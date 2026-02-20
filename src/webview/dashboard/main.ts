// Import shared utilities
import { getModelDisplayName } from '../shared/modelUtils';
import { formatNumber, formatCost, formatPercent } from '../shared/formatUtils';
import { el, createButton } from '../shared/domUtils';
import { BUTTONS } from '../shared/buttonConfig';
import themeStyles from '../shared/theme.css';
import styles from './styles.css';

type ModelUsage = Record<string, { inputTokens: number; outputTokens: number }>;

interface UserSummary {
	userId: string;
	totalTokens: number;
	totalInteractions: number;
	totalCost: number;
	devices: string[];
	workspaces: string[];
	modelUsage: ModelUsage;
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
	lastUpdated: string | Date;
}

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: any) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

declare global {
	interface Window {
		__INITIAL_DASHBOARD__?: DashboardStats;
	}
}

const vscode: VSCodeApi = acquireVsCodeApi();
const initialData = window.__INITIAL_DASHBOARD__;
console.log('[CopilotTokenTracker] dashboard webview loaded');
console.log('[CopilotTokenTracker] initialData:', initialData);

function showLoading(): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	root.replaceChildren();

	const themeStyle = document.createElement('style');
	themeStyle.textContent = themeStyles;

	const style = document.createElement('style');
	style.textContent = styles;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const title = el('div', 'title', '📊 Team Dashboard');
	header.append(title);

	const loading = el('div', 'loading-indicator');
	const spinner = el('div', 'spinner');
	const loadingText = el('div', 'loading-text', 'Loading dashboard data...');
	loading.append(spinner, loadingText);

	container.append(header, loading);
	root.append(themeStyle, style, container);
}

function showError(message: string): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	root.replaceChildren();

	const themeStyle = document.createElement('style');
	themeStyle.textContent = themeStyles;

	const style = document.createElement('style');
	style.textContent = styles;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const title = el('div', 'title', '📊 Team Dashboard');
	const buttonRow = el('div', 'button-row');
	buttonRow.append(createButton(BUTTONS['btn-refresh']));
	header.append(title, buttonRow);

	const errorEl = el('div', 'error-message', message);

	container.append(header, errorEl);
	root.append(themeStyle, style, container);
	wireButtons();
}

function render(stats: DashboardStats): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	renderShell(root, stats);
	wireButtons();
}

function renderShell(root: HTMLElement, stats: DashboardStats): void {
	const lastUpdated = new Date(stats.lastUpdated);

	root.replaceChildren();

	const themeStyle = document.createElement('style');
	themeStyle.textContent = themeStyles;
	
	const style = document.createElement('style');
	style.textContent = styles;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const titleGroup = el('div', 'title-group');
	const title = el('div', 'title', '📊 Team Dashboard');
	const period = el('div', 'period', 'Last 30 days');
	titleGroup.append(title, period);
	const buttonRow = el('div', 'button-row');

	buttonRow.append(
		createButton(BUTTONS['btn-refresh']),
		createButton(BUTTONS['btn-details']),
		createButton(BUTTONS['btn-chart']),
		createButton(BUTTONS['btn-usage']),
		createButton(BUTTONS['btn-diagnostics']),
		createButton(BUTTONS['btn-maturity'])
	);

	header.append(titleGroup, buttonRow);

	const footer = el('div', 'footer', `Last updated: ${lastUpdated.toLocaleString()}`);

	const sections = el('div', 'sections');
	sections.append(buildPersonalSection(stats.personal));
	sections.append(buildTeamSection(stats));

	container.append(header, sections, footer);
	root.append(themeStyle, style, container);
}

function buildPersonalSection(personal: UserSummary): HTMLElement {
	const section = el('div', 'section');
	const sectionTitle = el('h2', '', '👤 Your Summary (All Devices & Workspaces)');
	
	const grid = el('div', 'stats-grid');
	
	grid.append(
		buildStatCard('Total Tokens', formatNumber(personal.totalTokens)),
		buildStatCard('Interactions', formatNumber(personal.totalInteractions)),
		buildStatCard('Estimated Cost', formatCost(personal.totalCost)),
		buildStatCard('Devices', personal.devices.length.toString()),
		buildStatCard('Workspaces', personal.workspaces.length.toString())
	);

	const modelSection = buildModelBreakdown(personal.modelUsage);
	
	section.append(sectionTitle, grid, modelSection);
	return section;
}

function buildTeamSection(stats: DashboardStats): HTMLElement {
	const section = el('div', 'section');
	const sectionTitle = el('h2', '', '👥 Team Comparison');
	
	const teamGrid = el('div', 'stats-grid');
	teamGrid.append(
		buildStatCard('Team Total', formatNumber(stats.team.totalTokens) + ' tokens'),
		buildStatCard('Team Members', stats.team.members.length.toString()),
		buildStatCard('Avg per User', formatNumber(Math.round(stats.team.averageTokensPerUser)) + ' tokens')
	);

	// Add date range info if available
	console.log('Team firstDate:', stats.team.firstDate, 'lastDate:', stats.team.lastDate);
	let dateInfo: HTMLElement | null = null;
	if (stats.team.firstDate || stats.team.lastDate) {
		dateInfo = el('div', 'info-box');
		dateInfo.style.cssText = 'margin-top: 16px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 6px; font-size: 13px; color: #aaa;';
		const firstDate = stats.team.firstDate;
		const lastDate = stats.team.lastDate;
		if (firstDate && lastDate) {
			dateInfo.textContent = `📅 Data Range: ${firstDate} to ${lastDate}`;
		} else if (firstDate) {
			dateInfo.textContent = `📅 First Data: ${firstDate}`;
		} else if (lastDate) {
			dateInfo.textContent = `📅 Last Data: ${lastDate}`;
		}
		console.log('Date info element created');
	} else {
		console.log('No date range data available');
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
	const card = el('div', 'stat-card');
	const labelEl = el('div', 'stat-label', label);
	const valueEl = el('div', 'stat-value', value);
	card.append(labelEl, valueEl);
	return card;
}

function buildModelBreakdown(modelUsage: ModelUsage): HTMLElement {
	const container = el('div', 'model-breakdown');
	const title = el('h3', '', 'Model Usage');
	
	const modelList = el('div', 'model-list');
	
	const models = Object.entries(modelUsage)
		.map(([model, usage]) => ({
			model,
			tokens: usage.inputTokens + usage.outputTokens
		}))
		.sort((a, b) => b.tokens - a.tokens);

	for (const { model, tokens } of models) {
		const item = el('div', 'model-item');
		const modelName = el('span', 'model-name', getModelDisplayName(model));
		const tokenCount = el('span', 'token-count', formatNumber(tokens));
		item.append(modelName, tokenCount);
		modelList.append(item);
	}
	
	container.append(title, modelList);
	return container;
}

function buildLeaderboard(stats: DashboardStats): HTMLElement {
	const container = el('div', 'leaderboard');
	const title = el('h3', '', 'Leaderboard');
	
	const table = el('table', 'leaderboard-table');
	const thead = el('thead', '');
	const headerRow = el('tr', '');
	
	const headers = [
		{ text: '#', class: 'rank-header' },
		{ text: 'User', class: '' },
		{ text: 'Dataset', class: '' },
		{ text: 'Tokens', class: 'number-header' },
		{ text: 'Days', class: 'number-header' },
		{ text: 'Sessions', class: 'number-header' },
		{ text: 'Avg Turns', class: 'number-header' },
		{ text: 'Models', class: 'number-header' },
		{ text: 'Projects', class: 'number-header' },
		{ text: 'Tok/Turn', class: 'number-header' },
		{ text: 'Cost', class: 'number-header' }
	];
	
	headers.forEach(header => {
		const th = el('th', header.class, header.text);
		headerRow.append(th);
	});
	thead.append(headerRow);
	
	const tbody = el('tbody', '');
	
	for (const member of stats.team.members) {
		const row = el('tr', '');
		
		// Strip prefixes for display (u:, ds:)
		const displayUserId = member.userId.replace(/^u:/, '');
		const displayDatasetId = (member.datasetId || '').replace(/^ds:/, '');
		
		// Highlight current user
		const isCurrentUser = member.userId === stats.personal.userId;
		if (isCurrentUser) {
			row.classList.add('current-user');
		}
		
		const rankCell = el('td', 'rank-cell', `${member.rank}`);
		const userCell = el('td', '', isCurrentUser ? `${displayUserId} (You)` : displayUserId);
		const datasetCell = el('td', 'dataset-cell', displayDatasetId);
		const tokensCell = el('td', 'number-cell', formatNumber(member.totalTokens));
		const daysCell = el('td', 'number-cell', formatNumber(member.daysActive));
		const sessionsCell = el('td', 'number-cell', formatNumber(member.sessions));
		const avgTurnsCell = el('td', 'number-cell', formatNumber(member.avgTurnsPerSession));
		const modelsCell = el('td', 'number-cell', formatNumber(member.uniqueModels));
		const projectsCell = el('td', 'number-cell', formatNumber(member.uniqueWorkspaces));
		const tokPerTurnCell = el('td', 'number-cell', formatNumber(member.avgTokensPerTurn));
		const costCell = el('td', 'number-cell', formatCost(member.totalCost));
		
		row.append(rankCell, userCell, datasetCell, tokensCell, daysCell, sessionsCell, avgTurnsCell, modelsCell, projectsCell, tokPerTurnCell, costCell);
		tbody.append(row);
	}
	
	table.append(thead, tbody);
	container.append(title, table);
	return container;
}

function wireButtons(): void {
	document.getElementById('btn-refresh')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'refresh' });
	});

	document.getElementById('btn-details')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDetails' });
	});

	document.getElementById('btn-chart')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showChart' });
	});

	document.getElementById('btn-usage')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showUsageAnalysis' });
	});

	document.getElementById('btn-diagnostics')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDiagnostics' });
	});

	document.getElementById('btn-maturity')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showMaturity' });
	});
	
	// Note: No dashboard button handler - users are already on the dashboard
}

// Listen for messages from the extension
window.addEventListener('message', (event) => {
	const message = event.data;
	switch (message.command) {
		case 'dashboardData':
			console.log('Dashboard data received:', JSON.stringify(message.data.team, null, 2));
			render(message.data);
			break;
		case 'dashboardLoading':
			showLoading();
			break;
		case 'dashboardError':
			showError(message.message);
			break;
	}
});

async function bootstrap(): Promise<void> {
	console.log('[CopilotTokenTracker] dashboard bootstrap called');
	const { provideVSCodeDesignSystem, vsCodeButton } = await import('@vscode/webview-ui-toolkit');
	provideVSCodeDesignSystem().register(vsCodeButton());

	if (initialData) {
		render(initialData);
	} else {
		showLoading();
	}
}

bootstrap().catch(err => {
	console.error('[CopilotTokenTracker] Failed to bootstrap dashboard:', err);
	const root = document.getElementById('root');
	if (root) {
		root.textContent = 'Failed to initialize dashboard.';
	}
});
