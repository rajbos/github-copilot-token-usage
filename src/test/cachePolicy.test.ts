import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	CliCachePolicy,
	VS_CODE_CACHE_EVICT_BATCH,
	VS_CODE_CACHE_MAX_ENTRIES,
	VS_CODE_CACHE_TRIGGER_THRESHOLD,
	VsCodeCachePolicy,
} from '../cachePolicy';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface TestEntry {
	mtime: number;
	size?: number;
}

function makeEntry(mtime: number, size?: number): TestEntry {
	return size !== undefined ? { mtime, size } : { mtime };
}

// ---------------------------------------------------------------------------
// VsCodeCachePolicy — isValid
// ---------------------------------------------------------------------------

test('VsCodeCachePolicy.isValid: returns true on exact mtime+size match', () => {
	const policy = new VsCodeCachePolicy(() => {});
	assert.equal(policy.isValid(makeEntry(100, 200), 100, 200), true);
});

test('VsCodeCachePolicy.isValid: returns false when mtime differs', () => {
	const policy = new VsCodeCachePolicy(() => {});
	assert.equal(policy.isValid(makeEntry(100, 200), 999, 200), false);
});

test('VsCodeCachePolicy.isValid: returns false when size differs', () => {
	const policy = new VsCodeCachePolicy(() => {});
	assert.equal(policy.isValid(makeEntry(100, 200), 100, 999), false);
});

test('VsCodeCachePolicy.isValid: returns false when size is missing (old format)', () => {
	const policy = new VsCodeCachePolicy(() => {});
	assert.equal(policy.isValid(makeEntry(100), 100, 200), false);
});

// ---------------------------------------------------------------------------
// VsCodeCachePolicy — evict
// ---------------------------------------------------------------------------

function makeVsCodeCache(count: number): Map<string, TestEntry> {
	const m = new Map<string, TestEntry>();
	for (let i = 0; i < count; i++) {
		m.set(`file${i}`, { mtime: i, size: i });
	}
	return m;
}

test('VsCodeCachePolicy.evict: no-op when size is at the threshold', () => {
	const logs: string[] = [];
	const policy = new VsCodeCachePolicy((m) => logs.push(m));
	const cache = makeVsCodeCache(VS_CODE_CACHE_TRIGGER_THRESHOLD);
	policy.evict(cache);
	assert.equal(cache.size, VS_CODE_CACHE_TRIGGER_THRESHOLD, 'Should not evict when at threshold');
	assert.equal(logs.length, 0, 'Should not log when no eviction');
});

test('VsCodeCachePolicy.evict: triggers when size exceeds threshold', () => {
	const logs: string[] = [];
	const policy = new VsCodeCachePolicy((m) => logs.push(m));
	const cache = makeVsCodeCache(VS_CODE_CACHE_TRIGGER_THRESHOLD + 1);
	policy.evict(cache);
	assert.equal(cache.size, VS_CODE_CACHE_MAX_ENTRIES, 'Should evict one batch back to the steady-state cap');
	assert.ok(logs.some(l => l.includes('removed 100 oldest entries')), 'Should log eviction');
});

test('VsCodeCachePolicy.evict: removes oldest by insertion order, not by mtime', () => {
	const logs: string[] = [];
	const policy = new VsCodeCachePolicy((m) => logs.push(m), VS_CODE_CACHE_TRIGGER_THRESHOLD, VS_CODE_CACHE_EVICT_BATCH);
	const cache = new Map<string, TestEntry>();
	// Insert threshold+1 entries, with the "oldest" by insertion having the highest mtime
	for (let i = VS_CODE_CACHE_TRIGGER_THRESHOLD; i >= 0; i--) {
		cache.set(`file${i}`, { mtime: i * 1000, size: i });
	}
	policy.evict(cache);
	// The first-inserted keys are file20099..file20000 (oldest by insertion order)
	assert.equal(cache.has(`file${VS_CODE_CACHE_TRIGGER_THRESHOLD}`), false, 'First inserted key should be evicted');
	assert.equal(cache.has(`file${VS_CODE_CACHE_MAX_ENTRIES}`), false, 'Insertion-oldest keys should be evicted');
	assert.equal(cache.has(`file${VS_CODE_CACHE_MAX_ENTRIES - 1}`), true, 'key inserted just after the eviction batch should survive');
	assert.equal(cache.has('file0'), true, 'Last-inserted key should survive');
});

test('VsCodeCachePolicy.evict: custom thresholds are respected', () => {
	const logs: string[] = [];
	const policy = new VsCodeCachePolicy((m) => logs.push(m), 10, 3);
	const cache = makeVsCodeCache(11);
	policy.evict(cache);
	assert.equal(cache.size, 8, 'Should evict 3 entries from 11 → 8');
});

// ---------------------------------------------------------------------------
// CliCachePolicy — isValid
// ---------------------------------------------------------------------------

test('CliCachePolicy.isValid: returns true on exact mtime+size match', () => {
	const policy = new CliCachePolicy();
	assert.equal(policy.isValid(makeEntry(100, 200), 100, 200), true);
});

test('CliCachePolicy.isValid: returns false when mtime differs', () => {
	const policy = new CliCachePolicy();
	assert.equal(policy.isValid(makeEntry(100, 200), 999, 200), false);
});

test('CliCachePolicy.isValid: returns false when size differs', () => {
	const policy = new CliCachePolicy();
	assert.equal(policy.isValid(makeEntry(100, 200), 100, 999), false);
});

test('CliCachePolicy.isValid: returns false when size is undefined', () => {
	const policy = new CliCachePolicy();
	assert.equal(policy.isValid(makeEntry(100), 100, 200), false);
});

// ---------------------------------------------------------------------------
// CliCachePolicy — evict
// ---------------------------------------------------------------------------

function makeCliCache(count: number): Map<string, TestEntry> {
	const m = new Map<string, TestEntry>();
	for (let i = 0; i < count; i++) {
		m.set(`file${i}`, { mtime: i, size: i });
	}
	return m;
}

test('CliCachePolicy.evict: no-op when size is at max (2000)', () => {
	const policy = new CliCachePolicy(2000);
	const cache = makeCliCache(2000);
	policy.evict(cache);
	assert.equal(cache.size, 2000, 'Should not evict when at max');
});

test('CliCachePolicy.evict: trims to maxEntries when size exceeds max', () => {
	const policy = new CliCachePolicy(2000);
	const cache = makeCliCache(2500);
	policy.evict(cache);
	assert.equal(cache.size, 2000, 'Should trim to exactly 2000 entries');
});

test('CliCachePolicy.evict: retains most recently modified entries by mtime', () => {
	const policy = new CliCachePolicy(3);
	const cache = new Map<string, TestEntry>([
		['old1', { mtime: 100, size: 1 }],
		['old2', { mtime: 200, size: 2 }],
		['recent1', { mtime: 500, size: 5 }],
		['old3', { mtime: 50, size: 3 }],
		['recent2', { mtime: 400, size: 4 }],
	]);
	policy.evict(cache);
	assert.equal(cache.size, 3);
	assert.ok(cache.has('recent1'), 'Most recent (mtime=500) should survive');
	assert.ok(cache.has('recent2'), 'Second most recent (mtime=400) should survive');
	assert.ok(cache.has('old2'), 'Third most recent (mtime=200) should survive');
	assert.equal(cache.has('old1'), false, 'mtime=100 should be evicted');
	assert.equal(cache.has('old3'), false, 'mtime=50 should be evicted');
});

test('CliCachePolicy.evict: custom maxEntries is respected', () => {
	const policy = new CliCachePolicy(5);
	const cache = makeCliCache(10);
	policy.evict(cache);
	assert.equal(cache.size, 5);
});
