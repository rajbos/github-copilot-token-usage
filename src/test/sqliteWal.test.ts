import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	MAX_WAL_MERGE_DB_SIZE_BYTES,
	isWalWriterActive,
	tryReadDbWithWal,
	tryReadDbWithWalFingerprint,
	readDbBufferWithWalFingerprint,
	sweepStaleWalTempFiles,
	walMergeCacheSizeForTests,
	walMergeCacheHasEntryForTests,
	WAL_MERGE_MIN_INTERVAL_MS,
	WAL_MERGE_WRITER_ACTIVE_INTERVAL_MS,
	WRITER_ACTIVE_WAL_RECENCY_MS,
	setNodeSqliteLoaderForTests,
} from '../utils/sqliteWal';

/**
 * Creates a real WAL-mode sqlite fixture using node:sqlite directly (Node 22+, same runtime the
 * extension ships on). Returns the still-open writer connection so callers can insert rows that
 * stay pending in the `-wal` file.
 */
function createWalFixture() {
	const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-fixture-'));
	const dbPath = path.join(tmpDir, 'test.db');
	const writer = new DatabaseSync(dbPath);
	writer.exec('PRAGMA journal_mode=WAL;');
	writer.exec('CREATE TABLE t (v TEXT);');
	writer.exec("INSERT INTO t VALUES ('seed')");
	return {
		tmpDir,
		dbPath,
		writer,
		cleanup: () => {
			try { writer.close(); } catch { /* ignore */ }
			fs.rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

test('tryReadDbWithWal refuses to copy a database above the size cap, returning null', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-oversized-'));
	const dbPath = path.join(tmpDir, 'huge.db');
	const walPath = dbPath + '-wal';
	try {
		// A sparse file reports the requested size via fs.stat without writing real bytes to disk.
		const fd = fs.openSync(dbPath, 'w');
		fs.ftruncateSync(fd, MAX_WAL_MERGE_DB_SIZE_BYTES + 1024);
		fs.closeSync(fd);
		fs.writeFileSync(walPath, 'not empty so the WAL-present check passes');

		const result = await tryReadDbWithWal(dbPath);

		assert.equal(result, null, 'a db above MAX_WAL_MERGE_DB_SIZE_BYTES must never be copied');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('tryReadDbWithWal throttles repeated merge attempts for the same db path', async () => {
	const fixture = createWalFixture();
	try {
		const first = await tryReadDbWithWal(fixture.dbPath);
		assert.ok(first, 'first call should merge and return a buffer');

		// Keep changing the WAL so a naive implementation would see "new work" every time.
		fixture.writer.exec("INSERT INTO t VALUES ('more-1')");
		const second = await tryReadDbWithWal(fixture.dbPath);
		fixture.writer.exec("INSERT INTO t VALUES ('more-2')");
		const third = await tryReadDbWithWal(fixture.dbPath);

		// Within the throttle window, the cached buffer is served — no new merge is attempted,
		// so all three calls return the exact same Buffer instance.
		assert.equal(second, first, 'second call within the throttle window must reuse the cached result');
		assert.equal(third, first, 'third call within the throttle window must reuse the cached result');
	} finally {
		fixture.cleanup();
	}
});

test('isWalWriterActive: shm present and wal touched recently => active', () => {
	const fixture = createWalFixture();
	try {
		fixture.writer.exec("INSERT INTO t VALUES ('touch')");
		assert.ok(fs.existsSync(fixture.dbPath + '-shm'), 'fixture setup: -shm should exist while the writer is open');

		assert.equal(isWalWriterActive(fixture.dbPath), true);
	} finally {
		fixture.cleanup();
	}
});

test('isWalWriterActive: no shm file => not active', () => {
	// Built from plain files rather than by deleting a live connection's -shm: SQLite holds that
	// file open, and while POSIX happily unlinks an open file, Windows either refuses the delete
	// or leaves it pending until the handle closes — so existsSync still sees it and the check
	// reports "active". That made this test pass on Linux/macOS and fail intermittently on
	// Windows. No live handle, no race, and the scenario under test is unchanged.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-noshm-'));
	try {
		const dbPath = path.join(tmpDir, 'test.db');
		fs.writeFileSync(dbPath, 'db');
		fs.writeFileSync(dbPath + '-wal', 'recent wal frames'); // recent mtime, so only the missing -shm decides
		assert.equal(fs.existsSync(dbPath + '-shm'), false, 'fixture setup: no -shm should exist');

		assert.equal(isWalWriterActive(dbPath), false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('isWalWriterActive: shm present but wal mtime is old => not active', () => {
	// Plain files for the same reason as the test above: back-dating the -wal of a live writer
	// races SQLite, which can touch the file again at any point.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-oldwal-'));
	try {
		const dbPath = path.join(tmpDir, 'test.db');
		fs.writeFileSync(dbPath, 'db');
		fs.writeFileSync(dbPath + '-wal', 'stale wal frames');
		fs.writeFileSync(dbPath + '-shm', 'shm'); // present, so only the stale -wal mtime decides
		const oldDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
		fs.utimesSync(dbPath + '-wal', oldDate, oldDate);

		assert.equal(isWalWriterActive(dbPath), false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('isWalWriterActive: no -wal file at all => not active', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-nowal-'));
	try {
		const dbPath = path.join(tmpDir, 'plain.db');
		fs.writeFileSync(dbPath, 'not wal mode');
		assert.equal(isWalWriterActive(dbPath), false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('sweepStaleWalTempFiles removes old matching files and leaves recent or non-matching files alone', async () => {
	const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-sweep-a-'));
	const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-sweep-b-'));
	try {
		const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

		const oldCursorFile = path.join(dirA, 'cursor-wal-12345-old.db');
		fs.writeFileSync(oldCursorFile, 'old');
		fs.utimesSync(oldCursorFile, oldDate, oldDate);

		const oldSqliteFile = path.join(dirB, 'sqlite-wal-state.vscdb-99-old.db-wal');
		fs.writeFileSync(oldSqliteFile, 'old');
		fs.utimesSync(oldSqliteFile, oldDate, oldDate);

		const recentMatchingFile = path.join(dirA, 'cursor-wal-99999-recent.db');
		fs.writeFileSync(recentMatchingFile, 'recent');

		const nonMatchingOldFile = path.join(dirA, 'some-other-file.db');
		fs.writeFileSync(nonMatchingOldFile, 'unrelated');
		fs.utimesSync(nonMatchingOldFile, oldDate, oldDate);

		const removed = await sweepStaleWalTempFiles(60 * 60 * 1000, [
			{ dir: dirA, prefixes: ['cursor-wal-'] },
			{ dir: dirB, prefixes: ['sqlite-wal-'] },
		]);

		assert.equal(removed, 2, 'exactly the two old, prefix-matching files should be removed');
		assert.equal(fs.existsSync(oldCursorFile), false, 'old cursor-wal- file should be gone');
		assert.equal(fs.existsSync(oldSqliteFile), false, 'old sqlite-wal- file should be gone');
		assert.equal(fs.existsSync(recentMatchingFile), true, 'recent matching file should be left alone');
		assert.equal(fs.existsSync(nonMatchingOldFile), true, 'old but non-matching file should be left alone');
	} finally {
		fs.rmSync(dirA, { recursive: true, force: true });
		fs.rmSync(dirB, { recursive: true, force: true });
	}
});

test('sweepStaleWalTempFiles tolerates a missing directory', async () => {
	const missingDir = path.join(os.tmpdir(), `sqlitewal-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const removed = await sweepStaleWalTempFiles(60 * 60 * 1000, [{ dir: missingDir, prefixes: ['cursor-wal-'] }]);
	assert.equal(removed, 0);
});

test('sweepStaleWalTempFiles only sweeps a directory for ITS OWN assigned prefix, never the other directory\'s prefix (Fix 4)', async () => {
	// os.tmpdir() has only ever leaked cursor-wal-* (see #2033); sqlite-wal-* has only ever been
	// written under ~/.copilot/tmp (see performWalMerge). Both directories are shared with other
	// applications, so sweeping a plausible-but-foreign prefix out of either one risks deleting a
	// file that belongs to something else entirely — this must not happen in either direction.
	const tmpdirRole = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-sweep-tmpdir-role-'));
	const copilotTmpRole = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-sweep-copilot-role-'));
	try {
		const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
		const makeOld = (dir: string, name: string) => {
			const p = path.join(dir, name);
			fs.writeFileSync(p, 'old');
			fs.utimesSync(p, oldDate, oldDate);
			return p;
		};

		// The correct case for each directory's own prefix: removed.
		const ownCursorFile = makeOld(tmpdirRole, 'cursor-wal-own-old.db');
		const ownSqliteFile = makeOld(copilotTmpRole, 'sqlite-wal-own-old.db');

		// The foreign-prefix case for each directory: a plausible-looking file that must be left
		// alone because it does not belong to what this helper has ever written into THAT directory.
		const foreignSqliteFileInTmpdirRole = makeOld(tmpdirRole, 'sqlite-wal-foreign-old.db');
		const foreignCursorFileInCopilotRole = makeOld(copilotTmpRole, 'cursor-wal-foreign-old.db');

		const removed = await sweepStaleWalTempFiles(60 * 60 * 1000, [
			{ dir: tmpdirRole, prefixes: ['cursor-wal-'] },
			{ dir: copilotTmpRole, prefixes: ['sqlite-wal-'] },
		]);

		assert.equal(removed, 2, 'only the two files matching their OWN directory\'s prefix should be removed');
		assert.equal(fs.existsSync(ownCursorFile), false, 'cursor-wal- in the os.tmpdir() role must be removed');
		assert.equal(fs.existsSync(ownSqliteFile), false, 'sqlite-wal- in the ~/.copilot/tmp role must be removed');
		assert.equal(
			fs.existsSync(foreignSqliteFileInTmpdirRole), true,
			'sqlite-wal- in the os.tmpdir() role must be left alone — that prefix is only ever swept from ~/.copilot/tmp'
		);
		assert.equal(
			fs.existsSync(foreignCursorFileInCopilotRole), true,
			'cursor-wal- in the ~/.copilot/tmp role must be left alone — that prefix is only ever swept from os.tmpdir()'
		);
	} finally {
		fs.rmSync(tmpdirRole, { recursive: true, force: true });
		fs.rmSync(copilotTmpRole, { recursive: true, force: true });
	}
});


test('tryReadDbWithWal evicts merged buffers once they are past the retention window', async () => {
	const fixture = createWalFixture();
	const realNow = Date.now;
	try {
		const first = await tryReadDbWithWal(fixture.dbPath);
		assert.ok(first, 'first call should merge and return a buffer');
		assert.ok(walMergeCacheSizeForTests() > 0, 'the merged buffer should be cached initially');

		// Jump past the retention window (the longest throttle interval) so the cached buffer
		// can never be served again — it must be dropped rather than retained for the life of
		// the process, since each one can be up to MAX_WAL_MERGE_DB_SIZE_BYTES.
		const shifted = realNow() + 6 * 60_000;
		Date.now = () => shifted;

		const second = await tryReadDbWithWal(fixture.dbPath);
		assert.notEqual(second, first, 'past the retention window a fresh merge must run, not the cached buffer');
	} finally {
		Date.now = realNow;
		fixture.cleanup();
	}
});

test('tryReadDbWithWalFingerprint reports the ORIGINAL fingerprint for a throttled buffer, not the current (changed) WAL state', async () => {
	// This is the root-cause regression test for the "throttle can hide data forever" bug: a
	// caller that stamps its own cache with a freshly-read WAL mtime after being served a stale,
	// throttled buffer ends up with a cache entry that claims to be newer than the data actually
	// is. If the writer then stops, that wrong fingerprint never gets invalidated again.
	const fixture = createWalFixture();
	try {
		const first = await tryReadDbWithWalFingerprint(fixture.dbPath);
		assert.ok(first, 'first call should merge and return a result');

		fixture.writer.exec("INSERT INTO t VALUES ('more')"); // live WAL state moves on
		const liveWal = fs.statSync(fixture.dbPath + '-wal');
		assert.ok(
			liveWal.mtimeMs !== first.walMtimeMs || liveWal.size !== first.walSize,
			'fixture setup: the live WAL must have changed since the first merge'
		);

		const second = await tryReadDbWithWalFingerprint(fixture.dbPath); // inside the throttle window
		assert.equal(second?.buffer, first.buffer, 'sanity: served from the throttle cache');
		assert.equal(
			second?.walMtimeMs, first.walMtimeMs,
			'a throttled (stale) buffer must report the fingerprint it was actually produced from — not a fresh stat of the live WAL, which would claim newer data than the served bytes actually contain'
		);
		assert.equal(second?.walSize, first.walSize);
		assert.equal(second?.dbMtimeMs, first.dbMtimeMs);
		assert.equal(second?.dbSize, first.dbSize);
	} finally {
		fixture.cleanup();
	}
});

/**
 * Spies on `fs.copyFileSync` for the duration of a test, returning a restore function.
 *
 * TS compiles `import * as fs from 'fs'` to a live-binding getter (via tslib's `__importStar`),
 * so this module's own `fs.copyFileSync` can't be assigned directly ("Cannot set property
 * copyFileSync of #<Object> which has only a getter"). `require('fs')` returns the real,
 * plain-writable module object underneath that every `import * as fs` — including in
 * src/utils/sqliteWal.ts — transparently forwards reads to, so mutating it here is visible there.
 */
function spyOnCopyFileSync(
	impl: (original: typeof fs.copyFileSync, ...args: Parameters<typeof fs.copyFileSync>) => ReturnType<typeof fs.copyFileSync>
): () => void {
	const rawFs = require('fs') as typeof fs;
	const original = rawFs.copyFileSync;
	rawFs.copyFileSync = ((...args: Parameters<typeof fs.copyFileSync>) => impl(original, ...args)) as typeof fs.copyFileSync;
	return () => { rawFs.copyFileSync = original; };
}

test('tryReadDbWithWalFingerprint does not serve a throttled buffer once the main db file itself has changed', async () => {
	const fixture = createWalFixture();
	let copyCalls = 0;
	const restoreCopyFileSync = spyOnCopyFileSync((original, ...args) => {
		copyCalls++;
		return original(...args);
	});
	try {
		const first = await tryReadDbWithWal(fixture.dbPath);
		assert.ok(first, 'first call should merge and return a buffer');
		const copyCallsAfterFirstMerge = copyCalls;
		assert.ok(copyCallsAfterFirstMerge > 0, 'sanity: the first call actually copied files');

		// A checkpoint (RESTART) folds all pending frames into the main .db file, changing its
		// mtime/size, while leaving journal_mode=WAL active for further writes — this is the
		// "checkpoint changed the main file while a WAL remains" scenario item 2 guards against.
		// It must NOT be confused with "the writer stopped" (nothing here reduces WAL activity).
		fixture.writer.exec('PRAGMA wal_checkpoint(RESTART);');
		fixture.writer.exec("INSERT INTO t VALUES ('after-checkpoint')"); // leave a fresh, non-empty WAL

		// Still well inside the throttle window — a naive throttle would just re-serve `first`.
		const second = await tryReadDbWithWal(fixture.dbPath);

		assert.ok(
			copyCalls > copyCallsAfterFirstMerge,
			'a main-db-file change during the throttle window must force a fresh merge attempt, not silently reuse a buffer that predates the change'
		);
		assert.notEqual(second, first, 'the served buffer must reflect the post-checkpoint db, not the stale pre-checkpoint one');
	} finally {
		restoreCopyFileSync();
		fixture.cleanup();
	}
});

test('tryReadDbWithWal evicts a now-ineligible path\'s cached buffer immediately, not after the retention window', async () => {
	const fixture = createWalFixture();
	try {
		const first = await tryReadDbWithWal(fixture.dbPath);
		assert.ok(first, 'first call should merge and return a buffer');
		assert.equal(walMergeCacheHasEntryForTests(fixture.dbPath), true, 'the merged buffer should be cached initially');

		// Checkpoint+truncate collapses the WAL to empty — the path is now ineligible for merging.
		fixture.writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
		const result = await tryReadDbWithWal(fixture.dbPath);

		assert.equal(result, null, 'no WAL left to merge, so tryReadDbWithWal must return null');
		assert.equal(
			walMergeCacheHasEntryForTests(fixture.dbPath), false,
			'an ineligible path\'s retained buffer must be dropped immediately, not held for the rest of the retention window'
		);
	} finally {
		fixture.cleanup();
	}
});

test('tryReadDbWithWal refuses to attempt a merge when db+wal COMBINED exceed the cap, even though the db alone is small', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-hugewal-'));
	const dbPath = path.join(tmpDir, 'small.db');
	const walPath = dbPath + '-wal';
	let copyCalls = 0;
	const restoreCopyFileSync = spyOnCopyFileSync((original, ...args) => {
		copyCalls++;
		return original(...args);
	});
	try {
		fs.writeFileSync(dbPath, 'tiny db content, nowhere near the cap alone');
		// A sparse file reports the requested size via fs.stat without writing real bytes to disk.
		const fd = fs.openSync(walPath, 'w');
		fs.ftruncateSync(fd, MAX_WAL_MERGE_DB_SIZE_BYTES);
		fs.closeSync(fd);

		const result = await tryReadDbWithWal(dbPath);

		assert.equal(result, null, 'a small db with a huge WAL must still be refused');
		assert.equal(
			copyCalls, 0,
			'the combined db+wal size must be checked BEFORE any copy is attempted — a small db must not let an oversized WAL through the cap'
		);
	} finally {
		restoreCopyFileSync();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('tryReadDbWithWalFingerprint does not serve a stale buffer under its old fingerprint when the main db changed and the re-merge attempt fails (Fix 2)', async () => {
	const fixture = createWalFixture();
	let shouldFailMerge = false;
	const restoreCopyFileSync = spyOnCopyFileSync((original, ...args) => {
		if (shouldFailMerge) { throw new Error('simulated merge failure'); }
		return original(...args);
	});
	try {
		const first = await tryReadDbWithWalFingerprint(fixture.dbPath);
		assert.ok(first, 'first call should merge and return a result');

		// A checkpoint (RESTART) folds pending frames into the main .db file, changing its
		// mtime/size — exactly the "main db changed" condition that makes
		// tryReadDbWithWalFingerprint fall through to attempting a fresh merge instead of serving
		// the throttled buffer.
		fixture.writer.exec('PRAGMA wal_checkpoint(RESTART);');
		fixture.writer.exec("INSERT INTO t VALUES ('after-checkpoint')"); // leave a fresh, non-empty WAL

		// Now make the fresh re-merge attempt itself fail (e.g. a transient lock, or an ENOENT from
		// an atomic-replace pattern).
		shouldFailMerge = true;
		const second = await tryReadDbWithWalFingerprint(fixture.dbPath);

		assert.equal(
			second, null,
			'the main db changed since the cached buffer and the re-merge failed — the stale pre-checkpoint buffer must not be served under a fingerprint that no longer matches the current main db'
		);

		// readDbBufferWithWalFingerprint (the public, "never null" API) must fall through to a
		// fresh, honestly-fingerprinted plain read of the CURRENT main db — not silently reuse the
		// stale pre-checkpoint fingerprint a caller might otherwise believe is still accurate.
		const currentDbStat = fs.statSync(fixture.dbPath);
		const fallback = await readDbBufferWithWalFingerprint(fixture.dbPath);
		assert.equal(
			fallback.dbMtimeMs, currentDbStat.mtimeMs,
			'the fallback fingerprint must reflect the CURRENT (post-checkpoint) main db, not the stale cached one'
		);
		assert.equal(fallback.dbSize, currentDbStat.size);
		assert.notEqual(fallback.dbMtimeMs, first.dbMtimeMs, 'sanity: the post-checkpoint main db must differ from the pre-checkpoint one');
	} finally {
		restoreCopyFileSync();
		fixture.cleanup();
	}
});

test('readDbBufferWithWalFingerprint reports walIncluded:false when the WAL-blind fallback skips a non-empty, un-mergeable WAL (Fix 3)', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-walincluded-oversized-'));
	const dbPath = path.join(tmpDir, 'huge.db');
	const walPath = dbPath + '-wal';
	try {
		// A sparse file reports the requested size via fs.stat without writing real bytes to disk.
		const fd = fs.openSync(dbPath, 'w');
		fs.ftruncateSync(fd, MAX_WAL_MERGE_DB_SIZE_BYTES + 1024);
		fs.closeSync(fd);
		fs.writeFileSync(walPath, 'not empty so the WAL-present check passes');

		const result = await readDbBufferWithWalFingerprint(dbPath);

		assert.equal(
			result.walIncluded, false,
			'a non-empty WAL that could not be merged in (over the combined size cap) must be reported as NOT included — the returned bytes exclude it'
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('readDbBufferWithWalFingerprint reports walIncluded:true when there is no WAL content to have missed', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-walincluded-nowal-'));
	const dbPath = path.join(tmpDir, 'plain.db');
	try {
		fs.writeFileSync(dbPath, 'not wal mode');
		const result = await readDbBufferWithWalFingerprint(dbPath);
		assert.equal(result.walIncluded, true, 'nothing was excluded — there was no WAL content to miss');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('tryReadDbWithWalFingerprint reports walIncluded:true for both a fresh merge and a throttle-served buffer', async () => {
	const fixture = createWalFixture();
	try {
		const first = await tryReadDbWithWalFingerprint(fixture.dbPath);
		assert.equal(first?.walIncluded, true, 'a fresh, successful merge folds in the WAL');

		fixture.writer.exec("INSERT INTO t VALUES ('more')");
		const second = await tryReadDbWithWalFingerprint(fixture.dbPath); // served from the throttle
		assert.equal(second?.buffer, first?.buffer, 'sanity: served from the throttle cache');
		assert.equal(second?.walIncluded, true, 'a throttle-served buffer still reflects an honestly-reported, WAL-inclusive point in time');
	} finally {
		fixture.cleanup();
	}
});

test('tryReadDbWithWal throttles a persistently failing merge instead of retrying the expensive copy on every call', async () => {
	const fixture = createWalFixture();
	let copyAttempts = 0;
	const restoreCopyFileSync = spyOnCopyFileSync(() => {
		copyAttempts++;
		throw new Error('simulated persistent copy failure');
	});
	try {
		const first = await tryReadDbWithWal(fixture.dbPath);
		assert.equal(first, null, 'a failing merge with nothing cached yet must return null');
		assert.equal(copyAttempts, 1, 'sanity: the merge was attempted once');

		const second = await tryReadDbWithWal(fixture.dbPath);
		assert.equal(second, null);
		assert.equal(
			copyAttempts, 1,
			'a persistently failing merge must be throttled like a successful one — retrying the full copy on every single call defeats the throttle exactly where it matters most'
		);
	} finally {
		restoreCopyFileSync();
		fixture.cleanup();
	}
});

test('the throttle interval constants keep their documented values (1 min, 5 min writer-active, 30 s recency)', () => {
	assert.equal(WAL_MERGE_MIN_INTERVAL_MS, 60_000);
	assert.equal(WAL_MERGE_WRITER_ACTIVE_INTERVAL_MS, 5 * 60_000);
	assert.equal(WRITER_ACTIVE_WAL_RECENCY_MS, 30_000);
	assert.ok(WAL_MERGE_WRITER_ACTIVE_INTERVAL_MS > WAL_MERGE_MIN_INTERVAL_MS, 'a live writer must back off harder than the plain throttle');
});

test('the over-cap skip is logged once per path via console.debug, and again after the path becomes eligible and regrows', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitewal-logonce-'));
	const dbPath = path.join(tmpDir, 'huge.db');
	const walPath = dbPath + '-wal';
	const messages: string[] = [];
	const originalDebug = console.debug;
	console.debug = (...args: unknown[]) => { messages.push(args.join(' ')); };
	const makeSparse = (file: string, size: number) => {
		const fd = fs.openSync(file, 'w');
		fs.ftruncateSync(fd, size);
		fs.closeSync(fd);
	};
	try {
		makeSparse(dbPath, MAX_WAL_MERGE_DB_SIZE_BYTES + 1024);
		fs.writeFileSync(walPath, 'not empty');

		await tryReadDbWithWal(dbPath);
		await tryReadDbWithWal(dbPath);
		await tryReadDbWithWal(dbPath);
		const forPath = () => messages.filter(m => m.includes(dbPath));
		assert.equal(forPath().length, 1, 'repeated polls over the cap must log exactly once');

		// Shrink the main db below the cap: the path becomes eligible again (clearing the logged flag),
		// and the merge attempt on this fake db fails quietly. Then regrow it past the cap.
		makeSparse(dbPath, 1024);
		await tryReadDbWithWal(dbPath);
		makeSparse(dbPath, MAX_WAL_MERGE_DB_SIZE_BYTES + 1024);
		await tryReadDbWithWal(dbPath);
		assert.equal(forPath().length, 2, 'regrowing past the cap after being eligible must log again');
	} finally {
		console.debug = originalDebug;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('falls back to a direct (WAL-blind) read, without throwing, when node:sqlite cannot be loaded', async () => {
	// A REAL WAL fixture: without the loader seam being consulted, the merge would succeed and
	// return the WAL row, so this test fails if performWalMerge bypasses the injected loader.
	const fixture = createWalFixture();
	let loaderCalls = 0;
	try {
		setNodeSqliteLoaderForTests(() => { loaderCalls++; throw new Error('Cannot find module node:sqlite'); });

		assert.equal(await tryReadDbWithWal(fixture.dbPath), null, 'no merge is possible without node:sqlite');
		assert.equal(loaderCalls, 1, 'the merge must have gone through the injected loader, not the real module');

		const result = await readDbBufferWithWalFingerprint(fixture.dbPath);
		assert.deepEqual(result.buffer, fs.readFileSync(fixture.dbPath), 'must fall back to the plain main-file bytes');
		assert.equal(result.walIncluded, false, 'the non-empty WAL was not merged, and must be reported as such');
	} finally {
		setNodeSqliteLoaderForTests(undefined);
		fixture.cleanup();
	}
});
