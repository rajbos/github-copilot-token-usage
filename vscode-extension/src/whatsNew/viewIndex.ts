/**
 * A map of everything the extension can show you: every view you can open
 * directly, its tabs (and tab groups), and the sections on each tab, each with
 * a short description. The Session Log Viewer is the one panel left out as a
 * view of its own: it only opens on a specific session, so it is listed where
 * you open it from (Recent Sessions, Diagnostics › Session Files).
 *
 * Rendered as the **View index** tab of the What's New panel, where it can be
 * fuzzy-searched and every line can open its surface — the view, the right
 * tab, scrolled to the right section.
 *
 * Pure data, no `vscode` import: the What's New webview bundles it directly
 * (so the index costs nothing in the panel's initial payload), and the host
 * imports it to resolve an entry id back into somewhere to navigate to.
 *
 * ## Keeping it honest
 *
 * Navigation is declared, not inferred, so it can rot. `viewIndex.test.ts`
 * checks the structure (unique ids, a description on every line) and that
 * every tab and anchor named here still appears in that view's webview
 * sources. When you add a tab or section to a panel, add it here too — a
 * feature that is not in the index is one fewer thing a user can find.
 *
 * - `tab` is the tab button's `data-tab` value. The group a tab sits in is
 *   found from the DOM at navigation time, so it is never declared here.
 * - `anchor` is an element id to scroll to; give a section an id rather than
 *   reach for `selector` (a CSS selector, first match wins) where you can.
 * - Navigation is inherited: a section only declares its own `anchor`, the
 *   tab comes from its parent.
 */
import type { FeatureViewId } from './catalog';

export interface ViewIndexNavigation {
	/** `data-tab` of the tab to open. */
	readonly tab?: string;
	/** `data-subtab` of a sub-tab within that tab. */
	readonly subtab?: string;
	/** Element id to scroll to. */
	readonly anchor?: string;
	/** CSS selector to scroll to, for a section with no id. */
	readonly selector?: string;
}

export interface ViewIndexNode {
	/** Stable, unique id. The webview posts it back to open the entry. */
	readonly id: string;
	readonly title: string;
	/** One or two sentences: what it shows and why you'd look. */
	readonly description: string;
	/** Extra search terms that appear in neither the title nor the description. */
	readonly keywords?: readonly string[];
	/** Navigation this node adds on top of its ancestors'. */
	readonly nav?: ViewIndexNavigation;
	/** Shown only under some condition (e.g. data present, a backend configured). */
	readonly condition?: string;
	readonly children?: readonly ViewIndexNode[];
}

export interface ViewIndexView extends ViewIndexNode {
	readonly view: FeatureViewId;
}

/** A node with its navigation fully resolved against its ancestors. */
export interface ViewIndexEntry {
	readonly id: string;
	readonly view: FeatureViewId;
	readonly nav: ViewIndexNavigation;
	/** Titles from the view down to this node. */
	readonly path: readonly string[];
	readonly node: ViewIndexNode;
}

export const VIEW_INDEX: readonly ViewIndexView[] = [
	{
		id: 'details',
		view: 'details',
		title: 'AI Engineering Fluency (Details)',
		description: 'The at-a-glance overview: tokens, estimated cost and sessions for today, this month and the projected year.',
		keywords: ['overview', 'home', 'summary', 'status bar'],
		children: [
			{
				id: 'details.cost-by-provider',
				title: 'Cost by Provider',
				description: 'Estimated spend per AI provider. Click a provider to include or exclude it from the totals below.',
				keywords: ['spend', 'price', 'filter'],
				nav: { anchor: 'section-cost-by-provider' },
				condition: 'When two or more providers have cost this month',
			},
			{
				id: 'details.key-metrics',
				title: 'Key Metrics',
				description: 'Tokens, cost, sessions and CO₂ side by side for today, the last 30 days, this month, last month and the projected year.',
				keywords: ['tokens', 'cost', 'co2', 'projection'],
				nav: { anchor: 'section-key-metrics' },
			},
			{
				id: 'details.editor-usage',
				title: 'Usage by Editor',
				description: 'Token usage per editor or CLI (VS Code, Visual Studio, JetBrains, Copilot CLI, Claude Code…).',
				keywords: ['ide', 'cli', 'tools'],
				nav: { anchor: 'section-editor-usage' },
			},
			{
				id: 'details.model-usage',
				title: 'Model Usage (Tokens)',
				description: 'Which models consumed your tokens, per period.',
				keywords: ['gpt', 'claude', 'gemini', 'llm'],
				nav: { anchor: 'section-model-usage' },
			},
		],
	},
	{
		id: 'chart',
		view: 'chart',
		title: 'Token Usage Over Time (Chart)',
		description: 'Daily, weekly or monthly charts of tokens, output, cost or sessions, split by model, editor, provider, repository, language or task.',
		keywords: ['graph', 'trend', 'history', 'timeline'],
		children: [
			{
				id: 'chart.summary',
				title: 'Summary cards',
				description: 'Period count, total and average tokens and sessions for the selected window, plus a per-editor breakdown.',
				keywords: ['totals', 'by editor'],
				nav: { anchor: 'summary-cards' },
			},
			{
				id: 'chart.chart',
				title: 'Chart & controls',
				description: 'The chart itself with period, metric and split toggles, a rolling average and a time-window picker. Output split by language shows a heatmap.',
				keywords: ['split', 'rolling average', 'heatmap', 'cost by model', 'repository', 'language'],
				nav: { anchor: 'token-chart' },
			},
		],
	},
	{
		id: 'usage',
		view: 'usage',
		title: 'AI Usage Analysis',
		description: 'The deep dive: how you use AI, which tools and models, workspace setup, GitHub activity and coaching tips.',
		keywords: ['analysis', 'dashboard'],
		children: [
			{
				id: 'usage.group.usage',
				title: 'Usage',
				description: 'Your own activity: interaction modes, spend, models and context, plus every recent session.',
				nav: { tab: 'activity' },
				children: [
					{
						id: 'usage.activity',
						title: 'My Activity',
						description: 'How you work with AI: modes, spend, models and context use over the recent periods.',
						nav: { tab: 'activity' },
						children: [
							{ id: 'usage.activity.sessions-summary', title: 'Sessions Summary', description: 'Session counts for today, the last 30 days, this month and last month.', nav: { anchor: 'section-sessions-summary' } },
							{ id: 'usage.activity.interaction-modes', title: 'Interaction Modes', description: 'How often you use Ask, Edit, Agent, Plan and CLI modes, today and over the last 30 days.', keywords: ['ask', 'edit', 'agent', 'plan'], nav: { anchor: 'section-interaction-modes' } },
							{ id: 'usage.activity.billing-coverage', title: 'AI Billing Coverage', description: 'Copilot API credit balance against locally tracked cost, plus costs from other providers.', keywords: ['budget', 'credits', 'premium requests'], nav: { anchor: 'section-billing-coverage' }, condition: 'When billing data is available' },
							{ id: 'usage.activity.model-cost', title: 'Model Cost Usage', description: 'Share of requests on low, medium and high cost models for three periods.', keywords: ['tier', 'expensive'], nav: { anchor: 'section-model-cost' } },
							{ id: 'usage.activity.model-leaderboard', title: 'Local Model Leaderboard', description: 'Efficiency frontier and a per-model table: one-shot edit rate, cost, tokens and tool steps.', keywords: ['model efficiency', 'compare models'], nav: { anchor: 'section-model-efficiency' } },
							{ id: 'usage.activity.thinking-effort', title: 'Thinking Effort (Reasoning)', description: 'Requests per reasoning-effort level for three periods.', keywords: ['reasoning'], nav: { anchor: 'section-thinking-effort' }, condition: 'When effort data exists' },
							{ id: 'usage.activity.context-references', title: 'Context References', description: 'How often you attach #file, @workspace and other references, and which files you reference most.', keywords: ['#file', '@workspace'], nav: { anchor: 'section-context-references' } },
							{ id: 'usage.activity.context-window', title: 'Context Window & Long-Context Pricing', description: 'Your largest requests against the long-context price line, context tiers and automatic compactions.', keywords: ['compaction', 'tokens limit'], nav: { anchor: 'section-context-window' } },
						],
					},
					{
						id: 'usage.sessions',
						title: 'Recent Sessions',
						description: 'Every recent session in a filterable table. Open a session to read it turn by turn in the Session Log Viewer.',
						keywords: ['history', 'conversations', 'chats', 'session log viewer', 'turns', 'columns'],
						nav: { tab: 'sessions' },
					},
				],
			},
			{
				id: 'usage.group.workspace',
				title: 'Workspace',
				description: 'How your workspaces are set up for AI: tools and integrations, customization files, readiness and worktrees.',
				nav: { tab: 'tools' },
				children: [
					{
						id: 'usage.tools',
						title: 'Tools & Integrations',
						description: 'Which tools and MCP servers the agent calls, how reliable and fast they are, and which you could drop.',
						keywords: ['mcp'],
						nav: { tab: 'tools' },
						children: [
							{ id: 'usage.tools.tool-usage', title: 'Tool Usage', description: 'Tool calls per tool for today, the last 30 days and last month.', nav: { anchor: 'section-tool-usage' } },
							{ id: 'usage.tools.reliability', title: 'Tool execution reliability', description: 'Success and failure counts per tool over the last 30 days.', keywords: ['errors', 'failures'], nav: { anchor: 'section-tool-reliability' } },
							{ id: 'usage.tools.latency', title: 'Tool latency profile', description: 'p50 and p95 duration per tool.', keywords: ['slow', 'duration', 'performance'], nav: { anchor: 'section-tool-latency' } },
							{ id: 'usage.tools.mcp-health', title: 'MCP server health', description: 'Calls and failure share per MCP server.', nav: { anchor: 'section-mcp-health' } },
							{ id: 'usage.tools.cost-speed', title: 'Cost vs speed map', description: 'Bubble chart of tool latency against the tokens each tool returns.', nav: { anchor: 'section-tool-cost-speed' } },
							{ id: 'usage.tools.mcp-tools', title: 'MCP Tools', description: 'MCP calls by server and by tool for three periods, and any unknown tools you can report.', keywords: ['unknown tools'], nav: { anchor: 'section-mcp-tools' } },
							{ id: 'usage.tools.curation', title: 'Tool Curation', description: 'Available versus used tools, the prompt overhead they cost, and unused MCP servers, plugins, built-ins and skills.', keywords: ['unused', 'overhead', 'trim'], nav: { anchor: 'section-tool-curation' }, condition: 'When tool definitions were captured' },
							{ id: 'usage.tools.memory-files', title: 'Copilot Memory Files', description: 'Memory files per workspace with size, stale entries and last update.', keywords: ['memories', 'hygiene'], nav: { anchor: 'section-memory-files' }, condition: 'When memory files exist' },
							{ id: 'usage.tools.server-memories', title: 'Copilot Repository Memories', description: 'Server-side agent memories for this repository and candidates to promote into instructions.', nav: { anchor: 'section-server-memories' }, condition: 'When the workspace is a GitHub repository' },
							{ id: 'usage.tools.skill-suggestions', title: 'Skill Suggestions', description: 'Prompts you keep repeating that would make good reusable skills.', keywords: ['repeated prompts'], nav: { anchor: 'section-skill-suggestions' }, condition: 'When repeated prompts are found' },
							{ id: 'usage.tools.multi-model', title: 'Multi-Model Usage', description: 'How many models you use and how often you switch between them within a conversation.', keywords: ['switching'], nav: { anchor: 'section-multi-model' } },
						],
					},
					{
						id: 'usage.health',
						title: 'Workspace Health',
						description: 'Customization files per workspace, missed potential from other AI tools, and repository hygiene checks.',
						nav: { tab: 'health' },
						children: [
							{ id: 'usage.health.customization', title: 'Copilot Customization Files', description: 'Which workspaces have instructions, prompts, agents and skills set up for Copilot.', keywords: ['instructions', 'agents.md', 'copilot-instructions'], nav: { anchor: 'section-customization-files' } },
							{ id: 'usage.health.missed-potential', title: 'Missed Potential', description: 'Workspaces with instruction files for other AI tools but no Copilot equivalent.', keywords: ['claude.md', 'cursor rules'], nav: { anchor: 'section-missed-potential' } },
							{ id: 'usage.health.repo-hygiene', title: 'Repository Hygiene Analysis', description: 'Per-repository checks for the setup that helps agents do good work.', nav: { anchor: 'section-repo-hygiene' } },
						],
					},
					{
						id: 'usage.readiness',
						title: 'AI Readiness',
						description: 'How ready each repository is for autonomous agents, stage by stage, with what is missing.',
						keywords: ['dark factory', 'maturity', 'controls'],
						nav: { tab: 'readiness' },
						condition: 'When a readiness scan is available',
					},
					{
						id: 'usage.worktrees',
						title: 'Worktrees',
						description: 'Finds git worktrees under the folders you choose, grouped by repository with their disk usage.',
						keywords: ['disk space', 'cleanup'],
						nav: { tab: 'worktrees' },
						children: [
							{ id: 'usage.worktrees.roots', title: 'Root Folders', description: 'Choose which folders to scan and start the scan.', nav: { anchor: 'worktree-controls' } },
							{ id: 'usage.worktrees.results', title: 'Results', description: 'Worktrees grouped by repository, with disk usage and status.', nav: { anchor: 'worktree-results' } },
						],
					},
				],
			},
			{
				id: 'usage.group.github',
				title: 'GitHub',
				description: 'AI activity on GitHub itself: pull requests and cloud agent sessions.',
				nav: { tab: 'repos' },
				children: [
					{ id: 'usage.repos', title: 'Repository PRs', description: 'Pull requests from the last 30 days that AI authored or was asked to review.', keywords: ['pull requests', 'review'], nav: { tab: 'repos' } },
					{ id: 'usage.agent', title: 'Cloud Agent', description: 'Copilot cloud agent tasks and sessions from the last 30 days, with credits and premium requests.', keywords: ['coding agent', 'copilot agent'], nav: { tab: 'agent' } },
				],
			},
			{
				id: 'usage.group.coaching',
				title: 'Coaching',
				description: 'Personal tips based on your usage, and the moments where you had to correct the AI.',
				nav: { tab: 'insights' },
				children: [
					{ id: 'usage.insights', title: 'Insights', description: 'New tips picked for you, and the full list of tips.', keywords: ['tips', 'recommendations', 'for you'], nav: { tab: 'insights' } },
					{ id: 'usage.corrections', title: 'Corrections', description: 'Moments where you corrected the AI, per repository and session, with filters.', keywords: ['mistakes', 'retries'], nav: { tab: 'corrections' } },
				],
			},
		],
	},
	{
		id: 'efficiency',
		view: 'efficiency',
		title: 'AI Efficiency Trends',
		description: 'Is AI getting cheaper and more effective for you? Trends, month-on-month changes, cost attribution and model comparisons.',
		keywords: ['roi', 'value', 'productivity'],
		children: [
			{ id: 'efficiency.trends', title: 'Trends', description: 'Cost per 1K lines changed, tokens and turns per session, edit retry and apply rate over time.', nav: { tab: 'trends' } },
			{ id: 'efficiency.skills', title: 'Tools & Skills', description: 'Tool and skill use over time, and whether skill-assisted sessions run differently.', nav: { tab: 'skills' } },
			{ id: 'efficiency.deltas', title: 'Month vs Month', description: 'Each efficiency metric for this month against last month.', keywords: ['compare', 'delta'], nav: { tab: 'deltas' } },
			{
				id: 'efficiency.attribution',
				title: 'Cost Attribution',
				description: 'What moved your cost: volume, session size or model mix.',
				nav: { tab: 'attribution' },
				children: [
					{ id: 'efficiency.attribution.model-mix', title: 'Model mix movement', description: 'Which models gained or lost share between the periods, and what that did to cost.', nav: { anchor: 'attr-shift-heading' }, condition: 'When the model mix shifted' },
				],
			},
			{ id: 'efficiency.cache', title: 'Prompt Cache', description: 'How often the prompt cache breaks, the re-write factor and the likely causes.', keywords: ['caching', 'cache breaks'], nav: { tab: 'cache' }, condition: 'When cache data is available' },
			{
				id: 'efficiency.models',
				title: 'Models',
				description: 'Head-to-head comparison of two models, or one model across two periods.',
				nav: { tab: 'models' },
				children: [
					{ id: 'efficiency.models.shape', title: 'Shape of each side', description: 'Radar chart of how each side behaves across the comparison metrics.', nav: { anchor: 'model-radar' } },
					{ id: 'efficiency.models.drift', title: 'Drift over time', description: 'How the compared metrics moved over the selected window.', nav: { anchor: 'model-trend' } },
				],
			},
			{ id: 'efficiency.value', title: 'Value', description: 'Merged PRs, cost per merged PR, apply rate and work delegated to AI agents.', keywords: ['pull requests', 'roi'], nav: { tab: 'value' } },
			{ id: 'efficiency.combined', title: 'Combined', description: 'Several efficiency metrics on one chart.', nav: { tab: 'combined' } },
		],
	},
	{
		id: 'environmental',
		view: 'environmental',
		title: 'Environmental Impact',
		description: 'Your AI usage expressed as estimated CO₂, water and tree equivalents.',
		keywords: ['carbon', 'sustainability', 'green'],
		children: [
			{ id: 'environmental.impact', title: 'Impact at a Glance', description: 'Tokens, CO₂, water and tree equivalents for today, the last 30 days, last month and the projected year.', nav: { anchor: 'section-impact' } },
			{ id: 'environmental.methodology', title: 'Calculation & Estimates', description: 'How the estimates are calculated and the assumptions behind them.', keywords: ['methodology'], nav: { anchor: 'section-methodology' } },
		],
	},
	{
		id: 'maturity',
		view: 'maturity',
		title: 'AI Engineering Fluency Score',
		description: 'Your last 30 days mapped onto a four-stage fluency model across six categories, with next steps to level up.',
		keywords: ['maturity', 'level', 'stage'],
		children: [
			{ id: 'maturity.overall', title: 'Overall fluency', description: 'Your overall stage and what it means.', nav: { selector: '.stage-banner' } },
			{ id: 'maturity.radar', title: 'Radar chart', description: 'Your stage per category on one chart, with the stage reference.', nav: { selector: '.radar-wrapper' } },
			{ id: 'maturity.categories', title: 'Categories', description: 'Prompt engineering, context engineering, agentic, tool usage, customization and workflow integration, each with evidence and next steps.', keywords: ['next steps', 'tips'], nav: { selector: '.category-grid' } },
			{ id: 'maturity.share', title: 'Share your score', description: 'Share to social media or export your score as an image or presentation.', keywords: ['export', 'png', 'pptx'], nav: { selector: '.share-section' } },
		],
	},
	{
		id: 'fluency-level-viewer',
		view: 'fluency-level-viewer',
		title: 'Scoring Guide',
		description: 'What each fluency stage requires, per category, and how to reach the next one.',
		keywords: ['levels', 'requirements', 'how is my score calculated'],
		children: [
			{ id: 'fluency-level-viewer.categories', title: 'Category picker', description: 'Choose a category to see its stages.', nav: { selector: '.category-selector' } },
			{ id: 'fluency-level-viewer.levels', title: 'Stages', description: 'Requirements and next steps for stages 1 to 4 of the selected category.', nav: { selector: '.level-grid' } },
		],
	},
	{
		id: 'dashboard',
		view: 'dashboard',
		title: 'Team Dashboard',
		description: 'Usage synced across your devices and your team, from Azure Storage or a team server.',
		keywords: ['team', 'sharing', 'leaderboard'],
		condition: 'When a backend is configured',
		children: [
			{
				id: 'dashboard.azure',
				title: 'Azure Dashboard',
				description: 'Usage synced through Azure Storage: your own totals and how the team compares.',
				keywords: ['azure storage'],
				// No `tab`: with only Azure configured there is no tab bar. Scrolling to a
				// section inside the hidden Azure panel switches to its tab when there is one.
				nav: { anchor: 'section-personal-summary' },
				condition: 'When Azure Storage is configured',
				children: [
					{ id: 'dashboard.personal', title: 'Your Summary', description: 'Your synced tokens, interactions, cost, devices and workspaces, with a model breakdown.', nav: { anchor: 'section-personal-summary' } },
					{ id: 'dashboard.team', title: 'Team Comparison', description: 'Team totals and a leaderboard with each member\'s fluency score breakdown.', keywords: ['leaderboard'], nav: { anchor: 'section-team-comparison' } },
				],
			},
			{ id: 'dashboard.team-server', title: 'Team Server', description: 'A launch card for the team server\'s own web dashboard.', nav: { anchor: 'section-team-server' }, condition: 'When a team server is configured' },
		],
	},
	{
		id: 'diagnostics',
		view: 'diagnostics',
		title: 'Diagnostic Report',
		description: 'Everything about how the extension sees your machine: session files, cache, research tools and settings.',
		keywords: ['debug', 'troubleshoot', 'settings'],
		children: [
			{
				id: 'diagnostics.group.diagnostics',
				title: 'Diagnostics',
				description: 'The report itself and the files behind it.',
				nav: { tab: 'report' },
				children: [
					{ id: 'diagnostics.report', title: 'Report', description: 'A plain-text diagnostic report (no code or conversation content) to copy into an issue, plus the session folders per editor.', keywords: ['issue', 'bug report'], nav: { tab: 'report' } },
					{ id: 'diagnostics.sessions', title: 'Session Files', description: 'Every session file found, per editor, with interactions and tokens. Open one in the Session Log Viewer.', keywords: ['logs', 'files', 'session log viewer'], nav: { tab: 'sessions' } },
					{ id: 'diagnostics.cache', title: 'Cache', description: 'Cache size, age and location, and buttons to clear or reset it.', nav: { tab: 'cache' } },
					{ id: 'diagnostics.path-analyzer', title: 'Path Analyzer', description: 'Point at a folder to see which session files the extension finds there and how it reads them.', keywords: ['folder', 'scan'], nav: { tab: 'path-analyzer' } },
					{ id: 'diagnostics.share', title: 'Share Card', description: 'A shareable card of your AI coding toolbox for a chosen period.', keywords: ['social', 'image'], nav: { tab: 'share' } },
				],
			},
			{
				id: 'diagnostics.group.research',
				title: 'Research',
				description: 'Deeper analyses you run on demand.',
				nav: { tab: 'model-usage' },
				children: [
					{ id: 'diagnostics.model-usage', title: 'Model Usage', description: 'Tokens and cost per model for a chosen editor and time range.', nav: { tab: 'model-usage' } },
					{ id: 'diagnostics.tool-analysis', title: 'Tool Analysis', description: 'Output tokens per tool, grouped by tool family, against the built-in baseline.', keywords: ['tool families'], nav: { tab: 'tool-analysis' } },
					{ id: 'diagnostics.skill-usage', title: 'Skill Usage', description: 'Which skills were invoked over the last 30 days, per editor.', nav: { tab: 'skill-usage' } },
					{ id: 'diagnostics.otel-delta', title: 'OTel Delta', description: 'Estimated against exact Copilot CLI token counts from OpenTelemetry export.', keywords: ['opentelemetry', 'accuracy'], nav: { tab: 'otel-delta' } },
					{ id: 'diagnostics.ttft', title: 'TTFT', description: 'Time to first token per model, as a chart and a table.', keywords: ['latency', 'time to first token', 'speed'], nav: { tab: 'ttft' } },
				],
			},
			{
				id: 'diagnostics.group.settings',
				title: 'Settings',
				description: 'Display options, sync backends and GitHub sign-in.',
				nav: { tab: 'display' },
				children: [
					{
						id: 'diagnostics.display',
						title: 'Display',
						description: 'Status bar, monthly budget, API quota, editor discovery notifications and number formatting.',
						nav: { tab: 'display' },
						children: [
							{ id: 'diagnostics.display.quota', title: 'API Quota Information', description: 'Your Copilot premium request quota and account budgets.', keywords: ['budget', 'premium requests'], nav: { anchor: 'diag-quota-card' } },
						],
					},
					{
						id: 'diagnostics.backend',
						title: 'Backend Storage',
						description: 'Sync your usage to Azure Storage or a team server.',
						keywords: ['sync', 'sharing'],
						nav: { tab: 'backend' },
						children: [
							{ id: 'diagnostics.backend.azure', title: 'Azure Storage', description: 'Set up or review the Azure Storage backend and its local statistics.', nav: { subtab: 'backend-azure' } },
							{ id: 'diagnostics.backend.team-server', title: 'Team Server', description: 'Connect to a self-hosted team server and check its status.', keywords: ['sharing server'], nav: { subtab: 'backend-teamserver' } },
						],
					},
					{ id: 'diagnostics.github', title: 'GitHub Auth', description: 'Sign in to GitHub for PR and cloud agent data, or disconnect.', keywords: ['login', 'token'], nav: { tab: 'github' } },
					{ id: 'diagnostics.debug', title: 'Debug', description: 'Global state counters and dismissed flags, for working on the extension itself.', keywords: ['global state', 'notifications'], nav: { tab: 'debug' }, condition: 'Only while debugging the extension' },
				],
			},
		],
	},
	{
		id: 'whatsnew',
		view: 'whatsnew',
		title: "What's New",
		description: 'The last few releases in plain English, and this index.',
		children: [
			{ id: 'whatsnew.releases', title: 'Releases', description: 'What each recent release added, with a button to go and look.', keywords: ['changelog'], nav: { tab: 'releases' } },
			{ id: 'whatsnew.index', title: 'View index', description: 'Every view, tab and section, searchable — you are here.', keywords: ['map', 'search', 'find'], nav: { tab: 'index' } },
		],
	},
];

/** Every node with its navigation resolved, in tree order. */
export function flattenViewIndex(views: readonly ViewIndexView[] = VIEW_INDEX): ViewIndexEntry[] {
	const entries: ViewIndexEntry[] = [];
	const walk = (node: ViewIndexNode, view: FeatureViewId, inherited: ViewIndexNavigation, path: readonly string[]): void => {
		const own = node.nav ?? {};
		// A new tab resets the sub-tab and scroll target; a section only adds its own.
		const nav: ViewIndexNavigation = own.tab !== undefined && own.tab !== inherited.tab
			? { ...own }
			: { tab: inherited.tab, subtab: own.subtab ?? inherited.subtab, anchor: own.anchor, selector: own.selector };
		const cleaned = Object.fromEntries(Object.entries(nav).filter(([, v]) => v !== undefined)) as ViewIndexNavigation;
		const nodePath = [...path, node.title];
		entries.push({ id: node.id, view, nav: cleaned, path: nodePath, node });
		node.children?.forEach((child) => walk(child, view, { tab: cleaned.tab, subtab: cleaned.subtab }, nodePath));
	};
	views.forEach((view) => walk(view, view.view, {}, []));
	return entries;
}

/** Looks up an entry by id. Returns `null` for an unknown id. */
export function findViewIndexEntry(id: string): ViewIndexEntry | null {
	return flattenViewIndex().find((entry) => entry.id === id) ?? null;
}
