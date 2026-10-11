/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

/**
 * Rendering tests for the Details view's provider filter (issue #2198).
 *
 * These bundle and execute the real `src/webview/details/main.ts` in jsdom. The bug lived in how
 * the rendered cost row, its tooltip and the "Cost by Provider" panel related to each other, so the
 * assertions read the rendered DOM for every period column rather than the helpers in isolation.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'details', 'main.ts');

const PERIODS = ['today', 'last30Days', 'month', 'lastMonth'] as const;
type Period = typeof PERIODS[number];
type Costs = Record<string, number>;
/** Editor → model id used in every period. Billing group comes from `getBillingGroup(editor, model)`. */
type EditorModels = Record<string, string>;

/** VS Code is a Copilot surface (→ "GitHub Copilot"); Claude Code bills its Claude model to Anthropic. */
const DEFAULT_EDITORS: EditorModels = { 'VS Code': 'gpt-5', 'Claude Code': 'claude-sonnet-4' };

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

function period(costs: Costs, editors: EditorModels): Record<string, unknown> {
	const copilot = costs['GitHub Copilot'] ?? 0;
	const modelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {};
	const editorUsage: Record<string, { tokens: number; sessions: number }> = {};
	const editorModelUsage: Record<string, Record<string, { inputTokens: number; outputTokens: number }>> = {};
	for (const [editor, model] of Object.entries(editors)) {
		modelUsage[model] = { inputTokens: 1000, outputTokens: 100 };
		editorUsage[editor] = { tokens: 1100, sessions: 1 };
		editorModelUsage[editor] = { [model]: { inputTokens: 1000, outputTokens: 100 } };
	}
	return {
		tokens: 1_000_000, thinkingTokens: 0, estimatedTokens: 1_000_000, actualTokens: 1_000_000,
		sessions: 3, avgInteractionsPerSession: 4, avgTokensPerSession: 333_333,
		modelUsage, editorUsage, editorModelUsage,
		co2: 0, treesEquivalent: 0, waterUsage: 0,
		estimatedCost: Object.values(costs).reduce((s, v) => s + v, 0),
		estimatedCostCopilot: copilot,
		billingGroupCosts: costs,
	};
}

function detailsData(costs: Record<Period, Costs>, excludedProviders: string[], editors: EditorModels = DEFAULT_EDITORS): Record<string, unknown> {
	return {
		today: period(costs.today, editors),
		last30Days: period(costs.last30Days, editors),
		month: period(costs.month, editors),
		lastMonth: period(costs.lastMonth, editors),
		lastUpdated: '2026-09-27T12:00:00.000Z',
		backendConfigured: false,
		compactNumbers: false,
		sortSettings: { excludedProviders },
	};
}

async function renderDetails(data: Record<string, unknown>): Promise<Document> {
	const bundle = await bundleDetailsWebview();
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://example.org/',
	});
	const window = dom.window as any;
	window.acquireVsCodeApi = () => ({ postMessage() { /* no-op */ }, getState: () => undefined, setState: () => undefined });
	window.HTMLElement.prototype.attachInternals = () => ({
		setFormValue() { /* no-op */ }, setValidity() { /* no-op */ }, form: null, states: new Set(), role: null,
	});
	window.__INITIAL_DETAILS__ = data;
	window.eval(bundle);
	for (let i = 0; i < 5; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	return window.document as Document;
}

/** Finds the provider cost row ("Estimated cost (all|selected providers)") in the Key Metrics table. */
function providersCostRow(doc: Document): { label: string; tooltip: string; cells: Record<Period, string> } | undefined {
	for (const tr of Array.from(doc.querySelectorAll('#section-key-metrics table.data-table tbody tr'))) {
		const labelEl = tr.querySelector('.metric-label');
		const label = labelEl?.textContent ?? '';
		if (!/Estimated cost \((all|selected) providers\)/.test(label)) { continue; }
		const values = Array.from(tr.querySelectorAll('td')).slice(1).map(td => (td.textContent ?? '').trim());
		return {
			label,
			tooltip: labelEl?.getAttribute('title') ?? '',
			cells: { today: values[0], last30Days: values[1], month: values[2], lastMonth: values[3] },
		};
	}
	return undefined;
}

/** First-cell text of every body row in the section whose heading contains `heading`. */
function sectionRowLabels(doc: Document, heading: string): string[] {
	const h3 = Array.from(doc.querySelectorAll('h3')).find(h => (h.textContent ?? '').includes(heading));
	const rows = h3?.closest('.section')?.querySelectorAll('table tbody tr') ?? [];
	return Array.from(rows).map(tr => (tr.querySelector('td')?.textContent ?? '').trim());
}

function hasRow(labels: string[], name: string): boolean {
	return labels.some(label => label.includes(name));
}

function hasCostByProviderPanel(doc: Document): boolean {
	return Array.from(doc.querySelectorAll('h3')).some(h => (h.textContent ?? '').includes('Cost by Provider'));
}

test('hidden panel: a saved exclusion no longer zeroes any period, and the row says "all providers" (issue #2198)', async () => {
	// Only Anthropic has cost this month, so the Cost by Provider panel is hidden. A stale saved
	// exclusion of Anthropic used to silently drop it from every period's total.
	const doc = await renderDetails(detailsData({
		today: { 'GitHub Copilot': 0, Anthropic: 40 },
		last30Days: { 'GitHub Copilot': 0, Anthropic: 600 },
		month: { 'GitHub Copilot': 0, Anthropic: 682 },
		lastMonth: { 'GitHub Copilot': 5, Anthropic: 20 },
	}, ['Anthropic']));

	assert.equal(hasCostByProviderPanel(doc), false, 'panel should be hidden with one provider costing this month');
	const row = providersCostRow(doc);
	assert.ok(row, 'provider cost row should render when a non-Copilot provider is present');
	assert.match(row.label, /Estimated cost \(all providers\)/);
	assert.doesNotMatch(row.tooltip, /filter/i, 'tooltip must not point at a filter that is not shown');
	assert.deepEqual(row.cells, { today: '$40.00', last30Days: '$600.00', month: '$682.00', lastMonth: '$25.00' });

	// The same stale exclusion must not hide Anthropic usage from the Editor / Model lists either.
	const editors = sectionRowLabels(doc, 'Usage by Editor');
	assert.ok(hasRow(editors, 'Claude Code'), `Claude Code should stay listed, got ${JSON.stringify(editors)}`);
	assert.ok(hasRow(editors, 'VS Code'));
	const models = sectionRowLabels(doc, 'Model Usage');
	assert.ok(hasRow(models, 'claude-sonnet-4'), `Claude model should stay listed, got ${JSON.stringify(models)}`);
	assert.ok(hasRow(models, 'gpt-5'));
});

test('visible panel: an exclusion with a card applies to every period and the row says "selected providers"', async () => {
	const doc = await renderDetails(detailsData({
		today: { 'GitHub Copilot': 3, Anthropic: 40 },
		last30Days: { 'GitHub Copilot': 30, Anthropic: 600 },
		month: { 'GitHub Copilot': 35, Anthropic: 682 },
		lastMonth: { 'GitHub Copilot': 5, Anthropic: 20 },
	}, ['Anthropic']));

	assert.equal(hasCostByProviderPanel(doc), true);
	const row = providersCostRow(doc);
	assert.ok(row);
	assert.match(row.label, /Estimated cost \(selected providers\)/);
	assert.match(row.tooltip, /Cost by Provider section/);
	assert.doesNotMatch(row.tooltip, /below/, 'the panel renders above the table');
	assert.deepEqual(row.cells, { today: '$3.00', last30Days: '$30.00', month: '$35.00', lastMonth: '$5.00' });

	// A carded exclusion filters the Editor / Model lists too.
	const editors = sectionRowLabels(doc, 'Usage by Editor');
	assert.ok(!hasRow(editors, 'Claude Code'), `Claude Code should be filtered out, got ${JSON.stringify(editors)}`);
	assert.ok(hasRow(editors, 'VS Code'));
	const models = sectionRowLabels(doc, 'Model Usage');
	assert.ok(!hasRow(models, 'claude-sonnet-4'), `Claude model should be filtered out, got ${JSON.stringify(models)}`);
	assert.ok(hasRow(models, 'gpt-5'));
});

test('visible panel: a saved exclusion for a provider with no card is ignored in every period', async () => {
	// Google only has cost last month, so it gets no card and its saved exclusion cannot be undone.
	const doc = await renderDetails(detailsData({
		today: { 'GitHub Copilot': 3, Anthropic: 40 },
		last30Days: { 'GitHub Copilot': 30, Anthropic: 600, Google: 7 },
		month: { 'GitHub Copilot': 35, Anthropic: 682 },
		lastMonth: { 'GitHub Copilot': 5, Anthropic: 20, Google: 9 },
	}, ['Google'], { ...DEFAULT_EDITORS, 'Gemini CLI': 'gemini-2.5-pro' }));

	assert.equal(hasCostByProviderPanel(doc), true);
	const row = providersCostRow(doc);
	assert.ok(row);
	assert.deepEqual(row.cells, { today: '$43.00', last30Days: '$637.00', month: '$717.00', lastMonth: '$34.00' });

	// Google's usage stays listed: its exclusion has no card, so it does not apply.
	const editors = sectionRowLabels(doc, 'Usage by Editor');
	assert.ok(hasRow(editors, 'Gemini CLI'), `Gemini CLI should stay listed, got ${JSON.stringify(editors)}`);
	const models = sectionRowLabels(doc, 'Model Usage');
	assert.ok(hasRow(models, 'gemini-2.5-pro'), `Gemini model should stay listed, got ${JSON.stringify(models)}`);
});

test('Usage by Editor rows show the official logo, falling back to the emoji for unknown editors', async () => {
	const doc = await renderDetails(detailsData({
		today: { 'GitHub Copilot': 3 }, last30Days: { 'GitHub Copilot': 30 },
		month: { 'GitHub Copilot': 35 }, lastMonth: { 'GitHub Copilot': 5 },
	}, [], { 'VS Code': 'gpt-5', 'Claude Code': 'claude-sonnet-4', 'Totally Unknown Editor': 'gpt-5' }));

	const h3 = Array.from(doc.querySelectorAll('h3')).find(h => (h.textContent ?? '').includes('Usage by Editor'));
	const rows = Array.from(h3?.closest('.section')?.querySelectorAll('table tbody tr') ?? []);
	const rowFor = (name: string) => rows.find(tr => (tr.querySelector('td')?.textContent ?? '').includes(name));

	const vscodeRow = rowFor('VS Code');
	assert.match(vscodeRow?.querySelector('img.editor-logo')?.getAttribute('src') ?? '', /^data:image\/svg\+xml/);
	assert.ok(rowFor('Claude Code')?.querySelector('img.editor-logo'));
	const unknown = rowFor('Totally Unknown Editor');
	assert.equal(unknown?.querySelector('img.editor-logo'), null);
	assert.ok(unknown?.querySelector('.editor-logo-emoji'), 'unknown editor keeps its emoji');
	assert.ok(doc.body.getAttribute('data-logo-theme'), 'logo theme marker is set for the dark/light variants');
});

test('header does not render the Copilot plan badge even when the host sends a plan', async () => {
	const doc = await renderDetails({
		...detailsData({
			today: { 'GitHub Copilot': 3 }, last30Days: { 'GitHub Copilot': 30 },
			month: { 'GitHub Copilot': 35 }, lastMonth: { 'GitHub Copilot': 5 },
		}, []),
		copilotPlan: { planId: 'individual_max', planName: 'individual_max', monthlyAiCreditsUsd: 0, monthlyPremiumRequests: null },
	});

	const headerLeft = doc.querySelector('.header-left');
	assert.ok(headerLeft, 'header should render');
	assert.equal(doc.querySelector('.plan-badge'), null);
	assert.doesNotMatch(headerLeft.textContent ?? '', /individual_max|credits/);
});
