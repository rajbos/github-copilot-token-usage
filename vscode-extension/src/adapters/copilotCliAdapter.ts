/**
 * CopilotCliAdapter — discovers GitHub Copilot CLI agent-mode session files.
 *
 * Two session storage formats are discovered:
 *   1. ~/.copilot/session-state/<uuid>/events.jsonl — worktree/project sessions
 *      with rich data (tool calls, model metrics, token counts).
 *   2. ~/.copilot/session-store.db — all sessions including chat-only sessions
 *      (repository IS NULL) that never produce an events.jsonl file.
 *
 * For events.jsonl files the adapter participates only in discovery (handles()
 * returns false for those paths) so the existing fallback JSONL parser in
 * extension.ts continues to own parsing. For session-store.db virtual paths
 * handles() returns true and the adapter provides metadata from the DB.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage, ChatTurn } from '../types';
import type {
	IEcosystemAdapter,
	IDiscoverableEcosystem,
	DiscoveryResult,
	CandidatePath,
} from '../ecosystemAdapter';
import { CopilotCliStoreAccess } from '../copilotCliStore';
import { createEmptyContextRefs } from '../tokenEstimation';

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

	private readonly store = new CopilotCliStoreAccess();

	/**
	 * Returns true only for session-store.db virtual paths.
	 * For events.jsonl files the adapter participates in discovery only; the
	 * existing fallback JSONL parser in extension.ts continues to own those.
	 */
	handles(sessionFile: string): boolean {
		return this.store.isCliStoreSession(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		if (this.store.isCliStoreSession(sessionFile)) {
			return this.store.getDbPathFromVirtual(sessionFile);
		}
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		if (this.store.isCliStoreSession(sessionFile)) {
			return this.store.stat(sessionFile);
		}
		return fs.promises.stat(sessionFile);
	}

	async getTokens(_sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		// session-store.db does not store token counts
		return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		if (this.store.isCliStoreSession(sessionFile)) {
			return this.store.countTurns(sessionFile);
		}
		return 0;
	}

	async getModelUsage(_sessionFile: string): Promise<ModelUsage> {
		return {};
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		if (this.store.isCliStoreSession(sessionFile)) {
			const session = await this.store.readSession(sessionFile);
			if (!session) { return { title: undefined, firstInteraction: null, lastInteraction: null }; }
			return {
				title: session.summary ?? undefined,
				firstInteraction: session.created_at,
				lastInteraction: session.updated_at,
				// workspacePath is intentionally absent for NULL-repository sessions
				// so callers can detect the no-workspace case via its absence.
			};
		}
		return { title: undefined, firstInteraction: null, lastInteraction: null };
	}

	getEditorRoot(sessionFile: string): string {
		if (this.store.isCliStoreSession(sessionFile)) {
			return path.join(os.homedir(), '.copilot');
		}
		return getCopilotCliSessionStateDir();
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[] }> {
		if (!this.store.isCliStoreSession(sessionFile)) {
			return { turns: [] };
		}
		const dbTurns = await this.store.getTurns(sessionFile);
		const turns: ChatTurn[] = dbTurns.map(t => ({
			turnNumber: t.turn_index + 1,
			timestamp: t.timestamp,
			mode: 'cli' as const,
			userMessage: t.user_message ?? '',
			assistantResponse: t.assistant_response ?? '',
			model: null,
			toolCalls: [],
			contextReferences: createEmptyContextRefs(),
			mcpTools: [],
			inputTokensEstimate: 0,
			outputTokensEstimate: 0,
			thinkingTokensEstimate: 0,
		}));
		return { turns };
	}

	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		if (this.store.isCliStoreSession(sessionFile)) {
			return this.store.getDailyFractions(sessionFile);
		}
		return {};
	}

	getCandidatePaths(): CandidatePath[] {
		const paths: CandidatePath[] = [
			{ path: getCopilotCliSessionStateDir(), source: 'Copilot CLI' },
		];
		const dbPath = this.store.getDbPath();
		paths.push({ path: dbPath, source: 'Copilot CLI (session-store.db)' });
		return paths;
	}

	/**
	 * Discover session files from two sources:
	 *   1. ~/.copilot/session-state/ — events.jsonl files (worktree sessions)
	 *   2. ~/.copilot/session-store.db — DB-only sessions (chat sessions without
	 *      a workspace, or sessions whose events.jsonl was not yet written)
	 *
	 * Sessions already represented by an events.jsonl are excluded from the DB
	 * results to prevent double-counting.
	 */
	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		const root = getCopilotCliSessionStateDir();

		// Collect UUID subdirectory names from session-state/ to exclude them
		// from the DB discovery (they are already covered by events.jsonl).
		const knownUuids = new Set<string>();

		try {
			if (await pathExists(root)) {
				let entries: fs.Dirent[];
				try {
					entries = await fs.promises.readdir(root, { withFileTypes: true });
				} catch (e) {
					log(`Could not read Copilot CLI session path in ${root}: ${e}`);
					entries = [];
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
							if (stats.size > 0) {
								knownUuids.add(subDir.name);
								return eventsFile;
							}
						} catch { /* no events.jsonl in this subdir */ }
						return null;
					}),
				)).filter((f): f is string => f !== null);
				if (subDirFiles.length > 0) {
					log(`📄 Found ${subDirFiles.length} session files in Copilot CLI subdirectories`);
					sessionFiles.push(...subDirFiles);
				}
			}
		} catch (e) {
			log(`Could not check Copilot CLI session path ${root}: ${e}`);
		}

		// Also discover DB-only sessions (no matching events.jsonl)
		try {
			const dbOnlyIds = await this.store.discoverNewSessions(knownUuids);
			if (dbOnlyIds.length > 0) {
				log(`📄 Found ${dbOnlyIds.length} chat-only session(s) in Copilot CLI session-store.db`);
				sessionFiles.push(...dbOnlyIds.map(id => this.store.virtualPath(id)));
			}
		} catch (e) {
			log(`Could not read Copilot CLI session-store.db: ${e}`);
		}

		return { sessionFiles, candidatePaths };
	}
}
