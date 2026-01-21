// Log Viewer webview - displays session file details and chat turns
type ContextReferenceUsage = {
	file: number;
	selection: number;
	symbol: number;
	codebase: number;
	workspace: number;
	terminal: number;
	vscode: number;
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
	return refs.file + refs.selection + refs.symbol + refs.codebase +
		refs.workspace + refs.terminal + refs.vscode;
}

function getContextRefsSummary(refs: ContextReferenceUsage): string {
	const parts: string[] = [];
	if (refs.file > 0) { parts.push(`#file: ${refs.file}`); }
	if (refs.selection > 0) { parts.push(`#selection: ${refs.selection}`); }
	if (refs.symbol > 0) { parts.push(`#symbol: ${refs.symbol}`); }
	if (refs.codebase > 0) { parts.push(`#codebase: ${refs.codebase}`); }
	if (refs.workspace > 0) { parts.push(`@workspace: ${refs.workspace}`); }
	if (refs.terminal > 0) { parts.push(`@terminal: ${refs.terminal}`); }
	if (refs.vscode > 0) { parts.push(`@vscode: ${refs.vscode}`); }
	return parts.length > 0 ? parts.join(', ') : 'None';
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
	
	const toolCallsHtml = hasToolCalls ? `
		<div class="turn-tools">
			<div class="tools-header">🔧 Tool Calls (${turn.toolCalls.length})</div>
			<div class="tools-list">
				${turn.toolCalls.map(tc => `
					<div class="tool-item">
						<span class="tool-name" title="${escapeHtml(tc.toolName)}">${escapeHtml(lookupToolName(tc.toolName))}</span>
						${tc.arguments ? `<details class="tool-details"><summary>Arguments</summary><pre>${escapeHtml(tc.arguments)}</pre></details>` : ''}
						${tc.result ? `<details class="tool-details"><summary>Result</summary><pre>${escapeHtml(truncateText(tc.result, 500))}</pre></details>` : ''}
					</div>
				`).join('')}
			</div>
		</div>
	` : '';
	
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
	
	const contextRefsHtml = totalRefs > 0 ? `
		<div class="turn-context">
			<span class="context-label">🔗 Context:</span>
			<span class="context-value">${escapeHtml(getContextRefsSummary(turn.contextReferences))}</span>
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
				</div>
				<div class="turn-time">${formatDate(turn.timestamp)}</div>
			</div>
			
			<div class="turn-content">
				<div class="message user-message">
					<div class="message-label">👤 User</div>
					<div class="message-text">${escapeHtml(turn.userMessage) || '<em>No message</em>'}</div>
				</div>
				
				${contextRefsHtml}
				${toolCallsHtml}
				${mcpToolsHtml}
				
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
				<style>
					* { margin: 0; padding: 0; box-sizing: border-box; }
					body {
						font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
						background: #0e0e0f;
						color: #e7e7e7;
						padding: 16px;
						line-height: 1.5;
						min-width: 320px;
					}
					.container {
						background: linear-gradient(135deg, #1b1b1e 0%, #1f1f22 100%);
						border: 1px solid #2e2e34;
						border-radius: 10px;
						padding: 16px;
						box-shadow: 0 4px 10px rgba(0, 0, 0, 0.28);
						max-width: 1200px;
						margin: 0 auto;
					}
					.header {
						display: flex;
						justify-content: space-between;
						align-items: flex-start;
						gap: 12px;
						margin-bottom: 16px;
						padding-bottom: 12px;
						border-bottom: 1px solid #2e2e34;
					}
					.header-left { flex: 1; }
					.header-title {
						font-size: 20px;
						font-weight: 700;
						color: #fff;
						margin-bottom: 4px;
						display: flex;
						align-items: center;
						gap: 8px;
					}
					.header-subtitle {
						font-size: 13px;
						color: #3b82f6;
						font-weight: 500;
					}
					.button-row { display: flex; flex-wrap: wrap; gap: 8px; }
					.button-row vscode-button {
						transition: box-shadow 0.2s;
					}
					.button-row vscode-button:hover {
						box-shadow: 0 2px 8px #3b82f6;
					}

					/* Mode/model bar improvements */
					.mode-bar-group {
						background: #18181b;
						border: 1px solid #2a2a30;
						border-radius: 8px;
						padding: 12px 18px;
						display: flex;
						align-items: center;
						gap: 24px;
						margin-bottom: 18px;
						box-shadow: 0 2px 8px rgba(60,60,80,0.08);
					}
					.mode-bar {
						display: flex;
						align-items: center;
						gap: 8px;
						font-size: 14px;
						font-weight: 500;
					}
					.mode-icon {
						width: 28px;
						height: 28px;
						border-radius: 6px;
						display: flex;
						align-items: center;
						justify-content: center;
						font-size: 16px;
						background: #23232a;
						border: 1px solid #2a2a30;
					}
					.mode-label {
						color: #b0b0b0;
					}
					.mode-count {
						color: #fff;
						font-weight: 700;
					}
					.model-summary {
						margin-left: 16px;
						font-size: 14px;
						font-weight: 600;
						color: #fff;
						display: flex;
						align-items: center;
						gap: 10px;
					}
					.model-list {
						margin-left: 8px;
						font-size: 13px;
						color: #b0b0b0;
						font-weight: 500;
						display: flex;
						gap: 16px;
					}
					.model-item {
						background: #23232a;
						border-radius: 4px;
						padding: 2px 8px;
						color: #3b82f6;
						font-weight: 600;
						box-shadow: 0 1px 4px rgba(60,60,80,0.08);
					}

					/* Summary cards */
					.summary-cards {
						display: grid;
						grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
						gap: 14px;
						margin-bottom: 18px;
					}
					.summary-card {
						background: #18181b;
						border: 1px solid #2a2a30;
						border-radius: 8px;
						padding: 18px 10px 14px 10px;
						text-align: center;
						box-shadow: 0 2px 8px rgba(60,60,80,0.08);
					}
					.summary-label { font-size: 16px; color: #fff; margin-bottom: 4px; font-weight: 700; }
					.summary-value { font-size: 22px; font-weight: 700; color: #3b82f6; }

					/* ...existing code... */
				grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
				gap: 12px;
			<!-- Footer removed: file path no longer shown here -->
				border-radius: 8px;
				padding: 12px;
			}
			.info-item {
				display: flex;
				flex-direction: column;
			}
			.info-label {
				font-size: 10px;
				color: #888;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}
			.info-value {
				font-size: 14px;
				font-weight: 600;
				color: #fff;
			}
			.info-value.small {
				font-size: 12px;
				font-weight: 400;
			}
			
			/* Summary cards */
			.summary-cards {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
				gap: 10px;
				margin-bottom: 16px;
			}
			.summary-card {
				background: #18181b;
				border: 1px solid #2a2a30;
				border-radius: 6px;
				padding: 10px;
				text-align: center;
			}
			.summary-label { font-size: 10px; color: #999; margin-bottom: 2px; }
			.summary-value { font-size: 18px; font-weight: 700; color: #fff; }
			
			/* Mode bars */
			.mode-bars {
				display: flex;
				gap: 16px;
				margin-bottom: 16px;
				flex-wrap: wrap;
			}
			.mode-bar {
				display: flex;
				align-items: center;
				gap: 6px;
				font-size: 12px;
			}
			.mode-icon {
				width: 24px;
				height: 24px;
				border-radius: 4px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 14px;
			}
			
			/* Turns container */
			.turns-header {
				font-size: 14px;
				font-weight: 600;
				color: #fff;
				margin-bottom: 12px;
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.turns-list {
				display: flex;
				flex-direction: column;
				gap: 12px;
			}
			
			/* Turn card */
			.turn-card {
				background: #18181b;
				border: 1px solid #2a2a30;
				border-radius: 8px;
				overflow: hidden;
			}
			.turn-header {
				background: #1f1f24;
				padding: 10px 12px;
				display: flex;
				justify-content: space-between;
				align-items: center;
				flex-wrap: wrap;
				gap: 8px;
				border-bottom: 1px solid #2a2a30;
			}
			.turn-meta {
				display: flex;
				align-items: center;
				gap: 8px;
				flex-wrap: wrap;
			}
			.turn-number {
				font-weight: 700;
				color: #fff;
				font-size: 14px;
			}
			.turn-mode {
				padding: 2px 8px;
				border-radius: 12px;
				font-size: 11px;
				font-weight: 600;
				color: #fff;
			}
			.turn-model {
				font-size: 11px;
				color: #b0b0b0;
				background: #2a2a30;
				padding: 2px 6px;
				border-radius: 4px;
			}
			.turn-tokens {
				font-size: 11px;
				color: #888;
			}
			.turn-time {
				font-size: 11px;
				color: #666;
			}
			
			.turn-content {
				padding: 12px;
			}
			
			/* Messages */
			.message {
				margin-bottom: 12px;
			}
			.message:last-child {
				margin-bottom: 0;
			}
			.message-label {
				font-size: 11px;
				font-weight: 600;
				color: #888;
				margin-bottom: 4px;
			}
			.message-text {
				background: #242428;
				border-radius: 6px;
				padding: 10px 12px;
				font-size: 13px;
				white-space: pre-wrap;
				word-break: break-word;
				max-height: 400px;
				overflow-y: auto;
			}
			.user-message .message-text {
				border-left: 3px solid #3b82f6;
			}
			.assistant-message .message-text {
				border-left: 3px solid #10b981;
			}
			
			/* Context references */
			.turn-context {
				margin-bottom: 12px;
				padding: 8px 10px;
				background: #252530;
				border-radius: 4px;
				font-size: 12px;
			}
			.context-label {
				color: #888;
				margin-right: 6px;
			}
			.context-value {
				color: #c0c0c0;
			}
			
			/* Tool calls */
			.turn-tools {
				margin-bottom: 12px;
				background: #1e1e28;
				border: 1px solid #3a3a50;
				border-radius: 6px;
				padding: 10px;
			}
			.tools-header {
				font-size: 12px;
				font-weight: 600;
				color: #fff;
				margin-bottom: 8px;
			}
			.tools-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
			}
			.tool-item {
				background: #242430;
				border-radius: 4px;
				padding: 8px 10px;
			}
			.tool-name {
				font-weight: 600;
				color: #7c3aed;
				font-size: 12px;
			}
			.tool-details {
				margin-top: 6px;
				font-size: 11px;
			}
			.tool-details summary {
				cursor: pointer;
				color: #888;
			}
			.tool-details pre {
				background: #1a1a20;
				padding: 8px;
				border-radius: 4px;
				overflow-x: auto;
				max-height: 200px;
				font-size: 11px;
				margin-top: 4px;
			}
			
			/* MCP tools */
			.turn-mcp {
				margin-bottom: 12px;
				background: #1e281e;
				border: 1px solid #3a503a;
				border-radius: 6px;
				padding: 10px;
			}
			.mcp-header {
				font-size: 12px;
				font-weight: 600;
				color: #fff;
				margin-bottom: 8px;
			}
			.mcp-list {
				display: flex;
				flex-wrap: wrap;
				gap: 6px;
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
			<div class="header">
				<div class="header-left">
					<div class="header-title">
						<span>📜</span>
						<span>${data.title ? escapeHtml(data.title) : 'Session Log'}</span>
					</div>
					<div class="header-subtitle"><a id="file-link" href="#" style="color:#3b82f6;text-decoration:underline;">${escapeHtml(getFileName(data.file))}</a></div>
				</div>
				<div class="button-row">
					<vscode-button id="btn-raw">📄 View Raw</vscode-button>
					<vscode-button id="btn-diagnostics">🔍 Back to Files</vscode-button>
					<vscode-button id="btn-usage">📊 Usage Analysis</vscode-button>
				</div>
			</div>
			
			<div class="session-info" style="display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 18px;">
				<div class="info-item">
					<span class="info-label">Editor</span>
					<span class="info-value">${escapeHtml(data.editorName)}</span>
				</div>
				<div class="info-item">
					<span class="info-label">File Size</span>
					<span class="info-value">${formatFileSize(data.size)}</span>
				</div>
				<div class="info-item">
					<span class="info-label">Modified</span>
					<span class="info-value small">${formatDate(data.modified)}</span>
				</div>
				<div class="info-item">
					<span class="info-label">First Interaction</span>
					<span class="info-value small">${formatDate(data.firstInteraction)}</span>
				</div>
				<div class="info-item">
					<span class="info-label">Last Interaction</span>
					<span class="info-value small">${formatDate(data.lastInteraction)}</span>
				</div>
			</div>
			
			<div class="summary-cards">
				<div class="summary-card">
					<div class="summary-label">💬 Turns</div>
					<div class="summary-value">${data.turns.length}</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">📊 Est. Tokens</div>
					<div class="summary-value">${totalTokens.toLocaleString()}</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">🔧 Tool Calls</div>
					<div class="summary-value">${totalToolCalls}</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">🔌 MCP Tools</div>
					<div class="summary-value">${totalMcpTools}</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">🔗 Context Refs</div>
					<div class="summary-value">${totalRefs}</div>
				</div>
			</div>
			
				<div class="mode-bar-group">
					<div class="mode-bar">
						<div class="mode-icon" style="background: ${getModeColor('ask')};">💬</div>
						<span class="mode-label">Ask:</span>
						<span class="mode-count">${modeUsage.ask}</span>
					</div>
					<div class="mode-bar">
						<div class="mode-icon" style="background: ${getModeColor('edit')};">✏️</div>
						<span class="mode-label">Edit:</span>
						<span class="mode-count">${modeUsage.edit}</span>
					</div>
					<div class="mode-bar">
						<div class="mode-icon" style="background: ${getModeColor('agent')};">🤖</div>
						<span class="mode-label">Agent:</span>
						<span class="mode-count">${modeUsage.agent}</span>
					</div>
					<div class="model-summary">
						<span>Models used: <strong>${modelNames.length}</strong></span>
						${modelNames.length > 0 ? `<span class="model-list">${modelNames.map(m => `<span class="model-item">${escapeHtml(m)}: <strong>${modelUsage[m]}</strong></span>`).join('')}</span>` : ''}
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
