/**
 * CodexCliDataAccess — reads session data for the OpenAI Codex CLI (https://github.com/openai/codex).
 *
 * Codex CLI stores its data under `$CODEX_HOME` (default `~/.codex` on every platform):
 *
 *   1. Rollout session files (primary, when present):
 *        ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<uuid>.jsonl
 *        ~/.codex/archived_sessions/... (same layout, after `/archive`)
 *      JSONL, one JSON object per line:
 *        { "timestamp": "<ISO 8601>", "type": "<kind>", "payload": { ... } }
 *      Line kinds observed/documented in codex-rs:
 *        - session_meta:  payload { id, timestamp, cwd, originator, cli_version, instructions, git }
 *        - turn_context:  payload { cwd, approval_policy, sandbox_policy, model, effort, summary }
 *        - response_item: payload { type: message|reasoning|function_call|function_call_output|
 *                                   local_shell_call|custom_tool_call|web_search_call, ... }
 *        - event_msg:     payload { type: token_count|user_message|agent_message|..., ... }
 *          token_count carries CUMULATIVE usage in payload.info.total_token_usage:
 *            { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }
 *          (older builds inline the same fields directly on the payload).
 *        - compacted:     history compaction marker.
 *      A legacy (pre-wrapper) format exists where each line IS the response item and the first
 *      line is the session meta object — both are handled defensively.
 *
 *   2. SQLite state DB (fallback + registry): ~/.codex/state_<N>.sqlite (N = schema generation;
 *      state_5.sqlite as of Codex CLI ~0.115). Read via sql.js like the other DB-backed adapters.
 *      `threads` table columns (confirmed against a live state_5.sqlite):
 *        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
 *        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
 *        git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
 *        agent_role, memory_mode, model, reasoning_effort, agent_path
 *      `rollout_path` points at the rollout file for the thread. When that file is missing
 *      (deleted, or the machine only has the DB), the thread row alone still provides
 *      tokens_used / model / title / cwd / timestamps, exposed via a virtual path:
 *        <state_db_path>#<thread_id>   e.g. C:\Users\alice\.codex\state_5.sqlite#019d0233-...
 *      (mirrors the OpenCode/Crush/Devin CLI `db#id` convention).
 *
 *   Also present but NOT used here: logs_<N>.sqlite (diagnostic tracing only — no per-session
 *   usage data) and models_cache.json (model catalog; slugs match the model ids already used
 *   in rollouts/threads, so no mapping is needed).
 *
 * Timestamp units: rollout lines use ISO 8601 strings. threads.created_at / updated_at are
 * epoch integers whose unit could not be confirmed against live rows (the observed DB had an
 * empty threads table); values are treated as SECONDS unless > 1e12 (then milliseconds).
 *
 * Known limitation: sql.js reads only the main DB file, so thread rows still sitting in an
 * un-checkpointed `-wal` file are not visible until Codex checkpoints them (same limitation
 * as every other sql.js-based adapter in this repo).
 */
/// <reference types="sql.js" />
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs from 'sql.js';
import type { ModelUsage } from './types';
import { joinedChildPrefixForComparison, normalizePath } from './utils/pathUtils';
import { toLocalDayKey } from './utils/dayKeys';

type SqlJsStatic = initSqlJs.SqlJsStatic;
type SqlDatabase = initSqlJs.Database;

type DbCacheEntry = { db: SqlDatabase; mtimeMs: number; size: number };

/** Matches rollout session filenames: rollout-2026-03-19T12-00-00-<uuid>.jsonl */
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/i;
/** Extracts the thread/session uuid from a rollout filename. */
const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/**
 * Matches virtual thread paths that point into a state_<N>.sqlite DB. The DB name may
 * start the path: with CODEX_HOME='.' path.join drops the './', giving `state_<N>.sqlite#<id>`.
 */
const STATE_DB_VIRTUAL_RE = /(?:^|\/)state_\d+\.sqlite#/i;
/** Newest schema generation observed at implementation time (used only as a diagnostics fallback). */
const DEFAULT_STATE_DB_NAME = 'state_5.sqlite';
/** System-injected user messages start with these XML-ish tags and are not real user turns. */
const SYNTHETIC_USER_TAG_RE = /^\s*<(user_instructions|environment_context|turn_context|permissions|ide_context|system_instructions)\b/i;

/** Row from the `threads` table (subset used by this adapter). */
export interface CodexThread {
	id: string;
	rollout_path: string | null;
	created_at: number | null;
	updated_at: number | null;
	cwd: string | null;
	title: string | null;
	tokens_used: number | null;
	has_user_event: number | null;
	archived: number | null;
	first_user_message: string | null;
	model: string | null;
}

/** One parsed rollout JSONL line, normalised across new and legacy formats. */
export interface CodexRolloutLine {
	timestamp: string | null;
	kind: string;
	payload: Record<string, unknown>;
}

/** Cumulative token usage snapshot from a token_count event. */
interface TokenSnapshot {
	input: number;
	cachedInput: number;
	output: number;
	reasoning: number;
	model: string;
}

/** Aggregated view of one rollout file, consumed by the adapter. */
export interface CodexRolloutSummary {
	sessionId: string | null;
	cwd: string | null;
	firstTimestamp: string | null;
	lastTimestamp: string | null;
	/** Genuine user messages (system-injected instruction/context payloads filtered out). */
	userMessages: { text: string; timestamp: string | null }[];
	assistantMessages: { text: string; timestamp: string | null; model: string }[];
	toolCalls: { name: string; timestamp: string | null }[];
	/** Cumulative usage snapshots in file order, tagged with the model active at that point. */
	tokenSnapshots: TokenSnapshot[];
	/** Total characters of reasoning summary text (for thinking-token estimation fallback). */
	reasoningChars: number;
	/** Models seen in turn_context order (deduplicated, first-seen order). */
	models: string[];
}

/** Sums per-model input/output deltas across cumulative snapshots (reset-safe). */
export interface CodexTokenTotals {
	perModel: { [model: string]: { inputTokens: number; outputTokens: number; sessions: number } };
	totalTokens: number;
	thinkingTokens: number;
}

export class CodexCliDataAccess {
	private _sqlJsModule: SqlJsStatic | null = null;
	private _sqlJsInitPromise: Promise<SqlJsStatic> | null = null;
	private _dbCache: Map<string, DbCacheEntry> = new Map();
	private _dbCacheInflight: Map<string, Promise<SqlDatabase | null>> = new Map();
	/** Parsed-rollout cache keyed by file path, invalidated on mtime/size change (bounded). */
	private _rolloutCache: Map<string, { mtimeMs: number; size: number; summary: CodexRolloutSummary }> = new Map();
	private static readonly ROLLOUT_CACHE_MAX = 64;
	/** Test-only override for the Codex home directory. */
	private _codexHomeOverride: string | null = null;

	dispose(): void {
		for (const entry of this._dbCache.values()) {
			try { entry.db.close(); } catch { /* ignore */ }
		}
		this._dbCache.clear();
		this._dbCacheInflight.clear();
		this._rolloutCache.clear();
		this._sqlJsInitPromise = null;
	}

	// ── Paths ───────────────────────────────────────────────────────────────

	/** Codex home: $CODEX_HOME or ~/.codex (same on every platform). */
	getCodexHome(): string {
		if (this._codexHomeOverride) { return this._codexHomeOverride; }
		const envHome = process.env['CODEX_HOME'];
		if (envHome && envHome.trim()) { return envHome; }
		return path.join(os.homedir(), '.codex');
	}

	/** Test-only: override the Codex home directory. */
	setCodexHomeOverrideForTests(dir: string | null): void {
		this._codexHomeOverride = dir;
		this._rolloutCache.clear();
	}

	getSessionsDir(): string {
		return path.join(this.getCodexHome(), 'sessions');
	}

	getArchivedSessionsDir(): string {
		return path.join(this.getCodexHome(), 'archived_sessions');
	}

	/**
	 * Absolute path to the newest state_<N>.sqlite in the Codex home.
	 * Falls back to the newest known default name when none exists yet
	 * (so diagnostics can still display the expected location).
	 */
	getStateDbPath(): string {
		const home = this.getCodexHome();
		let best: { n: number; name: string } | null = null;
		try {
			for (const name of fs.readdirSync(home)) {
				const m = /^state_(\d+)\.sqlite$/i.exec(name);
				if (m) {
					const n = parseInt(m[1], 10);
					if (!best || n > best.n) { best = { n, name }; }
				}
			}
		} catch { /* home missing — fall through to default */ }
		return path.join(home, best ? best.name : DEFAULT_STATE_DB_NAME);
	}

	// ── Path classification ─────────────────────────────────────────────────

	/**
	 * Returns true for any path owned by this adapter:
	 *  - rollout JSONL files under the Codex home (sessions/ or archived_sessions/)
	 *  - virtual thread paths <state_db>#<thread_id>
	 */
	isCodexCliSessionFile(filePath: string): boolean {
		const norm = normalizePath(filePath).toLowerCase();
		if (norm.includes('/.codex/')) {
			return STATE_DB_VIRTUAL_RE.test(norm) || ROLLOUT_FILE_RE.test(path.basename(norm));
		}
		// A relocated $CODEX_HOME: compare against the prefix path.join() puts on this
		// adapter's own paths, so homes like '.' (join drops the './') and '/' still match.
		// Only Codex's own entries count — a broad home (e.g. '/') must not claim an
		// unrelated rollout-*.jsonl elsewhere under it.
		const homePrefix = joinedChildPrefixForComparison(this.getCodexHome());
		if (!norm.startsWith(homePrefix)) { return false; }
		const rest = norm.slice(homePrefix.length);
		if (/^state_\d+\.sqlite#/.test(rest)) { return true; }
		return /^(sessions|archived_sessions)\//.test(rest) && ROLLOUT_FILE_RE.test(path.basename(norm));
	}

	/** Returns true when the path is a virtual DB-thread path (as opposed to a rollout file). */
	isVirtualThreadPath(filePath: string): boolean {
		return STATE_DB_VIRTUAL_RE.test(normalizePath(filePath));
	}

	/** Extract the real state DB path from a virtual thread path. */
	getDbPathFromVirtual(virtualPath: string): string {
		const idx = virtualPath.lastIndexOf('.sqlite#');
		if (idx === -1) { return virtualPath; }
		return virtualPath.substring(0, idx + '.sqlite'.length);
	}

	/** Extract the thread id from a virtual thread path. */
	getThreadId(virtualPath: string): string | null {
		const idx = virtualPath.lastIndexOf('.sqlite#');
		if (idx === -1) { return null; }
		const id = virtualPath.substring(idx + '.sqlite#'.length);
		return id || null;
	}

	/** Build a virtual thread path for a thread id. */
	virtualPath(threadId: string): string {
		return `${this.getStateDbPath()}#${threadId}`;
	}

	/** Real backing file for a session path (rollout file itself, or the state DB). */
	getBackingPath(sessionFile: string): string {
		return this.isVirtualThreadPath(sessionFile) ? this.getDbPathFromVirtual(sessionFile) : sessionFile;
	}

	/** Stat the backing file for a session path. */
	async statSessionFile(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(this.getBackingPath(sessionFile));
	}

	// ── sql.js boilerplate (same pattern as crush.ts / devinCli.ts) ─────────

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

	/** Cached SQL.Database, re-opened only on mtime/size change; single-flight deduplicated. */
	private async getDb(dbPath: string): Promise<SqlDatabase | null> {
		const stats = await this.statDb(dbPath);
		if (!stats) { return this._dbCache.get(dbPath)?.db ?? null; }
		const cached = this._dbCache.get(dbPath);
		if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) { return cached.db; }
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

	private rowsToObjects(result: initSqlJs.QueryExecResult[]): Record<string, unknown>[] {
		if (result.length === 0) { return []; }
		const { columns, values } = result[0];
		return values.map(row => {
			const obj: Record<string, unknown> = {};
			columns.forEach((c, i) => { obj[c] = row[i]; });
			return obj;
		});
	}

	// ── Threads table access ────────────────────────────────────────────────

	/** Read all thread rows (including archived — they still represent real usage). */
	async readAllThreads(): Promise<CodexThread[]> {
		const db = await this.getDb(this.getStateDbPath());
		if (!db) { return []; }
		try {
			const result = db.exec(
				`SELECT id, rollout_path, created_at, updated_at, cwd, title, tokens_used,
				        has_user_event, archived, first_user_message, model
				 FROM threads ORDER BY updated_at DESC`,
			);
			return this.rowsToObjects(result) as unknown as CodexThread[];
		} catch {
			return [];
		}
	}

	/** Read one thread row for a virtual thread path. */
	async readThread(virtualPath: string): Promise<CodexThread | null> {
		const threadId = this.getThreadId(virtualPath);
		if (!threadId) { return null; }
		const db = await this.getDb(this.getDbPathFromVirtual(virtualPath));
		if (!db) { return null; }
		try {
			const result = db.exec(
				`SELECT id, rollout_path, created_at, updated_at, cwd, title, tokens_used,
				        has_user_event, archived, first_user_message, model
				 FROM threads WHERE id = ?`,
				[threadId],
			);
			const rows = this.rowsToObjects(result);
			return rows.length > 0 ? rows[0] as unknown as CodexThread : null;
		} catch {
			return null;
		}
	}

	/** Epoch seconds-vs-milliseconds heuristic (threads table unit unconfirmed — see file header). */
	toMillis(epoch: number | null | undefined): number | null {
		if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= 0) { return null; }
		return epoch > 1e12 ? epoch : epoch * 1000;
	}

	// ── Discovery ───────────────────────────────────────────────────────────

	/** Recursively collect rollout-*.jsonl files under a directory (depth-bounded). */
	private async collectRolloutFiles(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
		if (depth > 5) { return out; }
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await this.collectRolloutFiles(full, depth + 1, out);
			} else if (ROLLOUT_FILE_RE.test(entry.name)) {
				out.push(full);
			}
		}
		return out;
	}

	/**
	 * Discover all Codex CLI sessions:
	 *  1. rollout files under sessions/ and archived_sessions/
	 *  2. threads-table rows — resolved to their rollout_path when that file exists,
	 *     otherwise exposed as a virtual <state_db>#<thread_id> path.
	 * Threads whose id already matches a discovered rollout file are skipped (dedupe).
	 */
	async discoverSessions(): Promise<{ files: string[]; rolloutCount: number; dbOnlyCount: number }> {
		const files: string[] = [];
		const seenPaths = new Set<string>();
		const seenThreadIds = new Set<string>();

		const rollouts = [
			...await this.collectRolloutFiles(this.getSessionsDir()),
			...await this.collectRolloutFiles(this.getArchivedSessionsDir()),
		];
		for (const file of rollouts) {
			const key = normalizePath(file).toLowerCase();
			if (seenPaths.has(key)) { continue; }
			seenPaths.add(key);
			files.push(file);
			const uuid = ROLLOUT_UUID_RE.exec(file);
			if (uuid) { seenThreadIds.add(uuid[1].toLowerCase()); }
		}
		const rolloutCount = files.length;

		let dbOnlyCount = 0;
		for (const thread of await this.readAllThreads()) {
			if (!thread.id || seenThreadIds.has(thread.id.toLowerCase())) { continue; }
			seenThreadIds.add(thread.id.toLowerCase());
			const resolved = this.resolveThreadPath(thread, seenPaths);
			if (!resolved) { continue; }
			files.push(resolved.path);
			if (resolved.dbOnly) { dbOnlyCount++; }
		}
		return { files, rolloutCount, dbOnlyCount };
	}

	/** Resolve a thread row to its rollout file when it exists, else its virtual DB path. */
	private resolveThreadPath(thread: CodexThread, seenPaths: Set<string>): { path: string; dbOnly: boolean } | null {
		if (thread.rollout_path && fs.existsSync(thread.rollout_path)) {
			const key = normalizePath(thread.rollout_path).toLowerCase();
			if (seenPaths.has(key)) { return null; }
			seenPaths.add(key);
			return { path: thread.rollout_path, dbOnly: false };
		}
		return { path: this.virtualPath(thread.id), dbOnly: true };
	}

	// ── Rollout parsing ─────────────────────────────────────────────────────

	/**
	 * Normalise one parsed JSONL object across the current wrapper format and the
	 * legacy formats (raw response items; bare session-meta first line).
	 */
	normalizeRolloutLine(obj: Record<string, unknown>): CodexRolloutLine | null {
		const timestamp = typeof obj['timestamp'] === 'string' ? obj['timestamp'] as string : null;
		const type = typeof obj['type'] === 'string' ? obj['type'] as string : null;
		const payload = obj['payload'];
		if (type && typeof payload === 'object' && payload !== null) {
			return { timestamp, kind: type, payload: payload as Record<string, unknown> };
		}
		// Legacy: the line itself is a response item ({type:'message',role:...} etc.).
		if (type) {
			return { timestamp, kind: 'response_item', payload: obj };
		}
		// Legacy: bare session meta first line ({id, timestamp, instructions, ...}).
		if (typeof obj['id'] === 'string' && ('instructions' in obj || 'cwd' in obj || 'git' in obj)) {
			return { timestamp, kind: 'session_meta', payload: obj };
		}
		return null;
	}

	/** Extract the concatenated text from a response-item message content array. */
	private extractMessageText(payload: Record<string, unknown>): string {
		const content = payload['content'];
		if (typeof content === 'string') { return content; }
		if (!Array.isArray(content)) { return ''; }
		return content
			.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
			.filter(c => typeof c['text'] === 'string' &&
				(c['type'] === 'input_text' || c['type'] === 'output_text' || c['type'] === 'text' || c['type'] === undefined))
			.map(c => c['text'] as string)
			.join('\n');
	}

	/** Extract a cumulative usage snapshot from a token_count event payload (both shapes). */
	private extractTokenSnapshot(payload: Record<string, unknown>, model: string): TokenSnapshot | null {
		const info = payload['info'];
		const usageHolder = (typeof info === 'object' && info !== null)
			? (info as Record<string, unknown>)['total_token_usage'] ?? info
			: payload;
		if (typeof usageHolder !== 'object' || usageHolder === null) { return null; }
		const usage = usageHolder as Record<string, unknown>;
		const num = (k: string): number => typeof usage[k] === 'number' && Number.isFinite(usage[k] as number) ? usage[k] as number : 0;
		const input = num('input_tokens');
		const output = num('output_tokens');
		if (input === 0 && output === 0 && num('total_tokens') === 0) { return null; }
		return {
			input,
			cachedInput: num('cached_input_tokens'),
			output,
			reasoning: num('reasoning_output_tokens'),
			model,
		};
	}

	private toolNameForResponseItem(itemType: string, payload: Record<string, unknown>): string | null {
		if (itemType === 'function_call' || itemType === 'custom_tool_call') {
			return typeof payload['name'] === 'string' && payload['name'] ? payload['name'] as string : 'unknown';
		}
		if (itemType === 'local_shell_call') { return 'shell'; }
		if (itemType === 'web_search_call') { return 'web_search'; }
		return null;
	}

	private applyMessageItem(line: CodexRolloutLine, summary: CodexRolloutSummary, currentModel: string): void {
		const role = line.payload['role'];
		const text = this.extractMessageText(line.payload);
		if (!text) { return; }
		if (role === 'user' && !SYNTHETIC_USER_TAG_RE.test(text)) {
			summary.userMessages.push({ text, timestamp: line.timestamp });
		} else if (role === 'assistant') {
			summary.assistantMessages.push({ text, timestamp: line.timestamp, model: currentModel });
		}
	}

	private applyReasoningItem(payload: Record<string, unknown>, summary: CodexRolloutSummary): void {
		const summaries = Array.isArray(payload['summary']) ? payload['summary'] : [];
		for (const s of summaries) {
			if (typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>)['text'] === 'string') {
				summary.reasoningChars += ((s as Record<string, unknown>)['text'] as string).length;
			}
		}
	}

	private applyResponseItem(line: CodexRolloutLine, summary: CodexRolloutSummary, currentModel: string): void {
		const p = line.payload;
		const itemType = typeof p['type'] === 'string' ? p['type'] as string : '';
		if (itemType === 'message') {
			this.applyMessageItem(line, summary, currentModel);
			return;
		}
		if (itemType === 'reasoning') {
			this.applyReasoningItem(p, summary);
			return;
		}
		const toolName = this.toolNameForResponseItem(itemType, p);
		if (toolName) { summary.toolCalls.push({ name: toolName, timestamp: line.timestamp }); }
	}

	private applyEventMsg(line: CodexRolloutLine, summary: CodexRolloutSummary, currentModel: string): void {
		const p = line.payload;
		const eventType = p['type'];
		if (eventType === 'token_count') {
			const snapshot = this.extractTokenSnapshot(p, currentModel);
			if (snapshot) { summary.tokenSnapshots.push(snapshot); }
		}
	}

	/** Fallback user-turn counting from event_msg user_message events (legacy files without response items). */
	private countEventMsgUserMessages(lines: CodexRolloutLine[]): { text: string; timestamp: string | null }[] {
		const result: { text: string; timestamp: string | null }[] = [];
		for (const line of lines) {
			if (line.kind !== 'event_msg' || line.payload['type'] !== 'user_message') { continue; }
			const message = line.payload['message'];
			if (typeof message === 'string' && message && !SYNTHETIC_USER_TAG_RE.test(message)) {
				result.push({ text: message, timestamp: line.timestamp });
			}
		}
		return result;
	}

	/** Parse a rollout file into normalised lines (invalid/partial lines skipped). */
	async readRolloutLines(filePath: string): Promise<CodexRolloutLine[]> {
		let content: string;
		try {
			content = await fs.promises.readFile(filePath, 'utf8');
		} catch {
			return [];
		}
		const lines: CodexRolloutLine[] = [];
		for (const raw of content.split('\n')) {
			const trimmed = raw.trim();
			if (!trimmed) { continue; }
			try {
				const obj = JSON.parse(trimmed);
				if (typeof obj !== 'object' || obj === null) { continue; }
				const normalized = this.normalizeRolloutLine(obj as Record<string, unknown>);
				if (normalized) { lines.push(normalized); }
			} catch { /* truncated/partial line — skip */ }
		}
		return lines;
	}

	/** Parse + summarise a rollout file (cached by mtime/size). */
	async getRolloutSummary(filePath: string): Promise<CodexRolloutSummary> {
		let stats: fs.Stats | null = null;
		try { stats = await fs.promises.stat(filePath); } catch { /* missing */ }
		if (stats) {
			const cached = this._rolloutCache.get(filePath);
			if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
				return cached.summary;
			}
		}
		const summary = this.buildRolloutSummary(await this.readRolloutLines(filePath));
		if (stats) {
			if (this._rolloutCache.size >= CodexCliDataAccess.ROLLOUT_CACHE_MAX) {
				const oldest = this._rolloutCache.keys().next().value;
				if (oldest !== undefined) { this._rolloutCache.delete(oldest); }
			}
			this._rolloutCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
		}
		return summary;
	}

	private buildRolloutSummary(lines: CodexRolloutLine[]): CodexRolloutSummary {
		const summary: CodexRolloutSummary = {
			sessionId: null, cwd: null, firstTimestamp: null, lastTimestamp: null,
			userMessages: [], assistantMessages: [], toolCalls: [],
			tokenSnapshots: [], reasoningChars: 0, models: [],
		};
		let currentModel = 'unknown';
		for (const line of lines) {
			if (line.timestamp) {
				if (!summary.firstTimestamp) { summary.firstTimestamp = line.timestamp; }
				summary.lastTimestamp = line.timestamp;
			}
			currentModel = this.applyRolloutLine(line, summary, currentModel);
		}
		if (summary.userMessages.length === 0) {
			summary.userMessages = this.countEventMsgUserMessages(lines);
		}
		return summary;
	}

	private applyRolloutLine(line: CodexRolloutLine, summary: CodexRolloutSummary, currentModel: string): string {
		if (line.kind === 'session_meta') {
			const p = line.payload;
			if (typeof p['id'] === 'string') { summary.sessionId = p['id'] as string; }
			if (typeof p['cwd'] === 'string') { summary.cwd = p['cwd'] as string; }
			return currentModel;
		}
		if (line.kind === 'turn_context') {
			const model = line.payload['model'];
			if (typeof model === 'string' && model) {
				if (!summary.models.includes(model)) { summary.models.push(model); }
				return model;
			}
			return currentModel;
		}
		if (line.kind === 'response_item') { this.applyResponseItem(line, summary, currentModel); }
		else if (line.kind === 'event_msg') { this.applyEventMsg(line, summary, currentModel); }
		return currentModel;
	}

	// ── Token / usage computation ───────────────────────────────────────────

	/**
	 * Compute per-model token totals from cumulative snapshots by summing successive
	 * deltas (negative deltas — e.g. after compaction resets — are clamped to 0,
	 * and a reset re-baselines from the new snapshot).
	 */
	computeTokenTotals(summary: CodexRolloutSummary): CodexTokenTotals {
		const perModel: CodexTokenTotals['perModel'] = {};
		let thinking = 0;
		let prev: TokenSnapshot | null = null;
		for (const snap of summary.tokenSnapshots) {
			const dInput = prev ? Math.max(0, snap.input - prev.input) : snap.input;
			const dOutput = prev ? Math.max(0, snap.output - prev.output) : snap.output;
			const dReasoning = prev ? Math.max(0, snap.reasoning - prev.reasoning) : snap.reasoning;
			if (dInput > 0 || dOutput > 0) {
				const entry = perModel[snap.model] ?? (perModel[snap.model] = { inputTokens: 0, outputTokens: 0, sessions: 0 });
				entry.inputTokens += dInput;
				entry.outputTokens += dOutput;
			}
			thinking += dReasoning;
			prev = snap;
		}
		const totalTokens = Object.values(perModel).reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
		return { perModel, totalTokens, thinkingTokens: thinking };
	}

	private estimateTextTokens(text: string): number {
		return text ? Math.ceil(text.length / 4) : 0;
	}

	/** Fallback ~4 chars/token estimate over all message + reasoning text. */
	private estimateRolloutTokens(summary: CodexRolloutSummary): { input: number; output: number; thinking: number } {
		let input = 0;
		let output = 0;
		for (const m of summary.userMessages) { input += this.estimateTextTokens(m.text); }
		for (const m of summary.assistantMessages) { output += this.estimateTextTokens(m.text); }
		const thinking = Math.ceil(summary.reasoningChars / 4);
		return { input, output, thinking };
	}

	/** Session token counts. Rollouts: real token_count data (estimate fallback). DB threads: tokens_used. */
	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number }> {
		if (this.isVirtualThreadPath(sessionFile)) {
			const thread = await this.readThread(sessionFile);
			const tokens = typeof thread?.tokens_used === 'number' ? thread.tokens_used : 0;
			return { tokens, thinkingTokens: 0 };
		}
		const summary = await this.getRolloutSummary(sessionFile);
		const totals = this.computeTokenTotals(summary);
		if (totals.totalTokens > 0) {
			return { tokens: totals.totalTokens, thinkingTokens: totals.thinkingTokens };
		}
		const est = this.estimateRolloutTokens(summary);
		return { tokens: est.input + est.output + est.thinking, thinkingTokens: est.thinking };
	}

	/** Count genuine user turns. DB-only threads expose no message data → 1 if any user event, else 0. */
	async countInteractions(sessionFile: string): Promise<number> {
		if (this.isVirtualThreadPath(sessionFile)) {
			const thread = await this.readThread(sessionFile);
			if (!thread) { return 0; }
			const hasUser = thread.has_user_event === 1 ||
				(typeof thread.first_user_message === 'string' && thread.first_user_message.trim().length > 0);
			return hasUser ? 1 : 0;
		}
		const summary = await this.getRolloutSummary(sessionFile);
		return summary.userMessages.length;
	}

	/** Per-model usage. Rollouts: real per-model deltas. DB threads: all tokens on the thread's model. */
	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		if (this.isVirtualThreadPath(sessionFile)) {
			const thread = await this.readThread(sessionFile);
			const tokens = typeof thread?.tokens_used === 'number' ? thread.tokens_used : 0;
			if (tokens === 0) { return {}; }
			const model = thread?.model || 'unknown';
			// Only a single total is stored; agent sessions are heavily input-dominated,
			// so the total is attributed to inputTokens (conservative for cost estimates).
			return { [model]: { inputTokens: tokens, outputTokens: 0, sessions: 0 } };
		}
		const summary = await this.getRolloutSummary(sessionFile);
		const totals = this.computeTokenTotals(summary);
		if (totals.totalTokens > 0) { return totals.perModel; }
		const est = this.estimateRolloutTokens(summary);
		if (est.input + est.output + est.thinking === 0) { return {}; }
		const model = summary.models[summary.models.length - 1] || 'unknown';
		return { [model]: { inputTokens: est.input, outputTokens: est.output + est.thinking, sessions: 0 } };
	}

	/** Session metadata (title, first/last interaction, workspace path). */
	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		if (this.isVirtualThreadPath(sessionFile)) {
			return this.getThreadMeta(sessionFile);
		}
		const summary = await this.getRolloutSummary(sessionFile);
		const title = summary.userMessages[0]?.text.split('\n')[0].slice(0, 100);
		return {
			title: title || undefined,
			firstInteraction: summary.firstTimestamp,
			lastInteraction: summary.lastTimestamp,
			workspacePath: summary.cwd || undefined,
		};
	}

	private async getThreadMeta(virtualPath: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const thread = await this.readThread(virtualPath);
		const created = this.toMillis(thread?.created_at);
		const updated = this.toMillis(thread?.updated_at);
		return {
			title: thread?.title || thread?.first_user_message?.slice(0, 100) || undefined,
			firstInteraction: created ? new Date(created).toISOString() : null,
			lastInteraction: updated ? new Date(updated).toISOString() : null,
			workspacePath: thread?.cwd || undefined,
		};
	}

	/** Per-local-day fractions for multi-day attribution. */
	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		if (this.isVirtualThreadPath(sessionFile)) {
			const thread = await this.readThread(sessionFile);
			const millis = this.toMillis(thread?.updated_at) ?? this.toMillis(thread?.created_at);
			return { [toLocalDayKey(millis ? new Date(millis) : new Date())]: 1.0 };
		}
		const summary = await this.getRolloutSummary(sessionFile);
		const counts: Record<string, number> = {};
		let total = 0;
		for (const m of [...summary.userMessages, ...summary.assistantMessages]) {
			if (!m.timestamp) { continue; }
			const d = new Date(m.timestamp);
			if (isNaN(d.getTime())) { continue; }
			const key = toLocalDayKey(d);
			counts[key] = (counts[key] || 0) + 1;
			total++;
		}
		if (total === 0) {
			const fallback = summary.lastTimestamp ? new Date(summary.lastTimestamp) : new Date();
			return { [toLocalDayKey(isNaN(fallback.getTime()) ? new Date() : fallback)]: 1.0 };
		}
		const fractions: Record<string, number> = {};
		for (const [day, count] of Object.entries(counts)) { fractions[day] = count / total; }
		return fractions;
	}
}
