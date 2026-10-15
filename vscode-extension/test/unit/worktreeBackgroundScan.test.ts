import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
	shouldRunDailyWorktreeScan,
	shouldNotifyWorktreeFindings,
	formatBytesForNotification,
	sumWorktreeBytes,
	parseCleanupPushedWorktreesMessage,
	buildCleanupConfirmTitle,
	enqueueCleanupCandidates,
	validateWorktreeRepoRootFromSessionPaths,
	WORKTREE_BACKGROUND_SCAN_INTERVAL_MS,
	WORKTREE_SCAN_NOTIFY_MIN_BYTES,
} from '../../src/worktreeBackgroundScan';
import { scanWorktreeRootsWithTimeout } from '../../src/worktreeScan';

// ---------------------------------------------------------------------------
// shouldRunDailyWorktreeScan
// ---------------------------------------------------------------------------

test('shouldRunDailyWorktreeScan: never run before -> true', () => {
	assert.equal(shouldRunDailyWorktreeScan(undefined, Date.now()), true);
});

test('shouldRunDailyWorktreeScan: unparseable timestamp -> true (treat as never run)', () => {
	assert.equal(shouldRunDailyWorktreeScan('not-a-date', Date.now()), true);
});

test('shouldRunDailyWorktreeScan: less than a day since last run -> false', () => {
	const now = Date.parse('2026-08-21T12:00:00Z');
	const startedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
	assert.equal(shouldRunDailyWorktreeScan(startedAt, now), false);
});

test('shouldRunDailyWorktreeScan: exactly one interval since last run -> true', () => {
	const now = Date.parse('2026-08-21T12:00:00Z');
	const startedAt = new Date(now - WORKTREE_BACKGROUND_SCAN_INTERVAL_MS).toISOString();
	assert.equal(shouldRunDailyWorktreeScan(startedAt, now), true);
});

test('shouldRunDailyWorktreeScan: more than a day since last run -> true', () => {
	const now = Date.parse('2026-08-21T12:00:00Z');
	const startedAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
	assert.equal(shouldRunDailyWorktreeScan(startedAt, now), true);
});

test('shouldRunDailyWorktreeScan: respects a custom interval', () => {
	const now = Date.parse('2026-08-21T12:00:00Z');
	const startedAt = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago
	assert.equal(shouldRunDailyWorktreeScan(startedAt, now, 60 * 60 * 1000), false); // 1h interval
	assert.equal(shouldRunDailyWorktreeScan(startedAt, now, 15 * 60 * 1000), true); // 15min interval
});

// ---------------------------------------------------------------------------
// shouldNotifyWorktreeFindings
// ---------------------------------------------------------------------------

test('shouldNotifyWorktreeFindings: below the minimum footprint -> never notifies', () => {
	assert.equal(shouldNotifyWorktreeFindings(WORKTREE_SCAN_NOTIFY_MIN_BYTES - 1, undefined), false);
	assert.equal(shouldNotifyWorktreeFindings(1024, 500), false);
});

test('shouldNotifyWorktreeFindings: first time above the minimum -> notifies', () => {
	assert.equal(shouldNotifyWorktreeFindings(WORKTREE_SCAN_NOTIFY_MIN_BYTES, undefined), true);
});

test('shouldNotifyWorktreeFindings: small delta from last-notified baseline -> does not renotify', () => {
	const baseline = 1_000_000_000; // 1 GB
	const smallGrowth = baseline * 1.05; // 5%
	assert.equal(shouldNotifyWorktreeFindings(smallGrowth, baseline), false);
});

test('shouldNotifyWorktreeFindings: >= 10% growth from last-notified baseline -> renotifies', () => {
	const baseline = 1_000_000_000; // 1 GB
	const bigGrowth = baseline * 1.1; // exactly 10%
	assert.equal(shouldNotifyWorktreeFindings(bigGrowth, baseline), true);
});

test('shouldNotifyWorktreeFindings: >= 10% shrink from last-notified baseline also renotifies', () => {
	const baseline = 1_000_000_000;
	const shrunk = baseline * 0.85; // -15%
	assert.equal(shouldNotifyWorktreeFindings(shrunk, baseline), true);
});

test('shouldNotifyWorktreeFindings: a zero/negative baseline is treated like "never notified"', () => {
	assert.equal(shouldNotifyWorktreeFindings(WORKTREE_SCAN_NOTIFY_MIN_BYTES, 0), true);
});

// ---------------------------------------------------------------------------
// formatBytesForNotification
// ---------------------------------------------------------------------------

test('formatBytesForNotification: bytes below 1024 stay in B', () => {
	assert.equal(formatBytesForNotification(512), '512 B');
});

test('formatBytesForNotification: scales through KB/MB/GB', () => {
	assert.equal(formatBytesForNotification(1024), '1.0 KB');
	assert.equal(formatBytesForNotification(450 * 1024 * 1024), '450 MB');
	assert.equal(formatBytesForNotification(1.3 * 1024 * 1024 * 1024), '1.3 GB');
});

test('formatBytesForNotification: negative/NaN inputs fall back to "0 B"', () => {
	assert.equal(formatBytesForNotification(-5), '0 B');
	assert.equal(formatBytesForNotification(NaN), '0 B');
});

// ---------------------------------------------------------------------------
// sumWorktreeBytes
// ---------------------------------------------------------------------------

test('sumWorktreeBytes: sums only known (non-negative) byte counts', () => {
	const total = sumWorktreeBytes([{ bytes: 100 }, { bytes: -1 }, { bytes: 250 }]);
	assert.equal(total, 350);
});

test('sumWorktreeBytes: empty list -> 0', () => {
	assert.equal(sumWorktreeBytes([]), 0);
});

test('scanWorktreeRootsWithTimeout: skips a blocked root and continues scanning', async () => {
	const errors: Array<{ root: string; message: string }> = [];
	const visited: string[] = [];

	const results = await scanWorktreeRootsWithTimeout({
		roots: ['blocked', 'healthy'],
		isActive: () => true,
		timeoutMs: 10,
		scanRoot: async (root) => {
			visited.push(root);
			if (root === 'blocked') {
				return new Promise<string[]>(() => { /* never settles */ });
			}
			return ['found'];
		},
		onRootError: (root, error) => errors.push({ root, message: error.message }),
	});

	assert.deepEqual(visited, ['blocked', 'healthy']);
	assert.deepEqual(results, ['found']);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].root, 'blocked');
	assert.match(errors[0].message, /timed out after 10ms/);
});

test('scanWorktreeRootsWithTimeout: invalidates a timed-out root callback', async () => {
	let isBlockedRootActive: (() => boolean) | undefined;

	await scanWorktreeRootsWithTimeout({
		roots: ['blocked'],
		isActive: () => true,
		timeoutMs: 10,
		scanRoot: async (_root, isRootActive) => {
			isBlockedRootActive = isRootActive;
			return new Promise<string[]>(() => { /* never settles */ });
		},
		onRootError: () => undefined,
	});

	assert.equal(isBlockedRootActive?.(), false);
});

// ---------------------------------------------------------------------------
// parseCleanupPushedWorktreesMessage
// ---------------------------------------------------------------------------

test('parseCleanupPushedWorktreesMessage: parses candidates and an unscoped message', () => {
	const result = parseCleanupPushedWorktreesMessage({
		worktrees: [
			{ path: '/repo-a/wt1', branch: 'feature-1', repoLabel: 'repo-a' },
			{ path: '/repo-b/wt1', branch: 'feature-2', repoLabel: 'repo-b' },
		],
	});
	assert.deepEqual(result.candidates, [
		{ path: '/repo-a/wt1', branch: 'feature-1', repoLabel: 'repo-a' },
		{ path: '/repo-b/wt1', branch: 'feature-2', repoLabel: 'repo-b' },
	]);
	assert.equal(result.scopeRepoLabel, undefined);
});

test('parseCleanupPushedWorktreesMessage: trusts repoLabel scope when every candidate matches', () => {
	const result = parseCleanupPushedWorktreesMessage({
		repoLabel: 'repo-a',
		worktrees: [
			{ path: '/repo-a/wt1', branch: 'feature-1', repoLabel: 'repo-a' },
			{ path: '/repo-a/wt2', branch: 'feature-2', repoLabel: 'repo-a' },
		],
	});
	assert.equal(result.scopeRepoLabel, 'repo-a');
	assert.equal(result.candidates.length, 2);
});

test('parseCleanupPushedWorktreesMessage: falls back to unscoped when the candidate list is mixed-repo', () => {
	// A stale/mismatched webview state could send a repoLabel scope alongside worktrees from a
	// different (or multiple) repos; the confirmation dialog must not claim a narrower scope
	// than what is actually about to be deleted.
	const result = parseCleanupPushedWorktreesMessage({
		repoLabel: 'repo-a',
		worktrees: [
			{ path: '/repo-a/wt1', branch: 'feature-1', repoLabel: 'repo-a' },
			{ path: '/repo-b/wt1', branch: 'feature-2', repoLabel: 'repo-b' },
		],
	});
	assert.equal(result.scopeRepoLabel, undefined);
	assert.equal(result.candidates.length, 2);
});

test('parseCleanupPushedWorktreesMessage: falls back to unscoped when no candidate matches the requested repoLabel', () => {
	const result = parseCleanupPushedWorktreesMessage({
		repoLabel: 'repo-a',
		worktrees: [{ path: '/repo-b/wt1', branch: 'feature-2', repoLabel: 'repo-b' }],
	});
	assert.equal(result.scopeRepoLabel, undefined);
});

test('parseCleanupPushedWorktreesMessage: filters out entries with a missing/blank path', () => {
	const result = parseCleanupPushedWorktreesMessage({
		worktrees: [
			{ path: '  ', branch: 'x', repoLabel: 'repo-a' },
			{ branch: 'x', repoLabel: 'repo-a' },
			{ path: '/repo-a/wt1', branch: 'feature-1', repoLabel: 'repo-a' },
		],
	});
	assert.deepEqual(result.candidates, [{ path: '/repo-a/wt1', branch: 'feature-1', repoLabel: 'repo-a' }]);
});

test('parseCleanupPushedWorktreesMessage: a non-array/missing worktrees list yields no candidates', () => {
	assert.deepEqual(parseCleanupPushedWorktreesMessage({}).candidates, []);
	assert.deepEqual(parseCleanupPushedWorktreesMessage({ worktrees: 'not-an-array' }).candidates, []);
});

// ---------------------------------------------------------------------------
// buildCleanupConfirmTitle
// ---------------------------------------------------------------------------

test('buildCleanupConfirmTitle: unscoped, singular vs. plural count', () => {
	assert.equal(buildCleanupConfirmTitle(1, undefined), 'Clean up 1 pushed worktree?');
	assert.equal(buildCleanupConfirmTitle(3, undefined), 'Clean up 3 pushed worktrees?');
});

test('buildCleanupConfirmTitle: names the repository when scoped', () => {
	assert.equal(buildCleanupConfirmTitle(2, 'repo-a'), 'Clean up 2 pushed worktrees in "repo-a"?');
});

// ---------------------------------------------------------------------------
// validateWorktreeRepoRootFromSessionPaths
// ---------------------------------------------------------------------------

test('validateWorktreeRepoRootFromSessionPaths: accepts a session workspace in the same repo root', () => {
	const result = validateWorktreeRepoRootFromSessionPaths(
		'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo\\feature-x',
		[
			'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo\\main',
			'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo\\feature-x\\nested',
		],
	);

	assert.equal(result?.repoRoot, 'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo');
	assert.equal(result?.sessionWorkspacePath, 'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo\\main');
});

test('validateWorktreeRepoRootFromSessionPaths: rejects unrelated session workspaces', () => {
	assert.equal(
		validateWorktreeRepoRootFromSessionPaths(
			'C:\\Users\\me\\.copilot\\copilot-worktrees\\repo-a\\feature-x',
			['C:\\Users\\me\\.copilot\\copilot-worktrees\\repo-b\\main'],
		),
		undefined,
	);
});

// ---------------------------------------------------------------------------
// enqueueCleanupCandidates
// ---------------------------------------------------------------------------

test('enqueueCleanupCandidates: appends new paths and returns only those added', () => {
	const queue = [{ path: 'C:\wt\a', branch: 'a', repoLabel: 'r1' }];
	const added = enqueueCleanupCandidates(queue, [
		{ path: 'c:\WT\A', branch: 'a', repoLabel: 'r1' },
		{ path: 'C:\wt\b', branch: 'b', repoLabel: 'r2' },
		{ path: 'C:\wt\b', branch: 'b', repoLabel: 'r2' },
	]);
	assert.deepEqual(added.map((c) => c.path), ['C:\wt\b']);
	assert.deepEqual(queue.map((c) => c.path), ['C:\wt\a', 'C:\wt\b']);
});

test('enqueueCleanupCandidates: nothing new -> empty result, queue untouched', () => {
	const queue = [{ path: '/wt/a', branch: 'a', repoLabel: 'r' }];
	assert.deepEqual(enqueueCleanupCandidates(queue, [{ path: '/wt/a', branch: 'a', repoLabel: 'r' }]), []);
	assert.equal(queue.length, 1);
});
