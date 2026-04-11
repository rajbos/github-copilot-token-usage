// @ts-nocheck // Chart.js ESM bundle is loaded dynamically; skip CJS resolution noise
import { el, createButton } from '../shared/domUtils';
import { BUTTONS } from '../shared/buttonConfig';
import { formatCompact, setCompactNumbers } from '../shared/formatUtils';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import styles from './styles.css';

type ChartModule = typeof import('chart.js/auto');
type ChartConstructor = ChartModule['default'];
type ChartInstance = InstanceType<ChartConstructor>;
type ChartConfig = import('chart.js').ChartConfiguration<'bar' | 'line', number[], string>;

type ModelDataset = { label: string; data: number[]; backgroundColor: string; borderColor: string; borderWidth: number };
type EditorDataset = ModelDataset;
type RepositoryDataset = ModelDataset & { fullRepo?: string };

type ChartPeriodData = {
	labels: string[];
	tokensData: number[];
	sessionsData: number[];
	modelDatasets: ModelDataset[];
	editorDatasets: EditorDataset[];
	repositoryDatasets: RepositoryDataset[];
	periodCount: number;
	totalTokens: number;
	totalSessions: number;
	avgPerPeriod: number;
};

type ChartPeriod = 'day' | 'week' | 'month';

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
	periods?: {
		daily: ChartPeriodData;
		weekly: ChartPeriodData;
		monthly: ChartPeriodData;
	};
};

// VS Code injects this in the webview environment
declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: any) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

declare global {
	interface Window { __INITIAL_CHART__?: InitialChartData; }
}

const vscode: VSCodeApi = acquireVsCodeApi();
const initialData = window.__INITIAL_CHART__;

let chart: ChartInstance | undefined;
let Chart: ChartConstructor | undefined;

async function loadChartModule(): Promise<void> {
	if (Chart) {
		return;
	}
	const mod = await import('chart.js/auto');
	Chart = mod.default;
}
let currentView: 'total' | 'model' | 'editor' | 'repository' = 'total';
let currentPeriod: ChartPeriod = 'day';
// Stores state to restore after a background data update re-initializes the chart
let pendingView: typeof currentView | null = null;
let pendingPeriod: ChartPeriod | null = null;

/** Returns period data for the current period, falling back to legacy flat fields. */
function getActivePeriodData(data: InitialChartData): ChartPeriodData {
	if (data.periods) {
		return data.periods[currentPeriod];
	}
	// Fallback for backward compat (no periods field)
	return {
		labels: data.labels,
		tokensData: data.tokensData,
		sessionsData: data.sessionsData,
		modelDatasets: data.modelDatasets,
		editorDatasets: data.editorDatasets,
		repositoryDatasets: data.repositoryDatasets,
		periodCount: data.dailyCount,
		totalTokens: data.totalTokens,
		totalSessions: data.totalSessions,
		avgPerPeriod: data.avgTokensPerDay,
	};
}

const PERIOD_LABELS: Record<ChartPeriod, { title: string; footer: string; countLabel: string; avgLabel: string }> = {
	day:   { title: 'Token Usage – Last 30 Days',  footer: 'Day-by-day token usage for the last 30 days',   countLabel: 'Total Days',   avgLabel: 'Avg Tokens / Day'   },
	week:  { title: 'Token Usage – Last 6 Weeks',  footer: 'Week-by-week token usage for the last 6 weeks', countLabel: 'Total Weeks',  avgLabel: 'Avg Tokens / Week'  },
	month: { title: 'Token Usage – Last 12 Months', footer: 'Monthly token usage for the last 12 months',   countLabel: 'Total Months', avgLabel: 'Avg Tokens / Month' },
};

function renderLayout(data: InitialChartData): void {
	setCompactNumbers(data.compactNumbers !== false);
	const root = document.getElementById('root');
	if (!root) {
		return;
	}

	root.replaceChildren();

	const themeStyle = document.createElement('style');
	themeStyle.textContent = themeStyles;
	const style = document.createElement('style');
	style.textContent = styles;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const headerLeft = el('div', 'header-left');
	const icon = el('span', 'header-icon', '📈');
	const title = el('span', 'header-title', PERIOD_LABELS[currentPeriod].title);
	title.id = 'chart-title';
	headerLeft.append(icon, title);
	const buttons = el('div', 'button-row');
	buttons.append(
		createButton(BUTTONS['btn-refresh']),
		createButton(BUTTONS['btn-details']),
		createButton(BUTTONS['btn-usage']),
		createButton(BUTTONS['btn-environmental']),
		createButton(BUTTONS['btn-diagnostics']),
		createButton(BUTTONS['btn-maturity'])
	);
	if (data.backendConfigured) {
		buttons.append(createButton(BUTTONS['btn-dashboard']));
	}
	header.append(headerLeft, buttons);

	const periodData = getActivePeriodData(data);
	const periodMeta = PERIOD_LABELS[currentPeriod];

	const summarySection = el('div', 'section');
	summarySection.append(el('h3', '', '📊 Summary'));
	const cards = el('div', 'cards');
	cards.id = 'summary-cards';
	cards.append(
		buildCard('card-period-count',  periodMeta.countLabel,   periodData.periodCount.toLocaleString()),
		buildCard('card-total-tokens',  'Total Tokens',           formatCompact(periodData.totalTokens)),
		buildCard('card-avg-tokens',    periodMeta.avgLabel,      formatCompact(periodData.avgPerPeriod)),
		buildCard('card-total-sessions','Total Sessions',         periodData.totalSessions.toLocaleString())
	);
	summarySection.append(cards);

	const editorCards = buildEditorCards(data.editorTotalsMap);
	if (editorCards) {
		summarySection.append(editorCards);
	}

	const chartSection = el('div', 'section');
	chartSection.append(el('h3', '', '📊 Charts'));

	const chartShell = el('div', 'chart-shell');

	// Period toggle row
	const periodToggles = el('div', 'chart-controls period-controls');
	const dayBtn = el('button', `toggle${currentPeriod === 'day' ? ' active' : ''}`, '📅 Day');
	dayBtn.id = 'period-day';
	const weekBtn = el('button', `toggle${currentPeriod === 'week' ? ' active' : ''}`, '🗓️ Week');
	weekBtn.id = 'period-week';
	const monthBtn = el('button', `toggle${currentPeriod === 'month' ? ' active' : ''}`, '📆 Month');
	monthBtn.id = 'period-month';
	periodToggles.append(dayBtn, weekBtn, monthBtn);

	// Chart view toggle row
	const toggles = el('div', 'chart-controls');
	const totalBtn = el('button', `toggle${currentView === 'total' ? ' active' : ''}`, 'Total Tokens');
	totalBtn.id = 'view-total';
	const modelBtn = el('button', `toggle${currentView === 'model' ? ' active' : ''}`, 'By Model');
	modelBtn.id = 'view-model';
	const editorBtn = el('button', `toggle${currentView === 'editor' ? ' active' : ''}`, 'By Editor');
	editorBtn.id = 'view-editor';
	const repoBtn = el('button', `toggle${currentView === 'repository' ? ' active' : ''}`, 'By Repository');
	repoBtn.id = 'view-repository';
	toggles.append(totalBtn, modelBtn, editorBtn, repoBtn);

	const canvasWrap = el('div', 'canvas-wrap');
	const canvas = document.createElement('canvas');
	canvas.id = 'token-chart';
	canvasWrap.append(canvas);

	chartShell.append(periodToggles, toggles, canvasWrap);
	chartSection.append(chartShell);

	const footer = el('div', 'footer',
		`${periodMeta.footer}\nLast updated: ${new Date(data.lastUpdated).toLocaleString()}\nUpdates automatically every 5 minutes.`
	);
	footer.id = 'chart-footer';

	container.append(header, summarySection, chartSection, footer);
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
	entries.forEach(([editor, tokens]) => {
		wrap.append(buildCard(`editor-${editor}`, editor, formatCompact(tokens)));
	});
	return wrap;
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

	updateCard('card-period-count',   periodMeta.countLabel,  periodData.periodCount.toLocaleString());
	updateCard('card-total-tokens',   null,                   formatCompact(periodData.totalTokens));
	updateCard('card-avg-tokens',     periodMeta.avgLabel,    formatCompact(periodData.avgPerPeriod));
	updateCard('card-total-sessions', null,                   periodData.totalSessions.toLocaleString());

	const title = document.getElementById('chart-title');
	if (title) { title.textContent = periodMeta.title; }

	const footer = document.getElementById('chart-footer');
	if (footer) {
		footer.textContent = `${periodMeta.footer}\nLast updated: ${new Date(data.lastUpdated).toLocaleString()}\nUpdates automatically every 5 minutes.`;
	}
}

function wireInteractions(data: InitialChartData): void {
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

	// Chart view toggle buttons
	const viewButtons = [
		{ id: 'view-total',      view: 'total'      as const },
		{ id: 'view-model',      view: 'model'      as const },
		{ id: 'view-editor',     view: 'editor'     as const },
		{ id: 'view-repository', view: 'repository' as const },
	];
	viewButtons.forEach(({ id, view }) => {
		const btn = document.getElementById(id);
		btn?.addEventListener('click', () => { void switchView(view, data); });
	});
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
	chart = new Chart(ctx, createConfig('total', data));
	// Restore the previously active period and view if a background update triggered a re-render
	if (pendingPeriod !== null && pendingPeriod !== 'day') {
		const periodToRestore = pendingPeriod;
		currentPeriod = 'day';
		await switchPeriod(periodToRestore, data);
	} else if (pendingView !== null && pendingView !== 'total') {
		const viewToRestore = pendingView;
		currentView = 'total';
		await switchView(viewToRestore, data);
	}
	pendingView = null;
	pendingPeriod = null;
}

async function switchPeriod(period: ChartPeriod, data: InitialChartData): Promise<void> {
	if (currentPeriod === period) {
		return;
	}
	currentPeriod = period;
	setActivePeriod(period);
	updateSummaryCards(data);
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
	chart = new Chart(ctx, createConfig(currentView, data));
}

async function switchView(view: 'total' | 'model' | 'editor' | 'repository', data: InitialChartData): Promise<void> {
	if (currentView === view) {
		return;
	}
	currentView = view;
	setActiveView(view);
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
	chart = new Chart(ctx, createConfig(view, data));
}

function setActivePeriod(period: ChartPeriod): void {
	(['period-day', 'period-week', 'period-month'] as const).forEach(id => {
		const btn = document.getElementById(id);
		if (!btn) { return; }
		btn.classList.toggle('active', id === `period-${period}`);
	});
}

function setActiveView(view: 'total' | 'model' | 'editor' | 'repository'): void {
	['view-total', 'view-model', 'view-editor', 'view-repository'].forEach(id => {
		const btn = document.getElementById(id);
		if (!btn) {
			return;
		}
		btn.classList.toggle('active', id === `view-${view}`);
	});
}

function createConfig(view: 'total' | 'model' | 'editor' | 'repository', data: InitialChartData): ChartConfig {
	const period = getActivePeriodData(data);

	// Get CSS variables for theme-aware colors
	const styles = getComputedStyle(document.body);
	const textColor = styles.getPropertyValue('--text-primary') || '#e0e0e0';
	const mutedColor = styles.getPropertyValue('--text-muted') || '#999999';
	const borderColor = styles.getPropertyValue('--border-subtle') || '#3a3a40';
	const bgColor = styles.getPropertyValue('--bg-tertiary') || '#1e1e1e';

	// Make grid lines very subtle with low opacity
	const gridColor = 'rgba(128, 128, 128, 0.15)';

	const baseOptions = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: { mode: 'index' as const, intersect: false },
		plugins: {
			legend: { position: 'top' as const, labels: { color: textColor, font: { size: 12 } } },
			tooltip: {
				backgroundColor: bgColor,
				titleColor: textColor,
				bodyColor: textColor,
				borderColor: borderColor,
				borderWidth: 1,
				padding: 10,
				displayColors: true
			}
		},
		scales: {
			x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 } } }
		} as const
	};

	if (view === 'total') {
		return {
			type: 'bar' as const,
			data: {
				labels: period.labels,
				datasets: [
					{
						label: 'Tokens',
						data: period.tokensData,
						backgroundColor: 'rgba(54, 162, 235, 0.6)',
						borderColor: 'rgba(54, 162, 235, 1)',
						borderWidth: 1,
						yAxisID: 'y'
					},
					{
						label: 'Sessions',
						data: period.sessionsData,
						backgroundColor: 'rgba(255, 99, 132, 0.6)',
						borderColor: 'rgba(255, 99, 132, 1)',
						borderWidth: 1,
						type: 'line' as const,
						yAxisID: 'y1'
					}
				]
			},
			options: {
				...baseOptions,
				scales: {
					...baseOptions.scales,
					y: {
						type: 'linear' as const,
						display: true,
						position: 'left' as const,
						grid: { color: gridColor },
						ticks: { color: textColor, font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() },
						title: { display: true, text: 'Tokens', color: textColor, font: { size: 12, weight: 'bold' } }
					},
					y1: {
						type: 'linear' as const,
						display: true,
						position: 'right' as const,
						grid: { drawOnChartArea: false },
						ticks: { color: textColor, font: { size: 11 } },
						title: { display: true, text: 'Sessions', color: textColor, font: { size: 12, weight: 'bold' } }
					}
				}
			}
		};
	}

	const datasets = view === 'model' ? period.modelDatasets : view === 'repository' ? period.repositoryDatasets : period.editorDatasets;

	// Add sessions line as an overlay on all stacked views
	const sessionsDataset = {
		label: 'Sessions',
		data: period.sessionsData,
		backgroundColor: 'rgba(255, 99, 132, 0.6)',
		borderColor: 'rgba(255, 99, 132, 1)',
		borderWidth: 2,
		type: 'line' as const,
		yAxisID: 'y1',
		stack: undefined // Don't stack the line
	};

	return {
		type: 'bar' as const,
		data: { labels: period.labels, datasets: [...datasets, sessionsDataset] },
		options: {
			...baseOptions,
			plugins: {
				...baseOptions.plugins,
				legend: { position: 'top' as const, labels: { color: textColor, font: { size: 11 } } }
			},
			scales: {
				...baseOptions.scales,
				y: {
					stacked: true,
					grid: { color: gridColor },
					ticks: { color: textColor, font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() },
					title: { display: true, text: 'Tokens', color: textColor, font: { size: 12, weight: 'bold' } }
				},
				x: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 } } },
				y1: {
					type: 'linear' as const,
					display: true,
					position: 'right' as const,
					grid: { drawOnChartArea: false },
					ticks: { color: textColor, font: { size: 11 } },
					title: { display: true, text: 'Sessions', color: textColor, font: { size: 12, weight: 'bold' } }
				}
			}
		}
	};
}


async function bootstrap(): Promise<void> {
	const { provideVSCodeDesignSystem, vsCodeButton } = await import('@vscode/webview-ui-toolkit');
	provideVSCodeDesignSystem().register(vsCodeButton());

	if (!initialData) {
		const root = document.getElementById('root');
		if (root) {
			root.textContent = 'No data available.';
		}
		return;
	}
	renderLayout(initialData);
}

void bootstrap();

// Listen for background data updates from the extension
window.addEventListener('message', (event: MessageEvent) => {
	const message = event.data;
	if (message.command === 'updateChartData') {
		// Save current toggles for restoration after chart re-initializes
		pendingView = currentView;
		pendingPeriod = currentPeriod;
		renderLayout(message.data as InitialChartData);
	}
});

