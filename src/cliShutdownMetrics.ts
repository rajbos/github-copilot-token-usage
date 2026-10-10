/**
 * Folding of Copilot CLI `session.shutdown` `data.modelMetrics` blocks into one
 * per-session, per-model total.
 *
 * Copilot CLI writes a `session.shutdown` event every time a run ends, so a
 * resumed session carries several of them. Their `modelMetrics` have had two
 * shapes over time (verified against local ~/.copilot/session-state logs):
 *
 * - **Cumulative** (CLI ~1.0.67+, July 2026 onwards): each shutdown repeats the
 *   whole session's totals; values only grow, every earlier model is listed
 *   again, and a resume with no new work repeats the previous shutdown verbatim.
 * - **Per-segment** (older CLIs): each shutdown covers only the run since the
 *   last resume; a run with no work writes `{}`.
 *
 * Summing shutdowns is right for the old shape and double counts the new one,
 * so each shutdown is compared with the previous one: when every model from the
 * previous shutdown is still present with no counter lower, it is a cumulative
 * snapshot that replaces the previous one; otherwise the previous snapshot is
 * closed off as a finished segment and the new one starts the next.
 */
import type { ModelUsage } from './types';
import { isUnsafeObjectKey } from './utils/protoGuard';

/** One `modelMetrics[model]` entry as written by Copilot CLI. */
export interface CliShutdownModelMetricsEntry {
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
}

/** Running state for folding a session's shutdown events in file order. */
export interface CliShutdownAccumulator {
	/** Totals of segments that a later non-cumulative shutdown closed off. */
	committed: ModelUsage;
	/** The most recent shutdown's snapshot (not yet included in `committed`). */
	last: ModelUsage | null;
}

export function createCliShutdownAccumulator(): CliShutdownAccumulator {
	return { committed: {}, last: null };
}

function num(v: unknown): number {
	return typeof v === 'number' ? v : 0;
}

/** Normalise a raw `modelMetrics` block into a ModelUsage snapshot (entries without `usage` are skipped). */
function toSnapshot(modelMetrics: Record<string, CliShutdownModelMetricsEntry>): ModelUsage {
	const snap: ModelUsage = {};
	for (const [modelName, metrics] of Object.entries(modelMetrics)) {
		// Untrusted key from JSON.parse, which can create an own "__proto__" property — see protoGuard.ts.
		if (isUnsafeObjectKey(modelName)) { continue; }
		const usage = metrics?.usage;
		if (!usage) { continue; }
		const entry: ModelUsage[string] = { inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), sessions: 0 };
		const cacheRead = num(usage.cacheReadTokens);
		const cacheWrite = num(usage.cacheWriteTokens);
		if (cacheRead > 0) { entry.cachedReadTokens = cacheRead; }
		if (cacheWrite > 0) { entry.cacheCreationTokens = cacheWrite; }
		snap[modelName] = entry;
	}
	return snap;
}

/** True when `cur` extends `prev`: every model of `prev` is present and no counter went down. */
function isCumulativeOf(prev: ModelUsage, cur: ModelUsage): boolean {
	for (const [model, p] of Object.entries(prev)) {
		// Own-property check: a model id such as "toString" must not resolve to an inherited member.
		if (!Object.hasOwn(cur, model)) { return false; }
		const c = cur[model];
		if (c.inputTokens < p.inputTokens || c.outputTokens < p.outputTokens) { return false; }
		if ((c.cachedReadTokens ?? 0) < (p.cachedReadTokens ?? 0)) { return false; }
		if ((c.cacheCreationTokens ?? 0) < (p.cacheCreationTokens ?? 0)) { return false; }
	}
	return true;
}

function sumInputOutput(usage: ModelUsage): number {
	let total = 0;
	for (const u of Object.values(usage)) { total += u.inputTokens + u.outputTokens; }
	return total;
}

function addInto(dest: ModelUsage, src: ModelUsage): void {
	for (const [model, u] of Object.entries(src)) {
		if (!Object.hasOwn(dest, model)) { dest[model] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
		const d = dest[model];
		d.inputTokens += u.inputTokens;
		d.outputTokens += u.outputTokens;
		if (u.cachedReadTokens) { d.cachedReadTokens = (d.cachedReadTokens ?? 0) + u.cachedReadTokens; }
		if (u.cacheCreationTokens) { d.cacheCreationTokens = (d.cacheCreationTokens ?? 0) + u.cacheCreationTokens; }
	}
}

/**
 * Fold one shutdown's `modelMetrics` into the accumulator.
 * Returns the input+output tokens this shutdown adds to the session total — the
 * delta to attribute to the shutdown's day (0 for a repeated identical shutdown).
 */
export function applyCliShutdownMetrics(acc: CliShutdownAccumulator, modelMetrics: Record<string, CliShutdownModelMetricsEntry>): number {
	const snap = toSnapshot(modelMetrics);
	const prev = acc.last;
	acc.last = snap;
	if (prev && isCumulativeOf(prev, snap)) {
		return sumInputOutput(snap) - sumInputOutput(prev);
	}
	if (prev) { addInto(acc.committed, prev); }
	return sumInputOutput(snap);
}

/** The session's per-model totals: closed segments plus the latest snapshot. */
export function getCliShutdownTotals(acc: CliShutdownAccumulator): ModelUsage {
	const totals: ModelUsage = {};
	addInto(totals, acc.committed);
	if (acc.last) { addInto(totals, acc.last); }
	return totals;
}
