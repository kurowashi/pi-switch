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
 * namespace, which pi-switch uses as their group key. See README.md#動作 for the
 * user-facing description.
 */

import type { SystemMessage } from "@earendil-works/pi-ai";
import type { Skill, SourceInfo, ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig, ToggleTarget } from "./config.ts";

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
		if (resolved.isDisabled({ kind: "sections", name })) {
			removed = true;
			continue;
		}
		kept[name] = text;
	}
	// No disabled section: leave the message untouched so Pi keeps its replay-identical head.
	if (!removed) return undefined;
	return { ...current, sections: kept };
}

export function itemDisabled(resolved: ResolvedConfig, item: CatalogItem): boolean {
	return resolved.isDisabled(itemTarget(item));
}

export function packageDisabled(resolved: ResolvedConfig, name: string): boolean {
	return resolved.isDisabled({ kind: "packages", name });
}

export function filterSkills(skills: readonly Skill[], resolved: ResolvedConfig): Skill[] {
	return skills.filter((skill) => !resolved.isDisabled(targetFor("skills", skill.name, skill.sourceInfo)));
}

export interface ToolState {
	/** Names to pass to `setActiveTools`. */
	active: string[];
	/** Tool names removed because the config disables them, kept so enabling restores them. */
	hidden: string[];
}

/**
 * Reconcile the active tool set with the resolved configuration.
 *
 * The current set is the base: tools Pi activated after the session started
 * (MCP servers connect late) keep their state unless the config disables them.
 * Removed names are remembered in `hidden` so enabling them again restores
 * them, even when the session transcript no longer carries them.
 */
export function applyToolState(
	current: readonly string[],
	hidden: readonly string[],
	tools: readonly ToolInfo[],
	resolved: ResolvedConfig,
): ToolState {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const hiddenSet = new Set(hidden);
	for (const tool of tools) {
		if (isDeclarable(tool) && resolved.isDisabled(toolTarget(tool))) hiddenSet.add(tool.name);
	}
	const active = new Set<string>();
	for (const name of current) {
		const tool = byName.get(name);
		if (tool !== undefined && resolved.isDisabled(toolTarget(tool))) continue;
		active.add(name);
	}
	for (const name of [...hiddenSet]) {
		const tool = byName.get(name);
		if (tool === undefined || !isDeclarable(tool) || resolved.isDisabled(toolTarget(tool))) continue;
		hiddenSet.delete(name);
		active.add(name);
	}
	// Drop names that unregistered or changed to a non-declarable exposure: they cannot be restored.
	const restorable = [...hiddenSet].filter((name) => {
		const tool = byName.get(name);
		return tool !== undefined && isDeclarable(tool);
	});
	return { active: orderedNames(tools, current, active), hidden: restorable };
}

/** Registered tools first in registration order, then names the catalog does not know. */
function orderedNames(tools: readonly ToolInfo[], current: readonly string[], active: ReadonlySet<string>): string[] {
	const order = new Map<string, number>();
	for (const name of [...tools.map((tool) => tool.name), ...current]) {
		if (!order.has(name)) order.set(name, order.size);
	}
	return [...order.keys()].filter((name) => active.has(name));
}

export function packageState(catalog: Catalog, resolved: ResolvedConfig, name: string): PackageState {
	const entry = catalog.packages.find((candidate) => candidate.name === name);
	if (entry === undefined) return packageDisabled(resolved, name) ? "off" : "on";
	const targets: ToggleTarget[] = [
		...entry.tools.map((tool) => withPackage({ kind: "tools" as const, name: tool }, name)),
		...entry.skills.map((skill) => withPackage({ kind: "skills" as const, name: skill }, name)),
	];
	if (targets.length === 0) return packageDisabled(resolved, name) ? "off" : "on";
	const disabled = targets.filter((target) => resolved.isDisabled(target)).length;
	if (disabled === 0) return "on";
	if (disabled === targets.length) return "off";
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
