/**
 * Claude Desktop Cowork data access layer.
 * Handles reading session data from Claude Desktop's Cowork feature.
 *
 * Cowork sessions are stored at:
 *   Windows: %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\local-agent-mode-sessions\
 *
 * Directory structure:
 *   <base>/<app-uuid>/<machine-uuid>/local_<session-id>.json       — session metadata (title, timestamps, model)
 *   <base>/<app-uuid>/<machine-uuid>/local_<session-id>/.claude/projects/<hash>/<uuid>.jsonl — JSONL token data
 *
 * The JSONL format is identical to Claude Code sessions.
 * Token data is ACTUAL Anthropic API counts — no estimation needed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { normalizeClaudeModelId } from './claudecode';
import type { ModelUsage } from './types';

/** Package name for the Claude Desktop Windows Store app. */
const CLAUDE_DESKTOP_PACKAGE = 'Claude_pzs8sxrjxfjjc';

export class ClaudeDesktopCoworkDataAccess {

	/**
	 * Get the Claude Desktop Cowork sessions base directory.
	 * Returns an empty string on non-Windows platforms.
	 */
	getCoworkBaseDir(): string {
		if (os.platform() !== 'win32') { return ''; }
		const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		return path.join(
			localAppData,
			'Packages',
			CLAUDE_DESKTOP_PACKAGE,
			'LocalCache',
			'Roaming',
			'Claude',
			'local-agent-mode-sessions'
		);
	}

	/**
	 * Check if a file path is a Claude Desktop Cowork session file.
	 * Cowork session files live inside local-agent-mode-sessions/ and end with .jsonl.
	 */
	isCoworkSessionFile(filePath: string): boolean {
		const normalized = filePath.toLowerCase().replace(/\\/g, '/');
		return normalized.includes('/local-agent-mode-sessions/') && normalized.endsWith('.jsonl');
	}

	/**
	 * Get all Cowork session JSONL file paths.
	 * Walks the nested directory structure: <base>/<app>/<machine>/<session>/.claude/projects/<hash>/<uuid>.jsonl
	 */
	getCoworkSessionFiles(): string[] {
		const baseDir = this.getCoworkBaseDir();
		if (!baseDir || !fs.existsSync(baseDir)) { return []; }
		const results: string[] = [];
		try {
			this.walkForJsonlFiles(baseDir, results, 0, 8);
		} catch {
			// Ignore top-level errors
		}
		return results;
	}

	private walkForJsonlFiles(dir: string, results: string[], depth: number, maxDepth: number): void {
		if (depth > maxDepth) { return; }
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				this.walkForJsonlFiles(fullPath, results, depth + 1, maxDepth);
			} else if (entry.name.endsWith('.jsonl')) {
				try {
					const stats = fs.statSync(fullPath);
					if (stats.size > 0) {
						results.push(fullPath);
					}
				} catch {
					// Ignore inaccessible files
				}
			}
		}
	}

	/**
	 * Parse all JSONL events from a Cowork session file.
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
	 * Get token counts from a Cowork session.
	 * Uses actual Anthropic API counts; de-duplicates by requestId using only final events.
	 */
	getTokensFromCoworkSession(sessionFilePath: string): { tokens: number; thinkingTokens: number } {
		const events = this.readSessionEvents(sessionFilePath);
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		const seenRequestIds = new Set<string>();

		for (const event of events) {
			if (event.type !== 'assistant') { continue; }
			const usage = event.message?.usage;
			if (!usage) { continue; }

			const requestId = event.requestId;
			if (requestId) {
				if (event.message?.stop_reason === null || event.message?.stop_reason === undefined) {
					continue; // Streaming fragment — skip
				}
				if (seenRequestIds.has(requestId)) { continue; }
				seenRequestIds.add(requestId);
			}

			const inputTokens = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
				+ (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0)
				+ (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0);
			const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

			totalInputTokens += inputTokens;
			totalOutputTokens += outputTokens;
		}

		return { tokens: totalInputTokens + totalOutputTokens, thinkingTokens: 0 };
	}

	/**
	 * Count user interactions in a Cowork session.
	 */
	countCoworkInteractions(sessionFilePath: string): number {
		const events = this.readSessionEvents(sessionFilePath);
		let count = 0;
		for (const event of events) {
			if (event.type === 'user' && !event.isSidechain && event.message?.role === 'user') {
				const content = event.message?.content;
				if (typeof content === 'string') {
					count++;
				} else if (Array.isArray(content)) {
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
	 * Get per-model token usage from a Cowork session.
	 */
	getCoworkModelUsage(sessionFilePath: string): ModelUsage {
		const events = this.readSessionEvents(sessionFilePath);
		const modelUsage: ModelUsage = {};
		const seenRequestIds = new Set<string>();

		for (const event of events) {
			if (event.type !== 'assistant') { continue; }
			const usage = event.message?.usage;
			if (!usage) { continue; }

			const requestId = event.requestId;
			if (requestId) {
				if (event.message?.stop_reason === null || event.message?.stop_reason === undefined) { continue; }
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
	 * Derive the metadata JSON file path from a Cowork session JSONL path.
	 *
	 * Structure: .../local-agent-mode-sessions/<app>/<machine>/local_<id>/.claude/.../<uuid>.jsonl
	 * Metadata:  .../local-agent-mode-sessions/<app>/<machine>/local_<id>.json
	 */
	private getMetadataPathFromJsonl(jsonlPath: string): string | null {
		const normalized = jsonlPath.replace(/\\/g, '/');
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
	getCoworkSessionMeta(sessionFilePath: string): {
		title?: string;
		firstInteraction?: string;
		lastInteraction?: string;
		cwd?: string;
	} | null {
		const metaPath = this.getMetadataPathFromJsonl(sessionFilePath);
		if (!metaPath) { return null; }

		try {
			const raw = fs.readFileSync(metaPath, 'utf8');
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
