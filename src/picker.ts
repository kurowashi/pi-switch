/**
 * The pi-switch picker: one searchable list of packages, tools, and skills with
 * a live toggle for the active scope.
 *
 * The component is written by hand instead of using `SelectList` or
 * `SettingsList` because rows mix three kinds, carry per-scope state badges,
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

	function view(): View {
		const catalog = deps.catalog();
		const query = filter.trim().toLowerCase();
		const rows: Row[] = [];
		appendSection(
			rows,
			"Packages",
			catalog.packages
				.filter((entry) => matchesPackage(entry, query))
				.map((entry) => ({ type: "package" as const, name: entry.name })),
		);
		appendSection(
			rows,
			"Tools",
			catalog.items
				.filter((item) => item.kind === "tool" && matchesItem(item, query))
				.map((item) => ({ type: "item" as const, item })),
		);
		appendSection(
			rows,
			"Skills",
			catalog.items
				.filter((item) => item.kind === "skill" && matchesItem(item, query))
				.map((item) => ({ type: "item" as const, item })),
		);
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
		if (row.type === "package") togglePackage(scope.name, row.name, deps.catalog());
		else deps.toggle(scope.name, [itemTarget(row.item)], itemDisabled(deps.resolved(), row.item));
		refresh();
	}

	function togglePackage(scope: ScopeName, name: string, catalog: Catalog): void {
		const enabled = packageState(catalog, deps.resolved(), name) !== "on";
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
		const counts = entry === undefined ? "" : `${entry.tools.length} tools · ${entry.skills.length} skills`;
		return truncateToWidth(
			`${marker}${stateGlyph(state)} ${theme.bold(name)}  ${theme.fg("muted", counts)}${badges({ kind: "packages", name })}`,
			width,
		);
	}

	function itemLine(marker: string, item: CatalogItem, width: number): string {
		const suffix = item.packageName === undefined ? "" : `  ${theme.fg("muted", item.packageName)}`;
		const description = item.description === "" ? "" : `  ${theme.fg("dim", item.description)}`;
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

function matchesItem(item: CatalogItem, query: string): boolean {
	if (query === "") return true;
	return [item.name, item.packageName ?? "", item.description].join("\n").toLowerCase().includes(query);
}

function appendSection(rows: Row[], label: string, entries: Row[]): void {
	if (entries.length === 0) return;
	rows.push({ type: "section", label }, ...entries);
}

function matchesPackage(entry: PackageEntry, query: string): boolean {
	return query === "" || entry.name.toLowerCase().includes(query);
}

function isPrintable(data: string): boolean {
	return data.length > 0 && [...data].every(isPrintableCodePoint);

	function isPrintableCodePoint(char: string): boolean {
		const code = char.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
	}
}
