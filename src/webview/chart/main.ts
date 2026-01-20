// @ts-nocheck // Chart.js ESM bundle is loaded dynamically; skip CJS resolution noise
type ChartModule = typeof import('chart.js/auto');
type ChartConstructor = ChartModule['default'];
type ChartInstance = InstanceType<ChartConstructor>;
type ChartConfig = import('chart.js').ChartConfiguration<'bar' | 'line', number[], string>;

type ModelDataset = { label: string; data: number[]; backgroundColor: string; borderColor: string; borderWidth: number };
type EditorDataset = ModelDataset;

type InitialChartData = {
	labels: string[];
	tokensData: number[];
	sessionsData: number[];
	modelDatasets: ModelDataset[];
	editorDatasets: EditorDataset[];
	editorTotalsMap: Record<string, number>;
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

let chart: ChartInstance | undefined;
let Chart: ChartConstructor | undefined;

async function loadChartModule(): Promise<void> {
	if (Chart) {
		return;
	}
	const mod = await import('chart.js/auto');
	Chart = mod.default;
}
let currentView: 'total' | 'model' | 'editor' = 'total';

function renderLayout(data: InitialChartData): void {
	const root = document.getElementById('root');
	if (!root) {
		return;
	}

	root.replaceChildren();

	const style = document.createElement('style');
	style.textContent = `
		:root { color: #e7e7e7; background: #0e0e0f; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
		body { margin: 0; background: #0e0e0f; }
		.container { padding: 16px; display: flex; flex-direction: column; gap: 14px; max-width: 1200px; margin: 0 auto; }
		.header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 4px; }
		.header-left { display: flex; align-items: center; gap: 8px; }
		.header-icon { font-size: 20px; }
		.header-title { font-size: 16px; font-weight: 700; color: #fff; text-align: left; }
		.button-row { display: flex; flex-wrap: wrap; gap: 8px; }
		.section { background: linear-gradient(135deg, #1b1b1e 0%, #1f1f22 100%); border: 1px solid #2e2e34; border-radius: 10px; padding: 12px; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.28); text-align: center; }
		.section h3 { margin: 0 0 10px 0; font-size: 14px; display: flex; align-items: center; gap: 6px; color: #ffffff; letter-spacing: 0.2px; text-align: left; }
		.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; text-align: center; }
		.card { background: #1b1b1e; border: 1px solid #2a2a30; border-radius: 8px; padding: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.24); text-align: center; }
		.card-label { color: #b8b8b8; font-size: 11px; margin-bottom: 6px; }
		.card-value { color: #f6f6f6; font-size: 18px; font-weight: 700; }
		.card-sub { color: #9aa0a6; font-size: 11px; margin-top: 2px; }
		.chart-shell { background: #1b1b1e; border: 1px solid #2a2a30; border-radius: 10px; padding: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.22); text-align: center; }
		.chart-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; justify-content: center; }
		.toggle { background: #202024; border: 1px solid #2d2d33; color: #e7e7e7; padding: 8px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.15s ease; }
		.toggle.active { background: #0e639c; border-color: #1177bb; color: #fff; }
		.toggle:hover { background: #2a2a30; }
		.toggle.active:hover { background: #1177bb; }
		.canvas-wrap { position: relative; height: 420px; }
		.footer { color: #a0a0a0; font-size: 11px; margin-top: 6px; text-align: center; }
		.footer em { color: #c0c0c0; }
	`;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const headerLeft = el('div', 'header-left');
	const icon = el('span', 'header-icon', '📈');
	const title = el('span', 'header-title', 'Token Usage Over Time');
	headerLeft.append(icon, title);
	const buttons = el('div', 'button-row');
	const refreshBtn = document.createElement('vscode-button');
	refreshBtn.id = 'btn-refresh';
	refreshBtn.setAttribute('appearance', 'primary');
	refreshBtn.textContent = '🔄 Refresh';
	const detailsBtn = document.createElement('vscode-button');
	detailsBtn.id = 'btn-details';
	detailsBtn.textContent = '🤖 Details';
	const usageBtn = document.createElement('vscode-button');
	usageBtn.id = 'btn-usage';
	usageBtn.textContent = '📊 Usage Analysis';
	const diagnosticsBtn = document.createElement('vscode-button');
	diagnosticsBtn.id = 'btn-diagnostics';
	diagnosticsBtn.textContent = '🔍 Diagnostics';
	buttons.append(refreshBtn, detailsBtn, usageBtn, diagnosticsBtn);
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
	toggles.append(totalBtn, modelBtn, editorBtn);

	const canvasWrap = el('div', 'canvas-wrap');
	const canvas = document.createElement('canvas');
	canvas.id = 'token-chart';
	canvasWrap.append(canvas);

	chartShell.append(toggles, canvasWrap);
	chartSection.append(chartShell);

	const footer = el('div', 'footer', `Day-by-day token usage for the current month\nLast updated: ${new Date(data.lastUpdated).toLocaleString()}\nUpdates automatically every 5 minutes.`);

	container.append(header, summarySection, chartSection, footer);
	root.append(style, container);

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

async function switchView(view: 'total' | 'model' | 'editor', data: InitialChartData): Promise<void> {
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

function setActive(view: 'total' | 'model' | 'editor'): void {
	['view-total', 'view-model', 'view-editor'].forEach(id => {
		const btn = document.getElementById(id);
		if (!btn) {
			return;
		}
		btn.classList.toggle('active', id === `view-${view}`);
	});
}

function createConfig(view: 'total' | 'model' | 'editor', data: InitialChartData): ChartConfig {
	const baseOptions = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: { mode: 'index' as const, intersect: false },
		plugins: {
			legend: { position: 'top' as const, labels: { color: '#e7e7e7', font: { size: 12 } } },
			tooltip: {
				backgroundColor: 'rgba(0,0,0,0.85)',
				titleColor: '#ffffff',
				bodyColor: '#d0d0d0',
				borderColor: '#2a2a30',
				borderWidth: 1,
				padding: 10,
				displayColors: true
			}
		},
		scales: {
			x: { grid: { color: '#2d2d33' }, ticks: { color: '#c8c8c8', font: { size: 11 } } }
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
						grid: { color: '#2d2d33' },
						ticks: { color: '#c8c8c8', font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() },
						title: { display: true, text: 'Tokens', color: '#d0d0d0', font: { size: 12, weight: 'bold' } }
					},
					y1: {
						type: 'linear' as const,
						display: true,
						position: 'right' as const,
						grid: { drawOnChartArea: false },
						ticks: { color: '#c8c8c8', font: { size: 11 } },
						title: { display: true, text: 'Sessions', color: '#d0d0d0', font: { size: 12, weight: 'bold' } }
					}
				}
			}
		};
	}

	const datasets = view === 'model' ? data.modelDatasets : data.editorDatasets;
	return {
		type: 'bar' as const,
		data: { labels: data.labels, datasets },
		options: {
			...baseOptions,
			plugins: {
				...baseOptions.plugins,
				legend: { position: 'top' as const, labels: { color: '#e7e7e7', font: { size: 11 } } }
			},
			scales: {
				...baseOptions.scales,
				y: { stacked: true, grid: { color: '#2d2d33' }, ticks: { color: '#c8c8c8', font: { size: 11 }, callback: (value: any) => Number(value).toLocaleString() } },
				x: { stacked: true, grid: { color: '#2d2d33' }, ticks: { color: '#c8c8c8', font: { size: 11 } } }
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
