/**
 * Shared helper functions for CLI commands.
 * Handles session file discovery, parsing, and stats aggregation.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { SessionDiscovery } from '../../vscode-extension/src/sessionDiscovery';
import { OpenCodeDataAccess } from '../../vscode-extension/src/opencode';
import { CrushDataAccess } from '../../vscode-extension/src/crush';
import { ContinueDataAccess } from '../../vscode-extension/src/continue';
import { VisualStudioDataAccess } from '../../vscode-extension/src/visualstudio';
import { parseSessionFileContent } from '../../vscode-extension/src/sessionParser';
import { estimateTokensFromText, getModelFromRequest, isJsonlContent, estimateTokensFromJsonlSession, calculateEstimatedCost, getModelTier } from '../../vscode-extension/src/tokenEstimation';
import type { DetailedStats, PeriodStats, ModelUsage, EditorUsage, SessionFileCache, UsageAnalysisStats, UsageAnalysisPeriod } from '../../vscode-extension/src/types';
import { analyzeSessionUsage, mergeUsageAnalysis, calculateModelSwitching, trackEnhancedMetrics } from '../../vscode-extension/src/usageAnalysis';
import { createEmptyContextRefs } from '../../vscode-extension/src/tokenEstimation';
import * as vscodeStub from './vscode-stub';
import { loadCache, saveCache, disableCache, getCached, setCached, getCacheStats } from './cliCache';

// Import JSON data files
import tokenEstimatorsData from '../../vscode-extension/src/tokenEstimators.json';
import modelPricingData from '../../vscode-extension/src/modelPricing.json';
import toolNamesData from '../../vscode-extension/src/toolNames.json';

// Environmental impact constants (from extension.ts)
const CO2_PER_1K_TOKENS = 0.2;           // gCO2e per 1000 tokens
const CO2_ABSORPTION_PER_TREE_PER_YEAR = 21000; // grams CO2 per tree/year
const WATER_USAGE_PER_1K_TOKENS = 0.3;   // liters per 1000 tokens

const tokenEstimators: { [key: string]: number } = tokenEstimatorsData.estimators;
const modelPricing = modelPricingData.pricing as { [key: string]: any };
const toolNameMap = toolNamesData as { [key: string]: string };

/** Logging functions for the CLI context */
const log = (msg: string) => { /* quiet by default */ };
const warn = (msg: string) => { /* quiet by default */ };
const error = (msg: string, err?: any) => console.error(chalk.red(msg), err || '');

/** Create OpenCode data access instance for CLI */
function createOpenCode(): OpenCodeDataAccess {
	const fakeUri = vscodeStub.Uri.file(__dirname);
	return new OpenCodeDataAccess(fakeUri as any);
}

/** Create Crush data access instance for CLI */
function createCrush(): CrushDataAccess {
	const fakeUri = vscodeStub.Uri.file(__dirname);
	return new CrushDataAccess(fakeUri as any);
}

/** Create Continue data access instance for CLI */
function createContinue(): ContinueDataAccess {
	return new ContinueDataAccess();
}

/** Create Visual Studio data access instance for CLI */
function createVisualStudio(): VisualStudioDataAccess {
	return new VisualStudioDataAccess();
}

// Module-level singletons so sql.js WASM is only initialised once across all session files
const _openCodeInstance = createOpenCode();
const _crushInstance = createCrush();
const _continueInstance = createContinue();
const _visualStudioInstance = createVisualStudio();

/** Create session discovery instance for CLI */
function createSessionDiscovery(): SessionDiscovery {
	return new SessionDiscovery({ log, warn, error, openCode: _openCodeInstance, crush: _crushInstance, continue_: _continueInstance, visualStudio: _visualStudioInstance });
}

/** Discover all session files on this machine */
export async function discoverSessionFiles(): Promise<string[]> {
	const discovery = createSessionDiscovery();
	return discovery.getCopilotSessionFiles();
}

/** Get diagnostic candidate paths info */
export function getDiagnosticPaths(): { path: string; exists: boolean; source: string }[] {
	const discovery = createSessionDiscovery();
	return discovery.getDiagnosticCandidatePaths();
}

/**
 * Token estimation wrapper that uses the shared tokenEstimators data.
 */
function estimateTokens(text: string, model?: string): number {
	return estimateTokensFromText(text, model || 'gpt-4', tokenEstimators);
}

/**
 * Model resolver wrapper.
 */
function resolveModel(request: any): string {
	return getModelFromRequest(request, modelPricing);
}

/**
 * Check if a session file path is an OpenCode DB virtual path.
 */
function isOpenCodeDbSession(filePath: string): boolean {
	return filePath.includes('opencode.db#ses_');
}

/**
 * Check if a session file path is a Crush DB virtual path.
 */
function isCrushSessionFile(filePath: string): boolean {
	return _crushInstance.isCrushSessionFile(filePath);
}

/**
 * Stat a session file, handling DB virtual paths (OpenCode and Crush).
 * Virtual DB paths are resolved to the actual DB file.
 */
async function statSessionFile(filePath: string): Promise<fs.Stats> {
	if (isCrushSessionFile(filePath)) {
		return _crushInstance.statSessionFile(filePath);
	}
	if (isOpenCodeDbSession(filePath)) {
		const dbPath = filePath.split('#')[0];
		return fs.promises.stat(dbPath);
	}
	return fs.promises.stat(filePath);
}

/** Determine editor source from file path */
function getEditorSourceFromPath(filePath: string): string {
	const normalized = filePath.toLowerCase().replace(/\\/g, '/');
	if (normalized.includes('/cursor/')) { return 'cursor'; }
	if (normalized.includes('/code - insiders/')) { return 'vscode-insiders'; }
	if (normalized.includes('/code - exploration/')) { return 'vscode-exploration'; }
	if (normalized.includes('/vscodium/')) { return 'vscodium'; }
	if (normalized.includes('/.copilot/')) { return 'copilot-cli'; }
	if (normalized.includes('/.crush/crush.db#')) { return 'crush'; }
	if (normalized.includes('/opencode/')) { return 'opencode'; }
	if (normalized.includes('.vscode-server')) { return 'vscode-remote'; }
        if (normalized.includes('/.vs/') && normalized.includes('/copilot-chat/')) { return 'Visual Studio'; }
	return 'vscode';
}

export interface SessionData {
	file: string;
	tokens: number;
	thinkingTokens: number;
	interactions: number;
	modelUsage: ModelUsage;
	lastModified: Date;
	editorSource: string;
}

/**
 * Process a single session file and extract its data.
 */
export async function processSessionFile(filePath: string): Promise<SessionData | null> {
	try {
		const stats = await statSessionFile(filePath);

		// Check the cache before doing any parsing
		const cached = getCached(filePath, stats.mtimeMs, stats.size);
		if (cached) {
			return cached;
		}

		// Handle Crush DB virtual paths directly via the crush module
		if (isCrushSessionFile(filePath)) {
			const result = await _crushInstance.getTokensFromCrushSession(filePath);
			const interactions = await _crushInstance.countCrushInteractions(filePath);
			const modelUsage = await _crushInstance.getCrushModelUsage(filePath);
const crushResult: SessionData = {
			file: filePath,
			tokens: result.tokens,
			thinkingTokens: result.thinkingTokens,
			interactions,
			modelUsage,
			lastModified: stats.mtime,
			editorSource: getEditorSourceFromPath(filePath),
		};
			setCached(filePath, stats.mtimeMs, stats.size, crushResult);
			return crushResult;
		}

		// Handle OpenCode DB virtual paths directly via the opencode module
		if (isOpenCodeDbSession(filePath)) {
			const result = await _openCodeInstance.getTokensFromOpenCodeSession(filePath);
			const interactions = await _openCodeInstance.countOpenCodeInteractions(filePath);
			const modelUsage = await _openCodeInstance.getOpenCodeModelUsage(filePath);
			const openCodeResult: SessionData = {
				file: filePath,
				tokens: result.tokens,
				thinkingTokens: result.thinkingTokens,
				interactions,
				modelUsage,
				lastModified: stats.mtime,
				editorSource: getEditorSourceFromPath(filePath),
			};
			setCached(filePath, stats.mtimeMs, stats.size, openCodeResult);
			return openCodeResult;
		}

                // Handle Visual Studio session files (binary MessagePack)
                if (_visualStudioInstance.isVSSessionFile(filePath)) {
                        const result = _visualStudioInstance.getTokenEstimates(filePath, estimateTokens);
                        const objects = _visualStudioInstance.decodeSessionFile(filePath);
                        const interactions = _visualStudioInstance.countInteractions(objects);
                        const modelUsage = _visualStudioInstance.getModelUsage(filePath, estimateTokens);
                        const vsResult: SessionData = {
                                file: filePath,
                                tokens: result.tokens,
                                thinkingTokens: result.thinkingTokens,
                                interactions,
                                modelUsage,
                                lastModified: stats.mtime,
                                editorSource: getEditorSourceFromPath(filePath),
                        };
                        setCached(filePath, stats.mtimeMs, stats.size, vsResult);
                        return vsResult;
                }

		const content = await fs.promises.readFile(filePath, 'utf-8');

		if (!content.trim()) {
			return null;
		}

		const isJsonl = filePath.endsWith('.jsonl') || isJsonlContent(content);

		let tokens = 0;
		let thinkingTokens = 0;
		let interactions = 0;
		let fileModelUsage: ModelUsage = {};

		if (isJsonl) {
			const result = estimateTokensFromJsonlSession(content);
			tokens = result.tokens;
			thinkingTokens = result.thinkingTokens;

			// Count interactions from JSONL
			const lines = content.trim().split('\n');
			for (const line of lines) {
				try {
					const event = JSON.parse(line);
					if (event.type === 'user.message' || (event.kind === 2 && event.k?.[0] === 'requests')) {
						interactions++;
					}
				} catch {
					// skip
				}
			}
		} else {
			const result = parseSessionFileContent(
				filePath,
				content,
				estimateTokens,
				resolveModel
			);
			tokens = result.tokens;
			thinkingTokens = result.thinkingTokens;
			interactions = result.interactions;
			fileModelUsage = result.modelUsage as ModelUsage;
		}

		const sessionData: SessionData = {
			file: filePath,
			tokens,
			thinkingTokens,
			interactions,
			modelUsage: fileModelUsage,
			lastModified: stats.mtime,
			editorSource: getEditorSourceFromPath(filePath),
		};
		setCached(filePath, stats.mtimeMs, stats.size, sessionData);
		return sessionData;
	} catch {
		return null;
	}
}

/**
 * Calculate detailed statistics across all time periods.
 */
export async function calculateDetailedStats(
	sessionFiles: string[],
	progressCallback?: (completed: number, total: number) => void
): Promise<DetailedStats> {
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
	const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
	const last30DaysStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);

	const periods: {
		today: PeriodStats;
		month: PeriodStats;
		lastMonth: PeriodStats;
		last30Days: PeriodStats;
	} = {
		today: createEmptyPeriodStats(),
		month: createEmptyPeriodStats(),
		lastMonth: createEmptyPeriodStats(),
		last30Days: createEmptyPeriodStats(),
	};

	let processed = 0;
	for (const file of sessionFiles) {
		const data = await processSessionFile(file);
		processed++;
		if (progressCallback) {
			progressCallback(processed, sessionFiles.length);
		}

		if (!data || data.tokens === 0) {
			continue;
		}

		const modified = data.lastModified;

		// Skip files older than the last month's start
		if (modified < lastMonthStart) {
			continue;
		}

		// Aggregate into appropriate periods
		if (modified >= todayStart) {
			aggregateIntoPeriod(periods.today, data);
		}
		if (modified >= monthStart) {
			aggregateIntoPeriod(periods.month, data);
		}
		if (modified >= lastMonthStart && modified <= lastMonthEnd) {
			aggregateIntoPeriod(periods.lastMonth, data);
		}
		if (modified >= last30DaysStart) {
			aggregateIntoPeriod(periods.last30Days, data);
		}
	}

	// Compute derived stats
	for (const period of Object.values(periods)) {
		if (period.sessions > 0) {
			period.avgTokensPerSession = Math.round(period.tokens / period.sessions);
		}
		period.co2 = (period.tokens / 1000) * CO2_PER_1K_TOKENS;
		period.treesEquivalent = period.co2 / CO2_ABSORPTION_PER_TREE_PER_YEAR;
		period.waterUsage = (period.tokens / 1000) * WATER_USAGE_PER_1K_TOKENS;
		period.estimatedCost = calculateEstimatedCost(period.modelUsage, modelPricing);
	}

	return {
		...periods,
		lastUpdated: now,
	};
}

function createEmptyPeriodStats(): PeriodStats {
	return {
		tokens: 0,
		thinkingTokens: 0,
		estimatedTokens: 0,
		actualTokens: 0,
		sessions: 0,
		avgInteractionsPerSession: 0,
		avgTokensPerSession: 0,
		modelUsage: {},
		editorUsage: {},
		co2: 0,
		treesEquivalent: 0,
		waterUsage: 0,
		estimatedCost: 0,
	};
}

function aggregateIntoPeriod(period: PeriodStats, data: SessionData): void {
	period.tokens += data.tokens;
	period.thinkingTokens += data.thinkingTokens;
	period.estimatedTokens += data.tokens;
	period.sessions++;

	// Merge model usage
	for (const [model, usage] of Object.entries(data.modelUsage)) {
		if (!period.modelUsage[model]) {
			period.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
		}
		period.modelUsage[model].inputTokens += usage.inputTokens;
		period.modelUsage[model].outputTokens += usage.outputTokens;
	}

	// Track interactions
	const totalInteractions = period.avgInteractionsPerSession * (period.sessions - 1) + data.interactions;
	period.avgInteractionsPerSession = period.sessions > 0 ? totalInteractions / period.sessions : 0;

	// Editor usage
	if (!period.editorUsage[data.editorSource]) {
		period.editorUsage[data.editorSource] = { tokens: 0, sessions: 0 };
	}
	period.editorUsage[data.editorSource].tokens += data.tokens;
	period.editorUsage[data.editorSource].sessions++;
}

/**
 * Calculate usage analysis stats for fluency scoring.
 * This is a simplified version that uses the shared usageAnalysis module.
 */
export async function calculateUsageAnalysisStats(sessionFiles: string[]): Promise<UsageAnalysisStats> {
	const deps = {
		warn,
		openCode: _openCodeInstance,
		crush: _crushInstance,
		visualStudio: _visualStudioInstance,
		tokenEstimators,
		modelPricing,
		toolNameMap,
	};

	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const last30DaysStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

	const todayPeriod = createEmptyUsageAnalysisPeriod();
	const last30DaysPeriod = createEmptyUsageAnalysisPeriod();
	const monthPeriod = createEmptyUsageAnalysisPeriod();

	for (const file of sessionFiles) {
		try {
			const stats = await statSessionFile(file);
			const modified = stats.mtime;

			if (modified < last30DaysStart) {
				continue;
			}

			const analysis = await analyzeSessionUsage(deps, file);

			if (modified >= last30DaysStart) {
				mergeUsageAnalysis(last30DaysPeriod, analysis);
				last30DaysPeriod.sessions++;
			}
			if (modified >= monthStart) {
				mergeUsageAnalysis(monthPeriod, analysis);
				monthPeriod.sessions++;
			}
			if (modified >= todayStart) {
				mergeUsageAnalysis(todayPeriod, analysis);
				todayPeriod.sessions++;
			}
		} catch {
			// Skip files that can't be processed
		}
	}

	return {
		today: todayPeriod,
		last30Days: last30DaysPeriod,
		month: monthPeriod,
		lastUpdated: now,
	};
}

function createEmptyUsageAnalysisPeriod(): UsageAnalysisPeriod {
	return {
		sessions: 0,
		toolCalls: { total: 0, byTool: {} },
		modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
		contextReferences: createEmptyContextRefs(),
		mcpTools: { total: 0, byServer: {}, byTool: {} },
		modelSwitching: {
			modelsPerSession: [],
			totalSessions: 0,
			averageModelsPerSession: 0,
			maxModelsPerSession: 0,
			minModelsPerSession: 0,
			switchingFrequency: 0,
			standardModels: [],
			premiumModels: [],
			unknownModels: [],
			mixedTierSessions: 0,
			standardRequests: 0,
			premiumRequests: 0,
			unknownRequests: 0,
			totalRequests: 0,
		},
		repositories: [],
		repositoriesWithCustomization: [],
		editScope: {
			singleFileEdits: 0,
			multiFileEdits: 0,
			totalEditedFiles: 0,
			avgFilesPerSession: 0,
		},
		applyUsage: {
			totalApplies: 0,
			totalCodeBlocks: 0,
			applyRate: 0,
		},
		sessionDuration: {
			totalDurationMs: 0,
			avgDurationMs: 0,
			avgFirstProgressMs: 0,
			avgTotalElapsedMs: 0,
			avgWaitTimeMs: 0,
		},
		conversationPatterns: {
			multiTurnSessions: 0,
			singleTurnSessions: 0,
			avgTurnsPerSession: 0,
			maxTurnsInSession: 0,
		},
		agentTypes: {
			editsAgent: 0,
			defaultAgent: 0,
			workspaceAgent: 0,
			other: 0,
		},
	};
}

/** Format a number with thousand separators */
export function fmt(n: number): string {
	return n.toLocaleString('en-US');
}

/** Format token counts for display */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}K`;
	}
	return tokens.toString();
}

/** Environmental impact constants export for use in commands */
export const ENVIRONMENTAL = {
	CO2_PER_1K_TOKENS,
	CO2_ABSORPTION_PER_TREE_PER_YEAR,
	WATER_USAGE_PER_1K_TOKENS,
	// Context comparison constants
	CO2_PER_KM_DRIVING: 120,          // grams CO2 per km for average car
	CO2_PER_PHONE_CHARGE: 8.22,       // grams CO2 per smartphone full charge
	WATER_PER_COFFEE_CUP: 140,        // liters of water per cup of coffee
	CO2_PER_LED_HOUR: 20,             // grams CO2 per hour for 10W LED bulb
};

/** Model pricing data export */
export { modelPricing, tokenEstimators, toolNameMap };

/** Cache lifecycle — re-export for use in commands */
export { loadCache, saveCache, disableCache, getCacheStats } from './cliCache';

