import test from 'node:test';
import * as assert from 'node:assert/strict';

import { parseConsentTimestamp } from '../../src/backend/services/syncService';

test('parseConsentTimestamp returns Error for null/undefined', () => {
	const result1 = parseConsentTimestamp(null);
	const result2 = parseConsentTimestamp(undefined);
	
	assert.ok(result1 instanceof Error);
	assert.ok(result2 instanceof Error);
	assert.ok(result1.message.includes('no consent timestamp provided'));
	assert.ok(result2.message.includes('no consent timestamp provided'));
});

test('parseConsentTimestamp returns Error for empty string', () => {
	const result = parseConsentTimestamp('');
	
	assert.ok(result instanceof Error);
	assert.ok(result.message.includes('no consent timestamp provided'));
});

test('parseConsentTimestamp returns Error for invalid date string', () => {
	const result = parseConsentTimestamp('not-a-date');
	
	assert.ok(result instanceof Error);
	assert.ok(result.message.includes('Invalid consent timestamp (not a valid date)'));
});

test('parseConsentTimestamp returns Error for future date', () => {
	// Create a date far in the future
	const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10); // 10 years in future
	const futureDateStr = futureDate.toISOString();
	
	const result = parseConsentTimestamp(futureDateStr);
	
	assert.ok(result instanceof Error);
	assert.ok(result.message.includes('Invalid consent timestamp (future date)'));
});

test('parseConsentTimestamp returns Date for valid ISO date string', () => {
	const dateStr = '2024-01-15T10:30:00.000Z';
	const result = parseConsentTimestamp(dateStr);
	
	assert.ok(!(result instanceof Error));
	assert.ok(result instanceof Date);
	assert.equal(result.toISOString(), dateStr);
});

test('parseConsentTimestamp returns Date for valid date string', () => {
	const dateStr = '2024-01-15';
	const result = parseConsentTimestamp(dateStr);
	
	assert.ok(!(result instanceof Error));
	assert.ok(result instanceof Date);
	assert.equal(result.toISOString(), '2024-01-15T00:00:00.000Z');
});

test('parseConsentTimestamp returns Date for Date object', () => {
	const date = new Date('2024-01-15');
	const result = parseConsentTimestamp(date);
	
	assert.ok(!(result instanceof Error));
	assert.ok(result instanceof Date);
	assert.equal(result.getTime(), date.getTime());
});
