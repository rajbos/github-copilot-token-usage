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
import { ClaudeCodeDataAccess } from '../../vscode-extension/src/claudecode';
import { ClaudeDesktopCoworkDataAccess } from '../../vscode-extension/src/claudedesktop';
import { MistralVibeDataAccess } from '../../vscode-extension/src/mistralvibe';
import type { IEcosystemAdapter } from '../../vscode-extension/src/ecosystemAdapter';
import { OpenCodeAdapter, CrushAdapter, ContinueAdapter, ClaudeDesktopAdapter, ClaudeCodeAdapter, VisualStudioAdapter, MistralVibeAdapter, CopilotChatAdapter, CopilotCliAdapter, JetBrainsAdapter } from '../../vscode-extension/src/adapters';
import { isMcpTool, extractMcpServerName } from '../../vscode-extension/src/workspaceHelpers';
import { parseSessionFileContent } from '../../vscode-extension/src/sessionParser';
import { estimateTokensFromText, getModelFromRequest, isJsonlContent, estimateTokensFromJsonlSession, calculateEstimatedCost, getModelTier } from '../../vscode-extension/src/tokenEstimation';
import type { DetailedStats, PeriodStats, ModelUsage, EditorUsage, SessionFileCache, UsageAnalysisStats, UsageAnalysisPeriod, WorkspaceCustomizationMatrix } from '../../vscode-extension/src/types';
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

/** Create Claude Code data access instance for CLI */
function createClaudeCode(): ClaudeCodeDataAccess {
	return new ClaudeCodeDataAccess();
}

/** Create Claude Desktop Cowork data access instance for CLI */
function createClaudeDesktopCowork(): ClaudeDesktopCoworkDataAccess {
	return new ClaudeDesktopCoworkDataAccess();
}

/** Create Mistral Vibe data access instance for CLI */
function createMistralVibe(): MistralVibeDataAccess {
	return new MistralVibeDataAccess();
}

// Module-level singletons so sql.js WASM is only initialised once across all session files
const _openCodeInstance = createOpenCode();
const _crushInstance = createCrush();
const _continueInstance = createContinue();
const _visualStudioInstance = createVisualStudio();
const _claudeCodeInstance = createClaudeCode();
const _claudeDesktopCoworkInstance = createClaudeDesktopCowork();
const _mistralVibeInstance = createMistralVibe();

/** Ordered registry of ecosystem adapters — first match wins. */
const _ecosystems: IEcosystemAdapter[] = [
	new OpenCodeAdapter(_openCodeInstance),
	new CrushAdapter(_crushInstance),
	new VisualStudioAdapter(_visualStudioInstance, (t, m) => estimateTokensFromText(t, m ?? 'gpt-4', tokenEstimators)),
	new ContinueAdapter(_continueInstance),
	new ClaudeDesktopAdapter(
		_claudeDesktopCoworkInstance,
		isMcpTool,
		extractMcpServerName,
		(t, m) => estimateTokensFromText(t, m ?? 'gpt-4', tokenEstimators)
	),
	new ClaudeCodeAdapter(_claudeCodeInstance),
	new MistralVibeAdapter(_mistralVibeInstance),
	// Copilot Chat / CLI adapters: discovery-only. Their handles() returns
	// false so processSessionFile() falls through to the shared parser path
	// for VS Code Copilot Chat and CLI files. See issue #654.
	new CopilotChatAdapter(),
	new CopilotCliAdapter(),
	new JetBrainsAdapter(),
];

/** Create session discovery instance for CLI */
function createSessionDiscovery(): SessionDiscovery {
	return new SessionDiscovery({ log, warn, error, ecosystems: _ecosystems });
}

/** Discover all session files on this machine */
export async function discoverSessionFiles(): Promise<string[]> {
	const discovery = createSessionDiscovery();
	return discovery.getCopilotSessionFiles();
}

/**
 * Builds a WorkspaceCustomizationMatrix from session file paths.
 *
 * - For VS Code sessions: derives workspace folder from workspaceStorage/<hash>/workspace.json,
 *   then checks for .github/copilot-instructions.md, agents.md, or CLAUDE.md.
 * - For Claude Code sessions (~/.claude/projects/<hash>/): reads the JSONL to extract the
 *   `cwd` workspace path, then checks for CLAUDE.md there.
 */
export async function buildCustomizationMatrix(sessionFiles: string[]): Promise<WorkspaceCustomizationMatrix | undefined> {
	const workspacePaths = new Set<string>();
	const claudeBasePath = path.join(os.homedir(), '.claude', 'projects');

	for (const sessionFile of sessionFiles) {
		// Claude Code session: ~/.claude/projects/<hash>/<uuid>.jsonl
		if (sessionFile.startsWith(claudeBasePath + path.sep) || sessionFile.startsWith(claudeBasePath + '/')) {
			try {
				const content = await fs.promises.readFile(sessionFile, 'utf-8');
				const lines = content.split('\n').slice(0, 30);
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						if (event.cwd && typeof event.cwd === 'string') {
							workspacePaths.add(event.cwd);
							break;
						}
					} catch { /* skip malformed lines */ }
				}
			} catch { /* skip unreadable files */ }
			continue;
		}

		// VS Code session: .../workspaceStorage/<hash>/chatSessions/<file>
		const chatSessionsDir = path.dirname(sessionFile);
		if (path.basename(chatSessionsDir) !== 'chatSessions') { continue; }
		const hashDir = path.dirname(chatSessionsDir);
		const workspaceJsonPath = path.join(hashDir, 'workspace.json');

		try {
			if (!fs.existsSync(workspaceJsonPath)) { continue; }
			const content = JSON.parse(await fs.promises.readFile(workspaceJsonPath, 'utf-8'));
			const folderUri: string | undefined = content.folder;
			if (!folderUri || !folderUri.startsWith('file://')) { continue; }

			let folderPath = decodeURIComponent(folderUri.replace(/^file:\/\//, ''));
			// On Windows, file:///C:/... becomes /C:/... — strip the leading slash
			if (/^\/[A-Za-z]:/.test(folderPath)) { folderPath = folderPath.slice(1); }
			workspacePaths.add(folderPath);
		} catch { /* skip unreadable workspace.json files */ }
	}

	if (workspacePaths.size === 0) { return undefined; }

	let workspacesWithIssues = 0;
	for (const wsPath of workspacePaths) {
		try {
			const hasInstructions = fs.existsSync(path.join(wsPath, '.github', 'copilot-instructions.md'));
			const hasAgentsMd    = fs.existsSync(path.join(wsPath, 'agents.md'));
			const hasClaudeMd    = fs.existsSync(path.join(wsPath, 'CLAUDE.md'));
			if (!hasInstructions && !hasAgentsMd && !hasClaudeMd) { workspacesWithIssues++; }
		} catch {
			workspacesWithIssues++;
		}
	}

	return {
		customizationTypes: [],
		workspaces: [],
		totalWorkspaces: workspacePaths.size,
		workspacesWithIssues,
	};
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
 * Stat a session file, handling DB virtual paths (OpenCode and Crush).
 * Virtual DB paths are resolved to the actual DB file.
 */
async function statSessionFile(filePath: string): Promise<fs.Stats> {
	const eco = _ecosystems.find(e => e.handles(filePath));
	if (eco) { return eco.stat(filePath); }
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
	if (normalized.includes('/local-agent-mode-sessions/')) { return 'claude-desktop-cowork'; }
	if (normalized.includes('/.claude/projects/')) { return 'claude-code'; }
	if (normalized.includes('/.vibe/logs/session/')) { return 'mistral-vibe'; }
	if (normalized.includes('.vscode-server')) { return 'vscode-remote'; }
	if (normalized.includes('/.vs/') && normalized.includes('/copilot-chat/')) { return 'Visual Studio'; }
	return 'vscode';
}

/**
 * Run async tasks with bounded concurrency.
 * Items are processed up to `limit` at a time, avoiding I/O and memory saturation.
 */
async function runWithConcurrency<T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	limit = 20
): Promise<(R | undefined)[]> {
	if (items.length === 0) { return []; }
	const results: (R | undefined)[] = new Array(items.length);
	let idx = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (idx < items.length) {
			const i = idx++;
			try { results[i] = await fn(items[i], i); } catch { results[i] = undefined; }
		}
	});
	await Promise.all(workers);
	return results;
}

export interface SessionData {
	file: string;
	tokens: number;
	thinkingTokens: number;
	interactions: number;
	modelUsage: ModelUsage;
	lastModified: Date;
	editorSource: string;
	/** Per-UTC-day actual token breakdown from shutdown event timestamps. */
	dailyActualTokens?: Record<string, number>;
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

		// Dispatch to ecosystem adapters (OpenCode, Crush, VS, Continue, ClaudeDesktop, ClaudeCode, MistralVibe)
		const eco = _ecosystems.find(e => e.handles(filePath));
		if (eco) {
			const [tokenResult, interactions, modelUsage] = await Promise.all([
				eco.getTokens(filePath),
				eco.countInteractions(filePath),
				eco.getModelUsage(filePath),
			]);
			const ecoResult: SessionData = {
				file: filePath,
				tokens: tokenResult.actualTokens > 0 ? tokenResult.actualTokens : tokenResult.tokens,
				thinkingTokens: tokenResult.thinkingTokens,
				interactions,
				modelUsage,
				lastModified: stats.mtime,
				editorSource: getEditorSourceFromPath(filePath),
			};
			setCached(filePath, stats.mtimeMs, stats.size, ecoResult);
			return ecoResult;
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
		let fileDailyActualTokens: Record<string, number> | undefined;

		if (isJsonl) {
			const result = estimateTokensFromJsonlSession(content);
			// Prefer actualTokens (from session.shutdown modelMetrics) over estimated tokens,
			// matching VS Code's logic: actualTokens > 0 ? actualTokens : estimatedTokens
			tokens = result.actualTokens > 0 ? result.actualTokens : result.tokens;
			thinkingTokens = result.thinkingTokens;
			fileModelUsage = result.modelUsage;
			// Store per-day breakdown for accurate period attribution of multi-day sessions
			if (Object.keys(result.dailyActualTokens).length > 0) {
				fileDailyActualTokens = result.dailyActualTokens;
			}

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
			dailyActualTokens: fileDailyActualTokens,
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
	const todayUtcKey = now.toISOString().slice(0, 10);
	const monthUtcStartKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
	const lastMonthLastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
	const lastMonthUtcEndKey = lastMonthLastDay.toISOString().slice(0, 10);
	const lastMonthUtcStartKey = new Date(Date.UTC(lastMonthLastDay.getUTCFullYear(), lastMonthLastDay.getUTCMonth(), 1)).toISOString().slice(0, 10);
	const last30DaysUtcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
	const last30DaysUtcStartKey = last30DaysUtcStart.toISOString().slice(0, 10);

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
	const sessionResults = await runWithConcurrency(sessionFiles, async (file) => {
		const data = await processSessionFile(file);
		if (progressCallback) { progressCallback(++processed, sessionFiles.length); }
		return data;
	});

	for (const data of sessionResults) {
		if (!data || data.tokens === 0) {
			continue;
		}

		const modifiedUtcKey = data.lastModified.toISOString().slice(0, 10);

		// Skip files older than the last month's start
		if (modifiedUtcKey < lastMonthUtcStartKey) {
			continue;
		}

		// When per-day actual token breakdown is available (multi-day sessions),
		// distribute tokens accurately across the days they occurred — matching
		// VS Code's dailyRollups behavior.
		if (data.dailyActualTokens && Object.keys(data.dailyActualTokens).length > 1) {
			let addedToToday = false;
			let addedToMonth = false;
			let addedToLastMonth = false;
			let addedToLast30Days = false;

			for (const [dayKey, dayTokens] of Object.entries(data.dailyActualTokens)) {
				if (dayKey < lastMonthUtcStartKey) { continue; }

				const dayData: SessionData = {
					...data,
					tokens: dayTokens,
				};

				if (dayKey === todayUtcKey) {
					aggregateIntoPeriod(periods.today, dayData, !addedToToday);
					addedToToday = true;
				}
				if (dayKey >= monthUtcStartKey) {
					aggregateIntoPeriod(periods.month, dayData, !addedToMonth);
					addedToMonth = true;
				}
				if (dayKey >= lastMonthUtcStartKey && dayKey <= lastMonthUtcEndKey) {
					aggregateIntoPeriod(periods.lastMonth, dayData, !addedToLastMonth);
					addedToLastMonth = true;
				}
				if (dayKey >= last30DaysUtcStartKey) {
					aggregateIntoPeriod(periods.last30Days, dayData, !addedToLast30Days);
					addedToLast30Days = true;
				}
			}
			continue;
		}

		// Single-day session (or no daily breakdown): attribute all tokens to mtime day
		if (modifiedUtcKey === todayUtcKey) {
			aggregateIntoPeriod(periods.today, data);
		}
		if (modifiedUtcKey >= monthUtcStartKey) {
			aggregateIntoPeriod(periods.month, data);
		}
		if (modifiedUtcKey >= lastMonthUtcStartKey && modifiedUtcKey <= lastMonthUtcEndKey) {
			aggregateIntoPeriod(periods.lastMonth, data);
		}
		if (modifiedUtcKey >= last30DaysUtcStartKey) {
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
		period.estimatedCostCopilot = calculateEstimatedCost(period.modelUsage, modelPricing, 'copilot');
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

function aggregateIntoPeriod(period: PeriodStats, data: SessionData, countSession = true): void {
	period.tokens += data.tokens;
	period.thinkingTokens += data.thinkingTokens;
	period.estimatedTokens += data.tokens;
	if (countSession) {
		period.sessions++;
	}

	// Merge model usage
	for (const [model, usage] of Object.entries(data.modelUsage)) {
		if (!period.modelUsage[model]) {
			period.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
		}
		period.modelUsage[model].inputTokens += usage.inputTokens;
		period.modelUsage[model].outputTokens += usage.outputTokens;
	}

	// Track interactions
	if (countSession) {
		const totalInteractions = period.avgInteractionsPerSession * (period.sessions - 1) + data.interactions;
		period.avgInteractionsPerSession = period.sessions > 0 ? totalInteractions / period.sessions : 0;
	}

	// Editor usage
	if (!period.editorUsage[data.editorSource]) {
		period.editorUsage[data.editorSource] = { tokens: 0, sessions: 0 };
	}
	period.editorUsage[data.editorSource].tokens += data.tokens;
	if (countSession) {
		period.editorUsage[data.editorSource].sessions++;
	}
}

/**
 * Calculate usage analysis stats for fluency scoring.
 * This is a simplified version that uses the shared usageAnalysis module.
 */
export async function calculateUsageAnalysisStats(sessionFiles: string[]): Promise<UsageAnalysisStats> {
	const deps = {
		warn,
		tokenEstimators,
		modelPricing,
		toolNameMap,
		ecosystems: _ecosystems,
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
		modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
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

/** A single day's aggregated token data for the chart view. */
interface DailyEntry {
	tokens: number;
	sessions: number;
	modelUsage: ModelUsage;
	editorUsage: { [editor: string]: { tokens: number; sessions: number } };
}

/**
 * Process session files and return per-day stats for the last 30 days.
 * Returns `{ labels, days }` where labels are sorted YYYY-MM-DD strings and
 * days are the corresponding aggregated stats.
 */
export async function calculateDailyStats(sessionFiles: string[]): Promise<{
	labels: string[];
	days: DailyEntry[];
	allDaysMap: Map<string, DailyEntry>;
}> {
	const now = new Date();
	const last30DaysStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
	const fmtKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

	// Fill in all 31 days (today inclusive) with zeroes so the chart has continuous labels
	const dailyMap = new Map<string, DailyEntry>();
	const cursor = new Date(last30DaysStart);
	while (cursor <= now) {
		dailyMap.set(fmtKey(new Date(cursor)), { tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });
		cursor.setDate(cursor.getDate() + 1);
	}

	// Full historical map (all time) for weekly/monthly chart periods
	const allDaysMap = new Map<string, DailyEntry>();

	const addToEntry = (map: Map<string, DailyEntry>, dateKey: string, data: { tokens: number; modelUsage: ModelUsage; editorSource: string }) => {
		if (!map.has(dateKey)) {
			map.set(dateKey, { tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });
		}
		const entry = map.get(dateKey)!;
		entry.tokens += data.tokens;
		entry.sessions++;
		for (const [model, usage] of Object.entries(data.modelUsage)) {
			if (!entry.modelUsage[model]) { entry.modelUsage[model] = { inputTokens: 0, outputTokens: 0 }; }
			entry.modelUsage[model].inputTokens += (usage as any).inputTokens;
			entry.modelUsage[model].outputTokens += (usage as any).outputTokens;
		}
		const editor = data.editorSource;
		if (!entry.editorUsage[editor]) { entry.editorUsage[editor] = { tokens: 0, sessions: 0 }; }
		entry.editorUsage[editor].tokens += data.tokens;
		entry.editorUsage[editor].sessions++;
	};

	for (const file of sessionFiles) {
		const data = await processSessionFile(file);
		if (!data || data.tokens === 0 || data.interactions === 0) { continue; }

		const d = data.lastModified;
		const dateKey = fmtKey(d);

		// Always add to the full history map
		addToEntry(allDaysMap, dateKey, data);

		// Only add to the 30-day map if within window
		if (data.lastModified >= last30DaysStart && dailyMap.has(dateKey)) {
			addToEntry(dailyMap, dateKey, data);
		}
	}

	const labels = Array.from(dailyMap.keys()).sort();
	const days = labels.map(l => dailyMap.get(l)!);
	return { labels, days, allDaysMap };
}

const CHART_COLORS = [
	{ bg: 'rgba(54, 162, 235, 0.6)',  border: 'rgba(54, 162, 235, 1)' },
	{ bg: 'rgba(255, 99, 132, 0.6)',  border: 'rgba(255, 99, 132, 1)' },
	{ bg: 'rgba(75, 192, 192, 0.6)',  border: 'rgba(75, 192, 192, 1)' },
	{ bg: 'rgba(153, 102, 255, 0.6)', border: 'rgba(153, 102, 255, 1)' },
	{ bg: 'rgba(255, 159, 64, 0.6)',  border: 'rgba(255, 159, 64, 1)' },
	{ bg: 'rgba(255, 205, 86, 0.6)',  border: 'rgba(255, 205, 86, 1)' },
	{ bg: 'rgba(201, 203, 207, 0.6)', border: 'rgba(201, 203, 207, 1)' },
	{ bg: 'rgba(100, 181, 246, 0.6)', border: 'rgba(100, 181, 246, 1)' },
];

/**
 * Build the JSON payload consumed by the chart webview from the daily stats arrays
 * returned by `calculateDailyStats`. Includes weekly and monthly period aggregations.
 */
export function buildChartPayload(labels: string[], days: DailyEntry[], allDaysMap?: Map<string, DailyEntry>): object {
	const fmtKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

	const buildPeriodFromEntries = (buckets: Array<{ label: string; entry: DailyEntry }>) => {
		const entries = buckets.map(b => b.entry);
		const bLabels = buckets.map(b => b.label);
		const tokensData = entries.map(e => e.tokens);
		const sessionsData = entries.map(e => e.sessions);

		const allModels = new Set<string>();
		entries.forEach(e => Object.keys(e.modelUsage).forEach(m => allModels.add(m)));
		const modelDatasets = Array.from(allModels).map((model, idx) => {
			const color = CHART_COLORS[idx % CHART_COLORS.length];
			return { label: model, data: entries.map(e => { const u = e.modelUsage[model]; return u ? u.inputTokens + u.outputTokens : 0; }), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
		});

		const allEditors = new Set<string>();
		entries.forEach(e => Object.keys(e.editorUsage).forEach(ed => allEditors.add(ed)));
		const editorDatasets = Array.from(allEditors).map((editor, idx) => {
			const color = CHART_COLORS[idx % CHART_COLORS.length];
			return { label: editor, data: entries.map(e => e.editorUsage[editor]?.tokens || 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
		});

		const totalTokens = tokensData.reduce((a, b) => a + b, 0);
		const totalSessions = sessionsData.reduce((a, b) => a + b, 0);
		const periodCount = buckets.length;
		const costData = entries.map(e => calculateEstimatedCost(e.modelUsage, modelPricing));
		const totalCost = costData.reduce((a, b) => a + b, 0);
		const avgCostPerPeriod = periodCount > 0 ? totalCost / periodCount : 0;
		return { labels: bLabels, tokensData, sessionsData, modelDatasets, editorDatasets, repositoryDatasets: [], periodCount, totalTokens, totalSessions, avgPerPeriod: periodCount > 0 ? Math.round(totalTokens / periodCount) : 0, costData, totalCost, avgCostPerPeriod };
	};

	const mergeEntry = (target: DailyEntry, src: DailyEntry) => {
		target.tokens += src.tokens;
		target.sessions += src.sessions;
		for (const [m, u] of Object.entries(src.modelUsage)) {
			if (!target.modelUsage[m]) { target.modelUsage[m] = { inputTokens: 0, outputTokens: 0 }; }
			target.modelUsage[m].inputTokens += u.inputTokens;
			target.modelUsage[m].outputTokens += u.outputTokens;
		}
		for (const [e, u] of Object.entries(src.editorUsage)) {
			if (!target.editorUsage[e]) { target.editorUsage[e] = { tokens: 0, sessions: 0 }; }
			target.editorUsage[e].tokens += u.tokens;
			target.editorUsage[e].sessions += u.sessions;
		}
	};

	const emptyEntry = (): DailyEntry => ({ tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });

	const now = new Date();

	// ── Daily period: the existing 30-day data ──────────────────────────
	const dailyBuckets = labels.map((l, i) => ({ label: l, entry: days[i] }));
	const dailyPeriod = buildPeriodFromEntries(dailyBuckets);

	// ── Weekly period: last 6 calendar weeks ───────────────────────────
	const getMondayOfWeek = (d: Date): Date => {
		const copy = new Date(d); copy.setHours(0, 0, 0, 0);
		const day = copy.getDay();
		copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1));
		return copy;
	};
	const fmtWeekLabel = (monday: Date): string => {
		const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
		if (monday.getMonth() === sunday.getMonth()) {
			return `${monday.toLocaleDateString('en-US', { month: 'short' })} ${monday.getDate()}–${sunday.getDate()}`;
		}
		return `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
	};
	const thisMonday = getMondayOfWeek(now);
	const weekBucketMap = new Map<string, { label: string; entry: DailyEntry }>();
	for (let w = 5; w >= 0; w--) {
		const monday = new Date(thisMonday); monday.setDate(thisMonday.getDate() - w * 7);
		const key = fmtKey(monday);
		weekBucketMap.set(key, { label: fmtWeekLabel(monday), entry: emptyEntry() });
	}
	const sourceMap = allDaysMap || new Map(labels.map((l, i) => [l, days[i]]));
	for (const [dateKey, entry] of sourceMap.entries()) {
		const monday = getMondayOfWeek(new Date(dateKey + 'T00:00:00'));
		const bucket = weekBucketMap.get(fmtKey(monday));
		if (bucket) { mergeEntry(bucket.entry, entry); }
	}
	const weeklyBuckets = Array.from(weekBucketMap.values());
	const weeklyPeriod = buildPeriodFromEntries(weeklyBuckets);

	// ── Monthly period: last 12 calendar months ────────────────────────
	const monthBucketMap = new Map<string, { label: string; entry: DailyEntry }>();
	for (let m = 11; m >= 0; m--) {
		const monthDate = new Date(now.getFullYear(), now.getMonth() - m, 1);
		const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
		const label = monthDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
		monthBucketMap.set(key, { label, entry: emptyEntry() });
	}
	for (const [dateKey, entry] of sourceMap.entries()) {
		const monthKey = dateKey.slice(0, 7);
		const bucket = monthBucketMap.get(monthKey);
		if (bucket) { mergeEntry(bucket.entry, entry); }
	}
	const monthlyBuckets = Array.from(monthBucketMap.values());
	const monthlyPeriod = buildPeriodFromEntries(monthlyBuckets);

	// ── Editor totals map (last 30 days) ───────────────────────────────
	const editorTotalsMap: Record<string, number> = {};
	days.forEach(d => {
		Object.entries(d.editorUsage).forEach(([editor, usage]) => {
			editorTotalsMap[editor] = (editorTotalsMap[editor] || 0) + usage.tokens;
		});
	});

	return {
		// Backward-compat flat fields (daily period)
		labels: dailyPeriod.labels,
		tokensData: dailyPeriod.tokensData,
		sessionsData: dailyPeriod.sessionsData,
		modelDatasets: dailyPeriod.modelDatasets,
		editorDatasets: dailyPeriod.editorDatasets,
		editorTotalsMap,
		repositoryDatasets: [],
		repositoryTotalsMap: {},
		dailyCount: dailyPeriod.periodCount,
		totalTokens: dailyPeriod.totalTokens,
		avgTokensPerDay: dailyPeriod.periodCount > 0 ? Math.round(dailyPeriod.totalTokens / dailyPeriod.periodCount) : 0,
		totalSessions: dailyPeriod.totalSessions,
		lastUpdated: new Date().toISOString(),
		backendConfigured: false,
		periodsReady: true,
		periods: {
			day: dailyPeriod,
			week: weeklyPeriod,
			month: monthlyPeriod,
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

