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
import type { CustomizationFileEntry, DailyTokenStats, DetailedStats, SessionUsageAnalysis, UsageAnalysisStats, WorkspaceCustomizationMatrix, TodaySessionSummary } from '../../src/types';
import { analyzeSessionUsage, mergeUsageAnalysis } from '../../src/usageAnalysis';
import { activeSessionDays, addSessionToDailyStats, sortedDailyStats, sessionLocFromUsageAnalysis } from '../../src/statsHelpers';
import { resolveSessionTaskAttribution } from '../../src/taskClassification';
import { createSessionAttributesCache, resolveSessionAttributes, type SessionAttributesCache } from '../../src/sessionRepository';
import { addSessionEfficiencyToDailyStats } from '../../src/modelEfficiency';
import { EFFICIENCY_BEHAVIOR_WEEKS, toEfficiencySessionInput } from '../../src/efficiencyViewBuilder';
import type { EfficiencySessionInput } from '../../src/efficiencyAnalysis';
import { calculateEnvironmentalImpact } from '../../src/environmentalImpact';
import { withErrorRecovery, withErrorRecoverySync } from '../../src/utils/errors';
import { buildRecentSessionBuckets, type RecentSessionBucketItem } from '../../src/recentSessions';
import { groupWorkspaces, groupFolders, type WorkspaceGroup, type WorkspaceGroupingProbes, type WorkspaceUsageEntry } from '../../src/workspaceGrouping';
import { buildWorkspaceCustomization, type WorkspaceCustomization } from '../../src/customizationMatrix';
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
export type { SessionData } from './analysis';
export { effectiveTokens, buildChartPayload, buildEfficiencyPayload, fmt, formatTokens } from './analysis';

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
export async function resolveSessionWorkspace(activity: SessionActivityLookup, claudeBasePath: string): Promise<{ path: string; repository?: string } | undefined> {
	const meta = await activity.meta();
	// The adapter's own workspace first; then Copilot CLI events.jsonl, discovered by its adapter
	// but not handled by it (so getMeta() knows nothing), whose adjacent workspace.yaml the adapter
	// still reads through this hook; then the Claude Code JSONL / VS Code chatSessions fallbacks.
	const workspacePath = meta?.workspacePath
		?? await findWorkspacePathForDiscoveredPath(getEcosystems(), activity.file)
		?? await resolveSessionWorkspacePath(activity.file, claudeBasePath);
	if (!workspacePath) { return undefined; }
	// The adapter's recorded remote, else the workspace folder's own repository (walking up for a
	// sub-folder workspace) — the same shared rule as the extension's analysis, for adapter-backed
	// and VS Code sessions alike; never a referenced file, which can live in another repository.
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

/** The CLI's customization files for one folder: the instruction files that exist in it. */
function instructionFilesIn(folder: string): CustomizationFileEntry[] {
	return withErrorRecoverySync(
		// Same case-insensitive resolution as the shared customization scanner, so the CLI
		// accepts every spelling the extension does (including on case-sensitive filesystems).
		() => INSTRUCTION_PATHS.flatMap(rel => {
			const found = resolveExactWorkspacePath(folder, rel, true);
			return found === undefined ? [] : [{
				path: found, relativePath: rel, type: CLI_INSTRUCTIONS_TYPE.id, icon: CLI_INSTRUCTIONS_TYPE.icon,
				label: CLI_INSTRUCTIONS_TYPE.label, name: path.basename(found), lastModified: null, isStale: false,
				category: 'copilot' as const,
			}];
		}),
		[],
		`buildWorkspaceCustomization workspace check(${folder})`
	);
}

/**
 * The Usage Analysis view's `customizationMatrix` and `missedPotential` for these sessions,
 * assembled by the shared `buildWorkspaceCustomization()` (src/customizationMatrix.ts) the
 * extension uses.
 *
 * - For VS Code sessions: derives workspace folder from workspaceStorage/<hash>/workspace.json.
 * - For Claude Code sessions (~/.claude/projects/<hash>/): reads the JSONL to extract the
 *   `cwd` workspace path.
 *
 * Folders are then grouped with the shared `groupWorkspaces()` (src/workspaceGrouping.ts) — the
 * same rules the VS Code extension uses — so worktrees and clones of one repository count once.
 *
 * Only the inputs differ from the extension: instead of the full customization-pattern scan (a
 * recursive directory walk per workspace, too slow for hosts that wait on the CLI with a
 * timeout) the CLI checks for AGENTS.md, CLAUDE.md and .github/copilot-instructions.md, as one
 * "Instructions" column. It does not look for non-Copilot files, so `missedPotential` is empty.
 */
export async function buildWorkspaceCustomizationForSessions(
	sessionFiles: string[],
	probes?: WorkspaceGroupingProbes,
	now: Date = new Date(),
): Promise<WorkspaceCustomization | undefined> {
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
	const byPath = new Map<string, WorkspaceGroup>(groups.map(g => [g.canonicalPath, g]));
	return buildWorkspaceCustomization({
		customizationTypes: [CLI_INSTRUCTIONS_TYPE],
		workspaces: groups.map(group => ({ path: group.canonicalPath, sessionCount: group.sessionCount, interactionCount: group.interactionCount, group })),
		// A group is customized when any of its folders is, like the extension's merged group scan.
		filesFor: (workspacePath) => {
			const group = byPath.get(workspacePath);
			return group ? groupFolders(group).flatMap(instructionFilesIn) : [];
		},
	});
}

/** The customization matrix alone, for fluency scoring. See {@link buildWorkspaceCustomizationForSessions}. */
export async function buildCustomizationMatrix(
	sessionFiles: string[],
	probes?: WorkspaceGroupingProbes,
	now: Date = new Date(),
): Promise<WorkspaceCustomizationMatrix | undefined> {
	return (await buildWorkspaceCustomizationForSessions(sessionFiles, probes, now))?.customizationMatrix;
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
 * A session's version for the view caches (the shared analysis memo and the enriched session
 * entry). For a file it is the file's stat. A DB-backed (virtual) session is stat'ed through its
 * shared database, whose mtime moves for every other session in it and may not move at all while
 * this session's writes sit in the WAL, so its adapter-reported last-activity time is part of
 * the version too: a write to this session invalidates its view data even when the database
 * mtime has not moved.
 */
export interface SessionVersion {
	mtimeMs: number;
	size: number;
	/** DB-backed sessions only: the adapter's last-activity time for this session, when known. */
	activityMs?: number;
}

export async function sessionVersion(
	filePath: string,
	stats: { mtimeMs: number; size: number },
	lastActivity: () => Promise<Date | null> = () => getSessionLastActivity(filePath),
): Promise<SessionVersion> {
	const base = { mtimeMs: stats.mtimeMs, size: stats.size };
	if (getSessionBackingPath(filePath) === filePath) { return base; }
	const last = await lastActivity().catch(() => null);
	return last ? { ...base, activityMs: last.getTime() } : base;
}

function sameSessionVersion(a: SessionVersion, b: SessionVersion): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size && a.activityMs === b.activityMs;
}

/** Completed analyses kept for reuse; bounded because a long-lived host (the desktop app) walks many files. */
const ANALYSIS_MEMO_LIMIT = 1000;
const analysisMemo = new Map<string, Promise<{ analysis: SessionUsageAnalysis; failed: boolean }>>();

/**
 * analyzeSessionUsage() for one file version, shared by every caller in this process.
 *
 * The view enrichment (processSessionFileForViews) and calculateUsageAnalysisStats() both need
 * the full analysis of recent sessions, and `cli all` / the desktop Efficiency build run them
 * together. The session cache only stores the slim enriched data, so without this each recent
 * session would be analyzed twice. Keyed by path + mtime + size, so a changed file is analyzed
 * afresh; concurrent callers share one in-flight pass. Completed results are kept only while
 * the session cache is enabled (`--no-cache` means uncached), and a failed analysis is never
 * kept, so the next caller retries it.
 */
function analyzeSessionUsageShared(
	filePath: string,
	version: SessionVersion | undefined,
	content?: string,
): Promise<{ analysis: SessionUsageAnalysis; failed: boolean }> {
	const key = version ? `${filePath}\0${version.mtimeMs}\0${version.size}\0${version.activityMs ?? ''}` : undefined;
	const hit = key ? analysisMemo.get(key) : undefined;
	if (key && hit) {
		// Refresh its recency so the bound evicts the least recently used entry.
		analysisMemo.delete(key);
		analysisMemo.set(key, hit);
		return hit;
	}
	let failed = false;
	const run = analyzeSessionUsage(
		{ warn, onAnalysisError: () => { failed = true; }, tokenEstimators, modelPricing, toolNameMap, ecosystems: getEcosystems() },
		filePath,
		content,
	).then(analysis => ({ analysis, failed }));
	if (key) {
		analysisMemo.set(key, run);
		while (analysisMemo.size > ANALYSIS_MEMO_LIMIT) {
			const oldest = analysisMemo.keys().next().value;
			if (oldest === undefined) { break; }
			analysisMemo.delete(oldest);
		}
		const forget = () => { if (analysisMemo.get(key) === run) { analysisMemo.delete(key); } };
		run.then(r => { if (r.failed || !getCacheStats().enabled) { forget(); } }, forget);
	}
	return run;
}

/**
 * The per-session fields the Chart and Efficiency views split by (repository, task category,
 * lines of code, efficiency signals), derived through the same shared helpers the extension's
 * session analyzer and details pass use.
 *
 * Returns `null` when the analysis failed. analyzeSessionUsage() swallows read, parser and
 * adapter errors and returns an empty analysis, signalling them through `deps.onAnalysisError`.
 * An empty result from a failed read must not be marked resolved and cached, or the session
 * would show no task/LOC/efficiency data until it changes. Plain `deps.warn` notices (a
 * sub-step that failed, an unexpected format) leave a valid analysis and are not failures.
 * Likewise a repository that could not be resolved (unreadable file) is a failure, while a
 * session that names no repository resolves to `''` and is recorded as "Unknown".
 */
async function sessionViewAttributes(filePath: string, version: SessionVersion | undefined, walkCache?: SessionAttributesCache): Promise<Pick<SessionData, 'repository' | 'taskCategory' | 'taskCategoryShares' | 'linesAdded' | 'linesRemoved' | 'languageUsage' | 'usageAnalysis'> | null> {
	try {
		// Read a file-based session once and hand the content to both passes; ecosystem
		// (DB-backed) sessions are read through their adapter instead. A failed read throws
		// here and is reported as a failure below.
		const ecosystems = getEcosystems();
		const content = ecosystems.some(e => e.handles(filePath)) ? undefined : await fs.promises.readFile(filePath, 'utf-8');
		const [{ analysis, failed }, sessionAttributes] = await Promise.all([
			analyzeSessionUsageShared(filePath, version, content),
			resolveSessionAttributes(ecosystems, filePath, content, walkCache),
		]);
		if (failed || sessionAttributes === undefined) { return null; }
		const { repository, title } = sessionAttributes;
		return {
			...(repository ? { repository } : {}),
			// With the session title, as the extension's analyzer passes it, so the heuristic
			// fallback (sessions whose analysis classified no turns) agrees across hosts.
			...resolveSessionTaskAttribution(analysis, title),
			...sessionLocFromUsageAnalysis(analysis),
			usageAnalysis: {
				...(analysis.modelEfficiency ? { modelEfficiency: analysis.modelEfficiency } : {}),
				...(analysis.sessionDuration ? { sessionDuration: analysis.sessionDuration } : {}),
				...(analysis.applyUsage ? { applyUsage: analysis.applyUsage } : {}),
				...(analysis.skillCalls ? { skillCalls: analysis.skillCalls } : {}),
				...(analysis.editScope ? { editScope: analysis.editScope } : {}),
			},
		};
	} catch {
		return null;
	}
}

/** The session's parse without any view attributes from an earlier (now outdated) enrichment. */
function withoutViewAttributes(data: SessionData): SessionData {
	const {
		repository: _repository, taskCategory: _taskCategory, taskCategoryShares: _taskCategoryShares,
		linesAdded: _linesAdded, linesRemoved: _linesRemoved, languageUsage: _languageUsage,
		usageAnalysis: _usageAnalysis, viewAttributesResolved: _resolved, viewActivityMs: _activity,
		...base
	} = data;
	return base;
}

/**
 * {@link processSessionFile} plus the view attributes (task category, lines of code, efficiency
 * signals) the Chart and Efficiency payloads need.
 *
 * The attributes cost a full usage-analysis pass, so they are added lazily here rather than in
 * processSessionFile(): token-only commands (`usage`, `environmental`, the prompt segment) keep
 * the lean parse. The enriched entry is written back to the session cache, so each session is
 * analyzed at most once per file version.
 *
 * Like every other cache write here, the entry is keyed by the stat taken *before* reading the
 * file. The base parse and the analysis are two reads, so the file is stat'ed again afterwards
 * and the entry is only cached when nothing changed in between — otherwise an actively-written
 * session would store data parsed from an older version under the newer mtime. A failed
 * analysis is neither marked resolved nor cached, so the next run retries it.
 */
export async function processSessionFileForViews(filePath: string, verbose = false, walkCache?: SessionAttributesCache): Promise<SessionData | null> {
	let before: SessionVersion | undefined;
	try { before = await sessionVersion(filePath, await statSessionFile(filePath)); } catch { /* processSessionFile reports the failure */ }
	let data = await processSessionFile(filePath, verbose);
	if (!data) { return data; }
	// A DB-backed session's entry is keyed by the shared database's stat, so it is only current
	// while the session's own activity time still matches what it was derived for (see
	// sessionVersion). That covers the base parse too: a write still in the WAL leaves the
	// database stat unchanged, so the cached tokens, interactions, model usage and day split can
	// be as outdated as the view attributes. Re-parse without reading the cache before enriching,
	// rather than merging fresh attributes onto a stale parse.
	if (before?.activityMs !== undefined && data.viewActivityMs !== before.activityMs) {
		data = await processSessionFileWith(filePath, { verbose, cache: { get: () => null, set: setCached } });
		if (!data) { return data; }
	}
	if (data.viewAttributesResolved && data.viewActivityMs === before?.activityMs) { return data; }
	const attributes = await sessionViewAttributes(filePath, before, walkCache);
	const base = withoutViewAttributes(data);
	if (!attributes) { return base; }
	const enriched: SessionData = {
		...base, ...attributes, viewAttributesResolved: true,
		...(before?.activityMs !== undefined ? { viewActivityMs: before.activityMs } : {}),
	};
	try {
		const after = await sessionVersion(filePath, await statSessionFile(filePath));
		if (before && sameSessionVersion(before, after)) {
			setCached(filePath, before.mtimeMs, before.size, enriched);
		}
	} catch {
		// Not cacheable (file vanished): still return the enriched data for this run.
	}
	return enriched;
}

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
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const last30DaysStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
	const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const cutoffStart = recentAnalysisCutoff(now);

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

			// The session's own activity time. A DB-backed session's file mtime can lag its real
			// activity (writes still in the SQLite WAL), so when the mtime alone says "older than
			// the window" the adapter's last-activity time is asked — the rule the Chart/Efficiency
			// view walk uses too (isSessionActiveSince), so the Efficiency view combines the same
			// sessions from both. The lookup reads the adapter at most once per session and is
			// reused below; regular files are decided by their mtime with no lookup.
			const activity = createSessionActivityLookup(file);
			const activeAt = await sessionActivityTime(activity, modified);
			if (activeAt < cutoffStart) { continue; }

			// Shared with the view enrichment, so `cli all` and the desktop Efficiency build do not
			// analyze each recent session twice.
			const { analysis } = await analyzeSessionUsageShared(file, await sessionVersion(file, stats, () => activity.lastActivity()));
			if (options.includeRepeatedTasks) {
				await addRepeatedTaskSource(repeatedTaskSources, activity, analysis.firstUserPrompt, stats.mtimeMs, cutoffStart);
			}
			// Period stats bucket by the same activity time.
			let sessionSummary: TodaySessionSummary | undefined;
			const data = activeAt >= last30DaysStart ? await processSessionFile(file) : undefined;
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
					// The same activity time the period buckets use, so a WAL-backed session
					// counted in today's totals is also shown, and bucketed, as active today.
					lastActivity: activeAt.toISOString(),
					...(analysis.sessionDuration?.totalDurationMs !== undefined ? { durationMs: analysis.sessionDuration.totalDurationMs } : {}),
					...(analysis.sessionDuration?.activeDurationMs !== undefined ? { activeDurationMs: analysis.sessionDuration.activeDurationMs } : {}),
				};
				recentSessionItems.push({
					activityKey: toLocalDayKey(activeAt),
					interactions: data.interactions,
					value: sessionSummary,
				});
			}

			if (activeAt >= last30DaysStart) {
				mergeUsageAnalysis(last30DaysPeriod, analysis);
				last30DaysPeriod.sessions++;
			}
			if (activeAt >= monthStart) {
				mergeUsageAnalysis(monthPeriod, analysis);
				monthPeriod.sessions++;
			}
			if (activeAt >= todayStart) {
				mergeUsageAnalysis(todayPeriod, analysis);
				todayPeriod.sessions++;
				if (sessionSummary) { todaySessions.push(sessionSummary); }
			}
			if (activeAt >= lastMonthStart && activeAt < monthStart) {
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
	/** A DB-backed (virtual) session, stat'ed through a database shared with other sessions. */
	readonly isVirtual: boolean;
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
	const isVirtual = sources.getBackingPath(file) !== file;
	const lookup: SessionActivityLookup = {
		file,
		isVirtual,
		meta: () => (meta ??= sources.getMeta(file)),
		lastActivity: () => (lastActivity ??= (async () => {
			// Regular files: the file mtime is the session's own; no adapter lookup needed.
			if (!isVirtual) { return null; }
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

/** Thrown by {@link calculateViewStats} when its caller cancelled the walk. */
export class ViewStatsCancelledError extends Error {
	constructor() {
		super('View stats walk cancelled');
		this.name = 'ViewStatsCancelledError';
	}
}

/**
 * The Chart and Efficiency views' session-derived inputs, from **one** walk over the files.
 *
 * Both need every session's enriched parse (processSessionFileForViews). Walking twice would
 * parse and analyze each cold session twice — the session cache cannot be relied on to absorb
 * that, since it holds a bounded number of entries and has no in-flight de-duplication.
 *
 * `isCancelled` lets a long-lived host stop the walk when nobody is waiting for it any more
 * (the desktop app, when the user leaves Chart/Efficiency): once it returns true the remaining
 * files are skipped and the walk throws {@link ViewStatsCancelledError} instead of returning a
 * partial result, so nothing incomplete is cached.
 */
export async function calculateViewStats(sessionFiles: string[], verbose = false, weeksBack = EFFICIENCY_BEHAVIOR_WEEKS, options: { isCancelled?: () => boolean } = {}): Promise<{
	dailyStats: DailyTokenStats[];
	efficiencySessionInputs: EfficiencySessionInput[];
}> {
	// Latched: once any check sees cancellation, the walk stays cancelled. The caller's predicate
	// can flip back (the user returns to Chart before the walk ends), and files skipped while it
	// was true must not be returned — or cached — as a complete history.
	let cancelled = false;
	const isCancelled = () => (cancelled ||= options.isCancelled?.() ?? false);
	if (isCancelled()) { throw new ViewStatsCancelledError(); }
	const walkCache = createSessionAttributesCache();
	const sessions = await runWithConcurrency(sessionFiles, async (file) => (isCancelled() ? null : processSessionFileForViews(file, verbose, walkCache)));
	if (isCancelled()) { throw new ViewStatsCancelledError(); }
	return {
		dailyStats: dailyStatsFromSessions(sessions),
		efficiencySessionInputs: efficiencyInputsFromSessions(sessions, weeksBack),
	};
}

/**
 * Start of the window Usage Analysis analyzes: the start of last month or 30 days ago,
 * whichever is earlier.
 */
export function recentAnalysisCutoff(now: Date = new Date()): Date {
	const last30DaysStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
	const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	return lastMonthStart < last30DaysStart ? lastMonthStart : last30DaysStart;
}

export interface DailyStatsOptions {
	/**
	 * Only sessions modified since this date get the view enrichment (repository, task
	 * category, lines of code, efficiency signals); older ones use the lean parse, whose
	 * tokens, models and editors are still exact. Omit it to enrich the whole history.
	 *
	 * The enrichment costs a usage-analysis pass and a repository lookup per session, and
	 * the session cache is bounded, so on a large history a full walk repeats on every new
	 * process. Hosts that wait on a CLI command with a timeout (`all --json` for Visual
	 * Studio) pass {@link recentAnalysisCutoff}: those sessions are analyzed for Usage
	 * Analysis anyway, and the analysis is shared, so the extra cost is bounded.
	 */
	enrichSince?: Date;
}

/**
 * Process session files into per-day stats over the whole history, in the
 * `DailyTokenStats[]` shape the shared `buildChartData()` takes. Aggregation goes through
 * the shared `addSessionToDailyStats()` — see AGENTS.md, "CLI Must Reuse Shared Functions".
 * Use {@link calculateViewStats} when the Efficiency inputs are needed too.
 */
export async function calculateDailyStats(sessionFiles: string[], verbose = false, options: DailyStatsOptions = {}): Promise<DailyTokenStats[]> {
	const walkCache = createSessionAttributesCache();
	return dailyStatsFromSessions(await runWithConcurrency(sessionFiles, async (file) => processSessionFileWithinWindow(file, verbose, options.enrichSince, walkCache)));
}

/** The view parse for a session modified since `enrichSince` (or always, without it), else the lean parse. */
async function processSessionFileWithinWindow(filePath: string, verbose: boolean, enrichSince: Date | undefined, walkCache: SessionAttributesCache): Promise<SessionData | null> {
	if (enrichSince) {
		let modified: Date | undefined;
		try { modified = (await statSessionFile(filePath)).mtime; } catch { /* processSessionFile reports it */ }
		if (!modified || !(await isSessionActiveSince(createSessionActivityLookup(filePath), modified, enrichSince))) {
			return processSessionFile(filePath, verbose);
		}
	}
	return processSessionFileForViews(filePath, verbose, walkCache);
}

/**
 * A session's own last-activity time. A regular file's mtime is its own. A DB-backed (virtual)
 * session shares its database's mtime, which moves whenever any session in it changes (and may
 * lag its own writes in the SQLite WAL), so it is judged by its own adapter-reported activity —
 * the rule sessionActiveSince() documents — even when the database mtime is recent: otherwise
 * one write would admit and date every historical session in that database. Only when the
 * adapter reports nothing does the database mtime stand in, so such sessions still count as
 * they did before. One rule for Usage Analysis and the Chart/Efficiency view walk, so the
 * Efficiency view combines the same sessions from both.
 */
export async function sessionActivityTime(activity: Pick<SessionActivityLookup, 'lastActivity' | 'isVirtual'>, fileMtime: Date): Promise<Date> {
	if (!activity.isVirtual) { return fileMtime; }
	return (await activity.lastActivity()) ?? fileMtime;
}

/** Whether a session was active since `cutoff`, by {@link sessionActivityTime}; regular files need no lookup. */
export async function isSessionActiveSince(activity: Pick<SessionActivityLookup, 'lastActivity' | 'isVirtual'>, fileMtime: Date, cutoff: Date): Promise<boolean> {
	if (!activity.isVirtual) { return fileMtime >= cutoff; }
	return (await sessionActivityTime(activity, fileMtime)) >= cutoff;
}

function dailyStatsFromSessions(sessions: Array<SessionData | null | undefined>): DailyTokenStats[] {
	const dailyStatsMap = new Map<string, DailyTokenStats>();
	for (const data of sessions) {
		if (!data || data.tokens === 0 || data.interactions === 0) { continue; }
		addSessionToDailyStats(dailyStatsMap, {
			editorType: data.editorSource,
			repository: data.repository,
			tokens: effectiveTokens(data),
			interactions: data.interactions,
			modelUsage: data.modelUsage,
			dailyFractions: data.dailyFractions,
			taskCategory: data.taskCategory,
			taskCategoryShares: data.taskCategoryShares,
			linesAdded: data.linesAdded,
			linesRemoved: data.linesRemoved,
			languageUsage: data.languageUsage,
		});
		addSessionEfficiencyToDailyStats(dailyStatsMap, {
			editorType: data.editorSource,
			modelUsage: data.modelUsage,
			dailyFractions: data.dailyFractions,
			linesAdded: data.linesAdded,
			linesRemoved: data.linesRemoved,
			usageAnalysis: data.usageAnalysis,
		}, modelPricing);
	}
	return sortedDailyStats(dailyStatsMap);
}

/**
 * Per-session inputs for the Efficiency view's behaviour trends over the trailing
 * `weeksBack` weeks — the Node-side counterpart of the extension's
 * collectEfficiencySessionInputs(). Use {@link calculateViewStats} when the daily stats are
 * needed too, so the files are walked once.
 */
export async function calculateEfficiencySessionInputs(sessionFiles: string[], weeksBack = EFFICIENCY_BEHAVIOR_WEEKS): Promise<EfficiencySessionInput[]> {
	const walkCache = createSessionAttributesCache();
	return efficiencyInputsFromSessions(await runWithConcurrency(sessionFiles, async (file) => processSessionFileForViews(file, false, walkCache)), weeksBack);
}

function efficiencyInputsFromSessions(sessions: Array<SessionData | null | undefined>, weeksBack: number): EfficiencySessionInput[] {
	const now = new Date();
	const cutoffKey = toLocalDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - weeksBack * 7));
	const inputs: EfficiencySessionInput[] = [];
	for (const data of sessions) {
		if (!data || data.interactions === 0) { continue; }
		// The session's last active day, as the extension derives it from its daily rollups.
		const dayKey = activeSessionDays(data.dailyFractions).at(-1)?.[0] ?? toLocalDayKey(data.lastModified);
		if (dayKey < cutoffKey) { continue; }
		inputs.push(toEfficiencySessionInput(data, dayKey, data.editorSource));
	}
	return inputs;
}

/** Environmental impact constants export for use in commands */
export { ENVIRONMENTAL } from './constants';

/** Model pricing data export */
export { modelPricing, tokenEstimators, toolNameMap };

/** Cache lifecycle — re-export for use in commands */
export { loadCache, saveCache, disableCache, getCacheStats } from './cliCache';
