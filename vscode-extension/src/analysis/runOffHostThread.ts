/**
 * The host's "worker first, in-process only if the worker is unusable" decision, as a pure function so
 * the rule can be tested without constructing the extension.
 *
 * Only an `unavailable` failure falls back. A `timeout`, or an error thrown by the analysis itself, is a
 * fact about the *file*: re-running it on the host would just move the hang or crash onto the one thread
 * that must stay responsive. Those are rethrown as they are; `AnalysisWorkerError.code` carries the Node error
 * code (`ENOENT`, ...) across the thread boundary, so callers that branch on `error.code` keep working.
 */
import { AnalysisWorkerError, type AnalysisWorkerPool } from './analysisWorkerPool';

export interface OffHostThreadContext {
	/** The pool, or undefined when the worker is disabled or its bundle is missing. */
	pool: AnalysisWorkerPool | undefined;
	/** True once the extension is shutting down; no in-process fallback is started then. */
	isDisposed: () => boolean;
	warn: (message: string) => void;
}

export async function runOffHostThread<T>(
	context: OffHostThreadContext,
	viaWorker: (pool: AnalysisWorkerPool) => Promise<T>,
	inProcess: () => Promise<T>,
): Promise<T> {
	const { pool } = context;
	if (pool) {
		// Even a disabled pool is asked: it rejects a file that earlier hung or killed a worker as `failed`, which
		// must not become an in-process parse just because the pool has since given up.
		try {
			return await viaWorker(pool);
		} catch (error) {
			if (context.isDisposed() || !(error instanceof AnalysisWorkerError) || error.kind !== 'unavailable') {
				throw error;
			}
			// A pool that is permanently disabled has said so once; do not repeat it for every file.
			if (pool.isAvailable()) { context.warn(`Analysis worker unavailable (${error.message}); analyzing in-process.`); }
		}
	}
	// Disposed with no usable worker (the pool is cleared on dispose): shutting down, so no full parse here.
	if (context.isDisposed()) {
		throw new AnalysisWorkerError('Extension disposed before the analysis could run', 'unavailable');
	}
	return inProcess();
}
