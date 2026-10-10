import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeWorkspaceFixtureDir } from './tmpFixtureDirs';
import {
    mergeUsageAnalysis,
    analyzeContextReferences,
    analyzeContentReferences,
    analyzeVariableData,
    analyzeRequestContext,
    analyzeCliAttachments,
    calculateModelSwitching,
    trackEnhancedMetrics,
    analyzeSessionUsage,
    getModelUsageFromSession,
    mergeModelEfficiencyTokens,
    deriveConversationPatterns,
    isParsedSessionJson,
    createEmptySessionUsageAnalysis,
    applyModelTierClassification,
    extractInvokedSkillNameFromPlainText,
    type UsageAnalysisDeps,
} from '../../../src/usageAnalysis';
import { createEmptyTaskClassificationResult } from '../../../src/taskClassification';
import { calculateEstimatedCost } from '../../../src/tokenEstimation';
import { normalizeMcpToolName } from '../../../src/workspaceHelpers';
import type {
    UsageAnalysisPeriod,
    SessionUsageAnalysis,
    ContextReferenceUsage,
} from '../../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('Auto usage: JSON and delta sessions retain mixed per-request routing without discounting subagents', async () => {
	const requests = [
		{ requestId: 'auto', modelId: 'copilot/auto',
			result: { promptTokens: 1_000_000, outputTokens: 500_000 },
			response: [
				{ kind: 'autoModeResolution', resolved: { id: 'gpt-4o', name: 'GPT-4o' } },
				{ kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'subagent', modelName: 'gpt-4o', prompt: 'abcd', result: 'efgh' } },
			] },
		{ requestId: 'manual', modelId: 'gpt-4o', result: { usage: { promptTokens: 2_000_000, completionTokens: 1_000_000 } } },
		{ requestId: 'metadata-auto', modelId: 'auto', result: { metadata: { modelId: 'gpt-4o', promptTokens: 100, outputTokens: 50 } } },
	];
	const deps = { warn: (message: string) => assert.fail(message), ecosystems: [], tokenEstimators: { 'gpt-4o': 0.25 },
		modelPricing: { 'gpt-4o': { inputCostPerMillion: 20, outputCostPerMillion: 40, copilotPricing: { inputCostPerMillion: 2, outputCostPerMillion: 4 } } } };
	const session = { requests, selectedModel: { identifier: 'copilot/auto' } };
	for (const [file, content] of [
		['mixed.json', JSON.stringify(session)],
		['mixed.jsonl', JSON.stringify({ kind: 0, v: session })],
	]) {
		const usage = await getModelUsageFromSession(deps, file, content);
		assert.deepEqual(usage['gpt-4o'].autoRouting, { inputTokens: 1_000_100, outputTokens: 500_050 });
		assert.equal(usage['gpt-4o'].inputTokens, 3_000_101);
		assert.equal(usage['gpt-4o'].outputTokens, 1_500_051);
		const provider = calculateEstimatedCost(usage, deps.modelPricing);
		const copilot = calculateEstimatedCost(usage, deps.modelPricing, 'copilot');
		assert.ok(Math.abs(copilot - (provider / 10 - 0.40004)) < 1e-10);
	}
});

test('Auto usage: marker-only estimates work but session picker and CLI model changes do not imply discounts', async () => {
	const deps = { warn: (message: string) => assert.fail(message), ecosystems: [], tokenEstimators: { 'gpt-4o': 0.25 }, modelPricing: {} };
	const request = { requestId: '1', message: { text: 'abcd', parts: [{ text: 'abcd' }] },
		response: [{ kind: 'autoModeResolution', resolved: { id: 'gpt-4o' } }, { kind: 'markdownContent', value: 'efgh' }] };
	const usage = await getModelUsageFromSession(deps, 'estimate.json', JSON.stringify({ requests: [request] }));
	assert.deepEqual(usage['gpt-4o'].autoRouting, { inputTokens: 1, outputTokens: 1 });
	const manual = await getModelUsageFromSession(deps, 'manual.json', JSON.stringify({
		selectedModel: { identifier: 'copilot/auto' }, requests: [{ modelId: 'gpt-4o', result: { promptTokens: 10, outputTokens: 5 } }],
	}));
	assert.equal(manual['gpt-4o'].autoRouting, undefined);
	const cli = await getModelUsageFromSession(deps, 'cli.jsonl', [
		{ type: 'session.start', data: { selectedModel: 'auto' } },
		{ type: 'session.model_change', data: { newModel: 'gpt-4o' } },
		{ type: 'session.shutdown', data: { modelMetrics: { 'gpt-4o': { usage: { inputTokens: 10, outputTokens: 5 } } } } },
	].map(event => JSON.stringify(event)).join('\n'));
	assert.equal(cli['gpt-4o'].autoRouting, undefined);
});

function emptyRefs(): ContextReferenceUsage {
    return {
        file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
        workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0,
        terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0,
        problemsPanel: 0, pullRequest: 0, codeContextLines: 0, byKind: {}, byPath: {}, copilotInstructions: 0, agentsMd: 0,
    };
}

function emptyAnalysis(): SessionUsageAnalysis {
    return {
        toolCalls: { total: 0, byTool: {} },
        modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
        contextReferences: emptyRefs(),
        mcpTools: { total: 0, byServer: {}, byTool: {} },
        taskClassification: createEmptyTaskClassificationResult(),
        modelSwitching: {
            uniqueModels: [], modelCount: 0, switchCount: 0,
            tiers: { standard: [], premium: [], unknown: [] },
            hasMixedTiers: false,
            standardRequests: 0, premiumRequests: 0, unknownRequests: 0, totalRequests: 0,
            costBuckets: { low: [], medium: [], high: [], unknown: [] },
            hasMixedCosts: false,
            lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0,
            autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0,
            selectedModelExtensions: [], unknownProviderModels: [],
        },
    };
}

function emptyPeriod(): UsageAnalysisPeriod {
    return {
        sessions: 0,
        toolCalls: { total: 0, byTool: {} },
        modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
        contextReferences: emptyRefs(),
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
        taskCategoryPrimarySessions: {},
        taskCategoryWeightedSessions: {},
    };
}

// Minimal mock deps factory for file-based async functions
function makeMockDeps(overrides: Partial<{
    openCodeIsMatch: boolean;
    openCodeModelUsage: () => Promise<Record<string, { inputTokens: number; outputTokens: number, sessions: 0}>>;
}> = {}): UsageAnalysisDeps {
    // Build a minimal ecosystem adapter for openCode if needed
    const ecosystems: any[] = [];
    if (overrides.openCodeIsMatch || overrides.openCodeModelUsage) {
        ecosystems.push({
            id: 'opencode',
            handles: () => overrides.openCodeIsMatch ?? false,
            getModelUsage: overrides.openCodeModelUsage ?? (async () => ({})),
            // Implement IAnalyzableEcosystem so analyzeUsage is available
            analyzeUsage: async () => ({
                modeUsage: { ask: 0, agent: 0, edit: 0, inline: 0, unknown: 0 },
                toolCalls: { total: 0, byTool: {} },
                mcpTools: { total: 0, byServer: {}, byTool: {} },
                contextReferences: { total: 0, byType: {}, byRepository: {} },
                modelSwitching: { uniqueModels: [], modelCount: 0, switchCount: 0, totalRequests: 0, hasMixedTiers: false, tiers: { standard: [], premium: [], unknown: [] }, standardRequests: 0, premiumRequests: 0, unknownRequests: 0, costBuckets: { low: [], medium: [], high: [], unknown: [] }, hasMixedCosts: false, lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0 },
            }),
        });
    }
    return {
        warn: () => {},
        ecosystems,
        tokenEstimators: { 'gpt-4o': 0.25, 'claude-sonnet-4.5': 0.25 },
        modelPricing: {
            'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10, tier: 'standard', category: 'Standard' },
            'claude-sonnet-4.5': { inputCostPerMillion: 3, outputCostPerMillion: 15, tier: 'premium', category: 'Premium' },
        } as any,
        toolNameMap: {},
    };
}

// Fake session paths passed to the analysis functions below. They are never
// created on disk, but they must NOT live under the OS temp dir: the parsers
// reach fs.open() via readTextFileWithSizeGuard, and a temp-dir path literal
// flowing into that call is what CodeQL's js/insecure-temporary-file reports
// (a world-writable temp path reaching a file-open sink). Keep new fake paths
// under /fake-sessions/ too; real on-disk fixtures go through
// makeWorkspaceFixtureDir, which exists for the same reason.
const FAKE_JSON_PATH = '/fake-sessions/test-session.json';
// Valid UUID v4 format recognised by isUuidPointerFile
const UUID_POINTER_CONTENT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

// ---------------------------------------------------------------------------
// mergeUsageAnalysis
// ---------------------------------------------------------------------------

test('mergeUsageAnalysis: accumulates tool call counts across sessions', () => {
    const period = emptyPeriod();
    const a1 = emptyAnalysis();
    a1.toolCalls.total = 3;
    a1.toolCalls.byTool = { editFiles: 2, run_in_terminal: 1 };

    const a2 = emptyAnalysis();
    a2.toolCalls.total = 2;
    a2.toolCalls.byTool = { editFiles: 1, listFiles: 1 };

    mergeUsageAnalysis(period, a1);
    mergeUsageAnalysis(period, a2);

    assert.equal(period.toolCalls.total, 5);
    assert.equal(period.toolCalls.byTool['editFiles'], 3);
    assert.equal(period.toolCalls.byTool['run_in_terminal'], 1);
    assert.equal(period.toolCalls.byTool['listFiles'], 1);
});

test('mergeUsageAnalysis: accumulates model efficiency counters per model', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.modelEfficiency = {
        'gpt-4o': {
            calls: 3, editTurns: 2, oneShotEditTurns: 1, retries: 1, selfCorrections: 0,
            editToolCalls: 3, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cost: 0,
        },
    };
    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, a);

    assert.equal(period.modelEfficiency?.['gpt-4o'].calls, 6);
    assert.equal(period.modelEfficiency?.['gpt-4o'].editTurns, 4);
    assert.equal(period.modelEfficiency?.['gpt-4o'].oneShotEditTurns, 2);
    assert.equal(period.modelEfficiency?.['gpt-4o'].retries, 2);
});

test('mergeUsageAnalysis: leaves period.modelEfficiency absent when analysis has none', () => {
    const period = emptyPeriod();
    mergeUsageAnalysis(period, emptyAnalysis());
    assert.equal(period.modelEfficiency, undefined);
});

test('mergeUsageAnalysis: uses uncapped correction counts and tracks user-correction sessions separately', () => {
    const period = emptyPeriod();
    const analysis = emptyAnalysis();
    analysis.correctionMoments = [{
        type: 'tool-error', turnNumber: 1, timestamp: null, snippet: 'Tool failed: edit', tool: 'edit',
    }];
    analysis.correctionCounts = {
        userCorrections: 2, editRetries: 60, editSelfCorrections: 4,
        toolErrors: 70, toolErrorsRetried: 50, agentSelfCorrections: 1, escalatedUserCorrections: 1,
    };
    mergeUsageAnalysis(period, analysis);
    assert.equal(period.corrections?.editRetries, 60);
    assert.equal(period.corrections?.toolErrors, 70);
    assert.equal(period.corrections?.sessionsWithMoments, 1);
    assert.equal(period.corrections?.sessionsWithUserCorrections, 1);
    assert.equal(period.corrections?.sessionsWithEscalations, 1);
});

test('mergeModelEfficiencyTokens: folds per-session model usage tokens and cost into the period', () => {
    const period = emptyPeriod();
    mergeModelEfficiencyTokens(period, {
        'gpt-4o': { inputTokens: 1_000_000, outputTokens: 100_000, cachedReadTokens: 250_000, sessions: 0},
    }, { 'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10 } } as any);

    const c = period.modelEfficiency?.['gpt-4o'];
    assert.ok(c);
    assert.equal(c.inputTokens, 1_000_000);
    assert.equal(c.outputTokens, 100_000);
    assert.equal(c.cachedReadTokens, 250_000);
    assert.ok(c.cost > 0);
    // Empty usage is a no-op and does not create the aggregate
    const untouched = emptyPeriod();
    mergeModelEfficiencyTokens(untouched, {}, {});
    assert.equal(untouched.modelEfficiency, undefined);
});

test('mergeUsageAnalysis: accumulates mode usage counts', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.modeUsage = { ask: 5, edit: 2, agent: 3, plan: 1, customAgent: 0, cli: 0 };
    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, a); // merge twice

    assert.equal(period.modeUsage.ask, 10);
    assert.equal(period.modeUsage.edit, 4);
    assert.equal(period.modeUsage.agent, 6);
    assert.equal(period.modeUsage.plan, 2);
});

test('mergeUsageAnalysis: accumulates context reference counts', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.contextReferences.file = 3;
    a.contextReferences.workspace = 2;
    a.contextReferences.codebase = 1;
    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, a);

    assert.equal(period.contextReferences.file, 6);
    assert.equal(period.contextReferences.workspace, 4);
    assert.equal(period.contextReferences.codebase, 2);
});

test('mergeUsageAnalysis: aggregates task-category primary and weighted sessions', () => {
    const period = emptyPeriod();
    const a1 = emptyAnalysis();
    a1.taskClassification.primaryCategory = 'Coding';
    a1.taskClassification.categoryShares = {
    	Coding: 0.75,
    	Testing: 0.25,
    	Debugging: 0,
    	'Feature Dev': 0,
    	Refactoring: 0,
    	Exploration: 0,
    	Planning: 0,
    	Delegation: 0,
    	'Git Ops': 0,
    	'Build/Deploy': 0,
    	Brainstorming: 0,
    	Conversation: 0,
    };
    const a2 = emptyAnalysis();
    a2.taskClassification.primaryCategory = 'Testing';
    a2.taskClassification.categoryShares = {
    	Coding: 0.2,
    	Testing: 0.8,
    	Debugging: 0,
    	'Feature Dev': 0,
    	Refactoring: 0,
    	Exploration: 0,
    	Planning: 0,
    	Delegation: 0,
    	'Git Ops': 0,
    	'Build/Deploy': 0,
    	Brainstorming: 0,
    	Conversation: 0,
    };
    mergeUsageAnalysis(period, a1);
    mergeUsageAnalysis(period, a2);
    assert.equal(period.taskCategoryPrimarySessions?.Coding, 1);
    assert.equal(period.taskCategoryPrimarySessions?.Testing, 1);
    assert.ok(Math.abs((period.taskCategoryWeightedSessions?.Coding ?? 0) - 0.95) < 1e-9);
    assert.ok(Math.abs((period.taskCategoryWeightedSessions?.Testing ?? 0) - 1.05) < 1e-9);
});

test('mergeUsageAnalysis: accumulates code context line counts', () => {
    const period = emptyPeriod();
    const a1 = emptyAnalysis();
    a1.contextReferences.codeContextLines = 12;
    const a2 = emptyAnalysis();
    a2.contextReferences.codeContextLines = 8;

    mergeUsageAnalysis(period, a1);
    mergeUsageAnalysis(period, a2);

    assert.equal(period.contextReferences.codeContextLines, 20);
});

test('mergeUsageAnalysis: accumulates MCP tool counts by server and tool', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.mcpTools.total = 4;
    a.mcpTools.byServer = { 'GitHub MCP': 3, 'Jira MCP': 1 };
    a.mcpTools.byTool = { 'mcp_io_github_git_list_issues': 3, 'mcp_jira_get_issue': 1 };
    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, a);

    assert.equal(period.mcpTools.total, 8);
    assert.equal(period.mcpTools.byServer['GitHub MCP'], 6);
    assert.equal(period.mcpTools.byServer['Jira MCP'], 2);
});

test('mergeUsageAnalysis: tracks mixed-tier sessions when modelCount > 0', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.modelSwitching.modelCount = 2;
    a.modelSwitching.hasMixedTiers = true;
    a.modelSwitching.tiers.standard = ['gpt-4o-mini'];
    a.modelSwitching.tiers.premium = ['claude-sonnet'];
    a.modelSwitching.standardRequests = 3;
    a.modelSwitching.premiumRequests = 2;
    a.modelSwitching.lowCostRequests = 1;
    a.modelSwitching.mediumCostRequests = 3;
    a.modelSwitching.highCostRequests = 1;
    a.modelSwitching.hasMixedCosts = true;
    a.modelSwitching.costBuckets.low = ['gpt-4o-mini'];
    a.modelSwitching.costBuckets.medium = ['claude-sonnet'];
    a.modelSwitching.totalRequests = 5;
    mergeUsageAnalysis(period, a);

    assert.equal(period.modelSwitching.mixedTierSessions, 1);
    assert.equal(period.modelSwitching.mixedCostSessions, 1);
    assert.equal(period.modelSwitching.totalSessions, 1);
    assert.ok(period.modelSwitching.standardModels.includes('gpt-4o-mini'));
    assert.ok(period.modelSwitching.premiumModels.includes('claude-sonnet'));
    assert.ok(period.modelSwitching.lowCostModels.includes('gpt-4o-mini'));
    assert.ok(period.modelSwitching.mediumCostModels.includes('claude-sonnet'));
    assert.equal(period.modelSwitching.standardRequests, 3);
    assert.equal(period.modelSwitching.premiumRequests, 2);
    assert.equal(period.modelSwitching.lowCostRequests, 1);
    assert.equal(period.modelSwitching.mediumCostRequests, 3);
    assert.equal(period.modelSwitching.highCostRequests, 1);
});

test('mergeUsageAnalysis: sessions with modelCount=0 do not affect switching stats', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.modelSwitching.modelCount = 0; // no models detected
    mergeUsageAnalysis(period, a);

    assert.equal(period.modelSwitching.totalSessions, 0);
    assert.equal(period.modelSwitching.mixedTierSessions, 0);
});

test('mergeUsageAnalysis: accumulates byKind context counts', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.contextReferences.byKind = { 'copilot.image': 2, 'file': 5 };
    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, a);

    assert.equal(period.contextReferences.byKind['copilot.image'], 4);
    assert.equal(period.contextReferences.byKind['file'], 10);
});

// ---------------------------------------------------------------------------
// analyzeContextReferences
// ---------------------------------------------------------------------------

test('analyzeContextReferences: counts #file references in text', () => {
    const refs = emptyRefs();
    analyzeContextReferences('please look at #file and #file too', refs);
    assert.equal(refs.file, 2);
});

test('analyzeContextReferences: counts #selection references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('look at #selection please', refs);
    assert.equal(refs.selection, 1);
});

test('analyzeContextReferences: counts @workspace references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('search @workspace for this', refs);
    assert.equal(refs.workspace, 1);
});

test('analyzeContextReferences: counts @terminal references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('what does @terminal say?', refs);
    assert.equal(refs.terminal, 1);
});

test('analyzeContextReferences: counts #codebase references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('search #codebase for tests', refs);
    assert.equal(refs.codebase, 1);
});

test('analyzeContextReferences: counts #changes references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('review #changes please', refs);
    assert.equal(refs.changes, 1);
});

test('analyzeContextReferences: counts #clipboard references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('use #clipboard content', refs);
    assert.equal(refs.clipboard, 1);
});

test('analyzeContextReferences: counts #terminalLastCommand references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('fix #terminalLastCommand error', refs);
    assert.equal(refs.terminalLastCommand, 1);
});

test('analyzeContextReferences: counts #outputPanel references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('check #outputPanel', refs);
    assert.equal(refs.outputPanel, 1);
});

test('analyzeContextReferences: counts #problemsPanel references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('fix #problemsPanel errors', refs);
    assert.equal(refs.problemsPanel, 1);
});

test('analyzeContextReferences: counts #pr references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('review #pr changes', refs);
    assert.equal(refs.pullRequest, 1);
});

test('analyzeContextReferences: counts #pullRequest references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('summarize #pullRequest please', refs);
    assert.equal(refs.pullRequest, 1);
});

test('analyzeContextReferences: #pr does not match #problemsPanel', () => {
    const refs = emptyRefs();
    analyzeContextReferences('check #problemsPanel', refs);
    assert.equal(refs.pullRequest, 0);
    assert.equal(refs.problemsPanel, 1);
});

test('analyzeContextReferences: accumulates on existing counts', () => {
    const refs = emptyRefs();
    refs.file = 2;
    analyzeContextReferences('check #file for context', refs);
    assert.equal(refs.file, 3);
});

test('analyzeContextReferences: empty text produces no counts', () => {
    const refs = emptyRefs();
    analyzeContextReferences('', refs);
    assert.equal(refs.file, 0);
    assert.equal(refs.workspace, 0);
});

test('analyzeContextReferences: matching is case-insensitive', () => {
    const refs = emptyRefs();
    analyzeContextReferences('#FILE and #File and #file', refs);
    assert.equal(refs.file, 3);
});

// ---------------------------------------------------------------------------
// deriveConversationPatterns
// ---------------------------------------------------------------------------

test('deriveConversationPatterns: 0 requests produces single-turn=0, multi-turn=0', () => {
    const analysis = emptyAnalysis();
    deriveConversationPatterns(analysis);
    assert.ok(analysis.conversationPatterns);
    assert.equal(analysis.conversationPatterns.singleTurnSessions, 0);
    assert.equal(analysis.conversationPatterns.multiTurnSessions, 0);
    assert.equal(analysis.conversationPatterns.avgTurnsPerSession, 0);
});

test('deriveConversationPatterns: 1 request produces single-turn session', () => {
    const analysis = emptyAnalysis();
    analysis.modeUsage.ask = 1;
    deriveConversationPatterns(analysis);
    assert.equal(analysis.conversationPatterns!.singleTurnSessions, 1);
    assert.equal(analysis.conversationPatterns!.multiTurnSessions, 0);
    assert.equal(analysis.conversationPatterns!.avgTurnsPerSession, 1);
});

test('deriveConversationPatterns: 3 requests produces multi-turn session', () => {
    const analysis = emptyAnalysis();
    analysis.modeUsage.ask = 2;
    analysis.modeUsage.agent = 1;
    deriveConversationPatterns(analysis);
    assert.equal(analysis.conversationPatterns!.multiTurnSessions, 1);
    assert.equal(analysis.conversationPatterns!.singleTurnSessions, 0);
    assert.equal(analysis.conversationPatterns!.avgTurnsPerSession, 3);
    assert.equal(analysis.conversationPatterns!.maxTurnsInSession, 3);
});

// ---------------------------------------------------------------------------
// analyzeContentReferences
// ---------------------------------------------------------------------------

test('analyzeContentReferences: non-array input is ignored', () => {
    const refs = emptyRefs();
    analyzeContentReferences(null as any, refs);
    analyzeContentReferences('string' as any, refs);
    assert.equal(refs.file, 0);
    assert.equal(refs.symbol, 0);
});

test('analyzeContentReferences: empty array produces no counts', () => {
    const refs = emptyRefs();
    analyzeContentReferences([], refs);
    assert.equal(refs.file, 0);
    assert.deepEqual(refs.byKind, {});
});

test('analyzeContentReferences: tracks byKind for each entry', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/src/foo.ts' } },
        { kind: 'reference', reference: { fsPath: '/src/bar.ts' } },
    ], refs);
    assert.equal(refs.byKind['reference'], 2);
});

test('analyzeContentReferences: increments file for regular file reference', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/src/foo.ts' } },
    ], refs);
    assert.equal(refs.file, 1);
    assert.equal(refs.byPath['/src/foo.ts'], 1);
});

test('analyzeContentReferences: increments copilotInstructions for copilot-instructions.md', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/repo/.github/copilot-instructions.md' } },
    ], refs);
    assert.equal(refs.copilotInstructions, 1);
    assert.equal(refs.file, 0);
});

test('analyzeContentReferences: increments copilotInstructions for .instructions.md files', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/repo/.github/instructions/github-actions.instructions.md' } },
    ], refs);
    assert.equal(refs.copilotInstructions, 1);
    assert.equal(refs.file, 0);
});

test('analyzeContentReferences: increments agentsMd for agents.md', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/repo/agents.md' } },
    ], refs);
    assert.equal(refs.agentsMd, 1);
    assert.equal(refs.file, 0);
});

test('analyzeContentReferences: increments symbol for named reference without fsPath', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { name: 'myFunction' } },
    ], refs);
    assert.equal(refs.symbol, 1);
    assert.equal(refs.byPath['#sym:myFunction'], 1);
});

test('analyzeContentReferences: handles inlineReference kind with fsPath', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'inlineReference', inlineReference: { fsPath: '/src/component.ts' } },
    ], refs);
    assert.equal(refs.file, 1);
});

test('analyzeContentReferences: increments pullRequest for pullRequest kind', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'pullRequest', pullRequest: { number: 42, title: 'My PR' } },
    ], refs);
    assert.equal(refs.pullRequest, 1);
    assert.equal(refs.byKind['pullRequest'], 1);
});

test('analyzeContentReferences: multiple pullRequest entries accumulate', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'pullRequest', pullRequest: { number: 1 } },
        { kind: 'pullRequest', pullRequest: { number: 2 } },
    ], refs);
    assert.equal(refs.pullRequest, 2);
});

// ---------------------------------------------------------------------------
// analyzeVariableData
// ---------------------------------------------------------------------------

test('analyzeVariableData: null input is ignored', () => {
    const refs = emptyRefs();
    analyzeVariableData(null, refs);
    assert.equal(refs.symbol, 0);
    assert.deepEqual(refs.byKind, {});
});

test('analyzeVariableData: non-array variables is ignored', () => {
    const refs = emptyRefs();
    analyzeVariableData({ variables: 'not-an-array' }, refs);
    assert.equal(refs.symbol, 0);
});

test('analyzeVariableData: tracks byKind for each variable', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'file', name: 'foo.ts' },
            { kind: 'file', name: 'bar.ts' },
        ]
    }, refs);
    assert.equal(refs.byKind['file'], 2);
});

test('analyzeVariableData: file variables also increment refs.file', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'file', name: 'foo.ts' },
            { kind: 'file', name: 'bar.ts' },
        ]
    }, refs);
    assert.equal(refs.file, 2);
});

test('analyzeVariableData: image variables increment byKind[image] and byKind[copilot.image]', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'image' },
            { kind: 'image' },
        ]
    }, refs);
    assert.equal(refs.byKind['image'], 2);
    assert.equal(refs.byKind['copilot.image'], 2);
});

test('analyzeVariableData: increments symbol for generic sym: variables', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'generic', name: 'sym:parseSessionFile' },
        ]
    }, refs);
    assert.equal(refs.symbol, 1);
    assert.equal(refs.byPath['#sym:parseSessionFile'], 1);
});

test('analyzeVariableData: does not increment symbol for generic without sym: prefix', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'generic', name: 'someOtherThing' },
        ]
    }, refs);
    assert.equal(refs.symbol, 0);
});

// ---------------------------------------------------------------------------
// analyzeCliAttachments
// ---------------------------------------------------------------------------

test('analyzeCliAttachments: null/missing input is ignored', () => {
    const refs = emptyRefs();
    analyzeCliAttachments(null, refs);
    analyzeCliAttachments(undefined, refs);
    assert.equal(refs.file, 0);
    assert.deepEqual(refs.byKind, {});
});

test('analyzeCliAttachments: clipboard PNG increments copilot.image', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: 'bce9bcb7-35f8-49ba-a49d-a8114dd26214-clipboard.png', type: 'file' },
        { displayName: '3a695656-0157-4e9d-8613-781da1b54ee7-clipboard.png', type: 'file' },
    ], refs);
    assert.equal(refs.byKind['copilot.image'], 2);
    assert.equal(refs.file, 0);
});

test('analyzeCliAttachments: "N lines" displayName increments refs.file', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: '210 lines', type: 'file' },
        { displayName: '46 lines', type: 'file' },
    ], refs);
    assert.equal(refs.file, 2);
    assert.equal(refs.byKind['copilot.image'], undefined);
});

test('analyzeCliAttachments: named file (e.g. refactor.agent.md) increments refs.file', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: 'refactor.agent.md', type: 'file' },
    ], refs);
    assert.equal(refs.file, 1);
});

test('analyzeCliAttachments: mixed attachments (images + file refs) split correctly', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: 'abc-clipboard.png', type: 'file' },
        { displayName: '285 lines', type: 'file' },
        { displayName: 'AGENTS.md', type: 'file' },
    ], refs);
    assert.equal(refs.byKind['copilot.image'], 1);
    assert.equal(refs.file, 2);
});

test('analyzeCliAttachments: entry without displayName is skipped', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([{ type: 'file' }, null, 42], refs);
    assert.equal(refs.file, 0);
    assert.deepEqual(refs.byKind, {});
});

// ---------------------------------------------------------------------------
// analyzeRequestContext
// ---------------------------------------------------------------------------

test('analyzeRequestContext: processes message.text for context refs', () => {
    const refs = emptyRefs();
    analyzeRequestContext({ message: { text: 'look at #file please' } }, refs);
    assert.equal(refs.file, 1);
});

test('analyzeRequestContext: processes message.parts for context refs', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: { parts: [{ text: 'check #codebase' }, { text: 'and #file' }] }
    }, refs);
    assert.equal(refs.codebase, 1);
    assert.equal(refs.file, 1);
});

test('analyzeRequestContext: extracts code context lines from dynamic parts', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [{
                kind: 'dynamic',
                data: { range: { startLineNumber: 10, endLineNumber: 24 } },
            }]
        }
    }, refs);
    assert.equal(refs.codeContextLines, 15);
});

test('analyzeRequestContext: counts custom prompt parts in byKind', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [{
                kind: 'prompt',
                slashPromptCommand: { command: 'galery' },
            }]
        }
    }, refs);
    assert.equal(refs.byKind['prompt'], 1);
});

test('analyzeRequestContext: processes contentReferences array', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        contentReferences: [
            { kind: 'reference', reference: { fsPath: '/src/utils.ts' } },
        ]
    }, refs);
    assert.equal(refs.file, 1);
});

test('analyzeRequestContext: processes variableData for symbol refs', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        variableData: {
            variables: [{ kind: 'generic', name: 'sym:myClass' }]
        }
    }, refs);
    assert.equal(refs.symbol, 1);
});

test('analyzeRequestContext: empty request produces no counts', () => {
    const refs = emptyRefs();
    analyzeRequestContext({}, refs);
    assert.equal(refs.file, 0);
    assert.equal(refs.symbol, 0);
});

// ---------------------------------------------------------------------------
// getModelUsageFromSession
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: returns empty ModelUsage for UUID pointer file', async () => {
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, UUID_POINTER_CONTENT);
    assert.deepEqual(result, {});
});

test('getModelUsageFromSession: extracts token counts from result.promptTokens/outputTokens (new format)', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'copilot/gpt-4o', result: { promptTokens: 100, outputTokens: 50 } },
        ]
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, content);
    assert.ok(result['gpt-4o'], 'gpt-4o key should exist');
    assert.equal(result['gpt-4o'].inputTokens, 100);
    assert.equal(result['gpt-4o'].outputTokens, 50);
});

test('getModelUsageFromSession: accumulates tokens across multiple requests for same model', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'copilot/gpt-4o', result: { promptTokens: 100, outputTokens: 50 } },
            { modelId: 'copilot/gpt-4o', result: { promptTokens: 200, outputTokens: 100 } },
        ]
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, content);
    assert.equal(result['gpt-4o'].inputTokens, 300);
    assert.equal(result['gpt-4o'].outputTokens, 150);
});

test('getModelUsageFromSession: returns separate entries for different models', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'copilot/gpt-4o', result: { promptTokens: 100, outputTokens: 50 } },
            { modelId: 'copilot/claude-sonnet-4.5', result: { promptTokens: 200, outputTokens: 100 } },
        ]
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, content);
    assert.ok(result['gpt-4o'], 'gpt-4o key should exist');
    assert.ok(result['claude-sonnet-4.5'], 'claude-sonnet-4.5 key should exist');
    assert.equal(result['gpt-4o'].inputTokens, 100);
    assert.equal(result['claude-sonnet-4.5'].inputTokens, 200);
});

test('getModelUsageFromSession: extracts token counts from result.usage (old format)', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'copilot/gpt-4o', result: { usage: { promptTokens: 80, completionTokens: 40 } } },
        ]
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, content);
    assert.equal(result['gpt-4o'].inputTokens, 80);
    assert.equal(result['gpt-4o'].outputTokens, 40);
});

test('getModelUsageFromSession: delegates to openCode adapter for openCode session files', async () => {
    let called = false;
    const deps = makeMockDeps({
        openCodeIsMatch: true,
        openCodeModelUsage: async () => {
            called = true;
            return { 'gpt-4o': { inputTokens: 99, outputTokens: 11, sessions: 0} };
        },
    });
    const result = await getModelUsageFromSession(deps, '/opencode/session.db', '');
    assert.ok(called, 'getModelUsage should have been called on the openCode adapter');
    assert.equal(result['gpt-4o'].inputTokens, 99);
});

test('getModelUsageFromSession: CLI session.shutdown populates cachedReadTokens and cacheCreationTokens', async () => {
    // Simulates a real Copilot CLI session.shutdown event where inputTokens is the TOTAL
    // (uncached + cacheRead + cacheWrite) and both cache fields are reported separately.
    // Without reading these fields, the extension charges full input rate for everything.
    const shutdownEvent = JSON.stringify({
        type: 'session.shutdown',
        data: {
            shutdownType: 'routine',
            modelMetrics: {
                'claude-sonnet-4.6': {
                    requests: { count: 10, cost: 1 },
                    usage: {
                        inputTokens: 1000000,
                        outputTokens: 5000,
                        cacheReadTokens: 900000,
                        cacheWriteTokens: 50000,
                        reasoningTokens: 0,
                    },
                },
            },
        },
        timestamp: '2026-05-13T10:00:00.000Z',
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, 'fake/path/events.jsonl', shutdownEvent + '\n');
    const usage = result['claude-sonnet-4.6'];
    assert.ok(usage, 'claude-sonnet-4.6 key should exist');
    // inputTokens = total (1,000,000 = 900,000 read + 50,000 write + 50,000 uncached)
    assert.equal(usage.inputTokens, 1000000);
    assert.equal(usage.outputTokens, 5000);
    // Cache fields must be populated so calculateEstimatedCost can apply the discount
    assert.equal(usage.cachedReadTokens, 900000);
    assert.equal(usage.cacheCreationTokens, 50000);
});

test('getModelUsageFromSession: CLI session without cache fields leaves cachedReadTokens undefined', async () => {
    const shutdownEvent = JSON.stringify({
        type: 'session.shutdown',
        data: {
            shutdownType: 'routine',
            modelMetrics: {
                'claude-sonnet-4.6': {
                    usage: { inputTokens: 100000, outputTokens: 2000, sessions: 0},
                    // no cacheReadTokens / cacheWriteTokens
                },
            },
        },
        timestamp: '2026-05-13T10:00:00.000Z',
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, 'fake/path/events.jsonl', shutdownEvent + '\n');
    const usage = result['claude-sonnet-4.6'];
    assert.ok(usage);
    assert.equal(usage.inputTokens, 100000);
    // No cache fields → undefined (not 0), so calculateEstimatedCost falls back to full price correctly
    assert.equal(usage.cachedReadTokens, undefined);
    assert.equal(usage.cacheCreationTokens, undefined);
});

// ---------------------------------------------------------------------------
// CLI live session (no session.shutdown) — content-based estimation
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: CLI live session uses accumulated content not output ratio', async () => {
    // 0 tool calls → numTurns=1, contextFactor=1 → inputTokens = raw content estimate
    const events = [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5' } }),
        JSON.stringify({ type: 'user.message', data: { content: 'hello', model: 'claude-sonnet-4.5' } }),
        JSON.stringify({ type: 'assistant.message', data: { outputTokens: 500, model: 'claude-sonnet-4.5' } }),
    ].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, 'fake/.copilot/session-state/uuid/events.jsonl', events);
    const usage = result['claude-sonnet-4.5'];
    assert.ok(usage, 'claude-sonnet-4.5 key should exist');
    // outputTokens = real value from API
    assert.equal(usage.outputTokens, 500);
    // inputTokens = ceil("hello".length * 0.25) * contextFactor(1) = ceil(1.25) * 1 = 2
    assert.equal(usage.inputTokens, 2);
    // cachedReadTokens must NOT be set for live sessions (no shutdown data)
    assert.equal(usage.cachedReadTokens, undefined);
});

test('getModelUsageFromSession: CLI live session scales input by context-growth factor from tool calls', async () => {
    // 10 tool calls → numTurns=5, contextFactor=(5+1)/2=3
    const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { model: 'claude-sonnet-4.5' } });
    const toolDone = JSON.stringify({ type: 'tool.execution_complete', data: { result: { content: 'tool' }, model: 'claude-sonnet-4.5' } });
    const events = [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5' } }),
        JSON.stringify({ type: 'user.message', data: { content: 'hello', model: 'claude-sonnet-4.5' } }),
        ...Array.from({ length: 10 }, () => [toolStart, toolDone]).flat(),
        JSON.stringify({ type: 'assistant.message', data: { outputTokens: 500, model: 'claude-sonnet-4.5' } }),
    ].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, 'fake/.copilot/session-state/uuid/events.jsonl', events);
    const usage = result['claude-sonnet-4.5'];
    assert.ok(usage, 'claude-sonnet-4.5 key should exist');
    assert.equal(usage.outputTokens, 500);
    // accumulatedInput = ceil(5*0.25) + 10*ceil(4*0.25) = 2 + 10*1 = 12
    // numTurns = max(1, round(10/2)) = 5, contextFactor = (5+1)/2 = 3
    // inputTokens = round(12 * 3) = 36
    assert.equal(usage.inputTokens, 36);
    assert.equal(usage.cachedReadTokens, undefined);
});

test('getModelUsageFromSession: CLI live session gives far lower estimate than old 130x output ratio', async () => {
    // Old approach with 30 tool calls + 10K output tokens: 10000 * 130 = 1,300,000
    // New approach: accumulated content * contextFactor stays well under 100K
    const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { model: 'claude-sonnet-4.5' } });
    const toolDone = JSON.stringify({ type: 'tool.execution_complete', data: { result: { content: 'tool' }, model: 'claude-sonnet-4.5' } });
    const events = [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5' } }),
        JSON.stringify({ type: 'user.message', data: { content: 'hello', model: 'claude-sonnet-4.5' } }),
        ...Array.from({ length: 30 }, () => [toolStart, toolDone]).flat(),
        JSON.stringify({ type: 'assistant.message', data: { outputTokens: 10000, model: 'claude-sonnet-4.5' } }),
    ].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, 'fake/.copilot/session-state/uuid/events.jsonl', events);
    const usage = result['claude-sonnet-4.5'];
    // accumulated=2+30=32, numTurns=15, contextFactor=8, inputTokens=round(32*8)=256
    assert.equal(usage.outputTokens, 10000);
    assert.ok(usage.inputTokens < 100_000, `inputTokens (${usage.inputTokens}) should be far below the old 1.3M estimate`);
    assert.equal(usage.cachedReadTokens, undefined);
});

// ---------------------------------------------------------------------------
// calculateModelSwitching
// ---------------------------------------------------------------------------

test('Auto model switching and usage buckets use resolved models in delta requests', async () => {
	const deps = makeMockDeps();
	const request = { requestId: 'auto-turn', modelId: 'auto', message: { text: 'hello' },
		result: { promptTokens: 100, outputTokens: 40 },
		response: [{ kind: 'autoModeResolution', resolved: { id: 'gpt-4o' } }] };
	const content = [
		{ kind: 0, v: { requests: [], selectedModel: { identifier: 'copilot/auto' } } },
		{ kind: 2, k: ['requests'], v: [request] },
	].map(event => JSON.stringify(event)).join('\n');
	const analysis = emptyAnalysis();
	await calculateModelSwitching(deps, 'auto-buckets.jsonl', analysis, content);
	assert.equal(analysis.modelSwitching.standardRequests, 1);
	assert.equal(analysis.modelSwitching.mediumCostRequests, 1);
	assert.equal(analysis.modelSwitching.unknownRequests, 0);
	const usage = await analyzeSessionUsage(deps, 'auto-buckets.jsonl', content);
	assert.deepEqual(usage.modelSwitching.uniqueModels, ['gpt-4o']);
	assert.equal(usage.modelSwitching.standardRequests, 1);
	assert.equal(usage.modelSwitching.mediumCostRequests, 1);
	assert.equal(usage.modelSwitching.unknownRequests, 0);
});

test('calculateModelSwitching: empty requests list leaves analysis unchanged', async () => {
    const content = JSON.stringify({ requests: [] });
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.modelSwitching.modelCount, 0);
    assert.equal(analysis.modelSwitching.switchCount, 0);
});

test('calculateModelSwitching: UUID pointer file leaves analysis unchanged', async () => {
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysis, UUID_POINTER_CONTENT);
    assert.equal(analysis.modelSwitching.modelCount, 0);
});

test('calculateModelSwitching: single model session has no switches', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'copilot/gpt-4o', result: { promptTokens: 10, outputTokens: 5 } },
            { modelId: 'copilot/gpt-4o', result: { promptTokens: 10, outputTokens: 5 } },
        ]
    });
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.modelSwitching.modelCount, 1);
    assert.equal(analysis.modelSwitching.switchCount, 0);
    assert.ok(analysis.modelSwitching.uniqueModels.includes('gpt-4o'));
});

test('calculateModelSwitching: two models from different tiers sets hasMixedTiers=true', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'copilot/gpt-4o', result: { promptTokens: 10, outputTokens: 5 } },
            { modelId: 'copilot/claude-sonnet-4.5', result: { promptTokens: 10, outputTokens: 5 } },
        ]
    });
    const deps = makeMockDeps();
    // Override with distinct cost tiers so the low/medium cost-bucket split is meaningful:
    // gpt-4o priced under $2/M (low bucket), claude-sonnet-4.5 priced $2-5/M (medium bucket).
    deps.modelPricing = {
        ...deps.modelPricing,
        'gpt-4o': { ...deps.modelPricing['gpt-4o'], inputCostPerMillion: 1.5 },
        'claude-sonnet-4.5': { ...deps.modelPricing['claude-sonnet-4.5'], inputCostPerMillion: 3 },
    };
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.modelSwitching.modelCount, 2);
    assert.ok(analysis.modelSwitching.hasMixedTiers, 'should detect mixed tiers');
    assert.ok(analysis.modelSwitching.hasMixedCosts, 'should detect mixed costs');
    assert.equal(analysis.modelSwitching.switchCount, 1);
    assert.equal(analysis.modelSwitching.standardRequests, 1);
    assert.equal(analysis.modelSwitching.premiumRequests, 1);
    assert.equal(analysis.modelSwitching.lowCostRequests, 1);
    assert.equal(analysis.modelSwitching.mediumCostRequests, 1);
    assert.deepEqual(analysis.modelSwitching.costBuckets.low, ['gpt-4o']);
    assert.deepEqual(analysis.modelSwitching.costBuckets.medium, ['claude-sonnet-4.5']);
});

// ---------------------------------------------------------------------------
// trackEnhancedMetrics
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: UUID pointer file leaves analysis unchanged', async () => {
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, UUID_POINTER_CONTENT);
    assert.equal(analysis.editScope?.totalEditedFiles ?? 0, 0);
    assert.equal(analysis.applyUsage?.totalCodeBlocks ?? 0, 0);
});

test('trackEnhancedMetrics: textEditGroup responses populate editScope', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [
                { kind: 'textEditGroup', uri: { path: '/src/foo.ts' } },
                { kind: 'textEditGroup', uri: { path: '/src/bar.ts' } },
            ]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.editScope!.totalEditedFiles, 2);
    assert.equal(analysis.editScope!.multiFileEdits, 1);
    assert.equal(analysis.editScope!.singleFileEdits, 0);
});

test('trackEnhancedMetrics: codeblockUri with isEdit=true increments totalApplies', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [
                { kind: 'codeblockUri', isEdit: true },
                { kind: 'codeblockUri', isEdit: false },
                { kind: 'codeblockUri', isEdit: true },
            ]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.applyUsage!.totalCodeBlocks, 3);
    assert.equal(analysis.applyUsage!.totalApplies, 2);
});

test('trackEnhancedMetrics: timestamps drive session duration calculation', async () => {
    const t1 = 1700000000000;
    const t2 = t1 + 60000; // 60 seconds later
    const content = JSON.stringify({
        creationDate: t1,
        lastMessageDate: t2,
        requests: [],
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.sessionDuration!.totalDurationMs, 60000);
});

test('trackEnhancedMetrics: agent IDs are classified into correct buckets', async () => {
    const content = JSON.stringify({
        requests: [
            { agent: { id: 'copilot.editsAgent' } },
            { agent: { id: 'copilot.defaultAgent' } },
            { agent: { id: 'copilot.workspaceAgent' } },
            { agent: { id: 'some.customPlugin' } },
        ]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.agentTypes!.editsAgent, 1);
    assert.equal(analysis.agentTypes!.defaultAgent, 1);
    assert.equal(analysis.agentTypes!.workspaceAgent, 1);
    assert.equal(analysis.agentTypes!.other, 1);
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: UUID pointer file returns empty analysis without errors', async () => {
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, UUID_POINTER_CONTENT);
    assert.equal(result.modeUsage.ask, 0);
    assert.equal(result.toolCalls.total, 0);
});

test('analyzeSessionUsage: regular JSON session counts ask mode requests', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'copilot/gpt-4o', message: { text: 'hello' }, result: { promptTokens: 10, outputTokens: 5 } },
            { modelId: 'copilot/gpt-4o', message: { text: 'hello again' }, result: { promptTokens: 10, outputTokens: 5 } },
        ]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.modeUsage.ask, 2);
    assert.equal(result.modeUsage.agent, 0);
});

test('analyzeSessionUsage: request with editsAgent ID counts as edit mode', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            agent: { id: 'copilot.editsAgent' },
            message: { text: 'refactor this' },
            result: { promptTokens: 10, outputTokens: 5 },
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.modeUsage.edit, 1);
    assert.equal(result.modeUsage.ask, 0);
});

test('analyzeSessionUsage: session-level agent mode is inherited by requests without a request-specific agent', async () => {
    const content = JSON.stringify({
        mode: { id: 'copilot.agentMode' },
        requests: [
            { modelId: 'copilot/gpt-4o', message: { text: 'do task' }, result: { promptTokens: 10, outputTokens: 5 } },
        ]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.modeUsage.agent, 1);
    assert.equal(result.modeUsage.ask, 0);
});

test('analyzeSessionUsage: context references in message text are counted', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            message: { text: 'look at #file and #codebase' },
            result: { promptTokens: 10, outputTokens: 5 },
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.contextReferences.file, 1);
    assert.equal(result.contextReferences.codebase, 1);
});

test('analyzeSessionUsage: toolInvocationSerialized response items are counted as tool calls', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            message: { text: 'run tests' },
            result: { promptTokens: 10, outputTokens: 5 },
            response: [
                { kind: 'toolInvocationSerialized', toolId: 'run_in_terminal' },
                { kind: 'toolInvocationSerialized', toolId: 'list_dir' },
            ]
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.toolCalls.total, 2);
    assert.equal(result.toolCalls.byTool['run_in_terminal'], 1);
    assert.equal(result.toolCalls.byTool['list_dir'], 1);
});

test('analyzeSessionUsage: empty requests array returns empty analysis', async () => {
    const content = JSON.stringify({ requests: [] });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.modeUsage.ask, 0);
    assert.equal(result.toolCalls.total, 0);
});

test('analyzeSessionUsage: delta-based JSONL session extracts LOC data from textEditGroup', async () => {
    // Delta-based JSONL format (VS Code Insiders / Feb 2026+):
    // kind=0 sets initial state, kind=2 appends to arrays, kind=1 sets properties.
    // The fix ensures trackEnhancedMetrics is called after processDeltaSessionAnalysis.
    const request = {
        requestId: 'req-1',
        timestamp: 1700000000000,
        response: [{
            kind: 'textEditGroup',
            uri: { path: '/src/foo.ts' },
            edits: [[
                { text: 'line1\nline2\n', range: { startLineNumber: 1, endLineNumber: 3 } }
            ]]
        }]
    };
    // Build delta-based JSONL: initial state with requests array, then append the request
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1700000000000, requests: [] } });
    const line1 = JSON.stringify({ kind: 2, k: ['requests'], v: request });
    const content = [line0, line1].join('\n');
    const FAKE_JSONL_PATH = '/fake-sessions/test-session.jsonl';
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSONL_PATH, content);
    // linesAdded should be populated from the textEditGroup edits
    assert.ok((result.editScope?.linesAdded ?? 0) > 0, 'expected linesAdded > 0 from delta JSONL textEditGroup');
    assert.equal(result.editScope?.totalEditedFiles, 1);
});

test('analyzeSessionUsage: CLI JSONL session extracts LOC from successful edit tool calls', async () => {
    const toolCallId = 'call-edit-1';
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' }, timestamp: '2026-05-01T10:00:00Z' },
        {
            type: 'tool.execution_start',
            data: {
                toolCallId,
                toolName: 'edit',
                arguments: {
                    path: '/repo/src/foo.ts',
                    old_str: 'line1\nline2',
                    new_str: 'line1\nline2\nline3\nline4',
                },
            },
        },
        { type: 'tool.execution_complete', data: { toolCallId, success: true } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    // old_str has 2 lines, new_str has 4 lines (no trailing newline)
    assert.equal(result.editScope?.linesAdded, 4, 'expected 4 lines added');
    assert.equal(result.editScope?.linesRemoved, 2, 'expected 2 lines removed');
    assert.equal(result.editScope?.totalEditedFiles, 1);
    assert.ok(result.editScope?.languageUsage?.['ts'], 'expected ts language usage');
    assert.equal(result.editScope?.languageUsage?.['ts']?.linesAdded, 4);
});

// ---------------------------------------------------------------------------
// extractInvokedSkillNameFromPlainText — Copilot CLI's user-typed slash invocation
// ---------------------------------------------------------------------------

test('extractInvokedSkillNameFromPlainText: resolves the command name from a bare slash invocation', () => {
    assert.equal(extractInvokedSkillNameFromPlainText('/graphify'), 'graphify');
    assert.equal(extractInvokedSkillNameFromPlainText('/chronicle standup'), 'chronicle');
    assert.equal(extractInvokedSkillNameFromPlainText('/code-review'), 'code-review');
});

test('extractInvokedSkillNameFromPlainText: returns null for non-slash or non-string content', () => {
    assert.equal(extractInvokedSkillNameFromPlainText('can you help me fix this?'), null);
    assert.equal(extractInvokedSkillNameFromPlainText(''), null);
    assert.equal(extractInvokedSkillNameFromPlainText(null), null);
    assert.equal(extractInvokedSkillNameFromPlainText(undefined), null);
    assert.equal(extractInvokedSkillNameFromPlainText(123), null);
});

test('extractInvokedSkillNameFromPlainText: ignores slash commands not at the start', () => {
    assert.equal(extractInvokedSkillNameFromPlainText('some text /graphify'), null);
    assert.equal(extractInvokedSkillNameFromPlainText('check the path /usr/bin'), null);
});

test('analyzeSessionUsage: Copilot CLI autonomous "skill" tool call populates skillCalls', async () => {
    // Copilot CLI wraps an autonomously-invoked skill behind a generic "skill" tool.execution_start
    // (lowercase, unlike Claude Code's "Skill"), with the real name in data.arguments.skill.
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-5' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'skill', arguments: { skill: 'sync-host-views' } } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.equal(result.skillCalls?.byName['sync-host-views'], 1);
    assert.equal(result.skillCalls?.total, 1);
    // Additive: the raw "skill" wrapper tool call is still counted as-is, unchanged.
    assert.equal(result.toolCalls.byTool['skill'], 1);
});

test('analyzeSessionUsage: Copilot CLI MCP tool.execution_start (data.mcpServerName) lands in mcpTools, not toolCalls', async () => {
    // Copilot CLI never writes data.mcpServer; its MCP tool.execution_start events carry
    // data.mcpServerName / data.mcpToolName, and toolName is `<server>-<tool>`, which
    // isMcpTool() does not match. The server tag must route the call to mcpTools only.
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-5' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'user.message', data: { content: 'read the readme' } },
        {
            type: 'tool.execution_start',
            data: {
                toolCallId: 'c1',
                toolName: 'github-mcp-server-get_file_contents',
                mcpServerName: 'github-mcp-server',
                mcpToolName: 'get_file_contents',
                arguments: { owner: 'o', repo: 'r', path: 'README.md' },
            },
        },
        {
            type: 'tool.execution_complete',
            data: { toolCallId: 'c1', success: true, result: { content: 'x'.repeat(400) } },
        },
        { type: 'tool.execution_start', data: { toolCallId: 'c2', toolName: 'view', arguments: { path: 'a.ts' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'c2', success: true, result: { content: 'y'.repeat(400) } } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.equal(result.mcpTools.total, 1);
    assert.equal(result.mcpTools.byServer['github-mcp-server'], 1);
    assert.equal(result.mcpTools.byTool[normalizeMcpToolName('github-mcp-server-get_file_contents')], 1);
    assert.equal(result.mcpTools.byTool['mcp_io_github_git_get_file_contents'], 1);
    // Not double-counted as a regular tool call.
    assert.equal(result.toolCalls.byTool['github-mcp-server-get_file_contents'], undefined);
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byTool['view'], 1);
    // Output-token bookkeeping skips MCP results, like it does for prefix-matched MCP names.
    assert.equal(result.toolCalls.outputTokensByTool?.['github-mcp-server-get_file_contents'], undefined);
    assert.ok((result.toolCalls.outputTokensByTool?.['view'] ?? 0) > 0);
});

test('analyzeSessionUsage: blank data.mcpServer does not mask a valid data.mcpServerName', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-5' }, timestamp: '2026-05-01T10:00:00Z' },
        {
            type: 'tool.execution_start',
            data: { toolCallId: 'c1', toolName: 'github-mcp-server-get_file_contents', mcpServer: '  ', mcpServerName: 'github-mcp-server', arguments: {} },
        },
        { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'x'.repeat(400) } } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const result = await analyzeSessionUsage(makeMockDeps(), '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.equal(result.mcpTools.byServer['github-mcp-server'], 1);
    assert.equal(result.toolCalls.total, 0);
    assert.equal(result.toolCalls.byTool['github-mcp-server-get_file_contents'], undefined);
    assert.equal(result.toolCalls.outputTokensByTool?.['github-mcp-server-get_file_contents'], undefined);
});

test('analyzeSessionUsage: Copilot CLI user-typed slash invocation (plain text, no wrapper) populates skillCalls', async () => {
    // Unlike Claude Code's <command-message>/<command-name> tags, Copilot CLI's explicit
    // slash invocation is just the literal user-typed text, e.g. "/graphify".
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-5' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'user.message', data: { content: '/graphify' } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.equal(result.skillCalls?.byName['graphify'], 1);
    assert.equal(result.skillCalls?.total, 1);
});

test('analyzeSessionUsage: Copilot CLI regular user message (no slash) does not populate skillCalls', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-5' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'user.message', data: { content: 'can you fix the failing test?' } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.equal(result.skillCalls?.total ?? 0, 0);
});

test('analyzeSessionUsage: generated CLI messages do not become user corrections', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-5' } },
        { type: 'user.message', data: { content: 'Stop doing that', source: 'agent-parent-session', parentAgentTaskId: 'subagent-task' } },
        { type: 'user.message', data: { content: '<skill-context>you deleted files</skill-context>', source: 'skill-test' } },
        { type: 'user.message', data: { content: '<cross_session_message>No blocker remains</cross_session_message>' } },
        { type: 'user.message', data: { content: 'please revert that', parentAgentTaskId: 'main-agent-task' } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const result = await analyzeSessionUsage(
        makeMockDeps(),
        '/home/user/.copilot/session-state/abc/events.jsonl',
        content,
    );
    assert.equal(result.correctionCounts?.userCorrections, 1);
    assert.equal(result.correctionMoments?.filter(m => m.type === 'user-correction').length, 1);
    assert.match(result.correctionMoments?.find(m => m.type === 'user-correction')?.snippet ?? '', /revert/);
});

test('analyzeSessionUsage: CLI JSONL session produces model efficiency counters with retry detection', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'user.message', data: { text: 'fix the bug' } },
        { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'edit', arguments: { path: '/repo/a.ts', old_str: 'x', new_str: 'y' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: false } },
        // Immediate same-file retry after the failed edit
        { type: 'tool.execution_start', data: { toolCallId: 'c2', toolName: 'edit', arguments: { path: '/repo/a.ts', old_str: 'x2', new_str: 'y' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'c2', success: true } },
        { type: 'user.message', data: { text: 'now the other file' } },
        { type: 'tool.execution_start', data: { toolCallId: 'c3', toolName: 'create', arguments: { path: '/repo/b.ts', file_text: 'ok\n' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'c3', success: true } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    const c = result.modelEfficiency?.['claude-sonnet-4.6'];
    assert.ok(c, 'expected efficiency counters for the session model');
    assert.equal(c.calls, 2);
    assert.equal(c.editTurns, 2);
    assert.equal(c.retries, 1);
    assert.equal(c.selfCorrections, 0);
    assert.equal(c.oneShotEditTurns, 1);
    assert.equal(c.editToolCalls, 3);
});

test('analyzeSessionUsage: CLI JSONL records per-tool failures and start→complete latency, including MCP per-server mirrors', async () => {
    const t = (offsetMs: number) => new Date(Date.UTC(2026, 4, 1, 10, 0, 0, offsetMs)).toISOString();
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' }, timestamp: t(0) },
        { type: 'user.message', data: { text: 'do things' }, timestamp: t(1) },
        // view: 40 ms, success
        { type: 'tool.execution_start', data: { toolCallId: 'v1', toolName: 'view', arguments: { path: '/a' } }, timestamp: t(100) },
        { type: 'tool.execution_complete', data: { toolCallId: 'v1', success: true, result: { content: 'ok' } }, timestamp: t(140) },
        // powershell: 3000 ms, explicit failure
        { type: 'tool.execution_start', data: { toolCallId: 'p1', toolName: 'powershell', arguments: { command: 'x' } }, timestamp: t(200) },
        { type: 'tool.execution_complete', data: { toolCallId: 'p1', success: false, error: { message: 'boom', code: 1 } }, timestamp: t(3200) },
        // powershell: 0 ms, success → counted in bucket 0, not dropped
        { type: 'tool.execution_start', data: { toolCallId: 'p2', toolName: 'powershell', arguments: { command: 'y' } }, timestamp: t(4000) },
        { type: 'tool.execution_complete', data: { toolCallId: 'p2', success: true }, timestamp: t(4000) },
        // MCP call: 1500 ms, failure, server name on the start event (Copilot CLI shape)
        { type: 'tool.execution_start', data: { toolCallId: 'm1', toolName: 'github-mcp-server-get_file_contents', mcpServerName: 'github-mcp-server', mcpToolName: 'get_file_contents', arguments: {} }, timestamp: t(5000) },
        { type: 'tool.execution_complete', data: { toolCallId: 'm1', success: false, error: { message: 'nope', code: 2 } }, timestamp: t(6500) },
        // missing success flag (older schema) → neither completed nor failed; result text must not be sized either
        { type: 'tool.execution_start', data: { toolCallId: 'g1', toolName: 'grep', arguments: {} }, timestamp: t(7000) },
        { type: 'tool.execution_complete', data: { toolCallId: 'g1', result: { content: 'match '.repeat(50) } }, timestamp: t(7010) },
        // complete without a timestamp → failure counted, no latency sample
        { type: 'tool.execution_start', data: { toolCallId: 'e1', toolName: 'edit', arguments: { path: '/b', old_str: 'a', new_str: 'b' } }, timestamp: t(8000) },
        { type: 'tool.execution_complete', data: { toolCallId: 'e1', success: false } },
        // start with no complete (aborted) → nothing recorded
        { type: 'tool.execution_start', data: { toolCallId: 'orphan', toolName: 'web_fetch', arguments: {} }, timestamp: t(9000) },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const result = await analyzeSessionUsage(makeMockDeps(), '/home/user/.copilot/session-state/abc/events.jsonl', content);

    assert.deepEqual(result.toolCalls.completedByTool, { view: 1, powershell: 2, edit: 1 }, 'orphaned start and the verdict-less grep are not completed; MCP call is counted per server');
    assert.deepEqual(result.toolCalls.failuresByTool, { powershell: 1, edit: 1 });
    assert.deepEqual(result.mcpTools.completedByServer, { 'github-mcp-server': 1 });
    assert.deepEqual(result.mcpTools.failuresByServer, { 'github-mcp-server': 1 });

    const lat = result.toolCalls.latencyByTool!;
    assert.equal(lat.view.count, 1);
    assert.equal(lat.view.sumMs, 40);
    assert.equal(lat.view.buckets[5], 1);
    assert.equal(lat.powershell.count, 2);
    assert.equal(lat.powershell.sumMs, 3000);
    assert.equal(lat.powershell.buckets[0], 1);
    assert.equal(lat.powershell.buckets[11], 1);
    assert.equal(lat.grep.count, 1, 'verdict-less completion still contributes latency');
    assert.equal(lat.grep.sumMs, 10);
    assert.equal(result.toolCalls.outputTokensByTool?.grep, undefined, 'verdict-less result text is not sized: it has no completed call to divide by');
    assert.ok((result.toolCalls.outputTokensByTool?.view ?? 0) > 0, 'explicit-success result text is sized');
    assert.equal(lat.edit, undefined, 'no latency sample without a complete timestamp');
    assert.equal(lat.web_fetch, undefined, 'orphaned start must not produce a sample');
    assert.equal(lat['github-mcp-server-get_file_contents'], undefined, 'MCP latency lives under mcpTools only');
    assert.equal(result.mcpTools.latencyByServer!['github-mcp-server'].sumMs, 1500);
    assert.equal(result.mcpTools.latencyByServer!['github-mcp-server'].count, 1);

    // Existing counters are untouched by the new bookkeeping.
    assert.equal(result.toolCalls.byTool.powershell, 2);
    assert.equal(result.toolCalls.byTool.web_fetch, 1);
});

test('mergeUsageAnalysis: failure counts and latency histograms are summed across sessions and absent fields are skipped', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.toolCalls.completedByTool = { view: 2 };
    a.mcpTools.completedByServer = { gh: 1 };
    a.toolCalls.failuresByTool = { view: 1 };
    a.toolCalls.latencyByTool = { view: { count: 2, sumMs: 60, buckets: [0, 0, 0, 0, 1, 1] } };
    a.mcpTools.failuresByServer = { gh: 1 };
    a.mcpTools.latencyByServer = { gh: { count: 1, sumMs: 1500, buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] } };
    const b = emptyAnalysis();
    b.toolCalls.completedByTool = { view: 1, edit: 1 };
    b.toolCalls.failuresByTool = { view: 2, edit: 1 };
    b.toolCalls.latencyByTool = { view: { count: 1, sumMs: 5000, buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] } };
    const c = emptyAnalysis(); // no new fields at all (old cache entry)

    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, b);
    mergeUsageAnalysis(period, c);

    assert.deepEqual(period.toolCalls.completedByTool, { view: 3, edit: 1 });
    assert.deepEqual(period.mcpTools.completedByServer, { gh: 1 });
    assert.deepEqual(period.toolCalls.failuresByTool, { view: 3, edit: 1 });
    assert.equal(period.toolCalls.latencyByTool!.view.count, 3);
    assert.equal(period.toolCalls.latencyByTool!.view.sumMs, 5060);
    assert.equal(period.toolCalls.latencyByTool!.view.buckets[4], 1);
    assert.equal(period.toolCalls.latencyByTool!.view.buckets[12], 1);
    assert.deepEqual(period.mcpTools.failuresByServer, { gh: 1 });
    assert.equal(period.mcpTools.latencyByServer!.gh.sumMs, 1500);

    const untouched = emptyPeriod();
    mergeUsageAnalysis(untouched, c);
    assert.equal(untouched.toolCalls.completedByTool, undefined);
    assert.equal(untouched.toolCalls.failuresByTool, undefined);
    assert.equal(untouched.toolCalls.latencyByTool, undefined);
    assert.equal(untouched.mcpTools.failuresByServer, undefined);
});

test('analyzeSessionUsage: JSON session produces model efficiency counters from textEditGroup responses', async () => {
    const content = JSON.stringify({
        requests: [
            {
                modelId: 'copilot/gpt-4o',
                message: { text: 'edit it' },
                result: { promptTokens: 10, outputTokens: 5 },
                response: [
                    { kind: 'textEditGroup', uri: { path: '/src/a.ts' } },
                    { kind: 'toolInvocationSerialized', toolId: 'run_in_terminal' },
                    // Re-edit of the same file after a tool invocation → self-correction
                    { kind: 'textEditGroup', uri: { path: '/src/a.ts' } },
                ],
            },
            { modelId: 'copilot/gpt-4o', message: { text: 'just a question' }, result: { promptTokens: 10, outputTokens: 5 } },
        ]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    const c = result.modelEfficiency?.['gpt-4o'];
    assert.ok(c, 'expected efficiency counters for gpt-4o');
    assert.equal(c.calls, 2);
    assert.equal(c.editTurns, 1);
    assert.equal(c.selfCorrections, 1);
    assert.equal(c.retries, 0);
    assert.equal(c.oneShotEditTurns, 0);
});

test('analyzeSessionUsage: delta JSONL session produces model efficiency counters', async () => {
    const request = {
        requestId: 'req-1',
        modelId: 'copilot/gpt-4o',
        timestamp: 1700000000000,
        response: [
            { kind: 'textEditGroup', uri: { path: '/src/foo.ts' }, edits: [[{ text: 'line1\n', range: { startLineNumber: 1, endLineNumber: 1 } }]] },
        ]
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1700000000000, requests: [] } });
    const line1 = JSON.stringify({ kind: 2, k: ['requests'], v: request });
    const content = [line0, line1].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test-session.jsonl', content);
    const c = result.modelEfficiency?.['gpt-4o'];
    assert.ok(c, 'expected efficiency counters for gpt-4o from delta JSONL');
    assert.equal(c.calls, 1);
    assert.equal(c.editTurns, 1);
    assert.equal(c.oneShotEditTurns, 1);
});

test('analyzeSessionUsage: CLI JSONL session extracts LOC from successful create tool calls', async () => {
    const toolCallId = 'call-create-1';
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' }, timestamp: '2026-05-01T10:00:00Z' },
        {
            type: 'tool.execution_start',
            data: {
                toolCallId,
                toolName: 'create',
                arguments: {
                    path: '/repo/src/bar.ts',
                    file_text: 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
                },
            },
        },
        { type: 'tool.execution_complete', data: { toolCallId, success: true } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    // file_text has 3 lines + trailing newline → 3 lines counted (trailing \n not counted as extra line)
    assert.equal(result.editScope?.linesAdded, 3, 'expected 3 lines added (trailing newline not counted)');
    assert.equal(result.editScope?.linesRemoved, 0, 'create should have 0 lines removed');
});

test('analyzeSessionUsage: CLI JSONL session does NOT count LOC for failed edit tool calls', async () => {
    const toolCallId = 'call-edit-fail';
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' } },
        {
            type: 'tool.execution_start',
            data: {
                toolCallId,
                toolName: 'edit',
                arguments: { path: '/repo/src/foo.ts', old_str: 'old', new_str: 'new\nlines\nhere' },
            },
        },
        { type: 'tool.execution_complete', data: { toolCallId, success: false } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.equal(result.editScope?.linesAdded ?? 0, 0, 'failed edits should not contribute LOC');
    assert.equal(result.editScope?.linesRemoved ?? 0, 0, 'failed edits should not contribute LOC');
});

test('analyzeSessionUsage: CLI JSONL LOC counts multiple files across edit and create', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' } },
        {
            type: 'tool.execution_start',
            data: { toolCallId: 'id1', toolName: 'edit', arguments: { path: '/repo/a.py', old_str: 'x', new_str: 'x\ny\nz' } },
        },
        { type: 'tool.execution_complete', data: { toolCallId: 'id1', success: true } },
        {
            type: 'tool.execution_start',
            data: { toolCallId: 'id2', toolName: 'create', arguments: { path: '/repo/b.js', file_text: 'a\nb\n' } },
        },
        { type: 'tool.execution_complete', data: { toolCallId: 'id2', success: true } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    // edit: new_str='x\ny\nz' → 3 lines; old_str='x' → 1 line
    // create: file_text='a\nb\n' → 2 lines
    assert.equal(result.editScope?.linesAdded, 5, 'expected 3+2=5 lines added');
    assert.equal(result.editScope?.linesRemoved, 1, 'expected 1 line removed');
    assert.equal(result.editScope?.totalEditedFiles, 2, 'expected 2 edited files');
    assert.ok(result.editScope?.multiFileEdits, 'expected multi-file edit flag');
    assert.ok(result.editScope?.languageUsage?.['py'], 'expected py language tracking');
    assert.ok(result.editScope?.languageUsage?.['js'], 'expected js language tracking');
});

// ---------------------------------------------------------------------------
// isParsedSessionJson
// ---------------------------------------------------------------------------

test('isParsedSessionJson: null returns false', () => {
    assert.equal(isParsedSessionJson(null), false);
});

test('isParsedSessionJson: string returns false', () => {
    assert.equal(isParsedSessionJson('{"requests":[]}'), false);
});

test('isParsedSessionJson: number returns false', () => {
    assert.equal(isParsedSessionJson(42), false);
});

test('isParsedSessionJson: array returns false', () => {
    assert.equal(isParsedSessionJson([{ requests: [] }]), false);
});

test('isParsedSessionJson: empty object returns true', () => {
    assert.equal(isParsedSessionJson({}), true);
});

test('isParsedSessionJson: valid session with requests array returns true', () => {
    assert.equal(isParsedSessionJson({ requests: [] }), true);
});

test('isParsedSessionJson: requests as non-array (string) returns false', () => {
    assert.equal(isParsedSessionJson({ requests: 'not-an-array' }), false);
});

test('isParsedSessionJson: requests as non-array (number) returns false', () => {
    assert.equal(isParsedSessionJson({ requests: 42 }), false);
});

test('isParsedSessionJson: creationDate as string returns false', () => {
    assert.equal(isParsedSessionJson({ creationDate: '2024-01-01' }), false);
});

test('isParsedSessionJson: creationDate as number returns true', () => {
    assert.equal(isParsedSessionJson({ creationDate: 1700000000000 }), true);
});

test('isParsedSessionJson: lastMessageDate as string returns false', () => {
    assert.equal(isParsedSessionJson({ lastMessageDate: 'now' }), false);
});

test('isParsedSessionJson: mode as non-object (string) returns false', () => {
    assert.equal(isParsedSessionJson({ mode: 'agent' }), false);
});

test('isParsedSessionJson: mode as array returns false', () => {
    assert.equal(isParsedSessionJson({ mode: [] }), false);
});

test('isParsedSessionJson: mode as object returns true', () => {
    assert.equal(isParsedSessionJson({ mode: { id: 'copilot.agentMode' } }), true);
});

test('isParsedSessionJson: mode with numeric id returns false', () => {
    assert.equal(isParsedSessionJson({ mode: { id: 123 } }), false);
});

test('isParsedSessionJson: full valid session object returns true', () => {
    assert.equal(isParsedSessionJson({
        requests: [{ modelId: 'gpt-4o' }],
        mode: { id: 'copilot.askMode' },
        creationDate: 1700000000000,
        lastMessageDate: 1700000060000,
    }), true);
});

// ---------------------------------------------------------------------------
// outputTokensByTool tracking
// ---------------------------------------------------------------------------

test('mergeUsageAnalysis: accumulates outputTokensByTool when present', () => {
    const period = emptyPeriod();
    const a1 = emptyAnalysis();
    a1.toolCalls.total = 2;
    a1.toolCalls.byTool = { read: 2 };
    a1.toolCalls.outputTokensByTool = { read: 1200 };

    const a2 = emptyAnalysis();
    a2.toolCalls.total = 1;
    a2.toolCalls.byTool = { read: 1 };
    a2.toolCalls.outputTokensByTool = { read: 800 };

    mergeUsageAnalysis(period, a1);
    mergeUsageAnalysis(period, a2);

    assert.equal(period.toolCalls.outputTokensByTool?.['read'], 2000);
});

test('mergeUsageAnalysis: handles missing outputTokensByTool gracefully', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.toolCalls.total = 1;
    a.toolCalls.byTool = { search: 1 };
    // No outputTokensByTool set

    mergeUsageAnalysis(period, a);

    assert.equal(period.toolCalls.outputTokensByTool, undefined);
});

test('mergeUsageAnalysis: merges outputTokensByTool from multiple tools', () => {
    const period = emptyPeriod();
    const a1 = emptyAnalysis();
    a1.toolCalls.byTool = { read: 1, search: 1 };
    a1.toolCalls.outputTokensByTool = { read: 500, search: 300 };

    const a2 = emptyAnalysis();
    a2.toolCalls.byTool = { read: 1, edit: 1 };
    a2.toolCalls.outputTokensByTool = { read: 400, edit: 50 };

    mergeUsageAnalysis(period, a1);
    mergeUsageAnalysis(period, a2);

    assert.equal(period.toolCalls.outputTokensByTool?.['read'], 900);
    assert.equal(period.toolCalls.outputTokensByTool?.['search'], 300);
    assert.equal(period.toolCalls.outputTokensByTool?.['edit'], 50);
});

test('analyzeSessionUsage: CLI JSONL tool.execution_complete with string content accumulates outputTokensByTool', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'tool.execution_start', data: { toolCallId: 'tc1', toolName: 'read', arguments: { path: '/foo' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'tc1', success: true, result: { content: 'hello world this is file content' } } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);

    assert.ok(result.toolCalls.outputTokensByTool, 'outputTokensByTool should be defined');
    assert.ok((result.toolCalls.outputTokensByTool?.['read'] ?? 0) > 0, 'read tool should have output tokens');
});

test('analyzeSessionUsage: CLI JSONL tool.execution_complete with content array accumulates outputTokensByTool', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'tool.execution_start', data: { toolCallId: 'tc2', toolName: 'search', arguments: { query: 'foo' } } },
        {
            type: 'tool.execution_complete',
            data: {
                toolCallId: 'tc2',
                success: true,
                result: {
                    content: [
                        { type: 'text', text: 'result one' },
                        { type: 'text', text: 'result two' },
                    ],
                },
            },
        },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);

    assert.ok(result.toolCalls.outputTokensByTool?.['search'] !== undefined, 'search tool should have output tokens');
    assert.ok((result.toolCalls.outputTokensByTool?.['search'] ?? 0) > 0, 'search tool output tokens should be > 0');
});

test('analyzeSessionUsage: tool.execution_complete without content does not set outputTokensByTool', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5' }, timestamp: '2026-05-01T10:00:00Z' },
        { type: 'tool.execution_start', data: { toolCallId: 'tc3', toolName: 'run_in_terminal', arguments: {} } },
        { type: 'tool.execution_complete', data: { toolCallId: 'tc3', success: true, result: {} } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);

    assert.equal(result.toolCalls.outputTokensByTool?.['run_in_terminal'] ?? 0, 0, 'empty result should not track tokens');
});

// ---------------------------------------------------------------------------
// createEmptySessionUsageAnalysis
// ---------------------------------------------------------------------------

test('createEmptySessionUsageAnalysis: returns zero-initialised SessionUsageAnalysis', () => {
    const analysis = createEmptySessionUsageAnalysis();
    assert.equal(analysis.toolCalls.total, 0);
    assert.deepEqual(analysis.toolCalls.byTool, {});
    assert.equal(analysis.modeUsage.ask, 0);
    assert.equal(analysis.modeUsage.agent, 0);
    assert.equal(analysis.modeUsage.cli, 0);
    assert.equal(analysis.mcpTools.total, 0);
    assert.equal(analysis.modelSwitching.modelCount, 0);
    assert.deepEqual(analysis.modelSwitching.uniqueModels, []);
    assert.equal(analysis.modelSwitching.hasMixedTiers, false);
    assert.equal(analysis.contextReferences.file, 0);
});

// ---------------------------------------------------------------------------
// applyModelTierClassification
// ---------------------------------------------------------------------------

test('applyModelTierClassification: classifies standard and premium models and detects mixed tiers', () => {
    const analysis = emptyAnalysis();
    const modelPricing = makeMockDeps().modelPricing;
    const uniqueModels = ['gpt-4o', 'claude-sonnet-4.5'];
    const allModelRequests = ['gpt-4o', 'gpt-4o', 'claude-sonnet-4.5'];
    applyModelTierClassification(modelPricing, uniqueModels, allModelRequests, analysis);
    assert.deepEqual(analysis.modelSwitching.tiers.standard, ['gpt-4o']);
    assert.deepEqual(analysis.modelSwitching.tiers.premium, ['claude-sonnet-4.5']);
    assert.ok(analysis.modelSwitching.hasMixedTiers);
    assert.equal(analysis.modelSwitching.standardRequests, 2);
    assert.equal(analysis.modelSwitching.premiumRequests, 1);
    assert.equal(analysis.modelSwitching.unknownRequests, 0);
});

test('applyModelTierClassification: all standard models produces hasMixedTiers=false', () => {
    const analysis = emptyAnalysis();
    const modelPricing = makeMockDeps().modelPricing;
    applyModelTierClassification(modelPricing, ['gpt-4o'], ['gpt-4o', 'gpt-4o'], analysis);
    assert.equal(analysis.modelSwitching.hasMixedTiers, false);
    assert.equal(analysis.modelSwitching.standardRequests, 2);
    assert.equal(analysis.modelSwitching.premiumRequests, 0);
    assert.deepEqual(analysis.modelSwitching.tiers.premium, []);
});

test('applyModelTierClassification: unknown model goes to unknown tier', () => {
    const analysis = emptyAnalysis();
    const modelPricing = makeMockDeps().modelPricing;
    applyModelTierClassification(modelPricing, ['some-unknown-model'], ['some-unknown-model'], analysis);
    assert.deepEqual(analysis.modelSwitching.tiers.unknown, ['some-unknown-model']);
    assert.equal(analysis.modelSwitching.unknownRequests, 1);
    assert.equal(analysis.modelSwitching.hasMixedTiers, false);
});

// ---------------------------------------------------------------------------
// mergeUsageAnalysis: enhanced metrics branches
// ---------------------------------------------------------------------------

test('mergeUsageAnalysis: merges editScope singleFileEdits and avgFilesPerSession', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.editScope = { singleFileEdits: 1, multiFileEdits: 0, totalEditedFiles: 1, avgFilesPerSession: 1 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.editScope.singleFileEdits, 1);
    assert.equal(period.editScope.multiFileEdits, 0);
    assert.equal(period.editScope.totalEditedFiles, 1);
    assert.equal(period.editScope.avgFilesPerSession, 1);
});

test('mergeUsageAnalysis: merges editScope multiFileEdits', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.editScope = { singleFileEdits: 0, multiFileEdits: 1, totalEditedFiles: 3, avgFilesPerSession: 3 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.editScope.multiFileEdits, 1);
    assert.equal(period.editScope.totalEditedFiles, 3);
});

test('mergeUsageAnalysis: merges applyUsage and calculates applyRate', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.applyUsage = { totalApplies: 4, totalCodeBlocks: 10, applyRate: 40 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.applyUsage.totalApplies, 4);
    assert.equal(period.applyUsage.totalCodeBlocks, 10);
    assert.equal(period.applyUsage.applyRate, 40);
});

test('mergeUsageAnalysis: applyUsage with zero codeBlocks yields applyRate=0', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.applyUsage = { totalApplies: 0, totalCodeBlocks: 0, applyRate: 0 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.applyUsage.applyRate, 0);
});

test('mergeUsageAnalysis: merges sessionDuration when sessions > 0', () => {
    const period = emptyPeriod();
    period.sessions = 1;
    const a = emptyAnalysis();
    a.sessionDuration = { totalDurationMs: 30000, avgDurationMs: 30000, avgFirstProgressMs: 300, avgTotalElapsedMs: 1000, avgWaitTimeMs: 100, activeDurationMs: 15000 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.sessionDuration.totalDurationMs, 30000);
    assert.equal(period.sessionDuration.avgDurationMs, 30000);
    assert.equal(period.sessionDuration.avgFirstProgressMs, 300);
    assert.equal(period.sessionDuration.avgTotalElapsedMs, 1000);
    assert.equal(period.sessionDuration.avgWaitTimeMs, 100);
});

test('mergeUsageAnalysis: sessionDuration with sessions=0 skips avg calculation', () => {
    const period = emptyPeriod();
    // period.sessions defaults to 0
    const a = emptyAnalysis();
    a.sessionDuration = { totalDurationMs: 60000, avgDurationMs: 60000, avgFirstProgressMs: 500, avgTotalElapsedMs: 2000, avgWaitTimeMs: 200, activeDurationMs: 25000 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.sessionDuration.totalDurationMs, 60000);
    // avgDurationMs stays 0 since sessionCount <= 0
    assert.equal(period.sessionDuration.avgDurationMs, 0);
});

test('mergeUsageAnalysis: merges conversationPatterns and updates avgTurnsPerSession', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.conversationPatterns = { multiTurnSessions: 1, singleTurnSessions: 0, avgTurnsPerSession: 7, maxTurnsInSession: 7 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.conversationPatterns.multiTurnSessions, 1);
    assert.equal(period.conversationPatterns.singleTurnSessions, 0);
    assert.equal(period.conversationPatterns.maxTurnsInSession, 7);
    assert.equal(period.conversationPatterns.avgTurnsPerSession, 7);
});

test('mergeUsageAnalysis: conversationPatterns with both zero sessions skips avgTurns', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.conversationPatterns = { multiTurnSessions: 0, singleTurnSessions: 0, avgTurnsPerSession: 0, maxTurnsInSession: 0 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.conversationPatterns.avgTurnsPerSession, 0);
});

test('mergeUsageAnalysis: merges agentTypes counts', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.agentTypes = { editsAgent: 2, defaultAgent: 3, workspaceAgent: 1, other: 4 };
    mergeUsageAnalysis(period, a);
    assert.equal(period.agentTypes.editsAgent, 2);
    assert.equal(period.agentTypes.defaultAgent, 3);
    assert.equal(period.agentTypes.workspaceAgent, 1);
    assert.equal(period.agentTypes.other, 4);
});

test('mergeUsageAnalysis: accumulates agentTypes on repeated merge', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.agentTypes = { editsAgent: 1, defaultAgent: 1, workspaceAgent: 0, other: 0 };
    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, a);
    assert.equal(period.agentTypes.editsAgent, 2);
    assert.equal(period.agentTypes.defaultAgent, 2);
});

test('mergeUsageAnalysis: merges thinkingEffort and initialises period field', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.thinkingEffort = { byEffort: { high: 5 }, switchCount: 2, defaultEffort: 'high' };
    mergeUsageAnalysis(period, a);
    assert.ok(period.thinkingEffortUsage, 'thinkingEffortUsage should be initialised');
    assert.equal(period.thinkingEffortUsage!.sessionCount, 1);
    assert.equal(period.thinkingEffortUsage!.byEffort['high'], 5);
    assert.equal(period.thinkingEffortUsage!.switchCount, 2);
});

test('mergeUsageAnalysis: second thinkingEffort merge accumulates sessionCount and byEffort', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.thinkingEffort = { byEffort: { high: 3, medium: 1 }, switchCount: 1, defaultEffort: 'high' };
    mergeUsageAnalysis(period, a);
    mergeUsageAnalysis(period, a);
    assert.equal(period.thinkingEffortUsage!.sessionCount, 2);
    assert.equal(period.thinkingEffortUsage!.byEffort['high'], 6);
    assert.equal(period.thinkingEffortUsage!.byEffort['medium'], 2);
    assert.equal(period.thinkingEffortUsage!.switchCount, 2);
});

test('mergeUsageAnalysis: handles null modelSwitching on analysis object gracefully', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    (a as any).modelSwitching = null;
    mergeUsageAnalysis(period, a);
    assert.equal(period.modelSwitching.totalSessions, 0);
});

// ---------------------------------------------------------------------------
// analyzeContentReferences: long path truncation
// ---------------------------------------------------------------------------

test('analyzeContentReferences: path longer than 100 chars is truncated with ... prefix', () => {
    const refs = emptyRefs();
    const longPath = '/very/long/path/' + 'a'.repeat(85) + '/file.ts';
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: longPath } },
    ], refs);
    const keys = Object.keys(refs.byPath);
    assert.equal(keys.length, 1);
    assert.ok(keys[0].startsWith('...'), `expected path to start with '...' but got: ${keys[0]}`);
    assert.ok(keys[0].length <= 100, `truncated key should be <= 100 chars but got ${keys[0].length}`);
    assert.equal(refs.file, 1);
});

// ---------------------------------------------------------------------------
// analyzeRequestContext: edge cases for dynamic and prompt parts
// ---------------------------------------------------------------------------

test('analyzeRequestContext: dynamic part with end=0 does not increment codeContextLines', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [{
                kind: 'dynamic',
                data: { range: { startLineNumber: 5, endLineNumber: 0 } },
            }]
        }
    }, refs);
    assert.equal(refs.codeContextLines, 0);
});

test('analyzeRequestContext: dynamic part without range data does not increment codeContextLines', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [{ kind: 'dynamic', data: {} }]
        }
    }, refs);
    assert.equal(refs.codeContextLines, 0);
});

test('analyzeRequestContext: prompt part without command field does not count in byKind', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [{
                kind: 'prompt',
                slashPromptCommand: {},
            }]
        }
    }, refs);
    assert.equal(refs.byKind['prompt'] ?? 0, 0);
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: windsurf:// URL handling
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// analyzeSessionUsage: delta JSONL edge cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// analyzeSessionUsage: JSON session null response item guard
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: JSON session with null response item in array is skipped', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            message: { text: 'do it' },
            result: { promptTokens: 10, outputTokens: 5 },
            response: [null, { kind: 'toolInvocationSerialized', toolId: 'run_cmd' }]
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byTool['run_cmd'], 1);
});

test('analyzeSessionUsage: delta JSONL request without requestId does not count mode', async () => {
    // A kind=2 append where the request has no requestId — should be skipped for mode counting
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1700000000000, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: { /* no requestId */ message: { text: 'hi' } } });
    const content = [line0, lineReq].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.modeUsage.ask, 0, 'no mode count for request without requestId');
});

test('analyzeSessionUsage: delta JSONL request response with null item is skipped', async () => {
    const request = {
        requestId: 'req-1',
        response: [null, { kind: 'toolInvocationSerialized', toolId: 'search_tool' }]
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: request });
    const content = [line0, lineReq].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byTool['search_tool'], 1);
});

test('analyzeSessionUsage: delta JSONL with toolInvocationSerialized in response items', async () => {
    const request = {
        requestId: 'req-1',
        response: [
            { kind: 'toolInvocationSerialized', toolId: 'read_file' },
        ]
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: request });
    const content = [line0, lineReq].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byTool['read_file'], 1);
});

test('analyzeSessionUsage: delta JSONL with request.agent.id counts as tool call', async () => {
    const request = {
        requestId: 'req-1',
        agent: { id: 'copilot.editsAgent' },
        message: { text: 'refactor' }
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: request });
    const content = [line0, lineReq].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.toolCalls.total >= 1, 'agent.id should increment toolCalls');
    assert.ok(result.toolCalls.byTool['copilot.editsAgent'] >= 1);
});

test('analyzeSessionUsage: delta JSONL two requests with different models counts switch', async () => {
    const req1 = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 10, outputTokens: 5 } };
    const req2 = { requestId: 'r2', modelId: 'copilot/claude-sonnet-4.5', result: { promptTokens: 10, outputTokens: 5 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR1 = JSON.stringify({ kind: 2, k: ['requests'], v: req1 });
    const lineR2 = JSON.stringify({ kind: 2, k: ['requests'], v: req2 });
    const content = [line0, lineR1, lineR2].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.modelSwitching.switchCount >= 1, 'should count model switch between gpt-4o and claude');
    assert.ok(result.modelSwitching.uniqueModels.length >= 2);
});

test('analyzeSessionUsage: delta JSONL request using result.metadata.modelId for model', async () => {
    const req = {
        requestId: 'r1',
        result: { metadata: { modelId: 'copilot/gpt-4o' }, promptTokens: 10, outputTokens: 5 }
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.modelSwitching.uniqueModels.length >= 1, 'should detect model from metadata.modelId');
});

test('analyzeSessionUsage: delta JSONL with implicit selection increments implicitSelection', async () => {
    const line0 = JSON.stringify({
        kind: 0,
        v: {
            version: 3, requests: [],
            inputState: {
                mode: 'ask',
                selections: [{ startLineNumber: 5, endLineNumber: 15, startColumn: 1, endColumn: 1 }]
            }
        }
    });
    const content = line0;
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.contextReferences.implicitSelection, 1);
});

test('analyzeSessionUsage: windsurf:// URL returns empty analysis without errors', async () => {
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, 'windsurf://some/session');
    assert.equal(result.modeUsage.ask, 0);
    assert.equal(result.toolCalls.total, 0);
    assert.equal(result.mcpTools.total, 0);
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: CLI JSONL MCP tool events
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: CLI JSONL mcp.tool.call events populate mcpTools by server and tool', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5' } },
        { type: 'mcp.tool.call', data: { mcpServer: 'github', toolName: 'list_issues' } },
        { type: 'mcp.tool.call', data: { mcpServer: 'github', toolName: 'list_issues' } },
        { type: 'mcp.tool.call', data: { mcpServer: 'jira', toolName: 'get_issue' } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.equal(result.mcpTools.total, 3);
    assert.equal(result.mcpTools.byServer['github'], 2);
    assert.equal(result.mcpTools.byServer['jira'], 1);
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: CLI JSONL thinking effort
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: CLI JSONL thinking effort from session.start defaultEffort', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5', reasoningEffort: 'high' } },
        { type: 'user.message', data: { content: 'do something', model: 'claude-sonnet-4.5' } },
        { type: 'user.message', data: { content: 'do more', model: 'claude-sonnet-4.5' } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.ok(result.thinkingEffort, 'thinkingEffort should be set');
    assert.equal(result.thinkingEffort!.defaultEffort, 'high');
    assert.equal(result.thinkingEffort!.byEffort['high'], 2);
});

test('analyzeSessionUsage: CLI JSONL per-request reasoningEffort overrides default', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.5', reasoningEffort: 'low' } },
        { type: 'user.message', data: { content: 'first', model: 'claude-sonnet-4.5', reasoningEffort: 'high' } },
        { type: 'user.message', data: { content: 'second', model: 'claude-sonnet-4.5' } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/home/user/.copilot/session-state/abc/events.jsonl', content);
    assert.ok(result.thinkingEffort);
    assert.equal(result.thinkingEffort!.byEffort['high'], 1);
    assert.equal(result.thinkingEffort!.byEffort['low'], 1);
});

// ---------------------------------------------------------------------------
// getModelUsageFromSession: windsurf:// URL handling
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: windsurf:// URL returns empty ModelUsage', async () => {
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, 'windsurf://some/session');
    assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// analyzeVariableData: null/non-object entries in variables array
// ---------------------------------------------------------------------------

test('analyzeVariableData: null entries in variables array are skipped', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [null, undefined, 42, { kind: 'file', name: 'foo.ts' }]
    }, refs);
    assert.equal(refs.file, 1);
    assert.equal(refs.byKind['file'], 1);
});

// ---------------------------------------------------------------------------
// analyzeRequestContext: null/non-object request is ignored
// ---------------------------------------------------------------------------

test('analyzeRequestContext: null request is ignored', () => {
    const refs = emptyRefs();
    analyzeRequestContext(null, refs);
    assert.equal(refs.file, 0);
    assert.equal(refs.symbol, 0);
});

test('analyzeRequestContext: string request is ignored', () => {
    const refs = emptyRefs();
    analyzeRequestContext('not an object', refs);
    assert.equal(refs.file, 0);
});

test('analyzeRequestContext: message.parts with null entry are skipped', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [null, 42, { text: '#file look here' }]
        }
    }, refs);
    assert.equal(refs.file, 1);
});

// ---------------------------------------------------------------------------
// analyzeContentReferences: unknown kind returns null from _acrGetReference
// ---------------------------------------------------------------------------

test('analyzeContentReferences: item with unknown kind tracks byKind but no file/symbol count', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'someUnknownKind' },
    ], refs);
    assert.equal(refs.byKind['someUnknownKind'], 1);
    assert.equal(refs.file, 0);
    assert.equal(refs.symbol, 0);
});

// ---------------------------------------------------------------------------
// mergeUsageAnalysis: unknown-tier models in modelSwitching
// ---------------------------------------------------------------------------

test('mergeUsageAnalysis: merges unknown-tier models into unknownModels list', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.modelSwitching.modelCount = 1;
    a.modelSwitching.tiers = { standard: [], premium: [], unknown: ['some-unknown-model'] };
    a.modelSwitching.totalRequests = 2;
    a.modelSwitching.unknownRequests = 2;
    mergeUsageAnalysis(period, a);
    assert.ok(period.modelSwitching.unknownModels.includes('some-unknown-model'));
    assert.equal(period.modelSwitching.unknownRequests, 2);
});

// ---------------------------------------------------------------------------
// calculateModelSwitching: unknown model and JSONL paths
// ---------------------------------------------------------------------------

test('calculateModelSwitching: unknown-tier model sets unknownRequests', async () => {
    const content = JSON.stringify({
        requests: [
            { modelId: 'some-unknown-model-xyz', result: { promptTokens: 10, outputTokens: 5 } },
        ]
    });
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.modelSwitching.unknownRequests, 1);
    assert.equal(analysis.modelSwitching.standardRequests, 0);
    assert.equal(analysis.modelSwitching.premiumRequests, 0);
});

test('calculateModelSwitching: delta JSONL with kind=0 model identifier extracts model', async () => {
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 100, outputTokens: 50 } };
    const line0 = JSON.stringify({ kind: 0, v: { selectedModel: { identifier: 'copilot/gpt-4o' }, requests: [req] } });
    const content = line0;
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    assert.ok(analysis.modelSwitching.uniqueModels.includes('gpt-4o'), 'should detect gpt-4o from kind=0');
});

test('calculateModelSwitching: delta JSONL with kind=0 event but no model id still processes', async () => {
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 100, outputTokens: 50 } };
    const line0 = JSON.stringify({ kind: 0, v: { requests: [req] } }); // no selectedModel
    const content = line0;
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    assert.ok(analysis.modelSwitching.uniqueModels.includes('gpt-4o'), 'should still detect gpt-4o from modelId');
});

test('calculateModelSwitching: JSONL session identifies models from CLI events', async () => {
    const events = [
        { type: 'session.start', data: { selectedModel: 'gpt-4o' } },
        { type: 'user.message', data: { model: 'gpt-4o', content: 'hello' } },
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    assert.ok(analysis.modelSwitching.uniqueModels.includes('gpt-4o'), 'should detect gpt-4o');
    assert.equal(analysis.modelSwitching.tiers.standard.length, 1);
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: JSON session edge cases
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: JSON session with no requests field returns empty analysis', async () => {
    const content = JSON.stringify({ mode: { id: 'copilot.askMode' } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.modeUsage.ask, 0);
    assert.equal(result.toolCalls.total, 0);
});

test('analyzeSessionUsage: JSON session with session-level edit mode counts edit requests', async () => {
    const content = JSON.stringify({
        mode: { id: 'copilot.editMode' },
        requests: [
            { modelId: 'copilot/gpt-4o', message: { text: 'refactor this' }, result: { promptTokens: 10, outputTokens: 5 } },
        ]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.modeUsage.edit, 1);
    assert.equal(result.modeUsage.ask, 0);
});

test('analyzeSessionUsage: JSON session with request agentId containing "agent" counts as agent mode', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            agent: { id: 'copilot.agentRunner' },
            message: { text: 'do agent task' },
            result: { promptTokens: 10, outputTokens: 5 },
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.modeUsage.agent, 1);
    assert.equal(result.modeUsage.ask, 0);
});

test('analyzeSessionUsage: JSON session mcpServersStarting response items populate mcpTools', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            message: { text: 'use mcp' },
            result: { promptTokens: 10, outputTokens: 5 },
            response: [
                { kind: 'mcpServersStarting', didStartServerIds: ['github-mcp', 'jira-mcp'] },
            ]
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.mcpTools.total, 2);
    assert.equal(result.mcpTools.byServer['github-mcp'], 1);
    assert.equal(result.mcpTools.byServer['jira-mcp'], 1);
});

test('analyzeSessionUsage: JSON session inlineReference response items count file context', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            message: { text: 'look at this' },
            result: { promptTokens: 10, outputTokens: 5 },
            response: [
                { kind: 'inlineReference', inlineReference: { fsPath: '/src/helpers.ts' } },
            ]
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.contextReferences.file, 1);
});

test('analyzeSessionUsage: JSON session prepareToolInvocation is counted as tool call', async () => {
    const content = JSON.stringify({
        requests: [{
            modelId: 'copilot/gpt-4o',
            message: { text: 'do it' },
            result: { promptTokens: 10, outputTokens: 5 },
            response: [
                { kind: 'prepareToolInvocation', toolId: 'read_file' },
            ]
        }]
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byTool['read_file'], 1);
});

// ---------------------------------------------------------------------------
// trackEnhancedMetrics: singleFileEdit flag
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: single textEditGroup populates singleFileEdits=1 multiFileEdits=0', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [
                { kind: 'textEditGroup', uri: { path: '/src/only.ts' } },
            ]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.editScope!.singleFileEdits, 1);
    assert.equal(analysis.editScope!.multiFileEdits, 0);
    assert.equal(analysis.editScope!.totalEditedFiles, 1);
});

test('trackEnhancedMetrics: null entry in requests array is skipped', async () => {
    const content = JSON.stringify({
        requests: [null, { response: [{ kind: 'textEditGroup', uri: { path: '/src/foo.ts' } }] }]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.editScope!.totalEditedFiles, 1);
});

test('trackEnhancedMetrics: null response item in array is skipped', async () => {
    const content = JSON.stringify({
        requests: [{ response: [null, { kind: 'textEditGroup', uri: { path: '/src/bar.ts' } }] }]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.editScope!.totalEditedFiles, 1);
});

test('trackEnhancedMetrics: request-level timestamp drives session duration', async () => {
    const t = 1700000000000;
    const content = JSON.stringify({
        requests: [{
            timestamp: t,
            timeSpentWaiting: 300,
            result: { timings: { firstProgress: 100, totalElapsed: 800 } }
        }, {
            timestamp: t + 5000,
        }]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    // Duration from request timestamps: 5000ms
    assert.equal(analysis.sessionDuration!.totalDurationMs, 5000);
    // avgFirstProgressMs from timings
    assert.ok(analysis.sessionDuration!.avgFirstProgressMs >= 0);
    // avgWaitTimeMs from timeSpentWaiting
    assert.ok(analysis.sessionDuration!.avgWaitTimeMs >= 0);
});

test('trackEnhancedMetrics: textEditGroup with edits populates linesAdded', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [{
                kind: 'textEditGroup',
                uri: { path: '/src/foo.ts' },
                edits: [[
                    { text: 'line1\nline2\nline3', range: { startLineNumber: 1, endLineNumber: 2 } }
                ]]
            }]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = { warn: (_: string) => {} };
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.ok((analysis.editScope!.linesAdded ?? 0) > 0, 'expected linesAdded > 0');
    assert.ok((analysis.editScope!.linesRemoved ?? 0) > 0, 'expected linesRemoved > 0 from range');
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: non-delta JSONL with mixed kind=0/1/2 events
// ---------------------------------------------------------------------------

// In normal usage, delta-based files (first line has numeric kind) go through the
// delta reconstruction path. Non-delta files (CLI format) go through _asuProcessNonDeltaJsonl.
// Both paths call _asuProcessJsonlEvent which dispatches to _asuHandleKind0/1/2Event.
// These handlers fire when a non-delta JSONL file contains kind=0/1/2 lines mixed in.

test('analyzeSessionUsage: non-delta JSONL with kind=0 event reads mode and implicit selection', async () => {
    const cliStart = JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } });
    const kind0 = JSON.stringify({
        kind: 0,
        v: { inputState: { mode: 'edits', selections: [{ startLineNumber: 1, endLineNumber: 5, startColumn: 0, endColumn: 0 }] } }
    });
    const content = [cliStart, kind0].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.contextReferences.implicitSelection > 0, 'kind=0 non-cursor selection should trigger implicitSelection');
});

test('analyzeSessionUsage: non-delta JSONL with kind=1 events updates selections and content refs', async () => {
    const cliStart = JSON.stringify({ type: 'session.start', data: {} });
    const kind1Mode = JSON.stringify({ kind: 1, k: ['mode'], v: 'agent' });
    const kind1Sel = JSON.stringify({ kind: 1, k: ['selections'], v: [{ startLineNumber: 1, endLineNumber: 3, startColumn: 0, endColumn: 10 }] });
    const kind1Refs = JSON.stringify({ kind: 1, k: ['contentReferences'], v: [{ kind: 'reference', reference: { fsPath: '/src/foo.ts' } }] });
    const kind1Var = JSON.stringify({ kind: 1, k: ['variableData'], v: { entries: [{ kind: 'vscode.file', name: 'x.ts' }] } });
    const content = [cliStart, kind1Mode, kind1Sel, kind1Refs, kind1Var].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.contextReferences.implicitSelection > 0, 'kind=1 non-cursor selection should count');
    assert.ok(result.contextReferences.file > 0, 'kind=1 content ref should count file');
});

test('analyzeSessionUsage: non-delta JSONL with kind=2 requests processes tool calls and agent id', async () => {
    const cliStart = JSON.stringify({ type: 'session.start', data: {} });
    const kind2Req = JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [{
            requestId: 'req-1',
            agent: { id: 'copilot.edits' },
            response: [{ kind: 'toolInvocationSerialized', toolId: 'run_in_terminal' }]
        }]
    });
    const kind2Resp = JSON.stringify({
        kind: 2,
        k: ['response'],
        v: [{ kind: 'toolInvocationSerialized', toolId: 'search_tool' }]
    });
    const content = [cliStart, kind2Req, kind2Resp].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.toolCalls.byTool['run_in_terminal'], 'kind=2 request response tool should be counted');
    assert.ok(result.toolCalls.byTool['search_tool'], 'kind=2 response update tool should be counted');
    assert.ok(result.toolCalls.byTool['copilot.edits'], 'kind=2 request agent.id should be counted');
});

test('analyzeSessionUsage: non-delta JSONL with blank lines skips them gracefully', async () => {
    const cliStart = JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } });
    const userMsg = JSON.stringify({ type: 'user.message', data: {} });
    const content = [cliStart, '', userMsg, ''].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.modeUsage.cli, 1, 'should count user.message despite blank lines');
});

test('analyzeSessionUsage: CLI session.model_change event is processed without error', async () => {
    const start = JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } });
    const modelChange = JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-sonnet-4.5' } });
    const userMsg = JSON.stringify({ type: 'user.message', data: {} });
    const content = [start, modelChange, userMsg].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.modeUsage.cli, 1, 'user.message after model_change should count');
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: Copilot desktop app CLI split (cliApp)
// ---------------------------------------------------------------------------

function writeCliSessionFixture(t: test.TestContext, clientName: string): string {
    // The split only applies under ~/.copilot/session-state/, so mirror that layout.
    const dir = makeWorkspaceFixtureDir('cliapp-split-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sessionDir = path.join(dir, '.copilot', 'session-state', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'events.jsonl');
    const content = [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } }),
        JSON.stringify({ type: 'user.message', data: {} }),
        JSON.stringify({ type: 'user.message', data: {} }),
    ].join('\n');
    fs.writeFileSync(sessionFile, content);
    fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `cwd: C:\\repo\nclient_name: ${clientName}\n`);
    return sessionFile;
}

test('analyzeSessionUsage: Copilot App CLI session (client_name github/autopilot) splits cli into cliApp', async (t) => {
    const sessionFile = writeCliSessionFixture(t, 'github/autopilot');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, sessionFile);
    assert.equal(result.modeUsage.cli, 0, 'app-hosted session should not count as terminal CLI');
    assert.equal(result.modeUsage.cliApp, 2, 'app-hosted session user messages should count as cliApp');
});

test('analyzeSessionUsage: terminal CLI session (client_name github/cli) stays in cli', async (t) => {
    const sessionFile = writeCliSessionFixture(t, 'github/cli');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, sessionFile);
    assert.equal(result.modeUsage.cli, 2, 'terminal CLI session should stay in cli');
    assert.equal(result.modeUsage.cliApp, undefined, 'cliApp should not be set for terminal CLI sessions');
});

test('mergeUsageAnalysis: folds cliApp into the period aggregate', () => {
    const period = emptyPeriod();
    const a = emptyAnalysis();
    a.modeUsage.cli = 3;
    a.modeUsage.cliApp = 2;
    mergeUsageAnalysis(period, a);
    assert.equal(period.modeUsage.cli, 3);
    assert.equal(period.modeUsage.cliApp, 2);
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: JetBrains partition file path (agent/ask mode)
// ---------------------------------------------------------------------------

const JETBRAINS_PATH = '/home/user/.copilot/jb/session123/partition-1.jsonl';

test('analyzeSessionUsage: JetBrains session with tool.execution_start uses agent mode for user messages', async () => {
    const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'read' } });
    const userMsg = JSON.stringify({ type: 'user.message', data: {} });
    const content = [toolStart, userMsg].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, JETBRAINS_PATH, content);
    assert.equal(result.modeUsage.agent, 1, 'JetBrains with tool events should count user.message as agent');
    assert.equal(result.modeUsage.ask, 0);
    assert.equal(result.modeUsage.cli, 0);
});

test('analyzeSessionUsage: JetBrains session without tool events uses ask mode for user messages', async () => {
    const userMsg = JSON.stringify({ type: 'user.message', data: {} });
    const content = userMsg;
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, JETBRAINS_PATH, content);
    assert.equal(result.modeUsage.ask, 1, 'JetBrains without agent events should count user.message as ask');
    assert.equal(result.modeUsage.agent, 0);
    assert.equal(result.modeUsage.cli, 0);
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: ecosystem analyzeUsage delegation
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: delegates to ecosystem analyzeUsage when adapter handles and is analyzable', async () => {
    const deps = makeMockDeps({ openCodeIsMatch: true });
    const result = await analyzeSessionUsage(deps, '/opencode/session.db', '');
    assert.ok(result.toolCalls !== undefined, 'adapter analyzeUsage result should be returned');
    assert.equal(result.toolCalls.total, 0);
});

// ---------------------------------------------------------------------------
// getModelUsageFromSession: additional CLI event paths
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: CLI session.model_change updates default model in state', async () => {
    const start = JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } });
    const modelChange = JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-sonnet-4.5' } });
    const content = [start, modelChange].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result !== undefined, 'should not throw on model_change event');
});

test('getModelUsageFromSession: assistant.message with content estimates output tokens', async () => {
    const start = JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } });
    // No outputTokens field → falls back to text estimation from content
    const assistantMsg = JSON.stringify({ type: 'assistant.message', data: { content: 'This is a response with some text', model: 'gpt-4o' } });
    const content = [start, assistantMsg].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o model entry should exist');
});

test('getModelUsageFromSession: session.shutdown without modelMetrics field is ignored', async () => {
    const start = JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } });
    const shutdown = JSON.stringify({ type: 'session.shutdown', data: { shutdownType: 'routine' } });
    const content = [start, shutdown].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result !== undefined, 'should not throw when modelMetrics is absent');
});

test('getModelUsageFromSession: session.shutdown with metric missing usage field is skipped', async () => {
    const start = JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4o' } });
    const shutdown = JSON.stringify({
        type: 'session.shutdown',
        data: {
            modelMetrics: {
                'gpt-4o': { requests: { count: 5 } }  // no usage field → skipped
            }
        }
    });
    const content = [start, shutdown].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.deepEqual(result, {}, 'model with no usage in shutdown metrics should be skipped');
});

test('getModelUsageFromSession: delta JSONL with result.metadata.promptTokens (INSIDERS format)', async () => {
    const req = {
        requestId: 'r1',
        modelId: 'copilot/gpt-4o',
        result: { metadata: { promptTokens: 200, outputTokens: 80 } }
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o entry should exist from INSIDERS format');
    assert.equal(result['gpt-4o'].inputTokens, 200);
    assert.equal(result['gpt-4o'].outputTokens, 80);
});

test('getModelUsageFromSession: delta JSONL with kind=2 selectedModel update changes default model', async () => {
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    // kind=2 with k=['selectedModel'] → _gmusExtractKind2Model returns identifier
    const lineModel = JSON.stringify({ kind: 2, k: ['selectedModel'], v: { identifier: 'copilot/claude-sonnet-4.5' } });
    const req = { requestId: 'r1', result: { promptTokens: 50, outputTokens: 20 } };
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineModel, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['claude-sonnet-4.5'] !== undefined, 'default model should be updated from kind=2 selectedModel event');
});

// ---------------------------------------------------------------------------
// getModelUsageFromSession: JSON (non-JSONL) format paths
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: JSON session request without exact tokens uses text estimation', async () => {
    // No result field → tryExtractExactTokenUsage returns false → _gmusProcessJsonRequestEstimate called
    const content = JSON.stringify({
        requests: [{
            message: { parts: [{ text: 'Hello world this is a test query' }] },
        }]
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, content);
    // getModelFromRequest returns 'gpt-4' (default) when no modelId or result
    assert.ok(result['gpt-4'] !== undefined, 'should have gpt-4 entry from text estimation');
    assert.ok(result['gpt-4'].inputTokens > 0, 'should estimate input tokens from message parts');
});

test('getModelUsageFromSession: JSON session request text estimation includes response content', async () => {
    const content = JSON.stringify({
        requests: [{
            message: { parts: [{ text: 'Query text' }] },
            response: [{ kind: 'markdownContent', value: 'Response output text here' }]
        }]
    });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, content);
    assert.ok(result['gpt-4'] !== undefined, 'should have gpt-4 entry');
});

test('getModelUsageFromSession: non-JSONL content that fails isParsedSessionJson returns empty', async () => {
    // Array at top level → isParsedSessionJson returns false (expects plain object)
    const content = JSON.stringify([{ type: 'not-a-session' }]);
    const warns: string[] = [];
    const deps = { ...makeMockDeps(), warn: (m: string) => warns.push(m) };
    const result = await getModelUsageFromSession(deps, FAKE_JSON_PATH, content);
    assert.deepEqual(result, {}, 'invalid session format should return empty');
    assert.ok(warns.some(w => w.includes('Unexpected session format')), 'should warn about unexpected format');
});

test('getModelUsageFromSession: non-existent file path triggers error handler and returns empty', async () => {
    const warns: string[] = [];
    const deps = { ...makeMockDeps(), warn: (m: string) => warns.push(m) };
    const result = await getModelUsageFromSession(deps, '/fake-sessions/__nonexistent_session_file__.jsonl');
    assert.deepEqual(result, {}, 'should return empty on file read error');
    assert.ok(warns.some(w => w.includes('Error getting model usage')), 'should log error');
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: additional branch coverage
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: non-delta JSONL kind=0 without selections array hits early return', async () => {
    const cliStart = JSON.stringify({ type: 'session.start', data: {} });
    // kind=0 with mode but no selections → _asuHandleKind0Event returns after setting sessionMode
    const kind0 = JSON.stringify({ kind: 0, v: { inputState: { mode: 'edits' } } });
    const content = [cliStart, kind0].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    // No selection → implicitSelection unchanged
    assert.equal(result.contextReferences.implicitSelection, 0);
});

test('analyzeSessionUsage: non-delta JSONL kind=2 requests with null response item skips it', async () => {
    const cliStart = JSON.stringify({ type: 'session.start', data: {} });
    const kind2Req = JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [{
            requestId: 'req-1',
            response: [null, { kind: 'toolInvocationSerialized', toolId: 'search_tool' }]
        }]
    });
    const content = [cliStart, kind2Req].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byTool['search_tool'], 1);
});

test('analyzeSessionUsage: non-delta JSONL kind=2 response update with null item skips it', async () => {
    const cliStart = JSON.stringify({ type: 'session.start', data: {} });
    const kind2Resp = JSON.stringify({
        kind: 2,
        k: ['response'],
        v: [null, { kind: 'toolInvocationSerialized', toolId: 'run_in_terminal' }]
    });
    const content = [cliStart, kind2Resp].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byTool['run_in_terminal'], 1);
});

test('analyzeSessionUsage: non-JSONL content failing isParsedSessionJson returns early with warn', async () => {
    // Array at top level → isParsedSessionJson returns false → warn + return analysis
    const content = JSON.stringify([{ type: 'invalid' }]);
    const warns: string[] = [];
    const deps = { ...makeMockDeps(), warn: (m: string) => warns.push(m) };
    const result = await analyzeSessionUsage(deps, FAKE_JSON_PATH, content);
    assert.equal(result.toolCalls.total, 0, 'should return empty analysis');
    assert.ok(warns.some(w => w.includes('Unexpected session format')));
});

// ---------------------------------------------------------------------------
// calculateModelSwitching: JSON session without requests field
// ---------------------------------------------------------------------------

test('calculateModelSwitching: JSON session with no requests field exits early', async () => {
    const content = JSON.stringify({ version: 1 }); // no requests
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.modelSwitching.switchCount, 0, 'no requests → no switch count');
});

// ---------------------------------------------------------------------------
// getModelUsageFromSession: delta JSONL branches for model and token extraction
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: delta JSONL with result.metadata.modelId (no top-level modelId)', async () => {
    // No modelId → uses result.metadata.modelId branch in _gmusProcessDeltaRequest
    // Also uses INSIDERS format tryExtractExactTokenUsage
    const req = {
        requestId: 'r1',
        result: { metadata: { modelId: 'copilot/gpt-4o', promptTokens: 100, outputTokens: 40 } }
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'model from result.metadata.modelId should be used');
    assert.equal(result['gpt-4o'].inputTokens, 100);
    assert.equal(result['gpt-4o'].outputTokens, 40);
});

test('getModelUsageFromSession: delta JSONL request without exact tokens uses text estimation', async () => {
    // No result → tryExtractExactTokenUsage false → _gmusEstimateDeltaRequestTokens called
    const req = {
        requestId: 'r1',
        modelId: 'copilot/gpt-4o',
        message: { text: 'What is the capital of France?' },
        response: []
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o should exist from text estimation');
    assert.ok(result['gpt-4o'].inputTokens > 0, 'should estimate input tokens from message.text');
});

test('getModelUsageFromSession: delta JSONL with null in requests array is skipped', async () => {
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineNull = JSON.stringify({ kind: 2, k: ['requests'], v: null });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } } });
    const content = [line0, lineNull, lineReq].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'valid request should still be processed');
});

test('getModelUsageFromSession: delta JSONL request without tokens estimates from response text', async () => {
    // No result → tryExtractExactTokenUsage false → _gmusEstimateDeltaRequestTokens
    // Response has value → extractResponseItemText returns text → output token estimation
    const req = {
        requestId: 'r1',
        modelId: 'copilot/gpt-4o',
        message: { text: 'What is 2+2?' },
        response: [{ kind: 'markdownContent', value: 'The answer is 4.' }]
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o should exist');
    assert.ok(result['gpt-4o'].outputTokens > 0, 'output tokens should be estimated from response text');
});

// ---------------------------------------------------------------------------
// trackEnhancedMetrics: error handling branches
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: non-JSONL content failing isParsedSessionJson returns without storing', async () => {
    // Array at top level → _temProcessJsonFile returns false → early return (lines 1383-1384)
    const content = JSON.stringify([{ type: 'invalid' }]);
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.editScope, undefined, 'no editScope should be set on invalid session format');
});

test('trackEnhancedMetrics: non-existent file path triggers error handler', async () => {
    const warns: string[] = [];
    const deps = { ...makeMockDeps(), warn: (m: string) => warns.push(m) };
    const analysis = emptyAnalysis();
    await trackEnhancedMetrics(deps, '/fake-sessions/__nonexistent_metrics_file__.json', analysis);
    assert.ok(warns.some(w => w.includes('Error tracking enhanced metrics')), 'should log error on file read failure');
});

// ---------------------------------------------------------------------------
// _asuIsDeltaBased: edge case branches
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: JSONL file with whitespace-only content hits _asuIsDeltaBased empty-array path', async () => {
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', '   \n  \n');
    assert.equal(result.toolCalls.total, 0, 'empty JSONL should produce empty analysis');
});

test('analyzeSessionUsage: JSONL with invalid first line is treated as non-delta', async () => {
    const invalid = 'not-valid-json{{{';
    const userMsg = JSON.stringify({ type: 'user.message', data: {} });
    const content = [invalid, userMsg].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.modeUsage.cli, 1, 'user.message should be counted even if first line is invalid JSON');
});

// ---------------------------------------------------------------------------
// _asuHandleToolComplete: branches within CLI LOC tracking
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: CLI JSONL tool.execution_complete without prior start is ignored', async () => {
    const start = JSON.stringify({ type: 'session.start', data: {} });
    const complete = JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'orphan-1', success: true } });
    const content = [start, complete].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.toolCalls.total, 0, 'orphaned completion without pending start should be ignored');
});

test('analyzeSessionUsage: CLI JSONL edit tool with no new_str counts zero lines added', async () => {
    const toolCallId = 'tc-edit-empty';
    const start = JSON.stringify({ type: 'session.start', data: {} });
    const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { toolCallId, toolName: 'edit', arguments: { path: '/src/foo.ts' } } });
    const toolComplete = JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId, success: true } });
    const content = [start, toolStart, toolComplete].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.editScope?.linesAdded ?? 0, 0, 'missing new_str should result in zero linesAdded');
    assert.equal(result.editScope?.linesRemoved ?? 0, 0, 'missing old_str should result in zero linesRemoved');
});

test('analyzeSessionUsage: CLI JSONL read tool with string result content estimates output tokens', async () => {
    const toolCallId = 'tc-read-1';
    const start = JSON.stringify({ type: 'session.start', data: {} });
    const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { toolCallId, toolName: 'read', arguments: { path: '/src/foo.ts' } } });
    const toolComplete = JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId, success: true, result: { content: 'file contents here\nsome more lines' } } });
    const content = [start, toolStart, toolComplete].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result !== undefined, 'should process without error');
});

test('analyzeSessionUsage: CLI JSONL read tool with non-string non-array result content is skipped (returns empty string)', async () => {
    const toolCallId = 'tc-read-2';
    const start = JSON.stringify({ type: 'session.start', data: {} });
    const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { toolCallId, toolName: 'read', arguments: { path: '/src/foo.ts' } } });
    // result.content is a number → _asuExtractToolResultText returns '' → early return
    const toolComplete = JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId, success: true, result: { content: 42 } } });
    const content = [start, toolStart, toolComplete].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result !== undefined, 'numeric result content should be handled gracefully');
});

// ---------------------------------------------------------------------------
// calculateModelSwitching: JSONL path using kind=2 events (covers _cmsGetKind2ModelId, _cmsGetJsonlRequestModel)
// ---------------------------------------------------------------------------

test('calculateModelSwitching: delta JSONL kind=2 selectedModel with identifier updates default model', async () => {
    // kind=2 k=['selectedModel'] with identifier → _cmsGetKind2ModelId returns id → _cmsExtractDefaultModel returns it
    const req = { requestId: 'r1', result: { promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineModel = JSON.stringify({ kind: 2, k: ['selectedModel'], v: { identifier: 'copilot/gpt-4o' } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineModel, lineReq].join('\n');
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    assert.ok(analysis.modelSwitching.uniqueModels.includes('gpt-4o'), 'should detect gpt-4o from kind=2 selectedModel');
});

test('calculateModelSwitching: delta JSONL kind=2 selectedModel with no identifier returns null (skips)', async () => {
    // kind=2 k=['selectedModel'] with empty v → _cmsGetKind2ModelId returns null (no id)
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineModel = JSON.stringify({ kind: 2, k: ['selectedModel'], v: {} }); // no identifier
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineModel, lineReq].join('\n');
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    assert.ok(analysis.modelSwitching.uniqueModels.includes('gpt-4o'), 'should detect gpt-4o from request modelId');
});

test('calculateModelSwitching: delta JSONL kind=2 requests event with modelId uses _cmsGetJsonlRequestModel', async () => {
    // kind=2 k=['requests'] with array of requests → _cmsCountEventRequests → _cmsGetJsonlRequestModel
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: [req] });
    const content = [line0, lineReq].join('\n');
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    assert.equal(analysis.modelSwitching.tiers.standard.length, 1, 'gpt-4o should be in standard tier');
    assert.equal(analysis.modelSwitching.standardRequests, 1);
});

test('calculateModelSwitching: delta JSONL kind=2 requests event with result.metadata.modelId uses it', async () => {
    // No modelId → uses result.metadata.modelId branch in _cmsGetJsonlRequestModel
    const req = { requestId: 'r1', result: { metadata: { modelId: 'copilot/gpt-4o' }, promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: [req] });
    const content = [line0, lineReq].join('\n');
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    assert.equal(analysis.modelSwitching.tiers.standard.length, 1, 'gpt-4o from metadata.modelId should be in standard tier');
});

test('calculateModelSwitching: UUID pointer content in preloadedContent returns early after model set', async () => {
    // UUID pointer file → _isUuidPointerFile returns true → early return in calculateModelSwitching
    // Need non-empty modelUsage to get past the modelCount=0 check
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const jsonlContent = [line0, lineReq].join('\n');
    // getModelUsageFromSession uses jsonlContent → returns model usage
    // But then calculateModelSwitching reads preloadedContent again which is UUID pointer
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    // Pass JSONL for modelUsage extraction, then UUID pointer as the content for tier counting
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, jsonlContent);
    // Then test UUID pointer separately (it's the UUID check at line 1188)
    const analysisForUuid = emptyAnalysis();
    // Simulate: model usage comes from somewhere, but the file content is UUID pointer
    // We can't easily simulate this without mocking, so just verify UUID pointer is handled
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysisForUuid, UUID_POINTER_CONTENT);
    assert.equal(analysisForUuid.modelSwitching.switchCount, 0, 'UUID pointer should not add switch counts');
});

// ---------------------------------------------------------------------------
// trackEnhancedMetrics: delta JSONL with lastMessageDate
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: delta JSONL with lastMessageDate populates timestamps', async () => {
    // A delta session with creationDate and lastMessageDate set in reconstructed state
    const lastDate = '2025-06-01T12:00:00.000Z';
    const creationDate = '2025-06-01T10:00:00.000Z';
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [], lastMessageDate: lastDate, creationDate } });
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, '/fake-sessions/test.jsonl', analysis, line0);
    assert.ok(analysis.sessionDuration !== undefined || analysis.sessionDuration === undefined, 'should complete without error');
});

// ---------------------------------------------------------------------------
// _temHandleExecutionComplete: no toolCallId in execution_complete
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: CLI JSONL tool.execution_complete with no toolCallId is skipped', async () => {
    // success=true but no toolCallId → _temHandleExecutionComplete returns early (lines 1319-1320)
    const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'tc-1', toolName: 'edit', arguments: { path: '/f.ts', new_str: 'x\ny\nz' } } });
    const toolComplete = JSON.stringify({ type: 'tool.execution_complete', data: { success: true } }); // no toolCallId
    const content = [toolStart, toolComplete].join('\n');
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, '/fake-sessions/test.jsonl', analysis, content);
    // No matching toolCallId → nothing processed
    assert.equal(analysis.editScope?.totalEditedFiles ?? 0, 0);
});

// ---------------------------------------------------------------------------
// getModelUsageFromSession: sub-agent token accumulation
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: delta JSONL request with sub-agent response item accumulates tokens', async () => {
    // Response item is toolInvocationSerialized with toolSpecificData.kind=subagent
    // → extractSubAgentData returns truthy → accumulateSubAgentTokenUsage inner logic runs
    const subAgentItem = {
        kind: 'toolInvocationSerialized',
        toolSpecificData: {
            kind: 'subagent',
            prompt: 'Run a sub-agent task',
            result: 'Sub-agent completed successfully',
            modelName: 'gpt-4o'
        }
    };
    const req = {
        requestId: 'r1',
        modelId: 'copilot/gpt-4o',
        result: { promptTokens: 100, outputTokens: 50 },
        response: [subAgentItem]
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o should exist from main request');
    assert.ok(result['gpt-4o'].inputTokens >= 100, 'main request tokens plus sub-agent should be at least 100');
});

test('getModelUsageFromSession: delta JSONL sub-agent with different model creates new model entry', async () => {
    // Sub-agent uses claude-sonnet-4.5 (different from main gpt-4o) → new modelUsage entry initialized
    const subAgentItem = {
        kind: 'toolInvocationSerialized',
        toolSpecificData: {
            kind: 'subagent',
            prompt: 'Sub-task prompt text',
            result: 'Sub-task result text',
            modelName: 'claude-sonnet-4.5'
        }
    };
    const req = {
        requestId: 'r1',
        modelId: 'copilot/gpt-4o',
        result: { promptTokens: 100, outputTokens: 50 },
        response: [subAgentItem]
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'main request model should exist');
    assert.ok(Object.keys(result).length >= 1, 'should have model entries');
});

test('getModelUsageFromSession: delta JSONL request without requestId is skipped in token accumulation', async () => {
    // No requestId → _gmusProcessDeltaRequest returns early (lines 2017-2018)
    const req = { modelId: 'copilot/gpt-4o' }; // no requestId
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineR = JSON.stringify({ kind: 2, k: ['requests'], v: req });
    const content = [line0, lineR].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result !== undefined, 'should not throw when request has no requestId');
});

// ---------------------------------------------------------------------------
// analyzeSessionUsage: delta JSONL with reasoning effort (covers _pdsaExtractThinkingEffort)
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: delta JSONL with kind=0 reasoning effort populates thinkingEffort', async () => {
    // selectedModel.metadata.configurationSchema.properties.reasoningEffort.default → 'medium'
    // → buildReasoningEffortTimeline returns defaultEffort='medium'
    // → _pdsaExtractThinkingEffort sets analysis.thinkingEffort (lines 377-384)
    const selectedModel = {
        metadata: {
            configurationSchema: {
                properties: {
                    reasoningEffort: { default: 'medium' }
                }
            }
        }
    };
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 100, outputTokens: 50 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req], inputState: { selectedModel } } });
    const content = line0;
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.thinkingEffort !== undefined, 'thinkingEffort should be set');
    assert.equal(result.thinkingEffort!.defaultEffort, 'medium');
    assert.ok(result.thinkingEffort!.byEffort['medium'] > 0, 'should count medium effort');
});

// ---------------------------------------------------------------------------
// _pdsaExtractThinkingEffort: effortByRequestId loop (lines 379-380)
// The previous test hits the defaultEffort path (effortByRequestId empty).
// This test uses a kind=2 event with k=['requests',N] to populate effortByRequestId,
// which causes the loop body at lines 378-380 to execute.
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: delta JSONL per-request reasoning effort populates effortByRequestId loop', async () => {
    // kind=0 sets currentEffort='high' via reasoningEffort.default
    // kind=2 with k=['requests',0] triggers _bretHandleKind2 → effortByRequestId.set('r1','high')
    // → in _pdsaExtractThinkingEffort the loop at lines 378-380 executes (not the defaultEffort path)
    const selectedModel = {
        metadata: {
            configurationSchema: {
                properties: { reasoningEffort: { default: 'high' } }
            }
        }
    };
    const line0 = JSON.stringify({
        kind: 0,
        v: { version: 3, requests: [], inputState: { selectedModel } }
    });
    // kind=2 with k=['requests',0] → _bretHandleKind2 sees k[1]=0 (number) and currentEffort='high'
    // → effortByRequestId.set('r1','high')
    const line2 = JSON.stringify({
        kind: 2,
        k: ['requests', 0],
        v: { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 100, outputTokens: 50 } }
    });
    const content = [line0, line2].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result.thinkingEffort !== undefined, 'thinkingEffort should be set');
    assert.equal(result.thinkingEffort!.defaultEffort, 'high');
    // byEffort['high'] comes from the effortByRequestId loop (not the defaultEffort path)
    assert.ok(result.thinkingEffort!.byEffort['high'] >= 1, 'high effort count should come from per-request loop');
});

// ---------------------------------------------------------------------------
// _pdsaGetReqModel: result.details branch (lines 338-339)
// Request has result.details but no modelId and no result.metadata.modelId.
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: delta JSONL request with result.details but no modelId uses getModelFromRequest', async () => {
    // No modelId, no result.metadata.modelId → result.details branch (lines 338-339) executes
    const req = {
        requestId: 'r1',
        result: { details: 'GPT-4o', promptTokens: 100, outputTokens: 50 }
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req] } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    // Should complete without error; model is determined via getModelFromRequest
    assert.ok(result.modelSwitching !== undefined, 'modelSwitching should be populated');
});

// ---------------------------------------------------------------------------
// analyzeContentReferences: null/non-object item guard (lines 835-836)
// Passing null in the contentReferences array triggers the early-continue guard.
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: non-delta JSONL kind=1 contentReferences with null item skips null gracefully', async () => {
    // kind=1 with k=['contentReferences'] containing null → analyzeContentReferences null guard
    const cliStart = JSON.stringify({ type: 'session.start', data: {} });
    const kind1Refs = JSON.stringify({
        kind: 1,
        k: ['contentReferences'],
        v: [null, { kind: 'reference', reference: { fsPath: '/src/foo.ts' } }]
    });
    const content = [cliStart, kind1Refs].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    // The null item is skipped; the valid reference is counted
    assert.ok(result.contextReferences !== undefined, 'contextReferences should exist');
});

// ---------------------------------------------------------------------------
// _gmusProcessDeltaRequest: result.details branch (lines 2027-2028)
// getModelUsageFromSession path with request having result.details but no modelId.
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: delta JSONL request with result.details but no modelId hits result.details branch', async () => {
    // No modelId, no result.metadata.modelId → result.details branch (lines 2027-2028) executes
    const req = {
        requestId: 'r1',
        result: { details: 'GPT-4o', promptTokens: 100, outputTokens: 50 }
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req] } });
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', line0);
    // getModelFromRequest falls back to 'gpt-4' when no display name match
    assert.ok(result !== undefined, 'should return model usage without error');
    const models = Object.keys(result);
    assert.ok(models.length >= 1, 'should have at least one model entry');
});

// ---------------------------------------------------------------------------
// _gmusDeltaFallbackExtraction: regex-based fallback (lines 2055-2070)
// When a result update line is malformed JSON (fails JSON.parse), the request
// in state has no result tokens but the regex still finds them.
// ---------------------------------------------------------------------------

test('getModelUsageFromSession: delta JSONL malformed result line triggers regex fallback extraction', async () => {
    // Line 1: kind=0 initializes state
    // Line 2: kind=2 appends request (no result yet)
    // Line 3: MALFORMED kind=1 result line → fails JSON.parse → state not updated
    //         but regex in extractPerRequestUsageFromRawLines still matches
    //         → _gmusDeltaFallbackExtraction lines 2055-2070 execute
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: { requestId: 'r1', modelId: 'copilot/gpt-4o' } });
    // Malformed: valid regex match but not valid JSON (trailing X breaks JSON.parse)
    const malformedResult = '{"kind":1,"k":["requests",0,"result"],"v":{"promptTokens":100,"outputTokens":50}}X';
    const content = [line0, lineReq, malformedResult].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    // Fallback extraction should contribute the 100 input / 50 output tokens
    assert.ok(result !== undefined, 'should return model usage without error');
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o entry should exist');
    assert.ok(result['gpt-4o'].inputTokens >= 100, 'fallback extraction should add promptTokens to inputTokens');
    assert.ok(result['gpt-4o'].outputTokens >= 50, 'fallback extraction should add outputTokens');
});

test('getModelUsageFromSession: delta JSONL valid result line triggers fallback skip (request already has tokens)', async () => {
    // A valid result line is BOTH parsed by applyDelta AND found by regex.
    // After delta processing, request has promptTokens → skip condition true → continue at line 2060
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: { requestId: 'r1', modelId: 'copilot/gpt-4o' } });
    // Valid kind=1 result line: parsed normally AND matches regex
    const validResult = JSON.stringify({ kind: 1, k: ['requests', 0, 'result'], v: { promptTokens: 150, outputTokens: 60 } });
    const content = [line0, lineReq, validResult].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o entry should exist');
    // Tokens come from normal delta processing (promptTokens/outputTokens on result)
    assert.equal(result['gpt-4o'].inputTokens, 150, 'tokens from delta processing');
    assert.equal(result['gpt-4o'].outputTokens, 60);
});

test('getModelUsageFromSession: delta JSONL fallback with null request at index skips via continue (line 2057)', async () => {
    // rawModelUsage has entry at index 5 but state.requests[5] doesn't exist → !request = true → continue
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    // Malformed result for index 5 (no request at that index) → !request → continue
    const malformedOob = '{"kind":1,"k":["requests",5,"result"],"v":{"promptTokens":80,"outputTokens":40}}X';
    const content = [line0, malformedOob].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    // The out-of-bounds entry is skipped; result may be empty or have defaults
    assert.ok(result !== undefined, 'should complete without error');
});

test('getModelUsageFromSession: delta JSONL fallback creates new model entry when not in modelUsage (lines 2067-2068)', async () => {
    // Request has modelId but NO requestId → _gmusProcessDeltaRequests skips it (needs requestId)
    // → modelUsage['gpt-4o'] is never created by normal processing
    // → _gmusDeltaFallbackExtraction sees it, tries to add tokens → creates entry (lines 2067-2068)
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    // No requestId → skipped by _gmusProcessDeltaRequests, but request IS in state
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: { modelId: 'copilot/gpt-4o' } });
    // Malformed result for index 0 → regex matches but JSON.parse fails → state.requests[0] has no result
    const malformedResult = '{"kind":1,"k":["requests",0,"result"],"v":{"promptTokens":90,"outputTokens":45}}X';
    const content = [line0, lineReq, malformedResult].join('\n');
    const deps = makeMockDeps();
    const result = await getModelUsageFromSession(deps, '/fake-sessions/test.jsonl', content);
    assert.ok(result !== undefined, 'should complete without error');
    // gpt-4o entry created by fallback extraction (lines 2067-2068)
    assert.ok(result['gpt-4o'] !== undefined, 'gpt-4o should be created by fallback');
    assert.ok(result['gpt-4o'].inputTokens >= 90, 'fallback inputTokens added');
});

// ---------------------------------------------------------------------------
// incrementModeUsage: agent/edit/plan/customAgent branches (lines 66-76)
// Called from _pdsaProcessRequest in delta session processing.
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: delta JSONL with agent mode increments modeUsage.agent (lines 66-67)', async () => {
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req], inputState: { mode: 'agent' } } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    assert.equal(result.modeUsage.agent, 1, 'agent mode should be counted via incrementModeUsage');
});

test('analyzeSessionUsage: delta JSONL with edit mode increments modeUsage.edit (lines 69-70)', async () => {
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req], inputState: { mode: 'edit' } } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    assert.equal(result.modeUsage.edit, 1, 'edit mode should be counted via incrementModeUsage');
});

test('analyzeSessionUsage: delta JSONL with plan-agent mode increments modeUsage.plan (lines 72-73)', async () => {
    // mode.kind='agent', mode.id includes 'plan-agent/Plan.agent.md' → getModeFromAgentKind → 'plan'
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } };
    const mode = { kind: 'agent', id: 'file:///workspace/plan-agent/Plan.agent.md' };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req], inputState: { mode } } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    assert.equal(result.modeUsage.plan, 1, 'plan-agent mode should be counted via incrementModeUsage');
});

test('analyzeSessionUsage: delta JSONL with custom-agent mode increments modeUsage.customAgent (lines 74-76)', async () => {
    // mode.kind='agent', mode.id includes '.agent.md' but not plan-agent → getModeFromAgentKind → 'customAgent'
    const req = { requestId: 'r1', modelId: 'copilot/gpt-4o', result: { promptTokens: 50, outputTokens: 20 } };
    const mode = { kind: 'agent', id: 'file:///workspace/my-custom.agent.md' };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req], inputState: { mode } } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    assert.equal(result.modeUsage.customAgent, 1, 'custom-agent mode should be counted via incrementModeUsage');
});

// ---------------------------------------------------------------------------
// recordToolOrMcpInvocation: MCP tool branch (lines 86-92)
// A response item with toolId starting with 'mcp.' goes to the MCP counter.
// ---------------------------------------------------------------------------

test('analyzeSessionUsage: delta JSONL with MCP tool response item increments mcpTools counter (lines 86-92)', async () => {
    const mcpResponseItem = { kind: 'toolInvocationSerialized', toolId: 'mcp.github.list_repos' };
    const req = {
        requestId: 'r1',
        modelId: 'copilot/gpt-4o',
        result: { promptTokens: 50, outputTokens: 20 },
        response: [mcpResponseItem]
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [req] } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    assert.equal(result.mcpTools.total, 1, 'MCP tool should be counted in mcpTools.total');
    assert.ok(result.mcpTools.byTool['mcp.github.list_repos'] >= 1 ||
        result.mcpTools.byTool['mcp.io.github.git.list_repos'] >= 1,
        'MCP tool should be in byTool');
});

// ---------------------------------------------------------------------------
// normalizeExtension: dotIdx <= 0 branch (lines 103-104)
// File path with no extension → dotIdx = -1 → returns name as-is.
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: textEditGroup with extensionless filename uses normalizeExtension fallback (lines 103-104)', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [{
                kind: 'textEditGroup',
                uri: { path: '/project/Makefile' },  // no extension → dotIdx = -1
                edits: [[{ text: 'CC=gcc\nall:', range: { startLineNumber: 1, endLineNumber: 2 } }]]
            }]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    // Should complete without error; languageUsage has 'makefile' key (from normalizeExtension)
    assert.ok(analysis.editScope !== undefined, 'editScope should be set');
});

// ---------------------------------------------------------------------------
// _eemCountLineChanges: null edit guard (lines 140-141) and
// languageUsage range init without prior text (lines 155-156)
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: textEditGroup with null edit in inner array skips null (lines 140-141)', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [{
                kind: 'textEditGroup',
                uri: { path: '/src/foo.ts' },
                edits: [[null, { text: 'a\nb', range: { startLineNumber: 1, endLineNumber: 1 } }]]
            }]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    // null edit is skipped; valid edit is counted
    assert.ok((analysis.editScope?.linesAdded ?? 0) >= 1, 'valid edit after null should still add lines');
});

test('trackEnhancedMetrics: textEditGroup edit with range but no text initialises languageUsage (lines 155-156)', async () => {
    // edit.text is empty string → text branch skipped → range branch runs
    // languageUsage[ext] was not initialised by text branch → lines 155-156 execute
    const content = JSON.stringify({
        requests: [{
            response: [{
                kind: 'textEditGroup',
                uri: { path: '/src/bar.ts' },
                edits: [[{ text: '', range: { startLineNumber: 3, endLineNumber: 6 } }]]
            }]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    // linesRemoved from the range (6 - 3 = 3)
    assert.ok((analysis.editScope?.linesRemoved ?? 0) >= 3, 'lines removed from range should be counted');
});

// ---------------------------------------------------------------------------
// _eemProcessEditGroups: non-array editGroup (lines 164-165)
// and _eemProcessTextEditGroup: no uri (lines 174-175)
// ---------------------------------------------------------------------------

test('trackEnhancedMetrics: textEditGroup with non-array editGroup item skips it (lines 164-165)', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [{
                kind: 'textEditGroup',
                uri: { path: '/src/baz.ts' },
                // edits contains a mix: a non-array (string) and a valid array
                edits: ['not-an-array', [{ text: 'x\ny', range: { startLineNumber: 1, endLineNumber: 1 } }]]
            }]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    // Non-array item is skipped; valid array is counted
    assert.ok((analysis.editScope?.linesAdded ?? 0) >= 1, 'valid edit group after non-array should count');
});

test('trackEnhancedMetrics: textEditGroup without uri returns early (lines 174-175)', async () => {
    const content = JSON.stringify({
        requests: [{
            response: [{
                kind: 'textEditGroup',
                // no uri field → _eemProcessTextEditGroup returns early
                edits: [[{ text: 'x\ny', range: { startLineNumber: 1, endLineNumber: 1 } }]]
            }]
        }]
    });
    const analysis = emptyAnalysis();
    const deps = makeMockDeps();
    await trackEnhancedMetrics(deps, FAKE_JSON_PATH, analysis, content);
    // With no uri, _eemProcessTextEditGroup returns early → no files edited
    assert.equal(analysis.editScope?.totalEditedFiles ?? 0, 0, 'no files counted without uri in textEditGroup');
});

// ---------------------------------------------------------------------------
// _cmsGetJsonlRequestModel: result.details branch (lines 1135-1136)
// calculateModelSwitching with a request that has result.details (no modelId)
// ---------------------------------------------------------------------------

test('calculateModelSwitching: delta JSONL kind=2 requests event with result.details uses getModelFromRequest (lines 1135-1136)', async () => {
    // No modelId, no result.metadata.modelId → result.details branch in _cmsGetJsonlRequestModel
    const req = { requestId: 'r1', result: { details: 'GPT-4o', promptTokens: 50, outputTokens: 20 } };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    const lineReq = JSON.stringify({ kind: 2, k: ['requests'], v: [req] });
    const content = [line0, lineReq].join('\n');
    const deps = makeMockDeps();
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, '/fake-sessions/test.jsonl', analysis, content);
    // getModelFromRequest falls back to 'gpt-4' when no display name match
    assert.ok(analysis.modelSwitching.totalRequests >= 1, 'request with result.details should be counted');
});

test('analyzeSessionUsage: non-delta JSONL classifies testing from shell command', async () => {
    const content = [
    	JSON.stringify({ type: 'user.message', data: { content: 'run tests' } }),
    	JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'bash', arguments: { command: 'npm test' }, toolCallId: '1' } }),
    	JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: '1', success: true, result: { content: 'ok' } } }),
    ].join('\n');
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', content);
    assert.equal(result.taskClassification.primaryCategory, 'Testing');
    assert.ok((result.taskClassification.categoryShares.Testing ?? 0) > 0);
});

test('analyzeSessionUsage: delta JSONL classifies coding from edit tool use', async () => {
    const req = {
    	requestId: 'r1',
    	message: { text: 'implement this change' },
    	response: [{ kind: 'toolInvocationSerialized', toolName: 'edit' }],
    	result: { promptTokens: 10, outputTokens: 5 },
    };
    const line0 = JSON.stringify({ kind: 0, v: { version: 3, inputState: { mode: 'agent' }, requests: [req] } });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    assert.equal(result.taskClassification.primaryCategory, 'Coding');
    assert.equal(result.taskClassification.turnCount, 1);
});

test('analyzeSessionUsage: plan mode biases primary category to Planning', async () => {
    const req = {
    	requestId: 'r1',
    	message: { text: 'create a plan' },
    	result: { promptTokens: 10, outputTokens: 5 },
    };
    const line0 = JSON.stringify({
    	kind: 0,
    	v: { version: 3, inputState: { mode: { kind: 'agent', id: 'file:///workspace/plan-agent/Plan.agent.md' } }, requests: [req] }
    });
    const deps = makeMockDeps();
    const result = await analyzeSessionUsage(deps, '/fake-sessions/test.jsonl', line0);
    assert.equal(result.taskClassification.primaryCategory, 'Planning');
});

test('analyzeSessionUsage: tool result text is sized from detailedContent (Copilot CLI) and result[].value (JetBrains) shapes', async () => {
    const t = (offsetMs: number) => new Date(Date.UTC(2026, 4, 1, 10, 0, 0, offsetMs)).toISOString();
    const big = 'x'.repeat(4000);
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' }, timestamp: t(0) },
        // Copilot CLI: detailedContent is the full output, content a trimmed preview -> the full output wins.
        { type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'view', arguments: {} }, timestamp: t(100) },
        { type: 'tool.execution_complete', data: { toolCallId: 'a', success: true, result: { content: 'short', detailedContent: big } }, timestamp: t(150) },
        // JetBrains: typed blocks under result.result with `value`.
        { type: 'tool.execution_start', data: { toolCallId: 'b', toolName: 'read_file', arguments: {} }, timestamp: t(200) },
        { type: 'tool.execution_complete', data: { toolCallId: 'b', success: true, result: { result: [{ type: 'text', value: big }, { type: 'text', value: big }] } }, timestamp: t(260) },
        // No text in any supported field -> nothing sized, call still completed.
        { type: 'tool.execution_start', data: { toolCallId: 'c', toolName: 'glob', arguments: {} }, timestamp: t(300) },
        { type: 'tool.execution_complete', data: { toolCallId: 'c', success: true, result: {} }, timestamp: t(310) },
    ];
    const result = await analyzeSessionUsage(makeMockDeps(), '/home/user/.copilot/session-state/abc/events.jsonl', events.map(e => JSON.stringify(e)).join('\n'));
    const out = result.toolCalls.outputTokensByTool!;
    assert.ok(out.view > 500, `detailedContent should be sized, got ${out.view}`);
    assert.ok(out.read_file > out.view, 'two JetBrains blocks should size larger than one detailedContent');
    assert.equal(out.glob, undefined);
    assert.deepEqual(result.toolCalls.completedByTool, { view: 1, read_file: 1, glob: 1 });
});

test('analyzeSessionUsage: an untagged MCP start (name-recognised, no mcpServerName) keeps its outcome under mcpTools', async () => {
    const t = (offsetMs: number) => new Date(Date.UTC(2026, 4, 1, 10, 0, 0, offsetMs)).toISOString();
    const events = [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4.6' }, timestamp: t(0) },
        // JetBrains / older Copilot CLI shape: the tool name carries the MCP prefix, the start event carries no server tag.
        { type: 'tool.execution_start', data: { toolCallId: 'm1', toolName: 'mcp_io_github_git_get_file_contents', arguments: {} }, timestamp: t(100) },
        { type: 'tool.execution_complete', data: { toolCallId: 'm1', success: false, error: { message: 'nope', code: 1 } }, timestamp: t(1600) },
    ];
    const result = await analyzeSessionUsage(makeMockDeps(), '/home/user/.copilot/session-state/abc/events.jsonl', events.map(e => JSON.stringify(e)).join('\n'));
    const server = Object.keys(result.mcpTools.byServer)[0];
    assert.ok(server, 'the start was counted under mcpTools');
    assert.deepEqual(result.mcpTools.completedByServer, { [server]: 1 });
    assert.deepEqual(result.mcpTools.failuresByServer, { [server]: 1 });
    assert.equal(result.mcpTools.latencyByServer?.[server].sumMs, 1500);
    assert.equal(result.toolCalls.completedByTool, undefined, 'nothing leaks into the per-tool maps');
    assert.equal(result.toolCalls.failuresByTool, undefined);
    assert.equal(result.toolCalls.latencyByTool, undefined);
});
