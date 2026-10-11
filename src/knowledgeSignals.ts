/**
 * Rework as a shared-knowledge signal, per repository.
 *
 * GitHub's Agentic Engineering System reads token use, retries and tool-call
 * churn on straightforward tasks as a symptom of weak shared knowledge rather
 * than of a weak model: "fast, confident mistakes". This module turns the
 * per-repository activity (src/repoAgentActivity.ts) into rework rates and
 * compares repositories that carry agent instruction files with those that
 * do not.
 *
 * The comparison is a correlation in the user's own data, not a causal claim,
 * and is only reported when both groups are large enough to be worth reading.
 * Pure — no VS Code API, no filesystem.
 */
import type { AgentActivityTotals, CustomizationFileEntry, RepoAgentActivity, RepoKnowledgeFiles } from './types';

/** A repository needs this many turn-detail sessions before its rates are compared. Tunable. */
export const MIN_REPO_TURN_DETAIL_SESSIONS = 5;
/** Each cohort needs this many qualifying repositories… Tunable. */
export const MIN_COHORT_REPOS = 3;
/** …and this many turn-detail sessions between them. Tunable. */
export const MIN_COHORT_SESSIONS = 20;

/** Instruction file basenames recognised regardless of the pattern type that found them. */
const INSTRUCTION_BASENAMES: ReadonlySet<string> = new Set(['agents.md', 'claude.md', 'gemini.md', 'codex.md']);
const INSTRUCTION_TYPES: ReadonlySet<string> = new Set(['instructions', 'non-copilot-instructions']);

export interface ReworkRates {
	/** All correction moments per turn-detail session. */
	correctionsPerSession: number | null;
	/** Share of turn-detail sessions with at least one correction moment. */
	correctedSessionShare: number | null;
	/** Edit turns that landed without a retry or self-correction. */
	oneShotRate: number | null;
	retriesPerEditTurn: number | null;
	toolErrorsPerSession: number | null;
	/** Tool calls per edit turn — "tool-call churn". */
	toolCallsPerEditTurn: number | null;
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator > 0 ? numerator / denominator : null;
}

/** Rework rates over a set of sessions; null where the denominator is zero. */
export function computeReworkRates(t: AgentActivityTotals): ReworkRates {
	return {
		correctionsPerSession: ratio(t.correctionMoments, t.sessionsWithTurnDetail),
		correctedSessionShare: ratio(t.sessionsWithCorrections, t.sessionsWithTurnDetail),
		oneShotRate: ratio(t.oneShotEditTurns, t.editTurns),
		retriesPerEditTurn: ratio(t.retries, t.editTurns),
		toolErrorsPerSession: ratio(t.toolErrors, t.sessionsWithTurnDetail),
		toolCallsPerEditTurn: ratio(t.toolCalls, t.editTurns),
	};
}

/** True when a customization file is an agent instruction file. */
export function isInstructionFile(file: Pick<CustomizationFileEntry, 'type' | 'relativePath'>): boolean {
	if (INSTRUCTION_TYPES.has(file.type)) { return true; }
	const base = file.relativePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
	return INSTRUCTION_BASENAMES.has(base);
}

/** Count instruction files (and stale ones) in a checkout's customization scan. */
export function summarizeInstructionFiles(files: readonly Pick<CustomizationFileEntry, 'type' | 'relativePath' | 'isStale'>[]): RepoKnowledgeFiles {
	const instructions = files.filter(isInstructionFile);
	return {
		instructionFiles: instructions.length,
		staleInstructionFiles: instructions.filter(f => f.isStale).length,
	};
}

/** Combine two scans of the same repository (e.g. two checkouts): the richer one wins. */
export function mergeKnowledgeFiles(a: RepoKnowledgeFiles | undefined, b: RepoKnowledgeFiles): RepoKnowledgeFiles {
	if (!a || b.instructionFiles > a.instructionFiles) { return b; }
	return a;
}

/** Median of a list, or null when empty. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) { return null; }
	const sorted = [...values].sort((x, y) => x - y);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface CohortStats {
	repos: number;
	sessions: number;
	medianCorrectionsPerSession: number | null;
	medianOneShotRate: number | null;
}

export interface InstructionCohortComparison {
	withInstructions: CohortStats;
	withoutInstructions: CohortStats;
	/** Both cohorts meet the minimum repository and session counts. */
	qualifies: boolean;
	/**
	 * How much lower the median corrections-per-session is in repositories with
	 * instruction files, in percent. Negative when it is higher. Null unless the
	 * comparison qualifies and the without-instructions median is above zero.
	 */
	correctionsReductionPct: number | null;
}

function cohortStats(rows: readonly RepoAgentActivity[]): CohortStats {
	const corrections: number[] = [];
	const oneShot: number[] = [];
	let sessions = 0;
	for (const row of rows) {
		const rates = computeReworkRates(row);
		sessions += row.sessionsWithTurnDetail;
		if (rates.correctionsPerSession !== null) { corrections.push(rates.correctionsPerSession); }
		if (rates.oneShotRate !== null) { oneShot.push(rates.oneShotRate); }
	}
	return {
		repos: rows.length,
		sessions,
		medianCorrectionsPerSession: median(corrections),
		medianOneShotRate: median(oneShot),
	};
}

/**
 * Compare repositories with agent instruction files against those without.
 * Only repositories with a scanned checkout (`knowledge` present) and at least
 * {@link MIN_REPO_TURN_DETAIL_SESSIONS} turn-detail sessions take part.
 */
export function compareInstructionCohorts(rows: readonly RepoAgentActivity[]): InstructionCohortComparison {
	const eligible = rows.filter(r => r.knowledge && r.sessionsWithTurnDetail >= MIN_REPO_TURN_DETAIL_SESSIONS);
	const withInstructions = cohortStats(eligible.filter(r => r.knowledge!.instructionFiles > 0));
	const withoutInstructions = cohortStats(eligible.filter(r => r.knowledge!.instructionFiles === 0));
	const qualifies = [withInstructions, withoutInstructions]
		.every(c => c.repos >= MIN_COHORT_REPOS && c.sessions >= MIN_COHORT_SESSIONS);
	const withMedian = withInstructions.medianCorrectionsPerSession;
	const withoutMedian = withoutInstructions.medianCorrectionsPerSession;
	const correctionsReductionPct = qualifies && withMedian !== null && withoutMedian !== null && withoutMedian > 0
		? ((withoutMedian - withMedian) / withoutMedian) * 100
		: null;
	return { withInstructions, withoutInstructions, qualifies, correctionsReductionPct };
}
