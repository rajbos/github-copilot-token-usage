/**
 * The one table component every webview uses: markup, CSS classes (`dataTable.css`), sorting,
 * pagination, row filters, focus restoration and screen-reader announcements live here, so a
 * table looks and behaves the same in every panel.
 *
 * Usage: build the markup with `renderDataTable(options)` and insert it like any other HTML.
 * Sort headers, pager buttons and filter checkboxes (`renderDataTableFilter`) are handled by
 * one delegated listener per document, installed on first render; an interaction re-renders
 * only that table, from the options it was last rendered with. Callers wire nothing for the
 * table itself — use `onRender` to re-attach listeners to custom cell content, and
 * `onStateChange` to persist the sort/page/filter state.
 *
 * Every view's `main.ts` must inject `dataTable.css` alongside `theme.css`.
 */
import { setHtml } from './domUtils';
import { escapeHtml } from './formatUtils';
import { localize, localizeFormat } from './localization';

export const DEFAULT_DATA_TABLE_PAGE_SIZE = 10;

export type DataTableSortDirection = 'asc' | 'desc';
export type DataTableSortValue = string | number | null | undefined;
/** Plain text (escaped by the table) or trusted markup the caller has already escaped. */
export type DataTableCell = string | { html: string };
export type DataTableAlign = 'left' | 'center' | 'right';

export interface DataTableColumn<Row> {
	id: string;
	/** Header text; also the sort button's accessible name unless `headerTitle` is set. */
	label: string;
	/** Trusted header markup (icons, sub-labels) shown instead of `label`. */
	headerHtml?: string;
	/** Tooltip and accessible name for the header, e.g. when `label` is an icon. */
	headerTitle?: string;
	align?: DataTableAlign;
	/** CSS width for the column's `<col>`, e.g. `'40%'` or `'96px'`. */
	width?: string;
	/** Extra class names for the column's header and body cells. */
	className?: string;
	/** Not rendered, but still usable as a sort key (e.g. a composite default order). */
	hidden?: boolean;
	/** Defaults to true when `sortValue` is provided. */
	sortable?: boolean;
	sortValue?: (row: Row) => DataTableSortValue;
	/** Direction of the first click; defaults to `desc` for right-aligned (numeric) columns, else `asc`. */
	firstSortDirection?: DataTableSortDirection;
	/** Render body cells as `<th scope="row">`. */
	rowHeader?: boolean;
	/** `index` is the row's 0-based position in the sorted, filtered list (not just the page). */
	render: (row: Row, index: number) => DataTableCell;
	cellClassName?: (row: Row) => string | undefined;
	/** Tooltip for a body cell. */
	cellTitle?: (row: Row) => string | undefined;
}

export interface DataTableRowOptions {
	className?: string;
	/** Extra attributes for the `<tr>`; values are escaped. */
	attributes?: Record<string, string>;
}

export interface DataTableGroupBy<Row> {
	/** Rows sharing a key stay together; groups keep the order they first appear in `rows`. */
	key: (row: Row) => string;
	label: (key: string, rows: readonly Row[]) => DataTableCell;
}

export interface DataTableFooterRow {
	className?: string;
	/** Cells by column id; missing ids render empty cells. */
	cells: Partial<Record<string, DataTableCell>>;
}

export interface DataTableSort {
	columnId: string;
	direction: DataTableSortDirection;
}

export interface DataTableState {
	/** `null` keeps the rows in the order they were passed. */
	sortColumn: string | null;
	sortDirection: DataTableSortDirection;
	page: number;
	filters: Record<string, boolean>;
}

export interface DataTableOptions<Row> {
	/** Unique per document; keys the persisted state and the root element id. */
	tableId: string;
	ariaLabel: string;
	rows: readonly Row[];
	columns: readonly DataTableColumn<Row>[];
	initialSort?: DataTableSort;
	/** Rows per page; `false` shows every row. Defaults to `DEFAULT_DATA_TABLE_PAGE_SIZE`. */
	pageSize?: number | false;
	emptyMessage?: string;
	/** Extra classes for the `<table>`, e.g. the `data-table--fixed` / `--compact` variants. */
	className?: string;
	/** Extra classes for the root wrapper. */
	rootClassName?: string;
	/** Set false for key/value tables that have no header row. */
	showHeader?: boolean;
	rowOptions?: (row: Row, index: number) => DataTableRowOptions | undefined;
	/** Trusted markup appended after the row (e.g. an expandable details row); moves with the row. */
	afterRow?: (row: Row, index: number) => string;
	groupBy?: DataTableGroupBy<Row>;
	footerRows?: readonly DataTableFooterRow[];
	defaultFilters?: Record<string, boolean>;
	filterRows?: (row: Row, filters: Readonly<Record<string, boolean>>) => boolean;
	/** Called after a sort, page or filter interaction changed the state. */
	onStateChange?: (state: Readonly<DataTableState>) => void;
	/** Called after the table re-rendered itself in place (not after the initial render). */
	onRender?: (root: HTMLElement) => void;
}

export interface DataTablePage<Row> {
	rows: Row[];
	filteredCount: number;
	page: number;
	pageCount: number;
	firstRow: number;
	lastRow: number;
	/** 0-based position of `rows[0]` in the sorted, filtered list. */
	offset: number;
}

export interface DataTablePageOptions<Row> {
	filterRows?: DataTableOptions<Row>['filterRows'];
	pageSize?: number | false;
	groupBy?: DataTableGroupBy<Row>;
}

export type DataTableFocusTarget =
	| { kind: 'sort'; columnId: string }
	| { kind: 'page'; direction: 'previous' | 'next' }
	| { kind: 'filter'; filterId: string };

type InteractionReason = 'sort' | 'page' | 'filter';

interface RegisteredTable {
	renderContent: () => string;
	firstSortDirection: (columnId: string) => DataTableSortDirection;
	findPage: (predicate: (row: unknown) => boolean) => number | undefined;
	onStateChange?: (state: Readonly<DataTableState>) => void;
	onRender?: (root: HTMLElement) => void;
}

const tableStates = new Map<string, DataTableState>();
const pendingStatePatches = new Map<string, Partial<DataTableState>>();
const registeredTables = new Map<string, RegisteredTable>();
const boundDocuments = new WeakSet<Document>();

export function dataTableRootId(tableId: string): string {
	return `data-table-root-${tableId}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Returns the table's state, creating it from the defaults the first time. */
export function getDataTableState(
	tableId: string,
	defaults: { sort?: DataTableSort; filters?: Record<string, boolean> } = {},
): DataTableState {
	let state = tableStates.get(tableId);
	if (!state) {
		const pending = pendingStatePatches.get(tableId);
		pendingStatePatches.delete(tableId);
		state = {
			sortColumn: defaults.sort?.columnId ?? null,
			sortDirection: defaults.sort?.direction ?? 'asc',
			page: 1,
			...pending,
			filters: { ...defaults.filters, ...pending?.filters },
		};
		tableStates.set(tableId, state);
	}
	return state;
}

/**
 * Overwrites part of the state, e.g. to restore a persisted sort. Before the first render the
 * patch is held and applied on top of the table's `initialSort` / `defaultFilters`.
 */
export function setDataTableState(tableId: string, patch: Partial<DataTableState>): void {
	const state = tableStates.get(tableId);
	if (!state) {
		const pending = pendingStatePatches.get(tableId);
		pendingStatePatches.set(tableId, { ...pending, ...patch, filters: { ...pending?.filters, ...patch.filters } });
		return;
	}
	tableStates.set(tableId, { ...state, ...patch, filters: { ...state.filters, ...patch.filters } });
}

export function resetDataTableState(tableId: string): void {
	tableStates.delete(tableId);
	pendingStatePatches.delete(tableId);
}

/** Toggles the direction on the active column; a new column starts at its first-click direction. */
export function setDataTableSort(tableId: string, columnId: string, firstDirection?: DataTableSortDirection): void {
	const state = getDataTableState(tableId);
	const initial = firstDirection ?? registeredTables.get(tableId)?.firstSortDirection(columnId) ?? 'asc';
	const sortDirection = state.sortColumn === columnId
		? (state.sortDirection === 'asc' ? 'desc' : 'asc')
		: initial;
	tableStates.set(tableId, { ...state, sortColumn: columnId, sortDirection, page: 1 });
}

export function setDataTablePage(tableId: string, page: number): void {
	const state = getDataTableState(tableId);
	tableStates.set(tableId, { ...state, page: Math.max(1, Math.floor(page)) });
}

export function setDataTableFilter(tableId: string, filterId: string, value: boolean): void {
	const state = getDataTableState(tableId);
	tableStates.set(tableId, { ...state, filters: { ...state.filters, [filterId]: value }, page: 1 });
}

// ---------------------------------------------------------------------------
// Filtering, sorting and paging (pure)
// ---------------------------------------------------------------------------

function isMissing(value: DataTableSortValue): value is null | undefined {
	return value === null || value === undefined;
}

function compareSortValues(a: DataTableSortValue, b: DataTableSortValue): number {
	if (isMissing(a)) { return isMissing(b) ? 0 : 1; }
	if (isMissing(b)) { return -1; }
	if (typeof a === 'number' && typeof b === 'number') { return a - b; }
	return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

function groupOrder<Row>(rows: readonly Row[], groupBy: DataTableGroupBy<Row> | undefined): Map<string, number> {
	const order = new Map<string, number>();
	if (groupBy) {
		for (const row of rows) {
			const key = groupBy.key(row);
			if (!order.has(key)) { order.set(key, order.size); }
		}
	}
	return order;
}

function sortRows<Row>(
	rows: readonly Row[],
	column: DataTableColumn<Row> | undefined,
	direction: DataTableSortDirection,
	groupBy: DataTableGroupBy<Row> | undefined,
): Row[] {
	const sortValue = column?.sortValue;
	if (!sortValue && !groupBy) { return rows.slice(); }
	const groups = groupOrder(rows, groupBy);
	return rows
		.map((row, index) => ({ row, index, group: groupBy ? groups.get(groupBy.key(row)) ?? 0 : 0, value: sortValue?.(row) }))
		.sort((a, b) => {
			if (a.group !== b.group) { return a.group - b.group; }
			const result = sortValue ? compareSortValues(a.value, b.value) : 0;
			if (result === 0) { return a.index - b.index; }
			// Missing values sort last in both directions.
			if (isMissing(a.value) || isMissing(b.value)) { return result; }
			return direction === 'asc' ? result : -result;
		})
		.map(item => item.row);
}

/** Applies filtering, a stable sort, and page slicing in that order. */
export function getDataTablePage<Row>(
	rows: readonly Row[],
	columns: readonly DataTableColumn<Row>[],
	state: DataTableState,
	options: DataTablePageOptions<Row> = {},
): DataTablePage<Row> {
	const filterRows = options.filterRows;
	const filtered = filterRows ? rows.filter(row => filterRows(row, state.filters)) : rows;
	const column = columns.find(candidate => candidate.id === state.sortColumn);
	const sorted = sortRows(filtered, column, state.sortDirection, options.groupBy);
	const pageSize = options.pageSize === false
		? Math.max(1, sorted.length)
		: Math.max(1, options.pageSize ?? DEFAULT_DATA_TABLE_PAGE_SIZE);
	const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
	const page = Math.min(Math.max(1, state.page), pageCount);
	const offset = (page - 1) * pageSize;
	return {
		rows: sorted.slice(offset, offset + pageSize),
		filteredCount: sorted.length,
		page,
		pageCount,
		firstRow: sorted.length === 0 ? 0 : offset + 1,
		lastRow: Math.min(offset + pageSize, sorted.length),
		offset,
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cellHtml(value: DataTableCell | null | undefined): string {
	if (value === null || value === undefined) { return ''; }
	return typeof value === 'string' ? escapeHtml(value) : value.html;
}

function classAttr(...names: Array<string | undefined | false>): string {
	const value = names.filter(Boolean).join(' ');
	return value ? ` class="${escapeHtml(value)}"` : '';
}

function alignClass(align: DataTableAlign | undefined): string | undefined {
	return align && align !== 'left' ? `data-table-align-${align}` : undefined;
}

function isSortable<Row>(column: DataTableColumn<Row>): boolean {
	return column.sortable ?? Boolean(column.sortValue);
}

function firstSortDirectionOf<Row>(column: DataTableColumn<Row> | undefined): DataTableSortDirection {
	if (column?.firstSortDirection) { return column.firstSortDirection; }
	return column?.align === 'right' ? 'desc' : 'asc';
}

function renderHeaderCell<Row>(column: DataTableColumn<Row>, state: DataTableState, tableId: string): string {
	const content = column.headerHtml ?? escapeHtml(column.label);
	const name = column.headerTitle ?? column.label;
	if (!isSortable(column)) {
		const titleAttrs = column.headerTitle
			? ` title="${escapeHtml(column.headerTitle)}" aria-label="${escapeHtml(column.headerTitle)}"`
			: '';
		return `<th scope="col"${classAttr(alignClass(column.align), column.className)}${titleAttrs}>${content}</th>`;
	}
	const direction = state.sortColumn === column.id ? state.sortDirection : undefined;
	const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
	const indicator = direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '';
	const title = direction
		? localize(direction === 'asc' ? 'dataTable.sortedAscending' : 'dataTable.sortedDescending')
		: localizeFormat('dataTable.sortBy', name);
	return `<th scope="col"${classAttr('data-table-sortable', direction && 'data-table-sorted', alignClass(column.align), column.className)} aria-sort="${ariaSort}">`
		+ `<button type="button" class="data-table-sort" data-table-id="${escapeHtml(tableId)}" data-table-sort="${escapeHtml(column.id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(name)}">`
		+ `<span class="data-table-sort-label">${content}</span>`
		+ `<span class="data-table-sort-indicator" aria-hidden="true">${indicator}</span>`
		+ '</button></th>';
}

function renderColGroup<Row>(columns: readonly DataTableColumn<Row>[]): string {
	if (!columns.some(column => column.width)) { return ''; }
	return `<colgroup>${columns.map(column => column.width ? `<col style="width:${escapeHtml(column.width)}">` : '<col>').join('')}</colgroup>`;
}

function renderBodyCell<Row>(column: DataTableColumn<Row>, row: Row, index: number): string {
	const tag = column.rowHeader ? 'th' : 'td';
	const scope = column.rowHeader ? ' scope="row"' : '';
	const title = column.cellTitle?.(row);
	const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
	return `<${tag}${scope}${classAttr(alignClass(column.align), column.className, column.cellClassName?.(row))}${titleAttr}>${cellHtml(column.render(row, index))}</${tag}>`;
}

function rowAttributes(options: DataTableRowOptions | undefined): string {
	if (!options) { return ''; }
	const attributes = Object.entries(options.attributes ?? {})
		.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
		.join('');
	return `${classAttr(options.className)}${attributes}`;
}

function renderGroupRow<Row>(options: DataTableOptions<Row>, key: string, columnCount: number): string {
	const groupBy = options.groupBy;
	if (!groupBy) { return ''; }
	const members = options.rows.filter(row => groupBy.key(row) === key);
	return `<tr class="data-table-group-row"><th scope="rowgroup" colspan="${columnCount}">${cellHtml(groupBy.label(key, members))}</th></tr>`;
}

function renderBody<Row>(options: DataTableOptions<Row>, page: DataTablePage<Row>, columns: readonly DataTableColumn<Row>[]): string {
	if (page.rows.length === 0) {
		const message = options.emptyMessage ?? localize('dataTable.noRows');
		return `<tr class="data-table-empty-row"><td class="data-table-empty" colspan="${columns.length}">${escapeHtml(message)}</td></tr>`;
	}
	let previousGroup: string | undefined;
	return page.rows.map((row, pageIndex) => {
		const index = page.offset + pageIndex;
		let html = '';
		if (options.groupBy) {
			const group = options.groupBy.key(row);
			if (group !== previousGroup) { html += renderGroupRow(options, group, columns.length); }
			previousGroup = group;
		}
		html += `<tr${rowAttributes(options.rowOptions?.(row, index))}>${columns.map(column => renderBodyCell(column, row, index)).join('')}</tr>`;
		return html + (options.afterRow?.(row, index) ?? '');
	}).join('');
}

function renderFooter<Row>(footerRows: readonly DataTableFooterRow[] | undefined, columns: readonly DataTableColumn<Row>[]): string {
	if (!footerRows || footerRows.length === 0) { return ''; }
	const rows = footerRows.map(footer => {
		const cells = columns.map(column => {
			const value = footer.cells[column.id];
			return `<td${classAttr(alignClass(column.align), column.className)}>${value === undefined ? '' : cellHtml(value)}</td>`;
		}).join('');
		return `<tr${classAttr('data-table-footer-row', footer.className)}>${cells}</tr>`;
	}).join('');
	return `<tfoot>${rows}</tfoot>`;
}

function pagerButton(tableId: string, direction: 'previous' | 'next', page: number, disabled: boolean): string {
	const label = localize(direction === 'previous' ? 'dataTable.previous' : 'dataTable.next');
	return `<button type="button" class="data-table-page-button" data-table-id="${escapeHtml(tableId)}" data-table-direction="${direction}" data-table-page="${page}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

function renderPager<Row>(options: DataTableOptions<Row>, page: DataTablePage<Row>): string {
	if (options.pageSize === false || page.filteredCount === 0) { return ''; }
	if (page.pageCount <= 1) {
		return `<div class="data-table-summary">${escapeHtml(localizeFormat('dataTable.showing', page.firstRow, page.lastRow, page.filteredCount))}</div>`;
	}
	return `<nav class="data-table-pager" aria-label="${escapeHtml(options.ariaLabel)}">`
		+ pagerButton(options.tableId, 'previous', page.page - 1, page.page <= 1)
		+ `<span class="data-table-page-info">${escapeHtml(localizeFormat('dataTable.page', page.page, page.pageCount, page.firstRow, page.lastRow, page.filteredCount))}</span>`
		+ pagerButton(options.tableId, 'next', page.page + 1, page.page >= page.pageCount)
		+ '</nav>';
}

/** Renders the replaceable part of the table (everything inside the root but the live region). */
function renderDataTableContent<Row>(options: DataTableOptions<Row>): string {
	const state = getDataTableState(options.tableId, { sort: options.initialSort, filters: options.defaultFilters });
	const page = getDataTablePage(options.rows, options.columns, state, options);
	if (page.page !== state.page) {
		tableStates.set(options.tableId, { ...state, page: page.page });
	}
	const columns = options.columns.filter(column => !column.hidden);
	const head = options.showHeader === false
		? ''
		: `<thead><tr>${columns.map(column => renderHeaderCell(column, state, options.tableId)).join('')}</tr></thead>`;
	// A labelled, focusable region so keyboard users can scroll a table wider than the panel.
	return `<div class="data-table-scroll" role="region" tabindex="0" aria-label="${escapeHtml(options.ariaLabel)}">`
		+ `<table${classAttr('data-table', options.className)} aria-label="${escapeHtml(options.ariaLabel)}">`
		+ renderColGroup(columns)
		+ head
		+ `<tbody>${renderBody(options, page, columns)}</tbody>`
		+ renderFooter(options.footerRows, columns)
		+ '</table></div>'
		+ renderPager(options, page);
}

/** 1-based page that holds the first row matching `predicate` under the current sort and filters. */
function findRowPage<Row>(options: DataTableOptions<Row>, predicate: (row: Row) => boolean): number | undefined {
	const state = getDataTableState(options.tableId, { sort: options.initialSort, filters: options.defaultFilters });
	const ordered = getDataTablePage(options.rows, options.columns, { ...state, page: 1 }, { ...options, pageSize: false }).rows;
	const index = ordered.findIndex(row => predicate(row));
	if (index < 0) { return undefined; }
	return options.pageSize === false ? 1 : Math.floor(index / Math.max(1, options.pageSize ?? DEFAULT_DATA_TABLE_PAGE_SIZE)) + 1;
}

/**
 * Renders a complete table. Re-rendering with the same `tableId` keeps the user's sort, page and
 * filters; pass new `rows` to refresh the data.
 */
export function renderDataTable<Row>(options: DataTableOptions<Row>): string {
	registeredTables.set(options.tableId, {
		renderContent: () => renderDataTableContent(options),
		firstSortDirection: columnId => firstSortDirectionOf(options.columns.find(column => column.id === columnId)),
		findPage: predicate => findRowPage(options, predicate),
		onStateChange: options.onStateChange,
		onRender: options.onRender,
	});
	if (typeof document !== 'undefined') { bindDataTables(document); }
	return `<div${classAttr('data-table-root', options.rootClassName)} id="${escapeHtml(dataTableRootId(options.tableId))}" data-table-root="${escapeHtml(options.tableId)}">`
		+ `<div class="data-table-content">${renderDataTableContent(options)}</div>`
		+ '<span class="data-table-status" role="status" aria-live="polite" aria-atomic="true"></span>'
		+ '</div>';
}

/** A filter checkbox bound to `filterRows`; it may sit anywhere in the document, not just inside the table. */
export function renderDataTableFilter(options: { tableId: string; filterId: string; label: string; checked: boolean; id?: string }): string {
	const id = options.id ? ` id="${escapeHtml(options.id)}"` : '';
	return `<label class="data-table-filter"><input type="checkbox"${id} data-table-id="${escapeHtml(options.tableId)}" data-table-filter="${escapeHtml(options.filterId)}"${options.checked ? ' checked' : ''}>`
		+ `<span>${escapeHtml(options.label)}</span></label>`;
}

// ---------------------------------------------------------------------------
// Focus and announcements
// ---------------------------------------------------------------------------

/**
 * Whether `element` belongs to the table rooted at `root` rather than to a table nested inside it
 * (e.g. a details table rendered through `afterRow`). When `root` is not itself a table root,
 * every descendant counts.
 */
function ownedBy(root: HTMLElement, element: Element): boolean {
	return !root.matches('.data-table-root') || element.closest('.data-table-root') === root;
}

/** Descendants of `root` matching `selector` that belong to this table, not a nested one. */
function ownQueryAll<E extends Element>(root: HTMLElement, selector: string): E[] {
	return Array.from(root.querySelectorAll<E>(selector)).filter(element => ownedBy(root, element));
}

export function getDataTableFocusTarget(root: HTMLElement, activeElement: Element | null): DataTableFocusTarget | undefined {
	if (!activeElement || !root.contains(activeElement) || !ownedBy(root, activeElement)) { return undefined; }
	const columnId = activeElement.closest('[data-table-sort]')?.getAttribute('data-table-sort');
	if (columnId) { return { kind: 'sort', columnId }; }
	const direction = activeElement.closest('[data-table-direction]')?.getAttribute('data-table-direction');
	if (direction === 'previous' || direction === 'next') { return { kind: 'page', direction }; }
	const filterId = activeElement.closest('[data-table-filter]')?.getAttribute('data-table-filter');
	if (filterId) { return { kind: 'filter', filterId }; }
	return undefined;
}

function findFocusControl(root: HTMLElement, target: DataTableFocusTarget): HTMLElement | undefined {
	if (target.kind === 'sort') {
		return ownQueryAll<HTMLElement>(root, '[data-table-sort]')
			.find(button => button.getAttribute('data-table-sort') === target.columnId);
	}
	if (target.kind === 'page') {
		const buttons = ownQueryAll<HTMLButtonElement>(root, '[data-table-direction]');
		// The button just used may now be disabled (first/last page); fall back to the other one.
		return buttons.find(button => button.getAttribute('data-table-direction') === target.direction && !button.disabled)
			?? buttons.find(button => !button.disabled);
	}
	return ownQueryAll<HTMLElement>(root, '[data-table-filter]')
		.find(input => input.getAttribute('data-table-filter') === target.filterId);
}

export function restoreDataTableFocus(root: HTMLElement, target: DataTableFocusTarget | undefined): boolean {
	if (!target) { return false; }
	const control = findFocusControl(root, target);
	if (!control) { return false; }
	control.focus();
	return true;
}

export function getDataTableAnnouncement(root: HTMLElement, sorted: boolean): string {
	if (sorted) {
		const button = ownQueryAll<HTMLElement>(root, 'th[aria-sort="ascending"] .data-table-sort, th[aria-sort="descending"] .data-table-sort')[0];
		if (button) {
			return localizeFormat('dataTable.announcement.sort', button.getAttribute('aria-label') ?? '', button.title);
		}
	}
	const status = ownQueryAll<HTMLElement>(root, '.data-table-page-info, .data-table-summary, .data-table-empty')[0];
	return status?.textContent?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

/** Re-renders a table in place from its last options, keeping focus on the control that was used. */
export function rerenderDataTable(tableId: string, doc: Document = document, reason?: InteractionReason): boolean {
	const table = registeredTables.get(tableId);
	const root = doc.getElementById(dataTableRootId(tableId));
	const content = root?.querySelector<HTMLElement>(':scope > .data-table-content');
	if (!table || !root || !content) { return false; }
	const focusTarget = getDataTableFocusTarget(root, doc.activeElement);
	setHtml(content, table.renderContent());
	restoreDataTableFocus(root, focusTarget);
	if (reason) {
		const status = root.querySelector<HTMLElement>(':scope > .data-table-status');
		if (status) { status.textContent = getDataTableAnnouncement(root, reason === 'sort'); }
		table.onStateChange?.(getDataTableState(tableId));
	}
	table.onRender?.(root);
	return true;
}

/**
 * Moves a rendered table to the page holding the first row matching `predicate` (e.g. to scroll a
 * row into view) and re-renders it when the page changes. Returns false when no row matches.
 */
export function revealDataTableRow<Row>(tableId: string, predicate: (row: Row) => boolean, doc: Document = document): boolean {
	const page = registeredTables.get(tableId)?.findPage(row => predicate(row as Row));
	if (page === undefined) { return false; }
	if (page !== getDataTableState(tableId).page) {
		setDataTablePage(tableId, page);
		rerenderDataTable(tableId, doc);
	}
	return true;
}

function asElement(target: EventTarget | null): Element | null {
	return target && typeof (target as Element).closest === 'function' ? target as Element : null;
}

/** Applies a click on a sort header or pager button; returns the table it changed. */
export function applyDataTableClick(target: EventTarget | null): { tableId: string; reason: InteractionReason } | undefined {
	const element = asElement(target);
	const sortButton = element?.closest('[data-table-sort]');
	const sortTable = sortButton?.getAttribute('data-table-id');
	const columnId = sortButton?.getAttribute('data-table-sort');
	if (sortTable && columnId) {
		setDataTableSort(sortTable, columnId);
		return { tableId: sortTable, reason: 'sort' };
	}
	const pageButton = element?.closest('[data-table-page]');
	const pageTable = pageButton?.getAttribute('data-table-id');
	const page = Number(pageButton?.getAttribute('data-table-page'));
	if (pageButton && pageTable && !pageButton.hasAttribute('disabled') && Number.isFinite(page)) {
		setDataTablePage(pageTable, page);
		return { tableId: pageTable, reason: 'page' };
	}
	return undefined;
}

/** Applies a filter checkbox change; returns the table it changed. */
export function applyDataTableFilterChange(target: EventTarget | null): { tableId: string; reason: InteractionReason } | undefined {
	const input = asElement(target);
	if (!input?.matches('input[data-table-filter]')) { return undefined; }
	const tableId = input.getAttribute('data-table-id');
	const filterId = input.getAttribute('data-table-filter');
	if (!tableId || !filterId) { return undefined; }
	setDataTableFilter(tableId, filterId, (input as HTMLInputElement).checked);
	return { tableId, reason: 'filter' };
}

/**
 * Installs the delegated listeners that drive every data table in `doc`. Idempotent, and called
 * automatically by `renderDataTable`, so views only need it for documents other than the global one.
 */
export function bindDataTables(doc: Document): void {
	if (boundDocuments.has(doc)) { return; }
	boundDocuments.add(doc);
	doc.addEventListener('click', event => {
		const change = applyDataTableClick(event.target);
		if (change) { rerenderDataTable(change.tableId, doc, change.reason); }
	});
	// `change`, not `click`, so a filter fires once however it was toggled (box, label, keyboard).
	doc.addEventListener('change', event => {
		const change = applyDataTableFilterChange(event.target);
		if (change) { rerenderDataTable(change.tableId, doc, change.reason); }
	});
}
