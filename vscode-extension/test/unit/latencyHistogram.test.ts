import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    LATENCY_BUCKET_COUNT,
    createLatencyHistogram,
    latencyBucketIndex,
    latencyMeanMs,
    latencyPercentileMs,
    mergeLatencyHistogram,
    recordLatencyMs,
} from '../../../src/latencyHistogram';

test('latencyBucketIndex: log2 buckets with zero/negative/non-finite in bucket 0 and overflow capped', () => {
    assert.equal(latencyBucketIndex(0), 0);
    assert.equal(latencyBucketIndex(-5), 0);
    assert.equal(latencyBucketIndex(NaN), 0);
    assert.equal(latencyBucketIndex(Infinity), 0);
    assert.equal(latencyBucketIndex(1), 0);
    assert.equal(latencyBucketIndex(1.99), 0);
    assert.equal(latencyBucketIndex(2), 1);
    assert.equal(latencyBucketIndex(1000), 9);      // 512..1023
    assert.equal(latencyBucketIndex(1024), 10);
    assert.equal(latencyBucketIndex(2 ** 40), LATENCY_BUCKET_COUNT - 1);
});

test('recordLatencyMs: counts, sums and ignores invalid durations', () => {
    const h = createLatencyHistogram();
    assert.equal(h.buckets.length, LATENCY_BUCKET_COUNT);
    recordLatencyMs(h, 40);
    recordLatencyMs(h, 3000);
    recordLatencyMs(h, 0);
    recordLatencyMs(h, -1);
    recordLatencyMs(h, NaN);
    assert.equal(h.count, 3);
    assert.equal(h.sumMs, 3040);
    assert.equal(h.buckets[0], 1);   // 0 ms
    assert.equal(h.buckets[5], 1);   // 32..63
    assert.equal(h.buckets[11], 1);  // 2048..4095
    assert.equal(latencyMeanMs(h), 3040 / 3);
});

test('latencyPercentileMs: empty histogram is null; percentiles land in the right bucket and interpolate on a log scale', () => {
    assert.equal(latencyPercentileMs(createLatencyHistogram(), 0.5), null);
    assert.equal(latencyMeanMs(createLatencyHistogram()), null);

    const h = createLatencyHistogram();
    for (let i = 0; i < 90; i++) { recordLatencyMs(h, 40); }     // bucket 5: [32, 64)
    for (let i = 0; i < 10; i++) { recordLatencyMs(h, 100_000); } // bucket 16: [65536, 131072)

    const p50 = latencyPercentileMs(h, 0.5)!;
    assert.ok(p50 >= 32 && p50 < 64, `p50 ${p50} should fall in the 32..64 bucket`);
    const p95 = latencyPercentileMs(h, 0.95)!;
    assert.ok(p95 >= 65_536 && p95 < 131_072, `p95 ${p95} should fall in the 64k..128k bucket`);
    // Within a bucket the estimate rises monotonically with p.
    assert.ok(latencyPercentileMs(h, 0.1)! < latencyPercentileMs(h, 0.8)!);
    // Clamped p outside [0, 1] does not throw and stays in range.
    assert.ok(latencyPercentileMs(h, 2)! >= 65_536);
    assert.ok(latencyPercentileMs(h, -1)! >= 32);
});

test('mergeLatencyHistogram: purely additive and tolerant of shorter bucket arrays from older cache entries', () => {
    const a = createLatencyHistogram();
    const b = createLatencyHistogram();
    recordLatencyMs(a, 10);
    recordLatencyMs(b, 10);
    recordLatencyMs(b, 5000);
    mergeLatencyHistogram(a, b);
    assert.equal(a.count, 3);
    assert.equal(a.sumMs, 5020);
    assert.equal(a.buckets[3], 2);
    assert.equal(a.buckets[12], 1);

    const legacy = { count: 1, sumMs: 2, buckets: [0, 1] };
    const into = createLatencyHistogram();
    mergeLatencyHistogram(into, legacy);
    assert.equal(into.count, 1);
    assert.equal(into.buckets[1], 1);
    assert.equal(into.buckets.length, LATENCY_BUCKET_COUNT);

    const longer = { count: 1, sumMs: 1, buckets: new Array(LATENCY_BUCKET_COUNT + 2).fill(0) };
    longer.buckets[LATENCY_BUCKET_COUNT + 1] = 1;
    const short = { count: 0, sumMs: 0, buckets: [] as number[] };
    mergeLatencyHistogram(short, longer);
    assert.equal(short.buckets.length, LATENCY_BUCKET_COUNT + 2);
    assert.equal(short.buckets[LATENCY_BUCKET_COUNT + 1], 1);
});
