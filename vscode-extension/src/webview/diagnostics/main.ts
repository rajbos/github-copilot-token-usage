// Diagnostics Report webview with tabbed interface
import { navButtonsHtml } from "../shared/buttonConfig";
import { setHtml } from "../shared/domUtils";
import { renderDataTable, setDataTableState, type DataTableColumn, type DataTableSortValue } from "../shared/dataTable";
import { wireExtensionPointButtons } from "../shared/extensionPoints";
import { escapeHtml, formatFileSize, getTimeSince, getEditorIcon } from "../shared/formatUtils";
import { createPeriodSelector, PERIOD_LABELS, type Period } from "../shared/periodSelector";
import { createViewStateManager } from "../shared/viewState";
// CSS imported as text via esbuild
import themeStyles from "../shared/theme.css";
import dataTableStyles from "../shared/dataTable.css";
import styles from "./styles.css";
import { getWindowData } from "../../../../src/webview/shared/dataLoader";
import { registerMessageHandler } from "../shared/messageHandler";
import { getModelColor } from "../../../../src/chartDataBuilder";
import { getModelDisplayName } from "../../../../src/webview/shared/modelUtils";
import { localize, localizeFormat } from "../shared/localization";
import type { AccountBudgetView } from "../usage/billingStatsSanitizer";
import { shouldListAccountBudgets } from "../../githubAccountBudgets";
import { applyWebviewLocale } from "../shared/webviewLocale";
import { installSurfaceNavigation } from "../shared/surfaceNavigation";

// Constants
const LOADING_PLACEHOLDER = "Loading...";
const SESSION_FILES_SECTION_REGEX =
  /Session File Locations \(first 20\):[\s\S]*?(?=\n\s*\n|={70})/;
/**
 * Live-updating loading state for the Report tab, shown while `data.report` is still the
 * LOADING_PLACEHOLDER. `#report-loading-subtext` is updated in place by
 * handleSessionFilesLoadProgress() as the background scan streams processed/total counts —
 * unlike the old plain-text LOADING_MESSAGE, this always reflects real progress instead of
 * sitting static until the whole report is ready. handleDiagnosticReport() wipes this out
 * (via .textContent =) the moment the real report arrives, so there's nothing to clean up.
 */
const LOADING_MESSAGE = `<div class="analyzer-loading" style="flex-direction:column;align-items:flex-start;gap:6px;">
<div style="display:flex;align-items:center;gap:10px;">
<span class="spinner" style="width:18px;height:18px;border:2px solid var(--link-color);border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin 0.7s linear infinite;"></span>
<span>⏳ Loading diagnostic data…</span>
</div>
<div id="report-loading-subtext" style="font-size:12px;color:var(--text-muted);">Scanning session files…</div>
</div>`;

import {
  ContextReferenceUsage,
  getContextRefsSummary,
  getTotalContextRefs,
} from "../shared/contextRefUtils";

type SessionFileDetails = {
  file: string;
  size: number;
  modified: string;
  interactions: number;
  tokens?: number;
  contextReferences: ContextReferenceUsage;
  firstInteraction: string | null;
  lastInteraction: string | null;
  editorSource: string;
  editorRoot?: string;
  editorName?: string;
  title?: string;
  repository?: string;
  parentInfo?: { uuid: string; name: string; sessionFile?: string } | null;
  childInfo?: Array<{ uuid: string; name: string; sessionFile?: string }>;
  totalChildCount?: number;
  /** Sub-agent/delegation tool calls detected in this session (from cache). Absent when zero/unknown. */
  subAgentCalls?: number;
  /** Per-model input/output token breakdown (when model attribution data is available). */
  modelUsage?: { [model: string]: { inputTokens: number; outputTokens: number } };
};

type ModelUsageRow = {
  model: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation1hTokens: number;
  estimatedCost: number;
};

type CacheInfo = {
  size: number;
  sizeInMB: number;
  lastUpdated: string | null;
  location: string;
  storagePath?: string | null;
};

type AzureStorageInfo = {
  enabled: boolean;
  isConfigured: boolean;
  storageAccount: string;
  subscriptionId: string;
  resourceGroup: string;
  aggTable: string;
  eventsTable: string;
  authMode: string;
  sharingProfile: string;
  lastSyncTime: string | null;
  deviceCount: number;
  sessionCount: number;
  recordCount: number | null;
};

type TeamServerInfo = {
  enabled: boolean;
  isConfigured: boolean;
  endpointUrl: string;
  sharingProfile: string;
  /** Last successful usage-rollup upload. Tracked separately from the fluency score below. */
  lastSyncTime: string | null;
  /** Last successful fluency-score upload, which runs and fails independently of the rollup sync. */
  fluencyLastSyncTime: string | null;
  sessionCount: number;
};

type BackendStorageInfo = {
  azure: AzureStorageInfo;
  teamServer: TeamServerInfo;
};

type GlobalStateCounters = {
  openCount: number;
  unknownMcpOpenCount: number;
  fluencyBannerDismissed: boolean;
  unknownMcpDismissedVersion: string;
  efficiencyTabBannerDismissed: boolean;
};

type GitHubAuthStatus = {
  authenticated: boolean;
  username?: string;
};

type SessionFolder = {
  dir: string;
  count: number;
  editorName?: string;
};

type StatusBarShowOption = 'none' | 'today' | 'last30days' | 'currentMonth' | 'both' | 'todayAndCurrentMonth';

type DisplaySettings = {
  showTokens: StatusBarShowOption;
  showCost: StatusBarShowOption;
  monthlyBudget?: number;
};

type QuotaEntitlements = {
  premium_interactions?: number;
  completions?: number;
};

type CopilotCliOtelComparisonSession = {
  file: string;
  sessionId: string;
  baselineTokens: number;
  otelTokens: number;
  delta: number;
  models: string[];
  lastActivity: string | null;
};

type CopilotCliOtelComparison = {
  otelDirExists: boolean;
  otelFileCount: number;
  otelSessionsIndexed: number;
  sessionsChecked: number;
  sessionsMatched: number;
  totalBaselineTokens: number;
  totalOtelTokens: number;
  deltaTokens: number;
  sessions: CopilotCliOtelComparisonSession[];
};

type DiagnosticsData = {
  report: string;
  sessionFiles: { file: string; size: number; modified: string }[];
  detailedSessionFiles?: SessionFileDetails[];
  cacheInfo?: CacheInfo;
  backendStorageInfo?: BackendStorageInfo;
  backendConfigured?: boolean;
  isDebugMode?: boolean;
  globalStateCounters?: GlobalStateCounters;
  githubAuth?: GitHubAuthStatus;
  sessionFolders?: SessionFolder[];
  displaySettings?: DisplaySettings;
  quotaEntitlements?: QuotaEntitlements;
  /** Copilot budget per GitHub account signed in to VS Code. */
  accountBudgets?: AccountBudgetView[];
  toolCallStats?: { total: number; byTool: { [key: string]: number }; outputTokensByTool?: { [key: string]: number } } | null;
  skillCallStats?: { total: number; byName: { [key: string]: number } } | null;
  /** Per-skill, per-editor invocation counts (skillName -> editorSource -> count), for the Skill Usage tab's editor filter. */
  skillCallsByEditor?: { [skillName: string]: { [editorSource: string]: number } } | null;
  /** Skill name -> description, sourced from discovered SKILL.md frontmatter. */
  skillDescriptions?: { [skillName: string]: string };
  toolFamilies?: ToolFamilyConfig[];
  otelComparison?: CopilotCliOtelComparison | null;
};

type ToolFamilyConfig = {
  id: string;
  name: string;
  builtIn: string[];
  alternatives: string[];
  description?: string;
};

type OtelDeltaPeriod = "all" | "today" | "yesterday" | "week" | "month";
type TtftGranularity = "day" | "week" | "month";
type TtftScanRange = "14d" | "30d" | "90d" | "180d" | "365d" | "all";

type DiagnosticsViewState = {
  activeTab?: string;
  activeSubtab?: string;
  otelDeltaPeriod?: OtelDeltaPeriod;
  shareCardPeriod?: Period;
  skillUsageEditorFilter?: string;
  ttftGranularity?: TtftGranularity;
  ttftScanRange?: TtftScanRange;
};

type FolderFileResult = {
  file: string;
  size: number;
  modified: string;
  interactions: number;
  tokens: number;
  actualTokens: number;
};

declare function acquireVsCodeApi<TState = DiagnosticsViewState>(): {
  postMessage: (message: unknown) => void;
  setState: (newState: TState) => void;
  getState: () => TState | undefined;
};

const vscode = acquireVsCodeApi<DiagnosticsViewState>();
installSurfaceNavigation(vscode, 'diagnostics');
const initialData = getWindowData<DiagnosticsData & { localization?: Record<string, string> }>('__INITIAL_DIAGNOSTICS__');

// Initialize localization for webview
applyWebviewLocale(initialData);

const diagState = createViewStateManager<DiagnosticsViewState>(vscode, {
  activeTab: undefined,
  activeSubtab: undefined,
  otelDeltaPeriod: "all",
  shareCardPeriod: "last14",
  skillUsageEditorFilter: "all",
  ttftGranularity: "day",
  ttftScanRange: "14d",
});

let currentOtelComparison: CopilotCliOtelComparison | null | undefined;
let currentOtelDeltaPeriod: OtelDeltaPeriod = diagState.restore().otelDeltaPeriod ?? "all";
let currentTtftGranularity: TtftGranularity = diagState.restore().ttftGranularity ?? "day";
let currentTtftScanRange: TtftScanRange = diagState.restore().ttftScanRange ?? "14d";

// Periods offered by the Share Card's period selector, in display order.
const SHARE_CARD_PERIOD_ORDER: Period[] = ["last7", "last14", "last30", "last90", "allTime"];
let currentShareCardPeriod: Period = diagState.restore().shareCardPeriod ?? "last14";

// Session table filtering state (sorting and paging live in the shared data table)
let currentEditorFilter: string | null = null; // null = show all
let currentContextRefFilter: keyof ContextReferenceUsage | null = null; // null = show all
let hideEmptySessions = true; // hide sessions with 0 interactions by default
let showOnlyUnattributed = false; // filter to only sessions with unattributed tokens

let storedToolFamilies: ToolFamilyConfig[] | undefined;

// Skill usage tab state
let currentSkillCallStats: DiagnosticsData['skillCallStats'];
let currentSkillCallsByEditor: DiagnosticsData['skillCallsByEditor'];
let currentSkillDescriptions: DiagnosticsData['skillDescriptions'];
let skillUsageEditorFilter: string = diagState.restore().skillUsageEditorFilter ?? "all";

// Render state (promoted to module level so all setup functions can be top-level)
let storedDetailedFiles: SessionFileDetails[] = [];
let isLoading = true;
let currentBackendInfo: BackendStorageInfo | undefined;
let currentGithubAuth: GitHubAuthStatus | undefined;
// A `switchTab` request (e.g. the What's New "Take me there" action) that arrived before
// renderLayout() built the tab bar — the message listener is registered before renderLayout()
// runs (see resolveEarlyBackendState's comment for the same race with backendStorageInfoLoaded),
// so activateTab() below can silently no-op on first arrival. Applied once renderLayout() runs.
let pendingSwitchTabTo: string | undefined;
let currentModelUsageTimeRange = "all";

function removeSessionFilesSection(reportText: string): string {
  return reportText.replace(SESSION_FILES_SECTION_REGEX, "");
}

function formatDate(isoString: string | null): string {
  if (!isoString) {
    return "N/A";
  }
  try {
    return escapeHtml(new Date(isoString).toLocaleString());
  } catch {
    return escapeHtml(isoString);
  }
}

function sanitizeNumber(value: number | undefined | null): string {
  if (value === undefined || value === null) {
    return "0";
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "0";
  }
  return Math.floor(n).toString();
}

function formatTokenCount(value: number | undefined | null): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) { return "0"; }
  if (n >= 1_000_000_000) { return `${(n / 1_000_000_000).toFixed(1)}B`; }
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return Math.floor(n).toString();
}

/**
 * Build a DOM element showing all candidate paths the extension considers,
 * with their existence status. Helps users understand why data may be missing.
 */
type CandidatePath = { path: string; exists: boolean; source: string };

type CandidatePathRow = { source: string; exists: boolean; paths: CandidatePath[] };

const CANDIDATE_PATHS_TABLE_ID = "diagnostics-candidate-paths";

/** Existing paths first, then by source; every Crush location collapses into one trailing row. */
function buildCandidatePathRows(candidatePaths: CandidatePath[]): CandidatePathRow[] {
  const sorted = [...candidatePaths].sort((a, b) => a.exists !== b.exists ? (a.exists ? -1 : 1) : a.source.localeCompare(b.source));
  const crushEntries = sorted.filter((cp) => cp.source.toLowerCase().includes("crush"));
  const rows: CandidatePathRow[] = sorted
    .filter((cp) => !cp.source.toLowerCase().includes("crush"))
    .map((cp) => ({ source: cp.source, exists: cp.exists, paths: [cp] }));
  if (crushEntries.length > 0) {
    rows.push({ source: "Crush", exists: crushEntries.some((cp) => cp.exists), paths: crushEntries });
  }
  return rows;
}

function renderCandidatePathCell(row: CandidatePathRow): string {
  if (row.paths.length === 1) {
    const cp = row.paths[0];
    return `<span title="${escapeHtml(cp.path)}">${escapeHtml(cp.path)}</span>`;
  }
  return row.paths
    .map((cp) => `<div class="candidate-path-line${cp.exists ? "" : " candidate-path-missing"}" title="${escapeHtml(cp.path)}">${cp.exists ? "✅" : "❌"} ${escapeHtml(cp.path)}</div>`)
    .join("");
}

function renderCandidatePathsTable(candidatePaths: CandidatePath[]): string {
  const columns: DataTableColumn<CandidatePathRow>[] = [
    { id: "status", label: "Status", align: "center", width: "60px", sortValue: (row) => row.exists ? 0 : 1, render: (row) => row.exists ? "✅" : "❌" },
    {
      id: "source",
      label: "Source",
      width: "140px",
      sortValue: (row) => row.source,
      render: (row) => ({ html: `<span class="${getEditorBadgeClass(row.source)}">${escapeHtml(`${getEditorIcon(row.source)} ${row.source}`)}</span>` }),
    },
    { id: "path", label: "Path", sortValue: (row) => row.paths[0]?.path, cellClassName: () => "diag-path-cell data-table-wrap-anywhere", render: (row) => ({ html: renderCandidatePathCell(row) }) },
  ];
  return renderDataTable({
    tableId: CANDIDATE_PATHS_TABLE_ID,
    ariaLabel: "Scanned Paths (all candidate locations):",
    rows: buildCandidatePathRows(candidatePaths),
    columns,
    className: "data-table--fixed",
    rowOptions: (row) => row.exists ? undefined : { className: "candidate-path-missing" },
  });
}

function buildCandidatePathsElement(
  candidatePaths: CandidatePath[],
): HTMLElement {
  const container = document.createElement("div");
  container.className = "candidate-paths-table";
  const heading = document.createElement("h4");
  heading.textContent = "Scanned Paths (all candidate locations):";
  container.appendChild(heading);
  const description = document.createElement("p");
  description.style.cssText = "color: #999; font-size: 12px; margin: 4px 0 8px 0;";
  description.textContent = "These are all the paths the extension checks for session files. Paths marked with ✅ exist on this system.";
  container.appendChild(description);
  const tableHost = document.createElement("div");
  setHtml(tableHost, renderCandidatePathsTable(candidatePaths));
  container.appendChild(tableHost);
  return container;
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1];
}

/**
 * Extract a friendly display name from a repository URL.
 * Supports HTTPS, SSH, and git:// URLs.
 * @param repoUrl The full repository URL
 * @returns A shortened display name like "owner/repo"
 */
function getRepoDisplayName(repoUrl: string): string {
  if (!repoUrl) {
    return "";
  }

  // Remove .git suffix if present
  let url = repoUrl.replace(/\.git$/, "");

  // Handle SSH URLs like git@github.com:owner/repo
  if (url.includes("@") && url.includes(":")) {
    const colonIndex = url.lastIndexOf(":");
    const atIndex = url.lastIndexOf("@");
    if (colonIndex > atIndex) {
      return url.substring(colonIndex + 1);
    }
  }

  // Handle HTTPS/git URLs - extract path after the host
  try {
    // Handle URLs with explicit protocol
    if (url.includes("://")) {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/").filter((p) => p);
      if (pathParts.length >= 2) {
        return `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
      }
      return urlObj.pathname.replace(/^\//, "");
    }
  } catch {
    // URL parsing failed, return as-is
  }

  // Fallback: return the last part of the path
  const parts = url.split("/").filter((p) => p);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return url;
}

function getEditorBadgeClass(editor: string): string {
  const lower = editor.toLowerCase();
  // MS Scout must be checked before generic 'copilot' to avoid misclassification.
  if (lower.includes("ms scout") || lower.includes("microsoft scout")) {
    return "editor-badge editor-badge-ms-scout";
  }
  if (lower.includes("visual studio")) {
    return "editor-badge editor-badge-vs";
  }
  if (lower.includes("jetbrains")) {
    return "editor-badge editor-badge-jetbrains";
  }
  if (lower.includes("mistral")) {
    return "editor-badge editor-badge-mistral-vibe";
  }
  // Antigravity must be checked before gemini (both contain 'gemini' in their path)
  if (lower.includes("antigravity")) {
    return "editor-badge editor-badge-antigravity";
  }
  if (lower.includes("gemini")) {
    return "editor-badge editor-badge-gemini-cli";
  }
  if (lower.includes("crush")) {
    return "editor-badge editor-badge-crush";
  }
  if (lower.includes("cursor")) {
    return "editor-badge editor-badge-cursor";
  }
  // Exact match required: 'copilot' contains the substring 'pi' and would false-positive.
  if (lower === 'pi') {
    return "editor-badge editor-badge-pi";
  }
  return "editor-badge";
}


const SESSION_TABLE_ID = "diagnostics-sessions";

type SessionTableRows = {
  rows: SessionFileDetails[];
  /** Child session -> the parent row it is listed under; children sort with their parent. */
  anchors: Map<SessionFileDetails, SessionFileDetails>;
};

function lastInteractionTime(sf: SessionFileDetails): number | null {
  if (!sf.lastInteraction) { return null; }
  const time = new Date(sf.lastInteraction).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Orders the sessions newest first and moves every child listed in a parent's `childInfo` to
 * directly after that parent. Each moved child is anchored to its parent, so the table sorts it by
 * the parent's value and the stable sort keeps the family together in any sort order.
 */
function groupChildrenAfterParents(files: SessionFileDetails[]): SessionTableRows {
  const newestFirst = [...files].sort((a, b) => {
    const aTime = lastInteractionTime(a);
    const bTime = lastInteractionTime(b);
    if (aTime === null || bTime === null) { return aTime === bTime ? 0 : aTime === null ? 1 : -1; }
    return bTime - aTime;
  });
  const byFile = new Map<string, SessionFileDetails>();
  for (const f of newestFirst) {
    if (!byFile.has(f.file)) { byFile.set(f.file, f); }
  }
  const placed = new Set<SessionFileDetails>();
  const rows: SessionFileDetails[] = [];
  const anchors = new Map<SessionFileDetails, SessionFileDetails>();
  for (const f of newestFirst) {
    if (placed.has(f)) { continue; }
    rows.push(f);
    placed.add(f);
    for (const childRef of f.childInfo ?? []) {
      if (!childRef.sessionFile) { continue; }
      const child = byFile.get(childRef.sessionFile);
      if (child && !placed.has(child)) {
        rows.push(child);
        placed.add(child);
        anchors.set(child, f);
      }
    }
  }
  return { rows, anchors };
}

function getEditorStats(files: SessionFileDetails[]): {
  [key: string]: { count: number; interactions: number };
} {
  // Use a Map keyed by (attacker-influenceable) editor name instead of a plain
  // object, so a crafted session file with an editor name like "__proto__"
  // can't pollute Object.prototype.
  const stats = new Map<string, { count: number; interactions: number }>();
  for (const sf of files) {
    const editor = sf.editorName || sf.editorSource || "Unknown";
    if (!stats.has(editor)) {
      stats.set(editor, { count: 0, interactions: 0 });
    }
    const entry = stats.get(editor)!;
    entry.count++;
    entry.interactions += sf.interactions;
  }
  return Object.fromEntries(stats);
}

function safeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  // Always convert to string and escape HTML to avoid XSS when inserting into innerHTML.
  return escapeHtml(String(value));
}

type ContextRefCounts = { file: number; symbol: number; selection: number; implicitSelection: number; codebase: number; workspace: number; terminal: number; vscode: number; copilotInstructions: number; agentsMd: number };
type FilteredSessionResult = { filteredFiles: SessionFileDetails[]; zeroInteractionCount: number };

/** Returns the number of tokens not attributed to any model (i.e. missing from modelUsage). */
function getUnattributedTokens(sf: SessionFileDetails): number {
  const tokens = sf.tokens || 0;
  if (tokens === 0 || !sf.modelUsage) { return 0; }
  const attributed = Object.values(sf.modelUsage).reduce((s, m) => s + m.inputTokens + m.outputTokens, 0);
  return attributed > 0 ? Math.max(0, tokens - attributed) : 0;
}

function applySessionFilters(detailedFiles: SessionFileDetails[]): FilteredSessionResult {
  let filteredFiles = currentEditorFilter ? detailedFiles.filter((sf) => (sf.editorName || sf.editorSource) === currentEditorFilter) : detailedFiles;
  if (currentContextRefFilter) {
    filteredFiles = filteredFiles.filter((sf) => { const value = sf.contextReferences[currentContextRefFilter!]; return typeof value === "number" && value > 0; });
  }
  if (showOnlyUnattributed) { filteredFiles = filteredFiles.filter(sf => getUnattributedTokens(sf) > 1000); }
  const zeroInteractionCount = filteredFiles.filter(sf => sf.interactions === 0).length;
  if (hideEmptySessions && zeroInteractionCount === filteredFiles.length && filteredFiles.length > 0) { hideEmptySessions = false; }
  if (hideEmptySessions) { filteredFiles = filteredFiles.filter(sf => sf.interactions > 0); }
  return { filteredFiles, zeroInteractionCount };
}

function aggregateContextRefs(filteredFiles: SessionFileDetails[]): ContextRefCounts {
  return filteredFiles.reduce((agg, sf) => {
    const r = sf.contextReferences;
    agg.file += r.file; agg.symbol += r.symbol; agg.selection += r.selection; agg.implicitSelection += r.implicitSelection;
    agg.codebase += r.codebase; agg.workspace += r.workspace; agg.terminal += r.terminal; agg.vscode += r.vscode;
    agg.copilotInstructions += r.copilotInstructions; agg.agentsMd += r.agentsMd;
    return agg;
  }, { file: 0, symbol: 0, selection: 0, implicitSelection: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0, copilotInstructions: 0, agentsMd: 0 });
}

function buildEditorPanelsHtml(detailedFiles: SessionFileDetails[], editorStats: Record<string, { count: number; interactions: number }>, editors: string[]): string {
  return `<div class="editor-filter-panels">
    <div class="editor-panel ${currentEditorFilter === null ? "active" : ""}" data-editor=""><div class="editor-panel-icon">🌐</div><div class="editor-panel-name">All Editors</div><div class="editor-panel-stats">${detailedFiles.length} sessions</div></div>
    ${editors.map((editor) => `<div class="editor-panel ${currentEditorFilter === editor ? "active" : ""}" data-editor="${escapeHtml(editor)}"><div class="editor-panel-icon">${getEditorIcon(editor)}</div><div class="editor-panel-name">${escapeHtml(editor)}</div><div class="editor-panel-stats">${editorStats[editor].count} sessions · ${editorStats[editor].interactions} interactions</div></div>`).join("")}
  </div>`;
}

function buildSessionSummaryCardsHtml(filteredFiles: SessionFileDetails[], allFiles: SessionFileDetails[], totalInteractions: number, totalTokens: number, totalContextRefs: number, agg: ContextRefCounts, zeroInteractionCount: number): string {
  const mkRef = (key: keyof ContextRefCounts, icon: string, label: string) => agg[key] > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === key ? "active" : ""}" data-ref-type="${key}">${icon} ${label} ${agg[key]}</div>` : "";
  const unattributedCount = allFiles.filter(sf => getUnattributedTokens(sf) > 1000).length;
  const unattributedCheckbox = unattributedCount > 0
    ? `<label class="empty-sessions-toggle" title="Sessions where some debug-log tokens cannot be assigned to a specific model — may indicate incomplete model attribution in the debug log"><input type="checkbox" id="show-only-unattributed" ${showOnlyUnattributed ? 'checked' : ''}>⚠️ Show only sessions with unattributed tokens<span class="hidden-count">(${unattributedCount} session${unattributedCount === 1 ? '' : 's'})</span></label>`
    : '';
  return `<div class="summary-cards">
    <div class="summary-card"><div class="summary-label">📁 ${currentEditorFilter ? "Filtered" : "Total"} Sessions</div><div class="summary-value">${filteredFiles.length}</div></div>
    <div class="summary-card"><div class="summary-label">💬 Interactions</div><div class="summary-value">${totalInteractions}</div></div>
    <div class="summary-card"><div class="summary-label">🪙 Tokens</div><div class="summary-value" title="${totalTokens.toLocaleString()} tokens">${formatTokenCount(totalTokens)}</div></div>
    <div class="summary-card"><div class="summary-label">🔗 Context References</div><div class="summary-value">${safeText(totalContextRefs)}</div><div class="summary-sub">${totalContextRefs === 0 ? "None" : ""}${mkRef("file","","#file")}${mkRef("symbol","","#sym")}${mkRef("implicitSelection","","implicit")}${mkRef("copilotInstructions","📋","instructions")}${mkRef("agentsMd","🤖","agents")}${mkRef("workspace","","@workspace")}${mkRef("vscode","","@vscode")}</div></div>
    <div class="summary-card"><div class="summary-label">📅 Time Range</div><div class="summary-value">Last 14 days</div></div>
  </div>
  <div class="filter-options"><label class="empty-sessions-toggle"><input type="checkbox" id="hide-empty-sessions" ${hideEmptySessions ? 'checked' : ''}>Hide sessions with 0 interactions${zeroInteractionCount > 0 ? `<span class="hidden-count">(${zeroInteractionCount} hidden)</span>` : ''}</label>${unattributedCheckbox}</div>`;
}

/** Badge for sessions with detected sub-agent tool calls. */
function buildSubAgentBadgeHtml(sf: SessionFileDetails): string {
  if (!sf.subAgentCalls || sf.subAgentCalls <= 0) { return ''; }
  const label = sf.subAgentCalls === 1 ? '1 sub-agent tool call' : `${sf.subAgentCalls} sub-agent tool calls`;
  return `<span class="session-hierarchy-badge" title="${label} detected in this session">🤖 ${sf.subAgentCalls} Sub-Agent${sf.subAgentCalls === 1 ? '' : 's'}</span>`;
}

function buildHierarchyBadgesHtml(sf: SessionFileDetails): string {
  let html = '';
  if (sf.parentInfo) {
    const parentTitle = escapeHtml(sf.parentInfo.name.length > 30 ? sf.parentInfo.name.substring(0, 30) + '…' : sf.parentInfo.name);
    const linkAttr = sf.parentInfo.sessionFile
      ? ` href="#" class="session-hierarchy-badge hierarchy-parent session-file-link" data-file="${encodeURIComponent(sf.parentInfo.sessionFile)}"`
      : ` class="session-hierarchy-badge hierarchy-parent"`;
    html += `<a${linkAttr} title="Parent session: ${escapeHtml(sf.parentInfo.name)}">↑ Parent: ${parentTitle}</a>`;
  }
  if (sf.totalChildCount && sf.totalChildCount > 0) {
    const count = sf.totalChildCount;
    const label = count === 1 ? '1 child session' : `${count} child sessions`;
    html += `<span class="session-hierarchy-badge hierarchy-children" title="${label}">↓ ${count} ${count === 1 ? 'Child' : 'Children'}</span>`;
  }
  html += buildSubAgentBadgeHtml(sf);
  return html ? `<div class="session-hierarchy-badges">${html}</div>` : '';
}

/** Returns a warning badge HTML string when the session has significant unattributed tokens. */
function buildUnattributedBadge(sf: SessionFileDetails): string {
  const unattributed = getUnattributedTokens(sf);
  if (unattributed <= 1000) { return ''; }
  const pct = Math.round(unattributed / (sf.tokens || 1) * 100);
  return ` <span title="⚠️ ${unattributed.toLocaleString()} tokens (~${pct}%) not attributed to any model — debug log events without a model field" style="color:#f59e0b; cursor:help; font-size:0.9em;">⚠️</span>`;
}

function renderSessionTitleCell(sf: SessionFileDetails): string {
  const rawTitleHtml = sf.title ? `<a href="#" class="session-file-link" data-file="${encodeURIComponent(sf.file)}" title="${escapeHtml(sf.title)}">${escapeHtml(sf.title.length > 40 ? sf.title.substring(0, 40) + "..." : sf.title)}</a>` : `<a href="#" class="session-file-link empty-session-link" data-file="${encodeURIComponent(sf.file)}" title="Empty session">(Empty session)</a>`;
  const titleHtml = sf.parentInfo ? `<span class="child-title-indent">${rawTitleHtml}</span>` : rawTitleHtml;
  return `${buildHierarchyBadgesHtml(sf)}${titleHtml}`;
}

function renderSessionRepositoryCell(sf: SessionFileDetails): string {
  const repoLabel = sf.repository ? escapeHtml(getRepoDisplayName(sf.repository)) : (sf.file.includes('session-store.db') ? '<span style="color: #888; font-style: italic;">No workspace</span>' : '<span style="color: #666;">—</span>');
  const repoTitle = sf.repository ? escapeHtml(sf.repository) : (sf.file.includes('session-store.db') ? 'Chat session — no workspace connected' : 'No repository detected');
  return `<span title="${repoTitle}">${repoLabel}</span>`;
}

function renderSessionActionsCell(sf: SessionFileDetails): string {
  const isUnknownEditor = (sf.editorName || sf.editorSource || "Unknown") === "Unknown";
  return `<a href="#" class="view-formatted-link" data-file="${encodeURIComponent(sf.file)}" title="View formatted JSONL file">📄 View</a>${isUnknownEditor ? ` <a href="#" class="report-editor-link" data-path="${encodeURIComponent(sf.file)}" title="Report this unknown path so we can add editor support">📢 Report</a>` : ""}`;
}

function buildSessionColumns(anchors: Map<SessionFileDetails, SessionFileDetails>): DataTableColumn<SessionFileDetails>[] {
  const byFamily = (value: (sf: SessionFileDetails) => DataTableSortValue) => (sf: SessionFileDetails) => value(anchors.get(sf) ?? sf);
  return [
    { id: "index", label: "#", width: "40px", render: (_sf, index) => String(index + 1) },
    {
      id: "editor",
      label: "Editor",
      sortValue: byFamily((sf) => sf.editorName || sf.editorSource),
      render: (sf) => {
        const editorLabel = sf.editorName || sf.editorSource;
        return { html: `<span class="${getEditorBadgeClass(editorLabel)}" title="${escapeHtml(sf.editorSource)}">${getEditorIcon(editorLabel)} ${escapeHtml(editorLabel)}</span>` };
      },
    },
    { id: "title", label: "Title", sortValue: byFamily((sf) => sf.title || null), cellClassName: () => "session-title", render: (sf) => ({ html: renderSessionTitleCell(sf) }) },
    {
      id: "repository",
      label: "Repository",
      sortValue: byFamily((sf) => sf.repository ? getRepoDisplayName(sf.repository) : null),
      cellClassName: () => "repository-cell",
      render: (sf) => ({ html: renderSessionRepositoryCell(sf) }),
    },
    { id: "size", label: "Size", align: "right", sortValue: byFamily((sf) => sf.size || 0), render: (sf) => formatFileSize(sf.size) },
    {
      id: "tokens",
      label: "Tokens",
      align: "right",
      sortValue: byFamily((sf) => sf.tokens || 0),
      render: (sf) => ({ html: `<span title="${Number(sf.tokens || 0).toLocaleString()} tokens">${formatTokenCount(sf.tokens)}</span>${buildUnattributedBadge(sf)}` }),
    },
    { id: "interactions", label: "Interactions", align: "right", sortValue: byFamily((sf) => sf.interactions || 0), render: (sf) => sanitizeNumber(sf.interactions) },
    {
      id: "contextRefs",
      label: "Context Refs",
      align: "right",
      sortValue: byFamily((sf) => getTotalContextRefs(sf.contextReferences)),
      render: (sf) => ({ html: `<span title="${escapeHtml(getContextRefsSummary(sf.contextReferences))}">${sanitizeNumber(getTotalContextRefs(sf.contextReferences))}</span>` }),
    },
    {
      id: "lastInteraction",
      label: "Last Interaction",
      firstSortDirection: "desc",
      sortValue: byFamily(lastInteractionTime),
      render: (sf) => ({ html: formatDate(sf.lastInteraction) }),
    },
    { id: "actions", label: "Actions", render: (sf) => ({ html: renderSessionActionsCell(sf) }) },
  ];
}

function buildSessionTableHtml(filteredFiles: SessionFileDetails[]): string {
  const { rows, anchors } = groupChildrenAfterParents(filteredFiles);
  return renderDataTable({
    tableId: SESSION_TABLE_ID,
    ariaLabel: "Session File Analysis",
    rows,
    columns: buildSessionColumns(anchors),
    initialSort: { columnId: "lastInteraction", direction: "desc" },
    rowOptions: (sf) => sf.parentInfo ? { className: "child-session-row" } : undefined,
  });
}

function renderSessionTable(
  detailedFiles: SessionFileDetails[],
  isLoading: boolean = false,
): string {
  if (isLoading) { return `<div class="loading-state"><div class="loading-spinner">⏳</div><div class="loading-text">Loading session files...</div><div class="loading-subtext" id="session-loading-subtext">Analyzing up to 500 files from the last 14 days</div></div>`; }
  if (detailedFiles.length === 0) { return '<p style="color: #999;">No session files with activity in the last 14 days.</p>'; }
  const editorStats = getEditorStats(detailedFiles);
  const editors = Object.keys(editorStats).sort();
  const { filteredFiles, zeroInteractionCount } = applySessionFilters(detailedFiles);
  const totalInteractions = filteredFiles.reduce((sum, sf) => sum + Number(sf.interactions || 0), 0);
  const totalTokens = filteredFiles.reduce((sum, sf) => sum + Number(sf.tokens || 0), 0);
  const totalContextRefs = filteredFiles.reduce((sum, sf) => sum + getTotalContextRefs(sf.contextReferences), 0);
  const agg = aggregateContextRefs(filteredFiles);
  return `${buildEditorPanelsHtml(detailedFiles, editorStats, editors)}${buildSessionSummaryCardsHtml(filteredFiles, detailedFiles, totalInteractions, totalTokens, totalContextRefs, agg, zeroInteractionCount)}${buildSessionTableHtml(filteredFiles)}`;
}

type DebugStateRow =
  | { kind: "counter"; key: string; label: string; value: number }
  | { kind: "flag"; key: string; label: string; value: boolean }
  | { kind: "string"; key: string; label: string; value: string };

function renderDebugStateValueCell(row: DebugStateRow): string {
  if (row.kind === "counter") {
    return `<input type="number" class="debug-counter-input" data-key="${escapeHtml(row.key)}" value="${row.value}" min="0" step="1"
          style="width:70px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 6px; font-family: var(--vscode-editor-font-family, monospace);" />`;
  }
  if (row.kind === "flag") {
    return `<input type="checkbox" class="debug-flag-input" data-key="${escapeHtml(row.key)}" ${row.value ? 'checked' : ''} />
        <span style="margin-left:6px; font-family: var(--vscode-editor-font-family, monospace);">${row.value ? '✅ true' : '❌ false'}</span>`;
  }
  const display = row.value ? `✅ ${escapeHtml(row.value)}` : '❌ (not set)';
  return `<span style="font-family: var(--vscode-editor-font-family, monospace);">${display}</span>`;
}

function renderDebugStateActionCell(row: DebugStateRow): string {
  if (row.kind === "string") { return ""; }
  const buttonClass = row.kind === "counter" ? "debug-counter-set" : "debug-flag-set";
  return `<button class="button secondary ${buttonClass}" data-key="${escapeHtml(row.key)}" style="padding: 2px 10px; font-size: 12px;">Set</button>`;
}

const DEBUG_STATE_COLUMNS: DataTableColumn<DebugStateRow>[] = [
  { id: "key", label: "", rowHeader: true, render: (row) => row.label },
  { id: "value", label: "", render: (row) => ({ html: renderDebugStateValueCell(row) }) },
  { id: "action", label: "", render: (row) => ({ html: renderDebugStateActionCell(row) }) },
];

function renderDebugStateTable(tableId: string, ariaLabel: string, rows: DebugStateRow[]): string {
  return renderDataTable({
    tableId,
    ariaLabel,
    rows,
    columns: DEBUG_STATE_COLUMNS,
    pageSize: false,
    showHeader: false,
    className: "data-table--key-value data-table--compact",
  });
}

/** Rolling lookback (in days) for each period the Share Card period selector offers. Periods absent from
 * this map (e.g. "allTime") are treated as "no filtering". */
const SHARE_CARD_PERIOD_DAYS: Partial<Record<Period, number>> = { last7: 7, last14: 14, last30: 30, last90: 90 };

/** Returns the sessions from `detailedFiles` whose last interaction falls within `period` (allTime = no filtering). */
function filterFilesByShareCardPeriod(detailedFiles: SessionFileDetails[], period: Period, now: Date = new Date()): SessionFileDetails[] {
  const days = SHARE_CARD_PERIOD_DAYS[period];
  if (days === undefined) { return detailedFiles; } // allTime (or any unmapped period): no filtering
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  return detailedFiles.filter((sf) => {
    if (!sf.lastInteraction) { return false; }
    const activity = new Date(sf.lastInteraction);
    return !Number.isNaN(activity.getTime()) && activity >= cutoff && activity <= now;
  });
}

/** Lowercase, human-readable phrase describing a Share Card period, for use mid-sentence. */
function shareCardPeriodPhrase(period: Period): string {
  return period === "allTime" ? "of all time" : `in the ${PERIOD_LABELS[period].toLowerCase()}`;
}

/** Builds the plain-text version of the share summary, used by the "Copy Summary Text" button. */
function buildShareSummaryText(
  editors: string[],
  editorStats: Record<string, { count: number; interactions: number }>,
  totalSessions: number,
  totalInteractions: number,
  totalTokens: number,
  period: Period,
): string {
  const editorList = editors
    .map((editor) => `${getEditorIcon(editor)} ${editor} (${editorStats[editor].count})`)
    .join(", ");
  return `My AI Coding Toolbox — ${editors.length} editor${editors.length === 1 ? "" : "s"} detected: ${editorList}. ` +
    `${totalSessions} sessions, ${totalInteractions} interactions, ${formatTokenCount(totalTokens)} tokens ${shareCardPeriodPhrase(period)}. #AIEngineeringFluency`;
}

/** Renders a screenshot-friendly "Share Card" tab summarizing the detected editors — meant to be
 * shared in social media posts, mirroring the visual style of the startup loading screen. */
function renderShareCardTab(detailedFiles: SessionFileDetails[], isLoadingSessions: boolean = false): string {
  if (isLoadingSessions) {
    return `<div id="tab-share" class="tab-content">
      <div class="info-box">
        <div class="info-box-title">📸 Share Card</div>
        <div>A snapshot of your AI coding toolbox — screenshot this card to share your editor mix on social media.</div>
      </div>
      <div class="loading-state"><div class="loading-spinner">⏳</div><div class="loading-text">Loading session files...</div><div class="loading-subtext" id="share-loading-subtext">Analyzing up to 500 files from the last 14 days</div></div>
    </div>`;
  }
  if (detailedFiles.length === 0) {
    return `<div id="tab-share" class="tab-content">
      <div class="info-box">
        <div class="info-box-title">📸 Share Card</div>
        <div>No session activity found yet. Once you have some AI coding sessions, a shareable summary card will appear here.</div>
      </div>
    </div>`;
  }
  const period = currentShareCardPeriod;
  const filteredFiles = filterFilesByShareCardPeriod(detailedFiles, period);
  const editorStats = getEditorStats(filteredFiles);
  const editors = Object.keys(editorStats).sort((a, b) => editorStats[b].count - editorStats[a].count);
  const totalSessions = filteredFiles.length;
  const totalInteractions = filteredFiles.reduce((sum, sf) => sum + Number(sf.interactions || 0), 0);
  const totalTokens = filteredFiles.reduce((sum, sf) => sum + Number(sf.tokens || 0), 0);
  const pills = editors
    .map((editor) => `<div class="share-pill"><span>${getEditorIcon(editor)}</span><span>${escapeHtml(editor)}</span><span class="share-pill-count">${editorStats[editor].count}</span></div>`)
    .join("");
  const emptyPeriodNotice = totalSessions === 0
    ? `<div style="margin-top: 8px; font-size: 12px; color: var(--text-muted);">No session activity in this period. Try a wider range.</div>`
    : "";
  return `<div id="tab-share" class="tab-content">
    <div class="info-box">
      <div class="info-box-title">📸 Share Card</div>
      <div>A snapshot of your AI coding toolbox — screenshot this card to share your editor mix on social media.</div>
    </div>
    <div class="share-card-controls" style="margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 12px; color: var(--text-muted);">Period:</span>
      <span id="share-card-period-selector"></span>
    </div>
    <div class="share-card">
      <div class="share-badge">🤖 AI Engineering Fluency</div>
      <div class="share-title">My AI Coding Toolbox</div>
      <div class="share-subtitle">${escapeHtml(PERIOD_LABELS[period])} · ${editors.length} editor${editors.length === 1 ? "" : "s"} detected</div>
      <div class="share-pills">${pills}</div>
      <div class="share-stats">
        <div class="share-stat"><div class="share-stat-value">${totalSessions}</div><div class="share-stat-label">Sessions</div></div>
        <div class="share-stat"><div class="share-stat-value">${totalInteractions}</div><div class="share-stat-label">Interactions</div></div>
        <div class="share-stat"><div class="share-stat-value" title="${totalTokens.toLocaleString()} tokens">${formatTokenCount(totalTokens)}</div><div class="share-stat-label">Tokens</div></div>
        <div class="share-stat"><div class="share-stat-value">${editors.length}</div><div class="share-stat-label">Editors</div></div>
      </div>
    </div>
    ${emptyPeriodNotice}
    <div class="button-group" style="margin-top: 12px;">
      <button class="button secondary" id="btn-copy-share-summary"><span>📋</span><span>Copy Summary Text</span></button>
    </div>
    <div class="share-buttons" style="margin-top: 12px;">
      <button id="btn-share-card-linkedin" class="share-btn share-btn-linkedin"><span class="share-btn-icon">💼</span><span>Share on LinkedIn</span></button>
      <button id="btn-share-card-bluesky" class="share-btn share-btn-bluesky"><span class="share-btn-icon">🦋</span><span>Share on Bluesky</span></button>
      <button id="btn-share-card-mastodon" class="share-btn share-btn-mastodon"><span class="share-btn-icon">🐘</span><span>Share on Mastodon</span></button>
    </div>
  </div>`;
}

function renderDebugTab(counters: GlobalStateCounters | undefined): string {
  const c = counters ?? { openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: '', efficiencyTabBannerDismissed: false };
  return `
    <div id="tab-debug" class="tab-content">
      <div class="info-box">
        <div class="info-box-title">🐛 Debug — Global State Counters</div>
        <div>Visible only when a debugger is attached. Edit counters and dismissed flags stored in VS Code global state, then click Set to apply. Changes take effect immediately.</div>
      </div>
      <div class="cache-details">
        <h4>Notification Counters</h4>
        ${renderDebugStateTable("diagnostics-debug-counters", "Notification Counters", [
          { kind: "counter", key: 'extension.openCount', label: 'extension.openCount (fluency banner threshold: 5)', value: c.openCount },
          { kind: "counter", key: 'extension.unknownMcpOpenCount', label: 'extension.unknownMcpOpenCount (unknown MCP threshold: 8)', value: c.unknownMcpOpenCount },
        ])}
        <h4 style="margin-top:16px;">Dismissed Flags</h4>
        ${renderDebugStateTable("diagnostics-debug-flags", "Dismissed Flags", [
          { kind: "flag", key: 'news.fluencyScoreBanner.v1.dismissed', label: 'news.fluencyScoreBanner.v1.dismissed', value: c.fluencyBannerDismissed },
          { kind: "string", key: 'news.unknownMcpTools.dismissedVersion', label: 'news.unknownMcpTools.dismissedVersion', value: c.unknownMcpDismissedVersion },
          { kind: "flag", key: 'news.efficiencyTab.v1.dismissed', label: 'news.efficiencyTab.v1.dismissed', value: c.efficiencyTabBannerDismissed },
        ])}
        <div style="margin-top: 16px;">
          <button class="button secondary" id="btn-reset-debug-counters"><span>🔄</span><span>Reset All Counters &amp; Dismissed Flags</span></button>
        </div>
      </div>
    </div>`;
}

function renderGitHubAuthPanel(githubAuth: GitHubAuthStatus | undefined): string {
  const authenticated = githubAuth?.authenticated || false;
  const username = githubAuth?.username || '';

  const statusColor = authenticated ? '#2d6a4f' : '#666';
  const statusIcon = authenticated ? '✅' : '⚪';
  const statusText = authenticated ? 'Authenticated' : 'Not Authenticated';

  return `
<div class="info-box">
  <div class="info-box-title">🔑 GitHub Authentication</div>
  <div>
    Authenticate with GitHub to unlock additional features in future releases.
  </div>
</div>

<div class="summary-cards">
  <div class="summary-card" style="border-left: 4px solid ${statusColor};">
    <div class="summary-label">${statusIcon} Status</div>
    <div class="summary-value" style="font-size: 16px; color: ${statusColor};">${statusText}</div>
  </div>
  ${authenticated ? `
  <div class="summary-card">
    <div class="summary-label">👤 Logged in as</div>
    <div class="summary-value" style="font-size: 16px;">${escapeHtml(username)}</div>
  </div>
  ` : ''}
</div>

${authenticated ? `
  <div style="margin-top: 24px;">
    <p style="color: #999; font-size: 12px; margin-bottom: 16px;">
      You are currently authenticated with GitHub. This enables future features such as:
    </p>
    <ul style="margin: 8px 0 16px 20px; color: #999; font-size: 12px;">
      <li>Repository-specific usage tracking</li>
      <li>Team collaboration features</li>
      <li>Advanced analytics and insights</li>
    </ul>
  </div>
` : `
  <div style="margin-top: 24px;">
    <p style="color: #999; font-size: 12px; margin-bottom: 16px;">
      Sign in with your GitHub account to unlock future features. This uses VS Code's built-in authentication.
    </p>
  </div>
`}

<div class="button-group">
  ${authenticated ? `
    <button class="button secondary" id="btn-sign-out-github">
      <span>🔌</span>
      <span>Disconnect GitHub</span>
    </button>
  ` : `
    <button class="button" id="btn-authenticate-github">
      <span>🔑</span>
      <span>Authenticate with GitHub</span>
    </button>
  `}
</div>
  `;
}

function getBackendStatus(isConfigured: boolean, enabled: boolean): { color: string; icon: string; text: string } {
  return isConfigured
    ? { color: "#2d6a4f", icon: "✅", text: "Configured & Enabled" }
    : enabled
      ? { color: "#d97706", icon: "⚠️", text: "Enabled but Not Configured" }
      : { color: "#666", icon: "⚪", text: "Disabled" };
}

type KeyValueRow = { label: string; value: string };

const KEY_VALUE_COLUMNS: DataTableColumn<KeyValueRow>[] = [
  { id: "key", label: "", rowHeader: true, render: (row) => row.label },
  { id: "value", label: "", render: (row) => String(row.value ?? "") },
];

function renderKeyValueTable(tableId: string, ariaLabel: string, rows: KeyValueRow[]): string {
  return renderDataTable({ tableId, ariaLabel, rows, columns: KEY_VALUE_COLUMNS, pageSize: false, showHeader: false, className: "data-table--key-value" });
}

function renderAzureDetailsSection(azureInfo: AzureStorageInfo): string {
  if (!azureInfo.isConfigured) {
    return `<div style="margin-top: 24px;"><h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">🚀 Get Started with Azure Storage</h4><p style="color: #999; font-size: 12px; margin-bottom: 16px;">To enable cloud synchronization, configure an Azure Storage account via the Backend configuration panel.</p><ul style="margin: 8px 0 16px 20px; color: #999; font-size: 12px;"><li>Azure subscription with Storage Account access</li><li>Appropriate permissions (Storage Table Data Contributor or Storage Account Key)</li><li>VS Code signed in with your Azure account (for Entra ID auth)</li></ul></div>`;
  }
  return `<div style="margin-top: 24px;"><h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📊 Configuration Details</h4>${renderKeyValueTable("diagnostics-azure-config", "Configuration Details", [{ label: "Storage Account", value: azureInfo.storageAccount }, { label: "Subscription ID", value: azureInfo.subscriptionId }, { label: "Resource Group", value: azureInfo.resourceGroup }, { label: "Aggregation Table", value: azureInfo.aggTable }, { label: "Events Table", value: azureInfo.eventsTable }])}</div><div style="margin-top: 24px;"><h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📈 Local Session Statistics</h4><div class="summary-cards"><div class="summary-card"><div class="summary-label">💻 Unique Devices</div><div class="summary-value">${escapeHtml(String(azureInfo.deviceCount))}</div><div style="font-size: 11px; color: #999; margin-top: 4px;">Based on workspace IDs</div></div><div class="summary-card"><div class="summary-label">📁 Total Sessions</div><div class="summary-value">${escapeHtml(String(azureInfo.sessionCount))}</div><div style="font-size: 11px; color: #999; margin-top: 4px;">Local session files</div></div><div class="summary-card"><div class="summary-label">☁️ Cloud Records</div><div class="summary-value">${azureInfo.recordCount !== null ? escapeHtml(String(azureInfo.recordCount)) : "—"}</div><div style="font-size: 11px; color: #999; margin-top: 4px;">Azure Storage records</div></div><div class="summary-card"><div class="summary-label">🔄 Sync Status</div><div class="summary-value" style="font-size: 14px;">${azureInfo.lastSyncTime ? formatDate(azureInfo.lastSyncTime) : "Never"}</div></div></div></div>`;
}

function renderAzureStoragePanel(azureInfo: AzureStorageInfo): string {
  const { color, icon, text } = getBackendStatus(azureInfo.isConfigured, azureInfo.enabled);
  return `<div class="info-box"><div class="info-box-title">☁️ Azure Storage Backend</div><div>Sync your token usage data to Azure Storage Tables for team-wide reporting and multi-device access.</div></div>
    <div class="summary-cards"><div class="summary-card" style="border-left: 4px solid ${color};"><div class="summary-label">${icon} Status</div><div class="summary-value" style="font-size: 16px; color: ${color};">${text}</div></div><div class="summary-card"><div class="summary-label">🔐 Auth Mode</div><div class="summary-value" style="font-size: 16px;">${azureInfo.authMode === "entraId" ? "Entra ID" : "Shared Key"}</div></div><div class="summary-card"><div class="summary-label">👥 Sharing Profile</div><div class="summary-value" style="font-size: 14px;">${escapeHtml(azureInfo.sharingProfile)}</div></div><div class="summary-card"><div class="summary-label">🕒 Last Sync</div><div class="summary-value" style="font-size: 14px;">${azureInfo.lastSyncTime ? getTimeSince(azureInfo.lastSyncTime) : "Never"}</div></div></div>
    ${renderAzureDetailsSection(azureInfo)}
    <div class="button-group"><button class="button" id="btn-configure-backend"><span>${azureInfo.isConfigured ? "⚙️" : "🔧"}</span><span>${azureInfo.isConfigured ? "Manage Backend" : "Configure Backend"}</span></button></div>`;
}

function renderTeamServerGithubAuthCard(githubAuth: GitHubAuthStatus | undefined, githubNotAuthenticated: boolean): string {
  const authColor = githubNotAuthenticated ? '#d97706' : githubAuth?.authenticated ? '#2d6a4f' : '#666';
  const authIcon = githubNotAuthenticated ? '⚠️' : githubAuth?.authenticated ? '✅' : '⚪';
  const authValue = githubNotAuthenticated ? 'Not Authenticated' : githubAuth?.authenticated ? escapeHtml(githubAuth.username || 'Authenticated') : 'Not Authenticated';
  return `<div class="summary-card" style="border-left: 4px solid ${authColor};"><div class="summary-label">${authIcon} GitHub Auth</div><div class="summary-value" style="font-size: 14px; color: ${authColor};">${authValue}</div></div>`;
}

function renderTeamServerDetailsSection(teamInfo: TeamServerInfo): string {
  if (!teamInfo.isConfigured) {
    return `<div style="margin-top: 24px;"><h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">🚀 Get Started with Team Server</h4><p style="color: #999; font-size: 12px; margin-bottom: 16px;">Deploy the sharing server and configure its URL in the Backend configuration panel.</p><ul style="margin: 8px 0 16px 20px; color: #999; font-size: 12px;"><li>Deploy the sharing server (see the <code>sharing-server/</code> folder in the repository)</li><li>Enter the server's base URL in the Backend configuration panel</li><li>Data syncs automatically every 5 minutes once configured</li></ul></div>`;
  }
  return `<div style="margin-top: 24px;"><h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📊 ${escapeHtml(localize('diagnostics.teamServer.configDetails'))}</h4>${renderKeyValueTable("diagnostics-team-server-config", localize('diagnostics.teamServer.configDetails'), [{ label: localize('diagnostics.teamServer.serverUrl'), value: teamInfo.endpointUrl }])}</div><div style="margin-top: 24px;"><h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📈 ${escapeHtml(localize('diagnostics.teamServer.localSessionStats'))}</h4><div class="summary-cards"><div class="summary-card"><div class="summary-label">📁 ${escapeHtml(localize('diagnostics.teamServer.totalSessions'))}</div><div class="summary-value">${escapeHtml(String(teamInfo.sessionCount))}</div><div style="font-size: 11px; color: #999; margin-top: 4px;">${escapeHtml(localize('diagnostics.teamServer.localSessionFiles'))}</div></div><div class="summary-card"><div class="summary-label">🔄 ${escapeHtml(localize('diagnostics.teamServer.usageData'))}</div><div class="summary-value" style="font-size: 14px;">${teamInfo.lastSyncTime ? formatDate(teamInfo.lastSyncTime) : escapeHtml(localize('diagnostics.teamServer.never'))}</div><div style="font-size: 11px; color: #999; margin-top: 4px;">${escapeHtml(localize('diagnostics.teamServer.lastRollupUpload'))}</div></div><div class="summary-card"><div class="summary-label">🎯 ${escapeHtml(localize('diagnostics.teamServer.fluencyScore'))}</div><div class="summary-value" style="font-size: 14px;">${teamInfo.fluencyLastSyncTime ? formatDate(teamInfo.fluencyLastSyncTime) : escapeHtml(localize('diagnostics.teamServer.never'))}</div><div style="font-size: 11px; color: #999; margin-top: 4px;">${escapeHtml(localize('diagnostics.teamServer.uploadedSeparately'))}</div></div></div></div>`;
}

function renderTeamServerPanel(teamInfo: TeamServerInfo, githubAuth?: GitHubAuthStatus): string {
  const { color, icon, text } = getBackendStatus(teamInfo.isConfigured, teamInfo.enabled);
  const githubNotAuthenticated = teamInfo.isConfigured && !githubAuth?.authenticated;
  const authWarning = githubNotAuthenticated ? `<button id="btn-team-server-auth-warning" style="width: 100%; margin-bottom: 16px; padding: 12px 16px; background: rgba(217, 119, 6, 0.15); border: 1px solid #d97706; border-radius: 6px; display: flex; gap: 10px; align-items: center; cursor: pointer; text-align: left;" title="Click to sign in to GitHub"><span style="font-size: 18px; flex-shrink: 0;">⚠️</span><div style="flex: 1;"><div style="color: #fbbf24; font-weight: 600; font-size: 13px; margin-bottom: 4px;">GitHub Authentication Required</div><div style="color: #d4a017; font-size: 12px;">Team server sync will not run until you sign in to GitHub. <strong style="color: #fbbf24;">Click here to sign in.</strong></div></div><span style="color: #fbbf24; font-size: 18px; flex-shrink: 0;">→</span></button>` : '';
  return `<div class="info-box"><div class="info-box-title">🖥️ Team Server Backend</div><div>Sync your token usage data to a self-hosted team server for team-wide reporting.</div></div>
    ${authWarning}
    <div class="summary-cards"><div class="summary-card" style="border-left: 4px solid ${color};"><div class="summary-label">${icon} ${escapeHtml(localize('diagnostics.teamServer.status'))}</div><div class="summary-value" style="font-size: 16px; color: ${color};">${text}</div></div>${renderTeamServerGithubAuthCard(githubAuth, githubNotAuthenticated)}<div class="summary-card"><div class="summary-label">👥 ${escapeHtml(localize('diagnostics.teamServer.sharingProfile'))}</div><div class="summary-value" style="font-size: 14px;">${escapeHtml(teamInfo.sharingProfile)}</div></div><div class="summary-card"><div class="summary-label">🕒 ${escapeHtml(localize('diagnostics.teamServer.usageSync'))}</div><div class="summary-value" style="font-size: 14px;">${teamInfo.lastSyncTime ? getTimeSince(teamInfo.lastSyncTime) : escapeHtml(localize('diagnostics.teamServer.never'))}</div><div style="font-size: 11px; color: #999; margin-top: 4px;">${escapeHtml(localize('diagnostics.teamServer.rollupUploadOnly'))}</div></div></div>
    ${renderTeamServerDetailsSection(teamInfo)}
    <div class="button-group"><button class="button" id="btn-configure-backend-team"><span>${teamInfo.isConfigured ? "⚙️" : "🔧"}</span><span>${teamInfo.isConfigured ? "Manage Backend" : "Configure Backend"}</span></button></div>`;
}

function renderBackendStoragePanel(
  backendInfo: BackendStorageInfo | undefined,
  githubAuth?: GitHubAuthStatus,
): string {
  if (!backendInfo) {
    return `
      <div class="info-box">
        <div class="info-box-title">☁️ Backend Storage</div>
        <div>⏳ Loading backend storage status...</div>
      </div>
    `;
  }

  return `
    <div class="subtab-bar">
      <button class="subtab active" data-subtab="backend-azure">☁️ Azure Storage</button>
      <button class="subtab" data-subtab="backend-teamserver">🖥️ Team Server</button>
    </div>
    <div id="subtab-backend-azure" class="subtab-content active">
      ${renderAzureStoragePanel(backendInfo.azure)}
    </div>
    <div id="subtab-backend-teamserver" class="subtab-content">
      ${renderTeamServerPanel(backendInfo.teamServer, githubAuth)}
    </div>
  `;
}

function renderFolderAnalyzerTab(): string {
  return `
    <div class="info-box">
      <div class="info-box-title">🔬 Path Analyzer</div>
      <div>
        Analyze any folder to find session files and inspect their content.
        This helps troubleshoot why the extension isn't finding your AI tool's session files,
        or verify that files from another OS would be recognized.
      </div>
    </div>
    <div class="section">
      <div class="section-title"><span class="codicon codicon-folder-opened"></span><span>Folder Selection</span></div>
      <div class="folder-input-row">
        <input
          type="text"
          id="folder-path-input"
          class="folder-input"
          placeholder="Paste a folder path here, e.g. /Users/you/.claude/projects/abc123"
        />
        <button class="button secondary" id="btn-browse-folder">📂 Browse…</button>
      </div>
      <div style="margin-top: 14px;">
        <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 6px;">
          Tool type (determines which file types to scan):
        </label>
        <select id="tool-type-select" class="tool-type-select">
          <option value="auto">🔍 Auto-detect (all JSON / JSONL files)</option>
          <option value="antigravity">🚀 Antigravity (.jsonl only)</option>
          <option value="claude-code">🟣 Claude Code (.jsonl only)</option>
          <option value="claude-desktop">🖥️ Claude Desktop</option>
          <option value="continue">⚡ Continue</option>
          <option value="copilot-chat">💙 GitHub Copilot Chat (VS Code)</option>
          <option value="copilot-cli">🤖 GitHub Copilot CLI</option>
          <option value="gemini-cli">💎 Gemini CLI (.jsonl only)</option>
          <option value="mistral-vibe">🔥 Mistral Vibe</option>
          <option value="opencode">🟢 OpenCode (JSON format only — DB not supported)</option>
        </select>
      </div>
      <div style="margin-top: 16px;">
        <button class="button" id="btn-analyze-folder">🔍 Analyze</button>
      </div>
    </div>
    <div id="folder-analysis-results"></div>
  `;
}

const FOLDER_ANALYSIS_TABLE_ID = "diagnostics-folder-analysis";

function buildFolderFileColumns(folderPath: string): DataTableColumn<FolderFileResult>[] {
  return [
    { id: "index", label: "#", width: "40px", render: (_f, index) => String(index + 1) },
    {
      id: "file",
      label: "File",
      sortValue: (f) => f.file,
      render: (f) => {
        const rel = f.file.startsWith(folderPath)
          ? f.file.slice(folderPath.length).replace(/^[/\\]/, "")
          : getFileName(f.file);
        return { html: `<span class="diag-path-cell data-table-truncate" title="${escapeHtml(f.file)}" style="font-size: 11px; max-width: 420px;">${escapeHtml(rel)}</span>` };
      },
    },
    { id: "size", label: "Size", align: "right", sortValue: (f) => Number(f.size) || 0, render: (f) => String(formatFileSize(f.size)) },
    {
      id: "interactions",
      label: "Interactions",
      align: "right",
      sortValue: (f) => Number(f.interactions) || 0,
      render: (f) => {
        const safeInteractions = Number(f.interactions);
        return { html: safeInteractions > 0 ? `<strong>${escapeHtml(String(safeInteractions))}</strong>` : `<span style="color: var(--text-muted);">0</span>` };
      },
    },
    {
      id: "tokens",
      label: "Tokens",
      align: "right",
      sortValue: (f) => Number(f.tokens) || 0,
      render: (f) => {
        const safeTokens = Number(f.tokens);
        return {
          html: safeTokens > 0
            ? `<strong title="${escapeHtml(String(safeTokens.toLocaleString()))} tokens">${escapeHtml(String(formatTokenCount(safeTokens)))}</strong>`
            : `<span style="color: var(--text-muted);">0</span>`,
        };
      },
    },
    {
      id: "modified",
      label: "Last Modified",
      firstSortDirection: "desc",
      sortValue: (f) => { const time = new Date(f.modified).getTime(); return Number.isNaN(time) ? null : time; },
      render: (f) => ({ html: formatDate(f.modified) }),
    },
    // Default order: files with the most interactions first, then by tokens.
    { id: "score", label: "", hidden: true, sortValue: (f) => Number(f.interactions) * 1000 + Number(f.tokens) || 0, render: () => "" },
  ];
}

function renderFolderFileTable(files: FolderFileResult[], folderPath: string): string {
  // A new analysis starts on the first page; the chosen sort is kept.
  setDataTableState(FOLDER_ANALYSIS_TABLE_ID, { page: 1 });
  return renderDataTable({
    tableId: FOLDER_ANALYSIS_TABLE_ID,
    ariaLabel: "Analysis Results",
    rows: files,
    columns: buildFolderFileColumns(folderPath),
    initialSort: { columnId: "score", direction: "desc" },
    rowOptions: (f) => f.interactions > 0 || f.tokens > 0 ? undefined : { className: "folder-file-empty" },
  });
}

function renderFolderAnalysisResults(
  files: FolderFileResult[],
  totalScanned: number,
  parseErrors: number,
  truncated: boolean,
  folderPath: string,
): string {
  const sessionFiles = files.filter(f => f.interactions > 0 || f.tokens > 0);
  const totalInteractions = files.reduce((sum, f) => sum + Number(f.interactions), 0);
  const totalTokens = files.reduce((sum, f) => sum + Number(f.tokens), 0);

  const truncatedWarning = truncated
    ? `<div class="info-box" style="margin-bottom: 12px; border-color: #d97706; background: rgba(217,119,6,0.08);">
        <div>⚠️ Scan limit reached (500 files). Results may be incomplete. Try a more specific subfolder.</div>
      </div>`
    : "";

  const emptyState = `
    <div style="padding: 32px; text-align: center; color: var(--text-muted);">
      <div style="font-size: 36px; margin-bottom: 12px;">📭</div>
      <div style="font-size: 14px;">No matching files found in this folder.</div>
      <div style="font-size: 12px; margin-top: 8px;">Try a different folder path or tool type.</div>
    </div>`;

  return `
    <div class="section" style="margin-top: 0;">
      <div class="section-title"><span class="codicon codicon-graph"></span><span>Analysis Results</span></div>
      ${truncatedWarning}
      <div class="summary-cards">
        <div class="summary-card">
          <div class="summary-label">📄 Files Scanned</div>
          <div class="summary-value">${escapeHtml(String(totalScanned))}${truncated ? "+" : ""}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">✅ With Sessions</div>
          <div class="summary-value">${sessionFiles.length}</div>
          <div style="font-size: 11px; color: var(--text-muted);">${files.length - sessionFiles.length} empty / unknown</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">💬 Interactions</div>
          <div class="summary-value">${escapeHtml(String(totalInteractions))}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">🪙 Tokens</div>
          <div class="summary-value" title="${escapeHtml(String(totalTokens.toLocaleString()))} tokens">${escapeHtml(String(formatTokenCount(totalTokens)))}</div>
        </div>
        ${parseErrors > 0 ? `
        <div class="summary-card" style="border-left: 3px solid #d97706;">
          <div class="summary-label">⚠️ Unreadable</div>
          <div class="summary-value" style="color: #d97706;">${escapeHtml(String(parseErrors))}</div>
        </div>` : ""}
      </div>
      ${files.length === 0 ? emptyState : `
        <div style="margin-top: 12px;">${renderFolderFileTable(files, folderPath)}</div>`}
    </div>`;
}

const MODEL_USAGE_PERIOD_ORDER: Period[] = ["allTime", "lastMonth", "currentMonth", "thisWeek", "today"];
const MODEL_USAGE_PERIOD_TO_TIME_RANGE: Record<string, string> = {
  today: "today",
  thisWeek: "week",
  currentMonth: "month",
  lastMonth: "lastMonth",
  allTime: "all",
  yesterday: "yesterday",
};
const MODEL_USAGE_TIME_RANGE_TO_PERIOD: Record<string, string> = {
  today: "today",
  week: "thisWeek",
  month: "currentMonth",
  lastMonth: "lastMonth",
  all: "allTime",
  yesterday: "yesterday",
};

function renderModelUsageTab(detailedFiles: SessionFileDetails[], isLoadingSessions: boolean = false): string {
  const editorStats = getEditorStats(detailedFiles);
  const editorOptions = Object.keys(editorStats).sort()
    .map((editor) => `<option value="${escapeHtml(editor)}">${escapeHtml(getEditorIcon(editor))} ${escapeHtml(editor)} (${editorStats[editor].count})</option>`)
    .join("");
  const statusText = isLoadingSessions ? "⏳ Loading sessions…" : "";
  return `
    <div class="info-box">
      <div class="info-box-title">🧮 Model Usage Breakdown</div>
      <div>
        Aggregates the exact per-model token usage and estimated cost the dashboard uses,
        for a single editor or across all of them. Handy for spotting model/pricing
        mismatches behind an unexpected cost total (e.g. tokens attributed to the wrong model tier).
        Updates automatically when you change the editor or time range below.
      </div>
    </div>
    <div class="section">
      <div class="section-title">🎯 Select Editor &amp; Time Range</div>
      <div class="folder-input-row">
        <select id="model-usage-editor-select" class="tool-type-select" ${isLoadingSessions ? "disabled" : ""}>
          <option value="all">🌐 All Editors</option>
          ${editorOptions}
        </select>
        <span id="model-usage-time-selector"></span>
        <span id="model-usage-status" class="loading-status" role="status" aria-live="polite">${escapeHtml(statusText)}</span>
      </div>
    </div>
    <div id="model-usage-results"></div>
  `;
}

function renderModelUsageTimeSelector(disabled: boolean = false): void {
  const wrapper = document.getElementById("model-usage-time-selector");
  if (!wrapper) { return; }
  wrapper.replaceChildren();
  const selectedPeriod = MODEL_USAGE_TIME_RANGE_TO_PERIOD[currentModelUsageTimeRange] ?? "allTime";
  const { select } = createPeriodSelector({
    id: "model-usage-time-select",
    selected: selectedPeriod,
    periods: MODEL_USAGE_PERIOD_ORDER,
    extraOptions: [{ value: "yesterday", label: "Yesterday" }],
    label: "",
    onChange: (value) => {
      const timeRange = MODEL_USAGE_PERIOD_TO_TIME_RANGE[value];
      if (!timeRange) { return; }
      currentModelUsageTimeRange = timeRange;
      triggerModelUsageAnalysis();
    },
  });
  select.disabled = disabled;
  wrapper.append(select);
}

const MODEL_USAGE_TABLE_ID = "diagnostics-model-usage";

function tokenCountColumn(id: string, label: string, value: (row: ModelUsageRow) => number): DataTableColumn<ModelUsageRow> {
  return {
    id,
    label,
    align: "right",
    sortValue: value,
    render: (row) => ({ html: `<span title="${escapeHtml(`${value(row).toLocaleString()} tokens`)}">${formatTokenCount(value(row))}</span>` }),
  };
}

function buildModelUsageColumns(showCache1h: boolean): DataTableColumn<ModelUsageRow>[] {
  const columns: DataTableColumn<ModelUsageRow>[] = [
    { id: "model", label: "Model", sortValue: (row) => row.model, render: (row) => row.model },
    {
      id: "sessions",
      label: "Sessions",
      align: "right",
      sortValue: (row) => row.sessionCount,
      render: (row) => ({ html: `<span title="${escapeHtml(`${row.sessionCount} session(s)`)}">${row.sessionCount.toLocaleString()}</span>` }),
    },
    tokenCountColumn("input", "Input", (row) => row.inputTokens),
    tokenCountColumn("output", "Output", (row) => row.outputTokens),
    tokenCountColumn("cacheCreate", "Cache Create", (row) => row.cacheCreationTokens),
  ];
  if (showCache1h) {
    columns.push(tokenCountColumn("cacheCreate1h", "Cache Create (1h)", (row) => row.cacheCreation1hTokens));
  }
  columns.push(
    tokenCountColumn("cacheRead", "Cache Read", (row) => row.cachedReadTokens),
    { id: "cost", label: "Est. Cost", align: "right", sortValue: (row) => row.estimatedCost, render: (row) => `$${row.estimatedCost.toFixed(2)}` },
  );
  return columns;
}

function buildModelUsageExplanation(fileCount: number, filesWithUsage: number): string {
  const missing = fileCount - filesWithUsage;
  if (missing <= 0) { return ""; }
  return `
    <div class="info-box" style="margin-top: 12px;">
      <div class="info-box-title">ℹ️ ${missing} session(s) have no per-model data</div>
      <div>
        This is often expected, not a bug. Common causes: chat-only sessions stored in a
        database with no model/token columns (e.g. Copilot CLI's session-store.db), older
        or truncated session logs written before an editor started recording per-model
        attribution, or sessions that never made a model-backed request (e.g. empty/aborted
        chats).
      </div>
    </div>`;
}

const TIME_RANGE_LABELS: Record<string, string> = {
  all: "All Time",
  lastMonth: "Last Month",
  month: "Current Month",
  week: "This Week",
  today: "Today",
  yesterday: "Yesterday",
};

function renderModelUsageResults(
  editor: string,
  fileCount: number,
  filesWithUsage: number,
  rows: ModelUsageRow[],
  totalCost: number,
  supportsCache1h: boolean = true,
  timeRange: string = "all",
): string {
  const editorLabel = editor === "all" ? "All Editors" : editor;
  const timeLabel = TIME_RANGE_LABELS[timeRange] || "All Time";
  const scopeLabel = timeRange === "all" ? editorLabel : `${editorLabel} — ${timeLabel}`;
  if (rows.length === 0) {
    return `
      <div class="section" style="margin-top: 0;">
        <div style="padding: 32px; text-align: center; color: var(--text-muted);">
          <div style="font-size: 36px; margin-bottom: 12px;">📭</div>
          <div style="font-size: 14px;">No per-model usage data found for ${escapeHtml(scopeLabel)}.</div>
          <div style="font-size: 12px; margin-top: 8px;">${fileCount} session file(s) matched, ${filesWithUsage} had model attribution data.</div>
        </div>
      </div>
      ${buildModelUsageExplanation(fileCount, filesWithUsage)}`;
  }
  setDataTableState(MODEL_USAGE_TABLE_ID, { page: 1 });
  const table = renderDataTable({
    tableId: MODEL_USAGE_TABLE_ID,
    ariaLabel: "Model Usage Breakdown",
    rows,
    columns: buildModelUsageColumns(supportsCache1h),
  });
  return `
    <div class="section" style="margin-top: 0;">
      <div class="section-title">📊 Results — ${escapeHtml(scopeLabel)}</div>
      <div class="summary-cards">
        <div class="summary-card">
          <div class="summary-label">📄 Session Files</div>
          <div class="summary-value">${fileCount}</div>
          <div style="font-size: 11px; color: var(--text-muted);">${filesWithUsage} with model data</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">🧩 Models</div>
          <div class="summary-value">${rows.length}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">💰 Est. Total Cost</div>
          <div class="summary-value">$${totalCost.toFixed(2)}</div>
        </div>
      </div>
      <div style="margin-top: 12px;">${table}</div>
      ${buildModelUsageExplanation(fileCount, filesWithUsage)}
    </div>`;
}

function groupSessionFolders(
  raw: Array<{ dir: string; count: number; editorName?: string }>,
): Array<{ dir: string; count: number; editorName?: string }> {
  // Each JetBrains conversation lives in its own UUID subfolder under
  // `~/.copilot/jb/`, so without grouping the table grows unbounded with one
  // row per chat. Collapse them into a single row keyed on the parent dir.
  const result: Array<{ dir: string; count: number; editorName?: string }> = [];
  const jbBuckets = new Map<string, { dir: string; count: number; editorName?: string }>();
  for (const sf of raw || []) {
    const norm = String(sf.dir || "").replace(/\\/g, "/");
    const m = norm.match(/^(.*\/\.copilot\/jb)\/[^/]+\/?$/);
    if (m) {
      const parent = m[1];
      const existing = jbBuckets.get(parent);
      if (existing) {
        existing.count += sf.count;
      } else {
        // Preserve the original separator style of the input path.
        const tail = norm.length - parent.length;
        const parentNative = sf.dir.slice(0, sf.dir.length - tail);
        jbBuckets.set(parent, { dir: parentNative, count: sf.count, editorName: sf.editorName || "JetBrains" });
      }
    } else {
      result.push(sf);
    }
  }
  for (const bucket of jbBuckets.values()) { result.push(bucket); }
  return result;
}

function getHomeDirectory(): string {
  type WindowWithProcess = Window & { process?: { env?: { HOME?: string; USERPROFILE?: string } } };
  const win = window as WindowWithProcess;
  return win.process?.env?.HOME || win.process?.env?.USERPROFILE || "";
}

const SESSION_FOLDERS_TABLE_ID = "diagnostics-session-folders";

function renderSessionFolderOpenCell(sf: SessionFolder): string {
  const editorName = sf.editorName || "Unknown";
  const encodedPath = encodeURIComponent(String(sf.dir ?? ""));
  const openLink = `<a href="#" class="reveal-link" data-path="${escapeHtml(encodedPath)}">Open directory</a>`;
  const reportLink = editorName === "Unknown"
    ? ` <a href="#" class="report-editor-link" data-path="${escapeHtml(encodedPath)}" title="Report this unknown path so we can add editor support">📢 Report</a>`
    : "";
  return openLink + reportLink;
}

function buildSessionFolderColumns(home: string | null): DataTableColumn<SessionFolder>[] {
  return [
    {
      id: "folder",
      label: "Folder",
      sortValue: (sf) => sf.dir,
      cellClassName: () => "data-table-wrap-anywhere",
      render: (sf) => {
        // Host data from an older or partial payload may lack `dir`; render it empty rather than throw.
        const dir = String(sf.dir ?? "");
        const display = home && dir.startsWith(home) ? dir.replace(home, "~") : dir;
        return { html: `<span title="${escapeHtml(dir)}">${escapeHtml(display)}</span>` };
      },
    },
    {
      id: "editor",
      label: "Editor",
      width: "150px",
      sortValue: (sf) => sf.editorName || "Unknown",
      render: (sf) => {
        const editorName = sf.editorName || "Unknown";
        return { html: `<span class="${getEditorBadgeClass(editorName)}">${escapeHtml(`${getEditorIcon(editorName)} ${editorName}`)}</span>` };
      },
    },
    { id: "count", label: "# of Sessions", align: "right", width: "110px", sortValue: (sf) => sf.count, render: (sf) => String(sf.count ?? 0) },
    { id: "open", label: "Open", width: "150px", cellClassName: () => "data-table-wrap-anywhere", render: (sf) => ({ html: renderSessionFolderOpenCell(sf) }) },
  ];
}

function buildSessionFoldersElement(folders: SessionFolder[]): HTMLElement {
  const totalSessions = folders.reduce((sum, sf) => sum + (sf.count || 0), 0);

  const container = document.createElement("div");
  container.className = "session-folders-table";

  const heading = document.createElement("h4");
  heading.textContent = "Main Session Folders (by editor root):";
  container.appendChild(heading);

  const tableHost = document.createElement("div");
  setHtml(tableHost, renderDataTable({
    tableId: SESSION_FOLDERS_TABLE_ID,
    ariaLabel: "Main Session Folders (by editor root):",
    rows: folders,
    columns: buildSessionFolderColumns(getHomeDirectory()),
    initialSort: { columnId: "count", direction: "desc" },
    className: "data-table--fixed",
    footerRows: [{ cells: { editor: "Total:", count: String(totalSessions) } }],
  }));
  container.appendChild(tableHost);

  return container;
}

function setupStorageLinkHandlers(): void {
  document.querySelectorAll(".open-storage-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const path = decodeURIComponent(
        (link as HTMLElement).getAttribute("data-path") || "",
      );
      if (path) {
        vscode.postMessage({ command: "revealPath", path });
      }
    });
  });
}

function setupGitHubAuthHandlers(): void {
  document.getElementById('btn-authenticate-github')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'authenticateGitHub' });
  });

  document.getElementById('btn-sign-out-github')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'signOutGitHub' });
  });
}

function activateSubtab(subtabId: string): boolean {
  const subtabEl = document.querySelector(`.subtab[data-subtab="${subtabId}"]`);
  const contentEl = document.getElementById(`subtab-${subtabId}`);
  if (subtabEl && contentEl) {
    const subtabBar = subtabEl.closest(".subtab-bar");
    if (subtabBar) {
      subtabBar.querySelectorAll(".subtab").forEach((s) => s.classList.remove("active"));
    }
    document.querySelectorAll(".subtab-content").forEach((c) => c.classList.remove("active"));
    subtabEl.classList.add("active");
    contentEl.classList.add("active");
    return true;
  }
  return false;
}

function activateTab(tabId: string): boolean {
  const tabButton = document.querySelector(`.tab[data-tab="${tabId}"]`);
  const tabContent = document.getElementById(`tab-${tabId}`);

  if (tabButton && tabContent) {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));

    tabButton.classList.add("active");
    tabContent.classList.add("active");
    // Let the host record the subview so the what's-new announcer can skip tabs
    // the user already found for themselves. Fire-and-forget.
    vscode.postMessage({ command: "viewTabOpened", view: "diagnostics", tab: tabId });
    return true;
  }
  return false;
}

/** Which group tab (Diagnostics / Research / Settings) each leaf tab lives under. */
const TAB_GROUPS: Record<string, string[]> = {
  // Keep in step with the leaf-tab bars in renderTabBars: a tab rendered in a bar but missing
  // here can never be picked by firstAvailableTabInGroup, and groupOfTab only resolves it by
  // falling through to the "diagnostics" default rather than by actually knowing its group.
  diagnostics: ["report", "sessions", "cache", "path-analyzer", "share"],
  research: ["model-usage", "tool-analysis", "skill-usage", "otel-delta", "ttft"],
  settings: ["display", "backend", "github", "debug"],
};

function groupOfTab(tabId: string): string {
  for (const [group, tabs] of Object.entries(TAB_GROUPS)) {
    if (tabs.includes(tabId)) { return group; }
  }
  return "diagnostics";
}

function isKnownDiagnosticsTab(tabId: string): boolean {
  return Object.values(TAB_GROUPS).some((tabs) => tabs.includes(tabId));
}

/**
 * Requested by the extension host (e.g. the What's New "Take me there" action) to land on a
 * specific tab, including switching its group's leaf bar into view — a plain tab-button click
 * only ever needs activateTab() since the user is already looking at that group's leaf bar. If
 * the tab bar doesn't exist yet (renderLayout() hasn't run — see pendingSwitchTabTo's comment),
 * stash the request instead of silently dropping it.
 */
function handleSwitchTab(message: DiagMessage): void {
  const tab = String(message.tab ?? "");
  if (!isKnownDiagnosticsTab(tab)) { return; }
  if (activateTab(tab)) {
    activateGroup(groupOfTab(tab));
    diagState.patch({ activeTab: tab });
    return;
  }
  pendingSwitchTabTo = tab;
}

/** The first leaf tab in a group that actually has a rendered button (handles the conditional Debug tab). */
function firstAvailableTabInGroup(groupId: string): string | undefined {
  return TAB_GROUPS[groupId]?.find((id) => document.querySelector(`.tab[data-tab="${id}"]`));
}

/** Shows the leaf tab bar for the given group and hides the others; does not change which leaf tab is active. */
function activateGroup(groupId: string): boolean {
  const groupButton = document.querySelector(`.group-tab[data-group="${groupId}"]`);
  const leafBar = document.querySelector(`.leaf-tabs[data-group="${groupId}"]`);
  if (!groupButton || !leafBar) { return false; }

  document.querySelectorAll(".group-tab").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll<HTMLElement>(".leaf-tabs").forEach((b) => { b.style.display = "none"; });

  groupButton.classList.add("active");
  (leafBar as HTMLElement).style.display = "flex";
  return true;
}

function setupGroupHandlers(): void {
  document.querySelectorAll(".group-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const groupId = (button as HTMLElement).getAttribute("data-group");
      if (!groupId || !activateGroup(groupId)) { return; }

      const activeTabInGroup = document.querySelector(`.leaf-tabs[data-group="${groupId}"] .tab.active`);
      if (!activeTabInGroup) {
        const nextTab = firstAvailableTabInGroup(groupId);
        if (nextTab && activateTab(nextTab)) {
          diagState.patch({ activeTab: nextTab });
        }
      }
    });
  });
}

/** Filters change which rows the session table shows, so go back to its first page. */
function applySessionFilterChange(): void {
  setDataTableState(SESSION_TABLE_ID, { page: 1 });
  reRenderTable();
}

function setupEditorFilterHandlers(): void {
  document.querySelectorAll(".editor-panel").forEach((panel) => {
    panel.addEventListener("click", () => {
      const editor = (panel as HTMLElement).getAttribute("data-editor");
      currentEditorFilter = editor === "" ? null : editor;
      applySessionFilterChange();
    });
  });
}

function setupContextRefFilterHandlers(): void {
  document.querySelectorAll(".context-ref-filter").forEach((filter) => {
    filter.addEventListener("click", () => {
      const refType = (filter as HTMLElement).getAttribute(
        "data-ref-type",
      ) as keyof ContextReferenceUsage | null;

      if (currentContextRefFilter === refType) {
        currentContextRefFilter = null;
      } else {
        currentContextRefFilter = refType;
      }
      applySessionFilterChange();
    });
  });
}

function setupUnattributedFilterHandler(): void {
  const checkbox = document.getElementById("show-only-unattributed") as HTMLInputElement | null;
  if (checkbox) {
    checkbox.addEventListener("change", () => {
      showOnlyUnattributed = checkbox.checked;
      applySessionFilterChange();
    });
  }
}

function setupZeroInteractionFilterHandler(): void {
  const checkbox = document.getElementById("hide-empty-sessions") as HTMLInputElement | null;
  if (checkbox) {
    checkbox.addEventListener("change", () => {
      hideEmptySessions = checkbox.checked;
      applySessionFilterChange();
    });
  }
}

function setupBackendButtonHandlers(): void {
  document
    .getElementById("btn-configure-backend")
    ?.addEventListener("click", () => {
      vscode.postMessage({ command: "configureBackend" });
    });

  document
    .getElementById("btn-configure-backend-team")
    ?.addEventListener("click", () => {
      diagState.patch({ activeTab: "backend", activeSubtab: "backend-teamserver" });
      vscode.postMessage({ command: "configureTeamServer" });
    });

  document
    .getElementById("btn-team-server-auth-warning")
    ?.addEventListener("click", () => {
      vscode.postMessage({ command: "authenticateGitHub" });
    });

  document
    .getElementById("btn-open-settings")
    ?.addEventListener("click", () => {
      vscode.postMessage({ command: "openSettings" });
    });

  document
    .getElementById("btn-open-display-settings")
    ?.addEventListener("click", () => {
      vscode.postMessage({ command: "openDisplaySettings" });
    });
}

function setupDisplaySettingHandlers(): void {
  document
    .getElementById("select-show-tokens")
    ?.addEventListener("change", (e) => {
      const value = (e.target as HTMLSelectElement).value;
      vscode.postMessage({ command: "updateDisplaySetting", key: "display.statusBar.showTokens", value });
    });

  document
    .getElementById("select-show-cost")
    ?.addEventListener("change", (e) => {
      const value = (e.target as HTMLSelectElement).value;
      vscode.postMessage({ command: "updateDisplaySetting", key: "display.statusBar.showCost", value });
    });

  document
    .getElementById("input-monthly-budget")
    ?.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const raw = parseFloat(input.value);
      const value = isNaN(raw) ? 0 : Math.min(99999, Math.max(0, Math.round(raw * 100) / 100));
      input.value = value.toString();
      vscode.postMessage({ command: "updateDisplaySetting", key: "display.statusBar.monthlyBudget", value });
    });
}

function setupSubtabHandlers(): void {
  document.querySelectorAll(".subtab").forEach((subtab) => {
    subtab.addEventListener("click", () => {
      const subtabId = (subtab as HTMLElement).getAttribute("data-subtab");
      if (!subtabId) {
        return;
      }
      const subtabBar = subtab.closest(".subtab-bar");
      if (subtabBar) {
        subtabBar.querySelectorAll(".subtab").forEach((s) => s.classList.remove("active"));
      }
      document.querySelectorAll(".subtab-content").forEach((c) => c.classList.remove("active"));
      subtab.classList.add("active");
      document.getElementById(`subtab-${subtabId}`)?.classList.add("active");
      diagState.patch({ activeSubtab: subtabId });
    });
  });
}

function reRenderTable(): void {
  const container = document.getElementById("session-table-container");
  if (container) {
    setHtml(container, renderSessionTable(storedDetailedFiles, isLoading));
    if (!isLoading) {
      setupEditorFilterHandlers();
      setupContextRefFilterHandlers();
      setupZeroInteractionFilterHandler();
      setupUnattributedFilterHandler();
    }
  }
}

function setupToolAnalysisHandlers(): void {
  document.getElementById("btn-open-tool-families-settings")?.addEventListener("click", () => {
    vscode.postMessage({ command: "openToolFamiliesSettings" });
  });
}

const FILE_LINK_SELECTOR = ".session-file-link, .view-formatted-link, .reveal-link, .report-editor-link";
let fileLinksDelegated = false;

/**
 * One delegated listener for the file/folder links in table cells, so links keep working after a
 * table re-renders itself on sort or page changes.
 */
function setupFileLinks(): void {
  if (fileLinksDelegated) { return; }
  fileLinksDelegated = true;
  document.addEventListener("click", (e) => {
    const link = (e.target as Element | null)?.closest?.(FILE_LINK_SELECTOR) as HTMLElement | null;
    if (!link) { return; }
    e.preventDefault();
    if (link.classList.contains("session-file-link")) {
      vscode.postMessage({ command: "openSessionFile", file: decodeURIComponent(link.getAttribute("data-file") || "") });
    } else if (link.classList.contains("view-formatted-link")) {
      vscode.postMessage({ command: "openFormattedJsonlFile", file: decodeURIComponent(link.getAttribute("data-file") || "") });
    } else if (link.classList.contains("reveal-link")) {
      vscode.postMessage({ command: "revealPath", path: decodeURIComponent(link.getAttribute("data-path") || "") });
    } else {
      vscode.postMessage({ command: "reportNewEditorPath", path: decodeURIComponent(link.getAttribute("data-path") || "") });
    }
  });
}

function updateCacheNumbers(): void {
  const cacheTabContent = document.getElementById("tab-cache");
  if (cacheTabContent) {
    const summaryCards = cacheTabContent.querySelectorAll(".summary-card");
    if (summaryCards.length >= 4) {
      const entriesValue = summaryCards[0]?.querySelector(".summary-value");
      if (entriesValue) {
        entriesValue.textContent = "0";
      }

      const sizeValue = summaryCards[1]?.querySelector(".summary-value");
      if (sizeValue) {
        sizeValue.textContent = "0 MB";
      }

      const lastUpdatedValue =
        summaryCards[2]?.querySelector(".summary-value");
      if (lastUpdatedValue) {
        lastUpdatedValue.textContent = "Never";
      }

      const ageValue = summaryCards[3]?.querySelector(".summary-value");
      if (ageValue) {
        ageValue.textContent = "N/A";
      }
    }
  }
}

function setupFolderAnalyzerHandlers(): void {
  document.getElementById("btn-browse-folder")?.addEventListener("click", () => {
    vscode.postMessage({ command: "pickFolder" });
  });

  document.getElementById("btn-analyze-folder")?.addEventListener("click", () => {
    const input = document.getElementById("folder-path-input") as HTMLInputElement | null;
    const select = document.getElementById("tool-type-select") as HTMLSelectElement | null;
    const folderPath = input?.value.trim() ?? "";

    if (!folderPath) {
      if (input) {
        input.style.borderColor = "#d97706";
        input.focus();
      }
      return;
    }
    if (input) {
      input.style.borderColor = "";
    }

    const btn = document.getElementById("btn-analyze-folder") as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      setHtml(btn, "<span>⏳</span><span>Analyzing…</span>");
    }

    const resultsDiv = document.getElementById("folder-analysis-results");
    if (resultsDiv) {
      setHtml(resultsDiv, `
          <div class="analyzer-loading">
            <span class="spinner" style="width:18px;height:18px;border:2px solid var(--link-color);border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin 0.7s linear infinite;"></span>
            <span>Scanning files…</span>
          </div>`);
    }

    vscode.postMessage({
      command: "analyzeFolder",
      folderPath,
      toolType: select?.value ?? "auto",
    });
  });
}

function triggerModelUsageAnalysis(): void {
  const select = document.getElementById("model-usage-editor-select") as HTMLSelectElement | null;
  if (!select || select.disabled) { return; }
  const editor = select.value || "all";
  const timeRange = currentModelUsageTimeRange || "all";

  const resultsDiv = document.getElementById("model-usage-results");
  if (resultsDiv) {
    setHtml(resultsDiv, `
        <div class="analyzer-loading">
          <span class="spinner" style="width:18px;height:18px;border:2px solid var(--link-color);border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin 0.7s linear infinite;"></span>
          <span>Aggregating model usage…</span>
        </div>`);
  }

  vscode.postMessage({ command: "analyzeModelUsage", editor, timeRange });
}

function setupModelUsageHandlers(): void {
  document.getElementById("model-usage-editor-select")?.addEventListener("change", () => {
    triggerModelUsageAnalysis();
  });
}

function handleModelUsageResult(message: DiagMessage): void {
  const resultsDiv = document.getElementById("model-usage-results");
  if (!resultsDiv) { return; }
  if (typeof message.timeRange === "string" && message.timeRange) {
    currentModelUsageTimeRange = message.timeRange;
    renderModelUsageTimeSelector(false);
  }
  if (message.stillLoading) {
    setHtml(resultsDiv, `
      <div class="info-box" style="margin-top: 12px;">
        <div class="info-box-title">⏳ Still loading session files</div>
        <div>Session files are still being scanned in the background. Wait a moment (watch the "Session Files" tab count) and try again.</div>
      </div>`);
    return;
  }
  setHtml(resultsDiv, renderModelUsageResults(
    String(message.editor || "all"),
    Number(message.fileCount || 0),
    Number(message.filesWithUsage || 0),
    (message.rows || []) as ModelUsageRow[],
    Number(message.totalCost || 0),
    message.supportsCache1h !== false,
    String(message.timeRange || "all"),
  ));
}

function setupTabHandlers(): void {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabId = (tab as HTMLElement).getAttribute("data-tab");

      if (tabId && activateTab(tabId)) {
        diagState.patch({ activeTab: tabId });
        if (tabId === "model-usage") {
          const resultsDiv = document.getElementById("model-usage-results");
          if (resultsDiv && !resultsDiv.innerHTML.trim()) { triggerModelUsageAnalysis(); }
        } else if (tabId === "ttft") {
          const resultsDiv = document.getElementById("ttft-results");
          if (resultsDiv && !resultsDiv.innerHTML.trim()) { triggerTtftAnalysis(); }
        }
      }
    });
  });
}

function handleClearCacheClick(target: HTMLElement): void {
  target.style.background = "#d97706";
  setHtml(target, "<span>⏳</span><span>Clearing...</span>");
  if (target instanceof HTMLButtonElement) {
    target.disabled = true;
  }
  updateCacheNumbers();
  vscode.postMessage({ command: "clearCache" });
}

function handleDebugCounterSetClick(target: HTMLElement): void {
  const key = target.getAttribute("data-key");
  const row = target.closest("tr");
  const input = row?.querySelector(".debug-counter-input") as HTMLInputElement | null;
  if (key && input) {
    const value = parseInt(input.value, 10);
    if (!isNaN(value)) {
      vscode.postMessage({ command: "setDebugCounter", key, value });
    }
  }
}

function handleDebugFlagSetClick(target: HTMLElement): void {
  const key = target.getAttribute("data-key");
  const row = target.closest("tr");
  const input = row?.querySelector(".debug-flag-input") as HTMLInputElement | null;
  if (key && input) {
    vscode.postMessage({ command: "setDebugFlag", key, value: input.checked });
  }
}

function handleGlobalClickEvent(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (!target) { return; }
  if (target.id === "btn-clear-cache" || target.id === "btn-clear-cache-tab") {
    handleClearCacheClick(target);
  }
  if (target.id === "btn-reset-insights" || target.id === "btn-reset-insights-tab") {
    vscode.postMessage({ command: "resetInsightsState" });
  }
  if (target.id === "btn-reset-debug-counters") {
    vscode.postMessage({ command: "resetDebugCounters" });
  }
  if (target.id === "btn-reset-discovered-editors") {
    vscode.postMessage({ command: "resetDiscoveredEditors" });
  }
  if (target.classList.contains("debug-counter-set")) {
    handleDebugCounterSetClick(target);
  }
  if (target.classList.contains("debug-flag-set")) {
    handleDebugFlagSetClick(target);
  }
}

function wireNavButtons(): void {
  document
    .getElementById("btn-refresh")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "refresh" }),
    );
  document
    .getElementById("btn-chart")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showChart" }),
    );
  document
    .getElementById("btn-usage")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showUsageAnalysis" }),
    );
  document
    .getElementById("btn-details")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showDetails" }),
    );
  document
    .getElementById("btn-diagnostics")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showDiagnostics" }),
    );
  document
    .getElementById("btn-maturity")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showMaturity" }),
    );
  document
    .getElementById("btn-dashboard")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showDashboard" }),
    );
  document
    .getElementById("btn-environmental")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showEnvironmental" }),
    );
  document
    .getElementById("btn-efficiency")
    ?.addEventListener("click", () =>
      vscode.postMessage({ command: "showEfficiency" }),
    );
  wireExtensionPointButtons(vscode);
}

/** Renders the Share Card's period dropdown into its placeholder span, reusing the shared period-selector
 * component for visual/state consistency with the other period selectors in this webview (e.g. Model Usage). */
function renderShareCardPeriodSelector(): void {
  const wrapper = document.getElementById("share-card-period-selector");
  if (!wrapper) { return; }
  wrapper.replaceChildren();
  const { select } = createPeriodSelector({
    id: "share-card-period-select",
    selected: currentShareCardPeriod,
    periods: SHARE_CARD_PERIOD_ORDER,
    label: "",
    onChange: (value) => {
      currentShareCardPeriod = value as Period;
      diagState.patch({ shareCardPeriod: currentShareCardPeriod });
      reRenderShareCard();
    },
  });
  wrapper.append(select);
}

/** Builds the current Share Card's plain-text summary from live filtered session data, for both
 * the "Copy Summary Text" button and the social share buttons. */
function buildCurrentShareSummaryText(): string {
  const filteredFiles = filterFilesByShareCardPeriod(storedDetailedFiles, currentShareCardPeriod);
  const editorStats = getEditorStats(filteredFiles);
  const editors = Object.keys(editorStats).sort((a, b) => editorStats[b].count - editorStats[a].count);
  const totalSessions = filteredFiles.length;
  const totalInteractions = filteredFiles.reduce((sum, sf) => sum + Number(sf.interactions || 0), 0);
  const totalTokens = filteredFiles.reduce((sum, sf) => sum + Number(sf.tokens || 0), 0);
  return buildShareSummaryText(editors, editorStats, totalSessions, totalInteractions, totalTokens, currentShareCardPeriod);
}

/** Wires the "Copy Summary Text" button, social share buttons, and period selector on the Share
 * Card tab. Re-run after `reRenderShareCard()` replaces the tab's markup, since these elements are recreated. */
function setupShareSummaryButtonHandler(): void {
  renderShareCardPeriodSelector();
  document.getElementById("btn-copy-share-summary")?.addEventListener("click", () => {
    vscode.postMessage({ command: "copyText", text: buildCurrentShareSummaryText() });
  });
  const socialPlatforms: Array<{ id: string; platform: "linkedin" | "bluesky" | "mastodon" }> = [
    { id: "btn-share-card-linkedin", platform: "linkedin" },
    { id: "btn-share-card-bluesky", platform: "bluesky" },
    { id: "btn-share-card-mastodon", platform: "mastodon" },
  ];
  for (const { id, platform } of socialPlatforms) {
    document.getElementById(id)?.addEventListener("click", () => {
      vscode.postMessage({ command: "shareCardToSocial", platform, text: buildCurrentShareSummaryText() });
    });
  }
}

/** Re-renders the Share Card tab once session files have finished loading, since it is
 * initially rendered with an empty file list before the async load completes. */
function reRenderShareCard(): void {
  replaceTabContent("share", renderShareCardTab(storedDetailedFiles), setupShareSummaryButtonHandler);
}

function setupButtonHandlers(): void {
  document.getElementById("btn-copy")?.addEventListener("click", () => {
    vscode.postMessage({ command: "copyReport" });
  });

  setupShareSummaryButtonHandler();

  document.getElementById("btn-issue")?.addEventListener("click", () => {
    vscode.postMessage({ command: "openIssue" });
  });

  document.getElementById("btn-clear-cache")?.addEventListener("click", () => {
    const btn = document.getElementById(
      "btn-clear-cache",
    ) as HTMLButtonElement | null;
    if (btn) {
      btn.style.background = "#d97706";
      setHtml(btn, "<span>⏳</span><span>Clearing...</span>");
      btn.disabled = true;
    }
    updateCacheNumbers();
    vscode.postMessage({ command: "clearCache" });
  });

  document
    .getElementById("btn-clear-cache-tab")
    ?.addEventListener("click", () => {
      const btn = document.getElementById(
        "btn-clear-cache-tab",
      ) as HTMLButtonElement | null;
      if (btn) {
        btn.style.background = "#d97706";
        setHtml(btn, "<span>⏳</span><span>Clearing...</span>");
        btn.disabled = true;
      }
      updateCacheNumbers();
      vscode.postMessage({ command: "clearCache" });
    });

  document.addEventListener("click", handleGlobalClickEvent);

  wireNavButtons();
}

type DiagMessage = Record<string, any>;

function handleDiagnosticReport(message: DiagMessage): void {
  if (!message.report) { return; }
  const reportTabContent = document.getElementById("tab-report");
  if (!reportTabContent) { return; }
  const processedReport = removeSessionFilesSection(message.report);
  const reportPre = reportTabContent.querySelector(".report-content");
  if (reportPre) { reportPre.textContent = processedReport; }
}

function handleBackendStorageSection(message: DiagMessage): void {
  if (!message.backendStorageInfo) {
    console.warn("diagnosticDataLoaded received but backendStorageInfo is missing or undefined");
    return;
  }
  currentBackendInfo = message.backendStorageInfo;
  if (message.githubAuth !== undefined) { currentGithubAuth = message.githubAuth; }
  const backendTabContent = document.getElementById("tab-backend");
  if (!backendTabContent) { return; }
  const activeSubtabEl = backendTabContent.querySelector(".subtab.active") as HTMLElement | null;
  const previousSubtab = activeSubtabEl?.getAttribute("data-subtab") ?? diagState.restore().activeSubtab;
  setHtml(backendTabContent, renderBackendStoragePanel(currentBackendInfo, currentGithubAuth));
  setupBackendButtonHandlers();
  setupSubtabHandlers();
  if (previousSubtab) {
    activateSubtab(previousSubtab);
    diagState.patch({ activeSubtab: previousSubtab });
  }
}

function handleSessionFoldersSection(message: DiagMessage): void {
  if (!message.sessionFolders || message.sessionFolders.length === 0) { return; }
  const reportTabContent = document.getElementById("tab-report");
  if (!reportTabContent) { return; }
  const grouped = groupSessionFolders(message.sessionFolders as SessionFolder[]);
  const foldersEl = buildSessionFoldersElement(grouped);
  const existing = reportTabContent.querySelector(".session-folders-table");
  if (existing) {
    existing.replaceWith(foldersEl);
  } else {
    const reportContent = reportTabContent.querySelector(".report-content");
    if (reportContent) { reportContent.insertAdjacentElement("afterend", foldersEl); }
    else { reportTabContent.appendChild(foldersEl); }
  }
  setupStorageLinkHandlers();
}

function handleCandidatePathsSection(message: DiagMessage): void {
  if (!message.candidatePaths || message.candidatePaths.length === 0) { return; }
  const reportTabContent = document.getElementById("tab-report");
  if (!reportTabContent) { return; }
  reportTabContent.querySelector(".candidate-paths-table")?.remove();
  const candidateEl = buildCandidatePathsElement(message.candidatePaths);
  const foldersTable = reportTabContent.querySelector(".session-folders-table");
  if (foldersTable) {
    foldersTable.insertAdjacentElement("afterend", candidateEl);
  } else {
    const reportContent = reportTabContent.querySelector(".report-content");
    if (reportContent) { reportContent.insertAdjacentElement("afterend", candidateEl); }
    else { reportTabContent.appendChild(candidateEl); }
  }
}

/**
 * Replaces a tab's content element with freshly rendered HTML, preserving its active state.
 * Security contract: `newContent` is built entirely by this file's own render*() functions
 * from structured (non-HTML) data sent by the extension host over postMessage — every
 * interpolated string field is passed through escapeHtml(), and every numeric field through
 * an explicit Number() cast, before being placed into a template literal. Never pass raw
 * message field values into this function directly.
 */
function replaceTabContent(tabId: string, newContent: string, onReplaced?: () => void): void {
  const tabContent = document.getElementById(`tab-${tabId}`);
  if (!tabContent) { return; }
  const wasActive = tabContent.classList.contains("active");
  const temp = document.createElement('div');
  setHtml(temp, newContent);
  const newTab = temp.firstElementChild as HTMLElement | null;
  if (!newTab) { return; }
  if (wasActive) { newTab.classList.add("active"); }
  tabContent.replaceWith(newTab);
  onReplaced?.();
}

function handleGithubAuthSection(message: DiagMessage): void {
  if (message.githubAuth === undefined) { return; }
  const githubTabContent = document.getElementById("tab-github");
  if (githubTabContent) {
    setHtml(githubTabContent, renderGitHubAuthPanel(message.githubAuth));
    setupGitHubAuthHandlers();
  }
}

function handleToolAnalysisSection(message: DiagMessage): void {
  if (message.toolFamilies) { storedToolFamilies = message.toolFamilies as ToolFamilyConfig[]; }
  if (message.toolCallStats === undefined) { return; }
  const newContent = renderToolAnalysisTab(message.toolCallStats as DiagnosticsData['toolCallStats'], storedToolFamilies);
  replaceTabContent("tool-analysis", newContent, setupToolAnalysisHandlers);
}

/** Re-renders the Skill Usage tab body from the cached data + current editor filter, preserving active/tab state. */
function rerenderSkillUsageTab(): void {
  replaceTabContent(
    "skill-usage",
    renderSkillUsageTab(currentSkillCallStats, currentSkillCallsByEditor, currentSkillDescriptions, skillUsageEditorFilter),
    setupSkillUsageFilterHandler
  );
}

function setupSkillUsageFilterHandler(): void {
  document.querySelectorAll<HTMLElement>(".skill-usage-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const editor = chip.getAttribute("data-editor");
      if (!editor) { return; }
      skillUsageEditorFilter = editor;
      diagState.patch({ skillUsageEditorFilter: editor });
      setDataTableState(SKILL_USAGE_TABLE_ID, { page: 1 });
      rerenderSkillUsageTab();
    });
  });
}

function handleSkillUsageSection(message: DiagMessage): void {
  if (message.skillCallStats !== undefined) { currentSkillCallStats = message.skillCallStats as DiagnosticsData['skillCallStats']; }
  if (message.skillCallsByEditor !== undefined) { currentSkillCallsByEditor = message.skillCallsByEditor as DiagnosticsData['skillCallsByEditor']; }
  if (message.skillDescriptions !== undefined) { currentSkillDescriptions = message.skillDescriptions as DiagnosticsData['skillDescriptions']; }
  if (message.skillCallStats === undefined) { return; }
  rerenderSkillUsageTab();
}

/** Re-renders the OTel Delta tab body from currentOtelComparison + currentOtelDeltaPeriod, preserving active/tab state. */
function rerenderOtelDeltaTab(): void {
  replaceTabContent("otel-delta", renderOtelDeltaTab(currentOtelComparison, currentOtelDeltaPeriod), setupOtelDeltaPeriodHandler);
}

function setupOtelDeltaPeriodHandler(): void {
  const select = document.getElementById("otel-delta-period") as HTMLSelectElement | null;
  if (!select) { return; }
  select.addEventListener("change", () => {
    currentOtelDeltaPeriod = select.value as OtelDeltaPeriod;
    diagState.patch({ otelDeltaPeriod: currentOtelDeltaPeriod });
    setDataTableState(OTEL_DELTA_TABLE_ID, { page: 1 });
    rerenderOtelDeltaTab();
  });
}

function handleOtelComparisonSection(message: DiagMessage): void {
  if (message.otelComparison === undefined) { return; }
  currentOtelComparison = message.otelComparison as DiagnosticsData['otelComparison'];
  rerenderOtelDeltaTab();
}

function handleDiagnosticDataLoaded(message: DiagMessage): void {
  if (message.accountBudgets !== undefined) { handleAccountBudgetsUpdated(message); }
  handleDiagnosticReport(message);
  handleBackendStorageSection(message);
  handleSessionFoldersSection(message);
  handleCandidatePathsSection(message);
  handleGithubAuthSection(message);
  handleToolAnalysisSection(message);
  handleSkillUsageSection(message);
  handleOtelComparisonSection(message);
}

function handleAccountBudgetsUpdated(message: DiagMessage): void {
  const card = document.getElementById("diag-quota-card");
  if (card && Object.prototype.hasOwnProperty.call(message, "quotaEntitlements")) {
    // Re-render the whole card: sign-out or a removed account clears the quota figures, not just the list.
    const rendered = document.createElement("div");
    setHtml(rendered, renderQuotaCardHtml({
      quotaEntitlements: message.quotaEntitlements as QuotaEntitlements | undefined,
      accountBudgets: message.accountBudgets as AccountBudgetView[] | undefined,
    }));
    const fresh = rendered.firstElementChild;
    if (fresh) { card.replaceWith(fresh); }
    // The Monthly Budget card's hint reads the same quota, so it must follow the card (sign-out / account switch).
    const hint = document.getElementById("diag-api-budget-hint");
    if (hint) { setHtml(hint, renderApiBudgetHintHtml(message.quotaEntitlements as QuotaEntitlements | undefined)); }
    return;
  }
  const container = document.getElementById("diag-account-budgets");
  if (container) { setHtml(container, renderAccountBudgetsHtml(message.accountBudgets as AccountBudgetView[] | undefined)); }
}

function handleGithubAuthUpdated(message: DiagMessage): void {
  currentGithubAuth = message.githubAuth;
  const githubTabContent = document.getElementById("tab-github");
  if (githubTabContent) {
    setHtml(githubTabContent, renderGitHubAuthPanel(currentGithubAuth));
    setupGitHubAuthHandlers();
  }
  const backendTabContent = document.getElementById("tab-backend");
  if (backendTabContent && currentBackendInfo) {
    const activeSubtabEl = backendTabContent.querySelector(".subtab.active") as HTMLElement | null;
    const previousSubtab = activeSubtabEl?.getAttribute("data-subtab");
    setHtml(backendTabContent, renderBackendStoragePanel(currentBackendInfo, currentGithubAuth));
    setupBackendButtonHandlers();
    setupSubtabHandlers();
    if (previousSubtab) {
      activateSubtab(previousSubtab);
    }
  }
}

function handleDiagnosticDataError(message: DiagMessage): void {
  console.error("Error loading diagnostic data:", message.error);
  const rootEl = document.getElementById("root");
  if (rootEl) {
    const errorDiv = document.createElement("div");
    errorDiv.style.cssText =
      "color: #ff6b6b; padding: 20px; text-align: center;";
    setHtml(errorDiv, `
<h3><span class="codicon codicon-warning"></span> Error Loading Diagnostic Data</h3>
<p>${escapeHtml(message.error || "Unknown error")}</p>
`);
    rootEl.insertBefore(errorDiv, rootEl.firstChild);
  }
}

function sanitizeNumericRecord(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, Number(value ?? 0) || 0]),
  );
}

function numField(v: unknown): number { return Number(v ?? 0) || 0; }
function optStr(v: unknown): string | undefined { return v === null || v === undefined ? undefined : String(v); }
function nullStr(v: unknown): string | null { return v === null || v === undefined ? null : String(v); }

function sanitizeContextReferences(contextRefs: Record<string, unknown>) {
  return {
    file: numField(contextRefs.file),
    symbol: numField(contextRefs.symbol),
    selection: numField(contextRefs.selection),
    implicitSelection: numField(contextRefs.implicitSelection),
    codebase: numField(contextRefs.codebase),
    workspace: numField(contextRefs.workspace),
    terminal: numField(contextRefs.terminal),
    vscode: numField(contextRefs.vscode),
    terminalLastCommand: numField(contextRefs.terminalLastCommand),
    terminalSelection: numField(contextRefs.terminalSelection),
    clipboard: numField(contextRefs.clipboard),
    changes: numField(contextRefs.changes),
    outputPanel: numField(contextRefs.outputPanel),
    problemsPanel: numField(contextRefs.problemsPanel),
    pullRequest: numField(contextRefs.pullRequest),
    byKind: sanitizeNumericRecord(contextRefs.byKind),
    copilotInstructions: numField(contextRefs.copilotInstructions),
    agentsMd: numField(contextRefs.agentsMd),
    byPath: sanitizeNumericRecord(contextRefs.byPath),
  };
}

function sanitizeChildInfo(sf: Record<string, unknown>) {
  if (!Array.isArray(sf.childInfo)) { return undefined; }
  return sf.childInfo
    .filter((child): child is Record<string, unknown> => !!child && typeof child === "object")
    .map((child) => ({
      uuid: String(child.uuid ?? ""),
      name: String(child.name ?? ""),
      sessionFile: optStr(child.sessionFile),
    }));
}

function sanitizeParentInfo(sf: Record<string, unknown>) {
  if (!sf.parentInfo || typeof sf.parentInfo !== "object") { return undefined; }
  const p = sf.parentInfo as Record<string, unknown>;
  return {
    uuid: String(p.uuid ?? ""),
    name: String(p.name ?? ""),
    sessionFile: optStr(p.sessionFile),
  };
}

function sanitizeSessionFileItem(item: unknown): SessionFileDetails {
  const sf = (item ?? {}) as Record<string, unknown>;
  const contextRefs = (sf.contextReferences ?? {}) as Record<string, unknown>;
  return {
    file: String(sf.file ?? sf.sessionFile ?? ""),
    editorSource: String(sf.editorSource ?? ""),
    editorRoot: optStr(sf.editorRoot),
    editorName: optStr(sf.editorName),
    title: optStr(sf.title),
    repository: optStr(sf.repository),
    size: numField(sf.size),
    modified: String(sf.modified ?? ""),
    tokens: numField(sf.tokens),
    interactions: numField(sf.interactions),
    firstInteraction: nullStr(sf.firstInteraction),
    lastInteraction: nullStr(sf.lastInteraction),
    contextReferences: sanitizeContextReferences(contextRefs),
    parentInfo: sanitizeParentInfo(sf),
    childInfo: sanitizeChildInfo(sf),
    totalChildCount: sf.totalChildCount === null || sf.totalChildCount === undefined ? undefined : Number(sf.totalChildCount),
    subAgentCalls: sf.subAgentCalls === null || sf.subAgentCalls === undefined ? undefined : Number(sf.subAgentCalls),
  } as SessionFileDetails;
}

function sanitizeDetailedSessionFiles(input: unknown): SessionFileDetails[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map(sanitizeSessionFileItem);
}

function handleSessionFilesLoadProgress(message: DiagMessage): void {
  const processed = Number(message.processed || 0);
  const total = Number(message.total || 0);
  const progressText = total > 0 ? `Analyzing files… (${processed} / ${total})` : "Analyzing files…";

  const sessionSubtext = document.getElementById("session-loading-subtext");
  if (sessionSubtext) { sessionSubtext.textContent = progressText; }

  const shareSubtext = document.getElementById("share-loading-subtext");
  if (shareSubtext) { shareSubtext.textContent = progressText; }

  const reportSubtext = document.getElementById("report-loading-subtext");
  if (reportSubtext) { reportSubtext.textContent = progressText; }

  const ttftLoadingStatus = document.getElementById("ttft-loading-status");
  if (ttftLoadingStatus) { ttftLoadingStatus.textContent = progressText; }

  const modelUsageStatus = document.getElementById("model-usage-status");
  if (modelUsageStatus) {
    modelUsageStatus.textContent = total > 0 ? `⏳ Loading sessions… (${processed}/${total})` : "⏳ Loading sessions…";
  }
}

function handleSessionFilesLoaded(message: DiagMessage): void {
  storedDetailedFiles = sanitizeDetailedSessionFiles(message.detailedSessionFiles);
  isLoading = false;

  const sessionsTab = document.querySelector('.tab[data-tab="sessions"]');
  if (sessionsTab) {
    sessionsTab.textContent = `📁 Session Files (${storedDetailedFiles.length})`;
  }

  const modelUsageSelect = document.getElementById("model-usage-editor-select") as HTMLSelectElement | null;
  if (modelUsageSelect) {
    const editorStats = getEditorStats(storedDetailedFiles);
    const editorOptions = Object.keys(editorStats).sort()
      .map((editor) => `<option value="${escapeHtml(editor)}">${escapeHtml(getEditorIcon(editor))} ${escapeHtml(editor)} (${editorStats[editor].count})</option>`)
      .join("");
    setHtml(modelUsageSelect, `<option value="all">🌐 All Editors</option>${editorOptions}`);
    modelUsageSelect.disabled = false;
  }
  renderModelUsageTimeSelector(false);
  const modelUsageStatus = document.getElementById("model-usage-status");
  if (modelUsageStatus) { modelUsageStatus.textContent = ""; }

  triggerModelUsageAnalysis();

  // Only re-run TTFT if the user already opened that tab (or changed granularity) while
  // files were still loading — its results div would be non-empty in that case (holding
  // either the initial spinner or the "still loading" notice). A user who never opened the
  // tab has an empty div here, and TTFT stays lazy for them as designed.
  const ttftResultsDiv = document.getElementById("ttft-results");
  if (ttftResultsDiv && ttftResultsDiv.innerHTML.trim()) { triggerTtftAnalysis(); }

  reRenderTable();
  reRenderShareCard();
}

function handleCacheCleared(): void {
  const btnReport = document.getElementById(
    "btn-clear-cache",
  ) as HTMLButtonElement | null;
  const btnTab = document.getElementById(
    "btn-clear-cache-tab",
  ) as HTMLButtonElement | null;
  if (btnReport) {
    btnReport.style.background = "#2d6a4f";
    setHtml(btnReport, "<span>✅</span><span>Cache Cleared</span>");
    btnReport.disabled = false;
  }
  if (btnTab) {
    btnTab.style.background = "#2d6a4f";
    setHtml(btnTab, "<span>✅</span><span>Cache Cleared</span>");
    btnTab.disabled = false;
  }

  setTimeout(() => {
    if (btnReport) {
      btnReport.style.background = "";
      setHtml(btnReport, "<span>🗑️</span><span>Clear Cache</span>");
    }
    if (btnTab) {
      btnTab.style.background = "";
      setHtml(btnTab, "<span>🗑️</span><span>Clear Cache</span>");
    }
  }, 2000);
}

function updateCacheSummaryCards(cacheInfo: any, summaryCards: NodeListOf<Element>): void {
  if (summaryCards.length < 4) { return; }
  const entriesValue = summaryCards[0]?.querySelector(".summary-value");
  if (entriesValue) { entriesValue.textContent = String(cacheInfo.size); }
  const sizeValue = summaryCards[1]?.querySelector(".summary-value");
  if (sizeValue) { sizeValue.textContent = `${cacheInfo.sizeInMB.toFixed(2)} MB`; }
  const lastUpdatedValue = summaryCards[2]?.querySelector(".summary-value");
  if (lastUpdatedValue) { lastUpdatedValue.textContent = new Date(cacheInfo.lastUpdated).toLocaleString(); }
  const ageValue = summaryCards[3]?.querySelector(".summary-value");
  if (ageValue) { ageValue.textContent = "0 seconds ago"; }
}

function handleCacheRefreshed(message: DiagMessage): void {
  if (!message.cacheInfo) { return; }
  const cacheTabContent = document.getElementById("tab-cache");
  if (!cacheTabContent) { return; }
  updateCacheSummaryCards(message.cacheInfo, cacheTabContent.querySelectorAll(".summary-card"));
}

function handleFolderPicked(message: DiagMessage): void {
  const input = document.getElementById("folder-path-input") as HTMLInputElement | null;
  if (input && message.folderPath) {
    input.value = message.folderPath;
    input.style.borderColor = "";
  }
}

function handleFolderAnalysisResult(message: DiagMessage): void {
  const btn = document.getElementById("btn-analyze-folder") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    setHtml(btn, "<span>🔍</span><span>Analyze</span>");
  }
  const resultsDiv = document.getElementById("folder-analysis-results");
  if (resultsDiv) {
    if (message.error) {
      setHtml(resultsDiv, `
        <div class="info-box" style="border-color: #d97706; background: rgba(217,119,6,0.08); margin-top: 12px;">
          <div class="info-box-title">⚠️ Analysis Error</div>
          <div>${escapeHtml(message.error)}</div>
        </div>`);
    } else {
      setHtml(resultsDiv, renderFolderAnalysisResults(
        message.files || [],
        message.totalScanned || 0,
        message.parseErrors || 0,
        message.truncated || false,
        escapeHtml(String(message.folderPath || "")),
      ));
    }
  }
}

const DIAG_MESSAGE_HANDLERS: Record<string, (message: DiagMessage) => void> = {
  diagnosticDataLoaded: handleDiagnosticDataLoaded,
  backendStorageInfoLoaded: handleBackendStorageSection,
  githubAuthUpdated: handleGithubAuthUpdated,
  accountBudgetsUpdated: handleAccountBudgetsUpdated,
  diagnosticDataError: handleDiagnosticDataError,
  sessionFilesLoadProgress: handleSessionFilesLoadProgress,
  cacheCleared: handleCacheCleared,
  cacheRefreshed: handleCacheRefreshed,
  folderPicked: handleFolderPicked,
  folderAnalysisResult: handleFolderAnalysisResult,
  modelUsageResult: handleModelUsageResult,
  ttftResult: handleTtftResult,
  switchTab: handleSwitchTab,
};

function setupMessageHandlers(): void {
  registerMessageHandler((message: DiagMessage) => {
    // Only one command carries a payload-shaped guard beyond its name, so it stays a special case
    // rather than forcing every entry in the table above to encode its own dispatch condition.
    if (message.command === "sessionFilesLoaded") {
      if (message.detailedSessionFiles) { handleSessionFilesLoaded(message); }
      return;
    }
    DIAG_MESSAGE_HANDLERS[message.command]?.(message);
  });
}

function renderDiagCacheTabHtml(data: DiagnosticsData): string {
  return `
<div id="tab-cache" class="tab-content">
<div class="info-box">
<div class="info-box-title">💾 Cache Information</div>
<div>
The extension caches session file data to improve performance and reduce file system operations.
Cache is stored in VS Code's global state and persists across sessions.
</div>
</div>
<div class="cache-details">
<div class="summary-cards">
<div class="summary-card">
<div class="summary-label">📦 Cache Entries</div>
<div class="summary-value">${data.cacheInfo?.size || 0}</div>
</div>
<div class="summary-card">
<div class="summary-label">💾 Cache Size</div>
<div class="summary-value">${data.cacheInfo?.sizeInMB ? data.cacheInfo.sizeInMB.toFixed(2) + " MB" : "N/A"}</div>
</div>
<div class="summary-card">
<div class="summary-label">🕒 Last Updated</div>
<div class="summary-value" style="font-size: 14px;">${data.cacheInfo?.lastUpdated ? formatDate(data.cacheInfo.lastUpdated) : "Never"}</div>
</div>
<div class="summary-card">
<div class="summary-label">⏱️ Cache Age</div>
<div class="summary-value" style="font-size: 14px;">${data.cacheInfo?.lastUpdated ? getTimeSince(data.cacheInfo.lastUpdated) : "N/A"}</div>
</div>
</div>
<div class="cache-location">
<h4>Storage Location</h4>
<div class="location-box">
<code>${escapeHtml(data.cacheInfo?.location || "VS Code Global State")}</code>
${data.cacheInfo?.storagePath ? ` <a href="#" class="open-storage-link" data-path="${encodeURIComponent(data.cacheInfo.storagePath)}">Open storage location</a>` : ""}
</div>
<p style="color: #999; font-size: 12px; margin-top: 8px;">
Cache is stored in VS Code's global state (extension storage) and includes:
<ul style="margin: 8px 0 0 20px;">
<li>Token counts per session file</li>
<li>Interaction counts</li>
<li>Model usage statistics</li>
<li>File modification timestamps for validation</li>
<li>Usage analysis data (tool calls, modes, context references)</li>
</ul>
</p>
</div>
<div class="cache-actions">
<h4>Cache Management</h4>
<p style="color: #999; font-size: 12px; margin-bottom: 12px;">
Clearing the cache will force the extension to re-read and re-analyze all session files on the next update.
This can help resolve issues with stale or incorrect data.
</p>
<div class="button-group" style="margin-top: 8px;">
<button class="button secondary" id="btn-clear-cache-tab"><span>🗑️</span><span>Clear Cache</span></button>
<button class="button secondary" id="btn-reset-insights-tab"><span>💡</span><span>Reset Insights Dismissals</span></button>
</div>
</div>
</div>
</div>`;
}

function sel(current: string, value: string): string {
  return current === value ? 'selected' : '';
}

function renderAccountBudgetRowHtml(b: AccountBudgetView): string {
  const plan = b.planName ? ` (${escapeHtml(b.planName)})` : "";
  let detail: string;
  if (b.status === "ok" && b.balance) {
    const reset = b.resetDate ? `, ${escapeHtml(localizeFormat("accountBudgets.resets", b.resetDate.slice(0, 10)))}` : "";
    detail = `${escapeHtml(localizeFormat("accountBudgets.usedLeft", "$" + (b.balance.usedAiCredits / 100).toFixed(2), "$" + b.balance.budgetUsd.toFixed(2), b.balance.pctAvailable.toFixed(1)))}${reset}`;
  } else if (b.status === "no-quota") {
    detail = escapeHtml(localize("accountBudgets.noQuota"));
  } else if (b.reason === "no-session") {
    detail = escapeHtml(localize("accountBudgets.noSession"));
  } else if (b.reason === "lookup-failed") {
    detail = escapeHtml(localizeFormat("accountBudgets.lookupFailed", b.detail ?? ""));
  } else {
    detail = escapeHtml(b.detail ?? localize("accountBudgets.unavailable"));
  }
  return `<strong>${escapeHtml(b.label)}</strong>${plan}: ${detail}<br/>`;
}

/** Whether the quota card above already shows the budget a lone account would repeat. */
let quotaFigureShown = false;

function renderAccountBudgetsHtml(accounts: AccountBudgetView[] | undefined): string {
  // Same rule as the other surfaces: skip only a lone account with a balance, which the quota figures above already show.
  if (!accounts || !shouldListAccountBudgets(accounts, quotaFigureShown)) { return ""; }
  return `<p><strong>${escapeHtml(localize("accountBudgets.title"))}</strong><br/>${accounts.map(renderAccountBudgetRowHtml).join("")}</p>`;
}

/** The "API-driven budget" hint under the Monthly Budget input; empty without a premium quota. */
function renderApiBudgetHintHtml(quota: QuotaEntitlements | undefined): string {
  if (!quota || !quota.premium_interactions) { return ""; }
  // The amount is bold, so it is substituted after escaping via a sentinel the translation cannot contain.
  const sentinel = "\u0000";
  const body = escapeHtml(localizeFormat("diagnostics.apiBudgetHint.body", sentinel))
    .replace(sentinel, `<strong>$${quota.premium_interactions.toFixed(2)}</strong>`);
  return `<p class="hint" style="color: #90ee90;"><strong>${escapeHtml(localize("diagnostics.apiBudgetHint.label"))}</strong> ${body}</p>`;
}

function renderQuotaCardHtml(data: Pick<DiagnosticsData, 'quotaEntitlements' | 'accountBudgets'>): string {
  quotaFigureShown = !!data.quotaEntitlements?.premium_interactions;
  const quotaContent = data.quotaEntitlements
    ? `<p>
${
      data.quotaEntitlements.premium_interactions
        ? `<strong>Premium Interactions:</strong> $${data.quotaEntitlements.premium_interactions.toFixed(2)}/month<br/>`
        : ''
}${
      data.quotaEntitlements.completions
        ? `<strong>Completions:</strong> $${data.quotaEntitlements.completions.toFixed(2)}/month<br/>`
        : ''
}
    </p>`
    : `<p class="hint">No quota information available from the API yet. Sign out and back in to refresh.</p>`;
  return `<div class="backend-card" id="diag-quota-card">
<h4>📊 API Quota Information</h4>
${quotaContent}
<div id="diag-account-budgets">${renderAccountBudgetsHtml(data.accountBudgets)}</div>
</div>`;
}

function renderEditorDiscoveryCardHtml(): string {
  return `<div class="backend-card">
<h4>🆕 Editor Discovery Notifications</h4>
<p>
The extension remembers which editors it has already seen so each editor triggers a discovery notification only once.
Use this reset to clear that memory and start tracking from scratch.
</p>
<div class="button-group">
<button class="button secondary" id="btn-reset-discovered-editors">
<span>♻️</span>
<span>Reset Discovered Editors</span>
</button>
</div>
</div>`;
}

function renderDiagDisplayTabHtml(data: DiagnosticsData): string {
  const showTokens = data.displaySettings?.showTokens ?? 'both';
  const showCost = data.displaySettings?.showCost ?? 'none';
  const monthlyBudget = Math.round((data.displaySettings?.monthlyBudget ?? 0) * 100) / 100;
  return `
<div id="tab-display" class="tab-content">
<div class="info-box">
<div class="info-box-title">⚙️ Display Settings</div>
<div>Configure what is shown in the status bar at the bottom of VS Code. Changes take effect immediately — no data refresh needed.</div>
</div>
<div class="backend-card">
<h4>📊 Status Bar Display</h4>
<p>
Choose what to show in the VS Code status bar toolbar. You can show token counts, estimated costs, both, or neither for each period.
</p>
<div style="display: grid; gap: 16px;">
<div style="display: flex; align-items: center; gap: 12px;">
  <label style="min-width: 175px; font-size: 13px;">🔢 Token counts:</label>
  <select id="select-show-tokens" class="settings-select" style="background: #2d2d2d; color: #ccc; border: 1px solid #555; border-radius: 4px; padding: 4px 8px; font-size: 13px;">
    <option value="none" ${sel(showTokens, 'none')}>None</option>
    <option value="today" ${sel(showTokens, 'today')}>Today only</option>
    <option value="last30days" ${sel(showTokens, 'last30days')}>Last 30 days only</option>
    <option value="currentMonth" ${sel(showTokens, 'currentMonth')}>Current calendar month only</option>
    <option value="both" ${sel(showTokens, 'both')}>Today + last 30 days (default)</option>
    <option value="todayAndCurrentMonth" ${sel(showTokens, 'todayAndCurrentMonth')}>Today + current calendar month</option>
  </select>
</div>
<div style="display: flex; align-items: center; gap: 12px;">
  <label style="min-width: 175px; font-size: 13px;">💰 Estimated cost (USD):</label>
  <select id="select-show-cost" class="settings-select" style="background: #2d2d2d; color: #ccc; border: 1px solid #555; border-radius: 4px; padding: 4px 8px; font-size: 13px;">
    <option value="none" ${sel(showCost, 'none')}>None (hidden)</option>
    <option value="today" ${sel(showCost, 'today')}>Today only</option>
    <option value="last30days" ${sel(showCost, 'last30days')}>Last 30 days only</option>
    <option value="currentMonth" ${sel(showCost, 'currentMonth')}>Current calendar month only</option>
    <option value="both" ${sel(showCost, 'both')}>Today + last 30 days</option>
    <option value="todayAndCurrentMonth" ${sel(showCost, 'todayAndCurrentMonth')}>Today + current calendar month</option>
  </select>
</div>
</div>
<p class="hint">Cost is estimated using GitHub Copilot AI-Credit rates (Usage Based Billing). Changes apply to the status bar immediately.</p>
</div>
<div class="backend-card">
<h4>💰 Monthly Budget</h4>
<p>
Set a monthly AI spend budget in USD to get visual alerts on the status bar. The bar turns yellow at 75%, orange at 90%, and red at 100% of your budget. Set to 0 to disable.
</p>
<div style="display: flex; align-items: center; gap: 12px;">
  <label style="min-width: 175px; font-size: 13px;">💵 Monthly budget (USD):</label>
  <input id="input-monthly-budget" type="number" min="0" max="99999" step="0.01" value="${monthlyBudget}" style="background: #2d2d2d; color: #ccc; border: 1px solid #555; border-radius: 4px; padding: 4px 8px; font-size: 13px; width: 100px;" />
</div>
<p class="hint">Budget coloring uses the current calendar month's estimated cost. Set to 0 to disable.</p>
<div id="diag-api-budget-hint">${renderApiBudgetHintHtml(data.quotaEntitlements)}</div>
</div>
${renderQuotaCardHtml(data)}
${renderEditorDiscoveryCardHtml()}
<div class="backend-card">
<h4>🔢 Number Formatting</h4>
<p>
Token counts can be shown in compact format using K/M suffixes (e.g. <strong>1.5K</strong>, <strong>1.2M</strong>)
for quick scanning, or as full numbers (e.g. <strong>1,500</strong>, <strong>1,200,000</strong>) for precision.
</p>
<div class="button-group">
<button class="button" id="btn-open-display-settings">
<span>⚙️</span>
<span>Open Display Settings</span>
</button>
</div>
</div>
</div>`;
}

type ToolAnalysisRow = { tool: string; totalTokens: number; calls: number; isBuiltIn: boolean };

/** Compute pooled avg tokens/call across a set of rows (built-in baseline). Returns NaN if no data. */
function pooledAvg(rows: ToolAnalysisRow[]): number {
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
  return totalCalls > 0 ? totalTokens / totalCalls : NaN;
}

function toolAvgTokens(r: ToolAnalysisRow): number {
  return r.calls > 0 ? r.totalTokens / r.calls : 0;
}

/** An alternative tool's avg tokens/call relative to the family's built-in baseline, or null when not comparable. */
function toolBaselineRatio(r: ToolAnalysisRow, builtInBaseline: number): number | null {
  if (r.isBuiltIn || isNaN(builtInBaseline) || builtInBaseline <= 0 || r.calls <= 0) { return null; }
  return toolAvgTokens(r) / builtInBaseline;
}

function toolRatioClass(r: ToolAnalysisRow, builtInBaseline: number): string | undefined {
  if (r.isBuiltIn) { return "tool-builtin-label"; }
  const ratio = toolBaselineRatio(r, builtInBaseline);
  if (ratio === null) { return undefined; }
  return ratio < 0.85 ? "ratio-better" : ratio > 1.15 ? "ratio-worse" : "ratio-neutral";
}

function renderToolRatioCell(r: ToolAnalysisRow, builtInBaseline: number): string {
  if (r.isBuiltIn) { return "baseline"; }
  const ratio = toolBaselineRatio(r, builtInBaseline);
  if (ratio === null) { return "—"; }
  const pct = Number(Math.round(ratio * 100)) || 0;
  return `<span title="${pct}% of built-in average">${pct}%</span>`;
}

function buildToolAnalysisColumns(builtInBaseline: number): DataTableColumn<ToolAnalysisRow>[] {
  return [
    {
      id: "tool",
      label: "Tool",
      sortValue: (r) => r.tool,
      render: (r) => {
        const badge = r.isBuiltIn ? ' <span class="tool-type-badge built-in">built-in</span>' : ' <span class="tool-type-badge alternative">alt</span>';
        return { html: `${escapeHtml(r.tool)}${badge}` };
      },
    },
    { id: "calls", label: "Calls", align: "right", sortValue: (r) => r.calls, render: (r) => String(r.calls) },
    { id: "total", label: "Total Output Tokens", align: "right", sortValue: (r) => r.totalTokens, render: (r) => formatTokenCount(r.totalTokens) },
    { id: "avg", label: "Avg Tokens / Call", align: "right", sortValue: toolAvgTokens, render: (r) => formatTokenCount(Math.round(toolAvgTokens(r))) },
    {
      id: "ratio",
      label: "vs Built-in",
      align: "right",
      className: "tool-ratio",
      sortValue: (r) => toolBaselineRatio(r, builtInBaseline),
      cellClassName: (r) => toolRatioClass(r, builtInBaseline),
      render: (r) => ({ html: renderToolRatioCell(r, builtInBaseline) }),
    },
  ];
}

/** One sortable, paged table per tool family; each keeps its own sort and page. */
function renderToolAnalysisTable(tableId: string, ariaLabel: string, rows: ToolAnalysisRow[], builtInBaseline: number): string {
  return renderDataTable({
    tableId,
    ariaLabel,
    rows,
    columns: buildToolAnalysisColumns(builtInBaseline),
    initialSort: { columnId: "avg", direction: "desc" },
    className: "tool-analysis-table",
  });
}

/** Render one family section. Returns empty string if the family has no data. */
function renderToolFamilySection(
  family: ToolFamilyConfig,
  outputTokensByTool: { [key: string]: number },
  byTool: { [key: string]: number },
  assignedTools: Set<string>
): { html: string; rows: ToolAnalysisRow[] } {
  const buildRows = (names: string[], isBuiltIn: boolean): ToolAnalysisRow[] =>
    names
      .filter(t => outputTokensByTool[t] !== undefined && (byTool[t] || 0) > 0 && !assignedTools.has(t))
      .map(t => { assignedTools.add(t); return { tool: t, totalTokens: outputTokensByTool[t], calls: byTool[t] || 0, isBuiltIn }; });

  const builtInRows = buildRows(family.builtIn, true);
  const altRows = buildRows(family.alternatives, false);
  const allRows = [...builtInRows, ...altRows];
  if (allRows.length === 0) { return { html: '', rows: [] }; }

  const baseline = pooledAvg(builtInRows);
  const desc = family.description ? ` <span class="hint">${escapeHtml(family.description)}</span>` : '';
  const html = `
<div class="tool-family-section">
<h4 class="tool-family-heading">${escapeHtml(family.name)}${desc}</h4>
${renderToolAnalysisTable(`diagnostics-tool-family-${family.id}`, family.name, allRows, baseline)}
</div>`;
  return { html, rows: allRows };
}

function renderToolAnalysisTab(toolCallStats: DiagnosticsData['toolCallStats'], families?: ToolFamilyConfig[]): string {
  if (!toolCallStats || !toolCallStats.outputTokensByTool || Object.keys(toolCallStats.outputTokensByTool).length === 0) {
    return `<div id="tab-tool-analysis" class="tab-content">
<div class="info-box">
<div class="info-box-title">🔧 Tool Output Token Analysis</div>
<div>Track how many tokens each tool produces as output over the last 30 days. Data is collected as you use the extension — no output token data has been recorded yet.</div>
</div>
</div>`;
  }
  const outputTokensByTool = toolCallStats.outputTokensByTool;
  const byTool = toolCallStats.byTool;
  const assignedTools = new Set<string>();
  let sectionsHtml = '';

  if (families && families.length > 0) {
    for (const family of families) {
      const { html } = renderToolFamilySection(family, outputTokensByTool, byTool, assignedTools);
      sectionsHtml += html;
    }
  }

  // Remaining tools not in any family
  const otherRows: ToolAnalysisRow[] = Object.entries(outputTokensByTool)
    .filter(([t]) => !assignedTools.has(t) && (byTool[t] || 0) > 0)
    .map(([t, tokens]) => ({ tool: t, totalTokens: tokens, calls: byTool[t] || 0, isBuiltIn: false }));
  if (otherRows.length > 0) {
    sectionsHtml += `
<div class="tool-family-section">
<h4 class="tool-family-heading">Other Tools</h4>
${renderToolAnalysisTable("diagnostics-tool-other", "Other Tools", otherRows, NaN)}
</div>`;
  }

  return `<div id="tab-tool-analysis" class="tab-content">
<div class="info-box">
<div class="info-box-title">🔧 Tool Output Token Analysis</div>
<div>Tokens produced by each tool's output over the last 30 days. Tools are grouped by family. <strong>vs Built-in</strong> shows how an alternative compares to the pooled baseline — green is more token-efficient. Click column headers to sort within each group. <button class="inline-link" id="btn-open-tool-families-settings">Configure tool families ↗</button></div>
</div>
${sectionsHtml}
</div>`;
}

/** Sum every editor's count for one skill's byEditor map. */
function _sumSkillEditorCounts(byEditor: { [editorSource: string]: number } | undefined): number {
  return Object.values(byEditor ?? {}).reduce((s, n) => s + n, 0);
}

/** Build the "All" + per-editor filter chip row, with each chip's own total invocation count. */
function _renderSkillUsageFilterPanel(
  skillCallsByEditor: DiagnosticsData['skillCallsByEditor'],
  totalAll: number,
  activeFilter: string
): string {
  const editorTotals = new Map<string, number>();
  for (const byEditor of Object.values(skillCallsByEditor ?? {})) {
    for (const [editor, count] of Object.entries(byEditor)) {
      editorTotals.set(editor, (editorTotals.get(editor) ?? 0) + count);
    }
  }
  const editors = [...editorTotals.entries()].sort((a, b) => b[1] - a[1]);
  if (editors.length === 0) { return ''; }
  const allChip = `<button class="skill-usage-chip${activeFilter === 'all' ? ' active' : ''}" data-editor="all">All <span class="skill-usage-chip-count">${formatTokenCount(totalAll)}</span></button>`;
  const editorChips = editors.map(([editor, count]) =>
    `<button class="skill-usage-chip${activeFilter === editor ? ' active' : ''}" data-editor="${escapeHtml(editor)}">${escapeHtml(editor)} <span class="skill-usage-chip-count">${formatTokenCount(count)}</span></button>`
  ).join('');
  return `<div class="skill-usage-filter-panel">${allChip}${editorChips}</div>`;
}

type SkillUsageRow = { name: string; count: number; description: string };

const SKILL_USAGE_TABLE_ID = "diagnostics-skill-usage";

const SKILL_USAGE_COLUMNS: DataTableColumn<SkillUsageRow>[] = [
  { id: "skill", label: "Skill", sortValue: (r) => r.name, render: (r) => r.name },
  {
    id: "description",
    label: "Description",
    sortValue: (r) => r.description || null,
    cellClassName: () => "skill-usage-description",
    render: (r) => ({ html: r.description ? escapeHtml(r.description) : '<span class="hint">—</span>' }),
  },
  { id: "invocations", label: "Invocations", align: "right", sortValue: (r) => r.count, render: (r) => formatTokenCount(r.count) },
];

/**
 * Renders per-skill invocation counts (e.g. Claude Code's `/graphify`, custom SKILL.md
 * workflows) over the last 30 days, filterable by editor. Adapter-agnostic by design —
 * populated only for editors whose session logs expose a distinguishable skill name
 * (currently Claude Code, Claude Desktop, and Copilot CLI); other editors show the empty
 * state until their format is mapped.
 */
function renderSkillUsageTab(
  skillCallStats: DiagnosticsData['skillCallStats'],
  skillCallsByEditor: DiagnosticsData['skillCallsByEditor'],
  skillDescriptions: DiagnosticsData['skillDescriptions'],
  editorFilter: string = 'all'
): string {
  const byName = skillCallStats?.byName ?? {};
  if (Object.keys(byName).length === 0) {
    return `<div id="tab-skill-usage" class="tab-content">
<div class="info-box">
<div class="info-box-title">🧩 Skill Usage</div>
<div>Tracks how often each agent skill (e.g. a <code>/skill-name</code> invocation or another editor's <code>SKILL.md</code> workflow) was invoked over the last 30 days. No skill invocations have been recorded yet. Skill usage is currently detected for Claude Code, Claude Desktop, and Copilot CLI sessions — support for other editors depends on whether their session logs expose a distinguishable skill name.</div>
</div>
</div>`;
  }
  const totalAll = Object.values(byName).reduce((s, n) => s + n, 0);
  const filterPanel = _renderSkillUsageFilterPanel(skillCallsByEditor, totalAll, editorFilter);
  const rows = Object.keys(byName)
    .map(name => ({
      name,
      count: editorFilter === 'all' ? byName[name] : (skillCallsByEditor?.[name]?.[editorFilter] ?? 0),
      description: skillDescriptions?.[name] ?? '',
    }))
    .filter(r => r.count > 0);
  const shownTotal = rows.reduce((s, r) => s + r.count, 0);
  const table = renderDataTable({
    tableId: SKILL_USAGE_TABLE_ID,
    ariaLabel: "Skill Usage",
    rows,
    columns: SKILL_USAGE_COLUMNS,
    initialSort: { columnId: "invocations", direction: "desc" },
    className: "skill-usage-table",
  });
  const scopeLabel = editorFilter === 'all' ? 'across all editors' : `for ${escapeHtml(editorFilter)}`;
  return `<div id="tab-skill-usage" class="tab-content">
<div class="info-box">
<div class="info-box-title">🧩 Skill Usage</div>
<div>${formatTokenCount(shownTotal)} skill invocation(s) across ${rows.length} skill(s) ${scopeLabel} in the last 30 days. Currently detected for Claude Code / Claude Desktop / Copilot CLI sessions.</div>
</div>
${filterPanel}
${table}
</div>`;
}

function renderOtelDeltaSetupNotice(comparison: CopilotCliOtelComparison | null | undefined): string {
  if (comparison === undefined) {
    return `<div class="info-box">
<div class="info-box-title">📡 Copilot CLI OpenTelemetry Detection Running</div>
<div>
Detecting Copilot CLI OpenTelemetry export data…<br/><br/>
This check compares this extension's estimated token counts against exact counts from local OTel export files.
</div>
</div>`;
  }
  if (comparison && comparison.otelSessionsIndexed > 0) { return ''; }
  const dirStatus = comparison?.otelDirExists
    ? `The export directory exists but no session data has been indexed from it yet (${Number(comparison.otelFileCount)} file(s) found).`
    : `No <code>~/.copilot/otel</code> directory was found — the export isn't enabled yet.`;
  return `<div class="info-box">
<div class="info-box-title">📡 Copilot CLI OpenTelemetry Export Not Detected</div>
<div>
${dirStatus} Enabling it lets this extension read <strong>exact</strong> token counts (input, output, cache) straight from Copilot CLI instead of estimating them from ratios.<br/><br/>
Set these three environment variables before starting a Copilot CLI session, then run a session and reopen this tab:
<pre style="margin-top:8px;">COPILOT_OTEL_ENABLED=true
COPILOT_OTEL_EXPORTER_TYPE=file
COPILOT_OTEL_FILE_EXPORTER_PATH=~/.copilot/otel/copilot-otel.jsonl</pre>
See <code>docs/COPILOT-CLI-OTEL-EXPORT.md</code> in the repo for full setup steps (Windows/PowerShell and Unix shells) and how to verify it's working.
</div>
</div>`;
}

/** Formats a signed token delta as e.g. "+12.3K" / "-4.0K" / "0", with a class for coloring. */
function formatTokenDelta(rawDelta: number): { text: string; cssClass: string } {
  const delta = Number(rawDelta) || 0;
  if (delta === 0) { return { text: '0', cssClass: '' }; }
  const sign = delta > 0 ? '+' : '-';
  const cssClass = delta > 0 ? 'otel-delta-positive' : 'otel-delta-negative';
  return { text: `${sign}${formatTokenCount(Math.abs(delta))}`, cssClass };
}

/** Local (not UTC) start-of-day, for comparing a session's lastActivity against "today"/"yesterday". */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function otelSessionMatchesPeriod(lastActivity: string | null, period: OtelDeltaPeriod, now: Date): boolean {
  if (period === "all") { return true; }
  if (!lastActivity) { return false; }
  const activity = new Date(lastActivity);
  if (Number.isNaN(activity.getTime())) { return false; }
  const today = startOfLocalDay(now);
  const activityDay = startOfLocalDay(activity);
  if (period === "today") { return activityDay.getTime() === today.getTime(); }
  if (period === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return activityDay.getTime() === yesterday.getTime();
  }
  if (period === "week") {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6); // rolling 7 days including today
    return activity >= weekStart && activity <= now;
  }
  // month: current calendar month to date
  return activity.getFullYear() === now.getFullYear() && activity.getMonth() === now.getMonth() && activity <= now;
}

/** Filters an OTel comparison to sessions matching the given period, recomputing the aggregate totals from the subset. */
function filterOtelComparisonByPeriod(comparison: CopilotCliOtelComparison, period: OtelDeltaPeriod): CopilotCliOtelComparison {
  if (period === "all") { return comparison; }
  const now = new Date();
  const sessions = comparison.sessions.filter(s => otelSessionMatchesPeriod(s.lastActivity, period, now));
  const totalBaselineTokens = sessions.reduce((sum, s) => sum + s.baselineTokens, 0);
  const totalOtelTokens = sessions.reduce((sum, s) => sum + s.otelTokens, 0);
  return {
    ...comparison,
    sessions,
    sessionsMatched: sessions.length,
    totalBaselineTokens,
    totalOtelTokens,
    deltaTokens: totalOtelTokens - totalBaselineTokens,
  };
}

const OTEL_DELTA_PERIOD_LABELS: Record<OtelDeltaPeriod, string> = {
  all: "All Time", today: "Today", yesterday: "Yesterday", week: "This Week", month: "This Month",
};

function renderOtelDeltaPeriodSelector(period: OtelDeltaPeriod): string {
  const options = (Object.keys(OTEL_DELTA_PERIOD_LABELS) as OtelDeltaPeriod[])
    .map(p => `<option value="${p}"${p === period ? ' selected' : ''}>${OTEL_DELTA_PERIOD_LABELS[p]}</option>`)
    .join('');
  return `<div class="otel-delta-period-row">
<label for="otel-delta-period">Show:</label>
<select id="otel-delta-period" class="otel-delta-period-select">${options}</select>
</div>`;
}

function renderOtelDeltaSummaryCards(comparison: CopilotCliOtelComparison): string {
  const delta = formatTokenDelta(comparison.deltaTokens);
  const sessionsMatched = Number(comparison.sessionsMatched) || 0;
  const totalBaselineTokens = Number(comparison.totalBaselineTokens) || 0;
  const totalOtelTokens = Number(comparison.totalOtelTokens) || 0;
  const deltaTokens = Number(comparison.deltaTokens) || 0;
  return `<div class="summary-cards">
<div class="summary-card">
<div class="summary-label">📡 Sessions With OTel Data</div>
<div class="summary-value">${sessionsMatched.toLocaleString()}</div>
</div>
<div class="summary-card">
<div class="summary-label">📊 Previous Estimate (Total)</div>
<div class="summary-value" title="${totalBaselineTokens.toLocaleString()} tokens">${formatTokenCount(totalBaselineTokens)}</div>
</div>
<div class="summary-card">
<div class="summary-label">🎯 OTel Exact (Total)</div>
<div class="summary-value" title="${totalOtelTokens.toLocaleString()} tokens">${formatTokenCount(totalOtelTokens)}</div>
</div>
<div class="summary-card">
<div class="summary-label">Δ Delta</div>
<div class="summary-value ${delta.cssClass}" title="${deltaTokens.toLocaleString()} tokens">${delta.text}</div>
</div>
</div>`;
}

const OTEL_DELTA_TABLE_ID = "diagnostics-otel-delta";

function otelSessionModels(s: CopilotCliOtelComparisonSession): string {
  return (Array.isArray(s.models) ? s.models : []).map(m => String(m)).join(', ') || '—';
}

function otelTokenColumn(id: string, label: string, value: (s: CopilotCliOtelComparisonSession) => number): DataTableColumn<CopilotCliOtelComparisonSession> {
  return {
    id,
    label,
    align: "right",
    sortValue: value,
    render: (s) => ({ html: `<span title="${value(s).toLocaleString()} tokens">${formatTokenCount(value(s))}</span>` }),
  };
}

const OTEL_DELTA_COLUMNS: DataTableColumn<CopilotCliOtelComparisonSession>[] = [
  {
    id: "session",
    label: "Session",
    sortValue: (s) => String(s.sessionId ?? ''),
    render: (s) => ({ html: `<code title="${escapeHtml(String(s.sessionId ?? ''))}">${escapeHtml(String(s.sessionId ?? '').slice(0, 8))}</code>` }),
  },
  { id: "models", label: "Model(s)", sortValue: otelSessionModels, render: otelSessionModels },
  otelTokenColumn("baseline", "Previous Estimate", (s) => Number(s.baselineTokens) || 0),
  otelTokenColumn("otel", "OTel Exact", (s) => Number(s.otelTokens) || 0),
  {
    id: "delta",
    label: "Delta",
    align: "right",
    sortValue: (s) => Number(s.delta) || 0,
    cellClassName: (s) => formatTokenDelta(s.delta).cssClass || undefined,
    render: (s) => ({ html: `<span title="${(Number(s.delta) || 0).toLocaleString()} tokens">${formatTokenDelta(s.delta).text}</span>` }),
  },
];

function renderOtelDeltaSessionTable(sessions: CopilotCliOtelComparisonSession[]): string {
  return renderDataTable({
    tableId: OTEL_DELTA_TABLE_ID,
    ariaLabel: "OTel vs. Estimated Token Counts",
    rows: sessions,
    columns: OTEL_DELTA_COLUMNS,
  });
}

function renderOtelDeltaTab(comparison: CopilotCliOtelComparison | null | undefined, period: OtelDeltaPeriod = currentOtelDeltaPeriod): string {
  const setupNotice = renderOtelDeltaSetupNotice(comparison);
  if (!comparison || comparison.sessionsMatched === 0) {
    return `<div id="tab-otel-delta" class="tab-content">
<div class="info-box">
<div class="info-box-title">📡 OTel vs. Estimated Token Counts</div>
<div>Compares the token counts this extension estimates for Copilot CLI sessions against exact counts read from Copilot CLI's OpenTelemetry export, when available.</div>
</div>
${setupNotice}
</div>`;
  }
  const filtered = filterOtelComparisonByPeriod(comparison, period);
  const tableOrEmpty = filtered.sessions.length > 0
    ? renderOtelDeltaSessionTable(filtered.sessions)
    : `<div class="info-box">No Copilot CLI sessions with OTel data in this period. Try a wider range.</div>`;
  return `<div id="tab-otel-delta" class="tab-content">
<div class="info-box">
<div class="info-box-title">📡 OTel vs. Estimated Token Counts</div>
<div>
Compares the token counts this extension would normally estimate for each Copilot CLI session against the exact counts read from Copilot CLI's OpenTelemetry file export. A positive delta means OTel revealed usage the estimate missed entirely (e.g. chat-only sessions, which previously reported 0 tokens); near-zero deltas mean the estimate already had exact numbers from a session.shutdown event.<br/>
Checked ${(Number(comparison.sessionsChecked) || 0).toLocaleString()} Copilot CLI session(s) found locally; ${(Number(comparison.otelSessionsIndexed) || 0).toLocaleString()} session(s) are present in the OTel export.
</div>
</div>
${setupNotice}
${renderOtelDeltaPeriodSelector(period)}
${renderOtelDeltaSummaryCards(filtered)}
${tableOrEmpty}
</div>`;
}

// --- TTFT (time to first token) tab -----------------------------------------------------

type TtftBucketView = { key: string; label: string; avgSeconds: number; count: number };
type TtftModelSeriesView = { model: string; data: (number | null)[] };

const TTFT_GRANULARITY_LABELS: Record<TtftGranularity, string> = { day: "Day", week: "Week", month: "Month" };
const TTFT_SCAN_RANGE_LABELS: Record<TtftScanRange, string> = {
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "180d": "Last 6 months",
  "365d": "Last year",
  "all": "All time",
};

/** Values arrive already normalized to seconds (see extractTtftSamplesFromDebugLog); this only picks the more readable unit for display. */
function formatTtftSeconds(seconds: number): string {
  return seconds >= 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`;
}

function renderTtftGranularitySelector(granularity: TtftGranularity): string {
  const options = (Object.keys(TTFT_GRANULARITY_LABELS) as TtftGranularity[])
    .map(g => `<option value="${g}"${g === granularity ? ' selected' : ''}>${TTFT_GRANULARITY_LABELS[g]}</option>`)
    .join('');
  return `<div class="otel-delta-period-row">
<label for="ttft-granularity">Bucket by:</label>
<select id="ttft-granularity" class="otel-delta-period-select">${options}</select>
</div>`;
}

function renderTtftScanRangeSelector(range: TtftScanRange): string {
  const options = (Object.keys(TTFT_SCAN_RANGE_LABELS) as TtftScanRange[])
    .map(r => `<option value="${r}"${r === range ? ' selected' : ''}>${TTFT_SCAN_RANGE_LABELS[r]}</option>`)
    .join('');
  return `<div class="otel-delta-period-row">
<label for="ttft-scan-range">Scan session files from:</label>
<select id="ttft-scan-range" class="otel-delta-period-select">${options}</select>
</div>`;
}

const TTFT_CHART_WIDTH = 760;
const TTFT_CHART_HEIGHT = 220;
const TTFT_CHART_PAD_LEFT = 48;
const TTFT_CHART_PAD_RIGHT = 32;
const TTFT_CHART_PAD_TOP = 12;
const TTFT_CHART_PAD_BOTTOM = 28;

/** Renders one SVG line chart with one path per model series, breaking the line across buckets where a model has no samples (null) rather than interpolating over the gap. */
function renderTtftChartSvg(buckets: TtftBucketView[], series: TtftModelSeriesView[]): string {
  if (buckets.length === 0 || series.length === 0) { return ''; }
  const innerW = TTFT_CHART_WIDTH - TTFT_CHART_PAD_LEFT - TTFT_CHART_PAD_RIGHT;
  const innerH = TTFT_CHART_HEIGHT - TTFT_CHART_PAD_TOP - TTFT_CHART_PAD_BOTTOM;
  const allValues = series.flatMap(s => s.data.filter((v): v is number => v !== null));
  const maxValue = allValues.length > 0 ? Math.max(...allValues) : 1;
  const yMax = (maxValue || 1) * 1.15;
  const xStep = buckets.length > 1 ? innerW / (buckets.length - 1) : 0;
  const xAt = (i: number) => TTFT_CHART_PAD_LEFT + i * xStep;
  const yAt = (v: number) => TTFT_CHART_PAD_TOP + innerH - (v / yMax) * innerH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const value = yMax * f;
    const y = yAt(value);
    return `<line x1="${TTFT_CHART_PAD_LEFT}" y1="${y.toFixed(1)}" x2="${TTFT_CHART_WIDTH - TTFT_CHART_PAD_RIGHT}" y2="${y.toFixed(1)}" class="ttft-gridline" />
<text x="${TTFT_CHART_PAD_LEFT - 6}" y="${(y + 3).toFixed(1)}" class="ttft-axis-label" text-anchor="end">${escapeHtml(formatTtftSeconds(value))}</text>`;
  }).join('');

  // Thin out x-axis labels so they don't overlap when there are many buckets. The first/last
  // labels are anchored inward (start/end instead of middle) so they render within the
  // viewBox instead of overflowing past its edges and getting clipped.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const xLabels = buckets.map((b, i) => {
    if (i % labelEvery !== 0 && i !== buckets.length - 1) { return ''; }
    const anchor = i === buckets.length - 1 ? 'end' : i === 0 ? 'start' : 'middle';
    return `<text x="${xAt(i).toFixed(1)}" y="${TTFT_CHART_HEIGHT - 8}" class="ttft-axis-label" text-anchor="${anchor}">${escapeHtml(b.label)}</text>`;
  }).join('');

  const paths = series.map((s, idx) => {
    const color = getModelColor(idx);
    let d = '';
    let drawing = false;
    s.data.forEach((v, i) => {
      if (v === null) { drawing = false; return; }
      const x = xAt(i).toFixed(1);
      const y = yAt(v).toFixed(1);
      d += drawing ? ` L ${x} ${y}` : `${d ? ' ' : ''}M ${x} ${y}`;
      drawing = true;
    });
    const dots = s.data.map((v, i) => v === null ? '' : `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="2.5" fill="${color.border}" />`).join('');
    return `<g class="ttft-series" data-model="${escapeHtml(s.model)}"><path d="${d}" fill="none" stroke="${color.border}" stroke-width="2" />${dots}</g>`;
  }).join('');

  const legend = series.map((s, idx) => {
    const color = getModelColor(idx);
    const name = escapeHtml(getModelDisplayName(s.model));
    return `<span class="ttft-legend-item" data-model="${escapeHtml(s.model)}" role="button" tabindex="0" aria-pressed="false" title="Click to hide/show ${name}"><span class="ttft-legend-swatch" style="background:${color.border}"></span>${name}</span>`;
  }).join('');

  return `<div class="ttft-chart-wrap">
<svg viewBox="0 0 ${TTFT_CHART_WIDTH} ${TTFT_CHART_HEIGHT}" class="ttft-chart" role="img" aria-label="Average time to first token per model over time">
${yTicks}
${xLabels}
${paths}
</svg>
<div class="ttft-legend">${legend}</div>
</div>`;
}

const TTFT_BUCKET_TABLE_ID = "diagnostics-ttft-buckets";

/** Newest bucket first. */
function renderTtftBucketTable(granularity: TtftGranularity, buckets: TtftBucketView[]): string {
  setDataTableState(TTFT_BUCKET_TABLE_ID, { page: 1 });
  return renderDataTable({
    tableId: TTFT_BUCKET_TABLE_ID,
    ariaLabel: "Time to First Token",
    rows: buckets.slice().reverse(),
    columns: [
      { id: "bucket", label: TTFT_GRANULARITY_LABELS[granularity], sortValue: (b) => b.key, render: (b) => b.label },
      { id: "avg", label: "Avg TTFT", align: "right", sortValue: (b) => b.avgSeconds, render: (b) => formatTtftSeconds(b.avgSeconds) },
      { id: "samples", label: "Samples", align: "right", sortValue: (b) => b.count, render: (b) => b.count.toLocaleString() },
    ],
  });
}

function renderTtftResults(granularity: TtftGranularity, buckets: TtftBucketView[], series: TtftModelSeriesView[], sampleCount: number, fileCount: number): string {
  if (sampleCount === 0) {
    return `<div class="info-box">
<div class="info-box-title">📭 No TTFT data found</div>
<div>
Checked ${fileCount.toLocaleString()} session file(s) in the selected range; none had a debug log
with a populated <code>attrs.ttft</code>. Try widening "Scan session files from" above, but also
check VS Code's <b>GitHub › Copilot › Chat › Agent Debug Log › File Logging: Enabled</b> setting
(Experimental) — it's off by default, and this data only exists for sessions that ran while it
was on (a window reload is needed after enabling it).
</div>
</div>`;
  }
  const overallAvg = buckets.reduce((sum, b) => sum + b.avgSeconds * b.count, 0) / Math.max(1, sampleCount);
  return `<div class="summary-cards">
<div class="summary-card">
<div class="summary-label">⏱️ Overall Avg TTFT</div>
<div class="summary-value">${escapeHtml(formatTtftSeconds(overallAvg))}</div>
</div>
<div class="summary-card">
<div class="summary-label">🧩 Models Shown</div>
<div class="summary-value">${series.length}</div>
</div>
<div class="summary-card">
<div class="summary-label">📊 Samples</div>
<div class="summary-value">${sampleCount.toLocaleString()}</div>
</div>
<div class="summary-card">
<div class="summary-label">📄 Session Files Checked</div>
<div class="summary-value">${fileCount.toLocaleString()}</div>
</div>
</div>
${renderTtftChartSvg(buckets, series)}
<div style="margin-top: 12px;">${renderTtftBucketTable(granularity, buckets)}</div>`;
}

function renderTtftTab(): string {
  return `<div id="tab-ttft" class="tab-content">
<div class="info-box">
<div class="info-box-title">⏱️ Time to First Token</div>
<div>
How long a chat model takes to start streaming a response, averaged per model over time.
Read from VS Code Copilot Chat's own debug log (<code>attrs.ttft</code> on <code>llm_request</code>
events) — the same file this extension already reads for exact per-session billing. This only
exists for sessions that ran while VS Code's experimental <b>GitHub › Copilot › Chat › Agent Debug
Log › File Logging: Enabled</b> setting was on (off by default, requires a window reload after
enabling) — nothing in this extension's own settings. The unit isn't documented upstream, so
values are auto-detected as seconds or milliseconds by magnitude.
</div>
</div>
${renderTtftGranularitySelector(currentTtftGranularity)}
${renderTtftScanRangeSelector(currentTtftScanRange)}
<div id="ttft-results"></div>
</div>`;
}

function triggerTtftAnalysis(): void {
  const resultsDiv = document.getElementById("ttft-results");
  if (resultsDiv) {
    setHtml(resultsDiv, `
        <div class="analyzer-loading">
          <span class="spinner" style="width:18px;height:18px;border:2px solid var(--link-color);border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin 0.7s linear infinite;"></span>
          <span>Scanning debug logs for TTFT…</span>
        </div>`);
  }
  vscode.postMessage({ command: "analyzeTtft", granularity: currentTtftGranularity, scanRange: currentTtftScanRange });
}














function setupTtftHandlers(): void {
  document.getElementById("ttft-granularity")?.addEventListener("change", (e) => {
    currentTtftGranularity = (e.target as HTMLSelectElement).value as TtftGranularity;
    diagState.patch({ ttftGranularity: currentTtftGranularity });
    triggerTtftAnalysis();
  });
  document.getElementById("ttft-scan-range")?.addEventListener("change", (e) => {
    currentTtftScanRange = (e.target as HTMLSelectElement).value as TtftScanRange;
    diagState.patch({ ttftScanRange: currentTtftScanRange });
    triggerTtftAnalysis();
  });
  const resultsDiv = document.getElementById("ttft-results");
  const toggleTtftModel = (item: HTMLElement) => {
    const model = item.dataset.model;
    if (!model) { return; }
    const hidden = item.classList.toggle("ttft-hidden");
    item.setAttribute("aria-pressed", String(hidden));
    document.querySelectorAll(".ttft-series").forEach((el) => {
      if ((el as HTMLElement).dataset.model === model) { (el as HTMLElement).classList.toggle("ttft-hidden", hidden); }
    });
  };
  resultsDiv?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement)?.closest(".ttft-legend-item") as HTMLElement | null;
    if (item) { toggleTtftModel(item); }
  });
  resultsDiv?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") { return; }
    const item = (e.target as HTMLElement)?.closest(".ttft-legend-item") as HTMLElement | null;
    if (item) { e.preventDefault(); toggleTtftModel(item); }
  });
}

function handleTtftResult(message: DiagMessage): void {
  const resultsDiv = document.getElementById("ttft-results");
  if (!resultsDiv) { return; }
  if (message.stillLoading) {
    setHtml(resultsDiv, `
        <div class="analyzer-loading">
          <span class="spinner" style="width:18px;height:18px;border:2px solid var(--link-color);border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin 0.7s linear infinite;"></span>
          <span id="ttft-loading-status">Waiting for session files to finish loading…</span>
        </div>`);
    // No manual retry needed: handleSessionFilesLoaded() re-triggers this analysis as soon
    // as the background scan completes, since this results div is now non-empty.
    return;
  }
  setHtml(resultsDiv, renderTtftResults(
    (message.granularity || currentTtftGranularity) as TtftGranularity,
    (message.buckets || []) as TtftBucketView[],
    (message.series || []) as TtftModelSeriesView[],
    Number(message.sampleCount || 0),
    Number(message.fileCount || 0),
  ));
}

function buildDiagReportTabHtml(escapedReport: string): string {
  return `<div id="tab-report" class="tab-content active">
<div class="info-box">
<div class="info-box-title">📋 About This Report</div>
<div>
This diagnostic report contains information about your AI Engineering Fluency extension
extension setup and usage statistics. </br> It does <strong>not</strong> include any of your
code or conversation content. You can safely share this report when reporting issues.
</div>
</div>
<div class="button-group" style="margin-bottom: 12px;">
<button class="button" id="btn-copy"><span>📋</span><span>Copy to Clipboard</span></button>
<button class="button secondary" id="btn-issue"><span>🐛</span><span>Open GitHub Issue</span></button>
<button class="button secondary" id="btn-clear-cache"><span>🗑️</span><span>Clear Cache</span></button>
<button class="button secondary" id="btn-reset-insights"><span>💡</span><span>Reset Insights Dismissals</span></button>
</div>
<div class="report-content">${escapedReport}</div>
</div>`;
}

/** The three group-tab bars (Diagnostics / Research / Settings) atop the diagnostics panel. */
function renderTabBars(data: DiagnosticsData, detailedFiles: SessionFileDetails[]): string {
  return `
<div class="tabs group-tabs">
<button class="group-tab active" data-group="diagnostics">🩺 Diagnostics</button>
<button class="group-tab" data-group="research">🔬 Research</button>
<button class="group-tab" data-group="settings">⚙️ Settings</button>
</div>

<div class="tabs leaf-tabs" data-group="diagnostics" style="display: flex;">
<button class="tab active" data-tab="report">📋 Report</button>
<button class="tab" data-tab="sessions">📁 Session Files (${detailedFiles.length})</button>
<button class="tab" data-tab="cache">💾 Cache</button>
<button class="tab" data-tab="path-analyzer">🔬 Path Analyzer</button>
<button class="tab" data-tab="share">📸 Share Card</button>
</div>

<div class="tabs leaf-tabs" data-group="research" style="display: none;">
<button class="tab" data-tab="model-usage">🧮 Model Usage</button>
<button class="tab" data-tab="tool-analysis">🔧 Tool Analysis</button>
<button class="tab" data-tab="skill-usage">🧩 Skill Usage</button>
<button class="tab" data-tab="otel-delta">📡 OTel Delta</button>
<button class="tab" data-tab="ttft">⏱️ TTFT</button>
</div>

<div class="tabs leaf-tabs" data-group="settings" style="display: none;">
<button class="tab" data-tab="display">⚙️ Display</button>
<button class="tab" data-tab="backend">☁️ Backend Storage</button>
<button class="tab" data-tab="github">🔑 GitHub Auth</button>
${data.isDebugMode ? '<button class="tab" data-tab="debug">🐛 Debug</button>' : ''}
</div>`;
}

function buildDiagRootHtml(
  data: DiagnosticsData,
  detailedFiles: SessionFileDetails[],
  escapedReport: string,
): string {
  return `
<style>${themeStyles}</style><style>${dataTableStyles}</style>
<style>${styles}</style>
<div class="container">
<div class="header">
<div class="header-left">
<span class="header-icon">🔍</span>
<span class="header-title">Diagnostic Report</span>
</div>
<div class="button-row">
${navButtonsHtml("btn-diagnostics", !!data?.backendConfigured)}
</div>
</div>

${renderTabBars(data, detailedFiles)}

${buildDiagReportTabHtml(escapedReport)}

<div id="tab-sessions" class="tab-content">
<div class="info-box"><div class="info-box-title">📁 Session File Analysis</div><div>
This tab shows session files with activity in the last 14 days from all detected editors. </br>
Click on an editor panel to filter, click column headers to sort, and click a file name to open it.
</div></div>
<div id="session-table-container">${renderSessionTable(detailedFiles, detailedFiles.length === 0)}</div>
</div>

${renderDiagCacheTabHtml(data)}
<div id="tab-backend" class="tab-content">
${renderBackendStoragePanel(data.backendStorageInfo, data.githubAuth)}
</div>

<div id="tab-github" class="tab-content">
${renderGitHubAuthPanel(data.githubAuth)}
</div>
${renderDiagDisplayTabHtml(data)}
${data.isDebugMode ? renderDebugTab(data.globalStateCounters) : ''}
<div id="tab-path-analyzer" class="tab-content">
${renderFolderAnalyzerTab()}
</div>
${renderShareCardTab(detailedFiles, isLoading)}
<div id="tab-model-usage" class="tab-content">
${renderModelUsageTab(detailedFiles, isLoading)}
</div>
${renderToolAnalysisTab(data.toolCallStats, data.toolFamilies)}
${renderSkillUsageTab(data.skillCallStats, data.skillCallsByEditor, data.skillDescriptions, skillUsageEditorFilter)}
${renderOtelDeltaTab(data.otelComparison)}
${renderTtftTab()}
</div>
`;
}

/**
 * `backendStorageInfoLoaded` is sent by the host *before* diagnosticDataLoaded (see
 * sendBackendStorageInfoEarly in extension.ts) so the Backend Storage tab can populate before
 * the rest of diagnostics finishes loading. Since the message listener is registered before
 * renderLayout() runs (see setupMessageHandlers() call site), that early message can legitimately
 * arrive first and already have set currentBackendInfo/currentGithubAuth. Prefer that over the
 * (possibly stale/placeholder) value baked into the initial bootstrap payload, so the first paint
 * doesn't silently discard already-received state, and persist the resolved values back to the
 * module-level state so later handlers keep seeing the same data.
 */
function resolveEarlyBackendState(data: DiagnosticsData): Pick<DiagnosticsData, "backendStorageInfo" | "githubAuth"> {
  currentBackendInfo = currentBackendInfo ?? data.backendStorageInfo;
  currentGithubAuth = currentGithubAuth ?? data.githubAuth;
  return { backendStorageInfo: currentBackendInfo, githubAuth: currentGithubAuth };
}

function renderLayout(data: DiagnosticsData): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }

  // Initialise module-level render state
  const detailedFiles = data.detailedSessionFiles || [];
  storedDetailedFiles = detailedFiles;
  isLoading = detailedFiles.length === 0;
  const earlyBackendState = resolveEarlyBackendState(data);
  currentOtelComparison = data.otelComparison;
  if (data.toolFamilies) { storedToolFamilies = data.toolFamilies; }
  currentSkillCallStats = data.skillCallStats;
  currentSkillCallsByEditor = data.skillCallsByEditor;
  currentSkillDescriptions = data.skillDescriptions;

  const reportIsLoading = data.report === LOADING_PLACEHOLDER;
  const escapedReport = reportIsLoading
    ? LOADING_MESSAGE.trim()
    : removeSessionFilesSection(escapeHtml(data.report));

  setHtml(root, buildDiagRootHtml({ ...data, ...earlyBackendState }, detailedFiles, escapedReport));

  // Render session folders via DOM API (XSS-safe, no innerHTML)
  const sessionFolders = groupSessionFolders(data.sessionFolders || []);
  if (sessionFolders.length > 0) {
    const reportTab = document.getElementById("tab-report");
    const reportContent = reportTab?.querySelector(".report-content");
    if (reportContent) {
      reportContent.insertAdjacentElement("afterend", buildSessionFoldersElement(sessionFolders));
    }
  }

  setupTabHandlers();
  setupGroupHandlers();
  setupEditorFilterHandlers();
  setupContextRefFilterHandlers();
  setupZeroInteractionFilterHandler();
  setupUnattributedFilterHandler();
  setupBackendButtonHandlers();
  setupSubtabHandlers();
  setupFileLinks();
  setupStorageLinkHandlers();
  setupGitHubAuthHandlers();
  setupFolderAnalyzerHandlers();
  setupModelUsageHandlers();
  renderModelUsageTimeSelector(isLoading);
  setupButtonHandlers();
  setupDisplaySettingHandlers();
  setupToolAnalysisHandlers();
  setupSkillUsageFilterHandler();
  setupOtelDeltaPeriodHandler();
  setupTtftHandlers();

  restoreActiveTabAndSubtab();
}

/**
 * Applies whichever tab should be active on first render: a `switchTab` request that arrived
 * before renderLayout() ran (see pendingSwitchTabTo's comment) takes priority over whatever tab
 * was last open — it's an explicit, just-now navigation request, not stale persisted state.
 */
function restoreActiveTabAndSubtab(): void {
  const savedState = diagState.restore();
  const requestedTab = pendingSwitchTabTo;
  pendingSwitchTabTo = undefined;
  let restoredTab = "report";
  if (requestedTab && activateTab(requestedTab)) {
    restoredTab = requestedTab;
    diagState.patch({ activeTab: requestedTab });
  } else if (savedState?.activeTab && activateTab(savedState.activeTab)) {
    restoredTab = savedState.activeTab;
  } else {
    activateTab("report");
  }
  activateGroup(groupOfTab(restoredTab));

  if (savedState?.activeSubtab) {
    activateSubtab(savedState.activeSubtab);
  }
}
async function bootstrap(): Promise<void> {
  await import('@vscode-elements/elements/dist/vscode-button/index.js');

  if (!initialData) {
    const root = document.getElementById("root");
    if (root) {
      root.textContent = "No data available.";
    }
    return;
  }
  renderLayout(initialData);
}

// Registered synchronously at module load — NOT inside renderLayout() — so the listener is
// live before bootstrap()'s dynamic import resolves. The host sends `backendStorageInfoLoaded`
// as early as possible (see sendBackendStorageInfoEarly in extension.ts) specifically to beat
// the slower `diagnosticDataLoaded` message; if that early message arrived before the listener
// existed it would be silently dropped (individual handlers are already defensive about a
// missing container/tab, so registering early adds no risk).
setupMessageHandlers();

void bootstrap();
