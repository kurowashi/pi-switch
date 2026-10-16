/**
 * Unit: migration of version 1 config files (`disabled` / `enabled` lists).
 *
 * This file is deleted with src/legacy-v1.ts in pi-switch 0.3.0
 * (docs/adr/0008-migrate-v1-config-with-removal-deadline.md). The cases pin the
 * meaning v1 files had, so the migrated state keeps the same effective result.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_FILE_NAME, parseConfig, readConfigFile, resolveConfig, writeConfigFile } from "../../src/config.ts";
import type { ToggleTarget } from "../../src/model.ts";

function migrate(source: string) {
	const parsed = parseConfig(source);
	assert.ok(parsed.ok, `v1 fixture must parse: ${JSON.stringify(parsed)}`);
	return parsed.config;
}

test("a v1 disable becomes an off value and a v1 enable becomes an on value", () => {
	const user = migrate('{"version":1,"disabled":{"tools":["a"],"skills":["s"],"packages":["npm:p"]}}');
	assert.deepEqual(user.values.tools, { a: "off" });
	assert.deepEqual(user.values.skills, { s: "off" });
	assert.deepEqual(user.values.packages, { "npm:p": "off" });
	const enabled = migrate('{"enabled":{"tools":["b"]}}');
	assert.deepEqual(enabled.values.tools, { b: "on" });
	assert.equal(enabled.version, 2);
});

test("inside one v1 file the enabled list beats the disabled list for the same name", () => {
	const user = migrate('{"version":1,"disabled":{"tools":["a"]},"enabled":{"tools":["a"]}}');
	assert.deepEqual(user.values.tools, { a: "on" });
});

test("v1 sections map to the top-level sections kind", () => {
	const user = migrate('{"version":1,"sections":{"disabled":["docs"],"enabled":["rules"]}}');
	assert.deepEqual(user.values.sections, { docs: "off", rules: "on" });
	assert.equal(migrate('{"version":1}').values.sections["docs"], undefined);
});

test("unknown v1 top-level fields are kept as extra", () => {
	const user = migrate('{"version":1,"note":"keep me","disabled":{"tools":["a"]}}');
	assert.deepEqual(user.extra, { note: "keep me" });
});

test("v1 shapes that v1 rejected are still rejected", () => {
	assert.equal(parseConfig('{"version":1,"disabled":[]}').ok, false);
	assert.equal(parseConfig('{"version":1,"disabled":{"tools":"a"}}').ok, false);
	assert.equal(parseConfig('{"version":1,"disabled":{"tools":[1]}}').ok, false);
	assert.equal(parseConfig('{"version":1,"disabled":{"tols":[]}}').ok, false);
	assert.equal(parseConfig('{"version":1,"disabled":{"tools":[""]}}').ok, false);
	assert.equal(parseConfig('{"version":1,"disabled":{"sections":["docs"]}}').ok, false, "sections belong at the top");
	assert.equal(parseConfig('{"version":1,"enabled":{"nope":[]}}').ok, false);
	assert.equal(parseConfig('{"version":1,"sections":[]}').ok, false);
	assert.equal(parseConfig('{"version":1,"sections":{"unknown":[]}}').ok, false);
});

test("the cross-file effect of a v1 file matches v2 for the cases v1 documented", () => {
	const globalDisable = migrate('{"version":1,"disabled":{"tools":["a"]}}');
	const projectEnable = migrate('{"version":1,"enabled":{"tools":["a"]}}');
	const target: ToggleTarget = { kind: "tools", name: "a" };
	assert.equal(resolveConfig(globalDisable, projectEnable).resolve(target).value, "on", "project enable wins");

	const globalEnable = migrate('{"version":1,"enabled":{"tools":["a"]}}');
	const projectDisable = migrate('{"version":1,"disabled":{"tools":["a"]}}');
	assert.equal(resolveConfig(globalEnable, projectDisable).resolve(target).value, "off", "project disable wins");

	const globalPackage = migrate('{"version":1,"disabled":{"packages":["npm:p"]},"enabled":{"tools":["a"]}}');
	const child: ToggleTarget = { kind: "tools", name: "a", packageName: "npm:p" };
	assert.equal(resolveConfig(globalPackage, undefined).resolve(child).value, "on", "an enabled item beats its package");
});

test("a v1 file is rewritten as version 2 on its next write", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-switch-legacy-"));
	try {
		const path = join(directory, CONFIG_FILE_NAME);
		writeFileSync(path, '{"version":1,"disabled":{"tools":["a"]}}');
		const file = readConfigFile(path);
		assert.equal(file.malformed, false);
		writeConfigFile(file);
		const rewritten = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.equal(rewritten["version"], 2);
		assert.deepEqual(rewritten["tools"], { a: "off" });
		assert.equal(rewritten["disabled"], undefined);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
