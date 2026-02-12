// @ts-nocheck // Chart.js ESM bundle is loaded dynamically; skip CJS resolution noise
import { el, createButton } from '../shared/domUtils';
import { BUTTONS } from '../shared/buttonConfig';
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

function renderLayout(data: InitialChartData): void {
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
	const title = el('span', 'header-title', 'Token Usage - Last 30 Days');
	headerLeft.append(icon, title);
	const buttons = el('div', 'button-row');
	buttons.append(
		createButton(BUTTONS['btn-refresh']),
		createButton(BUTTONS['btn-details']),
		createButton(BUTTONS['btn-usage']),
		createButton(BUTTONS['btn-diagnostics'])
	);
	header.append(headerLeft, buttons);

	const summarySection = el('div', 'section');
	summarySection.append(el('h3', '', '📊 Summary'));
	const cards = el('div', 'cards');
	cards.append(
		buildCard('Total Days', data.dailyCount.toLocaleString()),
		buildCard('Total Tokens', data.totalTokens.toLocaleString()),
		buildCard('Avg Tokens / Day', data.avgTokensPerDay.toLocaleString()),
		buildCard('Total Sessions', data.totalSessions.toLocaleString())
	);
	summarySection.append(cards);

	const editorCards = buildEditorCards(data.editorTotalsMap);
	if (editorCards) {
		summarySection.append(editorCards);
	}

	const chartSection = el('div', 'section');
	chartSection.append(el('h3', '', '📊 Charts'));

	const chartShell = el('div', 'chart-shell');
	const toggles = el('div', 'chart-controls');
	const totalBtn = el('button', 'toggle active', 'Total Tokens');
	totalBtn.id = 'view-total';
	const modelBtn = el('button', 'toggle', 'By Model');
	modelBtn.id = 'view-model';
	const editorBtn = el('button', 'toggle', 'By Editor');
	editorBtn.id = 'view-editor';
	const repoBtn = el('button', 'toggle', 'By Repository');
	repoBtn.id = 'view-repository';
	toggles.append(totalBtn, modelBtn, editorBtn, repoBtn);

	const canvasWrap = el('div', 'canvas-wrap');
	const canvas = document.createElement('canvas');
	canvas.id = 'token-chart';
	canvasWrap.append(canvas);

	chartShell.append(toggles, canvasWrap);
	chartSection.append(chartShell);

	const footer = el('div', 'footer', `Day-by-day token usage for the last 30 days\nLast updated: ${new Date(data.lastUpdated).toLocaleString()}\nUpdates automatically every 5 minutes.`);

	container.append(header, summarySection, chartSection, footer);
	root.append(themeStyle, style, container);

	wireInteractions(data);
	void setupChart(canvas, data);
}

function buildCard(label: string, value: string): HTMLElement {
	const card = el('div', 'card');
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
		wrap.append(buildCard(editor, tokens.toLocaleString()));
	});
	return wrap;
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

	const viewButtons = [
		{ id: 'view-total', view: 'total' as const },
		{ id: 'view-model', view: 'model' as const },
		{ id: 'view-editor', view: 'editor' as const },
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
}

async function switchView(view: 'total' | 'model' | 'editor' | 'repository', data: InitialChartData): Promise<void> {
	if (currentView === view) {
		return;
	}
	currentView = view;
	setActive(view);
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

function setActive(view: 'total' | 'model' | 'editor' | 'repository'): void {
	['view-total', 'view-model', 'view-editor', 'view-repository'].forEach(id => {
		const btn = document.getElementById(id);
		if (!btn) {
			return;
		}
		btn.classList.toggle('active', id === `view-${view}`);
	});
}

function createConfig(view: 'total' | 'model' | 'editor' | 'repository', data: InitialChartData): ChartConfig {
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
				labels: data.labels,
				datasets: [
					{
						label: 'Tokens',
						data: data.tokensData,
						backgroundColor: 'rgba(54, 162, 235, 0.6)',
						borderColor: 'rgba(54, 162, 235, 1)',
						borderWidth: 1,
						yAxisID: 'y'
					},
					{
						label: 'Sessions',
						data: data.sessionsData,
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

	const datasets = view === 'model' ? data.modelDatasets : view === 'repository' ? data.repositoryDatasets : data.editorDatasets;
	
	// Add sessions line as an overlay on all stacked views
	const sessionsDataset = {
		label: 'Sessions',
		data: data.sessionsData,
		backgroundColor: 'rgba(255, 99, 132, 0.6)',
		borderColor: 'rgba(255, 99, 132, 1)',
		borderWidth: 2,
		type: 'line' as const,
		yAxisID: 'y1',
		stack: undefined // Don't stack the line
	};
	
	return {
		type: 'bar' as const,
		data: { labels: data.labels, datasets: [...datasets, sessionsDataset] },
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

