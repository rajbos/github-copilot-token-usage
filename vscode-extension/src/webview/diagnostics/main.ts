// Diagnostics Report webview with tabbed interface
import { buttonHtml } from "../shared/buttonConfig";
// CSS imported as text via esbuild
import themeStyles from "../shared/theme.css";
import styles from "./styles.css";

// Constants
const LOADING_PLACEHOLDER = "Loading...";
const SESSION_FILES_SECTION_REGEX =
  /Session File Locations \(first 20\):[\s\S]*?(?=\n\s*\n|={70})/;
const LOADING_MESSAGE = `⏳ Loading diagnostic data...

This may take a few moments depending on the number of session files.
The view will automatically update when data is ready.`;

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
  lastSyncTime: string | null;
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
};

type GitHubAuthStatus = {
  authenticated: boolean;
  username?: string;
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
};

type DiagnosticsViewState = {
  activeTab?: string;
  activeSubtab?: string;
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

declare global {
  interface Window {
    __INITIAL_DIAGNOSTICS__?: DiagnosticsData;
  }
}

const vscode = acquireVsCodeApi<DiagnosticsViewState>();
const initialData = window.__INITIAL_DIAGNOSTICS__;

// Sorting and filtering state
let currentSortColumn: "lastInteraction" | "size" | "tokens" | "interactions" | "contextRefs" = "lastInteraction";
let currentSortDirection: "asc" | "desc" = "desc";
let currentEditorFilter: string | null = null; // null = show all
let currentContextRefFilter: keyof ContextReferenceUsage | null = null; // null = show all
let hideEmptySessions = true; // hide sessions with 0 interactions by default

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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

function getTimeSince(isoString: string): string {
  try {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diffMs = now - then;

    if (diffMs < 0) {
      return "Just now";
    }

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} day${days !== 1 ? "s" : ""} ago`;
    }
    if (hours > 0) {
      return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    }
    if (minutes > 0) {
      return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    }
    return `${seconds} second${seconds !== 1 ? "s" : ""} ago`;
  } catch {
    return "Unknown";
  }
}

function formatFileSize(bytes: number): string {
  const numericBytes = Number(bytes);
  if (!Number.isFinite(numericBytes) || numericBytes < 0) {
    // Fallback for unexpected or untrusted values
    return "N/A";
  }
  if (numericBytes < 1024) {
    return `${numericBytes} B`;
  }
  if (numericBytes < 1024 * 1024) {
    return `${(numericBytes / 1024).toFixed(1)} KB`;
  }
  return `${(numericBytes / (1024 * 1024)).toFixed(2)} MB`;
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
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return Math.floor(n).toString();
}

/**
 * Build a DOM element showing all candidate paths the extension considers,
 * with their existence status. Helps users understand why data may be missing.
 */
function buildCandidatePathsElement(
  candidatePaths: { path: string; exists: boolean; source: string }[],
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

  const table = document.createElement("table");
  table.className = "session-table";
  container.appendChild(table);

  const thead = document.createElement("thead");
  table.appendChild(thead);
  const headerRow = document.createElement("tr");
  thead.appendChild(headerRow);
  for (const text of ["Status", "Source", "Path"]) {
    const th = document.createElement("th");
    th.textContent = text;
    headerRow.appendChild(th);
  }

  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  // Show found paths first, then missing paths
  const sorted = [...candidatePaths].sort((a, b) => {
    if (a.exists !== b.exists) {
      return a.exists ? -1 : 1;
    }
    return a.source.localeCompare(b.source);
  });

  // Group all Crush entries into one row; render everything else individually
  const crushEntries = sorted.filter((cp) =>
    cp.source.toLowerCase().includes("crush"),
  );
  const otherEntries = sorted.filter(
    (cp) => !cp.source.toLowerCase().includes("crush"),
  );

  const renderRow = (cp: { path: string; exists: boolean; source: string }) => {
    const row = document.createElement("tr");
    if (!cp.exists) {
      row.style.opacity = "0.5";
    }

    const statusCell = document.createElement("td");
    statusCell.textContent = cp.exists ? "✅" : "❌";
    statusCell.style.textAlign = "center";
    row.appendChild(statusCell);

    const sourceCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = getEditorBadgeClass(cp.source);
    badge.textContent = `${getEditorIcon(cp.source)} ${cp.source}`;
    sourceCell.appendChild(badge);
    row.appendChild(sourceCell);

    const pathCell = document.createElement("td");
    pathCell.setAttribute("title", cp.path);
    pathCell.style.fontFamily = "var(--vscode-editor-font-family, monospace)";
    pathCell.style.fontSize = "12px";
    pathCell.textContent = cp.path;
    row.appendChild(pathCell);

    tbody.appendChild(row);
  };

  for (const cp of otherEntries) {
    renderRow(cp);
  }

  if (crushEntries.length > 0) {
    const anyExist = crushEntries.some((cp) => cp.exists);
    const row = document.createElement("tr");
    if (!anyExist) {
      row.style.opacity = "0.5";
    }

    const statusCell = document.createElement("td");
    statusCell.textContent = anyExist ? "✅" : "❌";
    statusCell.style.textAlign = "center";
    row.appendChild(statusCell);

    const sourceCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = getEditorBadgeClass("Crush");
    badge.textContent = `${getEditorIcon("Crush")} Crush`;
    sourceCell.appendChild(badge);
    row.appendChild(sourceCell);

    const pathCell = document.createElement("td");
    pathCell.style.fontFamily = "var(--vscode-editor-font-family, monospace)";
    pathCell.style.fontSize = "12px";
    pathCell.style.lineHeight = "1.6";
    for (const cp of crushEntries) {
      const line = document.createElement("div");
      line.style.opacity = cp.exists ? "1" : "0.5";
      line.title = cp.path;
      line.textContent = `${cp.exists ? "✅" : "❌"} ${cp.path}`;
      pathCell.appendChild(line);
    }
    row.appendChild(pathCell);

    tbody.appendChild(row);
  }

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
  if (lower.includes("visual studio")) {
    return "editor-badge editor-badge-vs";
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
  if (lower.includes("crush")) {
    return "editor-badge editor-badge-crush";
  }
  return "editor-badge";
}

function getEditorIcon(editor: string): string {
  const lower = editor.toLowerCase();
  if (lower.includes("jetbrains") || lower.includes("rider") || lower.includes("intellij")) {
    return "🟣";
  }
  if (lower.includes("visual studio")) {
    return "🪟";
  }
  if (lower.includes("visual studio")) {
    return "🪟";
  }
  if (lower.includes("mistral")) {
    return "🔥";
  }
  if (lower.includes("crush")) {
    return "🩷";
  }
  if (lower.includes("opencode")) {
    return "🟢";
  }
  if (lower.includes("cursor")) {
    return "🖱️";
  }
  if (lower.includes("insiders")) {
    return "💚";
  }
  if (lower.includes("vscodium")) {
    return "🔵";
  }
  if (lower.includes("windsurf")) {
    return "🏄";
  }
  if (lower.includes("vs code") || lower.includes("vscode")) {
    return "💙";
  }
  return "📝";
}

function sortSessionFiles(files: SessionFileDetails[]): SessionFileDetails[] {
  return [...files].sort((a, b) => {
    let aNum: number;
    let bNum: number;

    if (currentSortColumn === "lastInteraction") {
      const aVal = a.lastInteraction;
      const bVal = b.lastInteraction;
      if (!aVal && !bVal) { return 0; }
      if (!aVal) { return 1; }
      if (!bVal) { return -1; }
      aNum = new Date(aVal).getTime();
      bNum = new Date(bVal).getTime();
    } else if (currentSortColumn === "size") {
      aNum = a.size || 0;
      bNum = b.size || 0;
    } else if (currentSortColumn === "tokens") {
      aNum = a.tokens || 0;
      bNum = b.tokens || 0;
    } else if (currentSortColumn === "interactions") {
      aNum = a.interactions || 0;
      bNum = b.interactions || 0;
    } else if (currentSortColumn === "contextRefs") {
      aNum = getTotalContextRefs(a.contextReferences);
      bNum = getTotalContextRefs(b.contextReferences);
    } else {
      return 0;
    }

    return currentSortDirection === "desc" ? bNum - aNum : aNum - bNum;
  });
}

function getSortIndicator(column: typeof currentSortColumn): string {
  if (currentSortColumn !== column) {
    return "";
  }
  return currentSortDirection === "desc" ? " ▼" : " ▲";
}

function getEditorStats(files: SessionFileDetails[]): {
  [key: string]: { count: number; interactions: number };
} {
  const stats: { [key: string]: { count: number; interactions: number } } = {};
  for (const sf of files) {
    const editor = sf.editorSource || "Unknown";
    if (!stats[editor]) {
      stats[editor] = { count: 0, interactions: 0 };
    }
    stats[editor].count++;
    stats[editor].interactions += sf.interactions;
  }
  return stats;
}

function safeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  // Always convert to string and escape HTML to avoid XSS when inserting into innerHTML.
  return escapeHtml(String(value));
}

function renderSessionTable(
  detailedFiles: SessionFileDetails[],
  isLoading: boolean = false,
): string {
  if (isLoading) {
    return `
			<div class="loading-state">
				<div class="loading-spinner">⏳</div>
				<div class="loading-text">Loading session files...</div>
				<div class="loading-subtext">Analyzing up to 500 files from the last 14 days</div>
			</div>
		`;
  }

  if (detailedFiles.length === 0) {
    return '<p style="color: #999;">No session files with activity in the last 14 days.</p>';
  }

  // Get editor stats for ALL files (before filtering)
  const editorStats = getEditorStats(detailedFiles);
  const editors = Object.keys(editorStats).sort();

  // Apply editor filter
  let filteredFiles = currentEditorFilter
    ? detailedFiles.filter((sf) => sf.editorSource === currentEditorFilter)
    : detailedFiles;

  // Apply context ref filter
  if (currentContextRefFilter) {
    filteredFiles = filteredFiles.filter((sf) => {
      const refType = currentContextRefFilter!; // Assert non-null since we're inside the if block
      const value = sf.contextReferences[refType];
      return typeof value === "number" && value > 0;
    });
  }

  // Count zero-interaction sessions (before hiding them) for the toggle label
  const zeroInteractionCount = filteredFiles.filter(sf => sf.interactions === 0).length;

  // Hide sessions with 0 interactions when filter is active
  if (hideEmptySessions) {
    filteredFiles = filteredFiles.filter(sf => sf.interactions > 0);
  }

  // Summary stats for filtered files
  const totalInteractions = filteredFiles.reduce(
    (sum, sf) => sum + Number(sf.interactions || 0),
    0,
  );
  const totalTokens = filteredFiles.reduce(
    (sum, sf) => sum + Number(sf.tokens || 0),
    0,
  );
  const totalContextRefs = filteredFiles.reduce(
    (sum, sf) => sum + getTotalContextRefs(sf.contextReferences),
    0,
  );

  // Aggregate context ref breakdown
  const aggContextRefs = filteredFiles.reduce(
    (agg, sf) => {
      const r = sf.contextReferences;
      agg.file += r.file;
      agg.symbol += r.symbol;
      agg.selection += r.selection;
      agg.implicitSelection += r.implicitSelection;
      agg.codebase += r.codebase;
      agg.workspace += r.workspace;
      agg.terminal += r.terminal;
      agg.vscode += r.vscode;
      agg.copilotInstructions += r.copilotInstructions;
      agg.agentsMd += r.agentsMd;
      return agg;
    },
    {
      file: 0,
      symbol: 0,
      selection: 0,
      implicitSelection: 0,
      codebase: 0,
      workspace: 0,
      terminal: 0,
      vscode: 0,
      copilotInstructions: 0,
      agentsMd: 0,
    },
  );

  // Sort filtered files
  const sortedFiles = sortSessionFiles(filteredFiles);

  // Build editor filter panels
  const editorPanelsHtml = `
		<div class="editor-filter-panels">
			<div class="editor-panel ${currentEditorFilter === null ? "active" : ""}" data-editor="">
				<div class="editor-panel-icon">🌐</div>
				<div class="editor-panel-name">All Editors</div>
				<div class="editor-panel-stats">${detailedFiles.length} sessions</div>
			</div>
			${editors
        .map(
          (editor) => `
				<div class="editor-panel ${currentEditorFilter === editor ? "active" : ""}" data-editor="${escapeHtml(editor)}">
					<div class="editor-panel-icon">${getEditorIcon(editor)}</div>
					<div class="editor-panel-name">${escapeHtml(editor)}</div>
					<div class="editor-panel-stats">${editorStats[editor].count} sessions · ${editorStats[editor].interactions} interactions</div>
				</div>
			`,
        )
        .join("")}
		</div>
	`;

  return `
		${editorPanelsHtml}

		<div class="summary-cards">
			<div class="summary-card">
				<div class="summary-label">📁 ${currentEditorFilter ? "Filtered" : "Total"} Sessions</div>
				<div class="summary-value">${filteredFiles.length}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">💬 Interactions</div>
				<div class="summary-value">${totalInteractions}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">🪙 Tokens</div>
				<div class="summary-value" title="${totalTokens.toLocaleString()} tokens">${formatTokenCount(totalTokens)}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">🔗 Context References</div>
				<div class="summary-value">${safeText(totalContextRefs)}</div>
				<div class="summary-sub">
				${totalContextRefs === 0 ? "None" : ""}
				${aggContextRefs.file > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "file" ? "active" : ""}" data-ref-type="file">#file ${aggContextRefs.file}</div>` : ""}
				${aggContextRefs.symbol > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "symbol" ? "active" : ""}" data-ref-type="symbol">#sym ${aggContextRefs.symbol}</div>` : ""}
				${aggContextRefs.implicitSelection > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "implicitSelection" ? "active" : ""}" data-ref-type="implicitSelection">implicit ${aggContextRefs.implicitSelection}</div>` : ""}
				${aggContextRefs.copilotInstructions > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "copilotInstructions" ? "active" : ""}" data-ref-type="copilotInstructions">📋 instructions ${aggContextRefs.copilotInstructions}</div>` : ""}
				${aggContextRefs.agentsMd > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "agentsMd" ? "active" : ""}" data-ref-type="agentsMd">🤖 agents ${aggContextRefs.agentsMd}</div>` : ""}
				${aggContextRefs.workspace > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "workspace" ? "active" : ""}" data-ref-type="workspace">@workspace ${aggContextRefs.workspace}</div>` : ""}
				${aggContextRefs.vscode > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "vscode" ? "active" : ""}" data-ref-type="vscode">@vscode ${aggContextRefs.vscode}</div>` : ""}
				</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">📅 Time Range</div>
				<div class="summary-value">Last 14 days</div>
			</div>
		</div>

		<div class="filter-options">
			<label class="empty-sessions-toggle">
				<input type="checkbox" id="hide-empty-sessions" ${hideEmptySessions ? 'checked' : ''}>
				Hide sessions with 0 interactions
				${zeroInteractionCount > 0 ? `<span class="hidden-count">(${zeroInteractionCount} hidden)</span>` : ''}
			</label>
		</div>

		<div class="table-container">
			<table class="session-table">
				<thead>
					<tr>
						<th>#</th>
						<th>Editor</th>
						<th>Title</th>
						<th>Repository</th>
						<th class="sortable" data-sort="size">Size${getSortIndicator("size")}</th>
						<th class="sortable" data-sort="tokens">Tokens${getSortIndicator("tokens")}</th>
						<th class="sortable" data-sort="interactions">Interactions${getSortIndicator("interactions")}</th>
						<th class="sortable" data-sort="contextRefs">Context Refs${getSortIndicator("contextRefs")}</th>
						<th class="sortable" data-sort="lastInteraction">Last Interaction${getSortIndicator("lastInteraction")}</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					${sortedFiles
            .map(
              (sf, idx) => `
						<tr>
							<td>${idx + 1}</td>
							<td><span class="${getEditorBadgeClass(sf.editorName || sf.editorSource)}" title="${escapeHtml(sf.editorSource)}">${getEditorIcon(sf.editorName || sf.editorSource)} ${escapeHtml(sf.editorName || sf.editorSource)}</span></td>
							<td class="session-title" title="${sf.title ? escapeHtml(sf.title) : "Empty session"}">
								${sf.title ? `<a href="#" class="session-file-link" data-file="${encodeURIComponent(sf.file)}" title="${escapeHtml(sf.title)}">${escapeHtml(sf.title.length > 40 ? sf.title.substring(0, 40) + "..." : sf.title)}</a>` : `<a href="#" class="session-file-link empty-session-link" data-file="${encodeURIComponent(sf.file)}" title="Empty session">(Empty session)</a>`}
							</td>
							<td class="repository-cell" title="${sf.repository ? escapeHtml(sf.repository) : "No repository detected"}">${sf.repository ? escapeHtml(getRepoDisplayName(sf.repository)) : '<span style="color: #666;">—</span>'}</td>
							<td>${formatFileSize(sf.size)}</td>
							<td title="${Number(sf.tokens || 0).toLocaleString()} tokens">${formatTokenCount(sf.tokens)}</td>
							<td>${sanitizeNumber(sf.interactions)}</td>
							<td title="${escapeHtml(getContextRefsSummary(sf.contextReferences))}">${sanitizeNumber(getTotalContextRefs(sf.contextReferences))}</td>
							<td>${formatDate(sf.lastInteraction)}</td>
							<td>
								<a href="#" class="view-formatted-link" data-file="${encodeURIComponent(sf.file)}" title="View formatted JSONL file">📄 View</a>
								${(sf.editorName || sf.editorSource || "Unknown") === "Unknown" ? ` <a href="#" class="report-editor-link" data-path="${encodeURIComponent(sf.file)}" title="Report this unknown path so we can add editor support">📢 Report</a>` : ""}
							</td>
						</tr>
					`,
            )
            .join("")}
				</tbody>
			</table>
		</div>
	`;
}

function counterRow(key: string, label: string, value: number): string {
  return `
    <tr>
      <td style="padding: 6px 12px 6px 0; color: var(--vscode-descriptionForeground); white-space: nowrap;">${escapeHtml(label)}</td>
      <td style="padding: 6px 8px 6px 0;">
        <input type="number" class="debug-counter-input" data-key="${escapeHtml(key)}" value="${value}" min="0" step="1"
          style="width:70px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 6px; font-family: var(--vscode-editor-font-family, monospace);" />
      </td>
      <td style="padding: 6px 0;">
        <button class="button secondary debug-counter-set" data-key="${escapeHtml(key)}" style="padding: 2px 10px; font-size: 12px;">Set</button>
      </td>
    </tr>`;
}

function stringRow(key: string, label: string, value: string): string {
  const display = value ? `✅ ${escapeHtml(value)}` : '❌ (not set)';
  return `
    <tr>
      <td style="padding: 6px 12px 6px 0; color: var(--vscode-descriptionForeground); white-space: nowrap;">${escapeHtml(label)}</td>
      <td style="padding: 6px 8px 6px 0;" colspan="2">
        <span style="font-family: var(--vscode-editor-font-family, monospace);">${display}</span>
      </td>
    </tr>`;
}

function flagRow(key: string, label: string, value: boolean): string {
  return `
    <tr>
      <td style="padding: 6px 12px 6px 0; color: var(--vscode-descriptionForeground); white-space: nowrap;">${escapeHtml(label)}</td>
      <td style="padding: 6px 8px 6px 0;">
        <input type="checkbox" class="debug-flag-input" data-key="${escapeHtml(key)}" ${value ? 'checked' : ''} />
        <span style="margin-left:6px; font-family: var(--vscode-editor-font-family, monospace);">${value ? '✅ true' : '❌ false'}</span>
      </td>
      <td style="padding: 6px 0;">
        <button class="button secondary debug-flag-set" data-key="${escapeHtml(key)}" style="padding: 2px 10px; font-size: 12px;">Set</button>
      </td>
    </tr>`;
}

function renderDebugTab(counters: GlobalStateCounters | undefined): string {
  const c = counters ?? { openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: '' };
  return `
    <div id="tab-debug" class="tab-content">
      <div class="info-box">
        <div class="info-box-title">🐛 Debug — Global State Counters</div>
        <div>Visible only when a debugger is attached. Edit counters and dismissed flags stored in VS Code global state, then click Set to apply. Changes take effect immediately.</div>
      </div>
      <div class="cache-details">
        <h4>Notification Counters</h4>
        <table><tbody>
          ${counterRow('extension.openCount', 'extension.openCount (fluency banner threshold: 5)', c.openCount)}
          ${counterRow('extension.unknownMcpOpenCount', 'extension.unknownMcpOpenCount (unknown MCP threshold: 8)', c.unknownMcpOpenCount)}
        </tbody></table>
        <h4 style="margin-top:16px;">Dismissed Flags</h4>
        <table><tbody>
          ${flagRow('news.fluencyScoreBanner.v1.dismissed', 'news.fluencyScoreBanner.v1.dismissed', c.fluencyBannerDismissed)}
          ${stringRow('news.unknownMcpTools.dismissedVersion', 'news.unknownMcpTools.dismissedVersion', c.unknownMcpDismissedVersion)}
        </tbody></table>
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

function renderAzureStoragePanel(azureInfo: AzureStorageInfo): string {
  const statusColor = azureInfo.isConfigured ? "#2d6a4f" : azureInfo.enabled ? "#d97706" : "#666";
  const statusIcon = azureInfo.isConfigured ? "✅" : azureInfo.enabled ? "⚠️" : "⚪";
  const statusText = azureInfo.isConfigured
    ? "Configured & Enabled"
    : azureInfo.enabled
      ? "Enabled but Not Configured"
      : "Disabled";

  return `
    <div class="info-box">
      <div class="info-box-title">☁️ Azure Storage Backend</div>
      <div>Sync your token usage data to Azure Storage Tables for team-wide reporting and multi-device access.</div>
    </div>

    <div class="summary-cards">
      <div class="summary-card" style="border-left: 4px solid ${statusColor};">
        <div class="summary-label">${statusIcon} Status</div>
        <div class="summary-value" style="font-size: 16px; color: ${statusColor};">${statusText}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">🔐 Auth Mode</div>
        <div class="summary-value" style="font-size: 16px;">${azureInfo.authMode === "entraId" ? "Entra ID" : "Shared Key"}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">👥 Sharing Profile</div>
        <div class="summary-value" style="font-size: 14px;">${escapeHtml(azureInfo.sharingProfile)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">🕒 Last Sync</div>
        <div class="summary-value" style="font-size: 14px;">${azureInfo.lastSyncTime ? getTimeSince(azureInfo.lastSyncTime) : "Never"}</div>
      </div>
    </div>

    ${azureInfo.isConfigured ? `
      <div style="margin-top: 24px;">
        <h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📊 Configuration Details</h4>
        <table class="session-table">
          <tbody>
            <tr><td style="font-weight: 600; width: 200px;">Storage Account</td><td>${escapeHtml(azureInfo.storageAccount)}</td></tr>
            <tr><td style="font-weight: 600;">Subscription ID</td><td>${escapeHtml(azureInfo.subscriptionId)}</td></tr>
            <tr><td style="font-weight: 600;">Resource Group</td><td>${escapeHtml(azureInfo.resourceGroup)}</td></tr>
            <tr><td style="font-weight: 600;">Aggregation Table</td><td>${escapeHtml(azureInfo.aggTable)}</td></tr>
            <tr><td style="font-weight: 600;">Events Table</td><td>${escapeHtml(azureInfo.eventsTable)}</td></tr>
          </tbody>
        </table>
      </div>

      <div style="margin-top: 24px;">
        <h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📈 Local Session Statistics</h4>
        <div class="summary-cards">
          <div class="summary-card">
            <div class="summary-label">💻 Unique Devices</div>
            <div class="summary-value">${escapeHtml(String(azureInfo.deviceCount))}</div>
            <div style="font-size: 11px; color: #999; margin-top: 4px;">Based on workspace IDs</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">📁 Total Sessions</div>
            <div class="summary-value">${escapeHtml(String(azureInfo.sessionCount))}</div>
            <div style="font-size: 11px; color: #999; margin-top: 4px;">Local session files</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">☁️ Cloud Records</div>
            <div class="summary-value">${azureInfo.recordCount !== null ? escapeHtml(String(azureInfo.recordCount)) : "—"}</div>
            <div style="font-size: 11px; color: #999; margin-top: 4px;">Azure Storage records</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">🔄 Sync Status</div>
            <div class="summary-value" style="font-size: 14px;">${azureInfo.lastSyncTime ? formatDate(azureInfo.lastSyncTime) : "Never"}</div>
          </div>
        </div>
      </div>
    ` : `
      <div style="margin-top: 24px;">
        <h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">🚀 Get Started with Azure Storage</h4>
        <p style="color: #999; font-size: 12px; margin-bottom: 16px;">
          To enable cloud synchronization, configure an Azure Storage account via the Backend configuration panel.
        </p>
        <ul style="margin: 8px 0 16px 20px; color: #999; font-size: 12px;">
          <li>Azure subscription with Storage Account access</li>
          <li>Appropriate permissions (Storage Table Data Contributor or Storage Account Key)</li>
          <li>VS Code signed in with your Azure account (for Entra ID auth)</li>
        </ul>
      </div>
    `}

    <div class="button-group">
      <button class="button" id="btn-configure-backend">
        <span>${azureInfo.isConfigured ? "⚙️" : "🔧"}</span>
        <span>${azureInfo.isConfigured ? "Manage Backend" : "Configure Backend"}</span>
      </button>
    </div>
  `;
}

function renderTeamServerPanel(teamInfo: TeamServerInfo): string {
  const statusColor = teamInfo.isConfigured ? "#2d6a4f" : teamInfo.enabled ? "#d97706" : "#666";
  const statusIcon = teamInfo.isConfigured ? "✅" : teamInfo.enabled ? "⚠️" : "⚪";
  const statusText = teamInfo.isConfigured
    ? "Configured & Enabled"
    : teamInfo.enabled
      ? "Enabled but Not Configured"
      : "Disabled";

  return `
    <div class="info-box">
      <div class="info-box-title">🖥️ Team Server Backend</div>
      <div>Sync your token usage data to a self-hosted team server for team-wide reporting.</div>
    </div>

    <div class="summary-cards">
      <div class="summary-card" style="border-left: 4px solid ${statusColor};">
        <div class="summary-label">${statusIcon} Status</div>
        <div class="summary-value" style="font-size: 16px; color: ${statusColor};">${statusText}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">👥 Sharing Profile</div>
        <div class="summary-value" style="font-size: 14px;">${escapeHtml(teamInfo.sharingProfile)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">🕒 Last Sync</div>
        <div class="summary-value" style="font-size: 14px;">${teamInfo.lastSyncTime ? getTimeSince(teamInfo.lastSyncTime) : "Never"}</div>
      </div>
    </div>

    ${teamInfo.isConfigured ? `
      <div style="margin-top: 24px;">
        <h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📊 Configuration Details</h4>
        <table class="session-table">
          <tbody>
            <tr>
              <td style="font-weight: 600; width: 200px;">Server URL</td>
              <td>${escapeHtml(teamInfo.endpointUrl)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style="margin-top: 24px;">
        <h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📈 Local Session Statistics</h4>
        <div class="summary-cards">
          <div class="summary-card">
            <div class="summary-label">📁 Total Sessions</div>
            <div class="summary-value">${escapeHtml(String(teamInfo.sessionCount))}</div>
            <div style="font-size: 11px; color: #999; margin-top: 4px;">Local session files</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">🔄 Last Sync</div>
            <div class="summary-value" style="font-size: 14px;">${teamInfo.lastSyncTime ? formatDate(teamInfo.lastSyncTime) : "Never"}</div>
          </div>
        </div>
      </div>
    ` : `
      <div style="margin-top: 24px;">
        <h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">🚀 Get Started with Team Server</h4>
        <p style="color: #999; font-size: 12px; margin-bottom: 16px;">
          Deploy the sharing server and configure its URL in the Backend configuration panel.
        </p>
        <ul style="margin: 8px 0 16px 20px; color: #999; font-size: 12px;">
          <li>Deploy the sharing server (see the <code>sharing-server/</code> folder in the repository)</li>
          <li>Enter the server's base URL in the Backend configuration panel</li>
          <li>Data syncs automatically every 5 minutes once configured</li>
        </ul>
      </div>
    `}

    <div class="button-group">
      <button class="button" id="btn-configure-backend-team">
        <span>${teamInfo.isConfigured ? "⚙️" : "🔧"}</span>
        <span>${teamInfo.isConfigured ? "Manage Backend" : "Configure Backend"}</span>
      </button>
    </div>
  `;
}

function renderBackendStoragePanel(
  backendInfo: BackendStorageInfo | undefined,
): string {
  if (!backendInfo) {
    return `
      <div class="info-box">
        <div class="info-box-title">☁️ Backend Storage</div>
        <div>Backend storage information is not available. This may be a temporary issue.</div>
        <div class="button-group" style="margin-top: 12px;">
          <button class="button" id="btn-configure-backend">
            <span>🔧</span>
            <span>Configure Backend</span>
          </button>
        </div>
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
      ${renderTeamServerPanel(backendInfo.teamServer)}
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
      <div class="section-title">📁 Folder Selection</div>
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
          <option value="copilot-chat">💙 GitHub Copilot Chat (VS Code)</option>
          <option value="copilot-cli">🤖 GitHub Copilot CLI</option>
          <option value="claude-code">🟣 Claude Code (.jsonl only)</option>
          <option value="continue">⚡ Continue</option>
          <option value="opencode">🟢 OpenCode (JSON format only — DB not supported)</option>
          <option value="mistral-vibe">🔥 Mistral Vibe</option>
          <option value="claude-desktop">🖥️ Claude Desktop</option>
        </select>
      </div>
      <div style="margin-top: 16px;">
        <button class="button" id="btn-analyze-folder">🔍 Analyze</button>
      </div>
    </div>
    <div id="folder-analysis-results"></div>
  `;
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

  const sorted = [...files].sort((a, b) => {
    const aScore = a.interactions * 1000 + a.tokens;
    const bScore = b.interactions * 1000 + b.tokens;
    return bScore - aScore;
  });

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

  const tableRows = sorted.map((f, idx) => {
    const hasData = f.interactions > 0 || f.tokens > 0;
    const rel = f.file.startsWith(folderPath)
      ? f.file.slice(folderPath.length).replace(/^[/\\]/, "")
      : getFileName(f.file);
    const safeInteractions = Number(f.interactions);
    const interactionsCell = safeInteractions > 0
      ? `<strong>${escapeHtml(String(safeInteractions))}</strong>`
      : `<span style="color: var(--text-muted);">0</span>`;
    const safeTokens = Number(f.tokens);
    const tokensCell = safeTokens > 0
      ? `<strong title="${escapeHtml(String(safeTokens.toLocaleString()))} tokens">${escapeHtml(String(formatTokenCount(safeTokens)))}</strong>`
      : `<span style="color: var(--text-muted);">0</span>`;
    return `
      <tr style="${hasData ? "" : "opacity: 0.45;"}">
        <td>${idx + 1}</td>
        <td title="${escapeHtml(f.file)}" style="font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(rel)}</td>
        <td>${escapeHtml(String(formatFileSize(f.size)))}</td>
        <td>${interactionsCell}</td>
        <td>${tokensCell}</td>
        <td>${formatDate(f.modified)}</td>
      </tr>`;
  }).join("");

  return `
    <div class="section" style="margin-top: 0;">
      <div class="section-title">📊 Analysis Results</div>
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
        <div class="table-container" style="margin-top: 12px; max-height: 420px;">
          <table class="session-table">
            <thead>
              <tr>
                <th>#</th>
                <th>File</th>
                <th>Size</th>
                <th>Interactions</th>
                <th>Tokens</th>
                <th>Last Modified</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>`}
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

function renderLayout(data: DiagnosticsData): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }

  // Build session folder summary (main entry folders) for reference
  let sessionFilesHtml = "";
  const sessionFolders = groupSessionFolders((data as any).sessionFolders || []);
  if (sessionFolders.length > 0) {
    // Sort folders by descending count so top folders show first
    const sorted = [...sessionFolders].sort((a, b) => b.count - a.count);
    sessionFilesHtml = `
			<div class="session-folders-table">
				<h4>Main Session Folders (by editor root):</h4>
				<table class="session-table">
					<thead>
						<tr>
							<th>Folder</th>
							<th>Editor</th>
							<th># of Sessions</th>
							<th>Open</th>
						</tr>
					</thead>
					<tbody>`;
    const totalSessions = sorted.reduce((sum, sf) => sum + sf.count, 0);
    console.log(
      "[Diagnostics] Total sessions calculated:",
      totalSessions,
      "from",
      sorted.length,
      "folders",
    );

    sorted.forEach(
      (sf: { dir: string; count: number; editorName?: string }) => {
        // Shorten common user paths for readability
        let display = sf.dir;
        const home =
          (window as any).process?.env?.HOME ||
          (window as any).process?.env?.USERPROFILE ||
          "";
        if (home && display.startsWith(home)) {
          display = display.replace(home, "~");
        }
        const editorName = sf.editorName || "Unknown";
        sessionFilesHtml += `
				<tr>
					<td title="${escapeHtml(sf.dir)}">${escapeHtml(display)}</td>
				<td><span class="${getEditorBadgeClass(editorName)}">${getEditorIcon(editorName)} ${escapeHtml(editorName)}</span></td>
					<td>${sf.count}</td>
					<td><a href="#" class="reveal-link" data-path="${encodeURIComponent(sf.dir)}">Open directory</a>${editorName === "Unknown" ? ` <a href="#" class="report-editor-link" data-path="${encodeURIComponent(sf.dir)}" title="Report this unknown path so we can add editor support">📢 Report</a>` : ""}</td>
				</tr>`;
      },
    );

    // Add total row
    sessionFilesHtml += `
				<tr style="border-top: 2px solid #5a5a5a; font-weight: 600; background: rgba(255, 255, 255, 0.05);">
					<td colspan="2" style="text-align: right; padding-right: 16px;">Total:</td>
					<td>${totalSessions}</td>
					<td></td>
				</tr>`;
    console.log("[Diagnostics] Total row HTML added to sessionFilesHtml");

    sessionFilesHtml += `
					</tbody>
				</table>
			</div>`;
  }

  // Remove session files section from report text (it's shown separately as clickable links)
  let escapedReport = escapeHtml(data.report);

  // Check if we're in loading state for the report
  const reportIsLoading = data.report === LOADING_PLACEHOLDER;

  if (!reportIsLoading) {
    // Remove the old session files list from the report text if present
    escapedReport = removeSessionFilesSection(escapedReport);
  } else {
    // Show a better loading message
    escapedReport = LOADING_MESSAGE.trim();
  }

  // Build detailed session files table
  const detailedFiles = data.detailedSessionFiles || [];

  root.innerHTML = `
		<style>${themeStyles}</style>
		<style>${styles}</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">🔍</span>
					<span class="header-title">Diagnostic Report</span>
				</div>
				<div class="button-row">
					${buttonHtml("btn-refresh")}
					${buttonHtml("btn-details")}
					${buttonHtml("btn-chart")}
					${buttonHtml("btn-usage")}
					${buttonHtml("btn-environmental")}
					${buttonHtml("btn-maturity")}
					${data?.backendConfigured ? buttonHtml("btn-dashboard") : ""}
				</div>
			</div>

			<div class="tabs">
				<button class="tab active" data-tab="report">📋 Report</button>
				<button class="tab" data-tab="sessions">📁 Session Files (${detailedFiles.length})</button>
				<button class="tab" data-tab="cache">💾 Cache</button>
				<button class="tab" data-tab="backend">☁️ Backend Storage</button>
				<button class="tab" data-tab="github">🔑 GitHub Auth</button>
				<button class="tab" data-tab="display">⚙️ Settings</button>
				<button class="tab" data-tab="path-analyzer">🔬 Path Analyzer</button>
				${data.isDebugMode ? '<button class="tab" data-tab="debug">🐛 Debug</button>' : ''}
			</div>

			<div id="tab-report" class="tab-content active">
				<div class="info-box">
					<div class="info-box-title">📋 About This Report</div>
					<div>
						This diagnostic report contains information about your AI Engineering Fluency extension
						extension setup and usage statistics. </br> It does <strong>not</strong> include any of your
						code or conversation content. You can safely share this report when reporting issues.
					</div>
				</div>
				<div class="report-content">${escapedReport}</div>
				${sessionFilesHtml}
				<div class="button-group">
					<button class="button" id="btn-copy"><span>📋</span><span>Copy to Clipboard</span></button>
					<button class="button secondary" id="btn-issue"><span>🐛</span><span>Open GitHub Issue</span></button>
					<button class="button secondary" id="btn-clear-cache"><span>🗑️</span><span>Clear Cache</span></button>
				</div>
			</div>

			<div id="tab-sessions" class="tab-content">
				<div class="info-box">
					<div class="info-box-title">📁 Session File Analysis</div>
					<div>
						This tab shows session files with activity in the last 14 days from all detected editors. </br>
						Click on an editor panel to filter, click column headers to sort, and click a file name to open it.
					</div>
				</div>
				<div id="session-table-container">${renderSessionTable(detailedFiles, detailedFiles.length === 0)}</div>
			</div>

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
						<button class="button secondary" id="btn-clear-cache-tab"><span>🗑️</span><span>Clear Cache</span></button>
					</div>
				</div>
			</div>

			<div id="tab-backend" class="tab-content">
				${renderBackendStoragePanel(data.backendStorageInfo)}
			</div>

			<div id="tab-github" class="tab-content">
				${renderGitHubAuthPanel(data.githubAuth)}
			</div>
			<div id="tab-display" class="tab-content">
				<div class="info-box">
					<div class="info-box-title">⚙️ Display Settings</div>
					<div>Configure how numbers are displayed across the extension. Changes take effect immediately in the Settings editor and are applied the next time a view is opened or refreshed.</div>
				</div>
				<div class="backend-card">
					<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">🔢 Number Formatting</h4>
					<p style="color: #ccc; margin-bottom: 12px;">
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
			</div>
			${data.isDebugMode ? renderDebugTab(data.globalStateCounters) : ''}
			<div id="tab-path-analyzer" class="tab-content">
				${renderFolderAnalyzerTab()}
			</div>
		</div>
	`;

  // Store data for re-rendering on sort - will be updated when data loads
  let storedDetailedFiles = detailedFiles;
  let isLoading = detailedFiles.length === 0;

  // Listen for messages from the extension (background loading)
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.command === "diagnosticDataLoaded") {
      // Initial diagnostic data has loaded (report, session folders, backend info)
      // Update the report text and folders
      if (message.report) {
        // Update the report tab content
        const reportTabContent = document.getElementById("tab-report");
        if (reportTabContent) {
          // Process the report text to remove session files section
          const processedReport = removeSessionFilesSection(message.report);
          const reportPre = reportTabContent.querySelector(".report-content");
          if (reportPre) {
            reportPre.textContent = processedReport;
          }
        }
      }

      // Update backend storage info if provided
      if (message.backendStorageInfo) {
        const backendTabContent = document.getElementById("tab-backend");
        if (backendTabContent) {
          // Capture active subtab before re-rendering so we can restore it
          const activeSubtabEl = backendTabContent.querySelector(".subtab.active") as HTMLElement | null;
          const previousSubtab = activeSubtabEl?.getAttribute("data-subtab")
            ?? vscode.getState()?.activeSubtab;

          backendTabContent.innerHTML = renderBackendStoragePanel(
            message.backendStorageInfo,
          );
          // Re-attach event listeners for backend buttons
          setupBackendButtonHandlers();
          setupSubtabHandlers();

          // Restore previously-active subtab (or default to first)
          if (previousSubtab) {
            activateSubtab(previousSubtab);
            const currentState = vscode.getState() ?? {};
            vscode.setState({ ...currentState, activeSubtab: previousSubtab });
          }
        }
      } else {
        console.warn("diagnosticDataLoaded received but backendStorageInfo is missing or undefined");
      }

      // Update session folders if provided
      if (message.sessionFolders && message.sessionFolders.length > 0) {
        const reportTabContent = document.getElementById("tab-report");
        if (reportTabContent) {
          const grouped = groupSessionFolders(message.sessionFolders);
          const sorted = [...grouped].sort(
            (a: any, b: any) => b.count - a.count,
          );

          // Build the session folders table using DOM APIs to avoid HTML injection
          let container = reportTabContent.querySelector(
            ".session-folders-table",
          ) as HTMLElement | null;
          if (!container) {
            container = document.createElement("div");
            container.className = "session-folders-table";
          } else {
            // Clear existing content so we can rebuild safely
            while (container.firstChild) {
              container.removeChild(container.firstChild);
            }
          }

          const heading = document.createElement("h4");
          heading.textContent = "Main Session Folders (by editor root):";
          container.appendChild(heading);

          const table = document.createElement("table");
          table.className = "session-table";
          container.appendChild(table);

          const thead = document.createElement("thead");
          table.appendChild(thead);
          const headerRow = document.createElement("tr");
          thead.appendChild(headerRow);

          const headers = ["Folder", "Editor", "# of Sessions", "Open"];
          headers.forEach((text) => {
            const th = document.createElement("th");
            th.textContent = text;
            headerRow.appendChild(th);
          });

          const tbody = document.createElement("tbody");
          table.appendChild(tbody);

          sorted.forEach((sf: any) => {
            let display = sf.dir;
            const home =
              (window as any).process?.env?.HOME ||
              (window as any).process?.env?.USERPROFILE ||
              "";
            if (home && display.startsWith(home)) {
              display = display.replace(home, "~");
            }
            const editorName = sf.editorName || "Unknown";

            const row = document.createElement("tr");

            // Folder cell
            const folderCell = document.createElement("td");
            folderCell.setAttribute("title", escapeHtml(sf.dir));
            folderCell.textContent = escapeHtml(display);
            row.appendChild(folderCell);

            // Editor cell
            const editorCell = document.createElement("td");
            const editorBadge = document.createElement("span");
            editorBadge.className = getEditorBadgeClass(editorName);
            editorBadge.textContent = `${getEditorIcon(editorName)} ${escapeHtml(editorName)}`;
            editorCell.appendChild(editorBadge);
            row.appendChild(editorCell);

            // Count cell
            const countCell = document.createElement("td");
            countCell.textContent = String(sf.count);
            row.appendChild(countCell);

            // Open link cell
            const openCell = document.createElement("td");
            const openLink = document.createElement("a");
            openLink.href = "#";
            openLink.className = "reveal-link";
            openLink.setAttribute("data-path", encodeURIComponent(sf.dir));
            openLink.textContent = "Open directory";
            openCell.appendChild(openLink);
            row.appendChild(openCell);

            tbody.appendChild(row);
          });

          // Add total row
          const totalSessions = sorted.reduce((sum, sf) => sum + sf.count, 0);
          const totalRow = document.createElement("tr");
          totalRow.style.borderTop = "2px solid var(--vscode-panel-border)";
          totalRow.style.fontWeight = "bold";
          totalRow.style.background = "rgba(255, 255, 255, 0.05)";

          const totalLabelCell = document.createElement("td");
          totalLabelCell.setAttribute("colspan", "2");
          totalLabelCell.style.textAlign = "right";
          totalLabelCell.style.paddingRight = "16px";
          totalLabelCell.textContent = "Total:";
          totalRow.appendChild(totalLabelCell);

          const totalCountCell = document.createElement("td");
          totalCountCell.textContent = totalSessions.toString();
          totalRow.appendChild(totalCountCell);

          const totalEmptyCell = document.createElement("td");
          totalRow.appendChild(totalEmptyCell);

          tbody.appendChild(totalRow);

          // Find where to insert or replace the session folders table
          // It should be inserted after the report-content div but before the button-group
          const existingTable = reportTabContent.querySelector(
            ".session-folders-table",
          );
          if (!existingTable) {
            // Insert after the report-content div
            const reportContent =
              reportTabContent.querySelector(".report-content");
            if (reportContent) {
              reportContent.insertAdjacentElement("afterend", container);
            } else {
              // Fallback: append to the tab content if report-content is missing
              reportTabContent.appendChild(container);
            }
          }

          setupStorageLinkHandlers();
        }
      }

      // Update candidate paths if provided
      if (message.candidatePaths && message.candidatePaths.length > 0) {
        const reportTabContent = document.getElementById("tab-report");
        if (reportTabContent) {
          // Remove existing candidate paths table if present
          const existing = reportTabContent.querySelector(".candidate-paths-table");
          if (existing) {
            existing.remove();
          }

          const candidateEl = buildCandidatePathsElement(message.candidatePaths);

          // Insert after session-folders-table if it exists, otherwise after report-content
          const foldersTable = reportTabContent.querySelector(".session-folders-table");
          if (foldersTable) {
            foldersTable.insertAdjacentElement("afterend", candidateEl);
          } else {
            const reportContent = reportTabContent.querySelector(".report-content");
            if (reportContent) {
              reportContent.insertAdjacentElement("afterend", candidateEl);
            } else {
              reportTabContent.appendChild(candidateEl);
            }
          }
        }
      }

      // Diagnostic data loaded successfully - no console needed as this is normal operation

      // Update GitHub Auth tab with the auth status from the loaded data
      if (message.githubAuth !== undefined) {
        const githubTabContent = document.getElementById("tab-github");
        if (githubTabContent) {
          githubTabContent.innerHTML = renderGitHubAuthPanel(message.githubAuth);
          setupGitHubAuthHandlers();
        }
      }
    } else if (message.command === "githubAuthUpdated") {
      // Update GitHub Auth tab with new authentication status
      const githubTabContent = document.getElementById("tab-github");
      if (githubTabContent) {
        githubTabContent.innerHTML = renderGitHubAuthPanel(message.githubAuth);
        setupGitHubAuthHandlers();
      }
    } else if (message.command === "diagnosticDataError") {
      // Show error message
      console.error("Error loading diagnostic data:", message.error);
      const root = document.getElementById("root");
      if (root) {
        const errorDiv = document.createElement("div");
        errorDiv.style.cssText =
          "color: #ff6b6b; padding: 20px; text-align: center;";
        errorDiv.innerHTML = `
					<h3>⚠️ Error Loading Diagnostic Data</h3>
					<p>${escapeHtml(message.error || "Unknown error")}</p>
				`;
        root.insertBefore(errorDiv, root.firstChild);
      }
    } else if (
      message.command === "sessionFilesLoaded" &&
      message.detailedSessionFiles
    ) {
      storedDetailedFiles = message.detailedSessionFiles;
      isLoading = false;

      // Update tab count
      const sessionsTab = document.querySelector('.tab[data-tab="sessions"]');
      if (sessionsTab) {
        sessionsTab.textContent = `📁 Session Files (${storedDetailedFiles.length})`;
      }

      // Re-render the table
      reRenderTable();
    } else if (message.command === "cacheCleared") {
      // Reset button states to indicate success
      const btnReport = document.getElementById(
        "btn-clear-cache",
      ) as HTMLButtonElement | null;
      const btnTab = document.getElementById(
        "btn-clear-cache-tab",
      ) as HTMLButtonElement | null;
      if (btnReport) {
        btnReport.style.background = "#2d6a4f";
        btnReport.innerHTML = "<span>✅</span><span>Cache Cleared</span>";
        btnReport.disabled = false;
      }
      if (btnTab) {
        btnTab.style.background = "#2d6a4f";
        btnTab.innerHTML = "<span>✅</span><span>Cache Cleared</span>";
        btnTab.disabled = false;
      }

      // Re-enable buttons after a short delay and reset to original state
      setTimeout(() => {
        if (btnReport) {
          btnReport.style.background = "";
          btnReport.innerHTML = "<span>🗑️</span><span>Clear Cache</span>";
        }
        if (btnTab) {
          btnTab.style.background = "";
          btnTab.innerHTML = "<span>🗑️</span><span>Clear Cache</span>";
        }
      }, 2000);
    } else if (message.command === "cacheRefreshed") {
      // Update cache numbers with refreshed data
      if (message.cacheInfo) {
        const cacheInfo = message.cacheInfo;
        const cacheTabContent = document.getElementById("tab-cache");
        if (cacheTabContent) {
          const summaryCards =
            cacheTabContent.querySelectorAll(".summary-card");
          if (summaryCards.length >= 4) {
            const entriesValue =
              summaryCards[0]?.querySelector(".summary-value");
            if (entriesValue) {
              entriesValue.textContent = String(cacheInfo.size);
            }

            const sizeValue = summaryCards[1]?.querySelector(".summary-value");
            if (sizeValue) {
              sizeValue.textContent = `${cacheInfo.sizeInMB.toFixed(2)} MB`;
            }

            const lastUpdatedValue =
              summaryCards[2]?.querySelector(".summary-value");
            if (lastUpdatedValue) {
              const date = new Date(cacheInfo.lastUpdated);
              lastUpdatedValue.textContent = date.toLocaleString();
            }

            const ageValue = summaryCards[3]?.querySelector(".summary-value");
            if (ageValue) {
              ageValue.textContent = "0 seconds ago";
            }
          }
        }
      }
    } else if (message.command === "folderPicked") {
      const input = document.getElementById("folder-path-input") as HTMLInputElement | null;
      if (input && message.folderPath) {
        input.value = message.folderPath;
        input.style.borderColor = "";
      }
    } else if (message.command === "folderAnalysisResult") {
      const btn = document.getElementById("btn-analyze-folder") as HTMLButtonElement | null;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = "<span>🔍</span><span>Analyze</span>";
      }
      const resultsDiv = document.getElementById("folder-analysis-results");
      if (resultsDiv) {
        if (message.error) {
          resultsDiv.innerHTML = `
            <div class="info-box" style="border-color: #d97706; background: rgba(217,119,6,0.08); margin-top: 12px;">
              <div class="info-box-title">⚠️ Analysis Error</div>
              <div>${escapeHtml(message.error)}</div>
            </div>`;
        } else {
          resultsDiv.innerHTML = renderFolderAnalysisResults(
            message.files || [],
            message.totalScanned || 0,
            message.parseErrors || 0,
            message.truncated || false,
            escapeHtml(String(message.folderPath || "")),
          );
        }
      }
    }
  });

  // Handle open storage link clicks
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

  // Helper function to activate a subtab by its ID (without the "subtab-" prefix)
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

  // Helper function to activate a tab by its ID
  function activateTab(tabId: string): boolean {
    const tabButton = document.querySelector(`.tab[data-tab="${tabId}"]`);
    const tabContent = document.getElementById(`tab-${tabId}`);

    if (tabButton && tabContent) {
      // Remove active class from all tabs and contents
      document
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));

      // Activate the specified tab
      tabButton.classList.add("active");
      tabContent.classList.add("active");
      return true;
    }
    return false;
  }

  // Wire up tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabId = (tab as HTMLElement).getAttribute("data-tab");

      if (tabId && activateTab(tabId)) {
        // Save the active tab state
        vscode.setState({ activeTab: tabId });
      }
    });
  });

  // Wire up sortable column headers
  function setupSortHandlers(): void {
    document.querySelectorAll(".sortable").forEach((header) => {
      header.addEventListener("click", () => {
        const sortColumn = (header as HTMLElement).getAttribute(
          "data-sort",
        ) as typeof currentSortColumn;
        if (sortColumn) {
          // Toggle direction if same column, otherwise default to desc
          if (currentSortColumn === sortColumn) {
            currentSortDirection =
              currentSortDirection === "desc" ? "asc" : "desc";
          } else {
            currentSortColumn = sortColumn;
            currentSortDirection = "desc";
          }

          // Re-render table
          reRenderTable();
        }
      });
    });
  }

  // Wire up editor filter panel handlers
  function setupEditorFilterHandlers(): void {
    document.querySelectorAll(".editor-panel").forEach((panel) => {
      panel.addEventListener("click", () => {
        const editor = (panel as HTMLElement).getAttribute("data-editor");
        currentEditorFilter = editor === "" ? null : editor;

        // Re-render table
        reRenderTable();
      });
    });
  }

  // Wire up context ref filter handlers
  function setupContextRefFilterHandlers(): void {
    document.querySelectorAll(".context-ref-filter").forEach((filter) => {
      filter.addEventListener("click", () => {
        const refType = (filter as HTMLElement).getAttribute(
          "data-ref-type",
        ) as keyof ContextReferenceUsage | null;

        // Toggle: if clicking the same filter, clear it
        if (currentContextRefFilter === refType) {
          currentContextRefFilter = null;
        } else {
          currentContextRefFilter = refType;
        }

        // Re-render table
        reRenderTable();
      });
    });
  }

  // Wire up hide-empty-sessions checkbox handler
  function setupZeroInteractionFilterHandler(): void {
    const checkbox = document.getElementById("hide-empty-sessions") as HTMLInputElement | null;
    if (checkbox) {
      checkbox.addEventListener("change", () => {
        hideEmptySessions = checkbox.checked;
        reRenderTable();
      });
    }
  }

  // Wire up backend button handlers
  function setupBackendButtonHandlers(): void {
    document
      .getElementById("btn-configure-backend")
      ?.addEventListener("click", () => {
        vscode.postMessage({ command: "configureBackend" });
      });

    document
      .getElementById("btn-configure-backend-team")
      ?.addEventListener("click", () => {
        // Pre-save the teamserver subtab so the diagnostics panel restores to it
        // after the settings change triggers a panel refresh
        const currentState = vscode.getState() ?? {};
        vscode.setState({ ...currentState, activeTab: "backend", activeSubtab: "backend-teamserver" });
        vscode.postMessage({ command: "configureTeamServer" });
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

  function setupSubtabHandlers(): void {
    document.querySelectorAll(".subtab").forEach((subtab) => {
      subtab.addEventListener("click", () => {
        const subtabId = (subtab as HTMLElement).getAttribute("data-subtab");
        if (!subtabId) {
          return;
        }
        // Deactivate all subtabs and content in the same subtab-bar
        const subtabBar = subtab.closest(".subtab-bar");
        if (subtabBar) {
          subtabBar.querySelectorAll(".subtab").forEach((s) => s.classList.remove("active"));
        }
        document.querySelectorAll(".subtab-content").forEach((c) => c.classList.remove("active"));
        subtab.classList.add("active");
        document.getElementById(`subtab-${subtabId}`)?.classList.add("active");
        // Persist active subtab so it can be restored after a data refresh
        const currentState = vscode.getState() ?? {};
        vscode.setState({ ...currentState, activeSubtab: subtabId });
      });
    });
  }

  // Re-render the session table with current filter/sort state
  function reRenderTable(): void {
    const container = document.getElementById("session-table-container");
    if (container) {
      container.innerHTML = renderSessionTable(storedDetailedFiles, isLoading);
      if (!isLoading) {
        setupSortHandlers();
        setupEditorFilterHandlers();
        setupContextRefFilterHandlers();
        setupZeroInteractionFilterHandler();
        setupFileLinks();
      }
    }
  }

  // Wire up file link handlers
  function setupFileLinks(): void {
    document.querySelectorAll(".session-file-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const file = decodeURIComponent(
          (link as HTMLElement).getAttribute("data-file") || "",
        );
        vscode.postMessage({ command: "openSessionFile", file });
      });
    });

    // View formatted JSONL link handlers
    document.querySelectorAll(".view-formatted-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const file = decodeURIComponent(
          (link as HTMLElement).getAttribute("data-file") || "",
        );
        vscode.postMessage({ command: "openFormattedJsonlFile", file });
      });
    });

    // Reveal link handlers
    document.querySelectorAll(".reveal-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const path = decodeURIComponent(
          (link as HTMLElement).getAttribute("data-path") || "",
        );
        vscode.postMessage({ command: "revealPath", path });
      });
    });

    // Report unknown editor path handlers
    document.querySelectorAll(".report-editor-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const path = decodeURIComponent(
          (link as HTMLElement).getAttribute("data-path") || "",
        );
        vscode.postMessage({ command: "reportNewEditorPath", path });
      });
    });
  }

  // Wire up event listeners
  document.getElementById("btn-copy")?.addEventListener("click", () => {
    vscode.postMessage({ command: "copyReport" });
  });

  document.getElementById("btn-issue")?.addEventListener("click", () => {
    vscode.postMessage({ command: "openIssue" });
  });

  // Helper function to update cache numbers to zero
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
        btn.innerHTML = "<span>⏳</span><span>Analyzing…</span>";
      }

      const resultsDiv = document.getElementById("folder-analysis-results");
      if (resultsDiv) {
        resultsDiv.innerHTML = `
          <div class="analyzer-loading">
            <span class="spinner" style="width:18px;height:18px;border:2px solid var(--link-color);border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin 0.7s linear infinite;"></span>
            <span>Scanning files…</span>
          </div>`;
      }

      vscode.postMessage({
        command: "analyzeFolder",
        folderPath,
        toolType: select?.value ?? "auto",
      });
    });
  }

  document.getElementById("btn-clear-cache")?.addEventListener("click", () => {
    const btn = document.getElementById(
      "btn-clear-cache",
    ) as HTMLButtonElement | null;
    if (btn) {
      btn.style.background = "#d97706";
      btn.innerHTML = "<span>⏳</span><span>Clearing...</span>";
      btn.disabled = true;
    }
    // Immediately update cache numbers (optimistic update)
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
        btn.innerHTML = "<span>⏳</span><span>Clearing...</span>";
        btn.disabled = true;
      }
      // Immediately update cache numbers (optimistic update)
      updateCacheNumbers();
      vscode.postMessage({ command: "clearCache" });
    });

  // Fallback click delegation in case direct listeners are not attached
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target) {
      return;
    }
    if (
      target.id === "btn-clear-cache" ||
      target.id === "btn-clear-cache-tab"
    ) {
      target.style.background = "#d97706";
      target.innerHTML = "<span>⏳</span><span>Clearing...</span>";
      if (target instanceof HTMLButtonElement) {
        target.disabled = true;
      }
      // Immediately update cache numbers (optimistic update)
      updateCacheNumbers();
      vscode.postMessage({ command: "clearCache" });
    }
    if (target.id === "btn-reset-debug-counters") {
      vscode.postMessage({ command: "resetDebugCounters" });
    }
    if (target.classList.contains("debug-counter-set")) {
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
    if (target.classList.contains("debug-flag-set")) {
      const key = target.getAttribute("data-key");
      const row = target.closest("tr");
      const input = row?.querySelector(".debug-flag-input") as HTMLInputElement | null;
      if (key && input) {
        vscode.postMessage({ command: "setDebugFlag", key, value: input.checked });
      }
    }
  });

  // Navigation buttons (match details view)
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

  setupSortHandlers();
  setupEditorFilterHandlers();
  setupContextRefFilterHandlers();
  setupZeroInteractionFilterHandler();
  setupBackendButtonHandlers();
  setupSubtabHandlers();
  setupFileLinks();
  setupStorageLinkHandlers();
  setupGitHubAuthHandlers();
  setupFolderAnalyzerHandlers();

  // Restore active tab from saved state, with fallback to default
  const savedState = vscode.getState();
  if (savedState?.activeTab && !activateTab(savedState.activeTab)) {
    // If saved tab doesn't exist (e.g., structure changed), activate default "report" tab
    activateTab("report");
  }

  // Restore active subtab from saved state
  if (savedState?.activeSubtab) {
    activateSubtab(savedState.activeSubtab);
  }
}

async function bootstrap(): Promise<void> {
  const { provideVSCodeDesignSystem, vsCodeButton } =
    await import("@vscode/webview-ui-toolkit");
  provideVSCodeDesignSystem().register(vsCodeButton());

  if (!initialData) {
    const root = document.getElementById("root");
    if (root) {
      root.textContent = "No data available.";
    }
    return;
  }
  renderLayout(initialData);
}

void bootstrap();
