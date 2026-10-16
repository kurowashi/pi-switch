/**
 * pi-switch: enable or disable tools, skills, packages, MCP servers, and
 * prompt sections per user or project scope.
 *
 * The two config files are the only state. Changes apply in place: tools
 * through `pi.setActiveTools`, skills through the `before_agent_start` prompt
 * options, and prompt sections per request through `context_with_system`.
 * `/switch` opens the picker. See README.md for the user-facing description
 * and DESIGN.md for why unloading is out of scope.
 */

import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	emptyConfig,
	projectConfigPath,
	type ResolvedConfig,
	readConfigFile,
	resolveConfig,
	type ScopeFile,
	setValue,
	userConfigPath,
	valueIn,
	writeConfigFile,
} from "./config.ts";
import type { ScopeName, ToggleTarget } from "./model.ts";
import { runScopePicker, type ScopeInfo, type ScopePickerDeps, type SettingChange } from "./picker.ts";
import {
	applyToolState,
	BUILTIN_SECTIONS,
	collectCatalog,
	type DefaultOn,
	filterPromptSections,
	filterSkills,
	type SectionEntry,
} from "./resources.ts";

export const COMMAND_NAME = "switch";

/** Longest derived section description kept for the picker. */
const SECTION_DESCRIPTION_LIMIT = 120;

export default function scopeExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	let userFile: ScopeFile = { path: userConfigPath(agentDir), config: emptyConfig(), malformed: false };
	let projectFile: ScopeFile | undefined;
	let resolved: ResolvedConfig = resolveConfig(userFile.config, undefined);
	/** Tools pi-switch removed because the config turned them off; inheriting them again restores Pi's default. */
	let hiddenTools: string[] = [];
	/** Whether Pi had each tool active before pi-switch first touched it in this session. */
	let toolDefaults = new Map<string, boolean>();
	/** Registered tool names at the last application, to notice late registrations. */
	let knownTools: string[] = [];
	const warned = new Set<string>();
	/** Section names seen in a request, with the description derived from each body. */
	const observedSections = new Map<string, string>();

	function reload(ctx: ExtensionContext): void {
		userFile = readConfigFile(userConfigPath(agentDir));
		projectFile = ctx.isProjectTrusted() ? readConfigFile(projectConfigPath(ctx.cwd)) : undefined;
		resolved = resolveConfig(userFile.config, projectFile?.config);
	}

	function warnMalformed(ctx: ExtensionContext): void {
		for (const file of [userFile, projectFile]) {
			if (file === undefined || !file.malformed || warned.has(file.path)) continue;
			warned.add(file.path);
			ctx.ui.notify(`pi-switch: ignoring malformed config ${file.path}; it is never overwritten`, "warning");
		}
	}

	/** Pi's own state for an unset target: the tool's state at first sight, every other kind is on. */
	const defaultOn: DefaultOn = (target) => (target.kind === "tools" ? (toolDefaults.get(target.name) ?? true) : true);

	function applyTools(): void {
		const tools = pi.getAllTools();
		const current = pi.getActiveTools();
		for (const tool of tools) {
			if (!toolDefaults.has(tool.name)) toolDefaults.set(tool.name, current.includes(tool.name));
		}
		const state = applyToolState(current, hiddenTools, tools, resolved, defaultOn);
		hiddenTools = state.hidden;
		knownTools = tools.map((tool) => tool.name);
		if (sameNames(state.active, current)) return;
		pi.setActiveTools(state.active);
	}

	/** True when tools registered or disappeared since the last application. */
	function toolsChanged(): boolean {
		const names = pi.getAllTools().map((tool) => tool.name);
		return !sameNames(names, knownTools);
	}

	/** Persist the changes in one write, then apply them to the live session. */
	function apply(ctx: ExtensionCommandContext, scope: ScopeName, changes: readonly SettingChange[]): void {
		// Re-read both files so an edit made while the picker was open is not clobbered.
		reload(ctx);
		const file = writableFile(ctx, scope);
		if (file === undefined) return;
		for (const change of changes) setValue(file.config, change.target, change.setting);
		try {
			writeConfigFile(file);
		} catch (error) {
			ctx.ui.notify(`pi-switch: ${error instanceof Error ? error.message : String(error)}`, "error");
			reload(ctx);
		}
		resolved = resolveConfig(userFile.config, projectFile?.config);
		applyTools();
	}

	function writableFile(ctx: ExtensionCommandContext, scope: ScopeName): ScopeFile | undefined {
		const file = scope === "user" ? userFile : projectFile;
		if (file === undefined) {
			ctx.ui.notify("pi-switch: the project scope is unavailable", "warning");
			return undefined;
		}
		if (file.malformed) {
			ctx.ui.notify(`pi-switch: refusing to edit malformed config ${file.path}`, "error");
			return undefined;
		}
		return file;
	}

	function scopes(): ScopeInfo[] {
		const project: ScopeInfo =
			projectFile === undefined
				? { name: "project", available: false, reason: "the project is not trusted" }
				: { name: "project", available: true };
		return [{ name: "user", available: true }, project];
	}

	function sectionEntries(): SectionEntry[] {
		const entries = new Map<string, string>();
		for (const section of BUILTIN_SECTIONS) entries.set(section.name, section.description);
		for (const [name, description] of observedSections) if (!entries.has(name)) entries.set(name, description);
		return [...entries]
			.map(([name, description]) => ({ name, description }))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	function dependencies(ctx: ExtensionCommandContext): ScopePickerDeps {
		return {
			catalog: () => collectCatalog(pi.getAllTools(), ctx.getSystemPromptOptions().skills ?? [], sectionEntries()),
			resolved: () => resolved,
			defaultOn,
			scopes,
			valueOf: (scope: ScopeName, target: ToggleTarget) =>
				valueIn(scope === "user" ? userFile.config : projectFile?.config, target),
			apply: (scope: ScopeName, changes: readonly SettingChange[]) => apply(ctx, scope, changes),
			notify: (message: string, type?: "info" | "warning" | "error") => ctx.ui.notify(message, type),
		};
	}

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		warnMalformed(ctx);
		hiddenTools = [];
		toolDefaults = new Map();
		applyTools();
	});

	pi.on("before_agent_start", (event) => {
		// MCP servers connect after session_start; apply their off state before this request.
		if (toolsChanged()) applyTools();
		event.systemPromptOptions.skills = filterSkills(event.systemPromptOptions.skills, resolved);
	});

	// Sections are removed per request, after every extension has contributed its own.
	// The transcript keeps them, so disabling never touches compaction or reloads.
	pi.on("context_with_system", (event) => {
		const current = getCurrentSystemMessage(event.messages);
		if (current === undefined) return undefined;
		for (const [name, text] of Object.entries(current.sections ?? {})) {
			if (text === null || observedSections.has(name)) continue;
			observedSections.set(name, sectionDescription(text));
		}
		const head = filterPromptSections(current, resolved);
		if (head === undefined) return undefined;
		// Rebuilding collapses mid-conversation system messages into the replayed head,
		// the same way Pi does for providers without mid-conversation support.
		return { messages: [head, ...event.messages.filter((message) => message.role !== "system")] };
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Enable or disable tools, skills, packages, MCP servers, and prompt sections per scope",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify(`pi-switch: /${COMMAND_NAME} takes no arguments`, "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`pi-switch: /${COMMAND_NAME} requires TUI mode`, "error");
				return;
			}
			reload(ctx);
			warnMalformed(ctx);
			await runScopePicker(ctx, dependencies(ctx));
		},
	});
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Describe a prompt section by its first real line. Pi wraps every section in
 * a tag of its own name, so skip the tag line and markdown heading markers.
 */
function sectionDescription(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || /^<\/?[A-Za-z0-9_-]+>$/.test(line)) continue;
		const heading = line.replace(/^#+\s*/, "");
		return heading.length > SECTION_DESCRIPTION_LIMIT ? `${heading.slice(0, SECTION_DESCRIPTION_LIMIT - 1)}…` : heading;
	}
	return "";
}
