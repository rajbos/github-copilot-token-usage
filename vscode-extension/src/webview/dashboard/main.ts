// Import shared utilities
import { BUTTONS, getNavButtons } from "../shared/buttonConfig";
import { createButton, el, setHtml } from "../shared/domUtils";
import { escapeHtml, formatCost, formatNumber, formatCompact, setCompactNumbers } from "../shared/formatUtils";
import { getModelDisplayName } from "../../../../src/webview/shared/modelUtils";
import { wireExtensionPointButtons } from "../shared/extensionPoints";
import themeStyles from "../shared/theme.css";
import dataTableStyles from "../shared/dataTable.css";
import styles from "./styles.css";
import { getWindowData } from "../../../../src/webview/shared/dataLoader";
import type { ModelUsage } from "../shared/types";
import { registerMessageHandler } from "../shared/messageHandler";
import { applyWebviewLocale } from "../shared/webviewLocale";
import { installSurfaceNavigation } from "../shared/surfaceNavigation";
import { renderDataTable, type DataTableColumn, type DataTableRowOptions } from "../shared/dataTable";

interface UserSummary {
  userId: string;
  totalTokens: number;
  totalInteractions: number;
  totalCost: number;
  devices: string[];
  workspaces: string[];
  modelUsage: ModelUsage;
  localTokens?: number;
  localInteractions?: number;
}

interface TeamMemberStats {
  userId: string;
  datasetId: string;
  totalTokens: number;
  totalInteractions: number;
  totalCost: number;
  sessions: number;
  avgTurnsPerSession: number;
  uniqueModels: number;
  uniqueWorkspaces: number;
  daysActive: number;
  avgTokensPerTurn: number;
  fluencyStage?: number; // Optional - only present if fluency data exists
  fluencyLabel?: string; // Optional - only present if fluency data exists
  fluencyCategories?: { category: string; icon: string; stage: number; tips: string[] }[];
  rank: number;
}

interface DashboardStats {
  // Personal data across all devices/workspaces
  personal: UserSummary;
  // Team data for comparison
  team: {
    members: TeamMemberStats[];
    totalTokens: number;
    totalInteractions: number;
    averageTokensPerUser: number;
    firstDate?: string | null;
    lastDate?: string | null;
  };
  lookbackDays?: number;
  lastUpdated: string | Date;
  compactNumbers?: boolean;
}

declare function acquireVsCodeApi<TState = unknown>(): {
  postMessage: (message: any) => void;
  setState: (newState: TState) => void;
  getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

interface DashboardConfig {
  azureConfigured: boolean;
  azureStorageUrl: string;
  teamServerConfigured: boolean;
  teamServerUrl: string;
}

declare global {
  interface Window {
    __DASHBOARD_CONFIG__?: DashboardConfig;
  }
}

const vscode: VSCodeApi = acquireVsCodeApi();
installSurfaceNavigation(vscode, 'dashboard');
const initialData = getWindowData<DashboardStats & { localization?: Record<string, string> }>('__INITIAL_DASHBOARD__');
console.log("[CopilotTokenTracker] dashboard webview loaded");

// Initialize localization for webview
applyWebviewLocale(initialData);

/** Active backend config, set once from __DASHBOARD_CONFIG__ during bootstrap. */
let currentConfig: DashboardConfig | null = null;

/** Reference to the loading text element so backfillProgress messages can update it in place. */
let loadingTextEl: HTMLElement | null = null;

function showLoading(): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }

  root.replaceChildren();

  const themeStyle = document.createElement("style");
  themeStyle.textContent = `${themeStyles}\n${dataTableStyles}`;

  const style = document.createElement("style");
  style.textContent = styles;

  const container = el("div", "container");
  const header = el("div", "header");
  const title = el("div", "title", "📊 Team Dashboard");
  header.append(title);

  const loading = el("div", "loading-indicator");
  const spinner = el("div", "spinner");
  const serverUrl = currentConfig?.azureStorageUrl;
  const loadingText = el(
    "div",
    "loading-text",
    serverUrl ? `Loading dashboard data from ${serverUrl}...` : "Loading dashboard data...",
  );
  loadingTextEl = loadingText;
  loading.append(spinner, loadingText);

  container.append(header, loading);
  root.append(themeStyle, style, container);
}

function showError(message: string): void {
  loadingTextEl = null;
  const root = document.getElementById("root");
  if (!root) {
    return;
  }

  root.replaceChildren();

  const themeStyle = document.createElement("style");
  themeStyle.textContent = `${themeStyles}\n${dataTableStyles}`;

  const style = document.createElement("style");
  style.textContent = styles;

  const container = el("div", "container");
  const header = el("div", "header");
  const title = el("div", "title", "📊 Team Dashboard");
  const buttonRow = el("div", "button-row");
  buttonRow.append(createButton(BUTTONS["btn-refresh"]));
  header.append(title, buttonRow);

  container.append(header, buildDashboardFailure(message));
  root.append(themeStyle, style, container);
  wireButtons();
}

function buildDashboardFailure(message: string): HTMLElement {
  const failure = el("div", "dashboard-failure");

  const header = el("div", "config-card-header");
  const icon = el("span", "config-card-icon", "☁️");
  const heading = el("span", "config-card-heading", "Azure Storage");
  header.append(icon, heading);

  const errorEl = el("div", "error-message", message);
  const configureButton = createButton(
    "btn-configure-backend",
    "Configure Azure Storage",
    "secondary",
  );
  failure.append(header, errorEl, configureButton);
  return failure;
}

function render(stats: DashboardStats): void {
  loadingTextEl = null;
  setCompactNumbers(stats.compactNumbers !== false);
  const root = document.getElementById("root");
  if (!root) {
    return;
  }

  renderShell(root, stats);
  wireButtons();
}

function renderShell(root: HTMLElement, stats: DashboardStats): void {
  const lastUpdated = new Date(stats.lastUpdated);
  const hasBothBackends = !!(currentConfig?.azureConfigured && currentConfig?.teamServerConfigured);

  root.replaceChildren();

  const themeStyle = document.createElement("style");
  themeStyle.textContent = `${themeStyles}\n${dataTableStyles}`;

  const style = document.createElement("style");
  style.textContent = styles;

  const container = el("div", "container");
  const header = el("div", "header");
  const titleGroup = el("div", "title-group");
  const title = el("div", "title", "📊 Team Dashboard");
  const period = el("div", "period", `Last ${stats.lookbackDays ?? 30} days`);
  titleGroup.append(title, period);
  const buttonRow = el("div", "button-row");

  buttonRow.append(...getNavButtons("btn-dashboard", true).map((button) => createButton(button)));

  header.append(titleGroup, buttonRow);

  const footer = el(
    "div",
    "footer",
    `Last updated: ${lastUpdated.toLocaleString()}`,
  );

  const sections = el("div", "sections");
  sections.append(buildPersonalSection(stats.personal, stats.lookbackDays ?? 30));
  sections.append(buildTeamSection(stats));

  if (hasBothBackends) {
    sections.id = "azure-content";
    sections.setAttribute("role", "tabpanel");
    sections.setAttribute("aria-labelledby", "tab-azure");
    const tabNav = buildTabNav();
    const teamServerPanel = buildTeamServerPanel(currentConfig!.teamServerUrl);
    teamServerPanel.id = "team-server-content";
    teamServerPanel.setAttribute("role", "tabpanel");
    teamServerPanel.setAttribute("aria-labelledby", "tab-team-server");
    teamServerPanel.style.display = "none";

    container.append(header, tabNav, sections, footer, teamServerPanel);
    wireTabNav(tabNav, sections, footer, teamServerPanel);
  } else {
    container.append(header, sections, footer);
  }

  root.append(themeStyle, style, container);
}

function buildPersonalSection(personal: UserSummary, lookbackDays: number): HTMLElement {
  const section = el("div", "section");
  section.id = "section-personal-summary";
  const sectionTitle = el(
    "h2",
    "",
    "👤 Your Summary (All Devices & Workspaces)",
  );

  const grid = el("div", "stats-grid");

  grid.append(
    buildStatCard("Synced Tokens", formatCompact(personal.totalTokens)),
    buildStatCard("Synced Interactions", formatNumber(personal.totalInteractions)),
    buildStatCard("Estimated Cost", formatCost(personal.totalCost)),
    buildStatCard("Devices", personal.devices.length.toString()),
    buildStatCard("Workspaces", personal.workspaces.length.toString()),
  );

  const modelSection = buildModelBreakdown(personal.modelUsage);

  // Show sync coverage warning when local activity significantly exceeds synced data
  const localTokens = personal.localTokens ?? 0;
  const syncedTokens = personal.totalTokens;
  const showSyncWarning = localTokens > 0 && syncedTokens < localTokens * 0.9;

  if (showSyncWarning) {
    const syncCoverage = localTokens > 0 ? Math.round((syncedTokens / localTokens) * 100) : 100;
    const warning = el("div", "sync-warning");
    const warningTitle = el("div", "sync-warning-title");
    warningTitle.textContent = `⚠️ Only ${syncCoverage}% of your local activity is synced to cloud (${formatCompact(syncedTokens)} of ${formatCompact(localTokens)} local tokens in last ${lookbackDays} days)`;
    const warningNote = el("div", "sync-warning-note");
    warningNote.textContent = "To close the gap: increase the lookback window, run a manual sync, or check that blob upload is enabled and configured.";
    const backfillBtn = document.createElement("button");
    backfillBtn.className = "backfill-btn";
    backfillBtn.textContent = "⏫ Backfill Historical Data";
    backfillBtn.title = "Scan all local session files and upload missing daily data to Azure Storage";
    backfillBtn.addEventListener("click", () => {
      vscode.postMessage({ command: "backfillHistoricalData" });
    });
    warning.append(warningTitle, warningNote, backfillBtn);
    section.append(sectionTitle, grid, warning, modelSection);
  } else {
    section.append(sectionTitle, grid, modelSection);
  }
  return section;
}

function buildTeamSection(stats: DashboardStats): HTMLElement {
  const section = el("div", "section");
  section.id = "section-team-comparison";
  const sectionTitle = el("h2", "", "👥 Team Comparison");

  const teamGrid = el("div", "stats-grid");
  teamGrid.append(
    buildStatCard(
      "Team Total",
      formatCompact(stats.team.totalTokens) + " tokens",
    ),
    buildStatCard("Team Members", stats.team.members.length.toString()),
    buildStatCard(
      "Avg per User",
      formatCompact(Math.round(stats.team.averageTokensPerUser)) + " tokens",
    ),
  );

  // Add date range info if available
  let dateInfo: HTMLElement | null = null;
  if (stats.team.firstDate || stats.team.lastDate) {
    dateInfo = el("div", "info-box");
    const firstDate = stats.team.firstDate;
    const lastDate = stats.team.lastDate;
    const rangeLabel = el("div", "info-box-title");
    if (firstDate && lastDate) {
      rangeLabel.textContent = `📅 Synced data range: ${firstDate} → ${lastDate}`;
    } else if (firstDate) {
      rangeLabel.textContent = `📅 First synced data: ${firstDate}`;
    } else if (lastDate) {
      rangeLabel.textContent = `📅 Last synced data: ${lastDate}`;
    }
    const rangeNote = el("div", "info-box-note");
    const lookback = stats.lookbackDays ?? 30;
    rangeNote.textContent = `Dashboard is filtered to the last ${lookback} days. This reflects what team members have synced to cloud storage. Older data may exist locally but was outside their configured upload window.`;
    dateInfo.append(rangeLabel, rangeNote);
  }

  const leaderboard = buildLeaderboard(stats);

  if (dateInfo) {
    section.append(sectionTitle, teamGrid, dateInfo, leaderboard);
  } else {
    section.append(sectionTitle, teamGrid, leaderboard);
  }
  return section;
}

function buildStatCard(label: string, value: string): HTMLElement {
  const card = el("div", "stat-card");
  const labelEl = el("div", "stat-label", label);
  const valueEl = el("div", "stat-value", value);
  card.append(labelEl, valueEl);
  return card;
}

function buildModelBreakdown(modelUsage: ModelUsage): HTMLElement {
  const container = el("div", "model-breakdown");
  const title = el("h3", "", "Model Usage");

  const modelList = el("div", "model-list");

  const models = Object.entries(modelUsage)
    .map(([model, usage]) => ({
      model,
      tokens: usage.inputTokens + usage.outputTokens,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));

  for (const { model, tokens } of models) {
    const item = el("div", "model-item");
    const modelName = el("span", "model-name", getModelDisplayName(model));
    const tokenCount = el("span", "token-count", formatCompact(tokens));
    item.append(modelName, tokenCount);
    modelList.append(item);
  }

  container.append(title, modelList);
  return container;
}

const LEADERBOARD_TABLE_ID = "dashboard-leaderboard";

/** Members whose fluency detail row is open, keyed by `memberKey`; kept across sort/page re-renders. */
const expandedLeaderboardMembers = new Set<string>();

function memberKey(member: TeamMemberStats): string {
	return JSON.stringify([member.userId, member.datasetId]);
}

function displayUserIdOf(member: TeamMemberStats): string {
	return member.userId.replace(/^u:/, "");
}

function displayDatasetIdOf(member: TeamMemberStats): string {
	return (member.datasetId || "").replace(/^ds:/, "");
}

function hasFluencyCategories(member: TeamMemberStats): boolean {
	return !!member.fluencyCategories?.length;
}

function leaderboardFluencyCellHtml(member: TeamMemberStats): string {
	if (!member.fluencyStage || !member.fluencyLabel) { return ""; }
	return `<span class="fluency-badge stage-${escapeHtml(String(member.fluencyStage))}">${escapeHtml(`${getFluencyStageIcon(member.fluencyStage)} ${member.fluencyLabel}`)}</span>`;
}

function leaderboardRankCellHtml(member: TeamMemberStats): string {
	const toggle = hasFluencyCategories(member)
		? `<span class="expand-toggle">${expandedLeaderboardMembers.has(memberKey(member)) ? "▼" : "▶"}</span>`
		: "";
	return `${toggle}${escapeHtml(String(member.rank))}`;
}

function leaderboardDeleteButtonHtml(member: TeamMemberStats): string {
	const title = `Delete data for ${displayUserIdOf(member)} in dataset ${displayDatasetIdOf(member)}`;
	return `<button type="button" class="delete-row-btn" data-user-id="${escapeHtml(member.userId)}" data-dataset-id="${escapeHtml(member.datasetId ?? "")}" title="${escapeHtml(title)}">🗑️</button>`;
}

function leaderboardNumberColumn(id: string, label: string, value: (member: TeamMemberStats) => number, format: (value: number) => string = formatNumber): DataTableColumn<TeamMemberStats> {
	return { id, label, align: "right", sortValue: value, render: (member) => format(value(member)) };
}

function leaderboardColumns(stats: DashboardStats): DataTableColumn<TeamMemberStats>[] {
	return [
		{ id: "rank", label: "#", align: "center", className: "rank-cell", sortValue: (member) => member.rank, render: (member) => ({ html: leaderboardRankCellHtml(member) }) },
		{
			id: "user", label: "User", sortValue: displayUserIdOf,
			render: (member) => member.userId === stats.personal.userId ? `${displayUserIdOf(member)} 👈` : displayUserIdOf(member),
		},
		{ id: "dataset", label: "Dataset", className: "dataset-cell", sortValue: displayDatasetIdOf, render: displayDatasetIdOf },
		{
			id: "fluency", label: "Fluency", align: "center", firstSortDirection: "desc",
			sortValue: (member) => (member.fluencyStage && member.fluencyLabel ? member.fluencyStage : null),
			render: (member) => ({ html: leaderboardFluencyCellHtml(member) }),
		},
		leaderboardNumberColumn("tokens", "Tokens", (member) => member.totalTokens, formatCompact),
		leaderboardNumberColumn("days", "Days", (member) => member.daysActive),
		leaderboardNumberColumn("sessions", "Sessions", (member) => member.sessions),
		leaderboardNumberColumn("avgTurns", "Avg Turns", (member) => member.avgTurnsPerSession),
		leaderboardNumberColumn("models", "Models", (member) => member.uniqueModels),
		leaderboardNumberColumn("projects", "Projects", (member) => member.uniqueWorkspaces),
		leaderboardNumberColumn("tokPerTurn", "Tok/Turn", (member) => member.avgTokensPerTurn),
		leaderboardNumberColumn("cost", "Cost", (member) => member.totalCost, formatCost),
		{ id: "action", label: "", align: "center", width: "44px", render: (member) => ({ html: leaderboardDeleteButtonHtml(member) }) },
	];
}

function leaderboardRowOptions(member: TeamMemberStats, stats: DashboardStats): DataTableRowOptions {
	const classes = ["leaderboard-row"];
	if (member.userId === stats.personal.userId) { classes.push("current-user"); }
	const attributes: Record<string, string> = { "data-member-key": memberKey(member) };
	if (hasFluencyCategories(member)) {
		classes.push("expandable");
		attributes["aria-expanded"] = String(expandedLeaderboardMembers.has(memberKey(member)));
		attributes.tabindex = "0";
	}
	return { className: classes.join(" "), attributes };
}

function leaderboardDetailRowHtml(member: TeamMemberStats, colSpan: number): string {
	if (!hasFluencyCategories(member)) { return ""; }
	const hidden = expandedLeaderboardMembers.has(memberKey(member)) ? "" : " hidden";
	return `<tr class="detail-row${hidden}"><td class="detail-cell" colspan="${colSpan}">${fluencyDetailPanelHtml(member)}</td></tr>`;
}

/** Opens or closes a member's fluency detail row in place and remembers the state for re-renders. */
function toggleLeaderboardRow(row: HTMLElement): void {
	const key = row.getAttribute("data-member-key");
	if (!key) { return; }
	const expanded = !expandedLeaderboardMembers.has(key);
	if (expanded) { expandedLeaderboardMembers.add(key); } else { expandedLeaderboardMembers.delete(key); }
	row.setAttribute("aria-expanded", String(expanded));
	const toggle = row.querySelector(".expand-toggle");
	if (toggle) { toggle.textContent = expanded ? "▼" : "▶"; }
	const detailRow = row.nextElementSibling;
	if (detailRow?.classList.contains("detail-row")) { detailRow.classList.toggle("hidden", !expanded); }
}

/** One delegated listener pair on the stable leaderboard container survives every table re-render. */
function wireLeaderboardInteractions(container: HTMLElement): void {
	container.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const deleteButton = target?.closest<HTMLElement>(".delete-row-btn");
		if (deleteButton) {
			vscode.postMessage({
				command: "deleteUserDataset",
				userId: deleteButton.getAttribute("data-user-id") ?? "",
				datasetId: deleteButton.getAttribute("data-dataset-id") ?? "",
			});
			return;
		}
		const row = target?.closest<HTMLElement>("tr.leaderboard-row.expandable");
		if (row) { toggleLeaderboardRow(row); }
	});
	container.addEventListener("keydown", (event) => {
		const row = event.target instanceof HTMLElement ? event.target : null;
		if (!row?.matches("tr.leaderboard-row.expandable")) { return; }
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggleLeaderboardRow(row);
		}
	});
}

function buildLeaderboard(stats: DashboardStats): HTMLElement {
	const columns = leaderboardColumns(stats);
	const container = el("div", "leaderboard");
	const tableContainer = el("div", "leaderboard-table-container");
	setHtml(tableContainer, renderDataTable<TeamMemberStats>({
		tableId: LEADERBOARD_TABLE_ID,
		ariaLabel: "Leaderboard",
		rows: stats.team.members,
		columns,
		initialSort: { columnId: "rank", direction: "asc" },
		className: "leaderboard-table",
		rowOptions: (member) => leaderboardRowOptions(member, stats),
		afterRow: (member) => leaderboardDetailRowHtml(member, columns.length),
	}));
	wireLeaderboardInteractions(tableContainer);
	container.append(el("h3", "", "Leaderboard"), tableContainer);
	return container;
}

function fluencyCategoryCardHtml(cat: NonNullable<TeamMemberStats["fluencyCategories"]>[number]): string {
	const pips = [1, 2, 3, 4]
		.map((s) => `<div class="stage-pip${s <= cat.stage ? ` filled stage-pip-${escapeHtml(String(cat.stage))}` : ""}"></div>`)
		.join("");
	let footer = "";
	if (cat.tips.length > 0) {
		const tips = cat.tips.map((tip) => `<div class="fluency-tip">${renderTipHtml(tip)}</div>`).join("");
		footer = `<div class="fluency-tips"><div class="fluency-tips-label">${escapeHtml("💡 Next steps to level up:")}</div>${tips}</div>`;
	} else if (cat.stage === 4) {
		footer = `<div class="fluency-achieved">${escapeHtml("✅ Stage 4 achieved!")}</div>`;
	}
	return `<div class="fluency-category-card">`
		+ `<div class="fluency-category-header">`
		+ `<span class="fluency-category-label">${escapeHtml(`${cat.icon} ${cat.category}`)}</span>`
		+ `<span class="fluency-category-badge stage-${escapeHtml(String(cat.stage))}">${escapeHtml(`${getFluencyStageIcon(cat.stage)} Stage ${cat.stage}`)}</span>`
		+ `</div>`
		+ `<div class="fluency-stage-bar">${pips}</div>`
		+ footer
		+ `</div>`;
}

function fluencyDetailPanelHtml(member: TeamMemberStats): string {
	const cards = (member.fluencyCategories ?? []).map(fluencyCategoryCardHtml).join("");
	return `<div class="fluency-detail-panel">`
		+ `<div class="fluency-detail-heading">${escapeHtml("📊 Fluency Score Breakdown")}</div>`
		+ `<div class="fluency-categories-grid">${cards}</div>`
		+ `</div>`;
}

function getFluencyStageIcon(stage: number): string {
	// Return emoji icons for each stage
	const icons: Record<number, string> = {
		1: '🌱', // Skeptic
		2: '🔍', // Explorer
		3: '🤝', // Collaborator
		4: '🎯'  // Strategist
	};
	return icons[stage] || '❓';
}

function markdownToHtml(text: string): string {
	const escaped = escapeHtml(text);
	return escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** Render a tip string as HTML, handling markdown links and multi-line repo lists. */
function renderTipHtml(tip: string): string {
	if (!tip.includes('\n')) {
		return markdownToHtml(tip);
	}
	const lines = tip.split('\n').filter(line => line.trim());
	const summary = markdownToHtml(lines[0]);
	const hasHeader = lines.length > 1 && lines[1].toLowerCase().includes('top repos');
	if (hasHeader && lines.length > 2) {
		const header = escapeHtml(lines[1]);
		const listItems = lines.slice(2).map(item => `<li>${escapeHtml(item)}</li>`).join('');
		return `${summary}<div style="margin-top:8px;font-weight:600;font-size:11px;color:#999;">${header}</div><ul style="margin:6px 0 0 0;padding-left:18px;list-style:disc;">${listItems}</ul>`;
	}
	return lines.map(line => markdownToHtml(line)).join('<br>');
}

/** Builds the tab navigation bar shown when both Azure and Team Server are configured. */
function buildTabNav(): HTMLElement {
  const nav = el("div", "tab-nav");
  nav.setAttribute("role", "tablist");

  const azureTab = el("button", "tab-btn tab-btn-active", "☁️ Azure Dashboard") as HTMLButtonElement;
  azureTab.id = "tab-azure";
  azureTab.dataset.tab = "azure";
  azureTab.setAttribute("role", "tab");
  azureTab.setAttribute("aria-controls", "azure-content");
  azureTab.setAttribute("aria-selected", "true");
  azureTab.tabIndex = 0;

  const teamServerTab = el("button", "tab-btn", "🖥️ Team Server") as HTMLButtonElement;
  teamServerTab.id = "tab-team-server";
  teamServerTab.dataset.tab = "teamServer";
  teamServerTab.setAttribute("role", "tab");
  teamServerTab.setAttribute("aria-controls", "team-server-content");
  teamServerTab.setAttribute("aria-selected", "false");
  teamServerTab.tabIndex = -1;

  nav.append(azureTab, teamServerTab);
  return nav;
}

/** Wires tab click handlers to show/hide the Azure and Team Server panels. */
function wireTabNav(
  tabNav: HTMLElement,
  azureContent: HTMLElement,
  footer: HTMLElement,
  teamServerPanel: HTMLElement,
): void {
  const tabs = tabNav.querySelectorAll<HTMLButtonElement>(".tab-btn");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.remove("tab-btn-active");
        t.setAttribute("aria-selected", String(t === tab));
        t.tabIndex = t === tab ? 0 : -1;
      });
      tab.classList.add("tab-btn-active");
      const isTeamServer = tab.dataset.tab === "teamServer";
      azureContent.style.display = isTeamServer ? "none" : "";
      footer.style.display = isTeamServer ? "none" : "";
      teamServerPanel.style.display = isTeamServer ? "" : "none";
    });
    tab.addEventListener("keydown", (event) => {
      const index = Array.from(tabs).indexOf(tab);
      let nextIndex: number;
      switch (event.key) {
        case "ArrowRight": nextIndex = (index + 1) % tabs.length; break;
        case "ArrowLeft": nextIndex = (index - 1 + tabs.length) % tabs.length; break;
        case "Home": nextIndex = 0; break;
        case "End": nextIndex = tabs.length - 1; break;
        default: return;
      }
      event.preventDefault();
      tabs[nextIndex].focus();
      tabs[nextIndex].click();
    });
  });
}

/** Builds the team server launch card (no iframe -- VS Code webviews don't share
 *  browser cookie/session state, so OAuth-gated pages cannot be embedded). */
function buildTeamServerPanel(url: string): HTMLElement {
  const panel = el("div", "team-server-panel");

  const card = el("div", "team-server-card");
  card.id = "section-team-server";

  const header = el("div", "config-card-header");
  const icon = el("span", "config-card-icon", "🖥️");
  const heading = el("span", "config-card-heading", "Team Server Dashboard");
  header.append(icon, heading);

  const urlEl = el("div", "team-server-card-url", url);

  const openBtn = createButton("btn-open-team-server", "↗ Open Team Server in Browser", "secondary") as HTMLButtonElement;
  openBtn.addEventListener("click", () => {
    vscode.postMessage({ command: "openExternal", url });
  });

  const note = el(
    "p",
    "team-server-card-note",
    "The team server dashboard uses GitHub OAuth for authentication. " +
    "VS Code webviews run in an isolated sandbox that cannot share browser sessions, " +
    "so the dashboard opens in your default browser instead.",
  );

  card.append(header, urlEl, openBtn, note);
  panel.append(card);
  return panel;
}

/** Shows the team-server view, optionally retaining an Azure Storage failure message. */
function showTeamServerView(url: string, failureMessage?: string): void {
  loadingTextEl = null;
  const root = document.getElementById("root");
  if (!root) { return; }

  root.replaceChildren();

  const themeStyle = document.createElement("style");
  themeStyle.textContent = `${themeStyles}\n${dataTableStyles}`;
  const style = document.createElement("style");
  style.textContent = styles;

  const container = el("div", "container");
  const header = el("div", "header");
  const title = el("div", "title", "📊 Team Dashboard");
  const buttonRow = el("div", "button-row");
  buttonRow.append(...getNavButtons("btn-dashboard", true)
    .filter((button) => button.id !== "btn-refresh")
    .map((button) => createButton(button)));
  header.append(title, buttonRow);

  const panel = buildTeamServerPanel(url);

  container.append(header);
  if (failureMessage) {
    container.append(buildDashboardFailure(failureMessage));
  }
  container.append(panel);
  root.append(themeStyle, style, container);
  wireButtons();
}

function wireButtons(): void {
  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    vscode.postMessage({ command: "refresh" });
  });

  document
    .getElementById("btn-configure-backend")
    ?.addEventListener("click", () => {
      vscode.postMessage({ command: "configureBackend" });
    });

  document.getElementById("btn-details")?.addEventListener("click", () => {
    vscode.postMessage({ command: "showDetails" });
  });

  document.getElementById("btn-chart")?.addEventListener("click", () => {
    vscode.postMessage({ command: "showChart" });
  });

  document.getElementById("btn-usage")?.addEventListener("click", () => {
    vscode.postMessage({ command: "showUsageAnalysis" });
  });

  document.getElementById("btn-diagnostics")?.addEventListener("click", () => {
    vscode.postMessage({ command: "showDiagnostics" });
  });

  document.getElementById("btn-maturity")?.addEventListener("click", () => {
    vscode.postMessage({ command: "showMaturity" });
  });
  document.getElementById("btn-environmental")?.addEventListener("click", () => {
    vscode.postMessage({ command: "showEnvironmental" });
  });
  document.getElementById("btn-efficiency")?.addEventListener("click", () => {
    vscode.postMessage({ command: "showEfficiency" });
  });

  // Note: No dashboard button handler - users are already on the dashboard
  wireExtensionPointButtons(vscode);
}

// Listen for messages from the extension
registerMessageHandler((message: any) => {
  switch (message.command) {
    case "dashboardData":
      console.log(
        "Dashboard data received:",
        JSON.stringify(message.data.team, null, 2),
      );
      render(message.data);
      break;
    case "dashboardLoading":
      showLoading();
      break;
    case "dashboardError":
      showError(message.message);
      break;
    case "dashboardTeamServerFallback": {
      showTeamServerView(message.url, message.message);
      break;
    }
    case "backfillProgress": {
      const progressText = message.text ?? "Backfill in progress...";
      if (!loadingTextEl) {
        showLoading(); // ensures loadingTextEl is set
      }
      const textEl = loadingTextEl;
      if (textEl) {
        textEl.textContent = progressText;
      }
      break;
    }
  }
});

async function bootstrap(): Promise<void> {
  console.log("[CopilotTokenTracker] dashboard bootstrap called");
  await import('@vscode-elements/elements/dist/vscode-button/index.js');

  currentConfig = window.__DASHBOARD_CONFIG__ ?? null;

  if (initialData) {
    render(initialData);
  } else if (currentConfig?.teamServerConfigured && !currentConfig.azureConfigured) {
    // Team server only — show iframe immediately, no Azure data needed
    showTeamServerView(currentConfig.teamServerUrl);
  } else {
    showLoading();
  }
}

bootstrap().catch((err) => {
  console.error("[CopilotTokenTracker] Failed to bootstrap dashboard:", err);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = "Failed to initialize dashboard.";
  }
});
