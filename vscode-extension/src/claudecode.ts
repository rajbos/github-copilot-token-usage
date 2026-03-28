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
	 */
	isClaudeCodeSessionFile(filePath: string): boolean {
		const normalized = filePath.toLowerCase().replace(/\\/g, '/');
		return normalized.includes('/.claude/projects/') && normalized.endsWith('.jsonl');
	}

	/**
	 * Get all Claude Code session file paths (top-level session files, excluding subagent files).
	 */
	getClaudeCodeSessionFiles(): string[] {
		const projectsDir = this.getClaudeCodeProjectsDir();
		if (!fs.existsSync(projectsDir)) { return []; }
		const results: string[] = [];
		try {
			const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
			for (const projectDir of projectDirs) {
				if (!projectDir.isDirectory()) { continue; }
				const projectPath = path.join(projectsDir, projectDir.name);
				try {
					const entries = fs.readdirSync(projectPath, { withFileTypes: true });
					for (const entry of entries) {
						if (!entry.isDirectory() && entry.name.endsWith('.jsonl')) {
							const fullPath = path.join(projectPath, entry.name);
							try {
								const stats = fs.statSync(fullPath);
								if (stats.size > 0) {
									results.push(fullPath);
								}
							} catch {
								// Ignore individual file access errors
							}
						}
					}
				} catch {
					// Ignore project directory read errors
				}
			}
		} catch {
			// Ignore top-level read errors
		}
		return results;
	}

	/**
	 * Parse a Claude Code session JSONL file and return all events.
	 */
	private readSessionEvents(sessionFilePath: string): any[] {
		try {
			const content = fs.readFileSync(sessionFilePath, 'utf8');
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
	 * Get token counts from a Claude Code session.
	 * Uses ACTUAL Anthropic API token counts from assistant event message.usage.
	 * De-duplicates by requestId, using only events with stop_reason != null.
	 */
	getTokensFromClaudeCodeSession(sessionFilePath: string): { tokens: number; thinkingTokens: number } {
		const events = this.readSessionEvents(sessionFilePath);
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		// We track requestIds to de-duplicate streaming fragments
		const seenRequestIds = new Set<string>();

		for (const event of events) {
			if (event.type !== 'assistant') { continue; }
			const usage = event.message?.usage;
			if (!usage) { continue; }

			// De-duplicate: only count the final event per requestId
			const requestId = event.requestId;
			if (requestId) {
				if (event.message?.stop_reason === null || event.message?.stop_reason === undefined) {
					// Streaming fragment — skip if we haven't seen this ID yet (will get final)
					continue;
				}
				if (seenRequestIds.has(requestId)) { continue; }
				seenRequestIds.add(requestId);
			}

			// Actual API token counts
			const inputTokens = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
				+ (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0)
				+ (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0);
			const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

			totalInputTokens += inputTokens;
			totalOutputTokens += outputTokens;
		}

		// Claude Code does not separate thinking tokens — they are included in output_tokens
		return { tokens: totalInputTokens + totalOutputTokens, thinkingTokens: 0 };
	}

	/**
	 * Count user interactions in a Claude Code session.
	 * Counts user events that are not sidechain (main conversation only).
	 */
	countClaudeCodeInteractions(sessionFilePath: string): number {
		const events = this.readSessionEvents(sessionFilePath);
		let count = 0;
		for (const event of events) {
			if (event.type === 'user' && !event.isSidechain && event.message?.role === 'user') {
				// Only count actual user text messages (not tool results)
				const content = event.message?.content;
				if (typeof content === 'string') {
					count++;
				} else if (Array.isArray(content)) {
					// Count if any content block is a text block (not tool_result)
					const hasText = content.some((c: any) => c.type === 'text');
					if (hasText && !content.some((c: any) => c.type === 'tool_result')) {
						count++;
					}
				}
			}
		}
		return count;
	}

	/**
	 * Get per-model token usage from a Claude Code session.
	 * Uses the model field from assistant event message objects.
	 */
	getClaudeCodeModelUsage(sessionFilePath: string): ModelUsage {
		const events = this.readSessionEvents(sessionFilePath);
		const modelUsage: ModelUsage = {};
		const seenRequestIds = new Set<string>();

		for (const event of events) {
			if (event.type !== 'assistant') { continue; }
			const usage = event.message?.usage;
			if (!usage) { continue; }

			// De-duplicate by requestId
			const requestId = event.requestId;
			if (requestId) {
				if (event.message?.stop_reason === null || event.message?.stop_reason === undefined) {
					continue;
				}
				if (seenRequestIds.has(requestId)) { continue; }
				seenRequestIds.add(requestId);
			}

			const model = normalizeClaudeModelId(event.message?.model || 'unknown');

			if (!modelUsage[model]) {
				modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
			}

			const inputTokens = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
				+ (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0)
				+ (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0);
			const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

			modelUsage[model].inputTokens += inputTokens;
			modelUsage[model].outputTokens += outputTokens;
		}

		return modelUsage;
	}

	/**
	 * Read session metadata (title, timestamps, entrypoint) from a Claude Code session.
	 */
	getClaudeCodeSessionMeta(sessionFilePath: string): {
		title?: string;
		entrypoint?: string;
		firstInteraction?: string;
		lastInteraction?: string;
		cwd?: string;
	} | null {
		const events = this.readSessionEvents(sessionFilePath);
		if (events.length === 0) { return null; }

		let title: string | undefined;
		let entrypoint: string | undefined;
		let cwd: string | undefined;
		const timestamps: number[] = [];

		for (const event of events) {
			// Extract AI-generated title
			if (event.type === 'ai-title' && event.aiTitle) {
				title = event.aiTitle;
			}

			// Extract entrypoint and cwd from any event
			if (!entrypoint && event.entrypoint) {
				entrypoint = event.entrypoint;
			}
			if (!cwd && event.cwd) {
				cwd = event.cwd;
			}

			// Collect timestamps
			if (event.timestamp) {
				const ts = new Date(event.timestamp).getTime();
				if (!isNaN(ts)) {
					timestamps.push(ts);
				}
			}
		}

		let firstInteraction: string | undefined;
		let lastInteraction: string | undefined;
		if (timestamps.length > 0) {
			timestamps.sort((a, b) => a - b);
			firstInteraction = new Date(timestamps[0]).toISOString();
			lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
		}

		return { title, entrypoint, firstInteraction, lastInteraction, cwd };
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
