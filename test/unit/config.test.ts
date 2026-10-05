/**
 * Unit: configuration parsing, effective resolution, and persistence.
 *
 * The rules under test are the user-facing contract in README.md#設定:
 * unlisted targets stay enabled, each layer can override the previous one,
 * and a malformed file is ignored without ever being overwritten.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CONFIG_FILE_NAME,
	emptyConfig,
	layerState,
	parseConfig,
	projectConfigPath,
	readConfigFile,
	resolveConfig,
	type ScopeConfig,
	serializeConfig,
	setDisabled,
	setEnabled,
	toggleInScope,
	userConfigPath,
	writeConfigFile,
} from "../../src/config.ts";

function sandbox(): string {
	return mkdtempSync(join(tmpdir(), "pi-switch-config-"));
}

function config(source: string): ScopeConfig {
	const parsed = parseConfig(source);
	assert.ok(parsed.ok, `fixture must parse: ${JSON.stringify(parsed)}`);
	return parsed.config;
}

test("an empty object is a valid config with version 1", () => {
	const parsed = parseConfig("{}");
	assert.ok(parsed.ok);
	assert.equal(parsed.config.version, 1);
	assert.deepEqual(parsed.config.disabled, { tools: [], skills: [], packages: [], sections: [] });
	assert.deepEqual(parsed.config.enabled, { tools: [], skills: [], packages: [], sections: [] });
	assert.deepEqual(parsed.config.extra, {});
});

test("lists are deduplicated and sorted", () => {
	const parsed = parseConfig('{"disabled":{"tools":["b","a","b"]}}');
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.config.disabled.tools, ["a", "b"]);
});

test("unknown top-level fields survive a write", () => {
	const parsed = parseConfig('{"version":1,"note":"keep me","disabled":{"tools":["a"]}}');
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.config.extra, { note: "keep me" });
	const serialized = JSON.parse(serializeConfig(parsed.config)) as Record<string, unknown>;
	assert.equal(serialized["note"], "keep me");
	assert.deepEqual(serialized["disabled"], { tools: ["a"] });
	assert.equal(serialized["enabled"], undefined);
});

test("invalid configs are rejected with a reason", () => {
	assert.equal(parseConfig("not json").ok, false);
	assert.equal(parseConfig("[]").ok, false);
	assert.equal(parseConfig('{"version":"one"}').ok, false);
	assert.equal(parseConfig('{"version":2}').ok, false);
	assert.equal(parseConfig('{"disabled":[]}').ok, false);
	assert.equal(parseConfig('{"disabled":{"tools":"a"}}').ok, false);
	assert.equal(parseConfig('{"disabled":{"tools":[1]}}').ok, false);
	assert.equal(parseConfig('{"disabled":{"tols":[]}}').ok, false);
	assert.equal(parseConfig('{"disabled":{"tools":[""]}}').ok, false);
	assert.equal(parseConfig('{"disabled":{"sections":["docs"]}}').ok, false, "sections belong at the top level");
	assert.equal(parseConfig('{"enabled":{"nope":[]}}').ok, false);
	assert.equal(parseConfig('{"sections":[]}').ok, false);
	assert.equal(parseConfig('{"sections":{"disabled":"docs"}}').ok, false);
	assert.equal(parseConfig('{"sections":{"unknown":[]}}').ok, false);
});

test("prompt sections live in the top-level sections key", () => {
	const parsed = parseConfig('{"sections":{"disabled":["docs","b","a","docs"],"enabled":["rules"]}}');
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.config.disabled.sections, ["a", "b", "docs"]);
	assert.deepEqual(parsed.config.enabled.sections, ["rules"]);
	const serialized = JSON.parse(serializeConfig(parsed.config)) as Record<string, unknown>;
	assert.deepEqual(serialized["sections"], { disabled: ["a", "b", "docs"], enabled: ["rules"] });
	assert.equal(serialized["disabled"], undefined, "sections must not leak into the disabled map");
	assert.equal(serialized["enabled"], undefined);
});

test("a file without a sections key stays valid (older versions)", () => {
	const parsed = parseConfig('{"version":1,"disabled":{"tools":["a"]}}');
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.config.disabled.sections, []);
	assert.deepEqual(parsed.config.enabled.sections, []);
});

test("sections round-trip through the file and the unknown fields survive", () => {
	const directory = sandbox();
	try {
		const file = readConfigFile(join(directory, CONFIG_FILE_NAME));
		setDisabled(file.config, "sections", "docs", true);
		file.config.extra["note"] = "keep me";
		writeConfigFile(file);

		const serialized = JSON.parse(readFileSync(file.path, "utf8")) as Record<string, unknown>;
		assert.deepEqual(serialized["sections"], { disabled: ["docs"] });
		assert.equal(serialized["note"], "keep me");

		const reread = readConfigFile(file.path);
		assert.equal(reread.malformed, false);
		assert.deepEqual(reread.config.disabled.sections, ["docs"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a missing file is empty and a broken file is malformed", () => {
	const directory = sandbox();
	try {
		const missing = readConfigFile(join(directory, CONFIG_FILE_NAME));
		assert.equal(missing.malformed, false);
		assert.deepEqual(missing.config, emptyConfig());

		const brokenPath = join(directory, "broken.json");
		writeFileSync(brokenPath, "{ nope");
		const broken = readConfigFile(brokenPath);
		assert.equal(broken.malformed, true);
		assert.deepEqual(broken.config, emptyConfig());

		const unreadable = readConfigFile(directory);
		assert.equal(unreadable.malformed, true, "an unreadable path is malformed, not fatal");

		assert.throws(() => writeConfigFile(broken), /malformed/);
		assert.equal(readFileSync(brokenPath, "utf8"), "{ nope", "the broken file must not be touched");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("writeConfigFile creates the directory, replaces the file atomically, and round-trips", () => {
	const directory = sandbox();
	try {
		const file = readConfigFile(join(directory, ".pi", CONFIG_FILE_NAME));
		setDisabled(file.config, "tools", "exa_request", true);
		writeConfigFile(file);
		const first = statSync(file.path).ino;

		setDisabled(file.config, "skills", "pdf", true);
		writeConfigFile(file);
		// rename(2) replaces the inode; a direct overwrite would keep it.
		assert.notEqual(statSync(file.path).ino, first, "the write must replace the file through rename");
		assert.deepEqual(
			readdirSync(join(directory, ".pi")).filter((name) => name.includes(".tmp-")),
			[],
			"no temporary file may survive the write",
		);

		const reread = readConfigFile(file.path);
		assert.equal(reread.malformed, false);
		assert.deepEqual(reread.config.disabled, { tools: ["exa_request"], skills: ["pdf"], packages: [], sections: [] });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("configuration paths are the documented ones", () => {
	assert.equal(userConfigPath("/home/someone/.pi/agent"), join("/home/someone/.pi/agent", CONFIG_FILE_NAME));
	assert.equal(projectConfigPath("/work/repo"), join("/work/repo", ".pi", CONFIG_FILE_NAME));
});

test("unlisted targets stay enabled and each layer can override the previous", () => {
	const user = config('{"disabled":{"tools":["a"],"packages":["npm:pkg"]}}');
	const project = config('{"enabled":{"tools":["a"],"packages":["npm:pkg"]}}');
	assert.equal(resolveConfig(emptyConfig(), undefined).isDisabled({ kind: "tools", name: "a" }), false);
	assert.equal(resolveConfig(user, undefined).isDisabled({ kind: "tools", name: "a" }), true);
	assert.equal(resolveConfig(user, undefined).isDisabled({ kind: "tools", name: "b" }), false);
	assert.equal(resolveConfig(user, undefined).isDisabled({ kind: "skills", name: "s" }), false);
	assert.equal(resolveConfig(emptyConfig(), project).isDisabled({ kind: "tools", name: "a" }), false);
	assert.equal(resolveConfig(user, project).isDisabled({ kind: "tools", name: "a" }), false);
	assert.equal(resolveConfig(user, undefined).isDisabled({ kind: "skills", name: "s", packageName: "npm:pkg" }), true);
	assert.equal(resolveConfig(user, project).isDisabled({ kind: "skills", name: "s", packageName: "npm:pkg" }), false);
	assert.equal(resolveConfig(user, project).isDisabled({ kind: "packages", name: "npm:pkg" }), false);
});

test("sections resolve through the same layers as other targets", () => {
	const user = config('{"sections":{"disabled":["docs"]}}');
	const project = config('{"sections":{"enabled":["docs"]}}');
	assert.equal(resolveConfig(user, undefined).isDisabled({ kind: "sections", name: "docs" }), true);
	assert.equal(resolveConfig(user, undefined).isDisabled({ kind: "sections", name: "rules" }), false);
	assert.equal(resolveConfig(user, project).isDisabled({ kind: "sections", name: "docs" }), false);
});

test("an enable override inside one layer beats that layer's package disable", () => {
	const user = config('{"disabled":{"packages":["npm:pkg"],"tools":["b"]},"enabled":{"tools":["a"]}}');
	const resolved = resolveConfig(user, undefined);
	assert.equal(resolved.isDisabled({ kind: "tools", name: "a", packageName: "npm:pkg" }), false);
	assert.equal(resolved.isDisabled({ kind: "tools", name: "b", packageName: "npm:pkg" }), true);
	assert.equal(resolved.isDisabled({ kind: "tools", name: "c", packageName: "npm:pkg" }), true);
});

test("setDisabled and setEnabled keep a stable sorted list", () => {
	const user = emptyConfig();
	setDisabled(user, "skills", "b", true);
	setDisabled(user, "skills", "a", true);
	setDisabled(user, "skills", "b", false);
	setEnabled(user, "skills", "z", true);
	assert.deepEqual(user.disabled.skills, ["a"]);
	assert.deepEqual(user.enabled.skills, ["z"]);
});

test("toggling off records a disable in the edited scope", () => {
	const user = emptyConfig();
	toggleInScope(user, undefined, "user", { kind: "tools", name: "a" }, false);
	assert.deepEqual(user.disabled.tools, ["a"]);
	assert.deepEqual(user.enabled.tools, []);
});

test("toggling on clears the disable and needs no override when nothing else disables it", () => {
	const user = config('{"disabled":{"tools":["a"]},"enabled":{"tools":["a"]}}');
	toggleInScope(user, undefined, "user", { kind: "tools", name: "a" }, true);
	assert.deepEqual(user.disabled.tools, []);
	assert.deepEqual(user.enabled.tools, []);
});

test("a project enable overrides a user disable, and a project disable records its own entry", () => {
	const user = config('{"disabled":{"tools":["a","b"]}}');
	const project = emptyConfig();
	toggleInScope(user, project, "project", { kind: "tools", name: "a" }, true);
	toggleInScope(user, project, "project", { kind: "tools", name: "b" }, false);
	assert.deepEqual(project.enabled.tools, ["a"]);
	assert.deepEqual(project.disabled.tools, ["b"]);
	const resolved = resolveConfig(user, project);
	assert.equal(resolved.isDisabled({ kind: "tools", name: "a" }), false);
	assert.equal(resolved.isDisabled({ kind: "tools", name: "b" }), true);
});

test("an item can be enabled inside a disabled package in the same scope", () => {
	const user = config('{"disabled":{"packages":["npm:pkg"]}}');
	toggleInScope(user, undefined, "user", { kind: "tools", name: "a", packageName: "npm:pkg" }, true);
	assert.deepEqual(user.enabled.tools, ["a"]);
	assert.equal(resolveConfig(user, undefined).isDisabled({ kind: "tools", name: "a", packageName: "npm:pkg" }), false);
});

test("toggling in the project scope without a project file fails loudly", () => {
	assert.throws(
		() => toggleInScope(emptyConfig(), undefined, "project", { kind: "tools", name: "a" }, true),
		/project scope is unavailable/,
	);
});

test("layerState reports only direct entries in that file", () => {
	const user = config('{"disabled":{"tools":["a"]},"enabled":{"skills":["s"]}}');
	assert.equal(layerState(user, { kind: "tools", name: "a" }), "disabled");
	assert.equal(layerState(user, { kind: "skills", name: "s" }), "enabled");
	assert.equal(layerState(user, { kind: "tools", name: "b" }), "unset");
	assert.equal(layerState(undefined, { kind: "tools", name: "a" }), "unset");
});
