import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UriLike } from '../opencode';
import { CursorDataAccess } from '../cursor';

const FAKE_URI: UriLike = { fsPath: '', path: '', scheme: 'file' };

/**
 * Counts WAL temp files in `dir` that *this* process created. Both temp directories below are
 * shared with every other process on the machine — including the concurrently-running
 * sqliteWal.test.js, which performs real merges into `~/.copilot/tmp` — so a bare prefix count
 * would intermittently see another test file's in-flight temp files and fail. The merge helper
 * embeds the creating pid in every name (`<prefix>...-<pid>-<ts>-<rand>`), so scoping the count
 * to this pid keeps the assertion about this test alone. Missing dir counts as 0.
 */
function countOwnWalTempFiles(dir: string, prefixes: string[]): number {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	const ownPid = `-${process.pid}-`;
	return entries.filter(
		name => prefixes.some(prefix => name.startsWith(prefix)) && name.includes(ownPid)
	).length;
}

const WAL_TEMP_PREFIXES = ['cursor-wal-', 'sqlite-wal-'];
const copilotTmpDir = path.join(os.homedir(), '.copilot', 'tmp');

/**
 * Creates a real WAL-mode `state.vscdb`-shaped fixture with `cursorDiskKV(key, value)`, using
 * node:sqlite directly (Node 22+, same runtime the extension ships on). Returns the still-open
 * writer connection so callers can insert rows that stay pending in the `-wal` file.
 */
function createCursorDbFixture() {
	const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fixture-'));
	const dbPath = path.join(tmpDir, 'state.vscdb');
	const writer = new DatabaseSync(dbPath);
	writer.exec('PRAGMA journal_mode=WAL;');
	writer.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
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

test('readComposerData sees a live writer\'s pending WAL frames via the read-only backend, without copying or checkpointing the db', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerId = 'composer-pending';
		const payload = JSON.stringify({ composerId, name: 'Pending session', contextTokensUsed: 42 });
		// Insert without closing the writer connection — this row is committed to SQLite's WAL
		// semantics but lives only in the `-wal` file; sql.js reading raw `.db` bytes would miss it.
		fixture.writer.exec(`INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}', '${payload.replace(/'/g, "''")}')`);

		const beforeMain = fs.statSync(fixture.dbPath);
		const beforeWal = fs.statSync(fixture.dbPath + '-wal');
		const beforeTmpCount = countOwnWalTempFiles(os.tmpdir(), WAL_TEMP_PREFIXES);
		const beforeCopilotTmpCount = countOwnWalTempFiles(copilotTmpDir, WAL_TEMP_PREFIXES);

		const access = new CursorDataAccess(FAKE_URI);
		const virtualPath = `${fixture.dbPath}#${composerId}`;
		const data = await access.readComposerData(virtualPath);

		assert.equal(data?.name, 'Pending session');
		assert.equal(data?.contextTokensUsed, 42);

		const afterMain = fs.statSync(fixture.dbPath);
		const afterWal = fs.statSync(fixture.dbPath + '-wal');
		assert.equal(afterMain.size, beforeMain.size, 'main db file size must be unchanged (no checkpoint)');
		assert.equal(afterMain.mtimeMs, beforeMain.mtimeMs, 'main db file mtime must be unchanged (no write)');
		assert.equal(afterWal.size, beforeWal.size, '-wal file size must be unchanged (no truncating checkpoint)');

		assert.equal(countOwnWalTempFiles(os.tmpdir(), WAL_TEMP_PREFIXES), beforeTmpCount, 'this process must create no temp file in os.tmpdir()');
		assert.equal(countOwnWalTempFiles(copilotTmpDir, WAL_TEMP_PREFIXES), beforeCopilotTmpCount, 'this process must create no temp file in ~/.copilot/tmp');
	} finally {
		fixture.cleanup();
	}
});

test('discoverSessions and readBubbles also read the live WAL without copying the db', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerId = 'composer-2';
		fixture.writer.exec(
			`INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}', '${JSON.stringify({ composerId }).replace(/'/g, "''")}')`
		);
		fixture.writer.exec(
			`INSERT INTO cursorDiskKV VALUES ('bubbleId:${composerId}:b1', '${JSON.stringify({ bubbleId: 'b1', type: 1, text: 'hello' }).replace(/'/g, "''")}')`
		);

		const access = new CursorDataAccess(FAKE_URI);
		// discoverSessions() reads the well-known cursor db path — point it at the fixture.
		access.getCursorDbPath = () => fixture.dbPath;

		const sessions = await access.discoverSessions();
		assert.deepEqual(sessions, [`${fixture.dbPath}#${composerId}`]);

		const bubbles = await access.readBubbles(sessions[0], ['b1']);
		assert.equal(bubbles.get('b1')?.text, 'hello');
	} finally {
		fixture.cleanup();
	}
});

test('readComposerData caches parsed composer data instead of re-querying for each call in one session read', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerId = 'composer-cache';
		fixture.writer.exec(
			`INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}', '${JSON.stringify({
				composerId,
				contextTokensUsed: 10,
				fullConversationHeadersOnly: [{ type: 1, bubbleId: 'b1' }],
			}).replace(/'/g, "''")}')`
		);

		const access = new CursorDataAccess(FAKE_URI);
		let queryCount = 0;
		const originalQueryAll = (access as unknown as { queryAll: (...args: unknown[]) => unknown }).queryAll.bind(access);
		(access as unknown as { queryAll: (...args: unknown[]) => unknown }).queryAll = (...args: unknown[]) => {
			queryCount++;
			return originalQueryAll(...args);
		};

		const virtualPath = `${fixture.dbPath}#${composerId}`;
		// Mirrors getSessionData(): 4 concurrent readComposerData()-backed calls for one session read.
		await Promise.all([
			access.getTokens(virtualPath),
			access.countInteractions(virtualPath),
			access.getModelUsage(virtualPath),
			access.getSessionMeta(virtualPath),
		]);

		assert.equal(queryCount, 1, 'only one underlying query should run for 4 concurrent reads of the same composer');

		// A second, later read (cache still valid — db file unchanged) should also be served from cache.
		await access.readComposerData(virtualPath);
		assert.equal(queryCount, 1, 'a cache-valid follow-up read should not re-query');
	} finally {
		fixture.cleanup();
	}
});

test('falls back to sql.js when node:sqlite is unavailable, and still returns composer data', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerId = 'composer-fallback';
		const payload = { composerId, name: 'Fallback session', contextTokensUsed: 7 };
		fixture.writer.exec(
			`INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}', '${JSON.stringify(payload).replace(/'/g, "''")}')`
		);
		fixture.writer.close(); // checkpoint on close so the plain sql.js buffer read sees the row too

		const access = new CursorDataAccess(FAKE_URI);
		// Simulate an environment without node:sqlite (older Electron).
		(access as unknown as { getNodeSqliteModule: () => null }).getNodeSqliteModule = () => null;

		const virtualPath = `${fixture.dbPath}#${composerId}`;
		const data = await access.readComposerData(virtualPath);

		assert.equal(data?.name, 'Fallback session');
		assert.equal(data?.contextTokensUsed, 7);
	} finally {
		fixture.cleanup();
	}
});

test('a db path that fails to open read-only is only probed once, not retried on every call', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-badfile-'));
	const dbPath = path.join(tmpDir, 'state.vscdb');
	try {
		fs.writeFileSync(dbPath, 'not a real sqlite file');

		const access = new CursorDataAccess(FAKE_URI);
		let openAttempts = 0;
		class FailingDatabaseSync {
			constructor() {
				openAttempts++;
				throw new Error('simulated read-only open failure');
			}
		}
		(access as unknown as { getNodeSqliteModule: () => { DatabaseSync: unknown } }).getNodeSqliteModule = () => (
			{ DatabaseSync: FailingDatabaseSync }
		);
		access.getCursorDbPath = () => dbPath;

		await access.discoverSessions();
		await access.discoverSessions();
		await access.discoverSessions();

		assert.equal(openAttempts, 1, 'the read-only backend should only be probed once for a db path that fails to open');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('a failed read-only open demotes the db only temporarily, not for the process lifetime', async () => {
	const fixture = createCursorDbFixture();
	try {
		const access = new CursorDataAccess(FAKE_URI);
		// Force the read-only backend to fail once, as a transient SQLITE_BUSY would while the
		// writer holds an exclusive lock during its own checkpoint.
		const accessInternals = access as unknown as {
			_readOnlyUnsupportedDbs: Map<string, number>;
			isReadOnlyDemoted(dbPath: string): boolean;
		};
		accessInternals._readOnlyUnsupportedDbs.set(fixture.dbPath, Date.now());
		assert.equal(
			accessInternals.isReadOnlyDemoted(fixture.dbPath), true,
			'a just-failed db should be demoted to the sql.js fallback'
		);

		// Past the cooldown the demotion must lapse — otherwise one transient failure strands this
		// db on the copy-based fallback forever, reintroducing the multi-GB copies (#2033).
		accessInternals._readOnlyUnsupportedDbs.set(fixture.dbPath, Date.now() - 6 * 60_000);
		assert.equal(
			accessInternals.isReadOnlyDemoted(fixture.dbPath), false,
			'the demotion must expire so the copy-free backend is retried'
		);
		assert.equal(
			accessInternals._readOnlyUnsupportedDbs.has(fixture.dbPath), false,
			'the lapsed entry should be cleared rather than accumulating'
		);
	} finally {
		fixture.cleanup();
	}
});

test('a failed read-only open demotes the db only temporarily — the REAL query path retries the native backend once the cooldown expires', async () => {
	// Unlike the test above (which only pokes the private _readOnlyUnsupportedDbs map and the
	// isReadOnlyDemoted predicate directly), this exercises the actual public query path end to
	// end with an injected failing/recovering backend and a controllable clock, so a regression
	// that left queryReadOnly permanently bypassed after one failure would be caught here.
	const fixture = createCursorDbFixture();
	const realNow = Date.now;
	try {
		const composerId = 'composer-cooldown';
		const payload = JSON.stringify({ composerId, name: 'Cooldown session', contextTokensUsed: 5 });
		fixture.writer.exec(`INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}', '${payload.replace(/'/g, "''")}')`);

		const access = new CursorDataAccess(FAKE_URI);
		const { DatabaseSync: RealDatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
		let openAttempts = 0;
		let shouldFail = true;
		class ControllableDatabaseSync {
			private readonly real: InstanceType<typeof RealDatabaseSync>;
			constructor(dbPath: string, options?: ConstructorParameters<typeof RealDatabaseSync>[1]) {
				openAttempts++;
				if (shouldFail) {
					throw new Error('simulated transient read-only failure (e.g. SQLITE_BUSY during a checkpoint)');
				}
				this.real = new RealDatabaseSync(dbPath, options);
			}
			prepare(sql: string) { return this.real.prepare(sql); }
			close() { return this.real.close(); }
		}
		(access as unknown as { getNodeSqliteModule: () => { DatabaseSync: unknown } }).getNodeSqliteModule = () => (
			{ DatabaseSync: ControllableDatabaseSync }
		);

		const virtualPath = `${fixture.dbPath}#${composerId}`;
		const composerCache = (access as unknown as { _composerCache: Map<string, unknown> })._composerCache;

		// First call: the native open fails, so the real query path falls back to sql.js and
		// demotes this db path.
		const first = await access.readComposerData(virtualPath);
		assert.equal(openAttempts, 1, 'the native backend should have been attempted once');
		assert.equal(first?.name, 'Cooldown session', 'the sql.js fallback must still return correct data');

		// Still within the cooldown — force a re-query (bypassing the unrelated composer-data
		// cache) and confirm the real query path does NOT retry the native backend yet.
		composerCache.clear();
		await access.readComposerData(virtualPath);
		assert.equal(openAttempts, 1, 'still within the cooldown, the real query path must not retry the native backend');

		// Jump the clock past the cooldown, and let the native backend succeed this time.
		Date.now = () => realNow() + 6 * 60_000;
		shouldFail = false;
		composerCache.clear();

		await access.readComposerData(virtualPath);
		assert.equal(
			openAttempts, 2,
			'past the cooldown, the real query path must attempt the native backend again — not stay demoted for the process lifetime'
		);
	} finally {
		Date.now = realNow;
		fixture.cleanup();
	}
});

test('the sql.js fallback backend caches a parsed Database per db path instead of reloading the whole db for every distinct composer', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerIds = ['fallback-c1', 'fallback-c2', 'fallback-c3'];
		for (const id of composerIds) {
			fixture.writer.exec(
				`INSERT INTO cursorDiskKV VALUES ('composerData:${id}', '${JSON.stringify({ composerId: id, contextTokensUsed: 1 }).replace(/'/g, "''")}')`
			);
		}

		const access = new CursorDataAccess(FAKE_URI);
		// Simulate an environment without node:sqlite (older Electron) — every query below must go
		// through the sql.js fallback.
		(access as unknown as { getNodeSqliteModule: () => null }).getNodeSqliteModule = () => null;

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

		// Sequential (NOT concurrent) reads across distinct composers — deliberately not batched
		// via Promise.all, so this can only be served by the per-db-path Database cache and not by
		// the (separate, already-tested) single-flight dedup for concurrent calls to the same
		// composer. Each id is also queried for the first time, so the per-composer `_composerCache`
		// can't short-circuit the call before it ever reaches the sql.js backend either.
		for (const id of composerIds) {
			const data = await access.readComposerData(`${fixture.dbPath}#${id}`);
			assert.equal(data?.composerId, id);
		}

		assert.equal(
			dbConstructions, 1,
			'one sql.js Database load should serve every composer in this db path, not one reload per composer'
		);

		// A later, separate read of the SAME composer (composer cache still valid — file unchanged)
		// should also reuse it.
		await access.readComposerData(`${fixture.dbPath}#${composerIds[0]}`);
		assert.equal(dbConstructions, 1, 'a cache-valid follow-up read should not reload the db either');
	} finally {
		fixture.cleanup();
	}
});

test('a transient read failure is not cached as "composer not found" — it is retried on the next call, not stuck forever', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerId = 'composer-transient';
		const payload = JSON.stringify({ composerId, name: 'Recovered session', contextTokensUsed: 3 });
		fixture.writer.exec(`INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}', '${payload.replace(/'/g, "''")}')`);

		const access = new CursorDataAccess(FAKE_URI);
		// Force every query through the sql.js fallback, and make its very first load fail —
		// simulating a momentary error (e.g. a transient lock) rather than a genuinely missing row.
		(access as unknown as { getNodeSqliteModule: () => null }).getNodeSqliteModule = () => null;
		let initAttempts = 0;
		const realInitSqlJs = access.initSqlJs.bind(access);
		access.initSqlJs = async () => {
			initAttempts++;
			if (initAttempts === 1) {
				throw new Error('simulated transient failure (e.g. a momentary lock)');
			}
			return realInitSqlJs();
		};

		const virtualPath = `${fixture.dbPath}#${composerId}`;

		const first = await access.readComposerData(virtualPath);
		assert.equal(first, null, 'a transient read failure surfaces as null for this one call');

		const cache = (access as unknown as { _composerCache: Map<string, unknown> })._composerCache;
		assert.equal(
			cache.has(virtualPath), false,
			'a failed read must not be cached as "not found" — caching it would hide a live composer until the file identity happens to change'
		);

		const second = await access.readComposerData(virtualPath);
		assert.equal(
			second?.name, 'Recovered session',
			'once the backend recovers, the next call must see the real data — not a cached null from the earlier failure'
		);
	} finally {
		fixture.cleanup();
	}
});

test('the -wal size is part of the composer cache key, not just its mtime', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerId = '11111111-2222-3333-4444-555555555555';
		const virtualPath = `${fixture.dbPath}#${composerId}`;
		const write = (name: string) => fixture.writer.exec(
			`INSERT OR REPLACE INTO cursorDiskKV VALUES ('composerData:${composerId}', '${JSON.stringify({ composerId, name }).replace(/'/g, "''")}')`
		);

		const access = new CursorDataAccess(FAKE_URI);
		write('first');
		assert.equal((await access.readComposerData(virtualPath))?.name, 'first');

		write('second');

		// Re-point the cached entry's file-identity fields at the *current* db and -wal mtimes,
		// leaving only the recorded walSize stale. That is the situation a coarse-granularity
		// filesystem produces on its own (ext3/HFS+/FAT keep whole-second mtimes, so two WAL
		// appends in one tick move no mtime while the WAL still grows) and it cannot be staged
		// here by back-dating files, because utimes does not round-trip an mtime exactly — doing
		// it that way invalidates the entry via the mtime and proves nothing. Reaching into the
		// cache isolates the one field under test.
		const cache = (access as unknown as {
			_composerCache: Map<string, { mtimeMs: number; size: number; walMtimeMs: number; walSize: number }>;
		})._composerCache;
		const entry = cache.get(virtualPath);
		assert.ok(entry, 'fixture setup: the first read should have cached an entry');
		const dbNow = fs.statSync(fixture.dbPath);
		const walNow = fs.statSync(fixture.dbPath + '-wal');
		assert.notEqual(entry.walSize, walNow.size, 'fixture setup: the WAL should have grown since the cached read');
		entry.mtimeMs = dbNow.mtimeMs;
		entry.size = dbNow.size;
		entry.walMtimeMs = walNow.mtimeMs;

		assert.equal(
			(await access.readComposerData(virtualPath))?.name, 'second',
			'a grown WAL must invalidate the entry even when every mtime matches'
		);
	} finally {
		fixture.cleanup();
	}
});

test('the sql.js fallback reuses the parsed Database across a throttled read instead of reparsing every time the live WAL is touched (Fix 1)', async () => {
	const fixture = createCursorDbFixture();
	try {
		const composerId = 'fix1-composer';
		fixture.writer.exec(
			`INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}', '${JSON.stringify({ composerId, name: 'v1' }).replace(/'/g, "''")}')`
		);

		const access = new CursorDataAccess(FAKE_URI);
		// Simulate an environment without node:sqlite (older Electron) — every query below must go
		// through the sql.js fallback and its per-db-path Database cache (getSqlJsDb).
		(access as unknown as { getNodeSqliteModule: () => null }).getNodeSqliteModule = () => null;

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

		const virtualPath = `${fixture.dbPath}#${composerId}`;
		const first = await access.readComposerData(virtualPath);
		assert.equal(first?.name, 'v1');
		assert.equal(dbConstructions, 1, 'the first read parses the db once');

		// Touch the live WAL (grows it, changing its mtime/size) WITHOUT letting sqliteWal's own
		// merge throttle window lapse, and clear the per-composer cache so this call is forced back
		// down into getSqlJsDb — the cheap fresh-stat pre-check will see the WAL has moved and
		// attempt a read, but that read will be served from sqliteWal's own throttle under the
		// SAME original fingerprint as before (nothing has actually changed from the fallback's
		// point of view).
		fixture.writer.exec(
			`INSERT INTO cursorDiskKV VALUES ('composerData:other', '${JSON.stringify({ composerId: 'other' }).replace(/'/g, "''")}')`
		);
		const composerCache = (access as unknown as { _composerCache: Map<string, unknown> })._composerCache;
		composerCache.clear();

		const second = await access.readComposerData(virtualPath);
		assert.equal(second?.name, 'v1', 'still the same data — the throttled read served the original, unchanged buffer');
		assert.equal(
			dbConstructions, 1,
			'a throttled read reporting the SAME fingerprint as before must reuse the already-parsed Database, not reparse it'
		);
	} finally {
		fixture.cleanup();
	}
});

test('a WAL-blind plain read (merge failed, nothing cached) is not persisted as a settled per-path Database — a later successful merge still surfaces data written before it (Fix 3)', async () => {
	const fixture = createCursorDbFixture();
	let mergeShouldFail = true;
	const rawFs = require('fs') as typeof fs;
	const originalCopyFileSync = rawFs.copyFileSync;
	// TS compiles `import * as fs` to a live-binding getter, so this module's own fs.copyFileSync
	// can't be assigned directly; require('fs') returns the real, writable module object every
	// `import * as fs` — including src/utils/sqliteWal.ts's — transparently forwards reads to.
	rawFs.copyFileSync = ((...args: Parameters<typeof fs.copyFileSync>) => {
		if (mergeShouldFail) { throw new Error('simulated merge failure'); }
		return originalCopyFileSync(...args);
	}) as typeof fs.copyFileSync;
	const realNow = Date.now;
	try {
		const composerId = 'fix3-composer';
		const write = (name: string) => fixture.writer.exec(
			`INSERT OR REPLACE INTO cursorDiskKV VALUES ('composerData:${composerId}', '${JSON.stringify({ composerId, name }).replace(/'/g, "''")}')`
		);
		write('v1');
		// Checkpoint v1 into the MAIN db file (not just leaving it in the WAL) so the plain,
		// WAL-blind fallback below can still see it.
		fixture.writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
		write('v2'); // pending only in the WAL from here on

		const access = new CursorDataAccess(FAKE_URI);
		(access as unknown as { getNodeSqliteModule: () => null }).getNodeSqliteModule = () => null;

		const virtualPath = `${fixture.dbPath}#${composerId}`;
		const composerCache = (access as unknown as { _composerCache: Map<string, unknown> })._composerCache;
		const sqlJsDbCache = (access as unknown as { _sqlJsDbCache: Map<string, unknown> })._sqlJsDbCache;

		// First read: the merge fails (forced), so this falls back to a WAL-blind plain read that
		// only sees v1 (the checkpointed main file) — v2 is still pending, unmerged, in the WAL.
		const first = await access.readComposerData(virtualPath);
		assert.equal(first?.name, 'v1', 'sanity: the WAL-blind read only sees the checkpointed main file');
		assert.equal(
			sqlJsDbCache.has(fixture.dbPath), false,
			'a WAL-blind read must not be persisted into the long-lived per-path Database cache as "settled"'
		);

		// Now let merges succeed again, jump past sqliteWal's own merge-retry throttle (so the next
		// attempt is not itself short-circuited as "recently failed, stay throttled"), and force a
		// re-query.
		mergeShouldFail = false;
		Date.now = () => realNow() + 6 * 60_000;
		composerCache.clear();

		const second = await access.readComposerData(virtualPath);
		assert.equal(
			second?.name, 'v2',
			'the WAL data written before the WAL-blind read must still surface once a real merge succeeds — proving the earlier read was not wrongly cached as caught-up'
		);
	} finally {
		Date.now = realNow;
		rawFs.copyFileSync = originalCopyFileSync;
		fixture.cleanup();
	}
});
