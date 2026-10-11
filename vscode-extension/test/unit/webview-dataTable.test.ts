import test, { beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { escapeHtml } from '../../src/webview/shared/formatUtils';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import {
	DEFAULT_DATA_TABLE_PAGE_SIZE,
	bindDataTables,
	getDataTableAnnouncement,
	getDataTablePage,
	getDataTableState,
	renderDataTable,
	renderDataTableFilter,
	resetDataTableState,
	revealDataTableRow,
	setDataTableFilter,
	setDataTablePage,
	setDataTableSort,
	setDataTableState,
	type DataTableColumn,
	type DataTableOptions,
	type DataTableState,
} from '../../src/webview/shared/dataTable';

type Row = { id: string; name: string; count: number; included: boolean; group?: string };

const columns: DataTableColumn<Row>[] = [
	{ id: 'name', label: 'Name', sortValue: row => row.name, render: row => row.name },
	{ id: 'count', label: 'Count', align: 'right', sortValue: row => row.count, render: row => String(row.count) },
];

function rows(count: number): Row[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `row-${index}`,
		name: `Row ${String(count - index).padStart(2, '0')}`,
		count: count - index,
		included: index % 2 === 0,
	}));
}

function state(overrides: Partial<DataTableState> = {}): DataTableState {
	return { sortColumn: 'name', sortDirection: 'asc', page: 1, filters: {}, ...overrides };
}

function options(tableId: string, overrides: Partial<DataTableOptions<Row>> = {}): DataTableOptions<Row> {
	return { tableId, ariaLabel: 'test rows', rows: rows(25), columns, initialSort: { columnId: 'count', direction: 'desc' }, ...overrides };
}

/** Renders a table into a fresh JSDOM document with the delegated listeners bound. */
function mount(tableOptions: DataTableOptions<Row>): { dom: JSDOM; doc: Document; root: () => HTMLElement } {
	const dom = new JSDOM(`<body><div id="host">${renderDataTable(tableOptions)}</div></body>`, { pretendToBeVisual: true });
	const doc = dom.window.document;
	bindDataTables(doc);
	return {
		dom,
		doc,
		root: () => {
			const root = doc.getElementById(`data-table-root-${tableOptions.tableId}`);
			assert.ok(root);
			return root;
		},
	};
}

function click(dom: JSDOM, element: Element | null): void {
	assert.ok(element);
	(element as HTMLElement).focus();
	element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

beforeEach(() => initializeWebviewLocalization({}));

test('dataTable: sorts strings case-insensitively and numbers in both directions with stable ties', () => {
	const values: Row[] = [
		{ id: 'first-a', name: 'alpha', count: 2, included: true },
		{ id: 'first-b', name: 'ALPHA', count: 2, included: true },
		{ id: 'last', name: 'bravo', count: 1, included: true },
	];
	assert.deepEqual(getDataTablePage(values, columns, state()).rows.map(row => row.id), ['first-a', 'first-b', 'last']);
	assert.deepEqual(getDataTablePage(values, columns, state({ sortDirection: 'desc' })).rows.map(row => row.id), ['last', 'first-a', 'first-b']);
	assert.deepEqual(getDataTablePage(values, columns, state({ sortColumn: 'count' })).rows.map(row => row.count), [1, 2, 2]);
	assert.deepEqual(getDataTablePage(values, columns, state({ sortColumn: 'count', sortDirection: 'desc' })).rows.map(row => row.id), ['first-a', 'first-b', 'last']);
});

test('dataTable: missing sort values stay last in either direction; no sort keeps input order', () => {
	const values = [{ name: 'connected', count: 2 }, { name: 'missing', count: null }, { name: 'small', count: 1 }];
	const numeric: DataTableColumn<typeof values[number]>[] = [{ id: 'count', label: 'Count', sortValue: row => row.count, render: row => row.name }];
	for (const sortDirection of ['asc', 'desc'] as const) {
		assert.equal(getDataTablePage(values, numeric, state({ sortColumn: 'count', sortDirection })).rows.at(-1)?.name, 'missing');
	}
	assert.deepEqual(getDataTablePage(values, numeric, state({ sortColumn: null })).rows.map(row => row.name), ['connected', 'missing', 'small']);
});

test('dataTable: slices empty, one-row, full, and multi-page tables at ten rows', () => {
	assert.equal(DEFAULT_DATA_TABLE_PAGE_SIZE, 10);
	for (const [length, expectedPages] of [[0, 1], [1, 1], [10, 1], [11, 2], [25, 3]] as const) {
		const page = getDataTablePage(rows(length), columns, state({ sortColumn: 'count', sortDirection: 'desc' }));
		assert.equal(page.rows.length, Math.min(length, 10), `${length} rows`);
		assert.equal(page.filteredCount, length);
		assert.equal(page.pageCount, expectedPages);
		assert.equal(page.firstRow, length === 0 ? 0 : 1);
		assert.equal(page.lastRow, Math.min(length, 10));
		const html = renderDataTable(options(`test-render-${length}`, { rows: rows(length) }));
		assert.equal(html.includes('data-table-pager'), length > 10);
		assert.equal(html.includes('data-table-summary'), length > 0 && length <= 10);
		assert.equal(html.includes('data-table-empty'), length === 0);
	}
});

test('dataTable: pageSize false shows every row without pager or summary', () => {
	const html = renderDataTable(options('test-unpaged', { rows: rows(42), pageSize: false }));
	assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 42);
	assert.doesNotMatch(html, /data-table-pager|data-table-summary/);
	assert.equal(getDataTablePage(rows(42), columns, state(), { pageSize: false }).pageCount, 1);
});

test('dataTable: clamps the active page when rows shrink', () => {
	const tableId = 'test-clamp';
	renderDataTable(options(tableId));
	setDataTablePage(tableId, 3);
	assert.match(renderDataTable(options(tableId)), /Page 3 of 3/);
	renderDataTable(options(tableId, { rows: rows(11) }));
	assert.equal(getDataTableState(tableId).page, 2);
	renderDataTable(options(tableId, { rows: rows(1) }));
	assert.equal(getDataTableState(tableId).page, 1);
});

test('dataTable: sorting and filters reset pagination, with filtering before page slicing', () => {
	const tableId = 'test-filter';
	const filterRows = (row: Row, filters: Readonly<Record<string, boolean>>): boolean => row.included === filters.included;
	renderDataTable(options(tableId, { defaultFilters: { included: true }, filterRows }));
	setDataTablePage(tableId, 2);
	setDataTableSort(tableId, 'name');
	assert.equal(getDataTableState(tableId).page, 1);
	setDataTablePage(tableId, 2);
	setDataTableFilter(tableId, 'included', false);
	assert.equal(getDataTableState(tableId).page, 1);
	const filtered = getDataTablePage(rows(25), columns, getDataTableState(tableId), { filterRows });
	assert.equal(filtered.filteredCount, 12);
	assert.equal(filtered.pageCount, 2);
	assert.ok(filtered.rows.every(row => !row.included));
});

test('dataTable: first click sorts numeric (right-aligned) columns descending, others ascending, and toggles after', () => {
	const tableId = 'test-first-direction';
	const withOverride: DataTableColumn<Row>[] = [...columns, { id: 'flag', label: 'Flag', firstSortDirection: 'desc', sortValue: row => String(row.included), render: row => String(row.included) }];
	renderDataTable(options(tableId, { columns: withOverride, initialSort: undefined }));
	assert.equal(getDataTableState(tableId).sortColumn, null);
	setDataTableSort(tableId, 'count');
	assert.deepEqual([getDataTableState(tableId).sortColumn, getDataTableState(tableId).sortDirection], ['count', 'desc']);
	setDataTableSort(tableId, 'count');
	assert.equal(getDataTableState(tableId).sortDirection, 'asc');
	setDataTableSort(tableId, 'name');
	assert.equal(getDataTableState(tableId).sortDirection, 'asc');
	setDataTableSort(tableId, 'flag');
	assert.equal(getDataTableState(tableId).sortDirection, 'desc');
});

test('dataTable: state restored before the first render layers over the defaults', () => {
	const tableId = 'test-restore';
	resetDataTableState(tableId);
	setDataTableState(tableId, { sortColumn: 'name', sortDirection: 'asc' });
	renderDataTable(options(tableId, { defaultFilters: { included: true } }));
	const restored = getDataTableState(tableId);
	assert.deepEqual([restored.sortColumn, restored.sortDirection, restored.filters.included], ['name', 'asc', true]);
	setDataTableState(tableId, { page: 2 });
	assert.equal(getDataTableState(tableId).page, 2);
	resetDataTableState(tableId);
	renderDataTable(options(tableId));
	assert.equal(getDataTableState(tableId).sortColumn, 'count');
});

test('dataTable: escapes plain cell content, labels and row attributes', () => {
	const hostile = [{ id: 'hostile', name: '<img src=x onerror="alert(1)">', count: 1, included: true }];
	const html = renderDataTable(options('test-escape', {
		rows: hostile,
		ariaLabel: '<table>',
		rowOptions: row => ({ className: 'x"y', attributes: { 'data-id': row.name } }),
	}));
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
	assert.match(html, /aria-label="&lt;table&gt;"/);
	assert.match(html, /class="x&quot;y" data-id="&lt;img/);
	const empty = renderDataTable(options('test-escape-empty', { rows: [], emptyMessage: '<empty>' }));
	assert.match(empty, /&lt;empty&gt;/);
});

test('dataTable: structure options render groups, detail rows, footer, widths, row headers and hidden columns', () => {
	const grouped: Row[] = [
		{ id: 'a', name: 'b-model', count: 1, included: true, group: 'Editors' },
		{ id: 'b', name: 'a-model', count: 5, included: true, group: 'Models' },
		{ id: 'c', name: 'a-editor', count: 3, included: true, group: 'Editors' },
	];
	const cols: DataTableColumn<Row>[] = [
		{ id: 'name', label: 'Name', rowHeader: true, width: '40%', sortValue: row => row.name, render: row => row.name },
		{ id: 'secret', label: 'Secret', hidden: true, sortValue: row => row.id, render: () => 'hidden-cell' },
		{ id: 'count', label: 'Count', align: 'right', className: 'num', cellClassName: row => row.count > 4 ? 'big' : undefined, sortValue: row => row.count, render: row => String(row.count) },
	];
	const html = renderDataTable(options('test-structure', {
		rows: grouped,
		columns: cols,
		initialSort: { columnId: 'name', direction: 'asc' },
		groupBy: { key: row => row.group ?? '', label: (key, members) => `${key} (${members.length})` },
		afterRow: row => `<tr class="detail"><td colspan="2">detail-${row.id}</td></tr>`,
		footerRows: [{ className: 'total', cells: { name: 'Total', count: '9' } }],
		pageSize: false,
	}));
	const dom = new JSDOM(`<body>${html}</body>`);
	const doc = dom.window.document;
	const bodyRows = (Array.from(doc.querySelectorAll('tbody > tr')) as Element[]).map(tr => tr.textContent?.trim());
	assert.deepEqual(bodyRows, ['Editors (2)', 'a-editor3', 'detail-c', 'b-model1', 'detail-a', 'Models (1)', 'a-model5', 'detail-b']);
	assert.equal(doc.querySelectorAll('tbody th[scope="row"]').length, 3);
	assert.equal(doc.querySelector('col')?.getAttribute('style'), 'width:40%');
	assert.doesNotMatch(html, /hidden-cell|Secret/);
	assert.equal(doc.querySelector('td.big')?.textContent, '5');
	assert.ok(doc.querySelector('td.data-table-align-right.num'));
	assert.equal(doc.querySelector('tfoot tr.data-table-footer-row.total')?.textContent, 'Total9');
	const headless = renderDataTable(options('test-headless', { showHeader: false }));
	assert.doesNotMatch(headless, /<thead>/);
	dom.window.close();
});

test('dataTable: clicks drive sorting and paging, keep focus, announce, and notify the caller', () => {
	const tableId = 'test-interaction';
	const changes: DataTableState[] = [];
	let renders = 0;
	const { dom, doc, root } = mount(options(tableId, {
		onStateChange: s => changes.push({ ...s }),
		onRender: () => { renders += 1; },
	}));
	const status = (): string => root().querySelector('.data-table-status')?.textContent ?? '';

	click(dom, root().querySelector('[data-table-sort="name"]'));
	assert.equal(doc.activeElement?.getAttribute('data-table-sort'), 'name');
	assert.equal(root().querySelector('th[aria-sort="ascending"] .data-table-sort-indicator')?.textContent, '↑');
	assert.equal(status(), 'Name: Sorted ascending');
	assert.equal(root().querySelector('tbody td')?.textContent, 'Row 01');

	click(dom, root().querySelector('[data-table-direction="next"]'));
	assert.equal(doc.activeElement?.getAttribute('data-table-direction'), 'next');
	assert.equal(status(), 'Page 2 of 3 · Showing 11–20 of 25');

	click(dom, root().querySelector('[data-table-direction="previous"]'));
	// "Previous" is disabled on page 1, so focus moves to the still-usable "Next".
	assert.equal(doc.activeElement?.getAttribute('data-table-direction'), 'next');
	assert.equal(root().querySelector('[data-table-direction="previous"]')?.hasAttribute('disabled'), true);

	click(dom, root().querySelector('[data-table-direction="previous"]'));
	assert.equal(changes.length, 3, 'a disabled pager button changes nothing');
	assert.deepEqual(changes.map(c => [c.sortColumn, c.page]), [['name', 1], ['name', 2], ['name', 1]]);
	assert.equal(renders, 3);
	dom.window.close();
});

test('dataTable: a filter checkbox outside the table re-renders it once per change', () => {
	const tableId = 'test-filter-control';
	const tableOptions = options(tableId, { defaultFilters: { onlyIncluded: false }, filterRows: (row, filters) => !filters.onlyIncluded || row.included });
	const tableHtml = renderDataTable(tableOptions);
	const filterHtml = renderDataTableFilter({ tableId, filterId: 'onlyIncluded', label: 'Only <included>', checked: false, id: 'only-included' });
	assert.match(filterHtml, /Only &lt;included&gt;/);
	const dom = new JSDOM(`<body>${filterHtml}${tableHtml}</body>`, { pretendToBeVisual: true });
	const doc = dom.window.document;
	bindDataTables(doc);
	bindDataTables(doc); // idempotent: a second bind must not double-apply
	const input = doc.getElementById('only-included') as HTMLInputElement;
	const summary = (): string => doc.querySelector('.data-table-page-info, .data-table-summary')?.textContent ?? '';
	assert.match(summary(), /of 25$/);
	input.closest('label')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal(input.checked, true);
	assert.match(summary(), /of 13$/);
	input.checked = false;
	input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	assert.match(summary(), /of 25$/);
	dom.window.close();
});

test('dataTable: icon-only headers expose headerTitle as the accessible name, tooltip and announcement', () => {
	const tableId = 'test-icon-header';
	const iconColumns: DataTableColumn<Row>[] = [
		...columns,
		{ id: 'agents', label: '🤖', headerTitle: 'Agents', align: 'center', sortValue: row => row.count, render: row => String(row.count) },
		{ id: 'plain', label: '📄', headerTitle: 'Instructions', render: () => '' },
	];
	const { dom, root } = mount(options(tableId, { rows: rows(3), columns: iconColumns, initialSort: { columnId: 'name', direction: 'asc' } }));
	const agentsButton = root().querySelector('[data-table-sort="agents"]');
	assert.equal(agentsButton?.getAttribute('aria-label'), 'Agents');
	assert.equal(agentsButton?.getAttribute('title'), 'Sort by Agents');
	const nameButton = root().querySelector('[data-table-sort="name"]');
	assert.equal(nameButton?.textContent, 'Name↑');
	assert.equal(nameButton?.getAttribute('aria-label'), 'Name');
	const plainHeader = Array.from(root().querySelectorAll('th')).find(th => th.textContent?.trim() === '📄');
	assert.equal(plainHeader?.getAttribute('aria-label'), 'Instructions');
	assert.equal(plainHeader?.querySelector('button'), null);
	const agentsCell = root().querySelector('tbody tr')?.children[2];
	assert.equal(agentsCell?.className, 'data-table-align-center');
	click(dom, agentsButton);
	assert.equal(getDataTableAnnouncement(root(), true), 'Agents: Sorted ascending');
	dom.window.close();
});

test('dataTable: cellTitle sets an escaped tooltip on body cells', () => {
	const titled: DataTableColumn<Row>[] = [{ ...columns[0], cellTitle: row => `Full "${row.name}"` }, columns[1]];
	const html = renderDataTable(options('test-cell-title', { rows: rows(1), columns: titled }));
	assert.match(html, /<td title="Full &quot;Row 01&quot;">Row 01<\/td>/);
	assert.doesNotMatch(html, /<td[^>]*class="data-table-align-right"[^>]*title=/);
});

test('dataTable: revealDataTableRow pages to the matching row under the current sort, page size and filters', () => {
	const tableId = 'test-reveal';
	const { dom, doc, root } = mount(options(tableId, { pageSize: 5 }));
	// Sorted by count desc: Row 25 … Row 01, so Row 03 sits at index 22 → page 5 of 5.
	assert.equal(revealDataTableRow<Row>(tableId, row => row.name === 'Row 03', doc), true);
	assert.equal(getDataTableState(tableId).page, 5);
	assert.ok(Array.from(root().querySelectorAll('tbody td')).some(td => td.textContent === 'Row 03'));
	assert.equal(revealDataTableRow<Row>(tableId, row => row.name === 'Row 03', doc), true, 'already visible: stays');
	assert.equal(getDataTableState(tableId).page, 5);
	assert.equal(revealDataTableRow<Row>(tableId, row => row.name === 'missing', doc), false);
	assert.equal(revealDataTableRow<Row>('not-rendered', () => true, doc), false);
	dom.window.close();
});

test('dataTable: a missing field in a host payload renders an empty cell instead of aborting the render', () => {
	// Host payloads are untyped at runtime: a row without the field a column reads must not throw
	// (that used to abort a whole panel's render and leave every button unwired).
	type Partial = { name?: string; count?: number };
	const partialRows = [{ count: 1 }, { name: 'named', count: 2 }] as Partial[];
	const cols: DataTableColumn<Partial>[] = [
		{ id: 'name', label: 'Name', sortValue: row => row.name, render: row => row.name as string },
		{ id: 'escaped', label: 'Escaped', render: row => ({ html: `<b>${escapeHtml(row.name as string)}</b>` }) },
	];
	const html = renderDataTable({ tableId: 'test-missing-field', ariaLabel: 'partial', rows: partialRows, columns: cols, initialSort: { columnId: 'name', direction: 'asc' } });
	assert.match(html, /<td>named<\/td>/);
	assert.match(html, /<td><\/td><td><b><\/b><\/td>/);
	assert.equal(escapeHtml(undefined as unknown as string), '');
	assert.equal(escapeHtml(null as unknown as string), '');
});

test('dataTable: an outer table keeps focus and announcements on its own pager, not a nested table\'s', () => {
	// Mirrors Usage → Worktrees: each outer row carries a paged details table through afterRow.
	const outerId = 'test-nested-outer';
	const innerId = (row: Row): string => `test-nested-inner-${row.id}`;
	const innerOptions = (row: Row): DataTableOptions<Row> => options(innerId(row), { rows: rows(15), initialSort: { columnId: 'name', direction: 'asc' } });
	const { dom, doc, root } = mount(options(outerId, {
		afterRow: row => `<tr class="detail"><td colspan="2">${renderDataTable(innerOptions(row))}</td></tr>`,
	}));
	const outerNext = (): Element | undefined => Array.from(root().querySelectorAll('[data-table-direction="next"]'))
		.find(button => button.getAttribute('data-table-id') === outerId);
	click(dom, outerNext() ?? null);
	assert.equal(getDataTableState(outerId).page, 2);
	assert.equal(doc.activeElement?.getAttribute('data-table-id'), outerId, 'focus stays on the outer pager');
	assert.equal(root().querySelector(':scope > .data-table-status')?.textContent, 'Page 2 of 3 · Showing 11–20 of 25');

	click(dom, root().querySelector(`[data-table-id="${outerId}"][data-table-sort="name"]`));
	assert.equal(doc.activeElement?.getAttribute('data-table-id'), outerId);
	assert.equal(root().querySelector(':scope > .data-table-status')?.textContent, 'Name: Sorted ascending');
	dom.window.close();
});

test('dataTable: the scroll container is a labelled, keyboard-focusable region', () => {
	const html = renderDataTable(options('test-scroll-region', { ariaLabel: 'Models <wide>' }));
	const dom = new JSDOM(`<body>${html}</body>`);
	const region = dom.window.document.querySelector('.data-table-scroll');
	assert.equal(region?.getAttribute('role'), 'region');
	assert.equal(region?.getAttribute('tabindex'), '0');
	assert.equal(region?.getAttribute('aria-label'), 'Models <wide>');
	dom.window.close();
});

test('dataTable: localized pager and sort strings come from the shared dataTable.* keys', () => {
	initializeWebviewLocalization({ 'dataTable.next': '下一页', 'dataTable.sortBy': '按{0}排序' });
	const html = renderDataTable(options('test-l10n', { initialSort: undefined }));
	assert.match(html, />下一页</);
	assert.match(html, /title="按Name排序"/);
});

test('dataTable: every view that injects theme.css also injects the shared dataTable.css', () => {
	const webviewDir = join(__dirname, '../../../../src/webview');
	const views = readdirSync(webviewDir).filter(name => existsSync(join(webviewDir, name, 'main.ts')));
	let checked = 0;
	for (const view of views) {
		const source = readFileSync(join(webviewDir, view, 'main.ts'), 'utf8');
		if (!/shared\/theme\.css/.test(source)) { continue; }
		checked += 1;
		assert.match(source, /import dataTableStyles from ['"]\.\.\/shared\/dataTable\.css['"]/, `${view}/main.ts must import dataTable.css`);
		assert.match(source, /\$\{dataTableStyles\}/, `${view}/main.ts must inject dataTable.css`);
	}
	assert.ok(checked >= 8, `expected most views to be checked, got ${checked}`);
});
