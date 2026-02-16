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
	totalTokens: number;
	totalInteractions: number;
	totalCost: number;
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
	const title = el('div', 'title', '📊 Team Dashboard');
	const buttonRow = el('div', 'button-row');

	buttonRow.append(
		createButton(BUTTONS['btn-refresh']),
		createButton(BUTTONS['btn-details']),
		createButton(BUTTONS['btn-chart']),
		createButton(BUTTONS['btn-usage']),
		createButton(BUTTONS['btn-diagnostics']),
		createButton(BUTTONS['btn-maturity'])
	);

	header.append(title, buttonRow);

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

	const leaderboard = buildLeaderboard(stats);
	
	section.append(sectionTitle, teamGrid, leaderboard);
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
	
	['Rank', 'User', 'Tokens', 'Interactions', 'Est. Cost'].forEach(text => {
		const th = el('th', '', text);
		headerRow.append(th);
	});
	thead.append(headerRow);
	
	const tbody = el('tbody', '');
	
	for (const member of stats.team.members) {
		const row = el('tr', '');
		
		// Highlight current user
		const isCurrentUser = member.userId === stats.personal.userId;
		if (isCurrentUser) {
			row.classList.add('current-user');
		}
		
		const rankCell = el('td', 'rank-cell', `#${member.rank}`);
		const userCell = el('td', '', isCurrentUser ? `${member.userId} (You)` : member.userId);
		const tokensCell = el('td', 'number-cell', formatNumber(member.totalTokens));
		const interactionsCell = el('td', 'number-cell', formatNumber(member.totalInteractions));
		const costCell = el('td', 'number-cell', formatCost(member.totalCost));
		
		row.append(rankCell, userCell, tokensCell, interactionsCell, costCell);
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

if (initialData) {
	render(initialData);
} else {
	const root = document.getElementById('root');
	if (root) {
		root.textContent = 'No dashboard data available. Please configure backend sync.';
	}
}
