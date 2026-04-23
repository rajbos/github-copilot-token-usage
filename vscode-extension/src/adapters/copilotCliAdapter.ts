/**
 * CopilotCliAdapter — discovers GitHub Copilot CLI agent-mode session files
 * stored under `~/.copilot/session-state/`. Two layouts are supported:
 *   1. Flat .json / .jsonl files at the top level (legacy).
 *   2. UUID subdirectories containing an `events.jsonl` file (newer format).
 *
 * Like CopilotChatAdapter, this adapter currently participates only in
 * discovery via IDiscoverableEcosystem. `handles()` returns `false` so the
 * existing fallback parsing in extension.ts continues to own CLI session
 * parsing semantics unchanged. The other IEcosystemAdapter methods are
 * implemented as safe defaults so a future PR can flip `handles()` to a
 * real path predicate without re-plumbing call sites.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage } from '../types';
import type {
	IEcosystemAdapter,
	IDiscoverableEcosystem,
	DiscoveryResult,
	CandidatePath,
} from '../ecosystemAdapter';

/** Returns the canonical Copilot CLI session-state directory (~/.copilot/session-state). */
export function getCopilotCliSessionStateDir(): string {
	return path.join(os.homedir(), '.copilot', 'session-state');
}

/** Path predicate matching any file under ~/.copilot/session-state/ (any depth). */
export function isCopilotCliSessionPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, '/');
	return norm.includes('/.copilot/session-state/');
}

async function pathExists(p: string): Promise<boolean> {
	try { await fs.promises.access(p); return true; } catch { return false; }
}

export class CopilotCliAdapter implements IEcosystemAdapter, IDiscoverableEcosystem {
	readonly id = 'copilotcli';
	readonly displayName = 'GitHub Copilot CLI';

	/**
	 * Currently a no-op match. The adapter participates in discovery via
	 * IDiscoverableEcosystem but lets the existing fallback parsing code in
	 * extension.ts continue to own per-session parsing for Copilot CLI files.
	 */
	handles(_sessionFile: string): boolean {
		return false;
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(_sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
	}

	async countInteractions(_sessionFile: string): Promise<number> {
		return 0;
	}

	async getModelUsage(_sessionFile: string): Promise<ModelUsage> {
		return {};
	}

	async getMeta(_sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		return { title: undefined, firstInteraction: null, lastInteraction: null };
	}

	getEditorRoot(_sessionFile: string): string {
		return getCopilotCliSessionStateDir();
	}

	getCandidatePaths(): CandidatePath[] {
		return [{ path: getCopilotCliSessionStateDir(), source: 'Copilot CLI' }];
	}

	/**
	 * Walk ~/.copilot/session-state collecting:
	 *   - top-level .json / .jsonl files
	 *   - UUID subdirectories' events.jsonl (when non-empty)
	 */
	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		const root = getCopilotCliSessionStateDir();

		try {
			if (!(await pathExists(root))) {
				return { sessionFiles, candidatePaths };
			}
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(root, { withFileTypes: true });
			} catch (e) {
				log(`Could not read Copilot CLI session path in ${root}: ${e}`);
				return { sessionFiles, candidatePaths };
			}

			// Top-level .json / .jsonl files
			const flat = entries
				.filter(e => !e.isDirectory() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl')))
				.map(e => path.join(root, e.name));
			if (flat.length > 0) {
				log(`📄 Found ${flat.length} session files in Copilot CLI directory`);
				sessionFiles.push(...flat);
			}

			// UUID subdirectories' events.jsonl
			const subDirs = entries.filter(e => e.isDirectory());
			const subDirFiles = (await Promise.all(
				subDirs.map(async (subDir) => {
					const eventsFile = path.join(root, subDir.name, 'events.jsonl');
					try {
						const stats = await fs.promises.stat(eventsFile);
						return stats.size > 0 ? eventsFile : null;
					} catch {
						return null;
					}
				}),
			)).filter((f): f is string => f !== null);
			if (subDirFiles.length > 0) {
				log(`📄 Found ${subDirFiles.length} session files in Copilot CLI subdirectories`);
				sessionFiles.push(...subDirFiles);
			}
		} catch (e) {
			log(`Could not check Copilot CLI session path ${root}: ${e}`);
		}

		return { sessionFiles, candidatePaths };
	}
}
