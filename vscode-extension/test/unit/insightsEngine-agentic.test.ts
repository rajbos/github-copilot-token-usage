import test from 'node:test';
import * as assert from 'node:assert/strict';
import { evaluateInsights, INSIGHT_CATALOG, type InsightContext } from '../../src/insightsEngine';
import { createTranslator } from '../../src/l10nCore';
import type { ActivityTrendWindows, MissedPotentialWorkspace } from '../../../src/types';
import { activityReport, repoRow, totals } from './agenticFixtures';
import { emptyPeriod } from './fixtures/insightContexts';

const EN = createTranslator('en');
const ZH = createTranslator('zh-cn');

/** Only the fields the agentic insights read; other insights stay silent on an empty period. */
function ctx(overrides: Partial<InsightContext> = {}, translate = EN): InsightContext {
	return { translate, today: emptyPeriod(), last30Days: emptyPeriod(), missedPotential: [], ...overrides };
}

function ids(c: InsightContext): string[] {
	return evaluateInsights(c, {}, 2, null).map(i => i.id);
}

function body(c: InsightContext, id: string): string {
	return evaluateInsights(c, {}, 2, null).find(i => i.id === id)!.body;
}

test('agentic insights are in the catalog', () => {
	for (const id of ['speed-without-quality', 'delegation-without-objective', 'unreviewed-agent-merges', 'review-burden-rising']) {
		assert.ok(INSIGHT_CATALOG.some(d => d.id === id), id);
	}
	assert.ok(!INSIGHT_CATALOG.some(d => d.id === 'agentic-system-stretched'), 'the foundations-score insight was removed');
});

function trend(currentAgentic: number, currentCorrections: number): ActivityTrendWindows {
	const w = (agentic: number, corrections: number) => totals({ sessions: 40, sessionsWithTurnDetail: 20, agenticSessions: agentic, correctionMoments: corrections, editTurns: 100, oneShotEditTurns: 80 });
	return { current: w(currentAgentic, currentCorrections), currentDays: 15, previous: w(15, 10), previousDays: 30 };
}

test('speed-without-quality: fires only when adoption and rework rise together', () => {
	assert.ok(ids(ctx({ activityTrend: trend(15, 20) })).includes('speed-without-quality'));
	assert.match(body(ctx({ activityTrend: trend(15, 20) }), 'speed-without-quality'), /0\.5 → 1\.0 sessions a day.*0\.50 → 1\.00/);
	assert.ok(!ids(ctx({ activityTrend: trend(15, 10) })).includes('speed-without-quality'));
	assert.ok(!ids(ctx({ activityTrend: null })).includes('speed-without-quality'));
});

function scoping(underScoped: number, underScopedCorrected: number, scoped: number, scopedCorrected: number) {
	return activityReport([], { totals: totals({ scoping: { underScoped, underScopedCorrected, scoped, scopedCorrected } }) });
}

test('delegation-without-objective: compares short-prompt sessions with the user\'s own scoped ones', () => {
	const c = ctx({ repoActivity: scoping(10, 4, 10, 1) });
	assert.ok(ids(c).includes('delegation-without-objective'));
	assert.match(body(c, 'delegation-without-objective'), /^4 of your 10 .* \(40%\), against 10%/);
	assert.ok(!ids(ctx({ repoActivity: scoping(10, 4, 10, 3) })).includes('delegation-without-objective'), 'not enough of a gap');
	assert.ok(!ids(ctx({ repoActivity: scoping(4, 4, 10, 0) })).includes('delegation-without-objective'), 'too few short-prompt sessions');
	assert.ok(!ids(ctx({ repoActivity: scoping(10, 1, 10, 0) })).includes('delegation-without-objective'), 'a single corrected session is not a pattern');
});

test('unreviewed-agent-merges: absent review wording wins over unknown, and nothing fires without agent PRs', () => {
	const unknown = ctx({ reviewControls: [{ repository: 'o/a', agentPullRequests: 'present', humanReview: 'unknown' }] });
	assert.match(body(unknown, 'unreviewed-agent-merges'), /cannot confirm/);
	const absent = ctx({ reviewControls: [
		{ repository: 'o/a', agentPullRequests: 'present', humanReview: 'unknown' },
		{ repository: 'o/b', agentPullRequests: 'present', humanReview: 'absent' },
	] });
	assert.match(body(absent, 'unreviewed-agent-merges'), /^Agents open pull requests in o\/b, but merges there do not require/);
	assert.ok(!ids(ctx({ reviewControls: [{ repository: 'o/a', agentPullRequests: 'present', humanReview: 'present' }] })).includes('unreviewed-agent-merges'));
	assert.ok(!ids(ctx({ reviewControls: [{ repository: 'o/a', agentPullRequests: 'unknown', humanReview: 'absent' }] })).includes('unreviewed-agent-merges'));
});

test('review-burden-rising: needs rising agent PR volume together with reverts or rising rework', () => {
	const rising = { repository: 'o/a', aiAuthoredRecent: 8, aiAuthoredEarlier: 4, aiRevertedPrs: 2 };
	assert.match(body(ctx({ agentPrActivity: [rising] }), 'review-burden-rising'), /^Cloud agents opened 8 pull requests in o\/a .* up from 4 .* and 2 of their merged PRs were reverted/);
	assert.ok(!ids(ctx({ agentPrActivity: [{ ...rising, aiRevertedPrs: 0 }] })).includes('review-burden-rising'), 'volume alone is not a problem');
	// Rework is judged per repository: rising rework in o/a counts for o/a…
	const reworkInA = (key: string): ActivityTrendWindows => {
		const t = trend(10, 20);
		return { ...t, repos: { [key]: { current: t.current, previous: t.previous } } };
	};
	assert.ok(ids(ctx({ agentPrActivity: [{ ...rising, aiRevertedPrs: 0 }], activityTrend: reworkInA('o/a') })).includes('review-burden-rising'));
	// …but not for o/b, even though the overall trend shows rising rework.
	assert.ok(!ids(ctx({ agentPrActivity: [{ ...rising, repository: 'o/b', aiRevertedPrs: 0 }], activityTrend: reworkInA('o/a') })).includes('review-burden-rising'),
		'another repository\'s rework must not count');
	assert.ok(!ids(ctx({ agentPrActivity: [{ ...rising, aiRevertedPrs: 0 }], activityTrend: trend(10, 20) })).includes('review-burden-rising'),
		'an overall trend without per-repository windows says nothing about o/a');
	assert.ok(!ids(ctx({ agentPrActivity: [{ ...rising, aiAuthoredRecent: 4 }] })).includes('review-burden-rising'), 'too few recent PRs');
	assert.ok(!ids(ctx({ agentPrActivity: [{ ...rising, aiAuthoredEarlier: 7 }] })).includes('review-burden-rising'), 'not rising enough');
});

test('missing-instructions: cites the user\'s own cohort difference when it qualifies', () => {
	const missed: MissedPotentialWorkspace[] = [{ workspacePath: '/w', workspaceName: 'w', sessionCount: 3, interactionCount: 9, nonCopilotFiles: [] }];
	const repo = (name: string, files: number, corrections: number) => repoRow(name, {
		sessions: 10, sessionsWithTurnDetail: 10, correctionMoments: corrections, knowledge: { instructionFiles: files, staleInstructionFiles: 0 },
	});
	const report = activityReport([repo('a/1', 1, 2), repo('a/2', 1, 2), repo('a/3', 1, 2), repo('b/1', 0, 8), repo('b/2', 0, 8), repo('b/3', 0, 8)]);
	assert.match(body(ctx({ missedPotential: missed, repoActivity: report }), 'missing-instructions'), /needed 75% fewer corrections per session\.$/);
	assert.doesNotMatch(body(ctx({ missedPotential: missed }), 'missing-instructions'), /fewer corrections/);
});

test('agentic insights resolve in zh-CN without raw keys', () => {
	const c = ctx({
		activityTrend: trend(15, 20),
		repoActivity: scoping(10, 4, 10, 1),
		reviewControls: [{ repository: 'o/a', agentPullRequests: 'present', humanReview: 'absent' }],
		agentPrActivity: [{ repository: 'o/a', aiAuthoredRecent: 8, aiAuthoredEarlier: 4, aiRevertedPrs: 2 }],
	}, ZH);
	const evaluated = evaluateInsights(c, {}, 2, null).filter(i => ['speed-without-quality', 'delegation-without-objective', 'unreviewed-agent-merges', 'review-burden-rising'].includes(i.id));
	assert.equal(evaluated.length, 4);
	for (const insight of evaluated) {
		assert.doesNotMatch(`${insight.title} ${insight.body} ${insight.actionLabel}`, /insight\./, insight.id);
		assert.match(insight.body, /[一-鿿]/, insight.id);
	}
});
