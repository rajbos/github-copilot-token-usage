/**
 * ASS timestamps.
 *
 * The bug these exist for: centiseconds were rounded on their own and an
 * overflowing 100 was clamped back to 99, so a time just under a boundary
 * moved *backwards* and the carry never reached seconds, minutes or hours.
 * A cue could therefore end fractionally before the moment it was computed to
 * end at.
 *
 *   1.9999    -> 0:00:01.99   (should be 0:00:02.00)
 *   59.999    -> 0:00:59.99   (should be 0:01:00.00)
 *   3599.9999 -> 0:59:59.99   (should be 1:00:00.00)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assTime } from '../util';

test('a fraction just under a second carries into the second', () => {
	assert.equal(assTime(1.9999), '0:00:02.00');
	assert.equal(assTime(0.995), '0:00:01.00');
});

test('the carry reaches minutes and hours', () => {
	assert.equal(assTime(59.999), '0:01:00.00');
	assert.equal(assTime(3599.9999), '1:00:00.00');
});

test('exact values are unchanged', () => {
	assert.equal(assTime(0), '0:00:00.00');
	assert.equal(assTime(2), '0:00:02.00');
	assert.equal(assTime(61.5), '0:01:01.50');
	assert.equal(assTime(3661.25), '1:01:01.25');
});

test('a negative time clamps to zero rather than formatting nonsense', () => {
	assert.equal(assTime(-5), '0:00:00.00');
});

test('timestamps never move backwards as the input increases', () => {
	// The property the old rounding broke. Walking across several boundaries
	// in small steps, each formatted value must be >= the previous one.
	let previous = '';
	for (let centis = 0; centis <= 6200; centis++) {
		const formatted = assTime(centis / 100);
		assert.ok(formatted >= previous, `${formatted} sorts before ${previous}`);
		previous = formatted;
	}
});
