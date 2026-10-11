/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

/**
 * Behaviour tests for the Team Dashboard leaderboard, rendered by the shared data table component.
 * These bundle and execute the real `src/webview/dashboard/main.ts` in jsdom and drive the table
 * through clicks: rank ordering, the current-user highlight, expandable fluency rows (which must
 * survive a sort re-render), the delete button, and escaping of member-supplied names.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'dashboard', 'main.ts');

let bundlePromise: Promise<string> | undefined;

function bundleDashboardWebview(): Promise<string> {
	bundlePromise ??= esbuild.build({
		entryPoints: [ENTRY],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		nodePaths: [path.join(EXT_ROOT, 'node_modules')],
		loader: { '.css': 'text', '.svg': 'dataurl', '.png': 'dataurl' },
		logLevel: 'silent',
	}).then((result) => result.outputFiles[0].text);
	return bundlePromise;
}

type Member = Record<string, unknown> & { userId: string; datasetId: string; totalTokens: number; rank: number };

function member(index: number, overrides: Partial<Member> = {}): Member {
	return {
		userId: `u:user-${index}`,
		datasetId: `ds:team-${index}`,
		totalTokens: 100_000 - index * 1000,
		totalInteractions: 10,
		totalCost: 1,
		sessions: 20 - index,
		avgTurnsPerSession: 3,
		uniqueModels: 2,
		uniqueWorkspaces: 1,
		daysActive: index + 1,
		avgTokensPerTurn: 50,
		rank: index + 1,
		...overrides,
	};
}

const FLUENCY = {
	fluencyStage: 2,
	fluencyLabel: 'Explorer',
	fluencyCategories: [{ category: 'Prompting', icon: '💬', stage: 2, tips: ['Read [the guide](https://example.org/guide)'] }],
};

function dashboardData(members: Member[], personalUserId = 'u:user-1'): Record<string, unknown> {
	return {
		personal: { userId: personalUserId, totalTokens: 1000, totalInteractions: 10, totalCost: 1, devices: ['d1'], workspaces: ['w1'], modelUsage: {} },
		team: { members, totalTokens: 1000, totalInteractions: 10, averageTokensPerUser: 500 },
		lookbackDays: 30,
		lastUpdated: '2026-09-27T12:00:00.000Z',
		compactNumbers: false,
	};
}

async function renderDashboard(data: Record<string, unknown>): Promise<{ doc: Document; posted: Array<Record<string, unknown>> }> {
	const bundle = await bundleDashboardWebview();
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://example.org/',
	});
	const posted: Array<Record<string, unknown>> = [];
	const window = dom.window as any;
	window.acquireVsCodeApi = () => ({ postMessage(message: Record<string, unknown>) { posted.push(message); }, getState: () => undefined, setState: () => undefined });
	window.HTMLElement.prototype.attachInternals = () => ({
		setFormValue() { /* no-op */ }, setValidity() { /* no-op */ }, form: null, states: new Set(), role: null,
	});
	window.console.log = () => { /* keep test output quiet */ };
	window.__INITIAL_DASHBOARD__ = data;
	window.eval(bundle);
	for (let i = 0; i < 5; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	return { doc: window.document as Document, posted };
}

/** The table may have been re-rendered in place, so look it up again after every interaction. */
function leaderboard(doc: Document): HTMLTableElement {
	const table = doc.querySelector<HTMLTableElement>('.leaderboard table.data-table');
	assert.ok(table, 'leaderboard should render a data table');
	return table;
}

function memberRows(doc: Document): HTMLTableRowElement[] {
	return Array.from(leaderboard(doc).querySelectorAll<HTMLTableRowElement>('tbody tr.leaderboard-row'));
}

function rowFor(doc: Document, userId: string): HTMLTableRowElement {
	const row = memberRows(doc).find(tr => (tr.children[1]?.textContent ?? '').startsWith(userId));
	assert.ok(row, `row for ${userId} should render`);
	return row;
}

test('ranks members by the default rank order and highlights the current user', async () => {
	const { doc } = await renderDashboard(dashboardData([member(0), member(1), member(2)]));
	const table = leaderboard(doc);
	assert.equal(table.querySelector('th[aria-sort="ascending"] [data-table-sort]')?.getAttribute('data-table-sort'), 'rank');
	assert.deepEqual(memberRows(doc).map(tr => (tr.children[0]?.textContent ?? '').trim()), ['1', '2', '3']);
	const current = rowFor(doc, 'user-1');
	assert.ok(current.classList.contains('current-user'));
	assert.match(current.children[1]?.textContent ?? '', /user-1 👈/);
	assert.equal(memberRows(doc).filter(tr => tr.classList.contains('current-user')).length, 1);
	assert.equal(rowFor(doc, 'user-0').children[2]?.textContent, 'team-0', 'dataset prefix is stripped');
});

test('a fluency row expands its detail row, and stays expanded across a sort re-render', async () => {
	const { doc } = await renderDashboard(dashboardData([member(0), member(1, FLUENCY), member(2)]));
	let row = rowFor(doc, 'user-1');
	assert.ok(row.classList.contains('expandable'));
	assert.equal(row.getAttribute('aria-expanded'), 'false');
	assert.ok(row.nextElementSibling?.classList.contains('detail-row'));
	assert.ok(row.nextElementSibling?.classList.contains('hidden'));
	assert.equal(rowFor(doc, 'user-0').classList.contains('expandable'), false, 'members without fluency data do not expand');

	row.click();
	assert.equal(row.getAttribute('aria-expanded'), 'true');
	assert.equal(row.querySelector('.expand-toggle')?.textContent, '▼');
	assert.equal(row.nextElementSibling?.classList.contains('hidden'), false);
	assert.ok(row.nextElementSibling?.querySelector('.fluency-tip a[href="https://example.org/guide"]'), 'tip links render');

	leaderboard(doc).querySelector<HTMLButtonElement>('button[data-table-sort="days"]')?.click();
	assert.equal((memberRows(doc)[0].children[0]?.textContent ?? '').replace(/[▶▼]/, '').trim(), '3', 'sorted by days, descending');
	row = rowFor(doc, 'user-1');
	assert.equal(row.getAttribute('aria-expanded'), 'true', 'expansion survives the re-render');
	assert.equal(row.nextElementSibling?.classList.contains('detail-row'), true, 'the detail row moves with its member');
	assert.equal(row.nextElementSibling?.classList.contains('hidden'), false);

	row.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(row.getAttribute('aria-expanded'), 'false', 'Enter collapses the row again');
	assert.ok(row.nextElementSibling?.classList.contains('hidden'));
});

test('the delete button posts the member and dataset without toggling the row', async () => {
	const { doc, posted } = await renderDashboard(dashboardData([member(0, FLUENCY)]));
	const row = rowFor(doc, 'user-0');
	const button = row.querySelector<HTMLButtonElement>('.delete-row-btn');
	assert.equal(button?.title, 'Delete data for user-0 in dataset team-0');
	button?.click();
	assert.deepEqual({ ...posted.find(message => message.command === 'deleteUserDataset') }, { command: 'deleteUserDataset', userId: 'u:user-0', datasetId: 'ds:team-0' });
	assert.equal(row.getAttribute('aria-expanded'), 'false');
});

test('member-supplied names are escaped and long teams are paged', async () => {
	const members = Array.from({ length: 12 }, (_, index) => member(index));
	members[0] = member(0, { userId: 'u:<img src=x onerror=alert(1)>', datasetId: 'ds:"><b>x</b>' });
	const { doc } = await renderDashboard(dashboardData(members, 'u:nobody'));
	const table = leaderboard(doc);
	assert.equal(table.querySelector('img, b'), null, 'no markup from member names is rendered');
	assert.match(memberRows(doc)[0].children[1]?.textContent ?? '', /<img src=x onerror=alert\(1\)>/);
	assert.equal(memberRows(doc).length, 10, 'the first page shows the default page size');
	assert.ok(doc.querySelector('.leaderboard .data-table-pager'));
});
