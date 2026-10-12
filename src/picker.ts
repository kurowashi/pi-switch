/**
 * The pi-switch picker: one searchable list of packages, MCP servers, tools,
 * skills, and prompt sections with a live toggle for the active scope.
 *
 * The component is written by hand instead of using `SelectList` or
 * `SettingsList` because rows mix several kinds, carry per-scope state badges,
 * and toggling writes files. Tests drive `createScopePicker` directly; `/switch`
 * wraps it in `ctx.ui.custom`. See README.md#コマンド for the keys.
 */

import type { ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeyId, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { LayerState, ResolvedConfig, ScopeName, ToggleTarget } from "./config.ts";
import {
	type Catalog,
	type CatalogItem,
	itemDisabled,
	itemTarget,
	type PackageEntry,
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

export interface ScopePickerDeps {
	catalog(): Catalog;
	resolved(): ResolvedConfig;
	scopes(): ScopeInfo[];
	layerState(scope: ScopeName, target: ToggleTarget): LayerState;
	/** Persist the change and update the live session. Siblings are applied as one write. */
	toggle(scope: ScopeName, targets: readonly ToggleTarget[], enabled: boolean): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface PickerCallbacks {
	requestRender(): void;
	close(): void;
}

/** Rows shown at once. The terminal height is not available here, so this is fixed. */
const MAX_VISIBLE_ROWS = 14;

type Row = { type: "section"; label: string } | { type: "item"; item: CatalogItem } | { type: "package"; name: string };

interface View {
	rows: Row[];
	selectable: number[];
}

const SCOPE_LABELS: Record<ScopeName, string> = { user: "Global", project: "Project" };
const SCOPE_INITIALS: Record<ScopeName, string> = { user: "g", project: "p" };

function createScopePicker(theme: PickerTheme, deps: ScopePickerDeps, callbacks: PickerCallbacks): Component {
	let scopeIndex = 0;
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

	function rowsFor(label: string, entries: Row[]): Row[] {
		return entries.length === 0 ? [] : [{ type: "section" as const, label }, ...entries];
	}

	function groupRows(catalog: Catalog, kind: PackageEntry["kind"], query: string): Row[] {
		return catalog.packages
			.filter((entry) => entry.kind === kind && matchesPackage(entry, query))
			.map((entry) => ({ type: "package" as const, name: entry.name }));
	}

	function itemRows(catalog: Catalog, kind: CatalogItem["kind"], query: string): Row[] {
		return catalog.items
			.filter((item) => item.kind === kind && matchesItem(item, query))
			.map((item) => ({ type: "item" as const, item }));
	}

	function view(): View {
		const catalog = deps.catalog();
		const query = filter.trim().toLowerCase();
		const rows: Row[] = [
			...rowsFor("Packages", groupRows(catalog, "package", query)),
			...rowsFor("MCP", groupRows(catalog, "mcp", query)),
			...rowsFor("Tools", itemRows(catalog, "tool", query)),
			...rowsFor("Skills", itemRows(catalog, "skill", query)),
			...rowsFor("Sections", itemRows(catalog, "section", query)),
		];
		return { rows, selectable: rows.flatMap((row, index) => (row.type === "section" ? [] : [index])) };
	}

	function selectedRow(): Row | undefined {
		const current = view();
		const rowIndex = current.selectable[selected];
		return rowIndex === undefined ? undefined : current.rows[rowIndex];
	}

	function refresh(): void {
		const count = view().selectable.length;
		selected = count === 0 ? 0 : Math.min(selected, count - 1);
		callbacks.requestRender();
	}

	function move(delta: number): void {
		const count = view().selectable.length;
		if (count === 0) return;
		selected = (selected + delta + count) % count;
		callbacks.requestRender();
	}

	function moveTo(index: number): void {
		const count = view().selectable.length;
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

	function toggleSelected(): void {
		const scope = activeScope();
		if (!scope.available) {
			deps.notify(`pi-switch: ${scope.reason ?? "the project scope is unavailable"}`, "warning");
			return;
		}
		const row = selectedRow();
		if (row === undefined || row.type === "section") return;
		if (row.type === "package") togglePackage(scope.name, row.name);
		else deps.toggle(scope.name, [itemTarget(row.item)], itemDisabled(deps.resolved(), row.item));
		refresh();
	}

	function togglePackage(scope: ScopeName, name: string): void {
		const catalog = deps.catalog();
		const enabled = packageState(catalog, deps.resolved(), name) !== "on";
		// An MCP server can own dozens of tools; its row writes only the group key.
		if (catalog.packages.find((entry) => entry.name === name)?.kind === "mcp") {
			deps.toggle(scope, [{ kind: "packages", name }], enabled);
			return;
		}
		const targets: ToggleTarget[] = [{ kind: "packages", name }];
		for (const item of catalog.items) {
			if (item.packageName === name) targets.push(itemTarget(item));
		}
		deps.toggle(scope, targets, enabled);
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
		{ key: Key.up, run: () => move(-1) },
		{ key: Key.down, run: () => move(1) },
		{ key: Key.pageUp, run: () => movePage(-1) },
		{ key: Key.pageDown, run: () => movePage(1) },
		{ key: Key.home, run: () => moveTo(0) },
		{ key: Key.end, run: () => moveTo(view().selectable.length - 1) },
		{ key: Key.space, run: toggleSelected },
		{ key: Key.enter, run: toggleSelected },
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

	function filterLine(width: number): string {
		const prompt = theme.fg("muted", "filter: ");
		if (filter === "") return truncateToWidth(`${prompt}${theme.fg("dim", "type to search")}`, width);
		return truncateToWidth(`${prompt}${filter}`, width);
	}

	function listLines(width: number): string[] {
		const current = view();
		const anchor = current.selectable[selected] ?? 0;
		const start = Math.max(
			0,
			Math.min(anchor - Math.floor(MAX_VISIBLE_ROWS / 2), current.rows.length - MAX_VISIBLE_ROWS),
		);
		return current.rows
			.slice(start, start + MAX_VISIBLE_ROWS)
			.map((row, index) => renderRow(row, start + index === anchor, width));
	}

	function renderRow(row: Row, isSelected: boolean, width: number): string {
		const marker = isSelected ? theme.fg("accent", "❯ ") : "  ";
		if (row.type === "section") return truncateToWidth(`${marker}${theme.bold(theme.fg("muted", row.label))}`, width);
		if (row.type === "package") return packageLine(marker, row.name, width);
		return itemLine(marker, row.item, width);
	}

	function packageLine(marker: string, name: string, width: number): string {
		const catalog = deps.catalog();
		const entry = catalog.packages.find((candidate) => candidate.name === name);
		const state = packageState(catalog, deps.resolved(), name);
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
		const state = itemDisabled(deps.resolved(), item) ? "off" : "on";
		return truncateToWidth(
			`${marker}${stateGlyph(state)} ${item.name}${suffix}${badges(itemTarget(item))}${description}`,
			width,
		);
	}

	function badgeFor(scope: ScopeInfo, target: ToggleTarget): string | undefined {
		const state = deps.layerState(scope.name, target);
		if (state === "unset") return undefined;
		const on = state === "enabled";
		return theme.fg(on ? "success" : "error", `${SCOPE_INITIALS[scope.name]}:${on ? "on" : "off"}`);
	}

	function badges(target: ToggleTarget): string {
		const parts = scopes().flatMap((scope) => badgeFor(scope, target) ?? []);
		return parts.length === 0 ? "" : `  ${parts.join(" ")}`;
	}

	function footer(width: number): string {
		const catalog = deps.catalog();
		const resolved = deps.resolved();
		const enabled = (kind: "tool" | "skill") =>
			catalog.items.filter((item) => item.kind === kind && !itemDisabled(resolved, item)).length;
		const counts = `${enabled("tool")}/${catalog.items.filter((item) => item.kind === "tool").length} tools · ${enabled("skill")}/${catalog.items.filter((item) => item.kind === "skill").length} skills`;
		return truncateToWidth(
			`${theme.fg("dim", "space toggle · tab scope · esc close")}  ${theme.fg("muted", counts)}`,
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
			return [header(width), filterLine(width), ...listLines(width), footer(width)];
		},
		handleInput,
		invalidate(): void {},
	};
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
