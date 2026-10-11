// Fluency Level Viewer webview
import { buttonHtml } from '../shared/buttonConfig';
import { setHtml } from '../shared/domUtils';
import { escapeHtml, markdownToHtml, STAGE_LABELS, STAGE_DESCRIPTIONS } from '../shared/formatUtils';
import { wireExtensionPointButtons } from '../shared/extensionPoints';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import type { CategoryLevelData } from '../shared/types';
import { applyWebviewLocale } from '../shared/webviewLocale';
import { installSurfaceNavigation } from '../shared/surfaceNavigation';

// ── Types ──────────────────────────────────────────────────────────────

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

const vscode = acquireVsCodeApi();
installSurfaceNavigation(vscode, 'fluency-level-viewer');
const initialData = getWindowData<FluencyLevelData & { localization?: Record<string, string> }>('__INITIAL_FLUENCY_LEVEL_DATA__');

// Initialize localization for webview
applyWebviewLocale(initialData);

let selectedCategoryIndex = 0;


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
					<span>${markdownToHtml(tip)}</span>
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

function wireNavButtons(data: FluencyLevelData): void {
	document.getElementById('btn-refresh')?.addEventListener('click', () => { vscode.postMessage({ command: 'refresh' }); });
	document.getElementById('btn-maturity')?.addEventListener('click', () => { vscode.postMessage({ command: 'showMaturity' }); });
	document.getElementById('btn-details')?.addEventListener('click', () => { vscode.postMessage({ command: 'showDetails' }); });
	document.getElementById('btn-chart')?.addEventListener('click', () => { vscode.postMessage({ command: 'showChart' }); });
	document.getElementById('btn-usage')?.addEventListener('click', () => { vscode.postMessage({ command: 'showUsageAnalysis' }); });
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => { vscode.postMessage({ command: 'showDiagnostics' }); });
	document.getElementById('btn-dashboard')?.addEventListener('click', () => { vscode.postMessage({ command: 'showDashboard' }); });
	wireExtensionPointButtons(vscode);
	document.querySelectorAll('.category-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			const target = e.currentTarget as HTMLElement;
			selectedCategoryIndex = parseInt(target.getAttribute('data-index') || '0', 10);
			renderLayout(data);
		});
	});
}

function renderLayout(data: FluencyLevelData): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	const selectedCategory = data.categories[selectedCategoryIndex];

	setHtml(root, `
		<style>${styles}</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">📊</span>
					<span class="header-title">Scoring Guide</span>
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
					This tool shows all fluency score rules, thresholds, and tips for each category and stage.
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
				📊 Scoring Guide &middot; ${data.categories.length} categories &middot; 4 stages each
			</div>
		</div>
	`);

	wireNavButtons(data);
}

async function bootstrap(): Promise<void> {
	await import('@vscode-elements/elements/dist/vscode-button/index.js');

	if (!initialData) {
		const root = document.getElementById('root');
		if (root) { root.textContent = 'No data available.'; }
		return;
	}
	renderLayout(initialData);
}

void bootstrap();
