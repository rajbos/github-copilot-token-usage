/**
 * Claude Desktop Cowork data access layer.
 * Handles reading session data from Claude Desktop's Cowork (local agent mode) feature.
 *
 * Cowork sessions are stored under the Claude Desktop config dir:
 *   Windows: %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\
 *   macOS:   ~/Library/Application Support/Claude/
 * in a session subdirectory that was RENAMED by the desktop app:
 *   current: claude-code-sessions\         (since ~Aug 2026)
 *   legacy:  local-agent-mode-sessions\    (still read for older installs)
 *
 * Directory structure (both names):
 *   <base>/<app-uuid>/<machine-uuid>/local_<session-id>.json        — session metadata (title, timestamps, model)
 *   <base>/<app-uuid>/<machine-uuid>/local_<session-id>/
 *     .claude/projects/<hash>/<uuid>.jsonl                          — JSONL conversation + token data
 *     audit.jsonl                                                   — SKIP: HMAC audit trail, no usage data
 *     agent/                                                        — SKIP: background ditto sub-sessions
 *
 * Note: newer desktop versions may store only the metadata .json files here and write
 * the actual transcripts to the shared ~/.claude/projects/ directory (linked via the
 * metadata's cliSessionId) — those are picked up by the Claude Code adapter instead.
 *
 * ── JSONL FORMAT ────────────────────────────────────────────────────────────────────────────────
 *
 * Each line is a JSON object. Event types:
 *
 *   Queue bookends:
 *     {"type":"queue-operation","operation":"enqueue|dequeue",...}
 *
 *   User messages (two kinds — distinguish by content):
 *     Real human turn:   {"type":"user","isSidechain":false,"parentUuid":null,
 *                          "message":{"role":"user","content":"<text>"|[{"type":"text","text":"..."}]},
 *                          "timestamp":"<ISO>","uuid":"<uuid>"}
 *     Tool result:       {"type":"user","isSidechain":false,"parentUuid":"<assistant-uuid>",
 *                          "message":{"role":"user","content":[{"type":"tool_result",...}]}}
 *     Distinction: real turns have parentUuid=null/empty and content without tool_result blocks.
 *
 *   Assistant messages (streaming + final share the SAME top-level type):
 *     Streaming fragment: {"type":"assistant","requestId":"req_...","isSidechain":false,
 *                           "parentUuid":"<prev-uuid>",
 *                           "message":{"role":"assistant","model":"claude-*","stop_reason":"",
 *                                      "usage":{...with output_tokens:0...},"content":[...]}}
 *     Final event:        {"type":"assistant","requestId":"req_...","isSidechain":false,
 *                           "parentUuid":"<prev-uuid>",
 *                           "message":{"role":"assistant","model":"claude-*","stop_reason":"tool_use"|"end_turn",
 *                                      "usage":{...with real output_tokens...},"content":[...]}}
 *     CRITICAL: stop_reason is "" (empty string) on fragments, "tool_use"/"end_turn" on final events.
 *     Use falsy check (!stop_reason) to skip fragments — === null / === undefined will NOT work.
 *     Both streaming and final share the same requestId → use requestId dedup to count each turn once.
 *
 *   Other events (ignore for token/interaction counting):
 *     {"type":"last-prompt","lastPrompt":"..."}
 *     {"type":"attachment","attachment":{"type":"deferred_tools_delta","addedNames":[...]}}
 *
 * ── TOKEN USAGE ─────────────────────────────────────────────────────────────────────────────────
 *   Tokens are in final assistant events: message.usage.{input_tokens, output_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens}. These are ACTUAL Anthropic API counts.
 *   De-duplicate by requestId, taking only the event where !stop_reason is falsy (i.e., has value).
 *
 * ── INTERACTION COUNTING ────────────────────────────────────────────────────────────────────────
 *   Count only real human turns: type==='user' && !isSidechain && content has text but no tool_result.
 *   Tool-result user events (parentUuid set, content=[{type:'tool_result'}]) are NOT interactions.
 *   Neither are harness-injected synthetic turns whose text is nothing but a wrapper element such as
 *   <system-reminder>…</system-reminder> or <task-notification>…</task-notification>; a real prompt
 *   prefixed by such a wrapper still counts. See utils/claudeUserTurns.ts for the shared rule.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { normalizeClaudeModelId } from './claudecode';
import type { ModelUsage, ModelId } from './types';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { isHumanUserTurn } from './utils/claudeUserTurns';
import { normalizePathForComparison, normalizePath } from './workspaceHelpers';

/** Package name for the Claude Desktop Windows Store app. */
const CLAUDE_DESKTOP_PACKAGE = 'Claude_pzs8sxrjxfjjc';

/**
 * Session directory names used by the Claude Desktop app, newest first.
 * The app renamed 'local-agent-mode-sessions' to 'claude-code-sessions';
 * both are read so older installs keep working.
 */
const CLAUDE_DESKTOP_SESSION_DIR_NAMES = ['claude-code-sessions', 'local-agent-mode-sessions'] as const;

export class ClaudeDesktopDataAccess {

	/**
	 * Get the Claude Desktop config directory that holds the session subdirectories.
	 * Returns an empty string on unsupported platforms (Linux).
	 */
	private getDesktopConfigDir(): string {
		const platform = os.platform();
		if (platform === 'win32') {
			const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
			return path.join(
				localAppData,
				'Packages',
				CLAUDE_DESKTOP_PACKAGE,
				'LocalCache',
				'Roaming',
				'Claude'
			);
		}
		if (platform === 'darwin') {
			return path.join(
				os.homedir(),
				'Library',
				'Application Support',
				'Claude'
			);
		}
		return '';
	}

	/**
	 * Get all candidate Claude Desktop session base directories (newest naming first,
	 * legacy 'local-agent-mode-sessions' last). Empty on unsupported platforms.
	 */
	getDesktopSessionDirs(): string[] {
		const configDir = this.getDesktopConfigDir();
		if (!configDir) { return []; }
		return CLAUDE_DESKTOP_SESSION_DIR_NAMES.map(name => path.join(configDir, name));
	}

	/**
	 * Resolve which session base directory a session file belongs to. Falls back to
	 * the first (current-naming) candidate when the file matches none.
	 */
	getSessionDirForFile(filePath: string): string {
		const normalized = normalizePathForComparison(filePath);
		for (const dir of this.getDesktopSessionDirs()) {
			if (normalized.startsWith(normalizePathForComparison(dir))) { return dir; }
		}
		return this.getDesktopSessionDirs()[0] ?? '';
	}

	/**
	 * Check if a file path is a Claude Desktop Cowork session file.
	 * Cowork session files live inside claude-code-sessions/ (current) or
	 * local-agent-mode-sessions/ (legacy) and end with .jsonl.
	 */
	isDesktopSessionFile(filePath: string): boolean {
		const normalized = normalizePathForComparison(filePath);
		return CLAUDE_DESKTOP_SESSION_DIR_NAMES.some(name => normalized.includes(`/${name}/`))
			&& normalized.endsWith('.jsonl');
	}

	/**
	 * Get all Cowork session JSONL file paths across every candidate session directory.
	 * Walks the nested directory structure: <base>/<app>/<machine>/<session>/.claude/projects/<hash>/<uuid>.jsonl
	 */
	async getDesktopSessionFiles(): Promise<string[]> {
		const results: string[] = [];
		for (const baseDir of this.getDesktopSessionDirs()) {
			try {
				await fs.promises.access(baseDir);
			} catch {
				continue;
			}
			try {
				await this.walkForJsonlFiles(baseDir, results, 0, 8);
			} catch {
				// Ignore top-level errors
			}
		}
		return results;
	}

	private async walkForJsonlFiles(dir: string, results: string[], depth: number, maxDepth: number): Promise<void> {
		if (depth > maxDepth) { return; }
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			await this.processWalkEntry(entry, dir, results, depth, maxDepth);
		}
	}

	private async processWalkEntry(entry: fs.Dirent, dir: string, results: string[], depth: number, maxDepth: number): Promise<void> {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'agent') { return; }
			await this.walkForJsonlFiles(fullPath, results, depth + 1, maxDepth);
		} else if (entry.name.endsWith('.jsonl') && entry.name !== 'audit.jsonl') {
			try {
				const st = await fs.promises.stat(fullPath);
				if (st.size > 0) { results.push(fullPath); }
			} catch {
				// Ignore inaccessible files
			}
		}
	}

	/**
	 * Report how much of what Claude Desktop still lists is actually readable on this disk.
	 *
	 * Claude Desktop keeps one small `local_<id>.json` metadata record per Cowork session, but the
	 * transcript itself lives elsewhere — modern sessions write to the shared `~/.claude/projects`
	 * tree (linked by `cliSessionId`), older ones to a `local_<id>/` directory beside the metadata.
	 * Metadata outlives the transcript: Claude Code prunes `~/.claude/projects` on its own retention
	 * schedule (`cleanupPeriodDays`, default 30), and sessions that ran in the cloud never wrote a
	 * transcript to this machine at all. Either way Desktop's own sidebar keeps listing them, so its
	 * session count legitimately exceeds what this extension can measure.
	 *
	 * Counting the leftover metadata is what lets the UI explain that gap with a real number instead
	 * of leaving the user to assume sessions were lost. Reads only the small metadata files.
	 */
	async getDesktopLocalCoverage(claudeProjectsDir: string): Promise<{ knownSessions: number; withTranscript: number; missingTranscript: number }> {
		let knownSessions = 0;
		let withTranscript = 0;

		// Transcript filenames are `<cliSessionId>.jsonl` bucketed under an opaque per-workspace slug,
		// so the slug list is read once and each session id probed against it.
		let projectSlugs: string[] = [];
		try {
			projectSlugs = (await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true }))
				.filter(e => e.isDirectory())
				.map(e => e.name);
		} catch {
			// No ~/.claude/projects at all — every record then counts as missing, which is accurate.
		}

		for (const machineDir of await this.getDesktopMetadataDirs()) {
			let entries: string[];
			try {
				entries = await fs.promises.readdir(machineDir);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.startsWith('local_') || !entry.endsWith('.json')) { continue; }
				knownSessions++;
				if (await this.hasLocalTranscript(machineDir, entry, claudeProjectsDir, projectSlugs)) { withTranscript++; }
			}
		}

		return { knownSessions, withTranscript, missingTranscript: knownSessions - withTranscript };
	}

	/** Resolve the `<base>/<app-uuid>/<machine-uuid>` directories that hold `local_<id>.json` records. */
	private async getDesktopMetadataDirs(): Promise<string[]> {
		const dirs: string[] = [];
		for (const baseDir of this.getDesktopSessionDirs()) {
			for (const appDir of await this.readSubdirectories(baseDir)) {
				dirs.push(...await this.readSubdirectories(appDir));
			}
		}
		return dirs;
	}

	private async readSubdirectories(dir: string): Promise<string[]> {
		try {
			return (await fs.promises.readdir(dir, { withFileTypes: true }))
				.filter(e => e.isDirectory())
				.map(e => path.join(dir, e.name));
		} catch {
			return [];
		}
	}

	/** Whether a `local_<id>.json` record's transcript is present in either supported location. */
	private async hasLocalTranscript(machineDir: string, metadataFile: string, claudeProjectsDir: string, projectSlugs: string[]): Promise<boolean> {
		let cliSessionId: string | undefined;
		try {
			const raw = await fs.promises.readFile(path.join(machineDir, metadataFile), 'utf8');
			const parsed = JSON.parse(raw);
			cliSessionId = typeof parsed?.cliSessionId === 'string' ? parsed.cliSessionId : undefined;
		} catch {
			// Unreadable/corrupt metadata: fall through to the legacy directory probe below.
		}

		// Modern layout: transcript in the shared ~/.claude/projects tree, keyed by cliSessionId.
		// Reject path separators so a hostile id can't escape the projects directory.
		if (cliSessionId && !/[\\/]/.test(cliSessionId)) {
			for (const slug of projectSlugs) {
				try {
					await fs.promises.access(path.join(claudeProjectsDir, slug, `${cliSessionId}.jsonl`));
					return true;
				} catch { /* try the next slug */ }
			}
		}

		// Legacy layout: a local_<id>/ directory beside the metadata holding the transcript.
		const nested = path.join(machineDir, metadataFile.replace(/\.json$/, ''));
		const found: string[] = [];
		try {
			await this.walkForJsonlFiles(nested, found, 0, 8);
		} catch { /* missing or unreadable — treated as absent */ }
		return found.length > 0;
	}

	/**
	 * Parse all JSONL events from a Cowork session file.
	 * Public so extension.ts can use it for log viewer turn building.
	 */
	async readDesktopSessionEvents(sessionFilePath: string): Promise<any[]> {
		try {
			const content = await fs.promises.readFile(sessionFilePath, 'utf8');
			const lines = content.trim().split('\n');
			const events: any[] = [];
			for (const line of lines) {
				if (!line.trim()) { continue; }
				try {
					events.push(JSON.parse(line));
				} catch {
					// Skip malformed lines
				}
			}
			return events;
		} catch {
			return [];
		}
	}

	/**
	 * Get token counts from a Cowork session.
	 * Uses actual Anthropic API counts; de-duplicates by requestId using only final events.
	 */
	async getTokensFromDesktopSession(sessionFilePath: string): Promise<{ tokens: number; thinkingTokens: number }> {
		const events = await this.readDesktopSessionEvents(sessionFilePath);
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		const seenRequestIds = new Set<string>();
		for (const event of events) {
			const counts = this.extractDesktopEventTokens(event, seenRequestIds);
			if (!counts) { continue; }
			totalInputTokens += counts.inputTokens;
			totalOutputTokens += counts.outputTokens;
		}
		return { tokens: totalInputTokens + totalOutputTokens, thinkingTokens: 0 };
	}

	private computeDesktopTokenCounts(usage: any): { inputTokens: number; outputTokens: number; cacheCreation: number; cachedRead: number; cacheCreation1h: number } {
		const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
		// Split out the 1-hour TTL portion of cache-creation tokens (billed at a higher
		// rate than the default 5-minute TTL) — see calculateEstimatedCost() in tokenEstimation.ts.
		const cacheCreation1h = typeof usage.cache_creation?.ephemeral_1h_input_tokens === 'number'
			? usage.cache_creation.ephemeral_1h_input_tokens
			: 0;
		const cachedRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
		const inputTokens = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) + cacheCreation + cachedRead;
		const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
		return { inputTokens, outputTokens, cacheCreation, cachedRead, cacheCreation1h };
	}

	private extractDesktopEventTokens(event: any, seenRequestIds: Set<string>): { inputTokens: number; outputTokens: number } | null {
		if (event.type !== 'assistant') { return null; }
		const usage = event.message?.usage;
		if (!usage) { return null; }
		const requestId = event.requestId;
		if (requestId) {
			if (!event.message?.stop_reason) { return null; }
			if (seenRequestIds.has(requestId)) { return null; }
			seenRequestIds.add(requestId);
		}
		const { inputTokens, outputTokens } = this.computeDesktopTokenCounts(usage);
		return { inputTokens, outputTokens };
	}

	/**
	 * Count user interactions in a Cowork session.
	 */
	async countDesktopSessionInteractions(sessionFilePath: string): Promise<number> {
		const events = await this.readDesktopSessionEvents(sessionFilePath);
		let count = 0;
		for (const event of events) {
			if (event.type === 'user' && !event.isSidechain && event.message?.role === 'user') {
				// Real human turns only — see claudeUserTurns.ts for why synthetic wrapper-only
				// messages are excluded.
				if (isHumanUserTurn(event)) { count++; }
			}
		}
		return count;
	}

	/**
	 * Get per-model token usage from a Cowork session.
	 */
	async getDesktopSessionModelUsage(sessionFilePath: string): Promise<ModelUsage> {
		const events = await this.readDesktopSessionEvents(sessionFilePath);
		const modelUsage: ModelUsage = {};
		const seenRequestIds = new Set<string>();
		for (const event of events) {
			this.processDesktopEventModelUsage(event, seenRequestIds, modelUsage);
		}
		return modelUsage;
	}

	private processDesktopEventModelUsage(event: any, seenRequestIds: Set<string>, modelUsage: ModelUsage): void {
		if (event.type !== 'assistant') { return; }
		const usage = event.message?.usage;
		if (!usage) { return; }
		if (!this.shouldCountDesktopRequest(event, seenRequestIds)) { return; }
		const model = normalizeClaudeModelId(event.message?.model || 'unknown');
		// Untrusted `model` string from parsed session JSON — see protoGuard.ts.
		if (isUnsafeObjectKey(model)) { return; }
		if (!modelUsage[model]) { modelUsage[model] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
		this.applyDesktopTokenCounts(modelUsage[model], usage);
	}

	private shouldCountDesktopRequest(event: any, seenRequestIds: Set<string>): boolean {
		const requestId = event.requestId;
		if (!requestId) { return true; }
		if (!event.message?.stop_reason) { return false; }
		if (seenRequestIds.has(requestId)) { return false; }
		seenRequestIds.add(requestId);
		return true;
	}

	private applyDesktopTokenCounts(entry: ModelUsage[ModelId], usage: any): void {
		const { inputTokens, outputTokens, cacheCreation, cachedRead, cacheCreation1h } = this.computeDesktopTokenCounts(usage);
		entry.inputTokens += inputTokens;
		entry.outputTokens += outputTokens;
		if (cacheCreation > 0) { entry.cacheCreationTokens = (entry.cacheCreationTokens ?? 0) + cacheCreation; }
		if (cacheCreation1h > 0) { entry.cacheCreation1hTokens = (entry.cacheCreation1hTokens ?? 0) + cacheCreation1h; }
		if (cachedRead > 0) { entry.cachedReadTokens = (entry.cachedReadTokens ?? 0) + cachedRead; }
	}

	/**
	 * Derive the metadata JSON file path from a Cowork session JSONL path.
	 *
	 * Structure: .../<session-base>/<app>/<machine>/local_<id>/.claude/.../<uuid>.jsonl
	 * Metadata:  .../<session-base>/<app>/<machine>/local_<id>.json
	 * where <session-base> is claude-code-sessions (current) or local-agent-mode-sessions (legacy).
	 */
	private getMetadataPathFromJsonl(jsonlPath: string): string | null {
		const normalized = normalizePath(jsonlPath);
		const parts = normalized.split('/');
		// Find the index of '.claude' — session directory is just before it
		const dotClaudeIdx = parts.lastIndexOf('.claude');
		if (dotClaudeIdx < 1) { return null; }
		// The session dir component starts with 'local_'
		const sessionDirName = parts[dotClaudeIdx - 1];
		if (!sessionDirName.startsWith('local_')) { return null; }
		// Metadata file is a sibling of the session dir
		const parentDir = parts.slice(0, dotClaudeIdx - 1).join('/');
		return `${parentDir}/${sessionDirName}.json`;
	}

	/**
	 * Read session metadata (title, timestamps, cwd) for a Cowork session.
	 * The metadata comes from the sibling .json file alongside the session directory.
	 */
	async getDesktopSessionMeta(sessionFilePath: string): Promise<{
		title?: string;
		firstInteraction?: string;
		lastInteraction?: string;
		cwd?: string;
	} | null> {
		const metaPath = this.getMetadataPathFromJsonl(sessionFilePath);
		if (!metaPath) { return null; }

		try {
			const raw = await fs.promises.readFile(metaPath, 'utf8');
			const meta = JSON.parse(raw);

			const firstInteraction = meta.createdAt
				? new Date(meta.createdAt).toISOString()
				: undefined;
			const lastInteraction = meta.lastActivityAt
				? new Date(meta.lastActivityAt).toISOString()
				: undefined;

			// cwd: prefer userSelectedFolders[0] over the internal session cwd
			const cwd = (Array.isArray(meta.userSelectedFolders) && meta.userSelectedFolders.length > 0)
				? meta.userSelectedFolders[0]
				: meta.cwd;

			return {
				title: meta.title || undefined,
				firstInteraction,
				lastInteraction,
				cwd: typeof cwd === 'string' ? cwd : undefined,
			};
		} catch {
			return null;
		}
	}
}
