/**
 * Shared helper for reading a SQLite database file that may have an active
 * WAL (write-ahead log) sidecar.
 *
 * sql.js loads a database by reading raw bytes from the `.db` file only — it
 * has no concept of the `-wal`/`-shm` sidecar files SQLite uses in WAL mode.
 * When another process (e.g. the Copilot CLI) holds the database open in WAL
 * mode, its most recent writes live only in the `-wal` file until a
 * checkpoint merges them back into the main file. Reading just the `.db`
 * bytes in that window silently returns a stale snapshot — no error, just
 * missing recent rows/columns — until something else (e.g. the writer
 * closing its connection) triggers a checkpoint.
 *
 * `tryReadDbWithWal` works around this without a native SQLite dependency in
 * the extension's runtime: it copies the db + wal (+ shm) files to a temp
 * location, opens the copy with Node's built-in `node:sqlite` (Node.js 22+),
 * forces `PRAGMA wal_checkpoint(TRUNCATE)` to merge all WAL frames into the
 * temp file, and returns the resulting buffer for sql.js to load.
 *
 * This is a fallback path — callers with a native `node:sqlite` available
 * should prefer opening `dbPath` directly with `{ readOnly: true }`, which
 * sees pending WAL frames with zero copies (see src/cursor.ts). This module
 * still guards the copy-based approach for callers/environments that can't
 * do that: a size cap refuses to copy very large databases (see #2033, where
 * an unbounded copy of Cursor's 1-2 GB `state.vscdb` on every read filled
 * %temp%), and a per-path throttle with writer-activity backoff keeps a
 * continuously-written WAL from driving back-to-back merges.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Never copy a db + WAL pair whose COMBINED size is above this budget just to merge in WAL
 * frames — `performWalMerge` copies both `dbPath` and `dbPath-wal` in full, so the temp
 * footprint it must bound is their sum, not the main db alone. The copy + native-open +
 * checkpoint + read-back is O(size) I/O and memory, and for a multi-GB pair (exactly the shape
 * that triggered #2033 — Cursor's `state.vscdb` routinely runs 1-2 GB on its own) that is worse
 * than reading a slightly stale plain `.db` file. Above this threshold `tryReadDbWithWal`
 * returns `null` so callers fall back to `fs.readFileSync(dbPath)` — a WAL-blind read that can
 * be stale, logged once per path below. Callers that need both cheap AND current reads for a
 * database this large should prefer the copy-free read-only `node:sqlite` backend instead (see
 * `src/cursor.ts`), which has no size cap because it never copies anything.
 */
export const MAX_WAL_MERGE_DB_SIZE_BYTES = 256 * 1024 * 1024; // 256 MB

/**
 * Db paths we've already logged as "skipped: over the combined size cap", so the message is
 * emitted once per path instead of on every poll (callers of `tryReadDbWithWal` are typically
 * called every few seconds). Cleared for a path once it becomes eligible again, so a later
 * regrowth past the cap logs again — this tracks the *decision*, not a one-time-ever message.
 */
const loggedOversizedPaths = new Set<string>();

/** Minimum time between WAL-merge attempts for the same db path. */
export const WAL_MERGE_MIN_INTERVAL_MS = 60_000;

/**
 * Minimum time between merge attempts while a writer looks live (see `isWalWriterActive`).
 * A running Cursor/Copilot CLI touches its WAL constantly, so without this a merge would be
 * re-attempted at the plain throttle rate forever; back off harder instead.
 */
export const WAL_MERGE_WRITER_ACTIVE_INTERVAL_MS = 5 * 60_000;

/** A writer is considered "recently active" if its WAL was touched within this window. */
export const WRITER_ACTIVE_WAL_RECENCY_MS = 30_000;

/**
 * The full identity of the bytes a merge (or a plain direct read) actually reflects: the main
 * db file's mtime/size, and the `-wal` sidecar's mtime/size, *as they were when those bytes were
 * produced*. Callers that cache a db keyed on file identity should key on this instead of
 * re-statting the files after the fact — see `readDbBufferWithWalFingerprint`.
 */
export interface WalReadResult {
	buffer: Buffer;
	dbMtimeMs: number;
	dbSize: number;
	walMtimeMs: number;
	walSize: number;
	/**
	 * Whether `buffer` folds in whatever was pending in the `-wal` sidecar as of this fingerprint —
	 * `true` for a fresh merge, a throttle-served buffer, or a last-good buffer served after a
	 * transient re-merge failure (all of these reflect *some* honestly-reported point in time that
	 * did account for the WAL); `false` only for the plain, WAL-blind fallback read in
	 * `readDbBufferWithWalFingerprint` when a non-empty `-wal` existed but wasn't merged in (e.g.
	 * the db+wal combined size is over `MAX_WAL_MERGE_DB_SIZE_BYTES`, or the merge failed with
	 * nothing to fall back on). A caller with its own long-lived per-path cache must not persist a
	 * `walIncluded: false` result as "settled, current" — a later WAL-quiet moment would then look
	 * identical to a genuinely caught-up read, permanently hiding rows that were committed but never
	 * checkpointed into the main file. See #2036 review notes (Fix 3).
	 */
	walIncluded: boolean;
}

interface WalMergeCacheEntry {
	/** The last successful merge result, if any attempt has ever succeeded for this path. */
	buffer: Buffer | undefined;
	/** When the last attempt (successful or failed) ran — drives the time-based throttle. */
	attemptedAt: number;
	/**
	 * The db+wal fingerprint the *cached `buffer`* was produced from (meaningless when `buffer`
	 * is undefined). Used to detect a main-file change (checkpoint / wholesale replacement)
	 * during the throttle window — see `tryReadDbWithWalFingerprint`.
	 */
	dbMtimeMs: number;
	dbSize: number;
	walMtimeMs: number;
	walSize: number;
}

/** Per-db-path cache of the last successful (or last-served) merge result and when it was produced. */
const walMergeCache = new Map<string, WalMergeCacheEntry>();

/**
 * How long a merged buffer is kept after its last use. A cached buffer is only ever *served*
 * inside the throttle window above, so past that point it is dead weight — and at up to
 * `MAX_WAL_MERGE_DB_SIZE_BYTES` each, across every consumer's db path, retaining them for the
 * life of the extension host would be a sizeable leak. Evicting only costs a plain (slightly
 * stale) direct read on the next call, which is what an uncached path does anyway.
 */
const WAL_MERGE_CACHE_RETENTION_MS = WAL_MERGE_WRITER_ACTIVE_INTERVAL_MS;

type NodeSqliteModule = typeof import('node:sqlite');

/** Loads `node:sqlite`; replaceable by tests to simulate a runtime without it. */
let loadNodeSqlite: () => NodeSqliteModule = () => require('node:sqlite') as NodeSqliteModule;

/** Overrides how `node:sqlite` is loaded (pass `undefined` to restore) — for tests only. */
export function setNodeSqliteLoaderForTests(loader: (() => NodeSqliteModule) | undefined): void {
	loadNodeSqlite = loader ?? (() => require('node:sqlite') as NodeSqliteModule);
}

/** Number of merged buffers currently retained — for tests only. */
export function walMergeCacheSizeForTests(): number {
	return walMergeCache.size;
}

/** Whether a cache entry (successful or failed-attempt) is currently retained for `dbPath` — for tests only. */
export function walMergeCacheHasEntryForTests(dbPath: string): boolean {
	return walMergeCache.has(dbPath);
}

/** Drops merged buffers nothing can serve from any more, so they aren't retained forever. */
function evictExpiredWalMergeCacheEntries(nowMs: number): void {
	for (const [key, entry] of walMergeCache) {
		if (nowMs - entry.attemptedAt >= WAL_MERGE_CACHE_RETENTION_MS) {
			walMergeCache.delete(key);
		}
	}
}

/**
 * Heuristic for "another process currently holds this db open in WAL mode", using only two
 * `fs.stat` checks — no process enumeration, no lock probing. `<db>-shm` exists only while some
 * process holds the db open in WAL mode; a recently-touched `<db>-wal` on top of that means it is
 * still being written to, not just left over from a process that has since exited.
 */
export function isWalWriterActive(dbPath: string, nowMs: number = Date.now()): boolean {
	if (!fs.existsSync(dbPath + '-shm')) { return false; }
	const walMtimeMs = getWalMtimeMs(dbPath);
	if (walMtimeMs === 0) { return false; }
	return nowMs - walMtimeMs <= WRITER_ACTIVE_WAL_RECENCY_MS;
}

/** The full identity (mtime + size) of `dbPath`, and of `dbPath` and its `-wal` sidecar. */
interface WalMergeEligibility {
	walPath: string;
	dbMtimeMs: number;
	dbSize: number;
	walMtimeMs: number;
	walSize: number;
}

/**
 * Returns the current db+wal fingerprint when `dbPath` has a non-empty WAL worth merging and the
 * COMBINED db+WAL size is small enough to copy, or `null` when a merge should be skipped outright
 * (no `-wal` file, an empty one, or db+wal together are above `MAX_WAL_MERGE_DB_SIZE_BYTES`).
 * Logs once (at debug level) the first time a path is skipped for being over the cap, so a large
 * db falling back to a WAL-blind read is discoverable instead of silent — see module docs.
 */
function checkWalMergeEligible(dbPath: string): WalMergeEligibility | null {
	const walPath = dbPath + '-wal';
	let walStat: fs.Stats;
	try {
		walStat = fs.statSync(walPath);
	} catch {
		return null; // No WAL file — no merge needed
	}
	if (walStat.size === 0) { return null; }

	let dbStat: fs.Stats;
	try {
		dbStat = fs.statSync(dbPath);
	} catch {
		return null;
	}
	// Cap the COMBINED footprint: performWalMerge copies both files, so the db alone being under
	// the cap doesn't bound the temp copy when the WAL itself is huge.
	if (dbStat.size + walStat.size > MAX_WAL_MERGE_DB_SIZE_BYTES) {
		if (!loggedOversizedPaths.has(dbPath)) {
			loggedOversizedPaths.add(dbPath);
			console.debug(
				`[sqliteWal] Skipping WAL merge for ${dbPath}: db (${dbStat.size} bytes) + wal (${walStat.size} bytes) `
				+ `exceed the ${MAX_WAL_MERGE_DB_SIZE_BYTES} byte cap — reads will be a plain, potentially stale `
				+ `snapshot of the main db file until the WAL shrinks below the cap or a checkpoint runs.`
			);
		}
		return null;
	}
	loggedOversizedPaths.delete(dbPath); // eligible again — a later regrowth past the cap should log again

	return { walPath, dbMtimeMs: dbStat.mtimeMs, dbSize: dbStat.size, walMtimeMs: walStat.mtimeMs, walSize: walStat.size };
}

/**
 * Copies `dbPath` + `walPath` (+ `-shm`, if present) to a temp location, uses node:sqlite to
 * checkpoint the WAL, and returns the merged buffer. Always cleans up its temp files, even when
 * a step above throws — otherwise a failed merge attempt leaks a temp DB (and, on Windows, a
 * still-open handle) on every such call.
 */
function performWalMerge(dbPath: string, walPath: string): Buffer {
	let tmpDb: string | undefined;
	let tmpWal: string | undefined;
	let tmpShm: string | undefined;
	let nativeDb: import('node:sqlite').DatabaseSync | undefined;
	try {
		const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
		const tmpDir = path.join(os.homedir(), '.copilot', 'tmp');
		fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
		tmpDb = path.join(tmpDir, `sqlite-wal-${path.basename(dbPath)}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
		tmpWal = tmpDb + '-wal';
		tmpShm = tmpDb + '-shm';
		const shmPath = dbPath + '-shm';

		fs.copyFileSync(dbPath, tmpDb);
		fs.copyFileSync(walPath, tmpWal);
		if (fs.existsSync(shmPath)) { fs.copyFileSync(shmPath, tmpShm); }

		nativeDb = new DatabaseSync(tmpDb);
		nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
		nativeDb.close();
		nativeDb = undefined;

		return fs.readFileSync(tmpDb);
	} finally {
		if (nativeDb) { try { nativeDb.close(); } catch { /* ignore */ } }
		for (const f of [tmpDb, tmpWal, tmpShm]) {
			if (!f) { continue; }
			try { fs.unlinkSync(f); } catch { /* ignore — may not have been created */ }
		}
	}
}

/**
 * Returns a fully checked-out buffer for `dbPath` with any pending WAL frames merged in, together
 * with the db+wal fingerprint those exact bytes were produced from — or `null` when there is no
 * WAL to merge (no `-wal` file, an empty one, the combined db+wal size is above
 * `MAX_WAL_MERGE_DB_SIZE_BYTES`, or `node:sqlite` is unavailable / the merge attempt failed and
 * nothing was ever cached for this path). Callers should fall back to a plain
 * `fs.readFileSync(dbPath)` (using the current file stat as the fingerprint) when this returns
 * null — `readDbBufferWithWalFingerprint` below does exactly that.
 *
 * Repeated calls for the same `dbPath` within the throttle window are served from an in-memory
 * cache of the last merge result instead of re-copying — see module docs. The fingerprint
 * returned for a cache-served buffer is the buffer's ORIGINAL fingerprint (when it was produced),
 * not a fresh stat of the current files: the whole point is that those bytes may now be stale, and
 * a caller that re-stats and stores "current" would hide that staleness — see #2036 review notes.
 *
 * The cached buffer is only served while the main db file's own identity (mtime+size) still
 * matches what produced it — a checkpoint or wholesale replacement of the main `.db` file during
 * the throttle window forces a fresh merge instead of silently reusing a buffer that predates it.
 * The WAL's mtime is deliberately NOT part of that reuse decision (reacting to every WAL touch is
 * what the throttle exists to prevent) — only whether the *main* file changed underneath it.
 */
export async function tryReadDbWithWalFingerprint(dbPath: string): Promise<WalReadResult | null> {
	const now = Date.now();
	// Run eviction before the eligibility check (not after it, behind an early return) so a path
	// that has gone ineligible (WAL gone/emptied, or grown past the cap) still gets its retained
	// buffer reclaimed instead of holding it for the life of the process.
	evictExpiredWalMergeCacheEntries(now);

	const eligible = checkWalMergeEligible(dbPath);
	if (!eligible) {
		walMergeCache.delete(dbPath); // drop it now rather than waiting out the retention window
		return null;
	}

	const cached = walMergeCache.get(dbPath);
	const minInterval = isWalWriterActive(dbPath, now) ? WAL_MERGE_WRITER_ACTIVE_INTERVAL_MS : WAL_MERGE_MIN_INTERVAL_MS;
	if (cached && now - cached.attemptedAt < minInterval) {
		const mainDbUnchanged = cached.dbMtimeMs === eligible.dbMtimeMs && cached.dbSize === eligible.dbSize;
		if (cached.buffer && mainDbUnchanged) {
			// Serve the previous merge result under its ORIGINAL fingerprint — see doc comment above.
			return { buffer: cached.buffer, dbMtimeMs: cached.dbMtimeMs, dbSize: cached.dbSize, walMtimeMs: cached.walMtimeMs, walSize: cached.walSize, walIncluded: true };
		}
		if (!cached.buffer) {
			return null; // a recent attempt already failed and produced nothing to serve — stay throttled
		}
		// cached.buffer exists but the main db file changed since — fall through to a fresh merge
		// rather than serving bytes that no longer reflect the main file (item 2).
	}

	try {
		const buffer = performWalMerge(dbPath, eligible.walPath);
		walMergeCache.set(dbPath, {
			buffer, attemptedAt: now,
			dbMtimeMs: eligible.dbMtimeMs, dbSize: eligible.dbSize, walMtimeMs: eligible.walMtimeMs, walSize: eligible.walSize,
		});
		return { buffer, dbMtimeMs: eligible.dbMtimeMs, dbSize: eligible.dbSize, walMtimeMs: eligible.walMtimeMs, walSize: eligible.walSize, walIncluded: true };
	} catch {
		// node:sqlite unavailable or copy/merge failed. This `catch` is only reached when either
		// nothing was cached yet, or the `mainDbUnchanged` check above found the main db file HAS
		// changed since the cached buffer was produced (that's precisely why we fell through to
		// attempting a fresh merge instead of serving the throttled buffer). Only serve the old
		// buffer under its old fingerprint in the FIRST case — the main db genuinely hasn't moved,
		// so this failure is a transient hiccup (e.g. a momentary lock) and the buffer is still
		// accurate. In the second case, serving it anyway would be actively misleading: a caller
		// whose own cache still holds that same old fingerprint (because it too has been unable to
		// observe the main-db change through this same call chain) would conclude nothing changed,
		// even though we positively know the main db has moved since — see #2036 review notes (Fix 2).
		const mainDbUnchangedSinceCache = !!cached && cached.dbMtimeMs === eligible.dbMtimeMs && cached.dbSize === eligible.dbSize;
		if (cached?.buffer && mainDbUnchangedSinceCache) {
			// Keep serving the last-good buffer (under its own original fingerprint), but record
			// this attempt so a merge that keeps failing is throttled too.
			cached.attemptedAt = now;
			return { buffer: cached.buffer, dbMtimeMs: cached.dbMtimeMs, dbSize: cached.dbSize, walMtimeMs: cached.walMtimeMs, walSize: cached.walSize, walIncluded: true };
		}
		// Either nothing usable was ever cached for this db, or the main db has changed since what
		// WAS cached — in both cases there is nothing honest left to serve under an old fingerprint.
		// Record the failed attempt anyway so a persistently failing path is throttled instead of
		// re-attempting the full copy/merge on every single call, and drop any now-stale buffer so
		// it can't be served later under a fingerprint that no longer matches its own main db state.
		walMergeCache.set(dbPath, {
			buffer: undefined, attemptedAt: now,
			dbMtimeMs: eligible.dbMtimeMs, dbSize: eligible.dbSize, walMtimeMs: eligible.walMtimeMs, walSize: eligible.walSize,
		});
		return null; // fall back to a fresh, honestly-fingerprinted direct read of the CURRENT main db
	}
}

/**
 * Same as {@link tryReadDbWithWalFingerprint}, returning just the buffer for callers that don't
 * need the fingerprint.
 */
export async function tryReadDbWithWal(dbPath: string): Promise<Buffer | null> {
	const result = await tryReadDbWithWalFingerprint(dbPath);
	return result ? result.buffer : null;
}

/** The `-wal` sidecar's mtime and size, or zeroes when no `-wal` file exists. */
function statWal(dbPath: string): { mtimeMs: number; size: number } {
	try {
		const stat = fs.statSync(dbPath + '-wal');
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return { mtimeMs: 0, size: 0 };
	}
}

/** The WAL sidecar's mtime in milliseconds, or 0 when no `-wal` file exists. */
export function getWalMtimeMs(dbPath: string): number {
	return statWal(dbPath).mtimeMs;
}

/**
 * The WAL sidecar's mtime AND size, or zeroes when no `-wal` file exists. Prefer this over
 * `getWalMtimeMs` alone for anything that caches a parsed db keyed on file identity: mtime
 * granularity is coarse on some filesystems (whole seconds on ext3/HFS+/FAT), so two WAL appends
 * inside one tick can leave the mtime identical while the file still grows — a cache keyed on
 * mtime alone would miss that and serve stale data. WAL frames are appended, so size always moves
 * on a write even when mtime cannot.
 */
export function getWalStat(dbPath: string): { mtimeMs: number; size: number } {
	return statWal(dbPath);
}

/** One directory to sweep, and the WAL-merge temp-file prefix(es) this helper's own code has ever written there. */
interface WalTempSweepTarget {
	dir: string;
	prefixes: string[];
}

/** Removes `filePath` if it is a plain file older than `minAgeMs`. Returns whether it removed it. */
async function removeIfStaleWalTempFile(filePath: string, minAgeMs: number, nowMs: number): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile() || nowMs - stat.mtimeMs < minAgeMs) { return false; }
		await fs.promises.unlink(filePath);
		return true;
	} catch {
		return false; // removed/locked concurrently, or stat/unlink failed — leave it alone
	}
}

/** Sweeps one directory, for only its own given prefix(es), for stale WAL-merge temp files. Returns how many it removed. */
async function sweepDirForStaleWalTempFiles(dir: string, prefixes: string[], minAgeMs: number, nowMs: number): Promise<number> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return 0; // directory missing/unreadable — nothing to sweep
	}
	let removed = 0;
	for (const name of entries) {
		if (!prefixes.some(prefix => name.startsWith(prefix))) { continue; }
		if (await removeIfStaleWalTempFile(path.join(dir, name), minAgeMs, nowMs)) { removed++; }
	}
	return removed;
}

/**
 * Best-effort sweep of stranded WAL-merge temp files. Earlier extension versions (<= 0.17.2)
 * copied Cursor's `state.vscdb` on every read without a `finally`-guarded cleanup, leaking
 * `cursor-wal-*` (+ `-wal`/`-shm` siblings) files into `os.tmpdir()` — see #2033. The current
 * helper writes `sqlite-wal-*` under `~/.copilot/tmp` instead, but nothing swept either
 * location before this. Runs once at activation (see extension.ts) to reclaim both.
 *
 * Conservative by design: only removes files whose name starts with a prefix AND are older than
 * `minAgeMs`; anything else — including any error — is left alone. Each directory is swept ONLY
 * for the prefix(es) this helper's own code has actually ever written there — never the other
 * directory's prefix — because BOTH directories are shared with other applications: `os.tmpdir()`
 * by every process on the machine, and `~/.copilot/tmp` by GitHub Copilot tooling broadly (it is
 * not exclusively this extension's directory either). Sweeping a plausible-but-foreign prefix out
 * of either one risks deleting a file that belongs to something else entirely — `sqlite-wal-*` is
 * a generic-sounding name this helper has never written into `os.tmpdir()`, so it is scoped to
 * `~/.copilot/tmp` only, where `performWalMerge` is the sole writer of that name.
 *
 * `dirsOverride` replaces the default [`os.tmpdir()` swept for `cursor-wal-*`, `~/.copilot/tmp`
 * swept for `sqlite-wal-*`] pair — for tests only; production callers should omit it.
 */
export async function sweepStaleWalTempFiles(minAgeMs: number = 60 * 60 * 1000, dirsOverride?: WalTempSweepTarget[]): Promise<number> {
	const targets = dirsOverride ?? [
		{ dir: os.tmpdir(), prefixes: ['cursor-wal-'] },
		{ dir: path.join(os.homedir(), '.copilot', 'tmp'), prefixes: ['sqlite-wal-'] },
	];
	const now = Date.now();
	let removed = 0;
	for (const { dir, prefixes } of targets) {
		removed += await sweepDirForStaleWalTempFiles(dir, prefixes, minAgeMs, now);
	}
	return removed;
}

/**
 * Reads `dbPath` as a buffer, merging in any pending WAL frames first when
 * possible. Always prefer this over a bare `fs.readFileSync(dbPath)` for
 * SQLite databases that another process may hold open in WAL mode.
 */
export async function readDbBufferWithWal(dbPath: string): Promise<Buffer> {
	const walBuffer = await tryReadDbWithWal(dbPath);
	return walBuffer ?? fs.readFileSync(dbPath);
}

/**
 * Same as {@link readDbBufferWithWal}, but always returns the db+wal fingerprint the returned
 * bytes actually reflect (never null) — for callers that key their own cache on file identity.
 *
 * Prefer this over pairing `readDbBufferWithWal` with a fresh `getWalMtimeMs(dbPath)` call after
 * the read: a merge served from the throttle cache can be older than "now", and re-stating the
 * WAL after the fact stamps the cache entry with a fingerprint the served bytes don't actually
 * match — see the #2036 review notes on `tryReadDbWithWalFingerprint` above. When no merge ran
 * (no WAL to merge, or the merge failed with nothing cached), the fingerprint is a fresh stat of
 * the plain file that was actually read, which is accurate since that read has no staleness window.
 */
export async function readDbBufferWithWalFingerprint(dbPath: string): Promise<WalReadResult> {
	const merged = await tryReadDbWithWalFingerprint(dbPath);
	if (merged) { return merged; }

	// No merge ran — fall back to a plain read. Open once and take both the stat and the bytes
	// from that one descriptor rather than stat'ing the path and then reading it: a separate
	// stat-then-read pair re-resolves the path, so a file replaced in between yields a
	// fingerprint describing one file and bytes from another — precisely the mismatch this
	// return value exists to prevent (and a CodeQL TOCTOU finding on the earlier form).
	const fd = fs.openSync(dbPath, 'r');
	let buffer: Buffer;
	let dbStat: fs.Stats;
	try {
		dbStat = fs.fstatSync(fd);
		buffer = fs.readFileSync(fd);
	} finally {
		try { fs.closeSync(fd); } catch { /* ignore */ }
	}
	const wal = statWal(dbPath);
	return {
		buffer, dbMtimeMs: dbStat.mtimeMs, dbSize: dbStat.size, walMtimeMs: wal.mtimeMs, walSize: wal.size,
		// This read is WAL-blind — it never merged in the `-wal` sidecar's frames. That's harmless
		// when there is nothing pending there to have missed (`wal.size === 0`), but honest callers
		// with their own settle-and-cache logic must know when it's NOT harmless (a non-empty WAL
		// existed but wasn't folded in) — see the `walIncluded` doc comment on `WalReadResult`.
		walIncluded: wal.size === 0,
	};
}
