/// <reference path="../../src/types/jsdom.d.ts" />
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

/**
 * Drives the *real* bundled Log Viewer (`src/webview/logviewer/main.ts`) in jsdom to check the
 * behaviour its shared data tables must keep: the tool pills filter the whole tool list (not just
 * the visible page), clicks inside rows keep working after a sort or page re-render, the steps
 * overview starts in chronological order, and a HydraFusion "jump to step" link reaches a step
 * on another page with its legs expanded — and they stay expanded through a re-sort.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'logviewer', 'main.ts');
const FIXTURE = path.join(EXT_ROOT, '..', '.github', 'skills', 'visual-view-diff', 'fixtures', 'logviewer.json');

let bundlePromise: Promise<string> | undefined;

function bundleLogViewer(): Promise<string> {
	bundlePromise ??= esbuild.build({
		entryPoints: [ENTRY],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		nodePaths: [path.join(EXT_ROOT, 'node_modules')],
		loader: { '.css': 'text' },
		logLevel: 'silent',
	}).then(result => result.outputFiles[0].text);
	return bundlePromise;
}

const TURN_COUNT = 12;
/** The step the single HydraFusion turn matches — on the overview's second page. */
const HYDRA_STEP = 11;

function minute(n: number): string {
	return new Date(Date.UTC(2026, 2, 14, 9, n, 0)).toISOString();
}

/**
 * The visual-diff fixture, stretched to 12 steps so the overview pages, with 12 tool calls in
 * step 1 (11 × read_file, then one grep_search that lands on the tool table's second page).
 */
function buildLogData(): Record<string, any> {
	const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
	const template = fixture.turns[0];
	const turns = Array.from({ length: TURN_COUNT }, (_, i) => ({
		...template,
		turnNumber: i + 1,
		timestamp: minute(i + 1),
		toolCalls: i === 0
			? [...Array.from({ length: 11 }, () => ({ toolName: 'read_file', arguments: 'a.ts' })), { toolName: 'grep_search', arguments: 'retry' }]
			: [],
	}));
	const hydraTurn = { ...fixture.hydraFusion.turns[0], startedAt: new Date(Date.parse(minute(HYDRA_STEP)) + 1_000).toISOString() };
	return {
		...fixture,
		turns,
		interactions: TURN_COUNT,
		hydraFusion: { ...fixture.hydraFusion, turns: [hydraTurn], totalTurns: 1 },
	};
}

interface Harness {
	window: any;
	document: Document;
	posted: any[];
	scrolledTo: string[];
	close: () => void;
}

async function bootLogViewer(): Promise<Harness> {
	const bundle = await bundleLogViewer();
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://example.org/',
	});
	const window = dom.window as any;
	const posted: any[] = [];
	window.acquireVsCodeApi = () => ({
		postMessage: (message: unknown) => { posted.push(message); },
		getState: () => undefined,
		setState: () => undefined,
	});
	// jsdom's ElementInternals is a stub; <vscode-button> calls setFormValue on it.
	window.HTMLElement.prototype.attachInternals = () => ({
		setFormValue() { /* no-op */ }, setValidity() { /* no-op */ }, form: null, states: new Set(), role: null,
	});
	const scrolledTo: string[] = [];
	window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
		scrolledTo.push(`${this.className.split(' ')[0]}:${this.getAttribute('data-turn')}`);
	};
	window.__INITIAL_LOGDATA__ = buildLogData();
	window.eval(bundle);
	for (let i = 0; i < 20; i++) { await new Promise(resolve => setImmediate(resolve)); }
	return { window, document: window.document, posted, scrolledTo, close: () => window.close() };
}

function click(element: Element | null | undefined): void {
	assert.ok(element, 'element to click should exist');
	(element as HTMLElement).click();
}

function toolRows(h: Harness): HTMLElement[] {
	return Array.from(h.document.querySelectorAll<HTMLElement>('#data-table-root-logviewer-tools-1 tr.tool-row'));
}

function overviewSteps(h: Harness): number[] {
	return Array.from(h.document.querySelectorAll<HTMLElement>('#data-table-root-logviewer-turns-overview tr.turns-overview-row:not(.turns-overview-child-row)'))
		.map(row => Number(row.getAttribute('data-turn')));
}

function legsRow(h: Harness, step: number): HTMLElement | null {
	return h.document.querySelector<HTMLElement>(`.turns-overview-legs-row[data-parent-turn="${step}"]`);
}

describe('Log Viewer tables (bundled webview in jsdom)', () => {
	test('renders every table through the shared data table', async () => {
		const h = await bootLogViewer();
		try {
			for (const id of ['logviewer-tools-1', 'logviewer-turns-overview', 'hydra-models', 'hydra-phases', 'hydra-turn-legs-0']) {
				assert.ok(h.document.getElementById(`data-table-root-${id}`), `${id} should be rendered`);
			}
			assert.equal(h.document.querySelectorAll('table:not(.data-table)').length, 0, 'no hand-rolled tables remain');
		} finally { h.close(); }
	});

	test('a tool pill filters the whole tool list, including calls on later pages, and a second click clears it', async () => {
		const h = await bootLogViewer();
		try {
			assert.equal(toolRows(h).length, 10, 'the tool table pages at 10 rows');
			const pill = h.document.querySelector('.tool-summary-item[data-tool-filter="grep_search"][data-turn="1"]');
			click(pill);
			const filtered = toolRows(h);
			assert.equal(filtered.length, 1);
			assert.equal(filtered[0].getAttribute('data-tool-name'), 'grep_search');
			assert.equal(filtered[0].querySelector('.tool-call-link')?.getAttribute('data-toolcall'), '11', 'keeps the call\'s original index');
			assert.ok(pill?.classList.contains('active'));
			assert.equal(h.document.querySelector<HTMLDetailsElement>('.turn-card[data-turn="1"] details.tool-calls-details')?.open, true);

			click(pill);
			assert.equal(toolRows(h).length, 10);
			assert.ok(!pill?.classList.contains('active'));
		} finally { h.close(); }
	});

	test('tool call links keep posting the right call after the table re-sorts', async () => {
		const h = await bootLogViewer();
		try {
			click(h.document.querySelector('[data-table-id="logviewer-tools-1"][data-table-sort="name"]'));
			const first = toolRows(h)[0];
			assert.equal(first.getAttribute('data-tool-name'), 'grep_search', 'sorted by name, grep_search comes first');
			click(first.querySelector('.tool-call-link'));
			click(first.querySelector('.tool-call-pretty'));
			// Posted from the jsdom realm: compare plain copies, not cross-realm objects.
			assert.deepEqual(JSON.parse(JSON.stringify(h.posted.slice(-2))), [
				{ command: 'revealToolCallSource', turnNumber: 1, toolCallIdx: 11 },
				{ command: 'showToolCallPretty', turnNumber: 1, toolCallIdx: 11 },
			]);
		} finally { h.close(); }
	});

	test('the steps overview starts in chronological order and its rows still jump to their turn after paging', async () => {
		const h = await bootLogViewer();
		try {
			assert.deepEqual(overviewSteps(h), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
			click(h.document.querySelector('[data-table-id="logviewer-turns-overview"][data-table-direction="next"]'));
			assert.deepEqual(overviewSteps(h), [11, 12]);
			click(h.document.querySelector('#data-table-root-logviewer-turns-overview tr.turns-overview-row[data-turn="12"] td:nth-child(2)'));
			assert.equal(h.scrolledTo[h.scrolledTo.length - 1], 'turn-card:12');
		} finally { h.close(); }
	});

	test('a HydraFusion jump-to-step link pages the overview to its step and expands the legs', async () => {
		const h = await bootLogViewer();
		try {
			assert.ok(!overviewSteps(h).includes(HYDRA_STEP), 'the step starts off-page');
			click(h.document.querySelector(`.hydra-jump-to-step[data-turn="${HYDRA_STEP}"]`));
			assert.ok(overviewSteps(h).includes(HYDRA_STEP));
			assert.equal(legsRow(h, HYDRA_STEP)?.style.display, '');
			assert.ok(h.document.getElementById(`data-table-root-logviewer-turns-overview-legs-${HYDRA_STEP}`), 'the overview embeds its own copy of the legs table');
			assert.equal(h.document.querySelector(`.turns-overview-leg-toggle[data-turn="${HYDRA_STEP}"]`)?.getAttribute('aria-expanded'), 'true');
			assert.equal(h.scrolledTo[h.scrolledTo.length - 1], `turns-overview-row:${HYDRA_STEP}`);
		} finally { h.close(); }
	});

	test('expanded legs stay expanded through a re-sort, and the toggle collapses them without jumping to the turn', async () => {
		const h = await bootLogViewer();
		try {
			click(h.document.querySelector(`.hydra-jump-to-step[data-turn="${HYDRA_STEP}"]`));
			const scrolls = h.scrolledTo.length;
			const sortByStep = (): void => click(h.document.querySelector('[data-table-id="logviewer-turns-overview"][data-table-sort="step"]'));
			sortByStep(); // ascending, back to page 1
			sortByStep(); // descending: 12, 11, …
			assert.deepEqual(overviewSteps(h).slice(0, 2), [12, HYDRA_STEP]);
			assert.equal(legsRow(h, HYDRA_STEP)?.style.display, '', 'the legs row moved with its step and stayed open');

			click(h.document.querySelector(`.turns-overview-leg-toggle[data-turn="${HYDRA_STEP}"]`));
			assert.equal(legsRow(h, HYDRA_STEP)?.style.display, 'none');
			assert.equal(h.scrolledTo.length, scrolls, 'toggling the legs does not jump to the turn card');
		} finally { h.close(); }
	});
});
