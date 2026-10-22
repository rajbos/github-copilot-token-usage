/**
 * DevinCliDataAccess — reads session data from Devin CLI's global SQLite database.
 *
 * Devin CLI (Cognition Labs) is a separate tool from the Devin desktop app (which is a
 * fork/rebrand of Windsurf, see windsurf.ts / devin-windsurf-session-format.md). Devin CLI
 * is an ACP (Agent Client Protocol, https://agentclientprotocol.com) based agent whose
 * backend binary is internally named "chisel" (crates: chisel_server, chisel_agent,
 * chisel_api) — confirming a Rust implementation.
 *
 * All sessions across all projects/working-directories are stored in a single global
 * SQLite database (no per-project registry, unlike Crush's projects.json):
 *   Windows: %APPDATA%\devin\cli\sessions.db
 *   macOS:   ~/Library/Application Support/devin/cli/sessions.db   (inferred, Rust `dirs`
 *            crate convention — not verified on a live macOS install)
 *   Linux:   $XDG_DATA_HOME/devin/cli/sessions.db or ~/.local/share/devin/cli/sessions.db
 *            (inferred, same convention — not verified)
 *
 * Virtual path scheme: <absolute-path-to-sessions.db>#<session-id>
 * Example (Windows): C:\Users\alice\AppData\Roaming\devin\cli\sessions.db#3ee22c56-...
 * Mirrors the Crush (crush.db#<uuid>) / OpenCode (opencode.db#ses_<id>) convention.
 *
 * Schema (confirmed via PRAGMA table_info / refinery_schema_history on a live but EMPTY
 * install — see docs/logFilesSchema/devin-cli-session-format.md for the full writeup and
 * known limitations):
 *   sessions:          id, working_directory, backend_type, model, agent_mode, created_at,
 *                      last_activity_at, title, main_chain_id, shell_last_seen_index,
 *                      cogs_json, workspace_dirs, hidden, metadata
 *   message_nodes:     row_id, session_id, node_id, parent_node_id (NULL = root), chat_message
 *                      (JSON — shape inferred from the ACP v2 schema since no live populated
 *                      row was available at implementation time), created_at, metadata
 *   prompt_history:    id, content, timestamp, session_id, is_shell
 *   tool_call_state:   session_id, tool_call_id, tool_call_json, tool_call_update_json
 *
 * IMPORTANT CAVEAT: at the time this adapter was written, sessions.db had zero rows in
 * every data table despite an actively running Devin CLI ACP server process on the test
 * machine. The chat_message JSON shape and cogs_json token/cost shape are therefore
 * inferred from the ACP v2 protocol spec (UsageUpdate/Cost/ContentBlock types), not
 * confirmed against real data. Parsing is intentionally defensive/best-effort; the token
 * count falls back to a ~4-chars/token text estimate when no structured usage data is found.
 *
 * created_at / last_activity_at are documented in the task as epoch integers; their unit
 * (seconds vs milliseconds) could not be verified against live data. This implementation
 * assumes epoch SECONDS (consistent with Crush's convention for the same Cognition/Charm
 * SQLite-based CLI-agent pattern) and multiplies by 1000 before constructing JS Dates.
 * This should be re-verified once real session data exists.
 */
/// <reference types="sql.js" />
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqlJsFileDbCacheBase } from './utils/sqlJsDbCache';
import type { ModelUsage } from './types';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { toLocalDayKey } from './utils/dayKeys';


const DB_MARKER = 'devin/cli/sessions.db#';

export interface DevinCliSession {
	id: string;
	working_directory: string | null;
	backend_type: string | null;
	model: string | null;
	agent_mode: string | null;
	created_at: number | null;
	last_activity_at: number | null;
	title: string | null;
	main_chain_id: number | null;
	cogs_json: string | null;
	hidden: number | null;
}

export interface DevinCliMessageNode {
	row_id: number;
	session_id: string;
	node_id: number;
	parent_node_id: number | null;
	chat_message: string | null;
	created_at: number | null;
	metadata: string | null;
}

export interface DevinCliToolCall {
	session_id: string;
	tool_call_id: string;
	tool_call_json: string | null;
	tool_call_update_json: string | null;
}

/** Parsed representation of a message_nodes.chat_message row, best-effort. */
export interface ParsedChatMessage {
	role: 'user' | 'assistant' | 'tool' | 'unknown';
	text: string;
}

/** Returns the first finite numeric value found among the given keys, else 0. */
function firstNumericField(obj: Record<string, unknown>, keys: string[]): number {
	for (const key of keys) {
		const v = obj[key];
		if (typeof v === 'number' && Number.isFinite(v) && v !== 0) { return v; }
	}
	return 0;
}

export class DevinCliDataAccess extends SqlJsFileDbCacheBase {
	/** Test-only override for the sessions.db path, so tests don't depend on the real OS default location. */
	private _dbPathOverride: string | null = null;

	dispose(): void {
		super.dispose();
	}

	/** Cross-platform config/data dir for Devin CLI. */
	getConfigDir(): string {
		if (process.platform === 'win32') {
			const appData = process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming');
			return path.join(appData, 'devin', 'cli');
		}
		if (process.platform === 'darwin') {
			return path.join(os.homedir(), 'Library', 'Application Support', 'devin', 'cli');
		}
		// Linux and other Unix-likes: XDG_DATA_HOME or ~/.local/share (inferred, unverified).
		const xdgDataHome = process.env['XDG_DATA_HOME'];
		const base = xdgDataHome && xdgDataHome.trim() ? xdgDataHome : path.join(os.homedir(), '.local', 'share');
		return path.join(base, 'devin', 'cli');
	}

	/** Absolute path to sessions.db. */
	getDbPath(): string {
		return this._dbPathOverride ?? path.join(this.getConfigDir(), 'sessions.db');
	}

	/** Test-only: override the sessions.db path so tests don't depend on the real OS default location. */
	setDbPathOverrideForTests(dbPath: string | null): void {
		this._dbPathOverride = dbPath;
	}

	/** Build a virtual session path for the given session id. */
	virtualPath(sessionId: string): string {
		return `${this.getDbPath()}#${sessionId}`;
	}

	/** Returns true if the path is a Devin CLI virtual session path (backslashes normalised). */
	isDevinCliSessionFile(filePath: string): boolean {
		return filePath.replace(/\\/g, '/').toLowerCase().includes(DB_MARKER);
	}

	/** Extract the real DB file path from a virtual session path. */
	getDbPathFromVirtual(virtualPath: string): string {
		const idx = virtualPath.lastIndexOf('sessions.db#');
		if (idx === -1) { return virtualPath; }
		return virtualPath.substring(0, idx + 'sessions.db'.length);
	}

	/** Extract the session id from a virtual session path. */
	getSessionId(virtualPath: string): string | null {
		const idx = virtualPath.lastIndexOf('sessions.db#');
		if (idx === -1) { return null; }
		const id = virtualPath.substring(idx + 'sessions.db#'.length);
		return id || null;
	}

	/** Stat the underlying sessions.db file for a virtual path. */
	async statSessionFile(virtualPath: string): Promise<fs.Stats> {
		return fs.promises.stat(this.getDbPathFromVirtual(virtualPath));
	}

	/** Discover all non-hidden session ids in the DB. */
	async discoverSessionIds(): Promise<string[]> {
		const dbPath = this.getDbPath();
		const db = await this.getDb(dbPath);
		if (!db) { return []; }
		try {
			const result = db.exec('SELECT id FROM sessions WHERE hidden = 0 OR hidden IS NULL ORDER BY last_activity_at DESC');
			return this.rowsToObjects(result).map(r => r['id'] as string);
		} catch {
			try {
				// hidden column may not exist on very old schema versions — fall back.
				const result = db.exec('SELECT id FROM sessions ORDER BY last_activity_at DESC');
				return this.rowsToObjects(result).map(r => r['id'] as string);
			} catch {
				return [];
			}
		}
	}

	/** Read session metadata for a virtual session path. */
	async readSession(virtualPath: string): Promise<DevinCliSession | null> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return null; }
		const db = await this.getDb(dbPath);
		if (!db) { return null; }
		try {
			const result = db.exec(
				`SELECT id, working_directory, backend_type, model, agent_mode, created_at,
				        last_activity_at, title, main_chain_id, cogs_json, hidden
				 FROM sessions WHERE id = ?`,
				[sessionId],
			);
			const rows = this.rowsToObjects(result);
			if (rows.length === 0) { return null; }
			return rows[0] as unknown as DevinCliSession;
		} catch {
			return null;
		}
	}

	/** Read all message nodes for a session (unordered — caller reconstructs the chain). */
	async getMessageNodes(virtualPath: string): Promise<DevinCliMessageNode[]> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return []; }
		const db = await this.getDb(dbPath);
		if (!db) { return []; }
		try {
			const result = db.exec(
				`SELECT row_id, session_id, node_id, parent_node_id, chat_message, created_at, metadata
				 FROM message_nodes WHERE session_id = ? ORDER BY created_at ASC`,
				[sessionId],
			);
			return this.rowsToObjects(result) as unknown as DevinCliMessageNode[];
		} catch {
			return [];
		}
	}

	/** Read all tool call state rows for a session. */
	async getToolCalls(virtualPath: string): Promise<DevinCliToolCall[]> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return []; }
		const db = await this.getDb(dbPath);
		if (!db) { return []; }
		try {
			const result = db.exec(
				`SELECT session_id, tool_call_id, tool_call_json, tool_call_update_json
				 FROM tool_call_state WHERE session_id = ?`,
				[sessionId],
			);
			return this.rowsToObjects(result) as unknown as DevinCliToolCall[];
		} catch {
			return [];
		}
	}

	/**
	 * Reconstruct the ordered "main" conversation chain for a session.
	 *
	 * message_nodes form a tree (parent_node_id), not a flat list — this happens when a
	 * user edits/regenerates a message, leaving abandoned branches. When session.main_chain_id
	 * identifies the head (leaf) node_id of the currently active branch, this walks parent
	 * pointers from that leaf back to the root and reverses the result. If main_chain_id is
	 * absent or the leaf can't be resolved, falls back to created_at ordering of all nodes
	 * (which may include abandoned branches, but is a reasonable best-effort fallback).
	 */
	buildMainChain(nodes: DevinCliMessageNode[], mainChainId: number | null): DevinCliMessageNode[] {
		if (nodes.length === 0) { return []; }
		if (mainChainId === null || mainChainId === undefined) {
			return [...nodes].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
		}
		const byNodeId = new Map<number, DevinCliMessageNode>();
		for (const n of nodes) { byNodeId.set(n.node_id, n); }
		const chain: DevinCliMessageNode[] = [];
		let current = byNodeId.get(mainChainId);
		const seen = new Set<number>();
		while (current && !seen.has(current.node_id)) {
			seen.add(current.node_id);
			chain.push(current);
			current = current.parent_node_id !== null ? byNodeId.get(current.parent_node_id) : undefined;
		}
		if (chain.length === 0) {
			return [...nodes].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
		}
		return chain.reverse();
	}

	/**
	 * Best-effort parse of a message_nodes.chat_message JSON blob.
	 *
	 * Shape is inferred from the ACP v2 protocol (UserMessage/AgentMessage/ContentBlock)
	 * since no live populated row was available. Handles a few plausible shapes defensively:
	 *  - { role: 'user'|'assistant'|'tool', content: string | ContentBlock[] }
	 *  - { sessionUpdate: 'user_message'|'agent_message'|..., content: ContentBlock[] }
	 *  - { text: string } (flat fallback)
	 */
	parseChatMessage(raw: string | null): ParsedChatMessage {
		if (!raw) { return { role: 'unknown', text: '' }; }
		let json: unknown;
		try { json = JSON.parse(raw); } catch { return { role: 'unknown', text: raw }; }
		if (typeof json !== 'object' || json === null) { return { role: 'unknown', text: '' }; }
		const obj = json as Record<string, unknown>;
		return { role: this.extractRole(obj), text: this.extractText(obj) };
	}

	private extractRole(obj: Record<string, unknown>): ParsedChatMessage['role'] {
		const role = obj['role'];
		if (role === 'user' || role === 'assistant' || role === 'tool') { return role; }
		const sessionUpdate = obj['sessionUpdate'] ?? obj['session_update'];
		if (typeof sessionUpdate === 'string') {
			if (sessionUpdate.startsWith('user_message')) { return 'user'; }
			if (sessionUpdate.startsWith('agent_message')) { return 'assistant'; }
			if (sessionUpdate.includes('tool_call')) { return 'tool'; }
		}
		return 'unknown';
	}

	private extractText(obj: Record<string, unknown>): string {
		const content = obj['content'];
		if (typeof content === 'string') { return content; }
		if (Array.isArray(content)) {
			return content
				.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
				.filter(block => block['type'] === 'text' && typeof block['text'] === 'string')
				.map(block => block['text'] as string)
				.join('\n');
		}
		if (typeof obj['text'] === 'string') { return obj['text'] as string; }
		return '';
	}

	private estimateTokens(text: string): number {
		if (!text) { return 0; }
		return Math.ceil(text.length / 4);
	}

	/**
	 * Best-effort extraction of a token/usage summary from sessions.cogs_json.
	 * Field names are guessed defensively (no live example available) — probes several
	 * plausible names used by cost-tracking ("cogs" = cost-of-goods-sold) systems.
	 */
	private extractCogsTokens(cogsJson: string | null): { input: number; output: number; thinking: number } | null {
		const obj = this.parseJsonObject(cogsJson);
		if (!obj) { return null; }
		const input = firstNumericField(obj, ['input_tokens', 'prompt_tokens', 'inputTokens']);
		const output = firstNumericField(obj, ['output_tokens', 'completion_tokens', 'outputTokens']);
		const thinking = firstNumericField(obj, ['reasoning_tokens', 'thinking_tokens', 'reasoningTokens']);
		if (input === 0 && output === 0 && thinking === 0) {
			// ACP UsageUpdate-style snapshot: { used, size } — 'used' is context tokens currently
			// in context, not a cumulative total, but is the best signal available if present.
			const used = firstNumericField(obj, ['used', 'total_tokens', 'tokens_used']);
			return used > 0 ? { input: used, output: 0, thinking: 0 } : null;
		}
		return { input, output, thinking };
	}

	private parseJsonObject(raw: string | null): Record<string, unknown> | null {
		if (!raw) { return null; }
		try {
			const json = JSON.parse(raw);
			return (typeof json === 'object' && json !== null) ? json as Record<string, unknown> : null;
		} catch {
			return null;
		}
	}

	/** Get token counts (actual when available via cogs_json, else estimated from text). */
	async getTokens(virtualPath: string): Promise<{ tokens: number; thinkingTokens: number }> {
		const session = await this.readSession(virtualPath);
		const cogs = this.extractCogsTokens(session?.cogs_json ?? null);
		if (cogs) {
			return { tokens: cogs.input + cogs.output + cogs.thinking, thinkingTokens: cogs.thinking };
		}
		const nodes = await this.getMessageNodes(virtualPath);
		let tokens = 0;
		for (const node of nodes) {
			const parsed = this.parseChatMessage(node.chat_message);
			tokens += this.estimateTokens(parsed.text);
		}
		return { tokens, thinkingTokens: 0 };
	}

	/** Count user-role interactions (turns) in the session's main chain. */
	async countInteractions(virtualPath: string): Promise<number> {
		const nodes = await this.getMessageNodes(virtualPath);
		let count = 0;
		for (const node of nodes) {
			if (this.parseChatMessage(node.chat_message).role === 'user') { count++; }
		}
		if (count > 0) { return count; }
		// Fall back to prompt_history (shell/prompt entries) when message_nodes is empty.
		return this.countPromptHistory(virtualPath);
	}

	private async countPromptHistory(virtualPath: string): Promise<number> {
		const dbPath = this.getDbPathFromVirtual(virtualPath);
		const sessionId = this.getSessionId(virtualPath);
		if (!sessionId) { return 0; }
		const db = await this.getDb(dbPath);
		if (!db) { return 0; }
		try {
			const result = db.exec('SELECT COUNT(*) as c FROM prompt_history WHERE session_id = ?', [sessionId]);
			const rows = this.rowsToObjects(result);
			return rows.length > 0 ? (rows[0]['c'] as number) || 0 : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Per-model token usage. ACP does not expose a per-message model field, so the
	 * session-level `model` column is used to attribute all estimated tokens for the
	 * session — this cannot represent mid-session model switches (not exposed by the schema).
	 */
	async getModelUsage(virtualPath: string): Promise<ModelUsage> {
		const session = await this.readSession(virtualPath);
		// Untrusted `model` string from the session database — treat unsafe object keys
		// like a missing model (see protoGuard.ts).
		const rawModel = session?.model;
		const model = rawModel && !isUnsafeObjectKey(rawModel) ? rawModel : 'unknown';
		const nodes = await this.getMessageNodes(virtualPath);
		const usage: ModelUsage = { [model]: { inputTokens: 0, outputTokens: 0, sessions: 0 } };
		for (const node of nodes) {
			const parsed = this.parseChatMessage(node.chat_message);
			const est = this.estimateTokens(parsed.text);
			if (parsed.role === 'user') { usage[model].inputTokens += est; }
			else if (parsed.role === 'assistant') { usage[model].outputTokens += est; }
		}
		return usage;
	}

	/** Per-local-day fractions for accurate multi-day attribution. */
	async getDailyFractions(virtualPath: string): Promise<Record<string, number>> {
		const nodes = await this.getMessageNodes(virtualPath);
		const counts: Record<string, number> = {};
		let total = 0;
		for (const node of nodes) {
			if (!node.created_at) { continue; }
			const dateKey = toLocalDayKey(new Date(node.created_at * 1000));
			counts[dateKey] = (counts[dateKey] || 0) + 1;
			total++;
		}
		if (total === 0) {
			const session = await this.readSession(virtualPath);
			const fallbackDate = session?.last_activity_at
				? toLocalDayKey(new Date(session.last_activity_at * 1000))
				: toLocalDayKey(new Date());
			return { [fallbackDate]: 1.0 };
		}
		const fractions: Record<string, number> = {};
		for (const [day, count] of Object.entries(counts)) { fractions[day] = count / total; }
		return fractions;
	}
}
