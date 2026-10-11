import test from 'node:test';
import * as assert from 'node:assert/strict';

import { toEfficiencySessionInput } from '../../../src/efficiencyViewBuilder';
import { addSessionEfficiencyToDailyStats, buildSessionEfficiencyAttribution } from '../../../src/modelEfficiency';
import { addSessionToDailyStats, sortedDailyStats } from '../../../src/statsHelpers';
import type { DailyTokenStats, ModelEfficiencyCounters } from '../../../src/types';

const counters = (over: Partial<ModelEfficiencyCounters> = {}): ModelEfficiencyCounters => ({
	calls: 2, editTurns: 2, oneShotEditTurns: 1, retries: 1, selfCorrections: 0, editToolCalls: 2,
	inputTokens: 0, outputTokens: 0, cachedReadTokens: 0,
	...over,
} as ModelEfficiencyCounters);

test('toEfficiencySessionInput sums turn counters and prefers actual tokens', () => {
	const input = toEfficiencySessionInput({
		interactions: 3, tokens: 500, actualTokens: 800,
		usageAnalysis: {
			modelEfficiency: { 'gpt-4o': counters(), 'claude-sonnet-4.5': counters({ editTurns: 3, retries: 2 }) },
			sessionDuration: { totalDurationMs: 0, avgDurationMs: 0, avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0, activeDurationMs: 60000 },
			applyUsage: { totalApplies: 4, totalCodeBlocks: 5 } as never,
			skillCalls: { total: 0, byName: {} },
		},
	}, '2026-05-02', 'VS Code');
	assert.deepEqual(input, {
		dayKey: '2026-05-02', activeDurationMs: 60000, editTurns: 5, retries: 3, applies: 4, codeBlocks: 5,
		interactions: 3, totalTokens: 800, skillCalls: undefined, editor: 'VS Code',
	});
});

test('addSessionEfficiencyToDailyStats splits tokens by day and lands counters on the last day', () => {
	const map = new Map<string, DailyTokenStats>();
	const session = {
		editorType: 'Copilot CLI',
		tokens: 1000, interactions: 2,
		modelUsage: { 'gpt-4o': { inputTokens: 800, outputTokens: 200, sessions: 0 } },
		dailyFractions: { '2026-05-01': 0.5, '2026-05-02': 0.5 },
		usageAnalysis: { modelEfficiency: { 'gpt-4o': counters() } },
	};
	addSessionToDailyStats(map, session);
	addSessionEfficiencyToDailyStats(map, session, {});
	const [first, last] = sortedDailyStats(map);
	assert.equal(first.modelEfficiency?.['gpt-4o'].inputTokens, 400);
	assert.equal(last.modelEfficiency?.['gpt-4o'].inputTokens, 400);
	assert.equal(first.modelEfficiency?.['gpt-4o'].editTurns ?? 0, 0, 'session counters must not be counted on every day');
	assert.equal(last.modelEfficiency?.['gpt-4o'].editTurns, 2);
	// The per-editor slice mirrors the day total (the editor filter relies on it).
	assert.deepEqual(last.editorModelEfficiency?.['Copilot CLI'], last.modelEfficiency);
});

test('buildSessionEfficiencyAttribution keeps deletion-only LOC from editScope', () => {
	// Deletion-only sessions carry no top-level LOC (sessionLocFromUsageAnalysis keeps LOC only
	// when lines were added), so the cached editScope is the only source of their removals.
	const attribution = buildSessionEfficiencyAttribution({
		modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 10, sessions: 0 } },
		usageAnalysis: { editScope: { singleFileEdits: 1, multiFileEdits: 0, totalEditedFiles: 1, avgFilesPerSession: 1, linesAdded: 0, linesRemoved: 7 } },
	});
	assert.equal(attribution.linesRemoved, 7);
	assert.equal(attribution.linesAdded, 0);
});

test('addSessionEfficiencyToDailyStats puts counters on the session\'s own last active day', () => {
	const map = new Map<string, DailyTokenStats>();
	const other = { editorType: 'VS Code', tokens: 10, interactions: 1, modelUsage: { 'gpt-4o': { inputTokens: 10, outputTokens: 0, sessions: 0 } }, dailyFractions: { '2026-05-03': 1 } };
	addSessionToDailyStats(map, other);
	const session = {
		editorType: 'VS Code', tokens: 100, interactions: 2,
		modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 0, sessions: 0 } },
		dailyFractions: { '2026-05-01': 1, '2026-05-03': 0 },
		usageAnalysis: { modelEfficiency: { 'gpt-4o': counters() } },
	};
	addSessionToDailyStats(map, session);
	addSessionEfficiencyToDailyStats(map, session, {});
	assert.equal(map.get('2026-05-01')!.modelEfficiency?.['gpt-4o'].editTurns, 2);
	assert.equal(map.get('2026-05-03')!.modelEfficiency?.['gpt-4o']?.editTurns ?? 0, 0, 'a day this session had no share of must not get its counters');
});

test('addSessionEfficiencyToDailyStats gives a model named like an inherited member its own entry', () => {
	// A model id such as "toString" must not resolve to Object.prototype.toString, which would be
	// mutated with counter fields while the model vanished from the Efficiency payload.
	const map = new Map<string, DailyTokenStats>();
	const session = {
		editorType: 'toString',
		tokens: 100, interactions: 1,
		modelUsage: { toString: { inputTokens: 80, outputTokens: 20, sessions: 0 } },
		dailyFractions: { '2026-05-01': 1 },
		usageAnalysis: { modelEfficiency: { toString: counters() } },
	};
	addSessionToDailyStats(map, session);
	addSessionEfficiencyToDailyStats(map, session, {});
	const day = map.get('2026-05-01')!;
	assert.equal(Object.hasOwn(day.modelEfficiency!, 'toString'), true);
	assert.equal(day.modelEfficiency!['toString' as string].inputTokens, 80);
	assert.equal(day.modelEfficiency!['toString' as string].editTurns, 2);
	assert.equal(Object.hasOwn(day.editorModelEfficiency!, 'toString'), true, 'the per-editor slice too');
	const proto = Object.prototype.toString as unknown as Record<string, unknown>;
	assert.equal(proto.inputTokens, undefined);
	assert.equal(proto.editTurns, undefined);
});
