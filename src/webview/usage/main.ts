// Usage Analysis webview
import { el } from '../shared/domUtils';
import { buttonHtml } from '../shared/buttonConfig';
import { ContextReferenceUsage, getTotalContextRefs } from '../shared/contextRefUtils';
// CSS imported as text via esbuild
import styles from './styles.css';

type ModeUsage = { ask: number; edit: number; agent: number };
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
	lastUpdated: string;
	customizationMatrix?: WorkspaceCustomizationMatrix | null;
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

const vscode = acquireVsCodeApi();
const initialData = window.__INITIAL_USAGE__;

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

function renderToolsTable(byTool: { [key: string]: number }, limit = 10): string {
	const sortedTools = Object.entries(byTool)
		.sort(([, a], [, b]) => b - a)
		.slice(0, limit);

	if (sortedTools.length === 0) {
		return '<div style="color: #999;">No tools used yet</div>';
	}

	const rows = sortedTools.map(([tool, count], idx) => {
		const friendly = escapeHtml(lookupToolName(tool));
		const idEscaped = escapeHtml(tool);
		return `
			<tr>
				<td style="padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.04);">${idx + 1}</td>
				<td style="padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.04);"><strong title="${idEscaped}">${friendly}</strong></td>
				<td style="padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.04); text-align:right;">${count}</td>
			</tr>`;
	}).join('');

	return `
		<table style="width:100%; border-collapse:collapse;">
			<thead>
				<tr style="color:#b8b8b8; font-size:12px; text-align:left;">
					<th style="padding:8px 12px; opacity:0.9;">#</th>
					<th style="padding:8px 12px; opacity:0.9;">Tool</th>
					<th style="padding:8px 12px; opacity:0.9; text-align:right;">Calls</th>
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

	const matrix = (window.__INITIAL_USAGE__ as any)?.customizationMatrix as WorkspaceCustomizationMatrix | undefined | null;
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
									${matrix.customizationTypes.map(type => `
										<td style="padding: 6px 8px; border-bottom: 1px solid #2a2a30; text-align: center; font-size: 16px;">
											${ws.typeStatuses[type.id] || '❓'}
										</td>
									`).join('')}
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
	const monthTotalRefs = getTotalContextRefs(stats.month.contextReferences);
	const todayTotalModes = stats.today.modeUsage.ask + stats.today.modeUsage.edit + stats.today.modeUsage.agent;
	const monthTotalModes = stats.month.modeUsage.ask + stats.month.modeUsage.edit + stats.month.modeUsage.agent;

	root.innerHTML = `
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
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="bar-chart">
							<div class="bar-item">
								<div class="bar-label"><span>💬 Ask Mode</span><span><strong>${stats.today.modeUsage.ask}</strong> (${todayTotalModes > 0 ? ((stats.today.modeUsage.ask / todayTotalModes) * 100).toFixed(0) : 0}%)</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.ask / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #3b82f6, #60a5fa);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>✏️ Edit Mode</span><span><strong>${stats.today.modeUsage.edit}</strong> (${todayTotalModes > 0 ? ((stats.today.modeUsage.edit / todayTotalModes) * 100).toFixed(0) : 0}%)</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.edit / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #10b981, #34d399);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>🤖 Agent Mode</span><span><strong>${stats.today.modeUsage.agent}</strong> (${todayTotalModes > 0 ? ((stats.today.modeUsage.agent / todayTotalModes) * 100).toFixed(0) : 0}%)</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.agent / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7c3aed, #a855f7);"></div></div>
							</div>
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
						<div class="bar-chart">
							<div class="bar-item">
								<div class="bar-label"><span>💬 Ask Mode</span><span><strong>${stats.month.modeUsage.ask}</strong> (${monthTotalModes > 0 ? ((stats.month.modeUsage.ask / monthTotalModes) * 100).toFixed(0) : 0}%)</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${monthTotalModes > 0 ? ((stats.month.modeUsage.ask / monthTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #3b82f6, #60a5fa);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>✏️ Edit Mode</span><span><strong>${stats.month.modeUsage.edit}</strong> (${monthTotalModes > 0 ? ((stats.month.modeUsage.edit / monthTotalModes) * 100).toFixed(0) : 0}%)</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${monthTotalModes > 0 ? ((stats.month.modeUsage.edit / monthTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #10b981, #34d399);"></div></div>
							</div>
							<div class="bar-item">
								<div class="bar-label"><span>🤖 Agent Mode</span><span><strong>${stats.month.modeUsage.agent}</strong> (${monthTotalModes > 0 ? ((stats.month.modeUsage.agent / monthTotalModes) * 100).toFixed(0) : 0}%)</span></div>
								<div class="bar-track"><div class="bar-fill" style="width: ${monthTotalModes > 0 ? ((stats.month.modeUsage.agent / monthTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7c3aed, #a855f7);"></div></div>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Context References Section -->
			<div class="section">
				<div class="section-title"><span>🔗</span><span>Context References</span></div>
				<div class="section-subtitle">How often you reference files, selections, symbols, and workspace context</div>
				<div class="stats-grid">
					<div class="stat-card"><div class="stat-label">📄 #file</div><div class="stat-value">${stats.month.contextReferences.file}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.file}</div></div>
					<div class="stat-card"><div class="stat-label">✂️ #selection</div><div class="stat-value">${stats.month.contextReferences.selection}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.selection}</div></div>
					<div class="stat-card" title="Text selected in your editor providing passive context to Copilot"><div class="stat-label">✨ Implicit Selection</div><div class="stat-value">${stats.month.contextReferences.implicitSelection}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.implicitSelection}</div></div>
					<div class="stat-card"><div class="stat-label">🔤 #symbol</div><div class="stat-value">${stats.month.contextReferences.symbol}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.symbol}</div></div>
					<div class="stat-card"><div class="stat-label">🗂️ #codebase</div><div class="stat-value">${stats.month.contextReferences.codebase}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.codebase}</div></div>
					<div class="stat-card"><div class="stat-label">📁 @workspace</div><div class="stat-value">${stats.month.contextReferences.workspace}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.workspace}</div></div>
					<div class="stat-card"><div class="stat-label">💻 @terminal</div><div class="stat-value">${stats.month.contextReferences.terminal}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.terminal}</div></div>
					<div class="stat-card"><div class="stat-label">🔧 @vscode</div><div class="stat-value">${stats.month.contextReferences.vscode}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.vscode}</div></div>
					<div class="stat-card" title="Last command run in the terminal"><div class="stat-label">⌨️ #terminalLastCommand</div><div class="stat-value">${stats.month.contextReferences.terminalLastCommand || 0}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.terminalLastCommand || 0}</div></div>
					<div class="stat-card" title="Selected terminal output"><div class="stat-label">🖱️ #terminalSelection</div><div class="stat-value">${stats.month.contextReferences.terminalSelection || 0}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.terminalSelection || 0}</div></div>
					<div class="stat-card" title="Clipboard contents"><div class="stat-label">📋 #clipboard</div><div class="stat-value">${stats.month.contextReferences.clipboard || 0}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.clipboard || 0}</div></div>
					<div class="stat-card" title="Uncommitted git changes"><div class="stat-label">📝 #changes</div><div class="stat-value">${stats.month.contextReferences.changes || 0}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.changes || 0}</div></div>
					<div class="stat-card" title="Output panel contents"><div class="stat-label">📤 #outputPanel</div><div class="stat-value">${stats.month.contextReferences.outputPanel || 0}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.outputPanel || 0}</div></div>
					<div class="stat-card" title="Problems panel contents"><div class="stat-label">⚠️ #problemsPanel</div><div class="stat-value">${stats.month.contextReferences.problemsPanel || 0}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.problemsPanel || 0}</div></div>
					<div class="stat-card" title="copilot-instructions.md file references detected in session logs"><div class="stat-label">📋 Copilot Instructions</div><div class="stat-value">${stats.month.contextReferences.copilotInstructions}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.copilotInstructions}</div></div>
					<div class="stat-card" title="agents.md file references detected in session logs"><div class="stat-label">🤖 Agents.md</div><div class="stat-value">${stats.month.contextReferences.agentsMd}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.agentsMd}</div></div>
					<div class="stat-card" style="background: #4a3a5a;"><div class="stat-label">📊 Total References</div><div class="stat-value">${monthTotalRefs}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${todayTotalRefs}</div></div>
				</div>
				${Object.keys(stats.month.contextReferences.byKind).length > 0 ? `
					<div style="margin-top: 16px; padding: 12px; background: #18181b; border: 1px solid #2a2a30; border-radius: 6px;">
						<div style="font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 8px;">📎 Attached Files by Type (This Month)</div>
						<div style="font-size: 12px; color: #d0d0d0;">
							${Object.entries(stats.month.contextReferences.byKind)
								.sort(([, a], [, b]) => (b as number) - (a as number))
								.slice(0, 5)
								.map(([kind, count]) => `<div style="margin-bottom: 4px;"><span style="color: #60a5fa;">${escapeHtml(kind)}:</span> ${count}</div>`)
								.join('')}
						</div>
					</div>
				` : ''}
				${Object.keys(stats.month.contextReferences.byPath).length > 0 ? `
					<div style="margin-top: 16px; padding: 12px; background: #18181b; border: 1px solid #2a2a30; border-radius: 6px;">
						<div style="font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 8px;">📁 Most Referenced Files (This Month)</div>
						<div style="font-size: 11px; color: #d0d0d0;">
							${Object.entries(stats.month.contextReferences.byPath)
								.sort(([, a], [, b]) => (b as number) - (a as number))
								.slice(0, 10)
								.map(([path, count]) => `<div style="margin-bottom: 4px; font-family: 'Courier New', monospace;"><span style="color: #60a5fa;">${count}×</span> ${escapeHtml(path)}</div>`)
								.join('')}
						</div>
					</div>
				` : ''}
			</div>

			${customizationHtml}

			<!-- Tool Calls Section -->
			<div class="section">
				<div class="section-title"><span>🔧</span><span>Tool Usage</span></div>
				<div class="section-subtitle">Functions and tools invoked by Copilot during interactions</div>
				<div class="three-column">
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total Tool Calls: ${stats.today.toolCalls.total}</div>
							${renderToolsTable(stats.today.toolCalls.byTool, 10)}
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total Tool Calls: ${stats.month.toolCalls.total}</div>
							${renderToolsTable(stats.month.toolCalls.byTool, 10)}
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total Tool Calls: ${stats.last30Days.toolCalls.total}</div>
							${renderToolsTable(stats.last30Days.toolCalls.byTool, 10)}
						</div>
					</div>
				</div>
			</div>

			<!-- MCP Tools Section -->
			<div class="section">
				<div class="section-title"><span>🔌</span><span>MCP Tools</span></div>
				<div class="section-subtitle">Model Context Protocol (MCP) server and tool usage</div>
				<div class="three-column">
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total MCP Calls: ${stats.today.mcpTools.total}</div>
							${stats.today.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.today.mcpTools.byServer, 8)}</div></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.today.mcpTools.byTool, 8)}</div></div>
							` : '<div style="color: #999; margin-top: 8px;">No MCP tools used yet</div>'}
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total MCP Calls: ${stats.month.mcpTools.total}</div>
							${stats.month.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.month.mcpTools.byServer, 8)}</div></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.month.mcpTools.byTool, 8)}</div></div>
							` : '<div style="color: #999; margin-top: 8px;">No MCP tools used yet</div>'}
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total MCP Calls: ${stats.last30Days.mcpTools.total}</div>
							${stats.last30Days.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.last30Days.mcpTools.byServer, 8)}</div></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><div style="margin-top: 8px;">${renderToolsTable(stats.last30Days.mcpTools.byTool, 8)}</div></div>
							` : '<div style="color: #999; margin-top: 8px;">No MCP tools used yet</div>'}
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
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="stats-grid" style="grid-template-columns: 1fr;">
							<div class="stat-card">
								<div class="stat-label">📊 Avg Models per Conversation</div>
								<div class="stat-value">${stats.today.modelSwitching.averageModelsPerSession.toFixed(1)}</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">🔄 Switching Frequency</div>
								<div class="stat-value">${stats.today.modelSwitching.switchingFrequency.toFixed(0)}%</div>
								<div style="font-size: 10px; color: #999; margin-top: 4px;">Sessions with >1 model</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">📈 Max Models in Session</div>
								<div class="stat-value">${stats.today.modelSwitching.maxModelsPerSession || 0}</div>
							</div>
						</div>
						<div style="margin-top: 12px; padding: 12px; background: #18181b; border: 1px solid #2a2a30; border-radius: 6px;">
							<div style="font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 8px;">Models by Tier:</div>
							${stats.today.modelSwitching.standardModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #60a5fa;">🔵 Standard:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.today.modelSwitching.standardModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.today.modelSwitching.premiumModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #fbbf24;">⭐ Premium:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.today.modelSwitching.premiumModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.today.modelSwitching.unknownModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #9ca3af;">❓ Unknown:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.today.modelSwitching.unknownModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.today.modelSwitching.mixedTierSessions > 0 ? `
								<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a30;">
									<span style="font-size: 11px; color: #e0a0ff;">🔀 Mixed tier sessions: ${stats.today.modelSwitching.mixedTierSessions}</span>
								</div>
							` : ''}
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">� This Month</h4>
						<div class="stats-grid" style="grid-template-columns: 1fr;">
							<div class="stat-card">
								<div class="stat-label">📊 Avg Models per Conversation</div>
								<div class="stat-value">${stats.month.modelSwitching.averageModelsPerSession.toFixed(1)}</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">🔄 Switching Frequency</div>
								<div class="stat-value">${stats.month.modelSwitching.switchingFrequency.toFixed(0)}%</div>
								<div style="font-size: 10px; color: #999; margin-top: 4px;">Sessions with >1 model</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">📈 Max Models in Session</div>
								<div class="stat-value">${stats.month.modelSwitching.maxModelsPerSession || 0}</div>
							</div>
						</div>
						<div style="margin-top: 12px; padding: 12px; background: #18181b; border: 1px solid #2a2a30; border-radius: 6px;">
							<div style="font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 8px;">Models by Tier:</div>
							${stats.month.modelSwitching.standardModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #60a5fa;">🔵 Standard:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.month.modelSwitching.standardModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.month.modelSwitching.premiumModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #fbbf24;">⭐ Premium:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.month.modelSwitching.premiumModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.month.modelSwitching.unknownModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #9ca3af;">❓ Unknown:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.month.modelSwitching.unknownModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.month.modelSwitching.mixedTierSessions > 0 ? `
								<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a30;">
									<span style="font-size: 11px; color: #e0a0ff;">🔀 Mixed tier sessions: ${stats.month.modelSwitching.mixedTierSessions}</span>
								</div>
							` : ''}
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
						<div class="stats-grid" style="grid-template-columns: 1fr;">
							<div class="stat-card">
								<div class="stat-label">📊 Avg Models per Conversation</div>
								<div class="stat-value">${stats.last30Days.modelSwitching.averageModelsPerSession.toFixed(1)}</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">🔄 Switching Frequency</div>
								<div class="stat-value">${stats.last30Days.modelSwitching.switchingFrequency.toFixed(0)}%</div>
								<div style="font-size: 10px; color: #999; margin-top: 4px;">Sessions with >1 model</div>
							</div>
							<div class="stat-card">
								<div class="stat-label">📈 Max Models in Session</div>
								<div class="stat-value">${stats.last30Days.modelSwitching.maxModelsPerSession || 0}</div>
							</div>
						</div>
						<div style="margin-top: 12px; padding: 12px; background: #18181b; border: 1px solid #2a2a30; border-radius: 6px;">
							<div style="font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 8px;">Models by Tier:</div>
							${stats.last30Days.modelSwitching.standardModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #60a5fa;">🔵 Standard:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.last30Days.modelSwitching.standardModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.last30Days.modelSwitching.premiumModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #fbbf24;">⭐ Premium:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.last30Days.modelSwitching.premiumModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.last30Days.modelSwitching.unknownModels.length > 0 ? `
								<div style="margin-bottom: 6px;">
									<span style="color: #9ca3af;">❓ Unknown:</span>
									<span style="font-size: 11px; color: #d0d0d0;">${stats.last30Days.modelSwitching.unknownModels.join(', ')}</span>
								</div>
							` : ''}
							${stats.last30Days.modelSwitching.mixedTierSessions > 0 ? `
								<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a30;">
									<span style="font-size: 11px; color: #e0a0ff;">🔀 Mixed tier sessions: ${stats.last30Days.modelSwitching.mixedTierSessions}</span>
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
					<div class="stat-card"><div class="stat-label">📅 Today Sessions</div><div class="stat-value">${stats.today.sessions}</div></div>
					<div class="stat-card"><div class="stat-label">� This Month Sessions</div><div class="stat-value">${stats.month.sessions}</div></div>
					<div class="stat-card"><div class="stat-label">📆 Last 30 Days Sessions</div><div class="stat-value">${stats.last30Days.sessions}</div></div>
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
	renderLayout(initialData);
}

void bootstrap();
