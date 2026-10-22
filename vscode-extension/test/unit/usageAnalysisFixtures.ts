import { createEmptyTaskClassificationResult } from '../../../src/taskClassification';
import type { SessionUsageAnalysis, ContextReferenceUsage } from '../../../src/types';

export function emptyRefs(): ContextReferenceUsage {
    return {
        file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
        workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0,
        terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0,
        problemsPanel: 0, pullRequest: 0, codeContextLines: 0, byKind: {}, byPath: {}, copilotInstructions: 0, agentsMd: 0,
    };
}

export function emptyAnalysis(): SessionUsageAnalysis {
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
