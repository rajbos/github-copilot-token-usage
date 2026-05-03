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
	/** Actual LLM tokens from session.shutdown or request-level usage data. 0 means unavailable. */
	actualTokens: number;
	interactions: number;
	modelUsage: ModelUsage;
	lastModified: Date;
	editorSource: string;
	/**
	 * Per-UTC-day token fractions, keyed by "YYYY-MM-DD".
	 * Values sum to 1.0. Built from interaction timestamps extracted from the session file.
	 * Falls back to { [mtimeDateKey]: 1.0 } when no timestamps are available.
	 *
	 * This is the canonical attribution mechanism for all session formats:
	 *  - Copilot CLI JSONL: from user.message event timestamps
	 *  - VS Code delta JSONL: from kind:0/1/2 request timestamps
	 *  - VS Code JSON: from requests[].timestamp fields
	 *  - Ecosystem adapters: mtime fallback (until adapter implements getDailyFractions)
	 */
	dailyFractions: Record<string, number>;
}

/**
 * Extract per-UTC-day fractions from session content using interaction timestamps.
 * Fractions sum to 1.0. Falls back to { [fallbackDateKey]: 1.0 } when no timestamps found.
 *
 * Single canonical implementation for all text-based session formats:
 *  - Copilot CLI JSONL: timestamps on `user.message` events
 *  - VS Code delta JSONL: timestamps in kind:0 initial state, kind:2 appends, kind:1 updates
 *  - VS Code JSON: timestamps on request objects
 *
 * When adding support for a new session format, extend this function rather than creating
 * a separate attribution implementation — this keeps all formats consistent.
 */
export function extractDailyFractions(content: string, isJsonl: boolean, fallbackDate: Date): Record<string, number> {
	const fallbackKey = fallbackDate.toISOString().slice(0, 10);
	const dayCounts: Record<string, number> = {};

	function recordTimestamp(ts: unknown): void {
		if (ts === undefined || ts === null) { return; }
		const date = new Date(ts as any);
		if (!isNaN(date.getTime())) {
			const key = date.toISOString().slice(0, 10);
			dayCounts[key] = (dayCounts[key] || 0) + 1;
		}
	}

	if (isJsonl) {
		// Track per-index timestamps for kind:1 updates so we can add them even when kind:2 had no timestamp
		const requestTsMap: Record<number, unknown> = {};

		const lines = content.trim().split('\n');
		for (const line of lines) {
			if (!line.trim()) { continue; }
			try {
				const event = JSON.parse(line);

				// Copilot CLI JSONL: user.message events carry the interaction timestamp
				if (event.type === 'user.message') {
					const ts = event.timestamp ?? event.ts ?? event.data?.timestamp;
					recordTimestamp(ts);
					continue;
				}

				// VS Code delta JSONL
				const kind = event.kind;
				const k: unknown[] = event.k;
				const v = event.v;

				if (kind === 0 && v?.requests && Array.isArray(v.requests)) {
					// Initial state — extract timestamps from existing requests
					for (const req of v.requests) {
						const ts = req.timestamp ?? req.ts;
						recordTimestamp(ts);
					}
				} else if (kind === 2 && Array.isArray(k) && k[0] === 'requests') {
					if (Array.isArray(v)) {
						// Batch append
						for (const req of v) {
							const ts = req.timestamp ?? req.ts;
							recordTimestamp(ts);
						}
					} else if (v && typeof v === 'object') {
						// Single request append — may or may not have timestamp yet
						const ts = (v as any).timestamp ?? (v as any).ts;
						if (ts !== undefined) {
							recordTimestamp(ts);
						}
						// Track index for potential kind:1 timestamp update below
						if (typeof k[1] === 'number') {
							requestTsMap[k[1]] = ts;
						}
					}
				} else if (kind === 1 && Array.isArray(k) && k.length === 3 && k[0] === 'requests' &&
						(k[2] === 'timestamp' || k[2] === 'ts') && typeof k[1] === 'number') {
					// kind:1 updates the timestamp on an existing request
					const idx = k[1] as number;
					if (requestTsMap[idx] === undefined) {
						// First time seeing a timestamp for this request index
						recordTimestamp(v);
					}
					requestTsMap[idx] = v;
				}
			} catch { /* skip malformed lines */ }
		}
	} else {
		// VS Code JSON format: requests array with timestamp fields
		try {
			const data = JSON.parse(content);
			if (data.requests && Array.isArray(data.requests)) {
				for (const req of data.requests) {
					const ts = req.timestamp ?? req.ts ?? req.result?.timestamp;
					recordTimestamp(ts);
				}
			}
		} catch { /* skip */ }
	}

	const total = Object.values(dayCounts).reduce((a, b) => a + b, 0);
	if (total === 0) {
		return { [fallbackKey]: 1.0 };
	}
	const fractions: Record<string, number> = {};
	for (const [key, count] of Object.entries(dayCounts)) {
		fractions[key] = count / total;
	}
	return fractions;
}

/** Returns actual tokens when available (more accurate), else falls back to estimated. */
export function effectiveTokens(data: SessionData): number {
	return data.actualTokens > 0 ? data.actualTokens : data.tokens;
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
			const mtimeDateKey = stats.mtime.toISOString().slice(0, 10);
			const ecoResult: SessionData = {
				file: filePath,
				tokens: tokenResult.actualTokens > 0 ? tokenResult.actualTokens : tokenResult.tokens,
				thinkingTokens: tokenResult.thinkingTokens,
				actualTokens: tokenResult.actualTokens,
				interactions,
				modelUsage,
				lastModified: stats.mtime,
				editorSource: getEditorSourceFromPath(filePath),
				// Ecosystem adapters don't expose per-request timestamps; fall back to mtime
				dailyFractions: { [mtimeDateKey]: 1.0 },
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
		let actualTokens = 0;
		let interactions = 0;
		let fileModelUsage: ModelUsage = {};

		if (isJsonl) {
			const result = estimateTokensFromJsonlSession(content);
			// Prefer actualTokens (from session.shutdown modelMetrics) over estimated tokens,
			// matching VS Code's logic: actualTokens > 0 ? actualTokens : estimatedTokens
			tokens = result.actualTokens > 0 ? result.actualTokens : result.tokens;
			thinkingTokens = result.thinkingTokens;
			actualTokens = result.actualTokens;
			// Use per-model breakdown from session.shutdown events (more accurate than request-level estimates)
			fileModelUsage = result.modelUsage;

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
			actualTokens = result.actualTokens;
			interactions = result.interactions;
			fileModelUsage = result.modelUsage as ModelUsage;
		}

		const dailyFractions = extractDailyFractions(content, isJsonl, stats.mtime);

		const sessionData: SessionData = {
			file: filePath,
			tokens,
			thinkingTokens,
			actualTokens,
			interactions,
			modelUsage: fileModelUsage,
			lastModified: stats.mtime,
			editorSource: getEditorSourceFromPath(filePath),
			dailyFractions,
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

	// All period boundaries are UTC date keys (YYYY-MM-DD) to match the VS Code extension's behaviour.
	const todayUtcKey = now.toISOString().slice(0, 10);

	const y = now.getUTCFullYear();
	const m = now.getUTCMonth(); // 0-indexed
	const monthStartKey = `${y}-${String(m + 1).padStart(2, '0')}-01`;

	// Last month: the month before the current UTC month
	const lmYear = m === 0 ? y - 1 : y;
	const lmMonth = m === 0 ? 12 : m; // 1-indexed last month number
	const lastMonthStartKey = `${lmYear}-${String(lmMonth).padStart(2, '0')}-01`;
	// lastMonthEndKey is the day before monthStartKey — string comparison handles this naturally
	// (any date >= lastMonthStartKey && < monthStartKey is in last month)

	const last30DaysDate = new Date(Date.UTC(y, m, now.getUTCDate() - 30));
	const last30DaysStartKey = last30DaysDate.toISOString().slice(0, 10);

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

		// Skip sessions that have no relevant days (all older than last month)
		const hasRelevantDay = Object.keys(data.dailyFractions).some(k => k >= lastMonthStartKey);
		if (!hasRelevantDay) { continue; }

		// Accumulate per-period fractions from the session's daily breakdown
		let todayFrac = 0;
		let monthFrac = 0;
		let lastMonthFrac = 0;
		let last30DaysFrac = 0;

		for (const [dateKey, fraction] of Object.entries(data.dailyFractions)) {
			if (dateKey === todayUtcKey) { todayFrac += fraction; }
			if (dateKey >= monthStartKey) { monthFrac += fraction; }
			if (dateKey >= lastMonthStartKey && dateKey < monthStartKey) { lastMonthFrac += fraction; }
			if (dateKey >= last30DaysStartKey) { last30DaysFrac += fraction; }
		}

		if (todayFrac > 0) { aggregateIntoPeriod(periods.today, data, todayFrac); }
		if (monthFrac > 0) { aggregateIntoPeriod(periods.month, data, monthFrac); }
		if (lastMonthFrac > 0) { aggregateIntoPeriod(periods.lastMonth, data, lastMonthFrac); }
		if (last30DaysFrac > 0) { aggregateIntoPeriod(periods.last30Days, data, last30DaysFrac); }
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

function aggregateIntoPeriod(period: PeriodStats, data: SessionData, fraction: number): void {
	const displayTok = Math.round(effectiveTokens(data) * fraction);
	const thinkingTok = Math.round(data.thinkingTokens * fraction);
	const actualTok = Math.round(data.actualTokens * fraction);

	period.tokens += displayTok;
	period.thinkingTokens += thinkingTok;
	period.estimatedTokens += Math.round(data.tokens * fraction);
	period.actualTokens += actualTok;
	period.sessions++;

	// Merge model usage proportionally
	for (const [model, usage] of Object.entries(data.modelUsage)) {
		if (!period.modelUsage[model]) {
			period.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
		}
		period.modelUsage[model].inputTokens += Math.round(usage.inputTokens * fraction);
		period.modelUsage[model].outputTokens += Math.round(usage.outputTokens * fraction);
	}

	// Track interactions proportionally for the running average
	const interactions = Math.round(data.interactions * fraction);
	const totalInteractions = period.avgInteractionsPerSession * (period.sessions - 1) + interactions;
	period.avgInteractionsPerSession = period.sessions > 0 ? totalInteractions / period.sessions : 0;

	// Editor usage
	if (!period.editorUsage[data.editorSource]) {
		period.editorUsage[data.editorSource] = { tokens: 0, sessions: 0 };
	}
	period.editorUsage[data.editorSource].tokens += displayTok;
	period.editorUsage[data.editorSource].sessions++;
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
 * Returns `{ labels, days }` where labels are sorted YYYY-MM-DD strings (UTC) and
 * days are the corresponding aggregated stats.
 */
export async function calculateDailyStats(sessionFiles: string[]): Promise<{
	labels: string[];
	days: DailyEntry[];
	allDaysMap: Map<string, DailyEntry>;
}> {
	const now = new Date();
	const last30DaysDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
	const last30DaysStartKey = last30DaysDate.toISOString().slice(0, 10);
	const todayKey = now.toISOString().slice(0, 10);

	// Fill in all 31 days (today inclusive) with zeroes so the chart has continuous labels
	const dailyMap = new Map<string, DailyEntry>();
	const cursor = new Date(last30DaysDate);
	while (cursor.toISOString().slice(0, 10) <= todayKey) {
		const key = cursor.toISOString().slice(0, 10);
		dailyMap.set(key, { tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}

	// Full historical map (all time, no age filter) for weekly/monthly chart periods
	const allDaysMap = new Map<string, DailyEntry>();

	const sessionResults = await runWithConcurrency(sessionFiles, async (file) => processSessionFile(file));

	for (const data of sessionResults) {
		if (!data || data.tokens === 0 || data.interactions === 0) { continue; }

		const displayTok = effectiveTokens(data);

		for (const [dateKey, fraction] of Object.entries(data.dailyFractions)) {
			const tokForDay = Math.round(displayTok * fraction);

			// 30-day map: only add days within the window
			const dailyEntry = dailyMap.get(dateKey);
			if (dailyEntry) {
				dailyEntry.tokens += tokForDay;
				dailyEntry.sessions++;
				for (const [model, usage] of Object.entries(data.modelUsage)) {
					if (!dailyEntry.modelUsage[model]) {
						dailyEntry.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
					}
					dailyEntry.modelUsage[model].inputTokens += Math.round(usage.inputTokens * fraction);
					dailyEntry.modelUsage[model].outputTokens += Math.round(usage.outputTokens * fraction);
				}
				const editor = data.editorSource;
				if (!dailyEntry.editorUsage[editor]) {
					dailyEntry.editorUsage[editor] = { tokens: 0, sessions: 0 };
				}
				dailyEntry.editorUsage[editor].tokens += tokForDay;
				dailyEntry.editorUsage[editor].sessions++;
			}

			// Full history map: always add regardless of age (used for weekly/monthly charts)
			if (!allDaysMap.has(dateKey)) {
				allDaysMap.set(dateKey, { tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });
			}
			const allEntry = allDaysMap.get(dateKey)!;
			allEntry.tokens += tokForDay;
			allEntry.sessions++;
			for (const [model, usage] of Object.entries(data.modelUsage)) {
				if (!allEntry.modelUsage[model]) {
					allEntry.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
				}
				allEntry.modelUsage[model].inputTokens += Math.round(usage.inputTokens * fraction);
				allEntry.modelUsage[model].outputTokens += Math.round(usage.outputTokens * fraction);
			}
			const editor = data.editorSource;
			if (!allEntry.editorUsage[editor]) {
				allEntry.editorUsage[editor] = { tokens: 0, sessions: 0 };
			}
			allEntry.editorUsage[editor].tokens += tokForDay;
			allEntry.editorUsage[editor].sessions++;
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
		return { labels: bLabels, tokensData, sessionsData, modelDatasets, editorDatasets, repositoryDatasets: [], periodCount, totalTokens, totalSessions, avgPerPeriod: periodCount > 0 ? Math.round(totalTokens / periodCount) : 0, costData: [], totalCost: 0, avgCostPerPeriod: 0 };
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

