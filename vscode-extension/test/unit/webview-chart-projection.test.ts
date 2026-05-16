import test from 'node:test';
import * as assert from 'node:assert/strict';

import { getCurrentPeriodFraction, computeProjectionExtra } from '../../src/webview/chart/projectionUtils';

// ── getCurrentPeriodFraction – day ────────────────────────────────────────────

test('getCurrentPeriodFraction day: midnight returns 0', () => {
	const midnight = new Date(2025, 4, 15, 0, 0, 0); // May 15, 00:00
	assert.equal(getCurrentPeriodFraction('day', midnight), 0);
});

test('getCurrentPeriodFraction day: noon returns ~0.5', () => {
	const noon = new Date(2025, 4, 15, 12, 0, 0);
	const frac = getCurrentPeriodFraction('day', noon);
	assert.ok(Math.abs(frac - 0.5) < 0.001, `Expected ~0.5, got ${frac}`);
});

test('getCurrentPeriodFraction day: end of day returns ~1', () => {
	const almostMidnight = new Date(2025, 4, 15, 23, 59, 0);
	const frac = getCurrentPeriodFraction('day', almostMidnight);
	assert.ok(frac > 0.99 && frac < 1, `Expected close to 1, got ${frac}`);
});

// ── getCurrentPeriodFraction – week ──────────────────────────────────────────

test('getCurrentPeriodFraction week: Monday midnight returns 0', () => {
	// May 12, 2025 is a Monday
	const mondayMidnight = new Date(2025, 4, 12, 0, 0, 0);
	const frac = getCurrentPeriodFraction('week', mondayMidnight);
	assert.equal(frac, 0);
});

test('getCurrentPeriodFraction week: Monday noon returns ~1/14', () => {
	const mondayNoon = new Date(2025, 4, 12, 12, 0, 0); // Mon at noon
	const frac = getCurrentPeriodFraction('week', mondayNoon);
	const expected = 0.5 / 7;
	assert.ok(Math.abs(frac - expected) < 0.001, `Expected ~${expected}, got ${frac}`);
});

test('getCurrentPeriodFraction week: Thursday midnight returns ~3/7', () => {
	// May 15, 2025 is a Thursday (isoWeekDay = 3)
	const thursdayMidnight = new Date(2025, 4, 15, 0, 0, 0);
	const frac = getCurrentPeriodFraction('week', thursdayMidnight);
	const expected = 3 / 7;
	assert.ok(Math.abs(frac - expected) < 0.001, `Expected ~${expected}, got ${frac}`);
});

test('getCurrentPeriodFraction week: Sunday end returns close to 1', () => {
	// May 18, 2025 is a Sunday (isoWeekDay = 6)
	const sundayAlmostEnd = new Date(2025, 4, 18, 23, 59, 0);
	const frac = getCurrentPeriodFraction('week', sundayAlmostEnd);
	assert.ok(frac > 0.99 && frac <= 1, `Expected close to 1, got ${frac}`);
});

// ── getCurrentPeriodFraction – month ─────────────────────────────────────────

test('getCurrentPeriodFraction month: 1st midnight returns 0', () => {
	const firstMidnight = new Date(2025, 4, 1, 0, 0, 0); // May 1
	const frac = getCurrentPeriodFraction('month', firstMidnight);
	assert.equal(frac, 0);
});

test('getCurrentPeriodFraction month: 15th of 31-day month midnight returns ~14/31', () => {
	// May has 31 days; May 15 midnight = 14 full days elapsed
	const may15Midnight = new Date(2025, 4, 15, 0, 0, 0);
	const frac = getCurrentPeriodFraction('month', may15Midnight);
	const expected = 14 / 31;
	assert.ok(Math.abs(frac - expected) < 0.001, `Expected ~${expected}, got ${frac}`);
});

test('getCurrentPeriodFraction month: last day of 30-day month near end is close to 1', () => {
	// June has 30 days; June 30, 23:59
	const lastDay = new Date(2025, 5, 30, 23, 59, 0);
	const frac = getCurrentPeriodFraction('month', lastDay);
	assert.ok(frac > 0.99 && frac <= 1, `Expected close to 1, got ${frac}`);
});

// ── computeProjectionExtra ────────────────────────────────────────────────────

test('computeProjectionExtra: returns null when actual is 0', () => {
	assert.equal(computeProjectionExtra(0, 0.5), null);
});

test('computeProjectionExtra: returns null when fraction is below threshold', () => {
	assert.equal(computeProjectionExtra(1000, 0.005), null);
});

test('computeProjectionExtra: returns null when fraction is above threshold (period complete)', () => {
	assert.equal(computeProjectionExtra(1000, 0.999), null);
});

test('computeProjectionExtra: returns correct extra for 50% elapsed', () => {
	// 1000 tokens at 50% → projected 2000 total → extra = 1000
	const extra = computeProjectionExtra(1000, 0.5);
	assert.equal(extra, 1000);
});

test('computeProjectionExtra: returns correct extra for 25% elapsed', () => {
	// 500 tokens at 25% → projected 2000 total → extra = 1500
	const extra = computeProjectionExtra(500, 0.25);
	assert.equal(extra, 1500);
});

test('computeProjectionExtra: matches user formula (15th of 31-day month)', () => {
	// User formula: sum/dayOfMonth * daysInMonth - sum
	// At midnight on May 15: 14 full days elapsed out of 31 → fraction = 14/31
	const fraction = 14 / 31;
	const actual = 7000;
	const extra = computeProjectionExtra(actual, fraction);
	// projected = 7000 / (14/31) = 7000 * 31/14 = 15500; extra = 15500 - 7000 = 8500
	const expected = Math.round(actual / fraction - actual);
	assert.equal(extra, expected);
});

test('computeProjectionExtra: returns a positive float for tiny actual at 99% elapsed', () => {
	// fraction = 0.99 (just under threshold), actual = 0.001 → returns a tiny positive float
	const extra = computeProjectionExtra(0.001, 0.99);
	// 0.001 / 0.99 - 0.001 ≈ 0.00001 > 0 → non-null
	assert.ok(extra !== null && extra > 0, `Expected a small positive value, got ${extra}`);
});

test('computeProjectionExtra: returns positive value for realistic token counts', () => {
	// 10k tokens at 1/3 of the day
	const extra = computeProjectionExtra(10000, 1 / 3);
	assert.ok(extra !== null && extra > 0, `Expected positive extra, got ${extra}`);
	// projected = 30000; extra = 20000
	assert.equal(extra, 20000);
});
