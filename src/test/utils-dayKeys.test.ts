import test from 'node:test';
import * as assert from 'node:assert/strict';

import { toLocalDayKey, toUtcDayKey, addDaysUtc, getDayKeysInclusive } from '../utils/dayKeys';

// ── toUtcDayKey ─────────────────────────────────────────────────────────

test('toUtcDayKey: formats a UTC midnight date correctly', () => {
	assert.equal(toUtcDayKey(new Date('2025-03-15T00:00:00.000Z')), '2025-03-15');
});

test('toUtcDayKey: handles end-of-year', () => {
	assert.equal(toUtcDayKey(new Date('2025-12-31T23:59:59.999Z')), '2025-12-31');
});

test('toUtcDayKey: handles start-of-year', () => {
	assert.equal(toUtcDayKey(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01');
});

test('toUtcDayKey: late-day UTC time stays on the same day', () => {
	assert.equal(toUtcDayKey(new Date('2025-06-15T23:30:00.000Z')), '2025-06-15');
});

// ── addDaysUtc ──────────────────────────────────────────────────────────

test('addDaysUtc: adds positive days', () => {
	assert.equal(addDaysUtc('2025-03-28', 5), '2025-04-02');
});

test('addDaysUtc: subtracts days with negative offset', () => {
	assert.equal(addDaysUtc('2025-04-02', -5), '2025-03-28');
});

test('addDaysUtc: crosses year boundary forward', () => {
	assert.equal(addDaysUtc('2025-12-30', 3), '2026-01-02');
});

test('addDaysUtc: crosses year boundary backward', () => {
	assert.equal(addDaysUtc('2026-01-02', -3), '2025-12-30');
});

test('addDaysUtc: adding zero returns the same day', () => {
	assert.equal(addDaysUtc('2025-07-04', 0), '2025-07-04');
});

test('addDaysUtc: handles leap year (Feb 28 → Mar 1)', () => {
	assert.equal(addDaysUtc('2024-02-28', 2), '2024-03-01');
});

// ── getDayKeysInclusive ─────────────────────────────────────────────────

test('getDayKeysInclusive: returns a range of day keys', () => {
	const keys = getDayKeysInclusive('2025-03-01', '2025-03-05');
	assert.deepEqual(keys, [
		'2025-03-01', '2025-03-02', '2025-03-03', '2025-03-04', '2025-03-05'
	]);
});

test('getDayKeysInclusive: single day (start === end)', () => {
	assert.deepEqual(getDayKeysInclusive('2025-06-15', '2025-06-15'), ['2025-06-15']);
});

test('getDayKeysInclusive: returns empty when start > end', () => {
	assert.deepEqual(getDayKeysInclusive('2025-06-15', '2025-06-10'), []);
});

test('getDayKeysInclusive: crosses month boundary', () => {
	const keys = getDayKeysInclusive('2025-01-30', '2025-02-02');
	assert.deepEqual(keys, ['2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02']);
});



// ── toLocalDayKey ────────────────────────────────────────────────────────

test('toLocalDayKey: formats a local date as YYYY-MM-DD', () => {
const d = new Date(2025, 2, 15); // March 15, 2025 (month is 0-based)
const result = toLocalDayKey(d);
assert.equal(result, '2025-03-15');
});

test('toLocalDayKey: pads single-digit month and day with leading zero', () => {
const d = new Date(2025, 0, 5); // January 5, 2025
const result = toLocalDayKey(d);
assert.equal(result, '2025-01-05');
});

test('toLocalDayKey: handles December 31', () => {
const d = new Date(2025, 11, 31); // December 31, 2025
const result = toLocalDayKey(d);
assert.equal(result, '2025-12-31');
});

test('toLocalDayKey: handles January 1', () => {
const d = new Date(2026, 0, 1); // January 1, 2026
const result = toLocalDayKey(d);
assert.equal(result, '2026-01-01');
});

test('toLocalDayKey: returns a string of exactly 10 characters', () => {
const d = new Date(2024, 5, 8); // June 8, 2024
const result = toLocalDayKey(d);
assert.equal(result.length, 10);
assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('getDayKeysInclusive: stops at the end key without computing the day after it (max date boundary)', () => {
	// Day after 9999-12-31 is '+010000-01-01', which sorts *before* '9999-12-31' as a string.
	// Without the early break at the end key the loop would never terminate.
	assert.deepEqual(getDayKeysInclusive('9999-12-31', '9999-12-31'), ['9999-12-31']);
	assert.deepEqual(getDayKeysInclusive('9999-12-30', '9999-12-31'), ['9999-12-30', '9999-12-31']);
});
