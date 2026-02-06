// Log Viewer webview - displays session file details and chat turns
type ContextReferenceUsage = {
	file: number;
	selection: number;
	implicitSelection: number;
	symbol: number;
	codebase: number;
	workspace: number;
	terminal: number;
	vscode: number;
	byKind: { [kind: string]: number };
	copilotInstructions: number;
	agentsMd: number;
	byPath: { [path: string]: number };
};

type ChatTurn = {
	turnNumber: number;
	timestamp: string | null;
	mode: 'ask' | 'edit' | 'agent';
	userMessage: string;
	assistantResponse: string;
	model: string | null;
	toolCalls: { toolName: string; arguments?: string; result?: string }[];
	contextReferences: ContextReferenceUsage;
	mcpTools: { server: string; tool: string }[];
	inputTokensEstimate: number;
	outputTokensEstimate: number;
};

type ToolCallUsage = { total: number; byTool: { [key: string]: number } };
type ModeUsage = { ask: number; edit: number; agent: number };
type McpToolUsage = { total: number; byServer: { [key: string]: number }; byTool: { [key: string]: number } };
type SessionUsageAnalysis = {
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
};

type SessionLogData = {
	file: string;
	title: string | null;
	editorSource: string;
	editorName: string;
	size: number;
	modified: string;
	interactions: number;
	contextReferences: ContextReferenceUsage;
	firstInteraction: string | null;
	lastInteraction: string | null;
	turns: ChatTurn[];
	usageAnalysis?: SessionUsageAnalysis;
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

declare global {
	interface Window { __INITIAL_LOGDATA__?: SessionLogData; }
}

const vscode = acquireVsCodeApi();
const initialData = window.__INITIAL_LOGDATA__;

import toolNames from '../../toolNames.json';

let TOOL_NAME_MAP: { [key: string]: string } | null = toolNames || null;

function lookupToolName(id: string): string {
	if (!TOOL_NAME_MAP) {
		return id;
	}
	return TOOL_NAME_MAP[id] || id;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function formatDate(isoString: string | null): string {
	if (!isoString) { return 'N/A'; }
	try {
		return new Date(isoString).toLocaleString();
	} catch {
		return isoString;
	}
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) { return `${bytes} B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getTotalContextRefs(refs: ContextReferenceUsage): number {
	return refs.file + refs.selection + refs.implicitSelection + refs.symbol + refs.codebase +
		refs.workspace + refs.terminal + refs.vscode + refs.copilotInstructions + refs.agentsMd;
}

function getContextRefsSummary(refs: ContextReferenceUsage): string {
	const parts: string[] = [];
	if (refs.file > 0) { parts.push(`#file: ${refs.file}`); }
	if (refs.selection > 0) { parts.push(`#selection: ${refs.selection}`); }
	if (refs.implicitSelection > 0) { parts.push(`implicit: ${refs.implicitSelection}`); }
	if (refs.symbol > 0) { parts.push(`#symbol: ${refs.symbol}`); }
	if (refs.codebase > 0) { parts.push(`#codebase: ${refs.codebase}`); }
	if (refs.workspace > 0) { parts.push(`@workspace: ${refs.workspace}`); }
	if (refs.terminal > 0) { parts.push(`@terminal: ${refs.terminal}`); }
	if (refs.vscode > 0) { parts.push(`@vscode: ${refs.vscode}`); }
	if (refs.copilotInstructions > 0) { parts.push(`📋 instructions: ${refs.copilotInstructions}`); }
	if (refs.agentsMd > 0) { parts.push(`🤖 agents: ${refs.agentsMd}`); }
	return parts.length > 0 ? parts.join(', ') : 'None';
}

function getContextRefBadges(refs: ContextReferenceUsage): string {
	const badges: string[] = [];
	if (refs.selection > 0) { badges.push(`<span class="context-ref-item">#selection: <strong>${refs.selection}</strong></span>`); }
	if (refs.file > 0) { badges.push(`<span class="context-ref-item">#file: <strong>${refs.file}</strong></span>`); }
	if (refs.symbol > 0) { badges.push(`<span class="context-ref-item">#symbol: <strong>${refs.symbol}</strong></span>`); }
	if (refs.codebase > 0) { badges.push(`<span class="context-ref-item">#codebase: <strong>${refs.codebase}</strong></span>`); }
	if (refs.workspace > 0) { badges.push(`<span class="context-ref-item">@workspace: <strong>${refs.workspace}</strong></span>`); }
	if (refs.terminal > 0) { badges.push(`<span class="context-ref-item">@terminal: <strong>${refs.terminal}</strong></span>`); }
	if (refs.vscode > 0) { badges.push(`<span class="context-ref-item">@vscode: <strong>${refs.vscode}</strong></span>`); }
	if (refs.implicitSelection > 0) { badges.push(`<span class="context-ref-item context-ref-implicit">implicit: <strong>${refs.implicitSelection}</strong></span>`); }
	return badges.join('');
}

function renderContextReferencesDetailed(refs: ContextReferenceUsage): string {
	const sections: string[] = [];
	
	// Show instruction file references
	if (refs.copilotInstructions > 0 || refs.agentsMd > 0) {
		const instrRefs: string[] = [];
		if (refs.copilotInstructions > 0) { instrRefs.push(`📋 copilot-instructions: ${refs.copilotInstructions}`); }
		if (refs.agentsMd > 0) { instrRefs.push(`🤖 agents.md: ${refs.agentsMd}`); }
		sections.push(`<div class="context-section"><strong>Instructions:</strong> ${instrRefs.join(', ')}</div>`);
	}
	
	// Show file paths if any
	if (refs.byPath && Object.keys(refs.byPath).length > 0) {
		const pathList = Object.entries(refs.byPath)
			.map(([path, count]) => `${getFileName(path)}: ${count}`)
			.join(', ');
		sections.push(`<div class="context-section"><strong>Files:</strong> ${pathList}</div>`);
	}
	
	return sections.length > 0 ? sections.join('') : '<div class="context-section">No additional details</div>';
}

function getTopEntries(map: { [key: string]: number } = {}, limit = 3): { key: string; value: number }[] {
	return Object.entries(map)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([key, value]) => ({ key, value }));
}

function getModeIcon(mode: string): string {
	switch (mode) {
		case 'ask': return '💬';
		case 'edit': return '✏️';
		case 'agent': return '🤖';
		default: return '❓';
	}
}

function getModeColor(mode: string): string {
	switch (mode) {
		case 'ask': return '#3b82f6';
		case 'edit': return '#10b981';
		case 'agent': return '#7c3aed';
		default: return '#888';
	}
}

function getFileName(filePath: string): string {
	const parts = filePath.split(/[/\\]/);
	return parts[parts.length - 1];
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) { return text; }
	return text.substring(0, maxLength) + '...';
}

function renderTurnCard(turn: ChatTurn): string {
	const totalTokens = turn.inputTokensEstimate + turn.outputTokensEstimate;
	const hasToolCalls = turn.toolCalls.length > 0;
	const hasMcpTools = turn.mcpTools.length > 0;
	const totalRefs = getTotalContextRefs(turn.contextReferences);
	
	// Build context file badges for header
	const contextFileBadges: string[] = [];
	if (turn.contextReferences.copilotInstructions > 0) {
		contextFileBadges.push(`<span class="context-badge">📋 copilot-instructions.md</span>`);
	}
	if (turn.contextReferences.agentsMd > 0) {
		contextFileBadges.push(`<span class="context-badge">🤖 agents.md</span>`);
	}
	// Add other file references
	if (turn.contextReferences.byPath && Object.keys(turn.contextReferences.byPath).length > 0) {
		const otherPaths = Object.entries(turn.contextReferences.byPath)
			.filter(([path]) => {
				const normalized = path.toLowerCase().replace(/\\/g, '/');
				return !(normalized.includes('copilot-instructions.md') || normalized.endsWith('/agents.md'));
			});
		
		otherPaths.forEach(([path]) => {
			contextFileBadges.push(`<span class="context-badge" title="${escapeHtml(path)}">📄 ${escapeHtml(getFileName(path))}</span>`);
		});
	}
	
	const contextHeaderHtml = contextFileBadges.length > 0 ? contextFileBadges.join('') : '';

	// Build tool call summary
	let toolCallsHtml = '';
	if (hasToolCalls) {
		const toolCounts: { [key: string]: number } = {};
		turn.toolCalls.forEach(tc => {
			const toolName = lookupToolName(tc.toolName);
			toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
		});
		
		const toolSummary = Object.entries(toolCounts)
			.map(([name, count]) => `<span class="tool-summary-item">${escapeHtml(name)}: <strong>${count}</strong></span>`)
			.join('');
		
		toolCallsHtml = `
			<div class="turn-tools">
				<details class="tool-calls-details">
					<summary class="tool-calls-summary">
						<span class="collapse-arrow">▶</span>
						<span class="tools-header-inline">🔧 TOOL CALLS (${turn.toolCalls.length})</span>
						<span class="tool-summary-text">${toolSummary}</span>
					</summary>
					<table class="tools-table">
						<thead>
							<tr>
								<th scope="col">Tool Name</th>
								<th scope="col">Action</th>
							</tr>
						</thead>
						<tbody>
							${turn.toolCalls.map((tc, idx) => `
								<tr class="tool-row">
									<td class="tool-name-cell">
										<span class="tool-name tool-call-link" data-turn="${turn.turnNumber}" data-toolcall="${idx}" title="${escapeHtml(tc.toolName)}" style="cursor:pointer;">${escapeHtml(lookupToolName(tc.toolName))}</span>
										${tc.arguments ? `<details class="tool-details"><summary>Arguments</summary><pre>${escapeHtml(tc.arguments)}</pre></details>` : ''}
										${tc.result ? `<details class="tool-details"><summary>Result</summary><pre>${escapeHtml(truncateText(tc.result, 500))}</pre></details>` : ''}
									</td>
									<td class="tool-action-cell">
										<span class="tool-call-pretty" data-turn="${turn.turnNumber}" data-toolcall="${idx}" title="View pretty JSON" style="cursor:pointer;color:#22c55e;">Investigate</span>
									</td>
								</tr>
							`).join('')}
						</tbody>
					</table>
				</details>
			</div>
		`;
	}
	
	const mcpToolsHtml = hasMcpTools ? `
		<div class="turn-mcp">
			<div class="mcp-header">🔌 MCP Tools (${turn.mcpTools.length})</div>
			<div class="mcp-list">
				${turn.mcpTools.map(mcp => `
					<span class="mcp-item"><span class="mcp-server">${escapeHtml(mcp.server)}</span>: ${escapeHtml(mcp.tool)}</span>
				`).join('')}
			</div>
		</div>
	` : '';
	
	// Build context references detail section
	const hasContextRefs = totalRefs > 0;
	const contextRefBadges = getContextRefBadges(turn.contextReferences);
	const contextRefsHtml = hasContextRefs ? `
		<div class="turn-context-refs">
			<details class="context-refs-details">
				<summary class="context-refs-summary">
					<span class="collapse-arrow">▶</span>
					<span class="context-refs-header-inline">🔗 CONTEXT REFERENCES (${totalRefs})</span>
					<span class="context-ref-summary-text">${contextRefBadges}</span>
				</summary>
				<div class="context-refs-content">
					${renderContextReferencesDetailed(turn.contextReferences)}
				</div>
			</details>
		</div>
	` : '';
	
	return `
		<div class="turn-card" data-turn="${turn.turnNumber}">
			<div class="turn-header">
				<div class="turn-meta">
					<span class="turn-number">#${turn.turnNumber}</span>
					<span class="turn-mode" style="background: ${getModeColor(turn.mode)};">${getModeIcon(turn.mode)} ${turn.mode}</span>
					${turn.model ? `<span class="turn-model">🎯 ${escapeHtml(turn.model)}</span>` : ''}
					<span class="turn-tokens">📊 ${totalTokens.toLocaleString()} tokens (↑${turn.inputTokensEstimate} ↓${turn.outputTokensEstimate})</span>
					${contextHeaderHtml}
				</div>
				<div class="turn-time">${formatDate(turn.timestamp)}</div>
			</div>
			
			${toolCallsHtml}
			${mcpToolsHtml}
			${contextRefsHtml}
			
			<div class="turn-content">
				<div class="message user-message">
					<div class="message-label">👤 User</div>
					<div class="message-text">${escapeHtml(turn.userMessage) || '<em>No message</em>'}</div>
				</div>
				
				<div class="message assistant-message">
					<div class="message-label">🤖 Assistant</div>
					<div class="message-text">${escapeHtml(turn.assistantResponse) || '<em>No response</em>'}</div>
				</div>
			</div>
		</div>
	`;
}

function renderLayout(data: SessionLogData): void {
	const root = document.getElementById('root');
	if (!root) { return; }
	
	const totalTokens = data.turns.reduce((sum, t) => sum + t.inputTokensEstimate + t.outputTokensEstimate, 0);
	const totalToolCalls = data.turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
	const totalMcpTools = data.turns.reduce((sum, t) => sum + t.mcpTools.length, 0);
	const totalRefs = getTotalContextRefs(data.contextReferences);
	const usage = data.usageAnalysis;
	const usageMode = usage?.modeUsage || { ask: 0, edit: 0, agent: 0 };
	const usageToolTotal = usage?.toolCalls?.total ?? totalToolCalls;
	const usageTopTools = usage ? getTopEntries(usage.toolCalls.byTool, 3) : [];
	const usageMcpTotal = usage?.mcpTools?.total ?? totalMcpTools;
	const usageTopMcpTools = usage ? getTopEntries(usage.mcpTools.byTool, 3) : [];
	const usageContextRefs = usage?.contextReferences || data.contextReferences;
	const usageContextTotal = getTotalContextRefs(usageContextRefs);

	const formatTopList = (entries: { key: string; value: number }[], mapper?: (k: string) => string) => {
		if (!entries.length) { return 'None'; }
		return entries.map(e => `<div>${escapeHtml(mapper ? mapper(e.key) : e.key)}: ${e.value}</div>`).join('');
	};
	
	const formatTopListWithOther = (entries: { key: string; value: number }[], total: number, mapper?: (k: string) => string) => {
		if (!entries.length) { return 'None'; }
		const lines = entries.map(e => `<div>${escapeHtml(mapper ? mapper(e.key) : e.key)}: ${e.value}</div>`);
		const topSum = entries.reduce((sum, e) => sum + e.value, 0);
		const other = total - topSum;
		if (other > 0) {
			lines.push(`<div>Other: ${other}</div>`);
		}
		return lines.join('');
	};
	
	// Mode usage summary
	const modeUsage = { ask: 0, edit: 0, agent: 0 };
	const modelUsage: { [model: string]: number } = {};
	for (const turn of data.turns) {
		modeUsage[turn.mode]++;
		if (turn.model) {
			modelUsage[turn.model] = (modelUsage[turn.model] || 0) + 1;
		}
	}
	const modelNames = Object.keys(modelUsage);
	
	root.innerHTML = `
		<style>
			* { margin: 0; padding: 0; box-sizing: border-box; }
			body {
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				background: #0e0e0f;
				color: #e7e7e7;
				padding: 20px;
				line-height: 1.6;
				min-width: 320px;
			}
			.container {
				max-width: 1400px;
				margin: 0 auto;
			}

			/* Mode/model bar improvements */
			.mode-bar-group {
				background: linear-gradient(135deg, #1a1a22 0%, #1f1f28 100%);
				border: 1px solid #3a3a44;
				border-radius: 12px;
				padding: 20px 24px;
				display: flex;
				align-items: center;
				flex-wrap: wrap;
				gap: 28px;
				margin-bottom: 24px;
				box-shadow: 0 4px 12px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.2);
			}
			.mode-bar {
				display: flex;
				align-items: center;
				gap: 10px;
				font-size: 15px;
				font-weight: 500;
			}
			.mode-icon {
				width: 36px;
				height: 36px;
				border-radius: 8px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 18px;
				background: #23232a;
				border: 2px solid #2a2a30;
				box-shadow: 0 2px 4px rgba(0,0,0,0.2);
			}
			.mode-label {
				color: #b8b8c0;
				font-weight: 600;
			}
			.mode-count {
				color: #fff;
				font-weight: 700;
				font-size: 18px;
			}
			.model-summary {
				margin-left: auto;
				font-size: 15px;
				font-weight: 600;
				color: #fff;
				display: flex;
				align-items: center;
				gap: 12px;
				flex-wrap: wrap;
			}
			.model-list {
				display: flex;
				gap: 10px;
				flex-wrap: wrap;
			}
			.model-item {
				background: linear-gradient(135deg, #2a2a35 0%, #25252f 100%);
				border: 1px solid #3a3a44;
				border-radius: 6px;
				padding: 4px 12px;
				color: #60a5fa;
				font-weight: 600;
				font-size: 13px;
				box-shadow: 0 2px 6px rgba(0,0,0,0.15);
			}

			/* Summary cards */
			.summary-cards {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
				gap: 16px;
				margin-bottom: 24px;
			}
			.summary-card {
				background: linear-gradient(135deg, #1a1a22 0%, #1f1f28 100%);
				border: 1px solid #3a3a44;
				border-radius: 12px;
				padding: 24px 16px;
				text-align: center;
				box-shadow: 0 4px 12px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.2);
				transition: transform 0.2s, box-shadow 0.2s;
			}
			.summary-card:hover {
				transform: translateY(-2px);
				box-shadow: 0 6px 16px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.2);
			}
			.filename-link {
				cursor: pointer;
				color: #60a5fa;
				text-decoration: underline;
				transition: color 0.2s;
			}
			.filename-link:hover {
				color: #93c5fd;
			}
			.summary-label { 
				font-size: 14px; 
				color: #b8b8c0; 
				margin-bottom: 8px; 
				font-weight: 600;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.summary-value { 
				font-size: 32px; 
				font-weight: 700; 
				color: #60a5fa;
				margin-bottom: 8px;
			}
			.summary-sub { 
				font-size: 12px; 
				color: #94a3b8; 
				line-height: 1.5;
			}
			
			/* Turns container */
			.turns-header {
				font-size: 18px;
				font-weight: 700;
				color: #fff;
				margin-bottom: 16px;
				display: flex;
				align-items: center;
				gap: 10px;
				padding: 12px 0;
				border-bottom: 2px solid #3a3a44;
			}
			.turns-list {
				display: flex;
				flex-direction: column;
				gap: 16px;
			}
			
			/* Turn card */
			.turn-card {
				background: linear-gradient(135deg, #1a1a22 0%, #1f1f28 100%);
				border: 1px solid #3a3a44;
				border-radius: 12px;
				overflow: hidden;
				box-shadow: 0 4px 12px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.2);
				transition: transform 0.2s, box-shadow 0.2s;
			}
			.turn-card:hover {
				transform: translateY(-2px);
				box-shadow: 0 6px 16px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.2);
			}
			.turn-header {
				background: linear-gradient(135deg, #22222a 0%, #27272f 100%);
				padding: 14px 16px;
				display: flex;
				justify-content: space-between;
				align-items: center;
				gap: 10px;
				border-bottom: 1px solid #3a3a44;
				min-height: 48px;
			}
			.turn-meta {
				display: flex;
				align-items: center;
				gap: 8px;
				flex-wrap: nowrap;
				flex: 1;
				min-width: 0;
				overflow: hidden;
			}
			.turn-number {
				font-weight: 700;
				color: #fff;
				font-size: 16px;
				background: #3a3a44;
				padding: 4px 10px;
				border-radius: 6px;
				flex-shrink: 0;
			}
			.turn-mode {
				padding: 4px 12px;
				border-radius: 16px;
				font-size: 12px;
				font-weight: 700;
				color: #fff;
				box-shadow: 0 2px 4px rgba(0,0,0,0.2);
				flex-shrink: 0;
				white-space: nowrap;
			}
			.turn-model {
				font-size: 12px;
				color: #94a3b8;
				background: #2a2a35;
				padding: 4px 10px;
				border-radius: 6px;
				font-weight: 600;
				border: 1px solid #3a3a44;
				flex-shrink: 0;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				max-width: 200px;
			}
			.turn-tokens {
				font-size: 12px;
				color: #94a3b8;
				font-weight: 600;
				flex-shrink: 0;
				white-space: nowrap;
			}
			.context-badge {
				font-size: 12px;
				color: #e0e7ff;
				background: linear-gradient(135deg, #4c1d95 0%, #5b21b6 100%);
				padding: 4px 10px;
				border-radius: 6px;
				font-weight: 600;
				border: 1px solid #6d28d9;
				flex-shrink: 0;
				white-space: nowrap;
				margin-left: 4px;
				box-shadow: 0 2px 4px rgba(0,0,0,0.2);
			}
			
			/* Messages */
			.turn-content {
				padding: 16px;
			}
			.message {
				margin-bottom: 14px;
			}
			.message:last-child {
				margin-bottom: 0;
			}
			.message-label {
				font-size: 12px;
				font-weight: 700;
				color: #94a3b8;
				margin-bottom: 6px;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.message-text {
				background: #22222a;
				border-radius: 8px;
				padding: 14px 16px;
				font-size: 14px;
				line-height: 1.6;
				white-space: pre-wrap;
				word-break: break-word;
				max-height: 400px;
				overflow-y: auto;
				border: 1px solid #3a3a44;
			}
			.user-message .message-text {
				border-left: 4px solid #60a5fa;
				background: linear-gradient(135deg, #1e293b 0%, #22222a 100%);
			}
			.assistant-message .message-text {
				border-left: 4px solid #7c3aed;
				background: linear-gradient(135deg, #1e1e2a 0%, #22222a 100%);
			}
			
			/* Shared collapse arrow for details/summary panels */
			.collapse-arrow {
				display: inline-block;
				width: 16px;
				color: #94a3b8;
				font-size: 10px;
				transition: transform 0.2s;
				flex-shrink: 0;
			}
			details[open] > summary .collapse-arrow {
				transform: rotate(90deg);
			}
		
			/* Tool calls */
			.turn-tools {
				margin-bottom: 14px;
				background: linear-gradient(135deg, #2a2a35 0%, #25252f 100%);
				border: 1px solid #3a3a44;
				border-radius: 8px;
				padding: 12px 14px;
				box-shadow: 0 2px 8px rgba(0,0,0,0.2);
			}
			.tool-calls-details {
				cursor: pointer;
				margin: 0;
				padding: 0;
			}
			.tool-calls-summary {
				list-style: none;
				cursor: pointer;
				user-select: none;
				display: flex;
				align-items: center;
				gap: 10px;
				padding: 2px 0;
				padding-inline-start: 0;
				margin: 0;
			}
			.tool-calls-summary::-webkit-details-marker {
				display: none;
			}
			.tool-calls-summary::marker {
				display: none;
			}
			.tool-calls-summary:hover {
				color: #fff;
			}
			.tools-header-inline {
				font-size: 13px;
				font-weight: 700;
				color: #fff;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.tool-summary-text {
				font-size: 12px;
				font-weight: 600;
				color: #c084fc;
				flex: 1;
				display: flex;
				flex-wrap: wrap;
				gap: 8px;
				align-items: center;
			}
			.tool-summary-item {
				background: rgba(192, 132, 252, 0.1);
				border: 1px solid rgba(192, 132, 252, 0.3);
				padding: 2px 8px;
				border-radius: 4px;
				white-space: nowrap;
			}
			.tool-summary-item strong {
				color: #e9d5ff;
				font-weight: 700;
			}
			.tools-header {
				font-size: 13px;
				font-weight: 700;
				color: #fff;
				margin-bottom: 10px;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.tools-table {
				width: 100%;
				border-collapse: collapse;
				font-size: 13px;
				margin-top: 10px;
			}
			.tools-table thead th {
				text-align: left;
				padding: 8px 12px;
				background: #1a1a22;
				border-bottom: 2px solid #4a4a5a;
				color: #94a3b8;
				font-weight: 600;
				font-size: 12px;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.tools-table thead th:nth-child(2) {
				text-align: right;
			}
			.tools-table tbody .tool-row {
				border-bottom: 1px solid #3a3a44;
			}
			.tools-table tbody .tool-row:last-child {
				border-bottom: none;
			}
			.tool-name-cell {
				padding: 10px 12px;
				vertical-align: top;
			}
			.tool-action-cell {
				padding: 10px 12px;
				text-align: right;
				vertical-align: top;
				width: 100px;
			}
			.tool-name {
				font-weight: 700;
				color: #c084fc;
				font-size: 13px;
			}
			.tool-call-pretty {
				font-weight: 700;
				color: #34d399;
				font-size: 12px;
				text-decoration: underline;
				white-space: nowrap;
			}
			.tool-call-pretty:hover {
				color: #6ee7b7;
			}
			.tool-details {
				margin-top: 8px;
				font-size: 12px;
			}
			.tool-details summary {
				cursor: pointer;
				color: #94a3b8;
				font-weight: 600;
			}
			.tool-details summary:hover {
				color: #cbd5e1;
			}
			.tool-details pre {
				background: #1a1a20;
				border: 1px solid #2a2a30;
				padding: 10px;
				border-radius: 6px;
				overflow-x: auto;
				max-height: 200px;
				font-size: 11px;
				margin-top: 6px;
				line-height: 1.5;
			}
			
			/* MCP tools */
			.turn-mcp {
				margin-bottom: 14px;
				background: linear-gradient(135deg, #1e2e1e 0%, #1a261a 100%);
				border: 1px solid #3a5a3a;
				border-radius: 8px;
				padding: 14px;
				box-shadow: 0 2px 8px rgba(0,0,0,0.2);
			}
			.mcp-header {
				font-size: 13px;
				font-weight: 700;
				color: #fff;
				margin-bottom: 10px;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.mcp-list {
				display: flex;
				flex-wrap: wrap;
				gap: 6px;
			}
			.mcp-item {
				background: rgba(34, 197, 94, 0.1);
				border: 1px solid rgba(34, 197, 94, 0.3);
				padding: 4px 10px;
				border-radius: 4px;
				font-size: 12px;
				color: #cbd5e1;
			}
			.mcp-server {
				font-weight: 600;
				color: #22c55e;
			}
			
			/* Context References */
			.turn-context-details {
				margin-bottom: 14px;
				background: linear-gradient(135deg, #2a2535 0%, #252530 100%);
				border: 1px solid #4a4a5a;
				border-radius: 8px;
				padding: 14px;
				box-shadow: 0 2px 8px rgba(0,0,0,0.2);
			}
			.context-header {
				font-size: 13px;
				font-weight: 700;
				color: #fff;
				margin-bottom: 10px;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.context-section {
				font-size: 13px;
				color: #cbd5e1;
				margin-bottom: 8px;
				line-height: 1.6;
			}
			.context-section:last-child {
				margin-bottom: 0;
			}
			.context-section strong {
				color: #94a3b8;
				font-weight: 600;
			}
			.context-path {
				padding-left: 10px;
				color: #9ca3af;
				font-size: 12px;
				margin-top: 4px;
			}
			
			/* Empty state */
			.empty-state {
				text-align: center;
				padding: 60px 20px;
				color: #94a3b8;
				font-size: 16px;
				background: linear-gradient(135deg, #1a1a22 0%, #1f1f28 100%);
				border: 1px solid #3a3a44;
				border-radius: 12px;
				box-shadow: 0 4px 12px rgba(0,0,0,0.3);
			}

			/* Scrollbar styling */
			::-webkit-scrollbar {
				width: 10px;
				height: 10px;
			}
			::-webkit-scrollbar-track {
				background: #1a1a22;
			}
			::-webkit-scrollbar-thumb {
				background: #3a3a44;
				border-radius: 5px;
			}
			::-webkit-scrollbar-thumb:hover {
				background: #4a4a54;
			}
			}
			
			/* Context References */
			.turn-context-refs {
				margin-bottom: 14px;
				background: linear-gradient(135deg, #2a2535 0%, #252530 100%);
				border: 1px solid #4a4a5a;
				border-radius: 8px;
				padding: 12px 14px;
				box-shadow: 0 2px 8px rgba(0,0,0,0.2);
			}
			.context-refs-details {
				cursor: pointer;
				margin: 0;
				padding: 0;
			}
			.context-refs-summary {
				list-style: none;
				cursor: pointer;
				user-select: none;
				display: flex;
				align-items: center;
				gap: 10px;
				padding: 2px 0;
				padding-inline-start: 0;
				margin: 0;
			}
			.context-refs-summary::-webkit-details-marker {
				display: none;
			}
			.context-refs-summary::marker {
				display: none;
			}
			.context-refs-summary:hover {
				color: #fff;
			}
			.context-refs-header-inline {
				font-size: 13px;
				font-weight: 700;
				color: #fff;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.context-ref-summary-text {
				font-size: 12px;
				font-weight: 600;
				color: #22d3ee;
				flex: 1;
				display: flex;
				flex-wrap: wrap;
				gap: 8px;
				align-items: center;
			}
			.context-ref-item {
				background: rgba(34, 211, 238, 0.1);
				border: 1px solid rgba(34, 211, 238, 0.3);
				padding: 2px 8px;
				border-radius: 4px;
				white-space: nowrap;
			}
			.context-ref-item strong {
				color: #a5f3fc;
				font-weight: 700;
			}
			.context-ref-implicit {
				background: rgba(148, 163, 184, 0.1);
				border: 1px solid rgba(148, 163, 184, 0.3);
				color: #94a3b8;
			}
			.context-ref-implicit strong {
				color: #cbd5e1;
			}
			.context-refs-content {
				margin-top: 12px;
				padding-top: 12px;
				border-top: 1px solid rgba(255,255,255,0.1);
			}
			.mcp-item {
				background: #243024;
				padding: 4px 8px;
				border-radius: 4px;
				font-size: 11px;
			}
			.mcp-server {
				color: #10b981;
				font-weight: 600;
			}
			
			/* Footer */
			.footer {
				margin-top: 16px;
				padding-top: 12px;
				border-top: 1px solid #2a2a30;
				font-size: 11px;
				color: #666;
			}
			
			/* Empty state */
			.empty-state {
				text-align: center;
				padding: 40px 20px;
				color: #888;
			}
		</style>
		
		<div class="container">
			<div class="summary-cards">
				<div class="summary-card">
					<div class="summary-label">📝 Interactions</div>
					<div class="summary-value">${data.interactions}</div>
					<div class="summary-sub">Total chat turns in this session</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">📊 Total Tokens</div>
					<div class="summary-value">${totalTokens.toLocaleString()}</div>
					<div class="summary-sub">Input + Output tokens across all turns</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">🔧 Tool Calls</div>
					<div class="summary-value">${usageToolTotal}</div>
					<div class="summary-sub">${formatTopListWithOther(usageTopTools, usageToolTotal, lookupToolName)}</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">🔌 MCP Tools</div>
					<div class="summary-value">${usageMcpTotal}</div>
					<div class="summary-sub">${formatTopListWithOther(usageTopMcpTools, usageMcpTotal)}</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">🔗 Context Refs</div>
					<div class="summary-value">${usageContextTotal}</div>
				<div class="summary-sub">
				${usageContextTotal === 0 ? 'None' : ''}
				${usageContextRefs.file > 0 ? `<div>#file ${usageContextRefs.file}</div>` : ''}
				${usageContextRefs.implicitSelection > 0 ? `<div>implicit ${usageContextRefs.implicitSelection}</div>` : ''}
				${usageContextRefs.copilotInstructions > 0 ? `<div>📋 instructions ${usageContextRefs.copilotInstructions}</div>` : ''}
				${usageContextRefs.agentsMd > 0 ? `<div>🤖 agents ${usageContextRefs.agentsMd}</div>` : ''}
				${usageContextRefs.workspace > 0 ? `<div>@workspace ${usageContextRefs.workspace}</div>` : ''}
				${usageContextRefs.vscode > 0 ? `<div>@vscode ${usageContextRefs.vscode}</div>` : ''}
				</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">📁 File Name</div>
					<div class="summary-value" style="font-size: 16px;"><span class="filename-link" id="open-file-link">${escapeHtml(getFileName(data.file))}</span></div>
					<div class="summary-sub">Click to open in editor</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">💻 Editor</div>
					<div class="summary-value" style="font-size: 20px;">${escapeHtml(data.editorName)}</div>
					<div class="summary-sub">Source editor</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">📦 File Size</div>
					<div class="summary-value">${formatFileSize(data.size)}</div>
					<div class="summary-sub">Total size on disk</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">🕒 Modified</div>
					<div class="summary-value" style="font-size: 14px;">${formatDate(data.modified)}</div>
					<div class="summary-sub">Last file modification</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">▶️ First Interaction</div>
					<div class="summary-value" style="font-size: 14px;">${formatDate(data.firstInteraction)}</div>
					<div class="summary-sub">Session started</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">⏹️ Last Interaction</div>
					<div class="summary-value" style="font-size: 14px;">${formatDate(data.lastInteraction)}</div>
					<div class="summary-sub">Most recent activity</div>
				</div>
			</div>
			
			<div class="turns-header">
				<span>📝</span>
				<span>Chat Turns (${data.turns.length})</span>
			</div>
			
			<div class="turns-list">
				${data.turns.length > 0 
					? data.turns.map(turn => renderTurnCard(turn)).join('')
					: '<div class="empty-state">No chat turns found in this session.</div>'
				}
			</div>
			

		</div>
	`;
	
	// Wire up event handlers
	document.getElementById('btn-raw')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'openRawFile' });
	});
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDiagnostics' });
	});
	document.getElementById('btn-usage')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showUsageAnalysis' });
	});
	document.getElementById('btn-details')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'showDetails' });
	});
	document.getElementById('file-link')?.addEventListener('click', (e) => {
		e.preventDefault();
		vscode.postMessage({ command: 'openRawFile' });
	});
	document.getElementById('open-file-link')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'openRawFile' });
	});

	// Wire tool call clicks after DOM render so listeners bind correctly
	document.querySelectorAll('.tool-call-link').forEach(link => {
		link.addEventListener('click', (e) => {
			e.preventDefault();
			const turnNumber = parseInt(link.getAttribute('data-turn') || '0', 10);
			const toolCallIdx = parseInt(link.getAttribute('data-toolcall') || '0', 10);
			vscode.postMessage({ command: 'revealToolCallSource', turnNumber, toolCallIdx });
		});
	});

	// Pretty JSON view for a single tool call
	document.querySelectorAll('.tool-call-pretty').forEach(link => {
		link.addEventListener('click', (e) => {
			e.preventDefault();
			const turnNumber = parseInt(link.getAttribute('data-turn') || '0', 10);
			const toolCallIdx = parseInt(link.getAttribute('data-toolcall') || '0', 10);
			vscode.postMessage({ command: 'showToolCallPretty', turnNumber, toolCallIdx });
		});
	});

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
