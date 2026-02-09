// Log Viewer webview - displays session file details and chat turns
import { ContextReferenceUsage, getTotalContextRefs, getImplicitContextRefs, getExplicitContextRefs, getContextRefsSummary } from '../shared/contextRefUtils';
// CSS imported as text via esbuild
import styles from './styles.css';

type PromptTokenDetail = {
	category: string;
	label: string;
	percentageOfPrompt: number;
};

type ActualUsage = {
	completionTokens: number;
	promptTokens: number;
	promptTokenDetails?: PromptTokenDetail[];
	details?: string;
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
	actualUsage?: ActualUsage;
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

function getContextRefBadges(refs: ContextReferenceUsage): string {
	const badges: string[] = [];
	if (refs.selection > 0) { badges.push(`<span class="context-ref-item">#selection: <strong>${refs.selection}</strong></span>`); }
	if (refs.file > 0) { badges.push(`<span class="context-ref-item">#file: <strong>${refs.file}</strong></span>`); }
	if (refs.symbol > 0) { badges.push(`<span class="context-ref-item">#symbol: <strong>${refs.symbol}</strong></span>`); }
	if (refs.codebase > 0) { badges.push(`<span class="context-ref-item">#codebase: <strong>${refs.codebase}</strong></span>`); }
	if (refs.workspace > 0) { badges.push(`<span class="context-ref-item">@workspace: <strong>${refs.workspace}</strong></span>`); }
	if (refs.terminal > 0) { badges.push(`<span class="context-ref-item">@terminal: <strong>${refs.terminal}</strong></span>`); }
	if (refs.vscode > 0) { badges.push(`<span class="context-ref-item">@vscode: <strong>${refs.vscode}</strong></span>`); }
	if ((refs.terminalLastCommand || 0) > 0) { badges.push(`<span class="context-ref-item">#terminalLastCommand: <strong>${refs.terminalLastCommand}</strong></span>`); }
	if ((refs.terminalSelection || 0) > 0) { badges.push(`<span class="context-ref-item">#terminalSelection: <strong>${refs.terminalSelection}</strong></span>`); }
	if ((refs.clipboard || 0) > 0) { badges.push(`<span class="context-ref-item">#clipboard: <strong>${refs.clipboard}</strong></span>`); }
	if ((refs.changes || 0) > 0) { badges.push(`<span class="context-ref-item">#changes: <strong>${refs.changes}</strong></span>`); }
	if ((refs.outputPanel || 0) > 0) { badges.push(`<span class="context-ref-item">#outputPanel: <strong>${refs.outputPanel}</strong></span>`); }
	if ((refs.problemsPanel || 0) > 0) { badges.push(`<span class="context-ref-item">#problemsPanel: <strong>${refs.problemsPanel}</strong></span>`); }
	if (refs.implicitSelection > 0) { badges.push(`<span class="context-ref-item context-ref-implicit">implicit: <strong>${refs.implicitSelection}</strong></span>`); }
	return badges.join('');
}

function renderContextReferencesDetailed(refs: ContextReferenceUsage): string {
	const rows: { category: string; name: string; count: number; type: 'implicit' | 'explicit' }[] = [];
	
	// Implicit selections (implicit)
	if (refs.implicitSelection > 0) {
		rows.push({ category: '📝 Selection', name: 'editor selection', count: refs.implicitSelection, type: 'implicit' });
	}
	
	// File paths and symbols from byPath
	if (refs.byPath && Object.keys(refs.byPath).length > 0) {
		Object.entries(refs.byPath).forEach(([path, count]) => {
			if (path.startsWith('#sym:')) {
				// Symbols are explicit user references
				rows.push({ category: '🔣 Symbol', name: path.substring(5), count, type: 'explicit' });
			} else {
				// Check if this is an instruction file (implicit) or regular file (explicit)
				const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
				const isInstructionFile = normalizedPath.includes('copilot-instructions.md') || 
				                          normalizedPath.endsWith('.instructions.md') ||
				                          normalizedPath.endsWith('/agents.md');
				if (isInstructionFile) {
					rows.push({ category: '📋 Instructions', name: getFileName(path), count, type: 'implicit' });
				} else {
					// Regular file references are explicit
					rows.push({ category: '📁 File', name: getFileName(path), count, type: 'explicit' });
				}
			}
		});
	}
	
	// Instruction counters that aren't in byPath (fallback)
	// Only show if we haven't already added instruction files from byPath
	const hasInstructionFiles = rows.some(r => r.category === '📋 Instructions');
	if (!hasInstructionFiles) {
		if (refs.copilotInstructions > 0) {
			rows.push({ category: '📋 Instructions', name: 'copilot-instructions', count: refs.copilotInstructions, type: 'implicit' });
		}
		if (refs.agentsMd > 0) {
			rows.push({ category: '🤖 Agents', name: 'agents.md', count: refs.agentsMd, type: 'implicit' });
		}
	}
	
	// Explicit @ references
	if (refs.workspace > 0) {
		rows.push({ category: '🌐 Workspace', name: '@workspace', count: refs.workspace, type: 'explicit' });
	}
	if (refs.terminal > 0) {
		rows.push({ category: '💻 Terminal', name: '@terminal', count: refs.terminal, type: 'explicit' });
	}
	if (refs.vscode > 0) {
		rows.push({ category: '⚙️ VS Code', name: '@vscode', count: refs.vscode, type: 'explicit' });
	}
	if (refs.codebase > 0) {
		rows.push({ category: '📚 Codebase', name: '#codebase', count: refs.codebase, type: 'explicit' });
	}
	if (refs.selection > 0) {
		rows.push({ category: '✂️ Selection', name: '#selection', count: refs.selection, type: 'explicit' });
	}
	
	if (rows.length === 0) {
		return '<div class="context-section">No context references</div>';
	}
	
	// Build table
	const tableRows = rows.map(row => {
		const typeClass = row.type === 'implicit' ? 'context-type-implicit' : 'context-type-explicit';
		const typeLabel = row.type === 'implicit' ? '🔒 implicit' : '👤 explicit';
		return `<tr>
			<td>${row.category}</td>
			<td>${escapeHtml(row.name)}</td>
			<td class="count-cell">${row.count}</td>
			<td class="${typeClass}">${typeLabel}</td>
		</tr>`;
	}).join('');
	
	return `
		<table class="context-refs-table">
			<thead>
				<tr>
					<th>Category</th>
					<th>Reference</th>
					<th>Count</th>
					<th>Type</th>
				</tr>
			</thead>
			<tbody>
				${tableRows}
			</tbody>
		</table>
	`;
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
	const hasActualUsage = !!turn.actualUsage;
	
	// Build actual usage section
	let actualUsageHtml = '';
	if (hasActualUsage && turn.actualUsage) {
		const au = turn.actualUsage;
		const actualTotal = au.promptTokens + au.completionTokens;
		const estimatedTotal = totalTokens;
		const deltaTotal = actualTotal - estimatedTotal;
		const deltaInput = au.promptTokens - turn.inputTokensEstimate;
		const deltaOutput = au.completionTokens - turn.outputTokensEstimate;
		const deltaSign = (n: number) => n > 0 ? '+' : '';
		const deltaClass = (n: number) => n > 0 ? 'delta-over' : n < 0 ? 'delta-under' : 'delta-zero';
		
		// Build prompt breakdown rows
		let promptBreakdownHtml = '';
		if (au.promptTokenDetails && au.promptTokenDetails.length > 0) {
			const breakdownRows = au.promptTokenDetails.map(detail => {
				const deducedTokens = Math.round(au.promptTokens * detail.percentageOfPrompt / 100);
				const barWidth = Math.min(detail.percentageOfPrompt, 100);
				const categoryClass = detail.category === 'System' ? 'category-system' : 'category-user';
				return `<tr>
					<td><span class="${categoryClass}">${escapeHtml(detail.category)}</span></td>
					<td>${escapeHtml(detail.label)}</td>
					<td class="count-cell">${detail.percentageOfPrompt}%</td>
					<td class="count-cell">${deducedTokens.toLocaleString()}</td>
					<td><div class="bar-cell"><div class="bar-fill ${categoryClass}-bar" style="width: ${barWidth}%"></div></div></td>
				</tr>`;
			}).join('');
			
			// Calculate system vs user totals
			const systemPct = au.promptTokenDetails.filter(d => d.category === 'System').reduce((s, d) => s + d.percentageOfPrompt, 0);
			const userPct = au.promptTokenDetails.filter(d => d.category !== 'System').reduce((s, d) => s + d.percentageOfPrompt, 0);
			const systemTokens = Math.round(au.promptTokens * systemPct / 100);
			const userTokens = Math.round(au.promptTokens * userPct / 100);
			
			promptBreakdownHtml = `
				<div class="prompt-breakdown">
					<div class="breakdown-summary">
						<span class="category-system">System: ${systemPct}% (~${systemTokens.toLocaleString()} tokens)</span>
						<span class="category-user">User Context: ${userPct}% (~${userTokens.toLocaleString()} tokens)</span>
					</div>
					<table class="prompt-breakdown-table">
						<thead>
							<tr>
								<th>Category</th>
								<th>Label</th>
								<th>%</th>
								<th>~Tokens</th>
								<th>Distribution</th>
							</tr>
						</thead>
						<tbody>
							${breakdownRows}
						</tbody>
					</table>
				</div>
			`;
		}
		
		actualUsageHtml = `
			<div class="turn-actual-usage">
				<details class="actual-usage-details">
					<summary class="actual-usage-summary">
						<span class="collapse-arrow">▶</span>
						<span class="actual-usage-header-inline">📊 ACTUAL LLM USAGE</span>
						<span class="actual-usage-summary-text">
							<span class="usage-badge">↑${au.promptTokens.toLocaleString()}</span>
							<span class="usage-badge">↓${au.completionTokens.toLocaleString()}</span>
							<span class="usage-badge usage-total">Σ${actualTotal.toLocaleString()}</span>
							<span class="usage-badge ${deltaClass(deltaTotal)}">delta: ${deltaSign(deltaTotal)}${deltaTotal.toLocaleString()}</span>
							${au.details ? `<span class="usage-badge usage-model-info">${escapeHtml(au.details)}</span>` : ''}
						</span>
					</summary>
					<div class="actual-usage-content">
						<table class="usage-comparison-table">
							<thead>
								<tr>
									<th>Metric</th>
									<th>Estimated</th>
									<th>Actual</th>
									<th>Delta</th>
									<th>Ratio</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>↑ Prompt / Input</td>
									<td class="count-cell">${turn.inputTokensEstimate.toLocaleString()}</td>
									<td class="count-cell">${au.promptTokens.toLocaleString()}</td>
									<td class="count-cell ${deltaClass(deltaInput)}">${deltaSign(deltaInput)}${deltaInput.toLocaleString()}</td>
									<td class="count-cell">${turn.inputTokensEstimate > 0 ? (au.promptTokens / turn.inputTokensEstimate).toFixed(1) + 'x' : 'N/A'}</td>
								</tr>
								<tr>
									<td>↓ Completion / Output</td>
									<td class="count-cell">${turn.outputTokensEstimate.toLocaleString()}</td>
									<td class="count-cell">${au.completionTokens.toLocaleString()}</td>
									<td class="count-cell ${deltaClass(deltaOutput)}">${deltaSign(deltaOutput)}${deltaOutput.toLocaleString()}</td>
									<td class="count-cell">${turn.outputTokensEstimate > 0 ? (au.completionTokens / turn.outputTokensEstimate).toFixed(1) + 'x' : 'N/A'}</td>
								</tr>
								<tr class="usage-total-row">
									<td><strong>Σ Total</strong></td>
									<td class="count-cell"><strong>${estimatedTotal.toLocaleString()}</strong></td>
									<td class="count-cell"><strong>${actualTotal.toLocaleString()}</strong></td>
									<td class="count-cell ${deltaClass(deltaTotal)}"><strong>${deltaSign(deltaTotal)}${deltaTotal.toLocaleString()}</strong></td>
									<td class="count-cell"><strong>${estimatedTotal > 0 ? (actualTotal / estimatedTotal).toFixed(1) + 'x' : 'N/A'}</strong></td>
								</tr>
							</tbody>
						</table>
						${promptBreakdownHtml}
					</div>
				</details>
			</div>
		`;
	}
	
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
			// Check if this is a symbol reference
			if (path.startsWith('#sym:')) {
				const symbolName = path.substring(5); // Remove '#sym:' prefix
				contextFileBadges.push(`<span class="context-badge" title="Symbol: ${escapeHtml(symbolName)}">🔤 ${escapeHtml(symbolName)}</span>`);
			} else {
				contextFileBadges.push(`<span class="context-badge" title="${escapeHtml(path)}">📄 ${escapeHtml(getFileName(path))}</span>`);
			}
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
					<span class="turn-tokens">📊 ${totalTokens.toLocaleString()} est.${hasActualUsage ? ` | ${(turn.actualUsage!.promptTokens + turn.actualUsage!.completionTokens).toLocaleString()} actual` : ''}</span>
					${contextHeaderHtml}
				</div>
				<div class="turn-time">${formatDate(turn.timestamp)}</div>
			</div>
			
			${toolCallsHtml}
			${mcpToolsHtml}
			${contextRefsHtml}
			${actualUsageHtml}
			
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
	const usageContextImplicit = getImplicitContextRefs(usageContextRefs);
	const usageContextExplicit = getExplicitContextRefs(usageContextRefs);

	// Calculate actual usage totals across all turns
	const turnsWithActual = data.turns.filter(t => t.actualUsage);
	const hasAnyActualUsage = turnsWithActual.length > 0;
	const actualPromptTotal = turnsWithActual.reduce((s, t) => s + (t.actualUsage?.promptTokens || 0), 0);
	const actualCompletionTotal = turnsWithActual.reduce((s, t) => s + (t.actualUsage?.completionTokens || 0), 0);
	const actualTotal = actualPromptTotal + actualCompletionTotal;
	
	// Aggregate prompt breakdown across all turns
	const aggregatedBreakdown: { [key: string]: { category: string; label: string; totalTokens: number; totalPct: number; count: number } } = {};
	for (const turn of turnsWithActual) {
		if (turn.actualUsage?.promptTokenDetails) {
			for (const detail of turn.actualUsage.promptTokenDetails) {
				const key = `${detail.category}|${detail.label}`;
				if (!aggregatedBreakdown[key]) {
					aggregatedBreakdown[key] = { category: detail.category, label: detail.label, totalTokens: 0, totalPct: 0, count: 0 };
				}
				const deducedTokens = Math.round((turn.actualUsage?.promptTokens || 0) * detail.percentageOfPrompt / 100);
				aggregatedBreakdown[key].totalTokens += deducedTokens;
				aggregatedBreakdown[key].totalPct += detail.percentageOfPrompt;
				aggregatedBreakdown[key].count++;
			}
		}
	}

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
		<style>${styles}</style>
		
		<div class="container">
			<div class="summary-cards">
				<div class="summary-card">
					<div class="summary-label">📝 Interactions</div>
					<div class="summary-value">${data.interactions}</div>
					<div class="summary-sub">Total chat turns in this session</div>
				</div>
				<div class="summary-card">
					<div class="summary-label">📊 Estimated Tokens</div>
					<div class="summary-value">${totalTokens.toLocaleString()}</div>
					<div class="summary-sub">Input + Output estimated from text</div>
				</div>
				${hasAnyActualUsage ? `
				<div class="summary-card actual-usage-card">
					<div class="summary-label">📊 Actual Tokens</div>
					<div class="summary-value">${actualTotal.toLocaleString()}</div>
					<div class="summary-sub">↑${actualPromptTotal.toLocaleString()} prompt, ↓${actualCompletionTotal.toLocaleString()} completion</div>
				</div>
				` : ''}
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
				${usageContextTotal === 0 ? 'None' : `implicit ${usageContextImplicit}, explicit ${usageContextExplicit}`}
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
			
			${hasAnyActualUsage ? (() => {
				const breakdownEntries = Object.values(aggregatedBreakdown).sort((a, b) => b.totalTokens - a.totalTokens);
				const avgPct = (entry: { totalPct: number; count: number }) => Math.round(entry.totalPct / entry.count);
				const breakdownRows = breakdownEntries.map(entry => {
					const pct = avgPct(entry);
					const categoryClass = entry.category === 'System' ? 'category-system' : 'category-user';
					return `<tr>
						<td><span class="${categoryClass}">${escapeHtml(entry.category)}</span></td>
						<td>${escapeHtml(entry.label)}</td>
						<td class="count-cell">${pct}%</td>
						<td class="count-cell">${entry.totalTokens.toLocaleString()}</td>
						<td><div class="bar-cell"><div class="bar-fill ${categoryClass}-bar" style="width: ${Math.min(pct, 100)}%"></div></div></td>
					</tr>`;
				}).join('');
				
				const systemTokens = breakdownEntries.filter(e => e.category === 'System').reduce((s, e) => s + e.totalTokens, 0);
				const userTokens = breakdownEntries.filter(e => e.category !== 'System').reduce((s, e) => s + e.totalTokens, 0);
				const estimateRatio = totalTokens > 0 ? (actualTotal / totalTokens).toFixed(1) : 'N/A';
				
				return `
			<div class="session-actual-usage">
				<div class="session-usage-header">📊 Session Actual LLM Usage (${turnsWithActual.length}/${data.turns.length} turns with data)</div>
				<div class="session-usage-grid">
					<div class="session-usage-comparison">
						<table class="usage-comparison-table">
							<thead><tr><th>Metric</th><th>Estimated</th><th>Actual</th><th>Ratio</th></tr></thead>
							<tbody>
								<tr><td>↑ Prompt</td><td class="count-cell">${data.turns.reduce((s,t) => s + t.inputTokensEstimate, 0).toLocaleString()}</td><td class="count-cell">${actualPromptTotal.toLocaleString()}</td><td class="count-cell">${data.turns.reduce((s,t) => s + t.inputTokensEstimate, 0) > 0 ? (actualPromptTotal / data.turns.reduce((s,t) => s + t.inputTokensEstimate, 0)).toFixed(1) + 'x' : 'N/A'}</td></tr>
								<tr><td>↓ Completion</td><td class="count-cell">${data.turns.reduce((s,t) => s + t.outputTokensEstimate, 0).toLocaleString()}</td><td class="count-cell">${actualCompletionTotal.toLocaleString()}</td><td class="count-cell">${data.turns.reduce((s,t) => s + t.outputTokensEstimate, 0) > 0 ? (actualCompletionTotal / data.turns.reduce((s,t) => s + t.outputTokensEstimate, 0)).toFixed(1) + 'x' : 'N/A'}</td></tr>
								<tr class="usage-total-row"><td><strong>Σ Total</strong></td><td class="count-cell"><strong>${totalTokens.toLocaleString()}</strong></td><td class="count-cell"><strong>${actualTotal.toLocaleString()}</strong></td><td class="count-cell"><strong>${estimateRatio}x</strong></td></tr>
							</tbody>
						</table>
					</div>
					<div class="session-usage-breakdown">
						<div class="breakdown-summary">
							<span class="category-system">System: ~${systemTokens.toLocaleString()} tokens</span>
							<span class="category-user">User Context: ~${userTokens.toLocaleString()} tokens</span>
						</div>
						<table class="prompt-breakdown-table">
							<thead><tr><th>Category</th><th>Label</th><th>Avg %</th><th>Total ~Tokens</th><th>Distribution</th></tr></thead>
							<tbody>${breakdownRows}</tbody>
						</table>
					</div>
				</div>
			</div>
			`;
			})() : ''}
			
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
