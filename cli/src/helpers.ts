/**
 * Shared helper functions for CLI commands.
 * Handles session file discovery, parsing, and stats aggregation.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { SessionDiscovery } from '../../src/sessionDiscovery';
import { findWorkspacePathForDiscoveredPath, type IEcosystemAdapter } from '../../src/ecosystemAdapter';
import { findRepositoryRemoteForFolder, resolveExactWorkspacePath } from '../../src/workspaceHelpers';
import { resolveFileUri } from '../../src/workspacePathResolver';
import { calculateEstimatedCost } from '../../src/tokenEstimation';
import { toLocalDayKey } from '../../src/utils/dayKeys';
import type { DetailedStats, UsageAnalysisStats, WorkspaceCustomizationMatrix, WorkspaceCustomizationRow, TodaySessionSummary } from '../../src/types';
import { analyzeSessionUsage, mergeUsageAnalysis } from '../../src/usageAnalysis';
import { addModelUsage, scaleModelUsage } from '../../src/statsHelpers';
import { calculateEnvironmentalImpact } from '../../src/environmentalImpact';
import { withErrorRecovery, withErrorRecoverySync } from '../../src/utils/errors';
import { buildRecentSessionBuckets, type RecentSessionBucketItem } from '../../src/recentSessions';
import { groupWorkspaces, groupFolders, detectArtefactWorkspaceNames, type WorkspaceGroupingProbes, type WorkspaceUsageEntry } from '../../src/workspaceGrouping';
import { prefetchWorkspaceGroupingProbes } from '../../src/workspaceGroupingProbes';
import { getTimeWindowStartDate } from '../../src/timeWindows';
import { buildRepeatedTaskReport, type RepeatedTaskSessionSource } from '../../src/repeatedTasks';
import { loadCache, saveCache, disableCache, getCached, setCached, getCacheStats } from './cliCache';
import {
	getEcosystems,
	modelPricing,
	tokenEstimators,
	statSessionFile,
	getSessionBackingPath,
	processSessionFile as processSessionFileWith,
	type SessionDataCache,
} from './sessionProcessing';
export { readDebugLogTokensForSession, getSessionBackingPath } from './sessionProcessing';

// Import JSON data files
import toolNamesData from '../../src/toolNames.json';

// Pure analysis helpers from analysis.ts
import {
	type SessionData,
	type DailyEntry,
	type PeriodStats,
	effectiveTokens,
	runWithConcurrency,
	createEmptyPeriodStats,
	aggregateIntoPeriod,
	createEmptyUsageAnalysisPeriod,
	buildChartPayload,
	fmt,
	formatTokens,
} from './analysis';
export type { SessionData, DailyEntry } from './analysis';
export { effectiveTokens, buildChartPayload, fmt, formatTokens } from './analysis';

const cliSessionCache: SessionDataCache = { get: getCached, set: setCached };
const toolNameMap = toolNamesData as { [key: string]: string };

/** Logging functions for the CLI context */
const log = (msg: string) => { /* quiet by default */ };
const warn = (msg: string) => { /* quiet by default */ };
const error = (msg: string, err?: unknown) => {
	const errMsg = err instanceof Error ? err.message : (err !== undefined ? String(err) : '');
	console.error(chalk.red(msg), errMsg);
};

/**
 * Safely reads and parses a JSON file.
 * Returns null if the file does not exist (silently) or on any other error (with a structured log message).
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		const raw = await fs.promises.readFile(filePath, 'utf-8');
		return JSON.parse(raw) as T;
	} catch (err: any) {
		if (err?.code !== 'ENOENT') {
			error(`[readJsonFile] Failed to read or parse JSON at ${filePath}:`, err);
		}
		return null;
	}
}

/** Create session discovery instance for CLI */
function createSessionDiscovery(): SessionDiscovery {
	return new SessionDiscovery({ log, warn, error, ecosystems: getEcosystems() });
}

/** Discover all session files on this machine */
export async function discoverSessionFiles(): Promise<string[]> {
	const discovery = createSessionDiscovery();
	return discovery.getCopilotSessionFiles();
}

/** Instruction files that satisfy the CLI's "has customization" check (case-insensitive). */
/** The customization type the CLI's instructions-file check reports (same id as the extension's). */
const CLI_INSTRUCTIONS_TYPE = { id: 'instructions', icon: '📋', label: 'Instructions' };

const INSTRUCTION_PATHS = ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'];

/** Workspace folder a session belongs to, or undefined when it cannot be resolved. */
/**
 * Interactions of a session that counts towards workspace usage, or 0 when it does not: the
 * extension only counts sessions with at least one interaction in its last-30-days window, so
 * old or empty sessions must not add CLI workspaces, remotes or session counts either.
 */
async function recentSessionInteractions(activity: SessionActivityLookup, cutoff: Date): Promise<number> {
	try {
		const own = await activity.lastActivity();
		const isVirtual = getSessionBackingPath(activity.file) !== activity.file;
		const stats = await statSessionFile(activity.file);
		if (!sessionActiveSince(stats.mtime, own, cutoff, isVirtual)) { return 0; }
		const data = await processSessionFile(activity.file);
		if (!data) { return 0; }
		if (isVirtual) { return sessionActiveSince(data.lastModified, own, cutoff, true) ? data.interactions : 0; }
		// A regular file is placed by its last day of real activity, like the extension: the owning
		// adapter's recorded last interaction (e.g. Pi, whose daily split is otherwise synthesised
		// from the mtime), else its daily activity. A recently copied or touched old log does not count.
		const adapterLastInteraction = (await activity.meta())?.lastInteraction;
		return sessionLastActivityDay(data.dailyFractions, data.lastModified, adapterLastInteraction) >= toLocalDayKey(cutoff) ? data.interactions : 0;
	} catch {
		return 0;
	}
}

/**
 * The latest day a session had activity on: the adapter's recorded last interaction when it is a
 * valid timestamp, else its last daily-fraction day, else its file mtime's day.
 */
export function sessionLastActivityDay(dailyFractions: Record<string, number> | undefined, fallback: Date, adapterLastInteraction?: string | null): string {
	const recorded = adapterLastInteraction ? new Date(adapterLastInteraction) : undefined;
	if (recorded && !Number.isNaN(recorded.getTime())) { return toLocalDayKey(recorded); }
	const days = Object.keys(dailyFractions ?? {}).sort();
	return days.length > 0 ? days[days.length - 1] : toLocalDayKey(fallback);
}

/**
 * Whether a session's own activity is on or after `cutoff`. A DB-backed (virtual) session
 * shares its database's mtime, which moves whenever any session in it changes, so only its own
 * last activity from the adapter counts — and a virtual session whose activity is unknown does
 * not qualify, rather than borrowing the database mtime (Cursor, for one, may report none).
 * Regular files use their own mtime. Unlike `isActiveSince()`, a recent database mtime alone
 * never admits a session, or every historical session in an active database would count.
 */
export function sessionActiveSince(fileMtime: Date, ownLastActivity: Date | null, cutoff: Date, isVirtual = false): boolean {
	if (ownLastActivity) { return ownLastActivity >= cutoff; }
	return !isVirtual && fileMtime >= cutoff;
}

/**
 * A session's workspace folder and git remote. The owning adapter's metadata comes first
 * (Copilot CLI, OpenCode, Crush and the other adapter-backed editors record both); the
 * format-specific fallbacks below cover Claude Code JSONL and VS Code chatSessions files.
 */
async function resolveSessionWorkspace(activity: SessionActivityLookup, claudeBasePath: string): Promise<{ path: string; repository?: string } | undefined> {
	const meta = await activity.meta();
	if (meta?.workspacePath) { return { path: meta.workspacePath, repository: meta.repository }; }
	// Copilot CLI events.jsonl: discovered by its adapter but not handled by it, so getMeta()
	// knows nothing; the adapter still reads the adjacent workspace.yaml through this hook.
	const workspacePath = await findWorkspacePathForDiscoveredPath(getEcosystems(), activity.file)
		?? await resolveSessionWorkspacePath(activity.file, claudeBasePath);
	if (!workspacePath) { return undefined; }
	// No adapter covers VS Code chatSessions files: the remote is the workspace folder's own
	// repository (walking up for a sub-folder workspace), the same shared rule as the extension's
	// analysis — never a referenced file, which can live in another or a nested repository.
	const repository = meta?.repository ?? await withErrorRecovery(
		() => findRepositoryRemoteForFolder(workspacePath),
		undefined,
		`buildCustomizationMatrix repository(${workspacePath})`
	);
	return { path: workspacePath, ...(repository ? { repository } : {}) };
}

/** The `cwd` recorded in the first lines of a Claude Code session JSONL. */
async function readClaudeSessionCwd(sessionFile: string): Promise<string | undefined> {
	const content = await withErrorRecovery(
		() => fs.promises.readFile(sessionFile, 'utf-8'),
		null,
		`buildCustomizationMatrix readFile(${sessionFile})`
	);
	for (const line of (content ?? '').split('\n').slice(0, 30)) {
		if (!line.trim()) { continue; }
		try {
			const event = JSON.parse(line);
			if (event.cwd && typeof event.cwd === 'string') { return event.cwd; }
		} catch { /* skip malformed lines */ }
	}
	return undefined;
}

async function resolveSessionWorkspacePath(sessionFile: string, claudeBasePath: string): Promise<string | undefined> {
	// Claude Code session: ~/.claude/projects/<hash>/<uuid>.jsonl
	if (sessionFile.startsWith(claudeBasePath + path.sep) || sessionFile.startsWith(claudeBasePath + '/')) {
		return readClaudeSessionCwd(sessionFile);
	}

	// VS Code session: .../workspaceStorage/<hash>/chatSessions/<file>
	const chatSessionsDir = path.dirname(sessionFile);
	if (path.basename(chatSessionsDir) !== 'chatSessions') { return undefined; }
	const workspaceJson = await readJsonFile<{ folder?: string }>(path.join(path.dirname(chatSessionsDir), 'workspace.json'));
	const folderUri = workspaceJson?.folder;
	if (!folderUri || !folderUri.startsWith('file://')) { return undefined; }
	return resolveFileUri(folderUri) || undefined;
}

/**
 * Builds a WorkspaceCustomizationMatrix from session file paths.
 *
 * - For VS Code sessions: derives workspace folder from workspaceStorage/<hash>/workspace.json.
 * - For Claude Code sessions (~/.claude/projects/<hash>/): reads the JSONL to extract the
 *   `cwd` workspace path.
 *
 * Folders are then grouped with the shared `groupWorkspaces()` (src/workspaceGrouping.ts) — the
 * same rules the VS Code extension uses — so worktrees and clones of one repository count once.
 * A group has an issue when none of its folders has AGENTS.md, CLAUDE.md, or
 * .github/copilot-instructions.md.
 */
export async function buildCustomizationMatrix(
	sessionFiles: string[],
	probes?: WorkspaceGroupingProbes,
	now: Date = new Date(),
): Promise<WorkspaceCustomizationMatrix | undefined> {
	const claudeBasePath = path.join(os.homedir(), '.claude', 'projects');
	// The extension's last-30-days window (30 calendar dates including today), from the shared helper.
	const cutoff = getTimeWindowStartDate('last30', now)!;
	// One entry per session; the grouping sums sessions of the same folder.
	const entries: WorkspaceUsageEntry[] = [];
	for (const sessionFile of sessionFiles) {
		// One memoized adapter lookup per session, shared by the activity check and the metadata read.
		const activity = createSessionActivityLookup(sessionFile);
		const interactions = await recentSessionInteractions(activity, cutoff);
		if (interactions === 0) { continue; }
		const workspace = await resolveSessionWorkspace(activity, claudeBasePath);
		if (!workspace) { continue; }
		// Normalised like the extension's trackWorkspaceForSession(), so both feed the grouping the same keys.
		entries.push({ path: path.normalize(workspace.path), sessionCount: 1, interactionCount: interactions, repository: workspace.repository });
	}
	if (entries.length === 0) { return undefined; }

	const groups = groupWorkspaces(entries, probes ?? await prefetchWorkspaceGroupingProbes(entries));
	const hasInstructions = (wsPath: string): boolean => withErrorRecoverySync(
		// Same case-insensitive resolution as the shared customization scanner, so the CLI
		// accepts every spelling the extension does (including on case-sensitive filesystems).
		() => INSTRUCTION_PATHS.some(p => resolveExactWorkspacePath(wsPath, p, true) !== undefined),
		false,
		`buildCustomizationMatrix workspace check(${wsPath})`
	);

	let workspacesWithIssues = 0;
	const workspaces: WorkspaceCustomizationRow[] = groups.map(group => {
		const folders = groupFolders(group);
		const customized = folders.some(hasInstructions);
		if (!customized) { workspacesWithIssues++; }
		return {
			workspacePath: group.canonicalPath,
			workspaceName: group.displayName,
			sessionCount: group.sessionCount,
			interactionCount: group.interactionCount,
			// The one type the CLI checks, from the same group-wide test as workspacesWithIssues, so
			// the shared scorer never mistakes a customized repository for a missing one.
			typeStatuses: { [CLI_INSTRUCTIONS_TYPE.id]: customized ? '✅' : '❌' },
			...(folders.length > 1 ? { memberPaths: folders } : {}),
		};
	});
	const ungrouped = detectArtefactWorkspaceNames(groups).map(a => a.displayName);

	return {
		customizationTypes: [CLI_INSTRUCTIONS_TYPE],
		workspaces,
		totalWorkspaces: workspaces.length,
		workspacesWithIssues,
		...(ungrouped.length > 0 ? { ungroupedWorkspaceNames: ungrouped } : {}),
	};
}

/** Get diagnostic candidate paths info */
export function getDiagnosticPaths(): { path: string; exists: boolean; source: string }[] {
	const discovery = createSessionDiscovery();
	return discovery.getDiagnosticCandidatePaths();
}

/** What an adapter knows about one session beyond its token counts. */
export type SessionMeta = Awaited<ReturnType<IEcosystemAdapter['getMeta']>>;

/**
 * Per-session title and first/last interaction times from the owning adapter,
 * or null for sessions no adapter handles. For DB-backed editors this is the
 * only per-session timestamp: the backing database's mtime moves whenever any
 * session in it changes.
 */
export async function getSessionMeta(filePath: string): Promise<SessionMeta | null> {
	const eco = getEcosystems().find(e => e.handles(filePath));
	if (!eco) { return null; }
	try {
		return await eco.getMeta(filePath);
	} catch {
		return null;
	}
}

/**
 * Cheap per-session last-activity time from the owning adapter, or null when the
 * adapter has no such lookup (then the file's own mtime is the right signal).
 */
export async function getSessionLastActivity(filePath: string): Promise<Date | null> {
	const eco = getEcosystems().find(e => e.handles(filePath));
	if (!eco?.getLastActivity) { return null; }
	try {
		return await eco.getLastActivity(filePath);
	} catch {
		return null;
	}
}

/**
 * Extract per-UTC-day fractions from session content using interaction timestamps.
 * Fractions sum to 1.0. Falls back to { [fallbackDateKey]: 1.0 } when no timestamps found.
 *
 * Single canonical implementation for all text-based session formats:
 *  - Copilot CLI JSONL: timestamps on `user.message` events
 *  - VS Code delta JSONL: timestamps in kind:0 initial state, kind:2 appends, kind:1 updates
 *  - VS Code JSON: timestamps on request objects
 *
 * When adding support for a new session format, extend this function rather than creating
 * a separate attribution implementation — this keeps all formats consistent.
 */

/**
 * Process a single session file and extract its data, using the CLI's disk-backed cache.
 * The parsing itself lives in sessionProcessing.ts so the library entry point can reuse it
 * without the CLI's console/chalk dependencies.
 */
export async function processSessionFile(filePath: string, verbose = false): Promise<SessionData | null> {
	return processSessionFileWith(filePath, { verbose, cache: cliSessionCache });
}

/**
 * Calculate detailed statistics across all time periods.
 */
export async function calculateDetailedStats(
	sessionFiles: string[],
	progressCallback?: (completed: number, total: number) => void
): Promise<DetailedStats> {
	const now = new Date();

	// All period boundaries use local calendar dates so that "today" reflects
	// the user's local clock rather than resetting at UTC midnight.
	const todayKey = toLocalDayKey(now);

	const y = now.getFullYear();
	const m = now.getMonth(); // 0-indexed
	const monthStartKey = toLocalDayKey(new Date(y, m, 1));

	// Last month: the month before the current local month
	const lastMonthLastDay = new Date(y, m, 0); // day 0 = last day of previous month
	const lastMonthStartKey = toLocalDayKey(new Date(lastMonthLastDay.getFullYear(), lastMonthLastDay.getMonth(), 1));
	// lastMonthEndKey is the day before monthStartKey — string comparison handles this naturally
	// (any date >= lastMonthStartKey && < monthStartKey is in last month)

	const last30DaysDate = new Date(y, m, now.getDate() - 30);
	const last30DaysStartKey = toLocalDayKey(last30DaysDate);

	const periods: {
		today: PeriodStats;
		month: PeriodStats;
		lastMonth: PeriodStats;
		last30Days: PeriodStats;
	} = {
		today: createEmptyPeriodStats(),
		month: createEmptyPeriodStats(),
		lastMonth: createEmptyPeriodStats(),
		last30Days: createEmptyPeriodStats(),
	};

	let processed = 0;
	const sessionResults = await runWithConcurrency(sessionFiles, async (file) => {
		const data = await processSessionFile(file);
		if (progressCallback) { progressCallback(++processed, sessionFiles.length); }
		return data;
	});

	for (const data of sessionResults) {
		if (!data || data.tokens === 0) {
			continue;
		}

		// Skip sessions that have no relevant days (all older than last month)
		const hasRelevantDay = Object.keys(data.dailyFractions).some(k => k >= lastMonthStartKey);
		if (!hasRelevantDay) { continue; }

		// Accumulate per-period fractions from the session's daily breakdown
		let todayFrac = 0;
		let monthFrac = 0;
		let lastMonthFrac = 0;
		let last30DaysFrac = 0;

		for (const [dateKey, fraction] of Object.entries(data.dailyFractions)) {
			if (dateKey === todayKey) { todayFrac += fraction; }
			if (dateKey >= monthStartKey) { monthFrac += fraction; }
			if (dateKey >= lastMonthStartKey && dateKey < monthStartKey) { lastMonthFrac += fraction; }
			if (dateKey >= last30DaysStartKey) { last30DaysFrac += fraction; }
		}

		if (todayFrac > 0) { aggregateIntoPeriod(periods.today, data, todayFrac); }
		if (monthFrac > 0) { aggregateIntoPeriod(periods.month, data, monthFrac); }
		if (lastMonthFrac > 0) { aggregateIntoPeriod(periods.lastMonth, data, lastMonthFrac); }
		if (last30DaysFrac > 0) { aggregateIntoPeriod(periods.last30Days, data, last30DaysFrac); }
	}

	// Compute derived stats
	for (const period of Object.values(periods)) {
		if (period.sessions > 0) {
			period.avgTokensPerSession = Math.round(period.tokens / period.sessions);
		}
		const environmentalImpact = calculateEnvironmentalImpact(period.modelUsage, period.tokens);
		period.co2 = environmentalImpact.co2;
		period.treesEquivalent = environmentalImpact.treesEquivalent;
		period.waterUsage = environmentalImpact.waterUsage;
		period.estimatedCost = calculateEstimatedCost(period.modelUsage, modelPricing);
		period.estimatedCostCopilot = calculateEstimatedCost(period.modelUsage, modelPricing, 'copilot');
	}

	return {
		...periods,
		lastUpdated: now,
	};
}

/** Options for calculateUsageAnalysisStats. */
export interface UsageAnalysisOptions {
	/**
	 * Also cluster the analysed sessions' first prompts into a repeated-task
	 * (Skill Suggestions) report. Off by default: the report carries prompt text.
	 */
	includeRepeatedTasks?: boolean;
}

/**
 * Calculate usage analysis stats for fluency scoring.
 * This is a simplified version that uses the shared usageAnalysis module.
 */
export async function calculateUsageAnalysisStats(sessionFiles: string[], options: UsageAnalysisOptions = {}): Promise<UsageAnalysisStats> {
	const deps = {
		warn,
		tokenEstimators,
		modelPricing,
		toolNameMap,
		ecosystems: getEcosystems(),
	};

	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const last30DaysStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
	const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	// Cutoff includes last month — which may start before the 30-day window
	const cutoffStart = lastMonthStart < last30DaysStart ? lastMonthStart : last30DaysStart;

	const todayPeriod = createEmptyUsageAnalysisPeriod();
	const last30DaysPeriod = createEmptyUsageAnalysisPeriod();
	const monthPeriod = createEmptyUsageAnalysisPeriod();
	const lastMonthPeriod = createEmptyUsageAnalysisPeriod();
	const todaySessions: TodaySessionSummary[] = [];
	const recentSessionItems: RecentSessionBucketItem<TodaySessionSummary>[] = [];
	const repeatedTaskSources: RepeatedTaskSessionSource[] = [];

	for (const file of sessionFiles) {
		try {
			const stats = await statSessionFile(file);
			const modified = stats.mtime;

			const inPeriodWindow = modified >= cutoffStart;
			// A DB-backed session's file mtime can lag its real activity (writes still in
			// the SQLite WAL), so the repeated-task report asks the adapter before skipping.
			// The lookup reads the adapter at most once per session and is reused below.
			const activity = createSessionActivityLookup(file);
			if (!inPeriodWindow) {
				if (!options.includeRepeatedTasks) { continue; }
				if (!isActiveSince(modified, await activity.lastActivity(), cutoffStart)) { continue; }
			}

			const analysis = await analyzeSessionUsage(deps, file);
			if (options.includeRepeatedTasks) {
				await addRepeatedTaskSource(repeatedTaskSources, activity, analysis.firstUserPrompt, stats.mtimeMs, cutoffStart);
			}
			// Period stats keep using the file mtime, as before.
			if (!inPeriodWindow) { continue; }
			let sessionSummary: TodaySessionSummary | undefined;
			const data = modified >= last30DaysStart ? await processSessionFile(file) : undefined;
			if (data && data.interactions > 0) {
				let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
				for (const usage of Object.values(data.modelUsage)) {
					inputTokens += usage.inputTokens;
					outputTokens += usage.outputTokens;
					cachedTokens += usage.cachedReadTokens ?? 0;
				}
				sessionSummary = {
					title: null,
					filePath: file,
					interactions: data.interactions,
					toolCalls: analysis.toolCalls.total,
					inputTokens,
					outputTokens,
					thinkingTokens: data.thinkingTokens ?? 0,
					cachedTokens,
					totalTokens: data.tokens,
					estimatedCost: calculateEstimatedCost(data.modelUsage, modelPricing),
					editor: data.editorSource,
					models: Object.keys(data.modelUsage),
					lastActivity: data.lastModified.toISOString(),
					...(analysis.sessionDuration?.totalDurationMs !== undefined ? { durationMs: analysis.sessionDuration.totalDurationMs } : {}),
					...(analysis.sessionDuration?.activeDurationMs !== undefined ? { activeDurationMs: analysis.sessionDuration.activeDurationMs } : {}),
				};
				recentSessionItems.push({
					activityKey: toLocalDayKey(data.lastModified),
					interactions: data.interactions,
					value: sessionSummary,
				});
			}

			if (modified >= last30DaysStart) {
				mergeUsageAnalysis(last30DaysPeriod, analysis);
				last30DaysPeriod.sessions++;
			}
			if (modified >= monthStart) {
				mergeUsageAnalysis(monthPeriod, analysis);
				monthPeriod.sessions++;
			}
			if (modified >= todayStart) {
				mergeUsageAnalysis(todayPeriod, analysis);
				todayPeriod.sessions++;
				if (sessionSummary) { todaySessions.push(sessionSummary); }
			}
			if (modified >= lastMonthStart && modified < monthStart) {
				mergeUsageAnalysis(lastMonthPeriod, analysis);
				lastMonthPeriod.sessions++;
			}
		} catch {
			// Skip files that can't be processed
		}
	}

	return {
		today: todayPeriod,
		last30Days: last30DaysPeriod,
		month: monthPeriod,
		lastMonth: lastMonthPeriod,
		lastUpdated: now,
		todaySessions: todaySessions.sort((a, b) => b.interactions - a.interactions),
		recentSessions: buildRecentSessionBuckets(recentSessionItems, now),
		...(options.includeRepeatedTasks ? { repeatedTasks: buildRepeatedTaskReport(repeatedTaskSources) } : {}),
	};
}

/** Adapter lookups a SessionActivityLookup uses; injectable for tests. */
export interface SessionActivitySources {
	getLastActivity(file: string): Promise<Date | null>;
	getMeta(file: string): Promise<SessionMeta | null>;
	getBackingPath(file: string): string;
}

const defaultActivitySources: SessionActivitySources = {
	getLastActivity: getSessionLastActivity,
	getMeta: getSessionMeta,
	getBackingPath: getSessionBackingPath,
};

/** Memoized per-session adapter reads: each underlying lookup runs at most once. */
export interface SessionActivityLookup {
	readonly file: string;
	meta(): Promise<SessionMeta | null>;
	/**
	 * The session's own last activity, for DB-backed (virtual) sessions only: the
	 * adapter's cheap `getLastActivity()`, else the metadata's `lastInteraction`.
	 * Null for regular files and when unknown; the file mtime is then the signal.
	 */
	lastActivity(): Promise<Date | null>;
}

export function createSessionActivityLookup(file: string, sources: SessionActivitySources = defaultActivitySources): SessionActivityLookup {
	let meta: Promise<SessionMeta | null> | undefined;
	let lastActivity: Promise<Date | null> | undefined;
	const lookup: SessionActivityLookup = {
		file,
		meta: () => (meta ??= sources.getMeta(file)),
		lastActivity: () => (lastActivity ??= (async () => {
			// Regular files: the file mtime is the session's own; no adapter lookup needed.
			if (sources.getBackingPath(file) === file) { return null; }
			const cheap = await sources.getLastActivity(file);
			if (cheap) { return cheap; }
			const fromMeta = (await lookup.meta())?.lastInteraction;
			const parsed = fromMeta ? new Date(fromMeta) : null;
			return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
		})()),
	};
	return lookup;
}

/**
 * Session context for the repeated-task report, from the owning adapter when it has one.
 * DB-backed sessions share their database's mtime, so the adapter's per-session
 * last interaction (or last activity) is what places a session in the window.
 */
async function toRepeatedTaskSource(activity: SessionActivityLookup, firstUserPrompt: string, mtimeMs: number): Promise<RepeatedTaskSessionSource> {
	const meta = await activity.meta();
	const lastInteraction = meta?.lastInteraction ?? (await activity.lastActivity())?.toISOString() ?? null;
	return {
		file: activity.file,
		firstUserPrompt,
		title: meta?.title ?? null,
		lastInteraction,
		mtime: mtimeMs,
		repository: meta?.repository ?? null,
	};
}

/** Add a session with a first prompt to the repeated-task sources when its own activity is in the window. */
async function addRepeatedTaskSource(
	sources: RepeatedTaskSessionSource[], activity: SessionActivityLookup,
	firstUserPrompt: string | undefined, mtimeMs: number, cutoff: Date,
): Promise<void> {
	if (!firstUserPrompt) { return; }
	const source = await toRepeatedTaskSource(activity, firstUserPrompt, mtimeMs);
	if (repeatedTaskActivityMs(source) >= cutoff.getTime()) { sources.push(source); }
}

/**
 * Whether a session was active on or after `cutoff`: by its file mtime, or by the
 * adapter's per-session last activity when the file mtime is stale.
 */
export function isActiveSince(fileMtime: Date, sessionLastActivity: Date | null, cutoff: Date): boolean {
	return fileMtime >= cutoff || (sessionLastActivity !== null && sessionLastActivity >= cutoff);
}

/**
 * A repeated-task source's own activity time in epoch ms: its last interaction
 * when known and parseable, otherwise the file mtime.
 */
export function repeatedTaskActivityMs(source: Pick<RepeatedTaskSessionSource, 'lastInteraction' | 'mtime'>): number {
	const parsed = source.lastInteraction ? Date.parse(source.lastInteraction) : NaN;
	return Number.isNaN(parsed) ? source.mtime : parsed;
}

/**
 * Process session files and return per-day stats for the last 30 days.
 * Returns `{ labels, days }` where labels are sorted YYYY-MM-DD strings (UTC) and
 * days are the corresponding aggregated stats.
 */
export async function calculateDailyStats(sessionFiles: string[], verbose = false): Promise<{
	labels: string[];
	days: DailyEntry[];
	allDaysMap: Map<string, DailyEntry>;
}> {
	const now = new Date();
	const last30DaysDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
	const last30DaysStartKey = toLocalDayKey(last30DaysDate);
	const todayKey = toLocalDayKey(now);

	// Fill in all 31 days (today inclusive) with zeroes so the chart has continuous labels
	const dailyMap = new Map<string, DailyEntry>();
	const cursor = new Date(last30DaysDate);
	while (toLocalDayKey(cursor) <= todayKey) {
		const key = toLocalDayKey(cursor);
		dailyMap.set(key, { tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });
		cursor.setDate(cursor.getDate() + 1);
	}

	// Full historical map (all time, no age filter) for weekly/monthly chart periods
	const allDaysMap = new Map<string, DailyEntry>();

	const sessionResults = await runWithConcurrency(sessionFiles, async (file) => processSessionFile(file, verbose));

	for (const data of sessionResults) {
		if (!data || data.tokens === 0 || data.interactions === 0) { continue; }

		const displayTok = effectiveTokens(data);

		for (const [dateKey, fraction] of Object.entries(data.dailyFractions)) {
			const tokForDay = Math.round(displayTok * fraction);
			const scaledUsage = scaleModelUsage(data.modelUsage, fraction);

			// 30-day map: only add days within the window
			const dailyEntry = dailyMap.get(dateKey);
			if (dailyEntry) {
				dailyEntry.tokens += tokForDay;
				dailyEntry.sessions++;
				addModelUsage(dailyEntry.modelUsage, scaledUsage);
				const editor = data.editorSource;
				if (!dailyEntry.editorUsage[editor]) {
					dailyEntry.editorUsage[editor] = { tokens: 0, sessions: 0 };
				}
				dailyEntry.editorUsage[editor].tokens += tokForDay;
				dailyEntry.editorUsage[editor].sessions++;
				if (!dailyEntry.editorModelUsage) { dailyEntry.editorModelUsage = {}; }
				if (!dailyEntry.editorModelUsage[editor]) { dailyEntry.editorModelUsage[editor] = {}; }
				addModelUsage(dailyEntry.editorModelUsage[editor], scaledUsage);
			}

			// Full history map: always add regardless of age (used for weekly/monthly charts)
			if (!allDaysMap.has(dateKey)) {
				allDaysMap.set(dateKey, { tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });
			}
			const allEntry = allDaysMap.get(dateKey)!;
			allEntry.tokens += tokForDay;
			allEntry.sessions++;
			addModelUsage(allEntry.modelUsage, scaledUsage);
			const editor = data.editorSource;
			if (!allEntry.editorUsage[editor]) {
				allEntry.editorUsage[editor] = { tokens: 0, sessions: 0 };
			}
			allEntry.editorUsage[editor].tokens += tokForDay;
			allEntry.editorUsage[editor].sessions++;
			if (!allEntry.editorModelUsage) { allEntry.editorModelUsage = {}; }
			if (!allEntry.editorModelUsage[editor]) { allEntry.editorModelUsage[editor] = {}; }
			addModelUsage(allEntry.editorModelUsage[editor], scaledUsage);
		}
	}

	const labels = Array.from(dailyMap.keys()).sort();
	const days = labels.map(l => dailyMap.get(l)!);
	return { labels, days, allDaysMap };
}

/** Environmental impact constants export for use in commands */
export { ENVIRONMENTAL } from './constants';

/** Model pricing data export */
export { modelPricing, tokenEstimators, toolNameMap };

/** Cache lifecycle — re-export for use in commands */
export { loadCache, saveCache, disableCache, getCacheStats } from './cliCache';
