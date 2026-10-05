/**
 * Contract: the model-facing surface stays empty, and the documented events exist.
 *
 * pi-switch never registers a tool: the model learns about tools through Pi's own
 * declarations, and a pi-switch tool would tax every request. The picker is the
 * only command; the three events are the whole runtime footprint.
 *
 * The extension is loaded through Pi's own loader (jiti), the same path Pi uses
 * at runtime, so these assertions cover the shipped artifact. The loader also
 * scans project and global extension directories, so both are redirected to an
 * empty sandbox.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, type Extension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../helpers/root.ts";

/** The behaviors README.md documents, one registration each. */
const EXPECTED_EVENTS = ["before_agent_start", "context_with_system", "session_start"];
const EXPECTED_COMMANDS = ["switch"];

async function loadExtension(): Promise<Extension> {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-switch-surface-"));
	process.env["PI_CODING_AGENT_DIR"] = sandbox;
	const result: LoadExtensionsResult = await discoverAndLoadExtensions(
		[join(PACKAGE_ROOT, "src", "index.ts")],
		sandbox,
		sandbox,
	);
	assert.deepEqual(result.errors, [], "the extension must load without errors");
	const extension = result.extensions[0];
	assert.ok(extension, "the loader must return the extension");
	assert.equal(result.extensions.length, 1, "the sandbox must load only this extension");
	return extension;
}

test("no tools are registered", async () => {
	const extension = await loadExtension();
	assert.deepEqual([...extension.tools.keys()], [], "a tool would tax every request; the picker is the only surface");
});

test("only the picker command is registered", async () => {
	const extension = await loadExtension();
	assert.deepEqual([...extension.commands.keys()], EXPECTED_COMMANDS);
});

test("every documented event has exactly one handler", async () => {
	const extension = await loadExtension();
	assert.deepEqual([...extension.handlers.keys()].sort(), EXPECTED_EVENTS);
	for (const event of EXPECTED_EVENTS) {
		assert.equal(extension.handlers.get(event)?.length, 1, `${event} must have exactly one handler`);
	}
});
