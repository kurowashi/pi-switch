/**
 * Reader for the version 1 config format (`disabled` / `enabled` lists per file).
 *
 * This module exists only to migrate files written by pi-switch 0.1.x. It is
 * imported by config.ts alone, and it is deleted in pi-switch 0.3.0 together
 * with its tests (docs/adr/0008-migrate-v1-config-with-removal-deadline.md).
 * Do not add anything here that the current format needs.
 */

import { emptyValues, type ResourceKind, type Values } from "./model.ts";

export type LegacyResult = { ok: true; values: Values; extra: Record<string, unknown> } | { ok: false; error: string };

type LayerKind = Exclude<ResourceKind, "sections">;
type Lists = Record<LayerKind, string[]>;

const V1_KEYS = ["version", "disabled", "enabled", "sections"];

/**
 * Convert a version 1 file into version 2 values.
 *
 * Within one file, `enabled` beat `disabled` for the same name, so the enabled
 * list is applied last. The mapping is per file; the cross-file rules are
 * pinned by test/unit/legacy-v1.test.ts.
 */
export function parseLegacyV1(record: Record<string, unknown>): LegacyResult {
	// A version 2 kind without `"version": 2` would otherwise be kept as an unknown
	// field and silently ignored, so name the fix instead.
	const misplaced = ["tools", "skills", "packages"].find((kind) => kind in record);
	if (misplaced !== undefined) {
		return {
			ok: false,
			error: `${misplaced} at the top level needs "version": 2; version 1 keeps it in disabled/enabled`,
		};
	}
	const disabled = parseLayerLists(record["disabled"]);
	if (disabled === undefined) {
		return { ok: false, error: "disabled must map tools, skills, and packages to arrays of names" };
	}
	const enabled = parseLayerLists(record["enabled"]);
	if (enabled === undefined) {
		return { ok: false, error: "enabled must map tools, skills, and packages to arrays of names" };
	}
	const sections = parseSections(record["sections"]);
	if (sections === undefined) {
		return { ok: false, error: "sections must map disabled and enabled to arrays of names" };
	}
	const values = emptyValues();
	const layerKinds: LayerKind[] = ["tools", "skills", "packages"];
	for (const kind of layerKinds) {
		for (const name of disabled[kind]) values[kind][name] = "off";
	}
	for (const name of sections.disabled) values.sections[name] = "off";
	for (const kind of layerKinds) {
		for (const name of enabled[kind]) values[kind][name] = "on";
	}
	for (const name of sections.enabled) values.sections[name] = "on";
	return { ok: true, values, extra: extraFields(record) };
}

function parseLayerLists(value: unknown): Lists | undefined {
	const parsed = parseNamedLists(value, ["tools", "skills", "packages"]);
	if (parsed === undefined) return undefined;
	return { tools: parsed["tools"] ?? [], skills: parsed["skills"] ?? [], packages: parsed["packages"] ?? [] };
}

function parseSections(value: unknown): { disabled: string[]; enabled: string[] } | undefined {
	const parsed = parseNamedLists(value, ["disabled", "enabled"]);
	if (parsed === undefined) return undefined;
	return { disabled: parsed["disabled"] ?? [], enabled: parsed["enabled"] ?? [] };
}

function parseNamedLists(value: unknown, keys: readonly string[]): Record<string, string[]> | undefined {
	if (value === undefined) return Object.fromEntries(keys.map((key) => [key, []]));
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!keys.includes(key)) return undefined;
	}
	const result: Record<string, string[]> = {};
	for (const key of keys) {
		const names = parseNameList(record[key]);
		if (names === undefined) return undefined;
		result[key] = names;
	}
	return result;
}

function parseNameList(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const names: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0) return undefined;
		names.push(entry);
	}
	return names;
}

function extraFields(record: Record<string, unknown>): Record<string, unknown> {
	const extra: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (!V1_KEYS.includes(key)) extra[key] = entry;
	}
	return extra;
}
