import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    mergeUsageAnalysis,
    analyzeContextReferences,
    deriveConversationPatterns,
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
        problemsPanel: 0, byKind: {}, byPath: {}, copilotInstructions: 0, agentsMd: 0,
    };
}

function emptyAnalysis(): SessionUsageAnalysis {
    return {
        toolCalls: { total: 0, byTool: {} },
        modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
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
        modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
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
    a.modeUsage = { ask: 5, edit: 2, agent: 3, plan: 1, customAgent: 0 };
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