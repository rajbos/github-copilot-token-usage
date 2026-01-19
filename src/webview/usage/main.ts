// Usage Analysis webview
type ModeUsage = { ask: number; edit: number; agent: number };
type ContextReferenceUsage = {
	file: number;
	selection: number;
	symbol: number;
	codebase: number;
	workspace: number;
	terminal: number;
	vscode: number;
};
type ToolCallUsage = { total: number; byTool: { [key: string]: number } };
type McpToolUsage = { total: number; byServer: { [key: string]: number }; byTool: { [key: string]: number } };

type UsageAnalysisPeriod = {
	sessions: number;
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
};

type UsageAnalysisStats = {
	today: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	lastUpdated: string;
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

declare global {
	interface Window { __INITIAL_USAGE__?: UsageAnalysisStats; }
}

const vscode = acquireVsCodeApi();
const initialData = window.__INITIAL_USAGE__;

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

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function getTotalContextRefs(refs: ContextReferenceUsage): number {
	return refs.file + refs.selection + refs.symbol + refs.codebase +
		refs.workspace + refs.terminal + refs.vscode;
}

function generateTopToolsList(byTool: { [key: string]: number }, limit = 5): string {
	const sortedTools = Object.entries(byTool)
		.sort(([, a], [, b]) => b - a)
		.slice(0, limit);

	if (sortedTools.length === 0) {
		return '<li style="color: #999;">No tools used yet</li>';
	}

	return sortedTools.map(([tool, count]) =>
		`<li><strong>${escapeHtml(tool)}</strong>: ${count} ${count === 1 ? 'call' : 'calls'}</li>`
	).join('');
}

function renderLayout(stats: UsageAnalysisStats): void {
	const root = document.getElementById('root');
	if (!root) {
		return;
	}

	const todayTotalRefs = getTotalContextRefs(stats.today.contextReferences);
	const monthTotalRefs = getTotalContextRefs(stats.month.contextReferences);
	const todayTotalModes = stats.today.modeUsage.ask + stats.today.modeUsage.edit + stats.today.modeUsage.agent;
	const monthTotalModes = stats.month.modeUsage.ask + stats.month.modeUsage.edit + stats.month.modeUsage.agent;

	root.innerHTML = `
		<style>
			* { margin: 0; padding: 0; box-sizing: border-box; }
			body {
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				background: #2d2d2d;
				color: #cccccc;
				padding: 16px;
				line-height: 1.5;
				min-width: 320px;
			}
			.container {
				background: #3c3c3c;
				border: 1px solid #5a5a5a;
				border-radius: 8px;
				padding: 16px;
				box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
				max-width: 1200px;
				margin: 0 auto;
			}
			.header {
				display: flex;
				align-items: center;
				gap: 8px;
				margin-bottom: 16px;
				padding-bottom: 12px;
				border-bottom: 1px solid #5a5a5a;
			}
			.header-icon { font-size: 20px; }
			.header-title { font-size: 16px; font-weight: 600; color: #ffffff; }
			.section { margin-bottom: 24px; }
			.section-title {
				font-size: 15px;
				font-weight: 600;
				color: #ffffff;
				margin-bottom: 12px;
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.section-subtitle { font-size: 13px; color: #999; margin-bottom: 12px; }
			.stats-grid {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
				gap: 12px;
				margin-bottom: 16px;
			}
			.stat-card {
				background: #353535;
				border: 1px solid #5a5a5a;
				border-radius: 4px;
				padding: 12px;
			}
			.stat-label { font-size: 11px; color: #b3b3b3; margin-bottom: 4px; }
			.stat-value { font-size: 20px; font-weight: 600; color: #ffffff; }
			.bar-chart {
				background: #353535;
				border: 1px solid #5a5a5a;
				border-radius: 4px;
				padding: 12px;
				margin-bottom: 12px;
			}
			.bar-item { margin-bottom: 8px; }
			.bar-label { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
			.bar-track { background: #2a2a2a; height: 8px; border-radius: 4px; overflow: hidden; }
			.bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease; }
			.list {
				background: #353535;
				border: 1px solid #5a5a5a;
				border-radius: 4px;
				padding: 12px 16px;
			}
			.list ul { list-style: none; padding: 0; }
			.list li { padding: 4px 0; font-size: 13px; }
			.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
			.info-box {
				background: #3a4a5a;
				border: 1px solid #4a5a6a;
				border-radius: 4px;
				padding: 12px;
				margin-bottom: 16px;
				font-size: 13px;
			}
			.info-box-title { font-weight: 600; color: #ffffff; margin-bottom: 6px; }
			.footer {
				margin-top: 16px;
				padding-top: 12px;
				border-top: 1px solid #5a5a5a;
				text-align: center;
				font-size: 11px;
				color: #999999;
				font-style: italic;
			}
			.refresh-button {
				background: #0e639c;
				border: 1px solid #1177bb;
				color: #ffffff;
				padding: 8px 16px;
				border-radius: 4px;
				cursor: pointer;
				font-size: 12px;
				font-weight: 500;
				margin-top: 8px;
				transition: background-color 0.2s;
				display: inline-flex;
				align-items: center;
				gap: 6px;
			}
			.refresh-button:hover { background: #1177bb; }
			.refresh-button:active { background: #0a5a8a; }
			@media (max-width: 768px) { .two-column { grid-template-columns: 1fr; } }
		</style>
		<div class="container">
			<div class="header">
				<span class="header-icon">📊</span>
				<span class="header-title">Copilot Usage Analysis Dashboard</span>
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
					<div class="stat-card"><div class="stat-label">🔤 #symbol</div><div class="stat-value">${stats.month.contextReferences.symbol}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.symbol}</div></div>
					<div class="stat-card"><div class="stat-label">🗂️ #codebase</div><div class="stat-value">${stats.month.contextReferences.codebase}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.codebase}</div></div>
					<div class="stat-card"><div class="stat-label">📁 @workspace</div><div class="stat-value">${stats.month.contextReferences.workspace}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.workspace}</div></div>
					<div class="stat-card"><div class="stat-label">💻 @terminal</div><div class="stat-value">${stats.month.contextReferences.terminal}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.terminal}</div></div>
					<div class="stat-card"><div class="stat-label">🔧 @vscode</div><div class="stat-value">${stats.month.contextReferences.vscode}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.vscode}</div></div>
					<div class="stat-card" style="background: #4a3a5a;"><div class="stat-label">📊 Total References</div><div class="stat-value">${monthTotalRefs}</div><div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${todayTotalRefs}</div></div>
				</div>
			</div>

			<!-- Tool Calls Section -->
			<div class="section">
				<div class="section-title"><span>🔧</span><span>Tool Usage</span></div>
				<div class="section-subtitle">Functions and tools invoked by Copilot during interactions</div>
				<div class="two-column">
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total Tool Calls: ${stats.today.toolCalls.total}</div>
							<ul>${generateTopToolsList(stats.today.toolCalls.byTool)}</ul>
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total Tool Calls: ${stats.month.toolCalls.total}</div>
							<ul>${generateTopToolsList(stats.month.toolCalls.byTool)}</ul>
						</div>
					</div>
				</div>
			</div>

			<!-- MCP Tools Section -->
			<div class="section">
				<div class="section-title"><span>🔌</span><span>MCP Tools</span></div>
				<div class="section-subtitle">Model Context Protocol (MCP) server and tool usage</div>
				<div class="two-column">
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total MCP Calls: ${stats.today.mcpTools.total}</div>
							${stats.today.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><ul style="margin-top: 4px;">${generateTopToolsList(stats.today.mcpTools.byServer)}</ul></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><ul style="margin-top: 4px;">${generateTopToolsList(stats.today.mcpTools.byTool)}</ul></div>
							` : '<div style="color: #999; margin-top: 8px;">No MCP tools used yet</div>'}
						</div>
					</div>
					<div>
						<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
						<div class="list">
							<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">Total MCP Calls: ${stats.month.mcpTools.total}</div>
							${stats.month.mcpTools.total > 0 ? `
								<div style="margin-top: 12px;"><strong>By Server:</strong><ul style="margin-top: 4px;">${generateTopToolsList(stats.month.mcpTools.byServer)}</ul></div>
								<div style="margin-top: 12px;"><strong>By Tool:</strong><ul style="margin-top: 4px;">${generateTopToolsList(stats.month.mcpTools.byTool)}</ul></div>
							` : '<div style="color: #999; margin-top: 8px;">No MCP tools used yet</div>'}
						</div>
					</div>
				</div>
			</div>

			<!-- Summary Section -->
			<div class="section">
				<div class="section-title"><span>📈</span><span>Sessions Summary</span></div>
				<div class="stats-grid">
					<div class="stat-card"><div class="stat-label">📅 Today Sessions</div><div class="stat-value">${stats.today.sessions}</div></div>
					<div class="stat-card"><div class="stat-label">📊 Month Sessions</div><div class="stat-value">${stats.month.sessions}</div></div>
				</div>
			</div>

			<div class="footer">
				Last updated: ${new Date(stats.lastUpdated).toLocaleString()}<br>
				Updates automatically every 5 minutes
				<br>
				<button class="refresh-button" id="btn-refresh"><span>🔄</span><span>Refresh Analysis</span></button>
			</div>
		</div>
	`;

	document.getElementById('btn-refresh')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'refresh' });
	});
}

function bootstrap(): void {
	if (!initialData) {
		const root = document.getElementById('root');
		if (root) {
			root.textContent = 'No data available.';
		}
		return;
	}
	renderLayout(initialData);
}

bootstrap();
