// --- Node.js built-ins & VS Code ---
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';

// Localization support (key-based resolver over package.nls*.json — see l10n.ts
// for why vscode.l10n.t() cannot be used directly with key-based strings)
import { t as l10nT, resolvedLocale } from './l10n';
import { buildWebviewLocalization } from './webviewLocalization';
const l10n = { t: l10nT };

// --- JSON data files ---
import tokenEstimatorsData from '../../src/tokenEstimators.json';
import modelPricingData from '../../src/modelPricing.json';
import toolNamesData from '../../src/toolNames.json';
import builtinCommandDescriptionsData from '../../src/builtinCommandDescriptions.json';
import automaticToolsData from '../../src/automaticTools.json';
import customizationPatternsData from '../../src/customizationPatterns.json';
import copilotPlansData from './copilotPlans.json';
import * as packageJson from '../package.json';
import { getToolFamilies, DEFAULT_TOOL_FAMILIES } from './toolFamilies';
import { getEditorIconByName } from './editorIcons';
import * as loadingHtml from './loadingHtml';

// --- Core types ---
import type {
  TokenUsageStats,
  ModelUsage,
  ModelEfficiencyUsage,
  ModelId,
  ModelPricing,
  EditorUsage,
  RepositoryUsage,
  PeriodStats,
  DetailedStats,
  DailyTokenStats,
  DailyModelEfficiency,
  ChartDataPayload,
  ChartTimeWindow,
  SessionFileCache,
  CustomizationFileEntry,
  SessionUsageAnalysis,
  ToolCallUsage,
  ModeUsage,
  ContextReferenceUsage,
  McpToolUsage,
  EditScopeUsage,
  ApplyButtonUsage,
  SessionDurationData,
  ConversationPatterns,
  AgentTypeUsage,
  ModelSwitchingAnalysis,
  MissedPotentialWorkspace,
  UsageAnalysisStats,
  TodaySessionSummary,
  ClaudeDesktopCoverage,
  CustomizationTypeStatus,
  WorkspaceCustomizationRow,
  WorkspaceCustomizationMatrix,
  UsageAnalysisPeriod,
  AgenticTrendPoint,
  DarkFactoryReport,
  SessionFileDetails,
  PromptTokenDetail,
  ActualUsage,
  ChatTurn,
  SessionLogData,
  WorkspaceCustomizationSummary,
  AgentSessionsResult,
  TokenEstimator,
  SessionRelationRef,
  EvaluatedInsight,
  InsightStateBag,
  ToolCurationAnalysis,
  CorrectionCounts,
  CorrectionReport,
  CorrectionRepoGroup,
  CorrectionSessionEntry,
  RepeatedTaskReport,
  MemoryFilesAnalysis,
  ServerMemoriesAnalysis,
  ServerMemoriesAnalysisView,
} from '../../src/types';
import {
	ensureContextPressure,
	hasContextSignal,
	mergeDbContextPressure,
	mergeSessionContextPressure,
	sessionCompactionEvents,
	indexSessionsByCliUuid,
	applyDbContextToSession,
	applyDbContextToIndexedSessions,
} from './contextPressure';
import { getTimeWindowStartDate, getTimeWindowStartDayKey } from '../../src/timeWindows';

// --- Correction-moment detection (per-repo report over recent sessions) ---
import {
  createEmptyCorrectionCounts as _createEmptyCorrectionCounts,
  mergeCorrectionCounts as _mergeCorrectionCounts,
  summarizeCorrectionMoments as _summarizeCorrectionMoments,
  buildCorrectionImprovementPrompt as _buildCorrectionImprovementPrompt,
} from '../../src/correctionDetection';

// --- Repeated-task detection (skill candidates from recurring prompts) ---
import {
  buildRepeatedTaskReport as _buildRepeatedTaskReport,
  repoDisplayName as _repoDisplayName,
} from '../../src/repeatedTasks';

// --- Tool curation ---
import {
  enumerateRuntimeTools as _enumerateRuntimeTools,
  enumerateExtensionMcpServers as _enumerateExtensionMcpServers,
  buildMcpEntriesFromJson as _buildMcpEntriesFromJson,
  buildMcpEntriesFromSettings as _buildMcpEntriesFromSettings,
  discoverSkillEntries as _discoverSkillEntries,
  analyzeToolCuration as _analyzeToolCuration,
  findSkillDescriptionInWorkspaces as _findSkillDescriptionInWorkspaces,
} from '../../src/toolCuration';

// --- Copilot memory files (hygiene analysis) ---
import {
  discoverAllMemoryFiles as _discoverAllMemoryFiles,
  analyzeMemoryFiles as _analyzeMemoryFiles,
  toMemoryFilesAnalysisView as _toMemoryFilesAnalysisView,
} from '../../src/copilotMemoryFiles';

/**
 * Minimum time between memory-files filesystem scans (readdirSync/statSync across every
 * VS Code User root and workspace hash). Memory file hygiene changes slowly, so reusing a
 * recent scan avoids repeating a synchronous filesystem walk on every uncached recompute
 * (e.g. periodic Usage Analysis refreshes while the panel is open).
 */
const MEMORY_FILES_SCAN_TTL_MS = 5 * 60 * 1000;

// --- Copilot server-side repository memories ---
import {
  fetchRepoMemories as _fetchRepoMemories,
  analyzeServerMemories as _analyzeServerMemories,
  parseRepoFromRemoteUrl as _parseRepoFromRemoteUrl,
  toServerMemoriesAnalysisView as _toServerMemoriesAnalysisView,
  createRepoFileExists as _createRepoFileExists,
} from '../../src/copilotServerMemories';
import { readGitOriginUrl as _readGitOriginUrl, isGitRepoRoot as _isGitRepoRoot } from '../../src/darkFactorySignals';

/**
 * Minimum time between reads of a repository's server-side memory store.
 *
 * Far longer than {@link MEMORY_FILES_SCAN_TTL_MS} because this one costs a network round
 * trip to GitHub rather than a local filesystem walk, and a memory store only changes when
 * a coding-agent run stores something — on the order of hours, not minutes.
 */
const SERVER_MEMORIES_FETCH_TTL_MS = 60 * 60 * 1000;

/**
 * How long the silent GitHub session lookup may take before it is treated as "no session".
 *
 * A local, non-prompting call, so this is generous only to avoid flapping on a busy host —
 * its job is to make sure a stalled auth provider cannot leave the in-flight guard set and
 * silently disable the section for the rest of the session.
 */
const SERVER_MEMORIES_AUTH_TIMEOUT_MS = 10 * 1000;

/**
 * VS Code's built-in **public** GitHub authentication provider.
 *
 * Named separately from `getGitHubAuthProviderId()`, which resolves to `github-enterprise`
 * when `github-enterprise.uri` is set. The memory feature is pinned to public GitHub at both
 * ends — it only parses github.com remotes and only calls api.githubcopilot.com — so it must
 * not pick up an Enterprise token that was never issued for that host.
 */
const PUBLIC_GITHUB_AUTH_PROVIDER_ID = 'github';

// --- Insights engine ---
import type { TaskCategory, TaskCategoryBreakdown } from '../../src/taskClassification';
import {
  evaluateInsights as _evaluateInsights,
  mergeInsightStates as _mergeInsightStates,
  countNewInsights as _countNewInsights,
  isToastAllowed as _isToastAllowed,
} from './insightsEngine';

// --- Worktree background scan (once-daily, leader-only disk-usage scan) ---
import {
  shouldRunDailyWorktreeScan as _shouldRunDailyWorktreeScan,
  shouldNotifyWorktreeFindings as _shouldNotifyWorktreeFindings,
  formatBytesForNotification as _formatBytesForNotification,
  sumWorktreeBytes as _sumWorktreeBytes,
  parseCleanupPushedWorktreesMessage as _parseCleanupPushedWorktreesMessage,
  buildCleanupConfirmTitle as _buildCleanupConfirmTitle,
  validateWorktreeRepoRootFromSessionPaths as _validateWorktreeRepoRootFromSessionPaths,
  type WorktreeBackgroundScanResult,
} from './worktreeBackgroundScan';
import { scanWorktreeRootsWithTimeout as _scanWorktreeRootsWithTimeout } from './worktreeScan';

// --- Ecosystem adapter types & helpers ---
import type { OpenCodeDataAccess } from '../../src/opencode';
import type { CrushDataAccess } from '../../src/crush';
import type { VisualStudioDataAccess } from '../../src/visualstudio';
import type { ContinueDataAccess } from '../../src/continue';
import type { ClaudeCodeDataAccess } from '../../src/claudecode';
import type { ClaudeDesktopDataAccess } from '../../src/claudedesktop';
import type { MistralVibeDataAccess } from '../../src/mistralvibe';
import type { GeminiCliDataAccess } from '../../src/geminicli';
import type { IEcosystemAdapter } from '../../src/ecosystemAdapter';
import type { CopilotCliAdapter } from '../../src/adapters/copilotCliAdapter';
import { WindsurfDataAccess } from '../../src/windsurf';
import { getEcosystemDisplayName } from '../../src/ecosystemAdapter';
import { buildAdapterRegistry, createDataAccessInstances } from '../../src/adapters';
import { CopilotAppDataAccess, type SessionContextWindow } from './copilotAppData';
import { PiDataAccess } from '../../src/pi';
import { HermesDataAccess } from '../../src/hermes';
import { getVSCodeUserPaths } from '../../src/adapters/copilotChatAdapter';
import { isJetBrainsSessionPath } from '../../src/adapters/adapterPredicates';
import { detectJetBrainsModelHintFromContent } from '../../src/jetbrains';
import { analyzeHydraFusionSession, aiuToUsd } from '../../src/hydrafusion';
import type { HydraFusionSummary } from '../../src/hydrafusion';
import { extractCopilotCliSessionId, getCopilotCliExactUsage, getCopilotCliOtelStatus, getCopilotCliOtelUsage, loadCopilotCliOtelIndex, setCopilotCliOtelSnapshotPath, setCopilotCliOtelLogger } from '../../src/copilotCliOtel';
import { createWorkerOtelLookup, type WorkerOtelLookup } from './otelIndexLookup';
import { createWakeupGate, createSemaphore, yieldToEventLoop, TimeoutError as _TimeoutError, withTimeout as _withTimeout, type Semaphore } from './utils/promises';
import { WebviewMessageReplay } from './webviewMessageReplay';
import { startEventLoopMonitor, type EventLoopMonitor } from './utils/eventLoopMonitor';
import {
	analyzeSessionFile as _analyzeSessionFile,
	supplementCacheWithDebugLog as _supplementCacheWithDebugLog,
	quickAnalyzeSessionContent as _quickAnalyzeSessionContent,
	toUsageAnalysisDeps,
	type SessionAnalyzerDeps,
} from './analysis/sessionFileAnalyzer';
import { AnalysisWorkerPool } from './analysis/analysisWorkerPool';
import { runOffHostThread as _runOffHostThread } from './analysis/runOffHostThread';
import { computeSessionFileDetails as _computeSessionFileDetails } from './analysis/sessionDetailsAnalyzer';
import { scanCustomizationFilesForWorkspace as _scanCustomizationFilesForWorkspace } from './analysis/workspaceCustomizationScan';

// --- Session parsing & token estimation ---
import {
  estimateTokensFromText as _estimateTokensFromText,
  estimateTokensFromJsonlSession as _estimateTokensFromJsonlSession,
  extractPerRequestUsageFromRawLines as _extractPerRequestUsageFromRawLines,
  getModelFromRequest as _getModelFromRequest,
  isCopilotAutoRequest,
  attachEstimatedTurnCosts,
  isJsonlContent as _isJsonlContent,
  isUuidPointerFile as _isUuidPointerFile,
  applyDelta as _applyDelta,
  getModelTier as _getModelTier,
  calculateEstimatedCost as _calculateEstimatedCost,
  createEmptyContextRefs as _createEmptyContextRefs,
  getTotalTokensFromModelUsage as _getTotalTokensFromModelUsage,
  reconstructJsonlStateAsync as _reconstructJsonlStateAsync,
  extractSubAgentData as _extractSubAgentData,
  buildReasoningEffortTimeline as _buildReasoningEffortTimeline,
  extractTtftSamplesFromDebugLog as _extractTtftSamplesFromDebugLog,
  extractResponseItemText as _extractResponseItemText,
  type TtftSample,
} from '../../src/tokenEstimation';
import { SessionDiscovery } from '../../src/sessionDiscovery';

// --- Cache ---
import { CacheManager } from './cacheManager';
import { isFullCacheHit, isDetailsOnlyPlaceholder, resolveFullResultAgainstCurrent } from './detailsOnlyCache';
import { sweepStaleWalTempFiles } from '../../src/utils/sqliteWal';
import { HookManager } from './hookManager';

// --- Usage analysis ---
import {
  mergeUsageAnalysis as _mergeUsageAnalysis,
  analyzeContextReferences as _analyzeContextReferences,
  analyzeContentReferences as _analyzeContentReferences,
  analyzeVariableData as _analyzeVariableData,
  deriveConversationPatterns as _deriveConversationPatterns,
  analyzeRequestContext as _analyzeRequestContext,
  calculateModelSwitching as _calculateModelSwitching,
  trackEnhancedMetrics as _trackEnhancedMetrics,
  mergeModelEfficiencyTokens as _mergeModelEfficiencyTokens,
  type UsageAnalysisDeps,
} from '../../src/usageAnalysis';
import { createEmptyTaskClassificationResult } from '../../src/taskClassification';
import {
  accumulateDayAndEditorModelTokens as _accumulateDayAndEditorModelTokens,
  accumulateDayAndEditorModelCounters as _accumulateDayAndEditorModelCounters,
  buildSessionEfficiencyAttribution as _buildSessionEfficiencyAttribution,
} from '../../src/modelEfficiency';
import { calculateEnvironmentalImpact, getEnvironmentalMethodologySourceUrl } from '../../src/environmentalImpact';

// --- Efficiency analysis ---
import {
  buildEfficiencyTrends as _buildEfficiencyTrends,
  buildSkillUsageTrends as _buildSkillUsageTrends,
  computeCostAttribution as _computeCostAttribution,
  computeEfficiencyDeltas as _computeEfficiencyDeltas,
  computeSkillImpact as _computeSkillImpact,
  listComparableModels as _listComparableModels,
  listEfficiencyEditors as _listEfficiencyEditors,
  resolveEfficiencyRange as _resolveEfficiencyRange,
  splitModelDayByEditor as _splitModelDayByEditor,
  computeValueSignals as _computeValueSignals,
  getTrailingWindowBoundaries as _getTrailingWindowBoundaries,
  splitTrailingWindows as _splitTrailingWindows,
  toEfficiencyDailyVolume as _toEfficiencyDailyVolume,
  type EfficiencyDailyVolume,
  type EfficiencyDeps,
  type EfficiencySessionInput,
  type EfficiencyViewData,
  type ModelDailyInput,
  type PeriodVolumeTotals,
  valueSignalsEqual as _valueSignalsEqual,
  type ValueSignals,
  type ValueSignalsInput,
} from '../../src/efficiencyAnalysis';

/**
 * Weeks of session logs walked for the Efficiency view's behavioural inputs
 * (duration, retries, applies, skills). Shorter than the year of daily volume
 * aggregates because it costs a full session-file scan — longer time presets
 * therefore show behavioural gaps rather than invented values.
 */
const EFFICIENCY_BEHAVIOR_WEEKS = 12;

import { DARK_FACTORY_CACHE_KEY, isReportStale, parseCacheEntry, readinessScopeKey, scanDarkFactoryReadiness } from './darkFactoryService';

// --- Maturity & fluency scoring ---
import {
  getFluencyLevelData as _getFluencyLevelData,
  calculateFluencyScoreForTeamMember as _calculateFluencyScoreForTeamMember,
  calculateMaturityScores as _calculateMaturityScores,
  STAGE_THRESHOLDS,
} from '../../src/maturityScoring';

// --- Workspace helpers ---
import {
  parseWorkspaceStorageJsonFile as _parseWorkspaceStorageJsonFile,
  extractWorkspaceIdFromSessionPath as _extractWorkspaceIdFromSessionPath,
  resolveWorkspaceFolderFromSessionPath as _resolveWorkspaceFolderFromSessionPath,
  resolveWorkspaceFolderWithFallback as _resolveWorkspaceFolderWithFallback,
  globToRegExp as _globToRegExp,
  resolveExactWorkspacePath as _resolveExactWorkspacePath,
  getModeType as _getModeType,
  extractCustomAgentName as _extractCustomAgentName,
  getEditorTypeFromPath as _getEditorTypeFromPath,
  getEditorNameFromRoot as _getEditorNameFromRoot,
  getRepoDisplayName as _getRepoDisplayName,
  detectEditorSource as _detectEditorSource,
  parseGitRemoteUrl as _parseGitRemoteUrl,
  resolveSessionWorkspaceName as _resolveSessionWorkspaceName,
  isMcpTool as _isMcpTool,
  normalizeMcpToolName as _normalizeMcpToolName,
  extractMcpServerName as _extractMcpServerName,
  normalizePath as _normalizePath,
  normalizePathForDedup as _normalizePathForDedup,
  dedupeByNormalizedKeyKeepGreatest as _dedupeByNormalizedKeyKeepGreatest,
  normalizeToRepoRoot as _normalizeToRepoRoot,
  resolveDebugLogCandidatePaths as _resolveDebugLogCandidatePaths,
} from '../../src/workspaceHelpers';
import { getRepositoryUrl as _getRepositoryUrl } from './repositoryUrl';

// --- Chart building ---
import { buildChartData as _buildChartData, getBillingGroup, getPricingSourceForBillingGroup, getPricingSourceForEditor } from '../../src/chartDataBuilder';

// --- Time-to-first-token analysis ---
import { buildTtftBuckets as _buildTtftBuckets, buildTtftModelSeries as _buildTtftModelSeries, type TtftGranularity } from '../../src/ttftAnalysis';

/** How far back the Research > TTFT tab's scan-range picker looks for session files; 'all' skips the mtime filter entirely. */
type TtftScanRange = '14d' | '30d' | '90d' | '180d' | '365d' | 'all';
const TTFT_SCAN_RANGE_DAYS: Record<Exclude<TtftScanRange, 'all'>, number> = { '14d': 14, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };
/** Resolves a scan-range picker value to a lookback window in ms, or null for 'all' (no mtime filter). */
function ttftScanRangeToMs(range: unknown): number | null {
	if (range === 'all') { return null; }
	const key = (typeof range === 'string' && Object.prototype.hasOwnProperty.call(TTFT_SCAN_RANGE_DAYS, range)) ? (range as Exclude<TtftScanRange, 'all'>) : '14d';
	return TTFT_SCAN_RANGE_DAYS[key] * 24 * 60 * 60 * 1000;
}

// --- Task classification ---
import { countDelegationToolCalls } from '../../src/taskClassification';

// --- Stats helpers ---
import { addModelUsage, addEditorUsage, addLanguageUsage, computeUtcDateRanges, aggregatePeriodStats, makePeriodAccumulator, computeSessionTotalTokens, computeSessionDurationMs, reconcileModelUsageToTotal, type SessionAggregateInput } from '../../src/statsHelpers';
import { preferActualTokens, addTaskCategoryToDailyEntry as _addTaskCategoryToDailyEntry } from '../../src/statsHelpers';

// --- GitHub & agent sessions ---
import {
	detectAiType,
	discoverGitHubRepos,
	fetchRepoPrs,
	fetchCopilotPlanInfo,
	fetchCopilotTokenEndpointInfo,
	fetchUserEnterprises,
	fetchEnterprisePremiumBudgets,
	fetchPrCopilotReviewActivity,
	type CopilotPlanInfo,
	type RepoPrDetail,
	type RepoPrInfo,
	type RepoPrStatsResult,
} from './githubPrService';
import { computeApiBalance, fetchAllAccountBudgets, formatAccountBudgetLines, type AccountBudget } from './githubAccountBudgets';
import { collectAgentSessions } from './agentSessionsService';
import {
	AGENT_TASKS_CACHE_SCHEMA_VERSION,
	AGENT_TASKS_REFRESH_INTERVAL_MS,
	canServeAgentTasksSnapshot,
	getAgentTasksCachePath,
	isAgentTasksEnvelopeUsable,
	readAgentTasksSnapshot,
	writeAgentTasksSnapshot,
} from './agentTasksCache';
import {
	REPO_PRS_CACHE_SCHEMA_VERSION,
	REPO_PRS_REFRESH_INTERVAL_MS,
	canServeRepoPrSnapshot,
	getRepoPrCachePath,
	isRealRepoPrSnapshot,
	isRepoPrEnvelopeUsable,
	shouldPublishRepoPrStats,
	readRepoPrSnapshot,
	shouldPreserveRepoPrSnapshotForEmptyDiscovery,
	writeRepoPrSnapshot,
} from './repoPrCache';
import { getConfiguredGitHubEnterpriseUri, getConfiguredGitHubWebOrigin, getGitHubAuthProviderId } from './githubApiConfig';

// --- View regression ---
import {
  createViewRegressionProbeScript,
  evaluateViewRegressionProbe,
  formatLocalViewRegressionReport,
  type LocalViewRegressionMetric,
  type LocalViewRegressionResult,
  type ViewRegressionExpectation,
  type ViewRegressionProbeConfig,
  type ViewRegressionProbeSnapshot,
} from './viewRegression';
// --- Backend & UI ---
import type { AiFluencyExtensionApi, ExtensionPointButton } from './extensionPoints';
import { REPO_HYGIENE_SKILL } from './backend/repoHygieneSkill';
import { deferWhileApplyingSettings } from './backend/settingsBatch';
import { BackendFacade } from './backend/facade';
import { BackendCommandHandler } from './backend/commands';
import { TeamServerConfigPanel } from './backend/teamServerConfigPanel';
import { getModelDisplayName } from '../../src/webview/shared/modelUtils';
import { ConfirmationMessages } from './backend/ui/messages';

// --- Utilities ---
import { insightCardElementId } from './insightAnchors';
import { getNonce, buildCspMeta, getCodiconStylesheetTag } from './utils/webviewUtils';
import { getAzureTableStorageEndpoint } from './utils/azureEndpoints';
import { isGuidMcpTool, isKnownToolDisplayName, isMcpFamilyResolvedTool, lookupKnownToolName } from '../../src/utils/toolUtils';
import { toLocalDayKey } from '../../src/utils/dayKeys';
import { buildRecentSessionBuckets as bucketRecentSessions, collectSessionModelIds } from '../../src/recentSessions';
import { determineOnboardingAction } from './onboarding';
import { mergeNotifiedEditors, mergeSeenEditors } from './editorDiscovery';
import { TtftScanResultCache } from './ttftAnalysisCache';
import {
	WHATS_NEW_RELEASES,
	WHATS_NEW_MAX_RELEASES,
	findFeature,
	type FeatureSurface,
	type FeatureViewId,
	type WhatsNewFeature,
	type WhatsNewRelease,
} from './whatsNew/catalog';
import {
	EMPTY_WHATS_NEW_STATE,
	planAnnouncement,
	reconcileVersion,
	sanitizeState,
	type WhatsNewState,
} from './whatsNew/announcer';
import { hasVisitedSince, recordVisit, sanitizeVisits, type ViewVisitMap } from './whatsNew/visits';
import { findViewIndexEntry, type ViewIndexNavigation } from './whatsNew/viewIndex';
import { SurfaceRevealQueue } from './whatsNew/surfaceRevealQueue';
import { toolCallsByEditorToRecord } from './webview/usage/toolEditors';

type LocalViewRegressionProbeResult = {
  pass: boolean;
  summary: string;
  timedOut?: boolean;
  metrics?: ViewRegressionProbeSnapshot;
};

type LocalViewRegressionCase = {
  id: string;
  title: string;
  timeoutMs: number;
  expectations: ViewRegressionExpectation;
  dataPoints: LocalViewRegressionMetric[];
  reset: () => void;
  open: () => Promise<void>;
};

/** Pre-loaded session file data shared across both analysis passes (detailed + usage analysis). */
type SessionFilePreload = {
	sessionFile: string;
	mtime: number;
	fileSize: number;
	sessionData: SessionFileCache;
	wasCached: boolean;
	/** Only populated for files with interactions > 0 (avoids fetching details for empty sessions). */
	details?: SessionFileDetails;
};

export type StatusBarDisplaySetting = 'none' | 'today' | 'last30days' | 'currentMonth' | 'both' | 'todayAndCurrentMonth';

/**
 * Determines which secondary period section to show in the hover tooltip.
 * Returns 'last30days' if either setting explicitly requests a rolling 30-day window
 * (i.e. 'last30days' or 'both'), preserving backwards-compatible behaviour.
 * Otherwise returns 'currentMonth' so users who opted into current-month views
 * see a consistent tooltip.
 */
export function tooltipSecondaryPeriod(
	tokensSetting: StatusBarDisplaySetting,
	costSetting: StatusBarDisplaySetting,
): 'last30days' | 'currentMonth' {
	const usesLast30 = (s: StatusBarDisplaySetting) => s === 'last30days' || s === 'both';
	return usesLast30(tokensSetting) || usesLast30(costSetting) ? 'last30days' : 'currentMonth';
}

/** Sums per-provider costs into a total-across-all-providers figure. */
export function defaultSumBillingGroupCosts(billingGroupCosts: Record<string, number> | undefined): number {
	return Object.values(billingGroupCosts ?? {}).reduce((s, v) => s + v, 0);
}

/** Whether Git refused to remove a worktree because it contains initialized submodules. */
export function isSubmoduleWorktreeRemovalFailure(stderr: string): boolean {
	return /working trees containing submodules cannot be moved or removed/i.test(stderr);
}

/** Whether Git reached directory deletion but the operating system rejected that step. */
export function isWorktreeDirectoryRemovalFailure(stderr: string): boolean {
	return /failed to (delete|remove) '.*'/i.test(stderr);
}

/** Forces Git's machine-parsed diagnostics to English regardless of the user's display locale. */
export function getLocaleStableGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...environment, LC_ALL: 'C', LANG: 'C' };
}

type WorktreeRemovalResult = { ok: boolean; stderr: string };

type WorktreeForceConfirmation = (
	message: string,
	options: { modal: true; detail: string },
	action: string,
) => PromiseLike<string | undefined>;

/**
 * Requests explicit confirmation before retrying a submodule-blocked removal with --force.
 * Keeping the destructive retry behind this injectable boundary makes the decline/confirm
 * behavior executable in unit tests instead of relying on source-order assertions.
 */
export async function retrySubmoduleWorktreeRemovalWithConfirmation(
	worktreePath: string,
	result: WorktreeRemovalResult,
	confirm: WorktreeForceConfirmation,
	forceRemove: () => Promise<WorktreeRemovalResult>,
	removeDirectoryFallback: () => Promise<WorktreeRemovalResult>,
): Promise<WorktreeRemovalResult | undefined> {
	if (result.ok || !isSubmoduleWorktreeRemovalFailure(result.stderr)) { return result; }

	const forceDelete = l10n.t('worktree.forceDelete');
	const forceChoice = await confirm(
		l10n.t('worktree.submoduleForcePrompt', worktreePath),
		{ modal: true, detail: l10n.t('worktree.submoduleForceDetail') },
		forceDelete,
	);
	if (forceChoice !== forceDelete) { return undefined; }
	const forcedResult = await forceRemove();
	if (
		!forcedResult.ok
		&& (isWorktreeDirectoryRemovalFailure(forcedResult.stderr) || isSubmoduleWorktreeRemovalFailure(forcedResult.stderr))
	) {
		return removeDirectoryFallback();
	}
	return forcedResult;
}

/** The computed-stat caches that carry a generation stamp. */
export type ComputedStatsKey = 'detailed' | 'daily' | 'fullDaily' | 'usage' | 'sessionInputs' | 'memoryFiles';

/**
 * Whether a computed-stat cache stamped at `stampedGeneration` may still be read.
 *
 * The stamp is the cache generation in effect when the computation that produced the value
 * *started*, not when it finished, and that distinction is the whole point. A build already
 * running when the caches are cleared finishes afterwards and assigns its result — data
 * derived from the pre-clear session cache — so the presence of a value proves nothing about
 * whether it survived the clear. Stamping at the start makes such a result carry the old
 * generation, and this rejects it. An unstamped cache (`undefined`) is never current.
 */
export function isComputedStatsCurrent(
	stampedGeneration: number | undefined,
	currentGeneration: number,
): boolean {
	return stampedGeneration === currentGeneration;
}

/**
 * Whether a previous memory-files filesystem scan (readdirSync/statSync across every VS
 * Code User root and workspace hash) may be reused instead of re-walking the filesystem.
 *
 * `lastScannedAt` of `undefined` means no scan has ever completed, so it is never reusable.
 * Otherwise the cached result is reusable while `now - lastScannedAt` is still within
 * `ttlMs`, throttling a synchronous filesystem walk that would otherwise repeat on every
 * uncached recompute (e.g. periodic Usage Analysis refreshes while the panel is open).
 */
export function isMemoryFilesScanFresh(
	lastScannedAt: number | undefined,
	now: number,
	ttlMs: number,
): boolean {
	return lastScannedAt !== undefined && (now - lastScannedAt) < ttlMs;
}

/** Inputs to {@link decideServerMemoriesRefresh}, all read from tracker state at call time. */
export interface ServerMemoriesRefreshInputs {
	/** The `serverMemories.enabled` setting. */
	enabled: boolean;
	/** `owner/name` the workspace currently resolves to, or undefined for a non-GitHub folder. */
	currentRepo: string | undefined;
	/** Checkout root the workspace currently resolves to. */
	currentRepoRoot: string | undefined;
	/** `owner/name` the cached analysis belongs to. */
	cachedRepo: string | undefined;
	/**
	 * Checkout root the cached analysis was computed against. Part of the identity because
	 * the stale-citation counts are file-existence results from *that* tree: two worktrees of
	 * one repository share a slug but not their working files.
	 */
	cachedRepoRoot: string | undefined;
	/** When the cached analysis was stored. */
	fetchedAt: number | undefined;
	/** Whether a fetch is already running. */
	fetchInFlight: boolean;
	now: number;
	ttlMs: number;
}

/**
 * Decide what a server-memories refresh pass should do, kept pure so the ordering rules can
 * be tested without a workspace, a network or a VS Code host — the same reason
 * {@link isMemoryFilesScanFresh} exists.
 *
 * The ordering is the whole point, and two orderings that look equivalent are not:
 *
 *  - **The repository is resolved before anything else is consulted.** The TTL answers "is
 *    *this repository's* store still fresh?", so checking it first lets a workspace switch
 *    keep showing the previous repository's memories until the hour elapses.
 *  - **A stale repository is cleared even while a fetch is in flight.** Returning early on
 *    the in-flight guard leaves the previous repository's analysis in place, so it keeps
 *    being rendered until that request *and* a later refresh both finish. Whether we may
 *    start a new request is a separate question from whether what we are showing is still
 *    the right repository's.
 */
export function decideServerMemoriesRefresh(input: ServerMemoriesRefreshInputs): { clearCache: boolean; startFetch: boolean } {
	// Switching the feature off must hide what was already fetched, not merely stop fetching.
	if (!input.enabled) { return { clearCache: true, startFetch: false }; }
	// A non-GitHub folder has no store to show, including any left over from a folder that did.
	if (!input.currentRepo) { return { clearCache: true, startFetch: false }; }

	const moved = input.cachedRepo !== undefined
		&& (input.cachedRepo !== input.currentRepo || input.cachedRepoRoot !== input.currentRepoRoot);
	// Drop the old context's result now; only the fetch itself has to wait for a free slot.
	if (moved) { return { clearCache: true, startFetch: !input.fetchInFlight }; }

	if (input.fetchInFlight) { return { clearCache: false, startFetch: false }; }
	const fresh = input.cachedRepo === input.currentRepo
		&& input.cachedRepoRoot === input.currentRepoRoot
		&& input.fetchedAt !== undefined
		&& (input.now - input.fetchedAt) < input.ttlMs;
	return { clearCache: false, startFetch: !fresh };
}

/** The verified output of one refresh pass, as handed to publishRefreshResult(). */
interface RefreshPublication {
	detailedStats: DetailedStats;
	dailyStats: DailyTokenStats[];
	preloaded: SessionFilePreload[];
	silent: boolean;
	isLeader: boolean;
}

/** The minimum of a webview panel this module needs in order to post to it. */
export interface PostablePanel { webview: { postMessage(msg: object): unknown } }

/**
 * A loading-screen sink that reports to whichever panel is live at send time, and drops
 * everything when none is.
 *
 * `getLive` is read per message rather than captured, so a build that outlives the panel that
 * started it keeps reporting to the panel the user is actually looking at. That is only sound
 * where at most one producer can be running — see `efficiencyLoadingSink()`, whose builds are
 * serialized — and it governs the loading screen only: rendering a *result* into a panel still
 * needs its own identity check, because a result belongs to the build that asked for it.
 */
export function makeLivePanelSink<P extends PostablePanel>(
	getLive: () => P | undefined,
): (msg: object) => void {
	return (msg: object) => {
		const live = getLive();
		if (!live) { return; }
		void live.webview.postMessage(msg);
	};
}

/**
 * Queues `build` behind `previous` so only one runs at a time.
 *
 * Returns the caller's result separately from the chain the next caller should queue behind.
 * The two differ in their failure handling on purpose: the result rejects so the caller can
 * render a failure, while the chain always resolves, so one failed build does not wedge every
 * build queued after it.
 */
export function chainBuild<T>(
	previous: Promise<unknown>,
	build: () => Promise<T>,
): { result: Promise<T>; chain: Promise<void> } {
	const result = previous.then(build, build);
	return { result, chain: result.then(() => undefined, () => undefined) };
}

/**
 * Keeps the per-model efficiency counters when a refreshed day replaces an
 * enriched one.
 *
 * The routine refresh path builds its days through `statsHelpers`'
 * `addToDailyEntry`, which computes volume but not `modelEfficiency` /
 * `editorModelEfficiency` — those come only from the fuller
 * `calculateDailyStats()` pass. Replacing the day wholesale therefore
 * stripped the newest days of exactly the data the Models tab and its editor
 * filter read, emptying recent comparisons after the first background
 * refresh. Carrying the counters forward keeps them at their last computed
 * value instead of dropping them; the next full pass recomputes them.
 *
 * The carried counters are therefore as old as the last full pass: a day whose
 * sessions changed since (a new session, a re-run with a different model, a
 * deleted log) keeps the previous pass's per-model split until that next full
 * pass. Volume — tokens, sessions, interactions, the per-editor split — always
 * comes from the refreshed day and is never carried. Bounded staleness on a
 * secondary breakdown beats the empty Models tab that dropping the field
 * produced.
 */
function carryForwardEnrichedFields(previous: DailyTokenStats | undefined, refreshed: DailyTokenStats): DailyTokenStats {
	if (!previous) { return refreshed; }
	if (!refreshed.modelEfficiency && previous.modelEfficiency) { refreshed.modelEfficiency = previous.modelEfficiency; }
	if (!refreshed.editorModelEfficiency && previous.editorModelEfficiency) { refreshed.editorModelEfficiency = previous.editorModelEfficiency; }
	return refreshed;
}

/**
 * Merges `incoming` day rows into the full-year `current` array, or refuses the merge.
 *
 * The destination's own stamp is not enough. `current` comes from a generation-guarded
 * accessor, so it is by construction current — but the rows being merged *into* it carry a
 * generation of their own, and a run that started before a clear can reach here after a
 * post-clear build has already repopulated the destination at the new generation. Merging
 * then splices pre-clear rows into a current-stamped array and leaves the stamp untouched,
 * so later reads accept the mixture as fully current. That is worse than no guard at all:
 * the scheme actively certifies corrupted data. Refusing the merge leaves the destination
 * holding only post-clear rows, which is what the clear asked for.
 *
 * Returns `undefined` when there is nothing to merge into or the input is superseded, so the
 * caller leaves the destination untouched rather than writing a partial result.
 */
export function mergeDailyStatsIntoFullYear(
	current: DailyTokenStats[] | undefined,
	incoming: DailyTokenStats[],
	originGeneration: number,
	currentGeneration: number,
): DailyTokenStats[] | undefined {
	if (!current) { return undefined; }
	if (!isComputedStatsCurrent(originGeneration, currentGeneration)) { return undefined; }
	const fullMap = new Map(current.map(d => [d.date, d]));
	for (const day of incoming) { fullMap.set(day.date, carryForwardEnrichedFields(fullMap.get(day.date), day)); }
	return Array.from(fullMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Decides what one automatic Efficiency-rebuild request should do.
 *
 * `requestedFor` collapses two requests raised at the same generation. It cannot see the build
 * queue, though, and a build sitting in that queue captures the live generation at the moment
 * it starts running — so its result already answers an invalidation raised before it started.
 * Close/reopen queues an initial build, `clearCache()` bumps the generation and asks for a
 * rebuild, and without `queuedBuilds` that rebuild runs a second full-year walk immediately
 * behind a queued build that was already going to produce post-clear data.
 *
 * A build that is already *running* counts only when it captured this same generation — see
 * `runningFor`. An earlier draft assumed a running build always captured an *older* one and could
 * never satisfy the invalidation, which is false: `clearCache()` bumps the generation and only
 * then awaits `updateTokenStats()`, so a build starting inside that await captures the *bumped*
 * generation, takes `queuedBuilds` back to zero on its way in, and is still running when the
 * rebuild is finally requested. Counting queued builds alone then starts a second full-year walk
 * behind a running build that was already going to produce exactly that payload. A running build
 * at an older generation still does not count: its result will be discarded.
 */
export function planEfficiencyRebuild(
	requestedFor: number | undefined,
	currentGeneration: number,
	queuedBuilds: number,
	completedFor?: number,
	runningFor?: number,
): 'start' | 'coalesce-onto-queued' | 'coalesce-onto-running' | 'already-built' | 'already-requested' {
	if (requestedFor === currentGeneration) { return 'already-requested'; }
	// A build that already *finished* at this generation answers the invalidation just as well as
	// one still queued. clearCache() requests its rebuild only after awaiting updateTokenStats(),
	// which is long enough for a queued build to start (dropping `queuedBuilds` to zero), capture
	// the bumped generation and complete — after which counting queued builds alone would start a
	// second full-year walk over data that is already current.
	if (completedFor === currentGeneration) { return 'already-built'; }
	if (queuedBuilds > 0) { return 'coalesce-onto-queued'; }
	return runningFor === currentGeneration ? 'coalesce-onto-running' : 'start';
}

/**
 * The document language for a webview's `<html lang>`.
 *
 * Every view in this file renders localized text — a localized `<title>`, localized headings, or a
 * `localization` payload the view bundle renders from — so a hardcoded `lang="en"` tells assistive
 * technology to announce translated text with English pronunciation rules.
 *
 * Derived from the bundle that actually serves those strings, not from `vscode.env.language`:
 * `l10n.t()` falls back to the English bundle for every language without a
 * `package.nls.<locale>.json`, so on a French or Brazilian-Portuguese install the rendered text is
 * English and `lang="fr"` would be the same mismatch pointing the other way. `resolvedLocale()`
 * returns a LOCALE_BUNDLES id or `en`, a closed set of compile-time constants, so the value is
 * safe to interpolate into the quoted attribute.
 */
export function webviewDocumentLanguage(vscodeLanguage: string | undefined): string {
	return resolvedLocale((vscodeLanguage ?? '').trim());
}

/**
 * Computes the figures for the Copilot Budget gauge row: total spend against budget
 * (locally-tracked usage plus any usage the Copilot API reports that this device has no
 * local session data for) and how much budget remains. Folding the untracked gap into the
 * headline total keeps the "$X / $Y" figure consistent with the bar's percentage, so a
 * reader doesn't have to subtract the untracked sub-row themselves to find out how much
 * budget is actually left — that figure is rendered as its own sub-row.
 */
export function computeCopilotBudgetDisplay(
	copilotCost: number,
	budget: number,
	apiUsedUsd: number | null,
): { totalUsed: number; remaining: number; trackedRatio: number; gapRatio: number; gapUsd: number } {
	const gapUsd = apiUsedUsd !== null ? Math.max(0, apiUsedUsd - copilotCost) : 0;
	const totalUsed = copilotCost + gapUsd;
	const remaining = budget - totalUsed;
	const trackedRatio = budget > 0 ? copilotCost / budget : 0;
	const gapRatio = budget > 0 ? gapUsd / budget : 0;
	return { totalUsed, remaining, trackedRatio, gapRatio, gapUsd };
}

/**
 * Labels for the indented sub-rows rendered under the "🎯 Copilot Budget" gauge row, in order.
 *
 * Each figure gets its own short line rather than being crammed into one: the tracked and
 * untracked amounts used to share a single "$X tracked here + $Y untracked (other
 * devices/cloud)" row that wrapped mid-parenthetical, and remaining budget used to be appended
 * to the gauge row itself, where "$X / $Y · $Z left" pushed that row onto a second line too.
 * Remaining budget is always listed; the tracked/untracked split only when there is a gap
 * worth a cent to split.
 */
export function buildCopilotBudgetSubRowLabels(copilotCost: number, remaining: number, gapUsd: number): string[] {
	const labels: string[] = [];
	if (gapUsd > 0.005) {
		labels.push(l10n.t('tooltip.budgetTrackedHere', `$${copilotCost.toFixed(2)}`));
		labels.push(l10n.t('tooltip.budgetUntracked', `$${gapUsd.toFixed(2)}`));
	}
	labels.push(remaining >= 0
		? l10n.t('tooltip.budgetRemaining', `$${remaining.toFixed(2)}`)
		: l10n.t('tooltip.budgetOverBy', `$${Math.abs(remaining).toFixed(2)}`));
	return labels;
}

/**
 * Trailing spacer appended to every non-final cell of the hover tooltip's Markdown tables.
 *
 * VS Code renders tooltip Markdown without any stylesheet this extension can reach, so table
 * cells sit flush against each other and columns of long numbers visually run together.
 * Widening each cell with non-breaking spaces is the only column gutter available.
 */
export const TOOLTIP_COLUMN_GUTTER = '&nbsp;'.repeat(6);

/**
 * Formats the main stats table in Markdown for the status bar hover tooltip.
 * Renders Today, Current Month, and Last 30 Days columns side by side.
 */
export function formatTooltipStatsTable(
	detailedStats: DetailedStats,
	sumCosts: (costs: Record<string, number> | undefined) => number = defaultSumBillingGroupCosts
): string {
	// Gutter padding on every column but the last — the header row included, so a header and its
	// values agree on one column width — keeps the three period columns from running together.
	const pad = (cell: string) => `${cell}${TOOLTIP_COLUMN_GUTTER}`;
	const row = (label: string, today: string, month: string, last30Days: string) =>
		`| ${pad(label)} | ${pad(today)} | ${pad(month)} | ${last30Days} |\n`;
	// Hide decimals once the rounded display value reaches 1000+ so large totals stay readable.
	const formatUsageValue = (n: number, fractionDigits: number, unit: string) => {
		const rounded = Math.round(n * (10 ** fractionDigits)) / (10 ** fractionDigits);
		const format = Math.abs(rounded) >= 1000
			? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
			: { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
		return `${n.toLocaleString(undefined, format)} ${unit}`;
	};
	const grams = (n: number) => formatUsageValue(n, 2, 'grams');
	const liters = (n: number) => formatUsageValue(n, 3, 'liters');
	const tokens = (period: PeriodStats) => period.tokens.toLocaleString();
	const copilotCost = (period: PeriodStats) => `$ ${(period.estimatedCostCopilot ?? 0).toFixed(2)}`;
	const allProvidersCost = (period: PeriodStats) => `$ ${sumCosts(period.billingGroupCosts).toFixed(2)}`;
	const { today, month, last30Days } = detailedStats;

	return (
		row('', `📅 ${l10n.t('tooltip.todayLabel')}`, `📊 ${l10n.t('tooltip.currentMonthLabel')}`, `📈 ${l10n.t('tooltip.last30DaysLabel')}`) +
		`|:---|:---|:---|:---|\n` +
		row(`${l10n.t('tooltip.tokensLabel')} :`, tokens(today), tokens(month), tokens(last30Days)) +
		row(`${l10n.t('tooltip.copilotCostLabel')} :`, copilotCost(today), copilotCost(month), copilotCost(last30Days)) +
		row(`${l10n.t('tooltip.allProvidersCostLabel')} :`, allProvidersCost(today), allProvidersCost(month), allProvidersCost(last30Days)) +
		row(`${l10n.t('tooltip.co2Label')} :`, grams(today.co2), grams(month.co2), grams(last30Days.co2)) +
		row(`${l10n.t('tooltip.waterLabel')} :`, liters(today.waterUsage), liters(month.waterUsage), liters(last30Days.waterUsage))
	);
}

/**
 * The Copilot Budget gauge row's rendered pieces. Built by the tracker rather than by
 * formatProviderCostTable() because they depend on the live API balance and on SVG rendering,
 * which would drag an extension host into what is otherwise a pure string formatter.
 */
export interface CopilotBudgetGauge {
	/** Total spend against budget, e.g. "$794.07 / $1250.00". */
	usedOfBudget: string;
	/** Markdown image cell holding the two-segment (tracked + untracked) bar. */
	barCell: string;
	/** Indented sub-row labels, from buildCopilotBudgetSubRowLabels(). */
	subRowLabels: string[];
	/** Where the budget figure came from (not currently rendered in the tooltip). */
	source: string;
}

/**
 * Formats the "💰 Costs by Provider" table for the status bar hover tooltip: the Copilot Budget
 * gauge and its sub-rows on top (when a budget is set), then every provider's share of total
 * monthly spend.
 *
 * The section title doubles as the table's header row. A title line above an empty `|  |  |  |`
 * header left a blank band between the two, wasting vertical space in a popup narrow enough that
 * rows already wrap. Costs are right-aligned (`---:`) with the same trailing gutter as the period
 * table, so every amount ends at the same offset instead of drifting with each provider name's
 * length.
 *
 * Returns an empty string when there are no providers, so the caller appends nothing.
 */
export function formatProviderCostTable(
	monthCosts: Record<string, number>,
	totalCost: number,
	gauge: CopilotBudgetGauge | null,
	shareBarCell: (ratio: number) => string,
): string {
	const providers = Object.keys(monthCosts).sort((a, b) => (monthCosts[b] ?? 0) - (monthCosts[a] ?? 0));
	if (providers.length === 0) { return ''; }
	const pad = (cell: string) => `${cell}${TOOLTIP_COLUMN_GUTTER}`;
	let markdown = `\n| 💰 ${l10n.t('tooltip.costsByProvider')} |  |  |\n|:---|---:|:---|\n`;
	if (gauge) {
		markdown += `| 🎯 ${pad(l10n.t('tooltip.copilotBudgetLabel'))} | ${pad(gauge.usedOfBudget)} | ${gauge.barCell} |\n`;
		for (const label of gauge.subRowLabels) {
			markdown += `| &nbsp;&nbsp;↳ ${label} |  |  |\n`;
		}
		markdown += `| **${l10n.t('tooltip.shareOfTotalSpend')}** |  |  |\n`;
	}
	for (const provider of providers) {
		const cost = monthCosts[provider] ?? 0;
		markdown += `| ${pad(provider)} | ${pad(`$${cost.toFixed(2)}`)} | ${shareBarCell(totalCost > 0 ? cost / totalCost : 0)} |\n`;
	}
	return markdown;
}

// ── extension.ts module-level helpers ────────────────────────────────────────

/** Type guard for the social platforms supported by `shareTextToSocialPlatform`. */
function isSharePlatform(value: unknown): value is 'linkedin' | 'bluesky' | 'mastodon' {
	return value === 'linkedin' || value === 'bluesky' || value === 'mastodon';
}

/**
 * Groups per-editor model usage into billing groups (e.g. "GitHub Copilot", "Anthropic").
 * Extracted as a module-level function to keep `computeBillingGroupCosts` complexity low.
 */
function aggregateEditorModelUsageByBillingGroup(editorModelUsage: { [editor: string]: ModelUsage }): Record<string, ModelUsage> {
	const groupModelUsage: Record<string, ModelUsage> = {};
	for (const [editor, modelUsage] of Object.entries(editorModelUsage)) {
		for (const modelId of Object.keys(modelUsage)) {
			const group = getBillingGroup(editor, modelId);
			if (!groupModelUsage[group]) { groupModelUsage[group] = {}; }
			addModelUsage(groupModelUsage[group], { [modelId]: modelUsage[modelId] });
		}
	}
	return groupModelUsage;
}

function _dwbcPickWinner(
	key: string, canonical: string,
	keyIsRemote: boolean, canonIsRemote: boolean,
	sessionCounts: Map<string, number>
): string {
	if (!keyIsRemote && canonIsRemote) { return key; }
	if (!canonIsRemote && keyIsRemote) { return canonical; }
	return (sessionCounts.get(key) || 0) >= (sessionCounts.get(canonical) || 0) ? key : canonical;
}

/** One Copilot CLI session where OTel export data was found, for the diagnostics "OTel Delta" tab. */
interface CopilotCliOtelComparisonSession {
	file: string;
	sessionId: string;
	/** Token count the extension would have reported before OTel enrichment (0 for DB-only chat sessions). */
	baselineTokens: number;
	otelTokens: number;
	delta: number;
	models: string[];
	/** Session file mtime (ISO string), used for the tab's date-range filter. Null if stat failed. */
	lastActivity: string | null;
}

/** Summary of how much more/different token tracking is with the OTel export versus the estimate-only path. */
interface CopilotCliOtelComparison {
	otelDirExists: boolean;
	otelFileCount: number;
	otelSessionsIndexed: number;
	sessionsChecked: number;
	sessionsMatched: number;
	totalBaselineTokens: number;
	totalOtelTokens: number;
	deltaTokens: number;
	sessions: CopilotCliOtelComparisonSession[];
}

/**
 * A discovered git worktree row for the diagnostics Worktrees tab. `files`/`folders`/`bytes`
 * are -1 while their (expensive) size walk is still pending; `pushed` is "?" until the
 * background push-status check completes.
 */
interface WorktreeScanResult {
	path: string;
	repoLabel: string;
	branch: string;
	lastCommit: string;
	lastCommitDate: string | null;
	pushed: "yes" | "no" | "?";
	files: number;
	folders: number;
	bytes: number;
}

/**
 * Extra git/filesystem context gathered for a worktree the bulk cleanup could not delete.
 * A bare "Has uncommitted or untracked changes." tells the user nothing about *what* to do,
 * so every field here exists to answer a remediation question: is this stale or still active
 * (lastModified/lastCommitDate), does the branch exist on the remote and is it in sync
 * (remoteBranch/ahead/behind), and how much local work is actually at risk (modifiedFiles/
 * untrackedFiles). Fields are optional because each probe is best-effort — a git failure
 * degrades that one field, it never fails the whole report.
 */
interface WorktreeCleanupDiagnostics {
	/** Newest mtime seen at the worktree root (ISO), i.e. when the folder was last touched. */
	lastModified?: string;
	/** ISO timestamp of the last commit on the checked-out branch. */
	lastCommitDate?: string;
	/** Human-readable relative age of the last commit ("3 weeks ago"). */
	lastCommitRelative?: string;
	/** Upstream tracking ref (e.g. "origin/feature-x"), present only when `remoteStatus` is "tracked" or "gone". */
	remoteBranch?: string;
	/**
	 * Tri-state so an unreadable worktree is never reported as a fact: "tracked" (upstream exists),
	 * "gone" (upstream configured but its remote-tracking ref is gone), "none" (branch has no
	 * upstream). Left undefined when the probe itself failed — the UI then shows no remote chip
	 * rather than claiming the branch was never pushed.
	 */
	remoteStatus?: "tracked" | "gone" | "none";
	/** Commits on HEAD not on the upstream branch. */
	ahead?: number;
	/** Commits on the upstream branch not on HEAD. */
	behind?: number;
	/** Tracked files with uncommitted modifications. */
	modifiedFiles?: number;
	/** Untracked files (excluding ignored ones). */
	untrackedFiles?: number;
}

/** How long a "take me there" request waits for its panel to finish loading before it is dropped. */
const SURFACE_REVEAL_TTL_MS = 60_000;

type UsageAnalysisTab = 'activity' | 'sessions' | 'tools' | 'health' | 'repos' | 'agent' | 'readiness' | 'worktrees' | 'insights' | 'corrections';

/** Narrows an arbitrary tab name (e.g. from the what's-new catalog) to one `showUsageAnalysisOnTab` accepts. */
function isUsageAnalysisTab(tab: string): tab is UsageAnalysisTab {
	return (['activity', 'sessions', 'tools', 'health', 'repos', 'agent', 'readiness', 'worktrees', 'insights', 'corrections'] as string[]).includes(tab);
}

/**
 * Pre-set filter the Recent Sessions tab should apply when it is opened from
 * elsewhere — today only `nearContextLimit`, which narrows the table to the very
 * sessions the "nearly ran out of context window" insight counts.
 */
type SessionsTabPreset = { filter: 'nearContextLimit'; lookback: 'last30' };

class CopilotTokenTracker implements vscode.Disposable {
	// Cache version - increment this when making changes that require cache invalidation.
	// v79: Copilot CLI exact cost (copilotNanoAiu) is the latest session.usage_checkpoint/shutdown
	// totalNanoAiu instead of a sum over shutdowns (it is cumulative, so resumed sessions were
	// counted more than once); an mtime/size hit would keep the summed value until the file changed.
	// v78: per-tool outcome maps (toolCalls.completedByTool/failuresByTool/latencyByTool,
	// mcpTools.completedByServer/failuresByServer/latencyByServer) are now recorded from Copilot
	// CLI/JetBrains tool.execution_start/complete pairs and Claude Code tool_use/tool_result pairs;
	// an mtime/size hit skips re-analysis, so existing entries would never gain the fields.
	// v77: Copilot CLI MCP calls (tool.execution_start tagged with data.mcpServerName) now land in
	// usageAnalysis.mcpTools instead of toolCalls (and no longer get output-token estimates);
	// getSessionFileDataCached() serves the persisted usageAnalysis on an mtime/size hit, so without
	// this bump unchanged CLI sessions would keep the old counts until their file changed.
	// v75: legacy details-only placeholders (tokens 0, empty usage analysis, real mtime/size) were
	// written unmarked by updateCacheWithSessionDetails() and cannot be told apart from full entries,
	// so the whole generation is discarded; new placeholders carry `detailsOnly`.
	// Earlier: Rebuild Mistral Vibe model usage so it carries cachedReadTokens: getSessionFileDataCached()
	// returns an mtime/size hit without re-running getModelUsage(), so without this bump existing
	// entries would keep billing the whole prompt at the full input rate until their file changed.
	// v74: Distribute the debug-log exact Copilot cost (nano-AIU) over each session's dailyRollups:
	// aggregatePeriodStats reads exact cost from rollups only, so existing entries would keep
	// showing an estimate in Today/month/30-day totals until their file changed.
	// v76: Add per-session autonomyUsage (autopilot/auto vs supervised) to usageAnalysis: cache hits
	// skip re-analysis, so existing entries would lack the metric until their file changed.
	private static readonly CACHE_VERSION = 79;
	/** Initial stats should not wait indefinitely for one inaccessible or stalled session. */
	private static readonly SESSION_PRELOAD_TIMEOUT_MS = 15_000;
	/**
	 * Size of _deferredParseSemaphore: how many session-file parses (fast or eventually deferred)
	 * may be in flight at once. Deferring a slow parse does not cancel it — it keeps running to
	 * completion — and without a real cap, every worker that hits SESSION_PRELOAD_TIMEOUT_MS
	 * immediately grabs the next file while the slow one keeps consuming CPU, so a scan with
	 * hundreds of slow files accumulates hundreds of concurrent CPU-bound parses competing for
	 * the same single-threaded event loop the webview's postMessage delivery and rendering also
	 * depend on — the likely cause of a loading flow that looks frozen despite work still
	 * happening. Currently matches CONCURRENCY, the worker pool size in _preloadSessionFiles()
	 * (a separate constant there, not structurally linked to this one): with every file — not
	 * just deferred ones — holding a permit for its own duration, a run where every file is fast
	 * never contends for one as long as permits >= worker count, and contention only appears
	 * once files actually start piling up in the background.
	 */
	private static readonly MAX_CONCURRENT_DEFERRED_PARSES = 20;
	/**
	 * Size of _deferredParseReserve: a second, smaller pool a worker falls back to only once it
	 * has waited 3s for a primary permit and gotten nothing — meaning every primary permit is
	 * currently held by a parse showing no sign of ever finishing, not merely a slow one (those
	 * settle well within that window). Acquiring from the reserve has no timeout, so total
	 * concurrent parses stays bounded at MAX_CONCURRENT_DEFERRED_PARSES + this reserve instead of
	 * growing without limit as more workers hit the same stuck wall across successive waves.
	 */
	private static readonly DEFERRED_PARSE_RESERVE_PERMITS = 10;
	// Maximum length for displaying workspace IDs in diagnostics/customization matrix
	private static readonly WORKSPACE_ID_DISPLAY_LENGTH = 8;
	private static readonly SEEN_EDITORS_STATE_KEY = 'discovery.seenEditors';
	private static readonly NOTIFIED_EDITORS_STATE_KEY = 'discovery.notifiedEditors';

	private diagnosticsPanel?: vscode.WebviewPanel;
	// Tracks whether the diagnostics panel has already received its session files
	private diagnosticsHasLoadedFiles: boolean = false;
	// Cache of the last loaded detailed session files for diagnostics view
	private diagnosticsCachedFiles: SessionFileDetails[] = [];
	// Full, unfiltered session file paths from the last diagnostics load (no 14-day/500-file cap) —
	// the TTFT scan-range picker filters this list itself instead of relying on diagnosticsCachedFiles.
	private diagnosticsAllSessionFiles: string[] = [];

	// Per scan-range TTFT result cache. Granularity changes reuse the cached sample set instantly.
	private readonly diagnosticsTtftCache = new TtftScanResultCache();
	// Cache of the last diagnostic report text for copy/issue operations
	private lastDiagnosticReport: string = '';
	// Incremented on each worktree scan start/cancel; in-flight scans check this to stop early
	private worktreeScanId: number = 0;
	// Incremented on each cleanup start/cancel; an in-flight cleanup loop checks this to stop early
	private worktreeCleanupId: number = 0;
	// Incremented on each background worktree scan start/dispose; the in-flight drip scan checks this to stop early
	private backgroundWorktreeScanId: number = 0;
	// True while a daily background worktree scan is in flight in this window, to avoid starting a second one concurrently
	private backgroundWorktreeScanRunning: boolean = false;
	private static readonly WORKTREE_BG_SCAN_STARTED_KEY = 'worktrees.backgroundScan.startedAt';
	private static readonly WORKTREE_BG_SCAN_RESULT_KEY = 'worktrees.backgroundScan.result';
	private static readonly WORKTREE_BG_SCAN_NOTIFIED_BYTES_KEY = 'worktrees.backgroundScan.lastNotifiedBytes';
	private logViewerPanel?: vscode.WebviewPanel;
	private logViewerSessionFilePath: string = '';
	private logViewerCurrentData?: SessionLogData;
	public openCode!: OpenCodeDataAccess;
	public crush!: CrushDataAccess;
	public visualStudio!: VisualStudioDataAccess;
	private continue_!: ContinueDataAccess;
	private claudeCode!: ClaudeCodeDataAccess;
	private claudeDesktop!: ClaudeDesktopDataAccess;
	/** Cached Claude Desktop local-transcript coverage (see computeClaudeDesktopCoverage). */
	private _claudeDesktopCoverage?: { value: ClaudeDesktopCoverage; computedAt: number };
	private mistralVibe!: MistralVibeDataAccess;
	private geminiCli!: GeminiCliDataAccess;
	public windsurf!: WindsurfDataAccess;
	private hermes!: HermesDataAccess;
	private ecosystems!: IEcosystemAdapter[];
	private cacheManager!: CacheManager;
	private hookManager!: HookManager;
	private readonly copilotAppData = new CopilotAppDataAccess();

	private get usageAnalysisDeps(): UsageAnalysisDeps {
		return toUsageAnalysisDeps(this.analyzerDeps);
	}

	/** Everything the session-analysis pipeline needs, for the in-process path (the worker builds its own). */
	private get analyzerDeps(): SessionAnalyzerDeps {
		return { warn: (m: string) => this.warn(m), tokenEstimators: this.tokenEstimators, modelPricing: this.modelPricing, toolNameMap: this.toolNameMap, ecosystems: this.ecosystems, windsurf: this.windsurf };
	}

	/**
	 * Worker threads that do the CPU-heavy session parsing off this host's event loop (see
	 * src/analysis/). Undefined when the bundled worker is missing or explicitly disabled, in
	 * which case everything runs in-process exactly as before.
	 */
	private analysisPool: AnalysisWorkerPool | undefined;
	private otelLookup: WorkerOtelLookup | undefined;
	public sessionDiscovery!: SessionDiscovery;
	private statusBarItem!: vscode.StatusBarItem;
	/** Dedicated status bar item for insights — shown only when new insights exist. */
	private insightsStatusBarItem!: vscode.StatusBarItem;
	private readonly extensionUri: vscode.Uri;
	private readonly context: vscode.ExtensionContext;
	private _devBranch: string | undefined;
	/** Dev-mode-only path for debugCrashLog(); undefined disables it entirely (never set outside Development mode). */
	private _crashDebugLogPath: string | undefined;
	private localRegressionSampleDataDir?: string;
	private pendingLocalViewRegressionProbe?: ViewRegressionProbeConfig;
	private readonly localViewRegressionResolvers = new Map<string, (result: LocalViewRegressionProbeResult) => void>();


	/**
	 * Resolve the workspace folder full path from a session file path.
	 * Looks for a `workspaceStorage/<id>/` segment and reads `workspace.json` or `meta.json`.
	 * Synchronous by design to keep the analysis flow simple and cached.
	 */
	// Helper: read a workspaceStorage JSON file and extract a candidate folder path from configured keys

	/**
	 * Extract workspace ID from a session file path, if it's workspace-scoped.
	 * Returns the workspace ID or undefined if not a workspace-scoped session.
	 */


	/**
	 * Convert a simple glob pattern to a RegExp.
	 * Supports: ** (match multiple path segments), * (match within a segment), ?.
	 */

	/**
	 * Resolve an exact relative path in a workspace.
	 * When `caseInsensitive` is true, path segments are matched case-insensitively.
	 */

	/**
	 * Scan a workspace folder for customization files according to `customizationPatterns.json`.
	 */
	/** Buttons registered by companion extensions via the extension points API. */
	private readonly _extensionPointButtons = new Map<string, { config: ExtensionPointButton; handler: () => void | Promise<void> }>();

	private _disposed = false;
	private updateInterval: NodeJS.Timeout | undefined;
	private _eventLoopMonitor: EventLoopMonitor | undefined;
	private detailsPanel: vscode.WebviewPanel | undefined;
	private chartPanel: vscode.WebviewPanel | undefined;
	private analysisPanel: vscode.WebviewPanel | undefined;
	/** Incremented per created analysis panel so logs can distinguish a stale panel from the live one. */
	private _analysisPanelSeq = 0;
	private analysisWebviewReady = false;
	private readonly analysisMessageReplay = new WebviewMessageReplay(
		(message) => this.analysisPanel?.webview.postMessage(message) ?? false,
		2_000,
		(error) => this.warn(`Usage Analysis message delivery failed: ${error}`),
	);
	private pendingAnalysisNavigation: { tab: UsageAnalysisTab; anchor?: string; sessionsPreset?: SessionsTabPreset } | undefined;
	private maturityPanel: vscode.WebviewPanel | undefined;
	private dashboardPanel: vscode.WebviewPanel | undefined;
	private fluencyLevelViewerPanel: vscode.WebviewPanel | undefined;
	private environmentalPanel: vscode.WebviewPanel | undefined;
	private efficiencyPanel: vscode.WebviewPanel | undefined;
	/**
	 * Replay channel for the Efficiency panel's Value updates. Reset on every HTML replacement and
	 * on disposal: a retained snapshot is only valid for the document it was derived for.
	 */
	private readonly efficiencyMessageReplay = new WebviewMessageReplay(
		(message) => this.efficiencyPanel?.webview.postMessage(message) ?? false,
		2_000,
		(error) => this.warn(`Efficiency message delivery failed: ${error}`),
	);
	private whatsNewPanel: vscode.WebviewPanel | undefined;
	/**
	 * "Take me there" requests waiting for their panel to load or acknowledge
	 * them. See whatsNew/surfaceRevealQueue.ts for the handshake.
	 */
	private readonly surfaceReveals = new SurfaceRevealQueue<FeatureViewId, ViewIndexNavigation, vscode.WebviewPanel>(SURFACE_REVEAL_TTL_MS);
	/** Bumped by every navigation, so a slow opener never focuses its panel after a newer one started. */
	private surfaceNavGeneration = 0;
	/** What the user has already been told about; see `src/whatsNew/announcer.ts`. */
	private _whatsNewState: WhatsNewState = { ...EMPTY_WHATS_NEW_STATE };
	/** Last time the user opened each view / tab; see `src/whatsNew/visits.ts`. */
	private _viewVisits: ViewVisitMap = {};
	/** Resolves once the persisted what's-new bookkeeping has been read and reconciled. */
	private _whatsNewReady: Promise<void> | undefined;
	/** Memoized per-session efficiency inputs; cleared wherever the daily/usage stat caches are. */
	private lastEfficiencySessionInputs: EfficiencySessionInput[] | undefined;
	/**
	 * Last successfully rendered Efficiency payload — restored if a refresh build fails, and the
	 * base for Value-only updates.
	 */
	private _lastEfficiencyViewData: EfficiencyViewData | undefined;
	/** Bumped whenever the computed stat caches are invalidated; see recordEfficiencyPayload(). */
	private _cacheGeneration = 0;
	/**
	 * Per-cache generation stamps: for each computed-stat cache, the `_cacheGeneration` that was
	 * in effect when the computation now holding it *began*. Read through
	 * `isComputedStatsCurrent()` before reusing a cache, so a build that was already running
	 * when the caches were cleared cannot have its pre-clear result read back as current.
	 */
	private _statsGeneration: Partial<Record<ComputedStatsKey, number>> = {};

	/**
	 * The computed-stat caches, readable only while they are still current.
	 *
	 * Every consumer goes through these rather than touching the `last*` fields, so the
	 * generation check cannot be half-applied: a stamp that no longer matches reads as
	 * `undefined`, which every caller already handles because these caches start empty and are
	 * emptied again by `clearCache()`. Reading a raw field would silently opt that caller out,
	 * so `efficiencyBuildGuards.test.ts` asserts the fields appear nowhere but their writes and
	 * these accessors.
	 */
	private get currentDetailedStats(): DetailedStats | undefined {
		return isComputedStatsCurrent(this._statsGeneration.detailed, this._cacheGeneration) ? this.lastDetailedStats : undefined;
	}
	private get currentDailyStats(): DailyTokenStats[] | undefined {
		return isComputedStatsCurrent(this._statsGeneration.daily, this._cacheGeneration) ? this.lastDailyStats : undefined;
	}
	private get currentFullDailyStats(): DailyTokenStats[] | undefined {
		return isComputedStatsCurrent(this._statsGeneration.fullDaily, this._cacheGeneration) ? this.lastFullDailyStats : undefined;
	}
	private get currentUsageAnalysisStats(): UsageAnalysisStats | undefined {
		return isComputedStatsCurrent(this._statsGeneration.usage, this._cacheGeneration) ? this.lastUsageAnalysisStats : undefined;
	}
	private get currentEfficiencySessionInputs(): EfficiencySessionInput[] | undefined {
		return isComputedStatsCurrent(this._statsGeneration.sessionInputs, this._cacheGeneration) ? this.lastEfficiencySessionInputs : undefined;
	}
	private outputChannel!: vscode.OutputChannel;
	private lastDetailedStats: DetailedStats | undefined;
	private lastDailyStats: DailyTokenStats[] | undefined;
	/** Full-year daily stats (up to 365 days) for the chart Week/Month period views. */
	private lastFullDailyStats: DailyTokenStats[] | undefined;
	/** globalState key for the Chart view's collapsed "By Editor" section; survives closing and reopening the panel. */
	private static readonly CHART_EDITOR_LIST_COLLAPSED_KEY = 'chart.editorListCollapsed';
	/** Last period selected by the user in the chart view; restored on next open. */
	private lastChartPeriod: 'day' | 'week' | 'month' = 'day';
	/** Last view selected by the user in the chart view; restored on next open. */
	private lastChartView: 'total' | 'model' | 'editor' | 'repository' | 'cost' | 'task' | 'taskCategory' = 'total';
	private lastChartMetric: 'tokens' | 'output' | 'cost' | 'sessions' = 'tokens';
	private lastChartSplit: 'total' | 'model' | 'editor' | 'repository' | 'language' | 'provider' | 'task' | 'taskCategory' = 'total';
	private lastChartTimeWindow: ChartTimeWindow = 'last30';
	private lastUsageAnalysisStats: UsageAnalysisStats | undefined;
	/** Cached result of the last memory-files filesystem scan, reused across recomputes within {@link MEMORY_FILES_SCAN_TTL_MS}. */
	private _memoryFilesAnalysisCache: MemoryFilesAnalysis | null | undefined;
	/**
	 * Wall-clock time (ms) of the last memory-files scan, used to throttle repeated
	 * `readdirSync`/`statSync` walks. Reset to `undefined` by `refreshAnalysisPanel()` and
	 * `clearCache()` so an explicit refresh always re-scans rather than serving a
	 * within-TTL result the user is specifically asking to update.
	 */
	private _memoryFilesAnalysisScannedAt: number | undefined;
	/**
	 * Last successful read of the workspace repository's server-side memory store.
	 *
	 * Held separately from the computed-stats caches because it is fetched out of band: the
	 * stats build is synchronous and must not wait on a network call, so it renders whatever
	 * this field holds and a background refresh updates it for the *next* render.
	 */
	private _serverMemoriesAnalysis: ServerMemoriesAnalysis | null | undefined;
	/** Wall-clock time (ms) of the last server-memory fetch attempt, successful or not. */
	private _serverMemoriesFetchedAt: number | undefined;
	/**
	 * `owner/name` that {@link _serverMemoriesAnalysis} belongs to. The TTL alone is not enough:
	 * it answers "is this repository's store still fresh?", so without the slug a workspace
	 * switch would keep showing the previous repository's memories until the hour elapsed.
	 */
	private _serverMemoriesRepo: string | undefined;
	/**
	 * Checkout root {@link _serverMemoriesAnalysis} was computed against. The slug alone is not
	 * enough either: the stale-citation counts are file-existence results from a specific tree,
	 * and two worktrees of one repository share a slug while having different files on disk —
	 * which this repository's own workflow makes a routine case rather than a corner one.
	 */
	private _serverMemoriesRepoRoot: string | undefined;
	/**
	 * Bumped by {@link invalidateServerMemoriesCache}. A fetch captures this when it starts
	 * and must still match to publish, which is the only thing that can stop a request begun
	 * under one account from landing after the user has switched to another — the identity
	 * checks cannot see that change, since the setting, repository and root are all unchanged.
	 * Mirrors the `_cacheGeneration`/`isComputedStatsCurrent()` guard used for the other
	 * computed-stat caches.
	 */
	private _serverMemoriesGeneration = 0;
	/** In-flight fetch, so concurrent refreshes coalesce into one request rather than racing. */
	private _serverMemoriesFetchInFlight: Promise<void> | undefined;
	private lastDashboardData: any | undefined;
	/** Insight engine: persisted state for all surfaced insights. */
	private _insightStateBag: InsightStateBag = {};
	/** ISO timestamp of the last time an insight toast was shown. */
	private _lastInsightNudgeAt: string | null = null;
	/** Count of insights currently in 'new' status (drives the status-bar badge). */
	private _newInsightCount = 0;
	/** The last non-badge status bar text (so badge can be appended/removed). */
	private _statusBarBaseText = '';
	/** Cached top new insight title for tooltip display. */
	private _topInsightTitle: string | null = null;
	/** Id of the insight behind `_topInsightTitle`, so clicking the badge scrolls to that card. */
	private _topInsightId: string | null = null;
	/** Cached last detailed stats for tooltip rebuilding. */
	private _lastDetailedStats: DetailedStats | undefined;
	private tokenEstimators: Record<string, TokenEstimator> = tokenEstimatorsData.estimators;
	private _cacheHits = 0; // Counter for cache hits during usage analysis
	private _cacheMisses = 0; // Counter for cache misses during usage analysis
	// Short-term cache to avoid rescanning filesystem during rapid successive calls (e.g., diagnostics load)

	// Cached sql.js SQL module (lazy initialized)

	// In-flight command tracker — prevents concurrent execution of the same webview command
	private readonly _inFlightCommands = new Set<string>();

	// In-flight updateTokenStats promise — coalesces concurrent callers onto the same run
	private _updateTokenStatsInFlight: Promise<DetailedStats | undefined> | undefined;
	/**
	 * persistRefreshResult()'s detached end-of-refresh snapshot save for the leader cycle currently
	 * finishing up, if any. _runUpdateTokenStats() awaits this in its `finally` before releasing the
	 * refresh-leader lock — otherwise the lock (and the leader role with it) could pass to a second
	 * window while this window's own save was still mid-flight, letting that window publish its own
	 * snapshot and then have this window's stale save land after it and be merged back in on top.
	 */
	private _pendingLeaderSnapshotSave: Promise<void> | undefined;
	/**
	 * Every currently-running full-year `calculateDailyStats(365, ...)` call, tracked so
	 * clearCache() can wait all of them out before clearing. There are two call sites: the
	 * one-time, detached backfill `_runRefreshCore()` fires after a leader refresh publishes (see
	 * its own call site), dispatched fire-and-forget *after* the refresh that started it has
	 * already returned — invisible to both `_updateTokenStatsInFlight` and
	 * `_deferredSessionPreloadPromises`; and the foreground full-year walk `collectEfficiencyInputs()`
	 * awaits directly on a cold Efficiency view open. Both reparse every discovered session file
	 * unconditionally, calling getSessionFileDataCached()/setCachedSessionData() the same as any
	 * other parse. A `Set` rather than a single slot: two overlapping calls (e.g. a second leader
	 * refresh's own backfill starting before an earlier one settles) must each be tracked and
	 * awaited, not have the newer one silently overwrite the older one's tracking. See
	 * trackFullYearBackfill().
	 */
	private readonly _pendingFullYearBackfills = new Set<Promise<unknown>>();

	/**
	 * Registers a full-year `calculateDailyStats(365, ...)` call in `_pendingFullYearBackfills` for
	 * the duration of its run and returns the same promise unchanged, so callers can still await it
	 * directly. See that field's doc comment for why every such call must be tracked, not just the
	 * most recently started one.
	 */
	private trackFullYearBackfill<T>(backfill: Promise<T>): Promise<T> {
		this._pendingFullYearBackfills.add(backfill);
		backfill.finally(() => { this._pendingFullYearBackfills.delete(backfill); }).catch(() => undefined);
		return backfill;
	}
	/**
	 * The `_cacheGeneration` the in-flight run's results will belong to — registered when the run
	 * starts and narrowed to _runRefreshCore()'s own capture once it gathers its inputs. A caller
	 * on the far side of a clear this number predates must not coalesce onto that run, because the
	 * run will discard its results rather than publish them. See updateTokenStats().
	 */
	private _updateTokenStatsInFlightGeneration: number | undefined;
	/**
	 * The generation of the last refresh that published successfully. A caller that waited out a
	 * superseded run consults it before starting its own: that run can have retagged itself to the
	 * caller's generation in its preamble (see beginRefreshGeneration()) and published valid data,
	 * in which case a second full refresh is pure duplicate work.
	 */
	private _lastPublishedRefreshGeneration: number | undefined;
	// Timed-out preloads continue in the background; skip duplicate work until their cache entries settle.
	private readonly _deferredSessionPreloadFiles = new Set<string>();
	private _deferredSessionPreloadCount = 0;
	/**
	 * The in-flight promise of every deferred (backgrounded) session-file parse, keyed by file
	 * path. clearCache() awaits all of these (a snapshot at the moment it runs) before clearing,
	 * so a parse that is still running from a refresh that already returned cannot call
	 * setCachedSessionData() after the clear and silently repopulate the cache it just emptied.
	 * This only covers parses that already timed out into the background by the time clearCache()
	 * takes its snapshot — a foreground worker still on its ordinary (non-deferred) pass over a
	 * file is not registered here yet, which is why clearCache() also awaits the whole in-flight
	 * refresh (`_updateTokenStatsInFlight`) before reading this map; see clearCache()'s own comment.
	 * Populated/cleared alongside _deferredSessionPreloadFiles in deferSessionPreloadRefresh().
	 */
	private readonly _deferredSessionPreloadPromises = new Map<string, Promise<void>>();
	/**
	 * Bounds how many session-file parses (see MAX_CONCURRENT_DEFERRED_PARSES) may be in flight
	 * across worker() calls in _preloadSessionFiles(), including ones that end up deferred to the
	 * background. A worker acquires a permit before starting a file and releases it either
	 * immediately (the file completed or errored within its own turn) or later, from
	 * deferSessionPreloadRefresh()'s completion handler, once ownership has been handed off to a
	 * deferred parse still running past the worker's turn — see processPreloadQueueFileWithCrashLog.
	 * A single persistent semaphore (not recreated per run) because a deferred parse from a
	 * previous run releasing its permit must still be able to admit a worker parked in the next one.
	 */
	private readonly _deferredParseSemaphore: Semaphore = createSemaphore(CopilotTokenTracker.MAX_CONCURRENT_DEFERRED_PARSES);
	/** See DEFERRED_PARSE_RESERVE_PERMITS — the bounded fallback for when the primary semaphore above is entirely stuck. */
	private readonly _deferredParseReserve: Semaphore = createSemaphore(CopilotTokenTracker.DEFERRED_PARSE_RESERVE_PERMITS);
	private _deferredSessionRefreshTimer: NodeJS.Timeout | undefined;
	private _updateTokenStatsStartedAt: number | undefined;

	// --- Multi-window refresh coordination ---
	// When several VS Code/Codium windows are open, only the window that holds the
	// refresh leader lock performs the heavy discover+parse pass and publishes a
	// shared snapshot. Follower windows warm their cache from that snapshot and skip
	// parsing, except for a small budget of newly-changed files so the actively-used
	// window still shows fresh data (the "hybrid" freshness policy).
	private static readonly FOLLOWER_MISS_BUDGET = 25;
	// Bounded retry chain a follower uses to pick up the leader's snapshot when it
	// started before any snapshot existed (cold simultaneous start). Must cover a
	// worst-case cold-boot leader parse: with an empty cache the leader can need
	// several minutes to parse thousands of session files before it publishes.
	// 24 × 15s = 6 minutes of coverage; without this the follower shows partial
	// (near-zero) stats until the 5-minute periodic refresh happens to fire.
	private static readonly FOLLOWER_RESYNC_MAX_RETRIES = 24;
	private static readonly FOLLOWER_RESYNC_DELAY_MS = 15 * 1000;
	private _followerResyncTimer: NodeJS.Timeout | undefined;
	private _refreshHeartbeat: NodeJS.Timeout | undefined;

	// Flag to track if details panel is currently showing the loading screen
	private _detailsPanelIsLoading = false;

	/**
	 * Panels currently showing getLoadingHtml() while waiting on this exact same
	 * updateTokenStats()/_runRefreshCore() run — Details and Environmental, the two views
	 * that directly await it before rendering. sendLoadingPanelMessage() broadcasts to all of
	 * them, since they are all watching the same operation (see that method's own doc comment
	 * on why the same broadcast must NOT reach a panel waiting on a different operation, like
	 * Efficiency's own build or the Log Viewer/Maturity's independent loads).
	 */
	private readonly _refreshLoadingPanels = new Set<vscode.WebviewPanel>();

	// Editor list captured during the last (or current) log analysis, used to render the loading tooltip SVG
	private _loadingEditors: { icon: string; name: string }[] = [];
	/** Generation the last automatic Efficiency rebuild was requested for; see requestEfficiencyRebuild(). */
	private _efficiencyRebuildRequestedFor: number | undefined;
	/**
	 * Efficiency builds queued through runEfficiencyBuild() that have not started running yet.
	 * Each will capture the live `_cacheGeneration` when it does, so while this is non-zero an
	 * invalidation needs no rebuild of its own — see planEfficiencyRebuild().
	 */
	private _efficiencyBuildsQueued = 0;
	/**
	 * The generation of the last Efficiency payload that was recorded rather than discarded. An
	 * invalidation it already covers needs no rebuild — see planEfficiencyRebuild().
	 */
	private _efficiencyBuildCompletedFor: number | undefined;
	/**
	 * The generation captured by the Efficiency build currently running, or undefined when none is.
	 * A running build that captured *this* generation is already producing the payload an
	 * invalidation wants — see planEfficiencyRebuild().
	 */
	private _efficiencyBuildRunningFor: number | undefined;
	/** Tail of the serialized Efficiency build queue; see runEfficiencyBuild(). */
	private _efficiencyBuildChain: Promise<void> = Promise.resolve();
	// Previous progress percentage used to animate the progress bar smoothly between tooltip updates
	private _prevLoadingPercentage = 0;

	// Cache mapping workspaceStorageId -> resolved workspace folder path (or undefined if not resolvable)
	private _workspaceIdToFolderCache: Map<string, string | undefined> = new Map();

	// Cache mapping workspaceFolderPath -> found customization files (avoid re-scanning)
	private _customizationFilesCache: Map<string, CustomizationFileEntry[]> = new Map();
	/** Workspaces whose customization scan has been requested but not yet run (see resolvePendingCustomizationScans). */
	private readonly _pendingCustomizationScans = new Set<string>();
	/** Tail of the serialized calculateUsageAnalysisStats runs. */
	private _usageAnalysisChain: Promise<void> = Promise.resolve();

	// Last computed customization matrix for usage analysis (typed)
	private _lastCustomizationMatrix?: WorkspaceCustomizationMatrix;
	private _lastMissedPotential?: MissedPotentialWorkspace[];
	// Per-skill, per-editor invocation counts for the last-30-days window (Skill Usage tab).
	// Accumulated per session in aggregateSessionFileIntoStats, reset at the top of each refresh.
	private _skillCallsByEditorAccum: Map<string, Map<string, number>> = new Map();
	private _lastSkillCallsByEditor?: Record<string, Record<string, number>>;
	// Per-tool, per-editor call counts for the last-30-days window, so the "Report Unknown Tools"
	// issue can say which editor each unknown tool was seen in. Reset at the top of each refresh.
	private _toolCallsByEditorAccum: Map<string, Map<string, number>> = new Map();
	// Distinct workspace folder paths each skill was invoked from (last 30 days), used to
	// backfill descriptions for skills whose repo isn't the one currently open (see
	// findSkillDescriptionInWorkspaces).
	private _skillWorkspacePathsAccum: Map<string, Set<string>> = new Map();

	// Model pricing data - loaded from modelPricing.json
	// Reference: OpenAI API Pricing (https://openai.com/api/pricing/) - Retrieved December 2025
	// Reference: Anthropic Claude Pricing (https://www.anthropic.com/pricing) - Standard rates
	// Note: GitHub Copilot uses these models but pricing may differ from direct API usage
	// These are reference prices for cost estimation purposes only
	private modelPricing: { [key: string]: ModelPricing } = modelPricingData.pricing as { [key: string]: ModelPricing };

	// GitHub authentication session
	public githubSession: vscode.AuthenticationSession | undefined;
	// Promise that resolves when the startup session restore completes
	private _sessionRestorePromise: Promise<void> | undefined;
	// Promise that resolves when the initial cache load from disk completes, INCLUDING the
	// OpenCode DB probe chained after it (queueMissingOpenCodeDbSessionsFromCache(), which does
	// its own SQLite I/O). Callers that need the full startup sequence (the real refresh) await
	// this one.
	private _cacheLoadPromise: Promise<void> | undefined;
	// Promise that resolves as soon as the on-disk cache *file* itself has been read — before the
	// OpenCode DB probe chained onto _cacheLoadPromise runs. renderInstantStatsFromCache() awaits
	// this one instead of _cacheLoadPromise, so it never blocks on OpenCode's SQLite I/O and stays
	// a true no-filesystem-scan first paint.
	private _cacheFileLoadPromise: Promise<void> | undefined;
	/**
	 * Set once a real (discover→parse→verify) refresh has published its results. Guards
	 * renderInstantStatsFromCache(): it runs fire-and-forget, concurrently with the real refresh
	 * that starts 3s later in scheduleInitialUpdate() — normally far faster (pure in-memory
	 * aggregation vs. filesystem discovery+parsing), but with no hard ordering guarantee. Without
	 * this check, an instant paint that happened to take longer than the real refresh could finish
	 * last and silently overwrite verified, freshly discovered stats with older cache-only ones.
	 */
	private _hasCompletedRealRefresh = false;
	/**
	 * OpenCode DB virtual session paths discovered at startup that are missing from the
	 * persisted cache. These paths bypass the mtime cutoff once so new DB sessions are
	 * picked up even when opencode.db's file mtime lags behind per-session updates.
	 */
	private readonly _startupOpenCodeDbMisses = new Set<string>();
	/** True when the user explicitly signed out from our extension this VS Code session. Gated by globalState so it survives reloads. */
	private _githubSignedOutByUser: boolean = false;
	/** Resolved Copilot plan details fetched from copilot_internal/user after sign-in. */
	private _copilotPlanResolved: { planId: string; planName: string; monthlyAiCreditsUsd: number; monthlyPremiumRequests: number | null; isMCPEnabled?: boolean } | undefined;
	/** Quota entitlements from copilot_internal/user response (e.g., premium_interactions entitlement). */
	private _copilotQuotaEntitlements: {
		premium_interactions?: number;
		completions?: number;
		/** Raw quota_remaining from the premium_interactions snapshot (in AI Credits). */
		premium_interactions_remaining?: number;
	} = {};
	/** Copilot budget per GitHub account signed in to VS Code (not only the one this extension prefers). */
	private _accountBudgets: AccountBudget[] = [];
	/** Monotonic id of the latest account-budget refresh, so a slow stale lookup can't overwrite a newer one. */
	private _accountBudgetsRefreshSeq = 0;
	/**
	 * Bumped whenever the preferred account's plan/quota state is cleared, and at the start of every
	 * plan load. An in-flight loadAndLogCopilotPlanInfo() holds the value it started with and discards
	 * its results once it no longer matches (sign-out, account removed or switched, or a newer load).
	 */
	private _preferredPlanGeneration = 0;
	/** Id of the GitHub account the cached plan/quota state belongs to, so an account switch can drop it. */
	private _preferredPlanAccountId: string | undefined;
	/**
	 * Monotonic id shared by every path that discovers the preferred session and assigns `githubSession`
	 * (startup restore, the auth-session listener, explicit sign-in, sign-out). Each takes a number before
	 * its `getSession()` await and discards its result if the number is no longer current, so an older
	 * lookup that finishes last cannot overwrite a newer one (or an explicit sign-out) with a stale account.
	 */
	private _sessionLookupSeq = 0;
	/** Counts explicit sign-outs, so an interactive sign-in that was pending across one can tell and stand down. */
	private _signOutCount = 0;

	// Cached PR stats result for the repos tab (mirrors the shared snapshot on disk)
	private _lastRepoPrStats?: RepoPrStatsResult;

	// True while this window is refreshing the shared repository-PRs snapshot from the GitHub API
	private _repoPrRefreshInFlight = false;

	// Cached cloud agent sessions result for the cloud agent tab (mirrors the shared snapshot on disk)
	private _lastAgentSessionsData?: AgentSessionsResult;

	// True while this window is refreshing the shared cloud-agent snapshot from the GitHub API
	private _agentSessionsRefreshInFlight = false;

	// Tool name mapping - loaded from toolNames.json for friendly display names
	private toolNameMap: { [key: string]: string } = toolNamesData as { [key: string]: string };

	// Backend facade instance for accessing table storage data
	public backend: BackendFacade | undefined;

	// Helper method to get repository URL from package.json
	private getRepositoryUrl(): string {
		return _getRepositoryUrl();
	}

	/**
	 * Determine the editor type from a session file path
	 * Returns: 'VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Copilot CLI', or 'Unknown'
	 */
	/**
	 * Detect the actual mode type from inputState.mode object.
	 * Returns 'ask', 'edit', 'agent', 'plan', or 'customAgent'.
	 */
	private getModeType(mode: any): 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' {
		return _getModeType(mode);
	}

	/**
	 * Extract custom agent name from a file:// URI pointing to a .agent.md file.
	 * Returns the filename without the .agent.md extension.
	 */
	public getEditorTypeFromPath(filePath: string): string {
		return this._resolveEditorLabel(filePath) ??
			_getEditorTypeFromPath(filePath, (p) => this.findEcosystem(p)?.id === 'opencode');
	}

	/**
	 * Resolves a session-specific editor label from the adapter that handles OR
	 * discovered the file. Returns undefined when no adapter provides a specific label.
	 * This covers both:
	 *  - handled files (adapter.handles() = true): uses getDisplayName()
	 *  - discovered-only files (events.jsonl): uses getDisplayNameForDiscoveredPath()
	 */
	private _resolveEditorLabel(filePath: string): string | undefined {
		const eco = this.findEcosystem(filePath);
		if (eco) {
			const specificName = getEcosystemDisplayName(eco, filePath);
			if (specificName !== eco.displayName) { return specificName; }
			return undefined;
		}
		// File not handled by any adapter — check if any discoverable adapter knows it
		for (const adapter of this.ecosystems) {
			const label = adapter.getDisplayNameForDiscoveredPath?.(filePath);
			if (label !== undefined) { return label; }
		}
		return undefined;
	}

	/** Returns the first adapter that claims this session file, or null for Copilot Chat sessions. */
	private findEcosystem(sessionFile: string): IEcosystemAdapter | null {
		const known = this._ecosystemByPath.get(sessionFile);
		if (known !== undefined) { return known; }
		const found = this.ecosystems.find(e => e.handles(sessionFile)) ?? null;
		if (this._ecosystemByPath.size >= 50_000) { this._ecosystemByPath.clear(); }
		this._ecosystemByPath.set(sessionFile, found);
		return found;
	}

	/**
	 * Which adapter owns a session path. Asked several times per file by every view (labels, details, stats), and
	 * each ask walks all ~22 adapters' path checks on the host thread, so with thousands of files and several views
	 * open at once that alone was a sizeable share of the host's stalls. Which adapter handles a path does not
	 * change during a session, so it is remembered.
	 */
	private readonly _ecosystemByPath = new Map<string, IEcosystemAdapter | null>();

	/**
	 * Stat a session file, handling virtual paths for both OpenCode and Crush.
	 * Must be used instead of fs.promises.stat() directly.
	 */
	public async statSessionFile(sessionFile: string): Promise<import('fs').Stats> {
		const eco = this.findEcosystem(sessionFile);
		if (eco) { return eco.stat(sessionFile); }
		if (this.windsurf.isWindsurfSessionFile(sessionFile)) {
			const session = await this.windsurf.resolveSession(sessionFile);
			if (session) {
				const baseStats = await fs.promises.stat(__filename);
				Object.defineProperty(baseStats, 'mtime', { value: new Date(session.modified), writable: false });
				Object.defineProperty(baseStats, 'size', { value: session.size, writable: false });
				return baseStats;
			}
			return fs.promises.stat(__filename);
		}
		return fs.promises.stat(sessionFile);
	}

	/**
	 * Run async tasks over session files with bounded concurrency (default: 10).
	 * Prevents I/O saturation when processing hundreds of session files in parallel.
	 */
	private async runWithConcurrency<R>(
		files: string[],
		fn: (file: string, index: number) => Promise<R>,
		limit = 10
	): Promise<(R | undefined)[]> {
		if (files.length === 0) { return []; }
		const results: (R | undefined)[] = new Array(files.length);
		let idx = 0;
		const workers = Array.from({ length: Math.min(limit, files.length) }, async () => {
			while (idx < files.length) {
				const i = idx++;
				try { results[i] = await fn(files[i], i); } catch { results[i] = undefined; }
			}
		});
		await Promise.all(workers);
		return results;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Determine a friendly editor name from an editor root path (folder name)
	 * e.g. 'C:\...\AppData\Roaming\Code' -> 'VS Code'
	 */
	private getEditorNameFromRoot(rootPath: string): string {
		return _getEditorNameFromRoot(rootPath);
	}

	/**
	 * Extract a friendly display name from a repository URL.
	 * Supports HTTPS, SSH, and git:// URLs.
	 * @param repoUrl The full repository URL
	 * @returns A shortened display name like "owner/repo"
	 */
	private getRepoDisplayName(repoUrl: string): string {
		return _getRepoDisplayName(repoUrl);
	}

	// Logging methods
	public log(message: string): void {
		if (this._disposed) { return; }
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ${message}`);
	}

	public warn(message: string): void {
		if (this._disposed) { return; }
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] WARNING: ${message}`);
	}

	private error(message: string, error?: any): void {
		if (this._disposed) { return; }
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
		if (error) {
			this.outputChannel.appendLine(`[${timestamp}] ${error}`);
		}
	}

	/**
	 * Dispatch a webview command with in-flight deduplication and error handling.
	 * If a command with the same key is already executing, the new call is silently dropped.
	 * Use panel-prefixed keys for panel-specific commands (e.g. 'refresh:details') and plain
	 * command names for shared navigation commands (e.g. 'showDetails').
	 */
	private async dispatch(commandKey: string, handler: () => unknown): Promise<void> {
		if (this._inFlightCommands.has(commandKey)) {
			this.log(`⏳ Command '${commandKey}' already in flight, skipping`);
			return;
		}
		this._inFlightCommands.add(commandKey);
		try {
			await handler();
		} catch (error) {
			this.error(`Webview command '${commandKey}' failed`, error);
			vscode.window.showErrorMessage(`Operation failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this._inFlightCommands.delete(commandKey);
		}
	}

	public registerExtensionPointButton(button: ExtensionPointButton, handler: () => void | Promise<void>): { dispose(): void } {
		this._extensionPointButtons.set(button.id, { config: button, handler });
		this.broadcastExtensionPointButtons();
		return {
			dispose: () => {
				this._extensionPointButtons.delete(button.id);
				this.broadcastExtensionPointButtons();
			},
		};
	}

	private extensionPointButtonsScript(nonce: string): string {
		const data = [...this._extensionPointButtons.values()].map(e => ({ id: e.config.id, label: e.config.label }));
		return `<script nonce="${nonce}">window.__EXTENSION_POINT_BUTTONS__ = ${JSON.stringify(data)};</script>`;
	}

	/**
	 * Pushes the current extension-point button list to every open webview panel so a button
	 * registered — or disposed — by a companion extension after a panel's HTML was already
	 * generated still shows up (or disappears) live. The inline `window.__EXTENSION_POINT_BUTTONS__`
	 * bootstrap only ever captures a snapshot taken at HTML-generation time, so panels that were
	 * already open need this message-based follow-up. See `wireExtensionPointButtons` in
	 * `src/webview/shared/extensionPoints.ts`, which reconciles its button row idempotently.
	 */
	private broadcastExtensionPointButtons(): void {
		const data = [...this._extensionPointButtons.values()].map(e => ({ id: e.config.id, label: e.config.label }));
		const panels = [
			this.analysisPanel,
			this.detailsPanel,
			this.chartPanel,
			this.dashboardPanel,
			this.diagnosticsPanel,
			this.maturityPanel,
			this.fluencyLevelViewerPanel,
			this.environmentalPanel,
			this.efficiencyPanel,
			this.whatsNewPanel,
		];
		for (const panel of panels) {
			if (panel && this.isPanelOpen(panel)) {
				void panel.webview.postMessage({ command: 'extensionPointButtonsUpdated', buttons: data });
			}
		}
	}

	private async handleExtensionPointAction(buttonId: string): Promise<boolean> {
		const entry = this._extensionPointButtons.get(buttonId);
		if (!entry) { return false; }
		await this.dispatch(`extensionPoint:${buttonId}`, () => entry.handler());
		return true;
	}

	/**
	 * Dispatch a shared navigation command that is common across all webview panels.
	 * Returns true if the command was recognised and dispatched, false if it is panel-specific.
	 */
	private async dispatchSharedCommand(message: { command: string; [key: string]: any }): Promise<boolean> {
		if (message.command === 'openToolPicker') {
			this.log(`📨 dispatchSharedCommand received: ${message.command}`);
		}
		if (message.command === 'extensionPointAction' && typeof message.buttonId === 'string') {
			return this.handleExtensionPointAction(message.buttonId);
		}
		const handlers: Record<string, () => unknown> = {
			// Plain opens go through openView so they also cancel any deep link still
			// pending for that view (see openViewSurface).
			showDetails:            () => this.openView('details'),
			showChart:              () => this.openView('chart'),
			showUsageAnalysis:      () => this.openView('usage'),
			// Distinct from showUsageAnalysis: that handler deliberately ignores payload
			// properties, so a tab can only be requested through its own command.
			showUsageAnalysisRepoPrs: () => this.showUsageAnalysisOnReposTab(),
			showDiagnostics:        () => this.openView('diagnostics'),
			showMaturity:           () => this.openView('maturity'),
			showReadiness:          () => this.showReadiness(),
			showDashboard:          () => this.openView('dashboard'),
			showEnvironmental:      () => this.openView('environmental'),
			showEfficiency:         () => this.openView('efficiency'),
			showFluencyLevelViewer: () => this.openView('fluency-level-viewer'),
			showWhatsNew:           () => this.openView('whatsnew'),
			// Panels report their own tab switches so the what's-new announcer can tell
			// which subviews the user has already found. Fire-and-forget by design: the
			// webview must never wait on bookkeeping to render a tab.
			viewTabOpened:          () => {
				const view = typeof message.view === 'string' ? message.view : '';
				const tab = typeof message.tab === 'string' ? message.tab : undefined;
				if (view) { this.recordViewVisit(view as FeatureViewId, tab); }
			},
			// Navigation is started, not awaited: dispatch() drops a command whose key is
			// still in flight, so awaiting a slow cold open (e.g. Details loading its data)
			// would silently swallow the user's next pick. A newer navigation supersedes an
			// older one by itself (surfaceNavGeneration, the reveal queue's request ids).
			openWhatsNewFeature:    () => {
				if (typeof message.featureId === 'string' && message.featureId) {
					this.startNavigation(`What's New feature "${message.featureId}"`, () => this.openWhatsNewFeature(message.featureId));
				}
			},
			openViewIndexEntry:     () => {
				if (typeof message.entryId === 'string' && message.entryId) {
					this.startNavigation(`View index entry "${message.entryId}"`, () => this.openViewIndexEntry(message.entryId));
				}
			},
			// A panel's script is now listening: hand it any navigation that was
			// requested while the panel was still being created.
			surfaceNavReady:        () => {
				if (typeof message.view === 'string') { this.flushPendingSurfaceReveal(message.view as FeatureViewId); }
			},
			// The webview acted on a revealSurface request: nothing is left to replay.
			surfaceRevealHandled:   () => {
				if (typeof message.view === 'string') {
					this.surfaceReveals.handled(message.view as FeatureViewId, typeof message.requestId === 'number' ? message.requestId : undefined);
				}
			},
			openFile:               () => {
				if (typeof message.path === 'string' && message.path) {
					void vscode.window.showTextDocument(vscode.Uri.file(message.path));
				}
			},
			openToolPicker:         async () => this._handleOpenToolPickerCommand(),
			openFileFromList:       async () => {
				const paths: unknown = message.paths;
				if (!Array.isArray(paths) || paths.length === 0) { return; }
				const stringPaths = paths.filter((p): p is string => typeof p === 'string');
				if (stringPaths.length === 1) {
					await vscode.window.showTextDocument(vscode.Uri.file(stringPaths[0]));
					return;
				}
				const items = stringPaths.map(p => ({ label: path.basename(path.dirname(p)) + '/' + path.basename(p), description: p, fsPath: p }));
				const picked = await vscode.window.showQuickPick(items, { title: 'Open MCP config file', placeHolder: 'Select which config file to open' });
				if (picked) { await vscode.window.showTextDocument(vscode.Uri.file(picked.fsPath)); }
			},
			searchMcpExtensions:    () => vscode.commands.executeCommand('workbench.extensions.search', '@tag:mcp'),
			'workbench.extensions.action.showExtensions': () =>
				vscode.commands.executeCommand('workbench.extensions.action.showExtensions'),
			openAgentPlugins:       () => {
				// Open the Extensions view filtered to agent plugins. When a plugin name
				// is provided the query becomes "@agentPlugins <name>" so the user lands
				// directly on the relevant plugin rather than the whole installed list.
				const pluginName = typeof message.pluginName === 'string' && message.pluginName ? message.pluginName : '';
				const query = pluginName ? `@agentPlugins ${pluginName}` : '@agentPlugins';
				return vscode.commands.executeCommand('workbench.extensions.search', query);
			},
			manageExtension:        async () => {
				// Open the Extensions view details pane for a specific extension.
				// VS Code can't tell us whether the user disabled the extension's tools in the chat
				// tool picker (no public API), so the only honest action we can offer for
				// extension-contributed MCP servers is "go look at / uninstall the extension".
				const extensionId = typeof message.extensionId === 'string' ? message.extensionId : '';
				if (!extensionId) { return; }
				try {
					await vscode.commands.executeCommand('extension.open', extensionId);
				} catch (err) {
					this.log(`manageExtension: extension.open failed for ${extensionId}: ${err instanceof Error ? err.message : String(err)}`);
					// Fallback: search the marketplace view for the extension ID
					await vscode.commands.executeCommand('workbench.extensions.search', `@id:${extensionId}`);
				}
			},
		};
		const handler = handlers[message.command];
		if (!handler) {
			// Forward fully-qualified extension commands (e.g. from insight card buttons)
			if (message.command.startsWith('aiEngineeringFluency.')) {
				await vscode.commands.executeCommand(message.command);
				return true;
			}
			return false;
		}
		await this.dispatch(message.command, handler);
		return true;
	}

	private async _handleOpenToolPickerCommand(): Promise<void> {
		this.log('🔧 openToolPicker: handler invoked');
		const allCommands = await vscode.commands.getCommands(true);
		const configureToolsId = 'workbench.action.chat.configureTools';
		const hasConfigure = allCommands.includes(configureToolsId);
		this.log(`🔧 openToolPicker: '${configureToolsId}' registered = ${hasConfigure}`);
		if (!hasConfigure) {
			this.log('🔧 openToolPicker: command not registered, opening chat panel + notifying user');
			await vscode.commands.executeCommand('workbench.action.chat.open');
			void vscode.window.showInformationMessage(
				'To manage tools, click the Tools (⚙) button in the GitHub Copilot Chat input area.'
			);
			return;
		}
		// ConfigureToolsAction requires: (1) chat in Agent mode, (2) a focused chat widget.
		try {
			this.log('🔧 openToolPicker: opening chat in agent mode');
			await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
		} catch (err) {
			this.log(`🔧 openToolPicker: chat.open failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			this.log(`🔧 openToolPicker: executing '${configureToolsId}'`);
			await vscode.commands.executeCommand(configureToolsId);
			this.log('🔧 openToolPicker: command executed successfully');
		} catch (err) {
			this.log(`🔧 openToolPicker: command failed: ${err instanceof Error ? err.message : String(err)}`);
			void vscode.window.showErrorMessage(
				`Could not open tool picker: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private consumeLocalViewRegressionProbe(viewId: string): ViewRegressionProbeConfig | undefined {
		const probe = this.pendingLocalViewRegressionProbe;
		if (probe?.viewId !== viewId) {
			return undefined;
		}
		this.pendingLocalViewRegressionProbe = undefined;
		return probe;
	}

	private getLocalViewRegressionProbeScript(viewId: string, nonce: string): string {
		return createViewRegressionProbeScript(nonce, this.consumeLocalViewRegressionProbe(viewId));
	}

	/**
	 * Returns a <script> block that injects the JSON config files as window globals,
	 * so the webview bundles no longer need to bundle them inline.
	 * All views receive all four globals; the small extra payload is negligible.
	 */
	private getJsonConfigScript(nonce: string): string {
		const estimators = JSON.stringify(tokenEstimatorsData).replace(/</g, '\\u003c');
		const pricing    = JSON.stringify(modelPricingData).replace(/</g, '\\u003c');
		const tools      = JSON.stringify(toolNamesData).replace(/</g, '\\u003c');
		const autoTools  = JSON.stringify(automaticToolsData).replace(/</g, '\\u003c');
		return `<script nonce="${nonce}">` +
			`window.__TOKEN_ESTIMATORS__=${estimators};` +
			`window.__MODEL_PRICING__=${pricing};` +
			`window.__TOOL_NAMES__=${tools};` +
			`window.__AUTOMATIC_TOOLS__=${autoTools};` +
			`</script>`;
	}

	private handleLocalViewRegressionMessage(message: any): boolean {
		if (message?.command !== 'localViewRegressionReport' || typeof message.runId !== 'string') {
			return false;
		}

		const resolve = this.localViewRegressionResolvers.get(message.runId);
		if (!resolve) {
			return true;
		}

		this.localViewRegressionResolvers.delete(message.runId);
		resolve({
			pass: Boolean(message.pass),
			summary: typeof message.summary === 'string' ? message.summary : 'Local view regression probe finished.',
			timedOut: Boolean(message.timedOut),
			metrics: typeof message.metrics === 'object' && message.metrics
				? message.metrics as ViewRegressionProbeSnapshot
				: undefined,
		});
		return true;
	}

	private getBundledLocalViewRegressionSampleDir(): string {
		return path.join(this.extensionUri.fsPath, 'test', 'fixtures', 'sample-session-data', 'chatSessions');
	}

	private async ensureLocalViewRegressionSampleDir(): Promise<string> {
		const sampleDir = this.getBundledLocalViewRegressionSampleDir();
		await fs.promises.access(sampleDir);
		return sampleDir;
	}

	private async runLocalViewRegressionCase(viewCase: LocalViewRegressionCase): Promise<LocalViewRegressionResult> {
		viewCase.reset();
		const runId = `${viewCase.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const probePromise = new Promise<LocalViewRegressionProbeResult>((resolve) => {
			let settled = false;
			const finish = (result: LocalViewRegressionProbeResult) => {
				if (settled) {
					return;
				}
				settled = true;
				this.localViewRegressionResolvers.delete(runId);
				resolve(result);
			};

			this.localViewRegressionResolvers.set(runId, finish);
			setTimeout(() => {
				finish({
					pass: false,
					summary: `No regression probe response received within ${Math.round(viewCase.timeoutMs / 1000)}s.`,
					timedOut: true,
				});
			}, viewCase.timeoutMs + 750).unref();
		});

		try {
			this.pendingLocalViewRegressionProbe = {
				runId,
				viewId: viewCase.id,
				title: viewCase.title,
				timeoutMs: viewCase.timeoutMs,
				expectations: viewCase.expectations,
			};
			await viewCase.open();
		} catch (error) {
			this.pendingLocalViewRegressionProbe = undefined;
			this.localViewRegressionResolvers.delete(runId);
			return {
				id: viewCase.id,
				title: viewCase.title,
				status: 'fail',
				detail: error instanceof Error ? error.message : String(error),
				dataPoints: viewCase.dataPoints,
			};
		}

		const probeResult = await probePromise;
		const evaluated = probeResult.metrics
			? evaluateViewRegressionProbe(viewCase.expectations, probeResult.metrics)
			: { pass: probeResult.pass, summary: probeResult.summary };

		return {
			id: viewCase.id,
			title: viewCase.title,
			status: evaluated.pass ? 'pass' : 'fail',
			detail: probeResult.summary || evaluated.summary,
			dataPoints: viewCase.dataPoints,
			probe: probeResult.metrics,
		};
	}

	public async runLocalViewRegression(): Promise<void> {
		if (this.context.extensionMode !== vscode.ExtensionMode.Development) {
			await vscode.window.showWarningMessage('Local view regression is only available in the Extension Development Host.');
			return;
		}
		this.outputChannel.show(true);
		const previousSampleDir = this.localRegressionSampleDataDir;
		this.localRegressionSampleDataDir = '';
		this.sessionDiscovery.clearCache();
		this.lastDetailedStats = this.lastDailyStats = this.lastFullDailyStats = this.lastUsageAnalysisStats = undefined;
		this.lastEfficiencySessionInputs = undefined;
		this._lastEfficiencyViewData = undefined;
		this._cacheGeneration++;
		const results: LocalViewRegressionResult[] = [];
		let dataSourceLabel = 'local session data';
		// Populated once setupRegressionSessionFiles() resolves, so the finally block can evict
		// exactly these entries from cacheManager.cache — see the finally block's comment for why.
		let regressionSessionFiles: string[] = [];
		let usedBundledFixtures = false;
		try {
			const setup = await this.setupRegressionSessionFiles(dataSourceLabel);
			dataSourceLabel = setup.dataSourceLabel;
			regressionSessionFiles = setup.sessionFiles;
			usedBundledFixtures = setup.usedBundledFixtures;
			this.log(`🧪 Starting local view regression using ${dataSourceLabel}. Found ${setup.sessionFiles.length} session file(s).`);
			const stats = await this.computeRegressionStats(dataSourceLabel, setup.sessionFiles);
			const cases = this.buildLocalViewRegressionCases(stats, setup.sessionFiles);
			for (const viewCase of cases) { results.push(await this.runLocalViewRegressionCase(viewCase)); }
			results.push({ id: 'dashboard', title: 'Team Dashboard', status: 'skip', detail: 'Skipped because this view requires a configured backend.' });
		} catch (error) {
			results.push({ id: 'regression-runner', title: 'Local regression runner', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
		} finally {
			this.pendingLocalViewRegressionProbe = undefined;
			this.localRegressionSampleDataDir = previousSampleDir;
			this.sessionDiscovery.clearCache();
			// setupRegressionSessionFiles() falls back to the bundled fixture directory only when
			// this machine has zero real session files (the common case in a clean CI runner —
			// exactly where the visual-view-diff/screenshot harness runs); computeRegressionStats()
			// then parses those fixture files through the normal pipeline, which unconditionally
			// populates cacheManager.cache (getSessionFileDataCached() -> setCachedSessionData()).
			// persistRefreshResult()/maybeCheckpointCache() being skipped in sample-data mode only
			// stops that from reaching disk — it does nothing about the in-memory cache, which
			// getDeduplicatedCacheEntries() (the cache-only instant paint, the cache-seeded preload
			// queue) reads directly. Without evicting here, the very next normal refresh in this
			// same session — no restart needed — would seed/paint from these fixture entries
			// alongside or instead of real ones.
			//
			// Only run this eviction when fixtures were actually used (usedBundledFixtures). When a
			// developer runs this locally on a machine WITH real session data, regressionSessionFiles
			// is that real, entire discovered set — tombstoning it isn't merely "one avoidable
			// reparse" (deleteCachedSessionData() persists past this run): buildMergedSnapshotEntries()
			// excludes tombstoned paths from every subsequent save, so a normal refresh's checkpoint
			// or snapshot publish landing before the next full re-parse completes would wipe those
			// real sessions from the shared on-disk snapshot too, not just this window's memory.
			if (usedBundledFixtures) {
				await this.evictRegressionSessionFilesFromCache(regressionSessionFiles);
			}
			this.lastDetailedStats = this.lastDailyStats = this.lastFullDailyStats = this.lastUsageAnalysisStats = this.lastDashboardData = undefined;
			this.lastEfficiencySessionInputs = undefined;
			this._lastEfficiencyViewData = undefined;
			this._cacheGeneration++;
		}
		await this.reportLocalViewRegressionResults(results, dataSourceLabel);
	}

	// Called only when usedBundledFixtures is true (see runLocalViewRegression()'s finally block):
	// evicting real discovered sessions unconditionally isn't just "one avoidable reparse" —
	// deleteCachedSessionData() tombstones the path, and buildMergedSnapshotEntries() excludes every
	// tombstoned path from every subsequent save, so a normal refresh's checkpoint/publish landing
	// before the next full re-parse completes would wipe those real sessions from the shared
	// on-disk snapshot too, not just this window's memory.
	private async evictRegressionSessionFilesFromCache(regressionSessionFiles: string[]): Promise<void> {
		// Swept by normalized key, not the exact raw strings setupRegressionSessionFiles() returned:
		// a same-file spelling variant already sitting in the cache under a different raw key
		// (case/separator) would otherwise survive this eviction and still be readable by the very
		// next getDeduplicatedCacheEntries() call.
		const regressionKeys = new Set(regressionSessionFiles.map(f => _normalizePathForDedup(f)));
		if (regressionKeys.size === 0) { return; }
		let evictedAny = false;
		for (const rawPath of Array.from(this.cacheManager.cache.keys())) {
			if (regressionKeys.has(_normalizePathForDedup(rawPath))) {
				this.cacheManager.deleteCachedSessionData(rawPath);
				evictedAny = true;
			}
		}
		// The eviction above only tombstones these paths in memory. A prior run (before the
		// sample-mode save guards existed, or a checkpoint that raced this eviction) could have
		// already written fixture entries to the shared on-disk snapshot; those would otherwise
		// linger untouched until some later save happens to occur, and the next process boot would
		// instant-paint them as real usage in the meantime. Persist now, while sample mode is
		// confirmed off again (runLocalViewRegression()'s finally block just restored the previous
		// sample dir before calling this), so the tombstones actually reach disk.
		if (evictedAny && !this.isSampleDataModeActive()) {
			try { await this.trySaveCacheToStorage(); }
			catch (err) { console.error(`Failed to persist regression cache eviction: ${err}`); }
		}
	}

	private async setupRegressionSessionFiles(defaultLabel: string): Promise<{ sessionFiles: string[]; dataSourceLabel: string; usedBundledFixtures: boolean }> {
		let sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
		if (sessionFiles.length > 0) { return { sessionFiles, dataSourceLabel: defaultLabel, usedBundledFixtures: false }; }
		let sampleDir: string;
		try { sampleDir = await this.ensureLocalViewRegressionSampleDir(); }
		catch { throw new Error('Bundled sample session data was not found. Expected test fixtures under vscode-extension\\test\\fixtures\\sample-session-data\\chatSessions.'); }
		this.localRegressionSampleDataDir = sampleDir;
		this.sessionDiscovery.clearCache();
		sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
		return { sessionFiles, dataSourceLabel: `bundled sample data (${sampleDir})`, usedBundledFixtures: true };
	}

	private async computeRegressionStats(dataSourceLabel: string, sessionFiles: string[]): Promise<{ detailedStats: any; dailyStats: any; usageStats: any; maturityData: any; diagnosticReport: string; fluencyLevelData: any; chartTotals: any }> {
		const detailedStats = await this.updateTokenStats(true);
		if (!detailedStats) { throw new Error(`Failed to calculate detailed stats from ${dataSourceLabel}.`); }
		const dailyStats = this.currentDailyStats ?? await this.trackFullYearBackfill(this.calculateDailyStats());
		const usageStats = await this.calculateUsageAnalysisStats(false);
		const maturityData = await this.calculateMaturityScores(false);
		const diagnosticReport = await this.generateDiagnosticReport();
		const fluencyLevelData = this.getFluencyLevelData(true);
		const chartTotals = this.buildChartData(dailyStats);
		return { detailedStats, dailyStats, usageStats, maturityData, diagnosticReport, fluencyLevelData, chartTotals };
	}

	private buildLocalViewRegressionCases(stats: any, sessionFiles: string[]): LocalViewRegressionCase[] {
		const { detailedStats, usageStats, maturityData, diagnosticReport, fluencyLevelData, chartTotals } = stats;
		const totalFluencyLevels = fluencyLevelData.categories.reduce((sum: number, c: any) => sum + c.levels.length, 0);
		const categoriesWithEvidence = maturityData.categories.filter((c: any) => c.evidence.length > 0).length;
		return [
			{ id: 'details', title: 'Details', timeoutMs: 25000, expectations: { minRootChildren: 1, minBodyTextLength: 120, minRootTextLength: 80 }, dataPoints: [{ label: 'today tokens', value: detailedStats.today.tokens }, { label: '30d tokens', value: detailedStats.last30Days.tokens }, { label: '30d sessions', value: detailedStats.last30Days.sessions }], reset: () => this.detailsPanel?.dispose(), open: () => this.showDetails() },
			{ id: 'chart', title: 'Chart', timeoutMs: 25000, expectations: { minRootChildren: 1, minBodyTextLength: 20, minCanvasOrSvg: 1 }, dataPoints: [{ label: 'days', value: chartTotals.dailyCount }, { label: 'tokens', value: chartTotals.totalTokens }, { label: 'sessions', value: chartTotals.totalSessions }], reset: () => this.chartPanel?.dispose(), open: () => this.showChart() },
			{ id: 'usage', title: 'Usage Analysis', timeoutMs: 25000, expectations: { minRootChildren: 1, minBodyTextLength: 140, minRootTextLength: 80 }, dataPoints: [{ label: '30d sessions', value: usageStats.last30Days.sessions }, { label: 'repos', value: usageStats.last30Days.repositories.length }, { label: 'tool calls', value: usageStats.last30Days.toolCalls.total }], reset: () => this.analysisPanel?.dispose(), open: () => this.showUsageAnalysis() },
			{ id: 'maturity', title: 'Fluency Score', timeoutMs: 25000, expectations: { minRootChildren: 1, minBodyTextLength: 120, minRootTextLength: 80 }, dataPoints: [{ label: 'overall', value: maturityData.overallLabel }, { label: 'categories', value: maturityData.categories.length }, { label: 'with evidence', value: categoriesWithEvidence }], reset: () => this.maturityPanel?.dispose(), open: () => this.showMaturity() },
			{ id: 'environmental', title: 'Environmental Impact', timeoutMs: 25000, expectations: { minRootChildren: 1, minBodyTextLength: 100, minRootTextLength: 70 }, dataPoints: [{ label: '30d tokens', value: detailedStats.last30Days.tokens }, { label: 'CO2 g', value: detailedStats.last30Days.co2.toFixed(2) }, { label: 'water L', value: detailedStats.last30Days.waterUsage.toFixed(2) }], reset: () => this.environmentalPanel?.dispose(), open: () => this.showEnvironmental() },
			{ id: 'diagnostics', title: 'Diagnostics', timeoutMs: 30000, expectations: { minRootChildren: 1, minBodyTextLength: 140, minRootTextLength: 80, disallowTextPatterns: ['loading...'] }, dataPoints: [{ label: 'session files', value: sessionFiles.length }, { label: 'report lines', value: diagnosticReport.split(/\r?\n/).length }], reset: () => this.diagnosticsPanel?.dispose(), open: () => this.showDiagnosticReport() },
			{ id: 'whatsnew', title: "What's New", timeoutMs: 20000, expectations: { minRootChildren: 1, minBodyTextLength: 120, minRootTextLength: 80 }, dataPoints: [{ label: 'releases', value: WHATS_NEW_RELEASES.slice(0, WHATS_NEW_MAX_RELEASES).length }, { label: 'features', value: WHATS_NEW_RELEASES.slice(0, WHATS_NEW_MAX_RELEASES).reduce((sum, r) => sum + r.features.length, 0) }], reset: () => this.whatsNewPanel?.dispose(), open: () => this.showWhatsNew() },
			{ id: 'fluency-level-viewer', title: 'Fluency Level Viewer', timeoutMs: 25000, expectations: { minRootChildren: 1, minBodyTextLength: 120, minRootTextLength: 80 }, dataPoints: [{ label: 'categories', value: fluencyLevelData.categories.length }, { label: 'levels', value: totalFluencyLevels }], reset: () => this.fluencyLevelViewerPanel?.dispose(), open: () => this.showFluencyLevelViewer() },
		];
	}

	private async reportLocalViewRegressionResults(results: LocalViewRegressionResult[], dataSourceLabel: string): Promise<void> {
		const report = formatLocalViewRegressionReport(results);
		this.outputChannel.appendLine('');
		for (const line of report.split(/\r?\n/)) { this.outputChannel.appendLine(line); }
		this.outputChannel.appendLine('');
		const failures = results.filter((r) => r.status === 'fail').length;
		const passed = results.filter((r) => r.status === 'pass').length;
		const skipped = results.filter((r) => r.status === 'skip').length;
		const summary = failures === 0
			? `Local view regression passed: ${passed} view(s), ${skipped} skipped. Data source: ${dataSourceLabel}.`
			: `Local view regression found ${failures} failing view(s). Data source: ${dataSourceLabel}. See the output channel for details.`;
		const choice = failures === 0
			? await vscode.window.showInformationMessage(summary, 'Show Output')
			: await vscode.window.showWarningMessage(summary, 'Show Output');
		if (choice === 'Show Output') { this.outputChannel.show(true); }
	}

	// Cache management methods
	/**
	 * Checks if the cache is valid for a file by comparing mtime and size.
	 * If the cache entry is missing size (old format), treat as invalid so it will be upgraded.
	 */

	private getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.cacheManager.getCachedSessionData(filePath);
	}

	/**
	 * Sets the cache entry for a session file, including file size.
	 */
	private setCachedSessionData(filePath: string, data: SessionFileCache, fileSize?: number): void {
		return this.cacheManager.setCachedSessionData(filePath, data, fileSize);
	}


	/**
	 * Generate a cache identifier based on VS Code extension mode.
	 * VS Code editions (stable vs insiders) already have separate globalState storage,
	 * so we only need to distinguish between production and development (debug) mode.
	 * In development mode, each VS Code window gets a unique cache identifier using
	 * the session ID, preventing the Extension Development Host from sharing/fighting
	 * with the main dev window's cache.
	 */

	/**
	 * Get the path for the cache lock file.
	 * Uses globalStorageUri which is already scoped per VS Code edition.
	 */

	/**
	 * Acquire an exclusive file lock for cache writes.
	 * Uses atomic file creation (O_EXCL / CREATE_NEW) to prevent concurrent writes
	 * across multiple VS Code windows of the same edition.
	 * Returns true if lock acquired, false if another instance holds it.
	 */

	/**
	 * Release the cache lock file, but only if we own it.
	 */

	// Persistent cache storage methods

	/**
	 * One-time migration: remove old per-session cache keys that were created by
	 * earlier versions of the extension (keys containing sessionId or timestamp).
	 * Also removes the legacy unscoped keys ('sessionFileCache', 'sessionFileCacheVersion').
	 */

	private async trySaveCacheToStorage(): Promise<boolean> {
		return this.cacheManager.trySaveCacheToStorage();
	}

	public async clearCache(): Promise<void> {
		try {
			// Show the output channel so users can see what's happening
			this.outputChannel.show(true);
			this.log('Clearing session file cache...');

			// Wait out a pre-existing refresh (a timer or an earlier manual Refresh, never this
			// call's own — that one is started below, after clearing) that is still mid-
			// _preloadSessionFiles(): its foreground workers call setCachedSessionData() directly
			// for every file that hasn't hit the deferred-parse timeout yet, and
			// awaitAllDeferredParses() only knows about parses already registered as deferred — a
			// worker still on its first, ordinary (non-deferred) pass over a file is invisible to
			// it. Settling this promise doesn't require the run to actually finish quickly: its own
			// isRefreshSuperseded() check (against the generation this clear is about to bump) makes
			// it discard its results without publishing once it notices, exactly as a caller of
			// updateTokenStats() arriving after a clear already waits it out (see that method's own
			// "waiting it out before refreshing" branch).
			//
			// Looped rather than a single pass: awaitAllDeferredParses() below can await real,
			// I/O-bound parses, which yields to the event loop for real time — long enough for an
			// unrelated timer-triggered refresh to start and populate _updateTokenStatsInFlight with
			// a run this call never captured. Re-checking after every pass closes that window; the
			// loop only exits once one full pass finds nothing left to wait for.
			while (this._updateTokenStatsInFlight || this._deferredSessionPreloadPromises.size > 0 || this._pendingFullYearBackfills.size > 0) {
				const preClearRefresh = this._updateTokenStatsInFlight;
				if (preClearRefresh) {
					await preClearRefresh.catch(() => undefined);
				}

				// Every full-year chart backfill currently running (see _pendingFullYearBackfills'
				// own doc comment for its two call sites) is invisible to the wait above — one is
				// dispatched fire-and-forget only after its refresh's own promise already resolved,
				// and the other runs on a separate foreground call chain entirely. Without this, any
				// of them could still be reparsing older session files and calling
				// setCachedSessionData() well after the wait above returns, repopulating the cache
				// this command is about to empty. Snapshotted before awaiting: a backfill that
				// finishes deletes itself from the live set mid-loop, and a new one can start while
				// we wait — the outer while-loop's re-check catches that.
				const pendingBackfills = [...this._pendingFullYearBackfills];
				await Promise.all(pendingBackfills.map(backfill => backfill.catch(() => undefined)));

				// Wait out any deferred (backgrounded) parse still finishing from a refresh that
				// already returned — without this, its setCachedSessionData() call could land after
				// the synchronous clear below and silently repopulate the cache this command just
				// emptied. Run after the wait above: that run's own workers can defer new parses to
				// the background while this call was waiting on it, and those need to be covered too.
				// Safe to await before the invalidation block: the generation hasn't bumped yet, so a
				// build reading the cache during this wait sees the pre-clear generation it would
				// have seen anyway, not the "new generation, stale data" combination the comment
				// below guards.
				await this.awaitAllDeferredParses();
			}

			const cacheSize = this.cacheManager.cache.size;
			this.cacheManager.clearAllCachedData();

			// Everything invalidating happens before the next await. Bumping the generation
			// alone was not enough: a build starting during the await would capture the *new*
			// generation, read the computed caches that had not been cleared yet, and so pass
			// the check with pre-clear data. Clearing the caches here closes that window —
			// after the await there is nothing left for such a build to read.
			//
			// The writes are a separate problem, and the generation bump below is what answers
			// them: calculateDailyStats() and calculateUsageAnalysisStats() assign
			// lastFullDailyStats and lastUsageAnalysisStats when they finish, so a build already
			// in flight repopulates them from pre-clear data after this runs. Nothing here can
			// unwind those assignments, so instead each cache carries the generation its
			// computation *started* in (_statsGeneration), and every reuse goes through
			// isComputedStatsCurrent(). Such a write lands stamped with the generation this
			// bump just superseded, and the next read recomputes rather than serving it.
			this.lastDetailedStats = undefined;
			this.lastDailyStats = undefined;
			this.lastFullDailyStats = undefined;
			this.lastUsageAnalysisStats = undefined;
			this.lastDashboardData = undefined;
			this.lastEfficiencySessionInputs = undefined;
			this._lastEfficiencyViewData = undefined;
			this._memoryFilesAnalysisScannedAt = undefined;
			this._cacheGeneration++;

			// Delete the on-disk snapshot so it isn't reloaded after restart. deleteSharedSnapshot()
			// itself now serializes on the shared cache lock before deleting, so a writer already
			// mid-flight when clearAllCachedData() ran above — this window's own checkpoint or
			// persistRefreshResult() save, or another window's entirely — cannot land its rename
			// after this delete and resurrect the data this clear is removing. See that method's
			// doc comment for why the lock, not just the in-memory clear generation, is required.
			//
			// Its return value distinguishes a fully durable clear (both the on-disk snapshot delete
			// and the epoch marker write actually landed) from one that only cleared this window's
			// own memory: this window's own cache is empty either way, but only the former is visible
			// to a peer window at all — see deleteSharedSnapshot()'s doc comment for both failure
			// branches this can mean.
			const durablyCleared = await this.cacheManager.deleteSharedSnapshot();

			// Reset diagnostics loaded flag so the diagnostics view will reload files
			this.diagnosticsHasLoadedFiles = false;
			this.diagnosticsCachedFiles = [];
			this.diagnosticsAllSessionFiles = [];
			this.diagnosticsTtftCache.clear();

			if (durablyCleared) {
				this.log(`Cache cleared successfully. Removed ${cacheSize} entries.`);
				vscode.window.showInformationMessage('Cache cleared successfully. Reloading statistics...');
			} else {
				// Deliberately generic: durablyCleared is false for either failure branch inside
				// deleteSharedSnapshot() (the epoch write itself failing, or the snapshot delete
				// failing before the epoch is even touched), and this message must not claim to know
				// which one happened.
				this.warn(`Cache cleared locally (removed ${cacheSize} entries), but could not durably record the clear for other open windows.`);
				vscode.window.showWarningMessage(l10n.t('cacheClear.epochNotPersistedWarning'));
			}

			// Trigger a refresh after clearing the cache
			this.log('Reloading token statistics...');
			await this.updateTokenStats();
			this.log('Token statistics reloaded successfully.');

			// The Efficiency panel is not part of that refresh — _runRefreshCore() publishes to the
			// details, chart, analysis and environmental panels, not this one — and showEfficiency()
			// returns early for an already-open panel. Without this, an open Efficiency view keeps
			// showing pre-clear numbers indefinitely until the user clicks Refresh. Detached
			// deliberately: the rebuild is a full walk, and the panel puts up its own loading screen
			// with live progress while it runs, so there is nothing for clearCache() to wait on.
			if (this.efficiencyPanel) {
				this.log('⚡ Rebuilding the open Efficiency view after the clear...');
				this.requestEfficiencyRebuild();
			}
		} catch (error) {
			this.error('Error clearing cache:', error);
			vscode.window.showErrorMessage('Failed to clear cache: ' + error);
		}
	}

	public async resetInsightsState(): Promise<void> {
		try {
			this._insightStateBag = {};
			this._lastInsightNudgeAt = null;
			await this.context.globalState.update('insights.state', {});
			await this.context.globalState.update('insights.lastNudgeAt', undefined);
			this.refreshStatusBarInsightBadge(0);

			const usageForInsights = this.currentUsageAnalysisStats;
			if (usageForInsights && this.analysisPanel && this.isPanelOpen(this.analysisPanel)) {
				const insights = this.buildCurrentInsights(usageForInsights);
				void this.analysisPanel.webview.postMessage({ command: 'updateInsights', insights });
			}

			vscode.window.showInformationMessage('Insights dismissal state has been reset.');
		} catch (error) {
			this.error('Error resetting insights state:', error);
			const errorMsg = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to reset insights state: ${errorMsg}`);
		}
	}

	constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.extensionUri = extensionUri;
		this.context = context;
		this.initializeAdapters(extensionUri, context);
		this.analysisPool = this.createAnalysisPool(extensionUri);
		this.initializeOutputChannel(context);
		const cacheFileLoad = this.cacheManager.loadCacheFromStorage();
		this._cacheFileLoadPromise = cacheFileLoad.finally(() => {
			this._cacheFileLoadPromise = undefined;
		});
		this._cacheLoadPromise = cacheFileLoad.then(async () => {
			await this.queueMissingOpenCodeDbSessionsFromCache();
		}).finally(() => {
			this._cacheLoadPromise = undefined;
		});
		// Best-effort housekeeping: reclaim cache/lock files orphaned by previous
		// Extension Development Host sessions. Never blocks activation.
		void this.cacheManager.cleanupStaleDevCacheFiles().catch((e) => this.warn(`Stale dev cache cleanup failed: ${e}`));
		// Best-effort housekeeping: reclaim WAL-merge temp files stranded by earlier extension
		// versions (see #2033) or an interrupted merge. Never blocks activation.
		void sweepStaleWalTempFiles().catch((e) => this.warn(`Stale WAL temp file sweep failed: ${e}`));
		this._sessionRestorePromise = this.restoreGitHubSession();
		this.setupGitHubAuthListener(context);
		this.sessionDiscovery.checkCopilotExtension();
		this.initializeStatusBar();
		this.setupConfigurationListener(context);
		this.loadInsightState();
		this._whatsNewReady = this.loadWhatsNewState();
		this.scheduleInitialUpdate();
		this.updateInterval = setInterval(() => {
			this.updateTokenStats(true, true);
		}, 5 * 60 * 1000);
		// A webview click can only be delivered between event-loop ticks, so a long synchronous
		// stretch on this thread is what the user feels as "navigation is blocked". Surface it.
		this._eventLoopMonitor = startEventLoopMonitor({
			onStall: (r) => this.warn(`Extension host event loop stalled: worst tick ${r.maxMs}ms (p99 ${r.p99Ms}ms) in the last ${r.windowMs}ms — webview clicks were delayed by that long.`),
		});
	}

	private createAnalysisPool(extensionUri: vscode.Uri): AnalysisWorkerPool | undefined {
		// Runs from the constructor, before the output channel exists, so anything worth saying is
		// logged once construction has finished instead of here.
		const logAfterConstruction = (message: string): void => { void Promise.resolve().then(() => this.log(message)); };
		if (process.env.AI_FLUENCY_DISABLE_ANALYSIS_WORKER === '1') {
			logAfterConstruction('Analysis worker disabled via AI_FLUENCY_DISABLE_ANALYSIS_WORKER; parsing runs on the extension host.');
			return undefined;
		}
		const workerPath = path.join(extensionUri.fsPath, 'dist', 'analysisWorker.js');
		if (!fs.existsSync(workerPath)) {
			logAfterConstruction(`Analysis worker bundle not found at ${workerPath}; parsing runs on the extension host.`);
			return undefined;
		}
		// Leave a core for the host and the renderer. Capped at two: every worker keeps its own in-memory copy of
		// the SQLite stores it reads (Copilot's session-store.db and data.db are 100+ MB each on a long-lived
		// machine), so a third thread buys little speed for a lot of memory.
		const size = Math.max(1, Math.min(2, os.cpus().length - 1));
		return new AnalysisWorkerPool({
			workerPath,
			extensionPath: extensionUri.fsPath,
			size,
			log: (m) => this.log(m),
			warn: (m) => this.warn(m),
			// One OTel index (this process's) serves every worker; see copilotCliOtel.ts. The session-store lookup stays in the workers.
			// A question asked while the index is still being built fails at once; the sessions it failed for are refreshed
			// when the index announces it is ready (otelIndexLookup.ts), instead of each one waiting on the build.
			resolveOtelUsage: (sessionFile) => (this.otelLookup ??= createWorkerOtelLookup(3_000, () => void this.refreshAfterOtelIndexReady())).resolve(sessionFile),
		});
	}

	/** The OTel index finished building after some sessions had to be skipped for want of it: parse those now. */
	private async refreshAfterOtelIndexReady(): Promise<void> {
		if (this._disposed) { return; }
		this.log('The OTel index is ready; refreshing the sessions that were waiting for it');
		await this._updateTokenStatsInFlight?.catch(() => undefined); // that run may itself have missed the index
		await this.updateTokenStats(true).catch(() => undefined);
	}

	/** Runs `viaWorker` on a worker thread, or `inProcess` when none is usable (rules in analysis/runOffHostThread.ts). */
	private runOffHostThread<T>(viaWorker: (pool: AnalysisWorkerPool) => Promise<T>, inProcess: () => Promise<T>): Promise<T> {
		return _runOffHostThread({ pool: this.analysisPool, isDisposed: () => this._disposed, warn: (m) => this.warn(m) }, viaWorker, inProcess);
	}

	private initializeAdapters(extensionUri: vscode.Uri, context: vscode.ExtensionContext): void {
		const dataAccess = createDataAccessInstances(extensionUri);
		this.openCode = dataAccess.openCode;
		this.crush = dataAccess.crush;
		this.continue_ = dataAccess.continue_;
		this.visualStudio = dataAccess.visualStudio;
		this.claudeCode = dataAccess.claudeCode;
		this.claudeDesktop = dataAccess.claudeDesktop;
		this.mistralVibe = dataAccess.mistralVibe;
		this.geminiCli = dataAccess.geminiCli;
		this.windsurf = new WindsurfDataAccess(extensionUri, (m) => this.log(m));
		this.hermes = dataAccess.hermes;
		this.ecosystems = buildAdapterRegistry({
			...dataAccess,
			estimateTokens: (t, m) => this.estimateTokensFromText(t, m),
			isMcpTool: (t) => this.isMcpTool(t),
			extractMcpServerName: (t) => this.extractMcpServerName(t),
		});
		this.cacheManager = new CacheManager(context, {
			log: (m: string) => this.log(m),
			warn: (m: string) => this.warn(m),
			error: (m: string) => this.error(m),
			// Mirrors clearCache()'s own local-clear invalidation, minus the two steps that are
			// clearCache()-specific rather than cache-state invalidation: clearAllCachedData() (the
			// CacheManager whose own detection this is reacting to already dropped its session cache)
			// and deleteSharedSnapshot()/the success-or-warning message (this window isn't the one
			// that cleared, so there's nothing here for it to delete or announce). Everything else
			// clearCache() does to make sure THIS window stops serving pre-clear data applies equally
			// to a peer-detected clear:
			// - The derived-stat caches: CacheManager has no visibility into this class's separate,
			//   generation-stamped caches, so without this a view like showDetails() could keep
			//   rendering statistics computed before the peer's clear even though the underlying
			//   session cache was correctly dropped.
			// - The diagnostics caches: same shape of staleness, for the diagnostics view's own
			//   loaded-files tracking and model-usage handlers.
			// - The open Efficiency panel: unlike the other panels (which get republished by the next
			//   periodic refresh once the generation bump above forces a recompute), showEfficiency()
			//   returns immediately for an already-open panel and the regular refresh never publishes
			//   to it — nothing else would ever push it a rebuild.
			onPeerClearDetected: () => {
				this.lastDetailedStats = undefined;
				this.lastDailyStats = undefined;
				this.lastFullDailyStats = undefined;
				this.lastUsageAnalysisStats = undefined;
				this.lastDashboardData = undefined;
				this.lastEfficiencySessionInputs = undefined;
				this._lastEfficiencyViewData = undefined;
				this._memoryFilesAnalysisScannedAt = undefined;
				this._cacheGeneration++;

				this.diagnosticsHasLoadedFiles = false;
				this.diagnosticsCachedFiles = [];
				this.diagnosticsAllSessionFiles = [];
				this.diagnosticsTtftCache.clear();

				if (this.efficiencyPanel) {
					this.log('⚡ Rebuilding the open Efficiency view after a peer window\'s clear...');
					this.requestEfficiencyRebuild();
				}

				// Resetting diagnosticsHasLoadedFiles alone only affects the *next* request a webview
				// happens to send — it does not itself make one happen. An already-open panel's next
				// modelUsageResult/ttftResult request would just see the reset flag and reply with
				// stillLoading: true forever, with nothing having scheduled a real load to eventually
				// flip it back. Proactively kicking off the same background load
				// showDiagnosticReport() already triggers whenever the panel is revealed closes that
				// gap, mirroring the Efficiency panel's own explicit rebuild above.
				if (this.diagnosticsPanel) {
					this.log('🔍 Reloading the open Diagnostic Report after a peer window\'s clear...');
					this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
				}
			},
		}, CopilotTokenTracker.CACHE_VERSION);
		this.hookManager = new HookManager(context.globalState, (msg) => this.log(msg));
		this.sessionDiscovery = new SessionDiscovery({
			log: (m) => this.log(m),
			warn: (m) => this.warn(m),
			error: (m, e) => this.error(m, e),
			ecosystems: this.ecosystems,
			windsurf: this.windsurf,
			sampleDataDirectoryOverride: () => this.localRegressionSampleDataDir,
		});
	}

	private loadInsightState(): void {
		this._insightStateBag = this.context.globalState.get<InsightStateBag>('insights.state', {});
		this._lastInsightNudgeAt = this.context.globalState.get<string>('insights.lastNudgeAt', '') || null;
	}

	// ── What's New: view-visit tracking and one-at-a-time announcements ──────────
	//
	// Three pieces, all of them deliberately quiet:
	//   1. Every panel open (and every tab switch inside one) stamps a timestamp,
	//      so we can tell what the user found on their own.
	//   2. On an upgrade, the catalog's features for the crossed versions are
	//      queued — at most three per release.
	//   3. The startup pass announces at most one queued feature per calendar day,
	//      skipping anything the user has since opened themselves.
	// The full rule set lives in `src/whatsNew/announcer.ts`; keep it there rather
	// than growing conditions here.

	/** Key under which the announcement bookkeeping is persisted. */
	private static readonly WHATS_NEW_STATE_KEY = 'whatsNew.state';
	/** Key under which the per-view/per-tab last-opened stamps are persisted. */
	private static readonly WHATS_NEW_VISITS_KEY = 'whatsNew.viewVisits';

	/**
	 * Loads the what's-new bookkeeping and reconciles it against the running
	 * version. Runs at construction so the queue is already correct by the time
	 * `scheduleInitialUpdate` gets around to announcing anything.
	 */
	private async loadWhatsNewState(): Promise<void> {
		try {
			this._viewVisits = sanitizeVisits(this.context.globalState.get(CopilotTokenTracker.WHATS_NEW_VISITS_KEY));
			const stored = sanitizeState(this.context.globalState.get(CopilotTokenTracker.WHATS_NEW_STATE_KEY));
			const reconciled = reconcileVersion({
				releases: WHATS_NEW_RELEASES,
				state: stored,
				currentVersion: packageJson.version,
				now: new Date(),
				// Everyone already using the extension when this bookkeeping shipped
				// arrives here with no stored version. `hasSeenOnboarding` is the only
				// signal that separates them from a genuinely new install, and it
				// decides whether they hear about this release at all.
				isFreshInstall: !this.context.globalState.get<boolean>('hasSeenOnboarding', false),
			});
			this._whatsNewState = reconciled;
			if (reconciled !== stored) {
				await this.context.globalState.update(CopilotTokenTracker.WHATS_NEW_STATE_KEY, reconciled);
				if (reconciled.pending.length > stored.pending.length) {
					this.log(`📣 What's New: queued ${reconciled.pending.length - stored.pending.length} feature(s) after upgrade to ${packageJson.version}`);
				}
			}
		} catch (error) {
			this.warn(`What's New state load failed: ${error}`);
		}
	}

	/**
	 * Records that the user is looking at a view (and, when given, a specific tab
	 * inside it). Fire-and-forget: this is a hint for suppressing notifications,
	 * never something a panel should wait on.
	 */
	private recordViewVisit(view: FeatureViewId, tab?: string): void {
		const surface: FeatureSurface = tab ? { view, tab } : { view };
		const updated = recordVisit(this._viewVisits, surface, new Date().toISOString());
		if (updated === this._viewVisits) { return; }
		this._viewVisits = updated;
		void this.context.globalState.update(CopilotTokenTracker.WHATS_NEW_VISITS_KEY, updated)
			.then(undefined, (error) => this.warn(`What's New visit save failed: ${error}`));
	}

	/** True when the user has not turned the new-feature notifications off. */
	private whatsNewNotificationsEnabled(): boolean {
		return vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('whatsNew.notificationsEnabled', true);
	}

	/**
	 * Announces at most one new view/tab/section, at most once a day. The decision
	 * — including which feature and whether to say anything at all — belongs to
	 * `planAnnouncement`; this method only persists the outcome and shows the toast.
	 *
	 * State is written before the notification is shown, matching the older news
	 * banners: an ignored notification still counts as shown, because re-offering
	 * it on the next window open is the exact noise this feature exists to avoid.
	 */
	private async showWhatsNewNotification(): Promise<void> {
		if (!this.whatsNewNotificationsEnabled()) { return; }
		// The startup delay makes this all but certain already, but announcing
		// against a half-loaded queue would double-announce, so make it explicit.
		await this._whatsNewReady;
		const plan = planAnnouncement({
			releases: WHATS_NEW_RELEASES,
			state: this._whatsNewState,
			visits: this._viewVisits,
			now: new Date(),
		});
		if (plan.state !== this._whatsNewState) {
			this._whatsNewState = plan.state;
			await this.context.globalState.update(CopilotTokenTracker.WHATS_NEW_STATE_KEY, plan.state);
		}
		const announcement = plan.announcement;
		if (!announcement) { return; }

		const { feature, release } = announcement;
		this.log(`📣 What's New: announcing "${l10nT(feature.titleKey)}" from ${release.version}`);
		const kindLabel = feature.kind === 'view' ? 'view' : feature.kind === 'tab' ? 'tab' : 'section';
		const takeMeThere = l10n.t('whatsNew.takeMeThere');
		const seeAll = l10n.t('whatsNew.seeAll');
		const choice = await vscode.window.showInformationMessage(
			`✨ New ${kindLabel}: ${l10nT(feature.titleKey)} — ${l10nT(feature.descriptionKey)}`,
			takeMeThere,
			seeAll,
		);
		if (choice === takeMeThere) {
			await this.openWhatsNewFeature(feature.id);
		} else if (choice === seeAll) {
			await this.showWhatsNew();
		}
	}

	/** Opens the surface a catalog feature lives on, landing on its tab and section. */
	private async openWhatsNewFeature(featureId: string): Promise<void> {
		const entry = findFeature(featureId);
		if (!entry) {
			this.warn(`What's New: unknown feature id "${featureId}"`);
			return;
		}
		const { view, tab, anchor } = entry.feature.surface;
		await this.openViewSurface(view, { ...(tab ? { tab } : {}), ...(anchor ? { anchor } : {}) });
	}

	/** Runs a navigation without blocking the command dispatcher, reporting a failure the way dispatch() would. */
	private startNavigation(label: string, navigate: () => Promise<void>): void {
		navigate().catch((error: unknown) => {
			this.error(`Opening ${label} failed`, error);
			vscode.window.showErrorMessage(l10n.t('viewIndex.navigationFailed', error instanceof Error ? error.message : String(error)));
		});
	}

	/** Opens the view, tab and section a View index entry points at. */
	private async openViewIndexEntry(entryId: string): Promise<void> {
		const entry = findViewIndexEntry(entryId);
		if (!entry) {
			this.warn(`View index: unknown entry id "${entryId}"`);
			return;
		}
		this.log(`🧭 View index: opening ${entry.path.join(' › ')}`);
		await this.openViewSurface(entry.view, entry.nav);
	}

	/**
	 * Opens a view as the user asked for it — a header button or a command, no
	 * tab or section. Unlike calling the view's opener directly, this also
	 * cancels any deep link still pending for that view, so it can no longer
	 * switch tabs or scroll after the user went to the view itself.
	 */
	public async openView(view: FeatureViewId): Promise<void> {
		await this.openViewSurface(view, {});
	}

	/** The open panel for a view, if any. */
	private getPanelForView(view: FeatureViewId): vscode.WebviewPanel | undefined {
		const panels: Partial<Record<FeatureViewId, vscode.WebviewPanel | undefined>> = {
			details: this.detailsPanel,
			chart: this.chartPanel,
			usage: this.analysisPanel,
			maturity: this.maturityPanel,
			efficiency: this.efficiencyPanel,
			environmental: this.environmentalPanel,
			diagnostics: this.diagnosticsPanel,
			'fluency-level-viewer': this.fluencyLevelViewerPanel,
			dashboard: this.dashboardPanel,
			whatsnew: this.whatsNewPanel,
		};
		return panels[view];
	}

	/**
	 * Opens a view and lands on a tab and section within it. The usage panel has
	 * its own navigation protocol (`switchTab`); every other panel takes a
	 * `revealSurface` request (see webview/shared/surfaceNavigation.ts).
	 */
	private async openViewSurface(view: FeatureViewId, nav: ViewIndexNavigation): Promise<void> {
		if (view === 'logviewer') {
			// The log viewer only opens on a specific session file, so a catalog feature
			// living there (e.g. HydraFusion routing) lands where sessions are opened from:
			// Recent Sessions, with a pointer to what to do next.
			await this.showUsageAnalysisOnTab('sessions');
			void vscode.window.showInformationMessage(l10n.t('whatsNew.logviewerHint'));
			return;
		}
		if (view === 'usage') {
			if (nav.tab && isUsageAnalysisTab(nav.tab)) {
				await this.showUsageAnalysisOnTab(nav.tab, nav.anchor);
			} else {
				// Going to the view itself supersedes a deep link still waiting for the
				// panel to be ready, which would otherwise redirect this open later.
				this.pendingAnalysisNavigation = undefined;
				const wasOpen = this.analysisPanel;
				await this.runOpenerFocused('usage', () => this.showUsageAnalysis());
				// A deep link that already reached the webview may still be waiting for its
				// section to render; drop that too.
				if (wasOpen && wasOpen === this.analysisPanel) {
					void wasOpen.webview.postMessage({ command: 'cancelPendingNavigation' });
				}
			}
			return;
		}
		const openers: Partial<Record<FeatureViewId, () => Promise<void>>> = {
			details: () => this.showDetails(),
			chart: () => this.showChart(),
			maturity: () => this.showMaturity(),
			efficiency: () => this.showEfficiency(),
			environmental: () => this.showEnvironmental(),
			diagnostics: () => this.showDiagnosticReport(),
			// `logviewer` is deliberately absent: it only opens against a specific
			// session file, so it can never be the destination of a catalog entry.
			'fluency-level-viewer': () => this.showFluencyLevelViewer(),
			dashboard: () => this.showDashboard(),
			whatsnew: () => this.showWhatsNew(),
		};
		const open = openers[view];
		if (!open) { return; }
		const hasTarget = !!(nav.tab || nav.subtab || nav.anchor || nav.selector);
		if (!hasTarget) {
			this.surfaceReveals.clear(view);
			const existing = this.getPanelForView(view);
			const panel = await this.runOpenerFocused(view, open);
			// An already-open panel may still be waiting to carry out an earlier
			// reveal; going to the view itself supersedes it.
			if (panel && panel === existing) {
				void panel.webview.postMessage({ command: 'cancelReveal' });
			}
			return;
		}
		// Held before opening: a panel the opener creates may report ready before `open` resolves.
		const existingPanel = this.getPanelForView(view);
		this.surfaceReveals.request(view, nav, existingPanel);
		const panel = await this.runOpenerFocused(view, open, (created) => {
			// A new panel exists once the opener's synchronous part ran: bind the
			// request to it now, before the opener's data load resolves.
			if (created !== existingPanel) { this.surfaceReveals.bind(view, created); }
		});
		const postNow = this.surfaceReveals.opened(view, panel);
		if (!panel) { return; }
		if (postNow) {
			// The opener reused the panel. Post now; if the webview is reloading
			// (a hidden panel without retained context) the message may be lost, so
			// the request stays held until the webview acknowledges it or the
			// reloaded page reports ready.
			void panel.webview.postMessage({ command: 'revealSurface', requestId: this.surfaceReveals.currentId(view), ...postNow });
		}
	}

	/**
	 * Runs a view's opener and focuses its panel. Openers create their panel (with
	 * preserveFocus) before their first await and then load data, so the panel is
	 * focused right when it appears — not after a slow load, by which time the user
	 * may be somewhere else. Only if no panel existed synchronously is it focused
	 * after the opener resolves, and then only if no newer navigation started since.
	 * `onPanel` sees the panel as soon as it exists.
	 */
	private async runOpenerFocused(
		view: FeatureViewId,
		open: () => Promise<void>,
		onPanel?: (panel: vscode.WebviewPanel) => void,
	): Promise<vscode.WebviewPanel | undefined> {
		const generation = ++this.surfaceNavGeneration;
		const opening = open();
		const early = this.getPanelForView(view);
		if (early) {
			onPanel?.(early);
			early.reveal(undefined, false);
		}
		await opening;
		const panel = this.getPanelForView(view);
		if (panel && !early && generation === this.surfaceNavGeneration) {
			onPanel?.(panel);
			panel.reveal(undefined, false);
		}
		return panel;
	}

	private flushPendingSurfaceReveal(view: FeatureViewId): void {
		const panel = this.getPanelForView(view);
		if (!panel) { return; }
		// Held until the webview acknowledges it with surfaceRevealHandled.
		const nav = this.surfaceReveals.ready(view, panel);
		if (nav) { void panel.webview.postMessage({ command: 'revealSurface', requestId: this.surfaceReveals.currentId(view), ...nav }); }
	}

	/** Projects the catalog into the shape the What's New webview renders. */
	private buildWhatsNewViewData(): {
		currentVersion: string;
		releases: Array<{
			version: string;
			date: string | null;
			headline: string;
			isCurrent: boolean;
			features: Array<{ id: string; title: string; description: string; kind: WhatsNewFeature['kind']; isUnseen: boolean }>;
		}>;
		backendConfigured: boolean;
		localization: Record<string, string>;
	} {
		const projectFeature = (feature: WhatsNewFeature) => ({
			id: feature.id,
			// Resolved here, at the render boundary: catalog.ts is pure and holds keys.
			title: l10nT(feature.titleKey),
			description: l10nT(feature.descriptionKey),
			kind: feature.kind,
			// "Not opened yet" is measured from when this build first ran, not from
			// the dawn of time: a tab visited a year ago on an older version says
			// nothing about whether the user has seen what changed in it since.
			isUnseen: !hasVisitedSince(this._viewVisits, feature.surface, this._whatsNewState.versionSeenAt),
		});
		const projectRelease = (release: WhatsNewRelease) => ({
			version: release.version,
			date: release.date,
			headline: l10nT(release.headlineKey),
			isCurrent: release.version === packageJson.version,
			features: release.features.map(projectFeature),
		});
		return {
			currentVersion: packageJson.version,
			releases: WHATS_NEW_RELEASES.slice(0, WHATS_NEW_MAX_RELEASES).map(projectRelease),
			backendConfigured: this.isBackendConfigured(),
			...this.getWebviewLocaleFields(),
		};
	}

	/** Opens the What's New panel: the last few releases, described in prose. */
	public async showWhatsNew(): Promise<void> {
		this.log("📣 Opening What's New view");
		this.recordViewVisit('whatsnew');

		if (this.whatsNewPanel) {
			this.whatsNewPanel.reveal();
			return;
		}

		this.whatsNewPanel = vscode.window.createWebviewPanel(
			'copilotWhatsNew',
			"What's New",
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(this.extensionUri, 'media'),
				],
			}
		);

		this.whatsNewPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message)) { return; }
			if (message.command === 'refresh' && this.whatsNewPanel) {
				this.whatsNewPanel.webview.postMessage({ command: 'updateWhatsNew', data: this.buildWhatsNewViewData() });
			}
		});

		this.whatsNewPanel.onDidDispose(() => {
			this.log("📣 What's New view closed");
			this.whatsNewPanel = undefined;
		});

		this.whatsNewPanel.webview.html = this.getWhatsNewHtml(this.whatsNewPanel.webview);
	}

	private getWhatsNewHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'whatsnew.js')
		);
		const initialData = JSON.stringify(this.buildWhatsNewViewData()).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>What's New</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_WHATSNEW__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			${this.getLocalViewRegressionProbeScript('whatsnew', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private initializeOutputChannel(context: vscode.ExtensionContext): void {
		if (context.extensionMode === vscode.ExtensionMode.Development) {
			try {
				this._devBranch = childProcess.execSync('git rev-parse --abbrev-ref HEAD', {
					cwd: context.extensionUri.fsPath, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
				}).trim();
			} catch { /* Ignore git errors in dev mode */ }
			this.initializeCrashDebugLog(context);
		}
		this.outputChannel = vscode.window.createOutputChannel(l10n.t('outputChannelName'));
		context.subscriptions.push(this.outputChannel);
		this.log('Constructor called');
		const version = context.extension.packageJSON?.version ?? 'unknown';
		const mode = context.extensionMode === vscode.ExtensionMode.Development ? 'Development'
			: context.extensionMode === vscode.ExtensionMode.Test ? 'Test' : 'Production';
		let startupInfo = l10n.t('startupInfo', version, mode, CopilotTokenTracker.CACHE_VERSION);
		if (context.extensionMode === vscode.ExtensionMode.Development) {
			try {
				const sha = childProcess.execSync('git rev-parse --short HEAD', {
					cwd: context.extensionUri.fsPath, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
				}).trim();
				startupInfo += ` branch=${this._devBranch ?? 'unknown'} sha=${sha}`;
			} catch { /* git unavailable */ }
		}
		this.log(startupInfo);
	}

	/**
	 * Sets up debugCrashLog()'s target file and truncates it for this session. Dev
	 * mode only, called once from initializeOutputChannel(). Left unset (debugCrashLog
	 * becomes a no-op) if this fails, e.g. globalStorage isn't writable yet.
	 */
	private initializeCrashDebugLog(context: vscode.ExtensionContext): void {
		const logPath = path.join(context.globalStorageUri.fsPath, 'crash-debug.log');
		try {
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.writeFileSync(logPath, `=== session ${vscode.env.sessionId} started ${new Date().toISOString()} ===\n`);
			this._crashDebugLogPath = logPath;
		} catch { /* best-effort — debugCrashLog stays a no-op */ }
	}

	/**
	 * Synchronous, crash-safe logging for the session-file scan loop. Unlike this.log()
	 * (the OutputChannel, which buffers in the renderer and can be lost entirely if the
	 * extension host process dies before it flushes), this hits disk immediately via a
	 * blocking write — so the last few lines survive even a hard native crash. Dev mode
	 * only (debugCrashLogPath is never set otherwise): the synchronous I/O cost per call
	 * is not acceptable for real users, only for diagnosing a crash during development.
	 */
	private debugCrashLog(msg: string): void {
		if (!this._crashDebugLogPath) { return; }
		try { fs.appendFileSync(this._crashDebugLogPath, `${new Date().toISOString()} ${msg}\n`); } catch { /* best-effort */ }
	}

	private setupGitHubAuthListener(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.authentication.onDidChangeSessions(async (e) => {
				// Checked against the *public* provider, and before either early return below:
				// the repository-memory cache is keyed by repository and checkout root, not by
				// identity, so a sign-out or account switch would otherwise keep showing data
				// fetched under the old session for up to the full TTL. The handler below filters
				// on getGitHubAuthProviderId(), which names the Enterprise provider on a GHES
				// install — a provider this feature deliberately never authenticates with.
				if (e.provider.id === PUBLIC_GITHUB_AUTH_PROVIDER_ID) { this.invalidateServerMemoriesCache(); }
				const authProviderId = getGitHubAuthProviderId();
				if (e.provider.id !== authProviderId) { return; }
				if (this._githubSignedOutByUser) { return; }
				const lookupSeq = ++this._sessionLookupSeq;
				const session = await vscode.authentication.getSession(authProviderId, ['read:user'], { silent: true });
				// A sign-out, or a newer session lookup, may have landed while getSession() was pending; don't undo it.
				if (this._githubSignedOutByUser || lookupSeq !== this._sessionLookupSeq) { return; }
				if (session) {
					this.githubSession = session;
					await this.context.globalState.update('github.authenticated', true);
					await this.context.globalState.update('github.username', session.account.label);
					void this.loadAndLogCopilotPlanInfo();
				} else {
					this.githubSession = undefined;
					await this.context.globalState.update('github.authenticated', false);
					await this.context.globalState.update('github.username', undefined);
					this.log('GitHub session removed externally — clearing auth state');
					// The preferred account is gone: drop its quota/plan state so no surface keeps showing its
					// budget, then re-list whichever accounts remain.
					this.clearPreferredAccountBudgetState();
					this.refreshBudgetDependentUi();
					this.pushAccountBudgetsToPanels();
					void this.refreshAccountBudgets();
				}
			})
		);
	}

	private initializeStatusBar(): void {
		this.statusBarItem = vscode.window.createStatusBarItem('ai-engineering-fluency', vscode.StatusBarAlignment.Right, 102);
		this.statusBarItem.name = l10n.t("statusBar.name");
		this.setStatusBarText(l10n.t("statusBar.loadingText"));
		this.statusBarItem.tooltip = l10n.t("statusBar.tooltip");
		this.statusBarItem.command = 'aiEngineeringFluency.showDetails';
		this.statusBarItem.show();

		// Separate insights badge — hidden until there are new insights
		this.insightsStatusBarItem = vscode.window.createStatusBarItem('ai-engineering-fluency-insights', vscode.StatusBarAlignment.Right, 101);
		this.insightsStatusBarItem.name = l10n.t("statusBar.nameInsights");
		this.insightsStatusBarItem.command = 'aiEngineeringFluency.openInsightsTab';
		// starts hidden; shown in refreshStatusBarInsightBadge when count > 0

		this.log('Status bar item created and shown');
	}

	private setupConfigurationListener(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('aiEngineeringFluency.display')) { this.refreshOpenPanelsForSettingChange(); }
				// Without this the opt-out only takes effect on the next periodic refresh, so a
				// user who switches it off keeps looking at the card they just disabled.
				if (e.affectsConfiguration('aiEngineeringFluency.serverMemories')) { this.invalidateServerMemoriesCache(); }
				if (e.affectsConfiguration('aiEngineeringFluency.backend')) {
					// A multi-key save defers this until its last write, so no sync ever runs
					// against a half-applied configuration (see settingsBatch.ts).
					const onBackendSettingsChanged = () => this.onBackendSettingsChanged();
					if (!deferWhileApplyingSettings(onBackendSettingsChanged)) { onBackendSettingsChanged(); }
				}
			})
		);
	}

	/** Restarts the sync timer and forces a sync after backend settings changed. */
	private onBackendSettingsChanged(): void {
		this.startBackendSyncAfterInitialAnalysis();
		const backend = this.backend;
		if (backend && typeof backend.syncToBackendStore === 'function') {
			void (async () => {
				try {
					await backend.syncToBackendStore(true);
					if (this.diagnosticsPanel) { this.loadDiagnosticDataInBackground(this.diagnosticsPanel); }
				} catch (err: unknown) {
					this.warn('Backend sync after settings change failed: ' + err);
				}
			})();
		}
		if (this.diagnosticsPanel) { this.loadDiagnosticDataInBackground(this.diagnosticsPanel); }
	}

	private scheduleInitialUpdate(): void {
		this.log('🚀 Starting token usage analysis...');
		// Paint real numbers from the on-disk cache immediately, before the real
		// discover→parse pass (below) even starts. No filesystem discovery, no
		// fs.stat, no parsing — just the cache already loaded into memory — so a
		// cold boot shows a real status bar within a second or two instead of
		// blank/zero for however long the full scan takes. See issue #2018 fix #2.
		void this.renderInstantStatsFromCache();
		// Use a longer delay (3 s) so that:
		// 1. VS Code and other extensions finish their own startup work first.
		// 2. On macOS, the TCC privacy framework has time to resolve any first-time
		//    folder-access permissions before our synchronous filesystem scan begins.
		//    Without this delay the sync fs calls block the shared extension-host
		//    event loop and make VS Code appear frozen.
		// Previously a "wait for Copilot ready" gate provided a similar natural delay;
		// this explicit wait restores that behaviour for users who do not have Copilot.
		setTimeout(async () => {
			try {
				await this.updateTokenStats();
				this.startBackendSyncAfterInitialAnalysis();
				await this.checkAndShowOnboarding();
				await this.showFluencyScoreNewsBanner();
				await this.showEfficiencyTabNewsBanner();
				await this.showUnknownMcpToolsBanner();
				await this.showWhatsNewNotification();
			} catch (error) {
				this.error('Error in initial update:', error);
			}
		}, 3000);
	}

	/**
	 * Mirrors SessionDiscovery.tryGetSampleDataFiles()'s effective-sample-dir check — precedence,
	 * empty-string handling, AND the directory (not just existence) gate:
	 *
	 * - Precedence: `sampleDataDirectoryOverride?.() ?? configured`. The override function
	 *   (`() => this.localRegressionSampleDataDir`) is always defined once constructed, so `??`
	 *   only ever falls through to the config setting while the override itself has never been
	 *   set (`undefined`) — NOT whenever it happens to be falsy. runLocalViewRegression() sets it
	 *   to `''` (not undefined) while it deliberately tries real discovery first; treating `''` as
	 *   "no override, fall back to config" (a plain truthy check) disagrees with that and would
	 *   wrongly suppress the cache-only paint/seeding during that phase whenever the user also
	 *   happens to have a `sampleDataDirectory` setting configured for something else.
	 * - tryGetSampleDataFiles() returns `undefined` (falls back to real adapter discovery) for a
	 *   configured-but-missing/stale directory, or one whose `readdir()` fails (e.g. it names a
	 *   file, not a directory) — an existence-only check disagrees with both and would wrongly
	 *   suppress the cache-only instant paint/seeding on an otherwise normal warm boot.
	 *
	 * In sample mode SessionDiscovery bypasses every adapter and returns only the fixture's files
	 * — callers that read the real on-disk cache directly must not mix real user sessions into
	 * what is meant to be a clean, deterministic fixture run.
	 */
	private isSampleDataModeActive(): boolean {
		const overrideValue = this.localRegressionSampleDataDir;
		const sampleDir = overrideValue !== undefined ? overrideValue : vscode.workspace.getConfiguration('aiEngineeringFluency').get<string>('sampleDataDirectory');
		if (!sampleDir || sampleDir.trim().length === 0) { return false; }
		try {
			return fs.statSync(sampleDir.trim()).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Returns the on-disk cache's entries deduplicated by _normalizePathForDedup() key, keeping
	 * whichever raw-path variant has the newer mtime for a given physical file. The cache
	 * snapshot is keyed by whatever raw path string was recorded at write time — possibly across
	 * different adapter runs/history — so two spelling variants of the same file (differing only
	 * in separator/case, e.g. on Windows) can coexist as separate Map entries;
	 * buildMergedSnapshotEntries() only merges entries that share the exact same key string, so
	 * it never collapses these. The normal discover→parse pass never surfaces this, because
	 * adapters always report one canonical spelling per real scan — only a fresh discovery's own
	 * spelling is ever looked up. Any caller that reads the cache directly instead (the
	 * cache-only instant paint, the cache-seeded preload queue) must dedupe through this, or it
	 * will double-count that file's tokens.
	 */
	private getDeduplicatedCacheEntries(): [string, SessionFileCache][] {
		return _dedupeByNormalizedKeyKeepGreatest(this.cacheManager.cache, data => data.mtime);
	}

	/**
	 * Paints the status bar (and any already-open Details/Chart panels) straight
	 * from the on-disk cache — no filesystem discovery, no fs.stat, no parsing —
	 * so a cold boot shows real numbers within a second or two instead of sitting
	 * blank/zero for the full discover→parse pass. The real pass kicked off right
	 * after this in scheduleInitialUpdate() still runs and overwrites this with
	 * verified, reconciled data; this is a provisional first paint only (see issue
	 * #2018, fix #2: "Render last-known stats from the loaded snapshot before the
	 * parse finishes").
	 */
	/**
	 * Whether renderInstantStatsFromCache() must abandon its cache-only paint after awaiting
	 * _cacheFileLoadPromise: sample mode could have turned on while that await was suspended (e.g.
	 * runLocalViewRegression() started concurrently) — the check at the top of the caller only
	 * reflects the state at the very start of the call, not at the point the cache is actually
	 * read — or the window could have been disposed (dispose() tears down statusBarItem/
	 * detailsPanel/chartPanel synchronously, so resuming into aggregation/UI-publish afterward
	 * would touch disposed VS Code objects).
	 */
	private shouldAbandonInstantPaintAfterCacheLoad(): boolean {
		return this.isSampleDataModeActive() || this._disposed;
	}

	/**
	 * Whether a cache entry is usable for the instant cache-only paint: it has a finite, positive
	 * interaction count (a persisted snapshot is just parsed JSON — an untyped `!== 0` check would
	 * accept a NaN or negative `interactions` value, since neither strictly equals 0, letting it
	 * propagate as a NaN/negative count into the provisional status/chart data), a finite mtime
	 * (a malformed one would make `new Date(...).toISOString()` throw deeper in
	 * renderInstantStatsFromCache(), aborting the entire paint over one bad record instead of just
	 * skipping it), and falls within the same recency window the real refresh bounds `preloaded` to
	 * (`cutoffMs`) — without that last check, this provisional paint could include cache entries the
	 * real refresh's own `preloaded` excludes, showing a higher, more-inclusive number that then
	 * visibly drops once the verified refresh (which never counted those older entries) overwrites
	 * it moments later.
	 */
	private isUsableForInstantPaint(sessionData: SessionFileCache | undefined, cutoffMs: number): sessionData is SessionFileCache {
		return !!sessionData
			// A details-only placeholder carries no real tokens/usage analysis; never paint it as stats.
			&& !sessionData.detailsOnly
			&& Number.isFinite(sessionData.interactions) && sessionData.interactions > 0
			&& Number.isFinite(sessionData.mtime) && sessionData.mtime >= cutoffMs;
	}

	/**
	 * Whether the provisional cache-only paint may still be published.
	 *
	 * The real refresh (kicked off 3s later in scheduleInitialUpdate()) runs concurrently with this
	 * and normally publishes first, but there is no hard ordering guarantee: if it already
	 * committed verified data, never overwrite it with these older, cache-only numbers. Also bail
	 * if the window closed, or sample-data mode turned on (e.g. runLocalViewRegression() started
	 * during this same, potentially slow aggregation) — publishing real cached stats now would
	 * contaminate a regression/screenshot run that expects only its fixture data.
	 *
	 * `_hasCompletedRealRefresh` is no substitute for the generation check: a clearCache() landing
	 * while calculateDetailedStats() was awaiting leaves that flag false — the clear's own refresh
	 * has not published yet — while the status bar, Details and Chart would all be handed pre-clear
	 * data stamped as current.
	 */
	private canPublishInstantPaint(startedAtGeneration: number): boolean {
		if (this._hasCompletedRealRefresh || this._disposed || this.isSampleDataModeActive()) { return false; }
		if (isComputedStatsCurrent(startedAtGeneration, this._cacheGeneration)) { return true; }
		this.log('⚡ Discarding the instant cache-only paint: the caches were cleared while it ran');
		return false;
	}

	private async renderInstantStatsFromCache(): Promise<void> {
		// Captured before any await: what this paints is only as current as the cache it started
		// from, so a clearCache() landing mid-aggregation must leave the stamp behind it.
		const startedAtGeneration = this._cacheGeneration;
		try {
			// Sample-data mode (screenshot/regression fixtures, see runLocalViewRegression()
			// and the aiEngineeringFluency.sampleDataDirectory setting) intentionally bypasses
			// all adapters and shows only the fixture's files. Rendering from the real,
			// unrelated on-disk cache here would paint real user data over (or alongside) the
			// fixture before the real fixture-only pass runs. Skip entirely.
			if (this.isSampleDataModeActive()) { return; }
			// Await only the raw cache-file read, not the OpenCode DB probe chained onto
			// _cacheLoadPromise (queueMissingOpenCodeDbSessionsFromCache() does its own SQLite
			// I/O) — awaiting that would defeat the point of a no-filesystem-scan first paint.
			if (this._cacheFileLoadPromise) {
				try { await this._cacheFileLoadPromise; } catch { /* already logged in loadCacheFromStorage */ }
			}
			if (this.shouldAbandonInstantPaintAfterCacheLoad()) { return; }
			// _cacheFileLoadPromise settling only means loadCacheFromStorage() re-synchronized with
			// the epoch as of ITS OWN completion — a peer clear landing in the gap between that and
			// this line would leave the in-memory cache about to be read below stale, with nothing
			// having bumped _cacheGeneration to make canPublishInstantPaint()'s check further down
			// catch it. This re-checks immediately before that read, the same way every other reader
			// of `cache` (loadSharedSnapshotIfChanged(), writeSharedSnapshot()) already does.
			await this.cacheManager.checkClearEpoch();
			if (this.cacheManager.cache.size === 0) { return; }

			// Same window the real refresh bounds `preloaded` to (see _preloadSessionFiles()'s own
			// fileLoadCutoffMs) — without it, this provisional paint could include cache entries the
			// real refresh's preloaded array excludes, so calculateDetailedStats() would show a
			// higher, more-inclusive number here that then visibly drops once the verified refresh
			// (which never counted those older entries) overwrites it moments later.
			const { last30DaysStartMs: instantLast30DaysStartMs, lastMonthStartMs: instantLastMonthStartMs } = computeUtcDateRanges(new Date());
			const instantPaintCutoffMs = Math.min(instantLast30DaysStartMs, instantLastMonthStartMs);

			const preloaded: SessionFilePreload[] = [];
			for (const [sessionFile, sessionData] of this.getDeduplicatedCacheEntries()) {
				if (!this.isUsableForInstantPaint(sessionData, instantPaintCutoffMs)) { continue; }
				const stat = { size: sessionData.size ?? 0, mtime: new Date(sessionData.mtime) } as unknown as import('fs').Stats;
				preloaded.push({
					sessionFile,
					mtime: sessionData.mtime,
					fileSize: sessionData.size ?? 0,
					sessionData,
					wasCached: true,
					details: this.buildMinimalPreloadDetails(sessionFile, stat, sessionData),
				});
			}
			if (preloaded.length === 0) { return; }

			const { stats, dailyStats } = await this.calculateDetailedStats(undefined, preloaded);
			if (!this.canPublishInstantPaint(startedAtGeneration)) { return; }
			this.recordDetailedStats(stats, startedAtGeneration);
			this.lastDailyStats = dailyStats;
			this._statsGeneration.daily = startedAtGeneration;
			this.mergeIntoFullDailyStats(dailyStats, startedAtGeneration);
			this.updateStatusBarAndTooltip(stats);
			this.updateDetailsPanelIfOpen(stats, true);
			this.updateChartPanelIfOpen(true);
			this.log(`⚡ Instant first paint from ${preloaded.length} cached session file(s) (provisional — full scan still running)`);
		} catch (error) {
			this.warn(`Instant cache-only render failed, waiting for full scan instead: ${error}`);
		}
	}

	private async queueMissingOpenCodeDbSessionsFromCache(): Promise<void> {
		try {
			const dbSessionIds = await this.openCode.discoverOpenCodeDbSessions();
			if (dbSessionIds.length === 0) { return; }
			const cachedOpenCodeIds = new Set<string>();
			for (const filePath of this.cacheManager.cache.keys()) {
				if (!this.openCode.isOpenCodeDbSession(filePath)) { continue; }
				const sessionId = this.openCode.getOpenCodeSessionId(filePath);
				if (sessionId) { cachedOpenCodeIds.add(sessionId); }
			}
			const dataDir = this.openCode.getOpenCodeDataDir();
			let queued = 0;
			for (const sessionId of dbSessionIds) {
				if (cachedOpenCodeIds.has(sessionId)) { continue; }
				this._startupOpenCodeDbMisses.add(path.join(dataDir, `opencode.db#${sessionId}`));
				queued++;
			}
			if (queued > 0) {
				if (queued > 0) {
			this.log(`Queued ${queued} uncached OpenCode DB session(s) for startup refresh`);
		}
				this.sessionDiscovery.clearCache();
			}
		} catch (error) {
			this.warn(`OpenCode startup DB check skipped: ${error}`);
		}
	}

	/**
	 * After the initial scan, decide whether to show onboarding guidance.
	 * Branches on three cases:
	 *   1. Returning user (`hasSeenOnboarding` already set) — do nothing.
	 *   2. Genuine first use (no files, no discovery error) — show welcome notification.
	 *   3. Discovery failure (no files + adapter error) — route to Diagnostics.
	 * When data is found, the flag is marked so subsequent runs skip this.
	 */
	private async checkAndShowOnboarding(): Promise<void> {
		const hasSeenOnboarding = this.context.globalState.get<boolean>('hasSeenOnboarding', false);
		const sessionFilesCount = this.sessionDiscovery.lastDiscoveryFilesCount;
		const hadDiscoveryError = this.sessionDiscovery.lastDiscoveryHadError;

		// Compute action from pre-update state so the decision is stable.
		const action = determineOnboardingAction(hasSeenOnboarding, sessionFilesCount, hadDiscoveryError);

		// Mark as seen whenever data is present so future runs skip onboarding.
		if (sessionFilesCount > 0) {
			await this.context.globalState.update('hasSeenOnboarding', true);
		}

		switch (action) {
			case 'welcome': {
				const message = l10n.t('onboarding.welcome.message');
				const openFluencyScore = l10n.t('onboarding.welcome.openFluencyScore');
				const learnMore = l10n.t('onboarding.welcome.learnMore');
				const choice = await vscode.window.showInformationMessage(
					message,
					openFluencyScore,
					learnMore,
				);
				await this.context.globalState.update('hasSeenOnboarding', true);
				if (choice === openFluencyScore) {
					await this.showMaturity();
				} else if (choice === learnMore) {
					await vscode.env.openExternal(vscode.Uri.parse('https://github.com/rajbos/ai-engineering-fluency#supported-editors'));
				}
				break;
			}
			case 'diagnostics': {
				const message = l10n.t('onboarding.diagnostics.message');
				const openDiagnostics = l10n.t('onboarding.diagnostics.openDiagnostics');
				const choice = await vscode.window.showWarningMessage(
					message,
					openDiagnostics,
				);
				if (choice === openDiagnostics) {
					await this.showDiagnosticReport();
				}
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Start backend sync timer after initial token analysis completes.
	 * This avoids resource contention during extension startup.
	 */
	private startBackendSyncAfterInitialAnalysis(): void {
		try {
			const backend = this.backend;
			if (backend && typeof backend.startTimerIfEnabled === 'function') {
				backend.startTimerIfEnabled();
			}
		} catch (error) {
			this.warn('Failed to start backend sync timer: ' + error);
		}
	}

	private async showFluencyScoreNewsBanner(): Promise<void> {
		const dismissedKey = 'news.fluencyScoreBanner.v1.dismissed';
		if (this.context.globalState.get<boolean>(dismissedKey)) {
			return;
		}
		// If the user already opened the fluency view themselves, no need to prompt them
		const fluencyViewedKey = 'fluencyScore.everOpened';
		if (this.context.globalState.get<boolean>(fluencyViewedKey)) {
			await this.context.globalState.update(dismissedKey, true);
			return;
		}
		const openCountKey = 'extension.openCount';
		const openCount = (this.context.globalState.get<number>(openCountKey) ?? 0) + 1;
		await this.context.globalState.update(openCountKey, openCount);
		if (openCount < 5) {
			return;
		}
		const message = l10n.t('news.fluencyScoreBanner.message');
		const open = l10n.t('news.fluencyScoreBanner.open');
		const dismiss = l10n.t('news.fluencyScoreBanner.dismiss');
		const choice = await vscode.window.showInformationMessage(
			message,
			open,
			dismiss
		);
		await this.context.globalState.update(dismissedKey, true);
		if (choice === open) {
			await this.showMaturity();
		}
	}

	/**
	 * Shows a one-time popup pointing users at the new Efficiency view. Fires once per
	 * install: the dismissed flag is set immediately so the notification never reappears,
	 * even if the user ignores it. Can be cleared from Diagnostics > Debug for re-testing.
	 */
	private async showEfficiencyTabNewsBanner(): Promise<void> {
		const dismissedKey = 'news.efficiencyTab.v1.dismissed';
		if (this.context.globalState.get<boolean>(dismissedKey)) {
			return;
		}
		await this.context.globalState.update(dismissedKey, true);
		const message = l10n.t('news.efficiencyTabBanner.message');
		const open = l10n.t('news.efficiencyTabBanner.open');
		const choice = await vscode.window.showInformationMessage(
			message,
			open
		);
		if (choice === open) {
			await this.showEfficiency();
		}
	}

	private getUnknownMcpToolsFromStats(stats: UsageAnalysisStats): string[] {
		const allTools = new Set<string>();
		Object.keys(stats.today.mcpTools.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.last30Days.mcpTools.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.month.mcpTools.byTool).forEach(tool => allTools.add(tool));
		// MCP server names are rendered through the same friendly-name lookup in the
		// "By Server" tables, so include them in the missing-name detection too.
		Object.keys(stats.today.mcpTools.byServer).forEach(server => allTools.add(server));
		Object.keys(stats.last30Days.mcpTools.byServer).forEach(server => allTools.add(server));
		Object.keys(stats.month.mcpTools.byServer).forEach(server => allTools.add(server));
		Object.keys(stats.today.toolCalls.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.last30Days.toolCalls.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.month.toolCalls.byTool).forEach(tool => allTools.add(tool));
		const suppressed = new Set<string>(
			vscode.workspace.getConfiguration('aiEngineeringFluency').get<string[]>('suppressedUnknownTools', [])
		);
		return Array.from(allTools).filter(tool => !lookupKnownToolName(tool, this.toolNameMap) && !isKnownToolDisplayName(tool, this.toolNameMap) && !isGuidMcpTool(tool) && !isMcpFamilyResolvedTool(tool) && !suppressed.has(tool)).sort();
	}

	private async showUnknownMcpToolsBanner(): Promise<void> {
		const dismissedKey = 'news.unknownMcpTools.dismissedVersion';
		const dismissedVersion = this.context.globalState.get<string>(dismissedKey);
		if (dismissedVersion === packageJson.version) {
			return;
		}
		const openCountKey = 'extension.unknownMcpOpenCount';
		const openCount = (this.context.globalState.get<number>(openCountKey) ?? 0) + 1;
		await this.context.globalState.update(openCountKey, openCount);
		if (openCount < 8) {
			return;
		}
		const stats = await this.calculateUsageAnalysisStats(true);
		const unknownTools = this.getUnknownMcpToolsFromStats(stats);
		if (unknownTools.length === 0) {
			return;
		}
		const open = l10n.t('button.openUsageAnalysis');
		const dismiss = l10n.t('button.dismiss');
		const choice = await vscode.window.showInformationMessage(
			`🔌 Found ${unknownTools.length} tool${unknownTools.length > 1 ? 's' : ''} without friendly names. Help improve the extension by reporting them.`,

			open,
			dismiss
		);
		await this.context.globalState.update(dismissedKey, packageJson.version);
		if (choice === open) {
			await this.showUsageAnalysisOnToolsTab('unknown-mcp-tools-section');
		}
	}

	private async storeDiscoveredEditorsAndNotify(discoveredEditors: Iterable<string>): Promise<void> {
		const existingSeenEditors = this.context.globalState.get<string[] | undefined>(
			CopilotTokenTracker.SEEN_EDITORS_STATE_KEY,
			undefined,
		);
		const existingNotifiedEditors = this.context.globalState.get<string[] | undefined>(
			CopilotTokenTracker.NOTIFIED_EDITORS_STATE_KEY,
			undefined,
		);
		const { seenEditors, newEditors } = mergeSeenEditors(existingSeenEditors, discoveredEditors);

		const changed =
			existingSeenEditors === undefined ||
			existingSeenEditors.length !== seenEditors.length ||
			existingSeenEditors.some((editor, i) => editor !== seenEditors[i]);
		if (changed) {
			await this.context.globalState.update(CopilotTokenTracker.SEEN_EDITORS_STATE_KEY, seenEditors);
		}
		const { notifiedEditors, editorsToNotify } = mergeNotifiedEditors(existingNotifiedEditors, newEditors);
		const notifiedChanged =
			existingNotifiedEditors === undefined ||
			existingNotifiedEditors.length !== notifiedEditors.length ||
			existingNotifiedEditors.some((editor, i) => editor !== notifiedEditors[i]);
		if (notifiedChanged) {
			await this.context.globalState.update(CopilotTokenTracker.NOTIFIED_EDITORS_STATE_KEY, notifiedEditors);
		}
		if (editorsToNotify.length === 0) { return; }

		const names = editorsToNotify.join(', ');
		this.log(`🆕 New editor${editorsToNotify.length > 1 ? 's' : ''} discovered: ${names}`);
		void vscode.window.showInformationMessage(
			editorsToNotify.length === 1
				? `🆕 New editor detected: ${editorsToNotify[0]}. New session data from this editor is now included in your stats.`
				: `🆕 New editors detected: ${names}. New session data from these editors is now included in your stats.`
		);
	}

	private setStatusBarText(text: string): void {
		this._statusBarBaseText = text;
		this.statusBarItem.text = this._devBranch ? `${text} [${this._devBranch}]` : text;
	}

	/**
	 * Repaints the insights badge. `topInsight` is set unconditionally rather than carried over:
	 * once the previous top insight is dismissed, snoozed or marked done, keeping it would leave
	 * the tooltip naming — and a click scrolling to — a card that is no longer at the top of the
	 * list. Callers that only know the count use `refreshInsightBadgeFromState`.
	 */
	private refreshStatusBarInsightBadge(count: number, topInsight?: { title: string; id: string }): void {
		this._newInsightCount = count;
		this._topInsightTitle = topInsight?.title ?? null;
		this._topInsightId = topInsight?.id ?? null;
		// Main status bar: remove the 💡 badge — it now lives in its own item
		this.setStatusBarText(this._statusBarBaseText);

		if (count > 0) {
			const label = count === 1 ? '1 insight' : `${count} insights`;
			this.insightsStatusBarItem.text = `💡 ${label}`;
			const tooltip = new vscode.MarkdownString();
			tooltip.isTrusted = false;
			tooltip.appendMarkdown(`**${l10n.t('aiFluencyInsights')}** — ${label} waiting for you\n\n`);
			if (this._topInsightTitle) {
				tooltip.appendMarkdown(`${this._topInsightTitle}\n\n`);
			}
			tooltip.appendMarkdown('Click to open the Insights tab');
			this.insightsStatusBarItem.tooltip = tooltip;
			// Pass the insight the tooltip names so the click lands on that card, not just the tab.
			this.insightsStatusBarItem.command = this._topInsightId
				? { command: 'aiEngineeringFluency.openInsightsTab', title: l10n.t('button.openInsightsTab'), arguments: [this._topInsightId] }
				: 'aiEngineeringFluency.openInsightsTab';
			this.insightsStatusBarItem.show();
		} else {
			this.insightsStatusBarItem.hide();
		}
	}

	/**
	 * Recomputes the badge so its count, tooltip and click target all describe the same, current
	 * list. `evaluated` lets a caller that already built that list pass it in rather than
	 * evaluating every insight twice.
	 *
	 * The count comes from the evaluated list rather than the persisted state bag: the bag keeps
	 * entries for insights that no longer apply (`mergeInsightStates` adds and refreshes, never
	 * removes), so a bag-derived count can claim insights the Insights tab does not show and name
	 * none of them. Counting the 'new' entries of the list is exactly what the tab's own badge
	 * does, so the two can no longer disagree. Only with no list at all — stats not loaded yet —
	 * is the bag the only thing left to go on.
	 */
	private refreshInsightBadgeFromState(now: string, evaluated?: EvaluatedInsight[]): void {
		const stats = this.currentUsageAnalysisStats;
		const list = evaluated ?? (stats ? this.buildCurrentInsights(stats) : undefined);
		if (!list) {
			this.refreshStatusBarInsightBadge(_countNewInsights(this._insightStateBag, now));
			return;
		}
		const newInsights = list.filter(i => i.status === 'new');
		const topNew = newInsights[0];
		this.refreshStatusBarInsightBadge(
			newInsights.length,
			topNew ? { title: topNew.title, id: topNew.id } : undefined,
		);
	}

	/**
	 * Send a loading-screen message to every panel waiting on this same
	 * updateTokenStats()/_runRefreshCore() run.
	 *
	 * Deliberately narrow to `_refreshLoadingPanels`, not every open loading screen: the
	 * script renders each message over the whole screen — subtitle, file counters, parse
	 * checklist and editor pills, not just the bar — so broadcasting to a panel waiting on a
	 * *different* operation would show that operation's counts and labels as if they were its
	 * own. `_refreshLoadingPanels` only ever holds panels (Details, Environmental) that awaited
	 * this exact call chain, so broadcasting to all of them is safe. Every other loading screen
	 * (Efficiency's own build, Log Viewer/Maturity's independent loads) sends to itself instead;
	 * see `efficiencyLoadingSink()`.
	 */
	private sendLoadingPanelMessage(msg: object): void {
		for (const panel of this._refreshLoadingPanels) {
			void panel.webview.postMessage(msg);
		}
	}

	/**
	 * The Efficiency loading screen's sink: reports to whichever Efficiency panel is live.
	 *
	 * It used to be bound to the panel that started the build, so that a build outliving a
	 * closed panel could not paint onto the replacement a reopen created. That protected
	 * against two Efficiency builds reporting at once — which `runEfficiencyBuild()` had
	 * already made impossible, since both entry points queue through it. What it did instead
	 * was leave a reopened panel with a dead loading screen for the whole of the previous
	 * build's walk, while its own build sat queued behind it: the frozen bar this view was
	 * changed to stop showing, arrived at from the other direction.
	 *
	 * With at most one build in flight, its progress is the only Efficiency work happening,
	 * and so is by definition what the live panel is waiting on — its own build, or the one
	 * ahead of it in the queue. Rendering is unaffected: every render path checks
	 * `efficiencyPanel === panel` separately, so a stale build still cannot draw its result
	 * over the replacement's.
	 */
	private efficiencyLoadingSink(): (msg: object) => void {
		return makeLivePanelSink(() => this.efficiencyPanel);
	}

	/**
	 * Requests the one automatic Efficiency rebuild a cache invalidation is owed.
	 *
	 * Two paths independently notice an invalidation and want the panel rebuilt: `clearCache()`,
	 * and a detached build discovering on completion that its payload predates the clear. Both
	 * are correct to want it and neither can be dropped — `clearCache()` is not the only writer
	 * that bumps the generation, so the build-side retry still covers the others — but together
	 * they queued two full walks for a single clear, doubling exactly the wait this view exists
	 * to make legible. Recording the generation a rebuild was requested for collapses them: the
	 * first caller through wins, the second no-ops, and a *later* invalidation gets its own.
	 */
	private requestEfficiencyRebuild(): void {
		if (!this.efficiencyPanel) { return; }
		const plan = planEfficiencyRebuild(
			this._efficiencyRebuildRequestedFor, this._cacheGeneration, this._efficiencyBuildsQueued,
			this._efficiencyBuildCompletedFor, this._efficiencyBuildRunningFor,
		);
		if (plan === 'already-requested') { return; }
		this._efficiencyRebuildRequestedFor = this._cacheGeneration;
		if (plan === 'already-built') {
			this.log('⚡ [Efficiency] A build has already produced data for this generation; nothing to rebuild');
			return;
		}
		if (plan === 'coalesce-onto-queued') {
			this.log('⚡ [Efficiency] A queued build will capture this invalidation; not queuing a second walk');
			return;
		}
		if (plan === 'coalesce-onto-running') {
			this.log('⚡ [Efficiency] The running build already captured this invalidation; not queuing a second walk');
			return;
		}
		void this.refreshEfficiencyPanel();
	}

	/**
	 * Releases the automatic-rebuild stamp after a build fails.
	 *
	 * requestEfficiencyRebuild() marks a generation satisfied when it defers to a build that is
	 * already queued — which assumes that build publishes. If it throws instead, the panel is left
	 * on its error or fallback state and the stamp would keep every later request for that same
	 * generation coalescing into nothing. Clearing it re-opens the retry without auto-retrying,
	 * which could loop on a build that fails every time.
	 *
	 * Identity-checked on the failed build's own generation, exactly as clearInFlightRefresh() is
	 * on its run. An unconditional clear lets a *stale* build's failure erase a stamp a newer
	 * invalidation has already set — and once that newer replacement starts, dropping the queued
	 * count to zero, the next automatic request queues a duplicate full-year walk.
	 */
	private releaseEfficiencyRebuildRequest(failedAtGeneration: number): void {
		if (this._efficiencyRebuildRequestedFor !== failedAtGeneration) { return; }
		this._efficiencyRebuildRequestedFor = undefined;
	}

	/**
	 * Serializes Efficiency builds, tracking how many are queued but not yet started.
	 *
	 * Two builds overlapping is not only a render race: they write shared caches
	 * (`lastUsageAnalysisStats`, `lastEfficiencySessionInputs`, `lastFullDailyStats`), so an older
	 * build finishing second leaves stale data behind for every later view. Running them one at a
	 * time removes that ordering problem at the source, and a queued refresh then reuses whatever
	 * the build ahead of it just cached.
	 *
	 * The count is decremented immediately before `build` runs, so a non-zero count means at least
	 * one build is still going to read the live generation. That is what lets
	 * requestEfficiencyRebuild() coalesce onto it instead of queuing a second walk.
	 *
	 * Once a build starts, that count no longer describes it, so its captured generation is
	 * recorded in `_efficiencyBuildRunningFor` for as long as it runs — a build that captured the
	 * live generation answers an invalidation just as well while running as it did while queued.
	 * The capture is taken here and *handed* to `build`, rather than each caller re-reading
	 * `_cacheGeneration` as its first statement: one capture cannot drift from the other if there
	 * is only one. It is cleared identity-checked, so a build settling after its successor started
	 * cannot erase the successor's registration.
	 */
	private runEfficiencyBuild<T>(build: (generation: number) => Promise<T>): Promise<T> {
		this._efficiencyBuildsQueued++;
		const { result, chain } = chainBuild(this._efficiencyBuildChain, async () => {
			this._efficiencyBuildsQueued--;
			const generation = this._cacheGeneration;
			this._efficiencyBuildRunningFor = generation;
			try { return await build(generation); }
			finally {
				if (this._efficiencyBuildRunningFor === generation) { this._efficiencyBuildRunningFor = undefined; }
			}
		});
		this._efficiencyBuildChain = chain;
		return result;
	}

	/**
	 * Authenticate with GitHub using VS Code's authentication API.
	 */
	public async authenticateWithGitHub(): Promise<void> {
		try {
			this.log('Attempting GitHub authentication...');
			const signOutCountAtStart = this._signOutCount;
			const session = await vscode.authentication.getSession(
				getGitHubAuthProviderId(),
				['read:user'],
				{ createIfNone: true }
			);
			// A sign-out that ran while the sign-in request / account picker was pending was the later user
			// action and must stand; restoring the session here would silently undo it.
			if (signOutCountAtStart !== this._signOutCount) {
				this.log('Sign-in result discarded: the user signed out while it was pending');
				return;
			}
			if (session) {
				// Supersedes any silent lookup still in flight.
				this._sessionLookupSeq++;
				this.githubSession = session;
				this._githubSignedOutByUser = false;
				// Symmetric with sign-out: the flag that suppressed the memory fetch has just
				// been lifted, so re-render rather than leaving the section blank until the
				// next periodic refresh happens to come round.
				this.invalidateServerMemoriesCache();
				await this.context.globalState.update('github.signedOutByUser', false);
				this.log(`✅ Successfully authenticated as ${session.account.label}`);
				vscode.window.showInformationMessage(`GitHub authentication successful! Logged in as ${session.account.label}`);
				await this.context.globalState.update('github.authenticated', true);
				await this.context.globalState.update('github.username', session.account.label);
				void this.loadAndLogCopilotPlanInfo();
			}
		} catch (error) {
			this.error('GitHub authentication failed:', error);
			vscode.window.showErrorMessage('Failed to authenticate with GitHub. Please try again.');
		}
	}

	/**
	 * Sign out from GitHub.
	 */
	public async signOutFromGitHub(): Promise<void> {
		try {
			this.log('Signing out from GitHub...');
			this.githubSession = undefined;
			this._githubSignedOutByUser = true;
			this._signOutCount++;
			this._sessionLookupSeq++;
			this._accountBudgets = [];
			this._accountBudgetsRefreshSeq++;
			this.clearPreferredAccountBudgetState();
			this.pushAccountBudgetsToPanels();
			this.refreshBudgetDependentUi();
			await this.context.globalState.update('github.authenticated', false);
			await this.context.globalState.update('github.username', undefined);
			await this.context.globalState.update('github.signedOutByUser', true);
			// Clear the repository-memory cache with the other GitHub-derived snapshots below.
			// Explicit sign-out revokes nothing at the provider — the VS Code session survives —
			// so without this an already-fetched analysis stays renderable, and the next refresh
			// would happily reuse that still-valid session.
			this.invalidateServerMemoriesCache();
			this.log('✅ Successfully signed out from GitHub');
			vscode.window.showInformationMessage('Signed out from GitHub successfully.');

			const since = new Date();
			since.setDate(since.getDate() - 30);
			// Record the unauthenticated PR result regardless of which panels are open: the
			// Efficiency view's Value tab derives its PR metrics from this same snapshot, and
			// sign-out is also reachable from Diagnostics and the command palette. Leaving the
			// authenticated snapshot in place would keep those cards showing PR metrics the user
			// just signed out of. publishRepoPrStats() tolerates a closed Analysis panel (the
			// message is retained for replay) and notifies Efficiency itself.
			await this.publishRepoPrStats(this.buildEmptyRepoPrStatsResult(since, false));
			// Cloud-agent data has no such cross-panel consumer, so it stays panel-conditional.
			if (this.analysisPanel) {
				await this.publishAgentSessions(this.buildEmptyAgentSessionsResult(since, false));
			}
		} catch (error) {
			this.error('Failed to sign out from GitHub:', error);
			vscode.window.showErrorMessage('Failed to sign out from GitHub.');
		}
	}

	/**
	 * Get the current GitHub authentication status.
	 */
	public getGitHubAuthStatus(): { authenticated: boolean; username?: string } {
		// Check in-memory session first — avoids race with globalState writes on startup
		if (this.githubSession) {
			return { authenticated: true, username: this.githubSession.account.label };
		}
		const authenticated = this.context.globalState.get<boolean>('github.authenticated', false);
		const username = this.context.globalState.get<string>('github.username');
		return { authenticated, username };
	}

	/**
	 * Check if the user is authenticated with GitHub.
	 */
	public isGitHubAuthenticated(): boolean {
		// Primary check: in-memory session
		if (this.githubSession !== undefined) {
			return true;
		}
		// Fallback: check persisted state (session may not be restored yet)
		// Note: This may be true even if the session is expired
		// The restoreGitHubSession method will reconcile this on startup
		return this.context.globalState.get<boolean>('github.authenticated', false);
	}

	/**
	 * Get the current GitHub session (if authenticated).
	 */
	public getGitHubSession(): vscode.AuthenticationSession | undefined {
		return this.githubSession;
	}

	private repoPrStatsSince(): Date {
		const since = new Date();
		since.setDate(since.getDate() - 30);
		return since;
	}

	/** Path of the cross-window Repository PRs snapshot shared by every window of this VS Code edition. */
	private repoPrCachePath(): string {
		return getRepoPrCachePath(this.context.globalStorageUri.fsPath, this.cacheManager.getCacheIdentifier());
	}

	/** An empty snapshot — `fetchedAt: ''` marks "never fetched", which the panel renders as pending. */
	private buildEmptyRepoPrStatsResult(since: Date, authenticated: boolean): RepoPrStatsResult {
		return { repos: [], authenticated, since: since.toISOString(), fetchedAt: '' };
	}

	/**
	 * Remember and push a snapshot to the analysis panel, if one is open. The refresh interval is
	 * stamped on here so the panel can show when the next refresh is due without duplicating the
	 * cache policy.
	 */
	private async publishRepoPrStats(result: RepoPrStatsResult): Promise<void> {
		// A refresh already in flight when the user signs out finishes with an authenticated result,
		// and publishing it would repopulate both the Repository PRs tab and the Efficiency Value
		// cards that the sign-out just cleared. The guard in maybeRefreshRepoPrStats() only covers
		// refreshes that have not started yet, so drop the late result here.
		if (!shouldPublishRepoPrStats(result, this._githubSignedOutByUser)) {
			this.log('🔎 Dropping an authenticated repository PR result — the user signed out while it was in flight');
			return;
		}
		const stamped: RepoPrStatsResult = { ...result, refreshIntervalMs: REPO_PRS_REFRESH_INTERVAL_MS };
		this._lastRepoPrStats = stamped;
		const { delivered, wasReady } = await this.analysisMessageReplay.publish('repoPrStats', { command: 'repoPrStatsLoaded', data: stamped });
		this.log(`🔎 Repository PR stats posted for ${stamped.repos.length} repo(s) (delivered=${delivered}, webviewReady=${wasReady}, ${this._describeAnalysisPanel()})`);

		// The Efficiency view's Value tab is derived from this same snapshot, and it is routinely
		// rendered before Repository PRs are loaded from the Usage Analysis panel. Push a
		// Value-only update so its "no data" hint doesn't persist until an explicit Refresh click
		// (showEfficiency() deliberately doesn't recompute on reveal, and `retainContextWhenHidden`
		// means revealing a hidden panel re-renders nothing).
		await this.notifyEfficiencyValueSignals();
	}

	/**
	 * Show Repository PR stats in the analysis panel.
	 *
	 * This never calls GitHub itself: it serves the shared hourly snapshot (see `repoPrCache.ts`)
	 * so opening the tab is instant and costs no API calls, then asks for a refresh, which only
	 * happens if the snapshot is stale *and* this window wins the repo-PRs lock.
	 */
	private async loadRepoPrStats(): Promise<void> {
		if (!this.analysisPanel) { return; }

		const since = this.repoPrStatsSince();
		this.log('🔎 Loading repository PR stats (last 30 days)…');
		try {
			await this.collectAndPublishRepoPrStats(since);
		} catch (err) {
			// Guarantee a post-back on every failure path — otherwise the webview stays on
			// "Loading…" forever and dispatch() dedup silently swallows every retry.
			// publish() routes through analysisMessageReplay, which retains the payload and
			// tolerates the panel being disposed mid-flight (postMessage on a disposed webview
			// resolves false instead of throwing).
			this.error('Failed to load repository PR stats', err);
			const fallback = this._lastRepoPrStats ?? this.buildEmptyRepoPrStatsResult(since, !this._githubSignedOutByUser);
			// The webview renders the error box in place of the repo table whenever `error` is
			// set, even if `repos` is populated — so only surface it when there is no cached data
			// to fall back to. A transient snapshot-read/timeout failure would otherwise blank out
			// perfectly good previously-loaded PR data behind a "failed to load" message.
			const message = err instanceof Error ? err.message : String(err);
			await this.publishRepoPrStats(fallback.repos.length > 0 ? fallback : { ...fallback, error: message });
		}
	}

	private async collectAndPublishRepoPrStats(since: Date): Promise<void> {
		if (this._githubSignedOutByUser) {
			await this.publishRepoPrStats(this.buildEmptyRepoPrStatsResult(since, false));
			return;
		}

		const session = await this.syncSilentGitHubSession();
		if (!session) {
			await this.publishRepoPrStats(this.buildEmptyRepoPrStatsResult(since, false));
			return;
		}

		await this.publishRepoPrStats(this._lastRepoPrStats ?? this.buildEmptyRepoPrStatsResult(since, true));
		const snapshot = await _withTimeout(
			readRepoPrSnapshot(this.repoPrCachePath()),
			10_000,
			'Reading the repository PRs snapshot',
		);
		if (isRepoPrEnvelopeUsable(snapshot, since)) {
			await this.publishRepoPrStats(snapshot!.data);
		}

		void this.maybeRefreshRepoPrStats().catch((err) => {
			this.warn(`Repository PRs refresh scheduling failed: ${err}`);
		});
	}

	/**
	 * Refresh the Repository PRs snapshot from the GitHub API, if it is due.
	 *
	 * Collecting it costs a PR-list call (plus a commit-messages call per PR to detect
	 * co-authored-by AI) for every discovered repo, so it is deliberately rationed: at most once
	 * every REPO_PRS_REFRESH_INTERVAL_MS, and only in the window that wins the repo-PRs lock — the
	 * other windows read that window's snapshot from global storage instead of repeating the calls.
	 * Runs on extension start and on every cache refresh cycle (both leader-gated), plus whenever
	 * the Repository PRs tab is opened.
	 */
	private async maybeRefreshRepoPrStats(): Promise<void> {
		if (this._repoPrRefreshInFlight || this._githubSignedOutByUser) { return; }
		const since = this.repoPrStatsSince();
		const cachePath = this.repoPrCachePath();
		if (canServeRepoPrSnapshot(await readRepoPrSnapshot(cachePath), since, Date.now())) { return; }

		const session = await vscode.authentication.getSession(getGitHubAuthProviderId(), ['read:user'], { silent: true });
		if (!session) { return; }

		let acquired = false;
		try { acquired = await this.cacheManager.acquireRepoPrLock(); }
		catch (err) { this.warn(`Failed to acquire repo-PRs lock: ${err}`); }
		if (!acquired) {
			this.log('⏭️ Repository PRs refresh skipped — another window is refreshing the shared snapshot');
			return;
		}

		this._repoPrRefreshInFlight = true;
		// Heartbeat the lock: a slow API pass must not look stale to another window, which would
		// let it start the same collection in parallel.
		const heartbeat = setInterval(() => { void this.cacheManager.renewRepoPrLock(); }, 60 * 1000);
		try {
			await this.refreshRepoPrStatsSnapshot(session.accessToken, session.account.label, since, cachePath);
		} catch (err) {
			this.warn(`Repository PRs refresh failed: ${err}`);
		} finally {
			clearInterval(heartbeat);
			this._repoPrRefreshInFlight = false;
			try { await this.cacheManager.releaseRepoPrLock(); }
			catch (err) { this.warn(`Failed to release repo-PRs lock: ${err}`); }
		}
	}

	/** Collect the snapshot from every discovered workspace repo, write it to disk and publish it. */
	private async refreshRepoPrStatsSnapshot(token: string, userLogin: string | undefined, since: Date, cachePath: string): Promise<void> {
		const workspacePaths = this._buildWorkspacePaths();
		const discoveryStart = Date.now();
		const repos = await discoverGitHubRepos(workspacePaths, getConfiguredGitHubEnterpriseUri());
		this.log(`🔎 Refreshing repository PRs snapshot: discovered ${repos.length} GitHub repo(s) across ${workspacePaths.length} workspace path(s) in ${((Date.now() - discoveryStart) / 1000).toFixed(1)}s`);
		const existingSnapshot = await readRepoPrSnapshot(cachePath);
		if (shouldPreserveRepoPrSnapshotForEmptyDiscovery(existingSnapshot, since, repos.length)) {
			this.log('🔎 Repository PR discovery found no workspace repos; preserving the existing shared snapshot');
			await this.publishRepoPrStats(existingSnapshot!.data);
			return;
		}
		await this.analysisMessageReplay.publish('repoPrStats', { command: 'repoPrStatsProgress', total: repos.length, done: 0 });

		const webOrigin = getConfiguredGitHubWebOrigin();
		const results: RepoPrInfo[] = [];
		for (let i = 0; i < repos.length; i++) {
			const { owner, repo } = repos[i];
			this.log(`🔎 Fetching PRs for ${owner}/${repo} (${i + 1}/${repos.length})…`);
			const { prs, error } = await fetchRepoPrs(owner, repo, token, since);
			this.log(`🔎 Fetched ${prs.length} PR(s) for ${owner}/${repo}${error ? ` — ${error}` : ''}`);
			const stats = this.collectAiPrStats(prs, error, userLogin);
			results.push({ owner, repo, repoUrl: `${webOrigin}/${owner}/${repo}`, ...stats, error });
			await this.analysisMessageReplay.publish('repoPrStats', { command: 'repoPrStatsProgress', total: repos.length, done: i + 1 });
		}

		const fetchedAt = new Date().toISOString();
		const result: RepoPrStatsResult = { repos: results, authenticated: true, since: since.toISOString(), fetchedAt };

		try {
			await writeRepoPrSnapshot(cachePath, {
				schemaVersion: REPO_PRS_CACHE_SCHEMA_VERSION,
				fetchedAt,
				since: result.since,
				data: result,
			});
		} catch (err) {
			this.warn(`Failed to write repository PRs snapshot: ${err}`);
		}

		this.log(`🔎 Repository PRs snapshot: ${results.length} repo(s)`);
		await this.publishRepoPrStats(result);
	}

	/** Classify one PR, pushing any AI detail rows and returning its contribution to the counters. */
	private classifyPr(pr: any, login: string | undefined, aiDetails: RepoPrDetail[]): { aiAuthored: number; aiReviewRequested: number; userAuthored: number; userMerged: number } {
		const author = pr.user?.login ?? '';
		const authorAi = detectAiType(pr.user);
		let aiAuthored = 0;
		if (authorAi) {
			aiAuthored = 1;
			aiDetails.push({ number: pr.number, title: pr.title, url: pr.html_url, aiType: authorAi, role: 'author' });
		}
		let aiReviewRequested = 0;
		for (const reviewer of (pr.requested_reviewers ?? [])) {
			const reviewerAi = detectAiType(reviewer);
			if (reviewerAi) {
				aiReviewRequested++;
				aiDetails.push({ number: pr.number, title: pr.title, url: pr.html_url, aiType: reviewerAi, role: 'reviewer-requested' });
			}
		}
		const isUser = !!login && author.toLowerCase() === login;
		return {
			aiAuthored,
			aiReviewRequested,
			userAuthored: isUser ? 1 : 0,
			userMerged: isUser && pr.merged_at ? 1 : 0,
		};
	}

	private collectAiPrStats(prs: any[], error: any, userLogin?: string): { totalPrs: number; aiAuthoredPrs: number; aiReviewRequestedPrs: number; aiDetails: RepoPrDetail[]; userAuthoredPrs?: number; userMergedPrs?: number } {
		let totalPrs = 0;
		let aiAuthoredPrs = 0;
		let aiReviewRequestedPrs = 0;
		let userAuthoredPrs = 0;
		let userMergedPrs = 0;
		const aiDetails: RepoPrDetail[] = [];
		const login = userLogin?.toLowerCase();
		if (!error) {
			totalPrs = prs.length;
			for (const pr of prs) {
				const c = this.classifyPr(pr, login, aiDetails);
				aiAuthoredPrs += c.aiAuthored;
				aiReviewRequestedPrs += c.aiReviewRequested;
				userAuthoredPrs += c.userAuthored;
				userMergedPrs += c.userMerged;
			}
		}
		return login
			? { totalPrs, aiAuthoredPrs, aiReviewRequestedPrs, aiDetails, userAuthoredPrs, userMergedPrs }
			: { totalPrs, aiAuthoredPrs, aiReviewRequestedPrs, aiDetails };
	}

	/** Window the cloud-agent snapshot covers: the last 30 days, matching the other GitHub panels. */
	private agentSessionsSince(): Date {
		const since = new Date();
		since.setDate(since.getDate() - 30);
		return since;
	}

	/** Path of the cross-window cloud-agent snapshot shared by every window of this VS Code edition. */
	private agentTasksCachePath(): string {
		return getAgentTasksCachePath(this.context.globalStorageUri.fsPath, this.cacheManager.getCacheIdentifier());
	}

	/** An empty snapshot — `fetchedAt: ''` marks "never fetched", which the panel renders as pending. */
	private buildEmptyAgentSessionsResult(since: Date, authenticated: boolean): AgentSessionsResult {
		return {
			repos: [], totalTasks: 0, totalSessions: 0, totalCredits: 0, totalPremiumRequests: 0,
			authenticated, since: since.toISOString(), fetchedAt: '',
			accountTasksAvailable: false, partial: false,
		};
	}

	/**
	 * Remember and push a snapshot to the analysis panel, if one is open. The refresh interval is
	 * stamped on here so the panel can show when the next refresh is due without duplicating the
	 * cache policy.
	 */
	private async publishAgentSessions(result: AgentSessionsResult): Promise<void> {
		const stamped: AgentSessionsResult = { ...result, refreshIntervalMs: AGENT_TASKS_REFRESH_INTERVAL_MS };
		this._lastAgentSessionsData = stamped;
		const { delivered, wasReady } = await this.analysisMessageReplay.publish('agentSessions', { command: 'agentSessionsLoaded', data: stamped });
		this.log(`🤖 Cloud agent snapshot posted (${stamped.repos.length} repo(s), delivered=${delivered}, webviewReady=${wasReady})`);
	}

	/**
	 * Show Copilot cloud agent session stats in the analysis panel.
	 *
	 * This never calls GitHub itself: it serves the shared hourly snapshot (see `agentTasksCache.ts`)
	 * so opening the tab is instant and costs no API calls, then asks for a refresh, which only
	 * happens if the snapshot is stale *and* this window wins the agent-tasks lock.
	 */
	private async loadAgentSessions(): Promise<void> {
		if (!this.analysisPanel) { return; }
		const since = this.agentSessionsSince();
		this.log('🤖 Loading cloud agent sessions…');
		try {
			await this.collectAndPublishAgentSessions(since);
		} catch (err) {
			// Guarantee a post-back on every failure path so the webview never hangs on "Loading…".
			this.error('Failed to load cloud agent sessions', err);
			await this.publishAgentSessions(this._lastAgentSessionsData ?? this.buildEmptyAgentSessionsResult(since, !this._githubSignedOutByUser));
		}
	}

	private async collectAndPublishAgentSessions(since: Date): Promise<void> {
		if (this._githubSignedOutByUser) {
			await this.publishAgentSessions(this.buildEmptyAgentSessionsResult(since, false));
			return;
		}

		const session = await this.syncSilentGitHubSession();
		if (!session) {
			await this.publishAgentSessions(this.buildEmptyAgentSessionsResult(since, false));
			return;
		}

		await this.publishAgentSessions(this._lastAgentSessionsData ?? this.buildEmptyAgentSessionsResult(since, true));
		const snapshot = await _withTimeout(
			readAgentTasksSnapshot(this.agentTasksCachePath()),
			10_000,
			'Reading the cloud agent snapshot',
		);
		if (isAgentTasksEnvelopeUsable(snapshot, since)) {
			await this.publishAgentSessions(snapshot!.data);
		}

		void this.maybeRefreshAgentSessions().catch((err) => {
			this.warn(`Cloud agent refresh scheduling failed: ${err}`);
		});
	}

	/**
	 * Refresh the cloud-agent snapshot from the GitHub API, if it is due.
	 *
	 * Collecting it costs one task-list call per repo plus one detail call per task, so it is
	 * deliberately rationed: at most once every AGENT_TASKS_REFRESH_INTERVAL_MS, and only in the
	 * window that wins the agent-tasks lock — the other windows read that window's snapshot from
	 * global storage instead of repeating the calls. Runs on extension start and on every cache
	 * refresh cycle (both leader-gated), plus whenever the Cloud Agent tab is opened.
	 */
	private async maybeRefreshAgentSessions(): Promise<void> {
		if (this._agentSessionsRefreshInFlight || this._githubSignedOutByUser) { return; }
		const since = this.agentSessionsSince();
		const cachePath = this.agentTasksCachePath();
		if (canServeAgentTasksSnapshot(await readAgentTasksSnapshot(cachePath), since, Date.now())) { return; }

		const session = await vscode.authentication.getSession(getGitHubAuthProviderId(), ['read:user'], { silent: true });
		if (!session) { return; }

		let acquired = false;
		try { acquired = await this.cacheManager.acquireAgentTasksLock(); }
		catch (err) { this.warn(`Failed to acquire agent tasks lock: ${err}`); }
		if (!acquired) {
			this.log('⏭️ Cloud agent refresh skipped — another window is refreshing the shared snapshot');
			return;
		}

		this._agentSessionsRefreshInFlight = true;
		// Heartbeat the lock: a slow API pass must not look stale to another window, which would
		// let it start the same collection in parallel.
		const heartbeat = setInterval(() => { void this.cacheManager.renewAgentTasksLock(); }, 60 * 1000);
		try {
			await this.refreshAgentSessionsSnapshot(session.accessToken, since, cachePath);
		} catch (err) {
			this.warn(`Cloud agent session refresh failed: ${err}`);
		} finally {
			clearInterval(heartbeat);
			this._agentSessionsRefreshInFlight = false;
			try { await this.cacheManager.releaseAgentTasksLock(); }
			catch (err) { this.warn(`Failed to release agent tasks lock: ${err}`); }
		}
	}

	/**
	 * Collect the snapshot and publish it, combining the workspace repos (which also surface tasks
	 * other people started there) with the account-wide task list (tasks started on github.com in
	 * repos that aren't checked out here, and ad-hoc cloud chat tasks with no repository at all).
	 */
	private async refreshAgentSessionsSnapshot(token: string, since: Date, cachePath: string): Promise<void> {
		const workspaceRepos = await discoverGitHubRepos(this._buildWorkspacePaths(), getConfiguredGitHubEnterpriseUri());
		this.log(`🤖 Refreshing cloud agent snapshot (${workspaceRepos.length} workspace repo(s) + account-wide tasks)`);

		const result = await collectAgentSessions({
			token,
			since,
			workspaceRepos,
			onProgress: (done, total) => {
				void this.analysisMessageReplay.publish('agentSessions', { command: 'agentSessionsProgress', total, done });
			},
		});

		try {
			await writeAgentTasksSnapshot(cachePath, {
				schemaVersion: AGENT_TASKS_CACHE_SCHEMA_VERSION,
				fetchedAt: result.fetchedAt,
				since: result.since,
				data: result,
			});
		} catch (err) {
			this.warn(`Failed to write cloud agent snapshot: ${err}`);
		}

		this.log(`🤖 Cloud agent snapshot: ${result.repos.length} repo(s), ${result.totalTasks} task(s), ${result.totalCredits.toFixed(1)} credits`);
		await this.publishAgentSessions(result);
	}

	/** Collect workspace paths from the customization matrix and currently open VS Code workspace folders. */
	private _buildWorkspacePaths(): string[] {
		const workspacePaths: string[] = [];
		const matrix = this._lastCustomizationMatrix;
		if (matrix && matrix.workspaces.length > 0) {
			for (const ws of matrix.workspaces) {
				if (!ws.workspacePath.startsWith('<unresolved:')) {
					workspacePaths.push(ws.workspacePath);
				}
			}
		}
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const p = folder.uri.fsPath;
			if (!workspacePaths.includes(p)) {
				workspacePaths.push(p);
			}
		}
		return workspacePaths;
	}

	/**
	 * Restore GitHub authentication session on extension startup.
	 * Always attempts a silent getSession so that a pre-existing VS Code GitHub
	 * session (e.g. from GitHub Copilot) is picked up automatically.
	 */
	private async restoreGitHubSession(): Promise<void> {
		try {
			// Respect explicit sign-out — don't auto-restore until user clicks Authenticate again
			this._githubSignedOutByUser = this.context.globalState.get<boolean>('github.signedOutByUser', false);
			if (this._githubSignedOutByUser) {
				this.log('GitHub session restore skipped — user signed out explicitly');
				return;
			}

			// Always try silently — never prompt (silent: true suppresses the Accounts-menu
			// sign-in badge). This picks up sessions from Copilot or other extensions that
			// already authenticated the user with GitHub, without nagging users who never
			// intend to sign in here.
			const lookupSeq = ++this._sessionLookupSeq;
			const session = await vscode.authentication.getSession(getGitHubAuthProviderId(), ['read:user'], { silent: true });
			// Same race as the session listener: a sign-out or a newer lookup during the await must stand.
			if (this._githubSignedOutByUser || lookupSeq !== this._sessionLookupSeq) { return; }
			if (session) {
				this.githubSession = session;
				this.log(`✅ GitHub session found for ${session.account.label}`);
				await this.context.globalState.update('github.authenticated', true);
				await this.context.globalState.update('github.username', session.account.label);
				void this.loadAndLogCopilotPlanInfo();
			} else {
				// No preferred session here, but other signed-in accounts may exist — list them anyway
				// so each shows its "sign in" prompt instead of waiting for a later auth event.
				void this.refreshAccountBudgets();
				const wasAuthenticated = this.context.globalState.get<boolean>('github.authenticated', false);
				if (wasAuthenticated) {
					// Session was present before but is gone now — clear stored state
					this.log('GitHub session not found - clearing authenticated state');
					await this.context.globalState.update('github.authenticated', false);
					await this.context.globalState.update('github.username', undefined);
				}
			}
		} catch (error) {
			this.warn('Failed to restore GitHub session: ' + String(error));
			await this.context.globalState.update('github.authenticated', false);
			await this.context.globalState.update('github.username', undefined);
		}
	}

	/**
	 * Fetch and log Copilot plan information and token endpoint metadata for the authenticated user.
	 * Both API calls run in parallel so all Copilot info is logged together as a single grouped block.
	 * For enterprise or business plans, also discovers the enterprise/org and checks the premium request budget.
	 * Best-effort: each call is independent — a failure in one does not suppress the other.
	 */
	private async loadAndLogCopilotPlanInfo(): Promise<void> {
		const session = this.githubSession;
		// Rechecked here as the last line of defence: a continuation that began before an explicit sign-out
		// must not start a fresh load (and a fresh generation) that repopulates the cleared budget state.
		if (!session || this._githubSignedOutByUser) { return; }
		// logCopilotPlanResult() only overwrites fields the response contains, so a switch to an account whose
		// lookup fails or omits a quota would otherwise keep the previous account's budget on screen.
		if (this._preferredPlanAccountId !== undefined && this._preferredPlanAccountId !== session.account.id) {
			this.clearPreferredAccountBudgetState();
			this.refreshBudgetDependentUi();
			this.pushAccountBudgetsToPanels();
		}
		this._preferredPlanAccountId = session.account.id;
		const generation = ++this._preferredPlanGeneration;
		const isStale = (): boolean => generation !== this._preferredPlanGeneration;

		const [planResult, tokenResult] = await Promise.all([
			fetchCopilotPlanInfo(session.accessToken).catch((err): ReturnType<typeof fetchCopilotPlanInfo> => Promise.resolve({ error: String(err) })),
			fetchCopilotTokenEndpointInfo(session.accessToken).catch((err): ReturnType<typeof fetchCopilotTokenEndpointInfo> => Promise.resolve({ error: String(err) })),
		]);
		// Applying the result writes the plan/quota caches, so a lookup that outlived a sign-out, an
		// account removal/switch, or was superseded by a newer load must not touch them.
		if (isStale()) { this.log('Copilot plan lookup superseded (sign-out or account change) — discarding its result'); return; }

		const isOrgPlan = this.logCopilotPlanResult(planResult);
		this.logCopilotTokenResult(tokenResult);

		if (isOrgPlan) {
			await this.loadAndLogEnterpriseInfo(session);
			if (isStale()) { return; }
		}

		// Publish the refreshed preferred-account quota now: the account enumeration below is best-effort and
		// can fail, which must not leave open panels showing the quota from before this refresh.
		this.pushAccountBudgetsToPanels();

		await this.refreshAccountBudgets();
		if (isStale()) { return; }

		// The plan info above may have populated a new Copilot plan quota / budget
		// (via captureQuotaEntitlement). The status bar tooltip flyout is only rebuilt
		// during token refreshes, so refresh it now so the freshly-fetched budget shows
		// up immediately after sign-in instead of only on the next 5-minute refresh.
		if (this.currentDetailedStats) {
		this.refreshBudgetDependentUi();
	}
	}

	/**
	 * Silent session lookup for the periodic PR / cloud-agent collectors. Adopts the session as the
	 * extension's own when it has none yet (so a pre-existing VS Code sign-in is picked up), but never
	 * undoes an explicit sign-out or overwrites a newer lookup: it returns undefined, adopting nothing,
	 * when a sign-out ran or another session lookup started while `getSession()` was pending.
	 *
	 * It only *reads* `_sessionLookupSeq` — it must not bump it, or this hourly refresh would cancel the
	 * auth listener's lookup right after an account switch.
	 */
	private async syncSilentGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
		const seqAtStart = this._sessionLookupSeq;
		const session = await vscode.authentication.getSession(getGitHubAuthProviderId(), ['read:user'], { silent: true });
		if (this._githubSignedOutByUser || seqAtStart !== this._sessionLookupSeq) { return undefined; }
		if (session && !this.githubSession) {
			this.githubSession = session;
			this.log(`✅ GitHub session synced from existing VS Code auth: ${session.account.label}`);
			await this.persistGitHubAuthState();
		}
		return session;
	}

	/**
	 * Writes the signed-in flag and username from the in-memory session. The flag is issued first, so a
	 * sign-out that lands afterwards queues its own signed-out write behind it; the username is re-read
	 * after the first await so it reflects that sign-out rather than a stale snapshot.
	 */
	private async persistGitHubAuthState(): Promise<void> {
		await this.context.globalState.update('github.authenticated', this.githubSession !== undefined);
		await this.context.globalState.update('github.username', this.githubSession?.account.label);
	}

	/**
	 * Looks up the Copilot budget for every GitHub account signed in to VS Code, then refreshes the
	 * tooltip and any open panels. Silent (never prompts) and best-effort: a failure leaves the
	 * previous result in place. Skipped after an explicit sign-out from this extension.
	 *
	 * Scope: only the provider named by getGitHubAuthProviderId() — `github` by default, or
	 * `github-enterprise` when `github-enterprise.uri` is set. Accounts on the other provider are not
	 * listed because the plan lookup is bound to that one configured API host.
	 */
	private async refreshAccountBudgets(): Promise<void> {
		if (this._githubSignedOutByUser) {
			this._accountBudgets = [];
			return;
		}
		const seq = ++this._accountBudgetsRefreshSeq;
		try {
			const plans = copilotPlansData.plans as Record<string, { name: string }>;
			const planNames = Object.fromEntries(Object.entries(plans).map(([id, p]) => [id, p.name]));
			const budgets = await fetchAllAccountBudgets(vscode.authentication, getGitHubAuthProviderId(), fetchCopilotPlanInfo, planNames);
			if (seq !== this._accountBudgetsRefreshSeq) { return; }
			this._accountBudgets = budgets;
			this.log(`GitHub accounts in VS Code: ${budgets.length === 0 ? 'none' : budgets.map((b) => `${b.label} (${b.status})`).join(', ')}`);
			this.refreshBudgetDependentUi();
			this.pushAccountBudgetsToPanels();
		} catch (error) {
			this.warn('Failed to load per-account Copilot budgets: ' + String(error));
		}
	}

	/** Forgets the plan and quota snapshot of the preferred account (sign-out, or the account was removed). */
	private clearPreferredAccountBudgetState(invalidateInFlight = true): void {
		if (invalidateInFlight) {
			this._preferredPlanGeneration++;
			this._preferredPlanAccountId = undefined;
		}
		this._copilotPlanResolved = undefined;
		this._copilotQuotaEntitlements = {};
	}

	/**
	 * Sends the budget state to the open panels that show it: the per-account list plus the preferred
	 * account's balance / quota, so clearing or refreshing that state reaches every surface.
	 */
	private pushAccountBudgetsToPanels(): void {
		// Through the replay buffer: a lookup that finishes before the panel's listener is ready is re-sent on readiness.
		void this.analysisMessageReplay.publish('accountBudgets', {
			command: 'updateAccountBudgets',
			accountBudgets: this._accountBudgets,
			copilotApiBalance: this._buildCopilotApiBalance(),
		});
		void this.diagnosticsPanel?.webview.postMessage({
			command: 'accountBudgetsUpdated',
			accountBudgets: this._accountBudgets,
			quotaEntitlements: this._copilotQuotaEntitlements,
		});
	}

	/** Rebuilds the status bar tooltip flyout (and its background color) from the last
	 *  computed stats so a budget change — e.g. picked up from the Copilot plan quota
	 *  right after GitHub sign-in — is reflected without waiting for the next refresh.
	 *  No-op until the first stats computation has produced a tooltip to update. */
	private refreshBudgetDependentUi(): void {
		const stats = this.currentDetailedStats;
		if (!stats) { return; }
		this.updateStatusBarBackgroundColor(stats);
		this.statusBarItem.tooltip = this.buildTooltipMarkdown(stats);
	}

	private logCopilotPlanResult(planResult: { planInfo?: any; statusCode?: number; error?: string }): boolean {
		const { planInfo, statusCode: planStatus, error: planError } = planResult;
		if (planError || !planInfo) {
			this.warn(`Copilot plan info unavailable (HTTP ${planStatus ?? 'n/a'}): ${planError ?? 'no data'}`);
			return false;
		}
		const planId = planInfo.copilot_plan as string | undefined;
		const planIdLower = (planId ?? '').toLowerCase();
		// Business and Enterprise plans are both backed by a GitHub Enterprise — show enterprise/budget info for both
		const isOrgPlan = planIdLower.includes('enterprise') || planIdLower.includes('business');
		const plans = copilotPlansData.plans as Record<string, { name: string; monthlyPremiumRequests: number | null; monthlyPricePerUser: number; monthlyAiCreditsUsd: number }>;
		const knownPlan = planId ? plans[planId] : undefined;
		const planLabel = knownPlan ? `${knownPlan.name} (${planId})` : (planId ?? 'unknown');
		this.log(`Copilot plan: ${planLabel}`);
		this.logCopilotPlanDetails(planId, knownPlan, planInfo);
		return isOrgPlan;
	}

	private logCopilotTokenResult(tokenResult: { info?: any; statusCode?: number; error?: string }): void {
		const { info, statusCode: tokenStatus, error: tokenError } = tokenResult;
		if (tokenError || !info) {
			this.warn(`Copilot token endpoint info unavailable (HTTP ${tokenStatus ?? 'n/a'}): ${tokenError ?? 'no data'}`);
			return;
		}
		if (info.endpoints?.api) { this.log(`  Copilot API endpoint: ${info.endpoints.api}`); }
		if (info.expires_at !== undefined) { this.log(`  Copilot token valid until: ${new Date(info.expires_at * 1000).toISOString()}`); }
		if (info.sku) { this.log(`  Copilot SKU: ${info.sku}`); }
	}

	/**
	 * Discover which GitHub Enterprise(s) the user belongs to and fetch the premium request budget.
	 * Fires for both Copilot Business and Copilot Enterprise plans (both are backed by a GitHub Enterprise).
	 * Uses GraphQL viewer.enterprises and the enterprise billing/budgets endpoint.
	 * Best-effort: requires enterprise admin or billing manager for budget data.
	 */
	private async loadAndLogEnterpriseInfo(session: vscode.AuthenticationSession): Promise<void> {
		const { enterprises, error: entError } = await fetchUserEnterprises(session.accessToken);
		if (entError || !enterprises?.length) {
			this.warn(`Enterprise discovery unavailable: ${entError ?? 'no enterprises found'}`);
			return;
		}

		const username = session.account.label;
		this.log(`  Enterprise(s): ${enterprises.map((e) => `${e.name} (${e.slug})`).join(', ')}`);

		// Fetch budget for each enterprise in parallel
		const budgetResults = await Promise.all(
			enterprises.map((e) =>
				fetchEnterprisePremiumBudgets(e.slug, username, session.accessToken)
					.then((r) => ({ enterprise: e, ...r }))
					.catch((err) => ({ enterprise: e, error: String(err) }))
			)
		);

		for (const result of budgetResults) {
			this.logEnterpriseBudgetResult(result as { enterprise: { slug: string; name: string }; budgets?: any[]; statusCode?: number; error?: string });
		}
	}

	private logEnterpriseBudgetResult(result: { enterprise: { slug: string; name: string }; budgets?: any[]; statusCode?: number; error?: string }): void {
		const { enterprise, budgets, statusCode, error } = result;
		if (error) {
			// 403 means the user isn't an admin/billing manager — log quietly
			const isForbidden = statusCode === 403 || error.includes('403');
			if (isForbidden) {
				this.log(`  Budget (${enterprise.slug}): not accessible (requires enterprise admin or billing manager)`);
			} else {
				this.warn(`  Budget fetch failed for ${enterprise.slug} (HTTP ${statusCode ?? 'n/a'}): ${error}`);
			}
			return;
		}
		if (!budgets?.length) {
			this.log(`  Budget (${enterprise.slug}): no premium request budgets configured`);
			return;
		}
		for (const budget of budgets) {
			const amount = budget.budget_amount !== undefined ? `$${budget.budget_amount}` : 'n/a';
			const block = budget.prevent_further_usage ? ', blocks usage' : '';
			this.log(`  Budget (${enterprise.slug}): ${amount}/month${block} [${budget.budget_scope ?? 'unknown scope'}]`);
		}
	}

	private logCopilotPlanDetails(planId: string | undefined, knownPlan: { name: string; monthlyPremiumRequests: number | null; monthlyPricePerUser: number; monthlyAiCreditsUsd: number } | undefined, planInfo: any): void {
		// A successful response is authoritative: start from empty so a quota or plan it no longer reports
		// (plan change, quota removed) is not carried over from the previous lookup of the same account.
		this.clearPreferredAccountBudgetState(false);
		this.logKnownPlanEntry(planId, knownPlan);
		if (this._copilotPlanResolved) {
			this._copilotPlanResolved.isMCPEnabled = typeof planInfo?.is_mcp_enabled === 'boolean' ? planInfo.is_mcp_enabled : undefined;
		}
		this.logPlanInfoUserFields(planInfo);
		this.logQuotaSnapshots(planInfo.quota_snapshots);
		this.logLegacyPlanFields(planInfo);
	}

	private logKnownPlanEntry(planId: string | undefined, knownPlan: { name: string; monthlyPremiumRequests: number | null; monthlyPricePerUser: number; monthlyAiCreditsUsd: number } | undefined): void {
		if (knownPlan) {
			const credits = knownPlan.monthlyPremiumRequests !== null ? `${knownPlan.monthlyPremiumRequests.toLocaleString()}/month` : 'unlimited';
			this.log(`  Monthly premium requests: ${credits}`);
			const aiCredits = knownPlan.monthlyAiCreditsUsd > 0 ? `$${knownPlan.monthlyAiCreditsUsd}/month included` : 'none';
			this.log(`  Monthly AI credits: ${aiCredits}`);
			this._copilotPlanResolved = {
				planId: planId!,
				planName: knownPlan.name,
				monthlyAiCreditsUsd: knownPlan.monthlyAiCreditsUsd,
				monthlyPremiumRequests: knownPlan.monthlyPremiumRequests,
			};
		} else if (planId) {
			this._copilotPlanResolved = { planId, planName: planId, monthlyAiCreditsUsd: 0, monthlyPremiumRequests: null };
		}
	}

	private logFieldIfDefined(label: string, value: any): void {
		if (value !== null && value !== undefined) {
			this.log(`  ${label}: ${value}`);
		}
	}

	private pushPartIfDefined(parts: string[], text: string, value: any): void {
		if (value !== null && value !== undefined) {
			parts.push(text);
		}
	}

	private logPlanInfoUserFields(planInfo: any): void {
		// Log user info from copilot_internal/user response
		this.logFieldIfDefined('Login', planInfo.login);
		this.logFieldIfDefined('Chat enabled', planInfo.chat_enabled);
		this.logFieldIfDefined('CLI enabled', planInfo.cli_enabled);
		this.logFieldIfDefined('MCP enabled', planInfo.is_mcp_enabled);
		this.logFieldIfDefined('Editor preview features', planInfo.editor_preview_features_enabled);
		this.logFieldIfDefined('Copilotignore enabled', planInfo.copilotignore_enabled);
		this.logFieldIfDefined('Restricted telemetry', planInfo.restricted_telemetry);
		this.logFieldIfDefined('Access type SKU', planInfo.access_type_sku);
		this.logFieldIfDefined('Assigned date', planInfo.assigned_date);
		if (Array.isArray(planInfo.organization_list)) {
			this.log(`  Organizations: ${planInfo.organization_list.join(', ')}`);
		}
		this.logFieldIfDefined('Quota reset date (UTC)', planInfo.quota_reset_date_utc);
		this.logFieldIfDefined('Quota reset date', planInfo.quota_reset_date);
		this.logFieldIfDefined('Token-based billing', planInfo.token_based_billing);
		this.logFieldIfDefined('Analytics tracking ID', planInfo.analytics_tracking_id);
	}

	private captureQuotaEntitlement(key: string, qs: any): void {
		if (qs.entitlement === null || qs.entitlement === undefined) { return; }
		if (key === 'premium_interactions') {
			this._copilotQuotaEntitlements.premium_interactions = qs.entitlement / 100;
			if (qs.quota_remaining !== null && qs.quota_remaining !== undefined) {
				this._copilotQuotaEntitlements.premium_interactions_remaining = Number(qs.quota_remaining);
			}
		} else if (key === 'completions') {
			this._copilotQuotaEntitlements.completions = qs.entitlement / 100;
		}
	}

	private pushEntitlementPart(parts: string[], entitlement: any): void {
		if (entitlement !== null && entitlement !== undefined) {
			parts.push(`entitlement=${entitlement} cents ($${(entitlement / 100).toFixed(2)})`);
		}
	}

	private logQuotaSnapshotEntry(key: string, snapshot: any): void {
		const qs = snapshot as any;
		if (typeof qs !== 'object' || qs === null) { return; }

		this.captureQuotaEntitlement(key, qs);

		const parts: string[] = [];
		this.pushPartIfDefined(parts, `id=${qs.quota_id}`, qs.quota_id);
		this.pushEntitlementPart(parts, qs.entitlement);
		this.pushPartIfDefined(parts, `unlimited=${qs.unlimited}`, qs.unlimited);
		this.pushPartIfDefined(parts, `remaining=${qs.quota_remaining}`, qs.quota_remaining);
		this.pushPartIfDefined(parts, `${qs.percent_remaining}%`, qs.percent_remaining);
		this.pushPartIfDefined(parts, `overage=${qs.overage_count}`, qs.overage_count);
		this.pushPartIfDefined(parts, `reset=${qs.quota_reset_at}`, qs.quota_reset_at);
		if (parts.length > 0) {
			this.log(`  Quota (${key}): ${parts.join(', ')}`);
		}
	}

	private logQuotaSnapshots(quotaSnapshots: any): void {
		if (!quotaSnapshots || typeof quotaSnapshots !== 'object') { return; }
		for (const [key, snapshot] of Object.entries(quotaSnapshots)) {
			this.logQuotaSnapshotEntry(key, snapshot);
		}
	}

	private logLegacyPlanFields(planInfo: any): void {
		// Log legacy fields if present (for backwards compatibility)
		this.logFieldIfDefined('IDE chat', planInfo.ide_chat);
		this.logFieldIfDefined('Agent mode', planInfo.copilot_ide_agent);
		this.logFieldIfDefined('Public code suggestions', planInfo.public_code_suggestions);
		this.logFieldIfDefined('Unlimited PR summaries', planInfo.unlimited_pr_summaries);
	}

	/** Forgets the in-flight refresh registration, but only if `run` is still the registered one. */
	private clearInFlightRefresh(run: Promise<DetailedStats | undefined>): void {
		if (this._updateTokenStatsInFlight !== run) { return; }
		this._updateTokenStatsInFlight = undefined;
		this._updateTokenStatsInFlightGeneration = undefined;
	}

	public async updateTokenStats(silent: boolean = false, skipIfBusy = false): Promise<DetailedStats | undefined> {
		// Coalesce concurrent callers onto the same in-flight run to prevent
		// multiple executions from racing to update the status bar simultaneously.
		// Background/timer callers pass skipIfBusy=true to drop the call rather than queue.
		//
		// Coalescing is only sound while the run's results are still publishable. A run that
		// gathered its inputs before a cache clear discards them rather than publishing
		// (_runRefreshCore()), so handing it to a caller on the far side of that clear would leave
		// clearCache() — which awaits this — having refreshed nothing at all. Such a caller waits
		// the superseded run out and starts a fresh one below.
		//
		// Waiting rather than running the two concurrently is deliberate. acquireRefreshLock() is a
		// cross-window file lock this window would still be holding, so an overlapping second run
		// would lose the leader election to the very run it is replacing and parse as a follower —
		// on FOLLOWER_MISS_BUDGET, over the cache the clear just emptied — and the first run's
		// stopRefreshHeartbeat()/releaseRefreshLock() would fire underneath it.
		while (this._updateTokenStatsInFlight) {
			const inFlight = this._updateTokenStatsInFlight;
			if (skipIfBusy) {
				this.log('updateTokenStats already in progress, skipping background refresh');
				return undefined;
			}
			if (this._updateTokenStatsInFlightGeneration === this._cacheGeneration) {
				this.log('updateTokenStats already in progress, coalescing onto existing run');
				return inFlight;
			}
			this.log('updateTokenStats in progress but predates a cache clear; waiting it out before refreshing');
			const settled = await inFlight.catch(() => undefined);
			// Its owner clears the registration in its own finally. Clearing it here too is what
			// stops this loop spinning on a promise that has already settled.
			this.clearInFlightRefresh(inFlight);
			// That run was registered before this caller's generation, but it captures again once
			// past its cache-load/snapshot/lock preamble (beginRefreshGeneration()). A clear landing
			// inside that preamble therefore leaves it publishing valid post-clear data — and
			// starting a second full refresh here would double the work for one clear.
			if (settled !== undefined && this._lastPublishedRefreshGeneration === this._cacheGeneration) {
				this.log('updateTokenStats: the run we waited for already covered this generation; reusing its result');
				return settled;
			}
		}

		const startedAt = Date.now();
		this._updateTokenStatsStartedAt = startedAt;
		const run = this._runUpdateTokenStats(silent);
		this._updateTokenStatsInFlight = run;
		this._updateTokenStatsInFlightGeneration = this._cacheGeneration;
		try {
			return await run;
		} finally {
			// Identity-checked: a superseded run settling after the fresh run that replaced it must
			// not deregister the fresh run.
			this.clearInFlightRefresh(run);
			if (this._updateTokenStatsStartedAt === startedAt) {
				this._updateTokenStatsStartedAt = undefined;
			}
		}
	}

	/**
	 * Seeds a preload queue with the on-disk cache's known file paths before adapter
	 * discovery (a full filesystem walk across ~15 adapters) even starts, so the
	 * worker pool begins stat+cache-validating files from tick zero instead of
	 * waiting for the slowest adapter's directory walk to stream its first batch.
	 * This is the "persist the discovery list ... render from it immediately,
	 * re-discover in the background and reconcile" fix from issue #2018: on a warm
	 * cache, most of the ~6500-file backlog is already known.
	 *
	 * Seeded paths are added to `seen` (keyed by _normalizePathForDedup(), the same
	 * normalization SessionDiscovery.addDedupedBatch() uses across adapters — separators and case
	 * can otherwise differ between a cache-recorded key and what a fresh adapter scan reports for
	 * the same physical file, e.g. on Windows) so the caller's discovery-batch handler can dedupe
	 * against them — a file is still only ever processed once; newly-added or previously uncached
	 * files still arrive through normal streaming discovery. A cached path for a file deleted
	 * since the last run simply fails its stat with ENOENT, which
	 * processPreloadQueueFileWithCrashLog already swallows — no different from any other file
	 * that disappears mid-scan today.
	 *
	 * Skipped entirely in sample-data mode (see isSampleDataModeActive()): SessionDiscovery
	 * bypasses every adapter in that mode and returns only the fixture's files, so seeding real
	 * cached sessions here would contaminate a screenshot/regression run with unrelated data.
	 *
	 * A seeded file that still exists but a clean, successful discovery pass no longer recognizes
	 * (an adapter's rules changed, an integration got disabled) is reconciled back out of the
	 * returned `preloaded` array by the caller, `_preloadSessionFiles()`, once the real discovery
	 * result is known — this method only seeds the fast warm path, it doesn't know discovery's
	 * outcome yet.
	 *
	 * Filtered to entries at or after `cutoffMs` — the same recency window `preloaded` itself is
	 * bounded to (~30 days) — not the full, snapshot-capped (20,000-entry) cache. The worker pool's
	 * concurrency is finite and this queue is a simple FIFO with no priority: seeding every cache
	 * entry regardless of age would let a large, long-lived cache's old-but-still-valid backlog
	 * occupy every worker ahead of the files that actually matter for this refresh's stats (today/
	 * last30Days), delaying exactly the fast, relevant results this method exists to speed up. An
	 * excluded older entry isn't lost — it still exists on disk, so normal streaming discovery finds
	 * it and its cache hit resolves just as fast, only later in the queue instead of dominating the
	 * front of it.
	 *
	 * Returns the number of paths seeded (for the caller's totalDiscovered count).
	 */
	private seedPreloadQueueFromCache(queue: string[], seen: Set<string>, cutoffMs: number, editorSet?: Set<string>): number {
		if (this.isSampleDataModeActive()) { return 0; }
		const cachedPaths = this.getDeduplicatedCacheEntries()
			.filter(([, data]) => data.mtime >= cutoffMs)
			.map(([filePath]) => filePath);
		if (cachedPaths.length === 0) { return 0; }
		for (const p of cachedPaths) { seen.add(_normalizePathForDedup(p)); }
		if (editorSet) {
			for (const file of cachedPaths) {
				const editor = this.detectEditorSource(file);
				if (editor && editor !== 'Unknown') { editorSet.add(editor); }
			}
		}
		queue.push(...cachedPaths);
		return cachedPaths.length;
	}

	/**
	 * A cache-seeded file that still exists on disk but is no longer recognized by ANY current
	 * adapter (e.g. an adapter's matching rules changed, an integration got disabled/uninstalled)
	 * would otherwise keep contributing its stale stats to every refresh forever — unlike an
	 * outright-deleted file, clearExpiredCache() has no way to detect this "un-discovered while
	 * still readable" case. Only trust this run's discovery enough to drop such entries when it
	 * actually completed cleanly (no adapter erroring, and it found *something*) — a
	 * partial/flaky scan must never silently zero out real, still-valid cached sessions just
	 * because one adapter hiccuped.
	 *
	 * Unconfirmed entries are evicted via cacheManager.deleteCachedSessionData() (which tombstones
	 * the path so writeSharedSnapshot()'s merge — which starts from whatever is already on disk —
	 * cannot silently resurrect it on the very next save) rather than filtered out of the returned
	 * array alone — otherwise this run's own `preloaded`/stats are correct, but the *next* boot's
	 * cache-only instant paint (which reads the cache directly, before any discovery has even run)
	 * would still resurrect the same stale entry.
	 *
	 * Every raw cache key that normalizes to an unconfirmed path is evicted — swept directly from
	 * `cacheManager.cache`, not derived from `preloaded`. `preloaded` only holds files that passed
	 * the refresh cutoff and parsed successfully; a cache-seeded entry that was too old for this
	 * cutoff, or whose stat/parse failed this run, never reaches `preloaded` at all but would still
	 * be sitting in the cache — confirming it against `confirmedKeys` directly is the only way to
	 * catch those too, not just the dedup winner a same-file spelling variant happened to produce.
	 *
	 * Must bail out in sample-data mode too, same as seedPreloadQueueFromCache()/
	 * persistRefreshResult(): SessionDiscovery deliberately returns only the fixture directory's
	 * files as `sessionFiles` in that mode, so `confirmedKeys` would contain nothing but fixture
	 * paths — sweeping the whole cache against that would tombstone every real session the user
	 * actually has, not just reconcile fixture-related entries.
	 */
	private reconcilePreloadedAgainstDiscovery(preloaded: SessionFilePreload[], sessionFiles: string[]): SessionFilePreload[] {
		if (this.isSampleDataModeActive() || this.sessionDiscovery.lastDiscoveryHadError || sessionFiles.length === 0) { return preloaded; }
		const confirmedKeys = new Set(sessionFiles.map(f => _normalizePathForDedup(f)));
		for (const rawPath of Array.from(this.cacheManager.cache.keys())) {
			if (!confirmedKeys.has(_normalizePathForDedup(rawPath))) {
				this.cacheManager.deleteCachedSessionData(rawPath);
			}
		}
		return preloaded.filter(p => confirmedKeys.has(_normalizePathForDedup(p.sessionFile)));
	}

	/**
	 * Discover all session files, stat them, and load (or cache-hit) their parsed data.
	 * Returns a `SessionFilePreload[]` that both calculateDetailedStats and
	 * calculateUsageAnalysisStats can consume, eliminating a second filesystem scan.
	 */
	private async _preloadSessionFiles(
		cutoffMs: number,
		progressCallback?: (completed: number, total: number) => void,
		editorSet?: Set<string>,
		missBudget?: { remaining: number },
		isLeader: boolean = true
	): Promise<{ sessionFiles: string[]; preloaded: SessionFilePreload[] }> {
		// --- Streaming pipeline: overlap discovery with parsing ---
		// Discovery pushes file batches into a shared queue as each adapter completes.
		// Worker pool drains the queue immediately, starting parsing while discovery continues.
		const queue: string[] = [];
		let readIndex = 0;
		let discoveryDone = false;
		let totalDiscovered = 0;
		let preloaded: SessionFilePreload[] = [];
		let processed = 0;
		const CONCURRENCY = 20;
		this._deferredSessionPreloadCount = 0;

		// Event-driven wakeups: workers that find the queue empty park on the gate
		// instead of polling on a timer, avoiding pointless wake-ups while discovery runs.
		const gate = createWakeupGate();

		const analyzeStartMs = Date.now();

		// Seed the queue from the on-disk cache's known file list before discovery
		// starts (see seedPreloadQueueFromCache doc comment for why).
		const seen = new Set<string>();
		const seededCount = this.seedPreloadQueueFromCache(queue, seen, cutoffMs, editorSet);
		totalDiscovered += seededCount;

		// Discovery fills the queue via onBatch callback
		const discoveryPromise = (async () => {
			try {
				return await this.sessionDiscovery.getCopilotSessionFilesStreaming((batch) => {
					if (editorSet) {
						for (const file of batch) {
							const editor = this.detectEditorSource(file);
							if (editor && editor !== 'Unknown') { editorSet.add(editor); }
						}
					}
					// Normalize with the same key SessionDiscovery.addDedupedBatch() uses across
					// adapters (see seedPreloadQueueFromCache doc comment) so a cache-seeded path
					// that differs only in separator/case from a freshly discovered one is still
					// recognized as the same file, not queued (and counted) twice.
					const newFiles = batch.filter(f => !seen.has(_normalizePathForDedup(f)));
					if (newFiles.length === 0) { return; }
					for (const f of newFiles) { seen.add(_normalizePathForDedup(f)); }
					queue.push(...newFiles);
					totalDiscovered += newFiles.length;
					gate.signal();
				});
			} finally {
				discoveryDone = true;
				gate.signal();
			}
		})();

		// Worker: consumes from queue, parses each file
		const worker = async () => {
			while (true) {
				if (readIndex >= queue.length) {
					if (discoveryDone) { break; }
					// Park until discovery pushes more work or signals completion. The gate
					// registers the waiter synchronously in this same tick, so no batch can
					// slip in unobserved between the emptiness check and parking.
					await gate.wait();
					continue;
				}
				// Reserve this worker's queue item before awaiting anything below: the length check
				// above and this increment must run in the same synchronous tick (no `await` between
				// them), or multiple workers can pass that check against the same stale `readIndex`
				// — a final batch with fewer items than parked workers — and only the first to resume
				// after acquiring a permit claims a real file; the rest each get `queue[readIndex]`
				// past the end (`undefined`), wasting a permit and never processing anything.
				const sessionFile = queue[readIndex++];
				// Backpressure: hold a permit from a MAX_CONCURRENT_DEFERRED_PARSES-sized semaphore
				// for the whole duration of this file's processing — brief for a normal file,
				// however long it takes for one that gets deferred. Deferring doesn't cancel a slow
				// parse; it keeps running in the background, so without this a run with many slow
				// files accumulates unbounded concurrent work. Unlike racing a plain timer against
				// the old WakeupGate-based wait (which woke every parked worker on one release, and
				// left the losing side of the race registered forever — see git history), this is a
				// real reservation: acquire() hands the freed permit to exactly one waiter per
				// release(), and a timed-out acquire() removes its own registration.
				// A file already being parsed by a still-running background parse from an earlier
				// run is a pure no-op here (processPreloadQueueFileWithCrashLog() used to discover
				// this itself, after a permit was already held) — checked before acquiring so this
				// worker never blocks waiting for a permit only to find out there was nothing to do,
				// competing with genuinely slow parses for the exact capacity this semaphore exists
				// to ration. Normalized like every other cross-batch/cross-run comparison of session
				// paths (see seedPreloadQueueFromCache()'s doc comment): the same physical file can
				// be discovered under a different separator/case spelling than the one the earlier
				// run deferred it under, and a raw-string comparison would miss that, starting a
				// duplicate slow parse instead of recognizing the file as already in flight.
				if (this._deferredSessionPreloadFiles.has(_normalizePathForDedup(sessionFile))) {
					this.debugCrashLog(`deferred ${sessionFile}`);
				} else {
					let release: () => void;
					if (await this._deferredParseSemaphore.acquire(3_000)) {
						release = () => this._deferredParseSemaphore.release();
					} else {
						// The 3s timeout won: every primary permit is held by a parse that has shown no
						// sign of ever finishing (merely slow files settle well within a handful of these
						// waits). Falling back to running unreserved here would let total concurrency
						// creep past the cap by a full worker-pool's width on every such wave — the exact
						// drift the primary semaphore exists to prevent (see git history). Instead, wait
						// (uncapped) on a small, separately bounded reserve — see
						// DEFERRED_PARSE_RESERVE_PERMITS — so the worst case is a bigger but still fixed
						// ceiling, not unbounded growth.
						await this._deferredParseReserve.acquire();
						release = () => this._deferredParseReserve.release();
					}
					const wasDeferred = await this.processPreloadQueueFileWithCrashLog(sessionFile, cutoffMs, preloaded, missBudget, release);
					if (!wasDeferred) {
						release();
					}
				}
				processed++;
				if (progressCallback) { progressCallback(processed, totalDiscovered); }
				// Checkpoint cache periodically during long-running preload. Skipped in sample-data
				// mode for the same reason persistRefreshResult() never saves there — a mid-parse
				// checkpoint writes straight to the shared on-disk snapshot too, bypassing that guard.
				// Leader-only, matching persistRefreshResult()'s invariant (see
				// .github/instructions/vscode-extension.instructions.md) that only the leader writes
				// the shared snapshot during a refresh — a follower checkpointing here was writing a
				// deliberately partial (FOLLOWER_MISS_BUDGET-bounded) in-memory cache to the same
				// shared file the leader is concurrently building, on every one of its own first 25
				// files (a follower never resets lastCheckpointTime, so it always starts past the time
				// threshold).
				if (processed % 25 === 0 && isLeader && !this.isSampleDataModeActive()) {
					this.cacheManager.maybeCheckpointCache();
				}
			}
		};

		// Run discovery and workers concurrently
		const [sessionFiles] = await Promise.all([
			discoveryPromise,
			...Array.from({ length: CONCURRENCY }, () => worker()),
		]);

		preloaded = this.reconcilePreloadedAgainstDiscovery(preloaded, sessionFiles);

		// Defer expired-cache cleanup to avoid blocking discovery/workers startup. Scheduled
		// unconditionally (not only on a successful, non-empty scan) so a cached entry for a file
		// that was genuinely deleted still gets pruned even on a run where every adapter otherwise
		// returned nothing — otherwise it would keep sitting in the cache indefinitely, available
		// for a future boot's cache-only instant paint to resurrect.
		void Promise.resolve().then(() => this.cacheManager.clearExpiredCache());

		if (sessionFiles.length === 0) {
			// `sessionFiles` only reflects this run's adapter discovery — it does not include the
			// cache-seeded backlog (see seedPreloadQueueFromCache()). If adapters transiently
			// returned nothing (e.g. every adapter errored) while the cache still holds valid,
			// already-processed entries, `preloaded` can be non-empty here; returning it (instead
			// of hardcoding []) keeps those real, already-computed results instead of discarding
			// them and regressing the instant cache-only paint back to zero stats.
			if (preloaded.length === 0) {
				this.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}
			return { sessionFiles, preloaded };
		}

		this.logPreloadSessionFileSummary(sessionFiles, preloaded, analyzeStartMs);

		return { sessionFiles, preloaded };
	}

	private logPreloadSessionFileSummary(sessionFiles: string[], preloaded: SessionFilePreload[], analyzeStartMs: number): void {
		this.log(`📊 Analyzed ${sessionFiles.length} session file(s)`);
		this.log(`📦 Preloaded ${preloaded.length}/${sessionFiles.length} session file(s) within date range in ${((Date.now() - analyzeStartMs) / 1000).toFixed(1)}s`);
		if (this._deferredSessionPreloadCount > 0) {
			this.warn(`⏳ Deferred ${this._deferredSessionPreloadCount} slow session parse(s) to the background`);
		}
	}

	/**
	 * Wraps processPreloadQueueFile() with crash-safe start/done/error logging
	 * (see debugCrashLog) so a hard native crash mid-scan still leaves a trace of
	 * which file(s) were in flight. A "start" line with no matching "done"/"error"
	 * for the same file means the process died while processing it.
	 *
	 * Callers only reach this once the worker loop has already confirmed `sessionFile` isn't
	 * still being handled by an earlier run's deferred parse — see that loop's own
	 * `_deferredSessionPreloadFiles` check, made before acquiring a permit for exactly this file.
	 *
	 * `release` is the permit worker() acquired for this file (from whichever pool — the primary
	 * semaphore or the reserve, see their declarations), called exactly once total regardless of
	 * outcome: either here-and-now by the caller when this returns `false` (not deferred), or
	 * later by deferSessionPreloadRefresh() once the deferred parse itself finishes, when this
	 * returns `true` and ownership has transferred.
	 */
	private async processPreloadQueueFileWithCrashLog(sessionFile: string, cutoffMs: number, preloaded: SessionFilePreload[], missBudget: { remaining: number } | undefined, release: () => void): Promise<boolean> {
		this.debugCrashLog(`start ${sessionFile}`);
		const processing = this.processPreloadQueueFile(sessionFile, cutoffMs, preloaded, missBudget);
		const operation = `Parsing session "${sessionFile}"`;
		try {
			await _withTimeout(processing, CopilotTokenTracker.SESSION_PRELOAD_TIMEOUT_MS, operation);
			this.debugCrashLog(`done  ${sessionFile}`);
			return false;
		} catch (e) {
			if (e instanceof _TimeoutError) {
				this.debugCrashLog(`deferred ${sessionFile}`);
				this._deferredSessionPreloadCount++;
				this.deferSessionPreloadRefresh(sessionFile, processing, release);
				return true;
			}
			this.debugCrashLog(`error ${sessionFile}: ${e}`);
			return false;
		}
	}

	/**
	 * Keeps a timed-out preload alive without holding the initial statistics pass. Once every
	 * deferred parse has filled its cache entry, a single refresh incorporates those results.
	 */
	private deferSessionPreloadRefresh(sessionFile: string, processing: Promise<void>, release: () => void): void {
		// Normalized key: see the worker loop's matching _deferredSessionPreloadFiles.has() check —
		// the same physical file can be discovered under a different separator/case spelling by a
		// later run, and a raw-string key would make that lookup miss this entry.
		const deferredKey = _normalizePathForDedup(sessionFile);
		this._deferredSessionPreloadFiles.add(deferredKey);
		const settled = processing
			.then(() => this.debugCrashLog(`done(background)  ${sessionFile}`))
			.catch(error => this.debugCrashLog(`error(background) ${sessionFile}: ${error}`))
			.finally(() => {
				this._deferredSessionPreloadFiles.delete(deferredKey);
				this._deferredSessionPreloadPromises.delete(sessionFile);
				// The worker that started this file didn't release its permit because this parse
				// turned out to be deferred (see processPreloadQueueFileWithCrashLog) — release it
				// now that the background work it was held for has actually finished.
				release();
				if (this._deferredSessionPreloadFiles.size === 0) {
					this.scheduleDeferredSessionRefresh();
				}
			});
		this._deferredSessionPreloadPromises.set(sessionFile, settled);
	}

	/**
	 * Resolves once every deferred parse in flight at the moment this is called has settled — a
	 * snapshot of `_deferredSessionPreloadPromises`, not a live wait: a parse that starts fresh
	 * after this snapshot is taken is not included. clearCache() accounts for that itself by
	 * looping this call together with its in-flight-refresh wait until one full pass finds nothing
	 * left outstanding, rather than relying on a single call here to be enough — awaiting real,
	 * I/O-bound parses yields to the event loop for real time, long enough for an unrelated
	 * timer-triggered refresh to start and defer parses of its own in between. Used by clearCache()
	 * so a deferred parse from a refresh that already returned cannot call setCachedSessionData()
	 * after the clear and silently repopulate the cache it just emptied.
	 */
	private async awaitAllDeferredParses(): Promise<void> {
		if (this._deferredSessionPreloadPromises.size === 0) { return; }
		await Promise.all(this._deferredSessionPreloadPromises.values());
	}

	private scheduleDeferredSessionRefresh(): void {
		if (this._deferredSessionRefreshTimer || this._disposed) { return; }
		this._deferredSessionRefreshTimer = setTimeout(() => {
			this._deferredSessionRefreshTimer = undefined;
			if (this._disposed) { return; }
			if (this._updateTokenStatsInFlight) {
				void this._updateTokenStatsInFlight.finally(() => this.scheduleDeferredSessionRefresh());
				return;
			}
			void this.updateTokenStats(true, true);
		}, 0);
		if (typeof this._deferredSessionRefreshTimer.unref === 'function') {
			this._deferredSessionRefreshTimer.unref();
		}
	}

	private async processPreloadQueueFile(sessionFile: string, cutoffMs: number, preloaded: SessionFilePreload[], missBudget?: { remaining: number }): Promise<void> {
		const fileStats = await this.statSessionFile(sessionFile);
		const mtime = fileStats.mtime.getTime();
		const fileSize = fileStats.size;
		const forceStartupOpenCodeLoad = this._startupOpenCodeDbMisses.has(sessionFile);
		if (mtime < cutoffMs && !forceStartupOpenCodeLoad) { return; }
		const cachedData = this.getCachedSessionData(sessionFile);
		const wasCached = isFullCacheHit(cachedData, mtime, fileSize);
		if (forceStartupOpenCodeLoad && wasCached) {
			this._startupOpenCodeDbMisses.delete(sessionFile);
		}
		// Follower mode (missBudget defined): avoid the N-windows-parse-everything
		// stampede. Serve cache hits freely, but only parse a bounded number of
		// cache-miss files; skip the rest until the leader publishes a snapshot.
		if (!wasCached && missBudget && !forceStartupOpenCodeLoad) {
			if (missBudget.remaining <= 0) { return; }
			missBudget.remaining--;
		}
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		// Avoid the expensive full getSessionFileDetails parse (which calls _reconstructJsonlStateAsync
		// for delta-based .jsonl files) during the hot preloading loop. Use the detail cache when
		// already populated (e.g. warm run), or fall back to a lightweight stub built from sessionData.
		// The details panel fetches full details on demand; repository is not needed for stats.
		const details = sessionData.interactions > 0
			? ((await this.getSessionFileDetailsFromCache(sessionFile, fileStats)) ?? this.buildMinimalPreloadDetails(sessionFile, fileStats, sessionData))
			: undefined;
		preloaded.push({ sessionFile, mtime, fileSize, sessionData, wasCached, details } as SessionFilePreload);
		if (forceStartupOpenCodeLoad) {
			this._startupOpenCodeDbMisses.delete(sessionFile);
		}
		if (!wasCached) {
			// Yield after CPU-intensive cache-miss work to keep VS Code responsive
			await yieldToEventLoop();
		}
	}

	/**
	 * Build a lightweight SessionFileDetails stub from already-computed sessionData.
	 * Used during preloading to avoid re-parsing files just to extract repository info.
	 * The full parse (including repository) is deferred to the details panel on demand.
	 */
	private buildMinimalPreloadDetails(sessionFile: string, stat: import('fs').Stats, sessionData: SessionFileCache): SessionFileDetails {
		const details: SessionFileDetails = {
			file: sessionFile,
			size: stat.size,
			modified: stat.mtime.toISOString(),
			interactions: sessionData.interactions,
			tokens: sessionData.actualTokens || sessionData.tokens || 0,
			contextReferences: sessionData.usageAnalysis?.contextReferences ?? this.createEmptyContextRefs(),
			firstInteraction: sessionData.firstInteraction ?? null,
			lastInteraction: sessionData.lastInteraction ?? null,
			editorSource: this.detectEditorSource(sessionFile),
			title: sessionData.title,
			repository: sessionData.repository,
			...(sessionData.subAgentCalls ? { subAgentCalls: sessionData.subAgentCalls } : {}),
			...(sessionData.modelUsage && Object.keys(sessionData.modelUsage).length > 0 ? { modelUsage: sessionData.modelUsage } : {}),
		};
		this.enrichDetailsWithEditorInfo(sessionFile, details);
		return details;
	}

	private async _runUpdateTokenStats(silent: boolean): Promise<DetailedStats | undefined> {
		// Ensure the initial cache load from disk has completed before parsing.
		if (this._cacheLoadPromise) {
			try { await this._cacheLoadPromise; } catch { /* already logged in loadCacheFromStorage */ }
		}

		// Warm the in-memory cache from any newer snapshot another window published,
		// so most files become cache hits and parsing is skipped.
		try { await this.cacheManager.loadSharedSnapshotIfChanged(); }
		catch (err) { this.warn(`Failed to warm cache from shared snapshot: ${err}`); }

		// Elect a refresh leader. The single window in a lone-window setup always
		// wins, so its behaviour is unchanged. With multiple windows, only the leader
		// performs the heavy parse and publishes the snapshot; followers parse at most
		// a small budget of newly-changed files and reload the leader's snapshot.
		let isLeader = false;
		try { isLeader = await this.cacheManager.acquireRefreshLock(); }
		catch (err) { this.warn(`Failed to acquire refresh lock, proceeding as leader: ${err}`); isLeader = true; }
		this.startRefreshHeartbeat(isLeader);

		// Piggyback the once-daily background worktree scan on the same leader election: only
		// the window that won this refresh's leader lock may start it, and it runs detached
		// (drip-throttled, can take far longer than this refresh cycle) so it never blocks it.
		// The hourly cloud-agent and repository-PRs snapshot refreshes ride along for the same
		// reason: they are leader-only GitHub API work that must not hold up the parse, and this
		// also gives them a run at startup.
		if (isLeader) {
			void this.maybeStartBackgroundWorktreeScan();
			void this.maybeRefreshAgentSessions();
			void this.maybeRefreshRepoPrStats();
		}

		try {
			return await this._runRefreshCore(silent, isLeader);
		} catch (error) {
			this.error('Error updating token stats:', error);
			this.setStatusBarText(l10n.t('statusBar.tokenError'));
			this.statusBarItem.tooltip = l10n.t('statusBar.errorTooltip');
			// A genuine throw here (unlike publishRefreshResult() returning false for a
			// superseded run, which never reaches this catch) means no later refresh is already
			// under way to resolve a panel left waiting on this one — see showDetails()/
			// showEnvironmental()'s isRefreshSuperseded() branch, which deliberately leaves a
			// superseded run's panel registered for exactly such a replacement to publish into.
			// Without this, a panel whose refresh genuinely failed while it was in the "stay on
			// the loading screen, a replacement will handle it" state would never get one.
			this.resolveStuckLoadingPanelsAsFailed();
			return undefined;
		} finally {
			if (isLeader) {
				// Deliberately NOT stopping the heartbeat yet: it renews the refresh-lock's
				// timestamp every 30s so a legitimately long save/checkpoint here isn't mistaken for
				// an abandoned lock by handleExistingLock()'s 5-minute staleness check. Stopping it
				// before these awaits (as this used to) leaves the lock's timestamp frozen for their
				// entire duration — a slow enough snapshot write (a large cache, a slow filesystem)
				// could then let another window break the lock and start its own leader cycle while
				// this window is still mid-save, the exact stale-snapshot race this wait exists to
				// prevent in the first place.
				//
				// Await this cycle's own end-of-refresh snapshot save (if this run reached
				// persistRefreshResult()) before releasing the lock — see
				// _pendingLeaderSnapshotSave's own doc comment for why releasing first is unsafe.
				if (this._pendingLeaderSnapshotSave) {
					await this._pendingLeaderSnapshotSave;
					this._pendingLeaderSnapshotSave = undefined;
				}
				// Also await a still-running *periodic* mid-parse checkpoint (maybeCheckpointCache(),
				// fire-and-forget, holds the same cache lock persistRefreshResult()'s save needs) —
				// otherwise that checkpoint can still be serializing when the refresh-leader lock is
				// released here. A new leader elected in the gap would then lose its own save to that
				// same lock too, leaving the older, partial checkpoint as the on-disk snapshot even
				// though a full refresh (this one or the new leader's) has already completed.
				await this.cacheManager.awaitInFlightCheckpoint();
				this.stopRefreshHeartbeat();
				try { await this.cacheManager.releaseRefreshLock(); }
				catch (err) { this.warn(`Failed to release refresh lock: ${err}`); }
			} else {
				this.stopRefreshHeartbeat();
			}
		}
	}

	/**
	 * Whether this run's discovery can't be trusted to be complete, and the one-time full-year
	 * chart backfill (calculateDailyStats(365, sessionFiles)) must therefore be skipped.
	 *
	 * Two cases: the "sessionFiles came back empty but we still have real cached data" case (see
	 * reconcilePreloadedAgainstDiscovery()), or lastDiscoveryHadError — set whenever any single
	 * adapter throws, even if other adapters still returned a non-empty partial sessionFiles list.
	 * Either way, calculateDailyStats(365, sessionFiles) would compute and store a
	 * truncated/incomplete year and, since an empty *or partial* array is truthy, showChart()'s
	 * `!!this.currentFullDailyStats` / `?? this.currentDailyStats` checks would treat that as complete
	 * data and get stuck instead of falling back to the real 30-day stats or retrying on a later,
	 * successful refresh. A genuine first-ever user with zero session files (sessionFiles and the
	 * cache both empty, no discovery error) is unaffected.
	 *
	 * "We still have real cached data" is judged by the cache itself, not `preloaded` — `preloaded`
	 * only holds entries within `fileLoadCutoffMs` (~30 days), far narrower than this 365-day
	 * backfill. A dormant user with real data older than that window would have an empty `preloaded`
	 * on a transient empty-discovery run too, and still hit the exact bug this guard exists to avoid
	 * if only `preloaded` were checked.
	 */
	private isDiscoveryUntrustworthyForBackfill(sessionFiles: string[], preloaded: SessionFilePreload[]): boolean {
		return this.sessionDiscovery.lastDiscoveryHadError
			|| (sessionFiles.length === 0 && (preloaded.length > 0 || this.cacheManager.cache.size > 0));
	}

	/**
	 * Captures the generation this refresh's inputs belong to.
	 *
	 * Also republishes it as the in-flight run's generation: updateTokenStats() registered its own
	 * capture before the cache load, snapshot warm and leader election this runs after, so a clear
	 * landing in that preamble would otherwise leave a later caller declining to coalesce onto a
	 * run that is in fact going to publish current data — and paying for a second full parse.
	 */
	private beginRefreshGeneration(): number {
		this._updateTokenStatsInFlightGeneration = this._cacheGeneration;
		return this._cacheGeneration;
	}

	/**
	 * Whether a cache clear landed after this refresh gathered its inputs.
	 *
	 * The per-cache stamps make a later *read* of a superseded result recompute, but nothing in
	 * them stops the run that produced it from publishing: updateDetailsPanelIfOpen(),
	 * updateAnalysisPanelIfOpen() and updateEnvironmentalPanelIfOpen() post straight to their
	 * panels, and no second refresh is started behind them. A run that fails this publishes
	 * nothing at all — `_hasCompletedRealRefresh` included, since that flag tells the instant paint
	 * that verified data has already reached the status bar.
	 *
	 * This keys on `_cacheGeneration` itself, not on the per-cache stamps, so a *scoped*
	 * invalidation trips it too: refreshAnalysisPanel() bumps the same global counter while
	 * meaning to invalidate usage-analysis state only, and carries the daily/full-year stamps
	 * across its bump for exactly that reason. A token refresh in flight across one of those is
	 * therefore discarded even though its inputs are fine — never wrong data, but a redundant
	 * parse, since that method's own trailing updateTokenStats() then starts a fresh run.
	 * Narrowing this wants a clear-generation the emptying writers (clearCache(),
	 * runLocalViewRegression()) bump and the scoped ones do not; deliberately not built here.
	 */
	private isRefreshSuperseded(startedAtGeneration: number): boolean {
		if (isComputedStatsCurrent(startedAtGeneration, this._cacheGeneration)) { return false; }
		this.log('Refresh superseded by a cache invalidation; discarding its results');
		return true;
	}

	/**
	 * Whether a publication belonging to `originGeneration` may still reach a panel.
	 *
	 * The outer gates in publishRefreshResult() run *between* helpers, which is too late for a
	 * helper that awaits and then publishes on its way back: updateAnalysisPanelIfOpen() posts
	 * after calculateUsageAnalysisStats(), computeAndUploadFluencyScore() renders the Maturity
	 * panel after calculateMaturityScores(), and evaluateAndSurfaceInsights() posts after writing
	 * globalState. A clear landing inside any of those is already on screen by the time the caller
	 * re-checks. So each of them asks this immediately before publishing.
	 *
	 * `undefined` means the caller is not part of a generation-owned refresh (showUsageAnalysis()
	 * and friends), and is always allowed to publish.
	 */
	private mayPublishAt(originGeneration: number | undefined): boolean {
		return originGeneration === undefined || isComputedStatsCurrent(originGeneration, this._cacheGeneration);
	}

	/** Publishes a detailed-stats result, stamped with the generation its inputs were gathered in. */
	private recordDetailedStats(stats: DetailedStats, originGeneration: number): void {
		this.lastDetailedStats = stats;
		this._statsGeneration.detailed = originGeneration;
	}

	/**
	 * Publishes one refresh's verified result, abandoning the sequence as soon as a cache clear
	 * supersedes it.
	 *
	 * The generation is re-checked at every async boundary, not only on entry. Between the first
	 * check and the last step this awaits calculateUsageAnalysisStats(), calculateMaturityScores()
	 * and the insight pass — each long enough for a clearCache() to land — and everything after
	 * such a bump (the Environmental panel, the persisted snapshot) would otherwise carry pre-clear
	 * data that the clear waiting on this run is about to recompute anyway. What has already been
	 * posted when a bump lands cannot be unposted, but every cache this writes is stamped with the
	 * superseded generation, so no later read treats any of it as current.
	 *
	 * Returns false once superseded, so the caller reports the run as having published nothing.
	 */
	private async publishRefreshResult(result: RefreshPublication, startedAtGeneration: number): Promise<boolean> {
		const { detailedStats, dailyStats, preloaded, silent, isLeader } = result;
		if (this.isRefreshSuperseded(startedAtGeneration)) { return false; }
		// Set as soon as the verified result exists, before any of the (some awaited, some
		// network-bound — see computeAndUploadFluencyScore below) publication steps that follow.
		// renderInstantStatsFromCache() (if still in flight) checks this right before committing
		// its own, older cache-only results — it must never see this as false once real data has
		// already started being published, or it can overwrite an already-correct status bar.
		this._hasCompletedRealRefresh = true;
		this.lastDailyStats = dailyStats;
		this._statsGeneration.daily = startedAtGeneration;
		this.mergeIntoFullDailyStats(dailyStats, startedAtGeneration);
		// Recorded *before* the panels publish, not after. _buildAnalysisUpdateData() and the
		// initial Usage Analysis payload both read monthBillingGroupCosts through
		// currentDetailedStats, and that accessor reads empty until this stamp lands — so
		// publishing first dropped the Copilot Billing Coverage section from the very refresh
		// that was holding the figure.
		this.recordDetailedStats(detailedStats, startedAtGeneration);

		this.updateStatusBarAndTooltip(detailedStats);
		this.updateChartPanelIfOpen(silent);
		// These sub-steps report real sub-progress on the Details/Environmental loading screen —
		// including computeAndUploadFluencyScore, which runs calculateMaturityScores() and an
		// optional network upload on every non-silent refresh regardless of whether the Maturity
		// panel is even open (see that method). Both panels' real HTML/data is published right
		// after, not before: publishing Details earlier than this used to swap its loading screen
		// away before these sub-steps were even sent, so it never actually showed the progress
		// they report.
		this.sendLoadingPanelMessage({
			command: 'loadingStep', step: 'computing',
			percentage: CopilotTokenTracker.REFRESH_STEP_PCT.analysis, label: l10n.t('loading.refresh.analyzingUsage'),
		});
		await this.updateAnalysisPanelIfOpen(silent, preloaded, startedAtGeneration);
		if (this.isRefreshSuperseded(startedAtGeneration)) { return false; }
		this.sendLoadingPanelMessage({
			command: 'loadingStep', step: 'computing',
			percentage: CopilotTokenTracker.REFRESH_STEP_PCT.fluency, label: l10n.t('loading.refresh.scoringFluency'),
		});
		await this.computeAndUploadFluencyScore(silent, preloaded, startedAtGeneration);
		if (this.isRefreshSuperseded(startedAtGeneration)) { return false; }

		// Published here, before evaluateAndSurfaceInsights() rather than after: that call can
		// await an interactive insight toast (vscode.window.showInformationMessage()) that only
		// resolves once the user acts on or dismisses it — sitting behind that await would leave
		// Details/Environmental stuck on the loading screen for as long as the toast sits
		// unanswered, even though the refresh itself finished. The "finalizing insights" sub-step
		// this displaces was never going to be visible on the loading screen after this anyway.
		this.updateDetailsPanelIfOpen(detailedStats, silent);
		this.updateEnvironmentalPanelIfOpen(detailedStats, silent);

		await this.evaluateAndSurfaceInsights(startedAtGeneration);
		if (this.isRefreshSuperseded(startedAtGeneration)) { return false; }

		this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Last 30 Days: ${detailedStats.last30Days.tokens}`);
		this.persistRefreshResult(isLeader);
		this._lastPublishedRefreshGeneration = startedAtGeneration;
		return true;
	}

	/**
	 * Flushes any dirty cache state left behind by a previous leader cycle before
	 * resetCheckpointCounters() zeroes the counter that is its only record of being unpersisted.
	 *
	 * A leader cycle that throws (see _runUpdateTokenStats's catch) never reaches
	 * persistRefreshResult() — its only other chance to checkpoint is the periodic every-25-files
	 * call in _preloadSessionFiles(), so up to 24 parsed-but-uncheckpointed files can be left
	 * dirty when it fails. Without this, the next cycle's unconditional resetCheckpointCounters()
	 * zeroed that dirty count while the underlying entries were still only in memory: a
	 * cache-hit-only next cycle (nothing new to re-dirty the counter) would then never checkpoint
	 * them again, so a crash before some unrelated future write finally does would lose parses
	 * that had, in fact, already succeeded.
	 *
	 * Only resets once nothing is left dirty. If the flush itself is skipped or fails (e.g. another
	 * window holds the cache lock), the counters are left untouched rather than reset — this cycle's
	 * own threshold-based checkpointing then still owns that debt instead of it being silently
	 * forgotten.
	 */
	private async flushPendingCheckpointBeforeReset(): Promise<void> {
		await this.cacheManager.awaitInFlightCheckpoint();
		if (this.cacheManager.hasUnflushedCheckpointWork()) {
			await this.cacheManager.forceCheckpointCache();
		}
		if (this.cacheManager.hasUnflushedCheckpointWork()) {
			this.log('Pending cache checkpoint from a previous cycle could not be flushed; leaving checkpoint counters intact so this cycle retries it');
			return;
		}
		this.cacheManager.resetCheckpointCounters();
	}

	/** Core discover → parse → compute → render → persist pass for one refresh. */
	private async _runRefreshCore(silent: boolean, isLeader: boolean): Promise<DetailedStats | undefined> {
		this.log(isLeader ? 'Updating token stats (leader)...' : 'Updating token stats (follower)...');
		// Covers the whole cycle below (discovery + preload/parse + stats), not just discovery —
		// see the completion log near this method's return.
		const refreshStartMs = Date.now();
		// Captured before the preload: this run's output belongs to the generation its inputs were
		// gathered in, not the one each later calculation starts in (see calculateUsageAnalysisStats).
		const startedAtGeneration = this.beginRefreshGeneration();

		// Reset checkpoint counters at the start of each refresh cycle — but only once any
		// unpersisted work from a previous cycle (e.g. one that threw before persistRefreshResult()
		// ever ran) has actually reached disk. See flushPendingCheckpointBeforeReset().
		if (isLeader) {
			await this.flushPendingCheckpointBeforeReset();
		}

		const { last30DaysStartMs, lastMonthStartMs } = computeUtcDateRanges(new Date());
		const fileLoadCutoffMs = Math.min(last30DaysStartMs, lastMonthStartMs);

		this._loadingEditors = [];
		this.sendLoadingPanelMessage({ command: 'loadingStep', step: 'discovering' });
		this.showLoadingTooltipForStep('discovering', silent);

		// Streaming pipeline: discovery and parsing run concurrently.
		// Workers start processing files as each adapter batch arrives.
		const discoveredEditorSet = new Set<string>();
		const progressCallback = this.buildProgressCallback(silent, () =>
			[...discoveredEditorSet].map(name => ({ icon: this.getEditorIconForLoader(name), name }))
		);
		const missBudget = isLeader ? undefined : { remaining: CopilotTokenTracker.FOLLOWER_MISS_BUDGET };
		const { sessionFiles, preloaded } = await this._preloadSessionFiles(fileLoadCutoffMs, progressCallback, discoveredEditorSet, missBudget, isLeader);
		if (!isLeader && preloaded.length < sessionFiles.length) {
			this.log(`Follower with cold cache: stats below are partial (${preloaded.length}/${sessionFiles.length} files within date range parsed within the follower budget). Will resync once the leader publishes its snapshot.`);
		}
		try {
			await this.storeDiscoveredEditorsAndNotify(discoveredEditorSet);
		} catch (error) {
			this.warn(`Failed to update seen-editor state: ${error}`);
		}

		this.sendLoadingPanelMessage({
			command: 'loadingStep', step: 'computing',
			percentage: CopilotTokenTracker.REFRESH_STEP_PCT.stats, label: l10n.t('loading.refresh.calculatingStats'),
		});
		this.showLoadingTooltipForStep('computing', silent);

		const { stats: detailedStats, dailyStats } = await this.calculateDetailedStats(undefined, preloaded);
		const published = await this.publishRefreshResult(
			{ detailedStats, dailyStats, preloaded, silent, isLeader }, startedAtGeneration,
		);
		if (!published) { return undefined; }

		const refreshElapsedSec = ((Date.now() - refreshStartMs) / 1000).toFixed(1);
		this.log(`⏱️ Full refresh (${isLeader ? 'leader' : 'follower'}) completed in ${refreshElapsedSec}s: ${sessionFiles.length} session file(s) discovered, ${preloaded.length} loaded`);

		// Skip the one-time full-year backfill when this run's discovery can't be trusted to be
		// complete — see isDiscoveryUntrustworthyForBackfill() for why. Leader-only: unlike the
		// regular refresh above, calculateDailyStats() has no missBudget/follower awareness at all —
		// it reparses every discovered session file unconditionally. Running it on every follower
		// window's first refresh would launch a full, unbounded reparse in parallel with the leader's
		// own preload, defeating FOLLOWER_MISS_BUDGET's stampede protection and the very cold-boot
		// cost this PR exists to cut. A follower that skips this still renders correctly: every
		// lastFullDailyStats read elsewhere already falls back to lastDailyStats or computes its own
		// full-year data lazily on demand (e.g. when Chart is opened).
		if (isLeader && !this.currentFullDailyStats && !this.chartPanel && !this.isDiscoveryUntrustworthyForBackfill(sessionFiles, preloaded)) {
			// Tracked (not just detached) so clearCache() can wait it out — see
			// _pendingFullYearBackfills' own doc comment.
			this.trackFullYearBackfill(this.calculateDailyStats(365, sessionFiles));
		}

		return detailedStats;
	}

	/**
	 * Persist results after a refresh. Only the leader publishes the shared
	 * snapshot (so a follower's partial cache can never regress it); a follower
	 * instead schedules a bounded resync to pick up the leader's snapshot.
	 *
	 * Never persists during sample-data mode (runLocalViewRegression(), the visual-view-diff
	 * harness): that refresh's cache entries are fixture data, parsed under the SAME 'dev' cache
	 * identity a real debug session uses (getCacheIdentifier() doesn't distinguish sample runs).
	 * Saving them to the shared on-disk snapshot would let them survive past
	 * localRegressionSampleDataDir being restored to '' — the cache-only instant paint and
	 * cache-seeded preload queue (see isSampleDataModeActive()'s doc comment) read that same
	 * snapshot directly on the *next* normal boot and would then display fixture data as real
	 * stats. The regression tool only needs its results in memory (lastDetailedStats etc.) for
	 * that one verification pass, never on disk.
	 */
	private persistRefreshResult(isLeader: boolean): void {
		if (isLeader) {
			if (this.isSampleDataModeActive()) { return; }
			// Tracked (not just detached) so _runUpdateTokenStats()'s finally can await it before
			// releasing the refresh-leader lock — see _pendingLeaderSnapshotSave's own doc comment.
			//
			// The `false` a lock-contended or failed save resolves with is deliberately not handled
			// here (no retry, no explicit branch): saveAndAccountForRefresh() already leaves the
			// dirty count intact on that outcome (see its own doc comment), and
			// flushPendingCheckpointBeforeReset() — run at the start of every subsequent leader
			// cycle, before that cycle resets those same counters — forces a checkpoint for exactly
			// that leftover debt. A skipped save here is retried within one refresh cycle, never
			// silently dropped.
			this._pendingLeaderSnapshotSave = (async () => {
				try { await this.cacheManager.saveAndAccountForRefresh(); }
				catch (err) { this.warn(`Failed to save cache: ${err}`); }
			})();
		} else {
			this.scheduleFollowerResync();
		}
	}

	/**
	 * Start (leader) or clear (follower) the periodic heartbeat that renews the
	 * refresh leader lock so a legitimately long parse is not treated as stale by
	 * another window.
	 */
	private startRefreshHeartbeat(isLeader: boolean): void {
		this.stopRefreshHeartbeat();
		if (!isLeader) { return; }
		this._refreshHeartbeat = setInterval(() => {
			void this.cacheManager.renewRefreshLock();
		}, 30 * 1000);
	}

	private stopRefreshHeartbeat(): void {
		if (this._refreshHeartbeat) {
			clearInterval(this._refreshHeartbeat);
			this._refreshHeartbeat = undefined;
		}
	}

	/**
	 * Bounded retry chain for a follower window that started before a snapshot
	 * existed. Periodically reloads the shared snapshot; once the leader publishes
	 * fresher data, triggers a single recompute and stops. Capped to avoid looping.
	 */
	private scheduleFollowerResync(retriesLeft: number = CopilotTokenTracker.FOLLOWER_RESYNC_MAX_RETRIES): void {
		if (this._followerResyncTimer) { return; }
		if (retriesLeft <= 0) { return; }
		this._followerResyncTimer = setTimeout(() => {
			this._followerResyncTimer = undefined;
			void (async () => {
				let merged = 0;
				try { merged = await this.cacheManager.loadSharedSnapshotIfChanged(); }
				catch { /* best-effort */ }
				if (merged > 0) {
					// Leader published fresher data — recompute once with the warm cache.
					void this.updateTokenStats(true, true);
					return;
				}
				this.scheduleFollowerResync(retriesLeft - 1);
			})();
		}, CopilotTokenTracker.FOLLOWER_RESYNC_DELAY_MS);
		if (typeof this._followerResyncTimer.unref === 'function') { this._followerResyncTimer.unref(); }
	}

	private buildProgressCallback(
		silent: boolean,
		getEditors?: () => { icon: string; name: string }[],
		send: (msg: object) => void = (msg) => this.sendLoadingPanelMessage(msg),
	): (completed: number, total: number) => void {
		// Always build a callback regardless of `silent` so that a silent background
		// refresh that coalesces with an open loading panel still sends progress
		// messages to it.  Status-bar updates remain gated on !silent; loading-panel
		// messages are gated inside sendLoadingPanelMessage (checks
		// _detailsPanelIsLoading), so they are only delivered when the panel is
		// actually visible.
		let parsingStepNotified = false;
		let lastProgressSentMs = 0;
		let lastPercentage = -1;
		return (completed: number, total: number) => {
			const percentage = Math.round((completed / total) * 100);
			if (!silent) {
				// Only touch the status bar text when the rounded percentage actually
				// changes, to avoid needless status-bar relayout on every callback.
				if (percentage !== lastPercentage) {
					lastPercentage = percentage;
					this.setStatusBarText(l10n.t('statusBar.analyzingLogs', percentage.toString()));
				}
			}
			if (!parsingStepNotified) {
				parsingStepNotified = true;
				const editors = getEditors?.() ?? [];
				this._loadingEditors = editors;
				const msg: Record<string, unknown> = { command: 'loadingStep', step: 'parsing', total, editors };
				send(msg);
				if (!silent) {
					// Set the hover tooltip exactly once when parsing starts, using the
					// indeterminate (self-animating SMIL) variant. The tooltip is never
					// reassigned during parsing, so the hover popup no longer flickers on
					// every progress redraw — the previous per-500ms reassignment forced
					// VS Code to rebuild the hover and reload the data-URI <img>. The live
					// climbing percentage stays visible in the status bar text instead.
					// Skip entirely when the loading panel is already open — it shows progress itself.
					if (!this._detailsPanelIsLoading) {
						if (!silent) { this.statusBarItem.tooltip = this.buildLoadingTooltipMarkdown('parsing'); }
					}
				}
			}
			// The hover popup intentionally stays put during parsing; only the live
			// webview panel (if open) receives incremental progress updates.
			const now = Date.now();
			if (now - lastProgressSentMs >= 500 || completed === total) {
				lastProgressSentMs = now;
				const editors = getEditors?.() ?? [];
				send({ command: 'loadingProgress', completed, total, percentage, editors });
			}
		};
	}

	/** Maps known editor display names to emoji icons for the loader animation. */
	private getEditorIconForLoader(editorName: string): string {
		return getEditorIconByName(editorName);
	}

	/**
	 * Splices a just-computed 30-day window into the cached full year.
	 *
	 * `originGeneration` is the generation the incoming rows' inputs were gathered in, and the
	 * merge is refused when it is stale — see mergeDailyStatsIntoFullYear() for why guarding the
	 * destination alone lets pre-clear rows into a current-stamped array.
	 */
	private mergeIntoFullDailyStats(dailyStats: DailyTokenStats[], originGeneration: number): void {
		const merged = mergeDailyStatsIntoFullYear(
			this.currentFullDailyStats, dailyStats, originGeneration, this._cacheGeneration,
		);
		if (merged) { this.setFullDailyStats(merged); }
	}

	/**
	 * Replaces the cached full daily stats, retiring the Efficiency view's
	 * session sample with them.
	 *
	 * The two are charted side by side — daily aggregates supply the volume
	 * series, the session sample the duration/retry/apply/skill series — so a
	 * refresh that renewed only one would hand the webview a payload whose two
	 * halves describe different moments. Assigning through one setter keeps that
	 * impossible rather than merely remembered.
	 */
	private setFullDailyStats(stats: DailyTokenStats[]): void {
		this.lastFullDailyStats = stats;
		this.lastEfficiencySessionInputs = undefined;
	}

	private updateStatusBarAndTooltip(detailedStats: DetailedStats): void {
		this._lastDetailedStats = detailedStats;
		if (detailedStats.today.sessions === 0 && detailedStats.last30Days.sessions === 0) {
			this.setStatusBarText(l10n.t('statusBar.noSessionData'));
		} else {
			this.setStatusBarText(this.buildStatusBarText(detailedStats));
		}
		this.statusBarItem.tooltip = this.buildTooltipMarkdown(detailedStats);
		this.updateStatusBarBackgroundColor(detailedStats);
	}

	/**
	 * Shows the loading tooltip for `step`, unless this is a silent refresh or the Details panel is
	 * already showing its own loading screen (which owns the tooltip while it is up).
	 */
	private showLoadingTooltipForStep(step: 'discovering' | 'computing', silent: boolean): void {
		if (!silent && !this._detailsPanelIsLoading) { this.statusBarItem.tooltip = this.buildLoadingTooltipMarkdown(step); }
	}

	private buildLoadingTooltipMarkdown(step: 'discovering' | 'parsing' | 'computing', percentage?: number): vscode.MarkdownString {
		const svg = this.generateLoadingSvg(step, this._loadingEditors, percentage, this._prevLoadingPercentage);
		this._prevLoadingPercentage = percentage ?? this._prevLoadingPercentage;
		const tooltip = new vscode.MarkdownString(`![Loading](data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)})`);
		tooltip.isTrusted = true;
		tooltip.supportThemeIcons = false;
		return tooltip;
	}

	// eslint-disable-next-line max-lines-per-function, complexity, sonarjs/cognitive-complexity
	private generateLoadingSvg(
		step: 'discovering' | 'parsing' | 'computing',
		editors: { icon: string; name: string }[],
		percentage?: number,
		prevPercentage?: number
	): string {
		const W = 440, P = 12;
		const CARD  = '#24273a', FG  = '#cdd6f4';
		const MUT  = '#9399b2', ACC   = '#89b4fa', OK  = '#a6e3a1';
		const BRD  = '#313244';
		const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
		const esc  = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

		const doneUntil  = step === 'discovering' ? 0 : step === 'parsing' ? 1 : 2;
		const activeStep = step === 'discovering' ? 0 : step === 'parsing' ? 1 : 2;
		const STEPS = [
			'Discovering session files',
			'Parsing session logs', 'Computing statistics', 'Ready!',
		];
		const pct     = step === 'computing' ? 96 : (percentage ?? 0);
		const pctTxt  = step === 'computing' ? '96%' : (percentage !== undefined && percentage > 0 ? `${percentage}%` : '–');
		const subtitle =
			step === 'discovering' ? 'Discovering session files...' :
			step === 'parsing'     ? 'Parsing session files...'     :
			                         'Computing statistics...';
		const pills   = editors.slice(0, 6);

		// Layout — always reserve pills row so height never changes between phases
		const BY    = P + 13;
		const TY    = BY + 20;
		const SBY   = TY + 16;
		const PRY   = SBY + 16;
		const PRH   = 5;
		const PIL_Y = PRY + PRH + 8;
		const SBX_Y = PIL_Y + 34;  // 28px pills height + 6px gap, always reserved
		const SBX_H = P + STEPS.length * 22 + 8;
		const H     = SBX_Y + SBX_H + P;
		const PW    = W - P * 2;

		const o: string[] = [];
		o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
		o.push(`<defs>
  <linearGradient id="pg" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="${ACC}"/>
    <stop offset="100%" stop-color="${OK}"/>
  </linearGradient>
  <clipPath id="pclip"><rect x="${P}" y="${PRY}" width="${PW}" height="${PRH}" rx="2.5"/></clipPath>
</defs>`);

		// Badge
		o.push(`<text x="${P}" y="${BY}" font-family="${FONT}" font-size="10" font-weight="700" letter-spacing="1.5" fill="${ACC}">🤖 ANALYZING YOUR AI ACTIVITY</text>`);

		// Title + large pct display
		o.push(`<text x="${P}" y="${TY}" font-family="${FONT}" font-size="17" font-weight="700" fill="${FG}">Building Activity Index</text>`);
		o.push(`<text x="${W - P}" y="${TY}" text-anchor="end" font-family="${FONT}" font-size="26" font-weight="800" fill="${FG}">${esc(pctTxt)}</text>`);

		// Subtitle
		o.push(`<text x="${P}" y="${SBY}" font-family="${FONT}" font-size="11" fill="${MUT}">${esc(subtitle)}</text>`);

		// Progress track
		o.push(`<rect x="${P}" y="${PRY}" width="${PW}" height="${PRH}" rx="2.5" fill="${BRD}"/>`);

		// Progress fill — shimmer (indeterminate) during discovering/early parsing, animated fill when progress is known
		if (step !== 'computing' && pct === 0) {
			const sw = Math.round(PW * 0.25);
			o.push(`<rect y="${PRY}" width="${sw}" height="${PRH}" rx="2.5" fill="url(#pg)" clip-path="url(#pclip)">
  <animate attributeName="x" from="${P - Math.round(PW * 0.35)}" to="${P + Math.round(PW * 1.1)}" dur="1.8s" repeatCount="indefinite" calcMode="ease-in-out"/>
</rect>`);
		} else {
			const fw = Math.max(8, Math.round((pct / 100) * PW));
			const prevFw = Math.max(8, Math.round(((prevPercentage ?? 0) / 100) * PW));
			if (prevFw < fw) {
				// Animate from previous width to current width so the bar grows smoothly
				o.push(`<rect x="${P}" y="${PRY}" height="${PRH}" rx="2.5" fill="url(#pg)" width="${prevFw}">
  <animate attributeName="width" from="${prevFw}" to="${fw}" dur="0.5s" fill="freeze" calcMode="spline" keySplines="0.25 0.46 0.45 0.94" keyTimes="0;1"/>
</rect>`);
			} else {
				o.push(`<rect x="${P}" y="${PRY}" width="${fw}" height="${PRH}" rx="2.5" fill="url(#pg)"/>`);
			}
		}

		// Editor pills
		if (pills.length > 0) {
			let px = P;
			for (const ed of pills) {
				const rawLbl = `${ed.icon} ${ed.name}`;
				const pw2    = Math.min(Math.max([...rawLbl].length * 7 + 16, 64), 130);
				if (px + pw2 > W - P) { break; }
				o.push(`<rect x="${px}" y="${PIL_Y}" width="${pw2}" height="22" rx="11" fill="${CARD}" stroke="${BRD}"/>`);
				o.push(`<text x="${px + pw2 / 2}" y="${PIL_Y + 15}" text-anchor="middle" font-family="${FONT}" font-size="10.5" fill="${FG}">${esc(rawLbl)}</text>`);
				px += Math.round(pw2) + 6;
			}
		}

		// Steps box
		o.push(`<rect x="${P}" y="${SBX_Y}" width="${PW}" height="${SBX_H}" rx="8" fill="${CARD}" stroke="${BRD}"/>`);

		const ICX = P + P + 4;
		const LBX = ICX + 18;
		let sy = SBX_Y + P + 8;
		for (let i = 0; i < STEPS.length; i++) {
			const done   = i < doneUntil;
			const active = i === activeStep;
			const col    = done ? OK : active ? ACC : MUT;
			const wt     = active ? '600' : '400';
			const lbl    = STEPS[i];

			if (done) {
				o.push(`<text x="${ICX}" y="${sy}" text-anchor="middle" font-family="monospace" font-size="13" fill="${OK}">✓</text>`);
			} else if (active) {
				// Spinning ↻ via SMIL animateTransform around the glyph centre
				const cy = sy - 4;
				o.push(`<text x="${ICX}" y="${sy}" text-anchor="middle" font-family="monospace" font-size="13" fill="${ACC}">↻<animateTransform attributeName="transform" type="rotate" values="0 ${ICX} ${cy};360 ${ICX} ${cy}" dur="0.75s" repeatCount="indefinite" additive="sum"/></text>`);
			} else {
				o.push(`<text x="${ICX}" y="${sy}" text-anchor="middle" font-size="13" fill="${MUT}">○</text>`);
			}
			o.push(`<text x="${LBX}" y="${sy}" font-family="${FONT}" font-size="12" font-weight="${wt}" fill="${col}">${esc(lbl)}</text>`);
			sy += 22;
		}

		o.push('</svg>');
		return o.join('');
	}

	private buildTooltipMarkdown(detailedStats: DetailedStats): vscode.MarkdownString {
		const tooltip = new vscode.MarkdownString();
		tooltip.isTrusted = true;
		tooltip.supportThemeIcons = false;
		tooltip.appendMarkdown(`#### ${l10n.t('tooltip.title')}`);
		tooltip.appendMarkdown('\n---\n');
		tooltip.appendMarkdown(formatTooltipStatsTable(detailedStats, (costs) => this.sumBillingGroupCosts(costs)));
		tooltip.appendMarkdown('\n---\n');
		this.appendProviderCostSection(tooltip, detailedStats);
		// A lone account's row is redundant only when the gauge both renders (local cost groups and a budget)
		// and reflects that account's quota. A user-configured monthly budget overrides the quota, so the
		// gauge then shows the setting rather than the account.
		const gaugeShown = Object.keys(detailedStats.month.billingGroupCosts ?? {}).length > 0
			&& this.getEffectiveMonthlyBudget() > 0
			&& this.getMonthlyBudgetSetting() <= 0;
		const accountLines = formatAccountBudgetLines(this._accountBudgets, {
			usedLeft: (used, budget, pct) => l10n.t('accountBudgets.usedLeft', used, budget, pct),
			noQuota: l10n.t('accountBudgets.noQuota'),
			unavailable: l10n.t('accountBudgets.unavailable'),
			noSession: l10n.t('accountBudgets.noSession'),
			lookupFailed: (detail) => l10n.t('accountBudgets.lookupFailed', detail),
		}, gaugeShown);
		if (accountLines.length > 0) {
			tooltip.appendMarkdown(`\n---\n**${l10n.t('accountBudgets.title')}**\n\n${accountLines.join('\n')}\n`);
		}
		return tooltip;
	}

	/** Sums per-provider costs into a total-across-all-providers figure. */
	private sumBillingGroupCosts(billingGroupCosts: Record<string, number> | undefined): number {
		return defaultSumBillingGroupCosts(billingGroupCosts);
	}

	/** Builds and appends the cost sections: a GitHub Copilot budget gauge on top (spend vs.
	 *  budget, health-colored), then a spend breakdown where every provider's bar is its share
	 *  of total monthly spend (so those bars sum to 100%). */
	private appendProviderCostSection(tooltip: vscode.MarkdownString, detailedStats: DetailedStats): void {
		const monthCosts = detailedStats.month.billingGroupCosts ?? {};
		if (Object.keys(monthCosts).length === 0) { return; }
		const { budget, source } = this.getEffectiveMonthlyBudgetWithSource();
		tooltip.appendMarkdown(formatProviderCostTable(
			monthCosts,
			this.sumBillingGroupCosts(monthCosts),
			budget > 0 ? this.buildCopilotBudgetGauge(monthCosts['GitHub Copilot'] ?? 0, budget, source) : null,
			(ratio) => `![](data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.buildBarSvg(ratio, '#5B9BD5'))})`,
		));
	}

	/** Builds the "🎯 Copilot Budget" gauge row's parts (the rendered pieces that need live state,
	 *  so formatProviderCostTable() itself stays pure and testable). The API balance (when
	 *  available) reports usage across all channels — other
	 *  PCs/VDIs, WSL, web chat, cloud agent, review agent — not just this device's local
	 *  session logs. The gap between that total and our local copilotCost is usage we can't
	 *  attribute to a tracked session, so it gets its own hatched bar segment instead of
	 *  silently inflating (or understating) the "tracked" portion. */
	private buildCopilotBudgetGauge(copilotCost: number, budget: number, source: string): CopilotBudgetGauge {
		const apiBalance = this._buildCopilotApiBalance();
		const apiUsedUsd = apiBalance ? aiuToUsd(apiBalance.usedAiCredits) : null;
		const { totalUsed, remaining, trackedRatio, gapRatio, gapUsd } = computeCopilotBudgetDisplay(copilotCost, budget, apiUsedUsd);
		const totalRatio = trackedRatio + gapRatio;
		const color = totalRatio >= 0.9 ? '#EF5350' : totalRatio >= 0.75 ? '#FFA726' : '#4CAF50';
		return {
			// The headline figure is total spend (tracked + untracked) against budget, so it
			// agrees with the bar's percentage. Remaining budget is deliberately not part of it:
			// in a hover popup this narrow, "$X / $Y · $Z left" wraps onto a second line, and
			// the figure is already implied by the "$X / $Y" pair. It is a sub-row instead —
			// see buildCopilotBudgetSubRowLabels().
			usedOfBudget: `$${totalUsed.toFixed(2)} / $${budget.toFixed(2)}`,
			barCell: `![](data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.buildTwoSegmentBarSvg(trackedRatio, gapRatio, color))})`,
			subRowLabels: buildCopilotBudgetSubRowLabels(copilotCost, remaining, gapUsd),
			source,
		};
	}

	/** Generates a small SVG progress bar with two fill segments sharing one color: a solid
	 *  segment for locally-tracked usage, and a diagonally-hatched segment for usage the
	 *  Copilot API reports but this device has no local session data for (other devices,
	 *  WSL, web chat, cloud agent, review agent). Ratios are 0–1 fractions of the bar width;
	 *  the remainder is left as unfilled track. */
	private buildTwoSegmentBarSvg(trackedRatio: number, gapRatio: number, fillColor: string): string {
		const W = 130, H = 12, R = 4;
		const clampedTracked = Math.max(0, Math.min(1, trackedRatio));
		const clampedGap = Math.max(0, Math.min(1 - clampedTracked, gapRatio));
		const trackedW = Math.round(clampedTracked * W);
		const gapW = Math.round(clampedGap * W);
		const pctLabel = `${Math.round((clampedTracked + clampedGap) * 100)}%`;
		const segments = gapW > 0
			? `<rect x="0" y="1" width="${trackedW}" height="${H - 2}" fill="${fillColor}"/><rect x="${trackedW}" y="1" width="${gapW}" height="${H - 2}" fill="url(#gapHatch)"/>`
			: `<rect x="0" y="1" width="${trackedW}" height="${H - 2}" fill="${fillColor}"/>`;
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 36}" height="${H}"><defs><pattern id="gapHatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${fillColor}"/><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-opacity="0.35" stroke-width="2"/></pattern><clipPath id="barClip"><rect x="0" y="1" width="${W}" height="${H - 2}" rx="${R}"/></clipPath></defs><rect x="0" y="1" width="${W}" height="${H - 2}" rx="${R}" fill="#444"/><g clip-path="url(#barClip)">${segments}</g><text x="${W + 4}" y="${H - 1}" font-family="sans-serif" font-size="9" fill="#ccc">${pctLabel}</text></svg>`;
	}

	/** Generates a small SVG progress bar with the given fill ratio (0–1) and color. */
	private buildBarSvg(ratio: number, fillColor: string): string {
		const W = 130, H = 12, R = 4;
		const clampedRatio = Math.min(1, Math.max(0, ratio));
		const fillW = Math.max(R * 2, Math.round(clampedRatio * W));
		const pctLabel = `${Math.round(ratio * 100)}%`;
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 36}" height="${H}"><rect x="0" y="1" width="${W}" height="${H - 2}" rx="${R}" fill="#444"/><rect x="0" y="1" width="${fillW}" height="${H - 2}" rx="${R}" fill="${fillColor}"/><text x="${W + 4}" y="${H - 1}" font-family="sans-serif" font-size="9" fill="#ccc">${pctLabel}</text></svg>`;
	}

	private updateDetailsPanelIfOpen(detailedStats: DetailedStats, silent: boolean): void {
		if (!this.detailsPanel) { return; }
		if (silent) {
			void this.detailsPanel.webview.postMessage({
				command: 'updateStats',
				data: {
					today: detailedStats.today, month: detailedStats.month,
					lastMonth: detailedStats.lastMonth, last30Days: detailedStats.last30Days,
					lastUpdated: detailedStats.lastUpdated.toISOString(),
					backendConfigured: this.isBackendConfigured(), compactNumbers: this.getCompactNumbersSetting(),
				},
			});
		} else {
			// Whichever refresh reaches here first owns clearing this panel's loading-tracking
			// state, not only the one showDetails() itself awaited: a run that gets superseded by
			// a cache clear deliberately leaves the panel registered as loading (see
			// isRefreshSuperseded() call sites in showDetails()) so it keeps receiving progress
			// from whatever run replaces it — that replacement's own publish, right here, is what
			// finally clears it. Without this, a superseded run leaves _detailsPanelIsLoading
			// stuck true (suppressing the normal status-bar tooltip) and the panel stuck in
			// _refreshLoadingPanels (a future loadingStep broadcast would hit its real content).
			this._refreshLoadingPanels.delete(this.detailsPanel);
			this._detailsPanelIsLoading = false;
			try {
				this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, detailedStats);
			} catch (err) {
				this.error('❌ Failed to render Details panel after refresh', err);
				// Already out of _refreshLoadingPanels above — without this fallback a render
				// exception here would leave the panel frozen on the loading screen with no
				// further messages and no way to retry (see loadDetailsIntoPanel()'s own catch).
				this.detailsPanel.webview.html = this.getRefreshFailedHtml(this.detailsPanel.webview);
			}
		}
	}

	private updateChartPanelIfOpen(silent: boolean): void {
		if (!this.chartPanel || (!this.currentFullDailyStats && !this.currentDailyStats)) { return; }
		const chartStats = this.currentFullDailyStats ?? this.currentDailyStats!;
		if (silent) {
			void this.chartPanel.webview.postMessage({ command: 'updateChartData', data: { ...this.buildChartData(chartStats), compactNumbers: this.getCompactNumbersSetting(), monthlyBudget: this.getEffectiveMonthlyBudget() } });
		} else {
			this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, chartStats);
		}
	}

	private async updateAnalysisPanelIfOpen(silent: boolean, preloaded?: SessionFilePreload[], originGeneration?: number): Promise<void> {
		if (!this.analysisPanel) { return; }
		const analysisStats = await this.calculateUsageAnalysisStats(false, preloaded, originGeneration);
		if (!this.mayPublishAt(originGeneration)) { return; }
		if (silent) {
			// Reuse the same payload builder as the full-refresh paths (_buildAnalysisUpdateData)
			// so every field the webview renders (correctionReport, repeatedTasks, curationAnalysis, …)
			// stays populated on periodic silent refreshes instead of being dropped and blanking
			// tabs that were already showing data (see the Corrections tab going empty while the
			// insight card still reports accurate counts).
			void this.analysisPanel.webview.postMessage({
				command: 'updateStats',
				data: this._buildAnalysisUpdateData(analysisStats),
			});
		} else {
			this.analysisWebviewReady = false;
			this.analysisMessageReplay.markNotReady();
			this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);
		}
	}

	private async computeAndUploadFluencyScore(silent: boolean, preloaded?: SessionFilePreload[], originGeneration?: number): Promise<void> {
		const freshMaturityData = (!silent || this.maturityPanel)
			? await this.calculateMaturityScores(false, preloaded, originGeneration)
			: undefined;
		if (!this.mayPublishAt(originGeneration)) { return; }
		if (this.maturityPanel && !silent && freshMaturityData) {
			this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, freshMaturityData);
		}
		if (!this.backend) { return; }
		const settings = this.backend.getSettings();
		// Skip the score computation when the service would refuse the upload anyway.
		if (!settings.sharingServerEnabled || !settings.sharingServerEndpointUrl || settings.sharingProfile === 'off') { return; }
		const maturityData = await (freshMaturityData ?? this.calculateMaturityScores(false));
		const scorePayload: Record<string, unknown> = {
			overallStage: maturityData.overallStage, overallLabel: maturityData.overallLabel,
			categories: maturityData.categories.map((c: any) => ({
				category: c.category, icon: c.icon, stage: c.stage, tips: c.tips,
			})),
			computedAt: new Date().toISOString(),
		};
		// Gated on the way in, not ordered on the way out: this upload is detached, so two of them
		// can still land out of order and leave the server holding the older score. Making that
		// safe needs the server to reject an older version, which is not this PR's to change.
		if (!this.mayPublishAt(originGeneration)) { return; }
		void (async () => {
			try { await this.backend!.uploadFluencyScoreToSharingServer(settings, scorePayload); }
			catch (err: unknown) { this.warn(`Failed to upload fluency score to sharing server: ${err}`); }
		})();
	}

	private updateEnvironmentalPanelIfOpen(detailedStats: DetailedStats, silent: boolean): void {
		if (!this.environmentalPanel) { return; }
		if (silent) {
			void this.environmentalPanel.webview.postMessage({
				command: 'updateStats',
				data: {
					today: detailedStats.today, month: detailedStats.month,
					lastMonth: detailedStats.lastMonth, last30Days: detailedStats.last30Days,
					lastUpdated: detailedStats.lastUpdated.toISOString(),
					backendConfigured: this.isBackendConfigured(), compactNumbers: this.getCompactNumbersSetting(),
				},
			});
		} else {
			// See the matching comment in updateDetailsPanelIfOpen(): whichever refresh reaches
			// here first clears this panel's loading-tracking state, since a superseded run
			// deliberately leaves it registered for the replacement run to publish into.
			this._refreshLoadingPanels.delete(this.environmentalPanel);
			try {
				this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, detailedStats);
			} catch (err) {
				this.error('❌ Failed to render Environmental panel after refresh', err);
				// Same rationale as updateDetailsPanelIfOpen()'s catch: already out of
				// _refreshLoadingPanels above, so a render exception here needs its own fallback
				// or the panel is left frozen on the loading screen with no way to retry.
				this.environmentalPanel.webview.html = this.getRefreshFailedHtml(this.environmentalPanel.webview);
			}
		}
	}

	private async evaluateAndSurfaceInsights(originGeneration?: number): Promise<void> {
		const stats = this.currentUsageAnalysisStats;
		if (!stats) { return; }

		const insightsEnabled = vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('insights.enabled', true);
		if (!insightsEnabled) { return; }

		const cadenceDays = vscode.workspace.getConfiguration('aiEngineeringFluency').get<number>('insights.cadenceDays', 2);
		const now = new Date().toISOString();

		const ctx = {
			// insightsEngine.ts stays VS Code-free, so it cannot reach l10n's t()
			// itself — the host injects it (issue #2081).
			translate: l10nT,
			today: stats.today,
			last30Days: stats.last30Days,
			month: stats.month,
			lastMonth: stats.lastMonth,
			autoCompactionsLast7Days: stats.autoCompactionsLast7Days,
			missedPotential: stats.missedPotential ?? [],
			customizationMatrix: stats.customizationMatrix,
			memoryFilesAnalysis: stats.memoryFilesAnalysis ?? null,
		};

		const evaluated = _evaluateInsights(ctx, this._insightStateBag, cadenceDays, this._lastInsightNudgeAt);
		_mergeInsightStates(evaluated, this._insightStateBag, now);

		this.refreshInsightBadgeFromState(now, evaluated);

		await this.context.globalState.update('insights.state', this._insightStateBag);
		if (!this.mayPublishAt(originGeneration)) { return; }

		// Push updated insights to the analysis panel if it is open
		if (this.analysisPanel) {
			void this.analysisPanel.webview.postMessage({
				command: 'updateInsights',
				insights: evaluated,
			});
		}

		// Surface a toast for the highest-weight 'new' allowToast insight (rate-limited)
		const toastsEnabled = vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('insights.toastsEnabled', true);
		if (!toastsEnabled) { return; }
		if (!_isToastAllowed(cadenceDays, this._lastInsightNudgeAt, now)) { return; }

		const toastCandidate = evaluated.find(i => i.allowToast && i.status === 'new');
		if (!toastCandidate) { return; }

		this._lastInsightNudgeAt = now;
		await this.context.globalState.update('insights.lastNudgeAt', now);
		// Second check, for the same reason as the first: the toast is a publication too, and this
		// await is another window for a clear to land in.
		if (!this.mayPublishAt(originGeneration)) { return; }

		const view = l10n.t('button.openInsightsTab');
		const dismiss = l10n.t('button.dismiss');
		const choice = await vscode.window.showInformationMessage(
			`💡 ${toastCandidate.title}`,
			view,
			dismiss,
		);
		if (choice === view) {
			await this.showUsageAnalysisOnInsightsTab(toastCandidate.id);
		} else if (choice === dismiss) {
			this._insightStateBag[toastCandidate.id] = {
				...(this._insightStateBag[toastCandidate.id] ?? { firstSurfacedAt: now }),
				status: 'dismissed',
				lastSurfacedAt: now,
			};
			await this.context.globalState.update('insights.state', this._insightStateBag);
			this.refreshInsightBadgeFromState(now);
		}
	}

	/** Builds the current evaluated insight list from cached state + latest stats. */
	private buildCurrentInsights(stats: UsageAnalysisStats): EvaluatedInsight[] {
		const cadenceDays = vscode.workspace.getConfiguration('aiEngineeringFluency').get<number>('insights.cadenceDays', 2);
		const ctx = {
			// See evaluateAndSurfaceInsights above: the engine is injected with t().
			translate: l10nT,
			today: stats.today,
			last30Days: stats.last30Days,
			month: stats.month,
			lastMonth: stats.lastMonth,
			autoCompactionsLast7Days: stats.autoCompactionsLast7Days,
			missedPotential: stats.missedPotential ?? [],
			customizationMatrix: stats.customizationMatrix,
			todaySessions: stats.todaySessions,
			curationAnalysis: stats.curationAnalysis ?? null,
			repeatedTasks: stats.repeatedTasks ?? null,
			memoryFilesAnalysis: stats.memoryFilesAnalysis ?? null,
		};
		return _evaluateInsights(ctx, this._insightStateBag, cadenceDays, this._lastInsightNudgeAt);
	}

	private async calculateTokenUsage(): Promise<Pick<TokenUsageStats, 'todayTokens' | 'monthTokens'>> {		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		let todayTokens = 0;
		let monthTokens = 0;

		try {
			// Get session files from both workspace and global storage
			const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();

			const fileResults = await this.runWithConcurrency(sessionFiles, async (sessionFile) => {
				const fileStats = await this.statSessionFile(sessionFile);
				const mtime = fileStats.mtime.getTime();
				const fileSize = fileStats.size;
				if (mtime < monthStart.getTime()) { return null; }
				const tokens = (await this.getSessionFileDataCached(sessionFile, mtime, fileSize)).tokens;
				return { mtime, tokens };
			});

			for (const r of fileResults) {
				if (!r) { continue; }
				monthTokens += r.tokens;
				if (r.mtime >= todayStart.getTime()) { todayTokens += r.tokens; }
			}
		} catch (error) {
			this.error(l10n.t('error.calculatingTokenUsage'), error);
		}

		return {
			todayTokens,
			monthTokens
		};
	}

	private async calculateDetailedStats(progressCallback?: (completed: number, total: number) => void, preloaded?: SessionFilePreload[]): Promise<{ stats: DetailedStats; dailyStats: DailyTokenStats[] }> {
		const now = new Date();
		const { todayUtcKey, monthUtcStartKey, lastMonthUtcStartKey, lastMonthUtcEndKey, last30DaysUtcStartKey, last30DaysStartMs, lastMonthStartMs } = computeUtcDateRanges(now);
		const fileLoadCutoffMs = Math.min(last30DaysStartMs, lastMonthStartMs);

		let todayStats = makePeriodAccumulator();
		let monthStats = makePeriodAccumulator();
		let lastMonthStats = makePeriodAccumulator();
		let last30DaysStats = makePeriodAccumulator();
		let dailyStatsMap = new Map<string, DailyTokenStats>();

		try {
			let cacheHits = 0; let cacheMisses = 0; let skippedFiles = 0;
			const analysisStartMs = Date.now();

			type SessionDataEntry = { sessionFile: string; sessionData: SessionFileCache; details: SessionFileDetails; mtime: number; wasCached: boolean };
			let sessionDataResults: (SessionDataEntry | null | undefined)[];

			if (preloaded) {
				sessionDataResults = preloaded.map(p => {
					if (p.sessionData.interactions === 0 || !p.details) { return null; }
					return { sessionFile: p.sessionFile, sessionData: p.sessionData, details: p.details, mtime: p.mtime, wasCached: p.wasCached };
				});
			} else {
				sessionDataResults = await this.loadSessionDataStandalone(fileLoadCutoffMs, progressCallback);
			}

			const aggregateInputs: SessionAggregateInput[] = [];
			for (const r of sessionDataResults) {
				if (!r) { skippedFiles++; continue; }
				if (r.wasCached) { cacheHits++; } else { cacheMisses++; }
				try {
					aggregateInputs.push({ editorType: this.getEditorTypeFromPath(r.sessionFile), sessionData: r.sessionData, mtime: r.mtime, lastInteraction: r.sessionData.lastInteraction || r.details.lastInteraction });
				} catch (fileError) { this.warn(`Error processing session file ${r.sessionFile}: ${fileError}`); }
			}

			const aggregated = aggregatePeriodStats(aggregateInputs, { todayUtcKey, monthUtcStartKey, lastMonthUtcStartKey, lastMonthUtcEndKey, last30DaysUtcStartKey, last30DaysStartMs, lastMonthStartMs });
			todayStats = aggregated.todayStats; monthStats = aggregated.monthStats;
			lastMonthStats = aggregated.lastMonthStats; last30DaysStats = aggregated.last30DaysStats;
			dailyStatsMap = aggregated.dailyStatsMap; skippedFiles += aggregated.skippedCount;

			const analysisElapsedSec = ((Date.now() - analysisStartMs) / 1000).toFixed(1);
			this.log(`✅ Analysis complete in ${analysisElapsedSec}s: Today ${todayStats.sessions} sessions, Month ${monthStats.sessions} sessions, Last 30 Days ${last30DaysStats.sessions} sessions, Previous Month ${lastMonthStats.sessions} sessions`);
			if (skippedFiles > 0) { this.log(`⏭️ Skipped ${skippedFiles} session file(s) (empty or no activity in recent months)`); }
			const totalCacheAccesses = cacheHits + cacheMisses;
			this.log(`💾 Cache performance: ${cacheHits} hits, ${cacheMisses} misses (${totalCacheAccesses > 0 ? ((cacheHits / totalCacheAccesses) * 100).toFixed(1) : 0}% hit rate)`);
		} catch (error) {
			this.error('Error calculating detailed stats:', error);
		}

		const dailyStats = this.fillMissingDailyStats(dailyStatsMap, now);
		const result = this.buildDetailedStatsResult(todayStats, monthStats, lastMonthStats, last30DaysStats, now);
		return { stats: result, dailyStats };
	}

	private async loadSessionDataStandalone(fileLoadCutoffMs: number, progressCallback?: (completed: number, total: number) => void): Promise<({ sessionFile: string; sessionData: SessionFileCache; details: SessionFileDetails; mtime: number; wasCached: boolean } | null | undefined)[]> {
		void this.cacheManager.clearExpiredCache();
		const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
		this.log(`📊 Analyzing ${sessionFiles.length} session file(s)...`);
		if (sessionFiles.length === 0) { this.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?'); }
		return this.runWithConcurrency(sessionFiles, async (sessionFile, i) => {
			if (progressCallback) { progressCallback(i + 1, sessionFiles.length); }
			this.debugCrashLog(`start [${i + 1}/${sessionFiles.length}] ${sessionFile}`);
			const fileStats = await this.statSessionFile(sessionFile);
			const mtime = fileStats.mtime.getTime();
			const fileSize = fileStats.size;
			if (mtime < fileLoadCutoffMs) { this.debugCrashLog(`done  [${i + 1}/${sessionFiles.length}] ${sessionFile} (too old, skipped)`); return null; }
			const cachedData = this.getCachedSessionData(sessionFile);
			const wasCached = isFullCacheHit(cachedData, mtime, fileSize);
			const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
			if (sessionData.interactions === 0) { this.debugCrashLog(`done  [${i + 1}/${sessionFiles.length}] ${sessionFile} (0 interactions, skipped)`); return null; }
			const details = await this.getSessionFileDetails(sessionFile);
			this.debugCrashLog(`done  [${i + 1}/${sessionFiles.length}] ${sessionFile}`);
			return { sessionFile, sessionData, details, mtime, wasCached };
		});
	}

	private fillMissingDailyStats(dailyStatsMap: Map<string, DailyTokenStats>, now: Date): DailyTokenStats[] {
		const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
		const todayKey = toLocalDayKey(now);
		const existingDates = new Set(dailyStatsMap.keys());
		const fillDate = new Date(thirtyDaysAgo);
		while (toLocalDayKey(fillDate) <= todayKey) {
			const dateKey = toLocalDayKey(fillDate);
			if (!existingDates.has(dateKey)) {
				dailyStatsMap.set(dateKey, { date: dateKey, tokens: 0, sessions: 0, interactions: 0, modelUsage: {}, editorUsage: {}, repositoryUsage: {} });
			}
			fillDate.setDate(fillDate.getDate() + 1);
		}
		return Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
	}

	/**
	 * Computes estimated costs grouped by billing provider for a period.
	 * Uses per-editor model usage to determine which billing group each model/session belongs to.
	 * The "GitHub Copilot" group value is replaced by the more accurate `estimatedCostCopilot`
	 * (exact nanoAiu billing + estimated for remaining sessions) when available.
	 */
	private computeBillingGroupCosts(
		editorModelUsage: { [editor: string]: ModelUsage },
		estimatedCostCopilot: number
	): Record<string, number> {
		const groupModelUsage = aggregateEditorModelUsageByBillingGroup(editorModelUsage);
		const result: Record<string, number> = {};
		for (const [group, modelUsage] of Object.entries(groupModelUsage)) {
			result[group] = this.calculateEstimatedCost(modelUsage, getPricingSourceForBillingGroup(group));
		}
		// Replace GitHub Copilot with the more accurate value that accounts for exact nanoAiu billing
		if (estimatedCostCopilot > 0 || result['GitHub Copilot'] !== undefined) {
			result['GitHub Copilot'] = estimatedCostCopilot;
		}
		return result;
	}

	private buildSinglePeriodStats(acc: ReturnType<typeof makePeriodAccumulator>): PeriodStats {
		const environmentalImpact = calculateEnvironmentalImpact(acc.modelUsage, acc.tokens, this.modelPricing);
		const copilotCost = acc.exactCopilotCostDollars + this.calculateEstimatedCost(acc.modelUsageNoExact, 'copilot');
		return {
			tokens: acc.tokens, thinkingTokens: acc.thinkingTokens,
			estimatedTokens: acc.estimatedTokens, actualTokens: acc.actualTokens,
			sessions: acc.sessions,
			avgInteractionsPerSession: acc.sessions > 0 ? Math.round(acc.interactions / acc.sessions) : 0,
			avgTokensPerSession: acc.sessions > 0 ? Math.round(acc.tokens / acc.sessions) : 0,
			modelUsage: acc.modelUsage, editorUsage: acc.editorUsage,
			co2: environmentalImpact.co2,
			treesEquivalent: environmentalImpact.treesEquivalent,
			waterUsage: environmentalImpact.waterUsage,
			estimatedCost: this.calculateEstimatedCost(acc.modelUsage),
			estimatedCostCopilot: copilotCost,
			billingGroupCosts: this.computeBillingGroupCosts(acc.editorModelUsage, copilotCost),
			editorModelUsage: acc.editorModelUsage,
			...(acc.cachedTokens > 0 ? { cachedTokens: acc.cachedTokens } : {}),
			...(acc.subAgentSessions > 0 ? { subAgentSessions: acc.subAgentSessions } : {})
		};
	}

	private buildDetailedStatsResult(
		todayStats: ReturnType<typeof makePeriodAccumulator>,
		monthStats: ReturnType<typeof makePeriodAccumulator>,
		lastMonthStats: ReturnType<typeof makePeriodAccumulator>,
		last30DaysStats: ReturnType<typeof makePeriodAccumulator>,
		now: Date
	): DetailedStats {
		return {
			today: this.buildSinglePeriodStats(todayStats),
			month: this.buildSinglePeriodStats(monthStats),
			lastMonth: this.buildSinglePeriodStats(lastMonthStats),
			last30Days: this.buildSinglePeriodStats(last30DaysStats),
			lastUpdated: now
		};
	}

	private formatDateKey(date: Date): string {
		return toLocalDayKey(date);
	}

	/**
	 * Formats a token count using K/M suffixes for compact display (e.g. 1,500 → 1.5K, 1,200,000 → 1.2M).
	 * Falls back to full locale number when the compact numbers setting is disabled.
	 */
	private formatCompact(value: number): string {
		if (!this.getCompactNumbersSetting()) {
			return value.toLocaleString();
		}
		return new Intl.NumberFormat(undefined, {
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(value);
	}

	private getCompactNumbersSetting(): boolean {
		return vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('display.compactNumbers', true);
	}

	/**
	 * The localization dictionary every webview panel receives in its payload.
	 *
	 * Delegates to {@link buildWebviewLocalization}, which the desktop, JetBrains
	 * and Visual Studio hosts call too — they ship the same bundles and each has
	 * to supply this itself. This used to be a 147-entry literal here plus six
	 * helper methods that existed only to keep it under `max-lines-per-function`.
	 * See docs/adr/LOCALIZATION-ARCHITECTURE.md (S2).
	 */
	private getWebviewLocalization(): Record<string, string> {
		return {
			...buildWebviewLocalization(l10nT),
			// Kept for the JetBrains and Visual Studio hosts, which receive the
			// dictionary as a prebuilt JSON sidecar and so have nowhere else to put
			// the language. The `language` field below always wins where it exists.
			'__language__': resolvedLocale(vscode.env.language),
		};
	}

	/**
	 * The locale-related fields every webview payload carries.
	 *
	 * Two, not one, because they answer different questions: `language` decides
	 * *which strings*, `locale` decides *how numbers and dates are written*. A
	 * German developer on an English VS Code wants `1.234,56` with English UI,
	 * so collapsing them would be a regression. See
	 * docs/adr/LOCALIZATION-ARCHITECTURE.md (S4).
	 *
	 * `language` is the resolved locale, not the raw display language, so English
	 * text is never labelled `lang="fr"` on a locale we ship no bundle for.
	 */
	private getWebviewLocaleFields(): { localization: Record<string, string>; language: string } {
		return {
			localization: this.getWebviewLocalization(),
			language: resolvedLocale(vscode.env.language),
		};
	}

	private getUse24HourTimeSetting(): boolean {
		return vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('display.use24HourTime', true);
	}

	private getHideAutomaticToolCallsSetting(): boolean {
		return vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('display.hideAutomaticToolCalls', true);
	}

	private getStatusBarShowTokensSetting(): StatusBarDisplaySetting {
		return vscode.workspace.getConfiguration('aiEngineeringFluency.display.statusBar').get<StatusBarDisplaySetting>('showTokens', 'both');
	}

	private getStatusBarShowCostSetting(): StatusBarDisplaySetting {
		return vscode.workspace.getConfiguration('aiEngineeringFluency.display.statusBar').get<StatusBarDisplaySetting>('showCost', 'none');
	}

	private getMonthlyBudgetSetting(): number {
		return vscode.workspace.getConfiguration('aiEngineeringFluency.display.statusBar').get<number>('monthlyBudget', 0);
	}

	/** Returns the effective monthly budget: the explicitly configured value if set, otherwise falls back
	 *  to the monthly AI credits included with the user's Copilot plan, or the premium_interactions
	 *  quota entitlement from the API if available. */
	private getEffectiveMonthlyBudget(): number {
		return this.getEffectiveMonthlyBudgetWithSource().budget;
	}

	/** Same as getEffectiveMonthlyBudget, but also reports where the value comes from,
	 *  so the UI can explain a budget the user never configured themselves. */
	private getEffectiveMonthlyBudgetWithSource(): { budget: number; source: string } {
		const configured = this.getMonthlyBudgetSetting();
		if (configured > 0) { return { budget: configured, source: 'monthlyBudget setting' }; }
		// Fall back to quota entitlement (premium_interactions) if available, then to plan credits
		if (this._copilotQuotaEntitlements.premium_interactions) {
			return { budget: this._copilotQuotaEntitlements.premium_interactions, source: 'Copilot plan quota' };
		}
		const planCredits = this._copilotPlanResolved?.monthlyAiCreditsUsd ?? 0;
		return { budget: planCredits, source: 'Copilot plan credits' };
	}

	/** Updates the status bar background color based on current-month GitHub Copilot spend vs. the configured budget.
	 *  Uses the Copilot-only cost from billingGroupCosts so the comparison is provider-specific.
	 *  Uses VS Code's built-in theme colors: warning (yellow) at ≥75%, error (red/orange) at ≥90%.
	 *  Clears the background when no budget is configured or spend is below 75%. */
	private updateStatusBarBackgroundColor(stats: DetailedStats): void {
		const budget = this.getEffectiveMonthlyBudget();
		if (budget <= 0) {
			this.statusBarItem.backgroundColor = undefined;
			return;
		}
		const copilotCost = stats.month.billingGroupCosts?.['GitHub Copilot'] || stats.month.estimatedCostCopilot || stats.month.estimatedCost || 0;
		const ratio = copilotCost / budget;
		if (ratio >= 0.90) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else if (ratio >= 0.75) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	private buildTokenParts(show: StatusBarDisplaySetting, stats: DetailedStats): string[] {
		const parts: string[] = [];
		if (show === 'today' || show === 'both' || show === 'todayAndCurrentMonth') {
			parts.push(this.formatCompact(stats.today.tokens));
		}
		if (show === 'last30days' || show === 'both') {
			parts.push(this.formatCompact(stats.last30Days.tokens));
		}
		if (show === 'currentMonth' || show === 'todayAndCurrentMonth') {
			parts.push(this.formatCompact(stats.month.tokens));
		}
		return parts;
	}

	private buildCostParts(show: StatusBarDisplaySetting, stats: DetailedStats): string[] {
		const fmt = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
		const totalCost = (period: PeriodStats) => {
			const billingTotal = this.sumBillingGroupCosts(period.billingGroupCosts);
			return billingTotal > 0 || period.billingGroupCosts ? billingTotal : (period.estimatedCostCopilot ?? 0);
		};
		const parts: string[] = [];
		if (show === 'today' || show === 'both' || show === 'todayAndCurrentMonth') {
			parts.push(fmt(totalCost(stats.today)));
		}
		if (show === 'last30days' || show === 'both') {
			parts.push(fmt(totalCost(stats.last30Days)));
		}
		if (show === 'currentMonth' || show === 'todayAndCurrentMonth') {
			parts.push(fmt(totalCost(stats.month)));
		}
		return parts;
	}

	private buildStatusBarText(stats: DetailedStats): string {
		const showTokens = this.getStatusBarShowTokensSetting();
		const showCost = this.getStatusBarShowCostSetting();
		const parts: string[] = [];

		if (showTokens !== 'none') {
			parts.push(`$(symbol-numeric) ${this.buildTokenParts(showTokens, stats).join(' | ')}`);
		}
		if (showCost !== 'none') {
			parts.push(`$(credit-card) ${this.buildCostParts(showCost, stats).join(' | ')}`);
		}

        return parts.length > 0 ? parts.join('  ') : `$(symbol-numeric) ${l10n.t('statusBar.defaultText')}`;
	}

	private refreshOpenPanelsForSettingChange(): void {
		const stats = this.currentDetailedStats;
		if (!stats) { return; }
		// Refresh status bar text and background color (respects new display settings)
		this.setStatusBarText(this.buildStatusBarText(stats));
		this.updateStatusBarBackgroundColor(stats);
		this.statusBarItem.tooltip = this.buildTooltipMarkdown(stats);
		if (this.detailsPanel) {
			this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);
		}
		if (this.environmentalPanel) {
			this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, stats);
		}
		if (this.chartPanel && (this.currentFullDailyStats || this.currentDailyStats)) {
			this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, this.currentFullDailyStats ?? this.currentDailyStats!);
		}
		const usageForPanel = this.currentUsageAnalysisStats;
		if (this.analysisPanel && usageForPanel) {
			void this.analysisPanel.webview.postMessage({ command: 'updateStats', data: this._buildAnalysisUpdateData(usageForPanel) });
		}
	}

	/** Compute daily token stats for up to `daysBack` days, using the same token preference
	 *  (actualTokens > estimatedTokens) and UTC date assignment as calculateDetailedStats
	 *  so all chart period views are consistent. Stores the result in
	 *  `lastFullDailyStats` and returns it. Zero-fill is handled per-period in buildChartData. */
	private async calculateDailyStats(
		daysBack = 365,
		knownSessionFiles?: string[],
		onProgress?: (completed: number, total: number, editors: ReadonlySet<string>) => void,
	): Promise<DailyTokenStats[]> {
		// Captured before the first await: the result is only as current as the state this walk
		// started from, so a clearCache() landing mid-walk must leave this stamp behind it.
		const startedAtGeneration = this._cacheGeneration;
		const now = new Date();
		const cutoffStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
		const cutoffStartKey = toLocalDayKey(cutoffStart);
		const cutoffMs = cutoffStart.getTime();
		const dailyStatsMap = new Map<string, DailyTokenStats>();

		try {
			const sessionFiles = knownSessionFiles ?? await this.sessionDiscovery.getCopilotSessionFiles();
			this.log(`📈 Preparing chart data (${daysBack}d) from ${sessionFiles.length} session file(s)...`);

			let completed = 0;
			// Accumulated here rather than by the caller, so every tick carries the whole set
			// so far and a reporter does not have to rebuild it from the single file each
			// tick names.
			const editors = new Set<string>();
			const dailyResults = await this.runWithConcurrency(sessionFiles, async (sessionFile) => {
				try {
					const fileStats = await this.statSessionFile(sessionFile);
					const mtime = fileStats.mtime.getTime();
					const fileSize = fileStats.size;
					if (mtime < cutoffMs) { return null; }
					return { sessionFile, sessionData: await this.getSessionFileDataCached(sessionFile, mtime, fileSize), mtime };
				} finally {
					if (onProgress) {
						const editor = this.detectEditorSource(sessionFile);
						if (editor && editor !== 'Unknown') { editors.add(editor); }
						onProgress(++completed, sessionFiles.length, editors);
					}
				}
			});

			for (const r of dailyResults) {
				if (!r) { continue; }
				const { sessionFile, sessionData, mtime } = r;
				try {
					const editorType = this.getEditorTypeFromPath(sessionFile);
					const repository = sessionData.repository || 'Unknown';
					if (sessionData.dailyRollups && Object.keys(sessionData.dailyRollups).length > 0) {
						this.accumulateDailyRollups(dailyStatsMap, sessionData, editorType, repository, cutoffStartKey);
					} else {
						this.accumulateSessionFallback(dailyStatsMap, sessionData, mtime, editorType, repository, cutoffStartKey);
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile} for daily stats: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating daily stats:', error);
		}

		const result = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
		this.setFullDailyStats(result);
		this._statsGeneration.fullDaily = startedAtGeneration;
		return result;
	}

	private accumulateDailyRollups(dailyStatsMap: Map<string, DailyTokenStats>, sessionData: SessionFileCache, editorType: string, repository: string, cutoffUtcStartKey: string): void {
		const dailyRollups = sessionData.dailyRollups!;
		let lastDayKey: string | undefined;
		for (const [dayKey, dayRollup] of Object.entries(dailyRollups)) {
			if (dayKey < cutoffUtcStartKey) { continue; }
			const dayTokens = (dayRollup.actualTokens > 0 ? dayRollup.actualTokens : dayRollup.tokens);
			const dailyEntry = this.getOrCreateDailyEntry(dailyStatsMap, dayKey);
			// Falls back to the session's overall category (rather than silently dropping to
			// "Conversation") for a day rollup that predates per-day task classification.
			const primaryTaskCategory = dayRollup.primaryTaskCategory ?? sessionData.taskCategory;
			this.addUsageToDailyEntry(dailyEntry, dayTokens, dayRollup.interactions, editorType, repository, dayRollup.modelUsage, dayRollup.taskCategoryShares, primaryTaskCategory, sessionData.usageAnalysis?.modelEfficiency);
			if (!lastDayKey || dayKey > lastDayKey) { lastDayKey = dayKey; }
		}
		if (lastDayKey) {
			// Session-level signals (turn counters, duration, LOC) describe the whole
			// session and cannot be split per day, so they land on the last active day —
			// the same convention the LOC attribution below already uses.
			this.addModelEfficiencyToDailyEntry(dailyStatsMap.get(lastDayKey)!, sessionData, editorType);
			if ((sessionData.linesAdded ?? 0) + (sessionData.linesRemoved ?? 0) > 0) {
				this.addLocToDailyEntry(dailyStatsMap.get(lastDayKey)!, sessionData.linesAdded ?? 0, sessionData.linesRemoved ?? 0, editorType, repository, sessionData.languageUsage);
			}
		}
	}

	private accumulateSessionFallback(dailyStatsMap: Map<string, DailyTokenStats>, sessionData: SessionFileCache, mtime: number, editorType: string, repository: string, cutoffUtcStartKey: string): void {
		const actualTokens = sessionData.actualTokens || 0;
		const tokens = (actualTokens > 0 ? actualTokens : sessionData.tokens);
		const lastActivity = sessionData.lastInteraction ? new Date(sessionData.lastInteraction) : new Date(mtime);
		const dateKey = toLocalDayKey(lastActivity);
		if (dateKey < cutoffUtcStartKey) { return; }
		const dailyEntry = this.getOrCreateDailyEntry(dailyStatsMap, dateKey);
		this.addUsageToDailyEntry(dailyEntry, tokens, sessionData.interactions, editorType, repository, sessionData.modelUsage, sessionData.taskCategoryShares, sessionData.taskCategory, sessionData.usageAnalysis?.modelEfficiency);
		this.addModelEfficiencyToDailyEntry(dailyEntry, sessionData, editorType);
		if ((sessionData.linesAdded ?? 0) + (sessionData.linesRemoved ?? 0) > 0) {
			this.addLocToDailyEntry(dailyEntry, sessionData.linesAdded ?? 0, sessionData.linesRemoved ?? 0, editorType, repository, sessionData.languageUsage);
		}
	}

	/**
	 * Folds one session's per-model efficiency signals into the day entry, so the
	 * Efficiency view can compare models over arbitrary time windows. Session-level
	 * duration/LOC/apply counts are split across the session's models by token share.
	 */
	private addModelEfficiencyToDailyEntry(entry: DailyTokenStats, sessionData: SessionFileCache, editorType: string): void {
		if (!sessionData.usageAnalysis?.modelEfficiency && Object.keys(sessionData.modelUsage).length === 0) { return; }
		_accumulateDayAndEditorModelCounters(entry, editorType, _buildSessionEfficiencyAttribution(sessionData));
	}

	private getOrCreateDailyEntry(dailyStatsMap: Map<string, DailyTokenStats>, dateKey: string): DailyTokenStats {
		if (!dailyStatsMap.has(dateKey)) {
			dailyStatsMap.set(dateKey, {
				date: dateKey,
				tokens: 0,
				sessions: 0,
				interactions: 0,
				modelUsage: {},
				editorUsage: {},
				repositoryUsage: {},
				taskCategoryTokens: {},
				taskCategorySessions: {},
				taskCategoryModelUsage: {},
				taskCategoryUsage: {},
			});
		}
		return dailyStatsMap.get(dateKey)!;
	}

	private addUsageToDailyEntry(
		entry: DailyTokenStats,
		tokens: number,
		interactions: number,
		editorType: string,
		repository: string,
		modelUsage: any,
		taskCategoryShares?: TaskCategoryBreakdown,
		primaryTaskCategory?: TaskCategory,
		/** The session's per-model turn counters; lets routed (hydrafusion/auto) sessions be re-keyed for the efficiency aggregate. */
		modelEfficiency?: ModelEfficiencyUsage
	): void {
		entry.tokens += tokens;
		entry.sessions += 1;
		entry.interactions += interactions;
		if (!entry.editorUsage[editorType]) { entry.editorUsage[editorType] = { tokens: 0, sessions: 0 }; }
		entry.editorUsage[editorType].tokens += tokens;
		entry.editorUsage[editorType].sessions += 1;
		entry.editorUsage[editorType].interactions = (entry.editorUsage[editorType].interactions ?? 0) + interactions;
		if (!entry.repositoryUsage[repository]) { entry.repositoryUsage[repository] = { tokens: 0, sessions: 0 }; }
		entry.repositoryUsage[repository].tokens += tokens;
		entry.repositoryUsage[repository].sessions += 1;
		addModelUsage(entry.modelUsage, modelUsage);
		for (const model of Object.keys(modelUsage)) {
			entry.modelUsage[model]!.sessions += 1;
		}
		_accumulateDayAndEditorModelTokens(entry, editorType, modelUsage, this.modelPricing, modelEfficiency);
		if (!entry.editorModelUsage) { entry.editorModelUsage = {}; }
		if (!entry.editorModelUsage[editorType]) { entry.editorModelUsage[editorType] = {}; }
		addModelUsage(entry.editorModelUsage[editorType], modelUsage);
		for (const model of Object.keys(modelUsage)) {
			entry.editorModelUsage[editorType][model]!.sessions += 1;
		}
		// Shared with the periodic-refresh aggregation path (src/statsHelpers.ts) so a fix to the
		// task-category attribution algorithm can't drift out of sync between the two pipelines.
		_addTaskCategoryToDailyEntry(entry, tokens, modelUsage, primaryTaskCategory, taskCategoryShares);
	}

	private addLocToDailyEntry(entry: DailyTokenStats, linesAdded: number, linesRemoved: number, editorType: string, repository: string, languageUsage?: any): void {
		entry.linesAdded = (entry.linesAdded ?? 0) + linesAdded;
		entry.linesRemoved = (entry.linesRemoved ?? 0) + linesRemoved;
		if (!entry.editorUsage[editorType]) { entry.editorUsage[editorType] = { tokens: 0, sessions: 0 }; }
		entry.editorUsage[editorType].linesAdded = (entry.editorUsage[editorType].linesAdded ?? 0) + linesAdded;
		entry.editorUsage[editorType].linesRemoved = (entry.editorUsage[editorType].linesRemoved ?? 0) + linesRemoved;
		if (!entry.repositoryUsage[repository]) { entry.repositoryUsage[repository] = { tokens: 0, sessions: 0 }; }
		entry.repositoryUsage[repository].linesAdded = (entry.repositoryUsage[repository].linesAdded ?? 0) + linesAdded;
		entry.repositoryUsage[repository].linesRemoved = (entry.repositoryUsage[repository].linesRemoved ?? 0) + linesRemoved;
		if (languageUsage) {
			if (!entry.languageUsage) { entry.languageUsage = {}; }
			addLanguageUsage(entry.languageUsage, languageUsage);
		}
	}

	private detectMissedPotential(
		workspaceSessionCounts: Map<string, number>,
		workspaceInteractionCounts: Map<string, number>
	): MissedPotentialWorkspace[] {
		const missedPotential: MissedPotentialWorkspace[] = [];

		for (const [workspacePath, sessionCount] of workspaceSessionCounts) {
			const files = this._customizationFilesCache.get(workspacePath) || [];
			
			// Check for Copilot files (category "copilot" or undefined for backward compatibility)
			const hasCopilotFiles = files.some(f => !f.category || f.category === 'copilot');
			
			// Check for non-Copilot files (must be explicitly "non-copilot")
			const nonCopilotFiles = files.filter(f => f.category === 'non-copilot');
			
			// Missed potential = has non-Copilot files AND NO Copilot files
			if (nonCopilotFiles.length > 0 && !hasCopilotFiles) {
				missedPotential.push({
					workspacePath,
					workspaceName: path.basename(workspacePath),
					sessionCount,
					interactionCount: workspaceInteractionCounts.get(workspacePath) || 0,
					nonCopilotFiles
				});
			}
		}

		// Sort by interaction count (descending) so most active "missed" repos are first
		missedPotential.sort((a, b) => b.interactionCount - a.interactionCount);

		return missedPotential;
	}

	/**
	 * Calculate usage analysis statistics for today and last 30 days
	 * @param useCache If true, return cached stats if available. If false, force recalculation.
	 */
	/**
	 * `originGeneration` is the generation the caller's `preloaded` entries were gathered in. It
	 * exists because stamping with this function's own start would be wrong for a refresh: the
	 * entries can predate a clear that landed while the refresh was still preloading, and a
	 * calculation starting *after* that clear would otherwise stamp pre-clear inputs as current.
	 * A caller that passes no `preloaded` can still have older inputs: the Efficiency build's
	 * full-year walk repopulates the raw session cache before this runs, so it passes its own
	 * origin generation too. Only a caller with nothing older than this call may omit it.
	 */
	/**
	 * Runs are serialized. A run resets `_customizationFilesCache`/`_workspaceIdToFolderCache` at its start and,
	 * since scans became asynchronous, awaits between filling and reading them; an overlapping run's reset in
	 * that gap would hand the first run an emptied cache (every workspace showing as having no customization
	 * files). Callers already tolerate waiting: the work is a background refresh.
	 */
	private calculateUsageAnalysisStats(useCache = true, preloaded?: SessionFilePreload[], originGeneration?: number): Promise<UsageAnalysisStats> {
		const run = this._usageAnalysisChain.then(() => this.calculateUsageAnalysisStatsExclusive(useCache, preloaded, originGeneration));
		this._usageAnalysisChain = run.then(() => undefined, () => undefined);
		return run;
	}

	private async calculateUsageAnalysisStatsExclusive(useCache = true, preloaded?: SessionFilePreload[], originGeneration?: number): Promise<UsageAnalysisStats> {
		const cachedUsage = this.currentUsageAnalysisStats;
		if (useCache && cachedUsage) {
			this.log('🔍 [Usage Analysis] Using cached stats');
			return cachedUsage;
		}
		const startedAtGeneration = originGeneration ?? this._cacheGeneration;
		const now = new Date();
		const { todayUtcKey, last30DaysUtcStartKey, monthUtcStartKey, lastMonthUtcStartKey, lastMonthUtcEndKey, last30DaysStartMs, lastMonthStartMs } = computeUtcDateRanges(now);
		const cutoffMs = Math.min(last30DaysStartMs, lastMonthStartMs);
		this.log('🔍 [Usage Analysis] Starting calculation...');
		this._cacheHits = 0;
		this._cacheMisses = 0;
		const todayStats = this.createEmptyUsagePeriod();
		const last30DaysStats = this.createEmptyUsagePeriod();
		const monthStats = this.createEmptyUsagePeriod();
		const lastMonthStats = this.createEmptyUsagePeriod();
		const todaySessionsList: TodaySessionSummary[] = [];
		const workspaceSessionCounts = new Map<string, number>();
		const workspaceInteractionCounts = new Map<string, number>();
		const unresolvedWorkspaceIds = new Set<string>();
		const unresolvedWorkspaceInteractionCounts = new Map<string, number>();
		this._workspaceIdToFolderCache.clear();
		this._customizationFilesCache.clear();
		this._pendingCustomizationScans.clear();
		this._skillCallsByEditorAccum = new Map();
		this._toolCallsByEditorAccum = new Map();
		this._skillWorkspacePathsAccum = new Map();
		let agenticDailyTrend: AgenticTrendPoint[] | undefined;
		let recentSessions: { last7: TodaySessionSummary[]; last30: TodaySessionSummary[]; currentMonth: TodaySessionSummary[] } | undefined;
		let correctionReport: CorrectionReport | undefined;
		let repeatedTasks: RepeatedTaskReport | undefined;
		let autoCompactionsLast7Days: UsageAnalysisStats['autoCompactionsLast7Days'];
		try {
			const { results: usageResults, totalFiles } = await this.loadUsageSessionFiles(preloaded, cutoffMs);
			const periods = { todayStats, last30DaysStats, monthStats, lastMonthStats, todayUtcKey, last30DaysUtcStartKey, monthUtcStartKey, lastMonthUtcStartKey, lastMonthUtcEndKey };
			const wsMaps = { workspaceSessionCounts, workspaceInteractionCounts, unresolvedWorkspaceIds, unresolvedWorkspaceInteractionCounts };
			this.aggregateUsageFileResults(usageResults, periods, wsMaps, todaySessionsList, totalFiles);
			recentSessions = this.buildRecentSessionBuckets(usageResults, now);
			autoCompactionsLast7Days = this.buildAutoCompactionStats(usageResults, now);
			correctionReport = this.buildCorrectionReport(usageResults);
			repeatedTasks = this.buildRepeatedTaskReport(usageResults);
			this._lastSkillCallsByEditor = {};
			for (const [skillName, byEditor] of this._skillCallsByEditorAccum) {
				this._lastSkillCallsByEditor[skillName] = Object.fromEntries(byEditor);
			}
			await this.deduplicateWorkspacePathsWithScans(workspaceSessionCounts, workspaceInteractionCounts);
			this.buildUsageCustomizationMatrix(workspaceSessionCounts, workspaceInteractionCounts, unresolvedWorkspaceIds, unresolvedWorkspaceInteractionCounts);
			await this.enrichMultiAgentParentCount(usageResults, last30DaysStats, last30DaysUtcStartKey);
			agenticDailyTrend = await this._computeAgenticDailyTrend(usageResults, last30DaysUtcStartKey);
			// The Recent Sessions buckets are stamped alongside today's list so the
			// "near context limit" column and filter work for every lookback, not just today.
			const contextSessionLists = [todaySessionsList, ...(recentSessions ? [recentSessions.last7, recentSessions.last30, recentSessions.currentMonth] : [])];
			await this.enrichContextWindowFromAppData(usageResults, periods, contextSessionLists);
		} catch (error) {
			this.error('Error calculating usage analysis stats:', error);
		}
		this.log(`🔍 [Usage Analysis] Cache stats: ${this._cacheHits} hits, ${this._cacheMisses} misses`);
		const stats: UsageAnalysisStats = {
			today: todayStats,
			last30Days: last30DaysStats,
			month: monthStats,
			lastMonth: lastMonthStats,
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
			lastUpdated: now,
			customizationMatrix: this._lastCustomizationMatrix,
			missedPotential: this._lastMissedPotential || [],
			todaySessions: todaySessionsList.sort((a, b) => b.interactions - a.interactions),
			recentSessions,
			correctionReport,
			repeatedTasks,
			curationAnalysis: this.computeCurationAnalysis(last30DaysStats, startedAtGeneration),
			agenticDailyTrend,
			autoCompactionsLast7Days,
			memoryFilesAnalysis: this.computeMemoryFilesAnalysis(startedAtGeneration),
			claudeDesktopCoverage: await this.computeClaudeDesktopCoverage(),
			toolCallsByEditor: this._buildToolCallsByEditor(),
		};
		this.lastUsageAnalysisStats = stats;
		this._statsGeneration.usage = startedAtGeneration;
		return stats;
	}

	/**
	 * Measure how many of the Claude Desktop sessions Desktop itself still lists have a transcript
	 * this extension can actually read, so the Recent Sessions view can explain — with a real number —
	 * why Desktop's own session list is longer than the table below it.
	 *
	 * Cached for an hour: it reads ~150 small metadata files, which is cheap but pointless to repeat
	 * on every refresh, and the underlying retention/cloud split moves on the order of days.
	 */
	private async computeClaudeDesktopCoverage(): Promise<ClaudeDesktopCoverage | undefined> {
		const ttlMs = 60 * 60 * 1000;
		if (this._claudeDesktopCoverage && Date.now() - this._claudeDesktopCoverage.computedAt < ttlMs) {
			return this._claudeDesktopCoverage.value;
		}
		try {
			const value = await this.claudeDesktop.getDesktopLocalCoverage(this.claudeCode.getClaudeCodeProjectsDir());
			if (value.knownSessions === 0) { return undefined; }
			this._claudeDesktopCoverage = { value, computedAt: Date.now() };
			return value;
		} catch (error) {
			this.error('Error computing Claude Desktop local coverage:', error);
			return undefined;
		}
	}

	/**
	 * Build a ToolCurationAnalysis from runtime tools + workspace files + recent usage.
	 * Returns null when there are no available tools to analyse.
	 */
	private computeCurationAnalysis(last30Days: UsageAnalysisPeriod, originGeneration?: number): ToolCurationAnalysis | null {
		try {
			const windowDays = vscode.workspace.getConfiguration('aiEngineeringFluency').get<number>('curation.timeWindowDays', 30);
			const workspaceFolderPaths = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
			this.postUsageLoadingProgress('curation:start', {
				workspaces: workspaceFolderPaths.length,
			}, originGeneration);

			// Collect available tools: VS Code runtime tools + mcp.json + extension-contributed + settings + skills.
			const runtimeEntries = _enumerateRuntimeTools(vscode.lm.tools);
			this.postUsageLoadingProgress('curation:runtimeTools', {
				count: runtimeEntries.length,
			}, originGeneration);
			const mcpEntries = _buildMcpEntriesFromJson(workspaceFolderPaths);
			this.postUsageLoadingProgress('curation:mcpJson', {
				count: mcpEntries.length,
			}, originGeneration);
			// Build the set of MCP servers that currently have at least one tool enabled in
			// `vscode.lm.tools`. Extension-contributed entries cross-reference against this
			// set so we can mark them as enabled or disabled (and avoid recommending the user
			// disable tools they've already disabled).
			const enabledMcpServers = new Set<string>();
			for (const e of runtimeEntries) {
				if (e.source === 'mcp' && e.server) { enabledMcpServers.add(e.server); }
			}
			const extensionMcpEntries = _enumerateExtensionMcpServers(vscode.extensions.all, enabledMcpServers);
			const settingsMcpServers = vscode.workspace.getConfiguration('mcp').get<Record<string, unknown>>('servers', {});
			const settingsMcpEntries = _buildMcpEntriesFromSettings(settingsMcpServers);
			this.postUsageLoadingProgress('curation:mcpSources', {
				extensionEntries: extensionMcpEntries.length,
				settingsEntries: settingsMcpEntries.length,
			}, originGeneration);
			const configuredSkillDirsRaw = vscode.workspace.getConfiguration('chat').get<unknown>('agentSkillsLocations', []);
			const configuredSkillDirs = Array.isArray(configuredSkillDirsRaw)
				? configuredSkillDirsRaw.filter((dir): dir is string => typeof dir === 'string')
				: [];
			this.postUsageLoadingProgress('curation:skillsScanStart', {
				configuredLocations: configuredSkillDirs.length,
			}, originGeneration);
			const skillEntries = _discoverSkillEntries(workspaceFolderPaths, { additionalSkillDirs: configuredSkillDirs });
			this.postUsageLoadingProgress('curation:skillsScanDone', {
				skills: skillEntries.length,
			}, originGeneration);

			// Merge: runtime entries already include MCP tools from vscode.lm.tools.
			// Deduplicate MCP server entries (prefer runtime over all static sources).
			const runtimeServers = new Set(runtimeEntries.filter(e => e.source === 'mcp').map(e => e.server));
			const uniqueMcpEntries = mcpEntries.filter(e => !runtimeServers.has(e.server));
			const uniqueExtensionMcpEntries = extensionMcpEntries.filter(e => !runtimeServers.has(e.server) && !uniqueMcpEntries.some(m => m.server === e.server));
			const uniqueSettingsMcpEntries = settingsMcpEntries.filter(e =>
				!runtimeServers.has(e.server) &&
				!uniqueMcpEntries.some(m => m.server === e.server) &&
				!uniqueExtensionMcpEntries.some(m => m.server === e.server)
			);

			const availableTools = [...runtimeEntries, ...uniqueMcpEntries, ...uniqueExtensionMcpEntries, ...uniqueSettingsMcpEntries, ...skillEntries];
			if (availableTools.length === 0) {
				this.postUsageLoadingProgress('curation:done', { availableTools: 0 }, originGeneration);
				return null;
			}
			this.postUsageLoadingProgress('curation:analyzing', {
				availableTools: availableTools.length,
				skills: skillEntries.length,
			}, originGeneration);

			const result = _analyzeToolCuration(availableTools, last30Days, windowDays);
			this.postUsageLoadingProgress('curation:done', {
				availableTools: availableTools.length,
				unusedTools: result.unusedTools.length,
			}, originGeneration);
			return result;
		} catch (err) {
			this.postUsageLoadingProgress('curation:error', {
				error: String(err),
			}, originGeneration);
			this.log(`⚠️ Tool curation analysis failed: ${String(err)}`);
			return null;
		}
	}

	/**
	 * Discover and analyze Copilot's on-disk agent memory files (memory-tool/memories,
	 * user/repo/session scope) for a hygiene insight. Metadata-only (path/size/mtime),
	 * never reads memory file content. Returns null when no memory files were found or
	 * on any scan error, so a failure here never breaks the rest of the stats build.
	 *
	 * The underlying scan is a synchronous `readdirSync`/`statSync` walk across every VS
	 * Code User root and workspace hash, so it is throttled to at most once per
	 * {@link MEMORY_FILES_SCAN_TTL_MS} and reused across recomputes in between (e.g.
	 * periodic Usage Analysis refreshes) rather than re-walking the filesystem every time.
	 */
	private computeMemoryFilesAnalysis(originGeneration: number): MemoryFilesAnalysis | null {
		const now = Date.now();
		// The TTL alone isn't enough: a calculation that started before a clearCache()/
		// refreshAnalysisPanel() generation bump can resume afterwards and still reach this
		// point, where a fresh-looking scan it performs would otherwise satisfy a later,
		// post-clear read without ever re-scanning. Gating reuse on the generation this scan
		// was cached *under* (mirroring the `_statsGeneration`/`isComputedStatsCurrent` guard
		// used for the other computed-stat caches) rejects that stale-origin result.
		const generationCurrent = isComputedStatsCurrent(this._statsGeneration.memoryFiles, this._cacheGeneration);
		if (generationCurrent && isMemoryFilesScanFresh(this._memoryFilesAnalysisScannedAt, now, MEMORY_FILES_SCAN_TTL_MS)) {
			return this._memoryFilesAnalysisCache ?? null;
		}
		let result: MemoryFilesAnalysis | null;
		try {
			const files = _discoverAllMemoryFiles();
			result = files.length === 0 ? null : _analyzeMemoryFiles(files);
		} catch (err) {
			this.log(`⚠️ Memory files analysis failed: ${String(err)}`);
			result = null;
		}
		// Only let a calculation whose origin generation is still current update the shared
		// scan cache — a stale (pre-clear) calculation must not let its result be reused by a
		// post-clear read, even though the scan it just ran reflects the current filesystem.
		if (originGeneration === this._cacheGeneration) {
			this._memoryFilesAnalysisCache = result;
			this._memoryFilesAnalysisScannedAt = now;
			this._statsGeneration.memoryFiles = originGeneration;
		}
		return result;
	}

	/**
	 * Is the server-memories section switched on? Defaults to on, with its own opt-out because
	 * this section reads from GitHub on a background refresh. That is not a claim the view is
	 * otherwise offline — the same refresh path already fetches Repository PR and Cloud Agent
	 * data — only that this section has a switch of its own.
	 */
	private getServerMemoriesEnabledSetting(): boolean {
		return vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('serverMemories.enabled', true);
	}

	/**
	 * Resolve the workspace's `owner/name`, reusing the shared git-config reader rather than
	 * spawning `git remote get-url` (see `readGitOriginUrl`). Returns undefined when there is
	 * no folder open, no origin remote, or the remote is not a GitHub repository — all of
	 * which mean there is no memory store to ask about.
	 */
	/**
	 * Drop any cached repository-memory analysis and re-render the open panel.
	 *
	 * Called when something the cache identity does *not* cover changes: the signed-in
	 * account, or the feature's own setting. The identity is repository + checkout root,
	 * which is right for "is this the same store?" but says nothing about who we asked as, so
	 * those two need an explicit nudge rather than waiting out the TTL.
	 */
	private invalidateServerMemoriesCache(): void {
		// Bump first: any request already in flight captured the previous value and is now
		// disqualified from publishing, rather than overwriting this clear when it returns.
		this._serverMemoriesGeneration++;
		this._serverMemoriesAnalysis = undefined;
		this._serverMemoriesRepo = undefined;
		this._serverMemoriesRepoRoot = undefined;
		this._serverMemoriesFetchedAt = undefined;
		if (this.analysisPanel) { this.refreshOpenPanelsForSettingChange(); }
	}

	private resolveWorkspaceRepoSlug(): { repoRoot: string; repo: string } | undefined {
		// Workspace trust gates this, for the same reason it gates the repository hygiene
		// analysis in ensureWorkspaceTrustedForGitAccess(). Everything downstream is driven by
		// a file the checkout controls: `.git/config` names the repository, which decides what
		// this asks the Copilot API for with the user's token, and the citations that come
		// back decide which local paths get probed. Merely *opening* a hostile repository
		// should not be enough to start authenticated network work on its behalf.
		//
		// This returns undefined rather than throwing, unlike the hygiene analysis: that one
		// is an explicit user action that deserves an explanation, while this runs on a
		// background refresh, where the right outcome is simply no section.
		if (!vscode.workspace.isTrusted) { return undefined; }
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			// A virtual workspace has no local git config or working tree to inspect, and
			// `fsPath` on a non-file URI is not a usable filesystem path.
			if (folder.uri.scheme !== 'file') { continue; }
			const repoRoot = this.findGitRepoRoot(folder.uri.fsPath);
			if (!repoRoot) { continue; }
			const originUrl = _readGitOriginUrl(repoRoot);
			const repo = originUrl ? _parseRepoFromRemoteUrl(originUrl) : undefined;
			if (repo) { return { repoRoot, repo }; }
		}
		return undefined;
	}

	/**
	 * Walk up from `startPath` to the nearest ancestor that is a git repository root.
	 *
	 * An open workspace folder is often *not* the repository root — opening a subdirectory
	 * of a checkout is ordinary. `readGitOriginUrl()` only looks for `<dir>/.git`, so
	 * without this the section would silently vanish for those workspaces, which reads
	 * exactly like "this repository has no memories". The root also has to be right for its
	 * own sake: citation staleness resolves repo-relative paths against it, so a
	 * subdirectory base would make every citation look missing.
	 */
	private findGitRepoRoot(startPath: string): string | undefined {
		const path = require('path') as typeof import('path');
		let current = path.resolve(startPath);
		// Stop at the filesystem root, where `dirname` becomes a fixed point.
		for (let parent = path.dirname(current); ; current = parent, parent = path.dirname(current)) {
			if (_isGitRepoRoot(current)) { return current; }
			if (parent === current) { return undefined; }
		}
	}

	/**
	 * Refresh {@link _serverMemoriesAnalysis} in the background when it is stale.
	 *
	 * Fire-and-forget on purpose: the stats build that calls this is synchronous, so the
	 * result lands in the *next* render rather than this one. That is acceptable for a panel
	 * that refreshes periodically, and it keeps a slow or unreachable GitHub from delaying
	 * every other number on the view.
	 *
	 * Authentication is silent-only. If the user has no GitHub session already, the section
	 * stays empty rather than popping a sign-in prompt at them for a secondary insight.
	 */
	/**
	 * A public-GitHub access token for the signed-in user, or undefined when there is no
	 * session to reuse.
	 *
	 * The public `github` provider specifically, NOT getGitHubAuthProviderId(). That helper
	 * follows the `github-enterprise.uri` setting, but this feature is fixed to public GitHub
	 * at both ends: the remote parser only accepts github.com repositories, and the request
	 * always goes to api.githubcopilot.com. With an Enterprise endpoint configured and a
	 * public checkout open, the helper would hand us a GHES token to send to a host it was
	 * never issued for.
	 *
	 * `silent: true` never prompts, so a user without a session sees nothing rather than a
	 * sign-in dialog for a secondary insight. It also only returns a session that already
	 * covers the requested scopes, which is why this asks for the same `read:user` scope every
	 * other getSession() call in this file uses rather than anything wider: a broader request
	 * would come back empty for users who have already granted the narrower one.
	 */
	private async getPublicGitHubTokenSilently(): Promise<string | undefined> {
		// Signing out in this extension does not revoke the provider session, so getSession()
		// would still hand one back. Honour the user's decision instead: they asked us to stop
		// using their GitHub identity, and a background fetch is exactly the kind of thing they
		// meant. The flag is cleared when they authenticate again.
		if (this._githubSignedOutByUser) { return undefined; }
		// Bounded, and never throws. This call is awaited inside the same in-flight promise as
		// the memory requests, which are themselves timed out — but an auth provider that
		// stalls would wedge the guard just as surely as a hung socket, and one that rejects
		// would reach the outer catch, which stamps a fresh one-hour timestamp and so hides
		// the failure while suppressing every retry. Returning undefined instead routes both
		// cases through the no-session path, which deliberately does not mark the cache fresh.
		try {
			const session = await Promise.race([
				vscode.authentication.getSession(PUBLIC_GITHUB_AUTH_PROVIDER_ID, ['read:user'], { silent: true }),
				new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), SERVER_MEMORIES_AUTH_TIMEOUT_MS)),
			]);
			return session?.accessToken;
		} catch (err) {
			this.log(`⚠️ Server memories: GitHub session lookup failed: ${String(err)}`);
			return undefined;
		}
	}

	private scheduleServerMemoriesRefresh(): void {
		// The workspace is resolved unconditionally, before any early return, so that a switch
		// away from a repository clears what is on screen even while that repository's own
		// fetch is still running. See decideServerMemoriesRefresh() for why the order matters.
		const context = this.resolveWorkspaceRepoSlug();
		const decision = decideServerMemoriesRefresh({
			enabled: this.getServerMemoriesEnabledSetting(),
			currentRepo: context?.repo,
			currentRepoRoot: context?.repoRoot,
			cachedRepo: this._serverMemoriesRepo,
			cachedRepoRoot: this._serverMemoriesRepoRoot,
			fetchedAt: this._serverMemoriesFetchedAt,
			fetchInFlight: this._serverMemoriesFetchInFlight !== undefined,
			now: Date.now(),
			ttlMs: SERVER_MEMORIES_FETCH_TTL_MS,
		});

		if (decision.clearCache) {
			this._serverMemoriesAnalysis = null;
			this._serverMemoriesRepo = undefined;
			this._serverMemoriesRepoRoot = undefined;
			this._serverMemoriesFetchedAt = undefined;
		}
		if (!decision.startFetch || !context) { return; }

		const generation = this._serverMemoriesGeneration;
		this._serverMemoriesFetchInFlight = (async () => {
			try {
				// Resolved up front rather than inside getToken() so "the user is not signed in"
				// stays distinct from "the request failed". Both would otherwise arrive as a
				// `result.error` and render the unavailable card, contradicting the documented
				// behaviour that a user without a session simply sees nothing. A genuine request
				// failure still surfaces, which is the case worth showing.
				const token = await this.getPublicGitHubTokenSilently();
				if (!token) {
					// Deliberately NOT marked fresh. Signing in is something the user can do at
					// any moment, and stamping a full TTL here would leave the section empty for
					// an hour afterwards even though a session is now available. Leaving the
					// timestamp unset makes the next refresh retry; the retry is a local,
					// non-prompting getSession() call, so repeating it costs nothing.
					if (this.isServerMemoriesContextCurrent(context, generation)) {
						this._serverMemoriesAnalysis = null;
						this._serverMemoriesRepo = undefined;
						this._serverMemoriesRepoRoot = undefined;
						this._serverMemoriesFetchedAt = undefined;
					}
					return;
				}
				const result = await _fetchRepoMemories(context.repo, {
					getToken: async () => token,
				});
				// Symlink-safe: existsSync() follows links, so a repository symlink pointing out of
				// the checkout would turn a lexically-innocent citation into a probe of an
				// arbitrary path. createRepoFileExists() resolves the real path and requires it
				// to stay under the real root.
				const analysis = _analyzeServerMemories(result, {
					fileExists: _createRepoFileExists(context.repoRoot),
				});
				// The workspace can change, or the user can switch the feature off, while this
				// request is in flight. Publishing unconditionally would then put one repository's
				// memories on screen for another — or restore a section the user just disabled.
				if (this.isServerMemoriesContextCurrent(context, generation)) {
					this._serverMemoriesAnalysis = analysis;
					this._serverMemoriesRepo = context.repo;
					this._serverMemoriesRepoRoot = context.repoRoot;
					this._serverMemoriesFetchedAt = Date.now();
				}
			} catch (err) {
				this.log(`⚠️ Server memories fetch failed: ${String(err)}`);
				if (this.isServerMemoriesContextCurrent(context, generation)) {
					this._serverMemoriesAnalysis = null;
					this._serverMemoriesRepo = context.repo;
					this._serverMemoriesRepoRoot = context.repoRoot;
					this._serverMemoriesFetchedAt = Date.now();
				}
			} finally {
				this._serverMemoriesFetchInFlight = undefined;
			}
		})();
	}

	/**
	 * Is a finished fetch for `repo` still the one the view wants?
	 *
	 * False when the feature was switched off mid-flight, or when the workspace has since
	 * resolved to a different repository — in either case the result must be dropped rather
	 * than published over the current context.
	 */
	private isServerMemoriesContextCurrent(context: { repo: string; repoRoot: string }, generation: number): boolean {
		// A fetch begun before an explicit sign-out must not publish after it. The generation
		// bump from invalidateServerMemoriesCache() already covers this, but the flag is
		// checked directly so the guarantee does not depend on that one call site.
		if (this._githubSignedOutByUser) { return false; }
		// The generation is the part the other three cannot express: signing out or switching
		// account leaves the setting, repository and root all identical, so without it a
		// response fetched under the previous token would publish into the new session's view.
		if (generation !== this._serverMemoriesGeneration) { return false; }
		if (!this.getServerMemoriesEnabledSetting()) { return false; }
		const current = this.resolveWorkspaceRepoSlug();
		return current?.repo === context.repo && current?.repoRoot === context.repoRoot;
	}

	/**
	 * The server-memories projection for a webview payload, kicking off a background refresh
	 * when the cached read has aged out.
	 */
	private buildServerMemoriesView(): ServerMemoriesAnalysisView | null {
		this.scheduleServerMemoriesRefresh();
		return _toServerMemoriesAnalysisView(this._serverMemoriesAnalysis ?? null);
	}

	async openMcpJson(): Promise<void> {
		const fs = require('fs') as typeof import('fs');
		const path = require('path') as typeof import('path');
		const os = require('os') as typeof import('os');

		// Collect all candidate paths (workspace + user-level), keeping only those that exist.
		const folderPaths = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
		const candidates: { label: string; fsPath: string }[] = [];

		const workspaceCandidates = folderPaths.flatMap(folder => [
			{ label: '.vscode/mcp.json', fsPath: path.join(folder, '.vscode', 'mcp.json') },
			{ label: '.mcp.json (repo root)', fsPath: path.join(folder, '.mcp.json') },
			{ label: '.vs/mcp.json', fsPath: path.join(folder, '.vs', 'mcp.json') },
			{ label: '.cursor/mcp.json', fsPath: path.join(folder, '.cursor', 'mcp.json') },
		]);
		const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
		const userCandidate = { label: `~/.mcp.json (user-global)`, fsPath: path.join(home, '.mcp.json') };

		for (const c of [...workspaceCandidates, userCandidate]) {
			if (fs.existsSync(c.fsPath)) {
				candidates.push(c);
			}
		}

		if (candidates.length === 0) {
			// No files exist — offer to create one
			const target = folderPaths.length > 0
				? path.join(folderPaths[0], '.vscode', 'mcp.json')
				: path.join(home, '.mcp.json');
			const choice = await vscode.window.showInformationMessage(
				`No mcp.json files found. Create ${target}?`,
				'Create', 'Cancel',
			);
			if (choice !== 'Create') { return; }
			const dir = path.dirname(target);
			if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
			fs.writeFileSync(target, JSON.stringify({ servers: {} }, null, 2));
			await vscode.window.showTextDocument(vscode.Uri.file(target));
			return;
		}

		if (candidates.length === 1) {
			await vscode.window.showTextDocument(vscode.Uri.file(candidates[0].fsPath));
			return;
		}

		// Multiple files — show a quick pick
		const items: (vscode.QuickPickItem & { fsPath: string })[] = candidates.map(c => ({
			label: c.label,
			description: c.fsPath,
			fsPath: c.fsPath,
		}));
		const picked = await vscode.window.showQuickPick(items, {
			title: 'Open MCP config file',
			placeHolder: 'Select which mcp.json to open',
		});
		if (picked) {
			await vscode.window.showTextDocument(vscode.Uri.file(picked.fsPath));
		}
	}

	private createEmptyUsagePeriod(): UsageAnalysisPeriod {
		return {
			sessions: 0,
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
			contextReferences: {
				file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
				workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0,
				clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0,
				byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} },
			modelSwitching: {
				modelsPerSession: [], totalSessions: 0, averageModelsPerSession: 0,
				maxModelsPerSession: 0, minModelsPerSession: 0, switchingFrequency: 0,
				autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0,
				selectedModelExtensions: [], unknownProviderModels: [],
				standardModels: [], premiumModels: [], unknownModels: [], mixedTierSessions: 0,
				standardRequests: 0, premiumRequests: 0, unknownRequests: 0, totalRequests: 0,
				lowCostModels: [], mediumCostModels: [], highCostModels: [], mixedCostSessions: 0,
				lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0
			},
			repositories: [],
			repositoriesWithCustomization: [],
			editScope: { singleFileEdits: 0, multiFileEdits: 0, totalEditedFiles: 0, avgFilesPerSession: 0 },
			applyUsage: { totalApplies: 0, totalCodeBlocks: 0, applyRate: 0 },
			sessionDuration: { totalDurationMs: 0, avgDurationMs: 0, avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0, activeDurationMs: 0 },
			conversationPatterns: { multiTurnSessions: 0, singleTurnSessions: 0, avgTurnsPerSession: 0, maxTurnsInSession: 0 },
			agentTypes: { editsAgent: 0, defaultAgent: 0, workspaceAgent: 0, other: 0 },
			taskCategoryPrimarySessions: {},
			taskCategoryWeightedSessions: {},
		};
	}

	/** Splits usage results (within the last-30-days window) into Copilot CLI uuids and Hermes session ids, along with each id's day key (for daily trend bucketing). */
	private _collectMultiAgentCandidateIds(
		usageResults: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		last30DaysUtcStartKey: string,
	): { cliUuids: string[]; hermesIds: string[]; dayByCliUuid: Map<string, string>; dayByHermesId: Map<string, string> } {
		const cliUuids: string[] = [];
		const hermesIds: string[] = [];
		const dayByCliUuid = new Map<string, string>();
		const dayByHermesId = new Map<string, string>();
		for (const r of usageResults) {
			if (!r) { continue; }
			const lastActivityKey = this.computeLastActivityKey(r.sessionData, r.mtime);
			if (lastActivityKey < last30DaysUtcStartKey) { continue; }
			const uuid = this.extractCopilotCliUuid(r.sessionFile);
			if (uuid) { cliUuids.push(uuid); dayByCliUuid.set(uuid, lastActivityKey); continue; }
			if (this.hermes.isHermesSessionFile(r.sessionFile)) {
				const id = this.hermes.getSessionId(r.sessionFile);
				if (id) { hermesIds.push(id); dayByHermesId.set(id, lastActivityKey); }
			}
		}
		return { cliUuids, hermesIds, dayByCliUuid, dayByHermesId };
	}

	/** Counts Copilot CLI sessions (from data.db hierarchy) with 2+ direct child workspaces. */
	private async _countCliMultiAgentParents(cliUuids: string[]): Promise<number> {
		if (cliUuids.length === 0) { return 0; }
		try {
			const hierarchy = await this.copilotAppData.getSessionHierarchy(cliUuids);
			let count = 0;
			for (const uuid of cliUuids) {
				const node = hierarchy.get(uuid);
				if (node && node.totalChildCount >= STAGE_THRESHOLDS.agentic.multiAgentMinChildren) { count++; }
			}
			return count;
		} catch {
			return 0; /* optional enrichment — suppress */
		}
	}

	/**
	 * Query data.db (Copilot CLI) and Hermes's state.db for multi-agent parent counts and
	 * set the combined total on the period. A session counts as a "multi-agent parent" when
	 * it has 2+ direct children (child workspaces for Copilot CLI; `source='subagent'` rows
	 * pointing back via `parent_session_id` for Hermes). Errors are swallowed — optional enrichment only.
	 */
	private async enrichMultiAgentParentCount(
		usageResults: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		last30DaysStats: UsageAnalysisPeriod,
		last30DaysUtcStartKey: string,
	): Promise<void> {
		const { cliUuids, hermesIds } = this._collectMultiAgentCandidateIds(usageResults, last30DaysUtcStartKey);
		let count = await this._countCliMultiAgentParents(cliUuids);
		if (hermesIds.length > 0) {
			try {
				count += await this.hermes.getMultiAgentParentCount(hermesIds);
			} catch { /* optional enrichment — suppress */ }
		}
		if (count > 0) { last30DaysStats.multiAgentParentSessions = count; }
	}

	/** Buckets multi-agent-parent counts (CLI + Hermes) per day into `byDay`. Shared by `_computeAgenticDailyTrend`. */
	private async _bucketMultiAgentParentsByDay(
		cliUuids: string[],
		hermesIds: string[],
		dayByCliUuid: Map<string, string>,
		dayByHermesId: Map<string, string>,
		byDay: Map<string, { multiAgentParentSessions: number; delegationSessions: number }>,
	): Promise<void> {
		const getEntry = (day: string) => {
			let entry = byDay.get(day);
			if (!entry) { entry = { multiAgentParentSessions: 0, delegationSessions: 0 }; byDay.set(day, entry); }
			return entry;
		};
		const threshold = STAGE_THRESHOLDS.agentic.multiAgentMinChildren;
		if (cliUuids.length > 0) {
			const hierarchy = await this.copilotAppData.getSessionHierarchy(cliUuids);
			for (const uuid of cliUuids) {
				const node = hierarchy.get(uuid);
				const day = dayByCliUuid.get(uuid);
				if (node && node.totalChildCount >= threshold && day) { getEntry(day).multiAgentParentSessions++; }
			}
		}
		if (hermesIds.length > 0) {
			const childCounts = await this.hermes.getChildCounts(hermesIds);
			for (const id of hermesIds) {
				const childCount = childCounts.get(id) ?? 0;
				const day = dayByHermesId.get(id);
				if (childCount >= threshold && day) { getEntry(day).multiAgentParentSessions++; }
			}
		}
	}

	/**
	 * Builds the daily "Multi-Agent Usage" trend (last ~30 days) shown as a sparkline on the
	 * Fluency dashboard's Agentic category card. Each day combines two independent signals:
	 * multi-agent-parent sessions (data.db/Hermes hierarchy, 2+ children) and delegation
	 * sessions (adapter-agnostic tool-name classification). Errors are swallowed — optional
	 * enrichment only, absent from the payload when it fails or there is no signal.
	 */
	private async _computeAgenticDailyTrend(
		usageResults: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		last30DaysUtcStartKey: string,
	): Promise<AgenticTrendPoint[] | undefined> {
		try {
			const { cliUuids, hermesIds, dayByCliUuid, dayByHermesId } = this._collectMultiAgentCandidateIds(usageResults, last30DaysUtcStartKey);
			const byDay = new Map<string, { multiAgentParentSessions: number; delegationSessions: number }>();
			await this._bucketMultiAgentParentsByDay(cliUuids, hermesIds, dayByCliUuid, dayByHermesId, byDay);
			for (const r of usageResults) {
				if (!r || r.sessionData.taskCategory !== 'Delegation') { continue; }
				const day = this.computeLastActivityKey(r.sessionData, r.mtime);
				if (day < last30DaysUtcStartKey) { continue; }
				const entry = byDay.get(day) ?? { multiAgentParentSessions: 0, delegationSessions: 0 };
				entry.delegationSessions++;
				byDay.set(day, entry);
			}
			if (byDay.size === 0) { return undefined; }
			return Array.from(byDay.entries())
				.map(([date, v]) => ({ date, ...v }))
				.sort((a, b) => a.date.localeCompare(b.date));
		} catch {
			return undefined; /* optional enrichment — suppress */
		}
	}

	/** The usage periods whose date range contains the given UTC activity key. */
	private _periodsForActivityKey(
		key: string,
		periods: { todayStats: UsageAnalysisPeriod; last30DaysStats: UsageAnalysisPeriod; monthStats: UsageAnalysisPeriod; lastMonthStats: UsageAnalysisPeriod; todayUtcKey: string; last30DaysUtcStartKey: string; monthUtcStartKey: string; lastMonthUtcStartKey: string; lastMonthUtcEndKey: string },
	): UsageAnalysisPeriod[] {
		const matched: UsageAnalysisPeriod[] = [];
		if (key >= periods.last30DaysUtcStartKey) { matched.push(periods.last30DaysStats); }
		if (key >= periods.monthUtcStartKey) { matched.push(periods.monthStats); }
		if (key >= periods.lastMonthUtcStartKey && key <= periods.lastMonthUtcEndKey) { matched.push(periods.lastMonthStats); }
		if (key === periods.todayUtcKey) { matched.push(periods.todayStats); }
		return matched;
	}

	/** Fold one data.db context row into a period aggregate. `hadTier` prevents double-counting sessions whose events.jsonl already carried a tier. */
	private _mergeDbContextIntoPeriod(period: UsageAnalysisPeriod, info: SessionContextWindow, hadTier: boolean): void {
		const cw = this._ensureContextWindow(period);
		if (info.contextReachedTokens && info.contextReachedTokens > (cw.maxReachedTokens ?? 0)) {
			cw.maxReachedTokens = info.contextReachedTokens;
			cw.maxReachedWindowLimit = info.contextWindowLimit ?? undefined;
		}
		if (info.contextTier && !hadTier) {
			cw.tierCounts[info.contextTier] = (cw.tierCounts[info.contextTier] ?? 0) + 1;
		}
	}

	/**
	 * Fold one data.db context row into a period's per-session exhaustion counters.
	 * See `contextPressure.ts` for the denominator and de-duplication rules.
	 */
	private _mergeDbContextPressure(
		period: UsageAnalysisPeriod, info: SessionContextWindow, alreadyCounted: boolean, compacted: boolean,
	): void {
		mergeDbContextPressure(period, info, alreadyCounted, compacted);
	}

	/** Collect activity key + tier presence per Copilot CLI session uuid in the loaded window. */
	private _collectCliSessionEntries(
		usageResults: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
	): Map<string, { activityKey: string; hadTier: boolean; hasContextSignal: boolean; compacted: boolean }> {
		const entries = new Map<string, { activityKey: string; hadTier: boolean; hasContextSignal: boolean; compacted: boolean }>();
		for (const r of usageResults) {
			if (!r || r.sessionData.interactions === 0) { continue; }
			const uuid = this.extractCopilotCliUuid(r.sessionFile);
			if (!uuid) { continue; }
			entries.set(uuid, {
				activityKey: this.computeLastActivityKey(r.sessionData, r.mtime),
				hadTier: !!r.sessionData.contextTier,
				hasContextSignal: this._hasContextSignal(r.sessionData),
				compacted: this._sessionCompactionEvents(r.sessionData) > 0,
			});
		}
		return entries;
	}

	/** Index session summaries by Copilot CLI uuid, using this class's path parser. */
	private _indexSessionsByCliUuid(sessionLists: TodaySessionSummary[][]): Map<string, TodaySessionSummary[]> {
		return indexSessionsByCliUuid(sessionLists, (filePath) => this.extractCopilotCliUuid(filePath));
	}

	/**
	 * Stamp data.db context-window state (tier, window limit, last fill) onto a
	 * standalone list of session summaries — used by the lazily-loaded Recent
	 * Sessions lookbacks, which are built outside the main analysis pass and
	 * would otherwise show no context fill at all.
	 */
	private async applyDbContextToSessions(sessions: TodaySessionSummary[]): Promise<void> {
		const byUuid = this._indexSessionsByCliUuid([sessions]);
		if (byUuid.size === 0) { return; }
		try {
			applyDbContextToIndexedSessions(byUuid, await this.copilotAppData.getSessionContextInfo([...byUuid.keys()]));
		} catch { /* optional enrichment — suppress */ }
	}

	/**
	 * Enrich the usage periods and the given session summary lists with
	 * context-window state from data.db: the selected window limit, the last
	 * known fill, and the context tier (data.db also covers sessions whose
	 * events.jsonl lacks a contextTier).
	 *
	 * `sessionLists` covers today's list *and* the Recent Sessions lookback
	 * buckets, so the per-session fill the "Context" column and its near-limit
	 * filter read is populated for every period the tab can show, not only
	 * today. Errors are swallowed — this is optional enrichment only.
	 */
	private async enrichContextWindowFromAppData(
		usageResults: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		periods: { todayStats: UsageAnalysisPeriod; last30DaysStats: UsageAnalysisPeriod; monthStats: UsageAnalysisPeriod; lastMonthStats: UsageAnalysisPeriod; todayUtcKey: string; last30DaysUtcStartKey: string; monthUtcStartKey: string; lastMonthUtcStartKey: string; lastMonthUtcEndKey: string },
		sessionLists: TodaySessionSummary[][],
	): Promise<void> {
		const entries = this._collectCliSessionEntries(usageResults);
		if (entries.size === 0) { return; }
		const sessionsByUuid = this._indexSessionsByCliUuid(sessionLists);
		try {
			const contextInfo = await this.copilotAppData.getSessionContextInfo([...entries.keys()]);
			for (const [uuid, info] of contextInfo) {
				const entry = entries.get(uuid);
				if (!entry) { continue; }
				for (const period of this._periodsForActivityKey(entry.activityKey, periods)) {
					this._mergeDbContextIntoPeriod(period, info, entry.hadTier);
					this._mergeDbContextPressure(period, info, entry.hasContextSignal, entry.compacted);
				}
				for (const session of sessionsByUuid.get(uuid) ?? []) { applyDbContextToSession(session, info); }
			}
		} catch { /* optional enrichment — suppress */ }
	}

	private buildDefaultSessionAnalysis(): SessionUsageAnalysis {
		return {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
			contextReferences: {
				file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
				workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0,
				clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0,
				byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} },
			taskClassification: createEmptyTaskClassificationResult(),
			modelSwitching: {
				uniqueModels: [], modelCount: 0, switchCount: 0,
				autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0,
				selectedModelExtensions: [], unknownProviderModels: [],
				tiers: { standard: [], premium: [], unknown: [] }, hasMixedTiers: false,
				standardRequests: 0, premiumRequests: 0, unknownRequests: 0, totalRequests: 0,
				costBuckets: { low: [], medium: [], high: [], unknown: [] }, hasMixedCosts: false,
				lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0
			}
		};
	}

	private async loadUsageSessionFiles(
		preloaded: SessionFilePreload[] | undefined,
		cutoffMs: number
	): Promise<{ results: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[]; totalFiles: number }> {
		if (preloaded) {
			this.log(`🔍 [Usage Analysis] Processing ${preloaded.length} preloaded session files`);
			const results = preloaded.map(p => ({ sessionFile: p.sessionFile, sessionData: p.sessionData, mtime: p.mtime }));
			return { results, totalFiles: preloaded.length };
		}
		const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
		this.log(`🔍 [Usage Analysis] Processing ${sessionFiles.length} session files`);
		const results = await this.runWithConcurrency(sessionFiles, async (sessionFile) => {
			const fileStats = await this.statSessionFile(sessionFile);
			const mtime = fileStats.mtime.getTime();
			const fileSize = fileStats.size;
			if (mtime < cutoffMs) { return null; }
			const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
			return { sessionFile, sessionData, mtime };
		});
		return { results, totalFiles: sessionFiles.length };
	}

	/**
	 * Build session summaries for a lookback window and send them to the analysis panel.
	 * Used by the "Recent Sessions" tab lookback selector; the default "Today" view
	 * keeps using the summaries bundled with updateStats.
	 */
	private async loadRecentSessions(period: ChartTimeWindow): Promise<void> {
		if (!this.analysisPanel) { return; }
		if (period === 'today' || period === 'allTime') { return; }
		// Serve from the main analysis's already-parsed sessions (like Today) instead of
		// re-walking the whole session corpus per period switch; guarantee a post-back on
		// every path (including errors) so the webview never hangs on "Loading...".
		let sessions: TodaySessionSummary[] = [];
		try {
			if (period === 'last90') {
				const now = new Date();
				const start = getTimeWindowStartDate(period, now);
				if (!start) {
					throw new Error(`Cannot load recent sessions for time window "${period}"`);
				}
				const { results } = await this.loadUsageSessionFiles(undefined, start.getTime());
				sessions = this.buildRecentSessionBucket(results, getTimeWindowStartDayKey(period, now));
				await this.applyDbContextToSessions(sessions);
			} else {
				const stats = this.currentUsageAnalysisStats ?? await this.calculateUsageAnalysisStats(true);
				sessions = stats.recentSessions?.[period] ?? [];
			}
		} catch (error) {
			this.error('Error loading recent sessions:', error);
		}
		this.analysisPanel.webview.postMessage({ command: 'recentSessionsLoaded', period, sessions });
	}

	/**
	 * Buckets already-parsed session results into last7 / last30 / currentMonth summaries,
	 * once per analysis calculation, so the Recent Sessions tab can serve any period from
	 * memory instead of re-parsing the whole session corpus on every period switch.
	 */
	private buildRecentSessionBuckets(
		results: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		now: Date
	): { last7: TodaySessionSummary[]; last30: TodaySessionSummary[]; currentMonth: TodaySessionSummary[] } {
		return bucketRecentSessions(this.buildRecentSessionItems(results), now);
	}

	private buildRecentSessionBucket(
		results: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		startKey: string
	): TodaySessionSummary[] {
		return this.buildRecentSessionItems(results)
			.filter(it => it.activityKey >= startKey)
			.map(it => it.value);
	}

	/**
	 * Aggregate the two explicit automatic-compaction signals emitted by supported
	 * session formats without exposing them as regular tool calls.
	 */
	private buildAutoCompactionStats(
		results: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		now: Date,
	): NonNullable<UsageAnalysisStats['autoCompactionsLast7Days']> {
		const startKey = getTimeWindowStartDayKey('last7', now);
		const bySource = { copilotCli: 0, claude: 0 };
		for (const result of results) {
			if (!result || this.computeLastActivityKey(result.sessionData, result.mtime) < startKey) { continue; }
			bySource.copilotCli += result.sessionData.truncationCount ?? 0;
			bySource.claude += result.sessionData.usageAnalysis?.toolCalls.byTool['__auto_compact__'] ?? 0;
		}
		return { total: bySource.copilotCli + bySource.claude, bySource };
	}

	private buildRecentSessionItems(
		results: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[]
	): { activityKey: string; interactions: number; value: TodaySessionSummary }[] {
		const items: { activityKey: string; interactions: number; value: TodaySessionSummary }[] = [];
		for (const r of results) {
			if (!r || r.sessionData.interactions === 0) { continue; }
			const analysis = r.sessionData.usageAnalysis || this.buildDefaultSessionAnalysis();
			const value = this.collectTodaySessionInfo(r.sessionData, r.sessionFile, analysis, r.sessionData.interactions, r.mtime);
			items.push({ activityKey: this.computeLastActivityKey(r.sessionData, r.mtime), interactions: r.sessionData.interactions, value });
		}
		items.sort((a, b) => b.interactions - a.interactions);
		return items;
	}

	private computeLastActivityKey(sessionData: SessionFileCache, mtime: number): string {
		if (sessionData.dailyRollups && Object.keys(sessionData.dailyRollups).length > 0) {
			return Object.keys(sessionData.dailyRollups).sort().pop()!;
		}
		const lastActivity = sessionData.lastInteraction ? new Date(sessionData.lastInteraction) : new Date(mtime);
		return toLocalDayKey(lastActivity);
	}

	/** Maximum number of sessions with detected correction moments listed per repository. */
	private static readonly CORRECTION_SCAN_SESSIONS_PER_REPO = 25;

	/**
	 * Build the correction-moment report from already-parsed session results:
	 * sessions are first filtered to those carrying detected correction moments,
	 * then the 25 most recent of those are kept per repository.
	 * Moments come from the cached per-session usage analysis, so this is a
	 * pure in-memory regrouping — no extra parsing. Returns undefined when no
	 * session carried any moments.
	 */
	private buildCorrectionReport(
		results: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[]
	): CorrectionReport | undefined {
		const byRepo = new Map<string, { sessionFile: string; sessionData: SessionFileCache; mtime: number }[]>();
		for (const r of results) {
			const moments = r?.sessionData.usageAnalysis?.correctionMoments;
			if (!r || !moments || moments.length === 0) { continue; }
			const repo = _repoDisplayName(r.sessionData.repository || '(unknown)');
			if (!byRepo.has(repo)) { byRepo.set(repo, []); }
			byRepo.get(repo)!.push(r);
		}
		if (byRepo.size === 0) { return undefined; }

		const repos: CorrectionRepoGroup[] = [];
		const totals = _createEmptyCorrectionCounts();
		let sessionsWithMoments = 0;
		for (const [repository, entries] of [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			entries.sort((a, b) => b.mtime - a.mtime);
			const selectedEntries = entries.slice(0, CopilotTokenTracker.CORRECTION_SCAN_SESSIONS_PER_REPO);
			const sessions: CorrectionSessionEntry[] = selectedEntries
				.map(e => ({
					file: e.sessionFile,
					title: e.sessionData.title ?? null,
					lastInteraction: e.sessionData.lastInteraction ?? null,
					moments: e.sessionData.usageAnalysis!.correctionMoments!,
					totalMoments: this.correctionMomentCount(
						e.sessionData.usageAnalysis!.correctionCounts
							?? _summarizeCorrectionMoments(e.sessionData.usageAnalysis!.correctionMoments!)
					),
				}));
			const counts = _createEmptyCorrectionCounts();
			for (const entry of selectedEntries) {
				const analysis = entry.sessionData.usageAnalysis!;
				_mergeCorrectionCounts(counts, analysis.correctionCounts ?? _summarizeCorrectionMoments(analysis.correctionMoments!));
			}
			_mergeCorrectionCounts(totals, counts);
			sessionsWithMoments += sessions.length;
			repos.push({ repository, sessions, counts, sessionsWithMoments: sessions.length });
		}
		return { sessionsPerRepo: CopilotTokenTracker.CORRECTION_SCAN_SESSIONS_PER_REPO, repos, counts: totals, sessionsWithMoments };
	}

	private correctionMomentCount(counts: CorrectionCounts): number {
		return counts.userCorrections + counts.editRetries + counts.editSelfCorrections
			+ counts.toolErrors + counts.agentSelfCorrections;
	}

	/**
	 * Build the repeated-task report from already-parsed session results:
	 * cluster the first user prompt of every scanned session (across all
	 * repositories) into tasks the user keeps prompting for manually —
	 * candidates for a reusable skill or prompt file. Pure in-memory
	 * clustering over cached prompts; returns undefined when no cluster
	 * reaches the minimum size.
	 */
	private buildRepeatedTaskReport(
		results: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[]
	): RepeatedTaskReport | undefined {
		return _buildRepeatedTaskReport(results
			.filter((r): r is NonNullable<typeof r> => !!r)
			.map(r => ({
				file: r.sessionFile,
				firstUserPrompt: r.sessionData.usageAnalysis?.firstUserPrompt,
				title: r.sessionData.title,
				lastInteraction: r.sessionData.lastInteraction,
				mtime: r.mtime,
				repository: r.sessionData.repository,
			})));
	}

	private _resolveSessionModelTokens(sessionData: SessionFileCache, modelUsage: ModelUsage): { inputTok: number; outputTok: number; cachedTok: number } {
		let inputTok = 0, outputTok = 0, cachedTok = 0;
		for (const usage of Object.values(modelUsage)) {
			inputTok += usage.inputTokens || 0;
			outputTok += usage.outputTokens || 0;
			cachedTok += usage.cachedReadTokens || 0;
		}
		if (sessionData.debugLogInputTokens !== undefined) { inputTok = sessionData.debugLogInputTokens; }
		if (sessionData.debugLogOutputTokens !== undefined) { outputTok = sessionData.debugLogOutputTokens; }
		if (sessionData.cacheReadTokens !== undefined) { cachedTok = sessionData.cacheReadTokens; }
		return { inputTok, outputTok, cachedTok };
	}

	private collectTodaySessionInfo(
		sessionData: SessionFileCache, sessionFile: string,
		analysis: SessionUsageAnalysis, interactions: number, mtime: number
	): TodaySessionSummary {
		const modelUsage = sessionData.modelUsage || {};
		const { inputTok, outputTok, cachedTok } = this._resolveSessionModelTokens(sessionData, modelUsage);
		// Wall-clock duration (includes idle gaps between turns) — kept for reference/future use.
		const durationMs = computeSessionDurationMs(sessionData.firstInteraction, sessionData.lastInteraction);
		// Net/active duration (excludes idle gaps between turns) — this is what's shown as "Duration".
		// Only meaningful for formats with per-request timing data (e.g. VS Code Chat); other
		// formats (e.g. Copilot CLI JSONL) report 0 here, which must not shadow the wall-clock
		// duration below, or every such session would misleadingly show up as "<1m".
		const rawActiveDurationMs = analysis.sessionDuration?.activeDurationMs;
		const activeDurationMs = rawActiveDurationMs !== undefined && rawActiveDurationMs > 0 ? rawActiveDurationMs : undefined;
		const workspace = this.resolveSessionWorkspaceName(sessionData, sessionFile);
		return {
			title: sessionData.title || null, filePath: sessionFile, interactions,
			toolCalls: analysis.toolCalls.total, inputTokens: inputTok, outputTokens: outputTok,
			thinkingTokens: sessionData.thinkingTokens || 0, cachedTokens: cachedTok,
			totalTokens: computeSessionTotalTokens(inputTok, outputTok, sessionData.thinkingTokens || 0),
			estimatedCost: sessionData.copilotExactCostDollars ?? this.calculateEstimatedCost(modelUsage),
			editor: this.detectEditorSource(sessionFile), models: collectSessionModelIds(modelUsage, analysis?.modelEfficiency),
			lastActivity: sessionData.lastInteraction || new Date(mtime).toISOString(),
			...(sessionData.truncationCount ? { truncationCount: sessionData.truncationCount } : {}),
			...(sessionData.maxRequestInputTokens ? { maxRequestInputTokens: sessionData.maxRequestInputTokens } : {}),
			...(sessionData.contextTier ? { contextTier: sessionData.contextTier } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
			...(activeDurationMs !== undefined ? { activeDurationMs } : {}),
			...(workspace ? { workspace } : {}),
			...(sessionData.subAgentCalls ? { subAgentCalls: sessionData.subAgentCalls } : {}),
		};
	}

	/**
	 * Best-effort workspace name for a session summary. Prefers the workspace
	 * folder path already cached on the session data, then the repository name,
	 * then workspaceStorage folder resolution. Returns undefined when
	 * attribution is unavailable.
	 */
	private resolveSessionWorkspaceName(sessionData: SessionFileCache, sessionFile: string): string | undefined {
		return _resolveSessionWorkspaceName(sessionData, sessionFile, this._workspaceIdToFolderCache);
	}

	/**
	 * Asks for a workspace's customization files to be in `_customizationFilesCache` by the next
	 * `resolvePendingCustomizationScans()`. It does not scan: the discovery is a recursive
	 * synchronous directory walk that took over a minute across a real set of workspaces, and
	 * this is called from the synchronous per-session aggregation loop on the host's only thread.
	 */
	private ensureWorkspaceCustomizationCached(norm: string): void {
		if (this._customizationFilesCache.has(norm)) { return; }
		this._pendingCustomizationScans.add(norm);
	}

	/**
	 * Runs the scans queued by `ensureWorkspaceCustomizationCached()` — on the worker threads, in
	 * parallel — and fills the cache. Must be awaited before anything reads
	 * `_customizationFilesCache`. A scan that fails leaves its workspace uncached, which readers
	 * already treat as "no customization files", exactly like a failed synchronous scan did.
	 */
	private async resolvePendingCustomizationScans(): Promise<void> {
		if (this._pendingCustomizationScans.size === 0) { return; }
		const workspaces = [...this._pendingCustomizationScans].filter((norm) => !this._customizationFilesCache.has(norm));
		this._pendingCustomizationScans.clear();
		const generation = this._cacheGeneration;
		await Promise.all(workspaces.map(async (norm) => {
			let files: CustomizationFileEntry[] | undefined;
			try {
				files = await this.runOffHostThread(
					(pool) => pool.scanCustomizationFiles(norm),
					async () => { await yieldToEventLoop(); return _scanCustomizationFilesForWorkspace(norm); },
				);
			} catch { /* ignore scan errors per workspace */ }
			// A cache clear while this scan was away makes its answer stale; drop it. The workspace then stays
			// uncached until the next run clears and rebuilds the cache, which is fine: the run that asked for it
			// is itself being discarded as stale (see isRefreshSuperseded).
			if (files && generation === this._cacheGeneration && !this._customizationFilesCache.has(norm)) {
				this._customizationFilesCache.set(norm, files);
			}
		}));
	}

	private trackWorkspaceForSession(
		sessionFile: string, interactions: number,
		sessionCounts: Map<string, number>, interactionCounts: Map<string, number>,
		unresolvedIds: Set<string>, unresolvedCounts: Map<string, number>,
		fallbackWorkspacePath?: string
	): void {
		const workspaceId = _extractWorkspaceIdFromSessionPath(sessionFile);
		try {
			// Prefer VS Code's workspaceStorage-based resolution (covers Copilot Chat sessions).
			// Non-VS Code editors (Copilot CLI, JetBrains, Claude Code, etc.) don't live under a
			// "workspaceStorage" folder, so fall back to the workspace/cwd path already resolved
			// onto sessionData (e.g. Copilot CLI's workspace.yaml `cwd` or session-store.db `cwd`)
			// so those workspaces still show up in the Copilot Customization Files health matrix.
			const workspaceFolder = _resolveWorkspaceFolderWithFallback(sessionFile, this._workspaceIdToFolderCache, fallbackWorkspacePath);
			if (workspaceFolder) {
				const norm = path.normalize(workspaceFolder);
				sessionCounts.set(norm, (sessionCounts.get(norm) || 0) + 1);
				interactionCounts.set(norm, (interactionCounts.get(norm) || 0) + interactions);
				this.ensureWorkspaceCustomizationCached(norm);
			} else if (workspaceId) {
				unresolvedIds.add(workspaceId);
				unresolvedCounts.set(workspaceId, (unresolvedCounts.get(workspaceId) || 0) + interactions);
			}
		} catch (e) {
			if (workspaceId) {
				unresolvedIds.add(workspaceId);
				unresolvedCounts.set(workspaceId, (unresolvedCounts.get(workspaceId) || 0) + interactions);
			}
		}
	}

	/** Increments `period.delegationSessions` when the session was classified as `Delegation` (see `taskClassification.ts`). */
	private _incrementDelegationSessions(period: UsageAnalysisPeriod, sessionData: SessionFileCache): void {
		if (sessionData.taskCategory !== 'Delegation') { return; }
		period.delegationSessions = (period.delegationSessions ?? 0) + 1;
	}

	/**
	 * Accumulate this session's skill invocations into `_skillCallsByEditorAccum`
	 * (skillName -> editorSource -> count), powering the Skill Usage tab's per-editor
	 * breakdown/filter. Only resolves editorSource when there's actually a skill call to
	 * attribute, since `detectEditorSource` does path-based work best skipped otherwise.
	 */
	private _accumulateSkillCallsByEditor(sessionFile: string, analysis: SessionUsageAnalysis, workspaceFolderPath?: string): void {
		const byName = analysis.skillCalls?.byName;
		if (!byName) { return; }
		const entries = Object.entries(byName);
		if (entries.length === 0) { return; }
		const editorSource = this.detectEditorSource(sessionFile);
		for (const [skillName, count] of entries) {
			let byEditor = this._skillCallsByEditorAccum.get(skillName);
			if (!byEditor) { byEditor = new Map(); this._skillCallsByEditorAccum.set(skillName, byEditor); }
			byEditor.set(editorSource, (byEditor.get(editorSource) || 0) + count);
			if (workspaceFolderPath) {
				let paths = this._skillWorkspacePathsAccum.get(skillName);
				if (!paths) { paths = new Set(); this._skillWorkspacePathsAccum.set(skillName, paths); }
				paths.add(workspaceFolderPath);
			}
		}
	}

	/** Plain-object snapshot of `_toolCallsByEditorAccum` for the stats payload. */
	private _buildToolCallsByEditor(): Record<string, Record<string, number>> {
		return toolCallsByEditorToRecord(this._toolCallsByEditorAccum);
	}

	/**
	 * Accumulate this session's tool calls (general tools, MCP tools and MCP servers) into
	 * `_toolCallsByEditorAccum` (toolName -> editorSource -> count).
	 */
	private _accumulateToolCallsByEditor(sessionFile: string, analysis: SessionUsageAnalysis): void {
		const sources = [analysis.toolCalls.byTool, analysis.mcpTools.byTool, analysis.mcpTools.byServer];
		if (sources.every(s => Object.keys(s).length === 0)) { return; }
		const editorSource = this.detectEditorSource(sessionFile);
		// 'Unknown' means no editor could be identified; leave it out so reports fall back to the no-editor format.
		if (editorSource === 'Unknown') { return; }
		for (const source of sources) {
			for (const [name, count] of Object.entries(source)) {
				let byEditor = this._toolCallsByEditorAccum.get(name);
				if (!byEditor) { byEditor = new Map(); this._toolCallsByEditorAccum.set(name, byEditor); }
				byEditor.set(editorSource, (byEditor.get(editorSource) || 0) + count);
			}
		}
	}

	/**
	 * Skill name -> description, for the Skill Usage tab. Three tiers, in order:
	 * 1. `curationAnalysis.availableTools` (populated by `discoverSkillEntries()`, scoped to
	 *    the currently open workspace(s)).
	 * 2. For an invoked skill still missing a description — e.g. one invoked from a repo
	 *    that isn't open right now — a targeted lookup in that skill's own historical
	 *    workspace path(s) via `findSkillDescriptionInWorkspaces()`.
	 * 3. `builtinCommandDescriptions.json` — many "skills" invoked via a bare `/name` are
	 *    actually the CLI's own built-in commands (e.g. Copilot CLI's `/model`, `/login`),
	 *    baked into the binary with no SKILL.md anywhere to find. This static, hand-curated
	 *    list (sourced from Claude Code's and Copilot CLI's official docs) is the last resort.
	 */
	private _buildSkillDescriptions(): Record<string, string> {
		const descriptions: Record<string, string> = {};
		for (const t of this.currentUsageAnalysisStats?.curationAnalysis?.availableTools ?? []) {
			if (t.source === 'skill' && t.description) { descriptions[t.name] = t.description; }
		}
		const builtins = builtinCommandDescriptionsData as { [key: string]: string };
		for (const skillName of this._skillCallsByEditorAccum.keys()) {
			if (descriptions[skillName]) { continue; }
			const workspacePaths = this._skillWorkspacePathsAccum.get(skillName);
			const found = workspacePaths && workspacePaths.size > 0
				? _findSkillDescriptionInWorkspaces(skillName, workspacePaths)
				: undefined;
			if (found) { descriptions[skillName] = found; }
			else if (builtins[skillName]) { descriptions[skillName] = builtins[skillName]; }
		}
		return descriptions;
	}

	private aggregateSessionFileIntoStats(
		r: { sessionFile: string; sessionData: SessionFileCache; mtime: number },
		periods: { todayStats: UsageAnalysisPeriod; last30DaysStats: UsageAnalysisPeriod; monthStats: UsageAnalysisPeriod; lastMonthStats: UsageAnalysisPeriod; todayUtcKey: string; last30DaysUtcStartKey: string; monthUtcStartKey: string; lastMonthUtcStartKey: string; lastMonthUtcEndKey: string },
		wsMaps: { workspaceSessionCounts: Map<string, number>; workspaceInteractionCounts: Map<string, number>; unresolvedWorkspaceIds: Set<string>; unresolvedWorkspaceInteractionCounts: Map<string, number> },
		todaySessionsList: TodaySessionSummary[]
	): void {
		const { sessionFile, sessionData, mtime } = r;
		const interactions = sessionData.interactions;
		if (interactions === 0) { return; }
		const analysis = sessionData.usageAnalysis || this.buildDefaultSessionAnalysis();
		const lastActivityUtcKey = this.computeLastActivityKey(sessionData, mtime);
		const inLast30Days = lastActivityUtcKey >= periods.last30DaysUtcStartKey;
		const inLastMonth = lastActivityUtcKey >= periods.lastMonthUtcStartKey && lastActivityUtcKey <= periods.lastMonthUtcEndKey;
		// month-to-date is always a subset of last 30 days, so this guard also covers it.
		if (!inLast30Days && !inLastMonth) { return; }
		if (inLast30Days) {
			periods.last30DaysStats.sessions++;
			this.mergeUsageAnalysis(periods.last30DaysStats, analysis);
			this._mergeContextWindowStats(periods.last30DaysStats, sessionData);
			_mergeModelEfficiencyTokens(periods.last30DaysStats, sessionData.modelUsage, this.modelPricing);
			this._incrementDelegationSessions(periods.last30DaysStats, sessionData);
			this.trackWorkspaceForSession(sessionFile, interactions,
				wsMaps.workspaceSessionCounts, wsMaps.workspaceInteractionCounts,
				wsMaps.unresolvedWorkspaceIds, wsMaps.unresolvedWorkspaceInteractionCounts,
				sessionData.workspaceFolderPath);
			this._accumulateSkillCallsByEditor(sessionFile, analysis, sessionData.workspaceFolderPath);
			this._accumulateToolCallsByEditor(sessionFile, analysis);
		}
		if (lastActivityUtcKey >= periods.monthUtcStartKey) {
			periods.monthStats.sessions++;
			this.mergeUsageAnalysis(periods.monthStats, analysis);
			this._mergeContextWindowStats(periods.monthStats, sessionData);
			_mergeModelEfficiencyTokens(periods.monthStats, sessionData.modelUsage, this.modelPricing);
			this._incrementDelegationSessions(periods.monthStats, sessionData);
		}
		if (inLastMonth) {
			periods.lastMonthStats.sessions++;
			this.mergeUsageAnalysis(periods.lastMonthStats, analysis);
			this._mergeContextWindowStats(periods.lastMonthStats, sessionData);
			_mergeModelEfficiencyTokens(periods.lastMonthStats, sessionData.modelUsage, this.modelPricing);
			this._incrementDelegationSessions(periods.lastMonthStats, sessionData);
		}
		if (lastActivityUtcKey === periods.todayUtcKey) {
			periods.todayStats.sessions++;
			this.mergeUsageAnalysis(periods.todayStats, analysis);
			this._mergeContextWindowStats(periods.todayStats, sessionData);
			_mergeModelEfficiencyTokens(periods.todayStats, sessionData.modelUsage, this.modelPricing);
			this._incrementDelegationSessions(periods.todayStats, sessionData);
			todaySessionsList.push(this.collectTodaySessionInfo(sessionData, sessionFile, analysis, interactions, mtime));
		}
	}

	/** Get-or-create the contextWindow aggregate on a usage period. */
	private _ensureContextWindow(period: UsageAnalysisPeriod): NonNullable<UsageAnalysisPeriod['contextWindow']> {
		if (!period.contextWindow) {
			period.contextWindow = { maxRequestInputTokens: 0, maxRequestModels: [], tierCounts: {} };
		}
		return period.contextWindow;
	}

	/** Get-or-create the contextPressure aggregate on a usage period. */
	private _ensureContextPressure(period: UsageAnalysisPeriod): NonNullable<UsageAnalysisPeriod['contextPressure']> {
		return ensureContextPressure(period);
	}

	/** Automatic compaction/truncation events recorded for one session, across all formats. */
	private _sessionCompactionEvents(sessionData: SessionFileCache): number {
		return sessionCompactionEvents(sessionData);
	}

	/** True when a session carries any usable context-window or compaction signal. */
	private _hasContextSignal(sessionData: SessionFileCache): boolean {
		return hasContextSignal(sessionData);
	}

	/** Count one session towards a period's per-session context-exhaustion counters. */
	private _mergeContextPressure(period: UsageAnalysisPeriod, sessionData: SessionFileCache): void {
		mergeSessionContextPressure(period, sessionData);
	}

	/** Fold one session's context-window fields (from its cache entry) into a period aggregate. */
	private _mergeContextWindowStats(period: UsageAnalysisPeriod, sessionData: SessionFileCache): void {
		this._mergeContextPressure(period, sessionData);
		if (!sessionData.maxRequestInputTokens && !sessionData.contextTier) { return; }
		const cw = this._ensureContextWindow(period);
		if ((sessionData.maxRequestInputTokens ?? 0) > cw.maxRequestInputTokens) {
			cw.maxRequestInputTokens = sessionData.maxRequestInputTokens!;
			cw.maxRequestModels = Object.keys(sessionData.modelUsage || {});
		}
		if (sessionData.contextTier) {
			cw.tierCounts[sessionData.contextTier] = (cw.tierCounts[sessionData.contextTier] ?? 0) + 1;
		}
	}

	private aggregateUsageFileResults(
		usageResults: ({ sessionFile: string; sessionData: SessionFileCache; mtime: number } | null | undefined)[],
		periods: { todayStats: UsageAnalysisPeriod; last30DaysStats: UsageAnalysisPeriod; monthStats: UsageAnalysisPeriod; lastMonthStats: UsageAnalysisPeriod; todayUtcKey: string; last30DaysUtcStartKey: string; monthUtcStartKey: string; lastMonthUtcStartKey: string; lastMonthUtcEndKey: string },
		wsMaps: { workspaceSessionCounts: Map<string, number>; workspaceInteractionCounts: Map<string, number>; unresolvedWorkspaceIds: Set<string>; unresolvedWorkspaceInteractionCounts: Map<string, number> },
		todaySessionsList: TodaySessionSummary[], totalFiles: number
	): void {
		let processed = 0;
		const progressInterval = Math.max(1, Math.floor(totalFiles / 20));
		for (const r of usageResults) {
			try {
				if (r) { this.aggregateSessionFileIntoStats(r, periods, wsMaps, todaySessionsList); }
			} catch (fileError) {
				this.warn(`Error processing session file for usage analysis: ${fileError}`);
			}
			processed++;
			if (processed % progressInterval === 0) {
				this.log(`🔍 [Usage Analysis] Progress: ${processed}/${totalFiles} files (${Math.round(processed / totalFiles * 100)}%)`);
			}
		}
	}

	private mergeWorkspaceInto(
		winner: string, loser: string,
		sessionCounts: Map<string, number>, interactionCounts: Map<string, number>
	): void {
		sessionCounts.set(winner, (sessionCounts.get(winner) || 0) + (sessionCounts.get(loser) || 0));
		interactionCounts.set(winner, (interactionCounts.get(winner) || 0) + (interactionCounts.get(loser) || 0));
		sessionCounts.delete(loser);
		interactionCounts.delete(loser);
		const winnerFiles = this._customizationFilesCache.get(winner) || [];
		const loserFiles = this._customizationFilesCache.get(loser) || [];
		if (winnerFiles.length === 0 && loserFiles.length > 0) {
			this._customizationFilesCache.set(winner, loserFiles);
		}
		this._customizationFilesCache.delete(loser);
	}

	private deduplicateWorkspacesByCase(sessionCounts: Map<string, number>, interactionCounts: Map<string, number>): void {
		if (process.platform !== 'win32' && process.platform !== 'darwin') { return; }
		const isRemotePath = (p: string) => process.platform === 'win32' && _normalizePath(p).startsWith('/');
		const lowerToCanonical = new Map<string, string>();
		for (const key of Array.from(sessionCounts.keys())) {
			const lower = key.toLowerCase();
			if (!lowerToCanonical.has(lower)) { lowerToCanonical.set(lower, key); continue; }
			const canonical = lowerToCanonical.get(lower)!;
			const winner = _dwbcPickWinner(key, canonical, isRemotePath(key), isRemotePath(canonical), sessionCounts);
			this.mergeWorkspaceInto(winner, winner === key ? canonical : key, sessionCounts, interactionCounts);
			lowerToCanonical.set(lower, winner);
		}
	}

	private deduplicateRemoteWorkspacePaths(sessionCounts: Map<string, number>, interactionCounts: Map<string, number>): void {
		if (process.platform !== 'win32') { return; }
		const isRemotePath = (p: string) => _normalizePath(p).startsWith('/');
		const basenameToLocal = new Map<string, string>();
		for (const key of Array.from(sessionCounts.keys())) {
			if (!isRemotePath(key)) { basenameToLocal.set(path.basename(key).toLowerCase(), key); }
		}
		for (const key of Array.from(sessionCounts.keys())) {
			if (!isRemotePath(key)) { continue; }
			const localKey = basenameToLocal.get(path.basename(key).toLowerCase());
			if (localKey && sessionCounts.has(key)) {
				this.mergeWorkspaceInto(localKey, key, sessionCounts, interactionCounts);
			}
		}
	}

	private deduplicateCopilotWorktrees(sessionCounts: Map<string, number>, interactionCounts: Map<string, number>): void {
		const worktreeToCanonical = new Map<string, string>();
		for (const key of Array.from(sessionCounts.keys())) {
			const segments = key.split(path.sep);
			const wtIdx = segments.map(s => s.toLowerCase()).lastIndexOf('copilot-worktrees');
			if (wtIdx === -1 || wtIdx + 2 >= segments.length) { continue; }
			const repoName = segments[wtIdx + 1];
			const reposPath = path.normalize(segments.slice(0, wtIdx).concat('repos', repoName).join(path.sep));
			const canonical = fs.existsSync(reposPath) ? reposPath : path.normalize(segments.slice(0, wtIdx + 2).join(path.sep));
			worktreeToCanonical.set(key, canonical);
		}
		const canonicals = new Set(worktreeToCanonical.values());
		for (const canonical of canonicals) {
			if (!sessionCounts.has(canonical)) { sessionCounts.set(canonical, 0); interactionCounts.set(canonical, 0); }
			for (const [worktree, canon] of worktreeToCanonical) {
				if (canon === canonical && worktree !== canonical && sessionCounts.has(worktree)) {
					this.mergeWorkspaceInto(canonical, worktree, sessionCounts, interactionCounts);
				}
			}
			this.ensureWorkspaceCustomizationCached(canonical);
		}
	}

	/**
	 * Dedup compares the customization files of the workspaces it merges, and may name new
	 * canonical workspaces of its own, so the queued scans are resolved on both sides of it.
	 */
	private async deduplicateWorkspacePathsWithScans(sessionCounts: Map<string, number>, interactionCounts: Map<string, number>): Promise<void> {
		await this.resolvePendingCustomizationScans();
		this.deduplicateWorkspacePaths(sessionCounts, interactionCounts);
		await this.resolvePendingCustomizationScans();
	}

	private deduplicateWorkspacePaths(sessionCounts: Map<string, number>, interactionCounts: Map<string, number>): void {
		this.deduplicateWorkspacesByCase(sessionCounts, interactionCounts);
		this.deduplicateRemoteWorkspacePaths(sessionCounts, interactionCounts);
		this.deduplicateCopilotWorktrees(sessionCounts, interactionCounts);
		this.deduplicateByBasename(sessionCounts, interactionCounts);
	}

	/**
	 * Pass 4 — same-basename dedup for local paths.
	 * A repo cloned at two different locations (e.g. ~/.copilot/repos/my-repo AND
	 * ~/source/my-repo) will have the same basename but different absolute paths.
	 * Merge them into one entry; the path with more interactions wins so the richer
	 * customization file scan is kept.
	 */
	private deduplicateByBasename(sessionCounts: Map<string, number>, interactionCounts: Map<string, number>): void {
		const isRemotePath = (p: string) => process.platform === 'win32' && _normalizePath(p).startsWith('/');
		// Group all non-remote, non-unresolved paths by lower-case basename
		const basenameToKeys = new Map<string, string[]>();
		for (const key of Array.from(sessionCounts.keys())) {
			if (isRemotePath(key) || key.startsWith('<unresolved:')) { continue; }
			const base = path.basename(key).toLowerCase();
			const group = basenameToKeys.get(base) || [];
			group.push(key);
			basenameToKeys.set(base, group);
		}
		for (const [, group] of basenameToKeys) {
			if (group.length < 2) { continue; }
			// Pick winner: most interactions; on tie, most sessions; on tie, first entry
			const winner = group.reduce((best, key) => {
				const bestScore = (interactionCounts.get(best) || 0) * 10000 + (sessionCounts.get(best) || 0);
				const keyScore = (interactionCounts.get(key) || 0) * 10000 + (sessionCounts.get(key) || 0);
				return keyScore > bestScore ? key : best;
			});
			for (const key of group) {
				if (key !== winner && sessionCounts.has(key)) {
					this.mergeWorkspaceInto(winner, key, sessionCounts, interactionCounts);
				}
			}
		}
	}

	private buildResolvedWorkspaceMatrixRows(
		sessionCounts: Map<string, number>, interactionCounts: Map<string, number>,
		customizationTypes: { id: string; icon: string; label: string }[]
	): { rows: WorkspaceCustomizationRow[]; issues: number } {
		const rows: WorkspaceCustomizationRow[] = [];
		let issues = 0;
		for (const [folderPath, sessionCount] of sessionCounts) {
			const files = this._customizationFilesCache.get(folderPath) || [];
			const typeStatuses: { [typeId: string]: CustomizationTypeStatus } = {};
			for (const type of customizationTypes) {
				const filesOfType = files.filter(f => f.type === type.id);
				if (filesOfType.length === 0) { typeStatuses[type.id] = '❌'; }
				else if (filesOfType.some(f => f.isStale)) { typeStatuses[type.id] = '⚠️'; }
				else { typeStatuses[type.id] = '✅'; }
			}
			if (customizationTypes.every(t => typeStatuses[t.id] === '❌')) { issues++; }
			rows.push({ workspacePath: folderPath, workspaceName: path.basename(folderPath), sessionCount, interactionCount: interactionCounts.get(folderPath) || 0, typeStatuses });
		}
		return { rows, issues };
	}

	private buildUnresolvedWorkspaceMatrixRows(
		unresolvedIds: Set<string>, unresolvedCounts: Map<string, number>,
		customizationTypes: { id: string; icon: string; label: string }[]
	): { rows: WorkspaceCustomizationRow[]; issues: number } {
		const rows: WorkspaceCustomizationRow[] = [];
		let issues = 0;
		for (const workspaceId of unresolvedIds) {
			const typeStatuses: { [typeId: string]: CustomizationTypeStatus } = {};
			for (const type of customizationTypes) { typeStatuses[type.id] = '❌'; }
			issues++;
			const displayId = workspaceId.length > CopilotTokenTracker.WORKSPACE_ID_DISPLAY_LENGTH
				? `${workspaceId.substring(0, CopilotTokenTracker.WORKSPACE_ID_DISPLAY_LENGTH)}...`
				: workspaceId;
			rows.push({
				workspacePath: `<unresolved:${workspaceId}>`, workspaceName: `Unresolved (${displayId})`,
				sessionCount: 0, interactionCount: unresolvedCounts.get(workspaceId) || 0, typeStatuses
			});
		}
		return { rows, issues };
	}

	private buildUsageCustomizationMatrix(
		sessionCounts: Map<string, number>, interactionCounts: Map<string, number>,
		unresolvedIds: Set<string>, unresolvedCounts: Map<string, number>
	): void {
		try {
			const uniqueTypes = new Map<string, { icon: string; label: string }>();
			for (const pattern of (customizationPatternsData as any).patterns || []) {
				if (pattern.category && pattern.category !== 'copilot') { continue; }
				if (!uniqueTypes.has(pattern.type)) {
					uniqueTypes.set(pattern.type, { icon: pattern.icon || '', label: pattern.label || pattern.type });
				}
			}
			const customizationTypes = Array.from(uniqueTypes.entries()).map(([id, v]) => ({ id, icon: v.icon, label: v.label }));
			const { rows: resolvedRows, issues: resolvedIssues } = this.buildResolvedWorkspaceMatrixRows(sessionCounts, interactionCounts, customizationTypes);
			const { rows: unresolvedRows, issues: unresolvedIssues } = this.buildUnresolvedWorkspaceMatrixRows(unresolvedIds, unresolvedCounts, customizationTypes);
			const matrixRows = [...resolvedRows, ...unresolvedRows];
			matrixRows.sort((a, b) => b.interactionCount !== a.interactionCount ? b.interactionCount - a.interactionCount : b.sessionCount - a.sessionCount);
			this._lastCustomizationMatrix = { customizationTypes, workspaces: matrixRows, totalWorkspaces: matrixRows.length, workspacesWithIssues: resolvedIssues + unresolvedIssues };
			this._lastMissedPotential = this.detectMissedPotential(sessionCounts, interactionCounts);
		} catch (e) { /* ignore overall customization scanning errors */ }
	}

	/**
	 * Merge usage analysis data into period stats
	 */
	private mergeUsageAnalysis(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
		return _mergeUsageAnalysis(period, analysis);
	}




	/**
	 * Analyze a session file for usage patterns (tool calls, modes, context references, MCP tools)
	 */

	/**
	 * Calculate model switching statistics for a session file.
	 * This method updates the analysis.modelSwitching field in place.
	 */

	/**
	 * Check if a tool name indicates it's an MCP (Model Context Protocol) tool.
	 * MCP tools are identified by names starting with "mcp." or "mcp_"
	 */
	private isMcpTool(toolName: string): boolean {
		return _isMcpTool(toolName);
	}

	/**
	 * Normalize an MCP tool name so that equivalent tools from different servers
	 * (local stdio vs remote) are counted under a single canonical key in "By Tool" views.
	 * Maps mcp_github_github_<action> → mcp_io_github_git_<action>.
	 */

	/**
	 * Extract server name from an MCP tool name.
	 * MCP tool names follow the format: mcp.server.tool or mcp_server_tool
	 * For example: "mcp.io.github.git.assign_copilot_to_issue" → "GitHub MCP"
	 * Uses the display name from toolNames.json (the part before the colon).
	 * Falls back to extracting the second segment if no mapping exists.
	 */
	private extractMcpServerName(toolName: string): string {
		return _extractMcpServerName(toolName, this.toolNameMap);
	}

	/**
	 * Derive conversation patterns from already-computed mode usage.
	 * Called before every return in analyzeSessionUsage to ensure all file formats get patterns.
	 */

	/**
	 * Track enhanced metrics from session files:
	 * - Edit scope (single vs multi-file edits)
	 * - Apply button usage (codeblockUri with isEdit flag)
	 * - Session duration data
	 * - Conversation patterns (multi-turn sessions)
	 * - Agent type usage
	 */

	/**
	 * Analyze a request object for all context references.
	 * This is the unified method that processes text, contentReferences, and variableData.
	 */
	private analyzeRequestContext(request: any, refs: ContextReferenceUsage): void {
		return _analyzeRequestContext(request, refs);
	}

	/**
	 * Analyze text for context references like #file, #selection, @workspace
	 */
	private analyzeContextReferences(text: string, refs: ContextReferenceUsage): void {
		return _analyzeContextReferences(text, refs);
	}

	/**
	 * Analyze contentReferences from session log data to track specific file attachments.
	 * Looks for kind: "reference" entries and tracks by kind, path patterns.
	 * Also increments specific category counters like refs.file when appropriate.
	 */

	/**
	 * Analyze variableData to track prompt file attachments and other variable-based context.
	 * This captures automatic attachments like copilot-instructions.md via variable system.
	 */

































	// Cached versions of session file reading methods
	public async getSessionFileDataCached(sessionFilePath: string, mtime: number, fileSize: number): Promise<SessionFileCache> {
		const cached = this.getCachedSessionData(sessionFilePath);
		if (isFullCacheHit(cached, mtime, fileSize)) {
			if (cached.debugLogInputTokens === undefined && !cached.debugLogChecked) {
				const supplemented = await this.supplementCachedSessionWithDebugLog(cached, sessionFilePath, fileSize);
				if (supplemented) { return supplemented; }
			}
			this._cacheHits++;
			return cached;
		}

		this._cacheMisses++;
		const sessionData = await this.analyzeSessionFileOffHostThread(sessionFilePath, mtime, fileSize, cached);
		// Re-read: a concurrent details parse may have written a placeholder while we analyzed.
		const toStore = resolveFullResultAgainstCurrent(sessionData, this.getCachedSessionData(sessionFilePath));
		this.setCachedSessionData(sessionFilePath, toStore, fileSize);
		return toStore;
	}

	/**
	 * Parses a session file into a fresh cache entry. Windsurf's virtual sessions come from a
	 * host-only gRPC client, so they stay in-process; everything else goes to a worker thread.
	 */
	/**
	 * What this window's discovery learned about a Copilot CLI session (Scout / desktop app). The workers never run
	 * discovery, so it travels with the request; see CopilotCliSessionKind.
	 */
	private copilotCliKindsFor(sessionFile: string): Array<'scout' | 'app'> {
		const adapter = this.ecosystems.find((eco) => eco.id === 'copilotcli') as CopilotCliAdapter | undefined;
		return adapter?.getSessionKinds?.(sessionFile) ?? [];
	}

	private analyzeSessionFileOffHostThread(sessionFilePath: string, mtime: number, fileSize: number, previous: SessionFileCache | undefined): Promise<SessionFileCache> {
		const inProcess = () => _analyzeSessionFile(this.analyzerDeps, sessionFilePath, mtime, fileSize, previous);
		if (this.windsurf.isWindsurfSessionFile(sessionFilePath)) { return inProcess(); }
		const kinds = this.copilotCliKindsFor(sessionFilePath);
		return this.runOffHostThread((pool) => pool.analyze(sessionFilePath, mtime, fileSize, previous?.repository, kinds), inProcess);
	}

	private async supplementCachedSessionWithDebugLog(cached: SessionFileCache, sessionFilePath: string, fileSize: number): Promise<SessionFileCache | null> {
		const supplemented = await this.runOffHostThread(
			(pool) => pool.supplement(cached, sessionFilePath),
			() => _supplementCacheWithDebugLog(cached, sessionFilePath),
		);
		if (!supplemented) {
			// No usable debug log: remember that so the lookup is not repeated for this entry.
			this.setCachedSessionData(sessionFilePath, { ...cached, debugLogChecked: true as const }, fileSize);
			this._cacheHits++;
			return null;
		}
		this.setCachedSessionData(sessionFilePath, supplemented, fileSize);
		this._cacheHits++;
		return supplemented;
	}

	/** Interaction count + token estimate for content the caller already read; parsed off the host thread. */
	private quickAnalyzeSessionContent(sessionFile: string, content: string, mtimeMs: number, size: number) {
		return this.runOffHostThread(
			(pool) => pool.quickAnalyze(sessionFile, content, mtimeMs, size),
			() => _quickAnalyzeSessionContent(this.analyzerDeps, sessionFile, content),
		);
	}

	private async getUsageAnalysisFromSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<SessionUsageAnalysis> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		const analysis = sessionData.usageAnalysis || this.buildDefaultSessionAnalysis();

		// Ensure modelSwitching field exists for backward compatibility with old cache
		if (!analysis.modelSwitching) {
			analysis.modelSwitching = {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				autoSessions: 0,
				foundryWindowsSessions: 0,
				unknownProviderSessions: 0,
				selectedModelExtensions: [],
				unknownProviderModels: [],
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0,
				costBuckets: { low: [], medium: [], high: [], unknown: [] },
				hasMixedCosts: false,
				lowCostRequests: 0,
				mediumCostRequests: 0,
				highCostRequests: 0
			};
		} else {
			analysis.modelSwitching.costBuckets ??= { low: [], medium: [], high: [], unknown: [] };
			analysis.modelSwitching.hasMixedCosts ??= false;
			analysis.modelSwitching.lowCostRequests ??= 0;
			analysis.modelSwitching.mediumCostRequests ??= 0;
			analysis.modelSwitching.highCostRequests ??= 0;
			analysis.modelSwitching.autoSessions ??= 0;
			analysis.modelSwitching.foundryWindowsSessions ??= 0;
			analysis.modelSwitching.unknownProviderSessions ??= 0;
			analysis.modelSwitching.selectedModelExtensions ??= [];
			analysis.modelSwitching.unknownProviderModels ??= [];
		}
		if (!analysis.taskClassification) { analysis.taskClassification = createEmptyTaskClassificationResult(); }

		return analysis;
	}

	/**
	 * Add editor root and name information to session file details.
	 * Enriches the details object with editorRoot and editorName properties.
	 * When an adapter provides a session-specific name (e.g. "MS Scout (Copilot CLI)"
	 * instead of "Copilot CLI"), editorSource is also updated so diagnostics tiles
	 * and chart views group Scout sessions separately.
	 */
	private enrichDetailsWithEditorInfo(sessionFile: string, details: SessionFileDetails): void {
		const eco = this.findEcosystem(sessionFile);
		if (eco) {
			details.editorRoot = eco.getEditorRoot(sessionFile);
			const specificName = getEcosystemDisplayName(eco, sessionFile);
			details.editorName = specificName;
			// When the adapter returns a more specific name than its static displayName,
			// propagate it to editorSource so tiles and charts group correctly.
			if (specificName !== eco.displayName) {
				details.editorSource = specificName;
			}
			return;
		}
		// File not handled by any adapter — check if a discoverable adapter labels it
		// (e.g. events.jsonl files discovered by CopilotCliAdapter for Scout sessions).
		const discoveredLabel = this._resolveEditorLabel(sessionFile);
		if (discoveredLabel) {
			details.editorName = discoveredLabel;
			details.editorSource = discoveredLabel;
			return;
		}
		if (this.windsurf.isWindsurfSessionFile(sessionFile)) {
			details.editorName = this.windsurf.getFamilyEditorName(sessionFile);
			return;
		}
		try {
			const parts = sessionFile.split(/[/\\]/);
			const userIdx = parts.findIndex(p => p.toLowerCase() === 'user');
			if (userIdx > 0) {
				details.editorRoot = parts.slice(0, userIdx).join(require('path').sep);
			} else {
				details.editorRoot = require('path').dirname(sessionFile);
			}
			details.editorName = this.getEditorNameFromRoot(details.editorRoot || '');
		} catch (e) {
			details.editorRoot = require('path').dirname(sessionFile);
			details.editorName = this.getEditorNameFromRoot(details.editorRoot || '');
		}
	}

	/**
	 * Reconstruct SessionFileDetails from cached data without reading the file.
	 * Returns undefined if cache is not valid or doesn't have all required data.
	 */
	private async getSessionFileDetailsFromCache(sessionFile: string, stat: fs.Stats): Promise<SessionFileDetails | undefined> {
		const cached = this.getCachedSessionData(sessionFile);

		// Validate cache against file stats
		if (!cached || cached.mtime !== stat.mtime.getTime() || cached.size !== stat.size) {
			return undefined;
		}

		// Check if cache has the required fields (for backward compatibility with old cache)
		if (!cached.usageAnalysis?.contextReferences || typeof cached.interactions !== 'number' || cached.interactions < 0) {
			return undefined;
		}

		// Cache entries written before repository extraction was attempted need one full
		// re-parse to backfill the field. Key this off `repositoryResolved`, NOT off
		// `repository === undefined` — the latter is also the correct, permanent value for
		// sessions that genuinely have no resolvable repository, and treating it as "needs
		// reparse" forced a full re-parse (including costly JSONL delta reconstruction and
		// ecosystem adapter calls) on every single Diagnostics reload, forever, for any
		// repo-less .jsonl session.
		if (sessionFile.endsWith('.jsonl') && !cached.repositoryResolved) {
			return undefined;
		}

		// Use the cached lastInteraction from session content directly.
		// Do NOT fall back to file mtime here: mtime is updated whenever VS Code writes the
		// session file (e.g. finalising a session just after midnight), which would shift
		// yesterday's sessions into "today". Only use mtime when no content timestamp exists.
		const lastInteraction: string | null = cached.lastInteraction || stat.mtime.toISOString();

		// Reconstruct SessionFileDetails from cache.
		// Prefer actualTokens (real API count) when available; fall back to estimated tokens.
		const details: SessionFileDetails = {
			file: sessionFile,
			size: cached.size || stat.size,
			modified: stat.mtime.toISOString(),
			interactions: cached.interactions,
			tokens: cached.actualTokens || cached.tokens || 0,
			contextReferences: cached.usageAnalysis.contextReferences,
			firstInteraction: cached.firstInteraction || null,
			lastInteraction: lastInteraction,
			editorSource: this.detectEditorSource(sessionFile),
			title: cached.title,
			repository: cached.repository,
			workspacePath: cached.workspaceFolderPath,
			subAgentCalls: cached.subAgentCalls,
			...(cached.modelUsage && Object.keys(cached.modelUsage).length > 0 ? { modelUsage: cached.modelUsage } : {}),
		};

		// Add editor root and name
		this.enrichDetailsWithEditorInfo(sessionFile, details);

		return details;
	}

	/**
	 * Update or create cache entry with session file details.
	 * Merges new detail fields with existing cached data if available.
	 * @param tokenResult - Fresh token data from eco.getTokens(); when provided, takes
	 *   precedence over any cached token values so eco-session diagnostics always show
	 *   the correct (actual-API) count rather than a stale or zero value.
	 * @param modelUsage - Fresh per-model usage data (from eco.getModelUsage() or the
	 *   shared getModelUsageFromSession()); when provided, takes precedence over any
	 *   cached value. Without this, per-model attribution silently stayed empty forever
	 *   for any session never separately touched by the Usage/Charts analysis pipeline
	 *   (the only other code path that computes it) — this is what caused the Model
	 *   Usage diagnostics tab to show data for only a handful of editors.
	 */
	/** Resolve the sub-agent call count for a cache update: fresh count from just-parsed details, else the previously cached value. */
	private resolveSubAgentCallsForCacheUpdate(details: SessionFileDetails, existingCache: SessionFileCache | undefined): number {
		return details.toolCalls ? countDelegationToolCalls(details.toolCalls.byTool) : (existingCache?.subAgentCalls ?? 0);
	}

	private async updateCacheWithSessionDetails(
		sessionFile: string,
		stat: fs.Stats,
		details: SessionFileDetails,
		tokenResult?: { tokens: number; thinkingTokens: number; actualTokens: number },
		modelUsage?: ModelUsage
	): Promise<void> {
		// Only inherit from an entry that still matches the file: a stale full entry would otherwise
		// be re-stamped with the new mtime/size (unmarked) and then served as a fresh hit.
		const cachedEntry = this.getCachedSessionData(sessionFile);
		const existingCache = cachedEntry && cachedEntry.mtime === stat.mtime.getTime() && cachedEntry.size === stat.size ? cachedEntry : undefined;
		const resolved = this.resolveTokensForCacheUpdate(tokenResult, existingCache);
		details.tokens = resolved.actualTokens || resolved.tokens || 0;
		const resolvedModelUsage = modelUsage && Object.keys(modelUsage).length > 0 ? modelUsage : (existingCache?.modelUsage || {});
		if (Object.keys(resolvedModelUsage).length > 0) { details.modelUsage = resolvedModelUsage; }
		// Prefer a fresh count from the just-parsed details; otherwise keep the cached value.
		const subAgentCalls = this.resolveSubAgentCallsForCacheUpdate(details, existingCache);
		if (subAgentCalls > 0) { details.subAgentCalls = subAgentCalls; }

		const cacheEntry: SessionFileCache = {
			tokens: resolved.tokens,
			interactions: details.interactions,
			modelUsage: resolvedModelUsage,
			mtime: stat.mtime.getTime(),
			size: stat.size,
			// Placeholder (default usage analysis) when no existing full entry backs this one, even with a token result; keeps
			// getSessionFileDataCached() from serving it as a hit. See detailsOnlyCache.ts.
			...(isDetailsOnlyPlaceholder(existingCache) ? { detailsOnly: true as const } : {}),
			actualTokens: resolved.actualTokens,
			thinkingTokens: resolved.thinkingTokens,
			...(resolved.cacheReadTokens ? { cacheReadTokens: resolved.cacheReadTokens } : {}),
			dailyRollups: existingCache?.dailyRollups,
			...this.preserveExistingDebugLogFields(existingCache),
			...this.preserveExistingLocFields(existingCache),
			usageAnalysis: existingCache?.usageAnalysis || this.buildDefaultUsageAnalysis(),
			taskCategory: existingCache?.taskCategory,
			taskCategoryShares: existingCache?.taskCategoryShares,
			firstInteraction: details.firstInteraction,
			lastInteraction: details.lastInteraction,
			title: details.title,
			repository: details.repository,
			// This function only runs after a full parse, which always attempts repository
			// extraction — so `repository` above is the definitive result (possibly undefined
			// because none was found), not "not yet checked". See SessionFileCache.repositoryResolved.
			repositoryResolved: true,
			workspaceFolderPath: this.resolveCachedWorkspacePath(details, existingCache),
			...(subAgentCalls > 0 ? { subAgentCalls } : {}),
		};

		cacheEntry.usageAnalysis!.contextReferences = details.contextReferences;
		this.setCachedSessionData(sessionFile, cacheEntry, stat.size);
	}

	/** Resolve the session's local workspace path for caching, preferring fresh details over the cached value. */
	private resolveCachedWorkspacePath(details: SessionFileDetails, existingCache: SessionFileCache | undefined): string | undefined {
		return details.workspacePath ?? existingCache?.workspaceFolderPath;
	}

	private resolveTokensForCacheUpdate(tokenResult: { tokens: number; thinkingTokens: number; actualTokens: number } | undefined, existingCache: SessionFileCache | undefined): { tokens: number; actualTokens: number | undefined; thinkingTokens: number | undefined; cacheReadTokens: number | undefined } {
		return {
			actualTokens: tokenResult?.actualTokens ?? existingCache?.actualTokens,
			tokens: tokenResult?.tokens ?? existingCache?.tokens ?? 0,
			thinkingTokens: tokenResult?.thinkingTokens ?? existingCache?.thinkingTokens,
			cacheReadTokens: (tokenResult as any)?.cacheReadTokens ?? existingCache?.cacheReadTokens,
		};
	}

	private preserveExistingDebugLogFields(existingCache: SessionFileCache | undefined): Partial<SessionFileCache> {
		return {
			...(existingCache?.modelTurns !== undefined ? { modelTurns: existingCache.modelTurns } : {}),
			...(existingCache?.debugLogInputTokens !== undefined ? { debugLogInputTokens: existingCache.debugLogInputTokens } : {}),
			...(existingCache?.debugLogOutputTokens !== undefined ? { debugLogOutputTokens: existingCache.debugLogOutputTokens } : {}),
			...(existingCache?.debugLogChecked ? { debugLogChecked: true as const } : {}),
		};
	}

	private preserveExistingLocFields(existingCache: SessionFileCache | undefined): Partial<SessionFileCache> {
		return {
			...(existingCache?.linesAdded !== undefined ? { linesAdded: existingCache.linesAdded } : {}),
			...(existingCache?.linesRemoved !== undefined ? { linesRemoved: existingCache.linesRemoved } : {}),
			...(existingCache?.languageUsage !== undefined ? { languageUsage: existingCache.languageUsage } : {}),
		};
	}

	private buildDefaultUsageAnalysis(): SessionUsageAnalysis {
		return {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
			contextReferences: {
				file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
				workspace: 0, terminal: 0, vscode: 0,
				terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0,
				outputPanel: 0, problemsPanel: 0, pullRequest: 0,
				byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} },
			taskClassification: createEmptyTaskClassificationResult(),
			modelSwitching: { uniqueModels: [], modelCount: 0, switchCount: 0, autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0, selectedModelExtensions: [], unknownProviderModels: [], tiers: { standard: [], premium: [], unknown: [] }, hasMixedTiers: false, standardRequests: 0, premiumRequests: 0, unknownRequests: 0, totalRequests: 0, costBuckets: { low: [], medium: [], high: [], unknown: [] }, hasMixedCosts: false, lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0 }
		};
	}

	/**
	 * Get detailed session file information for diagnostics view.
	 * Analyzes session files to extract interactions, context references, and timestamps.
	 * Uses cached data when available to avoid re-reading files.
	 */
	private async getSessionFileDetails(sessionFile: string, existingStat?: Awaited<ReturnType<typeof this.statSessionFile>>): Promise<SessionFileDetails> {
		const stat = existingStat ?? await this.statSessionFile(sessionFile);

		const cachedDetails = await this.getSessionFileDetailsFromCache(sessionFile, stat);
		if (cachedDetails) {
			this._cacheHits++;
			return cachedDetails;
		}

		this._cacheMisses++;

		const details: SessionFileDetails = {
			file: sessionFile, size: stat.size, modified: stat.mtime.toISOString(), interactions: 0,
			contextReferences: { file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {} },
			firstInteraction: null, lastInteraction: null, editorSource: this.detectEditorSource(sessionFile)
		};

		this.enrichDetailsWithEditorInfo(sessionFile, details);

		// Windsurf virtual sessions — resolve via API or .pb file metadata. That client is
		// host-only, so they are the one kind of session that cannot be parsed on a worker.
		if (!this.findEcosystem(sessionFile) && this.windsurf.isWindsurfSessionFile(sessionFile)) {
			return this.processWindsurfSessionDetails(sessionFile, stat, details);
		}

		// Reading and parsing the file is the expensive part, so it runs off the host thread; only
		// the cache write (which owns host state) happens here.
		const result = await this.runOffHostThread(
			(pool) => pool.computeDetails(sessionFile, stat.mtime.getTime(), stat.size, details, this.copilotCliKindsFor(sessionFile)),
			() => _computeSessionFileDetails(this.analyzerDeps, sessionFile, stat, details),
		);
		if (result.cacheUpdate) {
			await this.updateCacheWithSessionDetails(sessionFile, stat, result.details, result.cacheUpdate.tokenResult, result.cacheUpdate.modelUsage);
		}
		return result.details;
	}

	private async processWindsurfSessionDetails(sessionFile: string, stat: fs.Stats, details: SessionFileDetails): Promise<SessionFileDetails> {
		const session = await this.windsurf.resolveSession(sessionFile);
		if (session) {
			details.title = session.title;
			details.interactions = session.interactions;
			// editorSource/editorName come from the resolved session, which already
			// attributes to Windsurf or Devin correctly (see WindsurfDataAccess.resolveSession).
			details.editorSource = session.editorSource;
			details.editorName = session.editorName;
			details.firstInteraction = session.firstInteraction ?? stat.mtime.toISOString();
			details.lastInteraction = session.lastInteraction ?? stat.mtime.toISOString();
		}
		await this.updateCacheWithSessionDetails(sessionFile, stat, details);
		return details;
	}













	/**
	 * Detect which editor the session file belongs to based on its path.
	 * When an adapter provides a more specific per-session name (e.g. "MS Scout (Copilot CLI)"),
	 * that name is returned instead of the generic path-derived one.
	 */
	private detectEditorSource(filePath: string): string {
		return this._resolveEditorLabel(filePath) ??
			_detectEditorSource(filePath, (p) => this.findEcosystem(p)?.id === 'opencode');
	}

	/**
	 * Extract full session log data including chat turns for the log viewer.
	 */
	private async getSessionLogData(sessionFile: string): Promise<SessionLogData> {
		// Use pre-enriched details from the diagnostics cache when available — it carries
		// hierarchy data (parentInfo, childInfo) populated by enrichSessionHierarchy /
		// enrichPiSessionHierarchy during the background load.
		const cached = this.diagnosticsCachedFiles.find(f => f.file === sessionFile);
		const details = cached ?? await this.getSessionFileDetails(sessionFile);
		let subAgentsStarted: number | undefined;
		let hydraFusion: HydraFusionSummary | undefined;
		let turns: ChatTurn[] = [];

		try {
			const eco = this.findEcosystem(sessionFile);
			if (eco?.buildTurns) {
				const result = await eco.buildTurns(sessionFile);
				return this.buildBaseLogData(details, result.turns, undefined, undefined, eco, sessionFile, result.actualTokens);
			}

			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			if (this.isUuidPointerFile(fileContent)) {
				return this.buildBaseLogData(details, [], undefined);
			}

			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n').filter(l => l.trim());
				const isDeltaBased = this.detectIsDeltaBased(lines);
				if (isDeltaBased) {
					turns = await this.buildDeltaJsonlTurns(lines);
				} else {
					const cliResult = await this.buildCliJsonlTurns(lines, sessionFile, fileContent);
					turns = cliResult.turns;
					subAgentsStarted = cliResult.subAgentsStarted;
					hydraFusion = analyzeHydraFusionSession(fileContent);
				}
			} else {
				const sessionContent = JSON.parse(fileContent);
				turns = this.buildJsonSessionTurns(sessionContent);
			}
		} catch (error) {
			this.warn(`Error extracting chat turns from ${sessionFile}: ${error}`);
		}

		let usageAnalysis: SessionUsageAnalysis | undefined;
		try {
			const mtimeMs = new Date(details.modified).getTime();
			usageAnalysis = await this.getUsageAnalysisFromSessionCached(sessionFile, mtimeMs, details.size);
		} catch (usageError) {
			this.warn(`Error loading usage analysis for ${sessionFile}: ${usageError}`);
		}

		const sessionCache = this.getCachedSessionData(sessionFile);
		return this.buildBaseLogData(details, turns, usageAnalysis, sessionCache, undefined, undefined, undefined, { subAgentsStarted, hydraFusion });
	}

	private buildBaseLogData(
		details: SessionFileDetails,
		turns: ChatTurn[],
		usageAnalysis: SessionUsageAnalysis | undefined,
		sessionCache?: SessionFileCache | null,
		eco?: IEcosystemAdapter | null,
		sessionFile?: string,
		ecoActualTokens?: number,
		/** Extras only the CLI JSONL path can supply; every other caller leaves them out. */
		extras: { subAgentsStarted?: number; hydraFusion?: HydraFusionSummary } = {}
	): SessionLogData {
		const editorName = details.editorName || (eco && sessionFile ? getEcosystemDisplayName(eco, sessionFile) : details.editorSource);
		const actualTokens = ecoActualTokens ?? sessionCache?.actualTokens ?? 0;
		const editorNote = editorName === 'Cursor' ? {
			items: [
				'Token counts reflect the context window size at the last request (contextTokensUsed), not cumulative per-turn billing.',
				'Output tokens are not stored locally — Cursor proxies all AI calls through its backend.',
				'Per-turn input/output token breakdown is unavailable (shown as 0).',
				'For accurate billing data, check the Cursor dashboard at cursor.com/settings.',
			],
		} : undefined;
		attachEstimatedTurnCosts(turns, this.modelPricing, getPricingSourceForEditor(editorName));
		return {
			file: details.file, title: details.title || null, editorSource: details.editorSource,
			editorName, size: details.size, modified: details.modified, interactions: details.interactions,
			contextReferences: details.contextReferences, firstInteraction: details.firstInteraction,
			lastInteraction: details.lastInteraction, turns, usageAnalysis, actualTokens,
			...(editorNote ? { editorNote } : {}),
			...(details.parentInfo ? { parentInfo: details.parentInfo } : {}),
			...(details.childInfo ? { childInfo: details.childInfo, totalChildCount: details.totalChildCount } : {}),
			...(extras.hydraFusion ? { hydraFusion: extras.hydraFusion } : {}),
			...this.buildLogDataCacheFields(sessionCache, extras.subAgentsStarted ?? ((details.totalChildCount ?? 0) > 0 ? details.totalChildCount : undefined)),
		};
	}

	private buildLogDataCacheFields(sessionCache: SessionFileCache | null | undefined, subAgentsStarted?: number): Partial<SessionLogData> {
		return {
			...(sessionCache?.cacheReadTokens ? { cachedTokens: sessionCache.cacheReadTokens } : {}),
			...(subAgentsStarted !== undefined ? { subAgentsStarted } : {}),
			...(sessionCache?.debugLogInputTokens !== undefined ? { debugLogInputTokens: sessionCache.debugLogInputTokens } : {}),
			...(sessionCache?.debugLogOutputTokens !== undefined ? { debugLogOutputTokens: sessionCache.debugLogOutputTokens } : {}),
			...(sessionCache?.modelTurns !== undefined ? { modelTurns: sessionCache.modelTurns } : {}),
			...(sessionCache?.truncationCount ? { truncationCount: sessionCache.truncationCount, messagesRemovedByTruncation: sessionCache.messagesRemovedByTruncation } : {}),
		};
	}

	private detectIsDeltaBased(lines: string[]): boolean {
		if (lines.length === 0) { return false; }
		try {
			const firstLine = JSON.parse(lines[0]);
			return firstLine && typeof firstLine.kind === 'number';
		} catch { return false; }
	}

	private async buildDeltaJsonlTurns(lines: string[]): Promise<ChatTurn[]> {
		const turns: ChatTurn[] = [];
		const { sessionState } = await _reconstructJsonlStateAsync(lines);
		const { effortByRequestId } = _buildReasoningEffortTimeline(lines);
		const rawUsageFallback = this.extractPerRequestUsageFromRawLines(lines);

		let sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' = 'ask';
		let currentModel: string | null = null;
		if (sessionState.inputState?.mode) {
			sessionMode = this.getModeType(sessionState.inputState.mode);
			if (sessionState.inputState?.selectedModel?.metadata?.id) {
				currentModel = sessionState.inputState.selectedModel.metadata.id;
			}
		}

		const requests = sessionState.requests || [];
		for (let i = 0; i < requests.length; i++) {
			const request = requests[i];
			if (!request || !request.requestId) { continue; }
			const turn = this.buildDeltaTurn(i, request, sessionMode, currentModel, effortByRequestId, rawUsageFallback);
			turns.push(turn);
		}
		return turns;
	}

	private buildDeltaTurn(i: number, request: any, sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent', currentModel: string | null, effortByRequestId: Map<string, string>, rawUsageFallback: Map<number, { promptTokens: number; outputTokens: number }>): ChatTurn {
		const contextRefs = this.createEmptyContextRefs();
		const userMessage = request.message?.text || '';
		this.analyzeRequestContext(request, contextRefs);
		const requestModel = this.resolveDeltaTurnModel(request, currentModel);
		const { responseText, thinkingText, toolCalls, mcpTools } = this.extractResponseData(request.response || []);
		const actualUsage = this.extractActualUsageFromRequest(request, rawUsageFallback, i);
		return {
			turnNumber: i + 1,
			timestamp: request.timestamp ? new Date(request.timestamp).toISOString() : null,
			mode: sessionMode, userMessage, assistantResponse: responseText, model: requestModel,
			autoRouted: isCopilotAutoRequest(request),
			toolCalls, contextReferences: contextRefs, mcpTools,
			inputTokensEstimate: this.estimateTokensFromText(userMessage, requestModel),
			outputTokensEstimate: this.estimateTokensFromText(responseText, requestModel),
			thinkingTokensEstimate: this.estimateTokensFromText(thinkingText, requestModel),
			actualUsage, thinkingEffort: effortByRequestId.get(request.requestId)
		};
	}

	/**
	 * Resolves the model actually used for one delta-format turn. `request.modelId`
	 * is only the generic `"auto"`/`"copilot/auto"` id when Copilot's Auto routing
	 * was used — the real per-turn model is only recoverable via `getModelFromRequest`
	 * (which reads the response stream's `autoModeResolution` item). Preferring a raw
	 * `"auto"` modelId here would otherwise price every Auto-routed turn as an unknown
	 * model, silently dropping its cost from the Session Steps Overview table.
	 *
	 * When a turn is explicitly Auto-routed but its response has no `autoModeResolution`
	 * item (e.g. an older session predating that field), the `"auto"` sentinel is kept
	 * as-is rather than falling back to `currentModel` — the session's selected model can
	 * differ from whatever Auto actually picked, and substituting it would silently
	 * mislabel/misprice the turn.
	 */
	private resolveDeltaTurnModel(request: any, currentModel: string | null): string {
		return _getModelFromRequest(request, this.modelPricing, currentModel || 'gpt-4');
	}

	private extractActualUsageFromRequest(request: any, rawUsageFallback: Map<number, { promptTokens: number; outputTokens: number }>, index: number): ActualUsage | undefined {
		const resultDetails = typeof request.result?.details === 'string' ? request.result.details : undefined;
		if (request.result?.usage) {
			return this.extractUsageFromResultUsage(request.result.usage, resultDetails);
		}
		if (typeof request.result?.promptTokens === 'number' && typeof request.result?.outputTokens === 'number') {
			return { completionTokens: request.result.outputTokens, promptTokens: request.result.promptTokens, details: resultDetails };
		}
		const meta = request.result?.metadata;
		if (meta && typeof meta.promptTokens === 'number' && typeof meta.outputTokens === 'number') {
			return { completionTokens: meta.outputTokens, promptTokens: meta.promptTokens, details: resultDetails };
		}
		const extracted = rawUsageFallback.get(index);
		if (extracted) { return { completionTokens: extracted.outputTokens, promptTokens: extracted.promptTokens }; }
		return undefined;
	}

	private extractUsageFromResultUsage(u: any, details: string | undefined): ActualUsage {
		return {
			completionTokens: typeof u.completionTokens === 'number' ? u.completionTokens : 0,
			promptTokens: typeof u.promptTokens === 'number' ? u.promptTokens : 0,
			promptTokenDetails: Array.isArray(u.promptTokenDetails) ? u.promptTokenDetails : undefined,
			details
		};
	}

	private async buildCliJsonlTurns(lines: string[], sessionFile: string, fileContent: string): Promise<{ turns: ChatTurn[]; subAgentsStarted: number | undefined }> {
		const turns: ChatTurn[] = [];
		let subAgentsStarted: number | undefined;
		const isJetBrainsFile = isJetBrainsSessionPath(sessionFile);
		const jetBrainsModelHint: string | null = isJetBrainsFile ? detectJetBrainsModelHintFromContent(fileContent) : null;
		let cliSessionModel = isJetBrainsFile ? (jetBrainsModelHint || 'unknown') : 'unknown';
		let cliSessionEffort: string | undefined;

		cliSessionModel = this.detectCliSessionModel(lines, isJetBrainsFile, jetBrainsModelHint, cliSessionModel);
		const modelRef = { value: cliSessionModel };
		const effortRef = { value: cliSessionEffort };

		const subAgentOutputTokenMap = new Map<string, number>();
		let turnNumber = 0;

		for (const line of lines) {
			try {
				const event = JSON.parse(line);
				const result = this.processCliEventForTurns(event, turns, modelRef, effortRef, isJetBrainsFile, jetBrainsModelHint, turnNumber, subAgentOutputTokenMap);
				if (result.turnAdded) { turnNumber++; }
				if (result.subAgentStarted) { subAgentsStarted = (subAgentsStarted ?? 0) + 1; }
			} catch { /* skip malformed */ }
		}

		this.attachSubAgentTokens(turns, subAgentOutputTokenMap, modelRef.value);
		return { turns, subAgentsStarted };
	}

	private detectCliSessionModel(lines: string[], isJetBrainsFile: boolean, jetBrainsModelHint: string | null, defaultModel: string): string {
		if (isJetBrainsFile && jetBrainsModelHint) { return jetBrainsModelHint; }
		for (const line of lines) {
			try {
				const model = this.pickModelFromCliEvent(JSON.parse(line));
				if (model) { return model; }
			} catch { /* skip */ }
		}
		return defaultModel;
	}

	private pickModelFromCliEvent(ev: any): string | null {
		if (ev.type === 'session.start' && ev.data) {
			return ev.data.selectedModel || ev.data.model || null;
		}
		if (ev.type === 'session.model_change') { return ev.data?.newModel || null; }
		const modelEventTypes = ['assistant.message', 'tool.execution_complete', 'assistant.turn_start'];
		if (modelEventTypes.includes(ev.type)) { return ev.data?.model || null; }
		return null;
	}

	private processCliEventForTurns(event: any, turns: ChatTurn[], modelRef: { value: string }, effortRef: { value: string | undefined }, isJetBrainsFile: boolean, jetBrainsModelHint: string | null, turnNumber: number, subAgentOutputTokenMap: Map<string, number>): { turnAdded: boolean; subAgentStarted: boolean } {
		const subAgentStarted = event.type === 'subagent.started';
		let turnAdded = false;
		if (event.type === 'session.model_change') { this.updateCliSessionRefs(event, modelRef, effortRef); }
		if (event.type === 'user.message' && event.data?.content) {
			turns.push(this.buildCliUserTurn(event, turnNumber + 1, modelRef.value, isJetBrainsFile, jetBrainsModelHint, turnNumber + 1, effortRef.value));
			turnAdded = true;
		}
		if (event.type === 'assistant.message' && event.data?.content) {
			this.updateCliAssistantTurn(event, turns, modelRef.value, subAgentOutputTokenMap);
		}
		if (this.isCliToolEvent(event) && turns.length > 0) { this.addCliToolCall(event, turns[turns.length - 1], isJetBrainsFile); }
		if (event.type === 'mcp.tool.call' || event.data?.mcpServer) { this.handleCliMcpEvent(event, turns); }
		return { turnAdded, subAgentStarted };
	}

	private handleCliMcpEvent(event: any, turns: ChatTurn[]): void {
		if (turns.length === 0) { return; }
		turns[turns.length - 1].mcpTools.push({ server: event.data?.mcpServer || 'unknown', tool: event.data?.toolName || event.toolName || 'unknown' });
	}

	private updateCliSessionRefs(event: any, modelRef: { value: string }, effortRef: { value: string | undefined }): void {
		if (typeof event.data?.newModel === 'string') { modelRef.value = event.data.newModel; }
		if (typeof event.data?.reasoningEffort === 'string') { effortRef.value = event.data.reasoningEffort; }
	}

	private isCliToolEvent(event: any): boolean {
		return (event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'tool.execution_start') && !event.data?.parentToolCallId;
	}

	private buildCliUserTurn(event: any, turnNumber: number, cliSessionModel: string, isJetBrainsFile: boolean, jetBrainsModelHint: string | null, localTurnNumber: number, cliSessionEffort: string | undefined): ChatTurn {
		const contextRefs = this.createEmptyContextRefs();
		const userMessage = event.data.content;
		this.analyzeContextReferences(userMessage, contextRefs);
		const turnModel = this.resolveCliTurnModel(event, cliSessionModel, isJetBrainsFile, jetBrainsModelHint, localTurnNumber);
		const turnEffort = typeof event.data?.reasoningEffort === 'string' ? event.data.reasoningEffort : cliSessionEffort;
		return {
			turnNumber, timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : null,
			mode: isJetBrainsFile ? 'ask' : 'cli', userMessage, assistantResponse: '', model: turnModel,
			toolCalls: [], contextReferences: contextRefs, mcpTools: [],
			inputTokensEstimate: this.estimateTokensFromText(userMessage, turnModel),
			outputTokensEstimate: 0, thinkingTokensEstimate: 0, thinkingEffort: turnEffort
		};
	}

	private resolveCliTurnModel(event: any, cliSessionModel: string, isJetBrainsFile: boolean, jetBrainsModelHint: string | null, turnNumber: number): string {
		if (!isJetBrainsFile) { return event.model || event.data?.model || cliSessionModel; }
		if (turnNumber !== 1) { return '?'; }
		return jetBrainsModelHint && jetBrainsModelHint !== 'unknown' ? `${jetBrainsModelHint}?` : '?';
	}

	private updateCliAssistantTurn(event: any, turns: ChatTurn[], cliSessionModel: string, subAgentOutputTokenMap: Map<string, number>): void {
		if (event.data.parentToolCallId) {
			const prev = subAgentOutputTokenMap.get(event.data.parentToolCallId) ?? 0;
			subAgentOutputTokenMap.set(event.data.parentToolCallId, prev + this.estimateTokensFromText(event.data.content, cliSessionModel));
		} else if (turns.length > 0) {
			const lastTurn = turns[turns.length - 1];
			if (typeof event.data.model === 'string') { lastTurn.model = event.data.model; }
			lastTurn.assistantResponse += event.data.content;
			lastTurn.outputTokensEstimate = this.estimateTokensFromText(lastTurn.assistantResponse, lastTurn.model || cliSessionModel);
		}
	}

	private addCliToolCall(event: any, lastTurn: ChatTurn, isJetBrainsFile: boolean): void {
		const CLI_SUB_AGENT_TOOLS = new Set(['task', 'read_agent', 'write_agent', 'list_agents']);
		const toolName = event.data?.toolName || event.toolName || 'unknown';
		const isSubAgent = CLI_SUB_AGENT_TOOLS.has(toolName);
		if (isJetBrainsFile && event.type === 'tool.execution_start') { lastTurn.mode = 'agent'; }
		if (this.isMcpTool(toolName)) {
			lastTurn.mcpTools.push({ server: this.extractMcpServerName(toolName), tool: toolName });
		} else if (isSubAgent) {
			this.addSubAgentToolCall(event, lastTurn, toolName);
		} else {
			this.addRegularToolCall(event, lastTurn, toolName);
		}
	}

	private addSubAgentToolCall(event: any, lastTurn: ChatTurn, toolName: string): void {
		const entry: any = { toolName, arguments: event.data?.arguments ? JSON.stringify(event.data.arguments) : undefined, result: undefined, isSubAgent: true };
		if (event.data?.toolCallId) { entry._callId = event.data.toolCallId; }
		lastTurn.toolCalls.push(entry);
	}

	private addRegularToolCall(event: any, lastTurn: ChatTurn, toolName: string): void {
		const callId = event.data?.toolCallId;
		if (callId && lastTurn.toolCalls.some((tc: any) => tc._callId === callId)) { return; }
		const tc: any = {
			toolName,
			arguments: event.type !== 'tool.result' ? JSON.stringify(event.data?.arguments || {}) : undefined,
			result: event.type === 'tool.result' ? event.data?.output : undefined
		};
		if (callId) { tc._callId = callId; }
		lastTurn.toolCalls.push(tc);
	}

	private attachSubAgentTokens(turns: ChatTurn[], subAgentOutputTokenMap: Map<string, number>, cliSessionModel: string): void {
		if (subAgentOutputTokenMap.size === 0) { return; }
		for (const turn of turns) {
			for (const tc of turn.toolCalls as any[]) {
				if (!tc.isSubAgent || !tc._callId) { continue; }
				const outputTokens = subAgentOutputTokenMap.get(tc._callId) ?? 0;
				const inputTokens = this.computeSubAgentInputTokens(tc, cliSessionModel);
				if (outputTokens > 0 || inputTokens > 0) { tc.subAgentTokens = { input: inputTokens, output: outputTokens }; }
			}
		}
	}

	private computeSubAgentInputTokens(tc: any, model: string): number {
		if (!tc.arguments) { return 0; }
		try {
			const args = JSON.parse(tc.arguments);
			const prompt = typeof args?.prompt === 'string' ? args.prompt : tc.arguments;
			return this.estimateTokensFromText(prompt, model);
		} catch { return this.estimateTokensFromText(tc.arguments, model); }
	}

	private buildJsonSessionTurns(sessionContent: any): ChatTurn[] {
		if (!sessionContent.requests || !Array.isArray(sessionContent.requests)) { return []; }
		let sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' = 'ask';
		if (sessionContent.mode) { sessionMode = this.getModeType(sessionContent.mode); }
		return sessionContent.requests.map((request: any, idx: number) => this.buildJsonRequestTurn(request, idx + 1, sessionMode));
	}

	private buildJsonRequestTurn(request: any, turnNumber: number, sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent'): ChatTurn {
		let requestMode = sessionMode;
		if (request.agent?.id) {
			const agentId = request.agent.id.toLowerCase();
			if (agentId.includes('edit')) { requestMode = 'edit'; }
			else if (agentId.includes('agent')) { requestMode = 'agent'; }
		}
		let userMessage = '';
		if (request.message?.text) { userMessage = request.message.text; }
		else if (request.message?.parts) { userMessage = request.message.parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n'); }
		const contextRefs = this.createEmptyContextRefs();
		this.analyzeRequestContext(request, contextRefs);
		const model = this.getModelFromRequest(request);
		let assistantResponse = ''; let thinkingText = '';
		const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
		const mcpTools: { server: string; tool: string }[] = [];
		if (request.response && Array.isArray(request.response)) {
			const extracted = this.extractResponseData(request.response);
			assistantResponse = extracted.responseText; thinkingText = extracted.thinkingText;
			toolCalls.push(...extracted.toolCalls); mcpTools.push(...extracted.mcpTools);
		}
		return {
			turnNumber, timestamp: request.timestamp || request.ts || request.result?.timestamp || null,
			mode: requestMode, userMessage, assistantResponse, model, toolCalls, contextReferences: contextRefs, mcpTools,
			autoRouted: isCopilotAutoRequest(request),
			actualUsage: this.extractActualUsageFromRequest(request, new Map(), turnNumber - 1),
			inputTokensEstimate: this.estimateTokensFromText(userMessage, model),
			outputTokensEstimate: this.estimateTokensFromText(assistantResponse, model),
			thinkingTokensEstimate: this.estimateTokensFromText(thinkingText, model)
		};
	}

	private createEmptyContextRefs(): ContextReferenceUsage {
		return _createEmptyContextRefs();
	}

	/**
	 * Extract response data from a response array.
	 */
	private extractResponseData(response: any[]): {
		responseText: string;
		thinkingText: string;
		toolCalls: { toolName: string; arguments?: string; result?: string; isSubAgent?: boolean; subAgentModel?: string }[];
		mcpTools: { server: string; tool: string }[];
	} {
		const acc = { responseText: '', thinkingText: '', toolCalls: [] as any[], mcpTools: [] as any[] };
		for (const item of response) {
			if (!item || typeof item !== 'object') { continue; }
			this.processResponseItem(item, acc);
		}
		return acc;
	}

	private processResponseItem(item: any, acc: { responseText: string; thinkingText: string; toolCalls: any[]; mcpTools: any[] }): void {
		const { text, isThinking } = _extractResponseItemText(item);
		if (text) { if (isThinking) { acc.thinkingText += text; } else { acc.responseText += text; } }
		if (item.kind === 'toolInvocationSerialized' || item.kind === 'prepareToolInvocation') {
			this.handleToolInvocationItem(item, acc.toolCalls, acc.mcpTools);
		}
		if (item.kind === 'mcpServersStarting' && item.didStartServerIds) {
			for (const serverId of item.didStartServerIds) { acc.mcpTools.push({ server: serverId, tool: 'start' }); }
		}
	}

	private handleToolInvocationItem(item: any, toolCalls: { toolName: string; arguments?: string; result?: string; isSubAgent?: boolean; subAgentModel?: string }[], mcpTools: { server: string; tool: string }[]): void {
		const subAgentData = _extractSubAgentData(item);
		if (subAgentData) {
			toolCalls.push({
				toolName: (item.toolSpecificData?.agentName as string | undefined) || 'Sub-Agent',
				arguments: subAgentData.prompt || undefined, result: undefined,
				isSubAgent: true, subAgentModel: subAgentData.modelName || undefined,
			});
			return;
		}
		const toolName = this.resolveToolInvocationName(item);
		if (this.isMcpTool(toolName)) {
			mcpTools.push({ server: this.extractMcpServerName(toolName), tool: toolName });
		} else {
			toolCalls.push({ toolName, arguments: item.input ? JSON.stringify(item.input) : undefined, result: this.formatToolResult(item.result) });
		}
	}

	private resolveToolInvocationName(item: any): string {
		return item.toolId || item.toolName || item.invocationMessage?.toolName || item.toolSpecificData?.kind || 'unknown';
	}

	private formatToolResult(result: any): string | undefined {
		if (!result) { return undefined; }
		return typeof result === 'string' ? result : JSON.stringify(result);
	}

	public calculateEstimatedCost(modelUsage: ModelUsage, pricingSource: 'provider' | 'copilot' = 'provider'): number {
		return _calculateEstimatedCost(modelUsage, this.modelPricing, pricingSource);
	}














	private estimateTokensFromJsonlSession(fileContent: string, exactUsage?: Awaited<ReturnType<typeof getCopilotCliExactUsage>>): { tokens: number; thinkingTokens: number; actualTokens: number; cacheReadTokens: number; copilotNanoAiu: number; truncationCount?: number; messagesRemovedByTruncation?: number; maxRequestInputTokens?: number; contextTier?: string } {
		return _estimateTokensFromJsonlSession(fileContent, exactUsage);
	}


	/** Reads and extracts TTFT samples from one session's debug log, trying each candidate path. Returns null when the session has no debug log or none of its llm_request events carry attrs.ttft. */
	private async readTtftSamplesForSessionFile(sessionFilePath: string): Promise<TtftSample[] | null> {
		const candidatePaths = _resolveDebugLogCandidatePaths(sessionFilePath);
		if (!candidatePaths) { return null; }
		for (const debugLogPath of candidatePaths) {
			try {
				const content = await fs.promises.readFile(debugLogPath, 'utf8');
				const samples = _extractTtftSamplesFromDebugLog(content);
				if (samples.length > 0) { return samples; }
			} catch { /* file doesn't exist or can't be read — try next variant */ }
		}
		return null;
	}

	/**
	 * Collects TTFT samples across many sessions' debug logs, bounding concurrency so a
	 * large session count doesn't open hundreds of file handles at once. Sessions with no
	 * debug log (non-VS-Code-Chat editors, or Chat sessions predating this file) resolve to
	 * null immediately with no I/O — see resolveDebugLogCandidatePaths in workspaceHelpers.ts.
	 *
	 * The scan result is cached per scan-range selector so granularity-only changes can reuse the
	 * same sample set instantly. When the range changes, the first miss for that range scans
	 * `diagnosticsAllSessionFiles` — the full, unfiltered discovery list — rather than
	 * `diagnosticsCachedFiles`, which is capped to the last 14 days / 500 files for the rest of
	 * the Diagnostics screen. That cap silently hid real `attrs.ttft` data that exists on disk
	 * but is older than 14 days; the tab's own picker widens the search instead. Debug-log-shaped
	 * candidates are found cheaply first (no I/O — a path check), then only those are stat'd for
	 * the requested range on a cache miss.
	 */
	private async collectTtftSamples(scanRange: TtftScanRange): Promise<{ samples: TtftSample[]; fileCount: number }> {
		return this.diagnosticsTtftCache.getOrLoad(scanRange, async () => {
			const scanRangeMs = ttftScanRangeToMs(scanRange);
			const candidates = this.diagnosticsAllSessionFiles.filter(f => _resolveDebugLogCandidatePaths(f) !== undefined);
			const CONCURRENCY = 20;
			let inRange = candidates;
			if (scanRangeMs !== null) {
				const cutoff = Date.now() - scanRangeMs;
				const withStats: (string | null)[] = [];
				for (let i = 0; i < candidates.length; i += CONCURRENCY) {
					const batch = candidates.slice(i, i + CONCURRENCY);
					const results = await Promise.all(batch.map(async (file) => {
						try {
							const stat = await fs.promises.stat(file);
							return stat.mtimeMs >= cutoff ? file : null;
						} catch { return null; }
					}));
					withStats.push(...results);
				}
				inRange = withStats.filter((f): f is string => f !== null);
			}

			const all: TtftSample[] = [];
			for (let i = 0; i < inRange.length; i += CONCURRENCY) {
				const batch = inRange.slice(i, i + CONCURRENCY);
				const results = await Promise.all(batch.map(f => this.readTtftSamplesForSessionFile(f)));
				for (const r of results) { if (r) { all.push(...r); } }
			}
			return { samples: all, fileCount: inRange.length };
		});
	}

	private extractPerRequestUsageFromRawLines(lines: string[]): Map<number, { promptTokens: number; outputTokens: number }> {
		return _extractPerRequestUsageFromRawLines(lines);
	}








	public getModelFromRequest(request: any): string {
		return _getModelFromRequest(request, this.modelPricing);
	}

	private isJsonlContent(content: string): boolean {
		return _isJsonlContent(content);
	}

	private isUuidPointerFile(content: string): boolean {
		return _isUuidPointerFile(content);
	}

	private applyDelta(state: any, delta: any): any {
		return _applyDelta(state, delta);
	}


	public estimateTokensFromText(text: string, model: string = 'gpt-4'): number {
		return _estimateTokensFromText(text, model, this.tokenEstimators);
	}

	/**
	 * Failure state for a panel that was showing the loading screen when updateTokenStats()
	 * returned no data. _runUpdateTokenStats() already caught the error and reported it via the
	 * status bar, but nothing else tells an open panel — without this, a panel left registered in
	 * _refreshLoadingPanels through the whole compute phase would otherwise be stuck showing a
	 * frozen "Building Activity Index" screen forever, since nothing will ever replace it.
	 * Reuses existing l10n strings rather than adding new ones purely for this fallback.
	 */
	private getRefreshFailedHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			<title>${l10n.t('aiEngineeringFluency')}</title>
		</head>
		<body style="font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-foreground);">
			<h2 style="margin:0 0 8px;">${l10n.t('statusBar.errorTooltip')}</h2>
			<button id="retry" style="padding:6px 14px;cursor:pointer;border:none;border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);">${l10n.t('efficiency.error.retry')}</button>
			<script nonce="${nonce}">
				const vscodeApi = acquireVsCodeApi();
				document.getElementById('retry').addEventListener('click', () => vscodeApi.postMessage({ command: 'retryRefresh' }));
			</script>
		</body>
		</html>`;
	}

	/**
	 * Shows the loading screen on `panel`, awaits a fresh updateTokenStats(), and renders the
	 * result — success, "stay on loading" for a superseded run, or the failure/retry page.
	 * Shared by showDetails()'s initial load and the failure page's retry button, so retrying
	 * after a genuine failure gets the same loading feedback the first load did, instead of
	 * sitting on the stale error page with no visible progress until the fetch finishes.
	 */
	private async loadDetailsIntoPanel(panel: vscode.WebviewPanel): Promise<void> {
		this._detailsPanelIsLoading = true;
		this._refreshLoadingPanels.add(panel);
		this.statusBarItem.tooltip = l10n.t('statusBar.loadingInPanel');
		panel.webview.html = this.getLoadingHtml(panel.webview, this._updateTokenStatsStartedAt ?? Date.now());

		const startedAtGeneration = this._cacheGeneration;
		const stats = await this.updateTokenStats();

		if (this.detailsPanel !== panel) {
			// panel was replaced (never disposed without going through onDidDispose, which already
			// unconditionally deletes it from the registry) — but drop it defensively too, so a
			// future refactor of that invariant can't leave a stale panel registered for broadcast.
			this._refreshLoadingPanels.delete(panel);
			return;
		}
		if (!stats && this.isRefreshSuperseded(startedAtGeneration)) { return; }
		this._detailsPanelIsLoading = false;
		if (!this._refreshLoadingPanels.has(panel)) {
			// Already given its terminal state by someone else: a successful, non-superseded
			// `stats` result means publishRefreshResult() already ran updateDetailsPanelIfOpen()'s
			// non-silent branch as part of this same updateTokenStats() call — it deletes the panel
			// from this registry right after rendering the real content. A genuine failure instead
			// means resolveStuckLoadingPanelsAsFailed() already installed the failure page and
			// cleared the whole registry. Either way, taking ownership of the render again here
			// would overwrite already-current content — including any sort/tab/expansion state the
			// user changed while evaluateAndSurfaceInsights() was awaiting an interactive toast —
			// for no benefit.
			return;
		}
		this._refreshLoadingPanels.delete(panel);
		if (!stats) {
			panel.webview.html = this.getRefreshFailedHtml(panel.webview);
			return;
		}
		try {
			panel.webview.html = this.getDetailsHtml(panel.webview, stats);
			this.log('✅ Details panel HTML set successfully');
		} catch (err) {
			this.error('❌ Failed to set Details panel HTML', err);
			// A real `stats` result means this run succeeded — only the render itself failed. The
			// panel is already out of _refreshLoadingPanels by this point, so without a fallback here
			// it would otherwise stay frozen on the loading screen (or blank, from showDetails()'s
			// cached-stats path) with no further messages and no way to retry.
			panel.webview.html = this.getRefreshFailedHtml(panel.webview);
		}
	}

	/** Environmental's counterpart to loadDetailsIntoPanel() — see that method's doc comment. */
	private async loadEnvironmentalIntoPanel(panel: vscode.WebviewPanel): Promise<void> {
		this._refreshLoadingPanels.add(panel);
		panel.webview.html = this.getLoadingHtml(panel.webview, this._updateTokenStatsStartedAt ?? Date.now());

		const startedAtGeneration = this._cacheGeneration;
		const stats = await this.updateTokenStats();

		if (this.environmentalPanel !== panel) {
			// See loadDetailsIntoPanel()'s identical guard: defensive-only, since onDidDispose()
			// already unconditionally removes a disposed panel from the registry.
			this._refreshLoadingPanels.delete(panel);
			return;
		}
		if (!stats && this.isRefreshSuperseded(startedAtGeneration)) { return; }
		if (!this._refreshLoadingPanels.has(panel)) {
			// See loadDetailsIntoPanel()'s identical check for why: already given its terminal
			// state by publishRefreshResult()'s own non-silent render or, on a genuine failure, by
			// resolveStuckLoadingPanelsAsFailed() — taking ownership of the render again here would
			// overwrite already-current content for no benefit.
			return;
		}
		this._refreshLoadingPanels.delete(panel);
		if (!stats) {
			panel.webview.html = this.getRefreshFailedHtml(panel.webview);
			return;
		}
		try {
			panel.webview.html = this.getEnvironmentalHtml(panel.webview, stats);
		} catch (err) {
			// See loadDetailsIntoPanel()'s identical catch for why this fallback matters.
			this.error('❌ Failed to set Environmental panel HTML', err);
			panel.webview.html = this.getRefreshFailedHtml(panel.webview);
		}
	}

	/**
	 * Resolves every panel still registered in _refreshLoadingPanels with the failure state,
	 * for a refresh that genuinely threw (see this method's call site in _runUpdateTokenStats()).
	 *
	 * A panel can be sitting in this set for one of two reasons: its own showDetails()/
	 * showEnvironmental() call is still awaiting this exact run, or an earlier run that produced
	 * it was superseded and deliberately left the panel registered for *this* replacement to
	 * resolve (see isRefreshSuperseded() call sites in showDetails()/showEnvironmental()) —
	 * either way, this run failing outright means nothing else is coming to rescue it.
	 */
	private resolveStuckLoadingPanelsAsFailed(): void {
		try {
			for (const panel of this._refreshLoadingPanels) {
				try {
					panel.webview.html = this.getRefreshFailedHtml(panel.webview);
				} catch (err) {
					this.error('❌ Failed to resolve stuck loading panel with failure HTML', err);
				}
				if (this.detailsPanel === panel) { this._detailsPanelIsLoading = false; }
			}
		} finally {
			this._refreshLoadingPanels.clear();
		}
	}

	public async showDetails(): Promise<void> {
		this.log('📊 Opening Details panel');
		this.recordViewVisit('details');

		// If panel already exists, just reveal it
		if (this.detailsPanel) {
			this.detailsPanel.reveal();
			this.log('📊 Details panel revealed (already exists)');
			return;
		}

		// Log environment context to help diagnose blank-panel issues
		this.log(`📊 Creating Details panel (uiKind=${vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web'}, remote=${vscode.env.remoteName || 'none'})`);

		// Create a small webview panel
		this.detailsPanel = vscode.window.createWebviewPanel(
			'copilotTokenDetails',
			l10n.t('aiEngineeringFluency'),
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')]
			}
		);

		this.log('✅ Details panel created successfully');
		// Captured once, right after creation: the loading-registry bookkeeping and the
		// post-await continuation below must track *this* panel specifically, not whatever
		// `this.detailsPanel` happens to hold by the time they run — a close-then-reopen while
		// `await this.updateTokenStats()` is still pending would otherwise let this call's
		// continuation delete/overwrite the *replacement* panel instead of a no-op on its own.
		const panel = this.detailsPanel;

		// Track when the panel becomes active or inactive
		this.detailsPanel.onDidChangeViewState((e) => { this.log(`📊 Details panel view state changed: active=${e.webviewPanel.active}, visible=${e.webviewPanel.visible}`); });

		// Handle messages from the webview
		this.detailsPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message)) { return; }
			switch (message.command) {
				case 'refresh':
					await this.dispatch('refresh:details', () => this.refreshDetailsPanel());
					break;
				case 'retryRefresh':
					// From getRefreshFailedHtml()'s retry button — unlike plain 'refresh' above,
					// this shows the loading screen (with real progress) while it retries, instead
					// of leaving the failure page up with no feedback until it finishes.
					await this.dispatch('retryRefresh:details', () => this.loadDetailsIntoPanel(panel));
					break;
				case 'saveSortSettings':
					await this.dispatch('saveSortSettings:details', () =>
						this.context.globalState.update('details.sortSettings', message.settings)
					);
					break;
			}
		});

		// Handle panel disposal
		this.detailsPanel.onDidDispose(() => {
			this.log('📊 Details panel closed');
			// Always remove this specific panel from the registry, but only clear the tracked
			// fields when they still point at it — a stale dispose callback for a panel that has
			// already been replaced (this.detailsPanel !== panel) must not clear the replacement's
			// own state out from under its own, still-in-flight showDetails() call.
			this._refreshLoadingPanels.delete(panel);
			if (this.detailsPanel === panel) {
				this.detailsPanel = undefined;
				this._detailsPanelIsLoading = false;
			}
		});

		// Use cached stats if available, otherwise show loading screen while calculating
		const stats = this.currentDetailedStats;
		if (!stats) {
			this.log('No cached stats — showing loading screen while calculating...');
			await this.loadDetailsIntoPanel(panel);
			return;
		}

		// Set the HTML content
		try {
			panel.webview.html = this.getDetailsHtml(panel.webview, stats);
			this.log('✅ Details panel HTML set successfully');
		} catch (err) {
			// See loadDetailsIntoPanel()'s identical catch: without this fallback the panel would be
			// left blank forever (this branch never painted a loading screen first) with no retry.
			this.error('❌ Failed to set Details panel HTML', err);
			panel.webview.html = this.getRefreshFailedHtml(panel.webview);
		}
	}

	public async showEnvironmental(): Promise<void> {
		this.log('🌿 Opening Environmental Impact view');
		this.recordViewVisit('environmental');

		if (this.environmentalPanel) {
			this.environmentalPanel.reveal();
			this.log('🌿 Environmental Impact view revealed (already exists)');
			return;
		}

		this.environmentalPanel = vscode.window.createWebviewPanel(
			'copilotEnvironmental',
			'Environmental Impact',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(this.extensionUri, 'media'),
				]
			}
		);

		this.environmentalPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message)) { return; }
			if (message.command === 'refresh') {
				await this.dispatch('refresh:environmental', async () => {
					const refreshed = await this.updateTokenStats();
					if (refreshed && this.environmentalPanel) {
						this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, refreshed);
					}
				});
			} else if (message.command === 'retryRefresh') {
				// From getRefreshFailedHtml()'s retry button — unlike plain 'refresh' above, this
				// shows the loading screen (with real progress) while it retries, instead of
				// leaving the failure page up with no feedback until it finishes.
				await this.dispatch('retryRefresh:environmental', () => this.loadEnvironmentalIntoPanel(panel));
			} else if (message.command === 'openMethodologySource') {
				const url = getEnvironmentalMethodologySourceUrl(message.source);
				if (url) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
			}
		});

		this.environmentalPanel.onDidDispose(() => {
			this.log('🌿 Environmental Impact view closed');
			// Same guard as showDetails()'s dispose handler: a stale callback for an
			// already-replaced panel (this.environmentalPanel !== panel) must not clear the
			// replacement's own tracked reference.
			this._refreshLoadingPanels.delete(panel);
			if (this.environmentalPanel === panel) { this.environmentalPanel = undefined; }
		});

		const panel = this.environmentalPanel;
		if (this.currentDetailedStats) {
			// Cached stats exist — updateTokenStats() below is a no-op (see the ?? short-circuit),
			// so this loading screen is only ever painted for an instant before being replaced and
			// never needs to receive progress messages.
			panel.webview.html = this.getLoadingHtml(panel.webview);
			void (async () => {
				const stats = this.currentDetailedStats;
				if (this.environmentalPanel !== panel || !stats) { return; }
				try {
					panel.webview.html = this.getEnvironmentalHtml(panel.webview, stats);
				} catch (err) {
					// See loadDetailsIntoPanel()'s identical catch: without this fallback the panel
					// would be left frozen on the loading screen forever, with no retry.
					this.error('❌ Failed to set Environmental panel HTML', err);
					panel.webview.html = this.getRefreshFailedHtml(panel.webview);
				}
			})();
		} else {
			void this.loadEnvironmentalIntoPanel(panel);
		}
	}

	private getEnvironmentalHtml(webview: vscode.Webview, stats: DetailedStats): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'environmental.js')
		);

		const dataWithBackend = {
			...stats,
			backendConfigured: this.isBackendConfigured(),
			compactNumbers: this.getCompactNumbersSetting(),
			...this.getWebviewLocaleFields(),
		};
		const initialData = JSON.stringify(dataWithBackend).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>Environmental Impact</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_ENVIRONMENTAL__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			${this.getLocalViewRegressionProbeScript('environmental', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	public async showChart(): Promise<void> {
		this.log('📈 Opening Chart view');
		this.recordViewVisit('chart');

		// If panel already exists, just reveal it
		if (this.chartPanel) {
			this.chartPanel.reveal();
			this.log('📈 Chart view revealed (already exists)');
			return;
		}

		// Open the panel IMMEDIATELY with whatever daily stats are already in memory.
		// Full-year data (needed for Week/Month views) is computed in the background below.
		// A truthy lastFullDailyStats is not enough: a build already running when clearCache()
		// fires finishes afterwards and repopulates it with pre-clear data, stamped with the
		// generation the clear just superseded. currentFullDailyStats rejects that stamp so
		// this falls back to the 30-day cache (or triggers a fresh full-year calculation below)
		// instead of rendering stale data.
		const hasFullData = !!this.currentFullDailyStats;
		const initialStats = this.currentFullDailyStats ?? this.currentDailyStats ?? [];

		// Create webview panel now so the tab appears without waiting for I/O
		this.chartPanel = vscode.window.createWebviewPanel(
			'copilotTokenChart',
			'Token Usage Over Time',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.log('✅ Chart view created successfully');

		// Handle messages from the webview
		this.chartPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message)) { return; }
			if (message.command === 'refresh') { await this.dispatch('refresh:chart', () => this.refreshChartPanel()); }
			if (message.command === 'setPeriodPreference') { this.setChartPeriodPreference(message.period); }
			if (message.command === 'setTimeWindowPreference') { this.setChartTimeWindowPreference(message.timeWindow); }
			if (message.command === 'setViewPreference') { this.setChartViewPreference(message); }
			if (message.command === 'setEditorListCollapsed' && typeof message.collapsed === 'boolean') {
				await this.context.globalState.update(CopilotTokenTracker.CHART_EDITOR_LIST_COLLAPSED_KEY, message.collapsed);
			}
		});

		// Render immediately; Week/Month buttons are shown as loading if full-year data isn't ready
		this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, initialStats, hasFullData);

		// Handle panel disposal
		this.chartPanel.onDidDispose(() => {
			this.log('📈 Chart view closed');
			this.chartPanel = undefined;
		});

		// If we only have 30-day data, compute the full year in the background and push an update.
		// This must NOT be awaited here: showChart() is wrapped in dispatch()'s in-flight guard, which
		// only releases the 'showChart' key once this function returns. Awaiting the (potentially long)
		// full-year calculation would keep that key locked — if the user closes the panel and reopens it
		// before the calculation finishes, the reopen would be silently dropped as "already in flight".
		if (!hasFullData) {
			void (async () => {
				// Tracked (not just detached) so clearCache() can wait it out — see
				// _pendingFullYearBackfills' own doc comment.
				const fullStats = await this.trackFullYearBackfill(this.calculateDailyStats());
				if (this.chartPanel) {
					void this.chartPanel.webview.postMessage({
						command: 'updateChartData',
						data: { ...this.buildChartData(fullStats), periodsReady: true, compactNumbers: this.getCompactNumbersSetting() }
					});
				}
			})();
		}
	}

	private setChartPeriodPreference(period: string): void {
		if (period === 'day' || period === 'week' || period === 'month') { this.lastChartPeriod = period; }
	}

	private setChartTimeWindowPreference(timeWindow: string): void {
		const valid: ChartTimeWindow[] = ['today', 'last7', 'last30', 'last90', 'currentMonth', 'allTime'];
		if (valid.includes(timeWindow as ChartTimeWindow)) { this.lastChartTimeWindow = timeWindow as ChartTimeWindow; }
	}

	private normalizeLegacyChartPreference<T extends string>(value: string | undefined, validValues: readonly T[]): T | undefined {
		if (typeof value !== 'string') { return undefined; }
		const normalized = value === 'taskCategory' ? 'task' : value;
		return (validValues as readonly string[]).includes(normalized) ? (normalized as T) : undefined;
	}

	private setChartViewPreference(message: any): void {
		const v = this.normalizeLegacyChartPreference(message.view, ['total', 'model', 'editor', 'repository', 'cost', 'task']);
		const validMetrics = new Set(['tokens', 'output', 'cost', 'sessions']);
		const split = this.normalizeLegacyChartPreference(message.split, ['total', 'model', 'editor', 'repository', 'language', 'provider', 'task']);
		if (v) { this.lastChartView = v as typeof this.lastChartView; }
		if (typeof message.metric === 'string' && validMetrics.has(message.metric)) { this.lastChartMetric = message.metric as typeof this.lastChartMetric; }
		if (split) { this.lastChartSplit = split as typeof this.lastChartSplit; }
	}

	public async showUsageAnalysis(): Promise<void> {
		this.log('📊 Opening Usage Analysis dashboard');
		this.recordViewVisit('usage');
		if (this.analysisPanel) {
			this.log('📊 Revealing existing Usage Analysis panel');
			this.analysisPanel.reveal(vscode.ViewColumn.One, false);
			return;
		}
		this.analysisPanel = vscode.window.createWebviewPanel(
			'copilotUsageAnalysis', 'AI Usage Analysis',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')] }
		);
		this.analysisWebviewReady = false;
		this.analysisMessageReplay.markNotReady();
		this._analysisPanelSeq++;
		this.log(`✅ Usage Analysis dashboard created successfully (panel #${this._analysisPanelSeq})`);
		this.analysisPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message)) { return; }
			await this.handleAnalysisMessage(message);
		});
		// A truthy lastUsageAnalysisStats is not enough: a build already running when
		// clearCache() fires finishes afterwards and repopulates it with pre-clear data,
		// stamped with the generation the clear just superseded. currentUsageAnalysisStats
		// rejects that stamp so this falls back to loading fresh data instead of rendering it.
		const usageForOpen = this.currentUsageAnalysisStats;
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, usageForOpen ?? null);
		if (!usageForOpen) { void this.loadAnalysisStatsInBackground(this.analysisPanel); }
		this.analysisPanel.onDidDispose(() => {
			this.log('📊 Usage Analysis dashboard closed');
			this.analysisPanel = undefined;
			this.analysisWebviewReady = false;
			this.analysisMessageReplay.markNotReady();
			this.pendingAnalysisNavigation = undefined;
		});
	}

	private async flushPendingAnalysisNavigation(): Promise<void> {
		const panel = this.analysisPanel;
		const navigation = this.pendingAnalysisNavigation;
		if (!panel || !this.analysisWebviewReady || !navigation) { return; }
		const delivered = await panel.webview.postMessage({ command: 'switchTab', ...navigation });
		if (delivered && this.pendingAnalysisNavigation === navigation) {
			this.pendingAnalysisNavigation = undefined;
		}
	}

	private async showUsageAnalysisOnTab(tab: UsageAnalysisTab, anchor?: string, sessionsPreset?: SessionsTabPreset): Promise<void> {
		this.pendingAnalysisNavigation = { tab, ...(anchor ? { anchor } : {}), ...(sessionsPreset ? { sessionsPreset } : {}) };
		await this.runOpenerFocused('usage', () => this.showUsageAnalysis());
		await this.flushPendingAnalysisNavigation();
	}

	/**
	 * Opens the Recent Sessions tab filtered to the sessions that nearly filled
	 * their context window over the last 30 days — the actionable drill-down
	 * behind the "Some sessions nearly ran out of context window" insight, whose
	 * counters are computed over that same window.
	 */
	public async showContextPressureSessions(): Promise<void> {
		await this.showUsageAnalysisOnTab('sessions', undefined, { filter: 'nearContextLimit', lookback: 'last30' });
	}

	/**
	 * Opens the Usage Analysis panel and activates the Insights tab. When `insightId` is given —
	 * the toast's "View" action, or the status-bar badge naming its top insight — the webview also
	 * scrolls to and highlights that specific card, instead of dropping the user at the top of a
	 * tab full of look-alike cards and leaving them to find the one they were notified about.
	 */
	public async showUsageAnalysisOnInsightsTab(insightId?: string): Promise<void> {
		await this.showUsageAnalysisOnTab('insights', insightId ? insightCardElementId(insightId) : undefined);
	}

	/** Opens the Usage Analysis panel and activates the Tools & Integrations tab. */
	public async showUsageAnalysisOnToolsTab(anchor = 'section-tool-curation'): Promise<void> {
		await this.showUsageAnalysisOnTab('tools', anchor);
	}

	/** Opens the Usage Analysis panel and activates the Activity tab. */
	public async showUsageAnalysisOnActivityTab(anchor = 'section-interaction-modes'): Promise<void> {
		await this.showUsageAnalysisOnTab('activity', anchor);
	}

	public async showUsageAnalysisOnHealthTab(): Promise<void> {
		await this.showUsageAnalysisOnTab('health');
	}

	/**
	 * Opens the Usage Analysis panel and activates the Repository PRs tab. The webview's own
	 * tab handler owns the lazy PR-statistics fetch, so this only has to get the tab selected —
	 * whether the panel was closed, still rendering its loading state, or already on another tab.
	 */
	public async showUsageAnalysisOnReposTab(): Promise<void> {
		await this.showUsageAnalysisOnTab('repos');
	}

	public async showUsageAnalysisOnCorrectionsTab(): Promise<void> {
		await this.showUsageAnalysisOnTab('corrections');
	}

	/**
	 * Opens the Corrections tab and, for the repository with the most correction moments in the
	 * last cached report, sends Copilot Chat a prompt asking how to improve that workspace's setup
	 * (instructions files, custom instructions, etc.) grounded in real correction examples. Used by
	 * the "Ask Copilot to Fix This" insight action, which — unlike the per-repo buttons in the
	 * Corrections tab — has no single repo to target on its own.
	 */
	public async askCopilotAboutCorrections(): Promise<void> {
		await this.showUsageAnalysisOnCorrectionsTab();
		const repos = this.currentUsageAnalysisStats?.correctionReport?.repos ?? [];
		if (repos.length === 0) { return; }
		const topRepo = repos.reduce((best, repo) =>
			this.correctionMomentCount(repo.counts) > this.correctionMomentCount(best.counts) ? repo : best
		);
		const prompt = _buildCorrectionImprovementPrompt(topRepo);
		await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isNewChat: true });
	}

	public async showUsageAnalysisOnModelEfficiency(): Promise<void> {
		await this.showUsageAnalysisOnTab('activity', 'section-model-efficiency');
	}

	/** Opens the Usage Analysis panel, pushes the latest background worktree scan findings, and activates the Worktrees tab. */
	public async showUsageAnalysisOnWorktreesTab(): Promise<void> {
		await this.showUsageAnalysisOnTab('worktrees');
		this.postWorktreeBackgroundResults();
	}

	private async _handleSuppressUnknownTool(toolName: string): Promise<void> {
		this.analysisPanel?.webview.postMessage({ command: 'toolSuppressed', toolName });
		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
		const current = config.get<string[]>('suppressedUnknownTools', []);
		if (!current.includes(toolName)) {
			await config.update('suppressedUnknownTools', [...current, toolName], vscode.ConfigurationTarget.Global);
			this.log(`🔇 Suppressed unknown tool: ${toolName}`);
		}
	}

	private _logTraceCuration(message: any): void {
		const stage = typeof message.stage === 'string' ? message.stage : 'unknown';
		let details = '{}';
		if (message.details && typeof message.details === 'object') {
			try { details = JSON.stringify(message.details); } catch { details = '[circular or non-serializable]'; }
		}
		this.log(`🧭 [Tool Curation Trace] ${stage} ${details}`);
	}

	private async _handleOpenSessionFile(message: any): Promise<void> {
		if (!message.file) { return; }
		const turnNumber = typeof message.turnNumber === 'number' && Number.isSafeInteger(message.turnNumber) && message.turnNumber > 0
			? message.turnNumber
			: undefined;
		await this.dispatch('openSessionFile:analysis', async () => {
			try { await this.showLogViewer(message.file, turnNumber); }
			catch { vscode.window.showErrorMessage('Could not open log viewer: ' + message.file); }
		});
	}

	private _getAnalysisMessageHandlers(): Record<string, (message: any) => Promise<void> | void> {
		return {
			refresh: () => this.dispatch('refresh:analysis', () => this.refreshAnalysisPanel()),
			analyseRepository: (message) => this.dispatch('analyseRepository', () => this.handleAnalyseRepository(message.workspacePath)),
			analyseAllRepositories: () => this.dispatch('analyseAllRepositories', () => this.handleAnalyseAllRepositories()),
			openCopilotChatWithPrompt: (message) => this.dispatch('openCopilotChatWithPrompt', () =>
				vscode.commands.executeCommand('workbench.action.chat.open', { query: message.prompt, isNewChat: true })
			),
			// Pre-fills the chat input without submitting, so the user reviews the prompt first.
			draftCopilotChatWithPrompt: (message) => this.dispatch('draftCopilotChatWithPrompt', () =>
				typeof message.prompt === 'string'
					? vscode.commands.executeCommand('workbench.action.chat.open', { query: message.prompt, isNewChat: true, isPartialQuery: true, mode: 'agent' })
					: undefined
			),
			suppressUnknownTool: (message) => {
				const toolName = message.toolName as string;
				return toolName ? this._handleSuppressUnknownTool(toolName) : undefined;
			},
			loadRepoPrStats: () => this.dispatch('loadRepoPrStats', () => this.loadRepoPrStats()),
			loadReadiness: (message) => this.dispatch('loadReadiness:analysis', () => this.loadReadinessForUsage(message.requestId, message.force)),
			checkCcrActivity: (message) => {
				const owner = typeof message.owner === 'string' ? message.owner : '';
				const repo = typeof message.repo === 'string' ? message.repo : '';
				const prNumber = typeof message.prNumber === 'number' ? message.prNumber : Number(message.prNumber);
				if (!owner || !repo || !Number.isFinite(prNumber) || prNumber <= 0) { return undefined; }
				return this.dispatch(`checkCcrActivity:${owner}/${repo}#${prNumber}`, () => this.handleCheckCcrActivity(owner, repo, prNumber));
			},
			loadAgentSessions: () => this.dispatch('loadAgentSessions', () => this.loadAgentSessions()),
			loadRecentSessions: (message) => this.dispatch(`loadRecentSessions:${message.period}`, () => this.loadRecentSessions(message.period as ChartTimeWindow)),
			openSessionFile: (message) => this._handleOpenSessionFile(message),
			usageWebviewReady: async (message) => {
				this.analysisWebviewReady = true;
				const reason = typeof message.reason === 'string' ? message.reason : 'unknown';
				const hasContainers = Boolean(message.hasGitHubActivityContainers);
				const replayed = await this.analysisMessageReplay.markReady();
				this.log(`📨 Usage Analysis webview ready (${reason}, containers=${hasContainers}); replayed: ${replayed.length ? replayed.join(', ') : 'nothing buffered'}`);
				await this.flushPendingAnalysisNavigation();
			},
			usageWebviewTrace: (message) => {
				this.log(`📨 Usage Analysis webview trace: ${message.stage} ${JSON.stringify(message.details ?? {})}`);
			},
			insightAction: (message) => this.dispatch(`insightAction:${message.id ?? ''}`, () => this.handleInsightAction(message)),
			traceUsageCuration: (message) => this._logTraceCuration(message),
			saveSessionColumnSettings: (message) => this.dispatch('saveSessionColumnSettings', () =>
				this.context.globalState.update('usage.sessionColumnSettings', message.settings)
			),
			revealPath: (message) => message.path ? this.dispatch('revealPath:analysis', () => this.diagHandleRevealPath(message.path)) : undefined,
			pickWorktreeRoot: () => this.dispatch('pickWorktreeRoot:analysis', () => this.diagHandlePickWorktreeRoot()),
			scanWorktrees: (message) => this.dispatch('scanWorktrees:analysis', () => this.diagHandleScanWorktrees(message)),
			cancelWorktreeScan: () => this.dispatch('cancelWorktreeScan:analysis', () => this.diagHandleCancelWorktreeScan()),
			deleteWorktree: (message) => this.dispatch('deleteWorktree:analysis', () => this.diagHandleDeleteWorktree(message)),
			openWorktreeInEditor: (message) => this.dispatch('openWorktreeInEditor:analysis', () => this.diagHandleOpenWorktreeInEditor(message)),
			cleanupPushedWorktrees: (message) => this.dispatch('cleanupPushedWorktrees:analysis', () => this.diagHandleCleanupPushedWorktrees(message)),
			cancelCleanupPushedWorktrees: () => this.dispatch('cancelCleanupPushedWorktrees:analysis', () => this.diagHandleCancelCleanupPushedWorktrees()),
			// The webview posts this when navigator.clipboard rejects (no permission,
			// no focus). Without a handler the copy button just silently stays on
			// "Copy" and the user has no idea the path never reached the clipboard.
			copyFailed: async (message) => {
				const failedPath = typeof message.path === 'string' ? message.path : '';
				this.log(`📋 Clipboard write failed from the Usage Analysis webview${failedPath ? ` for ${failedPath}` : ''}`);
				const choice = await vscode.window.showWarningMessage(
					l10n.t('usage.copyFailed'),
					...(failedPath ? [l10n.t('usage.copyFailed.retry')] : [])
				);
				if (choice) { await vscode.env.clipboard.writeText(failedPath); }
			},
		};
	}

	/** Describes the analysis panel's identity/visibility so delivery logs can be told apart from "posted into the void". */
	private _describeAnalysisPanel(): string {
		const panel = this.analysisPanel;
		if (!panel) { return 'panel=none'; }
		return `panel=#${this._analysisPanelSeq} visible=${panel.visible} active=${panel.active} htmlLen=${panel.webview.html.length}`;
	}

	private async handleAnalysisMessage(message: any): Promise<void> {
		const handler = this._getAnalysisMessageHandlers()[message.command];
		if (!handler) {
			// Silently dropping unknown commands hides real wiring bugs (a webview posting a
			// command nobody registered looks exactly like a webview posting nothing at all).
			this.log(`📨 Usage Analysis: no handler for webview command '${String(message?.command ?? '(none)')}'`);
			return;
		}
		await handler(message);
	}

	private async handleInsightAction(message: any): Promise<void> {
		const id = typeof message.id === 'string' ? message.id : '';
		const action = typeof message.action === 'string' ? message.action : '';
		if (!id || !action) { return; }
		const now = new Date().toISOString();
		const existing = this._insightStateBag[id] ?? { status: 'new', firstSurfacedAt: now, lastSurfacedAt: now };
		switch (action) {
			case 'seen':
				if (existing.status === 'new') {
					this._insightStateBag[id] = { ...existing, status: 'seen', lastSurfacedAt: now };
				}
				break;
			case 'dismiss':
				this._insightStateBag[id] = { ...existing, status: 'dismissed', lastSurfacedAt: now };
				break;
			case 'snooze': {
				const snoozeUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
				this._insightStateBag[id] = { ...existing, status: 'snoozed', lastSurfacedAt: now, snoozeUntil };
				break;
			}
			case 'done':
				this._insightStateBag[id] = { ...existing, status: 'done', lastSurfacedAt: now };
				break;
		}
		await this.context.globalState.update('insights.state', this._insightStateBag);
		// Re-evaluate once and use it for both surfaces: the insight just acted on may no longer be
		// the top 'new' one, and a badge left naming it would send a click to the wrong card.
		const evaluated = this.currentUsageAnalysisStats ? this.buildCurrentInsights(this.currentUsageAnalysisStats) : undefined;
		this.refreshInsightBadgeFromState(now, evaluated);
		// Push refreshed state back to the webview
		if (this.analysisPanel && evaluated) {
			void this.analysisPanel.webview.postMessage({ command: 'updateInsights', insights: evaluated });
		}
	}

	private _buildAnalysisUpdateData(analysisStats: Awaited<ReturnType<typeof this.calculateUsageAnalysisStats>>): object {
		const workspacePaths = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
		return {
			today: analysisStats.today, last30Days: analysisStats.last30Days,
			month: analysisStats.month, lastMonth: analysisStats.lastMonth,
			autoCompactionsLast7Days: analysisStats.autoCompactionsLast7Days,
			locale: analysisStats.locale,
			customizationMatrix: analysisStats.customizationMatrix || null,
			missedPotential: analysisStats.missedPotential || [],
			lastUpdated: analysisStats.lastUpdated.toISOString(),
			backendConfigured: this.isBackendConfigured(),
			readinessAvailable: true,
			currentWorkspacePaths: workspacePaths,
			toolCallsByEditor: analysisStats.toolCallsByEditor ?? {},
			todaySessions: analysisStats.todaySessions || [],
			claudeDesktopCoverage: analysisStats.claudeDesktopCoverage ?? null,
			insights: this.buildCurrentInsights(analysisStats),
			correctionReport: analysisStats.correctionReport ?? null,
			repeatedTasks: analysisStats.repeatedTasks ?? null,
			curationAnalysis: analysisStats.curationAnalysis ?? null,
			// A cold-opened panel gets `window.__INITIAL_USAGE__ = null` when there are no cached
			// stats yet (_buildUsageAnalysisInitialData returns 'null'), so the webview's
			// initial-payload localization step is skipped entirely. Without this the whole view —
			// tab groups, band headings, context-pressure rows — falls back to English on a
			// non-English VS Code until the panel is reopened with stats already cached.
			...this.getWebviewLocaleFields(),
			memoryFilesAnalysis: _toMemoryFilesAnalysisView(analysisStats.memoryFilesAnalysis ?? null),
			serverMemoriesAnalysis: this.buildServerMemoriesView(),
			copilotApiBalance: this._buildCopilotApiBalance(),
			accountBudgets: this._accountBudgets,
			monthBillingGroupCosts: this.currentDetailedStats?.month.billingGroupCosts ?? null,
			hideAutomaticToolCalls: this.getHideAutomaticToolCallsSetting(),
		};
	}

	/**
	 * Returns a snapshot of the Copilot API quota balance for the usage view.
	 * budgetUsd: monthly entitlement in USD (entitlement / 100).
	 * budgetAiCredits: monthly entitlement in AI Credits (budgetUsd * 100).
	 * remainingAiCredits: raw quota_remaining from the API (AI Credits).
	 * usedAiCredits: budgetAiCredits - remainingAiCredits.
	 * Returns null when no entitlement data is available.
	 */
	private _buildCopilotApiBalance(): { budgetUsd: number; budgetAiCredits: number; remainingAiCredits: number; usedAiCredits: number; pctAvailable: number } | null {
		return computeApiBalance(this._copilotQuotaEntitlements.premium_interactions, this._copilotQuotaEntitlements.premium_interactions_remaining);
	}

	private async loadAnalysisStatsInBackground(panel: vscode.WebviewPanel): Promise<void> {
		// Captured before the walk and handed to it, so the generation this result is stamped with
		// and the one gated on below are the same number by construction rather than by timing.
		const startedAtGeneration = this._cacheGeneration;
		try {
			this.postUsageLoadingProgress('start');
			const analysisStats = await this.calculateUsageAnalysisStats(true, undefined, startedAtGeneration);
			if (!this.analysisPanel || this.analysisPanel !== panel) { return; }
			// Same boundary as the helpers publishRefreshResult() gates: this posts straight to the
			// panel, so the stamp that makes currentUsageAnalysisStats reject the cached result does
			// nothing to stop the result itself reaching the view. A clear landing during the walk
			// would otherwise let this land *after* the clear's replacement refresh and overwrite it.
			// Nothing is stranded by dropping it: that refresh's updateAnalysisPanelIfOpen() posts
			// updateStats to this panel, which leaves the loading state on its own.
			if (!this.mayPublishAt(startedAtGeneration)) { return; }
			this.postUsageLoadingProgress('ready', {
				availableTools: analysisStats.curationAnalysis?.availableTools.length ?? 0,
				unusedTools: analysisStats.curationAnalysis?.unusedTools.length ?? 0,
			});
			void this.analysisPanel.webview.postMessage({ command: 'updateStats', data: this._buildAnalysisUpdateData(analysisStats) });
		} catch (err) {
			// Logged unconditionally — the failure is real and worth recording whatever its
			// generation. The two *panel-facing* messages are not: a superseded load failing is
			// no reason to replace the replacement refresh's loading state, or the valid content
			// it already rendered, with an error about a walk whose result was going to be
			// discarded anyway. Same gate as the success path, for the same reason.
			this.error(`Failed to load usage analysis stats: ${err}`);
			if (!this.mayPublishAt(startedAtGeneration)) { return; }
			this.postUsageLoadingProgress('error', { error: String(err) });
			if (this.analysisPanel && this.analysisPanel === panel) {
				void this.analysisPanel.webview.postMessage({ command: 'updateStatsError', error: String(err) });
			}
		}
	}

	/**
	 * Posts one loading-progress stage to the Usage Analysis panel.
	 *
	 * `originGeneration` gates the post the same way mayPublishAt() gates a result: a walk that a
	 * clear has superseded must not keep narrating its progress to the live panel. The terminal
	 * `ready`/`error` messages were gated first, but the curation stages come from
	 * computeCurationAnalysis() *inside* the walk — so a superseded walk could still regress the
	 * replacement refresh's loading UI back to its own stale stages and counts until it finished.
	 *
	 * `undefined` means the caller is not part of a generation-owned walk and always posts, the
	 * same convention mayPublishAt() uses.
	 */
	private postUsageLoadingProgress(stage: string, details?: Record<string, unknown>, originGeneration?: number): void {
		if (!this.analysisPanel) { return; }
		if (!this.mayPublishAt(originGeneration)) { return; }
		void this.analysisPanel.webview.postMessage({
			command: 'usageLoadingProgress',
			stage,
			details: details ?? {},
		});
	}

	private async handleAnalyseRepository(workspacePath?: string): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		try {
			this.log(`🏗️ Running repository hygiene analysis${workspacePath ? ` for ${workspacePath}` : ''}`);
			const results = await this.runRepoHygieneAnalysis(workspacePath);
			this.analysisPanel.webview.postMessage({
				command: 'repoAnalysisResults',
				data: results,
				workspacePath
			});
			this.log(`✅ Repository hygiene analysis complete${workspacePath ? ` for ${workspacePath}` : ''}`);
		} catch (error) {
			this.error(`Repository analysis failed: ${error}`);
			this.analysisPanel.webview.postMessage({
				command: 'repoAnalysisError',
				error: error instanceof Error ? error.message : String(error),
				workspacePath
			});
		}
	}

	/**
	 * On-demand only (never part of the hourly `refreshRepoPrStatsSnapshot` bulk pass): fetches one
	 * PR's actual Copilot Code Review history — every completed review plus who requested each one —
	 * via `fetchPrCopilotReviewActivity`. This is the fix for the "open PRs only" caveat on the
	 * Repository PRs tab (`repoPrSnapshotFootnoteHtml`): the bulk snapshot only sees a *pending*
	 * review request, which GitHub clears once Copilot posts its review, so a merged or already-
	 * reviewed PR shows nothing there. This call looks at the PR's reviews + issue timeline directly,
	 * so it works regardless of the PR's current state — at the cost of two extra GitHub API requests,
	 * which is why it's gated behind the user clicking a specific PR rather than run for every PR.
	 */
	private async handleCheckCcrActivity(owner: string, repo: string, prNumber: number): Promise<void> {
		if (!this.analysisPanel) { return; }
		try {
			const session = await vscode.authentication.getSession(getGitHubAuthProviderId(), ['read:user'], { silent: true });
			if (!session) {
				this.analysisPanel.webview.postMessage({ command: 'ccrActivityError', owner, repo, prNumber, error: l10nT('usage.repoPrs.ccrNotSignedIn') });
				return;
			}
			const activity = await fetchPrCopilotReviewActivity(owner, repo, prNumber, session.accessToken);
			if (activity.error) {
				this.analysisPanel.webview.postMessage({ command: 'ccrActivityError', owner, repo, prNumber, error: activity.error });
				return;
			}
			this.analysisPanel.webview.postMessage({
				command: 'ccrActivityResult', owner, repo, prNumber,
				reviews: activity.reviews, requests: activity.requests,
			});
		} catch (error) {
			this.error(`Failed to check Copilot Code Review activity for ${owner}/${repo}#${prNumber}`, error);
			this.analysisPanel?.webview.postMessage({
				command: 'ccrActivityError', owner, repo, prNumber,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async handleAnalyseAllRepositories(): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		// Get all workspaces from the customization matrix
		const matrix = this._lastCustomizationMatrix;
		if (!matrix || !matrix.workspaces || matrix.workspaces.length === 0) {
			this.warn('No workspaces available for batch analysis');
			this.analysisPanel.webview.postMessage({
				command: 'repoAnalysisBatchComplete'
			});
			return;
		}

		// Filter out unresolved workspaces (those with paths starting with '<unresolved:')
		const workspaces = matrix.workspaces.filter(ws => !ws.workspacePath.startsWith('<unresolved:'));
		
		this.log(`🏗️ Starting batch repository analysis for ${workspaces.length} workspace(s)`);

		// Run analyses in parallel with a concurrency limit
		const CONCURRENCY_LIMIT = 3; // Analyze up to 3 repos at a time
		const analyzeWorkspace = async (workspace: WorkspaceCustomizationRow) => {
			try {
				await this.handleAnalyseRepository(workspace.workspacePath);
			} catch (error) {
				this.warn(`Failed to analyze workspace ${workspace.workspacePath}: ${error}`);
			}
		};

		// Process workspaces in batches
		for (let i = 0; i < workspaces.length; i += CONCURRENCY_LIMIT) {
			const batch = workspaces.slice(i, i + CONCURRENCY_LIMIT);
			await Promise.all(batch.map(analyzeWorkspace));
		}

		this.log(`✅ Batch repository analysis complete for ${workspaces.length} workspace(s)`);
		
		// Notify the webview that all analyses are complete
		this.analysisPanel.webview.postMessage({
			command: 'repoAnalysisBatchComplete'
		});
	}

	private async runRepoHygieneAnalysis(workspacePath?: string): Promise<any> {
		this.ensureWorkspaceTrustedForGitAccess();
		const workspaceRoot = this.resolveWorkspaceRoot(workspacePath);
		const { branchName, repoName } = this.getGitRepoInfo(workspaceRoot);
		const fileTree = await this.getWorkspaceFileTree(workspaceRoot);
		const prompt = this.buildRepoHygienePrompt(repoName, branchName, workspaceRoot, fileTree);
		try {
			const fullResponse = await this.invokeCopilotModel(prompt);
			return this.parseCopilotHygieneResponse(fullResponse);
		} catch (error) {
			this.error(`Failed to get analysis from Copilot: ${error}`);
			throw new Error(`AI analysis failed: ${error instanceof Error ? error.message : String(error)}. Please try again or check that GitHub Copilot is properly configured.`);
		}
	}

	private buildRepoHygienePrompt(repoName: string, branchName: string, workspaceRoot: string, fileTree: string): string {
		return `You are a repository analyzer. Analyze this repository for hygiene and best practices.

Use these skill instructions:

${REPO_HYGIENE_SKILL}

Repository: ${repoName}
Branch: ${branchName}
Workspace root: ${workspaceRoot}

File tree (showing configuration files):
${fileTree}

Perform the 17 hygiene checks as specified in the skill instructions. Return ONLY a valid JSON object matching this exact schema:

{
  "summary": {
    "totalScore": <number>,
    "maxScore": 76,
    "percentage": <number>,
    "passedChecks": <number>,
    "failedChecks": <number>,
    "warningChecks": <number>,
    "totalChecks": 17,
    "categories": {
      "versionControl": { "score": <number>, "maxScore": 13, "percentage": <number> },
      "codeQuality": { "score": <number>, "maxScore": 17, "percentage": <number> },
      "cicd": { "score": <number>, "maxScore": 10, "percentage": <number> },
      "environment": { "score": <number>, "maxScore": 9, "percentage": <number> },
      "documentation": { "score": <number>, "maxScore": 5, "percentage": <number> }
    }
  },
  "checks": [
    {
      "id": "<string>",
      "category": "<versionControl|codeQuality|cicd|environment|documentation>",
      "label": "<string>",
      "status": "<pass|fail|warning>",
      "weight": <number>,
      "found": <boolean>,
      "detail": "<string>",
      "hint": "<string or null>"
    }
  ],
  "recommendations": [
    {
      "priority": "<high|medium|low>",
      "category": "<string>",
      "action": "<string>",
      "weight": <number>,
      "impact": "<string>"
    }
  ],
  "metadata": {
    "scanVersion": "1.0.0",
    "timestamp": "${new Date().toISOString()}",
    "repository": "${repoName}",
    "branch": "${branchName}",
    "skillName": "repo-hygiene"
  }
}

Return ONLY the JSON object, no markdown formatting, no explanations.`;
	}

	private async invokeCopilotModel(prompt: string): Promise<string> {
		let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'auto' });
		if (models.length === 0) {
			models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		}
		if (models.length === 0) {
			throw new Error('No Copilot models available. Please ensure GitHub Copilot is installed and activated.');
		}
		const model = models[0];
		this.log(`🤖 Using Copilot model: ${model.id} for repository analysis`);
		const cts = new vscode.CancellationTokenSource();
		// Hard cap so a hung model request can't leave the webview stuck on "Analyzing…" forever.
		const timeoutMs = 120_000;
		const timer = setTimeout(() => cts.cancel(), timeoutMs);
		try {
			const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cts.token);
			let fullResponse = '';
			for await (const chunk of response.text) { fullResponse += chunk; }
			// Clear the timer before the cancellation check so a request that finished
			// streaming just as the timer fired isn't reported as a timeout.
			clearTimeout(timer);
			if (cts.token.isCancellationRequested) {
				throw new Error(`Copilot model request timed out after ${timeoutMs / 1000}s`);
			}
			this.log(`📋 Copilot analysis response length: ${fullResponse.length} characters`);
			return fullResponse;
		} catch (error) {
			if (cts.token.isCancellationRequested) {
				throw new Error(`Copilot model request timed out after ${timeoutMs / 1000}s. Please try again.`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}

	/**
	 * Repository hygiene analysis runs `git` (via child_process.execSync) and scans files
	 * inside the workspace folder, so it must not run in untrusted or virtual workspaces
	 * (see package.json `capabilities.untrustedWorkspaces`/`virtualWorkspaces`, both "limited").
	 * This check runs fresh on every invocation (no cached result), so it automatically
	 * reflects the current trust state — including right after the user grants trust.
	 */
	private ensureWorkspaceTrustedForGitAccess(): void {
		if (!vscode.workspace.isTrusted) {
			throw new Error('Repository hygiene analysis requires a trusted workspace because it runs git commands and reads workspace files. Grant workspace trust to enable it.');
		}
		if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme !== 'file')) {
			throw new Error('Repository hygiene analysis is not available for virtual workspaces because it requires local git and filesystem access.');
		}
	}

	private resolveWorkspaceRoot(workspacePath?: string): string {
		if (workspacePath) { return workspacePath; }
		const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!firstFolder) { throw new Error('No workspace folder open'); }
		return firstFolder;
	}

	private getGitRepoInfo(workspaceRoot: string): { branchName: string; repoName: string } {
		let branchName = 'unknown';
		let repoName = path.basename(workspaceRoot);
		try {
			branchName = childProcess.execSync('git rev-parse --abbrev-ref HEAD', {
				cwd: workspaceRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
			}).trim();
			try {
				const remote = childProcess.execSync('git remote get-url origin', {
					cwd: workspaceRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
				}).trim();
				const match = remote.match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
				if (match) { repoName = match[1]; }
			} catch { /* Ignore remote fetch errors */ }
		} catch { /* Ignore git errors */ }
		return { branchName, repoName };
	}

	private parseCopilotHygieneResponse(fullResponse: string): any {
		let jsonText = fullResponse.trim();
		const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (jsonMatch) { jsonText = jsonMatch[1].trim(); }
		const results = JSON.parse(jsonText);
		if (!results.summary || !results.checks || !results.metadata) {
			throw new Error('Invalid response structure from Copilot');
		}
		return results;
	}

	private async getWorkspaceFileTree(workspaceRoot: string): Promise<string> {
		// Get a filtered file tree showing only configuration files
		const configPatterns = [
			'.git', '.gitignore', '.env.example', '.env.sample', '.editorconfig',
			'.eslintrc', 'eslint.config', '.prettierrc', 'prettier.config',
			'tsconfig.json', 'jsconfig.json', 'package.json', 'Makefile',
			'Dockerfile', 'docker-compose', '.github/workflows', '.devcontainer',
			'LICENSE', '.nvmrc', '.node-version', 'README'
		];

		try {
			const files: string[] = [];
			const maxDepth = 3;

			const scanDir = (dir: string, depth: number = 0) => {
				if (depth > maxDepth) {
					return;
				}

				try {
					const entries = fs.readdirSync(dir, { withFileTypes: true });
					for (const entry of entries) {
						const fullPath = path.join(dir, entry.name);
						const relativePath = path.relative(workspaceRoot, fullPath);

						// Skip node_modules and other large directories
						if (entry.name === 'node_modules' || entry.name === '.git' || 
						    entry.name === 'dist' || entry.name === 'build' || entry.name === 'out') {
							continue;
						}

						// Check if this file matches any config pattern
						const isConfig = configPatterns.some(pattern => relativePath.includes(pattern));

						if (isConfig) {
							files.push(relativePath);
						}

						if (entry.isDirectory() && depth < maxDepth) {
							scanDir(fullPath, depth + 1);
						}
					}
				} catch (error) {
					// Ignore permission errors
				}
			};

			scanDir(workspaceRoot);

			return files.length > 0 ? files.join('\n') : '(No configuration files detected)';
		} catch (error) {
			return '(Unable to scan workspace)';
		}
	}

	public async showLogViewer(sessionFilePath: string, focusedTurnNumber?: number): Promise<void> {
		if (this.windsurf.isWindsurfSessionFile(sessionFilePath)) {
			const trajectoryId = this.windsurf.extractTrajectoryId(sessionFilePath);
			const pbPath = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade', `${trajectoryId}.pb`);
			const editorLabel = this.windsurf.getFamilyEditorName(sessionFilePath);
			vscode.window.showInformationMessage(
				`${editorLabel} sessions are stored as binary protobuf files and cannot be viewed as text. The session file is: ${pbPath}`,
				'Reveal in Explorer'
			).then(choice => {
				if (choice === 'Reveal in Explorer') {
					vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pbPath));
				}
			});
			return;
		}
		if (this.logViewerPanel) { this.logViewerPanel.dispose(); this.logViewerPanel = undefined; }
		this.logViewerSessionFilePath = sessionFilePath;
		this.logViewerPanel = vscode.window.createWebviewPanel(
			'copilotLogViewer', `Session: ${path.basename(sessionFilePath)}`,
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(this.extensionUri, 'media'),
				],
			}
		);
		this.logViewerPanel.webview.onDidReceiveMessage(async (message) => { await this.handleLogViewerMessage(message); });
		this.logViewerPanel.onDidDispose(() => { this.logViewerPanel = undefined; });

		const panel = this.logViewerPanel;
		panel.webview.html = this.getLoadingHtml(panel.webview);
		void (async () => {
			const logData = await this.getSessionLogData(sessionFilePath);
			if (this.logViewerPanel !== panel) { return; }
			this.logViewerCurrentData = logData;
			panel.title = `Session: ${logData.title || path.basename(sessionFilePath)}`;
			panel.webview.html = this.getLogViewerHtml(panel.webview, logData, focusedTurnNumber);
		})();
	}

	private async handleLogViewerMessage(message: any): Promise<void> {
		if (await this.dispatchSharedCommand(message)) { return; }
		const logData = this.logViewerCurrentData;
		const sessionFilePath = this.logViewerSessionFilePath;
		switch (message.command) {
			case 'openRawFile':
				await this.dispatch('openRawFile:logviewer', () => this.logViewerHandleOpenRawFile(sessionFilePath)); break;
			case 'showToolCallPretty': {
				if (!logData) { break; }
				const { turnNumber, toolCallIdx } = message as { turnNumber: number; toolCallIdx: number };
				try { await this.logViewerShowToolCallPretty(turnNumber, toolCallIdx, logData); }
				catch (err) { this.error('showToolCallPretty: error', err); vscode.window.showErrorMessage('Could not open formatted tool call.'); }
				break;
			}
			case 'revealToolCallSource': {
				if (!logData) { break; }
				const { turnNumber, toolCallIdx } = message as { turnNumber: number; toolCallIdx: number };
				try { await this.logViewerRevealToolCallSource(turnNumber, toolCallIdx, logData, sessionFilePath); }
				catch (err) { this.error('revealToolCallSource: error', err); vscode.window.showErrorMessage('Could not reveal tool call in file.'); }
				break;
			}
			case 'refreshSession': {
				try {
					const newData = await this.getSessionLogData(sessionFilePath);
					this.logViewerCurrentData = newData;
					if (this.logViewerPanel) {
						this.logViewerPanel.webview.html = this.getLogViewerHtml(this.logViewerPanel.webview, newData);
					}
				} catch (err) {
					this.error('refreshSession: error', err);
					vscode.window.showErrorMessage('Could not refresh session data.');
				}
				break;
			}
		}
	}

	private async logViewerHandleOpenRawFile(sessionFilePath: string): Promise<void> {
		try {
			const rawEco = this.findEcosystem(sessionFilePath);
			const rawContent = rawEco?.getRawFileContent?.(sessionFilePath);
			if (rawContent !== undefined) {
				const doc = await vscode.workspace.openTextDocument({ content: rawContent, language: 'json' });
				await vscode.window.showTextDocument(doc);
			} else {
				await vscode.window.showTextDocument(vscode.Uri.file(sessionFilePath));
			}
		} catch { vscode.window.showErrorMessage('Could not open raw file: ' + sessionFilePath); }
	}

	private logViewerSafeParse(text?: string): any {
		if (!text) { return text; }
		try { return JSON.parse(text); } catch { return text; }
	}

	private logViewerMapTurnForContext(t?: ChatTurn): any {
		if (!t) { return undefined; }
		return { turnNumber: t.turnNumber, timestamp: t.timestamp, mode: t.mode, model: t.model, userMessage: t.userMessage, assistantResponse: t.assistantResponse, inputTokensEstimate: t.inputTokensEstimate, outputTokensEstimate: t.outputTokensEstimate, toolCalls: t.toolCalls?.map((tc, idx) => ({ index: idx, toolName: tc.toolName, arguments: tc.arguments, result: tc.result })) };
	}

	private logViewerMapToolCallForContext(tc: { toolName: string; arguments?: string; result?: string }, idx: number, parentTurn?: ChatTurn, fallbackTurnNumber?: number): any {
		return { turn: parentTurn?.turnNumber ?? fallbackTurnNumber, toolCallIdx: idx, toolName: tc.toolName, model: parentTurn?.model, mode: parentTurn?.mode, timestamp: parentTurn?.timestamp, userMessage: parentTurn?.userMessage, assistantResponse: parentTurn?.assistantResponse, inputTokensEstimate: parentTurn?.inputTokensEstimate, outputTokensEstimate: parentTurn?.outputTokensEstimate, argumentsRaw: tc.arguments ?? null, argumentsParsed: this.logViewerSafeParse(tc.arguments), resultRaw: tc.result ?? null, resultParsed: this.logViewerSafeParse(tc.result) };
	}

	private async logViewerShowToolCallPretty(turnNumber: number, toolCallIdx: number, logData: SessionLogData): Promise<void> {
		const turn = logData.turns.find(t => t.turnNumber === turnNumber);
		const turnIndex = logData.turns.findIndex(t => t.turnNumber === turnNumber);
		const toolCall = turn?.toolCalls?.[toolCallIdx];
		if (!toolCall) { this.log('showToolCallPretty: tool call not found in session data'); vscode.window.showInformationMessage('Tool call not found in session data.'); return; }
		const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'toolcall';
		const prettyName = sanitize(`${toolCall.toolName || 'tool'}-turn-${turnNumber}-call-${toolCallIdx}`);
		const prettyPayload = {
			turnBefore: turnIndex > 0 ? this.logViewerMapTurnForContext(logData.turns[turnIndex - 1]) : undefined,
			toolCall: this.logViewerMapToolCallForContext(toolCall, toolCallIdx, turn, turnNumber),
			turnAfter: turnIndex >= 0 && turnIndex < logData.turns.length - 1 ? this.logViewerMapTurnForContext(logData.turns[turnIndex + 1]) : undefined
		};
		const prettyUri = vscode.Uri.parse(`untitled:${prettyName}.json`);
		const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === prettyUri.toString());
		if (openDoc) { await vscode.window.showTextDocument(openDoc, { preview: true }); return; }
		const doc = await vscode.workspace.openTextDocument(prettyUri);
		const editor = await vscode.window.showTextDocument(doc, { preview: true });
		await editor.edit((eb) => { eb.insert(new vscode.Position(0, 0), JSON.stringify(prettyPayload, null, 2)); });
		await vscode.languages.setTextDocumentLanguage(doc, 'json');
	}

	private async logViewerRevealToolCallSource(turnNumber: number, toolCallIdx: number, logData: SessionLogData, sessionFilePath: string): Promise<void> {
		this.log(`revealToolCallSource: turn=${turnNumber}, toolCallIdx=${toolCallIdx}, file=${sessionFilePath}`);
		const turn = logData.turns.find(t => t.turnNumber === turnNumber);
		const toolCall = turn?.toolCalls?.[toolCallIdx];
		if (!toolCall) { this.log('revealToolCallSource: tool call not found in session data'); vscode.window.showInformationMessage('Tool call not found in session data.'); return; }
		const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
		const searchTerm = toolCall.toolName || '';
		const matchIdx = searchTerm ? fileContent.indexOf(searchTerm) : -1;
		this.log(`revealToolCallSource: searchTerm='${searchTerm}', matchIdx=${matchIdx}`);
		const doc = await vscode.workspace.openTextDocument(sessionFilePath);
		const editor = await vscode.window.showTextDocument(doc);
		if (matchIdx >= 0) {
			const pos = doc.positionAt(matchIdx);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		} else {
			vscode.window.showInformationMessage('Opened session file, but could not locate this tool call text.');
		}
	}

	/**
	 * Opens a JSONL file in a formatted view with array brackets and commas.
	 * Does not modify the original file.
	 */
	public async showFormattedJsonlFile(sessionFilePath: string): Promise<void> {
		// Windsurf/Devin sessions are binary protobuf files — open the real .pb file in the OS
		if (this.windsurf.isWindsurfSessionFile(sessionFilePath)) {
			const trajectoryId = this.windsurf.extractTrajectoryId(sessionFilePath);
			const pbPath = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade', `${trajectoryId}.pb`);
			const editorLabel = this.windsurf.getFamilyEditorName(sessionFilePath);
			vscode.window.showInformationMessage(
				`${editorLabel} sessions are stored as binary protobuf files and cannot be viewed as text. The session file is: ${pbPath}`,
				'Reveal in Explorer'
			).then(choice => {
				if (choice === 'Reveal in Explorer') {
					vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pbPath));
				}
			});
			return;
		}

		try {
			// Read the file content
			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf-8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				vscode.window.showInformationMessage(
					`This file contains only a session ID (${fileContent.trim()}). The actual session data is stored elsewhere in the Copilot CLI format.`
				);
				return;
			}

			// Parse JSONL into array of objects
			const lines = fileContent.trim().split('\n').filter(line => line.trim().length > 0);
			const jsonObjects: unknown[] = [];

			for (let i = 0; i < lines.length; i++) {
				try {
					const obj = JSON.parse(lines[i]);
					jsonObjects.push(obj);
				} catch (e) {
					// Skip malformed lines with detailed warning
					this.warn(`Skipping malformed line ${i + 1} in ${sessionFilePath}: ${e}`);
				}
			}

			// Format as JSON array
			const formattedJson = JSON.stringify(jsonObjects, null, 2);

			// Create an untitled document with the formatted content
			const fileName = path.basename(sessionFilePath, path.extname(sessionFilePath));
			const prettyUri = vscode.Uri.parse(`untitled:${fileName}-formatted.json`);

			// Check if this document is already open and close it to refresh
			const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === prettyUri.toString());
			if (openDoc) {
				// Close the existing document so we can create a fresh one with updated content
				const editor = vscode.window.visibleTextEditors.find(e => e.document === openDoc);
				if (editor) {
					await vscode.window.showTextDocument(openDoc, editor.viewColumn);
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				}
			}

			// Create and open the document
			const doc = await vscode.workspace.openTextDocument(prettyUri);
			const editor = await vscode.window.showTextDocument(doc, { preview: true });

			// Insert the formatted JSON
			await editor.edit((editBuilder) => {
				editBuilder.insert(new vscode.Position(0, 0), formattedJson);
			});

			// Set language mode to JSON for syntax highlighting
			await vscode.languages.setTextDocumentLanguage(doc, 'json');

		} catch (error) {
			this.error(`Error formatting JSONL file ${sessionFilePath}:`, error);
			throw error;
		}
	}

	private getLogViewerHtml(webview: vscode.Webview, logData: SessionLogData, focusedTurnNumber?: number): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'logviewer.js'));

		const initialData = JSON.stringify({ ...logData, focusedTurnNumber, compactNumbers: this.getCompactNumbersSetting(), ...this.getWebviewLocaleFields() }).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			<title>Session Log Viewer</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_LOGDATA__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private async refreshDetailsPanel(): Promise<void> {
		if (!this.detailsPanel) {
			return;
		}

		this.log('🔄 Refreshing Details panel');
		// Update token stats and refresh the webview content
		const stats = await this.updateTokenStats();
		if (stats) {
			this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);
			this.log('✅ Details panel refreshed');
		}
	}

	private async refreshChartPanel(): Promise<void> {
		if (!this.chartPanel) {
			return;
		}

		this.log('🔄 Refreshing Chart view');
		// Refresh the full-year daily stats so week/month period views are up to date. Tracked (not
		// just awaited locally) so a concurrent clearCache() can wait it out too — see
		// _pendingFullYearBackfills' own doc comment.
		await this.trackFullYearBackfill(this.calculateDailyStats());
		// Refresh all stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Chart view refreshed');
	}

	private async refreshAnalysisPanel(): Promise<void> {
		if (!this.analysisPanel) { return; }

		this.log('🔄 Refreshing Usage Analysis dashboard');
		// Tell the webview to switch to the loading UI immediately, then discard
		// the cached stats so loadAnalysisStatsInBackground performs a full recalculation.
		void this.analysisPanel.webview.postMessage({ command: 'usageRefreshing' });
		this.lastUsageAnalysisStats = undefined;
		// An explicit refresh should re-scan memory files too, even if the last scan is
		// still within its TTL: the user is asking for current data, so a stale cache here
		// would silently ignore files added/removed since the last scan.
		this._memoryFilesAnalysisScannedAt = undefined;
		// An Efficiency build spanning this refresh was built on the stats just discarded, so
		// bump the generation to stop its result being recorded. Deliberately *not* clearing
		// `_lastEfficiencyViewData` as clearCache() does: this leaves the session cache
		// intact, so an Efficiency rebuild will succeed, and dropping the last good payload
		// would only guarantee the failure state on the way there.
		//
		// The generation is global, but this refresh is not: it invalidates usage-analysis
		// state and nothing else. The detailed, daily and full-year caches are carried across the
		// bump so they stay readable. Dropping the detailed one costs this panel's own Copilot
		// Billing Coverage section — _buildAnalysisUpdateData() and the initial payload read
		// monthBillingGroupCosts through currentDetailedStats — and a bare bump silently
		// truncated an open Chart besides. With
		// `currentFullDailyStats` reading stale, _runRefreshCore()'s backfill is still skipped
		// (it skips whenever a chart panel is open), `mergeIntoFullDailyStats()` early-returns,
		// and the chart then re-renders from the 30-day fallback — losing its week, month and
		// all-history ranges after nothing more than a Usage Analysis refresh.
		const detailedWasCurrent = isComputedStatsCurrent(this._statsGeneration.detailed, this._cacheGeneration);
		const dailyWasCurrent = isComputedStatsCurrent(this._statsGeneration.daily, this._cacheGeneration);
		const fullDailyWasCurrent = isComputedStatsCurrent(this._statsGeneration.fullDaily, this._cacheGeneration);
		this._cacheGeneration++;
		if (detailedWasCurrent) { this._statsGeneration.detailed = this._cacheGeneration; }
		if (dailyWasCurrent) { this._statsGeneration.daily = this._cacheGeneration; }
		if (fullDailyWasCurrent) { this._statsGeneration.fullDaily = this._cacheGeneration; }
		await this.loadAnalysisStatsInBackground(this.analysisPanel);
		// Refresh token stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Usage Analysis dashboard refreshed');
	}

	// ── Maturity / Fluency Score ───────────────────────────────────────

	/**
	 * Calculate maturity scores across 6 categories using last 30 days of usage data.
	 * Each category is scored 1-4 based on threshold rules.
	 * Overall stage = median of the 6 category scores.
	 * @param useCache If true, use cached usage stats. If false, force recalculation.
	 */
	private async calculateMaturityScores(useCache = true, preloaded?: SessionFilePreload[], originGeneration?: number): Promise<{
		overallStage: number;
		overallLabel: string;
		categories: { category: string; icon: string; stage: number; evidence: string[]; tips: string[] }[];
		period: UsageAnalysisPeriod;
		lastUpdated: string;
		agenticTrend?: AgenticTrendPoint[];
	}> {
		return _calculateMaturityScores(this._lastCustomizationMatrix, (useCache) => this.calculateUsageAnalysisStats(useCache, preloaded, originGeneration), useCache, this._copilotPlanResolved?.isMCPEnabled);
	}

	/**
	 * Run the Dark Factory readiness scan over the repositories in this workspace.
	 *
	 * Filesystem-only plus the pull-request statistics the Usage Analysis view has
	 * already fetched, so opening AI Readiness issues no extra GitHub calls.
	 */
	private runDarkFactoryScan(workspacePaths: readonly string[]): DarkFactoryReport {
		return scanDarkFactoryReadiness({
			workspacePaths,
			prStats: this._lastRepoPrStats,
			enterpriseUri: getConfiguredGitHubEnterpriseUri(),
		});
	}

	/** Opens the AI Readiness tab in the existing Usage Analysis panel. */
	public async showReadiness(): Promise<void> {
		await this.showUsageAnalysisOnTab('readiness');
	}

	/**
	 * Serve the readiness report, cache-first.
	 *
	 * A cached report is posted immediately so the tab is usable at once; a fresh scan
	 * then runs in the background only when that cache is over a day old, or when the
	 * user asked for one (`force`). With no cache the scan runs straight away.
	 */
	/** Open folders first, then every workspace path the usage matrix knows about. */
	private darkFactoryCandidatePaths(): string[] {
		const openFolders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
		return [...openFolders, ...this._buildWorkspacePaths()];
	}

	private loadReadinessForUsage(requestId: unknown, force: unknown): void {
		const panel = this.analysisPanel;
		if (!panel) { return; }
		if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 1) {
			this.warn('AI Readiness: received an invalid scan request id');
			return;
		}
		const workspacePaths = this.darkFactoryCandidatePaths();
		const scopeKey = readinessScopeKey(workspacePaths);
		const cached = parseCacheEntry(this.context.globalState.get(DARK_FACTORY_CACHE_KEY), scopeKey, this.githubSession !== undefined);
		const needsScan = force === true || !cached || isReportStale(cached);
		if (cached && force !== true) {
			void panel.webview.postMessage({ command: 'readinessLoaded', requestId, report: cached, refreshing: needsScan });
		}
		if (!needsScan) { return; }
		// Deferred so the cached report above paints before the synchronous scan blocks the host.
		setTimeout(() => this.scanReadinessAndPost(panel, requestId, workspacePaths, scopeKey), 0);
	}

	private scanReadinessAndPost(panel: vscode.WebviewPanel, requestId: number, workspacePaths: readonly string[], scopeKey: string): void {
		try {
			const report = this.runDarkFactoryScan(workspacePaths);
			Promise.resolve(this.context.globalState.update(DARK_FACTORY_CACHE_KEY, { scopeKey, report }))
				.catch(err => this.warn(`Dark Factory readiness cache could not be saved: ${err}`));
			if (this.analysisPanel === panel) {
				void panel.webview.postMessage({ command: 'readinessLoaded', requestId, report, refreshing: false });
			}
		} catch (err) {
			this.warn(`Dark Factory readiness scan failed: ${err}`);
			if (this.analysisPanel === panel) {
				void panel.webview.postMessage({ command: 'readinessScanFailed', requestId });
			}
		}
	}

	public async showMaturity(): Promise<void> {
		this.log('🎯 Opening Copilot Fluency Score dashboard');
		this.recordViewVisit('maturity');
		if (this.maturityPanel) { this.maturityPanel.dispose(); this.maturityPanel = undefined; }
		const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;
		this.maturityPanel = vscode.window.createWebviewPanel(
			'copilotMaturity', l10n.t('pptxTitle'),
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(this.extensionUri, 'media'),
				],
			}
		);
		this.maturityPanel.webview.onDidReceiveMessage(async (message) => { await this.handleMaturityMessage(message); });
		this.maturityPanel.onDidDispose(() => { this.log('🎯 Copilot Fluency Score dashboard closed'); this.maturityPanel = undefined; });

		const panel = this.maturityPanel;
		panel.webview.html = this.getLoadingHtml(panel.webview);
		void (async () => {
			const [, maturityData, dismissedTips] = await Promise.all([
				this.context.globalState.update('fluencyScore.everOpened', true),
				this.calculateMaturityScores(true),
				this.getDismissedFluencyTips(),
			]);
			if (this.maturityPanel !== panel) { return; }
			const fluencyLevels = isDebugMode ? this.getFluencyLevelData(isDebugMode).categories : undefined;
			panel.webview.html = this.getMaturityHtml(panel.webview, {
				...maturityData,
				dismissedTips,
				isDebugMode,
				fluencyLevels,
				installedHooks: this.hookManager.getInstalledHooks(),
			});
		})();
	}

	private async handleMaturityMessage(message: any): Promise<void> {
		if (this.handleLocalViewRegressionMessage(message)) { return; }
		if (await this.dispatchSharedCommand(message)) { return; }
		const simpleCommands: Record<string, () => Promise<void>> = {
			refresh: () => this.dispatch('refresh:maturity', () => this.refreshMaturityPanel()),
			searchMcpExtensions: () => this.dispatch('searchMcpExtensions', () => vscode.commands.executeCommand('workbench.extensions.search', '@tag:mcp')),
			shareToIssue: () => this.dispatch('shareToIssue', () => this.maturityHandleShareToIssue()),
			resetDismissedTips: () => this.dispatch('resetDismissedTips', async () => { await this.resetDismissedFluencyTips(); await this.refreshMaturityPanel(); }),
			downloadChartImage: () => this.dispatch('downloadChartImage', () => this.downloadChartImage()),
			exportImageFailed: async () => { vscode.window.showErrorMessage('Failed to export the Fluency Score image. The dashboard was not ready yet; try again once it has finished loading.'); },
			shareToSocialFailed: async () => { vscode.window.showErrorMessage('Failed to generate share card image.'); },
		};
		if (simpleCommands[message.command]) { await simpleCommands[message.command](); return; }
		await this.handleMaturityConditionalMessage(message);
	}

	private async handleMaturityConditionalMessage(message: any): Promise<void> {
		switch (message.command) {
			case 'dismissTips': if (message.category) { await this.dispatch('dismissTips', async () => { await this.dismissFluencyTips(message.category); await this.refreshMaturityPanel(); }); } break;
			case 'installHook': if (message.hookId) { await this.maturityHandleInstallHook(message.hookId); } break;
			case 'uninstallHook': if (message.hookId) { await this.maturityHandleUninstallHook(message.hookId); } break;
			default: await this.handleMaturityExportCommand(message); break;
		}
	}

	private async handleMaturityExportCommand(message: any): Promise<void> {
		switch (message.command) {
			case 'saveChartImage': if (message.data) { await this.dispatch('saveChartImage', () => this.saveChartImageData(message.data)); } break;
			case 'exportPdf': if (message.data) { await this.dispatch('exportPdf', () => this.exportFluencyScorePdf(message.data)); } break;
			case 'exportPptx': if (message.data) { await this.dispatch('exportPptx', () => this.exportFluencyScorePptx(message.data)); } break;
			case 'shareToSocial': if (message.dataUrl && isSharePlatform(message.platform)) { await this.dispatch('shareToSocial', () => this.maturityHandleShareToSocial(message.platform, message.dataUrl)); } break;
		}
	}

	private async maturityHandleInstallHook(hookId: string): Promise<void> {
		try {
			await this.hookManager.installHook(hookId);
			const hooksDir = this.hookManager.getHooksDirectory();
			const choice = await vscode.window.showInformationMessage(
				`✅ Session reminder installed. Hook scripts written to ${hooksDir} — they will activate in your next Copilot agent session.`,
				'Open Hooks Folder'
			);
			if (choice === 'Open Hooks Folder') {
				await vscode.env.openExternal(vscode.Uri.file(hooksDir));
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to install hook: ${err instanceof Error ? err.message : String(err)}`);
		}
		await this.refreshMaturityPanel();
	}

	private async maturityHandleUninstallHook(hookId: string): Promise<void> {
		try {
			await this.hookManager.uninstallHook(hookId);
			vscode.window.showInformationMessage(`Removed session reminder for "${hookId}".`);
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to remove hook: ${err instanceof Error ? err.message : String(err)}`);
		}
		await this.refreshMaturityPanel();
	}

	private async maturityHandleShareToIssue(): Promise<void> {
		const scores = await this.calculateMaturityScores();
		const categorySections = scores.categories.map(c => {
			const evidenceList = c.evidence.length > 0 ? c.evidence.map(e => `- ✅ ${e}`).join('\n') : '- No significant activity detected';
			return `<h2>${c.icon} ${c.category} — Stage ${c.stage}</h2>\n\n${evidenceList}`;
		}).join('\n\n');
		const body = `<h2>${l10n.t('fluencyScoreFeedbackTitle')}</h2>\n\n**Overall Stage:** ${scores.overallLabel}\n\n${categorySections}\n\n<h2>Feedback</h2>\n<!-- Describe your feedback or suggestion here -->\n`;
		const issueUrl = `https://github.com/rajbos/ai-engineering-fluency/issues/new?title=${encodeURIComponent('Fluency Score Feedback')}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent('fluency-score')}`;
		await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
	}

private async refreshMaturityPanel(): Promise<void> {
	if (!this.maturityPanel) {
		return;
	}

	this.log('🔄 Refreshing Copilot Fluency Score dashboard');
	const maturityData = await this.calculateMaturityScores(false); // Force recalculation on refresh
	const dismissedTips = await this.getDismissedFluencyTips();
	const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;
	const fluencyLevels = isDebugMode ? this.getFluencyLevelData(isDebugMode).categories : undefined;
	this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, { ...maturityData, dismissedTips, isDebugMode, fluencyLevels, installedHooks: this.hookManager.getInstalledHooks() });
	this.log('✅ Copilot Fluency Score dashboard refreshed');
}

private async getDismissedFluencyTips(): Promise<string[]> {
	return this.context.globalState.get<string[]>('dismissedFluencyTips', []);
}

private async dismissFluencyTips(category: string): Promise<void> {
	const dismissed = await this.getDismissedFluencyTips();
	if (!dismissed.includes(category)) {
		dismissed.push(category);
		await this.context.globalState.update('dismissedFluencyTips', dismissed);
		this.log(`Dismissed fluency tips for category: ${category}`);
	}
}

private async resetDismissedFluencyTips(): Promise<void> {
	await this.context.globalState.update('dismissedFluencyTips', []);
	this.log('Reset all dismissed fluency tips');
}

/**
 * Copies `shareText` to the clipboard and opens the given social platform's compose/share page
 * in the browser, so the user can paste it in. Used by the diagnostics Share Card view.
 */
private async shareTextToSocialPlatform(shareText: string, platform: 'linkedin' | 'bluesky' | 'mastodon'): Promise<void> {
    const marketplaceUrl = 'https://marketplace.visualstudio.com/items?itemName=RobBos.ai-engineering-fluency';
    switch (platform) {
      case "linkedin": {
        // LinkedIn share URL - opens in browser for user to add their own commentary
        const shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(marketplaceUrl)}`;

        // Copy share text to clipboard for easy pasting
        await vscode.env.clipboard.writeText(shareText);
        const selection = await vscode.window.showInformationMessage(
          "Share text copied to clipboard! Paste it into your LinkedIn post.",
          "Open LinkedIn",
        );
        if (selection === "Open LinkedIn") {
          await vscode.env.openExternal(vscode.Uri.parse(shareUrl));
        }
        break;
      }

      case "bluesky": {
        // Copy share text to clipboard, then open Bluesky compose
        await vscode.env.clipboard.writeText(shareText);
        const selection = await vscode.window.showInformationMessage(
          "Share text copied to clipboard! Paste it into your Bluesky post.",
          "Open Bluesky",
        );
        if (selection === "Open Bluesky") {
          await vscode.env.openExternal(
            vscode.Uri.parse("https://bsky.app/intent/compose"),
          );
        }
        break;
      }

      case "mastodon": {
        // Mastodon share - ask user for their instance
        const instance = await vscode.window.showInputBox({
          prompt: "Enter your Mastodon instance (e.g., mastodon.social)",
          placeHolder: "mastodon.social",
          value: "mastodon.social",
        });

        if (instance) {
          // Copy share text to clipboard, then open Mastodon compose
          await vscode.env.clipboard.writeText(shareText);
          const selection = await vscode.window.showInformationMessage(
            "Share text copied to clipboard! Paste it into your Mastodon post.",
            "Open Mastodon",
          );
          if (selection === "Open Mastodon") {
            await vscode.env.openExternal(
              vscode.Uri.parse(`https://${instance}/share`),
            );
          }
        }
        break;
      }
    }
  }

  /**
   * Saves the generated share-card image to a temp file, copies the caption to the clipboard,
   * and opens the chosen social platform so the user can paste and attach the image.
   */
  private async maturityHandleShareToSocial(platform: 'linkedin' | 'bluesky' | 'mastodon', dataUrl: string): Promise<void> {
    const base64Match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!base64Match) {
      void vscode.window.showErrorMessage('Failed to process share card image.');
      return;
    }

    let platformUrl: string;
    const marketplaceUrl = 'https://marketplace.visualstudio.com/items?itemName=RobBos.ai-engineering-fluency';
    switch (platform) {
      case 'linkedin':
        platformUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(marketplaceUrl)}`;
        break;
      case 'bluesky':
        platformUrl = 'https://bsky.app/intent/compose';
        break;
      case 'mastodon': {
        const instance = await vscode.window.showInputBox({
          prompt: 'Enter your Mastodon instance (e.g., mastodon.social)',
          placeHolder: 'mastodon.social',
          value: 'mastodon.social',
        });
        if (!instance) { return; }
        platformUrl = `https://${instance}/share`;
        break;
      }
      default:
        platformUrl = marketplaceUrl;
    }

    const fileName = `ai-engineering-fluency-share-${Date.now()}.png`;
    const tempDir = this.context.globalStorageUri
      ? vscode.Uri.joinPath(this.context.globalStorageUri, 'share-cards')
      : vscode.Uri.file(path.join(this.context.extensionPath, '.tmp', 'share-cards'));
    await vscode.workspace.fs.createDirectory(tempDir);
    const filePath = path.join(tempDir.fsPath, fileName);
    const uri = vscode.Uri.file(filePath);
    const buffer = Buffer.from(base64Match[1], 'base64');
    await vscode.workspace.fs.writeFile(uri, buffer);

    const shareText = l10n.t('shareText');
    await vscode.env.clipboard.writeText(shareText);
    await vscode.env.openExternal(vscode.Uri.parse(platformUrl));

    const selection = await vscode.window.showInformationMessage(
      'Share card image saved and caption copied to clipboard.',
      'Open Image',
    );
    if (selection === 'Open Image') {
      void vscode.env.openExternal(uri);
    }
    this.log(`Shared fluency score card to ${platform}`);
  }

  /**
   * Download the fluency chart as an image
   */
  private async downloadChartImage(): Promise<void> {
    await vscode.window.showInformationMessage(
      '💡 Click the "Download Chart Image" button to save the radar chart as a PNG file.',
      "Got it",
    );
    this.log("Showed chart download instructions");
  }

  private async saveChartImageData(dataUrl: string): Promise<void> {
    const base64Match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!base64Match) {
      void vscode.window.showErrorMessage(
        "Failed to process chart image data.",
      );
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("copilot-fluency-score.png"),
      filters: { "PNG Image": ["png"] },
      title: "Save Fluency Score Chart",
    });

    if (!uri) {
      return;
    }

    const buffer = Buffer.from(base64Match[1], "base64");
    await vscode.workspace.fs.writeFile(uri, buffer);
    void (async () => {
      const selection = await vscode.window.showInformationMessage(
        `Chart image saved to ${uri.fsPath}`,
        "Open Image",
      );
      if (selection === "Open Image") {
        void vscode.env.openExternal(uri);
      }
    })();
    this.log(`Chart image saved to ${uri.fsPath}`);
  }

  /**
   * Export Copilot Fluency Score as a landscape PDF with screenshot images
   */
  private async exportFluencyScorePdf(images: { label: string; dataUrl: string }[]): Promise<void> {
    try {
      const jsPDF = (await import("jspdf")).default;
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file("copilot-fluency-score.pdf"), filters: { "PDF Document": ["pdf"] }, title: "Export Fluency Score Report" });
      if (!uri) { return; }
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 10;
      for (let i = 0; i < images.length; i++) {
        if (i > 0) { pdf.addPage(); }
        this.pdfAddPage(pdf, images[i].dataUrl, i, images.length, pageWidth, pageHeight, margin);
      }
      const pdfBuffer = Buffer.from(pdf.output("arraybuffer"));
      await vscode.workspace.fs.writeFile(uri, pdfBuffer);
      void (async () => { const sel = await vscode.window.showInformationMessage(`Fluency Score PDF saved to ${uri.fsPath}`, "Open PDF"); if (sel === "Open PDF") { void vscode.env.openExternal(uri); } })();
      this.log(`Fluency Score PDF exported to ${uri.fsPath}`);
    } catch (error) {
      this.error("Failed to export PDF", error instanceof Error ? error : new Error(String(error)));
      void vscode.window.showErrorMessage(`Failed to export PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private pdfAddPage(pdf: any, imgData: string, pageIndex: number, totalPages: number, pageWidth: number, pageHeight: number, margin: number): void {
    pdf.setFontSize(8); pdf.setTextColor(128, 128, 128);
    pdf.text(l10n.t('pdfReportTitle', (pageIndex + 1).toString(), totalPages.toString()), margin, 7);
    pdf.text(new Date().toLocaleDateString(), pageWidth - margin, 7, { align: "right" });
    const availW = pageWidth - 2 * margin;
    const availH = pageHeight - 2 * margin - 5;
    const imgProps = pdf.getImageProperties(imgData);
    const scale = Math.min(availW / imgProps.width, availH / imgProps.height);
    const drawW = imgProps.width * scale; const drawH = imgProps.height * scale;
    const x = margin + (availW - drawW) / 2; const y = margin + 5 + (availH - drawH) / 2;
    pdf.addImage(imgData, "PNG", x, y, drawW, drawH);
    pdf.setFontSize(8); pdf.setTextColor(128, 128, 128);
    pdf.text(l10n.t('pdfGeneratedBy'), pageWidth / 2, pageHeight - 5, { align: "center" });
  }

  private async exportFluencyScorePptx(images: { label: string; dataUrl: string }[]): Promise<void> {
    try {
      const PptxGenJSModule = await import("pptxgenjs");
      const PptxGenJS = PptxGenJSModule.default as any;
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file("copilot-fluency-score.pptx"), filters: { "PowerPoint Presentation": ["pptx"] }, title: "Export Fluency Score as PowerPoint" });
      if (!uri) { return; }
      const pptx = new PptxGenJS();
      pptx.layout = "LAYOUT_WIDE"; pptx.author = l10n.t('pptxAuthor');
      pptx.subject = l10n.t('pptxSubject'); pptx.title = l10n.t('pptxTitle');
      const slideW = 13.33; const slideH = 7.5;
      const maxW = slideW - 0.8; const maxH = slideH - 1.0;
      for (const img of images) { this.pptxAddImageSlide(pptx, img.dataUrl, slideW, slideH, maxW, maxH); }
      const pptxBuffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
      await vscode.workspace.fs.writeFile(uri, pptxBuffer);
      void (async () => { const sel = await vscode.window.showInformationMessage(`Fluency Score PPTX saved to ${uri.fsPath}`, "Open File"); if (sel === "Open File") { void vscode.env.openExternal(uri); } })();
      this.log(`Fluency Score PPTX exported to ${uri.fsPath}`);
    } catch (error) {
      this.error("Failed to export PPTX", error instanceof Error ? error : new Error(String(error)));
      void vscode.window.showErrorMessage(`Failed to export PPTX: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private pptxGetImageSize(dataUrl: string, maxW: number, maxH: number): { w: number; h: number } {
    try {
      const base64 = dataUrl.split(",")[1];
      const buf = Buffer.from(base64, "base64");
      if (buf.length > 24 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const pxW = buf.readUInt32BE(16); const pxH = buf.readUInt32BE(20);
        if (pxW > 0 && pxH > 0) {
          const aspect = pxW / pxH;
          if (aspect > maxW / maxH) { return { w: maxW, h: maxW / aspect }; }
          return { w: maxH * aspect, h: maxH };
        }
      }
    } catch { /* fall back to max dimensions */ }
    return { w: maxW, h: maxH };
  }

  private pptxAddImageSlide(pptx: any, dataUrl: string, slideW: number, slideH: number, maxW: number, maxH: number): void {
    const slide = pptx.addSlide();
    slide.background = { color: "1b1b1e" };
    const { w: imgW, h: imgH } = this.pptxGetImageSize(dataUrl, maxW, maxH);
    const x = (slideW - imgW) / 2; const y = (slideH - 1.0 - imgH) / 2 + 0.1;
    slide.addImage({ data: dataUrl, x, y, w: imgW, h: imgH });
    slide.addText(l10n.t('pptxGeneratedBy'), { x: 0, y: 7.0, w: 13.33, h: 0.4, fontSize: 8, color: "808080", align: "center" });
  }

  public async showFluencyLevelViewer(): Promise<void> {
    const isDebugMode = false;

    this.log("🔍 Opening Scoring Guide");
    this.recordViewVisit('fluency-level-viewer');

    // If panel already exists, dispose and recreate with fresh data
    if (this.fluencyLevelViewerPanel) {
      this.fluencyLevelViewerPanel.dispose();
      this.fluencyLevelViewerPanel = undefined;
    }

    const fluencyLevelData = this.getFluencyLevelData(isDebugMode);

    this.fluencyLevelViewerPanel = vscode.window.createWebviewPanel(
      "copilotFluencyLevelViewer",
      "Scoring Guide",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
        ],
      },
    );

    this.fluencyLevelViewerPanel.webview.onDidReceiveMessage(
      async (message) => {
        if (this.handleLocalViewRegressionMessage(message)) { return; }
        if (await this.dispatchSharedCommand(message)) { return; }
        if (message.command === "refresh") {
          await this.dispatch('refresh:fluencyLevelViewer', () => this.refreshFluencyLevelViewerPanel());
        }
      },
    );

    this.fluencyLevelViewerPanel.webview.html = this.getFluencyLevelViewerHtml(
      this.fluencyLevelViewerPanel.webview,
      fluencyLevelData,
    );

    this.fluencyLevelViewerPanel.onDidDispose(() => {
      this.log("🔍 Fluency Level Viewer closed");
      this.fluencyLevelViewerPanel = undefined;
    });
  }

  private async refreshFluencyLevelViewerPanel(): Promise<void> {
    if (!this.fluencyLevelViewerPanel) {
      return;
    }

    const isDebugMode = false;
    this.log("🔄 Refreshing Scoring Guide");
    const fluencyLevelData = this.getFluencyLevelData(isDebugMode);
    this.fluencyLevelViewerPanel.webview.html = this.getFluencyLevelViewerHtml(
      this.fluencyLevelViewerPanel.webview,
      fluencyLevelData,
    );
    this.log("✅ Scoring Guide refreshed");
  }



  private getFluencyLevelData(isDebugMode: boolean): ReturnType<typeof _getFluencyLevelData> {
		return _getFluencyLevelData(isDebugMode);
  }

  private getFluencyLevelViewerHtml(
    webview: vscode.Webview,
    data: {
      categories: Array<{
        category: string;
        icon: string;
        levels: Array<{
          stage: number;
          label: string;
          description: string;
          thresholds: string[];
          tips: string[];
        }>;
      }>;
      isDebugMode: boolean;
    },
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "dist",
        "webview",
        "fluency-level-viewer.js",
      ),
    );

    const dataWithBackend = {
      ...data,
      backendConfigured: this.isBackendConfigured(),
      ...this.getWebviewLocaleFields(),
    };
    const initialData = JSON.stringify(dataWithBackend).replace(
      /</g,
      "\\u003c",
    );

    return `<!DOCTYPE html>
	<html lang="${webviewDocumentLanguage(vscode.env.language)}">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		${buildCspMeta(webview, nonce)}
		${getCodiconStylesheetTag(webview, this.extensionUri)}
		<title>Scoring Guide</title>
	</head>
	<body>
		<div id="root"></div>
		<script nonce="${nonce}">window.__INITIAL_FLUENCY_LEVEL_DATA__ = ${initialData};</script>
		${this.getJsonConfigScript(nonce)}
		${this.extensionPointButtonsScript(nonce)}
		${this.getLocalViewRegressionProbeScript('fluency-level-viewer', nonce)}
		<script nonce="${nonce}" src="${scriptUri}"></script>
	</body>
	</html>`;
  }

  private getMaturityHtml(
    webview: vscode.Webview,
    data: {
      overallStage: number;
      overallLabel: string;
      categories: {
        category: string;
        icon: string;
        stage: number;
        evidence: string[];
        tips: string[];
      }[];
      period: UsageAnalysisPeriod;
      lastUpdated: string;
      agenticTrend?: AgenticTrendPoint[];
      dismissedTips?: string[];
      isDebugMode?: boolean;
      installedHooks?: string[];
      fluencyLevels?: Array<{
        category: string;
        icon: string;
        levels: Array<{
          stage: number;
          label: string;
          description: string;
          thresholds: string[];
          tips: string[];
        }>;
      }>;
    },
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "maturity.js"),
    );

    const dataWithBackend = {
      ...data,
      backendConfigured: this.isBackendConfigured(),
      ...this.getWebviewLocaleFields(),
    };
    const initialData = JSON.stringify(dataWithBackend).replace(
      /</g,
      "\\u003c",
    );

    return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>${l10n.t('pptxTitle')}</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_MATURITY__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			${this.getLocalViewRegressionProbeScript('maturity', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

	// ── Efficiency view ───────────────────────────────────────────────

	/**
	 * Opens the Efficiency panel: weekly ratio trends, month-over-month deltas,
	 * cost-change attribution (volume vs. efficiency vs. model mix), and value signals.
	 */
	public async showEfficiency(): Promise<void> {
		this.log('⚡ Opening Efficiency view');
		this.recordViewVisit('efficiency');

		// Already open — just reveal it. Recomputing here would make re-focusing the
		// tab as slow as a cold open; the Refresh button is the way to get new data.
		if (this.efficiencyPanel) {
			this.efficiencyPanel.reveal();
			this.log('⚡ Efficiency view revealed (already exists)');
			return;
		}

		// Create the panel before computing anything so the tab appears immediately,
		// then swap the loading screen for the rendered view once the data is ready.
		this.efficiencyPanel = vscode.window.createWebviewPanel(
			'copilotEfficiency', 'AI Efficiency Trends',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			// `media` is needed for the shared loading screen's icon; `dist/webview` for the view bundle.
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(this.extensionUri, 'media'),
				],
			}
		);
		this.efficiencyPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message)) { return; }
			if (message.command === 'refresh') { await this.dispatch('refresh:efficiency', () => this.refreshEfficiencyPanel()); }
			if (message.command === 'efficiencyWebviewReady') {
				const replayed = await this.efficiencyMessageReplay.markReady();
				this.log(`📨 Efficiency webview ready (${message.reason ?? 'unknown'}); replayed: ${replayed.length ? replayed.join(', ') : 'nothing buffered'}`);
			}
		});
		this.efficiencyPanel.onDidDispose(() => {
			this.log('⚡ Efficiency view closed');
			this.efficiencyPanel = undefined;
			// Transient per-document state: a later cold open derives Value from the latest
			// Repository PR snapshot on its own.
			this.efficiencyMessageReplay.reset();
			this._lastEfficiencyViewData = undefined;
		});

		const panel = this.efficiencyPanel;
		this.installEfficiencyDocument(panel, this.getLoadingHtml(panel.webview));

		// Build the data in the background rather than awaiting it here: showEfficiency() is
		// wrapped in dispatch()'s in-flight guard, which only releases the 'showEfficiency' key
		// once this function returns. Awaiting the (potentially long) data build would keep that
		// key locked — if the user closes the panel and reopens it before the build finishes, the
		// reopen would be silently dropped as "already in flight" (same fix as showChart above).
		void (async () => {
			let generation = this._cacheGeneration;
			try {
				const data = await this.runEfficiencyBuild(startedAt => {
					generation = startedAt;
					return this.buildEfficiencyViewData(false, this.efficiencyLoadingSink(), generation);
				});
				// Record the payload even if this panel is gone: it is valid data, and a later
				// refresh falls back to it rather than stranding its panel on the loading screen.
				// A payload the caches have outlived is not rendered: the clear that invalidated
				// it is precisely a statement that this data is no longer current. Nothing else
				// will redraw this panel though — clearCache() refreshes the token stats, not
				// this view — so rebuild rather than leaving the loading screen up forever.
				if (!this.recordEfficiencyPayload(data, generation)) {
					if (this.efficiencyPanel === panel) { this.requestEfficiencyRebuild(); }
					return;
				}
				// The user may have closed the panel while the data was being computed.
				if (this.efficiencyPanel !== panel) { return; }
				await this.renderEfficiencyData(panel, data);
				this.log('⚡ Efficiency view rendered');
			} catch (error) {
				this.error('Error building Efficiency view:', error);
				this.releaseEfficiencyRebuildRequest(generation);
				this.showEfficiencyError(panel, error);
			}
		})();
	}

	private async refreshEfficiencyPanel(): Promise<void> {
		const panel = this.efficiencyPanel;
		if (!panel) { return; }
		this.log('🔄 Refreshing Efficiency view');
		// Refresh forces all three walks to recompute, so it is as slow as a cold open —
		// show the same loading screen with live progress rather than a frozen view.
		let data: EfficiencyViewData;
		// Captured inside the queued callback, not here: a refresh waiting behind another build
		// reads the caches as they are when it finally runs, so a clear that lands during that
		// wait leaves it building from post-clear state, not stale state.
		let generation = this._cacheGeneration;
		try {
			data = await this.runEfficiencyBuild(async startedAt => {
				generation = startedAt;
				// Swap in the loading screen only once this refresh actually starts; queued
				// behind an initial build, it would otherwise blank the panel and sit there.
				if (this.efficiencyPanel === panel) { this.installEfficiencyDocument(panel, this.getLoadingHtml(panel.webview)); }
				return this.buildEfficiencyViewData(true, this.efficiencyLoadingSink(), generation);
			});
			// Same reasoning as the initial build: show something now — the last good payload if
			// the clear left one, else the failure state — and queue the rebuild that replaces it.
			//
			// This path used to queue nothing, on the grounds that "this *is* the refresh, so
			// re-entering it would loop". That was wrong: requestEfficiencyRebuild() records the
			// generation it requested for, so a second request at the same generation no-ops and a
			// loop would need a fresh bump every round. clearCache() hid the gap by requesting the
			// rebuild itself; refreshAnalysisPanel() bumps the generation and does not, so an
			// Efficiency refresh spanning one was left showing the fallback or the staleAfterClear
			// state with nothing queued to correct it.
			if (!this.recordEfficiencyPayload(data, generation)) {
				if (this.efficiencyPanel !== panel) { return; }
				const afterClear = this._lastEfficiencyViewData;
				// A fallback is still a freshly installed document, so it goes through the same
				// door as a normal render: buffer reset, then Value re-derived for it. Rendering
				// it directly would leave the previous document's retained snapshot armed and the
				// new one showing whatever PR data the fallback payload was built with.
				if (afterClear) { await this.renderEfficiencyData(panel, afterClear); }
				else { this.showEfficiencyError(panel, new Error(l10n.t('efficiency.error.staleAfterClear'))); }
				this.requestEfficiencyRebuild();
				return;
			}
		} catch (error) {
			// Never strand the panel on the loading screen: fall back to the last good payload,
			// which the initial build records even when its own render was skipped.
			this.error('Error refreshing Efficiency view:', error);
			this.releaseEfficiencyRebuildRequest(generation);
			const previous = this._lastEfficiencyViewData;
			if (this.efficiencyPanel !== panel) { return; }
			if (previous) { await this.renderEfficiencyData(panel, previous); }
			else { this.showEfficiencyError(panel, error); }
			return;
		}
		if (this.efficiencyPanel !== panel) { return; }
		await this.renderEfficiencyData(panel, data);
	}

	/**
	 * Installs a freshly built Efficiency document and reconciles its Value tab.
	 *
	 * Both render paths are async, so a Repository PRs result can land *while* the data is being
	 * built — it would then be baked into neither the replaced document (built too early) nor a
	 * live update (the old document is gone). Re-deriving Value here from the current snapshot and
	 * publishing it when it disagrees with what was just rendered closes that race; the replay
	 * buffer holds the message until the new document announces readiness.
	 */
	private async renderEfficiencyData(panel: vscode.WebviewPanel, data: EfficiencyViewData): Promise<void> {
		this._lastEfficiencyViewData = data;
		this.installEfficiencyDocument(panel, this.getEfficiencyHtml(panel.webview, data));
		await this.notifyEfficiencyValueSignals();
	}

	/**
	 * The one place the Efficiency panel's HTML is replaced.
	 *
	 * Installing a document invalidates the Value replay buffer: a retained snapshot is only
	 * meaningful for the document it was derived for. Routing every swap through here — the two
	 * loading screens, the failure state, and the rendered view — is what keeps that true without
	 * each call site remembering to, and keeps "does this path reset?" answerable by grep.
	 */
	private installEfficiencyDocument(panel: vscode.WebviewPanel, html: string): void {
		this.efficiencyMessageReplay.reset();
		panel.webview.html = html;
	}

	/**
	 * Posts a Value-only update to the live Efficiency document when the Repository PR snapshot
	 * moves its metrics.
	 *
	 * Only the Value fragment is derived and sent: no log scan, no trend recomputation and no
	 * `webview.html` replacement, so the selected tab, the Models-tab controls and the live charts
	 * all survive. Cloud-agent task loads deliberately never reach here — `aiPrs` counts
	 * bot-authored pull requests, not cloud-agent tasks.
	 */
	private async notifyEfficiencyValueSignals(): Promise<void> {
		const rendered = this._lastEfficiencyViewData;
		if (!this.efficiencyPanel || !rendered) { return; }
		const stats = this._lastRepoPrStats;
		// The instant placeholder served on cold open carries no PR data at all, so it says nothing
		// about the Value metrics. An unauthenticated snapshot *is* definitive though: it means "no
		// PR data", which is what turns populated cards back into the hint.
		if (stats && stats.authenticated && !isRealRepoPrSnapshot(stats)) { return; }
		const value = this.deriveEfficiencyValueSignals(rendered);
		if (_valueSignalsEqual(value, rendered.value)) { return; }
		this._lastEfficiencyViewData = { ...rendered, value };
		const { delivered, wasReady } = await this.efficiencyMessageReplay.publish(
			'valueSignals', { command: 'valueSignalsUpdated', value },
		);
		this.log(`⚡ Efficiency Value signals posted (prs=${value.userPrs ?? 'none'}, delivered=${delivered}, webviewReady=${wasReady})`);
	}

	/**
	 * Rebuilds the Value snapshot from the rendered view's own cost / apply / LOC totals plus the
	 * current PR aggregate — the lightweight alternative to re-running `buildEfficiencyViewData()`.
	 *
	 * `now` comes from the rendered snapshot so repeated derivations over an unchanged PR
	 * aggregate produce a byte-identical result (`prsPerWeek` divides by elapsed time), which is
	 * what makes the "did anything change?" comparison meaningful.
	 */
	private deriveEfficiencyValueSignals(rendered: EfficiencyViewData): ValueSignals {
		const v = rendered.value;
		return _computeValueSignals({
			...this.repoPrValueInputs(),
			periodCost: v.periodCost,
			applyUsage: { totalApplies: v.appliedBlocks, totalCodeBlocks: v.totalBlocks, applyRate: v.applyRate ?? 0 },
			linesChanged: v.linesChanged,
			now: new Date(rendered.lastUpdated),
		});
	}

	/**
	 * The PR half of the Value metrics. Null counts mean "Repository PRs were never loaded", which
	 * the Value tab renders as its actionable hint rather than as zeroes.
	 */
	private repoPrValueInputs(): Pick<ValueSignalsInput, 'userPrs' | 'mergedPrs' | 'aiPrs' | 'prsSince'> {
		// Same "is there really PR data?" test the update path uses: summing the cold-open
		// placeholder's empty repo list would render 0-PR cards instead of the never-loaded hint,
		// while an authenticated snapshot that really was fetched renders its zeroes as zeroes.
		const last = this._lastRepoPrStats;
		const prStats = last?.authenticated && isRealRepoPrSnapshot(last) ? last : undefined;
		const sumRepos = (pick: (r: RepoPrInfo) => number | undefined): number | null =>
			prStats ? prStats.repos.reduce((s, r) => s + (pick(r) ?? 0), 0) : null;
		return {
			userPrs: sumRepos(r => r.userAuthoredPrs),
			mergedPrs: sumRepos(r => r.userMergedPrs),
			aiPrs: sumRepos(r => r.aiAuthoredPrs),
			prsSince: prStats?.since ?? null,
		};
	}

	/** Maps one cached session to the pure-module input shape for efficiency trends. */
	private toEfficiencySessionInput(sessionData: SessionFileCache, mtime: number, editor?: string): EfficiencySessionInput {
		const dayKey = this.computeLastActivityKey(sessionData, mtime);
		const ua = sessionData.usageAnalysis;
		let editTurns = 0, retries = 0;
		for (const c of Object.values(ua?.modelEfficiency ?? {})) { editTurns += c.editTurns; retries += c.retries; }
		const skillCalls = ua?.skillCalls?.byName && Object.keys(ua.skillCalls.byName).length > 0
			? ua.skillCalls.byName
			: undefined;
		return {
			dayKey,
			activeDurationMs: ua?.sessionDuration?.activeDurationMs,
			editTurns,
			retries,
			applies: ua?.applyUsage?.totalApplies,
			codeBlocks: ua?.applyUsage?.totalCodeBlocks,
			interactions: sessionData.interactions,
			totalTokens: preferActualTokens(sessionData.actualTokens, sessionData.tokens),
			skillCalls,
			editor,
		};
	}

	/**
	 * Collect per-session inputs (duration, retries, apply usage, skill calls) for the
	 * trailing trend weeks.
	 *
	 * This walks every session file in the window, which is the most expensive part of
	 * building the Efficiency view, so the result is memoized alongside the other
	 * `last*` stat caches and invalidated by the same paths.
	 */
	private async collectEfficiencySessionInputs(
		weeksBack = 12, useCache = true, originGeneration?: number,
	): Promise<EfficiencySessionInput[]> {
		const cachedInputs = this.currentEfficiencySessionInputs;
		if (useCache && cachedInputs) {
			this.log('⚡ [Efficiency] Using cached session inputs');
			return cachedInputs;
		}
		const startedAtGeneration = originGeneration ?? this._cacheGeneration;
		const now = new Date();
		const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - weeksBack * 7);
		const inputs: EfficiencySessionInput[] = [];
		try {
			const { results } = await this.loadUsageSessionFiles(undefined, cutoff.getTime());
			for (const r of results) {
				if (!r || r.sessionData.interactions === 0) { continue; }
				// Must be the same resolver `calculateDailyStats` uses for `editorUsage`,
				// or an editor filter would match the daily aggregates and miss the
				// session-derived behaviour for the same editor.
				inputs.push(this.toEfficiencySessionInput(r.sessionData, r.mtime, this.getEditorTypeFromPath(r.sessionFile)));
			}
			this.lastEfficiencySessionInputs = inputs;
			this._statsGeneration.sessionInputs = startedAtGeneration;
		} catch (error) {
			this.error('Error collecting efficiency session inputs:', error);
		}
		return inputs;
	}

	/** Sums token/session/cost totals for the daily entries within one calendar month (YYYY-MM). */
	private monthVolumeTotals(dailyStats: DailyTokenStats[], monthKey: string): PeriodVolumeTotals {
		let tokens = 0, sessions = 0, estimatedCost = 0;
		for (const day of dailyStats) {
			if (day.date.slice(0, 7) !== monthKey) { continue; }
			tokens += day.tokens;
			sessions += day.sessions;
			estimatedCost += this.calculateEstimatedCost(day.modelUsage, 'copilot');
		}
		return { tokens, sessions, estimatedCost };
	}

	/**
	 * Trims the daily stats down to the per-model slice the Models tab needs, over
	 * the last year so month-vs-month comparisons have history to draw on. Days
	 * without per-model data are dropped to keep the webview payload small.
	 */
	private buildModelDailyPayload(dailyStats: DailyTokenStats[], now: Date): ModelDailyInput[] {
		// Same snapped cutoff as the volume payload: the 1-year preset starts on
		// the first of the month, so a flat 365-day window would leave the drift
		// chart's earliest bucket short of up to a month of data.
		const cutoffKey = _resolveEfficiencyRange('last1y', now).startKey;
		const payload: ModelDailyInput[] = [];
		for (const day of dailyStats) {
			if (day.date < cutoffKey || !day.modelEfficiency || Object.keys(day.modelEfficiency).length === 0) { continue; }
			const split = _splitModelDayByEditor(day);
			payload.push(...(split.length > 0 ? split : [{
				date: day.date,
				modelEfficiency: day.modelEfficiency,
				...(day.taskCategoryUsage ? { taskCategoryUsage: day.taskCategoryUsage } : {}),
			}]));
		}
		return payload;
	}

	/**
	 * Compact per-day volume aggregates for the trailing year — the payload the
	 * Efficiency view's time presets, drill-down and editor filter recompute
	 * from. Numbers only: no session titles, paths, prompts or repositories.
	 */
	private buildEfficiencyDailyVolumePayload(dailyStats: DailyTokenStats[], now: Date, deps: EfficiencyDeps): EfficiencyDailyVolume[] {
		// Cut off at the start of the widest preset rather than a flat day count:
		// the 1-year preset snaps back to the first of the month, so a plain
		// 365-day window would leave its earliest month half-empty.
		const cutoffKey = _resolveEfficiencyRange('last1y', now).startKey;
		return _toEfficiencyDailyVolume(dailyStats.filter(d => d.date >= cutoffKey), deps);
	}

	/**
	 * Formats one boundary of a Cost Attribution window. The ranges sit next to
	 * localized table labels, so they follow the VS Code display language rather
	 * than a hardcoded en-US. VS Code can report a tag Intl rejects (the
	 * 'qps-ploc' pseudo-locale), which throws a RangeError, so an unusable tag
	 * falls back to en-US instead of taking the whole view down.
	 */
	private formatAttributionDate(date: Date): string {
		const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
		try {
			return date.toLocaleDateString(vscode.env.language || undefined, options);
		} catch {
			return date.toLocaleDateString('en-US', options);
		}
	}

	/**
	 * Percentages the Efficiency build reports for its compute sub-steps. The file walk
	 * owns everything below the first of these, so the bar climbs with parsing and then
	 * keeps moving through aggregation instead of parking at one number for the wait.
	 */
	private static readonly EFFICIENCY_STEP_PCT = {
		daily: 88, usage: 92, sessions: 96, trends: 98,
	} as const;

	/**
	 * Percentages the main updateTokenStats() refresh reports for its own compute sub-steps,
	 * mirroring EFFICIENCY_STEP_PCT above. Parsing owns everything below the first of these
	 * (see loadingHtml.ts's 85%/compute-phase split); without sub-steps here the bar parked at
	 * a fixed 96% for the whole compute phase on any panel (Environmental) that doesn't swap
	 * away from the loading screen until this run fully returns. Stops at `fluency`: Details/
	 * Environmental are published right after that step (see publishRefreshResult()), before
	 * evaluateAndSurfaceInsights() — which can await an interactive toast — ever runs, so a
	 * fourth "finalizing insights" sub-step would never actually be seen on a loading screen.
	 */
	private static readonly REFRESH_STEP_PCT = {
		stats: 88, analysis: 92, fluency: 96,
	} as const;

	/**
	 * The Efficiency panel's failure state.
	 *
	 * Every path that swaps in the loading screen needs somewhere to land when the build
	 * throws and there is no last-good payload to fall back to — a first open that fails, or
	 * a refresh after the caches were cleared. Returning silently in those cases left the
	 * panel on the loading screen for the rest of the session.
	 */
	private getEfficiencyErrorHtml(webview: vscode.Webview, error: unknown): string {
		const nonce = getNonce();
		// The detail is an error message, which can carry a file path or arbitrary text.
		const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const detail = esc(String(error instanceof Error ? error.message : error));
		return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			<title>${l10n.t('efficiency.error.title')}</title>
		</head>
		<body style="font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-foreground);">
			<h2 style="margin:0 0 8px;">${esc(l10n.t('efficiency.error.title'))}</h2>
			<p style="color:var(--vscode-descriptionForeground);margin:0 0 16px;">${detail}</p>
			<button id="retry" style="padding:6px 14px;cursor:pointer;border:none;border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);">${esc(l10n.t('efficiency.error.retry'))}</button>
			<script nonce="${nonce}">
				const vscodeApi = acquireVsCodeApi();
				document.getElementById('retry').addEventListener('click', () => vscodeApi.postMessage({ command: 'refresh' }));
			</script>
		</body>
		</html>`;
	}

	/** Renders the failure state on `panel`, if it is still the live Efficiency panel. */
	private showEfficiencyError(panel: vscode.WebviewPanel, error: unknown): void {
		if (this.efficiencyPanel !== panel) { return; }
		this.installEfficiencyDocument(panel, this.getEfficiencyErrorHtml(panel.webview, error));
	}

	/**
	 * Records a built payload as the fallback a failed refresh renders, unless the caches it
	 * was computed from have been invalidated since the build began. Without that check a
	 * build started before `clearCache()` could finish after it and reinstate pre-clear data
	 * as the "last good" result.
	 */
	private recordEfficiencyPayload(data: EfficiencyViewData, builtAtGeneration: number): boolean {
		if (builtAtGeneration !== this._cacheGeneration) {
			this.log('⚡ [Efficiency] Discarding a payload built before the caches were cleared');
			return false;
		}
		this._lastEfficiencyViewData = data;
		this._efficiencyBuildCompletedFor = builtAtGeneration;
		return true;
	}

	/**
	 * Reports one Efficiency compute sub-step to the panel showing *its* loading screen.
	 *
	 * Deliberately not routed through sendLoadingPanelMessage(): that also reaches the details
	 * panel, whose loading screen is tracking updateTokenStats() rather than this build, so
	 * these labels would describe work it is not doing.
	 */
	private postEfficiencyStep(send: (msg: object) => void, percentage: number, label: string): void {
		send({ command: 'loadingStep', step: 'computing', percentage, label });
	}

	/**
	 * The three aggregation passes behind the Efficiency view, reporting each as a named
	 * sub-step so the loading bar keeps moving through them.
	 *
	 * Only the first parses cold files. It covers the widest window (a full year), and the
	 * other two read strict subsets of it straight out of the in-memory session cache it
	 * fills, so per-file progress is reported from that walk rather than from a separate
	 * warm-up pass over the same corpus.
	 */
	private async collectEfficiencyInputs(
		forceRecalc: boolean, send: (msg: object) => void, originGeneration: number | undefined,
	): Promise<{
		dailyStats: DailyTokenStats[]; usage: UsageAnalysisStats; sessionInputs: EfficiencySessionInput[];
	}> {
		const stepPct = CopilotTokenTracker.EFFICIENCY_STEP_PCT;
		let dailyStats: DailyTokenStats[];
		const cachedDaily = this.currentFullDailyStats;
		if (!forceRecalc && cachedDaily) {
			this.postEfficiencyStep(send, stepPct.daily, l10n.t('loading.efficiency.dailyActivity'));
			dailyStats = cachedDaily;
		} else {
			// No compute sub-step before the walk. The bar is monotonic and parsing owns only
			// its lower band, so posting one here would pin the bar above that band and freeze
			// it for the whole parse — the exact failure this view had at 96%. The walk's own
			// parsing ticks drive the bar instead.
			// The walk hands over the editors it has seen, so the Efficiency loader grows the
			// same pills the details loader does instead of an always-empty row.
			let seen: ReadonlySet<string> = new Set<string>();
			const report = this.buildProgressCallback(
				true,
				() => [...seen].map(name => ({ icon: this.getEditorIconForLoader(name), name })),
				send,
			);
			// Tracked (not just awaited locally) so a concurrent clearCache() can wait it out too —
			// see _pendingFullYearBackfills' own doc comment.
			dailyStats = await this.trackFullYearBackfill(this.calculateDailyStats(365, undefined, (completed, total, editors) => {
				seen = editors;
				report(completed, total);
			}));
			// Announced *after* the walk, not before it. Before, it would pin the bar above
			// parsing's band and freeze it for the whole parse; after, it is a step up from 85%
			// and the phase the PR advertises is shown on the cold open too, not only when the
			// year was already cached.
			this.postEfficiencyStep(send, stepPct.daily, l10n.t('loading.efficiency.dailyActivity'));
		}
		this.postEfficiencyStep(send, stepPct.usage, l10n.t('loading.efficiency.usageAnalysis'));
		// Both of these start *after* the full-year walk above, which repopulates the raw session
		// cache. A clearCache() landing during that walk leaves pre-clear entries in it, and these
		// two then read them as cache hits — so they are stamped with the generation this build's
		// inputs were gathered in, not the newer one they happen to start in.
		const usage = await this.calculateUsageAnalysisStats(!forceRecalc, undefined, originGeneration);
		this.postEfficiencyStep(send, stepPct.sessions, l10n.t('loading.efficiency.sessionSignals'));
		const sessionInputs = await this.collectEfficiencySessionInputs(EFFICIENCY_BEHAVIOR_WEEKS, !forceRecalc, originGeneration);
		this.postEfficiencyStep(send, stepPct.trends, l10n.t('loading.efficiency.buildingTrends'));
		return { dailyStats, usage, sessionInputs };
	}

	private async buildEfficiencyViewData(
		forceRecalc = false,
		send: (msg: object) => void = () => { /* no loading screen to report to */ },
		originGeneration?: number,
	): Promise<EfficiencyViewData> {
		const now = new Date();
		const { dailyStats, usage, sessionInputs } = await this.collectEfficiencyInputs(forceRecalc, send, originGeneration);
		const deps = {
			calculateEstimatedCost: (mu: ModelUsage, src: 'provider' | 'copilot') => this.calculateEstimatedCost(mu, src),
			now,
		};
		const weekly = _buildEfficiencyTrends(dailyStats, sessionInputs, deps);
		const modelDaily = this.buildModelDailyPayload(dailyStats, now);
		const dailyVolume = this.buildEfficiencyDailyVolumePayload(dailyStats, now, deps);
		const skillTrends = _buildSkillUsageTrends(sessionInputs, deps);
		const skillImpact = _computeSkillImpact(sessionInputs);
		const { prevDays, curDays } = _splitTrailingWindows(dailyStats, now);
		const attributionBoundaries = _getTrailingWindowBoundaries(now);
		const attribution = _computeCostAttribution(prevDays, curDays, deps);
		const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
		const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
		const deltas = _computeEfficiencyDeltas(
			usage.month, usage.lastMonth,
			this.monthVolumeTotals(dailyStats, monthKey),
			this.monthVolumeTotals(dailyStats, lastMonthKey),
		);
		const curCost = curDays.reduce((s, d) => s + this.calculateEstimatedCost(d.modelUsage, 'copilot'), 0);
		const curLoc = curDays.reduce((s, d) => s + (d.linesAdded ?? 0) + (d.linesRemoved ?? 0), 0);
		const value = _computeValueSignals({
			...this.repoPrValueInputs(),
			periodCost: curCost,
			applyUsage: usage.last30Days.applyUsage,
			linesChanged: curLoc,
			now,
		});
		return {
			weekly,
			hasLoc: weekly.some(w => w.loc > 0),
			hasDuration: weekly.some(w => w.activeMinutesPerSession !== null),
			hasRetry: weekly.some(w => w.retryRate !== null),
			hasApply: weekly.some(w => w.applyRate !== null),
			attribution,
			attributionWindows: {
				prev: 'previous 30 days',
				cur: 'last 30 days',
				prevRange: `${this.formatAttributionDate(attributionBoundaries.prevStart)}–${this.formatAttributionDate(attributionBoundaries.prevEnd)}`,
				curRange: `${this.formatAttributionDate(attributionBoundaries.curStart)}–${this.formatAttributionDate(attributionBoundaries.curEnd)}`,
			},
			deltas,
			deltaWindows: {
				prev: lastMonthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
				cur: `${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} (to date)`,
			},
			value,
			skillTrends,
			skillImpact,
			hasSkills: skillTrends.totalCalls > 0,
			modelDaily,
			hasModelComparison: _listComparableModels(modelDaily).filter(m => m.sampleSufficient).length >= 2,
			dailyVolume,
			sessionSamples: sessionInputs,
			editors: _listEfficiencyEditors(dailyVolume),
			behaviorWindowDays: EFFICIENCY_BEHAVIOR_WEEKS * 7,
			cacheBreakage: usage.last30Days.cacheBreakage ?? null,
			lastUpdated: now.toISOString(),
			backendConfigured: this.isBackendConfigured(),
			compactNumbers: this.getCompactNumbersSetting(),
			// Same detected locale the Usage Analysis view formats with, so both
			// views group numbers and place currency symbols identically.
			locale: usage.locale,
			isDebugMode: this.context.extensionMode === vscode.ExtensionMode.Development,
		};
	}

	private getEfficiencyHtml(webview: vscode.Webview, data: EfficiencyViewData): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'efficiency.js'),
		);
		const dataWithLocalization = {
			...data,
			...this.getWebviewLocaleFields(),
		};
		const initialData = JSON.stringify(dataWithLocalization).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>AI Efficiency Trends</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_EFFICIENCY__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

  /**
   * Opens the Team Dashboard panel showing personal and team usage comparison.
   */
  public async showDashboard(): Promise<void> {
    this.log("📊 Opening Team Dashboard");
    this.recordViewVisit('dashboard');
    if (!this.isBackendConfigured()) {
      vscode.window.showWarningMessage("Team Dashboard requires backend sync to be configured. Please configure backend settings first.");
      return;
    }
    if (this.dashboardPanel) { this.dashboardPanel.reveal(); this.log("📊 Team Dashboard revealed (already exists)"); return; }
    const backendConfig = this.getDashboardBackendConfig();
    this.dashboardPanel = vscode.window.createWebviewPanel(
      "copilotDashboard", "Team Dashboard",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")] },
    );
    this.dashboardPanel.webview.html = this.getDashboardHtml(this.dashboardPanel.webview, undefined);
    this.dashboardPanel.webview.onDidReceiveMessage(async (message) => {
      if (await this.dispatchSharedCommand(message)) { return; }
      switch (message.command) {
        case "refresh": await this.dispatch('refresh:dashboard', () => this.refreshDashboardPanel()); break;
        case "configureBackend": await this.dispatch('configureBackend:dashboard', () => vscode.commands.executeCommand("aiEngineeringFluency.configureBackend")); break;
        case "configureTeamServer": await this.dispatch('configureTeamServer:dashboard', () => vscode.commands.executeCommand("aiEngineeringFluency.configureTeamServer")); break;
        case "deleteUserDataset": await this.dispatch('deleteUserDataset', () => this.handleDeleteUserDataset(message.userId, message.datasetId)); break;
        case "backfillHistoricalData": await this.dispatch('backfillHistoricalData', () => this.handleBackfillHistoricalData()); break;
        case "openExternal": if (typeof message.url === 'string') { await vscode.env.openExternal(vscode.Uri.parse(message.url)); } break;
      }
    });
    this.dashboardPanel.onDidDispose(() => { this.log("📊 Team Dashboard closed"); this.dashboardPanel = undefined; });
    if (backendConfig.azureConfigured) { await this.loadDashboardAzureData(); }
  }

  private async loadDashboardAzureData(): Promise<void> {
    if (!this.dashboardPanel) { return; }
    if (this.lastDashboardData) {
      this.log("📊 Sending cached dashboard data immediately");
      this.dashboardPanel.webview.postMessage({ command: "dashboardData", data: this.lastDashboardData });
    }
    try {
      const dashboardData = await this.getDashboardData();
      this.lastDashboardData = dashboardData;
      this.dashboardPanel?.webview.postMessage({ command: "dashboardData", data: dashboardData });
    } catch (error) {
      this.error("Failed to load dashboard data:", error);
      if (!this.lastDashboardData) {
        this.showDashboardFailure(this.getAzureDashboardFailureMessage("load dashboard data"));
      }
    }
  }

  private async refreshDashboardPanel(): Promise<void> {
    if (!this.dashboardPanel) {
      return;
    }

    const { azureConfigured } = this.getDashboardBackendConfig();
    if (!azureConfigured) {
      // Team server only -- nothing to refresh (the panel is a launch card)
      return;
    }

    this.log("🔄 Refreshing Team Dashboard");
    this.dashboardPanel.webview.postMessage({ command: "dashboardLoading" });
    try {
      const dashboardData = await this.getDashboardData();
      this.lastDashboardData = dashboardData;
      this.dashboardPanel?.webview.postMessage({
        command: "dashboardData",
        data: dashboardData,
      });
      this.log("✅ Team Dashboard refreshed");
    } catch (error) {
      this.error("Failed to refresh dashboard:", error);
      this.showDashboardFailure(this.getAzureDashboardFailureMessage("refresh dashboard data"));
    }
  }

  /**
   * Handle per-row delete from the Team Dashboard.
   * Shows a confirmation dialog, deletes table entities, then refreshes.
   */
  private async handleDeleteUserDataset(
    userId: string,
    datasetId: string,
  ): Promise<void> {
    if (!this.backend || !userId || !datasetId) {
      return;
    }

    const conf = ConfirmationMessages.deleteUserDataset(userId, datasetId);
    const choice = await vscode.window.showWarningMessage(
      conf.message,
      { modal: true, detail: conf.detail },
      conf.button,
    );

    if (choice !== conf.button) {
      return;
    }

    this.log(`🗑️ Deleting data for user "${userId}" in dataset "${datasetId}"`);
    this.dashboardPanel?.webview.postMessage({ command: "dashboardLoading" });

    try {
      const result = await this.backend.deleteUserDataset(userId, datasetId);
      if (result.errors.length > 0) {
        this.warn(
          `Partial deletion: ${result.deletedCount} deleted, ${result.errors.length} errors`,
        );
        vscode.window.showWarningMessage(
          `Deleted ${result.deletedCount} entries with ${result.errors.length} errors. Dashboard will refresh.`,
        );
      } else {
        this.log(
          `✅ Deleted ${result.deletedCount} entries for user "${userId}" in dataset "${datasetId}"`,
        );
        vscode.window.showInformationMessage(
          `Deleted ${result.deletedCount} data entries for "${userId}".`,
        );
      }

      // Refresh the dashboard with fresh data
      await this.refreshDashboardPanel();
    } catch (error) {
      this.error("Failed to delete user dataset:", error);
      this.showDashboardFailure(this.getAzureDashboardFailureMessage("delete Azure Storage data"));
    }
  }

  /**
   * Calculates a fluency stage (1-4) for a team member based on aggregated Azure Table Storage metrics.
   * Applies the same 6-category scoring thresholds as calculateMaturityScores().
   */

  /**
   * Backfill historical token data to Azure Table Storage by scanning all local session files
   * without the normal mtime-based age filter.
   */
  private async handleBackfillHistoricalData(): Promise<void> {
    if (!this.backend) {
      return;
    }

    this.log('🔄 Starting historical data backfill...');
    this.dashboardPanel?.webview.postMessage({
      command: 'backfillProgress',
      text: 'Backfill starting — scanning local session files...',
      processed: 0,
      total: 0,
      daysFound: 0,
    });

    try {
      await this.backend.backfillHistoricalData(365, (processed, total, daysFound) => {
        // processed === -1 is a sentinel signalling the upload phase (total = entity count, daysFound = days)
        const text = processed === -1
          ? `Backfill: uploading ${total} entries for ${daysFound} days to Azure...`
          : `Backfill in progress: ${processed}${total > 0 ? `/${total}` : ''} files scanned, ${daysFound} days found...`;
        this.dashboardPanel?.webview.postMessage({
          command: 'backfillProgress',
          text,
          processed,
          total,
          daysFound,
        });
      });
      this.log('✅ Historical data backfill complete');
      vscode.window.setStatusBarMessage('$(check) Backfill complete. Refreshing dashboard...', 5000);
      // Invalidate the cached dashboard data so the refresh reflects the new backfill
      this.lastDashboardData = undefined;
      await this.refreshDashboardPanel();
    } catch (error) {
      this.error('Backfill failed:', error);
      this.showDashboardFailure(this.getAzureDashboardFailureMessage("backfill Azure Storage data"));
    }
  }

  /**
   * Fetches and aggregates data for the Team Dashboard.
   */
  private async getDashboardData(): Promise<any> {
    if (!this.backend) { throw new Error("Backend not configured"); }
    const { BackendUtility } = await import("./backend/services/utilityService.js");
    const { computeBackendSharingPolicy, hashMachineIdForTeam } = await import("./backend/sharingProfile.js");
    const settings = this.backend.getSettings();
    this.log(`[Dashboard] Backend settings - userIdentityMode: ${settings.userIdentityMode}, configured userId: "${settings.userId}", datasetId: "${settings.datasetId}"`);
    const sharingPolicy = computeBackendSharingPolicy({ enabled: settings.enabled ?? true, profile: settings.sharingProfile ?? 'off', shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames ?? false });
    const currentUserId = await this.backend.resolveEffectiveUserId(settings);
    const currentMachineId = this.resolveCurrentMachineId(settings, sharingPolicy, hashMachineIdForTeam);
    if (!currentUserId && !currentMachineId) {
      this.warn("[Dashboard] No user identity available. Ensure sharing profile includes user dimension.");
      this.warn(`[Dashboard] Settings: mode=${settings.userIdentityMode}, userId="${settings.userId}"`);
    }
    const now = new Date();
    const todayKey = BackendUtility.toUtcDayKey(now);
    const startKey = BackendUtility.addDaysUtc(todayKey, -(settings.lookbackDays - 1));
    const allEntities = await this.backend.getAllAggEntitiesForRange(settings, startKey, todayKey);
    this.logDashboardDebugInfo(allEntities, currentUserId, todayKey, startKey);
    const { personalData, userMap, userFluencyMap, firstDate, lastDate } = this.aggregateDashboardEntities(allEntities, currentUserId, currentMachineId, sharingPolicy);
    const personalCost = this.calculateEstimatedCost(personalData.modelUsage);
    for (const userData of userMap.values()) { userData.cost = (userData.tokens / 1000000) * 0.05; }
    const teamMembers = this.buildTeamLeaderboard(userMap, userFluencyMap);
    this.log(`[Dashboard] Date range: ${firstDate} to ${lastDate} (${teamMembers.length} team members)`);
    this.log(`[Dashboard] Personal stats: ${personalData.totalTokens} tokens, ${personalData.totalInteractions} interactions, ${personalData.devices.size} devices, ${personalData.workspaces.size} workspaces`);
    for (const [userKey, data] of userMap.entries()) {
      const [uId, dsId] = userKey.split("|");
      this.log(`[Dashboard] User "${uId}" (dataset: ${dsId}): ${data.tokens} tokens, ${data.interactions} interactions`);
    }
    const currentTeamMemberKey = currentUserId ? currentUserId : currentMachineId ? `machine:${currentMachineId}` : "";
    if (currentTeamMemberKey) { await this.overrideCurrentUserFluency(teamMembers, currentTeamMemberKey); }
    const { localTokens, localInteractions } = await this.getLocalStatsForWindow(settings.lookbackDays ?? 30);
    const teamTotalTokens = Array.from(userMap.values()).reduce((sum, u) => sum + u.tokens, 0);
    const teamTotalInteractions = Array.from(userMap.values()).reduce((sum, u) => sum + u.interactions, 0);
    return {
      personal: { userId: currentUserId || "", totalTokens: personalData.totalTokens, totalInteractions: personalData.totalInteractions, totalCost: personalCost, devices: Array.from(personalData.devices), workspaces: Array.from(personalData.workspaces), modelUsage: personalData.modelUsage, localTokens, localInteractions },
      team: { members: teamMembers, totalTokens: teamTotalTokens, totalInteractions: teamTotalInteractions, averageTokensPerUser: userMap.size > 0 ? teamTotalTokens / userMap.size : 0, firstDate, lastDate },
      lookbackDays: settings.lookbackDays, lastUpdated: new Date().toISOString(),
    };
  }

  private resolveCurrentMachineId(settings: any, sharingPolicy: any, hashFn: (opts: any) => string): string {
    if (sharingPolicy.includeUserDimension) { return ""; }
    const rawMachineId = vscode.env.machineId;
    return sharingPolicy.machineIdStrategy === "hashed" ? hashFn({ datasetId: settings.datasetId ?? "", machineId: rawMachineId }) : rawMachineId;
  }

  private logDashboardDebugInfo(allEntities: any[], currentUserId: string | undefined, todayKey: string, startKey: string): void {
    const uniqueUserIds = new Set(allEntities.map((e) => (e.userId ?? "").toString()).filter((id) => id.trim()));
    const uniqueDatasets = new Set(allEntities.map((e) => (e.datasetId ?? "").toString()).filter((id) => id.trim()));
    this.log(`[Dashboard] Fetched ${allEntities.length} entities for date range ${startKey} to ${todayKey}`);
    this.log(`[Dashboard] Current user ID resolved as: ${currentUserId || "(none)"}`);
    this.log(`[Dashboard] Datasets found: [${Array.from(uniqueDatasets).map((id) => `"${id}"`).join(", ")}]`);
    this.log(`[Dashboard] UserIds in data: [${Array.from(uniqueUserIds).map((id) => `"${id}"`).join(", ")}]`);
  }

  private aggregateDashboardEntities(allEntities: any[], currentUserId: string | undefined, currentMachineId: string, sharingPolicy: any): { personalData: any; userMap: Map<string, any>; userFluencyMap: Map<string, any>; firstDate: string | null; lastDate: string | null } {
    const personalData = { totalTokens: 0, totalInteractions: 0, devices: new Set<string>(), workspaces: new Set<string>(), modelUsage: {} as any };
    const userMap = new Map<string, any>();
    const userFluencyMap = new Map<string, any>();
    let firstDate: string | null = null;
    let lastDate: string | null = null;
    for (const entity of allEntities) {
      const ids = this.extractEntityIds(entity);
      if (ids.dayKey) {
        if (!firstDate || ids.dayKey < firstDate) { firstDate = ids.dayKey; }
        if (!lastDate || ids.dayKey > lastDate) { lastDate = ids.dayKey; }
      }
      if (this.isCurrentUserEntity(ids, currentUserId, currentMachineId, sharingPolicy)) { this.updatePersonalData(entity, ids, personalData); }
      const teamMemberKey = this.resolveTeamMemberKey(ids);
      if (teamMemberKey) { this.updateTeamData(entity, ids, teamMemberKey, userMap, userFluencyMap); }
    }
    return { personalData, userMap, userFluencyMap, firstDate, lastDate };
  }

  private isCurrentUserEntity(ids: any, currentUserId: string | undefined, currentMachineId: string, sharingPolicy: any): boolean {
    if (sharingPolicy.includeUserDimension) { return currentUserId !== "" && ids.userId === currentUserId; }
    return currentMachineId !== "" && ids.machineId === currentMachineId;
  }

  private resolveTeamMemberKey(ids: any): string {
    if (ids.userId && ids.userId.trim()) { return ids.userId; }
    return ids.machineId ? `machine:${ids.machineId}` : "";
  }

  private extractEntityIds(entity: any): { userId: string; datasetId: string; machineId: string; workspaceId: string; model: string; inputTokens: number; outputTokens: number; interactions: number; tokens: number; dayKey: string } {
    const userId = (entity.userId ?? "").toString().replace(/^u:/, "");
    const datasetId = (entity.datasetId ?? "").toString().replace(/^ds:/, "");
    const machineId = (entity.machineId ?? "").toString().replace(/^mc:/, "");
    const workspaceId = (entity.workspaceId ?? "").toString().replace(/^w:/, "");
    const model = (entity.model ?? "").toString().replace(/^m:/, "");
    const inputTokens = Number.isFinite(Number(entity.inputTokens)) ? Number(entity.inputTokens) : 0;
    const outputTokens = Number.isFinite(Number(entity.outputTokens)) ? Number(entity.outputTokens) : 0;
    const interactions = Number.isFinite(Number(entity.interactions)) ? Number(entity.interactions) : 0;
    const dayKey = (entity.day ?? "").toString().replace(/^d:/, "");
    return { userId, datasetId, machineId, workspaceId, model, inputTokens, outputTokens, interactions, tokens: inputTokens + outputTokens, dayKey };
  }

  private updatePersonalData(entity: any, ids: any, personalData: any): void {
    personalData.totalTokens += ids.tokens;
    personalData.totalInteractions += ids.interactions;
    personalData.devices.add(ids.machineId);
    personalData.workspaces.add(ids.workspaceId);
    addModelUsage(personalData.modelUsage, { [ids.model]: { inputTokens: ids.inputTokens, outputTokens: ids.outputTokens, sessions: 0 } });
  }

  private updateTeamData(entity: any, ids: any, teamMemberKey: string, userMap: Map<string, any>, userFluencyMap: Map<string, any>): void {
    const userKey = `${teamMemberKey}|${ids.datasetId}`;
    if (!userMap.has(userKey)) {
      userMap.set(userKey, { tokens: 0, interactions: 0, cost: 0, datasetId: ids.datasetId, sessions: new Set<string>(), models: new Set<string>(), workspaces: new Set<string>(), days: new Set<string>() });
    }
    const userData = userMap.get(userKey)!;
    userData.tokens += ids.tokens; userData.interactions += ids.interactions;
    userData.sessions.add(`${ids.dayKey}|${ids.workspaceId}|${ids.machineId}`);
    if (ids.model) { userData.models.add(ids.model); }
    if (ids.workspaceId) { userData.workspaces.add(ids.workspaceId); }
    if (ids.dayKey) { userData.days.add(ids.dayKey); }
    if ((entity.schemaVersion ?? 0) >= 4) { this.accumulateEntityFluency(entity, userKey, userFluencyMap); }
  }

  private accumulateEntityFluency(entity: any, userKey: string, userFluencyMap: Map<string, any>): void {
    if (!userFluencyMap.has(userKey)) { userFluencyMap.set(userKey, this.createUserFluencyAccumulator()); }
    const fd = userFluencyMap.get(userKey)!;
    fd.askModeCount += typeof entity.askModeCount === "number" ? entity.askModeCount : 0;
    fd.editModeCount += typeof entity.editModeCount === "number" ? entity.editModeCount : 0;
    fd.agentModeCount += typeof entity.agentModeCount === "number" ? entity.agentModeCount : 0;
    fd.planModeCount += typeof entity.planModeCount === "number" ? entity.planModeCount : 0;
    fd.customAgentModeCount += typeof entity.customAgentModeCount === "number" ? entity.customAgentModeCount : 0;
    fd.cliModeCount += typeof entity.cliModeCount === "number" ? entity.cliModeCount : 0;
    if (typeof entity.multiTurnSessions === "number") { fd.multiTurnSessions += entity.multiTurnSessions; }
    if (typeof entity.sessionCount === "number") { fd.sessionCount += entity.sessionCount; }
    if (typeof entity.avgTurnsPerSession === "number" && entity.avgTurnsPerSession > 0) { fd.turnsPerSessionSum += entity.avgTurnsPerSession; fd.turnsPerSessionCount++; }
    this.accumulateEntityJsonFields(entity, fd);
  }

  private createUserFluencyAccumulator(): any {
			return { askModeCount: 0, editModeCount: 0, agentModeCount: 0, planModeCount: 0, customAgentModeCount: 0, cliModeCount: 0, toolCallsTotal: 0, toolCallsByTool: {}, ctxFile: 0, ctxSelection: 0, ctxSymbol: 0, ctxCodebase: 0, ctxWorkspace: 0, ctxTerminal: 0, ctxVscode: 0, ctxClipboard: 0, ctxChanges: 0, ctxProblemsPanel: 0, ctxOutputPanel: 0, ctxTerminalLastCommand: 0, ctxTerminalSelection: 0, ctxByKind: {}, mcpTotal: 0, mcpByServer: {}, mixedTierSessions: 0, mixedCostSessions: 0, switchingFreqSum: 0, switchingFreqCount: 0, autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0, selectedModelExtensions: new Set(), unknownProviderModels: new Set(), standardModels: new Set(), premiumModels: new Set(), lowCostModels: new Set(), mediumCostModels: new Set(), highCostModels: new Set(), multiFileEdits: 0, filesPerEditSum: 0, filesPerEditCount: 0, editsAgentCount: 0, workspaceAgentCount: 0, repositories: new Set(), repositoriesWithCustomization: new Set(), applyRateSum: 0, applyRateCount: 0, multiTurnSessions: 0, turnsPerSessionSum: 0, turnsPerSessionCount: 0, sessionCount: 0, durationMsSum: 0, durationMsCount: 0 };
  }

  private accumulateEntityJsonFields(entity: any, fd: any): void {
    this.accumulateToolCallsJson(entity, fd);
    this.accumulateContextRefsJson(entity, fd);
    this.accumulateMcpToolsJson(entity, fd);
    this.accumulateModelSwitchingJson(entity, fd);
    this.accumulateEditScopeJson(entity, fd);
    this.accumulateAgentTypesJson(entity, fd);
    this.accumulateRepositoriesJson(entity, fd);
    this.accumulateApplyUsageJson(entity, fd);
    this.accumulateSessionDurationJson(entity, fd);
  }

  private accumulateToolCallsJson(entity: any, fd: any): void {
    if (!entity.toolCallsJson) { return; }
    try {
      const tc = JSON.parse(entity.toolCallsJson);
      fd.toolCallsTotal += tc.total ?? 0;
      for (const [tool, count] of Object.entries(tc.byTool ?? {})) { fd.toolCallsByTool[tool] = (fd.toolCallsByTool[tool] ?? 0) + Number(count); }
    } catch { /* ignore */ }
  }

  private accumulateContextRefsJson(entity: any, fd: any): void {
    if (!entity.contextRefsJson) { return; }
    try { this.applyContextRefs(JSON.parse(entity.contextRefsJson), fd); } catch { /* ignore */ }
  }

  private applyContextRefs(cr: any, fd: any): void {
    const fields: [string, string][] = [
      ['ctxFile', 'file'], ['ctxSelection', 'selection'], ['ctxSymbol', 'symbol'],
      ['ctxCodebase', 'codebase'], ['ctxWorkspace', 'workspace'], ['ctxTerminal', 'terminal'],
      ['ctxVscode', 'vscode'], ['ctxClipboard', 'clipboard'], ['ctxChanges', 'changes'],
      ['ctxProblemsPanel', 'problemsPanel'], ['ctxOutputPanel', 'outputPanel'],
      ['ctxTerminalLastCommand', 'terminalLastCommand'], ['ctxTerminalSelection', 'terminalSelection'],
    ];
    for (const [fdKey, crKey] of fields) { fd[fdKey] += cr[crKey] ?? 0; }
    for (const [kind, count] of Object.entries(cr.byKind ?? {})) { fd.ctxByKind[kind] = (fd.ctxByKind[kind] ?? 0) + Number(count); }
  }

  private accumulateMcpToolsJson(entity: any, fd: any): void {
    if (!entity.mcpToolsJson) { return; }
    try {
      const mcp = JSON.parse(entity.mcpToolsJson);
      fd.mcpTotal += mcp.total ?? 0;
      for (const [server, data] of Object.entries(mcp.byServer ?? {})) { fd.mcpByServer[server] = (fd.mcpByServer[server] ?? 0) + Number((data as any)?.total ?? data ?? 0); }
    } catch { /* ignore */ }
  }

  // eslint-disable-next-line complexity
  private accumulateModelSwitchingJson(entity: any, fd: any): void {
    if (!entity.modelSwitchingJson) { return; }
    try {
      const ms = JSON.parse(entity.modelSwitchingJson);
      fd.mixedTierSessions += ms.mixedTierSessions ?? 0;
      fd.mixedCostSessions += ms.mixedCostSessions ?? 0;
			fd.autoSessions += ms.autoSessions ?? 0;
			fd.foundryWindowsSessions += ms.foundryWindowsSessions ?? 0;
			fd.unknownProviderSessions += ms.unknownProviderSessions ?? 0;
      if (typeof ms.switchingFrequency === "number") { fd.switchingFreqSum += ms.switchingFrequency; fd.switchingFreqCount++; }
      for (const m of ms.standardModels ?? []) { fd.standardModels.add(m as string); }
      for (const m of ms.premiumModels ?? []) { fd.premiumModels.add(m as string); }
      for (const m of ms.lowCostModels ?? []) { fd.lowCostModels.add(m as string); }
      for (const m of ms.mediumCostModels ?? []) { fd.mediumCostModels.add(m as string); }
      for (const m of ms.highCostModels ?? []) { fd.highCostModels.add(m as string); }
			for (const ext of ms.selectedModelExtensions ?? []) { fd.selectedModelExtensions.add(ext as string); }
			for (const model of ms.unknownProviderModels ?? []) { fd.unknownProviderModels.add(model as string); }
    } catch { /* ignore */ }
  }

  private accumulateEditScopeJson(entity: any, fd: any): void {
    if (!entity.editScopeJson) { return; }
    try {
      const es = JSON.parse(entity.editScopeJson);
      fd.multiFileEdits += es.multiFileEdits ?? 0;
      if (typeof es.avgFilesPerSession === "number" && es.avgFilesPerSession > 0) { fd.filesPerEditSum += es.avgFilesPerSession; fd.filesPerEditCount++; }
    } catch { /* ignore */ }
  }

  private accumulateAgentTypesJson(entity: any, fd: any): void {
    if (!entity.agentTypesJson) { return; }
    try {
      const at = JSON.parse(entity.agentTypesJson);
      fd.editsAgentCount += at.editsAgent ?? 0; fd.workspaceAgentCount += at.workspaceAgent ?? 0;
    } catch { /* ignore */ }
  }

  private accumulateRepositoriesJson(entity: any, fd: any): void {
    if (!entity.repositoriesJson) { return; }
    try {
      const rj = JSON.parse(entity.repositoriesJson);
      for (const r of rj.repositories ?? []) { fd.repositories.add(r as string); }
      for (const r of rj.repositoriesWithCustomization ?? []) { fd.repositoriesWithCustomization.add(r as string); }
    } catch { /* ignore */ }
  }

  private accumulateApplyUsageJson(entity: any, fd: any): void {
    if (!entity.applyUsageJson) { return; }
    try {
      const au = JSON.parse(entity.applyUsageJson);
      if (typeof au.applyRate === "number") { fd.applyRateSum += au.applyRate; fd.applyRateCount++; }
    } catch { /* ignore */ }
  }

  private accumulateSessionDurationJson(entity: any, fd: any): void {
    if (!entity.sessionDurationJson) { return; }
    try {
      const sd = JSON.parse(entity.sessionDurationJson);
      if (typeof sd.avgDurationMs === "number" && sd.avgDurationMs > 0) { fd.durationMsSum += sd.avgDurationMs; fd.durationMsCount++; }
    } catch { /* ignore */ }
  }

  private buildTeamLeaderboard(userMap: Map<string, any>, userFluencyMap: Map<string, any>): any[] {
    return Array.from(userMap.entries()).map(([userKey, data]) => {
      const [userId, datasetId] = userKey.split("|");
      const sessionCount = data.sessions.size;
      const fluencyData = userFluencyMap.get(userKey);
      const fluencyScore = fluencyData ? _calculateFluencyScoreForTeamMember(fluencyData, sessionCount) : undefined;
      return {
        userId, datasetId, totalTokens: data.tokens, totalInteractions: data.interactions, totalCost: data.cost, sessions: sessionCount,
        avgTurnsPerSession: sessionCount > 0 ? Math.round(data.interactions / sessionCount) : 0,
        uniqueModels: data.models.size, uniqueWorkspaces: data.workspaces.size, daysActive: data.days.size,
        avgTokensPerTurn: data.interactions > 0 ? Math.round(data.tokens / data.interactions) : 0,
        rank: 0, ...(fluencyScore ? { fluencyStage: fluencyScore.stage, fluencyLabel: fluencyScore.label, fluencyCategories: fluencyScore.categories } : {}),
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens).map((member, index) => ({ ...member, rank: index + 1 }));
  }

  private async overrideCurrentUserFluency(teamMembers: any[], currentTeamMemberKey: string): Promise<void> {
    try {
      const localMaturity = await this.calculateMaturityScores(true);
      for (const member of teamMembers) {
        if (member.userId === currentTeamMemberKey) {
          member.fluencyStage = localMaturity.overallStage; member.fluencyLabel = localMaturity.overallLabel;
          member.fluencyCategories = localMaturity.categories.map((c: any) => ({ category: c.category, icon: c.icon, stage: c.stage, tips: c.tips }));
          break;
        }
      }
    } catch { /* non-critical */ }
  }

  private async getLocalStatsForWindow(lookbackDays: number): Promise<{ localTokens: number | undefined; localInteractions: number | undefined }> {
    const startedAtGeneration = this._cacheGeneration;
    try {
      const { dailyStats: freshDailyStats } = await this.calculateDetailedStats(undefined);
      this.lastDailyStats = freshDailyStats;
      this._statsGeneration.daily = startedAtGeneration;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
      const cutoffStr = toLocalDayKey(cutoffDate);
      const inWindow = freshDailyStats.filter(d => d.date >= cutoffStr);
      return { localTokens: inWindow.reduce((sum, d) => sum + d.tokens, 0), localInteractions: inWindow.reduce((sum, d) => sum + d.interactions, 0) };
    } catch { return { localTokens: undefined, localInteractions: undefined }; }
  }

  private getDashboardHtml(
    webview: vscode.Webview,
    data: any | undefined,
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "dashboard.js"),
    );

    const backendConfig = this.getDashboardBackendConfig();

    const dataWithBackend = data
      ? { ...data, backendConfigured: this.isBackendConfigured(), compactNumbers: this.getCompactNumbersSetting(), ...this.getWebviewLocaleFields() }
      : undefined;
    const initialDataScript = dataWithBackend
      ? `<script nonce="${nonce}">window.__INITIAL_DASHBOARD__ = ${JSON.stringify(dataWithBackend).replace(/</g, "\\u003c")};</script>`
      : "";
    const configScript = `<script nonce="${nonce}">window.__DASHBOARD_CONFIG__ = ${JSON.stringify(backendConfig).replace(/</g, "\\u003c")};</script>`;

    // The second document that deliberately declares `lang="en"`, for the same reason as
    // getLoadingHtml(): its content is English, not the viewer's language.
    //
    // The `localization` payload above looks like it makes this view localized, but it is behind
    // `data ?` and the only call site (`getDashboardHtml(webview, undefined)`) passes undefined —
    // so `window.__INITIAL_DASHBOARD__` is never emitted, `initializeWebviewLocalization()` in
    // dashboard/main.ts never runs, and the stats arrive later by postMessage carrying no
    // localization. That bundle renders raw English literals ("Synced Tokens", "Estimated Cost",
    // "Loading dashboard data…"), and this <title> is hardcoded English too.
    //
    // Emitting the payload unconditionally would not fix it: nothing in dashboard/main.ts reads
    // the table. Localizing that bundle is the real fix and is the same follow-up the loading
    // fragment needs.
    return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>Team Dashboard</title>
		</head>
		<body>
			<div id="root"></div>
			${configScript}
			${initialDataScript}
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  /**
   * Check if either Azure Storage or Team Server backend is configured for Team Dashboard access.
   */
  private isBackendConfigured(): boolean {
    const { azureConfigured, teamServerConfigured } = this.getDashboardBackendConfig();
    return azureConfigured || teamServerConfigured;
  }

  /**
   * Returns which backends are configured and the validated team server URL.
   * Azure is considered configured when all required Azure Storage fields are filled.
   * Team Server is configured when enabled with a valid http/https URL.
   */
  private getDashboardBackendConfig(): { azureConfigured: boolean; azureStorageUrl: string; teamServerConfigured: boolean; teamServerUrl: string } {
    const settings = this.backend?.getSettings();
    const azureConfigured = !!(
      settings?.subscriptionId &&
      settings?.resourceGroup &&
      settings?.storageAccount &&
      settings?.aggTable
    );
    const azureStorageUrl = azureConfigured
      ? getAzureTableStorageEndpoint(settings.storageAccount)
      : '';
    const teamServerUrl = this.buildTeamServerUrl(settings);
    return { azureConfigured, azureStorageUrl, teamServerConfigured: !!teamServerUrl, teamServerUrl };
  }

  private getAzureDashboardFailureMessage(action: string): string {
    const { azureStorageUrl } = this.getDashboardBackendConfig();
    const source = azureStorageUrl ? ` from ${azureStorageUrl}` : '';
    return `Unable to ${action}${source}. Review the Azure Storage configuration and try again.`;
  }

  private showDashboardFailure(message: string): void {
    const { teamServerConfigured, teamServerUrl } = this.getDashboardBackendConfig();
    this.dashboardPanel?.webview.postMessage(
      teamServerConfigured
        ? { command: 'dashboardTeamServerFallback', message, url: teamServerUrl }
        : { command: 'dashboardError', message },
    );
  }

  private buildTeamServerUrl(settings: any): string {
    const rawUrl = (settings?.sharingServerEnabled && settings?.sharingServerEndpointUrl) ? settings.sharingServerEndpointUrl : '';
    if (!rawUrl) { return ''; }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') { return rawUrl; }
    } catch { /* invalid URL — leave empty */ }
    return '';
  }

  /**
   * The shared loading screen — the one document that deliberately still declares `lang="en"`.
   *
   * `lang` names the predominant language of a document's content, and this body is
   * loadingHtml.getLoadingHtmlBody(), which emits hardcoded English throughout: "Analyzing Your
   * AI Activity", "Building Activity Index", the four step labels, the chips. Only the `<title>`
   * and the subtitle (replaced at runtime with `loading.efficiency.*`) are localized.
   *
   * Deriving the viewer's locale here would therefore mislabel the *whole page* on a zh-CN
   * install, where declaring `en` mislabels only those two elements — which is the state this
   * document was already in. Twelve documents render localized bodies and do derive it; this one
   * is the exception until its fragment is localized, which is its own change: the fragment is
   * shared with the desktop tray app and has no localization payload to draw on.
   */
  private getLoadingHtml(webview: vscode.Webview, startedAtMs: number = Date.now()): string {
    const nonce = getNonce();
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'robot-icon.png'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${buildCspMeta(webview, nonce)}
<title>${l10n.t('htmlTitleLoading')}</title>
<style>
${this.getLoadingHtmlCssBase()}
${this.getLoadingHtmlCssSteps()}
</style>
</head>
${this.getLoadingHtmlBody(nonce, iconUri.toString(), startedAtMs)}
</html>`;
  }

  private getLoadingHtmlCssBase(): string {
    return loadingHtml.getLoadingHtmlCssBase();
  }

  private getLoadingHtmlCssSteps(): string {
    return loadingHtml.getLoadingHtmlCssSteps();
  }

  private getLoadingHtmlBody(nonce: string, iconUri?: string, startedAtMs: number = Date.now()): string {
    return loadingHtml.getLoadingHtmlBody(nonce, iconUri, startedAtMs);
  }

  private getDetailsHtml(
    webview: vscode.Webview,
    stats: DetailedStats,
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "details.js"),
    );

    const sortSettings = this.context.globalState.get('details.sortSettings', {
      editor: { key: 'name', dir: 'asc' },
      model: { key: 'name', dir: 'asc' },
      modelOtherExpanded: false,
      editorOtherExpanded: false,
      editorSectionCollapsed: false,
      excludedProviders: [],
    });
    const dataWithBackend = {
      ...stats,
      backendConfigured: this.isBackendConfigured(),
      sortSettings,
      compactNumbers: this.getCompactNumbersSetting(),
      copilotPlan: this._copilotPlanResolved,
      ...this.getWebviewLocaleFields(),
    };
    const initialData = JSON.stringify(dataWithBackend).replace(
      /</g,
      "\\u003c",
    );

    return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>${l10n.t('htmlTitle')}</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DETAILS__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			${this.getLocalViewRegressionProbeScript('details', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  public async generateDiagnosticReport(): Promise<string> {
    this.log("Generating diagnostic report...");
    const report: string[] = [];
    this.buildDiagReportHeader(report);
    this.buildDiagReportExtensionInfo(report);
    this.buildDiagReportSystemInfo(report);
    this.buildDiagReportCopilotStatus(report);
    this.buildDiagReportBackendConfig(report);
    await this.buildDiagReportSessionFiles(report);
    this.buildDiagReportCacheStats(report);
    await this.buildDiagReportTokenStats(report);
    this.buildDiagReportFooter(report);
    this.log("Diagnostic report generated successfully");
    return report.join("\n");
  }

  private buildDiagReportHeader(report: string[]): void {
    report.push("=".repeat(70)); report.push(l10n.t('diagnosticReportTitle')); report.push("=".repeat(70)); report.push("");
  }

  private buildDiagReportExtensionInfo(report: string[]): void {
    report.push("## Extension Information");
    report.push(`Extension Version: ${(vscode.extensions.getExtension("RobBos.ai-engineering-fluency") ?? vscode.extensions.getExtension("RobBos.copilot-token-tracker"))?.packageJSON.version || "Unknown"}`);
    report.push(`VS Code Version: ${vscode.version}`); report.push("");
  }

  private buildDiagReportSystemInfo(report: string[]): void {
    report.push("## System Information");
    report.push(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);
    report.push(`Node Version: ${process.version}`);
    report.push(`Home Directory: ${os.homedir()}`);
    report.push(`Environment: ${process.env.CODESPACES === "true" ? "GitHub Codespaces" : vscode.env.remoteName || "Local"}`);
    report.push(`VS Code Machine ID: ${vscode.env.machineId}`);
    report.push(`VS Code Session ID: ${vscode.env.sessionId}`);
    report.push(`VS Code UI Kind: ${vscode.env.uiKind === vscode.UIKind.Desktop ? "Desktop" : "Web"}`);
    report.push(`Remote Name: ${vscode.env.remoteName || "N/A"}`); report.push("");
  }

  private buildDiagReportCopilotStatus(report: string[]): void {
    report.push("## GitHub Copilot Extension Status");
    this.addCopilotExtensionInfo(report, vscode.extensions.getExtension("GitHub.copilot"));
    this.addCopilotChatExtensionInfo(report, vscode.extensions.getExtension("GitHub.copilot-chat"));
    report.push("");
  }

  private addCopilotExtensionInfo(report: string[], copilotExtension: vscode.Extension<any> | undefined): void {
    if (!copilotExtension) { report.push(`GitHub Copilot Extension: Not Installed`); return; }
    report.push(`GitHub Copilot Extension:`);
    report.push(`  - Installed: Yes`);
    report.push(`  - Version: ${copilotExtension.packageJSON.version}`);
    report.push(`  - Active: ${copilotExtension.isActive ? "Yes" : "No"}`);
    try {
      const copilotApi = copilotExtension.exports;
      if (copilotApi?.status) {
        const status = copilotApi.status;
        if (typeof status === "object") { Object.keys(status).forEach((key) => { const value = status[key]; if (value !== undefined && value !== null) { report.push(`  - ${key}: ${value}`); } }); }
        else { report.push(`  - Status: ${status}`); }
      }
    } catch (error) { this.log(`Could not retrieve Copilot tier information: ${error}`); }
  }

  private addCopilotChatExtensionInfo(report: string[], copilotChatExtension: vscode.Extension<any> | undefined): void {
    if (!copilotChatExtension) { report.push(`GitHub Copilot Chat Extension: Not Installed`); return; }
    report.push(`GitHub Copilot Chat Extension:`); report.push(`  - Installed: Yes`);
    report.push(`  - Version: ${copilotChatExtension.packageJSON.version}`);
    report.push(`  - Active: ${copilotChatExtension.isActive ? "Yes" : "No"}`);
  }

  private buildDiagReportBackendConfig(report: string[]): void {
    report.push("## Backend Configuration");
    const settings = this.backend?.getSettings();
    const githubAuthStatus = this.getGitHubAuthStatus();
    report.push(`GitHub Authentication: ${githubAuthStatus.authenticated ? `Authenticated (${githubAuthStatus.username || "unknown"})` : "Not Authenticated"}`);
    if (settings?.sharingServerEnabled) {
      report.push(`Team Server: Enabled`); report.push(`  - Server URL: ${settings.sharingServerEndpointUrl || "(not set)"}`);
      if (!githubAuthStatus.authenticated) { report.push(`  - ⚠️ WARNING: GitHub authentication is required for team server sync`); }
    } else { report.push(`Team Server: Disabled`); }
    if (settings?.enabled) { report.push(`Azure Storage: Enabled`); report.push(`  - Storage Account: ${settings.storageAccount || "(not set)"}`); }
    else { report.push(`Azure Storage: Disabled`); }
    report.push("");
  }

  private async buildDiagReportSessionFiles(report: string[]): Promise<void> {
    report.push("## Session Files Discovery");
    try {
      const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
      report.push(`Total Session Files Found: ${sessionFiles.length}`); report.push("");
      if (sessionFiles.length > 0) { await this.appendSessionFileListing(report, sessionFiles); }
      else { this.appendNoSessionFilesMessage(report); }
      report.push("");
    } catch (error) { report.push(`Error discovering session files: ${error}`); report.push(""); }
  }

  private async appendSessionFileListing(report: string[], sessionFiles: string[]): Promise<void> {
    report.push("Session File Locations (first 20):");
    const filesToShow = sessionFiles.slice(0, 20);
    const fileStats = await Promise.all(filesToShow.map(async (file) => { try { const stat = await fs.promises.stat(file); return { file, stat, error: null }; } catch (error) { return { file, stat: null, error }; } }));
    fileStats.forEach((result, index) => {
      if (result.stat) { report.push(`  ${index + 1}. ${result.file}`); report.push(`     - Size: ${result.stat.size} bytes`); report.push(`     - Modified: ${result.stat.mtime.toISOString()}`); }
      else { report.push(`  ${index + 1}. ${result.file}`); report.push(`     - Error: ${result.error}`); }
    });
    if (sessionFiles.length > 20) { report.push(`  ... and ${sessionFiles.length - 20} more files`); }
  }

  private appendNoSessionFilesMessage(report: string[]): void {
    report.push("No session files found. Possible reasons:");
    report.push("  - Copilot extensions are not active");
    report.push("  - No Copilot Chat conversations have been initiated");
    report.push("  - Sessions stored in unsupported location");
    report.push("  - Authentication required with GitHub Copilot");
    if (vscode.env.remoteName === "wsl") {
      report.push(""); report.push("WSL note: the extension host runs inside WSL and scans both the");
      report.push("  Linux-side ~/.vscode-server paths and the Windows-side");
      report.push("  /mnt/c/Users/<you>/AppData/Roaming/Code paths.");
      report.push("  If /mnt/c is not mounted, Windows-side sessions cannot be read.");
    }
  }

  private buildDiagReportCacheStats(report: string[]): void {
    report.push("## Cache Statistics");
    report.push(`Cached Session Files: ${this.cacheManager.cache.size}`);
    report.push(`Cache Storage: Extension Global State`); report.push("");
    report.push("Cache provides faster loading by storing parsed session data with file modification timestamps.");
    report.push("Files are only re-parsed when their modification time changes."); report.push("");
  }

  private async buildDiagReportTokenStats(report: string[]): Promise<void> {
    report.push("## Token Usage Statistics");
    try {
      const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
      report.push(`Total Session Files Found: ${sessionFiles.length}`); report.push("");
      const dirCounts = new Map<string, number>();
      for (const file of sessionFiles) { const parent = require("path").dirname(file); dirCounts.set(parent, (dirCounts.get(parent) || 0) + 1); }
      if (dirCounts.size > 0) { report.push("Session Files by Directory:"); for (const [dir, count] of dirCounts.entries()) { report.push(`  ${dir}: ${count}`); } report.push(""); }
      if (sessionFiles.length > 0) { await this.appendSessionFileListing(report, sessionFiles); }
      else { this.appendNoSessionFilesMessage(report); }
      report.push("");
    } catch (error) { report.push(l10n.t('error.calculatingTokenUsageStatistics') + `: ${error}`); report.push(""); }
  }

  private buildDiagReportFooter(report: string[]): void {
    report.push("=".repeat(70)); report.push(`Report Generated: ${new Date().toISOString()}`); report.push("=".repeat(70)); report.push("");
    report.push("This report can be shared with the extension maintainers to help");
    report.push("troubleshoot issues. No sensitive data from your code is included."); report.push("");
    report.push("Submit issues at:"); report.push(`${this.getRepositoryUrl()}/issues`);
  }


  public async showDiagnosticReport(): Promise<void> {
    this.log("🔍 Opening Diagnostic Report");
    this.recordViewVisit('diagnostics');
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.reveal();
      this.log("🔍 Diagnostic Report revealed (already exists)");
      this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
      return;
    }
    this.diagnosticsPanel = vscode.window.createWebviewPanel(
      "copilotTokenDiagnostics", "Diagnostic Report",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")] },
    );
    this.log("✅ Diagnostic Report panel created");
    this.diagnosticsPanel.webview.onDidReceiveMessage(async (message) => { await this.handleDiagnosticMessage(message); });
    this.diagnosticsPanel.webview.html = this.getDiagnosticReportHtml(this.diagnosticsPanel.webview, "Loading...", [], [], [], null);
    this.diagnosticsPanel.onDidDispose(() => {
      this.log("🔍 Diagnostic Report closed");
      this.diagnosticsPanel = undefined;
    });
    this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
  }

  private async handleDiagnosticMessage(message: any): Promise<void> {
    if (this.handleLocalViewRegressionMessage(message)) { return; }
    if (await this.dispatchSharedCommand(message)) { return; }
    const simpleCommands: Record<string, () => Promise<void>> = {
      copyReport: () => this.dispatch('copyReport:diagnostics', () => this.diagHandleCopyReport()),
      openIssue: () => this.dispatch('openIssue:diagnostics', () => this.diagHandleOpenIssue()),
      clearCache: () => this.dispatch('clearCache:diagnostics', () => this.diagHandleClearCache()),
			resetInsightsState: () => this.dispatch('resetInsightsState:diagnostics', () => this.resetInsightsState()),
      configureBackend: () => this.dispatch('configureBackend:diagnostics', () => this.diagHandleConfigureBackend()),
      configureTeamServer: () => this.dispatch('configureTeamServer:diagnostics', () => this.diagHandleConfigureTeamServer()),
      openSettings: () => this.dispatch('openSettings:diagnostics', () => vscode.commands.executeCommand("workbench.action.openSettings", "aiEngineeringFluency.backend")),
      openDisplaySettings: () => this.dispatch('openDisplaySettings:diagnostics', () => vscode.commands.executeCommand("workbench.action.openSettings", "aiEngineeringFluency.display")),
      openToolFamiliesSettings: () => this.dispatch('openToolFamiliesSettings:diagnostics', () => vscode.commands.executeCommand("workbench.action.openSettings", "aiEngineeringFluency.toolFamilies")),
      resetDebugCounters: () => this.dispatch('resetDebugCounters:diagnostics', () => this.diagHandleResetDebugCounters()),
      resetDiscoveredEditors: () => this.dispatch('resetDiscoveredEditors:diagnostics', () => this.diagHandleResetDiscoveredEditors()),
      authenticateGitHub: () => this.dispatch('authenticateGitHub:diagnostics', () => this.diagHandleGitHubAuth(true)),
      signOutGitHub: () => this.dispatch('signOutGitHub:diagnostics', () => this.diagHandleGitHubAuth(false)),
      pickFolder: () => this.dispatch('pickFolder:diagnostics', () => this.diagHandlePickFolder()),
      analyzeFolder: () => this.dispatch('analyzeFolder:diagnostics', () => this.diagHandleAnalyzeFolder(message)),
      analyzeModelUsage: () => this.dispatch('analyzeModelUsage:diagnostics', () => this.diagHandleAnalyzeModelUsage(message)),
      analyzeTtft: () => this.dispatch('analyzeTtft:diagnostics', () => this.diagHandleAnalyzeTtft(message)),
    };
    if (simpleCommands[message.command]) { await simpleCommands[message.command](); return; }
    await this.handleDiagnosticConditionalCommand(message);
  }

  private async handleDiagnosticConditionalCommand(message: any): Promise<void> {
    switch (message.command) {
      case "reportNewEditorPath":
        if (message.path) { await this.dispatch('reportNewEditorPath:diagnostics', () => this.diagHandleReportNewEditorPath(message.path)); } break;
      case "openSessionFile":
        if (message.file) { await this.dispatch('openSessionFile:diagnostics', async () => { try { await this.showLogViewer(message.file); } catch { vscode.window.showErrorMessage("Could not open log viewer: " + message.file); } }); } break;
      case "openFormattedJsonlFile":
        if (message.file) { await this.dispatch('openFormattedJsonlFile:diagnostics', () => this.diagHandleOpenFormattedJsonlFile(message.file)); } break;
      case "revealPath":
        if (message.path) { await this.dispatch('revealPath:diagnostics', () => this.diagHandleRevealPath(message.path)); } break;
      default:
        await this.handleDiagnosticTypedCommand(message); break;
    }
  }

  private async handleDiagnosticTypedCommand(message: any): Promise<void> {
    switch (message.command) {
      case "updateDisplaySetting":
        if (typeof message.key === 'string' && message.value !== undefined) { await this.dispatch('updateDisplaySetting:diagnostics', () => this.diagHandleUpdateDisplaySetting(message.key, message.value)); } break;
      case "setDebugCounter":
        if (typeof message.key === 'string' && typeof message.value === 'number') { await this.dispatch('setDebugCounter:diagnostics', () => this.diagHandleSetDebugCounter(message.key, message.value)); } break;
      case "setDebugFlag":
        if (typeof message.key === 'string' && typeof message.value === 'boolean') { await this.dispatch('setDebugFlag:diagnostics', () => this.diagHandleSetDebugFlag(message.key, message.value)); } break;
      case "copyText":
        if (typeof message.text === 'string') { await this.dispatch('copyText:diagnostics', () => this.diagHandleCopyText(message.text)); } break;
      case "shareCardToSocial":
        if (typeof message.text === 'string' && isSharePlatform(message.platform)) {
          await this.dispatch('shareCardToSocial:diagnostics', () => this.diagHandleShareCardToSocial(message.text, message.platform));
        }
        break;
    }
  }

  private async diagHandleCopyReport(): Promise<void> {
    await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
    vscode.window.showInformationMessage("Diagnostic report copied to clipboard");
  }

  private async diagHandleCopyText(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage("Summary copied to clipboard");
  }

  private async diagHandleShareCardToSocial(text: string, platform: 'linkedin' | 'bluesky' | 'mastodon'): Promise<void> {
    await this.shareTextToSocialPlatform(text, platform);
    this.log(`Shared Share Card to ${platform}`);
  }

  private async diagHandleOpenIssue(): Promise<void> {
    await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
    vscode.window.showInformationMessage("Diagnostic report copied to clipboard. Please paste it into the GitHub issue.");
    const shortBody = encodeURIComponent("The diagnostic report has been copied to the clipboard. Please paste it below.");
    await vscode.env.openExternal(vscode.Uri.parse(`${this.getRepositoryUrl()}/issues/new?body=${shortBody}`));
  }

  private async diagHandleReportNewEditorPath(rawPath: string): Promise<void> {
    const home = os.homedir();
    const anonymizedPath = rawPath.startsWith(home) ? rawPath.replace(home, '~') : rawPath;
    const title = encodeURIComponent('New editor support: unknown session path found');
    const body = encodeURIComponent(['## Unknown editor session path found', '', 'The extension found a session file at a path it does not recognise:', '', '```', anonymizedPath, '```', '', '**Which editor or tool does this path belong to?**', '', 'Please describe the editor/tool and how you installed it so we can add support for it.'].join('\n'));
    await vscode.env.openExternal(vscode.Uri.parse(`${this.getRepositoryUrl()}/issues/new?title=${title}&body=${body}&labels=${encodeURIComponent('new-editor-support')}`));
  }

  private async diagHandleOpenFormattedJsonlFile(file: string): Promise<void> {
    try {
      await this.showFormattedJsonlFile(file);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage("Could not open formatted file: " + file + " (" + errorMsg + ")");
    }
  }

  private async diagHandleRevealPath(pathToReveal: string): Promise<void> {
    try {
      const fsModule = require("fs");
      const pathModule = require("path");
      const normalized = pathModule.normalize(pathToReveal);
      try {
        await fsModule.promises.stat(normalized);
      } catch (err) {
        // Only a genuinely missing path is "gone"; permission/IO errors fall through to the reveal attempt.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          vscode.window.showWarningMessage(l10n.t('usage.worktreeCleanup.revealMissing', normalized));
          return;
        }
      }
      // revealFileInOS works for folders and files alike; openExternal on a folder URI is
      // silently ignored on some hosts, which made "Reveal folder" look dead.
      try {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(normalized));
      } catch {
        await vscode.env.openExternal(vscode.Uri.file(normalized));
      }
    } catch {
      vscode.window.showErrorMessage("Could not reveal: " + pathToReveal);
    }
  }

  private async diagHandleClearCache(): Promise<void> {
    this.log("clearCache message received from diagnostics webview");
    await this.clearCache();
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.webview.postMessage({ command: "cacheCleared" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await this.showDiagnosticReport();
    }
  }

  private async diagHandleConfigureBackend(): Promise<void> {
    try {
      await vscode.commands.executeCommand("aiEngineeringFluency.configureBackend");
    } catch {
      void (async () => {
        const openSettings = l10n.t('button.openSettings');
        const choice = await vscode.window.showInformationMessage(l10n.t('backendConfigMessage'), openSettings);
        if (choice === openSettings) { void vscode.commands.executeCommand("workbench.action.openSettings", "aiEngineeringFluency.backend"); }
      })();
    }
  }

  private async diagHandleConfigureTeamServer(): Promise<void> {
    try {
      await vscode.commands.executeCommand("aiEngineeringFluency.configureTeamServer");
    } catch {
      void (async () => {
        const openSettings = l10n.t('button.openSettings');
        const choice = await vscode.window.showInformationMessage(l10n.t('teamServerConfigMessage'), openSettings);
        if (choice === openSettings) { void vscode.commands.executeCommand("workbench.action.openSettings", "aiEngineeringFluency.backend.sharingServer"); }
      })();
    }
  }

  private async diagHandleUpdateDisplaySetting(key: string, value: any): Promise<void> {
    const fullKeyMap: Record<string, string> = {
      'display.statusBar.showTokens': 'aiEngineeringFluency.display.statusBar.showTokens',
      'display.statusBar.showCost': 'aiEngineeringFluency.display.statusBar.showCost',
      'display.statusBar.monthlyBudget': 'aiEngineeringFluency.display.statusBar.monthlyBudget',
    };
    const fullKey = fullKeyMap[key];
    if (!fullKey) { return; }
    let sanitised: any = value;
    if (key === 'display.statusBar.monthlyBudget') {
      const n = typeof value === 'number' ? value : parseFloat(value);
      sanitised = isNaN(n) ? 0 : Math.min(99999, Math.max(0, Math.round(n * 100) / 100));
    }
    await vscode.workspace.getConfiguration().update(fullKey, sanitised, vscode.ConfigurationTarget.Global);
  }

  private async diagHandleResetDebugCounters(): Promise<void> {
    await this.context.globalState.update('extension.openCount', 0);
    await this.context.globalState.update('extension.unknownMcpOpenCount', 0);
    await this.context.globalState.update('news.fluencyScoreBanner.v1.dismissed', false);
    await this.context.globalState.update('news.unknownMcpTools.dismissedVersion', undefined);
    await this.context.globalState.update('news.efficiencyTab.v1.dismissed', false);
    vscode.window.showInformationMessage('Debug counters and dismissed flags have been reset.');
    await this.showDiagnosticReport();
  }

  private async diagHandleResetDiscoveredEditors(): Promise<void> {
    await this.context.globalState.update(CopilotTokenTracker.SEEN_EDITORS_STATE_KEY, undefined);
    await this.context.globalState.update(CopilotTokenTracker.NOTIFIED_EDITORS_STATE_KEY, undefined);
    vscode.window.showInformationMessage('Discovered editor tracking has been reset.');
    await this.showDiagnosticReport();
  }

  private async diagHandleSetDebugCounter(key: string, value: number): Promise<void> {
    await this.context.globalState.update(key, value);
    vscode.window.showInformationMessage(`Set ${key} = ${value}`);
    await this.showDiagnosticReport();
  }

  private async diagHandleSetDebugFlag(key: string, value: boolean): Promise<void> {
    await this.context.globalState.update(key, value);
    vscode.window.showInformationMessage(`Set ${key} = ${value}`);
    await this.showDiagnosticReport();
  }

  private async diagHandleGitHubAuth(signIn: boolean): Promise<void> {
    if (signIn) { await this.authenticateWithGitHub(); } else { await this.signOutFromGitHub(); }
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.webview.postMessage({ command: 'githubAuthUpdated', githubAuth: this.getGitHubAuthStatus() });
    }
  }















  private async diagHandlePickFolder(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Select Folder to Analyze" });
    if (uris && uris.length > 0 && this.diagnosticsPanel && this.isPanelOpen(this.diagnosticsPanel)) {
      this.diagnosticsPanel.webview.postMessage({ command: "folderPicked", folderPath: uris[0].fsPath });
    }
  }

  private async diagHandleAnalyzeFolder(message: any): Promise<void> {
    const { folderPath, toolType } = message as { folderPath: string; toolType: string };
    const effectiveToolType = toolType ?? "auto";
    if (!folderPath) {
      if (this.diagnosticsPanel && this.isPanelOpen(this.diagnosticsPanel)) {
        this.diagnosticsPanel.webview.postMessage({ command: "folderAnalysisResult", error: "No folder path provided.", files: [], totalScanned: 0, parseErrors: 0, truncated: false, folderPath: "", toolType: effectiveToolType });
      }
      return;
    }
    try {
      await fs.promises.access(folderPath);
    } catch {
      if (this.diagnosticsPanel && this.isPanelOpen(this.diagnosticsPanel)) {
        this.diagnosticsPanel.webview.postMessage({ command: "folderAnalysisResult", error: `Folder not found or not accessible: ${folderPath}`, files: [], totalScanned: 0, parseErrors: 0, truncated: false, folderPath, toolType: effectiveToolType });
      }
      return;
    }
    if (this.diagnosticsPanel) { await this.analyzeFolderPath(this.diagnosticsPanel, folderPath, effectiveToolType); }
  }

  /** Merge one file's per-model usage entries into the running aggregate. */
  private static mergeModelUsageEntry(aggregated: ModelUsage, model: string, usage: ModelUsage[ModelId]): void {
    if (!aggregated[model]) { aggregated[model] = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, sessions: 0 }; }
    addModelUsage(aggregated, { [model]: { ...usage, sessions: 0 } });
  }

  /** Aggregate per-model usage (and per-model session counts) across a set of session files with modelUsage data. */
  private aggregateModelUsage(matching: SessionFileDetails[]): { aggregated: ModelUsage; filesWithUsage: number; sessionCounts: Record<string, number> } {
    const aggregated: ModelUsage = {};
    const sessionCounts: Record<string, number> = {};
    let filesWithUsage = 0;
    for (const f of matching) {
      if (!f.modelUsage) { continue; }
      filesWithUsage++;
      for (const [model, usage] of Object.entries(f.modelUsage)) {
        CopilotTokenTracker.mergeModelUsageEntry(aggregated, model, usage);
        sessionCounts[model] = (sessionCounts[model] || 0) + 1;
      }
    }
    return { aggregated, filesWithUsage, sessionCounts };
  }

  /**
   * Computes [startMs, endMs) bounds for a Model Usage time-range filter, using the
   * user's local calendar (not UTC) so "today"/"this week"/etc. match their wall clock.
   * Returns null for 'all' (no filtering). Weeks start on Monday (ISO-8601 convention).
   */
  private getModelUsageTimeRangeBounds(range: string, now: Date = new Date()): { startMs: number; endMs: number } | null {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const todayStart = startOfDay(now);
    switch (range) {
      case 'today':
        return { startMs: todayStart, endMs: now.getTime() };
      case 'yesterday': {
        const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
        return { startMs: yesterdayStart, endMs: todayStart };
      }
      case 'week': {
        // ISO week: Monday = start. getDay() is 0=Sun..6=Sat; convert to days-since-Monday.
        const dayOfWeek = (now.getDay() + 6) % 7;
        const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek).getTime();
        return { startMs: weekStart, endMs: now.getTime() };
      }
      case 'month':
        return { startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), endMs: now.getTime() };
      case 'lastMonth':
        return {
          startMs: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
          endMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        };
      default:
        return null;
    }
  }

  /** Resolves the best available timestamp (ms) for a session file, for time-range filtering. */
  private getSessionFileTimestampMs(f: SessionFileDetails): number | null {
    const raw = f.lastInteraction || f.firstInteraction || f.modified;
    if (!raw) { return null; }
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /**
   * Aggregates per-model token usage (and estimated cost) across the already-loaded
   * diagnostics session files, optionally filtered to a single editor. Reuses the same
   * modelUsage data + calculateEstimatedCost() the dashboard uses, so the breakdown a
   * user sees here matches what drove their cost figures — useful for self-diagnosing
   * "why does my cost look wrong" reports without a separate script.
   *
   * Note on Copilot CLI: "0 files with model attribution" for this editor is often
   * expected, not a bug. Copilot CLI has two storage backends — events.jsonl (project/
   * worktree sessions, rich per-model data) and session-store.db (chat-only sessions
   * with no workspace). The DB schema has no model/token columns at all, so
   * CopilotCliAdapter.getModelUsage() legitimately returns {} for those files — see the
   * comment there for the verified schema. A mixed editor total can therefore show many
   * "matched, 0 attributed" files simply because a large fraction are DB-only sessions.
   */
  private async diagHandleAnalyzeModelUsage(message: any): Promise<void> {
    const editor = typeof message?.editor === 'string' && message.editor ? message.editor : 'all';
    const timeRange = typeof message?.timeRange === 'string' && message.timeRange ? message.timeRange : 'all';
    if (!this.diagnosticsPanel || !this.isPanelOpen(this.diagnosticsPanel)) { return; }

    if (!this.diagnosticsHasLoadedFiles) {
      this.diagnosticsPanel.webview.postMessage({
        command: 'modelUsageResult', editor, timeRange, fileCount: 0, filesWithUsage: 0, rows: [], totalCost: 0, stillLoading: true,
      });
      return;
    }

    const files = this.diagnosticsCachedFiles;
    const editorMatching = editor === 'all' ? files : files.filter(f => (f.editorSource || 'Unknown') === editor);
    const bounds = this.getModelUsageTimeRangeBounds(timeRange);
    const matching = bounds
      ? editorMatching.filter(f => {
        const ts = this.getSessionFileTimestampMs(f);
        return ts !== null && ts >= bounds.startMs && ts < bounds.endMs;
      })
      : editorMatching;
    const { aggregated, filesWithUsage, sessionCounts } = this.aggregateModelUsage(matching);

    const rows = Object.entries(aggregated).map(([model, usage]) => ({
      model,
      sessionCount: sessionCounts[model] || 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedReadTokens: usage.cachedReadTokens || 0,
      cacheCreationTokens: usage.cacheCreationTokens || 0,
      cacheCreation1hTokens: usage.cacheCreation1hTokens || 0,
      estimatedCost: this.calculateEstimatedCost({ [model]: usage }),
    })).sort((a, b) => b.estimatedCost - a.estimatedCost);

    const totalCost = this.calculateEstimatedCost(aggregated);
    // Only Anthropic/Claude models expose a 1-hour cache-TTL pricing tier. If none of the
    // models in this result set have that pricing field, the column would always be a
    // wall of zeros for this provider — hide it instead of showing dead data.
    const supportsCache1h = Object.keys(aggregated).some(model => this.modelPricing[model]?.cacheCreation1hCostPerMillion !== undefined);

    this.diagnosticsPanel.webview.postMessage({
      command: 'modelUsageResult',
      editor,
      timeRange,
      fileCount: matching.length,
      filesWithUsage,
      rows,
      totalCost,
      supportsCache1h,
    });
  }

  /**
   * Computes time-to-first-token averages (overall and per model) bucketed by day/week/month,
   * for the Research > TTFT diagnostics tab. Reads every session's debug log fresh on each
   * request rather than persisting samples in the session cache — TTFT is a Research-tab
   * curiosity, not something the dashboard's cost/token numbers depend on, so it doesn't
   * warrant a session-cache schema change. The scan range comes from the tab's own picker
   * (default 14 days, up to "all time") rather than the Diagnostics screen's 14-day/500-file
   * discovery cap, which would otherwise silently hide real `attrs.ttft` data on older sessions.
   * See collectTtftSamples() for the scan and docs/logFilesSchema/vscode-chat-debug-log-format.md
   * for what attrs.ttft is and isn't.
   */
  private async diagHandleAnalyzeTtft(message: any): Promise<void> {
    const granularity: TtftGranularity = message?.granularity === 'week' || message?.granularity === 'month' ? message.granularity : 'day';
    const scanRange: TtftScanRange = message?.scanRange === '30d' || message?.scanRange === '90d' || message?.scanRange === '180d' || message?.scanRange === '365d' || message?.scanRange === 'all'
      ? message.scanRange
      : '14d';
    if (!this.diagnosticsPanel || !this.isPanelOpen(this.diagnosticsPanel)) { return; }

    if (!this.diagnosticsHasLoadedFiles) {
      this.diagnosticsPanel.webview.postMessage({ command: 'ttftResult', granularity, buckets: [], series: [], sampleCount: 0, fileCount: 0, stillLoading: true });
      return;
    }

    const { samples, fileCount } = await this.collectTtftSamples(scanRange);
    const buckets = _buildTtftBuckets(samples, granularity);
    const series = _buildTtftModelSeries(buckets);

    this.diagnosticsPanel.webview.postMessage({
      command: 'ttftResult',
      granularity,
      buckets: buckets.map(b => ({ key: b.key, label: b.label, avgSeconds: b.avgSeconds, count: b.count })),
      series,
      sampleCount: samples.length,
      fileCount,
    });
  }

  private async diagHandlePickWorktreeRoot(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Select Root Folder to Scan" });
    if (uris && uris.length > 0 && this.analysisPanel && this.isPanelOpen(this.analysisPanel)) {
      this.analysisPanel.webview.postMessage({ command: "worktreeRootPicked", folderPath: uris[0].fsPath });
    }
  }

  private async diagHandleScanWorktrees(message: any): Promise<void> {
    const rootPaths: string[] = Array.isArray(message.rootPaths)
      ? message.rootPaths.filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 0).map((p: string) => p.trim())
      : [];
    await this.context.globalState.update("worktrees.scanRoots", rootPaths);
    if (!this.analysisPanel) { return; }
    if (rootPaths.length === 0) {
      this.analysisPanel.webview.postMessage({ command: "worktreeScanComplete", totalWorktrees: 0, elapsedMs: 0 });
      return;
    }
    await this.scanWorktreesIncremental(this.analysisPanel, rootPaths);
  }

  private diagHandleCancelWorktreeScan(): void {
    this.worktreeScanId++;
    if (this.analysisPanel && this.isPanelOpen(this.analysisPanel)) {
      this.analysisPanel.webview.postMessage({ command: "worktreeScanCancelled" });
    }
  }

  /**
   * Incrementally discovers uncleaned git worktree folders under the given root paths and
   * streams progress + per-worktree results to the diagnostics webview as they're found.
   * A worktree is identified by a ".git" FILE (not a directory) containing a "gitdir:" pointer.
   */
  private async scanWorktreesIncremental(panel: vscode.WebviewPanel, rootPaths: string[]): Promise<void> {
    const scanId = ++this.worktreeScanId;
    const excludeDirs = new Set(["node_modules", ".git", ".hg", ".svn", "packages", "vendor"]);
    const startTime = Date.now();
    const isActive = () => scanId === this.worktreeScanId;
    const send = (msg: Record<string, unknown>) => { if (this.isPanelOpen(panel)) { panel.webview.postMessage(msg); } };

    send({ command: "worktreeScanStarted", rootPaths });

    // Phase 1 — fast discovery: locate worktrees and report each with cheap git metadata only
    // (size and push status are left pending and filled in during phase 2).
    const discovered = await _scanWorktreeRootsWithTimeout<WorktreeScanResult>({
      roots: rootPaths,
      isActive,
      scanRoot: async (root, isRootActive) => {
        let isDirectory = false;
        try { isDirectory = (await fs.promises.stat(root)).isDirectory(); } catch { isDirectory = false; }
        if (!isRootActive()) { return []; }
        if (!isDirectory) {
          send({ command: "worktreeScanRootSkipped", root, reason: "Path does not exist or is not a directory" });
          return [];
        }

        send({ command: "worktreeScanRootStarted", root });
        const gitMarkers: string[] = [];
        // Report folder-walk progress (throttled) so the user sees activity on large roots
        // long before the first worktree is found.
        let dirsScanned = 0;
        let lastWalkPost = 0;
        const onDir = (): void => {
          if (!isRootActive()) { return; }
          dirsScanned++;
          const now = Date.now();
          if (now - lastWalkPost >= 200) {
            lastWalkPost = now;
            send({ command: "worktreeScanWalkProgress", root, dirsScanned, markersFound: gitMarkers.length, elapsedMs: now - startTime });
          }
        };
        await this.findGitMarkerFiles(root, excludeDirs, gitMarkers, isRootActive, onDir);
        if (!isRootActive()) { return []; }
        send({ command: "worktreeScanRootMarkersFound", root, count: gitMarkers.length });

        return this.discoverWorktreesFromMarkers(gitMarkers, root, isRootActive, send, startTime);
      },
      onRootError: (root, error) => {
        send({ command: "worktreeScanRootSkipped", root, reason: error.message });
      },
    });
    if (!isActive()) { return; }

    // Phase 2 — background enrichment: compute disk size and push status concurrently and
    // patch each row as results arrive, so discovery is not blocked by these slow operations.
    await this.enrichWorktrees(discovered, isActive, send, startTime);
    if (!isActive()) { return; }

    send({ command: "worktreeScanComplete", totalWorktrees: discovered.length, elapsedMs: Date.now() - startTime });
  }

  /**
   * Starts the once-daily background worktree scan if it's due and this window is the current
   * refresh leader. A no-op most of the time (cheap timestamp check); when it does run, it runs
   * detached from the caller so it never blocks the cache refresh that gated it.
   */
  private async maybeStartBackgroundWorktreeScan(): Promise<void> {
    if (this.backgroundWorktreeScanRunning) { return; }
    const startedAt = this.context.globalState.get<string>(CopilotTokenTracker.WORKTREE_BG_SCAN_STARTED_KEY);
    if (!_shouldRunDailyWorktreeScan(startedAt, Date.now())) { return; }
    const rootPaths = this.buildInitialWorktreeRoots();
    if (rootPaths.length === 0) { return; }

    this.backgroundWorktreeScanRunning = true;
    const scanId = ++this.backgroundWorktreeScanId;
    await this.context.globalState.update(CopilotTokenTracker.WORKTREE_BG_SCAN_STARTED_KEY, new Date().toISOString());
    this.log(`🌳 Starting daily background worktree scan across ${rootPaths.length} root(s)`);
    try {
      await this.runBackgroundWorktreeScan(rootPaths, scanId);
    } catch (err) {
      this.warn(`Background worktree scan failed: ${err}`);
    } finally {
      this.backgroundWorktreeScanRunning = false;
    }
  }

  /**
   * Drip-scans the given roots at low concurrency with pacing delays between each worktree, so
   * the scan can run unattended over the course of the day without contending with foreground
   * disk activity. Reuses the same discovery/enrichment helpers as the interactive Worktrees tab
   * scan, just with no webview to stream progress to and much gentler throttling.
   */
  private async runBackgroundWorktreeScan(rootPaths: string[], scanId: number): Promise<void> {
    const excludeDirs = new Set(["node_modules", ".git", ".hg", ".svn", "packages", "vendor"]);
    const isActive = () => scanId === this.backgroundWorktreeScanId;
    const noop = () => { /* no webview open for this scan — findings are persisted instead */ };
    const startTime = Date.now();

    const discovered: WorktreeScanResult[] = [];
    for (const root of rootPaths) {
      if (!isActive()) { return; }
      let isDirectory = false;
      try { isDirectory = (await fs.promises.stat(root)).isDirectory(); } catch { isDirectory = false; }
      if (!isDirectory) { continue; }

      const gitMarkers: string[] = [];
      await this.findGitMarkerFiles(root, excludeDirs, gitMarkers, isActive);
      if (!isActive()) { return; }

      discovered.push(...await this.discoverWorktreesFromMarkers(gitMarkers, root, isActive, noop, startTime, { concurrency: 1, throttleMs: 200 }));
      if (!isActive()) { return; }
      await this.sleep(500);
    }

    await this.enrichWorktrees(discovered, isActive, noop, startTime, { concurrency: 1, throttleMs: 400 });
    if (!isActive()) { return; }

    await this.finishBackgroundWorktreeScan(discovered);
  }

  /** Persists the completed background scan and decides whether to surface a findings notification. */
  private async finishBackgroundWorktreeScan(discovered: WorktreeScanResult[]): Promise<void> {
    const totalBytes = _sumWorktreeBytes(discovered);
    const result: WorktreeBackgroundScanResult = {
      scannedAt: new Date().toISOString(),
      totalBytes,
      worktreeCount: discovered.length,
      worktrees: discovered,
    };
    await this.context.globalState.update(CopilotTokenTracker.WORKTREE_BG_SCAN_RESULT_KEY, result);
    this.postWorktreeBackgroundResults();

    const lastNotifiedBytes = this.context.globalState.get<number>(CopilotTokenTracker.WORKTREE_BG_SCAN_NOTIFIED_BYTES_KEY);
    if (_shouldNotifyWorktreeFindings(totalBytes, lastNotifiedBytes)) {
      await this.context.globalState.update(CopilotTokenTracker.WORKTREE_BG_SCAN_NOTIFIED_BYTES_KEY, totalBytes);
      this.showWorktreeFindingsNotification(totalBytes, discovered.length);
    }
    this.log(`🌳 Background worktree scan complete: ${discovered.length} worktree(s), ${_formatBytesForNotification(totalBytes)}`);
  }

  /** Native notification pointing the user at the Worktrees tab findings. Fire-and-forget. */
  private showWorktreeFindingsNotification(totalBytes: number, count: number): void {
    const sizeLabel = _formatBytesForNotification(totalBytes);
    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        `We found ${sizeLabel} of data hidden in ${count} git worktree${count === 1 ? "" : "s"} that might no longer be needed.`,
        "Show Me",
      );
      if (choice === "Show Me") { await this.showUsageAnalysisOnWorktreesTab(); }
    })();
  }

  /** Sends the persisted background scan result to the Usage Analysis webview, if it's open. */
  private postWorktreeBackgroundResults(): void {
    if (!this.analysisPanel) { return; }
    const result = this.context.globalState.get<WorktreeBackgroundScanResult>(CopilotTokenTracker.WORKTREE_BG_SCAN_RESULT_KEY);
    if (!result) { return; }
    void this.analysisPanel.webview.postMessage({ command: "worktreeBackgroundResults", ...result });
  }

  /**
   * Resolve .git markers to unique worktree roots (cheap, sequential) then fetch cheap git
   * metadata concurrently, streaming each worktree to the webview as soon as it is known.
   */
  private async discoverWorktreesFromMarkers(
    gitMarkers: string[],
    root: string,
    isActive: () => boolean,
    send: (msg: Record<string, unknown>) => void,
    startTime: number,
    options?: { concurrency?: number; throttleMs?: number },
  ): Promise<WorktreeScanResult[]> {
    const concurrency = options?.concurrency ?? 8;
    const throttleMs = options?.throttleMs ?? 0;
    const foundRoots: string[] = [];
    const worktreeRoots: string[] = [];
    let checked = 0;
    for (const markerFile of gitMarkers) {
      if (!isActive()) { return []; }
      checked++;
      const worktreeRoot = await this.resolveWorktreeRootFromMarker(markerFile, foundRoots);
      if (worktreeRoot) { worktreeRoots.push(worktreeRoot); }
      if (checked % 10 === 0 || checked === gitMarkers.length) {
        send({ command: "worktreeScanProgress", root, checked, total: gitMarkers.length, foundCount: worktreeRoots.length, elapsedMs: Date.now() - startTime });
      }
    }

    const discovered: WorktreeScanResult[] = [];
    await this.runWithConcurrency(worktreeRoots, async (worktreeRoot) => {
      if (!isActive()) { return; }
      const result = await this.buildWorktreeDiscovery(worktreeRoot);
      if (!isActive()) { return; }
      discovered.push(result);
      send({ command: "worktreeFound", worktree: result });
      if (throttleMs) { await this.sleep(throttleMs); }
    }, concurrency);
    return discovered;
  }

  /**
   * Compute disk usage and push status for every discovered worktree, with bounded concurrency,
   * streaming a `worktreeEnriched` patch per worktree plus throttled overall progress.
   */
  private async enrichWorktrees(
    worktrees: WorktreeScanResult[],
    isActive: () => boolean,
    send: (msg: Record<string, unknown>) => void,
    startTime: number,
    options?: { concurrency?: number; throttleMs?: number },
  ): Promise<void> {
    const concurrency = options?.concurrency ?? 4;
    const throttleMs = options?.throttleMs ?? 0;
    const total = worktrees.length;
    if (total === 0) { return; }
    send({ command: "worktreeEnrichStarted", total, elapsedMs: Date.now() - startTime });
    let enriched = 0;
    let lastPost = 0;
    await this.runWithConcurrency(worktrees.map((w) => w.path), async (worktreePath) => {
      if (!isActive()) { return; }
      const [stats, pushed] = await Promise.all([
        this.computeFolderStats(worktreePath),
        this.getWorktreePushedStatus(worktreePath),
      ]);
      if (!isActive()) { return; }
      // Patch the caller's own objects (not just the webview, which tracks its own copy from
      // the message below) so callers without a webview — the background scan — still end up
      // with fully-enriched results in `worktrees` once this resolves.
      const target = worktrees.find((w) => w.path === worktreePath);
      if (target) { target.files = stats.files; target.folders = stats.folders; target.bytes = stats.bytes; target.pushed = pushed; }
      enriched++;
      send({ command: "worktreeEnriched", path: worktreePath, files: stats.files, folders: stats.folders, bytes: stats.bytes, pushed });
      const now = Date.now();
      if (now - lastPost >= 200 || enriched === total) {
        lastPost = now;
        send({ command: "worktreeEnrichProgress", enriched, total, elapsedMs: now - startTime });
      }
      if (throttleMs) { await this.sleep(throttleMs); }
    }, concurrency);
  }


  /**
   * Recursively collects paths to ".git" marker FILES (worktree pointers) under `dir`,
   * skipping excluded directory names for speed. Does not descend into any ".git" entry
   * itself (file or directory), so nested worktrees inside a scanned repo are still found.
   */
  private async findGitMarkerFiles(dir: string, excludeDirs: Set<string>, results: string[], isActive: () => boolean, onDir?: () => void): Promise<void> {
    if (!isActive()) { return; }
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    onDir?.();
    for (const entry of entries) {
      if (!isActive()) { return; }
      if (entry.name === ".git") {
        if (entry.isFile()) { results.push(path.join(dir, entry.name)); }
        continue;
      }
      if (entry.isDirectory() && !excludeDirs.has(entry.name)) {
        await this.findGitMarkerFiles(path.join(dir, entry.name), excludeDirs, results, isActive, onDir);
      }
    }
  }

  /**
   * Validates a ".git" marker file points to a worktree (starts with "gitdir:") and skips
   * worktrees nested inside an already-discovered worktree. Returns the worktree root, or null.
   */
  private async resolveWorktreeRootFromMarker(markerFile: string, foundRoots: string[]): Promise<string | null> {
    let firstLine = "";
    try {
      const handle = await fs.promises.open(markerFile, "r");
      try {
        const buf = Buffer.alloc(200);
        const { bytesRead } = await handle.read(buf, 0, 200, 0);
        firstLine = buf.toString("utf8", 0, bytesRead).split(/\r?\n/)[0];
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    if (!firstLine.startsWith("gitdir:")) { return null; }

    const worktreeRoot = path.dirname(markerFile);
    const normalizedRoot = worktreeRoot.toLowerCase();
    for (const known of foundRoots) {
      if (normalizedRoot.startsWith(known.toLowerCase() + path.sep)) { return null; }
    }
    foundRoots.push(worktreeRoot);
    return worktreeRoot;
  }

  /**
   * Fast per-worktree discovery: cheap git metadata only (branch, last commit, remote → repo
   * label). Size and push status are left pending (-1 / "?") and filled in by enrichWorktrees.
   */
  private async buildWorktreeDiscovery(worktreeRoot: string): Promise<WorktreeScanResult> {
    const gitInfo = await this.getWorktreeGitInfoFast(worktreeRoot);
    const repoLabel = gitInfo.remoteUrl ? this.getRepoLabelFromRemote(gitInfo.remoteUrl) : path.basename(path.dirname(worktreeRoot));
    return {
      path: worktreeRoot,
      repoLabel,
      branch: gitInfo.branch,
      lastCommit: gitInfo.lastCommit,
      lastCommitDate: gitInfo.lastCommitDate,
      pushed: "?",
      files: -1,
      folders: -1,
      bytes: -1,
    };
  }

  /** Recursively computes file/folder counts and total byte size for a worktree (no exclusions — reflects true disk usage). */
  private async computeFolderStats(dir: string): Promise<{ files: number; folders: number; bytes: number }> {
    let files = 0, folders = 0, bytes = 0;
    const walk = async (d: string): Promise<void> => {
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          folders++;
          await walk(full);
        } else if (entry.isFile()) {
          files++;
          try { bytes += (await fs.promises.stat(full)).size; } catch { /* unreadable file, skip its size */ }
        }
      }
    };
    await walk(dir);
    return { files, folders, bytes };
  }

  /** Runs a git subcommand without blocking the event loop; resolves { ok, stdout } (never rejects). */
  private runGit(args: string[], cwd: string, timeoutMs = 8000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      childProcess.execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: getLocaleStableGitEnvironment(),
        },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() }),
      );
    });
  }

  /** Cheap git metadata for discovery (branch, last commit, remote). Excludes the slow push check. */
  private async getWorktreeGitInfoFast(worktreeRoot: string): Promise<{ branch: string; lastCommit: string; lastCommitDate: string | null; remoteUrl: string }> {
    const [branch, lastCommit, lastCommitDate, remoteUrl] = await Promise.all([
      this.runGit(["branch", "--show-current"], worktreeRoot),
      this.runGit(["log", "-1", "--format=%cr"], worktreeRoot),
      this.runGit(["log", "-1", "--format=%cI"], worktreeRoot),
      this.runGit(["remote", "get-url", "origin"], worktreeRoot),
    ]);
    return {
      branch: branch.stdout || "?",
      lastCommit: lastCommit.stdout || "?",
      lastCommitDate: lastCommitDate.stdout || null,
      remoteUrl: remoteUrl.ok ? remoteUrl.stdout : "",
    };
  }

  /** Whether every local commit is present on some remote. "?" when it cannot be determined. */
  private async getWorktreePushedStatus(worktreeRoot: string): Promise<"yes" | "no" | "?"> {
    const r = await this.runGit(["log", "--oneline", "--not", "--remotes", "--branches"], worktreeRoot);
    if (!r.ok) { return "?"; }
    return r.stdout === "" ? "yes" : "no";
  }

  private getRepoLabelFromRemote(remoteUrl: string): string {
    const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
    return match ? match[1] : remoteUrl;
  }

  /** Counts `git status --porcelain` lines, split into untracked ("??") and modified/staged. */
  private async getWorktreeDirtyCounts(worktreeRoot: string): Promise<{ modifiedFiles?: number; untrackedFiles?: number }> {
    const status = await this.runGit(["status", "--porcelain"], worktreeRoot);
    if (!status.ok) { return {}; }
    const lines = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const untrackedFiles = lines.filter((line) => line.startsWith("??")).length;
    return { modifiedFiles: lines.length - untrackedFiles, untrackedFiles };
  }

  /**
   * Upstream tracking info: the upstream ref name, whether it still exists on the remote
   * (a branch deleted after a merged PR is the single most common reason a leftover worktree
   * is safe to remove), and the ahead/behind commit counts against it.
   *
   * A failing `@{upstream}` lookup is ambiguous — it means both "this branch has no upstream"
   * and "this is not a readable git worktree" — so the worktree is probed for readability
   * first. When that probe fails nothing is reported, because claiming "never pushed" for a
   * worktree we could not read would put a false remediation fact in front of the user.
   */
  private async getWorktreeRemoteBranchInfo(worktreeRoot: string): Promise<{ remoteBranch?: string; remoteStatus?: "tracked" | "gone" | "none"; ahead?: number; behind?: number }> {
    const readable = await this.runGit(["rev-parse", "--is-inside-work-tree"], worktreeRoot);
    if (!readable.ok || readable.stdout !== "true") { return {}; }

    const upstream = await this.runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], worktreeRoot);
    if (!upstream.ok || !upstream.stdout) { return { remoteStatus: "none" }; }
    const remoteBranch = upstream.stdout;
    // Resolving the remote-tracking ref locally (no network) tells us whether git still knows
    // about that branch; a pruned/deleted remote branch leaves the upstream name but no ref.
    const refExists = await this.runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteBranch}`], worktreeRoot);
    const counts = await this.runGit(["rev-list", "--left-right", "--count", `HEAD...${remoteBranch}`], worktreeRoot);
    const [aheadRaw, behindRaw] = counts.ok ? counts.stdout.split(/\s+/) : [];
    return {
      remoteBranch,
      remoteStatus: refExists.ok && refExists.stdout.length > 0 ? "tracked" : "gone",
      ahead: Number.isFinite(Number(aheadRaw)) && aheadRaw !== undefined ? Number(aheadRaw) : undefined,
      behind: Number.isFinite(Number(behindRaw)) && behindRaw !== undefined ? Number(behindRaw) : undefined,
    };
  }

  /** Newest mtime among the worktree root's direct entries, as an ISO string ("when was this last touched"). */
  private async getWorktreeLastModified(worktreeRoot: string): Promise<string | undefined> {
    try {
      const entries = await fs.promises.readdir(worktreeRoot, { withFileTypes: true });
      let newest = (await fs.promises.stat(worktreeRoot)).mtimeMs;
      for (const entry of entries) {
        if (entry.name === ".git") { continue; }
        try {
          const stat = await fs.promises.stat(path.join(worktreeRoot, entry.name));
          if (stat.mtimeMs > newest) { newest = stat.mtimeMs; }
        } catch { /* unreadable entry, ignore */ }
      }
      return new Date(newest).toISOString();
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort remediation context for a worktree the cleanup skipped or failed on. Every
   * probe degrades independently, so a partially broken repository still yields whatever
   * fields could be read instead of an all-or-nothing failure.
   */
  private async collectWorktreeCleanupDiagnostics(worktreeRoot: string): Promise<WorktreeCleanupDiagnostics> {
    const [lastModified, lastCommitDate, lastCommitRelative, remoteInfo, dirty] = await Promise.all([
      this.getWorktreeLastModified(worktreeRoot),
      this.runGit(["log", "-1", "--format=%cI"], worktreeRoot),
      this.runGit(["log", "-1", "--format=%cr"], worktreeRoot),
      this.getWorktreeRemoteBranchInfo(worktreeRoot),
      this.getWorktreeDirtyCounts(worktreeRoot),
    ]);
    return {
      lastModified,
      lastCommitDate: lastCommitDate.ok && lastCommitDate.stdout ? lastCommitDate.stdout : undefined,
      lastCommitRelative: lastCommitRelative.ok && lastCommitRelative.stdout ? lastCommitRelative.stdout : undefined,
      ...remoteInfo,
      ...dirty,
    };
  }

  /**
   * Resolve the main (non-linked) repository root that owns a given worktree, so `git worktree
   * remove` can be run from a location git recognizes as the repository. Returns null when the
   * shared .git directory cannot be resolved or does not sit at the root of a normal (non-bare)
   * working tree — callers should refuse to proceed rather than guess in that case.
   */
  private async resolveMainRepoRoot(worktreePath: string): Promise<string | null> {
    let commonDir = (await this.runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath)).stdout;
    if (!commonDir) {
      const legacy = await this.runGit(["rev-parse", "--git-common-dir"], worktreePath);
      if (!legacy.ok || !legacy.stdout) { return null; }
      commonDir = path.isAbsolute(legacy.stdout) ? legacy.stdout : path.resolve(worktreePath, legacy.stdout);
    }
    if (path.basename(commonDir).toLowerCase() !== ".git") { return null; }
    return path.dirname(commonDir);
  }

  /**
   * Removes a linked worktree via `git worktree remove` (never a raw folder delete): this keeps
   * the main repository's worktree registry consistent and — without `force` — refuses when the
   * worktree has uncommitted or untracked changes, protecting the user from silently losing work.
   * Committed history is never at risk either way, since it lives in the shared object database.
   */
  private async removeGitWorktree(mainRepoRoot: string, worktreePath: string, force: boolean): Promise<{ ok: boolean; stderr: string }> {
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath];
    const result = await this.runGit(args, mainRepoRoot, 120000);
    return { ok: result.ok, stderr: result.stderr };
  }

  /**
   * True when git's own directory-removal step failed at the OS level (git's message is
   * "failed to delete/remove '<path>': <errno text>") as opposed to refusing for a safety
   * reason (uncommitted/untracked changes). On Windows this is a known git-for-windows gap:
   * its internal directory walker can choke on reparse points/junctions (e.g. a pnpm
   * node_modules layout) or paths exceeding MAX_PATH, well after git's dirty-tree check has
   * already passed — so falling back to a direct filesystem delete here does not relax that
   * safety check, it only swaps out a less capable directory-removal implementation for a
   * more capable one (Node's fs.rm).
   */
  /** Deletes a worktree's folder directly (Node's fs.rm handles junctions/long paths git's Windows walker sometimes cannot). */
  private async forceRemoveWorktreeDirectory(worktreePath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await fs.promises.rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Falls back to a direct filesystem delete + git registration cleanup when git's own
   * directory-removal step failed at the OS level (see isWorktreeDirectoryRemovalFailure).
   * Returns the final remove/prune result.
   */
  private async removeWorktreeDirectoryFallback(mainRepoRoot: string, worktreePath: string): Promise<{ ok: boolean; stderr: string }> {
    const manual = await this.forceRemoveWorktreeDirectory(worktreePath);
    if (!manual.ok) {
      return { ok: false, stderr: `Could not delete the worktree folder: ${manual.error}. Close any editor, terminal, or process using files in "${worktreePath}" and try again.` };
    }
    // The folder is gone; git only needs to clean up its now-trivial administrative record.
    let result = await this.removeGitWorktree(mainRepoRoot, worktreePath, true);
    if (!result.ok) {
      const prune = await this.runGit(["worktree", "prune"], mainRepoRoot, 30000);
      result = { ok: prune.ok, stderr: prune.stderr };
    }
    return result;
  }

  /**
   * Removes a worktree, escalating through a fallback chain: plain removal, then (with user
   * confirmation) force removal for dirty or submodule-containing worktrees, then an OS-level
   * directory-removal fallback for Git-for-Windows junction/long-path failures. Returns the
   * final result, or `undefined` if the user declined a force-delete confirmation.
   */
  private async _removeWorktreeWithFallback(mainRepoRoot: string, worktreePath: string): Promise<{ ok: boolean; stderr: string } | undefined> {
    let result = await this.removeGitWorktree(mainRepoRoot, worktreePath, false);
    if (!result.ok && /modified or untracked/i.test(result.stderr)) {
      const forceChoice = await vscode.window.showWarningMessage(
        `"${worktreePath}" has uncommitted or untracked changes.`,
        { modal: true, detail: "Force-deleting will permanently discard those changes — this cannot be undone. Committed history elsewhere in the repository is not affected." },
        "Force Delete",
      );
      if (forceChoice !== "Force Delete") { return undefined; }
      result = await this.removeGitWorktree(mainRepoRoot, worktreePath, true);
    }

    const submoduleRetry = await retrySubmoduleWorktreeRemovalWithConfirmation(
      worktreePath,
      result,
      (message, options, action) => vscode.window.showWarningMessage(message, options, action),
      () => this.removeGitWorktree(mainRepoRoot, worktreePath, true),
      () => this.removeWorktreeDirectoryFallback(mainRepoRoot, worktreePath),
    );
    if (!submoduleRetry) { return undefined; }
    result = submoduleRetry;

    if (!result.ok && isWorktreeDirectoryRemovalFailure(result.stderr)) {
      result = await this.removeWorktreeDirectoryFallback(mainRepoRoot, worktreePath);
    }
    return result;
  }

  /** Parse and normalize the delete-worktree webview message's fields, defaulting missing ones. */
  private _parseDeleteWorktreeMessage(message: any): { worktreePath: string; branch: string; repoLabel: string; pushed: "yes" | "no" | "?" } {
    const worktreePath = typeof message?.path === "string" ? message.path.trim() : "";
    const branch = typeof message?.branch === "string" && message.branch ? message.branch : "?";
    const repoLabel = typeof message?.repoLabel === "string" && message.repoLabel ? message.repoLabel : path.basename(path.dirname(worktreePath));
    const pushed = message?.pushed === "yes" || message?.pushed === "no" ? message.pushed : "?";
    return { worktreePath, branch, repoLabel, pushed };
  }

  private async diagHandleDeleteWorktree(message: any): Promise<void> {
    const { worktreePath, branch, repoLabel, pushed } = this._parseDeleteWorktreeMessage(message);
    if (!worktreePath) { return; }

    // Progress/outcome messages let the cleanup report show a bar and the final state for the row.
    const post = (msg: Record<string, unknown>) => {
      if (this.analysisPanel && this.isPanelOpen(this.analysisPanel)) { this.analysisPanel.webview.postMessage(msg); }
    };
    const finish = (status: "deleted" | "error" | "cancelled", reason?: string) =>
      post({ command: "worktreeDeleteResult", path: worktreePath, status, reason });

    if (!(await this.confirmDeleteWorktree(worktreePath, branch, repoLabel, pushed))) { finish("cancelled"); return; }

    post({ command: "worktreeDeleteStarted", path: worktreePath });

    const mainRepoRoot = await this.resolveMainRepoRoot(worktreePath);
    if (!mainRepoRoot || path.resolve(mainRepoRoot).toLowerCase() === path.resolve(worktreePath).toLowerCase()) {
      const reason = `Could not safely locate the main repository for "${worktreePath}". Remove it manually with "git worktree remove".`;
      vscode.window.showErrorMessage(reason);
      finish("error", reason);
      return;
    }

    const result = await this._removeWorktreeWithFallback(mainRepoRoot, worktreePath);
    if (!result) { finish("cancelled"); return; }

    if (!result.ok) {
      const reason = result.stderr || l10n.t('usage.worktreeCleanup.unknownError');
      vscode.window.showErrorMessage(`Could not delete worktree: ${reason}`);
      finish("error", reason);
      return;
    }

    this.log(`🗑️ Deleted worktree: ${worktreePath}`);
    vscode.window.showInformationMessage(`Deleted worktree "${branch}" (${repoLabel}).`);
    post({ command: "worktreeDeleted", path: worktreePath });
    finish("deleted");
  }

  /**
   * Opens a worktree folder in a VS Code window so the user can immediately deal with whatever
   * blocked its cleanup (commit, push, or delete files). Uses a new window rather than replacing
   * the current one so the Usage Analysis panel — and the cleanup report it is showing — survives.
   */
  private async diagHandleOpenWorktreeInEditor(message: any): Promise<void> {
    const worktreePath = typeof message?.path === "string" ? message.path.trim() : "";
    if (!worktreePath) { return; }
    try {
      const stat = await fs.promises.stat(worktreePath);
      if (!stat.isDirectory()) { throw new Error("not a directory"); }
    } catch {
      vscode.window.showErrorMessage(`Could not open "${worktreePath}" — the folder no longer exists.`);
      return;
    }
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath), { forceNewWindow: true });
  }

  private diagHandleCancelCleanupPushedWorktrees(): void {
    this.worktreeCleanupId++;
    if (this.analysisPanel && this.isPanelOpen(this.analysisPanel)) {
      this.analysisPanel.webview.postMessage({ command: "cleanupCancelled" });
    }
  }

  /**
   * Bulk-deletes worktrees the caller believes are fully pushed, one at a time. Unlike the
   * single-worktree delete flow, this NEVER force-deletes: if a worktree turns out to have
   * uncommitted/untracked changes or unpushed commits (re-checked live, not trusted from the
   * webview's possibly-stale list), it is skipped and the loop moves on to the next one. The
   * OS-level directory-removal fallback (for git-for-windows junction/long-path failures) still
   * applies, since that is not a safety bypass — the dirty-tree check already passed by then.
   *
   * `message.repoLabel` is optional: when present, the webview has already filtered `worktrees`
   * down to a single repository's row (its own "Clean up" button), and this only changes the
   * confirmation wording to name that repository — the deletion logic is identical either way.
   */
  private async diagHandleCleanupPushedWorktrees(message: any): Promise<void> {
    const { candidates, scopeRepoLabel } = _parseCleanupPushedWorktreesMessage(message);

    if (!this.analysisPanel || !this.isPanelOpen(this.analysisPanel)) { return; }
    const panel = this.analysisPanel;

    if (candidates.length === 0) {
      panel.webview.postMessage({ command: "cleanupDeclined" });
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      _buildCleanupConfirmTitle(candidates.length, scopeRepoLabel),
      {
        modal: true,
        detail: 'Removes worktrees whose commits are already pushed to a remote, using "git worktree remove". Any worktree found to have uncommitted, untracked, or unpushed changes is automatically skipped (never force-deleted) and the cleanup continues with the rest.',
      },
      "Clean Up",
    );
    if (choice !== "Clean Up") {
      panel.webview.postMessage({ command: "cleanupDeclined" });
      return;
    }

    const cleanupId = ++this.worktreeCleanupId;
    const isActive = () => cleanupId === this.worktreeCleanupId;
    const send = (msg: Record<string, unknown>) => { if (this.isPanelOpen(panel)) { panel.webview.postMessage(msg); } };

    send({ command: "cleanupStarted", total: candidates.length });
    let deleted = 0, skipped = 0, errors = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (!isActive()) { break; }
      const target = candidates[i];
      const outcome = await this.cleanupSinglePushedWorktree(target.path);
      if (outcome.status === "deleted") { deleted++; send({ command: "worktreeDeleted", path: target.path }); }
      else if (outcome.status === "skipped") { skipped++; }
      else { errors++; }
      // Only the rows the user still has to act on get the (git-invoking) diagnostics pass.
      const diagnostics = outcome.status === "deleted" ? undefined : await this.collectWorktreeCleanupDiagnostics(target.path);
      send({
        command: "cleanupWorktreeResult",
        path: target.path, branch: target.branch, repoLabel: target.repoLabel,
        status: outcome.status, reason: outcome.reason, diagnostics,
        processed: i + 1, total: candidates.length,
      });
    }

    send({ command: "cleanupComplete", deleted, skipped, errors, cancelled: !isActive() });
    this.log(`🧹 Worktree cleanup finished: ${deleted} deleted, ${skipped} skipped, ${errors} error(s)`);
  }

  /**
   * Attempts to delete a single worktree as part of a bulk cleanup. Re-checks push status live
   * (never trusts the webview's cached value) and never passes --force: a dirty or unpushed
   * worktree is reported as "skipped", not force-removed.
   */
  private async cleanupSinglePushedWorktree(worktreePath: string): Promise<{ status: "deleted" | "skipped" | "error"; reason?: string }> {
    const sessionEvidence = await this.findSessionRepoEvidenceForWorktree(worktreePath);
    const mainRepoRoot = await this.resolveMainRepoRoot(worktreePath);
    const validatedMainRepoRoot = mainRepoRoot ?? sessionEvidence?.repoRoot;
    if (!validatedMainRepoRoot || _normalizePathForDedup(validatedMainRepoRoot) === _normalizePathForDedup(_normalizeToRepoRoot(worktreePath))) {
      return { status: "error", reason: `Could not safely locate the main repository for "${worktreePath}".` };
    }
    if (mainRepoRoot && sessionEvidence && _normalizePathForDedup(mainRepoRoot) !== _normalizePathForDedup(sessionEvidence.repoRoot)) {
      return {
        status: "error",
        reason: `Repo validation failed for "${worktreePath}": git resolved "${mainRepoRoot}" but session "${sessionEvidence.sessionWorkspacePath}" points to "${sessionEvidence.repoRoot}".`,
      };
    }

    const pushed = await this.getWorktreePushedStatus(worktreePath);
    if (pushed !== "yes") {
      return {
        status: "skipped",
        reason: pushed === "no"
          ? `Worktree at "${worktreePath}" has commits not pushed to any remote.`
          : `Could not confirm push status for worktree at "${worktreePath}".`,
      };
    }

    let result = await this.removeGitWorktree(validatedMainRepoRoot, worktreePath, false);
    if (!result.ok && /modified or untracked/i.test(result.stderr)) {
      return { status: "skipped", reason: "Has uncommitted or untracked changes." };
    }
    if (!result.ok && isWorktreeDirectoryRemovalFailure(result.stderr)) {
      result = await this.removeWorktreeDirectoryFallback(validatedMainRepoRoot, worktreePath);
    }
    if (!result.ok) {
      return { status: "error", reason: `Could not delete worktree at "${worktreePath}": ${result.stderr || "unknown error"}` };
    }
    return { status: "deleted" };
  }

  private getKnownSessionWorkspacePaths(): string[] {
    return this.diagnosticsCachedFiles
      .map((details) => typeof details.workspacePath === "string" ? details.workspacePath.trim() : "")
      .filter((value): value is string => value.length > 0);
  }

  private async findSessionRepoEvidenceForWorktree(worktreePath: string): Promise<{ sessionWorkspacePath: string; repoRoot: string } | undefined> {
    const cachedMatch = _validateWorktreeRepoRootFromSessionPaths(worktreePath, this.getKnownSessionWorkspacePaths());
    if (cachedMatch) { return cachedMatch; }

    const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
    const maxFilesToInspect = 25;
    for (const sessionFile of sessionFiles.slice(0, maxFilesToInspect)) {
      try {
        const details = await this.getSessionFileDetails(sessionFile);
        if (!details.workspacePath) { continue; }
        const match = _validateWorktreeRepoRootFromSessionPaths(worktreePath, [details.workspacePath]);
        if (match) { return match; }
      } catch {
        // Ignore individual session parse failures; this is only a best-effort validation path.
      }
    }

    return undefined;
  }

  private async confirmDeleteWorktree(worktreePath: string, branch: string, repoLabel: string, pushed: "yes" | "no" | "?"): Promise<boolean> {
    const unpushedWarning = pushed === "no"
      ? " ⚠️ This worktree has commits that have not been pushed to any remote — deleting it will permanently lose that work."
      : pushed === "?"
        ? " Push status could not be determined — make sure any important work has been pushed first."
        : "";
    const choice = await vscode.window.showWarningMessage(
      `Delete worktree "${branch}" (${repoLabel})?`,
      {
        modal: true,
        detail: `This removes the working copy at:\n${worktreePath}\n\nOnly the local working copy is removed via "git worktree remove" — committed history stays safe in the repository's shared object database. Only uncommitted or unpushed local changes in this worktree can be lost.${unpushedWarning}`,
      },
      "Delete Worktree",
    );
    return choice === "Delete Worktree";
  }

  /**
   * Derive candidate worktree scan roots from discovered sessions and known session folders.
   * Session workspace paths are normalized up to their repo root; known candidate folders are
   * added as-is. Results are deduplicated (case/separator-insensitive) and filtered to paths
   * that currently exist as directories.
   */
  private async computeDiscoveredWorktreeRoots(
    detailedFiles: SessionFileDetails[],
    candidatePaths: { path: string; exists: boolean; source: string }[],
  ): Promise<string[]> {
    const seen = new Set<string>();
    const ordered: string[] = [];
    const add = (raw: string | undefined): void => {
      const value = (raw ?? "").trim();
      if (!value) { return; }
      const key = _normalizePathForDedup(value);
      if (seen.has(key)) { return; }
      seen.add(key);
      ordered.push(value);
    };
    for (const f of detailedFiles) {
      if (f.workspacePath) { add(_normalizeToRepoRoot(f.workspacePath)); }
    }
    for (const cp of candidatePaths) { add(cp.path); }
    const result: string[] = [];
    for (const p of ordered) {
      try { if ((await fs.promises.stat(p)).isDirectory()) { result.push(p); } } catch { /* skip missing */ }
    }
    return result;
  }

  /** Deduplicate a path list case/separator-insensitively, preserving first-seen order. */
  private dedupePathList(paths: (string | undefined)[]): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const r of paths) {
      const value = (typeof r === "string" ? r : "").trim();
      if (!value) { continue; }
      const key = _normalizePathForDedup(value);
      if (seen.has(key)) { continue; }
      seen.add(key);
      merged.push(value);
    }
    return merged;
  }

  /**
   * Merge freshly discovered roots into the persisted worktrees.scanRoots set (existing entries
   * kept first), persist the union, and return it. This is what enables reboot hydration: the
   * next diagnostics open reads worktrees.scanRoots directly.
   */
  private async mergeAndPersistWorktreeRoots(newRoots: string[]): Promise<string[]> {
    const existing = this.context.globalState.get<string[]>("worktrees.scanRoots") ?? [];
    const merged = this.dedupePathList([...existing, ...newRoots]);
    await this.context.globalState.update("worktrees.scanRoots", merged);
    return merged;
  }

  /**
   * Synchronous known-folder roots for first render: the existing candidate-path directories
   * reported by the discovery adapters (e.g. ~/.claude/projects, Copilot session dirs). File
   * candidate paths (e.g. *.db) are excluded so the scanner is not handed a non-directory root.
   */
  private getKnownFolderWorktreeRoots(): string[] {
    let candidatePaths: { path: string; exists: boolean; source: string }[] = [];
    try { candidatePaths = this.sessionDiscovery.getDiagnosticCandidatePaths(); } catch { candidatePaths = []; }
    const dirs = candidatePaths.filter((cp) => {
      try { return fs.statSync(cp.path).isDirectory(); } catch { return false; }
    });
    return this.dedupePathList(dirs.map((cp) => cp.path));
  }

  /** Union of persisted scan roots and known-folder roots, for the initial diagnostics render. */
  private buildInitialWorktreeRoots(): string[] {
    const persisted = this.context.globalState.get<string[]>("worktrees.scanRoots") ?? [];
    return this.dedupePathList([...persisted, ...this.getKnownFolderWorktreeRoots()]);
  }

  /**
   * Compare "normal" (ratio-based estimate, or 0 for DB-only chat sessions) token
   * counts against exact counts from the Copilot CLI OpenTelemetry file export, for
   * every Copilot CLI session where OTel data is available. Powers the diagnostics
   * "OTel Delta" tab, which shows how much more accurate/complete the OTel export
   * makes token tracking versus the estimate-only path.
   */
  private async computeCopilotCliOtelComparison(sessionFiles: string[]): Promise<CopilotCliOtelComparison> {
    const status = await getCopilotCliOtelStatus();
    const candidates = sessionFiles
      .map(file => ({ file, sessionId: extractCopilotCliSessionId(file) }))
      .filter((c): c is { file: string; sessionId: string } => !!c.sessionId);

    const sessions: CopilotCliOtelComparisonSession[] = [];
    let totalBaselineTokens = 0;
    let totalOtelTokens = 0;

    for (const { file, sessionId } of candidates) {
      const otel = await getCopilotCliOtelUsage(file);
      if (!otel) { continue; }

      // DB-only chat sessions (session-store.db#uuid) have no token data of their own
      // and previously always reported 0 — that IS the "normal way" baseline for them.
      let baselineTokens = 0;
      if (file.endsWith('.jsonl')) {
        try {
          const content = await fs.promises.readFile(file, 'utf8');
          baselineTokens = this.estimateTokensFromJsonlSession(content).actualTokens;
        } catch { /* unreadable session file — treat baseline as 0 */ }
      }

      let lastActivity: string | null = null;
      try { lastActivity = (await this.statSessionFile(file)).mtime.toISOString(); } catch { /* stat failed — leave null, filter treats as unknown */ }

      totalBaselineTokens += baselineTokens;
      totalOtelTokens += otel.actualTokens;
      sessions.push({
        file, sessionId, baselineTokens,
        otelTokens: otel.actualTokens,
        delta: otel.actualTokens - baselineTokens,
        models: Object.keys(otel.modelUsage),
        lastActivity,
      });
    }

    sessions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return {
      otelDirExists: status.dirExists,
      otelFileCount: status.fileCount,
      otelSessionsIndexed: status.sessionsIndexed,
      sessionsChecked: candidates.length,
      sessionsMatched: sessions.length,
      totalBaselineTokens,
      totalOtelTokens,
      deltaTokens: totalOtelTokens - totalBaselineTokens,
      sessions: sessions.slice(0, 100),
    };
  }

  /** Computes the Copilot CLI OTel comparison, swallowing errors — this is an optional diagnostics enrichment. */
  private async tryComputeCopilotCliOtelComparison(sessionFiles: string[]): Promise<CopilotCliOtelComparison | null> {
    try {
      return await this.computeCopilotCliOtelComparison(sessionFiles);
    } catch (error) {
      this.warn(`Failed to compute Copilot CLI OTel comparison: ${error}`);
      return null;
    }
  }

  /**
   * Computes Backend Storage + GitHub Auth status and posts it to the webview immediately.
   * These are cheap relative to the stats/usage-analysis/report pipeline, so sending them early
   * lets the Settings > Backend Storage tab populate right away instead of showing a "not
   * available" placeholder for the several seconds the rest of diagnostics load takes.
   * Returns backendStorageInfo/githubAuthStatus so the caller can reuse them in the final
   * diagnosticDataLoaded message.
   */
  private async sendBackendStorageInfoEarly(
    panel: vscode.WebviewPanel,
  ): Promise<{
    backendStorageInfo: any;
    githubAuthStatus: { authenticated: boolean; username?: string };
  }> {
    const backendStorageInfo = await this.getBackendStorageInfo();
    this.log(
      `Backend storage info retrieved: azure.enabled=${backendStorageInfo.azure?.enabled}, azure.configured=${backendStorageInfo.azure?.isConfigured}, teamServer.enabled=${backendStorageInfo.teamServer?.enabled}, teamServer.configured=${backendStorageInfo.teamServer?.isConfigured}`,
    );
    const githubAuthStatus = this.getGitHubAuthStatus();
    if (this.isPanelOpen(panel)) {
      panel.webview.postMessage({
        command: "backendStorageInfoLoaded",
        backendStorageInfo,
        githubAuth: githubAuthStatus,
      });
    }
    return { backendStorageInfo, githubAuthStatus };
  }



  /**
   * Load all diagnostic data in the background and update the webview progressively.
   */
  private async loadDiagnosticDataInBackground(
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    try {
      this.log("🔄 Loading diagnostic data in background...");

      if (this._sessionRestorePromise) {
        await this._sessionRestorePromise;
      }

      const { backendStorageInfo, githubAuthStatus } = await this.sendBackendStorageInfoEarly(panel);

      if (!this.currentDetailedStats) {
        this.log(
          "⚡ No cached stats found - forcing initial stats calculation to populate cache...",
        );
        await this.updateTokenStats(true);
        this.log("✅ Cache populated, proceeding with diagnostics load");
      }

      if (!this.currentUsageAnalysisStats) {
        this.log("⚡ No usage analysis stats cached - computing for tool analysis tab...");
        await this.calculateUsageAnalysisStats(false);
        this.log("✅ Usage analysis stats computed");
      }

      const report = await this.generateDiagnosticReport();
      this.lastDiagnosticReport = report;

      const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
      this.diagnosticsAllSessionFiles = sessionFiles;
      this.diagnosticsTtftCache.clear();
      const sessionFileData = await this.getSessionFilePreviewData(sessionFiles);
      const sessionFolders = this.buildSessionFolderData(sessionFiles);
      const candidatePaths = this.sessionDiscovery.getDiagnosticCandidatePaths();
      const otelComparison = await this.tryComputeCopilotCliOtelComparison(sessionFiles);

      if (!this.isPanelOpen(panel)) {
        this.log("Diagnostic panel closed during data load, aborting update");
        return;
      }

      this.log(
        `Sending backend info to webview: ${backendStorageInfo ? "present" : "missing"}`,
      );
      panel.webview.postMessage({
        command: "diagnosticDataLoaded",
        report,
        sessionFiles: sessionFileData,
        sessionFolders,
        candidatePaths,
        backendStorageInfo,
        githubAuth: githubAuthStatus,
        accountBudgets: this._accountBudgets,
        // Carried with the list so the webview takes its full quota-card refresh path if a direct update was missed.
        quotaEntitlements: this._copilotQuotaEntitlements,
        toolCallStats: this.currentUsageAnalysisStats?.last30Days?.toolCalls ?? null,
        skillCallStats: this.currentUsageAnalysisStats?.last30Days?.skillCalls ?? null,
        skillCallsByEditor: this._lastSkillCallsByEditor ?? null,
        skillDescriptions: this._buildSkillDescriptions(),
        toolFamilies: getToolFamilies(),
        otelComparison,
      });

      this.log("✅ Diagnostic data loaded and sent to webview");

      this.loadSessionFilesInBackground(panel, sessionFiles);
    } catch (error) {
      this.error(`Failed to load diagnostic data: ${error}`);
      if (this.isPanelOpen(panel)) {
        panel.webview.postMessage({
          command: "diagnosticDataError",
          error: String(error),
        });
      }
    }
  }

  private async getSessionFilePreviewData(sessionFiles: string[]): Promise<{ file: string; size: number; modified: string }[]> {
    const sessionFileData: { file: string; size: number; modified: string }[] = [];
    for (const file of sessionFiles.slice(0, 20)) {
      try {
        const stat = await this.statSessionFile(file);
        sessionFileData.push({ file, size: stat.size, modified: stat.mtime.toISOString() });
      } catch {
        // Skip inaccessible files
      }
    }
    return sessionFileData;
  }

  private buildSessionFolderData(sessionFiles: string[]): { dir: string; count: number; editorName: string }[] {
    const dirCounts = new Map<string, number>();
    const dirEditorNames = new Map<string, string>();
    const pathModule = require("path");
    const copilotSessionStateDir = pathModule.join(os.homedir(), ".copilot", "session-state");
    for (const file of sessionFiles) {
      const eco = this.findEcosystem(file);
      if (eco) {
        const editorRoot = eco.getEditorRoot(file);
        dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
        dirEditorNames.set(editorRoot, getEcosystemDisplayName(eco, file));
        continue;
      }
      const parts = file.split(/[\\\/]/);
      const userIdx = parts.findIndex((p: string) => p.toLowerCase() === "user");
      let editorRoot = "";
      if (userIdx > 0) {
        editorRoot = pathModule.join(...parts.slice(0, Math.min(parts.length, userIdx + 2)));
      } else {
        editorRoot = pathModule.dirname(file);
      }
      if (editorRoot.startsWith(copilotSessionStateDir) && editorRoot !== copilotSessionStateDir) {
        editorRoot = copilotSessionStateDir;
      }
      dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
    }
    return Array.from(dirCounts.entries()).map(([dir, count]) => ({
      dir, count, editorName: dirEditorNames.get(dir) || this.getEditorNameFromRoot(dir),
    }));
  }

  /**
   * Check if a webview panel is still open and accessible.
   * A panel is considered open if its viewColumn is defined.
   */
  private isPanelOpen(panel: vscode.WebviewPanel): boolean {
    return panel.viewColumn !== undefined;
  }


  /**
   * Load session file details in the background and send to webview.
   */
  private async loadSessionFilesInBackground(panel: vscode.WebviewPanel, sessionFiles: string[]): Promise<void> {
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const detailedSessionFiles: SessionFileDetails[] = [];
    const initialCacheHits = this._cacheHits;
    const initialCacheMisses = this._cacheMisses;
    const filesToProcess = await this.selectSessionFilesRoundRobin(sessionFiles, fourteenDaysAgo.getTime());
    const total = filesToProcess.length;
    let processed = 0;
    let lastProgressPost = Date.now();
    for (const file of filesToProcess) {
      if (!this.isPanelOpen(panel)) { this.log("Diagnostic panel closed, stopping background load"); return; }
      try {
        const details = await this.getSessionFileDetails(file);
        const lastActivity = details.lastInteraction ? new Date(details.lastInteraction) : new Date(details.modified);
        if (lastActivity >= fourteenDaysAgo) { detailedSessionFiles.push(details); }
      } catch { /* Skip inaccessible files */ }
      processed++;
      // Throttle progress updates to ~5/sec so large scans don't flood the webview with messages.
      const now = Date.now();
      if (now - lastProgressPost >= 200 || processed === total) {
        lastProgressPost = now;
        panel.webview.postMessage({ command: "sessionFilesLoadProgress", processed, total });
      }
      await yieldToEventLoop();
    }
    await this.enrichSessionHierarchy(detailedSessionFiles);
    await this.enrichPiSessionHierarchy(detailedSessionFiles);
    await this.sendBgLoadResults(panel, detailedSessionFiles, initialCacheHits, initialCacheMisses);
  }

  /**
   * Extract the Copilot CLI events.jsonl UUID from a session file path.
   * Handles both:
   *   - ~/.copilot/session-state/{uuid}/events.jsonl  → returns the uuid directory name
   *   - ~/.copilot/session-store.db#{uuid}           → returns the uuid after '#'
   * Returns null for all other session types.
   */
  private extractCopilotCliUuid(sessionFile: string): string | null {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Virtual DB path: .../session-store.db#uuid
    if (sessionFile.includes('session-store.db#')) {
      const uuid = sessionFile.split('session-store.db#')[1] ?? '';
      return UUID_RE.test(uuid) ? uuid : null;
    }
    // events.jsonl path: .../session-state/{uuid}/events.jsonl
    if (sessionFile.includes('session-state')) {
      const uuid = path.basename(path.dirname(sessionFile));
      return UUID_RE.test(uuid) ? uuid : null;
    }
    return null;
  }

  /**
   * Enrich Copilot CLI sessions in `files` with parent/child hierarchy data
   * read from ~/.copilot/data.db.  All other session types are left untouched.
   * Errors are suppressed — hierarchy is an optional enrichment.
   */
  private async enrichSessionHierarchy(files: SessionFileDetails[]): Promise<void> {
    // Build uuid → SessionFileDetails map for Copilot CLI sessions only.
    const uuidToDetails = new Map<string, SessionFileDetails>();
    for (const details of files) {
      const uuid = this.extractCopilotCliUuid(details.file);
      if (uuid) { uuidToDetails.set(uuid, details); }
    }
    if (uuidToDetails.size === 0) { return; }

    try {
      const hierarchy = await this.copilotAppData.getSessionHierarchy([...uuidToDetails.keys()]);
      for (const [uuid, node] of hierarchy) {
        const details = uuidToDetails.get(uuid);
        if (!details) { continue; }
        if (node.parentUuid) {
          const ref: SessionRelationRef = {
            uuid: node.parentUuid,
            name: node.parentName ?? node.parentUuid,
            sessionFile: uuidToDetails.get(node.parentUuid)?.file,
          };
          details.parentInfo = ref;
        }
        if (node.childUuids.length > 0) {
          details.childInfo = node.childUuids.map(cUuid => ({
            uuid: cUuid,
            name: node.childNames.get(cUuid) ?? cUuid,
            sessionFile: uuidToDetails.get(cUuid)?.file,
          } satisfies SessionRelationRef));
          details.totalChildCount = node.totalChildCount;
        }
      }
    } catch { /* hierarchy is optional — never surface errors */ }
  }

  /**
   * Enrich Pi sessions in `files` with parent/child hierarchy data derived from
   * the `parentSession` field in each session's JSONL header.
   * All other session types are left untouched.
   * Errors are suppressed — hierarchy is an optional enrichment.
   */
  private async enrichPiSessionHierarchy(files: SessionFileDetails[]): Promise<void> {
    const pi = new PiDataAccess();
    const piFiles = files.filter(f => pi.isPiSessionFile(f.file));
    if (piFiles.length === 0) { return; }

    // Normalise a path for platform-independent comparison.
    const norm = (p: string) => _normalizePath(p);

    // Build normalised-path → SessionFileDetails map.
    const pathToDetails = new Map<string, SessionFileDetails>();
    for (const details of piFiles) {
      pathToDetails.set(norm(details.file), details);
    }

    // Discover parent links.
    // Primary: path-based detection (pi nests child sessions under {parentId}/{hash}/run-N/session.jsonl).
    // Fallback: header-based parentSession field (future pi versions may use this).
    const parentByChild = new Map<string, string>();     // normChildPath → normParentPath
    const childrenByParent = new Map<string, string[]>(); // normParentPath → normChildPaths[]
    await Promise.all(piFiles.map(async (details) => {
      try {
        const rawParent =
          pi.getParentSessionPathFromFilePath(details.file) ??
          await pi.getParentSessionPath(details.file);
        if (!rawParent) { return; }
        const normChild = norm(details.file);
        const normParent = norm(rawParent);
        parentByChild.set(normChild, normParent);
        if (!childrenByParent.has(normParent)) { childrenByParent.set(normParent, []); }
        childrenByParent.get(normParent)!.push(normChild);
      } catch { /* skip unreadable sessions */ }
    }));

    // Apply parentInfo to child sessions.
    for (const [normChild, normParent] of parentByChild) {
      const childDetails = pathToDetails.get(normChild);
      if (!childDetails) { continue; }
      const parentDetails = pathToDetails.get(normParent);
      childDetails.parentInfo = {
        uuid: normParent,
        name: parentDetails?.title ?? path.basename(path.dirname(normParent)),
        sessionFile: parentDetails?.file,
      } satisfies SessionRelationRef;
    }

    // Apply childInfo to parent sessions.
    for (const [normParent, normChildren] of childrenByParent) {
      const parentDetails = pathToDetails.get(normParent);
      if (!parentDetails) { continue; }
      parentDetails.childInfo = normChildren.map(nc => {
        const childDetails = pathToDetails.get(nc);
        return {
          uuid: nc,
          name: childDetails?.title ?? path.basename(path.dirname(nc)),
          sessionFile: childDetails?.file,
        } satisfies SessionRelationRef;
      });
      parentDetails.totalChildCount = normChildren.length;
    }
  }

  /**
   * Groups stat'd session files by editor, sorted most-recent-first within each
   * group, filtered to those newer than `cutoffMs`. Helper for
   * selectSessionFilesRoundRobin() below.
   */
  private groupSessionFilesByEditor(
    withStats: ({ file: string; mtime: number } | null)[],
    cutoffMs: number
  ): Map<string, { file: string; mtime: number }[]> {
    const byEditor = new Map<string, { file: string; mtime: number }[]>();
    for (const entry of withStats) {
      if (!entry || entry.mtime < cutoffMs) { continue; }
      const editor = this.detectEditorSource(entry.file) || 'Unknown';
      if (!byEditor.has(editor)) { byEditor.set(editor, []); }
      byEditor.get(editor)!.push(entry);
    }
    for (const list of byEditor.values()) { list.sort((a, b) => b.mtime - a.mtime); }
    return byEditor;
  }

  /** Round-robins through each editor's (already sorted, most-recent-first) file list, up to `maxFiles` total. */
  private roundRobinSelect(byEditor: Map<string, { file: string; mtime: number }[]>, maxFiles: number): string[] {
    const editors = [...byEditor.keys()];
    const cursors = new Map<string, number>(editors.map((e) => [e, 0]));
    const selected: string[] = [];
    let anyLeft = true;
    while (selected.length < maxFiles && anyLeft) {
      anyLeft = false;
      for (const editor of editors) {
        if (selected.length >= maxFiles) { break; }
        const idx = cursors.get(editor)!;
        const list = byEditor.get(editor)!;
        if (idx < list.length) {
          selected.push(list[idx].file);
          cursors.set(editor, idx + 1);
          anyLeft = true;
        }
      }
    }
    return selected;
  }

  /**
   * Selects up to 500 session files, within the last 14 days, round-robin across
   * editors (most-recent-first within each editor) instead of a flat global
   * mtime sort.
   *
   * Why: a flat "top 500 by mtime across all editors" sort lets a single
   * high-volume editor crowd out every other editor entirely once its file
   * count exceeds 500 — this starved the Diagnostics screen's session cache
   * (Session Files list + Model Usage dropdown) of any files from lower-volume
   * editors (e.g. Claude Code) whenever a heavier editor (e.g. Copilot CLI, with
   * thousands of sessions) dominated the global sort. Round-robining by editor
   * guarantees every discovered editor gets fair representation up to the cap.
   */
  private async selectSessionFilesRoundRobin(sessionFiles: string[], cutoffMs: number): Promise<string[]> {
    const withStats = await Promise.all(
      sessionFiles.map(async (file) => {
        try { const stat = await this.statSessionFile(file); return { file, mtime: stat.mtime.getTime() }; }
        catch { return null; }
      })
    );
    const byEditor = this.groupSessionFilesByEditor(withStats, cutoffMs);
    return this.roundRobinSelect(byEditor, 500);
  }

  private async sendBgLoadResults(panel: vscode.WebviewPanel, detailedSessionFiles: SessionFileDetails[], initialCacheHits: number, initialCacheMisses: number): Promise<void> {
    try {
      if (panel === this.diagnosticsPanel) { this.diagnosticsCachedFiles = detailedSessionFiles; }
      const withRepo = detailedSessionFiles.filter((s) => s.repository).length;
      this.log(`📊 Sending ${detailedSessionFiles.length} sessions to diagnostics (${withRepo} with repository info)`);
      await panel.webview.postMessage({ command: "sessionFilesLoaded", detailedSessionFiles });
      const cacheHits = this._cacheHits - initialCacheHits;
      const cacheMisses = this._cacheMisses - initialCacheMisses;
      const totalAccesses = cacheHits + cacheMisses;
      const hitRate = totalAccesses > 0 ? ((cacheHits / totalAccesses) * 100).toFixed(1) : "0.0";
      this.log(`Loaded ${detailedSessionFiles.length} session files in background (Cache: ${cacheHits} hits, ${cacheMisses} misses, ${hitRate}% hit rate)`);
      if (panel === this.diagnosticsPanel) { this.diagnosticsHasLoadedFiles = true; }
      await this.discoverAndSendWorktreeRoots(detailedSessionFiles);
    } catch { this.log("Could not send session files to panel (may be closed)"); }
  }

  /**
   * Derive worktree scan roots from the loaded sessions' workspace paths (plus known session
   * folders), persist the union to worktrees.scanRoots (for reboot hydration), and push it to
   * the Usage Analysis webview so the Worktrees tab roots list is pre-filled. Does not start a
   * scan. Triggered by whichever panel's background session load ran (currently only the
   * Diagnostics panel loads detailed session files), but always targets the Usage Analysis panel
   * since that is where the Worktrees tab now lives.
   */
  private async discoverAndSendWorktreeRoots(detailedSessionFiles: SessionFileDetails[]): Promise<void> {
    try {
      const candidatePaths = this.sessionDiscovery.getDiagnosticCandidatePaths();
      const discovered = await this.computeDiscoveredWorktreeRoots(detailedSessionFiles, candidatePaths);
      const merged = await this.mergeAndPersistWorktreeRoots(discovered);
      if (this.analysisPanel && this.isPanelOpen(this.analysisPanel)) {
        await this.analysisPanel.webview.postMessage({ command: "worktreeRootsDiscovered", roots: merged });
      }
    } catch (err) {
      this.warn(`Could not derive worktree scan roots: ${err}`);
    }
  }

  /**
   * Analyze a custom folder for session files belonging to any of the supported AI tools.
   * Scans recursively up to depth 5, max 500 files.
   * Does NOT touch the cache — reads each file once and counts its interactions and estimates its tokens
   * from that content (off the host thread: these are arbitrary user-selected files, any of which can be large).
   */
  private async analyzeFolderPath(panel: vscode.WebviewPanel, folderPath: string, toolType: string): Promise<void> {
    const { allowJson, allowJsonl } = this.resolveFolderScanOptions(toolType);
    const ctx = { results: [] as Array<{ file: string; size: number; modified: string; interactions: number; tokens: number; actualTokens: number }>, totalScanned: 0, parseErrors: 0, truncated: false };
    await this.scanFolderRecursive(folderPath, 0, allowJson, allowJsonl, ctx);
    if (this.isPanelOpen(panel)) {
      panel.webview.postMessage({ command: "folderAnalysisResult", files: ctx.results, totalScanned: ctx.totalScanned, parseErrors: ctx.parseErrors, truncated: ctx.truncated, folderPath, toolType });
    }
  }

  private resolveFolderScanOptions(toolType: string): { allowJson: boolean; allowJsonl: boolean } {
    const jsonOnly = ["claude-code", "gemini-cli"];
    const jsonlOnly = ["continue", "opencode", "mistral-vibe", "claude-desktop"];
    if (jsonOnly.includes(toolType)) { return { allowJson: false, allowJsonl: true }; }
    if (jsonlOnly.includes(toolType)) { return { allowJson: true, allowJsonl: false }; }
    return { allowJson: true, allowJsonl: true };
  }

  private async scanFolderRecursive(dir: string, depth: number, allowJson: boolean, allowJsonl: boolean, ctx: { results: Array<{ file: string; size: number; modified: string; interactions: number; tokens: number; actualTokens: number }>; totalScanned: number; parseErrors: number; truncated: boolean }): Promise<void> {
    const MAX_FILES = 500; const MAX_DEPTH = 5;
    if (ctx.totalScanned >= MAX_FILES) { ctx.truncated = true; return; }
    if (depth > MAX_DEPTH) { return; }
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ctx.totalScanned >= MAX_FILES) { ctx.truncated = true; break; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await this.scanFolderRecursive(full, depth + 1, allowJson, allowJsonl, ctx); }
      else if (entry.isFile()) {
        const isJson = entry.name.endsWith(".json"); const isJsonl = entry.name.endsWith(".jsonl");
        if ((isJson && allowJson) || (isJsonl && allowJsonl)) { await this.scanFolderFile(full, ctx); }
      }
    }
  }

  private async scanFolderFile(full: string, ctx: { results: Array<{ file: string; size: number; modified: string; interactions: number; tokens: number; actualTokens: number }>; totalScanned: number; parseErrors: number }): Promise<void> {
    ctx.totalScanned++;
    // Open once and stat/read the same file handle (not the path) so the file
    // can't change between the size/mtime check and the read (TOCTOU race).
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(full, "r");
    } catch {
      ctx.parseErrors++;
      return;
    }
    try {
      const stat = await handle.stat();
      let content: string;
      try {
        content = await handle.readFile("utf8");
      } catch {
        ctx.parseErrors++;
        ctx.results.push({ file: full, size: stat.size, modified: stat.mtime.toISOString(), interactions: 0, tokens: 0, actualTokens: 0 });
        return;
      }
      const { interactions, tokenResult } = await this.quickAnalyzeSessionContent(full, content, stat.mtimeMs, stat.size);
      ctx.results.push({ file: full, size: stat.size, modified: stat.mtime.toISOString(), interactions, tokens: tokenResult.tokens, actualTokens: tokenResult.actualTokens });
    } finally {
      await handle.close();
      await yieldToEventLoop();
    }
  }

  /**
   * Get backend storage information for diagnostics
   */
  private async getBackendStorageInfo(): Promise<any> {
    const config = vscode.workspace.getConfiguration("aiEngineeringFluency");
    const settings = this.backend?.getSettings();
    const azureSettings = this.extractAzureStorageSettings(settings, config);
    const teamSettings = this.extractTeamServerSettings(settings, azureSettings.sharingProfile);
    // Azure Storage and the Team Server sync independently of each other, so each tracks its
    // own "last successful sync" timestamp rather than sharing a single value.
    const azureLastSyncAt = this.context.globalState.get<number>("backend.azureLastSyncAt");
    const azureLastSyncTime = azureLastSyncAt ? new Date(azureLastSyncAt).toISOString() : null;
    // Deliberately not the legacy "backend.sharingServerLastSyncAt": older versions wrote
    // that key from both the rollup and the fluency-score upload, so a value left behind
    // by a score upload would be displayed here as a confirmed usage sync and would keep
    // a failing rollup upload hidden after upgrade. The rollup marker starts fresh.
    const teamLastSyncAt = this.context.globalState.get<number>("backend.sharingServerRollupLastSyncAt");
    const teamLastSyncTime = teamLastSyncAt ? new Date(teamLastSyncAt).toISOString() : null;
    // The rollup upload and the fluency-score upload run on different schedules and
    // fail independently, so each tracks its own timestamp. Sharing one let a
    // succeeding score upload hide a failing rollup upload behind a green indicator.
    const teamFluencyLastSyncAt = this.context.globalState.get<number>("backend.sharingServerFluencyLastSyncAt");
    const teamFluencyLastSyncTime = teamFluencyLastSyncAt ? new Date(teamFluencyLastSyncAt).toISOString() : null;
    const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
    const workspaceIds = this.extractWorkspaceIdsFromFiles(sessionFiles);
    return {
      azure: { ...azureSettings, isConfigured: settings ? this.backend!.isConfigured(settings) : false, lastSyncTime: azureSettings.enabled ? azureLastSyncTime : null, deviceCount: workspaceIds.size, sessionCount: sessionFiles.length, recordCount: null },
      teamServer: { ...teamSettings, isConfigured: teamSettings.enabled && !!teamSettings.endpointUrl, lastSyncTime: teamSettings.enabled ? teamLastSyncTime : null, fluencyLastSyncTime: teamSettings.enabled ? teamFluencyLastSyncTime : null, sessionCount: sessionFiles.length },
    };
  }

  private extractAzureStorageSettings(settings: any, config: any): any {
    const s = settings ?? {};
    const subscriptionId = s.subscriptionId ?? "";
    return {
      enabled: s.enabled ?? false, storageAccount: s.storageAccount ?? "",
      subscriptionId: subscriptionId ? subscriptionId.substring(0, 8) + "..." : "",
      resourceGroup: s.resourceGroup ?? "", aggTable: s.aggTable ?? "usageAggDaily",
      eventsTable: s.eventsTable ?? "usageEvents", authMode: s.authMode ?? "entraId",
      // The effective (inferred) profile, not get()'s 'off' default for an unset value: a Team
      // Server-only user with no explicit profile uploads as teamAnonymized.
      sharingProfile: (s.sharingProfile ?? config.get("backend.sharingProfile", "off")) as string,
    };
  }

  private extractTeamServerSettings(settings: any, sharingProfile: string): any {
    return { enabled: settings?.sharingServerEnabled ?? false, endpointUrl: settings?.sharingServerEndpointUrl ?? "", sharingProfile };
  }

  private extractWorkspaceIdsFromFiles(sessionFiles: string[]): Set<string> {
    const workspaceIds = new Set<string>();
    for (const file of sessionFiles) {
      const parts = file.split(/[\\\/]/);
      const idx = parts.findIndex((p) => p.toLowerCase() === "workspacestorage");
      if (idx >= 0 && idx < parts.length - 1) {
        const workspaceId = parts[idx + 1];
        if (workspaceId && workspaceId.length > 10) { workspaceIds.add(workspaceId); }
      }
    }
    return workspaceIds;
  }


  private getDiagnosticReportHtml(
    webview: vscode.Webview,
    report: string,
    sessionFiles: { file: string; size: number; modified: string }[],
    detailedSessionFiles: SessionFileDetails[],
    sessionFolders: { dir: string; count: number }[] = [],
    backendStorageInfo: any = null,
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "diagnostics.js"),
    );
    const cacheSizeInMB = this.resolveCacheSizeInMB();
    const persistedCacheSummary = this.resolvePersistedCacheSummary();
    const storageFilePath = this.findGlobalStateStoragePath();

    const cacheInfo = {
      size: this.cacheManager.cache.size,
      sizeInMB: cacheSizeInMB,
      lastUpdated: this.cacheManager.cache.size > 0 ? new Date().toISOString() : null,
      location: persistedCacheSummary,
      storagePath: storageFilePath,
    };

    const inspector = require('inspector') as { url(): string | undefined };
    const isDebugMode = inspector.url() !== undefined;
    const globalStateCounters = {
      openCount: this.context.globalState.get<number>('extension.openCount') ?? 0,
      unknownMcpOpenCount: this.context.globalState.get<number>('extension.unknownMcpOpenCount') ?? 0,
      fluencyBannerDismissed: this.context.globalState.get<boolean>('news.fluencyScoreBanner.v1.dismissed') ?? false,
      unknownMcpDismissedVersion: this.context.globalState.get<string>('news.unknownMcpTools.dismissedVersion') ?? '',
      efficiencyTabBannerDismissed: this.context.globalState.get<boolean>('news.efficiencyTab.v1.dismissed') ?? false,
    };

    const initialData = JSON.stringify({
      report, sessionFiles, detailedSessionFiles, sessionFolders,
      cacheInfo, backendStorageInfo,
      backendConfigured: this.isBackendConfigured(), isDebugMode, globalStateCounters,
      displaySettings: { showTokens: this.getStatusBarShowTokensSetting(), showCost: this.getStatusBarShowCostSetting(), monthlyBudget: this.getMonthlyBudgetSetting() },
      quotaEntitlements: this._copilotQuotaEntitlements,
      accountBudgets: this._accountBudgets,
      toolCallStats: this.currentUsageAnalysisStats?.last30Days?.toolCalls ?? null,
      skillCallStats: this.currentUsageAnalysisStats?.last30Days?.skillCalls ?? null,
      skillCallsByEditor: this._lastSkillCallsByEditor ?? null,
      skillDescriptions: this._buildSkillDescriptions(),
      toolFamilies: getToolFamilies(),
      ...this.getWebviewLocaleFields(),
    }).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>Diagnostic Report</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DIAGNOSTICS__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			${this.getLocalViewRegressionProbeScript('diagnostics', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  private resolveCacheSizeInMB(): number {
    try {
      const cacheData = Object.fromEntries(this.cacheManager.cache);
      const jsonString = JSON.stringify(cacheData);
      return (jsonString.length * 2) / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  private resolvePersistedCacheSummary(): string {
    try {
      const snapshotPath = this.cacheManager.getSharedSnapshotPath();
      const entries = this.cacheManager.cache.size;
      return `Disk snapshot: ${snapshotPath} (${entries} entr${entries === 1 ? 'y' : 'ies'} in-memory)`;
    } catch {
      return "Error reading cache snapshot path";
    }
  }

  private findGlobalStateStoragePath(): string | null {
    try {
      const extensionIds = ["RobBos.ai-engineering-fluency", "RobBos.copilot-token-tracker"];
      const userPaths = getVSCodeUserPaths();
      for (const userPath of userPaths) {
        for (const extId of extensionIds) {
          const result = this.tryFindGlobalStateFile(userPath, extId);
          if (result) { return result; }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private tryFindGlobalStateFile(userPath: string, extId: string): string | null {
    try {
      const candidate = path.join(userPath, "globalStorage", extId);
      if (fs.existsSync(candidate)) {
        const match = fs.readdirSync(candidate).find((f) => f.includes("state") || f.endsWith(".vscdb") || f.endsWith(".json"));
        if (match) { return path.join(candidate, match); }
      }
    } catch { /* ignore path access errors */ }
    return null;
  }

  private buildChartData(fullDailyStats: DailyTokenStats[]): ChartDataPayload {
    return _buildChartData(fullDailyStats, {
      getRepoDisplayName: _getRepoDisplayName,
      calculateEstimatedCost: (modelUsage, pricingSource) => _calculateEstimatedCost(modelUsage, this.modelPricing, pricingSource),
      backendConfigured: this.isBackendConfigured(),
      compactNumbers: this.getCompactNumbersSetting(),
    });
  }

  private getChartHtml(
    webview: vscode.Webview,
    dailyStats: DailyTokenStats[],
    periodsReady = true,
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "chart.js"),
    );

    const chartData = { 
      ...this.buildChartData(dailyStats), 
      periodsReady, 
      initialPeriod: this.lastChartPeriod, 
      initialTimeWindow: this.lastChartTimeWindow, 
      initialView: this.normalizeLegacyChartPreference(this.lastChartView, ['total', 'model', 'editor', 'repository', 'cost', 'task']) ?? 'total', 
      initialMetric: this.lastChartMetric, 
      initialSplit: this.normalizeLegacyChartPreference(this.lastChartSplit, ['total', 'model', 'editor', 'repository', 'language', 'provider', 'task']) ?? 'total', 
      initialEditorListCollapsed: this.context.globalState.get<boolean>(CopilotTokenTracker.CHART_EDITOR_LIST_COLLAPSED_KEY, false),
      monthlyBudget: this.getEffectiveMonthlyBudget(),
      ...this.getWebviewLocaleFields()
    };

    const initialData = JSON.stringify(chartData).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>${l10n.t('htmlTitleChart')}</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_CHART__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			${this.getLocalViewRegressionProbeScript('chart', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  /** Detect the user's locale for number formatting, logging each candidate source. */
  private _detectUsageAnalysisLocale(stats: UsageAnalysisStats | null): string {
    const localeFromEnv =
      process.env.LC_ALL || process.env.LC_NUMERIC || process.env.LANG;
    const vscodeLanguage = vscode.env.language; // e.g., 'en', 'nl', 'de'
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;

    this.log(`[Locale Detection] VS Code language: ${vscodeLanguage}`);
    this.log(
      `[Locale Detection] Environment locale: ${localeFromEnv || "not set"}`,
    );
    this.log(`[Locale Detection] Intl default: ${intlLocale}`);

    const detectedLocale = stats?.locale || localeFromEnv || intlLocale;
    this.log(`[Usage Analysis] Extension detected locale: ${detectedLocale}`);
    this.log(
      `[Usage Analysis] Test format 1234567.89: ${new Intl.NumberFormat(detectedLocale).format(1234567.89)}`,
    );
    return detectedLocale;
  }

  /** Build the JSON-serialized initial payload injected into the usage analysis webview. */
  private _buildUsageAnalysisInitialData(stats: UsageAnalysisStats | null, detectedLocale: string): string {
    if (!stats) { return 'null'; }
    const suppressedUnknownTools = vscode.workspace
      .getConfiguration('aiEngineeringFluency')
      .get<string[]>('suppressedUnknownTools', []);
    const sessionColumnSettings = this.context.globalState.get('usage.sessionColumnSettings', {});

    return JSON.stringify({
      today: stats.today,
      last30Days: stats.last30Days,
      month: stats.month,
      lastMonth: stats.lastMonth,
      autoCompactionsLast7Days: stats.autoCompactionsLast7Days,
      locale: detectedLocale,
      customizationMatrix: stats.customizationMatrix || null,
      missedPotential: stats.missedPotential || [],
      lastUpdated: stats.lastUpdated.toISOString(),
      backendConfigured: this.isBackendConfigured(),
      readinessAvailable: true,
      currentWorkspacePaths: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      suppressedUnknownTools,
      toolCallsByEditor: stats.toolCallsByEditor ?? {},
      todaySessions: stats.todaySessions || [],
      claudeDesktopCoverage: stats.claudeDesktopCoverage ?? null,
      use24HourTime: this.getUse24HourTimeSetting(),
      hideAutomaticToolCalls: this.getHideAutomaticToolCallsSetting(),
      insights: this.buildCurrentInsights(stats),
      correctionReport: stats.correctionReport ?? null,
      curationAnalysis: stats.curationAnalysis ?? null,
      memoryFilesAnalysis: _toMemoryFilesAnalysisView(stats.memoryFilesAnalysis ?? null),
      serverMemoriesAnalysis: this.buildServerMemoriesView(),
      sessionColumnSettings,
      copilotApiBalance: this._buildCopilotApiBalance(),
      accountBudgets: this._accountBudgets,
      monthBillingGroupCosts: this.currentDetailedStats?.month.billingGroupCosts ?? null,
      worktreeScanRoots: this.buildInitialWorktreeRoots(),
      ...this.getWebviewLocaleFields(),
      worktreeBackgroundScan: this.context.globalState.get<WorktreeBackgroundScanResult>(CopilotTokenTracker.WORKTREE_BG_SCAN_RESULT_KEY) ?? null,
    }).replace(/</g, "\\u003c");
  }

  private getUsageAnalysisHtml(
    webview: vscode.Webview,
    stats: UsageAnalysisStats | null,
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "usage.js"),
    );

    const detectedLocale = this._detectUsageAnalysisLocale(stats);
    const initialData = this._buildUsageAnalysisInitialData(stats, detectedLocale);

    return `<!DOCTYPE html>
		<html lang="${webviewDocumentLanguage(vscode.env.language)}">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.extensionUri)}
			<title>Usage Analysis</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_USAGE__ = ${initialData};</script>
			${this.getJsonConfigScript(nonce)}
			${this.extensionPointButtonsScript(nonce)}
			${this.getLocalViewRegressionProbeScript('usage', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this._eventLoopMonitor?.dispose();
    this._eventLoopMonitor = undefined;
    void this.analysisPool?.dispose();
    this.analysisPool = undefined;
    this.otelLookup?.dispose();
    this.otelLookup = undefined;
    // Stop any in-flight background worktree scan from doing further disk I/O once disposed.
    this.backgroundWorktreeScanId++;
    this.stopRefreshHeartbeat();
    if (this._followerResyncTimer) {
      clearTimeout(this._followerResyncTimer);
      this._followerResyncTimer = undefined;
    }
    if (this._deferredSessionRefreshTimer) {
      clearTimeout(this._deferredSessionRefreshTimer);
      this._deferredSessionRefreshTimer = undefined;
    }
    // Release the refresh leader lock if this window held it, so another window can
    // take over promptly instead of waiting for the stale-lock timeout.
    void this.cacheManager.releaseRefreshLock().catch(() => { /* best-effort */ });
    if (this.detailsPanel) {
      this.detailsPanel.dispose();
    }
    if (this.chartPanel) {
      this.chartPanel.dispose();
    }
    if (this.analysisPanel) {
      this.analysisPanel.dispose();
    }
    if (this.maturityPanel) {
      this.maturityPanel.dispose();
    }
    // Save cache to storage before disposing (fire-and-forget async operation)
    // Note: Cache loss during abnormal shutdown is acceptable as it will rebuild on next startup
    // We can't await here since dispose() is synchronous
    //
    // Must skip this save in sample-data mode, same as persistRefreshResult() does before its own
    // trySaveCacheToStorage() call: if the Extension Development Host closes while
    // runLocalViewRegression() is still mid-flight (fixture entries already in cacheManager.cache,
    // but its own finally block hasn't evicted them yet), this unconditional save would otherwise
    // persist fixture data into the developer's real, shared production snapshot.
    if (!this.isSampleDataModeActive()) {
      void (async () => {
        try {
          await this.trySaveCacheToStorage();
        } catch (err) {
          // Output channel will be disposed, so log to console as fallback
          console.error("Error saving cache during disposal:", err);
        }
      })();
    }
    if (this.logViewerPanel) {
      this.logViewerPanel.dispose();
    }
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.dispose();
    }
    this.openCode.dispose();
    this.statusBarItem.dispose();
    this.insightsStatusBarItem.dispose();
    this._disposed = true;
    this.outputChannel.dispose();
  }
}

const SETTINGS_MIGRATION_DONE_KEY = 'settingsMigrationFromCopilotTokenTrackerDone';

/**
 * One-time migration: copies any user-set values from the old `copilotTokenTracker.*` namespace
 * to the new `aiEngineeringFluency.*` namespace.  The old settings remain in package.json
 * with `deprecationMessage` so VS Code continues to show them as deprecated; this function
 * handles users who already had values configured before the rename.
 *
 * Uses globalState to record completion so the migration only runs once.
 */
async function migrateSettingsIfNeeded(context: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
  if (context.globalState.get<boolean>(SETTINGS_MIGRATION_DONE_KEY)) {
    return;
  }
  const keys = [
    'display.compactNumbers',
    'backend.enabled',
    'backend.backend',
    'backend.authMode',
    'backend.datasetId',
    'backend.sharingProfile',
    'backend.userId',
    'backend.shareWithTeam',
    'backend.shareWorkspaceMachineNames',
    'backend.shareConsentAt',
    'backend.userIdentityMode',
    'backend.userIdMode',
    'backend.subscriptionId',
    'backend.resourceGroup',
    'backend.storageAccount',
    'backend.aggTable',
    'backend.eventsTable',
    'backend.lookbackDays',
    'backend.includeMachineBreakdown',
    'backend.blobUploadEnabled',
    'backend.blobContainerName',
    'backend.blobUploadFrequencyHours',
    'backend.blobCompressFiles',
    'sampleDataDirectory',
    'suppressedUnknownTools',
  ];

  const oldCfg = vscode.workspace.getConfiguration('copilotTokenTracker');
  const newCfg = vscode.workspace.getConfiguration('aiEngineeringFluency');

  let migrated = 0;
  for (const key of keys) {
    const insp = oldCfg.inspect(key);
    if (insp?.globalValue !== undefined) {
      await newCfg.update(key, insp.globalValue, vscode.ConfigurationTarget.Global);
      migrated++;
    }
    if (insp?.workspaceValue !== undefined) {
      await newCfg.update(key, insp.workspaceValue, vscode.ConfigurationTarget.Workspace);
      migrated++;
    }
  }

  if (migrated > 0) {
    log(`Migrated ${migrated} setting(s) from 'copilotTokenTracker' to 'aiEngineeringFluency' namespace.`);
  }

  await context.globalState.update(SETTINGS_MIGRATION_DONE_KEY, true);
}

const SECRETS_MIGRATION_DONE_KEY = 'secretsMigrationFromCopilotTokenTrackerDone';

/**
 * One-time migration: copies any stored shared key secret from the old
 * `copilotTokenTracker.backend.storageSharedKey:*` SecretStorage key to the new
 * `aiEngineeringFluency.backend.storageSharedKey:*` key.
 *
 * Uses globalState to record completion so the migration only runs once.
 */
async function migrateSecretsIfNeeded(context: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
  if (context.globalState.get<boolean>(SECRETS_MIGRATION_DONE_KEY)) {
    return;
  }

  try {
    const storageAccount = vscode.workspace.getConfiguration('aiEngineeringFluency').get<string>('backend.storageAccount', '');
    if (storageAccount) {
      const oldKey = `copilotTokenTracker.backend.storageSharedKey:${storageAccount}`;
      const newKey = `aiEngineeringFluency.backend.storageSharedKey:${storageAccount}`;
      const existingSecret = await context.secrets.get(oldKey);
      if (existingSecret) {
        await context.secrets.store(newKey, existingSecret);
        await context.secrets.delete(oldKey);
        log(`Migrated shared key secret for storage account '${storageAccount}' to new key name.`);
      }
    }
  } catch (error) {
    log(`Error migrating secrets: ${error}`);
  }

  await context.globalState.update(SECRETS_MIGRATION_DONE_KEY, true);
}

const NEW_EXTENSION_ID = 'RobBos.ai-engineering-fluency';
const LEGACY_EXTENSION_ID = 'RobBos.copilot-token-tracker';

/**
 * When running as the new ai-engineering-fluency extension, checks whether the legacy
 * copilot-token-tracker extension is also installed and shows a one-time prompt to
 * uninstall it. The old extension already skips its own activation when the new one
 * is present, but this gives users a clear nudge to clean up.
 */
async function checkForLegacyExtensionConflict(context: vscode.ExtensionContext): Promise<void> {
  if (context.extension.id !== NEW_EXTENSION_ID) {
    return;
  }
  const legacyExt = vscode.extensions.getExtension(LEGACY_EXTENSION_ID);
  if (!legacyExt) {
    return;
  }
  // v2: reworded to clarify which extension to keep vs. remove (v1 was ambiguous due to similar names)
  const key = 'conflict.legacyExtensionPresent.v2.dismissed';
  if (context.globalState.get<boolean>(key, false)) {
    return;
  }
  const removeOldExtension = l10n.t('button.removeOldExtension');
  const dismiss = l10n.t('button.dismiss');
  const choice = await vscode.window.showWarningMessage(
    l10n.t('cleanupWarning') + l10n.t('cleanupMessage'),
    removeOldExtension,
    dismiss
  );
  if (choice === removeOldExtension) {
    try {
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', LEGACY_EXTENSION_ID);
    } catch {
      vscode.window.showInformationMessage(
        l10n.t('cleanupMessage2')
      );
    }
  } else if (choice === dismiss) {
    // Only suppress on explicit Dismiss — closing with ✕ shows again next startup.
    await context.globalState.update(key, true);
  }
}

function createBackendFacade(context: vscode.ExtensionContext, tokenTracker: CopilotTokenTracker): BackendFacade {
  return new BackendFacade({
    context,
    log: (m: string) => tokenTracker.log(m),
    warn: (m: string) => tokenTracker.warn(m),
    updateTokenStats: async () => { await tokenTracker.updateTokenStats(); },
    calculateEstimatedCost: (modelUsage: ModelUsage) => tokenTracker.calculateEstimatedCost(modelUsage),
    getCopilotSessionFiles: () =>
      tokenTracker.sessionDiscovery.getCopilotSessionFiles(),
    estimateTokensFromText: (text: string, model?: string) =>
      tokenTracker.estimateTokensFromText(text, model),
    getModelFromRequest: (req: any) =>
      tokenTracker.getModelFromRequest(req),
    getSessionFileDataCached: (p: string, m: number, s: number) =>
      tokenTracker.getSessionFileDataCached(p, m, s),
    statSessionFile: (sessionFile: string) =>
      tokenTracker.statSessionFile(sessionFile),
    isOpenCodeSession: (sessionFile: string) =>
      tokenTracker.openCode.isOpenCodeSessionFile(sessionFile),
    getOpenCodeSessionData: (sessionFile: string) =>
      tokenTracker.openCode.getOpenCodeSessionData(sessionFile),
    isCrushSession: (sessionFile: string) =>
      tokenTracker.crush.isCrushSessionFile(sessionFile),
    getCrushSessionData: (sessionFile: string) =>
      tokenTracker.crush.getCrushSessionData(sessionFile),
    isVSSessionFile: (sessionFile: string) =>
      tokenTracker.visualStudio.isVSSessionFile(sessionFile),
    getGithubToken: () => tokenTracker.githubSession?.accessToken,
    getEditorLabel: (sessionFile: string) =>
      tokenTracker.getEditorTypeFromPath(sessionFile),
  });
}

function setupBackend(context: vscode.ExtensionContext, tokenTracker: CopilotTokenTracker): void {
  try {
    const backendFacade = createBackendFacade(context, tokenTracker);

    const backendHandler = new BackendCommandHandler({
      facade: backendFacade as any,
      integration: undefined,
      calculateEstimatedCost: (mu: any) => 0,
      warn: (m: string) => tokenTracker.warn(m),
      log: (m: string) => tokenTracker.log(m),
    });

    // Store backend facade in the tracker instance for dashboard access
    tokenTracker.backend = backendFacade;

    const configureBackendCommand = vscode.commands.registerCommand(
      "aiEngineeringFluency.configureBackend",
      async () => {
        await backendHandler.handleConfigureBackend();
      },
    );

    context.subscriptions.push(configureBackendCommand);

    const configureTeamServerCommand = vscode.commands.registerCommand(
      "aiEngineeringFluency.configureTeamServer",
      async () => {
        TeamServerConfigPanel.show(context);
      },
    );

    context.subscriptions.push(configureTeamServerCommand);
  } catch (err) {
    // If backend wiring fails for any reason, don't block activation - fall back to settings behavior.
    tokenTracker.warn(
      "Failed to wire backend commands: " + String(err),
    );
  }
}

function registerSecondaryViewCommands(context: vscode.ExtensionContext, tokenTracker: CopilotTokenTracker): void {
  const showMaturityCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showMaturity",
    async () => {
      tokenTracker.log("Show maturity command called");
      await tokenTracker.openView('maturity');
    },
  );
  const showReadinessCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showReadiness",
    async () => {
      await tokenTracker.showReadiness();
    },
  );
  const showDashboardCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showDashboard",
    async () => {
      tokenTracker.log("Show dashboard command called");
      await tokenTracker.openView('dashboard');
    },
  );
  const showEnvironmentalCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showEnvironmental",
    async () => {
      tokenTracker.log("Show environmental impact command called");
      await tokenTracker.openView('environmental');
    },
  );
  const showEfficiencyCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showEfficiency",
    async () => {
      tokenTracker.log("Show efficiency trends command called");
      await tokenTracker.openView('efficiency');
    },
  );
  const showWhatsNewCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showWhatsNew",
    async () => {
      tokenTracker.log("Show what's new command called");
      await tokenTracker.openView('whatsnew');
    },
  );
  const openMcpJsonCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.openMcpJson",
    async () => {
      tokenTracker.log("Open mcp.json command called");
      await tokenTracker.openMcpJson();
    },
  );
  context.subscriptions.push(showMaturityCommand, showReadinessCommand, showDashboardCommand, showEnvironmentalCommand, showEfficiencyCommand, showWhatsNewCommand, openMcpJsonCommand);
}

function registerUsageNavigationCommands(context: vscode.ExtensionContext, tokenTracker: CopilotTokenTracker): void {
  const commands: Array<[string, string, (...args: unknown[]) => Promise<void>]> = [
    // The status-bar insights badge passes the id of the insight its tooltip names, so the panel
    // can scroll straight to that card. It is the only caller that passes one — the command is
    // registered but not contributed, so there is no palette or keybinding path — and the guard
    // keeps any other invocation (or a non-string argument) on the plain open-the-tab behaviour.
    ["aiEngineeringFluency.openInsightsTab", "Open Insights tab command called", (insightId) => tokenTracker.showUsageAnalysisOnInsightsTab(typeof insightId === 'string' ? insightId : undefined)],
    ["aiEngineeringFluency.openToolsTab", "Open Tools tab command called", () => tokenTracker.showUsageAnalysisOnToolsTab()],
    ["aiEngineeringFluency.openActivityTab", "Open Activity tab command called", () => tokenTracker.showUsageAnalysisOnActivityTab()],
    ["aiEngineeringFluency.openHealthTab", "Open Workspace Health tab command called", () => tokenTracker.showUsageAnalysisOnHealthTab()],
    ["aiEngineeringFluency.openCorrectionsTab", "Open Corrections tab command called", () => tokenTracker.showUsageAnalysisOnCorrectionsTab()],
    ["aiEngineeringFluency.askCopilotAboutCorrections", "Ask Copilot about corrections command called", () => tokenTracker.askCopilotAboutCorrections()],
    ["aiEngineeringFluency.openModelEfficiency", "Open Model Efficiency section command called", () => tokenTracker.showUsageAnalysisOnModelEfficiency()],
    ["aiEngineeringFluency.showContextPressureSessions", "Show near-context-limit sessions command called", () => tokenTracker.showContextPressureSessions()],
  ];
  context.subscriptions.push(...commands.map(([id, logMessage, handler]) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      tokenTracker.log(logMessage);
      await handler(...args);
    })
  ));
}

function registerViewCommands(context: vscode.ExtensionContext, tokenTracker: CopilotTokenTracker): void {
  const refreshCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.refresh",
    async () => {
      tokenTracker.log("Refresh command called");
      await tokenTracker.updateTokenStats();
      vscode.window.showInformationMessage(l10n.t('dataRefreshed'));
    },
  );

  const showDetailsCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showDetails",
    async () => {
      tokenTracker.log("Show details command called");
      await tokenTracker.openView('details');
    },
  );

  const showChartCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showChart",
    async () => {
      tokenTracker.log("Show chart command called");
      await tokenTracker.openView('chart');
    },
  );

  const showUsageAnalysisCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showUsageAnalysis",
    async () => {
      tokenTracker.log("Show usage analysis command called");
      await tokenTracker.openView('usage');
    },
  );

  context.subscriptions.push(refreshCommand, showDetailsCommand, showChartCommand, showUsageAnalysisCommand);
  registerUsageNavigationCommands(context, tokenTracker);
  registerSecondaryViewCommands(context, tokenTracker);
}

function formatWindsurfDiagnosticsContent(diagnostics: any): string {
  return `# Windsurf Diagnostics Report

Generated: ${new Date().toISOString()}

## Environment
- Running in Windsurf: ${diagnostics.environment.isRunningInWindsurf}
- Running in Devin: ${diagnostics.environment.isRunningInDevin}
- App Name: ${diagnostics.environment.appName}

## Extension Status
- Extension Found: ${diagnostics.extension.found}
- Extension Active: ${diagnostics.extension.active}
- Extension Version: ${diagnostics.extension.packageJSON}

## Credentials
- Available: ${diagnostics.credentials.available}
- Port: ${diagnostics.credentials.port}
- CSRF Token Length: ${diagnostics.credentials.csrfLength}

## API Connectivity Test
- Success: ${diagnostics.apiTest.success}
- Status Code: ${diagnostics.apiTest.statusCode}
- Error: ${diagnostics.apiTest.error || 'None'}

## Configuration
- Windsurf Integration Enabled: ${diagnostics.configuration.enabled}

## Sessions
- Available: ${diagnostics.sessions.available}
- Count: ${diagnostics.sessions.count}
- Error: ${diagnostics.sessions.error || 'None'}

## Recommendations

${!diagnostics.extension.found ? '- Install the Windsurf extension\n' : ''}${!diagnostics.extension.active ? '- Activate the Windsurf extension or restart Windsurf\n' : ''}${!diagnostics.credentials.available ? '- Check if Windsurf language server is running\n' : ''}${!diagnostics.apiTest.success ? `- API connectivity issue: ${diagnostics.apiTest.error}\n` : ''}${diagnostics.sessions.count === 0 && diagnostics.apiTest.success ? '- Windsurf is working correctly, but no chat sessions have been created yet. Try starting a chat session in Windsurf and then refresh the token tracker.\n' : ''}
`;
}

async function handleWindsurfDiagnosticsCommand(tokenTracker: CopilotTokenTracker): Promise<void> {
  try {
    const diagnostics = await tokenTracker.windsurf.runDiagnostics();
    const doc = await vscode.workspace.openTextDocument({
      content: formatWindsurfDiagnosticsContent(diagnostics),
      language: 'markdown'
    });
    await vscode.window.showTextDocument(doc);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to run Windsurf diagnostics: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function registerDiagnosticAndAuthCommands(context: vscode.ExtensionContext, tokenTracker: CopilotTokenTracker): void {
  const showFluencyLevelViewerCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showFluencyLevelViewer",
    async () => {
      tokenTracker.log("Show fluency level viewer command called");
      await tokenTracker.openView('fluency-level-viewer');
    },
  );

  const runLocalViewRegressionCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.runLocalViewRegression",
    async () => {
      tokenTracker.log("Run local view regression command called");
      await tokenTracker.runLocalViewRegression();
    },
  );

  // Register the generate diagnostic report command
  const generateDiagnosticReportCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.generateDiagnosticReport",
    async () => {
      tokenTracker.log("Generate diagnostic report command called");
      await tokenTracker.openView('diagnostics');
    },
  );

  // Register the clear cache command
  const clearCacheCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.clearCache",
    async () => {
      tokenTracker.log("Clear cache command called");
      await tokenTracker.clearCache();
    },
  );

	const resetInsightsStateCommand = vscode.commands.registerCommand(
		"aiEngineeringFluency.resetInsightsState",
		async () => {
			tokenTracker.log("Reset insights state command called");
			await tokenTracker.resetInsightsState();
		},
	);

  // Register the GitHub authentication command
  const authenticateGitHubCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.authenticateGitHub",
    async () => {
      tokenTracker.log("GitHub authentication command called");
      await tokenTracker.authenticateWithGitHub();
    },
  );

  const signOutGitHubCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.signOutGitHub",
    async () => {
      tokenTracker.log("GitHub sign out command called");
      await tokenTracker.signOutFromGitHub();
    },
  );

  const windsurfDiagnosticsCommand = vscode.commands.registerCommand(
    "copilot-token-tracker.checkWindsurfStatus",
    async () => {
      tokenTracker.log("Windsurf diagnostics command called");
      await handleWindsurfDiagnosticsCommand(tokenTracker);
    },
  );

  context.subscriptions.push(
    showFluencyLevelViewerCommand,
    runLocalViewRegressionCommand,
    generateDiagnosticReportCommand,
    clearCacheCommand,
		resetInsightsStateCommand,
    authenticateGitHubCommand,
    signOutGitHubCommand,
    windsurfDiagnosticsCommand,
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<AiFluencyExtensionApi> {
  // Kick off the Copilot CLI OTel export load immediately, on a worker thread, so the heavy
  // streaming read+parse of the (100+ MB, ever-growing) export file overlaps the rest of
  // activation instead of blocking the first usage analysis. Fire-and-forget: the result is
  // cached inside the module, and every consumer already awaits loadCopilotCliOtelIndex() lazily.
  // The built index is saved next to the other caches, so the next start restores it and reads only what was appended.
  setCopilotCliOtelSnapshotPath(path.join(context.globalStorageUri.fsPath, 'copilot-cli-otel-index.json'));
  // The index starts before the tracker (and its output channel) exists, so early messages wait for it.
  const earlyOtelMessages: string[] = [];
  let otelLogTarget: CopilotTokenTracker | undefined;
  setCopilotCliOtelLogger((message) => { if (otelLogTarget) { otelLogTarget.log(message); } else { earlyOtelMessages.push(message); } });
  void loadCopilotCliOtelIndex().catch(() => { /* off-by-default export; degrades to no data */ });

  // Create the token tracker
  const tokenTracker = new CopilotTokenTracker(context.extensionUri, context);
  otelLogTarget = tokenTracker;
  for (const message of earlyOtelMessages.splice(0)) { tokenTracker.log(message); }

  // Migrate settings from the old copilotTokenTracker namespace to aiEngineeringFluency.
  // Run before any other settings are read so the new keys are populated first.
  await migrateSettingsIfNeeded(context, (m) => tokenTracker.log(m));

  // Pre-fill toolFamilies setting with defaults so users have a starting point for customisation.
  const cfg = vscode.workspace.getConfiguration('aiEngineeringFluency');
  const existingFamilies = cfg.get<unknown[]>('toolFamilies');
  if (!existingFamilies || existingFamilies.length === 0) {
    await cfg.update('toolFamilies', DEFAULT_TOOL_FAMILIES, vscode.ConfigurationTarget.Global);
  }

  // Migrate any stored shared key secrets from the old key name to the new key name.
  await migrateSecretsIfNeeded(context, (m) => tokenTracker.log(m));

  // If the legacy extension is also installed, nudge the user to uninstall it.
  // Fire-and-forget: don't block activation on the user's response.
  void (async () => {
    try {
      await checkForLegacyExtensionConflict(context);
    } catch {
      /* ignore */
    }
  })();

  setupBackend(context, tokenTracker);
  registerViewCommands(context, tokenTracker);
  registerDiagnosticAndAuthCommands(context, tokenTracker);

  context.subscriptions.push(tokenTracker);

  tokenTracker.log("Extension activation complete");

  return {
    registerButton: (button: ExtensionPointButton, handler: () => void | Promise<void>) =>
      tokenTracker.registerExtensionPointButton(button, handler),
  };
}

export function deactivate() {
  // Extension cleanup is handled in the CopilotTokenTracker class
}
