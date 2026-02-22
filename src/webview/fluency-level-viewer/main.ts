// Fluency Level Viewer webview
import { buttonHtml } from '../shared/buttonConfig';
import styles from './styles.css';

// ── Types ──────────────────────────────────────────────────────────────

type CategoryLevelData = {
	category: string;
	icon: string;
	levels: LevelInfo[];
};

type LevelInfo = {
	stage: number;
	label: string;
	description: string;
	thresholds: string[];
	tips: string[];
};

type FluencyLevelData = {
	categories: CategoryLevelData[];
	isDebugMode: boolean;
	backendConfigured?: boolean;
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

declare global {
	interface Window { __INITIAL_FLUENCY_LEVEL_DATA__?: FluencyLevelData; }
}

const vscode = acquireVsCodeApi();
const initialData = window.__INITIAL_FLUENCY_LEVEL_DATA__;

let selectedCategoryIndex = 0;

// ── Stage labels ───────────────────────────────────────────────────────

const STAGE_LABELS: Record<number, string> = {
	1: 'Stage 1: Copilot Skeptic',
	2: 'Stage 2: Copilot Explorer',
	3: 'Stage 3: Copilot Collaborator',
	4: 'Stage 4: Copilot Strategist'
};

const STAGE_DESCRIPTIONS: Record<number, string> = {
	1: 'Rarely uses Copilot or uses only basic features',
	2: 'Exploring Copilot capabilities with occasional use',
	3: 'Regular, purposeful use across multiple features',
	4: 'Strategic, advanced use leveraging the full Copilot ecosystem'
};

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

// ── Main render ────────────────────────────────────────────────────────

function renderCategorySelector(categories: CategoryLevelData[]): string {
	return categories.map((cat, idx) => `
		<button class="category-btn ${idx === selectedCategoryIndex ? 'active' : ''}" data-index="${idx}">
			<span class="icon">${cat.icon}</span>
			<span>${escapeHtml(cat.category)}</span>
		</button>
	`).join('');
}

function renderLevelCards(category: CategoryLevelData): string {
	return category.levels.map(level => {
		const thresholdsHtml = level.thresholds.length > 0
			? level.thresholds.map(t => `
				<li class="threshold-item">
					<span class="threshold-icon">▸</span>
					<span>${escapeHtml(t)}</span>
				</li>
			`).join('')
			: '<li class="threshold-item"><span class="threshold-icon">-</span><span>No specific thresholds</span></li>';

		const tipsHtml = level.tips.length > 0
			? level.tips.map(tip => `
				<li class="tip-item-viewer">
					<span class="tip-icon">💡</span>
					<span>${escapeHtml(tip)}</span>
				</li>
			`).join('')
			: '<li class="tip-item-viewer"><span class="tip-icon">✓</span><span>No specific suggestions - you\'re at the highest level!</span></li>';

		return `
			<div class="level-card stage-${level.stage}">
				<div class="level-header">
					<div class="level-title">${escapeHtml(level.label)}</div>
					<div class="level-badge badge-${level.stage}">Stage ${level.stage}</div>
				</div>
				<div class="level-description">${escapeHtml(level.description)}</div>
				
				<div class="threshold-section">
					<div class="threshold-title">🎯 Requirements to Reach This Stage</div>
					<ul class="threshold-list">${thresholdsHtml}</ul>
				</div>
				
				${level.tips.length > 0 ? `
				<div class="tips-section">
					<div class="tips-title">💡 Next Steps (if below this stage)</div>
					<ul class="tips-list">${tipsHtml}</ul>
				</div>
				` : ''}
			</div>
		`;
	}).join('');
}

function renderLayout(data: FluencyLevelData): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	const selectedCategory = data.categories[selectedCategoryIndex];

	root.innerHTML = `
		<style>${styles}</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">🔍</span>
					<span class="header-title">Fluency Level Viewer</span>
					${data.isDebugMode ? '<span class="debug-badge">🐛 DEBUG MODE</span>' : ''}
				</div>
				<div class="button-row">
					${buttonHtml('btn-refresh')}
					${buttonHtml('btn-maturity')}
					${buttonHtml('btn-details')}
					${buttonHtml('btn-chart')}
					${buttonHtml('btn-usage')}
					${buttonHtml('btn-diagnostics')}
					${data.backendConfigured ? buttonHtml('btn-dashboard') : ''}
				</div>
			</div>

			<div class="info-box">
				<div class="info-box-title">📋 About This Tool</div>
				<div>
					This debug-only tool shows all fluency score rules, thresholds, and tips for each category and stage.
					Use it to understand how the scoring system works and what actions trigger different fluency levels.
					Select a category below to view its stage definitions and advancement criteria.
				</div>
			</div>

			<div class="category-selector">
				${renderCategorySelector(data.categories)}
			</div>

			<div class="level-grid">
				${renderLevelCards(selectedCategory)}
			</div>

			<div class="footer">
				🐛 Debug Tool - Only available when a debugger is active &middot; ${data.categories.length} categories &middot; 4 stages each
			</div>
		</div>
	`;

	// Wire up navigation buttons
	document.getElementById('btn-refresh')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'refresh' });
	});
	document.getElementById('btn-maturity')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showMaturity' });
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
	document.getElementById('btn-dashboard')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDashboard' });
	});

	// Wire up category selection buttons
	document.querySelectorAll('.category-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			const target = e.currentTarget as HTMLElement;
			const index = parseInt(target.getAttribute('data-index') || '0', 10);
			selectedCategoryIndex = index;
			renderLayout(data);
		});
	});
}

async function bootstrap(): Promise<void> {
	const { provideVSCodeDesignSystem, vsCodeButton } = await import('@vscode/webview-ui-toolkit');
	provideVSCodeDesignSystem().register(vsCodeButton());

	if (!initialData) {
		const root = document.getElementById('root');
		if (root) { root.textContent = 'No data available.'; }
		return;
	}
	renderLayout(initialData);
}

void bootstrap();
