import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	contextRefRecentTotal,
	partitionContextRefRows,
	type ContextRefRow,
} from '../../src/webview/usage/contextRefRows';

// ── Coverage for the Context References long-tail split ───────────────────────
//
// The Context References table enumerates every reference kind the extension can detect
// (21 rows today), most of which are permanently zero on any given machine. The rows with
// no usage today and none in the last 30 days collapse into an "Other references" disclosure
// so the handful that carry signal stay above the fold. These tests lock in the two decisions
// that would otherwise regress silently:
//   - which columns count as "recent" (today + last 30 days, NOT this/last month), and
//   - that the tail is collapsed, never dropped — every input row lands in exactly one half.

function row(label: string, counts: Partial<Omit<ContextRefRow, 'label' | 'title'>> = {}): ContextRefRow {
	return { label, today: 0, last30: 0, month: 0, lastMonth: 0, ...counts };
}

describe('contextRefRecentTotal', () => {
	test('sums today and the last 30 days', () => {
		assert.equal(contextRefRecentTotal(row('#file', { today: 3, last30: 40 })), 43);
	});

	test('ignores the this-month and last-month columns', () => {
		// A reference last used two months ago is exactly the long tail the split folds away,
		// and "this month" is already covered by the last-30-days window.
		assert.equal(contextRefRecentTotal(row('#clipboard', { month: 12, lastMonth: 99 })), 0);
	});
});

describe('partitionContextRefRows', () => {
	test('keeps rows used today or in the last 30 days active', () => {
		const rows = [
			row('#file', { today: 5, last30: 60 }),
			row('#pr', { today: 1 }),
			row('#codebase', { last30: 2 }),
		];
		const { active, other } = partitionContextRefRows(rows);
		assert.deepEqual(active.map(r => r.label), ['#file', '#pr', '#codebase']);
		assert.deepEqual(other, []);
	});

	test('moves rows with no recent usage into the other group', () => {
		const rows = [
			row('#file', { today: 5, last30: 60 }),
			row('#clipboard'),
			row('#problemsPanel', { lastMonth: 7 }),
		];
		const { active, other } = partitionContextRefRows(rows);
		assert.deepEqual(active.map(r => r.label), ['#file']);
		assert.deepEqual(other.map(r => r.label), ['#clipboard', '#problemsPanel']);
	});

	test('preserves the caller-supplied order within each half', () => {
		// main.ts sorts by last-30-days descending before partitioning; the split must not reshuffle.
		const rows = [
			row('a', { last30: 30 }),
			row('zero-1'),
			row('b', { last30: 10 }),
			row('zero-2'),
		];
		const { active, other } = partitionContextRefRows(rows);
		assert.deepEqual(active.map(r => r.label), ['a', 'b']);
		assert.deepEqual(other.map(r => r.label), ['zero-1', 'zero-2']);
	});

	test('never drops a row: the two halves partition the input exactly', () => {
		const rows = [row('a', { today: 1 }), row('b'), row('c', { last30: 4 }), row('d')];
		const { active, other } = partitionContextRefRows(rows);
		assert.equal(active.length + other.length, rows.length);
		assert.deepEqual(
			[...active, ...other].map(r => r.label).sort(),
			rows.map(r => r.label).sort(),
		);
	});

	test('an all-zero table yields no active rows rather than throwing', () => {
		const { active, other } = partitionContextRefRows([row('a'), row('b')]);
		assert.deepEqual(active, []);
		assert.equal(other.length, 2);
	});

	test('an empty table yields two empty halves', () => {
		assert.deepEqual(partitionContextRefRows([]), { active: [], other: [] });
	});

	test('does not mutate the input array or its rows', () => {
		const rows = [row('a', { today: 1 }), row('b')];
		const snapshot = JSON.parse(JSON.stringify(rows));
		partitionContextRefRows(rows);
		assert.deepEqual(rows, snapshot);
	});
});
