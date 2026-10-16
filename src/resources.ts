/**
 * pi-switch resource discovery: which tools, skills, and prompt sections this
 * session sees, which package or MCP server owns each one, and the effective
 * on/off state under a resolved configuration.
 *
 * Tools come from the live registry (`pi.getAllTools()`); skills come from the
 * prompt options at command time (`ctx.getSystemPromptOptions()`) or from the
 * `before_agent_start` event; prompt sections come from the names observed in
 * `context_with_system` plus {@link BUILTIN_SECTIONS}. `hidden` tools are never
 * listed: Pi ignores them in `setActiveTools`. MCP tools carry a `mcp__<server>`
 * namespace, which pi-switch uses as their group key. See README.md#仕組み for the
 * user-facing description.
 */

import type { SystemMessage } from "@earendil-works/pi-ai";
import type { Skill, SourceInfo, ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import type { ToggleTarget, Value } from "./model.ts";

/**
 * The state Pi gives a target that no config file sets. Tools use the state they
 * had when pi-switch first saw them; skills and sections are always on.
 */
export type DefaultOn = (target: ToggleTarget) => boolean;

type ItemKind = "tool" | "skill" | "section";

export interface CatalogItem {
	kind: ItemKind;
	name: string;
	description: string;
	/** Normalized package or MCP group key when one owns this resource. */
	packageName?: string;
}

export interface PackageEntry {
	name: string;
	/** A Pi package source or an MCP server namespace group. */
	kind: "package" | "mcp";
	/** The MCP server description, when the server configured one. */
	description?: string;
	tools: string[];
	skills: string[];
}

export interface Catalog {
	items: CatalogItem[];
	packages: PackageEntry[];
}

/** One prompt section with the one-line description the picker shows. */
export interface SectionEntry {
	name: string;
	description: string;
}

/**
 * Sections Pi always builds for the default prompt. Extensions can add more
 * (for example `knowledge_index`); the picker also lists names observed at
 * request time.
 */
export const BUILTIN_SECTIONS: readonly SectionEntry[] = [
	{ name: "preamble", description: "Assistant identity and opening instructions" },
	{ name: "tools", description: "Available tools with their one-line snippets" },
	{ name: "rules", description: "Behavioral guidelines the model follows" },
	{ name: "docs", description: "Pi documentation paths and when to read them" },
	{ name: "addendum", description: "Extra instructions appended from configuration" },
	{ name: "project_context", description: "Preloaded project files such as AGENTS.md" },
	{ name: "skills", description: "Available skills and how to invoke them" },
	{ name: "cwd", description: "Current working directory" },
];

export type PackageState = "on" | "off" | "partial";

/** Tool exposures that put a tool in the model's declaration list. */
const DECLARABLE_EXPOSURES: readonly ToolExposure[] = ["direct", "model-only"];
/** Prefix Pi gives MCP server tool groups (`mcpNamespace()`). */
const MCP_NAMESPACE_PREFIX = "mcp__";

/** Drop the version so `npm:pi-exa@1.2.3` and `npm:pi-exa` group together. */
export function packageKeyFromSource(source: string): string {
	if (!source.startsWith("npm:")) return source;
	const spec = source.slice("npm:".length);
	const at = spec.lastIndexOf("@");
	return at > 0 ? `npm:${spec.slice(0, at)}` : source;
}

export function collectCatalog(
	tools: readonly ToolInfo[],
	skills: readonly Skill[],
	sections: readonly SectionEntry[] = [],
): Catalog {
	const items: CatalogItem[] = [];
	const packages = new Map<string, PackageEntry>();
	for (const tool of tools) {
		if (tool.exposure === "hidden") continue;
		const item: CatalogItem = { kind: "tool", name: tool.name, description: tool.description };
		const packageName = toolPackageName(tool);
		if (packageName !== undefined) {
			item.packageName = packageName;
			const kind = ownedPackage(tool.sourceInfo) !== undefined ? "package" : "mcp";
			const entry = packageFor(packages, packageName, kind);
			setPackageDescription(entry, tool);
			entry.tools.push(tool.name);
		}
		items.push(item);
	}
	for (const skill of skills) {
		const item: CatalogItem = { kind: "skill", name: skill.name, description: skill.description };
		const packageName = ownedPackage(skill.sourceInfo);
		if (packageName !== undefined) {
			item.packageName = packageName;
			packageFor(packages, packageName, "package").skills.push(skill.name);
		}
		items.push(item);
	}
	for (const section of sections) {
		items.push({ kind: "section", name: section.name, description: section.description });
	}
	return { items, packages: [...packages.values()].sort((left, right) => left.name.localeCompare(right.name)) };
}

export function itemTarget(item: CatalogItem): ToggleTarget {
	const kind = item.kind === "tool" ? "tools" : item.kind === "skill" ? "skills" : "sections";
	const target: ToggleTarget = { kind, name: item.name };
	if (item.packageName !== undefined) target.packageName = item.packageName;
	return target;
}

/** The target for one live tool, including its package or MCP group. */
export function toolTarget(tool: ToolInfo): ToggleTarget {
	const target: ToggleTarget = { kind: "tools", name: tool.name };
	const packageName = toolPackageName(tool);
	if (packageName !== undefined) target.packageName = packageName;
	return target;
}

export function filterPromptSections(current: SystemMessage, resolved: ResolvedConfig): SystemMessage | undefined {
	const sections = current.sections;
	if (sections === undefined) return undefined;
	const kept: Record<string, string> = {};
	let removed = false;
	for (const [name, text] of Object.entries(sections)) {
		if (text === null) continue;
		if (isExplicitlyOff(resolved, { kind: "sections", name })) {
			removed = true;
			continue;
		}
		kept[name] = text;
	}
	// No disabled section: leave the message untouched so Pi keeps its replay-identical head.
	if (!removed) return undefined;
	return { ...current, sections: kept };
}

/** The effective state of one target: the config value when a file sets it, otherwise the default. */
export function isOn(resolved: ResolvedConfig, target: ToggleTarget, defaultOn: DefaultOn): boolean {
	const value = resolved.resolve(target).value;
	if (value === undefined) return defaultOn(target);
	return value === "on";
}

/** Only an explicit `off` removes a prompt section or a skill; an unset one stays as Pi built it. */
function isExplicitlyOff(resolved: ResolvedConfig, target: ToggleTarget): boolean {
	return resolved.resolve(target).value === "off";
}

export function itemOn(resolved: ResolvedConfig, item: CatalogItem, defaultOn: DefaultOn): boolean {
	return isOn(resolved, itemTarget(item), defaultOn);
}

export function filterSkills(skills: readonly Skill[], resolved: ResolvedConfig): Skill[] {
	return skills.filter((skill) => !isExplicitlyOff(resolved, targetFor("skills", skill.name, skill.sourceInfo)));
}

export interface ToolState {
	/** Names to pass to `setActiveTools`. */
	active: string[];
	/** Tools pi-switch removed, kept so that inheriting them again restores Pi's default. */
	hidden: string[];
}

/**
 * Reconcile the active tool set with the config.
 *
 * `off` removes a tool and `on` adds it, even when Pi started it inactive. An
 * unset tool is left as it is, except that a tool pi-switch removed earlier comes
 * back when Pi's default is on. Tools Pi activated after the session started
 * (MCP servers connect late) keep their state unless the config says otherwise.
 */
export function applyToolState(
	current: readonly string[],
	hidden: readonly string[],
	tools: readonly ToolInfo[],
	resolved: ResolvedConfig,
	defaultOn: DefaultOn,
): ToolState {
	const active = new Set(current);
	const removed = new Set(hidden);
	for (const tool of tools) {
		if (!isDeclarable(tool)) continue;
		applyOne(tool, resolved.resolve(toolTarget(tool)).value, defaultOn, active, removed);
	}
	// Drop names that unregistered or changed to a non-declarable exposure: they cannot be restored.
	const restorable = [...removed].filter((name) => {
		const tool = tools.find((candidate) => candidate.name === name);
		return tool !== undefined && isDeclarable(tool);
	});
	return { active: orderedNames(tools, current, active), hidden: restorable };
}

/** Move one tool to the state its value (or Pi's default) asks for; `active` and `removed` are updated in place. */
function applyOne(
	tool: ToolInfo,
	value: Value | undefined,
	defaultOn: DefaultOn,
	active: Set<string>,
	removed: Set<string>,
): void {
	const target = toolTarget(tool);
	if (value === "off") {
		active.delete(tool.name);
		removed.add(tool.name);
		return;
	}
	if (value === "on") {
		active.add(tool.name);
		removed.delete(tool.name);
		return;
	}
	if (removed.has(tool.name)) {
		// Inherit again: pi-switch stops managing the tool and Pi's default applies.
		removed.delete(tool.name);
		if (defaultOn(target)) active.add(tool.name);
	}
}

/** Registered tools first in registration order, then names the catalog does not know. */
function orderedNames(tools: readonly ToolInfo[], current: readonly string[], active: ReadonlySet<string>): string[] {
	const order = new Map<string, number>();
	for (const name of [...tools.map((tool) => tool.name), ...current]) {
		if (!order.has(name)) order.set(name, order.size);
	}
	return [...order.keys()].filter((name) => active.has(name));
}

/** The tools and skills a package or MCP group owns, as toggle targets. */
export function packageChildren(catalog: Catalog, name: string): ToggleTarget[] {
	const entry = catalog.packages.find((candidate) => candidate.name === name);
	if (entry === undefined) return [];
	return [
		...entry.tools.map((tool) => withPackage({ kind: "tools" as const, name: tool }, name)),
		...entry.skills.map((skill) => withPackage({ kind: "skills" as const, name: skill }, name)),
	];
}

/** A package row is on or off when all its children agree; mixed children show as partial. */
export function packageState(
	catalog: Catalog,
	resolved: ResolvedConfig,
	name: string,
	defaultOn: DefaultOn,
): PackageState {
	const targets = packageChildren(catalog, name);
	if (targets.length === 0) return isOn(resolved, { kind: "packages", name }, defaultOn) ? "on" : "off";
	const on = targets.filter((target) => isOn(resolved, target, defaultOn)).length;
	if (on === targets.length) return "on";
	if (on === 0) return "off";
	return "partial";
}

function isDeclarable(tool: ToolInfo): boolean {
	return DECLARABLE_EXPOSURES.includes(tool.exposure);
}

/** The package or MCP group a tool belongs to; a package source wins over a namespace. */
function toolPackageName(tool: ToolInfo): string | undefined {
	return ownedPackage(tool.sourceInfo) ?? mcpPackageName(tool);
}

function mcpPackageName(tool: ToolInfo): string | undefined {
	const name = tool.namespace?.name;
	return name?.startsWith(MCP_NAMESPACE_PREFIX) ? name : undefined;
}

function setPackageDescription(entry: PackageEntry, tool: ToolInfo): void {
	if (entry.kind !== "mcp" || entry.description !== undefined) return;
	const description = tool.namespace?.description?.trim();
	if (description !== undefined && description !== "") entry.description = description;
}

function targetFor(kind: "tools" | "skills", name: string, sourceInfo: SourceInfo): ToggleTarget {
	const target: ToggleTarget = { kind, name };
	const packageName = ownedPackage(sourceInfo);
	if (packageName !== undefined) target.packageName = packageName;
	return target;
}

function ownedPackage(sourceInfo: SourceInfo): string | undefined {
	return sourceInfo.origin === "package" ? packageKeyFromSource(sourceInfo.source) : undefined;
}

function withPackage(target: ToggleTarget, packageName: string): ToggleTarget {
	return { ...target, packageName };
}

function packageFor(packages: Map<string, PackageEntry>, name: string, kind: PackageEntry["kind"]): PackageEntry {
	const existing = packages.get(name);
	if (existing !== undefined) return existing;
	const entry: PackageEntry = { name, kind, tools: [], skills: [] };
	packages.set(name, entry);
	return entry;
}
