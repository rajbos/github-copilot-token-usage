/**
 * Shared InsightContext fixtures for exercising the whole insight catalog.
 *
 * Insights are mutually exclusive by design — several deliberately suppress one
 * another (`very-long-sessions-pattern` stands down for
 * `marathon-session-today`, `long-context-headroom` for
 * `long-context-pricing-crossed`, and so on), so no single context can fire all
 * of them. These fixtures are therefore a *set* of contexts, each tuned to one
 * family, evaluated in turn. That is what lets `l10n.test.ts` assert the
 * rendered output of effectively the entire catalog rather than a handful of
 * insights that happen to co-occur.
 *
 * Coverage here is checked by a test, not by eye: `l10n.test.ts` asserts these
 * contexts collectively fire most of the catalog, so an insight added without a
 * matching fixture is caught instead of silently going unrendered.
 */
import type { InsightContext } from '../../../src/insightsEngine';
import type { Translate } from '../../../src/l10nCore';
import type { UsageAnalysisPeriod, TodaySessionSummary } from '../../../../src/types';

export function emptyPeriod(): UsageAnalysisPeriod {
	return {
		sessions: 0,
		toolCalls: { total: 0, byTool: {} },
		modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
		contextReferences: {
			file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
			workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0,
			terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0,
			problemsPanel: 0, pullRequest: 0, byKind: {}, byPath: {}, copilotInstructions: 0, agentsMd: 0,
		},
		mcpTools: { total: 0, byServer: {}, byTool: {} },
		modelSwitching: {
			modelsPerSession: [], totalSessions: 0, averageModelsPerSession: 0,
			maxModelsPerSession: 0, minModelsPerSession: 0, switchingFrequency: 0,
			standardModels: [], premiumModels: [], unknownModels: [], mixedTierSessions: 0,
			standardRequests: 0, premiumRequests: 0, unknownRequests: 0, totalRequests: 0,
			lowCostModels: [], mediumCostModels: [], highCostModels: [], mixedCostSessions: 0,
			lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0,
			autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0,
			selectedModelExtensions: [], unknownProviderModels: [],
		},
		repositories: [], repositoriesWithCustomization: [],
		editScope: { singleFileEdits: 0, multiFileEdits: 0, totalEditedFiles: 0, avgFilesPerSession: 0 },
		applyUsage: { totalApplies: 0, totalCodeBlocks: 0, applyRate: 0 },
		sessionDuration: { totalDurationMs: 0, avgDurationMs: 0, avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0, activeDurationMs: 0 },
		conversationPatterns: { multiTurnSessions: 0, singleTurnSessions: 0, avgTurnsPerSession: 0, maxTurnsInSession: 0 },
		agentTypes: { editsAgent: 0, defaultAgent: 0, workspaceAgent: 0, other: 0 },
	};
}

function session(overrides: Partial<TodaySessionSummary>): TodaySessionSummary {
	return {
		title: null, filePath: '/tmp/session.jsonl', interactions: 5, toolCalls: 2,
		inputTokens: 1000, outputTokens: 500, thinkingTokens: 0, cachedTokens: 0,
		totalTokens: 1500, estimatedCost: 0.01, editor: 'VS Code',
		models: ['gpt-5.6-luna'], lastActivity: '2026-01-15T08:00:00.000Z',
		...overrides,
	};
}

function effCounters(retries: number, editTurns: number) {
	return {
		calls: editTurns, editTurns, oneShotEditTurns: Math.max(0, editTurns - retries),
		retries, selfCorrections: 0, editToolCalls: editTurns + retries,
		inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cost: 0,
	};
}

function base(translate: Translate): InsightContext {
	return { translate, today: emptyPeriod(), last30Days: emptyPeriod(), missedPotential: [] };
}

/**
 * A set of contexts that, evaluated together, render effectively the whole
 * catalog. Each entry names the insight family it is tuned for.
 */
export function insightFixtureContexts(translate: Translate): InsightContext[] {
	const contexts: InsightContext[] = [];

	// Customization: missing instructions, foundry models, high-cost models.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.missedPotential = [
			{ workspaceName: 'alpha', workspacePath: '/a', sessionCount: 5, interactionCount: 5, nonCopilotFiles: [] },
			{ workspaceName: 'beta', workspacePath: '/b', sessionCount: 4, interactionCount: 4, nonCopilotFiles: [] },
			{ workspaceName: 'gamma', workspacePath: '/c', sessionCount: 3, interactionCount: 3, nonCopilotFiles: [] },
			{ workspaceName: 'delta', workspacePath: '/d', sessionCount: 2, interactionCount: 2, nonCopilotFiles: [] },
		];
		ctx.last30Days.modelSwitching.foundryWindowsSessions = 3;
		ctx.last30Days.modelSwitching.totalRequests = 100;
		ctx.last30Days.modelSwitching.highCostRequests = 90;
		ctx.last30Days.modelSwitching.highCostModels = ['gpt-5.6-luna', 'claude-opus-5'];
		ctx.last30Days.modelSwitching.totalSessions = 20;
		contexts.push(ctx);
	}

	// Single missing workspace — exercises the `.one` plural branch.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.missedPotential = [
			{ workspaceName: 'solo', workspacePath: '/s', sessionCount: 5, interactionCount: 5, nonCopilotFiles: [] },
		];
		ctx.last30Days.modelSwitching.foundryWindowsSessions = 1;
		contexts.push(ctx);
	}

	// Context references: none at all, plus edit-only usage and low apply rate.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 30;
		ctx.last30Days.modeUsage.edit = 20;
		ctx.last30Days.conversationPatterns = { multiTurnSessions: 2, singleTurnSessions: 28, avgTurnsPerSession: 1.2, maxTurnsInSession: 3 };
		ctx.last30Days.applyUsage = { totalApplies: 6, totalCodeBlocks: 30, applyRate: 20 };
		ctx.last30Days.editScope = { singleFileEdits: 15, multiFileEdits: 0, totalEditedFiles: 15, avgFilesPerSession: 1 };
		ctx.last30Days.thinkingEffortUsage = { sessionCount: 8, switchCount: 0, byEffort: {} } as UsageAnalysisPeriod['thinkingEffortUsage'];
		contexts.push(ctx);
	}

	// Exactly one context reference — the `.one` branch of no-context-refs.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 30;
		ctx.last30Days.contextReferences.file = 1;
		ctx.last30Days.modeUsage.edit = 1;
		contexts.push(ctx);
	}

	// Rich context use, MCP adoption, multi-agent, delegation, effort switching.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 40;
		Object.assign(ctx.last30Days.contextReferences, {
			file: 30, codebase: 10, selection: 10, symbol: 10, terminal: 10, clipboard: 10, changes: 10,
		});
		ctx.last30Days.mcpTools = { total: 50, byServer: {}, byTool: { 'mcp__github__create_issue': 30, 'mcp__playwright__click': 20 } };
		ctx.last30Days.multiAgentParentSessions = 5;
		ctx.last30Days.delegationSessions = 8;
		ctx.last30Days.thinkingEffortUsage = { sessionCount: 10, switchCount: 6, byEffort: {} } as UsageAnalysisPeriod['thinkingEffortUsage'];
		ctx.today.sessions = 5;
		contexts.push(ctx);
	}

	// Consistency: heavy use, agent-mode growth, productive session today.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 30;
		ctx.last30Days.modeUsage = { ask: 50, edit: 20, agent: 10, plan: 0, customAgent: 0, cli: 0 };
		ctx.today.sessions = 5;
		ctx.today.modeUsage = { ask: 2, edit: 2, agent: 10, plan: 0, customAgent: 0, cli: 0 };
		ctx.todaySessions = [session({ interactions: 30, editor: 'VS Code' })];
		contexts.push(ctx);
	}

	// Sparse use: a single session in 30 days (the `.one` irregular-usage branch).
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 1;
		contexts.push(ctx);
	}

	// Mostly-Ask mode with no agentic usage at all.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.modeUsage = { ask: 100, edit: 2, agent: 0, plan: 0, customAgent: 0, cli: 0 };
		ctx.last30Days.conversationPatterns = { multiTurnSessions: 1, singleTurnSessions: 19, avgTurnsPerSession: 1.1, maxTurnsInSession: 2 };
		contexts.push(ctx);
	}

	// Session hygiene: a marathon session and frequent manual compaction.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.toolCalls.byTool['__slash__compact'] = 9;
		ctx.todaySessions = [session({ interactions: 80, totalTokens: 1_200_000, editor: 'Copilot CLI' })];
		ctx.today.sessions = 1;
		contexts.push(ctx);
	}

	// A marathon session with no editor recorded and zero tokens — exercises the
	// empty `where`/`tokens` fragments rather than the populated ones.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = [session({ interactions: 1, totalTokens: 0, editor: '' })];
		ctx.todaySessions[0].interactions = 60;
		contexts.push(ctx);
	}

	// Long chats as a 30-day pattern (no marathon today, so it is not suppressed).
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.conversationPatterns = { multiTurnSessions: 18, singleTurnSessions: 2, avgTurnsPerSession: 20, maxTurnsInSession: 120 };
		contexts.push(ctx);
	}

	// Automatic compaction, with and without the "N of M sessions" phrase.
	for (const considered of [40, 0]) {
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.autoCompactionsLast7Days = { total: 9, bySource: { copilotCli: 6, claude: 3 } };
		if (considered > 0) {
			ctx.last30Days.contextPressure = {
				sessionsConsidered: considered, sessionsCompacted: 12,
				sessionsNearLimit: 0, sessionsWithFillData: considered,
			};
		}
		contexts.push(ctx);
	}

	// Single automatic compaction — the `.one` branch.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.autoCompactionsLast7Days = { total: 6, bySource: { copilotCli: 6, claude: 0 } };
		contexts.push(ctx);
	}

	// Context pressure: near-limit sessions, with and without compaction/worst-fill.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.contextPressure = {
			sessionsConsidered: 20, sessionsCompacted: 1,
			sessionsNearLimit: 4, sessionsWithFillData: 20, worstFillPercent: 96,
		};
		contexts.push(ctx);
	}
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.contextPressure = {
			sessionsConsidered: 20, sessionsCompacted: 0,
			sessionsNearLimit: 2, sessionsWithFillData: 20,
		};
		contexts.push(ctx);
	}

	// Healthy context windows.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.contextPressure = {
			sessionsConsidered: 20, sessionsCompacted: 0,
			sessionsNearLimit: 0, sessionsWithFillData: 15, worstFillPercent: 30,
		};
		contexts.push(ctx);
	}

	// Model efficiency: a clear retry gap plus a price mismatch.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.modelEfficiency = {
			'claude-opus-5': effCounters(30, 30),
			'gpt-5.6-luna-mini': effCounters(1, 40),
		};
		contexts.push(ctx);
	}

	// Model efficiency with a single model — the no-comparison branch.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.modelEfficiency = { 'claude-opus-5': effCounters(30, 30) };
		contexts.push(ctx);
	}

	// Month-over-month trends, in both directions.
	for (const [prevAvg, curAvg] of [[20, 10], [10, 20]]) {
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.lastMonth = emptyPeriod();
		ctx.lastMonth.sessions = 20;
		ctx.lastMonth.conversationPatterns.avgTurnsPerSession = prevAvg;
		ctx.month = emptyPeriod();
		ctx.month.sessions = 20;
		ctx.month.conversationPatterns.avgTurnsPerSession = curAvg;
		contexts.push(ctx);
	}

	// Truncation today: one session/one event, and many/many.
	for (const [count, per] of [[1, 1], [3, 4]]) {
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = Array.from({ length: count }, () => session({ truncationCount: per }));
		contexts.push(ctx);
	}

	// Long-context pricing: crossed the threshold, and approaching it.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = [session({ models: ['gemini-2.5-pro'], maxRequestInputTokens: 900_000, contextTier: 'large', contextReachedTokens: 900_000, contextWindowLimit: 1_000_000 })];
		contexts.push(ctx);
	}
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = [session({ models: ['gemini-2.5-pro'], maxRequestInputTokens: 150_000 })];
		contexts.push(ctx);
	}
	// A large tier selected but never needed.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = [session({ models: ['gpt-5.6-luna'], contextTier: 'large', contextReachedTokens: 10_000, contextWindowLimit: 1_000_000 })];
		contexts.push(ctx);
	}

	// Tool curation: unused MCP servers (file-configured, extension-provided and
	// mixed), prompt bloat and stale skills.
	for (const flavor of ['file', 'extension', 'mixed'] as const) {
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		const servers = [
			{ server: 'unused-one', usedToolCount: 0, totalToolCount: 4, ...(flavor === 'file' ? {} : { extensionId: 'pub.ext' }) },
			{ server: 'unused-two', usedToolCount: 0, totalToolCount: 2, ...(flavor === 'extension' ? { extensionId: 'pub.ext2' } : {}) },
			{ server: 'unused-three', usedToolCount: 0, totalToolCount: 2 },
			{ server: 'unused-four', usedToolCount: 0, totalToolCount: 2 },
		];
		ctx.curationAnalysis = {
			windowDays: 30,
			availableTools: [],
			underusedMcpServers: servers,
			unusedTools: [
				{ name: 'stale-skill-a', source: 'skill' },
				{ name: 'stale-skill-b', source: 'skill' },
				{ name: 'stale-skill-c', source: 'skill' },
				{ name: 'stale-skill-d', source: 'skill' },
			],
			estimatedPromptBloat: { totalTokens: 9000, byTool: {} },
			recommendations: [],
		} as unknown as InsightContext['curationAnalysis'];
		contexts.push(ctx);
	}

	// A single unused server and a single stale skill — the `.one` branches.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.curationAnalysis = {
			windowDays: 30,
			availableTools: [],
			underusedMcpServers: [{ server: 'lonely', usedToolCount: 0, totalToolCount: 1 }],
			unusedTools: [{ name: 'lonely-skill', source: 'skill' }],
			estimatedPromptBloat: { totalTokens: 3000, byTool: {} },
			recommendations: [],
		} as unknown as InsightContext['curationAnalysis'];
		contexts.push(ctx);
	}

	// Memory files: stale only, large only, and both.
	for (const [stale, large] of [[3, 0], [0, 2], [4, 5], [1, 1]]) {
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.memoryFilesAnalysis = {
			staleFileCount: stale, largeFileCount: large,
			staleDays: 90, largeFileBytes: 65536, files: [], totalBytes: 0, fileCount: stale + large,
		} as unknown as InsightContext['memoryFilesAnalysis'];
		contexts.push(ctx);
	}

	// Corrections: both the singular and plural combinations.
	for (const [corrections, sessions] of [[1, 1], [12, 5]]) {
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.corrections = {
			userCorrections: Math.max(3, corrections), sessionsWithUserCorrections: sessions,
			sessionsWithMoments: sessions, toolErrors: Math.max(1, corrections),
			editRetries: corrections, editSelfCorrections: 0,
			escalatedUserCorrections: Math.max(2, corrections), sessionsWithEscalations: sessions,
		} as unknown as NonNullable<UsageAnalysisPeriod['corrections']>;
		contexts.push(ctx);
	}
	// Exactly one tool error and one edit retry.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.corrections = {
			userCorrections: 0, sessionsWithUserCorrections: 0, sessionsWithMoments: 0,
			toolErrors: 5, editRetries: 1, editSelfCorrections: 0,
			escalatedUserCorrections: 0, sessionsWithEscalations: 0,
		} as unknown as NonNullable<UsageAnalysisPeriod['corrections']>;
		contexts.push(ctx);
	}

	// Repeated tasks: one extra cluster, several extra clusters, and none.
	for (const extra of [0, 1, 3]) {
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.repeatedTasks = {
			clusters: [
				{ sessionCount: 5, representativePrompt: 'update the changelog' },
				...Array.from({ length: extra }, (_, i) => ({ sessionCount: 3, representativePrompt: `other ${i}` })),
			],
		} as unknown as InsightContext['repeatedTasks'];
		contexts.push(ctx);
	}

	// File references only — no codebase/selection breadth.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.contextReferences.file = 40;
		contexts.push(ctx);
	}

	// Context references trending up today against the 30-day daily average.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.contextReferences.file = 60;
		ctx.today.contextReferences.file = 9;
		contexts.push(ctx);
	}

	// A single today-reference — the `.one` branch of context-refs-trending-up.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.contextReferences.file = 6;
		ctx.today.contextReferences.file = 1;
		contexts.push(ctx);
	}

	// Many short, scattered sessions today.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = Array.from({ length: 8 }, () => session({ interactions: 2, totalTokens: 500 }));
		contexts.push(ctx);
	}

	// Retry/price mismatch: the pricier model also retries far more. The ids are
	// real entries in modelPricing.json — the insight needs both an output price
	// and a retry gap, so a made-up id would silently never fire.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.modelEfficiency = {
			'gpt-5.2-pro': effCounters(30, 30),
			'gpt-5-mini': effCounters(2, 40),
		};
		contexts.push(ctx);
	}

	// Sub-agent delegation without enough parent sessions for the multi-agent
	// insight, which would otherwise suppress it.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.last30Days.delegationSessions = 8;
		ctx.last30Days.multiAgentParentSessions = 1;
		contexts.push(ctx);
	}

	// Approaching — but not crossing — the long-context threshold. gpt-5.6-luna's
	// default tier ends at 200K, so 160K sits in the 70–100% headroom band.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = [session({ models: ['gpt-5.6-luna'], maxRequestInputTokens: 160_000 })];
		contexts.push(ctx);
	}

	// Crossing it outright, with the rate note populated.
	{
		const ctx = base(translate);
		ctx.last30Days.sessions = 20;
		ctx.todaySessions = [session({ models: ['gpt-5.6-luna'], maxRequestInputTokens: 260_000 })];
		contexts.push(ctx);
	}

	return contexts;
}
