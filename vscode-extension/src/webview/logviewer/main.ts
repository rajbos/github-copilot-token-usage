// Log Viewer webview - displays session file details and chat turns
import { ContextReferenceUsage, getTotalContextRefs, getImplicitContextRefs, getExplicitContextRefs, getContextRefsSummary } from '../shared/contextRefUtils';
import { setHtml } from '../shared/domUtils';
import { escapeHtml, formatCompact, formatCost, formatFileSize, setCompactNumbers, getEditorIcon } from '../shared/formatUtils';
import { getModelDisplayName } from '../../../../src/webview/shared/modelUtils';
import type { McpToolUsage, ModeUsage, ToolCallUsage } from '../shared/types';
import { aggregateTokenStats, aggregateActualUsageStats, aggregateModeStats, buildSummaryStats, getEffortDisplayName, getModeIcon, getTopEntries, MODE_LABELS, type ActualUsageStats, type BreakdownEntry, type SummaryStats, type ThinkingEffortUsage } from './summaryStats';
import { buildTurnOverviewRows, hashModelToHue, type TurnOverviewRow } from './turnsOverview';
import { renderHydraFusionSection, renderLegsTable, formatFusionCost } from './hydraFusionSection';
import { buildMcpAndContextRefsCard, formatTopListWithOther, sumSessionCost } from './summaryCards';
import { matchHydraFusionTurnsToChatTurns } from '../../../../src/hydrafusion';
import type { HydraFusionSummary, HydraFusionTurn } from '../../../../src/hydrafusion';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import dataTableStyles from '../shared/dataTable.css';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import { localize, localizeFormat } from '../shared/localization';
import {
	getDataTableState,
	renderDataTable,
	rerenderDataTable,
	revealDataTableRow,
	setDataTableState,
	type DataTableCell,
	type DataTableColumn,
	type DataTableSort,
} from '../shared/dataTable';
import { applyWebviewLocale } from '../shared/webviewLocale';

// ── Type definitions ──────────────────────────────────────────────────────────

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

/** A single tool call entry recorded in a chat turn. */
type ToolCall = {
toolName: string;
arguments?: string;
result?: string;
isSubAgent?: boolean;
subAgentModel?: string;
subAgentTokens?: { input: number; output: number };
subAgentCost?: number;
};

type ChatTurn = {
turnNumber: number;
timestamp: string | null;
mode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent';
userMessage: string;
assistantResponse: string;
model: string | null;
toolCalls: ToolCall[];
contextReferences: ContextReferenceUsage;
mcpTools: { server: string; tool: string }[];
inputTokensEstimate: number;
outputTokensEstimate: number;
thinkingTokensEstimate: number;
actualUsage?: ActualUsage;
thinkingEffort?: string;
/** Estimated USD cost of this turn's own model call, computed host-side. Absent when unknown. */
estimatedCost?: number;
};

type SessionUsageAnalysis = {
toolCalls: ToolCallUsage;
modeUsage: ModeUsage;
contextReferences: ContextReferenceUsage;
mcpTools: McpToolUsage;
thinkingEffort?: ThinkingEffortUsage;
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
/** Session-level actual token count from LLM API (e.g. CLI session.shutdown). 0 when unavailable. */
actualTokens?: number;
/** Cache-read token count from session.shutdown modelMetrics (CLI sessions only). Absent when unavailable. */
cachedTokens?: number;
/** Number of subagent sessions started (CLI format only). */
subAgentsStarted?: number;
/** Parent session info (Copilot CLI sessions only, from data.db hierarchy). */
parentInfo?: { uuid: string; name: string; sessionFile?: string } | null;
/** Direct child sessions (Copilot CLI sessions only, from data.db hierarchy). */
childInfo?: Array<{ uuid: string; name: string; sessionFile?: string }>;
/** Total child count from data.db (may exceed childInfo.length). */
totalChildCount?: number;
/** Input token total from debug log (sum of all llm_request events). Present for VS Code Copilot Chat agent-mode sessions. */
debugLogInputTokens?: number;
/** Output token total from debug log (sum of all llm_request events). Present for VS Code Copilot Chat agent-mode sessions. */
debugLogOutputTokens?: number;
/** Number of LLM API calls made during the session (from debug log). >1 means agent-mode multi-call session. */
modelTurns?: number;
/** Number of session.truncation events where messages were removed (breaking prompt cache). */
truncationCount?: number;
/** Total messages removed across all truncation events. */
messagesRemovedByTruncation?: number;
/** Optional editor-specific note. When present, an info panel is rendered at the top of the viewer. */
editorNote?: { items: string[] };
/** Per-leg HydraFusion routing detail (Copilot CLI sessions that used the `hydrafusion` model). */
hydraFusion?: HydraFusionSummary;
compactNumbers?: boolean;
};

/**
 * A single row for `renderUsageComparisonTable`.
 * When `delta` is `undefined` the Delta column is omitted.
 */
type ComparisonRow = {
label: string;
estimated: number;
actual: number;
delta?: number;
isTotal?: boolean;
};

// ── VS Code API bootstrap ────────────────────────────────────────────────────

declare function acquireVsCodeApi<TState = unknown>(): {
postMessage: (message: unknown) => void;
setState: (newState: TState) => void;
getState: () => TState | undefined;
};

declare global {
interface Window { __INITIAL_LOGDATA__?: SessionLogData & { focusedTurnNumber?: number; }; }
}

const vscode = acquireVsCodeApi();
const initialData = getWindowData<SessionLogData & { focusedTurnNumber?: number; localization?: Record<string, string> }>('__INITIAL_LOGDATA__');

// Initialize localization for webview
applyWebviewLocale(initialData);

import { resolveGuidMcpToolName, resolveMcpFamilyToolName, lookupKnownToolName } from '../../../../src/utils/toolUtils';

// Tool name map is injected by the extension host as window.__TOOL_NAMES__
const TOOL_NAME_MAP: { [key: string]: string } | null = getWindowData<Record<string, string>>('__TOOL_NAMES__') ?? null;

// ── Module-level constants ────────────────────────────────────────────────────

// ── Utility helpers ──────────────────────────────────────────────────────────

function lookupToolName(id: string): string {
if (!TOOL_NAME_MAP) {
return id;
}
return lookupKnownToolName(id, TOOL_NAME_MAP) ?? resolveGuidMcpToolName(id) ?? resolveMcpFamilyToolName(id) ?? id;
}

function formatDate(isoString: string | null): string {
if (!isoString) { return 'N/A'; }
try {
return new Date(isoString).toLocaleString();
} catch {
return isoString;
}
}

type ContextRefBadgeEntry = { key: keyof ContextReferenceUsage; label: string; implicit?: boolean };

const CONTEXT_REF_BADGE_ENTRIES: ContextRefBadgeEntry[] = [
	{ key: 'selection', label: '#selection' },
	{ key: 'file', label: '#file' },
	{ key: 'symbol', label: '#symbol' },
	{ key: 'codebase', label: '#codebase' },
	{ key: 'workspace', label: '@workspace' },
	{ key: 'terminal', label: '@terminal' },
	{ key: 'vscode', label: '@vscode' },
	{ key: 'terminalLastCommand', label: '#terminalLastCommand' },
	{ key: 'terminalSelection', label: '#terminalSelection' },
	{ key: 'clipboard', label: '#clipboard' },
	{ key: 'changes', label: '#changes' },
	{ key: 'outputPanel', label: '#outputPanel' },
	{ key: 'problemsPanel', label: '#problemsPanel' },
	{ key: 'pullRequest', label: '#pr' },
	{ key: 'implicitSelection', label: 'implicit', implicit: true },
];

function getContextRefBadges(refs: ContextReferenceUsage): string {
	return CONTEXT_REF_BADGE_ENTRIES
		.filter(e => ((refs[e.key] as number) || 0) > 0)
		.map(e => `<span class="context-ref-item${e.implicit ? ' context-ref-implicit' : ''}">${e.label}: <strong>${refs[e.key]}</strong></span>`)
		.join('');
}

function buildContextRefRows(refs: ContextReferenceUsage): ContextRefRow[] {
	const rows: ContextRefRow[] = [];
	if (refs.implicitSelection > 0) {
		rows.push({ category: '📝 Selection', name: 'editor selection', count: refs.implicitSelection, type: 'implicit' });
	}
	if (refs.byPath && Object.keys(refs.byPath).length > 0) {
		Object.entries(refs.byPath).forEach(([path, count]) => {
			if (path.startsWith('#sym:')) {
				rows.push({ category: '🔣 Symbol', name: path.substring(5), count, type: 'explicit' });
			} else {
				const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
				const isInstructionFile = normalizedPath.includes('copilot-instructions.md') ||
				                          normalizedPath.endsWith('.instructions.md') ||
				                          normalizedPath.endsWith('/agents.md');
				if (isInstructionFile) {
					rows.push({ category: '📋 Instructions', name: getFileName(path), count, type: 'implicit' });
				} else {
					rows.push({ category: '📁 File', name: getFileName(path), count, type: 'explicit' });
				}
			}
		});
	}
	const hasInstructionFiles = rows.some(r => r.category === '📋 Instructions');
	if (!hasInstructionFiles) {
		if (refs.copilotInstructions > 0) {
			rows.push({ category: '📋 Instructions', name: 'copilot-instructions', count: refs.copilotInstructions, type: 'implicit' });
		}
		if (refs.agentsMd > 0) {
			rows.push({ category: '🤖 Agents', name: 'agents.md', count: refs.agentsMd, type: 'implicit' });
		}
	}
	if (refs.workspace > 0) { rows.push({ category: '🌐 Workspace', name: '@workspace', count: refs.workspace, type: 'explicit' }); }
	if (refs.terminal > 0) { rows.push({ category: '💻 Terminal', name: '@terminal', count: refs.terminal, type: 'explicit' }); }
	if (refs.vscode > 0) { rows.push({ category: '⚙️ VS Code', name: '@vscode', count: refs.vscode, type: 'explicit' }); }
	if (refs.codebase > 0) { rows.push({ category: '📚 Codebase', name: '#codebase', count: refs.codebase, type: 'explicit' }); }
	if (refs.selection > 0) { rows.push({ category: '✂️ Selection', name: '#selection', count: refs.selection, type: 'explicit' }); }
	return rows;
}

type ContextRefRow = { category: string; name: string; count: number; type: 'implicit' | 'explicit' };

function renderContextReferencesDetailed(refs: ContextReferenceUsage, turnNumber: number): string {
	const rows = buildContextRefRows(refs);
	if (rows.length === 0) {
		return '<div class="context-section">No context references</div>';
	}
	const columns: DataTableColumn<ContextRefRow>[] = [
		{ id: 'category', label: 'Category', sortValue: row => row.category, render: row => row.category },
		{ id: 'reference', label: 'Reference', className: 'data-table-wrap-anywhere', sortValue: row => row.name, render: row => row.name },
		{ id: 'count', label: 'Count', align: 'right', className: 'count-cell', sortValue: row => row.count, render: row => String(row.count) },
		{
			id: 'type', label: 'Type', sortValue: row => row.type,
			cellClassName: row => row.type === 'implicit' ? 'context-type-implicit' : 'context-type-explicit',
			render: row => row.type === 'implicit' ? '🔒 implicit' : '👤 explicit',
		},
	];
	return renderDataTable({
		tableId: `logviewer-context-refs-${turnNumber}`,
		ariaLabel: localize('logviewer.summary.contextRefs'),
		rows,
		columns,
	});
}

function getModeColor(mode: string): string {
switch (mode) {
case 'ask': return '#3b82f6';
case 'edit': return '#10b981';
case 'agent': return '#7c3aed';
case 'plan': return '#f59e0b';
case 'customAgent': return '#ec4899';
case 'cli': return '#06b6d4';
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

/**
 * Render the per-turn model badge.
 *
 * JetBrains JSONL never persists the model selector, so the model field uses
 * sentinel suffixes/values to communicate uncertainty:
 *   • `"claude?"` / `"gpt?"` — first turn, family was inferred from the
 *     `tool.execution_start.toolCallId` prefix; specific version is unknown.
 *   • `"?"` — subsequent JetBrains turns where we have no per-turn signal at
 *     all (the user may have switched models partway through).
 *
 * Both variants render with an explanatory tooltip so users aren't misled.
 */
function renderTurnModelBadge(model: string): string {
if (model === '?') {
return `<span class="turn-model" title="Model not persisted in JetBrains session log; may differ from earlier turns if the user switched models.">🎯 ?</span>`;
}
if (model.endsWith('?')) {
const family = escapeHtml(model);
return `<span class="turn-model" title="JetBrains session logs only record the model family (inferred from the tool call ID prefix). Specific version isn't persisted.">🎯 ${family}</span>`;
}
return `<span class="turn-model">🎯 ${escapeHtml(getModelDisplayName(model))}</span>`;
}

// ── Delta comparison helpers ─────────────────────────────────────────────────

/** Returns '+' for positive numbers, '' for zero or negative. Used in delta comparisons. */
function deltaSign(n: number): string {
return n > 0 ? '+' : '';
}

/** Returns a CSS class name based on whether a delta is over, under, or zero. */
function deltaClass(n: number): string {
return n > 0 ? 'delta-over' : n < 0 ? 'delta-under' : 'delta-zero';
}

// ── Top-list formatters (used in summary cards) ──────────────────────────────

/**
 * Renders a top-N list as `<div>` rows.
 * @security All keys are passed through `escapeHtml`.
 */
function formatTopList(entries: { key: string; value: number }[], mapper?: (k: string) => string): string {
if (!entries.length) { return 'None'; }
return entries.map(e => `<div>${escapeHtml(mapper ? mapper(e.key) : e.key)}: ${e.value}</div>`).join('');
}

// ── Shared render helpers ────────────────────────────────────────────────────

/**
 * Renders the estimated-vs-actual comparison table from structured row data; a row
 * flagged `isTotal` becomes the table's footer. The Delta column is included only when
 * `showDelta` is `true`. All numeric values are formatted via `formatCompact`; ratio
 * cells gracefully fall back to `'N/A'` when the estimated value is zero.
 * A fixed set of rows in a meaningful order, so it is neither paged nor sortable.
 */
function renderUsageComparisonTable(tableId: string, ariaLabel: string, rows: ComparisonRow[], showDelta: boolean): string {
const ratio = (row: ComparisonRow): string => row.estimated > 0 ? (row.actual / row.estimated).toFixed(1) + 'x' : 'N/A';
const delta = (row: ComparisonRow): string => row.delta === undefined ? '' : `${deltaSign(row.delta)}${formatCompact(row.delta)}`;
const strong = (text: string, className?: string): DataTableCell =>
	({ html: `<strong${className ? ` class="${className}"` : ''}>${escapeHtml(text)}</strong>` });

const deltaColumn: DataTableColumn<ComparisonRow> = {
	id: 'delta', label: 'Delta', align: 'right', className: 'count-cell',
	cellClassName: row => row.delta === undefined ? undefined : deltaClass(row.delta),
	render: delta,
};
const columns: DataTableColumn<ComparisonRow>[] = [
	{ id: 'metric', label: 'Metric', render: row => row.label },
	{ id: 'estimated', label: 'Estimated', align: 'right', className: 'count-cell', render: row => formatCompact(row.estimated) },
	{ id: 'actual', label: 'Actual', align: 'right', className: 'count-cell', render: row => formatCompact(row.actual) },
	...(showDelta ? [deltaColumn] : []),
	{ id: 'ratio', label: 'Ratio', align: 'right', className: 'count-cell', render: ratio },
];

const footerRows = rows.filter(row => row.isTotal).map(row => ({
	cells: {
		metric: strong(row.label),
		estimated: strong(formatCompact(row.estimated)),
		actual: strong(formatCompact(row.actual)),
		delta: row.delta === undefined ? '' : strong(delta(row), deltaClass(row.delta)),
		ratio: strong(ratio(row)),
	},
}));

return renderDataTable({
	tableId,
	ariaLabel,
	rows: rows.filter(row => !row.isTotal),
	columns,
	pageSize: false,
	footerRows,
	rootClassName: 'usage-comparison',
});
}

/**
 * Renders file/symbol header badges for a turn card, sourced from
 * `contextReferences.byPath` and the instruction counters.
 * Returns an empty string when there are no badges to show.
 * @security All file paths and symbol names are passed through `escapeHtml`.
 */
function renderContextFileBadges(refs: ContextReferenceUsage): string {
const badges: string[] = [];
if (refs.copilotInstructions > 0) {
badges.push(`<span class="context-badge">📋 copilot-instructions.md</span>`);
}
if (refs.agentsMd > 0) {
badges.push(`<span class="context-badge">🤖 agents.md</span>`);
}
// Add other file references
if (refs.byPath && Object.keys(refs.byPath).length > 0) {
const otherPaths = Object.entries(refs.byPath)
.filter(([path]) => {
const normalized = path.toLowerCase().replace(/\\/g, '/');
return !(normalized.includes('copilot-instructions.md') || normalized.endsWith('/agents.md'));
});

otherPaths.forEach(([path]) => {
// Check if this is a symbol reference
if (path.startsWith('#sym:')) {
const symbolName = path.substring(5); // Remove '#sym:' prefix
badges.push(`<span class="context-badge" title="Symbol: ${escapeHtml(symbolName)}">🔤 ${escapeHtml(symbolName)}</span>`);
} else {
badges.push(`<span class="context-badge" title="${escapeHtml(path)}">📄 ${escapeHtml(getFileName(path))}</span>`);
}
});
}
return badges.join('');
}

type PromptBreakdownRow = { category: string; label: string; percent: number; tokens: number };

/**
 * Renders a prompt-breakdown table (category, label, share of the prompt, deduced tokens and a
 * distribution bar). The per-turn and the session-level tables differ only in their headers.
 */
function renderPromptBreakdownTable(options: {
	tableId: string;
	rows: PromptBreakdownRow[];
	percentLabel: string;
	tokensLabel: string;
	initialSort?: DataTableSort;
}): string {
	const categoryClass = (row: PromptBreakdownRow): string => row.category === 'System' ? 'category-system' : 'category-user';
	const columns: DataTableColumn<PromptBreakdownRow>[] = [
		{
			id: 'category', label: 'Category', sortValue: row => row.category,
			render: row => ({ html: `<span class="${categoryClass(row)}">${escapeHtml(row.category)}</span>` }),
		},
		{ id: 'label', label: 'Label', sortValue: row => row.label, render: row => row.label },
		{ id: 'percent', label: options.percentLabel, align: 'right', className: 'count-cell', sortValue: row => row.percent, render: row => `${row.percent}%` },
		{ id: 'tokens', label: options.tokensLabel, align: 'right', className: 'count-cell', sortValue: row => row.tokens, render: row => formatCompact(row.tokens) },
		{
			id: 'distribution', label: 'Distribution',
			render: row => ({ html: `<div class="bar-cell"><div class="bar-fill ${categoryClass(row)}-bar" style="width: ${Math.min(row.percent, 100)}%"></div></div>` }),
		},
	];
	return renderDataTable({
		tableId: options.tableId,
		ariaLabel: 'Prompt breakdown',
		rows: options.rows,
		columns,
		initialSort: options.initialSort,
	});
}

/**
 * Renders the "📊 ACTUAL LLM USAGE" `<details>` block for a single turn.
 * Returns an empty string when the turn has no actual usage data.
 */
function buildPromptBreakdownHtml(au: ChatTurn['actualUsage'] & {}, turnNumber: number): string {
	if (!au.promptTokenDetails || au.promptTokenDetails.length === 0) { return ''; }
	const breakdownRows: PromptBreakdownRow[] = au.promptTokenDetails.map(detail => ({
		category: detail.category,
		label: detail.label,
		percent: detail.percentageOfPrompt,
		tokens: Math.round(au.promptTokens * detail.percentageOfPrompt / 100),
	}));
	const systemPct = au.promptTokenDetails.filter(d => d.category === 'System').reduce((s, d) => s + d.percentageOfPrompt, 0);
	const userPct   = au.promptTokenDetails.filter(d => d.category !== 'System').reduce((s, d) => s + d.percentageOfPrompt, 0);
	const systemTokens = Math.round(au.promptTokens * systemPct / 100);
	const userTokens   = Math.round(au.promptTokens * userPct / 100);
	return `
<div class="prompt-breakdown">
<div class="breakdown-summary">
<span class="category-system">System: ${systemPct}% (~${formatCompact(systemTokens)} tokens)</span>
<span class="category-user">User Context: ${userPct}% (~${formatCompact(userTokens)} tokens)</span>
</div>
${renderPromptBreakdownTable({ tableId: `logviewer-prompt-breakdown-turn-${turnNumber}`, rows: breakdownRows, percentLabel: '%', tokensLabel: '~Tokens' })}
</div>
`;
}

function renderActualUsageSummary(turn: ChatTurn): string {
if (!turn.actualUsage) { return ''; }

const au = turn.actualUsage;
const totalTokens    = turn.inputTokensEstimate + turn.outputTokensEstimate + turn.thinkingTokensEstimate;
const actualTotal    = au.promptTokens + au.completionTokens;
const estimatedTotal = totalTokens;
const dInput  = au.promptTokens      - turn.inputTokensEstimate;
const dOutput = au.completionTokens  - turn.outputTokensEstimate;
const dTotal  = actualTotal          - estimatedTotal;

const promptBreakdownHtml = buildPromptBreakdownHtml(au, turn.turnNumber);

const comparisonRows: ComparisonRow[] = [
{ label: '↑ Prompt / Input',      estimated: turn.inputTokensEstimate,  actual: au.promptTokens,     delta: dInput  },
{ label: '↓ Completion / Output', estimated: turn.outputTokensEstimate, actual: au.completionTokens, delta: dOutput },
{ label: 'Σ Total',               estimated: estimatedTotal,             actual: actualTotal,          delta: dTotal, isTotal: true },
];

return `
<div class="turn-actual-usage">
<details class="actual-usage-details">
<summary class="actual-usage-summary">
<span class="collapse-arrow">▶</span>
<span class="actual-usage-header-inline">📊 ACTUAL LLM USAGE</span>
<span class="actual-usage-summary-text">
<span class="usage-badge">↑${formatCompact(au.promptTokens)}</span>
<span class="usage-badge">↓${formatCompact(au.completionTokens)}</span>
<span class="usage-badge usage-total">Σ${formatCompact(actualTotal)}</span>
<span class="usage-badge ${deltaClass(dTotal)}">delta: ${deltaSign(dTotal)}${formatCompact(dTotal)}</span>
${au.details ? `<span class="usage-badge usage-model-info">${escapeHtml(au.details)}</span>` : ''}
</span>
</summary>
<div class="actual-usage-content">
${renderUsageComparisonTable(`logviewer-usage-comparison-turn-${turn.turnNumber}`, 'Actual LLM usage', comparisonRows, true)}
${promptBreakdownHtml}
</div>
</details>
</div>
`;
}

/** One tool call in a turn's tool table; `idx` is its position in `turn.toolCalls`, which the host uses to find it. */
type ToolCallRow = { tc: ToolCall; idx: number; displayName: string; filterKey: string };

/** The `data-tool-filter` value of the sub-agent pill, and the filter key of every sub-agent row. */
const SUB_AGENT_TOOL_FILTER = '__subagent__';

/**
 * Renders the "🔧 TOOL CALLS" `<details>` block for a single turn.
 * Returns an empty string when the turn has no tool calls.
 * @security All tool names and display strings are passed through `escapeHtml`.
 */
function renderToolCallsSection(turn: ChatTurn): string {
if (turn.toolCalls.length === 0) { return ''; }

const regularCalls       = turn.toolCalls.filter(tc => !tc.isSubAgent);
const subAgentCallsInTurn = turn.toolCalls.filter(tc => tc.isSubAgent);
const toolCounts: { [key: string]: number } = {};
regularCalls.forEach(tc => {
const toolName = lookupToolName(tc.toolName);
toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
});

const toolSummary = Object.entries(toolCounts)
.map(([name, count]) => `<span class="tool-summary-item" data-tool-filter="${escapeHtml(name)}" data-turn="${turn.turnNumber}" title="Click to filter by ${escapeHtml(name)}">${escapeHtml(name)}: <strong>${count}</strong></span>`)
.join('');
const subAgentSummary = subAgentCallsInTurn.length > 0
? `<span class="sub-agent-summary-item" data-tool-filter="${SUB_AGENT_TOOL_FILTER}" data-turn="${turn.turnNumber}" title="Click to filter sub-agent calls">🤖 Sub-Agents: <strong>${subAgentCallsInTurn.length}</strong></span>`
: '';

const SUB_AGENT_DISPLAY: Record<string, string> = {
task:        '🤖 Sub-Agent',
read_agent:  '🤖 Sub-Agent (read)',
write_agent: '🤖 Sub-Agent (write)',
list_agents: '🤖 Sub-Agent (list)',
};

const toolRows: ToolCallRow[] = turn.toolCalls.map((tc, idx) => ({
tc,
idx,
displayName: tc.isSubAgent ? (SUB_AGENT_DISPLAY[tc.toolName] ?? `🤖 ${tc.toolName}`) : lookupToolName(tc.toolName),
filterKey: tc.isSubAgent ? SUB_AGENT_TOOL_FILTER : lookupToolName(tc.toolName),
}));

return `
<div class="turn-tools">
<details class="tool-calls-details">
<summary class="tool-calls-summary">
<span class="collapse-arrow">▶</span>
<span class="tools-header-inline">🔧 TOOL CALLS (${turn.toolCalls.length})</span>
<span class="tool-summary-text">${toolSummary}${subAgentSummary}</span>
</summary>
${renderToolCallsTable(turn.turnNumber, toolRows)}
</details>
</div>
`;
}

function toolCallsTableId(turnNumber: number | string): string {
return `logviewer-tools-${turnNumber}`;
}

/**
 * A turn's tool calls, in call order. The summary pills above it narrow the table to one tool
 * through the table's own filter state (see `applyToolCallFilter`), so the filter covers every
 * page and survives sorting and paging.
 * @security All tool names, arguments and results are passed through `escapeHtml`.
 */
function renderToolCallsTable(turnNumber: number, rows: ToolCallRow[]): string {
const columns: DataTableColumn<ToolCallRow>[] = [
{
id: 'name', label: 'Tool Name', className: 'tool-name-cell', sortValue: row => row.displayName,
render: ({ tc, idx, displayName }) => ({ html: `
<span class="tool-name tool-call-link" data-turn="${turnNumber}" data-toolcall="${idx}" title="${escapeHtml(tc.toolName)}" style="cursor:pointer;">${escapeHtml(displayName)}</span>
${tc.isSubAgent && tc.subAgentModel ? `<span class="sub-agent-model-badge">${escapeHtml(getModelDisplayName(tc.subAgentModel))}</span>` : ''}
${tc.isSubAgent && tc.subAgentTokens ? `<span class="sub-agent-tokens">↑${formatCompact(tc.subAgentTokens.input)} ↓${formatCompact(tc.subAgentTokens.output)} tokens${tc.subAgentCost ? ` · ${formatCost(tc.subAgentCost)}` : ''}</span>` : ''}
${tc.arguments && !tc.isSubAgent ? `<details class="tool-details"><summary>Arguments</summary><pre>${escapeHtml(tc.arguments)}</pre></details>` : ''}
${tc.result && !tc.isSubAgent ? `<details class="tool-details"><summary>Result</summary><pre>${escapeHtml(truncateText(tc.result, 500))}</pre></details>` : ''}
` }),
},
{
id: 'action', label: 'Action', align: 'right', width: '100px', className: 'tool-action-cell',
render: ({ tc, idx }) => ({ html: !tc.isSubAgent ? `<span class="tool-call-pretty" data-turn="${turnNumber}" data-toolcall="${idx}" title="View pretty JSON" style="cursor:pointer;color:#22c55e;">Investigate</span>` : '' }),
},
];
return renderDataTable({
tableId: toolCallsTableId(turnNumber),
ariaLabel: localize('logviewer.summary.toolCalls'),
rows,
columns,
rootClassName: 'turn-tools-table',
rowOptions: row => ({
className: `tool-row${row.tc.isSubAgent ? ' sub-agent-row' : ''}`,
attributes: { 'data-tool-name': row.filterKey },
}),
filterRows: (row, filters) => {
const active = Object.keys(filters).filter(key => filters[key]);
return active.length === 0 || active.includes(row.filterKey);
},
});
}

/** Narrows a turn's tool table to `filterKey`, or shows every call again when it is `null`. */
function applyToolCallFilter(turnNumber: string, filterKey: string | null): void {
const tableId = toolCallsTableId(turnNumber);
const filters: Record<string, boolean> = {};
for (const key of Object.keys(getDataTableState(tableId).filters)) { filters[key] = false; }
if (filterKey !== null) { filters[filterKey] = true; }
setDataTableState(tableId, { filters, page: 1 });
rerenderDataTable(tableId);
}

/**
 * Renders the "🔗 CONTEXT REFERENCES" `<details>` block for a single turn.
 * Returns an empty string when the turn has no context references.
 */
function renderContextRefsSection(turn: ChatTurn): string {
const totalRefs = getTotalContextRefs(turn.contextReferences);
if (totalRefs === 0) { return ''; }

const contextRefBadges = getContextRefBadges(turn.contextReferences);
return `
<div class="turn-context-refs">
<details class="context-refs-details">
<summary class="context-refs-summary">
<span class="collapse-arrow">▶</span>
<span class="context-refs-header-inline">🔗 CONTEXT REFERENCES (${totalRefs})</span>
<span class="context-ref-summary-text">${contextRefBadges}</span>
</summary>
<div class="context-refs-content">
${renderContextReferencesDetailed(turn.contextReferences, turn.turnNumber)}
</div>
</details>
</div>
`;
}

// ── Layout section renderers ─────────────────────────────────────────────────

/**
 * Combined "Editor identity" card: merges the previous Interactions (turns),
 * Editor Mode and Source Editor cards into a single compact card so the three
 * related facets of "which editor, in which mode, doing how many turns" read
 * as one panel instead of three.
 */
function buildEditorIdentityCard(data: SessionLogData, stats: SummaryStats): string {
	const { modeEntries, primaryModeLabel, modeSubLabel, totalModeTurns } = stats;
	const interactions = data.interactions;
	const modesTitle = modeEntries.map(([m, n]) => `${getModeIcon(m)} ${MODE_LABELS[m]} (${n})`).join(' · ');
	const extraModes = modeEntries.length > 1 ? ` · ${modeEntries.slice(1).map(([m, n]) => `${MODE_LABELS[m]} ${n}`).join(', ')}` : '';
	const modeValue = totalModeTurns > 0 ? primaryModeLabel : '—';
	const modeSub = totalModeTurns > 0 ? `${modeSubLabel}${extraModes}` : localize('logviewer.summary.noModeData');
	return `<div class="summary-card summary-card--compact summary-card--combined" title="${escapeHtml(modesTitle)}">
<div class="summary-label">🖥️ ${localize('logviewer.summary.editor')}</div>
<div class="summary-compact-rows">
<div class="summary-compact-row"><span class="summary-compact-key">💻 ${localize('logviewer.summary.editorSource')}</span><span class="summary-compact-val" style="font-size: 13px; font-weight: 700;">${escapeHtml(data.editorName)}</span></div>
<div class="summary-compact-row"><span class="summary-compact-key">🎛️ ${localize('logviewer.summary.editorMode')}</span><span class="summary-compact-val">${modeValue}</span></div>
<div class="summary-compact-row"><span class="summary-compact-key">📝 ${localize('logviewer.summary.interactions')}</span><span class="summary-compact-val">${interactions}</span></div>
</div>
<div class="summary-sub">${escapeHtml(modeSub)}</div>
</div>`;
}

/**
 * Per-editor notes for the Estimated Tokens card. When an editor is present in
 * this map the card renders a `ⓘ` hint with hover text explaining why the count
 * is an estimate (no actual API token counts persisted by that editor).
 */
const ESTIMATED_TOKENS_NOTES: Record<string, { title: string; sub: string }> = {
	JetBrains: {
		title: 'JetBrains: only user messages + assistant text are persisted in the session log, so this is an estimate of those alone. Actual API token counts and thinking tokens are not available.',
		sub: 'User + assistant text only (no API counts, no thinking)',
	},
	Antigravity: {
		title: 'Antigravity: token counts are estimated from transcript content. Actual API counts are not stored locally.',
		sub: 'Estimated from transcript content',
	},
	Cursor: {
		title: 'Cursor: shows the context window size at the last request (contextTokensUsed). This is a snapshot, not cumulative per-turn billing. Output tokens are not stored locally.',
		sub: 'Context window at last request (snapshot, not cumulative)',
	},
	Eclipse: {
		title: 'Eclipse: only user/assistant message text plus reasoning (thinkingBlock) text is persisted in the conversation file. The Context Window breakdown Eclipse shows (system instructions, tool definitions, tool results) is computed live and never written to disk, so this estimate covers message + thinking text only and will be lower than the context usage Eclipse displays.',
		sub: 'Message + thinking text only (Context Window not stored)',
	},
	Kiro: {
		title: 'Kiro: token counts are estimated (~4 chars/token) from the agent execution records, which store the full request context and response text per agent run. Actual API token counts and real model IDs are not persisted locally (Kiro meters usage in credits).',
		sub: 'Estimated from execution records (Kiro meters credits, not tokens)',
	},
	'Kiro CLI': {
		title: 'Kiro CLI: token counts are estimated from the message log text (~4 chars/token). The CLI records usage in credits per request but its input/output token counters are always 0, and the model is logged as "auto" (server-side routing).',
		sub: 'Estimated from message log (CLI meters credits, not tokens)',
	},
	'Devin CLI': {
		title: 'Devin CLI: the ACP protocol used by this tool does not define per-message token counts, so this is a ~4 chars/token estimate from message text. A per-session cogs_json field may hold real usage data, but its exact shape was unconfirmed (no populated example was available) at the time this was implemented.',
		sub: 'Estimated from message text (ACP has no per-message token counts)',
	},
};

function buildEstimatedTokensCard(data: SessionLogData, stats: SummaryStats): string {
	const note = ESTIMATED_TOKENS_NOTES[data.editorName];
	const titleAttr = note ? ` title="${note.title}"` : '';
	const suffix = note ? ' ⓘ' : '';
	const sub = note ? note.sub : 'Input + Output estimated from text';
	return `<div class="summary-card"${titleAttr}>
<div class="summary-label">📊 ${localize('logviewer.summary.estimatedTokens')}${suffix}</div>
<div class="summary-value">${formatCompact(stats.totalTokens)}</div>
<div class="summary-sub">${sub}</div>
</div>`;
}

function buildActualTokensCard(data: SessionLogData, stats: SummaryStats): string {
	const { hasAnyActualUsage, hasSessionActualOnly, actualTotal, actualPromptTotal, actualCompletionTotal, sessionActualTokens } = stats;
	if (hasAnyActualUsage && !data.debugLogInputTokens) {
		return `<div class="summary-card">
<div class="summary-label">✅ ${localize('logviewer.summary.actualTokens')}</div>
<div class="summary-value">${formatCompact(actualTotal)}</div>
<div class="summary-sub">↑${formatCompact(actualPromptTotal)} prompt, ↓${formatCompact(actualCompletionTotal)} completion</div>
</div>`;
	}
	if (data.debugLogInputTokens !== undefined) {
		return `<div class="summary-card" title="Token counts from the Copilot Chat debug log, summed across every LLM API call in this session. Agent-mode sessions make multiple calls per user turn; the debug log captures all of them.">
<div class="summary-label">✅ ${localize('logviewer.summary.actualTokens')}</div>
<div class="summary-value">${formatCompact((data.debugLogInputTokens ?? 0) + (data.debugLogOutputTokens ?? 0))}</div>
<div class="summary-sub">↑${formatCompact(data.debugLogInputTokens)} input, ↓${formatCompact(data.debugLogOutputTokens ?? 0)} output</div>
</div>`;
	}
	if (hasSessionActualOnly) {
		return `<div class="summary-card">
<div class="summary-label">✅ ${localize('logviewer.summary.actualTokens')}</div>
<div class="summary-value">${formatCompact(sessionActualTokens)}</div>
<div class="summary-sub">${data.editorName === 'Mistral Vibe' ? 'From session data' : 'Actual API tokens from Copilot CLI usage data'}</div>
</div>`;
	}
	return '';
}

function buildModelTurnsCard(data: SessionLogData): string {
	if ((data.modelTurns ?? 0) <= 0) { return ''; }
	const subText = (data.modelTurns ?? 0) > data.turns.length
		? `${data.modelTurns} API calls for ${data.turns.length} user turn${data.turns.length !== 1 ? 's' : ''}`
		: 'LLM API calls in this session';
	return `<div class="summary-card" title="Number of LLM API calls made during this session, as recorded in the Copilot Chat debug log. Agent-mode sessions make multiple calls per user turn (tool call → re-prompt → final answer).">
<div class="summary-label">🔄 ${localize('logviewer.summary.modelTurns')}</div>
<div class="summary-value">${data.modelTurns}</div>
<div class="summary-sub">${subText}</div>
</div>`;
}

function buildDebugTokenCards(data: SessionLogData): string {
	if (data.debugLogInputTokens === undefined) { return ''; }
	return `<div class="summary-card" title="Total input tokens sent to the LLM across all API calls in this session, from the Copilot Chat debug log.">
<div class="summary-label">📥 ${localize('logviewer.summary.inputTokens')}</div>
<div class="summary-value">${formatCompact(data.debugLogInputTokens)}</div>
<div class="summary-sub">Prompt tokens across all model calls</div>
</div>
<div class="summary-card" title="Total output tokens generated by the LLM across all API calls in this session, from the Copilot Chat debug log.">
<div class="summary-label">📤 ${localize('logviewer.summary.outputTokens')}</div>
<div class="summary-value">${formatCompact(data.debugLogOutputTokens ?? 0)}</div>
<div class="summary-sub">Completion tokens across all model calls</div>
</div>`;
}

function buildCachedTokensCard(data: SessionLogData): string {
	if ((data.cachedTokens ?? 0) <= 0) { return ''; }
	return `<div class="summary-card" title="Tokens served from the provider's prompt cache. Cached tokens are billed at a lower rate and reduce latency. Source: Copilot CLI usage data (assistant_usage_events).">
<div class="summary-label">💾 ${localize('logviewer.summary.cachedInput')}</div>
<div class="summary-value">${formatCompact(data.cachedTokens!)}</div>
<div class="summary-sub">Prompt tokens served from cache</div>
</div>`;
}

function buildEstimatedCostCard(data: SessionLogData): string {
	const total = sumSessionCost(data);
	if (total <= 0) { return ''; }
	return `<div class="summary-card" title="${escapeHtml(localize('logviewer.summary.estimatedCostTooltip'))}">
<div class="summary-label">💰 ${localize('logviewer.summary.estimatedCost')}</div>
<div class="summary-value">${formatCost(total)}</div>
<div class="summary-sub">${localize('logviewer.summary.estimatedCostSub')}</div>
</div>`;
}

function buildThinkingTokensCard(data: SessionLogData, stats: SummaryStats): string {
	if (stats.totalThinkingTokens <= 0) { return ''; }
	return `<div class="summary-card">
<div class="summary-label">🧠 ${localize('logviewer.summary.thinkingTokens')}</div>
<div class="summary-value">${formatCompact(stats.totalThinkingTokens)}</div>
<div class="summary-sub">${stats.turnsWithThinking} of ${data.turns.length} turns used thinking</div>
</div>`;
}

function buildEffortCard(stats: SummaryStats): string {
	if (!stats.sessionEffort) { return ''; }
	const { effortDefaultLabel, effortSummary, sessionEffort } = stats;
	const switchText = sessionEffort.switchCount > 0 ? ` · ${sessionEffort.switchCount} switch${sessionEffort.switchCount !== 1 ? 'es' : ''}` : '';
	return `<div class="summary-card">
<div class="summary-label">💡 ${localize('logviewer.summary.thinkingEffort')}</div>
<div class="summary-value">${effortDefaultLabel}</div>
<div class="summary-sub">${effortSummary}${switchText}</div>
</div>`;
}

function buildHierarchyCard(data: SessionLogData): string {
	const hasParent = !!data.parentInfo;
	const childCount = data.totalChildCount ?? data.childInfo?.length ?? 0;
	if (!hasParent && childCount === 0) { return ''; }

	let parts: string[] = [];
	if (hasParent) {
		const pName = escapeHtml(data.parentInfo!.name);
		parts.push(`<div class="hierarchy-line hierarchy-parent-line">↑ Parent: <strong>${pName}</strong></div>`);
	}
	if (childCount > 0) {
		const shown = data.childInfo?.slice(0, 5) ?? [];
		const more = childCount - shown.length;
		const childItems = shown.map(c => `<span class="hierarchy-child-name">${escapeHtml(c.name)}</span>`).join(', ');
		const moreHtml = more > 0 ? ` <span style="color: var(--vscode-descriptionForeground);">+${more} more</span>` : '';
		parts.push(`<div class="hierarchy-line hierarchy-children-line">↓ Children (${childCount}): ${childItems}${moreHtml}</div>`);
	}

	return `<div class="summary-card">
<div class="summary-label">🔗 ${localize('logviewer.summary.sessionHierarchy')}</div>
<div class="summary-sub hierarchy-card-content">${parts.join('')}</div>
</div>`;
}

function buildSubAgentsCard(data: SessionLogData, stats: SummaryStats): string {
	if (stats.totalSubAgentCalls <= 0 && (data.subAgentsStarted ?? 0) <= 0) { return ''; }
	const count = data.subAgentsStarted ?? stats.totalSubAgentCalls;
	const sub = data.subAgentsStarted !== undefined
		? `${data.subAgentsStarted} started · ${stats.totalSubAgentCalls} tool calls`
		: 'Agent mode sub-agent invocations';
	return `<div class="summary-card">
<div class="summary-label">🤖 ${localize('logviewer.summary.subAgents')}</div>
<div class="summary-value">${count}</div>
<div class="summary-sub">${sub}</div>
</div>`;
}

function buildTruncationCard(data: SessionLogData): string {
	if ((data.truncationCount ?? 0) <= 0) { return ''; }
	const removed = data.messagesRemovedByTruncation ?? 0;
	const sub = removed > 0
		? `${removed} message${removed !== 1 ? 's' : ''} dropped — prompt cache broken`
		: 'Context window truncated';
	return `<div class="summary-card summary-card--warning" title="The AI dropped earlier messages to fit within the context window. This breaks prompt cache efficiency and may affect response quality.">
<div class="summary-label">⚠️ ${localize('logviewer.summary.contextTruncated')}</div>
<div class="summary-value">${data.truncationCount}</div>
<div class="summary-sub">${sub}</div>
</div>`;
}

function buildFileNameCard(data: SessionLogData): string {
	const isOpenCode = data.file.includes('opencode.db#ses_');
	const displayName = escapeHtml(truncateText(getFileName(data.file), 30));
	const title = escapeHtml(getFileName(data.file));
	const valueHtml = isOpenCode
		? `<span title="${title}">${displayName}</span>`
		: `<span class="filename-link" id="open-file-link" title="${title}">${displayName}</span>`;
	const sub = isOpenCode ? 'Stored in SQLite database' : 'Click to open in editor';
	return `<div class="summary-card">
<div class="summary-label">📁 ${localize('logviewer.summary.fileName')}</div>
<div class="summary-value" style="font-size: 16px;">${valueHtml}</div>
<div class="summary-sub">${sub}</div>
</div>`;
}

/**
 * Renders the optional editor info panel at the very top of the log viewer.
 * Only shown when `data.editorNote` is present (injected by the adapter/backend
 * to communicate data-availability limitations or editor-specific notes).
 */
function renderEditorInfoPanel(data: SessionLogData): string {
	if (!data.editorNote?.items?.length) { return ''; }
	const icon = getEditorIcon(data.editorName);
	const items = data.editorNote.items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
	return `<div class="editor-info-panel">
<div class="editor-info-header">
<span class="editor-info-icon">${icon}</span>
<span class="editor-info-name">${escapeHtml(data.editorName)}</span>
<span class="editor-info-badge">ℹ️ Data Availability</span>
</div>
<ul class="editor-info-list">${items}</ul>
</div>`;
}

/**
 * Renders the grid of summary cards at the top of the log-viewer layout.
 * @security All user-controlled strings (editorName, file path) are escaped via `escapeHtml`.
 */
function renderSummaryCards(data: SessionLogData, stats: SummaryStats): string {
	const { usageToolTotal, usageTopTools } = stats;
	return `
<div class="summary-cards">
${buildEditorIdentityCard(data, stats)}
${buildEstimatedTokensCard(data, stats)}
${buildActualTokensCard(data, stats)}
${buildModelTurnsCard(data)}
${buildDebugTokenCards(data)}
${buildCachedTokensCard(data)}
${buildEstimatedCostCard(data)}
${buildThinkingTokensCard(data, stats)}
${buildEffortCard(stats)}
${buildSubAgentsCard(data, stats)}
${buildTruncationCard(data)}
${buildHierarchyCard(data)}
<div class="summary-card">
<div class="summary-label">🔧 ${localize('logviewer.summary.toolCalls')}</div>
<div class="summary-value">${usageToolTotal}</div>
<div class="summary-sub">${formatTopListWithOther(usageTopTools, usageToolTotal, lookupToolName)}</div>
</div>
${buildMcpAndContextRefsCard(stats)}
<div class="summary-card">
<div class="summary-label">📦 ${localize('logviewer.summary.fileSize')}</div>
<div class="summary-value">${formatFileSize(data.size)}</div>
<div class="summary-sub">Total size on disk</div>
</div>
${buildTimelineCard(data)}
</div>`;
}

/**
 * Renders a single compact card grouping the three session timestamps
 * (started, last activity, last file modification) as small rows instead of
 * three separate full-sized cards.
 */
function buildTimelineCard(data: SessionLogData): string {
	return `<div class="summary-card summary-card--compact">
<div class="summary-label">🕒 ${localize('logviewer.summary.timeline')}</div>
<div class="summary-compact-rows">
<div class="summary-compact-row"><span class="summary-compact-key">▶️ ${localize('logviewer.summary.started')}</span><span class="summary-compact-val">${formatDate(data.firstInteraction)}</span></div>
<div class="summary-compact-row"><span class="summary-compact-key">⏹️ ${localize('logviewer.summary.lastActivity')}</span><span class="summary-compact-val">${formatDate(data.lastInteraction)}</span></div>
<div class="summary-compact-row"><span class="summary-compact-key">💾 ${localize('logviewer.summary.modified')}</span><span class="summary-compact-val">${formatDate(data.modified)}</span></div>
</div>
</div>`;
}

/**
 * Renders the session-level actual-usage block (comparison table + aggregated
 * prompt breakdown) that appears below the summary cards.
 * Returns an empty string when there are no turns with actual usage data.
 */
function renderSessionActualUsage(
data: SessionLogData,
totalTokens: number,
turnsWithActual: ChatTurn[],
actualPromptTotal: number,
actualCompletionTotal: number,
actualTotal: number,
aggregatedBreakdown: { [key: string]: BreakdownEntry },
): string {
if (turnsWithActual.length === 0) { return ''; }

const inputEstimateSum  = data.turns.reduce((s, t) => s + t.inputTokensEstimate, 0);
const outputEstimateSum = data.turns.reduce((s, t) => s + t.outputTokensEstimate, 0);

const breakdownEntries = Object.values(aggregatedBreakdown);
const breakdownRows: PromptBreakdownRow[] = breakdownEntries.map(entry => ({
category: entry.category,
label: entry.label,
percent: Math.round(entry.totalPct / entry.count),
tokens: entry.totalTokens,
}));

const systemTokens = breakdownEntries.filter(e => e.category === 'System').reduce((s, e) => s + e.totalTokens, 0);
const userTokens   = breakdownEntries.filter(e => e.category !== 'System').reduce((s, e) => s + e.totalTokens, 0);

const hasComparison = actualTotal > 0 || totalTokens > 0;
const hasBreakdown  = breakdownEntries.length > 0;
const gridClass = (hasComparison && hasBreakdown)
? 'session-usage-grid'
: 'session-usage-grid session-usage-grid--single';

const comparisonRows: ComparisonRow[] = [
{ label: '↑ Prompt',     estimated: inputEstimateSum,  actual: actualPromptTotal    },
{ label: '↓ Completion', estimated: outputEstimateSum, actual: actualCompletionTotal },
{ label: 'Σ Total',      estimated: totalTokens,       actual: actualTotal, isTotal: true },
];

return `
<div class="session-actual-usage">
<div class="session-usage-header">📊 Session Actual LLM Usage (${turnsWithActual.length}/${data.turns.length} turns with data)</div>
<div class="${gridClass}">
${hasComparison ? `<div class="session-usage-comparison">
${renderUsageComparisonTable('logviewer-usage-comparison-session', 'Session Actual LLM Usage', comparisonRows, false)}
</div>` : ''}
${hasBreakdown ? `<div class="session-usage-breakdown">
<div class="breakdown-summary">
<span class="category-system">System: ~${formatCompact(systemTokens)} tokens</span>
<span class="category-user">User Context: ~${formatCompact(userTokens)} tokens</span>
</div>
${renderPromptBreakdownTable({
	tableId: 'logviewer-prompt-breakdown-session',
	rows: breakdownRows,
	percentLabel: 'Avg %',
	tokensLabel: 'Total ~Tokens',
	initialSort: { columnId: 'tokens', direction: 'desc' },
})}
</div>` : ''}
</div>
</div>
`;
}

// ── Turns overview table ─────────────────────────────────────────────────────
// Row-building logic (getTurnCachedTokens, buildTurnOverviewRows, hashModelToHue)
// lives in ./turnsOverview.ts so it can be unit-tested without the CSS/DOM
// dependencies this file carries — see that module for its doc comments.

function renderModelOverviewBadge(model: string | null): string {
	if (!model) { return '<span class="overview-model-badge overview-model-unknown">—</span>'; }
	const hue = hashModelToHue(model);
	const style = `background: hsl(${hue}, 55%, 16%); color: hsl(${hue}, 70%, 78%); border-color: hsl(${hue}, 55%, 32%);`;
	return `<span class="overview-model-badge" style="${style}" title="${escapeHtml(model)}">${escapeHtml(getModelDisplayName(model))}</span>`;
}

// Layout flags for the turns-overview table, derived once from its row list.
type TurnsOverviewTableFlags = {
	hasCached: boolean;
	hasModelSwitches: boolean;
	hasCost: boolean;
	totalChildren: number;
	hasLegs: boolean;
	columnCount: number;
};

function computeTurnsOverviewTableFlags(rows: TurnOverviewRow[]): TurnsOverviewTableFlags {
	const hasCached = rows.some(r => r.cached !== null);
	const hasModelSwitches = rows.some((r, i) => i > 0 && r.model && rows[i - 1].model && r.model !== rows[i - 1].model);
	const hasCost = rows.some(r => r.cost !== null || r.children.some(c => c.cost !== null));
	const totalChildren = rows.reduce((sum, r) => sum + r.children.length, 0);
	const hasLegs = rows.some(r => r.legs.length > 0);
	const columnCount = 7 + (hasCached ? 1 : 0) + (hasCost ? 1 : 0);
	return { hasCached, hasModelSwitches, hasCost, totalChildren, hasLegs, columnCount };
}

// Reverse-map chat turn number → this turn's matched HydraFusionTurn, so an expanded
// row can reuse the exact same leg table the HydraFusion section renders above
// (instead of re-deriving markup from the trimmed TurnOverviewLegRow) and show the
// same total: the turn's own rollup `aiu`, not a sum of the legs' individual costs,
// which `analyzeHydraFusionSession` can legitimately differ from (it prefers
// `session.fusion_completed.totalNanoAiu` and only falls back to summing legs when
// that rollup is missing — see buildTurn in src/hydrafusion.ts).
function buildHydraTurnByChatTurnMap(data: SessionLogData, hydraTurnMatches?: Map<number, number>): Map<number, HydraFusionTurn> {
	const hydraTurnByChatTurn = new Map<number, HydraFusionTurn>();
	if (data.hydraFusion && hydraTurnMatches) {
		for (const [hydraIndex, chatTurnNumber] of hydraTurnMatches) {
			const hydraTurn = data.hydraFusion.turns[hydraIndex];
			if (hydraTurn) { hydraTurnByChatTurn.set(chatTurnNumber, hydraTurn); }
		}
	}
	return hydraTurnByChatTurn;
}

/** One Session Steps Overview row plus what rendering it needs from its neighbours. */
type TurnsOverviewItem = {
	row: TurnOverviewRow;
	/** The model differs from the previous step's, in chronological order, so it holds under any sort. */
	switched: boolean;
	hydraTurn: HydraFusionTurn | undefined;
};

const TURNS_OVERVIEW_TABLE_ID = 'logviewer-turns-overview';

/** Steps whose HydraFusion legs are expanded, kept here so a sort or page change keeps them open. */
const expandedOverviewLegs = new Set<number>();

/** What the overview was last rendered with, to find the page that shows a given step. */

function overviewCountCell(html: string): string {
	return `<td class="data-table-align-right count-cell">${html}</td>`;
}

function renderTurnOverviewChildRows(row: TurnOverviewRow, flags: TurnsOverviewTableFlags): string {
	return row.children.map(child => `<tr class="turns-overview-row turns-overview-child-row" data-turn="${row.turnNumber}" title="Sub-agent call from step #${row.turnNumber} — jump to turn">
<td class="turns-overview-num">↳ 🤖</td>
<td><span class="turn-mode turns-overview-child-tool" title="${escapeHtml(child.toolName)}">${escapeHtml(child.toolName)}</span></td>
<td>${renderModelOverviewBadge(child.model)}</td>
${overviewCountCell(formatCompact(child.input))}
${flags.hasCached ? overviewCountCell('—') : ''}
${overviewCountCell(formatCompact(child.output))}
${overviewCountCell(`<strong>${formatCompact(child.total)}</strong>`)}
${flags.hasCost ? overviewCountCell(child.cost !== null ? escapeHtml(formatCost(child.cost)) : '—') : ''}
<td class="data-table-align-center turns-overview-actual" title="Estimated from text">~</td>
</tr>`).join('');
}

function turnsOverviewLegsTableId(turnNumber: number): string {
	return `logviewer-turns-overview-legs-${turnNumber}`;
}

function renderTurnOverviewLegsRow(item: TurnsOverviewItem, columnCount: number): string {
	const { row, hydraTurn } = item;
	if (row.legs.length === 0 || !hydraTurn) { return ''; }
	const hidden = expandedOverviewLegs.has(row.turnNumber) ? '' : ' style="display: none;"';
	return `<tr class="turns-overview-legs-row" data-parent-turn="${row.turnNumber}"${hidden}>
<td colspan="${columnCount}">
<div class="turns-overview-legs-wrap">
<div class="turns-overview-legs-caption">${escapeHtml(localizeFormat('logviewer.hydrafusion.legsCaptionTotal', row.turnNumber))} <strong>${escapeHtml(formatFusionCost(hydraTurn.aiu))}</strong></div>
${renderLegsTable(hydraTurn.phases, turnsOverviewLegsTableId(row.turnNumber))}
</div>
</td>
</tr>`;
}

function renderTurnOverviewStepCell({ row, switched }: TurnsOverviewItem): string {
	const expanded = expandedOverviewLegs.has(row.turnNumber);
	const legToggle = row.legs.length > 0
		? `<button type="button" class="turns-overview-leg-toggle" data-turn="${row.turnNumber}" aria-expanded="${expanded}" aria-label="${escapeHtml(localizeFormat('logviewer.hydrafusion.toggleLegsAriaLabel', row.turnNumber))}" title="${escapeHtml(localize('logviewer.hydrafusion.showLegsTitle'))}">${expanded ? '▾' : '▸'}</button> `
		: '';
	const switchIcon = switched ? ` <span class="overview-switch-icon" title="${escapeHtml(localize('logviewer.hydrafusion.modelChangedTitle'))}">⇄</span>` : '';
	return `${legToggle}#${row.turnNumber}${switchIcon}`;
}

function overviewCountColumn(
	id: string,
	label: string,
	value: (row: TurnOverviewRow) => number | null,
	strong = false,
): DataTableColumn<TurnsOverviewItem> {
	return {
		id, label, align: 'right', className: 'count-cell',
		sortValue: ({ row }) => value(row),
		render: ({ row }) => {
			const amount = value(row);
			const text = amount !== null ? formatCompact(amount) : '—';
			return strong ? { html: `<strong>${escapeHtml(text)}</strong>` } : text;
		},
	};
}

function buildTurnsOverviewColumns(flags: TurnsOverviewTableFlags): DataTableColumn<TurnsOverviewItem>[] {
	const columns: DataTableColumn<TurnsOverviewItem>[] = [
		{
			id: 'step', label: 'Step', className: 'turns-overview-num',
			sortValue: ({ row }) => row.turnNumber,
			render: item => ({ html: renderTurnOverviewStepCell(item) }),
		},
		{
			id: 'mode', label: 'Mode', sortValue: ({ row }) => row.mode,
			render: ({ row }) => ({ html: `<span class="turn-mode" style="background: ${getModeColor(row.mode)};">${getModeIcon(row.mode)} ${escapeHtml(row.mode)}</span>` }),
		},
		{
			id: 'model', label: 'Model', sortValue: ({ row }) => row.model ? getModelDisplayName(row.model) : null,
			render: ({ row }) => ({ html: renderModelOverviewBadge(row.model) }),
		},
		overviewCountColumn('input', 'Input', row => row.input),
	];
	if (flags.hasCached) { columns.push(overviewCountColumn('cached', 'Cached', row => row.cached)); }
	columns.push(
		overviewCountColumn('output', 'Output', row => row.output),
		overviewCountColumn('total', 'Total', row => row.total, true),
	);
	if (flags.hasCost) {
		columns.push({
			id: 'cost', label: localize('logviewer.hydrafusion.cost'), align: 'right', className: 'count-cell',
			sortValue: ({ row }) => row.cost,
			render: ({ row }) => row.cost !== null ? formatCost(row.cost) : '—',
		});
	}
	columns.push({
		id: 'source', label: 'Src', headerHtml: '<span title="✓ actual API usage, ~ estimated from text">Src</span>',
		align: 'center', className: 'turns-overview-actual',
		sortValue: ({ row }) => row.isActual ? 1 : 0,
		render: ({ row }) => ({ html: `<span title="${row.isActual ? 'Actual API usage' : 'Estimated from text'}">${row.isActual ? '✓' : '~'}</span>` }),
	});
	return columns;
}

/**
 * Renders the turns-overview table shown above the chat-turns list: one compact,
 * clickable row per turn with its mode, model, and input/cached/output token
 * usage, so a multi-model session (e.g. model-routing research) can be scanned
 * at a glance without opening every turn card. A row's model badge differing
 * from the one above it is flagged with ⇄ to spot model switches quickly.
 * Clicking a row scrolls to and briefly highlights the matching turn card.
 * Rows start in chronological step order; sub-agent rows and expandable legs
 * travel with their step when the table is sorted or paged.
 *
 * When a turn was routed through HydraFusion (`hydraTurnMatches` places it), its
 * row also gets a ⚡ toggle that expands the same leg-by-leg table shown in the
 * HydraFusion section above — see `matchHydraFusionTurnsToChatTurns`. This is the
 * only difference from a plain session's table: everything else here runs exactly
 * as before for the overwhelming majority of sessions, which never used the router.
 */
function renderTurnsOverviewTable(data: SessionLogData, hydraTurnMatches?: Map<number, number>): string {
	if (data.turns.length === 0) { return ''; }
	const rows = buildTurnOverviewRows(data.turns, data.hydraFusion, hydraTurnMatches);
	const flags = computeTurnsOverviewTableFlags(rows);
	const hydraTurnByChatTurn = buildHydraTurnByChatTurnMap(data, hydraTurnMatches);
	const items: TurnsOverviewItem[] = rows.map((row, i) => {
		const preceding = rows[i - 1];
		return {
			row,
			switched: !!preceding && !!row.model && !!preceding.model && row.model !== preceding.model,
			hydraTurn: hydraTurnByChatTurn.get(row.turnNumber),
		};
	});
	const columns = buildTurnsOverviewColumns(flags);

	return `
<div class="turns-overview">
<div class="turns-overview-header">
<span>🧭 Session Steps Overview (${rows.length})</span>
${flags.hasModelSwitches ? '<span class="overview-switch-note">⇄ marks a model change from the previous step</span>' : ''}
${flags.totalChildren > 0 ? `<span class="overview-switch-note">🤖 ↳ marks a sub-agent/child session delegated from that step</span>` : ''}
${flags.hasLegs ? `<span class="overview-switch-note">${escapeHtml(localize('logviewer.hydrafusion.expandStepNote'))}</span>` : ''}
</div>
${renderDataTable({
	tableId: TURNS_OVERVIEW_TABLE_ID,
	ariaLabel: 'Session Steps Overview',
	rows: items,
	columns,
	className: 'turns-overview-table data-table--nowrap',
	rowOptions: ({ row, switched }) => ({
		className: `turns-overview-row${switched ? ' turns-overview-row-switch' : ''}`,
		attributes: { 'data-turn': String(row.turnNumber), title: `Jump to turn #${row.turnNumber}` },
	}),
	afterRow: item => renderTurnOverviewChildRows(item.row, flags) + renderTurnOverviewLegsRow(item, flags.columnCount),
})}
</div>
`;
}

/** Moves the overview to the page that shows `turnNumber` under its current sort, when it is not on screen. */
function showTurnsOverviewPageFor(turnNumber: number): void {
	revealDataTableRow<TurnsOverviewItem>(TURNS_OVERVIEW_TABLE_ID, item => item.row.turnNumber === turnNumber);
}

/**
 * Applies a click on a tool-summary pill: narrows that turn's tool table to the pill's tool,
 * or shows every call again when the pill was already active.
 */
function handleToolPillClick(pill: HTMLElement): void {
	const turnNumber = pill.getAttribute('data-turn');
	const filter = pill.getAttribute('data-tool-filter');
	const turnCard = document.querySelector<HTMLElement>(`.turn-card[data-turn="${turnNumber}"]`);
	if (!turnCard || turnNumber === null || filter === null) { return; }

	const isActive = pill.classList.contains('active');
	turnCard.querySelectorAll<HTMLElement>('.tool-summary-item, .sub-agent-summary-item').forEach(p => p.classList.remove('active'));
	if (isActive) {
		applyToolCallFilter(turnNumber, null);
		return;
	}
	pill.classList.add('active');
	const detailsEl = turnCard.querySelector<HTMLDetailsElement>('details.tool-calls-details');
	if (detailsEl) { detailsEl.open = true; }
	applyToolCallFilter(turnNumber, filter);
}

function toolCallTarget(link: HTMLElement): { turnNumber: number; toolCallIdx: number } {
	return {
		turnNumber: parseInt(link.getAttribute('data-turn') || '0', 10),
		toolCallIdx: parseInt(link.getAttribute('data-toolcall') || '0', 10),
	};
}

/**
 * One delegated click listener for everything inside the tables (tool calls, tool pills,
 * overview rows and their leg toggles). The tables re-render their rows on every sort or
 * page change, so listeners bound to the rows themselves would be lost.
 */
function handleLogViewerClick(e: MouseEvent): void {
	const target = e.target instanceof Element ? e.target : null;
	if (!target) { return; }

	const sourceLink = target.closest<HTMLElement>('.tool-call-link');
	if (sourceLink) {
		e.preventDefault();
		vscode.postMessage({ command: 'revealToolCallSource', ...toolCallTarget(sourceLink) });
		return;
	}
	const prettyLink = target.closest<HTMLElement>('.tool-call-pretty');
	if (prettyLink) {
		e.preventDefault();
		vscode.postMessage({ command: 'showToolCallPretty', ...toolCallTarget(prettyLink) });
		return;
	}
	const pill = target.closest<HTMLElement>('.tool-summary-item[data-tool-filter], .sub-agent-summary-item[data-tool-filter]');
	if (pill) {
		// The pills sit inside the <summary>; filtering must not also toggle the <details>.
		e.preventDefault();
		handleToolPillClick(pill);
		return;
	}
	// A leg toggle expands its row in place instead of jumping to the turn card.
	const legToggle = target.closest<HTMLElement>('.turns-overview-leg-toggle');
	if (legToggle) {
		setOverviewLegsExpanded(legToggle.getAttribute('data-turn') || '', legToggle.getAttribute('aria-expanded') !== 'true');
		return;
	}
	const overviewRow = target.closest<HTMLElement>('.turns-overview-row');
	if (overviewRow) {
		const turnNumber = parseInt(overviewRow.getAttribute('data-turn') || '0', 10);
		if (turnNumber > 0) { scrollAndFocusTurn(turnNumber); }
	}
}

/** Clicking (or activating with the keyboard) a HydraFusion turn's "jump to step" link scrolls to and expands its row in the Session Steps Overview table below. */
function wireUpHydraFusionHandlers(): void {
document.querySelectorAll<HTMLElement>('.hydra-jump-to-step').forEach(link => {
const activate = (e: Event): void => {
e.preventDefault();
e.stopPropagation();
const turnNumber = parseInt(link.getAttribute('data-turn') || '0', 10);
if (turnNumber > 0) { scrollAndFocusOverviewRow(turnNumber); }
};
link.addEventListener('click', activate);
link.addEventListener('keydown', (e) => {
if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { activate(e); }
});
});
}

let logViewerClicksBound = false;

function wireUpEventHandlers(): void {
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
document.getElementById('btn-refresh-session')?.addEventListener('click', () => {
vscode.postMessage({ command: 'refreshSession' });
});
document.getElementById('file-link')?.addEventListener('click', (e) => {
e.preventDefault();
vscode.postMessage({ command: 'openRawFile' });
});
document.getElementById('open-file-link')?.addEventListener('click', () => {
vscode.postMessage({ command: 'openRawFile' });
});

// Bound once: the document outlives every in-place table re-render.
if (!logViewerClicksBound) {
logViewerClicksBound = true;
document.addEventListener('click', handleLogViewerClick);
}
wireUpHydraFusionHandlers();
}

// ── Entry-point renderers (signatures preserved) ─────────────────────────────

function getTurnTokenAttrs(isJetBrains: boolean, isAntigravity: boolean, isCursor: boolean, isEclipse: boolean): { tooltip: string; suffix: string } {
if (isJetBrains) { return { tooltip: ` title="JetBrains: estimated from user message + assistant text only. Actual API counts and thinking tokens are not available."`, suffix: ' ⓘ' }; }
if (isAntigravity) { return { tooltip: ` title="Antigravity: estimated from transcript content. Actual API counts are not stored locally."`, suffix: ' ⓘ' }; }
if (isCursor) { return { tooltip: ` title="Cursor: per-turn token counts are not stored locally. Output tokens are unavailable and input tokens require the full context window."`, suffix: ' ⓘ' }; }
if (isEclipse) { return { tooltip: ` title="Eclipse: estimated from message + thinking text only. Actual API counts are not stored locally."`, suffix: ' ⓘ' }; }
return { tooltip: '', suffix: '' };
}

function renderTurnCard(turn: ChatTurn, isJetBrains = false, isAntigravity = false, isCursor = false, isEclipse = false): string {
const totalTokens    = turn.inputTokensEstimate + turn.outputTokensEstimate + turn.thinkingTokensEstimate;
const hasThinking    = turn.thinkingTokensEstimate > 0;
const hasActualUsage = !!turn.actualUsage;
const hasMcpTools    = turn.mcpTools.length > 0;

const contextHeaderHtml = renderContextFileBadges(turn.contextReferences);
const toolCallsHtml     = renderToolCallsSection(turn);
const contextRefsHtml   = renderContextRefsSection(turn);
const actualUsageHtml   = renderActualUsageSummary(turn);

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

const { tooltip: tokenTooltip, suffix: tokenSuffix } = getTurnTokenAttrs(isJetBrains, isAntigravity, isCursor, isEclipse);

return `
<div class="turn-card" data-turn="${turn.turnNumber}">
<div class="turn-header">
<div class="turn-meta">
<span class="turn-number">#${turn.turnNumber}</span>
<span class="turn-mode" style="background: ${getModeColor(turn.mode)};">${getModeIcon(turn.mode)} ${turn.mode}</span>
${turn.model ? renderTurnModelBadge(turn.model) : ''}
${turn.thinkingEffort ? `<span class="turn-effort">💡 ${escapeHtml(getEffortDisplayName(turn.thinkingEffort))}</span>` : ''}
${totalTokens > 0 ? `<span class="turn-tokens"${tokenTooltip}>📊 ${formatCompact(totalTokens)} tokens (↑${turn.inputTokensEstimate} ↓${turn.outputTokensEstimate})${tokenSuffix}</span>` : ''}
${hasThinking ? `<span class="turn-tokens" style="color: #a78bfa;">🧠 ${formatCompact(turn.thinkingTokensEstimate)} thinking</span>` : ''}
${hasActualUsage ? `<span class="turn-tokens" style="color: #22c55e;">✓ ${formatCompact(turn.actualUsage!.promptTokens + turn.actualUsage!.completionTokens)} actual</span>` : ''}
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
	setCompactNumbers(data.compactNumbers !== false);
	const root = document.getElementById('root');
	if (!root) { return; }

	const tokenStats = aggregateTokenStats(data);
	const actualStats = aggregateActualUsageStats(data);
	const modeStats = aggregateModeStats(data);

	const summaryStats = buildSummaryStats(tokenStats, actualStats, modeStats);

	_renderLayoutBody(root, data, summaryStats, tokenStats.totalTokens, actualStats);
}

function _renderLayoutBody(
	root: HTMLElement,
	data: SessionLogData,
	summaryStats: SummaryStats,
	totalTokens: number,
	actualStats: ActualUsageStats<ChatTurn>,
): void {
	// Computed once and shared by both renderers below so the HydraFusion section's
	// "jump to step" links and the Session Steps Overview table's expandable legs
	// agree on which turn is which. `undefined` for the overwhelming majority of
	// sessions, which never used HydraFusion — both renderers treat that as "no legs".
	const hydraTurnMatches = data.hydraFusion ? matchHydraFusionTurnsToChatTurns(data.turns, data.hydraFusion.turns) : undefined;

	setHtml(root, `
<style>${themeStyles}</style><style>${dataTableStyles}</style>
<style>${styles}</style>

<div class="container">
${renderEditorInfoPanel(data)}

${renderSummaryCards(data, summaryStats)}

${renderSessionActualUsage(
	data, totalTokens, actualStats.turnsWithActual,
	actualStats.actualPromptTotal, actualStats.actualCompletionTotal, actualStats.actualTotal,
	actualStats.aggregatedBreakdown,
)}

${renderHydraFusionSection(data.hydraFusion, hydraTurnMatches)}

${renderTurnsOverviewTable(data, hydraTurnMatches)}

<div class="turns-header">
<span>📝</span>
<span>Chat Turns (${data.turns.length})${data.title ? ` - ${escapeHtml(data.title)}` : ''}</span>
<vscode-button id="btn-refresh-session" appearance="secondary" style="margin-left: auto;">🔄 Refresh</vscode-button>
</div>

<div class="turns-list">
${data.turns.length > 0 
? data.turns.map(turn => renderTurnCard(turn, data.editorName === 'JetBrains', data.editorName === 'Antigravity', data.editorName === 'Cursor', data.editorName === 'Eclipse')).join('')
: '<div class="empty-state">No chat turns found in this session.</div>'
}
</div>


</div>
`);

	wireUpEventHandlers();
	focusRequestedTurn(data as SessionLogData & { focusedTurnNumber?: number; });
}

/** Scrolls to and briefly highlights the turn card for the given turn number, if it exists. */
function scrollAndFocusTurn(turnNumber: number): void {
	const turnCard = document.querySelector<HTMLElement>(`.turn-card[data-turn="${turnNumber}"]`);
	if (!turnCard) { return; }
	turnCard.classList.add('turn-card-focused');
	turnCard.setAttribute('tabindex', '-1');
	turnCard.focus({ preventScroll: true });
	turnCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
	setTimeout(() => turnCard.classList.remove('turn-card-focused'), 2_000);
}

/** Shows or hides the HydraFusion legs nested under a Session Steps Overview row, syncing its toggle button. */
function setOverviewLegsExpanded(turnNumber: string, expanded: boolean): void {
	const step = Number(turnNumber);
	if (expanded) { expandedOverviewLegs.add(step); } else { expandedOverviewLegs.delete(step); }
	const toggle = document.querySelector<HTMLElement>(`.turns-overview-leg-toggle[data-turn="${turnNumber}"]`);
	const legsRow = document.querySelector<HTMLElement>(`.turns-overview-legs-row[data-parent-turn="${turnNumber}"]`);
	if (!toggle || !legsRow) { return; }
	toggle.setAttribute('aria-expanded', String(expanded));
	toggle.textContent = expanded ? '▾' : '▸';
	legsRow.style.display = expanded ? '' : 'none';
}

/** Scrolls to and briefly highlights a Session Steps Overview row, expanding its legs if it has any. */
function scrollAndFocusOverviewRow(turnNumber: number): void {
	showTurnsOverviewPageFor(turnNumber);
	const row = document.querySelector<HTMLElement>(`.turns-overview-row:not(.turns-overview-child-row)[data-turn="${turnNumber}"]`);
	if (!row) { return; }
	setOverviewLegsExpanded(String(turnNumber), true);
	row.classList.add('turns-overview-row-focused');
	row.scrollIntoView({ behavior: 'smooth', block: 'center' });
	setTimeout(() => row.classList.remove('turns-overview-row-focused'), 2_000);
}

function focusRequestedTurn(data: SessionLogData & { focusedTurnNumber?: number; }): void {
	const turnNumber = data.focusedTurnNumber;
	if (typeof turnNumber !== 'number' || !Number.isSafeInteger(turnNumber) || turnNumber < 1) { return; }
	scrollAndFocusTurn(turnNumber);
}

async function bootstrap(): Promise<void> {
await import('@vscode-elements/elements/dist/vscode-button/index.js');

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