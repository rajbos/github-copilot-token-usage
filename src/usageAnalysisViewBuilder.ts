/**
 * Assembles the Usage Analysis view's payload (`window.__INITIAL_USAGE__`, and the
 * `updateStats` message's `data`) from already-computed usage-analysis stats.
 *
 * This is the one place that payload is built: the VS Code extension, the CLI
 * (`usage-analysis --json`, `all --json`, which Visual Studio and JetBrains render) and
 * the desktop app all call {@link buildUsageAnalysisViewData}. They differ only in how
 * they gather the stats (the extension's `calculateUsageAnalysisStats()` vs the CLI's
 * `buildUsageAnalysisStats()`) and in host settings passed as
 * {@link UsageAnalysisViewInputs}. A host adds only fields that exist in that host alone
 * (the extension's API balance and account budgets, column settings, worktree scans).
 * Keeping assembly here is what stops a field the view needs from reaching one host and
 * not the others (see #2304, #2316, #2418).
 *
 * Pure: no `vscode`, no filesystem, no caching.
 */
import { toMemoryFilesAnalysisView } from './copilotMemoryFiles';
import { evaluateUsageInsights, type EvaluatedInsight, type InsightEvaluationState } from './insightsEngine';
import type {
	AutomaticCompactionStats,
	ClaudeDesktopCoverage,
	CorrectionReport,
	MemoryFilesAnalysisView,
	MissedPotentialWorkspace,
	RepeatedTaskReport,
	TodaySessionSummary,
	ToolCurationAnalysis,
	UsageAnalysisPeriod,
	UsageAnalysisStats,
	WorkspaceCustomizationMatrix,
} from './types';

/** Host settings and host-held state the payload carries. */
export interface UsageAnalysisViewInputs {
	/** Locale the view formats numbers and dates in. */
	locale: string;
	backendConfigured: boolean;
	/**
	 * Whether the Dark Factory readiness tab can be shown. Its checks run against the
	 * open workspace through extension-only commands, so only the extension passes true.
	 */
	readinessAvailable: boolean;
	/** Folders open in the host; empty for hosts without a workspace. */
	currentWorkspacePaths: string[];
	hideAutomaticToolCalls: boolean;
	use24HourTime: boolean;
	suppressedUnknownTools: string[];
	/** Translator and persisted insight state; stateless hosts pass only `translate`. */
	insights: InsightEvaluationState;
}

/** The payload fields every host sends. */
export interface UsageAnalysisViewData {
	today: UsageAnalysisPeriod;
	last30Days: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	lastMonth: UsageAnalysisPeriod;
	autoCompactionsLast7Days: AutomaticCompactionStats | undefined;
	locale: string;
	customizationMatrix: WorkspaceCustomizationMatrix | null;
	missedPotential: MissedPotentialWorkspace[];
	lastUpdated: string;
	backendConfigured: boolean;
	readinessAvailable: boolean;
	currentWorkspacePaths: string[];
	suppressedUnknownTools: string[];
	toolCallsByEditor: NonNullable<UsageAnalysisStats['toolCallsByEditor']>;
	todaySessions: TodaySessionSummary[];
	/**
	 * Last 7 / last 30 days / current month session buckets. Part of the shared payload: the
	 * view seeds its Recent Sessions tabs from it, and a host without the extension's
	 * `recentSessionsLoaded` round-trip (the desktop app) would otherwise stay on "Loading…".
	 * Undefined when the host's stats carry none.
	 */
	recentSessions: UsageAnalysisStats['recentSessions'];
	claudeDesktopCoverage: ClaudeDesktopCoverage | null;
	use24HourTime: boolean;
	hideAutomaticToolCalls: boolean;
	insights: EvaluatedInsight[];
	correctionReport: CorrectionReport | null;
	repeatedTasks: RepeatedTaskReport | null;
	curationAnalysis: ToolCurationAnalysis | null;
	memoryFilesAnalysis: MemoryFilesAnalysisView | null;
}

/** Every key {@link buildUsageAnalysisViewData} emits; tests pin hosts against it. */
export const USAGE_ANALYSIS_VIEW_KEYS: ReadonlyArray<keyof UsageAnalysisViewData> = [
	'today', 'last30Days', 'month', 'lastMonth', 'autoCompactionsLast7Days', 'locale',
	'customizationMatrix', 'missedPotential', 'lastUpdated', 'backendConfigured',
	'readinessAvailable', 'currentWorkspacePaths', 'suppressedUnknownTools', 'toolCallsByEditor',
	'todaySessions', 'recentSessions', 'claudeDesktopCoverage', 'use24HourTime', 'hideAutomaticToolCalls',
	'insights', 'correctionReport', 'repeatedTasks', 'curationAnalysis', 'memoryFilesAnalysis',
];

export function buildUsageAnalysisViewData(stats: UsageAnalysisStats, inputs: UsageAnalysisViewInputs): UsageAnalysisViewData {
	return {
		today: stats.today,
		last30Days: stats.last30Days,
		month: stats.month,
		lastMonth: stats.lastMonth,
		autoCompactionsLast7Days: stats.autoCompactionsLast7Days,
		locale: inputs.locale,
		customizationMatrix: stats.customizationMatrix ?? null,
		missedPotential: stats.missedPotential ?? [],
		lastUpdated: stats.lastUpdated.toISOString(),
		backendConfigured: inputs.backendConfigured,
		readinessAvailable: inputs.readinessAvailable,
		currentWorkspacePaths: inputs.currentWorkspacePaths,
		suppressedUnknownTools: inputs.suppressedUnknownTools,
		toolCallsByEditor: stats.toolCallsByEditor ?? {},
		todaySessions: stats.todaySessions ?? [],
		recentSessions: stats.recentSessions,
		claudeDesktopCoverage: stats.claudeDesktopCoverage ?? null,
		use24HourTime: inputs.use24HourTime,
		hideAutomaticToolCalls: inputs.hideAutomaticToolCalls,
		insights: evaluateUsageInsights(stats, inputs.insights),
		correctionReport: stats.correctionReport ?? null,
		repeatedTasks: stats.repeatedTasks ?? null,
		curationAnalysis: stats.curationAnalysis ?? null,
		memoryFilesAnalysis: toMemoryFilesAnalysisView(stats.memoryFilesAnalysis ?? null),
	};
}
