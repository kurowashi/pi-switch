/**
 * Integration: the extension's wiring, driven through a fake Pi runtime.
 *
 * These tests exercise the shipped entry point (events, command, and picker)
 * against real config files under a temporary agent directory, so the file
 * format, the trust gate, and the live tool and skill updates stay covered
 * end to end. See src/index.ts for the wiring and src/picker.ts for the keys.
 *
 * Space cycles a row through inherit, on, off. A tool Pi already runs therefore
 * shows the same glyph after its first Space, but its file gains an explicit "on".
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type {
	BeforeAgentStartEvent,
	ContextWithSystemEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Skill,
	SourceInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import scopeExtension, { COMMAND_NAME } from "../../src/index.ts";

const AGENT_ENV = "PI_CODING_AGENT_DIR";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Notification {
	message: string;
	type?: "info" | "warning" | "error";
}

interface FakeTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface FactoryArgs {
	tui: { requestRender(): void };
	theme: FakeTheme;
	done(result: unknown): void;
}

type Factory = (
	tui: FactoryArgs["tui"],
	theme: FakeTheme,
	keybindings: unknown,
	done: FactoryArgs["done"],
) => Component;

interface HarnessOptions {
	cwd: string;
	trusted?: boolean;
	mode?: "tui" | "print";
	active?: string[];
	tools?: ToolInfo[];
	skills?: Skill[];
}

interface Harness {
	ctx: ExtensionContext;
	notifications: Notification[];
	active: string[];
	setActiveCalls: string[][];
	emit(event: string, data: unknown): Promise<unknown>;
	runCommand(args?: string): Promise<void>;
	openPicker(): Promise<Component>;
	/** Simulate a late registration, like an MCP server connecting: the tool becomes active. */
	registerTools(...added: ToolInfo[]): void;
	closed(): boolean;
}

const THEME: FakeTheme = { fg: (_color, text) => text, bold: (text) => text };

function source(overrides: Partial<SourceInfo> = {}): SourceInfo {
	const base: SourceInfo = { path: "/tmp/resource", source: "local", scope: "user", origin: "top-level" };
	if (overrides.path !== undefined) base.path = overrides.path;
	if (overrides.source !== undefined) base.source = overrides.source;
	if (overrides.scope !== undefined) base.scope = overrides.scope;
	if (overrides.origin !== undefined) base.origin = overrides.origin;
	if (overrides.baseDir !== undefined) base.baseDir = overrides.baseDir;
	return base;
}

function packageSource(name: string): SourceInfo {
	return source({ source: `npm:${name}@1.2.3`, origin: "package", baseDir: `/tmp/${name}` });
}

function tool(name: string, sourceInfo: SourceInfo = source()): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: { type: "object" },
		exposure: "direct",
		sourceInfo,
	} as unknown as ToolInfo;
}

function mcpTool(name: string, server: string, description?: string): ToolInfo {
	return {
		...tool(name),
		namespace: { name: `mcp__${server}`, ...(description === undefined ? {} : { description }) },
	};
}

function skill(name: string, sourceInfo: SourceInfo = source()): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `${sourceInfo.path}/SKILL.md`,
		baseDir: sourceInfo.path,
		sourceInfo,
		disableModelInvocation: false,
	};
}

function beforeAgentStart(skills: Skill[]): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "",
		systemPrompt: "",
		systemPromptOptions: { skills },
	} as unknown as BeforeAgentStartEvent;
}

function contextWithSystem(sections: Record<string, string>): ContextWithSystemEvent {
	return {
		type: "context_with_system",
		messages: [
			{ role: "system", content: "", sections, timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		],
	} as unknown as ContextWithSystemEvent;
}

function createHarness(options: HarnessOptions): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const notifications: Notification[] = [];
	const setActiveCalls: string[][] = [];
	let tools = options.tools ?? [];
	let active = [...(options.active ?? [])];
	let factory: Factory | undefined;
	let closed = false;

	const ctx = {
		cwd: options.cwd,
		mode: options.mode ?? "tui",
		hasUI: true,
		isProjectTrusted: () => options.trusted ?? true,
		getSystemPromptOptions: () => ({ skills: options.skills ?? [] }),
		ui: {
			notify: (message: string, type?: Notification["type"]) => {
				notifications.push(type === undefined ? { message } : { message, type });
			},
			custom: (created: Factory) => {
				factory = created;
				return Promise.resolve(undefined);
			},
		},
	} as unknown as ExtensionCommandContext;

	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			commands.set(name, command);
		},
		getActiveTools: () => [...active],
		getAllTools: () => tools,
		setActiveTools: (names: string[]) => {
			setActiveCalls.push([...names]);
			active = [...names];
		},
	} as unknown as ExtensionAPI;

	scopeExtension(pi);

	return {
		ctx,
		notifications,
		get active(): string[] {
			return [...active];
		},
		setActiveCalls,
		async emit(event: string, data: unknown) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(data, ctx);
			return result;
		},
		async runCommand(args = "") {
			const command = commands.get(COMMAND_NAME);
			assert.ok(command, "the command must be registered");
			await command.handler(args, ctx);
		},
		async openPicker() {
			assert.ok(factory, "the command must open the picker");
			return await factory({ requestRender: () => {} }, THEME, {}, () => {
				closed = true;
			});
		},
		registerTools(...added: ToolInfo[]) {
			tools = [...tools, ...added];
			active = [...active, ...added.map((entry) => entry.name)];
		},
		closed: () => closed,
	};
}

function temporaryDirectory(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(value, undefined, 2), "utf8");
}

function readJson(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function userConfig(agentDir: string): string {
	return join(agentDir, "pi-switch.json");
}

function projectConfig(cwd: string): string {
	return join(cwd, ".pi", "pi-switch.json");
}

/** Point getAgentDir() at a temporary directory for the duration of one test. */
async function withAgentDirectory(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = temporaryDirectory("pi-switch-agent-");
	const previous = process.env[AGENT_ENV];
	process.env[AGENT_ENV] = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previous === undefined) delete process.env[AGENT_ENV];
		else process.env[AGENT_ENV] = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

/** Keys the picker handles, as terminal input. */
const KEY = {
	down: "\x1b[B",
	up: "\x1b[A",
	left: "\x1b[D",
	right: "\x1b[C",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	tab: "\t",
	space: " ",
	escape: "\x1b",
} as const;

const START = { type: "session_start", reason: "startup" } as const;

function screen(picker: Component, width = 120): string {
	return picker.render(width).join("\n");
}

test("session_start applies off tools and skills from the user config", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 2, tools: { off: "off" }, skills: { hidden: "off" } });
			const harness = createHarness({ cwd, active: ["on", "off"], tools: [tool("on"), tool("off")] });
			await harness.emit("session_start", START);
			assert.deepEqual(harness.setActiveCalls.at(-1), ["on"]);

			const event = beforeAgentStart([skill("hidden"), skill("visible")]);
			await harness.emit("before_agent_start", event);
			assert.deepEqual(
				event.systemPromptOptions.skills.map((entry) => entry.name),
				["visible"],
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("an off package hides its tools and skills, and an on item inside it stays visible", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), {
				version: 2,
				packages: { "npm:pi-exa": "off" },
				tools: { packaged: "on" },
			});
			const harness = createHarness({
				cwd,
				active: ["packaged", "other", "loose"],
				tools: [tool("packaged", packageSource("pi-exa")), tool("other", packageSource("pi-exa")), tool("loose")],
			});
			await harness.emit("session_start", START);
			assert.deepEqual(harness.setActiveCalls.at(-1), ["packaged", "loose"]);

			const event = beforeAgentStart([skill("packaged-skill", packageSource("pi-exa")), skill("loose-skill")]);
			await harness.emit("before_agent_start", event);
			assert.deepEqual(
				event.systemPromptOptions.skills.map((entry) => entry.name),
				["loose-skill"],
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("session_start leaves the active set alone when nothing is configured", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["a"], tools: [tool("a")] });
			await harness.emit("session_start", START);
			assert.deepEqual(harness.setActiveCalls, [], "an unchanged set must not be re-asserted");
			assert.deepEqual(harness.active, ["a"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a trusted project overrides the user, an untrusted one is ignored", async () => {
	await withAgentDirectory(async (agentDir) => {
		const trustedCwd = temporaryDirectory("pi-switch-trusted-");
		const untrustedCwd = temporaryDirectory("pi-switch-untrusted-");
		try {
			writeJson(userConfig(agentDir), { version: 2, tools: { a: "off" } });
			writeJson(projectConfig(trustedCwd), { version: 2, tools: { a: "on" } });
			writeJson(projectConfig(untrustedCwd), { version: 2, tools: { a: "on" } });

			const trusted = createHarness({ cwd: trustedCwd, trusted: true, active: ["a"], tools: [tool("a")] });
			await trusted.emit("session_start", START);
			assert.deepEqual(trusted.active, ["a"]);

			const untrusted = createHarness({ cwd: untrustedCwd, trusted: false, active: ["a"], tools: [tool("a")] });
			await untrusted.emit("session_start", START);
			assert.deepEqual(untrusted.active, []);
		} finally {
			rmSync(trustedCwd, { recursive: true, force: true });
			rmSync(untrustedCwd, { recursive: true, force: true });
		}
	});
});

test("a tool Pi started inactive shows Pi's default, and Space walks inherit, on, off, inherit", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["read"], tools: [tool("read"), tool("grep")] });
			await harness.emit("session_start", START);
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.down);
			assert.match(screen(picker), /○ grep/, "grep is off by Pi's default, so it must not show as on");

			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { grep: "on" } });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["read", "grep"]);

			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { grep: "off" } });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["read"]);

			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2 }, "inherit removes the entry");
			assert.deepEqual(harness.setActiveCalls.at(-1), ["read"], "Pi's default for grep is off");
			assert.match(screen(picker), /○ grep/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a toggle re-reads the files so an external edit is not clobbered", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["a", "b"], tools: [tool("a"), tool("b")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			writeJson(userConfig(agentDir), { version: 2, tools: { b: "off" } });
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { a: "on", b: "off" } });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a failed write is reported, leaves no file, and is re-read", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["a"], tools: [tool("a")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			chmodSync(agentDir, 0o500);
			try {
				picker.handleInput?.(KEY.space);
			} finally {
				chmodSync(agentDir, 0o700);
			}
			assert.match(harness.notifications.at(-1)?.message ?? "", /EACCES|permission denied/i);
			assert.equal(existsSync(userConfig(agentDir)), false, "a failed write must leave no file behind");
			assert.deepEqual(harness.setActiveCalls, [], "the re-read config changes nothing");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("on in Global under an off Project reports that the project keeps it off", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(projectConfig(cwd), { version: 2, tools: { a: "off" } });
			const harness = createHarness({ cwd, trusted: true, active: [], tools: [tool("a")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { a: "on" } });
			assert.match(harness.notifications.at(-1)?.message ?? "", /project config/);
			assert.deepEqual(harness.setActiveCalls, [], "the project still turns a off");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the picker writes the project file in the Project scope and leaves the user file alone", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, trusted: true, active: ["a", "b"], tools: [tool("a"), tool("b")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.tab);
			assert.match(screen(picker), /\[Project\]/);
			picker.handleInput?.(KEY.space);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(projectConfig(cwd)), { version: 2, tools: { a: "off" } });
			assert.equal(existsSync(userConfig(agentDir)), false, "the user file must stay untouched");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("an untrusted project blocks project toggles", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, trusted: false, active: ["a"], tools: [tool("a")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.tab);
			assert.match(screen(picker), /not trusted/);
			picker.handleInput?.(KEY.space);
			assert.equal(existsSync(projectConfig(cwd)), false);
			assert.deepEqual(harness.setActiveCalls, [], "nothing may change");
			assert.match(harness.notifications.at(-1)?.message ?? "", /not trusted/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the picker keeps the same height on every kind tab", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["read"], tools: [tool("read")] });
			await harness.emit("session_start", START);
			await harness.runCommand();
			const picker = await harness.openPicker();
			const heights = new Set<number>();
			for (let step = 0; step < 5; step += 1) {
				heights.add(picker.render(120).length);
				picker.handleInput?.(KEY.right);
			}
			assert.equal(heights.size, 1, "the list area must not shrink on a tab with fewer rows");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("filtering narrows rows, backspace edits, and escape clears then closes", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["alpha", "beta"], tools: [tool("alpha"), tool("beta")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.("b");
			assert.doesNotMatch(screen(picker), /alpha/);
			picker.handleInput?.("e");
			picker.handleInput?.("\x7f");
			assert.match(screen(picker), /beta/);
			picker.handleInput?.("\u0015");
			assert.match(screen(picker), /alpha/);
			picker.handleInput?.("\u0085");
			assert.match(screen(picker), /type to search/, "a C1 control must not enter the filter");
			picker.handleInput?.("a");
			picker.handleInput?.(KEY.escape);
			assert.equal(harness.closed(), false, "the first escape clears the filter");
			picker.handleInput?.(KEY.escape);
			assert.equal(harness.closed(), true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the selection moves and Space changes the row it is on", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["a", "b"], tools: [tool("a"), tool("b")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.down);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { b: "on" } });
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { b: "off" } });
			picker.handleInput?.(KEY.up);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { a: "on", b: "off" } });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the Packages tab toggles a package row and removes the entries inside it", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 2, tools: { packaged: "off" } });
			const harness = createHarness({
				cwd,
				active: ["other"],
				tools: [tool("packaged", packageSource("pi-exa")), tool("other")],
			});
			await harness.emit("session_start", START);
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.right);
			picker.handleInput?.(KEY.right);
			assert.match(screen(picker), /○ npm:pi-exa/, "the off child makes the package row off");
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, packages: { "npm:pi-exa": "on" } });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["packaged", "other"]);
			assert.match(screen(picker), /● npm:pi-exa/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a partial package row shows the partial glyph and Space turns every child on", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 2, tools: { a: "off" } });
			const harness = createHarness({
				cwd,
				active: ["a", "b"],
				tools: [tool("a", packageSource("pi-exa")), tool("b", packageSource("pi-exa"))],
			});
			await harness.emit("session_start", START);
			assert.deepEqual(harness.active, ["b"], "only the enabled child starts active");
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.right);
			picker.handleInput?.(KEY.right);
			assert.match(screen(picker), /◐ npm:pi-exa/);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, packages: { "npm:pi-exa": "on" } });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["a", "b"]);
			assert.match(screen(picker), /● npm:pi-exa/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the Sections tab lists sections and writes them to the top-level key", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.left);
			assert.match(screen(picker), /\[Sections\]/);
			assert.match(screen(picker), /docs/);
			picker.handleInput?.("docs");
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, sections: { docs: "on" } });
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, sections: { docs: "off" } });
			assert.match(screen(picker), /○ docs/);
			assert.deepEqual(harness.setActiveCalls, [], "sections need no tool re-application");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the MCP tab shows a server as one row and toggles the whole group with one write", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({
				cwd,
				active: ["mcp__docs__search", "mcp__docs__read"],
				tools: [mcpTool("mcp__docs__search", "docs", "Searches the docs"), mcpTool("mcp__docs__read", "docs")],
			});
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.right);
			picker.handleInput?.(KEY.right);
			picker.handleInput?.(KEY.right);
			const before = screen(picker);
			assert.match(before, /\[MCP\]/);
			assert.match(before, /mcp__docs {2}2 tools {2}Searches the docs/);
			assert.doesNotMatch(before, /mcp__docs__search/, "child tools are not listed under the server");
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, packages: { mcp__docs: "on" } });
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, packages: { mcp__docs: "off" } });
			assert.deepEqual(harness.setActiveCalls.at(-1), []);
			assert.match(screen(picker), /○ mcp__docs/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("an MCP tool registered after session_start is hidden before the next request", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 2, packages: { mcp__docs: "off" } });
			const harness = createHarness({ cwd, active: ["read"], tools: [tool("read")] });
			await harness.emit("session_start", START);
			assert.deepEqual(harness.setActiveCalls, [], "nothing changes before the server connects");

			harness.registerTools(mcpTool("mcp__docs__search", "docs"));
			await harness.emit("before_agent_start", beforeAgentStart([]));
			assert.deepEqual(harness.setActiveCalls.at(-1), ["read"]);
			assert.deepEqual(harness.active, ["read"]);

			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.right);
			picker.handleInput?.(KEY.right);
			picker.handleInput?.(KEY.right);
			assert.match(screen(picker), /○ mcp__docs/);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2 }, "off inherits, and Pi's default for MCP is on");
			assert.deepEqual(harness.setActiveCalls.at(-1), ["read", "mcp__docs__search"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("context_with_system removes off sections and keeps the rest of the request", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 2, sections: { docs: "off" } });
			const harness = createHarness({ cwd });
			await harness.emit("session_start", START);
			const result = (await harness.emit(
				"context_with_system",
				contextWithSystem({ preamble: "P", docs: "D", rules: "R" }),
			)) as { messages: SystemMessage[] } | undefined;
			assert.ok(result !== undefined);
			assert.equal(result.messages.length, 2, "exactly one system head plus the conversation");
			assert.equal(result.messages[0]?.role, "system");
			assert.deepEqual(result.messages[0]?.sections, { preamble: "P", rules: "R" });
			assert.deepEqual(result.messages[1], { role: "user", content: "hi", timestamp: 2 });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("context_with_system leaves the request alone when no section is off", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd });
			const result = await harness.emit("context_with_system", contextWithSystem({ preamble: "P" }));
			assert.equal(result, undefined, "an unchanged request must not be rebuilt");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a project section off applies only when the project is trusted", async () => {
	await withAgentDirectory(async () => {
		const trustedCwd = temporaryDirectory("pi-switch-trusted-");
		const untrustedCwd = temporaryDirectory("pi-switch-untrusted-");
		try {
			writeJson(projectConfig(trustedCwd), { version: 2, sections: { docs: "off" } });
			writeJson(projectConfig(untrustedCwd), { version: 2, sections: { docs: "off" } });

			const trusted = createHarness({ cwd: trustedCwd, trusted: true });
			await trusted.emit("session_start", START);
			assert.notEqual(
				await trusted.emit("context_with_system", contextWithSystem({ docs: "D", rules: "R" })),
				undefined,
			);

			const untrusted = createHarness({ cwd: untrustedCwd, trusted: false });
			await untrusted.emit("session_start", START);
			assert.equal(
				await untrusted.emit("context_with_system", contextWithSystem({ docs: "D", rules: "R" })),
				undefined,
			);
		} finally {
			rmSync(trustedCwd, { recursive: true, force: true });
			rmSync(untrustedCwd, { recursive: true, force: true });
		}
	});
});

test("a section observed in a request appears in the Sections tab", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd });
			await harness.runCommand();
			const before = await harness.openPicker();
			before.handleInput?.(KEY.left);
			assert.doesNotMatch(screen(before), /knowledge_index/);
			await harness.emit("context_with_system", contextWithSystem({ knowledge_index: "K" }));
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.left);
			picker.handleInput?.("knowledge_index");
			assert.match(screen(picker), /knowledge_index/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the picker shows a derived description for an observed section", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd });
			await harness.runCommand();
			await harness.emit(
				"context_with_system",
				contextWithSystem({
					knowledge_index: "<knowledge_index>\n## Project Knowledge\n\nIndex body",
					long_section: `<long_section>\n${`word `.repeat(40)}\n</long_section>`,
				}),
			);
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.left);
			const text = screen(picker, 400);
			assert.match(text, /knowledge_index {2}Project Knowledge/);
			assert.match(text, /long_section {2}word word/);
			assert.match(text, /…/);
			assert.match(text, /docs {2}Pi documentation paths and when to read them/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the command refuses arguments and non-TUI modes", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd });
			await harness.runCommand("extra");
			assert.match(harness.notifications.at(-1)?.message ?? "", /takes no arguments/);

			const print = createHarness({ cwd, mode: "print" });
			await print.runCommand();
			assert.match(print.notifications.at(-1)?.message ?? "", /requires TUI mode/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a tool description with line breaks stays on one picker row", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const multiline = {
				...tool("tool_search"),
				description: "# Tool discovery\r\n\r\nSearches over deferred tool metadata.\u000bMore.",
			};
			const harness = createHarness({ cwd, tools: [multiline] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			const lines = picker.render(120);
			for (const line of lines) {
				assert.doesNotMatch(
					line,
					/[\r\n\v\f\u0085\u2028\u2029]/,
					`a row must stay one terminal line: ${JSON.stringify(line)}`,
				);
			}
			assert.match(lines.join("\n"), /tool_search {2}# Tool discovery Searches over deferred tool metadata\. More\./);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("page, home, and end keys move by a page and to the edges", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const names = Array.from({ length: 20 }, (_, index) => `tool-${String(index).padStart(2, "0")}`);
			const harness = createHarness({ cwd, active: names, tools: names.map((name) => tool(name)) });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.("tool-");
			picker.handleInput?.(KEY.end);
			picker.handleInput?.(KEY.space);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { "tool-19": "off" } });
			picker.handleInput?.(KEY.home);
			picker.handleInput?.(KEY.pageDown);
			picker.handleInput?.(KEY.space);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), {
				version: 2,
				tools: { "tool-14": "off", "tool-19": "off" },
			});
			picker.handleInput?.(KEY.pageUp);
			picker.handleInput?.(KEY.space);
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), {
				version: 2,
				tools: { "tool-00": "off", "tool-14": "off", "tool-19": "off" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a malformed user config is warned about once and is never overwritten", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeFileSync(userConfig(agentDir), "{ nope", "utf8");
			const harness = createHarness({ cwd, active: ["a"], tools: [tool("a")] });
			await harness.emit("session_start", START);
			await harness.emit("session_start", { type: "session_start", reason: "reload" });
			assert.equal(harness.notifications.length, 1);
			assert.equal(readFileSync(userConfig(agentDir), "utf8"), "{ nope");

			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(KEY.space);
			assert.equal(readFileSync(userConfig(agentDir), "utf8"), "{ nope");
			assert.match(harness.notifications.at(-1)?.message ?? "", /refusing to edit/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a version 1 file is read as version 2 and rewritten on the next change", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 1, disabled: { tools: ["off"] }, enabled: { tools: ["grep"] } });
			const harness = createHarness({ cwd, active: ["off"], tools: [tool("off"), tool("grep")] });
			await harness.emit("session_start", START);
			assert.deepEqual(harness.active, ["grep"]);
			await harness.runCommand();
			const picker = await harness.openPicker();
			// The first row is "off", which inherits on Space and so turns back on.
			picker.handleInput?.(KEY.space);
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 2, tools: { grep: "on" } });
			assert.deepEqual(harness.active, ["off", "grep"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
