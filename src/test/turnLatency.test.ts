/**
 * Per-turn response latency (issue #2480): the turn window rule, the per-model
 * histogram in the efficiency counters, derived active duration, and the Claude
 * turn end. Sources without per-turn end times must stay empty, never zero.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	activeDurationFromTurns,
	accumulateDailyModelCounters,
	computeEfficiencyFromTurns,
	deriveModelEfficiencyRates,
	mergeModelEfficiency,
	turnDurationMs,
	createEmptyModelEfficiencyCounters,
} from '../modelEfficiency';
import { computeModelPeriodMetrics, compareModels } from '../efficiencyAnalysis';
import { buildClaudeChatTurns, type ClaudeAssistantTurnData } from '../adapters/claudeTurns';
import type { DailyModelEfficiency, ModelEfficiencyUsage } from '../types';

const T0 = '2026-07-01T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const turn = (start: number, end: number | null, extra: Record<string, unknown> = {}) =>
	({ model: 'm', toolCalls: [], timestamp: at(start), ...(end === null ? {} : { endTimestamp: at(end) }), ...extra });

test('turnDurationMs: needs both ends, in order, and parsable', () => {
	assert.equal(turnDurationMs({ timestamp: at(0), endTimestamp: at(12) }), 12_000);
	assert.equal(turnDurationMs({ timestamp: at(0), endTimestamp: at(0) }), 0);
	assert.equal(turnDurationMs({ timestamp: at(0) }), null);
	assert.equal(turnDurationMs({ endTimestamp: at(5) }), null);
	assert.equal(turnDurationMs({ timestamp: at(10), endTimestamp: at(5) }), null);
	assert.equal(turnDurationMs({ timestamp: 'nope', endTimestamp: at(5) }), null);
});

test('computeEfficiencyFromTurns: records each timed turn into its own model histogram', () => {
	const eff = computeEfficiencyFromTurns([
		turn(0, 10), turn(100, 130, { model: 'other' }), turn(200, 220),
	]);
	assert.equal(eff.m.turnLatency?.count, 2);
	assert.equal(eff.m.turnLatency?.sumMs, 30_000);
	assert.equal(eff.other.turnLatency?.count, 1);
	assert.equal(eff.other.turnLatency?.sumMs, 30_000);
});

test('computeEfficiencyFromTurns: turns without an end time produce no histogram (never fabricated)', () => {
	const eff = computeEfficiencyFromTurns([turn(0, null), turn(50, null)]);
	assert.equal(eff.m.calls, 2);
	assert.equal(eff.m.turnLatency, undefined);
	const rates = deriveModelEfficiencyRates(eff.m);
	assert.equal(rates.medianTurnSeconds, null);
	assert.equal(rates.outputTokensPerSecond, null);
});

test('deriveModelEfficiencyRates: median seconds and throughput over timed turns with reported output', () => {
	const eff = computeEfficiencyFromTurns([
		turn(0, 10, { actualUsage: { completionTokens: 500 } }),
		turn(100, 120, { actualUsage: { completionTokens: 500 } }),
		turn(200, 260), // timed, but no reported output tokens: counts for latency, not throughput
	]);
	const rates = deriveModelEfficiencyRates(eff.m);
	assert.ok(rates.medianTurnSeconds !== null && rates.medianTurnSeconds > 10 && rates.medianTurnSeconds < 40);
	// 1000 tokens over (10 + 20) s; the untokened 60 s turn is excluded from the denominator.
	assert.equal(Math.round(rates.outputTokensPerSecond! * 100) / 100, 33.33);
});

test('mergeModelEfficiency: histograms and throughput add; a side without them leaves the other intact', () => {
	const a = computeEfficiencyFromTurns([turn(0, 10, { actualUsage: { completionTokens: 100 } })]);
	const b = computeEfficiencyFromTurns([turn(0, 20, { actualUsage: { completionTokens: 300 } })]);
	const untimed = computeEfficiencyFromTurns([turn(0, null)]);
	const target: ModelEfficiencyUsage = {};
	mergeModelEfficiency(target, a);
	mergeModelEfficiency(target, b);
	mergeModelEfficiency(target, untimed);
	const merged = target.m;
	assert.equal(merged.calls, 3);
	assert.equal(merged.turnLatency?.count, 2);
	assert.equal(merged.turnLatency?.sumMs, 30_000);
	assert.equal(merged.timedOutputTokens, 400);
	assert.equal(merged.timedOutputMs, 30_000);
	// Merging must not alias the source histogram.
	assert.equal(a.m.turnLatency?.count, 1);
});

test('activeDurationFromTurns: merges overlapping windows and ignores idle gaps and untimed turns', () => {
	assert.equal(activeDurationFromTurns([turn(0, 10), turn(5, 20), turn(1000, 1010), turn(2000, null)]), 30_000);
	assert.equal(activeDurationFromTurns([turn(0, null)]), 0);
	assert.equal(activeDurationFromTurns([]), 0);
});

test('accumulateDailyModelCounters + compareModels: latency reaches the Models-tab comparison rows', () => {
	const slow = computeEfficiencyFromTurns([turn(0, 60, { actualUsage: { completionTokens: 300 } })]);
	const fast = computeEfficiencyFromTurns([turn(0, 6, { model: 'fast', actualUsage: { completionTokens: 300 } })]);
	const day = (eff: ModelEfficiencyUsage, model: string) => {
		const d: DailyModelEfficiency = {};
		accumulateDailyModelCounters(d, { modelEfficiency: eff, modelUsage: { [model]: { inputTokens: 10, outputTokens: 10 } } as any });
		return [{ date: '2026-07-01', modelEfficiency: d }];
	};
	const a = computeModelPeriodMetrics(day(slow, 'm'), 'm', 'Jul')!;
	const b = computeModelPeriodMetrics(day(fast, 'fast'), 'fast', 'Jul')!;
	assert.ok(a.medianTurnSeconds! > b.medianTurnSeconds!);
	assert.ok(b.outputTokensPerSecond! > a.outputTokensPerSecond!);
	const rows = compareModels(a, b).rows;
	assert.equal(rows.find(r => r.id === 'median-turn-seconds')?.winner, 'b');
	assert.equal(rows.find(r => r.id === 'output-tokens-per-second')?.winner, 'b');
});

test('computeModelPeriodMetrics: a model with no timed turns reports null latency, not zero', () => {
	const d: DailyModelEfficiency = {};
	accumulateDailyModelCounters(d, { modelEfficiency: computeEfficiencyFromTurns([turn(0, null)]), modelUsage: { m: { inputTokens: 1, outputTokens: 1 } } as any });
	const m = computeModelPeriodMetrics([{ date: '2026-07-01', modelEfficiency: d }], 'm', 'Jul')!;
	assert.equal(m.medianTurnSeconds, null);
	assert.equal(m.outputTokensPerSecond, null);
	assert.equal(createEmptyModelEfficiencyCounters().turnLatency, undefined);
});

// --- Claude turn end ---------------------------------------------------------

const claudeUser = (seconds: number) =>
	({ type: 'user', timestamp: at(seconds), message: { role: 'user', content: 'do it' } });
const claudeToolResult = (seconds: number) =>
	({ type: 'user', timestamp: at(seconds), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const claudeAssistant = (seconds: number) =>
	({ type: 'assistant', timestamp: at(seconds), message: { role: 'assistant', stop_reason: 'end_turn', content: [] } });
const noData = (): ClaudeAssistantTurnData => ({ assistantText: '', model: null, actualInputTokens: 0, actualOutputTokens: 0, toolCalls: [], mcpTools: [] });

test('buildClaudeChatTurns: a turn ends at its last assistant or tool-result event, before the next human message', () => {
	const turns = buildClaudeChatTurns(
		[claudeUser(0), claudeAssistant(4), claudeToolResult(9), claudeAssistant(15), claudeUser(600), claudeAssistant(612)],
		noData, t => t.length,
	);
	assert.equal(turns.length, 2);
	assert.equal(turns[0].endTimestamp, at(15));
	assert.equal(turns[1].endTimestamp, at(612));
});

test('buildClaudeChatTurns: a turn with no response events has no end time', () => {
	const turns = buildClaudeChatTurns([claudeUser(0)], noData, t => t.length);
	assert.equal(turns[0].endTimestamp, undefined);
});
