'use strict';

/**
 * A small bounded-concurrency runner for the render and interaction loops.
 *
 * Most of a render is waiting — a fixed settle sleep, a font load, a resize
 * redraw — so running a handful of pages at once overlaps those waits almost
 * entirely. Results come back in input order, never completion order, so file
 * names, reports and log summaries stay deterministic whatever the timing.
 */

/** The default number of pages open at once. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Reads a `--concurrency` value. A missing value takes `fallback`; anything
 * that is not a positive integer is an error rather than a silent serial run.
 */
function parseConcurrency(value, fallback = DEFAULT_CONCURRENCY) {
	if (value === undefined) { return fallback; }
	// A bare `--concurrency` parses as `true`, which Number() would read as 1.
	const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`--concurrency must be a positive integer, got '${value}'.`);
	}
	return n;
}

/**
 * Runs `worker(item, index)` over `items` with at most `concurrency` in
 * flight, and resolves to the results in input order.
 *
 * On the first rejection no further items are started, the ones already in
 * flight are allowed to finish (so a caller's `finally { browser.close() }`
 * does not pull the browser out from under them), and then the first error is
 * rethrown.
 */
async function runPool(items, concurrency, worker) {
	const results = new Array(items.length);
	let next = 0;
	let failure = null;
	const lane = async () => {
		while (failure === null && next < items.length) {
			const index = next++;
			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				if (failure === null) { failure = { error }; }
			}
		}
	};
	const lanes = Math.max(1, Math.min(concurrency, items.length));
	await Promise.all(Array.from({ length: lanes }, lane));
	if (failure !== null) { throw failure.error; }
	return results;
}

module.exports = { DEFAULT_CONCURRENCY, parseConcurrency, runPool };
