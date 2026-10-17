import test from 'node:test';
import * as assert from 'node:assert/strict';

import { extractDailyFractions } from '../dailyAttribution';

const FALLBACK = new Date('2025-01-01T12:00:00Z');

// ── JSONL path (Copilot CLI user.message events) ───────────────────────────

test('extractDailyFractions: CLI JSONL — single user.message returns its day', () => {
	const content = JSON.stringify({ type: 'user.message', timestamp: '2025-03-10T09:00:00Z' });
	const result = extractDailyFractions(content, true, FALLBACK);
	assert.deepEqual(result, { '2025-03-10': 1.0 });
});

test('extractDailyFractions: CLI JSONL — two messages on same day sum to 1.0', () => {
	const lines = [
		JSON.stringify({ type: 'user.message', timestamp: '2025-03-10T09:00:00Z' }),
		JSON.stringify({ type: 'user.message', timestamp: '2025-03-10T11:00:00Z' }),
	].join('\n');
	const result = extractDailyFractions(lines, true, FALLBACK);
	assert.deepEqual(result, { '2025-03-10': 1.0 });
});

test('extractDailyFractions: CLI JSONL — messages split across two days produce correct fractions', () => {
	// Use noon UTC so local day matches calendar day for all common timezones (UTC-11 to UTC+11)
	const lines = [
		JSON.stringify({ type: 'user.message', timestamp: '2025-03-10T12:00:00Z' }),
		JSON.stringify({ type: 'user.message', timestamp: '2025-03-11T12:00:00Z' }),
	].join('\n');
	const result = extractDailyFractions(lines, true, FALLBACK);
	const keys = Object.keys(result).sort();
	assert.equal(keys.length, 2, 'should have exactly 2 day keys');
	for (const v of Object.values(result)) {
		assert.ok(Math.abs(v - 0.5) < 1e-9, `each fraction should be 0.5, got ${v}`);
	}
});

test('extractDailyFractions: CLI JSONL — falls back when no timestamps found', () => {
	const content = JSON.stringify({ type: 'user.message', data: { content: 'no ts' } });
	const result = extractDailyFractions(content, true, FALLBACK);
	assert.deepEqual(result, { '2025-01-01': 1.0 });
});

test('extractDailyFractions: CLI JSONL — ignores non-user.message events for timestamp counting', () => {
	const lines = [
		JSON.stringify({ type: 'assistant.message', timestamp: '2025-03-10T09:00:00Z' }),
		JSON.stringify({ type: 'user.message', timestamp: '2025-03-11T09:00:00Z' }),
	].join('\n');
	const result = extractDailyFractions(lines, true, FALLBACK);
	// Only user.message contributes
	assert.deepEqual(result, { '2025-03-11': 1.0 });
});

// ── JSONL path (VS Code delta events) ──────────────────────────────────────

test('extractDailyFractions: delta JSONL — kind:0 initial state extracts request timestamps', () => {
	const content = JSON.stringify({
		kind: 0,
		v: { requests: [{ timestamp: '2025-04-05T12:00:00Z' }, { timestamp: '2025-04-06T12:00:00Z' }] }
	});
	const result = extractDailyFractions(content, true, FALLBACK);
	const keys = Object.keys(result).sort();
	assert.equal(keys.length, 2, 'should have exactly 2 day keys');
	for (const v of Object.values(result)) {
		assert.ok(Math.abs(v - 0.5) < 1e-9, `each fraction should be 0.5, got ${v}`);
	}
});

test('extractDailyFractions: delta JSONL — kind:2 batch append extracts timestamps', () => {
	const lines = [
		JSON.stringify({ kind: 0, v: {} }),
		JSON.stringify({
			kind: 2, k: ['requests'],
			v: [{ timestamp: '2025-04-07T10:00:00Z' }, { timestamp: '2025-04-07T11:00:00Z' }]
		}),
	].join('\n');
	const result = extractDailyFractions(lines, true, FALLBACK);
	assert.deepEqual(result, { '2025-04-07': 1.0 });
});

test('extractDailyFractions: delta JSONL — kind:2 single append with timestamp', () => {
	const lines = [
		JSON.stringify({ kind: 0, v: {} }),
		JSON.stringify({ kind: 2, k: ['requests', 0], v: { timestamp: '2025-04-08T12:00:00Z' } }),
	].join('\n');
	const result = extractDailyFractions(lines, true, FALLBACK);
	assert.deepEqual(result, { '2025-04-08': 1.0 });
});

test('extractDailyFractions: delta JSONL — kind:1 timestamp update counts new index only once', () => {
	const lines = [
		JSON.stringify({ kind: 0, v: {} }),
		JSON.stringify({ kind: 2, k: ['requests', 0], v: {} }),                                    // no timestamp yet
		JSON.stringify({ kind: 1, k: ['requests', 0, 'timestamp'], v: '2025-04-09T15:00:00Z' }),  // first update
		JSON.stringify({ kind: 1, k: ['requests', 0, 'timestamp'], v: '2025-04-09T15:01:00Z' }),  // second update (should not add)
	].join('\n');
	const result = extractDailyFractions(lines, true, FALLBACK);
	assert.deepEqual(result, { '2025-04-09': 1.0 });
});

// ── JSON path (VS Code plain JSON) ─────────────────────────────────────────

test('extractDailyFractions: JSON — extracts timestamps from requests array', () => {
	const data = {
		requests: [
			{ timestamp: '2025-05-01T12:00:00Z' },
			{ timestamp: '2025-05-02T12:00:00Z' },
		]
	};
	const result = extractDailyFractions(JSON.stringify(data), false, FALLBACK);
	const keys = Object.keys(result).sort();
	assert.equal(keys.length, 2, 'should have exactly 2 day keys');
	for (const v of Object.values(result)) {
		assert.ok(Math.abs(v - 0.5) < 1e-9, `each fraction should be 0.5, got ${v}`);
	}
});

test('extractDailyFractions: JSON — falls back to result.timestamp when timestamp missing', () => {
	const data = { requests: [{ result: { timestamp: '2025-05-03T09:00:00Z' } }] };
	const result = extractDailyFractions(JSON.stringify(data), false, FALLBACK);
	assert.deepEqual(result, { '2025-05-03': 1.0 });
});

test('extractDailyFractions: JSON — falls back when no timestamps', () => {
	const data = { requests: [{ message: 'no timestamp' }] };
	const result = extractDailyFractions(JSON.stringify(data), false, FALLBACK);
	assert.deepEqual(result, { '2025-01-01': 1.0 });
});

test('extractDailyFractions: JSON — falls back on invalid JSON', () => {
	const result = extractDailyFractions('not json', false, FALLBACK);
	assert.deepEqual(result, { '2025-01-01': 1.0 });
});

test('extractDailyFractions: JSON — fractions sum to 1.0', () => {
	const data = {
		requests: [
			{ timestamp: '2025-05-01T00:00:00Z' },
			{ timestamp: '2025-05-02T00:00:00Z' },
			{ timestamp: '2025-05-03T00:00:00Z' },
		]
	};
	const result = extractDailyFractions(JSON.stringify(data), false, FALLBACK);
	const sum = Object.values(result).reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(sum - 1.0) < 1e-9, `fractions should sum to 1.0, got ${sum}`);
});
