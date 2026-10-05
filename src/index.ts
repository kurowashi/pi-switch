/**
 * pi-switch: enable or disable tools, skills, packages, and prompt sections
 * per user or project scope.
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
	layerState,
	projectConfigPath,
	type ResolvedConfig,
	readConfigFile,
	resolveConfig,
	type ScopeFile,
	type ScopeName,
	type ToggleTarget,
	toggleInScope,
	userConfigPath,
	writeConfigFile,
} from "./config.ts";
import { runScopePicker, type ScopeInfo, type ScopePickerDeps } from "./picker.ts";
import { activeToolNames, BUILTIN_SECTIONS, collectCatalog, filterPromptSections, filterSkills } from "./resources.ts";

export const COMMAND_NAME = "switch";

export default function scopeExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	let userFile: ScopeFile = { path: userConfigPath(agentDir), config: emptyConfig(), malformed: false };
	let projectFile: ScopeFile | undefined;
	let resolved: ResolvedConfig = resolveConfig(userFile.config, undefined);
	let baseline: string[] | undefined;
	const warned = new Set<string>();
	/** Section names seen in a request. The picker also lists #{@link BUILTIN_SECTIONS}. */
	const observedSections = new Set<string>();

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

	function applyTools(): void {
		baseline ??= pi.getActiveTools();
		const next = activeToolNames(baseline, pi.getAllTools(), resolved);
		const current = pi.getActiveTools();
		if (next.length === current.length && next.every((name, index) => name === current[index])) return;
		pi.setActiveTools(next);
	}

	/** Global enable cannot beat a project disable; say so instead of leaving the user guessing. */
	function notifyIfIneffective(ctx: ExtensionCommandContext, scope: ScopeName, targets: readonly ToggleTarget[]): void {
		if (scope !== "user") return;
		const blocked = targets.filter((target) => resolved.isDisabled(target));
		if (blocked.length === 0) return;
		const names = blocked.map((target) => target.name).join(", ");
		ctx.ui.notify(`pi-switch: enabled globally, but the project config keeps these disabled here: ${names}`, "warning");
	}

	function toggle(
		ctx: ExtensionCommandContext,
		scope: ScopeName,
		targets: readonly ToggleTarget[],
		enabled: boolean,
	): void {
		// Re-read both files so an edit made while the picker was open is not clobbered.
		reload(ctx);
		const file = writableFile(ctx, scope);
		if (file === undefined) return;
		for (const target of targets) toggleInScope(userFile.config, projectFile?.config, scope, target, enabled);
		try {
			writeConfigFile(file);
		} catch (error) {
			ctx.ui.notify(`pi-switch: ${error instanceof Error ? error.message : String(error)}`, "error");
			reload(ctx);
		}
		resolved = resolveConfig(userFile.config, projectFile?.config);
		applyTools();
		if (enabled) notifyIfIneffective(ctx, scope, targets);
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

	function sectionNames(): string[] {
		return [...new Set([...BUILTIN_SECTIONS, ...observedSections])].sort();
	}

	function dependencies(ctx: ExtensionCommandContext): ScopePickerDeps {
		return {
			catalog: () => collectCatalog(pi.getAllTools(), ctx.getSystemPromptOptions().skills ?? [], sectionNames()),
			resolved: () => resolved,
			scopes,
			layerState: (scope: ScopeName, target: ToggleTarget) =>
				layerState(scope === "user" ? userFile.config : projectFile?.config, target),
			toggle: (scope: ScopeName, targets: readonly ToggleTarget[], enabled: boolean) =>
				toggle(ctx, scope, targets, enabled),
			notify: (message: string, type?: "info" | "warning" | "error") => ctx.ui.notify(message, type),
		};
	}

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		warnMalformed(ctx);
		baseline = pi.getActiveTools();
		applyTools();
	});

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.skills = filterSkills(event.systemPromptOptions.skills, resolved);
	});

	// Sections are removed per request, after every extension has contributed its own.
	// The transcript keeps them, so disabling never touches compaction or reloads.
	pi.on("context_with_system", (event) => {
		const current = getCurrentSystemMessage(event.messages);
		if (current === undefined) return undefined;
		for (const name of Object.keys(current.sections ?? {})) observedSections.add(name);
		const head = filterPromptSections(current, resolved);
		if (head === undefined) return undefined;
		// Rebuilding collapses mid-conversation system messages into the replayed head,
		// the same way Pi does for providers without mid-conversation support.
		return { messages: [head, ...event.messages.filter((message) => message.role !== "system")] };
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Enable or disable tools, skills, packages, and prompt sections per user or project scope",
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
