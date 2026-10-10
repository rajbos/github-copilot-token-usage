/**
 * Shared type definitions used across multiple webview panels.
 */

/** Token usage breakdown by model. */
export type ModelUsage = Record<string, { inputTokens: number; outputTokens: number }>;

/** Individual level descriptor used in fluency/maturity category level data. */
export type LevelInfo = {
	stage: number;
	label: string;
	description: string;
	thresholds: string[];
	tips: string[];
};

/** Category level data used in fluency level viewer and maturity webviews. */
export type CategoryLevelData = {
	category: string;
	icon: string;
	levels: LevelInfo[];
};

export type ModeUsage = { ask: number; edit: number; agent: number; plan: number; customAgent: number; cli: number; cliApp?: number; claudeDesktop?: number; claudeVsCode?: number };

/**
 * ModeUsage keys computed from session *content* (not just path) that distinguish an
 * interaction surface the coarse per-file editor label can't see on its own — e.g. a
 * Copilot CLI session launched via the desktop app, or a Claude Code session embedded
 * in VS Code vs. the standalone desktop app.
 *
 * If you add a new key here, also update `SYNCED_INTERACTION_MODE_LABELS` in
 * `src/workspaceHelpers.ts` (repo root) so the sharing-server sync's per-file editor
 * label picks it up too — `workspaceHelpers.test.ts` locks these two lists together
 * and fails the build if they diverge.
 */
export const MODE_USAGE_CONTENT_CLASSIFIED_KEYS = ['cliApp', 'claudeDesktop', 'claudeVsCode'] as const;
/** Mirror of `LatencyHistogram` in `src/types.ts` (repo root). */
export type LatencyHistogram = { count: number; sumMs: number; buckets: number[] };
export type ToolCallUsage = {
	total: number;
	byTool: { [key: string]: number };
	outputTokensByTool?: { [key: string]: number };
	completedByTool?: { [key: string]: number };
	failuresByTool?: { [key: string]: number };
	latencyByTool?: { [key: string]: LatencyHistogram };
};
export type McpToolUsage = {
	total: number;
	byServer: { [key: string]: number };
	byTool: { [key: string]: number };
	completedByServer?: { [key: string]: number };
	failuresByServer?: { [key: string]: number };
	latencyByServer?: { [key: string]: LatencyHistogram };
};

/** Common fields shared across all webviews that display model-switching data. */
export type ModelSwitchingAnalysis = {
	modelsPerSession: number[];
	totalSessions: number;
	averageModelsPerSession: number;
	maxModelsPerSession: number;
	switchingFrequency: number;
	standardModels: string[];
	premiumModels: string[];
	unknownModels: string[];
	mixedTierSessions: number;
	lowCostModels: string[];
	mediumCostModels: string[];
	highCostModels: string[];
	mixedCostSessions: number;
	lowCostRequests?: number;
	mediumCostRequests?: number;
	highCostRequests?: number;
	standardRequests?: number;
	premiumRequests?: number;
	unknownRequests?: number;
	totalRequests?: number;
};
