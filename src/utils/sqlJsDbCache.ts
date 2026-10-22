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

export type SqlJsFileDbEntry = { db: SqlDatabase; mtimeMs: number; size: number };

/**
 * Shared sql.js lifecycle for data-access classes that read several local SQLite files
 * (Codex CLI, Copilot CLI store, Devin CLI, Hermes): lazy WASM init plus one parsed Database
 * per path, re-opened only when the file's mtime/size change, with single-flight dedup.
 */
export abstract class SqlJsFileDbCacheBase {
	protected _sqlJsModule: SqlJsStatic | null = null;
	protected _sqlJsInitPromise: Promise<SqlJsStatic> | null = null;
	protected _dbCache: Map<string, SqlJsFileDbEntry> = new Map();
	protected _dbCacheInflight: Map<string, Promise<SqlDatabase | null>> = new Map();

	dispose(): void {
		for (const entry of this._dbCache.values()) {
			try { entry.db.close(); } catch { /* ignore */ }
		}
		this._dbCache.clear();
		this._dbCacheInflight.clear();
		this._sqlJsInitPromise = null;
	}

	/** Factory for the sql.js module; overridable so a subclass can inject a stub. */
	protected createSqlJs(config?: { wasmBinary: ArrayBuffer }): Promise<SqlJsStatic> {
		return initSqlJs(config);
	}

	/** Lazily initialise and cache the sql.js WASM module. */
	async initSqlJs(): Promise<SqlJsStatic> {
		if (this._sqlJsModule) { return this._sqlJsModule; }
		if (!this._sqlJsInitPromise) {
			this._sqlJsInitPromise = (async () => {
				const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
				let wasmBinary: Uint8Array | undefined;
				try {
					wasmBinary = await fs.promises.readFile(wasmPath);
				} catch { /* WASM file not present — proceed without pre-loaded binary */ }
				const module = await this.createSqlJs(wasmBinary ? { wasmBinary: wasmBinary.buffer as ArrayBuffer } : undefined);
				this._sqlJsModule = module;
				return module;
			})().catch(err => {
				this._sqlJsInitPromise = null;
				throw err;
			});
		}
		return this._sqlJsInitPromise;
	}

	protected closeDb(db: SqlDatabase): void {
		try { db.close(); } catch { /* ignore */ }
	}

	protected isMissingFileError(error: unknown): boolean {
		const code = (error as NodeJS.ErrnoException)?.code;
		return code === 'ENOENT' || code === 'ENOTDIR';
	}

	protected async statDb(dbPath: string): Promise<fs.Stats | null> {
		try {
			return await fs.promises.stat(dbPath);
		} catch (error) {
			if (this.isMissingFileError(error) && this._dbCache.has(dbPath)) {
				this.closeDb(this._dbCache.get(dbPath)!.db);
				this._dbCache.delete(dbPath);
			}
			return null;
		}
	}

	protected isCachedDbCurrent(dbPath: string, stats: fs.Stats): boolean {
		const entry = this._dbCache.get(dbPath);
		return !!entry && entry.mtimeMs === stats.mtimeMs && entry.size === stats.size;
	}

	protected sameDbStats(left: fs.Stats, right: fs.Stats): boolean {
		return left.mtimeMs === right.mtimeMs && left.size === right.size;
	}

	protected async refreshDb(dbPath: string, stats: fs.Stats): Promise<SqlDatabase | null> {
		let db: SqlDatabase;
		try {
			const SQL = await this.initSqlJs();
			const buffer = await fs.promises.readFile(dbPath);
			db = new SQL.Database(buffer);
		} catch {
			return this._dbCache.get(dbPath)?.db ?? null;
		}
		const currentStats = await this.statDb(dbPath);
		if (!currentStats || !this.sameDbStats(stats, currentStats)) {
			this.closeDb(db);
			return this._dbCache.get(dbPath)?.db ?? null;
		}
		const existing = this._dbCache.get(dbPath);
		if (existing) { this.closeDb(existing.db); }
		this._dbCache.set(dbPath, { db, mtimeMs: stats.mtimeMs, size: stats.size });
		return db;
	}

	/**
	 * Returns a cached SQL.Database instance, re-opening only when the file's
	 * mtime/size change. Single-flight deduplication prevents duplicate reads.
	 */
	protected async getDb(dbPath: string): Promise<SqlDatabase | null> {
		const stats = await this.statDb(dbPath);
		if (!stats) { return this._dbCache.get(dbPath)?.db ?? null; }
		if (this.isCachedDbCurrent(dbPath, stats)) { return this._dbCache.get(dbPath)!.db; }
		const cacheKey = `${dbPath}:${stats.mtimeMs}:${stats.size}`;
		const inflight = this._dbCacheInflight.get(cacheKey);
		if (inflight) { return inflight; }
		const createDbPromise = this.refreshDb(dbPath, stats);
		this._dbCacheInflight.set(cacheKey, createDbPromise);
		try {
			return await createDbPromise;
		} finally {
			if (this._dbCacheInflight.get(cacheKey) === createDbPromise) {
				this._dbCacheInflight.delete(cacheKey);
			}
		}
	}

	protected rowsToObjects(result: initSqlJs.QueryExecResult[]): Record<string, unknown>[] {
		if (result.length === 0) { return []; }
		const { columns, values } = result[0];
		return values.map(row => {
			const obj: Record<string, unknown> = {};
			columns.forEach((c, i) => { obj[c] = row[i]; });
			return obj;
		});
	}
}
