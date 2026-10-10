/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

/**
 * End-to-end message-flow tests for the Diagnostics webview (part of the Item 3 audit of the
 * other five webviews after PR #1919's shared-handler fix).
 *
 * The host sends `backendStorageInfoLoaded` *before* the slower `diagnosticDataLoaded` message
 * (see `sendBackendStorageInfoEarly` in extension.ts) specifically so the Backend Storage tab
 * can populate early. Because the webview's own `bootstrap()` awaits a dynamic import before it
 * builds the DOM (`renderLayout`), that early message can genuinely arrive before the layout —
 * and its containers — exist. These tests bundle and execute the *real*
 * `src/webview/diagnostics/main.ts` in jsdom to prove that an early arrival is captured (not
 * silently dropped) and is not subsequently discarded by the first full render.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'diagnostics', 'main.ts');

let bundlePromise: Promise<string> | undefined;

function bundleDiagnosticsWebview(): Promise<string> {
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
	}).then((result) => result.outputFiles[0].text);
	return bundlePromise;
}

function buildInitialData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		report: 'Diagnostic Report\n==================',
		sessionFiles: [],
		detailedSessionFiles: [],
		cacheInfo: { size: 0, sizeInMB: 0, lastUpdated: null, location: 'VS Code Global State', storagePath: null },
		backendStorageInfo: null,
		backendConfigured: false,
		isDebugMode: false,
		globalStateCounters: {
			openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false,
			unknownMcpDismissedVersion: '', efficiencyTabBannerDismissed: false,
		},
		githubAuth: { authenticated: false },
		sessionFolders: [],
		displaySettings: { showTokens: true, showCost: true, monthlyBudget: null },
		quotaEntitlements: null,
		toolCallStats: null,
		skillCallStats: null,
		skillCallsByEditor: null,
		skillDescriptions: {},
		toolFamilies: [],
		otelComparison: null,
		...overrides,
	};
}

function configuredBackendStorageInfo(): Record<string, unknown> {
	return {
		azure: {
			enabled: true, isConfigured: true, storageAccount: 'myuniquestorageaccount', subscriptionId: 'sub-1',
			resourceGroup: 'rg-1', aggTable: 'agg', eventsTable: 'events', authMode: 'entraId',
			sharingProfile: 'team', lastSyncTime: null, deviceCount: 1, sessionCount: 10, recordCount: 5,
		},
		teamServer: {
			enabled: false, isConfigured: false, endpointUrl: '', sharingProfile: 'team',
			lastSyncTime: null, fluencyLastSyncTime: null, sessionCount: 0,
		},
	};
}

interface Harness {
	window: any;
	posted: any[];
	post: (message: Record<string, unknown>) => void;
	postSync: (message: Record<string, unknown>) => void;
	text: (selector: string) => string | null;
	settle: () => Promise<void>;
}

/**
 * The locale every webview test renders under.
 *
 * A bare `toLocaleString()` resolves against the *realm's* default locale, and the realm here is
 * Node — so without this pin these tests would format numbers and dates using the host's Windows
 * regional format (`en-NL` on a Dutch machine → "2.000"). A real webview is a Chromium renderer,
 * whose locale comes from VS Code's display language and ignores the Windows regional format
 * entirely (`en-GB` on that same machine → "2,000"). Pinning keeps the tests deterministic
 * everywhere *and* keeps them describing what the shipped webview actually renders; English
 * locales agree on the comma thousands separator, so assertions on it are safe to hardcode.
 *
 * Dates are a different story: en-US renders 1/2/2026 where en-GB renders 02/01/2026. Assert on
 * formatted dates only if you accept this pinned locale as the contract.
 */
const WEBVIEW_TEST_LOCALE = 'en-US'; // No change needed, already correct

/**
 * Makes locale-less `toLocale*()` calls inside the jsdom realm resolve to {@link WEBVIEW_TEST_LOCALE}
 * instead of the host's locale. Must run before the bundle is evaluated.
 */
function pinRealmLocale(window: any): void {
	const pin = (proto: any, method: string): void => {
		const original = proto[method];
		proto[method] = function (this: unknown, locales?: unknown, options?: unknown) {
			return original.call(this, locales ?? WEBVIEW_TEST_LOCALE, options);
		};
	};
	pin(window.Number.prototype, 'toLocaleString');
	pin(window.Date.prototype, 'toLocaleString');
	pin(window.Date.prototype, 'toLocaleDateString');
	pin(window.Date.prototype, 'toLocaleTimeString');
}

/**
 * Boots the bundled webview in jsdom. `initialData` mirrors `window.__INITIAL_DIAGNOSTICS__`.
 * Unlike the usage-panel harness, this does NOT await settling before returning — callers that
 * need to dispatch a message *before* `bootstrap()`'s pending dynamic import resolves (i.e.
 * before `renderLayout` has run) must do so immediately, then call `settle()` themselves.
 */
function bootWebviewUnsettled(initialData: Record<string, unknown> | null, savedState?: Record<string, unknown>): Harness {
	const bundle = getSyncBundle();
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://example.org/',
	});
	const window = dom.window as any;
	pinRealmLocale(window); // No change needed, already called
	const posted: any[] = [];
	window.acquireVsCodeApi = () => ({
		postMessage: (message: unknown) => { posted.push(message); },
		getState: () => savedState,
		setState: () => undefined,
	});
	// jsdom's ElementInternals is a stub; <vscode-button> calls setFormValue on it.
	window.HTMLElement.prototype.attachInternals = () => ({
		setFormValue() { /* no-op */ }, setValidity() { /* no-op */ }, form: null, states: new Set(), role: null,
	});
	if (initialData) { window.__INITIAL_DIAGNOSTICS__ = initialData; }

	window.eval(bundle);

	const settle = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	};

	return {
		window,
		posted,
		settle,
		post: (message) => {
			const event = new window.MessageEvent('message', { data: message, origin: window.location.origin });
			Object.defineProperty(event, 'source', { value: {} });
			window.dispatchEvent(event);
		},
		// Alias kept distinct from `post` to make call sites self-documenting about intent:
		// dispatched synchronously, immediately after boot, before any await has run.
		postSync(message) {
			this.post(message);
		},
		text: (selector) => {
			const el = window.document.querySelector(selector);
			return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
		},
	};
}

/**
 * Reads one Share Card stat tile ("Sessions", "Interactions", …) by its label. The value and the
 * label live in sibling divs with no whitespace between them, so `harness.text()` would run them
 * together ("1Sessions"); going through the DOM keeps the assertion readable.
 */
function shareStat(harness: Harness, label: string): string | undefined {
	const tiles = Array.from(harness.window.document.querySelectorAll('#tab-share .share-stat')) as any[];
	const tile = tiles.find((t) => t.querySelector('.share-stat-label')?.textContent === label);
	return tile?.querySelector('.share-stat-value')?.textContent;
}

let syncBundle: string | undefined;
function getSyncBundle(): string {
	if (syncBundle === undefined) { throw new Error('Bundle not preloaded — call preloadBundle() first'); }
	return syncBundle;
}
async function preloadBundle(): Promise<void> {
	syncBundle ??= await bundleDiagnosticsWebview();
}

test('Backend Storage tab renders normally when no early message arrives', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ backendStorageInfo: configuredBackendStorageInfo() }));
	await harness.settle();

	const rendered = harness.text('#tab-backend');
	assert.ok(rendered?.includes('Configured & Enabled'), `expected configured status, got: ${rendered}`);
});

test('Backend Storage tab shows the loading placeholder until data arrives', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData());
	await harness.settle();

	const rendered = harness.text('#tab-backend');
	assert.ok(rendered?.includes('Loading backend storage status'), `expected placeholder, got: ${rendered}`);
});

test('a backendStorageInfoLoaded message delivered before the layout renders is not discarded by the first paint', async () => {
	// The host sends this message as early as possible (sendBackendStorageInfoEarly), racing the
	// webview's own bootstrap() which awaits a dynamic import before building any DOM. Dispatching
	// synchronously right after eval — before the pending import microtask resolves — reproduces
	// that race deterministically: renderLayout() has not run yet, so no #tab-backend exists.
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ backendStorageInfo: null }));

	assert.equal(harness.window.document.getElementById('tab-backend'), null, 'layout must not exist yet');
	harness.postSync({ command: 'backendStorageInfoLoaded', backendStorageInfo: configuredBackendStorageInfo(), githubAuth: { authenticated: true, username: 'octocat' } });

	await harness.settle();

	const rendered = harness.text('#tab-backend');
	assert.ok(
		rendered?.includes('Configured & Enabled'),
		`the early message's data must survive into the first paint, got: ${rendered}`,
	);
	assert.ok(
		!rendered?.includes('Loading backend storage status'),
		'the first paint must not silently fall back to the placeholder once real data already arrived',
	);
});

test('a githubAuth value from an early backendStorageInfoLoaded message also survives the first paint', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ backendStorageInfo: null, githubAuth: { authenticated: false } }));

	harness.postSync({
		command: 'backendStorageInfoLoaded',
		backendStorageInfo: configuredBackendStorageInfo(),
		githubAuth: { authenticated: true, username: 'octocat' },
	});
	await harness.settle();

	const rendered = harness.text('#tab-github');
	assert.ok(rendered?.includes('octocat'), `expected the authenticated GitHub user to render, got: ${rendered}`);
});

test('changing the Share Card period refreshes the card and keeps its controls interactive', async () => {
	await preloadBundle();
	const recent = new Date().toISOString();
	const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
	const session = (file: string, lastInteraction: string) => ({
		file,
		size: 100,
		modified: lastInteraction,
		interactions: 2,
		tokens: 1_000,
		contextReferences: {},
		firstInteraction: lastInteraction,
		lastInteraction,
		editorSource: 'VS Code',
	});
	const harness = bootWebviewUnsettled(buildInitialData({
		detailedSessionFiles: [session('recent.json', recent), session('old.json', old)],
	}));
	await harness.settle();

	const initialCard = harness.text('#tab-share');
	assert.ok(
		initialCard?.includes('Last 14 days · 1 editor detected'),
		`expected the default 14-day subtitle, got: ${initialCard}`,
	);
	assert.equal(shareStat(harness, 'Sessions'), '1', 'only the recent session falls inside the default period');

	const selector = harness.window.document.getElementById('share-card-period-select') as HTMLSelectElement;
	selector.value = 'allTime';
	selector.dispatchEvent(new harness.window.Event('change', { bubbles: true }));

	const refreshedCard = harness.text('#tab-share');
	assert.ok(
		refreshedCard?.includes('All time · 1 editor detected'),
		`expected the card to re-render for the new period, got: ${refreshedCard}`,
	);
	assert.equal(shareStat(harness, 'Sessions'), '2', 'the 60-day-old session joins the count once the period is All time');
	assert.equal(harness.window.document.querySelectorAll('#tab-share').length, 1);
	const refreshedSelector = harness.window.document.getElementById('share-card-period-select') as HTMLSelectElement;
	assert.equal(refreshedSelector.value, 'allTime');

	(harness.window.document.getElementById('btn-copy-share-summary') as HTMLButtonElement).click();
	assert.equal(harness.posted.at(-1)?.command, 'copyText');
	assert.match(harness.posted.at(-1)?.text, /2 sessions.*of all time/);
});

test('a backendStorageInfoLoaded message delivered before the layout renders is not discarded by the first paint', async () => {
	// The host sends this message as early as possible (sendBackendStorageInfoEarly), racing the
	// webview's own bootstrap() which awaits a dynamic import before building any DOM. Dispatching
	// synchronously right after eval — before the pending import microtask resolves — reproduces
	// that race deterministically: renderLayout() has not run yet, so no #tab-backend exists.
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ backendStorageInfo: null }));

	assert.equal(harness.window.document.getElementById('tab-backend'), null, 'layout must not exist yet');
	harness.postSync({ command: 'backendStorageInfoLoaded', backendStorageInfo: configuredBackendStorageInfo(), githubAuth: { authenticated: true, username: 'octocat' } });

	await harness.settle();

	const rendered = harness.text('#tab-backend');
	assert.ok(
		rendered?.includes('Configured & Enabled'),
		`the early message's data must survive into the first paint, got: ${rendered}`,
	);
	assert.ok(
		!rendered?.includes('Loading backend storage status'),
		'the first paint must not silently fall back to the placeholder once real data already arrived',
	);
});

test('Share Card setup is a no-op on the loading first paint, and does not abort the rest of the wiring', async () => {
	// renderShareCardTab() emits the period selector and share buttons only once session files
	// have loaded. On the loading first paint — which every panel open goes through — none of
	// the elements setupShareSummaryButtonHandler() wires exist yet. It must still return
	// cleanly: setupButtonHandlers() calls it mid-sequence, so anything thrown here would
	// silently leave every button wired after it — starting with btn-issue — dead for the
	// rest of the session. reRenderShareCard() wires them for real once the data arrives.
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ detailedSessionFiles: [] }));
	await harness.settle();

	const card = harness.text('#tab-share');
	assert.ok(card?.includes('Loading session files'), `expected the loading placeholder, got: ${card}`);
	assert.equal(
		harness.window.document.getElementById('share-card-period-select'),
		null,
		'the period selector must not exist while session files are still loading',
	);

	(harness.window.document.getElementById('btn-issue') as HTMLButtonElement).click();
	assert.equal(
		harness.posted.at(-1)?.command,
		'openIssue',
		'a button wired after setupShareSummaryButtonHandler must still be interactive',
	);
});

test('Diagnostics navigation and buttons remain interactive while session files are being analyzed', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ detailedSessionFiles: [] }));
	await harness.settle();

	harness.post({ command: 'sessionFilesLoadProgress', processed: 40, total: 500 });
	const doc = harness.window.document;
	assert.match(harness.text('#session-loading-subtext') ?? '', /40 \/ 500/);
	(doc.querySelector('.group-tab[data-group="settings"]') as HTMLButtonElement).click();
	assert.ok(doc.querySelector('.group-tab[data-group="settings"]')?.classList.contains('active'));
	(doc.getElementById('btn-issue') as HTMLButtonElement).click();
	assert.equal(harness.posted.at(-1)?.command, 'openIssue');
});

test('OTel Delta tab shows a detecting message while comparison data is still loading', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ otelComparison: undefined }));
	await harness.settle();

	const rendered = harness.text('#tab-otel-delta');
	assert.ok(rendered?.includes('OpenTelemetry Detection Running'), `expected detecting title, got: ${rendered}`);
	assert.ok(rendered?.includes('Detecting Copilot CLI OpenTelemetry export data'), `expected detecting body, got: ${rendered}`);
});

test('restoring the OTel Delta tab reveals the Research leaf bar and marks it active', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData(), { activeTab: 'otel-delta' });
	await harness.settle();

	const doc = harness.window.document;
	const researchGroupTab = doc.querySelector('.group-tab[data-group="research"]');
	const researchLeafBar = doc.querySelector('.leaf-tabs[data-group="research"]');
	const otelTabButton = doc.querySelector('.tab[data-tab="otel-delta"]');
	const otelTabContent = doc.getElementById('tab-otel-delta');

	assert.ok(researchGroupTab?.classList.contains('active'), 'expected the Research group tab to be active');
	assert.notEqual(researchLeafBar?.style.display, 'none', 'expected the Research leaf tab bar to be visible');
	assert.ok(otelTabButton?.classList.contains('active'), 'expected the OTel Delta tab button to be active');
	assert.ok(otelTabContent?.classList.contains('active'), 'expected the OTel Delta tab content to be active');
});

test('a switchTab message (e.g. the What\'s New "Take me there" action) navigates to the requested tab and group', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData());
	await harness.settle();

	harness.post({ command: 'switchTab', tab: 'otel-delta' });
	await harness.settle();

	const doc = harness.window.document;
	assert.ok(doc.querySelector('.group-tab[data-group="research"]')?.classList.contains('active'), 'expected the Research group tab to be active');
	assert.ok(doc.querySelector('.tab[data-tab="otel-delta"]')?.classList.contains('active'), 'expected the OTel Delta tab button to be active');
	assert.ok(doc.getElementById('tab-otel-delta')?.classList.contains('active'), 'expected the OTel Delta tab content to be active');
});

test('a switchTab message that arrives before the layout renders still lands on the requested tab', async () => {
	// Mirrors the backendStorageInfoLoaded early-arrival tests above: the message listener is
	// registered before renderLayout() runs (bootstrap() awaits a dynamic import first), so a
	// switchTab request — e.g. from the What's New "Take me there" action — can legitimately
	// arrive before any tab button exists yet.
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData());

	assert.equal(harness.window.document.getElementById('tab-otel-delta'), null, 'layout must not exist yet');
	harness.postSync({ command: 'switchTab', tab: 'otel-delta' });

	await harness.settle();

	const doc = harness.window.document;
	assert.ok(doc.querySelector('.group-tab[data-group="research"]')?.classList.contains('active'), 'expected the Research group tab to be active');
	assert.ok(doc.querySelector('.tab[data-tab="otel-delta"]')?.classList.contains('active'), 'expected the OTel Delta tab button to be active');
});

test('a switchTab message naming an unknown tab is ignored rather than breaking navigation', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData());
	await harness.settle();

	harness.post({ command: 'switchTab', tab: 'not-a-real-tab' });
	await harness.settle();

	const doc = harness.window.document;
	assert.ok(doc.querySelector('.tab[data-tab="report"]')?.classList.contains('active'), 'expected the default report tab to remain active');
});

// --- Shared data tables -------------------------------------------------------------------

function diagSession(file: string, hoursAgo: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const at = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
	return {
		file, size: 100, modified: at, interactions: 2, tokens: 1_000, contextReferences: {},
		firstInteraction: at, lastInteraction: at, editorSource: 'VS Code', title: file, ...overrides,
	};
}

function tableRows(harness: Harness, tableId: string): any[] {
	return Array.from(harness.window.document.querySelectorAll(`#data-table-root-${tableId} tbody tr`));
}

function cellTexts(harness: Harness, tableId: string, column: number): string[] {
	return tableRows(harness, tableId).map((row) => row.children[column]?.textContent.replace(/\s+/g, ' ').trim());
}

/** The last posted message, copied out of the jsdom realm so deepEqual compares plain objects. */
function lastPosted(harness: Harness): Record<string, unknown> {
	return { ...harness.posted.at(-1) };
}

function clickSort(harness: Harness, tableId: string, columnId: string): void {
	const button = harness.window.document.querySelector(`[data-table-id="${tableId}"][data-table-sort="${columnId}"]`);
	assert.ok(button, `expected a sort button for ${tableId}/${columnId}`);
	(button as HTMLButtonElement).click();
}

test('session table: newest first, children follow their parent in every sort order, and titles are escaped', async () => {
	await preloadBundle();
	const xssTitle = '<img src=x onerror=alert(1)>';
	const harness = bootWebviewUnsettled(buildInitialData({
		detailedSessionFiles: [
			diagSession('other.json', 2, { tokens: 1_000, title: xssTitle }),
			diagSession('child.json', 3, { tokens: 5_000, title: 'Child', parentInfo: { uuid: 'p', name: 'Parent', sessionFile: 'parent.json' } }),
			diagSession('parent.json', 1, { tokens: 100, title: 'Parent', childInfo: [{ uuid: 'c', name: 'Child', sessionFile: 'child.json' }], totalChildCount: 1 }),
		],
	}));
	await harness.settle();
	const tableId = 'diagnostics-sessions';

	const titles = () => tableRows(harness, tableId).map((row) => row.querySelector('a.session-file-link:not(.hierarchy-parent)')?.getAttribute('data-file'));
	assert.deepEqual(titles(), ['parent.json', 'child.json', 'other.json'], 'default order is newest first, child kept under its parent');
	assert.ok(tableRows(harness, tableId)[1].classList.contains('child-session-row'));
	assert.deepEqual(cellTexts(harness, tableId, 0), ['1', '2', '3']);

	clickSort(harness, tableId, 'tokens');
	assert.deepEqual(titles(), ['other.json', 'parent.json', 'child.json'], 'a child sorts with its parent, not by its own tokens');
	clickSort(harness, tableId, 'tokens');
	assert.deepEqual(titles(), ['parent.json', 'child.json', 'other.json']);

	const root = harness.window.document.getElementById(`data-table-root-${tableId}`);
	assert.equal(root.querySelector('img'), null, 'a session title must never become markup');
	assert.ok(root.textContent.includes(xssTitle));

	// Links keep working after the table re-rendered itself for the sort.
	(tableRows(harness, tableId)[0].querySelector('a.session-file-link') as HTMLAnchorElement).click();
	assert.deepEqual(lastPosted(harness), { command: 'openSessionFile', file: 'parent.json' });
	(tableRows(harness, tableId)[2].querySelector('a.view-formatted-link') as HTMLAnchorElement).click();
	assert.deepEqual(lastPosted(harness), { command: 'openFormattedJsonlFile', file: 'other.json' });
	(tableRows(harness, tableId)[1].querySelector('a.hierarchy-parent') as HTMLAnchorElement).click();
	assert.deepEqual(lastPosted(harness), { command: 'openSessionFile', file: 'parent.json' });
});

test('session table pages its rows and a filter change returns to the first page', async () => {
	await preloadBundle();
	const files = Array.from({ length: 12 }, (_, i) => diagSession(`s${i + 1}.json`, i + 1, { editorSource: i < 11 ? 'VS Code' : 'Cursor' }));
	const harness = bootWebviewUnsettled(buildInitialData({ detailedSessionFiles: files }));
	await harness.settle();
	const tableId = 'diagnostics-sessions';
	const doc = harness.window.document;

	assert.equal(tableRows(harness, tableId).length, 10);
	(doc.querySelector(`[data-table-id="${tableId}"][data-table-direction="next"]`) as HTMLButtonElement).click();
	assert.deepEqual(cellTexts(harness, tableId, 0), ['11', '12']);

	(doc.querySelector('.editor-panel[data-editor="VS Code"]') as HTMLElement).click();
	assert.equal(tableRows(harness, tableId).length, 10, 'filtering starts again at page 1');
	assert.match(doc.querySelector(`#data-table-root-${tableId} .data-table-page-info`)?.textContent ?? '', /1.*2/);
});

test('tool analysis tables sort by average tokens per call by default and escape tool names', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({
		toolCallStats: {
			total: 13,
			byTool: { read: 10, grep: 1, '<b>x</b>': 2 },
			outputTokensByTool: { read: 100, grep: 500, '<b>x</b>': 40 },
		},
	}));
	await harness.settle();
	const tableId = 'diagnostics-tool-other';
	const toolNames = () => tableRows(harness, tableId).map((row) => row.children[0].firstChild?.textContent.trim());

	assert.deepEqual(toolNames(), ['grep', '<b>x</b>', 'read'], 'default order is avg tokens / call, highest first');
	assert.equal(harness.window.document.querySelector(`#data-table-root-${tableId} td b`), null);

	clickSort(harness, tableId, 'calls');
	assert.deepEqual(toolNames(), ['read', '<b>x</b>', 'grep']);
	clickSort(harness, tableId, 'tool');
	clickSort(harness, tableId, 'tool');
	assert.deepEqual(toolNames(), ['read', 'grep', '<b>x</b>'], 'second click on Tool sorts descending');
});

test('session folders table: most sessions first, a total footer, and links that survive a re-sort', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({
		report: 'Report',
		sessionFolders: [
			{ dir: '/a', count: 2, editorName: 'VS Code' },
			{ dir: '/b<i>', count: 5 },
		],
	}));
	await harness.settle();
	const tableId = 'diagnostics-session-folders';
	const doc = harness.window.document;

	assert.deepEqual(cellTexts(harness, tableId, 0), ['/b<i>', '/a']);
	assert.equal(doc.querySelector(`#data-table-root-${tableId} tbody i`), null);
	assert.equal(doc.querySelector(`#data-table-root-${tableId} tfoot`)?.textContent.replace(/\s+/g, ''), 'Total:7');
	assert.ok(tableRows(harness, tableId)[0].querySelector('.report-editor-link'), 'an unknown editor folder can be reported');

	clickSort(harness, tableId, 'folder');
	assert.deepEqual(cellTexts(harness, tableId, 0), ['/a', '/b<i>']);
	(tableRows(harness, tableId)[1].querySelector('.reveal-link') as HTMLAnchorElement).click();
	assert.deepEqual(lastPosted(harness), { command: 'revealPath', path: '/b<i>' });
	(tableRows(harness, tableId)[1].querySelector('.report-editor-link') as HTMLAnchorElement).click();
	assert.deepEqual(lastPosted(harness), { command: 'reportNewEditorPath', path: '/b<i>' });
});

test('Azure configuration details render as an unpaged key/value table', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({ backendStorageInfo: configuredBackendStorageInfo() }));
	await harness.settle();
	const root = harness.window.document.getElementById('data-table-root-diagnostics-azure-config');

	assert.ok(root, 'expected the Azure configuration table');
	assert.equal(root.querySelector('thead'), null, 'key/value tables have no header row');
	assert.equal(root.querySelector('.data-table-pager, .data-table-summary'), null, 'key/value tables are not paged');
	const pairs = Array.from(root.querySelectorAll('tbody tr')).map((row: any) => [row.querySelector('th[scope="row"]')?.textContent, row.querySelector('td')?.textContent]);
	assert.deepEqual(pairs[0], ['Storage Account', 'myuniquestorageaccount']);
	assert.equal(pairs.length, 5);
});

test('skill usage table lists the most-invoked skills first', async () => {
	await preloadBundle();
	const harness = bootWebviewUnsettled(buildInitialData({
		skillCallStats: { total: 6, byName: { alpha: 1, beta: 5 } },
		skillDescriptions: { beta: 'Beta skill' },
	}));
	await harness.settle();

	assert.deepEqual(cellTexts(harness, 'diagnostics-skill-usage', 0), ['beta', 'alpha']);
	assert.deepEqual(cellTexts(harness, 'diagnostics-skill-usage', 1), ['Beta skill', '—']);
});