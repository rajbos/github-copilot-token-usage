/**
 * Contract test for the shared-logic split between token counting and model/cost
 * attribution — see ".github/copilot-instructions.md" § "CLI Must Reuse Shared
 * Extension Functions".
 *
 * The canonical split (mirrors getSessionFileDataCached in the VS Code extension):
 *   - Token counts       → estimateTokensFromJsonlSession()  (src/tokenEstimation.ts)
 *   - Model attribution  → getModelUsageFromSession()        (src/usageAnalysis.ts)
 *
 * WHY the contract exists: estimateTokensFromJsonlSession().modelUsage returns {}
 * for delta-format sessions (VS Code Chat JSONL, the `kind: 0/1/2` format). If the
 * CLI ever sourced model attribution from it, every VS Code Chat session would
 * silently report $0 cost. These tests pin both halves of that behaviour and then
 * verify the CLI's own analysis path (processSessionFile) produces non-empty model
 * attribution for a delta-format fixture — proving it goes through
 * getModelUsageFromSession() rather than the estimator's modelUsage.
 */

import test, { type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { calculateEstimatedCost, estimateTokensFromJsonlSession } from '../../../src/tokenEstimation';
import type { ChartDataPayload, DailyTokenStats, ModelUsage } from '../../../src/types';
import { buildChartData } from '../../../src/chartDataBuilder';
import { addSessionToDailyStats, sortedDailyStats } from '../../../src/statsHelpers';
import { getRepoDisplayName } from '../../../src/workspaceHelpers';
import { getModelUsageFromSession } from '../../../src/usageAnalysis';
import tokenEstimatorsData from '../../../src/tokenEstimators.json';
import modelPricingData from '../../../src/modelPricing.json';

import { calculateDailyStats, calculateEfficiencySessionInputs, calculateUsageAnalysisStats, processSessionFile, processSessionFileForViews } from '../helpers';
import { aggregateIntoPeriod, buildChartPayload, buildEfficiencyPayload, createEmptyChartPayload, createEmptyPeriodStats } from '../analysis';
import { disableCache } from '../cliCache';

const tokenEstimators: { [key: string]: number } = tokenEstimatorsData.estimators;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the cast used in cli/src/helpers.ts
const modelPricing = modelPricingData.pricing as { [key: string]: any };

// Compiled test bundles live in cli/out/test/, the fixture stays in cli/src/test/fixtures/.
const FIXTURE_PATH = path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', 'vscode-delta-session.jsonl');

function readFixture(): string {
	return fs.readFileSync(FIXTURE_PATH, 'utf-8');
}

test('fixture is a delta-format VS Code Chat JSONL session', () => {
	const content = readFixture();
	const firstLine = JSON.parse(content.trim().split('\n')[0]);
	// Delta-format sessions always start with a kind:0 initial-state event.
	assert.equal(firstLine.kind, 0, 'fixture must start with a kind:0 event to exercise the delta-format code path');
});

test('estimateTokensFromJsonlSession returns empty modelUsage for delta-format sessions', () => {
	const content = readFixture();
	const result = estimateTokensFromJsonlSession(content);

	// This is the reason the contract exists: the token estimator intentionally does
	// NOT produce model attribution for delta-format (VS Code Chat) sessions.
	assert.deepEqual(result.modelUsage, {}, 'estimateTokensFromJsonlSession().modelUsage must be empty for delta-format sessions — it must never be used as the attribution source');

	// It still produces token counts — that is its job in the split.
	const effectiveTokens = result.actualTokens > 0 ? result.actualTokens : result.tokens;
	assert.ok(effectiveTokens > 0, 'estimateTokensFromJsonlSession should still report token counts for the same session');
});

test('getModelUsageFromSession returns model attribution for the same delta-format session', async () => {
	const content = readFixture();
	const usage = await getModelUsageFromSession(
		{ warn: () => { /* quiet */ }, tokenEstimators, modelPricing, ecosystems: [] },
		FIXTURE_PATH,
		content
	);

	assert.ok(Object.keys(usage).length > 0, 'getModelUsageFromSession must return non-empty attribution for delta-format sessions');
	// modelId "copilot/<model>" is normalized by stripping the "copilot/" prefix.
	assert.ok(usage['gpt-4o'], 'expected gpt-4o attribution from request_fixture-0001');
	assert.equal(usage['gpt-4o'].inputTokens, 120);
	assert.equal(usage['gpt-4o'].outputTokens, 30);
	assert.ok(usage['claude-sonnet-4.5'], 'expected claude-sonnet-4.5 attribution from request_fixture-0002');
	assert.equal(usage['claude-sonnet-4.5'].inputTokens, 80);
	assert.equal(usage['claude-sonnet-4.5'].outputTokens, 25);
});

test('CLI processSessionFile reports model attribution for delta-format sessions', async () => {
	// Bypass the on-disk CLI cache so we exercise the real parsing path.
	disableCache();

	const data = await processSessionFile(FIXTURE_PATH);
	assert.ok(data, 'processSessionFile should parse the fixture');

	// The load-bearing assertion: non-empty model attribution proves the CLI routes
	// attribution through getModelUsageFromSession(). If someone "simplifies" the CLI
	// to use estimateTokensFromJsonlSession().modelUsage instead, this comes back {}
	// and the test fails.
	assert.ok(
		Object.keys(data!.modelUsage).length > 0,
		'CLI produced empty modelUsage for a delta-format session — it must derive attribution from getModelUsageFromSession(), not estimateTokensFromJsonlSession().modelUsage'
	);
	assert.equal(data!.modelUsage['gpt-4o']?.inputTokens, 120);
	assert.equal(data!.modelUsage['gpt-4o']?.outputTokens, 30);
	assert.equal(data!.modelUsage['claude-sonnet-4.5']?.inputTokens, 80);
	assert.equal(data!.modelUsage['claude-sonnet-4.5']?.outputTokens, 25);
	assert.ok(data!.tokens > 0, 'token counts should come from estimateTokensFromJsonlSession');
});

test('CLI usage analysis includes recent-session buckets for thin IDE hosts', async () => {
	disableCache();

	const stats = await calculateUsageAnalysisStats([FIXTURE_PATH]);

	assert.equal(stats.recentSessions?.last7.length, 1);
	assert.equal(stats.recentSessions?.last30.length, 1);
	assert.equal(stats.recentSessions?.currentMonth.length, 1);
	assert.equal(stats.recentSessions?.last7[0].filePath, FIXTURE_PATH);
});

const AUTO_MODEL = 'claude-sonnet-4.5';

function mockAutoSession(t: TestContext, format: 'json' | 'jsonl', debug = false): string {
	disableCache();
	const today = new Date();
	today.setHours(12, 0, 0, 0);
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	const requests = [
		{
			requestId: 'auto', timestamp: yesterday.getTime(), modelId: 'copilot/auto',
			message: { text: 'Auto request', parts: [{ text: 'Auto request' }] },
			response: [{ kind: 'autoModeResolution', resolved: { id: AUTO_MODEL } }],
			result: { promptTokens: 1000, outputTokens: 200 },
		},
		{
			requestId: 'manual', timestamp: today.getTime(), modelId: `copilot/${AUTO_MODEL}`,
			message: { text: 'Manual request', parts: [{ text: 'Manual request' }] },
			response: [], result: { promptTokens: 3000, outputTokens: 600 },
		},
	];
	const content = format === 'json'
		? JSON.stringify({ requests })
		: [
			{ kind: 0, v: { requests: [] } },
			...requests.map(request => ({ kind: 2, k: ['requests'], v: request })),
		].map(event => JSON.stringify(event)).join('\n');
	const sessionId = '11111111-1111-4111-8111-111111111111';
	// Real files (session files are read through the size-guarded reader, which opens a file
	// handle), under cli/out/ rather than os.tmpdir(), which that reader refuses.
	const root = fs.mkdtempSync(path.join(__dirname, 'auto-session-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const hashDir = path.join(root, 'workspaceStorage', 'synthetic');
	const filePath = path.join(hashDir, 'chatSessions', `${sessionId}.${format}`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	if (debug) {
		const debugLog = path.join(hashDir, 'GitHub.copilot-chat', 'debug-logs', sessionId, 'main.jsonl');
		fs.mkdirSync(path.dirname(debugLog), { recursive: true });
		fs.writeFileSync(debugLog, JSON.stringify({
			type: 'llm_request',
			attrs: { model: AUTO_MODEL, inputTokens: 8000, outputTokens: 1600, cachedTokens: 3200 },
		}));
	}
	// Pin mtime to today's noon so daily attribution is deterministic.
	const realStat = fs.statSync(filePath);
	t.mock.method(fs.promises, 'stat', async (file: string) => {
		assert.equal(file, filePath);
		return { ...realStat, mtime: today, mtimeMs: today.getTime() };
	});
	return filePath;
}

function assertAutoDiscount(usage: ModelUsage): void {
	const { autoRouting, ...total } = usage[AUTO_MODEL];
	assert.ok(autoRouting);
	const undiscounted = calculateEstimatedCost({ [AUTO_MODEL]: total }, modelPricing, 'copilot');
	const autoCost = calculateEstimatedCost({ [AUTO_MODEL]: { ...autoRouting, sessions: 0 } }, modelPricing, 'copilot');
	assert.ok(autoCost > 0);
	assert.ok(Math.abs(calculateEstimatedCost(usage, modelPricing, 'copilot') - (undiscounted - 0.1 * autoCost)) < 1e-12);
	assert.equal(
		calculateEstimatedCost(usage, modelPricing, 'provider'),
		calculateEstimatedCost({ [AUTO_MODEL]: total }, modelPricing, 'provider'),
		'Auto routing must not discount provider pricing'
	);
}

for (const format of ['json', 'jsonl'] as const) {
	test(`CLI ${format} ingestion preserves only the Auto request subset`, async t => {
		const data = await processSessionFile(mockAutoSession(t, format));
		assert.ok(data);
		assert.equal(data.modelUsage[AUTO_MODEL].inputTokens, 4000);
		assert.equal(data.modelUsage[AUTO_MODEL].outputTokens, 800);
		assert.deepEqual(data.modelUsage[AUTO_MODEL].autoRouting, { inputTokens: 1000, outputTokens: 200 });
		assertAutoDiscount(data.modelUsage);
	});
}

test('CLI debug replacement preserves the estimated Auto share including cached reads', async t => {
	const data = await processSessionFile(mockAutoSession(t, 'jsonl', true));
	assert.ok(data);
	assert.equal(data.actualTokens, 9600);
	assert.deepEqual(data.modelUsage[AUTO_MODEL], {
		inputTokens: 8000, outputTokens: 1600, cachedReadTokens: 3200, sessions: 0,
		autoRouting: { inputTokens: 2000, outputTokens: 400, cachedReadTokens: 800 },
	});
	assertAutoDiscount(data.modelUsage);
});

test('CLI period aggregation scales Auto tokens without changing session counting', async t => {
	const data = await processSessionFile(mockAutoSession(t, 'jsonl'));
	assert.ok(data);
	data.modelUsage[AUTO_MODEL].sessions = 7;
	const originalUsage = structuredClone(data.modelUsage);
	const period = createEmptyPeriodStats();
	aggregateIntoPeriod(period, data, 0.25);
	assert.deepEqual(period.modelUsage[AUTO_MODEL], {
		inputTokens: 1000, outputTokens: 200, sessions: 0,
		autoRouting: { inputTokens: 250, outputTokens: 50 },
	});
	aggregateIntoPeriod(period, data, 0.75);
	assert.equal(period.sessions, 2);
	assert.equal(period.editorUsage['VS Code'].sessions, 2);
	assert.equal(period.modelUsage[AUTO_MODEL].sessions, 0);
	assert.deepEqual(period.modelUsage[AUTO_MODEL].autoRouting, { inputTokens: 1000, outputTokens: 200 });
	assert.deepEqual(data.modelUsage, originalUsage, 'aggregation must not mutate its source');
	assertAutoDiscount(period.modelUsage);
});

interface CostPeriod {
	totalCost: number;
	totalSessions: number;
	editorCostDatasets: Array<{ label: string; data: number[] }>;
	billingGroupCostDatasets: Array<{ label: string; data: number[] }>;
}

function localDayKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A single day in the `DailyTokenStats` shape the shared chart builder takes. */
function dayStats(date: string, editor: string, usage: ModelUsage, tokens: number): DailyTokenStats {
	return {
		date, tokens, sessions: 1, interactions: 1, modelUsage: usage,
		editorUsage: { [editor]: { tokens, sessions: 1 } },
		repositoryUsage: { Unknown: { tokens, sessions: 1 } },
		editorModelUsage: { [editor]: usage },
	};
}

test('CLI daily, history, weekly, monthly and billing aggregates retain Auto discounts', async t => {
	const days = await calculateDailyStats([mockAutoSession(t, 'jsonl')]);
	assert.equal(days.length, 2);
	assert.deepEqual(days.map(d => d.date), [...days.map(d => d.date)].sort(), 'days must be oldest first');
	for (const entry of days) {
		assert.deepEqual(entry.modelUsage[AUTO_MODEL], {
			inputTokens: 2000, outputTokens: 400, sessions: 1,
			autoRouting: { inputTokens: 500, outputTokens: 100 },
		});
		assert.deepEqual(entry.editorModelUsage?.['VS Code'], entry.modelUsage);
		assert.equal(entry.sessions, 1);
		assertAutoDiscount(entry.modelUsage);
	}
	const originalDays = structuredClone(days);
	const payload = buildChartPayload(days);
	const expectedCost = days.reduce((sum, day) => sum + calculateEstimatedCost(day.modelUsage, modelPricing, 'copilot'), 0);
	for (const period of Object.values(payload.periods) as unknown as CostPeriod[]) {
		assert.ok(Math.abs(period.totalCost - expectedCost) < 1e-12);
		assert.equal(period.totalSessions, 2);
		assert.equal(period.editorCostDatasets.length, 1);
		assert.equal(period.editorCostDatasets[0].label, 'VS Code');
		assert.ok(Math.abs(period.editorCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0) - expectedCost) < 1e-12);
		assert.equal(period.billingGroupCostDatasets.length, 1);
		assert.equal(period.billingGroupCostDatasets[0].label, 'GitHub Copilot');
		assert.ok(Math.abs(period.billingGroupCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0) - expectedCost) < 1e-12);
	}
	assert.deepEqual(days, originalDays, 'building the payload must not mutate its input');
});

test('CLI chart payload is exactly the shared buildChartData() payload for the same days', () => {
	// The CLI used to keep its own builder, which drifted from the extension's more than once
	// (#2304: missing periodKeys blanked the desktop Chart view). It must now only supply host
	// dependencies, so for the same input days the two payloads are identical.
	const now = new Date(2026, 4, 20, 12);
	const usage: ModelUsage = { 'gpt-4o': { inputTokens: 900, outputTokens: 100, sessions: 1 } };
	const days: DailyTokenStats[] = [
		{
			...dayStats('2026-03-02', 'VS Code', usage, 1000),
			repositoryUsage: { 'https://github.com/o/r': { tokens: 1000, sessions: 1, linesAdded: 5, linesRemoved: 1 } },
			linesAdded: 5, linesRemoved: 1, languageUsage: { ts: { linesAdded: 5, linesRemoved: 1 } },
		},
		dayStats('2026-05-19', 'Claude Code', { 'claude-sonnet-4.5': { inputTokens: 400, outputTokens: 50, sessions: 1 } }, 450),
	];
	const extensionPayload = buildChartData(days, {
		getRepoDisplayName,
		calculateEstimatedCost: (mu, source) => calculateEstimatedCost(mu, modelPricing, source),
		backendConfigured: false,
		compactNumbers: false,
		now,
	});
	assert.deepEqual(buildChartPayload(days, { now }), extensionPayload);
});

/** Top-level and per-period fields the chart webview reads (vscode-extension/src/webview/chart/main.ts). */
const CHART_PAYLOAD_KEYS = [
	'labels', 'tokensData', 'sessionsData', 'modelDatasets', 'editorDatasets', 'repositoryDatasets',
	'editorTotalsMap', 'repositoryTotalsMap', 'dailyCount', 'totalTokens', 'avgTokensPerDay',
	'totalSessions', 'lastUpdated', 'backendConfigured', 'compactNumbers', 'periods', 'hasLocData',
];
const CHART_PERIOD_KEYS = [
	'labels', 'periodKeys', 'tokensData', 'sessionsData', 'modelDatasets', 'editorDatasets',
	'repositoryDatasets', 'periodCount', 'totalTokens', 'totalSessions', 'avgPerPeriod', 'costData',
	'totalCost', 'avgCostPerPeriod', 'locData', 'linesAddedData', 'linesRemovedData', 'languageDatasets',
	'locEditorDatasets', 'locRepositoryDatasets', 'editorCostDatasets', 'billingGroupCostDatasets',
	'modelCostDatasets', 'modelSessionsDatasets', 'editorSessionsDatasets', 'providerSessionsDatasets',
	'providerTokensDatasets', 'taskCategoryDatasets', 'taskCategoryTokenDatasets',
	'taskCategorySessionDatasets', 'taskCategoryCostDatasets',
];

function assertChartPayloadShape(payload: ChartDataPayload): void {
	for (const key of CHART_PAYLOAD_KEYS) {
		assert.ok(key in payload, `chart payload is missing "${key}"`);
	}
	for (const name of ['day', 'week', 'month'] as const) {
		const period = payload.periods[name];
		for (const key of CHART_PERIOD_KEYS) {
			assert.ok(key in period, `chart period "${name}" is missing "${key}"`);
		}
		// The chart webview filters each period by time window on `periodKeys` and throws
		// on load without them, which left the desktop app's Chart view blank (#2304).
		assert.equal(period.periodKeys.length, period.labels.length);
		assert.deepEqual(period.periodKeys, [...period.periodKeys].sort());
		assert.equal(period.tokensData.length, period.labels.length);
		assert.equal(period.costData.length, period.labels.length);
	}
}

test('CLI chart payload carries every field the chart webview reads, including periodKeys', () => {
	const key = localDayKey(new Date());
	const payload = buildChartPayload([dayStats(key, 'VS Code', {}, 10)]);
	assertChartPayloadShape(payload);
	assert.equal(payload.periods.day.periodKeys.at(-1), key);
	assert.match(payload.periods.week.periodKeys[0], /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(payload.periods.month.periodKeys.at(-1), key.slice(0, 7));
});

test('CLI empty chart payload has the same shape as a populated one', () => {
	// The zero-state payload used to be a hand-written object without `periods`, so the
	// webview's period filter had nothing to read when no sessions were found.
	const payload = createEmptyChartPayload(new Date(2026, 4, 20, 12));
	assertChartPayloadShape(payload);
	assert.equal(payload.totalTokens, 0);
	assert.equal(payload.periods.day.periodCount, 31);
	assert.equal(payload.periods.week.periodCount, 6);
	assert.equal(payload.periods.month.periodCount, 12);
});

test('CLI daily stats carry task category and lines of code into the chart payload', async t => {
	// The CLI builder used to emit no task / language / lines-of-code data at all, so
	// "By Task" and "By Language" were empty outside the extension (#2316).
	const dailyStatsMap = new Map<string, DailyTokenStats>();
	const today = localDayKey(new Date());
	addSessionToDailyStats(dailyStatsMap, {
		editorType: 'Claude Code',
		tokens: 1000,
		interactions: 4,
		modelUsage: { 'claude-sonnet-4.5': { inputTokens: 900, outputTokens: 100, sessions: 0 } },
		dailyFractions: { [today]: 1 },
		taskCategory: 'Testing',
		linesAdded: 12,
		linesRemoved: 3,
		languageUsage: { ts: { linesAdded: 12, linesRemoved: 3 } },
	});
	const payload = buildChartPayload(sortedDailyStats(dailyStatsMap));
	const day = payload.periods.day;
	assert.equal(payload.hasLocData, true);
	assert.equal(day.totalLinesAdded, 12);
	assert.equal(day.totalLinesRemoved, 3);
	assert.deepEqual((day.languageDatasets as Array<{ label: string }>).map(d => d.label), ['ts']);
	const taskTokens = day.taskCategoryTokenDatasets as Array<{ label: string; data: number[] }>;
	const testing = taskTokens.find(d => d.label === 'Testing');
	assert.ok(testing, 'the session task category must reach the "By Task" datasets');
	assert.equal(testing.data.reduce((a, b) => a + b, 0), 1000);
});

test('CLI view parse attributes a task category; the base parse stays lean', async t => {
	// The usage-analysis pass behind these attributes is only for the Chart and Efficiency
	// payloads, so token-only commands must not pay for it on every cold session.
	const lean = await processSessionFile(mockAutoSession(t, 'jsonl'));
	assert.ok(lean);
	assert.equal(lean.taskCategory, undefined, 'processSessionFile must not run the usage analysis');
	assert.equal(lean.viewAttributesResolved, undefined);
	t.mock.restoreAll();
	const data = await processSessionFileForViews(mockAutoSession(t, 'jsonl'));
	assert.ok(data?.taskCategory, 'processSessionFileForViews must attribute a task category');
	assert.equal(data.viewAttributesResolved, true);
	t.mock.restoreAll();
	const days = await calculateDailyStats([mockAutoSession(t, 'jsonl')]);
	assert.equal(days.length, 2);
	for (const day of days) {
		assert.ok(Object.keys(day.taskCategoryTokens ?? {}).length > 0, `day ${day.date} has no task-category tokens`);
	}
});

test('CLI groups GLM sessions under Z.ai, matching the shared billing helper', () => {
	// The CLI used to keep its own copy of chartDataBuilder's provider-prefix table, which
	// never gained `glm`, so a Mistral Vibe session routed to GLM billed to "Other" here
	// while the extension showed Z.ai. Guards against that copy reappearing.
	const usage: ModelUsage = { 'glm-5-2': { inputTokens: 4000, outputTokens: 800, sessions: 0 } };
	const payload = buildChartPayload([dayStats(localDayKey(new Date()), 'Mistral Vibe', usage, 4800)]);
	for (const period of Object.values(payload.periods) as unknown as CostPeriod[]) {
		assert.equal(period.billingGroupCostDatasets[0].label, 'Z.ai', 'GLM must not fall into the "Other" bucket');
		assert.ok(
			period.billingGroupCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0) > 0,
			'glm-5-2 is priced, so it must contribute non-zero cost',
		);
	}
});

test('CLI provider editor and billing costs remain undiscounted with Auto metadata', () => {
	const usage: ModelUsage = {
		[AUTO_MODEL]: { inputTokens: 4000, outputTokens: 800, sessions: 0, autoRouting: { inputTokens: 1000, outputTokens: 200 } },
	};
	const payload = buildChartPayload([dayStats(localDayKey(new Date()), 'Claude Code', usage, 4800)]);
	const expectedCost = calculateEstimatedCost({ [AUTO_MODEL]: { inputTokens: 4000, outputTokens: 800, sessions: 0 } }, modelPricing, 'provider');
	for (const period of Object.values(payload.periods) as unknown as CostPeriod[]) {
		assert.equal(period.editorCostDatasets[0].label, 'Claude Code');
		assert.equal(period.editorCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0), expectedCost);
		assert.equal(period.billingGroupCostDatasets[0].label, 'Anthropic');
		assert.equal(period.billingGroupCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0), expectedCost);
	}
});

/** Fields the Efficiency webview reads from `window.__INITIAL_EFFICIENCY__` (EfficiencyViewData). */
const EFFICIENCY_PAYLOAD_KEYS = [
	'weekly', 'hasLoc', 'hasDuration', 'hasRetry', 'hasApply', 'attribution', 'attributionWindows',
	'deltas', 'deltaWindows', 'value', 'skillTrends', 'skillImpact', 'hasSkills', 'modelDaily',
	'hasModelComparison', 'dailyVolume', 'sessionSamples', 'editors', 'behaviorWindowDays',
	'cacheBreakage', 'lastUpdated', 'backendConfigured', 'compactNumbers', 'isDebugMode',
];

test('CLI efficiency payload comes from the shared builder with the fields the webview reads', async t => {
	// The Efficiency view used to be assembled only inside the extension class, so the
	// desktop app could not show it at all (#2316). The CLI now gathers the same inputs.
	const file = mockAutoSession(t, 'jsonl');
	const [dailyStats, usage, sessionInputs] = await Promise.all([
		calculateDailyStats([file]),
		calculateUsageAnalysisStats([file]),
		calculateEfficiencySessionInputs([file]),
	]);
	assert.equal(sessionInputs.length, 1);
	assert.equal(sessionInputs[0].editor, 'VS Code');
	assert.equal(sessionInputs[0].interactions, 2);
	assert.equal(sessionInputs[0].dayKey, localDayKey(new Date()), 'a session is dated by its last active day');

	const payload = buildEfficiencyPayload({ dailyStats, usage, sessionInputs });
	for (const key of EFFICIENCY_PAYLOAD_KEYS) {
		assert.ok(key in payload, `efficiency payload is missing "${key}"`);
	}
	assert.deepEqual(payload.sessionSamples, sessionInputs);
	assert.deepEqual(payload.editors, ['VS Code']);
	assert.equal(payload.backendConfigured, false);
	assert.equal(payload.compactNumbers, false);
	assert.equal(payload.behaviorWindowDays, 12 * 7);
	assert.match(payload.attributionWindows.curRange, /^[A-Z][a-z]{2} \d{1,2}, \d{4}–[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
	// No PR data in the CLI: the Value tab must get its "never loaded" nulls, not zeroes.
	assert.equal(payload.value.userPrs, null);
	const volumeTokens = (payload.dailyVolume ?? []).reduce((sum, d) => sum + d.tokens, 0);
	assert.equal(volumeTokens, dailyStats.reduce((sum, d) => sum + d.tokens, 0));
	// Per-model counters reach the Models tab through the shared daily accumulation.
	assert.ok(dailyStats.some(d => d.modelEfficiency && Object.keys(d.modelEfficiency).length > 0));
});
