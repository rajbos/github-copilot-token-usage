import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { makeTmpFixtureDir } from './tmpFixtureDirs';
import * as path from 'node:path';

import { CacheManager } from '../../src/cacheManager';
import type { SessionFileCache } from '../../../src/types';
import { createMockMemento } from './vscode-test-helpers';

function makeManager(dir: string, cacheVersion = 1, depsOverride?: Partial<{ onPeerClearDetected: () => void }>): CacheManager {
	const context: any = {
		extensionMode: 1, // Production -> cache id 'prod'
		globalStorageUri: { fsPath: dir },
		globalState: createMockMemento(),
	};
	const deps = { log: () => {}, warn: () => {}, error: () => {}, ...depsOverride };
	return new CacheManager(context, deps, cacheVersion);
}

function tmpDir(): string {
	return makeTmpFixtureDir('ctt-snapshot-test-');
}

function entry(mtime: number, tokens = 100): SessionFileCache {
	return { tokens, interactions: 1, modelUsage: {}, mtime, size: 10 } as SessionFileCache;
}

test('writeSharedSnapshot + readSharedSnapshot round-trip entries', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	m.setCachedSessionData('/b.json', entry(2000), 10);
	await m.writeSharedSnapshot();

	const entries = await m.readSharedSnapshot();
	assert.ok(entries, 'snapshot should be readable');
	assert.equal(Object.keys(entries!).length, 2);
	assert.equal(entries!['/a.json'].mtime, 1000);
	assert.equal(entries!['/b.json'].mtime, 2000);
});

test('writeSharedSnapshot writes atomically (no leftover .tmp files)', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	const storageDir = path.dirname(m.getSharedSnapshotPath());
	const leftovers = fs.readdirSync(storageDir).filter(f => f.endsWith('.tmp'));
	assert.deepEqual(leftovers, [], 'no temp files should remain');
});

test('readSharedSnapshot returns undefined on cache-version mismatch', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir, 1);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	// A reader on a different cache version must ignore the snapshot.
	const reader = makeManager(dir, 2);
	const entries = await reader.readSharedSnapshot();
	assert.equal(entries, undefined);
});

test('readSharedSnapshot returns undefined on corrupt snapshot', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	fs.mkdirSync(path.dirname(m.getSharedSnapshotPath()), { recursive: true });
	fs.writeFileSync(m.getSharedSnapshotPath(), '{ this is not valid json');
	const entries = await m.readSharedSnapshot();
	assert.equal(entries, undefined);
});

test('loadSharedSnapshotIfChanged merges fresher entries and is idempotent', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	writer.setCachedSessionData('/b.json', entry(2000), 10);
	await writer.writeSharedSnapshot();

	const reader = makeManager(dir);
	const merged = await reader.loadSharedSnapshotIfChanged();
	assert.equal(merged, 2, 'both entries merged on first load');
	assert.equal(reader.cache.get('/a.json')?.mtime, 1000);

	// Second call without a newer snapshot should merge nothing.
	const mergedAgain = await reader.loadSharedSnapshotIfChanged();
	assert.equal(mergedAgain, 0);
});

test('loadSharedSnapshotIfChanged does not overwrite a newer local entry', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	const reader = makeManager(dir);
	// Reader already parsed a NEWER version of /a.json locally.
	reader.setCachedSessionData('/a.json', entry(5000), 10);
	const merged = await reader.loadSharedSnapshotIfChanged();
	assert.equal(merged, 0, 'older snapshot entry must not replace newer local entry');
	assert.equal(reader.cache.get('/a.json')?.mtime, 5000);
});

test('loadSharedSnapshotIfChanged returns 0 when no snapshot exists', async () => {
	const dir = tmpDir();
	const reader = makeManager(dir);
	const merged = await reader.loadSharedSnapshotIfChanged();
	assert.equal(merged, 0);
});

test('writeSharedSnapshot merges with existing snapshot without regressing newer entries', async () => {
	const dir = tmpDir();
	// Leader publishes a fresh entry for /a.json.
	const leader = makeManager(dir);
	leader.setCachedSessionData('/a.json', entry(2000), 10);
	await leader.writeSharedSnapshot();

	// Follower holds an OLDER /a.json plus an extra /b.json, then writes.
	const follower = makeManager(dir);
	follower.setCachedSessionData('/a.json', entry(1000), 10);
	follower.setCachedSessionData('/b.json', entry(3000), 10);
	await follower.writeSharedSnapshot();

	const entries = await leader.readSharedSnapshot();
	assert.ok(entries);
	assert.equal(entries!['/a.json'].mtime, 2000, 'leader\'s newer /a.json must survive');
	assert.equal(entries!['/b.json'].mtime, 3000, 'follower\'s extra /b.json must be added');
});

test('writeSharedSnapshot caps the shared snapshot at 20000 newest entries', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	for (let i = 0; i < 20_050; i++) {
		writer.setCachedSessionData(`/file${i}.json`, entry(i), 10);
	}
	await writer.writeSharedSnapshot();

	const entries = await writer.readSharedSnapshot();
	assert.ok(entries);
	assert.equal(Object.keys(entries!).length, 20_000, 'snapshot should keep only the newest 20000 entries');
	assert.equal(entries!['/file0.json'], undefined, 'oldest snapshot entry should be pruned');
	assert.equal(entries!['/file49.json'], undefined, 'entries outside the newest 20000 should be pruned');
	assert.equal(entries!['/file50.json']?.mtime, 50, 'newest retained window should start at entry 50');
	assert.equal(entries!['/file20049.json']?.mtime, 20049, 'newest entry should be retained');
});

test('refresh lock: acquire then release; renew only when owned', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	assert.equal(await m.acquireRefreshLock(), true, 'first acquire succeeds');
	assert.equal(await m.renewRefreshLock(), true, 'owner can renew');
	await m.releaseRefreshLock();
	assert.equal(fs.existsSync(m.getRefreshLockPath()), false, 'lock file removed after release');
});

test('refresh lock and cache lock are independent files', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	assert.notEqual(m.getRefreshLockPath(), m.getCacheLockPath());
	assert.equal(await m.acquireRefreshLock(), true);
	// The cache (save) lock must still be acquirable while the refresh lock is held.
	assert.equal(await m.acquireCacheLock(), true);
	await m.releaseRefreshLock();
	await m.releaseCacheLock();
});

// Windows reuses PIDs aggressively: after a reboot a leftover lock file can point
// at a PID now owned by an unrelated process. The stale-lock check must not trust
// a live PID whose image is not a VS Code/Electron host.
test('refresh lock: breaks stale lock owned by a recycled non-host PID (win32)', { skip: process.platform !== 'win32' }, async () => {
	const dir = tmpDir();
	const holder = makeManager(dir);
	assert.equal(await holder.acquireRefreshLock(), true);

	// Simulate a reboot: overwrite the lock with a fresh timestamp but point the
	// PID at cmd.exe, which is alive and guaranteed not to be an editor host.
	const lockPath = holder.getRefreshLockPath();
	const cmdPid: number = (require('node:child_process') as typeof import('node:child_process'))
		.spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 >nul'], { windowsHide: true }).pid!;
	try {
		fs.writeFileSync(lockPath, JSON.stringify({ sessionId: 'old-session', pid: cmdPid, timestamp: Date.now() }));
		const fresh = makeManager(dir);
		assert.equal(await fresh.acquireRefreshLock(), true, 'recycled non-host PID must be treated as stale');
		await fresh.releaseRefreshLock();
	} finally {
		try { process.kill(cmdPid); } catch { /* already exited */ }
	}
});

// A writer killed between the atomic create and the content write leaves a
// 0-byte (or otherwise unparseable) lock behind. JSON.parse throwing used to be
// swallowed by the same catch that handles "owner deleted the file", so the
// corrupt lock blocked every acquire attempt forever and forced all windows
// into follower mode.
test('refresh lock: breaks corrupt (empty) lock file left by a crashed writer', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	fs.writeFileSync(m.getRefreshLockPath(), '');
	assert.equal(await m.acquireRefreshLock(), true, 'empty lock must be treated as stale');
	const content = JSON.parse(fs.readFileSync(m.getRefreshLockPath(), 'utf-8'));
	assert.equal(typeof content.timestamp, 'number', 'lock must be rewritten with valid content');
	await m.releaseRefreshLock();
});

test('refresh lock: breaks lock file with invalid JSON or missing fields', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);

	fs.writeFileSync(m.getRefreshLockPath(), '{not json');
	assert.equal(await m.acquireRefreshLock(), true, 'invalid JSON lock must be treated as stale');
	await m.releaseRefreshLock();

	fs.writeFileSync(m.getRefreshLockPath(), JSON.stringify({ sessionId: 'old-session' }));
	assert.equal(await m.acquireRefreshLock(), true, 'lock without timestamp must be treated as stale');
	await m.releaseRefreshLock();
});

test('cache lock: breaks corrupt (empty) lock file', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	fs.writeFileSync(m.getCacheLockPath(), '');
	assert.equal(await m.acquireCacheLock(), true, 'empty cache lock must be treated as stale');
	await m.releaseCacheLock();
});

// ---------------------------------------------------------------------------
// loadCacheFromStorage (disk-based)
// ---------------------------------------------------------------------------

test('loadCacheFromStorage: loads entries from existing snapshot', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	writer.setCachedSessionData('/b.json', entry(2000), 20);
	await writer.writeSharedSnapshot();

	const logs: string[] = [];
	const context: any = {
		extensionMode: 1,
		globalStorageUri: { fsPath: dir },
		globalState: createMockMemento(),
	};
	const reader = new CacheManager(context, { log: (m: string) => logs.push(m), warn: () => {}, error: () => {} }, 1);
	await reader.loadCacheFromStorage();
	assert.equal(reader.cache.size, 2, 'should load both entries');
	assert.equal(reader.cache.get('/a.json')?.mtime, 1000);
	assert.equal(reader.cache.get('/b.json')?.mtime, 2000);
	assert.ok(logs.some(l => /Loaded 2 cached session files from disk snapshot \(prod\) in \d+ms/.test(l)),
		'should log load duration');
});

test('loadCacheFromStorage: starts with empty cache when no snapshot exists', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	await m.loadCacheFromStorage();
	assert.equal(m.cache.size, 0, 'cache should be empty when no snapshot exists');
});

test('loadCacheFromStorage: clears cache and resets lastCleanSyncVersion on version mismatch', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir, 1);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	// Reader uses a different cache version
	const logs: string[] = [];
	const context: any = {
		extensionMode: 1,
		globalStorageUri: { fsPath: dir },
		globalState: createMockMemento(),
	};
	// Pre-set a lastCleanSyncVersion to verify it gets cleared
	context.globalState.update('backend.lastCleanSyncVersion', 5);
	const reader = new CacheManager(context, { log: (m: string) => logs.push(m), warn: () => {}, error: () => {} }, 2);
	await reader.loadCacheFromStorage();
	assert.equal(reader.cache.size, 0, 'cache should be empty on version mismatch');
	assert.ok(logs.some(l => l.includes('version mismatch')), 'should log version mismatch');
	assert.equal(context.globalState.get('backend.lastCleanSyncVersion'), undefined,
		'lastCleanSyncVersion should be cleared on version mismatch');
});

test('loadCacheFromStorage: removes large globalState cache entries (migration)', async () => {
	const dir = tmpDir();
	const context: any = {
		extensionMode: 1,
		globalStorageUri: { fsPath: dir },
		globalState: createMockMemento(),
	};
	// Simulate old large entries in globalState
	await context.globalState.update('sessionFileCache_prod', { '/a.json': entry(1000) });
	await context.globalState.update('sessionFileCacheVersion_prod', 1);
	await context.globalState.update('sessionFileCache', { '/b.json': entry(2000) });

	const m = new CacheManager(context, { log: () => {}, warn: () => {}, error: () => {} }, 1);
	await m.loadCacheFromStorage();

	assert.equal(context.globalState.get('sessionFileCache_prod'), undefined,
		'current scoped key should be removed from globalState');
	assert.equal(context.globalState.get('sessionFileCacheVersion_prod'), undefined,
		'version key should be removed from globalState');
	assert.equal(context.globalState.get('sessionFileCache'), undefined,
		'legacy unscoped key should be removed from globalState');
});

// ---------------------------------------------------------------------------
// deleteSharedSnapshot
// ---------------------------------------------------------------------------

test('deleteSharedSnapshot: removes the snapshot file', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();
	assert.ok(fs.existsSync(m.getSharedSnapshotPath()), 'snapshot should exist before delete');

	await m.deleteSharedSnapshot();
	assert.equal(fs.existsSync(m.getSharedSnapshotPath()), false, 'snapshot should be removed');
});

test('deleteSharedSnapshot: is a no-op when snapshot does not exist', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	// Should not throw
	await assert.doesNotReject(() => m.deleteSharedSnapshot());
});

test('deleteSharedSnapshot: prevents reloading cleared cache after restart', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();
	await m.deleteSharedSnapshot();

	const reader = makeManager(dir);
	await reader.loadCacheFromStorage();
	assert.equal(reader.cache.size, 0, 'cleared cache should not be reloaded from disk');
});

// ---------------------------------------------------------------------------
// migrateOldCacheKeys: now removes all cache keys (including current scoped)
// ---------------------------------------------------------------------------

test('migrateOldCacheKeys: removes all sessionFileCache* keys from globalState', () => {
	const dir = tmpDir();
	const context: any = {
		extensionMode: 1,
		globalStorageUri: { fsPath: dir },
		globalState: createMockMemento(),
	};
	context.globalState.update('sessionFileCache_prod', { data: 'big' });
	context.globalState.update('sessionFileCacheVersion_prod', 1);
	context.globalState.update('sessionFileCache_dev-abc123', { data: 'big' });
	context.globalState.update('sessionFileCacheTimestamp_prod', 12345);
	context.globalState.update('sessionFileCache', { data: 'legacy' });
	context.globalState.update('github.authenticated', true); // should NOT be removed

	const m = new CacheManager(context, { log: () => {}, warn: () => {}, error: () => {} }, 1);
	m.migrateOldCacheKeys('prod');

	assert.equal(context.globalState.get('sessionFileCache_prod'), undefined);
	assert.equal(context.globalState.get('sessionFileCacheVersion_prod'), undefined);
	assert.equal(context.globalState.get('sessionFileCache_dev-abc123'), undefined);
	assert.equal(context.globalState.get('sessionFileCacheTimestamp_prod'), undefined);
	assert.equal(context.globalState.get('sessionFileCache'), undefined);
	// Unrelated keys must be preserved
	assert.equal(context.globalState.get('github.authenticated'), true);
});

// ---------------------------------------------------------------------------
// deleteCachedSessionData: deletion must survive a save (issue found in PR #2080
// review — writeSharedSnapshot()'s merge starts from whatever is already on disk, so a
// plain cache.delete() is silently resurrected by the very next save)
// ---------------------------------------------------------------------------

test('deleteCachedSessionData() tombstones the path so a later writeSharedSnapshot() cannot resurrect it from disk', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	m.setCachedSessionData('/b.json', entry(2000), 10);
	await m.writeSharedSnapshot();

	m.deleteCachedSessionData('/a.json');
	await m.writeSharedSnapshot();

	const entries = await m.readSharedSnapshot();
	assert.ok(entries, 'snapshot should still be readable');
	assert.equal(Object.keys(entries!).length, 1, 'the deleted entry must not survive a later save');
	assert.ok(!('/a.json' in entries!), '/a.json must be gone from the persisted snapshot, not resurrected from the disk copy written before the delete');
	assert.equal(entries!['/b.json'].mtime, 2000, 'an unrelated entry must be untouched');
});

// A second, independent deletion of an already-tombstoned path is plausible in practice:
// clearExpiredCache()'s fire-and-forget sweep can race with reconcilePreloadedAgainstDiscovery()'s
// synchronous one, both independently deciding to delete the same path. The second call finds no
// `existing` in-memory entry (the first deletion already removed it), so without preserving the
// prior baseline, the tombstone would be silently weakened to mtime 0 — letting any stale disk
// entry with a positive mtime pass the newer-than-tombstone check and be resurrected.
test('deleteCachedSessionData() does not weaken an existing tombstone baseline on a second, independent deletion of the same path', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(5000), 10);
	await writer.writeSharedSnapshot(); // disk: /a.json @ mtime 5000

	const deleter = makeManager(dir);
	deleter.setCachedSessionData('/a.json', entry(5000), 10);
	deleter.deleteCachedSessionData('/a.json'); // first deletion: tombstone baseline = mtime 5000
	deleter.deleteCachedSessionData('/a.json'); // second, independent deletion of the same path

	// The same-age disk entry (mtime 5000, written before either deletion) is exactly what a
	// wrongly weakened tombstone (mtime 0) would let back in via the `diskEntry.mtime > tombstoneMtime`
	// check in buildMergedSnapshotEntries().
	await deleter.writeSharedSnapshot();
	const entries = await deleter.readSharedSnapshot();
	assert.ok(!entries || !('/a.json' in entries!),
		'the same-age disk entry must still be stripped — a wrongly-weakened tombstone (mtime 0) would have let it survive');
});

// This documents *why* deleteCachedSessionData() (not a plain `cache.delete()`) is required: it
// proves writeSharedSnapshot()'s merge really does resurrect an in-memory-only delete from the
// on-disk copy written before it. If this test ever starts failing because the merge stopped
// reading from disk first, deleteCachedSessionData()'s tombstone becomes unnecessary — that's a
// signal to revisit it, not a reason to delete this test.
test('a plain cache.delete() (no tombstone) is resurrected by the next writeSharedSnapshot() — the exact bug deleteCachedSessionData() exists to avoid', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	m.cache.delete('/a.json');
	await m.writeSharedSnapshot();

	const entries = await m.readSharedSnapshot();
	assert.ok(entries && '/a.json' in entries!,
		'a plain cache.delete() is expected to be resurrected by the merge — this is exactly the bug deleteCachedSessionData() exists to avoid');
});

test('setCachedSessionData() clears a stale tombstone, so a rediscovered path can be persisted again', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	m.deleteCachedSessionData('/a.json');
	m.setCachedSessionData('/a.json', entry(3000), 10); // rediscovered with a newer mtime
	await m.writeSharedSnapshot();

	const entries = await m.readSharedSnapshot();
	assert.ok(entries && '/a.json' in entries!, 'a path re-added after deletion must not be permanently blocked by its old tombstone');
	assert.equal(entries!['/a.json'].mtime, 3000);
});

// Cross-window scenario: window A tombstones a path, then a NEWER entry for that same path
// arrives from another window via loadSharedSnapshotIfChanged() (mergeSnapshotEntries()) — not
// via setCachedSessionData(), the only place that previously cleared a tombstone. Without also
// clearing it there, window A's own next save would silently discard the other window's valid,
// newer publish — not merely resurrect an old deletion, but destroy new data.
test('loadSharedSnapshotIfChanged() clears a stale tombstone when accepting a newer entry from another window', async () => {
	const dir = tmpDir();
	const windowA = makeManager(dir);
	windowA.setCachedSessionData('/a.json', entry(1000), 10);
	await windowA.writeSharedSnapshot();

	windowA.deleteCachedSessionData('/a.json');

	// Another window republishes '/a.json' with a newer entry.
	const windowB = makeManager(dir);
	windowB.setCachedSessionData('/a.json', entry(5000), 10);
	await windowB.writeSharedSnapshot();
	// Window A recorded its own snapshot's mtime when it wrote above, and
	// loadSharedSnapshotIfChanged() short-circuits on `mtimeMs <= lastLoadedSnapshotMtime`. These
	// two writes can land in the same millisecond, which reads as "nothing changed" and makes the
	// merge below return 0 — the test then fails on "the newer /a.json entry must be merged in".
	// Express "window B published something newer" explicitly rather than relying on the clock
	// advancing between two back-to-back writes. The production `mtimeMs <=` rule is right as it
	// stands: real windows do not publish twice within a millisecond.
	//
	// Use a far-future wall-clock mtime, not `Date.now() + 1000`: on Windows the wall clock can
	// jump BACKWARD by seconds (NTP slew, VM time sync, WSL2) and the wall clock can tick coarser
	// than NTFS file mtimes. Either turns a "+1s" timestamp into a past one at the instant the
	// file gets it, so windowA's recorded `lastLoadedSnapshotMtime` can end up >= the utimes'd
	// value and the load short-circuits — the observed flake. A fixed far-future mtime can never
	// be overtaken, and re-statting verifies the utimes actually took effect on this filesystem.
	const snapshotMtime = new Date('2100-01-01T00:00:00Z');
	const snapshotPath = windowB.getSharedSnapshotPath();
	let snapshotMtimeMs = 0;
	for (let attempt = 0; attempt < 3 && snapshotMtimeMs < snapshotMtime.getTime(); attempt++) {
		await fs.promises.utimes(snapshotPath, snapshotMtime, snapshotMtime);
		snapshotMtimeMs = (await fs.promises.stat(snapshotPath)).mtimeMs;
	}
	assert.equal(snapshotMtimeMs, snapshotMtime.getTime(),
		'setting the snapshot mtime must take effect (a filesystem that silently drops it makes this test meaningless)');

	// Window A picks up window B's newer snapshot via the merge path, not setCachedSessionData().
	const merged = await windowA.loadSharedSnapshotIfChanged();
	assert.equal(merged, 1, 'the newer /a.json entry must be merged in');
	assert.equal(windowA.cache.get('/a.json')?.mtime, 5000);

	// Window A's own next save must not delete the entry it just accepted from window B.
	await windowA.writeSharedSnapshot();
	const entries = await windowA.readSharedSnapshot();
	assert.ok(entries && '/a.json' in entries!,
		'a stale tombstone must not survive accepting a newer merged-in entry — otherwise this window\'s own next save silently destroys another window\'s valid publish');
	assert.equal(entries!['/a.json'].mtime, 5000);
});

// Distinct from the "clears a stale tombstone when accepting a NEWER entry" test above: this
// covers mergeSnapshotEntries()'s own comparison, not just the end-to-end save-after-merge
// behavior. A tombstoned path has no `existing` in-memory entry to compare against (it was
// removed), so before the fix `!existing` was always true and ANY disk entry — even one no newer
// than what was deleted — got merged back in unconditionally, silently resurrecting the deletion.
test('loadSharedSnapshotIfChanged() does not resurrect a tombstoned path from a disk entry that is no newer than the deletion', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	const reader = makeManager(dir);
	reader.setCachedSessionData('/a.json', entry(1000), 10);
	reader.deleteCachedSessionData('/a.json'); // tombstone baseline = mtime 1000

	// The on-disk snapshot still has the same-age entry the tombstone was recorded against.
	const merged = await reader.loadSharedSnapshotIfChanged();

	assert.equal(merged, 0, 'a disk entry no newer than the tombstone baseline must not be merged in');
	assert.ok(!reader.cache.has('/a.json'), 'the path must stay deleted in memory, not resurrected from the stale disk copy');
});

test('clearExpiredCache() does not tombstone virtual session paths (.db#/.vscdb#/.sqlite#session-id, editor:// schemes) via a raw fs.access() check', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	const virtualDbPath = path.join(dir, 'opencode.db#ses_doesNotMatterIfMissing');
	const virtualVscdbPath = path.join(dir, 'state.vscdb#composerIdDoesNotMatterIfMissing'); // Cursor
	const virtualSqlitePath = path.join(dir, 'state_1.sqlite#threadIdDoesNotMatterIfMissing'); // Codex
	const virtualUriPath = 'windsurf://trajectory/some-id';
	const realMissingPath = path.join(dir, 'definitely-does-not-exist.json');
	m.setCachedSessionData(virtualDbPath, entry(1000), 10);
	m.setCachedSessionData(virtualVscdbPath, entry(1000), 10);
	m.setCachedSessionData(virtualSqlitePath, entry(1000), 10);
	m.setCachedSessionData(virtualUriPath, entry(1000), 10);
	m.setCachedSessionData(realMissingPath, entry(1000), 10);

	await m.clearExpiredCache();

	assert.ok(m.cache.has(virtualDbPath),
		'a .db#-style virtual path must survive clearExpiredCache() — fs.access() cannot validate it, and wrongly evicting it now tombstones a still-valid session out of every future snapshot, not just this process\'s memory');
	assert.ok(m.cache.has(virtualVscdbPath),
		'a .vscdb#-style virtual path (Cursor) must likewise survive — the exemption must recognize the general "<ext>#<id>" shape, not just the literal ".db#" substring');
	assert.ok(m.cache.has(virtualSqlitePath),
		'a .sqlite#-style virtual path (Codex) must likewise survive');
	assert.ok(m.cache.has(virtualUriPath),
		'a scheme:// virtual path (Windsurf/Devin) must likewise survive clearExpiredCache()');
	assert.ok(!m.cache.has(realMissingPath),
		'a genuinely missing real filesystem path must still be expired — this exemption must not blanket-disable expiry');
});

test('clearExpiredCache() only tombstones on a confirmed-missing error (ENOENT/ENOTDIR), not any fs.access() failure', { skip: process.platform === 'win32' }, async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	// A path with an over-length filename component reliably fails fs.access() with ENAMETOOLONG on
	// Linux/macOS — a real fs.access() failure that is NOT "this file is gone" (unlike ENOENT).
	const tooLongPath = path.join(dir, 'a'.repeat(300) + '.json');
	m.setCachedSessionData(tooLongPath, entry(1000), 10);

	await m.clearExpiredCache();

	assert.ok(m.cache.has(tooLongPath),
		'an fs.access() failure that is not ENOENT/ENOTDIR (ENAMETOOLONG here) must not be treated as a confirmed deletion — a permissions hiccup or transient I/O error would otherwise permanently tombstone a still-valid, expensive-to-rebuild session out of every future snapshot');
});

// Distinct from the loadSharedSnapshotIfChanged() cross-window test above: here window A never
// merges window B's newer publish into its own in-memory cache before saving again — it just goes
// straight to writeSharedSnapshot(), which reads the CURRENT on-disk snapshot (already containing
// B's newer entry) and merges A's own map on top. Without a timestamp on the tombstone, A's
// deletion decision (made before B ever republished) would still strip B's newer entry from the
// merged result it writes back to disk.
test('writeSharedSnapshot() does not let a stale tombstone strip a newer entry another window published to disk in the meantime', async () => {
	const dir = tmpDir();
	const windowA = makeManager(dir);
	windowA.setCachedSessionData('/a.json', entry(1000), 10);
	await windowA.writeSharedSnapshot();

	windowA.deleteCachedSessionData('/a.json'); // tombstone baseline = mtime 1000

	// Another window republishes '/a.json' with a newer entry, directly to disk — window A never
	// sees this in memory.
	const windowB = makeManager(dir);
	windowB.setCachedSessionData('/a.json', entry(9000), 10);
	await windowB.writeSharedSnapshot();

	// Window A saves again without ever merging window B's update into its own cache.
	await windowA.writeSharedSnapshot();

	const entries = await windowA.readSharedSnapshot();
	assert.ok(entries && '/a.json' in entries!,
		'a tombstone recorded against an older mtime (1000) must not strip a disk entry that is now newer (9000) — that newer entry was published after this deletion decision was made');
	assert.equal(entries!['/a.json'].mtime, 9000);
});

// ---------------------------------------------------------------------------
// Durable cross-window clear epoch (getClearEpochPath() / deleteSharedSnapshot() /
// writeSharedSnapshot() / loadSharedSnapshotIfChanged()): a peer window's later,
// independent save — built from its own untouched, pre-clear in-memory cache — must not
// republish stale data after another window's clearCache(), and that peer must stop
// *serving* the stale data from memory too, not just stop persisting it.
// ---------------------------------------------------------------------------

test('writeSharedSnapshot() skips publishing a save assembled before a peer window\'s clear', async () => {
	const dir = tmpDir();

	// Window A parses a session into memory but has not saved yet.
	const windowA = makeManager(dir);
	windowA.setCachedSessionData('/a.json', entry(1000), 10);

	// Window B clears the cache, which advances the durable clear epoch.
	const windowB = makeManager(dir);
	await windowB.deleteSharedSnapshot();

	// Window A's save was built entirely before window B's clear and must not land.
	await windowA.writeSharedSnapshot();

	const entries = await windowA.readSharedSnapshot();
	assert.ok(!entries || !('/a.json' in entries!),
		'a save assembled before a peer window\'s clear must not republish stale data to the shared snapshot');
});

test('loadSharedSnapshotIfChanged() drops a window\'s in-memory cache once a peer\'s clear is detected, even with nothing to publish', async () => {
	const dir = tmpDir();

	const windowA = makeManager(dir);
	windowA.setCachedSessionData('/a.json', entry(1000), 10);
	assert.equal(windowA.cache.size, 1);

	const windowB = makeManager(dir);
	await windowB.deleteSharedSnapshot();

	// Window A never saves anything — this only exercises the loader half of the fence.
	await windowA.loadSharedSnapshotIfChanged();

	assert.equal(windowA.cache.size, 0,
		'a detected peer clear must drop the in-memory cache so window A stops SERVING stale data, not just stop persisting it');
});

// A follow-up Copilot review found that the epoch check at the top of loadSharedSnapshotIfChanged()
// only guards the moment the call starts: a peer's clear landing anywhere during the subsequent
// stat/read/merge sequence would still get its pre-clear entries merged into this window's cache
// with no second check to catch it, letting the window serve (and later republish) that stale data
// until some unrelated later refresh cycle happened to call checkClearEpoch() again.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail)
// rather than a manual monkeypatch-plus-try/finally, so the patch cannot leak into another test.
test('loadSharedSnapshotIfChanged() re-checks the epoch after merging, so a clear landing mid-load is not resurrected', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot(); // pre-clear content on disk to (almost) resurrect

	const m = makeManager(dir);

	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		const result = await originalReadFile(...args);
		// Simulate a peer window's clear landing exactly while this call is reading the snapshot
		// it's about to merge — a real interleaving, not just a contrived ordering.
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			const peer = makeManager(dir);
			await peer.deleteSharedSnapshot();
		}
		return result;
	});
	const merged = await m.loadSharedSnapshotIfChanged();
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');
	assert.equal(merged, 0, 'entries read from a snapshot that turned out to predate a clear must not be reported as usefully merged');
	assert.equal(m.cache.size, 0, 'the pre-clear entry must not survive in memory once the mid-load clear is detected');
});

// A further Copilot review pass found the mid-load re-check above only covers the merge-succeeded
// path: the earlier `stat`-failure, stale-mtime, and corrupt-entries returns all exit before that
// check runs, so a peer's clear landing during `stat()` itself — including the case where the clear's
// own delete of the snapshot is what makes `stat()` throw — left this window's pre-clear in-memory
// cache untouched on the "no snapshot" early return. Fixed by centralizing the re-check to run before
// every return, not just the one after a successful merge.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('loadSharedSnapshotIfChanged() drops the stale in-memory cache on a peer clear landing during stat(), even with no snapshot on disk', async (t) => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10); // pre-clear in-memory data, never published

	const originalStat = fs.promises.stat.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'stat', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			// Simulate a peer window's clear landing exactly while this call is stat-ing the
			// snapshot — a real interleaving: there was never a snapshot on disk to begin with,
			// so stat() throws ENOENT either way, but the clear must still be detected here.
			const peer = makeManager(dir);
			await peer.deleteSharedSnapshot();
		}
		return originalStat(...args);
	});

	const merged = await m.loadSharedSnapshotIfChanged();
	assert.ok(intercepted, 'the stat interception must actually have fired for this assertion to be meaningful');
	assert.equal(merged, 0, 'nothing to merge — there was never a snapshot on disk');
	assert.equal(m.cache.size, 0, 'the pre-clear in-memory entry must be dropped once the mid-stat clear is detected, even on the no-snapshot early-return path');
});

// A further Copilot review found the epoch re-check above only guards against a *cross-window* clear:
// this window's own clearAllCachedData() (its own clearCache(), same process) landing during the
// stat/read/merge sequence bumps cacheClearGeneration, but deleteSharedSnapshot() — the call that
// actually advances the durable marker — may not have run yet (or already has, in which case this
// window's own clearEpoch already reflects it), so checkClearEpoch() can return false immediately
// afterward even though the cache was just synchronously emptied. Without a generation check too,
// mergeSnapshotEntries() (which reads `this.sessionFileCache` at call time, after the clear already
// ran) merges straight into that now-current, freshly-cleared map, silently reinserting pre-clear
// entries into what should be an empty cache.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('loadSharedSnapshotIfChanged() wipes what it just merged when this window\'s own clearAllCachedData() lands mid-load', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot(); // pre-clear content on disk to (almost) resurrect

	const m = makeManager(dir);

	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		const result = await originalReadFile(...args);
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			// Simulate this window's own clearCache() landing exactly while this load is reading the
			// snapshot it's about to merge — the same two calls clearCache() always makes back to
			// back, so clearInProgress is true only for this narrow window and cleared again once
			// deleteSharedSnapshot() finishes, matching production behavior.
			m.clearAllCachedData();
			await m.deleteSharedSnapshot();
		}
		return result;
	});

	const merged = await m.loadSharedSnapshotIfChanged();
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');
	assert.equal(merged, 0, 'entries merged into an already-cleared cache must not be reported as usefully merged');
	assert.equal(m.cache.size, 0, 'the pre-clear entry must not survive in the now-current (post-clear) cache map');

	// The wipe above must also reset lastLoadedSnapshotMtime, the same way loadCacheFromStorage()
	// guards the equivalent race on its own load path: left pointing at the pre-clear snapshot's
	// mtime, a post-clear snapshot recreated with an equal-or-lower mtime (coarse/backward clock)
	// would be wrongly skipped by this same method's own mtime shortcut on the next call.
	// publisher's own epoch still predates the real clear m just made (deleteSharedSnapshot() above
	// now genuinely advances the durable marker), so its first write is skipped and only resyncs it
	// (wiping publisher's own cache as a side effect) — the same "skipped once, resynced" pattern as
	// the dedicated test for that behavior elsewhere in this file.
	publisher.setCachedSessionData('/b.json', entry(2000), 10);
	await publisher.writeSharedSnapshot();
	publisher.setCachedSessionData('/b.json', entry(2000), 10);
	await publisher.writeSharedSnapshot();
	const snapshotPath = m.getSharedSnapshotPath();
	const stat = fs.statSync(snapshotPath);
	fs.utimesSync(snapshotPath, new Date(stat.mtimeMs - 1000), new Date(stat.mtimeMs - 1000));
	const secondMerged = await m.loadSharedSnapshotIfChanged();
	assert.ok(secondMerged > 0, 'the mtime bookmark must have been reset by the wipe above, not left pointing at the pre-clear snapshot');
	assert.ok(m.cache.has('/b.json'), 'the newly published entry must load despite its backdated mtime');
});

// A further Copilot review found the generation baseline was captured *after* the initial
// checkClearEpoch() call, so an *external* clearAllCachedData() (a different call chain, e.g. this
// window's own clearCache()) landing while that call's own internal epoch-marker read was still in
// flight went uncaught: the baseline already included the race by the time it was captured. Fixed by
// capturing a pre-call baseline too, and only advancing it to checkClearEpoch()'s own post-detection
// value when that same call is what produced the bump — checkClearEpoch() also legitimately bumps
// this counter on every real peer clear it detects, which must not be treated as a race with itself
// (see the comment at the capture site).
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('loadSharedSnapshotIfChanged() catches an external clearAllCachedData() landing during its own top-level epoch check', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot(); // pre-clear content on disk to (almost) resurrect

	const m = makeManager(dir);
	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).endsWith('.epoch.json')) {
			intercepted = true;
			// Simulate an unrelated call chain's clearCache() landing exactly while this call's own
			// top-level checkClearEpoch() is reading the epoch marker — a purely in-memory,
			// same-process clear that touches no files, so this read (and its own checkClearEpoch()
			// call) sees no epoch change and returns false.
			m.clearAllCachedData();
		}
		return originalReadFile(...args);
	});

	const merged = await m.loadSharedSnapshotIfChanged();
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');
	assert.equal(merged, 0, 'entries merged into an already-cleared cache must not be reported as usefully merged');
	assert.equal(m.cache.size, 0, 'the pre-clear entry must not survive the external clear that raced this call\'s own top-level epoch check');
});

test('a save that started before the clear epoch is skipped only once; the next save (after re-syncing) succeeds normally', async () => {
	const dir = tmpDir();

	const windowA = makeManager(dir);
	windowA.setCachedSessionData('/a.json', entry(1000), 10);

	const windowB = makeManager(dir);
	await windowB.deleteSharedSnapshot();

	await windowA.writeSharedSnapshot(); // skipped: pre-clear data
	assert.equal(windowA.cache.size, 0, 'the stale in-memory cache was dropped by the skipped save');

	// Window A resumes normal operation and parses fresh (post-clear) data.
	windowA.setCachedSessionData('/c.json', entry(9000), 10);
	await windowA.writeSharedSnapshot();

	const entries = await windowA.readSharedSnapshot();
	assert.ok(entries && '/c.json' in entries!, 'a save made after re-syncing with the clear epoch must publish normally');
});

// GitHub Copilot review on PR #2107 flagged two risks: the epoch write relying on rename() to
// overwrite an already-existing marker file (a concern on Windows for some replace strategies),
// and the epoch not being guaranteed to strictly advance across two close-together clears (e.g. a
// millisecond-granularity clock, or a backward NTP/VM time step). This test exercises both at
// once: two back-to-back clears necessarily rename over the marker the first clear just wrote, and
// must still produce a strictly greater epoch each time — on every platform CI runs this suite on,
// Windows included.
test('deleteSharedSnapshot() advances the clear epoch strictly, including two clears back-to-back', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);

	await m.deleteSharedSnapshot();
	const first = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;
	assert.equal(typeof first, 'number');

	await m.deleteSharedSnapshot();
	const second = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;

	assert.ok(second > first,
		`the second clear's epoch (${second}) must be strictly greater than the first (${first}) — a non-advancing epoch would let checkClearEpoch() silently miss the second clear`);
});

// A follow-up Copilot review noted the epoch's read-modify-write is itself a cross-window race (two
// windows could both read the same persisted epoch before either writes) and asked for it to be
// serialized. deleteSharedSnapshot() now bumps the epoch inside the same cache-lock section it
// already retries into before deleting (see its own doc comment) rather than acquiring the lock a
// second time — but that retry eventually gives up (see acquireCacheLockWithRetry()), so a clear
// must still succeed and advance the epoch even when a peer window never releases the lock at all.
// A tiny retryOptions budget keeps this test from waiting out the real (10s) production budget.
test('deleteSharedSnapshot() still advances the clear epoch once its lock retry budget is spent, with a peer holding the lock', async () => {
	const dir = tmpDir();
	const peer = makeManager(dir);
	assert.equal(await peer.acquireCacheLock(), true, 'peer window holds the cache lock, simulating a save in progress');

	const m = makeManager(dir);
	await assert.doesNotReject(() => m.deleteSharedSnapshot({ attempts: 2, delayMs: 5 }),
		'a clear must not hang or throw just because a peer window currently holds the cache lock');

	const epoch = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;
	assert.equal(typeof epoch, 'number', 'the epoch marker must still be advanced even without the lock');

	await peer.releaseCacheLock();
});

// A follow-up Copilot review found that checkClearEpoch() dropped the in-memory cache on a
// detected peer clear but left lastLoadedSnapshotMtime pointing at the pre-clear snapshot. On a
// coarse or backward-moving filesystem clock (the same class of clock behavior the cross-window
// tombstone test above already has to account for), a freshly recreated post-clear snapshot can get
// an mtime at or below that stale bookmark — which would make loadSharedSnapshotIfChanged()'s own
// mtime short-circuit believe it already has the latest snapshot and never load the new one.
test('a detected peer clear resets lastLoadedSnapshotMtime, so a post-clear snapshot with a non-advancing mtime still loads', async () => {
	const dir = tmpDir();

	const windowA = makeManager(dir);
	windowA.setCachedSessionData('/old.json', entry(1000), 10);
	await windowA.writeSharedSnapshot();
	const snapshotPath = windowA.getSharedSnapshotPath();
	const bookmarkedMtimeMs = (await fs.promises.stat(snapshotPath)).mtimeMs;
	await windowA.loadSharedSnapshotIfChanged(); // records windowA's own lastLoadedSnapshotMtime === bookmarkedMtimeMs

	const windowB = makeManager(dir);
	await windowB.deleteSharedSnapshot(); // peer clear: advances the epoch, removes the old snapshot
	windowB.setCachedSessionData('/new.json', entry(2000), 10);
	await windowB.writeSharedSnapshot(); // republish a post-clear snapshot

	// Force the freshly recreated snapshot's mtime BELOW windowA's already-recorded bookmark — the
	// coarse/backward-clock scenario the fix targets. Without the reset this makes
	// loadSharedSnapshotIfChanged()'s `mtimeMs <= lastLoadedSnapshotMtime` check believe nothing
	// changed, even though the clear resolved to entirely different content. A full second earlier
	// (not merely equal) avoids relying on exact mtime-resolution rounding across filesystems.
	const backdatedMtime = new Date(bookmarkedMtimeMs - 1000);
	await fs.promises.utimes(snapshotPath, backdatedMtime, backdatedMtime);

	const merged = await windowA.loadSharedSnapshotIfChanged();

	assert.ok(!windowA.cache.has('/old.json'), 'the detected peer clear must drop the pre-clear entry');
	assert.equal(merged, 1, 'the post-clear snapshot must still be loaded despite its non-advancing mtime');
	assert.ok(windowA.cache.has('/new.json'), 'the post-clear entry must be merged in');
});

test('a missing or corrupt clear-epoch marker fails open (writeSharedSnapshot still publishes)', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);

	// No epoch marker exists yet at all (fresh install / older extension version).
	await m.writeSharedSnapshot();
	let entries = await m.readSharedSnapshot();
	assert.ok(entries && '/a.json' in entries!, 'a missing epoch marker must not block a normal save');

	// A corrupt epoch marker must likewise not block a normal save.
	fs.mkdirSync(path.dirname(m.getClearEpochPath()), { recursive: true });
	fs.writeFileSync(m.getClearEpochPath(), '{ not valid json');
	m.setCachedSessionData('/b.json', entry(2000), 10);
	await m.writeSharedSnapshot();
	entries = await m.readSharedSnapshot();
	assert.ok(entries && '/b.json' in entries!, 'a corrupt epoch marker must fail open, not block saving');
});

test('a missing or corrupt clear-epoch marker fails open (loadSharedSnapshotIfChanged keeps the in-memory cache)', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);

	fs.mkdirSync(path.dirname(m.getClearEpochPath()), { recursive: true });
	fs.writeFileSync(m.getClearEpochPath(), 'not even json');

	await m.loadSharedSnapshotIfChanged();
	assert.equal(m.cache.size, 1, 'a corrupt epoch marker must not be treated as a detected clear');
	assert.equal(m.cache.get('/a.json')?.mtime, 1000);
});

// A further Copilot review found readClearEpoch() accepted any finite JSON number, but a corrupt
// marker like 1e100 is finite while not being a safe integer: `persisted + 1` on a value that large
// loses precision and rounds back to the same float, so bumpClearEpochLocked()'s new-epoch
// computation could fail to strictly advance, breaking the documented monotonicity guarantee despite
// the marker technically "parsing".
test('a clear-epoch marker with a finite but unsafe-integer value fails open, so the epoch still strictly advances', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);

	fs.mkdirSync(path.dirname(m.getClearEpochPath()), { recursive: true });
	fs.writeFileSync(m.getClearEpochPath(), JSON.stringify({ epoch: 1e100 }));

	await m.deleteSharedSnapshot();
	const persisted = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;
	assert.ok(Number.isSafeInteger(persisted), 'the marker must be rewritten with a safe integer, not the unsafe 1e100 plus one');
	assert.ok(persisted > 0, 'a finite-but-unsafe marker must fail open to 0, so the next clear still advances from a sane baseline');
});

// A further Copilot review found that when this branch fires, sessionFileCache is wiped but
// lastLoadedSnapshotMtime is not reset — a concurrent deleteSharedSnapshot() can reset that bookmark
// to 0 *before* this in-flight load's own stat() writes the pre-clear snapshot's (now stale) mtime
// back over it, so a post-clear snapshot recreated with an equal-or-lower mtime would then be wrongly
// skipped by loadSharedSnapshotIfChanged()'s own mtime shortcut.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('loadCacheFromStorage() resets the mtime bookmark too, when clearAllCachedData() lands mid-load', async (t) => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	const m = makeManager(dir);
	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		const result = await originalReadFile(...args);
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			// The same two calls clearCache() always makes back to back, so clearInProgress is true
			// only for this narrow window and cleared again once deleteSharedSnapshot() finishes,
			// matching production behavior.
			m.clearAllCachedData();
			await m.deleteSharedSnapshot();
		}
		return result;
	});

	await m.loadCacheFromStorage();
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');
	assert.equal(m.cache.size, 0, 'the pre-clear snapshot must not be loaded on top of a clear that landed mid-load');

	// A post-clear snapshot recreated with a non-advancing mtime (coarse/backward filesystem clock)
	// must still be eligible to load — it would not be if the bookmark still pointed at the old one.
	// publisher's own epoch predates the real clear m just made (deleteSharedSnapshot() above now
	// genuinely advances the durable marker and unlinks the pre-clear snapshot), so its first write
	// is skipped and only resyncs it (wiping publisher's own cache as a side effect) — the same
	// "skipped once, resynced" pattern as the dedicated test for that behavior elsewhere in this file.
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/b.json', entry(2000), 10);
	await publisher.writeSharedSnapshot();
	publisher.setCachedSessionData('/b.json', entry(2000), 10);
	await publisher.writeSharedSnapshot();
	const snapshotPath = m.getSharedSnapshotPath();
	const stat = fs.statSync(snapshotPath);
	fs.utimesSync(snapshotPath, new Date(stat.mtimeMs - 1000), new Date(stat.mtimeMs - 1000));

	// What matters is that /b.json actually loads despite its backdated mtime; left unfixed, the
	// stale bookmark from the pre-clear snapshot could exceed it and skip the load entirely.
	const merged = await m.loadSharedSnapshotIfChanged();
	assert.ok(merged > 0, 'the mtime bookmark must have been reset, not left pointing at the pre-clear snapshot');
	assert.ok(m.cache.has('/b.json'), 'the newly published entry must load despite its backdated mtime');
});

test('loadCacheFromStorage() seeds the clear epoch so freshly-loaded post-clear data is not immediately treated as stale', async () => {
	const dir = tmpDir();

	const first = makeManager(dir);
	first.setCachedSessionData('/a.json', entry(1000), 10);
	await first.writeSharedSnapshot();
	await first.deleteSharedSnapshot(); // simulates clearCache(): advances the durable epoch

	const second = makeManager(dir);
	await second.loadCacheFromStorage(); // must seed local epoch to the post-clear value, not 0
	second.setCachedSessionData('/b.json', entry(2000), 10);
	await second.writeSharedSnapshot();

	const entries = await second.readSharedSnapshot();
	assert.ok(entries && '/b.json' in entries!,
		'a save made after loadCacheFromStorage() seeded the epoch must not be wrongly treated as predating a past clear');
});

// A further Copilot review found the only-once-per-process constructor call to loadCacheFromStorage()
// can still race this same instance's own clearCache(): the promise it returns is never awaited by
// the constructor, so a clearCache() invoked before that disk read settles can land while it is still
// in flight. checkClearEpoch() in the `finally` block only reports a *cross-window* clear it has not
// yet accounted for — a same-process clearAllCachedData() bumps the generation but not necessarily
// the durable marker (deleteSharedSnapshot() may not have run yet), so it alone cannot be trusted to
// have wiped what this load just assigned to sessionFileCache above it.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('loadCacheFromStorage() wipes what it just loaded when clearAllCachedData() lands mid-load, same process', async (t) => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	const m = makeManager(dir);
	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		const result = await originalReadFile(...args);
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			// Simulate this window's own clearCache() landing exactly while the constructor's
			// loadCacheFromStorage() call is still reading the on-disk snapshot.
			m.clearAllCachedData();
		}
		return result;
	});

	await m.loadCacheFromStorage();
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');
	assert.equal(m.cache.size, 0, 'the pre-clear snapshot must not be loaded on top of a clear that landed mid-load');
});

test('writeSharedSnapshot() still strips a disk entry that is the same age as or older than the tombstoned deletion', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	writer.deleteCachedSessionData('/a.json'); // tombstone baseline = mtime 1000
	await writer.writeSharedSnapshot();

	const entries = await writer.readSharedSnapshot();
	assert.ok(!entries || !('/a.json' in entries!),
		'a disk entry no newer than the tombstone\'s baseline mtime is exactly what the deletion targeted, and must still be stripped');
});

// Checkpoint dirty-tracking: maybeCheckpointCache() must skip a save when nothing changed
// (previously it could fire on the time interval alone, even with zero dirty entries — the
// "Checkpointing cache: 0 new entries..." log line this behavior exists to eliminate), but must
// still recognize every real change — a changed existing entry, not just a brand-new path, and a
// genuine tombstone, not a repeated no-op of the same deletion race.
test('maybeCheckpointCache() returns false when nothing is dirty, even though a fresh manager has always had its time threshold elapsed', () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	// lastCheckpointTime starts at 0, so "time since last checkpoint" is enormous from the very
	// first check — the dirty-count guard must still block a checkpoint with nothing to save.
	assert.equal(m.maybeCheckpointCache(), false);
});

test('a dirty write on a fresh manager is eligible to checkpoint via the always-elapsed time threshold', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	assert.equal(m.maybeCheckpointCache(), false, 'nothing dirty yet');

	m.setCachedSessionData('/a.json', entry(1000), 10);
	assert.equal(m.maybeCheckpointCache(), true, 'one dirty write plus the always-elapsed time threshold must trigger a checkpoint');

	// Let the fire-and-forget save settle before the test (and its tmp dir) goes away.
	await m.awaitInFlightCheckpoint();
});

test('maybeCheckpointCache() counts a changed existing entry as dirty, not just brand-new paths', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	m.resetCheckpointCounters(); // start counting fresh, as _runRefreshCore() does per leader refresh
	assert.equal(m.maybeCheckpointCache(), false, 'nothing dirty right after reset');

	// Reach the entries threshold (300) via repeated *changes to the same already-cached path*,
	// not new paths — this is exactly what an earlier version of setCachedSessionData()
	// undercounted (only brand-new paths nudged the checkpoint threshold), so a long scan that
	// only re-parses already-known, changed files never checkpointed at all.
	for (let i = 0; i < 300; i++) {
		m.setCachedSessionData('/a.json', entry(2000 + i), 10);
	}
	assert.equal(m.maybeCheckpointCache(), true, 'reaching the entries threshold via changed-entry writes alone must trigger a checkpoint');

	await m.awaitInFlightCheckpoint();
});

test('deleteCachedSessionData() marks the cache dirty for a real removal, but a repeated no-op tombstone of the same path does not', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	for (let i = 0; i < 300; i++) {
		m.setCachedSessionData(`/file${i}.json`, entry(1000 + i), 10);
	}
	m.resetCheckpointCounters(); // start counting fresh, as _runRefreshCore() does per leader refresh
	assert.equal(m.maybeCheckpointCache(), false, 'nothing dirty right after reset');

	// 300 real, distinct deletions reach the entries threshold on their own (independent of the
	// time threshold, which a fresh reset leaves unmet) — proving a tombstone counts as dirty
	// just like a new/changed entry.
	for (let i = 0; i < 300; i++) {
		m.deleteCachedSessionData(`/file${i}.json`);
	}
	assert.equal(m.maybeCheckpointCache(), true, 'reaching the entries threshold via real deletions alone must trigger a checkpoint');
	await m.awaitInFlightCheckpoint(); // let the fire-and-forget save settle

	m.resetCheckpointCounters();
	assert.equal(m.maybeCheckpointCache(), false, 'nothing dirty right after reset');

	// Repeating the same 300 deletions again — the documented clearExpiredCache()/
	// reconcilePreloadedAgainstDiscovery() race, an already-gone, already-tombstoned path deleted
	// a second time — must not re-mark the cache dirty, since none of these tombstone baselines
	// actually change.
	for (let i = 0; i < 300; i++) {
		m.deleteCachedSessionData(`/file${i}.json`);
	}
	assert.equal(m.maybeCheckpointCache(), false,
		'300 repeated no-op tombstones of already-removed, already-tombstoned paths must not trigger a checkpoint');
});

// ---------------------------------------------------------------------------
// Round-8 review finding #1: a leader refresh cycle that parses files but throws before ever
// reaching persistRefreshResult() (and before a periodic mid-parse checkpoint fires) leaves
// genuinely dirty, unpersisted entries in the cache. The old _runRefreshCore() called
// resetCheckpointCounters() unconditionally at the top of the *next* leader cycle, zeroing that
// dirty count while the underlying data was still only in memory — a cache-hit-only next cycle
// would then never checkpoint it again. The fix (flushPendingCheckpointBeforeReset() in
// extension.ts) must flush first, and only reset once nothing is left dirty.
// ---------------------------------------------------------------------------

test('forceCheckpointCache() flushes pending dirty entries from a previous, uncheckpointed cycle before counters are reset', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);

	// Simulate a leader cycle that parsed files (dirty entries) but crashed/threw before
	// persistRefreshResult() or a periodic checkpoint ever ran — the data exists only in memory.
	m.setCachedSessionData('/a.json', entry(1000), 10);
	m.setCachedSessionData('/b.json', entry(2000), 10);
	assert.equal(m.hasUnflushedCheckpointWork(), true, 'the failed cycle left dirty, unpersisted entries behind');

	// This is the fix's own sequence, as _runRefreshCore() now runs it via
	// flushPendingCheckpointBeforeReset() before ever calling resetCheckpointCounters().
	await m.awaitInFlightCheckpoint(); // nothing in flight yet on a fresh manager — a no-op
	if (m.hasUnflushedCheckpointWork()) {
		await m.forceCheckpointCache();
	}
	assert.equal(m.hasUnflushedCheckpointWork(), false, 'forceCheckpointCache() must fully flush the pending work');

	const entries = await m.readSharedSnapshot();
	assert.ok(entries, 'the previous cycle\'s parsed data must have reached disk before the counters are reset');
	assert.equal(Object.keys(entries!).length, 2);

	// Only safe to reset once nothing dirty remains — and here it genuinely doesn't, because it
	// was flushed first rather than silently discarded.
	m.resetCheckpointCounters();
	assert.equal(m.maybeCheckpointCache(), false, 'nothing dirty right after reset, because it was actually flushed rather than dropped');
});

test('when the flush itself fails (e.g. another window holds the cache lock), the dirty entries stay tracked instead of being silently dropped', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);

	// Simulate another window holding the cache save lock: same PID (so checkOwnerAlive treats it
	// as alive) but a different sessionId (so this manager does not recognize it as its own), with
	// a fresh timestamp so it isn't treated as stale either.
	fs.writeFileSync(m.getCacheLockPath(), JSON.stringify({ sessionId: 'other-window', pid: process.pid, timestamp: Date.now() }));

	await m.forceCheckpointCache();
	assert.equal(m.hasUnflushedCheckpointWork(), true,
		'a flush that could not acquire the lock must leave the dirty entries tracked, not silently dropped — the caller must not reset the counters in this case');
});

// ---------------------------------------------------------------------------
// Round-8 review finding #2: clearCache() deletes the shared on-disk snapshot after clearing the
// in-memory cache. If a checkpoint's writeSharedSnapshot() is already mid-flight at that moment —
// built from on-disk/in-memory state read *before* the clear — its write could complete after the
// delete and resurrect the data the clear just removed. writeSharedSnapshot() now aborts once it
// notices clearAllCachedData() bumped the clear generation since it started reading, and
// clearCache() now awaits any in-flight checkpoint before deleting so its own delete always lands
// last regardless of exactly when the abort check fires.
// ---------------------------------------------------------------------------

test('writeSharedSnapshot() aborts instead of persisting when clearAllCachedData() runs mid-write', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	m.setCachedSessionData('/b.json', entry(2000), 10);

	const originalReadFile = fs.promises.readFile;
	let intercepted = false;
	(fs.promises as any).readFile = async (...args: unknown[]) => {
		const result = await (originalReadFile as (...a: unknown[]) => Promise<unknown>).apply(fs.promises, args);
		// Simulate clearCache() landing exactly while this checkpoint is reading the on-disk
		// snapshot it's about to merge with — a real interleaving, not just a contrived ordering.
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			m.clearAllCachedData();
		}
		return result;
	};
	let persisted: boolean;
	try {
		persisted = await m.writeSharedSnapshot();
	} finally {
		(fs.promises as any).readFile = originalReadFile;
	}
	assert.equal(persisted, false, 'a write racing a concurrent clear must abort rather than persist stale, pre-clear data');
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');

	const entries = await m.readSharedSnapshot();
	assert.ok(!entries || !('/b.json' in entries), 'the cleared cache must not be resurrected with data captured before the clear');
});

// A follow-up Copilot review found that checkClearEpoch() (the cross-window counterpart to
// clearAllCachedData() above) dropped the in-memory cache and adopted the new epoch, but never
// bumped cacheClearGeneration — so an in-flight writeSharedSnapshot() that had already passed its
// own first checkClearEpoch() check, and is now mid-buildMergedSnapshotEntries(), would find its
// own local clearEpoch already caught up by the time it re-checks, see no NEW clear, and still
// abort-check only against an unchanged generation. checkClearEpoch() now bumps the same
// generation counter, so this race aborts the same way the same-window one above does.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail)
// rather than a manual monkeypatch-plus-try/finally, so the patch cannot leak into another test.
test('writeSharedSnapshot() aborts when checkClearEpoch() detects a peer clear mid-write, via the generation bump', async (t) => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot(); // publish once, so there is pre-clear content on disk to resurrect

	m.setCachedSessionData('/b.json', entry(2000), 10);

	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		const result = await originalReadFile(...args);
		// Simulate a peer window's clear landing, and a concurrent task on this same instance (e.g.
		// loadSharedSnapshotIfChanged() on its own refresh timer) noticing it via checkClearEpoch(),
		// exactly while this write is reading the on-disk snapshot it's about to merge with.
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			const peer = makeManager(dir);
			await peer.deleteSharedSnapshot();
			await m.loadSharedSnapshotIfChanged();
		}
		return result;
	});
	const persisted = await m.writeSharedSnapshot();
	assert.equal(persisted, false,
		'a write racing a concurrently-detected peer clear must abort rather than resurrect pre-clear data');
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');

	const entries = await m.readSharedSnapshot();
	assert.ok(!entries || !('/a.json' in entries),
		'the peer\'s clear must not be undone by a write that only learned of it through the generation bump, not its own epoch check');
});

// A further Copilot review found the pre-rename check combined the generation comparison and the
// epoch check into one `a || await b()`: the synchronous generation comparison ran and evaluated
// false *before* the await for checkClearEpoch() even started, so a same-process clear landing during
// that await (which only bumps the generation — the durable epoch marker is untouched) was invisible
// by the time the comparison had already run. Fixed by awaiting checkClearEpoch() unconditionally
// first and comparing the generation synchronously right after, closing the gap.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('writeSharedSnapshot() catches a same-process clear landing during its own pre-rename epoch check', async (t) => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);

	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let epochReadCount = 0;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		if (String(args[0]).endsWith('.epoch.json')) {
			epochReadCount++;
			// The second epoch read is the pre-rename check (the first is the top-of-function one).
			// Simulate this window's own clearCache() landing exactly during that read.
			if (epochReadCount === 2) {
				m.clearAllCachedData();
			}
		}
		return originalReadFile(...args);
	});

	const persisted = await m.writeSharedSnapshot();
	assert.equal(epochReadCount, 2, 'the interception must have targeted the pre-rename epoch check for this assertion to be meaningful');
	assert.equal(persisted, false, 'a write racing its own pre-rename clear must abort rather than persist stale, pre-clear data');

	const entries = await m.readSharedSnapshot();
	assert.ok(!entries || !('/a.json' in entries), 'the clear must not be undone by a write whose generation check ran before the clear, not after');
});

// The same review also found bumpClearEpochLocked()'s monotonic floor only used the freshly-read
// `persisted` value, not this window's own already-known `clearEpoch` — so a corrupt/missing marker
// (readClearEpoch() fails open to 0) combined with a backward clock step could write a regressing
// epoch that a peer who already observed the higher value would fail to recognize as new.
test('bumpClearEpochLocked() floors on the local epoch too, so a corrupt marker plus a backward clock cannot regress it', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);

	await m.deleteSharedSnapshot();
	const firstEpoch = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;

	// Corrupt the marker so the next read fails open to 0, and force the clock backward below the
	// already-known epoch — the compound condition the fix targets.
	fs.writeFileSync(m.getClearEpochPath(), 'not json');
	const originalNow = Date.now;
	Date.now = () => 1;
	try {
		await m.deleteSharedSnapshot();
	} finally {
		Date.now = originalNow;
	}

	const secondEpoch = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;
	assert.ok(secondEpoch > firstEpoch,
		`a corrupt marker plus a backward clock must still floor on this window's own already-known epoch (${firstEpoch}), not regress to ${secondEpoch}`);
});

// A further Copilot review found bumpClearEpochLocked() adopted `newEpoch` into `this.clearEpoch`
// even when the marker write/rename failed and was only logged as a warning. If a later peer's real,
// successful clear computes that exact same `persisted + 1` value — routine whenever two clears land
// close together, which is the whole reason the floor exists — this window's checkClearEpoch() would
// see `persisted <= this.clearEpoch` and wrongly conclude nothing new happened, letting a later
// writeSharedSnapshot() resurrect pre-clear data right past the peer's real clear.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail) for the
// write interception, and the same Date.now() backward-clock forcing as the floor test above to make
// the "two clears compute the identical value" collision deterministic rather than timing-dependent.
test('bumpClearEpochLocked() leaves the local epoch untouched on a write failure, so a peer clear computing the same value is still detected', async (t) => {
	const dir = tmpDir();
	const m = makeManager(dir);

	await m.deleteSharedSnapshot(); // establish a real, persisted baseline epoch
	const baseline = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;

	const originalWriteFile = fs.promises.writeFile.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'writeFile', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).includes('.epoch.json.')) {
			intercepted = true;
			throw new Error('simulated disk failure');
		}
		return originalWriteFile(...args);
	});

	const originalNow = Date.now;
	Date.now = () => 1;
	try {
		m.setCachedSessionData('/a.json', entry(1000), 10);
		await m.deleteSharedSnapshot(); // epoch write fails; must not adopt the value it failed to persist
		assert.ok(intercepted, 'the write interception must actually have fired for this assertion to be meaningful');
		assert.equal(JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch, baseline,
			'a failed write must leave the on-disk epoch at its last successfully-persisted value');

		// A peer, with no knowledge of m's failed write, does a genuine, unrelated clear that computes
		// the exact same value m's failed write would have produced.
		const peer = makeManager(dir);
		await peer.deleteSharedSnapshot();
		const peerEpoch = JSON.parse(fs.readFileSync(peer.getClearEpochPath(), 'utf-8')).epoch;
		assert.ok(peerEpoch > baseline,
			'the peer\'s real clear must actually advance the persisted epoch for this test to be meaningful');

		const persisted = await m.writeSharedSnapshot();
		assert.equal(persisted, false,
			'm must still recognize the peer\'s real clear and refuse to republish pre-clear data, not silently treat a phantom locally-adopted epoch as already caught up');
	} finally {
		Date.now = originalNow;
	}
});

// A further Copilot review found deleteSharedSnapshot() reported unconditional success (a resolved
// `Promise<void>`) even when the epoch marker write failed — the on-disk snapshot was still deleted
// for this window, but with no durable record of the clear at all, no peer (and not even this window
// after a restart) has any way to learn it happened, defeating the cross-window fence entirely on a
// disk failure. Fixed by having deleteSharedSnapshot() (via bumpClearEpochLocked()) return whether the
// marker was actually persisted, so a caller like clearCache() can tell a fully durable clear apart
// from one that only cleared this window's own memory and warn instead of silently claiming success.
test('deleteSharedSnapshot() reports false, not unconditional success, when the epoch marker write fails', async (t) => {
	const dir = tmpDir();
	const m = makeManager(dir);

	const originalWriteFile = fs.promises.writeFile.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'writeFile', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).includes('.epoch.json.')) {
			intercepted = true;
			throw new Error('simulated disk failure');
		}
		return originalWriteFile(...args);
	});

	const persisted = await m.deleteSharedSnapshot();
	assert.ok(intercepted, 'the write interception must actually have fired for this assertion to be meaningful');
	assert.equal(persisted, false,
		'a failed epoch write must be reported to the caller, not silently treated as a successful clear');
});

// A further Copilot review found that when unlinking the snapshot fails for a genuine (non-ENOENT)
// reason, deleteSharedSnapshot() still advanced the epoch and reported success — but the pre-clear
// snapshot is still fully present on disk. A peer would then detect the epoch, reset its own mtime
// bookmark to 0, and its very next loadSharedSnapshotIfChanged() would immediately reload that
// still-present stale snapshot, resurrecting exactly the data this clear was meant to remove — a
// deterministic failure mode, not just a race. Fixed by skipping the epoch bump entirely when the
// unlink genuinely fails, so this clear attempt goes unrecorded to peers instead of misleadingly
// recorded as having succeeded. A later fix added a replace-with-empty fallback for exactly this
// failure (a failed unlink is often a transient file lock, which a tmp-file + rename can still get
// past), so this test also fails that fallback to keep exercising the "nothing worked" path.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('deleteSharedSnapshot() does not advance the epoch when unlinking AND the empty-replace fallback both genuinely fail, so a peer does not reload the still-present stale snapshot', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot();

	// A peer that has already loaded the pre-clear snapshot, so it is fully caught up before m's
	// failed clear attempt below — the state that would be wrongly disturbed by a phantom epoch bump.
	const peer = makeManager(dir);
	const initialMerge = await peer.loadSharedSnapshotIfChanged();
	assert.equal(initialMerge, 1, 'the peer must have actually loaded the snapshot for this test to be meaningful');

	const m = makeManager(dir);
	const originalUnlink = fs.promises.unlink.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'unlink', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			const err = new Error('simulated permission failure') as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}
		return originalUnlink(...args);
	});
	const originalWriteFile = fs.promises.writeFile.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	t.mock.method(fs.promises as any, 'writeFile', async (...args: unknown[]) => {
		if (String(args[0]).includes('.snapshot.json.')) {
			throw new Error('simulated disk failure for the empty-replace fallback too');
		}
		return originalWriteFile(...args);
	});

	const persisted = await m.deleteSharedSnapshot();
	assert.ok(intercepted, 'the unlink interception must actually have fired for this assertion to be meaningful');
	assert.equal(persisted, false,
		'a failed snapshot delete must be reported to the caller, not silently treated as a successful clear');
	assert.ok(fs.existsSync(m.getSharedSnapshotPath()),
		'the pre-clear snapshot must genuinely still be on disk for this test to be meaningful');
	assert.ok(!fs.existsSync(m.getClearEpochPath()),
		'a failed snapshot delete must not advance the epoch at all — doing so would tell peers a clear happened while the stale snapshot is still fully present');

	const mergedAfter = await peer.loadSharedSnapshotIfChanged();
	assert.equal(mergedAfter, 0,
		'the peer must not detect a clear (the epoch never advanced) and so must not reload the still-present pre-clear snapshot');
	assert.ok(peer.cache.has('/a.json'), 'the peer\'s already-loaded cache must be undisturbed by the failed clear attempt');
});

// A further Copilot review found that a failed snapshot delete, even after the fix above stops it
// from misleading peers, could still resurrect the pre-clear data in THIS SAME window: clearCache()'s
// very next step after deleteSharedSnapshot() returns is a refresh that calls
// loadSharedSnapshotIfChanged(), and if this window had never loaded the snapshot itself (mtime
// bookmark still at its initial value — e.g. the file appeared from a peer after this window
// started), that load would see the still-present file's mtime as new and merge the exact content
// clearAllCachedData() just emptied straight back in. No peer required — a single window hitting a
// transient unlink failure is enough. Also fails the later empty-replace fallback, to keep exercising
// the "nothing worked" path that still bookmarks the mtime.
test('deleteSharedSnapshot() bookmarks the still-present snapshot when unlinking AND the empty-replace fallback both fail, so this window\'s own next load does not resurrect it either', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot();

	// m never loads the snapshot itself before attempting the clear — its mtime bookmark starts at
	// 0, exactly the "never bookmarked yet" case the finding describes.
	const m = makeManager(dir);
	const originalUnlink = fs.promises.unlink.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'unlink', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			const err = new Error('simulated permission failure') as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}
		return originalUnlink(...args);
	});
	const originalWriteFile = fs.promises.writeFile.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	t.mock.method(fs.promises as any, 'writeFile', async (...args: unknown[]) => {
		if (String(args[0]).includes('.snapshot.json.')) {
			throw new Error('simulated disk failure for the empty-replace fallback too');
		}
		return originalWriteFile(...args);
	});

	const persisted = await m.deleteSharedSnapshot();
	assert.ok(intercepted, 'the unlink interception must actually have fired for this assertion to be meaningful');
	assert.equal(persisted, false, 'a failed snapshot delete must still be reported as not durable');

	const mergedAfter = await m.loadSharedSnapshotIfChanged();
	assert.equal(mergedAfter, 0,
		'this window\'s own next load must not treat the still-present, unchanged snapshot as newly-arrived content');
	assert.ok(!m.cache.has('/a.json'),
		'the cache clearAllCachedData() would have emptied must stay empty, not be resurrected by this window\'s own post-clear refresh');
});

// The early `return false` when neither the unlink nor the empty-replace fallback lands must still
// run deleteSharedSnapshot()'s completion bookkeeping. If it skipped the clearInProgressCount
// decrement, the clearAllCachedData() paired with it would stay "in progress" forever and every
// later writeSharedSnapshot() on this instance would silently abort.
test('deleteSharedSnapshot() still ends the in-progress clear when unlinking AND the empty-replace fallback both fail, so later writes are not wedged', async (t) => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	const originalUnlink = fs.promises.unlink.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'unlink', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			const err = new Error('simulated permission failure') as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}
		return originalUnlink(...args);
	});
	const originalWriteFile = fs.promises.writeFile.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	t.mock.method(fs.promises as any, 'writeFile', async (...args: unknown[]) => {
		if (String(args[0]).includes('.snapshot.json.')) {
			throw new Error('simulated disk failure for the empty-replace fallback too');
		}
		return originalWriteFile(...args);
	});

	m.clearAllCachedData();
	const cleared = await m.deleteSharedSnapshot();
	assert.ok(intercepted, 'the unlink interception must actually have fired for this assertion to be meaningful');
	assert.equal(cleared, false, 'the clear itself must still be reported as not durable');

	t.mock.restoreAll();
	m.setCachedSessionData('/b.json', entry(2000), 10);
	const persisted = await m.writeSharedSnapshot();
	assert.equal(persisted, true,
		'a failed clear must still release clearInProgress, or every later write on this instance aborts');
});

// A further Copilot review found a failed unlink could leave the pre-clear snapshot's entries
// mergeable back into a later write (buildMergedSnapshotEntries() reads whatever is still on disk).
// Fixed with a replace-with-empty fallback: a failed unlink is often a transient file lock (e.g.
// Windows holding a read handle open) rather than a genuine permissions failure, and the same
// tmp-file + rename pattern writeSharedSnapshot() already uses to publish can still land here, since
// it only needs to replace the directory entry, not touch whatever is holding the original open. When
// this fallback succeeds, the clear is fully durable — same as a normal successful unlink.
test('deleteSharedSnapshot() falls back to replacing the snapshot with an empty one when the direct unlink fails, landing a fully durable clear', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot();

	const m = makeManager(dir);
	const originalUnlink = fs.promises.unlink.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'unlink', async (...args: unknown[]) => {
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			const err = new Error('simulated transient file lock') as NodeJS.ErrnoException;
			err.code = 'EBUSY';
			throw err;
		}
		return originalUnlink(...args);
	});

	const persisted = await m.deleteSharedSnapshot();
	assert.ok(intercepted, 'the unlink interception must actually have fired for this assertion to be meaningful');
	assert.equal(persisted, true,
		'a failed unlink whose empty-replace fallback succeeds must still be reported as a fully durable clear');

	const entries = await m.readSharedSnapshot();
	assert.ok(entries && Object.keys(entries).length === 0,
		'the on-disk snapshot must have been replaced with an empty one, not left with the pre-clear entry');
	assert.ok(fs.existsSync(m.getClearEpochPath()),
		'the epoch must have been advanced normally, since the clear landed durably via the fallback');

	const peer = makeManager(dir);
	const merged = await peer.loadSharedSnapshotIfChanged();
	assert.equal(merged, 0, 'a peer loading the replaced snapshot must not find the pre-clear entry to merge');
});

// A further Copilot review found that if the empty-replace fallback's own writeFile() succeeded but
// its rename() then failed, the catch handling that failure couldn't clean up the temp file it had
// just written — the path was scoped to the inner try, out of reach in the catch. Repeated Clear
// Cache failures under that exact condition would leave orphaned temp files accumulating in
// globalStorage. Fixed by hoisting the temp path out of the try so the catch can best-effort unlink
// it too, the same cleanup pattern every other tmp-file-plus-rename write in this file already has.
test('deleteSharedSnapshot() cleans up its own orphaned temp file when the empty-replace fallback\'s rename fails', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot();

	const m = makeManager(dir);
	const originalUnlink = fs.promises.unlink.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let unlinkIntercepted = false;
	t.mock.method(fs.promises as any, 'unlink', async (...args: unknown[]) => {
		if (!unlinkIntercepted && String(args[0]).endsWith('.snapshot.json')) {
			unlinkIntercepted = true;
			const err = new Error('simulated permission failure') as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}
		return originalUnlink(...args);
	});
	const originalRename = fs.promises.rename.bind(fs.promises) as (...a: unknown[]) => Promise<void>;
	let renameIntercepted = false;
	t.mock.method(fs.promises as any, 'rename', async (...args: unknown[]) => {
		if (!renameIntercepted && String(args[0]).includes('.snapshot.json.')) {
			renameIntercepted = true;
			throw new Error('simulated rename failure for the empty-replace fallback');
		}
		return originalRename(...args);
	});

	const persisted = await m.deleteSharedSnapshot();
	assert.ok(unlinkIntercepted && renameIntercepted,
		'both interceptions must actually have fired for this assertion to be meaningful');
	assert.equal(persisted, false, 'a failed replace-fallback rename must still be reported as not durable');

	const leftoverTmpFiles = fs.readdirSync(dir).filter(f => f.includes('.snapshot.json.') && f.endsWith('.tmp'));
	assert.deepEqual(leftoverTmpFiles, [],
		'a failed replace-fallback rename must not leave an orphaned temp file behind in globalStorage');
});

// A further Copilot review found checkClearEpoch() only invalidated CacheManager's own raw session
// cache — a caller with its own separate, generation-stamped derived caches (the extension's per-view
// stats) has no way to know a peer's clear was just detected, so it could keep serving statistics
// computed before that clear indefinitely, even though the underlying session cache was correctly
// dropped. Fixed by adding an optional onPeerClearDetected hook to CacheManagerDeps, invoked whenever
// checkClearEpoch() detects and drops a peer's clear.
test('checkClearEpoch() invokes onPeerClearDetected exactly when it detects a peer clear, not otherwise', async () => {
	const dir = tmpDir();
	let calls = 0;
	const m = makeManager(dir, 1, { onPeerClearDetected: () => { calls++; } });

	// No clear has happened yet: an ordinary load must not fire the hook.
	await m.loadSharedSnapshotIfChanged();
	assert.equal(calls, 0, 'the hook must not fire when nothing has actually cleared');

	const peer = makeManager(dir);
	await peer.deleteSharedSnapshot(); // a genuine peer clear

	await m.loadSharedSnapshotIfChanged(); // routes through checkClearEpoch()
	assert.equal(calls, 1, 'the hook must fire exactly once when a real peer clear is detected');

	// A second load with nothing new must not fire it again.
	await m.loadSharedSnapshotIfChanged();
	assert.equal(calls, 1, 'the hook must not fire again for a load that detects no further clear');
});

test('clearCache()-style sequence (clearAllCachedData + awaitInFlightCheckpoint + deleteSharedSnapshot) is not resurrected by a slow in-flight checkpoint', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);

	const originalWriteFile = fs.promises.writeFile;
	(fs.promises as any).writeFile = async (...args: unknown[]) => {
		// Simulate a slow disk write so the checkpoint is still mid-flight when the clear below runs.
		await new Promise(r => setTimeout(r, 30));
		return (originalWriteFile as (...a: unknown[]) => Promise<unknown>).apply(fs.promises, args);
	};

	try {
		assert.equal(m.maybeCheckpointCache(), true, 'a dirty write plus the always-elapsed time threshold must start a checkpoint');

		// Mirrors clearCache(): clear in-memory state, wait for the in-flight checkpoint to settle,
		// then delete the on-disk snapshot — in that order.
		m.clearAllCachedData();
		await m.awaitInFlightCheckpoint();
		await m.deleteSharedSnapshot();
	} finally {
		(fs.promises as any).writeFile = originalWriteFile;
	}

	const entries = await m.readSharedSnapshot();
	assert.ok(!entries, 'the cleared snapshot must not be resurrected by a checkpoint that was in flight when the clear ran');
	assert.equal(fs.existsSync(m.getSharedSnapshotPath()), false, 'the snapshot file must stay deleted');
});

// ---------------------------------------------------------------------------
// Follow-up review finding: persistRefreshResult() used to call trySaveCacheToStorage() directly,
// bypassing checkpoint accounting entirely — a fully successful end-of-refresh save left
// entriesSinceLastCheckpoint exactly as dirty as before it, so the *next* leader cycle's
// flushPendingCheckpointBeforeReset() saw stale dirty state and performed a redundant extra
// checkpoint read/merge/write before doing anything of its own. saveAndAccountForRefresh() (what
// persistRefreshResult() now calls) must leave nothing dirty behind a successful save.
// ---------------------------------------------------------------------------

test('saveAndAccountForRefresh() persists and fully clears the dirty counter, so the next cycle has nothing left to flush', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	m.setCachedSessionData('/b.json', entry(2000), 10);
	assert.equal(m.hasUnflushedCheckpointWork(), true, 'dirty before the refresh-end save');

	const saved = await m.saveAndAccountForRefresh();
	assert.equal(saved, true, 'an uncontended save must succeed');
	assert.equal(m.hasUnflushedCheckpointWork(), false,
		'a fully successful end-of-refresh save must leave nothing dirty — otherwise the next leader cycle redundantly re-checkpoints before it has parsed anything of its own');

	const entries = await m.readSharedSnapshot();
	assert.ok(entries && Object.keys(entries).length === 2, 'the data must actually have reached disk');
});

test('saveAndAccountForRefresh() leaves the dirty count intact when the save is skipped (lock contention)', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);

	fs.writeFileSync(m.getCacheLockPath(), JSON.stringify({ sessionId: 'other-window', pid: process.pid, timestamp: Date.now() }));

	const saved = await m.saveAndAccountForRefresh();
	assert.equal(saved, false, 'lock contention must be reported as not-saved');
	assert.equal(m.hasUnflushedCheckpointWork(), true, 'a skipped save must not be mistaken for a persisted one');
});

// ---------------------------------------------------------------------------
// Follow-up review findings: clearCache()'s previous protection (awaiting only this window's own
// in-flight *checkpoint* promise) missed two real writers — this window's own persistRefreshResult()
// save (which never went through that promise) and any other VS Code window's save entirely, since
// cacheClearGeneration lives only in this process's memory. deleteSharedSnapshot() now serializes
// on the shared cache lock file itself (with a bounded retry) before deleting, which every writer —
// in-process or cross-window — already holds for the small window between its read and its rename.
// ---------------------------------------------------------------------------

test('deleteSharedSnapshot() waits for a held cache lock (e.g. another window mid-write) before deleting, rather than racing it', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	// Simulate another window holding the cache lock while it's mid-write: same PID (so
	// checkOwnerAlive treats it as alive) but a different sessionId, with a fresh timestamp.
	fs.writeFileSync(m.getCacheLockPath(), JSON.stringify({ sessionId: 'other-window', pid: process.pid, timestamp: Date.now() }));

	const deletePromise = m.deleteSharedSnapshot();

	// Release the simulated peer's lock shortly after — well within deleteSharedSnapshot()'s
	// retry budget (10 x 50ms = 500ms) — to prove it actually waited rather than deleting
	// immediately alongside the "held" lock.
	await new Promise(r => setTimeout(r, 100));
	fs.unlinkSync(m.getCacheLockPath());

	await deletePromise;

	assert.equal(fs.existsSync(m.getSharedSnapshotPath()), false, 'the snapshot must be deleted once the lock was actually available');
	assert.equal(fs.existsSync(m.getCacheLockPath()), false, 'deleteSharedSnapshot() must release the lock it acquired');
});

test('deleteSharedSnapshot() proceeds anyway once its retry budget is spent against a permanently stuck lock', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	// A lock that is never released (simulating a genuinely stuck peer) must not hang "Clear
	// Cache" forever. A small retry budget here exercises the same give-up path as production's
	// 10s/100ms default without a real test waiting out the full 10 seconds.
	fs.writeFileSync(m.getCacheLockPath(), JSON.stringify({ sessionId: 'other-window', pid: process.pid, timestamp: Date.now() }));

	await m.deleteSharedSnapshot({ attempts: 3, delayMs: 5 });

	assert.equal(fs.existsSync(m.getSharedSnapshotPath()), false, 'the snapshot must still be deleted even without the lock, rather than leaving Clear Cache stuck');
});

// A further Copilot review found a gap neither the generation-baseline fix nor the epoch check can
// close on their own: clearAllCachedData() runs synchronously (bumping the generation immediately),
// but the durable epoch only advances later, inside deleteSharedSnapshot() — which can be stuck
// retrying for the cache lock for its whole retry budget (up to 10s in production) against a peer
// that holds it. A loader starting in exactly that window captures a baseline that already reflects
// the generation bump (nothing further changes it during the loader's own run), while the epoch has
// not advanced either — so the still-present, pre-clear on-disk snapshot can be read and merged
// straight back into the cache clearAllCachedData() just emptied. clearInProgress, true for exactly
// this window, is the third signal that closes it.
test('loadSharedSnapshotIfChanged() rejects a merge started while deleteSharedSnapshot() is still stuck on a peer lock', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot(); // pre-clear content stays on disk for the whole race below

	const m = makeManager(dir); // never loaded yet, so its own mtime bookmark starts at 0

	// Simulate a peer holding the cache lock, so deleteSharedSnapshot() below is stuck retrying —
	// it has not yet unlinked the snapshot or bumped the epoch by the time the load races it.
	fs.writeFileSync(m.getCacheLockPath(), JSON.stringify({ sessionId: 'other-window', pid: process.pid, timestamp: Date.now() }));

	m.clearAllCachedData(); // the first of clearCache()'s two calls
	const deletePromise = m.deleteSharedSnapshot({ attempts: 20, delayMs: 20 }); // ~400ms retry budget

	// A concurrent load lands squarely inside the gap: clearAllCachedData() already ran, but
	// deleteSharedSnapshot() has not yet unlinked the snapshot or bumped the epoch.
	const merged = await m.loadSharedSnapshotIfChanged();
	assert.equal(merged, 0, 'a load landing while the clear is still mid-flight must not report a stale merge as useful');
	assert.equal(m.cache.size, 0, 'the pre-clear snapshot must not be reinstated while the clear transition is still in progress');

	fs.unlinkSync(m.getCacheLockPath()); // let deleteSharedSnapshot() finish rather than exhaust its budget
	await deletePromise;
});

// A further Copilot review found writeSharedSnapshot() never checked clearInProgress at all: a save
// (e.g. a periodic checkpoint) whose baseline is captured after an external clearAllCachedData() has
// already landed, but while deleteSharedSnapshot() is still stuck on a peer's lock, sees no generation
// change and no epoch change either — the exact same shape of gap the two loaders were fixed against,
// just on the write side. Left unfixed, buildMergedSnapshotEntries() would read the still-present
// pre-clear on-disk snapshot and rename it right back, undoing the clear entirely.
test('writeSharedSnapshot() rejects a write started while deleteSharedSnapshot() is still stuck on a peer lock', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot(); // pre-clear content stays on disk for the whole race below

	const m = makeManager(dir);

	fs.writeFileSync(m.getCacheLockPath(), JSON.stringify({ sessionId: 'other-window', pid: process.pid, timestamp: Date.now() }));

	m.clearAllCachedData();
	const deletePromise = m.deleteSharedSnapshot({ attempts: 20, delayMs: 20 });

	// A concurrent checkpoint lands squarely inside the gap, same as the loader race above.
	m.setCachedSessionData('/b.json', entry(2000), 10);
	const persisted = await m.writeSharedSnapshot();
	assert.equal(persisted, false, 'a write started while the clear is still mid-flight must not persist');

	fs.unlinkSync(m.getCacheLockPath());
	await deletePromise;

	const entries = await m.readSharedSnapshot();
	assert.ok(!entries || !('/a.json' in entries), 'the clear must not be undone by a write that raced its still-in-progress transition');
});

// A further Copilot review found clearInProgress (then a plain boolean) could report "no clear in
// progress" while a *second*, overlapping clearCache() was still mid-flight: nothing today serializes
// concurrent clearCache() calls, so if the first deleteSharedSnapshot() finishes (setting the flag to
// false) while the second clearAllCachedData() has already run but its own deleteSharedSnapshot() is
// still stuck on the lock, a load landing in that instant would see clearInProgress as false and could
// merge stale data back in. A counter, decremented rather than reset, fixes this: it only returns to
// zero once every outstanding clearAllCachedData() has been matched by its own finished
// deleteSharedSnapshot().
test('clearInProgress reports true until every overlapping clearCache() sequence finishes, not just the first', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);

	// Two overlapping clearCache() sequences, as if the command fired twice in quick succession —
	// run sequentially here since the fix is about the counter's own bookkeeping, not about forcing a
	// specific interleaving of the underlying lock-retry mechanics (already covered elsewhere).
	m.clearAllCachedData();
	m.clearAllCachedData();
	await m.deleteSharedSnapshot(); // matches only the FIRST clearAllCachedData()

	// publisher's own epoch predates the real clear m's first deleteSharedSnapshot() just made, so its
	// first write after it is skipped and only resyncs it (the same "skipped once, resynced" pattern
	// used elsewhere in this file) — the second attempt is what actually lands content on disk that
	// a plain boolean would wrongly let the check below resurrect.
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot();
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot();

	// A plain boolean would already report "no clear in progress" here, even though the second
	// clearAllCachedData()'s own deleteSharedSnapshot() has not run yet — a load landing at this
	// instant would incorrectly be allowed to merge (neither the generation nor the epoch check
	// catches it either, since this same instance already caught up to both on its own first call).
	const merged = await m.loadSharedSnapshotIfChanged();
	assert.equal(merged, 0, 'a load landing between the two overlapping clears\' own deleteSharedSnapshot() calls must still be rejected');
	assert.equal(m.cache.size, 0, 'the content published while the second clear was still outstanding must not be merged in yet');

	await m.deleteSharedSnapshot(); // matches the SECOND clearAllCachedData() — bumps the epoch again

	// Published only now, after the whole transition has finished — publishing beforehand would just
	// get deleted by the second deleteSharedSnapshot() call above, same as the first snapshot was by
	// the first one. publisher's epoch is stale yet again (the second delete just advanced it further
	// than what publisher resynced to earlier), so it needs one more skip-and-resync round first.
	publisher.setCachedSessionData('/b.json', entry(2000), 10);
	await publisher.writeSharedSnapshot();
	publisher.setCachedSessionData('/b.json', entry(2000), 10);
	await publisher.writeSharedSnapshot();

	const mergedAfter = await m.loadSharedSnapshotIfChanged();
	assert.ok(mergedAfter > 0, 'once every outstanding clear has finished, a normal load must succeed again');
	assert.ok(m.cache.has('/b.json'), 'content published once the whole transition finished must load normally');
});

// A further Copilot review found clearInProgress is a *live* signal — true only while
// deleteSharedSnapshot() has not yet finished — so it cannot catch a load whose stat/read sequence
// straddles the exact moment that call completes: started while a clear was genuinely in flight (the
// generation baseline already reflects clearAllCachedData()'s bump), but by the time this load's own
// final check runs, deleteSharedSnapshot() has already finished and the counter is back to zero. The
// epoch check also sees nothing new, since this same instance already adopted the bump itself. Fixed
// by having deleteSharedSnapshot() bump cacheClearGeneration a second time on its own completion (in
// addition to clearAllCachedData()'s own bump), so a baseline captured before that completion is still
// caught by the existing generation-mismatch check every loader and writeSharedSnapshot() already runs.
// Uses t.mock.method() (auto-restored by the test runner when this test ends, pass or fail).
test('loadSharedSnapshotIfChanged() catches a clear whose deleteSharedSnapshot() completes entirely during this call\'s own read', async (t) => {
	const dir = tmpDir();
	const publisher = makeManager(dir);
	publisher.setCachedSessionData('/a.json', entry(1000), 10);
	await publisher.writeSharedSnapshot(); // pre-clear content on disk to (almost) resurrect

	const m = makeManager(dir);
	m.clearAllCachedData(); // this load's baseline will already reflect this bump

	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		const result = await originalReadFile(...args); // the stale read itself completes normally...
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			// ...but the rest of this window's own clearCache() sequence — deleteSharedSnapshot() —
			// finishes entirely before control returns to loadSharedSnapshotIfChanged()'s merge step.
			await m.deleteSharedSnapshot();
		}
		return result;
	});

	const merged = await m.loadSharedSnapshotIfChanged();
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');
	assert.equal(merged, 0, 'a load whose read raced a clear that finished before this call\'s own final check must not report a stale merge as useful');
	assert.equal(m.cache.size, 0, 'the pre-clear entry must not survive a clear that completed during this call\'s own read');
});

// Same race, on loadCacheFromStorage()'s own load path.
test('loadCacheFromStorage() catches a clear whose deleteSharedSnapshot() completes entirely during this call\'s own read', async (t) => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000), 10);
	await writer.writeSharedSnapshot();

	const m = makeManager(dir);
	m.clearAllCachedData();

	const originalReadFile = fs.promises.readFile.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
	let intercepted = false;
	t.mock.method(fs.promises as any, 'readFile', async (...args: unknown[]) => {
		const result = await originalReadFile(...args);
		if (!intercepted && String(args[0]).endsWith('.snapshot.json')) {
			intercepted = true;
			await m.deleteSharedSnapshot();
		}
		return result;
	});

	await m.loadCacheFromStorage();
	assert.ok(intercepted, 'the read interception must actually have fired for this assertion to be meaningful');
	assert.equal(m.cache.size, 0, 'the pre-clear snapshot must not be loaded on top of a clear that completed during this call\'s own read');
});

// A further Copilot review found readClearEpoch() accepted Number.MAX_SAFE_INTEGER as a valid epoch,
// but bumpClearEpochLocked() computes the next value as `persisted + 1` — at that exact boundary,
// float64 rounds the result back down to the same unsafe value it started from, so two consecutive
// clears from an exhausted/corrupted marker could write the identical "new" epoch, breaking the
// strictly-advancing guarantee this method exists to provide.
// A follow-up Copilot review found the first version of this fix could *regress* the epoch once
// exhausted (falling back to Date.now(), far smaller than Number.MAX_SAFE_INTEGER) — worse than the
// original bug, since a peer that already adopted the ceiling value into its own in-memory clearEpoch
// would then treat every subsequent real clear as old, not just the one that hit the boundary. There
// is no larger safe float64 integer to advance to once genuinely exhausted, so the fix now holds at
// the ceiling instead: a write that fails to advance further (the same narrow, already-accepted
// failure mode an unsafe-but-finite corrupt marker like `1e100` already had), never one that goes
// backward.
test('bumpClearEpochLocked() never regresses the epoch once exhausted at the Number.MAX_SAFE_INTEGER boundary', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);

	fs.mkdirSync(path.dirname(m.getClearEpochPath()), { recursive: true });
	fs.writeFileSync(m.getClearEpochPath(), JSON.stringify({ epoch: Number.MAX_SAFE_INTEGER }));

	await m.deleteSharedSnapshot();
	const first = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;
	assert.equal(first, Number.MAX_SAFE_INTEGER,
		'an exhausted marker must hold at the ceiling, not fall back to a smaller value a peer holding the ceiling would treat as old');

	await m.deleteSharedSnapshot();
	const second = JSON.parse(fs.readFileSync(m.getClearEpochPath(), 'utf-8')).epoch;
	assert.equal(second, Number.MAX_SAFE_INTEGER, 'a second clear from the same exhausted state must not regress it either');
});

// ---------------------------------------------------------------------------
// Follow-up review finding: clearAllCachedData() cleared sessionFileCache but left deletedFilePaths
// (tombstones from deletions decided *before* the clear) intact. A "Clear Cache" is meant to reset
// all cache state, deletion decisions included — a stale, pre-clear tombstone surviving the clear
// would otherwise keep stripping a path that some window legitimately republishes afterward at or
// below that old baseline mtime, exactly the "clear doesn't actually reset everything" bug.
// ---------------------------------------------------------------------------

test('clearAllCachedData() clears tombstones too, so a pre-clear deletion cannot keep stripping a path republished after the clear', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();
	m.deleteCachedSessionData('/a.json'); // tombstone baseline = mtime 1000, pre-clear

	m.clearAllCachedData();
	// Paired immediately, the same as clearCache()'s real call sequence: clearAllCachedData() alone
	// leaves clearInProgressCount permanently incremented (see its own doc comment), which would
	// otherwise make the writeSharedSnapshot() below silently abort every time — this test would then
	// keep passing for the wrong reason, since the '/a.json' entry asserted below would just be
	// leftover from the write before the clear, not proof the post-clear republish actually persisted.
	await m.deleteSharedSnapshot();

	// Some window (this one or another) republishes '/a.json' at or below the old tombstone's
	// baseline mtime — plausible after a clear, since the file on disk hasn't necessarily changed.
	m.setCachedSessionData('/a.json', entry(1000), 10);
	await m.writeSharedSnapshot();

	const entries = await m.readSharedSnapshot();
	assert.ok(entries && '/a.json' in entries,
		'a tombstone recorded before clearAllCachedData() must not survive it and strip a path republished afterward');
});

// A further Copilot review found clearAllCachedData() is a public method, and its own doc comment
// only says clearInProgressCount is "decremented again once deleteSharedSnapshot() ... finishes" —
// nothing stops a caller (a future feature wanting only an in-memory reset, or a test) from calling
// it standalone. Since only deleteSharedSnapshot() ever decrements the counter, such a call wedges
// it above zero permanently: every later writeSharedSnapshot() call on that instance aborts, and
// every later loadSharedSnapshotIfChanged()/loadCacheFromStorage() call wipes whatever it just
// merged, both silently (no exception, no log a caller would necessarily notice) and irrecoverably
// short of recreating the manager. This is accepted for now rather than fixed with a broader public
// API change (e.g. a single method guaranteeing the pairing) — clearCache(), the only production
// caller, already invokes these two back to back with no await in between, so the gap this test
// documents does not occur there today. See CHANGELOG.md's cross-window clear-epoch entry for the
// broader follow-up this still leaves open for any other caller.
test('clearAllCachedData() called standalone, without a paired deleteSharedSnapshot(), permanently wedges snapshot I/O', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);

	m.clearAllCachedData(); // no matching deleteSharedSnapshot() call follows

	m.setCachedSessionData('/b.json', entry(2000), 10);
	const persisted = await m.writeSharedSnapshot();
	assert.equal(persisted, false,
		'an unpaired clearAllCachedData() leaves clearInProgressCount stuck above zero, so every later write aborts');

	const other = makeManager(dir);
	other.setCachedSessionData('/c.json', entry(3000), 10);
	await other.writeSharedSnapshot();

	const merged = await m.loadSharedSnapshotIfChanged();
	assert.equal(merged, 0,
		'the same stuck counter also makes every later load report nothing merged, even once real content is on disk');
});

test('clearAllCachedData() resets the checkpoint dirty count too, so the next cycle does not redundantly checkpoint an empty cache', () => {
	const m = makeManager(tmpDir());
	m.setCachedSessionData('/a.json', entry(1000), 10);
	assert.equal(m.hasUnflushedCheckpointWork(), true, 'dirty before the clear');

	m.clearAllCachedData();

	assert.equal(m.hasUnflushedCheckpointWork(), false,
		'a clear must reset the dirty count along with the entries it was tracking — otherwise the next leader cycle sees stale dirty state and performs a full checkpoint save of the now-empty cache before parsing anything of its own');
});

// A follow-up Copilot review found that checkClearEpoch() — the cross-window counterpart to
// clearAllCachedData() above — dropped the in-memory cache but never reset the checkpoint dirty
// count, for the exact same reason the test above exists: the next leader cycle would otherwise see
// a stale positive count and force a redundant checkpoint write of the now-empty cache.
test('checkClearEpoch() resets the checkpoint dirty count too, on a detected peer clear', async () => {
	const dir = tmpDir();
	const m = makeManager(dir);
	m.setCachedSessionData('/a.json', entry(1000), 10);
	assert.equal(m.hasUnflushedCheckpointWork(), true, 'dirty before the peer clear is detected');

	const peer = makeManager(dir);
	await peer.deleteSharedSnapshot();

	await m.loadSharedSnapshotIfChanged(); // detects the peer's clear via checkClearEpoch()

	assert.equal(m.hasUnflushedCheckpointWork(), false,
		'a detected peer clear must reset the dirty count along with the entries it was tracking, the same as clearAllCachedData() does for this window\'s own clear');
});

test('loadCacheFromStorage: starts with an empty cache on a snapshot whose schema version does not match', async () => {
	const dir = tmpDir();
	const logs: string[] = [];
	const m = makeManager(dir);
	const snapshotPath = m.getSharedSnapshotPath();
	fs.writeFileSync(snapshotPath, JSON.stringify({
		schemaVersion: 999,
		cacheVersion: 1,
		cacheId: 'prod',
		generatedAt: Date.now(),
		entryCount: 1,
		entries: { '/a.json': entry(1000) },
	}));

	const reader = new CacheManager(
		{ extensionMode: 1, globalStorageUri: { fsPath: dir }, globalState: createMockMemento() } as any,
		{ log: (msg: string) => logs.push(msg), warn: () => {}, error: () => {} },
		1,
	);
	await reader.loadCacheFromStorage();

	assert.equal(reader.cache.size, 0, 'entries written under a different snapshot schema must not be loaded');
	assert.ok(logs.some(l => l.includes('Snapshot schema mismatch')), 'should log the schema mismatch');
});

test('loadCacheFromStorage: starts with an empty cache when the snapshot parses to a non-object', async () => {
	const dir = tmpDir();
	const logs: string[] = [];
	const m = makeManager(dir);
	fs.writeFileSync(m.getSharedSnapshotPath(), 'null');

	const reader = new CacheManager(
		{ extensionMode: 1, globalStorageUri: { fsPath: dir }, globalState: createMockMemento() } as any,
		{ log: (msg: string) => logs.push(msg), warn: () => {}, error: () => {} },
		1,
	);
	await reader.loadCacheFromStorage();

	assert.equal(reader.cache.size, 0, 'a non-object envelope must not produce any entries');
	assert.ok(logs.some(l => l.includes('No valid snapshot found')), 'should log the unusable envelope');
});

test('loadCacheFromStorage: a non-ENOENT read failure empties the cache instead of leaving stale entries behind', async () => {
	const dir = tmpDir();
	const errors: string[] = [];
	const m = makeManager(dir);
	// A directory where the snapshot file belongs makes readFile fail with something
	// other than ENOENT (EISDIR/EPERM), the branch that rethrows rather than treating
	// the snapshot as merely absent.
	fs.mkdirSync(m.getSharedSnapshotPath());

	const reader = new CacheManager(
		{ extensionMode: 1, globalStorageUri: { fsPath: dir }, globalState: createMockMemento() } as any,
		{ log: () => {}, warn: () => {}, error: (msg: string) => errors.push(msg) },
		1,
	);
	reader.setCachedSessionData('/stale.json', entry(1000), 10);
	await reader.loadCacheFromStorage();

	assert.equal(reader.cache.size, 0,
		'an unreadable snapshot must fall back to an empty cache, not keep whatever was already in memory');
	assert.ok(errors.some(e => e.includes('Error loading cache from storage')),
		'the read failure should surface through deps.error');
});

test('loadSharedSnapshotIfChanged: a full snapshot entry replaces a local details-only placeholder at equal mtime', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', entry(1000, 500), 10);
	await writer.writeSharedSnapshot();

	const reader = makeManager(dir);
	reader.setCachedSessionData('/a.json', { ...entry(1000, 0), detailsOnly: true }, 10);
	const merged = await reader.loadSharedSnapshotIfChanged();
	assert.equal(merged, 1);
	assert.equal(reader.cache.get('/a.json')?.tokens, 500);
	assert.equal(reader.cache.get('/a.json')?.detailsOnly, undefined);
});

test('loadSharedSnapshotIfChanged: a snapshot placeholder does not replace a local full entry at equal mtime', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', { ...entry(1000, 0), detailsOnly: true }, 10);
	await writer.writeSharedSnapshot();

	const reader = makeManager(dir);
	reader.setCachedSessionData('/a.json', entry(1000, 500), 10);
	await reader.loadSharedSnapshotIfChanged();
	assert.equal(reader.cache.get('/a.json')?.tokens, 500);
});

test('writeSharedSnapshot: a details-only placeholder does not overwrite a full on-disk entry at equal mtime, and a full entry replaces a placeholder', async () => {
	const dir = tmpDir();
	const full = makeManager(dir);
	full.setCachedSessionData('/a.json', entry(1000, 500), 10);
	await full.writeSharedSnapshot();

	const other = makeManager(dir);
	other.setCachedSessionData('/a.json', { ...entry(1000, 0), detailsOnly: true }, 10);
	await other.writeSharedSnapshot();
	assert.equal((await other.readSharedSnapshot())!['/a.json'].tokens, 500);

	const dir2 = tmpDir();
	const ph = makeManager(dir2);
	ph.setCachedSessionData('/a.json', { ...entry(1000, 0), detailsOnly: true }, 10);
	await ph.writeSharedSnapshot();
	const fullWriter = makeManager(dir2);
	fullWriter.setCachedSessionData('/a.json', entry(1000, 500), 10);
	await fullWriter.writeSharedSnapshot();
	const onDisk = (await fullWriter.readSharedSnapshot())!['/a.json'];
	assert.equal(onDisk.tokens, 500);
	assert.equal(onDisk.detailsOnly, undefined);
});

test('equal-mtime placeholder precedence requires a matching size', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', { ...entry(1000, 500), size: 10 }, 10);
	await writer.writeSharedSnapshot();

	// Local placeholder for the same mtime but a different size: the file changed, so the stale
	// full snapshot entry must not replace it.
	const reader = makeManager(dir);
	reader.setCachedSessionData('/a.json', { ...entry(1000, 0), size: 20, detailsOnly: true }, 20);
	await reader.loadSharedSnapshotIfChanged();
	assert.equal(reader.cache.get('/a.json')?.detailsOnly, true);

	// Write side: a different-size placeholder must replace the stale full on-disk entry.
	await reader.writeSharedSnapshot();
	assert.equal((await reader.readSharedSnapshot())!['/a.json'].detailsOnly, true);
});

test('a full entry replacing a same-version placeholder keeps the placeholder repository metadata', async () => {
	const dir = tmpDir();
	const writer = makeManager(dir);
	writer.setCachedSessionData('/a.json', { ...entry(1000, 500) }, 10);
	await writer.writeSharedSnapshot();

	const reader = makeManager(dir);
	reader.setCachedSessionData('/a.json', { ...entry(1000, 0), detailsOnly: true, repository: 'https://example/repo.git', repositoryResolved: true }, 10);
	await reader.loadSharedSnapshotIfChanged();
	const got = reader.cache.get('/a.json');
	assert.equal(got?.tokens, 500);
	assert.equal(got?.detailsOnly, undefined);
	assert.equal(got?.repository, 'https://example/repo.git');
	assert.equal(got?.repositoryResolved, true);

	// Write side: in-memory full entry over an on-disk placeholder.
	const dir2 = tmpDir();
	const ph = makeManager(dir2);
	ph.setCachedSessionData('/a.json', { ...entry(1000, 0), detailsOnly: true, repository: 'r', repositoryResolved: true }, 10);
	await ph.writeSharedSnapshot();
	const fw = makeManager(dir2);
	fw.setCachedSessionData('/a.json', entry(1000, 500), 10);
	await fw.writeSharedSnapshot();
	const onDisk = (await fw.readSharedSnapshot())!['/a.json'];
	assert.equal(onDisk.tokens, 500);
	assert.equal(onDisk.repository, 'r');
	assert.equal(onDisk.repositoryResolved, true);
});
