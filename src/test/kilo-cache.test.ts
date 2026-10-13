import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KiloDataAccess } from '../kilo';

/**
 * Real WAL-mode `kilo.db`-shaped fixture (real `session` table, real node:sqlite writer) — Kilo
 * Code's data-access layer mirrors OpenCode's (see src/kilo.ts's module doc comment), so this
 * exercises the actual merge/throttle path in src/utils/sqliteWal.ts, not a fake in-memory
 * Database, the same way opencode-cache.test.ts's createOpenCodeWalFixture does.
 */
function createKiloWalFixture() {
	const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-wal-fixture-'));
	const dbPath = path.join(tmpDir, 'kilo.db');
	const writer = new DatabaseSync(dbPath);
	writer.exec('PRAGMA journal_mode=WAL;');
	writer.exec(
		'CREATE TABLE session (id TEXT PRIMARY KEY, slug TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, project_id TEXT, directory TEXT);'
	);
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

test('a WAL write made inside the throttle window eventually becomes visible once the writer goes quiet (regression: throttle must not hide data forever)', async () => {
	// Mirrors the equivalent opencode-cache.test.ts regression test — see its comment for the
	// full losing-sequence explanation.
	const fixture = createKiloWalFixture();
	const realNow = Date.now;
	try {
		fixture.writer.exec("INSERT INTO session VALUES ('s1', 'slug-1', 'Original title', 1, 1, 'p1', '/dir')");

		const access = new KiloDataAccess({ fsPath: '', path: '', scheme: 'file' });
		access.getKiloDataDir = () => fixture.tmpDir;

		const first = await access.readKiloDbSession('s1');
		assert.equal(first?.title, 'Original title');

		fixture.writer.exec("UPDATE session SET title = 'Updated title' WHERE id = 's1'");
		const second = await access.readKiloDbSession('s1');
		assert.equal(second?.title, 'Original title', 'sanity: still within the throttle window, the stale snapshot is served');

		const shifted = realNow() + 70_000; // past WAL_MERGE_MIN_INTERVAL_MS (60s) and the 30s writer-recency window
		Date.now = () => shifted;

		const third = await access.readKiloDbSession('s1');
		assert.equal(
			third?.title, 'Updated title',
			'once the throttle window lapses, the write must become visible — the cache must not have been fooled into believing it already had it'
		);
	} finally {
		Date.now = realNow;
		fixture.cleanup();
	}
});

test('the sql.js DB cache reuses the parsed Database across a throttled read instead of reparsing every time the live WAL is touched (Fix 1)', async () => {
	const fixture = createKiloWalFixture();
	try {
		fixture.writer.exec("INSERT INTO session VALUES ('s1', 'slug-1', 'v1', 1, 1, 'p1', '/dir')");

		const access = new KiloDataAccess({ fsPath: '', path: '', scheme: 'file' });
		access.getKiloDataDir = () => fixture.tmpDir;

		let dbConstructions = 0;
		const realInitSqlJs = access.initSqlJs.bind(access);
		access.initSqlJs = async () => {
			const SQL = await realInitSqlJs();
			const RealDatabase = SQL.Database;
			function CountingDatabase(this: unknown, ...args: unknown[]) {
				dbConstructions++;
				return new (RealDatabase as unknown as new (...a: unknown[]) => unknown)(...args);
			}
			CountingDatabase.prototype = RealDatabase.prototype;
			return { ...SQL, Database: CountingDatabase as unknown as typeof SQL.Database };
		};

		const first = await access.readKiloDbSession('s1');
		assert.equal(first?.title, 'v1');
		assert.equal(dbConstructions, 1, 'the first read parses the db once');

		// Touch the live WAL (grows it) WITHOUT letting sqliteWal's own merge throttle window
		// lapse — the cheap fresh-stat pre-check in getKiloDb() will see the WAL has moved and
		// attempt a read, but that read will be served from sqliteWal's own throttle under the
		// SAME original fingerprint as before, since nothing has actually settled/changed yet.
		fixture.writer.exec("INSERT INTO session VALUES ('s2', 'slug-2', 'other', 2, 2, 'p1', '/dir')");

		const second = await access.readKiloDbSession('s1');
		assert.equal(second?.title, 'v1', 'still the same data — the throttled read served the original, unchanged buffer');
		assert.equal(
			dbConstructions, 1,
			'a throttled read reporting the SAME fingerprint as before must reuse the already-parsed Database, not reparse it'
		);
	} finally {
		fixture.cleanup();
	}
});

test('the -wal size is part of the Kilo DB cache key, not just its mtime (Fix 1b)', async () => {
	const fixture = createKiloWalFixture();
	const realNow = Date.now;
	try {
		fixture.writer.exec("INSERT INTO session VALUES ('s1', 'slug-1', 'first', 1, 1, 'p1', '/dir')");

		const access = new KiloDataAccess({ fsPath: '', path: '', scheme: 'file' });
		access.getKiloDataDir = () => fixture.tmpDir;

		const first = await access.readKiloDbSession('s1');
		assert.equal(first?.title, 'first');

		fixture.writer.exec("UPDATE session SET title = 'second' WHERE id = 's1'");

		// Re-point the cached entry's file-identity fields at the *current* db and -wal mtimes,
		// leaving only the recorded walSize stale — the situation a coarse-granularity filesystem
		// produces on its own (ext3/HFS+/FAT keep whole-second mtimes, so two WAL appends in one
		// tick move no mtime while the WAL still grows). Reaching into the cache isolates the one
		// field under test, rather than staging this via fs.utimesSync (which does not round-trip
		// an mtime exactly and would invalidate the entry via the mtime instead, proving nothing).
		const dbCache = (access as unknown as {
			_dbCache: { mtimeMs: number; size: number; walMtimeMs: number; walSize: number } | null;
		})._dbCache;
		assert.ok(dbCache, 'fixture setup: the first read should have cached an entry');
		const dbNow = fs.statSync(fixture.dbPath);
		const walNow = fs.statSync(fixture.dbPath + '-wal');
		assert.notEqual(dbCache.walSize, walNow.size, 'fixture setup: the WAL should have grown since the cached read');
		dbCache.mtimeMs = dbNow.mtimeMs;
		dbCache.size = dbNow.size;
		dbCache.walMtimeMs = walNow.mtimeMs;

		// Jump past sqliteWal's own merge-throttle window so a genuinely fresh merge runs (reflecting
		// the UPDATE above) instead of being served a still-throttled, pre-update buffer — this
		// isolates "did our own cache key correctly detect the change" from "did sqliteWal's
		// unrelated throttle happen to still be open", which is not what Fix 1b is about.
		Date.now = () => realNow() + 6 * 60_000;

		const second = await access.readKiloDbSession('s1');
		assert.equal(
			second?.title, 'second',
			'a grown WAL must invalidate the cached entry even when every mtime matches'
		);
	} finally {
		Date.now = realNow;
		fixture.cleanup();
	}
});
