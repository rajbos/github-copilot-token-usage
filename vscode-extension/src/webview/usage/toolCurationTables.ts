import type { AvailableToolEntry, ToolCurationAnalysis } from '../../../../src/types';
import { escapeHtml, formatNumber } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { getDataTableState, renderDataTable, renderDataTableFilter, type DataTableColumn } from '../shared/dataTable';

type McpServerEntry = ToolCurationAnalysis['underusedMcpServers'][number];

export type CurationTableId = 'mcp' | 'builtin' | 'skills';

const curationLinkStyle = 'background:none;border:none;padding:0;cursor:pointer;color:var(--link-color);font-size:11px;text-decoration:underline;';
const defaultMcpConfigLink = '<code>.vscode/mcp.json</code>'; // i18n-exempt: configuration filename, not translatable prose.

export function estimateToolOverheadTokens(name: string, description: string | undefined): number {
	return Math.round((name.length + (description?.length ?? 0) + 10) / 4);
}

export function getSkillSourceLabel(skill: AvailableToolEntry): string {
	if (skill.pluginName) { return localizeFormat('usage.toolCuration.source.plugin', skill.pluginName); }
	if (!skill.skillPath) { return '—'; }
	if (skill.skillPath.startsWith('.github/skills')) { return localize('usage.toolCuration.source.workspaceGithub'); }
	if (skill.skillPath.startsWith('.claude/skills')) { return localize('usage.toolCuration.source.workspaceClaude'); }
	if (skill.skillPath.startsWith('.agents/skills')) { return localize('usage.toolCuration.source.workspaceAgents'); }
	return localize('usage.toolCuration.source.user');
}

function mcpSourceLabel(server: McpServerEntry): string {
	if (server.extensionId) { return localize('usage.toolCuration.source.extension'); }
	if (!server.configFiles || server.configFiles.length === 0) { return localize('usage.toolCuration.source.settings'); }
	const labels = new Set<string>();
	for (const file of server.configFiles) {
		const path = file.replace(/\\/g, '/');
		if (path.includes('/.vscode/')) { labels.add(localize('usage.toolCuration.source.workspace')); }
		else if (path.includes('/.vs/')) { labels.add(localize('usage.toolCuration.source.workspaceVisualStudio')); }
		else if (path.includes('/.cursor/')) { labels.add(localize('usage.toolCuration.source.workspaceCursor')); }
		else if (path.endsWith('/.mcp.json')) { labels.add(path.split('/').slice(-2).join('/')); }
		else { labels.add(localize('usage.toolCuration.source.configFile')); }
	}
	return [...labels].join(', ');
}

function mcpSourceOpenButton(server: McpServerEntry, sourceTip: string): string {
	if (server.configFiles && server.configFiles.length === 1) {
		return ` <button class="curation-file-btn" data-command="openFile" data-path="${escapeHtml(server.configFiles[0])}" style="${curationLinkStyle}" title="${escapeHtml(localizeFormat('usage.toolCuration.action.openFileTitle', server.configFiles[0]))}">${escapeHtml(localize('usage.toolCuration.action.open'))}</button>`;
	}
	if (server.configFiles && server.configFiles.length > 1) {
		return ` <button class="curation-file-btn" data-command="openFileFromList" data-paths="${escapeHtml(JSON.stringify(server.configFiles))}" style="${curationLinkStyle}" title="${escapeHtml(sourceTip)}">${escapeHtml(localize('usage.toolCuration.action.open'))}</button>`;
	}
	if (server.extensionId) {
		return ` <button class="curation-file-btn" data-command="manageExtension" data-extension-id="${escapeHtml(server.extensionId)}" style="${curationLinkStyle}" title="${escapeHtml(localizeFormat('usage.toolCuration.action.openExtensionsFor', server.extensionId))}">${escapeHtml(localize('usage.toolCuration.action.open'))}</button>`;
	}
	return ` <button class="curation-file-btn" data-command="searchMcpExtensions" style="${curationLinkStyle}" title="${escapeHtml(localize('usage.toolCuration.action.browseMcp'))}">${escapeHtml(localize('usage.toolCuration.action.open'))}</button>`;
}

function mcpActionButton(server: McpServerEntry): string {
	if (server.extensionId) {
		return `<button class="curation-file-btn" data-command="manageExtension" data-extension-id="${escapeHtml(server.extensionId)}" style="${curationLinkStyle}" title="${escapeHtml(localizeFormat('usage.toolCuration.action.manageExtensionTitle', server.extensionId))}">${escapeHtml(localize('usage.toolCuration.action.manageExtension'))}</button>`;
	}
	if (!server.configFiles || server.configFiles.length === 0) {
		return `<button class="curation-file-btn" data-command="openToolPicker" style="${curationLinkStyle}" title="${escapeHtml(localize('usage.toolCuration.action.openToolPickerTitle'))}">${escapeHtml(localize('usage.toolCuration.action.changeTools'))}</button>`;
	}
	if (server.configFiles.length === 1) {
		return `<button class="curation-file-btn" data-command="openFile" data-path="${escapeHtml(server.configFiles[0])}" style="${curationLinkStyle}" title="${escapeHtml(localizeFormat('usage.toolCuration.action.openFileTitle', server.configFiles[0]))}">${escapeHtml(localize('usage.toolCuration.action.changeTools'))}</button>`;
	}
	return `<button class="curation-file-btn" data-command="openFileFromList" data-paths="${escapeHtml(JSON.stringify(server.configFiles))}" style="${curationLinkStyle}" title="${escapeHtml(localizeFormat('usage.toolCuration.action.definedInFiles', server.configFiles.length))}">${escapeHtml(localize('usage.toolCuration.action.changeTools'))}</button>`;
}

function renderMcpTable(servers: McpServerEntry[], bloat: ToolCurationAnalysis['estimatedPromptBloat']): string {
	const columns: DataTableColumn<McpServerEntry>[] = [
		{
			id: 'default',
			label: '',
			hidden: true,
			sortValue: server => {
				const bucket = server.usedToolCount === 0 ? 0 : server.usedToolCount < server.availableToolCount ? 1 : 2;
				return `${bucket}:${String(server.usedToolCount).padStart(12, '0')}`;
			},
			render: () => '',
		},
		{ id: 'server', label: localize('usage.toolCuration.column.server'), sortValue: server => server.server, render: server => server.server },
		{
			id: 'source', label: localize('usage.toolCuration.column.source'), sortValue: mcpSourceLabel,
			render: server => {
				const sourceTip = server.configFiles?.join('\n') ?? server.extensionId ?? '';
				return { html: `<span title="${escapeHtml(sourceTip)}">${escapeHtml(mcpSourceLabel(server))}</span>${mcpSourceOpenButton(server, sourceTip)}` };
			},
		},
		{
			id: 'available', label: localize('usage.toolCuration.column.available'),
			sortValue: server => server.availableToolCount === 0 ? null : server.availableToolCount,
			render: server => server.availableToolCount === 0 ? { html: `<em style="color:var(--text-secondary)">${escapeHtml(localize('usage.toolCuration.status.notConnected'))}</em>` } : String(server.availableToolCount),
		},
		{
			id: 'used', label: localize('usage.toolCuration.column.used'),
			sortValue: server => server.availableToolCount === 0 ? null : server.usedToolCount,
			render: server => server.availableToolCount === 0 ? '—' : String(server.usedToolCount),
		},
		{
			id: 'overhead', label: localize('usage.toolCuration.column.overhead'), align: 'right',
			sortValue: server => bloat.byServer[server.server] ?? 0,
			render: server => {
				const tokens = bloat.byServer[server.server] ?? 0;
				return tokens > 0 ? `~${formatNumber(tokens)} tokens` : '—';
			},
		},
		{ id: 'action', label: localize('usage.toolCuration.column.action'), render: server => ({ html: mcpActionButton(server) }) },
	];
	return renderDataTable({
		tableId: 'mcp',
		ariaLabel: localize('usage.toolCuration.aria.mcp'),
		rows: servers,
		columns,
		initialSort: { columnId: 'default', direction: 'asc' },
		defaultFilters: { hideWithUsage: true },
		filterRows: (server, filters) => !filters.hideWithUsage || server.usedToolCount === 0,
	});
}

function renderSkillsTable(skills: AvailableToolEntry[]): string {
	const columns: DataTableColumn<AvailableToolEntry>[] = [
		{ id: 'name', label: localize('usage.toolCuration.column.skill'), sortValue: skill => skill.name, render: skill => skill.name },
		{
			id: 'source', label: localize('usage.toolCuration.column.source'), sortValue: getSkillSourceLabel,
			render: skill => {
				const label = getSkillSourceLabel(skill);
				const manage = skill.pluginName
					? ` <button class="curation-file-btn" data-command="openAgentPlugins" data-plugin-name="${escapeHtml(skill.pluginName)}" style="${curationLinkStyle}" title="${escapeHtml(localize('usage.toolCuration.action.managePluginsTitle'))}">${escapeHtml(localize('usage.toolCuration.action.manage'))}</button>`
					: '';
				return { html: `${escapeHtml(label)}${manage}` };
			},
		},
		{
			id: 'description', label: localize('usage.toolCuration.column.description'), sortValue: skill => skill.description,
			render: skill => ({ html: `<span class="data-table-truncate" title="${escapeHtml(skill.description)}">${escapeHtml(skill.description)}</span>` }),
		},
		{
			id: 'overhead', label: localize('usage.toolCuration.column.overhead'), align: 'right',
			sortValue: skill => estimateToolOverheadTokens(skill.name, skill.description),
			render: skill => `~${formatNumber(estimateToolOverheadTokens(skill.name, skill.description))} tokens`,
		},
		{
			id: 'view', label: localize('usage.toolCuration.column.view'),
			render: skill => {
				const file = skill.configFiles?.[0];
				return file
					? { html: `<button class="curation-file-btn" data-command="openFile" data-path="${escapeHtml(file)}" style="${curationLinkStyle}" title="${escapeHtml(localizeFormat('usage.toolCuration.action.openFileTitle', file))}">${escapeHtml(localize('usage.toolCuration.action.viewSkill'))}</button>` }
					: '—';
			},
		},
	];
	return renderDataTable({
		tableId: 'skills',
		ariaLabel: localize('usage.toolCuration.aria.skills'),
		rows: skills,
		columns,
		initialSort: { columnId: 'overhead', direction: 'desc' },
	});
}

function renderBuiltinTable(tools: AvailableToolEntry[]): string {
	const columns: DataTableColumn<AvailableToolEntry>[] = [
		{ id: 'name', label: localize('usage.toolCuration.column.tool'), sortValue: tool => tool.name, render: tool => tool.name },
		{
			id: 'description', label: localize('usage.toolCuration.column.description'), sortValue: tool => tool.description,
			render: tool => ({ html: `<span class="data-table-truncate" title="${escapeHtml(tool.description)}">${escapeHtml(tool.description || '—')}</span>` }),
		},
		{
			id: 'overhead', label: localize('usage.toolCuration.column.overhead'), align: 'right',
			sortValue: tool => estimateToolOverheadTokens(tool.name, tool.description),
			render: tool => `~${formatNumber(estimateToolOverheadTokens(tool.name, tool.description))} tokens`,
		},
	];
	return renderDataTable({
		tableId: 'builtin',
		ariaLabel: localize('usage.toolCuration.aria.builtin'),
		rows: tools,
		columns,
		initialSort: { columnId: 'overhead', direction: 'desc' },
	});
}

export function renderCurationTable(tableId: CurationTableId, analysis: ToolCurationAnalysis): string {
	switch (tableId) {
		case 'mcp':
			return renderMcpTable(analysis.underusedMcpServers, analysis.estimatedPromptBloat);
		case 'builtin':
			return renderBuiltinTable(analysis.availableTools.filter(tool => tool.source === 'builtin'));
		case 'skills':
			return renderSkillsTable(analysis.unusedTools.filter(tool => tool.source === 'skill'));
	}
}

export function buildUnusedMcpHtml(
	servers: ToolCurationAnalysis['underusedMcpServers'],
	bloat: ToolCurationAnalysis['estimatedPromptBloat'],
	windowDays: number,
): string {
	if (servers.length === 0) { return ''; }
	const mcpJsonLink = [...new Set(servers.filter(server => !server.extensionId).flatMap(server => server.configFiles ?? []))]
		.find(file => file.replace(/\\/g, '/').endsWith('.vscode/mcp.json'))
		?? servers.filter(server => !server.extensionId).flatMap(server => server.configFiles ?? [])[0];
	const configLink = mcpJsonLink
		? `<button class="curation-file-btn" data-command="openFile" data-path="${escapeHtml(mcpJsonLink)}" style="${curationLinkStyle}" title="${escapeHtml(mcpJsonLink)}">${escapeHtml(mcpJsonLink.replace(/\\/g, '/').split('/').slice(-3).join('/'))}</button>`
		: defaultMcpConfigLink;
	const unusedCount = servers.filter(server => server.usedToolCount === 0).length;
	const usedCount = servers.length - unusedCount;
	const state = getDataTableState('mcp', { sort: { columnId: 'default', direction: 'asc' }, filters: { hideWithUsage: true } });
	return `<details style="margin-top:12px;" open>
		<summary style="cursor:pointer; font-size:13px; font-weight:600; color:var(--text-primary); padding:6px 0;">${escapeHtml(localizeFormat('usage.toolCuration.summary.mcp', windowDays, servers.length))}</summary>
		<div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin:6px 0;">
			${renderDataTableFilter({ tableId: 'mcp', filterId: 'hideWithUsage', id: 'mcp-hide-toggle', label: localize('usage.toolCuration.filter.hideServersWithUsage'), checked: state.filters.hideWithUsage === true })}
			<span style="font-size:11px; color:var(--text-secondary);">${escapeHtml(localizeFormat('usage.toolCuration.summary.mcpCounts', unusedCount, usedCount))}</span>
		</div>
		<div style="margin-top:8px;">${renderMcpTable(servers, bloat)}</div>
		<div style="margin-top:8px; font-size:11px; color:var(--text-secondary);">${localizeFormat('usage.toolCuration.help.mcp', configLink, escapeHtml(localize('usage.toolCuration.action.manageExtension')))}</div>
	</details>`;
}

export function buildUnusedSkillsHtml(skills: AvailableToolEntry[]): string {
	if (skills.length === 0) { return ''; }
	return `<details style="margin-top:8px;" open>
		<summary style="cursor:pointer; font-size:13px; font-weight:600; color:var(--text-primary); padding:6px 0;">${escapeHtml(localizeFormat('usage.toolCuration.summary.unusedSkills', skills.length))}</summary>
		<div style="margin-top:8px;">${renderSkillsTable(skills)}</div>
		<div style="margin-top:8px; font-size:11px; color:var(--text-secondary);">${localizeFormat('usage.toolCuration.help.unusedSkills', escapeHtml(localize('usage.toolCuration.action.manage')))}</div>
	</details>`;
}

export function buildBuiltinToolsHtml(
	tools: AvailableToolEntry[],
	bloat: ToolCurationAnalysis['estimatedPromptBloat'],
): string {
	if (tools.length === 0) { return ''; }
	const builtinBloat = bloat.byServer.builtin ?? 0;
	const formattedBloat = builtinBloat >= 1000 ? `~${Math.round(builtinBloat / 1000)}K` : `~${builtinBloat}`;
	return `<details id="builtin-tools-details" style="margin-top:12px;">
		<summary style="cursor:pointer; font-size:13px; font-weight:600; color:var(--text-primary); padding:6px 0;">${escapeHtml(localizeFormat('usage.toolCuration.summary.builtin', tools.length, formattedBloat))}</summary>
		<div style="margin-top:8px;">${renderBuiltinTable(tools)}</div>
		<div style="margin-top:8px; font-size:11px; color:var(--text-secondary);">${escapeHtml(localize('usage.toolCuration.help.builtin'))}</div>
	</details>`;
}
