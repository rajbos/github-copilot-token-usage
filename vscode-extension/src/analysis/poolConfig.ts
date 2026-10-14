/**
 * Pure decisions behind how (and whether) the analysis worker pool is created, kept free of
 * `vscode` and the filesystem so they can be unit tested. See docs/adr/ANALYSIS-WORKER.md.
 */

/**
 * Leave a core for the host and the renderer. Capped at two: every worker keeps its own in-memory copy of
 * the SQLite stores it reads (Copilot's session-store.db and data.db are 100+ MB each on a long-lived
 * machine), so a third thread buys little speed for a lot of memory. Always at least one worker.
 */
export function computeAnalysisPoolSize(cores: number): number {
	const count = Number.isFinite(cores) ? cores : 0;
	return Math.max(1, Math.min(2, count - 1));
}

export type AnalysisPoolDecision =
	| { use: true }
	| { use: false; reason: 'disabled' | 'missing-bundle' };

/** Whether to run analysis on workers at all, or fall back to the in-process path. */
export function decideAnalysisPool(input: { disableEnv: string | undefined; bundleExists: boolean }): AnalysisPoolDecision {
	if (input.disableEnv === '1') { return { use: false, reason: 'disabled' }; }
	if (!input.bundleExists) { return { use: false, reason: 'missing-bundle' }; }
	return { use: true };
}
