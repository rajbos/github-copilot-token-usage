// Import shared utilities
import { getModelDisplayName, isCustomProviderGroup } from '../../../../src/webview/shared/modelUtils';
import { getCharsPerToken, formatFixed, formatPercent, formatNumber, formatCost, formatCompact, setCompactNumbers, escapeHtml } from '../shared/formatUtils';
import { el, createButton, iconHeading, setHtml } from '../shared/domUtils';
import { getNavButtons } from '../shared/buttonConfig';
import { wireExtensionPointButtons } from '../shared/extensionPoints';
import { localize } from '../shared/localization';
import { buildEditorLogo, syncLogoTheme } from '../shared/editorLogos';
import { applyWebviewLocale } from '../shared/webviewLocale';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import dataTableStyles from '../shared/dataTable.css';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import { registerMessageHandler } from '../shared/messageHandler';
import type { ModelUsage } from '../shared/types';
import { getBillingGroup } from '../../../../src/chartDataBuilder';
import { ALL_PERIODS, getAllProviders, getFilterableProviders, getActiveExcludedProviders } from './providerFilter';
import { installSurfaceNavigation } from '../shared/surfaceNavigation';
import { renderDataTable, rerenderDataTable, setDataTableState, type DataTableColumn, type DataTableOptions, type DataTableRowOptions, type DataTableState } from '../shared/dataTable';

type EditorUsage = Record<string, { tokens: number; sessions: number }>;
type TableSortKey = 'name' | 'today' | 'last30Days' | 'month' | 'lastMonth' | 'projected';
type SortDir = 'asc' | 'desc';

type PeriodStats = {
tokens: number;
thinkingTokens: number;
estimatedTokens: number;
actualTokens: number;
sessions: number;
avgInteractionsPerSession: number;
avgTokensPerSession: number;
modelUsage: ModelUsage;
editorUsage: EditorUsage;
co2: number;
treesEquivalent: number;
waterUsage: number;
estimatedCost: number;
estimatedCostCopilot?: number;
cachedTokens?: number;
/**
 * Estimated cost per billing group (e.g. "GitHub Copilot", "Anthropic", "Google")
 * for this period in USD. Used to show/filter cost across all providers, not just
 * GitHub Copilot's UBB billing.
 */
billingGroupCosts?: Record<string, number>;
/** Per-editor model usage breakdown, used to determine which billing group(s) an editor/model belongs to for provider filtering. */
editorModelUsage?: { [editor: string]: ModelUsage };
/** Number of sessions in this period that delegated work to sub-agents (1+ sub-agent tool calls). Absent when zero. */
subAgentSessions?: number;
};

type DetailedStats = {
today: PeriodStats;
month: PeriodStats;
lastMonth: PeriodStats;
last30Days: PeriodStats;
lastUpdated: string | Date;
backendConfigured?: boolean;
compactNumbers?: boolean;
sortSettings?: {
editor?: { key?: string; dir?: string };
model?: { key?: string; dir?: string };
modelOtherExpanded?: boolean;
editorOtherExpanded?: boolean;
/** Whether the "Usage by Editor" section is collapsed (its table hidden). Persisted across sessions. */
editorSectionCollapsed?: boolean;
/** Billing-group (provider) names that the user has unchecked in the cost provider filter. */
excludedProviders?: string[];
};
};

/** Strongly-typed messages sent from the webview to the extension host. */
type WebviewMessage =
| { command: 'refresh' }
| { command: 'showChart' }
| { command: 'showUsageAnalysis' }
| { command: 'showDiagnostics' }
| { command: 'showMaturity' }
| { command: 'showDashboard' }
| { command: 'showEnvironmental' }
| { command: 'showEfficiency' }
| { command: 'saveSortSettings'; settings: {
editor: { key: TableSortKey; dir: SortDir };
model: { key: TableSortKey; dir: SortDir };
modelOtherExpanded: boolean;
editorOtherExpanded: boolean;
editorSectionCollapsed: boolean;
excludedProviders: string[];
}};

/** Aggregated projection values calculated from last-30-days data. */
type Projections = {
projectedTokens: number;
projectedSessions: number;
projectedCo2: number;
projectedWater: number;
projectedCost: number;
projectedCostCopilot?: number;
projectedTrees: number;
};

// VS Code injects this in the webview environment
declare function acquireVsCodeApi<TState = unknown>(): {
postMessage: (message: WebviewMessage) => void;
setState: (newState: TState) => void;
getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

declare global {
	interface Window {
		Chart?: unknown;
	}
}

const vscode: VSCodeApi = acquireVsCodeApi();
installSurfaceNavigation(vscode, 'details');
const initialData = getWindowData<DetailedStats & { localization?: Record<string, string> }>('__INITIAL_DETAILS__');
console.log('[CopilotTokenTracker] details webview loaded');

// Initialize localization for webview
applyWebviewLocale(initialData);

const TABLE_SORT_KEYS: readonly TableSortKey[] = ['name', 'today', 'last30Days', 'month', 'lastMonth', 'projected'];
const METRICS_TABLE_ID = 'details-key-metrics';
const EDITOR_TABLE_ID = 'details-editor-usage';
const MODEL_TABLE_ID = 'details-model-usage';

function toSortKey(value: string | null | undefined): TableSortKey {
return TABLE_SORT_KEYS.find(key => key === value) ?? 'name';
}

function toSortDir(value: string | null | undefined): SortDir {
return value === 'desc' ? 'desc' : 'asc';
}

const _initSort = initialData?.sortSettings;
let editorSortKey: TableSortKey = toSortKey(_initSort?.editor?.key);
let editorSortDir: SortDir = toSortDir(_initSort?.editor?.dir);
let modelSortKey: TableSortKey = toSortKey(_initSort?.model?.key);
let modelSortDir: SortDir = toSortDir(_initSort?.model?.dir);
// Restore the persisted sort before the tables first render; the tables own it from then on.
setDataTableState(EDITOR_TABLE_ID, { sortColumn: editorSortKey, sortDirection: editorSortDir });
setDataTableState(MODEL_TABLE_ID, { sortColumn: modelSortKey, sortDirection: modelSortDir });
let modelOtherExpanded: boolean = (_initSort?.modelOtherExpanded) ?? false;
let editorOtherExpanded: boolean = (_initSort?.editorOtherExpanded) ?? false;
let editorSectionCollapsed: boolean = (_initSort?.editorSectionCollapsed) ?? false;
/** Billing-group (provider) names deselected in the "Cost by Provider" filter. Empty = all providers included. */
let excludedProviders: Set<string> = new Set(_initSort?.excludedProviders ?? []);
/** The subset of `excludedProviders` that applies to the current render — see `getActiveExcludedProviders`. */
let activeExcludedProviders: Set<string> = new Set();
/** Last rendered stats, kept so provider-filter toggles can trigger a full re-render. */
let lastStats: DetailedStats | null = null;

function calculateProjection(last30DaysValue: number): number {
// Project annual value based on last 30 days average
// This gives better predictions at the beginning of the month
const daysInYear = 365.25; // Average days per year (accounting for leap year cycle)
return (last30DaysValue / 30) * daysInYear;
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

type PeriodKey = Exclude<TableSortKey, 'name'>;

/** The period columns shared by the Key Metrics, Editor and Model tables. */
const PERIOD_COLUMNS: ReadonlyArray<{ key: PeriodKey; icon: string; text: string }> = [
{ key: 'today', icon: '📅', text: 'Today' },
{ key: 'last30Days', icon: '📈', text: 'Last 30 Days' },
{ key: 'month', icon: '🗓️', text: 'Current Month' },
{ key: 'lastMonth', icon: '📆', text: 'Previous Month' },
{ key: 'projected', icon: '🌍', text: 'Projected Year' },
];

function columnHeaderHtml(icon: string, text: string): string {
return `<span aria-hidden="true">${icon}</span> ${escapeHtml(text)}`;
}

/** Header, alignment and id of a right-aligned period column. */
function periodColumnBase(key: PeriodKey): { id: string; label: string; headerHtml: string; align: 'right' } {
const def = PERIOD_COLUMNS.find(column => column.key === key) ?? PERIOD_COLUMNS[0];
return { id: key, label: def.text, headerHtml: columnHeaderHtml(def.icon, def.text), align: 'right' };
}

/** A right-aligned value with an optional muted sub-text line. */
function valueCellHtml(mainValue: string, subText?: string): string {
return escapeHtml(mainValue) + (subText === undefined ? '' : `<div class="muted">${escapeHtml(subText)}</div>`);
}

/** An icon + label cell, with an optional colour for the icon and an optional tooltip hint. */
function metricLabelHtml(icon: string, label: string, color?: string, tooltip?: string): string {
const iconStyle = color ? ` style="color:${escapeHtml(color)}"` : '';
const labelAttrs = tooltip ? ` class="metric-label metric-label-help" title="${escapeHtml(tooltip)}"` : ' class="metric-label"';
const hint = tooltip ? '<span class="metric-hint"> ℹ️</span>' : '';
return `<span${labelAttrs}><span${iconStyle}>${escapeHtml(icon)}</span><span>${escapeHtml(label)}${hint}</span></span>`;
}

/** Re-registers a table with freshly computed options and re-renders it in place, keeping focus. */
function refreshDataTable<Row>(options: DataTableOptions<Row>): void {
renderDataTable(options);
rerenderDataTable(options.tableId);
}

/** Copies a table's sort into the persisted editor/model sort; returns whether it changed. */
function applyTableSort(table: 'editor' | 'model', state: Readonly<DataTableState>): boolean {
const key = toSortKey(state.sortColumn);
const dir = state.sortDirection;
if (table === 'editor') {
if (key === editorSortKey && dir === editorSortDir) { return false; }
editorSortKey = key;
editorSortDir = dir;
return true;
}
if (key === modelSortKey && dir === modelSortDir) { return false; }
modelSortKey = key;
modelSortDir = dir;
return true;
}

/**
 * Renders a top-N usage table into `container`. Its rows depend on the sort (which items are
 * "top N" and how the "Other" children are ordered), so `buildOptions` recomputes them; a click
 * on the "Other" row (`data-other-toggle`) shows or hides the items it groups.
 */
function mountUsageTable<Row>(container: HTMLElement, buildOptions: () => DataTableOptions<Row>, toggleOther: () => void): void {
setHtml(container, renderDataTable(buildOptions()));
container.addEventListener('click', event => {
const target = event.target instanceof Element ? event.target : null;
if (!target?.closest('tr[data-other-toggle]')) { return; }
toggleOther();
saveSortSettings();
refreshDataTable(buildOptions());
});
}

/** "📦 Other (N …)" label with its expand/collapse chevron. */
function otherGroupLabelHtml(label: string, expanded: boolean): string {
return `<span class="metric-label"><span class="other-group-name">${escapeHtml(`📦 ${label}`)}</span><span class="other-group-toggle">${escapeHtml(` ${expanded ? '▲' : '▼'}`)}</span></span>`;
}

/** Rows of a top-N table: the top items (sortable), the "Other" summary, and its expanded items. */
type UsageRowKind = 'top' | 'other' | 'otherChild';

/** Sort value for top-N rows only; `null` keeps "Other" and its children last, in their given order. */
function topRowSortValue<Row extends { kind: UsageRowKind }>(value: (row: Row) => string | number): (row: Row) => string | number | null {
return row => (row.kind === 'top' ? value(row) : null);
}

// ---------------------------------------------------------------------------
// Core rendering
// ---------------------------------------------------------------------------

function render(stats: DetailedStats): void {
setCompactNumbers(stats.compactNumbers !== false);
syncLogoTheme();
lastStats = stats;
const root = document.getElementById('root');
if (!root) { return; }

activeExcludedProviders = getActiveExcludedProviders(excludedProviders, getFilterableProviders(stats));

const allProviders = getAllProviders(stats);
const projectedTokens = Math.round(calculateProjection(stats.last30Days.tokens + stats.last30Days.thinkingTokens));
const projectedSessions = Math.round(calculateProjection(stats.last30Days.sessions));
const projectedCo2 = calculateProjection(stats.last30Days.co2);
const projectedWater = calculateProjection(stats.last30Days.waterUsage);
const projectedCost = calculateProjection(totalCostForPeriod(stats.last30Days, allProviders));
const projectedCostCopilot = calculateProjection(stats.last30Days.estimatedCostCopilot ?? 0);
const projectedTrees = calculateProjection(stats.last30Days.treesEquivalent);

renderShell(root, stats, {
projectedTokens,
projectedSessions,
projectedCo2,
projectedWater,
projectedCost,
projectedCostCopilot,
projectedTrees
});

wireButtons();
}

/** Re-renders using the last stats payload — used after the provider filter changes. */
function rerenderFromLastStats(): void {
if (lastStats) { render(lastStats); }
}

function renderShell(
root: HTMLElement,
stats: DetailedStats,
projections: Projections
): void {
const lastUpdated = new Date(stats.lastUpdated);

root.replaceChildren();

// Inject theme styles first, then component styles
const themeStyle = document.createElement('style');
themeStyle.textContent = `${themeStyles}\n${dataTableStyles}`;

const style = document.createElement('style');
style.textContent = styles;

const container = el('div', 'container');
const header = el('div', 'header');
const headerLeft = el('div', 'header-left');
headerLeft.append(el('div', 'title', 'AI Engineering Fluency'));
const buttonRow = el('div', 'button-row');

buttonRow.append(...getNavButtons('btn-details', !!stats.backendConfigured).map(config => createButton(config)));

header.append(headerLeft, buttonRow);

const footer = el('div', 'footer', `Last updated: ${lastUpdated.toLocaleString()} · Updates every 5 minutes`);

const sections = el('div', 'sections');

const isEmptyState = (stats.today.tokens ?? 0) === 0 && (stats.last30Days.tokens ?? 0) === 0 && (stats.lastMonth.tokens ?? 0) === 0;
if (isEmptyState) {
sections.append(buildEmptyStateSection());
} else {
const providerPanel = buildProviderPanel(stats);
if (providerPanel) {
sections.append(providerPanel);
}
}

sections.append(buildMetricsSection(stats, projections));

const editorSection = buildEditorUsageSection(stats);
if (editorSection) {
sections.append(editorSection);
}

const modelSection = buildModelUsageSection(stats);
if (modelSection) {
sections.append(modelSection);
}

container.append(header, sections, footer);
root.append(themeStyle, style, container);
}

type MetricRow = { label: string; labelTooltip?: string; icon: string; color?: string; today: string; last30Days: string; month: string; lastMonth: string; projected: string };

function sumInputTokens(p: PeriodStats): number {
	return Object.values(p.modelUsage).reduce((s, m) => s + m.inputTokens, 0);
}

function sumOutputTokens(p: PeriodStats): number {
	return Object.values(p.modelUsage).reduce((s, m) => s + m.outputTokens, 0);
}

function hasActualTokens(p: PeriodStats): boolean {
	return (p.actualTokens || 0) > 0;
}

function serviceOverheadPct(p: PeriodStats): string {
	return hasActualTokens(p) ? formatPercent(((p.actualTokens - p.estimatedTokens) / p.actualTokens) * 100) : '—';
}

function inputTokenCell(p: PeriodStats): string {
	return hasActualTokens(p) ? formatCompact(sumInputTokens(p)) : '—';
}

function outputTokenCell(p: PeriodStats): string {
	return hasActualTokens(p) ? formatCompact(sumOutputTokens(p)) : '—';
}

function totalTokenCell(p: PeriodStats): string {
	const modelTotal = sumInputTokens(p) + sumOutputTokens(p);
	if ((p.actualTokens ?? 0) > 0) {
		return formatCompact(p.tokens + p.thinkingTokens);
	}
	return formatCompact(modelTotal > 0 ? modelTotal : p.tokens);
}

function buildCachedTokenRow(stats: DetailedStats): MetricRow[] {
	if (!(stats.today.cachedTokens || stats.last30Days.cachedTokens || stats.month.cachedTokens || stats.lastMonth.cachedTokens)) {
		return [];
	}
	return [{ label: 'Cached tokens', labelTooltip: 'Cache-read tokens — already included in "Input tokens" above, shown separately because they are billed at a lower rate.', icon: '⚡', color: '#34d399', today: formatCompact(stats.today.cachedTokens || 0), last30Days: formatCompact(stats.last30Days.cachedTokens || 0), month: formatCompact(stats.month.cachedTokens || 0), lastMonth: formatCompact(stats.lastMonth.cachedTokens || 0), projected: '—' }];
}

type MetricGroup = { heading: string; rows: MetricRow[] };

/** Builds the all/selected-providers cost row (empty when GitHub Copilot is the only provider). */
function buildProvidersCostRows(stats: DetailedStats, projections: Projections, allProviders: string[]): MetricRow[] {
	// With GitHub Copilot as the only provider the "selected providers" row is just a
	// duplicate of the Copilot UBB row below it, so drop it — same reasoning as the
	// "Cost by Provider" panel hiding itself when there is nothing to compare.
	// Only mention the provider filter when the "Cost by Provider" panel is actually shown —
	// otherwise the tooltip points at a filter that does not exist (issue #2198).
	const hasProviderFilter = getFilterableProviders(stats).length > 0;
	const providersCostLabel = hasProviderFilter ? 'Estimated cost (selected providers)' : 'Estimated cost (all providers)';
	const providersCostTooltip = hasProviderFilter
		? 'Sum of estimated cost across the providers selected in the Cost by Provider section — GitHub Copilot uses UBB AI Credit rates, other providers use their own API pricing.'
		: 'Sum of estimated cost across all providers — GitHub Copilot uses UBB AI Credit rates, other providers (e.g. Claude Code, even on a subscription) use their own API pricing as an API-equivalent estimate.';
	return isCopilotOnlyProviders(allProviders) ? [] : [
		{ label: providersCostLabel, labelTooltip: providersCostTooltip, icon: '💵', color: '#7ce38b', today: formatCost(totalCostForPeriod(stats.today, allProviders)), last30Days: formatCost(totalCostForPeriod(stats.last30Days, allProviders)), month: formatCost(totalCostForPeriod(stats.month, allProviders)), lastMonth: formatCost(totalCostForPeriod(stats.lastMonth, allProviders)), projected: formatCost(projections.projectedCost) },
	];
}

function buildMetricsGroups(stats: DetailedStats, projections: Projections): MetricGroup[] {
	const allProviders = getAllProviders(stats);
	const tokenRows: MetricRow[] = [
		{ label: 'Total tokens', labelTooltip: 'All LLM API tokens counted across every call in this period — matches the status bar. When debug logs are available this is the definitive total; otherwise it falls back to per-model attribution or the text-based estimate.', icon: '🟣', color: '#c37bff', today: totalTokenCell(stats.today), last30Days: totalTokenCell(stats.last30Days), month: totalTokenCell(stats.month), lastMonth: totalTokenCell(stats.lastMonth), projected: formatCompact(projections.projectedTokens) },
		{ label: 'Input tokens', labelTooltip: 'Total prompt tokens sent to the model, including any cache-read tokens (shown separately below).', icon: '⬆️', color: '#c37bff', today: inputTokenCell(stats.today), last30Days: inputTokenCell(stats.last30Days), month: inputTokenCell(stats.month), lastMonth: inputTokenCell(stats.lastMonth), projected: '—' },
		{ label: 'Output tokens', icon: '⬇️', color: '#c37bff', today: outputTokenCell(stats.today), last30Days: outputTokenCell(stats.last30Days), month: outputTokenCell(stats.month), lastMonth: outputTokenCell(stats.lastMonth), projected: '—' },
		...buildCachedTokenRow(stats),
		{ label: 'Tokens (user estimated)', icon: '📝', color: '#b39ddb', today: formatCompact(stats.today.estimatedTokens), last30Days: formatCompact(stats.last30Days.estimatedTokens), month: formatCompact(stats.month.estimatedTokens), lastMonth: formatCompact(stats.lastMonth.estimatedTokens), projected: '—' },
		{ label: 'Service overhead %', icon: '☁️', color: '#90a4ae', today: serviceOverheadPct(stats.today), last30Days: serviceOverheadPct(stats.last30Days), month: serviceOverheadPct(stats.month), lastMonth: serviceOverheadPct(stats.lastMonth), projected: '—' },
		{ label: 'Thinking tokens', icon: '🧠', color: '#a78bfa', today: formatCompact(stats.today.thinkingTokens || 0), last30Days: formatCompact(stats.last30Days.thinkingTokens || 0), month: formatCompact(stats.month.thinkingTokens || 0), lastMonth: formatCompact(stats.lastMonth.thinkingTokens || 0), projected: '—' },
	];
	const selectedProvidersCostRows = buildProvidersCostRows(stats, projections, allProviders);
	const costRows: MetricRow[] = [
		...selectedProvidersCostRows,
		{ label: 'Estimated cost (GitHub Copilot UBB)', labelTooltip: 'Based on GitHub Copilot AI Credit rates (1 credit = $0.01) — this is what Copilot will bill you. UBB = Usage Based Billing.', icon: '🟢', color: '#7ce38b', today: formatCost(stats.today.estimatedCostCopilot ?? 0), last30Days: formatCost(stats.last30Days.estimatedCostCopilot ?? 0), month: formatCost(stats.month.estimatedCostCopilot ?? 0), lastMonth: formatCost(stats.lastMonth.estimatedCostCopilot ?? 0), projected: formatCost(projections.projectedCostCopilot ?? 0) },
	];
	const activityRows: MetricRow[] = [
		{ label: 'Sessions', icon: '📂', color: '#66aaff', today: formatNumber(stats.today.sessions), last30Days: formatNumber(stats.last30Days.sessions), month: formatNumber(stats.month.sessions), lastMonth: formatNumber(stats.lastMonth.sessions), projected: formatNumber(projections.projectedSessions) },
		{ label: 'Sessions with sub-agents', labelTooltip: 'Sessions that delegated work to sub-agents in this period (task/read_agent/write_agent/list_agents, runSubagent, delegate_* tool calls detected in the session logs).', icon: '🤖', color: '#66aaff', today: formatNumber(stats.today.subAgentSessions ?? 0), last30Days: formatNumber(stats.last30Days.subAgentSessions ?? 0), month: formatNumber(stats.month.subAgentSessions ?? 0), lastMonth: formatNumber(stats.lastMonth.subAgentSessions ?? 0), projected: '—' },
		{ label: 'Average interactions/session', icon: '💬', color: '#8ce0ff', today: formatNumber(stats.today.avgInteractionsPerSession), last30Days: formatNumber(stats.last30Days.avgInteractionsPerSession), month: formatNumber(stats.month.avgInteractionsPerSession), lastMonth: formatNumber(stats.lastMonth.avgInteractionsPerSession), projected: '—' },
		{ label: 'Average tokens/session', icon: '🔢', color: '#7ce38b', today: formatCompact(stats.today.avgTokensPerSession), last30Days: formatCompact(stats.last30Days.avgTokensPerSession), month: formatCompact(stats.month.avgTokensPerSession), lastMonth: formatCompact(stats.lastMonth.avgTokensPerSession), projected: '—' },
	];
	return [
		{ heading: '🔢 Tokens', rows: tokenRows },
		{ heading: '💰 Cost', rows: costRows },
		{ heading: '💬 Activity', rows: activityRows },
	];
}

type MetricTableRow = MetricRow & { group: string };

function buildMetricsSection(
stats: DetailedStats,
projections: Projections
): HTMLElement {
const section = el('div', 'section');
section.id = 'section-key-metrics';
section.append(iconHeading('h3', 'graph', 'Key Metrics'));
const rows: MetricTableRow[] = buildMetricsGroups(stats, projections)
.flatMap(group => group.rows.map(row => ({ ...row, group: group.heading })));
const columns: DataTableColumn<MetricTableRow>[] = [
{ id: 'metric', label: 'Metric', headerHtml: columnHeaderHtml('📊', 'Metric'), render: row => ({ html: metricLabelHtml(row.icon, row.label, row.color, row.labelTooltip) }) },
...PERIOD_COLUMNS.map(({ key }): DataTableColumn<MetricTableRow> => ({ ...periodColumnBase(key), render: row => row[key] })),
];
const tableContainer = el('div');
// Not sortable: rows mix units (tokens, %, $), so only the fixed metric order is meaningful.
setHtml(tableContainer, renderDataTable({
tableId: METRICS_TABLE_ID,
ariaLabel: 'Key Metrics',
rows,
columns,
groupBy: { key: row => row.group, label: key => key },
pageSize: false,
className: 'data-table--fixed',
}));
section.append(tableContainer);
return section;
}

// ---------------------------------------------------------------------------
// Cost by Provider section
// ---------------------------------------------------------------------------

/** Emoji shown next to each billing-group/provider name in the provider panel. */
const PROVIDER_ICONS: Record<string, string> = {
	'GitHub Copilot': '🐙',
	'Anthropic': '🅰️',
	'Google': '🔷',
	'OpenAI': '🟢',
	'Mistral AI': '🌬️',
	'xAI': '✖️',
	'Microsoft': '🪟',
	'Alibaba': '🐉',
	'Other': '❔',
};

function getProviderIcon(provider: string): string {
	if (PROVIDER_ICONS[provider]) { return PROVIDER_ICONS[provider]; }
	// User-configured custom endpoints ("Mistral (Custom)") share one icon.
	return isCustomProviderGroup(provider) ? '🧩' : '💵';
}

/** Builds a single clickable provider card; clicking toggles it in/out of `excludedProviders`. */
function buildProviderCard(stats: DetailedStats, provider: string): HTMLElement {
	const isExcluded = excludedProviders.has(provider);
	const card = el('div', `provider-card${isExcluded ? ' provider-card-excluded' : ''}`);
	card.tabIndex = 0;
	card.setAttribute('role', 'button');
	card.setAttribute('aria-pressed', String(!isExcluded));
	card.title = isExcluded
		? `${provider} is hidden — click to show it again and include it in the totals below.`
		: `Click to hide ${provider} — filters it out of the totals and the Editor/Model usage lists below.`;

	card.append(
		el('div', 'provider-card-label', `${getProviderIcon(provider)} ${provider}`),
		el('div', 'provider-card-value', formatCost(stats.month.billingGroupCosts?.[provider] || 0)),
		el('div', 'provider-card-sub', 'Cost this month')
	);

	const toggle = (): void => {
		if (excludedProviders.has(provider)) { excludedProviders.delete(provider); } else { excludedProviders.add(provider); }
		saveSortSettings();
		rerenderFromLastStats();
	};
	card.addEventListener('click', toggle);
	card.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
	});
	return card;
}

/** Builds the non-interactive "Total (selected)" card summarizing the currently included providers. */
function buildProviderTotalCard(stats: DetailedStats, allProviders: string[]): HTMLElement {
	const included = includedProviders(allProviders);
	const card = el('div', 'provider-card provider-card-total');
	card.title = `Sum of ${included.length} of ${allProviders.length} selected provider(s).`;
	card.append(
		el('div', 'provider-card-label', '∑ Total (selected)'),
		el('div', 'provider-card-value', formatCost(sumBillingGroupCosts(stats.month.billingGroupCosts, included))),
		el('div', 'provider-card-sub', 'Cost this month')
	);
	return card;
}

/**
 * Builds the "Cost by Provider" panel shown at the top of the page (replacing the old
 * fixed hero cards). Each provider is a clickable card — clicking toggles it in/out of
 * `excludedProviders`, which also filters the "Usage by Editor" and "Model Usage" lists
 * further down the page to just the selected provider(s).
 */
function buildProviderPanel(stats: DetailedStats): HTMLElement | null {
	const providersWithMonthlyCost = getFilterableProviders(stats);
	if (providersWithMonthlyCost.length === 0) { return null; }

	const section = el('div', 'section');
	section.id = 'section-cost-by-provider';
	section.append(iconHeading('h3', 'credit-card', 'Cost by Provider'));
	section.append(el('div', 'provider-panel-hint', 'Click a provider to hide/show it — this also filters the Editor & Model usage lists below.'));

	const grid = el('div', 'provider-cards');
	grid.append(buildProviderTotalCard(stats, providersWithMonthlyCost));
	providersWithMonthlyCost.forEach(provider => grid.append(buildProviderCard(stats, provider)));
	section.append(grid);
	return section;
}

function saveSortSettings(): void {
vscode.postMessage({
command: 'saveSortSettings',
settings: {
editor: { key: editorSortKey, dir: editorSortDir },
model: { key: modelSortKey, dir: modelSortDir },
modelOtherExpanded,
editorOtherExpanded,
editorSectionCollapsed,
excludedProviders: Array.from(excludedProviders)
}
});
}

// ---------------------------------------------------------------------------
// Cost-by-provider helpers
// ---------------------------------------------------------------------------

/**
 * Whether GitHub Copilot is the only provider in play — either it is the single billing
 * group seen, or there is no billing-group breakdown at all (older cached stats, which
 * fall back to the Copilot-only estimate).
 */
function isCopilotOnlyProviders(allProviders: string[]): boolean {
	return allProviders.every(p => p === 'GitHub Copilot');
}

/** Providers currently selected (not filtered out) from the given full provider list. */
function includedProviders(allProviders: string[]): string[] {
return allProviders.filter(p => !activeExcludedProviders.has(p));
}

/** Sums the billing-group costs for the given providers only. */
function sumBillingGroupCosts(billingGroupCosts: Record<string, number> | undefined, providers: string[]): number {
if (!billingGroupCosts) { return 0; }
return providers.reduce((s, p) => s + (billingGroupCosts[p] || 0), 0);
}

/**
 * Total estimated cost for a period across the currently selected providers.
 * Falls back to the legacy Copilot-only estimate when no billing-group breakdown
 * is available (e.g. stale cached data from an older extension version).
 */
function totalCostForPeriod(period: PeriodStats, allProviders: string[]): number {
if (allProviders.length === 0) {
return period.estimatedCostCopilot ?? period.estimatedCost ?? 0;
}
return sumBillingGroupCosts(period.billingGroupCosts, includedProviders(allProviders));
}

/** Billing group(s) an editor's usage falls into, derived from its per-model breakdown across all periods. */
function editorBillingGroups(stats: DetailedStats, editor: string): Set<string> {
	const groups = new Set<string>();
	ALL_PERIODS.forEach(period => {
		const modelUsage = stats[period].editorModelUsage?.[editor];
		if (modelUsage) { Object.keys(modelUsage).forEach(model => groups.add(getBillingGroup(editor, model))); }
	});
	return groups;
}

/** Billing group(s) a model belongs to, derived from every editor that used it across all periods. */
function modelBillingGroups(stats: DetailedStats, model: string): Set<string> {
	const groups = new Set<string>();
	ALL_PERIODS.forEach(period => {
		const editorModelUsage = stats[period].editorModelUsage;
		if (!editorModelUsage) { return; }
		Object.keys(editorModelUsage).forEach(editor => {
			if (editorModelUsage[editor][model]) { groups.add(getBillingGroup(editor, model)); }
		});
	});
	return groups;
}

/**
 * Whether an item (editor or model) should remain visible given the current provider filter.
 * With nothing excluded, everything is visible. When we have no billing-group data for the
 * item (e.g. older cached stats), it is never hidden — we only filter what we can attribute.
 */
function isVisibleForProviderFilter(groups: Set<string>): boolean {
	if (activeExcludedProviders.size === 0) { return true; }
	if (groups.size === 0) { return true; }
	return Array.from(groups).some(g => !activeExcludedProviders.has(g));
}

type EditorItem = {
	editor: string;
	todayUsage: { tokens: number; sessions: number };
	last30DaysUsage: { tokens: number; sessions: number };
	monthUsage: { tokens: number; sessions: number };
	lastMonthUsage: { tokens: number; sessions: number };
	projectedTokens: number;
	projectedSessions: number;
	/** Present when this item represents the aggregated "Other" group rather than a single editor. */
	otherEditors?: string[];
};

function toEditorItem(stats: DetailedStats, editor: string): EditorItem {
	const todayUsage = stats.today.editorUsage[editor] || { tokens: 0, sessions: 0 };
	const last30DaysUsage = stats.last30Days.editorUsage[editor] || { tokens: 0, sessions: 0 };
	const monthUsage = stats.month.editorUsage[editor] || { tokens: 0, sessions: 0 };
	const lastMonthUsage = stats.lastMonth.editorUsage[editor] || { tokens: 0, sessions: 0 };
	return { editor, todayUsage, last30DaysUsage, monthUsage, lastMonthUsage, projectedTokens: Math.round(calculateProjection(last30DaysUsage.tokens)), projectedSessions: Math.round(calculateProjection(last30DaysUsage.sessions)) };
}

/** Aggregated pseudo-item for the "Other" editors group, so it can be sorted alongside individual editors instead of always trailing the top-N list. */
function toOtherEditorItem(stats: DetailedStats, otherEditors: string[]): EditorItem {
	const sumUsage = (period: 'today' | 'last30Days' | 'month' | 'lastMonth') =>
		otherEditors.reduce((acc, e) => {
			const u = stats[period].editorUsage[e] || { tokens: 0, sessions: 0 };
			return { tokens: acc.tokens + u.tokens, sessions: acc.sessions + u.sessions };
		}, { tokens: 0, sessions: 0 });
	const todayUsage = sumUsage('today');
	const last30DaysUsage = sumUsage('last30Days');
	const monthUsage = sumUsage('month');
	const lastMonthUsage = sumUsage('lastMonth');
	return {
		editor: `Other (${otherEditors.length} editor${otherEditors.length !== 1 ? 's' : ''})`,
		todayUsage, last30DaysUsage, monthUsage, lastMonthUsage,
		projectedTokens: Math.round(calculateProjection(last30DaysUsage.tokens)),
		projectedSessions: Math.round(calculateProjection(last30DaysUsage.sessions)),
		otherEditors,
	};
}

function sortEditorItems(items: EditorItem[]): void {
	items.sort((a, b) => {
		let cmp: number;
		switch (editorSortKey) {
			case 'name': cmp = a.editor.localeCompare(b.editor); break;
			case 'today': cmp = a.todayUsage.tokens - b.todayUsage.tokens; break;
			case 'last30Days': cmp = a.last30DaysUsage.tokens - b.last30DaysUsage.tokens; break;
			case 'month': cmp = a.monthUsage.tokens - b.monthUsage.tokens; break;
			case 'lastMonth': cmp = a.lastMonthUsage.tokens - b.lastMonthUsage.tokens; break;
			case 'projected': cmp = a.projectedTokens - b.projectedTokens; break;
			default: cmp = 0;
		}
		return editorSortDir === 'asc' ? cmp : -cmp;
	});
}

/** Sort editors by the currently selected column for the purpose of deciding which ones are "top N".
 *  Unlike the table sort, this is always descending for numeric columns (so the largest values are
 *  shown individually) and ascending for the name column, regardless of the user's sort direction. */
function sortEditorsBySignificance(stats: DetailedStats, editors: string[]): string[] {
	return [...editors].sort((a, b) => {
		if (editorSortKey === 'name') {
			return a.localeCompare(b);
		}
		const aItem = toEditorItem(stats, a);
		const bItem = toEditorItem(stats, b);
		let cmp: number;
		switch (editorSortKey) {
			case 'today': cmp = aItem.todayUsage.tokens - bItem.todayUsage.tokens; break;
			case 'last30Days': cmp = aItem.last30DaysUsage.tokens - bItem.last30DaysUsage.tokens; break;
			case 'month': cmp = aItem.monthUsage.tokens - bItem.monthUsage.tokens; break;
			case 'lastMonth': cmp = aItem.lastMonthUsage.tokens - bItem.lastMonthUsage.tokens; break;
			case 'projected': cmp = aItem.projectedTokens - bItem.projectedTokens; break;
			default: cmp = 0;
		}
		return -cmp || a.localeCompare(b);
	});
}

type EditorRow = EditorItem & { kind: UsageRowKind };
type EditorTotals = { today: number; last30Days: number; month: number; lastMonth: number };

/** Editors whose token counts come with a caveat, shown as the row tooltip. */
const EDITOR_TOOLTIPS: ReadonlyMap<string, string> = new Map([
['JetBrains', 'JetBrains: only user messages + assistant text are persisted, so token counts here are estimates of those alone. Actual API counts and thinking tokens are not available.'],
['Antigravity', 'Antigravity: token counts are estimated from transcript content. Actual API counts are not stored locally.'],
['Cursor', 'Cursor: token counts reflect the context window size at the last request (contextTokensUsed). Output tokens are not stored locally.'],
]);

/**
 * The top N editors for the currently selected column, then an aggregated "Other" row that always
 * stays last (so it doesn't get interleaved among the editors it summarizes), then — when expanded —
 * the editors it groups, sorted by the current column.
 */
function buildEditorRows(stats: DetailedStats, editors: string[]): EditorRow[] {
const sortedBySignificance = sortEditorsBySignificance(stats, editors);
const otherEditors = sortedBySignificance.slice(TOP_N_EDITORS);
const rows: EditorRow[] = sortedBySignificance.slice(0, TOP_N_EDITORS).map(editor => ({ ...toEditorItem(stats, editor), kind: 'top' as const }));
if (otherEditors.length > 0) {
rows.push({ ...toOtherEditorItem(stats, otherEditors), kind: 'other' });
if (editorOtherExpanded) {
const children = otherEditors.map(editor => toEditorItem(stats, editor));
sortEditorItems(children);
rows.push(...children.map(child => ({ ...child, kind: 'otherChild' as const })));
}
}
return rows;
}

function editorNameHtml(row: EditorRow): string {
if (row.kind === 'other') { return otherGroupLabelHtml(row.editor, editorOtherExpanded); }
const indent = row.kind === 'otherChild' ? '<span class="other-child-indent"></span>' : '';
const info = EDITOR_TOOLTIPS.has(row.editor) ? ' ⓘ' : '';
return `<span class="metric-label">${indent}${buildEditorLogo(row.editor).outerHTML}${escapeHtml(` ${row.editor}${info}`)}</span>`;
}

function editorColumns(totals: EditorTotals): DataTableColumn<EditorRow>[] {
const pct = (part: number, total: number): number => (total > 0 ? (part / total) * 100 : 0);
const periodColumn = (key: Exclude<PeriodKey, 'projected'>, pick: (row: EditorRow) => { tokens: number; sessions: number }): DataTableColumn<EditorRow> => ({
...periodColumnBase(key),
sortValue: topRowSortValue((row: EditorRow) => pick(row).tokens),
render: row => {
const usage = pick(row);
return { html: valueCellHtml(formatCompact(usage.tokens), `${formatPercent(pct(usage.tokens, totals[key]))} · ${usage.sessions} sessions`) };
},
});
return [
{ id: 'name', label: 'Editor', headerHtml: columnHeaderHtml('📝', 'Editor'), sortValue: topRowSortValue((row: EditorRow) => row.editor), render: row => ({ html: editorNameHtml(row) }) },
periodColumn('today', row => row.todayUsage),
periodColumn('last30Days', row => row.last30DaysUsage),
periodColumn('month', row => row.monthUsage),
periodColumn('lastMonth', row => row.lastMonthUsage),
{
...periodColumnBase('projected'),
sortValue: topRowSortValue((row: EditorRow) => row.projectedTokens),
render: row => ({ html: valueCellHtml(formatCompact(row.projectedTokens), `${row.projectedSessions} sessions`) }),
},
];
}

function editorRowOptions(row: EditorRow): DataTableRowOptions | undefined {
if (row.kind === 'other') {
return { className: 'other-group-row', attributes: { 'data-other-toggle': 'editor', title: editorOtherExpanded ? 'Collapse other editors' : 'Expand other editors' } };
}
const tooltip = EDITOR_TOOLTIPS.get(row.editor);
return { className: row.kind === 'otherChild' ? 'other-child-row' : undefined, attributes: tooltip ? { title: tooltip } : undefined };
}

function editorTableOptions(stats: DetailedStats, editors: string[]): DataTableOptions<EditorRow> {
const totals: EditorTotals = {
today: editors.reduce((s, e) => s + (stats.today.editorUsage[e]?.tokens || 0), 0),
last30Days: editors.reduce((s, e) => s + (stats.last30Days.editorUsage[e]?.tokens || 0), 0),
month: editors.reduce((s, e) => s + (stats.month.editorUsage[e]?.tokens || 0), 0),
lastMonth: editors.reduce((s, e) => s + (stats.lastMonth.editorUsage[e]?.tokens || 0), 0),
};
return {
tableId: EDITOR_TABLE_ID,
ariaLabel: 'Usage by Editor',
rows: buildEditorRows(stats, editors),
columns: editorColumns(totals),
initialSort: { columnId: 'name', direction: 'asc' },
className: 'data-table--fixed',
emptyMessage: 'No editor usage matches the selected provider filter.',
rowOptions: editorRowOptions,
onStateChange: state => {
// A new sort column changes which editors are "top N", so recompute the rows.
if (!applyTableSort('editor', state)) { return; }
saveSortSettings();
refreshDataTable(editorTableOptions(stats, editors));
},
};
}

/** Wires the collapsible "Usage by Editor" section heading: toggles the table's visibility, syncs ARIA state and the localized tooltip, and supports keyboard activation (Enter/Space) since the heading carries role="button". The collapsed state is persisted via saveSortSettings(). */
function wireEditorSectionToggle(heading: HTMLElement, table: HTMLElement, chevron: HTMLElement): void {
const toggleEditorSection = (): void => {
editorSectionCollapsed = !editorSectionCollapsed;
table.classList.toggle('hidden', editorSectionCollapsed);
chevron.textContent = editorSectionCollapsed ? '\u25b8' : '\u25be';
heading.setAttribute('aria-expanded', String(!editorSectionCollapsed));
heading.title = editorSectionCollapsed ? localize('details.editorSection.show') : localize('details.editorSection.hide');
saveSortSettings();
};
heading.addEventListener('click', toggleEditorSection);
heading.addEventListener('keydown', (event: KeyboardEvent) => {
if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
event.preventDefault();
toggleEditorSection();
}
});
}

const TOP_N_EDITORS = 5;

function buildEditorUsageSection(stats: DetailedStats): HTMLElement | null {
const allEditors = new Set([
...Object.keys(stats.today.editorUsage),
...Object.keys(stats.last30Days.editorUsage),
...Object.keys(stats.month.editorUsage),
...Object.keys(stats.lastMonth.editorUsage)
]);

if (allEditors.size === 0) {
return null;
}

const visibleEditors = Array.from(allEditors).filter(editor => isVisibleForProviderFilter(editorBillingGroups(stats, editor)));

const section = el('div', 'section');
section.id = 'section-editor-usage';
const heading = iconHeading('h3', 'device-desktop', 'Usage by Editor');
heading.classList.add('section-heading-collapsible');
heading.setAttribute('role', 'button');
heading.setAttribute('tabindex', '0');
heading.setAttribute('aria-expanded', String(!editorSectionCollapsed));
heading.setAttribute('aria-controls', 'editor-usage-table');
const chevron = el('span', 'section-heading-chevron', editorSectionCollapsed ? '\u25b8' : '\u25be');
heading.title = editorSectionCollapsed ? localize('details.editorSection.show') : localize('details.editorSection.hide');
heading.append(chevron);
section.append(heading);

const tableContainer = el('div');
tableContainer.id = 'editor-usage-table';
mountUsageTable(tableContainer, () => editorTableOptions(stats, visibleEditors), () => { editorOtherExpanded = !editorOtherExpanded; });
if (editorSectionCollapsed) { tableContainer.classList.add('hidden'); }
section.append(tableContainer);

wireEditorSectionToggle(heading, tableContainer, chevron);

return section;
}

const TOP_N_MODELS = 5;

type ModelItem = {
	model: string;
	todayTotal: number; todayInputPct: number; todayOutputPct: number;
	last30DaysTotal: number; last30DaysInputPct: number; last30DaysOutputPct: number;
	monthTotal: number; monthInputPct: number; monthOutputPct: number;
	lastMonthTotal: number; lastMonthInputPct: number; lastMonthOutputPct: number;
	projected: number; charsPerToken: number;
	/** Present when this item represents the aggregated "Other" group rather than a single model. */
	otherModels?: string[];
};

function toModelItem(stats: DetailedStats, model: string): ModelItem {
	const todayUsage = stats.today.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
	const last30DaysUsage = stats.last30Days.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
	const monthUsage = stats.month.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
	const lastMonthUsage = stats.lastMonth.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
	const todayTotal = todayUsage.inputTokens + todayUsage.outputTokens;
	const last30DaysTotal = last30DaysUsage.inputTokens + last30DaysUsage.outputTokens;
	const monthTotal = monthUsage.inputTokens + monthUsage.outputTokens;
	const lastMonthTotal = lastMonthUsage.inputTokens + lastMonthUsage.outputTokens;
	return {
		model, todayTotal,
		todayInputPct: todayTotal > 0 ? (todayUsage.inputTokens / todayTotal) * 100 : 0,
		todayOutputPct: todayTotal > 0 ? (todayUsage.outputTokens / todayTotal) * 100 : 0,
		last30DaysTotal,
		last30DaysInputPct: last30DaysTotal > 0 ? (last30DaysUsage.inputTokens / last30DaysTotal) * 100 : 0,
		last30DaysOutputPct: last30DaysTotal > 0 ? (last30DaysUsage.outputTokens / last30DaysTotal) * 100 : 0,
		monthTotal,
		monthInputPct: monthTotal > 0 ? (monthUsage.inputTokens / monthTotal) * 100 : 0,
		monthOutputPct: monthTotal > 0 ? (monthUsage.outputTokens / monthTotal) * 100 : 0,
		lastMonthTotal,
		lastMonthInputPct: lastMonthTotal > 0 ? (lastMonthUsage.inputTokens / lastMonthTotal) * 100 : 0,
		lastMonthOutputPct: lastMonthTotal > 0 ? (lastMonthUsage.outputTokens / lastMonthTotal) * 100 : 0,
		projected: Math.round(calculateProjection(last30DaysTotal)), charsPerToken: getCharsPerToken(model),
	};
}

/** Aggregated pseudo-item for the "Other" models group, so it can be sorted alongside individual models instead of always trailing the top-N list. */
function toOtherModelItem(stats: DetailedStats, otherModels: string[]): ModelItem {
	const sumUsage = (period: 'today' | 'last30Days' | 'month' | 'lastMonth') =>
		otherModels.reduce((acc, m) => {
			const u = stats[period].modelUsage[m] || { inputTokens: 0, outputTokens: 0 };
			return { inputTokens: acc.inputTokens + u.inputTokens, outputTokens: acc.outputTokens + u.outputTokens };
		}, { inputTokens: 0, outputTokens: 0 });
	const todayUsage = sumUsage('today'); const last30DaysUsage = sumUsage('last30Days');
	const monthUsage = sumUsage('month'); const lastMonthUsage = sumUsage('lastMonth');
	const todayTotal = todayUsage.inputTokens + todayUsage.outputTokens;
	const last30DaysTotal = last30DaysUsage.inputTokens + last30DaysUsage.outputTokens;
	const monthTotal = monthUsage.inputTokens + monthUsage.outputTokens;
	const lastMonthTotal = lastMonthUsage.inputTokens + lastMonthUsage.outputTokens;
	return {
		model: `Other (${otherModels.length} model${otherModels.length !== 1 ? 's' : ''})`,
		todayTotal,
		todayInputPct: todayTotal > 0 ? (todayUsage.inputTokens / todayTotal) * 100 : 0,
		todayOutputPct: todayTotal > 0 ? (todayUsage.outputTokens / todayTotal) * 100 : 0,
		last30DaysTotal,
		last30DaysInputPct: last30DaysTotal > 0 ? (last30DaysUsage.inputTokens / last30DaysTotal) * 100 : 0,
		last30DaysOutputPct: last30DaysTotal > 0 ? (last30DaysUsage.outputTokens / last30DaysTotal) * 100 : 0,
		monthTotal,
		monthInputPct: monthTotal > 0 ? (monthUsage.inputTokens / monthTotal) * 100 : 0,
		monthOutputPct: monthTotal > 0 ? (monthUsage.outputTokens / monthTotal) * 100 : 0,
		lastMonthTotal,
		lastMonthInputPct: lastMonthTotal > 0 ? (lastMonthUsage.inputTokens / lastMonthTotal) * 100 : 0,
		lastMonthOutputPct: lastMonthTotal > 0 ? (lastMonthUsage.outputTokens / lastMonthTotal) * 100 : 0,
		projected: Math.round(calculateProjection(last30DaysTotal)), charsPerToken: 0,
		otherModels,
	};
}

function sortModelItems(items: ModelItem[]): void {
	items.sort((a, b) => {
		let cmp: number;
		switch (modelSortKey) {
			case 'name': cmp = a.model.localeCompare(b.model); break;
			case 'today': cmp = a.todayTotal - b.todayTotal; break;
			case 'last30Days': cmp = a.last30DaysTotal - b.last30DaysTotal; break;
			case 'month': cmp = a.monthTotal - b.monthTotal; break;
			case 'lastMonth': cmp = a.lastMonthTotal - b.lastMonthTotal; break;
			case 'projected': cmp = a.projected - b.projected; break;
			default: cmp = 0;
		}
		return modelSortDir === 'asc' ? cmp : -cmp;
	});
}

/** Sort models by the currently selected column for the purpose of deciding which ones are "top N".
 *  Unlike the table sort, this is always descending for numeric columns (so the largest values are
 *  shown individually) and ascending for the name column, regardless of the user's sort direction. */
function sortModelsBySignificance(stats: DetailedStats, models: string[]): string[] {
	return [...models].sort((a, b) => {
		if (modelSortKey === 'name') {
			return a.localeCompare(b);
		}
		const aItem = toModelItem(stats, a);
		const bItem = toModelItem(stats, b);
		let cmp: number;
		switch (modelSortKey) {
			case 'today': cmp = aItem.todayTotal - bItem.todayTotal; break;
			case 'last30Days': cmp = aItem.last30DaysTotal - bItem.last30DaysTotal; break;
			case 'month': cmp = aItem.monthTotal - bItem.monthTotal; break;
			case 'lastMonth': cmp = aItem.lastMonthTotal - bItem.lastMonthTotal; break;
			case 'projected': cmp = aItem.projected - bItem.projected; break;
			default: cmp = 0;
		}
		return -cmp || a.localeCompare(b);
	});
}

type ModelRow = ModelItem & { kind: UsageRowKind };

/** Same top-N / "Other" / expanded-children layout as `buildEditorRows`. */
function buildModelRows(stats: DetailedStats, models: string[]): ModelRow[] {
const sortedBySignificance = sortModelsBySignificance(stats, models);
const otherModels = sortedBySignificance.slice(TOP_N_MODELS);
const rows: ModelRow[] = sortedBySignificance.slice(0, TOP_N_MODELS).map(model => ({ ...toModelItem(stats, model), kind: 'top' as const }));
if (otherModels.length > 0) {
rows.push({ ...toOtherModelItem(stats, otherModels), kind: 'other' });
if (modelOtherExpanded) {
const children = otherModels.map(model => toModelItem(stats, model));
sortModelItems(children);
rows.push(...children.map(child => ({ ...child, kind: 'otherChild' as const })));
}
}
return rows;
}

function modelNameHtml(row: ModelRow): string {
if (row.kind === 'other') { return otherGroupLabelHtml(row.model, modelOtherExpanded); }
const indent = row.kind === 'otherChild' ? '<span class="other-child-indent"></span>' : '';
return `<span class="metric-label">${indent}${escapeHtml(`${getModelDisplayName(row.model)} `)}<span class="model-chars-per-token">${escapeHtml(`(~${row.charsPerToken.toFixed(1)} chars/tk)`)}</span></span>`;
}

function modelColumns(): DataTableColumn<ModelRow>[] {
const periodColumn = (key: Exclude<PeriodKey, 'projected'>, pick: (row: ModelRow) => { total: number; inputPct: number; outputPct: number }): DataTableColumn<ModelRow> => ({
...periodColumnBase(key),
sortValue: topRowSortValue((row: ModelRow) => pick(row).total),
render: row => {
const { total, inputPct, outputPct } = pick(row);
// The "Other" row omits the input/output split when the group has no tokens in the period.
const split = row.kind === 'other' && total <= 0 ? undefined : `↑${formatPercent(inputPct)} ↓${formatPercent(outputPct)}`;
return { html: valueCellHtml(formatCompact(total), split) };
},
});
return [
{ id: 'name', label: 'Model', headerHtml: columnHeaderHtml('🧠', 'Model'), sortValue: topRowSortValue((row: ModelRow) => row.model), render: row => ({ html: modelNameHtml(row) }) },
periodColumn('today', row => ({ total: row.todayTotal, inputPct: row.todayInputPct, outputPct: row.todayOutputPct })),
periodColumn('last30Days', row => ({ total: row.last30DaysTotal, inputPct: row.last30DaysInputPct, outputPct: row.last30DaysOutputPct })),
periodColumn('month', row => ({ total: row.monthTotal, inputPct: row.monthInputPct, outputPct: row.monthOutputPct })),
periodColumn('lastMonth', row => ({ total: row.lastMonthTotal, inputPct: row.lastMonthInputPct, outputPct: row.lastMonthOutputPct })),
{ ...periodColumnBase('projected'), sortValue: topRowSortValue((row: ModelRow) => row.projected), render: row => ({ html: valueCellHtml(formatCompact(row.projected)) }) },
];
}

function modelRowOptions(row: ModelRow): DataTableRowOptions | undefined {
if (row.kind === 'other') {
return { className: 'other-group-row', attributes: { 'data-other-toggle': 'model', title: modelOtherExpanded ? 'Collapse other models' : 'Expand other models' } };
}
return row.kind === 'otherChild' ? { className: 'other-child-row' } : undefined;
}

function modelTableOptions(stats: DetailedStats, models: string[]): DataTableOptions<ModelRow> {
return {
tableId: MODEL_TABLE_ID,
ariaLabel: 'Model Usage (Tokens)',
rows: buildModelRows(stats, models),
columns: modelColumns(),
initialSort: { columnId: 'name', direction: 'asc' },
className: 'data-table--fixed',
emptyMessage: 'No model usage matches the selected provider filter.',
rowOptions: modelRowOptions,
onStateChange: state => {
// A new sort column changes which models are "top N", so recompute the rows.
if (!applyTableSort('model', state)) { return; }
saveSortSettings();
refreshDataTable(modelTableOptions(stats, models));
},
};
}

function buildModelUsageSection(stats: DetailedStats): HTMLElement | null {
const allModels = new Set([
...Object.keys(stats.today.modelUsage),
...Object.keys(stats.last30Days.modelUsage),
...Object.keys(stats.month.modelUsage),
...Object.keys(stats.lastMonth.modelUsage)
]);

if (allModels.size === 0) {
return null;
}

const visibleModels = new Set(Array.from(allModels).filter(model => isVisibleForProviderFilter(modelBillingGroups(stats, model))));

const section = el('div', 'section');
section.id = 'section-model-usage';
const heading = iconHeading('h3', 'symbol-numeric', 'Model Usage (Tokens)');
section.append(heading);

const tableContainer = el('div');
mountUsageTable(tableContainer, () => modelTableOptions(stats, Array.from(visibleModels)), () => { modelOtherExpanded = !modelOtherExpanded; });
section.append(tableContainer);
return section;
}

function buildEmptyStateSection(): HTMLElement {
const section = el('div', 'section');
const inner = el('div', 'empty-state');

const title = el('div', 'empty-state-title', '👋 Welcome to AI Engineering Fluency');

const desc = el('p', 'empty-state-description',
'This extension tracks AI token usage by reading session log files stored locally by supported tools. No token data has been found yet.'
);

const toolsLabel = document.createElement('p');
toolsLabel.className = 'empty-state-description';
const toolsLabelStrong = document.createElement('strong');
toolsLabelStrong.textContent = 'Supported tools & editors:';
toolsLabel.append(toolsLabelStrong);

const toolsList = document.createElement('ul');
toolsList.className = 'empty-state-steps';
const toolsTexts = [
'🚀 Antigravity — Google\'s Gemini-powered desktop IDE',
'🤖 Claude Code — Anthropic\'s CLI coding agent',
'💻 Copilot CLI — GitHub Copilot in the terminal',
'🖱️ Cursor, 🌊 Windsurf — built-in AI chat',
'💎 Gemini CLI — Google\'s open-source CLI coding agent',
'🟢 OpenCode, 🦀 Crush — terminal-based coding agents',
'π Pi — Mistral-powered terminal coding agent',
'🖥️ Visual Studio 2022+ — GitHub Copilot Chat extension',
'💙 VS Code / VS Code Insiders / VSCodium — GitHub Copilot Chat extension',
];
toolsTexts.forEach(text => {
const li = document.createElement('li');
li.textContent = text;
toolsList.append(li);
});

const stepsLabel = document.createElement('p');
stepsLabel.className = 'empty-state-description';
const stepsLabelStrong = document.createElement('strong');
stepsLabelStrong.textContent = 'To get started:';
stepsLabel.append(stepsLabelStrong);

const steps = document.createElement('ol');
steps.className = 'empty-state-steps';
const stepTexts = [
'Use any of the supported tools or editors listed above to interact with an AI model.',
'For GitHub Copilot in VS Code: open the Copilot Chat panel (Ctrl+Alt+I / Cmd+Alt+I) and start a conversation.',
'For terminal agents (Claude Code, Gemini CLI, Antigravity, Pi, OpenCode, Copilot CLI): run a coding session in your terminal.',
'Click the 🔄 Refresh button above to reload the stats after your first session.',
];
stepTexts.forEach(text => {
const li = document.createElement('li');
li.textContent = text;
steps.append(li);
});

const note = el('div', 'empty-state-note',
'💡 If you have been using one of the supported tools but still see no data, open the Diagnostics panel (🔍 Diagnostics button above) to verify that session files are being discovered correctly.'
);

inner.append(title, desc, toolsLabel, toolsList, stepsLabel, steps, note);
section.append(inner);
return section;
}

function buildEstimatesSection(): HTMLElement {
const section = el('div', 'section');
const heading = iconHeading('h3', 'lightbulb', 'Calculation & Estimates');
section.append(heading);

const notes = document.createElement('ul');
notes.className = 'notes';

const items = [
'Cost (UBB) uses GitHub Copilot AI Credit rates (1 credit = $0.01) — this is what you are billed under Usage Based Billing.',
'"Estimated cost (all/selected providers)" and the Total card sum estimated spend across the currently included providers (GitHub Copilot, Anthropic, Google, OpenAI, …) — all of them by default; when the Cost by Provider section is shown, click a provider card there to include/exclude it. Non-Copilot providers (e.g. Claude Code) are priced at their public API rates as an API-equivalent estimate, even when you use them through a flat-rate subscription.',
'Estimated CO₂ is based on ~0.2 g CO₂e per 1,000 tokens.',
'Estimated water usage is based on ~0.3 L per 1,000 tokens.',
'Tree equivalent represents the fraction of a single mature tree\'s annual CO₂ absorption (~21 kg/year).'
];

items.forEach(text => {
const li = document.createElement('li');
li.textContent = text;
notes.append(li);
});

section.append(notes);
return section;
}

function wireButtons(): void {
const refresh = document.getElementById('btn-refresh');
const chart = document.getElementById('btn-chart');
const usage = document.getElementById('btn-usage');
const diagnostics = document.getElementById('btn-diagnostics');

refresh?.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
chart?.addEventListener('click', () => vscode.postMessage({ command: 'showChart' }));
usage?.addEventListener('click', () => vscode.postMessage({ command: 'showUsageAnalysis' }));
diagnostics?.addEventListener('click', () => vscode.postMessage({ command: 'showDiagnostics' }));

const maturity = document.getElementById('btn-maturity');
maturity?.addEventListener('click', () => vscode.postMessage({ command: 'showMaturity' }));

const dashboard = document.getElementById('btn-dashboard');
dashboard?.addEventListener('click', () => vscode.postMessage({ command: 'showDashboard' }));

const environmental = document.getElementById('btn-environmental');
environmental?.addEventListener('click', () => vscode.postMessage({ command: 'showEnvironmental' }));

const efficiency = document.getElementById('btn-efficiency');
efficiency?.addEventListener('click', () => vscode.postMessage({ command: 'showEfficiency' }));

// Cast to the looser signature required by the shared wireExtensionPointButtons utility,
// which posts extension-point-specific messages not modelled in WebviewMessage.
wireExtensionPointButtons(vscode as { postMessage: (message: unknown) => void });
}

async function bootstrap(): Promise<void> {
console.log('[CopilotTokenTracker] bootstrap called');
await import('@vscode-elements/elements/dist/vscode-button/index.js');
await import('@vscode-elements/elements/dist/vscode-badge/index.js');

if (initialData) {
console.log('[CopilotTokenTracker] Rendering details with initialData:', initialData);
render(initialData);
} else {
console.warn('[CopilotTokenTracker] No initialData found, rendering fallback.');
const root = document.getElementById('root');
if (root) {
root.textContent = '';
const fallback = document.createElement('div');
fallback.style.padding = '16px';
fallback.style.color = '#e7e7e7';
fallback.textContent = 'No data available.';
root.append(fallback);
}
}
}

// Listen for background stat updates from the extension
registerMessageHandler<{ command: string; data?: DetailedStats }>((message) => {
	if (message.command === 'updateStats') {
		render(message.data as DetailedStats);
	}
});

void bootstrap();
