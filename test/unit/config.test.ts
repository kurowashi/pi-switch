/**
 * Unit: configuration parsing, resolution, and persistence (format version 2).
 *
 * The rules under test are the user-facing contract in README.md#設定: each
 * file holds one value per target, the project file wins over the user file,
 * an item's own entry wins over its package's entry in the same file, and a
 * target no file sets has no value. A malformed file is ignored without ever
 * being overwritten.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CONFIG_FILE_NAME,
	emptyConfig,
	parseConfig,
	projectConfigPath,
	readConfigFile,
	resolveConfig,
	type ScopeConfig,
	serializeConfig,
	setValue,
	userConfigPath,
	valueIn,
	writeConfigFile,
} from "../../src/config.ts";
import type { ToggleTarget } from "../../src/model.ts";

function sandbox(): string {
	return mkdtempSync(join(tmpdir(), "pi-switch-config-"));
}

function config(source: string): ScopeConfig {
	const parsed = parseConfig(source);
	assert.ok(parsed.ok, `fixture must parse: ${JSON.stringify(parsed)}`);
	return parsed.config;
}

/** The value a target resolves to, with `undefined` meaning no file sets it. */
function valueAt(user: ScopeConfig, project: ScopeConfig | undefined, target: ToggleTarget) {
	return resolveConfig(user, project).resolve(target).value;
}

test("an empty object is a valid version 2 config", () => {
	const parsed = parseConfig("{}");
	assert.ok(parsed.ok);
	assert.equal(parsed.config.version, 2);
	assert.deepEqual(parsed.config.values, { tools: {}, skills: {}, packages: {}, sections: {} });
	assert.deepEqual(parsed.config.extra, {});
});

test("values parse as on and off per kind, and anything else is rejected", () => {
	const parsed = parseConfig('{"version":2,"tools":{"b":"off","a":"on"},"packages":{"npm:pkg":"off"}}');
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.config.values.tools, { b: "off", a: "on" });
	assert.deepEqual(parsed.config.values.packages, { "npm:pkg": "off" });

	assert.equal(parseConfig('{"version":2,"tools":{"a":true}}').ok, false);
	assert.equal(parseConfig('{"version":2,"tools":{"a":"inherit"}}').ok, false, "inherit is the absence of an entry");
	assert.equal(parseConfig('{"version":2,"tools":{"":"off"}}').ok, false);
	assert.equal(parseConfig('{"version":2,"tools":["a"]}').ok, false);
	assert.equal(parseConfig('{"version":2,"tools":"a"}').ok, false);
	assert.equal(parseConfig("not json").ok, false);
	assert.equal(parseConfig("[]").ok, false);
	assert.equal(parseConfig('{"version":"two"}').ok, false);
	assert.equal(parseConfig('{"version":3}').ok, false);
});

test("sections are a top-level kind with the same value form", () => {
	const parsed = parseConfig('{"version":2,"sections":{"docs":"off","rules":"on"}}');
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.config.values.sections, { docs: "off", rules: "on" });
	assert.equal(
		parseConfig('{"version":2,"disabled":{"sections":{"docs":"off"}}}').ok,
		true,
		"unknown keys are kept as extra",
	);
	assert.equal(parseConfig('{"version":2,"sections":["docs"]}').ok, false);
});

test("unknown top-level fields survive a write", () => {
	const parsed = parseConfig('{"version":2,"note":"keep me","tools":{"a":"off"}}');
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.config.extra, { note: "keep me" });
	const serialized = JSON.parse(serializeConfig(parsed.config)) as Record<string, unknown>;
	assert.equal(serialized["note"], "keep me");
	assert.deepEqual(serialized["tools"], { a: "off" });
	assert.equal(serialized["skills"], undefined, "empty kinds are not written");
});

test("serialization writes the version and sorted names", () => {
	const user = emptyConfig();
	setValue(user, { kind: "tools", name: "b" }, "off");
	setValue(user, { kind: "tools", name: "a" }, "on");
	assert.equal(serializeConfig(user), '{\n  "version": 2,\n  "tools": {\n    "a": "on",\n    "b": "off"\n  }\n}\n');
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
		setValue(file.config, { kind: "tools", name: "exa_request" }, "off");
		writeConfigFile(file);
		const first = statSync(file.path).ino;

		setValue(file.config, { kind: "skills", name: "pdf" }, "on");
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
		assert.deepEqual(reread.config.values.tools, { exa_request: "off" });
		assert.deepEqual(reread.config.values.skills, { pdf: "on" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("configuration paths are the documented ones", () => {
	assert.equal(userConfigPath("/home/someone/.pi/agent"), join("/home/someone/.pi/agent", CONFIG_FILE_NAME));
	assert.equal(projectConfigPath("/work/repo"), join("/work/repo", ".pi", CONFIG_FILE_NAME));
});

test("a target no file sets has no value, so the caller's default applies", () => {
	const user = config('{"version":2,"tools":{"a":"off"}}');
	assert.equal(valueAt(emptyConfig(), undefined, { kind: "tools", name: "a" }), undefined);
	assert.equal(valueAt(user, undefined, { kind: "tools", name: "a" }), "off");
	assert.equal(valueAt(user, undefined, { kind: "tools", name: "b" }), undefined);
});

test("the project file wins over the user file whenever it sets the target", () => {
	const user = config('{"version":2,"tools":{"a":"off"},"skills":{"s":"on"}}');
	const project = config('{"version":2,"tools":{"a":"on"},"skills":{"s":"off"}}');
	assert.equal(valueAt(user, project, { kind: "tools", name: "a" }), "on");
	assert.equal(valueAt(user, project, { kind: "skills", name: "s" }), "off");
	assert.equal(valueAt(user, emptyConfig(), { kind: "tools", name: "a" }), "off", "an empty project inherits");
});

test("a project entry beats the user's package, and the project's package beats the user's entry", () => {
	const user = config('{"version":2,"packages":{"npm:pkg":"off"}}');
	const project = config('{"version":2,"tools":{"x":"on"}}');
	const target: ToggleTarget = { kind: "tools", name: "x", packageName: "npm:pkg" };
	assert.equal(valueAt(user, project, target), "on", "the project's own entry wins over the user's package");
	assert.equal(valueAt(user, emptyConfig(), target), "off", "the user's package applies when nothing closer sets it");

	const userItem = config('{"version":2,"tools":{"x":"on"}}');
	const projectPackage = config('{"version":2,"packages":{"npm:pkg":"off"}}');
	assert.equal(valueAt(userItem, projectPackage, target), "off", "project wins even over the user's own entry");
});

test("inside one file an item's entry beats its package's entry", () => {
	const user = config('{"version":2,"packages":{"npm:pkg":"off"},"tools":{"a":"on"}}');
	assert.equal(valueAt(user, undefined, { kind: "tools", name: "a", packageName: "npm:pkg" }), "on");
	assert.equal(valueAt(user, undefined, { kind: "tools", name: "b", packageName: "npm:pkg" }), "off");
});

test("resolution reports the scope and the entry that decided", () => {
	const user = config('{"version":2,"packages":{"npm:pkg":"off"}}');
	const project = config('{"version":2,"tools":{"a":"on"}}');
	const resolved = resolveConfig(user, project);
	assert.deepEqual(resolved.resolve({ kind: "tools", name: "a", packageName: "npm:pkg" }), {
		value: "on",
		scope: "project",
		via: "entry",
	});
	assert.deepEqual(resolved.resolve({ kind: "tools", name: "b", packageName: "npm:pkg" }), {
		value: "off",
		scope: "user",
		via: "package",
	});
	assert.deepEqual(resolved.resolve({ kind: "tools", name: "c" }), {});
});

test("valueIn reads only the file's own entry", () => {
	const user = config('{"version":2,"packages":{"npm:pkg":"off"},"tools":{"a":"on"}}');
	assert.equal(valueIn(user, { kind: "tools", name: "a", packageName: "npm:pkg" }), "on");
	assert.equal(valueIn(user, { kind: "tools", name: "b", packageName: "npm:pkg" }), "inherit");
	assert.equal(valueIn(undefined, { kind: "tools", name: "a" }), "inherit");
});

test("setValue writes on, writes off, and removes the entry on inherit", () => {
	const user = emptyConfig();
	const target: ToggleTarget = { kind: "skills", name: "pdf" };
	setValue(user, target, "off");
	assert.deepEqual(user.values.skills, { pdf: "off" });
	setValue(user, target, "on");
	assert.deepEqual(user.values.skills, { pdf: "on" });
	setValue(user, target, "inherit");
	assert.deepEqual(user.values.skills, {});
});
