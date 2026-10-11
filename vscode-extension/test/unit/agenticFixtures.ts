/**
 * Shared fixtures for the agentic engineering system tests: activity totals and
 * per-repository rows with sensible zero defaults.
 */
import type { AgentActivityTotals, RepoAgentActivity, RepoAgentActivityReport } from '../../../src/types';

export function totals(overrides: Partial<AgentActivityTotals> = {}): AgentActivityTotals {
	return {
		sessions: 0, interactions: 0, tokens: 0, agenticSessions: 0, delegationSessions: 0,
		sessionsWithTurnDetail: 0, editTurns: 0, oneShotEditTurns: 0, retries: 0, selfCorrections: 0,
		toolCalls: 0, sessionsWithCorrections: 0, userCorrections: 0, toolErrors: 0, correctionMoments: 0,
		scoping: { underScoped: 0, underScopedCorrected: 0, scoped: 0, scopedCorrected: 0 },
		modes: { director: 0, performer: 0, assessor: 0 },
		...overrides,
	};
}

export function repoRow(repository: string, overrides: Partial<RepoAgentActivity> = {}): RepoAgentActivity {
	return { key: repository.toLowerCase(), repository, ...totals(), ...overrides };
}

export function activityReport(repos: RepoAgentActivity[], overrides: Partial<RepoAgentActivityReport> = {}): RepoAgentActivityReport {
	const sum = totals();
	for (const r of repos) {
		for (const k of ['sessions', 'sessionsWithTurnDetail', 'correctionMoments', 'delegationSessions', 'agenticSessions'] as const) { sum[k] += r[k]; }
		sum.modes.director += r.modes.director;
		sum.modes.performer += r.modes.performer;
		sum.modes.assessor += r.modes.assessor;
	}
	return { windowDays: 30, repos, unattributed: totals(), totals: sum, ...overrides };
}
