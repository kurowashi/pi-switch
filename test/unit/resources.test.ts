/**
 * Unit: resource discovery, package grouping, and effective filtering.
 *
 * The catalog is what the picker shows; the filters are what the model sees.
 * Both are pure functions so the rules in README.md#動作 stay testable without
 * a running Pi session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Skill, SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { emptyConfig, parseConfig, resolveConfig } from "../../src/config.ts";
import {
	activeToolNames,
	collectCatalog,
	filterSkills,
	itemDisabled,
	itemTarget,
	packageDisabled,
	packageKeyFromSource,
	packageState,
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
		{ name: "npm:pi-exa", tools: ["exa_search"], skills: [] },
		{ name: "npm:pi-knowledge", tools: [], skills: ["knowledge"] },
	]);
});

test("itemTarget carries the package only for packaged resources", () => {
	const [packaged, local] = collectCatalog([tool("a", PACKAGE_SOURCE("pi-exa")), tool("b")], []).items;
	assert.ok(packaged !== undefined && local !== undefined);
	assert.deepEqual(itemTarget(packaged), { kind: "tools", name: "a", packageName: "npm:pi-exa" });
	assert.deepEqual(itemTarget(local), { kind: "tools", name: "b" });
});

test("itemDisabled resolves through the owning package", () => {
	const user = parseConfig('{"disabled":{"packages":["npm:pi-exa"]}}');
	assert.ok(user.ok);
	const resolved = resolveConfig(user.config, undefined);
	const [packaged] = collectCatalog([tool("a", PACKAGE_SOURCE("pi-exa"))], []).items;
	assert.ok(packaged !== undefined);
	assert.equal(itemDisabled(resolved, packaged), true);
});

test("filterSkills removes disabled skills and keeps the rest", () => {
	const user = parseConfig('{"disabled":{"skills":["keep-off"],"packages":["npm:pi-knowledge"]}}');
	assert.ok(user.ok);
	const resolved = resolveConfig(user.config, undefined);
	const kept = filterSkills(
		[skill("keep-off"), skill("knowledge", PACKAGE_SOURCE("pi-knowledge")), skill("keep-on")],
		resolved,
	);
	assert.deepEqual(
		kept.map((entry) => entry.name),
		["keep-on"],
	);
});

test("activeToolNames subtracts disabled tools and leaves unknown names alone", () => {
	const user = parseConfig('{"disabled":{"tools":["off"],"packages":["npm:pi-exa"]}}');
	assert.ok(user.ok);
	const resolved = resolveConfig(user.config, undefined);
	const names = activeToolNames(
		["on", "off", "packaged", "registered-later"],
		[tool("on"), tool("off"), tool("packaged", PACKAGE_SOURCE("pi-exa"))],
		resolved,
	);
	assert.deepEqual(names, ["on", "registered-later"]);
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

test("packageDisabled reads the package list directly", () => {
	const user = parseConfig('{"disabled":{"packages":["npm:pi-exa"]}}');
	assert.ok(user.ok);
	const resolved = resolveConfig(user.config, undefined);
	assert.equal(packageDisabled(resolved, "npm:pi-exa"), true);
	assert.equal(packageDisabled(resolved, "npm:pi-knowledge"), false);
});
