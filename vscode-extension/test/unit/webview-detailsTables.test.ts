/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

/**
 * Behaviour tests for the Details view's tables, rendered by the shared data table component:
 * the grouped Key Metrics table, the persisted editor/model sort, and the top-N "Other" rows whose
 * membership depends on the sort column. These bundle and execute the real
 * `src/webview/details/main.ts` in jsdom and drive it through clicks.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'details', 'main.ts');

let bundlePromise: Promise<string> | undefined;

function bundleDetailsWebview(): Promise<string> {
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

type Tokens = Record<string, number>;

function period(models: Tokens, editors: Tokens): Record<string, unknown> {
	const modelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {};
	for (const [model, tokens] of Object.entries(models)) {
		modelUsage[model] = { inputTokens: tokens - Math.round(tokens / 10), outputTokens: Math.round(tokens / 10) };
	}
	const editorUsage: Record<string, { tokens: number; sessions: number }> = {};
	for (const [editor, tokens] of Object.entries(editors)) {
		editorUsage[editor] = { tokens, sessions: 1 };
	}
	const total = Object.values(models).reduce((s, v) => s + v, 0);
	return {
		tokens: total, thinkingTokens: 0, estimatedTokens: total, actualTokens: total,
		sessions: 3, avgInteractionsPerSession: 4, avgTokensPerSession: 100,
		modelUsage, editorUsage,
		co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 1, estimatedCostCopilot: 1,
	};
}

/** Same usage in every period except `today`, which can differ to make the Today sort change the top N. */
function detailsData(options: { models?: Tokens; todayModels?: Tokens; editors?: Tokens; todayEditors?: Tokens; sortSettings?: Record<string, unknown> }): Record<string, unknown> {
	const models = options.models ?? { 'gpt-5': 1000 };
	const editors = options.editors ?? {};
	const rest = period(models, editors);
	return {
		today: period(options.todayModels ?? models, options.todayEditors ?? editors),
		last30Days: rest,
		month: rest,
		lastMonth: rest,
		lastUpdated: '2026-09-27T12:00:00.000Z',
		backendConfigured: false,
		compactNumbers: false,
		sortSettings: options.sortSettings ?? {},
	};
}

type SavedSettings = {
	editor: { key: string; dir: string };
	model: { key: string; dir: string };
	modelOtherExpanded: boolean;
	editorOtherExpanded: boolean;
};

async function renderDetails(data: Record<string, unknown>): Promise<{ doc: Document; saved: SavedSettings[] }> {
	const bundle = await bundleDetailsWebview();
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://example.org/',
	});
	const saved: SavedSettings[] = [];
	const window = dom.window as any;
	window.acquireVsCodeApi = () => ({
		postMessage(message: { command: string; settings?: SavedSettings }) {
			if (message.command === 'saveSortSettings' && message.settings) { saved.push(message.settings); }
		},
		getState: () => undefined,
		setState: () => undefined,
	});
	window.HTMLElement.prototype.attachInternals = () => ({
		setFormValue() { /* no-op */ }, setValidity() { /* no-op */ }, form: null, states: new Set(), role: null,
	});
	window.console.log = () => { /* keep test output quiet */ };
	window.__INITIAL_DETAILS__ = data;
	window.eval(bundle);
	for (let i = 0; i < 5; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	return { doc: window.document as Document, saved };
}

function tableIn(doc: Document, sectionId: string): HTMLTableElement {
	const table = doc.querySelector<HTMLTableElement>(`#${sectionId} table.data-table`);
	assert.ok(table, `${sectionId} should render a data table`);
	return table;
}

type RowKind = 'top' | 'other' | 'child';

function rowKind(tr: Element): RowKind {
	if (tr.classList.contains('other-group-row')) { return 'other'; }
	return tr.classList.contains('other-child-row') ? 'child' : 'top';
}

/** Body rows as `{ label, kind }`, where kind tells the top-N rows, the "Other" row and its children apart. */
function bodyRows(table: HTMLTableElement): Array<{ label: string; kind: RowKind }> {
	return Array.from(table.querySelectorAll('tbody tr')).map(tr => ({
		label: (tr.querySelector('td')?.textContent ?? '').trim(),
		kind: rowKind(tr),
	}));
}

function clickSort(table: HTMLTableElement, columnId: string): void {
	const button = table.querySelector<HTMLButtonElement>(`button[data-table-sort="${columnId}"]`);
	assert.ok(button, `column ${columnId} should be sortable`);
	button.click();
}

/** The table may have been re-rendered in place, so look it up again after every interaction. */
const modelTable = (doc: Document) => tableIn(doc, 'section-model-usage');
const editorTable = (doc: Document) => tableIn(doc, 'section-editor-usage');

const SIX_MODELS: Tokens = { 'model-a': 600, 'model-b': 500, 'model-c': 400, 'model-d': 300, 'model-e': 200, 'model-f': 100 };

test('Key Metrics renders its Tokens / Cost / Activity groups as separator rows, without sort controls or a pager', async () => {
	const { doc } = await renderDetails(detailsData({}));
	const table = tableIn(doc, 'section-key-metrics');
	const groups = Array.from(table.querySelectorAll('tbody tr.data-table-group-row')).map(tr => (tr.textContent ?? '').trim());
	assert.deepEqual(groups, ['🔢 Tokens', '💰 Cost', '💬 Activity']);
	assert.equal(table.querySelector('[data-table-sort]'), null, 'metric rows mix units, so the table is not sortable');
	assert.equal(doc.querySelector('#section-key-metrics .data-table-pager, #section-key-metrics .data-table-summary'), null);
	const firstMetric = table.querySelector('tbody tr:not(.data-table-group-row)');
	assert.match(firstMetric?.textContent ?? '', /Total tokens/);
});

test('restores the persisted editor and model sort on first render', async () => {
	const { doc } = await renderDetails(detailsData({
		models: { 'model-a': 100, 'model-b': 300, 'model-c': 200 },
		editors: { 'Editor A': 100, 'Editor B': 300, 'Editor C': 200 },
		sortSettings: { editor: { key: 'today', dir: 'desc' }, model: { key: 'month', dir: 'asc' } },
	}));
	const editors = editorTable(doc);
	assert.equal(editors.querySelector('th[aria-sort="descending"] [data-table-sort]')?.getAttribute('data-table-sort'), 'today');
	assert.deepEqual(bodyRows(editors).map(row => ['Editor A', 'Editor B', 'Editor C'].find(name => row.label.endsWith(name))), ['Editor B', 'Editor C', 'Editor A']);
	const models = modelTable(doc);
	assert.equal(models.querySelector('th[aria-sort="ascending"] [data-table-sort]')?.getAttribute('data-table-sort'), 'month');
	assert.deepEqual(bodyRows(models).map(row => row.label.split(' ')[0]), ['model-a', 'model-c', 'model-b']);
});

test('a sort click is persisted and recomputes which models are in the top N; "Other" stays last', async () => {
	// model-f has the fewest tokens overall but the most today.
	const { doc, saved } = await renderDetails(detailsData({
		models: SIX_MODELS,
		todayModels: { ...SIX_MODELS, 'model-f': 10_000 },
	}));
	let rows = bodyRows(modelTable(doc));
	assert.deepEqual(rows.map(row => row.kind), ['top', 'top', 'top', 'top', 'top', 'other']);
	assert.ok(!rows.some(row => row.label.startsWith('model-f')), 'sorted by name, model-f falls into "Other"');

	clickSort(modelTable(doc), 'today');

	assert.deepEqual({ ...saved.at(-1)?.model }, { key: 'today', dir: 'desc' }, 'the new sort is saved through saveSortSettings');
	rows = bodyRows(modelTable(doc));
	assert.deepEqual(rows.map(row => row.kind), ['top', 'top', 'top', 'top', 'top', 'other']);
	assert.ok(rows[0].label.startsWith('model-f'), `model-f should now lead the top N, got ${JSON.stringify(rows)}`);
	assert.match(rows[5].label, /Other \(1 model\)/);

	clickSort(modelTable(doc), 'today');
	assert.deepEqual({ ...saved.at(-1)?.model }, { key: 'today', dir: 'asc' });
	rows = bodyRows(modelTable(doc));
	assert.equal(rows[5].kind, 'other', '"Other" stays last in both directions');
	assert.ok(rows[4].label.startsWith('model-f'), 'ascending puts the biggest top-N model last among the top rows');
});

test('clicking the "Other" row expands its models after it, and the expansion survives a sort', async () => {
	const { doc, saved } = await renderDetails(detailsData({
		models: { ...SIX_MODELS, 'model-g': 50 },
	}));
	const otherRow = modelTable(doc).querySelector<HTMLElement>('tr[data-other-toggle="model"]');
	assert.ok(otherRow);
	assert.equal(otherRow.getAttribute('title'), 'Expand other models');
	otherRow.click();

	assert.equal(saved.at(-1)?.modelOtherExpanded, true);
	let rows = bodyRows(modelTable(doc));
	assert.deepEqual(rows.map(row => row.kind), ['top', 'top', 'top', 'top', 'top', 'other', 'child', 'child']);
	assert.deepEqual(rows.slice(6).map(row => row.label.split(' ')[0]), ['model-f', 'model-g']);
	assert.equal(modelTable(doc).querySelector('tr[data-other-toggle="model"]')?.getAttribute('title'), 'Collapse other models');

	clickSort(modelTable(doc), 'name');
	rows = bodyRows(modelTable(doc));
	assert.deepEqual(rows.map(row => row.kind), ['top', 'top', 'top', 'top', 'top', 'other', 'child', 'child']);
	assert.deepEqual(rows.slice(6).map(row => row.label.split(' ')[0]), ['model-g', 'model-f'], 'children follow the new sort (name, descending)');

	modelTable(doc).querySelector<HTMLElement>('tr[data-other-toggle="model"]')?.click();
	assert.equal(saved.at(-1)?.modelOtherExpanded, false);
	assert.deepEqual(bodyRows(modelTable(doc)).map(row => row.kind), ['top', 'top', 'top', 'top', 'top', 'other']);
});

test('editor caveat tooltips stay on their rows and collapsing the section hides the table container', async () => {
	const { doc, saved } = await renderDetails(detailsData({ editors: { JetBrains: 200, 'VS Code': 100 } }));
	const jetBrains = Array.from(editorTable(doc).querySelectorAll('tbody tr')).find(tr => (tr.textContent ?? '').includes('JetBrains'));
	assert.match(jetBrains?.getAttribute('title') ?? '', /^JetBrains: only user messages/);
	assert.match(jetBrains?.textContent ?? '', /ⓘ/);

	const heading = doc.querySelector<HTMLElement>('#section-editor-usage h3');
	assert.equal(heading?.getAttribute('aria-controls'), 'editor-usage-table');
	heading?.click();
	assert.ok(doc.getElementById('editor-usage-table')?.classList.contains('hidden'));
	assert.equal((saved.at(-1) as unknown as { editorSectionCollapsed: boolean }).editorSectionCollapsed, true);
});
