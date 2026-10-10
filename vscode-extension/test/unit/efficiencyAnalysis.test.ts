import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	buildEfficiencyTrends,
	buildSkillUsageTrends,
	computeCostAttribution,
	computeSkillImpact,
	computeEfficiencyDeltas,
	computeValueSignals,
	valueSignalsEqual,
	getTrailingWindowBoundaries,
	splitTrailingWindows,
	computeModelPeriodMetrics,
	listComparableModels,
	compareModels,
	buildModelWeeklySeries,
	listEligibleModels,
	reconcileModelSelection,
	resolveModelCompareWindow,
	selectDaysInWindow,
	windowHasModelData,
	availableResolutions,
	buildEfficiencyBuckets,
	buildEfficiencyBucketSeries,
	buildModelBucketSeries,
	buildSkillUsageSeries,
	drillRangeForBucket,
	efficiencyTodayKey,
	efficiencyRangeSpanDays,
	filterModelsByVendor,
	listEfficiencyEditors,
	listModelVendors,
	UNKNOWN_EDITOR,
	resolveBucketResolution,
	resolveEfficiencyRange,
	selectModelDaysForEditor,
	splitModelDayByEditor,
	toEfficiencyDailyVolume,
	type EfficiencyDeps,
	type ModelCompareSelection,
	type EfficiencySessionInput,
	type ModelDailyInput,
} from '../../../src/efficiencyAnalysis';
import { createEmptyDailyModelEfficiencyEntry } from '../../../src/modelEfficiency';
import type { DailyModelEfficiency, DailyModelEfficiencyEntry, DailyTokenStats, ModelUsage, UsageAnalysisPeriod } from '../../../src/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Fixed "now": Wednesday 2026-07-15 → current week Monday is 2026-07-13.
const NOW = new Date(2026, 6, 15, 12, 0, 0);

/** Prices every model at $10 per million tokens regardless of mix. */
const flatDeps: EfficiencyDeps = {
	calculateEstimatedCost: (mu: ModelUsage) => {
		let tokens = 0;
		for (const u of Object.values(mu)) { tokens += u.inputTokens + u.outputTokens; }
		return (tokens / 1_000_000) * 10;
	},
	now: NOW,
};

function day(date: string, overrides: Partial<DailyTokenStats> = {}): DailyTokenStats {
	return {
		date,
		tokens: 0,
		sessions: 0,
		interactions: 0,
		modelUsage: {},
		editorUsage: {},
		repositoryUsage: {},
		...overrides,
	};
}

function usage(model: string, inputTokens: number, outputTokens: number, sessions = 1): ModelUsage {
	return { [model]: { inputTokens, outputTokens, sessions } };
}

function emptyPeriod(overrides: Partial<UsageAnalysisPeriod> = {}): UsageAnalysisPeriod {
	return {
		sessions: 0,
		toolCalls: { total: 0, byTool: {} },
		modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
		contextReferences: {
			file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
			workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0,
			clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0,
			byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {},
		},
		mcpTools: { total: 0, byServer: {}, byTool: {} },
		modelSwitching: {
			modelsPerSession: [], totalSessions: 0, averageModelsPerSession: 0, maxModelsPerSession: 0,
			minModelsPerSession: 0, switchingFrequency: 0, autoSessions: 0, foundryWindowsSessions: 0,
			unknownProviderSessions: 0, standardModels: [], premiumModels: [], unknownModels: [],
			mixedTierSessions: 0, standardRequests: 0, premiumRequests: 0, unknownRequests: 0,
			totalRequests: 0, lowCostModels: [], mediumCostModels: [], highCostModels: [],
			mixedCostSessions: 0, lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0,
			selectedModelExtensions: [], unknownProviderModels: [],
		},
		repositories: [],
		repositoriesWithCustomization: [],
		editScope: { singleFileEdits: 0, multiFileEdits: 0, totalEditedFiles: 0, avgFilesPerSession: 0 },
		applyUsage: { totalApplies: 0, totalCodeBlocks: 0, applyRate: 0 },
		sessionDuration: { totalDurationMs: 0, avgDurationMs: 0, avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0, activeDurationMs: 0 },
		conversationPatterns: { multiTurnSessions: 0, singleTurnSessions: 0, avgTurnsPerSession: 0, maxTurnsInSession: 0 },
		agentTypes: { editsAgent: 0, defaultAgent: 0, workspaceAgent: 0, other: 0 },
		...overrides,
	};
}

// ── buildEfficiencyTrends ────────────────────────────────────────────────────

test('buildEfficiencyTrends: returns requested number of weeks in order, current week last', () => {
	const weekly = buildEfficiencyTrends([], [], flatDeps, 12);
	assert.equal(weekly.length, 12);
	assert.equal(weekly[11].weekKey, '2026-07-13');
	assert.equal(weekly[0].weekKey, '2026-04-27');
	for (let i = 1; i < weekly.length; i++) {
		assert.ok(weekly[i].weekKey > weekly[i - 1].weekKey);
	}
});

test('buildEfficiencyTrends: computes volume ratios from daily stats', () => {
	// Two days inside the current week (Mon 2026-07-13, Tue 2026-07-14).
	const days = [
		day('2026-07-13', { tokens: 100_000, sessions: 2, interactions: 10, linesAdded: 300, linesRemoved: 200, modelUsage: usage('gpt-5', 60_000, 40_000, 2) }),
		day('2026-07-14', { tokens: 50_000, sessions: 1, interactions: 5, linesAdded: 400, linesRemoved: 100, modelUsage: usage('gpt-5', 30_000, 20_000, 1) }),
	];
	const weekly = buildEfficiencyTrends(days, [], flatDeps, 2);
	const cur = weekly[1];
	assert.equal(cur.sessions, 3);
	assert.equal(cur.tokens, 150_000);
	assert.equal(cur.loc, 1000);
	assert.equal(cur.tokensPerSession, 50_000);
	assert.equal(cur.turnsPerSession, 5);
	// Cost: 150K tokens at $10/M = $1.50 → per 1K LOC = $1.50.
	assert.ok(Math.abs((cur.cost ?? 0) - 1.5) < 1e-9);
	assert.ok(Math.abs((cur.costPerKloc ?? 0) - 1.5) < 1e-9);
	assert.ok(Math.abs((cur.locPerDollar ?? 0) - 1000 / 1.5) < 1e-6);
});

test('buildEfficiencyTrends: ratio fields are null for empty weeks', () => {
	const weekly = buildEfficiencyTrends([], [], flatDeps, 3);
	for (const w of weekly) {
		assert.equal(w.tokensPerSession, null);
		assert.equal(w.turnsPerSession, null);
		assert.equal(w.costPerKloc, null);
		assert.equal(w.activeMinutesPerSession, null);
		assert.equal(w.retryRate, null);
		assert.equal(w.applyRate, null);
	}
});

test('buildEfficiencyTrends: session inputs feed duration, retry, and apply ratios', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', activeDurationMs: 30 * 60_000, editTurns: 4, retries: 2, applies: 3, codeBlocks: 4 },
		{ dayKey: '2026-07-14', activeDurationMs: 10 * 60_000, editTurns: 6, retries: 1, applies: 1, codeBlocks: 4 },
	];
	const weekly = buildEfficiencyTrends([], sessions, flatDeps, 1);
	const cur = weekly[0];
	assert.equal(cur.durationSessions, 2);
	assert.ok(Math.abs((cur.activeMinutesPerSession ?? 0) - 20) < 1e-9);
	assert.equal(cur.editTurns, 10);
	assert.ok(Math.abs((cur.retryRate ?? 0) - 0.3) < 1e-9);
	assert.ok(Math.abs((cur.applyRate ?? 0) - 0.5) < 1e-9);
});

test('buildEfficiencyTrends: retry rate needs a minimum number of edit turns', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', editTurns: 2, retries: 2 },
	];
	const weekly = buildEfficiencyTrends([], sessions, flatDeps, 1);
	assert.equal(weekly[0].retryRate, null);
});

test('buildEfficiencyTrends: sessions without duration data do not dilute the duration average', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', activeDurationMs: 30 * 60_000 },
		{ dayKey: '2026-07-13' }, // no duration recorded
	];
	const weekly = buildEfficiencyTrends([], sessions, flatDeps, 1);
	assert.equal(weekly[0].durationSessions, 1);
	assert.ok(Math.abs((weekly[0].activeMinutesPerSession ?? 0) - 30) < 1e-9);
});

test('buildEfficiencyTrends: days and sessions outside the window are ignored', () => {
	const days = [day('2026-01-01', { tokens: 999, sessions: 9 })];
	const sessions: EfficiencySessionInput[] = [{ dayKey: '2026-01-01', activeDurationMs: 1000 }];
	const weekly = buildEfficiencyTrends(days, sessions, flatDeps, 2);
	assert.equal(weekly.reduce((s, w) => s + w.tokens, 0), 0);
	assert.equal(weekly.reduce((s, w) => s + w.durationSessions, 0), 0);
});

// ── computeCostAttribution ───────────────────────────────────────────────────

/** Deps where cost is driven by a per-model price table (per million tokens). */
function pricedDeps(prices: Record<string, number>): EfficiencyDeps {
	return {
		calculateEstimatedCost: (mu: ModelUsage) => {
			let cost = 0;
			for (const [model, u] of Object.entries(mu)) {
				cost += ((u.inputTokens + u.outputTokens) / 1_000_000) * (prices[model] ?? 0);
			}
			return cost;
		},
		now: NOW,
	};
}

test('computeCostAttribution: effects sum exactly to the cost delta', () => {
	const deps = pricedDeps({ 'expensive': 30, 'cheap': 3 });
	const prevDays = [
		day('2026-06-01', { tokens: 1_000_000, sessions: 10, modelUsage: usage('expensive', 600_000, 400_000, 10) }),
	];
	const curDays = [
		day('2026-07-01', { tokens: 800_000, sessions: 8, modelUsage: usage('cheap', 500_000, 300_000, 8) }),
	];
	const attr = computeCostAttribution(prevDays, curDays, deps);
	assert.ok(attr);
	const sum = attr.volumeEffect + attr.efficiencyEffect + attr.mixEffect;
	assert.ok(Math.abs(sum - attr.deltaCost) < 1e-9, `effects (${sum}) must sum to delta (${attr.deltaCost})`);
	// Prev: $30, cur: $2.40 → cost fell, dominated by the mix effect (30 → 3 $/M).
	assert.ok(Math.abs(attr.prev.cost - 30) < 1e-9);
	assert.ok(Math.abs(attr.cur.cost - 2.4) < 1e-9);
	assert.ok(attr.mixEffect < 0);
});

test('computeCostAttribution: pure volume change lands in volumeEffect only', () => {
	const deps = pricedDeps({ m: 10 });
	// Same tokens/session and same model — only session count doubles.
	const prevDays = [day('2026-06-01', { tokens: 500_000, sessions: 5, modelUsage: usage('m', 300_000, 200_000, 5) })];
	const curDays = [day('2026-07-01', { tokens: 1_000_000, sessions: 10, modelUsage: usage('m', 600_000, 400_000, 10) })];
	const attr = computeCostAttribution(prevDays, curDays, deps);
	assert.ok(attr);
	assert.ok(Math.abs(attr.efficiencyEffect) < 1e-9);
	assert.ok(Math.abs(attr.mixEffect) < 1e-9);
	assert.ok(Math.abs(attr.volumeEffect - attr.deltaCost) < 1e-9);
});

test('computeCostAttribution: null when either window is empty', () => {
	const deps = pricedDeps({ m: 10 });
	const days = [day('2026-07-01', { tokens: 1000, sessions: 1, modelUsage: usage('m', 600, 400) })];
	assert.equal(computeCostAttribution([], days, deps), null);
	assert.equal(computeCostAttribution(days, [], deps), null);
});

test('computeCostAttribution: reports the largest model mix shifts', () => {
	const deps = pricedDeps({ a: 10, b: 10 });
	const prevDays = [day('2026-06-01', { tokens: 1_000_000, sessions: 10, modelUsage: { ...usage('a', 500_000, 300_000, 8), ...usage('b', 150_000, 50_000, 2) } })];
	const curDays = [day('2026-07-01', { tokens: 1_000_000, sessions: 10, modelUsage: { ...usage('a', 150_000, 50_000, 2), ...usage('b', 500_000, 300_000, 8) } })];
	const attr = computeCostAttribution(prevDays, curDays, deps);
	assert.ok(attr);
	assert.equal(attr.modelShifts.length, 2);
	const shiftA = attr.modelShifts.find(s => s.model === 'a');
	assert.ok(shiftA);
	assert.ok(shiftA.deltaShare < 0);
});

test('computeCostAttribution: model shifts stay canonical — raw ids, no host-resolved names', () => {
	// The host has no pricing map to resolve names against (window.__MODEL_PRICING__
	// only exists in the webview), so the analytics layer deliberately emits the raw
	// id and lets the view resolve it. A friendly name appearing here would mean the
	// resolver moved back to the host and silently degraded to raw ids in production.
	const deps = pricedDeps({ 'gpt-4o': 10, 'claude-sonnet-4.5': 10 });
	const prevDays = [day('2026-06-01', { tokens: 1_000_000, sessions: 10, modelUsage: { ...usage('gpt-4o', 500_000, 300_000, 8), ...usage('claude-sonnet-4.5', 150_000, 50_000, 2) } })];
	const curDays = [day('2026-07-01', { tokens: 1_000_000, sessions: 10, modelUsage: { ...usage('gpt-4o', 150_000, 50_000, 2), ...usage('claude-sonnet-4.5', 500_000, 300_000, 8) } })];
	const attr = computeCostAttribution(prevDays, curDays, deps);
	assert.ok(attr);
	assert.deepEqual(attr.modelShifts.map(s => s.model).sort(), ['claude-sonnet-4.5', 'gpt-4o']);
	for (const s of attr.modelShifts) {
		assert.deepEqual(
			Object.keys(s).sort(),
			['curShare', 'curTokens', 'deltaShare', 'model', 'prevShare', 'prevTokens'],
		);
	}
});

test('computeCostAttribution: keeps the 0.5-point noise threshold, |delta| sort and six-row cap', () => {
	// Shares in percentage points; each period totals 100, so a model's delta is
	// exactly the difference between its two entries. 'quiet' moves 0.4 points —
	// just under the noise gate — while eight others move 5 points or more.
	const prevShares: Record<string, number> = { m0: 20, m1: 20, m2: 15, m3: 15, m4: 10, m5: 10, m6: 5, m7: 4.6, quiet: 0.4 };
	const curShares: Record<string, number> = { m0: 12, m1: 13, m2: 9, m3: 10, m4: 15, m5: 16, m6: 11, m7: 13.2, quiet: 0.8 };
	const deps = pricedDeps(Object.fromEntries(Object.keys(prevShares).map(m => [m, 10])));
	const toUsage = (shares: Record<string, number>): ModelUsage =>
		Object.assign({}, ...Object.entries(shares).map(([m, pts]) => usage(m, pts * 10_000, 0, 1)));
	const attr = computeCostAttribution(
		[day('2026-06-01', { tokens: 1_000_000, sessions: 9, modelUsage: toUsage(prevShares) })],
		[day('2026-07-01', { tokens: 1_000_000, sessions: 9, modelUsage: toUsage(curShares) })],
		deps,
	);
	assert.ok(attr);
	assert.equal(attr.modelShifts.length, 6, 'capped at the six largest movements');
	assert.ok(!attr.modelShifts.some(s => s.model === 'quiet'), 'sub-half-point movement is filtered as noise');
	const magnitudes = attr.modelShifts.map(s => Math.abs(s.deltaShare));
	assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a), 'sorted by |deltaShare|, largest first');
	for (const s of attr.modelShifts) {
		assert.ok(Math.abs(s.deltaShare) >= 0.005);
	}
	// The two smallest qualifying movements (5 points each) fall off the cap.
	assert.ok(!attr.modelShifts.some(s => s.model === 'm3' || s.model === 'm4'));
});

// ── splitTrailingWindows ─────────────────────────────────────────────────────

test('splitTrailingWindows: partitions days into trailing and previous 30-day windows', () => {
	const days = [
		day('2026-07-15'), // today → current
		day('2026-06-16'), // 29 days back → current
		day('2026-06-15'), // 30 days back → previous
		day('2026-05-17'), // 59 days back → previous
		day('2026-05-16'), // 60 days back → outside
		day('2026-07-16'), // future → outside
	];
	const { prevDays, curDays } = splitTrailingWindows(days, NOW);
	assert.deepEqual(curDays.map(d => d.date).sort(), ['2026-06-16', '2026-07-15']);
	assert.deepEqual(prevDays.map(d => d.date).sort(), ['2026-05-17', '2026-06-15']);
});

test('getTrailingWindowBoundaries: returns adjacent inclusive 30-day ranges', () => {
	const boundaries = getTrailingWindowBoundaries(NOW);
	assert.deepEqual(
		[
			boundaries.prevStart,
			boundaries.prevEnd,
			boundaries.curStart,
			boundaries.curEnd,
			].map(d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`),
		['2026-05-17', '2026-06-15', '2026-06-16', '2026-07-15'],
	);
});

// ── computeEfficiencyDeltas ──────────────────────────────────────────────────

function periodWithMetrics(sessions: number, turns: number, activeMs: number, retries: number, editTurns: number, lowReq: number, midReq: number, highReq: number, applies: number, blocks: number): UsageAnalysisPeriod {
	const p = emptyPeriod({ sessions });
	p.conversationPatterns = { multiTurnSessions: sessions, singleTurnSessions: 0, avgTurnsPerSession: turns, maxTurnsInSession: turns };
	p.sessionDuration = { totalDurationMs: activeMs, avgDurationMs: activeMs / Math.max(1, sessions), avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0, activeDurationMs: activeMs };
	p.modelEfficiency = { m: { calls: editTurns, editTurns, oneShotEditTurns: editTurns - retries, retries, selfCorrections: 0, editToolCalls: editTurns, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cost: 0 } };
	p.modelSwitching.lowCostRequests = lowReq;
	p.modelSwitching.mediumCostRequests = midReq;
	p.modelSwitching.highCostRequests = highReq;
	p.applyUsage = { totalApplies: applies, totalCodeBlocks: blocks, applyRate: blocks > 0 ? (applies / blocks) * 100 : 0 };
	return p;
}

test('computeEfficiencyDeltas: improvement flags follow the good direction', () => {
	const prev = periodWithMetrics(20, 10, 20 * 40 * 60_000, 10, 20, 10, 30, 60, 10, 40);
	const cur = periodWithMetrics(20, 6, 20 * 25 * 60_000, 4, 20, 60, 30, 10, 30, 40);
	const deltas = computeEfficiencyDeltas(cur, prev);
	const byId = new Map(deltas.map(d => [d.id, d]));

	const turns = byId.get('turns-per-session')!;
	assert.equal(turns.improved, true); // 10 → 6, down is good
	const minutes = byId.get('active-minutes-per-session')!;
	assert.equal(minutes.improved, true); // 40 → 25 min
	const retry = byId.get('retry-rate')!;
	assert.equal(retry.improved, true); // 0.5 → 0.2
	const lowCost = byId.get('low-cost-share')!;
	assert.equal(lowCost.improved, true); // 10% → 60%, up is good
	const apply = byId.get('apply-rate')!;
	assert.equal(apply.improved, true); // 25% → 75%
});

test('computeEfficiencyDeltas: too few sessions yields null values', () => {
	const prev = periodWithMetrics(2, 10, 100, 1, 20, 20, 0, 0, 5, 10);
	const cur = periodWithMetrics(20, 6, 100, 1, 20, 20, 0, 0, 5, 10);
	const deltas = computeEfficiencyDeltas(cur, prev);
	for (const d of deltas) {
		assert.equal(d.prev, null, `${d.id} prev should be gated`);
		assert.equal(d.deltaPct, null);
		assert.equal(d.improved, null);
	}
});

test('computeEfficiencyDeltas: volume totals add tokens- and cost-per-session cards', () => {
	const prev = periodWithMetrics(20, 10, 100, 1, 20, 20, 0, 0, 5, 10);
	const cur = periodWithMetrics(20, 6, 100, 1, 20, 20, 0, 0, 5, 10);
	const deltas = computeEfficiencyDeltas(cur, prev,
		{ tokens: 1_000_000, sessions: 20, estimatedCost: 10 },
		{ tokens: 3_000_000, sessions: 20, estimatedCost: 30 });
	const tokens = deltas.find(d => d.id === 'tokens-per-session')!;
	assert.equal(tokens.prev, 150_000);
	assert.equal(tokens.cur, 50_000);
	assert.equal(tokens.improved, true);
	const cost = deltas.find(d => d.id === 'cost-per-session')!;
	assert.ok(Math.abs((cost.cur ?? 0) - 0.5) < 1e-9);
	assert.equal(cost.improved, true);
});

test('computeEfficiencyDeltas: regressions are flagged as not improved', () => {
	const prev = periodWithMetrics(20, 6, 20 * 25 * 60_000, 4, 20, 60, 30, 10, 30, 40);
	const cur = periodWithMetrics(20, 10, 20 * 40 * 60_000, 10, 20, 10, 30, 60, 10, 40);
	const deltas = computeEfficiencyDeltas(cur, prev);
	const turns = deltas.find(d => d.id === 'turns-per-session')!;
	assert.equal(turns.improved, false);
});

// ── computeValueSignals ──────────────────────────────────────────────────────

test('computeValueSignals: merged PRs drive the rate and cost-per-PR metrics', () => {
	const since = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000).toISOString();
	const v = computeValueSignals({
		userPrs: 10, mergedPrs: 6, aiPrs: 0, prsSince: since, periodCost: 12,
		applyUsage: { totalApplies: 30, totalCodeBlocks: 40, applyRate: 75 },
		linesChanged: 3000, now: NOW,
	});
	assert.equal(v.userPrs, 10);
	assert.equal(v.mergedPrs, 6);
	assert.ok(Math.abs((v.prsPerWeek ?? 0) - 6 / (30 / 7)) < 1e-9, 'rate uses merged, not authored');
	assert.ok(Math.abs((v.costPerMergedPr ?? 0) - 2) < 1e-9);
	assert.ok(Math.abs((v.applyRate ?? 0) - 0.75) < 1e-9);
	assert.ok(Math.abs((v.locPerDollar ?? 0) - 250) < 1e-9);
});

test('computeValueSignals: zero AI-authored PRs still yields real user PR value', () => {
	// The common local-AI workflow: no bot-opened PRs, but plenty of shipped work.
	const since = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000).toISOString();
	const v = computeValueSignals({
		userPrs: 12, mergedPrs: 9, aiPrs: 0, prsSince: since, periodCost: 90,
		linesChanged: 5000, now: NOW,
	});
	assert.equal(v.aiPrs, 0);
	assert.equal(v.mergedPrs, 9);
	assert.ok(Math.abs((v.costPerMergedPr ?? 0) - 10) < 1e-9);
	assert.ok((v.prsPerWeek ?? 0) > 0);
});

test('computeValueSignals: falls back to authored PRs when merge state is unavailable', () => {
	const since = new Date(NOW.getTime() - 7 * 24 * 3600 * 1000).toISOString();
	const v = computeValueSignals({
		userPrs: 7, mergedPrs: null, aiPrs: null, prsSince: since, periodCost: 10,
		linesChanged: 0, now: NOW,
	});
	assert.ok(Math.abs((v.prsPerWeek ?? 0) - 7) < 1e-9);
	assert.equal(v.costPerMergedPr, null, 'no merge data means no cost-per-merged-PR');
});

test('computeValueSignals: PR metrics are null when PR stats were never loaded', () => {
	const v = computeValueSignals({
		userPrs: null, mergedPrs: null, aiPrs: null, prsSince: null,
		periodCost: 12, linesChanged: 0, now: NOW,
	});
	assert.equal(v.userPrs, null);
	assert.equal(v.prsPerWeek, null);
	assert.equal(v.costPerMergedPr, null);
	assert.equal(v.applyRate, null);
	assert.equal(v.locPerDollar, null);
});

test('computeValueSignals: zero merged PRs yields null cost per PR (no divide by zero)', () => {
	const since = new Date(NOW.getTime() - 7 * 24 * 3600 * 1000).toISOString();
	const v = computeValueSignals({
		userPrs: 2, mergedPrs: 0, aiPrs: 0, prsSince: since, periodCost: 12,
		linesChanged: 0, now: NOW,
	});
	assert.equal(v.mergedPrs, 0);
	assert.equal(v.costPerMergedPr, null);
	assert.equal(v.prsPerWeek, 0);
});

// ── buildSkillUsageTrends ────────────────────────────────────────────────────

test('buildSkillUsageTrends: buckets skill calls by week and computes session share', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', skillCalls: { graphify: 2 } },
		{ dayKey: '2026-07-14', skillCalls: { impeccable: 1 } },
		{ dayKey: '2026-07-14' }, // session without skills
		{ dayKey: '2026-07-06', skillCalls: { graphify: 1 } }, // previous week
	];
	const trends = buildSkillUsageTrends(sessions, flatDeps, 2);
	assert.equal(trends.totalCalls, 4);
	assert.deepEqual(trends.topSkills, ['graphify', 'impeccable']);

	const prevWeek = trends.weeks[0];
	assert.equal(prevWeek.weekKey, '2026-07-06');
	assert.equal(prevWeek.totalCalls, 1);
	assert.equal(prevWeek.skillSessions, 1);
	assert.equal(prevWeek.trackedSessions, 1);
	assert.equal(prevWeek.skillShare, 1);

	const curWeek = trends.weeks[1];
	assert.equal(curWeek.totalCalls, 3);
	assert.equal(curWeek.skillSessions, 2);
	assert.equal(curWeek.trackedSessions, 3);
	assert.ok(Math.abs((curWeek.skillShare ?? 0) - 2 / 3) < 1e-9);
	assert.deepEqual(curWeek.byName, { graphify: 2, impeccable: 1 });
});

test('buildSkillUsageTrends: empty input yields zeroed weeks and no top skills', () => {
	const trends = buildSkillUsageTrends([], flatDeps, 3);
	assert.equal(trends.weeks.length, 3);
	assert.equal(trends.totalCalls, 0);
	assert.deepEqual(trends.topSkills, []);
	for (const w of trends.weeks) {
		assert.equal(w.skillShare, null);
	}
});

test('buildSkillUsageTrends: zero-count skill entries are ignored', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', skillCalls: { graphify: 0 } },
	];
	const trends = buildSkillUsageTrends(sessions, flatDeps, 1);
	assert.equal(trends.totalCalls, 0);
	assert.equal(trends.weeks[0].skillSessions, 0);
	assert.equal(trends.weeks[0].trackedSessions, 1);
});

// ── computeSkillImpact ───────────────────────────────────────────────────────

function skillSession(skill: string | null, interactions: number, tokens: number, activeMin: number, editTurns: number, retries: number): EfficiencySessionInput {
	return {
		dayKey: '2026-07-13',
		interactions,
		totalTokens: tokens,
		activeDurationMs: activeMin * 60_000,
		editTurns,
		retries,
		...(skill ? { skillCalls: { [skill]: 1 } } : {}),
	};
}

test('computeSkillImpact: compares with/without cohorts and flags favourable differences', () => {
	// 5 sessions with graphify: leaner (4 turns, 50K tokens, 15 min, no retries).
	// 5 sessions without: heavier (10 turns, 200K tokens, 45 min, 50% retry rate).
	const sessions: EfficiencySessionInput[] = [
		...Array.from({ length: 5 }, () => skillSession('graphify', 4, 50_000, 15, 4, 0)),
		...Array.from({ length: 5 }, () => skillSession(null, 10, 200_000, 45, 4, 2)),
	];
	const impacts = computeSkillImpact(sessions);
	assert.equal(impacts.length, 1);
	const g = impacts[0];
	assert.equal(g.skill, 'graphify');
	assert.equal(g.withSkill.sessions, 5);
	assert.equal(g.withoutSkill.sessions, 5);
	assert.equal(g.withSkill.avgTurns, 4);
	assert.equal(g.withoutSkill.avgTurns, 10);
	assert.equal(g.withSkill.retryRate, 0);
	assert.equal(g.withoutSkill.retryRate, 0.5);
	const turns = g.metrics.find(m => m.id === 'turns')!;
	assert.equal(turns.favorable, true);
	assert.ok(Math.abs((turns.deltaPct ?? 0) + 60) < 1e-9); // 4 vs 10 → −60%
	const retry = g.metrics.find(m => m.id === 'retry-rate')!;
	assert.equal(retry.favorable, true);
});

test('computeSkillImpact: skills below the session floor are omitted', () => {
	const sessions: EfficiencySessionInput[] = [
		...Array.from({ length: 4 }, () => skillSession('graphify', 4, 50_000, 15, 0, 0)),
		...Array.from({ length: 10 }, () => skillSession(null, 10, 200_000, 45, 0, 0)),
	];
	assert.deepEqual(computeSkillImpact(sessions), []);
});

test('computeSkillImpact: requires enough sessions on the without side too', () => {
	const sessions: EfficiencySessionInput[] = [
		...Array.from({ length: 6 }, () => skillSession('graphify', 4, 50_000, 15, 0, 0)),
		...Array.from({ length: 2 }, () => skillSession(null, 10, 200_000, 45, 0, 0)),
	];
	assert.deepEqual(computeSkillImpact(sessions), []);
});

test('computeSkillImpact: unfavourable differences are flagged red', () => {
	// Skill sessions are heavier than the rest.
	const sessions: EfficiencySessionInput[] = [
		...Array.from({ length: 5 }, () => skillSession('impeccable', 12, 300_000, 50, 0, 0)),
		...Array.from({ length: 5 }, () => skillSession(null, 5, 60_000, 20, 0, 0)),
	];
	const impacts = computeSkillImpact(sessions);
	assert.equal(impacts.length, 1);
	const turns = impacts[0].metrics.find(m => m.id === 'turns')!;
	assert.equal(turns.favorable, false);
});

// ── Model comparison ─────────────────────────────────────────────────────────

function modelDay(date: string, models: { [model: string]: Partial<DailyModelEfficiencyEntry> }, taskCategoryUsage?: DailyTokenStats['taskCategoryUsage']): DailyTokenStats {
	const modelEfficiency: DailyModelEfficiency = {};
	for (const [model, overrides] of Object.entries(models)) {
		modelEfficiency[model] = { ...createEmptyDailyModelEfficiencyEntry(), ...overrides };
	}
	return {
		date, tokens: 0, sessions: 0, interactions: 0,
		modelUsage: {}, editorUsage: {}, repositoryUsage: {},
		modelEfficiency, ...(taskCategoryUsage ? { taskCategoryUsage } : {}),
	};
}

/** A model profile that clears both sample floors, with the given overrides applied. */
function solidModel(overrides: Partial<DailyModelEfficiencyEntry>): Partial<DailyModelEfficiencyEntry> {
	return {
		sessions: 10, sessionShare: 10, calls: 40, editTurns: 20, oneShotEditTurns: 15,
		retries: 5, inputTokens: 900_000, outputTokens: 100_000, cost: 10,
		linesAdded: 800, linesRemoved: 200, durationSessionShare: 10, activeDurationMs: 10 * 600_000,
		applies: 40, codeBlocks: 50,
		...overrides,
	};
}

test('computeModelPeriodMetrics: returns null for a model absent from the window', () => {
	const days = [modelDay('2026-07-01', { a: solidModel({}) })];
	assert.equal(computeModelPeriodMetrics(days, 'missing', 'Jul'), null);
});

test('computeModelPeriodMetrics: aggregates across days and derives ratios', () => {
	const days = [
		modelDay('2026-07-01', { kimi: solidModel({}) }),
		modelDay('2026-07-02', { kimi: solidModel({}) }),
	];
	const m = computeModelPeriodMetrics(days, 'kimi', 'Jul')!;
	assert.equal(m.sessionShare, 20);
	assert.equal(m.editTurns, 40);
	assert.equal(m.cost, 20);
	assert.equal(m.tokens, 2_000_000);
	assert.equal(m.costPerEditTurn, 0.5);            // $20 / 40 edit turns
	assert.equal(m.costPerSession, 1);               // $20 / 20 session equivalents
	assert.equal(m.costPerKloc, 10);                 // $20 / 2000 lines * 1000
	assert.equal(m.dollarsPerMTokens, 10);
	assert.equal(m.oneShotRate, 0.75);               // 30 / 40
	assert.equal(m.retryRate, 0.25);                 // 10 / 40
	assert.equal(m.activeMinutesPerSession, 10);     // 600_000ms per session equivalent
	assert.equal(m.applyRate, 0.8);                  // 80 / 100
	assert.ok(m.sampleSufficient && m.editSampleSufficient);
});

test('computeModelPeriodMetrics: suppresses ratios that fall below the sample floors', () => {
	const days = [modelDay('2026-07-01', { rare: { ...createEmptyDailyModelEfficiencyEntry(), sessions: 1, sessionShare: 1, editTurns: 2, retries: 1, cost: 3, inputTokens: 1000, linesAdded: 10 } })];
	const m = computeModelPeriodMetrics(days, 'rare', 'Jul')!;
	assert.equal(m.sampleSufficient, false);
	assert.equal(m.editSampleSufficient, false);
	assert.equal(m.retryRate, null);
	assert.equal(m.costPerEditTurn, null);
	assert.equal(m.costPerSession, null);
	// Price per token needs no behavioural sample, so it still reports.
	assert.ok(m.dollarsPerMTokens !== null);
});

test('computeModelPeriodMetrics: caps cache read share at 1.0', () => {
	const days = [modelDay('2026-07-01', { a: solidModel({ inputTokens: 1000, cachedReadTokens: 5000 }) })];
	assert.equal(computeModelPeriodMetrics(days, 'a', 'Jul')!.cacheReadShare, 1);
});

test('computeModelPeriodMetrics: attributes task mix by the model share of the day', () => {
	const days = [modelDay('2026-07-01',
		{ a: solidModel({ inputTokens: 750_000, outputTokens: 0 }), b: solidModel({ inputTokens: 250_000, outputTokens: 0 }) },
		{ Coding: { tokens: 800, sessions: 1 }, Debugging: { tokens: 200, sessions: 1 } },
	)];
	const m = computeModelPeriodMetrics(days, 'a', 'Jul')!;
	// Shares are normalized within the model, so the mix matches the day's mix.
	assert.equal(m.taskMix['Coding'], 0.8);
	assert.equal(m.taskMix['Debugging'], 0.2);
});

test('listComparableModels: sorts by tokens and flags models below the sample floor', () => {
	const days = [modelDay('2026-07-01', {
		small: { ...createEmptyDailyModelEfficiencyEntry(), sessionShare: 1, inputTokens: 100 },
		big: solidModel({}),
	})];
	const models = listComparableModels(days);
	assert.deepEqual(models.map(m => m.model), ['big', 'small']);
	assert.equal(models[0].sampleSufficient, true);
	assert.equal(models[1].sampleSufficient, false);
});

test('compareModels: picks the winner per metric respecting each metric direction', () => {
	const a = computeModelPeriodMetrics([modelDay('2026-07-01', { a: solidModel({ cost: 20 }) })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics([modelDay('2026-07-01', { b: solidModel({ cost: 10 }) })], 'b', 'Jul')!;
	const cmp = compareModels(a, b);

	const cost = cmp.rows.find(r => r.id === 'cost-per-edit-turn')!;
	assert.equal(cost.a, 1);
	assert.equal(cost.b, 0.5);
	assert.equal(cost.deltaPct, -50);
	assert.equal(cost.winner, 'b');   // cheaper is better
	assert.equal(cost.significant, true);

	// Identical one-shot rates are a tie, not a win.
	const oneShot = cmp.rows.find(r => r.id === 'one-shot-rate')!;
	assert.equal(oneShot.winner, 'tie');
	assert.equal(oneShot.significant, false);
});

test('compareModels: higher-is-better metrics award the win to the larger value', () => {
	const a = computeModelPeriodMetrics([modelDay('2026-07-01', { a: solidModel({ oneShotEditTurns: 4 }) })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics([modelDay('2026-07-01', { b: solidModel({ oneShotEditTurns: 18 }) })], 'b', 'Jul')!;
	const oneShot = compareModels(a, b).rows.find(r => r.id === 'one-shot-rate')!;
	assert.equal(oneShot.winner, 'b');
	assert.equal(oneShot.significant, true);
});

test('compareModels: nulls stay null and never produce a winner', () => {
	const a = computeModelPeriodMetrics([modelDay('2026-07-01', { a: solidModel({}) })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics([modelDay('2026-07-01', { b: { ...createEmptyDailyModelEfficiencyEntry(), sessionShare: 1, editTurns: 1, cost: 1, inputTokens: 10 } })], 'b', 'Jul')!;
	const cost = compareModels(a, b).rows.find(r => r.id === 'cost-per-edit-turn')!;
	assert.equal(cost.b, null);
	assert.equal(cost.winner, null);
	assert.equal(cost.significant, false);
});

test('compareModels: verdict counts significant wins on each side', () => {
	// b is cheaper (wins cost rows) but retries far more (loses quality rows).
	const a = computeModelPeriodMetrics([modelDay('2026-07-01', { a: solidModel({ cost: 40 }) })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics([modelDay('2026-07-01', { b: solidModel({ cost: 10, retries: 18, oneShotEditTurns: 2 }) })], 'b', 'Jul')!;
	const cmp = compareModels(a, b);
	assert.ok(cmp.verdict !== null);
	assert.ok(cmp.verdict!.wins.a > 0, 'a should win the quality rows');
	assert.ok(cmp.verdict!.wins.b > 0, 'b should win the cost rows');
});

test('compareModels: verdict is null when nothing clears the noise band', () => {
	const a = computeModelPeriodMetrics([modelDay('2026-07-01', { a: solidModel({}) })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics([modelDay('2026-07-01', { b: solidModel({}) })], 'b', 'Jul')!;
	assert.equal(compareModels(a, b).verdict, null);
});

test('compareModels: raises a caveat when a side is below the sample floor', () => {
	const a = computeModelPeriodMetrics([modelDay('2026-07-01', { a: solidModel({}) })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics([modelDay('2026-07-01', { b: { ...createEmptyDailyModelEfficiencyEntry(), sessionShare: 1, editTurns: 1, inputTokens: 10 } })], 'b', 'Jul')!;
	const cmp = compareModels(a, b);
	assert.ok(cmp.caveats.some(c => c.includes('session equivalents')));
	assert.ok(cmp.caveats.some(c => c.includes('edit turns')));
});

test('compareModels: raises a caveat when the two sides did different kinds of work', () => {
	const a = computeModelPeriodMetrics(
		[modelDay('2026-07-01', { a: solidModel({}) }, { Coding: { tokens: 1000, sessions: 1 } })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics(
		[modelDay('2026-07-01', { b: solidModel({}) }, { Debugging: { tokens: 1000, sessions: 1 } })], 'b', 'Jul')!;
	assert.ok(compareModels(a, b).caveats.some(c => c.includes('task-mix')));
});

test('compareModels: warns when the usage is dominated by mixed-model sessions', () => {
	// 20 sessions touched the model but they are worth only 5 session equivalents.
	const mixed = solidModel({ sessions: 20, sessionShare: 5 });
	const a = computeModelPeriodMetrics([modelDay('2026-07-01', { a: mixed })], 'a', 'Jul')!;
	const b = computeModelPeriodMetrics([modelDay('2026-07-01', { b: solidModel({}) })], 'b', 'Jul')!;
	assert.ok(compareModels(a, b).caveats.some(c => c.includes('mixed several models')));
});

test('buildModelWeeklySeries: buckets days into weeks and gaps unused weeks', () => {
	// NOW is Wed 2026-07-15, so the last bucket is the week of Mon 2026-07-13.
	const days = [
		modelDay('2026-07-14', { kimi: solidModel({ cost: 10 }) }),
		modelDay('2026-07-07', { kimi: solidModel({ cost: 20 }) }),
	];
	const series = buildModelWeeklySeries(days, 'kimi', NOW, 3);
	assert.equal(series.length, 3);
	assert.equal(series[0].metrics, null);              // week of Jun 29 — unused
	assert.equal(series[1].metrics!.cost, 20);          // week of Jul 6
	assert.equal(series[2].metrics!.cost, 10);          // week of Jul 13
});

test('buildModelWeeklySeries: ignores days outside the requested window', () => {
	const days = [modelDay('2020-01-01', { kimi: solidModel({}) })];
	const series = buildModelWeeklySeries(days, 'kimi', NOW, 4);
	assert.ok(series.every(p => p.metrics === null));
});

// ── Comparison windows ───────────────────────────────────────────────────────

test('resolveModelCompareWindow: last30 covers the 30 days ending today', () => {
	const w = resolveModelCompareWindow('last30', NOW);
	assert.equal(w.startKey, '2026-06-16');
	assert.equal(w.endKey, '2026-07-15');
	assert.equal(w.label, 'Last 30 days');
});

test('resolveModelCompareWindow: prev30 sits immediately before last30 without overlapping', () => {
	const last = resolveModelCompareWindow('last30', NOW);
	const prev = resolveModelCompareWindow('prev30', NOW);
	assert.equal(prev.startKey, '2026-05-17');
	assert.equal(prev.endKey, '2026-06-15');
	assert.ok(prev.endKey < last.startKey, 'previous window must end before the last window starts');
});

test('resolveModelCompareWindow: last90 spans 90 days ending today', () => {
	const w = resolveModelCompareWindow('last90', NOW);
	assert.equal(w.startKey, '2026-04-17');
	assert.equal(w.endKey, '2026-07-15');
});

test('resolveModelCompareWindow: thisMonth runs from the 1st to today and is labelled by month', () => {
	const w = resolveModelCompareWindow('thisMonth', NOW);
	assert.equal(w.startKey, '2026-07-01');
	assert.equal(w.endKey, '2026-07-15');
	assert.equal(w.label, 'July 2026');
});

test('resolveModelCompareWindow: lastMonth covers the whole previous calendar month', () => {
	const w = resolveModelCompareWindow('lastMonth', NOW);
	assert.equal(w.startKey, '2026-06-01');
	assert.equal(w.endKey, '2026-06-30');
	assert.equal(w.label, 'June 2026');
});

test('resolveModelCompareWindow: lastMonth rolls back across a year boundary', () => {
	const w = resolveModelCompareWindow('lastMonth', new Date(2026, 0, 9, 12, 0, 0));
	assert.equal(w.startKey, '2025-12-01');
	assert.equal(w.endKey, '2025-12-31');
	assert.equal(w.label, 'December 2025');
});

test('selectDaysInWindow: keeps only days inside the window, bounds included', () => {
	const days = [
		modelDay('2026-06-30', {}),
		modelDay('2026-07-01', {}),
		modelDay('2026-07-10', {}),
		modelDay('2026-07-15', {}),
		modelDay('2026-07-16', {}),
	];
	const picked = selectDaysInWindow(days, resolveModelCompareWindow('thisMonth', NOW));
	assert.deepEqual(picked.map(d => d.date), ['2026-07-01', '2026-07-10', '2026-07-15']);
});

test('selectDaysInWindow: returns nothing when no day falls inside the window', () => {
	const days = [modelDay('2026-01-05', {}), modelDay('2026-02-05', {})];
	assert.equal(selectDaysInWindow(days, resolveModelCompareWindow('last30', NOW)).length, 0);
});

test('resolveModelCompareWindow: rangeLabel is a concrete date span distinguishing same-length windows', () => {
	const last = resolveModelCompareWindow('last30', NOW);
	const prev = resolveModelCompareWindow('prev30', NOW);
	assert.equal(last.rangeLabel, 'Jun 16 – Jul 15, 2026');
	assert.equal(prev.rangeLabel, 'May 17 – Jun 15, 2026');
	assert.notEqual(last.rangeLabel, prev.rangeLabel);
});

test('resolveModelCompareWindow: rangeLabel includes both years when the span crosses a year boundary', () => {
	const w = resolveModelCompareWindow('lastMonth', new Date(2026, 0, 9, 12, 0, 0));
	assert.equal(w.rangeLabel, 'Dec 1 – Dec 31, 2025');
});

test('windowHasModelData: false when no day in the window has per-model efficiency data', () => {
	const days = [modelDay('2026-07-01', {}), modelDay('2026-07-10', {})];
	assert.equal(windowHasModelData(days, resolveModelCompareWindow('thisMonth', NOW)), false);
});

test('windowHasModelData: true when at least one day in the window has per-model efficiency data', () => {
	const days = [modelDay('2026-07-10', { 'gpt-4o': {} })];
	assert.equal(windowHasModelData(days, resolveModelCompareWindow('thisMonth', NOW)), true);
});

test('windowHasModelData: ignores data outside the window bounds', () => {
	const days = [modelDay('2026-06-01', { 'gpt-4o': {} })];
	assert.equal(windowHasModelData(days, resolveModelCompareWindow('thisMonth', NOW)), false);
});

// ── Time ranges, resolutions and buckets (issue #1965) ───────────────────────

test('resolveEfficiencyRange: 30-day preset spans exactly 30 inclusive days ending today', () => {
	const range = resolveEfficiencyRange('last30d', NOW);
	assert.equal(range.startKey, '2026-06-16');
	assert.equal(range.endKey, '2026-07-15');
	assert.equal(efficiencyRangeSpanDays(range), 30);
});

test('resolveEfficiencyRange: 12-week preset starts on a Monday, matching the legacy weekly window', () => {
	const range = resolveEfficiencyRange('last12w', NOW);
	// Current week's Monday is 2026-07-13; 11 weeks earlier is 2026-04-27.
	assert.equal(range.startKey, '2026-04-27');
	assert.equal(range.endKey, '2026-07-15');
	assert.equal(buildEfficiencyBuckets(range, 'weekly').length, 12);
});

test('resolveEfficiencyRange: month presets start on the first of the month', () => {
	assert.equal(resolveEfficiencyRange('last6m', NOW).startKey, '2026-02-01');
	assert.equal(resolveEfficiencyRange('last1y', NOW).startKey, '2025-08-01');
	assert.equal(buildEfficiencyBuckets(resolveEfficiencyRange('last6m', NOW), 'monthly').length, 6);
	assert.equal(buildEfficiencyBuckets(resolveEfficiencyRange('last1y', NOW), 'monthly').length, 12);
});

test('efficiencyTodayKey: every preset range reaches it, a drilled-into past bucket does not', () => {
	const todayKey = efficiencyTodayKey(NOW);
	assert.equal(todayKey, '2026-07-15');
	for (const id of ['last30d', 'last12w', 'last6m', 'last1y'] as const) {
		assert.ok(resolveEfficiencyRange(id, NOW).endKey >= todayKey, `${id} should still reach today`);
	}
	// Drilling into the current week keeps today in range; an earlier week does not.
	const weeks = buildEfficiencyBuckets(resolveEfficiencyRange('last12w', NOW), 'weekly');
	assert.ok(drillRangeForBucket(weeks.at(-1)!).endKey >= todayKey);
	assert.ok(drillRangeForBucket(weeks.at(-2)!).endKey < todayKey);
});

test('resolveBucketResolution: auto picks daily/weekly/monthly by span', () => {
	assert.equal(resolveBucketResolution('auto', resolveEfficiencyRange('last30d', NOW)), 'daily');
	assert.equal(resolveBucketResolution('auto', resolveEfficiencyRange('last12w', NOW)), 'weekly');
	assert.equal(resolveBucketResolution('auto', resolveEfficiencyRange('last6m', NOW)), 'weekly');
	assert.equal(resolveBucketResolution('auto', resolveEfficiencyRange('last1y', NOW)), 'monthly');
});

test('resolveBucketResolution: an explicit choice the range cannot carry falls back to auto', () => {
	const year = resolveEfficiencyRange('last1y', NOW);
	assert.equal(resolveBucketResolution('daily', year), 'monthly');
	assert.equal(resolveBucketResolution('weekly', year), 'weekly');
	const month = resolveEfficiencyRange('last30d', NOW);
	assert.equal(resolveBucketResolution('monthly', month), 'daily');
});

test('availableResolutions: never offers an empty set, and gates by span', () => {
	assert.deepEqual(availableResolutions(resolveEfficiencyRange('last30d', NOW)), ['daily', 'weekly']);
	assert.deepEqual(availableResolutions(resolveEfficiencyRange('last12w', NOW)), ['daily', 'weekly', 'monthly']);
	assert.deepEqual(availableResolutions(resolveEfficiencyRange('last1y', NOW)), ['weekly', 'monthly']);
	const singleDay = { id: 'custom' as const, label: 'One day', startKey: '2026-07-15', endKey: '2026-07-15' };
	assert.deepEqual(availableResolutions(singleDay), ['daily']);
});

test('buildEfficiencyBuckets: weekly buckets snap outward, and the trailing bucket is clipped to today', () => {
	const buckets = buildEfficiencyBuckets(resolveEfficiencyRange('last12w', NOW), 'weekly');
	assert.equal(buckets[0].startKey, '2026-04-27');
	assert.equal(buckets[0].endKey, '2026-05-03');
	assert.equal(buckets.at(-1)!.startKey, '2026-07-13');
	// The current week is partial, not extended into the future.
	assert.equal(buckets.at(-1)!.endKey, '2026-07-15');
});

test('buildEfficiencyBuckets: monthly buckets cover whole months except the current one', () => {
	const buckets = buildEfficiencyBuckets(resolveEfficiencyRange('last6m', NOW), 'monthly');
	assert.deepEqual(buckets.map(b => b.startKey), ['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
	assert.equal(buckets[0].endKey, '2026-02-28');
	assert.equal(buckets.at(-1)!.endKey, '2026-07-15');
});

test('buildEfficiencyBuckets: daily buckets are one day each, in order', () => {
	const buckets = buildEfficiencyBuckets(resolveEfficiencyRange('last30d', NOW), 'daily');
	assert.equal(buckets.length, 30);
	assert.equal(buckets[0].startKey, buckets[0].endKey);
	assert.equal(buckets.at(-1)!.startKey, '2026-07-15');
});

test('buildEfficiencyBuckets: an inverted or malformed range produces no buckets', () => {
	assert.deepEqual(buildEfficiencyBuckets({ id: 'custom', label: 'x', startKey: '2026-07-15', endKey: '2026-07-01' }, 'daily'), []);
	assert.deepEqual(buildEfficiencyBuckets({ id: 'custom', label: 'x', startKey: 'nonsense', endKey: '2026-07-01' }, 'daily'), []);
});

test('drillRangeForBucket: the label names the days drilled into, not the period they belong to', () => {
	// The trailing bucket of any range is clipped to today, so its period name
	// ("Jul 2026", "Jul 13–19") is wider than the days it actually holds.
	const months = buildEfficiencyBuckets(resolveEfficiencyRange('last6m', NOW), 'monthly');
	const currentMonth = months.at(-1)!;
	assert.equal(currentMonth.label, 'Jul 2026', 'the bucket keeps its period name for the chart axis');
	assert.equal(drillRangeForBucket(currentMonth).label, 'Jul 1–15, 2026');
	assert.equal(drillRangeForBucket(months.at(-2)!).label, 'Jun 1–30, 2026');

	const weeks = buildEfficiencyBuckets(resolveEfficiencyRange('last12w', NOW), 'weekly');
	assert.equal(drillRangeForBucket(weeks.at(-1)!).label, 'Jul 13–15, 2026', 'the current week stops at today');
	assert.equal(drillRangeForBucket(weeks.at(-2)!).label, 'Jul 6–12, 2026');
	// A week that straddles two months, and one that straddles two years.
	assert.equal(drillRangeForBucket(weeks[0]).label, 'Apr 27 – May 3, 2026');
	assert.equal(
		drillRangeForBucket({ key: '2025-12-29', label: 'Dec 29 – Jan 4', startKey: '2025-12-29', endKey: '2026-01-04', resolution: 'weekly' }).label,
		'Dec 29, 2025 – Jan 4, 2026',
	);
	// A bucket clipped to a single day still reads as that day.
	assert.equal(
		drillRangeForBucket({ key: '2026-07-15', label: 'Jul 2026', startKey: '2026-07-15', endKey: '2026-07-15', resolution: 'monthly' }).label,
		'Jul 15, 2026',
	);
});

test('drillRangeForBucket: a weekly bucket drills into exactly the days it contains', () => {
	const week = buildEfficiencyBuckets(resolveEfficiencyRange('last12w', NOW), 'weekly')[0];
	const drilled = drillRangeForBucket(week);
	assert.equal(drilled.id, 'custom');
	assert.equal(drilled.startKey, '2026-04-27');
	assert.equal(drilled.endKey, '2026-05-03');
	assert.equal(buildEfficiencyBuckets(drilled, 'daily').length, 7);
});

// ── Compact daily volume and bucketed series ─────────────────────────────────

function volumeDay(date: string, editors: { [editor: string]: { tokens: number; sessions: number; interactions: number; loc: number } }): DailyTokenStats {
	const editorUsage: DailyTokenStats['editorUsage'] = {};
	const editorModelUsage: { [editor: string]: ModelUsage } = {};
	let tokens = 0, sessions = 0, interactions = 0, linesAdded = 0;
	for (const [editor, v] of Object.entries(editors)) {
		editorUsage[editor] = { tokens: v.tokens, sessions: v.sessions, interactions: v.interactions, linesAdded: v.loc, linesRemoved: 0 };
		editorModelUsage[editor] = usage('gpt-5', v.tokens, 0, v.sessions);
		tokens += v.tokens; sessions += v.sessions; interactions += v.interactions; linesAdded += v.loc;
	}
	return day(date, {
		tokens, sessions, interactions, linesAdded, linesRemoved: 0,
		modelUsage: usage('gpt-5', tokens, 0, sessions),
		editorUsage, editorModelUsage,
	});
}

test('toEfficiencyDailyVolume: per-editor slices sum back to the day totals', () => {
	const volume = toEfficiencyDailyVolume([
		volumeDay('2026-07-13', { 'VS Code': { tokens: 300, sessions: 3, interactions: 12, loc: 90 }, 'Claude Code': { tokens: 700, sessions: 2, interactions: 8, loc: 40 } }),
	], flatDeps);
	const total = volume[0];
	const summed = Object.values(total.byEditor!).reduce(
		(acc, s) => ({ tokens: acc.tokens + s.tokens, sessions: acc.sessions + s.sessions, interactions: acc.interactions + s.interactions, loc: acc.loc + s.loc, cost: acc.cost + s.cost }),
		{ tokens: 0, sessions: 0, interactions: 0, loc: 0, cost: 0 },
	);
	assert.equal(summed.tokens, total.tokens);
	assert.equal(summed.sessions, total.sessions);
	assert.equal(summed.interactions, total.interactions);
	assert.equal(summed.loc, total.loc);
	assert.ok(Math.abs(summed.cost - total.cost) < 1e-9);
});

test('toEfficiencyDailyVolume: a day with no editor breakdown still carries its totals', () => {
	const volume = toEfficiencyDailyVolume([day('2026-07-13', { tokens: 500, sessions: 2, interactions: 9, modelUsage: usage('gpt-5', 500, 0, 2) })], flatDeps);
	assert.equal(volume[0].tokens, 500);
	assert.equal(volume[0].byEditor, undefined);
});

test('buildEfficiencyBucketSeries: unfiltered daily buckets keep each day separate and inclusive at both ends', () => {
	const volume = toEfficiencyDailyVolume([
		volumeDay('2026-07-13', { 'VS Code': { tokens: 100, sessions: 1, interactions: 4, loc: 10 } }),
		volumeDay('2026-07-14', { 'VS Code': { tokens: 200, sessions: 2, interactions: 6, loc: 20 } }),
		volumeDay('2026-07-15', { 'VS Code': { tokens: 300, sessions: 3, interactions: 9, loc: 30 } }),
		// Outside the range: must not leak into any bucket.
		volumeDay('2026-07-16', { 'VS Code': { tokens: 999, sessions: 9, interactions: 99, loc: 99 } }),
	], flatDeps);
	const range = { id: 'custom' as const, label: 'three days', startKey: '2026-07-13', endKey: '2026-07-15' };
	const points = buildEfficiencyBucketSeries(volume, [], buildEfficiencyBuckets(range, 'daily'));
	assert.deepEqual(points.map(p => p.tokens), [100, 200, 300]);
	assert.deepEqual(points.map(p => p.resolution), ['daily', 'daily', 'daily']);
});

test('buildEfficiencyBucketSeries: an interval with no data yields zeros and null ratios, not gaps in the axis', () => {
	const range = { id: 'custom' as const, label: 'two days', startKey: '2026-07-14', endKey: '2026-07-15' };
	const points = buildEfficiencyBucketSeries([], [], buildEfficiencyBuckets(range, 'daily'));
	assert.equal(points.length, 2);
	assert.equal(points[0].tokens, 0);
	assert.equal(points[0].tokensPerSession, null);
	assert.equal(points[0].costPerKloc, null);
	assert.equal(points[0].retryRate, null);
	assert.equal(points[0].applyRate, null);
});

test('buildEfficiencyBucketSeries: editor filtering narrows both volume and session-derived metrics', () => {
	const volume = toEfficiencyDailyVolume([
		volumeDay('2026-07-13', { 'VS Code': { tokens: 300, sessions: 3, interactions: 12, loc: 90 }, 'Claude Code': { tokens: 700, sessions: 2, interactions: 8, loc: 40 } }),
	], flatDeps);
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', editor: 'VS Code', editTurns: 10, retries: 2, applies: 4, codeBlocks: 8, activeDurationMs: 600_000 },
		{ dayKey: '2026-07-13', editor: 'Claude Code', editTurns: 10, retries: 8, applies: 1, codeBlocks: 8, activeDurationMs: 1_200_000 },
	];
	const buckets = buildEfficiencyBuckets({ id: 'custom', label: 'one day', startKey: '2026-07-13', endKey: '2026-07-13' }, 'daily');
	const all = buildEfficiencyBucketSeries(volume, sessions, buckets)[0];
	const vscodeOnly = buildEfficiencyBucketSeries(volume, sessions, buckets, { editor: 'VS Code' })[0];
	const claudeOnly = buildEfficiencyBucketSeries(volume, sessions, buckets, { editor: 'Claude Code' })[0];

	assert.equal(all.tokens, 1000);
	assert.equal(vscodeOnly.tokens, 300);
	assert.equal(claudeOnly.tokens, 700);
	// Totals are conserved across the split — no double counting, no loss.
	assert.equal(vscodeOnly.tokens + claudeOnly.tokens, all.tokens);
	assert.equal(vscodeOnly.sessions + claudeOnly.sessions, all.sessions);
	assert.equal(vscodeOnly.editTurns + claudeOnly.editTurns, all.editTurns);
	assert.equal(vscodeOnly.retryRate, 0.2);
	assert.equal(claudeOnly.retryRate, 0.8);
	assert.equal(all.retryRate, 0.5);
});

test('buildEfficiencyBucketSeries: sessions without an editor are counted unfiltered but excluded from every editor scope', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', editTurns: 10, retries: 5 },
		{ dayKey: '2026-07-13', editor: 'VS Code', editTurns: 10, retries: 1 },
	];
	const buckets = buildEfficiencyBuckets({ id: 'custom', label: 'one day', startKey: '2026-07-13', endKey: '2026-07-13' }, 'daily');
	assert.equal(buildEfficiencyBucketSeries([], sessions, buckets)[0].editTurns, 20);
	assert.equal(buildEfficiencyBucketSeries([], sessions, buckets, { editor: 'VS Code' })[0].editTurns, 10);
});

test('buildEfficiencyBucketSeries: weekly buckets over the default window reproduce buildEfficiencyTrends exactly', () => {
	const days = [
		day('2026-07-13', { tokens: 1000, sessions: 4, interactions: 20, linesAdded: 200, linesRemoved: 50, modelUsage: usage('gpt-5', 1000, 0, 4) }),
		day('2026-07-06', { tokens: 800, sessions: 2, interactions: 10, linesAdded: 100, linesRemoved: 10, modelUsage: usage('gpt-5', 800, 0, 2) }),
	];
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', editTurns: 12, retries: 3, applies: 5, codeBlocks: 10, activeDurationMs: 900_000 },
	];
	const weekly = buildEfficiencyTrends(days, sessions, flatDeps);
	const range = resolveEfficiencyRange('last12w', NOW);
	const bucketed = buildEfficiencyBucketSeries(toEfficiencyDailyVolume(days, flatDeps), sessions, buildEfficiencyBuckets(range, 'weekly'));
	assert.equal(weekly.length, bucketed.length);
	for (let i = 0; i < weekly.length; i++) {
		const { weekKey, ...rest } = weekly[i];
		assert.equal(weekKey, bucketed[i].bucketKey);
		assert.deepEqual(rest, bucketed[i]);
	}
});

test('listEfficiencyEditors: orders editors by tokens, largest first', () => {
	const volume = toEfficiencyDailyVolume([
		volumeDay('2026-07-13', { 'VS Code': { tokens: 300, sessions: 1, interactions: 1, loc: 1 }, 'Claude Code': { tokens: 700, sessions: 1, interactions: 1, loc: 1 } }),
	], flatDeps);
	assert.deepEqual(listEfficiencyEditors(volume), ['Claude Code', 'VS Code']);
});

test('listEfficiencyEditors: omits the Unknown sentinel, which is not a selectable editor', () => {
	const volume = toEfficiencyDailyVolume([
		volumeDay('2026-07-13', {
			'VS Code': { tokens: 300, sessions: 1, interactions: 1, loc: 1 },
			[UNKNOWN_EDITOR]: { tokens: 900, sessions: 3, interactions: 3, loc: 3 },
		}),
	], flatDeps);
	// Even though it is the largest bucket, it must not be offered as a scope —
	// the toolbar promises those sessions are excluded from editor-scoped views.
	assert.deepEqual(listEfficiencyEditors(volume), ['VS Code']);
	// It still contributes to the unfiltered totals.
	assert.equal(volume[0].tokens, 1200);
});

test('buildSkillUsageSeries: scoping to an editor keeps only that editor\'s invocations', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-07-13', editor: 'VS Code', skillCalls: { graphify: 2 } },
		{ dayKey: '2026-07-13', editor: 'Claude Code', skillCalls: { graphify: 1, 'code-review': 4 } },
	];
	const buckets = buildEfficiencyBuckets({ id: 'custom', label: 'one day', startKey: '2026-07-13', endKey: '2026-07-13' }, 'daily');
	const all = buildSkillUsageSeries(sessions, buckets);
	const scoped = buildSkillUsageSeries(sessions, buckets, { editor: 'VS Code' });
	assert.equal(all.totalCalls, 7);
	assert.equal(scoped.totalCalls, 2);
	assert.deepEqual(scoped.weeks[0].byName, { graphify: 2 });
	assert.equal(scoped.weeks[0].trackedSessions, 1);
	assert.equal(scoped.weeks[0].skillShare, 1);
});

// ── Editor- and vendor-scoped model comparison ───────────────────────────────

function createModelEntry(overrides: Partial<DailyModelEfficiencyEntry> = {}): DailyModelEfficiencyEntry {
	return { ...createEmptyDailyModelEfficiencyEntry(), ...overrides };
}

test('selectModelDaysForEditor: merging every editor row reproduces the unsplit day', () => {
	const merged = modelDay('2026-07-13', { 'gpt-5': { editTurns: 10, retries: 2, cost: 4, inputTokens: 1000, outputTokens: 200, sessionShare: 6 } });
	const split: ModelDailyInput[] = [
		{ date: '2026-07-13', editor: 'VS Code', modelEfficiency: { 'gpt-5': createModelEntry({ editTurns: 6, retries: 1, cost: 2.4, inputTokens: 600, outputTokens: 120, sessionShare: 3.6 }) } },
		{ date: '2026-07-13', editor: 'Claude Code', modelEfficiency: { 'gpt-5': createModelEntry({ editTurns: 4, retries: 1, cost: 1.6, inputTokens: 400, outputTokens: 80, sessionShare: 2.4 }) } },
	];
	const whole = computeModelPeriodMetrics([merged], 'gpt-5', 'window')!;
	const fromSplit = computeModelPeriodMetrics(split, 'gpt-5', 'window')!;
	assert.equal(fromSplit.editTurns, whole.editTurns);
	assert.equal(fromSplit.tokens, whole.tokens);
	assert.ok(Math.abs(fromSplit.cost - whole.cost) < 1e-9);
	assert.ok(Math.abs(fromSplit.sessionShare - whole.sessionShare) < 1e-9);
	assert.equal(fromSplit.retryRate, whole.retryRate);

	const scoped = computeModelPeriodMetrics(selectModelDaysForEditor(split, 'VS Code'), 'gpt-5', 'window')!;
	assert.equal(scoped.editTurns, 6);
	assert.equal(selectModelDaysForEditor(split, 'Netscape').length, 0);
});

test('selectModelDaysForEditor: rows with no editor are excluded from an editor scope', () => {
	const rows: ModelDailyInput[] = [
		{ date: '2026-07-13', modelEfficiency: { 'gpt-5': createModelEntry({ editTurns: 5 }) } },
		{ date: '2026-07-13', editor: 'VS Code', modelEfficiency: { 'gpt-5': createModelEntry({ editTurns: 7 }) } },
	];
	assert.equal(selectModelDaysForEditor(rows, 'VS Code').length, 1);
	assert.equal(selectModelDaysForEditor(rows, undefined).length, 2);
});

test('listModelVendors / filterModelsByVendor: narrow by the model\'s own provider, not the biller', () => {
	const rows: ModelDailyInput[] = [{
		date: '2026-07-13',
		editor: 'VS Code',
		modelEfficiency: {
			'claude-sonnet-4-5': createModelEntry({ inputTokens: 1000, sessionShare: 6 }),
			'gpt-5': createModelEntry({ inputTokens: 500, sessionShare: 6 }),
		},
	}];
	assert.deepEqual(listModelVendors(rows), ['Anthropic', 'OpenAI']);
	const models = listComparableModels(rows);
	assert.deepEqual(filterModelsByVendor(models, 'Anthropic').map(m => m.model), ['claude-sonnet-4-5']);
	assert.equal(filterModelsByVendor(models, undefined).length, 2);
	assert.equal(filterModelsByVendor(models, 'Mistral AI').length, 0);
});

test('buildModelBucketSeries: buckets without the model carry a null profile, not a zero', () => {
	const rows: ModelDailyInput[] = [
		{ date: '2026-07-14', editor: 'VS Code', modelEfficiency: { 'gpt-5': createModelEntry({ editTurns: 12, sessionShare: 6, inputTokens: 1000 }) } },
	];
	const buckets = buildEfficiencyBuckets({ id: 'custom', label: 'three days', startKey: '2026-07-13', endKey: '2026-07-15' }, 'daily');
	const series = buildModelBucketSeries(rows, 'gpt-5', buckets);
	assert.deepEqual(series.map(p => p.metrics === null), [true, false, true]);
	assert.equal(series[1].metrics!.editTurns, 12);
});

test('buildModelWeeklySeries still matches buildModelBucketSeries over the default weekly window', () => {
	const rows: ModelDailyInput[] = [
		{ date: '2026-07-14', modelEfficiency: { 'gpt-5': createModelEntry({ editTurns: 12, sessionShare: 6, inputTokens: 1000 }) } },
	];
	const weekly = buildModelWeeklySeries(rows, 'gpt-5', NOW);
	const bucketed = buildModelBucketSeries(rows, 'gpt-5', buildEfficiencyBuckets(resolveEfficiencyRange('last12w', NOW), 'weekly'));
	assert.equal(weekly.length, bucketed.length);
	assert.deepEqual(weekly.map(p => p.weekKey), bucketed.map(p => p.bucketKey));
	assert.deepEqual(weekly.map(p => p.metrics?.editTurns ?? null), bucketed.map(p => p.metrics?.editTurns ?? null));
});

// ── Per-editor daily aggregation (the extension's payload split) ─────────────

test('splitModelDayByEditor: rows merge back to the unsplit day, with no double counting', () => {
	const vsCode: DailyModelEfficiency = {
		'gpt-5': createModelEntry({ editTurns: 6, retries: 1, cost: 2.4, inputTokens: 600, outputTokens: 120, sessions: 2, sessionShare: 1.2, linesAdded: 60 }),
		'claude-sonnet-4-5': createModelEntry({ editTurns: 2, cost: 0.8, inputTokens: 200, outputTokens: 40, sessions: 1, sessionShare: 0.8, linesAdded: 20 }),
	};
	const claudeCode: DailyModelEfficiency = {
		'claude-sonnet-4-5': createModelEntry({ editTurns: 4, retries: 1, cost: 1.6, inputTokens: 400, outputTokens: 80, sessions: 2, sessionShare: 2, linesAdded: 40 }),
	};
	const dayStats = day('2026-07-13', {
		editorModelEfficiency: { 'VS Code': vsCode, 'Claude Code': claudeCode },
		taskCategoryUsage: { Coding: { tokens: 1440, sessions: 4 }, Debugging: { tokens: 720, sessions: 2 } },
	});

	const rows = splitModelDayByEditor(dayStats);
	assert.deepEqual(rows.map(r => r.editor), ['VS Code', 'Claude Code']);

	// A model used by two editors is counted once per editor, and the merge of
	// both rows equals what a single unsplit row would have produced.
	const mergedRow = modelDay('2026-07-13', {
		'claude-sonnet-4-5': { editTurns: 6, retries: 1, cost: 2.4, inputTokens: 600, outputTokens: 120, sessions: 3, sessionShare: 2.8, linesAdded: 60 },
	});
	const fromSplit = computeModelPeriodMetrics(rows, 'claude-sonnet-4-5', 'day')!;
	const fromWhole = computeModelPeriodMetrics([mergedRow], 'claude-sonnet-4-5', 'day')!;
	assert.equal(fromSplit.editTurns, fromWhole.editTurns);
	assert.equal(fromSplit.tokens, fromWhole.tokens);
	assert.equal(fromSplit.sessions, fromWhole.sessions);
	assert.ok(Math.abs(fromSplit.cost - fromWhole.cost) < 1e-9);
	assert.ok(Math.abs(fromSplit.sessionShare - fromWhole.sessionShare) < 1e-9);
});

test('splitModelDayByEditor: task-category tokens are apportioned by editor token share and sum back to the day', () => {
	const dayStats = day('2026-07-13', {
		editorModelEfficiency: {
			'VS Code': { 'gpt-5': createModelEntry({ inputTokens: 750, outputTokens: 0 }) },
			'Claude Code': { 'gpt-5': createModelEntry({ inputTokens: 250, outputTokens: 0 }) },
		},
		taskCategoryUsage: { Coding: { tokens: 400, sessions: 4 } },
	});
	const rows = splitModelDayByEditor(dayStats);
	assert.equal(rows[0].taskCategoryUsage!.Coding.tokens, 300);
	assert.equal(rows[1].taskCategoryUsage!.Coding.tokens, 100);
	const summed = rows.reduce((sum, r) => sum + (r.taskCategoryUsage?.Coding.tokens ?? 0), 0);
	assert.equal(summed, 400);
});

test('splitModelDayByEditor: the unsplit task mix is preserved, so an unfiltered view is unchanged', () => {
	const dayStats = day('2026-07-13', {
		editorModelEfficiency: {
			'VS Code': { 'gpt-5': createModelEntry({ inputTokens: 600, outputTokens: 0, sessionShare: 4 }) },
			'Claude Code': { 'gpt-5': createModelEntry({ inputTokens: 400, outputTokens: 0, sessionShare: 4 }) },
		},
		modelEfficiency: { 'gpt-5': createModelEntry({ inputTokens: 1000, outputTokens: 0, sessionShare: 8 }) },
		taskCategoryUsage: { Coding: { tokens: 800, sessions: 6 }, Debugging: { tokens: 200, sessions: 2 } },
	});
	const whole = computeModelPeriodMetrics([{ date: dayStats.date, modelEfficiency: dayStats.modelEfficiency, taskCategoryUsage: dayStats.taskCategoryUsage }], 'gpt-5', 'day')!;
	const fromSplit = computeModelPeriodMetrics(splitModelDayByEditor(dayStats), 'gpt-5', 'day')!;
	for (const category of ['Coding', 'Debugging']) {
		assert.ok(Math.abs((fromSplit.taskMix[category] ?? 0) - (whole.taskMix[category] ?? 0)) < 1e-9, category);
	}
});

test('splitModelDayByEditor: a day with no editor breakdown produces no rows, so the caller keeps the unsplit one', () => {
	assert.deepEqual(splitModelDayByEditor(day('2026-07-13', { modelEfficiency: { 'gpt-5': createModelEntry({ editTurns: 3 }) } })), []);
	assert.deepEqual(splitModelDayByEditor(day('2026-07-13', { editorModelEfficiency: {} })), []);
});

test('splitModelDayByEditor: a zero-token day still yields rows, just without a task-mix split to apportion', () => {
	const rows = splitModelDayByEditor(day('2026-07-13', {
		editorModelEfficiency: { 'VS Code': { 'gpt-5': createModelEntry({ editTurns: 2 }) } },
		taskCategoryUsage: { Coding: { tokens: 100, sessions: 1 } },
	}));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].taskCategoryUsage, undefined);
});

// ── valueSignalsEqual ────────────────────────────────────────────────────────
// Both sides of the Efficiency panel's Value update use this to decide whether anything actually
// moved: the host to avoid posting churn on every Repository PRs refresh, the webview to leave the
// rendered Value fragment alone.

test('valueSignalsEqual: an unchanged snapshot is a no-op', () => {
	const base = computeValueSignals({
		userPrs: 18, mergedPrs: 14, aiPrs: 3, prsSince: '2026-02-14T00:00:00.000Z',
		periodCost: 41.8, applyUsage: { totalApplies: 186, totalCodeBlocks: 300, applyRate: 0.62 },
		linesChanged: 14740, now: new Date('2026-03-12T10:00:00.000Z'),
	});
	const same = { ...base };
	assert.ok(valueSignalsEqual(base, same));
	assert.ok(valueSignalsEqual(undefined, undefined));
	assert.equal(valueSignalsEqual(base, undefined), false);
	assert.equal(valueSignalsEqual(base, { ...base, mergedPrs: 15 }), false);
	// Losing PR data (sign-out) is a change, not a no-op: the cards must go back to the hint.
	assert.equal(valueSignalsEqual(base, { ...base, userPrs: null }), false);
	// Non-PR totals matter too — a refreshed cost changes cost-per-merged-PR.
	assert.equal(valueSignalsEqual(base, { ...base, periodCost: 50 }), false);
});

// ── Models tab eligibility and selection reconciliation ──────────────────────

/** A selection with the shipped defaults, overridden per test. */
function selection(overrides: Partial<ModelCompareSelection> = {}): ModelCompareSelection {
	return { mode: 'models', modelA: '', modelB: '', window: 'last30', windowA: 'lastMonth', windowB: 'thisMonth', ...overrides };
}

/** A year of data where the only two-model pair sits outside every selectable window. */
function historicalOnlyDays(): DailyTokenStats[] {
	return [
		modelDay('2025-09-10', { legacy: solidModel({ inputTokens: 9_000_000 }), 'legacy-mini': solidModel({ inputTokens: 8_000_000 }) }),
		modelDay('2026-07-02', { current: solidModel({}) }),
	];
}

test('listEligibleModels: models mode offers only models present in the selected window', () => {
	const models = listEligibleModels(historicalOnlyDays(), selection({ window: 'last30' }), NOW);
	assert.deepEqual(models.map(m => m.model), ['current']);
});

test('listEligibleModels: periods mode offers only models present in both selected windows', () => {
	const days = [
		modelDay('2026-06-10', { shared: solidModel({}), juneOnly: solidModel({}) }),
		modelDay('2026-07-02', { shared: solidModel({}), julyOnly: solidModel({}) }),
	];
	const models = listEligibleModels(days, selection({ mode: 'periods', windowA: 'lastMonth', windowB: 'thisMonth' }), NOW);
	assert.deepEqual(models.map(m => m.model), ['shared']);
});

test('listEligibleModels: periods mode counts an overlapping window once when sizing the sample', () => {
	const days = [modelDay('2026-07-02', { a: solidModel({ sessionShare: 3 }) })];
	// windowA === windowB: the same days must not be merged twice and lift `a` over the sample floor.
	const models = listEligibleModels(days, selection({ mode: 'periods', windowA: 'thisMonth', windowB: 'thisMonth' }), NOW);
	assert.deepEqual(models.map(m => m.model), ['a']);
	assert.equal(models[0].sessionShare, 3);
	assert.equal(models[0].sampleSufficient, false);
});

test('reconcileModelSelection: replaces a model that only exists outside the active window', () => {
	const days = historicalOnlyDays();
	const window = resolveModelCompareWindow('last30', NOW);
	// The pre-fix pickers defaulted from the whole payload, so the most-used model
	// of the year was selected even though the active window has none of it —
	// leaving a permanently missing side for every offered combination.
	const stale = listComparableModels(days)[0].model;
	assert.equal(stale, 'legacy');
	assert.equal(computeModelPeriodMetrics(selectDaysInWindow(days, window), stale, window.label), null);

	const next = reconcileModelSelection(days, selection({ modelA: 'legacy', modelB: 'legacy-mini' }), NOW);
	assert.equal(next.modelA, 'current');
	assert.ok(computeModelPeriodMetrics(selectDaysInWindow(days, window), next.modelA, window.label) !== null);
});

test('reconcileModelSelection: models mode defaults to two distinct models when the window has a pair', () => {
	const days = [modelDay('2026-07-02', { big: solidModel({ inputTokens: 5_000_000 }), small: solidModel({}) })];
	const next = reconcileModelSelection(days, selection(), NOW);
	assert.equal(next.modelA, 'big');
	assert.equal(next.modelB, 'small');
});

test('reconcileModelSelection: models mode splits a Model B that has collapsed onto Model A', () => {
	const days = [modelDay('2026-07-02', { big: solidModel({ inputTokens: 5_000_000 }), small: solidModel({}) })];
	const next = reconcileModelSelection(days, selection({ modelA: 'big', modelB: 'big' }), NOW);
	assert.equal(next.modelA, 'big');
	assert.equal(next.modelB, 'small');
});

test('reconcileModelSelection: keeps a still-eligible pick untouched', () => {
	const days = [modelDay('2026-07-02', { big: solidModel({ inputTokens: 5_000_000 }), small: solidModel({}) })];
	const next = reconcileModelSelection(days, selection({ modelA: 'small', modelB: 'big' }), NOW);
	assert.equal(next.modelA, 'small');
	assert.equal(next.modelB, 'big');
});

test('reconcileModelSelection: keeps a low-sample pick the user made, but defaults to models that clear the floor', () => {
	const lowSample = { ...createEmptyDailyModelEfficiencyEntry(), sessions: 1, sessionShare: 1, editTurns: 2, inputTokens: 100 };
	const days = [modelDay('2026-07-02', { a: solidModel({ inputTokens: 5_000_000 }), b: solidModel({}), rare: lowSample })];
	assert.equal(reconcileModelSelection(days, selection({ modelA: 'rare', modelB: 'a' }), NOW).modelA, 'rare');
	assert.deepEqual(
		[reconcileModelSelection(days, selection(), NOW).modelA, reconcileModelSelection(days, selection(), NOW).modelB],
		['a', 'b'],
	);
});

test('reconcileModelSelection: models mode leaves Model B empty rather than comparing a model with itself', () => {
	const days = [modelDay('2026-07-02', { only: solidModel({}) })];
	const next = reconcileModelSelection(days, selection({ modelA: 'only', modelB: 'only' }), NOW);
	assert.equal(next.modelA, 'only');
	assert.equal(next.modelB, '');
});

test('reconcileModelSelection: periods mode repoints a model that is missing from one of the two periods', () => {
	const days = [
		modelDay('2026-06-10', { shared: solidModel({}) }),
		modelDay('2026-07-02', { shared: solidModel({}), julyOnly: solidModel({ inputTokens: 9_000_000 }) }),
	];
	const sel = selection({ mode: 'periods', modelA: 'julyOnly', windowA: 'lastMonth', windowB: 'thisMonth' });
	const next = reconcileModelSelection(days, sel, NOW);
	assert.equal(next.modelA, 'shared');
	for (const id of ['lastMonth', 'thisMonth'] as const) {
		const w = resolveModelCompareWindow(id, NOW);
		assert.ok(computeModelPeriodMetrics(selectDaysInWindow(days, w), next.modelA, w.label) !== null);
	}
});

test('reconcileModelSelection: periods mode preserves Model B so switching back to models mode keeps it', () => {
	const days = [
		modelDay('2026-06-10', { a: solidModel({ inputTokens: 5_000_000 }), b: solidModel({}) }),
		modelDay('2026-07-02', { a: solidModel({ inputTokens: 5_000_000 }), b: solidModel({}) }),
	];
	const sel = selection({ mode: 'periods', modelA: 'a', modelB: 'b', windowA: 'lastMonth', windowB: 'thisMonth' });
	assert.equal(reconcileModelSelection(days, sel, NOW).modelB, 'b');
});

test('reconcileModelSelection: empties both sides when the active window holds nothing to compare', () => {
	const days = [modelDay('2025-09-10', { legacy: solidModel({}) })];
	const next = reconcileModelSelection(days, selection({ modelA: 'legacy', modelB: 'legacy' }), NOW);
	assert.equal(next.modelA, '');
	assert.equal(next.modelB, '');
	// An empty side is the honest answer here — not a zero-valued stand-in.
	const w = resolveModelCompareWindow('last30', NOW);
	assert.equal(computeModelPeriodMetrics(selectDaysInWindow(days, w), next.modelA, w.label), null);
});

test('reconcileModelSelection: does not change the selected windows or mode', () => {
	const days = [modelDay('2026-07-02', { a: solidModel({}), b: solidModel({}) })];
	const sel = selection({ window: 'last90', windowA: 'prev30', windowB: 'last30' });
	const next = reconcileModelSelection(days, sel, NOW);
	assert.equal(next.mode, 'models');
	assert.equal(next.window, 'last90');
	assert.equal(next.windowA, 'prev30');
	assert.equal(next.windowB, 'last30');
});

test('reconcileModelSelection: replacing a stale Model A does not displace an eligible Model B', () => {
	// 'big' sorts first, so a naive replacement would move the user's B onto side A
	// and then push a different model into B — losing the pick it claims to keep.
	const days = [modelDay('2026-07-02', { big: solidModel({ inputTokens: 5_000_000 }), small: solidModel({}) })];
	const next = reconcileModelSelection(days, selection({ modelA: 'gone', modelB: 'big' }), NOW);
	assert.equal(next.modelB, 'big');
	assert.equal(next.modelA, 'small');
});

test('reconcileModelSelection: falls back to Model B for Model A when the window holds nothing else', () => {
	const days = [modelDay('2026-07-02', { only: solidModel({}) })];
	const next = reconcileModelSelection(days, selection({ modelA: 'gone', modelB: 'only' }), NOW);
	assert.equal(next.modelA, 'only');
	assert.equal(next.modelB, '');
});

test('reconcileModelSelection: defaults lead with a model that clears the sample floor, not the biggest token count', () => {
	// 'hog' has the most tokens but only one session equivalent, so it must not
	// take a default side ahead of 'steady', which clears the floor.
	const hog = { ...createEmptyDailyModelEfficiencyEntry(), sessions: 1, sessionShare: 1, editTurns: 2, inputTokens: 9_000_000, cost: 40 };
	const days = [modelDay('2026-07-02', { hog, steady: solidModel({ inputTokens: 1_000_000 }) })];
	assert.deepEqual(listEligibleModels(days, selection(), NOW).map(m => m.model), ['hog', 'steady']);
	const next = reconcileModelSelection(days, selection(), NOW);
	assert.equal(next.modelA, 'steady');
	assert.equal(next.modelB, 'hog');
});
