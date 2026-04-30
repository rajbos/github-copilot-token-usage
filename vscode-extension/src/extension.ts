import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';
import toolNamesData from './toolNames.json';
import customizationPatternsData from './customizationPatterns.json';
import copilotPlansData from './copilotPlans.json';
import { REPO_HYGIENE_SKILL } from './backend/repoHygieneSkill';
import { BackendFacade } from './backend/facade';
import { BackendCommandHandler } from './backend/commands';
import { TeamServerConfigPanel } from './backend/teamServerConfigPanel';
import * as packageJson from '../package.json';
import { getModelDisplayName } from './webview/shared/modelUtils';
import { ConfirmationMessages } from "./backend/ui/messages";
import {
	detectAiType,
	discoverGitHubRepos,
	fetchRepoPrs,
	fetchCopilotPlanInfo,
	type CopilotPlanInfo,
	type RepoPrDetail,
	type RepoPrInfo,
	type RepoPrStatsResult,
} from './githubPrService';

import type {
  TokenUsageStats,
  ModelUsage,
  ModelPricing,
  EditorUsage,
  RepositoryUsage,
  PeriodStats,
  DetailedStats,
  DailyTokenStats,
  ChartDataPayload,
  SessionFileCache,
  DailyRollupEntry,
  CustomizationFileEntry,
  SessionUsageAnalysis,
  ToolCallUsage,
  ModeUsage,
  ContextReferenceUsage,
  McpToolUsage,
  EditScopeUsage,
  ApplyButtonUsage,
  SessionDurationData,
  ConversationPatterns,
  AgentTypeUsage,
  ModelSwitchingAnalysis,
  MissedPotentialWorkspace,
  UsageAnalysisStats,
  CustomizationTypeStatus,
  WorkspaceCustomizationRow,
  WorkspaceCustomizationMatrix,
  UsageAnalysisPeriod,
  SessionFileDetails,
  PromptTokenDetail,
  ActualUsage,
  ChatTurn,
  SessionLogData,
  WorkspaceCustomizationSummary
} from './types';
import { OpenCodeDataAccess } from './opencode';
import { CrushDataAccess } from './crush';
import { VisualStudioDataAccess } from './visualstudio';
import { ContinueDataAccess } from './continue';
import { ClaudeCodeDataAccess } from './claudecode';
import { ClaudeDesktopCoworkDataAccess } from './claudedesktop';
import { MistralVibeDataAccess } from './mistralvibe';
import type { IEcosystemAdapter } from './ecosystemAdapter';
import {
	OpenCodeAdapter,
	CrushAdapter,
	ContinueAdapter,
	ClaudeDesktopAdapter,
	ClaudeCodeAdapter,
	VisualStudioAdapter,
	MistralVibeAdapter,
	CopilotChatAdapter,
	CopilotCliAdapter,
	JetBrainsAdapter,
} from './adapters';
import { getVSCodeUserPaths } from './adapters/copilotChatAdapter';
import {
  estimateTokensFromText as _estimateTokensFromText,
  estimateTokensFromJsonlSession as _estimateTokensFromJsonlSession,
  extractPerRequestUsageFromRawLines as _extractPerRequestUsageFromRawLines,
  getModelFromRequest as _getModelFromRequest,
  isJsonlContent as _isJsonlContent,
  isUuidPointerFile as _isUuidPointerFile,
  applyDelta as _applyDelta,
  getModelTier as _getModelTier,
  calculateEstimatedCost as _calculateEstimatedCost,
  createEmptyContextRefs as _createEmptyContextRefs,
  getTotalTokensFromModelUsage as _getTotalTokensFromModelUsage,
  reconstructJsonlStateAsync as _reconstructJsonlStateAsync,
  extractSubAgentData as _extractSubAgentData,
  buildReasoningEffortTimeline as _buildReasoningEffortTimeline,
} from './tokenEstimation';
import { SessionDiscovery } from './sessionDiscovery';
import { CacheManager } from './cacheManager';
import {
  mergeUsageAnalysis as _mergeUsageAnalysis,
  analyzeContextReferences as _analyzeContextReferences,
  analyzeContentReferences as _analyzeContentReferences,
  analyzeVariableData as _analyzeVariableData,
  deriveConversationPatterns as _deriveConversationPatterns,
  analyzeRequestContext as _analyzeRequestContext,
  calculateModelSwitching as _calculateModelSwitching,
  trackEnhancedMetrics as _trackEnhancedMetrics,
  analyzeSessionUsage as _analyzeSessionUsage,
  getModelUsageFromSession as _getModelUsageFromSession,
  type UsageAnalysisDeps,
} from './usageAnalysis';
import {
  getFluencyLevelData as _getFluencyLevelData,
  calculateFluencyScoreForTeamMember as _calculateFluencyScoreForTeamMember,
  calculateMaturityScores as _calculateMaturityScores,
} from './maturityScoring';
import {
  parseWorkspaceStorageJsonFile as _parseWorkspaceStorageJsonFile,
  extractWorkspaceIdFromSessionPath as _extractWorkspaceIdFromSessionPath,
  resolveWorkspaceFolderFromSessionPath as _resolveWorkspaceFolderFromSessionPath,
  globToRegExp as _globToRegExp,
  resolveExactWorkspacePath as _resolveExactWorkspacePath,
  scanWorkspaceCustomizationFiles as _scanWorkspaceCustomizationFiles,
  getRepositoryUrl as _getRepositoryUrl,
  getModeType as _getModeType,
  extractCustomAgentName as _extractCustomAgentName,
  getEditorTypeFromPath as _getEditorTypeFromPath,
  getEditorNameFromRoot as _getEditorNameFromRoot,
  getRepoDisplayName as _getRepoDisplayName,
  detectEditorSource as _detectEditorSource,
  parseGitRemoteUrl as _parseGitRemoteUrl,
  extractRepositoryFromContentReferences as _extractRepositoryFromContentReferences,
  isMcpTool as _isMcpTool,
  normalizeMcpToolName as _normalizeMcpToolName,
  extractMcpServerName as _extractMcpServerName,
} from './workspaceHelpers';
import {
  createViewRegressionProbeScript,
  evaluateViewRegressionProbe,
  formatLocalViewRegressionReport,
  type LocalViewRegressionMetric,
  type LocalViewRegressionResult,
  type ViewRegressionExpectation,
  type ViewRegressionProbeConfig,
  type ViewRegressionProbeSnapshot,
} from './viewRegression';
import { determineOnboardingAction } from './onboarding';
import { addModelUsage, addEditorUsage, computeUtcDateRanges, aggregatePeriodStats, type SessionAggregateInput } from './statsHelpers';

type LocalViewRegressionProbeResult = {
  pass: boolean;
  summary: string;
  timedOut?: boolean;
  metrics?: ViewRegressionProbeSnapshot;
};

type LocalViewRegressionCase = {
  id: string;
  title: string;
  timeoutMs: number;
  expectations: ViewRegressionExpectation;
  dataPoints: LocalViewRegressionMetric[];
  reset: () => void;
  open: () => Promise<void>;
};

class CopilotTokenTracker implements vscode.Disposable {
	// Cache version - increment this when making changes that require cache invalidation
	private static readonly CACHE_VERSION = 44; // Add tool.execution_complete token counting for CLI sessions
	// Maximum length for displaying workspace IDs in diagnostics/customization matrix
	private static readonly WORKSPACE_ID_DISPLAY_LENGTH = 8;

	private diagnosticsPanel?: vscode.WebviewPanel;
	// Tracks whether the diagnostics panel has already received its session files
	private diagnosticsHasLoadedFiles: boolean = false;
	// Cache of the last loaded detailed session files for diagnostics view
	private diagnosticsCachedFiles: SessionFileDetails[] = [];
	// Cache of the last diagnostic report text for copy/issue operations
	private lastDiagnosticReport: string = '';
	private logViewerPanel?: vscode.WebviewPanel;
	public openCode: OpenCodeDataAccess;
	public crush: CrushDataAccess;
	public visualStudio: VisualStudioDataAccess;
	private continue_: ContinueDataAccess;
	private claudeCode: ClaudeCodeDataAccess;
	private claudeDesktopCowork: ClaudeDesktopCoworkDataAccess;
	private mistralVibe: MistralVibeDataAccess;
	private readonly ecosystems: IEcosystemAdapter[];
	private cacheManager: CacheManager;

	private get usageAnalysisDeps(): UsageAnalysisDeps {
		return { warn: (m: string) => this.warn(m), tokenEstimators: this.tokenEstimators, modelPricing: this.modelPricing, toolNameMap: this.toolNameMap, ecosystems: this.ecosystems };
	}
	public sessionDiscovery: SessionDiscovery;
	private statusBarItem: vscode.StatusBarItem;
	private readonly extensionUri: vscode.Uri;
	private readonly context: vscode.ExtensionContext;
	private _devBranch: string | undefined;
	private localRegressionSampleDataDir?: string;
	private pendingLocalViewRegressionProbe?: ViewRegressionProbeConfig;
	private readonly localViewRegressionResolvers = new Map<string, (result: LocalViewRegressionProbeResult) => void>();


	/**
	 * Resolve the workspace folder full path from a session file path.
	 * Looks for a `workspaceStorage/<id>/` segment and reads `workspace.json` or `meta.json`.
	 * Synchronous by design to keep the analysis flow simple and cached.
	 */
	// Helper: read a workspaceStorage JSON file and extract a candidate folder path from configured keys

	/**
	 * Extract workspace ID from a session file path, if it's workspace-scoped.
	 * Returns the workspace ID or undefined if not a workspace-scoped session.
	 */


	/**
	 * Convert a simple glob pattern to a RegExp.
	 * Supports: ** (match multiple path segments), * (match within a segment), ?.
	 */

	/**
	 * Resolve an exact relative path in a workspace.
	 * When `caseInsensitive` is true, path segments are matched case-insensitively.
	 */

	/**
	 * Scan a workspace folder for customization files according to `customizationPatterns.json`.
	 */
	private _disposed = false;
	private updateInterval: NodeJS.Timeout | undefined;
	private detailsPanel: vscode.WebviewPanel | undefined;
	private chartPanel: vscode.WebviewPanel | undefined;
	private analysisPanel: vscode.WebviewPanel | undefined;
	private maturityPanel: vscode.WebviewPanel | undefined;
	private dashboardPanel: vscode.WebviewPanel | undefined;
	private fluencyLevelViewerPanel: vscode.WebviewPanel | undefined;
	private environmentalPanel: vscode.WebviewPanel | undefined;
	private outputChannel: vscode.OutputChannel;
	private lastDetailedStats: DetailedStats | undefined;
	private lastDailyStats: DailyTokenStats[] | undefined;
	/** Full-year daily stats (up to 365 days) for the chart Week/Month period views. */
	private lastFullDailyStats: DailyTokenStats[] | undefined;
	/** Last period selected by the user in the chart view; restored on next open. */
	private lastChartPeriod: 'day' | 'week' | 'month' = 'day';
	private lastUsageAnalysisStats: UsageAnalysisStats | undefined;
	private lastDashboardData: any | undefined;
	private tokenEstimators: { [key: string]: number } = tokenEstimatorsData.estimators;
	private co2Per1kTokens = 0.2; // gCO2e per 1000 tokens, a rough estimate
	private co2AbsorptionPerTreePerYear = 21000; // grams of CO2 per tree per year
	private waterUsagePer1kTokens = 0.3; // liters of water per 1000 tokens, based on data center usage estimates
	private _cacheHits = 0; // Counter for cache hits during usage analysis
	private _cacheMisses = 0; // Counter for cache misses during usage analysis
	// Short-term cache to avoid rescanning filesystem during rapid successive calls (e.g., diagnostics load)

	// Cached sql.js SQL module (lazy initialized)

	// In-flight command tracker — prevents concurrent execution of the same webview command
	private readonly _inFlightCommands = new Set<string>();

	// Cache mapping workspaceStorageId -> resolved workspace folder path (or undefined if not resolvable)
	private _workspaceIdToFolderCache: Map<string, string | undefined> = new Map();

	// Cache mapping workspaceFolderPath -> found customization files (avoid re-scanning)
	private _customizationFilesCache: Map<string, CustomizationFileEntry[]> = new Map();

	// Last computed customization matrix for usage analysis (typed)
	private _lastCustomizationMatrix?: WorkspaceCustomizationMatrix;
	private _lastMissedPotential?: MissedPotentialWorkspace[];

	// Model pricing data - loaded from modelPricing.json
	// Reference: OpenAI API Pricing (https://openai.com/api/pricing/) - Retrieved December 2025
	// Reference: Anthropic Claude Pricing (https://www.anthropic.com/pricing) - Standard rates
	// Note: GitHub Copilot uses these models but pricing may differ from direct API usage
	// These are reference prices for cost estimation purposes only
	private modelPricing: { [key: string]: ModelPricing } = modelPricingData.pricing as { [key: string]: ModelPricing };

	// GitHub authentication session
	public githubSession: vscode.AuthenticationSession | undefined;
	// Promise that resolves when the startup session restore completes
	private _sessionRestorePromise: Promise<void> | undefined;
	/** True when the user explicitly signed out from our extension this VS Code session. Gated by globalState so it survives reloads. */
	private _githubSignedOutByUser: boolean = false;
	/** Resolved Copilot plan details fetched from copilot_internal/user after sign-in. */
	private _copilotPlanResolved: { planId: string; planName: string; monthlyAiCreditsUsd: number; monthlyPremiumRequests: number | null } | undefined;

	// Cached PR stats result for the repos tab
	private _lastRepoPrStats?: RepoPrStatsResult;

	// Tool name mapping - loaded from toolNames.json for friendly display names
	private toolNameMap: { [key: string]: string } = toolNamesData as { [key: string]: string };

	// Backend facade instance for accessing table storage data
	public backend: BackendFacade | undefined;

	// Helper method to get repository URL from package.json
	private getRepositoryUrl(): string {
		return _getRepositoryUrl();
	}

	/**
	 * Determine the editor type from a session file path
	 * Returns: 'VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Copilot CLI', or 'Unknown'
	 */
	/**
	 * Detect the actual mode type from inputState.mode object.
	 * Returns 'ask', 'edit', 'agent', 'plan', or 'customAgent'.
	 */
	private getModeType(mode: any): 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' {
		return _getModeType(mode);
	}

	/**
	 * Extract custom agent name from a file:// URI pointing to a .agent.md file.
	 * Returns the filename without the .agent.md extension.
	 */
	private getEditorTypeFromPath(filePath: string): string {
		return _getEditorTypeFromPath(filePath, (p) => this.findEcosystem(p)?.id === 'opencode');
	}

	/** Returns the first adapter that claims this session file, or null for Copilot Chat sessions. */
	private findEcosystem(sessionFile: string): IEcosystemAdapter | null {
		return this.ecosystems.find(e => e.handles(sessionFile)) ?? null;
	}

	/**
	 * Stat a session file, handling virtual paths for both OpenCode and Crush.
	 * Must be used instead of fs.promises.stat() directly.
	 */
	public async statSessionFile(sessionFile: string): Promise<import('fs').Stats> {
		const eco = this.findEcosystem(sessionFile);
		if (eco) { return eco.stat(sessionFile); }
		return fs.promises.stat(sessionFile);
	}

	/**
	 * Run async tasks over session files with bounded concurrency (default: 20).
	 * Prevents I/O saturation when processing hundreds of session files in parallel.
	 */
	private async runWithConcurrency<R>(
		files: string[],
		fn: (file: string, index: number) => Promise<R>,
		limit = 20
	): Promise<(R | undefined)[]> {
		if (files.length === 0) { return []; }
		const results: (R | undefined)[] = new Array(files.length);
		let idx = 0;
		const workers = Array.from({ length: Math.min(limit, files.length) }, async () => {
			while (idx < files.length) {
				const i = idx++;
				try { results[i] = await fn(files[i], i); } catch { results[i] = undefined; }
			}
		});
		await Promise.all(workers);
		return results;
	}

	/**
	 * Determine a friendly editor name from an editor root path (folder name)
	 * e.g. 'C:\...\AppData\Roaming\Code' -> 'VS Code'
	 */
	private getEditorNameFromRoot(rootPath: string): string {
		return _getEditorNameFromRoot(rootPath);
	}

	/**
	 * Extract a friendly display name from a repository URL.
	 * Supports HTTPS, SSH, and git:// URLs.
	 * @param repoUrl The full repository URL
	 * @returns A shortened display name like "owner/repo"
	 */
	private getRepoDisplayName(repoUrl: string): string {
		return _getRepoDisplayName(repoUrl);
	}

	// Logging methods
	public log(message: string): void {
		if (this._disposed) { return; }
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ${message}`);
	}

	public warn(message: string): void {
		if (this._disposed) { return; }
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] WARNING: ${message}`);
	}

	private error(message: string, error?: any): void {
		if (this._disposed) { return; }
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
		if (error) {
			this.outputChannel.appendLine(`[${timestamp}] ${error}`);
		}
	}

	/**
	 * Dispatch a webview command with in-flight deduplication and error handling.
	 * If a command with the same key is already executing, the new call is silently dropped.
	 * Use panel-prefixed keys for panel-specific commands (e.g. 'refresh:details') and plain
	 * command names for shared navigation commands (e.g. 'showDetails').
	 */
	private async dispatch(commandKey: string, handler: () => unknown): Promise<void> {
		if (this._inFlightCommands.has(commandKey)) {
			this.log(`⏳ Command '${commandKey}' already in flight, skipping`);
			return;
		}
		this._inFlightCommands.add(commandKey);
		try {
			await handler();
		} catch (error) {
			this.error(`Webview command '${commandKey}' failed`, error);
			vscode.window.showErrorMessage(`Operation failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this._inFlightCommands.delete(commandKey);
		}
	}

	/**
	 * Dispatch a shared navigation command that is common across all webview panels.
	 * Returns true if the command was recognised and dispatched, false if it is panel-specific.
	 */
	private async dispatchSharedCommand(command: string): Promise<boolean> {
		const handlers: Record<string, () => unknown> = {
			showDetails:            () => this.showDetails(),
			showChart:              () => this.showChart(),
			showUsageAnalysis:      () => this.showUsageAnalysis(),
			showDiagnostics:        () => this.showDiagnosticReport(),
			showMaturity:           () => this.showMaturity(),
			showDashboard:          () => this.showDashboard(),
			showEnvironmental:      () => this.showEnvironmental(),
			showFluencyLevelViewer: () => this.showFluencyLevelViewer(),
		};
		const handler = handlers[command];
		if (!handler) { return false; }
		await this.dispatch(command, handler);
		return true;
	}

	private consumeLocalViewRegressionProbe(viewId: string): ViewRegressionProbeConfig | undefined {
		const probe = this.pendingLocalViewRegressionProbe;
		if (probe?.viewId !== viewId) {
			return undefined;
		}
		this.pendingLocalViewRegressionProbe = undefined;
		return probe;
	}

	private getLocalViewRegressionProbeScript(viewId: string, nonce: string): string {
		return createViewRegressionProbeScript(nonce, this.consumeLocalViewRegressionProbe(viewId));
	}

	private handleLocalViewRegressionMessage(message: any): boolean {
		if (message?.command !== 'localViewRegressionReport' || typeof message.runId !== 'string') {
			return false;
		}

		const resolve = this.localViewRegressionResolvers.get(message.runId);
		if (!resolve) {
			return true;
		}

		this.localViewRegressionResolvers.delete(message.runId);
		resolve({
			pass: Boolean(message.pass),
			summary: typeof message.summary === 'string' ? message.summary : 'Local view regression probe finished.',
			timedOut: Boolean(message.timedOut),
			metrics: typeof message.metrics === 'object' && message.metrics
				? message.metrics as ViewRegressionProbeSnapshot
				: undefined,
		});
		return true;
	}

	private getBundledLocalViewRegressionSampleDir(): string {
		return path.join(this.extensionUri.fsPath, 'test', 'fixtures', 'sample-session-data', 'chatSessions');
	}

	private async ensureLocalViewRegressionSampleDir(): Promise<string> {
		const sampleDir = this.getBundledLocalViewRegressionSampleDir();
		await fs.promises.access(sampleDir);
		return sampleDir;
	}

	private async runLocalViewRegressionCase(viewCase: LocalViewRegressionCase): Promise<LocalViewRegressionResult> {
		viewCase.reset();
		const runId = `${viewCase.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const probePromise = new Promise<LocalViewRegressionProbeResult>((resolve) => {
			let settled = false;
			const finish = (result: LocalViewRegressionProbeResult) => {
				if (settled) {
					return;
				}
				settled = true;
				this.localViewRegressionResolvers.delete(runId);
				resolve(result);
			};

			this.localViewRegressionResolvers.set(runId, finish);
			setTimeout(() => {
				finish({
					pass: false,
					summary: `No regression probe response received within ${Math.round(viewCase.timeoutMs / 1000)}s.`,
					timedOut: true,
				});
			}, viewCase.timeoutMs + 750).unref();
		});

		try {
			this.pendingLocalViewRegressionProbe = {
				runId,
				viewId: viewCase.id,
				title: viewCase.title,
				timeoutMs: viewCase.timeoutMs,
				expectations: viewCase.expectations,
			};
			await viewCase.open();
		} catch (error) {
			this.pendingLocalViewRegressionProbe = undefined;
			this.localViewRegressionResolvers.delete(runId);
			return {
				id: viewCase.id,
				title: viewCase.title,
				status: 'fail',
				detail: error instanceof Error ? error.message : String(error),
				dataPoints: viewCase.dataPoints,
			};
		}

		const probeResult = await probePromise;
		const evaluated = probeResult.metrics
			? evaluateViewRegressionProbe(viewCase.expectations, probeResult.metrics)
			: { pass: probeResult.pass, summary: probeResult.summary };

		return {
			id: viewCase.id,
			title: viewCase.title,
			status: evaluated.pass ? 'pass' : 'fail',
			detail: probeResult.summary || evaluated.summary,
			dataPoints: viewCase.dataPoints,
			probe: probeResult.metrics,
		};
	}

	public async runLocalViewRegression(): Promise<void> {
		if (this.context.extensionMode !== vscode.ExtensionMode.Development) {
			await vscode.window.showWarningMessage('Local view regression is only available in the Extension Development Host.');
			return;
		}

		this.outputChannel.show(true);

		const previousSampleDir = this.localRegressionSampleDataDir;
		this.localRegressionSampleDataDir = '';
		this.sessionDiscovery.clearCache();
		this.lastDetailedStats = undefined;
		this.lastDailyStats = undefined;
		this.lastFullDailyStats = undefined;
		this.lastUsageAnalysisStats = undefined;

		const results: LocalViewRegressionResult[] = [];
		let dataSourceLabel = 'local session data';

		try {
			let sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
			if (sessionFiles.length === 0) {
				let sampleDir: string;
				try {
					sampleDir = await this.ensureLocalViewRegressionSampleDir();
				} catch {
					await vscode.window.showErrorMessage('Bundled sample session data was not found. Expected test fixtures under vscode-extension\\test\\fixtures\\sample-session-data\\chatSessions.');
					return;
				}
				this.localRegressionSampleDataDir = sampleDir;
				this.sessionDiscovery.clearCache();
				sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
				dataSourceLabel = `bundled sample data (${sampleDir})`;
			}

			this.log(`🧪 Starting local view regression using ${dataSourceLabel}. Found ${sessionFiles.length} session file(s).`);

			const detailedStats = await this.updateTokenStats(true);
			if (!detailedStats) {
				throw new Error(`Failed to calculate detailed stats from ${dataSourceLabel}.`);
			}

			const dailyStats = this.lastDailyStats ?? await this.calculateDailyStats();
			const usageStats = await this.calculateUsageAnalysisStats(false);
			const maturityData = await this.calculateMaturityScores(false);
			const diagnosticReport = await this.generateDiagnosticReport();
			const fluencyLevelData = this.getFluencyLevelData(true);
			const totalFluencyLevels = fluencyLevelData.categories.reduce((sum, category) => sum + category.levels.length, 0);
			const categoriesWithEvidence = maturityData.categories.filter((category) => category.evidence.length > 0).length;
			const chartTotals = this.buildChartData(dailyStats);

			const cases: LocalViewRegressionCase[] = [
				{
					id: 'details',
					title: 'Details',
					timeoutMs: 25000,
					expectations: { minRootChildren: 1, minBodyTextLength: 120, minRootTextLength: 80 },
					dataPoints: [
						{ label: 'today tokens', value: detailedStats.today.tokens },
						{ label: '30d tokens', value: detailedStats.last30Days.tokens },
						{ label: '30d sessions', value: detailedStats.last30Days.sessions },
					],
					reset: () => this.detailsPanel?.dispose(),
					open: () => this.showDetails(),
				},
				{
					id: 'chart',
					title: 'Chart',
					timeoutMs: 25000,
					expectations: { minRootChildren: 1, minBodyTextLength: 20, minCanvasOrSvg: 1 },
					dataPoints: [
						{ label: 'days', value: chartTotals.dailyCount },
						{ label: 'tokens', value: chartTotals.totalTokens },
						{ label: 'sessions', value: chartTotals.totalSessions },
					],
					reset: () => this.chartPanel?.dispose(),
					open: () => this.showChart(),
				},
				{
					id: 'usage',
					title: 'Usage Analysis',
					timeoutMs: 25000,
					expectations: { minRootChildren: 1, minBodyTextLength: 140, minRootTextLength: 80 },
					dataPoints: [
						{ label: '30d sessions', value: usageStats.last30Days.sessions },
						{ label: 'repos', value: usageStats.last30Days.repositories.length },
						{ label: 'tool calls', value: usageStats.last30Days.toolCalls.total },
					],
					reset: () => this.analysisPanel?.dispose(),
					open: () => this.showUsageAnalysis(),
				},
				{
					id: 'maturity',
					title: 'Fluency Score',
					timeoutMs: 25000,
					expectations: { minRootChildren: 1, minBodyTextLength: 120, minRootTextLength: 80 },
					dataPoints: [
						{ label: 'overall', value: maturityData.overallLabel },
						{ label: 'categories', value: maturityData.categories.length },
						{ label: 'with evidence', value: categoriesWithEvidence },
					],
					reset: () => this.maturityPanel?.dispose(),
					open: () => this.showMaturity(),
				},
				{
					id: 'environmental',
					title: 'Environmental Impact',
					timeoutMs: 25000,
					expectations: { minRootChildren: 1, minBodyTextLength: 100, minRootTextLength: 70 },
					dataPoints: [
						{ label: '30d tokens', value: detailedStats.last30Days.tokens },
						{ label: 'CO2 g', value: detailedStats.last30Days.co2.toFixed(2) },
						{ label: 'water L', value: detailedStats.last30Days.waterUsage.toFixed(2) },
					],
					reset: () => this.environmentalPanel?.dispose(),
					open: () => this.showEnvironmental(),
				},
				{
					id: 'diagnostics',
					title: 'Diagnostics',
					timeoutMs: 30000,
					expectations: {
						minRootChildren: 1,
						minBodyTextLength: 140,
						minRootTextLength: 80,
						disallowTextPatterns: ['loading...'],
					},
					dataPoints: [
						{ label: 'session files', value: sessionFiles.length },
						{ label: 'report lines', value: diagnosticReport.split(/\r?\n/).length },
					],
					reset: () => this.diagnosticsPanel?.dispose(),
					open: () => this.showDiagnosticReport(),
				},
				{
					id: 'fluency-level-viewer',
					title: 'Fluency Level Viewer',
					timeoutMs: 25000,
					expectations: { minRootChildren: 1, minBodyTextLength: 120, minRootTextLength: 80 },
					dataPoints: [
						{ label: 'categories', value: fluencyLevelData.categories.length },
						{ label: 'levels', value: totalFluencyLevels },
					],
					reset: () => this.fluencyLevelViewerPanel?.dispose(),
					open: () => this.showFluencyLevelViewer(),
				},
			];

			for (const viewCase of cases) {
				results.push(await this.runLocalViewRegressionCase(viewCase));
			}

			results.push({
				id: 'dashboard',
				title: 'Team Dashboard',
				status: 'skip',
				detail: 'Skipped because this view requires a configured backend.',
			});
		} catch (error) {
			results.push({
				id: 'regression-runner',
				title: 'Local regression runner',
				status: 'fail',
				detail: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.pendingLocalViewRegressionProbe = undefined;
			this.localRegressionSampleDataDir = previousSampleDir;
			this.sessionDiscovery.clearCache();
			this.lastDetailedStats = undefined;
			this.lastDailyStats = undefined;
			this.lastFullDailyStats = undefined;
			this.lastUsageAnalysisStats = undefined;
			this.lastDashboardData = undefined;
		}

		const report = formatLocalViewRegressionReport(results);
		this.outputChannel.appendLine('');
		for (const line of report.split(/\r?\n/)) {
			this.outputChannel.appendLine(line);
		}
		this.outputChannel.appendLine('');

		const failures = results.filter((result) => result.status === 'fail').length;
		const passed = results.filter((result) => result.status === 'pass').length;
		const skipped = results.filter((result) => result.status === 'skip').length;
		const summary = failures === 0
			? `Local view regression passed: ${passed} view(s), ${skipped} skipped. Data source: ${dataSourceLabel}.`
			: `Local view regression found ${failures} failing view(s). Data source: ${dataSourceLabel}. See the output channel for details.`;
		const choice = failures === 0
			? await vscode.window.showInformationMessage(summary, 'Show Output')
			: await vscode.window.showWarningMessage(summary, 'Show Output');
		if (choice === 'Show Output') {
			this.outputChannel.show(true);
		}
	}

	// Cache management methods
	/**
	 * Checks if the cache is valid for a file by comparing mtime and size.
	 * If the cache entry is missing size (old format), treat as invalid so it will be upgraded.
	 */

	private getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.cacheManager.getCachedSessionData(filePath);
	}

	/**
	 * Sets the cache entry for a session file, including file size.
	 */
	private setCachedSessionData(filePath: string, data: SessionFileCache, fileSize?: number): void {
		return this.cacheManager.setCachedSessionData(filePath, data);
	}


	/**
	 * Generate a cache identifier based on VS Code extension mode.
	 * VS Code editions (stable vs insiders) already have separate globalState storage,
	 * so we only need to distinguish between production and development (debug) mode.
	 * In development mode, each VS Code window gets a unique cache identifier using
	 * the session ID, preventing the Extension Development Host from sharing/fighting
	 * with the main dev window's cache.
	 */

	/**
	 * Get the path for the cache lock file.
	 * Uses globalStorageUri which is already scoped per VS Code edition.
	 */

	/**
	 * Acquire an exclusive file lock for cache writes.
	 * Uses atomic file creation (O_EXCL / CREATE_NEW) to prevent concurrent writes
	 * across multiple VS Code windows of the same edition.
	 * Returns true if lock acquired, false if another instance holds it.
	 */

	/**
	 * Release the cache lock file, but only if we own it.
	 */

	// Persistent cache storage methods

	/**
	 * One-time migration: remove old per-session cache keys that were created by
	 * earlier versions of the extension (keys containing sessionId or timestamp).
	 * Also removes the legacy unscoped keys ('sessionFileCache', 'sessionFileCacheVersion').
	 */

	private async saveCacheToStorage(): Promise<void> {
		return this.cacheManager.saveCacheToStorage();
	}

	public async clearCache(): Promise<void> {
		try {
			// Show the output channel so users can see what's happening
			this.outputChannel.show(true);
			this.log('Clearing session file cache...');

				const cacheId = this.cacheManager.getCacheIdentifier();
			const cacheKey = `sessionFileCache_${cacheId}`;
			const versionKey = `sessionFileCacheVersion_${cacheId}`;
			
			const cacheSize = this.cacheManager.cache.size;
			this.cacheManager.cache.clear();
			await this.context.globalState.update(cacheKey, undefined);
			await this.context.globalState.update(versionKey, undefined);
			// Reset diagnostics loaded flag so the diagnostics view will reload files
			this.diagnosticsHasLoadedFiles = false;
			this.diagnosticsCachedFiles = [];
			// Clear cached computed stats so details panel doesn't show stale data
			this.lastDetailedStats = undefined;
			this.lastDailyStats = undefined;
			this.lastFullDailyStats = undefined;
			this.lastUsageAnalysisStats = undefined;
			this.lastDashboardData = undefined;

			this.log(`Cache cleared successfully. Removed ${cacheSize} entries.`);
			vscode.window.showInformationMessage('Cache cleared successfully. Reloading statistics...');

			// Trigger a refresh after clearing the cache
			this.log('Reloading token statistics...');
			await this.updateTokenStats();
			this.log('Token statistics reloaded successfully.');
		} catch (error) {
			this.error('Error clearing cache:', error);
			vscode.window.showErrorMessage('Failed to clear cache: ' + error);
		}
	}

	constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.extensionUri = extensionUri;
		this.openCode = new OpenCodeDataAccess(extensionUri);
		this.crush = new CrushDataAccess(extensionUri);
		this.continue_ = new ContinueDataAccess();
		this.visualStudio = new VisualStudioDataAccess();
		this.claudeCode = new ClaudeCodeDataAccess();
		this.claudeDesktopCowork = new ClaudeDesktopCoworkDataAccess();
		this.mistralVibe = new MistralVibeDataAccess();
		this.ecosystems = [
			new OpenCodeAdapter(this.openCode),
			new CrushAdapter(this.crush),
			new VisualStudioAdapter(this.visualStudio, (t, m) => this.estimateTokensFromText(t, m)),
			new ContinueAdapter(this.continue_),
			new ClaudeDesktopAdapter(this.claudeDesktopCowork, (t) => this.isMcpTool(t), (t) => this.extractMcpServerName(t), (t, m) => this.estimateTokensFromText(t, m)),
			new ClaudeCodeAdapter(this.claudeCode),
			new MistralVibeAdapter(this.mistralVibe),
			// Copilot Chat / CLI adapters: discovery-only. Their handles() returns
			// false so the existing fallback parsing in this file continues to
			// own per-session parsing for VS Code Copilot Chat and CLI files.
			// See issue #654.
			new CopilotChatAdapter(),
			new CopilotCliAdapter(),
			new JetBrainsAdapter(),
		];
		this.cacheManager = new CacheManager(context, { log: (m: string) => this.log(m), warn: (m: string) => this.warn(m), error: (m: string) => this.error(m) }, CopilotTokenTracker.CACHE_VERSION);
		this.sessionDiscovery = new SessionDiscovery({
			log: (m) => this.log(m),
			warn: (m) => this.warn(m),
			error: (m, e) => this.error(m, e),
			ecosystems: this.ecosystems,
			sampleDataDirectoryOverride: () => this.localRegressionSampleDataDir,
		});
		this.context = context;
		if (context.extensionMode === vscode.ExtensionMode.Development) {
			try {
				this._devBranch = childProcess.execSync('git rev-parse --abbrev-ref HEAD', {
					cwd: context.extensionUri.fsPath,
					encoding: 'utf8',
					timeout: 5000,
					stdio: ['pipe', 'pipe', 'pipe']
				}).trim();
			} catch {
				// Ignore git errors in dev mode branch detection
			}
		}
		// Create output channel for extension logs
		this.outputChannel = vscode.window.createOutputChannel('AI Engineering Fluency');
		// CRITICAL: Add output channel to context.subscriptions so VS Code doesn't dispose it
		context.subscriptions.push(this.outputChannel);
		this.log('Constructor called');

		// Load persisted cache from storage
		this.cacheManager.loadCacheFromStorage();

		// Restore GitHub authentication session if previously authenticated
		this._sessionRestorePromise = this.restoreGitHubSession();

		// Keep in-memory session in sync if the underlying VS Code auth session changes
		// (e.g. user signs out of GitHub from the Accounts menu or token expires)
		context.subscriptions.push(
			vscode.authentication.onDidChangeSessions(async (e) => {
				if (e.provider.id !== 'github') { return; }
				if (this._githubSignedOutByUser) { return; } // user explicitly disconnected; don't auto-reconnect
				const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
				if (session) {
					this.githubSession = session;
					await this.context.globalState.update('github.authenticated', true);
					await this.context.globalState.update('github.username', session.account.label);
					void this.loadAndLogCopilotPlanInfo();
				} else {
					this.githubSession = undefined;
					await this.context.globalState.update('github.authenticated', false);
					await this.context.globalState.update('github.username', undefined);
					this.log('GitHub session removed externally — clearing auth state');
				}
			})
		);

		// Check GitHub Copilot extension status
		this.sessionDiscovery.checkCopilotExtension();

		// Create status bar item
		this.statusBarItem = vscode.window.createStatusBarItem(
			'ai-engineering-fluency',
			vscode.StatusBarAlignment.Right,
			100
		);
		this.statusBarItem.name = "AI Engineering Fluency";
		this.setStatusBarText("$(loading~spin) AI Fluency: Loading...");
		this.statusBarItem.tooltip = "AI Engineering Fluency — daily and 30-day token usage - Click to open details";
		this.statusBarItem.command = 'aiEngineeringFluency.showDetails';
		this.statusBarItem.show();

		this.log('Status bar item created and shown');

		// Re-render open panels when display settings change
		// Also restart backend sync timer when backend settings change
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('aiEngineeringFluency.display')) {
					this.refreshOpenPanelsForSettingChange();
				}
				if (e.affectsConfiguration('aiEngineeringFluency.backend')) {
					this.startBackendSyncAfterInitialAnalysis();
					// Force an immediate sync so the "Last Sync" timestamp updates right away
					// instead of waiting for the next timer tick.
					const backend = this.backend;
					if (backend && typeof backend.syncToBackendStore === 'function') {
						backend.syncToBackendStore(true).then(() => {
							// Refresh diagnostics again after sync completes so "Last Sync" shows the new time
							if (this.diagnosticsPanel) {
								this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
							}
						}).catch((err: unknown) => {
							this.warn('Backend sync after settings change failed: ' + err);
						});
					}
					// If the diagnostic report is open, refresh it so the Backend Storage
					// section reflects the new settings immediately (e.g. after saving the
					// Team Server config panel).
					if (this.diagnosticsPanel) {
						this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
					}
				}
			})
		);

		// Smart initial update with delay for extension loading
		this.scheduleInitialUpdate();

		// Update every 5 minutes (cache is saved automatically after each update)
		this.updateInterval = setInterval(() => {
			this.updateTokenStats(true); // Silent update from timer
		}, 5 * 60 * 1000);
	}

	private scheduleInitialUpdate(): void {
		this.log('🚀 Starting token usage analysis...');
		// Use a longer delay (3 s) so that:
		// 1. VS Code and other extensions finish their own startup work first.
		// 2. On macOS, the TCC privacy framework has time to resolve any first-time
		//    folder-access permissions before our synchronous filesystem scan begins.
		//    Without this delay the sync fs calls block the shared extension-host
		//    event loop and make VS Code appear frozen.
		// Previously a "wait for Copilot ready" gate provided a similar natural delay;
		// this explicit wait restores that behaviour for users who do not have Copilot.
		setTimeout(async () => {
			try {
				await this.updateTokenStats();
				this.startBackendSyncAfterInitialAnalysis();
				await this.checkAndShowOnboarding();
				await this.showFluencyScoreNewsBanner();
				await this.showUnknownMcpToolsBanner();
			} catch (error) {
				this.error('Error in initial update:', error);
			}
		}, 3000);
	}

	/**
	 * After the initial scan, decide whether to show onboarding guidance.
	 * Branches on three cases:
	 *   1. Returning user (`hasSeenOnboarding` already set) — do nothing.
	 *   2. Genuine first use (no files, no discovery error) — show welcome notification.
	 *   3. Discovery failure (no files + adapter error) — route to Diagnostics.
	 * When data is found, the flag is marked so subsequent runs skip this.
	 */
	private async checkAndShowOnboarding(): Promise<void> {
		const hasSeenOnboarding = this.context.globalState.get<boolean>('hasSeenOnboarding', false);
		const sessionFilesCount = this.sessionDiscovery.lastDiscoveryFilesCount;
		const hadDiscoveryError = this.sessionDiscovery.lastDiscoveryHadError;

		// Compute action from pre-update state so the decision is stable.
		const action = determineOnboardingAction(hasSeenOnboarding, sessionFilesCount, hadDiscoveryError);

		// Mark as seen whenever data is present so future runs skip onboarding.
		if (sessionFilesCount > 0) {
			await this.context.globalState.update('hasSeenOnboarding', true);
		}

		switch (action) {
			case 'welcome': {
				const choice = await vscode.window.showInformationMessage(
					'AI Engineering Fluency tracks your GitHub Copilot usage — token counts, cost estimates, and fluency scores based on how you interact with AI tools.',
					'Open Fluency Score',
					'Learn More',
				);
				await this.context.globalState.update('hasSeenOnboarding', true);
				if (choice === 'Open Fluency Score') {
					await this.showMaturity();
				} else if (choice === 'Learn More') {
					await vscode.env.openExternal(vscode.Uri.parse('https://github.com/rajbos/github-copilot-token-usage#supported-editors'));
				}
				break;
			}
			case 'diagnostics': {
				const choice = await vscode.window.showWarningMessage(
					'AI Engineering Fluency: session files could not be found. Open Diagnostics to investigate.',
					'Open Diagnostics',
				);
				if (choice === 'Open Diagnostics') {
					await this.showDiagnosticReport();
				}
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Start backend sync timer after initial token analysis completes.
	 * This avoids resource contention during extension startup.
	 */
	private startBackendSyncAfterInitialAnalysis(): void {
		try {
			const backend = this.backend;
			if (backend && typeof backend.startTimerIfEnabled === 'function') {
				backend.startTimerIfEnabled();
			}
		} catch (error) {
			this.warn('Failed to start backend sync timer: ' + error);
		}
	}

	private async showFluencyScoreNewsBanner(): Promise<void> {
		const dismissedKey = 'news.fluencyScoreBanner.v1.dismissed';
		if (this.context.globalState.get<boolean>(dismissedKey)) {
			return;
		}
		// If the user already opened the fluency view themselves, no need to prompt them
		const fluencyViewedKey = 'fluencyScore.everOpened';
		if (this.context.globalState.get<boolean>(fluencyViewedKey)) {
			await this.context.globalState.update(dismissedKey, true);
			return;
		}
		const openCountKey = 'extension.openCount';
		const openCount = (this.context.globalState.get<number>(openCountKey) ?? 0) + 1;
		await this.context.globalState.update(openCountKey, openCount);
		if (openCount < 5) {
			return;
		}
		const open = 'Open Fluency Score';
		const dismiss = 'Dismiss';
		const choice = await vscode.window.showInformationMessage(
			'🎯 New: AI Engineering Fluency Score dashboard — track how deeply your team uses GitHub Copilot across 6 categories and 4 stages.',
			open,
			dismiss
		);
		await this.context.globalState.update(dismissedKey, true);
		if (choice === open) {
			await this.showMaturity();
		}
	}

	private getUnknownMcpToolsFromStats(stats: UsageAnalysisStats): string[] {
		const allTools = new Set<string>();
		Object.keys(stats.today.mcpTools.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.last30Days.mcpTools.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.month.mcpTools.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.today.toolCalls.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.last30Days.toolCalls.byTool).forEach(tool => allTools.add(tool));
		Object.keys(stats.month.toolCalls.byTool).forEach(tool => allTools.add(tool));
		const suppressed = new Set<string>(
			vscode.workspace.getConfiguration('aiEngineeringFluency').get<string[]>('suppressedUnknownTools', [])
		);
		return Array.from(allTools).filter(tool => !this.toolNameMap[tool] && !this.toolNameMap[tool.toLowerCase()] && !suppressed.has(tool)).sort();
	}

	private async showUnknownMcpToolsBanner(): Promise<void> {
		const dismissedKey = 'news.unknownMcpTools.dismissedVersion';
		const dismissedVersion = this.context.globalState.get<string>(dismissedKey);
		if (dismissedVersion === packageJson.version) {
			return;
		}
		const openCountKey = 'extension.unknownMcpOpenCount';
		const openCount = (this.context.globalState.get<number>(openCountKey) ?? 0) + 1;
		await this.context.globalState.update(openCountKey, openCount);
		if (openCount < 8) {
			return;
		}
		const stats = await this.calculateUsageAnalysisStats(true);
		const unknownTools = this.getUnknownMcpToolsFromStats(stats);
		if (unknownTools.length === 0) {
			return;
		}
		const open = 'Open Usage Analysis';
		const dismiss = 'Dismiss';
		const choice = await vscode.window.showInformationMessage(
			`🔌 Found ${unknownTools.length} tool${unknownTools.length > 1 ? 's' : ''} without friendly names. Help improve the extension by reporting them.`,

			open,
			dismiss
		);
		await this.context.globalState.update(dismissedKey, packageJson.version);
		if (choice === open) {
			await this.showUsageAnalysis();
			setTimeout(() => {
				this.analysisPanel?.webview.postMessage({ command: 'highlightUnknownTools' });
			}, 500);
		}
	}

	private setStatusBarText(text: string): void {
		this.statusBarItem.text = this._devBranch ? `${text} [${this._devBranch}]` : text;
	}

	/**
	 * Authenticate with GitHub using VS Code's authentication API.
	 */
	public async authenticateWithGitHub(): Promise<void> {
		try {
			this.log('Attempting GitHub authentication...');
			const session = await vscode.authentication.getSession(
				'github',
				['read:user'],
				{ createIfNone: true }
			);
			if (session) {
				this.githubSession = session;
				this._githubSignedOutByUser = false;
				await this.context.globalState.update('github.signedOutByUser', false);
				this.log(`✅ Successfully authenticated as ${session.account.label}`);
				vscode.window.showInformationMessage(`GitHub authentication successful! Logged in as ${session.account.label}`);
				await this.context.globalState.update('github.authenticated', true);
				await this.context.globalState.update('github.username', session.account.label);
				void this.loadAndLogCopilotPlanInfo();
			}
		} catch (error) {
			this.error('GitHub authentication failed:', error);
			vscode.window.showErrorMessage('Failed to authenticate with GitHub. Please try again.');
		}
	}

	/**
	 * Sign out from GitHub.
	 */
	public async signOutFromGitHub(): Promise<void> {
		try {
			this.log('Signing out from GitHub...');
			this.githubSession = undefined;
			this._githubSignedOutByUser = true;
			await this.context.globalState.update('github.authenticated', false);
			await this.context.globalState.update('github.username', undefined);
			await this.context.globalState.update('github.signedOutByUser', true);
			this.log('✅ Successfully signed out from GitHub');
			vscode.window.showInformationMessage('Signed out from GitHub successfully.');

			// Notify the analysis panel so the Repository PRs tab shows "not authenticated"
			if (this.analysisPanel) {
				const since = new Date();
				since.setDate(since.getDate() - 30);
				const result: RepoPrStatsResult = { repos: [], authenticated: false, since: since.toISOString() };
				this._lastRepoPrStats = result;
				this.analysisPanel.webview.postMessage({ command: 'repoPrStatsLoaded', data: result });
			}
		} catch (error) {
			this.error('Failed to sign out from GitHub:', error);
			vscode.window.showErrorMessage('Failed to sign out from GitHub.');
		}
	}

	/**
	 * Get the current GitHub authentication status.
	 */
	public getGitHubAuthStatus(): { authenticated: boolean; username?: string } {
		// Check in-memory session first — avoids race with globalState writes on startup
		if (this.githubSession) {
			return { authenticated: true, username: this.githubSession.account.label };
		}
		const authenticated = this.context.globalState.get<boolean>('github.authenticated', false);
		const username = this.context.globalState.get<string>('github.username');
		return { authenticated, username };
	}

	/**
	 * Check if the user is authenticated with GitHub.
	 */
	public isGitHubAuthenticated(): boolean {
		// Primary check: in-memory session
		if (this.githubSession !== undefined) {
			return true;
		}
		// Fallback: check persisted state (session may not be restored yet)
		// Note: This may be true even if the session is expired
		// The restoreGitHubSession method will reconcile this on startup
		return this.context.globalState.get<boolean>('github.authenticated', false);
	}

	/**
	 * Get the current GitHub session (if authenticated).
	 */
	public getGitHubSession(): vscode.AuthenticationSession | undefined {
		return this.githubSession;
	}

	/** Load PR stats for all discovered GitHub repos and send results to the analysis panel. */
	private async loadRepoPrStats(): Promise<void> {
		if (!this.analysisPanel) { return; }

		const since = new Date();
		since.setDate(since.getDate() - 30);

		// If the user explicitly signed out from our extension, don't auto-acquire the VS Code session
		if (this._githubSignedOutByUser) {
			const result: RepoPrStatsResult = { repos: [], authenticated: false, since: since.toISOString() };
			this._lastRepoPrStats = result;
			this.analysisPanel.webview.postMessage({ command: 'repoPrStatsLoaded', data: result });
			return;
		}

		// Require GitHub auth — read:user gives 5000 req/hr on public repos
		const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
		if (!session) {
			const result: RepoPrStatsResult = { repos: [], authenticated: false, since: since.toISOString() };
			this._lastRepoPrStats = result;
			this.analysisPanel.webview.postMessage({ command: 'repoPrStatsLoaded', data: result });
			return;
		}

		// Sync our tracked auth state if VS Code already has a session we weren't aware of
		// (e.g. from GitHub Copilot or another extension that authenticated earlier)
		if (!this.githubSession) {
			this.githubSession = session;
			await this.context.globalState.update('github.authenticated', true);
			await this.context.globalState.update('github.username', session.account.label);
			this.log(`✅ GitHub session synced from existing VS Code auth: ${session.account.label}`);
		}

		const workspacePaths = this._buildWorkspacePaths();
		const repos = discoverGitHubRepos(workspacePaths);
		this.analysisPanel.webview.postMessage({ command: 'repoPrStatsProgress', total: repos.length, done: 0 });

		const results: RepoPrInfo[] = [];
		for (let i = 0; i < repos.length; i++) {
			const { owner, repo } = repos[i];
			const { prs, error } = await fetchRepoPrs(owner, repo, session.accessToken, since);

			let totalPrs = 0;
			let aiAuthoredPrs = 0;
			let aiReviewRequestedPrs = 0;
			const aiDetails: RepoPrDetail[] = [];

			if (!error) {
				totalPrs = prs.length;
				for (const pr of prs) {
					const authorAi = detectAiType(pr.user?.login ?? '');
					if (authorAi) {
						aiAuthoredPrs++;
						aiDetails.push({ number: pr.number, title: pr.title, url: pr.html_url, aiType: authorAi, role: 'author' });
					}
					for (const reviewer of (pr.requested_reviewers ?? [])) {
						const reviewerAi = detectAiType(reviewer.login ?? '');
						if (reviewerAi) {
							aiReviewRequestedPrs++;
							aiDetails.push({ number: pr.number, title: pr.title, url: pr.html_url, aiType: reviewerAi, role: 'reviewer-requested' });
						}
					}
				}
			}

			results.push({
				owner,
				repo,
				repoUrl: `https://github.com/${owner}/${repo}`,
				totalPrs,
				aiAuthoredPrs,
				aiReviewRequestedPrs,
				aiDetails,
				error,
			});

			this.analysisPanel.webview.postMessage({ command: 'repoPrStatsProgress', total: repos.length, done: i + 1 });
		}

		const result: RepoPrStatsResult = { repos: results, authenticated: true, since: since.toISOString() };
		this._lastRepoPrStats = result;
		this.analysisPanel.webview.postMessage({ command: 'repoPrStatsLoaded', data: result });
	}

	/** Collect workspace paths from the customization matrix and currently open VS Code workspace folders. */
	private _buildWorkspacePaths(): string[] {
		const workspacePaths: string[] = [];
		const matrix = this._lastCustomizationMatrix;
		if (matrix && matrix.workspaces.length > 0) {
			for (const ws of matrix.workspaces) {
				if (!ws.workspacePath.startsWith('<unresolved:')) {
					workspacePaths.push(ws.workspacePath);
				}
			}
		}
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const p = folder.uri.fsPath;
			if (!workspacePaths.includes(p)) {
				workspacePaths.push(p);
			}
		}
		return workspacePaths;
	}

	/**
	 * Restore GitHub authentication session on extension startup.
	 * Always attempts a silent getSession so that a pre-existing VS Code GitHub
	 * session (e.g. from GitHub Copilot) is picked up automatically.
	 */
	private async restoreGitHubSession(): Promise<void> {
		try {
			// Respect explicit sign-out — don't auto-restore until user clicks Authenticate again
			this._githubSignedOutByUser = this.context.globalState.get<boolean>('github.signedOutByUser', false);
			if (this._githubSignedOutByUser) {
				this.log('GitHub session restore skipped — user signed out explicitly');
				return;
			}

			// Always try silently — never prompt. This picks up sessions from Copilot
			// or other extensions that already authenticated the user with GitHub.
			const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
			if (session) {
				this.githubSession = session;
				this.log(`✅ GitHub session found for ${session.account.label}`);
				await this.context.globalState.update('github.authenticated', true);
				await this.context.globalState.update('github.username', session.account.label);
				void this.loadAndLogCopilotPlanInfo();
			} else {
				const wasAuthenticated = this.context.globalState.get<boolean>('github.authenticated', false);
				if (wasAuthenticated) {
					// Session was present before but is gone now — clear stored state
					this.log('GitHub session not found - clearing authenticated state');
					await this.context.globalState.update('github.authenticated', false);
					await this.context.globalState.update('github.username', undefined);
				}
			}
		} catch (error) {
			this.warn('Failed to restore GitHub session: ' + String(error));
			await this.context.globalState.update('github.authenticated', false);
			await this.context.globalState.update('github.username', undefined);
		}
	}

	/**
	 * Fetch and log Copilot plan information for the authenticated user.
	 * Best-effort: silently skips if not authenticated or if the endpoint is unavailable.
	 */
	private async loadAndLogCopilotPlanInfo(): Promise<void> {
		if (!this.githubSession) { return; }
		try {
			const { planInfo, statusCode, error } = await fetchCopilotPlanInfo(this.githubSession.accessToken);
			if (error || !planInfo) {
				this.warn(`Copilot plan info unavailable (HTTP ${statusCode ?? 'n/a'}): ${error ?? 'no data'}`);
				return;
			}
			const planId = planInfo.copilot_plan as string | undefined;
			const plans = copilotPlansData.plans as Record<string, { name: string; monthlyPremiumRequests: number | null; monthlyPricePerUser: number; monthlyAiCreditsUsd: number }>;
			const knownPlan = planId ? plans[planId] : undefined;
			const planLabel = knownPlan ? `${knownPlan.name} (${planId})` : (planId ?? 'unknown');
			this.log(`Copilot plan: ${planLabel}`);
			if (knownPlan) {
				const credits = knownPlan.monthlyPremiumRequests !== null ? `${knownPlan.monthlyPremiumRequests.toLocaleString()}/month` : 'unlimited';
				this.log(`  Monthly premium requests: ${credits}`);
				const aiCredits = knownPlan.monthlyAiCreditsUsd > 0 ? `$${knownPlan.monthlyAiCreditsUsd}/month included` : 'none';
				this.log(`  Monthly AI credits: ${aiCredits}`);
				this._copilotPlanResolved = {
					planId: planId!,
					planName: knownPlan.name,
					monthlyAiCreditsUsd: knownPlan.monthlyAiCreditsUsd,
					monthlyPremiumRequests: knownPlan.monthlyPremiumRequests,
				};
			} else if (planId) {
				// Unknown plan ID — store it with no credits so the webview still shows it
				this._copilotPlanResolved = { planId, planName: planId, monthlyAiCreditsUsd: 0, monthlyPremiumRequests: null };
			}
			if (planInfo.ide_chat !== undefined)          { this.log(`  IDE chat: ${planInfo.ide_chat}`); }
			if (planInfo.copilot_ide_agent !== undefined) { this.log(`  Agent mode: ${planInfo.copilot_ide_agent}`); }
			if (planInfo.public_code_suggestions !== undefined) { this.log(`  Public code suggestions: ${planInfo.public_code_suggestions}`); }
			if (planInfo.unlimited_pr_summaries !== undefined)  { this.log(`  Unlimited PR summaries: ${planInfo.unlimited_pr_summaries}`); }
		} catch (err) {
			this.warn('Failed to load Copilot plan info: ' + String(err));
		}
	}

	public async updateTokenStats(silent: boolean = false): Promise<DetailedStats | undefined> {
		try {
			this.log('Updating token stats...');
			const { stats: detailedStats, dailyStats } = await this.calculateDetailedStats(silent ? undefined : (completed, total) => {
				const percentage = Math.round((completed / total) * 100);
				this.setStatusBarText(`$(loading~spin) Analyzing Logs: ${percentage}%`);
			});
			this.lastDailyStats = dailyStats;

			if (detailedStats.today.sessions === 0 && detailedStats.last30Days.sessions === 0) {
				this.setStatusBarText('$(symbol-numeric) No session data yet');
			} else {
				this.setStatusBarText(`$(symbol-numeric) ${this.formatCompact(detailedStats.today.tokens)} | ${this.formatCompact(detailedStats.last30Days.tokens)}`);
			}

			// Create detailed tooltip with improved style
			const tooltip = new vscode.MarkdownString();
			tooltip.isTrusted = false;
			// Title
			tooltip.appendMarkdown('#### AI Engineering Fluency');
			tooltip.appendMarkdown('\n---\n');
			// Table layout for Today
			tooltip.appendMarkdown(`📅 Today  \n`);
			tooltip.appendMarkdown(`|                 |  |\n|-----------------------|-------|\n`);
			tooltip.appendMarkdown(`| Tokens :                | ${detailedStats.today.tokens.toLocaleString()} |\n`);
			tooltip.appendMarkdown(`| Estimated cost (est.) :      | $ ${detailedStats.today.estimatedCost.toFixed(2)} |\n`);
			tooltip.appendMarkdown(`| Estimated cost (TBB) :       | $ ${(detailedStats.today.estimatedCostCopilot ?? 0).toFixed(2)} |\n`);
			tooltip.appendMarkdown(`| CO₂ estimated :              | ${detailedStats.today.co2.toFixed(2)} grams |\n`);
			tooltip.appendMarkdown(`| Water estimated :           | ${detailedStats.today.waterUsage.toFixed(3)} liters |\n`);
			tooltip.appendMarkdown(`| Sessions :             | ${detailedStats.today.sessions} |\n`);
			tooltip.appendMarkdown(`| Average interactions/session :     | ${detailedStats.today.avgInteractionsPerSession} |\n`);
			tooltip.appendMarkdown(`| Average tokens/session :            | ${detailedStats.today.avgTokensPerSession.toLocaleString()} |\n`);

			tooltip.appendMarkdown('\n---\n');

			// Table layout for Last 30 Days
			tooltip.appendMarkdown(`📊 Last 30 Days  \n`);
			tooltip.appendMarkdown(`|                 |  |\n|-----------------------|-------|\n`);
			tooltip.appendMarkdown(`| Tokens :                | ${detailedStats.last30Days.tokens.toLocaleString()} |\n`);
			tooltip.appendMarkdown(`| Estimated cost (est.) :      | $ ${detailedStats.last30Days.estimatedCost.toFixed(2)} |\n`);
			tooltip.appendMarkdown(`| Estimated cost (TBB) :       | $ ${(detailedStats.last30Days.estimatedCostCopilot ?? 0).toFixed(2)} |\n`);
			tooltip.appendMarkdown(`| CO₂ estimated :              | ${detailedStats.last30Days.co2.toFixed(2)} grams |\n`);
			tooltip.appendMarkdown(`| Water estimated :           | ${detailedStats.last30Days.waterUsage.toFixed(3)} liters |\n`);
			tooltip.appendMarkdown(`| Sessions :             | ${detailedStats.last30Days.sessions} |\n`);
			tooltip.appendMarkdown(`| Average interactions/session :      | ${detailedStats.last30Days.avgInteractionsPerSession} |\n`);
			tooltip.appendMarkdown(`| Average tokens/session :            | ${detailedStats.last30Days.avgTokensPerSession.toLocaleString()} |\n`);
			// Footer
			tooltip.appendMarkdown('\n---\n');
			tooltip.appendMarkdown('*Cost estimates based on actual input/output token ratios.*  \n');
			tooltip.appendMarkdown('*(est.) = provider API market rates, for reference only.*  \n');
			tooltip.appendMarkdown('*(TBB) = Copilot AI Credit rates — what Copilot will bill you.*  \n');
			tooltip.appendMarkdown('*Updates automatically every 5 minutes.*');

			this.statusBarItem.tooltip = tooltip;

			// If the details panel is open, update its content
			if (this.detailsPanel) {
				if (silent) {
					// Background update: send data via postMessage to preserve UI state (scroll position, open sections)
					void this.detailsPanel.webview.postMessage({
						command: 'updateStats',
						data: {
							today: detailedStats.today,
							month: detailedStats.month,
							lastMonth: detailedStats.lastMonth,
							last30Days: detailedStats.last30Days,
							lastUpdated: detailedStats.lastUpdated.toISOString(),
							backendConfigured: this.isBackendConfigured(),
							compactNumbers: this.getCompactNumbersSetting(),
						},
					});
				} else {
					this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, detailedStats);
				}
			}

			// If the chart panel is open, update its content (prefer full-year stats for week/month views)
			if (this.chartPanel && (this.lastFullDailyStats || this.lastDailyStats)) {
				const chartStats = this.lastFullDailyStats ?? this.lastDailyStats!;
				if (silent) {
					// Background update: send data via postMessage to preserve the active chart view toggle
					void this.chartPanel.webview.postMessage({ command: 'updateChartData', data: { ...this.buildChartData(chartStats), compactNumbers: this.getCompactNumbersSetting() } });
				} else {
					this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, chartStats);
				}
			}

			// If the analysis panel is open, update its content via postMessage to preserve repo hygiene results
			if (this.analysisPanel) {
				const analysisStats = await this.calculateUsageAnalysisStats(false); // Force recalculation on refresh
				if (silent) {
					// Background update: send data via postMessage so repo analysis results are preserved.
					// The webview re-renders stats but repoAnalysisState (module-level) restores analysis results.
					void this.analysisPanel.webview.postMessage({
						command: 'updateStats',
						data: {
							today: analysisStats.today,
							last30Days: analysisStats.last30Days,
							month: analysisStats.month,
							locale: analysisStats.locale,
							customizationMatrix: analysisStats.customizationMatrix || null,
							missedPotential: analysisStats.missedPotential || [],
							lastUpdated: analysisStats.lastUpdated.toISOString(),
							backendConfigured: this.isBackendConfigured(),
							currentWorkspacePaths: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
						},
					});
				} else {
					this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);
				}
			} else {
				// Skip pre-warming usage analysis when the panel isn't open.
				// calculateUsageAnalysisStats triggers workspace customization scans
				// and JSONL reconstruction which can starve the extension host event loop
				// on startup, amplifying the crash-loop risk.
			}

			// If the maturity panel is open, update its content.
			// During background (silent) updates, skip to preserve demo panel state and user overrides.
			// Always compute a fresh score so it can be reused for the sharing server upload below.
			const freshMaturityData = (!silent || this.maturityPanel)
				? await this.calculateMaturityScores(false)
				: undefined;
			if (this.maturityPanel && !silent && freshMaturityData) {
				this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, freshMaturityData);
			}

			// Upload the fluency score to the sharing server so its dashboard shows the same result
			// as the extension's local AI Fluency Score panel (avoids independent re-computation).
			// Run fire-and-forget to not block the UI update.
			if (this.backend) {
				const settings = this.backend.getSettings();
				if (settings.sharingServerEnabled && settings.sharingServerEndpointUrl) {
					// Use the already-computed fresh score when available; otherwise compute now.
					Promise.resolve(freshMaturityData ?? this.calculateMaturityScores(false)).then((maturityData) => {
						const scorePayload: Record<string, unknown> = {
							overallStage: maturityData.overallStage,
							overallLabel: maturityData.overallLabel,
							categories: maturityData.categories.map((c: any) => ({
								category: c.category,
								icon: c.icon,
								stage: c.stage,
								tips: c.tips,
							})),
							computedAt: new Date().toISOString(),
						};
						return this.backend!.uploadFluencyScoreToSharingServer(settings, scorePayload);
					}).catch((err: unknown) => {
						this.warn(`Failed to upload fluency score to sharing server: ${err}`);
					});
				}
			}

			// If the environmental panel is open, update its content
			if (this.environmentalPanel) {
				if (silent) {
					void this.environmentalPanel.webview.postMessage({
						command: 'updateStats',
						data: {
							today: detailedStats.today,
							month: detailedStats.month,
							lastMonth: detailedStats.lastMonth,
							last30Days: detailedStats.last30Days,
							lastUpdated: detailedStats.lastUpdated.toISOString(),
							backendConfigured: this.isBackendConfigured(),
							compactNumbers: this.getCompactNumbersSetting(),
						},
					});
				} else {
					this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, detailedStats);
				}
			}

			this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Last 30 Days: ${detailedStats.last30Days.tokens}`);
			// Store the stats for reuse without recalculation
			this.lastDetailedStats = detailedStats;

			// Save cache to ensure it's persisted for next run (don't await to avoid blocking UI)
			this.saveCacheToStorage().catch(err => {
				this.warn(`Failed to save cache: ${err}`);
			});

			// Pre-warm full-year chart data in background so the chart opens without delay.
			// Only kick off when not already computed and the chart panel isn't open (showChart handles that case).
			if (!this.lastFullDailyStats && !this.chartPanel) {
				void this.calculateDailyStats();
			}

			return detailedStats;
		} catch (error) {
			this.error('Error updating token stats:', error);
			this.setStatusBarText('$(error) Token Error');
			this.statusBarItem.tooltip = 'Error calculating token usage';
			return undefined;
		}
	}

	private async calculateTokenUsage(): Promise<Pick<TokenUsageStats, 'todayTokens' | 'monthTokens'>> {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		let todayTokens = 0;
		let monthTokens = 0;

		try {
			// Get session files from both workspace and global storage
			const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();

			const fileResults = await this.runWithConcurrency(sessionFiles, async (sessionFile) => {
				const fileStats = await this.statSessionFile(sessionFile);
				const mtime = fileStats.mtime.getTime();
				const fileSize = fileStats.size;
				if (mtime < monthStart.getTime()) { return null; }
				const tokens = (await this.getSessionFileDataCached(sessionFile, mtime, fileSize)).tokens;
				return { mtime, tokens };
			});

			for (const r of fileResults) {
				if (!r) { continue; }
				monthTokens += r.tokens;
				if (r.mtime >= todayStart.getTime()) { todayTokens += r.tokens; }
			}
		} catch (error) {
			this.error('Error calculating token usage:', error);
		}

		return {
			todayTokens,
			monthTokens
		};
	}

	private async calculateDetailedStats(progressCallback?: (completed: number, total: number) => void): Promise<{ stats: DetailedStats; dailyStats: DailyTokenStats[] }> {
		const now = new Date();
		// UTC-based date keys for consistent daily attribution (matching server-side)
		const { todayUtcKey, monthUtcStartKey, lastMonthUtcStartKey, lastMonthUtcEndKey, last30DaysUtcStartKey, last30DaysStartMs } = computeUtcDateRanges(now);

		let todayStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		let monthStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		let lastMonthStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		let last30DaysStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };

		// Daily stats map for the chart (populated by aggregatePeriodStats, finalized below)
		let dailyStatsMap = new Map<string, DailyTokenStats>();

		try {
			// Clean expired cache entries
			this.cacheManager.clearExpiredCache();

			const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
			this.log(`📊 Analyzing ${sessionFiles.length} session file(s)...`);

			if (sessionFiles.length === 0) {
				this.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}

			let cacheHits = 0;
			let cacheMisses = 0;
			let skippedFiles = 0;

			// Gather per-file data (stat + cache lookup + details) in parallel with bounded concurrency,
			// then aggregate results sequentially. This avoids serialising hundreds of cheap cache hits.
			const sessionDataResults = await this.runWithConcurrency(sessionFiles, async (sessionFile, i) => {
				if (progressCallback) { progressCallback(i + 1, sessionFiles.length); }
				const fileStats = await this.statSessionFile(sessionFile);
				const mtime = fileStats.mtime.getTime();
				const fileSize = fileStats.size;
				if (mtime < last30DaysStartMs) { return null; }
				const cachedData = this.getCachedSessionData(sessionFile);
				const wasCached = cachedData !== undefined && cachedData.mtime === mtime && cachedData.size === fileSize;
				const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
				if (sessionData.interactions === 0) { return null; }
				const details = await this.getSessionFileDetails(sessionFile);
				return { sessionFile, sessionData, details, mtime, wasCached };
			});

			// Build pure-function inputs: map non-null results and track cache stats
			const aggregateInputs: SessionAggregateInput[] = [];
			for (const r of sessionDataResults) {
				if (!r) { skippedFiles++; continue; }
				if (r.wasCached) { cacheHits++; } else { cacheMisses++; }
				try {
					aggregateInputs.push({
						editorType: this.getEditorTypeFromPath(r.sessionFile),
						sessionData: r.sessionData,
						mtime: r.mtime,
						lastInteraction: r.sessionData.lastInteraction || r.details.lastInteraction,
					});
				} catch (fileError) {
					this.warn(`Error processing session file ${r.sessionFile}: ${fileError}`);
				}
			}

			// Delegate all token accumulation to the pure helper
			const aggregated = aggregatePeriodStats(aggregateInputs, {
				todayUtcKey,
				monthUtcStartKey,
				lastMonthUtcStartKey,
				lastMonthUtcEndKey,
				last30DaysUtcStartKey,
				last30DaysStartMs,
			});
			todayStats = aggregated.todayStats;
			monthStats = aggregated.monthStats;
			lastMonthStats = aggregated.lastMonthStats;
			last30DaysStats = aggregated.last30DaysStats;
			dailyStatsMap = aggregated.dailyStatsMap;
			skippedFiles += aggregated.skippedCount;

			this.log(`✅ Analysis complete: Today ${todayStats.sessions} sessions, Month ${monthStats.sessions} sessions, Last 30 Days ${last30DaysStats.sessions} sessions, Previous Month ${lastMonthStats.sessions} sessions`);
			if (skippedFiles > 0) {
				this.log(`⏭️ Skipped ${skippedFiles} session file(s) (empty or no activity in recent months)`);
			}
			const totalCacheAccesses = cacheHits + cacheMisses;
			this.log(`💾 Cache performance: ${cacheHits} hits, ${cacheMisses} misses (${totalCacheAccesses > 0 ? ((cacheHits / totalCacheAccesses) * 100).toFixed(1) : 0}% hit rate)`);
		} catch (error) {
			this.error('Error calculating detailed stats:', error);
		}

		// Finalize daily stats: fill in missing days with zero values
		const thirtyDaysAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
		const todayDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
		const existingDates = new Set(dailyStatsMap.keys());
		const fillDate = new Date(thirtyDaysAgo);
		while (fillDate <= todayDate) {
			const dateKey = fillDate.toISOString().slice(0, 10);
			if (!existingDates.has(dateKey)) {
				dailyStatsMap.set(dateKey, {
					date: dateKey,
					tokens: 0,
					sessions: 0,
					interactions: 0,
					modelUsage: {},
					editorUsage: {},
					repositoryUsage: {}
				});
			}
			fillDate.setUTCDate(fillDate.getUTCDate() + 1);
		}
		const dailyStats = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));

		const todayCo2 = (todayStats.tokens / 1000) * this.co2Per1kTokens;
		const monthCo2 = (monthStats.tokens / 1000) * this.co2Per1kTokens;
		const lastMonthCo2 = (lastMonthStats.tokens / 1000) * this.co2Per1kTokens;
		const last30DaysCo2 = (last30DaysStats.tokens / 1000) * this.co2Per1kTokens;

		const todayWater = (todayStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const monthWater = (monthStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const lastMonthWater = (lastMonthStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const last30DaysWater = (last30DaysStats.tokens / 1000) * this.waterUsagePer1kTokens;

		const todayCost = this.calculateEstimatedCost(todayStats.modelUsage);
		const monthCost = this.calculateEstimatedCost(monthStats.modelUsage);
		const lastMonthCost = this.calculateEstimatedCost(lastMonthStats.modelUsage);
		const last30DaysCost = this.calculateEstimatedCost(last30DaysStats.modelUsage);

		const todayCostCopilot = this.calculateEstimatedCost(todayStats.modelUsage, 'copilot');
		const monthCostCopilot = this.calculateEstimatedCost(monthStats.modelUsage, 'copilot');
		const lastMonthCostCopilot = this.calculateEstimatedCost(lastMonthStats.modelUsage, 'copilot');
		const last30DaysCostCopilot = this.calculateEstimatedCost(last30DaysStats.modelUsage, 'copilot');

		const result: DetailedStats = {
			today: {
				tokens: todayStats.tokens,
				thinkingTokens: todayStats.thinkingTokens,
				estimatedTokens: todayStats.estimatedTokens,
				actualTokens: todayStats.actualTokens,
				sessions: todayStats.sessions,
				avgInteractionsPerSession: todayStats.sessions > 0 ? Math.round(todayStats.interactions / todayStats.sessions) : 0,
				avgTokensPerSession: todayStats.sessions > 0 ? Math.round(todayStats.tokens / todayStats.sessions) : 0,
				modelUsage: todayStats.modelUsage,
				editorUsage: todayStats.editorUsage,
				co2: todayCo2,
				treesEquivalent: todayCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: todayWater,
				estimatedCost: todayCost,
				estimatedCostCopilot: todayCostCopilot
			},
			month: {
				tokens: monthStats.tokens,
				thinkingTokens: monthStats.thinkingTokens,
				estimatedTokens: monthStats.estimatedTokens,
				actualTokens: monthStats.actualTokens,
				sessions: monthStats.sessions,
				avgInteractionsPerSession: monthStats.sessions > 0 ? Math.round(monthStats.interactions / monthStats.sessions) : 0,
				avgTokensPerSession: monthStats.sessions > 0 ? Math.round(monthStats.tokens / monthStats.sessions) : 0,
				modelUsage: monthStats.modelUsage,
				editorUsage: monthStats.editorUsage,
				co2: monthCo2,
				treesEquivalent: monthCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: monthWater,
				estimatedCost: monthCost,
				estimatedCostCopilot: monthCostCopilot
			},
			lastMonth: {
				tokens: lastMonthStats.tokens,
				thinkingTokens: lastMonthStats.thinkingTokens,
				estimatedTokens: lastMonthStats.estimatedTokens,
				actualTokens: lastMonthStats.actualTokens,
				sessions: lastMonthStats.sessions,
				avgInteractionsPerSession: lastMonthStats.sessions > 0 ? Math.round(lastMonthStats.interactions / lastMonthStats.sessions) : 0,
				avgTokensPerSession: lastMonthStats.sessions > 0 ? Math.round(lastMonthStats.tokens / lastMonthStats.sessions) : 0,
				modelUsage: lastMonthStats.modelUsage,
				editorUsage: lastMonthStats.editorUsage,
				co2: lastMonthCo2,
				treesEquivalent: lastMonthCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: lastMonthWater,
				estimatedCost: lastMonthCost,
				estimatedCostCopilot: lastMonthCostCopilot
			},
			last30Days: {
				tokens: last30DaysStats.tokens,
				thinkingTokens: last30DaysStats.thinkingTokens,
				estimatedTokens: last30DaysStats.estimatedTokens,
				actualTokens: last30DaysStats.actualTokens,
				sessions: last30DaysStats.sessions,
				avgInteractionsPerSession: last30DaysStats.sessions > 0 ? Math.round(last30DaysStats.interactions / last30DaysStats.sessions) : 0,
				avgTokensPerSession: last30DaysStats.sessions > 0 ? Math.round(last30DaysStats.tokens / last30DaysStats.sessions) : 0,
				modelUsage: last30DaysStats.modelUsage,
				editorUsage: last30DaysStats.editorUsage,
				co2: last30DaysCo2,
				treesEquivalent: last30DaysCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: last30DaysWater,
				estimatedCost: last30DaysCost,
				estimatedCostCopilot: last30DaysCostCopilot
			},
			lastUpdated: now
		};

		return { stats: result, dailyStats };
	}

	private formatDateKey(date: Date): string {
		return date.toISOString().slice(0, 10); // UTC-based YYYY-MM-DD key
	}

	/**
	 * Formats a token count using K/M suffixes for compact display (e.g. 1,500 → 1.5K, 1,200,000 → 1.2M).
	 * Falls back to full locale number when the compact numbers setting is disabled.
	 */
	private formatCompact(value: number): string {
		if (!this.getCompactNumbersSetting()) {
			return value.toLocaleString();
		}
		return new Intl.NumberFormat(undefined, {
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(value);
	}

	private getCompactNumbersSetting(): boolean {
		return vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('display.compactNumbers', true);
	}

	private refreshOpenPanelsForSettingChange(): void {
		const stats = this.lastDetailedStats;
		if (!stats) { return; }
		// Refresh status bar text (respects new compact setting)
		this.setStatusBarText(`$(symbol-numeric) ${this.formatCompact(stats.today.tokens)} | ${this.formatCompact(stats.last30Days.tokens)}`);
		if (this.detailsPanel) {
			this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);
		}
		if (this.environmentalPanel) {
			this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, stats);
		}
		if (this.chartPanel && (this.lastFullDailyStats || this.lastDailyStats)) {
			this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, this.lastFullDailyStats ?? this.lastDailyStats!);
		}
	}

	/** Compute daily token stats for up to `daysBack` days, using the same token preference
	 *  (actualTokens > estimatedTokens) and UTC date assignment as calculateDetailedStats
	 *  so all chart period views are consistent. Stores the result in
	 *  `lastFullDailyStats` and returns it. Zero-fill is handled per-period in buildChartData. */
	private async calculateDailyStats(daysBack = 365): Promise<DailyTokenStats[]> {
		const now = new Date();
		const cutoffUtcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack));
		const cutoffUtcStartKey = cutoffUtcStart.toISOString().slice(0, 10);
		const cutoffMs = cutoffUtcStart.getTime();

		const dailyStatsMap = new Map<string, DailyTokenStats>();

		try {
			const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
			this.log(`📈 Preparing chart data (${daysBack}d) from ${sessionFiles.length} session file(s)...`);

			const dailyResults = await this.runWithConcurrency(sessionFiles, async (sessionFile) => {
				const fileStats = await this.statSessionFile(sessionFile);
				const mtime = fileStats.mtime.getTime();
				const fileSize = fileStats.size;
				if (mtime < cutoffMs) { return null; }
				const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
				return { sessionFile, sessionData, mtime };
			});

			for (const r of dailyResults) {
				if (!r) { continue; }
				const { sessionFile, sessionData, mtime } = r;
				try {
					const editorType = this.getEditorTypeFromPath(sessionFile);
					const repository = sessionData.repository || 'Unknown';

					if (sessionData.dailyRollups && Object.keys(sessionData.dailyRollups).length > 0) {
						// Per-UTC-day rollup path
						for (const [dayKey, dayRollup] of Object.entries(sessionData.dailyRollups)) {
							if (dayKey < cutoffUtcStartKey) { continue; }
							const dayTokens = dayRollup.actualTokens > 0 ? dayRollup.actualTokens : dayRollup.tokens;

							if (!dailyStatsMap.has(dayKey)) {
								dailyStatsMap.set(dayKey, { date: dayKey, tokens: 0, sessions: 0, interactions: 0, modelUsage: {}, editorUsage: {}, repositoryUsage: {} });
							}
							const dailyEntry = dailyStatsMap.get(dayKey)!;
							dailyEntry.tokens += dayTokens;
							dailyEntry.sessions += 1;
							dailyEntry.interactions += dayRollup.interactions;
							if (!dailyEntry.editorUsage[editorType]) { dailyEntry.editorUsage[editorType] = { tokens: 0, sessions: 0 }; }
							dailyEntry.editorUsage[editorType].tokens += dayTokens;
							dailyEntry.editorUsage[editorType].sessions += 1;
							if (!dailyEntry.repositoryUsage[repository]) { dailyEntry.repositoryUsage[repository] = { tokens: 0, sessions: 0 }; }
							dailyEntry.repositoryUsage[repository].tokens += dayTokens;
							dailyEntry.repositoryUsage[repository].sessions += 1;
							for (const [model, usage] of Object.entries(dayRollup.modelUsage)) {
								if (!dailyEntry.modelUsage[model]) { dailyEntry.modelUsage[model] = { inputTokens: 0, outputTokens: 0 }; }
								dailyEntry.modelUsage[model].inputTokens += usage.inputTokens;
								dailyEntry.modelUsage[model].outputTokens += usage.outputTokens;
							}
						}
					} else {
						// Fallback: session-level attribution
						const estimatedTokens = sessionData.tokens;
						const actualTokens = sessionData.actualTokens || 0;
						const tokens = actualTokens > 0 ? actualTokens : estimatedTokens;
						const interactions = sessionData.interactions;
						const modelUsage = sessionData.modelUsage;

						const lastActivity = sessionData.lastInteraction
							? new Date(sessionData.lastInteraction)
							: new Date(mtime);
						const dateKey = lastActivity.toISOString().slice(0, 10);
						if (dateKey < cutoffUtcStartKey) { continue; }

						if (!dailyStatsMap.has(dateKey)) {
							dailyStatsMap.set(dateKey, { date: dateKey, tokens: 0, sessions: 0, interactions: 0, modelUsage: {}, editorUsage: {}, repositoryUsage: {} });
						}
						const dailyEntry = dailyStatsMap.get(dateKey)!;
						dailyEntry.tokens += tokens;
						dailyEntry.sessions += 1;
						dailyEntry.interactions += interactions;
						if (!dailyEntry.editorUsage[editorType]) { dailyEntry.editorUsage[editorType] = { tokens: 0, sessions: 0 }; }
						dailyEntry.editorUsage[editorType].tokens += tokens;
						dailyEntry.editorUsage[editorType].sessions += 1;
						if (!dailyEntry.repositoryUsage[repository]) { dailyEntry.repositoryUsage[repository] = { tokens: 0, sessions: 0 }; }
						dailyEntry.repositoryUsage[repository].tokens += tokens;
						dailyEntry.repositoryUsage[repository].sessions += 1;
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!dailyEntry.modelUsage[model]) { dailyEntry.modelUsage[model] = { inputTokens: 0, outputTokens: 0 }; }
							dailyEntry.modelUsage[model].inputTokens += usage.inputTokens;
							dailyEntry.modelUsage[model].outputTokens += usage.outputTokens;
						}
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile} for daily stats: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating daily stats:', error);
		}

		const result = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
		this.lastFullDailyStats = result;
		return result;
	}

	private detectMissedPotential(
		workspaceSessionCounts: Map<string, number>,
		workspaceInteractionCounts: Map<string, number>
	): MissedPotentialWorkspace[] {
		const missedPotential: MissedPotentialWorkspace[] = [];

		for (const [workspacePath, sessionCount] of workspaceSessionCounts) {
			const files = this._customizationFilesCache.get(workspacePath) || [];
			
			// Check for Copilot files (category "copilot" or undefined for backward compatibility)
			const hasCopilotFiles = files.some(f => !f.category || f.category === 'copilot');
			
			// Check for non-Copilot files (must be explicitly "non-copilot")
			const nonCopilotFiles = files.filter(f => f.category === 'non-copilot');
			
			// Missed potential = has non-Copilot files AND NO Copilot files
			if (nonCopilotFiles.length > 0 && !hasCopilotFiles) {
				missedPotential.push({
					workspacePath,
					workspaceName: path.basename(workspacePath),
					sessionCount,
					interactionCount: workspaceInteractionCounts.get(workspacePath) || 0,
					nonCopilotFiles
				});
			}
		}

		// Sort by interaction count (descending) so most active "missed" repos are first
		missedPotential.sort((a, b) => b.interactionCount - a.interactionCount);

		return missedPotential;
	}

	/**
	 * Calculate usage analysis statistics for today and last 30 days
	 * @param useCache If true, return cached stats if available. If false, force recalculation.
	 */
	private async calculateUsageAnalysisStats(useCache = true): Promise<UsageAnalysisStats> {
		// Return cached stats if available and cache is allowed
		if (useCache && this.lastUsageAnalysisStats) {
			this.log('🔍 [Usage Analysis] Using cached stats');
			return this.lastUsageAnalysisStats;
		}

		const now = new Date();
		// UTC-based day keys for consistent period boundaries (matching server-side)
		const todayUtcKey = now.toISOString().slice(0, 10);
		const last30DaysUtcStartKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)).toISOString().slice(0, 10);
		const monthUtcStartKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
		const last30DaysStartMs = new Date(last30DaysUtcStartKey).getTime();

		this.log('🔍 [Usage Analysis] Starting calculation...');
		this._cacheHits = 0; // Reset cache hit counter
		this._cacheMisses = 0; // Reset cache miss counter

		const emptyPeriod = (): UsageAnalysisPeriod => ({
			sessions: 0,
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
				terminalLastCommand: 0,
				terminalSelection: 0,
				clipboard: 0,
				changes: 0,
				outputPanel: 0,
				problemsPanel: 0,
				byKind: {},
				copilotInstructions: 0,
				agentsMd: 0,
				byPath: {}
			},
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
				totalRequests: 0
			},
			repositories: [],
			repositoriesWithCustomization: [],
			editScope: {
				singleFileEdits: 0,
				multiFileEdits: 0,
				totalEditedFiles: 0,
				avgFilesPerSession: 0
			},
			applyUsage: {
				totalApplies: 0,
				totalCodeBlocks: 0,
				applyRate: 0
			},
			sessionDuration: {
				totalDurationMs: 0,
				avgDurationMs: 0,
				avgFirstProgressMs: 0,
				avgTotalElapsedMs: 0,
				avgWaitTimeMs: 0
			},
			conversationPatterns: {
				multiTurnSessions: 0,
				singleTurnSessions: 0,
				avgTurnsPerSession: 0,
				maxTurnsInSession: 0
			},
			agentTypes: {
				editsAgent: 0,
				defaultAgent: 0,
				workspaceAgent: 0,
				other: 0
			}
		});

		const todayStats = emptyPeriod();
		const last30DaysStats = emptyPeriod();
		const monthStats = emptyPeriod();

		// Track session counts per resolved workspace (workspaces with activity in last 30 days)
		const workspaceSessionCounts = new Map<string, number>();
		// Track interaction counts per resolved workspace (for prioritization)
		const workspaceInteractionCounts = new Map<string, number>();
		// Track unresolved workspace IDs (failed resolution or no workspace)
		const unresolvedWorkspaceIds = new Set<string>();
		// Track interaction counts for unresolved workspace IDs
		const unresolvedWorkspaceInteractionCounts = new Map<string, number>();

		// Clear short-lived caches for this analysis run
		this._workspaceIdToFolderCache.clear();
		this._customizationFilesCache.clear();

		try {
			const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
			this.log(`🔍 [Usage Analysis] Processing ${sessionFiles.length} session files`);

			let processed = 0;
			const progressInterval = Math.max(1, Math.floor(sessionFiles.length / 20)); // Log every 5%

			// Gather stat + session data in parallel, then aggregate sequentially.
			// The workspace/customization-cache mutations below are not async, so they are safe
			// to run in the sequential aggregation pass even after parallel data fetch.
			const usageResults = await this.runWithConcurrency(sessionFiles, async (sessionFile) => {
				const fileStats = await this.statSessionFile(sessionFile);
				const mtime = fileStats.mtime.getTime();
				const fileSize = fileStats.size;
				if (mtime < last30DaysStartMs) { return null; }
				const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
				return { sessionFile, sessionData, mtime };
			});

			for (const r of usageResults) {
				try {
					if (!r) {
						processed++;
						if (processed % progressInterval === 0) {
							this.log(`🔍 [Usage Analysis] Progress: ${processed}/${sessionFiles.length} files (${Math.round(processed / sessionFiles.length * 100)}%)`);
						}
						continue;
					}
					const { sessionFile, sessionData, mtime } = r;

					const interactions = sessionData.interactions;
					const analysis = sessionData.usageAnalysis || {
						toolCalls: { total: 0, byTool: {} },
						modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
						contextReferences: {
							file: 0,
							selection: 0,
							implicitSelection: 0,
							symbol: 0,
								codebase: 0,
								workspace: 0,
								terminal: 0,
								vscode: 0,
								terminalLastCommand: 0,
								terminalSelection: 0,
								clipboard: 0,
								changes: 0,
								outputPanel: 0,
								problemsPanel: 0,
								byKind: {},
								copilotInstructions: 0,
								agentsMd: 0,
								byPath: {}
							},
							mcpTools: { total: 0, byServer: {}, byTool: {} },
							modelSwitching: {
								uniqueModels: [],
								modelCount: 0,
								switchCount: 0,
								tiers: { standard: [], premium: [], unknown: [] },
								hasMixedTiers: false,
								standardRequests: 0,
								premiumRequests: 0,
								unknownRequests: 0,
								totalRequests: 0
							}
						};

						// Exclude empty sessions (no interactions) from usage analysis
						if (interactions === 0) {
							// Skip counting this session as it contains no user interactions
							processed++;
							if (processed % progressInterval === 0) {
								this.log(`🔍 [Usage Analysis] Progress: ${processed}/${sessionFiles.length} files (${Math.round(processed / sessionFiles.length * 100)}%)`);
							}
							continue;
						}

						// Derive lastActivityUtcKey using dailyRollups if available, else lastInteraction
						let lastActivityUtcKey: string;
						if (sessionData.dailyRollups && Object.keys(sessionData.dailyRollups).length > 0) {
							// Use the most recent day in the rollups
							lastActivityUtcKey = Object.keys(sessionData.dailyRollups).sort().pop()!;
						} else {
							const lastActivity = sessionData.lastInteraction
								? new Date(sessionData.lastInteraction)
								: new Date(mtime);
							lastActivityUtcKey = lastActivity.toISOString().slice(0, 10);
						}

						// Add to last 30 days stats
						if (lastActivityUtcKey < last30DaysUtcStartKey) {
							processed++;
							continue;
						}
						last30DaysStats.sessions++;
						this.mergeUsageAnalysis(last30DaysStats, analysis);

						// Resolve workspace folder and track session counts; also pre-scan customization files for this workspace
						// Extract workspace ID first (this operation should be safe and not throw)
						const workspaceId = _extractWorkspaceIdFromSessionPath(sessionFile);
						try {
							const workspaceFolder = _resolveWorkspaceFolderFromSessionPath(sessionFile, this._workspaceIdToFolderCache);
							if (workspaceFolder) {
								const norm = path.normalize(workspaceFolder);
								workspaceSessionCounts.set(norm, (workspaceSessionCounts.get(norm) || 0) + 1);
								workspaceInteractionCounts.set(norm, (workspaceInteractionCounts.get(norm) || 0) + interactions);
								if (!this._customizationFilesCache.has(norm)) {
									try {
										const files = _scanWorkspaceCustomizationFiles(norm);
										this._customizationFilesCache.set(norm, files);
									} catch (e) {
										// ignore scan errors per workspace
									}
								}
							} else if (workspaceId) {
								// Workspace resolution failed but we have a workspace ID
								// Track it as unresolved so it counts toward total repos
								unresolvedWorkspaceIds.add(workspaceId);
								unresolvedWorkspaceInteractionCounts.set(workspaceId, (unresolvedWorkspaceInteractionCounts.get(workspaceId) || 0) + interactions);
							}
						} catch (e) {
							// Resolution threw an exception; track as unresolved if we have a workspace ID
							if (workspaceId) {
								unresolvedWorkspaceIds.add(workspaceId);
								unresolvedWorkspaceInteractionCounts.set(workspaceId, (unresolvedWorkspaceInteractionCounts.get(workspaceId) || 0) + interactions);
							}
						}

						// Add to month stats if activity falls in this calendar month
						if (lastActivityUtcKey >= monthUtcStartKey) {
							monthStats.sessions++;
							this.mergeUsageAnalysis(monthStats, analysis);
						}

						// Add to today stats if activity falls today
						if (lastActivityUtcKey === todayUtcKey) {
							todayStats.sessions++;
							this.mergeUsageAnalysis(todayStats, analysis);
						}

					processed++;
					if (processed % progressInterval === 0) {
						this.log(`🔍 [Usage Analysis] Progress: ${processed}/${sessionFiles.length} files (${Math.round(processed / sessionFiles.length * 100)}%)`);
					}
				} catch (fileError) {
					this.warn(`Error processing session file for usage analysis: ${fileError}`);
					processed++;
				}
			}

			// Deduplicate workspace paths that resolve to the same physical repository.
			// Two sources of duplication are handled:
			//
			// 1. Case differences on case-insensitive filesystems (Windows/macOS):
			//    Different VS Code variants may store the same folder as "C:\Users\..." vs "c:\users\...".
			//    Detected by lowercasing the full path.
			//
			// 2. Remote/devcontainer paths for the same local repo:
			//    Opening a devcontainer for a local project stores a vscode-remote:// URI whose
			//    resolved fsPath is the *container-internal* path (e.g. "/workspaces/my-repo"),
			//    while normal sessions store the local Windows path.
			//    Both have the same basename, and one of them is a non-local path
			//    (starts with "/workspaces/" or is a Unix-style absolute path on Windows).
			//    Detected by matching basename case-insensitively when one entry is a remote path.
			//
			// In both cases: session/interaction counts are summed; customization file scan results
			// are kept from whichever path has more files (the local path wins for scanning).
			{
				const mergeInto = (winner: string, loser: string) => {
					workspaceSessionCounts.set(winner,
						(workspaceSessionCounts.get(winner) || 0) + (workspaceSessionCounts.get(loser) || 0));
					workspaceInteractionCounts.set(winner,
						(workspaceInteractionCounts.get(winner) || 0) + (workspaceInteractionCounts.get(loser) || 0));
					workspaceSessionCounts.delete(loser);
					workspaceInteractionCounts.delete(loser);
					const winnerFiles = this._customizationFilesCache.get(winner) || [];
					const loserFiles = this._customizationFilesCache.get(loser) || [];
					if (winnerFiles.length === 0 && loserFiles.length > 0) {
						this._customizationFilesCache.set(winner, loserFiles);
					}
					this._customizationFilesCache.delete(loser);
				};

				// Helper: true when path looks like a remote/devcontainer path on Windows
				// (Unix-style absolute path, e.g. "/workspaces/repo" or "/home/user/repo")
				const isRemotePath = (p: string) => {
					if (process.platform !== 'win32') { return false; }
					const normalized = p.replace(/\\/g, '/');
					return normalized.startsWith('/');
				};

				// Pass 1 — case-insensitive dedup (covers casing differences between editor variants)
				if (process.platform === 'win32' || process.platform === 'darwin') {
					const lowerToCanonical = new Map<string, string>();
					for (const key of Array.from(workspaceSessionCounts.keys())) {
						const lower = key.toLowerCase();
						if (!lowerToCanonical.has(lower)) {
							lowerToCanonical.set(lower, key);
						} else {
							const canonical = lowerToCanonical.get(lower)!;
							// Prefer the local (non-remote) path as winner; otherwise more sessions wins
							const canonicalIsRemote = isRemotePath(canonical);
							const keyIsRemote = isRemotePath(key);
							const winner = (!keyIsRemote && canonicalIsRemote)
								? key
								: (!canonicalIsRemote && keyIsRemote)
									? canonical
									: (workspaceSessionCounts.get(key) || 0) >= (workspaceSessionCounts.get(canonical) || 0)
										? key : canonical;
							const loser = winner === key ? canonical : key;
							mergeInto(winner, loser);
							lowerToCanonical.set(lower, winner);
						}
					}
				}

				// Pass 2 — basename dedup for remote/devcontainer paths.
				// When one path is a remote (Unix-style) path and another is a local path with the
				// same basename, they represent the same physical repo opened via a devcontainer.
				if (process.platform === 'win32') {
					const basenameToLocal = new Map<string, string>(); // lower-basename → local path key
					for (const key of Array.from(workspaceSessionCounts.keys())) {
						if (!isRemotePath(key)) {
							basenameToLocal.set(path.basename(key).toLowerCase(), key);
						}
					}
					for (const key of Array.from(workspaceSessionCounts.keys())) {
						if (isRemotePath(key)) {
							const base = path.basename(key).toLowerCase();
							const localKey = basenameToLocal.get(base);
							if (localKey && workspaceSessionCounts.has(key)) {
								// Merge remote into local — local wins because we can scan its files
								mergeInto(localKey, key);
							}
						}
					}
				}
			}

			// Build the customization matrix using scanned workspace data and session counts
			try {
				// Unique customization types based on Copilot patterns only
				const uniqueTypes = new Map<string, { icon: string; label: string }>();
				for (const pattern of (customizationPatternsData as any).patterns || []) {
					if (pattern.category && pattern.category !== 'copilot') {
						continue;
					}
					if (!uniqueTypes.has(pattern.type)) {
						uniqueTypes.set(pattern.type, { icon: pattern.icon || '', label: pattern.label || pattern.type });
					}
				}

				const customizationTypes = Array.from(uniqueTypes.entries()).map(([id, v]) => ({ id, icon: v.icon, label: v.label }));

				const matrixRows: WorkspaceCustomizationRow[] = [];
				let workspacesWithIssues = 0;

				for (const [folderPath, sessionCount] of workspaceSessionCounts) {
					const files = this._customizationFilesCache.get(folderPath) || [];
					const typeStatuses: { [typeId: string]: CustomizationTypeStatus } = {};
					for (const type of customizationTypes) {
						const filesOfType = files.filter(f => f.type === type.id);
						if (filesOfType.length === 0) {
							typeStatuses[type.id] = '❌';
						} else if (filesOfType.some(f => f.isStale)) {
							typeStatuses[type.id] = '⚠️';
						} else {
							typeStatuses[type.id] = '✅';
						}
					}

					// Count workspaces that have NO customization files present at all
					const hasNoCustomizationFiles = customizationTypes.every(t => typeStatuses[t.id] === '❌');
					if (hasNoCustomizationFiles) { workspacesWithIssues++; }

					matrixRows.push({
						workspacePath: folderPath,
						workspaceName: path.basename(folderPath),
						sessionCount,
						interactionCount: workspaceInteractionCounts.get(folderPath) || 0,
						typeStatuses
					});
				}

				// Add unresolved workspaces as rows with all customization types marked as ❌
				// This ensures they count toward total repos and are assumed to have NO customizations
				for (const workspaceId of unresolvedWorkspaceIds) {
					const typeStatuses: { [typeId: string]: CustomizationTypeStatus } = {};
					for (const type of customizationTypes) {
						typeStatuses[type.id] = '❌';
					}
					workspacesWithIssues++; // Unresolved workspaces are counted as having no customization
					
					// Generate display name with smart truncation
					const displayId = workspaceId.length > CopilotTokenTracker.WORKSPACE_ID_DISPLAY_LENGTH
						? `${workspaceId.substring(0, CopilotTokenTracker.WORKSPACE_ID_DISPLAY_LENGTH)}...`
						: workspaceId;
					
					matrixRows.push({
						workspacePath: `<unresolved:${workspaceId}>`,
						workspaceName: `Unresolved (${displayId})`,
						// Session count is 0 because we only track counts in workspaceSessionCounts for successfully resolved workspaces.
						// The presence of this workspace in unresolvedWorkspaceIds means we encountered session files for it,
						// but couldn't resolve its folder path, so we couldn't increment a count in workspaceSessionCounts.
						sessionCount: 0,
						interactionCount: unresolvedWorkspaceInteractionCounts.get(workspaceId) || 0,
						typeStatuses
					});
				}

				matrixRows.sort((a, b) => {
					if (b.interactionCount !== a.interactionCount) {
						return b.interactionCount - a.interactionCount;
					}
					return b.sessionCount - a.sessionCount;
				});

				const customizationMatrix: WorkspaceCustomizationMatrix = {
					customizationTypes,
					workspaces: matrixRows,
					totalWorkspaces: matrixRows.length,
					workspacesWithIssues
				};

				this._lastCustomizationMatrix = customizationMatrix;
				
				// Calculate missed potential (workspaces with non-Copilot instruction files but no Copilot files)
				this._lastMissedPotential = this.detectMissedPotential(workspaceSessionCounts, workspaceInteractionCounts);
			} catch (e) {
				// ignore overall customization scanning errors
			}
		} catch (error) {
			this.error('Error calculating usage analysis stats:', error);
		}

		// Log cache statistics
		this.log(`🔍 [Usage Analysis] Cache stats: ${this._cacheHits} hits, ${this._cacheMisses} misses`);

		const stats: UsageAnalysisStats = {
			today: todayStats,
			last30Days: last30DaysStats,
			month: monthStats,
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
			lastUpdated: now,
			customizationMatrix: this._lastCustomizationMatrix,
			missedPotential: this._lastMissedPotential || []
		};

		// Cache the result for future use
		this.lastUsageAnalysisStats = stats;

		return stats;
	}

	/**
	 * Merge usage analysis data into period stats
	 */
	private mergeUsageAnalysis(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
		return _mergeUsageAnalysis(period, analysis);
	}

	private async countInteractionsInSession(sessionFile: string, preloadedContent?: string): Promise<number> {
		try {
			const eco = this.findEcosystem(sessionFile);
			if (eco) { return eco.countInteractions(sessionFile); }

			const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return 0; // No interactions to count in pointer files
			}

			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				let interactions = 0;
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						// Handle Copilot CLI format
						if (event.type === 'user.message') {
							interactions++;
						}
						// Handle VS Code incremental format (kind: 2 with requests array)
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								if (request.requestId) {
									interactions++;
								}
							}
						}
					} catch (e) {
						// Skip malformed lines
					}
				}
				return interactions;
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			// Count the number of requests as interactions
			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				// Each request in the array represents one user interaction
				return sessionContent.requests.length;
			}

			return 0;
		} catch (error) {
			this.warn(`Error counting interactions in ${sessionFile}: ${error}`);
			return 0;
		}
	}


	/**
	 * Analyze a session file for usage patterns (tool calls, modes, context references, MCP tools)
	 */

	/**
	 * Calculate model switching statistics for a session file.
	 * This method updates the analysis.modelSwitching field in place.
	 */

	/**
	 * Check if a tool name indicates it's an MCP (Model Context Protocol) tool.
	 * MCP tools are identified by names starting with "mcp." or "mcp_"
	 */
	private isMcpTool(toolName: string): boolean {
		return _isMcpTool(toolName);
	}

	/**
	 * Normalize an MCP tool name so that equivalent tools from different servers
	 * (local stdio vs remote) are counted under a single canonical key in "By Tool" views.
	 * Maps mcp_github_github_<action> → mcp_io_github_git_<action>.
	 */

	/**
	 * Extract server name from an MCP tool name.
	 * MCP tool names follow the format: mcp.server.tool or mcp_server_tool
	 * For example: "mcp.io.github.git.assign_copilot_to_issue" → "GitHub MCP"
	 * Uses the display name from toolNames.json (the part before the colon).
	 * Falls back to extracting the second segment if no mapping exists.
	 */
	private extractMcpServerName(toolName: string): string {
		return _extractMcpServerName(toolName, this.toolNameMap);
	}

	/**
	 * Derive conversation patterns from already-computed mode usage.
	 * Called before every return in analyzeSessionUsage to ensure all file formats get patterns.
	 */

	/**
	 * Track enhanced metrics from session files:
	 * - Edit scope (single vs multi-file edits)
	 * - Apply button usage (codeblockUri with isEdit flag)
	 * - Session duration data
	 * - Conversation patterns (multi-turn sessions)
	 * - Agent type usage
	 */

	/**
	 * Analyze a request object for all context references.
	 * This is the unified method that processes text, contentReferences, and variableData.
	 */
	private analyzeRequestContext(request: any, refs: ContextReferenceUsage): void {
		return _analyzeRequestContext(request, refs);
	}

	/**
	 * Analyze text for context references like #file, #selection, @workspace
	 */
	private analyzeContextReferences(text: string, refs: ContextReferenceUsage): void {
		return _analyzeContextReferences(text, refs);
	}

	/**
	 * Analyze contentReferences from session log data to track specific file attachments.
	 * Looks for kind: "reference" entries and tracks by kind, path patterns.
	 * Also increments specific category counters like refs.file when appropriate.
	 */

	/**
	 * Analyze variableData to track prompt file attachments and other variable-based context.
	 * This captures automatic attachments like copilot-instructions.md via variable system.
	 */

	/**
	 * Extract repository remote URL from file paths found in contentReferences.
	 * Looks for .git/config file in the workspace root to get the origin remote URL.
	 * @param contentReferences Array of content reference objects from session data
	 * @returns The repository remote URL if found, undefined otherwise
	 */
	private async extractRepositoryFromContentReferences(contentReferences: any[]): Promise<string | undefined> {
		return _extractRepositoryFromContentReferences(contentReferences);
	}


	private async extractSessionMetadata(sessionFile: string, preloadedContent?: string): Promise<{
		title: string | undefined;
		firstInteraction: string | null;
		lastInteraction: string | null;
		dailyInteractions: { [utcDayKey: string]: number };
	}> {
		let title: string | undefined;
		const timestamps: number[] = [];
		// Request-level timestamps (excludes session creationDate) for per-day interaction counts
		const requestTimestamps: number[] = [];

		try {
			const eco = this.findEcosystem(sessionFile);
			if (eco) {
				const meta = await eco.getMeta(sessionFile);
				return { ...meta, dailyInteractions: {} };
			}

			const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (_isUuidPointerFile(fileContent)) {
				return { title, firstInteraction: null, lastInteraction: null, dailyInteractions: {} };
			}

			const isJsonlContent = sessionFile.endsWith('.jsonl') || _isJsonlContent(fileContent);

			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				let firstUserMessage: string | undefined;
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);

						// Handle Copilot CLI format
						if (event.type === 'user.message') {
							const ts = event.timestamp || event.ts || event.data?.timestamp;
							if (ts) {
								const ms = new Date(ts).getTime();
								timestamps.push(ms);
								requestTimestamps.push(ms);
							}
							if (!firstUserMessage && event.data?.content) {
								firstUserMessage = event.data.content;
							}
						}

						// Handle Copilot CLI rename_session tool call - always use the last rename
						if (event.type === 'tool.execution_start' && event.data?.toolName === 'rename_session') {
							if (event.data?.arguments?.title) { title = event.data.arguments.title; }
						}

						// Handle VS Code incremental .jsonl format
						if (event.kind === 0 && event.v) {
							// creationDate is session creation, not a request — only add to timestamps (not requestTimestamps)
							if (event.v.creationDate) { timestamps.push(event.v.creationDate); }
							// Always update title - we want the LAST title in the file (matches VS Code UI)
							if (event.v.customTitle) { title = event.v.customTitle; }
						}

						// Handle kind: 2 events (requests array with timestamps)
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								if (request.timestamp) {
									timestamps.push(request.timestamp);
									requestTimestamps.push(request.timestamp);
								}
							}
						}

						// Check kind: 1 (value updates) for title changes
						if (event.kind === 1 && event.k?.includes('customTitle') && event.v) {
							title = event.v;
						}
					} catch {
						// Skip malformed lines
					}
				}

				// Fall back to first user message if no explicit title was set
				if (!title && firstUserMessage) {
					const trimmed = firstUserMessage.trim();
					title = trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
				}
			} else {
				// JSON format - try to parse
				try {
					const parsed = JSON.parse(fileContent);
					if (parsed.customTitle) { title = parsed.customTitle; }
					// creationDate is session creation, not a request — only add to timestamps
					if (parsed.creationDate) { timestamps.push(parsed.creationDate); }
					// Extract timestamps from requests array (like getSessionFileDetails does)
					if (parsed.requests && Array.isArray(parsed.requests)) {
						for (const request of parsed.requests) {
							if (request.timestamp || request.ts || request.result?.timestamp) {
								const ts = request.timestamp || request.ts || request.result?.timestamp;
								const ms = new Date(ts).getTime();
								timestamps.push(ms);
								requestTimestamps.push(ms);
							}
						}
					}
				} catch {
					// Unable to parse
				}
			}
		} catch {
			// File read error
		}

		let firstInteraction: string | null = null;
		let lastInteraction: string | null = null;
		if (timestamps.length > 0) {
			timestamps.sort((a, b) => a - b);
			firstInteraction = new Date(timestamps[0]).toISOString();
			lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
		}

		// Build per-UTC-day interaction counts from request timestamps
		const dailyInteractions: { [utcDayKey: string]: number } = {};
		for (const ts of requestTimestamps) {
			const dayKey = new Date(ts).toISOString().slice(0, 10);
			dailyInteractions[dayKey] = (dailyInteractions[dayKey] || 0) + 1;
		}

		return { title, firstInteraction, lastInteraction, dailyInteractions };
	}

	// Cached versions of session file reading methods
	public async getSessionFileDataCached(sessionFilePath: string, mtime: number, fileSize: number): Promise<SessionFileCache> {
		// Check if we have valid cached data
		const cached = this.getCachedSessionData(sessionFilePath);
		if (cached && cached.mtime === mtime && cached.size === fileSize) {
			this._cacheHits++;
			return cached;
		}

		this._cacheMisses++;

		// Pre-read file content once for regular Copilot Chat files to avoid 5 redundant reads
		let preloadedContent: string | undefined;
		const isSpecialSession = this.findEcosystem(sessionFilePath) !== null;
		if (!isSpecialSession) {
			preloadedContent = await fs.promises.readFile(sessionFilePath, 'utf8');
		}

		// Cache miss - process the file (using pre-read content when available)
		const tokenResult = await this.estimateTokensFromSession(sessionFilePath, preloadedContent);
		const interactions = await this.countInteractionsInSession(sessionFilePath, preloadedContent);
		const modelUsage = await _getModelUsageFromSession(this.usageAnalysisDeps, sessionFilePath, preloadedContent);
		const usageAnalysis = await _analyzeSessionUsage(this.usageAnalysisDeps, sessionFilePath, preloadedContent);

		// Extract title and timestamps from the session file
		const sessionMeta = await this.extractSessionMetadata(sessionFilePath, preloadedContent);

		// Compute per-UTC-day rollups by distributing cached totals proportionally across days
		// (same approach as syncService.processCachedSessionFile)
		const dailyRollups: { [utcDayKey: string]: DailyRollupEntry } = {};
		const dailyInteractionMap = sessionMeta.dailyInteractions;
		const totalInteractions = Object.values(dailyInteractionMap).reduce((a, b) => a + b, 0);
		if (totalInteractions > 0) {
			for (const [dayKey, dayInteractionCount] of Object.entries(dailyInteractionMap)) {
				const fraction = dayInteractionCount / totalInteractions;
				const dayModelUsage: ModelUsage = {};
				for (const [model, usage] of Object.entries(modelUsage)) {
					dayModelUsage[model] = {
						inputTokens: Math.round(usage.inputTokens * fraction),
						outputTokens: Math.round(usage.outputTokens * fraction),
					};
				}
				dailyRollups[dayKey] = {
					tokens: Math.round(tokenResult.tokens * fraction),
					actualTokens: Math.round((tokenResult.actualTokens || 0) * fraction),
					thinkingTokens: Math.round((tokenResult.thinkingTokens || 0) * fraction),
					interactions: dayInteractionCount,
					modelUsage: dayModelUsage,
				};
			}
		}

		// Fallback for ecosystem sessions (Mistral Vibe, Claude Desktop Cowork, etc.):
		// extractSessionMetadata always returns dailyInteractions: {} for these formats since
		// their raw files (meta.json, .jsonl) aren't standard Copilot Chat JSONL/JSON.
		// Use firstInteraction to attribute all tokens to the single day of the session so that
		// processCachedSessionFile's fast path can use dailyRollups and does not fall through to
		// the raw-file slow path which cannot parse these non-standard formats.
		if (Object.keys(dailyRollups).length === 0 && tokenResult.tokens > 0 && sessionMeta.firstInteraction) {
			try {
				const interactionDate = new Date(sessionMeta.firstInteraction);
				if (!isNaN(interactionDate.getTime())) {
					const dayKey = interactionDate.toISOString().slice(0, 10);
					const dayModelUsage: ModelUsage = {};
					for (const [model, usage] of Object.entries(modelUsage)) {
						dayModelUsage[model] = {
							inputTokens: usage.inputTokens,
							outputTokens: usage.outputTokens,
						};
					}
					dailyRollups[dayKey] = {
						tokens: tokenResult.tokens,
						actualTokens: tokenResult.actualTokens || 0,
						thinkingTokens: tokenResult.thinkingTokens || 0,
						interactions: Math.max(1, interactions),
						modelUsage: dayModelUsage,
					};
				}
			} catch { /* ignore date parsing errors */ }
		}

		const sessionData: SessionFileCache = {
			tokens: tokenResult.tokens,
			interactions,
			modelUsage,
			mtime,
			size: fileSize,
			usageAnalysis,
			title: sessionMeta.title,
			firstInteraction: sessionMeta.firstInteraction,
			lastInteraction: sessionMeta.lastInteraction,
			thinkingTokens: tokenResult.thinkingTokens,
			actualTokens: tokenResult.actualTokens,
			dailyRollups: Object.keys(dailyRollups).length > 0 ? dailyRollups : undefined,
		};

		this.setCachedSessionData(sessionFilePath, sessionData, fileSize);
		return sessionData;
	}




	private async getUsageAnalysisFromSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<SessionUsageAnalysis> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		const analysis = sessionData.usageAnalysis || {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
				terminalLastCommand: 0,
				terminalSelection: 0,
				clipboard: 0,
				changes: 0,
				outputPanel: 0,
				problemsPanel: 0,
				byKind: {},
				copilotInstructions: 0,
				agentsMd: 0,
				byPath: {}
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} },
			modelSwitching: {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0
			}
		};

		// Ensure modelSwitching field exists for backward compatibility with old cache
		if (!analysis.modelSwitching) {
			analysis.modelSwitching = {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0
			};
		}

		return analysis;
	}

	/**
	 * Add editor root and name information to session file details.
	 * Enriches the details object with editorRoot and editorName properties.
	 */
	private enrichDetailsWithEditorInfo(sessionFile: string, details: SessionFileDetails): void {
		const eco = this.findEcosystem(sessionFile);
		if (eco) {
			details.editorRoot = eco.getEditorRoot(sessionFile);
			details.editorName = eco.displayName;
			return;
		}
		try {
			const parts = sessionFile.split(/[/\\]/);
			const userIdx = parts.findIndex(p => p.toLowerCase() === 'user');
			if (userIdx > 0) {
				details.editorRoot = parts.slice(0, userIdx).join(require('path').sep);
			} else {
				details.editorRoot = require('path').dirname(sessionFile);
			}
			details.editorName = this.getEditorNameFromRoot(details.editorRoot || '');
		} catch (e) {
			details.editorRoot = require('path').dirname(sessionFile);
			details.editorName = this.getEditorNameFromRoot(details.editorRoot || '');
		}
	}

	/**
	 * Reconstruct SessionFileDetails from cached data without reading the file.
	 * Returns undefined if cache is not valid or doesn't have all required data.
	 */
	private async getSessionFileDetailsFromCache(sessionFile: string, stat: fs.Stats): Promise<SessionFileDetails | undefined> {
		const cached = this.getCachedSessionData(sessionFile);

		// Validate cache against file stats
		if (!cached || cached.mtime !== stat.mtime.getTime() || cached.size !== stat.size) {
			return undefined;
		}

		// Check if cache has the required fields (for backward compatibility with old cache)
		if (!cached.usageAnalysis?.contextReferences || typeof cached.interactions !== 'number' || cached.interactions < 0) {
			return undefined;
		}

		// Use the cached lastInteraction from session content directly.
		// Do NOT fall back to file mtime here: mtime is updated whenever VS Code writes the
		// session file (e.g. finalising a session just after midnight), which would shift
		// yesterday's sessions into "today". Only use mtime when no content timestamp exists.
		const lastInteraction: string | null = cached.lastInteraction || stat.mtime.toISOString();

		// Reconstruct SessionFileDetails from cache.
		// Prefer actualTokens (real API count) when available; fall back to estimated tokens.
		const details: SessionFileDetails = {
			file: sessionFile,
			size: cached.size || stat.size,
			modified: stat.mtime.toISOString(),
			interactions: cached.interactions,
			tokens: cached.actualTokens || cached.tokens || 0,
			contextReferences: cached.usageAnalysis.contextReferences,
			firstInteraction: cached.firstInteraction || null,
			lastInteraction: lastInteraction,
			editorSource: this.detectEditorSource(sessionFile),
			title: cached.title,
			repository: cached.repository
		};

		// Add editor root and name
		this.enrichDetailsWithEditorInfo(sessionFile, details);

		return details;
	}

	/**
	 * Update or create cache entry with session file details.
	 * Merges new detail fields with existing cached data if available.
	 * @param tokenResult - Fresh token data from eco.getTokens(); when provided, takes
	 *   precedence over any cached token values so eco-session diagnostics always show
	 *   the correct (actual-API) count rather than a stale or zero value.
	 */
	private async updateCacheWithSessionDetails(
		sessionFile: string,
		stat: fs.Stats,
		details: SessionFileDetails,
		tokenResult?: { tokens: number; thinkingTokens: number; actualTokens: number }
	): Promise<void> {
		// Get existing cache entry if available
		const existingCache = this.getCachedSessionData(sessionFile);

		// Prefer fresh token data (eco path supplies this) over any cached value.
		// For Copilot Chat sessions no tokenResult is provided, so we fall back to
		// the existing cache that was already populated by getSessionFileDataCached().
		const resolvedActualTokens = tokenResult?.actualTokens ?? existingCache?.actualTokens;
		const resolvedTokens = tokenResult?.tokens ?? existingCache?.tokens ?? 0;
		const resolvedThinkingTokens = tokenResult?.thinkingTokens ?? existingCache?.thinkingTokens;
		details.tokens = resolvedActualTokens || resolvedTokens || 0;

		// Create or update cache entry
		const cacheEntry: SessionFileCache = {
			tokens: resolvedTokens,
			interactions: details.interactions,
			modelUsage: existingCache?.modelUsage || {},
			mtime: stat.mtime.getTime(),
			size: stat.size,
			actualTokens: resolvedActualTokens,
			thinkingTokens: resolvedThinkingTokens,
			// Preserve existing dailyRollups so this partial update does not discard
			// the per-day breakdown computed by getSessionFileDataCached().
			dailyRollups: existingCache?.dailyRollups,
			usageAnalysis: existingCache?.usageAnalysis || {
				toolCalls: { total: 0, byTool: {} },
				modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
				contextReferences: {
					file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
					workspace: 0, terminal: 0, vscode: 0,
					terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0,
					// Extended fields expected by SessionUsageAnalysis in the webview
					byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
				},
				mcpTools: { total: 0, byServer: {}, byTool: {} },
				modelSwitching: {
					uniqueModels: [],
					modelCount: 0,
					switchCount: 0,
					tiers: { standard: [], premium: [], unknown: [] },
					hasMixedTiers: false,
					standardRequests: 0,
					premiumRequests: 0,
					unknownRequests: 0,
					totalRequests: 0
				}
			},
			firstInteraction: details.firstInteraction,
			lastInteraction: details.lastInteraction,
			title: details.title,
			repository: details.repository
		};

		// Update the contextReferences in usageAnalysis with the current data
		// usageAnalysis is guaranteed to exist here since we always initialize it above
		cacheEntry.usageAnalysis!.contextReferences = details.contextReferences;

		this.setCachedSessionData(sessionFile, cacheEntry, stat.size);
	}

	/**
	 * Get detailed session file information for diagnostics view.
	 * Analyzes session files to extract interactions, context references, and timestamps.
	 * Uses cached data when available to avoid re-reading files.
	 */
	private async getSessionFileDetails(sessionFile: string): Promise<SessionFileDetails> {
		const stat = await this.statSessionFile(sessionFile);

		// Try to get details from cache first
		const cachedDetails = await this.getSessionFileDetailsFromCache(sessionFile, stat);
		if (cachedDetails) {
			// Invalidate cache if repository field is missing (needed for new repository extraction feature)
			// Only re-parse JSONL files since they're likely to have contentReferences
			if (cachedDetails.repository === undefined && sessionFile.endsWith('.jsonl')) {
				// Fall through to re-parse
			} else {
				this._cacheHits++;
				return cachedDetails;
			}
		}

		this._cacheMisses++;

		const details: SessionFileDetails = {
			file: sessionFile,
			size: stat.size,
			modified: stat.mtime.toISOString(),
			interactions: 0,
			contextReferences: {
				file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
				workspace: 0, terminal: 0, vscode: 0,
				terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0,
				byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
			},
			firstInteraction: null,
			lastInteraction: null,
			editorSource: this.detectEditorSource(sessionFile)
		};

		// Determine top-level editor root path for this session file (up to the folder before 'User')
		this.enrichDetailsWithEditorInfo(sessionFile, details);

		try {
			// Handle all non-Copilot-Chat ecosystems via adapter dispatch
			const eco = this.findEcosystem(sessionFile);
			if (eco) {
				// Fetch meta, tokens, and interaction count in parallel to minimise file-read latency.
				// getTokens() is the key addition here: it reads the actual API token counts so the
				// diagnostics view shows the same (correct) total that the file viewer header does.
				const [meta, tokenResult, interactionCount] = await Promise.all([
					eco.getMeta(sessionFile),
					eco.getTokens(sessionFile),
					eco.countInteractions(sessionFile)
				]);
				details.title = meta.title;
				details.firstInteraction = meta.firstInteraction;
				details.lastInteraction = meta.lastInteraction;
				details.interactions = interactionCount;
				details.editorRoot = eco.getEditorRoot(sessionFile);
				details.editorName = eco.displayName;
				if (meta.workspacePath) {
					details.repository = path.basename(meta.workspacePath);
				}
				// Pass fresh tokenResult so updateCacheWithSessionDetails stores the correct counts
				// and does not overwrite a good full-cache entry with a stale/zero token value.
				await this.updateCacheWithSessionDetails(sessionFile, stat, details, tokenResult);
				return details;
			}

			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format where the file contains just a session ID)
			// These files act as session pointers, with actual data stored elsewhere
			if (this.isUuidPointerFile(fileContent)) {
				// This is a session ID pointer file, not actual session data
				// Skip parsing and return empty details (no interactions to count)
				await this.updateCacheWithSessionDetails(sessionFile, stat, details);
				return details;
			}

			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n').filter(l => l.trim());
				const timestamps: number[] = [];
				const allContentReferences: any[] = []; // Collect for repository extraction

				// Detect if this is delta-based format (VS Code incremental)
				let isDeltaBased = false;
				if (lines.length > 0) {
					try {
						const firstLine = JSON.parse(lines[0]);
						if (firstLine && typeof firstLine.kind === 'number') {
							isDeltaBased = true;
						}
					} catch {
						// Not delta format
					}
				}

				if (isDeltaBased) {
					// Delta-based format: reconstruct full state asynchronously to avoid
					// blocking the extension host event loop on large files.
					const { sessionState } = await _reconstructJsonlStateAsync(lines);

					// Extract session metadata from reconstructed state
					if (sessionState.creationDate) {
						timestamps.push(sessionState.creationDate);
					}
					if (sessionState.customTitle) {
						details.title = sessionState.customTitle;
					}

					// Process reconstructed requests array
					const requests = sessionState.requests || [];
					details.interactions = requests.length;

					for (const request of requests) {
						if (!request) { continue; }

						if (request.timestamp) {
							timestamps.push(request.timestamp);
						}

						// Analyze all context references from this request (unified method)
						this.analyzeRequestContext(request, details.contextReferences);

						// Collect contentReferences for repository extraction
						if (request.contentReferences && Array.isArray(request.contentReferences)) {
							allContentReferences.push(...request.contentReferences);
						}
					}

					if (timestamps.length > 0) {
						timestamps.sort((a, b) => a - b);
						details.firstInteraction = new Date(timestamps[0]).toISOString();
						// Use the last content timestamp directly. Do NOT mix in stat.mtime: mtime is set
						// when VS Code writes the file (e.g. after midnight), which would shift yesterday's
						// session into 'today', breaking the 30-day/today cutoff boundaries.
						details.lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
					} else {
						details.lastInteraction = stat.mtime.toISOString();
					}

					// Extract repository from collected contentReferences
					if (allContentReferences.length > 0) {
						details.repository = await this.extractRepositoryFromContentReferences(allContentReferences);
					}

					// Update cache with the details we just collected
					await this.updateCacheWithSessionDetails(sessionFile, stat, details);

					return details;
				}

				// Non-delta JSONL (Copilot CLI format) - process line-by-line
				let firstUserMessage: string | undefined;
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);

						// Handle Copilot CLI format (type: 'user.message')
						if (event.type === 'user.message') {
							details.interactions++;
							if (event.timestamp || event.ts || event.data?.timestamp) {
								const ts = event.timestamp || event.ts || event.data?.timestamp;
								timestamps.push(new Date(ts).getTime());
							}
							if (event.data?.content) {
								this.analyzeContextReferences(event.data.content, details.contextReferences);
								if (!firstUserMessage) { firstUserMessage = event.data.content; }
							}
						}

						// Handle Copilot CLI rename_session tool call - always use the last rename
						if (event.type === 'tool.execution_start' && event.data?.toolName === 'rename_session') {
							if (event.data?.arguments?.title) { details.title = event.data.arguments.title; }
						}

						// Collect file paths from tool arguments for repository detection
						if (event.type === 'tool.execution_start' && event.data?.arguments) {
							const args = event.data.arguments as Record<string, unknown>;
							for (const val of Object.values(args)) {
								if (typeof val === 'string' && val.length > 3 && (val.includes('/') || val.includes('\\'))) {
									allContentReferences.push({ kind: 'reference', reference: { fsPath: val } });
								}
							}
						}
					} catch {
						// Skip malformed lines
					}
				}

				// Fall back to first user message if no explicit title was set
				if (!details.title && firstUserMessage) {
					const trimmed = firstUserMessage.trim();
					details.title = trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
				}

				if (timestamps.length > 0) {
					timestamps.sort((a, b) => a - b);
					details.firstInteraction = new Date(timestamps[0]).toISOString();
					// Use the last content timestamp directly. Do NOT mix in stat.mtime: mtime is set
					// when VS Code writes the file (e.g. after midnight), which would shift yesterday's
					// session into 'today', breaking the 30-day/today cutoff boundaries.
					details.lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
				} else {
					// Fallback to file modification time if no timestamps in content
					details.lastInteraction = stat.mtime.toISOString();
				}

				// Extract repository from collected contentReferences
				if (allContentReferences.length > 0) {
					details.repository = await this.extractRepositoryFromContentReferences(allContentReferences);
				}

				// Update cache with the details we just collected
				await this.updateCacheWithSessionDetails(sessionFile, stat, details);

				return details;
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			// Extract session title if available
			if (sessionContent.customTitle) {
				details.title = sessionContent.customTitle;
			}

			const hasRequests = sessionContent.requests && Array.isArray(sessionContent.requests);

			if (hasRequests) {
				details.interactions = sessionContent.requests.length;
				const timestamps: number[] = [];
				const allContentReferences: any[] = []; // Collect for repository extraction

				for (const request of sessionContent.requests) {
					// Extract timestamps from requests
					if (request.timestamp || request.ts || request.result?.timestamp) {
						const ts = request.timestamp || request.ts || request.result?.timestamp;
						timestamps.push(new Date(ts).getTime());
					}

					// Analyze all context references from this request
					this.analyzeRequestContext(request, details.contextReferences);
					// Analyze context references
					if (request.message?.text) {
						this.analyzeContextReferences(request.message.text, details.contextReferences);
					}
					if (request.message?.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								this.analyzeContextReferences(part.text, details.contextReferences);
							}
						}
					}

					// Collect contentReferences for repository extraction
					if (request.contentReferences && Array.isArray(request.contentReferences)) {
						allContentReferences.push(...request.contentReferences);
					}

					// Check variableData for @workspace, @terminal, @vscode references
					if (request.variableData) {
						const varDataStr = JSON.stringify(request.variableData).toLowerCase();
						if (varDataStr.includes('workspace')) { details.contextReferences.workspace++; }
						if (varDataStr.includes('terminal')) { details.contextReferences.terminal++; }
						if (varDataStr.includes('vscode')) { details.contextReferences.vscode++; }
					}
				}

				if (timestamps.length > 0) {
					timestamps.sort((a, b) => a - b);
					details.firstInteraction = new Date(timestamps[0]).toISOString();
					// Use the last content timestamp directly. Do NOT mix in stat.mtime: mtime is set
					// when VS Code writes the file (e.g. after midnight), which would shift yesterday's
					// session into 'today', breaking the 30-day/today cutoff boundaries.
					details.lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
				} else {
					// Fallback to file modification time if no timestamps in content
					details.lastInteraction = stat.mtime.toISOString();
				}

				// Extract repository from collected contentReferences
				if (allContentReferences.length > 0) {
					details.repository = await this.extractRepositoryFromContentReferences(allContentReferences);
				}
			}

			// Update cache with the details we just collected
			await this.updateCacheWithSessionDetails(sessionFile, stat, details);
		} catch (error) {
			this.warn(`Error analyzing session file details for ${sessionFile}: ${error}`);
		}

		return details;
	}

	/**
	 * Detect which editor the session file belongs to based on its path.
	 */
	private detectEditorSource(filePath: string): string {
		return _detectEditorSource(filePath, (p) => !!this.findEcosystem(p));
	}

	/**
	 * Extract full session log data including chat turns for the log viewer.
	 */
	private async getSessionLogData(sessionFile: string): Promise<SessionLogData> {
		const details = await this.getSessionFileDetails(sessionFile);
		const turns: ChatTurn[] = [];
		let subAgentsStarted: number | undefined;

		try {
// Delegate to ecosystem adapter if available
const eco = this.findEcosystem(sessionFile);
if (eco?.buildTurns) {
const result = await eco.buildTurns(sessionFile);
turns.push(...result.turns);
return {
file: details.file,
title: details.title || null,
editorSource: details.editorSource,
editorName: details.editorName || eco.displayName,
size: details.size,
modified: details.modified,
interactions: details.interactions,
contextReferences: details.contextReferences,
firstInteraction: details.firstInteraction,
lastInteraction: details.lastInteraction,
turns,
...(result.actualTokens !== undefined ? { actualTokens: result.actualTokens } : {}),
usageAnalysis: undefined
};
}
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				// This is a session ID pointer file with no actual conversation data
				return {
					file: details.file,
					title: details.title || null,
					editorSource: details.editorSource,
					editorName: details.editorName || details.editorSource,
					size: details.size,
					modified: details.modified,
					interactions: details.interactions,
					contextReferences: details.contextReferences,
					firstInteraction: details.firstInteraction,
					lastInteraction: details.lastInteraction,
					turns,
					usageAnalysis: undefined
				};
			}

			// Check for JSONL content (either by extension or content detection)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);

			if (isJsonlContent) {
				// Handle JSONL formats (CLI and VS Code incremental/delta-based)
				const lines = fileContent.trim().split('\n').filter(l => l.trim());

				// Detect if this is delta-based format (VS Code incremental)
				let isDeltaBased = false;
				if (lines.length > 0) {
					try {
						const firstLine = JSON.parse(lines[0]);
						if (firstLine && typeof firstLine.kind === 'number') {
							isDeltaBased = true;
						}
					} catch {
						// Not delta format
					}
				}

				if (isDeltaBased) {
					// Delta-based format: reconstruct full state asynchronously to avoid
					// blocking the extension host event loop on large files.
					const { sessionState } = await _reconstructJsonlStateAsync(lines);

					// Build per-request effort map from delta lines
					const { effortByRequestId } = _buildReasoningEffortTimeline(lines);

					// Extract session-level info
					let sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' = 'ask';
					let currentModel: string | null = null;

					if (sessionState.inputState?.mode) {
						sessionMode = this.getModeType(sessionState.inputState.mode);
						if (sessionState.inputState?.selectedModel?.metadata?.id) {
							currentModel = sessionState.inputState.selectedModel.metadata.id;
						}
					}

					// Extract turns from reconstructed requests array
					const requests = sessionState.requests || [];
					// Pre-compute regex-based token extraction for lines that failed JSON.parse
					const rawUsageFallback = this.extractPerRequestUsageFromRawLines(lines);
					for (let i = 0; i < requests.length; i++) {
						const request = requests[i];
						if (!request || !request.requestId) { continue; }

						const contextRefs = this.createEmptyContextRefs();
						const userMessage = request.message?.text || '';

						// Analyze all context references from this request
						this.analyzeRequestContext(request, contextRefs);

						// Get model from request or fall back to session model
						const requestModel = request.modelId ||
							currentModel ||
							this.getModelFromRequest(request) ||
							'gpt-4';

						// Extract response data
						const { responseText, thinkingText, toolCalls, mcpTools } = this.extractResponseData(request.response || []);
						
						// Extract actual usage data from request.result if available
						let actualUsage: ActualUsage | undefined;
						if (request.result?.usage) {
							// OLD FORMAT (pre-Feb 2026): Tokens nested under request.result.usage
							const u = request.result.usage;
							actualUsage = {
								completionTokens: typeof u.completionTokens === 'number' ? u.completionTokens : 0,
								promptTokens: typeof u.promptTokens === 'number' ? u.promptTokens : 0,
								promptTokenDetails: Array.isArray(u.promptTokenDetails) ? u.promptTokenDetails : undefined,
								details: typeof request.result.details === 'string' ? request.result.details : undefined
							};
						} else if (typeof request.result?.promptTokens === 'number' && typeof request.result?.outputTokens === 'number') {
							// NEW FORMAT (Feb 2026+): Tokens directly at request.result level
							actualUsage = {
								completionTokens: request.result.outputTokens,
								promptTokens: request.result.promptTokens,
								details: typeof request.result.details === 'string' ? request.result.details : undefined
							};
						} else if (request.result?.metadata && typeof request.result.metadata.promptTokens === 'number' && typeof request.result.metadata.outputTokens === 'number') {
							// INSIDERS FORMAT (Feb 2026+): Tokens nested under result.metadata
							actualUsage = {
								completionTokens: request.result.metadata.outputTokens,
								promptTokens: request.result.metadata.promptTokens,
								details: typeof request.result.details === 'string' ? request.result.details : undefined
							};
						}

						// FALLBACK: If reconstruction missed result data (bad escape chars), use regex extraction
						if (!actualUsage) {
							const extracted = rawUsageFallback.get(i);
							if (extracted) {
								actualUsage = {
									completionTokens: extracted.outputTokens,
									promptTokens: extracted.promptTokens
								};
							}
						}

					const turn: ChatTurn = {
						turnNumber: i + 1,
						timestamp: request.timestamp ? new Date(request.timestamp).toISOString() : null,
						mode: sessionMode,
						userMessage,
						assistantResponse: responseText,
						model: requestModel,
						toolCalls,
						contextReferences: contextRefs,
						mcpTools,
						inputTokensEstimate: this.estimateTokensFromText(userMessage, requestModel),
						outputTokensEstimate: this.estimateTokensFromText(responseText, requestModel),
						thinkingTokensEstimate: this.estimateTokensFromText(thinkingText, requestModel),
						actualUsage,
						thinkingEffort: effortByRequestId.get(request.requestId)
					};

					turns.push(turn);
				}
			} else {
			// Non-delta JSONL (Copilot CLI format)
			let turnNumber = 0;
			let cliSessionModel = 'gpt-4o';
			let cliSessionEffort: string | undefined;

			// Pre-scan for model and effort:
			// 1. session.start.data.selectedModel (older CLI format)
			// 2. First tool.execution_complete.data.model (newer CLI format — session.start has no selectedModel)
			let cliModelFound = false;
			for (const line of lines) {
				try {
					const ev = JSON.parse(line);
					if (ev.type === 'session.start' && ev.data) {
						if (typeof ev.data.selectedModel === 'string') {
							cliSessionModel = ev.data.selectedModel;
							cliModelFound = true;
						}
						if (typeof ev.data.reasoningEffort === 'string') { cliSessionEffort = ev.data.reasoningEffort; }
						if (cliModelFound) { break; }
						// No model in session.start — continue scanning for tool.execution_complete
					}
					// Newer format: model stored per tool call result
					if (ev.type === 'tool.execution_complete' && typeof ev.data?.model === 'string') {
						cliSessionModel = ev.data.model;
						break;
					}
					// JetBrains / generic: model in assistant.turn_start.data.model
					if (ev.type === 'assistant.turn_start' && typeof ev.data?.model === 'string') {
						cliSessionModel = ev.data.model;
						break;
					}
					// Fallback: session.start.data.model (not selectedModel)
					if (ev.type === 'session.start' && typeof ev.data?.model === 'string' && !cliModelFound) {
						cliSessionModel = ev.data.model;
						cliModelFound = true;
					}
				} catch { /* skip */ }
			}

			// Track output tokens per subagent (keyed by parentToolCallId)
			const subAgentOutputTokenMap = new Map<string, number>();

			for (const line of lines) {
				try {
					const event = JSON.parse(line);

					// Handle Copilot CLI format (type: 'user.message')
					if (event.type === 'user.message' && event.data?.content) {
						turnNumber++;
						const contextRefs = this.createEmptyContextRefs();
						const userMessage = event.data.content;
						this.analyzeContextReferences(userMessage, contextRefs);
						const turnModel = event.model || event.data?.model || cliSessionModel;
						const turnEffort: string | undefined = typeof event.data?.reasoningEffort === 'string'
							? event.data.reasoningEffort
							: cliSessionEffort;
						const turn: ChatTurn = {
							turnNumber,
							timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : null,
							mode: 'cli', // CLI tool sessions use the dedicated cli mode
							userMessage,
							assistantResponse: '',
							model: turnModel,
							toolCalls: [],
							contextReferences: contextRefs,
							mcpTools: [],
							inputTokensEstimate: this.estimateTokensFromText(userMessage, turnModel),
							outputTokensEstimate: 0,
							thinkingTokensEstimate: 0,
							thinkingEffort: turnEffort
						};
						turns.push(turn);
					}

					// Handle CLI assistant response
					if (event.type === 'assistant.message' && event.data?.content) {
						if (event.data.parentToolCallId) {
							// Subagent response — accumulate output tokens keyed by parent tool call
							const prev = subAgentOutputTokenMap.get(event.data.parentToolCallId) ?? 0;
							subAgentOutputTokenMap.set(event.data.parentToolCallId, prev + this.estimateTokensFromText(event.data.content, cliSessionModel));
						} else if (turns.length > 0) {
							const lastTurn = turns[turns.length - 1];
							lastTurn.assistantResponse += event.data.content;
							lastTurn.outputTokensEstimate = this.estimateTokensFromText(lastTurn.assistantResponse, lastTurn.model || 'gpt-4o');
						}
					}

					// Handle CLI tool calls (tool.execution_start is the actual event type in current CLI format)
					const CLI_SUB_AGENT_TOOLS = new Set(['task', 'read_agent', 'write_agent', 'list_agents']);
					if ((event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'tool.execution_start')
					&& turns.length > 0
					&& !event.data?.parentToolCallId) {
						const lastTurn = turns[turns.length - 1];
						const toolName = event.data?.toolName || event.toolName || 'unknown';
						const isSubAgent = CLI_SUB_AGENT_TOOLS.has(toolName);

						// Check if this is an MCP tool by name pattern
						if (this.isMcpTool(toolName)) {
							const serverName = this.extractMcpServerName(toolName);
							lastTurn.mcpTools.push({ server: serverName, tool: toolName });
						} else if (isSubAgent) {
							const subAgentCallId: string | undefined = event.data?.toolCallId;
							const subAgentEntry: any = {
								toolName,
								arguments: event.data?.arguments ? JSON.stringify(event.data.arguments) : undefined,
								result: undefined,
								isSubAgent: true,
							};
							if (subAgentCallId) { subAgentEntry._callId = subAgentCallId; }
							lastTurn.toolCalls.push(subAgentEntry);
						} else {
							// Add to regular tool calls (skip duplicate execution_start events per toolCallId)
							const callId: string | undefined = event.data?.toolCallId;
							const alreadyAdded = callId && lastTurn.toolCalls.some((tc: any) => tc._callId === callId);
							if (!alreadyAdded) {
								const tc: any = {
									toolName,
									arguments: event.type !== 'tool.result' ? JSON.stringify(event.data?.arguments || {}) : undefined,
									result: event.type === 'tool.result' ? event.data?.output : undefined
								};
								if (callId) { tc._callId = callId; }
								lastTurn.toolCalls.push(tc);
							}
						}
					}

					// Handle explicit MCP tool calls from CLI
					if ((event.type === 'mcp.tool.call' || event.data?.mcpServer) && turns.length > 0) {
						const lastTurn = turns[turns.length - 1];
						const serverName = event.data?.mcpServer || 'unknown';
						const toolName = event.data?.toolName || event.toolName || 'unknown';
						lastTurn.mcpTools.push({ server: serverName, tool: toolName });
					}

					// Count distinct subagent sessions launched
					if (event.type === 'subagent.started') {
						subAgentsStarted = (subAgentsStarted ?? 0) + 1;
					}
				} catch {
					// Skip malformed lines
				}
			}

			// Attach subagent token estimates to sub-agent tool call entries
			if (subAgentOutputTokenMap.size > 0) {
				for (const turn of turns) {
					for (const tc of turn.toolCalls as any[]) {
						if (tc.isSubAgent && tc._callId) {
							const outputTokens = subAgentOutputTokenMap.get(tc._callId) ?? 0;
							let inputTokens = 0;
							if (tc.arguments) {
								try {
									const args = JSON.parse(tc.arguments);
									const prompt = typeof args?.prompt === 'string' ? args.prompt : tc.arguments;
									inputTokens = this.estimateTokensFromText(prompt, cliSessionModel);
								} catch {
									inputTokens = this.estimateTokensFromText(tc.arguments, cliSessionModel);
								}
							}
							if (outputTokens > 0 || inputTokens > 0) {
								tc.subAgentTokens = { input: inputTokens, output: outputTokens };
							}
						}
					}
				}
			}
		}
				const sessionContent = JSON.parse(fileContent);
				let sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' = 'ask';

				// Detect session-level mode
				if (sessionContent.mode) {
					sessionMode = this.getModeType(sessionContent.mode);
				}

				if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
					let turnNumber = 0;
					for (const request of sessionContent.requests) {
						turnNumber++;

						// Determine mode for this request
						let requestMode = sessionMode;
						if (request.agent?.id) {
							const agentId = request.agent.id.toLowerCase();
							if (agentId.includes('edit')) {
								requestMode = 'edit';
							} else if (agentId.includes('agent')) {
								requestMode = 'agent';
							}
						}

						// Extract user message
						let userMessage = '';
						if (request.message?.text) {
							userMessage = request.message.text;
						} else if (request.message?.parts) {
							userMessage = request.message.parts
								.filter((p: any) => p.text)
								.map((p: any) => p.text)
								.join('\n');
						}

						// Analyze context references
						const contextRefs = this.createEmptyContextRefs();
						this.analyzeRequestContext(request, contextRefs);

						// Extract model
						const model = this.getModelFromRequest(request);

						// Extract response
						let assistantResponse = '';
						let thinkingText = '';
						const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
						const mcpTools: { server: string; tool: string }[] = [];

						if (request.response && Array.isArray(request.response)) {
							const { responseText, thinkingText: tt, toolCalls: tc, mcpTools: mcp } = this.extractResponseData(request.response);
							assistantResponse = responseText;
							thinkingText = tt;
							toolCalls.push(...tc);
							mcpTools.push(...mcp);
						}

						const turn: ChatTurn = {
							turnNumber,
							timestamp: request.timestamp || request.ts || request.result?.timestamp || null,
							mode: requestMode,
							userMessage,
							assistantResponse,
							model,
							toolCalls,
							contextReferences: contextRefs,
							mcpTools,
							inputTokensEstimate: this.estimateTokensFromText(userMessage, model),
							outputTokensEstimate: this.estimateTokensFromText(assistantResponse, model),
							thinkingTokensEstimate: this.estimateTokensFromText(thinkingText, model)
						};

						turns.push(turn);
					}
				}
			}
		} catch (error) {
			this.warn(`Error extracting chat turns from ${sessionFile}: ${error}`);
		}

		let usageAnalysis: SessionUsageAnalysis | undefined;
		try {
			const mtimeMs = new Date(details.modified).getTime();
			usageAnalysis = await this.getUsageAnalysisFromSessionCached(sessionFile, mtimeMs, details.size);
		} catch (usageError) {
			this.warn(`Error loading usage analysis for ${sessionFile}: ${usageError}`);
		}

		const sessionCache = this.getCachedSessionData(sessionFile);

		return {
			file: details.file,
			title: details.title || null,
			editorSource: details.editorSource,
			editorName: details.editorName || details.editorSource,
			size: details.size,
			modified: details.modified,
			interactions: details.interactions,
			contextReferences: details.contextReferences,
			firstInteraction: details.firstInteraction,
			lastInteraction: details.lastInteraction,
			turns,
			usageAnalysis,
			actualTokens: sessionCache?.actualTokens || 0,
			...(subAgentsStarted !== undefined ? { subAgentsStarted } : {})
		};
	}

	private createEmptyContextRefs(): ContextReferenceUsage {
		return _createEmptyContextRefs();
	}

	/**
	 * Extract response data from a response array.
	 */
	private extractResponseData(response: any[]): {
		responseText: string;
		thinkingText: string;
		toolCalls: { toolName: string; arguments?: string; result?: string; isSubAgent?: boolean; subAgentModel?: string }[];
		mcpTools: { server: string; tool: string }[];
	} {
		let responseText = '';
		let thinkingText = '';
		const toolCalls: { toolName: string; arguments?: string; result?: string; isSubAgent?: boolean; subAgentModel?: string }[] = [];
		const mcpTools: { server: string; tool: string }[] = [];

		for (const item of response) {
			// Separate thinking items
			if (item.kind === 'thinking') {
				if (item.value && typeof item.value === 'string') {
					thinkingText += item.value;
				}
				continue;
			}

			// Extract text content
			if (item.value && typeof item.value === 'string') {
				responseText += item.value;
			} else if (item.kind === 'markdownContent' && item.content?.value) {
				responseText += item.content.value;
			}

			// Extract tool invocations
			if (item.kind === 'toolInvocationSerialized' || item.kind === 'prepareToolInvocation') {
				// Detect sub-agent calls first — tag them for the log viewer
				const subAgentData = _extractSubAgentData(item);
				if (subAgentData) {
					const displayName = (item.toolSpecificData?.agentName as string | undefined) || 'Sub-Agent';
					toolCalls.push({
						toolName: displayName,
						arguments: subAgentData.prompt || undefined,
						result: undefined,
						isSubAgent: true,
						subAgentModel: subAgentData.modelName || undefined,
					});
				} else {
					const toolName = item.toolId || item.toolName || item.invocationMessage?.toolName || item.toolSpecificData?.kind || 'unknown';
					// Check if this is an MCP tool by name pattern
					if (this.isMcpTool(toolName)) {
						const serverName = this.extractMcpServerName(toolName);
						mcpTools.push({ server: serverName, tool: toolName });
					} else {
						// Add to regular tool calls
						toolCalls.push({
							toolName,
							arguments: item.input ? JSON.stringify(item.input) : undefined,
							result: item.result ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result)) : undefined
						});
					}
				}
			}

			// Extract MCP tools
			if (item.kind === 'mcpServersStarting' && item.didStartServerIds) {
				for (const serverId of item.didStartServerIds) {
					mcpTools.push({ server: serverId, tool: 'start' });
				}
			}
		}

		return { responseText, thinkingText, toolCalls, mcpTools };
	}

	public calculateEstimatedCost(modelUsage: ModelUsage, pricingSource: 'provider' | 'copilot' = 'provider'): number {
		return _calculateEstimatedCost(modelUsage, this.modelPricing, pricingSource);
	}







	private async estimateTokensFromSession(sessionFilePath: string, preloadedContent?: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		try {
			const eco = this.findEcosystem(sessionFilePath);
			if (eco) { return eco.getTokens(sessionFilePath); }

			const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFilePath, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
			}

			// Handle .jsonl files OR .json files with JSONL content (each line is a separate JSON object)
			const isJsonlContent = sessionFilePath.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				return this.estimateTokensFromJsonlSession(fileContent);
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let totalThinkingTokens = 0;
			let totalActualTokens = 0;

			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Estimate tokens from user message (input)
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								totalInputTokens += this.estimateTokensFromText(part.text);
							}
						}
					}

					// Estimate tokens from assistant response (output)
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							// Separate thinking tokens
							if (responseItem.kind === 'thinking' && responseItem.value) {
								totalThinkingTokens += this.estimateTokensFromText(responseItem.value, this.getModelFromRequest(request));
								continue;
							}
							// Sub-agent invocations: count prompt (input) + result (output)
							const subAgent = _extractSubAgentData(responseItem);
							if (subAgent) {
								const saModel = subAgent.modelName || this.getModelFromRequest(request);
								if (subAgent.prompt) { totalInputTokens += this.estimateTokensFromText(subAgent.prompt, saModel); }
								if (subAgent.result) { totalOutputTokens += this.estimateTokensFromText(subAgent.result, saModel); }
								continue;
							}
							if (responseItem.value) {
								totalOutputTokens += this.estimateTokensFromText(responseItem.value, this.getModelFromRequest(request));
							}
						}
					}

					// Extract actual token counts from LLM API usage data
					if (request.result?.usage) {
						// OLD FORMAT (pre-Feb 2026)
						const u = request.result.usage;
						const prompt = typeof u.promptTokens === 'number' ? u.promptTokens : 0;
						const completion = typeof u.completionTokens === 'number' ? u.completionTokens : 0;
						totalActualTokens += prompt + completion;
					} else if (typeof request.result?.promptTokens === 'number' && typeof request.result?.outputTokens === 'number') {
						// NEW FORMAT (Feb 2026+)
						totalActualTokens += request.result.promptTokens + request.result.outputTokens;
					} else if (request.result?.metadata && typeof request.result.metadata.promptTokens === 'number' && typeof request.result.metadata.outputTokens === 'number') {
						// INSIDERS FORMAT (Feb 2026+): Tokens nested under result.metadata
						totalActualTokens += request.result.metadata.promptTokens + request.result.metadata.outputTokens;
					}
				}
			}

			return { tokens: totalInputTokens + totalOutputTokens + totalThinkingTokens, thinkingTokens: totalThinkingTokens, actualTokens: totalActualTokens };
		} catch (error) {
			this.warn(`Error parsing session file ${sessionFilePath}: ${error}`);
			return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
		}
	}

	private estimateTokensFromJsonlSession(fileContent: string): { tokens: number; thinkingTokens: number; actualTokens: number } {
		return _estimateTokensFromJsonlSession(fileContent);
	}

	private extractPerRequestUsageFromRawLines(lines: string[]): Map<number, { promptTokens: number; outputTokens: number }> {
		return _extractPerRequestUsageFromRawLines(lines);
	}








	public getModelFromRequest(request: any): string {
		return _getModelFromRequest(request, this.modelPricing);
	}

	private isJsonlContent(content: string): boolean {
		return _isJsonlContent(content);
	}

	private isUuidPointerFile(content: string): boolean {
		return _isUuidPointerFile(content);
	}

	private applyDelta(state: any, delta: any): any {
		return _applyDelta(state, delta);
	}


	public estimateTokensFromText(text: string, model: string = 'gpt-4'): number {
		return _estimateTokensFromText(text, model, this.tokenEstimators);
	}

	public async showDetails(): Promise<void> {
		this.log('📊 Opening Details panel');

		// If panel already exists, just reveal it
		if (this.detailsPanel) {
			this.detailsPanel.reveal();
			this.log('📊 Details panel revealed (already exists)');
			return;
		}

		// Use cached stats if available, otherwise calculate
		let stats = this.lastDetailedStats;
		if (!stats) {
			this.log('No cached stats available, calculating...');
			stats = await this.updateTokenStats();
			if (!stats) {
				return;
			}
		}

		// Create a small webview panel
		this.detailsPanel = vscode.window.createWebviewPanel(
			'copilotTokenDetails',
			'AI Engineering Fluency',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
			}
		);

		this.log('✅ Details panel created successfully');

		// Handle messages from the webview
		this.detailsPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message.command)) { return; }
			switch (message.command) {
				case 'refresh':
					await this.dispatch('refresh:details', () => this.refreshDetailsPanel());
					break;
				case 'saveSortSettings':
					await this.dispatch('saveSortSettings:details', () =>
						this.context.globalState.update('details.sortSettings', message.settings)
					);
					break;
			}
		});

		// Set the HTML content
		this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);

		// Handle panel disposal
		this.detailsPanel.onDidDispose(() => {
			this.log('📊 Details panel closed');
			this.detailsPanel = undefined;
		});
	}

	public async showEnvironmental(): Promise<void> {
		this.log('🌿 Opening Environmental Impact view');

		if (this.environmentalPanel) {
			this.environmentalPanel.reveal();
			this.log('🌿 Environmental Impact view revealed (already exists)');
			return;
		}

		let stats = this.lastDetailedStats;
		if (!stats) {
			stats = await this.updateTokenStats();
			if (!stats) {
				return;
			}
		}

		this.environmentalPanel = vscode.window.createWebviewPanel(
			'copilotEnvironmental',
			'Environmental Impact',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.environmentalPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message.command)) { return; }
			if (message.command === 'refresh') {
				await this.dispatch('refresh:environmental', async () => {
					const refreshed = await this.updateTokenStats();
					if (refreshed && this.environmentalPanel) {
						this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, refreshed);
					}
				});
			}
		});

		this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, stats);

		this.environmentalPanel.onDidDispose(() => {
			this.log('🌿 Environmental Impact view closed');
			this.environmentalPanel = undefined;
		});
	}

	private getEnvironmentalHtml(webview: vscode.Webview, stats: DetailedStats): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'environmental.js')
		);

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		const dataWithBackend = {
			...stats,
			backendConfigured: this.isBackendConfigured(),
			compactNumbers: this.getCompactNumbersSetting(),
		};
		const initialData = JSON.stringify(dataWithBackend).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Environmental Impact</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_ENVIRONMENTAL__ = ${initialData};</script>
			${this.getLocalViewRegressionProbeScript('environmental', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	public async showChart(): Promise<void> {
		this.log('📈 Opening Chart view');

		// If panel already exists, just reveal it
		if (this.chartPanel) {
			this.chartPanel.reveal();
			this.log('📈 Chart view revealed (already exists)');
			return;
		}

		// Open the panel IMMEDIATELY with whatever daily stats are already in memory.
		// Full-year data (needed for Week/Month views) is computed in the background below.
		const hasFullData = !!this.lastFullDailyStats;
		const initialStats = this.lastFullDailyStats ?? this.lastDailyStats ?? [];

		// Create webview panel now so the tab appears without waiting for I/O
		this.chartPanel = vscode.window.createWebviewPanel(
			'copilotTokenChart',
			'Token Usage Over Time',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.log('✅ Chart view created successfully');

		// Handle messages from the webview
		this.chartPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message.command)) { return; }
			if (message.command === 'refresh') {
				await this.dispatch('refresh:chart', () => this.refreshChartPanel());
			}
			if (message.command === 'setPeriodPreference') {
				const p = message.period;
				if (p === 'day' || p === 'week' || p === 'month') {
					this.lastChartPeriod = p;
				}
			}
		});

		// Render immediately; Week/Month buttons are shown as loading if full-year data isn't ready
		this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, initialStats, hasFullData);

		// Handle panel disposal
		this.chartPanel.onDidDispose(() => {
			this.log('📈 Chart view closed');
			this.chartPanel = undefined;
		});

		// If we only have 30-day data, compute the full year in the background and push an update
		if (!hasFullData) {
			const fullStats = await this.calculateDailyStats();
			if (this.chartPanel) {
				void this.chartPanel.webview.postMessage({
					command: 'updateChartData',
					data: { ...this.buildChartData(fullStats), periodsReady: true, compactNumbers: this.getCompactNumbersSetting() }
				});
			}
		}
	}

	public async showUsageAnalysis(): Promise<void> {
		this.log('📊 Opening Usage Analysis dashboard');

		// If panel already exists, dispose it and recreate with fresh data
		if (this.analysisPanel) {
			this.log('📊 Closing existing panel to refresh data...');
			this.analysisPanel.dispose();
			this.analysisPanel = undefined;
		}

		// Create webview panel immediately so the user sees something right away
		this.analysisPanel = vscode.window.createWebviewPanel(
			'copilotUsageAnalysis',
			'AI Usage Analysis',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: true, // Keep webview context to preserve analysis results when switching tabs
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.log('✅ Usage Analysis dashboard created successfully');

		// Handle messages from the webview
		this.analysisPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message.command)) { return; }
			switch (message.command) {
				case 'refresh':
					await this.dispatch('refresh:analysis', () => this.refreshAnalysisPanel());
					break;
				case 'analyseRepository':
					await this.dispatch('analyseRepository', () => this.handleAnalyseRepository(message.workspacePath));
					break;
				case 'analyseAllRepositories':
					await this.dispatch('analyseAllRepositories', () => this.handleAnalyseAllRepositories());
					break;
				case 'openCopilotChatWithPrompt':
					await this.dispatch('openCopilotChatWithPrompt', () =>
						vscode.commands.executeCommand('workbench.action.chat.open', { query: message.prompt, isNewChat: true })
					);
					break;
				case 'suppressUnknownTool': {
					const toolName = message.toolName as string;
					if (toolName) {
						const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
						const current = config.get<string[]>('suppressedUnknownTools', []);
						if (!current.includes(toolName)) {
							await config.update('suppressedUnknownTools', [...current, toolName], vscode.ConfigurationTarget.Global);
							this.log(`🔇 Suppressed unknown tool: ${toolName}`);
						}
						await this.dispatch('refresh:analysis', () => this.refreshAnalysisPanel());
					}
					break;
				}
				case 'loadRepoPrStats':
					await this.dispatch('loadRepoPrStats', () => this.loadRepoPrStats());
					break;
			}
		});

		// Set HTML immediately — use cached stats if available, else show loading spinner
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, this.lastUsageAnalysisStats ?? null);

		// If no cached stats, compute in the background and push via updateStats
		if (!this.lastUsageAnalysisStats) {
			// Capture panel reference to guard against stale async results
			// (user could close and reopen the panel while calculation is in flight)
			const panel = this.analysisPanel;
			this.calculateUsageAnalysisStats(true).then(analysisStats => {
				if (!this.analysisPanel || this.analysisPanel !== panel) { return; }
				void this.analysisPanel.webview.postMessage({
					command: 'updateStats',
					data: {
						today: analysisStats.today,
						last30Days: analysisStats.last30Days,
						month: analysisStats.month,
						locale: analysisStats.locale,
						customizationMatrix: analysisStats.customizationMatrix || null,
						missedPotential: analysisStats.missedPotential || [],
						lastUpdated: analysisStats.lastUpdated.toISOString(),
						backendConfigured: this.isBackendConfigured(),
						currentWorkspacePaths: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
					},
				});
			}).catch(err => {
				this.error(`Failed to load usage analysis stats: ${err}`);
				if (this.analysisPanel && this.analysisPanel === panel) {
					void this.analysisPanel.webview.postMessage({
						command: 'updateStatsError',
						error: String(err),
					});
				}
			});
		}

		// Handle panel disposal
		this.analysisPanel.onDidDispose(() => {
			this.log('📊 Usage Analysis dashboard closed');
			this.analysisPanel = undefined;
		});
	}

	private async handleAnalyseRepository(workspacePath?: string): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		try {
			this.log(`🏗️ Running repository hygiene analysis${workspacePath ? ` for ${workspacePath}` : ''}`);
			const results = await this.runRepoHygieneAnalysis(workspacePath);
			this.analysisPanel.webview.postMessage({
				command: 'repoAnalysisResults',
				data: results,
				workspacePath
			});
			this.log(`✅ Repository hygiene analysis complete${workspacePath ? ` for ${workspacePath}` : ''}`);
		} catch (error) {
			this.error(`Repository analysis failed: ${error}`);
			this.analysisPanel.webview.postMessage({
				command: 'repoAnalysisError',
				error: error instanceof Error ? error.message : String(error),
				workspacePath
			});
		}
	}

	private async handleAnalyseAllRepositories(): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		// Get all workspaces from the customization matrix
		const matrix = this._lastCustomizationMatrix;
		if (!matrix || !matrix.workspaces || matrix.workspaces.length === 0) {
			this.warn('No workspaces available for batch analysis');
			this.analysisPanel.webview.postMessage({
				command: 'repoAnalysisBatchComplete'
			});
			return;
		}

		// Filter out unresolved workspaces (those with paths starting with '<unresolved:')
		const workspaces = matrix.workspaces.filter(ws => !ws.workspacePath.startsWith('<unresolved:'));
		
		this.log(`🏗️ Starting batch repository analysis for ${workspaces.length} workspace(s)`);

		// Run analyses in parallel with a concurrency limit
		const CONCURRENCY_LIMIT = 3; // Analyze up to 3 repos at a time
		const analyzeWorkspace = async (workspace: WorkspaceCustomizationRow) => {
			try {
				await this.handleAnalyseRepository(workspace.workspacePath);
			} catch (error) {
				this.warn(`Failed to analyze workspace ${workspace.workspacePath}: ${error}`);
			}
		};

		// Process workspaces in batches
		for (let i = 0; i < workspaces.length; i += CONCURRENCY_LIMIT) {
			const batch = workspaces.slice(i, i + CONCURRENCY_LIMIT);
			await Promise.all(batch.map(analyzeWorkspace));
		}

		this.log(`✅ Batch repository analysis complete for ${workspaces.length} workspace(s)`);
		
		// Notify the webview that all analyses are complete
		this.analysisPanel.webview.postMessage({
			command: 'repoAnalysisBatchComplete'
		});
	}

	private async runRepoHygieneAnalysis(workspacePath?: string): Promise<any> {
		// Determine which workspace to analyze
		let workspaceRoot: string;
		
		if (workspacePath) {
			// Use the provided workspace path
			workspaceRoot = workspacePath;
		} else {
			// Fall back to the first open workspace folder
			const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!firstFolder) {
				throw new Error('No workspace folder open');
			}
			workspaceRoot = firstFolder;
		}

		// Get repository info
		let branchName = 'unknown';
		let repoName = path.basename(workspaceRoot);
		try {
			const branch = childProcess.execSync('git rev-parse --abbrev-ref HEAD', {
				cwd: workspaceRoot,
				encoding: 'utf8',
				timeout: 5000,
				stdio: ['pipe', 'pipe', 'pipe']
			}).trim();
			branchName = branch;

			try {
				const remote = childProcess.execSync('git remote get-url origin', {
					cwd: workspaceRoot,
					encoding: 'utf8',
					timeout: 5000,
					stdio: ['pipe', 'pipe', 'pipe']
				}).trim();
				const match = remote.match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
				if (match) {
					repoName = match[1];
				}
			} catch {
				// Ignore remote fetch errors
			}
		} catch {
			// Ignore git errors
		}

		// Get workspace file tree for context
		const fileTree = await this.getWorkspaceFileTree(workspaceRoot);

		// Prepare the prompt for Copilot
		const prompt = `You are a repository analyzer. Analyze this repository for hygiene and best practices.

Use these skill instructions:

${REPO_HYGIENE_SKILL}

Repository: ${repoName}
Branch: ${branchName}
Workspace root: ${workspaceRoot}

File tree (showing configuration files):
${fileTree}

Perform the 17 hygiene checks as specified in the skill instructions. Return ONLY a valid JSON object matching this exact schema:

{
  "summary": {
    "totalScore": <number>,
    "maxScore": 76,
    "percentage": <number>,
    "passedChecks": <number>,
    "failedChecks": <number>,
    "warningChecks": <number>,
    "totalChecks": 17,
    "categories": {
      "versionControl": { "score": <number>, "maxScore": 13, "percentage": <number> },
      "codeQuality": { "score": <number>, "maxScore": 17, "percentage": <number> },
      "cicd": { "score": <number>, "maxScore": 10, "percentage": <number> },
      "environment": { "score": <number>, "maxScore": 9, "percentage": <number> },
      "documentation": { "score": <number>, "maxScore": 5, "percentage": <number> }
    }
  },
  "checks": [
    {
      "id": "<string>",
      "category": "<versionControl|codeQuality|cicd|environment|documentation>",
      "label": "<string>",
      "status": "<pass|fail|warning>",
      "weight": <number>,
      "found": <boolean>,
      "detail": "<string>",
      "hint": "<string or null>"
    }
  ],
  "recommendations": [
    {
      "priority": "<high|medium|low>",
      "category": "<string>",
      "action": "<string>",
      "weight": <number>,
      "impact": "<string>"
    }
  ],
  "metadata": {
    "scanVersion": "1.0.0",
    "timestamp": "${new Date().toISOString()}",
    "repository": "${repoName}",
    "branch": "${branchName}",
    "skillName": "repo-hygiene"
  }
}

Return ONLY the JSON object, no markdown formatting, no explanations.`;

		try {
			// Use VS Code Language Model API to invoke Copilot
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});

			if (models.length === 0) {
				throw new Error('No Copilot models available. Please ensure GitHub Copilot is installed and activated.');
			}

			const model = models[0];
			this.log(`🤖 Using Copilot model: ${model.id} for repository analysis`);

			const messages = [
				vscode.LanguageModelChatMessage.User(prompt)
			];

			const cts = new vscode.CancellationTokenSource();
			try {
				const response = await model.sendRequest(messages, {}, cts.token);

				let fullResponse = '';
				for await (const chunk of response.text) {
					fullResponse += chunk;
				}

				this.log(`📋 Copilot analysis response length: ${fullResponse.length} characters`);

				// Extract JSON from response (in case it's wrapped in markdown code blocks)
				let jsonText = fullResponse.trim();
				const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
				if (jsonMatch) {
					jsonText = jsonMatch[1].trim();
				}

				// Parse the JSON response
				const results = JSON.parse(jsonText);

				// Validate the structure
				if (!results.summary || !results.checks || !results.metadata) {
					throw new Error('Invalid response structure from Copilot');
				}

				return results;
			} finally {
				cts.dispose();
			}
		} catch (error) {
			this.error(`Failed to get analysis from Copilot: ${error}`);
			throw new Error(`AI analysis failed: ${error instanceof Error ? error.message : String(error)}. Please try again or check that GitHub Copilot is properly configured.`);
		}
	}

	private async getWorkspaceFileTree(workspaceRoot: string): Promise<string> {
		// Get a filtered file tree showing only configuration files
		const configPatterns = [
			'.git', '.gitignore', '.env.example', '.env.sample', '.editorconfig',
			'.eslintrc', 'eslint.config', '.prettierrc', 'prettier.config',
			'tsconfig.json', 'jsconfig.json', 'package.json', 'Makefile',
			'Dockerfile', 'docker-compose', '.github/workflows', '.devcontainer',
			'LICENSE', '.nvmrc', '.node-version'
		];

		try {
			const files: string[] = [];
			const maxDepth = 3;

			const scanDir = (dir: string, depth: number = 0) => {
				if (depth > maxDepth) {
					return;
				}

				try {
					const entries = fs.readdirSync(dir, { withFileTypes: true });
					for (const entry of entries) {
						const fullPath = path.join(dir, entry.name);
						const relativePath = path.relative(workspaceRoot, fullPath);

						// Skip node_modules and other large directories
						if (entry.name === 'node_modules' || entry.name === '.git' || 
						    entry.name === 'dist' || entry.name === 'build' || entry.name === 'out') {
							continue;
						}

						// Check if this file matches any config pattern
						const isConfig = configPatterns.some(pattern => relativePath.includes(pattern));

						if (isConfig) {
							files.push(relativePath);
						}

						if (entry.isDirectory() && depth < maxDepth) {
							scanDir(fullPath, depth + 1);
						}
					}
				} catch (error) {
					// Ignore permission errors
				}
			};

			scanDir(workspaceRoot);

			return files.length > 0 ? files.join('\n') : '(No configuration files detected)';
		} catch (error) {
			return '(Unable to scan workspace)';
		}
	}

	public async showLogViewer(sessionFilePath: string): Promise<void> {
		// Close existing log viewer panel if open
		if (this.logViewerPanel) {
			this.logViewerPanel.dispose();
			this.logViewerPanel = undefined;
		}

		// Get session log data with chat turns
		const logData = await this.getSessionLogData(sessionFilePath);

		// Create webview panel
		this.logViewerPanel = vscode.window.createWebviewPanel(
			'copilotLogViewer',
			`Session: ${logData.title || path.basename(sessionFilePath)}`,
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: false
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		// Set the HTML content
		this.logViewerPanel.webview.html = this.getLogViewerHtml(this.logViewerPanel.webview, logData);

		// Handle messages from the webview
		this.logViewerPanel.webview.onDidReceiveMessage(async (message) => {
			if (await this.dispatchSharedCommand(message.command)) { return; }
			switch (message.command) {
					case 'openRawFile':
						await this.dispatch('openRawFile:logviewer', async () => {
							try {
								const rawEco = this.findEcosystem(sessionFilePath);
								const rawContent = rawEco?.getRawFileContent?.(sessionFilePath);
								if (rawContent !== undefined) {
									const doc = await vscode.workspace.openTextDocument({ content: rawContent, language: 'json' });
									await vscode.window.showTextDocument(doc);
								} else {
									await vscode.window.showTextDocument(vscode.Uri.file(sessionFilePath));
								}
							} catch (err) {
								vscode.window.showErrorMessage('Could not open raw file: ' + sessionFilePath);
							}
						});
					break;
				case 'showToolCallPretty': {
					const { turnNumber, toolCallIdx } = message as { turnNumber: number; toolCallIdx: number };
					this.log(`showToolCallPretty: turn=${turnNumber}, toolCallIdx=${toolCallIdx}, file=${sessionFilePath}`);
					try {
						const turn = logData.turns.find(t => t.turnNumber === turnNumber);
						const turnIndex = logData.turns.findIndex(t => t.turnNumber === turnNumber);
						const toolCall = turn?.toolCalls?.[toolCallIdx];
						if (!toolCall) {
							this.log('showToolCallPretty: tool call not found in session data');
							vscode.window.showInformationMessage('Tool call not found in session data.');
							break;
						}

						const safeParse = (text?: string) => {
							if (!text) { return text; }
							try { return JSON.parse(text); } catch { return text; }
						};

						const mapTurnForContext = (t?: ChatTurn) => t ? {
							turnNumber: t.turnNumber,
							timestamp: t.timestamp,
							mode: t.mode,
							model: t.model,
							userMessage: t.userMessage,
							assistantResponse: t.assistantResponse,
							inputTokensEstimate: t.inputTokensEstimate,
							outputTokensEstimate: t.outputTokensEstimate,
							toolCalls: t.toolCalls?.map((tc, idx) => ({ index: idx, toolName: tc.toolName, arguments: tc.arguments, result: tc.result }))
						} : undefined;

						const mapToolCallForContext = (tc: { toolName: string; arguments?: string; result?: string }, idx: number, parentTurn?: ChatTurn) => ({
							turn: parentTurn?.turnNumber ?? turnNumber,
							toolCallIdx: idx,
							toolName: tc.toolName,
							model: parentTurn?.model,
							mode: parentTurn?.mode,
							timestamp: parentTurn?.timestamp,
							userMessage: parentTurn?.userMessage,
							assistantResponse: parentTurn?.assistantResponse,
							inputTokensEstimate: parentTurn?.inputTokensEstimate,
							outputTokensEstimate: parentTurn?.outputTokensEstimate,
							argumentsRaw: tc.arguments ?? null,
							argumentsParsed: safeParse(tc.arguments),
							resultRaw: tc.result ?? null,
							resultParsed: safeParse(tc.result)
						});

						const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'toolcall';
						const prettyName = sanitize(`${toolCall.toolName || 'tool'}-turn-${turnNumber}-call-${toolCallIdx}`);

						const prettyPayload = {
							turnBefore: turnIndex > 0 ? mapTurnForContext(logData.turns[turnIndex - 1]) : undefined,
							toolCall: mapToolCallForContext(toolCall, toolCallIdx, turn),
							turnAfter: turnIndex >= 0 && turnIndex < logData.turns.length - 1 ? mapTurnForContext(logData.turns[turnIndex + 1]) : undefined
						};

						const prettyUri = vscode.Uri.parse(`untitled:${prettyName}.json`);
						const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === prettyUri.toString());
						if (openDoc) {
							await vscode.window.showTextDocument(openDoc, { preview: true });
							break;
						}

						const doc = await vscode.workspace.openTextDocument(prettyUri);
						const editor = await vscode.window.showTextDocument(doc, { preview: true });
						const jsonText = JSON.stringify(prettyPayload, null, 2);
						await editor.edit((editBuilder) => {
							editBuilder.insert(new vscode.Position(0, 0), jsonText);
						});
						await vscode.languages.setTextDocumentLanguage(doc, 'json');
					} catch (err) {
						this.error('showToolCallPretty: error', err);
						vscode.window.showErrorMessage('Could not open formatted tool call.');
					}
					break;
				}
				case 'revealToolCallSource': {
					const { turnNumber, toolCallIdx } = message as { turnNumber: number; toolCallIdx: number };
					this.log(`revealToolCallSource: turn=${turnNumber}, toolCallIdx=${toolCallIdx}, file=${sessionFilePath}`);
					try {
						const turn = logData.turns.find(t => t.turnNumber === turnNumber);
						const toolCall = turn?.toolCalls?.[toolCallIdx];
						if (!toolCall) {
							this.log('revealToolCallSource: tool call not found in session data');
							vscode.window.showInformationMessage('Tool call not found in session data.');
							break;
						}

						const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
						const searchTerm = toolCall.toolName || '';
						const matchIdx = searchTerm ? fileContent.indexOf(searchTerm) : -1;
						this.log(`revealToolCallSource: searchTerm='${searchTerm}', matchIdx=${matchIdx}`);

						const doc = await vscode.workspace.openTextDocument(sessionFilePath);
						const editor = await vscode.window.showTextDocument(doc);

						if (matchIdx >= 0) {
							const pos = doc.positionAt(matchIdx);
							editor.selection = new vscode.Selection(pos, pos);
							editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
						} else {
							vscode.window.showInformationMessage('Opened session file, but could not locate this tool call text.');
						}
					} catch (err) {
						this.error('revealToolCallSource: error', err);
						vscode.window.showErrorMessage('Could not reveal tool call in file.');
					}
					break;
				}
			}
		});

		// Handle panel disposal
		this.logViewerPanel.onDidDispose(() => {
			this.logViewerPanel = undefined;
		});
	}

	/**
	 * Opens a JSONL file in a formatted view with array brackets and commas.
	 * Does not modify the original file.
	 */
	public async showFormattedJsonlFile(sessionFilePath: string): Promise<void> {
		try {
			// Read the file content
			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf-8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				vscode.window.showInformationMessage(
					`This file contains only a session ID (${fileContent.trim()}). The actual session data is stored elsewhere in the Copilot CLI format.`
				);
				return;
			}

			// Parse JSONL into array of objects
			const lines = fileContent.trim().split('\n').filter(line => line.trim().length > 0);
			const jsonObjects: unknown[] = [];

			for (let i = 0; i < lines.length; i++) {
				try {
					const obj = JSON.parse(lines[i]);
					jsonObjects.push(obj);
				} catch (e) {
					// Skip malformed lines with detailed warning
					this.warn(`Skipping malformed line ${i + 1} in ${sessionFilePath}: ${e}`);
				}
			}

			// Format as JSON array
			const formattedJson = JSON.stringify(jsonObjects, null, 2);

			// Create an untitled document with the formatted content
			const fileName = path.basename(sessionFilePath, path.extname(sessionFilePath));
			const prettyUri = vscode.Uri.parse(`untitled:${fileName}-formatted.json`);

			// Check if this document is already open and close it to refresh
			const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === prettyUri.toString());
			if (openDoc) {
				// Close the existing document so we can create a fresh one with updated content
				const editor = vscode.window.visibleTextEditors.find(e => e.document === openDoc);
				if (editor) {
					await vscode.window.showTextDocument(openDoc, editor.viewColumn);
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				}
			}

			// Create and open the document
			const doc = await vscode.workspace.openTextDocument(prettyUri);
			const editor = await vscode.window.showTextDocument(doc, { preview: true });

			// Insert the formatted JSON
			await editor.edit((editBuilder) => {
				editBuilder.insert(new vscode.Position(0, 0), formattedJson);
			});

			// Set language mode to JSON for syntax highlighting
			await vscode.languages.setTextDocumentLanguage(doc, 'json');

		} catch (error) {
			this.error(`Error formatting JSONL file ${sessionFilePath}:`, error);
			throw error;
		}
	}

	private getLogViewerHtml(webview: vscode.Webview, logData: SessionLogData): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'logviewer.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify({ ...logData, compactNumbers: this.getCompactNumbersSetting() }).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Session Log Viewer</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_LOGDATA__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private async refreshDetailsPanel(): Promise<void> {
		if (!this.detailsPanel) {
			return;
		}

		this.log('🔄 Refreshing Details panel');
		// Update token stats and refresh the webview content
		const stats = await this.updateTokenStats();
		if (stats) {
			this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);
			this.log('✅ Details panel refreshed');
		}
	}

	private async refreshChartPanel(): Promise<void> {
		if (!this.chartPanel) {
			return;
		}

		this.log('🔄 Refreshing Chart view');
		// Refresh the full-year daily stats so week/month period views are up to date
		await this.calculateDailyStats();
		// Refresh all stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Chart view refreshed');
	}

	private async refreshAnalysisPanel(): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		this.log('🔄 Refreshing Usage Analysis dashboard');
		// Force fresh usage analysis stats and re-render the webview
		const analysisStats = await this.calculateUsageAnalysisStats(false);
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);
		// Refresh token stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Usage Analysis dashboard refreshed');
	}

	// ── Maturity / Fluency Score ───────────────────────────────────────

	/**
	 * Calculate maturity scores across 6 categories using last 30 days of usage data.
	 * Each category is scored 1-4 based on threshold rules.
	 * Overall stage = median of the 6 category scores.
	 * @param useCache If true, use cached usage stats. If false, force recalculation.
	 */
	private async calculateMaturityScores(useCache = true): Promise<{
		overallStage: number;
		overallLabel: string;
		categories: { category: string; icon: string; stage: number; evidence: string[]; tips: string[] }[];
		period: UsageAnalysisPeriod;
		lastUpdated: string;
	}> {
		return _calculateMaturityScores(this._lastCustomizationMatrix, (useCache) => this.calculateUsageAnalysisStats(useCache), useCache);
	}

	public async showMaturity(): Promise<void> {
		this.log('🎯 Opening Copilot Fluency Score dashboard');
		await this.context.globalState.update('fluencyScore.everOpened', true);

		// If panel already exists, dispose and recreate with fresh data
		if (this.maturityPanel) {
			this.maturityPanel.dispose();
			this.maturityPanel = undefined;
		}

		const maturityData = await this.calculateMaturityScores(true); // Use cached data for fast loading
		const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;

		this.maturityPanel = vscode.window.createWebviewPanel(
			'copilotMaturity',
			'AI Engineering Fluency Score',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		const dismissedTips = await this.getDismissedFluencyTips();
		const fluencyLevels = isDebugMode ? this.getFluencyLevelData(isDebugMode).categories : undefined;
		this.maturityPanel.webview.onDidReceiveMessage(async (message) => {
			if (this.handleLocalViewRegressionMessage(message)) { return; }
			if (await this.dispatchSharedCommand(message.command)) { return; }
			switch (message.command) {
				case 'refresh':
					await this.dispatch('refresh:maturity', () => this.refreshMaturityPanel());
					break;
				case 'searchMcpExtensions':
					await this.dispatch('searchMcpExtensions', () =>
						vscode.commands.executeCommand('workbench.extensions.search', '@tag:mcp')
					);
					break;
				case 'shareToIssue': {
					await this.dispatch('shareToIssue', async () => {
						const scores = await this.calculateMaturityScores();
						const categorySections = scores.categories.map(c => {
							const evidenceList = c.evidence.length > 0
								? c.evidence.map(e => `- ✅ ${e}`).join('\n')
								: '- No significant activity detected';
							return `<h2>${c.icon} ${c.category} — Stage ${c.stage}</h2>\n\n${evidenceList}`;
						}).join('\n\n');
						const body = `<h2>AI Engineering Fluency Score Feedback</h2>\n\n**Overall Stage:** ${scores.overallLabel}\n\n${categorySections}\n\n<h2>Feedback</h2>\n<!-- Describe your feedback or suggestion here -->\n`;
						const issueUrl = `https://github.com/rajbos/github-copilot-token-usage/issues/new?title=${encodeURIComponent('Fluency Score Feedback')}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent('fluency-score')}`;
						await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
					});
					break;
				}
				case 'dismissTips':
					if (message.category) {
						await this.dispatch('dismissTips', async () => {
							await this.dismissFluencyTips(message.category);
							await this.refreshMaturityPanel();
						});
					}
					break;
				case 'resetDismissedTips':
					await this.dispatch('resetDismissedTips', async () => {
						await this.resetDismissedFluencyTips();
						await this.refreshMaturityPanel();
					});
					break;
				case 'shareToLinkedIn':
					await this.dispatch('shareToLinkedIn', () => this.shareToSocialMedia('linkedin'));
					break;
				case 'shareToBluesky':
					await this.dispatch('shareToBluesky', () => this.shareToSocialMedia('bluesky'));
					break;
				case 'shareToMastodon':
					await this.dispatch('shareToMastodon', () => this.shareToSocialMedia('mastodon'));
					break;
				case 'downloadChartImage':
					await this.dispatch('downloadChartImage', () => this.downloadChartImage());
					break;
				case 'saveChartImage':
					if (message.data) {
						await this.dispatch('saveChartImage', () => this.saveChartImageData(message.data));
					}
					break;
				case 'exportPdf':
					if (message.data) {
						await this.dispatch('exportPdf', () => this.exportFluencyScorePdf(message.data));
					}
					break;
				case 'exportPptx':
					if (message.data) {
						await this.dispatch('exportPptx', () => this.exportFluencyScorePptx(message.data));
					}
					break;
			}
		});

		this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, { ...maturityData, dismissedTips, isDebugMode, fluencyLevels });

	this.maturityPanel.onDidDispose(() => {
		this.log('🎯 Copilot Fluency Score dashboard closed');
		this.maturityPanel = undefined;
	});
}

private async refreshMaturityPanel(): Promise<void> {
	if (!this.maturityPanel) {
		return;
	}

	this.log('🔄 Refreshing Copilot Fluency Score dashboard');
	const maturityData = await this.calculateMaturityScores(false); // Force recalculation on refresh
	const dismissedTips = await this.getDismissedFluencyTips();
	const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;
	const fluencyLevels = isDebugMode ? this.getFluencyLevelData(isDebugMode).categories : undefined;
	this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, { ...maturityData, dismissedTips, isDebugMode, fluencyLevels });
	this.log('✅ Copilot Fluency Score dashboard refreshed');
}

private async getDismissedFluencyTips(): Promise<string[]> {
	return this.context.globalState.get<string[]>('dismissedFluencyTips', []);
}

private async dismissFluencyTips(category: string): Promise<void> {
	const dismissed = await this.getDismissedFluencyTips();
	if (!dismissed.includes(category)) {
		dismissed.push(category);
		await this.context.globalState.update('dismissedFluencyTips', dismissed);
		this.log(`Dismissed fluency tips for category: ${category}`);
	}
}

private async resetDismissedFluencyTips(): Promise<void> {
	await this.context.globalState.update('dismissedFluencyTips', []);
	this.log('Reset all dismissed fluency tips');
}

/**
 * Share Copilot Fluency Score to social media platforms
 */
private async shareToSocialMedia(platform: 'linkedin' | 'bluesky' | 'mastodon'): Promise<void> {
	const scores = await this.calculateMaturityScores();
	const marketplaceUrl = 'https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker';
	const hashtag = '#CopilotFluencyScore';
	
	// Build share text with stats
	const categoryScores = scores.categories.map(c => `${c.icon} ${c.category}: Stage ${c.stage}`).join('\n');
	
	const shareText = `🎯 My AI Engineering Fluency Score

Overall: ${scores.overallLabel}

${categoryScores}

Track your Copilot usage and level up your AI-assisted development skills!

Get the extension: ${marketplaceUrl}

${hashtag}`;

    switch (platform) {
      case "linkedin": {
        // LinkedIn share URL - opens in browser for user to add their own commentary
        const shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(marketplaceUrl)}`;

        // Copy share text to clipboard for easy pasting
        await vscode.env.clipboard.writeText(shareText);
        await vscode.window
          .showInformationMessage(
            "Share text copied to clipboard! Paste it into your LinkedIn post.",
            "Open LinkedIn",
          )
          .then(async (selection) => {
            if (selection === "Open LinkedIn") {
              await vscode.env.openExternal(vscode.Uri.parse(shareUrl));
            }
          });
        break;
      }

      case "bluesky": {
        // Copy share text to clipboard, then open Bluesky compose
        await vscode.env.clipboard.writeText(shareText);
        await vscode.window
          .showInformationMessage(
            "Share text copied to clipboard! Paste it into your Bluesky post.",
            "Open Bluesky",
          )
          .then(async (selection) => {
            if (selection === "Open Bluesky") {
              await vscode.env.openExternal(
                vscode.Uri.parse("https://bsky.app/intent/compose"),
              );
            }
          });
        break;
      }

      case "mastodon": {
        // Mastodon share - ask user for their instance
        const instance = await vscode.window.showInputBox({
          prompt: "Enter your Mastodon instance (e.g., mastodon.social)",
          placeHolder: "mastodon.social",
          value: "mastodon.social",
        });

        if (instance) {
          // Copy share text to clipboard, then open Mastodon compose
          await vscode.env.clipboard.writeText(shareText);
          await vscode.window
            .showInformationMessage(
              "Share text copied to clipboard! Paste it into your Mastodon post.",
              "Open Mastodon",
            )
            .then(async (selection) => {
              if (selection === "Open Mastodon") {
                await vscode.env.openExternal(
                  vscode.Uri.parse(`https://${instance}/share`),
                );
              }
            });
        }
        break;
      }
    }

    this.log(`Shared fluency score to ${platform}`);
  }

  /**
   * Download the fluency chart as an image
   */
  private async downloadChartImage(): Promise<void> {
    await vscode.window.showInformationMessage(
      '💡 Click the "Download Chart Image" button to save the radar chart as a PNG file.',
      "Got it",
    );
    this.log("Showed chart download instructions");
  }

  private async saveChartImageData(dataUrl: string): Promise<void> {
    const base64Match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!base64Match) {
      void vscode.window.showErrorMessage(
        "Failed to process chart image data.",
      );
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("copilot-fluency-score.png"),
      filters: { "PNG Image": ["png"] },
      title: "Save Fluency Score Chart",
    });

    if (!uri) {
      return;
    }

    const buffer = Buffer.from(base64Match[1], "base64");
    await vscode.workspace.fs.writeFile(uri, buffer);
    void vscode.window
      .showInformationMessage(
        `Chart image saved to ${uri.fsPath}`,
        "Open Image",
      )
      .then((selection) => {
        if (selection === "Open Image") {
          void vscode.env.openExternal(uri);
        }
      });
    this.log(`Chart image saved to ${uri.fsPath}`);
  }

  /**
   * Export Copilot Fluency Score as a landscape PDF with screenshot images
   */
  private async exportFluencyScorePdf(
    images: { label: string; dataUrl: string }[],
  ): Promise<void> {
    try {
      const jsPDF = (await import("jspdf")).default;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file("copilot-fluency-score.pdf"),
        filters: { "PDF Document": ["pdf"] },
        title: "Export Fluency Score Report",
      });

      if (!uri) {
        return;
      }

      const pdf = new jsPDF({
        orientation: "landscape",
        unit: "mm",
        format: "a4",
      });

      const pageWidth = pdf.internal.pageSize.getWidth(); // ~297mm
      const pageHeight = pdf.internal.pageSize.getHeight(); // ~210mm
      const margin = 10;

      for (let i = 0; i < images.length; i++) {
        if (i > 0) {
          pdf.addPage();
        }

        // Page header
        pdf.setFontSize(8);
        pdf.setTextColor(128, 128, 128);
        pdf.text(
          `AI Engineering Fluency Score Report - Page ${i + 1} of ${images.length}`,
          margin,
          7,
        );
        pdf.text(new Date().toLocaleDateString(), pageWidth - margin, 7, {
          align: "right",
        });

        // Insert the screenshot image, fitting within the page
        const imgData = images[i].dataUrl;
        const availW = pageWidth - 2 * margin;
        const availH = pageHeight - 2 * margin - 5; // extra space for header/footer

        // Determine image aspect ratio from the base64 PNG header
        const imgProps = pdf.getImageProperties(imgData);
        const imgW = imgProps.width;
        const imgH = imgProps.height;
        const scale = Math.min(availW / imgW, availH / imgH);
        const drawW = imgW * scale;
        const drawH = imgH * scale;
        const x = margin + (availW - drawW) / 2;
        const y = margin + 5 + (availH - drawH) / 2;

        pdf.addImage(imgData, "PNG", x, y, drawW, drawH);

        // Footer
        pdf.setFontSize(8);
        pdf.setTextColor(128, 128, 128);
        pdf.text(
          "Generated by AI Engineering Fluency Extension",
          pageWidth / 2,
          pageHeight - 5,
          { align: "center" },
        );
      }

      const pdfBuffer = Buffer.from(pdf.output("arraybuffer"));
      await vscode.workspace.fs.writeFile(uri, pdfBuffer);

      void vscode.window
        .showInformationMessage(
          `Fluency Score PDF saved to ${uri.fsPath}`,
          "Open PDF",
        )
        .then((selection) => {
          if (selection === "Open PDF") {
            void vscode.env.openExternal(uri);
          }
        });

      this.log(`Fluency Score PDF exported to ${uri.fsPath}`);
    } catch (error) {
      this.error(
        "Failed to export PDF",
        error instanceof Error ? error : new Error(String(error)),
      );
      void vscode.window.showErrorMessage(
        `Failed to export PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Export Copilot Fluency Score as a PowerPoint presentation with screenshot images
   */
  private async exportFluencyScorePptx(
    images: { label: string; dataUrl: string }[],
  ): Promise<void> {
    try {
      const PptxGenJSModule = await import("pptxgenjs");
      const PptxGenJS = PptxGenJSModule.default as any;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file("copilot-fluency-score.pptx"),
        filters: { "PowerPoint Presentation": ["pptx"] },
        title: "Export Fluency Score as PowerPoint",
      });

      if (!uri) {
        return;
      }

      const pptx = new PptxGenJS();
      pptx.layout = "LAYOUT_WIDE"; // 13.33" x 7.5" — great for presentations
      pptx.author = "AI Engineering Fluency";
      pptx.subject = "AI Engineering Fluency Score Report";
      pptx.title = "AI Engineering Fluency Score";

      const slideW = 13.33;
      const slideH = 7.5;
      const maxW = slideW - 0.8; // 0.4" margin each side
      const maxH = slideH - 1.0; // room for footer

      for (const img of images) {
        const slide = pptx.addSlide();
        slide.background = { color: "1b1b1e" };

        // Decode PNG dimensions from the base64 data to preserve aspect ratio
        let imgW = maxW;
        let imgH = maxH;
        try {
          const base64 = img.dataUrl.split(",")[1];
          const buf = Buffer.from(base64, "base64");
          // PNG header: width at bytes 16-19, height at bytes 20-23 (big-endian)
          if (
            buf.length > 24 &&
            buf[1] === 0x50 &&
            buf[2] === 0x4e &&
            buf[3] === 0x47
          ) {
            const pxW = buf.readUInt32BE(16);
            const pxH = buf.readUInt32BE(20);
            if (pxW > 0 && pxH > 0) {
              const aspect = pxW / pxH;
              // Fit within maxW x maxH preserving aspect ratio
              if (aspect > maxW / maxH) {
                imgW = maxW;
                imgH = maxW / aspect;
              } else {
                imgH = maxH;
                imgW = maxH * aspect;
              }
            }
          }
        } catch {
          /* fall back to max dimensions */
        }

        const x = (slideW - imgW) / 2;
        const y = (slideH - 1.0 - imgH) / 2 + 0.1; // center in area above footer

        slide.addImage({
          data: img.dataUrl,
          x,
          y,
          w: imgW,
          h: imgH,
        });

        // Footer text
        slide.addText("Generated by AI Engineering Fluency Extension", {
          x: 0,
          y: 7.0,
          w: 13.33,
          h: 0.4,
          fontSize: 8,
          color: "808080",
          align: "center",
        });
      }

      const pptxBuffer = (await pptx.write({
        outputType: "nodebuffer",
      })) as Buffer;
      await vscode.workspace.fs.writeFile(uri, pptxBuffer);

      void vscode.window
        .showInformationMessage(
          `Fluency Score PPTX saved to ${uri.fsPath}`,
          "Open File",
        )
        .then((selection) => {
          if (selection === "Open File") {
            void vscode.env.openExternal(uri);
          }
        });

      this.log(`Fluency Score PPTX exported to ${uri.fsPath}`);
    } catch (error) {
      this.error(
        "Failed to export PPTX",
        error instanceof Error ? error : new Error(String(error)),
      );
      void vscode.window.showErrorMessage(
        `Failed to export PPTX: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async showFluencyLevelViewer(): Promise<void> {
    const isDebugMode = false;

    this.log("🔍 Opening Scoring Guide");

    // If panel already exists, dispose and recreate with fresh data
    if (this.fluencyLevelViewerPanel) {
      this.fluencyLevelViewerPanel.dispose();
      this.fluencyLevelViewerPanel = undefined;
    }

    const fluencyLevelData = this.getFluencyLevelData(isDebugMode);

    this.fluencyLevelViewerPanel = vscode.window.createWebviewPanel(
      "copilotFluencyLevelViewer",
      "Scoring Guide",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
        ],
      },
    );

    this.fluencyLevelViewerPanel.webview.onDidReceiveMessage(
      async (message) => {
        if (this.handleLocalViewRegressionMessage(message)) { return; }
        if (await this.dispatchSharedCommand(message.command)) { return; }
        if (message.command === "refresh") {
          await this.dispatch('refresh:fluencyLevelViewer', () => this.refreshFluencyLevelViewerPanel());
        }
      },
    );

    this.fluencyLevelViewerPanel.webview.html = this.getFluencyLevelViewerHtml(
      this.fluencyLevelViewerPanel.webview,
      fluencyLevelData,
    );

    this.fluencyLevelViewerPanel.onDidDispose(() => {
      this.log("🔍 Fluency Level Viewer closed");
      this.fluencyLevelViewerPanel = undefined;
    });
  }

  private async refreshFluencyLevelViewerPanel(): Promise<void> {
    if (!this.fluencyLevelViewerPanel) {
      return;
    }

    const isDebugMode = false;
    this.log("🔄 Refreshing Scoring Guide");
    const fluencyLevelData = this.getFluencyLevelData(isDebugMode);
    this.fluencyLevelViewerPanel.webview.html = this.getFluencyLevelViewerHtml(
      this.fluencyLevelViewerPanel.webview,
      fluencyLevelData,
    );
    this.log("✅ Scoring Guide refreshed");
  }

  private getFluencyLevelData(isDebugMode: boolean): ReturnType<typeof _getFluencyLevelData> {
		return _getFluencyLevelData(isDebugMode);
  }

  private getFluencyLevelViewerHtml(
    webview: vscode.Webview,
    data: {
      categories: Array<{
        category: string;
        icon: string;
        levels: Array<{
          stage: number;
          label: string;
          description: string;
          thresholds: string[];
          tips: string[];
        }>;
      }>;
      isDebugMode: boolean;
    },
  ): string {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "dist",
        "webview",
        "fluency-level-viewer.js",
      ),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const dataWithBackend = {
      ...data,
      backendConfigured: this.isBackendConfigured(),
    };
    const initialData = JSON.stringify(dataWithBackend).replace(
      /</g,
      "\\u003c",
    );

    return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
		<title>Scoring Guide</title>
	</head>
	<body>
		<div id="root"></div>
		<script nonce="${nonce}">window.__INITIAL_FLUENCY_LEVEL_DATA__ = ${initialData};</script>
		${this.getLocalViewRegressionProbeScript('fluency-level-viewer', nonce)}
		<script nonce="${nonce}" src="${scriptUri}"></script>
	</body>
	</html>`;
  }

  private getMaturityHtml(
    webview: vscode.Webview,
    data: {
      overallStage: number;
      overallLabel: string;
      categories: {
        category: string;
        icon: string;
        stage: number;
        evidence: string[];
        tips: string[];
      }[];
      period: UsageAnalysisPeriod;
      lastUpdated: string;
      dismissedTips?: string[];
      isDebugMode?: boolean;
      fluencyLevels?: Array<{
        category: string;
        icon: string;
        levels: Array<{
          stage: number;
          label: string;
          description: string;
          thresholds: string[];
          tips: string[];
        }>;
      }>;
    },
  ): string {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "maturity.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const dataWithBackend = {
      ...data,
      backendConfigured: this.isBackendConfigured(),
    };
    const initialData = JSON.stringify(dataWithBackend).replace(
      /</g,
      "\\u003c",
    );

    return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>AI Engineering Fluency Score</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_MATURITY__ = ${initialData};</script>
			${this.getLocalViewRegressionProbeScript('maturity', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  /**
   * Opens the Team Dashboard panel showing personal and team usage comparison.
   */
  public async showDashboard(): Promise<void> {
    this.log("📊 Opening Team Dashboard");

    // Check if backend is configured
    if (!this.backend) {
      vscode.window.showWarningMessage(
        "Team Dashboard requires backend sync to be configured. Please configure backend settings first.",
      );
      return;
    }

    const settings = this.backend.getSettings();
    if (!this.backend.isConfigured(settings)) {
      vscode.window.showWarningMessage(
        "Team Dashboard requires backend sync to be configured. Please configure backend settings first.",
      );
      return;
    }

    // If panel already exists, just reveal it
    if (this.dashboardPanel) {
      this.dashboardPanel.reveal();
      this.log("📊 Team Dashboard revealed (already exists)");
      return;
    }

    // Show panel immediately with loading state
    this.dashboardPanel = vscode.window.createWebviewPanel(
      "copilotDashboard",
      "Team Dashboard",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
        ],
      },
    );

    this.dashboardPanel.webview.html = this.getDashboardHtml(
      this.dashboardPanel.webview,
      undefined,
    );

    this.dashboardPanel.webview.onDidReceiveMessage(async (message) => {
      if (await this.dispatchSharedCommand(message.command)) { return; }
      switch (message.command) {
        case "refresh":
          await this.dispatch('refresh:dashboard', () => this.refreshDashboardPanel());
          break;
        case "deleteUserDataset":
          await this.dispatch('deleteUserDataset', () => this.handleDeleteUserDataset(message.userId, message.datasetId));
          break;
        case "backfillHistoricalData":
          await this.dispatch('backfillHistoricalData', () => this.handleBackfillHistoricalData());
          break;
      }
    });

    this.dashboardPanel.onDidDispose(() => {
      this.log("📊 Team Dashboard closed");
      this.dashboardPanel = undefined;
    });

    // If we have cached data, show it immediately so the panel renders fast
    if (this.lastDashboardData) {
      this.log("📊 Sending cached dashboard data immediately");
      this.dashboardPanel.webview.postMessage({
        command: "dashboardData",
        data: this.lastDashboardData,
      });
    }

    // Load (or refresh) data asynchronously and send to webview
    try {
      const dashboardData = await this.getDashboardData();
      this.lastDashboardData = dashboardData;
      this.dashboardPanel?.webview.postMessage({
        command: "dashboardData",
        data: dashboardData,
      });
    } catch (error) {
      this.error("Failed to load dashboard data:", error);
      // Only show error state when there's no cached data to fall back on
      if (!this.lastDashboardData) {
        this.dashboardPanel?.webview.postMessage({
          command: "dashboardError",
          message:
            "Failed to load dashboard data. Please check backend configuration and try again.",
        });
      }
    }
  }

  private async refreshDashboardPanel(): Promise<void> {
    if (!this.dashboardPanel) {
      return;
    }

    this.log("🔄 Refreshing Team Dashboard");
    this.dashboardPanel.webview.postMessage({ command: "dashboardLoading" });
    try {
      const dashboardData = await this.getDashboardData();
      this.lastDashboardData = dashboardData;
      this.dashboardPanel?.webview.postMessage({
        command: "dashboardData",
        data: dashboardData,
      });
      this.log("✅ Team Dashboard refreshed");
    } catch (error) {
      this.error("Failed to refresh dashboard:", error);
      this.dashboardPanel?.webview.postMessage({
        command: "dashboardError",
        message: "Failed to refresh dashboard data.",
      });
    }
  }

  /**
   * Handle per-row delete from the Team Dashboard.
   * Shows a confirmation dialog, deletes table entities, then refreshes.
   */
  private async handleDeleteUserDataset(
    userId: string,
    datasetId: string,
  ): Promise<void> {
    if (!this.backend || !userId || !datasetId) {
      return;
    }

    const conf = ConfirmationMessages.deleteUserDataset(userId, datasetId);
    const choice = await vscode.window.showWarningMessage(
      conf.message,
      { modal: true, detail: conf.detail },
      conf.button,
    );

    if (choice !== conf.button) {
      return;
    }

    this.log(`🗑️ Deleting data for user "${userId}" in dataset "${datasetId}"`);
    this.dashboardPanel?.webview.postMessage({ command: "dashboardLoading" });

    try {
      const result = await this.backend.deleteUserDataset(userId, datasetId);
      if (result.errors.length > 0) {
        this.warn(
          `Partial deletion: ${result.deletedCount} deleted, ${result.errors.length} errors`,
        );
        vscode.window.showWarningMessage(
          `Deleted ${result.deletedCount} entries with ${result.errors.length} errors. Dashboard will refresh.`,
        );
      } else {
        this.log(
          `✅ Deleted ${result.deletedCount} entries for user "${userId}" in dataset "${datasetId}"`,
        );
        vscode.window.showInformationMessage(
          `Deleted ${result.deletedCount} data entries for "${userId}".`,
        );
      }

      // Refresh the dashboard with fresh data
      await this.refreshDashboardPanel();
    } catch (error) {
      this.error("Failed to delete user dataset:", error);
      this.dashboardPanel?.webview.postMessage({
        command: "dashboardError",
        message:
          "Failed to delete data. Please check backend configuration and try again.",
      });
    }
  }

  /**
   * Calculates a fluency stage (1-4) for a team member based on aggregated Azure Table Storage metrics.
   * Applies the same 6-category scoring thresholds as calculateMaturityScores().
   */

  /**
   * Backfill historical token data to Azure Table Storage by scanning all local session files
   * without the normal mtime-based age filter.
   */
  private async handleBackfillHistoricalData(): Promise<void> {
    if (!this.backend) {
      return;
    }

    this.log('🔄 Starting historical data backfill...');
    this.dashboardPanel?.webview.postMessage({
      command: 'backfillProgress',
      text: 'Backfill starting — scanning local session files...',
      processed: 0,
      total: 0,
      daysFound: 0,
    });

    try {
      await this.backend.backfillHistoricalData(365, (processed, total, daysFound) => {
        // processed === -1 is a sentinel signalling the upload phase (total = entity count, daysFound = days)
        const text = processed === -1
          ? `Backfill: uploading ${total} entries for ${daysFound} days to Azure...`
          : `Backfill in progress: ${processed}${total > 0 ? `/${total}` : ''} files scanned, ${daysFound} days found...`;
        this.dashboardPanel?.webview.postMessage({
          command: 'backfillProgress',
          text,
          processed,
          total,
          daysFound,
        });
      });
      this.log('✅ Historical data backfill complete');
      vscode.window.setStatusBarMessage('$(check) Backfill complete. Refreshing dashboard...', 5000);
      // Invalidate the cached dashboard data so the refresh reflects the new backfill
      this.lastDashboardData = undefined;
      await this.refreshDashboardPanel();
    } catch (error) {
      this.error('Backfill failed:', error);
      this.dashboardPanel?.webview.postMessage({
        command: 'dashboardError',
        message: 'Backfill failed. Please check backend configuration and try again.',
      });
    }
  }

  /**
   * Fetches and aggregates data for the Team Dashboard.
   */
  private async getDashboardData(): Promise<any> {
    if (!this.backend) {
      throw new Error("Backend not configured");
    }

    const { BackendUtility } =
      await import("./backend/services/utilityService.js");
    const { computeBackendSharingPolicy, hashMachineIdForTeam } =
      await import("./backend/sharingProfile.js");
    const settings = this.backend.getSettings();

    // Log backend settings for debugging
    this.log(
      `[Dashboard] Backend settings - userIdentityMode: ${settings.userIdentityMode}, configured userId: "${settings.userId}", datasetId: "${settings.datasetId}"`,
    );

    // Compute the effective sharing policy so we know how entities were stored
    const sharingPolicy = computeBackendSharingPolicy({
      enabled: settings.enabled ?? true,
      profile: settings.sharingProfile ?? 'off',
      shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames ?? false,
    });

    // Resolve the effective userId for the current user based on backend config
    const currentUserId = await this.backend.resolveEffectiveUserId(settings);

    // When includeUserDimension is false (soloFull / teamAnonymized), entities are stored
    // without a userId. In that case, fall back to matching personal data by machineId.
    const rawMachineId = vscode.env.machineId;
    const currentMachineId = sharingPolicy.includeUserDimension
      ? "" // not needed — we match by userId
      : sharingPolicy.machineIdStrategy === "hashed"
        ? hashMachineIdForTeam({ datasetId: settings.datasetId ?? "", machineId: rawMachineId })
        : rawMachineId; // 'raw' strategy (soloFull)

    if (!currentUserId && !currentMachineId) {
      this.warn(
        "[Dashboard] No user identity available. Ensure sharing profile includes user dimension.",
      );
      this.warn(
        `[Dashboard] Settings: mode=${settings.userIdentityMode}, userId="${settings.userId}"`,
      );
    }

    // Query backend for the configured lookback window
    const now = new Date();
    const todayKey = BackendUtility.toUtcDayKey(now);
    const startKey = BackendUtility.addDaysUtc(todayKey, -(settings.lookbackDays - 1));

    // Fetch ALL entities across all datasets using the facade's public API
    const allEntities = await this.backend.getAllAggEntitiesForRange(
      settings,
      startKey,
      todayKey,
    );

    // Log all unique userIds and datasets in the data for debugging
    const uniqueUserIds = new Set(
      allEntities
        .map((e) => (e.userId ?? "").toString())
        .filter((id) => id.trim()),
    );
    const uniqueDatasets = new Set(
      allEntities
        .map((e) => (e.datasetId ?? "").toString())
        .filter((id) => id.trim()),
    );
    this.log(
      `[Dashboard] Fetched ${allEntities.length} entities for date range ${startKey} to ${todayKey}`,
    );
    this.log(
      `[Dashboard] Current user ID resolved as: ${currentUserId || "(none)"}`,
    );
    this.log(
      `[Dashboard] Datasets found: [${Array.from(uniqueDatasets)
        .map((id) => `"${id}"`)
        .join(", ")}]`,
    );
    this.log(
      `[Dashboard] UserIds in data: [${Array.from(uniqueUserIds)
        .map((id) => `"${id}"`)
        .join(", ")}]`,
    );

    // Aggregate personal data (all machines and workspaces for current user)
    const personalDevices = new Set<string>();
    const personalWorkspaces = new Set<string>();
    const personalModelUsage: {
      [model: string]: { inputTokens: number; outputTokens: number };
    } = {};
    let personalTotalTokens = 0;
    let personalTotalInteractions = 0;

    // Aggregate team data (all users across all datasets)
    const userMap = new Map<
      string,
      {
        tokens: number;
        interactions: number;
        cost: number;
        datasetId: string;
        sessions: Set<string>; // Track unique day+workspace+machine as session proxy
        models: Set<string>; // Track unique models used
        workspaces: Set<string>; // Track unique workspaces
        days: Set<string>; // Track unique days active
      }
    >();

    // Aggregate fluency data per user (schema version 4+ entities only)
    const userFluencyMap = new Map<string, {
      askModeCount: number; editModeCount: number; agentModeCount: number;
      planModeCount: number; customAgentModeCount: number; cliModeCount: number;
      toolCallsTotal: number; toolCallsByTool: Record<string, number>;
      ctxFile: number; ctxSelection: number; ctxSymbol: number;
      ctxCodebase: number; ctxWorkspace: number; ctxTerminal: number;
      ctxVscode: number; ctxClipboard: number; ctxChanges: number;
      ctxProblemsPanel: number; ctxOutputPanel: number;
      ctxTerminalLastCommand: number; ctxTerminalSelection: number;
      ctxByKind: Record<string, number>;
      mcpTotal: number; mcpByServer: Record<string, number>;
      mixedTierSessions: number; switchingFreqSum: number; switchingFreqCount: number;
      standardModels: Set<string>; premiumModels: Set<string>;
      multiFileEdits: number; filesPerEditSum: number; filesPerEditCount: number;
      editsAgentCount: number; workspaceAgentCount: number;
      repositories: Set<string>; repositoriesWithCustomization: Set<string>;
      applyRateSum: number; applyRateCount: number;
      multiTurnSessions: number; turnsPerSessionSum: number; turnsPerSessionCount: number;
      sessionCount: number; durationMsSum: number; durationMsCount: number;
    }>();

    // Track first and last data points for reference
    let firstDate: string | null = null;
    let lastDate: string | null = null;

    for (const entity of allEntities) {
      const userId = (entity.userId ?? "").toString().replace(/^u:/, ""); // Strip u: prefix
      const datasetId = (entity.datasetId ?? "").toString().replace(/^ds:/, ""); // Strip ds: prefix
      const machineId = (entity.machineId ?? "").toString().replace(/^mc:/, ""); // Strip mc: prefix
      const workspaceId = (entity.workspaceId ?? "").toString();
      const model = (entity.model ?? "").toString().replace(/^m:/, ""); // Strip m: prefix
      const inputTokens = Number.isFinite(Number(entity.inputTokens))
        ? Number(entity.inputTokens)
        : 0;
      const outputTokens = Number.isFinite(Number(entity.outputTokens))
        ? Number(entity.outputTokens)
        : 0;
      const interactions = Number.isFinite(Number(entity.interactions))
        ? Number(entity.interactions)
        : 0;
      const tokens = inputTokens + outputTokens;
      const dayKey = (entity.day ?? "").toString().replace(/^d:/, ""); // Strip d: prefix

      // Track date range
      if (dayKey) {
        if (!firstDate || dayKey < firstDate) {
          firstDate = dayKey;
        }
        if (!lastDate || dayKey > lastDate) {
          lastDate = dayKey;
        }
      }

      // Personal data aggregation - match against resolved userId (or machineId when
      // includeUserDimension is false, i.e. soloFull / teamAnonymized profiles).
      const isCurrentUser = sharingPolicy.includeUserDimension
        ? (currentUserId !== "" && userId === currentUserId)
        : (currentMachineId !== "" && machineId === currentMachineId);
      if (isCurrentUser) {
        personalTotalTokens += tokens;
        personalTotalInteractions += interactions;
        personalDevices.add(machineId);
        personalWorkspaces.add(workspaceId);

        if (!personalModelUsage[model]) {
          personalModelUsage[model] = { inputTokens: 0, outputTokens: 0 };
        }
        personalModelUsage[model].inputTokens += inputTokens;
        personalModelUsage[model].outputTokens += outputTokens;
      }

      // Team data aggregation - use userId|datasetId as key to track users across datasets.
      // When includeUserDimension is false, use machineId as the team member key so that
      // each machine appears as a distinct entry even though no userId was stored.
      const teamMemberKey = (userId && userId.trim()) ? userId : (machineId ? `machine:${machineId}` : "");
      if (teamMemberKey) {
        const userKey = `${teamMemberKey}|${datasetId}`;
        if (!userMap.has(userKey)) {
          userMap.set(userKey, {
            tokens: 0,
            interactions: 0,
            cost: 0,
            datasetId,
            sessions: new Set<string>(),
            models: new Set<string>(),
            workspaces: new Set<string>(),
            days: new Set<string>(),
          });
        }
        const userData = userMap.get(userKey)!;
        userData.tokens += tokens;
        userData.interactions += interactions;
        // Track unique sessions as day+workspace+machine combinations
        const sessionKey = `${dayKey}|${workspaceId}|${machineId}`;
        userData.sessions.add(sessionKey);
        // Track unique models, workspaces, and days
        if (model) {
          userData.models.add(model);
        }
        if (workspaceId) {
          userData.workspaces.add(workspaceId);
        }
        if (dayKey) {
          userData.days.add(dayKey);
        }

        // Fluency data accumulation (schema version 4+)
        if ((entity.schemaVersion ?? 0) >= 4) {
          if (!userFluencyMap.has(userKey)) {
            userFluencyMap.set(userKey, {
              askModeCount: 0, editModeCount: 0, agentModeCount: 0,
              planModeCount: 0, customAgentModeCount: 0, cliModeCount: 0,
              toolCallsTotal: 0, toolCallsByTool: {},
              ctxFile: 0, ctxSelection: 0, ctxSymbol: 0,
              ctxCodebase: 0, ctxWorkspace: 0, ctxTerminal: 0,
              ctxVscode: 0, ctxClipboard: 0, ctxChanges: 0,
              ctxProblemsPanel: 0, ctxOutputPanel: 0,
              ctxTerminalLastCommand: 0, ctxTerminalSelection: 0,
              ctxByKind: {},
              mcpTotal: 0, mcpByServer: {},
              mixedTierSessions: 0, switchingFreqSum: 0, switchingFreqCount: 0,
              standardModels: new Set(), premiumModels: new Set(),
              multiFileEdits: 0, filesPerEditSum: 0, filesPerEditCount: 0,
              editsAgentCount: 0, workspaceAgentCount: 0,
              repositories: new Set(), repositoriesWithCustomization: new Set(),
              applyRateSum: 0, applyRateCount: 0,
              multiTurnSessions: 0, turnsPerSessionSum: 0, turnsPerSessionCount: 0,
              sessionCount: 0, durationMsSum: 0, durationMsCount: 0,
            });
          }
          const fd = userFluencyMap.get(userKey)!;
          fd.askModeCount += typeof entity.askModeCount === "number" ? entity.askModeCount : 0;
          fd.editModeCount += typeof entity.editModeCount === "number" ? entity.editModeCount : 0;
          fd.agentModeCount += typeof entity.agentModeCount === "number" ? entity.agentModeCount : 0;
          fd.planModeCount += typeof entity.planModeCount === "number" ? entity.planModeCount : 0;
          fd.customAgentModeCount += typeof entity.customAgentModeCount === "number" ? entity.customAgentModeCount : 0;
          fd.cliModeCount += typeof entity.cliModeCount === "number" ? entity.cliModeCount : 0;
          if (entity.toolCallsJson) {
            try {
              const tc = JSON.parse(entity.toolCallsJson);
              fd.toolCallsTotal += tc.total ?? 0;
              for (const [tool, count] of Object.entries(tc.byTool ?? {})) {
                fd.toolCallsByTool[tool] = (fd.toolCallsByTool[tool] ?? 0) + Number(count);
              }
            } catch { /* ignore malformed JSON */ }
          }
          if (entity.contextRefsJson) {
            try {
              const cr = JSON.parse(entity.contextRefsJson);
              fd.ctxFile += cr.file ?? 0;
              fd.ctxSelection += cr.selection ?? 0;
              fd.ctxSymbol += cr.symbol ?? 0;
              fd.ctxCodebase += cr.codebase ?? 0;
              fd.ctxWorkspace += cr.workspace ?? 0;
              fd.ctxTerminal += cr.terminal ?? 0;
              fd.ctxVscode += cr.vscode ?? 0;
              fd.ctxClipboard += cr.clipboard ?? 0;
              fd.ctxChanges += cr.changes ?? 0;
              fd.ctxProblemsPanel += cr.problemsPanel ?? 0;
              fd.ctxOutputPanel += cr.outputPanel ?? 0;
              fd.ctxTerminalLastCommand += cr.terminalLastCommand ?? 0;
              fd.ctxTerminalSelection += cr.terminalSelection ?? 0;
              for (const [kind, count] of Object.entries(cr.byKind ?? {})) {
                fd.ctxByKind[kind] = (fd.ctxByKind[kind] ?? 0) + Number(count);
              }
            } catch { /* ignore malformed JSON */ }
          }
          if (entity.mcpToolsJson) {
            try {
              const mcp = JSON.parse(entity.mcpToolsJson);
              fd.mcpTotal += mcp.total ?? 0;
              for (const [server, data] of Object.entries(mcp.byServer ?? {})) {
                fd.mcpByServer[server] = (fd.mcpByServer[server] ?? 0) + Number((data as { total?: number })?.total ?? data ?? 0);
              }
            } catch { /* ignore malformed JSON */ }
          }
          if (entity.modelSwitchingJson) {
            try {
              const ms = JSON.parse(entity.modelSwitchingJson);
              fd.mixedTierSessions += ms.mixedTierSessions ?? 0;
              if (typeof ms.switchingFrequency === "number") {
                fd.switchingFreqSum += ms.switchingFrequency;
                fd.switchingFreqCount++;
              }
              for (const m of ms.standardModels ?? []) { fd.standardModels.add(m as string); }
              for (const m of ms.premiumModels ?? []) { fd.premiumModels.add(m as string); }
            } catch { /* ignore malformed JSON */ }
          }
          if (entity.editScopeJson) {
            try {
              const es = JSON.parse(entity.editScopeJson);
              fd.multiFileEdits += es.multiFileEdits ?? 0;
              if (typeof es.avgFilesPerSession === "number" && es.avgFilesPerSession > 0) {
                fd.filesPerEditSum += es.avgFilesPerSession;
                fd.filesPerEditCount++;
              }
            } catch { /* ignore malformed JSON */ }
          }
          if (entity.agentTypesJson) {
            try {
              const at = JSON.parse(entity.agentTypesJson);
              fd.editsAgentCount += at.editsAgent ?? 0;
              fd.workspaceAgentCount += at.workspaceAgent ?? 0;
            } catch { /* ignore malformed JSON */ }
          }
          if (entity.repositoriesJson) {
            try {
              const rj = JSON.parse(entity.repositoriesJson);
              for (const r of rj.repositories ?? []) { fd.repositories.add(r as string); }
              for (const r of rj.repositoriesWithCustomization ?? []) { fd.repositoriesWithCustomization.add(r as string); }
            } catch { /* ignore malformed JSON */ }
          }
          if (entity.applyUsageJson) {
            try {
              const au = JSON.parse(entity.applyUsageJson);
              if (typeof au.applyRate === "number") {
                fd.applyRateSum += au.applyRate;
                fd.applyRateCount++;
              }
            } catch { /* ignore malformed JSON */ }
          }
          if (typeof entity.multiTurnSessions === "number") { fd.multiTurnSessions += entity.multiTurnSessions; }
          if (typeof entity.avgTurnsPerSession === "number" && entity.avgTurnsPerSession > 0) {
            fd.turnsPerSessionSum += entity.avgTurnsPerSession;
            fd.turnsPerSessionCount++;
          }
          if (typeof entity.sessionCount === "number") { fd.sessionCount += entity.sessionCount; }
          if (entity.sessionDurationJson) {
            try {
              const sd = JSON.parse(entity.sessionDurationJson);
              if (typeof sd.avgDurationMs === "number" && sd.avgDurationMs > 0) {
                fd.durationMsSum += sd.avgDurationMs;
                fd.durationMsCount++;
              }
            } catch { /* ignore malformed JSON */ }
          }
        }
      }
    }

    // Calculate costs
    const personalCost = this.calculateEstimatedCost(personalModelUsage);

    // For team members, use a simplified cost estimate since we don't track
    // per-user model usage in aggregated data yet.
    // The personal cost uses the accurate model-aware calculation.
    for (const [userId, userData] of userMap.entries()) {
      userData.cost = (userData.tokens / 1000000) * 0.05;
    }

    // Build team leaderboard grouped by dataset
    const teamMembers = Array.from(userMap.entries())
      .map(([userKey, data]) => {
        const [userId, datasetId] = userKey.split("|");
        const sessionCount = data.sessions.size;
        const avgTurnsPerSession =
          sessionCount > 0 ? Math.round(data.interactions / sessionCount) : 0;
        const avgTokensPerTurn =
          data.interactions > 0
            ? Math.round(data.tokens / data.interactions)
            : 0;
        const fluencyData = userFluencyMap.get(userKey);
        const fluencyScore = fluencyData ? _calculateFluencyScoreForTeamMember(fluencyData, sessionCount) : undefined;
        return {
          userId,
          datasetId,
          totalTokens: data.tokens,
          totalInteractions: data.interactions,
          totalCost: data.cost,
          sessions: sessionCount,
          avgTurnsPerSession,
          uniqueModels: data.models.size,
          uniqueWorkspaces: data.workspaces.size,
          daysActive: data.days.size,
          avgTokensPerTurn,
          rank: 0,
          ...(fluencyScore ? {
            fluencyStage: fluencyScore.stage,
            fluencyLabel: fluencyScore.label,
            fluencyCategories: fluencyScore.categories,
          } : {}),
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((member, index) => ({
        ...member,
        rank: index + 1,
      }));

    const teamTotalTokens = Array.from(userMap.values()).reduce(
      (sum, u) => sum + u.tokens,
      0,
    );
    const teamTotalInteractions = Array.from(userMap.values()).reduce(
      (sum, u) => sum + u.interactions,
      0,
    );
    const averageTokensPerUser =
      userMap.size > 0 ? teamTotalTokens / userMap.size : 0;

    this.log(
      `[Dashboard] Date range: ${firstDate} to ${lastDate} (${teamMembers.length} team members)`,
    );
    this.log(
      `[Dashboard] Personal stats: ${personalTotalTokens} tokens, ${personalTotalInteractions} interactions, ${personalDevices.size} devices, ${personalWorkspaces.size} workspaces`,
    );

    // Log each user's aggregated data for debugging
    for (const [userKey, data] of userMap.entries()) {
      const [userId, datasetId] = userKey.split("|");
      this.log(
        `[Dashboard] User "${userId}" (dataset: ${datasetId}): ${data.tokens} tokens, ${data.interactions} interactions`,
      );
    }

    // For the current user, override the fluency score with the locally-computed one.
    // Azure Table Storage only contains recently-synced schema-v4 entities (a small window),
    // while calculateMaturityScores() uses the full local session log history.
    // When includeUserDimension is false, the team member key is "machine:<machineId>".
    const currentTeamMemberKey = currentUserId
      ? currentUserId
      : currentMachineId ? `machine:${currentMachineId}` : "";
    if (currentTeamMemberKey) {
      try {
        const localMaturity = await this.calculateMaturityScores(true);
        for (const member of teamMembers) {
          if (member.userId === currentTeamMemberKey) {
            member.fluencyStage = localMaturity.overallStage;
            member.fluencyLabel = localMaturity.overallLabel;
            member.fluencyCategories = localMaturity.categories.map(c => ({
              category: c.category,
              icon: c.icon,
              stage: c.stage,
              tips: c.tips,
            }));
            break;
          }
        }
      } catch {
        // Non-critical: leave whatever fluency score was already computed
      }
    }

    // Fetch local stats to surface the sync coverage gap in the dashboard.
    // Use the same lookback window as the backend so the comparison is apples-to-apples.
    let localTokens: number | undefined;
    let localInteractions: number | undefined;
    try {
      const { dailyStats: freshDailyStats } = await this.calculateDetailedStats(undefined); // ensures lastDailyStats is fresh
      this.lastDailyStats = freshDailyStats;
      const lookback = settings.lookbackDays ?? 30;
      // Always derive exact counts from daily stats so we avoid the rounding loss introduced
      // by avgInteractionsPerSession = Math.round(interactions / sessions).
      // lastDailyStats covers the last 30 days; for longer windows it is the best available data.
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - lookback);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);
      const dailyStats = this.lastDailyStats ?? [];
      const inWindow = dailyStats.filter(d => d.date >= cutoffStr);
      localTokens = inWindow.reduce((sum, d) => sum + d.tokens, 0);
      localInteractions = inWindow.reduce((sum, d) => sum + d.interactions, 0);
    } catch {
      // Non-critical: leave undefined
    }

    return {
      personal: {
        userId: currentUserId || "",
        totalTokens: personalTotalTokens,
        totalInteractions: personalTotalInteractions,
        totalCost: personalCost,
        devices: Array.from(personalDevices),
        workspaces: Array.from(personalWorkspaces),
        modelUsage: personalModelUsage,
        localTokens,
        localInteractions,
      },
      team: {
        members: teamMembers,
        totalTokens: teamTotalTokens,
        totalInteractions: teamTotalInteractions,
        averageTokensPerUser,
        firstDate,
        lastDate,
      },
      lookbackDays: settings.lookbackDays,
      lastUpdated: new Date().toISOString(),
    };
  }
  private getDashboardHtml(
    webview: vscode.Webview,
    data: any | undefined,
  ): string {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "dashboard.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const dataWithBackend = data
      ? { ...data, backendConfigured: this.isBackendConfigured(), compactNumbers: this.getCompactNumbersSetting() }
      : undefined;
    const initialDataScript = dataWithBackend
      ? `<script nonce="${nonce}">window.__INITIAL_DASHBOARD__ = ${JSON.stringify(dataWithBackend).replace(/</g, "\\u003c")};</script>`
      : "";

    return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Team Dashboard</title>
		</head>
		<body>
			<div id="root"></div>
			${initialDataScript}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  private getNonce(): string {
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let text = "";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Check if backend sync is configured for Team Dashboard access.
   */
  private isBackendConfigured(): boolean {
    if (!this.backend) {
      return false;
    }
    const settings = this.backend.getSettings();
    return this.backend.isConfigured(settings);
  }

  private getDetailsHtml(
    webview: vscode.Webview,
    stats: DetailedStats,
  ): string {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "details.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const sortSettings = this.context.globalState.get('details.sortSettings', {
      editor: { key: 'name', dir: 'asc' },
      model: { key: 'name', dir: 'asc' },
    });
    const dataWithBackend = {
      ...stats,
      backendConfigured: this.isBackendConfigured(),
      sortSettings,
      compactNumbers: this.getCompactNumbersSetting(),
      copilotPlan: this._copilotPlanResolved,
    };
    const initialData = JSON.stringify(dataWithBackend).replace(
      /</g,
      "\\u003c",
    );

    return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>AI Engineering Fluency</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DETAILS__ = ${initialData};</script>
			${this.getLocalViewRegressionProbeScript('details', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  public async generateDiagnosticReport(): Promise<string> {
    this.log("Generating diagnostic report...");

    const report: string[] = [];

    // Header
    report.push("=".repeat(70));
    report.push("AI Engineering Fluency - Diagnostic Report");
    report.push("=".repeat(70));
    report.push("");

    // Extension Information
    report.push("## Extension Information");
    report.push(
      `Extension Version: ${vscode.extensions.getExtension("RobBos.copilot-token-tracker")?.packageJSON.version || "Unknown"}`,
    );
    report.push(`VS Code Version: ${vscode.version}`);
    report.push("");

    // System Information
    report.push("## System Information");
    report.push(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);
    report.push(`Node Version: ${process.version}`);
    report.push(`Home Directory: ${os.homedir()}`);
    report.push(
      `Environment: ${process.env.CODESPACES === "true" ? "GitHub Codespaces" : vscode.env.remoteName || "Local"}`,
    );
    report.push(`VS Code Machine ID: ${vscode.env.machineId}`);
    report.push(`VS Code Session ID: ${vscode.env.sessionId}`);
    report.push(
      `VS Code UI Kind: ${vscode.env.uiKind === vscode.UIKind.Desktop ? "Desktop" : "Web"}`,
    );
    report.push(`Remote Name: ${vscode.env.remoteName || "N/A"}`);
    report.push("");

    // GitHub Copilot Extension Status
    report.push("## GitHub Copilot Extension Status");
    const copilotExtension = vscode.extensions.getExtension("GitHub.copilot");
    const copilotChatExtension = vscode.extensions.getExtension(
      "GitHub.copilot-chat",
    );

    if (copilotExtension) {
      report.push(`GitHub Copilot Extension:`);
      report.push(`  - Installed: Yes`);
      report.push(`  - Version: ${copilotExtension.packageJSON.version}`);
      report.push(`  - Active: ${copilotExtension.isActive ? "Yes" : "No"}`);

      // Try to get Copilot tier information if available
      try {
        const copilotApi = copilotExtension.exports;
        if (copilotApi && copilotApi.status) {
          const status = copilotApi.status;
          // Display key status fields in a readable format
          if (typeof status === "object") {
            Object.keys(status).forEach((key) => {
              const value = status[key];
              if (value !== undefined && value !== null) {
                report.push(`  - ${key}: ${value}`);
              }
            });
          } else {
            report.push(`  - Status: ${status}`);
          }
        }
      } catch (error) {
        this.log(`Could not retrieve Copilot tier information: ${error}`);
      }
    } else {
      report.push(`GitHub Copilot Extension: Not Installed`);
    }

    if (copilotChatExtension) {
      report.push(`GitHub Copilot Chat Extension:`);
      report.push(`  - Installed: Yes`);
      report.push(`  - Version: ${copilotChatExtension.packageJSON.version}`);
      report.push(
        `  - Active: ${copilotChatExtension.isActive ? "Yes" : "No"}`,
      );
    } else {
      report.push(`GitHub Copilot Chat Extension: Not Installed`);
    }
    report.push("");

    // Session Files Discovery
    report.push("## Session Files Discovery");
    try {
      const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
      report.push(`Total Session Files Found: ${sessionFiles.length}`);
      report.push("");

      if (sessionFiles.length > 0) {
        report.push("Session File Locations (first 20):");

        // Use async file stat to avoid blocking the event loop
        const filesToShow = sessionFiles.slice(0, 20);
        const fileStats = await Promise.all(
          filesToShow.map(async (file) => {
            try {
              const stat = await fs.promises.stat(file);
              return { file, stat, error: null };
            } catch (error) {
              return { file, stat: null, error };
            }
          }),
        );

        fileStats.forEach((result, index) => {
          if (result.stat) {
            report.push(`  ${index + 1}. ${result.file}`);
            report.push(`     - Size: ${result.stat.size} bytes`);
            report.push(`     - Modified: ${result.stat.mtime.toISOString()}`);
          } else {
            report.push(`  ${index + 1}. ${result.file}`);
            report.push(`     - Error: ${result.error}`);
          }
        });

        if (sessionFiles.length > 20) {
          report.push(`  ... and ${sessionFiles.length - 20} more files`);
        }
      } else {
        report.push("No session files found. Possible reasons:");
        report.push("  - Copilot extensions are not active");
        report.push("  - No Copilot Chat conversations have been initiated");
        report.push("  - Sessions stored in unsupported location");
        report.push("  - Authentication required with GitHub Copilot");
        if (vscode.env.remoteName === "wsl") {
          report.push("");
          report.push("WSL note: the extension host runs inside WSL and scans both the");
          report.push("  Linux-side ~/.vscode-server paths and the Windows-side");
          report.push("  /mnt/c/Users/<you>/AppData/Roaming/Code paths.");
          report.push("  If /mnt/c is not mounted, Windows-side sessions cannot be read.");
        }
      }
      report.push("");
    } catch (error) {
      report.push(`Error discovering session files: ${error}`);
      report.push("");
    }

    // Cache Statistics
    report.push("## Cache Statistics");
    report.push(`Cached Session Files: ${this.cacheManager.cache.size}`);
    report.push(`Cache Storage: Extension Global State`);
    report.push("");
    report.push(
      "Cache provides faster loading by storing parsed session data with file modification timestamps.",
    );
    report.push(
      "Files are only re-parsed when their modification time changes.",
    );
    report.push("");

    // Token Statistics
    report.push("## Token Usage Statistics");
    try {
      // Use cached session files to avoid redundant scans during diagnostic report generation
      // DO NOT call calculateDetailedStats here - it triggers expensive re-analysis
      // The loadDiagnosticDataInBackground method ensures stats are calculated if needed
      try {
        const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
        report.push(`Total Session Files Found: ${sessionFiles.length}`);
        report.push("");

        // Group session files by their parent directory
        const dirCounts = new Map<string, number>();
        for (const file of sessionFiles) {
          const parent = require("path").dirname(file);
          dirCounts.set(parent, (dirCounts.get(parent) || 0) + 1);
        }
        if (dirCounts.size > 0) {
          report.push("Session Files by Directory:");
          for (const [dir, count] of dirCounts.entries()) {
            report.push(`  ${dir}: ${count}`);
          }
          report.push("");
        }

        if (sessionFiles.length > 0) {
          report.push("Session File Locations (first 20):");
          const filesToShow = sessionFiles.slice(0, 20);
          const fileStats = await Promise.all(
            filesToShow.map(async (file) => {
              try {
                const stat = await fs.promises.stat(file);
                return { file, stat, error: null };
              } catch (error) {
                return { file, stat: null, error };
              }
            }),
          );
          fileStats.forEach((result, index) => {
            if (result.stat) {
              report.push(`  ${index + 1}. ${result.file}`);
              report.push(`     - Size: ${result.stat.size} bytes`);
              report.push(
                `     - Modified: ${result.stat.mtime.toISOString()}`,
              );
            } else {
              report.push(`  ${index + 1}. ${result.file}`);
              report.push(`     - Error: ${result.error}`);
            }
          });
          if (sessionFiles.length > 20) {
            report.push(`  ... and ${sessionFiles.length - 20} more files`);
          }
        } else {
          report.push("No session files found. Possible reasons:");
          report.push("  - Copilot extensions are not active");
          report.push("  - No Copilot Chat conversations have been initiated");
          report.push("  - Sessions stored in unsupported location");
          report.push("  - Authentication required with GitHub Copilot");
          if (vscode.env.remoteName === "wsl") {
            report.push("");
            report.push("WSL note: the extension host runs inside WSL and scans both the");
            report.push("  Linux-side ~/.vscode-server paths and the Windows-side");
            report.push("  /mnt/c/Users/<you>/AppData/Roaming/Code paths.");
            report.push("  If /mnt/c is not mounted, Windows-side sessions cannot be read.");
          }
        }
        report.push("");
      } catch (error) {
        report.push(`Error discovering session files: ${error}`);
        report.push("");
      }
    } catch (error) {
      report.push(`Error calculating token usage statistics: ${error}`);
      report.push("");
    }

    // Footer
    report.push("=".repeat(70));
    report.push(`Report Generated: ${new Date().toISOString()}`);
    report.push("=".repeat(70));
    report.push("");
    report.push(
      "This report can be shared with the extension maintainers to help",
    );
    report.push(
      "troubleshoot issues. No sensitive data from your code is included.",
    );
    report.push("");
    report.push("Submit issues at:");
    report.push(`${this.getRepositoryUrl()}/issues`);

    const fullReport = report.join("\n");
    this.log("Diagnostic report generated successfully");
    return fullReport;
  }

  public async showDiagnosticReport(): Promise<void> {
    this.log("🔍 Opening Diagnostic Report");

    // If panel already exists, just reveal it and trigger a refresh in the background
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.reveal();
      this.log("🔍 Diagnostic Report revealed (already exists)");
      // Load data in background and update the webview
      this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
      return;
    }

    // Create the panel immediately with loading state
    this.diagnosticsPanel = vscode.window.createWebviewPanel(
      "copilotTokenDiagnostics",
      "Diagnostic Report",
      {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep webview context to avoid reloading session files
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
        ],
      },
    );

    this.log("✅ Diagnostic Report panel created");

    // Handle messages from the webview
    this.diagnosticsPanel.webview.onDidReceiveMessage(async (message) => {
      if (this.handleLocalViewRegressionMessage(message)) { return; }
      if (await this.dispatchSharedCommand(message.command)) { return; }
      switch (message.command) {
        case "copyReport":
          await this.dispatch('copyReport:diagnostics', async () => {
            await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
            vscode.window.showInformationMessage(
              "Diagnostic report copied to clipboard",
            );
          });
          break;
        case "openIssue":
          await this.dispatch('openIssue:diagnostics', async () => {
            await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
            vscode.window.showInformationMessage(
              "Diagnostic report copied to clipboard. Please paste it into the GitHub issue.",
            );
            const shortBody = encodeURIComponent(
              "The diagnostic report has been copied to the clipboard. Please paste it below.",
            );
          const issueUrl = `${this.getRepositoryUrl()}/issues/new?body=${shortBody}`;
            await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
          });
          break;
        case "reportNewEditorPath":
          if (message.path) {
            await this.dispatch('reportNewEditorPath:diagnostics', async () => {
              const rawPath: string = message.path;
              const home = os.homedir();
              const anonymizedPath = rawPath.startsWith(home) ? rawPath.replace(home, '~') : rawPath;
              const title = encodeURIComponent('New editor support: unknown session path found');
              const body = encodeURIComponent([
                '## Unknown editor session path found',
                '',
                'The extension found a session file at a path it does not recognise:',
                '',
                '```',
                anonymizedPath,
                '```',
                '',
                '**Which editor or tool does this path belong to?**',
                '',
                'Please describe the editor/tool and how you installed it so we can add support for it.',
              ].join('\n'));
              const issueUrl = `${this.getRepositoryUrl()}/issues/new?title=${title}&body=${body}&labels=${encodeURIComponent('new-editor-support')}`;
              await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
            });
          }
          break;
        case "openSessionFile":
          if (message.file) {
            await this.dispatch('openSessionFile:diagnostics', async () => {
              try {
                // Open the session file in the log viewer
                await this.showLogViewer(message.file);
              } catch (err) {
                vscode.window.showErrorMessage(
                  "Could not open log viewer: " + message.file,
                );
              }
            });
          }
          break;

        case "openFormattedJsonlFile":
          if (message.file) {
            await this.dispatch('openFormattedJsonlFile:diagnostics', async () => {
              try {
                await this.showFormattedJsonlFile(message.file);
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(
                  "Could not open formatted file: " +
                    message.file +
                    " (" +
                    errorMsg +
                    ")",
                );
              }
            });
          }
          break;

        case "revealPath":
          if (message.path) {
            await this.dispatch('revealPath:diagnostics', async () => {
              try {
                const fs = require("fs");
                const pathModule = require("path");
                const normalized = pathModule.normalize(message.path);

                // If the path exists and is a directory, open it directly in the OS file manager.
                // Using `vscode.env.openExternal` with a file URI reliably opens the folder itself.
                try {
                  const stat = await fs.promises.stat(normalized);
                  if (stat.isDirectory()) {
                    await vscode.env.openExternal(vscode.Uri.file(normalized));
                  } else {
                    // For files, reveal the file in OS (select it)
                    await vscode.commands.executeCommand(
                      "revealFileInOS",
                      vscode.Uri.file(normalized),
                    );
                  }
                } catch (err) {
                  // If the stat fails, fallback to revealFileInOS which may still work
                  await vscode.commands.executeCommand(
                    "revealFileInOS",
                    vscode.Uri.file(normalized),
                  );
                }
              } catch (err) {
                vscode.window.showErrorMessage(
                  "Could not reveal: " + message.path,
                );
              }
            });
          }
          break;
        case "clearCache":
          await this.dispatch('clearCache:diagnostics', async () => {
            this.log("clearCache message received from diagnostics webview");
            await this.clearCache();
            // After clearing cache, refresh the diagnostic report if it's open
            if (this.diagnosticsPanel) {
              // Send completion message to webview before refreshing
              this.diagnosticsPanel.webview.postMessage({
                command: "cacheCleared",
              });
              // Wait a moment for the message to be processed
              await new Promise((resolve) => setTimeout(resolve, 500));
              // Simply refresh the diagnostic report by revealing it again
              // This will trigger a rebuild with fresh data
              await this.showDiagnosticReport();
            }
          });
          break;
        case "configureBackend":
          await this.dispatch('configureBackend:diagnostics', async () => {
            // Execute the configureBackend command if it exists
            try {
              await vscode.commands.executeCommand(
                "aiEngineeringFluency.configureBackend",
              );
            } catch (err) {
              // If command is not registered, show settings
              vscode.window
                .showInformationMessage(
                  'Backend configuration is available in settings. Search for "AI Engineering Fluency: Backend" in settings.',
                  "Open Settings",
                )
                .then((choice) => {
                  if (choice === "Open Settings") {
                    vscode.commands.executeCommand(
                      "workbench.action.openSettings",
                      "aiEngineeringFluency.backend",
                    );
                  }
                });
            }
          });
          break;
        case "configureTeamServer":
          await this.dispatch('configureTeamServer:diagnostics', async () => {
            try {
              await vscode.commands.executeCommand(
                "aiEngineeringFluency.configureTeamServer",
              );
            } catch (err) {
              vscode.window
                .showInformationMessage(
                  'Team Server configuration is available in settings. Search for "AI Engineering Fluency: Backend" in settings.',
                  "Open Settings",
                )
                .then((choice) => {
                  if (choice === "Open Settings") {
                    vscode.commands.executeCommand(
                      "workbench.action.openSettings",
                      "aiEngineeringFluency.backend.sharingServer",
                    );
                  }
                });
            }
          });
          break;
        case "openSettings":
          await this.dispatch('openSettings:diagnostics', () =>
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "aiEngineeringFluency.backend",
            )
          );
          break;
        case "openDisplaySettings":
          await this.dispatch('openDisplaySettings:diagnostics', () =>
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "aiEngineeringFluency.display",
            )
          );
          break;
        case "resetDebugCounters":
          await this.dispatch('resetDebugCounters:diagnostics', async () => {
            await this.context.globalState.update('extension.openCount', 0);
            await this.context.globalState.update('extension.unknownMcpOpenCount', 0);
            await this.context.globalState.update('news.fluencyScoreBanner.v1.dismissed', false);
            await this.context.globalState.update('news.unknownMcpTools.dismissedVersion', undefined);
            vscode.window.showInformationMessage('Debug counters and dismissed flags have been reset.');
            await this.showDiagnosticReport();
          });
          break;
        case "setDebugCounter":
          if (typeof message.key === 'string' && typeof message.value === 'number') {
            await this.dispatch('setDebugCounter:diagnostics', async () => {
              await this.context.globalState.update(message.key, message.value);
              vscode.window.showInformationMessage(`Set ${message.key} = ${message.value}`);
              await this.showDiagnosticReport();
            });
          }
          break;
        case "setDebugFlag":
          if (typeof message.key === 'string' && typeof message.value === 'boolean') {
            await this.dispatch('setDebugFlag:diagnostics', async () => {
              await this.context.globalState.update(message.key, message.value);
              vscode.window.showInformationMessage(`Set ${message.key} = ${message.value}`);
              await this.showDiagnosticReport();
            });
          }
          break;
        case "authenticateGitHub":
          await this.dispatch('authenticateGitHub:diagnostics', async () => {
            await this.authenticateWithGitHub();
            if (this.diagnosticsPanel) {
              this.diagnosticsPanel.webview.postMessage({
                command: 'githubAuthUpdated',
                githubAuth: this.getGitHubAuthStatus(),
              });
            }
          });
          break;
        case "signOutGitHub":
          await this.dispatch('signOutGitHub:diagnostics', async () => {
            await this.signOutFromGitHub();
            if (this.diagnosticsPanel) {
              this.diagnosticsPanel.webview.postMessage({
                command: 'githubAuthUpdated',
                githubAuth: this.getGitHubAuthStatus(),
              });
            }
          });
          break;
        case "pickFolder":
          await this.dispatch('pickFolder:diagnostics', async () => {
            const uris = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              openLabel: "Select Folder to Analyze",
            });
            if (uris && uris.length > 0 && this.diagnosticsPanel && this.isPanelOpen(this.diagnosticsPanel)) {
              this.diagnosticsPanel.webview.postMessage({
                command: "folderPicked",
                folderPath: uris[0].fsPath,
              });
            }
          });
          break;
        case "analyzeFolder":
          await this.dispatch('analyzeFolder:diagnostics', async () => {
            const { folderPath, toolType } = message as { folderPath: string; toolType: string };
            if (!folderPath) {
              if (this.diagnosticsPanel && this.isPanelOpen(this.diagnosticsPanel)) {
                this.diagnosticsPanel.webview.postMessage({
                  command: "folderAnalysisResult",
                  error: "No folder path provided.",
                  files: [],
                  totalScanned: 0,
                  parseErrors: 0,
                  truncated: false,
                  folderPath: "",
                  toolType: toolType ?? "auto",
                });
              }
              return;
            }
            try {
              await fs.promises.access(folderPath);
            } catch {
              if (this.diagnosticsPanel && this.isPanelOpen(this.diagnosticsPanel)) {
                this.diagnosticsPanel.webview.postMessage({
                  command: "folderAnalysisResult",
                  error: `Folder not found or not accessible: ${folderPath}`,
                  files: [],
                  totalScanned: 0,
                  parseErrors: 0,
                  truncated: false,
                  folderPath,
                  toolType: toolType ?? "auto",
                });
              }
              return;
            }
            if (this.diagnosticsPanel) {
              await this.analyzeFolderPath(this.diagnosticsPanel, folderPath, toolType ?? "auto");
            }
          });
          break;
      }
    });

    // Set the HTML content immediately with loading state
    // Note: "Loading..." is the agreed contract between backend and frontend
    // The webview checks for this value to show a loading indicator
    this.diagnosticsPanel.webview.html = this.getDiagnosticReportHtml(
      this.diagnosticsPanel.webview,
      "Loading...", // Placeholder report
      [], // Empty session files
      [], // Empty detailed session files
      [], // Empty session folders
      null, // No backend info yet
    );

    // Handle panel disposal
    this.diagnosticsPanel.onDidDispose(() => {
      this.log("🔍 Diagnostic Report closed");
      this.diagnosticsPanel = undefined;
    });

    // Load data in background and update the webview when ready
    this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
  }

  /**
   * Load all diagnostic data in the background and update the webview progressively.
   */
  private async loadDiagnosticDataInBackground(
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    try {
      this.log("🔄 Loading diagnostic data in background...");

      // Ensure the startup GitHub session restore has completed before reading auth state
      if (this._sessionRestorePromise) {
        await this._sessionRestorePromise;
      }

      // CRITICAL: Ensure stats have been calculated at least once to populate cache
      // If this is the first diagnostic panel open and no stats exist yet,
      // force an update now so the cache is populated before we load session files.
      // This dramatically improves performance on first load (near 100% cache hit rate).
      if (!this.lastDetailedStats) {
        this.log(
          "⚡ No cached stats found - forcing initial stats calculation to populate cache...",
        );
        await this.updateTokenStats(true);
        this.log("✅ Cache populated, proceeding with diagnostics load");
      }

      // Load the diagnostic report
      const report = await this.generateDiagnosticReport();
      this.lastDiagnosticReport = report;

      // Get session files
      const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();

      // Get first 20 session files with stats (quick preview)
      const sessionFileData: {
        file: string;
        size: number;
        modified: string;
      }[] = [];
      for (const file of sessionFiles.slice(0, 20)) {
        try {
          const stat = await this.statSessionFile(file);
          sessionFileData.push({
            file,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch {
          // Skip inaccessible files
        }
      }

      // Build folder counts grouped by top-level VS Code user folder (editor roots)
      const dirCounts = new Map<string, number>();
      // Tracks friendly display names for eco-adapter directories so the directory
      // table shows "Claude Desktop Cowork" etc. instead of "Unknown".
      const dirEditorNames = new Map<string, string>();
      const pathModule = require("path");
      const copilotSessionStateDir = pathModule.join(
        os.homedir(),
        ".copilot",
        "session-state",
      );
      for (const file of sessionFiles) {
        // Handle virtual/adapter-owned paths (e.g. opencode.db#ses_<id>, crush.db#<uuid>)
        const eco = this.findEcosystem(file);
        if (eco) {
          const editorRoot = eco.getEditorRoot(file);
          dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
          dirEditorNames.set(editorRoot, eco.displayName);
          continue;
        }
        const parts = file.split(/[\\\/]/);
        const userIdx = parts.findIndex(
          (p: string) => p.toLowerCase() === "user",
        );
        let editorRoot = "";
        if (userIdx > 0) {
          const rootParts = parts.slice(0, Math.min(parts.length, userIdx + 2));
          editorRoot = pathModule.join(...rootParts);
        } else {
          editorRoot = pathModule.dirname(file);
        }
        // Group all CLI session-state subdirectories under the common parent
        if (
          editorRoot.startsWith(copilotSessionStateDir) &&
          editorRoot !== copilotSessionStateDir
        ) {
          editorRoot = copilotSessionStateDir;
        }
        dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
      }
      const sessionFolders = Array.from(dirCounts.entries()).map(
        ([dir, count]) => ({
          dir,
          count,
          editorName: dirEditorNames.get(dir) || this.getEditorNameFromRoot(dir),
        }),
      );

      // Build candidate paths list for diagnostics
      const candidatePaths = this.sessionDiscovery.getDiagnosticCandidatePaths();

      // Get backend storage info
      const backendStorageInfo = await this.getBackendStorageInfo();
      this.log(
        `Backend storage info retrieved: azure.enabled=${backendStorageInfo.azure?.enabled}, azure.configured=${backendStorageInfo.azure?.isConfigured}, teamServer.enabled=${backendStorageInfo.teamServer?.enabled}, teamServer.configured=${backendStorageInfo.teamServer?.isConfigured}`,
      );

      // Get GitHub authentication status
      const githubAuthStatus = this.getGitHubAuthStatus();

      // Check if panel is still open before updating
      if (!this.isPanelOpen(panel)) {
        this.log("Diagnostic panel closed during data load, aborting update");
        return;
      }

      // Send the loaded data to the webview
      this.log(
        `Sending backend info to webview: ${backendStorageInfo ? "present" : "missing"}`,
      );
      panel.webview.postMessage({
        command: "diagnosticDataLoaded",
        report,
        sessionFiles: sessionFileData,
        sessionFolders,
        candidatePaths,
        backendStorageInfo,
        githubAuth: githubAuthStatus,
      });

      this.log("✅ Diagnostic data loaded and sent to webview");

      // Now load detailed session files in the background
      this.loadSessionFilesInBackground(panel, sessionFiles);
    } catch (error) {
      this.error(`Failed to load diagnostic data: ${error}`);
      // Send error to webview if panel is still open
      if (this.isPanelOpen(panel)) {
        panel.webview.postMessage({
          command: "diagnosticDataError",
          error: String(error),
        });
      }
    }
  }

  /**
   * Check if a webview panel is still open and accessible.
   * A panel is considered open if its viewColumn is defined.
   */
  private isPanelOpen(panel: vscode.WebviewPanel): boolean {
    return panel.viewColumn !== undefined;
  }

  /**
   * Load session file details in the background and send to webview.
   */
  private async loadSessionFilesInBackground(
    panel: vscode.WebviewPanel,
    sessionFiles: string[],
  ): Promise<void> {
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const detailedSessionFiles: SessionFileDetails[] = [];

    // Track cache performance for this load operation
    const initialCacheHits = this._cacheHits;
    const initialCacheMisses = this._cacheMisses;

    // Sort files by modification time (most recent first) before taking first 500
    // This ensures we prioritize recent sessions regardless of their folder location
    const fileStats = await Promise.all(
      sessionFiles.map(async (file) => {
        try {
          const stat = await this.statSessionFile(file);
          return { file, mtime: stat.mtime.getTime() };
        } catch {
          return { file, mtime: 0 };
        }
      }),
    );

    const sortedFiles = fileStats
      .sort((a, b) => b.mtime - a.mtime)
      .map((item) => item.file);

    // Process up to 500 most recent session files
    for (const file of sortedFiles.slice(0, 500)) {
      // Check if panel was disposed
      if (!this.isPanelOpen(panel)) {
        this.log("Diagnostic panel closed, stopping background load");
        return;
      }

      try {
        const details = await this.getSessionFileDetails(file);
        // Only include sessions with activity (lastInteraction or file modified time) within the last x days
        const lastActivity = details.lastInteraction
          ? new Date(details.lastInteraction)
          : new Date(details.modified);
        if (lastActivity >= fourteenDaysAgo) {
          detailedSessionFiles.push(details);
        }
      } catch {
        // Skip inaccessible files
      }
    }

    // Send the loaded data to the webview
    try {
      // Cache the loaded session files so we can re-send if the webview is recreated
      if (panel === this.diagnosticsPanel) {
        this.diagnosticsCachedFiles = detailedSessionFiles;
      }
      // Log summary stats
      const withRepo = detailedSessionFiles.filter((s) => s.repository).length;
      this.log(
        `📊 Sending ${detailedSessionFiles.length} sessions to diagnostics (${withRepo} with repository info)`,
      );
      await panel.webview.postMessage({
        command: "sessionFilesLoaded",
        detailedSessionFiles,
      });

      // Calculate and log cache performance for this operation
      const cacheHits = this._cacheHits - initialCacheHits;
      const cacheMisses = this._cacheMisses - initialCacheMisses;
      const totalAccesses = cacheHits + cacheMisses;
      const hitRate =
        totalAccesses > 0
          ? ((cacheHits / totalAccesses) * 100).toFixed(1)
          : "0.0";

      this.log(
        `Loaded ${detailedSessionFiles.length} session files in background (Cache: ${cacheHits} hits, ${cacheMisses} misses, ${hitRate}% hit rate)`,
      );

      // Mark diagnostics as loaded so we don't reload unnecessarily
      if (panel === this.diagnosticsPanel) {
        this.diagnosticsHasLoadedFiles = true;
      }
    } catch (err) {
      // Panel may have been disposed
      this.log("Could not send session files to panel (may be closed)");
    }
  }

  /**
   * Analyze a custom folder for session files belonging to any of the supported AI tools.
   * Scans recursively up to depth 5, max 500 files.
   * Does NOT touch the cache — reads each file once and calls countInteractionsInSession
   * and estimateTokensFromSession directly with preloaded content.
   */
  private async analyzeFolderPath(
    panel: vscode.WebviewPanel,
    folderPath: string,
    toolType: string,
  ): Promise<void> {
    const MAX_FILES = 500;
    const MAX_DEPTH = 5;

    // Determine which extensions to accept
    const jsonOnly = ["claude-code"];
    const jsonlOnly = ["continue", "opencode", "mistral-vibe", "claude-desktop"];
    let allowJson = true;
    let allowJsonl = true;
    if (jsonOnly.includes(toolType)) {
      allowJson = false;
      allowJsonl = true;
    } else if (jsonlOnly.includes(toolType)) {
      allowJson = true;
      allowJsonl = false;
    }

    const results: Array<{
      file: string;
      size: number;
      modified: string;
      interactions: number;
      tokens: number;
      actualTokens: number;
    }> = [];
    let totalScanned = 0;
    let parseErrors = 0;
    let truncated = false;

    // Recursive scan helper
    const scan = async (dir: string, depth: number): Promise<void> => {
      if (totalScanned >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (depth > MAX_DEPTH) { return; }

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (totalScanned >= MAX_FILES) {
          truncated = true;
          break;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full, depth + 1);
        } else if (entry.isFile()) {
          const isJson = entry.name.endsWith(".json");
          const isJsonl = entry.name.endsWith(".jsonl");
          if ((isJson && allowJson) || (isJsonl && allowJsonl)) {
            totalScanned++;

            let stat: fs.Stats;
            try {
              stat = await fs.promises.stat(full);
            } catch {
              parseErrors++;
              continue;
            }

            let content: string;
            try {
              content = await fs.promises.readFile(full, "utf8");
            } catch {
              parseErrors++;
              results.push({
                file: full,
                size: stat.size,
                modified: stat.mtime.toISOString(),
                interactions: 0,
                tokens: 0,
                actualTokens: 0,
              });
              continue;
            }

            const interactions = await this.countInteractionsInSession(full, content);
            const tokenResult = await this.estimateTokensFromSession(full, content);

            results.push({
              file: full,
              size: stat.size,
              modified: stat.mtime.toISOString(),
              interactions,
              tokens: tokenResult.tokens,
              actualTokens: tokenResult.actualTokens,
            });
          }
        }
      }
    };

    await scan(folderPath, 0);

    if (this.isPanelOpen(panel)) {
      panel.webview.postMessage({
        command: "folderAnalysisResult",
        files: results,
        totalScanned,
        parseErrors,
        truncated,
        folderPath,
        toolType,
      });
    }
  }

  /**
   * Get backend storage information for diagnostics
   */
  private async getBackendStorageInfo(): Promise<any> {
    const config = vscode.workspace.getConfiguration("aiEngineeringFluency");
    // Use the authoritative settings object so isConfigured uses the same logic as the sync engine
    const settings = this.backend?.getSettings();

    // Azure Storage settings
    const azureEnabled = settings?.enabled ?? false;
    const storageAccount = settings?.storageAccount ?? "";
    const subscriptionId = settings?.subscriptionId ?? "";
    const resourceGroup = settings?.resourceGroup ?? "";
    const aggTable = settings?.aggTable ?? "usageAggDaily";
    const eventsTable = settings?.eventsTable ?? "usageEvents";
    const authMode = settings?.authMode ?? "entraId";
    const sharingProfile = config.get<string>("backend.sharingProfile", "off");
    // Team Server settings
    const sharingServerEnabled = settings?.sharingServerEnabled ?? false;
    const sharingServerEndpointUrl = settings?.sharingServerEndpointUrl ?? "";

    // Use the same isConfigured logic as the sync engine
    const azureIsConfigured = settings ? this.backend!.isConfigured(settings) : false;
    const teamServerIsConfigured = sharingServerEnabled && !!sharingServerEndpointUrl;

    // Get last sync time from global state
    const lastSyncAt = this.context.globalState.get<number>("backend.lastSyncAt");
    const lastSyncTime = lastSyncAt ? new Date(lastSyncAt).toISOString() : null;

    // Get unique device count from session files (estimate based on unique workspace roots)
    const sessionFiles = await this.sessionDiscovery.getCopilotSessionFiles();
    const workspaceIds = new Set<string>();

    for (const file of sessionFiles) {
      const parts = file.split(/[\\\/]/);
      const workspaceStorageIdx = parts.findIndex(
        (p) => p.toLowerCase() === "workspacestorage",
      );
      if (workspaceStorageIdx >= 0 && workspaceStorageIdx < parts.length - 1) {
        const workspaceId = parts[workspaceStorageIdx + 1];
        if (workspaceId && workspaceId.length > 10) {
          workspaceIds.add(workspaceId);
        }
      }
    }

    return {
      azure: {
        enabled: azureEnabled,
        isConfigured: azureIsConfigured,
        storageAccount,
        subscriptionId: subscriptionId ? subscriptionId.substring(0, 8) + "..." : "",
        resourceGroup,
        aggTable,
        eventsTable,
        authMode,
        sharingProfile,
        lastSyncTime: azureEnabled ? lastSyncTime : null,
        deviceCount: workspaceIds.size,
        sessionCount: sessionFiles.length,
        recordCount: null,
      },
      teamServer: {
        enabled: sharingServerEnabled,
        isConfigured: teamServerIsConfigured,
        endpointUrl: sharingServerEndpointUrl,
        sharingProfile,
        lastSyncTime: sharingServerEnabled ? lastSyncTime : null,
        sessionCount: sessionFiles.length,
      },
    };
  }

  private getDiagnosticReportHtml(
    webview: vscode.Webview,
    report: string,
    sessionFiles: { file: string; size: number; modified: string }[],
    detailedSessionFiles: SessionFileDetails[],
    sessionFolders: { dir: string; count: number }[] = [],
    backendStorageInfo: any = null,
  ): string {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "dist",
        "webview",
        "diagnostics.js",
      ),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Get cache information
    let cacheSizeInMB = 0;
    try {
      // Estimate cache size by serializing to JSON
      const cacheData = Object.fromEntries(this.cacheManager.cache);
      const jsonString = JSON.stringify(cacheData);
      cacheSizeInMB = (jsonString.length * 2) / (1024 * 1024); // UTF-16 encoding (2 bytes per char)
    } catch {
      cacheSizeInMB = 0;
    }

    // Try to read the persisted cache from VS Code global state to show its actual storage status
    let persistedCacheSummary = "Not found in VS Code Global State";
    try {
      const persisted =
        this.context.globalState.get<Record<string, SessionFileCache>>(
          "sessionFileCache",
        );
      if (persisted && typeof persisted === "object") {
        const count = Object.keys(persisted).length;
        persistedCacheSummary = `VS Code Global State - sessionFileCache (${count} entr${count === 1 ? "y" : "ies"})`;
      }
    } catch (e) {
      persistedCacheSummary = "Error reading VS Code Global State";
    }

    // Try to locate the actual storage file (state DB) for the extension global state
    let storageFilePath: string | null = null;
    try {
      const extensionId = "RobBos.copilot-token-tracker";
      const userPaths = getVSCodeUserPaths();
      for (const userPath of userPaths) {
        try {
          const candidate = path.join(userPath, "globalStorage", extensionId);
          if (fs.existsSync(candidate)) {
            const files = fs.readdirSync(candidate);
            // Look for likely state files
            const match = files.find(
              (f) =>
                f.includes("state") ||
                f.endsWith(".vscdb") ||
                f.endsWith(".json"),
            );
            if (match) {
              storageFilePath = path.join(candidate, match);
              break;
            }
          }
        } catch (e) {
          // ignore path access errors
        }
      }
    } catch (e) {
      // ignore
    }

    const cacheInfo = {
      size: this.cacheManager.cache.size,
      sizeInMB: cacheSizeInMB,
      lastUpdated:
        this.cacheManager.cache.size > 0 ? new Date().toISOString() : null,
      location: persistedCacheSummary,
      storagePath: storageFilePath,
    };

    const inspector = require('inspector') as { url(): string | undefined };
    const isDebugMode = inspector.url() !== undefined;
    const globalStateCounters = {
      openCount: this.context.globalState.get<number>('extension.openCount') ?? 0,
      unknownMcpOpenCount: this.context.globalState.get<number>('extension.unknownMcpOpenCount') ?? 0,
      fluencyBannerDismissed: this.context.globalState.get<boolean>('news.fluencyScoreBanner.v1.dismissed') ?? false,
      unknownMcpDismissedVersion: this.context.globalState.get<string>('news.unknownMcpTools.dismissedVersion') ?? '',
    };

    const initialData = JSON.stringify({
      report,
      sessionFiles,
      detailedSessionFiles,
      sessionFolders,
      cacheInfo,
      backendStorageInfo,
      backendConfigured: this.isBackendConfigured(),
      isDebugMode,
      globalStateCounters,
    }).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Diagnostic Report</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DIAGNOSTICS__ = ${initialData};</script>
			${this.getLocalViewRegressionProbeScript('diagnostics', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  private buildChartData(fullDailyStats: DailyTokenStats[]): ChartDataPayload {
    const now = new Date();

    const modelColors = [
      { bg: "rgba(54, 162, 235, 0.6)", border: "rgba(54, 162, 235, 1)" },
      { bg: "rgba(255, 99, 132, 0.6)", border: "rgba(255, 99, 132, 1)" },
      { bg: "rgba(75, 192, 192, 0.6)", border: "rgba(75, 192, 192, 1)" },
      { bg: "rgba(153, 102, 255, 0.6)", border: "rgba(153, 102, 255, 1)" },
      { bg: "rgba(255, 159, 64, 0.6)", border: "rgba(255, 159, 64, 1)" },
      { bg: "rgba(255, 205, 86, 0.6)", border: "rgba(255, 205, 86, 1)" },
      { bg: "rgba(201, 203, 207, 0.6)", border: "rgba(201, 203, 207, 1)" },
      { bg: "rgba(100, 181, 246, 0.6)", border: "rgba(100, 181, 246, 1)" },
    ];

    const fmtKey = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const emptyEntry = (date: string): DailyTokenStats => ({
      date, tokens: 0, sessions: 0, interactions: 0,
      modelUsage: {}, editorUsage: {}, repositoryUsage: {},
    });

    const mergeInto = (target: DailyTokenStats, src: DailyTokenStats) => {
      target.tokens += src.tokens;
      target.sessions += src.sessions;
      target.interactions += src.interactions;
      for (const [m, u] of Object.entries(src.modelUsage)) {
        if (!target.modelUsage[m]) { target.modelUsage[m] = { inputTokens: 0, outputTokens: 0 }; }
        target.modelUsage[m].inputTokens += u.inputTokens;
        target.modelUsage[m].outputTokens += u.outputTokens;
        if (u.cachedReadTokens !== undefined) {
          target.modelUsage[m].cachedReadTokens = (target.modelUsage[m].cachedReadTokens ?? 0) + u.cachedReadTokens;
        }
        if (u.cacheCreationTokens !== undefined) {
          target.modelUsage[m].cacheCreationTokens = (target.modelUsage[m].cacheCreationTokens ?? 0) + u.cacheCreationTokens;
        }
      }
      for (const [e, u] of Object.entries(src.editorUsage)) {
        if (!target.editorUsage[e]) { target.editorUsage[e] = { tokens: 0, sessions: 0 }; }
        target.editorUsage[e].tokens += u.tokens;
        target.editorUsage[e].sessions += u.sessions;
      }
      for (const [r, u] of Object.entries(src.repositoryUsage)) {
        if (!target.repositoryUsage[r]) { target.repositoryUsage[r] = { tokens: 0, sessions: 0 }; }
        target.repositoryUsage[r].tokens += u.tokens;
        target.repositoryUsage[r].sessions += u.sessions;
      }
    };

    type BucketEntry = { label: string; key: string; stats: DailyTokenStats };

    const buildPeriodData = (buckets: BucketEntry[]) => {
      const entries = buckets.map(b => b.stats);
      const labels = buckets.map(b => b.label);
      const tokensData = entries.map(e => e.tokens);
      const sessionsData = entries.map(e => e.sessions);

      const allModels = new Set<string>();
      entries.forEach(e => Object.keys(e.modelUsage).forEach(m => allModels.add(m)));

      // Rank models by total tokens across the period; keep top 5, group the rest
      const modelTotals = new Map<string, number>();
      for (const model of allModels) {
        const total = entries.reduce((sum, e) => {
          const u = e.modelUsage[model];
          return sum + (u ? u.inputTokens + u.outputTokens : 0);
        }, 0);
        modelTotals.set(model, total);
      }
      const sortedModels = Array.from(allModels).sort((a, b) => (modelTotals.get(b) || 0) - (modelTotals.get(a) || 0));
      const topModels = sortedModels.slice(0, 5);
      const otherModels = sortedModels.slice(5);

      const modelDatasets = topModels.map((model, idx) => {
        const color = modelColors[idx % modelColors.length];
        return {
          label: getModelDisplayName(model),
          data: entries.map(e => { const u = e.modelUsage[model]; return u ? u.inputTokens + u.outputTokens : 0; }),
          backgroundColor: color.bg, borderColor: color.border, borderWidth: 1,
        };
      });
      if (otherModels.length > 0) {
        modelDatasets.push({
          label: 'Other models',
          data: entries.map(e => otherModels.reduce((sum, m) => {
            const u = e.modelUsage[m];
            return sum + (u ? u.inputTokens + u.outputTokens : 0);
          }, 0)),
          backgroundColor: 'rgba(150, 150, 150, 0.5)',
          borderColor: 'rgba(150, 150, 150, 0.8)',
          borderWidth: 1,
        });
      }

      const allEditors = new Set<string>();
      entries.forEach(e => Object.keys(e.editorUsage).forEach(ed => allEditors.add(ed)));
      const editorDatasets = Array.from(allEditors).map((editor, idx) => {
        const color = modelColors[idx % modelColors.length];
        return {
          label: editor,
          data: entries.map(e => e.editorUsage[editor]?.tokens || 0),
          backgroundColor: color.bg, borderColor: color.border, borderWidth: 1,
        };
      });

      const allRepos = new Set<string>();
      entries.forEach(e => Object.keys(e.repositoryUsage)
        .filter(r => r !== 'Unknown')
        .forEach(r => allRepos.add(r)));
      const repositoryDatasets = Array.from(allRepos).map((repo, idx) => {
        const color = modelColors[idx % modelColors.length];
        return {
          label: this.getRepoDisplayName(repo),
          fullRepo: repo,
          data: entries.map(e => e.repositoryUsage[repo]?.tokens || 0),
          backgroundColor: color.bg, borderColor: color.border, borderWidth: 1,
        };
      });

      const totalTokens = tokensData.reduce((a, b) => a + b, 0);
      const totalSessions = sessionsData.reduce((a, b) => a + b, 0);
      const periodCount = buckets.length;

      const costData = entries.map(e => this.calculateEstimatedCost(e.modelUsage, 'copilot'));
      const totalCost = costData.reduce((a, b) => a + b, 0);

      return {
        labels, tokensData, sessionsData, modelDatasets, editorDatasets, repositoryDatasets,
        periodCount, totalTokens, totalSessions,
        avgPerPeriod: periodCount > 0 ? Math.round(totalTokens / periodCount) : 0,
        costData,
        totalCost,
        avgCostPerPeriod: periodCount > 0 ? totalCost / periodCount : 0,
      };
    };

    // ── Daily period: last 30 days with zero-fill ─────────────────────
    const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    const thirtyDaysAgoStr = fmtKey(thirtyDaysAgo);
    const todayStr = fmtKey(now);
    const dailyBucketMap = new Map<string, BucketEntry>();
    for (let cursor = new Date(thirtyDaysAgo); cursor <= now; cursor.setDate(cursor.getDate() + 1)) {
      const key = fmtKey(new Date(cursor));
      dailyBucketMap.set(key, { key, label: key, stats: emptyEntry(key) });
    }
    for (const day of fullDailyStats) {
      if (day.date >= thirtyDaysAgoStr && day.date <= todayStr) {
        const bucket = dailyBucketMap.get(day.date);
        if (bucket) { mergeInto(bucket.stats, day); }
      }
    }
    const dailyBuckets = Array.from(dailyBucketMap.values()).sort((a, b) => a.key.localeCompare(b.key));
    const dailyPeriod = buildPeriodData(dailyBuckets);

    // ── Weekly period: last 6 calendar weeks with zero-fill ──────────
    const getMondayOfWeek = (d: Date): Date => {
      const copy = new Date(d); copy.setHours(0, 0, 0, 0);
      const day = copy.getDay();
      copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1));
      return copy;
    };
    const fmtWeekLabel = (monday: Date): string => {
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      if (monday.getMonth() === sunday.getMonth()) {
        return `${monday.toLocaleDateString("en-US", { month: "short" })} ${monday.getDate()}–${sunday.getDate()}`;
      }
      return `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${sunday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    };
    const thisMonday = getMondayOfWeek(now);
    const weekBucketMap = new Map<string, BucketEntry>();
    for (let w = 5; w >= 0; w--) {
      const monday = new Date(thisMonday); monday.setDate(thisMonday.getDate() - w * 7);
      const key = fmtKey(monday);
      weekBucketMap.set(key, { key, label: fmtWeekLabel(monday), stats: emptyEntry(key) });
    }
    for (const day of fullDailyStats) {
      const monday = getMondayOfWeek(new Date(day.date + "T00:00:00"));
      const bucket = weekBucketMap.get(fmtKey(monday));
      if (bucket) { mergeInto(bucket.stats, day); }
    }
    const weeklyBuckets = Array.from(weekBucketMap.values()).sort((a, b) => a.key.localeCompare(b.key));
    const weeklyPeriod = buildPeriodData(weeklyBuckets);

    // ── Monthly period: last 12 calendar months with zero-fill ───────
    const monthBucketMap = new Map<string, BucketEntry>();
    for (let m = 11; m >= 0; m--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
      const label = monthDate.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      monthBucketMap.set(key, { key, label, stats: emptyEntry(key) });
    }
    for (const day of fullDailyStats) {
      const monthKey = day.date.slice(0, 7);
      const bucket = monthBucketMap.get(monthKey);
      if (bucket) { mergeInto(bucket.stats, day); }
    }
    const monthlyBuckets = Array.from(monthBucketMap.values()).sort((a, b) => a.key.localeCompare(b.key));
    const monthlyPeriod = buildPeriodData(monthlyBuckets);

    // ── Summary totals from the daily period (last 30 days) ──────────
    const editorTotalsMap: Record<string, number> = {};
    dailyBuckets.forEach(b => {
      Object.entries(b.stats.editorUsage).forEach(([editor, usage]) => {
        editorTotalsMap[editor] = (editorTotalsMap[editor] || 0) + usage.tokens;
      });
    });
    const repositoryTotalsMap: Record<string, number> = {};
    dailyBuckets.forEach(b => {
      Object.entries(b.stats.repositoryUsage)
        .filter(([repo]) => repo !== 'Unknown')
        .forEach(([repo, usage]) => {
        const displayName = this.getRepoDisplayName(repo);
        repositoryTotalsMap[displayName] = (repositoryTotalsMap[displayName] || 0) + usage.tokens;
      });
    });

    return {
      // Backward-compat flat fields (daily period)
      labels: dailyPeriod.labels,
      tokensData: dailyPeriod.tokensData,
      sessionsData: dailyPeriod.sessionsData,
      modelDatasets: dailyPeriod.modelDatasets,
      editorDatasets: dailyPeriod.editorDatasets,
      repositoryDatasets: dailyPeriod.repositoryDatasets,
      editorTotalsMap,
      repositoryTotalsMap,
      dailyCount: dailyPeriod.periodCount,
      totalTokens: dailyPeriod.totalTokens,
      avgTokensPerDay: dailyPeriod.avgPerPeriod,
      totalSessions: dailyPeriod.totalSessions,
      lastUpdated: new Date().toISOString(),
      backendConfigured: this.isBackendConfigured(),
      compactNumbers: this.getCompactNumbersSetting(),
      periods: {
        day: dailyPeriod,
        week: weeklyPeriod,
        month: monthlyPeriod,
      },
    };
  }

  private getChartHtml(
    webview: vscode.Webview,
    dailyStats: DailyTokenStats[],
    periodsReady = true,
  ): string {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "chart.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const chartData = { ...this.buildChartData(dailyStats), periodsReady, initialPeriod: this.lastChartPeriod };

    const initialData = JSON.stringify(chartData).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>AI Engineering Fluency — Chart</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_CHART__ = ${initialData};</script>
			${this.getLocalViewRegressionProbeScript('chart', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  private getUsageAnalysisHtml(
    webview: vscode.Webview,
    stats: UsageAnalysisStats | null,
  ): string {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "usage.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Detect user's locale for number formatting
    const localeFromEnv =
      process.env.LC_ALL || process.env.LC_NUMERIC || process.env.LANG;
    const vscodeLanguage = vscode.env.language; // e.g., 'en', 'nl', 'de'
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;

    this.log(`[Locale Detection] VS Code language: ${vscodeLanguage}`);
    this.log(
      `[Locale Detection] Environment locale: ${localeFromEnv || "not set"}`,
    );
    this.log(`[Locale Detection] Intl default: ${intlLocale}`);

    const detectedLocale = (stats?.locale) || localeFromEnv || intlLocale;
    this.log(`[Usage Analysis] Extension detected locale: ${detectedLocale}`);
    this.log(
      `[Usage Analysis] Test format 1234567.89: ${new Intl.NumberFormat(detectedLocale).format(1234567.89)}`,
    );

    const suppressedUnknownTools = vscode.workspace
      .getConfiguration('aiEngineeringFluency')
      .get<string[]>('suppressedUnknownTools', []);

    const initialData = stats ? JSON.stringify({
      today: stats.today,
      last30Days: stats.last30Days,
      month: stats.month,
      locale: detectedLocale,
      customizationMatrix: stats.customizationMatrix || null,
      missedPotential: stats.missedPotential || [],
      lastUpdated: stats.lastUpdated.toISOString(),
      backendConfigured: this.isBackendConfigured(),
      currentWorkspacePaths: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      suppressedUnknownTools,
    }).replace(/</g, "\\u003c") : 'null';

    return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Usage Analysis</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_USAGE__ = ${initialData};</script>
			${this.getLocalViewRegressionProbeScript('usage', nonce)}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
  }

  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    if (this.detailsPanel) {
      this.detailsPanel.dispose();
    }
    if (this.chartPanel) {
      this.chartPanel.dispose();
    }
    if (this.analysisPanel) {
      this.analysisPanel.dispose();
    }
    if (this.maturityPanel) {
      this.maturityPanel.dispose();
    }
    // Save cache to storage before disposing (fire-and-forget async operation)
    // Note: Cache loss during abnormal shutdown is acceptable as it will rebuild on next startup
    // We can't await here since dispose() is synchronous
    this.saveCacheToStorage().catch((err) => {
      // Output channel will be disposed, so log to console as fallback
      console.error("Error saving cache during disposal:", err);
    });
    if (this.logViewerPanel) {
      this.logViewerPanel.dispose();
    }
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.dispose();
    }
    this.statusBarItem.dispose();
    this._disposed = true;
    this.outputChannel.dispose();
  }
}

/**
 * One-time migration: copies any user-set values from the old `copilotTokenTracker.*` namespace
 * to the new `aiEngineeringFluency.*` namespace.  The old settings remain in package.json
 * with `deprecationMessage` so VS Code continues to show them as deprecated; this function
 * handles users who already had values configured before the rename.
 *
 * Leave this migration in place for a couple of extension versions before removing it.
 */
async function migrateSettingsIfNeeded(log: (m: string) => void): Promise<void> {
  const keys = [
    'display.compactNumbers',
    'backend.enabled',
    'backend.backend',
    'backend.authMode',
    'backend.datasetId',
    'backend.sharingProfile',
    'backend.userId',
    'backend.shareWithTeam',
    'backend.shareWorkspaceMachineNames',
    'backend.shareConsentAt',
    'backend.userIdentityMode',
    'backend.userIdMode',
    'backend.subscriptionId',
    'backend.resourceGroup',
    'backend.storageAccount',
    'backend.aggTable',
    'backend.eventsTable',
    'backend.lookbackDays',
    'backend.includeMachineBreakdown',
    'backend.blobUploadEnabled',
    'backend.blobContainerName',
    'backend.blobUploadFrequencyHours',
    'backend.blobCompressFiles',
    'sampleDataDirectory',
    'suppressedUnknownTools',
  ];

  const oldCfg = vscode.workspace.getConfiguration('copilotTokenTracker');
  const newCfg = vscode.workspace.getConfiguration('aiEngineeringFluency');

  let migrated = 0;
  for (const key of keys) {
    const insp = oldCfg.inspect(key);
    if (insp?.globalValue !== undefined) {
      await newCfg.update(key, insp.globalValue, vscode.ConfigurationTarget.Global);
      migrated++;
    }
    if (insp?.workspaceValue !== undefined) {
      await newCfg.update(key, insp.workspaceValue, vscode.ConfigurationTarget.Workspace);
      migrated++;
    }
  }

  if (migrated > 0) {
    log(`Migrated ${migrated} setting(s) from 'copilotTokenTracker' to 'aiEngineeringFluency' namespace.`);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  // Create the token tracker
  const tokenTracker = new CopilotTokenTracker(context.extensionUri, context);

  // Migrate settings from the old copilotTokenTracker namespace to aiEngineeringFluency.
  // Run before any other settings are read so the new keys are populated first.
  await migrateSettingsIfNeeded((m) => tokenTracker.log(m));

  // Wire up backend facade and commands so the diagnostics webview can launch the
  // configuration wizard. Uses tokenTracker logging and helpers via casting to any.
  try {
    const backendFacade = new BackendFacade({
      context,
      log: (m: string) => tokenTracker.log(m),
      warn: (m: string) => tokenTracker.warn(m),
      updateTokenStats: async () => { await tokenTracker.updateTokenStats(); },
      calculateEstimatedCost: (modelUsage: ModelUsage) => tokenTracker.calculateEstimatedCost(modelUsage),



















      co2Per1kTokens: 0.2,
      waterUsagePer1kTokens: 0.3,
      co2AbsorptionPerTreePerYear: 21000,
      getCopilotSessionFiles: () =>
        tokenTracker.sessionDiscovery.getCopilotSessionFiles(),
      estimateTokensFromText: (text: string, model?: string) =>
        tokenTracker.estimateTokensFromText(text, model),
      getModelFromRequest: (req: any) =>
        tokenTracker.getModelFromRequest(req),
      getSessionFileDataCached: (p: string, m: number, s: number) =>
        tokenTracker.getSessionFileDataCached(p, m, s),
      statSessionFile: (sessionFile: string) =>
        tokenTracker.statSessionFile(sessionFile),
      isOpenCodeSession: (sessionFile: string) =>
        tokenTracker.openCode.isOpenCodeSessionFile(sessionFile),
      getOpenCodeSessionData: (sessionFile: string) =>
        tokenTracker.openCode.getOpenCodeSessionData(sessionFile),
      isCrushSession: (sessionFile: string) =>
        tokenTracker.crush.isCrushSessionFile(sessionFile),
      getCrushSessionData: (sessionFile: string) =>
        tokenTracker.crush.getCrushSessionData(sessionFile),
      isVSSessionFile: (sessionFile: string) =>
        tokenTracker.visualStudio.isVSSessionFile(sessionFile),
      getGithubToken: () => tokenTracker.githubSession?.accessToken,
    });

    const backendHandler = new BackendCommandHandler({
      facade: backendFacade as any,
      integration: undefined,
      calculateEstimatedCost: (mu: any) => 0,
      warn: (m: string) => tokenTracker.warn(m),
      log: (m: string) => tokenTracker.log(m),
    });

    // Store backend facade in the tracker instance for dashboard access
    tokenTracker.backend = backendFacade;

    // Backend sync timer will be started after initial token analysis completes
    // (see startBackendSyncAfterInitialAnalysis method)

    const configureBackendCommand = vscode.commands.registerCommand(
      "aiEngineeringFluency.configureBackend",
      async () => {
        await backendHandler.handleConfigureBackend();
      },
    );

    context.subscriptions.push(configureBackendCommand);

    const configureTeamServerCommand = vscode.commands.registerCommand(
      "aiEngineeringFluency.configureTeamServer",
      async () => {
        TeamServerConfigPanel.show(context);
      },
    );

    context.subscriptions.push(configureTeamServerCommand);
  } catch (err) {
    // If backend wiring fails for any reason, don't block activation - fall back to settings behavior.
    tokenTracker.warn(
      "Failed to wire backend commands: " + String(err),
    );
  }

  // Register the refresh command
  const refreshCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.refresh",
    async () => {
      tokenTracker.log("Refresh command called");
      await tokenTracker.updateTokenStats();
      vscode.window.showInformationMessage("AI Engineering Fluency data refreshed");
    },
  );

  // Register the show details command
  const showDetailsCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showDetails",
    async () => {
      tokenTracker.log("Show details command called");
      await tokenTracker.showDetails();
    },
  );

  // Register the show chart command
  const showChartCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showChart",
    async () => {
      tokenTracker.log("Show chart command called");
      await tokenTracker.showChart();
    },
  );

  // Register the show usage analysis command
  const showUsageAnalysisCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showUsageAnalysis",
    async () => {
      tokenTracker.log("Show usage analysis command called");
      await tokenTracker.showUsageAnalysis();
    },
  );

  // Register the show maturity / fluency score command
  const showMaturityCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showMaturity",
    async () => {
      tokenTracker.log("Show maturity command called");
      await tokenTracker.showMaturity();
    },
  );

  // Register the show dashboard command
  const showDashboardCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showDashboard",
    async () => {
      tokenTracker.log("Show dashboard command called");
      await tokenTracker.showDashboard();
    },
  );

  const showEnvironmentalCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showEnvironmental",
    async () => {
      tokenTracker.log("Show environmental impact command called");
      await tokenTracker.showEnvironmental();
    },
  );

  // Register the show fluency level viewer command (debug-only)
  const showFluencyLevelViewerCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.showFluencyLevelViewer",
    async () => {
      tokenTracker.log("Show fluency level viewer command called");
      await tokenTracker.showFluencyLevelViewer();
    },
  );

  const runLocalViewRegressionCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.runLocalViewRegression",
    async () => {
      tokenTracker.log("Run local view regression command called");
      await tokenTracker.runLocalViewRegression();
    },
  );

  // Register the generate diagnostic report command
  const generateDiagnosticReportCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.generateDiagnosticReport",
    async () => {
      tokenTracker.log("Generate diagnostic report command called");
      await tokenTracker.showDiagnosticReport();
    },
  );

  // Register the clear cache command
  const clearCacheCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.clearCache",
    async () => {
      tokenTracker.log("Clear cache command called");
      await tokenTracker.clearCache();
    },
  );

  // Register the GitHub authentication command
  const authenticateGitHubCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.authenticateGitHub",
    async () => {
      tokenTracker.log("GitHub authentication command called");
      await tokenTracker.authenticateWithGitHub();
    },
  );

  // Register the GitHub sign out command
  const signOutGitHubCommand = vscode.commands.registerCommand(
    "aiEngineeringFluency.signOutGitHub",
    async () => {
      tokenTracker.log("GitHub sign out command called");
      await tokenTracker.signOutFromGitHub();
    },
  );

  // Add to subscriptions for proper cleanup
  context.subscriptions.push(
    refreshCommand,
    showDetailsCommand,
    showChartCommand,
    showUsageAnalysisCommand,
    showMaturityCommand,
    showFluencyLevelViewerCommand,
    runLocalViewRegressionCommand,
    showDashboardCommand,
    showEnvironmentalCommand,
    generateDiagnosticReportCommand,
    clearCacheCommand,
    authenticateGitHubCommand,
    signOutGitHubCommand,
    tokenTracker,
  );

  tokenTracker.log("Extension activation complete");
}

export function deactivate() {
  // Extension cleanup is handled in the CopilotTokenTracker class
}
