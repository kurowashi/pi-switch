/**
 * pi-switch configuration: where the two files live, how they are parsed,
 * merged into an effective state, and written back.
 *
 * The user file is `<agent dir>/pi-switch.json`; the project file is
 * `<cwd>/.pi/pi-switch.json` and is read and written only in trusted projects.
 * A target is disabled when a layer disables it and no later layer enables it.
 * Layers apply in order, user then project, and inside a layer the enabled list
 * wins over the disabled list. Targets that no list mentions stay enabled.
 * Prompt sections live in the top-level `sections` key instead of the
 * `disabled` / `enabled` maps, so older versions keep the file valid as an
 * unknown top-level field. See README.md#設定 for the user-facing description.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "pi-switch.json";
const CONFIG_VERSION = 1;

export type ResourceKind = "tools" | "skills" | "packages" | "sections";
export type ScopeName = "user" | "project";

/** Kinds stored inside the `disabled` / `enabled` maps; sections have their own key. */
type DiskKind = Exclude<ResourceKind, "sections">;

const DISK_KINDS: readonly DiskKind[] = ["tools", "skills", "packages"];
const RESOURCE_KINDS: readonly ResourceKind[] = [...DISK_KINDS, "sections"];

/** A tool, a skill, or a whole package. */
export interface ToggleTarget {
	kind: ResourceKind;
	name: string;
	/** Normalized package key when a package owns the tool or skill. */
	packageName?: string;
}

/** One file's lists, keyed by resource kind. */
type Lists = Record<"disabled" | "enabled", Record<ResourceKind, string[]>>;

export interface ScopeConfig extends Lists {
	version: number;
	/** Unknown top-level fields, preserved when the file is rewritten. */
	extra: Record<string, unknown>;
}

interface SectionLists {
	disabled: string[];
	enabled: string[];
}

export interface ScopeFile {
	path: string;
	config: ScopeConfig;
	/** The file exists but is not a valid config. It is never overwritten. */
	malformed: boolean;
}

export type ParseResult = { ok: true; config: ScopeConfig } | { ok: false; error: string };

export interface ResolvedConfig {
	isDisabled(target: ToggleTarget): boolean;
}

export type LayerState = "disabled" | "enabled" | "unset";

export function userConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function emptyConfig(): ScopeConfig {
	return {
		version: CONFIG_VERSION,
		disabled: { tools: [], skills: [], packages: [], sections: [] },
		enabled: { tools: [], skills: [], packages: [], sections: [] },
		extra: {},
	};
}

export function parseConfig(text: string): ParseResult {
	const root = parseRoot(text);
	if (!root.ok) return root;
	const version = root.record["version"] ?? CONFIG_VERSION;
	if (typeof version !== "number" || !Number.isInteger(version) || version !== CONFIG_VERSION) {
		return { ok: false, error: `version must be ${CONFIG_VERSION}` };
	}
	const disabled = parseLists(root.record["disabled"]);
	if (disabled === undefined) {
		return { ok: false, error: "disabled must map tools, skills, and packages to arrays of names" };
	}
	const enabled = parseLists(root.record["enabled"]);
	if (enabled === undefined) {
		return { ok: false, error: "enabled must map tools, skills, and packages to arrays of names" };
	}
	const sections = parseSections(root.record["sections"]);
	if (sections === undefined) {
		return { ok: false, error: "sections must map disabled and enabled to arrays of names" };
	}
	return {
		ok: true,
		config: {
			version,
			disabled: { ...disabled, sections: sections.disabled },
			enabled: { ...enabled, sections: sections.enabled },
			extra: extraFields(root.record),
		},
	};
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

function extraFields(record: Record<string, unknown>): Record<string, unknown> {
	const extra: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (key === "version" || key === "disabled" || key === "enabled" || key === "sections") continue;
		extra[key] = entry;
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
	const output: Record<string, unknown> = { version: config.version };
	const disabled = compactLists(config.disabled);
	if (Object.keys(disabled).length > 0) output["disabled"] = disabled;
	const enabled = compactLists(config.enabled);
	if (Object.keys(enabled).length > 0) output["enabled"] = enabled;
	const sections = compactSections(config.disabled.sections, config.enabled.sections);
	if (sections !== undefined) output["sections"] = sections;
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

export function setDisabled(config: ScopeConfig, kind: ResourceKind, name: string, disabled: boolean): void {
	config.disabled[kind] = withEntry(config.disabled[kind], name, disabled);
}

export function setEnabled(config: ScopeConfig, kind: ResourceKind, name: string, enabled: boolean): void {
	config.enabled[kind] = withEntry(config.enabled[kind], name, enabled);
}

export function resolveConfig(user: ScopeConfig, project: ScopeConfig | undefined): ResolvedConfig {
	const userSets = toSets(user);
	const projectSets = project === undefined ? undefined : toSets(project);
	return {
		isDisabled(target: ToggleTarget): boolean {
			let disabled = false;
			if (matches(userSets, target, "disabled")) disabled = true;
			if (matches(userSets, target, "enabled")) disabled = false;
			if (projectSets !== undefined) {
				if (matches(projectSets, target, "disabled")) disabled = true;
				if (matches(projectSets, target, "enabled")) disabled = false;
			}
			return disabled;
		},
	};
}

/**
 * Set the target in one scope so the effective state becomes `enabled`.
 * Turning on first clears this layer's disable; when the target would still be
 * disabled by another layer or by this layer's package entry, the layer records
 * an explicit enable override.
 */
export function toggleInScope(
	user: ScopeConfig,
	project: ScopeConfig | undefined,
	scope: ScopeName,
	target: ToggleTarget,
	enabled: boolean,
): void {
	const config = scope === "user" ? user : project;
	if (config === undefined) throw new Error("the project scope is unavailable");
	if (!enabled) {
		setEnabled(config, target.kind, target.name, false);
		setDisabled(config, target.kind, target.name, true);
		return;
	}
	setDisabled(config, target.kind, target.name, false);
	const stillDisabled = resolveConfig(user, project).isDisabled(target);
	setEnabled(config, target.kind, target.name, stillDisabled);
}

/** What one file records for a target, ignoring the other layer. */
export function layerState(config: ScopeConfig | undefined, target: ToggleTarget): LayerState {
	if (config === undefined) return "unset";
	if (config.disabled[target.kind].includes(target.name)) return "disabled";
	if (config.enabled[target.kind].includes(target.name)) return "enabled";
	return "unset";
}

interface LayerSets {
	disabled: Map<ResourceKind, Set<string>>;
	enabled: Map<ResourceKind, Set<string>>;
}

function matches(layer: LayerSets, target: ToggleTarget, field: keyof LayerSets): boolean {
	if (layer[field].get(target.kind)?.has(target.name) === true) return true;
	if (target.packageName === undefined) return false;
	return layer[field].get("packages")?.has(target.packageName) === true;
}

function toSets(config: ScopeConfig): LayerSets {
	return {
		disabled: new Map(RESOURCE_KINDS.map((kind) => [kind, new Set(config.disabled[kind])])),
		enabled: new Map(RESOURCE_KINDS.map((kind) => [kind, new Set(config.enabled[kind])])),
	};
}

function parseLists(value: unknown): Record<DiskKind, string[]> | undefined {
	if (value === undefined) return { tools: [], skills: [], packages: [] };
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "tools" && key !== "skills" && key !== "packages") return undefined;
	}
	const lists: Record<DiskKind, string[]> = { tools: [], skills: [], packages: [] };
	for (const kind of DISK_KINDS) {
		const parsed = parseNameList(record[kind]);
		if (parsed === undefined) return undefined;
		lists[kind] = parsed;
	}
	return lists;
}

/** The top-level `sections` key: `disabled` and `enabled` lists of section names. */
function parseSections(value: unknown): SectionLists | undefined {
	if (value === undefined) return { disabled: [], enabled: [] };
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "disabled" && key !== "enabled") return undefined;
	}
	const disabled = parseNameList(record["disabled"]);
	const enabled = parseNameList(record["enabled"]);
	if (disabled === undefined || enabled === undefined) return undefined;
	return { disabled, enabled };
}

function parseNameList(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const names: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0) return undefined;
		names.push(entry);
	}
	return normalizeList(names);
}

function compactLists(lists: Record<ResourceKind, string[]>): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const kind of DISK_KINDS) {
		const names = normalizeList(lists[kind]);
		if (names.length > 0) result[kind] = names;
	}
	return result;
}

function compactSections(
	disabled: readonly string[],
	enabled: readonly string[],
): Record<string, string[]> | undefined {
	const result: Record<string, string[]> = {};
	const off = normalizeList(disabled);
	const on = normalizeList(enabled);
	if (off.length > 0) result["disabled"] = off;
	if (on.length > 0) result["enabled"] = on;
	if (Object.keys(result).length === 0) return undefined;
	return result;
}

function withEntry(names: readonly string[], name: string, present: boolean): string[] {
	const next = new Set(names);
	if (present) next.add(name);
	else next.delete(name);
	return normalizeList([...next]);
}

function normalizeList(names: readonly string[]): string[] {
	return [...new Set(names)].sort();
}
