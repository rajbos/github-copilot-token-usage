import test from 'node:test';
import * as assert from 'node:assert/strict';
import { sanitizeMcpOutcomeMaps, sanitizeToolOutcomeMaps } from '../../src/webview/usage/toolOutcomeSanitizer';

test('sanitizeToolOutcomeMaps: keeps well-formed outcome maps a live updateStats refresh delivers', () => {
    const raw = {
        total: 3,
        byTool: { view: 3 },
        outputTokensByTool: { view: 1200 },
        completedByTool: { view: 3 },
        failuresByTool: { view: 1 },
        latencyByTool: { view: { count: 3, sumMs: 120, buckets: [0, 0, 0, 0, 0, 3] } },
    };
    const out = sanitizeToolOutcomeMaps(raw);
    assert.deepEqual(out.outputTokensByTool, { view: 1200 });
    assert.deepEqual(out.completedByTool, { view: 3 });
    assert.deepEqual(out.failuresByTool, { view: 1 });
    assert.deepEqual(out.latencyByTool, { view: { count: 3, sumMs: 120, buckets: [0, 0, 0, 0, 0, 3] } });
    assert.notEqual(out.latencyByTool!.view.buckets, raw.latencyByTool.view.buckets, 'buckets are copied, not aliased');
});

test('sanitizeToolOutcomeMaps: absent maps stay absent (no present-but-undefined keys)', () => {
    const out = sanitizeToolOutcomeMaps({ total: 0, byTool: {} });
    assert.deepEqual(Object.keys(out), []);
    assert.equal('completedByTool' in out, false);
});

test('sanitizeToolOutcomeMaps: drops malformed entries instead of letting them reach the renderer', () => {
    const out = sanitizeToolOutcomeMaps({
        completedByTool: { ok: 2, nan: Number.NaN, str: '3', inf: Infinity, negative: -1 },
        failuresByTool: 'nope',
        latencyByTool: {
            good: { count: 1, sumMs: 5, buckets: [0, 0, 1] },
            noSum: { count: 1, buckets: [1] },
            badBuckets: { count: 1, sumMs: 1, buckets: [1, 'x'] },
            notArray: { count: 1, sumMs: 1, buckets: 'x' },
            missingCount: { sumMs: 1, buckets: [1] },
            negativeCount: { count: -1, sumMs: 1, buckets: [1] },
            negativeBucket: { count: 1, sumMs: 1, buckets: [1, -1] },
        },
    });
    assert.deepEqual(out.completedByTool, { ok: 2 }, 'NaN, string, Infinity and negative counts are dropped');
    assert.equal(out.failuresByTool, undefined);
    assert.deepEqual(Object.keys(out.latencyByTool!), ['good', 'noSum']);
    assert.deepEqual(out.latencyByTool!.noSum, { count: 1, sumMs: 0, buckets: [1] });
});

test('sanitizeMcpOutcomeMaps: per-server maps round-trip the same way', () => {
    const out = sanitizeMcpOutcomeMaps({
        completedByServer: { github: 9 },
        failuresByServer: { github: 2 },
        latencyByServer: { github: { count: 9, sumMs: 900, buckets: [0, 0, 0, 0, 0, 0, 0, 9] } },
    });
    assert.deepEqual(out.completedByServer, { github: 9 });
    assert.deepEqual(out.failuresByServer, { github: 2 });
    assert.equal(out.latencyByServer!.github.count, 9);
    assert.deepEqual(Object.keys(sanitizeMcpOutcomeMaps({})), []);
});
