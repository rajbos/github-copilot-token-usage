// @ts-nocheck // Chart.js ESM bundle is loaded dynamically; skip CJS resolution noise
import { el, createButton, iconHeading } from '../shared/domUtils';
import { getNavButtons } from '../shared/buttonConfig';
import { formatCompact, setCompactNumbers } from '../shared/formatUtils';
import { buildEditorLogo, syncLogoTheme } from '../shared/editorLogos';
import { wireExtensionPointButtons } from '../shared/extensionPoints';
import { createPeriodSelector, PERIOD_LABELS } from '../shared/periodSelector';
import { getCurrentPeriodFraction, computeProjectionExtra } from './projectionUtils';
import { createViewStateManager } from '../shared/viewState';
import { applyWebviewLocale } from '../shared/webviewLocale';
import type { ChartTimeWindow } from '../../../../src/types';
import { filterPeriodByTimeWindow } from './timeWindowFilter';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import dataTableStyles from '../shared/dataTable.css';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import { registerMessageHandler } from '../shared/messageHandler';
import { installSurfaceNavigation } from '../shared/surfaceNavigation';

type ChartModule = typeof import('chart.js/auto');
type ChartConstructor = ChartModule['default'];
type ChartInstance = InstanceType<ChartConstructor>;
type ChartConfig = import('chart.js').ChartConfiguration<'bar' | 'line', number[], string>;

type ModelDataset = { label: string; data: number[]; backgroundColor: string; borderColor: string; borderWidth: number };
type EditorDataset = ModelDataset;
type RepositoryDataset = ModelDataset & { fullRepo?: string };

type ChartPeriodData = {
	labels: string[];
	periodKeys?: string[];
	tokensData: number[];
	sessionsData: number[];
	modelDatasets: ModelDataset[];
	editorDatasets: EditorDataset[];
	repositoryDatasets: RepositoryDataset[];
	taskCategoryDatasets?: ModelDataset[];
	taskCategoryTokenDatasets?: ModelDataset[];
	taskCategorySessionDatasets?: ModelDataset[];
	taskCategoryCostDatasets?: ModelDataset[];
	periodCount: number;
	totalTokens: number;
	totalSessions: number;
	avgPerPeriod: number;
	costData: number[];
	totalCost: number;
	avgCostPerPeriod: number;
	locData?: number[];
	linesAddedData?: number[];
	linesRemovedData?: number[];
	languageDatasets?: ModelDataset[];
	locEditorDatasets?: ModelDataset[];
	locRepositoryDatasets?: RepositoryDataset[];
	totalLinesAdded?: number;
	totalLinesRemoved?: number;
	avgLocPerPeriod?: number;
	editorCostDatasets?: ModelDataset[];
	billingGroupCostDatasets?: ModelDataset[];
	modelCostDatasets?: ModelDataset[];
	modelSessionsDatasets?: ModelDataset[];
	editorSessionsDatasets?: ModelDataset[];
	providerSessionsDatasets?: ModelDataset[];
	providerTokensDatasets?: ModelDataset[];
};

type ChartPeriod = import('./projectionUtils').ChartPeriod;

type InitialChartData = {
	labels: string[];
	tokensData: number[];
	sessionsData: number[];
	modelDatasets: ModelDataset[];
	editorDatasets: EditorDataset[];
	repositoryDatasets: RepositoryDataset[];
	editorTotalsMap: Record<string, number>;
	repositoryTotalsMap: Record<string, number>;
	dailyCount: number;
	totalTokens: number;
	avgTokensPerDay: number;
	totalSessions: number;
	lastUpdated: string;
	backendConfigured?: boolean;
	compactNumbers?: boolean;
	monthlyCostBudget?: number;
	periodsReady?: boolean;
	hasLocData?: boolean;
	initialPeriod?: ChartPeriod;
	initialTimeWindow?: ChartTimeWindow;
	initialView?: 'total' | 'model' | 'editor' | 'repository' | 'cost' | 'task' | 'taskCategory';
	initialMetric?: 'tokens' | 'output' | 'cost' | 'sessions';
	initialSplit?: 'total' | 'model' | 'editor' | 'repository' | 'language' | 'provider' | 'task' | 'taskCategory';
	/** Host-persisted collapsed state of "By Editor"; outlives the panel, unlike webview state. */
	initialEditorListCollapsed?: boolean;
	monthlyBudget?: number;
	periods?: {
		day: ChartPeriodData;
		week: ChartPeriodData;
		month: ChartPeriodData;
	};
};

// VS Code injects this in the webview environment
declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: any) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

const vscode: VSCodeApi = acquireVsCodeApi();
installSurfaceNavigation(vscode, 'chart');
const initialData = getWindowData<InitialChartData & { localization?: Record<string, string> }>('__INITIAL_CHART__');

// Initialize localization for webview
applyWebviewLocale(initialData);

let chart: ChartInstance | undefined;
let Chart: ChartConstructor | undefined;

async function loadChartModule(): Promise<void> {
	if (Chart) {
		return;
	}
	const mod = await import('chart.js/auto');
	Chart = mod.default;
}
let currentMetric: 'tokens' | 'output' | 'cost' | 'sessions' = 'tokens';
let currentSplit: 'total' | 'model' | 'editor' | 'repository' | 'language' | 'provider' | 'task' | 'taskCategory' = 'total';
let currentPeriod: ChartPeriod = 'day';
let currentTimeWindow: ChartTimeWindow = 'last30';
// Stores state to restore after a background data update re-initializes the chart
let pendingMetric: typeof currentMetric | null = null;
let pendingSplit: typeof currentSplit | null = null;
let pendingPeriod: ChartPeriod | null = null;

type DisplayMode = 'actual' | 'rolling';
let currentDisplayMode: DisplayMode = 'actual';

type ChartWebviewState = {
	period: ChartPeriod;
	timeWindow: ChartTimeWindow;
	metric: 'tokens' | 'output' | 'cost' | 'sessions';
	split: 'total' | 'model' | 'editor' | 'repository' | 'language' | 'provider' | 'task' | 'taskCategory';
	displayMode: DisplayMode;
	/** Whether the per-editor breakdown cards under the Summary section are collapsed. */
	editorListCollapsed: boolean;
	/** @deprecated Use metric + split instead. Kept for migration of old saved state. */
	view?: 'total' | 'model' | 'editor' | 'repository' | 'cost' | 'task' | 'taskCategory';
};

const chartState = createViewStateManager<ChartWebviewState>(vscode, {
	period: 'day',
	timeWindow: 'last30',
	metric: 'tokens',
	split: 'total',
	displayMode: 'actual',
	editorListCollapsed: false,
});

let editorListCollapsed = false;

function saveWebviewState(): void {
	chartState.save({ period: currentPeriod, timeWindow: currentTimeWindow, metric: currentMetric, split: currentSplit, displayMode: currentDisplayMode, editorListCollapsed });
}

const ROLLING_WINDOW: Record<ChartPeriod, number> = { day: 7, week: 4, month: 3 };

function computeRollingAverage(data: number[], window: number): number[] {
	return data.map((_, i) => {
		const start = Math.max(0, i - window + 1);
		const slice = data.slice(start, i + 1);
		return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
	});
}

function getRollingLabel(): string {
	const w = ROLLING_WINDOW[currentPeriod];
	const unit = currentPeriod === 'day' ? 'day' : currentPeriod === 'week' ? 'week' : 'month';
	return `${w}-${unit} rolling avg`;
}

function getSessionsChartTitle(): string {
	switch (currentSplit) {
		case 'model': return 'Sessions by Model';
		case 'editor': return 'Sessions by Editor';
		case 'provider': return 'Sessions by Provider';
		default: {
			let title = 'Sessions';
			if (currentDisplayMode === 'rolling') { title += ` (${getRollingLabel()})`; }
			return title;
		}
	}
}

function getChartTitle(): string {
	const periodMeta = PERIOD_LABELS[currentPeriod];
	if (currentMetric === 'sessions') {
		return getSessionsChartTitle();
	}
	if (currentMetric === 'cost') {
		let titleText: string;
		if (currentSplit === 'model') {
			titleText = periodMeta.costTitle.replace('Est. Cost', 'Est. Cost by Model');
		} else if (currentSplit === 'editor') {
			titleText = periodMeta.costTitle.replace('Est. Cost', 'Est. Cost by Editor');
		} else if (currentSplit === 'provider') {
			titleText = periodMeta.costTitle.replace('Est. Cost', 'Est. Cost by Provider');
		} else {
			titleText = periodMeta.costTitle;
		}
		if (currentDisplayMode === 'rolling' && currentSplit === 'total') {
			titleText += ` (${getRollingLabel()})`;
		}
		return titleText;
	}
	if (currentMetric === 'output') {
		return periodMeta.outputTitle;
	}
	if (currentMetric === 'sessions') {
		return periodMeta.sessionsTitle;
	}
	let titleText = periodMeta.title;
	if (currentDisplayMode === 'rolling' && currentSplit === 'total') {
		titleText += ` (${getRollingLabel()})`;
	}
	return titleText;
}

function getAggregationIndicator(): string {
	return PERIOD_LABELS[currentPeriod].aggregationLabel;
}

/** Returns period data for the current period, falling back to legacy flat fields. */
function getActivePeriodData(data: InitialChartData): ChartPeriodData {
	let period: ChartPeriodData;
	if (data.periods) {
		period = data.periods[currentPeriod];
	} else {
		period = {
			labels: data.labels,
			periodKeys: data.labels,
			tokensData: data.tokensData,
			sessionsData: data.sessionsData,
			modelDatasets: data.modelDatasets,
			editorDatasets: data.editorDatasets,
			repositoryDatasets: data.repositoryDatasets,
			periodCount: data.dailyCount,
			totalTokens: data.totalTokens,
			totalSessions: data.totalSessions,
			avgPerPeriod: data.avgTokensPerDay,
			costData: [],
			totalCost: 0,
			avgCostPerPeriod: 0,
		};
	}
	return filterPeriodByTimeWindow(period, currentTimeWindow, currentPeriod);
}

const PERIOD_LABELS: Record<ChartPeriod, { title: string; footer: string; countLabel: string; avgLabel: string; aggregationLabel: string; costTitle: string; avgCostLabel: string; outputTitle: string; avgLocLabel: string; sessionsTitle: string; avgSessionsLabel: string }> = {
	day:   { title: 'Token Usage – Last 30 Days', footer: 'Day-by-day token usage for the last 30 days', countLabel: 'Total Days', avgLabel: 'Avg Tokens / Day', aggregationLabel: 'Aggregated by Day', costTitle: 'Est. Cost – Last 30 Days', avgCostLabel: 'Avg Cost / Day', outputTitle: 'Lines of Code – Last 30 Days', avgLocLabel: 'Avg Lines / Day', sessionsTitle: 'Sessions – Last 30 Days', avgSessionsLabel: 'Avg Sessions / Day' },
	week:  { title: 'Token Usage – Last 6 Weeks', footer: 'Week-by-week token usage for the last 6 weeks', countLabel: 'Total Weeks', avgLabel: 'Avg Tokens / Week', aggregationLabel: 'Aggregated by Week', costTitle: 'Est. Cost – Last 6 Weeks', avgCostLabel: 'Avg Cost / Week', outputTitle: 'Lines of Code – Last 6 Weeks', avgLocLabel: 'Avg Lines / Week', sessionsTitle: 'Sessions – Last 6 Weeks', avgSessionsLabel: 'Avg Sessions / Week' },
	month: { title: 'Token Usage – Last 12 Months', footer: 'Monthly token usage for the last 12 months', countLabel: 'Total Months', avgLabel: 'Avg Tokens / Month', aggregationLabel: 'Aggregated by Month', costTitle: 'Est. Cost – Last 12 Months', avgCostLabel: 'Avg Cost / Month', outputTitle: 'Lines of Code – Last 12 Months', avgLocLabel: 'Avg Lines / Month', sessionsTitle: 'Sessions – Last 12 Months', avgSessionsLabel: 'Avg Sessions / Month' },
};

function isComboSupported(metric: string, split: string): boolean {
	if (metric === 'sessions') { return split === 'total' || split === 'model' || split === 'editor' || split === 'provider' || split === 'task'; }
	if (metric === 'cost') { return split === 'total' || split === 'model' || split === 'editor' || split === 'provider' || split === 'task'; }
	if (metric === 'output') { return split !== 'model' && split !== 'provider' && split !== 'task' && split !== 'taskCategory'; }
	return split !== 'language' && split !== 'provider';
}

function buildChartHeader(data: InitialChartData): HTMLElement {
	const header = el('div', 'header');
	const headerLeft = el('div', 'header-left');
	const title = el('span', 'header-title', getChartTitle());
	title.id = 'chart-title';
	headerLeft.append(el('span', 'header-icon', '📈'), title);
	const buttons = el('div', 'button-row');
	buttons.append(...getNavButtons('btn-chart', !!data.backendConfigured).map(config => createButton(config)));
	header.append(headerLeft, buttons);
	return header;
}

function getSummaryValues(periodData: ChartPeriodData, periodMeta: typeof PERIOD_LABELS[ChartPeriod]) {
	if (currentMetric === 'cost') {
		return { totalLabel: 'Total Cost (est.)', totalValue: `$${periodData.totalCost.toFixed(2)}`, avgLabel: periodMeta.avgCostLabel, avgValue: `$${periodData.avgCostPerPeriod.toFixed(2)}` };
	}
	if (currentMetric === 'output') {
		return {
			totalLabel: 'Total Lines (AI)',
			totalValue: ((periodData.totalLinesAdded ?? 0) + (periodData.totalLinesRemoved ?? 0)).toLocaleString(),
			avgLabel: periodMeta.avgLocLabel,
			avgValue: Math.round(periodData.avgLocPerPeriod ?? 0).toLocaleString()
		};
	}
	if (currentMetric === 'sessions') {
		return {
			totalLabel: 'Total Sessions',
			totalValue: periodData.totalSessions.toLocaleString(),
			avgLabel: periodMeta.avgSessionsLabel,
			avgValue: Math.round(periodData.totalSessions / Math.max(1, periodData.periodCount)).toLocaleString()
		};
	}
	return { totalLabel: 'Total Tokens', totalValue: formatCompact(periodData.totalTokens), avgLabel: periodMeta.avgLabel, avgValue: formatCompact(periodData.avgPerPeriod) };
}

function buildSummaryCards(periodData: ChartPeriodData, periodMeta: typeof PERIOD_LABELS[ChartPeriod]): HTMLElement {
	const { totalLabel, totalValue, avgLabel, avgValue } = getSummaryValues(periodData, periodMeta);
	const cards = el('div', 'cards');
	cards.id = 'summary-cards';
	cards.append(
		buildCard('card-period-count', periodMeta.countLabel, periodData.periodCount.toLocaleString()),
		buildCard('card-total-tokens', totalLabel, totalValue),
		buildCard('card-avg-tokens', avgLabel, avgValue),
		buildCard('card-total-sessions', 'Total Sessions', periodData.totalSessions.toLocaleString()),
	);
	return cards;
}

function buildPeriodToggles(periodsReady: boolean): HTMLElement {
	const periodToggles = el('div', 'period-controls');
	const label = el('span', 'period-controls-label', 'Aggregate by');
	const dayBtn = el('button', `toggle${currentPeriod === 'day' ? ' active' : ''}`, 'Day');
	dayBtn.id = 'period-day';
	dayBtn.title = 'Aggregate data by day';
	const weekBtn = el('button', `toggle${currentPeriod === 'week' ? ' active' : ''}`, 'Week');
	weekBtn.id = 'period-week';
	weekBtn.title = 'Aggregate data by week';
	const monthBtn = el('button', `toggle${currentPeriod === 'month' ? ' active' : ''}`, 'Month');
	monthBtn.id = 'period-month';
	monthBtn.title = 'Aggregate data by month';
	if (!periodsReady) {
		(weekBtn as HTMLButtonElement).disabled = true; weekBtn.title = 'Loading historical data for weekly aggregation…';
		(monthBtn as HTMLButtonElement).disabled = true; monthBtn.title = 'Loading historical data for monthly aggregation…';
	}
	periodToggles.append(label, dayBtn, weekBtn, monthBtn);
	return periodToggles;
}

function buildTimeWindowControl(data: InitialChartData): HTMLElement {
	const periodsReady = data.periodsReady !== false;
	const group = el('div', 'control-group');
	const { wrapper } = createPeriodSelector({
		id: 'time-window-select',
		selected: currentTimeWindow,
		disabled: periodsReady ? [] : ['last90', 'allTime'],
		disabledTitle: 'Full history is still loading',
		label: 'Time window:',
		onChange: (value) => { void switchTimeWindow(value as ChartTimeWindow, data); },
	});
	wrapper.classList.add('chart-time-window');
	group.append(wrapper);
	if (!periodsReady) {
		const loadingNote = el('span', 'loading-note', 'Loading history…');
		loadingNote.title = 'Full history is still loading. "Last 90 days", "All time", and weekly/monthly aggregation are not available yet.';
		group.append(loadingNote);
	}
	return group;
}

function buildMetricControl(data: InitialChartData): HTMLElement {
	const group = el('div', 'control-group');
	group.append(el('span', 'control-label', 'Metric:'));
	const tokensBtn = el('button', `toggle${currentMetric === 'tokens' ? ' active' : ''}`, 'Tokens');
	tokensBtn.id = 'metric-tokens';
	const outputBtn = el('button', `toggle${currentMetric === 'output' ? ' active' : ''}${!data.hasLocData ? ' dim' : ''}`, '✏️ Output');
	outputBtn.id = 'metric-output';
	if (!data.hasLocData) { outputBtn.title = 'No edit data available yet (VS Code edit/agent sessions only)'; }
	const costBtn = el('button', `toggle${currentMetric === 'cost' ? ' active' : ''}`, '💰 Cost');
	costBtn.id = 'metric-cost';
	const sessionsBtn = el('button', `toggle${currentMetric === 'sessions' ? ' active' : ''}`, '📊 Sessions');
	sessionsBtn.id = 'metric-sessions';
	group.append(tokensBtn, outputBtn, costBtn, sessionsBtn);
	return group;
}

function buildSplitControl(): HTMLElement {
	const group = el('div', 'control-group');
	group.append(el('span', 'control-label', 'Split:'));
	const mkSplit = (id: string, split: string, label: string, tooltip?: string) => {
		const supported = isComboSupported(currentMetric, split);
		const btn = el('button', `toggle${(currentSplit === split || (currentSplit === 'taskCategory' && split === 'task')) ? ' active' : ''}${!supported ? ' disabled' : ''}`, label);
		btn.id = id;
		if (!supported) { (btn as HTMLButtonElement).disabled = true; btn.title = `Not available for ${currentMetric} metric`; }
		else if (tooltip) { btn.title = tooltip; }
		return btn;
	};
	group.append(
		mkSplit('split-total', 'total', 'Total'),
		mkSplit('split-model', 'model', 'By Model', 'Click a model name in the chart legend to hide its data; click it again to show it.'),
		mkSplit('split-editor', 'editor', 'By Editor', 'Click an editor name in the chart legend to hide its data; click it again to show it.'),
		mkSplit('split-provider', 'provider', '🏷️ By Provider'),
		mkSplit('split-repository', 'repository', 'By Repository'),
		mkSplit('split-language', 'language', 'By Language'),
		mkSplit('split-task', 'task', 'By Task')
	);
	return group;
}

function buildRollingControl(): HTMLElement {
	const group = el('div', 'control-group');
	const rollingApplicable = currentSplit === 'total' && currentMetric !== 'output';
	const rollingBtn = el('button', `toggle${currentDisplayMode === 'rolling' ? ' active' : ''}${rollingApplicable ? '' : ' hidden'}`, '📈 Rolling Avg');
	rollingBtn.id = 'view-rolling';
	group.append(rollingBtn);
	return group;
}

function buildChartControls(data: InitialChartData): HTMLElement {
	const controls = el('div', 'chart-controls');

	const scopeRow = el('div', 'chart-controls-row scope-row');
	scopeRow.append(buildTimeWindowControl(data), el('div', 'control-group-separator'), buildPeriodToggles(data.periodsReady !== false), el('div', 'control-group-separator'), buildRollingControl());

	const metricRow = el('div', 'chart-controls-row metric-row');
	metricRow.append(buildMetricControl(data));

	const splitRow = el('div', 'chart-controls-row split-row');
	splitRow.append(buildSplitControl());

	controls.append(scopeRow, metricRow, splitRow);
	return controls;
}

function renderLayout(data: InitialChartData): void {
	setCompactNumbers(data.compactNumbers !== false);
	const root = document.getElementById('root');
	if (!root) { return; }
	root.replaceChildren();
	const themeStyle = document.createElement('style'); themeStyle.textContent = `${themeStyles}\n${dataTableStyles}`;
	const style = document.createElement('style'); style.textContent = styles;
	const periodData = getActivePeriodData(data);
	const periodMeta = PERIOD_LABELS[currentPeriod];
	const summarySection = el('div', 'section');
	summarySection.append(iconHeading('h3', 'graph', 'Summary'), buildSummaryCards(periodData, periodMeta));
	const editorSection = buildEditorSection(data.editorTotalsMap);
	if (editorSection) { summarySection.append(editorSection); }
	const chartSectionHeader = el('div', 'chart-section-header');
	chartSectionHeader.append(iconHeading('h3', 'graph-line', 'Charts'));
	const canvasWrap = el('div', 'canvas-wrap');
	const canvas = document.createElement('canvas'); canvas.id = 'token-chart'; canvasWrap.append(canvas);
	const heatmapContainer = el('div', 'heatmap-container hidden');
	heatmapContainer.id = 'heatmap-container';
	const chartShell = el('div', 'chart-shell');
	chartShell.append(buildChartControls(data), canvasWrap, heatmapContainer);
	const chartSection = el('div', 'section');
	chartSection.append(chartSectionHeader, chartShell);
	const footer = el('div', 'footer',
		`${periodMeta.footer} (${periodMeta.aggregationLabel})\nLast updated: ${new Date(data.lastUpdated).toLocaleString()}\nUpdates automatically every 5 minutes.`);
	footer.id = 'chart-footer';
	const container = el('div', 'container');
	container.append(buildChartHeader(data), summarySection, chartSection, footer);
	root.append(themeStyle, style, container);
	wireInteractions(data);
	void setupChart(canvas, data);
}

function buildCard(id: string, label: string, value: string): HTMLElement {
	const card = el('div', 'card');
	card.id = id;
	card.append(el('div', 'card-label', label), el('div', 'card-value', value));
	return card;
}

function buildEditorCards(editorTotals: Record<string, number>): HTMLElement | null {
	const entries = Object.entries(editorTotals);
	if (!entries.length) {
		return null;
	}
	const wrap = el('div', 'cards');
	wrap.id = 'editor-cards';
	entries.forEach(([editor, tokens]) => {
		const card = buildCard(`editor-${editor}`, editor, formatCompact(tokens));
			card.prepend(buildEditorLogo(editor));
		// JetBrains only persists user messages + assistant text in its JSONL
		// — no API counts, no thinking tokens. Flag the caveat with an
		// info marker on the card so users don't compare apples-to-oranges.
		if (editor === 'JetBrains') {
			card.title = 'JetBrains: only user messages + assistant text are persisted, so token counts here are estimates of those alone. Actual API counts and thinking tokens are not available.';
			const labelEl = card.querySelector('.card-label');
			if (labelEl) { labelEl.textContent = `${editor} ⓘ`; }
		}
		if (editor === 'Antigravity') {
			card.title = 'Antigravity: token counts are estimated from transcript content. Actual API counts are not stored locally.';
			const labelEl = card.querySelector('.card-label');
			if (labelEl) { labelEl.textContent = `${editor} ⓘ`; }
		}
		wrap.append(card);
	});
	return wrap;
}

/** Builds the "By Editor" breakdown as a collapsible section: a toggle header plus the card grid. The collapsed state is persisted via webview state so it survives restarts. */
function buildEditorSection(editorTotals: Record<string, number>): HTMLElement | null {
	const cards = buildEditorCards(editorTotals);
	if (!cards) { return null; }
	if (editorListCollapsed) { cards.classList.add('hidden'); }

	const header = el('div', 'editor-section-header');
	const toggle = el('button', 'editor-list-toggle');
	toggle.id = 'editor-list-toggle';
	toggle.setAttribute('aria-expanded', String(!editorListCollapsed));
	toggle.setAttribute('aria-controls', 'editor-cards');
	toggle.title = editorListCollapsed ? 'Show per-editor breakdown' : 'Hide per-editor breakdown';
	const chevron = el('span', 'editor-list-chevron', editorListCollapsed ? '▸' : '▾');
	toggle.append(chevron, document.createTextNode(' By Editor'));
	header.append(toggle);

	const section = el('div', 'editor-section');
	section.append(header, cards);
	return section;
}

function updateSummaryCards(data: InitialChartData): void {
	const periodData = getActivePeriodData(data);
	const periodMeta = PERIOD_LABELS[currentPeriod];

	const updateCard = (id: string, label: string | null, value: string) => {
		const card = document.getElementById(id);
		if (!card) { return; }
		if (label !== null) {
			const labelEl = card.querySelector('.card-label');
			if (labelEl) { labelEl.textContent = label; }
		}
		const valueEl = card.querySelector('.card-value');
		if (valueEl) { valueEl.textContent = value; }
	};

updateCard('card-period-count', periodMeta.countLabel, periodData.periodCount.toLocaleString());

if (currentMetric === 'cost') {
	updateCard('card-total-tokens', 'Total Cost (est.)', `$${periodData.totalCost.toFixed(2)}`);
	updateCard('card-avg-tokens', periodMeta.avgCostLabel, `$${periodData.avgCostPerPeriod.toFixed(2)}`);
} else if (currentMetric === 'output') {
	const totalLines = (periodData.totalLinesAdded ?? 0) + (periodData.totalLinesRemoved ?? 0);
	updateCard('card-total-tokens', 'Total Lines (AI)', totalLines.toLocaleString());
	updateCard('card-avg-tokens', periodMeta.avgLocLabel, Math.round(periodData.avgLocPerPeriod ?? 0).toLocaleString());
} else if (currentMetric === 'sessions') {
	updateCard('card-total-tokens', 'Total Sessions', periodData.totalSessions.toLocaleString());
	updateCard('card-avg-tokens', periodMeta.avgSessionsLabel, Math.round(periodData.totalSessions / Math.max(1, periodData.periodCount)).toLocaleString());
} else {
	updateCard('card-total-tokens', 'Total Tokens', formatCompact(periodData.totalTokens));
	updateCard('card-avg-tokens', periodMeta.avgLabel, formatCompact(periodData.avgPerPeriod));
}

updateCard('card-total-sessions', null, periodData.totalSessions.toLocaleString());

	const title = document.getElementById('chart-title');
	if (title) { title.textContent = getChartTitle(); }

	const footer = document.getElementById('chart-footer');
	if (footer) {
		footer.textContent = `${periodMeta.footer} (${periodMeta.aggregationLabel})\nLast updated: ${new Date(data.lastUpdated).toLocaleString()}\nUpdates automatically every 5 minutes.`;
	}
}

/** Wires up the collapsible "By Editor" breakdown toggle; the collapsed state is persisted via webview state so it survives restarts. */
function wireEditorListToggle(): void {
	const toggle = document.getElementById('editor-list-toggle');
	const cards = document.getElementById('editor-cards');
	if (!toggle || !cards) { return; }
	const chevron = toggle.querySelector('.editor-list-chevron');
	toggle.addEventListener('click', () => {
		editorListCollapsed = !editorListCollapsed;
		cards.classList.toggle('hidden', editorListCollapsed);
		toggle.setAttribute('aria-expanded', String(!editorListCollapsed));
		toggle.title = editorListCollapsed ? 'Show per-editor breakdown' : 'Hide per-editor breakdown';
		if (chevron) { chevron.textContent = editorListCollapsed ? '▸' : '▾'; }
		chartState.patch({ editorListCollapsed });
		vscode.postMessage({ command: 'setEditorListCollapsed', collapsed: editorListCollapsed });
	});
}

function wireInteractions(data: InitialChartData): void {
	wireEditorListToggle();
	syncLogoTheme();

	const refresh = document.getElementById('btn-refresh');
	refresh?.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));

	const details = document.getElementById('btn-details');
	details?.addEventListener('click', () => vscode.postMessage({ command: 'showDetails' }));

	const usage = document.getElementById('btn-usage');
	usage?.addEventListener('click', () => vscode.postMessage({ command: 'showUsageAnalysis' }));

	const diagnostics = document.getElementById('btn-diagnostics');
	diagnostics?.addEventListener('click', () => vscode.postMessage({ command: 'showDiagnostics' }));

	const maturity = document.getElementById('btn-maturity');
	maturity?.addEventListener('click', () => vscode.postMessage({ command: 'showMaturity' }));

	const dashboard = document.getElementById('btn-dashboard');
	dashboard?.addEventListener('click', () => vscode.postMessage({ command: 'showDashboard' }));

	const environmental = document.getElementById('btn-environmental');
	environmental?.addEventListener('click', () => vscode.postMessage({ command: 'showEnvironmental' }));

	const efficiency = document.getElementById('btn-efficiency');
	efficiency?.addEventListener('click', () => vscode.postMessage({ command: 'showEfficiency' }));

	wireExtensionPointButtons(vscode);

	// Period toggle buttons
	const periodButtons: Array<{ id: string; period: ChartPeriod }> = [
		{ id: 'period-day',   period: 'day'   },
		{ id: 'period-week',  period: 'week'  },
		{ id: 'period-month', period: 'month' },
	];
	periodButtons.forEach(({ id, period }) => {
		const btn = document.getElementById(id);
		btn?.addEventListener('click', () => { void switchPeriod(period, data); });
	});

	// Chart metric toggle buttons
	const metricButtons: Array<{ id: string; metric: typeof currentMetric }> = [
		{ id: 'metric-tokens', metric: 'tokens' },
		{ id: 'metric-output', metric: 'output' },
		{ id: 'metric-cost',   metric: 'cost'   },
		{ id: 'metric-sessions', metric: 'sessions' },
	];
	metricButtons.forEach(({ id, metric }) => {
		const btn = document.getElementById(id);
		btn?.addEventListener('click', () => { void switchMetric(metric, data); });
	});

	// Chart split toggle buttons
	const splitButtons: Array<{ id: string; split: typeof currentSplit }> = [
		{ id: 'split-total',      split: 'total'      },
		{ id: 'split-model',      split: 'model'      },
		{ id: 'split-editor',     split: 'editor'     },
		{ id: 'split-repository', split: 'repository' },
		{ id: 'split-language',   split: 'language'   },
		{ id: 'split-provider',   split: 'provider'   },
		{ id: 'split-task',       split: 'task'       },
	];
	splitButtons.forEach(({ id, split }) => {
		const btn = document.getElementById(id);
		btn?.addEventListener('click', () => { void switchSplit(split, data); });
	});

	const rollingToggle = document.getElementById('view-rolling');
	rollingToggle?.addEventListener('click', () => { void switchDisplayMode(data); });
}

async function setupChart(canvas: HTMLCanvasElement, data: InitialChartData): Promise<void> {
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return;
	}
	await loadChartModule();
	if (!Chart) {
		return;
	}
	chart = new Chart(ctx, createConfig(data));
	// Restore the previously active period and view if a background update triggered a re-render
	if (pendingPeriod !== null && pendingPeriod !== 'day') {
		const periodToRestore = pendingPeriod;
		currentPeriod = 'day';
		await switchPeriod(periodToRestore, data);
	} else if (pendingMetric !== null || pendingSplit !== null) {
		const metricToRestore = pendingMetric ?? currentMetric;
		const splitToRestore = pendingSplit ?? currentSplit;
		currentMetric = 'tokens';
		currentSplit = 'total';
		await switchMetric(metricToRestore, data);
		if (splitToRestore !== 'total') {
			await switchSplit(splitToRestore, data);
		}
	}
	pendingMetric = null;
	pendingSplit = null;
	pendingPeriod = null;
	refreshHeatmapView(data);
}

async function switchPeriod(period: ChartPeriod, data: InitialChartData): Promise<void> {
	if (currentPeriod === period) {
		return;
	}
	currentPeriod = period;
	vscode.postMessage({ command: 'setPeriodPreference', period });
	saveWebviewState();
	setActivePeriod(period);
	updateSummaryCards(data);
	refreshHeatmapView(data);
	if (isHeatmapView()) { return; }
	if (!chart) {
		return;
	}
	const canvas = chart.canvas as HTMLCanvasElement | null;
	chart.destroy();
	if (!canvas) {
		return;
	}
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return;
	}
	await loadChartModule();
	if (!Chart) {
		return;
	}
	chart = new Chart(ctx, createConfig(data));
}

function clampSplitForMetric(metric: typeof currentMetric): void {
	const normalizedSplit = currentSplit === 'taskCategory' ? 'task' : currentSplit;
	if (metric === 'cost' && normalizedSplit !== 'model' && normalizedSplit !== 'editor' && normalizedSplit !== 'provider' && normalizedSplit !== 'task') { currentSplit = 'total'; return; }
	if (metric === 'output' && (normalizedSplit === 'model' || normalizedSplit === 'provider' || normalizedSplit === 'task')) { currentSplit = 'total'; return; }
	if (metric === 'tokens' && normalizedSplit === 'language') { currentSplit = 'total'; return; }
	if (metric === 'sessions' && normalizedSplit !== 'total' && normalizedSplit !== 'model' && normalizedSplit !== 'editor' && normalizedSplit !== 'provider' && normalizedSplit !== 'task') { currentSplit = 'total'; }
}

async function switchMetric(metric: typeof currentMetric, data: InitialChartData): Promise<void> {
	if (currentMetric === metric) { return; }
	currentSplit = getPreferredSplitForMetric(metric, currentSplit);
	currentMetric = metric;
	const rollingApplicable = currentSplit === 'total' && metric !== 'output';
	if (!rollingApplicable) { currentDisplayMode = 'actual'; }
	vscode.postMessage({ command: 'setViewPreference', metric: currentMetric, split: currentSplit });
	saveWebviewState();
	setActiveMetric(metric);
	setActiveSplit(currentSplit);
	updateSplitButtonStates();
	const rollingBtnEl = document.getElementById('view-rolling');
	if (rollingBtnEl) {
		rollingBtnEl.classList.toggle('hidden', !rollingApplicable);
		rollingBtnEl.classList.toggle('active', rollingApplicable && currentDisplayMode === 'rolling');
	}
	updateSummaryCards(data);
	await reinitChart(data);
}

async function switchTimeWindow(timeWindow: ChartTimeWindow, data: InitialChartData): Promise<void> {
	if (currentTimeWindow === timeWindow) { return; }
	currentTimeWindow = timeWindow;
	vscode.postMessage({ command: 'setTimeWindowPreference', timeWindow });
	saveWebviewState();
	updateSummaryCards(data);
	await reinitChart(data);
}

function getPreferredSplitForMetric(metric: typeof currentMetric, split: typeof currentSplit): typeof currentSplit {
	const normalized = split === 'taskCategory' ? 'task' : split;
	if (metric === 'cost') {
		return (normalized === 'editor' || normalized === 'provider' || normalized === 'task') ? normalized : 'total';
	}
	if (metric === 'output') {
		return (normalized === 'model' || normalized === 'provider' || normalized === 'task') ? 'total' : normalized;
	}
	if (metric === 'tokens') {
		return normalized === 'language' ? 'total' : normalized;
	}
	if (metric === 'sessions') {
		return (normalized === 'total' || normalized === 'model' || normalized === 'editor' || normalized === 'provider' || normalized === 'task') ? normalized : 'total';
	}
	return normalized;
}

function isSplitSupported(metric: typeof currentMetric, split: typeof currentSplit): boolean {
	const normalized = split === 'taskCategory' ? 'task' : split;
	if (metric === 'sessions') {
		return normalized === 'total' || normalized === 'model' || normalized === 'editor' || normalized === 'provider' || normalized === 'task';
	}
	if (metric === 'cost') {
		return normalized === 'total' || normalized === 'model' || normalized === 'editor' || normalized === 'provider' || normalized === 'task';
	}
	if (metric === 'output') {
		return normalized !== 'model' && normalized !== 'provider' && normalized !== 'task' && normalized !== 'taskCategory';
	}
	return normalized !== 'language' && normalized !== 'provider';
}

async function reinitChart(data: InitialChartData): Promise<void> {
	refreshHeatmapView(data);
	if (isHeatmapView()) {
		if (chart) { chart.destroy(); chart = undefined; }
		return;
	}
	if (!chart) {
		// May have come from heatmap view with no active chart — get canvas from DOM
		const canvasEl = document.getElementById('token-chart') as HTMLCanvasElement | null;
		if (!canvasEl) { return; }
		await loadChartModule();
		if (!Chart) { return; }
		const ctx = canvasEl.getContext('2d');
		if (!ctx) { return; }
		chart = new Chart(ctx, createConfig(data));
		return;
	}
	const canvas = chart.canvas as HTMLCanvasElement | null;
	chart.destroy();
	if (!canvas) { return; }
	const ctx = canvas.getContext('2d');
	if (!ctx) { return; }
	await loadChartModule();
	if (!Chart) { return; }
	chart = new Chart(ctx, createConfig(data));
}

async function switchSplit(split: typeof currentSplit, data: InitialChartData): Promise<void> {
	if (currentSplit === split) { return; }
	if (!isSplitSupported(currentMetric, split)) { return; }
	currentSplit = split;
	const rollingApplicable = split === 'total' && currentMetric !== 'output';
	if (!rollingApplicable) { currentDisplayMode = 'actual'; }
	vscode.postMessage({ command: 'setViewPreference', metric: currentMetric, split: currentSplit });
	saveWebviewState();
	setActiveSplit(split);
	const rollingBtnEl = document.getElementById('view-rolling');
	if (rollingBtnEl) {
		rollingBtnEl.classList.toggle('hidden', !rollingApplicable);
		rollingBtnEl.classList.toggle('active', rollingApplicable && currentDisplayMode === 'rolling');
	}
	updateSummaryCards(data);
	await reinitChart(data);
}

function setActivePeriod(period: ChartPeriod): void {
	(['period-day', 'period-week', 'period-month'] as const).forEach(id => {
		const btn = document.getElementById(id);
		if (!btn) { return; }
		btn.classList.toggle('active', id === `period-${period}`);
	});
}

function setActiveMetric(metric: typeof currentMetric): void {
	(['metric-tokens', 'metric-output', 'metric-cost', 'metric-sessions'] as const).forEach(id => {
		const btn = document.getElementById(id);
		if (!btn) { return; }
		btn.classList.toggle('active', id === `metric-${metric}`);
	});
}

function setActiveSplit(split: typeof currentSplit): void {
	const normalized = split === 'taskCategory' ? 'task' : split;
	(['split-total', 'split-model', 'split-editor', 'split-repository', 'split-language', 'split-provider', 'split-task'] as const).forEach(id => {
		const btn = document.getElementById(id);
		if (!btn) { return; }
		btn.classList.toggle('active', id === `split-${normalized}`);
	});
}

function updateSplitButtonStates(): void {
	const splits: Array<{ id: string; split: string }> = [
		{ id: 'split-total',      split: 'total'      },
		{ id: 'split-model',      split: 'model'      },
		{ id: 'split-editor',     split: 'editor'     },
		{ id: 'split-repository', split: 'repository' },
		{ id: 'split-language',   split: 'language'   },
		{ id: 'split-provider',   split: 'provider'   },
		{ id: 'split-task',       split: 'task'       },
	];
	splits.forEach(({ id, split }) => {
		const btn = document.getElementById(id) as HTMLButtonElement | null;
		if (!btn) { return; }
		const supported = isSplitSupported(currentMetric, split as typeof currentSplit);
		btn.disabled = !supported;
		btn.classList.toggle('disabled', !supported);
		btn.title = supported ? '' : `Not available for ${currentMetric} metric`;
	});
}

function setActiveDisplayMode(mode: DisplayMode): void {
	const btn = document.getElementById('view-rolling');
	if (!btn) { return; }
	btn.classList.toggle('active', mode === 'rolling');
}

async function switchDisplayMode(data: InitialChartData): Promise<void> {
	currentDisplayMode = currentDisplayMode === 'actual' ? 'rolling' : 'actual';
	setActiveDisplayMode(currentDisplayMode);
	saveWebviewState();
	updateSummaryCards(data);
	if (!chart) { return; }
	const canvas = chart.canvas as HTMLCanvasElement | null;
	chart.destroy();
	if (!canvas) { return; }
	const ctx = canvas.getContext('2d');
	if (!ctx) { return; }
	await loadChartModule();
	if (!Chart) { return; }
	chart = new Chart(ctx, createConfig(data));
}

const PROJECTION_LABELS: Record<ChartPeriod, string> = {
	day: '📈 Projected (today)', week: '📈 Projected (this week)', month: '📈 Projected (this month)',
};

type ChartColors = { textColor: string; gridColor: string; borderColor: string; bgColor: string };

function getChartColors(): ChartColors {
	const s = getComputedStyle(document.body);
	return {
		textColor: s.getPropertyValue('--text-primary') || '#e0e0e0',
		gridColor: 'rgba(128, 128, 128, 0.15)',
		borderColor: s.getPropertyValue('--border-subtle') || '#3a3a40',
		bgColor: s.getPropertyValue('--bg-tertiary') || '#1e1e1e',
	};
}

function buildBaseOptions(c: ChartColors, periodsReady: boolean) {
	const title = !periodsReady && (currentTimeWindow === 'last90' || currentTimeWindow === 'allTime')
		? `${PERIOD_LABELS[currentTimeWindow]} (loading history…)`
		: PERIOD_LABELS[currentTimeWindow];
	return {
		responsive: true, maintainAspectRatio: false,
		interaction: { mode: 'index' as const, intersect: false },
		plugins: {
			title: { display: true, text: title, color: c.textColor, font: { size: 14, weight: 'bold' }, padding: { top: 4, bottom: 12 } },
			legend: { position: 'top' as const, labels: { color: c.textColor, font: { size: 12 } } },
			tooltip: { backgroundColor: c.bgColor, titleColor: c.textColor, bodyColor: c.textColor, borderColor: c.borderColor, borderWidth: 1, padding: 10, displayColors: true }
		},
		scales: { x: { grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } } } as const
	};
}

function resolveSessionsDatasets(view: string, period: ChartPeriodData): ModelDataset[] | undefined {
	if (view === 'sessions-model') { return period.modelSessionsDatasets ?? period.modelDatasets; }
	if (view === 'sessions-editor') { return period.editorSessionsDatasets ?? period.editorDatasets; }
	if (view === 'sessions-provider') { return period.providerSessionsDatasets ?? period.billingGroupCostDatasets ?? []; }
	return undefined;
}

function buildSessionsTotalDataset(period: ChartPeriodData): any {
	const isRolling = currentDisplayMode === 'rolling';
	return {
		label: isRolling ? getRollingLabel() : 'Sessions',
		data: isRolling ? computeRollingAverage(period.sessionsData, ROLLING_WINDOW[currentPeriod]) : period.sessionsData,
		backgroundColor: isRolling ? 'rgba(137, 180, 250, 0.15)' : 'rgba(137, 180, 250, 0.7)',
		borderColor: 'rgba(137, 180, 250, 1)',
		borderWidth: isRolling ? 2 : 1,
		borderRadius: isRolling ? undefined : 4,
		type: isRolling ? 'line' as const : undefined,
		tension: isRolling ? 0.4 : undefined,
		fill: isRolling ? false : undefined
	};
}

function buildSessionsProjectionDataset(period: ChartPeriodData): any | null {
	const lastIdx = period.sessionsData.length - 1;
	if (lastIdx < 0) { return null; }
	const projExtra = computeProjectionExtra(period.sessionsData[lastIdx], getCurrentPeriodFraction(currentPeriod));
	if (projExtra === null) { return null; }
	return {
		label: PROJECTION_LABELS[currentPeriod],
		data: period.sessionsData.map((_: number, i: number) => i === lastIdx ? Math.round(projExtra) : 0),
		backgroundColor: 'rgba(137, 180, 250, 0.25)',
		borderColor: 'rgba(137, 180, 250, 0.5)',
		borderWidth: 1
	};
}

function buildSessionsViewConfig(view: string, period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const datasets = resolveSessionsDatasets(view, period);
	const isStacked = !!datasets;
	const isRolling = !isStacked && currentDisplayMode === 'rolling';
	const projDs = !isStacked && !isRolling ? buildSessionsProjectionDataset(period) : null;
	const showLegend = isStacked || !!projDs;
	const stackAxes = isStacked || !!projDs;
	const seriesDatasets = isStacked ? datasets as ModelDataset[] : [buildSessionsTotalDataset(period), ...(projDs ? [projDs] : [])];
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: seriesDatasets as any },
		options: { ...baseOptions, plugins: { ...baseOptions.plugins, legend: { display: showLegend, position: 'top' as const, labels: { color: c.textColor, font: { size: 12 } } }, tooltip: { ...baseOptions.plugins.tooltip, callbacks: { label: (ctx: any) => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toLocaleString()} sessions` } } },
			scales: { x: { stacked: stackAxes, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } },
				y: { stacked: stackAxes, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() }, title: { display: true, text: 'Sessions', color: c.textColor, font: { size: 12, weight: 'bold' } } }
			}
		}
	};
}

function buildTotalViewConfig(period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const isRolling = currentDisplayMode === 'rolling';
	const tokenData = isRolling ? computeRollingAverage(period.tokensData, ROLLING_WINDOW[currentPeriod]) : period.tokensData;
	const lastIdx = period.tokensData.length - 1;
	const projExtra = !isRolling && lastIdx >= 0 ? computeProjectionExtra(period.tokensData[lastIdx], getCurrentPeriodFraction(currentPeriod)) : null;
	const projDs = projExtra !== null ? [{ label: PROJECTION_LABELS[currentPeriod], data: period.tokensData.map((_: number, i: number) => i === lastIdx ? Math.round(projExtra) : 0), backgroundColor: 'rgba(54, 162, 235, 0.2)', borderColor: 'rgba(54, 162, 235, 0.5)', borderWidth: 1, yAxisID: 'y' }] : [];
	const rollingLabel = getRollingLabel();
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: [
			{ label: isRolling ? rollingLabel : 'Tokens', data: tokenData, backgroundColor: isRolling ? 'rgba(54, 162, 235, 0.15)' : 'rgba(54, 162, 235, 0.6)', borderColor: 'rgba(54, 162, 235, 1)', borderWidth: isRolling ? 2 : 1, type: isRolling ? 'line' as const : undefined, tension: isRolling ? 0.4 : undefined, fill: isRolling ? false : undefined, yAxisID: 'y' },
			...projDs,
			{ label: 'Sessions', data: period.sessionsData, backgroundColor: 'rgba(255, 99, 132, 0.6)', borderColor: 'rgba(255, 99, 132, 1)', borderWidth: 1, type: 'line' as const, yAxisID: 'y1' }
		] },
		options: { ...baseOptions, scales: {
			x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } },
			y: { stacked: true, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() }, title: { display: true, text: 'Tokens', color: c.textColor, font: { size: 12, weight: 'bold' } } },
			y1: { type: 'linear' as const, display: true, position: 'right' as const, grid: { drawOnChartArea: false }, ticks: { color: c.textColor, font: { size: 11 } }, title: { display: true, text: 'Sessions', color: c.textColor, font: { size: 12, weight: 'bold' } } }
		} }
	};
}

function buildBudgetLinePlugin(monthlyBudget: number) {
	return {
		id: 'budgetLine',
		afterDraw(ch: any) {
			const { ctx, chartArea, scales: { y } } = ch;
			if (!y || !chartArea) { return; }
			const yPos = y.getPixelForValue(monthlyBudget);
			if (yPos < chartArea.top || yPos > chartArea.bottom) { return; }
			ctx.save();
			ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
			ctx.lineWidth = 2;
			ctx.setLineDash([6, 4]);
			ctx.beginPath();
			ctx.moveTo(chartArea.left, yPos);
			ctx.lineTo(chartArea.right, yPos);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = 'rgba(255, 80, 80, 0.9)';
			ctx.font = 'bold 11px sans-serif';
			ctx.textAlign = 'left';
			ctx.fillText(`Budget: $${monthlyBudget.toFixed(2)}`, chartArea.left + 6, yPos - 5);
			ctx.restore();
		},
	};
}

function buildCostDataset(isRolling: boolean, rollingLabel: string, costData: number[]) {
	return {
		label: isRolling ? `${rollingLabel} (UBB)` : 'Est. Cost (UBB)',
		data: costData,
		backgroundColor: isRolling ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.6)',
		borderColor: 'rgba(34, 197, 94, 1)',
		borderWidth: isRolling ? 2 : 1,
		type: isRolling ? 'line' as const : undefined,
		tension: isRolling ? 0.4 : undefined,
		fill: isRolling ? false : undefined,
		yAxisID: 'y' as const,
	};
}

function buildCostProviderViewConfig(period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const datasets = (period.billingGroupCostDatasets ?? []) as ModelDataset[];
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: datasets as any },
		options: {
			...baseOptions,
			plugins: {
				...baseOptions.plugins,
				legend: { position: 'top' as const, labels: { color: c.textColor, font: { size: 11 } } },
				tooltip: {
					...baseOptions.plugins.tooltip,
					callbacks: {
						label: (ctx: any) => ` ${ctx.dataset.label}: $${Number(ctx.parsed.y).toFixed(4)}`,
						footer: (items: any[]) => {
							const total = items.reduce((sum: number, i: any) => sum + (Number(i.parsed.y) || 0), 0);
							return `Total: $${total.toFixed(4)}`;
						}
					}
				}
			},
			scales: {
				x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } },
				y: { stacked: true, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => `$${Number(value).toFixed(2)}` }, title: { display: true, text: 'Estimated Cost (USD)', color: c.textColor, font: { size: 12, weight: 'bold' as const } } }
			}
		}
	} as ChartConfig;
}

function buildCostEditorViewConfig(period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const datasets = (period.editorCostDatasets ?? []) as ModelDataset[];
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: datasets as any },
		options: {
			...baseOptions,
			plugins: {
				...baseOptions.plugins,
				legend: { position: 'top' as const, labels: { color: c.textColor, font: { size: 11 } } },
				tooltip: {
					...baseOptions.plugins.tooltip,
					callbacks: {
						label: (ctx: any) => ` ${ctx.dataset.label}: $${Number(ctx.parsed.y).toFixed(4)}`,
						footer: (items: any[]) => {
							const total = items.reduce((sum: number, i: any) => sum + (Number(i.parsed.y) || 0), 0);
							return `Total: $${total.toFixed(4)}`;
						}
					}
				}
			},
			scales: {
				x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } },
				y: { stacked: true, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => `$${Number(value).toFixed(2)}` }, title: { display: true, text: 'Estimated Cost (USD)', color: c.textColor, font: { size: 12, weight: 'bold' as const } } }
			}
		}
	} as ChartConfig;
}

function buildCostModelViewConfig(period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const datasets = (period.modelCostDatasets ?? []) as ModelDataset[];
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: datasets as any },
		options: {
			...baseOptions,
			plugins: {
				...baseOptions.plugins,
				legend: { position: 'top' as const, labels: { color: c.textColor, font: { size: 11 } } },
				tooltip: {
					...baseOptions.plugins.tooltip,
					callbacks: {
						label: (ctx: any) => ` ${ctx.dataset.label}: $${Number(ctx.parsed.y).toFixed(4)}`,
						footer: (items: any[]) => {
							const total = items.reduce((sum: number, i: any) => sum + (Number(i.parsed.y) || 0), 0);
							return `Total: $${total.toFixed(4)}`;
						}
					}
				}
			},
			scales: {
				x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } },
				y: { stacked: true, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => `$${Number(value).toFixed(2)}` }, title: { display: true, text: 'Estimated Cost (USD)', color: c.textColor, font: { size: 12, weight: 'bold' as const } } }
			}
		}
	} as ChartConfig;
}

function buildCostViewConfig(period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors, monthlyBudget = 0): ChartConfig {
	const isRolling = currentDisplayMode === 'rolling';
	const costData = isRolling ? computeRollingAverage(period.costData, ROLLING_WINDOW[currentPeriod]) : period.costData;
	const lastIdx = period.costData.length - 1;
	const projExtra = !isRolling && lastIdx >= 0 ? computeProjectionExtra(period.costData[lastIdx], getCurrentPeriodFraction(currentPeriod)) : null;
	const projDs = projExtra !== null ? [{ label: PROJECTION_LABELS[currentPeriod], data: period.costData.map((_: number, i: number) => i === lastIdx ? projExtra : 0), backgroundColor: 'rgba(34, 197, 94, 0.2)', borderColor: 'rgba(34, 197, 94, 0.5)', borderWidth: 1, yAxisID: 'y' }] : [];
	const budget = monthlyBudget;
	const budgetDs = budget > 0 && currentPeriod === 'month' ? [{ label: `Monthly Budget ($${budget.toFixed(2)})`, data: period.labels.map(() => budget), type: 'line' as const, borderColor: 'rgba(255, 165, 0, 0.9)', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false, yAxisID: 'y' }] : [];
	const rollingLabel = getRollingLabel();
	const showBudgetLine = currentPeriod === 'month' && monthlyBudget > 0;
	const budgetLinePlugin = showBudgetLine ? buildBudgetLinePlugin(monthlyBudget) : null;
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: [buildCostDataset(isRolling, rollingLabel, costData), ...projDs] },
		options: { ...baseOptions, plugins: { ...baseOptions.plugins, tooltip: { ...baseOptions.plugins.tooltip, callbacks: { label: (ctx: any) => ` $${Number(ctx.parsed.y).toFixed(4)}` } } },
			scales: { x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } }, y: { stacked: true, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => `$${Number(value).toFixed(2)}` }, title: { display: true, text: 'Estimated Cost (UBB)', color: c.textColor, font: { size: 12, weight: 'bold' as const } }, ...(showBudgetLine ? { suggestedMax: monthlyBudget * 1.05 } : {}) } }
		},
		...(budgetLinePlugin ? { plugins: [budgetLinePlugin] } : {}),
	} as ChartConfig;
}

function buildOutputViewConfig(view: string, period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const locDatasets = view === 'output-language' ? (period.languageDatasets ?? []) : view === 'output-editor' ? (period.locEditorDatasets ?? []) : view === 'output-repository' ? (period.locRepositoryDatasets ?? []) :
		[{ label: 'Lines Added', data: period.linesAddedData ?? [], backgroundColor: 'rgba(75, 192, 192, 0.6)', borderColor: 'rgba(75, 192, 192, 1)', borderWidth: 1 },
		 { label: 'Lines Removed', data: (period.linesRemovedData ?? []).map((v: number) => -v), backgroundColor: 'rgba(255, 99, 132, 0.6)', borderColor: 'rgba(255, 99, 132, 1)', borderWidth: 1 }];
	const stacked = view === 'output-total';
	return {
		type: 'bar' as const, data: { labels: period.labels, datasets: locDatasets as any },
		options: { ...baseOptions, plugins: { ...baseOptions.plugins, legend: { position: 'top' as const, labels: { color: c.textColor, font: { size: 11 } } }, tooltip: { ...baseOptions.plugins.tooltip, callbacks: { label: (ctx: any) => ` ${Math.abs(Number(ctx.parsed.y)).toLocaleString()} lines` } } },
			scales: { x: { stacked, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } }, y: { stacked, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => Math.abs(Number(value)).toLocaleString() }, title: { display: true, text: 'Lines of Code', color: c.textColor, font: { size: 12, weight: 'bold' } } } }
		}
	};
}

function buildSessionsTotalViewConfig(period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const isRolling = currentDisplayMode === 'rolling';
	const sessionsData = isRolling ? computeRollingAverage(period.sessionsData, ROLLING_WINDOW[currentPeriod]) : period.sessionsData;
	const rollingLabel = getRollingLabel();
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: [{ label: isRolling ? rollingLabel : 'Sessions', data: sessionsData, backgroundColor: 'rgba(255, 99, 132, 0.6)', borderColor: 'rgba(255, 99, 132, 1)', borderWidth: 1, type: isRolling ? 'line' as const : undefined, tension: isRolling ? 0.4 : undefined, fill: isRolling ? false : undefined }] },
		options: {
			...baseOptions,
			scales: {
				x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } },
				y: { stacked: true, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() }, title: { display: true, text: 'Sessions', color: c.textColor, font: { size: 12, weight: 'bold' as const } } }
			}
		}
	} as ChartConfig;
}

function buildTaskCategoryViewConfig(period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors, metric: 'tokens' | 'cost' | 'sessions'): ChartConfig {
	const datasets = metric === 'cost'
		? (period.taskCategoryCostDatasets ?? [])
		: metric === 'sessions'
			? (period.taskCategorySessionDatasets ?? [])
			: (period.taskCategoryTokenDatasets ?? []);
	const yAxisTitle = metric === 'cost' ? 'Estimated Cost (USD)' : metric === 'sessions' ? 'Sessions' : 'Tokens';
	const valueFormatter = metric === 'cost'
		? (value: number) => `$${Number(value).toFixed(2)}`
		: (value: number) => Number(value).toLocaleString();
	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: datasets as any },
		options: {
			...baseOptions,
			plugins: {
				...baseOptions.plugins,
				legend: { position: 'top' as const, labels: { color: c.textColor, font: { size: 11 } } },
				tooltip: {
					...baseOptions.plugins.tooltip,
					callbacks: {
						label: (ctx: any) => ` ${ctx.dataset.label}: ${metric === 'cost' ? `$${Number(ctx.parsed.y).toFixed(4)}` : Number(ctx.parsed.y).toLocaleString()}`,
					}
				}
			},
			scales: {
				x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } },
				y: { stacked: true, type: 'linear' as const, display: true, position: 'left' as const, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => valueFormatter(Number(value)) }, title: { display: true, text: yAxisTitle, color: c.textColor, font: { size: 12, weight: 'bold' as const } } }
			}
		}
	} as ChartConfig;
}

function getHeatmapColor(value: number, maxValue: number): string {
	if (maxValue === 0 || value === 0) { return 'rgba(128, 128, 128, 0.06)'; }
	// Log scale, dark forest green → bright green accent (#22c55e)
	const f = Math.log1p(value) / Math.log1p(maxValue);
	const r = Math.round(5 + (34 - 5) * f);
	const g = Math.round(60 + (197 - 60) * f);
	const b = Math.round(30 + (94 - 30) * f);
	const a = (0.55 + 0.45 * f).toFixed(2);
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const HEATMAP_TOP_LANGUAGES = 10;

function shortenDateLabel(label: string): string {
	const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(label);
	if (m) { return `${parseInt(m[1])}/${parseInt(m[2])}`; }
	return label;
}

function buildLanguageHeatmap(period: ChartPeriodData): HTMLElement {
	const datasets = (period.languageDatasets ?? []) as ModelDataset[];
	const withTotals = datasets
		.map(ds => ({ label: ds.label, data: ds.data as number[], total: (ds.data as number[]).reduce((a, b) => a + b, 0) }))
		.filter(ds => ds.total > 0)
		.sort((a, b) => b.total - a.total);
	const topLangs = withTotals.slice(0, HEATMAP_TOP_LANGUAGES);
	const otherLangs = withTotals.slice(HEATMAP_TOP_LANGUAGES);
	if (otherLangs.length > 0) {
		const otherData = otherLangs[0].data.map((_, i) => otherLangs.reduce((sum, ds) => sum + ds.data[i], 0));
		const otherTotal = otherData.reduce((a, b) => a + b, 0);
		if (otherTotal > 0) { topLangs.push({ label: 'Other', data: otherData, total: otherTotal }); }
	}
	const labels = period.labels;
	const shortLabels = labels.map(shortenDateLabel);
	const wrap = el('div', 'heatmap-wrap');
	if (!topLangs.length) {
		wrap.append(el('div', 'heatmap-empty', 'No language data for this period.'));
		return wrap;
	}
	const maxValue = Math.max(...topLangs.flatMap(ds => ds.data));
	const table = document.createElement('table');
	table.className = 'heatmap-table';
	const thead = document.createElement('thead');
	const headerRow = document.createElement('tr');
	const cornerTh = document.createElement('th');
	cornerTh.className = 'heatmap-lang-header';
	headerRow.append(cornerTh);
	labels.forEach((label, i) => {
		const th = document.createElement('th');
		th.className = 'heatmap-date-header';
		const span = document.createElement('span');
		span.textContent = shortLabels[i];
		th.title = label;
		th.append(span);
		headerRow.append(th);
	});
	thead.append(headerRow);
	table.append(thead);
	const tbody = document.createElement('tbody');
	topLangs.forEach(ds => {
		const tr = document.createElement('tr');
		const langTd = document.createElement('td');
		langTd.className = 'heatmap-lang-label';
		langTd.textContent = ds.label;
		tr.append(langTd);
		ds.data.forEach((value, i) => {
			const td = document.createElement('td');
			td.className = 'heatmap-data-cell';
			td.style.backgroundColor = getHeatmapColor(value, maxValue);
			if (value > 0) {
				td.title = `${ds.label} · ${labels[i]}: ${value.toLocaleString()} lines`;
			}
			tr.append(td);
		});
		tbody.append(tr);
	});
	table.append(tbody);
	wrap.append(table);
	return wrap;
}

function isHeatmapView(): boolean {
	return currentMetric === 'output' && currentSplit === 'language';
}

function refreshHeatmapView(data: InitialChartData): void {
	const canvasWrap = document.querySelector('.canvas-wrap') as HTMLElement | null;
	const heatmapContainer = document.getElementById('heatmap-container');
	if (!canvasWrap || !heatmapContainer) { return; }
	const show = isHeatmapView();
	canvasWrap.classList.toggle('hidden', show);
	heatmapContainer.classList.toggle('hidden', !show);
	if (show) {
		heatmapContainer.replaceChildren(buildLanguageHeatmap(getActivePeriodData(data)));
	}
}

function buildStackedViewConfig(view: string, period: ChartPeriodData, baseOptions: ReturnType<typeof buildBaseOptions>, c: ChartColors): ChartConfig {
	const datasets = view === 'model'
		? period.modelDatasets
		: view === 'repository'
			? period.repositoryDatasets
			: view === 'task' || view === 'taskCategory'
				? (period.taskCategoryDatasets ?? period.taskCategoryTokenDatasets ?? [])
				: view === 'provider'
					? (period.providerTokensDatasets ?? [])
					: period.editorDatasets;
	const lastIdx = period.tokensData.length - 1;
	const projExtra = lastIdx >= 0 ? computeProjectionExtra(period.tokensData[lastIdx], getCurrentPeriodFraction(currentPeriod)) : null;
	const projDs = projExtra !== null ? [{ label: PROJECTION_LABELS[currentPeriod], data: period.tokensData.map((_: number, i: number) => i === lastIdx ? Math.round(projExtra) : 0), backgroundColor: 'rgba(200, 200, 200, 0.25)', borderColor: 'rgba(200, 200, 200, 0.5)', borderWidth: 1 }] : [];
	const sessionsDs = { label: 'Sessions', data: period.sessionsData, backgroundColor: 'rgba(255, 99, 132, 0.6)', borderColor: 'rgba(255, 99, 132, 1)', borderWidth: 2, type: 'line' as const, yAxisID: 'y1', stack: undefined };
	return {
		type: 'bar' as const, data: { labels: period.labels, datasets: [...datasets, ...projDs, sessionsDs] },
		options: { ...baseOptions, plugins: { ...baseOptions.plugins, legend: { position: 'top' as const, labels: { color: c.textColor, font: { size: 11 } } },
			tooltip: { ...baseOptions.plugins.tooltip, callbacks: { footer: (items: any[]) => {
				if (currentSplit !== 'editor') { return ''; }
				if (items.some(i => i?.dataset?.label === 'JetBrains')) { return 'JetBrains: estimates from user messages + assistant text only.\nActual API counts and thinking tokens are not available.'; }
				if (items.some(i => i?.dataset?.label === 'Antigravity')) { return 'Antigravity: estimates from transcript content.\nActual API counts are not stored locally.'; }
				return '';
			} } } },
			scales: { ...baseOptions.scales, y: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() }, title: { display: true, text: 'Tokens', color: c.textColor, font: { size: 12, weight: 'bold' } } }, x: { stacked: true, grid: { color: c.gridColor }, ticks: { color: c.textColor, font: { size: 11 } } }, y1: { type: 'linear' as const, display: true, position: 'right' as const, grid: { drawOnChartArea: false }, ticks: { color: c.textColor, font: { size: 11 } }, title: { display: true, text: 'Sessions', color: c.textColor, font: { size: 12, weight: 'bold' } } } }
		}
	};
}

function resolveTokensView(split: typeof currentSplit): string {
	if (split === 'model') { return 'model'; }
	if (split === 'editor') { return 'editor'; }
	if (split === 'repository') { return 'repository'; }
	if (split === 'task' || split === 'taskCategory') { return 'task'; }
	if (split === 'provider') { return 'provider'; }
	return 'total';
}

function resolveCostView(split: typeof currentSplit): string {
	if (split === 'model') { return 'cost-model'; }
	if (split === 'editor') { return 'cost-editor'; }
	if (split === 'provider') { return 'cost-provider'; }
	if (split === 'task' || split === 'taskCategory') { return 'cost-task'; }
	return 'cost';
}

function resolveSessionsView(split: typeof currentSplit): string {
	if (split === 'model') { return 'sessions-model'; }
	if (split === 'editor') { return 'sessions-editor'; }
	if (split === 'provider') { return 'sessions-provider'; }
	if (split === 'task' || split === 'taskCategory') { return 'sessions-task'; }
	return 'sessions';
}

function resolveChartView(metric: typeof currentMetric, split: typeof currentSplit): string {
	const normalized = split === 'taskCategory' ? 'task' : split;
	if (metric === 'output') { return `output-${normalized}`; }
	if (metric === 'sessions') { return resolveSessionsView(normalized); }
	if (metric === 'tokens') { return resolveTokensView(normalized); }
	if (metric === 'cost') { return resolveCostView(normalized); }
	return `output-${normalized}`;
}

function createConfig(data: InitialChartData): ChartConfig {
	const period = getActivePeriodData(data);
	const view = resolveChartView(currentMetric, currentSplit);
	const c = getChartColors();
	const periodsReady = data.periodsReady !== false;
	const baseOptions = buildBaseOptions(c, periodsReady);
	if (view.startsWith('sessions')) { return buildSessionsViewConfig(view, period, baseOptions, c); }
	if (view === 'total') { return buildTotalViewConfig(period, baseOptions, c); }
	if (view === 'cost') { return buildCostViewConfig(period, baseOptions, c, data.monthlyBudget ?? 0); }
	if (view === 'cost-model') { return buildCostModelViewConfig(period, baseOptions, c); }
	if (view === 'cost-editor') { return buildCostEditorViewConfig(period, baseOptions, c); }
	if (view === 'cost-provider') { return buildCostProviderViewConfig(period, baseOptions, c); }
	if (view === 'cost-task') { return buildTaskCategoryViewConfig(period, baseOptions, c, 'cost'); }
	if (view === 'sessions-total') { return buildSessionsTotalViewConfig(period, baseOptions, c); }
	if (view === 'sessions-task') { return buildTaskCategoryViewConfig(period, baseOptions, c, 'sessions'); }
	if (view.startsWith('output-')) { return buildOutputViewConfig(view, period, baseOptions, c); }
	if (view === 'task') { return buildTaskCategoryViewConfig(period, baseOptions, c, 'tokens'); }
	return buildStackedViewConfig(view, period, baseOptions, c);
}


type MetricSplit = { metric: typeof currentMetric; split: typeof currentSplit };

function migrateViewKey(view: string): MetricSplit {
	const map: Record<string, MetricSplit> = {
		total: { metric: 'tokens', split: 'total' },
		model: { metric: 'tokens', split: 'model' },
		editor: { metric: 'tokens', split: 'editor' },
		repository: { metric: 'tokens', split: 'repository' },
		cost: { metric: 'cost', split: 'total' },
		task: { metric: 'tokens', split: 'task' },
		taskCategory: { metric: 'tokens', split: 'task' },
	};
	return map[view] ?? { metric: 'tokens', split: 'total' };
}

function applyInitialChartState(data: InitialChartData): void {
	if (data.initialPeriod) { currentPeriod = data.initialPeriod; }
	if (data.initialMetric) { currentMetric = data.initialMetric; }
	if (data.initialSplit) { currentSplit = data.initialSplit; return; }
	if (!data.initialView) { return; }
	const m = migrateViewKey(data.initialView);
	currentMetric = m.metric;
	currentSplit = m.split;
}

function applySavedChartState(saved: ChartWebviewState): void {
	currentPeriod = saved.period;
	currentDisplayMode = saved.displayMode;
	if (saved.view && !saved.metric) {
		const m = migrateViewKey(saved.view);
		currentMetric = m.metric;
		currentSplit = m.split;
		return;
	}
	currentMetric = saved.metric ?? 'tokens';
	currentSplit = saved.split ?? 'total';
}

function restoreChartState(initialData: InitialChartData): void {
	const saved = chartState.restore();
	// Webview state is newest for an existing panel (the host value is a snapshot embedded when the
	// panel was created); the host value only seeds a brand-new panel, which has no saved flag.
	const savedFlag = (vscode.getState() as Partial<ChartWebviewState> | undefined)?.editorListCollapsed;
	editorListCollapsed = savedFlag ?? initialData.initialEditorListCollapsed ?? false;
	if (!vscode.getState()) {
		if (initialData.initialPeriod) { currentPeriod = initialData.initialPeriod; }
		if (initialData.initialTimeWindow) { currentTimeWindow = initialData.initialTimeWindow; }
		if (initialData.initialMetric) { currentMetric = initialData.initialMetric; }
		if (initialData.initialSplit) {
			currentSplit = initialData.initialSplit === 'taskCategory' ? 'task' : initialData.initialSplit;
		} else if (initialData.initialView) {
			const m = migrateViewKey(initialData.initialView);
			currentMetric = m.metric; currentSplit = m.split;
		}
		return;
	}
	currentPeriod = saved.period ?? 'day';
	currentTimeWindow = saved.timeWindow ?? 'last30';
	currentDisplayMode = saved.displayMode ?? 'actual';
	if (saved.view && !saved.metric) {
		const m = migrateViewKey(saved.view);
		currentMetric = m.metric;
		currentSplit = m.split;
	} else {
		currentMetric = saved.metric ?? 'tokens';
		currentSplit = saved.split === 'taskCategory' ? 'task' : (saved.split ?? 'total');
	}
}

async function bootstrap(): Promise<void> {
	await import('@vscode-elements/elements/dist/vscode-button/index.js');

	if (!initialData) {
		const root = document.getElementById('root');
		if (root) { root.textContent = 'No data available.'; }
		return;
	}

	restoreChartState(initialData);
	renderLayout(initialData);
}

void bootstrap();

// Listen for background data updates from the extension
registerMessageHandler((message) => {
	if (message.command === 'updateChartData') {
		// Save current toggles for restoration after chart re-initializes
		pendingMetric = currentMetric;
		pendingSplit = currentSplit;
		pendingPeriod = currentPeriod;
		renderLayout(message.data as InitialChartData);
	}
});
