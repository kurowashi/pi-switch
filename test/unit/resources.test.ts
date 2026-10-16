/**
 * Unit: resource discovery, package and MCP grouping, and effective filtering.
 *
 * The catalog is what the picker shows; the filters and the tool-state
 * reconciliation are what the model sees. Unset targets fall back to a default
 * that the caller supplies (Pi's own state). All are pure functions, so the rules
 * in README.md#動作 stay testable without a running Pi session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { Skill, SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { parseConfig, resolveConfig } from "../../src/config.ts";
import {
	applyToolState,
	BUILTIN_SECTIONS,
	collectCatalog,
	type DefaultOn,
	filterPromptSections,
	filterSkills,
	isOn,
	itemOn,
	itemTarget,
	packageChildren,
	packageKeyFromSource,
	packageState,
	toolTarget,
} from "../../src/resources.ts";

function source(overrides: Partial<SourceInfo> = {}): SourceInfo {
	const base: SourceInfo = {
		path: "/tmp/resource",
		source: "local",
		scope: "user",
		origin: "top-level",
	};
	if (overrides.path !== undefined) base.path = overrides.path;
	if (overrides.source !== undefined) base.source = overrides.source;
	if (overrides.scope !== undefined) base.scope = overrides.scope;
	if (overrides.origin !== undefined) base.origin = overrides.origin;
	if (overrides.baseDir !== undefined) base.baseDir = overrides.baseDir;
	return base;
}

function tool(name: string, sourceInfo: SourceInfo = source(), exposure = "direct"): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: { type: "object" },
		exposure,
		sourceInfo,
	} as unknown as ToolInfo;
}

function mcpTool(name: string, server: string, description?: string): ToolInfo {
	const base = tool(name);
	return {
		...base,
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

const PACKAGE_SOURCE = (name: string) =>
	source({ source: `npm:${name}@1.2.3`, origin: "package", baseDir: `/tmp/${name}` });

/** Pi's default: every target is on unless the test says otherwise. */
const ALL_ON: DefaultOn = () => true;

/** Pi's default for tools that started inactive, such as `grep`. */
const offByDefault =
	(names: readonly string[]): DefaultOn =>
	(target) =>
		!(target.kind === "tools" && names.includes(target.name));

function parse(text: string) {
	const parsed = parseConfig(text);
	assert.ok(parsed.ok, `config must parse: ${text}`);
	return resolveConfig(parsed.config, undefined);
}

function parseLayers(user: string, project?: string) {
	const u = parseConfig(user);
	assert.ok(u.ok);
	const p = project === undefined ? undefined : parseConfig(project);
	if (p !== undefined) assert.ok(p.ok);
	return resolveConfig(u.config, p?.ok ? p.config : undefined);
}

test("itemTarget carries the package or MCP group only for grouped resources", () => {
	const [packaged, mcp, local] = collectCatalog(
		[tool("a", PACKAGE_SOURCE("pi-exa")), mcpTool("b", "docs"), tool("c")],
		[],
	).items;
	assert.ok(packaged !== undefined && mcp !== undefined && local !== undefined);
	assert.deepEqual(itemTarget(packaged), { kind: "tools", name: "a", packageName: "npm:pi-exa" });
	assert.deepEqual(itemTarget(mcp), { kind: "tools", name: "b", packageName: "mcp__docs" });
	assert.deepEqual(itemTarget(local), { kind: "tools", name: "c" });
});

test("toolTarget resolves the package or MCP group of a live tool", () => {
	assert.deepEqual(toolTarget(tool("a", PACKAGE_SOURCE("pi-exa"))), {
		kind: "tools",
		name: "a",
		packageName: "npm:pi-exa",
	});
	assert.deepEqual(toolTarget(mcpTool("b", "docs")), { kind: "tools", name: "b", packageName: "mcp__docs" });
	assert.deepEqual(toolTarget(tool("c")), { kind: "tools", name: "c" });
});

test("isOn uses the config value when set and the default otherwise", () => {
	const resolved = parse('{"version":2,"tools":{"off":"off","on":"on"}}');
	const defaults = offByDefault(["grep"]);
	assert.equal(isOn(resolved, { kind: "tools", name: "off" }, ALL_ON), false);
	assert.equal(isOn(resolved, { kind: "tools", name: "on" }, offByDefault(["on"])), true);
	assert.equal(isOn(resolved, { kind: "tools", name: "grep" }, defaults), false, "an unset tool shows Pi's default");
	assert.equal(isOn(resolved, { kind: "tools", name: "read" }, defaults), true);
});

test("itemOn resolves through the owning package or MCP group", () => {
	const resolved = parse('{"version":2,"packages":{"npm:pi-exa":"off","mcp__docs":"off"}}');
	const [packaged, mcp, loose] = collectCatalog(
		[tool("a", PACKAGE_SOURCE("pi-exa")), mcpTool("b", "docs"), tool("c")],
		[],
	).items;
	assert.ok(packaged !== undefined && mcp !== undefined && loose !== undefined);
	assert.equal(itemOn(resolved, packaged, ALL_ON), false);
	assert.equal(itemOn(resolved, mcp, ALL_ON), false);
	assert.equal(itemOn(resolved, loose, ALL_ON), true);
});

test("an individually enabled MCP tool beats the disabled group", () => {
	const resolved = parse('{"version":2,"packages":{"mcp__docs":"off"},"tools":{"mcp__docs__read":"on"}}');
	const [search, read] = collectCatalog(
		[mcpTool("mcp__docs__search", "docs"), mcpTool("mcp__docs__read", "docs")],
		[],
	).items;
	assert.ok(search !== undefined && read !== undefined);
	assert.equal(itemOn(resolved, search, ALL_ON), false);
	assert.equal(itemOn(resolved, read, ALL_ON), true);
});

test("a project file overrides the user's package for a child item", () => {
	const resolved = parseLayers(
		'{"version":2,"packages":{"npm:pi-exa":"off"}}',
		'{"version":2,"tools":{"exa_search":"on"}}',
	);
	const [exa] = collectCatalog([tool("exa_search", PACKAGE_SOURCE("pi-exa"))], []).items;
	assert.ok(exa !== undefined);
	assert.equal(itemOn(resolved, exa, ALL_ON), true);
});

test("filterSkills removes explicitly off skills and keeps unset ones", () => {
	const resolved = parse('{"version":2,"skills":{"keep-off":"off"},"packages":{"npm:pi-knowledge":"off"}}');
	const kept = filterSkills(
		[skill("keep-off"), skill("knowledge", PACKAGE_SOURCE("pi-knowledge")), skill("keep-on")],
		resolved,
	);
	assert.deepEqual(
		kept.map((entry) => entry.name),
		["keep-on"],
	);
});

test("filterSkills keeps a skill the config explicitly turns on, even inside an off package", () => {
	const resolved = parse('{"version":2,"packages":{"npm:pi-knowledge":"off"},"skills":{"knowledge":"on"}}');
	const kept = filterSkills([skill("knowledge", PACKAGE_SOURCE("pi-knowledge"))], resolved);
	assert.equal(kept.length, 1);
});

test("applyToolState removes off tools and remembers them for re-enabling", () => {
	const off = parse('{"version":2,"tools":{"off":"off"}}');
	const disabled = applyToolState(["on", "off"], [], [tool("on"), tool("off")], off, ALL_ON);
	assert.deepEqual(disabled, { active: ["on"], hidden: ["off"] });
	const inherit = applyToolState(disabled.active, disabled.hidden, [tool("on"), tool("off")], parse("{}"), ALL_ON);
	assert.deepEqual(inherit, { active: ["on", "off"], hidden: [] });
});

test("an on value adds a tool Pi started inactive", () => {
	const grep = parse('{"version":2,"tools":{"grep":"on"}}');
	const state = applyToolState([], [], [tool("grep")], grep, offByDefault(["grep"]));
	assert.deepEqual(state, { active: ["grep"], hidden: [] });
});

test("an unset tool Pi started inactive stays inactive", () => {
	const state = applyToolState(["read"], [], [tool("read"), tool("grep")], parse("{}"), offByDefault(["grep"]));
	assert.deepEqual(state, { active: ["read"], hidden: [] });
});

test("inheriting a tool pi-switch removed restores Pi's default, not a blanket on", () => {
	const removed = applyToolState(
		["grep", "read"],
		[],
		[tool("grep"), tool("read")],
		parse('{"version":2,"tools":{"grep":"off"}}'),
		offByDefault(["grep"]),
	);
	assert.deepEqual(removed, { active: ["read"], hidden: ["grep"] });
	const restored = applyToolState(
		removed.active,
		removed.hidden,
		[tool("grep"), tool("read")],
		parse("{}"),
		offByDefault(["grep"]),
	);
	assert.deepEqual(restored, { active: ["read"], hidden: [] }, "grep was off by default, so it stays off");
	assert.deepEqual(restored.hidden, [], "inheriting ends pi-switch's control of the tool");
});

test("applyToolState keeps tools registered after the session started", () => {
	const state = applyToolState(
		["known", "late"],
		[],
		[tool("known"), tool("late"), tool("not-active")],
		parse("{}"),
		ALL_ON,
	);
	assert.deepEqual(state, { active: ["known", "late"], hidden: [] });
});

test("applyToolState hides an off MCP group and restores it when inherited", () => {
	const tools = [mcpTool("mcp__docs__a", "docs"), mcpTool("mcp__docs__b", "docs"), tool("other")];
	const disabled = applyToolState(
		["mcp__docs__a", "mcp__docs__b", "other"],
		[],
		tools,
		parse('{"version":2,"packages":{"mcp__docs":"off"}}'),
		ALL_ON,
	);
	assert.deepEqual(disabled, { active: ["other"], hidden: ["mcp__docs__a", "mcp__docs__b"] });
	const restored = applyToolState(disabled.active, disabled.hidden, tools, parse("{}"), ALL_ON);
	assert.deepEqual(restored, { active: ["mcp__docs__a", "mcp__docs__b", "other"], hidden: [] });
});

test("applyToolState keeps unknown names and drops non-declarable tools from hidden", () => {
	const deferred = tool("deferred-off", source(), "deferred");
	const state = applyToolState(["ghost", "deferred"], ["deferred-off"], [deferred], parse("{}"), ALL_ON);
	assert.deepEqual(state, { active: ["ghost", "deferred"], hidden: [] });
});

test("applyToolState restores a removed tool that was not active yet", () => {
	const off = parse('{"version":2,"tools":{"x":"off"}}');
	const disabled = applyToolState([], [], [tool("x")], off, ALL_ON);
	assert.deepEqual(disabled, { active: [], hidden: ["x"] });
	const on = applyToolState(disabled.active, disabled.hidden, [tool("x")], parse("{}"), ALL_ON);
	assert.deepEqual(on, { active: ["x"], hidden: [] });
});

test("packageChildren lists the tools and skills of one package", () => {
	const catalog = collectCatalog([tool("a", PACKAGE_SOURCE("pi-exa"))], [skill("knowledge", PACKAGE_SOURCE("pi-exa"))]);
	assert.deepEqual(packageChildren(catalog, "npm:pi-exa"), [
		{ kind: "tools", name: "a", packageName: "npm:pi-exa" },
		{ kind: "skills", name: "knowledge", packageName: "npm:pi-exa" },
	]);
});

test("packageState aggregates children and handles empty and unknown packages", () => {
	const catalog = collectCatalog([tool("a", PACKAGE_SOURCE("pi-exa")), tool("b", PACKAGE_SOURCE("pi-exa"))], []);
	assert.equal(packageState(catalog, parse("{}"), "npm:pi-exa", ALL_ON), "on");
	assert.equal(packageState(catalog, parse("{}"), "npm:unknown", ALL_ON), "on", "an unknown package is on by default");
	assert.equal(packageState(catalog, parse('{"version":2,"tools":{"a":"off"}}'), "npm:pi-exa", ALL_ON), "partial");
	assert.equal(
		packageState(catalog, parse('{"version":2,"packages":{"npm:pi-exa":"off"}}'), "npm:pi-exa", ALL_ON),
		"off",
	);
	assert.equal(
		packageState(catalog, parse('{"version":2,"packages":{"npm:pi-exa":"on"}}'), "npm:pi-exa", offByDefault(["a"])),
		"on",
	);
});

test("packageState aggregates an MCP group", () => {
	const catalog = collectCatalog([mcpTool("mcp__docs__a", "docs"), mcpTool("mcp__docs__b", "docs")], []);
	assert.equal(packageState(catalog, parse("{}"), "mcp__docs", ALL_ON), "on");
	assert.equal(
		packageState(catalog, parse('{"version":2,"tools":{"mcp__docs__a":"off"}}'), "mcp__docs", ALL_ON),
		"partial",
	);
	assert.equal(
		packageState(catalog, parse('{"version":2,"packages":{"mcp__docs":"off"}}'), "mcp__docs", ALL_ON),
		"off",
	);
});

test("packageKeyFromSource drops npm versions but keeps scoped names", () => {
	assert.equal(packageKeyFromSource("npm:pi-exa@1.2.3"), "npm:pi-exa");
	assert.equal(packageKeyFromSource("npm:@scope/pkg@0.0.1"), "npm:@scope/pkg");
	assert.equal(packageKeyFromSource("npm:pi-exa"), "npm:pi-exa");
	assert.equal(packageKeyFromSource("npm:@scope/pkg"), "npm:@scope/pkg");
	assert.equal(packageKeyFromSource("git:github.com/user/repo"), "git:github.com/user/repo");
});

test("BUILTIN_SECTIONS pins the sections Pi builds by default and describes them", () => {
	assert.deepEqual(
		BUILTIN_SECTIONS.map((section) => section.name),
		["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"],
	);
	assert.ok(BUILTIN_SECTIONS.every((section) => section.description.length > 0));
});

test("collectCatalog appends section items without a package and itemTarget maps them", () => {
	const catalog = collectCatalog(
		[tool("read")],
		[],
		[
			{ name: "docs", description: "Pi documentation paths" },
			{ name: "knowledge_index", description: "Project Knowledge" },
		],
	);
	const sections = catalog.items.filter((item) => item.kind === "section");
	assert.deepEqual(
		sections.map((item) => `${item.name}:${item.description}:${item.packageName ?? "-"}`),
		["docs:Pi documentation paths:-", "knowledge_index:Project Knowledge:-"],
	);
	const [docs] = sections;
	assert.ok(docs !== undefined);
	assert.deepEqual(itemTarget(docs), { kind: "sections", name: "docs" });
});

test("itemOn resolves section names", () => {
	const resolved = parse('{"version":2,"sections":{"docs":"off"}}');
	const catalog = collectCatalog(
		[],
		[],
		[
			{ name: "docs", description: "Pi documentation paths" },
			{ name: "rules", description: "Behavioral guidelines" },
		],
	);
	const [docs, rules] = catalog.items;
	assert.ok(docs !== undefined && rules !== undefined);
	assert.equal(itemOn(resolved, docs, ALL_ON), false);
	assert.equal(itemOn(resolved, rules, ALL_ON), true);
});

function systemMessage(partial: Partial<SystemMessage> = {}): SystemMessage {
	return { role: "system", content: "", timestamp: 0, ...partial };
}

test("filterPromptSections removes off sections and keeps the rest", () => {
	const resolved = parse('{"version":2,"sections":{"docs":"off"}}');
	const toolsAdded = [{ name: "read" }] as unknown as NonNullable<SystemMessage["toolsAdded"]>;
	const current = systemMessage({
		content: "base",
		sections: { preamble: "P", docs: "D", rules: "R" },
		toolsAdded,
		timestamp: 7,
	});
	const head = filterPromptSections(current, resolved);
	assert.ok(head !== undefined);
	assert.deepEqual(head.sections, { preamble: "P", rules: "R" });
	assert.equal(head.content, "base");
	assert.equal(head.toolsAdded, toolsAdded);
	assert.equal(head.timestamp, 7);
});

test("filterPromptSections keeps an on section and leaves an unaffected or forced prompt alone", () => {
	const resolved = parse('{"version":2,"sections":{"docs":"off","rules":"on"}}');
	assert.equal(filterPromptSections(systemMessage({ sections: { rules: "R" } }), resolved), undefined);
	assert.equal(filterPromptSections(systemMessage({ content: "forced" }), resolved), undefined);
});

test("filterPromptSections ignores null section entries", () => {
	const resolved = parse('{"version":2,"sections":{"docs":"off"}}');
	assert.equal(
		filterPromptSections(systemMessage({ sections: { docs: null } }), resolved),
		undefined,
		"a null entry is already removed and must not trigger a rebuild",
	);
});

test("filterPromptSections empties the sections key when everything is off", () => {
	const head = filterPromptSections(
		systemMessage({ content: "base", sections: { docs: "D", rules: "R" } }),
		parse('{"version":2,"sections":{"docs":"off","rules":"off"}}'),
	);
	assert.ok(head !== undefined);
	assert.deepEqual(head.sections, {});
});
