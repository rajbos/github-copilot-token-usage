import test, { before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import tokenEstimatorsData from '../../../src/tokenEstimators.json';
import modelPricingData from '../../../src/modelPricing.json';
import toolNamesData from '../../../src/toolNames.json';
import type { ModelPricing, SessionFileCache, TokenEstimator } from '../../../src/types';
import { buildAdapterRegistry, createDataAccessInstances } from '../../../src/adapters';
import { estimateTokensFromText, NANO_AIU_TO_DOLLARS } from '../../../src/tokenEstimation';
import { isMcpTool, extractMcpServerName } from '../../../src/workspaceHelpers';
import { aggregatePeriodStats, type UtcDateRanges } from '../../../src/statsHelpers';
import { analyzeSessionFile, supplementCacheWithDebugLog, type SessionAnalyzerDeps } from '../../src/analysis/sessionFileAnalyzer';

/**
 * End to end: a Copilot Chat session whose exact billing (copilotUsageNanoAiu) exists ONLY in the
 * debug log must show up in the period totals, which read exact cost from daily rollups alone.
 */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(EXTENSION_ROOT, 'test', 'fixtures', 'sample-session-data', 'chatSessions', 'session-01-today.json');
const SESSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NANO_AIU = 2_500_000_000;
const EXPECTED = NANO_AIU * NANO_AIU_TO_DOLLARS;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

let scratchDir: string;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

before(() => {
	scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debuglog-exact-cost-'));
	// Keep the analyzer from reading the developer's real ~/.copilot session store.
	const emptyHome = path.join(scratchDir, 'home');
	fs.mkdirSync(emptyHome, { recursive: true });
	process.env.HOME = emptyHome;
	process.env.USERPROFILE = emptyHome;
});

after(() => {
	for (const key of ['HOME', 'USERPROFILE'] as const) {
		if (savedHome[key] === undefined) { delete process.env[key]; } else { process.env[key] = savedHome[key]; }
	}
	if (scratchDir) { fs.rmSync(scratchDir, { recursive: true, force: true }); }
});

function buildDeps(): SessionAnalyzerDeps {
	const tokenEstimators = tokenEstimatorsData.estimators as Record<string, TokenEstimator>;
	const toolNameMap = toolNamesData as { [key: string]: string };
	const extensionUri = { fsPath: EXTENSION_ROOT, path: EXTENSION_ROOT, scheme: 'file' };
	return {
		warn: () => undefined,
		tokenEstimators,
		modelPricing: modelPricingData.pricing as { [key: string]: ModelPricing },
		toolNameMap,
		ecosystems: buildAdapterRegistry({
			...createDataAccessInstances(extensionUri),
			estimateTokens: (text, model) => estimateTokensFromText(text, model ?? 'gpt-4', tokenEstimators),
			isMcpTool: (tool) => isMcpTool(tool),
			extractMcpServerName: (tool) => extractMcpServerName(tool, toolNameMap),
		}),
	};
}

/** workspaceStorage/<hash>/chatSessions/<uuid>.json, with the debug log laid out next to it like VS Code does. */
function makeWorkspace(name: string, withDebugLog: boolean): string {
	const hashDir = path.join(scratchDir, name, 'workspaceStorage', 'abc123');
	const chatDir = path.join(hashDir, 'chatSessions');
	fs.mkdirSync(chatDir, { recursive: true });
	const sessionFile = path.join(chatDir, `${SESSION_ID}.json`);
	// The fixture has no per-request timestamps; stamp requests on consecutive days so the cost has to be split across rollups.
	const session = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
	session.requests.forEach((r: { timestamp?: number }, i: number) => { r.timestamp = Date.UTC(2026, 5, 10 + i, 12); });
	fs.writeFileSync(sessionFile, JSON.stringify(session));
	if (withDebugLog) { writeDebugLog(hashDir); }
	return sessionFile;
}

function writeDebugLog(hashDir: string): void {
	const logDir = path.join(hashDir, 'GitHub.copilot-chat', 'debug-logs', SESSION_ID);
	fs.mkdirSync(logDir, { recursive: true });
	const llm = (inputTokens: number, outputTokens: number, copilotUsageNanoAiu: number) =>
		JSON.stringify({ type: 'llm_request', attrs: { model: 'claude-sonnet-4.5', inputTokens, outputTokens, cachedTokens: 0, copilotUsageNanoAiu } });
	fs.writeFileSync(path.join(logDir, 'main.jsonl'), [llm(40_000, 2_000, NANO_AIU / 2), llm(60_000, 3_000, NANO_AIU / 2)].join('\n') + '\n');
}

/** Period totals with "today" = the session's last rolled-up day, so the fixture's fixed dates stay in-window. */
function periodExactCost(session: SessionFileCache): { today: number; month: number; last30: number } {
	const days = Object.keys(session.dailyRollups ?? {}).sort();
	assert.ok(days.length > 1, 'session must have rollups on several days');
	const today = days[days.length - 1];
	const [y, m, d] = today.split('-').map(Number);
	const prevEnd = new Date(Date.UTC(y, m - 1, 0));
	const ranges: UtcDateRanges = {
		todayUtcKey: today,
		monthUtcStartKey: new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10),
		lastMonthUtcStartKey: new Date(Date.UTC(prevEnd.getUTCFullYear(), prevEnd.getUTCMonth(), 1)).toISOString().slice(0, 10),
		lastMonthUtcEndKey: prevEnd.toISOString().slice(0, 10),
		last30DaysUtcStartKey: new Date(Date.UTC(y, m - 1, d - 30)).toISOString().slice(0, 10),
		last30DaysStartMs: Date.UTC(y, m - 1, d - 30),
		lastMonthStartMs: Date.UTC(prevEnd.getUTCFullYear(), prevEnd.getUTCMonth(), 1),
	};
	const result = aggregatePeriodStats([{ editorType: 'vscode', sessionData: session, mtime: Date.UTC(y, m - 1, d, 12) }], ranges);
	return { today: result.todayStats.exactCopilotCostDollars, month: result.monthStats.exactCopilotCostDollars, last30: result.last30DaysStats.exactCopilotCostDollars };
}

/** Month / 30-day totals carry the whole exact cost; "today" carries only the last day's share of it. */
function assertSplitAcrossDays(session: SessionFileCache, cost: { today: number; month: number; last30: number }): void {
	const rollups = session.dailyRollups ?? {};
	const lastDayCost = rollups[Object.keys(rollups).sort().pop()!].copilotExactCostDollars ?? 0;
	assert.ok(close(cost.month, EXPECTED) && close(cost.last30, EXPECTED), JSON.stringify(cost));
	assert.ok(cost.today > 0 && cost.today < EXPECTED && close(cost.today, lastDayCost), JSON.stringify(cost));
}

function rollupCostSum(session: SessionFileCache): number {
	return Object.values(session.dailyRollups ?? {}).reduce((s, d) => s + (d.copilotExactCostDollars ?? 0), 0);
}

test('fresh parse: debug-log-only exact cost reaches rollups and every period total', async () => {
	const file = makeWorkspace('fresh', true);
	const stat = fs.statSync(file);
	const session = await analyzeSessionFile(buildDeps(), file, stat.mtimeMs, stat.size);
	assert.ok(close(session.copilotExactCostDollars ?? 0, EXPECTED), 'session level uses the debug log');
	assert.ok(close(rollupCostSum(session), EXPECTED), `rollups sum to the session cost (got ${rollupCostSum(session)})`);
	const cost = periodExactCost(session);
	assertSplitAcrossDays(session, cost);
});

test('cached supplement: a cached session gains the exact cost in its rollups once the debug log appears', async () => {
	const file = makeWorkspace('supplement', false);
	const stat = fs.statSync(file);
	const cached = await analyzeSessionFile(buildDeps(), file, stat.mtimeMs, stat.size);
	assert.equal(cached.copilotExactCostDollars, undefined, 'no exact cost without a debug log');
	assert.equal(periodExactCost(cached).today, 0);

	writeDebugLog(path.dirname(path.dirname(file)));
	const supplemented = await supplementCacheWithDebugLog(cached, file);
	assert.ok(supplemented, 'debug log should supplement the cache entry');
	assert.ok(close(supplemented.copilotExactCostDollars ?? 0, EXPECTED));
	assert.ok(close(rollupCostSum(supplemented), EXPECTED), `rollups sum to the session cost (got ${rollupCostSum(supplemented)})`);
	const cost = periodExactCost(supplemented);
	assertSplitAcrossDays(supplemented, cost);
});

test('no exact cost anywhere: rollups and period totals carry none (unchanged behaviour)', async () => {
	const file = makeWorkspace('estimate-only', false);
	const stat = fs.statSync(file);
	const session = await analyzeSessionFile(buildDeps(), file, stat.mtimeMs, stat.size);
	assert.ok(Object.values(session.dailyRollups ?? {}).every(d => d.copilotExactCostDollars === undefined));
	assert.deepEqual(periodExactCost(session), { today: 0, month: 0, last30: 0 });
});
