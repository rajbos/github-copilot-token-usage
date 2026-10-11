/**
 * Agentic engineering system signals in the Usage Analysis view: the
 * per-repository rework summary on the Corrections tab and the
 * Director / Performer / Assessor card on the Insights tab.
 *
 * See docs/features/AGENTIC-ENGINEERING-SIGNALS.md. Everything rendered here
 * is local — it is computed from the user's own session cache and never
 * uploaded or shared.
 *
 * Pure string building plus payload sanitizers, so it can be unit tested
 * without a DOM.
 */
import { escapeHtml, formatFixed, formatNumber, formatPercent } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import {
	compareInstructionCohorts,
	computeReworkRates,
	MIN_COHORT_REPOS,
	MIN_COHORT_SESSIONS,
	MIN_REPO_TURN_DETAIL_SESSIONS,
} from '../../../../src/knowledgeSignals';
import { modeShares } from '../../../../src/participationModes';
import type {
	AgentActivityTotals,
	ParticipationModeCounts,
	RepoAgentActivity,
	RepoAgentActivityReport,
} from '../../../../src/types';

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

const TOTAL_KEYS = [
	'sessions', 'interactions', 'tokens', 'agenticSessions', 'delegationSessions', 'sessionsWithTurnDetail',
	'editTurns', 'oneShotEditTurns', 'retries', 'selfCorrections', 'toolCalls', 'sessionsWithCorrections',
	'userCorrections', 'toolErrors', 'correctionMoments',
] as const;

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeModes(raw: any): ParticipationModeCounts | null {
	const director = count(raw?.director);
	const performer = count(raw?.performer);
	const assessor = count(raw?.assessor);
	return director === null || performer === null || assessor === null ? null : { director, performer, assessor };
}

/** Validate one activity total; null when any counter is missing or not a non-negative number. */
export function sanitizeActivityTotals(raw: any): AgentActivityTotals | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const totals: Partial<AgentActivityTotals> = {};
	for (const key of TOTAL_KEYS) {
		const value = count(raw[key]);
		if (value === null) { return null; }
		totals[key] = value;
	}
	const s = raw.scoping;
	const scoping = {
		underScoped: count(s?.underScoped),
		underScopedCorrected: count(s?.underScopedCorrected),
		scoped: count(s?.scoped),
		scopedCorrected: count(s?.scopedCorrected),
	};
	if (Object.values(scoping).some(v => v === null)) { return null; }
	const modes = sanitizeModes(raw.modes);
	if (!modes) { return null; }
	return { ...(totals as AgentActivityTotals), scoping: scoping as AgentActivityTotals['scoping'], modes };
}

function sanitizeRepoRow(raw: any): RepoAgentActivity | null {
	const totals = sanitizeActivityTotals(raw);
	if (!totals || typeof raw.key !== 'string' || typeof raw.repository !== 'string') { return null; }
	const row: RepoAgentActivity = { key: raw.key, repository: raw.repository, ...totals };
	const files = count(raw.knowledge?.instructionFiles);
	const stale = count(raw.knowledge?.staleInstructionFiles);
	if (files !== null && stale !== null && stale <= files) {
		row.knowledge = { instructionFiles: files, staleInstructionFiles: stale };
	}
	return row;
}

/** Validate the per-repository activity report; null when absent or malformed. */
export function sanitizeRepoActivity(raw: any): RepoAgentActivityReport | null {
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.repos)) { return null; }
	const windowDays = count(raw.windowDays);
	const unattributed = sanitizeActivityTotals(raw.unattributed);
	const totals = sanitizeActivityTotals(raw.totals);
	if (windowDays === null || !unattributed || !totals) { return null; }
	const repos = raw.repos.map(sanitizeRepoRow).filter((r: RepoAgentActivity | null): r is RepoAgentActivity => r !== null);
	return { windowDays, repos, unattributed, totals };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const DASH = '—';

function rateCell(value: number | null, digits = 2): string {
	return value === null ? DASH : formatFixed(value, digits);
}

function percentCell(value: number | null): string {
	return value === null ? DASH : formatPercent(value * 100, 0);
}

function knowledgeCell(row: RepoAgentActivity): string {
	if (!row.knowledge) {
		return `<span title="${escapeHtml(localize('agentic.repoSummary.knowledgeUnknownTitle'))}">${escapeHtml(localize('agentic.repoSummary.knowledgeUnknown'))}</span>`;
	}
	const { instructionFiles, staleInstructionFiles } = row.knowledge;
	if (instructionFiles === 0) {
		return `<span class="stale-warning">${escapeHtml(localize('agentic.repoSummary.knowledgeNone'))}</span>`;
	}
	const stale = staleInstructionFiles > 0
		? ` <span class="stale-warning">${escapeHtml(localizeFormat('agentic.repoSummary.knowledgeStale', staleInstructionFiles))}</span>`
		: '';
	return `${formatNumber(instructionFiles)}${stale}`;
}

// ---------------------------------------------------------------------------
// Corrections tab: rework per repository
// ---------------------------------------------------------------------------

/**
 * Rows to show: every repository with a turn-detail session, most sessions first. All of them, so a
 * repository driving rework is never hidden while the cohort comparison below still counts it.
 */
function summaryRows(report: RepoAgentActivityReport): RepoAgentActivity[] {
	return report.repos.filter(r => r.sessionsWithTurnDetail > 0);
}

function repoSummaryRowHtml(row: RepoAgentActivity): string {
	const rates = computeReworkRates(row);
	const small = row.sessionsWithTurnDetail < MIN_REPO_TURN_DETAIL_SESSIONS
		? ` <span class="agentic-muted" title="${escapeHtml(localizeFormat('agentic.repoSummary.smallSampleTitle', MIN_REPO_TURN_DETAIL_SESSIONS))}">*</span>`
		: '';
	return `<tr>
		<td>${escapeHtml(row.repository)}${small}</td>
		<td style="text-align:right;">${formatNumber(row.sessionsWithTurnDetail)} / ${formatNumber(row.sessions)}</td>
		<td style="text-align:right;">${rateCell(rates.correctionsPerSession)}</td>
		<td style="text-align:right;">${percentCell(rates.correctedSessionShare)}</td>
		<td style="text-align:right;">${percentCell(rates.oneShotRate)}</td>
		<td style="text-align:right;">${rateCell(rates.toolCallsPerEditTurn, 1)}</td>
		<td style="text-align:right;">${knowledgeCell(row)}</td>
	</tr>`;
}

/** The cohort sentence, or an explanation of why there is none. */
export function buildCohortComparisonHtml(report: RepoAgentActivityReport): string {
	const comparison = compareInstructionCohorts(report.repos);
	if (!comparison.qualifies) {
		return `<div class="agentic-note">${escapeHtml(localizeFormat(
			'agentic.repoSummary.cohortNotEnough', MIN_COHORT_REPOS, MIN_COHORT_SESSIONS, MIN_REPO_TURN_DETAIL_SESSIONS,
		))}</div>`;
	}
	if (comparison.correctionsReductionPct === null) {
		// Enough data, but the without-instructions median is zero: there is no baseline to take a percentage of.
		return `<div class="agentic-note">${escapeHtml(localizeFormat(
			'agentic.repoSummary.cohortZeroBaseline',
			comparison.withoutInstructions.repos,
			(comparison.withInstructions.medianCorrectionsPerSession ?? 0).toFixed(2),
			comparison.withInstructions.repos,
		))} ${escapeHtml(localize('agentic.repoSummary.cohortCaveat'))}</div>`;
	}
	const pct = Math.round(Math.abs(comparison.correctionsReductionPct));
	const key = comparison.correctionsReductionPct >= 0 ? 'agentic.repoSummary.cohortFewer' : 'agentic.repoSummary.cohortMore';
	return `<div class="agentic-note agentic-note-strong">${escapeHtml(localizeFormat(
		key, pct, comparison.withInstructions.repos, comparison.withoutInstructions.repos,
	))} ${escapeHtml(localize('agentic.repoSummary.cohortCaveat'))}</div>`;
}

/** Per-repository rework table for the Corrections tab. Empty string when there is nothing to show. */
export function buildCorrectionsRepoSummaryHtml(report: RepoAgentActivityReport | null | undefined): string {
	if (!report) { return ''; }
	const rows = summaryRows(report);
	const unattributed = report.unattributed.sessions > 0
		? `<div class="agentic-muted" style="margin-top:6px;">${escapeHtml(localizeFormat(
			'agentic.repoSummary.unattributed', report.unattributed.sessions, report.totals.sessions,
		))}</div>`
		: '';
	if (rows.length === 0 && !unattributed) { return ''; }
	const heading = `<div class="section-subtitle" style="margin-top:4px;"><strong>${escapeHtml(localize('agentic.repoSummary.title'))}</strong> —
			${escapeHtml(localizeFormat('agentic.repoSummary.subtitle', report.windowDays))}</div>`;
	// No repository to show a rate for, but sessions were left out: say how many, so an empty
	// table is not read as "no data".
	if (rows.length === 0) {
		return `<div class="agentic-repo-summary" id="corrections-repo-summary">
		${heading}
		${unattributed}
	</div>`;
	}
	return `<div class="agentic-repo-summary" id="corrections-repo-summary">
		${heading}
		<div class="customization-matrix-container" style="margin-top:8px;">
			<table class="customization-matrix agentic-table">
				<thead><tr>
					<th style="text-align:left;">${escapeHtml(localize('agentic.repoSummary.colRepository'))}</th>
					<th title="${escapeHtml(localize('agentic.repoSummary.colSessionsTitle'))}">${escapeHtml(localize('agentic.repoSummary.colSessions'))}</th>
					<th>${escapeHtml(localize('agentic.repoSummary.colCorrections'))}</th>
					<th>${escapeHtml(localize('agentic.repoSummary.colCorrected'))}</th>
					<th>${escapeHtml(localize('agentic.repoSummary.colOneShot'))}</th>
					<th title="${escapeHtml(localize('agentic.repoSummary.colChurnTitle'))}">${escapeHtml(localize('agentic.repoSummary.colChurn'))}</th>
					<th title="${escapeHtml(localize('agentic.repoSummary.colKnowledgeTitle'))}">${escapeHtml(localize('agentic.repoSummary.colKnowledge'))}</th>
				</tr></thead>
				<tbody>${rows.map(repoSummaryRowHtml).join('')}</tbody>
			</table>
		</div>
		${buildCohortComparisonHtml(report)}
		${unattributed}
	</div>`;
}

// ---------------------------------------------------------------------------
// Insights tab: Director / Performer / Assessor
// ---------------------------------------------------------------------------

/** Minimum classified turns before the split is shown. */
export const MIN_MODE_TURNS = 20;
/** Delegation share at or above which a low assessor share is called out. */
export const HIGH_DELEGATION_SHARE = 0.25;
/** Assessor share below which checking is called out as thin. */
export const LOW_ASSESSOR_SHARE = 0.1;

function modeBarHtml(label: string, share: number, turns: number, modifier: string): string {
	const pct = Math.round(share * 100);
	return `<div class="agentic-mode-row">
		<span class="agentic-mode-label">${escapeHtml(label)}</span>
		<span class="agentic-mode-bar"><span class="agentic-mode-fill ${modifier}" style="width:${pct}%;"></span></span>
		<span class="agentic-mode-value">${formatPercent(share * 100, 0)} · ${formatNumber(turns)}</span>
	</div>`;
}

/** True when a lot is handed to agents but little of the work is checked. */
export function isDelegationWithoutAssessment(totals: AgentActivityTotals): boolean {
	const turns = totals.modes.director + totals.modes.performer + totals.modes.assessor;
	if (turns < MIN_MODE_TURNS || totals.sessions === 0) { return false; }
	const delegationShare = totals.delegationSessions / totals.sessions;
	return delegationShare >= HIGH_DELEGATION_SHARE && modeShares(totals.modes).assessor < LOW_ASSESSOR_SHARE;
}

/** Director / Performer / Assessor card for the Insights tab. Empty string until there is enough data. */
export function buildParticipationModesCardHtml(report: RepoAgentActivityReport | null | undefined): string {
	if (!report) { return ''; }
	const totals = report.totals;
	const turns = totals.modes.director + totals.modes.performer + totals.modes.assessor;
	if (turns < MIN_MODE_TURNS) { return ''; }
	const shares = modeShares(totals.modes);
	const delegationShare = totals.sessions > 0 ? totals.delegationSessions / totals.sessions : 0;
	const callout = isDelegationWithoutAssessment(totals)
		? `<div class="agentic-note agentic-note-strong">${escapeHtml(localizeFormat(
			'agentic.modes.lowAssessor', Math.round(delegationShare * 100), Math.round(shares.assessor * 100),
		))}</div>`
		: '';
	return `<div class="section" id="participation-modes-card">
		<div class="section-title"><span class="codicon codicon-organization"></span><span>${escapeHtml(localize('agentic.modes.title'))}</span></div>
		<div class="section-subtitle">${escapeHtml(localizeFormat('agentic.modes.subtitle', report.windowDays, formatNumber(turns)))}</div>
		<div class="agentic-modes">
			${modeBarHtml(localize('agentic.modes.director'), shares.director, totals.modes.director, 'agentic-mode-director')}
			${modeBarHtml(localize('agentic.modes.performer'), shares.performer, totals.modes.performer, 'agentic-mode-performer')}
			${modeBarHtml(localize('agentic.modes.assessor'), shares.assessor, totals.modes.assessor, 'agentic-mode-assessor')}
		</div>
		<div class="agentic-muted" style="margin-top:6px;">${escapeHtml(localizeFormat('agentic.modes.delegation', formatPercent(delegationShare * 100, 0)))}</div>
		${callout}
		<details class="agentic-definition"><summary>${escapeHtml(localize('agentic.modes.howTitle'))}</summary>
			<div>${escapeHtml(localize('agentic.modes.how'))}</div>
		</details>
	</div>`;
}

// ---------------------------------------------------------------------------
// Repository PRs tab: what happened after merge
// ---------------------------------------------------------------------------

export type PrOutcomeView = {
	aiMergedPrs?: number;
	aiRevertedPrs?: number;
	otherMergedPrs?: number;
	otherRevertedPrs?: number;
};

/** Keep only coherent counts (reverted never above merged); older snapshots simply lack them. */
export function sanitizePrOutcomeCounts(raw: Record<string, unknown>): PrOutcomeView {
	const pair = (merged: unknown, reverted: unknown): [number, number] | null => {
		const m = count(merged);
		const r = count(reverted);
		return m !== null && r !== null && r <= m ? [m, r] : null;
	};
	const ai = pair(raw.aiMergedPrs, raw.aiRevertedPrs);
	const other = pair(raw.otherMergedPrs, raw.otherRevertedPrs);
	return {
		...(ai ? { aiMergedPrs: ai[0], aiRevertedPrs: ai[1] } : {}),
		...(other ? { otherMergedPrs: other[0], otherRevertedPrs: other[1] } : {}),
	};
}

function revertRate(reverted: number, merged: number): string {
	return merged > 0 ? formatPercent((reverted / merged) * 100, 0) : DASH;
}

/** "reverted / merged" for cloud-agent PRs, with everyone else's rate as the baseline. */
export function buildRevertCellHtml(r: PrOutcomeView): string {
	if (r.aiMergedPrs === undefined && r.otherMergedPrs === undefined) { return DASH; }
	const agent = r.aiMergedPrs === undefined
		? DASH
		: `${formatNumber(r.aiRevertedPrs ?? 0)} / ${formatNumber(r.aiMergedPrs)}`;
	const flag = (r.aiRevertedPrs ?? 0) > 0 ? ' style="font-weight:600; color:var(--warning-fg);"' : '';
	const baseline = r.otherMergedPrs === undefined
		? ''
		: `<div class="agentic-muted">${escapeHtml(localizeFormat('agentic.reverts.baseline', revertRate(r.otherRevertedPrs ?? 0, r.otherMergedPrs)))}</div>`;
	return `<span${flag}>${agent}</span>${baseline}`;
}
