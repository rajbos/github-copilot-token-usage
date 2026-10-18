import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
	addHydraFusionRollup,
	aggregateHydraFusionSummaries,
	createEmptyHydraFusionRollup,
	deriveHydraFusionAggregate,
	toHydraFusionRollup,
	aiuToUsd,
	analyzeHydraFusionSession,
	containsHydraFusionEvents,
	matchHydraFusionTurnsToChatTurns,
	nanoAiuToAiu,
} from '../hydrafusion';

// ── fixture builders ────────────────────────────────────────────────────────
// Field names and shapes mirror what Copilot CLI 1.0.84-x writes to
// ~/.copilot/session-state/<id>/events.jsonl. Only the fields the parser reads
// are included; the real events carry message bodies we deliberately ignore.

const AIU = 1_000_000_000;

function line(type: string, data: Record<string, unknown>, timestamp = '2026-09-11T09:00:00.000Z'): string {
	return JSON.stringify({ type, data, id: 'evt', timestamp, parentId: null });
}

function resolved(fusionId: string, overrides: Record<string, unknown> = {}): string {
	return line('session.fusion_resolved', {
		fusionId,
		syntheticModel: 'hydrafusion',
		policy: 'max',
		routeSource: 'capi_plan',
		pattern: 'cascade',
		phasePlan: [{ kind: 'primary' }, { kind: 'judge' }, { kind: 'repair' }],
		primaryModel: 'mai-code-1.1-flash',
		secondaryModel: 'gpt-5.6-sol',
		fallbackModel: 'gpt-5.6-sol',
		routingLatencyMs: 200,
		...overrides,
	});
}

function phase(fusionId: string, phaseId: string, overrides: Record<string, unknown> = {}): string {
	return line('assistant.fusion_phase_completed', {
		fusionId,
		phaseId: `${fusionId}:${phaseId}`,
		phaseKind: 'primary',
		role: 'solver',
		conversationScope: 'root',
		model: 'mai-code-1.1-flash',
		status: 'succeeded',
		verdict: null,
		durationMs: 22_000,
		usage: { requestCount: 1, inputTokens: 1000, outputTokens: 100, cachedTokens: 700, cacheWriteTokens: 0, totalNanoAiu: 1 * AIU },
		...overrides,
	});
}

function completed(fusionId: string, overrides: Record<string, unknown> = {}): string {
	return line('session.fusion_completed', {
		fusionId,
		syntheticModel: 'hydrafusion',
		pattern: 'cascade',
		outcome: 'completed',
		finalSourcePhaseId: `${fusionId}:repair`,
		finalSourceModel: 'gpt-5.6-sol',
		degradedReason: null,
		phaseCount: 3,
		requestCount: 7,
		inputTokens: 3000,
		outputTokens: 300,
		cachedTokens: 2000,
		cacheWriteTokens: 0,
		totalNanoAiu: 14.72 * AIU,
		durationMs: 77_000,
		...overrides,
	});
}

/** A full cascade turn: a cheap draft, a judge that rejects it, and a repair on a stronger model. */
function cascadeSession(fusionId = 'fusion-1'): string {
	return [
		resolved(fusionId),
		phase(fusionId, 'phase:0', { usage: { requestCount: 1, inputTokens: 1000, outputTokens: 100, cachedTokens: 700, cacheWriteTokens: 0, totalNanoAiu: 0.58 * AIU } }),
		phase(fusionId, 'judge', {
			phaseKind: 'judge', role: 'judge', conversationScope: 'review', model: 'gpt-5.6-sol', verdict: 'reject', durationMs: 4_500,
			usage: { requestCount: 1, inputTokens: 12_500, outputTokens: 7, cachedTokens: 7_680, cacheWriteTokens: 0, totalNanoAiu: 2.45 * AIU },
		}),
		phase(fusionId, 'repair', {
			phaseKind: 'repair', role: 'solver', model: 'gpt-5.6-sol', durationMs: 42_000,
			usage: { requestCount: 5, inputTokens: 40_000, outputTokens: 900, cachedTokens: 30_000, cacheWriteTokens: 0, totalNanoAiu: 11.69 * AIU },
		}),
		line('session.fusion_handoff', { fusionId, sourcePhaseId: `${fusionId}:judge`, targetPhaseId: `${fusionId}:repair`, targetModel: 'gpt-5.6-sol' }),
		completed(fusionId),
	].join('\n');
}

/** A single-model turn: one primary leg, no review. */
function singleSession(fusionId = 'fusion-single'): string {
	return [
		resolved(fusionId, { pattern: 'single', phasePlan: [{ kind: 'primary' }], routingLatencyMs: 300 }),
		phase(fusionId, 'phase:0', {
			model: 'gpt-5.6-sol', durationMs: 10_000,
			usage: { requestCount: 2, inputTokens: 500, outputTokens: 50, cachedTokens: 100, cacheWriteTokens: 0, totalNanoAiu: 8 * AIU },
		}),
		completed(fusionId, {
			pattern: 'single', finalSourcePhaseId: `${fusionId}:phase:0`, finalSourceModel: 'gpt-5.6-sol',
			phaseCount: 1, requestCount: 2, inputTokens: 500, outputTokens: 50, cachedTokens: 100,
			totalNanoAiu: 8 * AIU, durationMs: 10_000,
		}),
	].join('\n');
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('nanoAiuToAiu', () => {
	test('scales the CLI nano-AIU integer down to credits', () => {
		assert.equal(nanoAiuToAiu(14_720_000_000), 14.72);
	});

	test('treats a missing or non-numeric value as zero spend', () => {
		assert.equal(nanoAiuToAiu(undefined), 0);
		assert.equal(nanoAiuToAiu('11429228000'), 0);
	});
});

describe('containsHydraFusionEvents', () => {
	test('detects a session that routed through HydraFusion', () => {
		assert.equal(containsHydraFusionEvents(cascadeSession()), true);
	});

	test('rejects an ordinary CLI session with no fusion events', () => {
		const ordinary = [
			line('user.message', { content: 'hello' }),
			line('assistant.message', { content: 'hi' }),
		].join('\n');
		assert.equal(containsHydraFusionEvents(ordinary), false);
	});
});

describe('analyzeHydraFusionSession', () => {
	test('returns undefined for a session that never used HydraFusion', () => {
		assert.equal(analyzeHydraFusionSession(line('user.message', { content: 'hi' })), undefined);
		assert.equal(analyzeHydraFusionSession(''), undefined);
	});

	test('reconstructs a cascade turn leg by leg, in completion order', () => {
		const summary = analyzeHydraFusionSession(cascadeSession());
		assert.ok(summary);
		assert.equal(summary.totalTurns, 1);

		const turn = summary.turns[0];
		assert.equal(turn.pattern, 'cascade');
		assert.equal(turn.outcome, 'completed');
		assert.deepEqual(turn.phases.map(p => p.kind), ['primary', 'judge', 'repair']);
		assert.deepEqual(turn.phases.map(p => p.model), ['mai-code-1.1-flash', 'gpt-5.6-sol', 'gpt-5.6-sol']);
		assert.deepEqual(turn.plannedPhases, ['primary', 'judge', 'repair']);
		assert.equal(turn.isCompound, true);
	});

	test('reads the routing decision, including that it was served remotely', () => {
		const turn = analyzeHydraFusionSession(cascadeSession())!.turns[0];
		assert.equal(turn.policy, 'max');
		assert.equal(turn.routeSource, 'capi_plan');
		assert.equal(turn.routingLatencyMs, 200);
		assert.equal(turn.primaryModel, 'mai-code-1.1-flash');
		assert.equal(turn.fallbackModel, 'gpt-5.6-sol');
	});

	test('marks only the leg named by finalSourcePhaseId as the delivered answer', () => {
		const turn = analyzeHydraFusionSession(cascadeSession())!.turns[0];
		assert.deepEqual(turn.phases.map(p => p.isFinalSource), [false, false, true]);
		assert.equal(turn.finalSourceModel, 'gpt-5.6-sol');
	});

	test('captures the judge verdict on the judging leg and leaves other legs null', () => {
		const turn = analyzeHydraFusionSession(cascadeSession())!.turns[0];
		assert.deepEqual(turn.phases.map(p => p.verdict), [null, 'reject', null]);
	});

	test('records the escalation handoff from the rejecting judge', () => {
		const turn = analyzeHydraFusionSession(cascadeSession())!.turns[0];
		assert.deepEqual(turn.handoffs, [{
			sourcePhaseId: 'fusion-1:judge',
			targetPhaseId: 'fusion-1:repair',
			targetModel: 'gpt-5.6-sol',
		}]);
	});

	test('takes turn totals from the rollup, not from re-summing the legs', () => {
		// The rollup says 14.72 AIU while the legs sum to 14.72 as well; the point is
		// that the two must never be added together. Set the rollup apart to prove which wins.
		const content = cascadeSession().replace(String(14.72 * AIU), String(99 * AIU));
		const turn = analyzeHydraFusionSession(content)!.turns[0];
		assert.equal(turn.aiu, 99);
		assert.equal(analyzeHydraFusionSession(content)!.totalAiu, 99);
	});

	test('counts credits on non-answering legs as review spend', () => {
		const summary = analyzeHydraFusionSession(cascadeSession())!;
		// draft 0.58 + judge 2.45 were superseded; the repair leg supplied the answer.
		assert.ok(Math.abs(summary.reviewAiu - 3.03) < 1e-9);
		assert.ok(Math.abs(summary.reviewSharePercent - (3.03 / 14.72) * 100) < 1e-9);
	});

	test('a single-model turn spends nothing on review', () => {
		const summary = analyzeHydraFusionSession(singleSession())!;
		assert.equal(summary.reviewAiu, 0);
		assert.equal(summary.reviewSharePercent, 0);
		assert.equal(summary.compoundTurns, 0);
		assert.equal(summary.turns[0].isCompound, false);
	});

	test('computes the compound rate across a mixed session', () => {
		const summary = analyzeHydraFusionSession(`${cascadeSession('fusion-a')}\n${singleSession('fusion-b')}`)!;
		assert.equal(summary.totalTurns, 2);
		assert.equal(summary.compoundTurns, 1);
		assert.equal(summary.compoundRatePercent, 50);
	});

	test('computes the judge rejection rate over judged drafts only', () => {
		const accepted = cascadeSession('fusion-b').replace('"verdict":"reject"', '"verdict":"accept"');
		const summary = analyzeHydraFusionSession(`${cascadeSession('fusion-a')}\n${accepted}`)!;
		assert.equal(summary.judgeRejects, 1);
		assert.equal(summary.judgeAccepts, 1);
		assert.equal(summary.judgeRejectionRatePercent, 50);
	});

	test('reports no rejection rate at all when no judge ever ran', () => {
		const summary = analyzeHydraFusionSession(singleSession())!;
		assert.equal(summary.judgeRejectionRatePercent, null);
	});

	test('ranks models by credits spent and counts the answers each supplied', () => {
		const summary = analyzeHydraFusionSession(cascadeSession())!;
		assert.deepEqual(summary.models, ['gpt-5.6-sol', 'mai-code-1.1-flash']);
		const sol = summary.byModel[0];
		assert.equal(sol.legs, 2);
		assert.equal(sol.finalAnswers, 1);
		assert.ok(Math.abs(sol.aiu - 14.14) < 1e-9);
		assert.equal(summary.byModel[1].finalAnswers, 0);
	});

	test('builds the phase ledger by what each leg was for', () => {
		const summary = analyzeHydraFusionSession(cascadeSession())!;
		const kinds = Object.fromEntries(summary.byPhaseKind.map(p => [p.kind, p.aiu]));
		assert.ok(Math.abs(kinds['repair'] - 11.69) < 1e-9);
		assert.ok(Math.abs(kinds['judge'] - 2.45) < 1e-9);
		assert.ok(Math.abs(kinds['primary'] - 0.58) < 1e-9);
		// Highest spend first, so the ledger reads as a ranking.
		assert.equal(summary.byPhaseKind[0].kind, 'repair');
	});

	test('counts legs and inference calls as separate numbers', () => {
		const summary = analyzeHydraFusionSession(cascadeSession())!;
		assert.equal(summary.totalLegs, 3);
		assert.equal(summary.totalRequestCount, 7);
	});

	test('groups pattern counts with their spend, most frequent first', () => {
		const summary = analyzeHydraFusionSession(
			[cascadeSession('fusion-a'), singleSession('fusion-b'), singleSession('fusion-c')].join('\n'),
		)!;
		assert.deepEqual(summary.patternCounts.map(p => p.pattern), ['single', 'cascade']);
		assert.equal(summary.patternCounts[0].turns, 2);
		assert.equal(summary.patternCounts[0].aiu, 16);
	});

	test('averages routing latency across turns that reported it', () => {
		const summary = analyzeHydraFusionSession(`${cascadeSession('fusion-a')}\n${singleSession('fusion-b')}`)!;
		assert.equal(summary.avgRoutingLatencyMs, 250);
	});

	test('flags turns where the router fell back off its plan', () => {
		const degraded = cascadeSession('fusion-d').replace('"degradedReason":null', '"degradedReason":"judge_timeout"');
		const summary = analyzeHydraFusionSession(degraded)!;
		assert.equal(summary.degradedTurns, 1);
		assert.equal(summary.turns[0].degradedReason, 'judge_timeout');
	});

	test('surfaces the synthetic model the user actually selected', () => {
		assert.equal(analyzeHydraFusionSession(cascadeSession())!.syntheticModel, 'hydrafusion');
	});

	test('still reports an in-flight turn that has legs but no rollup yet', () => {
		const content = [
			resolved('fusion-x'),
			phase('fusion-x', 'phase:0', { usage: { requestCount: 3, inputTokens: 900, outputTokens: 80, cachedTokens: 0, cacheWriteTokens: 0, totalNanoAiu: 2 * AIU } }),
		].join('\n');
		const summary = analyzeHydraFusionSession(content)!;
		assert.equal(summary.totalTurns, 1);
		assert.equal(summary.turns[0].outcome, null);
		// Totals fall back to summing the legs so the turn is not reported as free.
		assert.equal(summary.turns[0].aiu, 2);
		assert.equal(summary.turns[0].requestCount, 3);
		// With no rollup to name it, the last non-review leg stands in as the answer.
		assert.equal(summary.turns[0].phases[0].isFinalSource, true);
		assert.equal(summary.turns[0].finalSourceModel, 'mai-code-1.1-flash');
	});

	test('never treats a review leg as the answer when the rollup is missing', () => {
		const content = [
			resolved('fusion-y'),
			phase('fusion-y', 'phase:0'),
			phase('fusion-y', 'judge', { phaseKind: 'judge', role: 'judge', conversationScope: 'review', model: 'gpt-5.6-sol', verdict: 'reject' }),
		].join('\n');
		const turn = analyzeHydraFusionSession(content)!.turns[0];
		assert.deepEqual(turn.phases.map(p => p.isFinalSource), [true, false]);
	});

	test('skips malformed lines instead of discarding the whole session', () => {
		const content = `${cascadeSession()}\n{"type":"session.fusion_completed","data":`;
		const summary = analyzeHydraFusionSession(content)!;
		assert.equal(summary.totalTurns, 1);
	});

	test('ignores fusion events that carry no fusionId to group them by', () => {
		const content = `${cascadeSession()}\n${line('session.fusion_resolved', { pattern: 'single' })}`;
		assert.equal(analyzeHydraFusionSession(content)!.totalTurns, 1);
	});

	test('tolerates unknown phase kinds and patterns from a newer CLI', () => {
		const content = [
			resolved('fusion-z', { pattern: 'ensemble', phasePlan: [{ kind: 'vote' }] }),
			phase('fusion-z', 'phase:0', { phaseKind: 'vote', role: 'voter' }),
			completed('fusion-z', { pattern: 'ensemble', finalSourcePhaseId: 'fusion-z:phase:0' }),
		].join('\n');
		const summary = analyzeHydraFusionSession(content)!;
		assert.equal(summary.turns[0].pattern, 'ensemble');
		assert.equal(summary.byPhaseKind[0].kind, 'vote');
	});

	test('falls back to sane defaults when a leg omits optional fields', () => {
		const content = [
			resolved('fusion-w'),
			line('assistant.fusion_phase_completed', { fusionId: 'fusion-w', phaseId: 'fusion-w:phase:0' }),
		].join('\n');
		const phaseResult = analyzeHydraFusionSession(content)!.turns[0].phases[0];
		assert.equal(phaseResult.model, 'unknown');
		assert.equal(phaseResult.kind, 'unknown');
		assert.equal(phaseResult.usage.aiu, 0);
		assert.equal(phaseResult.verdict, null);
	});

	test('keeps turns separated by fusionId even when their events interleave', () => {
		const content = [
			resolved('fusion-a', { pattern: 'single', phasePlan: [{ kind: 'primary' }] }),
			resolved('fusion-b', { pattern: 'single', phasePlan: [{ kind: 'primary' }] }),
			phase('fusion-a', 'phase:0', { model: 'model-a' }),
			phase('fusion-b', 'phase:0', { model: 'model-b' }),
		].join('\n');
		const summary = analyzeHydraFusionSession(content)!;
		assert.equal(summary.totalTurns, 2);
		assert.deepEqual(summary.turns.map(t => t.phases[0].model), ['model-a', 'model-b']);
	});
});

describe('aiuToUsd', () => {
	test('converts AI credits to dollars at the documented $0.01-per-credit rate', () => {
		assert.equal(aiuToUsd(14.72), 0.1472);
		assert.equal(aiuToUsd(0), 0);
	});
});

describe('matchHydraFusionTurnsToChatTurns', () => {
	/** A minimal one-leg fusion turn, timestamped so matching tests control ordering directly. */
	function fusionTurnAt(fusionId: string, timestamp: string): string {
		return [
			line('session.fusion_resolved', { fusionId, pattern: 'single', phasePlan: [{ kind: 'primary' }] }, timestamp),
			line('assistant.fusion_phase_completed', { fusionId, phaseId: `${fusionId}:phase:0`, phaseKind: 'primary', model: 'm', usage: { totalNanoAiu: AIU } }, timestamp),
			line('session.fusion_completed', { fusionId, finalSourcePhaseId: `${fusionId}:phase:0`, totalNanoAiu: AIU }, timestamp),
		].join('\n');
	}

	test('matches each fusion turn to the last chat turn whose prompt preceded it', () => {
		const content = [
			fusionTurnAt('f1', '2026-01-01T00:00:05.000Z'),
			fusionTurnAt('f2', '2026-01-01T00:00:15.000Z'),
		].join('\n');
		const summary = analyzeHydraFusionSession(content)!;
		const chatTurns = [
			{ turnNumber: 1, timestamp: '2026-01-01T00:00:00.000Z' },
			{ turnNumber: 2, timestamp: '2026-01-01T00:00:10.000Z' },
		];
		const matches = matchHydraFusionTurnsToChatTurns(chatTurns, summary.turns);
		assert.equal(matches.get(0), 1);
		assert.equal(matches.get(1), 2);
	});

	test('skips a chat turn a non-fusion model handled, rather than mismatching the next fusion turn to it', () => {
		// Turn 2 wasn't routed through HydraFusion (no fusion turn resolves between it and turn 3),
		// so it must not absorb f1's match even though it's chronologically closest.
		const content = [
			fusionTurnAt('f1', '2026-01-01T00:00:05.000Z'),
			fusionTurnAt('f2', '2026-01-01T00:00:25.000Z'),
		].join('\n');
		const summary = analyzeHydraFusionSession(content)!;
		const chatTurns = [
			{ turnNumber: 1, timestamp: '2026-01-01T00:00:00.000Z' },
			{ turnNumber: 2, timestamp: '2026-01-01T00:00:10.000Z' },
			{ turnNumber: 3, timestamp: '2026-01-01T00:00:20.000Z' },
		];
		const matches = matchHydraFusionTurnsToChatTurns(chatTurns, summary.turns);
		assert.equal(matches.get(0), 1);
		assert.equal(matches.get(1), 3);
	});

	test('leaves a fusion turn unmatched when no chat turn timestamp precedes it', () => {
		const content = fusionTurnAt('f1', '2020-01-01T00:00:00.000Z');
		const summary = analyzeHydraFusionSession(content)!;
		const chatTurns = [{ turnNumber: 1, timestamp: '2026-01-01T00:00:00.000Z' }];
		const matches = matchHydraFusionTurnsToChatTurns(chatTurns, summary.turns);
		assert.equal(matches.size, 0);
	});

	test('known limitation: attaches to a nearby non-fusion turn when the real trigger is missing from chatTurns entirely', () => {
		// Unlike the "skips a chat turn a non-fusion model handled" case above, here chat turn 2
		// is the ONLY turn available before f2 — there is no turn 3 in the list at all (e.g. it
		// was dropped upstream during turn extraction). matchHydraFusionTurnsToChatTurns has no
		// way to tell "the real trigger is missing" apart from "turn 2 is genuinely closest", so
		// it attaches f2 there. Documented in the function's own doc comment as a known trade-off
		// that would need a shared turn id to fully close.
		const content = [
			fusionTurnAt('f1', '2026-01-01T00:00:05.000Z'),
			fusionTurnAt('f2', '2026-01-01T00:00:25.000Z'),
		].join('\n');
		const summary = analyzeHydraFusionSession(content)!;
		const chatTurns = [
			{ turnNumber: 1, timestamp: '2026-01-01T00:00:00.000Z' },
			{ turnNumber: 2, timestamp: '2026-01-01T00:00:10.000Z' },
		];
		const matches = matchHydraFusionTurnsToChatTurns(chatTurns, summary.turns);
		assert.equal(matches.get(0), 1);
		assert.equal(matches.get(1), 2);
	});

	test('never matches a chat turn with no timestamp, even when it is otherwise the nearest one', () => {
		const content = fusionTurnAt('f1', '2026-01-01T00:00:20.000Z');
		const summary = analyzeHydraFusionSession(content)!;
		const chatTurns = [
			{ turnNumber: 1, timestamp: '2026-01-01T00:00:00.000Z' },
			{ turnNumber: 2, timestamp: null },
		];
		const matches = matchHydraFusionTurnsToChatTurns(chatTurns, summary.turns);
		assert.equal(matches.get(0), 1);
	});

	test('a chat turn with no timestamp is skipped permanently, not left blocking every later fusion turn', () => {
		// Regression test: an earlier version broke out of the advancement loop on an
		// unusable timestamp without moving past it, so chatIndex stayed pinned there —
		// every subsequent fusion turn hit the same bad entry immediately and could never
		// reach turn 3, even though it has a perfectly good timestamp.
		const content = [
			fusionTurnAt('f1', '2026-01-01T00:00:05.000Z'),
			fusionTurnAt('f2', '2026-01-01T00:00:25.000Z'),
		].join('\n');
		const summary = analyzeHydraFusionSession(content)!;
		const chatTurns = [
			{ turnNumber: 1, timestamp: '2026-01-01T00:00:00.000Z' },
			{ turnNumber: 2, timestamp: null },
			{ turnNumber: 3, timestamp: '2026-01-01T00:00:20.000Z' },
		];
		const matches = matchHydraFusionTurnsToChatTurns(chatTurns, summary.turns);
		assert.equal(matches.get(0), 1);
		assert.equal(matches.get(1), 3);
	});

	test('returns an empty map for a session with no fusion turns', () => {
		const chatTurns = [{ turnNumber: 1, timestamp: '2026-01-01T00:00:00.000Z' }];
		assert.equal(matchHydraFusionTurnsToChatTurns(chatTurns, []).size, 0);
	});
});

describe('aggregateHydraFusionSummaries', () => {
	const cascade = (id?: string) => analyzeHydraFusionSession(cascadeSession(id))!;
	const single = () => analyzeHydraFusionSession(singleSession())!;

	test('empty input yields zero totals and null rates, not NaN', () => {
		const agg = aggregateHydraFusionSummaries([]);
		assert.equal(agg.sessions, 0);
		assert.equal(agg.totalTurns, 0);
		assert.equal(agg.aiuPerTurn, null);
		assert.equal(agg.usdPerTurn, null);
		assert.equal(agg.judgeRejectionRatePercent, null);
		assert.equal(agg.compoundRatePercent, 0);
		assert.equal(agg.reviewSharePercent, 0);
		assert.equal(agg.escalationRatePercent, 0);
		assert.deepEqual(agg.patternCounts, []);
	});

	test('sums turns, judge decisions, escalations and the pattern mix across sessions', () => {
		const agg = aggregateHydraFusionSummaries([cascade(), single(), cascade('fusion-2')]);
		assert.equal(agg.sessions, 3);
		assert.equal(agg.totalTurns, 3);
		assert.equal(agg.compoundTurns, 2);
		assert.equal(agg.judgeRejects, 2);
		assert.equal(agg.judgeAccepts, 0);
		assert.equal(agg.judgeRejectionRatePercent, 100);
		assert.equal(agg.escalatedTurns, 2);
		assert.ok(Math.abs(agg.compoundRatePercent - 66.666) < 0.01);
		assert.ok(Math.abs(agg.escalationRatePercent - 66.666) < 0.01);
		assert.deepEqual(agg.patternCounts.map(p => [p.pattern, p.turns]), [['cascade', 2], ['single', 1]]);
	});

	test('credits come from the per-turn rollups, never rollups plus legs (double-count guard)', () => {
		const agg = aggregateHydraFusionSummaries([cascade(), single()]);
		// cascade rollup 14.72 AIU (its legs sum to 14.72 as well); single 8 AIU.
		assert.ok(Math.abs(agg.totalAiu - 22.72) < 1e-9);
		assert.ok(Math.abs(agg.aiuPerTurn! - 11.36) < 1e-9);
		assert.ok(Math.abs(agg.totalUsd - aiuToUsd(22.72)) < 1e-9);
		assert.ok(Math.abs(agg.usdPerTurn! - aiuToUsd(11.36)) < 1e-9);
	});

	test('review share is the review credits over total credits', () => {
		const agg = aggregateHydraFusionSummaries([cascade(), single()]);
		const expected = (cascade().reviewAiu / 22.72) * 100;
		assert.ok(agg.reviewSharePercent > 0);
		assert.ok(Math.abs(agg.reviewSharePercent - expected) < 1e-9);
	});

	test('does not mutate its inputs and returns an independent pattern list', () => {
		const a = cascade();
		const before = JSON.stringify(a);
		const agg = aggregateHydraFusionSummaries([a]);
		agg.patternCounts[0].turns = 99;
		assert.equal(JSON.stringify(a), before);
	});

	test('rollups are additive: summing per-session rollups equals aggregating the summaries', () => {
		const total = createEmptyHydraFusionRollup();
		addHydraFusionRollup(total, toHydraFusionRollup(cascade()));
		addHydraFusionRollup(total, toHydraFusionRollup(single()));
		assert.deepEqual(deriveHydraFusionAggregate(total), aggregateHydraFusionSummaries([cascade(), single()]));
	});

	test('a rollup carries counts and credits only (no model ids or prompts)', () => {
		const keys = Object.keys(toHydraFusionRollup(cascade())).sort();
		assert.deepEqual(keys, ['compoundTurns', 'degradedTurns', 'escalatedTurns', 'judgeAccepts', 'judgeRejects', 'patternCounts', 'reviewAiu', 'sessions', 'totalAiu', 'totalTurns']);
	});
});
