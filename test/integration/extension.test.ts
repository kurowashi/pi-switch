/**
 * Integration: the extension's wiring, driven through a fake Pi runtime.
 *
 * These tests exercise the shipped entry point (events, command, and picker)
 * against real config files under a temporary agent directory, so the file
 * format, the trust gate, and the live tool and skill updates stay covered
 * end to end. See src/index.ts for the wiring and src/picker.ts for the keys.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type {
	BeforeAgentStartEvent,
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
	emit(event: string, data: unknown): Promise<void>;
	runCommand(args?: string): Promise<void>;
	openPicker(): Promise<Component>;
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

function createHarness(options: HarnessOptions): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const notifications: Notification[] = [];
	const setActiveCalls: string[][] = [];
	const tools = options.tools ?? [];
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
			for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
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

test("session_start applies disabled tools and skills from the user config", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 1, disabled: { tools: ["off"], skills: ["hidden"] } });
			const harness = createHarness({
				cwd,
				active: ["on", "off"],
				tools: [tool("on"), tool("off")],
			});
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
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

test("a disabled package hides its tools and skills", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 1, disabled: { packages: ["npm:pi-exa"] } });
			const harness = createHarness({
				cwd,
				active: ["packaged", "loose"],
				tools: [tool("packaged", packageSource("pi-exa")), tool("loose")],
			});
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["loose"]);

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

test("session_start leaves the active set alone when nothing is disabled", async () => {
	await withAgentDirectory(async () => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["a"], tools: [tool("a")] });
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			assert.deepEqual(harness.setActiveCalls, [], "an unchanged set must not be re-asserted");
			assert.deepEqual(harness.active, ["a"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a trusted project can enable what the user disabled, an untrusted one is ignored", async () => {
	await withAgentDirectory(async (agentDir) => {
		const trustedCwd = temporaryDirectory("pi-switch-trusted-");
		const untrustedCwd = temporaryDirectory("pi-switch-untrusted-");
		try {
			writeJson(userConfig(agentDir), { version: 1, disabled: { tools: ["a"] } });
			writeJson(projectConfig(trustedCwd), { version: 1, enabled: { tools: ["a"] } });
			writeJson(projectConfig(untrustedCwd), { version: 1, enabled: { tools: ["a"] } });

			const trusted = createHarness({ cwd: trustedCwd, trusted: true, active: ["a"], tools: [tool("a")] });
			await trusted.emit("session_start", { type: "session_start", reason: "startup" });
			assert.deepEqual(trusted.active, ["a"]);

			const untrusted = createHarness({ cwd: untrustedCwd, trusted: false, active: ["a"], tools: [tool("a")] });
			await untrusted.emit("session_start", { type: "session_start", reason: "startup" });
			assert.deepEqual(untrusted.active, []);
		} finally {
			rmSync(trustedCwd, { recursive: true, force: true });
			rmSync(untrustedCwd, { recursive: true, force: true });
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
			writeJson(userConfig(agentDir), { version: 1, disabled: { tools: ["b"] } });
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 1, disabled: { tools: ["a", "b"] } });
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
				picker.handleInput?.(" ");
			} finally {
				chmodSync(agentDir, 0o700);
			}
			assert.match(harness.notifications.at(-1)?.message ?? "", /EACCES|permission denied/i);
			assert.equal(existsSync(userConfig(agentDir)), false, "a failed write must leave no file behind");
			assert.deepEqual(harness.setActiveCalls, [], "the re-read config disables nothing");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("enabling globally against a project disable reports that this project stays disabled", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 1, disabled: { tools: ["a"] } });
			writeJson(projectConfig(cwd), { version: 1, disabled: { tools: ["a"] } });
			const harness = createHarness({ cwd, trusted: true, active: [], tools: [tool("a")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 1, enabled: { tools: ["a"] } });
			assert.match(harness.notifications.at(-1)?.message ?? "", /project config/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the picker toggles a tool in the user scope and applies it immediately", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["a", "b"], tools: [tool("a"), tool("b")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			assert.match(picker.render(120).join("\n"), /Global/);
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 1, disabled: { tools: ["a"] } });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["b"]);
			assert.match(picker.render(120).join("\n"), /○ a/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the picker toggles a whole package from its row", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({
				cwd,
				active: ["packaged"],
				tools: [tool("packaged", packageSource("pi-exa"))],
			});
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), {
				version: 1,
				disabled: { tools: ["packaged"], packages: ["npm:pi-exa"] },
			});
			assert.deepEqual(harness.setActiveCalls.at(-1), []);
			assert.match(picker.render(120).join("\n"), /g:off/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the picker enables a package row that the config disabled", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 1, disabled: { packages: ["npm:pi-exa"] } });
			const harness = createHarness({
				cwd,
				active: ["packaged"],
				tools: [tool("packaged", packageSource("pi-exa"))],
			});
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			assert.deepEqual(harness.active, [], "the disabled package starts hidden");
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 1 });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["packaged"]);
			assert.match(picker.render(120).join("\n"), /● npm:pi-exa/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("a partial package row shows the partial glyph and turns every child on", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			writeJson(userConfig(agentDir), { version: 1, disabled: { tools: ["a"] } });
			const harness = createHarness({
				cwd,
				active: ["a", "b"],
				tools: [tool("a", packageSource("pi-exa")), tool("b", packageSource("pi-exa"))],
			});
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			assert.deepEqual(harness.active, ["b"], "only the enabled child starts active");
			await harness.runCommand();
			const picker = await harness.openPicker();
			assert.match(picker.render(120).join("\n"), /◐ npm:pi-exa/);
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 1 });
			assert.deepEqual(harness.setActiveCalls.at(-1), ["a", "b"]);
			assert.match(picker.render(120).join("\n"), /● npm:pi-exa/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the picker switches to project scope and writes the project file", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, trusted: true, active: ["a", "b"], tools: [tool("a"), tool("b")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.("\t");
			assert.match(picker.render(120).join("\n"), /\[Project\]/);
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(projectConfig(cwd)), { version: 1, disabled: { tools: ["a"] } });
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
			picker.handleInput?.("\t");
			assert.match(picker.render(120).join("\n"), /not trusted/);
			picker.handleInput?.(" ");
			assert.equal(existsSync(projectConfig(cwd)), false);
			assert.deepEqual(harness.setActiveCalls, [], "nothing may change");
			assert.match(harness.notifications.at(-1)?.message ?? "", /not trusted/);
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
			assert.doesNotMatch(picker.render(120).join("\n"), /alpha/);
			picker.handleInput?.("e");
			picker.handleInput?.("\x7f");
			assert.match(picker.render(120).join("\n"), /beta/);
			picker.handleInput?.("\u0015");
			assert.match(picker.render(120).join("\n"), /alpha/);
			picker.handleInput?.("\u0085");
			assert.match(picker.render(120).join("\n"), /type to search/, "a C1 control must not enter the filter");
			picker.handleInput?.("a");
			picker.handleInput?.("\x1b");
			assert.equal(harness.closed(), false, "the first escape clears the filter");
			picker.handleInput?.("\x1b");
			assert.equal(harness.closed(), true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("the selection moves and toggles the next row", async () => {
	await withAgentDirectory(async (agentDir) => {
		const cwd = temporaryDirectory("pi-switch-cwd-");
		try {
			const harness = createHarness({ cwd, active: ["a", "b"], tools: [tool("a"), tool("b")] });
			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.("\x1b[B");
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 1, disabled: { tools: ["b"] } });
			picker.handleInput?.("\x1b[A");
			picker.handleInput?.(" ");
			assert.deepEqual(readJson(userConfig(agentDir)), { version: 1, disabled: { tools: ["a", "b"] } });
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
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			await harness.emit("session_start", { type: "session_start", reason: "reload" });
			assert.equal(harness.notifications.length, 1);
			assert.equal(readFileSync(userConfig(agentDir), "utf8"), "{ nope");

			await harness.runCommand();
			const picker = await harness.openPicker();
			picker.handleInput?.(" ");
			assert.equal(readFileSync(userConfig(agentDir), "utf8"), "{ nope");
			assert.match(harness.notifications.at(-1)?.message ?? "", /refusing to edit/);
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
