/**
 * pi-switch configuration: where the two files live, how they are parsed,
 * resolved into an effective on/off state, and written back.
 *
 * Each file holds explicit values, `on` or `off`, per target. A target without
 * a value inherits. The project file wins over the user file. Inside one file
 * an item's value wins over its package's value. A target that no file sets
 * has no value here; the caller decides its default. See README.md#設定 and
 * docs/adr/0007-tri-state-values-and-project-precedence.md.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parseLegacyV1 } from "./legacy-v1.ts";
import {
	emptyValues,
	RESOURCE_KINDS,
	type ScopeName,
	type Setting,
	type ToggleTarget,
	type Value,
	type Values,
} from "./model.ts";

export const CONFIG_FILE_NAME = "pi-switch.json";
const CONFIG_VERSION = 2;

export interface ScopeConfig {
	version: number;
	values: Values;
	/** Unknown top-level fields, preserved when the file is rewritten. */
	extra: Record<string, unknown>;
}

export interface ScopeFile {
	path: string;
	config: ScopeConfig;
	/** The file exists but is not a valid config. It is never overwritten. */
	malformed: boolean;
}

export type ParseResult = { ok: true; config: ScopeConfig } | { ok: false; error: string };

/** The value that decides a target, and where it came from. `value` is undefined when no file sets it. */
interface Resolution {
	value?: Value;
	scope?: ScopeName;
	/** `package` when the target's package entry decided, `entry` when the target's own entry did. */
	via?: "entry" | "package";
}

export interface ResolvedConfig {
	resolve(target: ToggleTarget): Resolution;
}

export function userConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function emptyConfig(): ScopeConfig {
	return { version: CONFIG_VERSION, values: emptyValues(), extra: {} };
}

export function parseConfig(text: string): ParseResult {
	const root = parseRoot(text);
	if (!root.ok) return root;
	const version = root.record["version"] ?? 1;
	if (typeof version !== "number" || !Number.isInteger(version) || (version !== 1 && version !== CONFIG_VERSION)) {
		return { ok: false, error: `version must be 1 or ${CONFIG_VERSION}` };
	}
	if (version === 1) return fromLegacy(root.record);
	const values = emptyValues();
	for (const kind of RESOURCE_KINDS) {
		const map = parseValueMap(root.record[kind]);
		if (map === undefined) return { ok: false, error: `${kind} must map names to "on" or "off"` };
		values[kind] = map;
	}
	return { ok: true, config: { version: CONFIG_VERSION, values, extra: extraFields(root.record) } };
}

function fromLegacy(record: Record<string, unknown>): ParseResult {
	const legacy = parseLegacyV1(record);
	if (!legacy.ok) return legacy;
	return { ok: true, config: { version: CONFIG_VERSION, values: legacy.values, extra: legacy.extra } };
}

function parseRoot(text: string): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `invalid JSON (${error instanceof Error ? error.message : String(error)})` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "the root must be an object" };
	}
	return { ok: true, record: value as Record<string, unknown> };
}

function parseValueMap(value: unknown): Record<string, Value> | undefined {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const map: Record<string, Value> = {};
	for (const [name, setting] of Object.entries(value as Record<string, unknown>)) {
		if (name === "" || (setting !== "on" && setting !== "off")) return undefined;
		map[name] = setting;
	}
	return map;
}

function extraFields(record: Record<string, unknown>): Record<string, unknown> {
	const known: readonly string[] = ["version", ...RESOURCE_KINDS];
	const extra: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (!known.includes(key)) extra[key] = entry;
	}
	return extra;
}

/** Read one file. A missing file is an empty config; an unreadable or invalid one is malformed. */
export function readConfigFile(path: string): ScopeFile {
	if (!existsSync(path)) return { path, config: emptyConfig(), malformed: false };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { path, config: emptyConfig(), malformed: true };
	}
	const parsed = parseConfig(text);
	if (!parsed.ok) return { path, config: emptyConfig(), malformed: true };
	return { path, config: parsed.config, malformed: false };
}

export function serializeConfig(config: ScopeConfig): string {
	const output: Record<string, unknown> = { version: CONFIG_VERSION };
	for (const kind of RESOURCE_KINDS) {
		const entries = sortedEntries(config.values[kind]);
		if (entries.length > 0) output[kind] = Object.fromEntries(entries);
	}
	for (const [key, value] of Object.entries(config.extra)) output[key] = value;
	return `${JSON.stringify(output, undefined, 2)}\n`;
}

/** Write the current config atomically. Malformed files are left untouched. */
export function writeConfigFile(file: ScopeFile): void {
	if (file.malformed) throw new Error(`refusing to overwrite a malformed config: ${file.path}`);
	mkdirSync(dirname(file.path), { recursive: true });
	const temporary = `${file.path}.tmp-${process.pid}`;
	writeFileSync(temporary, serializeConfig(file.config), "utf8");
	renameSync(temporary, file.path);
}

/** The setting this file holds for the target's own entry. Package entries are not consulted. */
export function valueIn(config: ScopeConfig | undefined, target: ToggleTarget): Setting {
	return config?.values[target.kind][target.name] ?? "inherit";
}

/** Write one target's setting into one file. `inherit` removes the entry. */
export function setValue(config: ScopeConfig, target: ToggleTarget, setting: Setting): void {
	if (setting === "inherit") {
		const remaining = Object.entries(config.values[target.kind]).filter(([name]) => name !== target.name);
		config.values[target.kind] = Object.fromEntries(remaining);
		return;
	}
	config.values[target.kind][target.name] = setting;
}

/**
 * The project file is consulted first, then the user file. Within one file the
 * target's own entry beats its package's entry.
 */
export function resolveConfig(user: ScopeConfig, project: ScopeConfig | undefined): ResolvedConfig {
	const layers: Array<[ScopeName, ScopeConfig]> =
		project === undefined
			? [["user", user]]
			: [
					["project", project],
					["user", user],
				];
	return {
		resolve(target: ToggleTarget): Resolution {
			for (const [scope, config] of layers) {
				const hit = lookup(config.values, target);
				if (hit !== undefined) return { value: hit.value, scope, via: hit.via };
			}
			return {};
		},
	};
}

function lookup(values: Values, target: ToggleTarget): { value: Value; via: "entry" | "package" } | undefined {
	const entry = values[target.kind][target.name];
	if (entry !== undefined) return { value: entry, via: "entry" };
	if (target.packageName === undefined) return undefined;
	const owner = values.packages[target.packageName];
	return owner === undefined ? undefined : { value: owner, via: "package" };
}

function sortedEntries(map: Record<string, Value>): Array<[string, Value]> {
	return Object.entries(map).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
