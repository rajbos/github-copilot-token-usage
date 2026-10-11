import test from 'node:test';
import * as assert from 'node:assert/strict';

import type { AvailableToolEntry, ToolCurationAnalysis } from '../../../src/types';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import { getDataTablePage, setDataTableFilter, type DataTableColumn } from '../../src/webview/shared/dataTable';
import {
	buildBuiltinToolsHtml,
	buildUnusedMcpHtml,
	buildUnusedSkillsHtml,
	estimateToolOverheadTokens,
	getSkillSourceLabel,
} from '../../src/webview/usage/toolCurationTables';

initializeWebviewLocalization({});

function tool(name: string, source: AvailableToolEntry['source'], extra: Partial<AvailableToolEntry> = {}): AvailableToolEntry {
	return { name, description: `${name} description`, source, ...extra };
}

function analysis(overrides: Partial<ToolCurationAnalysis> = {}): ToolCurationAnalysis {
	return {
		windowDays: 30,
		availableTools: [],
		usedTools: [],
		unusedTools: [],
		underusedMcpServers: [],
		underusedAgentPlugins: [],
		estimatedPromptBloat: { totalTokens: 0, byServer: {} },
		recommendations: [],
		...overrides,
	};
}

test('toolCurationTables: MCP default order preserves the zero, partial, full usage buckets', () => {
	const servers: ToolCurationAnalysis['underusedMcpServers'] = [
		{ server: 'partial', availableToolCount: 3, usedToolCount: 1 },
		{ server: 'zero-b', availableToolCount: 2, usedToolCount: 0 },
		{ server: 'zero-a', availableToolCount: 1, usedToolCount: 0 },
		{ server: 'full', availableToolCount: 2, usedToolCount: 2 },
		{ server: 'not-connected', availableToolCount: 0, usedToolCount: 0 },
	];
	buildUnusedMcpHtml(servers, { totalTokens: 0, byServer: {} }, 30);
	setDataTableFilter('mcp', 'hideWithUsage', false);
	const html = buildUnusedMcpHtml(servers, { totalTokens: 0, byServer: {} }, 30);
	const order = ['zero-b', 'zero-a', 'not-connected', 'partial', 'full'].map(name => html.indexOf(`>${name}</td>`));
	assert.ok(order.every(index => index >= 0));
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
	assert.match(html, /MCP Servers in Last 30 Days \(5\)/);
	assert.match(html, /3 with no usage · 2 with usage/);
	assert.match(html, /data-table-filter="hideWithUsage"/);
	assert.doesNotMatch(html, /data-table-filter="hideWithUsage" checked/);
});

test('toolCurationTables: disconnected numeric values remain last in either sort direction', () => {
	const values = [{ name: 'connected', count: 2 }, { name: 'disconnected', count: null }, { name: 'small', count: 1 }];
	type NumericRow = typeof values[number];
	const column: DataTableColumn<NumericRow>[] = [{ id: 'count', label: 'Count', sortValue: row => row.count, render: row => row.name }];
	for (const direction of ['asc', 'desc'] as const) {
		const page = getDataTablePage(values, column, {
			sortColumn: 'count',
			sortDirection: direction,
			page: 1,
			filters: {},
		});
		assert.equal(page.rows.at(-1)?.name, 'disconnected');
	}
});

test('toolCurationTables: hide-with-usage filtering happens before pagination', () => {
	const servers = Array.from({ length: 25 }, (_, index) => ({
		server: `server-${index}`,
		availableToolCount: 1,
		usedToolCount: index % 2,
	}));
	type Server = typeof servers[number];
	const columns: DataTableColumn<Server>[] = [{ id: 'name', label: 'Name', sortValue: server => server.server, render: server => server.server }];
	const filtered = getDataTablePage(servers, columns, {
		sortColumn: 'name',
		sortDirection: 'asc',
		page: 1,
		filters: { hideWithUsage: true },
	}, { filterRows: (server, filters) => !filters.hideWithUsage || server.usedToolCount === 0 });
	assert.equal(filtered.filteredCount, 13);
	assert.equal(filtered.pageCount, 2);
	assert.ok(filtered.rows.every(server => server.usedToolCount === 0));
});

test('toolCurationTables: built-in tools default to estimated overhead descending', () => {
	const tools = [
		tool('small', 'builtin', { description: 'tiny' }),
		tool('large', 'builtin', { description: 'a much longer built-in tool description' }),
	];
	const html = buildBuiltinToolsHtml(tools, { totalTokens: 0, byServer: { builtin: 0 } });
	assert.ok(html.indexOf('large') < html.indexOf('small'));
	assert.match(html, /Built-in VS Code Tools/);
	assert.match(html, /not actionable/);
});

test('toolCurationTables: unused skills default to overhead and keep action metadata', () => {
	const pluginSkill = tool('plugin skill', 'skill', {
		pluginName: 'sample-plugin',
		configFiles: ['.copilot/plugins/sample/SKILL.md'],
	});
	const fileSkill = tool('workspace skill', 'skill', {
		skillPath: '.github/skills/example/SKILL.md',
		configFiles: ['.github/skills/example/SKILL.md'],
	});
	const html = buildUnusedSkillsHtml([fileSkill, pluginSkill]);
	assert.ok(html.indexOf('workspace skill') < html.indexOf('plugin skill'));
	assert.match(html, /data-command="openAgentPlugins" data-plugin-name="sample-plugin"/);
	assert.match(html, /data-command="openFile" data-path="\.github\/skills\/example\/SKILL\.md"/);
	assert.match(html, /data-command="openFile" data-path="\.copilot\/plugins\/sample\/SKILL\.md"/);
	assert.match(html, /class="data-table-sort"[^>]*data-table-sort="overhead"/);
});

test('toolCurationTables: source labels cover workspace, user, and plugin skills', () => {
	assert.equal(getSkillSourceLabel(tool('g', 'skill', { skillPath: '.github/skills/a/SKILL.md' })), 'Workspace (.github)');
	assert.equal(getSkillSourceLabel(tool('c', 'skill', { skillPath: '.claude/skills/a/SKILL.md' })), 'Workspace (.claude)');
	assert.equal(getSkillSourceLabel(tool('a', 'skill', { skillPath: '.agents/skills/a/SKILL.md' })), 'Workspace (.agents)');
	assert.equal(getSkillSourceLabel(tool('u', 'skill', { skillPath: '~/.copilot/skills/a/SKILL.md' })), 'User (~)');
	assert.equal(getSkillSourceLabel(tool('p', 'skill', { pluginName: 'demo' })), 'Plugin: demo');
	assert.equal(estimateToolOverheadTokens('name', 'description'), Math.round(('name'.length + 'description'.length + 10) / 4));
});

test('toolCurationTables: MCP action buttons retain command and path metadata', () => {
	const servers: ToolCurationAnalysis['underusedMcpServers'] = [
		{ server: 'file', availableToolCount: 1, usedToolCount: 0, configFiles: ['.vscode/mcp.json'] },
		{ server: 'multiple', availableToolCount: 1, usedToolCount: 0, configFiles: ['one.json', 'two.json'] },
		{ server: 'extension', availableToolCount: 1, usedToolCount: 0, extensionId: 'publisher.mcp' },
		{ server: 'settings', availableToolCount: 1, usedToolCount: 0 },
	];
	const html = buildUnusedMcpHtml(servers, { totalTokens: 0, byServer: {} }, 30);
	assert.match(html, /data-command="openFile" data-path="\.vscode\/mcp\.json"/);
	assert.match(html, /data-command="openFileFromList" data-paths="\[&quot;one\.json&quot;,&quot;two\.json&quot;\]"/);
	assert.match(html, /data-command="manageExtension" data-extension-id="publisher\.mcp"/);
	assert.match(html, /data-command="openToolPicker"/);
});

test('toolCurationTables: built-in helper and MCP link retain expected labels', () => {
	const builtin = buildBuiltinToolsHtml([tool('builtin-tool', 'builtin')], { totalTokens: 120, byServer: { builtin: 120 } });
	assert.match(builtin, /~120 tokens overhead, not actionable/);
	const mcp = buildUnusedMcpHtml(
		[{ server: 'server', availableToolCount: 1, usedToolCount: 0, configFiles: ['workspace/.vscode/mcp.json'] }],
		{ totalTokens: 1, byServer: {} },
		7,
	);
	assert.match(mcp, /workspace\/\.vscode\/mcp\.json/);
});

test('toolCurationTables: MCP without config files retains the literal configuration filename', () => {
	const html = buildUnusedMcpHtml(
		[{ server: 'settings', availableToolCount: 1, usedToolCount: 0 }],
		{ totalTokens: 0, byServer: {} },
		30,
	);
	assert.match(html, /<code>\.vscode\/mcp\.json<\/code>/);
});
