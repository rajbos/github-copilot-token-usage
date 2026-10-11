import test from 'node:test';
import * as assert from 'node:assert/strict';
import { findRevertedPrNumbers, isRevertPr, summarizePrOutcomes, type PrListItem } from '../../../src/prOutcomes';

type Pr = PrListItem & { agent?: boolean };

const pr = (number: number, title: string, merged: string | null, extra: Partial<Pr> = {}): Pr =>
	({ number, title, merged_at: merged, created_at: merged ?? '2026-09-10T00:00:00Z', ...extra });

test('isRevertPr: GitHub revert titles only', () => {
	assert.equal(isRevertPr({ title: 'Revert "Add login"' }), true);
	assert.equal(isRevertPr({ title: 'Revert login change' }), false);
	assert.equal(isRevertPr({ title: null }), false);
});

test('findRevertedPrNumbers: the revert button body names the reverted PR', () => {
	const prs = [pr(10, 'Add login', '2026-09-10T00:00:00Z'), pr(11, 'Revert "Add login"', '2026-09-11T00:00:00Z', { body: 'Reverts owner/repo#10' })];
	assert.deepEqual([...findRevertedPrNumbers(prs, 'Owner/Repo')], [10]);
});

test('findRevertedPrNumbers: a body reference to another repository is ignored', () => {
	const prs = [pr(10, 'Add login', '2026-09-10T00:00:00Z'), pr(11, 'Revert "Add login"', '2026-09-11T00:00:00Z', { body: 'Reverts someone/else#10' })];
	assert.equal(findRevertedPrNumbers(prs, 'owner/repo').size, 0);
});

test('findRevertedPrNumbers: without a body, the quoted title matches the latest earlier merge', () => {
	const prs = [
		pr(5, 'Bump deps', '2026-09-01T00:00:00Z'),
		pr(8, 'Bump deps', '2026-09-05T00:00:00Z'),
		pr(9, 'Revert "Bump deps"', '2026-09-06T00:00:00Z'),
		pr(12, 'Bump deps', '2026-09-08T00:00:00Z'),
	];
	assert.deepEqual([...findRevertedPrNumbers(prs, 'o/r')], [8]);
});

test('findRevertedPrNumbers: unmerged reverts do not count, and a revert of a revert targets the first revert', () => {
	const prs = [
		pr(10, 'Add login', '2026-09-10T00:00:00Z'),
		pr(11, 'Revert "Add login"', null, { body: 'Reverts o/r#10' }),
		pr(20, 'Feature', '2026-09-10T00:00:00Z'),
		pr(21, 'Revert "Feature"', '2026-09-11T00:00:00Z', { body: 'Reverts o/r#20' }),
		pr(22, 'Revert "Revert "Feature""', '2026-09-12T00:00:00Z', { body: 'Reverts o/r#21' }),
	];
	assert.deepEqual([...findRevertedPrNumbers(prs, 'o/r')].sort(), [20, 21]);
});

test('summarizePrOutcomes: splits agent PRs from the baseline and leaves revert PRs out of both', () => {
	const prs: Pr[] = [
		pr(1, 'Agent change', '2026-09-20T00:00:00Z', { agent: true }),
		pr(2, 'Agent change 2', '2026-09-20T00:00:00Z', { agent: true }),
		pr(3, 'Agent open', null, { agent: true, created_at: '2026-09-02T00:00:00Z' }),
		pr(4, 'Human change', '2026-09-20T00:00:00Z'),
		pr(5, 'Revert "Agent change"', '2026-09-21T00:00:00Z', { body: 'Reverts o/r#1' }),
	];
	const counts = summarizePrOutcomes(prs, p => !!p.agent, 'o/r', { sinceMs: Date.parse('2026-09-01T00:00:00Z'), nowMs: Date.parse('2026-09-25T00:00:00Z') });
	assert.deepEqual(counts, {
		aiMergedPrs: 2, aiRevertedPrs: 1, otherMergedPrs: 1, otherRevertedPrs: 0, aiAuthoredRecent: 2, aiAuthoredEarlier: 1,
	});
});
