// Pure aggregation of a session-log payload into the log-viewer's summary-card stats.
// Extracted from main.ts (which has module-load side effects — DOM access,
// dynamic imports — and so cannot itself be imported by unit tests).
import { ContextReferenceUsage, getTotalContextRefs, getImplicitContextRefs, getExplicitContextRefs } from '../shared/contextRefUtils';
import type { McpToolUsage, ModeUsage, ToolCallUsage } from '../shared/types';

/** The modes `aggregateModeStats` initializes counters for (excludes ModeUsage's optional content-derived keys). */
export type AggregatedMode = 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' | 'cli';

/** The subset of a chat turn that stats aggregation reads. */
export type SummaryStatsTurn = {
	mode: AggregatedMode;
	toolCalls: { isSubAgent?: boolean }[];
	mcpTools: unknown[];
	inputTokensEstimate: number;
	outputTokensEstimate: number;
	thinkingTokensEstimate: number;
	actualUsage?: {
		completionTokens: number;
		promptTokens: number;
		promptTokenDetails?: { category: string; label: string; percentageOfPrompt: number }[];
	};
};

/** The subset of the session-log payload that stats aggregation reads. */
export type SummaryStatsSource = {
	turns: SummaryStatsTurn[];
	contextReferences: ContextReferenceUsage;
	usageAnalysis?: {
		toolCalls: ToolCallUsage;
		mcpTools: McpToolUsage;
		contextReferences: ContextReferenceUsage;
		thinkingEffort?: ThinkingEffortUsage;
	};
	actualTokens?: number;
};

export type ThinkingEffortUsage = { byEffort: { [effort: string]: number }; switchCount: number; defaultEffort: string | null };

/** Aggregated prompt-breakdown entry accumulated across all turns in a session. */
export type BreakdownEntry = {
category: string;
label: string;
totalTokens: number;
totalPct: number;
count: number;
};


/** Pre-computed statistics passed to `renderSummaryCards`. */
export type SummaryStats = {
totalTokens: number;
totalThinkingTokens: number;
totalSubAgentCalls: number;
turnsWithThinking: number;
hasAnyActualUsage: boolean;
hasSessionActualOnly: boolean;
actualTotal: number;
actualPromptTotal: number;
actualCompletionTotal: number;
sessionActualTokens: number;
usageToolTotal: number;
usageTopTools: { key: string; value: number }[];
usageMcpTotal: number;
usageTopMcpTools: { key: string; value: number }[];
usageContextTotal: number;
usageContextImplicit: number;
usageContextExplicit: number;
sessionEffort: ThinkingEffortUsage | undefined;
effortDefaultLabel: string;
effortSummary: string;
modeEntries: [keyof ModeUsage, number][];
totalModeTurns: number;
primaryModeLabel: string;
modeSubLabel: string;
};


export const EFFORT_DISPLAY_NAMES: Record<string, string> = {
xhigh: 'Extra High',
};

/** Human-readable labels for each editor mode. */
export const MODE_LABELS: Record<string, string> = {
ask: 'Ask', edit: 'Edit', agent: 'Agent', plan: 'Plan', customAgent: 'Custom Agent', cli: 'CLI'
};


export function getEffortDisplayName(level: string): string {
return EFFORT_DISPLAY_NAMES[level] ?? level;
}


export function getTopEntries(map: { [key: string]: number } = {}, limit = 3): { key: string; value: number }[] {
return Object.entries(map)
.sort((a, b) => b[1] - a[1])
.slice(0, limit)
.map(([key, value]) => ({ key, value }));
}

export function getModeIcon(mode: string): string {
switch (mode) {
case 'ask': return '💬';
case 'edit': return '✏️';
case 'agent': return '🤖';
case 'plan': return '📋';
case 'customAgent': return '⚡';
case 'cli': return '🖥️';
default: return '❓';
}
}


export type TokenStats = {
	totalTokens: number;
	totalThinkingTokens: number;
	totalSubAgentCalls: number;
	turnsWithThinking: number;
	usageToolTotal: number;
	usageTopTools: { key: string; value: number }[];
	usageMcpTotal: number;
	usageTopMcpTools: { key: string; value: number }[];
	usageContextTotal: number;
	usageContextImplicit: number;
	usageContextExplicit: number;
	sessionEffort: ThinkingEffortUsage | undefined;
	effortDefaultLabel: string;
	effortSummary: string;
};

export function resolveSessionEffort(sessionEffort: ThinkingEffortUsage | undefined): { effortDefaultLabel: string; effortSummary: string } {
	const effortDefault = sessionEffort?.defaultEffort ?? (sessionEffort ? Object.keys(sessionEffort.byEffort)[0] : undefined);
	const effortDefaultLabel = effortDefault ? getEffortDisplayName(effortDefault) : '—';
	const effortSummary = sessionEffort
		? Object.entries(sessionEffort.byEffort).map(([k, v]) => `${getEffortDisplayName(k)}: ${v}`).join(', ')
		: '';
	return { effortDefaultLabel, effortSummary };
}

export function aggregateTokenStats(data: SummaryStatsSource): TokenStats {
	const totalTokens = data.turns.reduce((sum, t) => sum + t.inputTokensEstimate + t.outputTokensEstimate + t.thinkingTokensEstimate, 0);
	const totalThinkingTokens = data.turns.reduce((sum, t) => sum + t.thinkingTokensEstimate, 0);
	const totalToolCalls = data.turns.reduce((sum, t) => sum + t.toolCalls.filter(tc => !tc.isSubAgent).length, 0);
	const totalSubAgentCalls = data.turns.reduce((sum, t) => sum + t.toolCalls.filter(tc => tc.isSubAgent).length, 0);
	const totalMcpTools = data.turns.reduce((sum, t) => sum + t.mcpTools.length, 0);
	const turnsWithThinking = data.turns.filter(t => t.thinkingTokensEstimate > 0).length;
	const usage = data.usageAnalysis;
	const sessionEffort = usage?.thinkingEffort;
	const usageToolTotal = usage?.toolCalls?.total ?? totalToolCalls;
	const usageTopTools = usage ? getTopEntries(usage.toolCalls.byTool, 3) : [];
	const usageMcpTotal = usage?.mcpTools?.total ?? totalMcpTools;
	const usageTopMcpTools = usage ? getTopEntries(usage.mcpTools.byTool, 3) : [];
	const usageContextRefs = usage?.contextReferences || data.contextReferences;
	const usageContextTotal = getTotalContextRefs(usageContextRefs);
	const usageContextImplicit = getImplicitContextRefs(usageContextRefs);
	const usageContextExplicit = getExplicitContextRefs(usageContextRefs);
	const { effortDefaultLabel, effortSummary } = resolveSessionEffort(sessionEffort);
	return {
		totalTokens, totalThinkingTokens, totalSubAgentCalls, turnsWithThinking,
		usageToolTotal, usageTopTools, usageMcpTotal, usageTopMcpTools,
		usageContextTotal, usageContextImplicit, usageContextExplicit,
		sessionEffort, effortDefaultLabel, effortSummary,
	};
}

export type ActualUsageStats<T extends SummaryStatsTurn = SummaryStatsTurn> = {
	turnsWithActual: T[];
	hasAnyActualUsage: boolean;
	actualPromptTotal: number;
	actualCompletionTotal: number;
	actualTotal: number;
	sessionActualTokens: number;
	hasSessionActualOnly: boolean;
	aggregatedBreakdown: { [key: string]: BreakdownEntry };
};

export function aggregateActualUsageStats<T extends SummaryStatsTurn>(data: { turns: T[]; actualTokens?: number }): ActualUsageStats<T> {
	const turnsWithActual = data.turns.filter(t => t.actualUsage);
	const hasAnyActualUsage = turnsWithActual.length > 0;
	const actualPromptTotal = turnsWithActual.reduce((s, t) => s + (t.actualUsage?.promptTokens || 0), 0);
	const actualCompletionTotal = turnsWithActual.reduce((s, t) => s + (t.actualUsage?.completionTokens || 0), 0);
	const actualTotal = actualPromptTotal + actualCompletionTotal;
	const sessionActualTokens = data.actualTokens || 0;
	const hasSessionActualOnly = !hasAnyActualUsage && sessionActualTokens > 0;
	const aggregatedBreakdown: { [key: string]: BreakdownEntry } = {};
	for (const turn of turnsWithActual) {
		if (turn.actualUsage?.promptTokenDetails) {
			for (const detail of turn.actualUsage.promptTokenDetails) {
				const key = `${detail.category}|${detail.label}`;
				if (!aggregatedBreakdown[key]) {
					aggregatedBreakdown[key] = { category: detail.category, label: detail.label, totalTokens: 0, totalPct: 0, count: 0 };
				}
				const deducedTokens = Math.round((turn.actualUsage?.promptTokens || 0) * detail.percentageOfPrompt / 100);
				aggregatedBreakdown[key].totalTokens += deducedTokens;
				aggregatedBreakdown[key].totalPct += detail.percentageOfPrompt;
				aggregatedBreakdown[key].count++;
			}
		}
	}
	return { turnsWithActual, hasAnyActualUsage, actualPromptTotal, actualCompletionTotal, actualTotal, sessionActualTokens, hasSessionActualOnly, aggregatedBreakdown };
}

export type ModeStats = {
	modeEntries: [keyof ModeUsage, number][];
	totalModeTurns: number;
	primaryModeLabel: string;
	modeSubLabel: string;
};

export function aggregateModeStats(data: SummaryStatsSource): ModeStats {
	const modeUsage: ModeUsage = { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 };
	for (const turn of data.turns) {
		modeUsage[turn.mode]++;
	}
	const modeEntries = (Object.entries(modeUsage) as [keyof typeof modeUsage, number][])
		.filter(([, n]) => n > 0)
		.sort((a, b) => b[1] - a[1]);
	const totalModeTurns = modeEntries.reduce((s, [, n]) => s + n, 0);
	const primaryMode = modeEntries[0];
	const primaryModeLabel = primaryMode ? `${getModeIcon(primaryMode[0])} ${MODE_LABELS[primaryMode[0]]}` : '—';
	const modeSubLabel = modeEntries.length <= 1
		? (totalModeTurns === 1 ? '1 turn' : `${totalModeTurns} turns`)
		: `mixed across ${totalModeTurns} turns`;
	return { modeEntries, totalModeTurns, primaryModeLabel, modeSubLabel };
}

export function buildSummaryStats(
	tokenStats: ReturnType<typeof aggregateTokenStats>,
	actualStats: ActualUsageStats,
	modeStats: ReturnType<typeof aggregateModeStats>,
): SummaryStats {
	return {
		totalTokens: tokenStats.totalTokens,
		totalThinkingTokens: tokenStats.totalThinkingTokens,
		totalSubAgentCalls: tokenStats.totalSubAgentCalls,
		turnsWithThinking: tokenStats.turnsWithThinking,
		usageToolTotal: tokenStats.usageToolTotal,
		usageTopTools: tokenStats.usageTopTools,
		usageMcpTotal: tokenStats.usageMcpTotal,
		usageTopMcpTools: tokenStats.usageTopMcpTools,
		usageContextTotal: tokenStats.usageContextTotal,
		usageContextImplicit: tokenStats.usageContextImplicit,
		usageContextExplicit: tokenStats.usageContextExplicit,
		sessionEffort: tokenStats.sessionEffort,
		effortDefaultLabel: tokenStats.effortDefaultLabel,
		effortSummary: tokenStats.effortSummary,
		hasAnyActualUsage: actualStats.hasAnyActualUsage,
		hasSessionActualOnly: actualStats.hasSessionActualOnly,
		actualTotal: actualStats.actualTotal,
		actualPromptTotal: actualStats.actualPromptTotal,
		actualCompletionTotal: actualStats.actualCompletionTotal,
		sessionActualTokens: actualStats.sessionActualTokens,
		modeEntries: modeStats.modeEntries,
		totalModeTurns: modeStats.totalModeTurns,
		primaryModeLabel: modeStats.primaryModeLabel,
		modeSubLabel: modeStats.modeSubLabel,
	};
}
