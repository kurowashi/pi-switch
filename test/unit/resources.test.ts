/**
 * Unit: resource discovery, package and MCP grouping, and effective filtering.
 *
 * The catalog is what the picker shows; the filters and the tool-state
 * reconciliation are what the model sees. All are pure functions, so the rules
 * in README.md#動作 stay testable without a running Pi session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { Skill, SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { emptyConfig, parseConfig, resolveConfig } from "../../src/config.ts";
import {
	applyToolState,
	BUILTIN_SECTIONS,
	collectCatalog,
	filterPromptSections,
	filterSkills,
	itemDisabled,
	itemTarget,
	packageDisabled,
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

function parse(text: string) {
	const parsed = parseConfig(text);
	assert.ok(parsed.ok, `config must parse: ${text}`);
	return resolveConfig(parsed.config, undefined);
}

test("packageKeyFromSource drops npm versions but keeps scoped names", () => {
	assert.equal(packageKeyFromSource("npm:pi-exa@1.2.3"), "npm:pi-exa");
	assert.equal(packageKeyFromSource("npm:@scope/pkg@0.0.1"), "npm:@scope/pkg");
	assert.equal(packageKeyFromSource("npm:pi-exa"), "npm:pi-exa");
	assert.equal(packageKeyFromSource("npm:@scope/pkg"), "npm:@scope/pkg");
	assert.equal(packageKeyFromSource("git:github.com/user/repo"), "git:github.com/user/repo");
});

test("collectCatalog groups packaged tools and skills and skips hidden tools", () => {
	const catalog = collectCatalog(
		[
			tool("exa_search", PACKAGE_SOURCE("pi-exa")),
			tool("hidden_tool", PACKAGE_SOURCE("pi-exa"), "hidden"),
			tool("read"),
		],
		[skill("knowledge", PACKAGE_SOURCE("pi-knowledge")), skill("local-skill")],
	);
	assert.deepEqual(
		catalog.items.map((item) => `${item.kind}:${item.name}:${item.packageName ?? "-"}`),
		["tool:exa_search:npm:pi-exa", "tool:read:-", "skill:knowledge:npm:pi-knowledge", "skill:local-skill:-"],
	);
	assert.deepEqual(catalog.packages, [
		{ name: "npm:pi-exa", kind: "package", tools: ["exa_search"], skills: [] },
		{ name: "npm:pi-knowledge", kind: "package", tools: [], skills: ["knowledge"] },
	]);
});

test("collectCatalog groups MCP tools by namespace and keeps the server description", () => {
	const catalog = collectCatalog(
		[
			mcpTool("mcp__docs__search", "docs", "Searches the docs"),
			mcpTool("mcp__docs__read", "docs"),
			tool("mcp__odd__tool", source(), "hidden"),
			tool("loose"),
		],
		[],
	);
	assert.deepEqual(
		catalog.items.map((item) => `${item.kind}:${item.name}:${item.packageName ?? "-"}`),
		["tool:mcp__docs__search:mcp__docs", "tool:mcp__docs__read:mcp__docs", "tool:loose:-"],
	);
	assert.deepEqual(catalog.packages, [
		{
			name: "mcp__docs",
			kind: "mcp",
			description: "Searches the docs",
			tools: ["mcp__docs__search", "mcp__docs__read"],
			skills: [],
		},
	]);
});

test("a namespace without the MCP prefix is not a group", () => {
	const namespaced = { ...tool("namespaced"), namespace: { name: "other" } } as ToolInfo;
	const catalog = collectCatalog([namespaced], []);
	assert.deepEqual(catalog.packages, []);
	assert.equal(catalog.items[0]?.packageName, undefined);
});

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

test("itemDisabled resolves through the owning package or MCP group", () => {
	const resolved = parse('{"disabled":{"packages":["npm:pi-exa","mcp__docs"]}}');
	const [packaged, mcp, loose] = collectCatalog(
		[tool("a", PACKAGE_SOURCE("pi-exa")), mcpTool("b", "docs"), tool("c")],
		[],
	).items;
	assert.ok(packaged !== undefined && mcp !== undefined && loose !== undefined);
	assert.equal(itemDisabled(resolved, packaged), true);
	assert.equal(itemDisabled(resolved, mcp), true);
	assert.equal(itemDisabled(resolved, loose), false);
});

test("an individually enabled MCP tool beats the disabled group", () => {
	const resolved = parse('{"disabled":{"packages":["mcp__docs"]},"enabled":{"tools":["mcp__docs__read"]}}');
	const [search, read] = collectCatalog(
		[mcpTool("mcp__docs__search", "docs"), mcpTool("mcp__docs__read", "docs")],
		[],
	).items;
	assert.ok(search !== undefined && read !== undefined);
	assert.equal(itemDisabled(resolved, search), true);
	assert.equal(itemDisabled(resolved, read), false);
});

test("filterSkills removes disabled skills and keeps the rest", () => {
	const resolved = parse('{"disabled":{"skills":["keep-off"],"packages":["npm:pi-knowledge"]}}');
	const kept = filterSkills(
		[skill("keep-off"), skill("knowledge", PACKAGE_SOURCE("pi-knowledge")), skill("keep-on")],
		resolved,
	);
	assert.deepEqual(
		kept.map((entry) => entry.name),
		["keep-on"],
	);
});

test("applyToolState removes disabled tools and remembers them for re-enabling", () => {
	const off = parse('{"disabled":{"tools":["off"]}}');
	const disabled = applyToolState(["on", "off"], [], [tool("on"), tool("off")], off);
	assert.deepEqual(disabled, { active: ["on"], hidden: ["off"] });
	const on = applyToolState(disabled.active, disabled.hidden, [tool("on"), tool("off")], parse("{}"));
	assert.deepEqual(on, { active: ["on", "off"], hidden: [] });
});

test("applyToolState keeps tools registered after the session started", () => {
	const state = applyToolState(["known", "late"], [], [tool("known"), tool("late"), tool("not-active")], parse("{}"));
	assert.deepEqual(state, { active: ["known", "late"], hidden: [] });
});

test("applyToolState hides a disabled MCP group and restores it when enabled", () => {
	const tools = [mcpTool("mcp__docs__a", "docs"), mcpTool("mcp__docs__b", "docs"), tool("other")];
	const disabled = applyToolState(
		["mcp__docs__a", "mcp__docs__b", "other"],
		[],
		tools,
		parse('{"disabled":{"packages":["mcp__docs"]}}'),
	);
	assert.deepEqual(disabled, { active: ["other"], hidden: ["mcp__docs__a", "mcp__docs__b"] });
	const restored = applyToolState(disabled.active, disabled.hidden, tools, parse("{}"));
	assert.deepEqual(restored, { active: ["mcp__docs__a", "mcp__docs__b", "other"], hidden: [] });
});

test("applyToolState keeps unknown names and drops non-declarable tools from hidden", () => {
	const deferred = tool("deferred-off", source(), "deferred");
	const state = applyToolState(["ghost", "deferred"], ["deferred-off"], [deferred], parse("{}"));
	assert.deepEqual(state, { active: ["ghost", "deferred"], hidden: [] });
});

test("applyToolState restores a disabled tool that was not active yet", () => {
	const off = parse('{"disabled":{"tools":["x"]}}');
	const disabled = applyToolState([], [], [tool("x")], off);
	assert.deepEqual(disabled, { active: [], hidden: ["x"] });
	const on = applyToolState(disabled.active, disabled.hidden, [tool("x")], parse("{}"));
	assert.deepEqual(on, { active: ["x"], hidden: [] });
});

test("packageState aggregates children and handles empty and unknown packages", () => {
	const catalog = collectCatalog(
		[
			tool("a", PACKAGE_SOURCE("pi-exa")),
			tool("b", PACKAGE_SOURCE("pi-exa")),
			tool("c", PACKAGE_SOURCE("pi-knowledge"), "hidden"),
		],
		[skill("knowledge", PACKAGE_SOURCE("pi-knowledge"))],
	);
	const allOn = resolveConfig(emptyConfig(), undefined);
	assert.equal(packageState(catalog, allOn, "npm:pi-exa"), "on");
	assert.equal(packageState(catalog, allOn, "npm:pi-knowledge"), "on");
	assert.equal(packageState(catalog, allOn, "npm:unknown"), "on");

	const oneOff = parseConfig('{"disabled":{"tools":["a"]}}');
	assert.ok(oneOff.ok);
	assert.equal(packageState(catalog, resolveConfig(oneOff.config, undefined), "npm:pi-exa"), "partial");

	const allOff = parseConfig('{"disabled":{"packages":["npm:pi-exa"]},"enabled":{"skills":["knowledge"]}}');
	assert.ok(allOff.ok);
	const resolvedOff = resolveConfig(allOff.config, undefined);
	assert.equal(packageState(catalog, resolvedOff, "npm:pi-exa"), "off");
	assert.equal(packageState(catalog, resolvedOff, "npm:unknown"), "on");
});

test("packageState aggregates an MCP group", () => {
	const catalog = collectCatalog([mcpTool("mcp__docs__a", "docs"), mcpTool("mcp__docs__b", "docs")], []);
	assert.equal(packageState(catalog, parse("{}"), "mcp__docs"), "on");
	assert.equal(packageState(catalog, parse('{"disabled":{"tools":["mcp__docs__a"]}}'), "mcp__docs"), "partial");
	assert.equal(packageState(catalog, parse('{"disabled":{"packages":["mcp__docs"]}}'), "mcp__docs"), "off");
});

test("packageDisabled reads the package list directly", () => {
	const resolved = parse('{"disabled":{"packages":["npm:pi-exa"]}}');
	assert.equal(packageDisabled(resolved, "npm:pi-exa"), true);
	assert.equal(packageDisabled(resolved, "npm:pi-knowledge"), false);
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

test("itemDisabled resolves section names", () => {
	const resolved = parse('{"sections":{"disabled":["docs"]}}');
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
	assert.equal(itemDisabled(resolved, docs), true);
	assert.equal(itemDisabled(resolved, rules), false);
});

function systemMessage(partial: Partial<SystemMessage> = {}): SystemMessage {
	return { role: "system", content: "", timestamp: 0, ...partial };
}

test("filterPromptSections removes disabled sections and keeps the rest", () => {
	const resolved = parse('{"sections":{"disabled":["docs"]}}');
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

test("filterPromptSections leaves an unaffected or forced prompt alone", () => {
	const resolved = parse('{"sections":{"disabled":["docs"]}}');
	assert.equal(filterPromptSections(systemMessage({ sections: { rules: "R" } }), resolved), undefined);
	assert.equal(filterPromptSections(systemMessage({ content: "forced" }), resolved), undefined);
});

test("filterPromptSections ignores null section entries", () => {
	const resolved = parse('{"sections":{"disabled":["docs"]}}');
	assert.equal(
		filterPromptSections(systemMessage({ sections: { docs: null } }), resolved),
		undefined,
		"a null entry is already removed and must not trigger a rebuild",
	);
});

test("filterPromptSections empties the sections key when everything is disabled", () => {
	const head = filterPromptSections(
		systemMessage({ content: "base", sections: { docs: "D", rules: "R" } }),
		parse('{"sections":{"disabled":["docs","rules"]}}'),
	);
	assert.ok(head !== undefined);
	assert.deepEqual(head.sections, {});
});
