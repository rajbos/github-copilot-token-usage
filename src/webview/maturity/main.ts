// Maturity Score webview
import { buttonHtml } from '../shared/buttonConfig';
import type { ContextReferenceUsage } from '../shared/contextRefUtils';
import styles from './styles.css';

// ── Types ──────────────────────────────────────────────────────────────

type ModeUsage = { ask: number; edit: number; agent: number };
type ToolCallUsage = { total: number; byTool: { [key: string]: number } };
type McpToolUsage = { total: number; byServer: { [key: string]: number }; byTool: { [key: string]: number } };
type ModelSwitchingAnalysis = {
	modelsPerSession: number[];
	totalSessions: number;
	averageModelsPerSession: number;
	maxModelsPerSession: number;
	switchingFrequency: number;
	standardModels: string[];
	premiumModels: string[];
	unknownModels: string[];
	mixedTierSessions: number;
};

type UsageAnalysisPeriod = {
	sessions: number;
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
	modelSwitching: ModelSwitchingAnalysis;
	repositories: string[];
	repositoriesWithCustomization: string[];
	editScope?: { singleFileEdits: number; multiFileEdits: number; totalEditedFiles: number; avgFilesPerSession: number };
	applyUsage?: { totalApplies: number; totalCodeBlocks: number; applyRate: number };
	sessionDuration?: { totalDurationMs: number; avgDurationMs: number; avgFirstProgressMs: number; avgTotalElapsedMs: number; avgWaitTimeMs: number };
	conversationPatterns?: { multiTurnSessions: number; singleTurnSessions: number; avgTurnsPerSession: number; maxTurnsInSession: number };
	agentTypes?: { editsAgent: number; defaultAgent: number; workspaceAgent: number; other: number };
};

type CategoryScore = {
	category: string;
	icon: string;
	stage: number;       // 1-4
	evidence: string[];  // what signals led to this score
	tips: string[];      // suggestions to reach next stage
};

type MaturityData = {
	overallStage: number;
	overallLabel: string;
	categories: CategoryScore[];
	period: UsageAnalysisPeriod;
	lastUpdated: string;
	dismissedTips?: string[];
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

declare global {
	interface Window { __INITIAL_MATURITY__?: MaturityData; }
}

const vscode = acquireVsCodeApi();
const initialData = window.__INITIAL_MATURITY__;

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

// ── Radar chart SVG ────────────────────────────────────────────────────

function renderRadarChart(categories: CategoryScore[]): string {
	const cx = 275, cy = 275, maxR = 150;
	const n = categories.length;
	const angleStep = (2 * Math.PI) / n;
	// Start from top (- PI/2)
	const startAngle = -Math.PI / 2;

	// Grid rings (1–4)
	const rings = [1, 2, 3, 4].map(level => {
		const r = (level / 4) * maxR;
		const points = Array.from({ length: n }, (_, i) => {
			const angle = startAngle + i * angleStep;
			return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
		}).join(' ');
		return `<polygon points="${points}" fill="none" stroke="#2a2a40" stroke-width="1" />`;
	}).join('');

	// Axis lines
	const axes = Array.from({ length: n }, (_, i) => {
		const angle = startAngle + i * angleStep;
		const x2 = cx + maxR * Math.cos(angle);
		const y2 = cy + maxR * Math.sin(angle);
		return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#2a2a40" stroke-width="1" />`;
	}).join('');

	// Data polygon
	const dataPoints = categories.map((cat, i) => {
		const r = (cat.stage / 4) * maxR;
		const angle = startAngle + i * angleStep;
		return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
	}).join(' ');

	// Labels
	const labels = categories.map((cat, i) => {
		const angle = startAngle + i * angleStep;
		const labelR = maxR + 28;
		const x = cx + labelR * Math.cos(angle);
		const y = cy + labelR * Math.sin(angle);
		// Adjust anchor based on position
		let anchor = 'middle';
		if (Math.cos(angle) < -0.3) { anchor = 'end'; }
		else if (Math.cos(angle) > 0.3) { anchor = 'start'; }
		return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central"
			font-size="11" fill="#d0d0d0" font-weight="600">${cat.icon} ${cat.category}</text>`;
	}).join('');

	// Stage dots
	const dots = categories.map((cat, i) => {
		const r = (cat.stage / 4) * maxR;
		const angle = startAngle + i * angleStep;
		const x = cx + r * Math.cos(angle);
		const y = cy + r * Math.sin(angle);
		const color = stageColor(cat.stage);
		return `<circle cx="${x}" cy="${y}" r="5" fill="${color}" stroke="#fff" stroke-width="1.5" />`;
	}).join('');

	// Ring labels
	const ringLabels = [1, 2, 3, 4].map(level => {
		const r = (level / 4) * maxR;
		return `<text x="${cx + 4}" y="${cy - r + 3}" font-size="9" fill="#555">${level}</text>`;
	}).join('');

	return `<svg viewBox="0 0 550 550" class="radar-svg" xmlns="http://www.w3.org/2000/svg">
		${rings}
		${axes}
		<polygon points="${dataPoints}" fill="rgba(59,130,246,0.15)" stroke="#3b82f6" stroke-width="2" />
		${dots}
		${labels}
		${ringLabels}
	</svg>`;
}

function stageColor(stage: number): string {
	switch (stage) {
		case 1: return '#ef4444';
		case 2: return '#f59e0b';
		case 3: return '#3b82f6';
		case 4: return '#10b981';
		default: return '#666';
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

// ── Main render ────────────────────────────────────────────────────────

function renderLayout(data: MaturityData): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	const dismissedTips = data.dismissedTips || [];

	const categoryCards = data.categories.map(cat => {
		const progressPct = (cat.stage / 4) * 100;
		const color = stageColor(cat.stage);
		const evidenceHtml = cat.evidence.map(e =>
			`<li class="evidence-item"><span class="evidence-icon">&#x2713;</span><span>${escapeHtml(e)}</span></li>`
		).join('');
		const tipsHtml = cat.tips.length > 0
			? cat.tips.map(t => `<div class="tip-item">${escapeHtml(t)}</div>`).join('')
			: '<div class="tip-item" style="color:#666;">No specific suggestions - you\'re doing great!</div>';

		// Check if tips are dismissed for this category
		const tipsAreDismissed = dismissedTips.includes(cat.category);
		
		// Add MCP discovery button for Tool Usage category
		const mcpButton = cat.category === 'Tool Usage' ? `
			<div style="margin-top: 10px;">
				<button class="mcp-discover-btn" data-action="searchMcp">🔍 Discover MCP Servers in Marketplace</button>
			</div>
		` : '';

		return `
			<div class="category-card">
				<div class="category-header">
					<span class="category-name">${cat.icon} ${escapeHtml(cat.category)}</span>
					<span class="category-stage-badge badge-${cat.stage}">Stage ${cat.stage}</span>
				</div>
				<div class="category-stage-label">${escapeHtml(STAGE_LABELS[cat.stage] || 'Unknown')}</div>
				<div class="category-progress">
					<div class="category-progress-fill" style="width: ${progressPct}%; background: ${color};"></div>
				</div>
				<ul class="evidence-list">${evidenceHtml || '<li class="evidence-item"><span class="evidence-icon">-</span><span>No significant activity detected</span></li>'}</ul>
				${!tipsAreDismissed && cat.tips.length > 0 ? `
					<div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2a30;">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
							<div style="font-size: 11px; font-weight: 600; color: #f59e0b;">💡 Next steps to level up:</div>
							<button class="dismiss-tips-btn" data-category="${escapeHtml(cat.category)}" title="Dismiss these tips">✕</button>
						</div>
						${tipsHtml}
					</div>
				` : ''}${mcpButton}</div>`;
	}).join('');

	root.innerHTML = `
		<style>${styles}</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">🎯</span>
					<span class="header-title">Copilot Fluency Score</span>
				</div>
				<div class="button-row">
					${buttonHtml('btn-refresh')}
					${buttonHtml('btn-details')}
					${buttonHtml('btn-usage')}
					${buttonHtml('btn-diagnostics')}
				</div>
			</div>

			<div class="info-box">
				<div class="info-box-title">📋 About This Dashboard</div>
				<div>
					This dashboard maps your GitHub Copilot usage patterns from the last 30 days to a maturity model with 4 stages across 6 categories.
					It helps you understand which Copilot capabilities you already use and suggests areas to explore for greater productivity.
					<br><br>
					<strong>Note:</strong> Scores are based on data from session log files. Some features (e.g., inline suggestion acceptance) cannot be tracked via logs.
				</div>
			</div>

			<!-- Overall stage banner -->
			<div class="stage-banner">
				<div class="stage-banner-label">Overall Copilot Fluency</div>
				<div class="stage-banner-title stage-${data.overallStage}">${escapeHtml(data.overallLabel)}</div>
				<div class="stage-banner-subtitle">${escapeHtml(STAGE_DESCRIPTIONS[data.overallStage] || '')}</div>
			</div>

		<!-- Radar chart with legend -->
		<div class="radar-wrapper">
			<div class="radar-container">
				${renderRadarChart(data.categories)}
			</div>
			<div class="legend-panel">
				<div class="legend-title">Stage Reference</div>
				<div class="legend-item">
					<div class="legend-dot stage-1-dot"></div>
					<div class="legend-content">
						<div class="legend-label">Stage 1: Copilot Skeptic</div>
						<div class="legend-desc">Rarely uses Copilot or uses only basic features</div>
					</div>
				</div>
				<div class="legend-item">
					<div class="legend-dot stage-2-dot"></div>
					<div class="legend-content">
						<div class="legend-label">Stage 2: Copilot Explorer</div>
						<div class="legend-desc">Exploring Copilot capabilities with occasional use</div>
					</div>
				</div>
				<div class="legend-item">
					<div class="legend-dot stage-3-dot"></div>
					<div class="legend-content">
						<div class="legend-label">Stage 3: Copilot Collaborator</div>
						<div class="legend-desc">Regular, purposeful use across multiple features</div>
					</div>
				</div>
				<div class="legend-item">
					<div class="legend-dot stage-4-dot"></div>
					<div class="legend-content">
						<div class="legend-label">Stage 4: Copilot Strategist</div>
						<div class="legend-desc">Strategic, advanced use leveraging the full Copilot ecosystem</div>
					</div>
				</div>
			</div>
			</div>

			<!-- Category detail cards -->
			<div class="category-grid">
				${categoryCards}
			</div>

			<div class="footer">
				Based on last 30 days of activity &middot; Last updated: ${new Date(data.lastUpdated).toLocaleString()} &middot; Updates every 5 minutes
			</div>
		</div>
	`;

	// Wire up navigation buttons
	document.getElementById('btn-refresh')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'refresh' });
	});
	document.getElementById('btn-details')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDetails' });
	});
	document.getElementById('btn-usage')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showUsageAnalysis' });
	});
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDiagnostics' });
	});

	// Wire up MCP discovery button
	document.querySelector('.mcp-discover-btn')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'searchMcpExtensions' });
	});

	// Wire up dismiss tips buttons
	document.querySelectorAll('.dismiss-tips-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			const target = e.target as HTMLElement;
			const category = target.getAttribute('data-category');
			if (category) {
				vscode.postMessage({ command: 'dismissTips', category });
			}
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
