/**
 * Kilo Code data access layer.
 * Handles reading session data from Kilo Code's SQLite database.
 *
 * Kilo Code (https://kilo.ai) ships a VS Code extension and a CLI that share
 * one local database. Sessions are discovered exclusively from the SQLite
 * database — Kilo Code does not write JSON session/message/part files like
 * OpenCode does. The DB schema (session/message/part tables with a JSON
 * `data` column) and the message JSON shape (role, parentID,
 * tokens.total/input/output/reasoning/cache.read/write, modelID, time.created)
 * are documented here as Kilo Code's own contract so this layer can evolve
 * independently if Kilo Code diverges from its OpenCode heritage.
 *
 * Storage location (XDG Base Directory Specification):
 * - Windows: %USERPROFILE%\.local\share\kilo\
 * - Linux/macOS: ~/.local/share/kilo/
 *
 * Sessions are referenced through virtual paths like kilo.db#ses_<id>.
 */
/// <reference types="sql.js" />
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage, ModelId } from './types';
import { normalizePathForComparison } from './workspaceHelpers';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { readDbBufferWithWalFingerprint, getWalStat, type WalReadResult } from './utils/sqliteWal';

import { SqlJsDbCacheBase, type SqlDatabase } from './utils/sqlJsDbCache';

/** Minimal URI interface required by KiloDataAccess (subset of vscode.Uri). */
export interface KiloUriLike {
	readonly fsPath: string;
	readonly path: string;
	readonly scheme: string;
}

type KiloModelUsageWithInteractions = {
	[modelName: ModelId]: ModelUsage[ModelId] & { interactions?: number };
};

function toFiniteNumber(value: unknown): number {
	const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
	return Number.isFinite(numberValue) ? numberValue : 0;
}

export class KiloDataAccess extends SqlJsDbCacheBase {
	private readonly extensionUri: KiloUriLike;

	constructor(extensionUri: KiloUriLike) {
		super();
		this.extensionUri = extensionUri;
	}

	/**
	 * Get the Kilo Code data directory path.
	 * Kilo Code follows XDG Base Directory Specification:
	 * - Windows: %USERPROFILE%\.local\share\kilo\
	 * - Linux/macOS: ~/.local/share/kilo/
	 */
	getKiloDataDir(): string {
		const platform = os.platform();
		const homedir = os.homedir();
		if (platform === 'win32') {
			return path.join(homedir, '.local', 'share', 'kilo');
		}
		const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
		return path.join(xdgDataHome, 'kilo');
	}

	/** Absolute path of the kilo.db SQLite database file. */
	getKiloDbPath(): string {
		return path.join(this.getKiloDataDir(), 'kilo.db');
	}

	/**
	 * Check if a file path is a Kilo Code session file.
	 * Kilo Code sessions are referenced via virtual paths like kilo.db#ses_<id>.
	 */
	isKiloSessionFile(filePath: string): boolean {
		const normalized = normalizePathForComparison(filePath);
		return normalized.includes('/kilo/kilo.db#ses_');
	}

	/**
	 * Check if a session is stored in the Kilo Code SQLite database.
	 * Virtual path format: <kilo_dir>/kilo.db#ses_<id>
	 */
	isKiloDbSession(filePath: string): boolean {
		return filePath.includes('kilo.db#ses_');
	}

	/**
	 * Extract the session ID from a Kilo Code session file path.
	 * - ".../.local/share/kilo/kilo.db#ses_abc123" -> "ses_abc123"
	 */
	getKiloSessionId(sessionFilePath: string): string | null {
		// Handle DB virtual path: kilo.db#ses_<id>
		const hashIdx = sessionFilePath.indexOf('kilo.db#');
		if (hashIdx !== -1) {
			return sessionFilePath.substring(hashIdx + 'kilo.db#'.length);
		}
		return null;
	}

	private statKiloDb(dbPath: string): fs.Stats | null {
		try {
			return fs.statSync(dbPath);
		} catch (error) {
			if (this.isMissingFileError(error) && this._dbCache?.path === dbPath) {
				this.closeDbCache();
			}
			return null;
		}
	}

	private isCachedDbCurrent(dbPath: string, stats: fs.Stats): boolean {
		const wal = getWalStat(dbPath);
		return this._dbCache?.path === dbPath
			&& this._dbCache.mtimeMs === stats.mtimeMs
			&& this._dbCache.size === stats.size
			&& this._dbCache.walMtimeMs === wal.mtimeMs
			&& this._dbCache.walSize === wal.size;
	}

	private getDbCacheKey(dbPath: string, stats: fs.Stats): string {
		const wal = getWalStat(dbPath);
		return `${dbPath}:${stats.mtimeMs}:${stats.size}:wal${wal.mtimeMs}:${wal.size}`;
	}

	private sameDbStats(left: fs.Stats, right: fs.Stats): boolean {
		return left.mtimeMs === right.mtimeMs && left.size === right.size;
	}

	/** True when `_dbCache` was built from a read that reported this exact fingerprint. */
	private isCachedDbCurrentForFingerprint(dbPath: string, result: WalReadResult): boolean {
		return this._dbCache?.path === dbPath
			&& this._dbCache.mtimeMs === result.dbMtimeMs
			&& this._dbCache.size === result.dbSize
			&& this._dbCache.walMtimeMs === result.walMtimeMs
			&& this._dbCache.walSize === result.walSize;
	}

	private async refreshKiloDb(dbPath: string, stats: fs.Stats): Promise<SqlDatabase | null> {
		let result: WalReadResult;
		try {
			// Use the fingerprint the read itself reports rather than a fresh getWalStat(dbPath)
			// call afterwards: a throttled sqliteWal read can serve a buffer older than "now", and
			// stamping it with the current WAL state would make a stale cache entry look current —
			// permanently hiding any WAL writes that land after this read but before the throttle
			// window lapses (see #2036 review notes on src/utils/sqliteWal.ts).
			result = await readDbBufferWithWalFingerprint(dbPath);
		} catch {
			return this.getCachedDbForPath(dbPath);
		}

		// The cheap pre-check in getKiloDb() that led here used a fresh WAL stat and found a
		// possible change, but the read above may have been served from sqliteWal's own throttle
		// under the buffer's ORIGINAL fingerprint — i.e. nothing actually changed since the db
		// already cached here was built. Reuse it rather than paying to reparse bytes we already
		// have parsed — see #2036 review notes (Fix 1).
		if (this.isCachedDbCurrentForFingerprint(dbPath, result)) {
			return this._dbCache?.db ?? null;
		}

		let db: SqlDatabase;
		try {
			const SQL = await this.initSqlJs();
			db = new SQL.Database(result.buffer);
		} catch {
			return this.getCachedDbForPath(dbPath);
		}

		const currentStats = this.statKiloDb(dbPath);
		if (!currentStats || !this.sameDbStats(stats, currentStats)) {
			this.closeDb(db);
			if (this.isCachedDbCurrent(dbPath, currentStats ?? stats)) {
				return this._dbCache?.db ?? null;
			}
			return this.getCachedDbForPath(dbPath);
		}

		if (!result.walIncluded) {
			// A WAL-blind plain read (see sqliteWal.ts) — usable for this one call, but not safe to
			// treat as "caught up": persisting it into `_dbCache` would let a later WAL-quiet moment
			// look identical to a genuinely caught-up read, hiding committed rows never checkpointed
			// into the main file — see #2036 review notes (Fix 3). Keep it only in the single
			// trailing transient slot instead.
			this.releasePendingTransientDb();
			this._pendingTransientDb = db;
			return db;
		}

		this.closeDbCache();
		this.releasePendingTransientDb();
		this._dbCache = { db, path: dbPath, mtimeMs: result.dbMtimeMs, size: result.dbSize, walMtimeMs: result.walMtimeMs, walSize: result.walSize };
		return db;
	}

	/**
	 * Returns a cached SQL.Database instance for kilo.db, re-opening only when
	 * the file's mtime changes. This avoids reading and parsing the entire DB file
	 * on every query.
	 *
	 * Uses single-flight deduplication to prevent concurrent calls from each re-reading
	 * the DB file and leaving instances unclosed.
	 */
	private async getKiloDb(): Promise<SqlDatabase | null> {
		const dbPath = this.getKiloDbPath();
		const stats = this.statKiloDb(dbPath);
		if (!stats) { return this.getCachedDbForPath(dbPath); }

		if (this.isCachedDbCurrent(dbPath, stats)) {
			return this._dbCache?.db ?? null;
		}

		const cacheKey = this.getDbCacheKey(dbPath, stats);
		const inflight = this._dbCacheInflight.get(cacheKey);
		if (inflight) { return inflight; }

		const createDbPromise = this.refreshKiloDb(dbPath, stats);
		this._dbCacheInflight.set(cacheKey, createDbPromise);
		try {
			return await createDbPromise;
		} finally {
			if (this._dbCacheInflight.get(cacheKey) === createDbPromise) {
				this._dbCacheInflight.delete(cacheKey);
			}
		}
	}

	/**
	 * Read session metadata from the Kilo Code SQLite database.
	 */
	async readKiloDbSession(sessionId: string): Promise<any | null> {
		const db = await this.getKiloDb();
		if (!db) { return null; }
		try {
			const result = db.exec('SELECT id, slug, title, time_created, time_updated, project_id, directory FROM session WHERE id = ?', [sessionId]);
			if (result.length === 0 || result[0].values.length === 0) { return null; }
			const row = result[0].values[0];
			const cols = result[0].columns;
			const obj: any = {};
			for (let i = 0; i < cols.length; i++) { obj[cols[i]] = row[i]; }
			return {
				id: obj.id,
				slug: obj.slug,
				title: obj.title,
				projectID: obj.project_id,
				directory: obj.directory,
				time: { created: obj.time_created, updated: obj.time_updated }
			};
		} catch {
			return null;
		}
	}

	/**
	 * Read all Kilo Code messages from the SQLite database for a given session.
	 */
	async readKiloDbMessages(sessionId: string): Promise<any[]> {
		const db = await this.getKiloDb();
		if (!db) { return []; }
		try {
			const result = db.exec('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC', [sessionId]);
			if (result.length === 0) { return []; }
			return result[0].values.map((row: unknown[]) => {
				const data = JSON.parse(row[1] as string);
				data.id = row[0];
				data.time = data.time || {};
				data.time.created = data.time.created || row[2];
				return data;
			});
		} catch {
			return [];
		}
	}

	/**
	 * Read all Kilo Code parts from the SQLite database for a given message.
	 */
	async readKiloDbParts(messageId: string): Promise<any[]> {
		const db = await this.getKiloDb();
		if (!db) { return []; }
		try {
			const result = db.exec('SELECT id, data, time_created FROM part WHERE message_id = ? ORDER BY time_created ASC', [messageId]);
			if (result.length === 0) { return []; }
			return result[0].values.map((row: unknown[]) => {
				const data = JSON.parse(row[1] as string);
				data.id = row[0];
				data.time = data.time || {};
				data.time.created = data.time.created || row[2];
				return data;
			});
		} catch {
			return [];
		}
	}

	/**
	 * Discover all session IDs from the Kilo Code SQLite database.
	 */
	async discoverKiloDbSessions(): Promise<string[]> {
		const db = await this.getKiloDb();
		if (!db) { return []; }
		try {
			const result = db.exec('SELECT id FROM session');
			if (result.length === 0) { return []; }
			return result[0].values.map((row: unknown[]) => row[0] as string);
		} catch {
			return [];
		}
	}

	/**
	 * Get file stats for a session, handling Kilo Code DB virtual paths.
	 * For DB sessions, returns the stat of the kilo.db file itself.
	 */
	async statSessionFile(sessionFile: string): Promise<fs.Stats> {
		if (this.isKiloDbSession(sessionFile)) {
			return fs.promises.stat(this.getKiloDbPath());
		}
		return fs.promises.stat(sessionFile);
	}

	/**
	 * Get Kilo Code messages for a session (all sessions live in the database).
	 */
	async getKiloMessagesForSession(sessionFilePath: string): Promise<any[]> {
		const sessionId = this.getKiloSessionId(sessionFilePath);
		if (!sessionId) { return []; }
		return this.readKiloDbMessages(sessionId);
	}

	/**
	 * Get Kilo Code parts for a message.
	 */
	async getKiloPartsForMessage(messageId: string): Promise<any[]> {
		return this.readKiloDbParts(messageId);
	}

	/**
	 * Extract actual token counts from a Kilo Code session.
	 * Kilo Code stores actual token counts on assistant messages
	 * (tokens.input, tokens.output, tokens.reasoning, tokens.total).
	 */
	async getTokensFromKiloSession(sessionFilePath: string): Promise<{ tokens: number; thinkingTokens: number }> {
		const messages = await this.getKiloMessagesForSession(sessionFilePath);
		return this.getTokensFromKiloMessages(messages);
	}

	private getTokensFromKiloMessages(messages: any[]): { tokens: number; thinkingTokens: number } {
		let thinkingTokens = 0;

		// Kilo Code messages have a cumulative `total` field that grows with each API call.
		// The last assistant message's `total` is the session total.
		// Summing input+output across messages would over-count because each API call
		// re-sends the full conversation context as input.
		let sessionTotal = 0;
		for (const msg of messages) {
			if (msg.role === 'assistant' && msg.tokens) {
				const total = toFiniteNumber(msg.tokens.total);
				if (total > 0) { sessionTotal = total; } // cumulative — last one wins
				thinkingTokens += toFiniteNumber(msg.tokens.reasoning);
			}
		}

		return { tokens: sessionTotal, thinkingTokens };
	}

	/**
	 * Count interactions in a Kilo Code session (number of user messages).
	 */
	async countKiloInteractions(sessionFilePath: string): Promise<number> {
		const messages = await this.getKiloMessagesForSession(sessionFilePath);
		return this.countKiloInteractionsFromMessages(messages);
	}

	private countKiloInteractionsFromMessages(messages: any[]): number {
		return messages.filter(m => m.role === 'user').length;
	}

	private getAssistantMessagesByParent(messages: any[]): Map<string, any[]> {
		const assistantMessagesByParent = new Map<string, any[]>();
		for (const msg of messages) {
			if (msg.role !== 'assistant' || !msg.parentID) { continue; }
			const existing = assistantMessagesByParent.get(msg.parentID) ?? [];
			existing.push(msg);
			assistantMessagesByParent.set(msg.parentID, existing);
		}
		return assistantMessagesByParent;
	}

	/**
	 * Get per-model token usage from a Kilo Code session.
	 * Extracts model info from assistant messages.
	 */
	async getKiloModelUsage(sessionFilePath: string): Promise<ModelUsage> {
		const messages = await this.getKiloMessagesForSession(sessionFilePath);
		return this.getKiloModelUsageFromMessages(messages);
	}

	private computeTurnCumTotal(turnAssistantMsgs: any[], prevTotal: number): number {
		let cumTotal = prevTotal;
		for (const am of turnAssistantMsgs) {
			cumTotal = Math.max(cumTotal, toFiniteNumber(am.tokens?.total));
		}
		return cumTotal;
	}

	private getKiloModelUsageFromMessages(messages: any[]): ModelUsage {
		const modelUsage: ModelUsage = {};
		const assistantMessagesByParent = this.getAssistantMessagesByParent(messages);
		let prevTotal = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			const turnAssistantMsgs = assistantMessagesByParent.get(msg.id) ?? [];
			if (turnAssistantMsgs.length === 0) { continue; }
			const turnCumTotal = this.computeTurnCumTotal(turnAssistantMsgs, prevTotal);
			const turnTokens = turnCumTotal - prevTotal;
			if (turnTokens <= 0) { prevTotal = turnCumTotal; continue; }
			const model = turnAssistantMsgs[0].modelID || turnAssistantMsgs[0].model?.modelID || 'unknown';
			// Untrusted `model` string from parsed session JSON — see protoGuard.ts.
			if (isUnsafeObjectKey(model)) { prevTotal = turnCumTotal; continue; }
			if (!modelUsage[model]) { modelUsage[model] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
			const turnOutput = turnAssistantMsgs.reduce((sum, m) =>
				sum + toFiniteNumber(m.tokens?.output) + toFiniteNumber(m.tokens?.reasoning), 0);
			modelUsage[model].inputTokens += Math.max(0, turnTokens - turnOutput);
			modelUsage[model].outputTokens += turnOutput;
			const turnCachedRead = turnAssistantMsgs.reduce((sum, m) => sum + toFiniteNumber(m.tokens?.cache?.read), 0);
			const turnCacheCreation = turnAssistantMsgs.reduce((sum, m) => sum + toFiniteNumber(m.tokens?.cache?.write), 0);
			if (turnCachedRead > 0) { modelUsage[model].cachedReadTokens = (modelUsage[model].cachedReadTokens ?? 0) + turnCachedRead; }
			if (turnCacheCreation > 0) { modelUsage[model].cacheCreationTokens = (modelUsage[model].cacheCreationTokens ?? 0) + turnCacheCreation; }
			prevTotal = turnCumTotal;
		}
		return modelUsage;
	}

	/**
	 * Get all session data from a Kilo Code session in one call (for backend sync).
	 * Returns tokens, interactions, model usage, and timestamp.
	 * Includes per-model interaction counts in modelUsage.
	 */
	async getKiloSessionData(sessionFilePath: string): Promise<{ tokens: number; interactions: number; modelUsage: KiloModelUsageWithInteractions; timestamp: number }> {
		const messages = await this.getKiloMessagesForSession(sessionFilePath);

		// Use the first message's creation time as the session timestamp.
		// Messages store their timestamp in the nested `time.created` field.
		let timestamp = Date.now();
		const created = messages[0]?.time?.created;
		if (typeof created === 'number' && Number.isFinite(created)) {
			timestamp = created;
		} else if (typeof created === 'string') {
			const parsed = Date.parse(created);
			if (!Number.isNaN(parsed)) { timestamp = parsed; }
		}

		const { tokens } = this.getTokensFromKiloMessages(messages);
		const interactions = this.countKiloInteractionsFromMessages(messages);
		const baseModelUsage = this.getKiloModelUsageFromMessages(messages);
		const assistantMessagesByParent = this.getAssistantMessagesByParent(messages);

		// Count interactions per model (each user turn -> 1 interaction for the model that responded)
		const modelInteractions: { [model: string]: number } = {};
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			const turnAssistantMsgs = assistantMessagesByParent.get(msg.id) ?? [];
			if (turnAssistantMsgs.length === 0) { continue; }

			const model = turnAssistantMsgs[0].modelID || turnAssistantMsgs[0].model?.modelID || 'unknown';
			// Untrusted `model` string from parsed session JSON — see protoGuard.ts.
			if (isUnsafeObjectKey(model)) { continue; }
			modelInteractions[model] = (modelInteractions[model] || 0) + 1;
		}

		// Merge interaction counts into model usage. baseModelUsage's own keys are already
		// guarded (see getKiloModelUsageFromMessages), so Object.entries only yields safe keys.
		const modelUsage: KiloModelUsageWithInteractions = {};
		for (const [model, usage] of Object.entries(baseModelUsage)) {
			modelUsage[model] = {
				...usage,
				interactions: modelInteractions[model] || 0
			};
		}

		return { tokens, interactions, modelUsage, timestamp };
	}
}
