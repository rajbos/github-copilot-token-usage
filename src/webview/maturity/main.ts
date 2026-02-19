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

type CategoryLevelData = {
	category: string;
	icon: string;
	levels: Array<{ stage: number; label: string; description: string; thresholds: string[]; tips: string[] }>;
};

type MaturityData = {
	overallStage: number;
	overallLabel: string;
	categories: CategoryScore[];
	period: UsageAnalysisPeriod;
	lastUpdated: string;
	dismissedTips?: string[];
	isDebugMode?: boolean;
	fluencyLevels?: CategoryLevelData[];
	backendConfigured?: boolean;
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

// ── Demo mode state ─────────────────────────────────────────────────────

let demoModeActive = false;
let demoStageOverrides: number[] = [];
let demoPanelExpanded = false; // Hidden by default

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
			font-size="14" fill="#d0d0d0" font-weight="600">${cat.icon} ${cat.category}</text>`;
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

// ── Demo controls ──────────────────────────────────────────────────────

function renderDemoControls(categories: CategoryScore[]): string {
	const sliders = categories.map((cat, i) => {
		const currentStage = demoModeActive ? demoStageOverrides[i] : cat.stage;
		const stageButtons = [1, 2, 3, 4].map(s =>
			`<button class="demo-step-btn ${s === currentStage ? 'demo-step-active' : ''} demo-step-${s}" data-index="${i}" data-stage="${s}">${s}</button>`
		).join('');
		return `
			<div class="demo-slider-row">
				<label class="demo-slider-label">${cat.icon} ${escapeHtml(cat.category)}</label>
				<div class="demo-step-group">${stageButtons}</div>
				<span class="demo-slider-value badge-${currentStage}" data-value-index="${i}">${escapeHtml(STAGE_LABELS[currentStage] || '')}</span>
			</div>
		`;
	}).join('');

	return `
		<div class="demo-panel">
			<div class="demo-panel-header ${demoPanelExpanded ? '' : 'demo-collapsed'}">
				<div class="demo-panel-title">
					<button class="demo-expand-btn" id="demo-expand-toggle" title="${demoPanelExpanded ? 'Collapse' : 'Expand'} Demo Mode Panel">
						${demoPanelExpanded ? '▼' : '▶'}
					</button>
					🐛 Demo Mode — Override Spider Chart
				</div>
				<div class="demo-panel-actions ${demoPanelExpanded ? '' : 'demo-hidden'}">
					<button class="demo-btn demo-btn-toggle" id="demo-toggle">${demoModeActive ? '⏸ Disable Overrides' : '▶ Enable Overrides'}</button>
					<button class="demo-btn demo-btn-reset" id="demo-reset">↺ Reset to Actual</button>
				</div>
			</div>
			<div class="demo-sliders ${demoModeActive ? '' : 'demo-disabled'} ${demoPanelExpanded ? '' : 'demo-hidden'}">
				${sliders}
			</div>
		</div>
	`;
}

function wireDemoControls(data: MaturityData): void {
	// Initialize overrides from actual data if not set
	if (demoStageOverrides.length === 0) {
		demoStageOverrides = data.categories.map(c => c.stage);
	}

	document.getElementById('demo-expand-toggle')?.addEventListener('click', () => {
		demoPanelExpanded = !demoPanelExpanded;
		renderLayout(data);
	});

	document.getElementById('demo-toggle')?.addEventListener('click', () => {
		demoModeActive = !demoModeActive;
		renderLayout(data);
	});

	document.getElementById('demo-reset')?.addEventListener('click', () => {
		demoStageOverrides = data.categories.map(c => c.stage);
		demoModeActive = false;
		renderLayout(data);
	});

	document.querySelectorAll('.demo-step-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			const target = e.currentTarget as HTMLElement;
			const idx = parseInt(target.getAttribute('data-index') || '0', 10);
			const stage = parseInt(target.getAttribute('data-stage') || '1', 10);
			demoStageOverrides[idx] = stage;
			if (demoModeActive) {
				renderLayout(data);
			}
		});
	});
}

// ── Main render ────────────────────────────────────────────────────────

function renderLayout(data: MaturityData): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	const dismissedTips = data.dismissedTips || [];
	const useDemoCards = demoModeActive && data.fluencyLevels;

	const categoryCards = data.categories.map((cat, catIdx) => {
		const demoStage = demoStageOverrides[catIdx] ?? cat.stage;
		const displayStage = useDemoCards ? demoStage : cat.stage;
		const progressPct = (displayStage / 4) * 100;
		const color = stageColor(displayStage);

		// When demo mode is active, show level info from fluencyLevels instead of actual evidence/tips
		if (useDemoCards && data.fluencyLevels) {
			const levelData = data.fluencyLevels.find(l => l.category === cat.category);
			const stageInfo = levelData?.levels.find(l => l.stage === demoStage);

			const thresholdsHtml = stageInfo && stageInfo.thresholds.length > 0
				? stageInfo.thresholds.map(t =>
					`<li class="evidence-item"><span class="evidence-icon">🎯</span><span>${escapeHtml(t)}</span></li>`
				).join('')
				: '<li class="evidence-item"><span class="evidence-icon">-</span><span>No thresholds defined</span></li>';

			const tipsHtml = stageInfo && stageInfo.tips.length > 0
				? stageInfo.tips.map(t => `<div class="tip-item">${escapeHtml(t)}</div>`).join('')
				: '<div class="tip-item" style="color:#666;">No tips for this stage</div>';

			return `
				<div class="category-card demo-card-highlight">
					<div class="category-header">
						<span class="category-name">${cat.icon} ${escapeHtml(cat.category)}</span>
						<span class="category-stage-badge badge-${displayStage}">Stage ${displayStage}</span>
					</div>
					<div class="category-stage-label">${escapeHtml(STAGE_LABELS[displayStage] || 'Unknown')}</div>
					<div class="demo-card-description">${escapeHtml(stageInfo?.description || '')}</div>
					<div class="category-progress">
						<div class="category-progress-fill" style="width: ${progressPct}%; background: ${color};"></div>
					</div>
					<div class="demo-section-label">🎯 Requirements to Reach This Stage</div>
					<ul class="evidence-list">${thresholdsHtml}</ul>
					<div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2a30;">
						<div class="demo-section-label">💡 Tips</div>
						${tipsHtml}
					</div>
				</div>`;
		}

		// Normal mode — actual evidence/tips
		const evidenceHtml = cat.evidence.map(e =>
			`<li class="evidence-item"><span class="evidence-icon">&#x2713;</span><span>${escapeHtml(e)}</span></li>`
		).join('');
		const tipsHtml = cat.tips.length > 0
			? cat.tips.map(t => {
					// Check if tip contains newlines (multi-line tip with list items)
					if (t.includes('\n')) {
						const lines = t.split('\n').filter(line => line.trim());
						const summary = lines[0];
						const hasHeader = lines.length > 1 && lines[1].toLowerCase().includes('top repos');
						if (hasHeader && lines.length > 2) {
							const header = lines[1];
							const listItems = lines.slice(2).map(item => `<li>${escapeHtml(item)}</li>`).join('');
							return `<div class="tip-item">${escapeHtml(summary)}<div style="margin-top: 8px; font-weight: 600; font-size: 11px; color: #999;">${escapeHtml(header)}</div><ul style="margin: 6px 0 0 0; padding-left: 18px; list-style: disc;">${listItems}</ul></div>`;
						} else {
							// Just split lines without special list formatting
							return `<div class="tip-item">${lines.map(line => escapeHtml(line)).join('<br>')}</div>`;
						}
					} else {
						return `<div class="tip-item">${escapeHtml(t)}</div>`;
					}
				}).join('')
			: '<div class="tip-item" style="color:#666;">No specific suggestions - you\'re doing great!</div>';

		// Check if tips are dismissed for this category
		const tipsAreDismissed = dismissedTips.includes(cat.category);
		
		// Add MCP discovery button for Tool Usage category
		const mcpButton = cat.category === 'Tool Usage' ? `
			<div style="margin-top: 10px;">
				<button class="mcp-discover-btn" data-action="searchMcp">🔍 Discover more MCP Servers in Marketplace</button>
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
					${data.isDebugMode ? buttonHtml('btn-level-viewer') : ''}
					${buttonHtml('btn-details')}
					${buttonHtml('btn-chart')}
					${buttonHtml('btn-usage')}
					${buttonHtml('btn-diagnostics')}					${data.backendConfigured ? buttonHtml('btn-dashboard') : ''}				</div>
			</div>

			<div class="info-box">
				<div class="info-box-title">📋 About This Dashboard</div>
				<div>
					This dashboard maps your GitHub Copilot usage patterns from the last 30 days to a maturity model with 4 stages across 6 categories.
					It helps you understand which Copilot capabilities you already use and suggests areas to explore for greater productivity.
					<br><br>
					📖 <a href="https://github.com/rajbos/github-copilot-token-usage/blob/main/docs/FLUENCY-LEVELS.md" class="beta-link">Read the full scoring rules</a> to learn how each category and stage is calculated.
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

		<!-- Demo controls (debug mode only) -->
		${data.isDebugMode ? renderDemoControls(data.categories) : ''}

		<!-- Radar chart with legend -->
		<div class="radar-wrapper">
			<div class="radar-container">
				${renderRadarChart(demoModeActive ? data.categories.map((c, i) => ({ ...c, stage: demoStageOverrides[i] ?? c.stage })) : data.categories)}
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

			<!-- Share to social media section -->
			<div class="share-section">
				<div class="share-header">
					<span class="share-icon">📢</span>
					<span class="share-title">Share Your Copilot Fluency Score</span>
				</div>
				<div class="share-description">
					Share your progress with the community and inspire others to level up their Copilot skills!
				</div>
				<div class="share-buttons">
					<button id="btn-share-linkedin" class="share-btn share-btn-linkedin">
						<span class="share-btn-icon">💼</span>
						<span>Share on LinkedIn</span>
					</button>
					<button id="btn-share-bluesky" class="share-btn share-btn-bluesky">
						<span class="share-btn-icon">🦋</span>
						<span>Share on Bluesky</span>
					</button>
					<button id="btn-share-mastodon" class="share-btn share-btn-mastodon">
						<span class="share-btn-icon">🐘</span>
						<span>Share on Mastodon</span>
					</button>
					<div class="export-dropdown-container">
						<button id="btn-export-toggle" class="share-btn share-btn-download">
							<span class="share-btn-icon">💾</span>
							<span>Export Fluency Score</span>
							<span class="dropdown-arrow">▼</span>
						</button>
						<div id="export-dropdown" class="export-dropdown-menu" style="display: none;">
							<button class="export-menu-item" data-export-type="png">
								<span class="export-menu-icon">🖼️</span>
								<span>Export as PNG Image</span>
							</button>
							<button class="export-menu-item" data-export-type="pdf">
								<span class="export-menu-icon">📄</span>
								<span>Export as PDF Report</span>
							</button>
						</div>
					</div>
				</div>
			</div>

			<div class="beta-footer">
				<span class="beta-footer-icon">⚠️</span>
				<div class="beta-footer-content">
					<strong>Beta</strong> — This screen is still in beta. If you have feedback or suggestions for improvements,
					please <a href="https://github.com/rajbos/github-copilot-token-usage/issues" class="beta-link">create an issue</a> on the repository.
				</div>
				<button id="btn-share-issue" class="share-issue-btn">📤 Share to Issue</button>
			</div>
		</div>
	`;

	// Wire up navigation buttons
	document.getElementById('btn-refresh')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'refresh' });
	});
	document.getElementById('btn-level-viewer')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showFluencyLevelViewer' });
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

	// Wire up share to issue button
	document.getElementById('btn-share-issue')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'shareToIssue' });
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

	// Wire up share buttons
	document.getElementById('btn-share-linkedin')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'shareToLinkedIn' });
	});
	document.getElementById('btn-share-bluesky')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'shareToBluesky' });
	});
	document.getElementById('btn-share-mastodon')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'shareToMastodon' });
	});
	
	// Wire up export dropdown
	const exportToggleBtn = document.getElementById('btn-export-toggle');
	const exportDropdown = document.getElementById('export-dropdown');
	
	exportToggleBtn?.addEventListener('click', (e) => {
		e.stopPropagation();
		if (exportDropdown) {
			const isVisible = exportDropdown.style.display === 'block';
			exportDropdown.style.display = isVisible ? 'none' : 'block';
		}
	});
	
	// Close dropdown when clicking outside
	document.addEventListener('click', () => {
		if (exportDropdown) {
			exportDropdown.style.display = 'none';
		}
	});
	
	// Handle export menu items
	document.querySelectorAll('.export-menu-item').forEach(item => {
		item.addEventListener('click', (e) => {
			e.stopPropagation();
			const target = e.currentTarget as HTMLElement;
			const exportType = target.getAttribute('data-export-type');
			
			if (exportDropdown) {
				exportDropdown.style.display = 'none';
			}
			
			if (exportType === 'png') {
				handlePngExport();
			} else if (exportType === 'pdf') {
				handlePdfExport(data);
			}
		});
	});
	
	function handlePngExport(): void {
		const svgEl = document.querySelector('.radar-svg') as SVGSVGElement | null;
		if (!svgEl) { return; }

		// Clone SVG and set explicit dimensions + background for the exported image
		const clone = svgEl.cloneNode(true) as SVGSVGElement;
		clone.setAttribute('width', '1100');
		clone.setAttribute('height', '1100');
		// Add dark background rectangle as first child
		const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		bg.setAttribute('width', '100%');
		bg.setAttribute('height', '100%');
		bg.setAttribute('fill', '#1b1b1e');
		clone.insertBefore(bg, clone.firstChild);

		const svgData = new XMLSerializer().serializeToString(clone);
		// Use data URL instead of blob URL — blob: is blocked by webview CSP
		const encodedSvg = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));

		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = 1100;
			canvas.height = 1100;
			const ctx = canvas.getContext('2d');
			if (!ctx) { return; }
			ctx.drawImage(img, 0, 0, 1100, 1100);

			const dataUrl = canvas.toDataURL('image/png');
			vscode.postMessage({ command: 'saveChartImage', data: dataUrl });
		};
		img.onerror = () => {
			vscode.postMessage({ command: 'downloadChartImage' });
		};
		img.src = encodedSvg;
	}
	
	function handlePdfExport(maturityData: MaturityData): void {
		// Send data to extension for PDF generation
		vscode.postMessage({ 
			command: 'exportPdf',
			data: maturityData
		});
	}
  
	// Wire up demo mode controls (debug mode only)
	if (data.isDebugMode) {
		wireDemoControls(data);
	}
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
