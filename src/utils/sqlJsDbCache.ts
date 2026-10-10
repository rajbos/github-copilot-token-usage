/**
 * Shared sql.js lifecycle for data-access classes that read a single local SQLite DB
 * (OpenCode, Kilo Code): lazy WASM init, one cached parsed Database, and cleanup.
 */
/// <reference types="sql.js" />
import * as fs from 'fs';
import * as path from 'path';
import initSqlJs from 'sql.js';

export type SqlJsStatic = initSqlJs.SqlJsStatic;
export type SqlDatabase = initSqlJs.Database;

// walSize (not just walMtimeMs) is part of the cache identity: mtime granularity is coarse on
// some filesystems, so two WAL appends inside one tick can leave the mtime unchanged while the
// WAL still grows — see getWalStat's doc comment and #2036 review notes (Fix 1b).
export type SqlJsDbCache = { db: SqlDatabase; mtimeMs: number; size: number; path: string; walMtimeMs: number; walSize: number };

export abstract class SqlJsDbCacheBase {
	protected _sqlJsModule: SqlJsStatic | null = null;
	protected _sqlJsInitPromise: Promise<SqlJsStatic> | null = null;
	protected _dbCache: SqlJsDbCache | null = null;
	protected _dbCacheInflight: Map<string, Promise<SqlDatabase | null>> = new Map();
	// A single trailing slot for the most recent WAL-blind (`walIncluded: false`) parsed Database —
	// still usable for the call that just produced it, but deliberately NOT installed as `_dbCache`
	// (a WAL-blind read must not be treated as settled). Held here — rather than closed
	// immediately — only so its underlying WASM memory is still reclaimed (on the next read, or on
	// `dispose()`) instead of leaking.
	protected _pendingTransientDb: SqlDatabase | null = null;

	/**
	 * Lazily initialize and return the sql.js SQL module.
	 *
	 * Promise-caches the in-flight load so concurrent callers share a single
	 * WASM initialization rather than each starting an independent load.
	 * The cache is reset on failure so a transient error is retryable.
	 */
	async initSqlJs(): Promise<SqlJsStatic> {
		if (this._sqlJsModule) { return this._sqlJsModule; }
		if (!this._sqlJsInitPromise) {
			this._sqlJsInitPromise = (async () => {
				const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
				let wasmBinary: Uint8Array | undefined;
				if (fs.existsSync(wasmPath)) {
					wasmBinary = fs.readFileSync(wasmPath);
				}
				const module = await initSqlJs(wasmBinary ? { wasmBinary: wasmBinary.buffer as ArrayBuffer } : undefined);
				this._sqlJsModule = module;
				return module;
			})().catch(err => {
				this._sqlJsInitPromise = null;
				throw err;
			});
		}
		return this._sqlJsInitPromise;
	}

	dispose(): void {
		this.closeDbCache();
		this.releasePendingTransientDb();
		this._dbCacheInflight.clear();
		this._sqlJsInitPromise = null;
	}

	protected closeDb(db: SqlDatabase): void {
		try { db.close(); } catch { /* ignore */ }
	}

	protected closeDbCache(): void {
		if (this._dbCache) {
			this.closeDb(this._dbCache.db);
			this._dbCache = null;
		}
	}

	protected releasePendingTransientDb(): void {
		if (this._pendingTransientDb) {
			this.closeDb(this._pendingTransientDb);
			this._pendingTransientDb = null;
		}
	}

	protected getCachedDbForPath(dbPath: string): SqlDatabase | null {
		return this._dbCache?.path === dbPath ? this._dbCache.db : null;
	}

	protected isMissingFileError(error: unknown): boolean {
		const code = (error as NodeJS.ErrnoException)?.code;
		return code === 'ENOENT' || code === 'ENOTDIR';
	}
}
