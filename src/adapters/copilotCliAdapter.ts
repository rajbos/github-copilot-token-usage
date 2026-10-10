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
	IAnalyzableEcosystem,
	DiscoveryResult,
	CandidatePath,
	UsageAnalysisAdapterContext,
} from '../ecosystemAdapter';
import { CopilotCliStoreAccess, isMicrosoftScoutCwd, isCopilotAppClientName } from '../copilotCliStore';
import { getCopilotCliExactUsage } from '../copilotCliOtel';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis } from '../usageAnalysis';
import { normalizePath } from '../utils/pathUtils';
import { pathExists } from '../utils/fsAsync';
import { readTextFileWithSizeGuard } from '../utils/safeFileRead';

/** Returns the canonical Copilot CLI session-state directory (~/.copilot/session-state). */
export function getCopilotCliSessionStateDir(): string {
	return path.join(os.homedir(), '.copilot', 'session-state');
}


export class CopilotCliAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'copilotcli';
	readonly displayName = 'Copilot CLI';
	// Bounded so large session histories don't saturate disk, but the pathExists() pre-check
	// above (added alongside this) makes each miss a cheap access() instead of an open()+error-log,
	// so a higher bound is safe now — was 20, too low for histories with thousands of sessions.
	private static readonly WORKSPACE_YAML_CONCURRENCY = 64;

	private readonly store = new CopilotCliStoreAccess();
	/** UUIDs of sessions discovered to have been created by Microsoft Scout. */
	private readonly _scoutSessionIds = new Set<string>();
	/**
	 * UUIDs of sessions whose workspace.yaml records `client_name: github/autopilot`,
	 * meaning they were started via the Copilot desktop app (which wraps the CLI)
	 * rather than the plain terminal CLI (`client_name: github/cli`, or absent on
	 * older sessions predating this field).
	 */
	private readonly _appSessionIds = new Set<string>();

	/** The id the classification sets are keyed by: the DB session id, or the session-state directory name. */
	private classificationId(sessionFile: string): string {
		return this.store.getSessionId(sessionFile) ?? path.basename(path.dirname(sessionFile));
	}

	/**
	 * How discovery classified this session: started by Microsoft Scout, by the Copilot desktop app, or both (the two
	 * are independent; only the display label gives Scout precedence). Empty when it did not classify it.
	 * Discovery runs only where the adapter was asked to discover (the extension host), so a second instance — the
	 * analysis worker's — has to be told; see {@link noteSessionKinds}.
	 */
	getSessionKinds(sessionFile: string): Array<'scout' | 'app'> {
		const id = this.classificationId(sessionFile);
		const kinds: Array<'scout' | 'app'> = [];
		if (!id) { return kinds; }
		if (this._scoutSessionIds.has(id)) { kinds.push('scout'); }
		if (this._appSessionIds.has(id)) { kinds.push('app'); }
		return kinds;
	}

	/** Records classifications made elsewhere (by discovery in another instance) for this session. */
	noteSessionKinds(sessionFile: string, kinds: ReadonlyArray<'scout' | 'app'>): void {
		const id = this.classificationId(sessionFile);
		if (!id) { return; }
		for (const kind of kinds) { (kind === 'scout' ? this._scoutSessionIds : this._appSessionIds).add(id); }
	}

	/**
	 * Returns the per-session display name.
	 * Sessions whose cwd is under Documents\Microsoft Scout are shown as
	 * "MS Scout (Copilot CLI)" to distinguish them from regular CLI sessions.
	 * Sessions started via the Copilot desktop app are shown as "Copilot CLI (App)".
	 */
	getDisplayName(sessionFile: string): string {
		// DB virtual path: session-store.db#<uuid>
		const sessionId = this.store.getSessionId(sessionFile);
		// events.jsonl path: ~/.copilot/session-state/<uuid>/events.jsonl
		const eventsUuid = path.basename(path.dirname(sessionFile));
		if ((sessionId && this._scoutSessionIds.has(sessionId)) || (eventsUuid && this._scoutSessionIds.has(eventsUuid))) {
			return 'MS Scout (Copilot CLI)';
		}
		if ((sessionId && this._appSessionIds.has(sessionId)) || (eventsUuid && this._appSessionIds.has(eventsUuid))) {
			return 'Copilot CLI (App)';
		}
		return 'Copilot CLI';
	}

	/**
	 * Called for files that were *discovered* by this adapter but not *handled*
	 * (i.e. events.jsonl files, which are parsed by the JSONL fallback parser).
	 * Returns 'MS Scout (Copilot CLI)' or 'Copilot CLI (App)' when the session UUID
	 * was marked as such during discover(), undefined otherwise.
	 */
	getDisplayNameForDiscoveredPath(sessionFile: string): string | undefined {
		const eventsUuid = path.basename(path.dirname(sessionFile));
		if (eventsUuid && this._scoutSessionIds.has(eventsUuid)) {
			return 'MS Scout (Copilot CLI)';
		}
		if (eventsUuid && this._appSessionIds.has(eventsUuid)) {
			return 'Copilot CLI (App)';
		}
		return undefined;
	}

	/**
	 * Read workspace.yaml next to a discovered events.jsonl file and return its
	 * cwd value. This supplies workspace attribution for worktree CLI sessions
	 * without changing the handles() contract.
	 */
	async getWorkspacePathForDiscoveredPath(sessionFile: string): Promise<string | undefined> {
		const yamlPath = path.join(path.dirname(sessionFile), 'workspace.yaml');
		// pathExists() pre-check: see _tryMarkScoutFromWorkspaceYaml()'s doc comment — this is
		// called once per discovered Copilot CLI session file, and older sessions routinely
		// predate workspace.yaml.
		if (!await pathExists(yamlPath)) { return undefined; }
		const content = await readTextFileWithSizeGuard(yamlPath, 'copilotCliAdapter');
		if (content === undefined) { return undefined; }
		const match = content.match(/^cwd:\s*(.+)$/m);
		const cwd = match?.[1]?.trim();
		return cwd || undefined;
	}

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

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number; cacheReadTokens?: number }> {
		// Prefer exact billing rows from session-store.db; fall back to OTel file export.
		const exact = await getCopilotCliExactUsage(sessionFile);
		if (exact) {
			return {
				tokens: exact.actualTokens,
				thinkingTokens: 0,
				actualTokens: exact.actualTokens,
				cacheReadTokens: exact.cacheReadTokens,
			};
		}
		return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		if (this.store.isCliStoreSession(sessionFile)) {
			return this.store.countTurns(sessionFile);
		}
		return 0;
	}

	// session-store.db now contains an `assistant_usage_events` table with exact per-LLM-call
	// billing data (model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
	// total_nano_aiu), keyed by the same session UUID used in events.jsonl paths and DB-only
	// virtual paths. This is the authoritative source for both worktree and chat-only sessions;
	// OpenTelemetry file export (when enabled) is used only as a fallback.
	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		const exact = await getCopilotCliExactUsage(sessionFile);
		return exact?.modelUsage ?? {};
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string; repository?: string }> {
		if (this.store.isCliStoreSession(sessionFile)) {
			const session = await this.store.readSession(sessionFile);
			if (!session) { return { title: undefined, firstInteraction: null, lastInteraction: null }; }
			return {
				title: session.summary ?? undefined,
				firstInteraction: session.created_at,
				lastInteraction: session.updated_at,
				workspacePath: session.cwd ?? undefined,
				repository: session.repository ?? undefined,
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

	async analyzeUsage(sessionFile: string, _ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		if (!this.store.isCliStoreSession(sessionFile)) { return analysis; }
		const turns = await this.store.getTurns(sessionFile);
		// Each user turn counts as one CLI interaction; no model/tool data available in the schema.
		const cliCount = turns.filter(t => t.user_message !== null).length;
		const sessionId = this.store.getSessionId(sessionFile);
		if (sessionId && this._appSessionIds.has(sessionId)) {
			// Copilot desktop app session — broken out from terminal CLI usage.
			analysis.modeUsage.cliApp = cliCount;
		} else {
			analysis.modeUsage.cli = cliCount;
		}
		return analysis;
	}

	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		if (this.store.isCliStoreSession(sessionFile)) {
			return this.store.getDailyFractions(sessionFile);
		}
		return {};
	}

	/**
	 * Reads workspace.yaml from a UUID session directory and adds the UUID to
	 * _scoutSessionIds if the cwd indicates a Microsoft Scout session, and/or to
	 * _appSessionIds if client_name indicates the Copilot desktop app.
	 * Silently ignores missing or unreadable files.
	 *
	 * The pathExists() pre-check (same pattern as usageAnalysis.ts's
	 * _asuApplyCopilotAppSplit()) matters at this call site's scale: many
	 * historical sessions predate workspace.yaml, so this is called across
	 * thousands of session dirs where the file is routinely absent — without
	 * the pre-check, readTextFileWithSizeGuard() logs a console.error() on
	 * every miss, which is measurably slow under a debugger/Extension
	 * Development Host and was the dominant cost of a multi-minute discovery
	 * scan on a large session history.
	 */
	private async _tryMarkScoutFromWorkspaceYaml(uuidDir: string, uuid: string): Promise<void> {
		const yamlPath = path.join(uuidDir, 'workspace.yaml');
		if (!await pathExists(yamlPath)) { return; }
		const content = await readTextFileWithSizeGuard(yamlPath, 'copilotCliAdapter');
		if (content === undefined) { return; }
		const cwdMatch = content.match(/^cwd:\s*(.+)$/m);
		if (cwdMatch && isMicrosoftScoutCwd(cwdMatch[1].trim())) {
			this._scoutSessionIds.add(uuid);
		}
		const clientMatch = content.match(/^client_name:\s*(.+)$/m);
		if (clientMatch && isCopilotAppClientName(clientMatch[1].trim())) {
			this._appSessionIds.add(uuid);
		}
	}

	/** Read workspace metadata with bounded I/O so large session histories do not saturate disk. */
	private async markDbOnlySessionsFromWorkspaceYaml(sessions: { id: string; cwd: string | null }[], root: string): Promise<void> {
		let nextIndex = 0;
		const worker = async (): Promise<void> => {
			while (nextIndex < sessions.length) {
				const session = sessions[nextIndex++];
				if (isMicrosoftScoutCwd(session.cwd)) {
					this._scoutSessionIds.add(session.id);
				}
				await this._tryMarkScoutFromWorkspaceYaml(path.join(root, session.id), session.id);
			}
		};
		await Promise.all(Array.from(
			{ length: Math.min(CopilotCliAdapter.WORKSPACE_YAML_CONCURRENCY, sessions.length) },
			() => worker(),
		));
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
						const uuidDir = path.join(root, subDir.name);
						const eventsFile = path.join(uuidDir, 'events.jsonl');
						try {
							const stats = await fs.promises.stat(eventsFile);
							if (stats.size > 0) {
								knownUuids.add(subDir.name);
								// Check workspace.yaml to detect Microsoft Scout sessions
								await this._tryMarkScoutFromWorkspaceYaml(uuidDir, subDir.name);
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
			const dbOnlySessions = await this.store.discoverNewSessionsWithCwd(knownUuids);
			if (dbOnlySessions.length > 0) {
				log(`📄 Found ${dbOnlySessions.length} chat-only session(s) in Copilot CLI session-store.db`);
				// Chat-only sessions still get a session-state/<uuid>/ dir with workspace.yaml
				// (just no events.jsonl), so client_name (app vs. terminal CLI) is still detectable.
				await this.markDbOnlySessionsFromWorkspaceYaml(dbOnlySessions, root);
				for (const { id } of dbOnlySessions) {
					sessionFiles.push(this.store.virtualPath(id));
				}
			}
		} catch (e) {
			log(`Could not read Copilot CLI session-store.db: ${e}`);
		}

		return { sessionFiles, candidatePaths };
	}
}
