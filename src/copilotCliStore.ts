/**
 * CopilotCliStoreAccess — reads session metadata from ~/.copilot/session-store.db.
 *
 * The Copilot CLI persists all sessions (both worktree-backed and chat-only) in a
 * central SQLite database at ~/.copilot/session-store.db. Worktree sessions also
 * produce an events.jsonl file under ~/.copilot/session-state/<uuid>/; chat-only
 * sessions (started without any project open, repository IS NULL) exist only in
 * the database.
 *
 * Virtual path scheme: <absolute-path-to-db>#<session-uuid>
 * Example (Windows): C:\Users\alice\.copilot\session-store.db#3ee22c56-...
 * Example (Unix):    /home/alice/.copilot/session-store.db#3ee22c56-...
 *
 * The '#' character acts as a separator identical to the pattern used by Crush
 * (crush.db#<uuid>) and OpenCode (opencode.db#ses_<id>).
 */
/// <reference types="sql.js" />
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs from 'sql.js';
import { SqlJsFileDbCacheBase } from './utils/sqlJsDbCache';
import type { ModelUsage } from './types';
import { toLocalDayKey } from './utils/dayKeys';
import { isUnsafeObjectKey } from './utils/protoGuard';

// Access SqlJsStatic and Database via the globally declared initSqlJs namespace
// (made available by the /// <reference types="sql.js" /> directive above).
type SqlJsStatic = initSqlJs.SqlJsStatic;
type SqlValue = initSqlJs.SqlValue;

export interface CliStoreSession {
	id: string;
	cwd: string | null;
	repository: string | null;
	branch: string | null;
	summary: string | null;
	created_at: string | null;
	updated_at: string | null;
}

/**
 * Returns true when the session's cwd indicates it was created by Microsoft Scout.
 * Scout stores sessions under Documents\Microsoft Scout (or Documents/Microsoft Scout).
 */
export function isMicrosoftScoutCwd(cwd: string | null | undefined): boolean {
	if (!cwd) { return false; }
	return cwd.replace(/\\/g, '/').toLowerCase().includes('/microsoft scout');
}

/**
 * Returns true when a session's workspace.yaml `client_name` value indicates it was
 * started via the Copilot desktop app (which wraps the CLI process), as opposed to the
 * plain terminal CLI (`github/cli`) or an older session predating this field.
 */
export function isCopilotAppClientName(clientName: string | null | undefined): boolean {
	return clientName === 'github/autopilot';
}

export interface CliStoreTurn {
	session_id: string;
	turn_index: number;
	user_message: string | null;
	assistant_response: string | null;
	timestamp: string | null;
}

export function isCliStoreSession(obj: unknown): obj is CliStoreSession {
	if (typeof obj !== 'object' || obj === null) { return false; }
	const r = obj as Record<string, unknown>;
	return typeof r['id'] === 'string'
		&& (r['cwd'] === null || typeof r['cwd'] === 'string')
		&& (r['repository'] === null || typeof r['repository'] === 'string')
		&& (r['branch'] === null || typeof r['branch'] === 'string')
		&& (r['summary'] === null || typeof r['summary'] === 'string')
		&& (r['created_at'] === null || typeof r['created_at'] === 'string')
		&& (r['updated_at'] === null || typeof r['updated_at'] === 'string');
}

export function isCliStoreTurn(obj: unknown): obj is CliStoreTurn {
	if (typeof obj !== 'object' || obj === null) { return false; }
	const r = obj as Record<string, unknown>;
	return typeof r['session_id'] === 'string'
		&& typeof r['turn_index'] === 'number'
		&& (r['user_message'] === null || typeof r['user_message'] === 'string')
		&& (r['assistant_response'] === null || typeof r['assistant_response'] === 'string')
		&& (r['timestamp'] === null || typeof r['timestamp'] === 'string');
}

/** One parsed row from the `assistant_usage_events` billing table. */
type UsageEventRow = {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	nanoAiu: number;
};

type CliStoreSessionsCacheEntry = { mtimeMs: number; size: number; byId: Map<string, CliStoreSession> };
type CliStoreTurnCountsCacheEntry = { mtimeMs: number; size: number; byId: Map<string, number> };
type CliStoreUsage = { modelUsage: ModelUsage; actualTokens: number; cacheReadTokens: number; nanoAiu: number };
type CliStoreUsageCacheEntry = { mtimeMs: number; size: number; bySessionId: Map<string, CliStoreUsage> };

export class CopilotCliStoreAccess extends SqlJsFileDbCacheBase {
	private _initSqlJsFn: typeof initSqlJs;
	// Bulk-loaded caches keyed by dbPath, invalidated on the same mtime/size basis
	// as _dbCache. Populated by a single query over ALL sessions/turns instead of
	// one query per session — see getSessionsMap()/getTurnCountsMap() for why.
	private _sessionsCache: Map<string, CliStoreSessionsCacheEntry> = new Map();
	private _sessionsCacheInflight: Map<string, Promise<Map<string, CliStoreSession>>> = new Map();
	private _turnCountsCache: Map<string, CliStoreTurnCountsCacheEntry> = new Map();
	private _turnCountsCacheInflight: Map<string, Promise<Map<string, number>>> = new Map();
	private _usageCache: Map<string, CliStoreUsageCacheEntry> = new Map();
	private _usageCacheInflight: Map<string, Promise<Map<string, CliStoreUsage>>> = new Map();

	constructor(initSqlJsFn?: typeof initSqlJs) {
		super();
		this._initSqlJsFn = initSqlJsFn ?? initSqlJs;
	}

	dispose(): void {
		super.dispose();
		this._sessionsCache.clear();
		this._sessionsCacheInflight.clear();
		this._turnCountsCache.clear();
		this._turnCountsCacheInflight.clear();
		this._usageCache.clear();
		this._usageCacheInflight.clear();
	}

	protected override createSqlJs(config?: { wasmBinary: ArrayBuffer }): Promise<SqlJsStatic> {
		return this._initSqlJsFn(config);
	}

	/** Absolute path to ~/.copilot/session-store.db. */
	getDbPath(): string {
		return path.join(os.homedir(), '.copilot', 'session-store.db');
	}

	/** Build a virtual session path for the given session UUID. */
	virtualPath(sessionId: string): string {
		return `${this.getDbPath()}#${sessionId}`;
	}

	/** Returns true if the path is a session-store virtual path. */
	isCliStoreSession(filePath: string): boolean {
		return filePath.includes('session-store.db#');
	}

	/** Extract the real DB file path from a virtual session path. */
	getDbPathFromVirtual(virtualPath: string): string {
		const idx = virtualPath.indexOf('session-store.db#');
		if (idx === -1) { return virtualPath; }
		return virtualPath.substring(0, idx + 'session-store.db'.length);
	}

	/** Extract the session UUID from a virtual session path. */
	getSessionId(virtualPath: string): string | null {
		const idx = virtualPath.indexOf('session-store.db#');
		if (idx === -1) { return null; }
		const id = virtualPath.substring(idx + 'session-store.db#'.length);
		return id || null;
	}

	/**
	 * Returns a cached id → session map for the whole DB, populated by a single
	 * bulk query instead of one query per session.
	 *
	 * Why this matters: readSession()/stat()/countTurns() used to run a
	 * `WHERE id = ?` (or `WHERE session_id = ?`) query per call. sql.js has no
	 * index on these columns, so each lookup is a full table scan. Calling that
	 * once per session while iterating N sessions (e.g. during diagnostics file
	 * discovery/sorting) is O(N) scans of an O(N)-row table — O(N²) overall,
	 * which is what made the Diagnostics screen feel "ages" slow once a user
	 * accumulated a few thousand Copilot CLI chat sessions. One bulk query up
	 * front turns this into O(N) total.
	 */
	private async getSessionsMap(dbPath: string): Promise<Map<string, CliStoreSession>> {
		const stats = await this.statDb(dbPath);
		if (!stats) { return this._sessionsCache.get(dbPath)?.byId ?? new Map(); }

		const cached = this._sessionsCache.get(dbPath);
		if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
			return cached.byId;
		}

		const cacheKey = `${dbPath}:${stats.mtimeMs}:${stats.size}`;
		const inflight = this._sessionsCacheInflight.get(cacheKey);
		if (inflight) { return inflight; }

		const loadPromise = (async () => {
			const db = await this.getDb(dbPath);
			const byId = new Map<string, CliStoreSession>();
			if (db) {
				try {
					const result = db.exec('SELECT id, cwd, repository, branch, summary, created_at, updated_at FROM sessions');
					if (result.length > 0) {
						const cols = result[0].columns;
						for (const row of result[0].values) {
							const obj: Record<string, unknown> = {};
							cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
							if (isCliStoreSession(obj)) { byId.set(obj.id, obj); }
						}
					}
				} catch { /* leave byId empty on query failure */ }
			}
			this._sessionsCache.set(dbPath, { mtimeMs: stats.mtimeMs, size: stats.size, byId });
			return byId;
		})();
		this._sessionsCacheInflight.set(cacheKey, loadPromise);
		try {
			return await loadPromise;
		} finally {
			if (this._sessionsCacheInflight.get(cacheKey) === loadPromise) {
				this._sessionsCacheInflight.delete(cacheKey);
			}
		}
	}

	/** Returns a cached session_id → turn count map for the whole DB, populated by a single GROUP BY query. */
	private async getTurnCountsMap(dbPath: string): Promise<Map<string, number>> {
		const stats = await this.statDb(dbPath);
		if (!stats) { return this._turnCountsCache.get(dbPath)?.byId ?? new Map(); }

		const cached = this._turnCountsCache.get(dbPath);
		if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
			return cached.byId;
		}

		const cacheKey = `${dbPath}:${stats.mtimeMs}:${stats.size}`;
		const inflight = this._turnCountsCacheInflight.get(cacheKey);
		if (inflight) { return inflight; }

		const loadPromise = (async () => {
			const db = await this.getDb(dbPath);
			const byId = new Map<string, number>();
			if (db) {
				try {
					const result = db.exec('SELECT session_id, COUNT(*) FROM turns GROUP BY session_id');
					if (result.length > 0) {
						for (const row of result[0].values) {
							byId.set(row[0] as string, (row[1] as number) || 0);
						}
					}
				} catch { /* leave byId empty on query failure */ }
			}
			this._turnCountsCache.set(dbPath, { mtimeMs: stats.mtimeMs, size: stats.size, byId });
			return byId;
		})();
		this._turnCountsCacheInflight.set(cacheKey, loadPromise);
		try {
			return await loadPromise;
		} finally {
			if (this._turnCountsCacheInflight.get(cacheKey) === loadPromise) {
				this._turnCountsCacheInflight.delete(cacheKey);
			}
		}
	}

	/**
	 * Returns exact usage grouped by session. Loading this table once avoids a full
	 * sql.js scan for every DB-only Copilot CLI session during startup.
	 */
	private async getUsageMap(dbPath: string): Promise<Map<string, CliStoreUsage>> {
		const stats = await this.statDb(dbPath);
		if (!stats) { return this._usageCache.get(dbPath)?.bySessionId ?? new Map(); }

		const cached = this._usageCache.get(dbPath);
		if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
			return cached.bySessionId;
		}

		const cacheKey = `${dbPath}:${stats.mtimeMs}:${stats.size}`;
		const inflight = this._usageCacheInflight.get(cacheKey);
		if (inflight) { return inflight; }

		const loadPromise = (async () => {
			const db = await this.getDb(dbPath);
			const bySessionId = new Map<string, CliStoreUsage>();
			if (db) {
				try {
					const result = db.exec('SELECT session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_nano_aiu FROM assistant_usage_events');
					if (result.length > 0) {
						const columns = result[0].columns;
						const sessionIdIndex = columns.indexOf('session_id');
						for (const row of result[0].values) {
							const sessionId = row[sessionIdIndex];
							if (typeof sessionId !== 'string') { continue; }
							const event = this.parseUsageEventRow(columns, row);
							this.addUsageEventToSessionUsage(bySessionId, sessionId, event);
						}
						this.removeEmptyUsage(bySessionId);
					}
				} catch { /* leave bySessionId empty on query failure */ }
			}
			this._usageCache.set(dbPath, { mtimeMs: stats.mtimeMs, size: stats.size, bySessionId });
			return bySessionId;
		})();
		this._usageCacheInflight.set(cacheKey, loadPromise);
		try {
			return await loadPromise;
		} finally {
			if (this._usageCacheInflight.get(cacheKey) === loadPromise) {
				this._usageCacheInflight.delete(cacheKey);
			}
		}
	}

	private addUsageEventToSessionUsage(bySessionId: Map<string, CliStoreUsage>, sessionId: string, event: UsageEventRow): void {
		let usage = bySessionId.get(sessionId);
		if (!usage) {
			usage = { modelUsage: {}, actualTokens: 0, cacheReadTokens: 0, nanoAiu: 0 };
			bySessionId.set(sessionId, usage);
		}
		this.addUsageEventToModelUsage(usage.modelUsage, event);
		usage.actualTokens += event.inputTokens + event.outputTokens;
		usage.cacheReadTokens += event.cacheReadTokens;
		usage.nanoAiu += event.nanoAiu;
	}

	private removeEmptyUsage(bySessionId: Map<string, CliStoreUsage>): void {
		for (const [sessionId, usage] of bySessionId) {
			if (usage.actualTokens === 0 && usage.cacheReadTokens === 0 && usage.nanoAiu === 0) {
				bySessionId.delete(sessionId);
			}
		}
	}

	/**
	 * Stat a virtual session-store.db session path.
	 *
	 * IMPORTANT: this must NOT simply return `fs.stat()` on the shared .db file —
	 * every chat-only session would then report an identical, always-very-recent
	 * mtime (whenever the DB was last touched by *any* session), making hundreds
	 * of unrelated sessions look like the most recently modified files on disk.
	 * That starved out every other editor from mtime-sorted/capped file lists
	 * (e.g. the Diagnostics screen's session cache). Instead, use this session's
	 * own `updated_at` column so each virtual session gets its real, distinct mtime.
	 */
	async stat(virtualPath: string): Promise<fs.Stats> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		const baseStats = await fs.promises.stat(dbPath);
		const session = sessionId ? (await this.getSessionsMap(dbPath)).get(sessionId) : undefined;
		const updatedAt = session?.updated_at ? new Date(session.updated_at) : null;
		if (!updatedAt || Number.isNaN(updatedAt.getTime())) { return baseStats; }
		Object.defineProperty(baseStats, 'mtime', { value: updatedAt, writable: false });
		return baseStats;
	}

	/**
	 * Discover all session IDs in the DB whose UUIDs are NOT in `knownUuids`.
	 * These are sessions that exist only in the DB (no events.jsonl on disk).
	 * Returned in descending updated_at order (most recent first).
	 */
	async discoverNewSessions(knownUuids: Set<string>): Promise<string[]> {
		const dbPath = this.getDbPath();
		const db = await this.getDb(dbPath);
		if (!db) { return []; }
		try {
			const result = db.exec('SELECT id FROM sessions ORDER BY updated_at DESC');
			if (result.length === 0) { return []; }
			return result[0].values
				.map(row => row[0] as string)
				.filter(id => !knownUuids.has(id));
		} catch {
			return [];
		}
	}

	/**
	 * Discover all session IDs and their cwd values, excluding `knownUuids`.
	 * Used to identify Microsoft Scout sessions at discovery time.
	 */
	async discoverNewSessionsWithCwd(knownUuids: Set<string>): Promise<{ id: string; cwd: string | null }[]> {
		const dbPath = this.getDbPath();
		const db = await this.getDb(dbPath);
		if (!db) { return []; }
		try {
			const result = db.exec('SELECT id, cwd FROM sessions ORDER BY updated_at DESC');
			if (result.length === 0) { return []; }
			return result[0].values
				.filter(row => !knownUuids.has(row[0] as string))
				.map(row => ({ id: row[0] as string, cwd: (row[1] as string | null) ?? null }));
		} catch {
			return [];
		}
	}

	/** Read session metadata for a virtual session path. Uses the bulk-loaded sessions map (see getSessionsMap()). */
	async readSession(virtualPath: string): Promise<CliStoreSession | null> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return null; }
		const byId = await this.getSessionsMap(dbPath);
		return byId.get(sessionId) ?? null;
	}

	/** Read all turns for a session, ordered by turn_index. */
	async getTurns(virtualPath: string): Promise<CliStoreTurn[]> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return []; }
		const db = await this.getDb(dbPath);
		if (!db) { return []; }
		try {
			const result = db.exec(
				'SELECT session_id, turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index ASC',
				[sessionId],
			);
			if (result.length === 0) { return []; }
			const cols = result[0].columns;
			const turns: CliStoreTurn[] = [];
			for (const row of result[0].values) {
				const obj: Record<string, unknown> = {};
				cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
				if (isCliStoreTurn(obj)) {
					turns.push(obj);
				}
			}
			return turns;
		} catch {
			return [];
		}
	}

	/** Count turns (user interactions) for a session. Uses the bulk-loaded turn-counts map (see getTurnCountsMap()). */
	async countTurns(virtualPath: string): Promise<number> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return 0; }
		const byId = await this.getTurnCountsMap(dbPath);
		return byId.get(sessionId) ?? 0;
	}

	/**
	 * Returns exact per-model token/cost usage from the `assistant_usage_events`
	 * billing table for a session UUID. Returns null when the table is missing,
	 * the session has no rows, or the DB cannot be read.
	 *
	 * `input_tokens` already includes cache-write creation tokens, matching the
	 * `inputTokens` meaning used elsewhere. `cache_read_tokens` is tracked
	 * separately and exposed as `cachedReadTokens`; `cache_write_tokens` is
	 * exposed as `cacheCreationTokens`. `total_nano_aiu` is summed to
	 * `nanoAiu` so callers can compute exact dollar cost.
	 */
	async getSessionUsage(sessionId: string): Promise<CliStoreUsage | null> {
		const dbPath = this.getDbPath();
		const usageBySessionId = await this.getUsageMap(dbPath);
		return usageBySessionId.get(sessionId) ?? null;
	}

	/** Parse one `assistant_usage_events` row into a typed record, defaulting non-numeric fields to 0. */
	private parseUsageEventRow(cols: string[], row: SqlValue[]): UsageEventRow {
		const obj: Record<string, unknown> = {};
		cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
		return {
			model: typeof obj.model === 'string' ? obj.model : 'unknown',
			inputTokens: typeof obj.input_tokens === 'number' ? obj.input_tokens : 0,
			outputTokens: typeof obj.output_tokens === 'number' ? obj.output_tokens : 0,
			cacheReadTokens: typeof obj.cache_read_tokens === 'number' ? obj.cache_read_tokens : 0,
			cacheWriteTokens: typeof obj.cache_write_tokens === 'number' ? obj.cache_write_tokens : 0,
			nanoAiu: typeof obj.total_nano_aiu === 'number' ? obj.total_nano_aiu : 0,
		};
	}

	/** Merge a single usage event into the per-model accumulator (cache fields only when > 0). */
	private addUsageEventToModelUsage(modelUsage: ModelUsage, event: UsageEventRow): void {
		// Untrusted `model` string read from session-store.db rows — see protoGuard.ts.
		if (isUnsafeObjectKey(event.model)) { return; }
		if (!modelUsage[event.model]) { modelUsage[event.model] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
		const usage = modelUsage[event.model];
		usage.inputTokens += event.inputTokens;
		usage.outputTokens += event.outputTokens;
		if (event.cacheReadTokens > 0) { usage.cachedReadTokens = (usage.cachedReadTokens ?? 0) + event.cacheReadTokens; }
		if (event.cacheWriteTokens > 0) { usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + event.cacheWriteTokens; }
	}

	/**
	 * Returns per-local-day fractions for accurate session attribution.
	 * Uses turn timestamps when available; falls back to a single entry at
	 * the session's updated_at date.
	 */
	async getDailyFractions(virtualPath: string): Promise<Record<string, number>> {
		const turns = await this.getTurns(virtualPath);
		const counts: Record<string, number> = {};
		let total = 0;
		for (const turn of turns) {
			if (!turn.timestamp) { continue; }
			try {
				const turnDate = new Date(turn.timestamp);
				if (isNaN(turnDate.getTime())) { continue; }
				const dateKey = toLocalDayKey(turnDate);
				counts[dateKey] = (counts[dateKey] || 0) + 1;
				total++;
			} catch { /* skip malformed timestamp */ }
		}
		if (total === 0) {
			// Fallback: use session updated_at
			const session = await this.readSession(virtualPath);
			const fallbackDate = session?.updated_at
				? toLocalDayKey(new Date(session.updated_at))
				: toLocalDayKey(new Date());
			return { [fallbackDate]: 1.0 };
		}
		const fractions: Record<string, number> = {};
		for (const [day, count] of Object.entries(counts)) {
			fractions[day] = count / total;
		}
		return fractions;
	}
}
