/**
 * The pi-switch picker: one kind at a time (packages, MCP servers, tools,
 * skills, or prompt sections), searchable, with a three-way toggle for the
 * active scope.
 *
 * The component is written by hand instead of using `SelectList` or
 * `SettingsList` because rows carry per-scope badges and each toggle writes
 * files. Tests drive `createScopePicker` directly; `/switch` wraps it in
 * `ctx.ui.custom`. See README.md#コマンド for the keys.
 */

import type { ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeyId, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ResolvedConfig } from "./config.ts";
import { nextSetting, type ScopeName, type Setting, type ToggleTarget } from "./model.ts";
import {
	type Catalog,
	type CatalogItem,
	type DefaultOn,
	isOn,
	itemOn,
	itemTarget,
	type PackageEntry,
	packageChildren,
	packageState,
} from "./resources.ts";

/** The parts of the Pi theme this picker uses. */
interface PickerTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

export interface ScopeInfo {
	name: ScopeName;
	available: boolean;
	reason?: string;
}

/** One write in a batch: the target and the setting its file should hold afterwards. */
export interface SettingChange {
	target: ToggleTarget;
	setting: Setting;
}

export interface ScopePickerDeps {
	catalog(): Catalog;
	resolved(): ResolvedConfig;
	defaultOn: DefaultOn;
	scopes(): ScopeInfo[];
	/** The value the given scope's file holds for the target itself. */
	valueOf(scope: ScopeName, target: ToggleTarget): Setting;
	/** Persist the changes as one write and update the live session. */
	apply(scope: ScopeName, changes: readonly SettingChange[]): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface PickerCallbacks {
	requestRender(): void;
	close(): void;
}

/** Rows shown at once. The terminal height is not available here, so this is fixed. */
const MAX_VISIBLE_ROWS = 14;

/** One kind at a time. Packages and MCP servers are separate because MCP groups are many. */
type Kind = "packages" | "mcp" | "tools" | "skills" | "sections";
const KINDS: readonly Kind[] = ["tools", "skills", "packages", "mcp", "sections"];
const KIND_LABELS: Record<Kind, string> = {
	tools: "Tools",
	skills: "Skills",
	packages: "Packages",
	mcp: "MCP",
	sections: "Sections",
};

type Row = { type: "item"; item: CatalogItem } | { type: "package"; name: string };

interface View {
	rows: Row[];
	selectable: number[];
}

const SCOPE_LABELS: Record<ScopeName, string> = { user: "Global", project: "Project" };
const SCOPE_INITIALS: Record<ScopeName, string> = { user: "g", project: "p" };

function createScopePicker(theme: PickerTheme, deps: ScopePickerDeps, callbacks: PickerCallbacks): Component {
	let scopeIndex = 0;
	let kindIndex = 0;
	let filter = "";
	let selected = 0;

	function scopes(): ScopeInfo[] {
		const list = deps.scopes();
		return list.length > 0 ? list : [{ name: "user", available: true }];
	}

	function activeScope(): ScopeInfo {
		const list = scopes();
		const index = Math.min(scopeIndex, list.length - 1);
		const scope = list[index];
		return scope ?? { name: "user", available: true };
	}

	function activeKind(): Kind {
		return KINDS[kindIndex] ?? "tools";
	}

	function view(): View {
		const catalog = deps.catalog();
		const query = filter.trim().toLowerCase();
		const kind = activeKind();
		const rows: Row[] =
			kind === "packages" || kind === "mcp"
				? catalog.packages
						.filter((entry) => entry.kind === (kind === "mcp" ? "mcp" : "package") && matchesPackage(entry, query))
						.map((entry) => ({ type: "package" as const, name: entry.name }))
				: catalog.items
						.filter((item) => item.kind === itemKindOf(kind) && matchesItem(item, query))
						.map((item) => ({ type: "item" as const, item }));
		return { rows, selectable: rows.map((_row, index) => index) };
	}

	function selectedRow(): Row | undefined {
		return view().rows[selected];
	}

	function refresh(): void {
		const count = view().rows.length;
		selected = count === 0 ? 0 : Math.min(selected, count - 1);
		callbacks.requestRender();
	}

	function move(delta: number): void {
		const count = view().rows.length;
		if (count === 0) return;
		selected = (selected + delta + count) % count;
		callbacks.requestRender();
	}

	function moveTo(index: number): void {
		const count = view().rows.length;
		if (count === 0) return;
		selected = Math.max(0, Math.min(index, count - 1));
		callbacks.requestRender();
	}

	function movePage(direction: number): void {
		moveTo(selected + direction * MAX_VISIBLE_ROWS);
	}

	function switchScope(): void {
		const count = scopes().length;
		scopeIndex = (scopeIndex + 1) % count;
		callbacks.requestRender();
	}

	function switchKind(delta: number): void {
		kindIndex = (kindIndex + delta + KINDS.length) % KINDS.length;
		selected = 0;
		callbacks.requestRender();
	}

	function cycleSelected(): void {
		const scope = activeScope();
		if (!scope.available) {
			deps.notify(`pi-switch: ${scope.reason ?? "the project scope is unavailable"}`, "warning");
			return;
		}
		const row = selectedRow();
		if (row === undefined) return;
		const changes = row.type === "package" ? packageChanges(row.name, scope.name) : [itemChange(row.item, scope.name)];
		deps.apply(scope.name, changes);
		notifyIfBlocked(scope.name, changes);
		refresh();
	}

	function itemChange(item: CatalogItem, scope: ScopeName): SettingChange {
		const target = itemTarget(item);
		return { target, setting: nextSetting(deps.valueOf(scope, target)) };
	}

	/**
	 * A package row owns its children: its setting replaces every child entry in this
	 * scope. Otherwise a child entry left over from before would keep overriding it.
	 */
	function packageChanges(name: string, scope: ScopeName): SettingChange[] {
		const packageTarget: ToggleTarget = { kind: "packages", name };
		const setting = nextSetting(deps.valueOf(scope, packageTarget));
		const children = packageChildren(deps.catalog(), name).map((target) => ({ target, setting: "inherit" as const }));
		return [{ target: packageTarget, setting }, ...children];
	}

	/** Global `on` cannot beat a project `off`; say so instead of leaving the user guessing. */
	function notifyIfBlocked(scope: ScopeName, changes: readonly SettingChange[]): void {
		if (scope !== "user") return;
		const [first] = changes;
		if (first === undefined || first.setting !== "on") return;
		if (isOn(deps.resolved(), first.target, deps.defaultOn)) return;
		deps.notify(
			`pi-switch: enabled globally, but the project config keeps ${first.target.name} disabled here`,
			"warning",
		);
	}

	function editFilter(next: string): void {
		filter = next;
		selected = 0;
		callbacks.requestRender();
	}

	const actions: Array<{ key: KeyId; run(): void }> = [
		{ key: Key.escape, run: handleEscape },
		{ key: Key.ctrl("c"), run: handleEscape },
		{ key: Key.tab, run: switchScope },
		{ key: Key.left, run: () => switchKind(-1) },
		{ key: Key.right, run: () => switchKind(1) },
		{ key: Key.up, run: () => move(-1) },
		{ key: Key.down, run: () => move(1) },
		{ key: Key.pageUp, run: () => movePage(-1) },
		{ key: Key.pageDown, run: () => movePage(1) },
		{ key: Key.home, run: () => moveTo(0) },
		{ key: Key.end, run: () => moveTo(view().rows.length - 1) },
		{ key: Key.space, run: cycleSelected },
		{ key: Key.enter, run: cycleSelected },
		{ key: Key.backspace, run: deleteFilterChar },
		{ key: Key.delete, run: deleteFilterChar },
		{ key: Key.ctrl("u"), run: clearFilter },
	];

	function handleInput(data: string): void {
		for (const action of actions) {
			if (!matchesKey(data, action.key)) continue;
			action.run();
			return;
		}
		if (isPrintable(data)) editFilter(filter + data);
	}

	function handleEscape(): void {
		if (filter !== "") {
			editFilter("");
			return;
		}
		callbacks.close();
	}

	function deleteFilterChar(): void {
		editFilter(filter.slice(0, -1));
	}

	function clearFilter(): void {
		editFilter("");
	}

	function header(width: number): string {
		const tabs = scopes()
			.map((scope, index) => {
				const label = SCOPE_LABELS[scope.name];
				const text = index === scopeIndex ? theme.bold(`[${label}]`) : label;
				if (!scope.available) return theme.fg("warning", text);
				return index === scopeIndex ? theme.fg("accent", text) : theme.fg("muted", text);
			})
			.join(" ");
		const active = activeScope();
		const suffix = active.available ? "" : theme.fg("warning", `  ${active.reason ?? "unavailable"}`);
		return truncateToWidth(`${theme.bold("pi-switch")}  ${tabs}${suffix}`, width);
	}

	function kindLine(width: number): string {
		const tabs = KINDS.map((kind, index) => {
			const label = KIND_LABELS[kind];
			return index === kindIndex ? theme.bold(theme.fg("accent", `[${label}]`)) : theme.fg("muted", label);
		}).join(" ");
		return truncateToWidth(tabs, width);
	}

	function filterLine(width: number): string {
		const prompt = theme.fg("muted", "filter: ");
		if (filter === "") return truncateToWidth(`${prompt}${theme.fg("dim", "type to search")}`, width);
		return truncateToWidth(`${prompt}${filter}`, width);
	}

	/**
	 * Always exactly MAX_VISIBLE_ROWS lines. A shorter list is padded with blank lines,
	 * so switching tabs does not change the picker's height and make it jump.
	 */
	function listLines(width: number): string[] {
		const current = view();
		const anchor = Math.min(selected, Math.max(0, current.rows.length - 1));
		const start = Math.max(
			0,
			Math.min(anchor - Math.floor(MAX_VISIBLE_ROWS / 2), current.rows.length - MAX_VISIBLE_ROWS),
		);
		const lines =
			current.rows.length === 0
				? [theme.fg("dim", "  nothing here")]
				: current.rows
						.slice(start, start + MAX_VISIBLE_ROWS)
						.map((row, index) => renderRow(row, start + index === anchor, width));
		while (lines.length < MAX_VISIBLE_ROWS) lines.push("");
		return lines;
	}

	function renderRow(row: Row, isSelected: boolean, width: number): string {
		const marker = isSelected ? theme.fg("accent", "❯ ") : "  ";
		if (row.type === "package") return packageLine(marker, row.name, width);
		return itemLine(marker, row.item, width);
	}

	function packageLine(marker: string, name: string, width: number): string {
		const catalog = deps.catalog();
		const entry = catalog.packages.find((candidate) => candidate.name === name);
		const state = packageState(catalog, deps.resolved(), name, deps.defaultOn);
		const counts =
			entry === undefined
				? ""
				: entry.kind === "mcp"
					? `${entry.tools.length} tools`
					: `${entry.tools.length} tools · ${entry.skills.length} skills`;
		const description =
			entry?.kind === "mcp" && entry.description !== undefined
				? `  ${theme.fg("dim", singleLine(entry.description))}`
				: "";
		return truncateToWidth(
			`${marker}${stateGlyph(state)} ${theme.bold(name)}  ${theme.fg("muted", counts)}${badges({ kind: "packages", name })}${description}`,
			width,
		);
	}

	function itemLine(marker: string, item: CatalogItem, width: number): string {
		const suffix = item.packageName === undefined ? "" : `  ${theme.fg("muted", item.packageName)}`;
		const text = singleLine(item.description);
		const description = text === "" ? "" : `  ${theme.fg("dim", text)}`;
		const state = itemOn(deps.resolved(), item, deps.defaultOn) ? "on" : "off";
		return truncateToWidth(
			`${marker}${stateGlyph(state)} ${item.name}${suffix}${badges(itemTarget(item))}${description}`,
			width,
		);
	}

	function badgeFor(scope: ScopeInfo, target: ToggleTarget): string | undefined {
		const setting = deps.valueOf(scope.name, target);
		if (setting === "inherit") return undefined;
		return theme.fg(setting === "on" ? "success" : "error", `${SCOPE_INITIALS[scope.name]}:${setting}`);
	}

	function badges(target: ToggleTarget): string {
		const parts = scopes().flatMap((scope) => badgeFor(scope, target) ?? []);
		return parts.length === 0 ? "" : `  ${parts.join(" ")}`;
	}

	function footer(width: number): string {
		const catalog = deps.catalog();
		const resolved = deps.resolved();
		const count = (kind: "tool" | "skill") => {
			const items = catalog.items.filter((item) => item.kind === kind);
			const on = items.filter((item) => itemOn(resolved, item, deps.defaultOn)).length;
			return `${on}/${items.length}`;
		};
		const counts = `${count("tool")} tools · ${count("skill")} skills`;
		return truncateToWidth(
			`${theme.fg("dim", "space cycle · ←→ kind · tab scope · esc close")}  ${theme.fg("muted", counts)}`,
			width,
		);
	}

	function stateGlyph(state: "on" | "off" | "partial"): string {
		if (state === "on") return theme.fg("success", "●");
		if (state === "off") return theme.fg("error", "○");
		return theme.fg("warning", "◐");
	}

	return {
		render(width: number): string[] {
			return [header(width), kindLine(width), filterLine(width), ...listLines(width), footer(width)];
		},
		handleInput,
		invalidate(): void {},
	};
}

/** The catalog item kind a picker tab lists. */
function itemKindOf(kind: Kind): CatalogItem["kind"] {
	if (kind === "skills") return "skill";
	if (kind === "sections") return "section";
	return "tool";
}

export async function runScopePicker(ctx: ExtensionCommandContext, deps: ScopePickerDeps): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		createScopePicker(theme, deps, { requestRender: () => tui.requestRender(), close: () => done(undefined) }),
	);
}

/** Pi tool and skill descriptions can carry line breaks; one rendered row must stay one terminal line. */
function singleLine(text: string): string {
	return text.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ").trim();
}

function matchesItem(item: CatalogItem, query: string): boolean {
	if (query === "") return true;
	return [item.name, item.packageName ?? "", item.description].join("\n").toLowerCase().includes(query);
}

function matchesPackage(entry: PackageEntry, query: string): boolean {
	if (query === "") return true;
	return [entry.name, entry.description ?? ""].join("\n").toLowerCase().includes(query);
}

function isPrintable(data: string): boolean {
	return data.length > 0 && [...data].every(isPrintableCodePoint);

	function isPrintableCodePoint(char: string): boolean {
		const code = char.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
	}
}
