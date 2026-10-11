import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildActivityTrend,
    buildRepoAgentActivity,
    isAgenticSession,
    summarizeActivity,
    totalCorrectionMoments,
    type ActivitySessionInput,
} from '../../../src/repoAgentActivity';
import type { CorrectionCounts, SessionUsageAnalysis } from '../../../src/types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 25, 12);

function counts(overrides: Partial<CorrectionCounts> = {}): CorrectionCounts {
    return {
        userCorrections: 0, editRetries: 0, editSelfCorrections: 0, toolErrors: 0,
        toolErrorsRetried: 0, agentSelfCorrections: 0, escalatedUserCorrections: 0, ...overrides,
    };
}

interface SessionOptions {
    repository?: string;
    daysAgo?: number;
    agent?: boolean;
    turnDetail?: boolean;
    editTurns?: number;
    oneShot?: number;
    retries?: number;
    toolCalls?: number;
    corrections?: Partial<CorrectionCounts>;
    firstPrompt?: string;
    turns?: string[];
    subAgentCalls?: number;
    primary?: string;
}

function session(o: SessionOptions = {}): ActivitySessionInput {
    const analysis = {
        modeUsage: { ask: o.agent ? 0 : 1, edit: 0, agent: o.agent ? 3 : 0, plan: 0, customAgent: 0, cli: 0 },
        taskClassification: {
            primaryCategory: o.primary ?? 'Coding',
            categoryShares: {},
            turnCategories: o.turns ?? ['Coding'],
            turnCount: (o.turns ?? ['Coding']).length,
        },
        firstUserPrompt: o.firstPrompt,
        modelEfficiency: o.turnDetail === false ? undefined : {
            'gpt-5': {
                calls: 3, editTurns: o.editTurns ?? 2, oneShotEditTurns: o.oneShot ?? 2, retries: o.retries ?? 0,
                selfCorrections: 0, editToolCalls: 2, toolCalls: o.toolCalls ?? 4,
            },
        },
        correctionCounts: o.corrections ? counts(o.corrections) : undefined,
    } as unknown as SessionUsageAnalysis;
    return {
        repository: o.repository,
        lastInteractionMs: NOW - (o.daysAgo ?? 1) * DAY,
        interactions: 3,
        tokens: 1000,
        subAgentCalls: o.subAgentCalls,
        usageAnalysis: analysis,
    };
}

const window30 = { startMs: NOW - 30 * DAY, endMs: NOW };

test('totalCorrectionMoments: sums every moment kind, not toolErrorsRetried or escalations', () => {
    assert.equal(totalCorrectionMoments(counts({ userCorrections: 1, editRetries: 2, editSelfCorrections: 1, toolErrors: 1, agentSelfCorrections: 1, toolErrorsRetried: 5, escalatedUserCorrections: 5 })), 6);
    assert.equal(totalCorrectionMoments(undefined), 0);
});

test('buildRepoAgentActivity: groups by case-insensitive owner/repo across remote spellings', () => {
    const report = buildRepoAgentActivity([
        session({ repository: 'https://github.com/Owner/Repo.git' }),
        session({ repository: 'git@github.com:owner/repo.git' }),
        session({ repository: 'https://github.com/other/thing' }),
    ], window30);
    assert.equal(report.repos.length, 2);
    assert.equal(report.repos[0].key, 'owner/repo');
    assert.equal(report.repos[0].sessions, 2);
    assert.equal(report.totals.sessions, 3);
});

test('buildRepoAgentActivity: sessions outside the window are excluded, unresolved repos are kept apart', () => {
    const report = buildRepoAgentActivity([
        session({ repository: 'https://github.com/o/r', daysAgo: 31 }),
        session({ repository: undefined }),
        session({ repository: 'https://github.com/o/r', daysAgo: -1 }),
    ], window30);
    assert.equal(report.repos.length, 0);
    assert.equal(report.unattributed.sessions, 1);
    assert.equal(report.totals.sessions, 1);
});

test('summarizeActivity: rework counters only count sessions with turn detail', () => {
    const totals = summarizeActivity([
        session({ editTurns: 4, oneShot: 3, retries: 1, corrections: { userCorrections: 1 } }),
        session({ turnDetail: false, corrections: { userCorrections: 5 } }),
        session({ editTurns: 2, oneShot: 2 }),
    ]);
    assert.equal(totals.sessions, 3);
    assert.equal(totals.sessionsWithTurnDetail, 2);
    assert.equal(totals.editTurns, 6);
    assert.equal(totals.oneShotEditTurns, 5);
    assert.equal(totals.retries, 1);
    assert.equal(totals.sessionsWithCorrections, 1);
    assert.equal(totals.userCorrections, 1);
});

test('summarizeActivity: agentic and delegation sessions', () => {
    const totals = summarizeActivity([
        session({ agent: true }),
        session({ agent: false, subAgentCalls: 2 }),
        session({ agent: false, primary: 'Delegation' }),
        session({ agent: false, turns: ['Coding', 'Delegation', 'Testing'] }),
        session({ agent: false }),
    ]);
    assert.equal(totals.agenticSessions, 1);
    assert.equal(totals.delegationSessions, 3, 'a Delegation turn counts even when it is not the primary category');
});

test('summarizeActivity: scoping is judged on agentic turn-detail sessions only', () => {
    const totals = summarizeActivity([
        session({ agent: true, firstPrompt: 'fix it', corrections: { userCorrections: 2 } }),
        session({ agent: true, firstPrompt: 'fix it' }),
        session({ agent: true, firstPrompt: 'Add a retry with exponential backoff to the upload client and cover it with unit tests.' }),
        session({ agent: false, firstPrompt: 'fix it' }),
        session({ agent: true, turnDetail: false, firstPrompt: 'fix it' }),
    ]);
    assert.deepEqual(totals.scoping, { underScoped: 2, underScopedCorrected: 1, scoped: 1, scopedCorrected: 0 });
});

test('summarizeActivity: participation modes accumulate across sessions', () => {
    const totals = summarizeActivity([
        session({ turns: ['Planning', 'Coding'] }),
        session({ turns: ['Coding', 'Testing', 'Exploration'] }),
    ]);
    assert.deepEqual(totals.modes, { director: 1, performer: 2, assessor: 2 });
});

test('buildActivityTrend: month to date against the previous calendar month', () => {
    const now = new Date(Date.UTC(2026, 8, 10, 12)); // 10 September
    const at = (y: number, m: number, d: number): ActivitySessionInput => ({ ...session(), lastInteractionMs: Date.UTC(y, m, d, 9) });
    const trend = buildActivityTrend([at(2026, 8, 1), at(2026, 8, 9), at(2026, 7, 31), at(2026, 7, 1), at(2026, 6, 31)], now);
    assert.equal(trend.current.sessions, 2);
    assert.equal(trend.previous.sessions, 2);
    assert.equal(trend.currentDays, 10);
    assert.equal(trend.previousDays, 31);
});

test('buildActivityTrend: January compares against the previous December', () => {
    const now = new Date(Date.UTC(2027, 0, 15));
    const trend = buildActivityTrend([{ ...session(), lastInteractionMs: Date.UTC(2026, 11, 20) }], now);
    assert.equal(trend.previous.sessions, 1);
    assert.equal(trend.previousDays, 31);
});

test('isAgenticSession: every CLI surface counts, not only the terminal bucket', () => {
	const base = { ask: 1, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 };
	for (const bucket of ['cliApp', 'claudeDesktop', 'claudeVsCode'] as const) {
		const analysis = { modeUsage: { ...base, [bucket]: 2 } } as unknown as SessionUsageAnalysis;
		assert.equal(isAgenticSession(analysis), true, bucket);
	}
	assert.equal(isAgenticSession({ modeUsage: base } as unknown as SessionUsageAnalysis), false);
});

test('buildRepoAgentActivity: a GitLab repository never merges with the GitHub repository of the same name', () => {
    const report = buildRepoAgentActivity([
        session({ repository: 'https://github.com/o/r' }),
        session({ repository: 'https://gitlab.com/o/r' }),
        session({ repository: '/home/user/o/r' }),
    ], window30);
    assert.deepEqual(report.repos.map(r => r.key).sort(), ['gitlab.com/o/r', 'o/r']);
    assert.equal(report.unattributed.sessions, 1, 'a local path is not a remote');
});

test('buildActivityTrend: keeps the same windows per repository, keyed like the activity report', () => {
    const now = new Date(Date.UTC(2026, 8, 10, 12));
    const at = (repository: string, m: number): ActivitySessionInput => ({ ...session({ repository }), lastInteractionMs: Date.UTC(2026, m, 5, 9) });
    const trend = buildActivityTrend([
        at('https://github.com/O/A', 8), at('git@github.com:o/a.git', 7), at('https://github.com/o/b', 8), at('https://gitlab.com/o/a', 8),
    ], now);
    assert.equal(trend.current.sessions, 3);
    assert.equal(trend.repos?.['o/a'].current.sessions, 1);
    assert.equal(trend.repos?.['o/a'].previous.sessions, 1);
    assert.equal(trend.repos?.['o/b'].current.sessions, 1);
    assert.equal(trend.repos?.['gitlab.com/o/a'].current.sessions, 1);
});

test('buildRepoAgentActivity and buildActivityTrend: Copilot CLI slugs join the same row as remote URLs', () => {
    const cli = (repository: string): ActivitySessionInput => ({ ...session({ repository }), repositoryIsGitHubSlug: true });
    const report = buildRepoAgentActivity([
        session({ repository: 'https://github.com/Owner/Repo.git' }),
        cli('owner/repo'),
        { ...session({ repository: 'owner/repo' }) },
    ], window30);
    assert.deepEqual(report.repos.map(r => [r.key, r.sessions]), [['owner/repo', 2]]);
    assert.equal(report.unattributed.sessions, 1, 'an unmarked owner/repo string is not trusted');

    const now = new Date(NOW);
    const trend = buildActivityTrend([
        { ...cli('owner/repo'), lastInteractionMs: NOW - DAY },
        { ...session({ repository: 'git@github.com:owner/repo.git' }), lastInteractionMs: NOW - DAY },
    ], now);
    assert.equal(trend.repos?.['owner/repo'].current.sessions, 2);
});

test('summarizeActivity: a cache with correction moments but no counts still counts its corrections', () => {
    const moment = (type: string) => ({ type, turnNumber: 2, timestamp: null, snippet: '' });
    const s = session({ agent: true, firstPrompt: 'fix it' });
    s.usageAnalysis!.correctionMoments = [moment('user-correction'), moment('user-correction'), moment('tool-error')] as any;
    const totals = summarizeActivity([s]);
    assert.equal(totals.correctionMoments, 3);
    assert.equal(totals.userCorrections, 2);
    assert.equal(totals.toolErrors, 1);
    assert.equal(totals.sessionsWithCorrections, 1);
    assert.equal(totals.scoping.underScopedCorrected, 1, 'the scoping check reads the derived counts too');
});
