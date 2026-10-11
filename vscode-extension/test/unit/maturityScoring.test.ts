import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    calculateFluencyScoreForTeamMember,
    calculateMaturityScores,
    getFluencyLevelData,
    topReposMissingCustomization,
} from '../../../src/maturityScoring';
import type { UsageAnalysisStats, UsageAnalysisPeriod, WorkspaceCustomizationMatrix } from '../../../src/types';

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
        mixedTierSessions: 0, mixedCostSessions: 0, switchingFreqSum: 0, switchingFreqCount: 0,
        standardModels: new Set<string>(), premiumModels: new Set<string>(),
        lowCostModels: new Set<string>(), mediumCostModels: new Set<string>(), highCostModels: new Set<string>(),
        multiFileEdits: 0, filesPerEditSum: 0, filesPerEditCount: 0,
        editsAgentCount: 0, workspaceAgentCount: 0,
        autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0,
        selectedModelExtensions: new Set<string>(), unknownProviderModels: new Set<string>(),
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

function emptyStats(): UsageAnalysisStats {
    return { today: emptyPeriod(), last30Days: emptyPeriod(), month: emptyPeriod(), lastMonth: emptyPeriod(), lastUpdated: new Date() };
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

test('PE: Auto-heavy usage boosts Prompt Engineering', () => {
    const fd = emptyFd();
    fd.sessionCount = 10;
    fd.autoSessions = 8;
    const pe = calculateFluencyScoreForTeamMember(fd, 10).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3, `expected PE >= 3 with heavy Auto usage, got ${pe.stage}`);
    assert.ok(pe.tips.every(t => !t.toLowerCase().includes('auto model')), 'should not nudge frequent Auto users');
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
    fd.mixedCostSessions = 1;
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
    fd.lowCostModels = new Set(['gpt-4o-mini']);
    fd.mediumCostModels = new Set(['gpt-4o', 'gpt-4-turbo', 'claude-sonnet']);
    fd.highCostModels = new Set(['o1-preview']);
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

// ---------------------------------------------------------------------------
// calculateMaturityScores — Prompt Engineering via period data
// ---------------------------------------------------------------------------

test('calculateMaturityScores: PE conversation patterns (multiTurnSessions) populate evidence', async () => {
    const stats = emptyStats();
    stats.last30Days.conversationPatterns.multiTurnSessions = 5;
    stats.last30Days.conversationPatterns.avgTurnsPerSession = 3.5;
    stats.last30Days.sessions = 10;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 2, `expected PE >= 2 with avgTurns 3.5, got ${pe.stage}`);
    assert.ok(pe.evidence.some(e => e.includes('multi-turn')), 'evidence should mention multi-turn sessions');
});

test('calculateMaturityScores: PE avgTurns >= 5 boosts to at least Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.conversationPatterns.avgTurnsPerSession = 5.0;
    stats.last30Days.conversationPatterns.multiTurnSessions = 3;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3, `expected PE >= 3 with avgTurns 5.0, got ${pe.stage}`);
});

test('calculateMaturityScores: PE Stage 4 (100+ interactions, agent, model switching)', async () => {
    const stats = emptyStats();
    stats.last30Days.modeUsage.agent = 100;
    stats.last30Days.modelSwitching.mixedTierSessions = 2;
    stats.last30Days.modelSwitching.switchingFrequency = 50;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 4);
});

test('calculateMaturityScores: PE model switching alone boosts to Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.modelSwitching.mixedTierSessions = 1;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3, `expected PE >= 3 with mixedTierSessions=1, got ${pe.stage}`);
});

test('calculateMaturityScores: PE with CLI interactions includes evidence', async () => {
    const stats = emptyStats();
    stats.last30Days.modeUsage.cli = 10;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.evidence.some(e => e.includes('CLI')), 'evidence should mention CLI interactions');
});

test('calculateMaturityScores: PE with slash commands shows evidence', async () => {
    const stats = emptyStats();
    stats.last30Days.modeUsage.ask = 30;
    stats.last30Days.toolCalls.byTool = { explain: 2, fix: 1 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.evidence.some(e => e.includes('slash commands')), 'evidence should mention slash commands');
});

// ---------------------------------------------------------------------------
// calculateMaturityScores — Context Engineering via period data
// ---------------------------------------------------------------------------

test('calculateMaturityScores: CE image booster → Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.contextReferences.file = 1;
    stats.last30Days.contextReferences.byKind = { 'copilot.image': 2 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3, `expected CE >= 3 with image refs, got ${ce.stage}`);
    assert.ok(ce.evidence.some(e => e.includes('image')), 'evidence should mention image references');
});

test('calculateMaturityScores: CE prompt file booster → Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.contextReferences.byKind = { promptFile: 3 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3, `expected CE >= 3 with promptFile refs, got ${ce.stage}`);
});

test('calculateMaturityScores: CE Stage 4 (5+ ref types, 30+ total refs)', async () => {
    const stats = emptyStats();
    stats.last30Days.contextReferences.file = 10;
    stats.last30Days.contextReferences.selection = 5;
    stats.last30Days.contextReferences.symbol = 5;
    stats.last30Days.contextReferences.codebase = 5;
    stats.last30Days.contextReferences.workspace = 5;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.equal(ce.stage, 4);
});

test('calculateMaturityScores: CE Stage 4 tip shown when specialized items used', async () => {
    const stats = emptyStats();
    stats.last30Days.contextReferences.file = 4;
    stats.last30Days.contextReferences.selection = 3;
    stats.last30Days.contextReferences.codebase = 2;
    stats.last30Days.contextReferences.byKind = { 'copilot.image': 1, '#changes': 1 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.tips.length > 0);
});

test('calculateMaturityScores: CE evidence includes various ref types', async () => {
    const stats = emptyStats();
    stats.last30Days.contextReferences.terminal = 3;
    stats.last30Days.contextReferences.vscode = 2;
    stats.last30Days.contextReferences.clipboard = 1;
    stats.last30Days.contextReferences.changes = 1;
    stats.last30Days.contextReferences.problemsPanel = 1;
    stats.last30Days.contextReferences.terminalLastCommand = 1;
    stats.last30Days.contextReferences.terminalSelection = 1;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.evidence.length > 0);
});

// ---------------------------------------------------------------------------
// calculateMaturityScores — Agentic via period data
// ---------------------------------------------------------------------------

test('calculateMaturityScores: AG with editScope (multiFileEdits) → Stage 2', async () => {
    const stats = emptyStats();
    stats.last30Days.editScope.multiFileEdits = 5;
    stats.last30Days.editScope.singleFileEdits = 2;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 2, `expected AG >= 2 with multiFileEdits, got ${ag.stage}`);
    assert.ok(ag.evidence.some(e => e.includes('multi-file')), 'evidence should mention multi-file edits');
});

test('calculateMaturityScores: AG avgFilesPerSession ≥ 3 → Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.editScope.avgFilesPerSession = 3.5;
    stats.last30Days.editScope.multiFileEdits = 2;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 3, `expected AG >= 3 with avgFilesPerSession=3.5, got ${ag.stage}`);
});

test('calculateMaturityScores: AG multi-file Stage 4 (20+ multiFileEdits, avgFiles >= 3)', async () => {
    const stats = emptyStats();
    stats.last30Days.editScope.multiFileEdits = 20;
    stats.last30Days.editScope.avgFilesPerSession = 3.5;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 4);
});

test('calculateMaturityScores: AG multiAgentParentSessions=1 → Stage 3', async () => {
    const stats = emptyStats();
    (stats.last30Days as UsageAnalysisPeriod & { multiAgentParentSessions?: number }).multiAgentParentSessions = 1;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 3, `expected AG >= 3 with 1 multi-agent session, got ${ag.stage}`);
    assert.ok(ag.evidence.some(e => e.includes('multi-agent')), 'evidence should mention multi-agent orchestration');
});

test('calculateMaturityScores: AG multiAgentParentSessions=3 → Stage 4', async () => {
    const stats = emptyStats();
    (stats.last30Days as UsageAnalysisPeriod & { multiAgentParentSessions?: number }).multiAgentParentSessions = 3;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 4);
});

test('calculateMaturityScores: AG delegationSessions=2 → Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.delegationSessions = 2;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 3, `expected AG >= 3 with 2 delegation sessions, got ${ag.stage}`);
    assert.ok(ag.evidence.some(e => e.includes('delegated work to sub-agents')), 'evidence should mention sub-agent delegation');
});

test('calculateMaturityScores: AG delegationSessions=5 → Stage 4', async () => {
    const stats = emptyStats();
    stats.last30Days.delegationSessions = 5;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 4);
});

test('calculateMaturityScores: AG delegationSessions=1 → no booster (below threshold)', async () => {
    const stats = emptyStats();
    stats.last30Days.delegationSessions = 1;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(!ag.evidence.some(e => e.includes('delegated work to sub-agents')));
});

test('calculateMaturityScores: AG delegation tool-call volume adds evidence with avg per session', async () => {
    const stats = emptyStats();
    stats.last30Days.delegationSessions = 2;
    stats.last30Days.toolCalls.byTool = { subagent: 4, delegate_task: 2, edit_file: 10 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.evidence.some(e => e.includes('sub-agent/delegate tool calls executed') && e.includes('avg 3.0 per delegating session')));
});

test('calculateMaturityScores: AG editsAgent sessions provide evidence', async () => {
    const stats = emptyStats();
    stats.last30Days.agentTypes.editsAgent = 5;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 2, 'editsAgent sessions should push to at least Stage 2');
    assert.ok(ag.evidence.some(e => e.includes('edits agent')), 'evidence should mention edits agent');
});

// ---------------------------------------------------------------------------
// calculateMaturityScores — Tool Usage via period data
// ---------------------------------------------------------------------------

test('calculateMaturityScores: TU workspaceAgent → Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.agentTypes.workspaceAgent = 3;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const tu = result.categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 3, `expected TU >= 3 with workspaceAgent, got ${tu.stage}`);
    assert.ok(tu.evidence.some(e => e.includes('@workspace')), 'evidence should mention @workspace agent');
});

test('calculateMaturityScores: TU 2 advanced tools → Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.toolCalls.byTool = { github_pull_request: 2, run_in_terminal: 3 };
    stats.last30Days.toolCalls.total = 5;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const tu = result.categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 3, `expected TU >= 3 with 2 advanced tools, got ${tu.stage}`);
});

test('calculateMaturityScores: TU automatic-only tools reported but stay Stage 1', async () => {
    const stats = emptyStats();
    // Only automatic tools (reading files etc.)
    stats.last30Days.toolCalls.byTool = { read_file: 10, list_directory: 5 };
    stats.last30Days.toolCalls.total = 15;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const tu = result.categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.evidence.some(e => e.includes('automatic')), 'evidence should note automatic tools');
});

test('calculateMaturityScores: TU single MCP server → Stage 3 but not Stage 4', async () => {
    const stats = emptyStats();
    stats.last30Days.mcpTools.total = 3;
    stats.last30Days.mcpTools.byServer = { 'GitHub MCP': 3 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const tu = result.categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 3 && tu.stage < 4, `expected TU == 3 with 1 MCP server, got ${tu.stage}`);
    assert.ok(tu.evidence.some(e => e.includes('MCP')), 'evidence should mention MCP tool calls');
});

// ---------------------------------------------------------------------------
// calculateMaturityScores — Customization via period data + matrix
// ---------------------------------------------------------------------------

test('calculateMaturityScores: CU Stage 3 via customization rate (30%+, 2+ repos)', async () => {
    const matrix: WorkspaceCustomizationMatrix = {
        customizationTypes: [{ id: 'instructions', icon: '📝', label: 'Instructions' }],
        workspaces: [],
        totalWorkspaces: 5,
        workspacesWithIssues: 3,  // 2 of 5 have customization → 40% rate
    };
    const result = await calculateMaturityScores(matrix, async () => emptyStats());
    const cu = result.categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 3);
    assert.ok(cu.evidence.some(e => e.includes('repositor')), 'evidence should mention repositories');
});

test('calculateMaturityScores: CU Stage 4 via customization rate (70%+, 3+ repos)', async () => {
    const matrix: WorkspaceCustomizationMatrix = {
        customizationTypes: [{ id: 'instructions', icon: '📝', label: 'Instructions' }],
        workspaces: [],
        totalWorkspaces: 4,
        workspacesWithIssues: 1,  // 3 of 4 customized → 75% rate
    };
    const result = await calculateMaturityScores(matrix, async () => emptyStats());
    const cu = result.categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 4);
    assert.ok(cu.tips.some(t => t.includes('repo')), 'Stage 4 tips should mention repos');
});

test('calculateMaturityScores: CU Stage 4 all repos customized → "all repos" tip', async () => {
    const matrix: WorkspaceCustomizationMatrix = {
        customizationTypes: [{ id: 'instructions', icon: '📝', label: 'Instructions' }],
        workspaces: [],
        totalWorkspaces: 3,
        workspacesWithIssues: 0,  // 3 of 3 customized → 100%
    };
    const result = await calculateMaturityScores(matrix, async () => emptyStats());
    const cu = result.categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 4);
    assert.ok(cu.tips.some(t => t.toLowerCase().includes('all repos')), 'tip should say all repos customized');
});

test('calculateMaturityScores: CU Stage 4 with uncustomized repos shows prioritized missing repos tip', async () => {
    const matrix: WorkspaceCustomizationMatrix = {
        customizationTypes: [{ id: 'instructions', icon: '📝', label: 'Instructions' }],
        workspaces: [
            {
                workspaceName: 'my-repo', workspacePath: '/home/user/my-repo',
                sessionCount: 10, interactionCount: 50,
                typeStatuses: { instructions: '❌' },
            },
        ],
        totalWorkspaces: 5,
        workspacesWithIssues: 1,  // 4 of 5 customized → 80% → Stage 4
    };
    const result = await calculateMaturityScores(matrix, async () => emptyStats());
    const cu = result.categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 4);
    // Should show tip about uncustomized repos since workspacesWithIssues = 1
    assert.ok(cu.tips.some(t => t.includes('repo') && t.includes('miss')), 'tip should mention missing repos');
});

test('calculateMaturityScores: CU unique models boost to Stage 3', async () => {
    const stats = emptyStats();
    stats.last30Days.modelSwitching.standardModels = ['gpt-4o', 'gpt-4o-mini', 'gemini-pro'];
    const result = await calculateMaturityScores(undefined, async () => stats);
    const cu = result.categories.find(c => c.category === 'Customization')!;
    assert.ok(cu.stage >= 3, `expected CU >= 3 with 3 unique models, got ${cu.stage}`);
    assert.ok(cu.evidence.some(e => e.includes('model')), 'evidence should mention models used');
});

// ---------------------------------------------------------------------------
// calculateMaturityScores — Workflow Integration via period data
// ---------------------------------------------------------------------------

test('calculateMaturityScores: WI apply rate ≥ 50 → Stage 2 boost', async () => {
    const stats = emptyStats();
    stats.last30Days.applyUsage.totalCodeBlocks = 10;
    stats.last30Days.applyUsage.totalApplies = 8;
    stats.last30Days.applyUsage.applyRate = 80;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const wi = result.categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 2, `expected WI >= 2 with 80% apply rate, got ${wi.stage}`);
    assert.ok(wi.evidence.some(e => e.includes('apply rate')), 'evidence should mention apply rate');
});

test('calculateMaturityScores: WI session duration included in evidence', async () => {
    const stats = emptyStats();
    stats.last30Days.sessionDuration.avgDurationMs = 5 * 60 * 1000; // 5 minutes
    const result = await calculateMaturityScores(undefined, async () => stats);
    const wi = result.categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.evidence.some(e => e.includes('min session')), 'evidence should mention session duration');
});

test('calculateMaturityScores: WI Stage 4 (15+ sessions, 2+ modes, 20+ ctx refs)', async () => {
    const stats = emptyStats();
    stats.last30Days.sessions = 15;
    stats.last30Days.modeUsage.ask = 10;
    stats.last30Days.modeUsage.agent = 5;
    stats.last30Days.contextReferences.file = 20;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const wi = result.categories.find(c => c.category === 'Workflow Integration')!;
    assert.equal(wi.stage, 4);
});

test('calculateMaturityScores: WI CLI as third mode counts toward modesUsed', async () => {
    const stats = emptyStats();
    stats.last30Days.sessions = 5;
    stats.last30Days.modeUsage.ask = 5;
    stats.last30Days.modeUsage.agent = 5;
    stats.last30Days.modeUsage.cli = 5;
    stats.last30Days.contextReferences.file = 5;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const wi = result.categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 3, `expected WI >= 3 with 3 modes, got ${wi.stage}`);
    assert.ok(wi.evidence.some(e => e.includes('modes')), 'evidence should mention modes used');
});

// ---------------------------------------------------------------------------
// calculateFluencyScoreForTeamMember — edge cases for _calcFluency* helpers
// ---------------------------------------------------------------------------

test('AG (team): editsAgentCount > 0 boosts to at least Stage 2', () => {
    const fd = emptyFd();
    fd.editsAgentCount = 1;
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 2, `expected AG >= 2 with editsAgentCount=1, got ${ag.stage}`);
});

test('AG (team): multiFileEdits ≥ 20 + avgFilesPerSession ≥ 3 → Stage 4', () => {
    const fd = emptyFd();
    fd.multiFileEdits = 20;
    fd.filesPerEditSum = 70; fd.filesPerEditCount = 20; // avg = 3.5
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 4);
});

test('TU (team): workspaceAgentCount > 0 → at least Stage 3', () => {
    const fd = emptyFd();
    fd.workspaceAgentCount = 2;
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 3, `expected TU >= 3 with workspaceAgentCount=2, got ${tu.stage}`);
});

test('TU (team): 2 advanced tools → Stage 3', () => {
    const fd = emptyFd();
    fd.toolCallsByTool = { github_pull_request: 2, run_in_terminal: 1 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 3, `expected TU >= 3 with 2 advanced tools, got ${tu.stage}`);
});

test('TU (team): single MCP server tip says "Add more MCP servers"', () => {
    const fd = emptyFd();
    fd.mcpTotal = 3;
    fd.mcpByServer = { 'GitHub MCP': 3 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.tips.some((t: string) => t.toLowerCase().includes('more mcp')), 'tip should suggest adding more MCP servers');
});

test('TU (team): MCP present but zero servers → tip to explore MCP', () => {
    const fd = emptyFd();
    fd.mcpTotal = 0;
    fd.mcpByServer = {};
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.tips.some((t: string) => t.toLowerCase().includes('mcp')), 'tip should mention MCP setup');
});

test('CU (team): Stage 4 + uncustomized repos → tip mentions uncustomized count', () => {
    const fd = emptyFd();
    fd.repositories = new Set(['owner/a', 'owner/b', 'owner/c', 'owner/d']);
    fd.repositoriesWithCustomization = new Set(['owner/a', 'owner/b', 'owner/c']); // 75% → Stage 4
    const cu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 4);
    assert.ok(cu.tips.some((t: string) => t.includes('1') && t.toLowerCase().includes('miss')), 'tip should mention 1 missing repo');
});

test('CU (team): Stage 4 all customized → "all repos customized" tip', () => {
    const fd = emptyFd();
    fd.repositories = new Set(['owner/a', 'owner/b', 'owner/c']);
    fd.repositoriesWithCustomization = new Set(['owner/a', 'owner/b', 'owner/c']); // 100% → Stage 4
    const cu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 4);
    assert.ok(cu.tips.some((t: string) => t.toLowerCase().includes('all repos')), 'tip should say all repos customized');
});

test('WI (team): apply rate ≥ 50 boosts to at least Stage 2', () => {
    const fd = emptyFd();
    fd.applyRateSum = 80; fd.applyRateCount = 1; // avg apply rate = 80
    const wi = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 2, `expected WI >= 2 with 80% apply rate, got ${wi.stage}`);
});

test('WI (team): context refs ≥ 20 → at least Stage 3', () => {
    const fd = emptyFd();
    fd.ctxFile = 20;
    const wi = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 3, `expected WI >= 3 with 20 ctx refs, got ${wi.stage}`);
});

test('CE (team): 2 specialized items (changes+clipboard) → Stage 4 gap tip generated', () => {
    const fd = emptyFd();
    // Use direct ctxChanges/ctxClipboard (the specialized items checks use fd.ctxChanges, not byKind)
    fd.ctxChanges = 1; fd.ctxClipboard = 1;
    fd.ctxFile = 3; fd.ctxSelection = 2;
    // specializedUsedCount = 2 → enters gap-tip branch; stage < 4 (not enough types/refs)
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage < 4, 'stage should still be < 4');
    assert.ok(ce.tips.length > 0, 'tips should be generated');
});

test('CE (team): promptFile in ctxByKind boosts to at least Stage 3', () => {
    const fd = emptyFd();
    fd.ctxByKind = { promptFile: 2 };
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3, `expected CE >= 3 with promptFile refs, got ${ce.stage}`);
});

test('PE (team): Claude slash commands (__slash__ prefix) count for Stage 3', () => {
    const fd = emptyFd();
    fd.askModeCount = 30;
    fd.toolCallsByTool = { __slash__review: 1, __slash__bug: 1 };
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3, `expected PE >= 3 with Claude slash commands, got ${pe.stage}`);
});

test('PE (team): switchingFrequency via switchingFreqSum/Count enables Stage 4 with agent mode', () => {
    const fd = emptyFd();
    fd.agentModeCount = 100;
    fd.switchingFreqSum = 100; fd.switchingFreqCount = 2; // avg = 50% → hasModelSwitching=true
    fd.mixedTierSessions = 1; // needed for the mixedTierSessions stage-3 boost path
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 4, `expected PE = 4 with switchingFrequency + agent mode, got ${pe.stage}`);
});

test('PE (team): Stage 4 with slash commands as alternative to model switching', () => {
    const fd = emptyFd();
    fd.agentModeCount = 100;
    // 3 slash commands, no model switching
    fd.toolCallsByTool = { explain: 2, fix: 1, tests: 1 };
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.equal(pe.stage, 4);
});

// ---------------------------------------------------------------------------
// calculateMaturityScores — additional branch coverage
// ---------------------------------------------------------------------------

test('calculateMaturityScores: PE tip "Explore more slash commands" when agent+switching but few slash cmds', async () => {
    const stats = emptyStats();
    stats.last30Days.modeUsage.agent = 20;
    stats.last30Days.modelSwitching.mixedTierSessions = 1;
    // Only 1 slash command (< 3 needed for that tip path), not enough total for Stage 4
    stats.last30Days.toolCalls.byTool = { fix: 1 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3, `expected PE >= 3 with agent+switching, got ${pe.stage}`);
    assert.ok(pe.tips.some(t => t.toLowerCase().includes('slash')), 'tips should suggest slash commands');
});

test('calculateMaturityScores: PE no conversationPatterns guard does not crash', async () => {
    const stats = emptyStats();
    // Simulate a period without conversationPatterns (guard path)
    const periodWithoutPatterns = { ...stats.last30Days, conversationPatterns: undefined as any };
    const result = await calculateMaturityScores(undefined, async () => ({
        ...stats, last30Days: periodWithoutPatterns,
    }));
    const pe = result.categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe !== undefined);
});

test('calculateMaturityScores: CE specialized items (changes+clipboard) in period → Stage 4 tip with gap', async () => {
    const stats = emptyStats();
    // 2 specialized items used via direct period refs (not byKind)
    stats.last30Days.contextReferences.changes = 2;
    stats.last30Days.contextReferences.clipboard = 1;
    stats.last30Days.contextReferences.file = 3;
    stats.last30Days.contextReferences.selection = 2;
    // stage < 4 (only 4 ref types, 5 total refs) → _buildCeStage4Tip fires
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage < 4, 'should not reach Stage 4 yet');
    assert.ok(ce.tips.some(t => t.toLowerCase().includes('stage 4')), 'tips should mention Stage 4 requirements');
});

test('calculateMaturityScores: CE all 10 specialized items used → tip without gap listing', async () => {
    const stats = emptyStats();
    // All specialized items used, but not enough total refs for Stage 4
    stats.last30Days.contextReferences.changes = 1;
    stats.last30Days.contextReferences.problemsPanel = 1;
    stats.last30Days.contextReferences.outputPanel = 1;
    stats.last30Days.contextReferences.terminalLastCommand = 1;
    stats.last30Days.contextReferences.terminalSelection = 1;
    stats.last30Days.contextReferences.clipboard = 1;
    stats.last30Days.contextReferences.vscode = 1;
    stats.last30Days.contextReferences.byKind = { 'copilot.image': 1, promptFile: 1, prompt: 1 };
    stats.last30Days.contextReferences.file = 1;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3, 'image/promptFile boosters should reach at least Stage 3');
});

test('calculateMaturityScores: AG Stage 4 via 50+ agent interactions + 5 non-auto tools', async () => {
    const stats = emptyStats();
    stats.last30Days.modeUsage.agent = 50;
    stats.last30Days.toolCalls.byTool = {
        run_in_terminal: 5, github_pull_request: 4, editFiles: 3, listFiles: 2, myTool: 1
    };
    stats.last30Days.toolCalls.total = 15;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 4);
});

test('calculateMaturityScores: AG with edit mode interactions adds evidence', async () => {
    const stats = emptyStats();
    stats.last30Days.modeUsage.edit = 5;
    stats.last30Days.toolCalls.total = 3;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ag = result.categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.evidence.some(e => e.includes('edit-mode')), 'evidence should include edit-mode interactions');
});

test('calculateMaturityScores: TU 2+ MCP servers → Stage 4 (period-based)', async () => {
    const stats = emptyStats();
    stats.last30Days.mcpTools.total = 5;
    stats.last30Days.mcpTools.byServer = { 'GitHub MCP': 3, 'Jira MCP': 2 };
    const result = await calculateMaturityScores(undefined, async () => stats);
    const tu = result.categories.find(c => c.category === 'Tool Usage')!;
    assert.equal(tu.stage, 4);
});

test('calculateMaturityScores: TU byServer has entries but total=0 → tip for existing MCP', async () => {
    const stats = emptyStats();
    // Inconsistent state: byServer populated but total=0 → MCP block won't fire
    stats.last30Days.mcpTools.total = 0;
    stats.last30Days.mcpTools.byServer = { 'GitHub MCP': 0 };
    stats.last30Days.toolCalls.byTool = { run_in_terminal: 1 }; // 1 non-auto tool → Stage 2
    const result = await calculateMaturityScores(undefined, async () => stats);
    const tu = result.categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage < 3, `expected TU < 3 (MCP block didn't fire), got ${tu.stage}`);
    assert.ok(tu.tips.some(t => t.toLowerCase().includes('github integrations')), 'tip should mention GitHub integrations when MCP server in byServer but total=0');
});

test('calculateMaturityScores: CU Stage 4 via 5+ unique models + 3+ customized repos', async () => {
    const matrix: WorkspaceCustomizationMatrix = {
        customizationTypes: [{ id: 'instructions', icon: '📝', label: 'Instructions' }],
        workspaces: [],
        totalWorkspaces: 4,
        workspacesWithIssues: 1,  // 3 of 4 customized → 75% → meets rate threshold
    };
    const stats = emptyStats();
    stats.last30Days.modelSwitching.standardModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1'];
    stats.last30Days.modelSwitching.premiumModels = ['claude-sonnet'];
    const result = await calculateMaturityScores(matrix, async () => stats);
    const cu = result.categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 4);
    assert.ok(cu.evidence.some(e => e.includes('models')), 'evidence should mention models');
});

test('calculateMaturityScores: CU Stage 2 evidence (some customization, not Stage 3)', async () => {
    const matrix: WorkspaceCustomizationMatrix = {
        customizationTypes: [{ id: 'instructions', icon: '📝', label: 'Instructions' }],
        workspaces: [],
        totalWorkspaces: 5,
        workspacesWithIssues: 4,  // 1 of 5 customized → 20% → Stage 2 only
    };
    const result = await calculateMaturityScores(matrix, async () => emptyStats());
    const cu = result.categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 2);
    assert.ok(cu.evidence.some(e => e.includes('custom instructions')), 'evidence should mention custom instructions');
});

test('calculateMaturityScores: WI stage < 3, few context refs → explicit context tip shown', async () => {
    const stats = emptyStats();
    stats.last30Days.sessions = 5;
    stats.last30Days.modeUsage.ask = 5; // single mode, modesUsed = 1 < 2
    stats.last30Days.contextReferences.file = 2; // below hasExplicitContextMinRefs (10)
    const result = await calculateMaturityScores(undefined, async () => stats);
    const wi = result.categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage < 3, `expected WI < 3 with single mode, got ${wi.stage}`);
    assert.ok(wi.tips.some(t => t.toLowerCase().includes('context references')), 'tip should suggest using explicit context refs');
});

test('CU (team): Stage 3 with uncustomized repos → "add to remaining" tip', () => {
    const fd = emptyFd();
    // 3 repos, 2 customized → 66.7% ≥ 30%, 2 ≥ 2 → Stage 3. uncustomized = 1
    fd.repositories = new Set(['owner/a', 'owner/b', 'owner/c']);
    fd.repositoriesWithCustomization = new Set(['owner/a', 'owner/b']);
    const cu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 3);
    assert.ok(cu.tips.some((t: string) => t.includes('remaining')), 'tip should mention remaining repos');
});

test('CU (team): Foundry/local model usage promotes customization', () => {
    const fd = emptyFd();
    fd.foundryWindowsSessions = 3;
    fd.sessionCount = 3;
    const cu = calculateFluencyScoreForTeamMember(fd, 3).categories.find(c => c.category === 'Customization')!;
    assert.ok(cu.stage >= 2, `expected Customization >= 2 with Foundry/local usage, got ${cu.stage}`);
    assert.ok(cu.tips.some((t: string) => t.toLowerCase().includes('foundry') || t.toLowerCase().includes('local models')), 'tips should mention Foundry/local models');
});

test('CU (team): unknown provider usage promotes customization', () => {
    const fd = emptyFd();
    fd.unknownProviderSessions = 2;
    fd.unknownProviderModels = new Set(['phi-4-mini']);
    const cu = calculateFluencyScoreForTeamMember(fd, 2).categories.find(c => c.category === 'Customization')!;
    assert.ok(cu.stage >= 2, `expected Customization >= 2 with unknown provider usage, got ${cu.stage}`);
    assert.ok(cu.tips.some((t: string) => t.toLowerCase().includes('marketplace') || t.toLowerCase().includes('providers')), 'tip should mention more providers');
});

// ---------------------------------------------------------------------------
// getFluencyLevelData
// ---------------------------------------------------------------------------

test('getFluencyLevelData: returns categories and isDebugMode flag', () => {
    const result = getFluencyLevelData(false);
    assert.equal(result.isDebugMode, false);
    assert.ok(Array.isArray(result.categories), 'categories should be an array');
    assert.ok(result.categories.length > 0, 'should have at least one category');
});

test('getFluencyLevelData: isDebugMode=true is reflected', () => {
    const result = getFluencyLevelData(true);
    assert.equal(result.isDebugMode, true);
});

// ---------------------------------------------------------------------------
// Additional branch coverage — period-based scoring
// ---------------------------------------------------------------------------

test('calculateMaturityScores: WI apply rate < 50 does NOT boost to Stage 2', async () => {
    const stats = emptyStats();
    stats.last30Days.applyUsage.totalCodeBlocks = 10;
    stats.last30Days.applyUsage.totalApplies = 3;
    stats.last30Days.applyUsage.applyRate = 30;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const wi = result.categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.evidence.some(e => e.includes('apply rate')), 'evidence should include apply rate even below 50%');
});

test('calculateMaturityScores: TU 2 servers in byServer but total=0 → "multiple MCP" tip', async () => {
    const stats = emptyStats();
    // 2 entries in byServer but total = 0 → MCP scoring block skipped, mcpServers.length=2, stage<4
    stats.last30Days.mcpTools.total = 0;
    stats.last30Days.mcpTools.byServer = { 'GitHub MCP': 0, 'Jira MCP': 0 };
    stats.last30Days.toolCalls.byTool = { run_in_terminal: 1 }; // 1 non-auto tool → Stage 2
    const result = await calculateMaturityScores(undefined, async () => stats);
    const tu = result.categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage < 4, `expected TU < 4 (no MCP total), got ${tu.stage}`);
    assert.ok(tu.tips.some(t => t.toLowerCase().includes('multiple mcp')), 'tip should mention multiple MCP servers');
});

// 25 tests


// ===========================================================================
// 25 Targeted Tests for maturityScoring.ts Uncovered Branches
// ===========================================================================

// --- Model Switching Tests (3) ---

test('PE: switchingFrequency > 0 with mixedTierSessions qualifies for model switching', () => {
    const fd = emptyFd();
    fd.switchingFreqSum = 100;
    fd.switchingFreqCount = 5;
    fd.mixedTierSessions = 1;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3);
});

test('PE: mixedCostSessions > 0 triggers model switching boost to Stage 3', () => {
    const fd = emptyFd();
    fd.mixedCostSessions = 1;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3);
});

test('PE: mixedTierSessions > 0 triggers model switching boost to Stage 3', () => {
    const fd = emptyFd();
    fd.mixedTierSessions = 1;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3);
});

// --- Image/PromptFile Boosters Tests (3) ---

test('CE: copilot.image in ctxByKind boosts to Stage 3', () => {
    const fd = emptyFd();
    fd.ctxFile = 1;
    fd.ctxByKind = { 'copilot.image': 1 };
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3);
});

test('CE: promptFile in ctxByKind boosts to Stage 3', () => {
    const fd = emptyFd();
    fd.ctxFile = 1;
    fd.ctxByKind = { promptFile: 1 };
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3);
});

test('CE: both copilot.image and promptFile boost to Stage 3', () => {
    const fd = emptyFd();
    fd.ctxFile = 1;
    fd.ctxByKind = { 'copilot.image': 1, promptFile: 1 };
    const ce = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.stage >= 3);
});

// --- Multi-file Edits Tests (3) ---

test('AG: multiFileEdits > 0 boosts to Stage 2', () => {
    const fd = emptyFd();
    fd.multiFileEdits = 1;
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 2);
});

test('AG: multiFileEdits >= 20 + avgFilesPerSession >= 3 reaches Stage 4', () => {
    const fd = emptyFd();
    fd.multiFileEdits = 20;
    fd.filesPerEditSum = 60;
    fd.filesPerEditCount = 20;
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.equal(ag.stage, 4);
});

test('AG: filesPerEditCount = 0 avoids division by zero', () => {
    const fd = emptyFd();
    fd.multiFileEdits = 5;
    fd.filesPerEditSum = 0;
    fd.filesPerEditCount = 0;
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 2);
});

// --- MCP Server Detection Tests (2) ---

test('TU: mcpTotal > 0 boosts to Stage 3', () => {
    const fd = emptyFd();
    fd.mcpTotal = 1;
    fd.mcpByServer = { 'GitHub MCP': 1 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 3);
});

test('TU: 2+ MCP servers reaches Stage 4', () => {
    const fd = emptyFd();
    fd.mcpTotal = 5;
    fd.mcpByServer = { 'GitHub MCP': 3, 'Jira MCP': 2 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.equal(tu.stage, 4);
});

// --- Apply Rate Calculations Tests (2) ---

test('WI: applyRateCount = 0 avoids division by zero', () => {
    const fd = emptyFd();
    fd.applyRateSum = 0;
    fd.applyRateCount = 0;
    fd.sessionCount = 3;
    const wi = calculateFluencyScoreForTeamMember(fd, 3).categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 2);
});

test('WI: avgApplyRate >= 50 boosts to Stage 2', () => {
    const fd = emptyFd();
    fd.applyRateSum = 100;
    fd.applyRateCount = 2;
    fd.sessionCount = 3;
    const wi = calculateFluencyScoreForTeamMember(fd, 3).categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 2);
});

// --- Customization Stages Tests (2) ---

test('CU: 0 repos stays Stage 1', () => {
    const fd = emptyFd();
    const cu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Customization')!;
    assert.equal(cu.stage, 1);
});

test('CU: 3 unique models across all cost tiers boosts to Stage 3', () => {
    const fd = emptyFd();
    fd.standardModels = new Set(['gpt-4o']);
    fd.premiumModels = new Set(['gpt-4-turbo']);
    fd.lowCostModels = new Set(['gpt-4o-mini']);
    const cu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Customization')!;
    assert.ok(cu.stage >= 3);
});

// --- Session Duration Tests (2) ---

test('WI: session duration included when durationMsSum > 0', () => {
    const fd = emptyFd();
    fd.sessionCount = 5;
    fd.durationMsSum = 300000;
    fd.durationMsCount = 5;
    const wi = calculateFluencyScoreForTeamMember(fd, 5).categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 2);
});

test('WI: durationMsCount = 0 avoids division by zero', () => {
    const fd = emptyFd();
    fd.sessionCount = 5;
    fd.durationMsSum = 0;
    fd.durationMsCount = 0;
    const wi = calculateFluencyScoreForTeamMember(fd, 5).categories.find(c => c.category === 'Workflow Integration')!;
    assert.ok(wi.stage >= 2);
});

// --- Automatic vs Non-Automatic Tools Tests (2) ---

test('TU: all automatic tools returns Stage 1', () => {
    const fd = emptyFd();
    fd.toolCallsByTool = { read_file: 5, list_directory: 3, grep: 2 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.equal(tu.stage, 1);
});

test('TU: mixed automatic and non-automatic tools', () => {
    const fd = emptyFd();
    fd.toolCallsByTool = { read_file: 5, editFiles: 3, run_in_terminal: 2 };
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 2);
});

// --- Slash Command Detection Tests (2) ---

test('PE: VS Code slash commands detected', () => {
    const fd = emptyFd();
    fd.askModeCount = 30;
    fd.toolCallsByTool = { explain: 2, fix: 1, tests: 1 };
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3);
});

test('PE: Claude slash commands with __slash__ prefix detected', () => {
    const fd = emptyFd();
    fd.askModeCount = 30;
    fd.toolCallsByTool = { __slash__review: 1, __slash__bug: 1, __slash__think: 1 };
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 3);
});

// --- Additional Edge Cases (2) ---

test('PE: switchingFreqCount = 0 avoids division by zero', () => {
    const fd = emptyFd();
    fd.switchingFreqSum = 100;
    fd.switchingFreqCount = 0;
    const pe = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Prompt Engineering')!;
    assert.ok(pe.stage >= 1);
});

test('TU: workspaceAgentCount > 0 boosts to Stage 3', () => {
    const fd = emptyFd();
    fd.workspaceAgentCount = 1;
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.ok(tu.stage >= 3);
});


test('AG: editsAgentCount > 0 boosts to Stage 2', () => {
    const fd = emptyFd();
    fd.editsAgentCount = 1;
    const ag = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Agentic')!;
    assert.ok(ag.stage >= 2);
});

test('TU: mcpTotal = 0 with empty mcpByServer stays Stage 1', () => {
    const fd = emptyFd();
    fd.mcpTotal = 0;
    fd.mcpByServer = {};
    const tu = calculateFluencyScoreForTeamMember(fd, 0).categories.find(c => c.category === 'Tool Usage')!;
    assert.equal(tu.stage, 1);
});

test('fmt: formats numbers with thousand separators in evidence', async () => {
    const stats = emptyStats();
    stats.last30Days.contextReferences.file = 1500;
    const result = await calculateMaturityScores(undefined, async () => stats);
    const ce = result.categories.find(c => c.category === 'Context Engineering')!;
    assert.ok(ce.evidence.some(e => e.includes('1,500')), 'evidence should format 1500 as 1,500');
});

test('topReposMissingCustomization: only rows whose known statuses are all missing, most active first', () => {
    const row = (name: string, interactions: number, typeStatuses: Record<string, '✅' | '⚠️' | '❌'>, workspacePath = `/code/${name}`) =>
        ({ workspacePath, workspaceName: name, sessionCount: 1, interactionCount: interactions, typeStatuses });
    const matrix: WorkspaceCustomizationMatrix = {
        customizationTypes: [{ id: 'instructions', icon: '📋', label: 'Instructions' }],
        workspaces: [
            row('customized', 900, { instructions: '✅' }),
            row('no-data', 800, {}), // unknown, not missing: never recommended
            row('missing-busy', 500, { instructions: '❌' }),
            row('missing-quiet', 10, { instructions: '❌', agents: '❌' }),
            row('stale', 400, { instructions: '⚠️' }),
            row('unresolved', 999, { instructions: '❌' }, '<unresolved:abc>'),
        ],
        totalWorkspaces: 6,
        workspacesWithIssues: 2,
    };
    assert.deepEqual(topReposMissingCustomization(matrix).map(r => r.workspaceName), ['missing-busy', 'missing-quiet']);
    assert.deepEqual(topReposMissingCustomization(matrix, 1).map(r => r.workspaceName), ['missing-busy']);
    assert.deepEqual(topReposMissingCustomization(undefined), []);
});
