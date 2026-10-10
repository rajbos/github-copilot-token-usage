import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as vscode from 'vscode';
import { t } from '../../src/l10n';
import { ENGLISH_BUNDLE, resolvedLocale } from '../../src/l10nCore';
import { INSIGHT_CATALOG, evaluateInsights } from '../../src/insightsEngine';
import { insightFixtureContexts } from './fixtures/insightContexts';
import { WHATS_NEW_RELEASES } from '../../src/whatsNew/catalog';

const mock = (vscode as any).__mock;

// The shim's default l10n.t returns the raw key — exactly what real VS Code
// does for key-based calls on the default (English) display language.

test('l10n: VS Code-provided bundle translation takes precedence', () => {
	mock.setL10nBundle({ 'statusBar.loadingText': 'Chargement…' });
	assert.equal(t('statusBar.loadingText'), 'Chargement…');
	mock.setL10nBundle(null);
});

test('l10n: VS Code bundle args are passed through', () => {
	mock.setL10nBundle({ 'statusBar.analyzingLogs': 'Analyse: {0}%' });
	assert.equal(t('statusBar.analyzingLogs', '42'), 'Analyse: 42%');
	mock.setL10nBundle(null);
});

test('l10n: resolves English from the inlined package.nls.json when VS Code returns the raw key', () => {
	const value = t('statusBar.loadingText');
	assert.notEqual(value, 'statusBar.loadingText');
	assert.ok(value.includes('AI Fluency'), `expected English text, got: ${value}`);
});

test('l10n: inlined fallback formats {0} placeholders', () => {
	assert.equal(t('statusBar.analyzingLogs', '42'), '$(loading~spin) Analyzing Logs: 42%');
});

test('l10n: resolves zh-cn strings when the display language is zh-cn', () => {
	mock.setLanguage('zh-cn');
	assert.equal(t('nav.btnRefresh'), '刷新');
	mock.setLanguage('en');
});

test('l10n: missing-instructions insight is tool-neutral in English and zh-cn', () => {
	const enOne = "1 active workspace (repo) uses other AI tools but has no shared agent instructions file (`AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md`). `AGENTS.md` is the open standard read by most coding agents, including Copilot; adding one gives them project-specific context, reducing back-and-forth and improving response quality.";
	const enOther = "2 active workspaces (a, b) use other AI tools but have no shared agent instructions file (`AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md`). `AGENTS.md` is the open standard read by most coding agents, including Copilot; adding one gives them project-specific context, reducing back-and-forth and improving response quality.";
	const zhOne = '有 1 个活跃工作区（repo）使用了其他 AI 工具，但没有共享的智能体说明文件（`AGENTS.md`、`CLAUDE.md` 或 `.github/copilot-instructions.md`）。`AGENTS.md` 是大多数编码智能体（包括 Copilot）都支持的开放标准，添加后可提供项目专属上下文，减少反复沟通并提升回答质量。';
	const zhOther = '有 2 个活跃工作区（a, b）使用了其他 AI 工具，但没有共享的智能体说明文件（`AGENTS.md`、`CLAUDE.md` 或 `.github/copilot-instructions.md`）。`AGENTS.md` 是大多数编码智能体（包括 Copilot）都支持的开放标准，添加后可提供项目专属上下文，减少反复沟通并提升回答质量。';
	assert.equal(t('insight.missingInstructions.title'), '🗒️ Add an AGENTS.md to your repos');
	assert.equal(t('insight.missingInstructions.body.one', 1, 'repo', ''), enOne);
	assert.equal(t('insight.missingInstructions.body.other', 2, 'a, b', ''), enOther);
	mock.setLanguage('zh-cn');
	assert.equal(t('insight.missingInstructions.title'), '🗒️ 为你的仓库添加 AGENTS.md');
	assert.equal(t('insight.missingInstructions.body.one', 1, 'repo', ''), zhOne);
	assert.equal(t('insight.missingInstructions.body.other', 2, 'a, b', ''), zhOther);
	mock.setLanguage('en');
});

test('l10n: paged curation table controls resolve in English and zh-cn', () => {
	assert.equal(t('dataTable.previous'), 'Previous');
	assert.equal(t('dataTable.next'), 'Next');
	assert.equal(t('dataTable.page', 2, 3, 11, 20, 25), 'Page 2 of 3 · Showing 11–20 of 25');
	assert.equal(t('dataTable.showing', 1, 10, 10), 'Showing 1–10 of 10');
	assert.equal(t('dataTable.sortBy', 'Server'), 'Sort by Server');
	assert.equal(t('dataTable.sortedAscending'), 'Sorted ascending');
	assert.equal(t('dataTable.sortedDescending'), 'Sorted descending');
	assert.equal(t('dataTable.announcement.sort', 'Server', 'Sorted ascending'), 'Server: Sorted ascending');
	assert.equal(t('dataTable.noRows'), 'No rows to display.');
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('dataTable.previous'), '上一页');
		assert.equal(t('dataTable.next'), '下一页');
		assert.equal(t('dataTable.page', 2, 3, 11, 20, 25), '第 2/3 页 · 显示 11–20 条，共 25 条');
		assert.equal(t('dataTable.showing', 1, 10, 10), '显示 1–10 条，共 10 条');
		assert.equal(t('dataTable.sortBy', 'Server'), '按Server排序');
		assert.equal(t('dataTable.sortedAscending'), '当前按升序排列');
		assert.equal(t('dataTable.sortedDescending'), '当前按降序排列');
		assert.equal(t('dataTable.announcement.sort', '服务器', '当前按升序排列'), '服务器：当前按升序排列');
		assert.equal(t('dataTable.noRows'), '没有可显示的行。');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: customization files table controls resolve in English and zh-cn', () => {
	const translations: Array<[string, string, string]> = [
		['usage.customization.column.workspace', '📂 Workspace', '📂 工作区'],
		['usage.customization.column.sessions', 'Sessions', '会话'],
		['usage.customization.column.interactions', 'Interactions', '交互'],
		['usage.customization.aria.table', 'Copilot customization files by workspace', '按工作区列出的 Copilot 自定义文件'],
		['usage.customization.filter.noCustomizationOnly', 'Only workspaces without customization files', '仅显示没有自定义文件的工作区'],
		['usage.customization.status.fresh', "Present and fresh", "存在且最新"],
		['usage.customization.status.stale', "Present but stale", "存在但已过时"],
		['usage.customization.status.missing', "Missing", "缺失"],
		['usage.customization.status.unknown', "Status unknown", "状态未知"],
		['usage.customization.status.error', "Error", "错误"],
		['usage.customization.badge.noCustomization', "No customization files", "没有自定义文件"],
		['usage.customization.legend.fresh', "= Present & Fresh", "= 存在且最新"],
		['usage.customization.legend.stale', "= Present but Stale", "= 存在但已过时"],
		['usage.customization.legend.missing', "= Missing", "= 缺失"],
		['usage.customization.title', "Copilot Customization Files", "Copilot 自定义文件"],
		['usage.customization.emptySubtitle', "Showing workspace customization status for active workspaces", "显示活跃工作区的自定义状态"],
		['usage.customization.empty', "No workspaces with customization files detected in the last 30 days.", "过去 30 天内未检测到包含自定义文件的工作区。"],
		['usage.customization.summary.allGood', "All workspaces have up-to-date customizations.", "所有工作区的自定义文件均为最新。"],
	];
	for (const [key, english] of translations) {
		assert.equal(t(key), english);
	}
	assert.equal(t('usage.customization.summary', 26), 'Showing 26 workspace(s) with Copilot activity in the last 30 days.');
	assert.equal(t('usage.customization.summary.issues', 6), '6 workspace(s) have no customization files.');
	mock.setLanguage('zh-cn');
	try {
		for (const [key, , chinese] of translations) {
			assert.equal(t(key), chinese);
		}
		assert.equal(t('usage.customization.summary', 26), '显示过去 30 天内有 Copilot 活动的 26 个工作区。');
		assert.equal(t('usage.customization.summary.issues', 6), '6 个工作区没有自定义文件。');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: tool × period table strings resolve in English and zh-cn', () => {
	const translations: Array<[string, string, string]> = [
		['usage.toolPeriod.colTool', 'Tool', '工具'],
		['usage.toolPeriod.colServer', 'Server', '服务器'],
		['usage.toolPeriod.colToday', 'Today', '今天'],
		['usage.toolPeriod.colLast30', 'Last 30 Days', '最近 30 天'],
		['usage.toolPeriod.colPreviousMonth', 'Previous Month', '上月'],
		['usage.toolPeriod.totalToolCalls', 'Total tool calls', '工具调用总数'],
		['usage.toolPeriod.totalMcpCalls', 'Total MCP calls', 'MCP 调用总数'],
		['usage.toolPeriod.byServer', 'By Server', '按服务器'],
		['usage.toolPeriod.byTool', 'By Tool', '按工具'],
		['usage.toolPeriod.mcpViewAria', 'MCP breakdown', 'MCP 细分'],
		['usage.toolPeriod.emptyTools', 'No tools used yet', '尚未使用任何工具'],
		['usage.toolPeriod.emptyToolsHidden', 'No purposeful tools used yet (automatic tool calls are hidden)', '尚未使用任何有目的的工具（已隐藏自动工具调用）'],
		['usage.toolPeriod.emptyMcp', 'No MCP tools used yet', '尚未使用任何 MCP 工具'],
		['usage.toolPeriod.autoBadge', 'auto', '自动'],
		['usage.toolPeriod.ariaToolUsage', 'Tool usage by period', '按时间段的工具使用情况'],
		['usage.toolPeriod.ariaMcpServers', 'MCP calls by server and period', '按服务器和时间段的 MCP 调用'],
		['usage.toolPeriod.ariaMcpTools', 'MCP calls by tool and period', '按工具和时间段的 MCP 调用'],
		['usage.toolPeriod.autoBadgeTitle', 'Automatic tool — Copilot uses this internally and it does not count toward fluency scoring', '自动工具 — Copilot 在内部使用，不计入熟练度评分'],
	];
	for (const [key, english] of translations) {
		assert.equal(t(key), english, key);
	}
	mock.setLanguage('zh-cn');
	try {
		for (const [key, , chinese] of translations) {
			assert.equal(t(key), chinese, key);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: tool curation UI strings resolve in English and zh-cn', () => {
	const translations: Array<[string, string, string]> = [
		['usage.toolCuration.column.server', 'Server', '服务器'],
		['usage.toolCuration.column.source', 'Source', '来源'],
		['usage.toolCuration.column.available', 'Tools Available', '可用工具'],
		['usage.toolCuration.column.used', 'Tools Used', '已使用工具'],
		['usage.toolCuration.column.overhead', 'Est. Overhead', '估算开销'],
		['usage.toolCuration.column.action', 'Action', '操作'],
		['usage.toolCuration.column.skill', 'Skill', '技能'],
		['usage.toolCuration.column.description', 'Description', '描述'],
		['usage.toolCuration.column.view', 'View', '查看'],
		['usage.toolCuration.column.tool', 'Tool', '工具'],
		['usage.toolCuration.aria.mcp', 'MCP servers', 'MCP 服务器'],
		['usage.toolCuration.aria.skills', 'Unused skills', '未使用的技能'],
		['usage.toolCuration.aria.builtin', 'Built-in VS Code tools', '内置 VS Code 工具'],
		['usage.toolCuration.source.plugin', 'Plugin: {0}', '插件：{0}'],
		['usage.toolCuration.source.workspaceGithub', 'Workspace (.github)', '工作区 (.github)'],
		['usage.toolCuration.source.workspaceClaude', 'Workspace (.claude)', '工作区 (.claude)'],
		['usage.toolCuration.source.workspaceAgents', 'Workspace (.agents)', '工作区 (.agents)'],
		['usage.toolCuration.source.user', 'User (~)', '用户 (~)'],
		['usage.toolCuration.source.extension', 'Extension', '扩展'],
		['usage.toolCuration.source.settings', 'Settings', '设置'],
		['usage.toolCuration.source.workspace', 'Workspace', '工作区'],
		['usage.toolCuration.source.workspaceVisualStudio', 'Workspace (VS)', '工作区 (VS)'],
		['usage.toolCuration.source.workspaceCursor', 'Workspace (Cursor)', '工作区 (Cursor)'],
		['usage.toolCuration.source.configFile', 'Config file', '配置文件'],
		['usage.toolCuration.action.open', 'open', '打开'],
		['usage.toolCuration.action.openFileTitle', 'Open {0}', '打开 {0}'],
		['usage.toolCuration.action.openExtensionsFor', 'Open Extensions view for {0}', '打开适用于 {0} 的扩展视图'],
		['usage.toolCuration.action.browseMcp', 'Browse MCP extensions in the marketplace', '在市场中浏览 MCP 扩展'],
		['usage.toolCuration.action.manageExtensionTitle', 'Open the Extensions view for {0} (disable or uninstall to reclaim prompt budget)', '打开 {0} 的扩展视图（禁用或卸载以回收提示词预算）'],
		['usage.toolCuration.action.manageExtension', 'Manage Extension', '管理扩展'],
		['usage.toolCuration.action.openToolPickerTitle', 'Open VS Code tool selection menu', '打开 VS Code 工具选择菜单'],
		['usage.toolCuration.action.changeTools', 'Change Tools', '更改工具'],
		['usage.toolCuration.action.definedInFiles', 'Defined in {0} config files', '定义于 {0} 个配置文件'],
		['usage.toolCuration.action.managePluginsTitle', 'Open Extensions view filtered to agent plugins', '打开按智能体插件筛选的扩展视图'],
		['usage.toolCuration.action.manage', 'manage', '管理'],
		['usage.toolCuration.action.viewSkill', 'View skill', '查看技能'],
		['usage.toolCuration.status.notConnected', 'not connected', '未连接'],
		['usage.toolCuration.summary.mcp', '🔌 MCP Servers in Last {0} Days ({1})', '🔌 MCP 服务器（最近 {0} 天）（{1}）'],
		['usage.toolCuration.filter.hideServersWithUsage', 'Hide servers with usage', '隐藏有使用记录的服务器'],
		['usage.toolCuration.summary.mcpCounts', '{0} with no usage · {1} with usage', '{0} 个无使用记录 · {1} 个有使用记录'],
		['usage.toolCuration.help.mcp', '💡 Open {0} to disable file-configured servers, or use <em>{1}</em> to disable or uninstall an MCP-providing extension. (VS Code does not expose per-server picker state to extensions, so servers you disabled in the chat tool picker may still appear here.)', '💡 打开 {0} 以禁用由文件配置的服务器，或使用 <em>{1}</em> 禁用或卸载提供 MCP 的扩展。（VS Code 不会向扩展公开每个服务器的工具选择器状态，因此你在聊天工具选择器中禁用的服务器仍可能显示在此处。）'],
		['usage.toolCuration.summary.unusedSkills', '📚 Unused Skills ({0})', '📚 未使用的技能（{0}）'],
		['usage.toolCuration.help.unusedSkills', '💡 Est. overhead is per agent interaction. For plugin skills, click <em>{0}</em> to open the agent plugins view where you can uninstall the plugin. For workspace skills, update the description or remove the SKILL.md.', '💡 估算开销按每次智能体交互计算。对于插件技能，点击 <em>{0}</em> 打开智能体插件视图并卸载插件。对于工作区技能，请更新说明或移除 SKILL.md。'],
		['usage.toolCuration.summary.builtin', '🔧 Built-in VS Code Tools ({0}) — {1} tokens overhead, not actionable', '🔧 内置 VS Code 工具（{0}）— {1} 个令牌开销，不可操作'],
		['usage.toolCuration.help.builtin', '💡 These tools are provided by VS Code itself and cannot be disabled. They are excluded from the actionable overhead total above.', '💡 这些工具由 VS Code 自身提供，无法禁用。它们不计入上方可操作的开销总量。'],
	];
	for (const [key, english, chinese] of translations) {
		assert.equal(t(key), english, `${key} English`);
	}
	mock.setLanguage('zh-cn');
	try {
		for (const [key, , chinese] of translations) {
			assert.equal(t(key), chinese, `${key} zh-cn`);
		}
		assert.equal(t('usage.toolCuration.source.plugin', 'demo'), '插件：demo');
		assert.equal(t('usage.toolCuration.summary.mcp', 30, 3), '🔌 MCP 服务器（最近 30 天）（3）');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: AI Readiness command and navigation labels resolve in both languages', () => {
	assert.equal(t('command.showReadiness.title'), 'Show AI Readiness');
	assert.equal(t('nav.btnReadiness'), 'AI Readiness');
	assert.equal(t('readiness.loading'), 'Scanning repository controls…');
	assert.equal(t('readiness.refreshing'), 'Showing the last scan while a fresh one runs…');
	assert.equal(t('readiness.scanFailed'), 'Could not scan repository readiness. Check the AI Engineering Fluency output for details, then try Refresh.');
	assert.equal(t('whatsNew.release.0.18.1.headline'), 'A maintenance release: friendly tool names, localization groundwork, and a Mistral Vibe cost-attribution fix. No new screens.');
	assert.equal(t('whatsNew.release.0.18.2.headline'), 'See which repository controls are in place, and which still need evidence, in the new AI Readiness tab.');
	assert.equal(t('whatsNew.release.0.18.3.headline'), 'A maintenance release: the AI Readiness tab now collapses each repository to one row and can draft a Copilot Chat prompt for the controls you pick, plus friendlier MCP tool names. No new screens.');
	assert.equal(t('whatsNew.feature.usage.readiness-tab.title'), 'AI Readiness');
	assert.equal(t('whatsNew.feature.usage.readiness-tab.description'), "In Usage Analysis, scan each repository's delivery and governance controls to see what blocks its next stage and what could not be checked. Separate from your personal Fluency Score.");
	assert.equal(t('whatsNew.release.0.19.0.headline'), "Usage Analysis is now organized into Usage, Workspace, GitHub and Coaching groups, with banded sections, official editor logos in the Chart view and Copilot budget for every signed-in GitHub account.");
	assert.equal(t('whatsNew.feature.usage.group-tabs.title'), "Grouped tabs");
	assert.equal(t('whatsNew.feature.usage.group-tabs.description'), "The ten Usage Analysis tabs now sit under four group tabs (Usage, Workspace, GitHub, Coaching), and My Activity is split into Overview, Spend & models and Context bands.");
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('command.showReadiness.title'), '显示 AI 就绪度');
		assert.equal(t('nav.btnReadiness'), 'AI 就绪度');
		assert.equal(t('readiness.loading'), '正在扫描仓库控制措施…');
		assert.equal(t('readiness.refreshing'), '正在显示上次扫描结果，同时重新扫描…');
		assert.equal(t('readiness.scanFailed'), '无法扫描仓库就绪度。请查看 AI 工程熟练度输出中的详细信息，然后重试刷新。');
		assert.equal(t('whatsNew.release.0.18.1.headline'), '一个维护版本：友好的工具名称、本地化基础工作，以及一个 Mistral Vibe 成本归因修复。没有新增界面。');
		assert.equal(t('whatsNew.release.0.18.2.headline'), '在新的 AI 就绪度标签页中，查看仓库已具备的控制措施以及仍需核实的证据。');
		assert.equal(t('whatsNew.release.0.18.3.headline'), '一个维护版本：AI 就绪度标签页现在将每个仓库折叠为一行，并可为你选中的控制措施起草 Copilot Chat 提示，另外 MCP 工具名称更友好。没有新增界面。');
		assert.equal(t('whatsNew.feature.usage.readiness-tab.title'), 'AI 就绪度');
		assert.equal(t('whatsNew.feature.usage.readiness-tab.description'), '在使用分析中逐个扫描仓库的交付与治理控制措施，查看进入下一阶段的阻碍和无法核实的项目。与个人熟练度评分分开显示。');
		assert.equal(t('whatsNew.release.0.19.0.headline'), "使用分析现在按“使用”“工作区”“GitHub”“辅导”分组，各部分按区块排列；图表视图显示官方编辑器图标，并为每个已登录的 GitHub 账户显示 Copilot 预算。");
		assert.equal(t('whatsNew.feature.usage.group-tabs.title'), "分组标签页");
		assert.equal(t('whatsNew.feature.usage.group-tabs.description'), "使用分析的十个标签页现在归入四个分组标签（使用、工作区、GitHub、辅导），“我的活动”则分为概览、支出与模型、上下文三个区块。");
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Dark Factory Readiness overview and Copilot action strings resolve in both languages', () => {
	assert.equal(t('readiness.summary.missingForStage', 3, 1), '3 missing for Stage 1');
	assert.equal(t('readiness.summary.unchecked', 9), '9 unchecked');
	assert.equal(t('readiness.summary.antiPattern', 1), '1 anti-pattern');
	assert.equal(t('readiness.summary.antiPatterns', 2), '2 anti-patterns');
	assert.equal(t('readiness.overview.scannedOne', 1), '1 repository scanned');
	assert.equal(t('readiness.overview.scannedMany', 4), '4 repositories scanned');
	assert.equal(t('readiness.overview.atStage', 2, 0), '2 at Stage 0');
	assert.equal(t('readiness.overview.withAntiPatterns', 1), '1 with anti-patterns');
	assert.equal(t('readiness.overview.hint'), 'Click a repository to see what blocks its next stage.');
	assert.equal(t('readiness.disclaimer.headline'), 'A checklist, not a green light.');
	assert.equal(t('readiness.disclaimer.body'), 'For each repository this shows which safeguards are already in place (reviews, CI checks, agent instructions) and what is still missing for the next stage. It never says a repo is ready to run without people watching, so Stage 5 is never given out.');
	assert.equal(t('readiness.about.title'), '📋 What this measures');
	assert.equal(t('readiness.about.weakEvidence'), 'A green build from an unbounded agent is weak evidence.');
	assert.equal(t('readiness.about.stage5'), 'Stage 5 is never awarded: its defining evidence is not machine-detectable.');
	assert.equal(t('readiness.action.hint'), 'Pick the items above, then open a new Copilot Chat with a prompt to implement them. Nothing is sent until you press Enter.');
	assert.equal(t('readiness.action.draft'), '🤖 Draft Copilot Chat prompt');
	assert.equal(t('readiness.action.selectFirst'), '🤖 Select at least one item first');
	assert.equal(t('readiness.action.includeItem', 'CODEOWNERS'), 'Include CODEOWNERS in the Copilot prompt');
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('readiness.summary.missingForStage', 3, 1), '进入第 1 阶段还缺 3 项');
		assert.equal(t('readiness.summary.unchecked', 9), '9 项未检查');
		assert.equal(t('readiness.summary.antiPatterns', 2), '2 个反模式');
		assert.equal(t('readiness.overview.scannedMany', 4), '已扫描 4 个仓库');
		assert.equal(t('readiness.overview.atStage', 2, 0), '2 个处于第 0 阶段');
		assert.equal(t('readiness.overview.withAntiPatterns', 1), '1 个存在反模式');
		assert.equal(t('readiness.overview.hint'), '点击仓库，查看阻碍其进入下一阶段的因素。');
		assert.equal(t('readiness.disclaimer.headline'), '这是一份检查清单，而不是绿灯。');
		assert.equal(t('readiness.about.title'), '📋 衡量内容');
		assert.equal(t('readiness.about.stage5'), '第 5 阶段永远不会被授予：其决定性证据无法由机器检测。');
		assert.equal(t('readiness.action.draft'), '🤖 起草 Copilot Chat 提示词');
		assert.equal(t('readiness.action.selectFirst'), '🤖 请先至少选择一项');
		assert.equal(t('readiness.action.includeItem', 'CODEOWNERS'), '在 Copilot 提示词中包含 CODEOWNERS');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: bare language tag zh matches the zh-cn bundle', () => {
	mock.setLanguage('zh');
	assert.equal(t('nav.btnRefresh'), '刷新');
	mock.setLanguage('en');
});

test('l10n: zh-tw does not get the Simplified Chinese bundle', () => {
	mock.setLanguage('zh-tw');
	assert.equal(t('nav.btnRefresh'), 'Refresh');
	mock.setLanguage('en');
});

test('l10n: unknown key returns the key itself and warns once', () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (msg: unknown) => { warnings.push(String(msg)); };
	try {
		assert.equal(t('no.such.key.exists'), 'no.such.key.exists');
		t('no.such.key.exists');
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes('No localization found for key "no.such.key.exists"'));
});

// Keys added for the dialog/toast buttons and insights status bar name
// (PR #1876 follow-up) — guards against raw keys resurfacing in the UI.
test('l10n: dialog button and insights status bar keys resolve in English', () => {
	const expected: Record<string, string> = {
		'statusBar.nameInsights': 'AI Engineering Fluency — Insights',
		'button.openSettings': 'Open Settings',
		'button.openUsageAnalysis': 'Open Usage Analysis',
		'button.openInsightsTab': 'Open Insights tab',
		'button.removeOldExtension': 'Remove Old Extension',
		'button.dismiss': 'Dismiss',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: dialog button and insights status bar keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'statusBar.nameInsights': 'AI 工程熟练度 —— 洞察',
			'button.openSettings': '打开设置',
			'button.openUsageAnalysis': '打开使用分析',
			'button.openInsightsTab': '打开洞察标签页',
			'button.removeOldExtension': '删除旧扩展',
			'button.dismiss': '忽略',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: worktree force-delete dialog resolves in both languages', () => {
	assert.equal(t('worktree.forceDelete'), 'Force Delete');
	assert.equal(
		t('worktree.submoduleForcePrompt', 'C:\\repo\\worktree'),
		'"C:\\repo\\worktree" contains initialized submodules that Git cannot remove without force.',
	);
	assert.equal(
		t('worktree.submoduleForceDetail'),
		'Force-deleting will permanently remove this working copy. Uncommitted or unpushed changes in the worktree or its submodules can be lost.',
	);
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('worktree.forceDelete'), '强制删除');
		assert.equal(
			t('worktree.submoduleForcePrompt', 'C:\\repo\\worktree'),
			'“C:\\repo\\worktree”包含已初始化的子模块，Git 无法在不强制执行的情况下删除它。',
		);
		assert.equal(
			t('worktree.submoduleForceDetail'),
			'强制删除将永久移除此工作副本。工作树或其子模块中未提交或未推送的更改可能会丢失。',
		);
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: clipboard-failure keys resolve in English', () => {
	// Added with the `copyFailed` handler: before it existed the webview posted
	// this and nothing on the extension side listened, so a failed copy was
	// completely silent.
	const expected: Record<string, string> = {
		'usage.copyFailed': 'Could not copy the path to the clipboard.',
		'usage.copyFailed.retry': 'Copy Again',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: clipboard-failure keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'usage.copyFailed': '无法将路径复制到剪贴板。',
			'usage.copyFailed.retry': '重新复制',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

// Keys rendered into the share-card PNG export (PR #2035) — guards against raw
// keys resurfacing in the exported image for every locale.
test('l10n: share-card export keys resolve in English', () => {
	const expected: Record<string, string> = {
		'share.exportTitle': 'AI Engineering Fluency Score',
		'share.exportReportLabel': 'Report',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: share-card export keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'share.exportTitle': 'AI 工程熟练度评分',
			'share.exportReportLabel': '报告',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: usage context-pressure keys resolve in English', () => {
	// These back the two context-pressure rows in the Usage view's Context
	// Window section. A missing key would render a raw
	// `usage.contextPressure.compactedLabel` as the row label.
	const expected: Record<string, string> = {
		'usage.contextPressure.compactedLabel': '🗜️ Sessions compacted',
		'usage.contextPressure.noneCompacted': 'No session ran out of context window in this period',
		'usage.contextPressure.nearLimitLabel': '⚠️ Sessions near the limit',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
	assert.equal(t('usage.contextPressure.ofCount', '3', '12'), '3 of 12');
	assert.equal(t('usage.contextPressure.worstFill', '94'), 'Fullest session reached 94% of its window');
	assert.equal(
		t('usage.contextPressure.compactedShare', '25'),
		'25% of sessions with context data lost earlier turns to automatic compaction',
	);
	assert.match(t('usage.contextPressure.nearLimitTooltip', '80'), /at least 80% of their context window/);
	assert.match(t('usage.contextPressure.compactedTooltip'), /counted per session rather than per compaction event/);
});

test('l10n: usage context-pressure keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'usage.contextPressure.compactedLabel': '🗜️ 已压缩的会话',
			'usage.contextPressure.noneCompacted': '本期间没有会话耗尽上下文窗口',
			'usage.contextPressure.nearLimitLabel': '⚠️ 接近上限的会话',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
		// The Chinese phrasing reorders the two counts, so the placeholders are
		// not positional in the same way as English — a plain concatenation
		// would silently produce "3 个中的 12 个".
		assert.equal(t('usage.contextPressure.ofCount', '3', '12'), '12 个中的 3 个');
		assert.equal(t('usage.contextPressure.worstFill', '94'), '最满的会话达到了其窗口的 94%');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: usage tab-group, band and context-reference keys resolve in English', () => {
	// These back the Usage view's group tab strip, the Activity tab's band headings, and the
	// collapsed context-reference long tail. A missing key renders the raw key as a tab label
	// or section heading.
	const expected: Record<string, string> = {
		'usage.group.usage': 'Usage',
		'usage.group.workspace': 'Workspace',
		'usage.group.github': 'GitHub',
		'usage.group.coaching': 'Coaching',
		// The leaf tab labels. They render through `localize()` on every strip render, so a
		// missing key shows up as a tab titled "usage.tab.repos".
		'usage.tab.activity': 'My Activity',
		'usage.tab.sessions': 'Recent Sessions',
		'usage.tab.tools': 'Tools & Integrations',
		'usage.tab.health': 'Workspace Health',
		'usage.tab.repos': 'Repository PRs',
		'usage.tab.agent': 'Cloud Agent',
		'usage.tab.worktrees': 'Worktrees',
		'usage.tab.insights': 'Insights',
		'usage.tab.corrections': 'Corrections',
		'usage.band.overview.title': 'Overview',
		'usage.band.spend.title': 'Spend & models',
		'usage.band.context.title': 'Context',
		'usage.contextWindow.compactionHeading': 'Context compaction',
		'usage.contextRefs.noneRecent': 'No context references recorded today or in the last 30 days.',
		'usage.contextRefs.totalTooltip': 'Total across the reference kinds (#file, #selection, @workspace, instructions files and so on). The Images, Prompt Files, Custom Prompts and Code Lines rows are separate metrics and are not included in this total.',
		// The table's own head and footer labels. They render through `localize()` on every
		// render rather than from a module constant, so a missing key shows up as a column
		// titled "usage.contextRefs.colToday".
		'usage.contextRefs.colReference': 'Reference',
		'usage.contextRefs.colToday': 'Today',
		'usage.contextRefs.colThisMonth': 'This Month',
		'usage.contextRefs.colLastMonth': 'Last Month',
		'usage.contextRefs.colLast30': 'Last 30 Days',
		'usage.contextRefs.colTrend': 'Trend',
		'usage.contextRefs.colTrendTooltip': 'Trend: Last Month → This Month → Today',
		'usage.contextRefs.totalRow': '📊 Total References',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
	assert.match(t('usage.band.overview.subtitle'), /interaction modes/);
	assert.match(t('usage.band.spend.subtitle'), /how hard they were asked to think/);
	assert.match(t('usage.band.context.subtitle'), /what gets compacted away/);
	// The count is a placeholder, not concatenated, so a locale can reposition it.
	assert.equal(
		t('usage.contextRefs.otherSummary', '4'),
		'Other references (4, no usage today or in the last 30 days)',
	);
});

test('l10n: usage tab-group, band and context-reference keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'usage.group.usage': '使用情况',
			'usage.group.workspace': '工作区',
			'usage.group.coaching': '改进建议',
			'usage.tab.activity': '我的活动',
			'usage.tab.sessions': '最近会话',
			'usage.tab.tools': '工具与集成',
			'usage.tab.health': '工作区健康度',
			'usage.tab.repos': '仓库 PR',
			'usage.tab.agent': '云端代理',
			'usage.tab.worktrees': '工作树',
			'usage.tab.insights': '洞察',
			'usage.tab.corrections': '纠正',
			'usage.band.overview.title': '概览',
			'usage.band.spend.title': '花费与模型',
			'usage.band.context.title': '上下文',
			'usage.contextWindow.compactionHeading': '上下文压缩',
			'usage.contextRefs.colReference': '引用',
			'usage.contextRefs.colToday': '今天',
			'usage.contextRefs.colThisMonth': '本月',
			'usage.contextRefs.colLastMonth': '上月',
			'usage.contextRefs.colLast30': '最近 30 天',
			'usage.contextRefs.colTrend': '趋势',
			'usage.contextRefs.colTrendTooltip': '趋势：上月 → 本月 → 今天',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
		// "GitHub" is a proper noun and stays untranslated — asserted so a future bulk
		// translation pass doesn't quietly localize a product name.
		assert.equal(t('usage.group.github'), 'GitHub');
		assert.equal(t('usage.contextRefs.otherSummary', '4'), '其他引用（4 个，今天和最近 30 天均未使用）');
		// The band subtitles and the two context-reference strings are the longest prose in this
		// set, so they are the likeliest to be dropped or half-translated in a bulk edit.
		assert.equal(t('usage.band.overview.subtitle'), "你使用 AI 助手的总量，以及使用了哪些交互模式。", 'zh-cn value for usage.band.overview.subtitle');
		assert.equal(t('usage.band.spend.subtitle'), "这些使用产生的成本、运行在哪些模型上，以及它们被要求思考的深度。", 'zh-cn value for usage.band.spend.subtitle');
		assert.equal(t('usage.band.context.subtitle'), "你提供给模型的内容：附加的引用、请求与窗口上限的接近程度，以及被压缩掉的部分。", 'zh-cn value for usage.band.context.subtitle');
		assert.equal(t('usage.contextRefs.noneRecent'), "今天和最近 30 天均未记录到上下文引用。", 'zh-cn value for usage.contextRefs.noneRecent');
		assert.equal(t('usage.contextRefs.totalTooltip'), "各引用类型的合计（#file、#selection、@workspace、说明文件等）。图片、提示文件、自定义提示和代码行数这几行属于独立指标，不计入此合计。", 'zh-cn value for usage.contextRefs.totalTooltip');
		// The emoji is part of the label, not decoration added at render time, so it has to
		// survive translation along with the words after it.
		assert.equal(t('usage.contextRefs.totalRow'), "📊 引用合计", 'zh-cn value for usage.contextRefs.totalRow');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: efficiency Value empty-state keys resolve in English', () => {
	// These back the Value tab's empty state: the explanation and the "Open Repository PRs"
	// button beside it. A missing key would render a raw `efficiency.value.*` in the panel.
	assert.equal(t('efficiency.value.openRepositoryPrs'), 'Open Repository PRs');
	assert.equal(t('efficiency.value.prsHintDestination'), 'Usage Analysis → Repository PRs');
	assert.equal(
		t('efficiency.value.prsHint', '<b>Usage Analysis → Repository PRs</b>'),
		'💡 Connect GitHub and open <b>Usage Analysis → Repository PRs</b> once to add pull-request metrics here — merged PRs are a far better value signal than lines of code.',
	);
});

test('l10n: efficiency Value empty-state keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('efficiency.value.openRepositoryPrs'), '打开仓库 PR');
		assert.equal(t('efficiency.value.prsHintDestination'), '使用分析 → 仓库 PR');
		// The Chinese phrasing puts the destination after the verb rather than before "once",
		// so the placeholder is not positional in the same way as English.
		assert.equal(
			t('efficiency.value.prsHint', '<b>使用分析 → 仓库 PR</b>'),
			'💡 连接 GitHub 并打开一次 <b>使用分析 → 仓库 PR</b>，即可在此处添加拉取请求指标——已合并的 PR 是比代码行数更好的价值信号。',
		);
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Recent Sessions context-fill keys resolve in English', () => {
	// These back the Recent Sessions "Context" column and the "near context
	// limit" filter pill the context-pressure insight links to. A missing key
	// would put a raw `usage.sessions.contextFill.nearLimitFilter` on the pill.
	assert.equal(t('usage.sessions.contextFill.columnLabel'), 'Context');
	assert.equal(t('usage.sessions.contextFill.nearLimitFilter'), '🧠 Near context limit');
	assert.equal(
		t('usage.sessions.contextFill.nearLimitFilterTooltip', '80'),
		'Show only sessions that reached at least 80% of their context window without compacting',
	);
	assert.equal(t('usage.sessions.contextFill.used', '120,000', '200,000'), '120,000 of 200,000 context tokens used');
	assert.equal(
		t('usage.sessions.contextFill.usedNearLimit', '190,000', '200,000', '80'),
		'190,000 of 200,000 context tokens used — at or past 80% of the window',
	);
	assert.match(t('usage.sessions.contextFill.noData'), /only GitHub Copilot CLI sessions report one/);
});

test('l10n: Recent Sessions context-fill keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('usage.sessions.contextFill.columnLabel'), '上下文');
		assert.equal(t('usage.sessions.contextFill.nearLimitFilter'), '🧠 接近上下文上限');
		// The Chinese phrasing reorders the reached/limit counts, so a plain
		// concatenation would report the two numbers the wrong way round.
		assert.equal(t('usage.sessions.contextFill.used', '120,000', '200,000'), '已使用 200,000 个上下文 token 中的 120,000 个');
		assert.equal(
			t('usage.sessions.contextFill.usedNearLimit', '190,000', '200,000', '80'),
			'已使用 200,000 个上下文 token 中的 190,000 个——达到或超过窗口的 80%',
		);
		assert.match(t('usage.sessions.contextFill.nearLimitFilterTooltip', '80'), /至少 80%/);
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Repository PRs on-demand CCR activity keys resolve in English', () => {
	// Back the "Check actual CCR activity" button and its result rendering on the
	// Repository PRs tab. A missing key would put a raw
	// `usage.repoPrs.ccrCheckButton` on the button.
	assert.equal(t('usage.repoPrs.ccrCheckButton'), 'Check actual CCR activity');
	assert.equal(t('usage.repoPrs.ccrChecking'), 'Checking…');
	assert.equal(t('usage.repoPrs.ccrFailedToLoad'), 'Failed to load');
	assert.equal(t('usage.repoPrs.ccrNoReviews'), 'No completed Copilot reviews found on this PR yet.');
	assert.equal(t('usage.repoPrs.ccrReviewCount', '5'), '5 completed review(s)');
	assert.equal(t('usage.repoPrs.ccrRequestedBy', 'rajbos'), ' — requested by rajbos');
	assert.match(t('usage.repoPrs.ccrInfoTooltip'), /Not the AI-credit dollar cost/);
	assert.equal(t('usage.repoPrs.ccrNotSignedIn'), 'Not signed in to GitHub');
	assert.equal(t('usage.repoPrs.aiDetailAuthored'), 'authored');
	assert.equal(t('usage.repoPrs.aiDetailReviewRequested'), 'review requested');
});

test('l10n: Repository PRs on-demand CCR activity keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('usage.repoPrs.ccrCheckButton'), '检查实际的 CCR 活动');
		assert.equal(t('usage.repoPrs.ccrChecking'), '正在检查…');
		assert.equal(t('usage.repoPrs.ccrFailedToLoad'), '加载失败');
		assert.equal(t('usage.repoPrs.ccrNoReviews'), '此 PR 尚未发现已完成的 Copilot 审查。');
		assert.equal(t('usage.repoPrs.ccrReviewCount', '5'), '5 次已完成的审查');
		assert.equal(t('usage.repoPrs.ccrRequestedBy', 'rajbos'), ' — 由 rajbos 请求');
		assert.equal(t('usage.repoPrs.ccrNotSignedIn'), '尚未登录 GitHub');
		assert.equal(t('usage.repoPrs.aiDetailAuthored'), '已创建');
		assert.equal(t('usage.repoPrs.aiDetailReviewRequested'), '已请求审查');
	} finally {
		mock.setLanguage('en');
	}
});

test("l10n: what's-new notification keys resolve in English", () => {
	// The two buttons on the one-a-day new-feature notification. A missing key
	// here would put a raw `whatsNew.takeMeThere` on the button, which is the
	// kind of thing nobody notices until a user reports it.
	const expected: Record<string, string> = {
		'whatsNew.takeMeThere': 'Take me there',
		'whatsNew.seeAll': 'See what else is new',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test("l10n: what's-new notification keys resolve in zh-cn", () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'whatsNew.takeMeThere': '带我去看看',
			'whatsNew.seeAll': '查看其他新增内容',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: environmental methodology keys resolve in English', () => {
	mock.setLanguage('en');
	try {
		const expected: Record<string, string> = {
			'environmental.intro': 'All figures are estimates. CO₂ and water are derived from a published benchmark of LLM inference energy, weighted by token type and scaled per model; analogies use average reference values. Treat these as order-of-magnitude indicators, not precise measurements.',
			'environmental.methodology.heading': 'Calculation & Estimates',
			'environmental.methodology.co2Paper': 'CO₂: Jegham et al. estimate 5.671 Wh for one Claude 3.7 Sonnet request with 10,000 input and 1,500 output tokens; at 0.287 kg CO₂e/kWh (AWS) that is about 1.63 g CO₂e. Counting an input token as 1/20 of an output token, that request is 2,000 output-equivalent tokens, giving ~814 g (range 770–857 g) per 1M output-equivalent tokens, rounded up to 840 g.',
			'environmental.methodology.co2Weights': 'Token weights (output = 1.0, uncached input = 0.05, cache write = 0.0625, cache read = 0.0005) are approximations adopted from neuland/tokendashboard-backend, not values from the paper. The paper does not model prompt caching, and the cache-read weight in particular is a rough guess. Tokens without a per-model breakdown are counted with the reference request\'s input/output mix.',
			'environmental.methodology.modelScaling': 'Other models are scaled from the Claude Sonnet baseline by the ratio of their output-token price (for example Haiku ⅓×, Opus 1⅔×). Price stands in for model size here; it is not a measurement. Models without a known price use the Sonnet baseline.',
			'environmental.methodology.cost': 'Cost (UBB) uses GitHub Copilot AI Credit rates (1 credit = $0.01) under Usage Based Billing.',
			'environmental.methodology.water': 'Water uses the paper\'s formula: on-site cooling (energy ÷ PUE × 0.18 L/kWh) plus off-site electricity generation (energy × 5.11 L/kWh), with AWS\'s PUE of 1.14. That is about 30 mL for the reference request, or ~15 L per 1M output-equivalent tokens for Claude Sonnet, scaled per model like CO₂.',
			'environmental.methodology.tree': 'Tree equivalent represents the fraction of a single mature tree\'s annual CO₂ absorption (~21 kg/year).',
			'environmental.methodology.co2Analogies': 'CO₂ analogies: petrol car ≈ 120 g/km · intercity train ≈ 41 g/km · economy flight ≈ 180 g/km (ICAO avg.) · smartphone charge ≈ 8 g · LED bulb ≈ 3 g/hr (10 W, EU grid) · kettle boil ≈ 20 g.',
			'environmental.methodology.waterAnalogies': 'Water analogies: shower ≈ 8 L/min · washing machine ≈ 50 L · standard bathtub ≈ 150 L · dishwasher ≈ 12 L · mug of tea ≈ 250 mL · daily drinking water ≈ 2 L/person.',
			'environmental.methodology.caveat': 'All analogies are order-of-magnitude estimates. Actual values depend on your region\'s energy mix, hardware, model implementation, and caching behavior.',
			'environmental.methodology.sources': 'Sources:',
			'environmental.methodology.paperLink': 'Jegham et al., "How Hungry is AI?" (arXiv:2505.09598)',
			'environmental.methodology.neulandLink': 'neuland/tokendashboard-backend — CO₂ methodology',
		};
		for (const [key, english] of Object.entries(expected)) {
			assert.equal(t(key), english, `English value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

// Log viewer summary card labels (PR #2045 follow-up) — guards against raw
// keys resurfacing in the log viewer summary cards for every locale.
test('l10n: log viewer summary card labels resolve in English', () => {
	const expected: Record<string, string> = {
		'logviewer.summary.interactions': 'Interactions',
		'logviewer.summary.editorMode': 'Editor Mode',
		'logviewer.summary.estimatedTokens': 'Estimated Tokens',
		'logviewer.summary.actualTokens': 'Actual Tokens',
		'logviewer.summary.modelTurns': 'Model Turns',
		'logviewer.summary.inputTokens': 'Input Tokens',
		'logviewer.summary.outputTokens': 'Output Tokens',
		'logviewer.summary.cachedInput': 'Cached Input',
		'logviewer.summary.estimatedCost': 'Estimated Cost',
		'logviewer.summary.estimatedCostSub': 'Summed across all turns',
		'logviewer.summary.estimatedCostTooltip': 'Estimated USD cost of this session, summed from the per-turn costs. Based on model pricing; may differ from your actual bill.',
		'logviewer.summary.thinkingTokens': 'Thinking Tokens',
		'logviewer.summary.thinkingEffort': 'Thinking Effort',
		'logviewer.summary.subAgents': 'Sub-Agents',
		'logviewer.summary.contextTruncated': 'Context Truncated',
		'logviewer.summary.sessionHierarchy': 'Session Hierarchy',
		'logviewer.summary.toolCalls': 'Tool Calls',
		'logviewer.summary.mcpTools': 'MCP Tools',
		'logviewer.summary.contextRefs': 'Context Refs',
		'logviewer.summary.fileName': 'File Name',
		'logviewer.summary.editor': 'Editor',
		'logviewer.summary.editorSource': 'Source',
		'logviewer.summary.mcpAndContextRefs': 'MCP Tools & Context Refs',
		'logviewer.summary.noModeData': 'No mode data',
		'logviewer.summary.noneShort': 'None',
		'logviewer.summary.otherCount': 'Other: {0}',
		'logviewer.summary.contextRefsBreakdown': 'implicit {0}, explicit {1}',
		'logviewer.summary.fileSize': 'File Size',
		'logviewer.summary.modified': 'Modified',
		'logviewer.summary.timeline': 'Timeline',
		'logviewer.summary.started': 'Started',
		'logviewer.summary.lastActivity': 'Last activity',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: environmental methodology keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'environmental.intro': '所有数据均为估算值。CO₂ 和用水量基于一项已发表的 LLM 推理能耗基准，按令牌类型加权并按模型缩放；类比值使用平均参考值。请将其视为数量级指标，而非精确测量。',
			'environmental.methodology.heading': '计算与估算',
			'environmental.methodology.co2Paper': 'CO₂：Jegham 等人估算，一次包含 10,000 个输入令牌和 1,500 个输出令牌的 Claude 3.7 Sonnet 请求耗能 5.671 Wh；按 0.287 kg CO₂e/kWh（AWS）计算约为 1.63 g CO₂e。将一个输入令牌计为输出令牌的 1/20，该请求相当于 2,000 个输出当量令牌，即每 100 万输出当量令牌约 814 g（范围 770–857 g），向上取整为 840 g。',
			'environmental.methodology.co2Weights': '令牌权重（输出 = 1.0，未缓存输入 = 0.05，缓存写入 = 0.0625，缓存读取 = 0.0005）是采用自 neuland/tokendashboard-backend 的近似值，并非论文中的数值。论文未对提示缓存建模，尤其是缓存读取权重只是粗略估计。没有按模型拆分明细的令牌按参考请求的输入/输出比例计算。',
			'environmental.methodology.modelScaling': '其他模型以 Claude Sonnet 为基线，按其输出令牌价格之比进行缩放（例如 Haiku ⅓×，Opus 1⅔×）。这里用价格代表模型规模，并非实测值。价格未知的模型使用 Sonnet 基线。',
			'environmental.methodology.cost': '成本（UBB）在按量计费下使用 GitHub Copilot AI Credit 费率（1 个 credit = $0.01）。',
			'environmental.methodology.water': '用水量采用论文中的公式：现场冷却（能耗 ÷ PUE × 0.18 L/kWh）加上场外发电（能耗 × 5.11 L/kWh），AWS 的 PUE 为 1.14。参考请求约为 30 mL，即 Claude Sonnet 每 100 万输出当量令牌约 15 L，并像 CO₂ 一样按模型缩放。',
			'environmental.methodology.tree': '树木当量表示一棵成熟树一年吸收 CO₂ 的占比（约 21 kg/年）。',
			'environmental.methodology.co2Analogies': 'CO₂ 类比：汽油车 ≈ 120 g/km · 城际列车 ≈ 41 g/km · 经济舱短途航班 ≈ 180 g/km（ICAO 平均）· 智能手机充满电 ≈ 8 g · LED 灯 ≈ 3 g/小时（10 W，欧盟电网）· 烧开一壶水 ≈ 20 g。',
			'environmental.methodology.waterAnalogies': '用水类比：淋浴 ≈ 8 L/分钟 · 洗衣机 ≈ 50 L · 标准浴缸 ≈ 150 L · 洗碗机 ≈ 12 L · 一杯茶 ≈ 250 mL · 每人每日饮水 ≈ 2 L。',
			'environmental.methodology.caveat': '所有类比都只是数量级估算。实际数值取决于你所在地区的能源结构、硬件、模型实现和缓存行为。',
			'environmental.methodology.sources': '来源：',
			'environmental.methodology.paperLink': 'Jegham 等人，《How Hungry is AI?》（arXiv:2505.09598）',
			'environmental.methodology.neulandLink': 'neuland/tokendashboard-backend — CO₂ 方法说明',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: efficiency Cost Attribution labels resolve in English', () => {
	const expected: Record<string, string> = {
		'efficiency.attribution.costEffect': 'Estimated cost effect',
		'efficiency.attribution.costEffectLine': 'Estimated cost effect: {0}',
		'efficiency.attribution.change': 'Change',
		'efficiency.attribution.periodSub': '{0} · {1} sessions · {2} tokens',
		'efficiency.attribution.blendedRate': 'blended rate {0} → {1} per M tokens',
		'efficiency.attribution.tooltip.volume': 'Session count: {0} → {1} sessions',
		'efficiency.attribution.tooltip.size': 'Tokens per session: {0} → {1} tokens/session',
		'efficiency.attribution.tooltip.mix': 'Blended price: {0} → {1} per M tokens',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: efficiency Cost Attribution labels resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'efficiency.attribution.costEffect': '预计成本影响',
			'efficiency.attribution.costEffectLine': '预计成本影响：{0}',
			'efficiency.attribution.change': '变化',
			'efficiency.attribution.periodSub': '{0} · {1} 个会话 · {2} 个令牌',
			'efficiency.attribution.blendedRate': '混合费率 {0} → {1} 每百万令牌',
			'efficiency.attribution.tooltip.volume': '会话数：{0} → {1} 个会话',
			'efficiency.attribution.tooltip.size': '每会话令牌数：{0} → {1} 令牌/会话',
			'efficiency.attribution.tooltip.mix': '混合单价：{0} → {1} 每百万令牌',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: log viewer summary card labels resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'logviewer.summary.interactions': '交互次数',
			'logviewer.summary.editorMode': '编辑器模式',
			'logviewer.summary.estimatedTokens': '预计令牌数',
			'logviewer.summary.actualTokens': '实际令牌数',
			'logviewer.summary.modelTurns': '模型轮次',
			'logviewer.summary.inputTokens': '输入令牌',
			'logviewer.summary.outputTokens': '输出令牌',
			'logviewer.summary.cachedInput': '缓存输入',
			'logviewer.summary.estimatedCost': '预估费用',
			'logviewer.summary.estimatedCostSub': '所有轮次合计',
			'logviewer.summary.estimatedCostTooltip': '本会话的预估美元费用，由各轮次费用汇总而成。基于模型定价，可能与实际账单有所不同。',
			'logviewer.summary.thinkingTokens': '思考令牌',
			'logviewer.summary.thinkingEffort': '思考强度',
			'logviewer.summary.subAgents': '子代理',
			'logviewer.summary.contextTruncated': '上下文截断',
			'logviewer.summary.sessionHierarchy': '会话层级',
			'logviewer.summary.toolCalls': '工具调用',
			'logviewer.summary.mcpTools': 'MCP 工具',
			'logviewer.summary.contextRefs': '上下文引用',
			'logviewer.summary.fileName': '文件名',
			'logviewer.summary.editor': '编辑器',
			'logviewer.summary.editorSource': '来源',
			'logviewer.summary.mcpAndContextRefs': 'MCP 工具与上下文引用',
			'logviewer.summary.noModeData': '无模式数据',
			'logviewer.summary.noneShort': '无',
			'logviewer.summary.otherCount': '其他：{0}',
			'logviewer.summary.contextRefsBreakdown': '隐式 {0}，显式 {1}',
			'logviewer.summary.fileSize': '文件大小',
			'logviewer.summary.modified': '修改时间',
			'logviewer.summary.timeline': '时间线',
			'logviewer.summary.started': '开始',
			'logviewer.summary.lastActivity': '最后活动',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: efficiency loading step labels resolve in English', () => {
	const expected: Record<string, string> = {
		'loading.efficiency.dailyActivity': 'Aggregating daily activity…',
		'loading.efficiency.usageAnalysis': 'Analysing usage patterns…',
		'loading.efficiency.sessionSignals': 'Reading session signals…',
		'loading.efficiency.buildingTrends': 'Building efficiency trends…',
		'efficiency.error.title': 'Could not build the Efficiency view',
		'efficiency.error.retry': 'Try again',
		'efficiency.error.staleAfterClear': 'The cached data was cleared while this view was being built.',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: main refresh loading step labels resolve in English', () => {
	const expected: Record<string, string> = {
		'loading.refresh.calculatingStats': 'Calculating usage statistics…',
		'loading.refresh.analyzingUsage': 'Analysing usage patterns…',
		'loading.refresh.scoringFluency': 'Scoring AI fluency…',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});


test('l10n: Cost Attribution model-mix table labels resolve in English', () => {
	const expected: Record<string, string> = {
		'efficiency.modelMix.heading': 'Model mix movement',
		'efficiency.modelMix.caption': 'Token share per model, {0} compared with {1}',
		'efficiency.modelMix.model': 'Model',
		'efficiency.modelMix.previous': 'Previous',
		'efficiency.modelMix.current': 'Current',
		'efficiency.modelMix.shift': 'Shift',
		'efficiency.modelMix.shiftPoints': '{0} pt',
		'efficiency.modelMix.canonicalId': 'Model ID: {0}',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: Cost Attribution model-mix table labels resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'efficiency.modelMix.heading': '模型组合变化',
			'efficiency.modelMix.caption': '各模型的令牌占比，{0} 与 {1} 对比',
			'efficiency.modelMix.model': '模型',
			'efficiency.modelMix.previous': '上一期',
			'efficiency.modelMix.current': '本期',
			'efficiency.modelMix.shift': '变化',
			'efficiency.modelMix.shiftPoints': '{0} 个百分点',
			'efficiency.modelMix.canonicalId': '模型 ID：{0}',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

// HydraFusion Routing section + Session Steps Overview leg toggle (PR #2059
// follow-up) — guards against raw keys resurfacing in the new cost/leg UI.
test('l10n: HydraFusion routing keys resolve in English', () => {
	const expected: Record<string, string> = {
		'logviewer.hydrafusion.cost': 'Cost',
		'logviewer.hydrafusion.costForTurn': 'Cost for this turn',
		'logviewer.hydrafusion.jumpToStepTitle': 'Jump to step #{0} in the Session Steps Overview below',
		'logviewer.hydrafusion.jumpToStepLabel': 'step #{0}',
		'logviewer.hydrafusion.turnDetailIntro': 'Expand a turn to see each leg, what it decided, and what it cost. ● marks the leg whose output you actually received; ✗ marks a leg a judge rejected. The same legs also appear under their step in the Session Steps Overview below.',
		'logviewer.hydrafusion.toggleLegsAriaLabel': 'Toggle HydraFusion legs for step #{0}',
		'logviewer.hydrafusion.showLegsTitle': 'Show the HydraFusion legs behind this step',
		'logviewer.hydrafusion.legsCaptionTotal': '⚡ HydraFusion legs for step #{0} — total',
		'logviewer.hydrafusion.modelChangedTitle': 'Model changed from the previous step',
		'logviewer.hydrafusion.expandStepNote': '⚡ expand a step to see the HydraFusion legs behind it',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: efficiency loading step labels resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'loading.efficiency.dailyActivity': '正在汇总每日活动…',
			'loading.efficiency.usageAnalysis': '正在分析使用模式…',
			'loading.efficiency.sessionSignals': '正在读取会话信号…',
			'loading.efficiency.buildingTrends': '正在构建效率趋势…',
			'efficiency.error.title': '无法构建效率视图',
			'efficiency.error.retry': '重试',
			'efficiency.error.staleAfterClear': '构建此视图时缓存数据已被清除。',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: cache-clear epoch-not-persisted warning resolves in English and zh-cn', () => {
	assert.equal(t('cacheClear.epochNotPersistedWarning'),
		'Cache cleared, but could not confirm the clear to other open windows — they may still show stale data until you clear the cache again. Reloading statistics...');

	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('cacheClear.epochNotPersistedWarning'),
			'缓存已清除，但无法确认其他打开的窗口已收到清除通知——在再次清除缓存之前，它们可能仍显示旧数据。正在重新加载统计数据……');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: main refresh loading step labels resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'loading.refresh.calculatingStats': '正在计算使用统计…',
			'loading.refresh.analyzingUsage': '正在分析使用模式…',
			'loading.refresh.scoringFluency': '正在评估 AI 熟练度…',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});


test('l10n: HydraFusion routing keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'logviewer.hydrafusion.cost': '费用',
			'logviewer.hydrafusion.costForTurn': '本轮费用',
			'logviewer.hydrafusion.jumpToStepTitle': '跳转到下方会话步骤概览中的第 {0} 步',
			'logviewer.hydrafusion.jumpToStepLabel': '第 {0} 步',
			'logviewer.hydrafusion.turnDetailIntro': '展开一轮以查看每个环节、它做出的决定以及它的花费。● 标记你实际收到输出的环节；✗ 标记被评审拒绝的环节。相同的环节也会出现在下方会话步骤概览中对应的步骤下。',
			'logviewer.hydrafusion.toggleLegsAriaLabel': '切换第 {0} 步的 HydraFusion 环节',
			'logviewer.hydrafusion.showLegsTitle': '显示此步骤背后的 HydraFusion 环节',
			'logviewer.hydrafusion.legsCaptionTotal': '⚡ 第 {0} 步的 HydraFusion 环节 — 总计',
			'logviewer.hydrafusion.modelChangedTitle': '模型较上一步已更改',
			'logviewer.hydrafusion.expandStepNote': '⚡ 展开某一步以查看其背后的 HydraFusion 环节',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});



// Efficiency view — Models tab empty states. These explain why a window cannot
// form a comparison, so they must not surface in English for zh-CN users.
test('l10n: Efficiency Models tab empty states resolve in English', () => {
	mock.setLanguage('en');
	const expected: Record<string, string> = {
		'efficiency.models.noPairInWindow': 'Only one model was used in {0} ({1}), so there is no pair to compare. Pick a wider window, or switch to \u201cOne model, two periods\u201d.',
		'efficiency.models.noModelsInWindow': 'No model was used in {0} ({1}). Pick a wider window.',
		'efficiency.models.noSharedModel': 'No model was used in both {0} ({1}) and {2} ({3}), so there is no model to follow across those periods. Pick different periods, or switch to \u201cCompare two models\u201d.',
		'efficiency.models.noSecondModel': '\u2014 no second model in this window \u2014',
		'efficiency.models.search.placeholder': 'Search models\u2026',
		'efficiency.models.search.empty': 'No matching models',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: Efficiency Models tab empty states resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'efficiency.models.noPairInWindow': '{0}\uff08{1}\uff09\u5185\u53ea\u4f7f\u7528\u4e86\u4e00\u4e2a\u6a21\u578b\uff0c\u65e0\u6cd5\u7ec4\u6210\u5bf9\u6bd4\u3002\u8bf7\u9009\u62e9\u66f4\u5927\u7684\u65f6\u95f4\u7a97\u53e3\uff0c\u6216\u5207\u6362\u5230\u201c\u5355\u4e2a\u6a21\u578b\uff0c\u4e24\u4e2a\u65f6\u6bb5\u201d\u3002',
			'efficiency.models.noModelsInWindow': '{0}\uff08{1}\uff09\u5185\u672a\u4f7f\u7528\u4efb\u4f55\u6a21\u578b\u3002\u8bf7\u9009\u62e9\u66f4\u5927\u7684\u65f6\u95f4\u7a97\u53e3\u3002',
			'efficiency.models.noSecondModel': '\u2014 \u6b64\u65f6\u95f4\u7a97\u53e3\u5185\u6ca1\u6709\u7b2c\u4e8c\u4e2a\u6a21\u578b \u2014',
			'efficiency.models.search.placeholder': '\u641c\u7d22\u6a21\u578b\u2026',
			'efficiency.models.search.empty': '\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
		// The two-window message is the only one carrying four placeholders.
		const shared = t('efficiency.models.noSharedModel');
		assert.equal(
			shared,
			'\u6ca1\u6709\u6a21\u578b\u540c\u65f6\u5728{0}\uff08{1}\uff09\u548c{2}\uff08{3}\uff09\u5185\u4f7f\u7528\u8fc7\uff0c\u56e0\u6b64\u65e0\u6cd5\u8de8\u8fd9\u4e24\u4e2a\u65f6\u6bb5\u8ddf\u8e2a\u540c\u4e00\u4e2a\u6a21\u578b\u3002\u8bf7\u9009\u62e9\u5176\u4ed6\u65f6\u6bb5\uff0c\u6216\u5207\u6362\u5230\u201c\u5bf9\u6bd4\u4e24\u4e2a\u6a21\u578b\u201d\u3002',
			'zh-cn value for efficiency.models.noSharedModel',
		);
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Efficiency Models tab control labels resolve in English and zh-cn', () => {
	mock.setLanguage('en');
	const english: Record<string, string> = {
		'efficiency.models.controls.mode': 'Mode',
		'efficiency.models.controls.modelA': 'Model A',
		'efficiency.models.controls.modelB': 'Model B',
		'efficiency.models.controls.model': 'Model',
		'efficiency.models.controls.baseline': 'Baseline',
		'efficiency.models.controls.comparedWith': 'Compared with',
		'efficiency.models.controls.window': 'Window',
		'efficiency.models.mode.models': 'Compare two models',
		'efficiency.models.mode.periods': 'One model, two periods',
	};
	for (const [key, value] of Object.entries(english)) {
		assert.equal(t(key), value, `English value for ${key}`);
	}

	mock.setLanguage('zh-cn');
	try {
		const chinese: Record<string, string> = {
			'efficiency.models.controls.mode': '\u6a21\u5f0f',
			'efficiency.models.controls.modelA': '\u6a21\u578b A',
			'efficiency.models.controls.modelB': '\u6a21\u578b B',
			'efficiency.models.controls.model': '\u6a21\u578b',
			'efficiency.models.controls.baseline': '\u57fa\u51c6\u65f6\u6bb5',
			'efficiency.models.controls.comparedWith': '\u5bf9\u6bd4\u65f6\u6bb5',
			'efficiency.models.controls.window': '\u65f6\u95f4\u7a97\u53e3',
			'efficiency.models.mode.models': '\u5bf9\u6bd4\u4e24\u4e2a\u6a21\u578b',
			'efficiency.models.mode.periods': '\u5355\u4e2a\u6a21\u578b\uff0c\u4e24\u4e2a\u65f6\u6bb5',
		};
		for (const [key, value] of Object.entries(chinese)) {
			assert.equal(t(key), value, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Team Server diagnostics card strings resolve in English and zh-cn', () => {
	mock.setLanguage('en');
	const english: Record<string, string> = {
		'diagnostics.teamServer.configDetails': 'Configuration Details',
		'diagnostics.teamServer.serverUrl': 'Server URL',
		'diagnostics.teamServer.localSessionStats': 'Local Session Statistics',
		'diagnostics.teamServer.totalSessions': 'Total Sessions',
		'diagnostics.teamServer.localSessionFiles': 'Local session files',
		'diagnostics.teamServer.usageData': 'Usage Data',
		'diagnostics.teamServer.lastRollupUpload': 'Last rollup upload',
		'diagnostics.teamServer.fluencyScore': 'Fluency Score',
		'diagnostics.teamServer.uploadedSeparately': 'Uploaded separately',
		'diagnostics.teamServer.status': 'Status',
		'diagnostics.teamServer.sharingProfile': 'Sharing Profile',
		'diagnostics.teamServer.usageSync': 'Usage Sync',
		'diagnostics.teamServer.rollupUploadOnly': 'Rollup upload only',
		'diagnostics.teamServer.never': 'Never',
	};
	for (const [key, value] of Object.entries(english)) {
		assert.equal(t(key), value, `English value for ${key}`);
	}

	mock.setLanguage('zh-cn');
	try {
		const chinese: Record<string, string> = {
			'diagnostics.teamServer.configDetails': '\u914d\u7f6e\u8be6\u60c5',
			'diagnostics.teamServer.serverUrl': '\u670d\u52a1\u5668 URL',
			'diagnostics.teamServer.localSessionStats': '\u672c\u5730\u4f1a\u8bdd\u7edf\u8ba1',
			'diagnostics.teamServer.totalSessions': '\u4f1a\u8bdd\u603b\u6570',
			'diagnostics.teamServer.localSessionFiles': '\u672c\u5730\u4f1a\u8bdd\u6587\u4ef6',
			'diagnostics.teamServer.usageData': '\u4f7f\u7528\u6570\u636e',
			'diagnostics.teamServer.lastRollupUpload': '\u4e0a\u6b21\u6c47\u603b\u4e0a\u4f20',
			'diagnostics.teamServer.fluencyScore': '\u719f\u7ec3\u5ea6\u8bc4\u5206',
			'diagnostics.teamServer.uploadedSeparately': '\u5355\u72ec\u4e0a\u4f20',
			'diagnostics.teamServer.status': '\u72b6\u6001',
			'diagnostics.teamServer.sharingProfile': '\u5171\u4eab\u914d\u7f6e',
			'diagnostics.teamServer.usageSync': '\u4f7f\u7528\u6570\u636e\u540c\u6b65',
			'diagnostics.teamServer.rollupUploadOnly': '\u4ec5\u6c47\u603b\u4e0a\u4f20',
			'diagnostics.teamServer.never': '\u4ece\u4e0d',
		};
		for (const [key, value] of Object.entries(chinese)) {
			assert.equal(t(key), value, `zh-cn value for ${key}`);
		}
		// The two labels that carry the fix: the card was misleading because it did
		// not say which upload it measured, so a translated host losing that
		// distinction would reintroduce the ambiguity this change removes.
		assert.notEqual(t('diagnostics.teamServer.usageSync'), t('diagnostics.teamServer.fluencyScore'), 'The two Team Server timestamps must stay distinguishable in zh-cn');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Copilot Memory Files section strings resolve in English and zh-cn', () => {
	mock.setLanguage('en');
	const english: Record<string, string> = {
		'memoryFiles.sectionTitle': 'Copilot Memory Files',
		'memoryFiles.sectionSubtitle': 'Agent-written memory notes on disk (project conventions, decisions, scratch plans) \u2014 metadata only, content is never read',
		'memoryFiles.summary': '{0} files \u00b7 {1} total',
		'memoryFiles.staleSummary': '{0} stale (>{1}d)',
		'memoryFiles.largeSummary': '{0} unusually large (>{1}KB)',
		'memoryFiles.table.workspace': 'Workspace',
		'memoryFiles.table.repo': 'Repo',
		'memoryFiles.table.session': 'Session',
		'memoryFiles.table.global': 'Global',
		'memoryFiles.table.size': 'Size',
		'memoryFiles.table.stale': 'Stale',
		'memoryFiles.table.lastUpdated': 'Last updated',
		'memoryFiles.unknownWorkspace': 'Unknown workspace',
		'memoryFiles.globalWorkspaceLabel': 'User (global)',
		'memoryFiles.renderError': 'Memory files are temporarily unavailable due to a rendering error. Try Refresh.',
	};
	for (const [key, value] of Object.entries(english)) {
		assert.equal(t(key), value, `English value for ${key}`);
	}
	assert.equal(t('memoryFiles.summary', '4', '24 KB'), '4 files \u00b7 24 KB total');
	assert.equal(t('memoryFiles.staleSummary', '2', '90'), '2 stale (>90d)');
	assert.equal(t('memoryFiles.largeSummary', '1', '10'), '1 unusually large (>10KB)');

	mock.setLanguage('zh-cn');
	try {
		const chinese: Record<string, string> = {
			'memoryFiles.sectionTitle': 'Copilot \u8bb0\u5fc6\u6587\u4ef6',
			'memoryFiles.sectionSubtitle': '\u4ee3\u7406\u5199\u5165\u78c1\u76d8\u7684\u8bb0\u5fc6\u7b14\u8bb0\uff08\u9879\u76ee\u7ea6\u5b9a\u3001\u51b3\u7b56\u3001\u8349\u7a3f\u8ba1\u5212\uff09\u2014 \u4ec5\u5143\u6570\u636e\uff0c\u4ece\u4e0d\u8bfb\u53d6\u6587\u4ef6\u5185\u5bb9',
			'memoryFiles.summary': '{0} \u4e2a\u6587\u4ef6 \u00b7 \u5171 {1}',
			'memoryFiles.staleSummary': '{0} \u4e2a\u8fc7\u671f\uff08\u8d85\u8fc7 {1} \u5929\uff09',
			'memoryFiles.largeSummary': '{0} \u4e2a\u5f02\u5e38\u5927\uff08\u8d85\u8fc7 {1}KB\uff09',
			'memoryFiles.table.workspace': '\u5de5\u4f5c\u533a',
			'memoryFiles.table.repo': '\u4ed3\u5e93',
			'memoryFiles.table.session': '\u4f1a\u8bdd',
			'memoryFiles.table.global': '\u5168\u5c40',
			'memoryFiles.table.size': '\u5927\u5c0f',
			'memoryFiles.table.stale': '\u8fc7\u671f',
			'memoryFiles.table.lastUpdated': '\u6700\u8fd1\u66f4\u65b0',
			'memoryFiles.unknownWorkspace': '\u672a\u77e5\u5de5\u4f5c\u533a',
			'memoryFiles.globalWorkspaceLabel': '\u7528\u6237\uff08\u5168\u5c40\uff09',
			'memoryFiles.renderError': '\u7531\u4e8e\u6e32\u67d3\u9519\u8bef\uff0c\u8bb0\u5fc6\u6587\u4ef6\u6682\u65f6\u4e0d\u53ef\u7528\u3002\u8bf7\u5c1d\u8bd5\u5237\u65b0\u3002',
		};
		for (const [key, value] of Object.entries(chinese)) {
			assert.equal(t(key), value, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Copilot Repository Memories section strings resolve in English and zh-cn', () => {
	mock.setLanguage('en');
	const english: Record<string, string> = {
		'serverMemories.sectionTitle': 'Copilot Repository Memories',
		'serverMemories.sectionSubtitle': 'Facts the Copilot coding agent has stored server-side for this repository (GitHub Settings \u2192 Copilot \u2192 Memory)',
		'serverMemories.summary': '{0} memories \u00b7 {1} subjects',
		'serverMemories.documentedSummary': '{0} already cite an instruction file',
		'serverMemories.staleSummary': '{0} cite only files that no longer exist',
		'serverMemories.promoteHeading': 'Worth adding to AGENTS.md',
		'serverMemories.promoteHint': 'The agent learned these from code alone, so it re-derives them every run. Writing them into an instruction file makes them free.',
		'serverMemories.repeatBadge': 're-learned {0}\u00d7',
		'serverMemories.table.subject': 'Subject',
		'serverMemories.table.fact': 'Fact',
		'serverMemories.table.sources': 'Sources',
		'serverMemories.disabled': 'Memory is turned off for this repository.',
		'serverMemories.unavailable': 'Repository memories could not be read: {0}',
		'serverMemories.renderError': 'Repository memories are temporarily unavailable due to a rendering error. Try Refresh.',
		'serverMemories.truncated': 'Partial — more may exist',
		'serverMemories.truncatedTooltip': 'The server returned a full page of memories, so the counts above describe what was read, not the whole store. These routes have no pagination, so the rest cannot be fetched.',
	};
	for (const [key, value] of Object.entries(english)) {
		assert.equal(t(key), value, `English value for ${key}`);
	}
	// The placeholder-bearing keys are the ones a typo silently breaks: a wrong index leaves
	// a literal "{0}" in the rendered section rather than failing anywhere visible.
	assert.equal(t('serverMemories.summary', '340', '191'), '340 memories \u00b7 191 subjects');
	assert.equal(t('serverMemories.documentedSummary', '99'), '99 already cite an instruction file');
	assert.equal(t('serverMemories.staleSummary', '4'), '4 cite only files that no longer exist');
	assert.equal(t('serverMemories.repeatBadge', '12'), 're-learned 12\u00d7');
	assert.equal(t('serverMemories.unavailable', 'HTTP 403'), 'Repository memories could not be read: HTTP 403');

	mock.setLanguage('zh-cn');
	try {
		const chinese: Record<string, string> = {
			'serverMemories.sectionTitle': 'Copilot \u4ed3\u5e93\u8bb0\u5fc6',
			'serverMemories.sectionSubtitle': 'Copilot \u7f16\u7801\u4ee3\u7406\u4e3a\u672c\u4ed3\u5e93\u5b58\u50a8\u5728\u670d\u52a1\u7aef\u7684\u4e8b\u5b9e\uff08GitHub \u8bbe\u7f6e \u2192 Copilot \u2192 \u8bb0\u5fc6\uff09',
			'serverMemories.summary': '{0} \u6761\u8bb0\u5fc6 \u00b7 {1} \u4e2a\u4e3b\u9898',
			'serverMemories.documentedSummary': '{0} \u6761\u5df2\u5f15\u7528\u6307\u4ee4\u6587\u4ef6',
			'serverMemories.staleSummary': '{0} \u6761\u4ec5\u5f15\u7528\u4e86\u5df2\u4e0d\u5b58\u5728\u7684\u6587\u4ef6',
			'serverMemories.promoteHeading': '\u5efa\u8bae\u5199\u5165 AGENTS.md',
			'serverMemories.repeatBadge': '\u91cd\u590d\u5b66\u4e60 {0} \u6b21',
			'serverMemories.table.subject': '\u4e3b\u9898',
			'serverMemories.table.fact': '\u4e8b\u5b9e',
			'serverMemories.table.sources': '\u6765\u6e90',
			'serverMemories.disabled': '\u672c\u4ed3\u5e93\u5df2\u5173\u95ed\u8bb0\u5fc6\u529f\u80fd\u3002',
			'serverMemories.unavailable': '\u65e0\u6cd5\u8bfb\u53d6\u4ed3\u5e93\u8bb0\u5fc6\uff1a{0}',
			'serverMemories.renderError': '\u7531\u4e8e\u6e32\u67d3\u9519\u8bef\uff0c\u4ed3\u5e93\u8bb0\u5fc6\u6682\u65f6\u4e0d\u53ef\u7528\u3002\u8bf7\u5c1d\u8bd5\u5237\u65b0\u3002',
			'serverMemories.truncated': '部分结果 — 可能还有更多',
			'serverMemories.truncatedTooltip': '服务器返回了整页记忆，因此上述计数只反映已读取的部分，而非全部。该接口不支持分页，因此无法获取剩余内容。',
		};
		for (const [key, value] of Object.entries(chinese)) {
			assert.equal(t(key), value, `zh-cn value for ${key}`);
		}
		assert.equal(t('serverMemories.summary', '340', '191'), '340 \u6761\u8bb0\u5fc6 \u00b7 191 \u4e2a\u4e3b\u9898');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Copilot Budget gauge keys resolve in English', () => {
	// Back the "🎯 Copilot Budget" tooltip row, which folds untracked (other
	// devices/cloud) usage into the headline total so it agrees with the bar's
	// percentage, plus its sub-rows: the tracked/untracked split on one line each
	// and remaining budget on its own. A missing key would put a raw key like
	// `tooltip.budgetRemaining` in the hover tooltip.
	assert.equal(t('tooltip.copilotBudgetLabel'), 'Copilot Budget');
	assert.equal(t('tooltip.budgetRemaining', '$40.79'), '$40.79 left');
	assert.equal(t('tooltip.budgetOverBy', '$12.34'), '$12.34 over');
	assert.equal(t('tooltip.budgetTrackedHere', '$556.61'), '$556.61 tracked here');
	assert.equal(t('tooltip.budgetUntracked', '$202.60'), '$202.60 untracked (other devices/cloud)');
});

test('l10n: Copilot Budget gauge keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('tooltip.copilotBudgetLabel'), 'Copilot 预算');
		assert.equal(t('tooltip.budgetRemaining', '$40.79'), '剩余 $40.79');
		assert.equal(t('tooltip.budgetOverBy', '$12.34'), '超出 $12.34');
		assert.equal(t('tooltip.budgetTrackedHere', '$556.61'), '本设备跟踪 $556.61');
		assert.equal(t('tooltip.budgetUntracked', '$202.60'), '未跟踪(其他设备/云端) $202.60');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Claude Desktop coverage keys resolve in English', () => {
	// Back the Recent Sessions banner that explains why Claude Desktop lists more
	// sessions than this machine can measure. The three summary variants exist
	// because both counts drive agreement independently.
	assert.equal(
		t('usage.claudeDesktopCoverage.summary.oneOfOne', '1', '1'),
		'1 of 1 Claude Desktop session known to this machine has no local transcript left, so it cannot be measured here',
	);
	assert.equal(
		t('usage.claudeDesktopCoverage.summary.singular', '1', '12'),
		'1 of 12 Claude Desktop sessions known to this machine has no local transcript left, so it cannot be measured here',
	);
	assert.equal(
		t('usage.claudeDesktopCoverage.summary.plural', '69', '145'),
		'69 of 145 Claude Desktop sessions known to this machine have no local transcript left, so they cannot be measured here',
	);
	assert.match(t('usage.claudeDesktopCoverage.tooltip'), /cleanupPeriodDays/);
	assert.match(t('usage.claudeDesktopCoverage.tooltip'), /never write a transcript to this machine/);
});

test('l10n: Claude Desktop coverage keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		// Chinese has no verb agreement, so all three variants share one phrasing —
		// but each key must still resolve, or the banner renders a raw key.
		for (const key of ['oneOfOne', 'singular', 'plural']) {
			assert.equal(
				t(`usage.claudeDesktopCoverage.summary.${key}`, '69', '145'),
				'此计算机已知的 145 个 Claude Desktop 会话中，有 69 个已没有本地记录，因此无法在此处统计',
				`zh-cn value for summary.${key}`,
			);
		}
		assert.match(t('usage.claudeDesktopCoverage.tooltip'), /cleanupPeriodDays/);
	} finally {
		mock.setLanguage('en');
	}
});

// ---------------------------------------------------------------------------
// Personalized Insights catalog (issue #2081)
//
// insightsEngine.ts holds 50+ user-facing insights whose titles, bodies and
// action labels all resolve through injected `ctx.translate`. Per AGENTS.md's
// "Localization changes require test coverage" rule, that whole surface needs
// English + zh-CN coverage — table-driven over the catalog and the bundle
// rather than one assertion per key, because there are ~180 of them.
// ---------------------------------------------------------------------------

const INSIGHT_PREFIX = 'insight.';

/** Every `insight.*` key shipped in the English bundle. */
function insightKeys(): string[] {
	return Object.keys(ENGLISH_BUNDLE).filter(k => k.startsWith(INSIGHT_PREFIX));
}

/** The `{0}`, `{1}` … indices a template uses, as a sorted array. */
function placeholders(template: string): string[] {
	return [...new Set([...template.matchAll(/\{(\d+)\}/g)].map(m => m[1]))].sort();
}

test('insights l10n: the catalog actually has keys to cover', () => {
	// Guards the tests below against silently passing on an empty set if the
	// catalog is ever refactored to a different key prefix.
	assert.ok(insightKeys().length > 150, `expected the insight catalog's keys, got ${insightKeys().length}`);
	assert.equal(INSIGHT_CATALOG.length, 53, 'catalog size changed — update the expected count deliberately');
});

test('insights l10n: every catalog title and action label resolves in English', () => {
	for (const def of INSIGHT_CATALOG) {
		for (const key of [def.titleKey, def.actionLabelKey, def.secondaryActionLabelKey]) {
			if (key === undefined) { continue; }
			const value = t(key);
			assert.notEqual(value, key, `${def.id}: "${key}" has no entry in package.nls.json`);
			assert.ok(value.length > 0, `${def.id}: "${key}" resolved to an empty string`);
		}
	}
});

test('insights l10n: every catalog title and action label resolves in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		for (const def of INSIGHT_CATALOG) {
			for (const key of [def.titleKey, def.actionLabelKey, def.secondaryActionLabelKey]) {
				if (key === undefined) { continue; }
				const value = t(key);
				assert.notEqual(value, key, `${def.id}: "${key}" missing from package.nls.zh-cn.json`);
				// Not asserting the text differs from English: a few labels are
				// product names or command names that correctly stay identical.
				assert.ok(value.length > 0, `${def.id}: "${key}" resolved to an empty string in zh-cn`);
			}
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('insights l10n: every insight key has a zh-cn translation', () => {
	mock.setLanguage('zh-cn');
	try {
		const untranslated = insightKeys().filter(k => t(k) === ENGLISH_BUNDLE[k]);
		// Every insight string is prose, so unlike the two known product-name keys
		// elsewhere in the bundle, none of these may fall back to English.
		assert.deepEqual(untranslated, [], 'these insight keys fall back to English on a zh-cn install');
	} finally {
		mock.setLanguage('en');
	}
});

test('insights l10n: zh-cn templates use exactly the English placeholder set', () => {
	// Order may differ — zh-CN deliberately reorders clauses in several of these
	// (e.g. lowContextDiversity puts the session count before the percentage) —
	// but a *missing* index silently drops a live number from the sentence, and
	// an *extra* one renders a literal "{3}" to the user.
	const mismatches: string[] = [];
	for (const key of insightKeys()) {
		mock.setLanguage('zh-cn');
		const zh = t(key);
		mock.setLanguage('en');
		const en = t(key);
		const a = placeholders(en).join(','), b = placeholders(zh).join(',');
		if (a !== b) { mismatches.push(`${key}: en={${a}} zh-cn={${b}}`); }
	}
	mock.setLanguage('en');
	assert.deepEqual(mismatches, []);
});

test('insights l10n: the bundle carries no orphaned insight keys', () => {
	// A key nobody references is dead weight a translator still pays for. Keys
	// are built dynamically (`plural()` appends `.one`/`.other`, and a couple of
	// insights compose `.oneSession.otherEvents`-style suffixes), so a key counts
	// as referenced when it — or the prefix it is derived from — appears in the
	// engine's source.
	// Tests run compiled out of `out/`, so __dirname does not sit next to the
	// real source tree — same hop the other source-reading tests use.
	const source = readFileSync(join(__dirname, '../../../../src/insightsEngine.ts'), 'utf8');
	const orphans = insightKeys().filter(key => {
		const parts = key.split('.');
		// Try the full key, then progressively shorter prefixes, down to the two
		// dynamic suffix segments this file actually builds.
		for (let drop = 0; drop <= 2; drop++) {
			const candidate = parts.slice(0, parts.length - drop).join('.');
			if (candidate.length <= INSIGHT_PREFIX.length) { continue; }
			// Either a plain `'insight.x.y'` literal or the fixed head of a
			// template literal whose suffix is computed (`` `insight.x.${form}` ``).
			// Anchoring on the opening quote character keeps a key from matching a
			// longer, unrelated key that merely starts with the same text.
			// Every quote style, not just the one insightsEngine.ts happens to use
			// today — matching one silently turns a style change into false orphans.
			if (["'", '\"', '`'].some((q) => source.includes(q + candidate))) { return false; }
		}
		return true;
	});
	assert.deepEqual(orphans, [], 'these insight keys are in the bundle but never referenced');
});

test('insights l10n: evaluated insights never leak a raw key into the UI', () => {
	// The end-to-end guard the per-key tests cannot give: t() falls back to
	// returning the key itself for an unknown key, so a typo inside buildBody
	// ships "insight.foo.body" as the visible body text rather than throwing.
	const seen: string[] = [];
	for (const lang of ['en', 'zh-cn']) {
		mock.setLanguage(lang);
		try {
			for (const ctx of insightFixtureContexts(t)) {
				for (const insight of evaluateInsights(ctx, {}, 7, null)) {
					for (const text of [insight.title, insight.body, insight.actionLabel, insight.secondaryActionLabel]) {
						if (text && text.includes(INSIGHT_PREFIX)) {
							seen.push(`${lang}/${insight.id}: ${text}`);
						}
					}
				}
			}
		} finally {
			mock.setLanguage('en');
		}
	}
	assert.deepEqual(seen, [], 'unresolved localization keys rendered as insight text');
});

test('insights l10n: the fixtures render every insight in the catalog', () => {
	// The guarantee the "never leak a raw key" test above depends on: it can only
	// catch a bad key inside an insight that actually fires. Without this, adding
	// an insight with no matching fixture would quietly shrink that test's reach
	// instead of failing.
	const fired = new Set<string>();
	for (const ctx of insightFixtureContexts(t)) {
		for (const insight of evaluateInsights(ctx, {}, 7, null)) { fired.add(insight.id); }
	}
	const never = INSIGHT_CATALOG.map(d => d.id).filter(id => !fired.has(id));
	assert.deepEqual(never, [], 'add a fixture context to test/unit/fixtures/insightContexts.ts for these');
});
// ---------------------------------------------------------------------------
// Locale resolution across script and region variants
//
// Raised in review on #2138: the native hosts (and resolveLocaleId itself) only
// tried the full tag and its bare language, so `zh-Hans` — Simplified Chinese
// with a script but no region — fell through to English even though a zh-cn
// bundle ships. Matching on language + script after Intl maximization fixes the
// whole family at once, while keeping Traditional Chinese out.
// ---------------------------------------------------------------------------

test('l10n: Simplified Chinese tags all resolve to the zh-cn bundle', () => {
	for (const tag of ['zh', 'zh-cn', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG']) {
		assert.equal(resolvedLocale(tag), 'zh-cn', `${tag} should get Simplified Chinese`);
	}
});

test('l10n: Traditional Chinese tags never get the Simplified bundle', () => {
	// The regression this guards is worse than showing English: Traditional
	// readers would be served Simplified text as if it were their language.
	for (const tag of ['zh-TW', 'zh-Hant', 'zh-Hant-TW', 'zh-HK', 'zh-MO']) {
		assert.equal(resolvedLocale(tag), 'en', `${tag} must not get Simplified Chinese`);
	}
});

test('l10n: unshipped and malformed tags fall back to English', () => {
	// `constructor`/`__proto__` also cover the prototype-pollution guard: a
	// lowercase prototype key must not read back as a shipped locale.
	for (const tag of ['fr', 'de-DE', 'pt-BR', 'constructor', '__proto__', 'not a tag', '']) {
		assert.equal(resolvedLocale(tag), 'en', `${tag || '(empty)'} should fall back to English`);
	}
});

test('l10n: zh-Hans actually renders Chinese strings, not just resolves', () => {
	mock.setLanguage('zh-Hans');
	try {
		assert.equal(t('nav.btnRefresh'), '刷新');
	} finally {
		mock.setLanguage('en');
	}
});

// ---------------------------------------------------------------------------
// What's New catalog (step 5 of the localization ADR)
//
// catalog.ts is a pure module holding nls keys rather than prose; extension.ts
// resolves them at the render boundary. These keys reach two surfaces — the
// What's New view and the one-a-day toast — so an unresolved one is doubly
// visible.
// ---------------------------------------------------------------------------

test('whats-new l10n: every catalog key resolves in English and zh-cn', () => {
	const keys: string[] = [];
	for (const release of WHATS_NEW_RELEASES) {
		keys.push(release.headlineKey);
		for (const feature of release.features) {
			keys.push(feature.titleKey, feature.descriptionKey);
		}
	}
	assert.ok(keys.length > 20, `expected the whole catalog's keys, got ${keys.length}`);

	for (const key of keys) {
		assert.notEqual(t(key), key, `${key} has no package.nls.json entry`);
	}

	mock.setLanguage('zh-cn');
	try {
		const untranslated = keys.filter(k => t(k) === ENGLISH_BUNDLE[k]);
		// Release headlines and feature copy are prose; none may fall back.
		assert.deepEqual(untranslated, [], 'these What\'s New keys fall back to English on zh-cn');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: backend Sync Now warnings resolve in English and zh-cn', () => {
	assert.equal(t('backend.syncNow.profileOff'), 'Backend sync is off because the sharing profile is set to Off. Choose another profile to upload data.');
	assert.equal(t('backend.syncNow.notConfigured'), 'Backend is not fully configured. Run "Configure Backend" for Azure Storage or "Configure Team Server Backend" for the Team Server.');
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('backend.syncNow.profileOff'), '后端同步已关闭，因为共享配置文件设置为“关闭”。请选择其他配置文件以上传数据。');
		assert.equal(t('backend.syncNow.notConfigured'), '后端尚未完全配置。请运行“配置后端”以设置 Azure 存储，或运行“配置团队服务器后端”以设置团队服务器。');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: backend Sync Now progress and success text resolve in English and zh-cn', () => {
	assert.equal(t('backend.syncNow.synced', t('backend.syncNow.target.teamServer')), 'Synced to Team Server successfully');
	assert.equal(t('backend.syncNow.synced', t('backend.syncNow.target.azure')), 'Synced to Azure successfully');
	assert.equal(t('backend.syncNow.progress', t('backend.syncNow.target.both')), 'Syncing to Azure and Team Server...');
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('backend.syncNow.synced', t('backend.syncNow.target.teamServer')), '已成功同步到团队服务器');
		assert.equal(t('backend.syncNow.progress', t('backend.syncNow.target.both')), '正在同步到Azure 和团队服务器...');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: backend Sync Now failure and nothing-sent text resolve in English and zh-cn', () => {
	assert.equal(t('backend.syncNow.failed', 'Team Server'), 'Upload to Team Server failed. See the AI Engineering Fluency output channel for details.');
	assert.equal(t('backend.syncNow.nothingSent', 'Team Server'), 'Nothing was uploaded to Team Server. Another VS Code window may be syncing, or the Team Server needs a GitHub sign-in. See the output channel for details.');
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('backend.syncNow.failed', '团队服务器'), '上传到团队服务器失败。有关详细信息，请查看 AI Engineering Fluency 输出通道。');
		assert.equal(t('backend.syncNow.nothingSent', '团队服务器'), '未向团队服务器上传任何数据。可能有另一个 VS Code 窗口正在同步，或者团队服务器需要登录 GitHub。有关详细信息，请查看输出通道。');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: per-account budget strings resolve in English and zh-cn', () => {
	mock.setLanguage('en');
	const english: Record<string, string> = {
		'accountBudgets.title': 'GitHub accounts in VS Code',
		'accountBudgets.usedLeft': '{0} / {1} used · {2}% left',
		'accountBudgets.resets': 'resets {0}',
		'accountBudgets.noQuota': 'No metered budget on this plan',
		'accountBudgets.unavailable': 'Budget unavailable',
		'accountBudgets.noSession': 'Sign in with this account from the Accounts menu to see its budget',
		'accountBudgets.lookupFailed': 'Copilot plan lookup failed ({0})',
	};
	for (const [key, value] of Object.entries(english)) {
		assert.equal(t(key), value, `English value for ${key}`);
	}

	mock.setLanguage('zh-cn');
	try {
		const chinese: Record<string, string> = {
			'accountBudgets.title': 'VS Code 中的 GitHub 帐户',
			'accountBudgets.usedLeft': '已使用 {0} / {1} · 剩余 {2}%',
			'accountBudgets.resets': '{0} 重置',
			'accountBudgets.noQuota': '此计划没有计量预算',
			'accountBudgets.unavailable': '预算不可用',
			'accountBudgets.noSession': '请从“帐户”菜单使用此帐户登录以查看其预算',
			'accountBudgets.lookupFailed': 'Copilot 计划查询失败（{0}）',
		};
		assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort(), 'every new key has a zh-cn assertion');
		for (const [key, value] of Object.entries(chinese)) {
			assert.equal(t(key), value, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: Diagnostics API-driven budget hint strings resolve in English and zh-cn', () => {
	mock.setLanguage('en');
	assert.equal(t('diagnostics.apiBudgetHint.label'), "ℹ️ API-driven budget:");
	assert.equal(t('diagnostics.apiBudgetHint.body'), "Your premium_interactions quota entitlement is {0}/month. If the budget above is 0 or empty, this API value will be used as your effective budget.");
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('diagnostics.apiBudgetHint.label'), "ℹ️ API 驱动的预算：");
		assert.equal(t('diagnostics.apiBudgetHint.body'), "您的 premium_interactions 配额权益为 {0}/月。如果上方预算为 0 或为空，将使用此 API 值作为有效预算。");
	} finally {
		mock.setLanguage('en');
	}
});

// Efficiency scope toolbar (issue #1965) — the time presets, resolution,
// drill-down and editor/vendor filters. Guards against raw keys surfacing in
// the toolbar, and against the zh-CN bundle drifting away from the English one.
test('l10n: efficiency scope toolbar labels resolve in English', () => {
	const expected: Record<string, string> = {
		'efficiency.scope.timeRangeGroup': 'Time range',
		'efficiency.range.last30d': '30 days',
		'efficiency.range.last12w': '12 weeks',
		'efficiency.range.last6m': '6 months',
		'efficiency.range.last1y': '1 year',
		'efficiency.resolution.label': 'Resolution',
		'efficiency.resolution.auto': 'Auto ({0})',
		'efficiency.resolution.daily': 'Daily',
		'efficiency.resolution.weekly': 'Weekly',
		'efficiency.resolution.monthly': 'Monthly',
		'efficiency.scope.editorLabel': 'Editor',
		'efficiency.scope.allEditors': 'All editors',
		'efficiency.scope.vendorLabel': 'Model vendor',
		'efficiency.scope.allVendors': 'All vendors',
		'efficiency.scope.drillLabel': 'Drill',
		'efficiency.scope.drillPlaceholder': 'Drill into…',
		'efficiency.scope.back': '↩ Back',
		'efficiency.scope.backAria': 'Back to the previous range',
		'efficiency.scope.drillHintWeekly': 'Click a week on a chart to drill into its days',
		'efficiency.scope.drillHintMonthly': 'Click a month on a chart to drill into its days',
		'efficiency.scope.announce': 'Showing {0}.',
		'efficiency.scope.behaviorGap': '⚠️ Session-derived metrics (active minutes, retry rate, apply rate, skills) are only collected for the last {0} weeks, so earlier buckets in this range show gaps rather than zeros.',
		'efficiency.scope.editorScoped': 'Scoped to {0}. Sessions whose editor could not be determined are excluded from this view.',
		'efficiency.scope.noDataFor': 'No data for {0}',
		'efficiency.trends.bucketIntro': '{0} ratios over {1} ({2}).',
		'efficiency.trends.bucketsDaily': '{0} days',
		'efficiency.trends.bucketsWeekly': '{0} weeks',
		'efficiency.trends.bucketsMonthly': '{0} months',
		'efficiency.trends.badges': 'Badges compare the recent half of the window against the earlier half; green means the ratio moved in the efficient direction.',
		'efficiency.trends.partialDaily': 'The current day is partial.',
		'efficiency.trends.partialWeekly': 'The current week is partial.',
		'efficiency.trends.partialMonthly': 'The current month is partial.',
	};
	for (const [key, english] of Object.entries(expected)) {
		assert.equal(t(key), english, `English value for ${key}`);
	}
});

test('l10n: efficiency scope toolbar labels resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		const expected: Record<string, string> = {
			'efficiency.range.last30d': '30 天',
			'efficiency.range.last12w': '12 周',
			'efficiency.range.last6m': '6 个月',
			'efficiency.range.last1y': '1 年',
			'efficiency.resolution.label': '粒度',
			'efficiency.resolution.auto': '自动（{0}）',
			'efficiency.resolution.daily': '按天',
			'efficiency.resolution.weekly': '按周',
			'efficiency.resolution.monthly': '按月',
			'efficiency.scope.editorLabel': '编辑器',
			'efficiency.scope.allEditors': '所有编辑器',
			'efficiency.scope.vendorLabel': '模型厂商',
			'efficiency.scope.allVendors': '所有厂商',
			'efficiency.scope.drillLabel': '下钻',
			'efficiency.scope.drillPlaceholder': '下钻到…',
			'efficiency.scope.back': '↩ 返回',
			'efficiency.scope.backAria': '返回上一个范围',
			'efficiency.scope.announce': '当前显示：{0}。',
			'efficiency.scope.timeRangeGroup': '时间范围',
			'efficiency.scope.drillHintWeekly': '点击图表中的某一周可下钻查看其各天数据',
			'efficiency.scope.drillHintMonthly': '点击图表中的某一月可下钻查看其各天数据',
			'efficiency.scope.behaviorGap': '⚠️ 会话派生指标（活跃分钟数、重试率、应用率、技能）仅收集最近 {0} 周的数据，因此该范围内较早的分桶显示为缺口而非零值。',
			'efficiency.scope.editorScoped': '已限定为 {0}。无法确定所属编辑器的会话不计入此视图。',
			'efficiency.scope.noDataFor': '{0}（无数据）',
			'efficiency.trends.bucketIntro': '{1}的{0}比率（{2}）。',
			'efficiency.trends.bucketsDaily': '{0} 天',
			'efficiency.trends.bucketsWeekly': '{0} 周',
			'efficiency.trends.bucketsMonthly': '{0} 个月',
			'efficiency.trends.badges': '徽章将窗口的近半段与前半段进行比较；绿色表示比率朝更高效的方向变化。',
			'efficiency.trends.partialDaily': '当前这一天尚未结束。',
			'efficiency.trends.partialWeekly': '当前这一周尚未结束。',
			'efficiency.trends.partialMonthly': '当前这一月尚未结束。',
		};
		for (const [key, chinese] of Object.entries(expected)) {
			assert.equal(t(key), chinese, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: efficiency placeholder templates keep their {0} slot for localizeFormat', () => {
	for (const key of ['efficiency.resolution.auto', 'efficiency.scope.announce', 'efficiency.scope.behaviorGap', 'efficiency.scope.editorScoped', 'efficiency.scope.noDataFor', 'efficiency.trends.bucketsDaily', 'efficiency.trends.bucketsWeekly', 'efficiency.trends.bucketsMonthly']) {
		assert.ok(t(key).includes('{0}'), `${key} must carry a {0} placeholder`);
	}
	// The trends intro fills three slots — resolution, range and bucket count.
	for (const slot of ['{0}', '{1}', '{2}']) {
		assert.ok(t('efficiency.trends.bucketIntro').includes(slot), `efficiency.trends.bucketIntro must carry a ${slot} placeholder`);
	}
});

test('l10n: Tools & Integrations tool-execution section strings resolve in both languages', () => {
	assert.equal(t('usage.toolExec.reliability.title'), 'Tool execution reliability');
	assert.equal(t('usage.toolExec.latency.title'), 'Tool latency profile');
	assert.equal(t('usage.toolExec.mcp.title'), 'MCP server health');
	assert.equal(t('usage.toolExec.costSpeed.title'), 'Cost vs speed map');
	assert.equal(t('usage.toolExec.costSpeed.hint'), 'top-right = heavy & slow');
	assert.equal(t('usage.toolExec.mcpLabel', '1,211', '6%'), '1,211 · 6% fail');
	assert.equal(t('usage.toolExec.legend.failure'), 'Failure');
	assert.equal(t('usage.toolExec.empty.mcp'), 'No MCP server calls with a recorded outcome in this period.');
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('usage.toolExec.reliability.title'), '工具执行可靠性');
		assert.equal(t('usage.toolExec.latency.title'), '工具延迟分布');
		assert.equal(t('usage.toolExec.mcp.title'), 'MCP 服务器健康度');
		assert.equal(t('usage.toolExec.costSpeed.title'), '成本与速度图');
		assert.equal(t('usage.toolExec.mcpLabel', '1,211', '6%'), '1,211 · 6% 失败');
		assert.equal(t('usage.toolExec.legend.failure'), '失败');
	} finally {
		mock.setLanguage('en');
	}
});

test('l10n: tool-execution tooltips, table headers and the 0.19.1 What\'s New entry resolve in both languages', () => {
	assert.equal(t('usage.toolExec.tip.reliability', 'View', '30', '10'), 'View: 30 succeeded, 10 failed');
	assert.equal(t('usage.toolExec.tip.latency', 'Bash', '3.3s', '55s', '451'), 'Bash: p50 3.3s, p95 55s, 451 calls');
	assert.equal(t('usage.toolExec.table.show'), 'Show as table');
	assert.equal(t('usage.toolExec.col.completed'), 'Completed calls');
	assert.equal(t('usage.toolExec.empty.latency'), 'No tool latency data yet. It is recorded from Copilot CLI, JetBrains, Claude Code and Claude Desktop sessions.');
	assert.equal(t('whatsNew.release.0.19.1.headline'), 'The Tools & Integrations tab now shows how reliable and how slow each tool is, which MCP servers fail, and a cost-vs-speed map of your built-in, subagent and skill tools.');
	assert.equal(t('whatsNew.feature.usage.tool-execution-stats.title'), 'Tool reliability, latency and MCP health');
	assert.ok(t('whatsNew.feature.usage.tool-execution-stats.description').includes('cost-vs-speed map'));
	assert.equal(t('whatsNew.feature.whatsnew.view-index.title'), 'View index');
	assert.equal(t('whatsNew.logviewerHint'), 'Open a session from this list to see it in the Session Log Viewer.');
	assert.equal(t('viewIndex.navigationFailed', 'boom'), 'Could not open that view: boom');
	assert.ok(t('whatsNew.feature.whatsnew.view-index.description').startsWith('A searchable map of every view, tab and section'));
	assert.equal(t('whatsNew.footer', '0.19.1'), 'Running version 0.19.1. The full changelog, including fixes, ships with the extension.');
	assert.equal(t('viewIndex.summary', '97', '10'), '97 entries across 10 views');
	assert.equal(t('viewIndex.matchMany', '3'), '3 matches');
	assert.equal(t('viewIndex.noMatchStatus', 'xyz'), 'Nothing matches “xyz”. Try fewer or shorter words.');
	assert.equal(t('viewIndex.searchPlaceholder'), 'Search views, tabs and sections…');
	assert.equal(t('viewIndex.searchLabel'), 'Search the view index');
	assert.equal(t('viewIndex.treeLabel'), 'View index');
	assert.equal(t('viewIndex.expand', 'Usage'), 'Expand Usage');
	assert.equal(t('viewIndex.collapse', 'Usage'), 'Collapse Usage');
	assert.equal(t('viewIndex.open', 'Usage › Tools'), 'Open Usage › Tools');
	assert.equal(t('viewIndex.matchOne'), '1 match');
	assert.equal(t('viewIndex.noMatch'), 'No matching views, tabs or sections.');
	assert.ok(t('viewIndex.intro').startsWith('Every view you can open, with its tabs and sections.'));
	assert.equal(t('whatsNew.tabs.label'), "What's New sections");
	assert.equal(t('whatsNew.tab.releases'), '📣 Releases');
	assert.equal(t('whatsNew.tab.index'), '🧭 View index');
	mock.setLanguage('zh-cn');
	try {
		assert.equal(t('usage.toolExec.tip.reliability', 'View', '30', '10'), 'View：成功 30 次，失败 10 次');
		assert.equal(t('usage.toolExec.table.show'), '以表格显示');
		assert.equal(t('usage.toolExec.col.completed'), '已完成调用');
		assert.equal(t('usage.toolExec.empty.latency'), '暂无工具延迟数据。该数据来自 Copilot CLI、JetBrains、Claude Code 和 Claude Desktop 会话。');
		assert.equal(t('whatsNew.feature.usage.tool-execution-stats.title'), '工具可靠性、延迟与 MCP 健康度');
		assert.equal(t('whatsNew.feature.whatsnew.view-index.title'), '视图索引');
		assert.equal(t('whatsNew.logviewerHint'), '从此列表中打开一个会话，即可在会话日志查看器中查看。');
		assert.equal(t('viewIndex.navigationFailed', 'boom'), '无法打开该视图：boom');
		assert.ok(t('whatsNew.feature.whatsnew.view-index.description').startsWith('“新增功能”中的一个新标签页'));
		assert.equal(t('viewIndex.summary', '97', '10'), '10 个视图中共 97 个条目');
		assert.equal(t('viewIndex.matchMany', '3'), '3 个匹配项');
		assert.equal(t('whatsNew.tab.index'), '🧭 视图索引');
		assert.equal(t('whatsNew.tab.releases'), '📣 版本');
		assert.equal(t('whatsNew.tabs.label'), '新增功能分区');
		assert.equal(t('whatsNew.footer', '0.19.1'), '当前运行版本 0.19.1。包含修复内容的完整更新日志随扩展一起提供。');
		assert.equal(t('viewIndex.searchPlaceholder'), '搜索视图、标签页和部分…');
		assert.equal(t('viewIndex.searchLabel'), '搜索视图索引');
		assert.equal(t('viewIndex.treeLabel'), '视图索引');
		assert.equal(t('viewIndex.expand', 'X'), '展开 X');
		assert.equal(t('viewIndex.collapse', 'X'), '折叠 X');
		assert.equal(t('viewIndex.open', 'X'), '打开 X');
		assert.equal(t('viewIndex.matchOne'), '1 个匹配项');
		assert.equal(t('viewIndex.noMatchStatus', 'xyz'), '没有与“xyz”匹配的内容。请尝试更少或更短的词。');
		assert.equal(t('viewIndex.noMatch'), '没有匹配的视图、标签页或部分。');
		assert.ok(t('viewIndex.intro').startsWith('你可以打开的每个视图及其标签页和部分。'));
		assert.equal(t('whatsNew.release.0.19.1.headline'), '工具与集成标签页现在可以显示每个工具的可靠性和速度、哪些 MCP 服务器会失败，以及内置、子代理与技能工具的成本与速度图。');
	} finally {
		mock.setLanguage('en');
	}
});

const WORKTREE_CLEANUP_KEYS: Record<string, { en: string; zh: string }> = {
	'usage.worktreeCleanup.sizeChip': { en: 'Size: {0}', zh: '大小：{0}' },
	'usage.worktreeCleanup.sizeChipTitle': { en: '{0} bytes on disk', zh: '磁盘占用 {0} 字节' },
	'usage.worktreeCleanup.deleting': { en: '⏳ Deleting worktree{0}…', zh: '⏳ 正在删除工作树{0}…' },
	'usage.worktreeCleanup.deleted': { en: '✅ Deleted', zh: '✅ 已删除' },
	'usage.worktreeCleanup.deleteFailed': { en: '❌ Delete failed: {0}', zh: '❌ 删除失败：{0}' },
	'usage.worktreeCleanup.unknownError': { en: 'unknown error', zh: '未知错误' },
	'usage.worktreeCleanup.revealMissing': { en: '"{0}" no longer exists on disk.', zh: '“{0}”在磁盘上已不存在。' },
};

test('worktree cleanup delete-feedback keys resolve to their English text', () => {
	for (const [key, { en }] of Object.entries(WORKTREE_CLEANUP_KEYS)) {
		assert.equal(t(key), en, `en value for ${key}`);
	}
});

test('worktree cleanup delete-feedback keys resolve in zh-cn', () => {
	mock.setLanguage('zh-cn');
	try {
		for (const [key, { zh }] of Object.entries(WORKTREE_CLEANUP_KEYS)) {
			assert.equal(t(key), zh, `zh-cn value for ${key}`);
		}
	} finally {
		mock.setLanguage('en');
	}
});
