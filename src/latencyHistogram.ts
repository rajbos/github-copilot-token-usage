/**
 * Additive, log-spaced latency histogram.
 *
 * Bucket `i` counts durations in `[2^i, 2^(i+1))` milliseconds; bucket 0 also
 * absorbs sub-millisecond and zero durations, and the last bucket is an overflow
 * bucket for anything at or above `2^(LATENCY_BUCKET_COUNT-1)` ms (~70 minutes).
 *
 * Only counts and a sum are stored, so histograms from any number of sessions can
 * be merged by plain addition — which is what `mergeUsageAnalysis`, the session
 * cache and the backend rollups (`mergeJsonMetrics`) all assume. Percentiles are
 * derived at read time and are accurate to within a bucket (a factor of two),
 * which is sufficient for a log-scale latency chart.
 */
import type { LatencyHistogram } from './types';

/** Number of buckets: 2^0 ms … 2^22 ms (≈ 70 min), the last one being overflow. */
export const LATENCY_BUCKET_COUNT = 23;

export function createLatencyHistogram(): LatencyHistogram {
	return { count: 0, sumMs: 0, buckets: new Array<number>(LATENCY_BUCKET_COUNT).fill(0) };
}

/** Map a duration to its bucket index. Negative, NaN and non-finite values map to bucket 0. */
export function latencyBucketIndex(durationMs: number): number {
	if (!Number.isFinite(durationMs) || durationMs < 1) { return 0; }
	return Math.min(LATENCY_BUCKET_COUNT - 1, Math.floor(Math.log2(durationMs)));
}

/** Record one observed duration. Non-finite or negative durations are ignored. */
export function recordLatencyMs(histogram: LatencyHistogram, durationMs: number): void {
	if (!Number.isFinite(durationMs) || durationMs < 0) { return; }
	histogram.count++;
	histogram.sumMs += durationMs;
	histogram.buckets[latencyBucketIndex(durationMs)]++;
}

/** Add `from` into `into`. Tolerates bucket arrays of differing (older/newer) length. */
export function mergeLatencyHistogram(into: LatencyHistogram, from: LatencyHistogram): void {
	into.count += from.count;
	into.sumMs += from.sumMs;
	for (let i = 0; i < from.buckets.length; i++) {
		if (i >= into.buckets.length) { into.buckets.push(0); }
		into.buckets[i] += from.buckets[i];
	}
}

/**
 * Estimate the p-th percentile (0..1) in milliseconds by log-interpolating within
 * the bucket that contains the target rank. Returns `null` for an empty histogram.
 */
export function latencyPercentileMs(histogram: LatencyHistogram, p: number): number | null {
	if (histogram.count <= 0) { return null; }
	const clamped = Math.min(1, Math.max(0, p));
	const target = clamped * histogram.count;
	let cumulative = 0;
	for (let i = 0; i < histogram.buckets.length; i++) {
		const inBucket = histogram.buckets[i];
		if (inBucket <= 0) { continue; }
		if (cumulative + inBucket >= target) {
			const lo = 2 ** i;
			const hi = 2 ** (i + 1);
			const fraction = inBucket > 0 ? Math.min(1, Math.max(0, (target - cumulative) / inBucket)) : 0;
			return lo * (hi / lo) ** fraction;
		}
		cumulative += inBucket;
	}
	// Only reachable when buckets and count disagree (corrupt entry); fall back to the mean.
	return latencyMeanMs(histogram);
}

/** Arithmetic mean in milliseconds, or `null` for an empty histogram. */
export function latencyMeanMs(histogram: LatencyHistogram): number | null {
	return histogram.count > 0 ? histogram.sumMs / histogram.count : null;
}
