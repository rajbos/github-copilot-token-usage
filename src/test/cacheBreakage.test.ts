import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    detectCacheBreakage,
    mergeCacheBreakCounts,
    createEmptyCacheBreakCounts,
    MIN_PREFIX_TOKENS,
    MIN_RETAINED_PREFIX_RATIO,
    DEFAULT_CACHE_TTL_MS,
    EXTENDED_CACHE_TTL_MS,
    MAX_BREAKS_PER_SESSION,
    createEmptyCacheBreakagePeriodStats,
    mergeCacheBreakageIntoPeriod,
    periodRewriteFactor,
    totalCacheBreaks,
    totalTokensRewritten,
    type CacheTurn,
} from '../cacheBreakage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function turn(overrides: Partial<CacheTurn> & { timestamp: number }): CacheTurn {
    return {
        model: 'claude-sonnet-5',
        inputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ...overrides,
    };
}

/**
 * A healthy sequence: a big prefix is written once, then read back on every
 * subsequent turn with small increments appended. This is what the detector
 * must stay silent on.
 */
function healthySession(turns = 5, base = 60_000): CacheTurn[] {
    const out: CacheTurn[] = [turn({ timestamp: T0, cacheCreationTokens: base })];
    let read = base;
    for (let i = 1; i < turns; i++) {
        out.push(turn({ timestamp: T0 + i * 10_000, cacheReadTokens: read, cacheCreationTokens: 500 }));
        read += 500;
    }
    return out;
}

// ---------------------------------------------------------------------------
// No false positives
// ---------------------------------------------------------------------------

test('healthy session reports no breaks and a rewriteFactor near 1', () => {
    const result = detectCacheBreakage(healthySession(8));
    assert.equal(result.breaks.length, 0);
    assert.ok(result.rewriteFactor < 1.1, `expected ~1.0, got ${result.rewriteFactor}`);
});

test('breakpoint shuffle is not a break: a partial read drop above the ratio is ignored', () => {
    // Real logs show read/write split moving turn-to-turn with nothing actually
    // invalidated — a ~35% dip at a sub-second gap. Must not be reported.
    const turns = [
        turn({ timestamp: T0, cacheReadTokens: 90_000, cacheCreationTokens: 10_000 }),
        turn({ timestamp: T0 + 500, cacheReadTokens: 65_000, cacheCreationTokens: 35_000 }),
    ];
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks.length, 0);
});

test('warm-up below MIN_PREFIX_TOKENS is never flagged', () => {
    const small = Math.floor(MIN_PREFIX_TOKENS / 2);
    const turns = [
        turn({ timestamp: T0, cacheCreationTokens: small }),
        // Total prefix loss, but the prefix was too small to care about.
        turn({ timestamp: T0 + EXTENDED_CACHE_TTL_MS * 2, cacheCreationTokens: small }),
    ];
    assert.equal(detectCacheBreakage(turns).breaks.length, 0);
});

test('a single turn, or none, produces an empty result without dividing by zero', () => {
    assert.equal(detectCacheBreakage([]).rewriteFactor, 0);
    assert.equal(detectCacheBreakage([]).breaks.length, 0);
    const one = detectCacheBreakage([turn({ timestamp: T0, cacheCreationTokens: 50_000 })]);
    assert.equal(one.breaks.length, 0);
    assert.equal(one.peakContextTokens, 50_002);
});

test('exactly at the retention ratio counts as intact, not as a break', () => {
    const prefix = 100_000;
    const turns = [
        turn({ timestamp: T0, cacheCreationTokens: prefix }),
        turn({ timestamp: T0 + 1000, cacheReadTokens: MIN_RETAINED_PREFIX_RATIO * (prefix + 2) }),
    ];
    assert.equal(detectCacheBreakage(turns).breaks.length, 0);
});

// ---------------------------------------------------------------------------
// Cause classification
// ---------------------------------------------------------------------------

test('ttl-expiry: idle beyond the 5-minute default TTL', () => {
    const turns = [
        turn({ timestamp: T0, cacheCreationTokens: 80_000 }),
        turn({ timestamp: T0 + DEFAULT_CACHE_TTL_MS + 1000, cacheReadTokens: 0, cacheCreationTokens: 80_000 }),
    ];
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks.length, 1);
    assert.equal(result.breaks[0].cause, 'ttl-expiry');
    assert.equal(result.breaks[0].tokensRewritten, 80_002);
    assert.equal(result.breaks[0].ttlMs, DEFAULT_CACHE_TTL_MS);
});

test('the 1-hour TTL is honoured when the turn wrote 1h cache entries', () => {
    // Same 10-minute gap, two different TTLs. Under the extended TTL the prefix
    // was still alive, so the loss must be attributed to the prefix changing —
    // not blamed on the user being idle.
    const gap = 10 * 60 * 1000;
    const base = { timestamp: T0, cacheCreationTokens: 80_000, cacheCreation1hTokens: 80_000 };
    const turns = [
        turn(base),
        turn({
            timestamp: T0 + gap,
            cacheReadTokens: 0,
            cacheCreationTokens: 80_000,
            cacheCreation1hTokens: 80_000,
        }),
    ];
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks[0].ttlMs, EXTENDED_CACHE_TTL_MS);
    assert.equal(result.breaks[0].cause, 'prefix-invalidated');

    // Without the 1h marker the identical gap is a genuine expiry.
    const shortTtl = detectCacheBreakage([
        turn({ timestamp: T0, cacheCreationTokens: 80_000 }),
        turn({ timestamp: T0 + gap, cacheReadTokens: 0, cacheCreationTokens: 80_000 }),
    ]);
    assert.equal(shortTtl.breaks[0].cause, 'ttl-expiry');
});

test('model-switch wins over an idle gap that would also explain the loss', () => {
    const turns = [
        turn({ timestamp: T0, model: 'claude-sonnet-5', cacheCreationTokens: 80_000 }),
        turn({
            timestamp: T0 + EXTENDED_CACHE_TTL_MS * 2,
            model: 'claude-opus-5',
            cacheReadTokens: 0,
            cacheCreationTokens: 80_000,
        }),
    ];
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks[0].cause, 'model-switch');
    assert.equal(result.breaks[0].previousModel, 'claude-sonnet-5');
    assert.equal(result.breaks[0].model, 'claude-opus-5');
});

test('compaction wins over an idle gap, and previousModel is omitted', () => {
    const turns = [
        turn({ timestamp: T0, cacheCreationTokens: 80_000 }),
        turn({
            timestamp: T0 + DEFAULT_CACHE_TTL_MS * 3,
            cacheReadTokens: 0,
            cacheCreationTokens: 40_000,
            compacted: true,
        }),
    ];
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks[0].cause, 'compaction');
    assert.equal(result.breaks[0].previousModel, undefined);
});

test('prefix-invalidated: prompt died immediately, no gap, same model', () => {
    const turns = [
        turn({ timestamp: T0, cacheReadTokens: 100_000, cacheCreationTokens: 2_000 }),
        turn({ timestamp: T0 + 800, cacheReadTokens: 0, cacheCreationTokens: 104_000 }),
    ];
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks[0].cause, 'prefix-invalidated');
    assert.equal(result.breaks[0].gapMs, 800);
});

// ---------------------------------------------------------------------------
// Aggregate reporting
// ---------------------------------------------------------------------------

test('rewriteFactor counts repeated writes of the same context', () => {
    // Three full re-writes of a ~100k context after TTL expiries.
    const turns: CacheTurn[] = [];
    for (let i = 0; i < 3; i++) {
        turns.push(turn({
            timestamp: T0 + i * (DEFAULT_CACHE_TTL_MS + 60_000),
            cacheReadTokens: 0,
            cacheCreationTokens: 100_000,
        }));
    }
    const result = detectCacheBreakage(turns);
    assert.equal(result.tokensWritten, 300_000);
    assert.equal(result.peakContextTokens, 100_002);
    assert.ok(result.rewriteFactor > 2.9 && result.rewriteFactor < 3.1);
    assert.equal(result.counts['ttl-expiry'].breaks, 2);
});

test('break detail is capped but counts stay complete', () => {
    const turns: CacheTurn[] = [];
    for (let i = 0; i < MAX_BREAKS_PER_SESSION + 10; i++) {
        turns.push(turn({
            timestamp: T0 + i * (DEFAULT_CACHE_TTL_MS + 60_000),
            cacheReadTokens: 0,
            cacheCreationTokens: 80_000,
        }));
    }
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks.length, MAX_BREAKS_PER_SESSION);
    assert.equal(result.counts['ttl-expiry'].breaks, MAX_BREAKS_PER_SESSION + 9);
});

test('a clock that goes backwards yields a zero gap, not a negative one', () => {
    const turns = [
        turn({ timestamp: T0, cacheCreationTokens: 80_000 }),
        turn({ timestamp: T0 - 5_000, cacheReadTokens: 0, cacheCreationTokens: 80_000 }),
    ];
    const result = detectCacheBreakage(turns);
    assert.equal(result.breaks[0].gapMs, 0);
    assert.equal(result.breaks[0].cause, 'prefix-invalidated');
});

test('period stats aggregate sessions and weight the factor by session size', () => {
    const stats = createEmptyCacheBreakagePeriodStats();
    // One healthy session and one that re-wrote its context three times.
    const healthy = detectCacheBreakage(healthySession(6, 100_000));
    const churny = detectCacheBreakage([0, 1, 2].map(i => turn({
        timestamp: T0 + i * (DEFAULT_CACHE_TTL_MS + 60_000),
        cacheReadTokens: 0,
        cacheCreationTokens: 300_000,
    })));
    mergeCacheBreakageIntoPeriod(stats, healthy);
    mergeCacheBreakageIntoPeriod(stats, churny);

    assert.equal(stats.sessionsAnalyzed, 2);
    assert.equal(stats.sessionsWithBreaks, 1);
    assert.equal(stats.counts['ttl-expiry'].breaks, 2);
    assert.ok(stats.worstRewriteFactor > 2.9, `worst should track the churny session, got ${stats.worstRewriteFactor}`);
    // Summing peaks rather than averaging factors keeps the big session dominant:
    // 102.5k + 900k written over 102.5k + 300k of peak context.
    const factor = periodRewriteFactor(stats);
    assert.ok(factor > 2.4 && factor < 2.6, `expected ~2.5, got ${factor}`);
});

test('periodRewriteFactor is 0 rather than NaN for an empty period', () => {
    assert.equal(periodRewriteFactor(createEmptyCacheBreakagePeriodStats()), 0);
});

test('totalCacheBreaks and totalTokensRewritten sum every cause', () => {
    const result = detectCacheBreakage([
        turn({ timestamp: T0, cacheCreationTokens: 80_000 }),
        // TTL expiry.
        turn({ timestamp: T0 + DEFAULT_CACHE_TTL_MS * 2, cacheReadTokens: 0, cacheCreationTokens: 80_000 }),
        // Model switch immediately after.
        turn({ timestamp: T0 + DEFAULT_CACHE_TTL_MS * 2 + 1000, model: 'claude-opus-5', cacheReadTokens: 0, cacheCreationTokens: 80_000 }),
    ]);
    assert.equal(totalCacheBreaks(result.counts), 2);
    assert.equal(totalTokensRewritten(result.counts), 160_004);
    assert.equal(
        totalTokensRewritten(result.counts),
        result.breaks.reduce((s, b) => s + b.tokensRewritten, 0),
    );
});

test('mergeCacheBreakCounts accumulates across sessions and tolerates undefined', () => {
    const total = createEmptyCacheBreakCounts();
    const a = detectCacheBreakage([
        turn({ timestamp: T0, cacheCreationTokens: 80_000 }),
        turn({ timestamp: T0 + DEFAULT_CACHE_TTL_MS * 2, cacheReadTokens: 0, cacheCreationTokens: 80_000 }),
    ]);
    mergeCacheBreakCounts(total, a.counts);
    mergeCacheBreakCounts(total, a.counts);
    mergeCacheBreakCounts(total, undefined);
    assert.equal(total['ttl-expiry'].breaks, 2);
    assert.equal(total['ttl-expiry'].tokensRewritten, 160_004);
    assert.equal(total['model-switch'].breaks, 0);
});
