/**
 * OpenCode data access layer.
 * Handles reading session data from OpenCode's JSON files and SQLite database.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import initSqlJs from 'sql.js';
import type { ModelUsage } from './types';

export class OpenCodeDataAccess {
	private _sqlJsModule: any = null;
	private readonly extensionUri: vscode.Uri;

	constructor(extensionUri: vscode.Uri) {
		this.extensionUri = extensionUri;
	}

	/**
	 * Get the OpenCode data directory path.
	 * OpenCode follows XDG Base Directory Specification:
	 * - Windows: %USERPROFILE%\.local\share\opencode\
	 * - Linux/macOS: ~/.local/share/opencode/
	 */
	getOpenCodeDataDir(): string {
		const platform = os.platform();
		const homedir = os.homedir();
		if (platform === 'win32') {
			return path.join(homedir, '.local', 'share', 'opencode');
		}
		const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
		return path.join(xdgDataHome, 'opencode');
	}

	/**
	 * Check if a session file is an OpenCode session file.
	 * OpenCode sessions are stored in ~/.local/share/opencode/storage/session/ (JSON)
	 * or referenced via virtual paths like opencode.db#ses_<id> (SQLite).
	 */
	isOpenCodeSessionFile(filePath: string): boolean {
		const normalized = filePath.toLowerCase().replace(/\\/g, '/');
		return normalized.includes('/opencode/storage/session/') || normalized.includes('/opencode/opencode.db#ses_');
	}

	/**
	 * Check if a session is stored in the OpenCode SQLite database.
	 * Virtual path format: <opencode_dir>/opencode.db#ses_<id>
	 */
	isOpenCodeDbSession(filePath: string): boolean {
		return filePath.includes('opencode.db#ses_');
	}

	/**
	 * Lazily initialize and return the sql.js SQL module.
	 */
	async initSqlJs(): Promise<any> {
		if (this._sqlJsModule) { return this._sqlJsModule; }
		const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
		let wasmBinary: Uint8Array | undefined;
		if (fs.existsSync(wasmPath)) {
			wasmBinary = fs.readFileSync(wasmPath);
		}
		this._sqlJsModule = await initSqlJs(wasmBinary ? { wasmBinary } : undefined);
		return this._sqlJsModule;
	}

	/**
	 * Read session metadata from the OpenCode SQLite database.
	 */
	async readOpenCodeDbSession(sessionId: string): Promise<any | null> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return null; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
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
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	}

	/**
	 * Read all OpenCode messages from the SQLite database for a given session.
	 */
	async readOpenCodeDbMessages(sessionId: string): Promise<any[]> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
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
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/**
	 * Read all OpenCode parts from the SQLite database for a given message.
	 */
	async readOpenCodeDbParts(messageId: string): Promise<any[]> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
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
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/**
	 * Discover all session IDs from the OpenCode SQLite database.
	 */
	async discoverOpenCodeDbSessions(): Promise<string[]> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec('SELECT id FROM session');
				if (result.length === 0) { return []; }
				return result[0].values.map((row: unknown[]) => row[0] as string);
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/**
	 * Get file stats for a session, handling OpenCode DB virtual paths.
	 * For DB sessions, returns the stat of the opencode.db file itself.
	 */
	async statSessionFile(sessionFile: string): Promise<fs.Stats> {
		if (this.isOpenCodeDbSession(sessionFile)) {
			const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
			return fs.promises.stat(dbPath);
		}
		return fs.promises.stat(sessionFile);
	}

	/**
	 * Read all OpenCode message files for a given session.
	 * Messages are stored in ~/.local/share/opencode/storage/message/ses_<id>/
	 * Returns an array of parsed message objects sorted by creation time.
	 */
	readOpenCodeMessages(sessionId: string): any[] {
		const dataDir = this.getOpenCodeDataDir();
		const messageDir = path.join(dataDir, 'storage', 'message', sessionId);
		const messages: any[] = [];
		try {
			if (!fs.existsSync(messageDir)) { return messages; }
			const entries = fs.readdirSync(messageDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
				try {
					const content = fs.readFileSync(path.join(messageDir, entry.name), 'utf8');
					const msg = JSON.parse(content);
					messages.push(msg);
				} catch {
					// Skip unreadable message files
				}
			}
		} catch {
			// Directory not accessible
		}
		// Sort by creation time
		messages.sort((a, b) => ((a.time?.created || 0) - (b.time?.created || 0)));
		return messages;
	}

	/**
	 * Read all OpenCode part files for a given message.
	 * Parts are stored in ~/.local/share/opencode/storage/part/msg_<id>/
	 * Returns an array of parsed part objects sorted by creation/start time.
	 */
	readOpenCodeParts(messageId: string): any[] {
		const dataDir = this.getOpenCodeDataDir();
		const partDir = path.join(dataDir, 'storage', 'part', messageId);
		const parts: any[] = [];
		try {
			if (!fs.existsSync(partDir)) { return parts; }
			const entries = fs.readdirSync(partDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
				try {
					const content = fs.readFileSync(path.join(partDir, entry.name), 'utf8');
					const part = JSON.parse(content);
					parts.push(part);
				} catch {
					// Skip unreadable part files
				}
			}
		} catch {
			// Directory not accessible
		}
		// Sort by start time if available, otherwise by ID
		parts.sort((a, b) => ((a.time?.start || 0) - (b.time?.start || 0)));
		return parts;
	}

	/**
	 * Extract the session ID from an OpenCode session file path.
	 * Handles both JSON file paths and DB virtual paths:
	 * - ".../storage/session/global/ses_abc123.json" -> "ses_abc123"
	 * - ".../opencode.db#ses_abc123" -> "ses_abc123"
	 */
	getOpenCodeSessionId(sessionFilePath: string): string | null {
		// Handle DB virtual path: opencode.db#ses_<id>
		const hashIdx = sessionFilePath.indexOf('opencode.db#');
		if (hashIdx !== -1) {
			return sessionFilePath.substring(hashIdx + 'opencode.db#'.length);
		}
		const basename = path.basename(sessionFilePath, '.json');
		return basename.startsWith('ses_') ? basename : null;
	}

	/**
	 * Get OpenCode messages for a session, trying DB first then JSON files.
	 */
	async getOpenCodeMessagesForSession(sessionFilePath: string): Promise<any[]> {
		const sessionId = this.getOpenCodeSessionId(sessionFilePath);
		if (!sessionId) { return []; }
		if (this.isOpenCodeDbSession(sessionFilePath)) {
			return this.readOpenCodeDbMessages(sessionId);
		}
		// Try DB first (may have newer data), fall back to JSON files
		const dbMessages = await this.readOpenCodeDbMessages(sessionId);
		if (dbMessages.length > 0) { return dbMessages; }
		return this.readOpenCodeMessages(sessionId);
	}

	/**
	 * Get OpenCode parts for a message, trying DB first then JSON files.
	 */
	async getOpenCodePartsForMessage(messageId: string): Promise<any[]> {
		const dbParts = await this.readOpenCodeDbParts(messageId);
		if (dbParts.length > 0) { return dbParts; }
		return this.readOpenCodeParts(messageId);
	}

	/**
	 * Extract actual token counts from an OpenCode session.
	 * OpenCode stores actual token counts in message files (tokens.input, tokens.output, tokens.reasoning).
	 */
	async getTokensFromOpenCodeSession(sessionFilePath: string): Promise<{ tokens: number; thinkingTokens: number }> {
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);
		let thinkingTokens = 0;

		// OpenCode messages have a cumulative `total` field that grows with each API call.
		// The last assistant message's `total` is the session total.
		// Summing input+output across messages would over-count because each API call
		// re-sends the full conversation context as input.
		let sessionTotal = 0;
		for (const msg of messages) {
			if (msg.role === 'assistant' && msg.tokens) {
				if (typeof msg.tokens.total === 'number') {
					sessionTotal = msg.tokens.total; // cumulative — last one wins
				}
				thinkingTokens += msg.tokens.reasoning || 0;
			}
		}

		return { tokens: sessionTotal, thinkingTokens };
	}

	/**
	 * Count interactions in an OpenCode session (number of user messages).
	 */
	async countOpenCodeInteractions(sessionFilePath: string): Promise<number> {
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);
		return messages.filter(m => m.role === 'user').length;
	}

	/**
	 * Get model usage from an OpenCode session.
	 * Extracts model info from assistant message files.
	 */
	async getOpenCodeModelUsage(sessionFilePath: string): Promise<ModelUsage> {
		const modelUsage: ModelUsage = {};
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);

		// OpenCode messages have a cumulative `total` field. To get per-turn tokens,
		// compute deltas between consecutive user turns using the last assistant message's total.
		let prevTotal = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			// Find all assistant messages for this turn
			const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
			if (turnAssistantMsgs.length === 0) { continue; }

			// Get cumulative total from the last assistant message in this turn
			let turnCumTotal = prevTotal;
			for (const am of turnAssistantMsgs) {
				if (typeof am.tokens?.total === 'number') {
					turnCumTotal = Math.max(turnCumTotal, am.tokens.total);
				}
			}
			const turnTokens = turnCumTotal - prevTotal;
			if (turnTokens <= 0) { prevTotal = turnCumTotal; continue; }

			// Attribute to the model used in this turn (from first assistant message)
			const model = turnAssistantMsgs[0].modelID || turnAssistantMsgs[0].model?.modelID || 'unknown';
			if (!modelUsage[model]) {
				modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
			}
			// Output tokens are the sum of actual output+reasoning across the turn's API calls
			const turnOutput = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.output || 0) + (m.tokens?.reasoning || 0), 0);
			const turnInput = Math.max(0, turnTokens - turnOutput);
			modelUsage[model].inputTokens += turnInput;
			modelUsage[model].outputTokens += turnOutput;

			// Track cache tokens if available (tokens.cache.read / tokens.cache.write)
			const turnCachedRead = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.cache?.read || 0), 0);
			const turnCacheCreation = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.cache?.write || 0), 0);
			if (turnCachedRead > 0) {
				modelUsage[model].cachedReadTokens = (modelUsage[model].cachedReadTokens ?? 0) + turnCachedRead;
			}
			if (turnCacheCreation > 0) {
				modelUsage[model].cacheCreationTokens = (modelUsage[model].cacheCreationTokens ?? 0) + turnCacheCreation;
			}

			prevTotal = turnCumTotal;
		}

		return modelUsage;
	}

	/**
	 * Get all session data from an OpenCode session in one call (for backend sync).
	 * Returns tokens, interactions, model usage, and timestamp.
	 * Includes per-model interaction counts in modelUsage.
	 */
	async getOpenCodeSessionData(sessionFilePath: string): Promise<{ tokens: number; interactions: number; modelUsage: ModelUsage & { [key: string]: { inputTokens: number; outputTokens: number; interactions?: number } }; timestamp: number }> {
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);
		
		// Get timestamp from the first message
		let timestamp = Date.now();
		if (messages.length > 0 && messages[0].time_created) {
			timestamp = messages[0].time_created;
		}

		// Get tokens
		const { tokens } = await this.getTokensFromOpenCodeSession(sessionFilePath);

		// Get interactions (total count)
		const interactions = await this.countOpenCodeInteractions(sessionFilePath);

		// Get model usage with per-model interaction counts
		const baseModelUsage = await this.getOpenCodeModelUsage(sessionFilePath);
		
		// Count interactions per model (each user turn -> 1 interaction for the model that responded)
		const modelInteractions: { [model: string]: number } = {};
		let prevTotal = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
			if (turnAssistantMsgs.length === 0) { continue; }
			
			const model = turnAssistantMsgs[0].modelID || turnAssistantMsgs[0].model?.modelID || 'unknown';
			modelInteractions[model] = (modelInteractions[model] || 0) + 1;
		}
		
		// Merge interaction counts into model usage
		const modelUsage: any = {};
		for (const [model, usage] of Object.entries(baseModelUsage)) {
			modelUsage[model] = {
				...usage,
				interactions: modelInteractions[model] || 0
			};
		}

		return { tokens, interactions, modelUsage, timestamp };
	}
}

