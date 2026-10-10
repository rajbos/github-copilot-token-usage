// Usage Analysis webview
import { el, setHtml } from '../shared/domUtils';
import { createPeriodSelector, PERIOD_LABELS, type Period } from '../shared/periodSelector';
import { navButtonsHtml } from '../shared/buttonConfig';
import { ContextReferenceUsage, getTotalContextRefs } from '../shared/contextRefUtils';
import { buildFilterPillGroupHtml, type SessionFilterOption } from './sessionFilterBar';
import { escapeHtml, formatCompact, formatCost, formatDurationShort, formatFileSize, formatFixed, formatNumber, formatPercent, getTimeSince, safeSectionHtml, setFormatLocale } from '../shared/formatUtils';
import { wireExtensionPointButtons } from '../shared/extensionPoints';
import { localize, localizeFormat } from '../shared/localization';
import { applyWebviewLocale } from '../shared/webviewLocale';
import { RECENT_SESSION_PERIODS, sanitizeRecentSessionBuckets } from './recentSessionsSanitizer';
import { renderCcrCheckButtonHtml, wireCcrActivityButtons, renderCcrActivityResult, replayCcrActivityResults } from './ccrActivity';
import {
	hasContextWindowData,
	sanitizeAutomaticCompactions,
	sanitizeContextPressure,
	sanitizeContextWindow,
} from './contextWindowSanitizer';
// Imported from the shared contract rather than re-declared locally, so a shape
// change in src/types.ts surfaces here as a type error instead of silently
// drifting out of sync with what the extension host actually sends.
import type { AutomaticCompactionStats, AvailableToolEntry, ContextPressureStats, ContextWindowStats, MemoryFilesAnalysisView, ServerMemoriesAnalysisView, ToolCurationAnalysis } from '../../../../src/types';
import { CONTEXT_NEAR_LIMIT_RATIO } from '../../../../src/types';
import { getSessionContextFillPercent, isSessionNearContextLimit } from '../../../../src/utils/contextFill';

/** The near-limit threshold as a whole percentage, for display in copy. */
const NEAR_LIMIT_PERCENT = Math.round(CONTEXT_NEAR_LIMIT_RATIO * 100);
import type { McpToolUsage, ModeUsage, ModelSwitchingAnalysis as BaseModelSwitchingAnalysis, ToolCallUsage } from '../shared/types';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import dataTableStyles from '../shared/dataTable.css';
import { renderDataTable, rerenderDataTable, setDataTableState, type DataTableColumn, type DataTableSortValue } from '../shared/dataTable';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import { registerMessageHandler } from '../shared/messageHandler';
import { getModelDisplayName, getModelLookupCandidates } from '../../../../src/webview/shared/modelUtils';
import { getModelBillingProvider } from '../../../../src/chartDataBuilder';
import { getLongContextInfo } from '../../../../src/tokenEstimation';
import { deriveModelEfficiencyRates, computeEfficiencyLowUsageThreshold, computeLongTailModels } from '../../../../src/modelEfficiency';
import { buildCorrectionImprovementPrompt } from '../../../../src/correctionDetection';
import type { ModelPricing, ModelEfficiencyUsage, ModelEfficiencyCounters } from '../../../../src/types';
import { sanitizeCustomizationMatrix } from './customizationSanitizer';
import { statusBadgeHtml, type CustomizationTypeStatus } from './statusBadge';
import { buildCustomizationSectionHtml } from './customizationMatrixSection';
import { buildTabStripHtml, type UsageTabStripInput } from './tabStripHtml';
import { formatToolEditors, sanitizeToolCallsByEditor } from './toolEditors';
import { buildToolExecutionSectionsHtml } from './toolExecutionHtml';
import { sanitizeToolOutcomeMaps, sanitizeMcpOutcomeMaps } from './toolOutcomeSanitizer';
import { renderContextRefTable } from './contextRefTableHtml';
import { shouldListAccountBudgets } from '../../githubAccountBudgets';
import { applyBillingFields, sanitizeAccountBudgets, sanitizeCopilotApiBalance, type AccountBudgetView, type CopilotApiBalance } from './billingStatsSanitizer';
import { billingExtGroupCostsHtml } from './billingCoverage';
import { type ContextRefRow } from './contextRefRows';
import { sanitizeAgentSessionsData, toSafeNumber, toSafeHttpUrl, type AgentRepoSummary, type AgentSessionsResult } from './agentSessionsSanitizer';
import { isSwitchableTab } from './switchableTabs';
import { USAGE_TAB_GROUPS, groupOfUsageTab } from './tabGroups';
import { DarkFactoryTab } from './darkFactoryTab';
import { insightCardElementId, isInsightCardAnchor } from '../../insightAnchors';
import { placeBubbleLabels, scaleBubbleRadius, type BubbleLabelPlacement } from './modelLeaderboard';
import { createUsageWebviewReadyNotifier, restoreGitHubActivityPanels } from './readiness';
import { sanitizeServerMemoriesAnalysis as _sanitizeServerMemoriesAnalysis, buildServerMemoriesSectionHtml } from './serverMemories';
import { buildBuiltinToolsHtml, buildUnusedMcpHtml, buildUnusedSkillsHtml } from './toolCurationTables';
import { renderAgentPluginsFilter, renderAgentPluginsTable, renderMemoryFilesTable, renderMissedPotentialTable, renderRepoHygieneListTable, renderToolCountTable, type RepoHygieneListRow } from './usageListTables';

type ModelSwitchingAnalysis = BaseModelSwitchingAnalysis & {
	minModelsPerSession: number;
	standardRequests: number;
	premiumRequests: number;
	highCostRequests: number;
	lowCostRequests: number;
	mediumCostRequests: number;
	unknownRequests: number;
	totalRequests: number;
};

type UsageAnalysisPeriod = {
	sessions: number;
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
	modelSwitching: ModelSwitchingAnalysis;
	thinkingEffortUsage?: {
		byEffort: { [effort: string]: number };
		sessionCount: number;
		switchCount: number;
	};
	contextWindow?: ContextWindowStats;
	contextPressure?: ContextPressureStats;
	modelEfficiency?: ModelEfficiencyUsage;
};

type TodaySessionSummary = {
	title: string | null;
	filePath: string;
	interactions: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cachedTokens: number;
	totalTokens: number;
	estimatedCost: number;
	editor: string;
	models: string[];
	lastActivity: string;
	truncationCount?: number;
	maxRequestInputTokens?: number;
	contextTier?: string;
	contextWindowLimit?: number;
	contextReachedTokens?: number;
	durationMs?: number;
	activeDurationMs?: number;
	workspace?: string;
	subAgentCalls?: number;
};

type InsightSeverity = 'tip' | 'opportunity' | 'celebration';
type InsightStatus = 'new' | 'seen' | 'dismissed' | 'snoozed' | 'done';

type EvaluatedInsight = {
	id: string;
	category: string;
	severity: InsightSeverity;
	title: string;
	body: string;
	actionLabel?: string;
	actionCommand?: string;
	secondaryActionLabel?: string;
	secondaryActionCommand?: string;
	status: InsightStatus;
	allowToast?: boolean;
};

// ── Correction-moment types ─────────────────────────────────────────────────
// These mirror the interfaces in src/types.ts (CorrectionMoment etc.) and must
// be kept in sync manually — the webview bundle cannot import them directly.

type CorrectionMomentType = 'user-correction' | 'edit-retry' | 'edit-self-correction' | 'tool-error' | 'agent-self-correction';

/** A correction filter is either a moment type or the cross-type "escalated" flag. */
type CorrectionFilter = CorrectionMomentType | 'escalated';

type CorrectionMoment = {
	type: CorrectionMomentType;
	turnNumber: number;
	timestamp: string | null;
	snippet: string;
	tool?: string;
	file?: string;
	retried?: boolean;
	matchedPattern?: string;
	/** `user-correction` only: shouting/punctuation/intensifier cues on the message itself. */
	intensity?: 'strong';
	/** `user-correction` only: clustered with an earlier correction a few turns back. */
	escalated?: boolean;
	/** `agent-self-correction` only: which nearby signal corroborated the phrase match. */
	corroboratedBy?: 'tool-error' | 'edit-retry' | 'user-correction';
};

type CorrectionCounts = {
	userCorrections: number;
	editRetries: number;
	editSelfCorrections: number;
	toolErrors: number;
	toolErrorsRetried: number;
	agentSelfCorrections: number;
	escalatedUserCorrections: number;
};

type CorrectionSessionEntry = {
	file: string;
	title?: string | null;
	lastInteraction?: string | null;
	moments: CorrectionMoment[];
	totalMoments?: number;
};

type CorrectionRepoGroup = {
	repository: string;
	sessions: CorrectionSessionEntry[];
	counts: CorrectionCounts;
	sessionsWithMoments: number;
};

type CorrectionReport = {
	sessionsPerRepo: number;
	repos: CorrectionRepoGroup[];
	counts: CorrectionCounts;
	sessionsWithMoments: number;
};

// ── Repeated-task types ─────────────────────────────────────────────────────
// Mirror the interfaces in src/types.ts (RepeatedTaskReport etc.) — keep in
// sync manually; the webview bundle cannot import them directly.

type RepeatedTaskSessionRef = {
	file: string;
	title?: string | null;
	lastInteraction?: string | null;
	repository?: string;
};

type RepeatedTaskCluster = {
	representativePrompt: string;
	sessionCount: number;
	repositories: string[];
	sessions: RepeatedTaskSessionRef[];
	sharedKeywords: string[];
};

type RepeatedTaskReport = {
	minClusterSize: number;
	sessionsScanned: number;
	clusters: RepeatedTaskCluster[];
};

type UsageAnalysisStats = {
	today: UsageAnalysisPeriod;
	last30Days: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	lastMonth: UsageAnalysisPeriod;
	autoCompactionsLast7Days?: AutomaticCompactionStats;
	locale?: string;
	lastUpdated: string;
	customizationMatrix?: WorkspaceCustomizationMatrix | null;
	missedPotential?: MissedPotentialWorkspace[];
	backendConfigured?: boolean;
	readinessAvailable?: boolean;
	currentWorkspacePaths?: string[];
	suppressedUnknownTools?: string[];
	/** Per-tool, per-editor call counts (last 30 days); used to tag unknown-tool issue reports with the editor. */
	toolCallsByEditor?: { [tool: string]: { [editor: string]: number } };
	todaySessions?: TodaySessionSummary[];
	recentSessions?: { last7: TodaySessionSummary[]; last30: TodaySessionSummary[]; currentMonth: TodaySessionSummary[] };
	use24HourTime?: boolean;
	/** When true (default), rows tagged "auto" are hidden from the Tool Usage tables so only intentional tool calls are shown. */
	hideAutomaticToolCalls?: boolean;
	insights?: EvaluatedInsight[];
	/** Correction-moment report: per-repo, over each repo's most recent sessions. Undefined while the report is still loading, null when no moments were detected. */
	correctionReport?: CorrectionReport | null;
	/** Repeated-task candidates (skill suggestions). Null when no repeated task was found. */
	repeatedTasks?: RepeatedTaskReport | null;
	curationAnalysis?: ToolCurationAnalysis | null;
	/** Compact projection of the memory-files hygiene analysis (counts/rollup scalars only — no per-file paths). Null when none found. */
	memoryFilesAnalysis?: MemoryFilesAnalysisView | null;
	/**
	 * Compact projection of this repository's server-side Copilot memory store. Unlike
	 * `memoryFilesAnalysis` this carries fact text, because for server memories the fact is
	 * the finding. Null when the workspace is not a GitHub repository, memory is off, or the
	 * store could not be read.
	 */
	serverMemoriesAnalysis?: ServerMemoriesAnalysisView | null;
	/** Persisted "Recent Sessions" column visibility (optional column ids). Absent/invalid entries mean "show all". */
	sessionColumnSettings?: { enabledColumns?: string[] };
	/** Copilot API quota balance snapshot (available when the extension has fetched quota data). */
	copilotApiBalance?: CopilotApiBalance | null;
	/** Copilot budget for every GitHub account signed in to VS Code. */
	accountBudgets?: AccountBudgetView[];
	/** Current-month billing group costs in USD from the extension's local session tracking. */
	monthBillingGroupCosts?: Record<string, number> | null;
	/**
	 * How many Claude Desktop sessions have a transcript this machine can actually read. Drives the
	 * note explaining why Claude Desktop's own session list is longer than this table. Null/absent
	 * when no Claude Desktop sessions exist here.
	 */
	claudeDesktopCoverage?: { knownSessions: number; withTranscript: number; missingTranscript: number } | null;
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

interface CustomizationFileEntry {
	path: string;
	relativePath: string;
	type: string;
	icon?: string;
	label?: string;
	name?: string;
	lastModified?: string;
	isStale?: boolean;
	category?: 'copilot' | 'non-copilot';
}

interface WorkspaceCustomizationRow {
	workspacePath: string;
	workspaceName: string;
	sessionCount: number;
	interactionCount: number;
	typeStatuses: { [typeId: string]: CustomizationTypeStatus };
}

interface WorkspaceCustomizationMatrix {
	customizationTypes: Array<{ id: string; icon: string; label: string }>;
	workspaces: WorkspaceCustomizationRow[];
	totalWorkspaces: number;
	workspacesWithIssues: number;
}

interface MissedPotentialWorkspace {
	workspacePath: string;
	workspaceName: string;
	sessionCount: number;
	interactionCount: number;
	nonCopilotFiles: CustomizationFileEntry[];
}

/** Shape of hygiene check items returned by the extension host. */
interface RepoHygieneCheck {
	readonly id?: string;
	readonly label?: string;
	readonly detail?: string;
	readonly hint?: string;
	readonly weight?: number;
	readonly status?: string;
	readonly category?: string;
}

/** Shape of recommendation items returned by the extension host. */
interface RepoHygieneRecommendation {
	readonly action?: string;
	readonly impact?: string;
	readonly weight?: number;
	readonly priority?: string;
}

/** Shape of a full repo-hygiene analysis result. */
interface RepoAnalysisData {
	summary?: {
		percentage?: number;
		passedChecks?: number;
		warningChecks?: number;
		failedChecks?: number;
		totalScore?: number;
		maxScore?: number;
		categories?: Record<string, { percentage?: number }>;
	};
	checks?: RepoHygieneCheck[];
	recommendations?: RepoHygieneRecommendation[];
}
interface RepoAnalysisRecord {
	data?: RepoAnalysisData;
	error?: string;
}

/** Webview state persisted by VS Code across tab switches (survives the panel being hidden). */
interface UsageWebviewState {
	aboutCollapsed?: boolean;
}

const vscode = acquireVsCodeApi<UsageWebviewState>();
const notifyUsageWebviewReady = createUsageWebviewReadyNotifier(
	(message) => vscode.postMessage(message),
);
const curationTraceOnceKeys = new Set<string>();

/** Collapsed state of the "About This Dashboard" info box, restored from webview state. */
let aboutCollapsed = vscode.getState()?.aboutCollapsed ?? false;

function traceCuration(stage: string, details?: Record<string, unknown>): void {
	try {
		vscode.postMessage({ command: 'traceUsageCuration', stage, details: details ?? {} });
	} catch {
		// ignore tracing failures
	}
}

function traceCurationOnce(key: string, stage: string, details?: Record<string, unknown>): void {
	if (curationTraceOnceKeys.has(key)) { return; }
	curationTraceOnceKeys.add(key);
	traceCuration(stage, details);
}

type WorktreeBackgroundScanData = { scannedAt: string; totalBytes: number; worktreeCount: number; worktrees: unknown[] };
type InitialUsageData = UsageAnalysisStats & { customizationMatrix?: WorkspaceCustomizationMatrix | null; missedPotential?: MissedPotentialWorkspace[]; worktreeScanRoots?: string[]; localization?: Record<string, string>; worktreeBackgroundScan?: WorktreeBackgroundScanData | null };
const initialData = getWindowData<InitialUsageData>('__INITIAL_USAGE__');

// Initialize localization for webview
applyWebviewLocale(initialData);
let hygieneMatrixState: WorkspaceCustomizationMatrix | null = null;
const repoAnalysisState = new Map<string, RepoAnalysisRecord>();
/** Paths with an in-flight hygiene analysis; drives the disabled/secondary "Analyzing…" button state. */
const repoAnalysisInFlight = new Set<string>();
let selectedRepoPath: string | null = null;
let isSwitchingRepository = false;
/** When true, the Workspace Health repo list shows every workspace instead of grouping low-activity ones into "Other". */
let showAllWorkspacesInHealth = false;
let isBatchAnalysisInProgress = false;
/** True while the single "Analyze Repo for Best Practices" analysis (no workspace matrix) runs. */
let isSingleRepoAnalysisInProgress = false;
let currentWorkspacePaths: string[] = [];
let activeTab = 'activity';
let pendingTabAnchor: string | null = null;
/**
 * When a deep link that is still waiting for its section stops being honoured. Matches the
 * host's SURFACE_REVEAL_TTL_MS for every other panel, so a conditional section that turns up
 * much later does not scroll the user.
 */
const PENDING_ANCHOR_TTL_MS = 60_000;
let pendingTabAnchorExpiresAt = 0;
/**
 * How long an insight anchor keeps re-asserting itself once its card has been shown. Activating
 * the Insights tab immediately marks its new insights as "seen", which makes the host push a
 * fresh `updateInsights`; a background stats refresh runs the full `renderLayout`. Either rebuilds
 * every card, destroying the element we just scrolled to, and without this the scroll is lost.
 *
 * This governs re-assertion only. A deep link requested before the cards exist at all — a badge
 * click reaching a webview still on its loading screen — is carried by `pendingTabAnchor`, which
 * is only consumed once the element is actually found, so a slow stats load cannot drop it.
 */
const INSIGHT_FOCUS_WINDOW_MS = 4000;
let focusedInsightAnchor: { anchor: string; until: number } | null = null;
/** The node the last anchor scroll targeted, so a re-apply can tell a rebuild from a repeat. */
let lastAnchorScrollTarget: HTMLElement | null = null;
/** Handle of a deferred anchor scroll (section or insight card), so navigating away or a host cancel before it fires stops it. */
let pendingAnchorScrollTimer: ReturnType<typeof setTimeout> | null = null;
/** Elements with a highlight flash still in flight, with the styling their timer will restore. */
const activeFlashes = new WeakMap<HTMLElement, { shadow: string; transition: string; timer: ReturnType<typeof setTimeout> }>();
let loadingTimeoutId: ReturnType<typeof setTimeout> | null = null;
let currentInsights: EvaluatedInsight[] = [];
const darkFactoryTab = new DarkFactoryTab((message) => vscode.postMessage(message), traceToHost);
let activeCorrectionFilter: CorrectionFilter | null = null;
let currentCorrectionReport: CorrectionReport | null | undefined = undefined;
// Persisted across stats refreshes so the curation section doesn't disappear
// when a periodic updateStats message omits curationAnalysis.
let currentCurationAnalysis: ToolCurationAnalysis | null = null;
// Same rationale for the memory-files hygiene analysis.
let currentMemoryFilesAnalysis: MemoryFilesAnalysisView | null = null;
// And for the server-side repository memories, which additionally cost a network round
// trip — a refresh that omits them must keep showing the last good read rather than blank
// the section while the next fetch is in flight.
let currentServerMemoriesAnalysis: ServerMemoriesAnalysisView | null = null;

type WorktreeResult = {
	path: string;
	repoLabel: string;
	branch: string;
	lastCommit: string;
	lastCommitDate: string | null;
	pushed: "yes" | "no" | "?";
	files: number;
	folders: number;
	bytes: number;
};

type WorktreeScanStatus = {
	root: string;
	checked: number;
	total: number;
	foundCount: number;
	elapsedMs: number;
	/**
	 * "walking" while discovering .git markers under the root; "checking" while resolving them;
	 * "enriching" during the background size + push-status pass.
	 */
	phase?: "walking" | "checking" | "enriching";
	/** Folders explored during the "walking" phase (live activity indicator). */
	dirsScanned?: number;
	/** Worktrees whose size + push status have been computed during the "enriching" phase. */
	enriched?: number;
	/** Total worktrees to enrich during the "enriching" phase. */
	enrichTotal?: number;
};

// Worktree discovery tab state
let worktreeRoots: string[] = initialData?.worktreeScanRoots ? [...initialData.worktreeScanRoots] : [];
let worktreeResults: WorktreeResult[] = initialData?.worktreeBackgroundScan
	? initialData.worktreeBackgroundScan.worktrees.map(sanitizeWorktreeResult)
	: [];
// Set when worktreeResults reflects the once-daily background scan rather than a live/manual
// scan the user just ran — used to show a "found automatically" banner instead of empty state.
let worktreeBackgroundScanMeta: { scannedAt: string; totalBytes: number } | null = initialData?.worktreeBackgroundScan
	? { scannedAt: initialData.worktreeBackgroundScan.scannedAt, totalBytes: initialData.worktreeBackgroundScan.totalBytes }
	: null;
let worktreeScanInProgress = false;
let worktreeScanStatus: WorktreeScanStatus = { root: "", checked: 0, total: 0, foundCount: 0, elapsedMs: 0 };
let worktreeScanError: string | null = null;
let worktreeRenderPending = false;
// Repo labels whose per-worktree details table is expanded in the results view.
const worktreeExpandedRepos = new Set<string>();
// Whether the root-folders list is expanded. Collapsed by default when there are more than 2.
let worktreeRootsExpanded = false;

// Bulk "clean up pushed worktrees" state.
let worktreeCleanupInProgress = false;
// True from the moment the cleanup button is clicked until the extension's native confirm
// modal is answered, so a second click can't fire a duplicate confirmation while it's open.
let worktreeCleanupConfirmPending = false;
let worktreeCleanupStatus: { processed: number; total: number } = { processed: 0, total: 0 };
type WorktreeCleanupOutcome = "deleted" | "skipped" | "error";
/**
 * Remediation context for a cleanup row the user still has to act on (see
 * WorktreeCleanupDiagnostics in extension.ts — same shape, all fields best-effort).
 */
type WorktreeCleanupDiagnostics = {
	lastModified?: string;
	lastCommitDate?: string;
	lastCommitRelative?: string;
	remoteBranch?: string;
	remoteStatus?: "tracked" | "gone" | "none";
	ahead?: number;
	behind?: number;
	modifiedFiles?: number;
	untrackedFiles?: number;
	sizeBytes?: number;
};
/** Live state of a "Delete anyway…" retry on a cleanup-log row, keyed by worktree path. */
type WorktreeRetryState = { status: "running" | "deleted" | "error"; reason?: string };
const worktreeRetryState = new Map<string, WorktreeRetryState>();
type WorktreeCleanupLogEntry = { path: string; branch: string; repoLabel: string; status: WorktreeCleanupOutcome; reason?: string; diagnostics?: WorktreeCleanupDiagnostics };
let worktreeCleanupLog: WorktreeCleanupLogEntry[] = [];

function numField(v: unknown): number { return Number(v ?? 0) || 0; }

const USAGE_LOADING_CSS = `
<style id="usage-loading-css">
:root {
  --ul-bg: var(--vscode-sideBar-background, #181825);
  --ul-card: var(--vscode-editorWidget-background, #24273a);
  --ul-fg: var(--vscode-editor-foreground, #cdd6f4);
  --ul-muted: var(--vscode-descriptionForeground, #9399b2);
  --ul-accent: var(--vscode-textLink-foreground, #89b4fa);
  --ul-success: var(--vscode-terminal-ansiGreen, #a6e3a1);
  --ul-border: var(--vscode-panel-border, #313244);
  --ul-badge-bg: var(--vscode-badge-background, #313244);
}
#usage-loading-wrap {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  display: flex; align-items: flex-start; justify-content: center; padding: 28px 20px;
}
#usage-loading-card {
  width: 100%; max-width: 680px;
  background: var(--ul-card); border: 1px solid var(--ul-border);
  border-radius: 16px; padding: 24px 28px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3); color: var(--ul-fg);
}
#ul-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 16px; }
#ul-badge { font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: var(--ul-accent); margin-bottom: 4px; }
#ul-title { font-size: 22px; font-weight: 700; color: var(--ul-fg); margin-bottom: 4px; }
#ul-subtitle { font-size: 12px; color: var(--ul-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
#ul-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
#ul-pct { font-size: 32px; font-weight: 800; color: var(--ul-fg); line-height: 1; min-width: 60px; text-align: right; font-variant-numeric: tabular-nums; }
.ul-meta-badge { font-size: 11px; padding: 3px 10px; border: 1px solid var(--ul-border); border-radius: 20px; color: var(--ul-muted); background: var(--vscode-editor-background, #1e1e2e); white-space: nowrap; }
#ul-track { height: 6px; background: var(--ul-border); border-radius: 3px; overflow: hidden; margin: 16px 0; }
#ul-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--ul-accent), var(--ul-success)); transition: width 0.4s ease; width: 3%; }
#ul-fill.ul-indeterminate { width: 25%; animation: ul-shimmer 1.8s ease-in-out infinite; background: linear-gradient(90deg, transparent, var(--ul-accent), var(--ul-success), transparent); }
@keyframes ul-shimmer { 0% { margin-left: -30%; } 100% { margin-left: 110%; } }
#ul-steps { background: var(--ul-bg); border: 1px solid var(--ul-border); border-radius: 10px; padding: 14px 16px; }
.ul-step { display: flex; align-items: center; gap: 10px; padding: 5px 0; color: var(--ul-muted); font-size: 13px; transition: color 0.25s; }
.ul-step.ul-done   { color: var(--ul-success); }
.ul-step.ul-active { color: var(--ul-accent); font-weight: 600; }
.ul-ico { width: 18px; text-align: center; flex-shrink: 0; }
.ul-spin { display: inline-block; animation: ul-spin 0.75s linear infinite; }
@keyframes ul-spin { to { transform: rotate(360deg); } }
.ul-lbl { flex: 1; }
.ul-cnt { font-size: 11px; opacity: 0.75; font-variant-numeric: tabular-nums; }
@keyframes ul-pop { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.3); } 100% { transform: scale(1); opacity: 1; } }
.ul-pop { animation: ul-pop 0.3s ease both; }
</style>`;

const USAGE_LOADING_STEPS = [
	{ id: 'ul-s-start',  label: 'Starting usage analysis' },
	{ id: 'ul-s-tools',  label: 'Collecting runtime tools' },
	{ id: 'ul-s-mcp',    label: 'Discovering MCP servers' },
	{ id: 'ul-s-skills', label: 'Scanning skill directories' },
	{ id: 'ul-s-crunch', label: 'Computing curation analysis' },
	{ id: 'ul-s-ready',  label: 'Ready!' },
] as const;

type UsageLoadingStepId = typeof USAGE_LOADING_STEPS[number]['id'];

const USAGE_STAGE_MAP: Record<string, { pct: number; stepId: UsageLoadingStepId; subtitle: string }> = {
	start:                     { pct:  5, stepId: 'ul-s-start',  subtitle: 'Starting usage analysis…' },
	'curation:start':          { pct: 20, stepId: 'ul-s-tools',  subtitle: 'Collecting tools and skills…' },
	'curation:runtimeTools':   { pct: 32, stepId: 'ul-s-tools',  subtitle: 'Collected runtime tools' },
	'curation:mcpJson':        { pct: 44, stepId: 'ul-s-mcp',    subtitle: 'Scanning MCP config files…' },
	'curation:mcpSources':     { pct: 55, stepId: 'ul-s-mcp',    subtitle: 'Collected MCP servers' },
	'curation:skillsScanStart':{ pct: 63, stepId: 'ul-s-skills', subtitle: 'Scanning skill directories…' },
	'curation:skillsScanDone': { pct: 75, stepId: 'ul-s-skills', subtitle: 'Skill discovery complete' },
	'curation:analyzing':      { pct: 85, stepId: 'ul-s-crunch', subtitle: 'Analyzing tool usage patterns…' },
	'curation:done':           { pct: 96, stepId: 'ul-s-crunch', subtitle: 'Curation analysis complete' },
	ready:                     { pct:100, stepId: 'ul-s-ready',  subtitle: 'Usage analysis ready' },
	error:                     { pct:100, stepId: 'ul-s-ready',  subtitle: 'Analysis completed with errors' },
	'curation:error':          { pct: 85, stepId: 'ul-s-crunch', subtitle: 'Curation analysis skipped' },
};

function renderUsageLoadingState(initialMessage = 'Loading usage analysis...'): void {
	const root = document.getElementById('root');
	if (!root) { return; }
	_ulLoadingActive = true;
	// The tab bar is about to be replaced, so the next layout is a fresh one: a switchTab
	// arriving while this loading UI is up has no button to click, and only setupTabs can
	// start that tab's fetch once the layout comes back.
	layoutLazyTabLoadStarted = false;

	const stepsHtml = USAGE_LOADING_STEPS.map((s, i) => {
		const isFirst = i === 0;
		const cls = isFirst ? 'ul-step ul-active' : 'ul-step';
		const ico = isFirst ? '<span class="ul-spin">↻</span>' : '○';
		return `<div class="${cls}" id="${s.id}"><span class="ul-ico">${ico}</span><span class="ul-lbl">${escapeHtml(s.label)}</span><span class="ul-cnt" id="${s.id}-cnt"></span></div>`;
	}).join('');

	setHtml(root, `${USAGE_LOADING_CSS}
<div id="usage-loading-wrap">
  <div id="usage-loading-card">
    <div id="ul-header">
      <div>
        <div id="ul-badge">📊 Analyzing Usage Data</div>
        <div id="ul-title">${escapeHtml(initialMessage)}</div>
        <div id="ul-subtitle">Initializing…</div>
      </div>
      <div id="ul-right">
        <div id="ul-pct">–</div>
        <div style="display:flex;gap:6px;" id="ul-meta"></div>
      </div>
    </div>
    <div id="ul-track"><div id="ul-fill" class="ul-indeterminate"></div></div>
    <div id="ul-steps">${stepsHtml}</div>
  </div>
</div>`);
}

function _ulSetDone(id: string): void {
	const el = document.getElementById(id);
	if (!el) { return; }
	el.className = 'ul-step ul-done';
	const ico = el.querySelector('.ul-ico');
	if (ico) { setHtml(ico, '<span class="ul-pop">✓</span>'); }
}

function _ulSetActive(id: string): void {
	const el = document.getElementById(id);
	if (!el) { return; }
	el.className = 'ul-step ul-active';
	const ico = el.querySelector('.ul-ico');
	if (ico) { setHtml(ico, '<span class="ul-spin">↻</span>'); }
}

function _ulSetCnt(id: string, text: string): void {
	const el = document.getElementById(`${id}-cnt`);
	if (el) { el.textContent = text; }
}

let _ulLastStepIdx = 0;
// True while the loading card is the active view. Once real content is
// rendered (updateStats) this is cleared, so stray progress events from a
// background silent recompute never re-create the loading card over content.
let _ulLoadingActive = false;

function _ulAdvanceSteps(targetIdx: number, pct: number): void {
	for (let i = _ulLastStepIdx; i < targetIdx; i++) { _ulSetDone(USAGE_LOADING_STEPS[i].id); }
	if (targetIdx > _ulLastStepIdx) { _ulLastStepIdx = targetIdx; }
	if (pct < 100) { _ulSetActive(USAGE_LOADING_STEPS[targetIdx].id); }
	else { _ulSetDone(USAGE_LOADING_STEPS[targetIdx].id); }
}

function _ulDetailCnt(details: Record<string, unknown>): string {
	if (typeof details.count === 'number') { return `${details.count}`; }
	if (typeof details.skills === 'number') { return `${details.skills} skills`; }
	if (typeof details.availableTools === 'number') { return `${details.availableTools} tools`; }
	return '';
}

// Ensures the loading card exists before applying a progress event. Returns
// false when the event should be ignored because content has already replaced
// the card (stray events from a background silent recompute), preventing the
// loading card from flashing back over the rendered analysis.
function _ulEnsureCard(): boolean {
	const root = document.getElementById('root');
	if (!root) { return false; }
	if (root.querySelector('#usage-loading-card')) { return true; }
	if (!_ulLoadingActive) { return false; }
	renderUsageLoadingState('Building Usage Analysis');
	_ulLastStepIdx = 0;
	return true;
}

function updateUsageLoadingProgress(message: any): void {
	if (!_ulEnsureCard()) { return; }
	const stage = typeof message?.stage === 'string' ? message.stage : '';
	const mapped = USAGE_STAGE_MAP[stage];
	if (!mapped) { return; }

	const pct = mapped.pct;
	const fill = document.getElementById('ul-fill');
	if (fill) { fill.classList.remove('ul-indeterminate'); fill.style.width = `${Math.max(pct, 3)}%`; }
	const pctEl = document.getElementById('ul-pct');
	if (pctEl) { pctEl.textContent = pct === 100 ? '100%' : `${pct}%`; }
	const subtitleEl = document.getElementById('ul-subtitle');
	if (subtitleEl) { subtitleEl.textContent = mapped.subtitle; }

	const targetIdx = USAGE_LOADING_STEPS.findIndex(s => s.id === mapped.stepId);
	if (targetIdx >= 0) { _ulAdvanceSteps(targetIdx, pct); }

	const details = message?.details;
	if (details && typeof details === 'object') {
		const cnt = _ulDetailCnt(details as Record<string, unknown>);
		if (cnt) { _ulSetCnt(mapped.stepId, `(${cnt})`); }
	}
}

function clearLoadingTimeout(): void {
	if (loadingTimeoutId !== null) {
		clearTimeout(loadingTimeoutId);
		loadingTimeoutId = null;
	}
}

/** Creates a styled Refresh button that posts `refresh` to the extension host. */
function createRefreshButton(): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.textContent = '🔄 Refresh';
	btn.style.cssText = 'padding: 6px 16px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border-radius: 2px; font-size: 13px;';
	btn.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
	return btn;
}

function showLoadError(message: string): void {
	const root = document.getElementById('root');
	if (!root) { return; }
	const container = document.createElement('div');
	container.style.cssText = 'padding: 32px; text-align: center; font-size: 14px;';
	const icon = document.createElement('div');
	icon.style.cssText = 'font-size: 24px; margin-bottom: 12px;';
	setHtml(icon, statusBadgeHtml('❌', localize('usage.customization.status.error')));
	const msg = document.createElement('div');
	msg.style.cssText = 'color: var(--vscode-errorForeground, #f48771); margin-bottom: 16px;';
	msg.textContent = message;
	container.append(icon, msg, createRefreshButton());
	root.textContent = '';
	root.append(container);
}

// State for the Repository PRs tab
let repoPrStatsLoaded = false;
/** True once the layout currently on screen has kicked off its active tab's lazy fetch. */
let layoutLazyTabLoadStarted = false;
let repoPrStatsData: RepoPrStatsResult | null = null;

// State for the Cloud Agent tab
let agentSessionsLoaded = false;
let agentSessionsData: AgentSessionsResult | null = null;

type RepoPrDetail = {
  number: number;
  title: string;
  url: string;
  aiType: 'copilot' | 'claude' | 'openai' | 'other-ai';
  role: 'author' | 'reviewer-requested';
};

type RepoPrInfo = {
  owner: string;
  repo: string;
  repoUrl: string;
  totalPrs: number;
  aiAuthoredPrs: number;
  aiReviewRequestedPrs: number;
  aiDetails: RepoPrDetail[];
  userAuthoredPrs?: number;
  userMergedPrs?: number;
  error?: string;
};

type RepoPrStatsResult = {
  repos: RepoPrInfo[];
  authenticated: boolean;
  since: string;
  error?: string;
  /** When the snapshot was fetched from GitHub; empty string when it has never been fetched. */
  fetchedAt?: string;
  /** How often the snapshot is refreshed, so the UI can say when the next refresh is due. */
  refreshIntervalMs?: number;
};

const EFFORT_DISPLAY_NAMES: Record<string, string> = {
	xhigh: 'Extra High',
};

function getEffortDisplayName(level: string): string {
	return EFFORT_DISPLAY_NAMES[level] ?? level;
}

import { resolveGuidMcpToolName, isGuidMcpTool, resolveMcpFamilyToolName, isMcpFamilyResolvedTool, lookupKnownToolName, isKnownToolDisplayName } from '../../../../src/utils/toolUtils';
import { preferredScrollBehavior } from '../shared/surfaceNavigation';

// Tool name maps are injected by the extension host as window.__TOOL_NAMES__ and window.__AUTOMATIC_TOOLS__
const TOOL_NAME_MAP: { [key: string]: string } | null = getWindowData<Record<string, string>>('__TOOL_NAMES__') ?? null;
const _automaticToolIds = getWindowData<string[]>('__AUTOMATIC_TOOLS__') ?? [];
const AUTOMATIC_TOOL_SET_WV = new Set<string>(_automaticToolIds.map(id => id.toLowerCase()));

function lookupToolName(id: string): string {
	if (!TOOL_NAME_MAP) {
		return id;
	}
	return lookupKnownToolName(id, TOOL_NAME_MAP) ?? resolveGuidMcpToolName(id) ?? resolveMcpFamilyToolName(id) ?? id;
}

function lookupMcpToolName(id: string): string {
	const full = lookupToolName(id);
	// Strip the server prefix (e.g. "GitHub MCP (Local): Issue Read" → "Issue Read")
	const colonIdx = full.indexOf(':');
	if (colonIdx !== -1) {
		return full.substring(colonIdx + 1).trim();
	}
	return full;
}

function getUnknownMcpTools(stats: UsageAnalysisStats): string[] {
	const allTools = new Set<string>();
	
	// Collect all MCP tools from all periods
	Object.entries(stats.today.mcpTools.byTool).forEach(([tool]) => allTools.add(tool));
	Object.entries(stats.last30Days.mcpTools.byTool).forEach(([tool]) => allTools.add(tool));
	Object.entries(stats.month.mcpTools.byTool).forEach(([tool]) => allTools.add(tool));
	// Also collect MCP server names — the "By Server" tables render them through the
	// same friendly-name lookup, so an unmapped server name (e.g. `ccd_session`)
	// would otherwise show raw without ever being flagged as missing.
	Object.keys(stats.today.mcpTools.byServer).forEach(server => allTools.add(server));
	Object.keys(stats.last30Days.mcpTools.byServer).forEach(server => allTools.add(server));
	Object.keys(stats.month.mcpTools.byServer).forEach(server => allTools.add(server));
	// Also collect all general tool calls so non-MCP tools without friendly names are caught
	Object.entries(stats.today.toolCalls.byTool).forEach(([tool]) => allTools.add(tool));
	Object.entries(stats.last30Days.toolCalls.byTool).forEach(([tool]) => allTools.add(tool));
	Object.entries(stats.month.toolCalls.byTool).forEach(([tool]) => allTools.add(tool));

	const suppressed = new Set<string>(stats.suppressedUnknownTools ?? []);
	
	// Filter to only unknown tools (not a key in the map, case-insensitively or canonically, and not
	// resolvable via a known GUID/family pattern) and not suppressed. Tools resolved via
	// isMcpFamilyResolvedTool are a recognized MCP tool under a new server-registration
	// spelling (see issue #1760) — they shouldn't generate another "add missing name" report.
	return Array.from(allTools).filter(tool => !(TOOL_NAME_MAP && (lookupKnownToolName(tool, TOOL_NAME_MAP) || isKnownToolDisplayName(tool, TOOL_NAME_MAP))) && !isGuidMcpTool(tool) && !isMcpFamilyResolvedTool(tool) && !suppressed.has(tool)).sort();
}

function createMcpToolIssueUrl(unknownTools: string[], toolCallsByEditor?: { [tool: string]: { [editor: string]: number } }): string {
	const repoUrl = 'https://github.com/rajbos/ai-engineering-fluency';
	const title = encodeURIComponent('Add missing friendly names for tools');
	const toolList = unknownTools.map(tool => {
		const editors = formatToolEditors(tool, toolCallsByEditor);
		return editors ? `- \`${tool}\` (seen in: ${editors})` : `- \`${tool}\``;
	}).join('\n');
	const body = encodeURIComponent(
		`## Unknown Tools Found\n\n` +
		`The following tools were detected but don't have friendly display names:\n\n` +
		`${toolList}\n\n` +
		`Please add friendly names for these tools to improve the user experience.`
	);
	const labels = encodeURIComponent('MCP Toolnames');
	
	return `${repoUrl}/issues/new?title=${title}&body=${body}&labels=${labels}`;
}

// ─── Mode bar chart helpers ────────────────────────────────────────────────────

type ModeBarConfig = {
readonly label: string;
readonly key: keyof ModeUsage;
readonly gradient: string;
};

const MODE_BAR_CONFIGS: readonly ModeBarConfig[] = [
{ label: '\u{1F4AC} Ask Mode',    key: 'ask',         gradient: 'linear-gradient(90deg, #3b82f6, #60a5fa)' },
{ label: '\u270F\uFE0F Edit Mode',   key: 'edit',        gradient: 'linear-gradient(90deg, #10b981, #34d399)' },
{ label: '\u{1F916} Agent Mode',  key: 'agent',       gradient: 'linear-gradient(90deg, #7c3aed, #a855f7)' },
{ label: '\u{1F4CB} Plan Mode',   key: 'plan',        gradient: 'linear-gradient(90deg, #f59e0b, #fbbf24)' },
{ label: '\u26A1 Custom Agent',   key: 'customAgent', gradient: 'linear-gradient(90deg, #ec4899, #f472b6)' },
{ label: '\u{1F5A5}\uFE0F CLI',   key: 'cli',         gradient: 'linear-gradient(90deg, #06b6d4, #22d3ee)' },
{ label: '\u2728 Copilot App',    key: 'cliApp',      gradient: 'linear-gradient(90deg, #6366f1, #818cf8)' },
{ label: '\u{1F5A5}\uFE0F Claude Desktop', key: 'claudeDesktop', gradient: 'linear-gradient(90deg, #d97706, #f59e0b)' },
{ label: '\u{1F9E9} Claude (VS Code)', key: 'claudeVsCode', gradient: 'linear-gradient(90deg, #ea580c, #fb923c)' },
];

/** Renders a single horizontal bar item for the mode usage chart. */
function renderModeBarItem(label: string, count: number, total: number, gradient: string): string {
const pct = total > 0 ? (count / total) * 100 : 0;
return `
<div class="bar-item">
<div class="bar-label"><span>${label}</span><span><strong>${formatNumber(count)}</strong> (${formatPercent(pct, 0)})</span></div>
<div class="bar-track"><div class="bar-fill" style="width: ${pct.toFixed(1)}%; background: ${gradient};"></div></div>
</div>`;
}

/** Renders the full bar-chart column for a single time period's mode usage. */
function renderModeBarChart(modeUsage: ModeUsage, title: string): string {
const total = modeUsage.ask + modeUsage.edit + modeUsage.agent + modeUsage.plan + modeUsage.customAgent + modeUsage.cli + (modeUsage.cliApp ?? 0) + (modeUsage.claudeDesktop ?? 0) + (modeUsage.claudeVsCode ?? 0);
const bars = MODE_BAR_CONFIGS
.map(({ label, key, gradient }) => renderModeBarItem(label, modeUsage[key] ?? 0, total, gradient))
.join('');
return `
<div>
<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">${title}</h4>
<div class="bar-chart">${bars}
</div>
</div>`;
}

// ─── Multi-model period helper ──────────────────────────────────────────────────

/** Renders the top stats-grid section (avg models, switching frequency, max models). */
function _renderMultiModelStatCards(switching: ModelSwitchingAnalysis): string {
return `
<div class="stats-grid" style="grid-template-columns: 1fr;">
<div class="stat-card">
<div class="stat-label">\u{1F4CA} Avg Models per Conversation</div>
<div class="stat-value">${formatFixed(switching.averageModelsPerSession, 1)}</div>
</div>
<div class="stat-card">
<div class="stat-label">\u{1F504} Switching Frequency</div>
<div class="stat-value">${formatPercent(switching.switchingFrequency, 0)}</div>
<div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Sessions with &gt;1 model</div>
</div>
<div class="stat-card">
<div class="stat-label">\u{1F4C8} Max Models in Session</div>
<div class="stat-value">${formatNumber(switching.maxModelsPerSession || 0)}</div>
</div>
</div>`;
}

/** Renders the "Models by Cost Level" breakdown listing model names per cost tier. */
function _renderMultiModelCostLevelBreakdown(
allLowCostModels: readonly string[],
allMediumCostModels: readonly string[],
allHighCostModels: readonly string[],
allUnknownModels: readonly string[],
): string {
return `
<div style="min-height: 110px;">
${allLowCostModels.length > 0 ? `
<div style="margin-bottom: 6px;">
<span style="color: #4ade80;">💚 Low cost:</span>
<span style="font-size: 11px; color: var(--text-primary);">${allLowCostModels.map(escapeHtml).join(', ')}</span>
</div>
` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
${allMediumCostModels.length > 0 ? `
<div style="margin-bottom: 6px;">
<span style="color: var(--link-color);">🟡 Medium cost:</span>
<span style="font-size: 11px; color: var(--text-primary);">${allMediumCostModels.map(escapeHtml).join(', ')}</span>
</div>
` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
${allHighCostModels.length > 0 ? `
<div style="margin-bottom: 6px;">
<span style="color: var(--warning-fg);">💸 High cost:</span>
<span style="font-size: 11px; color: var(--text-primary);">${allHighCostModels.map(escapeHtml).join(', ')}</span>
</div>
` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
${allUnknownModels.length > 0 ? `
<div style="margin-bottom: 6px;">
<span style="color: var(--text-muted);">❓ Unknown:</span>
<span style="font-size: 11px; color: var(--text-primary);">${allUnknownModels.map(escapeHtml).join(', ')}</span>
</div>
` : ''}
</div>`;
}

/** Renders the "Request Count" breakdown by cost tier, or an empty string if there were no requests. */
function _renderMultiModelRequestCountBreakdown(switching: ModelSwitchingAnalysis): string {
if (switching.totalRequests <= 0) {
return '';
}
return `
<div style="padding-top: 8px; border-top: 1px solid var(--border-subtle); min-height: 85px;">
<div style="font-size: 11px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Request Count:</div>
${switching.lowCostRequests > 0 ? `
<div style="margin-bottom: 4px; font-size: 11px;">
<span style="color: #4ade80;">💚 Low cost: </span>
<span style="color: var(--text-primary);">${formatNumber(switching.lowCostRequests)} (${formatPercent((switching.lowCostRequests / switching.totalRequests) * 100)})</span>
</div>
` : ''}
${switching.mediumCostRequests > 0 ? `
<div style="margin-bottom: 4px; font-size: 11px;">
<span style="color: var(--link-color);">🟡 Medium cost: </span>
<span style="color: var(--text-primary);">${formatNumber(switching.mediumCostRequests)} (${formatPercent((switching.mediumCostRequests / switching.totalRequests) * 100)})</span>
</div>
` : ''}
${switching.highCostRequests > 0 ? `
<div style="margin-bottom: 4px; font-size: 11px;">
<span style="color: var(--warning-fg);">💸 High cost: </span>
<span style="color: var(--text-primary);">${formatNumber(switching.highCostRequests)} (${formatPercent((switching.highCostRequests / switching.totalRequests) * 100)})</span>
</div>
` : ''}
${switching.unknownRequests > 0 ? `
<div style="margin-bottom: 4px; font-size: 11px;">
<span style="color: var(--text-muted);">❓ Unknown: </span>
<span style="color: var(--text-primary);">${formatNumber(switching.unknownRequests)} (${formatPercent((switching.unknownRequests / switching.totalRequests) * 100)})</span>
</div>
` : ''}
</div>`;
}

/** Renders the mixed-cost-sessions callout line, or an empty string if there were none. */
function _renderMultiModelMixedCostSessions(switching: ModelSwitchingAnalysis): string {
if (switching.mixedCostSessions <= 0) {
return '';
}
return `
<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-subtle);">
<span style="font-size: 11px; color: var(--link-color);">🔀 Mixed cost sessions: ${formatNumber(switching.mixedCostSessions)}</span>
</div>`;
}

/** Renders one column of the Multi-Model Usage section for a single time period. */
function renderMultiModelPeriod(
title: string,
switching: ModelSwitchingAnalysis,
allLowCostModels: readonly string[],
allMediumCostModels: readonly string[],
allHighCostModels: readonly string[],
allUnknownModels: readonly string[],
): string {
return `
<div>
<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">${title}</h4>
${_renderMultiModelStatCards(switching)}
<div style="margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
<div style="font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Models by Cost Level:</div>
${_renderMultiModelCostLevelBreakdown(allLowCostModels, allMediumCostModels, allHighCostModels, allUnknownModels)}
${_renderMultiModelRequestCountBreakdown(switching)}
${_renderMultiModelMixedCostSessions(switching)}
</div>
</div>`;
}

// ─── Progress panel helper ──────────────────────────────────────────────────────

/**
 * Updates (or creates) a progress indicator inside a container element.
 * Strips existing non-title/subtitle children on first call; updates text on subsequent calls.
 */
function updateProgressPanel(
selector: string,
progressClass: string,
messagePrefix: string,
done: number,
total: number,
): void {
const container = document.querySelector(selector);
if (!container) { return; }
const pct = total > 0 ? Math.round((done / total) * 100) : 0;
const message = `${messagePrefix} ${done}/${total} repos (${pct}%)`;
const existing = container.querySelector(`.${progressClass}`);
if (existing) {
existing.textContent = message;
} else {
// First progress update — remove static placeholder content (keep title/subtitle divs)
Array.from(container.children).forEach(child => {
const htmlEl = child as HTMLElement;
if (!htmlEl.classList.contains('section-title') && !htmlEl.classList.contains('section-subtitle')) {
htmlEl.remove();
}
});
const div = document.createElement('div');
div.className = progressClass;
div.style.cssText = 'margin-top:8px; font-size:12px; color:var(--text-secondary);';
div.textContent = message;
container.appendChild(div);
}
}

function renderMissedPotential(stats: UsageAnalysisStats): string {
	const missed = stats.missedPotential || initialData?.missedPotential || [];
	if (missed.length === 0) {
		return `
			<div id="section-missed-potential" style="margin-top: 16px; margin-bottom: 16px; padding: 12px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 6px;">
				<div style="font-size: 13px; font-weight: 600; color: var(--success-fg); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
					${statusBadgeHtml('✅')} No other AI tool configs missing a Copilot counterpart
				</div>
				<div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 8px;">
					All active workspaces that contain instruction files for other AI tools (e.g. .cursorrules, CLAUDE.md, AGENTS.md) also have Copilot customization files configured.
				</div>
				<div style="font-size: 11px; color: var(--text-secondary);">
					A workspace appears here when it has instruction files for other AI tools but no Copilot customization files — indicating Copilot may be under-configured compared to other tools. <a href="https://code.visualstudio.com/docs/copilot/customization/custom-instructions" style="color: var(--link-color);" target="_blank">Learn how to add Copilot instructions</a>.
				</div>
			</div>
		`;
	}

	return `
        <div id="section-missed-potential" style="margin-top: 16px; margin-bottom: 16px; padding: 12px; background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); border-radius: 6px;">
            <div style="font-size: 13px; font-weight: 600; color: var(--warning-fg); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                ${statusBadgeHtml('⚠️')} Missed Potential: Non-Copilot Instruction Files
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;">
                These active workspaces use other AI tools but lack Copilot customizations. <a href="https://code.visualstudio.com/docs/copilot/customization/custom-instructions" style="color: var(--link-color);" target="_blank">Learn how to add Copilot instructions</a>.
            </div>
            ${renderMissedPotentialTable(missed)}
        </div>
    `;
}

function renderToolsTable(tableId: string, ariaLabel: string, byTool: { [key: string]: number }, limit = 10, nameResolver: (id: string) => string = lookupToolName, applyAutoFilter = false): string {
	const entries = applyAutoFilter && hideAutomaticToolCalls
		? Object.entries(byTool).filter(([tool]) => !AUTOMATIC_TOOL_SET_WV.has(tool.toLowerCase()))
		: Object.entries(byTool);
	const sortedTools = entries
		.sort(([, a], [, b]) => b - a)
		.slice(0, limit);

	if (sortedTools.length === 0) {
		return applyAutoFilter && hideAutomaticToolCalls
			? '<div style="color: var(--text-muted);">No purposeful tools used yet (automatic tool calls are hidden)</div>'
			: '<div style="color: var(--text-muted);">No tools used yet</div>';
	}

	return renderToolCountTable({
		tableId,
		ariaLabel,
		entries: sortedTools,
		nameResolver,
		isAutomatic: tool => AUTOMATIC_TOOL_SET_WV.has(tool.toLowerCase()),
	});
}

// --- Recent Sessions table with sortable, toggleable columns ---
type SessionsLookback = Period;
const SESSIONS_TABLE_ID = 'recent-sessions';

/** Optional (toggleable) session table columns. Title is always shown and is not part of this set. */
type SessionColumnId = 'interactions' | 'toolCalls' | 'inputTokens' | 'outputTokens' | 'thinkingTokens' | 'cachedTokens' | 'totalTokens' | 'estimatedCost' | 'editor' | 'workspace' | 'models' | 'durationMs' | 'lastActivity' | 'subAgentCalls' | 'contextFill';

type SessionColumnDef = {
	id: SessionColumnId;
	label: string;
	/** Absent for columns that cannot be sorted (Models). */
	sortValue?: (s: TodaySessionSummary) => DataTableSortValue;
	align: 'left' | 'right';
	/** Extra cell class (styles.css `.sessions-table .session-col-*`). */
	cellClass?: string;
	/** `html` is trusted markup; `title` is plain text and is escaped when rendered. */
	render: (s: TodaySessionSummary) => { html: string; title?: string };
};

function formatCompactSessionNumber(value: number): { html: string; title: string } {
	return { html: formatCompact(value), title: formatNumber(value) };
}

/**
 * Whether a raw model id refers to HydraFusion.
 *
 * Ids arrive in several shapes (`hydrafusion`, `copilot/hydrafusion`, `hydra-fusion`,
 * a dated/preview suffix), so separators are stripped and the name must start the id —
 * that keeps unrelated models that merely end in the word (`unrelated-hydrafusion`) out.
 */
function isHydraFusionModel(model: string): boolean {
	return getModelLookupCandidates(model)
		.some(candidate => candidate.toLowerCase().replace(/[-_. ]/g, '').startsWith('hydrafusion'));
}

/**
 * Returns the duration to display/sort by for a session: the active (non-idle) duration when
 * available, falling back to the wall-clock duration for session formats that don't provide
 * per-request timing data (e.g. Copilot CLI JSONL, where `activeDurationMs` is always 0).
 * Single source of truth for this fallback so the cell renderer and sort comparator can't drift.
 */
function getEffectiveSessionDurationMs(s: TodaySessionSummary): number | undefined {
	return s.activeDurationMs ? s.activeDurationMs : s.durationMs;
}

/** Timestamp sort key for an ISO date; unparseable or missing dates sort last. */
function sessionTimestamp(iso: string | undefined): number | null {
	const time = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(time) ? time : null;
}

const SESSION_COLUMN_DEFS: SessionColumnDef[] = [
	{ id: 'interactions', label: 'Turns', sortValue: s => s.interactions, align: 'right', render: s => formatCompactSessionNumber(s.interactions) },
	{ id: 'toolCalls', label: 'Tools', sortValue: s => s.toolCalls, align: 'right', render: s => formatCompactSessionNumber(s.toolCalls) },
	{ id: 'subAgentCalls', label: 'Sub-Agents', sortValue: s => s.subAgentCalls ?? 0, align: 'right', render: s => s.subAgentCalls
		? { ...formatCompactSessionNumber(s.subAgentCalls), title: `${formatNumber(s.subAgentCalls)} sub-agent tool call${s.subAgentCalls === 1 ? '' : 's'} detected in this session` }
		: { html: '—', title: 'No sub-agent calls detected in this session' } },
	{ id: 'inputTokens', label: 'Input', sortValue: s => s.inputTokens, align: 'right', render: s => formatCompactSessionNumber(s.inputTokens) },
	{ id: 'outputTokens', label: 'Output', sortValue: s => s.outputTokens, align: 'right', render: s => formatCompactSessionNumber(s.outputTokens) },
	{ id: 'thinkingTokens', label: 'Thinking', sortValue: s => s.thinkingTokens, align: 'right', render: s => formatCompactSessionNumber(s.thinkingTokens) },
	{ id: 'cachedTokens', label: 'Cached', sortValue: s => s.cachedTokens, align: 'right', render: s => formatCompactSessionNumber(s.cachedTokens) },
	{ id: 'totalTokens', label: 'Total', sortValue: s => s.totalTokens, align: 'right', render: s => formatCompactSessionNumber(s.totalTokens) },
	{ id: 'estimatedCost', label: 'Cost', sortValue: s => s.estimatedCost, align: 'right', render: s => s.estimatedCost > 0
		? { html: formatCost(s.estimatedCost), title: `$${s.estimatedCost.toFixed(4)}` }
		: { html: '—' } },
	{ id: 'editor', label: 'Editor', sortValue: s => s.editor || '', align: 'left', render: s => ({ html: escapeHtml(s.editor || 'unknown') }) },
	{ id: 'workspace', label: 'Workspace', sortValue: s => s.workspace || '', align: 'left', cellClass: 'session-col-workspace', render: s => ({ html: escapeHtml(s.workspace || '—'), title: s.workspace || '—' }) },
	{ id: 'models', label: 'Models', align: 'left', cellClass: 'session-col-models', render: s => { const models = s.models.map(m => getModelDisplayName(m)).join(', ') || '—'; return { html: escapeHtml(models), title: models }; } },
	{ id: 'durationMs', label: 'Duration', sortValue: s => getEffectiveSessionDurationMs(s), align: 'right', cellClass: 'session-col-nowrap', render: s => {
		const net = getEffectiveSessionDurationMs(s);
		const wallLabel = s.durationMs !== undefined ? `Wall time: ${formatDurationShort(s.durationMs)}` : undefined;
		return { html: formatDurationShort(net), ...(wallLabel ? { title: wallLabel } : {}) };
	} },
	{ id: 'contextFill', label: localize('usage.sessions.contextFill.columnLabel'), sortValue: s => getSessionContextFillPercent(s), align: 'right', cellClass: 'session-col-nowrap', render: s => {
		const pct = getSessionContextFillPercent(s);
		if (pct === undefined) {
			return { html: '—', title: localize('usage.sessions.contextFill.noData') };
		}
		const near = isSessionNearContextLimit(s);
		const reached = formatNumber(s.contextReachedTokens!);
		const limit = formatNumber(s.contextWindowLimit!);
		const title = near
			? localizeFormat('usage.sessions.contextFill.usedNearLimit', reached, limit, NEAR_LIMIT_PERCENT)
			: localizeFormat('usage.sessions.contextFill.used', reached, limit);
		const color = near ? 'var(--warning-color, #cca700)' : 'var(--text-primary)';
		return { html: `<span style="color:${color};">${near ? '⚠️ ' : ''}${pct}%</span>`, title };
	} },
	{
		id: 'lastActivity', label: 'Last Active', sortValue: s => sessionTimestamp(s.lastActivity), align: 'right', cellClass: 'session-col-nowrap',
		render: s => ({
			html: s.lastActivity
				? (sessionsLookback === 'today'
					? new Date(s.lastActivity).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !use24HourTime })
					: new Date(s.lastActivity).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !use24HourTime }))
				: '—'
		}),
	},
];

const ALL_SESSION_COLUMN_IDS: SessionColumnId[] = SESSION_COLUMN_DEFS.map(c => c.id);

let cachedTodaySessions: TodaySessionSummary[] = [];
let use24HourTime = true;
/** When true (default), the Tool Usage tables hide rows tagged "auto" so purposeful tool calls stand out. */
let hideAutomaticToolCalls = true;
// Lookback selector state: "today" renders the summaries bundled with updateStats;
// longer windows are lazily requested from the extension host and cached here.
let sessionsLookback: SessionsLookback = 'today';
let latestTodaySessions: TodaySessionSummary[] = [];
const recentSessionsCache: { [period: string]: TodaySessionSummary[] } = {};
/** Which optional columns are currently visible. Title (and the row number) are always shown. */
let enabledSessionColumns: Set<SessionColumnId> = new Set(ALL_SESSION_COLUMN_IDS);
/** Columns a navigation preset turned on; re-applied whenever saved settings replace the set above. */
const presetForcedColumns = new Set<SessionColumnId>();

// --- Recent Sessions pill filters (Editor / Model / Model vendor / HydraFusion) ---
/** Active editor pill filters. Empty set means "no filter" (show all editors). */
let sessionFilterEditors: Set<string> = new Set();
/** Active model-vendor pill filters (e.g. "Anthropic", "OpenAI"). Empty set means "no filter". */
let sessionFilterVendors: Set<string> = new Set();
/** Active model pill filters. Empty set means "no filter". */
let sessionFilterModels: Set<string> = new Set();
/** Quick toggle: when true, only show sessions that used a HydraFusion model. */
let sessionFilterHydraFusionOnly = false;
/** Quick toggle: when true, only show sessions that nearly filled their context window. */
let sessionFilterNearContextLimitOnly = false;

function saveSessionColumnSettings(): void {
	vscode.postMessage({ command: 'saveSessionColumnSettings', settings: { enabledColumns: Array.from(enabledSessionColumns) } });
}

/** Returns true when a session passes all currently active pill filters. */
function sessionMatchesFilters(s: TodaySessionSummary): boolean {
	if (sessionFilterNearContextLimitOnly && !isSessionNearContextLimit(s)) { return false; }
	if (sessionFilterHydraFusionOnly && !s.models.some(isHydraFusionModel)) { return false; }
	if (sessionFilterEditors.size > 0 && !sessionFilterEditors.has(s.editor || 'unknown')) { return false; }
	if (sessionFilterModels.size > 0 && !s.models.some(m => sessionFilterModels.has(m))) { return false; }
	if (sessionFilterVendors.size > 0 && !s.models.some(m => sessionFilterVendors.has(getModelBillingProvider(m)))) { return false; }
	return true;
}

/** Whether any Recent Sessions pill filter is currently active. */
function hasActiveSessionFilters(): boolean {
	return sessionFilterHydraFusionOnly || sessionFilterNearContextLimitOnly
		|| sessionFilterEditors.size > 0 || sessionFilterVendors.size > 0 || sessionFilterModels.size > 0;
}


/** Computes the distinct editor/vendor/model values (with counts) present across the given sessions, used to render filter pills. */
function computeSessionFilterOptions(sessions: TodaySessionSummary[]): {
	editors: SessionFilterOption[];
	vendors: SessionFilterOption[];
	models: SessionFilterOption[];
	hydraFusionCount: number;
	nearContextLimitCount: number;
} {
	const editorCounts = new Map<string, number>();
	const vendorCounts = new Map<string, number>();
	const modelCounts = new Map<string, number>();
	let hydraFusionCount = 0;
	let nearContextLimitCount = 0;
	for (const s of sessions) {
		if (isSessionNearContextLimit(s)) { nearContextLimitCount++; }
		const editor = s.editor || 'unknown';
		editorCounts.set(editor, (editorCounts.get(editor) || 0) + 1);
		const vendorsInSession = new Set<string>();
		let hasHydra = false;
		for (const m of s.models) {
			modelCounts.set(m, (modelCounts.get(m) || 0) + 1);
			vendorsInSession.add(getModelBillingProvider(m));
			if (isHydraFusionModel(m)) { hasHydra = true; }
		}
		for (const v of vendorsInSession) { vendorCounts.set(v, (vendorCounts.get(v) || 0) + 1); }
		if (hasHydra) { hydraFusionCount++; }
	}
	const toSortedOptions = (counts: Map<string, number>, labelFn: (value: string) => string): SessionFilterOption[] =>
		Array.from(counts.entries())
			.map(([value, count]) => ({ value, label: labelFn(value), count }))
			.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	return {
		editors: toSortedOptions(editorCounts, v => v),
		vendors: toSortedOptions(vendorCounts, v => v),
		models: toSortedOptions(modelCounts, getModelDisplayName),
		hydraFusionCount,
		nearContextLimitCount,
	};
}

/** Renders the pill filter bar above the Recent Sessions table (Editor / Vendor / Model / HydraFusion). */
function buildSessionFilterBarHtml(sessions: TodaySessionSummary[]): string {
	if (!sessions || sessions.length === 0) { return ''; }
	const opts = computeSessionFilterOptions(sessions);
	if (opts.editors.length === 0 && opts.vendors.length === 0 && opts.models.length === 0) { return ''; }
	const groups: string[] = [];
	// Shown whenever any session nearly filled its window, or while the filter is on —
	// the "Show these sessions" insight action switches it on, and a pill that vanished
	// would leave the narrowed table with no visible reason for being narrow.
	if (opts.nearContextLimitCount > 0 || sessionFilterNearContextLimitOnly) {
		const isActive = sessionFilterNearContextLimitOnly;
		const pillTitle = escapeHtml(localizeFormat('usage.sessions.contextFill.nearLimitFilterTooltip', NEAR_LIMIT_PERCENT));
		const pillLabel = escapeHtml(localize('usage.sessions.contextFill.nearLimitFilter'));
		groups.push(`<div class="session-filter-group"><button type="button" class="session-filter-pill${isActive ? ' active' : ''}" data-filter-type="nearcontextlimit" data-filter-value="true" aria-pressed="${isActive}" title="${pillTitle}">${pillLabel} <span class="session-filter-pill-count">${opts.nearContextLimitCount}</span></button></div>`);
	}
	if (opts.hydraFusionCount > 0) {
		const isActive = sessionFilterHydraFusionOnly;
		groups.push(`<div class="session-filter-group"><button type="button" class="session-filter-pill session-filter-pill-hydrafusion${isActive ? ' active' : ''}" data-filter-type="hydrafusion" data-filter-value="true" aria-pressed="${isActive}" title="Show only sessions that used HydraFusion">⚡ HydraFusion <span class="session-filter-pill-count">${opts.hydraFusionCount}</span></button></div>`);
	}
	groups.push(buildFilterPillGroupHtml('Editor', 'editor', opts.editors, sessionFilterEditors));
	groups.push(buildFilterPillGroupHtml('Vendor', 'vendor', opts.vendors, sessionFilterVendors));
	groups.push(buildFilterPillGroupHtml('Model', 'model', opts.models, sessionFilterModels));
	const clearButton = hasActiveSessionFilters()
		? `<button type="button" id="sessions-filter-clear" class="session-filter-pill session-filter-pill-clear">✕ Clear filters</button>`
		: '';
	return `<div class="session-filter-bar">${groups.filter(Boolean).join('')}${clearButton}</div>`;
}

/** Handles a click on a filter pill or the "Clear filters" button; returns true if it was handled. */
function handleSessionFilterPillClick(target: HTMLElement): boolean {
	const clearButton = target.closest<HTMLElement>('#sessions-filter-clear');
	if (clearButton) {
		sessionFilterEditors.clear();
		sessionFilterVendors.clear();
		sessionFilterModels.clear();
		sessionFilterHydraFusionOnly = false;
		sessionFilterNearContextLimitOnly = false;
		return true;
	}
	const pill = target.closest<HTMLElement>('.session-filter-pill');
	if (!pill) { return false; }
	const filterType = pill.getAttribute('data-filter-type');
	const value = pill.getAttribute('data-filter-value');
	if (filterType === 'hydrafusion') {
		sessionFilterHydraFusionOnly = !sessionFilterHydraFusionOnly;
		return true;
	}
	if (filterType === 'nearcontextlimit') {
		sessionFilterNearContextLimitOnly = !sessionFilterNearContextLimitOnly;
		return true;
	}
	if (!value) { return false; }
	const targetSet = filterType === 'editor' ? sessionFilterEditors
		: filterType === 'vendor' ? sessionFilterVendors
		: filterType === 'model' ? sessionFilterModels
		: undefined;
	if (!targetSet) { return false; }
	if (targetSet.has(value)) { targetSet.delete(value); } else { targetSet.add(value); }
	return true;
}

/** Maps a toggleable column onto the data table; a hidden column keeps sorting if it was the sort key. */
function toSessionDataColumn(col: SessionColumnDef): DataTableColumn<TodaySessionSummary> {
	return {
		id: col.id,
		label: col.label,
		align: col.align,
		className: col.cellClass,
		hidden: !enabledSessionColumns.has(col.id),
		sortValue: col.sortValue,
		render: s => {
			const { html, title } = col.render(s);
			return { html: title !== undefined ? `<span title="${escapeHtml(title)}">${html}</span>` : html };
		},
	};
}

function sessionTitleCellHtml(s: TodaySessionSummary): string {
	const title = escapeHtml(s.title || 'Untitled session');
	const hydraFusionBadge = s.models.some(isHydraFusionModel)
		? '<span class="hydrafusion-session-badge" title="This session used HydraFusion" style="display:inline-block; margin-right:4px; padding:1px 5px; border:1px solid var(--vscode-badge-background, var(--accent-color)); border-radius:999px; background:var(--vscode-badge-background, var(--accent-color)); color:var(--vscode-badge-foreground, var(--bg-primary)); font-size:10px; font-weight:600; line-height:14px; vertical-align:middle;">HydraFusion</span>'
		: '';
	return `<a href="#" class="session-title-link" data-file="${escapeHtml(s.filePath || '')}" title="Open viewer for session &quot;${title}&quot;" style="color:var(--link-color, #4fc1ff); text-decoration:none; cursor:pointer;">${hydraFusionBadge}${title}</a>`;
}

/** Re-renders the sessions table after its rows changed (filters, lookback), back on its first page. */
function rerenderSessionsTableFromFirstPage(): void {
	setDataTableState(SESSIONS_TABLE_ID, { page: 1 });
	const container = document.getElementById('sessions-table-container');
	if (container) { setHtml(container, buildSessionsTableHtml(cachedTodaySessions)); }
}

function renderTodaySessionsTable(sessions: TodaySessionSummary[]): string {
	cachedTodaySessions = sessions;
	if (!sessions || sessions.length === 0) {
		const emptyMessage = sessionsLookback === 'today' ? 'No sessions recorded today yet.' : 'No sessions recorded in this period.';
		return `<div style="color: var(--text-secondary); font-size: 13px; padding: 16px;">${emptyMessage}</div>`;
	}
	return `<div id="sessions-table-container">${buildSessionsTableHtml(sessions)}</div>`;
}

function buildSessionsTableHtml(sessions: TodaySessionSummary[]): string {
	const filterBarHtml = buildSessionFilterBarHtml(sessions);
	const filtered = sessions.filter(sessionMatchesFilters);

	if (filtered.length === 0) {
		return `${filterBarHtml}<div style="color: var(--text-secondary); font-size: 13px; padding: 16px;">No sessions match the selected filters.</div>`;
	}

	const table = renderDataTable<TodaySessionSummary>({
		tableId: SESSIONS_TABLE_ID,
		ariaLabel: 'Recent Sessions',
		rows: filtered,
		columns: [
			{ id: 'rank', label: '#', className: 'session-col-rank', render: (_s, index) => String(index + 1) },
			{ id: 'title', label: 'Title', className: 'session-col-title', sortValue: s => s.title || '', render: s => ({ html: sessionTitleCellHtml(s) }) },
			...SESSION_COLUMN_DEFS.map(toSessionDataColumn),
		],
		initialSort: { columnId: 'interactions', direction: 'desc' },
		className: 'sessions-table',
	});
	return `${filterBarHtml}${table}`;
}

/** Builds the "Columns" toggle button and its checkbox dropdown for showing/hiding optional columns. */
function buildSessionColumnsMenuHtml(): string {
	const items = SESSION_COLUMN_DEFS.map(col => `
		<label style="display:flex; align-items:center; gap:6px; padding:4px 8px; font-size:12px; white-space:nowrap; cursor:pointer;">
			<input type="checkbox" data-column="${col.id}"${enabledSessionColumns.has(col.id) ? ' checked' : ''} />
			<span>${col.label}</span>
		</label>`).join('');
	return `
		<div class="columns-menu-wrap" style="position:relative;">
			<button id="sessions-columns-toggle" type="button" style="font-size:12px; padding:2px 8px; background:var(--vscode-dropdown-background, var(--bg-secondary)); color:var(--vscode-dropdown-foreground, var(--text-primary)); border:1px solid var(--border-subtle); border-radius:4px; cursor:pointer;">⚙ Columns</button>
			<div id="sessions-columns-menu" style="display:none; position:absolute; right:0; top:100%; margin-top:4px; z-index:20; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:6px; box-shadow:0 4px 10px var(--shadow-color); padding:4px 0; min-width:160px;">
				${items}
			</div>
		</div>`;
}

function setupSessionsTableHandlers(): void {
	// Delegate from the stable panel body so listeners survive lookback re-renders,
	// which replace the inner #sessions-table-container element.
	const body = document.getElementById('sessions-panel-body');
	if (!body) { return; }
	body.addEventListener('click', (e) => {
		// Handle session title link clicks → open in log viewer
		const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.session-title-link');
		if (link) {
			e.preventDefault();
			const file = link.getAttribute('data-file');
			if (file) {
				vscode.postMessage({ command: 'openSessionFile', file });
			}
			return;
		}
		// Handle filter pill / clear-filters clicks
		if (handleSessionFilterPillClick(e.target as HTMLElement)) {
			rerenderSessionsTableFromFirstPage();
		}
	});
	renderSessionsLookbackSelector();
	setupSessionColumnsMenu();
}

let _documentClickClosesColumnsMenu = false;

function setupSessionColumnsMenu(): void {
	const toggle = document.getElementById('sessions-columns-toggle');
	const menu = document.getElementById('sessions-columns-menu');
	if (!toggle || !menu) { return; }
	toggle.addEventListener('click', (e) => {
		e.stopPropagation();
		menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
	});
	menu.addEventListener('click', (e) => e.stopPropagation());
	menu.addEventListener('change', (e) => {
		const checkbox = e.target as HTMLInputElement;
		const columnId = checkbox.getAttribute('data-column') as SessionColumnId | null;
		if (!columnId) { return; }
		if (checkbox.checked) { enabledSessionColumns.add(columnId); } else { enabledSessionColumns.delete(columnId); }
		const container = document.getElementById('sessions-table-container');
		if (container) { setHtml(container, buildSessionsTableHtml(cachedTodaySessions)); }
		saveSessionColumnSettings();
	});
	// Attached once ever (not per re-render) and re-queries the live menu element on
	// each click, so it keeps working across full DOM rebuilds without leaking listeners.
	if (!_documentClickClosesColumnsMenu) {
		_documentClickClosesColumnsMenu = true;
		document.addEventListener('click', () => {
			const liveMenu = document.getElementById('sessions-columns-menu');
			if (liveMenu) { liveMenu.style.display = 'none'; }
		});
	}
}

function renderSessionsLookbackSelector(): void {
	const wrapper = document.getElementById('sessions-lookback-wrapper');
	if (!wrapper) { return; }
	wrapper.replaceChildren();
	const { wrapper: selectorWrapper } = createPeriodSelector({
		id: 'sessions-lookback',
		selected: sessionsLookback,
		disabled: ['allTime'],
		disabledTitle: 'All-time sessions are not loaded yet',
		label: '',
		onChange: (value) => {
			sessionsLookback = value as Period;
			setDataTableState(SESSIONS_TABLE_ID, { page: 1 });
			refreshSessionsPanelBody();
		},
	});
	wrapper.append(selectorWrapper);
	// A full re-render may have restored a non-today lookback whose data was
	// rendered from cache already; if the cache is empty, request it now.
	if (sessionsLookback !== 'today' && !recentSessionsCache[sessionsLookback]) {
		refreshSessionsPanelBody();
	}
}

/** Renders the sessions table for the current lookback, requesting host data when needed. */
function refreshSessionsPanelBody(): void {
	const body = document.getElementById('sessions-panel-body');
	if (!body) { return; }
	if (sessionsLookback === 'today') {
		setHtml(body, renderTodaySessionsTable(latestTodaySessions));
		return;
	}
	const cached = recentSessionsCache[sessionsLookback];
	if (cached) {
		setHtml(body, renderTodaySessionsTable(cached));
		return;
	}
	setHtml(body, `<div style="color: var(--text-secondary); font-size: 13px; padding: 16px;">Loading sessions for ${PERIOD_LABELS[sessionsLookback]}…</div>`);
	vscode.postMessage({ command: 'loadRecentSessions', period: sessionsLookback });
}

function handleRecentSessionsLoaded(message: any): void {
	const period = message.period as Period;
	if (!period) { return; }
	const sessions = Array.isArray(message.sessions)
		? message.sessions.filter((s: any) => s && typeof s === 'object' && typeof s.interactions === 'number') as TodaySessionSummary[]
		: [];
	recentSessionsCache[period] = sessions;
	if (sessionsLookback === period) {
		refreshSessionsPanelBody();
	}
}

function replaceRecentSessionsCache(raw: unknown): void {
	for (const period of RECENT_SESSION_PERIODS) {
		delete recentSessionsCache[period];
	}
	const buckets = sanitizeRecentSessionBuckets(raw);
	if (!buckets) { return; }
	for (const period of RECENT_SESSION_PERIODS) {
		recentSessionsCache[period] = buckets[period] as TodaySessionSummary[];
	}
}

function unionFill(map: { [key: string]: number }, keys: string[]): { [key: string]: number } {
	const result: { [key: string]: number } = { ...map };
	for (const k of keys) {
		if (!(k in result)) { result[k] = 0; }
	}
	return result;
}

function coerceNumber(value: any): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function sanitizeModeUsage(mode: any): ModeUsage {
	const m = (mode && typeof mode === 'object') ? mode : {};
	return {
		ask: coerceNumber(m.ask),
		edit: coerceNumber(m.edit),
		agent: coerceNumber(m.agent),
		plan: coerceNumber(m.plan),
		customAgent: coerceNumber(m.customAgent),
		cli: coerceNumber(m.cli),
		cliApp: coerceNumber(m.cliApp),
		claudeDesktop: coerceNumber(m.claudeDesktop),
		claudeVsCode: coerceNumber(m.claudeVsCode),
	};
}

function sanitizeContextRefs(refs: any): ContextReferenceUsage {
	const r = (refs && typeof refs === 'object') ? refs : {};
	return {
		file: coerceNumber(r.file),
		selection: coerceNumber(r.selection),
		implicitSelection: coerceNumber(r.implicitSelection),
		symbol: coerceNumber(r.symbol),
		codebase: coerceNumber(r.codebase),
		workspace: coerceNumber(r.workspace),
		terminal: coerceNumber(r.terminal),
		vscode: coerceNumber(r.vscode),
		terminalLastCommand: coerceNumber(r.terminalLastCommand),
		terminalSelection: coerceNumber(r.terminalSelection),
		clipboard: coerceNumber(r.clipboard),
		changes: coerceNumber(r.changes),
		outputPanel: coerceNumber(r.outputPanel),
		problemsPanel: coerceNumber(r.problemsPanel),
		pullRequest: coerceNumber(r.pullRequest),
		byKind: r.byKind ?? {},
		copilotInstructions: coerceNumber(r.copilotInstructions),
		agentsMd: coerceNumber(r.agentsMd),
		byPath: r.byPath ?? {},
	};
}

/**
 * Validated pass-through for a period's context-window aggregate. Numbers are
 * coerced and the model list / tier map are rebuilt so an untrusted payload
 * cannot smuggle extra fields into the render path.
 */
function sanitizePeriod(period: any): UsageAnalysisPeriod {
	const p = (period && typeof period === 'object') ? period : {};
	const toolCalls = (p.toolCalls && typeof p.toolCalls === 'object') ? p.toolCalls : {};
	const mcpTools = (p.mcpTools && typeof p.mcpTools === 'object') ? p.mcpTools : {};
	return {
		sessions: coerceNumber(p.sessions),
		modeUsage: sanitizeModeUsage(p.modeUsage),
		contextReferences: sanitizeContextRefs(p.contextReferences),
		toolCalls: {
			total: coerceNumber(toolCalls.total),
			byTool: toolCalls.byTool ?? {},
			...sanitizeToolOutcomeMaps(toolCalls),
		},
		mcpTools: {
			total: coerceNumber(mcpTools.total),
			byServer: mcpTools.byServer ?? {},
			byTool: mcpTools.byTool ?? {},
			...sanitizeMcpOutcomeMaps(mcpTools),
		},
		modelSwitching: {
			modelsPerSession: [],
			totalSessions: 0,
			averageModelsPerSession: 0,
			maxModelsPerSession: 0,
			minModelsPerSession: 0,
			switchingFrequency: 0,
			standardModels: [],
			premiumModels: [],
			unknownModels: [],
			mixedTierSessions: 0,
			lowCostModels: [],
			mediumCostModels: [],
			highCostModels: [],
			mixedCostSessions: 0,
			standardRequests: 0,
			premiumRequests: 0,
			lowCostRequests: 0,
			mediumCostRequests: 0,
			highCostRequests: 0,
			unknownRequests: 0,
			totalRequests: 0,
			...(p.modelSwitching ?? {}),
		},
		thinkingEffortUsage: p.thinkingEffortUsage,
		modelEfficiency: p.modelEfficiency,
		contextWindow: sanitizeContextWindow(p.contextWindow),
		contextPressure: sanitizeContextPressure(p.contextPressure),
	};
}

function sanitizeInsights(rawInsights: any[]): EvaluatedInsight[] {
	return rawInsights
		.filter((i: any) => i && typeof i === 'object' && typeof i.id === 'string')
		.map((i: any): EvaluatedInsight => ({
			id: String(i.id),
			category: typeof i.category === 'string' ? i.category : 'general',
			severity: (['tip', 'opportunity', 'celebration'].includes(i.severity) ? i.severity : 'tip') as InsightSeverity,
			title: typeof i.title === 'string' ? i.title : '',
			body: typeof i.body === 'string' ? i.body : '',
			actionLabel: typeof i.actionLabel === 'string' ? i.actionLabel : undefined,
			actionCommand: typeof i.actionCommand === 'string' ? i.actionCommand : undefined,
			secondaryActionLabel: typeof i.secondaryActionLabel === 'string' ? i.secondaryActionLabel : undefined,
			secondaryActionCommand: typeof i.secondaryActionCommand === 'string' ? i.secondaryActionCommand : undefined,
			status: (['new', 'seen', 'dismissed', 'snoozed', 'done'].includes(i.status) ? i.status : 'new') as InsightStatus,
			allowToast: !!i.allowToast,
		}));
}

const CORRECTION_MOMENT_TYPES: CorrectionMomentType[] = ['user-correction', 'edit-retry', 'edit-self-correction', 'tool-error', 'agent-self-correction'];
const CORRECTION_FILTERS: CorrectionFilter[] = [...CORRECTION_MOMENT_TYPES, 'escalated'];

function sanitizeCorrectionMoment(raw: any): CorrectionMoment | null {
	if (!raw || typeof raw !== 'object') { return null; }
	if (!CORRECTION_MOMENT_TYPES.includes(raw.type) || typeof raw.snippet !== 'string') { return null; }
	return {
		type: raw.type,
		turnNumber: typeof raw.turnNumber === 'number' ? raw.turnNumber : 0,
		timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null,
		snippet: raw.snippet,
		tool: typeof raw.tool === 'string' ? raw.tool : undefined,
		file: typeof raw.file === 'string' ? raw.file : undefined,
		retried: raw.retried === true ? true : undefined,
		matchedPattern: typeof raw.matchedPattern === 'string' ? raw.matchedPattern : undefined,
		intensity: raw.intensity === 'strong' ? 'strong' : undefined,
		escalated: raw.escalated === true ? true : undefined,
		corroboratedBy: ['tool-error', 'edit-retry', 'user-correction'].includes(raw.corroboratedBy) ? raw.corroboratedBy : undefined,
	};
}

function sanitizeCorrectionCounts(raw: any): CorrectionCounts {
	const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
	return {
		userCorrections: num(raw?.userCorrections),
		editRetries: num(raw?.editRetries),
		editSelfCorrections: num(raw?.editSelfCorrections),
		toolErrors: num(raw?.toolErrors),
		toolErrorsRetried: num(raw?.toolErrorsRetried),
		agentSelfCorrections: num(raw?.agentSelfCorrections),
		escalatedUserCorrections: num(raw?.escalatedUserCorrections),
	};
}

function sanitizeCorrectionSession(raw: any): CorrectionSessionEntry | null {
	if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string' || !Array.isArray(raw.moments)) { return null; }
	const moments = raw.moments.map(sanitizeCorrectionMoment).filter((m: CorrectionMoment | null): m is CorrectionMoment => m !== null);
	if (moments.length === 0) { return null; }
	return {
		file: raw.file,
		title: typeof raw.title === 'string' ? raw.title : null,
		lastInteraction: typeof raw.lastInteraction === 'string' ? raw.lastInteraction : null,
		moments,
		totalMoments: typeof raw.totalMoments === 'number' && isFinite(raw.totalMoments)
			? Math.max(moments.length, raw.totalMoments)
			: moments.length,
	};
}

function sanitizeCorrectionRepoGroup(raw: any): CorrectionRepoGroup | null {
	if (!raw || typeof raw !== 'object' || typeof raw.repository !== 'string' || !Array.isArray(raw.sessions)) { return null; }
	const sessions = raw.sessions.map(sanitizeCorrectionSession).filter((s: CorrectionSessionEntry | null): s is CorrectionSessionEntry => s !== null);
	if (sessions.length === 0) { return null; }
	return {
		repository: raw.repository,
		sessions,
		counts: sanitizeCorrectionCounts(raw.counts),
		sessionsWithMoments: typeof raw.sessionsWithMoments === 'number' ? raw.sessionsWithMoments : sessions.length,
	};
}

function sanitizeCorrectionReport(raw: any): CorrectionReport | null {
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.repos)) { return null; }
	const repos = raw.repos.map(sanitizeCorrectionRepoGroup).filter((r: CorrectionRepoGroup | null): r is CorrectionRepoGroup => r !== null);
	if (repos.length === 0) { return null; }
	return {
		sessionsPerRepo: typeof raw.sessionsPerRepo === 'number' ? raw.sessionsPerRepo : 25,
		repos,
		counts: sanitizeCorrectionCounts(raw.counts),
		sessionsWithMoments: typeof raw.sessionsWithMoments === 'number' ? raw.sessionsWithMoments : repos.reduce((n: number, g: CorrectionRepoGroup) => n + g.sessionsWithMoments, 0),
	};
}

function sanitizeRepeatedTaskCluster(raw: any): RepeatedTaskCluster | null {
	if (!raw || typeof raw !== 'object') { return null; }
	if (typeof raw.representativePrompt !== 'string' || typeof raw.sessionCount !== 'number' || !Array.isArray(raw.sessions)) { return null; }
	const sessions: RepeatedTaskSessionRef[] = raw.sessions
		.filter((s: any) => s && typeof s === 'object' && typeof s.file === 'string')
		.map((s: any): RepeatedTaskSessionRef => ({
			file: s.file,
			title: typeof s.title === 'string' ? s.title : null,
			lastInteraction: typeof s.lastInteraction === 'string' ? s.lastInteraction : null,
			repository: typeof s.repository === 'string' ? s.repository : undefined,
		}));
	if (sessions.length === 0) { return null; }
	return {
		representativePrompt: raw.representativePrompt,
		// Derive from the sanitized session list so the UI count can never
		// disagree with it (and NaN/float counts are impossible).
		sessionCount: sessions.length,
		repositories: Array.isArray(raw.repositories) ? raw.repositories.filter((r: unknown) => typeof r === 'string') : [],
		sessions,
		sharedKeywords: Array.isArray(raw.sharedKeywords) ? raw.sharedKeywords.filter((k: unknown) => typeof k === 'string') : [],
	};
}

function sanitizeRepeatedTaskReport(raw: any): RepeatedTaskReport | null {
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.clusters)) { return null; }
	const clusters = raw.clusters.map(sanitizeRepeatedTaskCluster).filter((c: RepeatedTaskCluster | null): c is RepeatedTaskCluster => c !== null);
	if (clusters.length === 0) { return null; }
	return {
		minClusterSize: typeof raw.minClusterSize === 'number' ? raw.minClusterSize : 2,
		sessionsScanned: typeof raw.sessionsScanned === 'number' ? raw.sessionsScanned : 0,
		clusters,
	};
}

function _sanitizeCurationAnalysis(rawCa: unknown): ToolCurationAnalysis | null {
	if (!rawCa || typeof rawCa !== 'object') { return null; }
	const ca = rawCa as Partial<ToolCurationAnalysis>;
	return {
		windowDays: typeof ca.windowDays === 'number' ? ca.windowDays : 30,
		availableTools: Array.isArray(ca.availableTools) ? ca.availableTools : [],
		usedTools: Array.isArray(ca.usedTools) ? ca.usedTools : [],
		unusedTools: Array.isArray(ca.unusedTools) ? ca.unusedTools : [],
		underusedMcpServers: Array.isArray(ca.underusedMcpServers) ? ca.underusedMcpServers : [],
		underusedAgentPlugins: Array.isArray(ca.underusedAgentPlugins) ? ca.underusedAgentPlugins : [],
		estimatedPromptBloat: ca.estimatedPromptBloat && typeof ca.estimatedPromptBloat === 'object'
			? ca.estimatedPromptBloat
			: { totalTokens: 0, byServer: {} },
		recommendations: Array.isArray(ca.recommendations) ? ca.recommendations : [],
	};
}

/** Normalize an optional memory-files hygiene analysis (compact webview projection: counts/rollup scalars only) so rendering never throws on a partial payload. */
function _sanitizeMemoryFilesAnalysis(raw: unknown): MemoryFilesAnalysisView | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const ma = raw as Partial<MemoryFilesAnalysisView>;
	if (!Array.isArray(ma.byWorkspace)) { return null; }
	return {
		staleDays: typeof ma.staleDays === 'number' ? ma.staleDays : 90,
		largeFileBytes: typeof ma.largeFileBytes === 'number' ? ma.largeFileBytes : 10 * 1024,
		byWorkspace: ma.byWorkspace.map(ws => ({
			workspaceHash: ws?.workspaceHash,
			workspaceName: ws?.workspaceName,
			repoCount: typeof ws?.repoCount === 'number' ? ws.repoCount : 0,
			sessionCount: typeof ws?.sessionCount === 'number' ? ws.sessionCount : 0,
			userCount: typeof ws?.userCount === 'number' ? ws.userCount : 0,
			totalBytes: typeof ws?.totalBytes === 'number' ? ws.totalBytes : 0,
			newestMtimeMs: typeof ws?.newestMtimeMs === 'number' ? ws.newestMtimeMs : null,
			staleFileCount: typeof ws?.staleFileCount === 'number' ? ws.staleFileCount : 0,
		})),
		totalFiles: typeof ma.totalFiles === 'number' ? ma.totalFiles : 0,
		totalBytes: typeof ma.totalBytes === 'number' ? ma.totalBytes : 0,
		staleFileCount: typeof ma.staleFileCount === 'number' ? ma.staleFileCount : 0,
		largeFileCount: typeof ma.largeFileCount === 'number' ? ma.largeFileCount : 0,
	};
}

/** Sanitize the optional correction/repeated-task reports onto the stats object. */
function sanitizeOptionalReports(sanitized: UsageAnalysisStats, raw: any): void {
	if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'correctionReport')) {
		sanitized.correctionReport = sanitizeCorrectionReport(raw.correctionReport);
	}
	sanitized.repeatedTasks = sanitizeRepeatedTaskReport(raw.repeatedTasks);
	sanitized.autoCompactionsLast7Days = sanitizeAutomaticCompactions(raw?.autoCompactionsLast7Days);
}

function applySessionSummaries(sanitized: UsageAnalysisStats, raw: any): void {
	if (Array.isArray(raw.todaySessions)) {
		sanitized.todaySessions = raw.todaySessions.filter(
			(session: any) => session && typeof session === 'object' && typeof session.interactions === 'number'
		) as TodaySessionSummary[];
	}
	const recentSessions = sanitizeRecentSessionBuckets(raw.recentSessions);
	if (recentSessions) {
		sanitized.recentSessions = recentSessions as {
			last7: TodaySessionSummary[];
			last30: TodaySessionSummary[];
			currentMonth: TodaySessionSummary[];
		};
	}
	if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'claudeDesktopCoverage')) {
		sanitized.claudeDesktopCoverage = sanitizeClaudeDesktopCoverage(raw.claudeDesktopCoverage);
	}
}

/** Validate the Claude Desktop coverage counts; returns null for any non-numeric or incoherent payload. */
function sanitizeClaudeDesktopCoverage(raw: any): UsageAnalysisStats['claudeDesktopCoverage'] {
	if (!raw || typeof raw !== 'object') { return null; }
	const known = raw.knownSessions;
	const withTranscript = raw.withTranscript;
	const missing = raw.missingTranscript;
	const valid = [known, withTranscript, missing].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
	if (!valid || withTranscript + missing !== known) { return null; }
	return { knownSessions: known, withTranscript, missingTranscript: missing };
}

/** Pass through the memory-files hygiene analysis (compact `MemoryFilesAnalysisView` rollup:
 * counts/rollup scalars only — no paths and no per-file metadata) onto sanitized stats.
 * Only assigns when the raw payload explicitly includes the key — omitting it (e.g. a partial/silent
 * refresh) must not clobber a previously-cached value, so we don't default to `null` here. Whether the
 * field was explicitly `null` (all files gone) vs. omitted (no change) is resolved in `handleUpdateStats`. */
function applyMemoryFilesAnalysis(sanitized: UsageAnalysisStats, raw: any): void {
	if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'memoryFilesAnalysis')) {
		sanitized.memoryFilesAnalysis = _sanitizeMemoryFilesAnalysis(raw.memoryFilesAnalysis);
	}
	if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'serverMemoriesAnalysis')) {
		sanitized.serverMemoriesAnalysis = _sanitizeServerMemoriesAnalysis(raw.serverMemoriesAnalysis);
	}
}

function sanitizeStats(raw: any): UsageAnalysisStats | null {
	if (!raw || typeof raw !== 'object') {
		traceCurationOnce('sanitize-invalid-root', 'sanitizeStats.invalidRoot');
		return null;
	}

	try {
		const sanitized: UsageAnalysisStats = {
			today: sanitizePeriod(raw.today),
			last30Days: sanitizePeriod(raw.last30Days),
			month: sanitizePeriod(raw.month),
			lastMonth: sanitizePeriod(raw.lastMonth),
			lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : '',
			backendConfigured: !!raw.backendConfigured,
			readinessAvailable: raw.readinessAvailable === true,
			locale: typeof raw.locale === 'string' ? raw.locale : undefined,
			currentWorkspacePaths: Array.isArray(raw.currentWorkspacePaths)
				? raw.currentWorkspacePaths.filter((p: unknown) => typeof p === 'string') as string[]
				: undefined,
			suppressedUnknownTools: Array.isArray(raw.suppressedUnknownTools)
				? raw.suppressedUnknownTools.filter((t: unknown) => typeof t === 'string') as string[]
				: undefined,
			toolCallsByEditor: sanitizeToolCallsByEditor(raw.toolCallsByEditor),
		};

		// Sanitize customizationMatrix (avoid pass-through of untrusted nested fields)
		const safeMatrix = sanitizeCustomizationMatrix(raw.customizationMatrix);
		if (safeMatrix) {
			// sanitizeCustomizationMatrix returns WorkspaceCustomizationMatrix from types.ts;
			// the local WorkspaceCustomizationMatrix interface is structurally identical.
			sanitized.customizationMatrix = safeMatrix as WorkspaceCustomizationMatrix;
		}

		// Validated pass-through for missedPotential (array of objects)
		if (Array.isArray(raw.missedPotential)) {
			sanitized.missedPotential = raw.missedPotential.filter(
				(w: any) => w && typeof w === 'object' && typeof w.workspacePath === 'string'
			) as MissedPotentialWorkspace[];
		}

		applySessionSummaries(sanitized, raw);

		// Sanitize insights
		if (Array.isArray(raw.insights)) {
			sanitized.insights = sanitizeInsights(raw.insights);
		}

		sanitizeOptionalReports(sanitized, raw);

		// Pass through curationAnalysis (already structured server-side).
		// Normalize required array/object fields so rendering paths don't throw on partial payloads.
		const curationAnalysis = _sanitizeCurationAnalysis(raw.curationAnalysis);
		if (curationAnalysis) {
			sanitized.curationAnalysis = curationAnalysis;
			traceCuration('sanitizeStats.curation.present', {
				availableTools: curationAnalysis.availableTools.length,
				unusedTools: curationAnalysis.unusedTools.length,
				unusedServers: curationAnalysis.underusedMcpServers.filter(s => s && s.usedToolCount === 0).length,
			});
		} else {
			traceCurationOnce('sanitize-no-curation', 'sanitizeStats.curation.missing');
		}

		// Pass through the memory-files hygiene analysis (compact MemoryFilesAnalysisView
		// rollup: counts/rollup scalars only — no paths and no per-file metadata).
		applyMemoryFilesAnalysis(sanitized, raw);

		// Pass through the Copilot API quota balance and current-month billing costs.
		// Without this, periodic updateStats refreshes rebuild the stats object without
		// these fields, so the "Copilot Billing Coverage" section disappears after the
		// first refresh even though the extension still has the data.
		applyBillingFields(sanitized, raw);

		return sanitized;
	} catch (error) {
		traceCurationOnce('sanitize-error', 'sanitizeStats.error', {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function updateWorktreeControls(): void {
	const controlsEl = document.getElementById("worktree-controls");
	if (controlsEl) { setHtml(controlsEl, renderWorktreeControls()); }
}

function updateWorktreeResults(): void {
	const resultsEl = document.getElementById("worktree-results");
	if (resultsEl) { setHtml(resultsEl, renderWorktreeResults()); }
}

function updateWorktreeProgressArea(): void {
	const el = document.getElementById("worktree-progress-area");
	if (el) { setHtml(el, renderWorktreeProgress()); }
}

function scheduleWorktreeResultsRender(): void {
	if (worktreeRenderPending) { return; }
	worktreeRenderPending = true;
	requestAnimationFrame(() => {
		worktreeRenderPending = false;
		updateWorktreeResults();
	});
}

function addWorktreeRootFromInput(): void {
	const input = document.getElementById("worktree-root-input") as HTMLInputElement | null;
	const value = input?.value.trim();
	if (!value) { return; }
	if (!worktreeRoots.some((r) => r.toLowerCase() === value.toLowerCase())) {
		worktreeRoots.push(value);
	}
	if (input) { input.value = ""; }
	updateWorktreeControls();
}

function startWorktreeScan(): void {
	if (worktreeRoots.length === 0 || worktreeScanInProgress || worktreeCleanupInProgress) { return; }
	worktreeScanInProgress = true;
	worktreeResults = [];
	worktreeBackgroundScanMeta = null;
	worktreeScanError = null;
	worktreeScanStatus = { root: "", checked: 0, total: 0, foundCount: 0, elapsedMs: 0 };
	worktreeCleanupLog = [];
	worktreeRetryState.clear();
	updateWorktreeControls();
	updateWorktreeResults();
	vscode.postMessage({ command: "scanWorktrees", rootPaths: worktreeRoots });
}

/**
 * Kicks off the "clean up pushed worktrees" flow. The actual confirmation is a native VS Code
 * modal shown by the extension (see diagHandleCleanupPushedWorktrees) — this only sends the
 * candidate list and waits for cleanupStarted/cleanupDeclined to know the outcome. Pass
 * `repoLabel` to scope the cleanup to one repository's row; omit it for the global card.
 */
function startWorktreeCleanup(repoLabel?: string): void {
	if (worktreeCleanupInProgress || worktreeCleanupConfirmPending || worktreeScanInProgress) { return; }
	const targets = getCleanupCandidates(repoLabel);
	if (targets.length === 0) { return; }
	worktreeCleanupConfirmPending = true;
	updateWorktreeResults();
	vscode.postMessage({
		command: "cleanupPushedWorktrees",
		worktrees: targets.map((w) => ({ path: w.path, branch: w.branch, repoLabel: w.repoLabel })),
		repoLabel,
	});
}

function _handleWorktreeActionButtonClick(target: HTMLElement): boolean {
	if (target.id === "btn-browse-worktree-root") {
		vscode.postMessage({ command: "pickWorktreeRoot" });
		return true;
	}
	if (target.id === "btn-add-worktree-root") {
		addWorktreeRootFromInput();
		return true;
	}
	if (target.id === "btn-scan-worktrees") {
		startWorktreeScan();
		return true;
	}
	if (target.id === "btn-cancel-worktree-scan") {
		vscode.postMessage({ command: "cancelWorktreeScan" });
		return true;
	}
	if (target.id === "btn-cleanup-pushed-worktrees") {
		startWorktreeCleanup();
		return true;
	}
	if (target.id === "btn-cancel-cleanup") {
		vscode.postMessage({ command: "cancelCleanupPushedWorktrees" });
		return true;
	}
	const repoCleanupBtn = target.closest(".worktree-repo-cleanup-btn") as HTMLElement | null;
	if (repoCleanupBtn) {
		const repo = decodeURIComponent(repoCleanupBtn.getAttribute("data-repo") || "");
		if (repo) { startWorktreeCleanup(repo); }
		return true;
	}
	return false;
}

function _handleWorktreeRootsListClick(target: HTMLElement): boolean {
	if (target.closest("#btn-toggle-worktree-roots")) {
		worktreeRootsExpanded = !worktreeRootsExpanded;
		updateWorktreeControls();
		return true;
	}
	if (target.classList.contains("worktree-remove-root")) {
		const idx = Number(target.getAttribute("data-index"));
		if (!isNaN(idx)) {
			worktreeRoots.splice(idx, 1);
			updateWorktreeControls();
		}
		return true;
	}
	return false;
}

function _handleWorktreeRowLinkClick(event: MouseEvent, target: HTMLElement): boolean {
	const openEditorBtn = target.closest(".worktree-open-editor-btn") as HTMLElement | null;
	if (openEditorBtn) {
		event.preventDefault();
		const p = decodeURIComponent(openEditorBtn.getAttribute("data-path") || "");
		if (p) { vscode.postMessage({ command: "openWorktreeInEditor", path: p }); }
		return true;
	}
	const revealLink = target.closest(".worktree-reveal-link, .worktree-reveal-btn") as HTMLElement | null;
	if (revealLink) {
		event.preventDefault();
		const p = decodeURIComponent(revealLink.getAttribute("data-path") || "");
		if (p) { vscode.postMessage({ command: "revealPath", path: p }); }
		return true;
	}
	const deleteLink = target.closest(".worktree-delete-link, .worktree-delete-btn") as HTMLElement | null;
	if (deleteLink) {
		event.preventDefault();
		const p = decodeURIComponent(deleteLink.getAttribute("data-path") || "");
		const branch = decodeURIComponent(deleteLink.getAttribute("data-branch") || "");
		const repoLabel = decodeURIComponent(deleteLink.getAttribute("data-repo") || "");
		const pushed = deleteLink.getAttribute("data-pushed") || "?";
		// The actual confirmation is a native VS Code modal shown by the extension — it owns the
		// "git worktree remove" call and any dirty-tree force-confirmation, not this webview.
		if (p) { vscode.postMessage({ command: "deleteWorktree", path: p, branch, repoLabel, pushed }); }
		return true;
	}
	return false;
}

function _handleWorktreeRepoRowClick(target: HTMLElement): boolean {
	const repoRow = target.closest(".worktree-repo-row") as HTMLElement | null;
	if (!repoRow) { return false; }
	const repo = repoRow.getAttribute("data-repo") ?? "";
	if (worktreeExpandedRepos.has(repo)) { worktreeExpandedRepos.delete(repo); }
	else { worktreeExpandedRepos.add(repo); }
	updateWorktreeResults();
	return true;
}

function handleWorktreeTabClick(event: MouseEvent): void {
	const target = event.target as HTMLElement | null;
	if (!target) { return; }
	if (_handleWorktreeActionButtonClick(target)) { return; }
	if (_handleWorktreeRootsListClick(target)) { return; }
	if (_handleWorktreeRowLinkClick(event, target)) { return; }
	_handleWorktreeRepoRowClick(target);
}

function setupWorktreesHandlers(): void {
	const tabEl = document.getElementById("tab-panel-worktrees");
	if (!tabEl) { return; }
	tabEl.addEventListener("click", handleWorktreeTabClick);
	tabEl.addEventListener("keydown", (event) => {
		const target = event.target as HTMLElement | null;
		if (target?.id === "worktree-root-input" && (event as KeyboardEvent).key === "Enter") {
			event.preventDefault();
			addWorktreeRootFromInput();
		}
	});
}

function sanitizeWorktreeResult(item: unknown): WorktreeResult {
	const w = (item ?? {}) as Record<string, unknown>;
	const pushedRaw = String(w.pushed ?? "?");
	const pushed: WorktreeResult["pushed"] = pushedRaw === "yes" || pushedRaw === "no" ? pushedRaw : "?";
	return {
		path: String(w.path ?? ""),
		repoLabel: String(w.repoLabel ?? "Unknown"),
		branch: String(w.branch ?? "?"),
		lastCommit: String(w.lastCommit ?? "?"),
		lastCommitDate: w.lastCommitDate ? String(w.lastCommitDate) : null,
		pushed,
		files: numField(w.files),
		folders: numField(w.folders),
		bytes: numField(w.bytes),
	};
}

function handleWorktreeRootPicked(message: any): void {
	if (!message.folderPath) { return; }
	const folderPath = String(message.folderPath);
	if (!worktreeRoots.some((r) => r.toLowerCase() === folderPath.toLowerCase())) {
		worktreeRoots.push(folderPath);
	}
	updateWorktreeControls();
}

/**
 * Merge auto-discovered scan roots (from known session folders + session workspace paths,
 * computed by the extension after the background session load) into the editable roots list.
 * Case-insensitive dedup, existing order preserved. Skipped while a scan is running so the
 * list is not mutated mid-scan.
 */
function handleWorktreeRootsDiscovered(message: any): void {
	if (worktreeScanInProgress || !Array.isArray(message.roots)) { return; }
	let added = false;
	for (const raw of message.roots) {
		if (typeof raw !== "string") { continue; }
		const root = raw.trim();
		if (!root) { continue; }
		if (!worktreeRoots.some((r) => r.toLowerCase() === root.toLowerCase())) {
			worktreeRoots.push(root);
			added = true;
		}
	}
	if (added) { updateWorktreeControls(); }
}

function handleWorktreeScanStarted(): void {
	worktreeScanInProgress = true;
	worktreeResults = [];
	worktreeScanError = null;
	worktreeScanStatus = { root: "", checked: 0, total: 0, foundCount: 0, elapsedMs: 0 };
	updateWorktreeControls();
	updateWorktreeResults();
}

function handleWorktreeScanRootStarted(message: any): void {
	worktreeScanStatus = { ...worktreeScanStatus, root: String(message.root || ""), checked: 0, total: 0, phase: "walking", dirsScanned: 0 };
	updateWorktreeProgressArea();
}

function handleWorktreeScanWalkProgress(message: any): void {
	worktreeScanStatus = {
		...worktreeScanStatus,
		root: String(message.root ?? worktreeScanStatus.root),
		phase: "walking",
		dirsScanned: numField(message.dirsScanned),
		elapsedMs: numField(message.elapsedMs),
	};
	updateWorktreeProgressArea();
}

function handleWorktreeScanRootMarkersFound(message: any): void {
	worktreeScanStatus = { ...worktreeScanStatus, total: numField(message.count), phase: "checking" };
	updateWorktreeProgressArea();
}

function handleWorktreeScanRootSkipped(message: any): void {
	worktreeScanError = `Skipped "${message.root}": ${message.reason || "not accessible"}`;
	updateWorktreeControls();
}

function handleWorktreeScanProgress(message: any): void {
	worktreeScanStatus = {
		root: String(message.root ?? worktreeScanStatus.root),
		checked: numField(message.checked),
		total: message.total !== undefined ? numField(message.total) : worktreeScanStatus.total,
		foundCount: numField(message.foundCount),
		elapsedMs: numField(message.elapsedMs),
	};
	updateWorktreeProgressArea();
}

function handleWorktreeFound(message: any): void {
	if (!message.worktree) { return; }
	worktreeResults.push(sanitizeWorktreeResult(message.worktree));
	scheduleWorktreeResultsRender();
}

/** Remove a worktree row after the extension has confirmed and run "git worktree remove". */
function handleWorktreeDeleted(message: any): void {
	const targetPath = String(message.path ?? "");
	if (!targetPath) { return; }
	const idx = worktreeResults.findIndex((w) => w.path === targetPath);
	if (idx === -1) { return; }
	worktreeResults.splice(idx, 1);
	updateWorktreeResults();
}

/** The extension's confirm modal was dismissed/declined — re-enable the cleanup button. */
function handleCleanupDeclined(): void {
	worktreeCleanupConfirmPending = false;
	updateWorktreeResults();
}

function handleCleanupStarted(message: any): void {
	worktreeCleanupConfirmPending = false;
	worktreeCleanupInProgress = true;
	worktreeCleanupStatus = { processed: 0, total: numField(message.total) };
	worktreeCleanupLog = [];
	worktreeRetryState.clear();
	updateWorktreeResults();
}

function handleCleanupWorktreeResult(message: any): void {
	worktreeCleanupStatus = { processed: numField(message.processed), total: numField(message.total) };
	const rawStatus = message.status;
	const status: WorktreeCleanupOutcome = rawStatus === "deleted" || rawStatus === "skipped" ? rawStatus : "error";
	const entryPath = String(message.path ?? "");
	const diagnostics = sanitizeWorktreeCleanupDiagnostics(message.diagnostics);
	// The size comes from the scan's already-enriched row, not a second recursive disk walk per failed worktree.
	const scanned = worktreeResults.find((w) => w.path === entryPath);
	if (diagnostics && diagnostics.sizeBytes === undefined && scanned && !isWorktreePending(scanned)) { diagnostics.sizeBytes = knownBytes(scanned); }
	worktreeCleanupLog.push({
		path: entryPath,
		branch: String(message.branch ?? "?"),
		repoLabel: String(message.repoLabel ?? ""),
		status,
		reason: typeof message.reason === "string" ? message.reason : undefined,
		diagnostics,
	});
	updateWorktreeResults();
}

/** Normalizes the optional diagnostics payload; a missing/!object value yields undefined (no detail line). */
function sanitizeWorktreeCleanupDiagnostics(raw: unknown): WorktreeCleanupDiagnostics | undefined {
	if (!raw || typeof raw !== "object") { return undefined; }
	const d = raw as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	return {
		lastModified: str(d.lastModified),
		lastCommitDate: str(d.lastCommitDate),
		lastCommitRelative: str(d.lastCommitRelative),
		remoteBranch: str(d.remoteBranch),
		remoteStatus: d.remoteStatus === "tracked" || d.remoteStatus === "gone" || d.remoteStatus === "none" ? d.remoteStatus : undefined,
		ahead: num(d.ahead),
		behind: num(d.behind),
		modifiedFiles: num(d.modifiedFiles),
		untrackedFiles: num(d.untrackedFiles),
		sizeBytes: num(d.sizeBytes),
	};
}

/** The extension passed its confirmation and began removing a worktree from the cleanup report. */
function handleWorktreeDeleteStarted(message: any): void {
	const p = String(message.path ?? "");
	if (!p) { return; }
	worktreeRetryState.set(p, { status: "running" });
	updateWorktreeResults();
}

/** Final outcome of a "Delete anyway…" retry; "cancelled" (modal dismissed) just clears the state. */
function handleWorktreeDeleteResult(message: any): void {
	const p = String(message.path ?? "");
	if (!p) { return; }
	// A final result only means something for a retry still in flight; scan/cleanup clear the map, so a late result must not repopulate it.
	if ((message.status === "deleted" || message.status === "error") && worktreeRetryState.get(p)?.status !== "running") { return; }
	if (message.status === "deleted") {
		worktreeRetryState.set(p, { status: "deleted" });
	} else if (message.status === "error") {
		worktreeRetryState.set(p, { status: "error", reason: typeof message.reason === "string" ? message.reason : localize("usage.worktreeCleanup.unknownError") });
	} else {
		worktreeRetryState.delete(p);
	}
	updateWorktreeResults();
}

function handleCleanupComplete(): void {
	worktreeCleanupInProgress = false;
	updateWorktreeResults();
}

function handleCleanupCancelled(): void {
	worktreeCleanupInProgress = false;
	worktreeCleanupConfirmPending = false;
	updateWorktreeResults();
}

function handleWorktreeEnrichStarted(message: any): void {
	worktreeScanStatus = { ...worktreeScanStatus, phase: "enriching", enriched: 0, enrichTotal: numField(message.total), elapsedMs: numField(message.elapsedMs) };
	updateWorktreeProgressArea();
}

function handleWorktreeEnrichProgress(message: any): void {
	worktreeScanStatus = { ...worktreeScanStatus, phase: "enriching", enriched: numField(message.enriched), enrichTotal: numField(message.total), elapsedMs: numField(message.elapsedMs) };
	updateWorktreeProgressArea();
}

/** Patch a discovered worktree's size + push status once the background enrichment computes them. */
function handleWorktreeEnriched(message: any): void {
	const targetPath = String(message.path ?? "");
	if (!targetPath) { return; }
	const wt = worktreeResults.find((w) => w.path === targetPath);
	if (!wt) { return; }
	wt.files = numField(message.files);
	wt.folders = numField(message.folders);
	wt.bytes = numField(message.bytes);
	const pushedRaw = String(message.pushed ?? "?");
	wt.pushed = pushedRaw === "yes" || pushedRaw === "no" ? pushedRaw : "?";
	scheduleWorktreeResultsRender();
}

function handleWorktreeScanComplete(): void {
	worktreeScanInProgress = false;
	updateWorktreeControls();
	updateWorktreeResults();
}

function handleWorktreeScanCancelled(): void {
	worktreeScanInProgress = false;
	updateWorktreeControls();
}

/**
 * Populates the Worktrees tab from the once-daily background scan (see extension.ts
 * `postWorktreeBackgroundResults`), sent either in the initial payload or live when the
 * notification's "Show Me" action reveals an already-open panel. Ignored while a live/manual
 * scan or cleanup is in flight so it can't clobber what the user is actively watching.
 */
function handleWorktreeBackgroundResults(message: any): void {
	if (worktreeScanInProgress || worktreeCleanupInProgress) { return; }
	const worktrees = Array.isArray(message.worktrees) ? message.worktrees : [];
	worktreeResults = worktrees.map(sanitizeWorktreeResult);
	worktreeBackgroundScanMeta = { scannedAt: String(message.scannedAt ?? ""), totalBytes: numField(message.totalBytes) };
	updateWorktreeControls();
	updateWorktreeResults();
}

/** Dispatches worktree-tab messages via static, literal command comparisons (no dynamic method lookup). */
const _worktreeMessageHandlers: Record<string, (message: any) => void> = {
	worktreeRootPicked: handleWorktreeRootPicked,
	worktreeRootsDiscovered: handleWorktreeRootsDiscovered,
	worktreeScanStarted: () => handleWorktreeScanStarted(),
	worktreeScanRootStarted: handleWorktreeScanRootStarted,
	worktreeScanWalkProgress: handleWorktreeScanWalkProgress,
	worktreeScanRootMarkersFound: handleWorktreeScanRootMarkersFound,
	worktreeScanRootSkipped: handleWorktreeScanRootSkipped,
	worktreeScanProgress: handleWorktreeScanProgress,
	worktreeFound: handleWorktreeFound,
	worktreeEnrichStarted: handleWorktreeEnrichStarted,
	worktreeEnrichProgress: handleWorktreeEnrichProgress,
	worktreeEnriched: handleWorktreeEnriched,
	worktreeDeleted: handleWorktreeDeleted,
	worktreeDeleteStarted: handleWorktreeDeleteStarted,
	worktreeDeleteResult: handleWorktreeDeleteResult,
	worktreeScanComplete: () => handleWorktreeScanComplete(),
	worktreeScanCancelled: () => handleWorktreeScanCancelled(),
	worktreeBackgroundResults: handleWorktreeBackgroundResults,
	cleanupDeclined: () => handleCleanupDeclined(),
	cleanupStarted: handleCleanupStarted,
	cleanupWorktreeResult: handleCleanupWorktreeResult,
	cleanupComplete: () => handleCleanupComplete(),
	cleanupCancelled: () => handleCleanupCancelled(),
};

function handleWorktreeMessage(message: any): void {
	const handler = _worktreeMessageHandlers[message.command];
	if (handler) { handler(message); }
}

/**
 * Tells the host which subview the user is looking at, so the what's-new
 * announcer can stay quiet about tabs they already found. Fire-and-forget.
 */
function reportTabOpened(tab: string): void {
	// Recorded here rather than at each call site so every announcement path — a click, a
	// `switchTab` message, the unknown-tools banner, or setupTabs on a fresh layout — keeps
	// lastAnnouncedTab in step without having to remember to.
	lastAnnouncedTab = tab;
	vscode.postMessage({ command: 'viewTabOpened', view: 'usage', tab });
}

/**
 * Work a tab's first visit does once: fetching data it needs, or clearing its badge. Also run,
 * once, for whichever tab the layout first renders on: a tab the host requested while the tab bar
 * did not exist yet (see `handleSwitchTab`) has no button to click, so nothing else would ever
 * start its fetch.
 */
function runTabFirstVisitEffects(tab: string): void {
	if (tab === 'readiness') { darkFactoryTab.startIfNeeded(); }
	// Lazy-load repo PR stats on first visit to the tab
	if (tab === 'repos' && !repoPrStatsLoaded) {
		repoPrStatsLoaded = true;
		vscode.postMessage({ command: 'loadRepoPrStats' });
	}
	// Lazy-load cloud agent sessions on first visit to the tab
	if (tab === 'agent' && !agentSessionsLoaded) {
		agentSessionsLoaded = true;
		vscode.postMessage({ command: 'loadAgentSessions' });
	}
	// Mark new insights as seen when visiting the Insights tab
	if (tab === 'insights') {
		currentInsights
			.filter(i => i.status === 'new')
			.forEach(i => vscode.postMessage({ command: 'insightAction', id: i.id, action: 'seen' }));
	}
}

/**
 * The leaf tab each group was last left on, so re-opening a group returns the user to where they
 * were instead of resetting them to its first tab. Lives only in memory, like `activeTab` itself
 * — neither is written to `vscode.setState()` (`UsageWebviewState` holds only `aboutCollapsed`),
 * so a panel that is disposed and recreated legitimately starts over at the default tab.
 */
const lastTabPerGroup: Record<string, string> = {};

/** Shows one group's leaf tab bar and marks its group button active. Does not change which leaf is active. */
function activateUsageGroup(groupId: string): void {
	document.querySelectorAll<HTMLElement>('.group-tab').forEach(btn => {
		const selected = btn.getAttribute('data-group') === groupId;
		btn.classList.toggle('active', selected);
		// The `active` class is a paint-only signal. Without aria-pressed a screen reader hears
		// four identical buttons and cannot tell which group is open.
		btn.setAttribute('aria-pressed', String(selected));
	});
	document.querySelectorAll<HTMLElement>('.leaf-tabs').forEach(bar => {
		bar.style.display = bar.getAttribute('data-group') === groupId ? 'flex' : 'none';
	});
}

/**
 * The single path that switches tabs, whether the user clicked a tab, the host sent a
 * `switchTab` message, or an unknown-tool banner jumped here. Everything a tab switch has to
 * get right — revealing the owning group, the active markers, the panel, telemetry, first-visit
 * loads — lives here once, so a new entry point cannot forget half of it.
 *
 * Returns false when the tab has no rendered panel (e.g. the webview is still in its loading
 * state), leaving `activeTab` set so the eventual render lands on it.
 */
function activateUsageTab(tab: string): boolean {
	activeTab = tab;
	const panel = document.getElementById(`tab-panel-${tab}`);
	if (!panel) { return false; }
	const group = groupOfUsageTab(tab);
	lastTabPerGroup[group] = tab;
	activateUsageGroup(group);
	document.querySelectorAll<HTMLElement>('.tab-button').forEach(btn => {
		btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
	});
	document.querySelectorAll<HTMLElement>('.tab-panel').forEach(p => { p.style.display = 'none'; });
	panel.style.display = 'block';
	reportTabOpened(tab);
	runTabFirstVisitEffects(tab);
	return true;
}

/**
 * The leaf tab most recently reported to the host as opened, or null before the first report.
 *
 * setupTabs() runs after *every* renderLayout(), including each periodic silent `updateStats`
 * refresh — not just the first. Announcing unconditionally re-stamped the What's New visit window
 * on every refresh even though the user never moved.
 *
 * This tracks the tab rather than a bare "have we announced yet" flag because the panel can return
 * to the loading state and rebuild (renderUsageLoadingState on a refresh). A `switchTab` deep link
 * arriving in that window cannot be announced by activateUsageTab() — there is no panel yet — so a
 * lifetime boolean would suppress the announcement for the rebuilt layout too, and the host would
 * never record that leaf visit. Comparing against the last announced tab reports the new one and
 * still stays quiet when a refresh rebuilds the same tab.
 */
let lastAnnouncedTab: string | null = null;

function setupTabs(): void {
	// Seed the remembered-leaf map from whatever tab this render opened on. activateUsageTab()
	// records it on every later switch, but it bails before recording when no panel exists yet —
	// which is exactly the case for a `switchTab` deep link that arrives while the view is still
	// loading. Without this, opening on a deep-linked tab (the worktree notification's "Show Me",
	// say), leaving its group and coming back would drop the user on the group's first tab.
	lastTabPerGroup[groupOfUsageTab(activeTab)] = activeTab;
	if (lastAnnouncedTab !== activeTab) {
		// The tab that is already on screen counts as opened — the user is reading it
		// right now, whether or not they clicked anything to get here.
		reportTabOpened(activeTab);
	}
	// …and it counts as a first visit. activateUsageTab() bails before reaching these effects
	// when no panel exists yet, so a `switchTab` deep link to Repository PRs or Cloud Agent
	// would render its panel and then sit on the loading placeholder forever, because nothing
	// ever posted loadRepoPrStats/loadAgentSessions. Once per rendered layout (not per panel): a
	// layout rebuilt after the loading state still starts the tab it lands on, while a stats
	// refresh that rebuilds the same layout does not re-fire a fetch the user never asked for.
	if (!layoutLazyTabLoadStarted) {
		layoutLazyTabLoadStarted = true;
		runTabFirstVisitEffects(activeTab);
	}
	document.querySelectorAll<HTMLElement>('.tab-button').forEach(button => {
		button.addEventListener('click', () => {
			const tab = button.getAttribute('data-tab');
			if (!tab) { return; }
			// The user chose where to look. Drop any pending insight deep link right here rather
			// than waiting for a re-render to notice: clicking away and straight back would leave
			// the old anchor live and yank them to that card on the next update.
			clearFocusedInsightAnchor();
			activateUsageTab(tab);
		});
	});
	setupGroupTabs();
}

/**
 * Clicking a group tab reveals its leaf bar. It only moves the user to a different tab when the
 * group they opened does not already contain the active one — so returning to the group you came
 * from puts you back where you were, rather than resetting you to its first tab.
 */
function setupGroupTabs(): void {
	document.querySelectorAll<HTMLElement>('.group-tab').forEach(button => {
		button.addEventListener('click', () => {
			const groupId = button.getAttribute('data-group');
			const group = USAGE_TAB_GROUPS.find(g => g.id === groupId);
			if (!group) { return; }
			clearFocusedInsightAnchor();
			activateUsageGroup(group.id);
			if (group.tabs.includes(activeTab)) { return; }
			const remembered = lastTabPerGroup[group.id];
			const candidates = remembered ? [remembered, ...group.tabs] : group.tabs;
			const nextTab = candidates.find(tab => document.getElementById(`tab-panel-${tab}`));
			if (nextTab) { activateUsageTab(nextTab); }
		});
	});
}

function sanitizeRepoPrStatsData(input: unknown): RepoPrStatsResult {
	const src = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
	const repos = Array.isArray(src.repos) ? src.repos : [];
	return {
		authenticated: Boolean(src.authenticated),
		since: typeof src.since === 'string' || typeof src.since === 'number' ? src.since : Date.now(),
		error: typeof src.error === 'string' ? escapeHtml(src.error) : undefined,
		fetchedAt: typeof src.fetchedAt === 'string' ? src.fetchedAt : '',
		refreshIntervalMs: toSafeNumber(src.refreshIntervalMs),
		repos: repos.map((repo) => {
			const r = (repo && typeof repo === 'object') ? (repo as Record<string, unknown>) : {};
			const aiDetails = Array.isArray(r.aiDetails) ? r.aiDetails : [];
			return {
				repoUrl: toSafeHttpUrl(r.repoUrl),
				owner: escapeHtml(typeof r.owner === 'string' ? r.owner : ''),
				repo: escapeHtml(typeof r.repo === 'string' ? r.repo : ''),
				error: typeof r.error === 'string' ? escapeHtml(r.error) : '',
				totalPrs: toSafeNumber(r.totalPrs),
				aiAuthoredPrs: toSafeNumber(r.aiAuthoredPrs),
				aiReviewRequestedPrs: toSafeNumber(r.aiReviewRequestedPrs),
				userAuthoredPrs: toSafeNumber(r.userAuthoredPrs),
				userMergedPrs: toSafeNumber(r.userMergedPrs),
				aiDetails: aiDetails.map((d) => {
					const detail = (d && typeof d === 'object') ? (d as Record<string, unknown>) : {};
					const validAiTypes = ['copilot', 'claude', 'openai', 'other-ai'] as const;
					const validRoles = ['author', 'reviewer-requested'] as const;
					const aiType = validAiTypes.includes(detail.aiType as typeof validAiTypes[number])
						? detail.aiType as typeof validAiTypes[number]
						: 'other-ai';
					const role = validRoles.includes(detail.role as typeof validRoles[number])
						? detail.role as typeof validRoles[number]
						: 'author';
					return {
						number: toSafeNumber(detail.number),
						title: escapeHtml(typeof detail.title === 'string' ? detail.title : ''),
						url: toSafeHttpUrl(detail.url),
						aiType,
						role,
					};
				}),
			};
		}),
	} as RepoPrStatsResult;
}

/** Display label per detected AI agent type, used in the PR detail list. */
const AI_PR_LABEL: Record<string, string> = {
	copilot: '🤖 Copilot',
	claude: '🧠 Claude',
	openai: '✨ Codex',
	'other-ai': '🤖 AI',
};

/** Repositories whose AI PR detail list is expanded, so a sort or page change keeps them open. */
const openRepoPrDetails = new Set<string>();

/** Repository cell: the repo link plus its collapsible AI PR detail list, or the fetch error. */
function repoPrRepositoryCellHtml(r: RepoPrInfo): string {
	const repoLink = `<a href="${escapeHtml(r.repoUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--link-color); font-family:'Courier New',monospace; font-size:12px;">${escapeHtml(r.owner)}/${escapeHtml(r.repo)}</a>`;
	if (r.error) {
		return `${repoLink}<div style="color:var(--text-secondary); font-style:italic; font-size:12px;">${escapeHtml(r.error)}</div>`;
	}
	if (r.aiDetails.length === 0) { return repoLink; }
	const items = r.aiDetails.map(d => {
		const ccrButton = (d.role === 'reviewer-requested' && d.aiType === 'copilot')
			? renderCcrCheckButtonHtml(r.owner, r.repo, d.number)
			: '';
		const roleLabel = d.role === 'author' ? localize('usage.repoPrs.aiDetailAuthored') : localize('usage.repoPrs.aiDetailReviewRequested');
		return `<li><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--link-color);">#${d.number} ${escapeHtml(d.title)}</a> — ${AI_PR_LABEL[d.aiType] ?? escapeHtml(String(d.aiType))} (${escapeHtml(roleLabel)})${ccrButton}</li>`;
	}).join('');
	const key = `${r.owner}/${r.repo}`;
	return `${repoLink}
		<details data-repo-pr-details="${escapeHtml(key)}" style="margin-top:4px; font-size:11px;"${openRepoPrDetails.has(key) ? ' open' : ''}>
			<summary style="cursor:pointer; color:var(--text-secondary);">Show ${r.aiDetails.length} detail(s)</summary>
			<ul style="margin:4px 0 0 16px; padding:0; list-style:disc;">${items}</ul>
		</details>`;
}

/** A centred count column; error rows have no counts, so they render a dash and sort last. */
function githubCountColumn<Row extends { error?: string }>(
	id: string, label: string, tip: string | undefined, value: (row: Row) => number, cell: (row: Row) => string,
): DataTableColumn<Row> {
	return {
		id, label, align: 'center', firstSortDirection: 'desc',
		headerHtml: tip ? `<span title="${escapeHtml(tip)}">${escapeHtml(label)}</span>` : undefined,
		sortValue: row => row.error ? null : value(row),
		render: row => row.error ? '—' : { html: cell(row) },
	};
}

const boldCount = (value: number): string => value > 0 ? `<span style="font-weight:600;">${value}</span>` : '0';

/** No initialSort: repositories keep the order the host lists them in. */
function renderRepoPrTable(repos: RepoPrInfo[]): string {
	return renderDataTable<RepoPrInfo>({
		tableId: 'repo-prs',
		ariaLabel: 'AI Activity in Repository PRs',
		rows: repos,
		onRender: replayCcrActivityResults,
		columns: [
			{ id: 'repo', label: '📂 Repository', sortValue: r => `${r.owner}/${r.repo}`, render: r => ({ html: repoPrRepositoryCellHtml(r) }) },
			githubCountColumn<RepoPrInfo>('prs', 'PRs', undefined, r => r.totalPrs, r => `<span style="font-weight:600;">${r.totalPrs}</span>`),
			githubCountColumn<RepoPrInfo>('yours', '🚢 Yours (merged / opened)', 'PRs you opened yourself, shown as merged / opened. Work driven by a local AI assistant lands here, not under Cloud Agent Authored.',
				r => r.userAuthoredPrs ?? 0,
				r => (r.userAuthoredPrs ?? 0) > 0 ? `<span style="font-weight:600;">${r.userMergedPrs ?? 0} / ${r.userAuthoredPrs}</span>` : '0'),
			githubCountColumn<RepoPrInfo>('aiAuthored', '🤖 Cloud Agent Authored', 'PRs where the PR author\'s GitHub login matches a known AI agent (e.g. copilot-swe-agent, claude-code-action, openai-code-agent)',
				r => r.aiAuthoredPrs, r => boldCount(r.aiAuthoredPrs)),
			githubCountColumn<RepoPrInfo>('aiReview', '👁 Copilot Review Agent requested†', 'Open PRs where an AI agent was listed as a requested reviewer',
				r => r.aiReviewRequestedPrs, r => boldCount(r.aiReviewRequestedPrs)),
		],
	});
}

/**
 * Freshness line for the snapshot. The data is fetched at most once an hour, by whichever VS Code
 * window holds the repo-PRs lock, so the panel always says how old what it shows is.
 */
function repoPrSnapshotFreshnessHtml(data: RepoPrStatsResult): string {
  const box = 'margin-bottom:12px; padding:8px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; font-size:11px; color:var(--text-secondary);';
  if (!data.fetchedAt) {
    return `<div style="${box}">🕒 <strong>Not fetched yet.</strong> The snapshot is refreshed hourly by the main VS Code window — it will appear here once that first refresh completes.</div>`;
  }
  const fetchedMs = Date.parse(data.fetchedAt);
  const nextRefresh = Number.isFinite(fetchedMs) && data.refreshIntervalMs
    ? new Date(fetchedMs + data.refreshIntervalMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'unknown';
  return `<div style="${box}">
    🕒 Updated <strong>${escapeHtml(getTimeSince(data.fetchedAt))}</strong> · next refresh after ${escapeHtml(nextRefresh)}.
    Cached and refreshed at most once an hour, by a single VS Code window, to keep GitHub API usage low.
  </div>`;
}

function renderReposPrContent(data: RepoPrStatsResult): string {
	const sinceDate = escapeHtml(new Date(data.since).toLocaleDateString());
	if (data.error) {
		return `
			<div style="margin-top:12px; padding:12px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; font-size:12px; color:var(--text-secondary);">
				<strong>⚠️ Failed to load repository PR activity</strong><br/>
				${data.error}<br/>
				Switch to another tab and back to retry — details are in the extension Output channel.
			</div>`;
	}
	if (!data.authenticated) {
		return `
			<div style="margin-top:12px; padding:12px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; font-size:12px; color:var(--text-secondary);">
				<strong>🔒 GitHub authentication required</strong><br/>
				Sign in with GitHub (via the Diagnostics tab) to see AI PR activity across your repositories.
			</div>`;
	}
	if (data.repos.length === 0) {
		return `${repoPrSnapshotFreshnessHtml(data)}
			<div style="margin-top:12px; font-size:12px; color:var(--text-secondary);">
				No GitHub repositories detected in your workspace folders.
			</div>`;
	}

	return `
		${repoPrSnapshotFreshnessHtml(data)}
		<div style="font-size:11px; color:var(--text-secondary); margin-bottom:12px;">
			Showing PRs created since ${sinceDate}.
			Reviewer requests are only visible for <strong>open</strong> PRs — the GitHub API clears this field after a PR is merged or closed.
		</div>
		${renderRepoPrTable(data.repos)}
		<div style="margin-top:8px; font-size:10px; color:var(--text-muted); border-top:1px solid var(--border-subtle); padding-top:8px;">
			† Copilot Review Agent requested counts are for open PRs only. GitHub removes reviewer data after a PR is merged or closed.<br/>
			🤖 Cloud Agent Authored = PR author's GitHub login matches a known cloud agent (e.g. <code>copilot-swe-agent</code>, <code>claude-code-action</code>, <code>openai-code-agent</code>).
		</div>`;
}

/** Renders the repository PR panel. Returns false when the target container isn't in the DOM yet. */
function updateReposPrPanel(data: RepoPrStatsResult): boolean {
	const container = document.querySelector('#repos-pr-content');
	if (!container) { return false; }
	setHtml(container, `
		<div class="section-title"><span>🤖</span><span>AI Activity in Repository PRs</span></div>
		<div class="section-subtitle">
			PRs from the last 30 days across your known repositories, showing how many were <strong>authored by cloud agents</strong>
			(i.e. opened by a bot account like <code>copilot-swe-agent</code>, <code>claude-code-action</code>, or <code>openai-code-agent</code>)
			or had an AI agent requested as a reviewer.
		</div>
		${renderReposPrContent(data)}
	`);
	// A host refresh rebuilds the buttons; put back pending/answered CCR lookups so an answer does
	// not vanish and a pending check cannot be submitted twice.
	replayCcrActivityResults();
	return true;
}

// ---------------------------------------------------------------------------
// Cloud Agent Sessions tab
// ---------------------------------------------------------------------------

/** Label for one repo row: a link for real repos, a plain label for the "no repository" bucket. */
function agentRepoLabelHtml(r: AgentRepoSummary): string {
  const mono = "font-family:'Courier New',monospace; font-size:12px;";
  if (r.unassigned) {
    return `<span style="${mono} color:var(--text-secondary);" title="Tasks the agents API reported without a repository — typically ad-hoc sessions started from cloud chat">no repository (cloud chat)</span>`;
  }
  const link = `<a href="${r.repoUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--link-color); ${mono}">${r.owner}/${r.repo}</a>`;
  const accountOnly = r.discovery === 'account'
    ? ` <span title="Found through your account-wide agent tasks — this repo is not open in any workspace folder" style="color:var(--text-muted); font-size:10px;">(not in workspace)</span>`
    : '';
  return `${link}${accountOnly}`;
}

/** No initialSort: repositories keep the order the host lists them in. */
function renderAgentSessionsTable(repos: AgentRepoSummary[]): string {
	return renderDataTable<AgentRepoSummary>({
		tableId: 'agent-sessions',
		ariaLabel: 'Copilot Cloud Agent Sessions',
		rows: repos,
		columns: [
			{
				id: 'repo', label: '📂 Repository', sortValue: r => r.unassigned ? null : `${r.owner}/${r.repo}`,
				// r.owner, r.repo, r.repoUrl and r.error are pre-sanitized by sanitizeAgentSessionsData
				render: r => {
					if (r.error) {
						return { html: `${agentRepoLabelHtml(r)}<div style="color:var(--text-secondary); font-style:italic; font-size:12px;">${r.error}</div>` };
					}
					const partialNote = r.partial
						? ` <span title="Showing ${r.tasksScanned} of ${r.tasksTotal} tasks — capped to limit API usage" style="color:var(--text-muted); font-size:10px;">(${r.tasksScanned}/${r.tasksTotal} tasks scanned)</span>`
						: '';
					return { html: `${agentRepoLabelHtml(r)}${partialNote}` };
				},
			},
			githubCountColumn<AgentRepoSummary>('tasks', 'Tasks', 'Number of Copilot cloud agent tasks (each task = one user prompt to the agent)',
				r => r.totalTasks, r => `<span style="font-weight:600;">${r.totalTasks}</span>`),
			githubCountColumn<AgentRepoSummary>('sessions', 'Sessions', 'Number of agent sessions (each session = one autonomous coding run)',
				r => r.totalSessions, r => `<span style="font-weight:600;">${r.totalSessions}</span>`),
			githubCountColumn<AgentRepoSummary>('credits', 'AI Credits', 'AI credits consumed (1 credit = $0.01). Only available when the API reports usage data.',
				r => r.totalCredits > 0 ? r.totalCredits : r.totalPremiumRequests,
				r => r.totalCredits > 0
					? r.totalCredits.toFixed(1)
					: r.totalPremiumRequests > 0 ? `${r.totalPremiumRequests.toFixed(1)} PR` : '—'),
		],
	});
}

/**
 * Freshness line for the snapshot. The data is fetched at most once an hour, by whichever VS Code
 * window holds the agent-tasks lock, so the panel always says how old what it shows is.
 */
function agentSnapshotFreshnessHtml(data: AgentSessionsResult): string {
  const box = 'margin-bottom:12px; padding:8px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; font-size:11px; color:var(--text-secondary);';
  if (!data.fetchedAt) {
    return `<div style="${box}">🕒 <strong>Not fetched yet.</strong> The snapshot is refreshed hourly by the main VS Code window — it will appear here once that first refresh completes.</div>`;
  }
  const fetchedMs = Date.parse(data.fetchedAt);
  const nextRefresh = Number.isFinite(fetchedMs)
    ? new Date(fetchedMs + data.refreshIntervalMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'unknown';
  return `<div style="${box}">
    🕒 Updated <strong>${escapeHtml(getTimeSince(data.fetchedAt))}</strong> · next refresh after ${escapeHtml(nextRefresh)}.
    Cached and refreshed at most once an hour, by a single VS Code window, to keep GitHub API usage low.
  </div>`;
}

function renderAgentSessionsContent(data: AgentSessionsResult): string {
	if (!data.authenticated) {
		return `
			<div style="margin-top:12px; padding:12px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; font-size:12px; color:var(--text-secondary);">
				<strong>🔒 GitHub authentication required</strong><br/>
				Sign in with GitHub (via the Diagnostics tab) to see Copilot cloud agent session data.
			</div>`;
	}
	if (data.repos.length === 0) {
		return `${agentSnapshotFreshnessHtml(data)}
			<div style="margin-top:12px; font-size:12px; color:var(--text-secondary);">
				No cloud agent tasks found — neither in your workspace repositories nor anywhere else in your account.
			</div>`;
	}

	const sinceDate = new Date(data.since).toLocaleDateString();

	const summaryTotals = data.repos.reduce((acc, r) => {
		if (!r.error) {
			acc.tasks += r.totalTasks;
			acc.sessions += r.totalSessions;
			acc.credits += r.totalCredits;
			acc.premiumRequests += r.totalPremiumRequests;
		}
		return acc;
	}, { tasks: 0, sessions: 0, credits: 0, premiumRequests: 0 });

	const hasPartial = data.repos.some(r => r.partial && !r.error);
	const tile = 'background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; padding:12px 20px; text-align:center; min-width:80px;';

	return `
		${agentSnapshotFreshnessHtml(data)}
		<div style="margin-bottom:12px; display:flex; gap:24px; flex-wrap:wrap;">
			<div style="${tile}">
				<div style="font-size:22px; font-weight:700; color:var(--text-primary);">${summaryTotals.tasks}</div>
				<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Tasks</div>
			</div>
			<div style="${tile}">
				<div style="font-size:22px; font-weight:700; color:var(--text-primary);">${summaryTotals.sessions}</div>
				<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Sessions</div>
			</div>
			<div style="${tile}">
				<div style="font-size:22px; font-weight:700; color:var(--text-primary);">${summaryTotals.credits > 0 ? summaryTotals.credits.toFixed(1) : '—'}</div>
				<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">AI Credits</div>
			</div>
			${summaryTotals.premiumRequests > 0 ? `
			<div style="${tile}">
				<div style="font-size:22px; font-weight:700; color:var(--text-primary);">${summaryTotals.premiumRequests.toFixed(1)}</div>
				<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;" title="Sessions that ran before the June 2026 switch to AI credits are billed in premium requests">Premium Requests</div>
			</div>` : ''}
		</div>
		<div style="font-size:11px; color:var(--text-secondary); margin-bottom:12px;">
			Showing cloud-agent sessions from ${sinceDate} to now.
			${hasPartial ? '<strong>Note:</strong> Some repos were capped — totals are lower bounds. ' : ''}
			${data.accountTasksAvailable
				? ''
				: `<strong>Account-wide tasks unavailable:</strong> ${data.accountTasksError ?? 'the /agents/tasks endpoint could not be read'} — only workspace repositories are shown.`}
		</div>
		${renderAgentSessionsTable(data.repos)}
		<div style="margin-top:8px; font-size:10px; color:var(--text-muted); border-top:1px solid var(--border-subtle); padding-top:8px;">
			ℹ️ <strong>No double-counting:</strong> These are cloud agent sessions only. CLI/remote sessions and local IDE chat sessions (shown in "My Activity") are excluded.<br/>
			ℹ️ <strong>Two sources:</strong> your workspace repositories (which also surface tasks other people started there) plus your account-wide agent tasks, which cover repos you don't have open and ad-hoc cloud chat sessions. Tasks seen in both are counted once.<br/>
			ℹ️ <strong>Action minutes</strong> (GitHub Actions compute used by the agent) are not shown here — they require additional per-branch API calls.
		</div>`;
}

/** Renders the cloud agent panel. Returns false when the target container isn't in the DOM yet. */
function updateAgentSessionsPanel(data: AgentSessionsResult): boolean {
	const container = document.querySelector('#agent-sessions-content');
	if (!container) { return false; }
	setHtml(container, `
		<div class="section-title"><span>🤖</span><span>Copilot Cloud Agent Sessions</span></div>
		<div class="section-subtitle">
			Cloud agent tasks and sessions from the last 30 days. Each <strong>task</strong> is a user request to the agent;
			each <strong>session</strong> is an autonomous coding run within that task.
			<strong>CLI/remote sessions are excluded</strong> — they are separate from these cloud agent sessions.
		</div>
		${renderAgentSessionsContent(data)}
	`);
	return true;
}

/** Renders a compact three-period model cost breakdown for the Activity tab. */
function buildModelCostSectionHtml(stats: UsageAnalysisStats): string {
	const p30 = stats.last30Days.modelSwitching;
	const today = stats.today.modelSwitching;
	// Only show if we have any request data
	if ((p30.totalRequests ?? 0) === 0 && (today.totalRequests ?? 0) === 0) { return ''; }

	function renderCostPeriod(ms: ModelSwitchingAnalysis): string {
		const total = ms.totalRequests ?? 0;
		if (total === 0) { return '<div style="color: var(--text-muted); font-size: 11px;">No data</div>'; }
		const buckets: { label: string; count: number; color: string }[] = [
			{ label: '💚 Low cost', count: ms.lowCostRequests ?? 0, color: '#4ade80' },
			{ label: '🔵 Medium cost', count: ms.mediumCostRequests ?? 0, color: 'var(--link-color)' },
			{ label: '💸 High cost', count: ms.highCostRequests ?? 0, color: 'var(--warning-fg)' },
			{ label: '❓ Unknown', count: ms.unknownRequests ?? 0, color: 'var(--text-muted)' },
		].filter(b => b.count > 0);
		const rows = buckets.map(b => {
			const pct = total > 0 ? Math.round((b.count / total) * 100) : 0;
			return `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
				<span style="width: 90px; font-size: 12px; font-weight: 600; color: ${b.color};">${b.label}</span>
				<div style="flex: 1; background: var(--bg-secondary); border-radius: 4px; height: 12px; overflow: hidden;">
					<div style="width: ${pct}%; background: ${b.color}; height: 100%; border-radius: 4px;"></div>
				</div>
				<span style="font-size: 12px; font-weight: 600; color: var(--text-primary); min-width: 70px; text-align: right;">${formatNumber(b.count)} <span style="color: var(--text-secondary); font-weight: 400;">(${pct}%)</span></span>
			</div>`;
		}).join('');
		const mixedNote = (ms.mixedCostSessions ?? 0) > 0
			? `<div style="font-size: 11px; color: var(--link-color); margin-top: 6px;">🔀 ${formatNumber(ms.mixedCostSessions)} mixed-cost session${ms.mixedCostSessions !== 1 ? 's' : ''}</div>`
			: '';
		return `${rows}<div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">${formatNumber(total)} total requests</div>${mixedNote}`;
	}

	return `
		<!-- Model Cost Section -->
		<div class="section" id="section-model-cost">
			<div class="section-title"><span>💰</span><span>Model Cost Usage</span></div>
			<div class="section-subtitle">Request distribution across cost levels — low (&lt;$2/M tokens), medium ($2–5/M), high (≥$5/M)</div>
			<div class="three-column">
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
					${renderCostPeriod(today)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
					${renderCostPeriod(p30)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Previous Month</h4>
					${renderCostPeriod(stats.month.modelSwitching)}
				</div>
			</div>
		</div>`;
}

function buildThinkingEffortSectionHtml(stats: UsageAnalysisStats): string {
	const effortData = stats.last30Days.thinkingEffortUsage || stats.today.thinkingEffortUsage || stats.month.thinkingEffortUsage;
	if (!effortData) { return ''; }
	return `
		<!-- Thinking Effort Section -->
		<div class="section" id="section-thinking-effort">
			<div class="section-title"><span>💡</span><span>Thinking Effort (Reasoning)</span></div>
			<div class="section-subtitle">How often each reasoning effort level was used (requests per level)</div>
			<div class="three-column">
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
					${renderEffortPeriodHtml(stats.today.thinkingEffortUsage)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
					${renderEffortPeriodHtml(stats.last30Days.thinkingEffortUsage)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Previous Month</h4>
					${renderEffortPeriodHtml(stats.month.thinkingEffortUsage)}
				</div>
			</div>
		</div>`;
}

function renderEffortPeriodHtml(teu: { byEffort: { [effort: string]: number }; sessionCount: number; switchCount: number } | undefined): string {
	const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh'];
	if (!teu || teu.sessionCount === 0) { return '<div style="color: var(--text-muted); font-size: 11px;">No data</div>'; }
	const total = Object.values(teu.byEffort).reduce((s, v) => s + v, 0);
	const sorted = EFFORT_ORDER
		.filter(k => teu.byEffort[k] > 0)
		.concat(Object.keys(teu.byEffort).filter(k => !EFFORT_ORDER.includes(k) && teu.byEffort[k] > 0));
	return `
		${sorted.map(level => {
			const count = teu.byEffort[level] || 0;
			const pct = total > 0 ? Math.round((count / total) * 100) : 0;
			return `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
				<span style="width: 56px; font-size: 12px; font-weight: 600; color: var(--text-primary); text-transform: capitalize;">${escapeHtml(getEffortDisplayName(level))}</span>
				<div style="flex: 1; background: var(--bg-secondary); border-radius: 4px; height: 12px; overflow: hidden;">
					<div style="width: ${pct}%; background: var(--link-color); height: 100%; border-radius: 4px;"></div>
				</div>
				<span style="font-size: 12px; font-weight: 600; color: var(--text-primary); min-width: 70px; text-align: right;">${count} <span style="color: var(--text-secondary); font-weight: 400;">(${pct}%)</span></span>
			</div>`;
		}).join('')}
		<div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">${teu.sessionCount} session${teu.sessionCount !== 1 ? 's' : ''} · ${teu.switchCount} effort switch${teu.switchCount !== 1 ? 'es' : ''}</div>
	`;
}

function buildUsageAllKeysSets(stats: UsageAnalysisStats): {
	allToolKeys: string[];
	allMcpToolKeys: string[];
	allMcpServerKeys: string[];
	allStandardModels: string[];
	allHighCostModels: string[];
	allLowCostModels: string[];
	allMediumCostModels: string[];
	allUnknownModels: string[];
} {
	return {
		allToolKeys: [...new Set([...Object.keys(stats.today.toolCalls.byTool), ...Object.keys(stats.last30Days.toolCalls.byTool), ...Object.keys(stats.month.toolCalls.byTool)])].sort(),
		allMcpToolKeys: [...new Set([...Object.keys(stats.today.mcpTools.byTool), ...Object.keys(stats.last30Days.mcpTools.byTool), ...Object.keys(stats.month.mcpTools.byTool)])].sort(),
		allMcpServerKeys: [...new Set([...Object.keys(stats.today.mcpTools.byServer), ...Object.keys(stats.last30Days.mcpTools.byServer), ...Object.keys(stats.month.mcpTools.byServer)])].sort(),
		allStandardModels: [...new Set([...stats.today.modelSwitching.standardModels, ...stats.last30Days.modelSwitching.standardModels, ...stats.month.modelSwitching.standardModels])].sort(),
		allHighCostModels: [...new Set([...stats.today.modelSwitching.highCostModels, ...stats.last30Days.modelSwitching.highCostModels, ...stats.month.modelSwitching.highCostModels])].sort(),
		allLowCostModels: [...new Set([...stats.today.modelSwitching.lowCostModels, ...stats.last30Days.modelSwitching.lowCostModels, ...stats.month.modelSwitching.lowCostModels])].sort(),
		allMediumCostModels: [...new Set([...stats.today.modelSwitching.mediumCostModels, ...stats.last30Days.modelSwitching.mediumCostModels, ...stats.month.modelSwitching.mediumCostModels])].sort(),
		allUnknownModels: [...new Set([...stats.today.modelSwitching.unknownModels, ...stats.last30Days.modelSwitching.unknownModels, ...stats.month.modelSwitching.unknownModels])].sort(),
	};
}

function buildHealthTabPanelHtml(customizationHtml: string, stats: UsageAnalysisStats): string {
	return `
		<div id="tab-panel-health" class="tab-panel"${activeTab !== 'health' ? ' style="display:none"' : ''}>
			${customizationHtml}
			${renderMissedPotential(stats)}

			<!-- Repository Setup Section -->
			<div class="repo-hygiene-section" id="section-repo-hygiene" style="margin-top: 16px; margin-bottom: 16px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px;">
				<div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">
					🏗️ Repository Hygiene Analysis
				</div>
				<div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;">
					Analyze repository hygiene and structure to identify missing configuration files and best practices.
				</div>
				${hygieneMatrixState && hygieneMatrixState.workspaces && hygieneMatrixState.workspaces.length > 0 ? `
					<div style="margin-bottom: 12px;">
						<vscode-button id="btn-analyse-all" style="margin-bottom: 8px;" ${isBatchAnalysisInProgress ? 'disabled="true" appearance="secondary"' : ''}>${isBatchAnalysisInProgress ? 'Analyzing All...' : `Analyze All Repositories (${hygieneMatrixState.workspaces.length})`}</vscode-button>
					</div>
					<div id="repo-list-pane-container" class="repo-hygiene-pane">
						<div class="repo-hygiene-pane-header">📁 Repository List</div>
						<div id="repo-list-pane" class="repo-hygiene-pane-body"></div>
					</div>
					<div id="repo-details-pane-container" class="repo-hygiene-pane repo-hygiene-pane-collapsed">
						<div class="repo-hygiene-pane-header">📊 Repository Details</div>
						<div id="repo-details-pane" class="repo-hygiene-pane-body"></div>
					</div>
				` : `
					<vscode-button id="btn-analyse-repo" ${isSingleRepoAnalysisInProgress ? 'disabled="true" appearance="secondary"' : ''}>${isSingleRepoAnalysisInProgress ? 'Analyzing...' : 'Analyze Repo for Best Practices'}</vscode-button>
					<div id="repo-analysis-results" class="repo-hygiene-results" style="margin-top: 12px;"></div>
				`}
			</div>
		</div>`;
}

function buildMcpToolsSectionHtml(
	stats: UsageAnalysisStats,
	allMcpToolKeys: string[],
	allMcpServerKeys: string[],
): string {
	return `
		<!-- MCP Tools Section -->
		<div class="section" id="section-mcp-tools">
			<div class="section-title"><span>🔌</span><span>MCP Tools</span></div>
			<div class="section-subtitle">Model Context Protocol (MCP) server and tool usage</div>
			${buildUnknownMcpToolsBannerHtml(stats)}
			<div class="three-column">
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total MCP Calls: ${formatNumber(stats.today.mcpTools.total)}</div>
						${allMcpServerKeys.length > 0 ? `
							<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable('mcp-servers-today', 'By Server', unionFill(stats.today.mcpTools.byServer, allMcpServerKeys), 200)}</div></div>
						` : '<div style="color: var(--text-muted); margin-top: 8px;">No MCP tools used yet</div>'}
					</div>
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total MCP Calls: ${formatNumber(stats.last30Days.mcpTools.total)}</div>
						${allMcpServerKeys.length > 0 ? `
							<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable('mcp-servers-last30', 'By Server', unionFill(stats.last30Days.mcpTools.byServer, allMcpServerKeys), 200)}</div></div>
						` : '<div style="color: var(--text-muted); margin-top: 8px;">No MCP tools used yet</div>'}
					</div>
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Previous Month</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total MCP Calls: ${formatNumber(stats.month.mcpTools.total)}</div>
						${allMcpServerKeys.length > 0 ? `
							<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable('mcp-servers-month', 'By Server', unionFill(stats.month.mcpTools.byServer, allMcpServerKeys), 200)}</div></div>
						` : '<div style="color: var(--text-muted); margin-top: 8px;">No MCP tools used yet</div>'}
					</div>
				</div>
			</div>
			<div class="three-column" style="margin-top: 12px;">
				<div>
					${allMcpToolKeys.length > 0 ? `
						<div class="list">
							<div style="margin-top: 4px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable('mcp-tools-today', 'By Tool', unionFill(stats.today.mcpTools.byTool, allMcpToolKeys), 10, lookupMcpToolName)}</div></div>
						</div>
					` : ''}
				</div>
				<div>
					${allMcpToolKeys.length > 0 ? `
						<div class="list">
							<div style="margin-top: 4px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable('mcp-tools-last30', 'By Tool', unionFill(stats.last30Days.mcpTools.byTool, allMcpToolKeys), 10, lookupMcpToolName)}</div></div>
						</div>
					` : ''}
				</div>
				<div>
					${allMcpToolKeys.length > 0 ? `
						<div class="list">
							<div style="margin-top: 4px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable('mcp-tools-month', 'By Tool', unionFill(stats.month.mcpTools.byTool, allMcpToolKeys), 10, lookupMcpToolName)}</div></div>
						</div>
					` : ''}
				</div>
			</div>
		</div>`;
}

function buildCurationSummaryHtml(availableTools: AvailableToolEntry[], unusedTools: AvailableToolEntry[], bloat: ToolCurationAnalysis['estimatedPromptBloat']): string {
	const usedCount = availableTools.length - unusedTools.length;
	const severityColor = unusedTools.length > 0 ? 'rgba(251,191,36,0.12)' : 'rgba(74,222,128,0.12)';
	const severityBorder = unusedTools.length > 0 ? 'rgba(251,191,36,0.4)' : 'rgba(74,222,128,0.4)';
	const unusedColor = unusedTools.length > 0 ? '#fbbf24' : '#4ade80';
	const totalBloat = bloat.totalTokens;
	const skillBloat = bloat.byServer['skill'] ?? 0;
	const builtinBloat = bloat.byServer['builtin'] ?? 0;
	const mcpBloat = totalBloat - skillBloat - builtinBloat;
	const fmt = (n: number) => n >= 1000 ? `~${Math.round(n / 1000)}K` : `~${n}`;
	const actionableBloat = mcpBloat + skillBloat;
	const actionableParts: string[] = [];
	if (mcpBloat > 0) { actionableParts.push(`${fmt(mcpBloat)} MCP`); }
	if (skillBloat > 0) { actionableParts.push(`${fmt(skillBloat)} skills`); }
	return `<div style="display:flex; gap:16px; flex-wrap:wrap; margin:12px 0;">
		<div style="background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; padding:10px 16px; min-width:120px; text-align:center;">
			<div style="font-size:20px; font-weight:700; color:var(--text-primary);">${formatNumber(availableTools.length)}</div>
			<div style="font-size:11px; color:var(--text-primary); opacity:0.75;">Available</div>
		</div>
		<div style="background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; padding:10px 16px; min-width:120px; text-align:center;">
			<div style="font-size:20px; font-weight:700; color:#4ade80;">${formatNumber(usedCount)}</div>
			<div style="font-size:11px; color:var(--text-primary); opacity:0.75;">Used</div>
		</div>
		<div style="background:${severityColor}; border:1px solid ${severityBorder}; border-radius:6px; padding:10px 16px; min-width:120px; text-align:center;">
			<div style="font-size:20px; font-weight:700; color:${unusedColor};">${formatNumber(unusedTools.length)}</div>
			<div style="font-size:11px; color:var(--text-primary); opacity:0.75;">Unused</div>
		</div>
		${actionableBloat > 0 ? `<div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:6px; padding:10px 16px; min-width:140px; text-align:center;" title="Overhead you can reduce by disabling unused MCP servers or removing unused skills">
			<div style="font-size:20px; font-weight:700; color:#f87171;">${fmt(actionableBloat)}</div>
			<div style="font-size:11px; color:var(--text-primary); opacity:0.75;">Actionable overhead</div>
			${actionableParts.length > 0 ? `<div style="font-size:10px; color:var(--text-secondary); margin-top:2px;">${escapeHtml(actionableParts.join(' + '))}</div>` : ''}
		</div>` : ''}
		${builtinBloat > 0 ? `<div style="background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; padding:10px 16px; min-width:140px; text-align:center; opacity:0.7;" title="Overhead from VS Code built-in tools — cannot be disabled">
			<div style="font-size:20px; font-weight:700; color:var(--text-secondary);">${fmt(builtinBloat)}</div>
			<div style="font-size:11px; color:var(--text-primary); opacity:0.75;">Built-in overhead</div>
			<div style="font-size:10px; color:var(--text-secondary); margin-top:2px;">not actionable</div>
		</div>` : ''}
	</div>`;
}

function buildUnderusedAgentPluginsHtml(underusedAgentPlugins: ToolCurationAnalysis['underusedAgentPlugins'], windowDays: number): string {
	if (underusedAgentPlugins.length === 0) { return ''; }
	const unusedCount = underusedAgentPlugins.filter(p => p.usedSkillCount === 0).length;
	const usedCount = underusedAgentPlugins.length - unusedCount;
	const title = `🧩 Agent Plugins in Last ${windowDays} Days (${underusedAgentPlugins.length})`;
	return `<details style="margin-top:8px;" open>
		<summary style="cursor:pointer; font-size:13px; font-weight:600; color:var(--text-primary); padding:6px 0;">
			${title}
		</summary>
		<div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin:6px 0;">
			${renderAgentPluginsFilter()}
			<span style="font-size:11px; color:var(--text-secondary);">${unusedCount} with no usage · ${usedCount} with usage</span>
		</div>
		<div style="margin-top:8px;">
			${renderAgentPluginsTable(underusedAgentPlugins, title)}
			<div style="margin-top:8px; font-size:11px; color:var(--text-secondary);">💡 Click <em>Manage Plugin</em> to open the Extensions view filtered to <code>@agentPlugins</code> where you can uninstall unused plugins to reclaim prompt budget.</div>
		</div>
	</details>`;
}

function buildMemoryFilesSectionHtml(analysis: MemoryFilesAnalysisView | null | undefined): string {
	try {
		if (!analysis || analysis.totalFiles === 0) { return ''; }

		return `
			<!-- Memory Files Section -->
			<div id="section-memory-files" class="section">
				<div class="section-title"><span>🦉</span><span>${escapeHtml(localize('memoryFiles.sectionTitle'))}</span></div>
				<div class="section-subtitle" style="color:var(--text-primary); opacity:0.75;">${escapeHtml(localize('memoryFiles.sectionSubtitle'))}</div>
				<div style="margin-bottom:8px; font-size:13px; color:var(--text-primary);">
					${escapeHtml(localizeFormat('memoryFiles.summary', formatNumber(analysis.totalFiles), formatFileSize(analysis.totalBytes)))}
					${analysis.staleFileCount > 0 ? ` · <span style="color:var(--vscode-editorWarning-foreground, #cca700);">${escapeHtml(localizeFormat('memoryFiles.staleSummary', analysis.staleFileCount, analysis.staleDays))}</span>` : ''}
					${analysis.largeFileCount > 0 ? ` · <span style="color:var(--vscode-editorWarning-foreground, #cca700);">${escapeHtml(localizeFormat('memoryFiles.largeSummary', analysis.largeFileCount, Math.round(analysis.largeFileBytes / 1024)))}</span>` : ''}
				</div>
				${renderMemoryFilesTable(analysis.byWorkspace)}
			</div>`;
	} catch (error) {
		console.error(`[usage-webview] buildMemoryFilesSectionHtml failed: ${error instanceof Error ? error.message : String(error)}`);
		return `
			<div id="section-memory-files" class="section">
				<div class="section-title"><span>🦉</span><span>${escapeHtml(localize('memoryFiles.sectionTitle'))}</span></div>
				<div class="section-subtitle" style="color:var(--text-primary); opacity:0.75;">${escapeHtml(localize('memoryFiles.renderError'))}</div>
			</div>`;
	}
}

function buildCurationSectionHtml(curation: ToolCurationAnalysis | null | undefined): string {
	try {
		if (!curation || curation.availableTools.length === 0) {
			traceCurationOnce('render-hidden-empty', 'buildCurationSectionHtml.hidden', {
				hasCurationObject: !!curation,
				availableTools: curation?.availableTools?.length ?? 0,
			});
			return '';
		}

		const { availableTools, unusedTools, underusedMcpServers, underusedAgentPlugins, estimatedPromptBloat, windowDays } = curation;
		const unusedSkills = unusedTools.filter(t => t.source === 'skill');
		const builtinTools = availableTools.filter(t => t.source === 'builtin');

		traceCuration('buildCurationSectionHtml.render', {
			availableTools: availableTools.length,
			unusedTools: unusedTools.length,
			unusedSkills: unusedSkills.length,
			mcpServers: underusedMcpServers.length,
		});

		return `
			<!-- Tool Curation Section -->
			<div id="section-tool-curation" class="section">
				<div class="section-title"><span>✂️</span><span>Tool Curation</span></div>
				<div class="section-subtitle" style="color:var(--text-primary); opacity:0.75;">Compare available tools against actual usage to reduce prompt overhead (last ${windowDays} days)</div>
				${buildCurationSummaryHtml(availableTools, unusedTools, estimatedPromptBloat)}
				${buildUnusedMcpHtml(underusedMcpServers, estimatedPromptBloat, windowDays)}
				${buildUnderusedAgentPluginsHtml(underusedAgentPlugins, windowDays)}
				${buildBuiltinToolsHtml(builtinTools, estimatedPromptBloat)}
				${buildUnusedSkillsHtml(unusedSkills)}
			</div>`;
	} catch (error) {
		traceCuration('buildCurationSectionHtml.error', {
			error: error instanceof Error ? error.message : String(error),
		});
		return `
			<div id="section-tool-curation" class="section">
				<div class="section-title"><span>✂️</span><span>Tool Curation</span></div>
				<div class="section-subtitle" style="color:var(--text-primary); opacity:0.75;">Tool curation is temporarily unavailable due to a rendering error. Try Refresh.</div>
			</div>`;
	}
}

function buildReposAndAgentTabPanelsHtml(): string {
	const repoLoadingMessage = repoPrStatsLoaded
		? 'Fetching repository PRs…'
		: 'Loading… (sign in with GitHub to see data)';
	const agentLoadingMessage = agentSessionsLoaded
		? 'Loading cloud agent snapshot…'
		: 'Loading… (sign in with GitHub to see data)';
	return `
		<div id="tab-panel-repos" class="tab-panel"${activeTab !== 'repos' ? ' style="display:none"' : ''}>
			<div class="section" id="repos-pr-content">
				<div class="section-title"><span>🤖</span><span>AI Activity in Repository PRs</span></div>
				<div class="section-subtitle">PRs from the last 30 days across your known repositories — authored or reviewed by AI agents.</div>
				<div style="margin-top:12px; color: var(--text-secondary); font-size:12px;">${repoLoadingMessage}</div>
			</div>
		</div>
		<div id="tab-panel-agent" class="tab-panel"${activeTab !== 'agent' ? ' style="display:none"' : ''}>
			<div class="section" id="agent-sessions-content">
				<div class="section-title"><span>🤖</span><span>Copilot Cloud Agent Sessions</span></div>
				<div class="section-subtitle">Cloud agent tasks and sessions from the last 30 days, fetched from the GitHub API.</div>
				<div style="margin-top:12px; color: var(--text-secondary); font-size:12px;">${agentLoadingMessage}</div>
			</div>
		</div>`;
}

/** Builds the primary + optional secondary action buttons for one insight card. */
function buildInsightActionButtonsHtml(insight: EvaluatedInsight, bg: string, border: string): string {
	const actionBtn = insight.actionLabel
		? `<button class="insight-action-btn" data-insight-id="${escapeHtml(insight.id)}" data-action="execute" data-command="${escapeHtml(insight.actionCommand ?? '')}"
				style="padding:5px 14px; font-size:12px; font-weight:600; cursor:pointer;
				border:1px solid ${border}; border-radius:5px;
				background:${bg}; color:var(--text-primary);">${escapeHtml(insight.actionLabel)}</button>`
		: '';
	const secondaryActionBtn = insight.secondaryActionLabel
		? `<button class="insight-action-btn" data-insight-id="${escapeHtml(insight.id)}" data-action="execute" data-command="${escapeHtml(insight.secondaryActionCommand ?? '')}"
				style="padding:5px 14px; font-size:12px; font-weight:600; cursor:pointer; margin-left:8px;
				border:1px solid ${border}; border-radius:5px;
				background:transparent; color:var(--text-primary);">${escapeHtml(insight.secondaryActionLabel)}</button>`
		: '';
	return actionBtn || secondaryActionBtn ? `<div style="margin-top:12px;">${actionBtn}${secondaryActionBtn}</div>` : '';
}

function buildInsightCardHtml(insight: EvaluatedInsight): string {
	const severityColors: Record<InsightSeverity, string> = {
		tip: 'rgba(96,165,250,0.12)',
		opportunity: 'rgba(251,191,36,0.12)',
		celebration: 'rgba(74,222,128,0.12)',
	};
	const severityBorder: Record<InsightSeverity, string> = {
		tip: 'rgba(96,165,250,0.5)',
		opportunity: 'rgba(251,191,36,0.5)',
		celebration: 'rgba(74,222,128,0.5)',
	};
	// Accent colour used for the primary action button per severity
	const severityAccent: Record<InsightSeverity, string> = {
		tip: 'rgba(96,165,250,0.85)',
		opportunity: 'rgba(251,191,36,0.85)',
		celebration: 'rgba(74,222,128,0.85)',
	};
	const bg = severityColors[insight.severity] ?? severityColors.tip;
	const border = severityBorder[insight.severity] ?? severityBorder.tip;
	const accent = severityAccent[insight.severity] ?? severityAccent.tip;
	const isNew = insight.status === 'new';
	const isDone = insight.status === 'done';

	const actionButtonsHtml = buildInsightActionButtonsHtml(insight, bg, border);

	const doneBtn = !isDone
		? `<button class="insight-action-btn" data-insight-id="${escapeHtml(insight.id)}" data-action="done"
				title="Mark as done"
				style="padding:5px 14px; font-size:12px; font-weight:600; cursor:pointer;
				border:1px solid ${border}; border-radius:5px;
				background:${accent}; color:#0d1117;">✓ Done</button>`
		: `<span style="font-size:12px; color:var(--text-secondary); opacity:0.5; padding:5px 6px;">✓ Done</span>`;

	const snoozeBtn = !isDone
		? `<button class="insight-action-btn" data-insight-id="${escapeHtml(insight.id)}" data-action="snooze"
				title="Snooze for 7 days"
				style="padding:5px 14px; font-size:12px; font-weight:500; cursor:pointer;
				border:1px solid ${border}; border-radius:5px;
				background:transparent; color:var(--text-primary);">⏸ Snooze</button>`
		: '';

	const dismissBtn = !isDone
		? `<button class="insight-action-btn" data-insight-id="${escapeHtml(insight.id)}" data-action="dismiss"
				title="Dismiss permanently"
				style="padding:4px 8px; font-size:14px; line-height:1; cursor:pointer; border:none; border-radius:4px;
				background:transparent; color:var(--text-primary); opacity:0.5;">✕</button>`
		: '';

	return `
		<div class="insight-card" id="${escapeHtml(insightCardElementId(insight.id))}" data-insight-id="${escapeHtml(insight.id)}"
			style="margin-bottom:12px; padding:16px 18px; border-radius:8px;
			background:${bg}; border:1px solid ${border};
			${isNew ? 'box-shadow:0 2px 8px ' + bg + ';' : ''}
			${isDone ? 'opacity:0.45;' : ''}">
			<div style="display:flex; align-items:flex-start; gap:10px;">
				<div style="flex:1;">
					<div style="font-size:13px; font-weight:700; color:var(--text-primary); margin-bottom:8px; display:flex; align-items:center; gap:8px;">
						${isNew ? `<span style="font-size:10px; padding:2px 7px; border-radius:10px; background:${accent}; color:#0d1117; font-weight:700; letter-spacing:0.04em;">NEW</span>` : ''}
						${escapeHtml(insight.title)}
					</div>
					<div style="font-size:12px; color:var(--text-primary); line-height:1.5; opacity:0.85; white-space:pre-wrap;">${escapeHtml(insight.body)}</div>
					${actionButtonsHtml}
				</div>
				<div style="flex-shrink:0; margin-top:-4px;">
					${dismissBtn}
				</div>
			</div>
			<div style="display:flex; gap:8px; margin-top:14px; justify-content:flex-end; border-top:1px solid ${border}; padding-top:10px;">
				${doneBtn}
				${snoozeBtn}
			</div>
		</div>`;
}

function buildInsightsTabPanelHtml(insights: EvaluatedInsight[]): string {
	const applicable = insights.filter(i => i.status !== 'dismissed');
	const newInsights = applicable.filter(i => i.status === 'new');
	const otherInsights = applicable.filter(i => i.status !== 'new' && i.status !== 'done');

	const forYouSection = newInsights.length > 0
		? `<div style="margin-bottom:20px;">
			<div style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-secondary); letter-spacing:0.05em; margin-bottom:10px;">✨ For You</div>
			${newInsights.map(buildInsightCardHtml).join('')}
		</div>`
		: `<div style="margin-bottom:20px; padding:16px; background:var(--bg-tertiary); border-radius:8px; font-size:12px; color:var(--text-secondary); text-align:center;">
			🎉 No new insights right now — keep using Copilot and check back later!
		</div>`;

	const allSection = otherInsights.length > 0
		? `<div>
			<div style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-secondary); letter-spacing:0.05em; margin-bottom:10px;">All Tips</div>
			${otherInsights.map(buildInsightCardHtml).join('')}
		</div>`
		: '';

	return `
		<div id="tab-panel-insights" class="tab-panel"${activeTab !== 'insights' ? ' style="display:none"' : ''}>
			<div class="section">
				<div class="section-title"><span>💡</span><span>Insights</span></div>
				<div class="section-subtitle">
					Personalized tips based on your usage patterns. Tips are data-driven — they only appear when relevant to how you code with AI.
				</div>
				<div id="insights-container" style="margin-top:16px;">
					${forYouSection}
					${allSection}
				</div>
			</div>
		</div>`;
}

/** Gathers what the tab strip needs out of module state and the current stats. */
function usageTabStripInput(stats: UsageAnalysisStats): UsageTabStripInput {
	return {
		activeTab,
		newInsightCount: (stats.insights ?? []).filter(i => i.status === 'new').length,
		correctionSessionCount: stats.correctionReport?.sessionsWithMoments ?? 0,
		readinessButtonHtml: darkFactoryTab.button(activeTab),
	};
}

// ── Skill suggestions (repeated tasks) ──────────────────────────────────────

function buildRepeatedTaskSessionLinkHtml(session: RepeatedTaskSessionRef): string {
	const title = session.title || session.file.split(/[\\/]/).pop() || session.file;
	const date = session.lastInteraction ? new Date(session.lastInteraction) : null;
	const dateLabel = date && !isNaN(date.getTime()) ? date.toLocaleDateString() : '';
	const repo = session.repository ? ` · ${session.repository}` : '';
	return `<div style="font-size:11px; color:var(--text-secondary); padding:2px 0; overflow-wrap:anywhere;">${escapeHtml(title)}${escapeHtml(dateLabel ? ` · ${dateLabel}` : '')}${escapeHtml(repo)}</div>`;
}

function buildRepeatedTaskClusterHtml(cluster: RepeatedTaskCluster): string {
	const keywords = cluster.sharedKeywords.length > 0
		? `<div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:4px;">${cluster.sharedKeywords.map(k => `<span style="font-size:10px; padding:1px 7px; border-radius:8px; background:var(--bg-tertiary); color:var(--text-secondary);">${escapeHtml(k)}</span>`).join('')}</div>`
		: '';
	return `
		<div style="margin-top:10px; padding:12px 14px; border-radius:8px; background:var(--bg-tertiary); border:1px solid var(--border-color, transparent);">
			<div style="display:flex; align-items:flex-start; gap:10px;">
				<span style="flex-shrink:0; font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; background:rgba(74,222,128,0.15); border:1px solid rgba(74,222,128,0.5); color:var(--text-primary); white-space:nowrap;">${cluster.sessionCount}× repeated</span>
				<div style="flex:1; min-width:0; font-size:12px; color:var(--text-primary); font-style:italic; overflow-wrap:anywhere;">&ldquo;${escapeHtml(cluster.representativePrompt)}&rdquo;</div>
			</div>
			${keywords}
			<details style="margin-top:8px;">
				<summary style="font-size:11px; color:var(--text-secondary); cursor:pointer;">Sessions (${cluster.sessions.length})</summary>
				<div style="margin-top:4px;">${cluster.sessions.map(buildRepeatedTaskSessionLinkHtml).join('')}</div>
			</details>
		</div>`;
}

/** "Skill suggestions" section for the Tools & Integrations tab (empty string when no candidates). */
function buildSkillSuggestionsSectionHtml(report: RepeatedTaskReport | null): string {
	if (!report || report.clusters.length === 0) { return ''; }
	return `
		<div class="section" id="section-skill-suggestions">
			<div class="section-title"><span>🧩</span><span>Skill Suggestions</span></div>
			<div class="section-subtitle">
				Tasks you keep prompting for across sessions (first prompt per session, ${report.sessionsScanned} sessions scanned).
				A repeated task is a good candidate for a reusable skill, prompt file, or custom agent.
			</div>
			${report.clusters.map(buildRepeatedTaskClusterHtml).join('')}
		</div>`;
}

const CORRECTION_TYPE_META: Record<CorrectionMomentType, { label: string; color: string }> = {
	'user-correction': { label: 'You corrected the agent', color: 'rgba(251,191,36,0.85)' },
	'tool-error': { label: 'Tool failed', color: 'rgba(248,113,113,0.85)' },
	'edit-retry': { label: 'Edit retry', color: 'rgba(251,146,60,0.85)' },
	'edit-self-correction': { label: 'Edit self-correction', color: 'rgba(251,146,60,0.85)' },
	'agent-self-correction': { label: 'Agent caught itself', color: 'rgba(96,165,250,0.85)' },
};

function buildCorrectionMomentHtml(moment: CorrectionMoment, sessionFile: string): string {
	const meta = CORRECTION_TYPE_META[moment.type] ?? { label: moment.type, color: 'rgba(148,163,184,0.85)' };
	const time = moment.timestamp ? new Date(moment.timestamp) : null;
	const timeLabel = time && !isNaN(time.getTime()) ? time.toLocaleString() : '';
	const detail = moment.type === 'tool-error'
		? `tool \`${moment.tool ?? '?'}\`${moment.retried ? ' — retried shortly after' : ''}`
		: (moment.matchedPattern ? `matched ${moment.matchedPattern}` : '');
	const escalationBadge = moment.escalated
		? `<span title="Clustered with an earlier correction a few turns back" style="flex-shrink:0; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px; border:1px solid rgba(248,113,113,0.85); color:var(--text-primary); background:rgba(248,113,113,0.12); white-space:nowrap;">📈 escalating</span>`
		: '';
	const intensityBadge = moment.intensity === 'strong'
		? `<span title="Shouting / repeated punctuation / an intensifier like &quot;again&quot;" style="flex-shrink:0; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px; border:1px solid rgba(248,113,113,0.85); color:var(--text-primary); background:rgba(248,113,113,0.12); white-space:nowrap;">🔥 intense</span>`
		: '';
	return `
		<button type="button" class="correction-moment" data-correction-file="${escapeHtml(sessionFile)}" data-correction-turn="${moment.turnNumber}" title="Open this turn in the session log viewer" style="display:flex; width:100%; gap:10px; align-items:flex-start; padding:8px 0; border:0; border-bottom:1px solid var(--bg-tertiary); background:none; color:inherit; cursor:pointer; text-align:left;">
			<span style="flex-shrink:0; font-size:10px; font-weight:700; letter-spacing:0.03em; padding:2px 8px; border-radius:10px; border:1px solid ${meta.color}; color:var(--text-primary); background:${meta.color.replace('0.85', '0.12')}; white-space:nowrap;">${escapeHtml(meta.label)}</span>
			${escalationBadge}${intensityBadge}
			<div style="flex:1; min-width:0;">
				<div style="font-size:12px; color:var(--text-primary); opacity:0.9; overflow-wrap:anywhere;">${escapeHtml(moment.snippet)}</div>
				<div style="font-size:11px; color:var(--text-secondary); margin-top:3px;">
					turn ${moment.turnNumber}${detail ? ` · ${escapeHtml(detail)}` : ''}${timeLabel ? ` · ${escapeHtml(timeLabel)}` : ''}
				</div>
			</div>
		</button>`;
}

function buildCorrectionSessionHtml(session: CorrectionSessionEntry, moments: CorrectionMoment[]): string {
	const title = session.title || session.file.split(/[\\/]/).pop() || session.file;
	const date = session.lastInteraction ? new Date(session.lastInteraction) : null;
	const dateLabel = date && !isNaN(date.getTime()) ? date.toLocaleDateString() : '';
	const totalMoments = session.totalMoments ?? session.moments.length;
	const truncatedLabel = totalMoments > session.moments.length
		? ` · showing ${session.moments.length} of ${totalMoments} moments`
		: '';
	return `
		<div style="margin:10px 0 4px; padding:10px 12px; background:var(--bg-tertiary); border-radius:6px;">
			<div style="font-size:12px; font-weight:600; color:var(--text-primary); overflow-wrap:anywhere;">
				${escapeHtml(title)}${dateLabel || truncatedLabel ? ` <span style="font-weight:400; color:var(--text-secondary);">${dateLabel ? `· ${escapeHtml(dateLabel)}` : ''}${escapeHtml(truncatedLabel)}</span>` : ''}
			</div>
			${moments.map(moment => buildCorrectionMomentHtml(moment, session.file)).join('')}
		</div>`;
}

/** "Ask Copilot to fix this" + "Copy prompt" buttons for one repository's correction section. */
function buildCorrectionRepoActionsHtml(repository: string): string {
	const repoAttr = escapeHtml(repository);
	return `
		<div style="display:flex; gap:6px;">
			<button type="button" class="correction-ask-copilot" data-correction-repo="${repoAttr}"
				title="Send these correction examples to Copilot Chat and ask how to improve this workspace's setup"
				style="font-size:11px; padding:3px 10px; border-radius:5px; border:1px solid var(--vscode-focusBorder); background:var(--vscode-button-secondaryBackground); color:var(--text-primary); cursor:pointer;">🤖 Ask Copilot to fix this</button>
			<button type="button" class="correction-copy-prompt" data-correction-repo="${repoAttr}"
				title="Copy the same prompt to paste into another workspace's Copilot Chat"
				style="font-size:11px; padding:3px 10px; border-radius:5px; border:1px solid transparent; background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer;">📋 Copy prompt</button>
		</div>`;
}

const CORRECTION_FILTER_LABELS: Record<CorrectionFilter, string> = {
	'user-correction': 'User corrections',
	'tool-error': 'Tool errors',
	'edit-retry': 'Edit retries',
	'edit-self-correction': 'Edit self-corrections',
	'agent-self-correction': 'Agent self-corrections',
	'escalated': 'Escalating corrections',
};

/** True when a moment satisfies the active corrections filter (null filter = everything). */
function correctionMomentMatchesFilter(moment: CorrectionMoment, filter: CorrectionFilter | null): boolean {
	if (!filter) { return true; }
	if (filter === 'escalated') { return moment.escalated === true; }
	return moment.type === filter;
}

/** Small "✕ Clear filter" button shown whenever a corrections filter is active. */
function buildCorrectionClearFilterButtonHtml(): string {
	return `<button type="button" class="correction-clear-filter" title="Show every correction moment again" style="font-size:11px; padding:2px 10px; border-radius:10px; border:1px solid var(--border-color, transparent); background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer;">✕ Clear filter</button>`;
}

/** One filter pill. Active pills are outlined, bold and carry a ✕ so the active state is unmistakable. */
function correctionFilterChipHtml(count: number, label: string, filter: CorrectionFilter, accent?: string): string {
	if (!(count > 0)) { return ''; }
	const active = activeCorrectionFilter === filter;
	const border = active ? 'var(--vscode-focusBorder)' : (accent ?? 'transparent');
	const background = active ? 'var(--vscode-button-secondaryBackground, var(--bg-tertiary))' : (accent ? accent.replace('0.85', '0.12') : 'var(--bg-tertiary)');
	const title = active ? `Showing only ${label} — select again to clear` : `Show only ${label}`;
	return `<button type="button" data-correction-filter="${filter}" aria-pressed="${active}" title="${escapeHtml(title)}" style="font-size:11px; font-weight:${active ? '700' : '400'}; padding:2px 10px; border-radius:10px; border:1px solid ${border}; background:${background}; color:var(--text-primary); cursor:pointer; box-shadow:${active ? '0 0 0 1px var(--vscode-focusBorder)' : 'none'};">${count} ${escapeHtml(label)}${active ? ' ✕' : ''}</button>`;
}

/** The full pill row, including the escalating pill which filters across types. */
function buildCorrectionFilterChipsHtml(c: CorrectionCounts): string {
	return [
		correctionFilterChipHtml(c.userCorrections, 'user corrections', 'user-correction'),
		correctionFilterChipHtml(c.toolErrors, 'tool errors', 'tool-error'),
		correctionFilterChipHtml(c.editRetries, 'edit retries', 'edit-retry'),
		correctionFilterChipHtml(c.editSelfCorrections, 'edit self-corrections', 'edit-self-correction'),
		correctionFilterChipHtml(c.agentSelfCorrections, 'agent self-corrections', 'agent-self-correction'),
		correctionFilterChipHtml(c.escalatedUserCorrections, '📈 escalating', 'escalated', 'rgba(248,113,113,0.85)'),
	].filter(Boolean).join(' ');
}

/** "Showing X of Y moments" bar so it is always clear what the list below is filtered to. */
function buildCorrectionFilterStatusHtml(report: CorrectionReport): string {
	const sampled = report.repos.flatMap(repo => repo.sessions.flatMap(session => session.moments));
	const shown = sampled.filter(moment => correctionMomentMatchesFilter(moment, activeCorrectionFilter)).length;
	const summary = activeCorrectionFilter
		? `Showing <strong>${shown}</strong> of <strong>${sampled.length}</strong> listed correction moments — filtered by <strong>${escapeHtml(CORRECTION_FILTER_LABELS[activeCorrectionFilter])}</strong>`
		: `Showing all <strong>${sampled.length}</strong> listed correction moments — no filter active`;
	return `
		<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:10px; padding:6px 10px; border-radius:6px; background:var(--bg-tertiary); border-left:3px solid ${activeCorrectionFilter ? 'var(--vscode-focusBorder)' : 'transparent'}; font-size:11px; color:var(--text-secondary);">
			<span id="corrections-filter-status">${summary}</span>
			${activeCorrectionFilter ? buildCorrectionClearFilterButtonHtml() : ''}
		</div>`;
}

/** One repository's session list within the Corrections tab, or '' if the active filter leaves nothing to show. */
function buildCorrectionRepoSectionHtml(repo: CorrectionRepoGroup, activeFilter: CorrectionFilter | null): string {
	const sessions = repo.sessions
		.map(session => ({
			session,
			moments: session.moments.filter(moment => correctionMomentMatchesFilter(moment, activeFilter)),
		}))
		.filter(({ moments }) => moments.length > 0);
	if (sessions.length === 0) { return ''; }
	const shownMoments = sessions.reduce((sum, { moments }) => sum + moments.length, 0);
	const sessionLabel = activeFilter
		? `— ${sessions.length} of ${repo.sessions.length} session${repo.sessions.length !== 1 ? 's' : ''} match · ${shownMoments} moment${shownMoments !== 1 ? 's' : ''}`
		: `— ${sessions.length} session${sessions.length !== 1 ? 's' : ''} with moments · ${shownMoments} moment${shownMoments !== 1 ? 's' : ''}`;
	return `
	<div style="margin-top:18px;">
		<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:4px;">
			<div style="font-size:12px; font-weight:700; color:var(--text-primary);">
				${escapeHtml(repo.repository)}
				<span style="font-weight:400; color:var(--text-secondary);">${escapeHtml(sessionLabel)}</span>
			</div>
			${buildCorrectionRepoActionsHtml(repo.repository)}
		</div>
		${sessions.map(({ session, moments }) => buildCorrectionSessionHtml(session, moments)).join('')}
	</div>`;
}

function buildCorrectionsTabPanelHtml(report: CorrectionReport | null | undefined): string {
	if (typeof report === 'undefined') {
		return `
		<div id="tab-panel-corrections" class="tab-panel"${activeTab !== 'corrections' ? ' style="display:none"' : ''}>
			<div class="section">
				<div class="section-title"><span>🔁</span><span>Corrections</span></div>
				<div class="section-subtitle">Moments where the agent corrected itself after an error, or you had to correct the agent.</div>
				<div style="margin-top:16px; padding:16px; background:var(--bg-tertiary); border-radius:8px; font-size:12px; color:var(--text-secondary); text-align:center;">
					⏳ Scanning recent sessions for correction moments…
				</div>
			</div>
		</div>`;
	}

	if (!report || report.repos.length === 0) {
		return `
		<div id="tab-panel-corrections" class="tab-panel"${activeTab !== 'corrections' ? ' style="display:none"' : ''}>
			<div class="section">
				<div class="section-title"><span>🔁</span><span>Corrections</span></div>
				<div class="section-subtitle">Moments where the agent corrected itself after an error, or you had to correct the agent.</div>
				<div style="margin-top:16px; padding:16px; background:var(--bg-tertiary); border-radius:8px; font-size:12px; color:var(--text-secondary); text-align:center;">
					✨ No correction moments detected in your recent sessions — nice and smooth!
				</div>
			</div>
		</div>`;
	}

	const summaryChips = buildCorrectionFilterChipsHtml(report.counts);
	const repoSections = report.repos.map(repo => buildCorrectionRepoSectionHtml(repo, activeCorrectionFilter)).join('');
	const statusBar = buildCorrectionFilterStatusHtml(report);
	const emptyFilteredState = activeCorrectionFilter && !repoSections
		? `<div style="margin-top:16px; padding:16px; background:var(--bg-tertiary); border-radius:8px; font-size:12px; color:var(--text-secondary); text-align:center;">
				No <strong>${escapeHtml(CORRECTION_FILTER_LABELS[activeCorrectionFilter].toLowerCase())}</strong> appear in the detail sample below.
				The pill counts cover every detected moment, while each long session only lists a capped sample of its moments — so a counted moment can sit outside this list.
				<div style="margin-top:10px;">${buildCorrectionClearFilterButtonHtml()}</div>
			</div>`
		: '';

	return `
		<div id="tab-panel-corrections" class="tab-panel"${activeTab !== 'corrections' ? ' style="display:none"' : ''}>
			<div class="section">
				<div class="section-title"><span>🔁</span><span>Corrections</span></div>
				<div class="section-subtitle">
					Moments where the agent corrected itself after an error, or you had to correct the agent —
					heuristic detection over each repository's ${report.sessionsPerRepo} most recent sessions with detected moments —
					sessions without corrections are not listed. Summary counts include all detected moments; long sessions show a capped detail sample.
					Pattern-based matches are candidates, not verdicts; open the session in the log viewer for full context.
				</div>
				<div style="font-size:11px; color:var(--text-secondary); margin-top:12px;">Filter the list below — select a pill to drill down, select it again to clear.</div>
				<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">${summaryChips}</div>
				${statusBar}
				${repoSections}
				${emptyFilteredState}
			</div>
		</div>`;
}

/** Finds the repo group backing a correction "Ask Copilot"/"Copy prompt" button, and builds its prompt. */
function buildCorrectionPromptForRepo(repository: string): string | null {
	const repo = currentCorrectionReport?.repos.find(r => r.repository === repository);
	return repo ? buildCorrectionImprovementPrompt(repo) : null;
}

/** Handles a click on either the "Ask Copilot to fix this" or "Copy prompt" correction button. Returns true if handled. */
function handleCorrectionPromptButtonClick(target: HTMLElement): boolean {
	const askCopilotButton = target.closest<HTMLButtonElement>('button.correction-ask-copilot');
	if (askCopilotButton) {
		const repository = askCopilotButton.getAttribute('data-correction-repo');
		const prompt = repository ? buildCorrectionPromptForRepo(repository) : null;
		if (prompt) { vscode.postMessage({ command: 'openCopilotChatWithPrompt', prompt }); }
		return true;
	}
	const copyPromptButton = target.closest<HTMLButtonElement>('button.correction-copy-prompt');
	if (copyPromptButton) {
		const repository = copyPromptButton.getAttribute('data-correction-repo');
		const prompt = repository ? buildCorrectionPromptForRepo(repository) : null;
		if (prompt) {
			navigator.clipboard.writeText(prompt).then(() => {
				const original = copyPromptButton.textContent;
				copyPromptButton.textContent = '✅ Copied!';
				setTimeout(() => { copyPromptButton.textContent = original; }, 2000);
			});
		}
		return true;
	}
	return false;
}

function wireCorrectionInteractions(): void {
	const panel = document.getElementById('tab-panel-corrections');
	if (!panel) { return; }
	panel.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		if (target.closest('button.correction-clear-filter')) {
			activeCorrectionFilter = null;
			renderCorrectionsPanel();
			return;
		}
		const filterButton = target.closest<HTMLButtonElement>('button[data-correction-filter]');
		if (filterButton) {
			const filter = filterButton.getAttribute('data-correction-filter') as CorrectionFilter | null;
			if (!filter || !CORRECTION_FILTERS.includes(filter)) { return; }
			activeCorrectionFilter = activeCorrectionFilter === filter ? null : filter;
			renderCorrectionsPanel();
			return;
		}
		if (handleCorrectionPromptButtonClick(target)) { return; }
		const moment = target.closest<HTMLButtonElement>('button.correction-moment');
		if (!moment) { return; }
		const file = moment.getAttribute('data-correction-file');
		const turnNumber = Number(moment.getAttribute('data-correction-turn'));
		if (file && Number.isSafeInteger(turnNumber) && turnNumber > 0) {
			vscode.postMessage({ command: 'openSessionFile', file, turnNumber });
		}
	});
}

function renderCorrectionsPanel(): void {
	const panel = document.getElementById('tab-panel-corrections');
	if (!panel) { return; }
	setHtml(panel, buildCorrectionsTabPanelHtml(currentCorrectionReport));
	wireCorrectionInteractions();
}


function updateTabButtonCount(insights: EvaluatedInsight[]): void {
	const tabButton = document.querySelector<HTMLButtonElement>('.tab-button[data-tab="insights"]');
	if (!tabButton) { return; }
	const newCount = insights.filter(i => i.status === 'new').length;
	const badgeHtml = newCount > 0
		? ` <span style="background:rgba(96,165,250,0.4);border-radius:10px;padding:1px 6px;font-size:11px;">${newCount}</span>`
		: '';
	const titleOnly = '<span class="codicon codicon-lightbulb"></span> Insights';
	setHtml(tabButton, titleOnly + badgeHtml);
}

function refreshInsightsPanel(insights: EvaluatedInsight[]): void {
	const container = document.getElementById('insights-container');
	if (!container) { return; }
	currentInsights = insights;
	const forYou = insights.filter(i => i.status === 'new');
	const other = insights.filter(i => i.status !== 'new' && i.status !== 'dismissed' && i.status !== 'done');

	const forYouSection = forYou.length > 0
		? `<div style="margin-bottom:20px;">
			<div style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-secondary); letter-spacing:0.05em; margin-bottom:10px;">✨ For You</div>
			${forYou.map(buildInsightCardHtml).join('')}
		</div>`
		: `<div style="margin-bottom:20px; padding:16px; background:var(--bg-tertiary); border-radius:8px; font-size:12px; color:var(--text-secondary); text-align:center;">
			🎉 No new insights right now — keep using Copilot and check back later!
		</div>`;

	const allSection = other.length > 0
		? `<div>
			<div style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-secondary); letter-spacing:0.05em; margin-bottom:10px;">All Tips</div>
			${other.map(buildInsightCardHtml).join('')}
		</div>`
		: '';

	setHtml(container, forYouSection + allSection);
	wireInsightCardButtons();
	updateTabButtonCount(insights);
	// A deep link that arrived before its card was in the list is still sitting unconsumed, and
	// this re-render is the only thing that runs for an insights-only update — nothing else would
	// scroll to the card that just appeared, and the focus window may already have lapsed waiting
	// for exactly this.
	if (pendingTabAnchor && isInsightCardAnchor(pendingTabAnchor) && activeTab === 'insights') {
		scrollToPendingTabAnchor();
	}
	// Every card was just replaced, so a target that *was* resolved no longer exists in the DOM.
	// Re-resolve it against the new cards.
	reapplyFocusedInsightAnchor();
}

function _postOpenFileFromList(pathsJson: string | null): void {
	if (!pathsJson) { return; }
	try {
		const paths = JSON.parse(pathsJson) as string[];
		vscode.postMessage({ command: 'openFileFromList', paths });
	} catch (error) {
		traceCuration('wireCurationButtons.badPathsJson', { error: error instanceof Error ? error.message : String(error) });
	}
}

function _handleCurationBtnClick(btn: HTMLButtonElement): void {
	const command = btn.getAttribute('data-command');
	if (!command) { return; }
	if (command === 'openFile') {
		const filePath = btn.getAttribute('data-path');
		if (filePath) { vscode.postMessage({ command: 'openFile', path: filePath }); }
	} else if (command === 'openFileFromList') {
		_postOpenFileFromList(btn.getAttribute('data-paths'));
	} else if (command === 'manageExtension') {
		const extensionId = btn.getAttribute('data-extension-id');
		if (extensionId) { vscode.postMessage({ command: 'manageExtension', extensionId }); }
	} else if (command === 'openAgentPlugins') {
		const pluginName = btn.getAttribute('data-plugin-name') ?? '';
		vscode.postMessage({ command: 'openAgentPlugins', pluginName });
	} else {
		vscode.postMessage({ command });
	}
}

function handleCurationClick(event: Event, section: HTMLElement): void {
	const target = event.target;
	if (!(target instanceof Element)) { return; }
	const button = target.closest<HTMLButtonElement>('.curation-file-btn');
	if (button) { _handleCurationBtnClick(button); }
}

function wireCurationButtons(): void {
	try {
		const section = document.getElementById('section-tool-curation');
		if (!section) {
			traceCurationOnce('wire-no-section', 'wireCurationButtons.noSection');
			return;
		}
		if (section.dataset.curationInteractionsWired === 'true') { return; }
		section.dataset.curationInteractionsWired = 'true';
		traceCuration('wireCurationButtons.bind', { buttons: section.querySelectorAll('.curation-file-btn').length });
		section.addEventListener('click', event => {
			try {
				handleCurationClick(event, section);
			} catch (error) {
				traceCuration('wireCurationButtons.clickError', { error: error instanceof Error ? error.message : String(error) });
			}
		});
	} catch (error) {
		traceCuration('wireCurationButtons.error', { error: error instanceof Error ? error.message : String(error) });
	}
}

function wireInsightCardButtons(): void {
	const container = document.getElementById('insights-container');
	if (!container) { return; }
	container.querySelectorAll<HTMLButtonElement>('.insight-action-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			const id = btn.getAttribute('data-insight-id');
			const action = btn.getAttribute('data-action');
			if (!id || !action) { return; }
			if (action === 'execute') {
				const command = btn.getAttribute('data-command');
				if (command) { vscode.postMessage({ command }); }
			} else {
				vscode.postMessage({ command: 'insightAction', id, action });
			}
		});
	});
}


function buildUsageRootHtml(
	stats: UsageAnalysisStats,
	customizationHtml: string,
	multiModelHtml: string,
	thinkingEffortHtml: string,
	sessionsSummaryHtml: string,
	todayTotalRefs: number,
	last30DaysTotalRefs: number,
	allToolKeys: string[],
	allMcpToolKeys: string[],
	allMcpServerKeys: string[],
	allHighCostModels: string[],
	allLowCostModels: string[],
	allMediumCostModels: string[],
	allUnknownModels: string[],
): string {
	return `
		<style>${themeStyles}</style><style>${dataTableStyles}</style>
		<style>${styles}</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">📊</span>
					<span class="header-title">Usage Analysis</span>
				</div>
				<div class="button-row">
				${navButtonsHtml('btn-usage', !!stats.backendConfigured)}
				</div>
			</div>

			<div class="info-box">
				<div class="info-box-title info-box-toggle" id="about-info-toggle" role="button" tabindex="0" aria-expanded="${!aboutCollapsed}" aria-controls="about-info-body">
					<span>📋 About This Dashboard</span>
					<span class="info-box-chevron" aria-hidden="true">${aboutCollapsed ? '▸' : '▾'}</span>
				</div>
				<div class="info-box-body" id="about-info-body"${aboutCollapsed ? ' style="display:none"' : ''}>
					This dashboard analyzes your GitHub Copilot usage patterns by examining session log files.
					It tracks modes (ask/edit/agent), tool usage, context references (#file, @workspace, etc.),
					and MCP (Model Context Protocol) tools to help you understand how you interact with Copilot.
				</div>
			</div>

			${buildTabStripHtml(usageTabStripInput(stats))}

			${safeSectionHtml('Recent Sessions', () => buildSessionsTabPanelHtml(stats))}
			${safeSectionHtml('My Activity', () => buildActivityTabPanelHtml(stats, multiModelHtml, thinkingEffortHtml, sessionsSummaryHtml, todayTotalRefs, last30DaysTotalRefs))}
			${safeSectionHtml('Tools & Integrations', () => buildToolsTabPanelHtml(stats, allToolKeys, allMcpToolKeys, allMcpServerKeys, allHighCostModels, allLowCostModels, allMediumCostModels, allUnknownModels))}
			${safeSectionHtml('Workspace Health', () => buildHealthTabPanelHtml(customizationHtml, stats))}
			${safeSectionHtml('Repository PRs & Cloud Agent', () => buildReposAndAgentTabPanelsHtml())}
			${safeSectionHtml('AI Readiness', () => darkFactoryTab.panel(activeTab))}
			${safeSectionHtml('Worktrees', () => buildWorktreesTabPanelHtml())}
			${safeSectionHtml('Insights', () => buildInsightsTabPanelHtml(stats.insights ?? []))}
			${safeSectionHtml('Corrections', () => buildCorrectionsTabPanelHtml(stats.correctionReport))}
			<div class="footer">
				Last updated: ${escapeHtml(new Date(stats.lastUpdated).toLocaleString())} · Updates every 5 minutes
			</div>
		</div>
`;
}

function renderWorktreeRootsList(): string {
	if (worktreeRoots.length === 0) {
		return `<div style="color: var(--text-muted); font-size: 12px; margin: 8px 0;">No root folders added yet. Add a folder to scan for worktrees.</div>`;
	}
	// With more than 2 locations the list gets long, so collapse it by default and show a count.
	const collapsible = worktreeRoots.length > 2;
	const showList = !collapsible || worktreeRootsExpanded;
	const toggle = collapsible
		? `<button class="worktree-roots-toggle" id="btn-toggle-worktree-roots" aria-expanded="${worktreeRootsExpanded}"><span class="worktree-caret">${worktreeRootsExpanded ? "▼" : "▶"}</span>${worktreeRoots.length} root folders found</button>`
		: "";
	const list = showList
		? `<div class="worktree-roots-list">${worktreeRoots
			.map(
				(r, i) =>
					`<div class="worktree-root-item"><span title="${escapeHtml(r)}">${escapeHtml(r)}</span><button class="button secondary worktree-remove-root" data-index="${i}" ${worktreeScanInProgress ? "disabled" : ""}>✕</button></div>`,
			)
			.join("")}</div>`
		: "";
	return toggle + list;
}

function _renderWorktreeEnrichingProgress(s: WorktreeScanStatus, seconds: string): string {
	const done = s.enriched ?? 0;
	const total = s.enrichTotal ?? 0;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;
	return `
    <div class="info-box" style="margin-top: 12px;">
      <div class="info-box-title">📦 Computing sizes &amp; push status…</div>
      <div>${done} / ${total} worktree${total === 1 ? "" : "s"} analyzed (${seconds}s)</div>
      <div class="worktree-progress-bar"><div class="worktree-progress-fill" style="width: ${pct}%;"></div></div>
    </div>`;
}

function _renderWorktreeScanningProgress(s: WorktreeScanStatus, seconds: string): string {
	const walking = s.phase === "walking";
	const title = walking ? "🔍 Scanning folder…" : "⏳ Checking markers…";
	const dirs = s.dirsScanned ?? 0;
	const detail = walking
		? `Exploring for git worktrees — ${dirs} folder${dirs === 1 ? "" : "s"} scanned (${seconds}s)`
		: `${s.checked} / ${s.total || "?"} .git markers checked — ${s.foundCount} worktree${s.foundCount === 1 ? "" : "s"} found so far (${seconds}s)`;
	const pct = walking ? 100 : (s.total > 0 ? Math.round((s.checked / s.total) * 100) : 0);
	const fillClass = walking ? "worktree-progress-fill indeterminate" : "worktree-progress-fill";
	return `
    <div class="info-box" style="margin-top: 12px;">
      <div class="info-box-title">${title}</div>
      <div>Folder: <span style="font-family: var(--vscode-editor-font-family, monospace);">${escapeHtml(s.root || "…")}</span></div>
      <div>${detail}</div>
      <div class="worktree-progress-bar"><div class="${fillClass}" style="width: ${pct}%;"></div></div>
    </div>`;
}

function renderWorktreeProgress(): string {
	if (!worktreeScanInProgress) { return ""; }
	const s = worktreeScanStatus;
	const seconds = (s.elapsedMs / 1000).toFixed(1);
	if (s.phase === "enriching") { return _renderWorktreeEnrichingProgress(s, seconds); }
	return _renderWorktreeScanningProgress(s, seconds);
}

/** Banner noting that the visible results came from the once-daily automatic scan, not one the user just ran. */
function renderWorktreeBackgroundScanBanner(): string {
	if (!worktreeBackgroundScanMeta || worktreeScanInProgress || worktreeResults.length === 0) { return ""; }
	const when = escapeHtml(new Date(worktreeBackgroundScanMeta.scannedAt).toLocaleString());
	const size = formatFileSize(worktreeBackgroundScanMeta.totalBytes);
	const count = worktreeResults.length;
	return `<div class="info-box" style="margin-top: 12px;"><div>🌳 Found automatically by the daily background scan: ${size} across ${count} worktree${count === 1 ? "" : "s"}, last checked ${when}. Scan again for the latest.</div></div>`;
}

function renderWorktreeControls(): string {
	return `
    <div class="section">
      <div class="section-title"><span class="codicon codicon-folder-opened"></span><span>Root Folders</span></div>
      <div id="worktree-roots-list">${renderWorktreeRootsList()}</div>
      <div class="folder-input-row" style="margin-top: 8px;">
        <input
          type="text"
          id="worktree-root-input"
          class="folder-input"
          placeholder="Paste a root folder path here, e.g. C:\\code\\repos"
          ${worktreeScanInProgress ? "disabled" : ""}
        />
        <button class="button secondary" id="btn-browse-worktree-root" ${worktreeScanInProgress ? "disabled" : ""}>📂 Browse…</button>
        <button class="button secondary" id="btn-add-worktree-root" ${worktreeScanInProgress ? "disabled" : ""}>➕ Add</button>
      </div>
      <div style="margin-top: 16px;">
        <button class="button" id="btn-scan-worktrees" ${worktreeScanInProgress || worktreeCleanupInProgress || worktreeRoots.length === 0 ? "disabled" : ""}>🔍 Scan for Worktrees</button>
        ${worktreeScanInProgress ? '<button class="button secondary" id="btn-cancel-worktree-scan">✕ Cancel</button>' : ""}
      </div>
      ${renderWorktreeBackgroundScanBanner()}
      ${worktreeScanError ? `<div class="info-box" style="margin-top: 12px; border-color: #d97706; background: rgba(217,119,6,0.08);"><div>⚠️ ${escapeHtml(worktreeScanError)}</div></div>` : ""}
      <div id="worktree-progress-area">${renderWorktreeProgress()}</div>
    </div>`;
}

function groupWorktreesByRepo(results: WorktreeResult[]): Map<string, WorktreeResult[]> {
	const groups = new Map<string, WorktreeResult[]>();
	for (const wt of results) {
		const key = wt.repoLabel || "Unknown";
		if (!groups.has(key)) { groups.set(key, []); }
		groups.get(key)!.push(wt);
	}
	return groups;
}

/** A worktree whose size/push status has not been computed yet (bytes are the -1 sentinel). */
function isWorktreePending(w: WorktreeResult): boolean {
	return w.bytes < 0;
}

/** Bytes counted toward totals: pending (-1) worktrees contribute 0 until enriched. */
function knownBytes(w: WorktreeResult): number {
	return w.bytes > 0 ? w.bytes : 0;
}

/** Pending rows show "…" while a scan runs; a scan that stopped before enriching them shows a dash. */
function worktreePendingLabel(active: string): string {
	return `<span class="worktree-pending">${worktreeScanInProgress ? active : "—"}</span>`;
}

const WORKTREE_DETAIL_COLUMNS: DataTableColumn<WorktreeResult>[] = [
	{ id: "path", label: "Path", className: "worktree-path-cell", sortValue: (w) => w.path, render: (w) => ({ html: `<span title="${escapeHtml(w.path)}">${escapeHtml(w.path)}</span>` }) },
	{ id: "branch", label: "Branch", sortValue: (w) => w.branch, render: (w) => w.branch },
	{ id: "lastCommit", label: "Last Commit", sortValue: (w) => sessionTimestamp(w.lastCommitDate ?? undefined), render: (w) => w.lastCommit },
	{
		id: "pushed", label: "Pushed", sortValue: (w) => (isWorktreePending(w) ? null : w.pushed),
		render: (w) => ({ html: isWorktreePending(w) ? worktreePendingLabel("checking…") : `${w.pushed === "yes" ? "✅" : w.pushed === "no" ? "🔴" : "❓"} ${escapeHtml(w.pushed)}` }),
	},
	{ id: "files", label: "Files", align: "right", sortValue: (w) => (isWorktreePending(w) ? null : w.files), render: (w) => (isWorktreePending(w) ? { html: worktreePendingLabel("…") } : String(w.files)) },
	{
		id: "size", label: "Size", align: "right", sortValue: (w) => (isWorktreePending(w) ? null : w.bytes),
		render: (w) => ({ html: isWorktreePending(w) ? worktreePendingLabel("computing…") : `<span title="${w.bytes.toLocaleString()} bytes">${formatFileSize(w.bytes)}</span>` }),
	},
	{
		id: "actions", label: "Actions",
		render: (w) => ({ html: `<a href="#" class="worktree-reveal-link" data-path="${encodeURIComponent(w.path)}">Open</a>
      <a href="#" class="worktree-delete-link" data-path="${encodeURIComponent(w.path)}" data-branch="${encodeURIComponent(w.branch)}" data-repo="${encodeURIComponent(w.repoLabel)}" data-pushed="${escapeHtml(w.pushed)}" title="Remove via git worktree remove (asks for confirmation)">🗑️ Delete</a>` }),
	},
];

/** The per-worktree details table shown when a repository row is expanded; one stable table per repository. */
function buildWorktreeDetailsTableHtml(repoLabel: string, worktrees: WorktreeResult[]): string {
	return renderDataTable<WorktreeResult>({
		tableId: `worktree-details-${encodeURIComponent(repoLabel)}`,
		ariaLabel: repoLabel,
		rows: worktrees,
		columns: WORKTREE_DETAIL_COLUMNS,
		initialSort: { columnId: "size", direction: "desc" },
		className: "data-table--compact",
	});
}

/** Size cell text with a trailing "…" hint while any worktree in the set is still being sized. */
function worktreeSizeText(worktrees: WorktreeResult[]): string {
	const totalBytes = worktrees.reduce((s, w) => s + knownBytes(w), 0);
	const pending = worktrees.some(isWorktreePending);
	const size = `<span title="${totalBytes.toLocaleString()} bytes">${formatFileSize(totalBytes)}</span>`;
	return pending ? `${size} <span class="worktree-pending">…</span>` : size;
}

/**
 * Repo-scoped "Clean up (N)" button shown in each repository's summary row. Takes the repo's
 * already-sliced worktree list (the caller already has it) rather than re-filtering the entire
 * `worktreeResults` array per repo row — that would be an O(repoCount × worktreeCount) rescan on
 * every render.
 */
function buildWorktreeRepoCleanupButtonHtml(repoLabel: string, worktrees: WorktreeResult[]): string {
	const pushedCount = worktrees.filter((w) => w.pushed === "yes" && !isWorktreePending(w)).length;
	const disabled = worktreeCleanupInProgress || worktreeCleanupConfirmPending || worktreeScanInProgress || pushedCount === 0;
	return `<button type="button" class="button secondary worktree-repo-cleanup-btn" data-repo="${encodeURIComponent(repoLabel)}"
    title="Remove this repository's pushed worktrees via git worktree remove (asks for confirmation)" ${disabled ? "disabled" : ""}
    >🧹 Clean up (${pushedCount})</button>`;
}

/** Sum of the known (enriched) bytes across a repository's worktrees. */
function groupKnownBytes(worktrees: WorktreeResult[]): number {
	return worktrees.reduce((s, w) => s + knownBytes(w), 0);
}

type WorktreeRepoGroup = { repo: string; worktrees: WorktreeResult[] };

/**
 * The repository table (Repository | Worktrees | Size | Actions). An expanded repository (one in
 * worktreeExpandedRepos) gets a details row holding its per-worktree table right after it, so the
 * expansion moves with the repository when the table is sorted or paged.
 */
function buildWorktreeRepoTableHtml(groups: Map<string, WorktreeResult[]>): string {
	// Pre-sorted by name so repositories with equal counts or sizes keep a stable, alphabetical order.
	const rows: WorktreeRepoGroup[] = [...groups.entries()]
		.map(([repo, worktrees]) => ({ repo, worktrees }))
		.sort((a, b) => a.repo.localeCompare(b.repo));
	return renderDataTable<WorktreeRepoGroup>({
		tableId: "worktree-repos",
		ariaLabel: "📦 Repositories",
		rows,
		columns: [
			{
				id: "repo", label: "Repository", sortValue: (g) => g.repo,
				render: (g) => ({ html: `<span class="worktree-caret">${worktreeExpandedRepos.has(g.repo) ? "▼" : "▶"}</span> ${escapeHtml(g.repo)}` }),
			},
			{ id: "count", label: "Worktrees", align: "right", sortValue: (g) => g.worktrees.length, render: (g) => String(g.worktrees.length) },
			{ id: "size", label: "Size", align: "right", sortValue: (g) => groupKnownBytes(g.worktrees), render: (g) => ({ html: worktreeSizeText(g.worktrees) }) },
			{ id: "actions", label: "Actions", className: "worktree-repo-actions", render: (g) => ({ html: buildWorktreeRepoCleanupButtonHtml(g.repo, g.worktrees) }) },
		],
		initialSort: { columnId: "count", direction: "desc" },
		className: "worktree-repo-table",
		rowOptions: (g) => {
			const expanded = worktreeExpandedRepos.has(g.repo);
			return { className: `worktree-repo-row${expanded ? " expanded" : ""}`, attributes: { "data-repo": g.repo, "aria-expanded": String(expanded) } };
		},
		afterRow: (g) => worktreeExpandedRepos.has(g.repo)
			? `<tr class="worktree-repo-details" data-repo="${escapeHtml(g.repo)}"><td colspan="4">${buildWorktreeDetailsTableHtml(g.repo, g.worktrees)}</td></tr>`
			: "",
	});
}

/**
 * Worktrees eligible for a cleanup: known to be pushed and already enriched. Pass `repoLabel`
 * to scope the candidates to a single repository (used by each repo row's own "Clean up"
 * button); omit it for the global "Clean Up" card that spans every repository.
 */
function getCleanupCandidates(repoLabel?: string): WorktreeResult[] {
	return worktreeResults.filter((w) =>
		w.pushed === "yes" && !isWorktreePending(w) && (repoLabel === undefined || w.repoLabel === repoLabel));
}

/** The cleanup trigger, rendered as its own card inside the hero summary-cards row (to the right of Worktrees/Repositories/Total Size). */
function renderWorktreeCleanupCard(): string {
	const pushedCount = getCleanupCandidates().length;
	const disabled = worktreeCleanupInProgress || worktreeCleanupConfirmPending || worktreeScanInProgress || pushedCount === 0;
	const label = worktreeCleanupConfirmPending ? "⏳ Waiting…" : `🧹 Clean Up (${pushedCount})`;
	return `<div class="summary-card worktree-cleanup-card">
    <div class="summary-label">Pushed Worktrees</div>
    <div class="worktree-cleanup-card-actions">
      <button class="button secondary" id="btn-cleanup-pushed-worktrees" ${disabled ? "disabled" : ""}>${label}</button>
      ${worktreeCleanupInProgress ? '<button class="button secondary" id="btn-cancel-cleanup">✕</button>' : ""}
    </div>
  </div>`;
}

/** Local date/time label for an ISO string; empty when it is missing or unparseable. */
function formatWorktreeTimestamp(iso: string | undefined): string {
	if (!iso) { return ""; }
	const date = new Date(iso);
	return isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** One "label: value" chip; `danger` marks a fact that blocks or endangers the cleanup. */
function worktreeChip(icon: string, text: string, title: string, danger = false): string {
	return `<span class="worktree-cleanup-chip${danger ? " danger" : ""}" title="${escapeHtml(title)}">${icon} ${escapeHtml(text)}</span>`;
}

/** "Last updated" / "Last commit" chips — how stale (or how live) this worktree is. */
function buildWorktreeAgeChips(d: WorktreeCleanupDiagnostics): string[] {
	const chips: string[] = [];
	if (d.sizeBytes !== undefined) {
		chips.push(worktreeChip("💾", localizeFormat("usage.worktreeCleanup.sizeChip", formatFileSize(d.sizeBytes)), localizeFormat("usage.worktreeCleanup.sizeChipTitle", d.sizeBytes.toLocaleString())));
	}
	const lastModified = formatWorktreeTimestamp(d.lastModified);
	if (lastModified) {
		chips.push(worktreeChip("🕒", `Last updated: ${lastModified}`, "Newest file modification at the worktree root"));
	}
	const commitTitle = formatWorktreeTimestamp(d.lastCommitDate) || "Last commit on the checked-out branch";
	if (d.lastCommitRelative || d.lastCommitDate) {
		chips.push(worktreeChip("📝", `Last commit: ${d.lastCommitRelative || commitTitle}`, commitTitle));
	}
	return chips;
}

/** Remote-branch + ahead/behind chips — whether the work here exists anywhere but this folder. */
function buildWorktreeRemoteChips(d: WorktreeCleanupDiagnostics): string[] {
	const chips: string[] = [];
	// An undefined status means the probe itself failed, so no remote chip is shown at all —
	// silence is correct here, whereas "never pushed" would be an invented fact.
	if (d.remoteStatus === "none") {
		chips.push(worktreeChip("⚠️", "Remote: none (never pushed)", "This branch was never pushed — it has no upstream tracking branch", true));
	} else if (d.remoteStatus === "gone") {
		chips.push(worktreeChip("⚠️", `Remote: ${d.remoteBranch ?? "unknown"} (gone)`, "The upstream branch no longer exists on the remote (deleted or pruned)", true));
	} else if (d.remoteStatus === "tracked" && d.remoteBranch) {
		chips.push(worktreeChip("🌐", `Remote: ${d.remoteBranch}`, "Upstream tracking branch"));
	}
	if (d.ahead === undefined && d.behind === undefined) { return chips; }
	const ahead = d.ahead ?? 0, behind = d.behind ?? 0;
	const synced = ahead === 0 && behind === 0;
	chips.push(worktreeChip(
		synced ? "✅" : "🔀",
		`Push status: ${synced ? "up to date" : `${ahead} ahead · ${behind} behind`}`,
		"Commits on this branch compared with its upstream",
		ahead > 0,
	));
	return chips;
}

/** Working-tree chip — how much uncommitted work would be lost by a force-delete. */
function buildWorktreeDirtyChips(d: WorktreeCleanupDiagnostics): string[] {
	if (d.modifiedFiles === undefined && d.untrackedFiles === undefined) { return []; }
	const modified = d.modifiedFiles ?? 0, untracked = d.untrackedFiles ?? 0;
	const clean = modified === 0 && untracked === 0;
	return [worktreeChip(
		clean ? "✅" : "✏️",
		`Changes: ${clean ? "clean" : `${modified} modified · ${untracked} untracked`}`,
		"Uncommitted work in this worktree",
		!clean,
	)];
}

/**
 * The remediation facts for one blocked cleanup row, as compact "label: value" chips. Each chip
 * answers a question the user would otherwise have to open a terminal to answer: is this stale,
 * does the branch still exist on the remote, is it in sync, and how much work is uncommitted.
 */
function buildWorktreeCleanupDetailChips(d: WorktreeCleanupDiagnostics | undefined): string {
	if (!d) { return ""; }
	const chips = [...buildWorktreeAgeChips(d), ...buildWorktreeRemoteChips(d), ...buildWorktreeDirtyChips(d)];
	return chips.length === 0 ? "" : `<div class="worktree-cleanup-chips">${chips.join("")}</div>`;
}

/** Per-row remediation actions for a worktree the cleanup could not delete. */
function buildWorktreeCleanupActions(e: WorktreeCleanupLogEntry): string {
	const p = encodeURIComponent(e.path);
	return `<div class="worktree-cleanup-log-actions">
      <button type="button" class="button secondary worktree-open-editor-btn" data-path="${p}" title="Open this worktree folder in a new VS Code window so you can commit, push, or clean it up">💻 Open in VS Code</button>
      <button type="button" class="button secondary worktree-reveal-btn" data-path="${p}" title="Show this folder in the OS file explorer">📂 Reveal folder</button>
      <button type="button" class="button secondary worktree-delete-btn" data-path="${p}" data-branch="${encodeURIComponent(e.branch)}" data-repo="${encodeURIComponent(e.repoLabel)}" data-pushed="?" title="Try removing it again — you will be asked to confirm, and to force-delete if it still has uncommitted changes">🗑️ Delete anyway…</button>
    </div>`;
}

/** Replaces a row's actions while "Delete anyway…" runs, and shows its final state afterwards. */
function buildWorktreeRetryArea(e: WorktreeCleanupLogEntry, retry: WorktreeRetryState | undefined): string {
	if (!retry) { return buildWorktreeCleanupActions(e); }
	if (retry.status === "running") {
		const size = e.diagnostics?.sizeBytes !== undefined ? ` (${formatFileSize(e.diagnostics.sizeBytes)})` : "";
		return `<div class="worktree-retry-status" role="status">
      <div>${escapeHtml(localizeFormat("usage.worktreeCleanup.deleting", size))}</div>
      <div class="worktree-progress-bar"><div class="worktree-progress-fill indeterminate" style="width: 100%;"></div></div>
    </div>`;
	}
	if (retry.status === "deleted") {
		return `<div class="worktree-retry-status success" role="status">${escapeHtml(localize("usage.worktreeCleanup.deleted"))}</div>`;
	}
	return `<div class="worktree-retry-status failed" role="status">${escapeHtml(localizeFormat("usage.worktreeCleanup.deleteFailed", retry.reason || localize("usage.worktreeCleanup.unknownError")))}</div>${buildWorktreeCleanupActions(e)}`;
}

/** Non-deleted cleanup outcomes (skipped/error) — successful deletions just remove the row, no need to list them. */
function renderWorktreeCleanupLog(): string {
	const notable = worktreeCleanupLog.filter((e) => e.status !== "deleted");
	if (notable.length === 0) { return ""; }
	const rows = notable.map((e) => {
		const retry = worktreeRetryState.get(e.path);
		const icon = retry?.status === "deleted" ? "✅" : e.status === "skipped" ? "⏭️" : "❌";
		return `<div class="worktree-cleanup-log-row">
      <span>${icon}</span>
      <div class="worktree-cleanup-log-details">
        <div class="worktree-cleanup-log-headline">
          <span class="worktree-cleanup-log-branch">${escapeHtml(e.branch)}</span>
          <span class="worktree-cleanup-log-repo">${escapeHtml(e.repoLabel)}</span>
        </div>
        <div class="worktree-cleanup-log-path">${escapeHtml(e.path)}</div>
        ${retry?.status === "deleted" ? "" : `<div class="worktree-cleanup-log-reason">${escapeHtml(e.reason || "")}</div>`}
        ${buildWorktreeCleanupDetailChips(e.diagnostics)}
        ${buildWorktreeRetryArea(e, retry)}
      </div>
    </div>`;
	}).join("");
	return `<div class="worktree-cleanup-log">${rows}</div>`;
}

function renderWorktreeCleanupStatus(): string {
	if (worktreeCleanupInProgress) {
		const { processed, total } = worktreeCleanupStatus;
		const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
		return `<div class="info-box" style="margin-top: 12px;">
      <div class="info-box-title">🧹 Cleaning up pushed worktrees…</div>
      <div>${processed} / ${total} processed</div>
      <div class="worktree-progress-bar"><div class="worktree-progress-fill" style="width: ${pct}%;"></div></div>
    </div>${renderWorktreeCleanupLog()}`;
	}
	if (worktreeCleanupLog.length === 0) { return ""; }
	// A row the user later removed with "Delete anyway…" counts as deleted, not as its original outcome.
	const retried = (e: WorktreeCleanupLogEntry) => worktreeRetryState.get(e.path)?.status === "deleted";
	const deleted = worktreeCleanupLog.filter((e) => e.status === "deleted" || retried(e)).length;
	const skipped = worktreeCleanupLog.filter((e) => e.status === "skipped" && !retried(e)).length;
	const errors = worktreeCleanupLog.filter((e) => e.status === "error" && !retried(e)).length;
	return `<div class="info-box" style="margin-top: 12px;">
    <div class="info-box-title">🧹 Cleanup finished</div>
    <div>✅ ${deleted} deleted · ⏭️ ${skipped} skipped (uncommitted/unpushed) · ${errors > 0 ? `❌ ${errors} error${errors === 1 ? "" : "s"}` : "0 errors"}</div>
  </div>${renderWorktreeCleanupLog()}`;
}

function renderWorktreeResults(): string {
	if (worktreeResults.length === 0) {
		// The cleanup report is still shown here: a run that deleted or errored on every
		// remaining worktree empties this list, and dropping the report with it would hide
		// exactly the rows the user still has to act on.
		if (worktreeScanInProgress) { return '<div style="padding: 16px; color: var(--text-muted);">Discovering worktrees…</div>'; }
		return '<div style="padding: 16px; color: var(--text-muted);">No worktrees found yet. Add root folders above and click Scan.</div>'
			+ renderWorktreeCleanupStatus();
	}
	const groups = groupWorktreesByRepo(worktreeResults);
	const totalBytes = worktreeResults.reduce((s, w) => s + knownBytes(w), 0);
	const anyPending = worktreeResults.some(isWorktreePending);
	const totalSizeHtml = `${formatFileSize(totalBytes)}${anyPending ? ' <span class="worktree-pending">…</span>' : ''}`;
	const summary = `<div class="summary-cards">
    <div class="summary-card"><div class="summary-label">🌳 Worktrees</div><div class="summary-value">${worktreeResults.length}</div></div>
    <div class="summary-card"><div class="summary-label">📦 Repositories</div><div class="summary-value">${groups.size}</div></div>
    <div class="summary-card"><div class="summary-label">💾 Total Size</div><div class="summary-value" title="${totalBytes.toLocaleString()} bytes">${totalSizeHtml}</div></div>
    ${renderWorktreeCleanupCard()}
  </div>`;
	return summary + renderWorktreeCleanupStatus() + buildWorktreeRepoTableHtml(groups);
}

function buildWorktreesTabPanelHtml(): string {
	return `
    <div id="tab-panel-worktrees" class="tab-panel"${activeTab !== 'worktrees' ? ' style="display:none"' : ''}>
      <div class="info-box">
        <div class="info-box-title">🌳 Worktree Discovery</div>
        <div>
          Scans folders for uncleaned git worktrees and reports disk usage grouped by repository (based on each
          worktree's git remote). Add one or more root folders below, then click Scan. Results stream in as they're found.
        </div>
      </div>
      <div id="worktree-controls">${renderWorktreeControls()}</div>
      <div id="worktree-results">${renderWorktreeResults()}</div>
    </div>`;
}

function buildSessionsTabPanelHtml(stats: UsageAnalysisStats): string {
	// Guard against silent host updates that omit todaySessions (e.g. a stale payload
	// shape): keep showing the last known sessions instead of clearing the table.
	if (Array.isArray(stats.todaySessions)) {
		latestTodaySessions = stats.todaySessions;
	}
	const cachedForLookback = sessionsLookback === 'today' ? latestTodaySessions : recentSessionsCache[sessionsLookback];
	const bodyHtml = cachedForLookback
		? renderTodaySessionsTable(cachedForLookback)
		: `<div style="color: var(--text-secondary); font-size: 13px; padding: 16px;">Loading sessions for ${PERIOD_LABELS[sessionsLookback]}…</div>`;
	return `
		<div id="tab-panel-sessions" class="tab-panel"${activeTab !== 'sessions' ? ' style="display:none"' : ''}>
			<div class="section">
				<div class="section-title" style="display:flex; align-items:center; gap:8px;">
					<span>📋</span><span>Recent Sessions</span>
					<span id="sessions-lookback-wrapper" style="margin-left:auto;"></span>
					${buildSessionColumnsMenuHtml()}
				</div>
				<div class="section-subtitle">Individual session breakdown for the selected period — sorted by number of interactions (most active first).</div>
				<div id="sessions-panel-body" style="margin-top: 12px;">
					${bodyHtml}
				</div>
			</div>
		</div>`;
}

/** Renders the "GitHub Copilot API (all channels)" gauge as three segments: usage this
 *  extension can account for locally ("tracked here"), usage the API reports but this
 *  extension has no local session data for ("other devices/cloud" — e.g. a different PC,
 *  a VDI, WSL, web chat, cloud agent, or review agent), and whatever budget remains.
 *  `copilotCostUsd` is the extension's locally-tracked GitHub Copilot spend for the
 *  current month; it is clamped so a bar never renders more than 100% even if local
 *  tracking briefly overshoots the API snapshot (e.g. due to refresh timing). */
function _billingApiBalanceHtml(api: CopilotApiBalance, copilotCostUsd: number): string {
	const apiUsedUsd = api.usedAiCredits * 0.01;
	const trackedUsd = Math.max(0, Math.min(copilotCostUsd, apiUsedUsd));
	const gapUsd = Math.max(0, apiUsedUsd - trackedUsd);
	const budgetUsd = api.budgetUsd;
	const trackedPct = budgetUsd > 0 ? Math.min(100, (trackedUsd / budgetUsd) * 100) : 0;
	const gapPct = budgetUsd > 0 ? Math.min(100 - trackedPct, (gapUsd / budgetUsd) * 100) : 0;
	const totalUsedPct = trackedPct + gapPct;
	const usedPct = formatFixed(100 - api.pctAvailable, 1);
	const pct = formatFixed(api.pctAvailable, 1);
	const severityColor = totalUsedPct > 90 ? 'var(--error-color, #f14c4c)' : totalUsedPct > 75 ? 'var(--warning-color, #cca700)' : 'var(--accent-color, #4d9cf8)';
	const trackedSegment = trackedPct > 0
		? `<div style="height:100%; width:${formatFixed(trackedPct, 4)}%; background:${severityColor};"></div>`
		: '';
	// The "other usage" segment is hatched (striped) rather than solid — same severity
	// color, but visually flagged as usage this device can't confirm the source of.
	const gapSegment = gapPct > 0
		? `<div title="Usage the API reports but this device has no local session data for" style="height:100%; width:${formatFixed(gapPct, 4)}%; background:${severityColor}; background-image:repeating-linear-gradient(135deg, rgba(0,0,0,0.35) 0px, rgba(0,0,0,0.35) 3px, transparent 3px, transparent 6px);"></div>`
		: '';
	const legend = gapPct > 0
		? `<div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--text-secondary); margin-top:6px;">
				<span><span style="display:inline-block; width:9px; height:9px; border-radius:2px; background:${severityColor}; margin-right:4px; vertical-align:middle;"></span>Tracked here (${formatFixed(trackedPct, 1)}%)</span>
				<span><span style="display:inline-block; width:9px; height:9px; border-radius:2px; background:${severityColor}; background-image:repeating-linear-gradient(135deg, rgba(0,0,0,0.35) 0px, rgba(0,0,0,0.35) 2px, transparent 2px, transparent 4px); margin-right:4px; vertical-align:middle;"></span>Other devices/cloud (${formatFixed(gapPct, 1)}%)</span>
			</div>`
		: '';
	return `
		<div style="margin-bottom:12px;">
			<div style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">GitHub Copilot API (all channels)</div>
			<div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:8px;">
				<div style="background:var(--bg-tertiary); border:1px solid var(--border-subtle); border-radius:6px; padding:10px 16px; text-align:center; min-width:80px;">
					<div style="font-size:18px; font-weight:700; color:var(--text-primary);">${formatNumber(api.usedAiCredits)}</div>
					<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Credits used</div>
				</div>
				<div style="background:var(--bg-tertiary); border:1px solid var(--border-subtle); border-radius:6px; padding:10px 16px; text-align:center; min-width:80px;">
					<div style="font-size:18px; font-weight:700; color:var(--text-primary);">${formatNumber(api.remainingAiCredits)}</div>
					<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Credits remaining</div>
				</div>
				<div style="background:var(--bg-tertiary); border:1px solid var(--border-subtle); border-radius:6px; padding:10px 16px; text-align:center; min-width:80px;">
					<div style="font-size:18px; font-weight:700; color:var(--text-primary);">${formatNumber(api.budgetAiCredits)}</div>
					<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Monthly budget</div>
				</div>
			</div>
			<div style="margin-bottom:4px; font-size:11px; color:var(--text-secondary); display:flex; justify-content:space-between;">
				<span>${usedPct}% used</span><span>${pct}% available</span>
			</div>
			<div style="height:8px; border-radius:4px; background:var(--border-subtle); overflow:hidden; display:flex;">
				${trackedSegment}${gapSegment}
			</div>
			${legend}
			<div style="font-size:11px; color:var(--text-muted); margin-top:6px;">
				1 AI Credit = $0.01 · Budget = $${formatFixed(api.budgetUsd, 2)}/month
			</div>
		</div>`;
}

function _billingCoverageAnalysisHtml(api: CopilotApiBalance | null | undefined, copilotCostUsd: number, nonCopilotCostUsd: number): string {
	if (!api) {
		return `
			<div style="font-size:11px; color:var(--text-muted); margin-bottom:8px; line-height:1.5;">
				ℹ️ No Copilot API quota data available yet. The API balance appears after the extension fetches your Copilot plan info.
				The extension only tracks local IDE sessions — it cannot see web chat, cloud agent, or review agent usage.
			</div>`;
	}
	if (copilotCostUsd <= 0) { return ''; }
	const apiUsedUsd = api.usedAiCredits * 0.01;
	const gapUsd = apiUsedUsd - copilotCostUsd;
	const gapCredits = Math.round(gapUsd * 100);
	const gapRow = gapCredits > 0
		? `<div style="display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid var(--border-subtle); color:var(--text-secondary);"><span>Gap (untracked Copilot usage)</span><span>$${formatFixed(gapUsd, 2)} (${formatNumber(gapCredits)} credits)</span></div>`
		: '';
	const otherRow = nonCopilotCostUsd > 0.001
		? `<div style="display:flex; justify-content:space-between;"><span>Other providers (not in Copilot API)</span><span>$${formatFixed(nonCopilotCostUsd, 2)}</span></div>`
		: '';
	const note = gapCredits > 0
		? `<div style="margin-top:8px; font-size:11px; color:var(--text-muted); line-height:1.5;">ℹ️ The gap represents Copilot usage the extension cannot track: <strong>github.com/copilot</strong> web chat, <strong>cloud agent</strong> sessions, and <strong>Copilot review agent</strong> — all counted against your AI Credit budget.</div>`
		: `<div style="margin-top:8px; font-size:11px; color:var(--text-muted);">✅ Extension-tracked Copilot usage matches the API — no significant untracked usage from web chat, cloud agent, or review agent.</div>`;
	return `
		<div style="background:var(--bg-tertiary); border:1px solid var(--border-subtle); border-radius:6px; padding:12px 14px; margin-bottom:12px;">
			<div style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:8px;">Coverage analysis</div>
			<div style="display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--text-primary);">
				<div style="display:flex; justify-content:space-between;"><span>API total Copilot usage</span><span style="font-weight:600;">$${formatFixed(apiUsedUsd, 2)} (${formatNumber(api.usedAiCredits)} credits)</span></div>
				<div style="display:flex; justify-content:space-between;"><span>Extension tracked (Copilot IDE sessions)</span><span style="font-weight:600;">$${formatFixed(copilotCostUsd, 2)} (${formatNumber(Math.round(copilotCostUsd * 100))} credits)</span></div>
				${gapRow}${otherRow}
			</div>
			${note}
		</div>`;
}

/** Localized explanation for an account that has no usable budget figure. */
function accountBudgetNote(b: AccountBudgetView): string {
	if (b.status === 'no-quota') { return localize('accountBudgets.noQuota'); }
	if (b.reason === 'no-session') { return localize('accountBudgets.noSession'); }
	if (b.reason === 'lookup-failed') { return localizeFormat('accountBudgets.lookupFailed', b.detail ?? ''); }
	return b.detail ?? localize('accountBudgets.unavailable');
}

/** The last stats handed to renderLayout(), so a live account update can re-render when no mount point exists. */
let lastRenderedStats: UsageAnalysisStats | null = null;

/** One account's row in the per-account budget list. */
function _accountBudgetRowHtml(b: AccountBudgetView): string {
	const plan = b.planName ? ` <span style="color:var(--text-muted);">(${escapeHtml(b.planName)})</span>` : '';
	const name = `<span style="font-weight:600;">${escapeHtml(b.label)}</span>${plan}`;
	if (b.status !== 'ok' || !b.balance) {
		const note = escapeHtml(accountBudgetNote(b));
		return `<div style="display:flex; justify-content:space-between; gap:12px; font-size:12px;"><span>${name}</span><span style="color:var(--text-muted);">${note}</span></div>`;
	}
	const usedPct = Math.min(100, Math.max(0, 100 - b.balance.pctAvailable));
	const color = usedPct > 90 ? 'var(--error-color, #f14c4c)' : usedPct > 75 ? 'var(--warning-color, #cca700)' : 'var(--accent-color, #4d9cf8)';
	const reset = b.resetDate ? ` · ${escapeHtml(localizeFormat('accountBudgets.resets', b.resetDate.slice(0, 10)))}` : '';
	return `
		<div style="font-size:12px;">
			<div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:4px;">
				<span>${name}</span>
				<span>${escapeHtml(localizeFormat('accountBudgets.usedLeft', '$' + formatFixed(b.balance.usedAiCredits / 100, 2), '$' + formatFixed(b.balance.budgetUsd, 2), formatFixed(b.balance.pctAvailable, 1)))}${reset}</span>
			</div>
			<div style="height:6px; border-radius:3px; background:var(--border-subtle); overflow:hidden;"><div style="height:100%; width:${formatFixed(usedPct, 2)}%; background:${color};"></div></div>
		</div>`;
}

/** Budget per GitHub account. Omitted only for a lone account with a balance, which the API balance card already shows. */
function buildAccountBudgetsHtml(accounts: AccountBudgetView[] | undefined, apiBalanceShown: boolean): string {
	const list = accounts ?? [];
	if (!shouldListAccountBudgets(list, apiBalanceShown)) { return ''; }
	return `
		<div style="margin-bottom:12px;">
			<div style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">${escapeHtml(localize('accountBudgets.title'))}</div>
			<div style="background:var(--bg-tertiary); border:1px solid var(--border-subtle); border-radius:6px; padding:12px 14px; display:flex; flex-direction:column; gap:10px; color:var(--text-primary);">
				${list.map(_accountBudgetRowHtml).join('')}
			</div>
		</div>`;
}

/** Whether the AI Billing Coverage section has anything to show for these stats. */
function billingSectionHasContent(stats: UsageAnalysisStats): boolean {
	const groupCosts = stats.monthBillingGroupCosts;
	return !!stats.copilotApiBalance || shouldListAccountBudgets(stats.accountBudgets ?? [], !!stats.copilotApiBalance) || (!!groupCosts && Object.keys(groupCosts).length > 0);
}

function buildBillingComparisonSectionHtml(stats: UsageAnalysisStats): string {
	if (!billingSectionHasContent(stats)) { return ''; }
	const api = stats.copilotApiBalance;
	const groupCosts = stats.monthBillingGroupCosts;
	const accountsHtml = buildAccountBudgetsHtml(stats.accountBudgets, !!api);

	const copilotCostUsd = groupCosts?.['GitHub Copilot'] ?? 0;
	const totalCostUsd = groupCosts ? Object.values(groupCosts).reduce((s, v) => s + v, 0) : 0;
	const nonCopilotCostUsd = totalCostUsd - copilotCostUsd;

	const apiHtml = api ? _billingApiBalanceHtml(api, copilotCostUsd) : '';
	const extHtml = groupCosts && Object.keys(groupCosts).length > 0 ? billingExtGroupCostsHtml(groupCosts, api) : '';
	const deltaHtml = _billingCoverageAnalysisHtml(api, copilotCostUsd, nonCopilotCostUsd);

	return `
		<div class="section" id="section-billing-coverage">
			<div class="section-title"><span>💳</span><span>AI Billing Coverage</span></div>
			<div class="section-subtitle">Compare what the GitHub Copilot API reports across all channels with what the extension can track from local IDE session logs, alongside estimated costs from other AI providers.</div>
			${apiHtml}
			<div id="account-budgets">${accountsHtml}</div>
			${extHtml}
			${deltaHtml}
		</div>`;
}

/**
 * Heading that opens a band of related sections within a tab.
 *
 * A tab with nine sibling `.section` cards reads as one flat list, so a section's position in
 * it carries no meaning and anything near the bottom looks like leftovers. These headings give
 * the stack its groups back without splitting the tab or changing any section's own markup.
 *
 * Labels arrive as localization keys and are escaped after resolution, so a translated label
 * containing `&` or a quote renders as text rather than as markup.
 *
 * `role="heading"` + `aria-level` rather than a bare `<div>`: the grouping is the point of this
 * element, and a screen reader that cannot navigate to it still sees an ungrouped run of cards.
 * The level is 3 — below the panel's own heading, above each section title.
 */
function sectionGroupHeadingHtml(icon: string, titleKey: string, subtitleKey: string): string {
	return `
		<div class="section-group-heading">
			<div class="section-group-title" role="heading" aria-level="3"><span aria-hidden="true">${icon}</span><span>${escapeHtml(localize(titleKey))}</span></div>
			<div class="section-group-subtitle">${escapeHtml(localize(subtitleKey))}</div>
		</div>`;
}

function buildActivityTabPanelHtml(
	stats: UsageAnalysisStats,
	multiModelHtml: string,
	thinkingEffortHtml: string,
	sessionsSummaryHtml: string,
	todayTotalRefs: number,
	last30DaysTotalRefs: number,
): string {
	// Each section is built through safeSectionHtml so a bug in one section (e.g. a data
	// shape it doesn't expect) renders an inline error card for that section only, instead of
	// throwing out of this template literal and blanking the entire Activity tab.
	const modelCostHtml = safeSectionHtml('Model Cost', () => buildModelCostSectionHtml(stats));
	const billingComparisonHtml = safeSectionHtml('AI Billing Coverage', () => buildBillingComparisonSectionHtml(stats));
	const modeUsageHtml = safeSectionHtml('Interaction Modes', () => `
			<div class="section" id="section-interaction-modes">
				<div class="section-title"><span>🎯</span><span>Interaction Modes</span></div>
				<div class="section-subtitle">How you're using AI assistants: Ask (chat), Edit (code edits), Agent (autonomous tasks), Plan, Custom Agent, CLI (terminal), Copilot App (desktop-app CLI sessions), Claude Desktop, or Claude (VS Code)</div>
				<div class="two-column">
					${renderModeBarChart(stats.today.modeUsage, '📅 Today')}
					${renderModeBarChart(stats.last30Days.modeUsage, '📊 Last 30 Days')}
				</div>
			</div>`);
	const contextRefsHtml = safeSectionHtml('Context References', () => buildContextRefsHtml(stats, todayTotalRefs, last30DaysTotalRefs));
	const modelEfficiencyHtml = safeSectionHtml('Model Efficiency', () => buildModelEfficiencySectionHtml(stats));
	const contextWindowHtml = safeSectionHtml('Context Window', () => buildContextWindowSectionHtml(stats));
	// Three bands, in the order the questions get asked: what did I do, what did it cost,
	// and how much context did it take. Before this grouping, Thinking Effort and Context
	// Window trailed off the bottom of an undifferentiated stack of nine sections with no
	// signal that they answered a different question from the cost sections above them.
	return `
		<div id="tab-panel-activity" class="tab-panel"${activeTab !== 'activity' ? ' style="display:none"' : ''}>
			${sectionGroupHeadingHtml('📊', 'usage.band.overview.title', 'usage.band.overview.subtitle')}
			${sessionsSummaryHtml}
			<!-- Mode Usage Section -->
			${modeUsageHtml}

			${sectionGroupHeadingHtml('💵', 'usage.band.spend.title', 'usage.band.spend.subtitle')}
			${billingComparisonHtml}
			${modelCostHtml}
			${multiModelHtml}
			${modelEfficiencyHtml}
			${thinkingEffortHtml}

			${sectionGroupHeadingHtml('🧠', 'usage.band.context.title', 'usage.band.context.subtitle')}
			${contextRefsHtml}
			${contextWindowHtml}
		</div>`;
}

// ─── Context window / long-context pricing section ─────────────────────────────

const _modelPricingData = getWindowData<{ pricing: Record<string, ModelPricing> }>('__MODEL_PRICING__');
const MODEL_PRICING_MAP: Record<string, ModelPricing> = _modelPricingData?.pricing ?? {};

/** Long-context tier info for a set of models — smallest threshold wins. */
function _tierInfoForModels(models: string[]): { thresholdTokens: number; defaultInputCostPerMillion: number; longContextInputCostPerMillion: number; model: string } | null {
	let best: { thresholdTokens: number; defaultInputCostPerMillion: number; longContextInputCostPerMillion: number; model: string } | null = null;
	for (const model of models) {
		const info = getLongContextInfo(model, MODEL_PRICING_MAP);
		if (info && (!best || info.thresholdTokens < best.thresholdTokens)) {
			best = { ...info, model };
		}
	}
	return best;
}

/** "how much repo fits" estimate: ~4 characters per token, ~40 characters per source line. */
function _defaultTierCapacityText(thresholdTokens: number): string {
	const mb = (thresholdTokens * 4) / (1024 * 1024);
	const lines = Math.round(thresholdTokens / 10 / 1000);
	return `≈${formatFixed(mb, 1)} MB of code (~${formatNumber(lines)}K lines)`;
}

function _renderContextWindowBar(maxTokens: number, tier: { thresholdTokens: number; defaultInputCostPerMillion: number; longContextInputCostPerMillion: number; model: string }): string {
	const pct = (maxTokens / tier.thresholdTokens) * 100;
	const fillPct = Math.min(pct, 100);
	const color = pct > 100 ? 'var(--error-color, #f14c4c)' : pct >= 70 ? 'var(--warning-color, #cca700)' : 'var(--success-color, #89d185)';
	const modelName = escapeHtml(getModelDisplayName(tier.model));
	const rateNote = `above it, input billing goes $${tier.defaultInputCostPerMillion.toFixed(2)} → $${tier.longContextInputCostPerMillion.toFixed(2)} per 1M tokens`;
	return `
		<div style="margin-top: 12px;">
			<div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-secondary); margin-bottom:4px;">
				<span>${formatNumber(maxTokens)} tokens — ${formatFixed(pct, 0)}% of the ${formatNumber(tier.thresholdTokens)}-token default tier for ${modelName}</span>
				<span>${formatNumber(tier.thresholdTokens)}</span>
			</div>
			<div style="height:8px; border-radius:4px; background:var(--border-subtle); overflow:hidden;">
				<div style="height:100%; width:${formatFixed(fillPct, 0)}%; background:${color}; border-radius:4px;"></div>
			</div>
			<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Default tier fits ${_defaultTierCapacityText(tier.thresholdTokens)}; ${rateNote}.</div>
		</div>`;
}

/** One labelled value line inside a context-window period column. */
function _cwRow(label: string, value: string, subNote?: string, labelTitle?: string): string {
	const titleAttr = labelTitle ? ` title="${labelTitle}"` : '';
	return `
		<div style="margin-bottom: 10px;">
			<div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 2px;"${titleAttr}>${label}</div>
			<div style="font-size: 13px; color: var(--text-primary);">${value}</div>
			${subNote ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px; line-height: 1.4;">${subNote}</div>` : ''}
		</div>`;
}

/** Largest-request row for one period column (empty string when the period has none). */
function _cwLargestRequestRow(cw: ContextWindowStats): string {
	if (cw.maxRequestInputTokens <= 0) { return ''; }
	const tier = _tierInfoForModels(cw.maxRequestModels);
	const modelsLabel = escapeHtml(cw.maxRequestModels.map(m => getModelDisplayName(m)).join(', ') || '—');
	const thresholdNote = tier
		? `${formatFixed((cw.maxRequestInputTokens / tier.thresholdTokens) * 100, 0)}% of the ${formatNumber(tier.thresholdTokens)}-token price line · ${modelsLabel}`
		: `${modelsLabel} — no long-context surcharge for ${cw.maxRequestModels.length > 1 ? 'these models' : 'this model'}`;
	return _cwRow('📏 Largest request', `${formatNumber(cw.maxRequestInputTokens)} input tokens`, thresholdNote,
		'The biggest single prompt (input incl. cached tokens) sent to a model in one request during this period');
}

/** Fullest-CLI-window row for one period column (empty string when unavailable). */
function _cwFullestWindowRow(cw: ContextWindowStats): string {
	if ((cw.maxReachedTokens ?? 0) <= 0) { return ''; }
	const limit = cw.maxReachedWindowLimit;
	const value = limit
		? `${formatNumber(cw.maxReachedTokens!)} of ${formatNumber(limit)} (${formatFixed((cw.maxReachedTokens! / limit) * 100, 0)}%)`
		: formatNumber(cw.maxReachedTokens!);
	return _cwRow('🪟 Fullest CLI window', value, undefined,
		'The highest context fill recorded for a Copilot CLI session in this period, versus its window limit');
}

/** Per-session context-exhaustion rows for one period column (empty when unavailable). */
function _cwPressureRows(cp: ContextPressureStats | undefined): string {
	if (!cp) { return ''; }
	const compactedRow = cp.sessionsConsidered > 0
		? _cwRow(localize('usage.contextPressure.compactedLabel'),
			localizeFormat('usage.contextPressure.ofCount', formatNumber(cp.sessionsCompacted), formatNumber(cp.sessionsConsidered)),
			cp.sessionsCompacted > 0
				? localizeFormat('usage.contextPressure.compactedShare', formatFixed((cp.sessionsCompacted / cp.sessionsConsidered) * 100, 0))
				: localize('usage.contextPressure.noneCompacted'),
			localize('usage.contextPressure.compactedTooltip'))
		: '';
	const nearRow = cp.sessionsWithFillData > 0
		? _cwRow(localize('usage.contextPressure.nearLimitLabel'),
			localizeFormat('usage.contextPressure.ofCount', formatNumber(cp.sessionsNearLimit), formatNumber(cp.sessionsWithFillData)),
			cp.worstFillPercent
				? localizeFormat('usage.contextPressure.worstFill', cp.worstFillPercent)
				: undefined,
			localizeFormat('usage.contextPressure.nearLimitTooltip', NEAR_LIMIT_PERCENT))
		: '';
	return compactedRow + nearRow;
}

/** Renders one period column of the context-window section. */
function renderContextWindowPeriodHtml(cw: ContextWindowStats | undefined, cp?: ContextPressureStats): string {
	const hasWindowData = hasContextWindowData(cw);
	const pressureRows = _cwPressureRows(cp);
	if (!hasWindowData && !pressureRows) { return '<div style="color: var(--text-muted); font-size: 11px;">No data</div>'; }
	if (!hasWindowData) { return pressureRows; }
	const tierEntries = Object.entries(cw!.tierCounts);
	const tierSessionCount = tierEntries.reduce((sum, [, c]) => sum + c, 0);
	const tierRow = tierEntries.length > 0
		? _cwRow('🪜 Context tiers', tierEntries.map(([t, c]) => `${escapeHtml(t)} ×${c}`).join(', '),
			`${tierSessionCount} Copilot CLI session${tierSessionCount === 1 ? '' : 's'} grouped by chosen window size — "default" is the standard window at normal rates; larger tiers unlock more context at long-context prices`,
			'Copilot CLI lets you pick a context-window tier per session; the count shows how many sessions used each tier')
		: '';
	return _cwLargestRequestRow(cw!) + _cwFullestWindowRow(cw!) + tierRow + pressureRows;
}

function renderAutomaticCompactions(stats: AutomaticCompactionStats | undefined): string {
	if (!stats) { return ''; }
	const sources: Array<[string, number]> = [
		['GitHub Copilot CLI', stats.bySource.copilotCli],
		['Claude', stats.bySource.claude],
	];
	const entries = sources.filter(([, count]) => count > 0)
		.map(([source, count]) => `${escapeHtml(source)} ×${formatNumber(count)}`);
	const breakdown = entries.length > 0
		? entries.join(', ')
		: 'No automatic compactions detected';
	return `
		<h4 class="ctx-window-subheading">${escapeHtml(localize('usage.contextWindow.compactionHeading'))}</h4>
		<div class="automatic-compactions-card"
			title="Automatic compactions remove earlier messages to fit the context window and can affect response quality.">
			<div>
				<div class="automatic-compactions-label">↩ Automatic compactions (last 7 days)</div>
				<div class="automatic-compactions-detail">${breakdown}</div>
			</div>
			<div class="automatic-compactions-value">${formatNumber(stats.total)}</div>
		</div>`;
}

/**
 * Context band section: largest request per period vs the long-context pricing threshold,
 * fullest CLI window, context tiers used, and the automatic compactions that context pressure
 * forced over the last 7 days.
 */
function buildContextWindowSectionHtml(stats: UsageAnalysisStats): string {
	const cw30 = stats.last30Days.contextWindow;
	const tier30 = cw30 && cw30.maxRequestInputTokens > 0 ? _tierInfoForModels(cw30.maxRequestModels) : null;
	const bar = cw30 && tier30 ? _renderContextWindowBar(cw30.maxRequestInputTokens, tier30) : '';
	return `
		<div class="section" id="section-context-window">
			<div class="section-title"><span>🪟</span><span>Context Window &amp; Long-Context Pricing</span></div>
			<div class="section-subtitle">How close your largest requests come to the long-context price line. Models with tiered pricing bill higher input rates once a request exceeds their default-tier threshold.</div>
			<div class="three-column">
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
					${renderContextWindowPeriodHtml(stats.today.contextWindow, stats.today.contextPressure)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
					${renderContextWindowPeriodHtml(cw30, stats.last30Days.contextPressure)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Previous Month</h4>
					${renderContextWindowPeriodHtml(stats.lastMonth.contextWindow, stats.lastMonth.contextPressure)}
				</div>
			</div>
			${bar}
			${renderAutomaticCompactions(stats.autoCompactionsLast7Days)}
		</div>`;
}

interface ContextRefDescriptor {
	label: string;
	title?: string;
	get: (cr: ContextReferenceUsage) => number;
}

/** Whether the collapsed "Other references" long-tail group is expanded. Persists across re-renders. */
let contextRefOtherOpen = false;

function buildContextRefCardsHtml(stats: UsageAnalysisStats, todayTotalRefs: number, last30DaysTotalRefs: number): string {
	const c = (v: number | undefined): number => v || 0;
	const descriptors: ContextRefDescriptor[] = [
		{ label: '📄 #file', get: (cr) => cr.file },
		{ label: '✂️ #selection', get: (cr) => cr.selection },
		{ label: '✨ Implicit Selection', title: 'Text selected in your editor providing passive context to Copilot', get: (cr) => cr.implicitSelection },
		{ label: '🔤 #symbol', get: (cr) => cr.symbol },
		{ label: '🗂️ #codebase', get: (cr) => cr.codebase },
		{ label: '📁 @workspace', get: (cr) => cr.workspace },
		{ label: '💻 @terminal', get: (cr) => cr.terminal },
		{ label: '🔧 @vscode', get: (cr) => cr.vscode },
		{ label: '⌨️ #terminalLastCommand', title: 'Last command run in the terminal', get: (cr) => c(cr.terminalLastCommand) },
		{ label: '🖱️ #terminalSelection', title: 'Selected terminal output', get: (cr) => c(cr.terminalSelection) },
		{ label: '📋 #clipboard', title: 'Clipboard contents', get: (cr) => c(cr.clipboard) },
		{ label: '📝 #changes', title: 'Uncommitted git changes', get: (cr) => c(cr.changes) },
		{ label: '📤 #outputPanel', title: 'Output panel contents', get: (cr) => c(cr.outputPanel) },
		{ label: '⚠️ #problemsPanel', title: 'Problems panel contents', get: (cr) => c(cr.problemsPanel) },
		{ label: '🔀 #pr', title: 'Pull request context references (#pr / #pullRequest) — Copilot PR chat understanding, review, and summary', get: (cr) => c(cr.pullRequest) },
		{ label: '📷 Images', title: 'Pasted images and vision context detected in session logs', get: (cr) => c(cr.byKind['copilot.image']) },
		{ label: '📋 Prompt Files', title: '.github/prompts/ prompt file uses detected in session logs', get: (cr) => c(cr.byKind['promptFile']) },
		{ label: '📐 Code Lines', title: 'Total lines of code referenced via #file: range selections', get: (cr) => c(cr.codeContextLines) },
		{ label: '🎯 Custom Prompts', title: 'Custom /command prompt uses detected in session logs', get: (cr) => c(cr.byKind['prompt']) },
		{ label: '📋 Copilot Instructions', title: 'copilot-instructions.md file references detected in session logs', get: (cr) => cr.copilotInstructions },
		{ label: '🤖 Agents.md', title: 'agents.md file references detected in session logs', get: (cr) => cr.agentsMd },
	];
	const r = stats.last30Days.contextReferences;
	const m = stats.month.contextReferences;
	const lm = stats.lastMonth.contextReferences;
	const t = stats.today.contextReferences;
	const rows: ContextRefRow[] = descriptors.map((d) => ({
		label: d.label,
		title: d.title,
		last30: d.get(r),
		month: d.get(m),
		lastMonth: d.get(lm),
		today: d.get(t),
	}));
	return renderContextRefTable(rows, {
		last30: last30DaysTotalRefs,
		month: getTotalContextRefs(m),
		lastMonth: getTotalContextRefs(lm),
		today: todayTotalRefs,
	}, contextRefOtherOpen);
}

function buildContextRefsHtml(stats: UsageAnalysisStats, todayTotalRefs: number, last30DaysTotalRefs: number): string {
	const byKindHtml = Object.keys(stats.last30Days.contextReferences.byKind).length > 0 ? `
		<div style="margin-top: 16px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
			<div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">📎 Attached Files by Type (Last 30 Days)</div>
			<div style="font-size: 12px; color: var(--text-primary);">
				${Object.entries(stats.last30Days.contextReferences.byKind)
					.sort(([, a], [, b]) => (b as number) - (a as number))
					.slice(0, 5)
					.map(([kind, count]) => `<div style="margin-bottom: 4px;"><span style="color: var(--link-color);">${escapeHtml(kind)}:</span> ${count}</div>`)
					.join('')}
			</div>
		</div>
	` : '';
	const byPathHtml = Object.keys(stats.last30Days.contextReferences.byPath).length > 0 ? `
		<div style="margin-top: 16px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
			<div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">📁 Most Referenced Files (Last 30 Days)</div>
			<div style="font-size: 11px; color: var(--text-primary);">
				${Object.entries(stats.last30Days.contextReferences.byPath)
					.sort(([, a], [, b]) => (b as number) - (a as number))
					.slice(0, 10)
					.map(([path, count]) => `<div style="margin-bottom: 4px; font-family: 'Courier New', monospace;"><span style="color: var(--link-color);">${count}×</span> ${escapeHtml(path)}</div>`)
					.join('')}
			</div>
		</div>
	` : '';
	return `
		<!-- Context References Section -->
		<div class="section" id="section-context-references">
			<div class="section-title"><span>🔗</span><span>Context References</span></div>
			<div class="section-subtitle">How often you reference files, selections, symbols, and workspace context</div>
			${buildContextRefCardsHtml(stats, todayTotalRefs, last30DaysTotalRefs)}
			${byKindHtml}
			${byPathHtml}
		</div>`;
}

function buildUnknownMcpToolsBannerHtml(stats: UsageAnalysisStats): string {
	const unknownTools = getUnknownMcpTools(stats);
	if (unknownTools.length === 0) { return ''; }
	const issueUrl = createMcpToolIssueUrl(unknownTools, stats.toolCallsByEditor);
	const toolListHtml = unknownTools.map(tool => {
		const todayCount = (stats.today.toolCalls.byTool[tool] || 0) + (stats.today.mcpTools.byTool[tool] || 0);
		const last30Count = (stats.last30Days.toolCalls.byTool[tool] || 0) + (stats.last30Days.mcpTools.byTool[tool] || 0);
		const monthCount = (stats.month.toolCalls.byTool[tool] || 0) + (stats.month.mcpTools.byTool[tool] || 0);
		const countParts: string[] = [];
		if (todayCount > 0) { countParts.push(`${todayCount} today`); }
		if (last30Count > todayCount) { countParts.push(`${last30Count} in the last 30d`); }
		if (monthCount > last30Count) { countParts.push(`${monthCount} this month`); }
		const editors = formatToolEditors(tool, stats.toolCallsByEditor);
		if (editors) { countParts.push(editors); }
		const countHtml = countParts.length > 0 ? `<span style="color:var(--text-muted);"> (${escapeHtml(countParts.join(' | '))})</span>` : '';
		const suppressBtn = `<button data-suppress-tool="${escapeHtml(tool)}" title="Suppress this tool from the unknown list" style="background:none; border:none; cursor:pointer; padding:0 2px; color:var(--text-muted); font-size:11px; line-height:1;" aria-label="Suppress ${escapeHtml(tool)}">🔇</button>`;
		return `<span style="display:inline-flex; align-items:center; gap:4px; padding:2px 6px; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:3px; font-family:monospace; font-size:11px;">${escapeHtml(tool)}${countHtml}${suppressBtn}</span>`;
	}).join(' ');
	return `
		<div id="unknown-mcp-tools-section" style="margin-bottom: 12px; padding: 10px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px;">
			<div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px;">
				${toolListHtml}
			</div>
			<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--button-bg); color: var(--button-fg); border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: 500;">
				<span>📝</span>
				<span>Report Unknown Tools</span>
			</a>
		</div>
	`;
}

// --- Local model leaderboard ---

type EfficiencyPeriodKey = 'today' | 'last30Days' | 'month';
type EfficiencyMetricKey = 'cost' | 'outputTokens' | 'toolSteps';
type EfficiencyBubbleMetricKey = 'calls' | EfficiencyMetricKey;
type EfficiencyColorMode = 'vendor' | 'model';
type EfficiencyRow = { model: string; counters: ModelEfficiencyCounters; rates: ReturnType<typeof deriveModelEfficiencyRates> };
type EfficiencySortColumn = 'model' | 'calls' | 'oneShotRate' | 'retryRate' | 'selfCorrectionRate' | 'costPerCall' | 'outputTokensPerCall' | 'toolCallsPerCall' | 'cacheHitRate';

const EFFICIENCY_PERIOD_TO_DATA_KEY: Partial<Record<Period, EfficiencyPeriodKey>> = {
	today: 'today',
	last30: 'last30Days',
	currentMonth: 'month',
};

let efficiencySelectedPeriod: Period = 'last30';
let efficiencyPeriod: EfficiencyPeriodKey = 'last30Days';
let efficiencyMetric: EfficiencyMetricKey = 'cost';
let efficiencyBubbleMetric: EfficiencyBubbleMetricKey = 'calls';
let efficiencyColorMode: EfficiencyColorMode = 'vendor';
let cachedModelEfficiency: Partial<Record<EfficiencyPeriodKey, ModelEfficiencyUsage | undefined>> = {};
let efficiencyFilterLowUsage = true;
/** Whether the collapsed "Other models" long-tail group is expanded. Persists across re-renders. */
let efficiencyOtherModelsOpen = false;

type EfficiencyColumnDef = {
	sortKey: EfficiencySortColumn;
	label: string;
	title: string;
	sortValue: (row: EfficiencyRow) => number | string | null;
	render: (row: EfficiencyRow, totalCalls: number) => string;
};

type EfficiencyMetricDef = {
	key: EfficiencyMetricKey;
	label: string;
	axisLabel: string;
	value: (row: EfficiencyRow) => number | null;
	format: (value: number | null) => string;
};

type EfficiencyBubbleMetricDef = {
	key: EfficiencyBubbleMetricKey;
	label: string;
	value: (row: EfficiencyRow) => number | null;
	format: (value: number | null) => string;
};

/** Format a per-unit USD cost with enough precision for inexpensive local turns. */
function formatUnitCost(value: number | null): string {
	if (value === null) { return '—'; }
	return value >= 0.01 ? formatCost(value) : `$${value.toFixed(3)}`;
}

function formatRatePercent(value: number | null): string {
	return value === null ? '—' : formatPercent(value * 100);
}

function formatPerTurn(value: number | null): string {
	return value === null ? '—' : formatFixed(value, 1);
}

const EFFICIENCY_METRICS: EfficiencyMetricDef[] = [
	{ key: 'cost', label: 'Cost', axisLabel: 'Average cost per turn', value: row => row.rates.costPerCall, format: formatUnitCost },
	{ key: 'outputTokens', label: 'Output tokens', axisLabel: 'Average output tokens per turn', value: row => row.rates.outputTokensPerCall, format: value => value === null ? '—' : formatCompact(Math.round(value)) },
	{ key: 'toolSteps', label: 'Tool steps', axisLabel: 'Average tool steps per turn', value: row => row.rates.toolCallsPerCall, format: formatPerTurn },
];

const EFFICIENCY_BUBBLE_METRICS: EfficiencyBubbleMetricDef[] = [
	{ key: 'calls', label: 'Local use', value: row => row.counters.calls, format: value => `${formatNumber(value ?? 0)} turns` },
	...EFFICIENCY_METRICS.map(({ key, label, value, format }) => ({ key, label, value, format })),
];

function buildLocalUsageCell(row: EfficiencyRow, totalCalls: number): string {
	const share = totalCalls > 0 ? row.counters.calls / totalCalls : 0;
	return `<div class="model-use-cell">
		<div class="model-use-track" aria-hidden="true"><span style="width:${Math.max(2, share * 100).toFixed(1)}%"></span></div>
		<strong>${formatRatePercent(share)}</strong>
		<span>${formatNumber(row.counters.calls)} turns</span>
	</div>`;
}

const EFFICIENCY_COLUMN_DEFS: EfficiencyColumnDef[] = [
	{ sortKey: 'model', label: 'Model', title: 'Model identifier', sortValue: row => row.model, render: row => escapeHtml(getModelDisplayName(row.model)) },
	{ sortKey: 'calls', label: 'Local use', title: 'Share of user-request turns attributed to this model', sortValue: row => row.counters.calls, render: buildLocalUsageCell },
	{ sortKey: 'oneShotRate', label: 'One-shot', title: 'Share of edit turns completed without retries or self-corrections', sortValue: row => row.rates.oneShotRate, render: row => formatRatePercent(row.rates.oneShotRate) },
	{ sortKey: 'retryRate', label: 'Retries/edit', title: 'Average immediate same-file retries per edit turn', sortValue: row => row.rates.retryRate, render: row => formatPerTurn(row.rates.retryRate) },
	{ sortKey: 'selfCorrectionRate', label: 'Self-corr/edit', title: 'Average re-edits after intervening tool calls per edit turn', sortValue: row => row.rates.selfCorrectionRate, render: row => formatPerTurn(row.rates.selfCorrectionRate) },
	{ sortKey: 'costPerCall', label: 'Avg cost', title: 'Average estimated provider cost per user-request turn', sortValue: row => row.rates.costPerCall, render: row => formatUnitCost(row.rates.costPerCall) },
	{ sortKey: 'outputTokensPerCall', label: 'Out tok', title: 'Average output tokens per user-request turn', sortValue: row => row.rates.outputTokensPerCall, render: row => row.rates.outputTokensPerCall === null ? '—' : formatCompact(Math.round(row.rates.outputTokensPerCall)) },
	{ sortKey: 'toolCallsPerCall', label: 'Steps', title: 'Average tool invocations per user-request turn', sortValue: row => row.rates.toolCallsPerCall, render: row => formatPerTurn(row.rates.toolCallsPerCall) },
	{ sortKey: 'cacheHitRate', label: 'Cache hit', title: 'Cache-read share of input tokens', sortValue: row => row.rates.cacheHitRate, render: row => formatRatePercent(row.rates.cacheHitRate) },
];

/** Rows by descending local use: the leaderboard's default order and the chart's input. */
function buildEfficiencyRows(usage: ModelEfficiencyUsage): EfficiencyRow[] {
	return Object.entries(usage)
		.map(([model, counters]) => ({ model, counters, rates: deriveModelEfficiencyRates(counters) }))
		.sort((a, b) => b.counters.calls - a.counters.calls);
}

function filterLowUsageRows(rows: EfficiencyRow[], usage: ModelEfficiencyUsage): { rows: EfficiencyRow[]; hiddenNote: string } {
	if (!efficiencyFilterLowUsage) { return { rows, hiddenNote: '' }; }
	const threshold = computeEfficiencyLowUsageThreshold(usage);
	if (threshold === null) { return { rows, hiddenNote: '' }; }
	const filtered = rows.filter(row => row.counters.calls > threshold);
	const hiddenCount = rows.length - filtered.length;
	const noun = hiddenCount === 1 ? 'model' : 'models';
	const turnNoun = threshold === 1 ? 'turn' : 'turns';
	const hiddenNote = hiddenCount > 0 ? `${hiddenCount} low-usage ${noun} hidden (≤${threshold} ${turnNoun})` : '';
	return { rows: filtered, hiddenNote };
}

const MODEL_COLOR_VARS = ['--stage-1-color', '--stage-2-color', '--stage-3-color', '--stage-4-color', '--success-fg', '--warning-fg', '--link-color'];
const PROVIDER_COLOR_VARS: Record<string, string> = {
	Anthropic: '--warning-fg',
	OpenAI: '--success-fg',
	Google: '--stage-3-color',
	'Mistral AI': '--stage-2-color',
	xAI: '--stage-4-color',
	Alibaba: '--stage-1-color',
	Microsoft: '--link-color',
};

function getColorForKey(key: string): string {
	let hash = 0;
	for (let i = 0; i < key.length; i++) { hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0; }
	return `var(${MODEL_COLOR_VARS[Math.abs(hash) % MODEL_COLOR_VARS.length]})`;
}

function getEfficiencyColor(model: string): string {
	if (efficiencyColorMode === 'model') { return getColorForKey(model); }
	const provider = getModelBillingProvider(model);
	const colorVar = PROVIDER_COLOR_VARS[provider];
	return colorVar ? `var(${colorVar})` : getColorForKey(provider);
}

function formatMetricTick(metric: EfficiencyMetricDef, value: number): string {
	if (metric.key === 'cost') { return formatUnitCost(value); }
	if (metric.key === 'outputTokens') { return formatCompact(Math.round(value)); }
	return formatFixed(value, 1);
}

function buildEfficiencyGrid(metric: EfficiencyMetricDef, maxX: number): string {
	const vertical = [0, 0.25, 0.5, 0.75, 1].map(fraction => {
		const x = 76 + fraction * 760;
		return `<line x1="${x}" y1="24" x2="${x}" y2="286"></line><text x="${x}" y="310" text-anchor="middle">${escapeHtml(formatMetricTick(metric, maxX * fraction))}</text>`;
	}).join('');
	const horizontal = [0, 0.25, 0.5, 0.75, 1].map(fraction => {
		const y = 286 - fraction * 262;
		return `<line x1="76" y1="${y}" x2="836" y2="${y}"></line><text x="64" y="${y + 4}" text-anchor="end">${Math.round(fraction * 100)}%</text>`;
	}).join('');
	return `<g class="efficiency-grid">${vertical}${horizontal}</g>`;
}

function buildEfficiencyPoint(
	row: EfficiencyRow,
	metric: EfficiencyMetricDef,
	bubbleMetric: EfficiencyBubbleMetricDef,
	maxX: number,
	maxBubbleValue: number,
	labelPlacement: BubbleLabelPlacement,
): string {
	const value = metric.value(row) ?? 0;
	const bubbleValue = bubbleMetric.value(row) ?? 0;
	const rate = row.rates.oneShotRate ?? 0;
	const x = 76 + (value / maxX) * 760;
	const y = 286 - rate * 262;
	const radius = scaleBubbleRadius(bubbleValue, maxBubbleValue);
	const color = getEfficiencyColor(row.model);
	const rawLabel = getModelDisplayName(row.model);
	const label = escapeHtml(rawLabel);
	const aria = `${rawLabel}: ${formatRatePercent(rate)} one-shot edit rate, ${metric.format(value)} ${metric.axisLabel.toLowerCase()}, bubble sized by ${bubbleMetric.label.toLowerCase()}: ${bubbleMetric.format(bubbleValue)}`;
	return `<g class="efficiency-point" style="--model-color:${color}" tabindex="0" role="img" aria-label="${escapeHtml(aria)}">
		<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}"><title>${escapeHtml(aria)}</title></circle>
		<text x="${labelPlacement.x.toFixed(1)}" y="${labelPlacement.y.toFixed(1)}" text-anchor="${labelPlacement.textAnchor}">${label}</text>
	</g>`;
}

function buildEfficiencyColorLegendHtml(rows: EfficiencyRow[]): string {
	if (efficiencyColorMode !== 'vendor') { return ''; }
	const providers = [...new Set(rows.map(row => getModelBillingProvider(row.model)))].sort();
	const items = providers.map(provider => {
		const model = rows.find(row => getModelBillingProvider(row.model) === provider)?.model ?? '';
		return `<span class="efficiency-legend-item" style="--model-color:${getEfficiencyColor(model)}"><span aria-hidden="true"></span>${escapeHtml(provider)}</span>`;
	}).join('');
	return `<div class="efficiency-vendor-legend" aria-label="Model vendor colors">${items}</div>`;
}

function buildEfficiencyChartHtml(rows: EfficiencyRow[]): string {
	const metric = EFFICIENCY_METRICS.find(item => item.key === efficiencyMetric) ?? EFFICIENCY_METRICS[0];
	const bubbleMetric = EFFICIENCY_BUBBLE_METRICS.find(item => item.key === efficiencyBubbleMetric) ?? EFFICIENCY_BUBBLE_METRICS[0];
	const chartRows = rows.filter(row => row.rates.oneShotRate !== null && metric.value(row) !== null)
		.sort((a, b) => b.counters.calls - a.counters.calls).slice(0, 12);
	if (chartRows.length === 0) {
		return '<div class="model-leaderboard-empty"><strong>No comparable edit data yet.</strong><span>The chart appears after local sessions record both a model and structured edit turns.</span></div>';
	}
	const maxX = Math.max(...chartRows.map(row => metric.value(row) ?? 0), 0.0001) * 1.08;
	const maxBubbleValue = Math.max(...chartRows.map(row => bubbleMetric.value(row) ?? 0), 0);
	const labelInputs = chartRows.map(row => {
		const value = metric.value(row) ?? 0;
		const bubbleValue = bubbleMetric.value(row) ?? 0;
		return {
			x: 76 + (value / maxX) * 760,
			y: 286 - (row.rates.oneShotRate ?? 0) * 262,
			radius: scaleBubbleRadius(bubbleValue, maxBubbleValue),
			label: getModelDisplayName(row.model),
		};
	});
	const labelPlacements = placeBubbleLabels(labelInputs, { left: 76, right: 836, top: 24, bottom: 286 });
	const points = chartRows.map((row, index) =>
		buildEfficiencyPoint(row, metric, bubbleMetric, maxX, maxBubbleValue, labelPlacements[index])
	).join('');
	return `<div class="efficiency-chart-wrap">
		<svg class="efficiency-chart" viewBox="0 0 900 350" role="img" aria-label="One-shot edit rate compared with ${escapeHtml(metric.axisLabel.toLowerCase())}; bubble size represents ${escapeHtml(bubbleMetric.label.toLowerCase())}">
			${buildEfficiencyGrid(metric, maxX)}
			<text class="efficiency-axis-title" x="456" y="344" text-anchor="middle">${escapeHtml(metric.axisLabel)}</text>
			<text class="efficiency-axis-title" x="17" y="155" text-anchor="middle" transform="rotate(-90 17 155)">One-shot edit rate</text>
			<text class="efficiency-chart-hint" x="836" y="17" text-anchor="end">higher is better ↑</text>
			${points}
		</svg>
	</div>${buildEfficiencyColorLegendHtml(chartRows)}`;
}

function buildChartControlsHtml(): string {
	const buttons = EFFICIENCY_METRICS.map(metric =>
		`<button class="efficiency-metric-button${metric.key === efficiencyMetric ? ' active' : ''}" type="button" data-eff-metric="${metric.key}" aria-pressed="${metric.key === efficiencyMetric}">${metric.label}</button>`
	).join('');
	const bubbleOptions = EFFICIENCY_BUBBLE_METRICS.map(metric =>
		`<option value="${metric.key}"${metric.key === efficiencyBubbleMetric ? ' selected' : ''}>${metric.label}</option>`
	).join('');
	const colorOptions = [
		{ value: 'vendor', label: 'Vendor' },
		{ value: 'model', label: 'Model' },
	].map(option => `<option value="${option.value}"${option.value === efficiencyColorMode ? ' selected' : ''}>${option.label}</option>`).join('');
	return `<div class="efficiency-chart-controls">
		<div class="efficiency-control"><span>X-axis</span><div class="efficiency-metric-selector" role="group" aria-label="Efficiency comparison metric">${buttons}</div></div>
		<label class="efficiency-control"><span>Bubble size</span><select id="eff-bubble-metric">${bubbleOptions}</select></label>
		<label class="efficiency-control"><span>Color by</span><select id="eff-color-mode">${colorOptions}</select></label>
	</div>`;
}

const EFFICIENCY_TABLE_ID = 'model-leaderboard';
const EFFICIENCY_OTHER_TABLE_ID = 'model-leaderboard-other';
/** The sort both leaderboard tables last agreed on, as `column:direction`. */
let efficiencySharedSort = 'calls:desc';

function efficiencyDataColumns(totalCalls: number): DataTableColumn<EfficiencyRow>[] {
	return EFFICIENCY_COLUMN_DEFS.map((column): DataTableColumn<EfficiencyRow> => ({
		id: column.sortKey,
		label: column.label,
		headerHtml: `<span title="${escapeHtml(column.title)}">${escapeHtml(column.label)}</span>`,
		align: column.sortKey === 'model' || column.sortKey === 'calls' ? 'left' : 'right',
		firstSortDirection: column.sortKey === 'model' ? 'asc' : 'desc',
		className: column.sortKey === 'model' ? 'model-leaderboard-model' : undefined,
		sortValue: column.sortValue,
		render: row => ({ html: column.render(row, totalCalls) }),
	}));
}

/** One leaderboard table; the main and "Other models" tables share their sort order. */
function renderEfficiencyTable(tableId: string, peerTableId: string, rows: EfficiencyRow[], totalCalls: number): string {
	return renderDataTable<EfficiencyRow>({
		tableId,
		ariaLabel: 'Local Model Leaderboard',
		rows,
		columns: efficiencyDataColumns(totalCalls),
		initialSort: { columnId: 'calls', direction: 'desc' },
		className: 'model-leaderboard-table',
		rootClassName: 'model-leaderboard-table-wrap',
		rowOptions: row => ({ attributes: { style: `--model-color:${getEfficiencyColor(row.model)}` } }),
		onStateChange: state => {
			// Paging one table must not reset the other; only a changed sort order is shared.
			const sortKey = `${state.sortColumn}:${state.sortDirection}`;
			if (sortKey === efficiencySharedSort) { return; }
			efficiencySharedSort = sortKey;
			setDataTableState(peerTableId, { sortColumn: state.sortColumn, sortDirection: state.sortDirection, page: 1 });
			rerenderDataTable(peerTableId);
		},
	});
}

function buildEfficiencyTableHtml(rows: EfficiencyRow[], totalCalls: number, longTailModels: Set<string>): string {
	const mainRows = longTailModels.size > 0 ? rows.filter(row => !longTailModels.has(row.model)) : rows;
	const otherRows = longTailModels.size > 0 ? rows.filter(row => longTailModels.has(row.model)) : [];
	const table = renderEfficiencyTable(EFFICIENCY_TABLE_ID, EFFICIENCY_OTHER_TABLE_ID, mainRows, totalCalls);
	if (otherRows.length === 0) { return table; }
	const otherCalls = otherRows.reduce((sum, row) => sum + row.counters.calls, 0);
	const otherShare = totalCalls > 0 ? otherCalls / totalCalls : 0;
	return `${table}<details class="model-leaderboard-other" id="model-leaderboard-other"${efficiencyOtherModelsOpen ? ' open' : ''}>
		<summary>Other models (${otherRows.length}, ${formatRatePercent(otherShare)} of turns)</summary>
		${renderEfficiencyTable(EFFICIENCY_OTHER_TABLE_ID, EFFICIENCY_TABLE_ID, otherRows, totalCalls)}
	</details>`;
}

function buildModelEfficiencyContentHtml(): string {
	const usage = cachedModelEfficiency[efficiencyPeriod];
	if (!usage || Object.keys(usage).length === 0) {
		return '<div class="model-leaderboard-empty"><strong>No per-model efficiency data for this period.</strong><span>Run local agent sessions with model and tool-call metadata, then refresh the dashboard.</span></div>';
	}
	const allRows = buildEfficiencyRows(usage);
	const totalCalls = allRows.reduce((sum, row) => sum + row.counters.calls, 0);
	const filtered = filterLowUsageRows(allRows, usage);
	const note = filtered.hiddenNote ? `<span class="model-leaderboard-filter-note">${filtered.hiddenNote}</span>` : '';
	const filteredUsage: ModelEfficiencyUsage = Object.fromEntries(filtered.rows.map(row => [row.model, row.counters]));
	const longTailModels = computeLongTailModels(filteredUsage);
	return `<div class="efficiency-chart-header"><div><strong>Efficiency frontier</strong><span>One-shot edit rate is a local quality proxy, not a benchmark pass rate.</span></div>${buildChartControlsHtml()}</div>
		${buildEfficiencyChartHtml(filtered.rows)}
		<div class="model-leaderboard-heading"><div><strong>Most used models locally</strong><span>Ranked by your local turns; all averages use the same selected period.</span></div>${note}</div>
		${buildEfficiencyTableHtml(filtered.rows, totalCalls, longTailModels)}`;
}

function buildModelEfficiencySectionHtml(stats: UsageAnalysisStats): string {
	cachedModelEfficiency = { today: stats.today.modelEfficiency, last30Days: stats.last30Days.modelEfficiency, month: stats.month.modelEfficiency };
	return `<div class="section" id="section-model-efficiency">
		<div class="section-title"><span>🎯</span><span>Local Model Leaderboard</span></div>
		<div class="section-subtitle">Compare the models in your own sessions by local usage, one-shot edits, cost, output tokens, and tool steps. Exactness depends on what each editor records; missing structured data is shown as unavailable rather than estimated.</div>
		<div class="model-leaderboard-controls">
			<span id="model-efficiency-period-selector"></span>
			<label class="model-leaderboard-filter" title="Show only models above the 25th-percentile local turn count.">
				<input type="checkbox" id="eff-filter-low-usage"${efficiencyFilterLowUsage ? ' checked' : ''}>
				Hide low-usage models
			</label>
		</div>
		<div id="model-efficiency-content">${buildModelEfficiencyContentHtml()}</div>
	</div>`;
}

function renderModelEfficiencyPeriodSelector(): void {
	const wrapper = document.getElementById('model-efficiency-period-selector');
	if (!wrapper) { return; }
	wrapper.replaceChildren();
	const { wrapper: selectorWrapper } = createPeriodSelector({
		selected: efficiencySelectedPeriod,
		disabled: ['last7', 'last90', 'allTime'],
		disabledTitle: 'Not available for model efficiency',
		label: '',
		onChange: (value) => {
			const dataKey = EFFICIENCY_PERIOD_TO_DATA_KEY[value as Period];
			if (!dataKey) { return; }
			efficiencySelectedPeriod = value as Period;
			efficiencyPeriod = dataKey;
			rerenderModelEfficiencyContent();
		},
	});
	wrapper.append(selectorWrapper);
}

function rerenderModelEfficiencyContent(): void {
	const content = document.getElementById('model-efficiency-content');
	if (content) { setHtml(content, buildModelEfficiencyContentHtml()); }
}

/**
 * Remembers whether the "Other references" disclosure is open.
 *
 * The <details> is recreated on every re-render, which would otherwise snap it back to
 * collapsed the moment new stats arrive. `toggle` doesn't bubble, so listen in the capture phase.
 */
function setupContextRefSection(): void {
	const section = document.getElementById('section-context-references');
	if (!section) { return; }
	section.addEventListener('toggle', (event) => {
		const target = event.target as HTMLElement;
		if (target.id === 'ctx-ref-other') {
			contextRefOtherOpen = (target as HTMLDetailsElement).open;
		}
	}, true);
}

/** Wires chart controls and the low-usage filter; the leaderboard tables sort themselves. */
function setupModelEfficiencySection(): void {
	const section = document.getElementById('section-model-efficiency');
	if (!section) { return; }
	// The "Other models" <details> is recreated on every re-render (period, filter toggle, etc.),
	// which would otherwise always snap back to collapsed. `toggle` doesn't bubble, so listen
	// during the capture phase to catch it regardless of which re-rendered element raises it.
	section.addEventListener('toggle', (event) => {
		const target = event.target as HTMLElement;
		if (target.id === 'model-leaderboard-other') {
			efficiencyOtherModelsOpen = (target as HTMLDetailsElement).open;
		}
	}, true);
	section.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		const metric = target.closest<HTMLButtonElement>('button[data-eff-metric]')?.dataset.effMetric as EfficiencyMetricKey | undefined;
		if (metric && EFFICIENCY_METRICS.some(item => item.key === metric)) {
			efficiencyMetric = metric;
			rerenderModelEfficiencyContent();
		}
	});
	section.addEventListener('change', (event) => {
		const target = event.target as HTMLInputElement | HTMLSelectElement;
		if (target.id === 'eff-filter-low-usage') {
			efficiencyFilterLowUsage = (target as HTMLInputElement).checked;
			rerenderModelEfficiencyContent();
		} else if (target.id === 'eff-bubble-metric' && EFFICIENCY_BUBBLE_METRICS.some(item => item.key === target.value)) {
			efficiencyBubbleMetric = target.value as EfficiencyBubbleMetricKey;
			rerenderModelEfficiencyContent();
		} else if (target.id === 'eff-color-mode' && (target.value === 'vendor' || target.value === 'model')) {
			efficiencyColorMode = target.value;
			rerenderModelEfficiencyContent();
		}
	});
}

function buildToolsTabPanelHtml(
	stats: UsageAnalysisStats,
	allToolKeys: string[],
	allMcpToolKeys: string[],
	allMcpServerKeys: string[],
	allHighCostModels: string[],
	allLowCostModels: string[],
	allMediumCostModels: string[],
	allUnknownModels: string[],
): string {
	return `
		<div id="tab-panel-tools" class="tab-panel"${activeTab !== 'tools' ? ' style="display:none"' : ''}>
			<!-- Tool Calls Section -->
			<div class="section" id="section-tool-usage">
				<div class="section-title"><span>🔧</span><span>Tool Usage</span></div>
				<div class="section-subtitle">Functions and tools invoked by Copilot during interactions${hideAutomaticToolCalls ? ' (automatic tool calls hidden — disable "Hide Automatic Tool Calls" in settings to show them)' : ''}</div>
				<div class="three-column">
					<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total Tool Calls: ${formatNumber(stats.today.toolCalls.total)}</div>
						${renderToolsTable('tools-today', 'Tool Usage', unionFill(stats.today.toolCalls.byTool, allToolKeys), 10, lookupToolName, true)}
					</div>
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total Tool Calls: ${formatNumber(stats.last30Days.toolCalls.total)}</div>
							${renderToolsTable('tools-last30', 'Tool Usage', unionFill(stats.last30Days.toolCalls.byTool, allToolKeys), 10, lookupToolName, true)}
						</div>
					</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Previous Month</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total Tool Calls: ${formatNumber(stats.month.toolCalls.total)}</div>
							${renderToolsTable('tools-month', 'Tool Usage', unionFill(stats.month.toolCalls.byTool, allToolKeys), 10, lookupToolName, true)}
						</div>
					</div>
				</div>
			</div>

			${safeSectionHtml(localize('usage.tab.tools'), () => buildToolExecutionSectionsHtml({ toolCalls: stats.last30Days.toolCalls, mcpTools: stats.last30Days.mcpTools, resolveToolName: lookupToolName, hiddenTools: hideAutomaticToolCalls ? AUTOMATIC_TOOL_SET_WV : undefined }))}
			${buildMcpToolsSectionHtml(stats, allMcpToolKeys, allMcpServerKeys)}
			${buildCurationSectionHtml(currentCurationAnalysis ?? stats.curationAnalysis)}
			${buildMemoryFilesSectionHtml(currentMemoryFilesAnalysis ?? stats.memoryFilesAnalysis)}
			${buildServerMemoriesSectionHtml(currentServerMemoriesAnalysis ?? stats.serverMemoriesAnalysis)}
			${buildSkillSuggestionsSectionHtml(stats.repeatedTasks ?? null)}
			<!-- Multi-Model Usage Section -->
			<div class="section" id="section-multi-model">
				<div class="section-title"><span>🔀</span><span>Multi-Model Usage</span></div>
				<div class="section-subtitle">Track model diversity and switching patterns in your conversations</div>
				<div class="three-column">
					${renderMultiModelPeriod('📅 Today', stats.today.modelSwitching, allLowCostModels, allMediumCostModels, allHighCostModels, allUnknownModels)}
					${renderMultiModelPeriod('📆 Last 30 Days', stats.last30Days.modelSwitching, allLowCostModels, allMediumCostModels, allHighCostModels, allUnknownModels)}
					${renderMultiModelPeriod('📅 Previous Month', stats.month.modelSwitching, allLowCostModels, allMediumCostModels, allHighCostModels, allUnknownModels)}
				</div>
			</div>
		</div>`;
}

/**
 * Assigns the full dashboard HTML to `root`, isolating any failure that escapes the
 * per-section/per-tab safeSectionHtml wrapping in buildUsageRootHtml. On failure, falls back
 * to a minimal error state with a reload button instead of leaving the page on stale/blank
 * content. Returns true on success, false if the fallback error state was shown instead.
 */
function assignUsageRootHtml(root: HTMLElement, build: () => string): boolean {
	try {
		setHtml(root, build());
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[usage-webview] renderLayout failed: ${message}`);
		setHtml(root, `<div style="padding: 32px; text-align: center; font-size: 14px;">
			<div style="color: var(--vscode-foreground); opacity: 0.7; margin-bottom: 12px;">⚠️ Something went wrong rendering the dashboard.</div>
			${createRefreshButton().outerHTML}
		</div>`);
		return false;
	}
}

/**
 * Syncs module-level UI state (hygiene matrix, workspace paths, curation analysis cache) from
 * a fresh stats payload, and resolves the customization matrix to use for this render.
 */
function syncRenderLayoutState(stats: UsageAnalysisStats): WorkspaceCustomizationMatrix | null {
	// customizationMatrix is passed as an extra field on the stats object alongside the typed fields
	type StatsWithMatrix = UsageAnalysisStats & { customizationMatrix?: WorkspaceCustomizationMatrix | null };
	const matrix =
		(stats as StatsWithMatrix).customizationMatrix ??
		(initialData as StatsWithMatrix | undefined)?.customizationMatrix ?? null;
	hygieneMatrixState = matrix ?? null;
	if (!hygieneMatrixState || hygieneMatrixState.workspaces.length === 0) {
		selectedRepoPath = null;
	}
	if (Array.isArray(stats.currentWorkspacePaths)) {
		currentWorkspacePaths = stats.currentWorkspacePaths;
	}
	// Persist curation analysis across refreshes — periodic updateStats may omit it
	if (stats.curationAnalysis) {
		currentCurationAnalysis = stats.curationAnalysis;
		traceCuration('renderLayout.curation.cached', {
			availableTools: currentCurationAnalysis.availableTools.length,
			unusedTools: currentCurationAnalysis.unusedTools.length,
		});
	} else {
		traceCurationOnce('render-no-curation-update', 'renderLayout.curation.notProvidedInUpdate');
	}
	// Persist memory-files analysis across refreshes for the same reason. Whether the field was
	// omitted (keep cache) vs. explicitly cleared to null (all files gone) is resolved upstream in
	// handleUpdateStats before this runs, so a plain overwrite here is safe either way.
	currentMemoryFilesAnalysis = stats.memoryFilesAnalysis ?? null;
	currentServerMemoriesAnalysis = stats.serverMemoriesAnalysis ?? null;
	return matrix;
}

function renderLayout(stats: UsageAnalysisStats): void {
	lastRenderedStats = stats;
	const root = document.getElementById('root');
	if (!root) {
		return;
	}

	const matrix = syncRenderLayoutState(stats);
	darkFactoryTab.setAvailable(stats.readinessAvailable === true);
	currentCorrectionReport = stats.correctionReport;
	const customizationHtml = safeSectionHtml('Workspace Customization', () => buildCustomizationSectionHtml(matrix));
	// buildUsageAllKeysSets and the context-ref totals are cheap, pure aggregations over
	// already-validated stats — not worth isolating individually. buildUsageRootHtml (and each
	// tab/section within it) is isolated via safeSectionHtml / assignUsageRootHtml below.
	const allKeys = buildUsageAllKeysSets(stats);
	const todayTotalRefs = getTotalContextRefs(stats.today.contextReferences);
	const last30DaysTotalRefs = getTotalContextRefs(stats.last30Days.contextReferences);
	const thinkingEffortHtml = safeSectionHtml('Thinking Effort', () => buildThinkingEffortSectionHtml(stats));
	const sessionsSummaryHtml = `
		<!-- Summary Section -->
		<div class="section" id="section-sessions-summary">
			<div class="section-title"><span>📈</span><span>Sessions Summary</span></div>
			<div class="stats-grid">
				<div class="stat-card"><div class="stat-label">📅 Today Sessions</div><div class="stat-value">${formatNumber(stats.today.sessions)}</div></div>
				<div class="stat-card"><div class="stat-label">📆 Last 30 Days Sessions</div><div class="stat-value">${formatNumber(stats.last30Days.sessions)}</div></div>
				<div class="stat-card"><div class="stat-label">📅 This Month Sessions</div><div class="stat-value">${formatNumber(stats.month.sessions)}</div></div>
				<div class="stat-card"><div class="stat-label">📅 Last Month Sessions</div><div class="stat-value">${formatNumber(stats.lastMonth.sessions)}</div></div>
			</div>
		</div>`;

	const rendered = assignUsageRootHtml(root, () => buildUsageRootHtml(
		stats,
		customizationHtml,
		'',
		thinkingEffortHtml,
		sessionsSummaryHtml,
		todayTotalRefs,
		last30DaysTotalRefs,
		allKeys.allToolKeys,
		allKeys.allMcpToolKeys,
		allKeys.allMcpServerKeys,
		allKeys.allHighCostModels,
		allKeys.allLowCostModels,
		allKeys.allMediumCostModels,
		allKeys.allUnknownModels,
	));
	if (!rendered) { return; }

	wireNavigationButtons();
	wireAboutInfoToggle();
	wireRepositoryButtons();
	wireCurationButtons();
	renderRepositoryHygienePanels();
	// Before setupTabs(): its first-visit replay marks new insights as seen when the render opens
	// on the Insights tab (a deep link can), and that reads currentInsights. Assigned after, the
	// replay would iterate an empty array and silently mark nothing.
	currentInsights = stats.insights ?? [];
	setupTabs();
	darkFactoryTab.attach();
	setupModelEfficiencySection();
	setupContextRefSection();
	renderModelEfficiencyPeriodSelector();
	renderSessionsLookbackSelector();
	setupWorktreesHandlers();
	wireCopyButtons();
	wireCorrectionInteractions();
	// currentInsights is assigned above, before setupTabs(); this only wires the card buttons.
	wireInsightCardButtons();
	scrollToPendingTabAnchor();
	// A full layout rebuild — e.g. a background stats refresh landing mid-navigation — destroys
	// the card a still-fresh insight anchor pointed at, just as an insights-only re-render does.
	reapplyFocusedInsightAnchor();
	// The GitHub activity containers only exist now. Re-announce readiness so the extension
	// replays any PR / cloud-agent state that was posted while the DOM had no place to put it.
	restoreGitHubActivityPanels(repoPrStatsData, agentSessionsData, updateReposPrPanel, updateAgentSessionsPanel);
	notifyUsageWebviewReady('layout-rendered');
}

/** Wires up the collapsible "About This Dashboard" info box; the collapsed state is persisted via webview state. */
function wireAboutInfoToggle(): void {
	const toggle = document.getElementById('about-info-toggle');
	const body = document.getElementById('about-info-body');
	if (!toggle || !body) { return; }
	const chevron = toggle.querySelector('.info-box-chevron');
	const applyToggle = (): void => {
		aboutCollapsed = !aboutCollapsed;
		body.style.display = aboutCollapsed ? 'none' : '';
		toggle.setAttribute('aria-expanded', String(!aboutCollapsed));
		if (chevron) { chevron.textContent = aboutCollapsed ? '▸' : '▾'; }
		vscode.setState({ ...(vscode.getState() ?? {}), aboutCollapsed });
	};
	toggle.addEventListener('click', applyToggle);
	toggle.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			applyToggle();
		}
	});
}

/** Wires up top-level navigation toolbar buttons (refresh, details, chart, etc.). */
function wireNavigationButtons(): void {
	document.getElementById('btn-refresh')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'refresh' });
	});
	document.getElementById('btn-details')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDetails' });
	});
	document.getElementById('btn-chart')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showChart' });
	});
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDiagnostics' });
	});
	document.getElementById('btn-maturity')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showMaturity' });
	});
	document.getElementById('btn-dashboard')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDashboard' });
	});
	document.getElementById('btn-environmental')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showEnvironmental' });
	});
	document.getElementById('btn-efficiency')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showEfficiency' });
	});
	wireExtensionPointButtons(vscode);
}

/** Wires up repository hygiene analysis buttons and pane click handlers. */
function setButtonAnalyzingState(btn: (HTMLElement & { disabled: boolean }) | null, analyzingText: string): void {
	if (!btn) { return; }
	btn.disabled = true;
	btn.textContent = analyzingText;
	btn.setAttribute('appearance', 'secondary');
}

function wireRepositoryButtons(): void {
	document.getElementById('btn-analyse-repo')?.addEventListener('click', () => {
		const btn = document.getElementById('btn-analyse-repo') as HTMLElement & { disabled: boolean };
		isSingleRepoAnalysisInProgress = true;
		setButtonAnalyzingState(btn, 'Analyzing...');
		vscode.postMessage({ command: 'analyseRepository' });
	});

	document.getElementById('btn-analyse-all')?.addEventListener('click', () => {
		const btn = document.getElementById('btn-analyse-all') as HTMLElement & { disabled: boolean };
		setButtonAnalyzingState(btn, 'Analyzing All...');
		isBatchAnalysisInProgress = true;
		isSwitchingRepository = true;
		selectedRepoPath = null;
		for (const ws of hygieneMatrixState?.workspaces ?? []) {
			if (!ws.workspacePath.startsWith('<unresolved:')) {
				repoAnalysisInFlight.add(ws.workspacePath);
			}
		}
		renderRepositoryHygienePanels();
		vscode.postMessage({ command: 'analyseAllRepositories' });
	});

	document.getElementById('repo-list-pane')?.addEventListener('click', (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		if (target.closest('#btn-show-other-workspaces')) {
			showAllWorkspacesInHealth = true;
			renderRepositoryHygienePanels();
			return;
		}
		if (target.closest('#btn-collapse-other-workspaces')) {
			showAllWorkspacesInHealth = false;
			renderRepositoryHygienePanels();
			return;
		}
		const actionButton = target.closest<HTMLElement>('.btn-repo-action');
		if (!actionButton) { return; }
		const workspacePath = actionButton.getAttribute('data-workspace-path');
		const action = actionButton.getAttribute('data-action');
		if (!workspacePath || !action) { return; }
		if (action === 'details') {
			selectedRepoPath = workspacePath;
			isSwitchingRepository = false;
			renderRepositoryHygienePanels();
			return;
		}
		if (action === 'analyze') {
			repoAnalysisInFlight.add(workspacePath);
			isBatchAnalysisInProgress = false;
			renderRepositoryHygienePanels();
			vscode.postMessage({ command: 'analyseRepository', workspacePath });
		}
	});

	document.getElementById('repo-details-pane')?.addEventListener('click', (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		if (target.closest('#btn-switch-repository')) {
			isSwitchingRepository = true;
			renderRepositoryHygienePanels();
		}
	});

	// Delegated on the persistent container (its innerHTML is replaced wholesale on every
	// `updateReposPrPanel` re-render) so this keeps working across refreshes without rewiring.
	wireCcrActivityButtons('repos-pr-content', (message) => vscode.postMessage(message));
	// `toggle` does not bubble, so listen in the capture phase.
	document.getElementById('repos-pr-content')?.addEventListener('toggle', event => {
		const details = event.target instanceof HTMLDetailsElement ? event.target : null;
		const key = details?.getAttribute('data-repo-pr-details');
		if (!details || !key) { return; }
		if (details.open) { openRepoPrDetails.add(key); } else { openRepoPrDetails.delete(key); }
	}, true);
}

/** Wires up copy-to-clipboard buttons (class `cf-copy`). */
function wireCopyButtons(): void {
	Array.from(document.getElementsByClassName('cf-copy')).forEach((el) => {
		(el as HTMLElement).addEventListener('click', (ev) => {
			const target = ev.currentTarget as HTMLElement;
			const path = target.getAttribute('data-path') || '';
			if (navigator.clipboard && path) {
				navigator.clipboard.writeText(path).then(() => {
					target.textContent = 'Copied';
					setTimeout(() => { target.textContent = 'Copy'; }, 1200);
				}).catch(() => {
					vscode.postMessage({ command: 'copyFailed', path });
				});
			}
		});
	});
}

function handleUpdateStats(message: any): void {
	clearLoadingTimeout();
	// The initial payload is `null` for a panel opened before any stats were cached, so this is
	// the first chance to localize. applyWebviewLocale ignores unresolved keys, and
	// re-applying the same map is a no-op, so this is safe to run on every update.
	applyWebviewLocale(message.data);
	if (typeof message.data?.use24HourTime === 'boolean') {
		use24HourTime = message.data.use24HourTime;
	}
	if (typeof message.data?.hideAutomaticToolCalls === 'boolean') {
		hideAutomaticToolCalls = message.data.hideAutomaticToolCalls;
	}
	const sanitized = sanitizeStats(message.data);
	if (sanitized) {
		_ulLoadingActive = false;
		if (!Object.prototype.hasOwnProperty.call(message.data ?? {}, 'correctionReport')) {
			sanitized.correctionReport = currentCorrectionReport;
		}
		if (!Object.prototype.hasOwnProperty.call(message.data ?? {}, 'memoryFilesAnalysis')) {
			sanitized.memoryFilesAnalysis = currentMemoryFilesAnalysis;
		}
		// Same rule for the server memories, and it matters more here: this card is filled by
		// an out-of-band background fetch, so a partial refresh arriving between fetches would
		// otherwise blank a section the host is not going to re-send until its TTL expires.
		if (!Object.prototype.hasOwnProperty.call(message.data ?? {}, 'serverMemoriesAnalysis')) {
			sanitized.serverMemoriesAnalysis = currentServerMemoriesAnalysis;
		}
		// CLI-backed hosts include all buckets; VS Code omits them and keeps using lazy loading.
		replaceRecentSessionsCache(sanitized.recentSessions);
		renderLayout(sanitized);
		setupSessionsTableHandlers();
		renderRepositoryHygienePanels();
	} else {
		traceCurationOnce('update-invalid-sanitized', 'handleUpdateStats.sanitizeReturnedNull');
		showLoadError('Received invalid data from the extension. Try refreshing.');
	}
}

/** Replaces the per-account budget list in place; the next full `updateStats` carries it too. */
function handleUpdateAccountBudgets(message: { accountBudgets?: unknown; copilotApiBalance?: unknown }): void {
	const accounts = sanitizeAccountBudgets(message.accountBudgets);
	const container = document.getElementById('account-budgets');
	if (!lastRenderedStats) {
		if (container) { setHtml(container, buildAccountBudgetsHtml(accounts, true)); }
		return;
	}
	const wasShown = billingSectionHasContent(lastRenderedStats);
	lastRenderedStats.accountBudgets = accounts;
	// The preferred account's balance travels with the list so clearing it (sign-out, account removed)
	// reaches this view too. Absent means "unchanged"; null means "cleared".
	let balanceChanged = false;
	if (Object.prototype.hasOwnProperty.call(message, 'copilotApiBalance')) {
		const balance = sanitizeCopilotApiBalance(message.copilotApiBalance);
		balanceChanged = JSON.stringify(balance) !== JSON.stringify(lastRenderedStats.copilotApiBalance ?? null);
		lastRenderedStats.copilotApiBalance = balance;
	}
	if (balanceChanged || wasShown !== billingSectionHasContent(lastRenderedStats)) {
		// The section appeared, disappeared or changed its balance card: re-render it, not just the list.
		renderLayout(lastRenderedStats);
		setupSessionsTableHandlers();
	} else if (container) {
		setHtml(container, buildAccountBudgetsHtml(accounts, !!lastRenderedStats.copilotApiBalance));
	}
}

function handleToolSuppressed(toolName: string): void {
	if (!toolName) { return; }
	const section = document.getElementById('unknown-mcp-tools-section');
	if (!section) { return; }
	section.querySelectorAll<HTMLButtonElement>('button[data-suppress-tool]').forEach(btn => {
		if (btn.getAttribute('data-suppress-tool') === toolName) {
			btn.closest('span')?.remove();
		}
	});
	if (section.querySelectorAll('button[data-suppress-tool]').length === 0) {
		section.remove();
	}
}

function handleHighlightUnknownTools(): void {
	clearFocusedInsightAnchor();
	activateUsageTab('tools');
	const el = document.getElementById('unknown-mcp-tools-section');
	if (el) {
		el.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' });
		flashAnchorHighlight(el);
	}
}

function handleRepoPrStatsLoaded(data: any): void {
	repoPrStatsData = sanitizeRepoPrStatsData(data);
	if (!repoPrStatsData.authenticated) { repoPrStatsLoaded = false; }
	// Only the failure is worth a log line: a successful render is visible in the panel, but a
	// payload that arrives and renders nothing looks identical to one that never arrived.
	if (!updateReposPrPanel(repoPrStatsData)) {
		traceToHost('repoPrStatsLoaded.notRendered', {
			repos: repoPrStatsData.repos.length,
			authenticated: repoPrStatsData.authenticated,
		});
	}
}

function handleAgentSessionsLoaded(data: any): void {
	if (!data || typeof data !== 'object') { return; }
	agentSessionsData = sanitizeAgentSessionsData(data);
	if (!agentSessionsData.authenticated) { agentSessionsLoaded = false; }
	if (!updateAgentSessionsPanel(agentSessionsData)) {
		traceToHost('agentSessionsLoaded.notRendered', { authenticated: agentSessionsData.authenticated });
	}
}

function handleUpdateInsights(rawInsights: unknown): void {
	if (!Array.isArray(rawInsights)) { return; }
	const sanitized = sanitizeInsights(rawInsights);
	refreshInsightsPanel(sanitized);
}

function handleLoadingStateMessage(message: any): boolean {
	switch (message.command) {
		case 'usageLoadingProgress':
			updateUsageLoadingProgress(message); return true;
		case 'usageRefreshing':
			clearLoadingTimeout();
			_ulLastStepIdx = 0;
			darkFactoryTab.invalidate();
			renderUsageLoadingState('Refreshing Usage Analysis');
			return true;
		case 'updateStatsError':
			clearLoadingTimeout();
			showLoadError('Failed to calculate usage analysis. Check the Output panel for details.');
			return true;
	}
	return false;
}

/** Handles repository hygiene analysis messages. Returns true when the command was handled. */
function handleRepoAnalysisMessage(message: any): boolean {
	switch (message.command) {
		case 'repoAnalysisResults':
			try {
				displayRepoAnalysisResults(message.data, message.workspacePath);
			} catch (err) {
				console.error('Failed to render repo analysis results', err);
				displayRepoAnalysisError(err instanceof Error ? err.message : String(err), message.workspacePath);
			}
			return true;
		case 'repoAnalysisError':
			displayRepoAnalysisError(message.error, message.workspacePath);
			return true;
		case 'repoAnalysisBatchComplete':
			handleBatchAnalysisComplete();
			return true;
	}
	return false;
}

function handleTabMessage(message: any): boolean {
	if (message.command === 'readinessLoaded' || message.command === 'readinessScanFailed') { return darkFactoryTab.handleMessage(message); }
	if (message.command === 'ccrActivityResult' || message.command === 'ccrActivityError') {
		renderCcrActivityResult(String(message.owner ?? ''), String(message.repo ?? ''), Number(message.prNumber), message);
		return true;
	}
	return false;
}

function handleExtensionMessage(message: any): void {
	if (handleLoadingStateMessage(message)) { return; }
	if (handleRepoAnalysisMessage(message)) { return; }
	if (handleTabMessage(message)) { return; }
	switch (message.command) {
		case 'updateStats':
			handleUpdateStats(message); break;
		case 'toolSuppressed':
			handleToolSuppressed(message.toolName as string); break;
		case 'highlightUnknownTools':
			handleHighlightUnknownTools(); break;
		case 'repoPrStatsLoaded':
			handleRepoPrStatsLoaded(message.data); break;
		case 'repoPrStatsProgress':
			updateProgressPanel('#repos-pr-content', 'repos-pr-progress', 'Fetching PRs…', message.done as number, message.total as number);
			break;
		case 'agentSessionsLoaded':
			handleAgentSessionsLoaded(message.data); break;
		case 'recentSessionsLoaded':
			handleRecentSessionsLoaded(message); break;
		case 'agentSessionsProgress':
			updateProgressPanel('#agent-sessions-content', 'agent-sessions-progress', 'Fetching agent sessions…', message.done as number, message.total as number);
			break;
		case 'updateInsights':
			handleUpdateInsights(message.insights); break;
		case 'updateAccountBudgets':
			handleUpdateAccountBudgets(message); break;
		case 'switchTab':
			handleSwitchTab(message); break;
		case 'cancelPendingNavigation':
			// The user opened Usage Analysis itself; a deep link still waiting for its
			// section must not scroll them away from it later.
			clearFocusedInsightAnchor(); break;
		default:
			handleWorktreeMessage(message); break;
	}
}

/**
 * Applies a pre-set Recent Sessions filter carried by a `switchTab` message.
 *
 * Today the only preset is `nearContextLimit`, sent by the "Show these sessions"
 * action on the "Some sessions nearly ran out of context window" insight. The
 * Context column is force-enabled with it: a user who had hidden that column
 * would otherwise land on a filtered table with no visible fill percentage to
 * explain why those rows are the ones listed.
 */
function applySessionsTabPreset(preset: any): void {
	if (!preset || typeof preset !== 'object' || preset.filter !== 'nearContextLimit') { return; }
	sessionFilterNearContextLimitOnly = true;
	sessionFilterEditors.clear();
	sessionFilterVendors.clear();
	sessionFilterModels.clear();
	sessionFilterHydraFusionOnly = false;
	setDataTableState(SESSIONS_TABLE_ID, { page: 1 });
	enableSessionColumn('contextFill');
	if (preset.lookback && PERIOD_LABELS[preset.lookback as Period]) {
		sessionsLookback = preset.lookback as SessionsLookback;
	}
}

/**
 * Turns a column on in module state *and* in the already-rendered Columns menu.
 *
 * The menu is built once with the tab panel and sits outside `#sessions-panel-body`,
 * so a re-render of the table never rebuilds it: flipping only the state would leave
 * the checkbox unticked next to a visible column, and the next click on it would
 * toggle the opposite of what it shows.
 */
function enableSessionColumn(id: SessionColumnId): void {
	presetForcedColumns.add(id);
	enabledSessionColumns.add(id);
	const checkbox = document.querySelector<HTMLInputElement>(`#sessions-columns-menu input[data-column="${id}"]`);
	if (checkbox) { checkbox.checked = true; }
}

/**
 * Re-applies preset-forced columns over the saved column settings.
 *
 * `bootstrap()` yields on a dynamic import before it restores saved settings, and
 * the message listener is live from module evaluation — so the host's pending
 * `switchTab` preset routinely lands first, and the assignment that restores saved
 * settings replaces the whole Set, dropping the column the preset turned on. That
 * is the *normal* path when the insight opens a panel that wasn't already open.
 */
function reapplyPresetForcedColumns(): void {
	for (const id of presetForcedColumns) { enabledSessionColumns.add(id); }
}

function handleSwitchTab(message: any): void {
	const tab = String(message.tab);
	// Ignore unknown tabs entirely: a bogus name must not blank the dashboard, and only
	// allowlisted names may be interpolated into the selector below.
	if (!isSwitchableTab(tab)) { return; }
	applySessionsTabPreset(message.sessionsPreset);
	// Persist the requested tab in module state, not just the DOM: while the webview is in
	// its loading state the tab bar doesn't exist, so btn.click() below silently no-ops and
	// the later renderLayout would land on the default tab — swallowing e.g. the worktree
	// notification's "Show Me" action. With activeTab set, the eventual render honors it.
	// A newer host navigation supersedes a deferred scroll still queued for an older one,
	// even when this one's own section has not rendered yet.
	cancelPendingAnchorScroll();
	pendingTabAnchor = typeof message.anchor === 'string' && message.anchor ? message.anchor : null;
	pendingTabAnchorExpiresAt = Date.now() + PENDING_ANCHOR_TTL_MS;
	// activateUsageTab sets activeTab even when it finds no panel, so a switch that arrives
	// during the loading state is still honored by the render that follows.
	activateUsageTab(tab);
	if (tab === 'sessions' && message.sessionsPreset) {
		// Re-render the body so the preset's lookback is fetched and its filter is reflected in
		// the pill bar.
		renderSessionsLookbackSelector();
		refreshSessionsPanelBody();
	}
	// A card anchor has to outlive the re-renders that follow this navigation; a static section
	// anchor is stable and needs no such window. (User-driven tab clicks drop any pending insight
	// deep link in their click handlers; this navigation is the host's, not the user's.)
	focusedInsightAnchor = pendingTabAnchor && isInsightCardAnchor(pendingTabAnchor)
		? { anchor: pendingTabAnchor, until: Date.now() + INSIGHT_FOCUS_WINDOW_MS }
		: null;
	scrollToPendingTabAnchor();
}

function scrollToPendingTabAnchor(): void {
	if (!pendingTabAnchor) { return; }
	if (Date.now() > pendingTabAnchorExpiresAt) {
		// The section never rendered in time. Landing on it minutes later, on some
		// unrelated stats refresh, would yank the user away from whatever they are reading.
		pendingTabAnchor = null;
		return;
	}
	const anchor = document.getElementById(pendingTabAnchor);
	if (anchor) {
		pendingTabAnchor = null;
		lastAnchorScrollTarget = anchor;
		// Only one deferred scroll may be in flight: a newer target replaces an older one.
		cancelPendingAnchorScroll();
		const timer = setTimeout(() => {
			if (pendingAnchorScrollTimer === timer) { pendingAnchorScrollTimer = null; }
			anchor.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
			flashAnchorHighlight(anchor);
		}, 50);
		// Tracked for every anchor, so navigating away inside the defer — or the host cancelling
		// with cancelPendingNavigation — stops it scrolling and flashing what the user left behind.
		pendingAnchorScrollTimer = timer;
	}
}

/**
 * Briefly outlines the element we just scrolled to. Landing on the right tab is not the same as
 * pointing at the one card the notification was about — on a tab holding a dozen look-alike
 * insight cards, the flash is what tells the user which one they were sent to.
 */
function flashAnchorHighlight(element: HTMLElement): void {
	// Re-flashing an element that is still lit must not capture the flash's *own* outline as the
	// styling to restore — the second timer would then "restore" the outline permanently. Reuse
	// the styling the first flash captured and cancel its timer instead.
	const inFlight = activeFlashes.get(element);
	if (inFlight) { clearTimeout(inFlight.timer); }
	// A "new" insight card already carries its own inline glow; put it back afterwards rather than
	// clearing the property, or the flash would permanently strip the card's own styling.
	const shadow = inFlight ? inFlight.shadow : element.style.boxShadow;
	const transition = inFlight ? inFlight.transition : element.style.transition;
	element.style.transition = 'box-shadow 0.3s ease';
	element.style.boxShadow = '0 0 0 3px var(--vscode-focusBorder)';
	const timer = setTimeout(() => {
		activeFlashes.delete(element);
		element.style.boxShadow = shadow;
		element.style.transition = transition;
	}, 2000);
	activeFlashes.set(element, { shadow, transition, timer });
}

/**
 * Forgets any pending deep link — an insight card or a section — so nothing later scrolls the
 * user away from where they chose to look. Called on the user's own navigation (tab and group
 * clicks) and when the host cancels (`cancelPendingNavigation`); `handleSwitchTab` never calls
 * it, so the host's own navigation keeps the anchor it just requested.
 *
 * Both halves have to go. A link whose target did not exist yet is still sitting in
 * `pendingTabAnchor`, which `renderLayout` consumes without consulting the active tab — so
 * leaving it set would aim a later render at a section or card on a tab the user has left
 * (a conditional section such as Thinking Effort can appear on a much later stats load).
 */
function clearFocusedInsightAnchor(): void {
	focusedInsightAnchor = null;
	pendingTabAnchor = null;
	cancelPendingAnchorScroll();
}

/** Stops a deferred anchor scroll that has not fired yet, if any. */
function cancelPendingAnchorScroll(): void {
	if (pendingAnchorScrollTimer !== null) {
		clearTimeout(pendingAnchorScrollTimer);
		pendingAnchorScrollTimer = null;
	}
}

/**
 * Re-applies a still-fresh insight anchor after the cards were rebuilt. Called from the insights
 * re-render, where the element the pending anchor pointed at has just been replaced.
 */
function reapplyFocusedInsightAnchor(): void {
	if (!focusedInsightAnchor) { return; }
	if (Date.now() >= focusedInsightAnchor.until) {
		focusedInsightAnchor = null;
		return;
	}
	// The user may have clicked away in the meantime; re-scrolling a card on a hidden tab would
	// only fight whatever they chose to look at instead.
	if (activeTab !== 'insights') {
		focusedInsightAnchor = null;
		return;
	}
	const card = document.getElementById(focusedInsightAnchor.anchor);
	// Nothing was rebuilt — we are still looking at the very node we just scrolled to.
	if (!card || card === lastAnchorScrollTarget) { return; }
	pendingTabAnchor = focusedInsightAnchor.anchor;
	scrollToPendingTabAnchor();
}

// Listen for messages from the extension
let _traceBudget = 20;
function traceToHost(stage: string, details: Record<string, unknown>): void {
	// Bounded so a chatty session can't flood the Output channel.
	if (_traceBudget <= 0) { return; }
	_traceBudget--;
	vscode.postMessage({ command: 'usageWebviewTrace', stage, details });
}

registerMessageHandler<any>((message) => {
	// An exception thrown here escapes the listener uncaught and is only visible in the
	// webview devtools, which nobody has open — the panel just silently stays on "Loading…".
	// Report it back to the extension so it lands in the Output channel instead.
	try {
		handleExtensionMessage(message);
	} catch (err) {
		traceToHost('handleExtensionMessage.threw', {
			command: String(message?.command ?? ''),
			error: err instanceof Error ? err.message : String(err),
		});
	}
}, (event) => {
	// Tripwire for the failure that made every panel hang on "Loading…": the source-trust
	// check silently discarding real extension messages. Bounded by the trace budget, and
	// silent unless the trust model breaks again on some future host build.
	traceToHost('message-rejected-untrusted', {
		command: String((event as any)?.data?.command ?? '(none)'),
		origin: event.origin,
		ownOrigin: location.origin,
		href: String(location.href).slice(0, 120),
	});
});
// Uncaught errors in a webview are invisible without devtools open; surface them in the
// extension's Output channel instead.
window.addEventListener('error', (event) => {
	traceToHost('window.error', { message: String(event.message).slice(0, 200) });
});
window.addEventListener('unhandledrejection', (event: any) => {
	traceToHost('unhandledRejection', { reason: String(event?.reason).slice(0, 200) });
});
notifyUsageWebviewReady('listener-registered');

function getWorkspaceName(workspacePath: string): string {
	const workspace = hygieneMatrixState?.workspaces.find((ws) => ws.workspacePath === workspacePath);
	return workspace?.workspaceName || workspacePath;
}

function getScoreLabel(workspacePath: string): string {
	const record = repoAnalysisState.get(workspacePath);
	if (record?.data?.summary) {
		const percentage = toFiniteNumber(record.data.summary.percentage);
		return `${Math.round(percentage)}%`;
	}
	if (record?.error) {
		return 'Error';
	}
	return '—';
}

function toFiniteNumber(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

const REPO_DOCS_LINKS: { [key: string]: string } = {
	'git-repo': 'https://docs.github.com/en/get-started/using-git/about-git',
	'gitignore': 'https://docs.github.com/en/get-started/getting-started-with-git/ignoring-files',
	'env-example': 'https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions',
	'editorconfig': 'https://editorconfig.org/',
	'linter': 'https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning',
	'formatter': 'https://docs.github.com/en/contributing/style-guide-and-content-model/style-guide',
	'type-safety': 'https://docs.github.com/en/code-security/code-scanning/reference/code-ql-built-in-queries/javascript-typescript-built-in-queries',
	'commit-messages': 'https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/about-commits',
	'conventional-commits': 'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets',
	'ci-config': 'https://docs.github.com/en/actions/about-github-actions/understanding-github-actions',
	'scripts': 'https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs',
	'task-runner': 'https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/add-scripts',
	'devcontainer': 'https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration',
	'dockerfile': 'https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry',
	'version-pinning': 'https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration/setting-up-your-nodejs-project-for-codespaces',
	'license': 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository'
};

const REPO_CATEGORY_LABELS: { [key: string]: string } = {
	versionControl: '🔄 Version Control',
	codeQuality: '✨ Code Quality',
	cicd: '🚀 CI/CD',
	environment: '🔧 Environment',
	documentation: '📚 Documentation'
};

function buildScoreHeaderElement(summary: any): HTMLElement {
	const header = el('div');
	header.setAttribute('style', 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;');
	const title = el('div');
	title.setAttribute('style', 'font-size: 14px; font-weight: 600; color: var(--text-primary);');
	title.textContent = '📊 Repository Hygiene Score';
	const score = el('div');
	score.setAttribute('style', 'font-size: 24px; font-weight: 700; color: var(--link-color);');
	score.textContent = `${Math.round(toFiniteNumber(summary.percentage))}%`;
	header.append(title, score);
	return header;
}

function buildStatsGridElement(summary: any): HTMLElement {
	const statsGrid = el('div');
	statsGrid.setAttribute('style', 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;');
	const statCards = [
		{ count: summary.passedChecks, label: 'Passed', cardStyle: 'text-align: center; padding: 8px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 4px;', countStyle: 'font-size: 18px; font-weight: 600; color: var(--success-fg);' },
		{ count: summary.warningChecks, label: 'Warnings', cardStyle: 'text-align: center; padding: 8px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 4px;', countStyle: 'font-size: 18px; font-weight: 600; color: var(--warning-fg);' },
		{ count: summary.failedChecks, label: 'Failed', cardStyle: 'text-align: center; padding: 8px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 4px;', countStyle: 'font-size: 18px; font-weight: 600; color: #ef4444;' }
	];
	for (const statCard of statCards) {
		const card = el('div');
		card.setAttribute('style', statCard.cardStyle);
		const count = el('div');
		count.setAttribute('style', statCard.countStyle);
		count.textContent = String(toFiniteNumber(statCard.count));
		const label = el('div');
		label.setAttribute('style', 'font-size: 10px; color: var(--text-secondary);');
		label.textContent = statCard.label;
		card.append(count, label);
		statsGrid.appendChild(card);
	}
	return statsGrid;
}

function resolveCheckStatus(check: RepoHygieneCheck): { status: string; emoji: CustomizationTypeStatus; color: string } {
	const status = check?.status === 'pass' || check?.status === 'warning' ? check.status : 'fail';
	const emoji: CustomizationTypeStatus = status === 'pass' ? '✅' : status === 'warning' ? '⚠️' : '❌';
	const color = status === 'pass' ? '#22c55e' : status === 'warning' ? '#f59e0b' : '#ef4444';
	return { status, emoji, color };
}

function buildCheckContentElement(check: RepoHygieneCheck, statusColor: string): HTMLElement {
	const content = el('div');
	content.setAttribute('style', 'flex: 1;');
	const checkLabel = el('div');
	checkLabel.setAttribute('style', `font-size: 12px; font-weight: 600; color: ${statusColor};`);
	checkLabel.textContent = typeof check?.label === 'string' ? check.label : '';
	const checkDetail = el('div');
	checkDetail.setAttribute('style', 'font-size: 11px; color: var(--text-secondary); margin-top: 2px;');
	checkDetail.textContent = typeof check?.detail === 'string' ? check.detail : '';
	content.append(checkLabel, checkDetail);
	if (typeof check?.hint === 'string' && check.hint.length > 0) {
		const hint = el('div');
		hint.setAttribute('style', 'font-size: 10px; color: var(--link-color); margin-top: 4px; font-style: italic;');
		hint.textContent = `💡 ${check.hint}`;
		content.appendChild(hint);
	}
	const docUrl = REPO_DOCS_LINKS[typeof check?.id === 'string' ? check.id : ''];
	if (docUrl) {
		const docLink = el('a');
		docLink.setAttribute('href', docUrl);
		docLink.setAttribute('style', 'font-size: 10px; color: var(--link-color); margin-top: 4px; display: inline-block;');
		docLink.setAttribute('title', 'View official documentation');
		docLink.textContent = '📖 View documentation';
		content.appendChild(docLink);
	}
	return content;
}

function buildCheckRowElement(check: RepoHygieneCheck): HTMLElement {
	const { emoji, color } = resolveCheckStatus(check);
	const checkRow = el('div');
	checkRow.setAttribute('style', 'padding: 8px; border-bottom: 1px solid var(--border-subtle); display: flex; align-items: flex-start; gap: 8px;');
	const icon = el('span');
	icon.setAttribute('style', 'flex-shrink: 0; padding-top: 1px;');
	setHtml(icon, statusBadgeHtml(emoji));
	const weight = el('span');
	weight.setAttribute('style', 'font-size: 10px; color: var(--text-muted); min-width: 30px; text-align: right;');
	weight.textContent = `+${toFiniteNumber(check?.weight)}`;
	checkRow.append(icon, buildCheckContentElement(check, color), weight);
	return checkRow;
}

function buildCategorySectionElement(categoryId: string, categoryChecks: RepoHygieneCheck[], summary: any): HTMLElement {
	const section = el('div');
	section.setAttribute('style', 'margin-bottom: 12px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden;');
	const sectionHeader = el('div');
	sectionHeader.setAttribute('style', 'padding: 8px 12px; background: var(--list-hover-bg); border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;');
	const categoryName = el('span');
	categoryName.setAttribute('style', 'font-size: 12px; font-weight: 600; color: var(--text-primary);');
	categoryName.textContent = REPO_CATEGORY_LABELS[categoryId] || categoryId;
	const categorySummary = summary?.categories?.[categoryId];
	const categoryPct = el('span');
	categoryPct.setAttribute('style', 'font-size: 11px; color: var(--link-color); font-weight: 600;');
	categoryPct.textContent = `${Math.round(toFiniteNumber(categorySummary?.percentage))}%`;
	sectionHeader.append(categoryName, categoryPct);
	section.appendChild(sectionHeader);
	for (const check of categoryChecks) {
		section.appendChild(buildCheckRowElement(check));
	}
	return section;
}

function buildRecommendationsSectionElement(recommendations: RepoHygieneRecommendation[]): HTMLElement {
	const section = el('div');
	section.setAttribute('style', 'margin-top: 16px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden;');
	const hdr = el('div');
	hdr.setAttribute('style', 'padding: 8px 12px; background: var(--list-hover-bg); border-bottom: 1px solid var(--border-color);');
	const hdrTitle = el('span');
	hdrTitle.setAttribute('style', 'font-size: 12px; font-weight: 600; color: var(--text-primary);');
	hdrTitle.textContent = '💡 Top Recommendations';
	hdr.appendChild(hdrTitle);
	section.appendChild(hdr);
	for (const rec of recommendations.slice(0, 5)) {
		const priority = rec?.priority === 'high' || rec?.priority === 'medium' ? rec.priority : 'low';
		const priorityColor = priority === 'high' ? '#ef4444' : priority === 'medium' ? '#f59e0b' : '#60a5fa';
		const row = el('div');
		row.setAttribute('style', 'padding: 8px; border-bottom: 1px solid var(--border-subtle); display: flex; gap: 8px;');
		const priorityLabel = el('span');
		priorityLabel.setAttribute('style', `font-size: 10px; font-weight: 600; color: ${priorityColor}; min-width: 50px;`);
		priorityLabel.textContent = String(priority).toUpperCase();
		const content = el('div');
		content.setAttribute('style', 'flex: 1;');
		const action = el('div');
		action.setAttribute('style', 'font-size: 11px; color: var(--text-primary);');
		action.textContent = typeof rec?.action === 'string' ? rec.action : '';
		const impact = el('div');
		impact.setAttribute('style', 'font-size: 10px; color: var(--text-muted); margin-top: 2px;');
		impact.textContent = typeof rec?.impact === 'string' ? rec.impact : '';
		content.append(action, impact);
		const weight = el('span');
		weight.setAttribute('style', 'font-size: 10px; color: var(--text-muted); min-width: 30px; text-align: right;');
		weight.textContent = `+${toFiniteNumber(rec?.weight)}`;
		row.append(priorityLabel, content, weight);
		section.appendChild(row);
	}
	return section;
}

function buildCopilotSectionElement(failedChecks: RepoHygieneCheck[], workspacePath?: string): HTMLElement {
	const copilotSection = el('div');
	copilotSection.setAttribute('style', 'margin-top: 16px; padding: 12px; background: rgba(96, 165, 250, 0.07); border: 1px solid rgba(96, 165, 250, 0.3); border-radius: 4px; display: flex; align-items: center; justify-content: space-between; gap: 12px;');
	const copilotText = el('div');
	copilotText.setAttribute('style', 'font-size: 11px; color: var(--text-secondary); flex: 1;');
	copilotText.textContent = 'Let Copilot help you fix the identified issues in this repository.';
	const copilotBtn = document.createElement('vscode-button');
	copilotBtn.setAttribute('style', 'min-width: 180px;');
	copilotBtn.textContent = '🤖 Ask Copilot to Improve';
	copilotBtn.addEventListener('click', () => {
		const failedLines = failedChecks.map((c: RepoHygieneCheck) => `- ${c.label}: ${c.detail || ''}${c.hint ? ` (${c.hint})` : ''}`).join('\n');
		const prompt = `Please help me improve this repository by addressing the following best practice issues:\n\n${failedLines}\n\nFor each issue, please provide specific steps or code changes to fix it.`;
		const isRepoOpen = !workspacePath || currentWorkspacePaths.some(p => p.toLowerCase() === workspacePath.toLowerCase());
		if (isRepoOpen) {
			vscode.postMessage({ command: 'openCopilotChatWithPrompt', prompt });
		} else {
			const repoFolderName = workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? workspacePath;
			copilotSection.replaceChildren();
			copilotSection.setAttribute('style', 'margin-top: 16px; padding: 12px; background: rgba(251, 191, 36, 0.07); border: 1px solid rgba(251, 191, 36, 0.4); border-radius: 4px; display: flex; flex-direction: column; gap: 8px;');
			const instructions = el('div');
			instructions.setAttribute('style', 'font-size: 11px; color: var(--warning-fg);');
			instructions.textContent = `⚠️ Open "${repoFolderName}" in VS Code first, then paste this prompt into Copilot Chat:`;
			const promptBox = el('pre');
			promptBox.setAttribute('style', 'font-size: 10px; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto; font-family: monospace; margin: 0;');
			promptBox.textContent = prompt;
			const copyBtn = document.createElement('vscode-button');
			copyBtn.setAttribute('appearance', 'secondary');
			copyBtn.textContent = '📋 Copy prompt';
			copyBtn.addEventListener('click', () => {
				navigator.clipboard.writeText(prompt).then(() => {
					copyBtn.textContent = '✅ Copied!';
					setTimeout(() => { copyBtn.textContent = '📋 Copy prompt'; }, 2000);
				});
			});
			copilotSection.append(instructions, promptBox, copyBtn);
		}
	});
	copilotSection.append(copilotText, copilotBtn);
	return copilotSection;
}

function buildRepoAnalysisBodyElement(data: RepoAnalysisData, workspacePath?: string): HTMLElement {
	const summary = data?.summary || {};
	const checks = Array.isArray(data?.checks) ? data.checks : [];
	const recommendations = Array.isArray(data?.recommendations) ? [...data.recommendations] : [];

	const container = el('div');
	container.appendChild(buildScoreHeaderElement(summary));
	container.appendChild(buildStatsGridElement(summary));

	const scoreSummary = el('div');
	scoreSummary.setAttribute('style', 'font-size: 11px; color: var(--text-muted); text-align: center; margin-bottom: 16px;');
	scoreSummary.textContent = `Score: ${toFiniteNumber(summary.totalScore)} / ${toFiniteNumber(summary.maxScore)} points`;
	container.appendChild(scoreSummary);

	const priorityOrder: { [key: string]: number } = { high: 1, medium: 2, low: 3 };
	recommendations.sort((a: RepoHygieneRecommendation, b: RepoHygieneRecommendation) => (priorityOrder[a?.priority as string] || 99) - (priorityOrder[b?.priority as string] || 99));

	const categories: Record<string, RepoHygieneCheck[]> = {};
	for (const check of checks) {
		const categoryId = typeof check?.category === 'string' && check.category.length > 0 ? check.category : 'other';
		if (!categories[categoryId]) { categories[categoryId] = []; }
		categories[categoryId].push(check);
	}
	for (const [categoryId, categoryChecks] of Object.entries(categories)) {
		container.appendChild(buildCategorySectionElement(categoryId, categoryChecks, summary));
	}

	if (recommendations.length > 0) {
		container.appendChild(buildRecommendationsSectionElement(recommendations));
	}

	const failedChecks = checks.filter((c: RepoHygieneCheck) => c?.status === 'fail' || c?.status === 'warning');
	if (failedChecks.length > 0) {
		container.appendChild(buildCopilotSectionElement(failedChecks, workspacePath));
	}

	return container;
}

/**
 * Splits workspaces into a "major" group and a long-tail "other" group based on session count,
 * so a handful of heavily-used workspaces aren't buried in a long list of one/two-session workspaces.
 * The split point is found dynamically: the biggest proportional drop in session count between
 * consecutive workspaces (sorted descending), as long as the drop is at least 2x and leaves a
 * tail of 3+ workspaces (otherwise there's no meaningful "long tail" to group).
 */
function computeWorkspaceHealthGrouping(workspaces: WorkspaceCustomizationRow[]): { visible: WorkspaceCustomizationRow[]; otherWorkspaces: WorkspaceCustomizationRow[] } {
	if (workspaces.length <= 6) {
		return { visible: workspaces, otherWorkspaces: [] };
	}
	const sorted = [...workspaces].sort((a, b) => (Number(b.sessionCount) || 0) - (Number(a.sessionCount) || 0));
	let splitIdx = -1;
	let bestRatio = 1;
	// Only consider split points that would leave a tail of 3+ workspaces — a later, larger
	// ratio near the very end of the list isn't a valid candidate since it wouldn't group anything.
	for (let i = 1; i <= sorted.length - 3; i++) {
		const prev = Number(sorted[i - 1].sessionCount) || 0;
		const curr = Number(sorted[i].sessionCount) || 0;
		if (prev <= 0) { continue; }
		const ratio = prev / Math.max(curr, 1);
		if (ratio > bestRatio) {
			bestRatio = ratio;
			splitIdx = i;
		}
	}
	if (splitIdx < 1 || bestRatio < 2) {
		return { visible: sorted, otherWorkspaces: [] };
	}
	return { visible: sorted.slice(0, splitIdx), otherWorkspaces: sorted.slice(splitIdx) };
}

function renderRepoListPane(listPane: HTMLElement, visibleWorkspaces: WorkspaceCustomizationRow[], hasSelectedRepository: boolean, otherWorkspaces: WorkspaceCustomizationRow[] = [], canCollapse: boolean = false): void {
	const rows: RepoHygieneListRow[] = visibleWorkspaces.map(ws => {
		const record = repoAnalysisState.get(ws.workspacePath);
		const inFlight = repoAnalysisInFlight.has(ws.workspacePath);
		const hasResult = !!record?.data?.summary;
		return {
			workspaceName: ws.workspaceName,
			workspacePath: ws.workspacePath,
			sessions: Number(ws.sessionCount) || 0,
			interactions: Number(ws.interactionCount) || 0,
			scoreLabel: getScoreLabel(ws.workspacePath),
			action: hasResult && !inFlight ? 'details' : 'analyze',
			actionLabel: inFlight ? 'Analyzing…' : hasResult ? 'Details' : 'Analyze',
			actionDisabled: inFlight || (selectedRepoPath === ws.workspacePath && hasSelectedRepository),
			actionSecondary: inFlight,
		};
	});
	const other = otherWorkspaces.length > 0
		? {
			count: otherWorkspaces.length,
			sessions: otherWorkspaces.reduce((sum, ws) => sum + (Number(ws.sessionCount) || 0), 0),
			interactions: otherWorkspaces.reduce((sum, ws) => sum + (Number(ws.interactionCount) || 0), 0),
		}
		: undefined;
	setHtml(listPane, renderRepoHygieneListTable({ rows, other, showCollapse: !other && showAllWorkspacesInHealth && !hasSelectedRepository && canCollapse }));
}

function renderRepoDetailSuccess(detailsPane: HTMLElement, record: any, workspaceName: string): void {
	detailsPane.replaceChildren();
	const card = el('div', 'repo-details-card');
	card.setAttribute('style', 'padding: 12px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px;');
	const header = el('div', 'repo-details-card-header');
	header.setAttribute('style', 'display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px;');
	const label = el('div');
	label.setAttribute('style', 'font-size: 12px; color: var(--text-secondary);');
	label.textContent = 'Repository: ';
	const repoName = el('span');
	repoName.setAttribute('style', "color: var(--text-primary); font-weight: 600; font-family: 'Courier New', monospace;");
	repoName.textContent = workspaceName;
	label.appendChild(repoName);
	const switchButton = document.createElement('vscode-button');
	switchButton.id = 'btn-switch-repository';
	switchButton.setAttribute('style', 'min-width: 120px;');
	switchButton.textContent = 'Switch Repository';
	header.append(label, switchButton);
	card.append(header, buildRepoAnalysisBodyElement(record.data, selectedRepoPath ?? undefined));
	detailsPane.appendChild(card);
}

function renderRepositoryHygienePanels(): void {
	const listPane = document.getElementById('repo-list-pane');
	const listContainer = document.getElementById('repo-list-pane-container');
	const detailsPane = document.getElementById('repo-details-pane');
	const detailsContainer = document.getElementById('repo-details-pane-container');
	if (!listPane || !listContainer || !detailsPane || !detailsContainer || !hygieneMatrixState) {
		return;
	}

	const hasSelectedRepository = !!selectedRepoPath && !isSwitchingRepository;
	const grouping = computeWorkspaceHealthGrouping(hygieneMatrixState.workspaces);
	const canCollapse = grouping.otherWorkspaces.length > 0;
	let visibleWorkspaces: WorkspaceCustomizationRow[];
	let otherWorkspaces: WorkspaceCustomizationRow[] = [];
	if (hasSelectedRepository) {
		visibleWorkspaces = hygieneMatrixState.workspaces.filter((ws) => ws.workspacePath === selectedRepoPath);
	} else if (showAllWorkspacesInHealth || !canCollapse) {
		visibleWorkspaces = grouping.visible.concat(grouping.otherWorkspaces);
	} else {
		visibleWorkspaces = grouping.visible;
		otherWorkspaces = grouping.otherWorkspaces;
	}

	listContainer.classList.remove('repo-hygiene-pane-collapsed');
	detailsContainer.classList.toggle('repo-hygiene-pane-collapsed', !hasSelectedRepository);
	renderRepoListPane(listPane, visibleWorkspaces, hasSelectedRepository, otherWorkspaces, canCollapse);

	if (!hasSelectedRepository || !selectedRepoPath) {
		detailsPane.replaceChildren();
		return;
	}

	const workspaceName = getWorkspaceName(selectedRepoPath);
	const record = repoAnalysisState.get(selectedRepoPath);
	if (record?.data) {
		renderRepoDetailSuccess(detailsPane, record, workspaceName);
		return;
	}

	if (record?.error) {
		setHtml(detailsPane, `
			<div style="padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px;">
				<div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;">
					<div style="font-size: 11px; color: #fca5a5;">Repository: ${escapeHtml(workspaceName)}</div>
					<vscode-button id="btn-switch-repository" style="min-width: 120px;">Switch Repository</vscode-button>
				</div>
				<div style="font-size: 12px; font-weight: 600; color: #ef4444; margin-bottom: 4px;">❌ Analysis Failed</div>
				<div style="font-size: 11px; color: #fca5a5;">${escapeHtml(record.error)}</div>
			</div>
		`);
		return;
	}

	setHtml(detailsPane, `
		<div style="padding: 12px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px;">
			<div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;">
				<div style="font-size: 12px; color: var(--text-secondary);">Repository: <span style="color: var(--text-primary); font-weight: 600; font-family: 'Courier New', monospace;">${escapeHtml(workspaceName)}</span></div>
				<vscode-button id="btn-switch-repository" style="min-width: 120px;">Switch Repository</vscode-button>
			</div>
			<div style="font-size: 11px; color: var(--text-muted);">No analysis data yet. Click Analyze in the list.</div>
		</div>
	`);
}

function displayRepoAnalysisResults(data: RepoAnalysisData, workspacePath?: string): void {
	if (workspacePath) {
		repoAnalysisInFlight.delete(workspacePath);
		repoAnalysisState.set(workspacePath, { data, error: undefined });
		if (!isBatchAnalysisInProgress) {
			selectedRepoPath = workspacePath;
			isSwitchingRepository = false;
		}
		renderRepositoryHygienePanels();
		return;
	}

	const btn = document.getElementById('btn-analyse-repo') as (HTMLElement & { disabled: boolean }) | null;
	if (btn) {
		isSingleRepoAnalysisInProgress = false;
		btn.disabled = false;
		btn.textContent = 'Analyze Repo for Best Practices';
		btn.removeAttribute('appearance');
	}

	const resultsHost = document.getElementById('repo-analysis-results');
	if (resultsHost) {
		resultsHost.replaceChildren();
		const card = el('div', 'repo-analysis-card');
		card.setAttribute('style', 'padding: 12px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; margin-bottom: 12px;');
		card.appendChild(buildRepoAnalysisBodyElement(data, workspacePath));
		resultsHost.appendChild(card);
	}
}

function displayRepoAnalysisError(error: string, workspacePath?: string): void {
	if (workspacePath) {
		repoAnalysisInFlight.delete(workspacePath);
		repoAnalysisState.set(workspacePath, { data: undefined, error });
		if (!isBatchAnalysisInProgress) {
			selectedRepoPath = workspacePath;
			isSwitchingRepository = false;
		}
		renderRepositoryHygienePanels();
		return;
	}

	const btn = document.getElementById('btn-analyse-repo') as (HTMLElement & { disabled: boolean }) | null;
	if (btn) {
		isSingleRepoAnalysisInProgress = false;
		btn.disabled = false;
		btn.textContent = 'Analyze Repo for Best Practices';
		btn.removeAttribute('appearance');
	}

	const resultsHost = document.getElementById('repo-analysis-results');
	if (resultsHost) {
		setHtml(resultsHost, `
			<div style="padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px; margin-bottom: 12px;">
				<div style="font-size: 12px; font-weight: 600; color: #ef4444; margin-bottom: 4px;">❌ Analysis Failed</div>
				<div style="font-size: 11px; color: #fca5a5;">${escapeHtml(error)}</div>
			</div>
		`);
	}
}

function handleBatchAnalysisComplete(): void {
	isBatchAnalysisInProgress = false;
	isSwitchingRepository = true;
	selectedRepoPath = null;
	repoAnalysisInFlight.clear();
	renderRepositoryHygienePanels();

	// Re-enable the "Analyze All" button
	const btn = document.getElementById('btn-analyse-all') as (HTMLElement & { disabled: boolean }) | null;
	if (btn) {
		btn.disabled = false;
		btn.removeAttribute('appearance');
		const matrix = initialData?.customizationMatrix as WorkspaceCustomizationMatrix | undefined;
		const count = matrix?.workspaces?.length || 0;
		btn.textContent = `Analyze All Repositories (${count})`;
	}
}

async function bootstrap(): Promise<void> {
	await import('@vscode-elements/elements/dist/vscode-button/index.js');

	// TOOL_NAME_MAP is imported at build-time from src/toolNames.json

	if (!initialData) {
		renderUsageLoadingState('Loading usage analysis...');
		// If data doesn't arrive within 30s, show a helpful hint (non-fatal)
		loadingTimeoutId = setTimeout(() => {
			const r = document.getElementById('root');
			if (r && r.querySelector('#usage-loading-card')) {
				const hint = document.createElement('div');
				hint.style.cssText = 'padding: 32px; text-align: center; font-size: 14px;';
				const msg = document.createElement('div');
				msg.style.cssText = 'color: var(--vscode-foreground); opacity: 0.7; margin-bottom: 12px;';
				msg.textContent = '⏳ Taking longer than expected… Session files may be large or the scan is still in progress.';
				hint.append(msg, createRefreshButton());
				r.textContent = '';
				r.append(hint);
			}
		}, 30_000);
		// Stats will arrive via the updateStats message; the module-level listener will call renderLayout then.
		return;
	}
	setFormatLocale(initialData.locale);
	use24HourTime = initialData.use24HourTime !== false;
	hideAutomaticToolCalls = initialData.hideAutomaticToolCalls !== false;
	replaceRecentSessionsCache(initialData.recentSessions);
	const savedColumns = initialData.sessionColumnSettings?.enabledColumns;
	if (Array.isArray(savedColumns)) {
		const valid = savedColumns.filter((c): c is SessionColumnId => (ALL_SESSION_COLUMN_IDS as string[]).includes(c));
		enabledSessionColumns = new Set(valid);
		reapplyPresetForcedColumns();
	}
	// The initial payload skips sanitizeStats, but the correction report can come from an older
	// cache that predates newer counts (e.g. escalatedUserCorrections) — normalize it the same way.
	if (Object.prototype.hasOwnProperty.call(initialData, 'correctionReport')) {
		initialData.correctionReport = sanitizeCorrectionReport(initialData.correctionReport);
	}
	renderLayout(initialData);
	setupSessionsTableHandlers();

	// Event delegation for suppress-tool buttons (rendered dynamically in the tools section)
	document.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		const toolName = target.getAttribute('data-suppress-tool');
		if (toolName) {
			// Optimistic UI: remove the item immediately so the user sees instant feedback,
			// rather than waiting for the async config.update round-trip in the extension host.
			handleToolSuppressed(toolName);
			vscode.postMessage({ command: 'suppressUnknownTool', toolName });
		}
	});
}

void bootstrap().catch(err => {
	console.error('[Usage Analysis] Bootstrap failed:', err);
	const root = document.getElementById('root');
	if (root) {
		const container = document.createElement('div');
		container.style.cssText = 'padding: 32px; text-align: center; font-size: 14px;';
		const msg = document.createElement('div');
		msg.style.cssText = 'color: var(--vscode-errorForeground, #f48771); margin-bottom: 16px;';
		msg.textContent = 'Failed to initialize usage analysis. Please try refreshing.';
		container.append(msg, createRefreshButton());
		root.textContent = '';
		root.append(container);
	}
});
