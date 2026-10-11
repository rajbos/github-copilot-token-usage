/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

/**
 * End-to-end message-flow tests for the Usage Analysis webview.
 *
 * These bundle and execute the *real* `src/webview/usage/main.ts` in jsdom and drive it the way
 * the extension host does. The "Repository PRs" / "Cloud Agent" tabs previously sat on "Loading…"
 * forever even though the host had fetched and posted the data — a class of bug no unit test on
 * either side could catch, because each half was individually correct and only the hand-off broke.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'usage', 'main.ts');

let bundlePromise: Promise<string> | undefined;

function bundleUsageWebview(): Promise<string> {
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

function emptyPeriod(): Record<string, unknown> {
	return {
		sessions: 1,
		modeUsage: {},
		contextReferences: { total: 0, byKind: {}, byPath: {} },
		toolCalls: { total: 0, byTool: {} },
		mcpTools: { total: 0, byServer: {}, byTool: {} },
		modelSwitching: {
			modelsPerSession: [], totalSessions: 0, averageModelsPerSession: 0, maxModelsPerSession: 0,
			minModelsPerSession: 0, switchingFrequency: 0, standardModels: [], premiumModels: [],
			unknownModels: [], mixedTierSessions: 0, lowCostModels: [], mediumCostModels: [],
			highCostModels: [], mixedCostSessions: 0, standardRequests: 0, premiumRequests: 0,
			lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0, unknownRequests: 0, totalRequests: 0,
		},
	};
}

function emptyModelEfficiencyCounters(calls: number): Record<string, unknown> {
	return {
		calls, toolCalls: 0, editTurns: 0, oneShotEditTurns: 0, retries: 0, selfCorrections: 0,
		editToolCalls: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cost: 0,
	};
}

/** Local usage counts mirroring a real long-tail leaderboard: a clear cliff after the 4th model. */
function longTailModelEfficiency(): Record<string, unknown> {
	const counts: Record<string, number> = {
		kimi: 309, sol: 144, sonnet5: 120, opus5: 82,
		unknown: 20, hydrafusion: 16, mistralMedium: 14, sonnet46: 12, terra: 12, maiCode: 11,
	};
	return Object.fromEntries(Object.entries(counts).map(([model, calls]) => [model, emptyModelEfficiencyCounters(calls)]));
}

function buildStats(): Record<string, unknown> {
	return {
		today: emptyPeriod(),
		last30Days: emptyPeriod(),
		month: emptyPeriod(),
		lastMonth: emptyPeriod(),
		locale: 'en-US',
		customizationMatrix: null,
		missedPotential: [],
		todaySessions: [],
		lastUpdated: new Date().toISOString(),
		backendConfigured: false,
		currentWorkspacePaths: [],
		insights: [],
	};
}

/** `buildStats()` with a long-tail "Most used models locally" dataset for `last30Days`. */
function buildStatsWithLongTailModelEfficiency(): Record<string, unknown> {
	const stats = buildStats();
	stats.last30Days = { ...(stats.last30Days as Record<string, unknown>), modelEfficiency: longTailModelEfficiency() };
	return stats;
}

/**
 * `buildStats()` with a Workspace Health customization matrix mirroring a real long-tail
 * distribution: 5 heavily-used workspaces (110-60 sessions) followed by 5 workspaces with
 * only 1-2 sessions each — the "clear cliff" `computeWorkspaceHealthGrouping()` should detect.
 */
function buildStatsWithLongTailWorkspaces(): Record<string, unknown> {
	const stats = buildStats();
	const majorSessionCounts = [110, 90, 80, 70, 60];
	const tailSessionCounts = [2, 2, 1, 1, 1];
	const workspaces = [...majorSessionCounts, ...tailSessionCounts].map((sessionCount, index) => ({
		workspacePath: `/repos/repo-${index + 1}`,
		workspaceName: `repo-${index + 1}`,
		sessionCount,
		interactionCount: sessionCount * 10,
		typeStatuses: {},
	}));
	stats.customizationMatrix = {
		customizationTypes: [],
		workspaces,
		totalWorkspaces: workspaces.length,
		workspacesWithIssues: 0,
	};
	return stats;
}

function buildStatsWithCorrections(): Record<string, unknown> {
	return {
		...buildStats(),
		correctionReport: {
			sessionsPerRepo: 25,
			sessionsWithMoments: 1,
			counts: {
				userCorrections: 1, editRetries: 0, editSelfCorrections: 0,
				toolErrors: 1, toolErrorsRetried: 1, agentSelfCorrections: 0,
			},
			repos: [{
				repository: 'acme/web-app',
				sessionsWithMoments: 1,
				counts: {
					userCorrections: 1, editRetries: 0, editSelfCorrections: 0,
					toolErrors: 1, toolErrorsRetried: 1, agentSelfCorrections: 0,
				},
				sessions: [{
					file: '/sessions/example.jsonl',
					title: 'Correcting the build',
					moments: [
						{ type: 'user-correction', turnNumber: 2, timestamp: '2026-08-01T12:00:00.000Z', snippet: 'No, use the existing endpoint.', matchedPattern: 'no' },
						{ type: 'tool-error', turnNumber: 3, timestamp: '2026-08-01T12:01:00.000Z', snippet: 'Tool failed: edit', tool: 'edit', retried: true },
					],
				}],
			}],
		},
	};
}

/** Same report, but with one escalating user correction so the 📈 filter pill renders. */
function buildStatsWithEscalatingCorrection(): Record<string, unknown> {
	const stats = buildStatsWithCorrections() as any;
	stats.correctionReport.counts.escalatedUserCorrections = 1;
	stats.correctionReport.repos[0].counts.escalatedUserCorrections = 1;
	stats.correctionReport.repos[0].sessions[0].moments[0].escalated = true;
	return stats;
}

/**
 * `buildStats()` with a handful of insights so the Insights tab renders real cards. Mirrors what
 * the host sends: a couple of 'new' ones in "For You" plus one already-seen tip in "All Tips".
 */
function buildStatsWithInsights(): Record<string, unknown> {
	const stats = buildStats();
	stats.insights = [
		{ id: 'missing-instructions', category: 'workspace', severity: 'opportunity', title: 'No instructions file', body: 'Add one.', status: 'new', allowToast: true },
		{ id: 'marathon-session-today', category: 'hygiene', severity: 'tip', title: 'Marathon session today', body: 'Consider a fresh session.', status: 'new', allowToast: true },
		{ id: 'stale-skills', category: 'tools', severity: 'tip', title: 'Stale skills', body: 'Some skills are unused.', status: 'seen', allowToast: false },
	];
	return stats;
}

interface Harness {
	window: any;
	posted: any[];
	/** DOM ids of every element the webview called scrollIntoView() on, in order. */
	scrolledTo: string[];
	post: (message: Record<string, unknown>) => void;
	postFromHostFrame: (message: Record<string, unknown>) => void;
	postFromForeignOrigin: (message: Record<string, unknown>) => void;
	text: (selector: string) => string | null;
	settle: () => Promise<void>;
	/** Waits out the webview's deferred scroll (scrollToPendingTabAnchor defers by 50ms). */
	settleScroll: () => Promise<void>;
}

/**
 * Boots the bundled webview in jsdom. `initialData` mirrors `window.__INITIAL_USAGE__`.
 *
 * `duringBootstrap` is dispatched immediately after the bundle is evaluated and
 * before anything is awaited — i.e. while `bootstrap()` is still suspended on its
 * dynamic import, which is exactly when the extension host's pending messages
 * arrive in practice.
 */
async function bootWebview(
	initialData: Record<string, unknown> | null,
	duringBootstrap?: Record<string, unknown>,
): Promise<Harness> {
	const bundle = await bundleUsageWebview();
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
	// jsdom does not implement scrollIntoView; record the target so tests can assert *where*
	// the webview scrolled, not merely that it rendered the right tab.
	const scrolledTo: string[] = [];
	window.HTMLElement.prototype.scrollIntoView = function (this: any) { scrolledTo.push(this.id ?? ''); };
	if (initialData) { window.__INITIAL_USAGE__ = initialData; }

	window.eval(bundle);

	if (duringBootstrap) {
		const event = new window.MessageEvent('message', { data: duringBootstrap });
		Object.defineProperty(event, 'source', { value: null });
		window.dispatchEvent(event);
	}

	const settle = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	};
	await settle();

	return {
		window,
		posted,
		scrolledTo,
		settle,
		settleScroll: async (): Promise<void> => {
			await new Promise((resolve) => setTimeout(resolve, 80));
			await settle();
		},
		post: (message) => {
			const event = new window.MessageEvent('message', { data: message });
			Object.defineProperty(event, 'source', { value: null });
			window.dispatchEvent(event);
		},
		postFromHostFrame: (message: Record<string, unknown>) => {
			// Reproduces VS Code's real relay: an unidentifiable window object stamped with the
			// webview's own origin. Identity comparison against window/parent/top fails here.
			const event = new window.MessageEvent('message', { data: message, origin: window.location.origin });
			Object.defineProperty(event, 'source', { value: {} });
			window.dispatchEvent(event);
		},
		postFromForeignOrigin: (message: Record<string, unknown>) => {
			const event = new window.MessageEvent('message', { data: message, origin: 'https://evil.example' });
			Object.defineProperty(event, 'source', { value: {} });
			window.dispatchEvent(event);
		},
		text: (selector) => {
			const el = window.document.querySelector(selector);
			return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
		},
	};
}

function repoPrPayload(): Record<string, unknown> {
	return {
		authenticated: true,
		since: new Date('2026-08-01T00:00:00Z').toISOString(),
		repos: [
			{ owner: 'rajbos', repo: 'ai-engineering-fluency', repoUrl: 'https://github.com/rajbos/ai-engineering-fluency', totalPrs: 99, aiAuthoredPrs: 7, aiReviewRequestedPrs: 3, userAuthoredPrs: 40, userMergedPrs: 38, aiDetails: [] },
			{ owner: 'xebia', repo: 'xms-techradar', repoUrl: 'https://github.com/xebia/xms-techradar', totalPrs: 0, aiAuthoredPrs: 0, aiReviewRequestedPrs: 0, userAuthoredPrs: 0, userMergedPrs: 0, aiDetails: [], error: 'Repo not found or not accessible with current token' },
		],
	};
}

test('announces readiness both at listener registration and after the layout renders', async () => {
	const harness = await bootWebview(buildStats());
	const ready = harness.posted.filter((m) => m.command === 'usageWebviewReady');

	assert.ok(
		ready.some((m) => m.reason === 'listener-registered'),
		'must announce readiness as soon as the message listener exists',
	);
	const afterLayout = ready.find((m) => m.reason === 'layout-rendered');
	assert.ok(afterLayout, 'must re-announce readiness once the layout (and its containers) exists');
	assert.equal(afterLayout.hasGitHubActivityContainers, true);
});

test('renders repository PR results delivered after the layout exists', async () => {
	const harness = await bootWebview(buildStats());

	harness.post({ command: 'repoPrStatsLoaded', data: repoPrPayload() });

	const rendered = harness.text('#repos-pr-content');
	assert.ok(rendered?.includes('ai-engineering-fluency'), `expected the repo table, got: ${rendered}`);
	assert.ok(rendered?.includes('99'), 'expected the PR count in the rendered table');
	assert.ok(
		!rendered?.includes('sign in with GitHub'),
		'the placeholder must be replaced, not left in place',
	);
});

test('a host refresh of the Repository PRs panel keeps a pending or answered CCR check', async () => {
	const harness = await bootWebview(buildStats());
	const payload = (): Record<string, unknown> => {
		const data = repoPrPayload();
		(data.repos as Array<Record<string, unknown>>)[0].aiDetails = [
			{ number: 42, title: 'Add tables', url: 'https://github.com/rajbos/ai-engineering-fluency/pull/42', aiType: 'copilot', role: 'reviewer-requested' },
		];
		return data;
	};
	harness.post({ command: 'repoPrStatsLoaded', data: payload() });
	const doc = harness.window.document;
	const button = (): any => doc.querySelector('.btn-check-ccr[data-pr="42"]');
	const result = (): string => doc.querySelector('[data-ccr-result="rajbos/ai-engineering-fluency#42"]')?.textContent ?? '';
	assert.ok(button(), 'expects a CCR check button for the reviewer-requested Copilot PR');

	button().click();
	const requests = (): number => harness.posted.filter((m) => m.command === 'checkCcrActivity').length;
	assert.equal(requests(), 1);
	const checking = result();
	assert.ok(checking.length > 0, 'shows a checking state while the lookup runs');

	// Host refresh while the lookup is pending: the rebuilt button stays disabled.
	harness.post({ command: 'repoPrStatsLoaded', data: payload() });
	assert.equal(button().hasAttribute('disabled'), true, 'a pending check must not be submittable twice');
	assert.equal(result(), checking);

	harness.post({ command: 'ccrActivityResult', owner: 'rajbos', repo: 'ai-engineering-fluency', prNumber: 42, reviews: [], requests: [] });
	const answered = result();
	assert.ok(answered.length > 0 && answered !== checking);

	// Host refresh after the answer: the result is still shown.
	harness.post({ command: 'repoPrStatsLoaded', data: payload() });
	assert.equal(result(), answered);
	assert.equal(button().hasAttribute('disabled'), false);
});

test('repository PR results delivered before any layout exists still reach the panel', async () => {
	// The webview announces readiness at module-evaluation time, so the host replays buffered
	// state into a DOM that has no `#repos-pr-content` yet. Without a re-announce + restore
	// after renderLayout, that state is silently dropped and the tab hangs on "Loading…".
	const harness = await bootWebview(null);
	assert.equal(harness.window.document.querySelector('#repos-pr-content'), null);

	harness.post({ command: 'repoPrStatsLoaded', data: repoPrPayload() });
	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	const rendered = harness.text('#repos-pr-content');
	assert.ok(rendered?.includes('ai-engineering-fluency'), `expected the repo table, got: ${rendered}`);
});

test('a switchTab to Repository PRs that lands before the layout still starts the PR fetch', async () => {
	// The Efficiency view's "Open Repository PRs" action can reach a panel that is still in its
	// loading state. `handleSwitchTab` then has no tab button to click, so only the persisted
	// activeTab survives — and without an explicit kick at render time the tab would sit on
	// "Loading…" forever because nothing ever asks the host for the PR statistics.
	const harness = await bootWebview(null);
	assert.equal(harness.window.document.querySelector('.tab-button[data-tab="repos"]'), null);

	harness.post({ command: 'switchTab', tab: 'repos' });
	assert.ok(
		!harness.posted.some((m) => m.command === 'loadRepoPrStats'),
		'nothing to fetch into yet — the request belongs to the render, not the switch',
	);

	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	assert.equal(
		harness.posted.filter((m) => m.command === 'loadRepoPrStats').length,
		1,
		'the rendered layout must ask for the PR statistics exactly once',
	);
	const reposPanel = harness.window.document.querySelector('#tab-panel-repos');
	assert.notEqual(reposPanel?.style.display, 'none', 'the Repository PRs tab must be the visible one');
});

test('a stats refresh does not re-fire the active tab\'s lazy fetch', async () => {
	const harness = await bootWebview(buildStats());
	harness.post({ command: 'switchTab', tab: 'repos' });
	await harness.settle();
	assert.equal(harness.posted.filter((m) => m.command === 'loadRepoPrStats').length, 1);

	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	assert.equal(
		harness.posted.filter((m) => m.command === 'loadRepoPrStats').length,
		1,
		're-rendering the layout must not repeat a fetch the user never asked for again',
	);
});

test('a switchTab to Repository PRs during a refresh still starts the PR fetch', async () => {
	// `usageRefreshing` swaps the whole root for the loading card, so the tab bar is gone again
	// even though a layout rendered earlier. A guard that only ever fires once per webview would
	// skip this second layout and leave the tab on its placeholder with no fetch in flight.
	const harness = await bootWebview(buildStats());
	harness.post({ command: 'usageRefreshing' });
	await harness.settle();
	assert.equal(harness.window.document.querySelector('.tab-button[data-tab="repos"]'), null);

	harness.post({ command: 'switchTab', tab: 'repos' });
	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	assert.equal(
		harness.posted.filter((m) => m.command === 'loadRepoPrStats').length,
		1,
		'the layout rebuilt after the loading state must ask for the PR statistics',
	);
});

test('AI Readiness scans only on tab visit, refreshes on demand, and survives a layout rebuild', async () => {
	const stats = { ...buildStats(), readinessAvailable: true };
	const harness = await bootWebview(stats);
	assert.ok(harness.window.document.querySelector('.tab-button[data-tab="readiness"]'));
	assert.ok(!harness.posted.some((m) => m.command === 'loadReadiness'));

	harness.post({ command: 'switchTab', tab: 'readiness' });
	await harness.settle();
	assert.equal(harness.posted.filter((m) => m.command === 'loadReadiness').length, 1);
	assert.equal(harness.posted.find((m) => m.command === 'loadReadiness').requestId, 1);
	const report = { scannedAt: '2026-03-14T09:30:00.000Z', apiSignalsIncluded: false, maxAssessableStage: 4, repos: [], skippedRepoCount: 0 };
	harness.post({ command: 'readinessLoaded', requestId: 1, report });
	await harness.settle();
	assert.match(harness.text('#readiness-content')!, /No git repositories were found/);

	harness.post({ command: 'updateStats', data: stats });
	await harness.settle();
	assert.match(harness.text('#readiness-content')!, /No git repositories were found/);
	assert.equal(harness.posted.filter((m) => m.command === 'loadReadiness').length, 1);

	(harness.window.document.querySelector('#btn-refresh-readiness') as HTMLButtonElement).click();
	assert.equal(harness.posted.filter((m) => m.command === 'loadReadiness').at(-1)?.requestId, 2);
	harness.post({ command: 'readinessLoaded', requestId: 1, report });
	await harness.settle();
	// A forced refresh keeps the current report on screen and says it is refreshing.
	assert.equal(harness.posted.filter((m) => m.command === 'loadReadiness').at(-1)?.force, true);
	assert.match(harness.text('#readiness-content')!, /Showing the last scan while a fresh one runs/);
	assert.match(harness.text('#readiness-content')!, /No git repositories were found/);
	// A failed refresh must not throw away the report that is still on screen.
	harness.post({ command: 'readinessScanFailed', requestId: 2 });
	await harness.settle();
	assert.match(harness.text('#readiness-content')!, /No git repositories were found/);
	assert.doesNotMatch(harness.text('#readiness-content')!, /Could not scan repository readiness/);
});

test('AI Readiness deep link waits for stats and ignores responses from before a full refresh', async () => {
	const harness = await bootWebview(null);
	harness.post({ command: 'switchTab', tab: 'readiness' });
	harness.post({ command: 'updateStats', data: { ...buildStats(), readinessAvailable: true } });
	await harness.settle();
	assert.notEqual(harness.window.document.querySelector('#tab-panel-readiness')?.style.display, 'none');
	assert.equal(harness.posted.filter((m) => m.command === 'loadReadiness').length, 1);

	harness.post({ command: 'usageRefreshing' });
	harness.post({ command: 'updateStats', data: { ...buildStats(), readinessAvailable: true } });
	await harness.settle();
	assert.equal(harness.posted.filter((m) => m.command === 'loadReadiness').at(-1)?.requestId, 3);
	harness.post({ command: 'readinessLoaded', requestId: 1, report: { repos: [] } });
	await harness.settle();
	assert.match(harness.text('#readiness-content')!, /Scanning repository controls/);
});

test('a layout re-render repopulates the GitHub activity panels from retained state', async () => {
	// Any stats refresh rebuilds the whole root, recreating the "Loading…" placeholders. The
	// already-received PR data must be re-applied instead of being visually lost.
	const harness = await bootWebview(buildStats());
	harness.post({ command: 'repoPrStatsLoaded', data: repoPrPayload() });

	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	const rendered = harness.text('#repos-pr-content');
	assert.ok(rendered?.includes('ai-engineering-fluency'), `expected the repo table after re-render, got: ${rendered}`);
});

test('tells the host when a payload arrived but could not be rendered', async () => {
	// A payload that lands in a DOM with no container renders nothing, which from the outside
	// is indistinguishable from one that never arrived. The webview must say so. On success it
	// stays quiet — the rendered panel is its own evidence.
	const withoutLayout = await bootWebview(null);
	withoutLayout.posted.length = 0;
	withoutLayout.post({ command: 'repoPrStatsLoaded', data: repoPrPayload() });

	const trace = withoutLayout.posted.find(
		(m) => m.command === 'usageWebviewTrace' && m.stage === 'repoPrStatsLoaded.notRendered',
	);
	assert.ok(trace, 'the host must be told when a delivered payload rendered nothing');
	assert.equal(trace.details.repos, 2);

	const withLayout = await bootWebview(buildStats());
	withLayout.posted.length = 0;
	withLayout.post({ command: 'repoPrStatsLoaded', data: repoPrPayload() });
	assert.ok(
		!withLayout.posted.some((m) => m.command === 'usageWebviewTrace' && String(m.stage).startsWith('repoPrStatsLoaded')),
		'a successful render must not log anything',
	);
});

test('a rejected message is reported to the host instead of vanishing', async () => {
	// The trust check silently dropping real messages is what made every panel hang. If the
	// trust model ever breaks again, the drop must show up in the Output channel.
	const harness = await bootWebview(buildStats());
	harness.posted.length = 0;

	harness.postFromForeignOrigin({ command: 'repoPrStatsLoaded', data: repoPrPayload() });

	const trace = harness.posted.find(
		(m) => m.command === 'usageWebviewTrace' && m.stage === 'message-rejected-untrusted',
	);
	assert.ok(trace, 'a dropped message must be traced back to the host');
	assert.equal(trace.details.command, 'repoPrStatsLoaded');
	assert.ok(
		!harness.text('#repos-pr-content')?.includes('ai-engineering-fluency'),
		'a foreign-origin message must still not be rendered',
	);
});

test('renders repository PR fetch progress into the panel', async () => {
	const harness = await bootWebview(buildStats());

	harness.post({ command: 'repoPrStatsProgress', total: 2, done: 1 });

	const rendered = harness.text('#repos-pr-content');
	assert.ok(rendered?.includes('1/2'), `expected fetch progress, got: ${rendered}`);
});

test('renders the cleanup log with the worktree path for failing entries', async () => {
	const harness = await bootWebview(buildStats());
	const worktreePath = 'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo\\feature-x';

	harness.post({
		command: 'worktreeFound',
		worktree: {
			path: worktreePath,
			repoLabel: 'repo',
			branch: 'feature-x',
			lastCommit: 'abc1234',
			lastCommitDate: '2026-09-07T10:00:00.000Z',
			pushed: 'yes',
			files: 1,
			folders: 1,
			bytes: 1024,
		},
	});
	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult',
		path: worktreePath,
		branch: 'feature-x',
		repoLabel: 'repo',
		status: 'error',
		reason: `Could not safely locate the main repository for "${worktreePath}".`,
		processed: 1,
		total: 1,
	});
	harness.post({ command: 'cleanupComplete' });

	const rendered = harness.text('.worktree-cleanup-log');
	assert.ok(rendered?.includes(worktreePath), `expected the worktree path in the cleanup log, got: ${rendered}`);
	assert.ok(rendered?.includes('Could not safely locate the main repository'), 'expected the cleanup reason to stay visible');
});

test('a blocked cleanup entry shows remediation details and actionable buttons', async () => {
	// A bare "Has uncommitted or untracked changes." gives the user nothing to act on. The row
	// has to say how stale the worktree is, whether the branch still exists on the remote, and
	// whether it is pushed — and offer a way to go fix it.
	const harness = await bootWebview(buildStats());
	const worktreePath = 'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo\\stale-branch';

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult',
		path: worktreePath,
		branch: 'stale-branch',
		repoLabel: 'repo',
		status: 'skipped',
		reason: 'Has uncommitted or untracked changes.',
		diagnostics: {
			lastModified: '2026-09-01T08:30:00.000Z',
			lastCommitDate: '2026-08-20T09:00:00.000Z',
			lastCommitRelative: '3 weeks ago',
			remoteBranch: 'origin/stale-branch',
			remoteStatus: 'gone',
			ahead: 2,
			behind: 5,
			modifiedFiles: 3,
			untrackedFiles: 1,
		},
		processed: 1,
		total: 1,
	});
	harness.post({ command: 'cleanupComplete' });

	const rendered = harness.text('.worktree-cleanup-log');
	assert.ok(rendered?.includes('Last updated:'), `expected a last-updated chip, got: ${rendered}`);
	assert.ok(rendered?.includes('Last commit: 3 weeks ago'), 'expected the relative last-commit age');
	assert.ok(rendered?.includes('origin/stale-branch'), 'expected the remote branch name');
	assert.ok(rendered?.includes('(gone)'), 'a deleted upstream branch must be called out');
	assert.ok(rendered?.includes('2 ahead') && rendered?.includes('5 behind'), 'expected the ahead/behind push status');
	assert.ok(rendered?.includes('3 modified') && rendered?.includes('1 untracked'), 'expected the dirty-file counts');
	assert.ok(rendered?.includes('Open in VS Code'), 'expected an open-in-VS-Code remediation button');
});

test('a synced, never-dirty entry reports "up to date" rather than counts', async () => {
	const harness = await bootWebview(buildStats());

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult',
		path: 'C:\\wt\\clean',
		branch: 'clean',
		repoLabel: 'repo',
		status: 'error',
		reason: 'Could not delete worktree.',
		diagnostics: { remoteBranch: 'origin/clean', remoteStatus: 'tracked', ahead: 0, behind: 0, modifiedFiles: 0, untrackedFiles: 0 },
		processed: 1,
		total: 1,
	});
	harness.post({ command: 'cleanupComplete' });

	const rendered = harness.text('.worktree-cleanup-log');
	assert.ok(rendered?.includes('Push status: up to date'), `expected an up-to-date push status, got: ${rendered}`);
	assert.ok(rendered?.includes('Changes: clean'), 'a clean tree must say so instead of showing zero counts');
	assert.ok(!rendered?.includes('(gone)'), 'an existing upstream branch must not be marked gone');
});

test('a branch that was never pushed is flagged as having no remote', async () => {
	const harness = await bootWebview(buildStats());

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult',
		path: 'C:\\wt\\local-only',
		branch: 'local-only',
		repoLabel: 'repo',
		status: 'skipped',
		reason: 'Worktree has commits not pushed to any remote.',
		diagnostics: { remoteStatus: 'none' },
		processed: 1,
		total: 1,
	});
	harness.post({ command: 'cleanupComplete' });

	const rendered = harness.text('.worktree-cleanup-log');
	assert.ok(rendered?.includes('Remote: none (never pushed)'), `expected a missing-remote warning, got: ${rendered}`);
});

test('a worktree whose remote could not be probed shows no remote claim at all', async () => {
	// "Could not read this worktree" and "this branch has no upstream" both fail the same git
	// lookup. Reporting the unreadable case as "never pushed" would be an invented fact, so the
	// host omits remoteStatus entirely and the row must simply carry no remote chip.
	const harness = await bootWebview(buildStats());

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult',
		path: 'C:\\wt\\unreadable',
		branch: '?',
		repoLabel: 'repo',
		status: 'error',
		reason: 'Could not safely locate the main repository.',
		diagnostics: { lastModified: '2026-09-01T08:30:00.000Z' },
		processed: 1,
		total: 1,
	});
	harness.post({ command: 'cleanupComplete' });

	const rendered = harness.text('.worktree-cleanup-log');
	assert.ok(rendered?.includes('Last updated:'), `expected the readable facts to still render, got: ${rendered}`);
	assert.ok(!rendered?.includes('Remote:'), 'an unprobed remote must not be reported as a fact');
	assert.ok(!rendered?.includes('never pushed'), 'an unreadable worktree must never be called "never pushed"');
});

test('clicking "Open in VS Code" asks the host to open that worktree folder', async () => {
	const harness = await bootWebview(buildStats());
	const worktreePath = 'C:\\wt\\needs-attention';

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult',
		path: worktreePath,
		branch: 'needs-attention',
		repoLabel: 'repo',
		status: 'skipped',
		reason: 'Has uncommitted or untracked changes.',
		diagnostics: { modifiedFiles: 2, untrackedFiles: 0 },
		processed: 1,
		total: 1,
	});
	harness.post({ command: 'cleanupComplete' });
	harness.posted.length = 0;

	const button = harness.window.document.querySelector('.worktree-open-editor-btn') as HTMLElement | null;
	assert.ok(button, 'expected an open-in-VS-Code button on the blocked cleanup row');
	button.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

	const posted = harness.posted.find((m) => m.command === 'openWorktreeInEditor');
	assert.ok(posted, `expected an openWorktreeInEditor message, got: ${JSON.stringify(harness.posted)}`);
	assert.equal(posted.path, worktreePath);
});

test('"Delete anyway" shows size, then progress, then the final state on the row', async () => {
	const harness = await bootWebview(buildStats());
	const worktreePath = 'C:\\wt\\big';

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult',
		path: worktreePath, branch: 'big', repoLabel: 'repo', status: 'error',
		reason: 'Could not delete worktree.',
		diagnostics: { sizeBytes: 5 * 1024 * 1024 },
		processed: 1, total: 1,
	});
	harness.post({ command: 'cleanupComplete' });
	assert.ok(harness.text('.worktree-cleanup-log')?.includes('Size: '), 'expected a size chip on the failed row');

	harness.post({ command: 'worktreeDeleteStarted', path: worktreePath });
	assert.ok(harness.window.document.querySelector('.worktree-cleanup-log .worktree-progress-fill'), 'expected a progress bar while deleting');
	assert.equal(harness.window.document.querySelector('.worktree-delete-btn'), null, 'actions are hidden while deleting');

	harness.post({ command: 'worktreeDeleteResult', path: worktreePath, status: 'error', reason: 'folder in use' });
	assert.ok(harness.text('.worktree-cleanup-log')?.includes('folder in use'), 'expected the failure reason');
	assert.ok(harness.window.document.querySelector('.worktree-delete-btn'), 'actions return after a failure so the user can retry');

	// The user retries after the failure; the host announces the new attempt before its result.
	harness.post({ command: 'worktreeDeleteStarted', path: worktreePath });
	harness.post({ command: 'worktreeDeleteResult', path: worktreePath, status: 'deleted' });
	assert.ok(harness.text('.worktree-cleanup-log')?.includes('Deleted'), 'expected the final deleted state');
	assert.ok(!harness.text('.worktree-cleanup-log')?.includes('Could not delete worktree.'), 'a successful retry must not keep the old failure text');
	assert.ok(harness.text('.worktree-cleanup-log')?.includes('Deleted') && harness.window.document.body.textContent?.includes('1 deleted'), 'the summary must count the retried worktree as deleted');
	assert.ok(harness.window.document.body.textContent?.includes('0 errors'), 'the summary must not keep the original error count');
});

test('the size chip reuses the scanned worktree size instead of a second disk walk', async () => {
	const harness = await bootWebview(buildStats());
	const worktreePath = 'C:\\wt\\scanned';
	harness.post({ command: 'worktreeFound', worktree: { path: worktreePath, repoLabel: 'repo', branch: 'scanned', lastCommit: '', lastCommitDate: null, pushed: 'yes', files: 3, folders: 1, bytes: 2 * 1024 * 1024 } });
	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult', path: worktreePath, branch: 'scanned', repoLabel: 'repo', status: 'error',
		reason: 'Could not delete worktree.', diagnostics: { modifiedFiles: 0, untrackedFiles: 0 }, processed: 1, total: 1,
	});
	harness.post({ command: 'cleanupComplete' });
	assert.ok(harness.text('.worktree-cleanup-log')?.includes('Size: '), 'expected a size chip taken from the scan result');
});

test('a late delete result with no retry in flight is ignored, and empty worktrees still show a size', async () => {
	const harness = await bootWebview(buildStats());
	const worktreePath = 'C:\\wt\\empty';
	harness.post({ command: 'worktreeFound', worktree: { path: worktreePath, repoLabel: 'repo', branch: 'empty', lastCommit: '', lastCommitDate: null, pushed: 'yes', files: 0, folders: 0, bytes: 0 } });
	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post({
		command: 'cleanupWorktreeResult', path: worktreePath, branch: 'empty', repoLabel: 'repo', status: 'error',
		reason: 'Could not delete worktree.', diagnostics: { modifiedFiles: 0, untrackedFiles: 0 }, processed: 1, total: 1,
	});
	harness.post({ command: 'cleanupComplete' });
	assert.ok(harness.text('.worktree-cleanup-log')?.includes('Size: '), 'a zero-byte worktree still reports its size');

	harness.post({ command: 'worktreeDeleteResult', path: worktreePath, status: 'deleted' });
	assert.ok(!harness.text('.worktree-cleanup-log')?.includes('✅ Deleted'), 'a result without a running retry must not decorate the row');
});

test('a new cleanup run does not inherit the previous run\'s "Delete anyway" state', async () => {
	const harness = await bootWebview(buildStats());
	const worktreePath = 'C:\\wt\\again';
	const result = {
		command: 'cleanupWorktreeResult', path: worktreePath, branch: 'again', repoLabel: 'repo',
		status: 'error', reason: 'Could not delete worktree.', processed: 1, total: 1,
	};

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post(result);
	harness.post({ command: 'cleanupComplete' });
	harness.post({ command: 'worktreeDeleteStarted', path: worktreePath });
	harness.post({ command: 'worktreeDeleteResult', path: worktreePath, status: 'deleted' });
	assert.ok(harness.text('.worktree-cleanup-log')?.includes('Deleted'));

	harness.post({ command: 'cleanupStarted', total: 1 });
	harness.post(result);
	harness.post({ command: 'cleanupComplete' });
	assert.ok(!harness.text('.worktree-cleanup-log')?.includes('✅ Deleted'), 'stale deleted state leaked into the new run');
	assert.ok(harness.window.document.querySelector('.worktree-delete-btn'), 'the fresh row offers Delete anyway again');
});

test('accepts payloads relayed the way VS Code actually delivers them', async () => {
	// The panel hung with `delivered=true` logged host-side because the webview's source-trust
	// check compared window identities. VS Code relays from an internal window, so every
	// extension → webview message was dropped before any handler saw it.
	const harness = await bootWebview(buildStats());

	harness.postFromHostFrame({ command: 'repoPrStatsLoaded', data: repoPrPayload() });

	const rendered = harness.text('#repos-pr-content');
	assert.ok(rendered?.includes('ai-engineering-fluency'), `expected the repo table, got: ${rendered}`);
});

test('marks HydraFusion sessions in the recent sessions list', async () => {
	const stats = buildStats();
	const hydraFusionSession = {
		title: 'HydraFusion task',
		filePath: 'session.jsonl',
		interactions: 12500,
		toolCalls: 1500,
		inputTokens: 1500000,
		outputTokens: 12000,
		thinkingTokens: 2000,
		cachedTokens: 30000,
		totalTokens: 1544000,
		estimatedCost: 12.345,
		editor: 'VS Code',
		models: ['hydrafusion'],
		lastActivity: '2026-08-31T12:00:00.000Z',
	};
	stats.todaySessions = [
		hydraFusionSession,
		// Id variants seen in real session logs must all be recognized...
		{ ...hydraFusionSession, title: 'Prefixed task', filePath: 'b.jsonl', models: ['copilot/hydrafusion'] },
		{ ...hydraFusionSession, title: 'Separated task', filePath: 'c.jsonl', models: ['hydra-fusion'] },
		{ ...hydraFusionSession, title: 'Suffixed task', filePath: 'd.jsonl', models: ['hydrafusion-preview'] },
		// ...while a different model that merely ends in the name must not be.
		{ ...hydraFusionSession, title: 'Unrelated task', filePath: 'e.jsonl', models: ['unrelated-hydrafusion'] },
	];
	const harness = await bootWebview(stats);

	const badges = harness.window.document.querySelectorAll('.hydrafusion-session-badge');
	assert.equal(badges.length, 4, 'every HydraFusion id variant should be marked, and only those');
	const badge = badges[0];
	assert.ok(badge, 'expects a marker for HydraFusion sessions');
	assert.equal(badge.textContent, 'HydraFusion');
	const row = harness.window.document.querySelector('.sessions-table tbody tr');
	assert.match(row.textContent, /12\.5K/);
	assert.match(row.textContent, /1\.5M/);
	assert.match(row.textContent, /\$12\.35/);
	const costCell = [...row.cells].find(cell => cell.textContent === '$12.35');
	// The table has no per-cell attributes, so the tooltip sits on the cell's content.
	assert.equal(costCell?.querySelector('[title]')?.title, '$12.3450');
});

test('Recent Sessions Duration column falls back to wall-clock time when activeDurationMs is zero', async () => {
	// Regression test for a bug where session formats without per-request timing data (e.g.
	// Copilot CLI JSONL) always reported activeDurationMs === 0, and the Duration column's old
	// `??` fallback treated that defined zero as "no fallback needed", showing a misleading "<1m"
	// for sessions that actually ran much longer.
	const stats = buildStats();
	const cliSession = {
		title: 'Long CLI session', filePath: 'cli-session.jsonl', interactions: 40, toolCalls: 53,
		inputTokens: 3700000, outputTokens: 14300, thinkingTokens: 0, cachedTokens: 3600000, totalTokens: 3800000,
		estimatedCost: 1.13, editor: 'Copilot CLI (App)', models: ['gpt-5.6-terra'],
		lastActivity: '2026-09-06T11:00:00.000Z',
		durationMs: 125 * 60_000, // 125 minutes of wall-clock time
		activeDurationMs: 0, // no per-request timing available for this format
	};
	stats.todaySessions = [cliSession];
	const harness = await bootWebview(stats);

	const row = harness.window.document.querySelector('.sessions-table tbody tr');
	assert.ok(row, 'expects a rendered session row');
	assert.match(row.textContent, /2h 05m/, 'Duration should fall back to the 125-minute wall-clock time, not "<1m"');
	assert.doesNotMatch(row.textContent, /<1m/, 'a zero-but-defined activeDurationMs must not be shown as "<1m"');
});

test('Recent Sessions pill filters narrow the table by editor, vendor, model, and HydraFusion', async () => {
	const stats = buildStats();
	const baseSession = {
		interactions: 10, toolCalls: 5, inputTokens: 1000, outputTokens: 500, thinkingTokens: 0,
		cachedTokens: 0, totalTokens: 1500, estimatedCost: 0.5, lastActivity: '2026-09-06T11:00:00.000Z',
	};
	stats.todaySessions = [
		{ ...baseSession, title: 'CLI session', filePath: 'a.jsonl', editor: 'Copilot CLI (App)', models: ['claude-opus-5'] },
		{ ...baseSession, title: 'VS Code session', filePath: 'b.jsonl', editor: 'VS Code', models: ['gpt-5.6-terra'] },
		{ ...baseSession, title: 'HydraFusion session', filePath: 'c.jsonl', editor: 'VS Code', models: ['hydrafusion'] },
	];
	const harness = await bootWebview(stats);
	const doc = harness.window.document;
	const titles = () => [...doc.querySelectorAll('.sessions-table tbody tr .session-title-link')].map(a => a.textContent.replace(/^HydraFusion/, ''));

	assert.deepEqual(titles(), ['CLI session', 'VS Code session', 'HydraFusion session'], 'all three sessions render before any filter is applied');

	// Filter by editor: only the two VS Code sessions should remain.
	const editorPill = [...doc.querySelectorAll('.session-filter-pill[data-filter-type="editor"]')].find(p => p.getAttribute('data-filter-value') === 'VS Code');
	assert.ok(editorPill, 'expects a VS Code editor filter pill');
	editorPill.click();
	assert.deepEqual(titles(), ['VS Code session', 'HydraFusion session']);
	// The click replaces the whole table container's HTML, so re-query for the live pill.
	const editorPillAfterClick = [...doc.querySelectorAll('.session-filter-pill[data-filter-type="editor"]')].find(p => p.getAttribute('data-filter-value') === 'VS Code');
	assert.equal(editorPillAfterClick?.getAttribute('aria-pressed'), 'true', 'an active pill should expose aria-pressed="true"');

	// Combine with the HydraFusion quick filter: only the HydraFusion session should remain.
	const hydraPill = doc.querySelector('.session-filter-pill-hydrafusion');
	assert.ok(hydraPill, 'expects a HydraFusion quick-filter pill');
	hydraPill.click();
	assert.deepEqual(titles(), ['HydraFusion session']);

	// Clearing filters restores every session.
	const clearButton = doc.getElementById('sessions-filter-clear');
	assert.ok(clearButton, 'expects a "Clear filters" button once a filter is active');
	clearButton.click();
	assert.deepEqual(titles(), ['CLI session', 'VS Code session', 'HydraFusion session']);
	assert.equal(doc.getElementById('sessions-filter-clear'), null, 'the clear button disappears once no filters are active');
});

test('the Context column reports each session\'s window fill and flags the near-limit ones', async () => {
	const stats = buildStats();
	const baseSession = {
		interactions: 10, toolCalls: 5, inputTokens: 1000, outputTokens: 500, thinkingTokens: 0,
		cachedTokens: 0, totalTokens: 1500, estimatedCost: 0.5, lastActivity: '2026-09-06T11:00:00.000Z',
		editor: 'Copilot CLI (App)', models: ['gpt-5.6-terra'],
	};
	stats.todaySessions = [
		{ ...baseSession, title: 'Near limit', filePath: 'a.jsonl', contextWindowLimit: 200000, contextReachedTokens: 190000 },
		{ ...baseSession, title: 'Plenty of room', filePath: 'b.jsonl', contextWindowLimit: 200000, contextReachedTokens: 40000 },
		// Compaction resets the fill a near-limit judgement would rest on, so a
		// compacted session is shown but never flagged.
		{ ...baseSession, title: 'Compacted', filePath: 'c.jsonl', contextWindowLimit: 200000, contextReachedTokens: 199000, truncationCount: 2 },
		{ ...baseSession, title: 'No fill data', filePath: 'd.jsonl' },
	];
	const harness = await bootWebview(stats);
	const doc = harness.window.document;

	const contextCells = [...doc.querySelectorAll('.sessions-table tbody tr')].map((row: any) => {
		const cells = [...row.cells];
		return `${row.querySelector('.session-title-link').textContent} => ${cells[cells.length - 2].textContent.trim()}`;
	});
	assert.deepEqual(contextCells, [
		'Near limit => ⚠️ 95%',
		'Plenty of room => 20%',
		'Compacted => 99%',
		'No fill data => —',
	]);
});

test('the near-limit pill and the insight\'s switchTab preset both narrow Recent Sessions to the flagged sessions', async () => {
	const stats = buildStats();
	const baseSession = {
		interactions: 10, toolCalls: 5, inputTokens: 1000, outputTokens: 500, thinkingTokens: 0,
		cachedTokens: 0, totalTokens: 1500, estimatedCost: 0.5, lastActivity: '2026-09-06T11:00:00.000Z',
		editor: 'Copilot CLI (App)', models: ['gpt-5.6-terra'],
	};
	const sessions = [
		{ ...baseSession, title: 'Near limit A', filePath: 'a.jsonl', contextWindowLimit: 200000, contextReachedTokens: 190000 },
		{ ...baseSession, title: 'Plenty of room', filePath: 'b.jsonl', contextWindowLimit: 200000, contextReachedTokens: 40000 },
		{ ...baseSession, title: 'Near limit B', filePath: 'c.jsonl', contextWindowLimit: 128000, contextReachedTokens: 120000 },
	];
	stats.todaySessions = sessions;
	stats.recentSessions = { last7: sessions, last30: sessions, currentMonth: sessions };
	const harness = await bootWebview(stats);
	const doc = harness.window.document;
	const titles = () => [...doc.querySelectorAll('.sessions-table tbody tr .session-title-link')].map((a: any) => a.textContent);
	const pill = () => doc.querySelector('.session-filter-pill[data-filter-type="nearcontextlimit"]');

	assert.equal(pill()?.textContent.replace(/\s+/g, ' ').trim(), '🧠 Near context limit 2',
		'the pill counts only the sessions the insight counts');

	pill().click();
	assert.deepEqual(titles(), ['Near limit A', 'Near limit B']);
	assert.equal(pill()?.getAttribute('aria-pressed'), 'true');

	// Back to the unfiltered list, then take the path the insight's
	// "Show these N sessions" button drives.
	pill().click();
	assert.deepEqual(titles(), ['Near limit A', 'Plenty of room', 'Near limit B']);

	harness.post({ command: 'switchTab', tab: 'sessions', sessionsPreset: { filter: 'nearContextLimit', lookback: 'last30' } });
	await harness.settle();

	assert.equal(doc.querySelector('.tab-button.active')?.getAttribute('data-tab'), 'sessions');
	assert.deepEqual(titles(), ['Near limit A', 'Near limit B']);
	assert.equal(pill()?.getAttribute('aria-pressed'), 'true');
	// A user who had hidden the Context column must not be left with a filtered
	// table whose checkbox disagrees with what is on screen.
	const checkbox = doc.querySelector('#sessions-columns-menu input[data-column="contextFill"]');
	assert.equal(checkbox?.checked, true, 'the preset ticks the Columns menu checkbox it turned on');
});

test('a preset-forced column survives the saved column settings restored by bootstrap', async () => {
	// bootstrap() yields on a dynamic import before it restores saved settings,
	// while the message listener is live from module evaluation — so the host's
	// pending switchTab preset routinely lands first and the restore replaces the
	// whole column Set. Without re-applying, a user who had hidden the Context
	// column lands on a near-limit-filtered table with no fill percentage on it.
	const stats = buildStats() as any;
	const baseSession = {
		interactions: 10, toolCalls: 5, inputTokens: 1000, outputTokens: 500, thinkingTokens: 0,
		cachedTokens: 0, totalTokens: 1500, estimatedCost: 0.5, lastActivity: '2026-09-06T11:00:00.000Z',
		editor: 'Copilot CLI (App)', models: ['gpt-5.6-terra'],
	};
	const sessions = [
		{ ...baseSession, title: 'Near limit', filePath: 'a.jsonl', contextWindowLimit: 200000, contextReachedTokens: 190000 },
		{ ...baseSession, title: 'Plenty of room', filePath: 'b.jsonl', contextWindowLimit: 200000, contextReachedTokens: 40000 },
	];
	stats.todaySessions = sessions;
	// The preset switches to the 30-day lookback, which renders from this cache.
	stats.recentSessions = { last7: sessions, last30: sessions, currentMonth: sessions };
	// Saved settings from a user who had hidden the Context column.
	stats.sessionColumnSettings = { enabledColumns: ['interactions', 'totalTokens', 'editor', 'lastActivity'] };

	const harness = await bootWebview(
		stats,
		{ command: 'switchTab', tab: 'sessions', sessionsPreset: { filter: 'nearContextLimit', lookback: 'last30' } },
	);
	const doc = harness.window.document;

	assert.equal(doc.querySelector('#sessions-columns-menu input[data-column="contextFill"]')?.checked, true,
		'the preset\'s column must survive the saved settings restored after it arrived');
	const headers = [...doc.querySelectorAll('.sessions-table thead th')].map((th: any) => th.textContent.replace(/[↑↓]/g, '').trim());
	assert.ok(headers.includes('Context'), `the Context column is visible; got ${headers.join(', ')}`);
});

test('renders cloud agent session results', async () => {
	const harness = await bootWebview(buildStats());

	harness.post({
		command: 'agentSessionsLoaded',
		data: {
			authenticated: true, since: new Date('2026-08-01T00:00:00Z').toISOString(), fetchedAt: new Date().toISOString(),
			totalTasks: 4, totalSessions: 6, totalCredits: 0, totalPremiumRequests: 0,
			accountTasksAvailable: true, partial: false,
			repos: [{ owner: 'rajbos', repo: 'ai-engineering-fluency', repoUrl: 'https://github.com/rajbos/ai-engineering-fluency', tasks: 4, sessions: 6, discovery: 'workspace' }],
		},
	});

	const rendered = harness.text('#agent-sessions-content');
	assert.ok(rendered?.includes('ai-engineering-fluency'), `expected the agent table, got: ${rendered}`);
	assert.ok(!rendered?.includes('sign in with GitHub'), 'the placeholder must be replaced');
});

test('a throwing message handler is reported to the host instead of failing silently', async () => {
	const harness = await bootWebview(buildStats());
	harness.posted.length = 0;
	// `null` data makes sanitizeRepoPrStatsData produce an unauthenticated result rather than
	// throwing, so force a real failure by removing the render target's parent document node.
	harness.window.document.querySelector = () => { throw new Error('boom'); };

	harness.post({ command: 'repoPrStatsLoaded', data: repoPrPayload() });

	const trace = harness.posted.find((m) => m.command === 'usageWebviewTrace' && m.stage === 'handleExtensionMessage.threw');
	assert.ok(trace, 'a render exception must surface in the extension Output channel');
	assert.equal(trace.details.command, 'repoPrStatsLoaded');
});

test('collapses the long-tail of the local model leaderboard into a closed "Other models" group', async () => {
	const harness = await bootWebview(buildStatsWithLongTailModelEfficiency());

	const wraps = harness.window.document.querySelectorAll('.model-leaderboard-table-wrap');
	assert.equal(wraps.length, 2, 'expects a main table plus one collapsed "other models" table');

	const details = harness.window.document.getElementById('model-leaderboard-other');
	assert.ok(details, 'expects a collapsible "Other models" group in the DOM');
	assert.equal(details.open, false, 'the group must be collapsed by default');
	// The default "hide low-usage models" filter drops the 3 lowest-call models (Q1 threshold)
	// first, leaving 7; the long tail is then everything after the cliff among those 7.
	assert.match(details.querySelector('summary').textContent, /Other models \(3,/, 'expects the 3 remaining long-tail models grouped');

	const mainRows = wraps[0].querySelectorAll('tbody tr');
	assert.equal(mainRows.length, 4, 'the 4 models before the cliff stay in the main table');

	const otherRows = details.querySelectorAll('tbody tr');
	assert.equal(otherRows.length, 3, 'the 3 models after the cliff move into the other-models table');
});

test('remembers the "Other models" open state across a leaderboard re-render', async () => {
	const harness = await bootWebview(buildStatsWithLongTailModelEfficiency());

	const details = harness.window.document.getElementById('model-leaderboard-other');
	assert.equal(details.open, false);

	// Open it, mirroring what a real click on <summary> does, then dispatch the `toggle` event
	// the webview listens for (capture phase, since `toggle` does not bubble).
	details.open = true;
	details.dispatchEvent(new harness.window.Event('toggle'));

	// Switching the chart metric re-renders the whole leaderboard content, recreating the
	// <details> element from scratch; without persisted state it would snap back to collapsed.
	harness.window.document.querySelector('button[data-eff-metric="outputTokens"]').click();

	const detailsAfterRender = harness.window.document.getElementById('model-leaderboard-other');
	assert.notEqual(detailsAfterRender, details, 'the metric switch must have rebuilt the group');
	assert.equal(detailsAfterRender.open, true, 'the open state must survive the re-render');
});

test('sorting the model leaderboard sorts both tables in place and leaves "Other models" open', async () => {
	const harness = await bootWebview(buildStatsWithLongTailModelEfficiency());
	const doc = harness.window.document;
	const details = doc.getElementById('model-leaderboard-other');
	details.open = true;
	details.dispatchEvent(new harness.window.Event('toggle'));
	const modelSort = (tableId: string) => doc.querySelector(`#data-table-root-${tableId} [data-table-sort="model"]`)?.closest('th')?.getAttribute('aria-sort');

	doc.querySelector('#data-table-root-model-leaderboard [data-table-sort="model"]').click();

	assert.equal(modelSort('model-leaderboard'), 'ascending');
	assert.equal(modelSort('model-leaderboard-other'), 'ascending', 'the "Other models" table follows the main table\'s sort');
	assert.equal(doc.getElementById('model-leaderboard-other'), details, 'a sort re-renders only the table, not the section');
	assert.equal(details.open, true);
	const otherRows = [...details.querySelectorAll('tbody tr')];
	assert.equal(otherRows.length, 3, 'sorting keeps every long-tail model');
	assert.ok(otherRows.every((row: any) => /--model-color:/.test(row.getAttribute('style') ?? '')), 'rows keep their model colour');
});

test('Recent Sessions sorts from its headers and title links still open the session after a re-sort', async () => {
	const stats = buildStats();
	const baseSession = {
		toolCalls: 5, inputTokens: 1000, outputTokens: 500, thinkingTokens: 0, cachedTokens: 0, totalTokens: 1500,
		estimatedCost: 0.5, lastActivity: '2026-09-06T11:00:00.000Z', editor: 'VS Code', models: ['gpt-5.6-terra'],
	};
	stats.todaySessions = [
		{ ...baseSession, title: 'Alpha', filePath: 'alpha.jsonl', interactions: 5 },
		{ ...baseSession, title: 'Charlie', filePath: 'charlie.jsonl', interactions: 9 },
		{ ...baseSession, title: 'Bravo', filePath: 'bravo.jsonl', interactions: 3 },
	];
	const harness = await bootWebview(stats);
	const doc = harness.window.document;
	const titles = () => [...doc.querySelectorAll('.sessions-table tbody tr .session-title-link')].map((a: any) => a.textContent);
	const ranks = () => [...doc.querySelectorAll('.sessions-table tbody tr td.session-col-rank')].map((td: any) => td.textContent);

	assert.deepEqual(titles(), ['Charlie', 'Alpha', 'Bravo'], 'most active first by default');
	doc.querySelector('.sessions-table [data-table-sort="title"]').click();
	assert.deepEqual(titles(), ['Alpha', 'Bravo', 'Charlie']);
	assert.deepEqual(ranks(), ['1', '2', '3'], 'the # column numbers the sorted rows');
	assert.equal(doc.querySelector('.sessions-table th[aria-sort="ascending"]')?.textContent.replace(/[↑↓]/g, '').trim(), 'Title');

	harness.posted.length = 0;
	doc.querySelector('.sessions-table .session-title-link').click();
	const opened = harness.posted.find((m) => m.command === 'openSessionFile');
	assert.equal(opened?.file, 'alpha.jsonl', 'the delegated title-link handler must survive the table re-rendering itself');
});

test('worktree repositories expand into a per-worktree table that moves with its row when sorted', async () => {
	const harness = await bootWebview(buildStats());
	const doc = harness.window.document;
	const worktree = (path: string, repoLabel: string, bytes: number) => ({
		command: 'worktreeFound',
		worktree: { path, repoLabel, branch: 'b', lastCommit: 'abc', lastCommitDate: null, pushed: 'yes', files: 1, folders: 1, bytes },
	});
	harness.post(worktree('C:\\wt\\a1', 'alpha', 10));
	harness.post(worktree('C:\\wt\\b1', 'beta', 20));
	harness.post(worktree('C:\\wt\\b2', 'beta', 30));
	await new Promise((resolve) => setTimeout(resolve, 50));
	const repoOrder = () => [...doc.querySelectorAll('#data-table-root-worktree-repos tr.worktree-repo-row')].map((row: any) => row.getAttribute('data-repo'));

	assert.deepEqual(repoOrder(), ['beta', 'alpha'], 'most worktrees first by default');
	doc.querySelector('tr.worktree-repo-row[data-repo="alpha"] td').click();
	assert.equal(doc.querySelector('tr.worktree-repo-row[data-repo="alpha"]')?.getAttribute('aria-expanded'), 'true');

	doc.querySelector('#data-table-root-worktree-repos [data-table-sort="repo"]').click();
	assert.deepEqual(repoOrder(), ['alpha', 'beta']);
	const details = doc.querySelector('tr.worktree-repo-details[data-repo="alpha"]');
	assert.ok(details, 'the expansion survives the sort');
	assert.equal(details.previousElementSibling?.getAttribute('data-repo'), 'alpha', 'the details row follows its repository');
	assert.ok(details.querySelector('#data-table-root-worktree-details-alpha'), 'the nested table has its own stable id');

	harness.posted.length = 0;
	details.querySelector('.worktree-delete-link').click();
	assert.ok(harness.posted.some((m) => m.command === 'deleteWorktree' && m.path === 'C:\\wt\\a1'), 'nested action links keep working');
});

/** Which leaf tab is marked active, and which panel is the only visible one. */
function activeTabState(harness: any): { button: string | undefined; panels: string[]; group: string | undefined } {
	const doc = harness.window.document;
	return {
		button: doc.querySelector('.tab-button.active')?.getAttribute('data-tab') ?? undefined,
		panels: [...doc.querySelectorAll('.tab-panel')]
			.filter((p: any) => p.style.display !== 'none')
			.map((p: any) => p.id),
		group: doc.querySelector('.group-tab.active')?.getAttribute('data-group') ?? undefined,
	};
}

test('a deep link arriving while a rendered panel is reloading is still announced', async () => {
	// Regression: the announcement guard used to be a lifetime boolean. renderUsageLoadingState()
	// tears the panel down on a refresh, so a `switchTab` landing in that window could not be
	// announced by activateUsageTab() (no panel yet) and was then suppressed by the guard when the
	// layout came back — the host never recorded the visit, and What's New kept treating the
	// deep-linked tab as unseen. Tracking the last announced tab reports it on the rebuilt layout.
	const harness = await bootWebview(buildStats());
	const opened = (): string[] => harness.posted
		.filter((m: any) => m.command === 'viewTabOpened')
		.map((m: any) => m.tab);
	assert.deepEqual(opened(), ['activity'], 'the first render announces the tab it opened on');

	// A refresh tears the panel down, a deep link lands while it is gone, then stats rebuild it.
	harness.post({ command: 'usageRefreshing' });
	harness.post({ command: 'switchTab', tab: 'worktrees' });
	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	assert.equal(activeTabState(harness).button, 'worktrees', 'the deep link decides the rebuilt tab');
	assert.ok(opened().includes('worktrees'), 'the host must be told the deep-linked tab was opened');
});

test('a periodic refresh does not re-announce the tab or re-request its data', async () => {
	// Regression: setupTabs() runs after every renderLayout(), including each silent updateStats.
	// Announcing + replaying unconditionally re-stamped the What's New visit window on every
	// refresh, and re-posted loadRepoPrStats forever once an unauthenticated response had reset
	// the loaded flag (refresh -> post -> unauthenticated -> flag reset -> repeat).
	const harness = await bootWebview(null);
	harness.post({ command: 'switchTab', tab: 'repos' });
	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	const countOf = (command: string): number =>
		harness.posted.filter((m: any) => m.command === command).length;
	assert.equal(countOf('loadRepoPrStats'), 1, 'the opening render requests the data once');
	const opensAfterFirstRender = countOf('viewTabOpened');

	// An unauthenticated response resets the loaded flag, then two silent refreshes arrive.
	harness.post({ command: 'repoPrStatsLoaded', data: null });
	harness.post({ command: 'updateStats', data: buildStats() });
	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	assert.equal(countOf('loadRepoPrStats'), 1, 'refreshes must not re-request while the user sits on the tab');
	assert.equal(countOf('viewTabOpened'), opensAfterFirstRender, 'refreshes must not re-announce the same tab');

	// A real switch away and back is still an explicit retry.
	harness.window.document.querySelector('.tab-button[data-tab="activity"]').click();
	harness.window.document.querySelector('.group-tab[data-group="github"]').click();
	assert.equal(countOf('loadRepoPrStats'), 2, 're-entering the tab retries the load');
});

test('localization arriving with updateStats is applied when the initial payload was null', async () => {
	// A panel opened before any stats are cached gets `__INITIAL_USAGE__ = null`, so the initial
	// localization step never runs. Without the map on updateStats the whole view stays English.
	const harness = await bootWebview(null);
	harness.post({
		command: 'updateStats',
		data: { ...buildStats(), localization: { 'usage.group.workspace': 'WERKRUIMTE', '__language__': 'nl' } },
	});
	await harness.settle();

	const label = [...harness.window.document.querySelectorAll('.group-tab')]
		.find((b: any) => b.getAttribute('data-group') === 'workspace')?.textContent ?? '';
	assert.match(label, /WERKRUIMTE/, 'the group tab must use the payload translation, not the English default');
});

test('a deep link to a lazy-loaded tab still requests its data', async () => {
	// Regression: activateUsageTab() returns before runTabFirstVisitEffects() when no panel
	// exists yet, which is the state a `switchTab` message arrives in during loading. Without
	// replaying the effects at render time, Repository PRs opened via a deep link rendered its
	// panel and then sat on the loading placeholder, because loadRepoPrStats was never posted.
	const harness = await bootWebview(null);
	harness.post({ command: 'switchTab', tab: 'repos' });
	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();

	assert.equal(activeTabState(harness).button, 'repos', 'the deep link decides the opening tab');
	assert.ok(
		harness.posted.some((m: any) => m.command === 'loadRepoPrStats'),
		'the opening tab must request its own data, not wait for the user to switch away and back',
	);
});

test('a deep link to Insights marks its new insights as seen', async () => {
	// Regression: setupTabs() replays the opening tab's first-visit effects, but renderLayout
	// assigned currentInsights *after* that call, so the replay iterated an empty array and the
	// deep-linked Insights tab never posted `seen` until the user switched tabs by hand.
	const stats = buildStats() as any;
	stats.insights = [
		{ id: 'insight-a', status: 'new', title: 'A', body: 'a', severity: 'tip' },
		{ id: 'insight-b', status: 'seen', title: 'B', body: 'b', severity: 'tip' },
	];
	const harness = await bootWebview(null);
	harness.post({ command: 'switchTab', tab: 'insights' });
	harness.post({ command: 'updateStats', data: stats });
	await harness.settle();

	assert.equal(activeTabState(harness).button, 'insights', 'the deep link decides the opening tab');
	const seen = harness.posted
		.filter((m: any) => m.command === 'insightAction' && m.action === 'seen')
		.map((m: any) => m.id);
	assert.deepEqual(seen, ['insight-a'], 'only the new insight is marked seen, and it is marked');
});

test('group tabs expose which one is selected to assistive technology', async () => {
	const harness = await bootWebview(buildStats());
	const pressed = (): string[] => [...harness.window.document.querySelectorAll('.group-tab')]
		.filter((b: any) => b.getAttribute('aria-pressed') === 'true')
		.map((b: any) => b.getAttribute('data-group'));

	assert.deepEqual(pressed(), ['usage'], 'the open group is the only one marked pressed at render');

	harness.window.document.querySelector('.group-tab[data-group="coaching"]').click();

	assert.deepEqual(pressed(), ['coaching'], 'aria-pressed follows the group, not just the CSS class');
	// Every group button carries the attribute, so none reads as an untoggled plain button.
	const all = [...harness.window.document.querySelectorAll('.group-tab')];
	assert.ok(all.every((b: any) => b.hasAttribute('aria-pressed')), 'every group tab is a toggle');
});

test('switching group tabs moves to that group and shows only its panel', async () => {
	const harness = await bootWebview(buildStats());

	assert.deepEqual(activeTabState(harness), {
		button: 'activity', panels: ['tab-panel-activity'], group: 'usage',
	}, 'opens on My Activity under the Usage group');

	harness.window.document.querySelector('.group-tab[data-group="github"]').click();

	const after = activeTabState(harness);
	assert.equal(after.group, 'github', 'the clicked group becomes active');
	assert.equal(after.button, 'repos', "lands on the group's first leaf when none of its tabs was active");
	assert.deepEqual(after.panels, ['tab-panel-repos'], 'exactly one panel is visible');

	// Only the active group's leaf bar is on screen.
	const visibleBars = [...harness.window.document.querySelectorAll('.leaf-tabs')]
		.filter((bar: any) => bar.style.display !== 'none')
		.map((bar: any) => bar.getAttribute('data-group'));
	assert.deepEqual(visibleBars, ['github']);
});

test('returning to a group restores the leaf tab it was left on', async () => {
	const harness = await bootWebview(buildStats());
	const doc = harness.window.document;

	// Start on a non-first leaf of the Workspace group.
	doc.querySelector('.group-tab[data-group="workspace"]').click();
	doc.querySelector('.tab-button[data-tab="worktrees"]').click();
	assert.equal(activeTabState(harness).button, 'worktrees');

	// Leave for another group, then come back.
	doc.querySelector('.group-tab[data-group="coaching"]').click();
	assert.equal(activeTabState(harness).group, 'coaching');
	doc.querySelector('.group-tab[data-group="workspace"]').click();

	assert.deepEqual(activeTabState(harness), {
		button: 'worktrees', panels: ['tab-panel-worktrees'], group: 'workspace',
	}, 'the group reopens on Worktrees, not on its first tab');
});

test('a deep-linked tab is remembered by its group even though it arrived before the panels existed', async () => {
	// Regression: `switchTab` during the loading state sets activeTab but returns before
	// recording the group, because no panel exists yet. Without seeding lastTabPerGroup at
	// render time, leaving the group and returning dropped the user on its first tab instead.
	// Boot into the loading state (no initial data), deep-link, then deliver the stats — the
	// exact order the host produces when a notification action opens the panel.
	const harness = await bootWebview(null);
	harness.post({ command: 'switchTab', tab: 'worktrees' });
	harness.post({ command: 'updateStats', data: buildStats() });
	await harness.settle();
	const doc = harness.window.document;

	assert.equal(activeTabState(harness).button, 'worktrees', 'the deep link decides the opening tab');

	doc.querySelector('.group-tab[data-group="github"]').click();
	doc.querySelector('.group-tab[data-group="workspace"]').click();

	assert.equal(
		activeTabState(harness).button, 'worktrees',
		'returning to the group must restore the deep-linked tab, not fall back to Tools',
	);
});

/**
 * Context-reference counts with a clear split: #file and #selection used recently, everything
 * else untouched. `lastMonth` activity on #clipboard checks that only today + last-30-days
 * decide the split, matching contextRefRecentTotal().
 */
function buildStatsWithContextRefLongTail(): Record<string, unknown> {
	const stats = buildStats() as any;
	const refs = (today: number, last30: number, clipboard = 0): Record<string, unknown> => ({
		total: today + last30, byKind: {}, byPath: {},
		file: today, selection: last30, clipboard,
	});
	stats.today.contextReferences = refs(6, 0);
	stats.last30Days.contextReferences = refs(0, 40);
	stats.month.contextReferences = refs(0, 30);
	stats.lastMonth.contextReferences = refs(0, 0, 9);
	return stats;
}

test('collapses context-reference kinds with no recent usage into a closed "Other references" group', async () => {
	const harness = await bootWebview(buildStatsWithContextRefLongTail());

	const details = harness.window.document.getElementById('ctx-ref-other');
	assert.ok(details, 'expects a collapsible "Other references" group in the DOM');
	assert.equal(details.open, false, 'the group must be collapsed by default');

	const mainRows = harness.window.document.querySelectorAll(
		'#section-context-references > .ctx-ref-table-wrap tbody tr');
	const mainLabels = [...mainRows].map((row) => row.textContent);
	assert.ok(mainLabels.some((label) => label.includes('#file')), '#file was used today, so it stays visible');
	assert.ok(mainLabels.some((label) => label.includes('#selection')), '#selection was used in the last 30 days');
	assert.ok(
		!mainLabels.some((label) => label.includes('#clipboard')),
		'#clipboard was only used last month, so it belongs in the long tail, not the main table',
	);

	const otherRows = details.querySelectorAll('tbody tr');
	assert.ok(otherRows.length > 0, 'the unused kinds must still be rendered, just collapsed');
	// The long tail is paged like any data list; its pager reports the full row count.
	const otherRowCount = Number(details.querySelector('.data-table-page-info, .data-table-summary')?.textContent.match(/of (\d+)\s*$/)?.[1]);
	assert.ok(otherRowCount >= otherRows.length, `expects the pager to count every hidden kind; got ${otherRowCount}`);
	assert.match(
		details.querySelector('summary').textContent,
		new RegExp(`Other references \\(${otherRowCount},`),
		'the summary count must match the rows it hides',
	);

	// Every descriptor still renders somewhere: collapsing the tail must never drop a kind.
	assert.equal(mainRows.length + otherRowCount, 21, 'expects all 21 reference kinds accounted for');
});

test('remembers the "Other references" open state across a re-render', async () => {
	const harness = await bootWebview(buildStatsWithContextRefLongTail());

	const details = harness.window.document.getElementById('ctx-ref-other');
	assert.equal(details.open, false);

	// Mirror a real click on <summary>, then dispatch the `toggle` event the webview listens
	// for in the capture phase (`toggle` does not bubble).
	details.open = true;
	details.dispatchEvent(new harness.window.Event('toggle'));

	// A fresh stats payload rebuilds the whole view, recreating the <details> from scratch;
	// without the persisted flag it would snap back to collapsed.
	harness.post({ command: 'updateStats', data: buildStatsWithContextRefLongTail() });
	await harness.settle();

	const afterRerender = harness.window.document.getElementById('ctx-ref-other');
	assert.ok(afterRerender, 'expects the "Other references" group to still exist after a re-render');
	assert.equal(afterRerender.open, true, 'the open state must survive the re-render');
});

test('collapses the long tail of low-activity workspaces into an "Other" row on Workspace Health', async () => {
	const harness = await bootWebview(buildStatsWithLongTailWorkspaces());

	const majorRows = harness.window.document.querySelectorAll('#repo-list-pane .repo-name');
	assert.equal(majorRows.length, 5, 'only the 5 high-activity workspaces should render as individual rows');

	const rendered = harness.text('#repo-list-pane');
	assert.match(rendered ?? '', /Other \(5 repositories with low activity\)/);

	const showAllButton = harness.window.document.getElementById('btn-show-other-workspaces');
	assert.ok(showAllButton, 'expects a "Show all" toggle for the collapsed tail');

	showAllButton.click();
	await harness.settle();

	const allRows = harness.window.document.querySelectorAll('#repo-list-pane .repo-name');
	assert.equal(allRows.length, 10, '"Show all" must reveal every workspace, including the low-activity tail');
	assert.equal(
		harness.window.document.getElementById('btn-show-other-workspaces'), null,
		'the "Other" row must disappear once expanded',
	);
	const collapseButton = harness.window.document.getElementById('btn-collapse-other-workspaces');
	assert.ok(collapseButton, 'expects a "Show less" toggle once expanded');

	collapseButton.click();
	await harness.settle();

	const collapsedAgainRows = harness.window.document.querySelectorAll('#repo-list-pane .repo-name');
	assert.equal(collapsedAgainRows.length, 5, '"Show less" must collapse back to just the major group');
});

test('does not group workspaces on Workspace Health when there is no long tail', async () => {
	const stats = buildStats();
	// A gentle, non-cliff distribution with too few workspaces to bother grouping.
	stats.customizationMatrix = {
		customizationTypes: [],
		workspaces: [10, 8, 6, 4].map((sessionCount, index) => ({
			workspacePath: `/repos/repo-${index + 1}`,
			workspaceName: `repo-${index + 1}`,
			sessionCount,
			interactionCount: sessionCount * 10,
			typeStatuses: {},
		})),
		totalWorkspaces: 4,
		workspacesWithIssues: 0,
	};
	const harness = await bootWebview(stats);

	const rows = harness.window.document.querySelectorAll('#repo-list-pane .repo-name');
	assert.equal(rows.length, 4, 'all workspaces should render individually when there is no meaningful drop-off');
	assert.equal(
		harness.window.document.getElementById('btn-show-other-workspaces'), null,
		'no "Other" row should appear for a small, non-cliff workspace list',
	);
});

test('filters corrections by type and opens the selected session turn', async () => {
	const harness = await bootWebview(buildStatsWithCorrections());
	harness.window.document.querySelector('.tab-button[data-tab="corrections"]')?.click();

	const userCorrection = harness.window.document.querySelector('button[data-correction-filter="user-correction"]');
	assert.ok(userCorrection, 'expects a user-corrections filter pill');
	userCorrection.click();

	assert.equal(harness.window.document.querySelectorAll('button.correction-moment').length, 1);
	assert.match(harness.text('.correction-moment') ?? '', /^You corrected the agent No, use the existing endpoint\. turn 2 · matched no/);
	assert.equal(
		harness.window.document.querySelector('button[data-correction-filter="user-correction"]')?.getAttribute('aria-pressed'),
		'true',
	);
	harness.window.document.querySelector('button.correction-moment')?.click();
	harness.window.document.querySelector('button.correction-moment')?.click();
	const message = harness.posted.at(-1);
	assert.equal(message.command, 'openSessionFile');
	assert.equal(message.file, '/sessions/example.jsonl');
	assert.equal(message.turnNumber, 2);
});

test('corrections filter reports how many moments are shown and can be cleared', async () => {
	const harness = await bootWebview(buildStatsWithCorrections());
	harness.window.document.querySelector('.tab-button[data-tab="corrections"]')?.click();

	assert.match(harness.text('#corrections-filter-status') ?? '', /Showing all 2 listed correction moments/);
	assert.equal(harness.window.document.querySelector('button.correction-clear-filter'), null, 'no clear button without a filter');

	harness.window.document.querySelector('button[data-correction-filter="tool-error"]')?.click();
	assert.match(harness.text('#corrections-filter-status') ?? '', /Showing 1 of 2 listed correction moments/);
	assert.match(harness.text('#corrections-filter-status') ?? '', /Tool errors/);
	assert.equal(harness.window.document.querySelectorAll('button.correction-moment').length, 1);

	harness.window.document.querySelector('button.correction-clear-filter')?.click();
	assert.match(harness.text('#corrections-filter-status') ?? '', /Showing all 2 listed correction moments/);
	assert.equal(harness.window.document.querySelectorAll('button.correction-moment').length, 2);
});

test('the escalating pill is a filter that narrows the list to escalated moments', async () => {
	const harness = await bootWebview(buildStatsWithEscalatingCorrection());
	harness.window.document.querySelector('.tab-button[data-tab="corrections"]')?.click();

	const escalating = harness.window.document.querySelector('button[data-correction-filter="escalated"]');
	assert.ok(escalating, 'the escalating pill must be a clickable filter, not a static badge');
	escalating.click();

	assert.equal(
		harness.window.document.querySelector('button[data-correction-filter="escalated"]')?.getAttribute('aria-pressed'),
		'true',
	);
	assert.equal(harness.window.document.querySelectorAll('button.correction-moment').length, 1);
	assert.match(harness.text('#corrections-filter-status') ?? '', /Showing 1 of 2 listed correction moments/);
	assert.match(harness.text('#corrections-filter-status') ?? '', /Escalating corrections/);
});

/** Every correction pill's leading count, e.g. "1 user corrections" → "1". */
function correctionPillCounts(harness: Harness): string[] {
	return [...harness.window.document.querySelectorAll('button[data-correction-filter]')]
		.map((pill: any) => pill.textContent.trim().split(/\s+/)[0]);
}

for (const [label, boot] of [
	['the initial payload', () => bootWebview(buildStatsWithCorrections())],
	['an updateStats message', async () => {
		const harness = await bootWebview(buildStats());
		harness.post({ command: 'updateStats', data: buildStatsWithCorrections() });
		await harness.settle();
		return harness;
	}],
] as const) {
	test(`a correction report without escalatedUserCorrections renders numeric pill counts (via ${label})`, async () => {
		// Reports cached before the escalating count existed lack the field. It must default to 0
		// (no pill) rather than rendering "undefined 📈 escalating".
		const harness = await boot();
		harness.window.document.querySelector('.tab-button[data-tab="corrections"]')?.click();

		const counts = correctionPillCounts(harness);
		assert.ok(counts.length > 0, 'expects the correction pills to render');
		for (const count of counts) { assert.match(count, /^\d+$/, `every pill must lead with a number, got "${count}"`); }
		assert.equal(harness.window.document.querySelector('button[data-correction-filter="escalated"]'), null,
			'a missing escalated count is zero, so its pill is hidden');
		assert.ok(!(harness.text('#tab-panel-corrections') ?? '').includes('undefined'));
	});
}

// ── Insight deep-linking ───────────────────────────────────────────────────
// A toast ("💡 <title>" → View) and the status-bar insights badge both open the Insights tab for
// one specific insight. Landing on the tab is not enough: with a dozen look-alike cards the user
// still has to hunt for the one the notification was about.

test('every insight card carries its own DOM id so the host can target it', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	for (const id of ['missing-instructions', 'marathon-session-today', 'stale-skills']) {
		const card = harness.window.document.getElementById(`insight-card-${id}`);
		assert.ok(card, `no card element for insight ${id}`);
		assert.equal(card.getAttribute('data-insight-id'), id);
	}
});

test('switchTab with an insight anchor scrolls to and highlights that card', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-marathon-session-today' });
	await harness.settleScroll();

	assert.ok(
		harness.scrolledTo.includes('insight-card-marathon-session-today'),
		`expected a scroll to the requested card, scrolled to: ${JSON.stringify(harness.scrolledTo)}`,
	);
	const card = harness.window.document.getElementById('insight-card-marathon-session-today');
	assert.match(card.style.boxShadow, /var\(--vscode-focusBorder\)/, 'the target card must be visibly highlighted');
});

test('the insight anchor survives the re-render that marking the tab seen triggers', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	// Activating the tab makes the webview report its new insights as seen; the host answers with
	// a fresh insight list, rebuilding every card and destroying the element just scrolled to.
	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-missing-instructions' });
	assert.ok(
		harness.posted.some((m) => m.command === 'insightAction' && m.action === 'seen' && m.id === 'missing-instructions'),
		'activating the tab should mark the new insights as seen',
	);
	harness.post({
		command: 'updateInsights',
		insights: (buildStatsWithInsights().insights as any[]).map((i) => (i.status === 'new' ? { ...i, status: 'seen' } : i)),
	});
	await harness.settleScroll();

	assert.ok(
		harness.scrolledTo.includes('insight-card-missing-instructions'),
		`expected the rebuilt card to be scrolled to, scrolled to: ${JSON.stringify(harness.scrolledTo)}`,
	);
	const card = harness.window.document.getElementById('insight-card-missing-instructions');
	assert.match(card.style.boxShadow, /var\(--vscode-focusBorder\)/);
});

test('a switchTab without an anchor scrolls nowhere', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights' });
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, [], 'plain tab navigation must not hijack the scroll position');
});

test("the highlight flash restores a new card's own glow instead of stripping it", async () => {
	const harness = await bootWebview(buildStatsWithInsights());
	const before = harness.window.document.getElementById('insight-card-marathon-session-today').style.boxShadow;
	assert.notEqual(before, '', 'a NEW insight card ships with its own inline glow');

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-marathon-session-today' });
	await harness.settleScroll();
	await new Promise((resolve) => setTimeout(resolve, 2100));

	assert.equal(
		harness.window.document.getElementById('insight-card-marathon-session-today').style.boxShadow,
		before,
		'the flash must hand the card back the styling it had',
	);
});

test('flashing the same card twice in a row does not leave it permanently outlined', async () => {
	const harness = await bootWebview(buildStatsWithInsights());
	const before = harness.window.document.getElementById('insight-card-marathon-session-today').style.boxShadow;

	// Two anchored navigations to the same card inside the 2s flash window: the second flash must
	// not capture the first flash's own outline as the styling to restore.
	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-marathon-session-today' });
	await harness.settleScroll();
	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-marathon-session-today' });
	await harness.settleScroll();
	await new Promise((resolve) => setTimeout(resolve, 2100));

	assert.equal(
		harness.window.document.getElementById('insight-card-marathon-session-today').style.boxShadow,
		before,
		'the card must end up with its original styling, not the focus outline',
	);
});

test('a full stats re-render during the focus window still lands on the insight card', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-stale-skills' });
	await harness.settleScroll();
	harness.scrolledTo.length = 0;

	// A background stats refresh rebuilds the whole layout, destroying the card just scrolled to.
	harness.post({ command: 'updateStats', data: buildStatsWithInsights() });
	await harness.settleScroll();

	assert.ok(
		harness.scrolledTo.includes('insight-card-stale-skills'),
		`the rebuilt card must be scrolled to again, scrolled to: ${JSON.stringify(harness.scrolledTo)}`,
	);
});

test('a re-render after the user switches tabs does not drag them back to the insight', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-stale-skills' });
	await harness.settleScroll();
	harness.window.document.querySelector('.tab-button[data-tab="activity"]')?.click();
	harness.scrolledTo.length = 0;

	harness.post({ command: 'updateInsights', insights: buildStatsWithInsights().insights });
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, [], 'a hidden card must not steal the scroll position');
});

test('clicking away from Insights and back drops the pending deep link', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-stale-skills' });
	await harness.settleScroll();
	// Away and straight back, before any re-render observes the tab change.
	harness.window.document.querySelector('.tab-button[data-tab="activity"]')?.click();
	harness.window.document.querySelector('.tab-button[data-tab="insights"]')?.click();
	harness.scrolledTo.length = 0;

	harness.post({ command: 'updateInsights', insights: buildStatsWithInsights().insights });
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, [], 'the user chose this scroll position; nothing may override it');
});

test('a deep link survives a stats load slower than the re-assert window', async () => {
	// A badge click can reach a webview still on its loading screen, with no insight card in the
	// DOM at all. `pendingTabAnchor` — not the short re-assert window — is what carries the link
	// across the recalculation, and it is only consumed once the element is actually found.
	const harness = await bootWebview(null);

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-marathon-session-today' });
	await new Promise((resolve) => setTimeout(resolve, 4300));
	harness.post({ command: 'updateStats', data: buildStatsWithInsights() });
	await harness.settleScroll();

	assert.ok(
		harness.scrolledTo.includes('insight-card-marathon-session-today'),
		`the slow-loading card must still be scrolled to, scrolled to: ${JSON.stringify(harness.scrolledTo)}`,
	);
});

test('a deep link that never landed is dropped when the user navigates away', async () => {
	// The card does not exist yet, so the request sits in pendingTabAnchor rather than the focus
	// window. renderLayout consumes that without consulting the active tab, so leaving it set
	// would aim the eventual render at a card on a tab the user has since left.
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-not-yet-rendered' });
	harness.window.document.querySelector('.tab-button[data-tab="activity"]')?.click();
	harness.scrolledTo.length = 0;

	// The card finally arrives — too late, the user is reading something else.
	const stats = buildStatsWithInsights();
	(stats.insights as any[]).push({
		id: 'not-yet-rendered', category: 'tools', severity: 'tip',
		title: 'Late arrival', body: '...', status: 'new', allowToast: false,
	});
	harness.post({ command: 'updateStats', data: stats });
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, [], 'a stale deep link must not aim a later render');
});

test('a section deep link that never landed is dropped when the user navigates away', async () => {
	// A conditional section (here one that is never rendered) leaves its anchor in
	// pendingTabAnchor; a later render must not scroll there once the user picked another tab.
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-not-rendered-yet' });
	harness.window.document.querySelector('.tab-button[data-tab="sessions"]')?.click();
	harness.scrolledTo.length = 0;

	const late = harness.window.document.createElement('div');
	late.id = 'section-not-rendered-yet';
	harness.window.document.body.append(late);
	harness.post({ command: 'updateStats', data: buildStatsWithInsights() });
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, [], 'a stale section anchor must not aim a later render');
});

test('cancelPendingNavigation drops a deep link still waiting for its section', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-not-rendered-yet' });
	harness.post({ command: 'cancelPendingNavigation' });
	harness.scrolledTo.length = 0;

	const late = harness.window.document.createElement('div');
	late.id = 'section-not-rendered-yet';
	harness.window.document.body.append(late);
	harness.post({ command: 'updateStats', data: buildStatsWithInsights() });
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, []);
});

test('a section deep link that never landed expires after 60 seconds', async () => {
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-shows-up-much-later' });
	harness.scrolledTo.length = 0;
	// The bundle runs inside jsdom's window, so its clock is that window's Date.
	const webviewDate = (harness.window as unknown as { Date: DateConstructor }).Date;
	const realNow = webviewDate.now;
	webviewDate.now = () => realNow() + 61_000;
	try {
		const late = harness.window.document.createElement('div');
		late.id = 'section-shows-up-much-later';
		harness.window.document.body.append(late);
		harness.post({ command: 'updateStats', data: buildStatsWithInsights() });
		await harness.settleScroll();
	} finally {
		webviewDate.now = realNow;
	}

	assert.deepEqual(harness.scrolledTo, [], 'an expired deep link must not scroll a much later render');
});

test('a section scroll still in its paint delay is cancelled by navigation and by cancelPendingNavigation', async () => {
	// The section exists, so the scroll is already scheduled; acting inside its 50 ms defer
	// must still stop it.
	const byClick = await bootWebview(buildStatsWithInsights());
	byClick.post({ command: 'switchTab', tab: 'activity', anchor: 'section-interaction-modes' });
	byClick.window.document.querySelector('.tab-button[data-tab="sessions"]')?.click();
	await byClick.settleScroll();
	assert.deepEqual(byClick.scrolledTo, [], 'a tab click inside the defer cancels the section scroll');

	const byHost = await bootWebview(buildStatsWithInsights());
	byHost.post({ command: 'switchTab', tab: 'activity', anchor: 'section-interaction-modes' });
	byHost.post({ command: 'cancelPendingNavigation' });
	await byHost.settleScroll();
	assert.deepEqual(byHost.scrolledTo, [], 'the host cancel inside the defer stops the section scroll');
});

test('a second switchTab inside the paint delay replaces the first scroll', async () => {
	const harness = await bootWebview(buildStatsWithInsights());
	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-interaction-modes' });
	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-sessions-summary' });
	await harness.settleScroll();
	assert.deepEqual(harness.scrolledTo, ['section-sessions-summary'], 'only the newer deep link may scroll');
});

test('a newer switchTab whose section is not rendered yet still cancels the older queued scroll', async () => {
	const harness = await bootWebview(buildStatsWithInsights());
	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-interaction-modes' });
	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-not-rendered-yet' });
	await harness.settleScroll();
	assert.deepEqual(harness.scrolledTo, []);
});

test('switchTab still honours a static section anchor', async () => {
	// switchTab clicks the tab button itself, which runs the clear-on-navigation handler, so the
	// anchors are assigned after that click. This pins that ordering: assigning before the click
	// again would have the host's own navigation wipe the anchor it just requested.
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'activity', anchor: 'section-interaction-modes' });
	await harness.settleScroll();

	assert.ok(
		harness.scrolledTo.includes('section-interaction-modes'),
		`the section anchor must still be honoured, scrolled to: ${JSON.stringify(harness.scrolledTo)}`,
	);
});

test('a deep link to an insight that no longer exists opens the tab and scrolls nowhere', async () => {
	// The toast targets the insight it named, by id — so if that insight stopped applying (or was
	// acted on elsewhere) between the toast appearing and "View" being clicked, there is no card
	// to land on. That must degrade to plainly opening the tab, not to scrolling somewhere else.
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-long-gone' });
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, [], 'a missing target must not redirect the scroll');
	assert.equal(
		harness.window.document.getElementById('tab-panel-insights')?.style.display,
		'block',
		'the Insights tab must still be the one showing',
	);
});

test('navigating away inside the deferred scroll cancels it', async () => {
	// The scroll is deferred by 50ms. Clicking a tab inside that window must cancel it, or the
	// timer still fires and drags the user back to a card on the tab they just left.
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-stale-skills' });
	harness.window.document.querySelector('.tab-button[data-tab="activity"]')?.click();
	await harness.settleScroll();

	assert.deepEqual(harness.scrolledTo, [], 'the deferred scroll must not outlive the navigation');
});

test('a deep link stranded past the focus window still lands when its card appears', async () => {
	// switchTab can arrive before the target is in the insights list. The pending anchor then has
	// nothing to consume it, and for an insights-only update refreshInsightsPanel is the only
	// thing that runs — by which time the focus window may long since have lapsed.
	const harness = await bootWebview(buildStatsWithInsights());

	harness.post({ command: 'switchTab', tab: 'insights', anchor: 'insight-card-late-bloomer' });
	await new Promise((resolve) => setTimeout(resolve, 4300));
	harness.scrolledTo.length = 0;

	const insights = buildStatsWithInsights().insights as any[];
	insights.push({
		id: 'late-bloomer', category: 'tools', severity: 'tip',
		title: 'Late bloomer', body: '...', status: 'new', allowToast: false,
	});
	harness.post({ command: 'updateInsights', insights });
	await harness.settleScroll();

	assert.ok(
		harness.scrolledTo.includes('insight-card-late-bloomer'),
		`the card must be scrolled to once it exists, scrolled to: ${JSON.stringify(harness.scrolledTo)}`,
	);
});

test('flashing a second card while the first is still lit restores both', async () => {
	// Rapid clicks landing on *different* insights: the flashes overlap, so the first card's
	// restore timer fires while the second is still outlined. Each element's captured styling is
	// tracked separately, so neither may be left permanently outlined.
	const harness = await bootWebview(buildStatsWithInsights());
	const first = 'insight-card-marathon-session-today';
	const second = 'insight-card-stale-skills';
	const before = {
		first: harness.window.document.getElementById(first).style.boxShadow,
		second: harness.window.document.getElementById(second).style.boxShadow,
	};

	harness.post({ command: 'switchTab', tab: 'insights', anchor: first });
	await harness.settleScroll();
	harness.post({ command: 'switchTab', tab: 'insights', anchor: second });
	await harness.settleScroll();
	await new Promise((resolve) => setTimeout(resolve, 2200));

	assert.equal(harness.window.document.getElementById(first).style.boxShadow, before.first);
	assert.equal(harness.window.document.getElementById(second).style.boxShadow, before.second);
});
