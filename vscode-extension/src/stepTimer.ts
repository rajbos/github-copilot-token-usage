/**
 * Step timing for long multi-stage computations (e.g. the usage analysis post-loop steps), so a
 * log shows which stage a slow run spent its time in instead of one silent gap.
 */

/** Steps faster than this are not logged, to keep the output channel quiet on a healthy run. */
export const SLOW_STEP_LOG_THRESHOLD_MS = 250;

type StepLog = (message: string) => void;

function report(log: StepLog, label: string, startedAt: number): void {
	const ms = Date.now() - startedAt;
	if (ms >= SLOW_STEP_LOG_THRESHOLD_MS) { log(`⏱️ [Usage Analysis] ${label} took ${ms}ms`); }
}

/** Runs `fn`, logging its duration when it was slow. Re-throws what `fn` throws. */
export function timedStepSync<T>(log: StepLog, label: string, fn: () => T): T {
	const startedAt = Date.now();
	try { return fn(); } finally { report(log, label, startedAt); }
}

/** Awaits `fn()`, logging its duration when it was slow. Re-throws what `fn` rejects with. */
export async function timedStep<T>(log: StepLog, label: string, fn: () => Promise<T>): Promise<T> {
	const startedAt = Date.now();
	try { return await fn(); } finally { report(log, label, startedAt); }
}
