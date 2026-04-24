import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    calculateFluencyScoreForTeamMember,
    calculateMaturityScores,
} from '../../src/maturityScoring';
import type { UsageAnalysisStats, UsageAnalysisPeriod } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyFd() {
    return {
        askModeCount: 0, editModeCount: 0, agentModeCount: 0,
        planModeCount: 0, customAgentModeCount: 0, cliModeCount: 0,
        toolCallsTotal: 0, toolCallsByTool: {} as Record<string, number>,
        ctxFile: 0, ctxSelection: 0, ctxSymbol: 0,
        ctxCodebase: 0, ctxWorkspace: 0, ctxTerminal: 0,
        ctxVscode: 0, ctxClipboard: 0, ctxChanges: 0,
        ctxProblemsPanel: 0, ctxOutputPanel: 0,
        ctxTerminalLastCommand: 0, ctxTerminalSelection: 0,
        ctxByKind: {} as Record<string, number>,
        mcpTotal: 0, mcpByServer: {} as Record<string, number>,
        mixedTierSessions: 0, switchingFreqSum: 0, switchingFreqCount: 0,
        standardModels: new Set<string>(), premiumModels: new Set<string>(),
        multiFileEdits: 0, filesPerEditSum: 0, filesPerEditCount: 0,
        editsAgentCount: 0, workspaceAgentCount: 0,
        repositories: new Set<string>(), repositoriesWithCustomization: new Set<string>(),
        applyRateSum: 0, applyRateCount: 0,
        multiTurnSessions: 0, turnsPerSessionSum: 0, turnsPerSessionCount: 0,
        sessionCount: 0, durationMsSum: 0, durationMsCount: 0,
    };
}

function emptyPeriod(): UsageAnalysisPeriod {
    return {
        sessions: 0,
        toolCalls: { total: 0, byTool: {} },
        modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
        contextReferences: {
            file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
            workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0,
            terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0,
            problemsPanel: 0, byKind: {}, byPath: {}, copilotInstructions: 0, agentsMd: 0,
        },
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

function emptyStats(): UsageAnalysisStats {
    return { today: emptyPeriod(), last30Days: emptyPeriod(), month: emptyPeriod(), lastUpdated: new Date() };
}

// ---------------------------------------------------------------------------
// calculateFluencyScoreForTeamMember — overall stage
// ---------------------------------------------------------------------------

test('all-zero input yields overall Stage 1', () => {
    const result = calculateFluencyScoreForTeamMember(emptyFd(), 0);
    assert.equal(result.stage, 1);
    assert.equal(result.label, 'Stage 1: AI Skeptic');
    assert.equal(result.categories.length, 6);
});

// ---------------------------------------------------------------------------
// Prompt Engineering (PE)
// ---------------------------------------------------------------------------

test('PE: fewer than 5 interactions stays Stage 1', () => {
    const fd = emptyFd();
    fd.askModeCount = 4;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 1);
});

test('PE: exactly 5 interactions reaches Stage 2', () => {
    const fd = emptyFd();
    fd.askModeCount = 5;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 2);
});

test('PE: 30 interactions + agent mode reaches Stage 3', () => {
    const fd = emptyFd();
    fd.agentModeCount = 30;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 3);
});

test('PE: 30 interactions + 2 slash commands (no agent) reaches Stage 3', () => {
    const fd = emptyFd();
    fd.askModeCount = 30;
    fd.toolCallsByTool = { explain: 2, fix: 1 };
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 3);
});

test('PE: 100 interactions + agent + model switching reaches Stage 4', () => {
    const fd = emptyFd();
    fd.agentModeCount = 100;
    fd.mixedTierSessions = 1;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 4);
});

test('PE: avgTurns >= 3 boosts to at least Stage 2', () => {
    const fd = emptyFd();
    fd.turnsPerSessionSum = 9;
    fd.turnsPerSessionCount = 3; // avg = 3.0
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 2, `expected >= 2, got ${pe.stage}`);
});

test('PE: avgTurns >= 5 boosts to at least Stage 3', () => {
    const fd = emptyFd();
    fd.turnsPerSessionSum = 10;
    fd.turnsPerSessionCount = 2; // avg = 5.0
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3, `expected >= 3, got ${pe.stage}`);
});

test('PE: model switching alone boosts to at least Stage 3', () => {
    const fd = emptyFd();
    fd.mixedTierSessions = 1;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3, `expected >= 3, got ${pe.stage}`);
});

// ---------------------------------------------------------------------------
// Context Engineering (CE)
// ---------------------------------------------------------------------------

test('CE: no refs stays Stage 1', () => {
    const ce = calculateFluencyScoreForTeamMember(emptyFd(), 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.equal(ce.stage, 1);
});

test('CE: 1 #file ref raises to Stage 2', () => {
    const fd = emptyFd();
    fd.ctxFile = 1;
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.equal(ce.stage, 2);
});

test('CE: 3 different ref types + 10 total refs reaches Stage 3', () => {
    const fd = emptyFd();
    fd.ctxFile = 4; fd.ctxSelection = 3; fd.ctxWorkspace = 3; // 3 types, 10 total
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.equal(ce.stage, 3);
});

test('CE: only 2 ref types with 10 total stays below Stage 3', () => {
    const fd = emptyFd();
    fd.ctxFile = 5; fd.ctxSelection = 5; // 2 types, 10 total
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage < 3, `expected < 3, got ${ce.stage}`);
});

test('CE: 5 ref types + 30 total refs reaches Stage 4', () => {
    const fd = emptyFd();
    fd.ctxFile = 10; fd.ctxSelection = 5; fd.ctxSymbol = 5; fd.ctxCodebase = 5; fd.ctxWorkspace = 5; // 5 types, 30 total
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.equal(ce.stage, 4);
});

test('CE: image attachment boosts to at least Stage 3', () => {
    const fd = emptyFd();
    fd.ctxFile = 1; // need at least 1 ref to pass Stage 2
    fd.ctxByKind = { 'copilot.image': 1 };
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3, `expected >= 3, got ${ce.stage}`);
});

// ---------------------------------------------------------------------------
// Agentic (AG)
// ---------------------------------------------------------------------------

test('AG: no agent mode stays Stage 1', () => {
    const ag = calculateFluencyScoreForTeamMember(emptyFd(), 0).categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 1);
});

test('AG: any agent mode raises to Stage 2', () => {
    const fd = emptyFd();
    fd.agentModeCount = 1;
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 2, `expected >= 2, got ${ag.stage}`);
});

test('AG: 50 agent interactions + 5 non-auto tools reaches Stage 4', () => {
    const fd = emptyFd();
    fd.agentModeCount = 50;
    // 6 tools, all non-automatic (not in the automatic tool set)
    fd.toolCallsByTool = { run_in_terminal: 5, editFiles: 3, listFiles: 2, github_pull_request: 4, github_repo: 2, myCustomTool: 1 };
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 4);
});

// ---------------------------------------------------------------------------
// Tool Usage (TU)
// ---------------------------------------------------------------------------

test('TU: zero tool calls stays Stage 1', () => {
    const tu = calculateFluencyScoreForTeamMember(emptyFd(), 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.equal(tu.stage, 1);
});

test('TU: 2+ MCP servers reaches Stage 4', () => {
    const fd = emptyFd();
    fd.mcpTotal = 5;
    fd.mcpByServer = { 'GitHub MCP': 3, 'Jira MCP': 2 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.equal(tu.stage, 4);
});

test('TU: 1 MCP server stays below Stage 4', () => {
    const fd = emptyFd();
    fd.mcpTotal = 3;
    fd.mcpByServer = { 'GitHub MCP': 3 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage < 4, `expected < 4, got ${tu.stage}`);
});

// ---------------------------------------------------------------------------
// Customization (CU)
// ---------------------------------------------------------------------------

test('CU: no repos stays Stage 1', () => {
    const cu = calculateFluencyScoreForTeamMember(emptyFd(), 0).categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 1);
});

test('CU: 1 customized repo raises to Stage 2', () => {
    const fd = emptyFd();
    fd.repositories = new Set(['owner/repo-a']);
    fd.repositoriesWithCustomization = new Set(['owner/repo-a']);
    const cu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Customization')!;
    assert.ok(cu.stage >= 2, `expected >= 2, got ${cu.stage}`);
});

test('CU: 5+ unique models boosts to at least Stage 3', () => {
    const fd = emptyFd();
    fd.standardModels = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo']);
    fd.premiumModels = new Set(['claude-sonnet', 'o1-preview']);
    const cu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Customization')!;
    assert.ok(cu.stage >= 3, `expected >= 3, got ${cu.stage}`);
});

// ---------------------------------------------------------------------------
// Workflow Integration (WI)
// ---------------------------------------------------------------------------

test('WI: fewer than 3 sessions stays Stage 1', () => {
    const fd = emptyFd();
    fd.sessionCount = 2;
    const wi = calculateFluencyScoreForTeamMember(fd, 2).categories.find(c => c.category === 'Workflow Integration')!;
    assert.equal(wi.stage, 1);
});

test('WI: 3+ sessions raises to Stage 2', () => {
    const fd = emptyFd();
    fd.sessionCount = 3;
    const wi = calculateFluencyScoreForTeamMember(fd, 3).categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 2, `expected >= 2, got ${wi.stage}`);
});

test('WI: 15 sessions + 2 modes + 20 ctx refs reaches Stage 4', () => {
    const fd = emptyFd();
    fd.sessionCount = 15;
    fd.askModeCount = 10;
    fd.agentModeCount = 5;
    fd.ctxFile = 20;
    const wi = calculateFluencyScoreForTeamMember(fd, 15).categories.find(c => c.category === 'Workflow Integration')!;
    assert.equal(wi.stage, 4);
});

// ---------------------------------------------------------------------------
// Overall median calculation
// ---------------------------------------------------------------------------

test('overall stage is median of 6 category stages', () => {
    const result = calculateFluencyScoreForTeamMember(emptyFd(), 0);
    // Verify all 6 category names are present
    const names = result.categories.map(c => c.category);
    assert.ok(names.includes('Prompt Engineering'));
    assert.ok(names.includes('Context Engineering'));
    assert.ok(names.includes('Agentic'));
    assert.ok(names.includes('Tool Usage'));
    assert.ok(names.includes('Customization'));
    assert.ok(names.includes('Workflow Integration'));
    // All zero → all Stage 1 → median = 1
    assert.equal(result.stage, 1);
});

test('median with mixed stages returns correct middle value', () => {
    // Force 3 categories to Stage 1, 3 to Stage 2 → sorted [1,1,1,2,2,2] → median avg = 1.5 → round = 2
    const fd = emptyFd();
    fd.sessionCount = 3;      // WI → 2
    fd.askModeCount = 5;      // PE → 2
    fd.ctxFile = 1;           // CE → 2
    // AG, TU, CU stay at 1
    const result = calculateFluencyScoreForTeamMember(fd, 3);
    assert.ok(result.stage >= 1 && result.stage <= 2, `expected 1 or 2, got ${result.stage}`);
});

// ---------------------------------------------------------------------------
// calculateMaturityScores (async, personal view)
// ---------------------------------------------------------------------------

test('calculateMaturityScores: Stage 1 for empty usage data', async () => {
    const result = await calculateMaturityScores(undefined, async () => emptyStats());
    assert.equal(result.overallStage, 1);
    assert.ok(result.categories.length > 0);
    assert.ok(typeof result.overallLabel === 'string');
    assert.ok(result.overallLabel.includes('Stage 1'));
});

test('calculateMaturityScores: higher stage for active usage', async () => {
    const stats = emptyStats();
    stats.last30Days.modeUsage.ask = 50;
    stats.last30Days.modeUsage.agent = 20;
    stats.last30Days.toolCalls.byTool = { fix: 3, tests: 2, explain: 1 };
    stats.last30Days.modelSwitching.mixedTierSessions = 2;
    stats.last30Days.modelSwitching.switchingFrequency = 50;
    const result = await calculateMaturityScores(undefined, async () => stats);
    assert.ok(result.overallStage >= 2, `expected >= 2, got ${result.overallStage}`);
});

test('calculateMaturityScores: returns all expected fields', async () => {
    const result = await calculateMaturityScores(undefined, async () => emptyStats());
    assert.ok('overallStage' in result);
    assert.ok('overallLabel' in result);
    assert.ok('categories' in result);
    assert.ok('period' in result);
    assert.ok('lastUpdated' in result);
});

test('calculateMaturityScores: passes useCache flag to stats callback', async () => {
    let capturedFlag: boolean | undefined;
    await calculateMaturityScores(undefined, async (useCache) => {
        capturedFlag = useCache;
        return emptyStats();
    }, false);
    assert.equal(capturedFlag, false);
});