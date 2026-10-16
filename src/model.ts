/**
 * The vocabulary shared by the config file, the resolver, and the picker:
 * resource kinds, the three-way setting of one file, and the target a setting
 * applies to. Kept apart from config.ts so the legacy reader can use these
 * types without importing the current format.
 */

export type ResourceKind = "tools" | "skills" | "packages" | "sections";
export const RESOURCE_KINDS: readonly ResourceKind[] = ["tools", "skills", "packages", "sections"];

export type ScopeName = "user" | "project";

/** What a file says about one target. */
export type Value = "on" | "off";

/** A file's setting for one target. `inherit` means the file has no entry, so the target falls through. */
export type Setting = Value | "inherit";

/** Explicit values of one file, keyed by resource kind and then by name. */
export type Values = Record<ResourceKind, Record<string, Value>>;

/** A tool, a skill, a package or MCP group, or a prompt section. */
export interface ToggleTarget {
	kind: ResourceKind;
	name: string;
	/** Normalized package key when a package or MCP group owns the tool or skill. */
	packageName?: string;
}

export function emptyValues(): Values {
	return { tools: {}, skills: {}, packages: {}, sections: {} };
}

/** The picker's cycle: inherit, then on, then off, then back to inherit. */
export function nextSetting(current: Setting): Setting {
	if (current === "inherit") return "on";
	if (current === "on") return "off";
	return "inherit";
}
