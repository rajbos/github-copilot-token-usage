// Usage Analysis webview
import { el } from '../shared/domUtils';
import { buttonHtml } from '../shared/buttonConfig';
import { ContextReferenceUsage, getTotalContextRefs } from '../shared/contextRefUtils';
import { formatFixed, formatNumber, formatPercent, setFormatLocale } from '../shared/formatUtils';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import styles from './styles.css';

type ModeUsage = { ask: number; edit: number; agent: number; plan: number; customAgent: number };
type ToolCallUsage = { total: number; byTool: { [key: string]: number } };
type McpToolUsage = { total: number; byServer: { [key: string]: number }; byTool: { [key: string]: number } };

type ModelSwitchingAnalysis = {
	modelsPerSession: number[];
	totalSessions: number;
	averageModelsPerSession: number;
	maxModelsPerSession: number;
	minModelsPerSession: number;
	switchingFrequency: number;
	standardModels: string[];
	premiumModels: string[];
	unknownModels: string[];
	mixedTierSessions: number;
	standardRequests: number;
	premiumRequests: number;
	unknownRequests: number;
	totalRequests: number;
};

type UsageAnalysisPeriod = {
	sessions: number;
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
	modelSwitching: ModelSwitchingAnalysis;
};

type UsageAnalysisStats = {
	today: UsageAnalysisPeriod;
	last30Days: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	locale?: string;
	lastUpdated: string;
	customizationMatrix?: WorkspaceCustomizationMatrix | null;
	backendConfigured?: boolean;
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

interface CustomizationFileEntry {
	path: string;
	relativePath: string;
	type: string;
	icon?: string;
	label?: string;
	name?: string;
	lastModified?: string;
	isStale?: boolean;
}

type CustomizationTypeStatus = '✅' | '⚠️' | '❌';

interface WorkspaceCustomizationRow {
	workspacePath: string;
	workspaceName: string;
	sessionCount: number;
	interactionCount: number;
	typeStatuses: { [typeId: string]: CustomizationTypeStatus };
}

interface WorkspaceCustomizationMatrix {
	customizationTypes: Array<{ id: string; icon: string; label: string }>;
	workspaces: WorkspaceCustomizationRow[];
	totalWorkspaces: number;
	workspacesWithIssues: number;
}

declare global {
	interface Window { __INITIAL_USAGE__?: UsageAnalysisStats & { customizationMatrix?: WorkspaceCustomizationMatrix | null } }
}

interface RepoAnalysisRecord {
	data?: any;
	error?: string;
}

const vscode = acquireVsCodeApi();
const initialData = window.__INITIAL_USAGE__;
let hygieneMatrixState: WorkspaceCustomizationMatrix | null = null;
const repoAnalysisState = new Map<string, RepoAnalysisRecord>();
let selectedRepoPath: string | null = null;
let isSwitchingRepository = false;
let isBatchAnalysisInProgress = false;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

import toolNames from '../../toolNames.json';

let TOOL_NAME_MAP: { [key: string]: string } | null = toolNames || null;

function lookupToolName(id: string): string {
	if (!TOOL_NAME_MAP) {
		return id;
	}
	return TOOL_NAME_MAP[id] || id;
}

function lookupMcpToolName(id: string): string {
	const full = lookupToolName(id);
	// Strip the server prefix (e.g. "GitHub MCP (Local): Issue Read" → "Issue Read")
	const colonIdx = full.indexOf(':');
	if (colonIdx !== -1) {
		return full.substring(colonIdx + 1).trim();
	}
	return full;
}

function getUnknownMcpTools(stats: UsageAnalysisStats): string[] {
	const allTools = new Set<string>();
	
	// Collect all MCP tools from all periods
	Object.entries(stats.today.mcpTools.byTool).forEach(([tool]) => allTools.add(tool));
	Object.entries(stats.last30Days.mcpTools.byTool).forEach(([tool]) => allTools.add(tool));
	Object.entries(stats.month.mcpTools.byTool).forEach(([tool]) => allTools.add(tool));
	
	// Filter to only unknown tools (where lookupToolName returns the same value)
	return Array.from(allTools).filter(tool => lookupToolName(tool) === tool).sort();
}

function createMcpToolIssueUrl(unknownTools: string[]): string {
	const repoUrl = 'https://github.com/rajbos/github-copilot-token-usage';
	const title = encodeURIComponent('Add missing friendly names for MCP tools');
	const toolList = unknownTools.map(tool => `- \`${tool}\``).join('\n');
	const body = encodeURIComponent(
		`## Unknown MCP Tools Found\n\n` +
		`The following MCP tools were detected but don't have friendly display names:\n\n` +
		`${toolList}\n\n` +
		`Please add friendly names for these tools to improve the user experience.`
	);
	const labels = encodeURIComponent('MCP Toolnames');
	
	return `${repoUrl}/issues/new?title=${title}&body=${body}&labels=${labels}`;
}

function renderToolsTable(byTool: { [key: string]: number }, limit = 10, nameResolver: (id: string) => string = lookupToolName): string {
	const sortedTools = Object.entries(byTool)
		.sort(([, a], [, b]) => b - a)
		.slice(0, limit);

	if (sortedTools.length === 0) {
		return '<div style="color: var(--text-muted);">No tools used yet</div>';
	}

	    const rows = sortedTools.map(([tool, count], idx) => {
		const friendly = escapeHtml(nameResolver(tool));
		const idEscaped = escapeHtml(tool);
		return `
		    <tr>
			    <td style="padding:8px 12px; border-bottom:1px solid var(--border-subtle); width:40px; max-width:40px; text-align:center;">${idx + 1}</td>
			    <td style="padding:8px 12px; border-bottom:1px solid var(--border-subtle); word-break:break-word; overflow-wrap:break-word; max-width:0;"> <strong title="${idEscaped}">${friendly}</strong></td>
			    <td style="padding:8px 12px; border-bottom:1px solid var(--border-subtle); text-align:right; width:90px; white-space:nowrap;">${formatNumber(count)}</td>
		    </tr>`;
	    }).join('');

	return `
		<table style="width:100%; border-collapse:collapse; table-layout:fixed;">
			<thead>
				<tr style="color:var(--text-secondary); font-size:12px; text-align:left;">
					<th style="padding:8px 12px; opacity:0.9; width:40px;">#</th>
					<th style="padding:8px 12px; opacity:0.9;">Tool</th>
					<th style="padding:8px 12px; opacity:0.9; text-align:right; width:90px;">Calls</th>
				</tr>
			</thead>
			<tbody>
				${rows}
			</tbody>
		</table>`;
}

function renderLayout(stats: UsageAnalysisStats): void {
	const root = document.getElementById('root');
	if (!root) {
		return;
	}

	const matrix =
		((stats as any)?.customizationMatrix as WorkspaceCustomizationMatrix | undefined | null) ??
		((window.__INITIAL_USAGE__ as any)?.customizationMatrix as WorkspaceCustomizationMatrix | undefined | null);
	hygieneMatrixState = matrix ?? null;
	if (!hygieneMatrixState || hygieneMatrixState.workspaces.length === 0) {
		selectedRepoPath = null;
	}
	let customizationHtml = '';
	if (!matrix || !matrix.workspaces || matrix.workspaces.length === 0) {
		customizationHtml = `
			<div class="section">
				<div class="section-title"><span>🛠️</span><span>Copilot Customization Files</span></div>
				<div class="section-subtitle">Showing workspace customization status for active workspaces</div>
				<div style="color:#999; padding:12px;">No workspaces with customization files detected in the last 30 days.</div>
			</div>`;
	} else {
		customizationHtml = `
			<div style="margin-top: 16px; margin-bottom: 16px; padding: 12px; background: #18181b; border: 1px solid #2a2a30; border-radius: 6px;">
				<div style="font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 8px;">
					🛠️ Copilot Customization Files
				</div>
				<div style="font-size: 11px; color: #b8b8b8; margin-bottom: 12px;">
					Showing ${matrix.totalWorkspaces} workspace(s) with Copilot activity in the last 30 days.
					${matrix.workspacesWithIssues > 0
						? `<span class="stale-warning">⚠️ ${matrix.workspacesWithIssues} workspace(s) have no customization files.</span>`
						: '✅ All workspaces have up-to-date customizations.'}
				</div>
				<div class="customization-matrix-container">
					<table class="customization-matrix">
						<thead>
							<tr>
								<th style="text-align: left; padding: 8px; border-bottom: 2px solid #2a2a30;">📂 Workspace</th>
								<th style="text-align: center; padding: 8px; border-bottom: 2px solid #2a2a30;">Sessions</th>
								${matrix.customizationTypes.map(type => `
									<th style="text-align: center; padding: 8px; border-bottom: 2px solid #2a2a30;" title="${escapeHtml(type.label)}">
										${type.icon}
									</th>
								`).join('')}
							</tr>
						</thead>
						<tbody>
							${matrix.workspaces.map(ws => `
								<tr>
									<td style="padding: 6px 8px; border-bottom: 1px solid #2a2a30; font-family: 'Courier New', monospace; font-size: 12px;">
										${escapeHtml(ws.workspaceName)}
									</td>
									<td style="padding: 6px 8px; border-bottom: 1px solid #2a2a30; text-align: center; color: #60a5fa; font-weight: 600;">
										${ws.sessionCount}
									</td>
									${matrix.customizationTypes.map(type => {
										const status = ws.typeStatuses[type.id] || '❓';
										const statusLabel =
											status === '✅'
												? 'Present and fresh'
												: status === '⚠️'
													? 'Present but stale'
													: status === '❌'
														? 'Missing'
														: 'Status unknown';
										return `
										<td style="position: relative; padding: 6px 8px; border-bottom: 1px solid #2a2a30; text-align: center; font-size: 16px;" title="${statusLabel}" aria-label="${statusLabel}">
											<span aria-hidden="true">${status}</span>
											<span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;">${statusLabel}</span>
										</td>
										`;
									}).join('')}
								</tr>
							`).join('')}
						</tbody>
					</table>
				</div>
				<div style="margin-top: 12px; font-size: 10px; color: #999; border-top: 1px solid #2a2a30; padding-top: 8px;">
					<div style="display: flex; gap: 16px; flex-wrap: wrap;">
						${matrix.customizationTypes.map(type => `
							<span>${type.icon} ${escapeHtml(type.label)}</span>
						`).join('')}
					</div>
					<div style="margin-top: 8px;">
						✅ = Present &amp; Fresh&nbsp;&nbsp;•&nbsp;&nbsp;⚠️ = Present but Stale&nbsp;&nbsp;•&nbsp;&nbsp;❌ = Missing
					</div>
				</div>
			</div>`;
	}

	const todayTotalRefs = getTotalContextRefs(stats.today.contextReferences);
	const last30DaysTotalRefs = getTotalContextRefs(stats.last30Days.contextReferences);
	const todayTotalModes = stats.today.modeUsage.ask + stats.today.modeUsage.edit + stats.today.modeUsage.agent + stats.today.modeUsage.plan + stats.today.modeUsage.customAgent;
	const last30DaysTotalModes = stats.last30Days.modeUsage.ask + stats.last30Days.modeUsage.edit + stats.last30Days.modeUsage.agent + stats.last30Days.modeUsage.plan + stats.last30Days.modeUsage.customAgent;

	root.innerHTML = `
		<style>${themeStyles}</style>
		<style>${styles}</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">📊</span>
					<span class="header-title">Usage Analysis</span>
				</div>
				<div class="button-row">
				${buttonHtml('btn-refresh')}
				${buttonHtml('btn-details')}
				${buttonHtml('btn-chart')}
				${buttonHtml('btn-diagnostics')}
				${buttonHtml('btn-maturity')}
				${stats.backendConfigured ? buttonHtml('btn-dashboard') : ''}
				</div>
			</div>

			<div class="info-box">
				<div class="info-box-title">📋 About This Dashboard</div>
				<div>
					This dashboard analyzes your GitHub Copilot usage patterns by examining session log files.
					It tracks modes (ask/edit/agent), tool usage, context references (#file, @workspace, etc.),
					and MCP (Model Context Protocol) tools to help you understand how you interact with Copilot.
				</div>
			</div>

			<!-- Mode Usage Section -->
			<div class="section">
				<div class="section-title"><span>🎯</span><span>Interaction Modes</span></div>
				<div class="section-subtitle">How you're using Copilot: Ask (chat), Edit (code edits), or Agent (autonomous tasks)</div>
				<div class="two-column">
					<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="bar-chart">
							<div class="bar-item">
								<div class="bar-label"><span>💬 Ask Mode</span><span><strong>${formatNumber(stats.today.modeUsage.ask)}</strong> (${formatPercent(todayTotalModes > 0 ? ((stats.today.modeUsage.ask / todayTotalModes) * 100) : 0, 0)})</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.ask / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #3b82f6, #60a5fa);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>✏️ Edit Mode</span><span><strong>${formatNumber(stats.today.modeUsage.edit)}</strong> (${formatPercent(todayTotalModes > 0 ? ((stats.today.modeUsage.edit / todayTotalModes) * 100) : 0, 0)})</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.edit / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #10b981, #34d399);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>🤖 Agent Mode</span><span><strong>${formatNumber(stats.today.modeUsage.agent)}</strong> (${formatPercent(todayTotalModes > 0 ? ((stats.today.modeUsage.agent / todayTotalModes) * 100) : 0, 0)})</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.agent / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7c3aed, #a855f7);"></div></div>
							</div>						<div class="bar-item">
							<div class="bar-label"><span>📋 Plan Mode</span><span><strong>${formatNumber(stats.today.modeUsage.plan)}</strong> (${formatPercent(todayTotalModes > 0 ? ((stats.today.modeUsage.plan / todayTotalModes) * 100) : 0, 0)})</span></div>
							<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.plan / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #f59e0b, #fbbf24);"></div></div>
						</div>
						<div class="bar-item">
							<div class="bar-label"><span>⚡ Custom Agent</span><span><strong>${formatNumber(stats.today.modeUsage.customAgent)}</strong> (${formatPercent(todayTotalModes > 0 ? ((stats.today.modeUsage.customAgent / todayTotalModes) * 100) : 0, 0)})</span></div>
							<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.customAgent / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #ec4899, #f472b6);"></div></div>
						</div>						</div>
					</div>
					<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📊 Last 30 Days</h4>
						<div class="bar-chart">
							<div class="bar-item">
								<div class="bar-label"><span>💬 Ask Mode</span><span><strong>${formatNumber(stats.last30Days.modeUsage.ask)}</strong> (${formatPercent(last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.ask / last30DaysTotalModes) * 100) : 0, 0)})</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.ask / last30DaysTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #3b82f6, #60a5fa);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>✏️ Edit Mode</span><span><strong>${formatNumber(stats.last30Days.modeUsage.edit)}</strong> (${formatPercent(last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.edit / last30DaysTotalModes) * 100) : 0, 0)})</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.edit / last30DaysTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #10b981, #34d399);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>🤖 Agent Mode</span><span><strong>${formatNumber(stats.last30Days.modeUsage.agent)}</strong> (${formatPercent(last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.agent / last30DaysTotalModes) * 100) : 0, 0)})</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.agent / last30DaysTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7c3aed, #a855f7);"></div></div>
							</div>						<div class="bar-item">
							<div class="bar-label"><span>📋 Plan Mode</span><span><strong>${formatNumber(stats.last30Days.modeUsage.plan)}</strong> (${formatPercent(last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.plan / last30DaysTotalModes) * 100) : 0, 0)})</span></div>
							<div class="bar-track"><div class="bar-fill" style="width: ${last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.plan / last30DaysTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #f59e0b, #fbbf24);"></div></div>
						</div>
						<div class="bar-item">
							<div class="bar-label"><span>⚡ Custom Agent</span><span><strong>${formatNumber(stats.last30Days.modeUsage.customAgent)}</strong> (${formatPercent(last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.customAgent / last30DaysTotalModes) * 100) : 0, 0)})</span></div>
							<div class="bar-track"><div class="bar-fill" style="width: ${last30DaysTotalModes > 0 ? ((stats.last30Days.modeUsage.customAgent / last30DaysTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #ec4899, #f472b6);"></div></div>
						</div>						</div>
					</div>
				</div>
			</div>

			<!-- Context References Section -->
			<div class="section">
				<div class="section-title"><span>🔗</span><span>Context References</span></div>
				<div class="section-subtitle">How often you reference files, selections, symbols, and workspace context</div>
				<div class="stats-grid">
					<div class="stat-card"><div class="stat-label">📄 #file</div><div class="stat-value">${stats.last30Days.contextReferences.file}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.file}</div></div>
					<div class="stat-card"><div class="stat-label">✂️ #selection</div><div class="stat-value">${stats.last30Days.contextReferences.selection}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.selection}</div></div>
					<div class="stat-card" title="Text selected in your editor providing passive context to Copilot"><div class="stat-label">✨ Implicit Selection</div><div class="stat-value">${stats.last30Days.contextReferences.implicitSelection}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.implicitSelection}</div></div>
					<div class="stat-card"><div class="stat-label">🔤 #symbol</div><div class="stat-value">${stats.last30Days.contextReferences.symbol}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.symbol}</div></div>
					<div class="stat-card"><div class="stat-label">🗂️ #codebase</div><div class="stat-value">${stats.last30Days.contextReferences.codebase}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.codebase}</div></div>
					<div class="stat-card"><div class="stat-label">📁 @workspace</div><div class="stat-value">${stats.last30Days.contextReferences.workspace}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.workspace}</div></div>
					<div class="stat-card"><div class="stat-label">💻 @terminal</div><div class="stat-value">${stats.last30Days.contextReferences.terminal}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.terminal}</div></div>
					<div class="stat-card"><div class="stat-label">🔧 @vscode</div><div class="stat-value">${stats.last30Days.contextReferences.vscode}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.vscode}</div></div>
					<div class="stat-card" title="Last command run in the terminal"><div class="stat-label">⌨️ #terminalLastCommand</div><div class="stat-value">${stats.last30Days.contextReferences.terminalLastCommand || 0}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.terminalLastCommand || 0}</div></div>
					<div class="stat-card" title="Selected terminal output"><div class="stat-label">🖱️ #terminalSelection</div><div class="stat-value">${stats.last30Days.contextReferences.terminalSelection || 0}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.terminalSelection || 0}</div></div>
					<div class="stat-card" title="Clipboard contents"><div class="stat-label">📋 #clipboard</div><div class="stat-value">${stats.last30Days.contextReferences.clipboard || 0}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.clipboard || 0}</div></div>
					<div class="stat-card" title="Uncommitted git changes"><div class="stat-label">📝 #changes</div><div class="stat-value">${stats.last30Days.contextReferences.changes || 0}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.changes || 0}</div></div>
					<div class="stat-card" title="Output panel contents"><div class="stat-label">📤 #outputPanel</div><div class="stat-value">${stats.last30Days.contextReferences.outputPanel || 0}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.outputPanel || 0}</div></div>
					<div class="stat-card" title="Problems panel contents"><div class="stat-label">⚠️ #problemsPanel</div><div class="stat-value">${stats.last30Days.contextReferences.problemsPanel || 0}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.problemsPanel || 0}</div></div>
					<div class="stat-card" title="copilot-instructions.md file references detected in session logs"><div class="stat-label">📋 Copilot Instructions</div><div class="stat-value">${stats.last30Days.contextReferences.copilotInstructions}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.copilotInstructions}</div></div>
					<div class="stat-card" title="agents.md file references detected in session logs"><div class="stat-label">🤖 Agents.md</div><div class="stat-value">${stats.last30Days.contextReferences.agentsMd}</div><div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Today: ${stats.today.contextReferences.agentsMd}</div></div>
					<div class="stat-card" style="background: var(--list-active-bg); border: 2px solid var(--border-color); color: var(--list-active-fg);"><div class="stat-label" style="color: var(--list-active-fg); opacity: 0.85;">📊 Total References</div><div class="stat-value" style="color: var(--list-active-fg);">${last30DaysTotalRefs}</div><div style="font-size: 10px; color: var(--list-active-fg); opacity: 0.75; margin-top: 4px;">Today: ${todayTotalRefs}</div></div>
				</div>
				${Object.keys(stats.last30Days.contextReferences.byKind).length > 0 ? `
					<div style="margin-top: 16px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
						<div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">📎 Attached Files by Type (Last 30 Days)</div>
						<div style="font-size: 12px; color: var(--text-primary);">
							${Object.entries(stats.last30Days.contextReferences.byKind)
								.sort(([, a], [, b]) => (b as number) - (a as number))
								.slice(0, 5)
								.map(([kind, count]) => `<div style="margin-bottom: 4px;"><span style="color: var(--link-color);">${escapeHtml(kind)}:</span> ${count}</div>`)
								.join('')}
						</div>
					</div>
				` : ''}
				${Object.keys(stats.last30Days.contextReferences.byPath).length > 0 ? `
					<div style="margin-top: 16px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
						<div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">📁 Most Referenced Files (Last 30 Days)</div>
						<div style="font-size: 11px; color: var(--text-primary);">
							${Object.entries(stats.last30Days.contextReferences.byPath)
								.sort(([, a], [, b]) => (b as number) - (a as number))
								.slice(0, 10)
								.map(([path, count]) => `<div style="margin-bottom: 4px; font-family: 'Courier New', monospace;"><span style="color: var(--link-color);">${count}×</span> ${escapeHtml(path)}</div>`)
								.join('')}
						</div>
					</div>
				` : ''}
			</div>

			${customizationHtml}

			<!-- Repository Setup Section -->
			<div class="repo-hygiene-section" style="margin-top: 16px; margin-bottom: 16px; padding: 12px; background: #18181b; border: 1px solid #2a2a30; border-radius: 6px;">
				<div style="font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 8px;">
					🏗️ Repository Hygiene Analysis
				</div>
				<div style="font-size: 11px; color: #b8b8b8; margin-bottom: 12px;">
					Analyze repository hygiene and structure to identify missing configuration files and best practices.
				</div>
				${matrix && matrix.workspaces && matrix.workspaces.length > 0 ? `
					<div style="margin-bottom: 12px;">
						<vscode-button id="btn-analyse-all" style="margin-bottom: 8px;">Analyze All Repositories (${matrix.workspaces.length})</vscode-button>
					</div>
					<div id="repo-list-pane-container" class="repo-hygiene-pane">
						<div class="repo-hygiene-pane-header">📁 Repository List</div>
						<div id="repo-list-pane" class="repo-hygiene-pane-body"></div>
					</div>
					<div id="repo-details-pane-container" class="repo-hygiene-pane repo-hygiene-pane-collapsed">
						<div class="repo-hygiene-pane-header">📊 Repository Details</div>
						<div id="repo-details-pane" class="repo-hygiene-pane-body"></div>
					</div>
				` : `
					<vscode-button id="btn-analyse-repo">Analyse Repository</vscode-button>
					<div id="repo-analysis-results" class="repo-hygiene-results" style="margin-top: 12px;"></div>
				`}
			</div>

			<!-- Tool Calls Section -->
			<div class="section">
				<div class="section-title"><span>🔧</span><span>Tool Usage</span></div>
				<div class="section-subtitle">Functions and tools invoked by Copilot during interactions</div>
				<div class="three-column">
					<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total Tool Calls: ${formatNumber(stats.today.toolCalls.total)}</div>
						${renderToolsTable(stats.today.toolCalls.byTool, 10)}
					</div>
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total Tool Calls: ${formatNumber(stats.last30Days.toolCalls.total)}</div>
							${renderToolsTable(stats.last30Days.toolCalls.byTool, 10)}
						</div>
					</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Last Month</h4>
					<div class="list">
						<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total Tool Calls: ${formatNumber(stats.month.toolCalls.total)}</div>
							${renderToolsTable(stats.month.toolCalls.byTool, 10)}
						</div>
					</div>
				</div>
			</div>

			<!-- MCP Tools Section -->
			<div class="section">
				<div class="section-title"><span>🔌</span><span>MCP Tools</span></div>
				<div class="section-subtitle">Model Context Protocol (MCP) server and tool usage</div>
				${(() => {
					const unknownTools = getUnknownMcpTools(stats);
					if (unknownTools.length > 0) {
						const issueUrl = createMcpToolIssueUrl(unknownTools);
						return `
							<div style="margin-bottom: 12px; padding: 10px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px;">
								<div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
									Found ${unknownTools.length} MCP tool${unknownTools.length > 1 ? 's' : ''} without friendly names
								</div>
								<a href="${issueUrl}" target="_blank" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--button-bg); color: var(--button-fg); border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: 500;">
									<span>📝</span>
									<span>Report Unknown Tools</span>
								</a>
							</div>
						`;
					}
					return '';
				})()}
				<div class="three-column">
					<div>
						<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total MCP Calls: ${formatNumber(stats.today.mcpTools.total)}</div>
							${stats.today.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.today.mcpTools.byServer, 8)}</div></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.today.mcpTools.byTool, 8, lookupMcpToolName)}</div></div>
							` : '<div style="color: var(--text-muted); margin-top: 8px;">No MCP tools used yet</div>'}
						</div>
					</div>
					<div>
						<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total MCP Calls: ${formatNumber(stats.last30Days.mcpTools.total)}</div>
							${stats.last30Days.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.last30Days.mcpTools.byServer, 8)}</div></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.last30Days.mcpTools.byTool, 8, lookupMcpToolName)}</div></div>
							` : '<div style="color: var(--text-muted); margin-top: 8px;">No MCP tools used yet</div>'}
						</div>
					</div>
					<div>
						<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Last Month</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Total MCP Calls: ${formatNumber(stats.month.mcpTools.total)}</div>
							${stats.month.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.month.mcpTools.byServer, 8)}</div></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.month.mcpTools.byTool, 8, lookupMcpToolName)}</div></div>
							` : '<div style="color: var(--text-muted); margin-top: 8px;">No MCP tools used yet</div>'}
						</div>
					</div>
				</div>
			</div>

			<!-- Multi-Model Usage Section -->
			<div class="section">
				<div class="section-title"><span>🔀</span><span>Multi-Model Usage</span></div>
				<div class="section-subtitle">Track model diversity and switching patterns in your conversations</div>
				<div class="three-column">
					<div>
						<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="stats-grid" style="grid-template-columns: 1fr;">
							<div class="stat-card">
								<div class="stat-label">📊 Avg Models per Conversation</div>
								<div class="stat-value">${formatFixed(stats.today.modelSwitching.averageModelsPerSession, 1)}</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">🔄 Switching Frequency</div>
								<div class="stat-value">${formatPercent(stats.today.modelSwitching.switchingFrequency, 0)}</div>
								<div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Sessions with >1 model</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">📈 Max Models in Session</div>
								<div class="stat-value">${formatNumber(stats.today.modelSwitching.maxModelsPerSession || 0)}</div>
							</div>
						</div>
						<div style="margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
							<div style="font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Models by Tier:</div>
							<div style="min-height: 90px;">
								${stats.today.modelSwitching.standardModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: var(--link-color);">🔵 Standard:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.today.modelSwitching.standardModels.join(', ')}</span>
									</div>
								` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
								${stats.today.modelSwitching.premiumModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: #fbbf24;">⭐ Premium:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.today.modelSwitching.premiumModels.join(', ')}</span>
									</div>
								` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
								${stats.today.modelSwitching.unknownModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: var(--text-muted);">❓ Unknown:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.today.modelSwitching.unknownModels.join(', ')}</span>
									</div>
								` : ''}
							</div>
							${stats.today.modelSwitching.totalRequests > 0 ? `
								<div style="padding-top: 8px; border-top: 1px solid #2a2a30; min-height: 65px;">
									<div style="font-size: 11px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Request Count:</div>
									${stats.today.modelSwitching.standardRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: var(--link-color);">🔵 Standard: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.today.modelSwitching.standardRequests)} (${formatPercent((stats.today.modelSwitching.standardRequests / stats.today.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
									${stats.today.modelSwitching.premiumRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: #fbbf24;">⭐ Premium: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.today.modelSwitching.premiumRequests)} (${formatPercent((stats.today.modelSwitching.premiumRequests / stats.today.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
									${stats.today.modelSwitching.unknownRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: var(--text-muted);">❓ Unknown: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.today.modelSwitching.unknownRequests)} (${formatPercent((stats.today.modelSwitching.unknownRequests / stats.today.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
								</div>
							` : ''}
							${stats.today.modelSwitching.mixedTierSessions > 0 ? `
								<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a30;">
									<span style="font-size: 11px; color: var(--link-color);">🔀 Mixed tier sessions: ${formatNumber(stats.today.modelSwitching.mixedTierSessions)}</span>
								</div>
							` : ''}
						</div>
					</div>
					<div>
						<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
						<div class="stats-grid" style="grid-template-columns: 1fr;">
							<div class="stat-card">
								<div class="stat-label">📊 Avg Models per Conversation</div>
								<div class="stat-value">${formatFixed(stats.last30Days.modelSwitching.averageModelsPerSession, 1)}</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">🔄 Switching Frequency</div>
								<div class="stat-value">${formatPercent(stats.last30Days.modelSwitching.switchingFrequency, 0)}</div>
								<div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Sessions with >1 model</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">📈 Max Models in Session</div>
								<div class="stat-value">${formatNumber(stats.last30Days.modelSwitching.maxModelsPerSession || 0)}</div>
							</div>
						</div>
						<div style="margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
							<div style="font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Models by Tier:</div>
							<div style="min-height: 90px;">
								${stats.last30Days.modelSwitching.standardModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: var(--link-color);">🔵 Standard:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.last30Days.modelSwitching.standardModels.join(', ')}</span>
									</div>
								` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
								${stats.last30Days.modelSwitching.premiumModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: #fbbf24;">⭐ Premium:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.last30Days.modelSwitching.premiumModels.join(', ')}</span>
									</div>
								` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
								${stats.last30Days.modelSwitching.unknownModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: var(--text-muted);">❓ Unknown:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.last30Days.modelSwitching.unknownModels.join(', ')}</span>
									</div>
								` : ''}
							</div>
							${stats.last30Days.modelSwitching.totalRequests > 0 ? `
								<div style="padding-top: 8px; border-top: 1px solid #2a2a30; min-height: 65px;">
									<div style="font-size: 11px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Request Count:</div>
									${stats.last30Days.modelSwitching.standardRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: var(--link-color);">🔵 Standard: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.last30Days.modelSwitching.standardRequests)} (${formatPercent((stats.last30Days.modelSwitching.standardRequests / stats.last30Days.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
									${stats.last30Days.modelSwitching.premiumRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: #fbbf24;">⭐ Premium: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.last30Days.modelSwitching.premiumRequests)} (${formatPercent((stats.last30Days.modelSwitching.premiumRequests / stats.last30Days.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
									${stats.last30Days.modelSwitching.unknownRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: var(--text-muted);">❓ Unknown: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.last30Days.modelSwitching.unknownRequests)} (${formatPercent((stats.last30Days.modelSwitching.unknownRequests / stats.last30Days.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
								</div>
							` : ''}
							${stats.last30Days.modelSwitching.mixedTierSessions > 0 ? `
								<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a30;">
									<span style="font-size: 11px; color: var(--link-color);">🔀 Mixed tier sessions: ${formatNumber(stats.last30Days.modelSwitching.mixedTierSessions)}</span>
								</div>
							` : ''}
						</div>
					</div>
					<div>
						<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Last Month</h4>
						<div class="stats-grid" style="grid-template-columns: 1fr;">
							<div class="stat-card">
								<div class="stat-label">📊 Avg Models per Conversation</div>
								<div class="stat-value">${formatFixed(stats.month.modelSwitching.averageModelsPerSession, 1)}</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">🔄 Switching Frequency</div>
								<div class="stat-value">${formatPercent(stats.month.modelSwitching.switchingFrequency, 0)}</div>
								<div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Sessions with >1 model</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">📈 Max Models in Session</div>
								<div class="stat-value">${formatNumber(stats.month.modelSwitching.maxModelsPerSession || 0)}</div>
							</div>
						</div>
						<div style="margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
							<div style="font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Models by Tier:</div>
							<div style="min-height: 90px;">
								${stats.month.modelSwitching.standardModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: var(--link-color);">🔵 Standard:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.month.modelSwitching.standardModels.join(', ')}</span>
									</div>
								` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
								${stats.month.modelSwitching.premiumModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: #fbbf24;">⭐ Premium:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.month.modelSwitching.premiumModels.join(', ')}</span>
									</div>
								` : '<div style="margin-bottom: 6px; height: 21px;"></div>'}
								${stats.month.modelSwitching.unknownModels.length > 0 ? `
									<div style="margin-bottom: 6px;">
										<span style="color: var(--text-muted);">❓ Unknown:</span>
										<span style="font-size: 11px; color: var(--text-primary);">${stats.month.modelSwitching.unknownModels.join(', ')}</span>
									</div>
								` : ''}
							</div>
							${stats.month.modelSwitching.totalRequests > 0 ? `
								<div style="padding-top: 8px; border-top: 1px solid #2a2a30; min-height: 65px;">
									<div style="font-size: 11px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Request Count:</div>
									${stats.month.modelSwitching.standardRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: var(--link-color);">🔵 Standard: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.month.modelSwitching.standardRequests)} (${formatPercent((stats.month.modelSwitching.standardRequests / stats.month.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
									${stats.month.modelSwitching.premiumRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: #fbbf24;">⭐ Premium: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.month.modelSwitching.premiumRequests)} (${formatPercent((stats.month.modelSwitching.premiumRequests / stats.month.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
									${stats.month.modelSwitching.unknownRequests > 0 ? `
										<div style="margin-bottom: 4px; font-size: 11px;">
											<span style="color: var(--text-muted);">❓ Unknown: </span>
											<span style="color: var(--text-primary);">${formatNumber(stats.month.modelSwitching.unknownRequests)} (${formatPercent((stats.month.modelSwitching.unknownRequests / stats.month.modelSwitching.totalRequests) * 100)})</span>
										</div>
									` : ''}
								</div>
							` : ''}
							${stats.month.modelSwitching.mixedTierSessions > 0 ? `
								<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a30;">
									<span style="font-size: 11px; color: var(--link-color);">🔀 Mixed tier sessions: ${formatNumber(stats.month.modelSwitching.mixedTierSessions)}</span>
								</div>
							` : ''}
						</div>
					</div>
				</div>
			</div>

			<!-- Summary Section -->
			<div class="section">
				<div class="section-title"><span>📈</span><span>Sessions Summary</span></div>
				<div class="stats-grid">
					<div class="stat-card"><div class="stat-label">📅 Today Sessions</div><div class="stat-value">${formatNumber(stats.today.sessions)}</div></div>
					<div class="stat-card"><div class="stat-label">📆 Last 30 Days Sessions</div><div class="stat-value">${formatNumber(stats.last30Days.sessions)}</div></div>
					<div class="stat-card"><div class="stat-label">📅 Last Month Sessions</div><div class="stat-value">${formatNumber(stats.month.sessions)}</div></div>
				</div>
			</div>

			<div class="footer">
				Last updated: ${new Date(stats.lastUpdated).toLocaleString()} · Updates every 5 minutes
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
	document.getElementById('btn-chart')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showChart' });
	});
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDiagnostics' });
	});
	document.getElementById('btn-maturity')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showMaturity' });
	});
	document.getElementById('btn-dashboard')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDashboard' });
	});
	
	// Repository analysis buttons
	document.getElementById('btn-analyse-repo')?.addEventListener('click', () => {
		const btn = document.getElementById('btn-analyse-repo') as any;
		if (btn) {
			btn.disabled = true;
			btn.textContent = 'Analyzing...';
		}
		vscode.postMessage({ command: 'analyseRepository' });
	});
	
	document.getElementById('btn-analyse-all')?.addEventListener('click', () => {
		const btn = document.getElementById('btn-analyse-all') as any;
		if (btn) {
			btn.disabled = true;
			btn.textContent = 'Analyzing All...';
		}
		isBatchAnalysisInProgress = true;
		isSwitchingRepository = true;
		selectedRepoPath = null;
		renderRepositoryHygienePanels();
		vscode.postMessage({ command: 'analyseAllRepositories' });
	});

	document.getElementById('repo-list-pane')?.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		const actionButton = target.closest<HTMLElement>('.btn-repo-action');
		if (!actionButton) {
			return;
		}

		const workspacePath = actionButton.getAttribute('data-workspace-path');
		const action = actionButton.getAttribute('data-action');
		if (!workspacePath || !action) {
			return;
		}

		if (action === 'details') {
			selectedRepoPath = workspacePath;
			isSwitchingRepository = false;
			renderRepositoryHygienePanels();
			return;
		}

		if (action === 'analyze') {
			(actionButton as any).disabled = true;
			(actionButton as any).textContent = 'Analyzing...';
			isBatchAnalysisInProgress = false;
			vscode.postMessage({ command: 'analyseRepository', workspacePath });
		}
	});

	document.getElementById('repo-details-pane')?.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		if (target.closest('#btn-switch-repository')) {
			isSwitchingRepository = true;
			renderRepositoryHygienePanels();
		}
	});

	renderRepositoryHygienePanels();

	// Copy path buttons in customization list
	Array.from(document.getElementsByClassName('cf-copy')).forEach((el) => {
		(el as HTMLElement).addEventListener('click', (ev) => {
			const target = ev.currentTarget as HTMLElement;
			const path = target.getAttribute('data-path') || '';
			if (navigator.clipboard && path) {
				navigator.clipboard.writeText(path).then(() => {
					target.textContent = 'Copied';
					setTimeout(() => { target.textContent = 'Copy'; }, 1200);
				}).catch(() => {
					vscode.postMessage({ command: 'copyFailed', path });
				});
			}
		});
	});
}

// Listen for messages from the extension
window.addEventListener('message', (event) => {
	const message = event.data;
	switch (message.command) {
		case 'repoAnalysisResults':
			displayRepoAnalysisResults(message.data, message.workspacePath);
			break;
		case 'repoAnalysisError':
			displayRepoAnalysisError(message.error, message.workspacePath);
			break;
		case 'repoAnalysisBatchComplete':
			handleBatchAnalysisComplete();
			break;
	}
});

function getWorkspaceName(workspacePath: string): string {
	const workspace = hygieneMatrixState?.workspaces.find((ws) => ws.workspacePath === workspacePath);
	return workspace?.workspaceName || workspacePath;
}

function getScoreLabel(workspacePath: string): string {
	const record = repoAnalysisState.get(workspacePath);
	if (record?.data?.summary) {
		return `${Math.round(record.data.summary.percentage)}%`;
	}
	if (record?.error) {
		return 'Error';
	}
	return '—';
}

function toFiniteNumber(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

function buildRepoAnalysisBodyElement(data: any): HTMLElement {
	const summary = data?.summary || {};
	const checks = Array.isArray(data?.checks) ? data.checks : [];
	const recommendations = Array.isArray(data?.recommendations) ? [...data.recommendations] : [];

	const container = el('div');

	const header = el('div');
	header.setAttribute('style', 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;');
	const title = el('div');
	title.setAttribute('style', 'font-size: 14px; font-weight: 600; color: #fff;');
	title.textContent = '📊 Repository Hygiene Score';
	const score = el('div');
	score.setAttribute('style', 'font-size: 24px; font-weight: 700; color: #60a5fa;');
	score.textContent = `${Math.round(toFiniteNumber(summary.percentage))}%`;
	header.append(title, score);
	container.appendChild(header);

	const statsGrid = el('div');
	statsGrid.setAttribute('style', 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;');

	const statCards: Array<{ count: unknown; label: string; cardStyle: string; countStyle: string }> = [
		{
			count: summary.passedChecks,
			label: 'Passed',
			cardStyle: 'text-align: center; padding: 8px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 4px;',
			countStyle: 'font-size: 18px; font-weight: 600; color: #22c55e;'
		},
		{
			count: summary.warningChecks,
			label: 'Warnings',
			cardStyle: 'text-align: center; padding: 8px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 4px;',
			countStyle: 'font-size: 18px; font-weight: 600; color: #f59e0b;'
		},
		{
			count: summary.failedChecks,
			label: 'Failed',
			cardStyle: 'text-align: center; padding: 8px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 4px;',
			countStyle: 'font-size: 18px; font-weight: 600; color: #ef4444;'
		}
	];

	for (const statCard of statCards) {
		const card = el('div');
		card.setAttribute('style', statCard.cardStyle);
		const count = el('div');
		count.setAttribute('style', statCard.countStyle);
		count.textContent = String(toFiniteNumber(statCard.count));
		const label = el('div');
		label.setAttribute('style', 'font-size: 10px; color: #b8b8b8;');
		label.textContent = statCard.label;
		card.append(count, label);
		statsGrid.appendChild(card);
	}

	container.appendChild(statsGrid);

	const scoreSummary = el('div');
	scoreSummary.setAttribute('style', 'font-size: 11px; color: #999; text-align: center; margin-bottom: 16px;');
	scoreSummary.textContent = `Score: ${toFiniteNumber(summary.totalScore)} / ${toFiniteNumber(summary.maxScore)} points`;
	container.appendChild(scoreSummary);

	const priorityOrder: { [key: string]: number } = { high: 1, medium: 2, low: 3 };
	recommendations.sort((a: any, b: any) => (priorityOrder[a?.priority as string] || 99) - (priorityOrder[b?.priority as string] || 99));

	const categories: { [key: string]: any[] } = {};
	for (const check of checks) {
		const categoryId = typeof check?.category === 'string' && check.category.length > 0 ? check.category : 'other';
		if (!categories[categoryId]) {
			categories[categoryId] = [];
		}
		categories[categoryId].push(check);
	}

	const categoryLabels: { [key: string]: string } = {
		versionControl: '🔄 Version Control',
		codeQuality: '✨ Code Quality',
		cicd: '🚀 CI/CD',
		environment: '🔧 Environment',
		documentation: '📚 Documentation'
	};

	for (const [categoryId, categoryChecks] of Object.entries(categories)) {
		const section = el('div');
		section.setAttribute('style', 'margin-bottom: 12px; background: #0d0d0f; border: 1px solid #2a2a30; border-radius: 4px; overflow: hidden;');

		const sectionHeader = el('div');
		sectionHeader.setAttribute('style', 'padding: 8px 12px; background: rgba(96, 165, 250, 0.1); border-bottom: 1px solid #2a2a30; display: flex; justify-content: space-between; align-items: center;');

		const categoryName = el('span');
		categoryName.setAttribute('style', 'font-size: 12px; font-weight: 600; color: #fff;');
		categoryName.textContent = categoryLabels[categoryId] || categoryId;

		const categorySummary = summary?.categories?.[categoryId];
		const categoryPct = el('span');
		categoryPct.setAttribute('style', 'font-size: 11px; color: #60a5fa; font-weight: 600;');
		categoryPct.textContent = `${Math.round(toFiniteNumber(categorySummary?.percentage))}%`;

		sectionHeader.append(categoryName, categoryPct);
		section.appendChild(sectionHeader);

		for (const check of categoryChecks) {
			const status = check?.status === 'pass' || check?.status === 'warning' ? check.status : 'fail';
			const statusIcon = status === 'pass' ? '✅' : status === 'warning' ? '⚠️' : '❌';
			const statusColor = status === 'pass' ? '#22c55e' : status === 'warning' ? '#f59e0b' : '#ef4444';

			const checkRow = el('div');
			checkRow.setAttribute('style', 'padding: 8px; border-bottom: 1px solid #2a2a30; display: flex; align-items: flex-start; gap: 8px;');

			const icon = el('span');
			icon.setAttribute('style', 'font-size: 16px;');
			icon.textContent = statusIcon;

			const content = el('div');
			content.setAttribute('style', 'flex: 1;');

			const checkLabel = el('div');
			checkLabel.setAttribute('style', `font-size: 12px; font-weight: 600; color: ${statusColor};`);
			checkLabel.textContent = typeof check?.label === 'string' ? check.label : '';

			const checkDetail = el('div');
			checkDetail.setAttribute('style', 'font-size: 11px; color: #b8b8b8; margin-top: 2px;');
			checkDetail.textContent = typeof check?.detail === 'string' ? check.detail : '';

			content.append(checkLabel, checkDetail);

			if (typeof check?.hint === 'string' && check.hint.length > 0) {
				const hint = el('div');
				hint.setAttribute('style', 'font-size: 10px; color: #60a5fa; margin-top: 4px; font-style: italic;');
				hint.textContent = `💡 ${check.hint}`;
				content.appendChild(hint);
			}

			const weight = el('span');
			weight.setAttribute('style', 'font-size: 10px; color: #999; min-width: 30px; text-align: right;');
			weight.textContent = `+${toFiniteNumber(check?.weight)}`;

			checkRow.append(icon, content, weight);
			section.appendChild(checkRow);
		}

		container.appendChild(section);
	}

	if (recommendations.length > 0) {
		const recommendationsSection = el('div');
		recommendationsSection.setAttribute('style', 'margin-top: 16px; background: #0d0d0f; border: 1px solid #2a2a30; border-radius: 4px; overflow: hidden;');

		const recommendationsHeader = el('div');
		recommendationsHeader.setAttribute('style', 'padding: 8px 12px; background: rgba(96, 165, 250, 0.1); border-bottom: 1px solid #2a2a30;');
		const recommendationsTitle = el('span');
		recommendationsTitle.setAttribute('style', 'font-size: 12px; font-weight: 600; color: #fff;');
		recommendationsTitle.textContent = '💡 Top Recommendations';
		recommendationsHeader.appendChild(recommendationsTitle);
		recommendationsSection.appendChild(recommendationsHeader);

		for (const recommendation of recommendations.slice(0, 5)) {
			const priority = recommendation?.priority === 'high' || recommendation?.priority === 'medium' ? recommendation.priority : 'low';
			const priorityColor = priority === 'high' ? '#ef4444' : priority === 'medium' ? '#f59e0b' : '#60a5fa';

			const row = el('div');
			row.setAttribute('style', 'padding: 8px; border-bottom: 1px solid #2a2a30; display: flex; gap: 8px;');

			const priorityLabel = el('span');
			priorityLabel.setAttribute('style', `font-size: 10px; font-weight: 600; color: ${priorityColor}; min-width: 50px;`);
			priorityLabel.textContent = String(priority).toUpperCase();

			const content = el('div');
			content.setAttribute('style', 'flex: 1;');

			const action = el('div');
			action.setAttribute('style', 'font-size: 11px; color: #fff;');
			action.textContent = typeof recommendation?.action === 'string' ? recommendation.action : '';

			const impact = el('div');
			impact.setAttribute('style', 'font-size: 10px; color: #999; margin-top: 2px;');
			impact.textContent = typeof recommendation?.impact === 'string' ? recommendation.impact : '';

			content.append(action, impact);

			const weight = el('span');
			weight.setAttribute('style', 'font-size: 10px; color: #999; min-width: 30px; text-align: right;');
			weight.textContent = `+${toFiniteNumber(recommendation?.weight)}`;

			row.append(priorityLabel, content, weight);
			recommendationsSection.appendChild(row);
		}

		container.appendChild(recommendationsSection);
	}

	return container;
}

function renderRepositoryHygienePanels(): void {
	const listPane = document.getElementById('repo-list-pane');
	const listContainer = document.getElementById('repo-list-pane-container');
	const detailsPane = document.getElementById('repo-details-pane');
	const detailsContainer = document.getElementById('repo-details-pane-container');
	if (!listPane || !listContainer || !detailsPane || !detailsContainer || !hygieneMatrixState) {
		return;
	}

	const hasSelectedRepository = !!selectedRepoPath && !isSwitchingRepository;
	const visibleWorkspaces = hasSelectedRepository
		? hygieneMatrixState.workspaces.filter((ws) => ws.workspacePath === selectedRepoPath)
		: hygieneMatrixState.workspaces;

	listContainer.classList.remove('repo-hygiene-pane-collapsed');
	detailsContainer.classList.toggle('repo-hygiene-pane-collapsed', !hasSelectedRepository);

	listPane.innerHTML = visibleWorkspaces.map((ws, idx) => {
		const record = repoAnalysisState.get(ws.workspacePath);
		const hasResult = !!record?.data?.summary;
		const scoreLabel = getScoreLabel(ws.workspacePath);
		const buttonLabel = hasResult ? 'Details' : 'Analyze';
		const buttonAction = hasResult ? 'details' : 'analyze';
		const isCurrentSelection = selectedRepoPath === ws.workspacePath && hasSelectedRepository;
		return `
			<div class="repo-item" style="padding: 8px 12px; border-bottom: ${idx < visibleWorkspaces.length - 1 ? '1px solid #2a2a30' : 'none'}; display: flex; align-items: center; justify-content: space-between; gap: 10px;">
				<div style="flex: 1; min-width: 0;">
					<div class="repo-name" style="font-size: 12px; font-weight: 600; color: #fff; font-family: 'Courier New', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(ws.workspacePath)}">
						${escapeHtml(ws.workspaceName)}
					</div>
					<div style="font-size: 10px; color: #999; margin-top: 2px;">
						${ws.sessionCount} ${ws.sessionCount === 1 ? 'session' : 'sessions'} · ${ws.interactionCount} ${ws.interactionCount === 1 ? 'interaction' : 'interactions'} · Score: ${scoreLabel}
					</div>
				</div>
				<vscode-button class="btn-repo-action" data-action="${buttonAction}" data-workspace-path="${escapeHtml(ws.workspacePath)}" ${isCurrentSelection ? 'disabled="true"' : ''} style="min-width: 80px;">
					${buttonLabel}
				</vscode-button>
			</div>
		`;
	}).join('');

	if (!hasSelectedRepository || !selectedRepoPath) {
		detailsPane.replaceChildren();
		return;
	}

	const workspaceName = getWorkspaceName(selectedRepoPath);
	const record = repoAnalysisState.get(selectedRepoPath);
	if (record?.data) {
		detailsPane.replaceChildren();
		const card = el('div', 'repo-details-card');
		card.setAttribute('style', 'padding: 12px; background: #0d0d0f; border: 1px solid #2a2a30; border-radius: 6px;');

		const header = el('div', 'repo-details-card-header');
		header.setAttribute('style', 'display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px;');

		const label = el('div');
		label.setAttribute('style', 'font-size: 12px; color: #b8b8b8;');
		label.textContent = 'Repository: ';

		const repoName = el('span');
		repoName.setAttribute('style', "color: #fff; font-weight: 600; font-family: 'Courier New', monospace;");
		repoName.textContent = workspaceName;
		label.appendChild(repoName);

		const switchButton = document.createElement('vscode-button');
		switchButton.id = 'btn-switch-repository';
		switchButton.setAttribute('style', 'min-width: 120px;');
		switchButton.textContent = 'Switch Repository';

		header.append(label, switchButton);
		card.append(header, buildRepoAnalysisBodyElement(record.data));
		detailsPane.appendChild(card);
		return;
	}

	if (record?.error) {
		detailsPane.innerHTML = `
			<div style="padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px;">
				<div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;">
					<div style="font-size: 11px; color: #fca5a5;">Repository: ${escapeHtml(workspaceName)}</div>
					<vscode-button id="btn-switch-repository" style="min-width: 120px;">Switch Repository</vscode-button>
				</div>
				<div style="font-size: 12px; font-weight: 600; color: #ef4444; margin-bottom: 4px;">❌ Analysis Failed</div>
				<div style="font-size: 11px; color: #fca5a5;">${escapeHtml(record.error)}</div>
			</div>
		`;
		return;
	}

	detailsPane.innerHTML = `
		<div style="padding: 12px; background: #0d0d0f; border: 1px solid #2a2a30; border-radius: 6px;">
			<div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;">
				<div style="font-size: 12px; color: #b8b8b8;">Repository: <span style="color: #fff; font-weight: 600; font-family: 'Courier New', monospace;">${escapeHtml(workspaceName)}</span></div>
				<vscode-button id="btn-switch-repository" style="min-width: 120px;">Switch Repository</vscode-button>
			</div>
			<div style="font-size: 11px; color: #999;">No analysis data yet. Click Analyze in the list.</div>
		</div>
	`;
}

function displayRepoAnalysisResults(data: any, workspacePath?: string): void {
	if (workspacePath) {
		repoAnalysisState.set(workspacePath, { data, error: undefined });
		if (!isBatchAnalysisInProgress) {
			selectedRepoPath = workspacePath;
			isSwitchingRepository = false;
		}
		renderRepositoryHygienePanels();
		return;
	}

	const btn = document.getElementById('btn-analyse-repo') as any;
	if (btn) {
		btn.disabled = false;
		btn.textContent = 'Analyse Repository';
	}

	const resultsHost = document.getElementById('repo-analysis-results');
	if (resultsHost) {
		resultsHost.replaceChildren();
		const card = el('div', 'repo-analysis-card');
		card.setAttribute('style', 'padding: 12px; background: #0d0d0f; border: 1px solid #2a2a30; border-radius: 6px; margin-bottom: 12px;');
		card.appendChild(buildRepoAnalysisBodyElement(data));
		resultsHost.appendChild(card);
	}
}

function displayRepoAnalysisError(error: string, workspacePath?: string): void {
	if (workspacePath) {
		repoAnalysisState.set(workspacePath, { data: undefined, error });
		if (!isBatchAnalysisInProgress) {
			selectedRepoPath = workspacePath;
			isSwitchingRepository = false;
		}
		renderRepositoryHygienePanels();
		return;
	}

	const btn = document.getElementById('btn-analyse-repo') as any;
	if (btn) {
		btn.disabled = false;
		btn.textContent = 'Analyse Repository';
	}

	const resultsHost = document.getElementById('repo-analysis-results');
	if (resultsHost) {
		resultsHost.innerHTML = `
			<div style="padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px; margin-bottom: 12px;">
				<div style="font-size: 12px; font-weight: 600; color: #ef4444; margin-bottom: 4px;">❌ Analysis Failed</div>
				<div style="font-size: 11px; color: #fca5a5;">${escapeHtml(error)}</div>
			</div>
		`;
	}
}

function handleBatchAnalysisComplete(): void {
	isBatchAnalysisInProgress = false;
	isSwitchingRepository = true;
	selectedRepoPath = null;
	renderRepositoryHygienePanels();

	// Re-enable the "Analyze All" button
	const btn = document.getElementById('btn-analyse-all') as any;
	if (btn) {
		btn.disabled = false;
		const matrix = (initialData as any)?.customizationMatrix as WorkspaceCustomizationMatrix | undefined;
		const count = matrix?.workspaces?.length || 0;
		btn.textContent = `Analyze All Repositories (${count})`;
	}
}

async function bootstrap(): Promise<void> {
	const { provideVSCodeDesignSystem, vsCodeButton } = await import('@vscode/webview-ui-toolkit');
	provideVSCodeDesignSystem().register(vsCodeButton());

	// TOOL_NAME_MAP is imported at build-time from src/toolNames.json

	if (!initialData) {
		const root = document.getElementById('root');
		if (root) {
			root.textContent = 'No data available.';
		}
		return;
	}
	console.log('[Usage Analysis] Browser default locale:', Intl.DateTimeFormat().resolvedOptions().locale);
	console.log('[Usage Analysis] Received locale from extension:', initialData.locale);
	console.log('[Usage Analysis] Test format 1234567.89 with received locale:', new Intl.NumberFormat(initialData.locale).format(1234567.89));
	setFormatLocale(initialData.locale);
	renderLayout(initialData);
}

void bootstrap();

