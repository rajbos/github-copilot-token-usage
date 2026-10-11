import test, { afterEach, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import type { WorkspaceCustomizationMatrix, WorkspaceCustomizationRow } from '../../../src/types';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import { statusBadgeHtml } from '../../src/webview/usage/statusBadge';
import {
	bindDataTables,
	getDataTablePage,
	getDataTableState,
	setDataTableFilter,
	setDataTablePage,
	setDataTableSort,
	type DataTableState,
} from '../../src/webview/shared/dataTable';
import {
	CUSTOMIZATION_FILTER_NONE_ONLY,
	CUSTOMIZATION_PAGE_SIZE,
	CUSTOMIZATION_TABLE_ID,
	buildCustomizationColumns,
	buildCustomizationSectionHtml,
	customizationStatusRank,
	hasNoCustomization,
	renderCustomizationTable,
	renderMergedWorkspaceMembers,
	renderUngroupedWorkspaceNote,
} from '../../src/webview/usage/customizationMatrixSection';

beforeEach(() => initializeWebviewLocalization({}));
afterEach(() => initializeWebviewLocalization({}));

const TYPES = [
	{ id: 'instructions', icon: '📄', label: 'Instructions' },
	{ id: 'agents', icon: '🤖', label: 'Agents' },
];

function row(name: string, interactions: number, statuses: Record<string, '✅' | '⚠️' | '❌'> = { instructions: '✅', agents: '✅' }, extra: Partial<WorkspaceCustomizationRow> = {}): WorkspaceCustomizationRow {
	return { workspacePath: `/repos/${name}`, workspaceName: name, sessionCount: interactions % 7, interactionCount: interactions, typeStatuses: statuses, ...extra };
}

function matrix(rows: WorkspaceCustomizationRow[]): WorkspaceCustomizationMatrix {
	return {
		customizationTypes: TYPES,
		workspaces: rows,
		totalWorkspaces: rows.length,
		workspacesWithIssues: rows.filter(hasNoCustomization).length,
	};
}

function rows(count: number): WorkspaceCustomizationRow[] {
	return Array.from({ length: count }, (_, i) => row(`ws-${String(i).padStart(3, '0')}`, count - i));
}

function state(overrides: Partial<DataTableState> = {}): DataTableState {
	return { sortColumn: 'interactions', sortDirection: 'desc', page: 1, filters: { [CUSTOMIZATION_FILTER_NONE_ONLY]: false }, ...overrides };
}

function filterRows(r: WorkspaceCustomizationRow, filters: Readonly<Record<string, boolean>>): boolean {
	return !filters[CUSTOMIZATION_FILTER_NONE_ONLY] || hasNoCustomization(r);
}

function page(data: WorkspaceCustomizationRow[], s: DataTableState) {
	return getDataTablePage(data, buildCustomizationColumns(matrix(data)), s, { filterRows, pageSize: CUSTOMIZATION_PAGE_SIZE });
}

test('customizationMatrix: page slicing at 0/1/20/21/140 rows', () => {
	const cases: Array<[number, number, number, number]> = [
		// rows, pageCount, rows on page 1, rows on last page
		[0, 1, 0, 0],
		[1, 1, 1, 1],
		[20, 1, 20, 20],
		[21, 2, 20, 1],
		[140, 7, 20, 20],
	];
	for (const [count, pageCount, firstLen, lastLen] of cases) {
		const data = rows(count);
		const first = page(data, state());
		assert.equal(first.pageCount, pageCount, `pageCount for ${count}`);
		assert.equal(first.rows.length, firstLen, `first page length for ${count}`);
		assert.equal(page(data, state({ page: pageCount })).rows.length, lastLen, `last page length for ${count}`);
	}
	const p2 = page(rows(21), state({ page: 2 }));
	assert.deepEqual([p2.firstRow, p2.lastRow, p2.filteredCount], [21, 21, 21]);
});

test('customizationMatrix: page clamps when the list shrinks', () => {
	const result = page(rows(25), state({ page: 7 }));
	assert.equal(result.page, 2);
	assert.equal(result.rows.length, 5);
});

test('customizationMatrix: default order is interactions descending', () => {
	const data = [row('a', 5), row('b', 50), row('c', 10)];
	assert.deepEqual(page(data, state()).rows.map(r => r.workspaceName), ['b', 'c', 'a']);
});

test('customizationMatrix: sorts by each column both directions', () => {
	const data = [
		row('beta', 3, { instructions: '❌', agents: '✅' }, { sessionCount: 9 }),
		row('Alpha', 7, { instructions: '✅', agents: '❌' }, { sessionCount: 1 }),
		row('gamma', 5, { instructions: '⚠️', agents: '⚠️' }, { sessionCount: 4 }),
	];
	const names = (s: DataTableState) => page(data, s).rows.map(r => r.workspaceName);
	assert.deepEqual(names(state({ sortColumn: 'workspace', sortDirection: 'asc' })), ['Alpha', 'beta', 'gamma']);
	assert.deepEqual(names(state({ sortColumn: 'workspace', sortDirection: 'desc' })), ['gamma', 'beta', 'Alpha']);
	assert.deepEqual(names(state({ sortColumn: 'sessions', sortDirection: 'asc' })), ['Alpha', 'gamma', 'beta']);
	assert.deepEqual(names(state({ sortColumn: 'interactions', sortDirection: 'asc' })), ['beta', 'gamma', 'Alpha']);
	// Status columns: ✅ > ⚠️ > ❌, so ascending lists the missing ones first.
	assert.deepEqual(names(state({ sortColumn: 'type:instructions', sortDirection: 'asc' })), ['beta', 'gamma', 'Alpha']);
	assert.deepEqual(names(state({ sortColumn: 'type:instructions', sortDirection: 'desc' })), ['Alpha', 'gamma', 'beta']);
	assert.deepEqual(names(state({ sortColumn: 'type:agents', sortDirection: 'asc' })), ['Alpha', 'gamma', 'beta']);
});

test('customizationMatrix: ties keep host order in both directions', () => {
	const data = [row('first', 1), row('second', 1), row('third', 1)];
	assert.deepEqual(page(data, state({ sortColumn: 'type:instructions', sortDirection: 'asc' })).rows.map(r => r.workspaceName), ['first', 'second', 'third']);
	assert.deepEqual(page(data, state({ sortColumn: 'type:instructions', sortDirection: 'desc' })).rows.map(r => r.workspaceName), ['first', 'second', 'third']);
});

test('customizationMatrix: status rank and no-customization test', () => {
	assert.equal(customizationStatusRank('✅'), 2);
	assert.equal(customizationStatusRank('⚠️'), 1);
	assert.equal(customizationStatusRank('❌'), 0);
	assert.equal(customizationStatusRank(undefined), null);
	assert.equal(hasNoCustomization(row('x', 1, { instructions: '❌', agents: '❌' })), true);
	assert.equal(hasNoCustomization(row('x', 1, { instructions: '❌', agents: '⚠️' })), false);
});

test('customizationMatrix: filter keeps paging consistent', () => {
	const data = rows(45).map((r, i) => i % 3 === 0 ? { ...r, typeStatuses: { instructions: '❌' as const, agents: '❌' as const } } : r);
	const filtered = page(data, state({ page: 3, filters: { [CUSTOMIZATION_FILTER_NONE_ONLY]: true } }));
	assert.equal(filtered.filteredCount, 15);
	assert.equal(filtered.pageCount, 1);
	assert.equal(filtered.page, 1);
	assert.ok(filtered.rows.every(hasNoCustomization));
});

test('customizationMatrix: rendered table resets page on sort/filter and updates counts', () => {
	const data = rows(45).map((r, i) => i % 3 === 0 ? { ...r, typeStatuses: { instructions: '❌' as const, agents: '❌' as const } } : r);
	const m = matrix(data);
	buildCustomizationSectionHtml(m);
	setDataTablePage(CUSTOMIZATION_TABLE_ID, 3);
	assert.match(renderCustomizationTable(m), /Page 3 of 3 · Showing 41–45 of 45/);
	setDataTableSort(CUSTOMIZATION_TABLE_ID, 'workspace');
	assert.equal(getDataTableState(CUSTOMIZATION_TABLE_ID).page, 1);
	setDataTablePage(CUSTOMIZATION_TABLE_ID, 2);
	setDataTableFilter(CUSTOMIZATION_TABLE_ID, CUSTOMIZATION_FILTER_NONE_ONLY, true);
	const html = renderCustomizationTable(m);
	assert.match(html, /Showing 1–15 of 15/);
	assert.doesNotMatch(html, /data-table-direction/);
	assert.match(buildCustomizationSectionHtml(m), /data-table-filter="noCustomizationOnly" checked/);
	setDataTableFilter(CUSTOMIZATION_TABLE_ID, CUSTOMIZATION_FILTER_NONE_ONLY, false);
});

test('customizationMatrix: pager hidden at 20 rows, shown at 21', () => {
	assert.doesNotMatch(renderCustomizationTable(matrix(rows(20))), /data-table-direction/);
	assert.match(renderCustomizationTable(matrix(rows(21))), /data-table-direction="next"/);
});

test('customizationMatrix: escapes name and path, path is the tooltip', () => {
	const evil = row('<img src=x onerror=alert(1)>', 3, undefined, { workspacePath: 'C:\\repos\\"quoted"<b>' });
	const twin = row('<img src=x onerror=alert(1)>', 2, undefined, { workspacePath: '/other/place' });
	const html = buildCustomizationSectionHtml(matrix([evil, twin]));
	assert.doesNotMatch(html, /<img src=x/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
	assert.match(html, /title="C:\\repos\\&quot;quoted&quot;&lt;b&gt;"/);
	assert.match(html, /title="\/other\/place"/);
});

test('customizationMatrix: renders interactions column, icon headers with type labels and the filter toggle', () => {
	const html = buildCustomizationSectionHtml(matrix([row('a', 1234), row('b', 3, { instructions: '❌', agents: '❌' })]));
	assert.match(html, />Interactions/);
	assert.match(html, />1234</);
	assert.match(html, /aria-label="Instructions"/);
	assert.match(html, /title="Sort by Agents"/);
	assert.match(html, /Only workspaces without customization files/);
	assert.match(html, /1 workspace\(s\) have no customization files/);
});

test('customizationMatrix: empty matrix renders the empty state', () => {
	assert.match(buildCustomizationSectionHtml(null), /No workspaces with customization files/);
	assert.match(buildCustomizationSectionHtml(matrix([])), /No workspaces with customization files/);
});

test('customizationMatrix: every badge carries a localized accessible name', () => {
	const issues = buildCustomizationSectionHtml(matrix([row('a', 1), row('b', 2, { instructions: '❌', agents: '❌' })]));
	assert.match(issues, /class="stale-warning"[^>]*><span[^>]*title="No customization files" aria-label="No customization files">!<\/span>/);
	const allGood = buildCustomizationSectionHtml(matrix([row('a', 1)]));
	assert.match(allGood, /title="Present and fresh" aria-label="Present and fresh">✓<\/span> All workspaces have up-to-date customizations\./);
	initializeWebviewLocalization({
		'usage.customization.status.fresh': '存在且最新',
		'usage.customization.status.stale': '存在但已过时',
		'usage.customization.status.missing': '缺失',
	});
	try {
		assert.match(statusBadgeHtml('✅'), /aria-label="存在且最新"/);
		assert.match(statusBadgeHtml('⚠️'), /aria-label="存在但已过时"/);
		assert.match(statusBadgeHtml('❌'), /aria-label="缺失"/);
		assert.doesNotMatch(statusBadgeHtml('❌'), / title=/);
	} finally {
		initializeWebviewLocalization({});
	}
});

test('customizationMatrix: an active filter stays clearable when a refresh leaves no matching workspaces', () => {
	buildCustomizationSectionHtml(matrix([row('a', 1), row('b', 2, { instructions: '❌', agents: '❌' })]));
	setDataTableFilter(CUSTOMIZATION_TABLE_ID, CUSTOMIZATION_FILTER_NONE_ONLY, true);
	try {
		const html = buildCustomizationSectionHtml(matrix([row('a', 1), row('b', 2)]));
		assert.match(html, /data-table-filter="noCustomizationOnly" checked/);
		assert.match(html, /No rows to display\./);
	} finally {
		setDataTableFilter(CUSTOMIZATION_TABLE_ID, CUSTOMIZATION_FILTER_NONE_ONLY, false);
	}
	assert.doesNotMatch(buildCustomizationSectionHtml(matrix([row('a', 1)])), /data-table-filter/);
});

test("customizationMatrix: populated and empty sections keep the What's New nav anchor", () => {
	assert.match(buildCustomizationSectionHtml(matrix([row('a', 1)])), /id="section-customization-files"/);
	assert.match(buildCustomizationSectionHtml(null), /id="section-customization-files"/);
});

test('customizationMatrix: a row with no status data is unknown, not missing', () => {
	assert.equal(hasNoCustomization(row('x', 1, {})), false);
	assert.equal(hasNoCustomization({ ...row('x', 1), typeStatuses: undefined as unknown as WorkspaceCustomizationRow['typeStatuses'] }), false);
	const html = buildCustomizationSectionHtml(matrix([row('a', 1, {})]));
	assert.doesNotMatch(html, /aria-label="No customization files"/);
	assert.match(html, /title="Status unknown" aria-label="Status unknown">\?<\/span>/);
});

test('statusBadge: unknown renders a neutral ? badge, not the missing ✕', () => {
	const unknown = statusBadgeHtml('❓');
	assert.match(unknown, />\?<\/span>$/);
	assert.match(unknown, /aria-label="Status unknown"/);
	assert.doesNotMatch(unknown, /239,68,68/);
	assert.match(statusBadgeHtml('❌'), />✕<\/span>$/);
});

test('customizationMatrix: the filter toggles once from the label text and from a plain change event', () => {
	const data = matrix([row('a', 3), row('b', 2, { instructions: '❌', agents: '❌' }), row('c', 1)]);
	const dom = new JSDOM(`<body>${buildCustomizationSectionHtml(data)}</body>`, { pretendToBeVisual: true });
	const globals = globalThis as Record<string, unknown>;
	const saved = ['document', 'Element', 'HTMLElement'].map(key => [key, globals[key]] as const);
	globals.document = dom.window.document;
	globals.Element = dom.window.Element;
	globals.HTMLElement = dom.window.HTMLElement;
	try {
		const doc = dom.window.document;
		bindDataTables(doc);
		const bodyRows = (): number => doc.querySelectorAll('#data-table-root-customization tbody tr').length;
		const input = doc.querySelector('input[data-table-filter="noCustomizationOnly"]') as HTMLInputElement | null;
		assert.ok(input);
		assert.equal(bodyRows(), 3);
		// Clicking the label text activates the checkbox and fires one change.
		const label = input.closest('label');
		assert.ok(label);
		label.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		assert.equal(input.checked, true);
		assert.equal(bodyRows(), 1);
		// Keyboard toggles arrive as a change too.
		input.checked = false;
		input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		assert.equal(bodyRows(), 3);
	} finally {
		for (const [key, value] of saved) { globals[key] = value; }
		setDataTableFilter(CUSTOMIZATION_TABLE_ID, CUSTOMIZATION_FILTER_NONE_ONLY, false);
		dom.window.close();
	}
});

test('merged-folder list: a single worktree grouped under a checkout found only through its pointer shows both folders', () => {
	// groupFolders() puts the synthetic canonical checkout first, even though it had no sessions itself.
	const html = renderMergedWorkspaceMembers(['/code/gadget', '/wt/feature']);
	assert.match(html, /2 folders merged/);
	assert.ok(html.includes('/code/gadget'));
	assert.ok(html.includes('/wt/feature'));
	assert.equal(renderMergedWorkspaceMembers(['/code/only']), '', 'one folder: nothing to expand');
	assert.equal(renderMergedWorkspaceMembers(undefined), '');
});

test('merged-folder list and ungrouped note escape folder names and carry an accessible badge label', () => {
	const html = renderMergedWorkspaceMembers(['/a/<b>', '/c/"d"']);
	assert.ok(!html.includes('<b>'), 'paths are escaped');
	const note = renderUngroupedWorkspaceNote(['repo-85ed99', 'goofy-wozniak-42f712']);
	assert.ok(note.includes('2 workspace name(s) look like ungrouped worktrees or clones: repo-85ed99, goofy-wozniak-42f712'));
	assert.match(note, /aria-label="Ungrouped workspace names"/);
	assert.equal(renderUngroupedWorkspaceNote([]), '');
});
