/**
 * Claude Code data access layer.
 * Handles reading session data from Claude Code (Anthropic CLI/IDE extension) JSONL session files.
 * Sessions are stored at: ~/.claude/projects/{project-hash}/{session-uuid}.jsonl
 * Token data is ACTUAL Anthropic API counts — no estimation needed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage } from './types';
import { withErrorRecovery } from './utils/errors';
import { normalizePathForComparison } from './workspaceHelpers';
import { toLocalDayKey } from './utils/dayKeys';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { isHumanUserTurn } from './utils/claudeUserTurns';
import { readTextFileWithSizeGuard } from './utils/safeFileRead';

/**
 * Normalize a Claude Code API model ID to the dot-notation format used throughout this codebase.
 *
 * Claude Code returns the full Anthropic API model ID, which uses hyphens as separators
 * everywhere — including for version numbers that other sources express with a decimal dot.
 *
 * Examples:
 *   claude-sonnet-4-6           → claude-sonnet-4.6
 *   claude-haiku-4-5-20250929   → claude-haiku-4.5
 *   claude-opus-4-6             → claude-opus-4.6
 *   claude-sonnet-4.6           → claude-sonnet-4.6  (already normalised — no-op)
 *
 * The pattern matched is: claude-{family}-{major}-{minor}[-{YYYYMMDD}]
 * where {major} and {minor} are single digits.  This avoids mismatching
 * legacy IDs like `claude-3-5-sonnet-20241022` whose version is embedded
 * differently.
 */
export function normalizeClaudeModelId(model: string): string {
	if (!model) { return model; }
	// Already in dot notation — nothing to do
	if (/claude-.+-\d+\.\d+/.test(model)) { return model; }
	// Match: claude-{family}-{digit}-{digit}[-{8-digit date}]
	const m = model.match(/^(claude-.+)-(\d)-(\d)(-\d{8})?$/);
	if (m) {
		return `${m[1]}-${m[2]}.${m[3]}`;
	}
	return model;
}

export class ClaudeCodeDataAccess {

	/**
	 * Get the Claude Code data directory path (~/.claude).
	 */
	getClaudeCodeDataDir(): string {
		return path.join(os.homedir(), '.claude');
	}

	/**
	 * Get the Claude Code projects directory path (~/.claude/projects).
	 */
	getClaudeCodeProjectsDir(): string {
		return path.join(this.getClaudeCodeDataDir(), 'projects');
	}

	/**
	 * Check if a file path is a Claude Code session file.
	 * Requires the path to be under the user's ~/.claude/projects/ directory to avoid
	 * false-positives on Cowork sessions that have a nested .claude/projects/ sub-path.
	 */
	isClaudeCodeSessionFile(filePath: string): boolean {
		const normalized = normalizePathForComparison(filePath);
		const projectsDir = normalizePathForComparison(this.getClaudeCodeProjectsDir());
		return normalized.startsWith(projectsDir) && normalized.endsWith('.jsonl');
	}

	/**
	 * Get all Claude Code session file paths, including subagent/workflow transcripts
	 * written under <project>/<sessionId>/subagents/**\/*.jsonl (issue #1608).
	 */
	async getClaudeCodeSessionFiles(): Promise<string[]> {
		const projectsDir = this.getClaudeCodeProjectsDir();
		try {
			await fs.promises.access(projectsDir);
		} catch {
			return [];
		}
		try {
			const projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
			const results = await Promise.all(
				projectDirs
					.filter(d => d.isDirectory())
					.map(d => this.collectJsonlFilesFromProject(path.join(projectsDir, d.name)))
			);
			return results.flat();
		} catch (err) {
			console.error('[claudecode] Failed to read projects dir:', err);
			return [];
		}
	}

	/**
	 * Recursively collect .jsonl files under a project directory, up to maxDepth levels
	 * deep, so subagent/workflow transcripts nested under <sessionId>/subagents/** are
	 * discovered alongside the top-level session files.
	 */
	private async collectJsonlFilesFromProject(projectPath: string, depth = 0, maxDepth = 6): Promise<string[]> {
		if (depth > maxDepth) { return []; }
		try {
			const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
			const results = await Promise.all(
				entries.map(async e => {
					const fullPath = path.join(projectPath, e.name);
					if (e.isDirectory()) {
						return this.collectJsonlFilesFromProject(fullPath, depth + 1, maxDepth);
					}
					if (!e.name.endsWith('.jsonl')) { return []; }
					try {
						const st = await fs.promises.stat(fullPath);
						return st.size > 0 ? [fullPath] : [];
					} catch (err) {
						console.error(`[claudecode] Failed to stat ${fullPath}:`, err);
						return [] as string[];
					}
				})
			);
			return results.flat();
		} catch (err) {
			console.error(`[claudecode] Failed to read project dir ${projectPath}:`, err);
			return [];
		}
	}

	/**
	 * Parse a Claude Code session JSONL file and return all events.
	 */
	private async readSessionEvents(sessionFilePath: string): Promise<any[]> {
		return withErrorRecovery(
			async () => {
				const content = await readTextFileWithSizeGuard(sessionFilePath, 'claudecode');
				if (content === undefined) { return []; }
				const lines = content.trim().split('\n');
				const events: any[] = [];
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						events.push(JSON.parse(line));
					} catch { /* skip malformed lines */ }
				}
				return events;
			},
			[],
			`claudecode readSessionEvents(${sessionFilePath})`
		);
	}

	/**
	 * Deduplicate assistant events using Anthropic's message.id (last-wins).
	 *
	 * Claude Code writes multiple JSONL entries per API request:
	 *   - Streaming fragments (stop_reason=null) during streaming
	 *   - The final complete event (non-null stop_reason, complete token counts)
	 *   - Sometimes the same complete event is written multiple times identically
	 *
	 * Using message.id last-wins handles all cases correctly:
	 *   - Normal request:  last event has complete output_tokens and non-null stop_reason ✓
	 *   - Crashed request: last known event has partial tokens — better than zero ✓
	 *   - Duplicate write: identical content, last-wins is a no-op ✓
	 *   - No requestId:    message.id (100% present) catches what requestId (87%) misses ✓
	 */
	private deduplicateAssistantEvents(events: any[]): any[] {
		const byMessageId = new Map<string, any>();
		const noMessageId: any[] = [];
		for (const event of events) {
			if (event.type !== 'assistant' || !event.message?.usage) { continue; }
			const msgId: string | undefined = event.message?.id;
			if (msgId) {
				byMessageId.set(msgId, event); // last-wins
			} else {
				noMessageId.push(event);
			}
		}
		return [...byMessageId.values(), ...noMessageId];
	}

	/**
	 * Resolve the project directory and session ID that `filePath` belongs to, whether it's
	 * the top-level session file itself or a subagent transcript nested under
	 * <sessionId>/subagents/**. Used to locate sibling files in the same session "family"
	 * for cross-file dedup (see getPriorFamilyMessageIds).
	 */
	private resolveSessionFamilyRoot(filePath: string): { projectDir: string; sessionId: string } {
		const parts = filePath.split(path.sep);
		const subagentsIndex = parts.lastIndexOf('subagents');
		if (subagentsIndex > 0) {
			return { sessionId: parts[subagentsIndex - 1], projectDir: parts.slice(0, subagentsIndex - 1).join(path.sep) };
		}
		return { sessionId: path.basename(filePath, '.jsonl'), projectDir: path.dirname(filePath) };
	}

	/**
	 * Get every .jsonl file in the same session "family" as `filePath` — the top-level
	 * session file plus any subagent transcripts under <sessionId>/subagents/** — in a
	 * stable canonical order (top-level file first, then subagent files sorted by path).
	 */
	private async getSessionFamilyFiles(filePath: string): Promise<string[]> {
		const { projectDir, sessionId } = this.resolveSessionFamilyRoot(filePath);
		const topLevelFile = path.join(projectDir, `${sessionId}.jsonl`);
		const subagentsDir = path.join(projectDir, sessionId, 'subagents');
		let subagentFiles: string[] = [];
		try {
			await fs.promises.access(subagentsDir);
			subagentFiles = (await this.collectJsonlFilesFromProject(subagentsDir)).sort();
		} catch { /* no subagents directory — common case, nothing to add */ }
		return [topLevelFile, ...subagentFiles];
	}

	/**
	 * Anthropic's message.id is meant to be unique per API response, but Claude Code's
	 * sidechain (subagent) logging can replay a parent message under a new requestId
	 * inside a subagent transcript. Since subagent files are discovered and token-counted
	 * independently (issue #1608), that replay would otherwise be summed twice — once from
	 * the file that first logged it, once from the file that replayed it.
	 *
	 * This returns the message.ids already "claimed" by family files that sort before
	 * `filePath` in canonical order (top-level file, then subagent files by path), so the
	 * caller can exclude them and each unique message is counted exactly once across the
	 * whole family (issue #1570). Only subagent files can have anything to exclude — the
	 * top-level file always sorts first — so this is a no-op fs-free fast path for the
	 * common (non-subagent) case.
	 */
	private async getPriorFamilyMessageIds(filePath: string): Promise<Set<string>> {
		const parts = filePath.split(path.sep);
		if (parts.lastIndexOf('subagents') <= 0) { return new Set(); }

		const family = await this.getSessionFamilyFiles(filePath);
		const target = path.normalize(filePath);
		const claimed = new Set<string>();
		for (const familyFile of family) {
			if (path.normalize(familyFile) === target) { break; }
			const events = await this.readSessionEvents(familyFile);
			for (const event of this.deduplicateAssistantEvents(events)) {
				const msgId: string | undefined = event.message?.id;
				if (msgId) { claimed.add(msgId); }
			}
		}
		return claimed;
	}

	/**
	 * Sum input + output tokens (including cache creation/read) from a single assistant
	 * event's usage object. Shared by getTokensFromClaudeCodeSession and
	 * getClaudeCodeDailyFractions so both use the identical token formula.
	 */
	private getEventTotalTokens(usage: any): number {
		const inputTokens = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
			+ (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0)
			+ (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0);
		const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
		return inputTokens + outputTokens;
	}

	/**
	 * Get token counts from a Claude Code session.
	 * Uses ACTUAL Anthropic API token counts from assistant event message.usage.
	 * De-duplicates by message.id (last-wins) — see deduplicateAssistantEvents — and, for
	 * subagent transcripts, excludes messages already claimed by an earlier file in the
	 * same session family (see getPriorFamilyMessageIds) so a replayed parent message
	 * isn't summed twice across files (issue #1570).
	 */
	async getTokensFromClaudeCodeSession(sessionFilePath: string): Promise<{ tokens: number; thinkingTokens: number }> {
		const events = await this.readSessionEvents(sessionFilePath);
		const priorIds = await this.getPriorFamilyMessageIds(sessionFilePath);
		let totalTokens = 0;

		for (const event of this.deduplicateAssistantEvents(events)) {
			const msgId: string | undefined = event.message?.id;
			if (msgId && priorIds.has(msgId)) { continue; }
			totalTokens += this.getEventTotalTokens(event.message.usage);
		}

		// Claude Code does not separate thinking tokens — they are included in output_tokens
		return { tokens: totalTokens, thinkingTokens: 0 };
	}

	/**
	 * Bucket a single assistant event's tokens into its local calendar day, unless its
	 * message.id was already claimed by an earlier family file (see getPriorFamilyMessageIds)
	 * or it has no usable tokens/timestamp. Returns the token count actually bucketed, so the
	 * caller can accumulate a running total without duplicating the skip conditions.
	 */
	private bucketEventIntoDay(event: any, priorIds: Set<string>, tokensPerDay: Map<string, number>): number {
		const msgId: string | undefined = event.message?.id;
		if (msgId && priorIds.has(msgId)) { return 0; }
		const tokens = this.getEventTotalTokens(event.message.usage);
		if (tokens <= 0) { return 0; }
		const ts = event.timestamp ? new Date(event.timestamp).getTime() : NaN;
		if (isNaN(ts)) { return 0; }
		const dayKey = toLocalDayKey(new Date(ts));
		tokensPerDay.set(dayKey, (tokensPerDay.get(dayKey) ?? 0) + tokens);
		return tokens;
	}

	/**
	 * Return the fraction of this session's tokens that occurred on each calendar day,
	 * bucketed by each assistant event's own timestamp rather than the session's
	 * firstInteraction. Claude Code logs exact per-event usage and an ISO timestamp per
	 * assistant event, so multi-day sessions are attributed to the days the tokens were
	 * actually spent on instead of collapsing everything onto the start day (issue #1608).
	 */
	async getClaudeCodeDailyFractions(sessionFilePath: string): Promise<Record<string, number>> {
		const events = await this.readSessionEvents(sessionFilePath);
		const priorIds = await this.getPriorFamilyMessageIds(sessionFilePath);
		const tokensPerDay = new Map<string, number>();
		let totalTokens = 0;

		for (const event of this.deduplicateAssistantEvents(events)) {
			totalTokens += this.bucketEventIntoDay(event, priorIds, tokensPerDay);
		}

		if (totalTokens === 0) {
			const meta = await this.getClaudeCodeSessionMeta(sessionFilePath);
			const fallbackMs = meta?.firstInteraction ? Date.parse(meta.firstInteraction) : NaN;
			const fallback = isNaN(fallbackMs) ? toLocalDayKey(new Date()) : toLocalDayKey(new Date(fallbackMs));
			return { [fallback]: 1.0 };
		}

		const fractions: Record<string, number> = {};
		for (const [dayKey, tokens] of tokensPerDay.entries()) {
			fractions[dayKey] = tokens / totalTokens;
		}
		return fractions;
	}

	/**
	 * Count user interactions in a Claude Code session.
	 * Counts user events that are not sidechain (main conversation only).
	 */
	async countClaudeCodeInteractions(sessionFilePath: string): Promise<number> {
		const events = await this.readSessionEvents(sessionFilePath);
		let count = 0;
		for (const event of events) {
			if (event.type === 'user' && !event.isSidechain && event.message?.role === 'user') {
				// Only count real human turns — not tool results, and not the harness's synthetic
				// <system-reminder>/<task-notification> injections (see claudeUserTurns.ts).
				if (isHumanUserTurn(event)) { count++; }
			}
		}
		return count;
	}

	/**
	 * Extract the cache-related token breakdown from an Anthropic usage object:
	 * total cache-creation tokens, the portion written under the 1-hour TTL, and
	 * cache-read tokens. Anthropic bills cache-creation at different rates depending
	 * on TTL, so the 1-hour portion is tracked separately from the total.
	 */
	private extractCacheTokenBreakdown(usage: any): { cacheCreation: number; cacheCreation1h: number; cachedRead: number } {
		const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
		const cacheCreation1h = typeof usage.cache_creation?.ephemeral_1h_input_tokens === 'number'
			? usage.cache_creation.ephemeral_1h_input_tokens
			: 0;
		const cachedRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
		return { cacheCreation, cacheCreation1h, cachedRead };
	}

	private addModelUsageEntry(
		modelUsage: ModelUsage,
		model: string,
		usage: any
	): void {
		// Untrusted `model` string from parsed session JSON — refuse keys that would
		// resolve through the prototype chain instead of an own property (see protoGuard.ts).
		if (isUnsafeObjectKey(model)) { return; }
		if (!modelUsage[model]) {
			modelUsage[model] = { inputTokens: 0, outputTokens: 0, sessions: 0 };
		}

		const { cacheCreation, cacheCreation1h, cachedRead } = this.extractCacheTokenBreakdown(usage);
		const inputTokens = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
			+ cacheCreation
			+ cachedRead;
		const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

		modelUsage[model].inputTokens += inputTokens;
		modelUsage[model].outputTokens += outputTokens;
		if (cacheCreation > 0) {
			modelUsage[model].cacheCreationTokens = (modelUsage[model].cacheCreationTokens ?? 0) + cacheCreation;
		}
		if (cacheCreation1h > 0) {
			modelUsage[model].cacheCreation1hTokens = (modelUsage[model].cacheCreation1hTokens ?? 0) + cacheCreation1h;
		}
		if (cachedRead > 0) {
			modelUsage[model].cachedReadTokens = (modelUsage[model].cachedReadTokens ?? 0) + cachedRead;
		}
	}

	/**
	 * Get per-model token usage from a Claude Code session.
	 * Uses the model field from assistant event message objects.
	 * De-duplicates by message.id (last-wins) — see deduplicateAssistantEvents.
	 */
	async getClaudeCodeModelUsage(sessionFilePath: string): Promise<ModelUsage> {
		const events = await this.readSessionEvents(sessionFilePath);
		const priorIds = await this.getPriorFamilyMessageIds(sessionFilePath);
		const modelUsage: ModelUsage = {};

		for (const event of this.deduplicateAssistantEvents(events)) {
			const msgId: string | undefined = event.message?.id;
			if (msgId && priorIds.has(msgId)) { continue; }
			const usage = event.message.usage;
			const model = normalizeClaudeModelId(event.message?.model || 'unknown');
			this.addModelUsageEntry(modelUsage, model, usage);
		}

		return modelUsage;
	}

	/**
	 * Read session metadata (title, timestamps, entrypoint) from a Claude Code session.
	 */
	async getClaudeCodeSessionMeta(sessionFilePath: string): Promise<{
		title?: string;
		entrypoint?: string;
		firstInteraction?: string;
		lastInteraction?: string;
		cwd?: string;
	} | null> {
		const events = await this.readSessionEvents(sessionFilePath);
		if (events.length === 0) { return null; }
		const { title, entrypoint, cwd, timestamps } = this.extractMetaFieldsFromEvents(events);
		let firstInteraction: string | undefined;
		let lastInteraction: string | undefined;
		if (timestamps.length > 0) {
			timestamps.sort((a, b) => a - b);
			firstInteraction = new Date(timestamps[0]).toISOString();
			lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
		}
		return { title, entrypoint, firstInteraction, lastInteraction, cwd };
	}

	private extractMetaFieldsFromEvents(events: any[]): { title?: string; entrypoint?: string; cwd?: string; timestamps: number[] } {
		let title: string | undefined;
		let customTitle: string | undefined;
		let entrypoint: string | undefined;
		let cwd: string | undefined;
		const timestamps: number[] = [];
		for (const event of events) {
			if (event.type === 'ai-title' && event.aiTitle) { title = event.aiTitle; }
			// A title the user set (or Claude Desktop set when naming a Cowork session) is written as
			// a separate `custom-title` event. Sessions started from Claude Desktop often carry ONLY
			// this one, so reading `ai-title` alone left them with no title at all.
			if (event.type === 'custom-title' && event.customTitle) { customTitle = event.customTitle; }
			if (!entrypoint && event.entrypoint) { entrypoint = event.entrypoint; }
			if (!cwd && event.cwd) { cwd = event.cwd; }
			if (event.timestamp) {
				const ts = new Date(event.timestamp).getTime();
				if (!isNaN(ts)) { timestamps.push(ts); }
			}
		}
		// An explicit custom title outranks the model-generated one.
		return { title: customTitle ?? title, entrypoint, cwd, timestamps };
	}

	/**
	 * Get the session ID (UUID) from a Claude Code session file path.
	 */
	getClaudeCodeSessionId(sessionFilePath: string): string {
		return path.basename(sessionFilePath, '.jsonl');
	}

	/**
	 * Reverse the project hash to recover the original working directory path.
	 * The hash is: lowercase path with drive colon removed, separators replaced with dashes.
	 */
	getProjectPathFromHash(projectHash: string): string {
		// Best-effort reverse engineering: replace dashes with path separators
		// The exact reversal is ambiguous (dashes in real paths), but works for display
		const platform = os.platform();
		if (platform === 'win32') {
			// Windows: first segment is drive letter, e.g., "c--Users-..." → "C:\Users\..."
			const parts = projectHash.split('-');
			if (parts.length >= 2 && parts[0].length === 1 && parts[1] === '') {
				// Drive letter pattern: "c--rest" → parts = ["c", "", "rest", ...]
				const drive = parts[0].toUpperCase();
				const rest = parts.slice(2).join('\\');
				return `${drive}:\\${rest}`;
			}
		}
		// Unix: replace leading segment dashes with /
		return '/' + projectHash.replace(/-/g, '/');
	}
}
