/**
 * pi-switch resource discovery: which tools and skills this session sees, which
 * package owns each one, and the effective on/off state under a resolved
 * configuration.
 *
 * Tools come from the live registry (`pi.getAllTools()`); skills come from the
 * prompt options at command time (`ctx.getSystemPromptOptions()`) or from the
 * `before_agent_start` event. `hidden` tools are never listed: Pi ignores them
 * in `setActiveTools`. See README.md#動作 for the user-facing description.
 */

import type { Skill, SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig, ToggleTarget } from "./config.ts";

type ItemKind = "tool" | "skill";

export interface CatalogItem {
	kind: ItemKind;
	name: string;
	description: string;
	/** Normalized package key when a Pi package owns this resource. */
	packageName?: string;
}

export interface PackageEntry {
	name: string;
	tools: string[];
	skills: string[];
}

export interface Catalog {
	items: CatalogItem[];
	packages: PackageEntry[];
}

export type PackageState = "on" | "off" | "partial";

/** Drop the version so `npm:pi-exa@1.2.3` and `npm:pi-exa` group together. */
export function packageKeyFromSource(source: string): string {
	if (!source.startsWith("npm:")) return source;
	const spec = source.slice("npm:".length);
	const at = spec.lastIndexOf("@");
	return at > 0 ? `npm:${spec.slice(0, at)}` : source;
}

export function collectCatalog(tools: readonly ToolInfo[], skills: readonly Skill[]): Catalog {
	const items: CatalogItem[] = [];
	const packages = new Map<string, PackageEntry>();
	for (const tool of tools) {
		if (tool.exposure === "hidden") continue;
		const item: CatalogItem = { kind: "tool", name: tool.name, description: tool.description };
		const packageName = ownedPackage(tool.sourceInfo);
		if (packageName !== undefined) {
			item.packageName = packageName;
			packageFor(packages, packageName).tools.push(tool.name);
		}
		items.push(item);
	}
	for (const skill of skills) {
		const item: CatalogItem = { kind: "skill", name: skill.name, description: skill.description };
		const packageName = ownedPackage(skill.sourceInfo);
		if (packageName !== undefined) {
			item.packageName = packageName;
			packageFor(packages, packageName).skills.push(skill.name);
		}
		items.push(item);
	}
	return { items, packages: [...packages.values()].sort((left, right) => left.name.localeCompare(right.name)) };
}

export function itemTarget(item: CatalogItem): ToggleTarget {
	const target: ToggleTarget = { kind: item.kind === "tool" ? "tools" : "skills", name: item.name };
	if (item.packageName !== undefined) target.packageName = item.packageName;
	return target;
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

export function activeToolNames(
	baseline: readonly string[],
	tools: readonly ToolInfo[],
	resolved: ResolvedConfig,
): string[] {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	return baseline.filter((name) => {
		const tool = byName.get(name);
		// A tool the catalog does not know (registered after discovery) keeps its state.
		if (tool === undefined) return true;
		return !resolved.isDisabled(targetFor("tools", tool.name, tool.sourceInfo));
	});
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

function packageFor(packages: Map<string, PackageEntry>, name: string): PackageEntry {
	const existing = packages.get(name);
	if (existing !== undefined) return existing;
	const entry: PackageEntry = { name, tools: [], skills: [] };
	packages.set(name, entry);
	return entry;
}
