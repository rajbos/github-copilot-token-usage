/**
 * HermesDataAccess — reads session data from Hermes Agent's global SQLite database.
 *
 * Hermes Agent is an open-source multi-platform AI assistant CLI/desktop app. All
 * sessions across every integration surface (desktop, subagent, and likely others such
 * as telegram/slack/cli) are stored in a single global SQLite database at the root of
 * HERMES_HOME:
 *   Windows:     %LOCALAPPDATA%\hermes\state.db  (NOT %USERPROFILE%\.hermes — confirmed
 *                via logs/bootstrap-installer.log: "Set HERMES_HOME=...\AppData\Local\hermes")
 *   Linux/macOS: ~/.hermes/state.db (inferred from internal log strings referencing
 *                "~/.hermes/skills/"; not verified on a live install)
 *   HERMES_HOME env var overrides the default on any platform — same convention as
 *   Codex CLI's CODEX_HOME (see codexcli.ts).
 *
 * The `sessions/` folder that also exists under HERMES_HOME is empty/unused — ignore it.
 * Other DBs found in HERMES_HOME (projects.db, verification_evidence.db, cron/executions.db)
 * are unrelated subsystems and are NOT session data — do not treat them as session files.
 * Similarly, a `hermes-agent/` subfolder (a git clone of the Hermes source) is not user data.
 *
 * Virtual path scheme: `<state.db path>#<session_id>`
 * Example: `C:\Users\RobBos\AppData\Local\hermes\state.db#20260726_204744_427b88`
 * Mirrors Crush's `crush.db#<uuid>` / Devin CLI's `sessions.db#<id>` convention.
 *
 * Timestamps (`sessions.started_at`/`ended_at`, `messages.timestamp`) are Unix epoch
 * SECONDS — multiply by 1000 before constructing JS Dates.
 *
 * Sessions form a parent/child relationship for delegated work: a session with
 * `source = 'subagent'` has `parent_session_id` pointing at the originating session.
 * The `async_delegations` table has richer dispatch/completion metadata but is not
 * required for basic session discovery/display and is not queried here.
 *
 * `session_model_usage` is the authoritative per-model token/cost breakdown, split by
 * `task` ('' for the main conversation, 'title_generation' for the async background
 * title-generation call). getModelUsage()/getTokens() exclude 'title_generation' rows so
 * that async housekeeping calls don't pollute the main per-model breakdown — they fall
 * back to the flat `sessions` columns only when no non-housekeeping usage rows exist.
 */
/// <reference types="sql.js" />
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs from 'sql.js';
import type { ModelUsage } from './types';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { toLocalDayKey } from './utils/dayKeys';
import { STAGE_THRESHOLDS } from './maturityScoring';

type SqlJsStatic = initSqlJs.SqlJsStatic;
type SqlDatabase = initSqlJs.Database;

const DB_MARKER = 'hermes/state.db#';

/** A background/housekeeping task on session_model_usage — excluded from the main usage totals. */
const HOUSEKEEPING_TASK = 'title_generation';

export interface HermesSession {
	id: string;
	source: string | null;
	display_name: string | null;
	model: string | null;
	started_at: number | null;
	ended_at: number | null;
	message_count: number | null;
	tool_call_count: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	reasoning_tokens: number | null;
	cwd: string | null;
	git_branch: string | null;
	git_repo_root: string | null;
	title: string | null;
	api_call_count: number | null;
	parent_session_id: string | null;
	archived: number | null;
	pinned: number | null;
}

export interface HermesMessage {
	id: number;
	session_id: string;
	role: string | null;
	content: string | null;
	tool_call_id: string | null;
	tool_calls: string | null;
	tool_name: string | null;
	timestamp: number | null;
	token_count: number | null;
	reasoning: string | null;
	reasoning_content: string | null;
	finish_reason: string | null;
	active: number | null;
	compacted: number | null;
}

export interface HermesModelUsageRow {
	session_id: string;
	model: string | null;
	task: string | null;
	api_call_count: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	reasoning_tokens: number | null;
}

/** A single parsed tool_calls[] entry from an assistant message. */
export interface HermesParsedToolCall {
	id: string | null;
	name: string;
	arguments: string | undefined;
}

type DbCacheEntry = { db: SqlDatabase; mtimeMs: number; size: number };

export class HermesDataAccess {
	private _sqlJsModule: SqlJsStatic | null = null;
	private _sqlJsInitPromise: Promise<SqlJsStatic> | null = null;
	private _dbCache: Map<string, DbCacheEntry> = new Map();
	private _dbCacheInflight: Map<string, Promise<SqlDatabase | null>> = new Map();
	/** Test-only override for the state.db path, so tests don't depend on the real OS default location. */
	private _dbPathOverride: string | null = null;

	dispose(): void {
		for (const entry of this._dbCache.values()) {
			try { entry.db.close(); } catch { /* ignore */ }
		}
		this._dbCache.clear();
		this._dbCacheInflight.clear();
		this._sqlJsInitPromise = null;
	}

	// ── Paths ───────────────────────────────────────────────────────────────

	/**
	 * Hermes home directory: $HERMES_HOME, else %LOCALAPPDATA%\hermes on Windows,
	 * else ~/.hermes on Linux/macOS.
	 */
	getConfigDir(): string {
		const envHome = process.env['HERMES_HOME'];
		if (envHome && envHome.trim()) { return envHome; }
		if (os.platform() === 'win32') {
			const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
			return path.join(localAppData, 'hermes');
		}
		return path.join(os.homedir(), '.hermes');
	}

	/** Absolute path to state.db. */
	getDbPath(): string {
		return this._dbPathOverride ?? path.join(this.getConfigDir(), 'state.db');
	}

	/** Test-only: override the state.db path so tests don't depend on the real OS default location. */
	setDbPathOverrideForTests(dbPath: string | null): void {
		this._dbPathOverride = dbPath;
	}

	/** Build a virtual session path for the given session id. */
	virtualPath(sessionId: string): string {
		return `${this.getDbPath()}#${sessionId}`;
	}

	/**
	 * Returns true if the path is a Hermes virtual session path (backslashes normalised):
	 * either the default `hermes/state.db#` marker, or `<getDbPath()>#` for a $HERMES_HOME
	 * whose folder is not named `hermes`.
	 */
	isHermesSessionFile(filePath: string): boolean {
		const normalized = filePath.replace(/\\/g, '/').toLowerCase();
		if (normalized.includes(DB_MARKER)) { return true; }
		return normalized.startsWith(this.getDbPath().replace(/\\/g, '/').toLowerCase() + '#');
	}

	/** Extract the real DB file path from a virtual session path. */
	getDbPathFromVirtual(virtualPath: string): string {
		const idx = virtualPath.lastIndexOf('state.db#');
		if (idx === -1) { return virtualPath; }
		return virtualPath.substring(0, idx + 'state.db'.length);
	}

	/** Extract the session id from a virtual session path. */
	getSessionId(virtualPath: string): string | null {
		const idx = virtualPath.lastIndexOf('state.db#');
		if (idx === -1) { return null; }
		const id = virtualPath.substring(idx + 'state.db#'.length);
		return id || null;
	}

	/** Stat the underlying state.db file for a virtual path. */
	async statSessionFile(virtualPath: string): Promise<fs.Stats> {
		return fs.promises.stat(this.getDbPathFromVirtual(virtualPath));
	}

	// ── DB open/cache plumbing (mirrors crush.ts / devinCli.ts) ──────────────

	private closeDb(db: SqlDatabase): void {
		try { db.close(); } catch { /* ignore */ }
	}

	private isMissingFileError(error: unknown): boolean {
		const code = (error as NodeJS.ErrnoException)?.code;
		return code === 'ENOENT' || code === 'ENOTDIR';
	}

	private async statDb(dbPath: string): Promise<fs.Stats | null> {
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

	private isCachedDbCurrent(dbPath: string, stats: fs.Stats): boolean {
		const entry = this._dbCache.get(dbPath);
		return !!entry && entry.mtimeMs === stats.mtimeMs && entry.size === stats.size;
	}

	private sameDbStats(left: fs.Stats, right: fs.Stats): boolean {
		return left.mtimeMs === right.mtimeMs && left.size === right.size;
	}

	private async refreshDb(dbPath: string, stats: fs.Stats): Promise<SqlDatabase | null> {
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
	private async getDb(dbPath: string): Promise<SqlDatabase | null> {
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

	private rowsToObjects(result: initSqlJs.QueryExecResult[]): Record<string, unknown>[] {
		if (result.length === 0) { return []; }
		const { columns, values } = result[0];
		return values.map(row => {
			const obj: Record<string, unknown> = {};
			columns.forEach((c, i) => { obj[c] = row[i]; });
			return obj;
		});
	}

	// ── Queries ───────────────────────────────────────────────────────────────

	/** Discover all session ids in the DB (includes archived and subagent sessions). */
	async discoverSessionIds(): Promise<string[]> {
		const db = await this.getDb(this.getDbPath());
		if (!db) { return []; }
		try {
			const result = db.exec('SELECT id FROM sessions ORDER BY started_at DESC');
			return this.rowsToObjects(result).map(r => r['id'] as string);
		} catch {
			return [];
		}
	}

	/**
	 * Returns child-session counts (rows with `source = 'subagent'`) keyed by `parent_session_id`,
	 * restricted to the given candidate session ids. Shared helper behind `getMultiAgentParentCount()`
	 * and the daily multi-agent usage trend (`extension.ts`'s `_computeAgenticDailyTrend`).
	 */
	async getChildCounts(candidateSessionIds: string[]): Promise<Map<string, number>> {
		const counts = new Map<string, number>();
		if (candidateSessionIds.length === 0) { return counts; }
		const db = await this.getDb(this.getDbPath());
		if (!db) { return counts; }
		try {
			const result = db.exec(
				`SELECT parent_session_id, COUNT(*) as child_count FROM sessions
				 WHERE parent_session_id IS NOT NULL
				 GROUP BY parent_session_id`,
			);
			const rows = this.rowsToObjects(result);
			const candidateSet = new Set(candidateSessionIds);
			for (const row of rows) {
				const parentId = row['parent_session_id'] as string | null;
				const childCount = (row['child_count'] as number) ?? 0;
				if (parentId && candidateSet.has(parentId)) { counts.set(parentId, childCount); }
			}
		} catch { /* optional enrichment — suppress */ }
		return counts;
	}

	/**
	 * Counts how many of the given (candidate) session ids are "multi-agent parents" —
	 * i.e. have `minChildren` or more sessions with `source = 'subagent'` pointing at them
	 * via `parent_session_id`. Mirrors `CopilotAppDataAccess.getSessionHierarchy()`'s
	 * multi-agent detection, but for Hermes's global state.db. Used to feed
	 * `UsageAnalysisPeriod.multiAgentParentSessions` alongside Copilot CLI data.
	 */
	async getMultiAgentParentCount(candidateSessionIds: string[], minChildren: number = STAGE_THRESHOLDS.agentic.multiAgentMinChildren): Promise<number> {
		const childCounts = await this.getChildCounts(candidateSessionIds);
		let count = 0;
		for (const childCount of childCounts.values()) {
			if (childCount >= minChildren) { count++; }
		}
		return count;
	}

	/** Read session metadata for a virtual session path. */
	async readSession(virtualPath: string): Promise<HermesSession | null> {
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return null; }
		const db = await this.getDb(this.getDbPathFromVirtual(virtualPath));
		if (!db) { return null; }
		try {
			const result = db.exec(
				`SELECT id, source, display_name, model, started_at, ended_at, message_count,
				        tool_call_count, input_tokens, output_tokens, cache_read_tokens,
				        cache_write_tokens, reasoning_tokens, cwd, git_branch, git_repo_root,
				        title, api_call_count, parent_session_id, archived, pinned
				 FROM sessions WHERE id = ?`,
				[sessionId],
			);
			const rows = this.rowsToObjects(result);
			if (rows.length === 0) { return null; }
			return rows[0] as unknown as HermesSession;
		} catch {
			return null;
		}
	}

	/** Read all messages for a session, ordered chronologically. */
	async getMessages(virtualPath: string): Promise<HermesMessage[]> {
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return []; }
		const db = await this.getDb(this.getDbPathFromVirtual(virtualPath));
		if (!db) { return []; }
		try {
			const result = db.exec(
				`SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name,
				        timestamp, token_count, reasoning, reasoning_content, finish_reason,
				        active, compacted
				 FROM messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC`,
				[sessionId],
			);
			return this.rowsToObjects(result) as unknown as HermesMessage[];
		} catch {
			return [];
		}
	}

	/**
	 * Read per-model usage rows for a session, excluding background/housekeeping tasks
	 * (e.g. title_generation) by default.
	 */
	async getModelUsageRows(virtualPath: string, includeHousekeeping = false): Promise<HermesModelUsageRow[]> {
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return []; }
		const db = await this.getDb(this.getDbPathFromVirtual(virtualPath));
		if (!db) { return []; }
		try {
			const result = db.exec(
				`SELECT session_id, model, task, api_call_count, input_tokens, output_tokens,
				        cache_read_tokens, cache_write_tokens, reasoning_tokens
				 FROM session_model_usage WHERE session_id = ?`,
				[sessionId],
			);
			const rows = this.rowsToObjects(result) as unknown as HermesModelUsageRow[];
			return includeHousekeeping ? rows : rows.filter(r => (r.task ?? '') !== HOUSEKEEPING_TASK);
		} catch {
			return [];
		}
	}

	/** Sum every token-bearing column (input/output/cache/reasoning) across a set of usage rows. */
	private sumUsageRowTokens(rows: HermesModelUsageRow[]): { tokens: number; thinkingTokens: number } {
		let tokens = 0;
		let thinkingTokens = 0;
		for (const row of rows) {
			tokens += (row.input_tokens || 0) + (row.output_tokens || 0) +
				(row.cache_read_tokens || 0) + (row.cache_write_tokens || 0) + (row.reasoning_tokens || 0);
			thinkingTokens += row.reasoning_tokens || 0;
		}
		return { tokens, thinkingTokens };
	}

	/** Fallback token totals from the flat sessions-row columns (used when session_model_usage is empty). */
	private tokensFromSessionRow(session: HermesSession | null): { tokens: number; thinkingTokens: number } {
		if (!session) { return { tokens: 0, thinkingTokens: 0 }; }
		const tokens = (session.input_tokens || 0) + (session.output_tokens || 0) +
			(session.cache_read_tokens || 0) + (session.cache_write_tokens || 0) + (session.reasoning_tokens || 0);
		return { tokens, thinkingTokens: session.reasoning_tokens || 0 };
	}

	/**
	 * Get token counts for a session. Prefers the authoritative session_model_usage
	 * breakdown (excluding title_generation housekeeping); falls back to the flat
	 * columns on the sessions row when no usage rows exist.
	 */
	async getTokens(virtualPath: string): Promise<{ tokens: number; thinkingTokens: number }> {
		const usageRows = await this.getModelUsageRows(virtualPath);
		if (usageRows.length > 0) { return this.sumUsageRowTokens(usageRows); }
		const session = await this.readSession(virtualPath);
		return this.tokensFromSessionRow(session);
	}

	/** Count user-role messages (= user turns) in the session. */
	async countInteractions(virtualPath: string): Promise<number> {
		const messages = await this.getMessages(virtualPath);
		return messages.filter(m => m.role === 'user').length;
	}

	/** Merge one session_model_usage row's token columns into a ModelUsage entry, in place. */
	private mergeUsageRowIntoModelUsage(usage: ModelUsage, row: HermesModelUsageRow): void {
		const model = row.model || 'unknown';
		// Untrusted `model` string from the session database — see protoGuard.ts.
		if (isUnsafeObjectKey(model)) { return; }
		const existing = usage[model] ?? { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0 };
		existing.inputTokens += row.input_tokens || 0;
		existing.outputTokens += row.output_tokens || 0;
		existing.cachedReadTokens = (existing.cachedReadTokens || 0) + (row.cache_read_tokens || 0);
		existing.cacheCreationTokens = (existing.cacheCreationTokens || 0) + (row.cache_write_tokens || 0);
		usage[model] = existing;
	}

	/** Fallback ModelUsage built from the flat sessions-row columns (used when session_model_usage is empty). */
	private modelUsageFromSessionRow(session: HermesSession | null): ModelUsage {
		const usage: ModelUsage = {};
		if (!session || (session.input_tokens || 0) + (session.output_tokens || 0) === 0) { return usage; }
		// Untrusted `model` string from the session database — treat unsafe object keys
		// like a missing model (see protoGuard.ts).
		const model = session.model && !isUnsafeObjectKey(session.model) ? session.model : 'unknown';
		usage[model] = {
			inputTokens: session.input_tokens || 0,
			outputTokens: session.output_tokens || 0,
			cachedReadTokens: session.cache_read_tokens || 0,
			cacheCreationTokens: session.cache_write_tokens || 0,
			sessions: 1,
		};
		return usage;
	}

	/** Per-model token usage, from the authoritative session_model_usage table. */
	async getModelUsage(virtualPath: string): Promise<ModelUsage> {
		const rows = await this.getModelUsageRows(virtualPath);
		const usage: ModelUsage = {};
		for (const row of rows) { this.mergeUsageRowIntoModelUsage(usage, row); }
		if (Object.keys(usage).length > 0) { return usage; }
		// Fall back to session-level flat columns when session_model_usage has no rows.
		const session = await this.readSession(virtualPath);
		return this.modelUsageFromSessionRow(session);
	}

	/** Best-effort extraction of a display title: explicit title, else the first user message text. */
	async resolveTitle(virtualPath: string, session: HermesSession | null): Promise<string | undefined> {
		if (session?.title && session.title.trim()) { return session.title.trim(); }
		const messages = await this.getMessages(virtualPath);
		const firstUser = messages.find(m => m.role === 'user' && m.content && m.content.trim());
		if (!firstUser?.content) { return undefined; }
		const text = firstUser.content.trim();
		return text.length > 100 ? text.slice(0, 100) + '...' : text;
	}

	/**
	 * Parse a message's `tool_calls` JSON column (an array of OpenAI-style function-call
	 * objects) defensively — the shape varies slightly across Hermes backends/providers.
	 */
	parseToolCalls(raw: string | null): HermesParsedToolCall[] {
		if (!raw) { return []; }
		let json: unknown;
		try { json = JSON.parse(raw); } catch { return []; }
		if (!Array.isArray(json)) { return []; }
		const calls: HermesParsedToolCall[] = [];
		for (const entry of json) {
			if (typeof entry !== 'object' || entry === null) { continue; }
			const obj = entry as Record<string, unknown>;
			const fn = obj['function'] as Record<string, unknown> | undefined;
			const name = (fn?.['name'] as string) || (obj['name'] as string) || undefined;
			if (!name) { continue; }
			const id = (obj['id'] as string) || (obj['call_id'] as string) || null;
			const args = fn?.['arguments'];
			calls.push({ id, name, arguments: typeof args === 'string' ? args : undefined });
		}
		return calls;
	}

	/**
	 * Best-effort extraction of a tool result's display text from a 'tool' role message's
	 * `content` column. The shape varies per tool (`{"content": "..."}` is common, but
	 * some tools store other JSON shapes or a plain string) — parsed defensively.
	 */
	parseToolResultText(raw: string | null): string | undefined {
		if (!raw) { return undefined; }
		try {
			const json = JSON.parse(raw);
			if (typeof json === 'string') { return json; }
			if (json && typeof json === 'object') {
				const obj = json as Record<string, unknown>;
				if (typeof obj['content'] === 'string') { return obj['content']; }
				if (typeof obj['output'] === 'string') { return obj['output']; }
				if (typeof obj['result'] === 'string') { return obj['result']; }
			}
			return raw;
		} catch {
			return raw;
		}
	}

	/** Per-local-day fractions for accurate multi-day attribution, weighted by message token_count. */
	async getDailyFractions(virtualPath: string): Promise<Record<string, number>> {
		const messages = await this.getMessages(virtualPath);
		const counts: Record<string, number> = {};
		let total = 0;
		for (const msg of messages) {
			if (!msg.timestamp) { continue; }
			const weight = msg.token_count && msg.token_count > 0 ? msg.token_count : 1;
			const dateKey = toLocalDayKey(new Date(msg.timestamp * 1000));
			counts[dateKey] = (counts[dateKey] || 0) + weight;
			total += weight;
		}
		if (total === 0) {
			const session = await this.readSession(virtualPath);
			const fallbackDate = session?.started_at
				? toLocalDayKey(new Date(session.started_at * 1000))
				: toLocalDayKey(new Date());
			return { [fallbackDate]: 1.0 };
		}
		const fractions: Record<string, number> = {};
		for (const [day, count] of Object.entries(counts)) { fractions[day] = count / total; }
		return fractions;
	}
}
