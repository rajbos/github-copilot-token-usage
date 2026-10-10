/**
 * Column definitions and renderers for the smaller Usage Analysis list tables: the tool call
 * counts, the missed-potential workspaces, the agent plugins and the memory files rollup.
 *
 * Split out of main.ts, which sits against the repository's `max-lines` ceiling. Every table here
 * is pure markup over its rows; anything that depends on main.ts module state (tool name lookup,
 * the automatic-tool set) arrives as an argument.
 */
import type { MemoryFilesAnalysisView, ToolCurationAnalysis } from '../../../../src/types';
import { getDataTableState, renderDataTable, renderDataTableFilter, type DataTableColumn, type DataTableFooterRow } from '../shared/dataTable';
import { escapeHtml, formatAbsoluteDate, formatFileSize, formatNumber } from '../shared/formatUtils';
import { localize } from '../shared/localization';

// ── Tool call counts ─────────────────────────────────────────────────────────

interface ToolCountRow { tool: string; name: string; count: number; rank: number; }

export interface ToolCountTableOptions {
	tableId: string;
	ariaLabel: string;
	/** Tool id → call count, already filtered and limited by the caller, sorted by count. */
	entries: ReadonlyArray<[string, number]>;
	nameResolver: (id: string) => string;
	isAutomatic: (id: string) => boolean;
}

export function renderToolCountTable(options: ToolCountTableOptions): string {
	const rows: ToolCountRow[] = options.entries.map(([tool, count], index) => ({ tool, name: options.nameResolver(tool), count, rank: index + 1 }));
	const columns: DataTableColumn<ToolCountRow>[] = [
		{ id: 'rank', label: '#', align: 'center', width: '40px', sortValue: row => row.rank, firstSortDirection: 'asc', render: row => String(row.rank) },
		{
			id: 'tool', label: 'Tool', className: 'data-table-wrap-anywhere', sortValue: row => row.name,
			render: row => {
				const autoBadge = options.isAutomatic(row.tool)
					? `<span class="auto-badge" title="Automatic tool — Copilot uses this internally and it does not count toward fluency scoring">auto</span>`
					: '';
				return { html: `<strong title="${escapeHtml(row.tool)}">${escapeHtml(row.name)}</strong>${autoBadge}` };
			},
		},
		{ id: 'calls', label: 'Calls', align: 'right', width: '90px', sortValue: row => row.count, render: row => formatNumber(row.count) },
	];
	return renderDataTable({
		tableId: options.tableId,
		ariaLabel: options.ariaLabel,
		rows,
		columns,
		initialSort: { columnId: 'calls', direction: 'desc' },
		className: 'data-table--fixed',
	});
}

// ── Missed potential (non-Copilot instruction files) ─────────────────────────

export interface MissedPotentialRow {
	workspaceName: string;
	sessionCount: number;
	interactionCount: number;
	nonCopilotFiles: ReadonlyArray<{ icon?: string; label?: string; relativePath: string }>;
}

function nonCopilotFilesHtml(row: MissedPotentialRow): string {
	const files = row.nonCopilotFiles.map(f => `
		<div style="font-size: 11px; display: flex; align-items: center; gap: 6px;">
			<span>${escapeHtml(f.icon || '📄')}</span>
			<span style="font-weight: 500;">${escapeHtml(f.label || '')}:</span>
			<span style="font-family: monospace; color: var(--text-muted);">${escapeHtml(f.relativePath)}</span>
		</div>`).join('');
	return `<div style="display: flex; flex-direction: column; gap: 4px;">${files}</div>`;
}

/** No initialSort: the host already orders the workspaces. */
export function renderMissedPotentialTable(rows: readonly MissedPotentialRow[]): string {
	return renderDataTable<MissedPotentialRow>({
		tableId: 'missed-potential',
		ariaLabel: 'Missed Potential: Non-Copilot Instruction Files',
		rows,
		columns: [
			{ id: 'workspace', label: '📂 Workspace', className: 'customization-workspace-name', sortValue: row => row.workspaceName, render: row => row.workspaceName },
			{ id: 'sessions', label: 'Sessions', align: 'right', sortValue: row => row.sessionCount, render: row => formatNumber(row.sessionCount) },
			{ id: 'interactions', label: 'Interactions', align: 'right', sortValue: row => row.interactionCount, render: row => formatNumber(row.interactionCount) },
			{ id: 'files', label: 'Non-Copilot Files Found', sortValue: row => row.nonCopilotFiles.length, render: row => ({ html: nonCopilotFilesHtml(row) }) },
		],
	});
}

// ── Agent plugins ────────────────────────────────────────────────────────────

type AgentPluginRow = ToolCurationAnalysis['underusedAgentPlugins'][number];

export const AGENT_PLUGINS_TABLE_ID = 'agent-plugins';
const HIDE_WITH_USAGE = 'hideWithUsage';

/** The "Hide plugins with usage" toggle; it lives outside the table, next to the usage counts. */
export function renderAgentPluginsFilter(): string {
	const state = getDataTableState(AGENT_PLUGINS_TABLE_ID, { filters: { [HIDE_WITH_USAGE]: true } });
	return renderDataTableFilter({
		tableId: AGENT_PLUGINS_TABLE_ID,
		filterId: HIDE_WITH_USAGE,
		id: 'plugin-hide-toggle',
		label: 'Hide plugins with usage',
		checked: state.filters[HIDE_WITH_USAGE] === true,
	});
}

/** No initialSort: the host already lists unused plugins first. */
export function renderAgentPluginsTable(plugins: readonly AgentPluginRow[], ariaLabel: string): string {
	const linkStyle = 'background:none;border:none;padding:0;cursor:pointer;color:var(--link-color);font-size:11px;text-decoration:underline;';
	return renderDataTable<AgentPluginRow>({
		tableId: AGENT_PLUGINS_TABLE_ID,
		ariaLabel,
		rows: plugins,
		columns: [
			{ id: 'plugin', label: 'Plugin', sortValue: p => p.pluginName, render: p => ({ html: `<span style="white-space:nowrap;">${escapeHtml(p.pluginName)}</span>` }) },
			{ id: 'available', label: 'Skills Available', align: 'right', sortValue: p => p.availableSkillCount, render: p => String(p.availableSkillCount) },
			{ id: 'used', label: 'Skills Used', align: 'right', sortValue: p => p.usedSkillCount, render: p => String(p.usedSkillCount) },
			{
				id: 'action', label: 'Action',
				render: p => ({ html: `<button class="curation-file-btn" data-command="openAgentPlugins" data-plugin-name="${escapeHtml(p.pluginName)}" style="${linkStyle}" title="Open Extensions view filtered to @agentPlugins ${escapeHtml(p.pluginName)}">Manage Plugin</button>` }),
			},
		],
		defaultFilters: { [HIDE_WITH_USAGE]: true },
		filterRows: (p, filters) => !filters[HIDE_WITH_USAGE] || p.usedSkillCount === 0,
	});
}

// ── Memory files ─────────────────────────────────────────────────────────────

type MemoryWorkspaceRow = MemoryFilesAnalysisView['byWorkspace'][number];

function memoryWorkspaceName(ws: MemoryWorkspaceRow): string {
	// The __user__ bucket is the only one that ever carries userCount > 0; its data-layer
	// workspaceName ("User (global)", used verbatim by the CLI report) is not localized, so
	// render the localized label here instead.
	return ws.userCount > 0
		? localize('memoryFiles.globalWorkspaceLabel')
		: ws.workspaceName ?? ws.workspaceHash ?? localize('memoryFiles.unknownWorkspace');
}

export function renderMemoryFilesTable(rows: readonly MemoryWorkspaceRow[]): string {
	const warn = 'var(--vscode-editorWarning-foreground, #cca700)';
	return renderDataTable<MemoryWorkspaceRow>({
		tableId: 'memory-files',
		ariaLabel: localize('memoryFiles.sectionTitle'),
		rows,
		columns: [
			{ id: 'workspace', label: localize('memoryFiles.table.workspace'), sortValue: memoryWorkspaceName, render: memoryWorkspaceName },
			{ id: 'repo', label: localize('memoryFiles.table.repo'), align: 'right', sortValue: ws => ws.repoCount, render: ws => String(ws.repoCount) },
			{ id: 'session', label: localize('memoryFiles.table.session'), align: 'right', sortValue: ws => ws.sessionCount, render: ws => String(ws.sessionCount) },
			{ id: 'global', label: localize('memoryFiles.table.global'), align: 'right', sortValue: ws => ws.userCount, render: ws => String(ws.userCount) },
			{ id: 'size', label: localize('memoryFiles.table.size'), align: 'right', sortValue: ws => ws.totalBytes, render: ws => formatFileSize(ws.totalBytes) },
			{
				id: 'stale', label: localize('memoryFiles.table.stale'), align: 'right', sortValue: ws => ws.staleFileCount,
				render: ws => ws.staleFileCount > 0 ? { html: `<span style="color:${warn};">${ws.staleFileCount}</span>` } : String(ws.staleFileCount),
			},
			{
				// newestMtimeMs is nullable (no files at all), not merely falsy — a real epoch
				// timestamp of 0 must still be formatted, not treated as "no data".
				id: 'lastUpdated', label: localize('memoryFiles.table.lastUpdated'), align: 'right', sortValue: ws => ws.newestMtimeMs,
				render: ws => ws.newestMtimeMs !== null ? formatAbsoluteDate(ws.newestMtimeMs) : '—',
			},
		],
		initialSort: { columnId: 'size', direction: 'desc' },
	});
}

// ── Repository hygiene: repository list ──────────────────────────────────────

export interface RepoHygieneListRow {
	workspaceName: string;
	workspacePath: string;
	sessions: number;
	interactions: number;
	/** Display label, e.g. "85%" or "—" when not analysed yet. */
	scoreLabel: string;
	action: 'analyze' | 'details';
	actionLabel: string;
	actionDisabled: boolean;
	actionSecondary: boolean;
}

export interface RepoHygieneListOptions {
	rows: readonly RepoHygieneListRow[];
	/** The long-tail group collapsed into one footer row with a "Show all" button. */
	other?: { count: number; sessions: number; interactions: number };
	/** Adds a footer row with a "Show less" button (the long tail is currently expanded). */
	showCollapse?: boolean;
}

export const REPO_HYGIENE_LIST_TABLE_ID = 'repo-hygiene-list';

function repoActionButtonHtml(row: RepoHygieneListRow): string {
	return `<vscode-button class="btn-repo-action" data-action="${row.action}" data-workspace-path="${escapeHtml(row.workspacePath)}"${row.actionDisabled ? ' disabled="true"' : ''}${row.actionSecondary ? ' appearance="secondary"' : ''} style="width: 110px;">${escapeHtml(row.actionLabel)}</vscode-button>`;
}

function repoHygieneFooterRows(options: RepoHygieneListOptions): DataTableFooterRow[] {
	if (options.other) {
		const other = options.other;
		return [{
			className: 'repo-item-other',
			cells: {
				repo: { html: `<span class="data-table-muted" style="font-style: italic; font-weight: 400;">Other (${other.count} repositor${other.count === 1 ? 'y' : 'ies'} with low activity)</span>` },
				sessions: String(other.sessions),
				interactions: String(other.interactions),
				score: '—',
				action: { html: '<vscode-button id="btn-show-other-workspaces" appearance="secondary" style="width: 110px;">Show all</vscode-button>' },
			},
		}];
	}
	if (options.showCollapse) {
		return [{ className: 'repo-item-other', cells: { action: { html: '<vscode-button id="btn-collapse-other-workspaces" appearance="secondary" style="width: 110px;">Show less</vscode-button>' } } }];
	}
	return [];
}

/** No initialSort: the host order (busiest repositories first) is the default. */
export function renderRepoHygieneListTable(options: RepoHygieneListOptions): string {
	return renderDataTable<RepoHygieneListRow>({
		tableId: REPO_HYGIENE_LIST_TABLE_ID,
		ariaLabel: 'Repository List',
		rows: options.rows,
		className: 'data-table--fixed',
		rowOptions: () => ({ className: 'repo-item' }),
		footerRows: repoHygieneFooterRows(options),
		columns: [
			{
				id: 'repo', label: 'Repository', sortValue: row => row.workspaceName,
				cellTitle: row => row.workspacePath,
				render: row => ({ html: `<span class="repo-name customization-workspace-name" style="font-weight: 600;">${escapeHtml(row.workspaceName)}</span>` }),
			},
			{ id: 'sessions', label: 'Sessions', align: 'right', width: '80px', sortValue: row => row.sessions, render: row => String(row.sessions) },
			{ id: 'interactions', label: 'Interactions', align: 'right', width: '100px', sortValue: row => row.interactions, render: row => String(row.interactions) },
			{
				id: 'score', label: 'Score', align: 'right', width: '70px',
				sortValue: row => { const value = Number.parseFloat(row.scoreLabel); return Number.isFinite(value) ? value : null; },
				render: row => row.scoreLabel,
			},
			{ id: 'action', label: '', width: '130px', render: row => ({ html: repoActionButtonHtml(row) }) },
		],
	});
}
