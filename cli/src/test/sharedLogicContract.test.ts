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
import type { ModelUsage } from '../../../src/types';
import { getModelUsageFromSession } from '../../../src/usageAnalysis';
import tokenEstimatorsData from '../../../src/tokenEstimators.json';
import modelPricingData from '../../../src/modelPricing.json';

import { calculateDailyStats, calculateUsageAnalysisStats, processSessionFile } from '../helpers';
import { aggregateIntoPeriod, buildChartPayload, createEmptyPeriodStats, type DailyEntry } from '../analysis';
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

test('CLI daily, history, weekly, monthly and billing aggregates retain Auto discounts', async t => {
	const { labels, days, allDaysMap } = await calculateDailyStats([mockAutoSession(t, 'jsonl')]);
	assert.equal(allDaysMap.size, 2);
	const populatedDays = days.filter(day => day.sessions > 0);
	assert.equal(populatedDays.length, 2);
	for (const entry of [...populatedDays, ...allDaysMap.values()]) {
		assert.deepEqual(entry.modelUsage[AUTO_MODEL], {
			inputTokens: 2000, outputTokens: 400, sessions: 0,
			autoRouting: { inputTokens: 500, outputTokens: 100 },
		});
		assert.deepEqual(entry.editorModelUsage?.['VS Code'], entry.modelUsage);
		assert.equal(entry.sessions, 1);
		assertAutoDiscount(entry.modelUsage);
	}
	const originalDays = structuredClone(days);
	const payload = buildChartPayload(labels, days, allDaysMap) as { periods: Record<string, CostPeriod> };
	const expectedCost = populatedDays.reduce((sum, day) => sum + calculateEstimatedCost(day.modelUsage, modelPricing, 'copilot'), 0);
	for (const period of Object.values(payload.periods)) {
		assert.ok(Math.abs(period.totalCost - expectedCost) < 1e-12);
		assert.equal(period.totalSessions, 2);
		assert.equal(period.editorCostDatasets.length, 1);
		assert.equal(period.editorCostDatasets[0].label, 'VS Code');
		assert.ok(Math.abs(period.editorCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0) - expectedCost) < 1e-12);
		assert.equal(period.billingGroupCostDatasets.length, 1);
		assert.equal(period.billingGroupCostDatasets[0].label, 'GitHub Copilot');
		assert.ok(Math.abs(period.billingGroupCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0) - expectedCost) < 1e-12);
	}
	assert.deepEqual(days, originalDays);
});

test('CLI chart payload carries sortable period keys for every period', () => {
	// The chart webview filters each period by time window on `periodKeys` and throws
	// on load without them, which left the desktop app's Chart view blank.
	const now = new Date();
	const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	const entry: DailyEntry = { tokens: 10, sessions: 1, modelUsage: {}, editorUsage: {} };
	const payload = buildChartPayload([key], [entry]) as unknown as { periods: Record<string, { labels: string[]; periodKeys: string[] }> };
	for (const period of Object.values(payload.periods)) {
		assert.equal(period.periodKeys.length, period.labels.length);
		assert.deepEqual(period.periodKeys, [...period.periodKeys].sort());
	}
	assert.deepEqual(payload.periods.day.periodKeys, [key]);
	assert.match(payload.periods.week.periodKeys[0], /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(payload.periods.month.periodKeys.at(-1), key.slice(0, 7));
});

test('CLI groups GLM sessions under Z.ai, matching the shared billing helper', () => {
	// The CLI used to keep its own copy of chartDataBuilder's provider-prefix table, which
	// never gained `glm` — so a Mistral Vibe session routed to GLM billed to "Other" here
	// while the extension showed Z.ai. Guards against that copy reappearing.
	const usage: ModelUsage = { 'glm-5-2': { inputTokens: 4000, outputTokens: 800, sessions: 0 } };
	const entry: DailyEntry = {
		tokens: 4800, sessions: 1, modelUsage: usage,
		editorUsage: { 'Mistral Vibe': { tokens: 4800, sessions: 1 } },
		editorModelUsage: { 'Mistral Vibe': usage },
	};
	const today = new Date();
	const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
	const payload = buildChartPayload([key], [entry]) as { periods: Record<string, CostPeriod> };
	for (const period of Object.values(payload.periods)) {
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
	const entry: DailyEntry = {
		tokens: 4800, sessions: 1, modelUsage: usage,
		editorUsage: { 'Claude Code': { tokens: 4800, sessions: 1 } },
		editorModelUsage: { 'Claude Code': usage },
	};
	const today = new Date();
	const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
	const payload = buildChartPayload([key], [entry]) as { periods: Record<string, CostPeriod> };
	const expectedCost = calculateEstimatedCost({ [AUTO_MODEL]: { inputTokens: 4000, outputTokens: 800, sessions: 0 } }, modelPricing, 'provider');
	for (const period of Object.values(payload.periods)) {
		assert.equal(period.editorCostDatasets[0].label, 'Claude Code');
		assert.equal(period.editorCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0), expectedCost);
		assert.equal(period.billingGroupCostDatasets[0].label, 'Anthropic');
		assert.equal(period.billingGroupCostDatasets[0].data.reduce((sum, cost) => sum + cost, 0), expectedCost);
	}
});
