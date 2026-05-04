import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    mergeUsageAnalysis,
    analyzeContextReferences,
    analyzeContentReferences,
    analyzeVariableData,
    analyzeRequestContext,
    calculateModelSwitching,
    trackEnhancedMetrics,
    analyzeSessionUsage,
    getModelUsageFromSession,
    deriveConversationPatterns,
    type UsageAnalysisDeps,
} from '../../src/usageAnalysis';
import type {
    UsageAnalysisPeriod,
    SessionUsageAnalysis,
    ContextReferenceUsage,
} from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyRefs(): ContextReferenceUsage {
    return {
        file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
        workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0,
        terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0,
        problemsPanel: 0, pullRequest: 0, byKind: {}, byPath: {}, copilotInstructions: 0, agentsMd: 0,
    };
}

function emptyAnalysis(): SessionUsageAnalysis {
    return {
        toolCalls: { total: 0, byTool: {} },
        modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
        contextReferences: emptyRefs(),
        mcpTools: { total: 0, byServer: {}, byTool: {} },
        modelSwitching: {
            uniqueModels: [], modelCount: 0, switchCount: 0,
            tiers: { standard: [], premium: [], unknown: [] },
            hasMixedTiers: false,
            standardRequests: 0, premiumRequests: 0, unknownRequests: 0, totalRequests: 0,
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
        },
        repositories: [], repositoriesWithCustomization: [],
        editScope: { singleFileEdits: 0, multiFileEdits: 0, totalEditedFiles: 0, avgFilesPerSession: 0 },
        applyUsage: { totalApplies: 0, totalCodeBlocks: 0, applyRate: 0 },
        sessionDuration: { totalDurationMs: 0, avgDurationMs: 0, avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0 },
        conversationPatterns: { multiTurnSessions: 0, singleTurnSessions: 0, avgTurnsPerSession: 0, maxTurnsInSession: 0 },
        agentTypes: { editsAgent: 0, defaultAgent: 0, workspaceAgent: 0, other: 0 },
    };
}

// Minimal mock deps factory for file-based async functions
function makeMockDeps(overrides: Partial<{
    openCodeIsMatch: boolean;
    openCodeModelUsage: () => Promise<Record<string, { inputTokens: number; outputTokens: number }>>;
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
                modelSwitching: { uniqueModels: [], modelCount: 0, switchCount: 0, totalRequests: 0, hasMixedTiers: false, tiers: { standard: [], premium: [], unknown: [] }, standardRequests: 0, premiumRequests: 0, unknownRequests: 0 },
            }),
        });
    }
    return {
        warn: () => {},
        ecosystems,
        tokenEstimators: { 'gpt-4o': 0.25, 'claude-sonnet-4.5': 0.25 },
        modelPricing: {
            'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10, tier: 'standard', category: 'Standard', multiplier: 0 },
            'claude-sonnet-4.5': { inputCostPerMillion: 3, outputCostPerMillion: 15, tier: 'premium', category: 'Premium', multiplier: 1 },
        } as any,
        toolNameMap: {},
    };
}

const FAKE_JSON_PATH = '/tmp/test-session.json';
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
    a.modelSwitching.totalRequests = 5;
    mergeUsageAnalysis(period, a);

    assert.equal(period.modelSwitching.mixedTierSessions, 1);
    assert.equal(period.modelSwitching.totalSessions, 1);
    assert.ok(period.modelSwitching.standardModels.includes('gpt-4o-mini'));
    assert.ok(period.modelSwitching.premiumModels.includes('claude-sonnet'));
    assert.equal(period.modelSwitching.standardRequests, 3);
    assert.equal(period.modelSwitching.premiumRequests, 2);
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
            return { 'gpt-4o': { inputTokens: 99, outputTokens: 11 } };
        },
    });
    const result = await getModelUsageFromSession(deps, '/opencode/session.db', '');
    assert.ok(called, 'getModelUsage should have been called on the openCode adapter');
    assert.equal(result['gpt-4o'].inputTokens, 99);
});

// ---------------------------------------------------------------------------
// calculateModelSwitching
// ---------------------------------------------------------------------------

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
    const analysis = emptyAnalysis();
    await calculateModelSwitching(deps, FAKE_JSON_PATH, analysis, content);
    assert.equal(analysis.modelSwitching.modelCount, 2);
    assert.ok(analysis.modelSwitching.hasMixedTiers, 'should detect mixed tiers');
    assert.equal(analysis.modelSwitching.switchCount, 1);
    assert.equal(analysis.modelSwitching.standardRequests, 1);
    assert.equal(analysis.modelSwitching.premiumRequests, 1);
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

