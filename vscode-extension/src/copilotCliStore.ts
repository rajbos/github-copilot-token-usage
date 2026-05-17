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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs from 'sql.js';

export interface CliStoreSession {
	id: string;
	repository: string | null;
	branch: string | null;
	summary: string | null;
	created_at: string | null;
	updated_at: string | null;
}

export interface CliStoreTurn {
	session_id: string;
	turn_index: number;
	user_message: string | null;
	assistant_response: string | null;
	timestamp: string | null;
}

export class CopilotCliStoreAccess {
	private _sqlJsModule: any = null;

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

	/** Stat the underlying session-store.db file. */
	async stat(virtualPath: string): Promise<fs.Stats> {
		return fs.promises.stat(this.getDbPathFromVirtual(virtualPath));
	}

	/** Lazily initialise and cache the sql.js WASM module. */
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
	 * Discover all session IDs in the DB whose UUIDs are NOT in `knownUuids`.
	 * These are sessions that exist only in the DB (no events.jsonl on disk).
	 * Returned in descending updated_at order (most recent first).
	 */
	async discoverNewSessions(knownUuids: Set<string>): Promise<string[]> {
		const dbPath = this.getDbPath();
		if (!fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec('SELECT id FROM sessions ORDER BY updated_at DESC');
				if (result.length === 0) { return []; }
				return (result[0].values as unknown[][])
					.map(row => row[0] as string)
					.filter(id => !knownUuids.has(id));
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/** Read session metadata for a virtual session path. */
	async readSession(virtualPath: string): Promise<CliStoreSession | null> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId || !fs.existsSync(dbPath)) { return null; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec(
					'SELECT id, repository, branch, summary, created_at, updated_at FROM sessions WHERE id = ?',
					[sessionId],
				);
				if (result.length === 0 || result[0].values.length === 0) { return null; }
				const cols = result[0].columns;
				const row = result[0].values[0];
				const obj: Record<string, unknown> = {};
				cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
				return obj as unknown as CliStoreSession;
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	}

	/** Read all turns for a session, ordered by turn_index. */
	async getTurns(virtualPath: string): Promise<CliStoreTurn[]> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId || !fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec(
					'SELECT session_id, turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index ASC',
					[sessionId],
				);
				if (result.length === 0) { return []; }
				const cols = result[0].columns;
				return (result[0].values as unknown[][]).map(row => {
					const obj: Record<string, unknown> = {};
					cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
					return obj as unknown as CliStoreTurn;
				});
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/** Count turns (user interactions) for a session. */
	async countTurns(virtualPath: string): Promise<number> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId || !fs.existsSync(dbPath)) { return 0; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec(
					'SELECT COUNT(*) FROM turns WHERE session_id = ?',
					[sessionId],
				);
				if (result.length === 0 || result[0].values.length === 0) { return 0; }
				return (result[0].values[0][0] as number) || 0;
			} finally {
				db.close();
			}
		} catch {
			return 0;
		}
	}

	/**
	 * Returns per-UTC-day fractions for accurate session attribution.
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
				const dateKey = new Date(turn.timestamp).toISOString().slice(0, 10);
				counts[dateKey] = (counts[dateKey] || 0) + 1;
				total++;
			} catch { /* skip malformed timestamp */ }
		}
		if (total === 0) {
			// Fallback: use session updated_at
			const session = await this.readSession(virtualPath);
			const fallbackDate = session?.updated_at
				? new Date(session.updated_at).toISOString().slice(0, 10)
				: new Date().toISOString().slice(0, 10);
			return { [fallbackDate]: 1.0 };
		}
		const fractions: Record<string, number> = {};
		for (const [day, count] of Object.entries(counts)) {
			fractions[day] = count / total;
		}
		return fractions;
	}
}
