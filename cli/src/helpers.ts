/**
 * Shared helper functions for CLI commands.
 * Handles session file discovery, parsing, and stats aggregation.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { SessionDiscovery } from '../../src/sessionDiscovery';
import type { IEcosystemAdapter } from '../../src/ecosystemAdapter';
import { resolveExactWorkspacePath } from '../../src/workspaceHelpers';
import { resolveFileUri } from '../../src/workspacePathResolver';
import { calculateEstimatedCost } from '../../src/tokenEstimation';
import { toLocalDayKey } from '../../src/utils/dayKeys';
import type { DetailedStats, UsageAnalysisStats, WorkspaceCustomizationMatrix, TodaySessionSummary } from '../../src/types';
import { analyzeSessionUsage, mergeUsageAnalysis } from '../../src/usageAnalysis';
import { addModelUsage, scaleModelUsage } from '../../src/statsHelpers';
import { calculateEnvironmentalImpact } from '../../src/environmentalImpact';
import { withErrorRecovery } from '../../src/utils/errors';
import { buildRecentSessionBuckets, type RecentSessionBucketItem } from '../../src/recentSessions';
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

/**
 * Builds a WorkspaceCustomizationMatrix from session file paths.
 *
 * - For VS Code sessions: derives workspace folder from workspaceStorage/<hash>/workspace.json,
 *   then checks for AGENTS.md, CLAUDE.md, or .github/copilot-instructions.md.
 * - For Claude Code sessions (~/.claude/projects/<hash>/): reads the JSONL to extract the
 *   `cwd` workspace path, then checks for CLAUDE.md there.
 */
export async function buildCustomizationMatrix(sessionFiles: string[]): Promise<WorkspaceCustomizationMatrix | undefined> {
	const workspacePaths = new Set<string>();
	const claudeBasePath = path.join(os.homedir(), '.claude', 'projects');

	for (const sessionFile of sessionFiles) {
		// Claude Code session: ~/.claude/projects/<hash>/<uuid>.jsonl
		if (sessionFile.startsWith(claudeBasePath + path.sep) || sessionFile.startsWith(claudeBasePath + '/')) {
			const content = await withErrorRecovery(
				() => fs.promises.readFile(sessionFile, 'utf-8'),
				null,
				`buildCustomizationMatrix readFile(${sessionFile})`
			);
			if (content !== null) {
				const lines = content.split('\n').slice(0, 30);
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						if (event.cwd && typeof event.cwd === 'string') {
							workspacePaths.add(event.cwd);
							break;
						}
					} catch { /* skip malformed lines */ }
				}
			}
			continue;
		}

		// VS Code session: .../workspaceStorage/<hash>/chatSessions/<file>
		const chatSessionsDir = path.dirname(sessionFile);
		if (path.basename(chatSessionsDir) !== 'chatSessions') { continue; }
		const hashDir = path.dirname(chatSessionsDir);
		const workspaceJsonPath = path.join(hashDir, 'workspace.json');

		const workspaceJson = await readJsonFile<{ folder?: string }>(workspaceJsonPath);
		if (!workspaceJson) { continue; }
		const folderUri: string | undefined = workspaceJson.folder;
		if (!folderUri || !folderUri.startsWith('file://')) { continue; }

		const folderPath = resolveFileUri(folderUri);
		if (folderPath) { workspacePaths.add(folderPath); }
	}

	if (workspacePaths.size === 0) { return undefined; }

	let workspacesWithIssues = 0;
	for (const wsPath of workspacePaths) {
		const hasIssues = await withErrorRecovery(
			async () => {
				// Same case-insensitive resolution as the shared customization scanner, so the CLI
				// accepts every spelling the extension does (including on case-sensitive filesystems).
				const instructionPaths = [
					'.github/copilot-instructions.md',
					'AGENTS.md',
					'CLAUDE.md',
					'.claude/CLAUDE.md',
				];
				return !instructionPaths.some(p => resolveExactWorkspacePath(wsPath, p, true) !== undefined);
			},
			true,
			`buildCustomizationMatrix workspace check(${wsPath})`
		);
		if (hasIssues) { workspacesWithIssues++; }
	}

	return {
		customizationTypes: [],
		workspaces: [],
		totalWorkspaces: workspacePaths.size,
		workspacesWithIssues,
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
