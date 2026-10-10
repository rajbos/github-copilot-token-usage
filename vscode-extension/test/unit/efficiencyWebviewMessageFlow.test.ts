/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import type { ValueSignals } from '../../../src/efficiencyAnalysis';

/**
 * End-to-end message-flow and click tests for the Efficiency webview's Value tab.
 *
 * These bundle and execute the *real* `src/webview/efficiency/main.ts` in jsdom and drive it the
 * way the extension host does — two classes of bug that no unit test on either side can catch,
 * because each half is individually correct and only the hand-off breaks:
 *
 *  - The Value tab used to keep its "open Usage Analysis → Repository PRs" hint forever once the
 *    panel had been rendered before that data loaded (#1962): the host had no way to update it.
 *  - The empty state's "Open Repository PRs" button (#1963) is the shape of bug the contract
 *    checker cannot see: the host handler can exist and the markup can be perfect while nobody
 *    ever called `addEventListener` on the button.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'efficiency', 'main.ts');

let bundlePromise: Promise<string> | undefined;

/**
 * Chart.js is replaced by a no-op constructor: jsdom has no canvas, so the real library throws
 * on `getContext('2d')` and the trend charts are not what these tests are about. Everything else
 * — tab switching, the Value renderer, the host-message handler — is the shipped code.
 */
const stubChartPlugin: esbuild.Plugin = {
	name: 'stub-chartjs',
	setup(build) {
		build.onResolve({ filter: /^chart\.js\/auto$/ }, () => ({ path: 'chartjs-stub', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: 'export default class Chart { destroy() {} }',
			loader: 'js',
		}));
	},
};

function bundleEfficiencyWebview(): Promise<string> {
	bundlePromise ??= esbuild.build({
		entryPoints: [ENTRY],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		nodePaths: [path.join(EXT_ROOT, 'node_modules')],
		loader: { '.css': 'text' },
		plugins: [stubChartPlugin],
		logLevel: 'silent',
	}).then((result) => result.outputFiles[0].text);
	return bundlePromise;
}

/** A never-loaded Value snapshot: null PR counts are what renders the actionable hint. */
function neverLoadedValue(): ValueSignals {
	return {
		userPrs: null, mergedPrs: null, aiPrs: null, prsSince: null, prsPerWeek: null,
		costPerMergedPr: null, applyRate: 0.5, appliedBlocks: 20, totalBlocks: 40,
		locPerDollar: 400, linesChanged: 8000, periodCost: 20,
	};
}

/** The same period, after Repository PRs loaded for an authenticated user. */
function loadedValue(overrides: Partial<ValueSignals> = {}): ValueSignals {
	return {
		...neverLoadedValue(),
		userPrs: 18, mergedPrs: 14, aiPrs: 3, prsSince: '2026-02-14T00:00:00.000Z',
		prsPerWeek: 3.5, costPerMergedPr: 1.43,
		...overrides,
	};
}

/** The Value-tab strings the host sends; without them the webview falls back to its defaults. */
const VALUE_LOCALIZATION: Record<string, string> = {
	'efficiency.value.openRepositoryPrs': 'Open Repository PRs',
	'efficiency.value.prsHint': '💡 Connect GitHub and open {0} once to add pull-request metrics here.',
	'efficiency.value.prsHintDestination': 'Usage Analysis → Repository PRs',
	'__language__': 'en',
};

function buildEfficiencyData(value: ValueSignals, localization?: Record<string, string>): Record<string, unknown> {
	return {
		...(localization ? { localization } : {}),
		weekly: [{
			weekKey: '2026-03-02', label: 'Mar 2–8', sessions: 4, interactions: 40, tokens: 400_000,
			cost: 20, loc: 8000, costPerKloc: 2.5, tokensPerSession: 100_000, turnsPerSession: 10,
			activeMinutesPerSession: 22, retryRate: 0.1, applyRate: 0.5, locPerDollar: 400,
		}],
		hasLoc: true, hasDuration: true, hasRetry: true, hasApply: true,
		attribution: null,
		attributionWindows: { prev: 'previous 30 days', cur: 'last 30 days', prevRange: 'Feb 1–Mar 1, 2026', curRange: 'Mar 2–Mar 31, 2026' },
		deltas: [],
		deltaWindows: { prev: 'February 2026', cur: 'March 2026 (to date)' },
		value,
		skillTrends: { weeks: [], topSkills: [], totalCalls: 0 },
		skillImpact: [],
		hasSkills: false,
		modelDaily: [],
		hasModelComparison: false,
		cacheBreakage: null,
		lastUpdated: '2026-03-12T10:00:00.000Z',
		backendConfigured: false,
		compactNumbers: true,
		isDebugMode: false,
	};
}

interface Harness {
	window: any;
	posted: any[];
	settle: () => Promise<void>;
	/** Posts the way VS Code relays a host message: unidentifiable source, webview's own origin. */
	postFromHost: (message: Record<string, unknown>) => void;
	clickTab: (tab: string) => void;
	tabContent: () => any;
	tabText: () => string;
}

async function bootWebview(
	value: ValueSignals,
	options: { postBeforeSettle?: Record<string, unknown>; localization?: Record<string, string> } = {},
): Promise<Harness> {
	const bundle = await bundleEfficiencyWebview();
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
	window.__INITIAL_EFFICIENCY__ = buildEfficiencyData(value, options.localization);

	const postFromHost = (message: Record<string, unknown>): void => {
		const event = new window.MessageEvent('message', { data: message, origin: window.location.origin });
		Object.defineProperty(event, 'source', { value: {} });
		window.dispatchEvent(event);
	};

	window.eval(bundle);
	// Before any `await`: reproduces a PR result landing while the document is still rendering.
	if (options.postBeforeSettle) { postFromHost(options.postBeforeSettle); }

	const settle = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	};
	await settle();

	const tabContent = (): any => window.document.getElementById('eff-tab-content');
	return {
		window,
		posted,
		settle,
		postFromHost,
		clickTab: (tab) => {
			const btn = window.document.querySelector(`.eff-tab[data-tab="${tab}"]`);
			assert.ok(btn, `tab button "${tab}" exists`);
			btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		},
		tabContent,
		tabText: () => (tabContent()?.textContent ?? '').replace(/\s+/g, ' ').trim(),
	};
}

const HINT = 'Connect GitHub and open';

test('a Value update replaces the never-loaded hint without recreating the document', async () => {
	const harness = await bootWebview(neverLoadedValue());
	harness.clickTab('value');
	assert.match(harness.tabText(), new RegExp(HINT), 'starts on the actionable hint');
	assert.equal(harness.window.document.querySelectorAll('.value-card').length, 2, 'only the PR-independent cards');

	const root = harness.window.document.querySelector('.efficiency-root');
	const content = harness.tabContent();
	harness.postFromHost({ command: 'valueSignalsUpdated', value: loadedValue() });
	await harness.settle();

	const text = harness.tabText();
	assert.doesNotMatch(text, new RegExp(HINT), 'hint is gone');
	assert.match(text, /Merged PRs/);
	assert.match(text, /of 18 you opened/);
	assert.match(text, /3\.5\/week merged/);
	assert.equal(harness.window.document.querySelectorAll('.value-card').length, 5, 'the three PR cards were added');
	// A targeted fragment update: the root document and the tab container are the same nodes, so
	// the selected tab, the chart instances and every other tab's DOM survive.
	assert.equal(harness.window.document.querySelector('.efficiency-root'), root);
	assert.equal(harness.tabContent(), content);
	assert.equal(harness.window.document.querySelector('.eff-tab.active').dataset.tab, 'value');
});

test('a Value update arriving while another tab is active is retained for the next tab switch', async () => {
	const harness = await bootWebview(neverLoadedValue());
	const trendsContent = harness.tabContent().innerHTML;

	harness.postFromHost({ command: 'valueSignalsUpdated', value: loadedValue() });
	await harness.settle();
	assert.equal(harness.tabContent().innerHTML, trendsContent, 'the active Trends tab is untouched');

	harness.clickTab('value');
	assert.match(harness.tabText(), /Merged PRs/);
	assert.doesNotMatch(harness.tabText(), new RegExp(HINT));
});

test('a Value update delivered during initial rendering is not lost', async () => {
	// The host builds the view data asynchronously and replays the latest Value message once the
	// document announces readiness; a response mid-render must still land.
	const harness = await bootWebview(neverLoadedValue(), {
		postBeforeSettle: { command: 'valueSignalsUpdated', value: loadedValue() },
	});
	harness.clickTab('value');
	assert.match(harness.tabText(), /Merged PRs/);
	assert.doesNotMatch(harness.tabText(), new RegExp(HINT));
});

test('readiness is announced for replay, before and after the first render', async () => {
	const harness = await bootWebview(neverLoadedValue());
	const reasons = harness.posted.filter((m) => m.command === 'efficiencyWebviewReady').map((m) => m.reason);
	assert.deepEqual(reasons, ['listener-registered', 'content-rendered']);
});

test('a semantically identical Value update leaves the rendered DOM alone', async () => {
	const harness = await bootWebview(loadedValue());
	harness.clickTab('value');
	const firstCard = harness.window.document.querySelector('.value-card');

	harness.postFromHost({ command: 'valueSignalsUpdated', value: loadedValue() });
	await harness.settle();

	assert.equal(harness.window.document.querySelector('.value-card'), firstCard, 'no re-render');
});

test('an unauthenticated result turns populated cards back into the hint', async () => {
	const harness = await bootWebview(loadedValue());
	harness.clickTab('value');
	assert.match(harness.tabText(), /Merged PRs/);

	// Sign-out: the host derives null PR counts from an unauthenticated snapshot.
	harness.postFromHost({ command: 'valueSignalsUpdated', value: neverLoadedValue() });
	await harness.settle();

	assert.match(harness.tabText(), new RegExp(HINT));
	assert.doesNotMatch(harness.tabText(), /Merged PRs/);
});

test('an authenticated result with zero PRs renders zero metrics, not the hint', async () => {
	const harness = await bootWebview(neverLoadedValue());
	harness.clickTab('value');

	harness.postFromHost({
		command: 'valueSignalsUpdated',
		value: loadedValue({ userPrs: 0, mergedPrs: 0, aiPrs: 0, prsPerWeek: 0, costPerMergedPr: null }),
	});
	await harness.settle();

	const text = harness.tabText();
	assert.doesNotMatch(text, new RegExp(HINT), 'zero PRs is loaded data, not missing data');
	assert.match(text, /Merged PRs/);
	assert.match(text, /of 0 you opened/);
	assert.match(text, /Zero is expected when you drive AI locally/);
});

test('cloud-agent and malformed messages never touch the Value tab', async () => {
	const harness = await bootWebview(neverLoadedValue());
	harness.clickTab('value');
	const firstCard = harness.window.document.querySelector('.value-card');

	// Cloud agent task loads are a different data path: `aiPrs` counts bot-authored PRs, so a
	// cloud-agent snapshot must neither change the numbers nor trigger a Value refresh.
	harness.postFromHost({ command: 'agentSessionsLoaded', data: { authenticated: true, repos: [], totalTasks: 7 } });
	// A malformed payload must not replace real metrics with `undefined`s either.
	harness.postFromHost({ command: 'valueSignalsUpdated', value: { userPrs: 4 } });
	harness.postFromHost({ command: 'valueSignalsUpdated' });
	// An unparseable `prsSince` would render the PR window as "Invalid Date".
	harness.postFromHost({ command: 'valueSignalsUpdated', value: loadedValue({ prsSince: 'not-a-date' }) });
	await harness.settle();

	assert.equal(harness.window.document.querySelector('.value-card'), firstCard, 'no re-render');
	assert.match(harness.tabText(), new RegExp(HINT));
	assert.doesNotMatch(harness.tabText(), /Invalid Date/);
});

// ── Empty-state action (#1963) ─────────────────────────────────────────────────
// The hint names a destination; the button next to it is what actually gets the user there.

test('the Value empty state offers a working Open Repository PRs button', async () => {
	const harness = await bootWebview(neverLoadedValue(), { localization: VALUE_LOCALIZATION });
	harness.clickTab('value');
	await harness.settle();

	const hint = harness.window.document.querySelector('.value-hint-text');
	assert.equal(
		hint?.textContent.trim(),
		'💡 Connect GitHub and open Usage Analysis → Repository PRs once to add pull-request metrics here.',
		'the explanation comes from the localization payload, with the destination interpolated',
	);
	assert.equal(
		hint?.querySelector('b')?.textContent,
		'Usage Analysis → Repository PRs',
		'the destination stays emphasized rather than arriving as escaped markup',
	);

	const button = harness.window.document.getElementById('btn-open-repo-prs');
	assert.ok(button, 'expected the Open Repository PRs button in the Value tab empty state');
	assert.equal(button.textContent.trim(), 'Open Repository PRs', 'button carries the localized label');

	button.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));
	await harness.settle();

	const commands = harness.posted.map((m: any) => m.command);
	assert.ok(
		commands.includes('showUsageAnalysisRepoPrs'),
		`expected showUsageAnalysisRepoPrs to be posted, got: ${JSON.stringify(commands)}`,
	);
});

test('the empty-state action disappears once PR metrics are available', async () => {
	const harness = await bootWebview(loadedValue(), { localization: VALUE_LOCALIZATION });
	harness.clickTab('value');
	await harness.settle();

	assert.equal(
		harness.window.document.getElementById('btn-open-repo-prs'),
		null,
		'the empty-state action must not shadow the real PR cards',
	);
});

test('a Value update that fills the cards retires the empty-state action', async () => {
	// The two features meet here: #1962's live update has to take #1963's button away with the
	// hint it belongs to, and bring it back when a sign-out empties the cards again.
	const harness = await bootWebview(neverLoadedValue(), { localization: VALUE_LOCALIZATION });
	harness.clickTab('value');
	await harness.settle();
	assert.ok(harness.window.document.getElementById('btn-open-repo-prs'), 'starts on the empty state');

	harness.postFromHost({ command: 'valueSignalsUpdated', value: loadedValue() });
	await harness.settle();
	assert.equal(harness.window.document.getElementById('btn-open-repo-prs'), null, 'button goes with the hint');

	harness.postFromHost({ command: 'valueSignalsUpdated', value: neverLoadedValue() });
	await harness.settle();
	assert.ok(harness.window.document.getElementById('btn-open-repo-prs'), 'and returns on sign-out');
});
