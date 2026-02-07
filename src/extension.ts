import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';
import { BackendFacade } from './backend/facade';
import { BackendCommandHandler } from './backend/commands';
import * as packageJson from '../package.json';
import {getModelDisplayName} from './webview/shared/modelUtils';

interface TokenUsageStats {
	todayTokens: number;
	monthTokens: number;
	lastUpdated: Date;
}

interface ModelUsage {
	[modelName: string]: {
		inputTokens: number;
		outputTokens: number;
	};
}

interface ModelPricing {
	inputCostPerMillion: number;
	outputCostPerMillion: number;
	category?: string;
	tier?: 'standard' | 'premium' | 'unknown';
	multiplier?: number;
	displayNames?: string[];
}

interface EditorUsage {
	[editorType: string]: {
		tokens: number;
		sessions: number;
	};
}

interface PeriodStats {
	tokens: number;
	sessions: number;
	avgInteractionsPerSession: number;
	avgTokensPerSession: number;
	modelUsage: ModelUsage;
	editorUsage: EditorUsage;
	co2: number;
	treesEquivalent: number;
	waterUsage: number;
	estimatedCost: number;
}

interface DetailedStats {
	today: PeriodStats;
	month: PeriodStats;
	lastMonth: PeriodStats;
	lastUpdated: Date;
}

interface DailyTokenStats {
	date: string; // YYYY-MM-DD format
	tokens: number;
	sessions: number;
	interactions: number;
	modelUsage: ModelUsage;
	editorUsage: EditorUsage;
}

interface SessionFileCache {
	tokens: number;
	interactions: number;
	modelUsage: ModelUsage;
	mtime: number; // file modification time as timestamp
	size?: number; // file size in bytes (optional for backward compatibility)
	usageAnalysis?: SessionUsageAnalysis; // New analysis data
	firstInteraction?: string | null; // ISO timestamp of first interaction
	lastInteraction?: string | null; // ISO timestamp of last interaction
	title?: string; // Session title (customTitle from session file)
}

// New interfaces for usage analysis
interface SessionUsageAnalysis {
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
	modelSwitching: {
		uniqueModels: string[];
		modelCount: number;
		switchCount: number;
		tiers: { standard: string[]; premium: string[]; unknown: string[] };
		hasMixedTiers: boolean;
	};
}

interface ToolCallUsage {
	total: number;
	byTool: { [toolName: string]: number };
}

interface ModeUsage {
	ask: number;     // Regular chat mode
	edit: number;    // Edit mode interactions
	agent: number;   // Agent mode interactions
}

interface ContextReferenceUsage {
	file: number;              // #file references
	selection: number;         // #selection references
	implicitSelection: number; // Implicit selections via inputState.selections
	symbol: number;            // #symbol references
	codebase: number;          // #codebase references
	workspace: number;         // @workspace references
	terminal: number;          // @terminal references
	vscode: number;            // @vscode references
	// contentReferences tracking from session logs
	byKind: { [kind: string]: number };           // Count by reference kind
	copilotInstructions: number;                  // .github/copilot-instructions.md
	agentsMd: number;                             // agents.md in repo root
	byPath: { [path: string]: number };           // Count by unique file path
}

interface McpToolUsage {
	total: number;
	byServer: { [serverName: string]: number };
	byTool: { [toolName: string]: number };
}

interface ModelSwitchingAnalysis {
	modelsPerSession: number[];  // Array of unique model counts per session
	totalSessions: number;
	averageModelsPerSession: number;
	maxModelsPerSession: number;
	minModelsPerSession: number;
	switchingFrequency: number;  // % of sessions with >1 model
	standardModels: string[];    // Unique standard models used
	premiumModels: string[];     // Unique premium models used
	unknownModels: string[];     // Unique models with unknown tier
	mixedTierSessions: number;   // Sessions using both standard and premium
}

interface UsageAnalysisStats {
	today: UsageAnalysisPeriod;
	last30Days: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	lastUpdated: Date;
}

interface UsageAnalysisPeriod {
	sessions: number;
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
	modelSwitching: ModelSwitchingAnalysis;
}

// Detailed session file information for diagnostics view
interface SessionFileDetails {
	file: string;
	size: number;
	modified: string;
	interactions: number;
	contextReferences: ContextReferenceUsage;
	firstInteraction: string | null;
	lastInteraction: string | null;
	editorSource: string; // 'vscode', 'vscode-insiders', 'cursor', etc.
	editorRoot?: string; // top-level editor root path (for display in diagnostics)
	editorName?: string; // friendly editor name (e.g., 'VS Code')
	title?: string; // session title (customTitle from session file)
}

// Chat turn information for log viewer
interface ChatTurn {
	turnNumber: number;
	timestamp: string | null;
	mode: 'ask' | 'edit' | 'agent';
	userMessage: string;
	assistantResponse: string;
	model: string | null;
	toolCalls: { toolName: string; arguments?: string; result?: string }[];
	contextReferences: ContextReferenceUsage;
	mcpTools: { server: string; tool: string }[];
	inputTokensEstimate: number;
	outputTokensEstimate: number;
}

// Full session log data for the log viewer
interface SessionLogData {
	file: string;
	title: string | null;
	editorSource: string;
	editorName: string;
	size: number;
	modified: string;
	interactions: number;
	contextReferences: ContextReferenceUsage;
	firstInteraction: string | null;
	lastInteraction: string | null;
	turns: ChatTurn[];
	usageAnalysis?: SessionUsageAnalysis;
}

class CopilotTokenTracker implements vscode.Disposable {
	// Cache version - increment this when making changes that require cache invalidation
	private static readonly CACHE_VERSION = 11; // Fix toolId extraction for tool calls (2026-02-05)
	
	private diagnosticsPanel?: vscode.WebviewPanel;
	// Tracks whether the diagnostics panel has already received its session files
	private diagnosticsHasLoadedFiles: boolean = false;
	// Cache of the last loaded detailed session files for diagnostics view
	private diagnosticsCachedFiles: SessionFileDetails[] = [];
	// Cache of the last diagnostic report text for copy/issue operations
	private lastDiagnosticReport: string = '';
	private logViewerPanel?: vscode.WebviewPanel;
	private statusBarItem: vscode.StatusBarItem;
	private readonly extensionUri: vscode.Uri;
	private readonly context: vscode.ExtensionContext;

	// Helper method to get total tokens from ModelUsage
	private getTotalTokensFromModelUsage(modelUsage: ModelUsage): number {
		return Object.values(modelUsage).reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0);
	}
	private updateInterval: NodeJS.Timeout | undefined;
	private initialDelayTimeout: NodeJS.Timeout | undefined;
	private detailsPanel: vscode.WebviewPanel | undefined;
	private chartPanel: vscode.WebviewPanel | undefined;
	private analysisPanel: vscode.WebviewPanel | undefined;
	private outputChannel: vscode.OutputChannel;
	private sessionFileCache: Map<string, SessionFileCache> = new Map();
	private lastDetailedStats: DetailedStats | undefined;
	private tokenEstimators: { [key: string]: number } = tokenEstimatorsData.estimators;
	private co2Per1kTokens = 0.2; // gCO2e per 1000 tokens, a rough estimate
	private co2AbsorptionPerTreePerYear = 21000; // grams of CO2 per tree per year
	private waterUsagePer1kTokens = 0.3; // liters of water per 1000 tokens, based on data center usage estimates
	private _cacheHits = 0; // Counter for cache hits during usage analysis
	private _cacheMisses = 0; // Counter for cache misses during usage analysis
	// Short-term cache to avoid rescanning filesystem during rapid successive calls (e.g., diagnostics load)
	private _sessionFilesCache: string[] | null = null;
	private _sessionFilesCacheTime: number = 0;
	private static readonly SESSION_FILES_CACHE_TTL = 60000; // Cache for 60 seconds

	// Model pricing data - loaded from modelPricing.json
	// Reference: OpenAI API Pricing (https://openai.com/api/pricing/) - Retrieved December 2025
	// Reference: Anthropic Claude Pricing (https://www.anthropic.com/pricing) - Standard rates
	// Note: GitHub Copilot uses these models but pricing may differ from direct API usage
	// These are reference prices for cost estimation purposes only
	private modelPricing: { [key: string]: ModelPricing } = modelPricingData.pricing as { [key: string]: ModelPricing };

	// Helper method to get repository URL from package.json
	private getRepositoryUrl(): string {
		const repoUrl = packageJson.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
		return repoUrl || 'https://github.com/rajbos/github-copilot-token-usage';
	}

	/**
	 * Determine the editor type from a session file path
	 * Returns: 'VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Copilot CLI', or 'Unknown'
	 */
	private getEditorTypeFromPath(filePath: string): string {
		const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
		
		if (normalizedPath.includes('/.copilot/session-state/')) {
			return 'Copilot CLI';
		}
		if (normalizedPath.includes('/code - insiders/') || normalizedPath.includes('/code%20-%20insiders/')) {
			return 'VS Code Insiders';
		}
		if (normalizedPath.includes('/code - exploration/') || normalizedPath.includes('/code%20-%20exploration/')) {
			return 'VS Code Exploration';
		}
		if (normalizedPath.includes('/vscodium/')) {
			return 'VSCodium';
		}
		if (normalizedPath.includes('/cursor/')) {
			return 'Cursor';
		}
		if (normalizedPath.includes('.vscode-server-insiders/')) {
			return 'VS Code Server (Insiders)';
		}
		if (normalizedPath.includes('.vscode-server/') || normalizedPath.includes('.vscode-remote/')) {
			return 'VS Code Server';
		}
		if (normalizedPath.includes('/code/')) {
			return 'VS Code';
		}
		
		return 'Unknown';
	}

	/**
	 * Determine a friendly editor name from an editor root path (folder name)
	 * e.g. 'C:\...\AppData\Roaming\Code' -> 'VS Code'
	 */
	private getEditorNameFromRoot(rootPath: string): string {
		if (!rootPath) { return 'Unknown'; }
		const lower = rootPath.toLowerCase();
		// Check obvious markers first
		if (lower.includes('.copilot') || lower.includes('copilot')) { return 'Copilot CLI'; }
		if (lower.includes('code - insiders') || lower.includes('code-insiders') || lower.includes('insiders')) { return 'VS Code Insiders'; }
		if (lower.includes('code - exploration') || lower.includes('code%20-%20exploration')) { return 'VS Code Exploration'; }
		if (lower.includes('vscodium')) { return 'VSCodium'; }
		if (lower.includes('cursor')) { return 'Cursor'; }
		// Generic 'code' match (catch AppData\Roaming\Code)
		if (lower.endsWith('code') || lower.includes(path.sep + 'code' + path.sep) || lower.includes('/code/')) { return 'VS Code'; }
		return 'Unknown';
	}

	// Logging methods
	public log(message: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ${message}`);
	}

	private warn(message: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] WARNING: ${message}`);
	}

	private error(message: string, error?: any): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
		if (error) {
			this.outputChannel.appendLine(`[${timestamp}] ${error}`);
		}
	}

	// Cache management methods
	/**
	 * Checks if the cache is valid for a file by comparing mtime and size.
	 * If the cache entry is missing size (old format), treat as invalid so it will be upgraded.
	 */
	private isCacheValid(filePath: string, currentMtime: number, currentSize: number): boolean {
		const cached = this.sessionFileCache.get(filePath);
		if (!cached) {
			return false;
		}
		// If size is missing (old cache), treat as invalid so it will be upgraded
		if (typeof cached.size !== 'number') {
			return false;
		}
		return cached.mtime === currentMtime && cached.size === currentSize;
	}

	private getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.sessionFileCache.get(filePath);
	}

	/**
	 * Sets the cache entry for a session file, including file size.
	 */
	private setCachedSessionData(filePath: string, data: SessionFileCache, fileSize?: number): void {
		if (typeof fileSize === 'number') {
			data.size = fileSize;
		}
		this.sessionFileCache.set(filePath, data);
		
		// Limit cache size to prevent memory issues (keep last 1000 files)
		// Only trigger cleanup when size exceeds limit by 100 to avoid frequent operations
		if (this.sessionFileCache.size > 1100) {
			// Remove 100 oldest entries to bring size back to 1000
			// Maps maintain insertion order, so the first entries are the oldest
			const keysToDelete: string[] = [];
			let count = 0;
			for (const key of this.sessionFileCache.keys()) {
				keysToDelete.push(key);
				count++;
				if (count >= 100) {
					break;
				}
			}
			for (const key of keysToDelete) {
				this.sessionFileCache.delete(key);
			}
			this.log(`Cache size limit reached, removed ${keysToDelete.length} oldest entries. Current size: ${this.sessionFileCache.size}`);
		}
	}

	private clearExpiredCache(): void {
		// Remove cache entries for files that no longer exist
		const filesToCheck = Array.from(this.sessionFileCache.keys());
		for (const filePath of filesToCheck) {
			try {
				if (!fs.existsSync(filePath)) {
					this.sessionFileCache.delete(filePath);
				}
			} catch (error) {
				// File access error, remove from cache
				this.sessionFileCache.delete(filePath);
			}
		}
	}

	// Persistent cache storage methods
	private loadCacheFromStorage(): void {
		try {
			// Check cache version first
			const storedVersion = this.context.globalState.get<number>('sessionFileCacheVersion');
			if (storedVersion !== CopilotTokenTracker.CACHE_VERSION) {
				this.log(`Cache version mismatch (stored: ${storedVersion}, current: ${CopilotTokenTracker.CACHE_VERSION}). Clearing cache.`);
				this.sessionFileCache = new Map();
				return;
			}
			
			const cacheData = this.context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache');
			if (cacheData) {
				this.sessionFileCache = new Map(Object.entries(cacheData));
				this.log(`Loaded ${this.sessionFileCache.size} cached session files from storage`);
			} else {
				this.log('No cached session files found in storage');
			}
		} catch (error) {
			this.error('Error loading cache from storage:', error);
			// Start with empty cache on error
			this.sessionFileCache = new Map();
		}
	}

	private async saveCacheToStorage(): Promise<void> {
		try {
			// Convert Map to plain object for storage
			const cacheData = Object.fromEntries(this.sessionFileCache);
			await this.context.globalState.update('sessionFileCache', cacheData);
			await this.context.globalState.update('sessionFileCacheVersion', CopilotTokenTracker.CACHE_VERSION);
			this.log(`Saved ${this.sessionFileCache.size} cached session files to storage (version ${CopilotTokenTracker.CACHE_VERSION})`);
		} catch (error) {
			this.error('Error saving cache to storage:', error);
		}
	}

	public async clearCache(): Promise<void> {
		   try {
			   // Show the output channel so users can see what's happening
			   this.outputChannel.show(true);
			   this.log('DEBUG clearCache() called');
			   this.log('Clearing session file cache...');
			   
			   const cacheSize = this.sessionFileCache.size;
			   this.sessionFileCache.clear();
			   await this.context.globalState.update('sessionFileCache', undefined);
			   // Reset diagnostics loaded flag so the diagnostics view will reload files
			this.diagnosticsHasLoadedFiles = false;
			this.diagnosticsCachedFiles = [];
			// Clear cached computed stats so details panel doesn't show stale data
			this.lastDetailedStats = undefined;
               
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
		this.context = context;
		// Create output channel for extension logs
		this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot Token Tracker');
		// CRITICAL: Add output channel to context.subscriptions so VS Code doesn't dispose it
		context.subscriptions.push(this.outputChannel);
		this.log('Constructor called');

		// Load persisted cache from storage
		this.loadCacheFromStorage();

		// Check GitHub Copilot extension status
		this.checkCopilotExtension();

		// Create status bar item
		this.statusBarItem = vscode.window.createStatusBarItem(
			'copilot-token-tracker',
			vscode.StatusBarAlignment.Right,
			100
		);
		this.statusBarItem.name = "GitHub Copilot Token Usage";
		this.statusBarItem.text = "$(loading~spin) Copilot Tokens: Loading...";
		this.statusBarItem.tooltip = "Daily and monthly GitHub Copilot token usage - Click to open details";
		this.statusBarItem.command = 'copilot-token-tracker.showDetails';
		this.statusBarItem.show();

		this.log('Status bar item created and shown');

		// Smart initial update with delay for extension loading
		this.scheduleInitialUpdate();

		// Update every 5 minutes (cache is saved automatically after each update)
		this.updateInterval = setInterval(() => {
			this.updateTokenStats(true); // Silent update from timer
		}, 5 * 60 * 1000);
	}

	private scheduleInitialUpdate(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		// Check if Copilot extensions exist but are not active (likely still loading)
		const extensionsExistButInactive =
			(copilotExtension && !copilotExtension.isActive) ||
			(copilotChatExtension && !copilotChatExtension.isActive);

		if (extensionsExistButInactive) {
			// Use shorter delay for testing in Codespaces
			const delaySeconds = process.env.CODESPACES === 'true' ? 5 : 2;
			this.log(`⏳ Waiting for Copilot Extension to start (${delaySeconds}s delay)`);

			this.initialDelayTimeout = setTimeout(() => {
				try {
					this.log('🚀 Starting token usage analysis...');
					this.recheckCopilotExtensionsAfterDelay();
					this.updateTokenStats();
				} catch (error) {
					this.error('Error in delayed initial update:', error);
				}
			}, delaySeconds * 1000);
		} else if (!copilotExtension && !copilotChatExtension) {
			this.log('⚠️ No Copilot extensions found - starting analysis anyway');
			setTimeout(() => this.updateTokenStats(), 100);
		} else {
			this.log('✅ Copilot extensions are active - starting token analysis');
			setTimeout(() => this.updateTokenStats(), 100);
		}
	}

	private recheckCopilotExtensionsAfterDelay(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		const copilotActive = copilotExtension?.isActive;
		const chatActive = copilotChatExtension?.isActive;

		if (copilotActive && chatActive) {
			this.log('✅ Copilot extensions are now active');
		} else {
			this.warn('⚠️ Some Copilot extensions still inactive after delay');
		}
	}

	public async updateTokenStats(silent: boolean = false): Promise<DetailedStats | undefined> {
		try {
			this.log('Updating token stats...');
			const detailedStats = await this.calculateDetailedStats(silent ? undefined : (completed, total) => {
				const percentage = Math.round((completed / total) * 100);
				this.statusBarItem.text = `$(loading~spin) Analyzing Logs: ${percentage}%`;
			});

			this.statusBarItem.text = `$(symbol-numeric) ${detailedStats.today.tokens.toLocaleString()} | ${detailedStats.month.tokens.toLocaleString()}`;

			// Create detailed tooltip with improved style
			const tooltip = new vscode.MarkdownString();
			tooltip.isTrusted = false;
			// Title
			tooltip.appendMarkdown('#### 🤖 GitHub Copilot Token Usage');
			tooltip.appendMarkdown('\n---\n');
			// Table layout for Today
			tooltip.appendMarkdown(`📅 Today  \n`);
			tooltip.appendMarkdown(`|                 |  |\n|-----------------------|-------|\n`);
			tooltip.appendMarkdown(`| Tokens :                | ${detailedStats.today.tokens.toLocaleString()} |\n`);
			tooltip.appendMarkdown(`| Estimated cost :             | $ ${detailedStats.today.estimatedCost.toFixed(4)} |\n`);
			tooltip.appendMarkdown(`| CO₂ estimated :              | ${detailedStats.today.co2.toFixed(2)} grams |\n`);
			tooltip.appendMarkdown(`| Water estimated :           | ${detailedStats.today.waterUsage.toFixed(3)} liters |\n`);
			tooltip.appendMarkdown(`| Sessions :             | ${detailedStats.today.sessions} |\n`);
			tooltip.appendMarkdown(`| Average interactions/session :     | ${detailedStats.today.avgInteractionsPerSession} |\n`);
			tooltip.appendMarkdown(`| Average tokens/session :            | ${detailedStats.today.avgTokensPerSession.toLocaleString()} |\n`);

			tooltip.appendMarkdown('\n---\n');

			// Table layout for This Month
			tooltip.appendMarkdown(`📊 This month  \n`);
			tooltip.appendMarkdown(`|                 |  |\n|-----------------------|-------|\n`);
			tooltip.appendMarkdown(`| Tokens :                | ${detailedStats.month.tokens.toLocaleString()} |\n`);
			tooltip.appendMarkdown(`| Estimated cost :             | $ ${detailedStats.month.estimatedCost.toFixed(4)} |\n`);
			tooltip.appendMarkdown(`| CO₂ estimated :              | ${detailedStats.month.co2.toFixed(2)} grams |\n`);
			tooltip.appendMarkdown(`| Water estimated :           | ${detailedStats.month.waterUsage.toFixed(3)} liters |\n`);
			tooltip.appendMarkdown(`| Sessions :             | ${detailedStats.month.sessions} |\n`);
			tooltip.appendMarkdown(`| Average interactions/session :      | ${detailedStats.month.avgInteractionsPerSession} |\n`);
			tooltip.appendMarkdown(`| Average tokens/session :            | ${detailedStats.month.avgTokensPerSession.toLocaleString()} |\n`);
			// Footer
			tooltip.appendMarkdown('\n---\n');
			tooltip.appendMarkdown('*Cost estimates based on actual input/output token ratios.*  \n');
			tooltip.appendMarkdown('*Updates automatically every 5 minutes.*');

			this.statusBarItem.tooltip = tooltip;

			// If the details panel is open, update its content
			if (this.detailsPanel) {
				this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, detailedStats);
			}

			// If the chart panel is open, update its content
			if (this.chartPanel) {
				const dailyStats = await this.calculateDailyStats();
				this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, dailyStats);
			}

			// If the analysis panel is open, update its content
			if (this.analysisPanel) {
				const analysisStats = await this.calculateUsageAnalysisStats();
				this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);
			}

			this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Month: ${detailedStats.month.tokens}`);
			// Store the stats for reuse without recalculation
			this.lastDetailedStats = detailedStats;
			
			// Save cache to ensure it's persisted for next run (don't await to avoid blocking UI)
			this.saveCacheToStorage().catch(err => {
				this.warn(`Failed to save cache: ${err}`);
			});
			
			return detailedStats;
		} catch (error) {
			this.error('Error updating token stats:', error);
			this.statusBarItem.text = '$(error) Token Error';
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
			const sessionFiles = await this.getCopilotSessionFiles();

			for (const sessionFile of sessionFiles) {
				try {
					const fileStats = fs.statSync(sessionFile);

					// Only process files modified in the current month
					if (fileStats.mtime >= monthStart) {
						const tokens = await this.estimateTokensFromSessionCached(sessionFile, fileStats.mtime.getTime(), fileStats.size);

						monthTokens += tokens;

						// If modified today, add to today's count
						if (fileStats.mtime >= todayStart) {
							todayTokens += tokens;
						}
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile}: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating token usage:', error);
		}

		return {
			todayTokens,
			monthTokens
		};
	}

	private async calculateDetailedStats(progressCallback?: (completed: number, total: number) => void): Promise<DetailedStats> {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
		// Calculate last month boundaries
		const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999); // Last day of previous month
		const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);

		const todayStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		const monthStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		const lastMonthStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };

		try {
			// Clean expired cache entries
			this.clearExpiredCache();
			
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`📊 Analyzing ${sessionFiles.length} session file(s)...`);

			if (sessionFiles.length === 0) {
				this.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}

			let cacheHits = 0;
			let cacheMisses = 0;
			let skippedFiles = 0;

			for (let i = 0; i < sessionFiles.length; i++) {
				const sessionFile = sessionFiles[i];
				
				if (progressCallback) {
					progressCallback(i + 1, sessionFiles.length);
				}

				try {
					// Fast check: Get file stats first to avoid processing old files
					const fileStats = fs.statSync(sessionFile);
					
					// Skip files modified before last month (quick filter)
					// This is the main performance optimization - filters out old sessions without reading file content
					if (fileStats.mtime < lastMonthStart) {
						skippedFiles++;
						continue;
					}
					
					// For files within current month, check if data is cached to avoid redundant reads
					const mtime = fileStats.mtime.getTime();
					const fileSize = fileStats.size;
					const wasCached = this.isCacheValid(sessionFile, mtime, fileSize);
					
					// Get interactions count (uses cache if available)
					const interactions = await this.countInteractionsInSessionCached(sessionFile, mtime, fileSize);
					// Skip empty sessions (no interactions = just opened chat panel, no messages sent)
					if (interactions === 0) {
						skippedFiles++;
						continue;
					}
					
					// Get remaining data (all use cache if available)
					const tokens = await this.estimateTokensFromSessionCached(sessionFile, mtime, fileSize);
					const modelUsage = await this.getModelUsageFromSessionCached(sessionFile, mtime, fileSize);
					const editorType = this.getEditorTypeFromPath(sessionFile);
					
					// For date filtering, get lastInteraction from session details
					const details = await this.getSessionFileDetails(sessionFile);
					const lastActivity = details.lastInteraction 
						? new Date(details.lastInteraction) 
						: new Date(details.modified);

					if (lastActivity >= monthStart) {

						// Update cache statistics
						if (wasCached) {
							cacheHits++;
						} else {
							cacheMisses++;
						}

						monthStats.tokens += tokens;
						monthStats.sessions += 1;
						monthStats.interactions += interactions;

						// Add editor usage to month stats
						if (!monthStats.editorUsage[editorType]) {
							monthStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
						}
						monthStats.editorUsage[editorType].tokens += tokens;
						monthStats.editorUsage[editorType].sessions += 1;

						// Add model usage to month stats
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!monthStats.modelUsage[model]) {
								monthStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
							}
							monthStats.modelUsage[model].inputTokens += usage.inputTokens;
							monthStats.modelUsage[model].outputTokens += usage.outputTokens;
						}

						if (lastActivity >= todayStart) {
							todayStats.tokens += tokens;
							todayStats.sessions += 1;
							todayStats.interactions += interactions;

							// Add editor usage to today stats
							if (!todayStats.editorUsage[editorType]) {
								todayStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
							}
							todayStats.editorUsage[editorType].tokens += tokens;
							todayStats.editorUsage[editorType].sessions += 1;

							// Add model usage to today stats
							for (const [model, usage] of Object.entries(modelUsage)) {
								if (!todayStats.modelUsage[model]) {
									todayStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
								}
								todayStats.modelUsage[model].inputTokens += usage.inputTokens;
								todayStats.modelUsage[model].outputTokens += usage.outputTokens;
							}
						}
					}
					else if (lastActivity >= lastMonthStart && lastActivity <= lastMonthEnd) {
						// Session is from last month - only track lastMonth stats
						if (wasCached) {
							cacheHits++;
						} else {
							cacheMisses++;
						}

						lastMonthStats.tokens += tokens;
						lastMonthStats.sessions += 1;
						lastMonthStats.interactions += interactions;

						// Add editor usage to last month stats
						if (!lastMonthStats.editorUsage[editorType]) {
							lastMonthStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
						}
						lastMonthStats.editorUsage[editorType].tokens += tokens;
						lastMonthStats.editorUsage[editorType].sessions += 1;

						// Add model usage to last month stats
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!lastMonthStats.modelUsage[model]) {
								lastMonthStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
							}
							lastMonthStats.modelUsage[model].inputTokens += usage.inputTokens;
							lastMonthStats.modelUsage[model].outputTokens += usage.outputTokens;
						}
					}
					else {
						// Session is too old (no activity in current or last month), skip it
						skippedFiles++;
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile}: ${fileError}`);
				}
			}

			this.log(`✅ Analysis complete: Today ${todayStats.sessions} sessions, Month ${monthStats.sessions} sessions, Last Month ${lastMonthStats.sessions} sessions`);
			if (skippedFiles > 0) {
				this.log(`⏭️ Skipped ${skippedFiles} session file(s) (empty or no activity in recent months)`);
			}
			const totalCacheAccesses = cacheHits + cacheMisses;
			this.log(`💾 Cache performance: ${cacheHits} hits, ${cacheMisses} misses (${totalCacheAccesses > 0 ? ((cacheHits / totalCacheAccesses) * 100).toFixed(1) : 0}% hit rate)`);
		} catch (error) {
			this.error('Error calculating detailed stats:', error);
		}

		const todayCo2 = (todayStats.tokens / 1000) * this.co2Per1kTokens;
		const monthCo2 = (monthStats.tokens / 1000) * this.co2Per1kTokens;
		const lastMonthCo2 = (lastMonthStats.tokens / 1000) * this.co2Per1kTokens;
		
		const todayWater = (todayStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const monthWater = (monthStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const lastMonthWater = (lastMonthStats.tokens / 1000) * this.waterUsagePer1kTokens;

		const todayCost = this.calculateEstimatedCost(todayStats.modelUsage);
		const monthCost = this.calculateEstimatedCost(monthStats.modelUsage);
		const lastMonthCost = this.calculateEstimatedCost(lastMonthStats.modelUsage);

		const result: DetailedStats = {
			today: {
				tokens: todayStats.tokens,
				sessions: todayStats.sessions,
				avgInteractionsPerSession: todayStats.sessions > 0 ? Math.round(todayStats.interactions / todayStats.sessions) : 0,
				avgTokensPerSession: todayStats.sessions > 0 ? Math.round(todayStats.tokens / todayStats.sessions) : 0,
				modelUsage: todayStats.modelUsage,
				editorUsage: todayStats.editorUsage,
				co2: todayCo2,
				treesEquivalent: todayCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: todayWater,
				estimatedCost: todayCost
			},
			month: {
				tokens: monthStats.tokens,
				sessions: monthStats.sessions,
				avgInteractionsPerSession: monthStats.sessions > 0 ? Math.round(monthStats.interactions / monthStats.sessions) : 0,
				avgTokensPerSession: monthStats.sessions > 0 ? Math.round(monthStats.tokens / monthStats.sessions) : 0,
				modelUsage: monthStats.modelUsage,
				editorUsage: monthStats.editorUsage,
				co2: monthCo2,
				treesEquivalent: monthCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: monthWater,
				estimatedCost: monthCost
			},
			lastMonth: {
				tokens: lastMonthStats.tokens,
				sessions: lastMonthStats.sessions,
				avgInteractionsPerSession: lastMonthStats.sessions > 0 ? Math.round(lastMonthStats.interactions / lastMonthStats.sessions) : 0,
				avgTokensPerSession: lastMonthStats.sessions > 0 ? Math.round(lastMonthStats.tokens / lastMonthStats.sessions) : 0,
				modelUsage: lastMonthStats.modelUsage,
				editorUsage: lastMonthStats.editorUsage,
				co2: lastMonthCo2,
				treesEquivalent: lastMonthCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: lastMonthWater,
				estimatedCost: lastMonthCost
			},
			lastUpdated: now
		};

		return result;
	}

	private formatDateKey(date: Date): string {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
	}

	private async calculateDailyStats(): Promise<DailyTokenStats[]> {
		const now = new Date();
		// Use last 30 days instead of current month for better chart visibility
		const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
		
		// Map to store daily stats by date string (YYYY-MM-DD)
		const dailyStatsMap = new Map<string, DailyTokenStats>();
		
		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`📈 Preparing chart data from ${sessionFiles.length} session file(s)...`);
			
			for (const sessionFile of sessionFiles) {
				try {
					const fileStats = fs.statSync(sessionFile);
					
					// Only process files modified in the last 30 days
					if (fileStats.mtime >= thirtyDaysAgo) {
						const mtime = fileStats.mtime.getTime();
						const fileSize = fileStats.size;
						const tokens = await this.estimateTokensFromSessionCached(sessionFile, mtime, fileSize);
						const interactions = await this.countInteractionsInSessionCached(sessionFile, mtime, fileSize);
						const modelUsage = await this.getModelUsageFromSessionCached(sessionFile, mtime, fileSize);
						const editorType = this.getEditorTypeFromPath(sessionFile);
						
						// Get the date in YYYY-MM-DD format
						const dateKey = this.formatDateKey(new Date(fileStats.mtime));
						
						// Initialize or update the daily stats
						if (!dailyStatsMap.has(dateKey)) {
							dailyStatsMap.set(dateKey, {
								date: dateKey,
								tokens: 0,
								sessions: 0,
								interactions: 0,
								modelUsage: {},
								editorUsage: {}
							});
						}
						
						const dailyStats = dailyStatsMap.get(dateKey)!;
						dailyStats.tokens += tokens;
						dailyStats.sessions += 1;
						dailyStats.interactions += interactions;
						
						// Merge editor usage
						if (!dailyStats.editorUsage[editorType]) {
							dailyStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
						}
						dailyStats.editorUsage[editorType].tokens += tokens;
						dailyStats.editorUsage[editorType].sessions += 1;
						
						// Merge model usage
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!dailyStats.modelUsage[model]) {
								dailyStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
							}
							dailyStats.modelUsage[model].inputTokens += usage.inputTokens;
							dailyStats.modelUsage[model].outputTokens += usage.outputTokens;
						}
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile} for daily stats: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating daily stats:', error);
		}
		
		// Convert map to array and sort by date
		let dailyStatsArray = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
		
		// Always fill in all 30 days to show complete chart
		const today = new Date();
		
		// Create a set of existing dates for quick lookup
		const existingDates = new Set(dailyStatsArray.map(s => s.date));
		
		// Generate all dates from 30 days ago to today
		const allDates: string[] = [];
		const currentDate = new Date(thirtyDaysAgo);
		
		while (currentDate <= today) {
			const dateKey = this.formatDateKey(currentDate);
			allDates.push(dateKey);
			currentDate.setDate(currentDate.getDate() + 1);
		}
		
		// Add missing dates with zero values
		for (const dateKey of allDates) {
			if (!existingDates.has(dateKey)) {
				dailyStatsMap.set(dateKey, {
					date: dateKey,
					tokens: 0,
					sessions: 0,
					interactions: 0,
					modelUsage: {},
					editorUsage: {}
				});
			}
		}
		
		// Re-convert map to array and sort by date
		dailyStatsArray = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
		
		return dailyStatsArray;
	}

	/**
	 * Calculate usage analysis statistics for today and this month
	 */
	private async calculateUsageAnalysisStats(): Promise<UsageAnalysisStats> {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const last30DaysStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		this.log('🔍 [Usage Analysis] Starting calculation...');
		this._cacheHits = 0; // Reset cache hit counter
		this._cacheMisses = 0; // Reset cache miss counter

		const emptyPeriod = (): UsageAnalysisPeriod => ({
			sessions: 0,
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
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
				mixedTierSessions: 0
			}
		});

		const todayStats = emptyPeriod();
		const last30DaysStats = emptyPeriod();
		const monthStats = emptyPeriod();

		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`🔍 [Usage Analysis] Processing ${sessionFiles.length} session files`);

			let processed = 0;
			const progressInterval = Math.max(1, Math.floor(sessionFiles.length / 20)); // Log every 5%
			
			for (const sessionFile of sessionFiles) {
				try {
					const fileStats = fs.statSync(sessionFile);

					// Check if file is within the last 30 days (widest range)
					if (fileStats.mtime >= last30DaysStart) {
						const mtime = fileStats.mtime.getTime();
						const fileSize = fileStats.size;
						const analysis = await this.getUsageAnalysisFromSessionCached(sessionFile, mtime, fileSize);
						
						// Add to last 30 days stats
						last30DaysStats.sessions++;
						this.mergeUsageAnalysis(last30DaysStats, analysis);

						// Add to month stats if modified this calendar month
						if (fileStats.mtime >= monthStart) {
							monthStats.sessions++;
							this.mergeUsageAnalysis(monthStats, analysis);
						}

						// Add to today stats if modified today
						if (fileStats.mtime >= todayStart) {
							todayStats.sessions++;
							this.mergeUsageAnalysis(todayStats, analysis);
						}
					}
					
					processed++;
					if (processed % progressInterval === 0) {
						this.log(`🔍 [Usage Analysis] Progress: ${processed}/${sessionFiles.length} files (${Math.round(processed/sessionFiles.length*100)}%)`);
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile} for usage analysis: ${fileError}`);
					processed++;
				}
			}
		} catch (error) {
			this.error('Error calculating usage analysis stats:', error);
		}

		// Log cache statistics
		this.log(`🔍 [Usage Analysis] Cache stats: ${this._cacheHits} hits, ${this._cacheMisses} misses`);

		return {
			today: todayStats,
			last30Days: last30DaysStats,
			month: monthStats,
			lastUpdated: now
		};
	}

	/**
	 * Merge usage analysis data into period stats
	 */
	private mergeUsageAnalysis(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
		// Merge tool calls
		period.toolCalls.total += analysis.toolCalls.total;
		for (const [tool, count] of Object.entries(analysis.toolCalls.byTool)) {
			period.toolCalls.byTool[tool] = (period.toolCalls.byTool[tool] || 0) + count;
		}

		// Merge mode usage
		period.modeUsage.ask += analysis.modeUsage.ask;
		period.modeUsage.edit += analysis.modeUsage.edit;
		period.modeUsage.agent += analysis.modeUsage.agent;

		// Merge context references
		period.contextReferences.file += analysis.contextReferences.file;
		period.contextReferences.selection += analysis.contextReferences.selection;
		period.contextReferences.implicitSelection += analysis.contextReferences.implicitSelection || 0;
		period.contextReferences.symbol += analysis.contextReferences.symbol;
		period.contextReferences.codebase += analysis.contextReferences.codebase;
		period.contextReferences.workspace += analysis.contextReferences.workspace;
		period.contextReferences.terminal += analysis.contextReferences.terminal;
		period.contextReferences.vscode += analysis.contextReferences.vscode;
		
		// Merge contentReferences counts
		period.contextReferences.copilotInstructions += analysis.contextReferences.copilotInstructions || 0;
		period.contextReferences.agentsMd += analysis.contextReferences.agentsMd || 0;
		
		// Merge byKind tracking
		for (const [kind, count] of Object.entries(analysis.contextReferences.byKind || {})) {
			period.contextReferences.byKind[kind] = (period.contextReferences.byKind[kind] || 0) + count;
		}
		
		// Merge byPath tracking
		for (const [path, count] of Object.entries(analysis.contextReferences.byPath || {})) {
			period.contextReferences.byPath[path] = (period.contextReferences.byPath[path] || 0) + count;
		}

		// Merge MCP tools
		period.mcpTools.total += analysis.mcpTools.total;
		for (const [server, count] of Object.entries(analysis.mcpTools.byServer)) {
			period.mcpTools.byServer[server] = (period.mcpTools.byServer[server] || 0) + count;
		}
		for (const [tool, count] of Object.entries(analysis.mcpTools.byTool)) {
			period.mcpTools.byTool[tool] = (period.mcpTools.byTool[tool] || 0) + count;
		}

		// Merge model switching data
		// Ensure modelSwitching exists (backward compatibility with old cache)
		if (!analysis.modelSwitching) {
			analysis.modelSwitching = {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false
			};
		}
		
		// Only count sessions with at least 1 model detected for model switching stats
		// Sessions without detected models (modelCount === 0) should not affect the average
		if (analysis.modelSwitching.modelCount > 0) {
			period.modelSwitching.totalSessions++;
			period.modelSwitching.modelsPerSession.push(analysis.modelSwitching.modelCount);
			
			// Track unique models by tier
			for (const model of analysis.modelSwitching.tiers.standard) {
				if (!period.modelSwitching.standardModels.includes(model)) {
					period.modelSwitching.standardModels.push(model);
				}
			}
			for (const model of analysis.modelSwitching.tiers.premium) {
				if (!period.modelSwitching.premiumModels.includes(model)) {
					period.modelSwitching.premiumModels.push(model);
				}
			}
			for (const model of analysis.modelSwitching.tiers.unknown) {
				if (!period.modelSwitching.unknownModels.includes(model)) {
					period.modelSwitching.unknownModels.push(model);
				}
			}
			
			// Count sessions with mixed tiers
			if (analysis.modelSwitching.hasMixedTiers) {
				period.modelSwitching.mixedTierSessions++;
			}
			
			// Calculate aggregate statistics
			if (period.modelSwitching.modelsPerSession.length > 0) {
				const counts = period.modelSwitching.modelsPerSession;
				period.modelSwitching.averageModelsPerSession = counts.reduce((a, b) => a + b, 0) / counts.length;
				period.modelSwitching.maxModelsPerSession = Math.max(...counts);
				period.modelSwitching.minModelsPerSession = Math.min(...counts);
				period.modelSwitching.switchingFrequency = (counts.filter(c => c > 1).length / counts.length) * 100;
			}
		}
	}

	private async countInteractionsInSession(sessionFile: string): Promise<number> {
		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
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

	private async getModelUsageFromSession(sessionFile: string): Promise<ModelUsage> {
		const modelUsage: ModelUsage = {};
		const fileName = sessionFile.split(/[/\\]/).pop() || sessionFile;

		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Detect JSONL content: either by extension or by content analysis
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			
			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				// Default model for CLI sessions - they may not specify the model per event
				let defaultModel = 'gpt-4o';
				
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						
						// Handle VS Code incremental format - extract model from session header (kind: 0)
						// The schema has v.selectedModel.identifier or v.selectedModel.metadata.id
						if (event.kind === 0) {
							const modelId = event.v?.selectedModel?.identifier || 
								event.v?.selectedModel?.metadata?.id ||
								// Legacy fallback: older Copilot Chat session logs stored selectedModel under v.inputState.
								// This is kept for backward compatibility so we can still read existing logs from those versions.
								event.v?.inputState?.selectedModel?.metadata?.id;
							if (modelId) {
								defaultModel = modelId.replace(/^copilot\//, '');
							}
						}
						
						// Handle model changes (kind: 2 with selectedModel update, NOT kind: 1 which is delete)
						if (event.kind === 2 && event.k?.[0] === 'selectedModel') {
							const modelId = event.v?.identifier || event.v?.metadata?.id;
							if (modelId) {
								defaultModel = modelId.replace(/^copilot\//, '');
							}
						}
						
						const model = event.model || defaultModel;
						
						if (!modelUsage[model]) {
							modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
						}
						
						// Handle Copilot CLI format
						if (event.type === 'user.message' && event.data?.content) {
							modelUsage[model].inputTokens += this.estimateTokensFromText(event.data.content, model);
						} else if (event.type === 'assistant.message' && event.data?.content) {
							modelUsage[model].outputTokens += this.estimateTokensFromText(event.data.content, model);
						} else if (event.type === 'tool.result' && event.data?.output) {
							// Tool outputs are typically input context
							modelUsage[model].inputTokens += this.estimateTokensFromText(event.data.output, model);
						}
						
						// Handle VS Code incremental format (kind: 2 with requests)
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								// Extract request-level modelId if available
								let requestModel = model;
								if (request.modelId) {
									requestModel = request.modelId.replace(/^copilot\//, '');
								} else if (request.result?.metadata?.modelId) {
									requestModel = request.result.metadata.modelId.replace(/^copilot\//, '');
								} else if (request.result?.details) {
									// Parse model from details string like "Claude Opus 4.5 • 3x"
									requestModel = this.getModelFromRequest(request);
								}
								
								if (!modelUsage[requestModel]) {
									modelUsage[requestModel] = { inputTokens: 0, outputTokens: 0 };
								}
								
								if (request.message?.text) {
									modelUsage[requestModel].inputTokens += this.estimateTokensFromText(request.message.text, requestModel);
								}
								// Also process message.parts if available
								if (request.message?.parts && Array.isArray(request.message.parts)) {
									for (const part of request.message.parts) {
										if (part.text && part.text !== request.message?.text) {
											modelUsage[requestModel].inputTokens += this.estimateTokensFromText(part.text, requestModel);
										}
									}
								}
								// Process response items if present in the request
								if (request.response && Array.isArray(request.response)) {
									for (const responseItem of request.response) {
										if (responseItem.value) {
											modelUsage[requestModel].outputTokens += this.estimateTokensFromText(responseItem.value, requestModel);
										}
									}
								}
							}
						}
						
						// Handle VS Code incremental format - response content (kind: 2 with response)
						if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
							for (const responseItem of event.v) {
								if (responseItem.value) {
									modelUsage[model].outputTokens += this.estimateTokensFromText(responseItem.value, model);
								} else if (responseItem.kind === 'markdownContent' && responseItem.content?.value) {
									modelUsage[model].outputTokens += this.estimateTokensFromText(responseItem.content.value, model);
								}
							}
						}
					} catch (e) {
						// Skip malformed lines
					}
				}
				return modelUsage;
			}
			
			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Get model for this request
					const model = this.getModelFromRequest(request);

					// Initialize model if not exists
					if (!modelUsage[model]) {
						modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
					}

					// Estimate tokens from user message (input)
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								const tokens = this.estimateTokensFromText(part.text, model);
								modelUsage[model].inputTokens += tokens;
							}
						}
					}

					// Estimate tokens from assistant response (output)
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							if (responseItem.value) {
								const tokens = this.estimateTokensFromText(responseItem.value, model);
								modelUsage[model].outputTokens += tokens;
							}
						}
					}
				}
			}
		} catch (error) {
			this.warn(`Error getting model usage from ${sessionFile}: ${error}`);
		}

		return modelUsage;
	}

	/**
	 * Analyze a session file for usage patterns (tool calls, modes, context references, MCP tools)
	 */
	private async analyzeSessionUsage(sessionFile: string): Promise<SessionUsageAnalysis> {
		const analysis: SessionUsageAnalysis = {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
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
				hasMixedTiers: false
			}
		};

		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				let sessionMode = 'ask'; // Default mode
				
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						
						// Handle VS Code incremental format - detect mode from session header
						if (event.kind === 0 && event.v?.inputState?.mode?.kind) {
							sessionMode = event.v.inputState.mode.kind;
							
							// Detect implicit selections in initial state
							if (event.v?.inputState?.selections && Array.isArray(event.v.inputState.selections) && event.v.inputState.selections.length > 0) {
								analysis.contextReferences.implicitSelection++;
							}
						}
						
						// Handle mode changes (kind: 1 with mode update)
						if (event.kind === 1 && event.k?.includes('mode') && event.v?.kind) {
							sessionMode = event.v.kind;
						}
						
						// Detect implicit selections in updates to inputState.selections
						if (event.kind === 1 && event.k?.includes('selections') && Array.isArray(event.v) && event.v.length > 0) {
							analysis.contextReferences.implicitSelection++;
						}
						
						// Handle VS Code incremental format - count requests as interactions
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								if (request.requestId) {
									// Count by mode
									if (sessionMode === 'agent') {
										analysis.modeUsage.agent++;
									} else if (sessionMode === 'edit') {
										analysis.modeUsage.edit++;
									} else {
										analysis.modeUsage.ask++;
									}
								}
								// Check for agent in request
								if (request.agent?.id) {
									const toolName = request.agent.id;
									analysis.toolCalls.total++;
									analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
								}
							
								// Analyze contentReferences if present
								if (request.contentReferences && Array.isArray(request.contentReferences)) {
									this.analyzeContentReferences(request.contentReferences, analysis.contextReferences);
								}
								
								// Extract tool calls from request.response array (when full request is added)
								if (request.response && Array.isArray(request.response)) {
									for (const responseItem of request.response) {
										if (responseItem.kind === 'toolInvocationSerialized' || responseItem.kind === 'prepareToolInvocation') {
											analysis.toolCalls.total++;
											const toolName = responseItem.toolId || responseItem.toolName || responseItem.invocationMessage?.toolName || responseItem.toolSpecificData?.kind || 'unknown';
											analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
										}
									}
								}
							}
						}
					
					// Handle VS Code incremental format - tool invocations in responses
					if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
						for (const responseItem of event.v) {
							if (responseItem.kind === 'toolInvocationSerialized') {
								analysis.toolCalls.total++;
								const toolName = responseItem.toolId || responseItem.toolName || responseItem.invocationMessage?.toolName || responseItem.toolSpecificData?.kind || 'unknown';
								analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
							}
						}
					}
					
					// Handle Copilot CLI format
						// Detect mode from event type - CLI can be chat or agent mode
						if (event.type === 'user.message') {
							analysis.modeUsage.ask++;
						}
						
						// If we see tool calls, upgrade to agent mode for this session
						if (event.type === 'tool.call' || event.type === 'tool.result') {
							// Tool usage indicates agent mode - adjust if we counted this as ask
							if (analysis.modeUsage.ask > 0) {
								analysis.modeUsage.ask--;
								analysis.modeUsage.agent++;
							}
						}
						
						// Detect tool calls from Copilot CLI
						if (event.type === 'tool.call' || event.type === 'tool.result') {
							analysis.toolCalls.total++;
							const toolName = event.data?.toolName || event.toolName || 'unknown';
							analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
						}
						
						// Detect MCP tools
						if (event.type === 'mcp.tool.call' || (event.data?.mcpServer)) {
							analysis.mcpTools.total++;
							const serverName = event.data?.mcpServer || 'unknown';
							const toolName = event.data?.toolName || event.toolName || 'unknown';
							analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
							analysis.mcpTools.byTool[toolName] = (analysis.mcpTools.byTool[toolName] || 0) + 1;
						}
						
						// Detect context references in user messages
						if (event.type === 'user.message' && event.data?.content) {
							this.analyzeContextReferences(event.data.content, analysis.contextReferences);
						}
					} catch (e) {
						// Skip malformed lines
					}
				}
				// Calculate model switching for JSONL files before returning
				await this.calculateModelSwitching(sessionFile, analysis);
				return analysis;
			}
			
			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			// Detect session mode and count interactions per request
			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Determine mode for each individual request
					let requestMode = 'ask'; // default
					
					// Check request-level agent ID first (more specific)
					if (request.agent?.id) {
						const agentId = request.agent.id.toLowerCase();
						if (agentId.includes('edit')) {
							requestMode = 'edit';
						} else if (agentId.includes('agent')) {
							requestMode = 'agent';
						}
					}
					// Fall back to session-level mode if no request-specific agent
					else if (sessionContent.mode?.id) {
						const modeId = sessionContent.mode.id.toLowerCase();
						if (modeId.includes('agent')) {
							requestMode = 'agent';
						} else if (modeId.includes('edit')) {
							requestMode = 'edit';
						}
					}
					
					// Count this request in the appropriate mode
					if (requestMode === 'agent') {
						analysis.modeUsage.agent++;
					} else if (requestMode === 'edit') {
						analysis.modeUsage.edit++;
					} else {
						analysis.modeUsage.ask++;
					}
					
					// Analyze user message for context references
					if (request.message) {
						if (request.message.text) {
							this.analyzeContextReferences(request.message.text, analysis.contextReferences);
						}
						if (request.message.parts) {
							for (const part of request.message.parts) {
								if (part.text) {
									this.analyzeContextReferences(part.text, analysis.contextReferences);
								}
							}
						}
					}
					
					// Analyze variableData for @workspace, @terminal, @vscode references
					if (request.variableData) {
						// Process variables array for prompt files and other context
						this.analyzeVariableData(request.variableData, analysis.contextReferences);
						
						// Also check for @ references in variable names/values
						const varDataStr = JSON.stringify(request.variableData).toLowerCase();
						if (varDataStr.includes('workspace')) {
							analysis.contextReferences.workspace++;
						}
						if (varDataStr.includes('terminal')) {
							analysis.contextReferences.terminal++;
						}
						if (varDataStr.includes('vscode')) {
							analysis.contextReferences.vscode++;
						}
					}
					
					// Analyze contentReferences if present
					if (request.contentReferences && Array.isArray(request.contentReferences)) {
						this.analyzeContentReferences(request.contentReferences, analysis.contextReferences);
					}
					
					// Analyze variableData if present
					if (request.variableData) {
						this.analyzeVariableData(request.variableData, analysis.contextReferences);
					}
					
					// Analyze variableData if present
					if (request.variableData) {
						this.analyzeVariableData(request.variableData, analysis.contextReferences);
					}
					
					// Analyze response for tool calls and MCP tools
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							// Detect tool invocations
							if (responseItem.kind === 'toolInvocationSerialized' || 
							    responseItem.kind === 'prepareToolInvocation') {
								analysis.toolCalls.total++;
								const toolName = responseItem.toolId ||
								                responseItem.toolName || 
								                responseItem.invocationMessage?.toolName || 
								                'unknown';
								analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
							}
							
							// Detect MCP servers starting
							if (responseItem.kind === 'mcpServersStarting' && responseItem.didStartServerIds) {
								for (const serverId of responseItem.didStartServerIds) {
									analysis.mcpTools.total++;
									analysis.mcpTools.byServer[serverId] = (analysis.mcpTools.byServer[serverId] || 0) + 1;
								}
							}
						
						// Detect inline references in response items
						if (responseItem.kind === 'inlineReference' && responseItem.inlineReference) {
							// Treat response inlineReferences as contentReferences
							this.analyzeContentReferences([responseItem], analysis.contextReferences);
						}
					}
				}
			}
		}
	} catch (error) {
		this.warn(`Error analyzing session usage from ${sessionFile}: ${error}`);
	}

	// Calculate model switching statistics from session
	await this.calculateModelSwitching(sessionFile, analysis);

	return analysis;
}

/**
 * Calculate model switching statistics for a session file.
 * This method updates the analysis.modelSwitching field in place.
 */
	private async calculateModelSwitching(sessionFile: string, analysis: SessionUsageAnalysis): Promise<void> {
		try {
			// Use non-cached method to avoid circular dependency
			// (getSessionFileDataCached -> analyzeSessionUsage -> getModelUsageFromSessionCached -> getSessionFileDataCached)
			const modelUsage = await this.getModelUsageFromSession(sessionFile);
			const modelCount = modelUsage ? Object.keys(modelUsage).length : 0;
			
			// Skip if modelUsage is undefined or empty (not a valid session file)
			if (!modelUsage || modelCount === 0) {
				return;
			}
			
			// Get unique models from this session
			const uniqueModels = Object.keys(modelUsage);
			analysis.modelSwitching.uniqueModels = uniqueModels;
			analysis.modelSwitching.modelCount = uniqueModels.length;
			
			// Classify models by tier
			const standardModels: string[] = [];
			const premiumModels: string[] = [];
			const unknownModels: string[] = [];
			
			for (const model of uniqueModels) {
				const tier = this.getModelTier(model);
				if (tier === 'standard') {
					standardModels.push(model);
				} else if (tier === 'premium') {
					premiumModels.push(model);
				} else {
					unknownModels.push(model);
				}
			}
			
			analysis.modelSwitching.tiers = { standard: standardModels, premium: premiumModels, unknown: unknownModels };
			analysis.modelSwitching.hasMixedTiers = standardModels.length > 0 && premiumModels.length > 0;
			
			// Count model switches by examining request sequence (for JSON files only - not JSONL)
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (!isJsonlContent) {
				const sessionContent = JSON.parse(fileContent);
				if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
					let previousModel: string | null = null;
					let switchCount = 0;
					
					for (const request of sessionContent.requests) {
						const currentModel = this.getModelFromRequest(request);
						if (previousModel && currentModel !== previousModel) {
							switchCount++;
						}
						previousModel = currentModel;
					}
					
					analysis.modelSwitching.switchCount = switchCount;
				}
			}
		} catch (error) {
			this.warn(`Error calculating model switching for ${sessionFile}: ${error}`);
		}
	}

	/**
	 * Analyze text for context references like #file, #selection, @workspace
	 */
	private analyzeContextReferences(text: string, refs: ContextReferenceUsage): void {
		// Count #file references
		const fileMatches = text.match(/#file/gi);
		if (fileMatches) {
			refs.file += fileMatches.length;
		}
		
		// Count #selection references
		const selectionMatches = text.match(/#selection/gi);
		if (selectionMatches) {
			refs.selection += selectionMatches.length;
		}
		
		// Count #symbol references
		const symbolMatches = text.match(/#symbol/gi);
		if (symbolMatches) {
			refs.symbol += symbolMatches.length;
		}
		
		// Count #codebase references
		const codebaseMatches = text.match(/#codebase/gi);
		if (codebaseMatches) {
			refs.codebase += codebaseMatches.length;
		}
		
		// Count @workspace references
		const workspaceMatches = text.match(/@workspace/gi);
		if (workspaceMatches) {
			refs.workspace += workspaceMatches.length;
		}
		
		// Count @terminal references
		const terminalMatches = text.match(/@terminal/gi);
		if (terminalMatches) {
			refs.terminal += terminalMatches.length;
		}
		
		// Count @vscode references
		const vscodeMatches = text.match(/@vscode/gi);
		if (vscodeMatches) {
			refs.vscode += vscodeMatches.length;
		}
	}

	/**
	 * Analyze contentReferences from session log data to track specific file attachments.
	 * Looks for kind: "reference" entries and tracks by kind, path patterns.
	 * Also increments specific category counters like refs.file when appropriate.
	 */
	private analyzeContentReferences(contentReferences: any[], refs: ContextReferenceUsage): void {
		if (!Array.isArray(contentReferences)) {
			return;
		}

		for (const contentRef of contentReferences) {
			if (!contentRef || typeof contentRef !== 'object') {
				continue;
			}

			// Track by kind
			const kind = contentRef.kind;
			if (typeof kind === 'string') {
				refs.byKind[kind] = (refs.byKind[kind] || 0) + 1;
			}

			// Extract reference object based on kind
			let reference = null;
			
			// Handle different reference structures
			if (kind === 'reference' && contentRef.reference) {
				reference = contentRef.reference;
			} else if (kind === 'inlineReference' && contentRef.inlineReference) {
				reference = contentRef.inlineReference;
			}
			
			// Process the reference if found
			if (reference) {
				// Try to extract file path from various possible fields
				const fsPath = reference.fsPath || reference.path;
				if (typeof fsPath === 'string') {
					// Normalize path separators for pattern matching
					const normalizedPath = fsPath.replace(/\\/g, '/').toLowerCase();
					
					// Track specific patterns
					if (normalizedPath.endsWith('/.github/copilot-instructions.md') || 
					    normalizedPath.includes('.github/copilot-instructions.md')) {
						refs.copilotInstructions++;
					} else if (normalizedPath.endsWith('/agents.md') || 
					           normalizedPath.match(/\/agents\.md$/i)) {
						refs.agentsMd++;
					} else {
						// For other files, increment the general file counter
						// This makes actual file attachments show up in context ref counts
						refs.file++;
					}
					
					// Track by full path (limit to last 100 chars for display)
					const pathKey = fsPath.length > 100 ? '...' + fsPath.substring(fsPath.length - 97) : fsPath;
					refs.byPath[pathKey] = (refs.byPath[pathKey] || 0) + 1;
				}
			}
		}
	}

	/**
	 * Analyze variableData to track prompt file attachments and other variable-based context.
	 * This captures automatic attachments like copilot-instructions.md via variable system.
	 */
	private analyzeVariableData(variableData: any, refs: ContextReferenceUsage): void {
		if (!variableData || !Array.isArray(variableData.variables)) {
			return;
		}

		for (const variable of variableData.variables) {
			if (!variable || typeof variable !== 'object') {
				continue;
			}

			// Track by kind from variableData
			const kind = variable.kind;
			if (typeof kind === 'string') {
				refs.byKind[kind] = (refs.byKind[kind] || 0) + 1;
			}

			// Process promptFile variables that contain file references
			if (kind === 'promptFile' && variable.value) {
				const value = variable.value;
				const fsPath = value.fsPath || value.path || value.external;
				
				if (typeof fsPath === 'string') {
					const normalizedPath = fsPath.replace(/\\/g, '/').toLowerCase();
					
					// Track specific patterns (but don't double-count if already in contentReferences)
					if (normalizedPath.endsWith('/.github/copilot-instructions.md') || 
					    normalizedPath.includes('.github/copilot-instructions.md')) {
						// copilotInstructions - tracked via contentReferences, skip here to avoid double counting
					} else if (normalizedPath.endsWith('/agents.md') || 
					           normalizedPath.match(/\/agents\.md$/i)) {
						// agents.md - tracked via contentReferences, skip here  to avoid double counting
					}
					// Note: We don't add to byPath here as these are automatic attachments,
					// not explicit user file selections
				}
			}
		}
	}

	// Cached versions of session file reading methods
	private async getSessionFileDataCached(sessionFilePath: string, mtime: number, fileSize: number): Promise<SessionFileCache> {
	// Check if we have valid cached data
	const cached = this.getCachedSessionData(sessionFilePath);
	if (cached && cached.mtime === mtime && cached.size === fileSize) {
		this._cacheHits++;
		return cached;
	}

		this._cacheMisses++;
		// Cache miss - read and process the file once to get all data
		const tokens = await this.estimateTokensFromSession(sessionFilePath);
		const interactions = await this.countInteractionsInSession(sessionFilePath);
		const modelUsage = await this.getModelUsageFromSession(sessionFilePath);
		const usageAnalysis = await this.analyzeSessionUsage(sessionFilePath);
		
		const sessionData: SessionFileCache = {
			tokens,
			interactions,
			modelUsage,
			mtime,
			usageAnalysis
		};

		this.setCachedSessionData(sessionFilePath, sessionData, fileSize);
		return sessionData;
	}

	private async estimateTokensFromSessionCached(sessionFilePath: string, mtime: number, fileSize: number): Promise<number> {
		const sessionData = await this.getSessionFileDataCached(sessionFilePath, mtime, fileSize);
		return sessionData.tokens;
	}

	private async countInteractionsInSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<number> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		return sessionData.interactions;
	}

	private async getModelUsageFromSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<ModelUsage> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		return sessionData.modelUsage;
	}

	private async getUsageAnalysisFromSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<SessionUsageAnalysis> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		const analysis = sessionData.usageAnalysis || {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
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
				hasMixedTiers: false
			}
		};
		
		// Ensure modelSwitching field exists for backward compatibility with old cache
		if (!analysis.modelSwitching) {
			analysis.modelSwitching = {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false
			};
		}
		
		return analysis;
	}

	/**
	 * Add editor root and name information to session file details.
	 * Enriches the details object with editorRoot and editorName properties.
	 */
	private enrichDetailsWithEditorInfo(sessionFile: string, details: SessionFileDetails): void {
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
		
		// Reconstruct SessionFileDetails from cache
		const details: SessionFileDetails = {
			file: sessionFile,
			size: cached.size || stat.size,
			modified: stat.mtime.toISOString(),
			interactions: cached.interactions,
			contextReferences: cached.usageAnalysis.contextReferences,
			firstInteraction: cached.firstInteraction || null,
			lastInteraction: cached.lastInteraction || null,
			editorSource: this.detectEditorSource(sessionFile),
			title: cached.title
		};
		
		// Add editor root and name
		this.enrichDetailsWithEditorInfo(sessionFile, details);
		
		return details;
	}

	/**
	 * Update or create cache entry with session file details.
	 * Merges new detail fields with existing cached data if available.
	 */
	private async updateCacheWithSessionDetails(
		sessionFile: string, 
		stat: fs.Stats, 
		details: SessionFileDetails
	): Promise<void> {
		// Get existing cache entry if available
		const existingCache = this.getCachedSessionData(sessionFile);
		
		// Create or update cache entry
		const cacheEntry: SessionFileCache = {
			tokens: existingCache?.tokens || 0,
			interactions: details.interactions,
			modelUsage: existingCache?.modelUsage || {},
			mtime: stat.mtime.getTime(),
			size: stat.size,
			usageAnalysis: existingCache?.usageAnalysis || {
				toolCalls: { total: 0, byTool: {} },
				modeUsage: { ask: 0, edit: 0, agent: 0 },
				contextReferences: {
					file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
					workspace: 0, terminal: 0, vscode: 0,
					// Extended fields expected by SessionUsageAnalysis in the webview
					byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
				},
				mcpTools: { total: 0, byServer: {}, byTool: {} },
				modelSwitching: {
					uniqueModels: [],
					modelCount: 0,
					switchCount: 0,
					tiers: { standard: [], premium: [], unknown: [] },
					hasMixedTiers: false
				}
			},
			firstInteraction: details.firstInteraction,
			lastInteraction: details.lastInteraction,
			title: details.title
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
		const stat = await fs.promises.stat(sessionFile);
		
		// Try to get details from cache first
		const cachedDetails = await this.getSessionFileDetailsFromCache(sessionFile, stat);
		if (cachedDetails) {
			this._cacheHits++;
			return cachedDetails;
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
				byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
			},
			firstInteraction: null,
			lastInteraction: null,
			editorSource: this.detectEditorSource(sessionFile)
		};

		// Determine top-level editor root path for this session file (up to the folder before 'User')
		this.enrichDetailsWithEditorInfo(sessionFile, details);

		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				const timestamps: number[] = [];
				
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
							}
						}
						
						// Handle VS Code incremental .jsonl format (kind: 0, 1, 2)
						// kind: 0 = session header with creationDate
						// kind: 2 = requests array with timestamps
						if (event.kind === 0 && event.v) {
							// Session creation timestamp
							if (event.v.creationDate) {
								timestamps.push(event.v.creationDate);
							}
							// Session title
							if (event.v.customTitle && !details.title) {
								details.title = event.v.customTitle;
							}
						}
						
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							// New requests being added - count interactions and extract timestamps
							for (const request of event.v) {
								if (request.requestId) {
									details.interactions++;
								}
								if (request.timestamp) {
									timestamps.push(request.timestamp);
								}
								// Analyze context references in request message
								if (request.message?.text) {
									this.analyzeContextReferences(request.message.text, details.contextReferences);
								}
								// Fallback: look for generatedTitle in response items
								if (!details.title && request.response && Array.isArray(request.response)) {
									for (const responseItem of request.response) {
										if (responseItem.generatedTitle) {
											details.title = responseItem.generatedTitle;
											break;
										}
									}
								}
							}
						}
						
						// Also check kind: 2 events that update response arrays directly
						if (!details.title && event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
							for (const responseItem of event.v) {
								if (responseItem.generatedTitle) {
									details.title = responseItem.generatedTitle;
									break;
								}
							}
						}
					} catch {
						// Skip malformed lines
					}
				}
				
				if (timestamps.length > 0) {
					timestamps.sort((a, b) => a - b);
					details.firstInteraction = new Date(timestamps[0]).toISOString();
					details.lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
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
			
			// Fallback: look for generatedTitle in responses if no customTitle
			if (!details.title && sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					if (details.title) { break; }
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							if (responseItem.generatedTitle) {
								details.title = responseItem.generatedTitle;
								break;
							}
						}
					}
				}
			}
			
			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				details.interactions = sessionContent.requests.length;
				const timestamps: number[] = [];
				
				for (const request of sessionContent.requests) {
					// Extract timestamps from requests
					if (request.timestamp || request.ts || request.result?.timestamp) {
						const ts = request.timestamp || request.ts || request.result?.timestamp;
						timestamps.push(new Date(ts).getTime());
					}
					
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
					details.lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
				} else {
					// Fallback to file modification time if no timestamps in content
					details.lastInteraction = stat.mtime.toISOString();
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
		const lowerPath = filePath.toLowerCase();
		if (lowerPath.includes('copilot-cli') || lowerPath.includes('cli')) { return 'Copilot CLI'; }
		if (lowerPath.includes('cursor')) { return 'Cursor'; }
		if (lowerPath.includes('code - insiders') || lowerPath.includes('code-insiders')) { return 'VS Code Insiders'; }
		if (lowerPath.includes('vscodium')) { return 'VSCodium'; }
		if (lowerPath.includes('windsurf')) { return 'Windsurf'; }
		if (lowerPath.includes('code')) { return 'VS Code'; }
		return 'Unknown';
	}

	/**
	 * Extract full session log data including chat turns for the log viewer.
	 */
	private async getSessionLogData(sessionFile: string): Promise<SessionLogData> {
		const details = await this.getSessionFileDetails(sessionFile);
		const turns: ChatTurn[] = [];
		
		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
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
					// Delta-based format: reconstruct full state first, then extract turns
					let sessionState: any = {};
					for (const line of lines) {
						try {
							const delta = JSON.parse(line);
							sessionState = this.applyDelta(sessionState, delta);
						} catch {
							// Skip invalid lines
						}
					}
					
					// Extract session-level info
					let sessionMode: 'ask' | 'edit' | 'agent' = 'ask';
					let currentModel: string | null = null;
					
					if (sessionState.inputState?.mode?.kind) {
						sessionMode = sessionState.inputState.mode.kind as 'ask' | 'edit' | 'agent';
					}
					if (sessionState.inputState?.selectedModel?.metadata?.id) {
						currentModel = sessionState.inputState.selectedModel.metadata.id;
					}
					
					// Extract turns from reconstructed requests array
					const requests = sessionState.requests || [];
					for (let i = 0; i < requests.length; i++) {
						const request = requests[i];
						if (!request || !request.requestId) { continue; }
						
						const contextRefs = this.createEmptyContextRefs();
						const userMessage = request.message?.text || '';
						this.analyzeContextReferences(userMessage, contextRefs);
						
						// Analyze contentReferences from request
						if (request.contentReferences && Array.isArray(request.contentReferences)) {
							this.analyzeContentReferences(request.contentReferences, contextRefs);
						}
						
						// Analyze variableData from request
						if (request.variableData) {
							this.analyzeVariableData(request.variableData, contextRefs);
						}
						
						// Get model from request or fall back to session model
						const requestModel = request.modelId || 
						                     currentModel || 
						                     this.getModelFromRequest(request) || 
						                     'gpt-4';
						
						// Extract response data
						const { responseText, toolCalls, mcpTools } = this.extractResponseData(request.response || []);
						
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
							outputTokensEstimate: this.estimateTokensFromText(responseText, requestModel)
						};
						
						turns.push(turn);
					}
				} else {
					// Non-delta JSONL (Copilot CLI format)
					let turnNumber = 0;
					
					for (const line of lines) {
						try {
							const event = JSON.parse(line);
						
							// Handle Copilot CLI format (type: 'user.message')
							if (event.type === 'user.message' && event.data?.content) {
								turnNumber++;
								const contextRefs = this.createEmptyContextRefs();
								const userMessage = event.data.content;
								this.analyzeContextReferences(userMessage, contextRefs);
								const turn: ChatTurn = {
									turnNumber,
									timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : null,
									mode: 'agent', // CLI is typically agent mode
									userMessage,
									assistantResponse: '',
									model: event.model || 'gpt-4o',
									toolCalls: [],
									contextReferences: contextRefs,
									mcpTools: [],
									inputTokensEstimate: this.estimateTokensFromText(userMessage, event.model || 'gpt-4o'),
									outputTokensEstimate: 0
								};
								turns.push(turn);
							}
							
							// Handle CLI assistant response
							if (event.type === 'assistant.message' && event.data?.content && turns.length > 0) {
								const lastTurn = turns[turns.length - 1];
								lastTurn.assistantResponse += event.data.content;
								lastTurn.outputTokensEstimate = this.estimateTokensFromText(lastTurn.assistantResponse, lastTurn.model || 'gpt-4o');
							}
							
							// Handle CLI tool calls
							if ((event.type === 'tool.call' || event.type === 'tool.result') && turns.length > 0) {
								const lastTurn = turns[turns.length - 1];
								const toolName = event.data?.toolName || event.toolName || 'unknown';
								lastTurn.toolCalls.push({
									toolName,
									arguments: event.type === 'tool.call' ? JSON.stringify(event.data?.arguments || {}) : undefined,
									result: event.type === 'tool.result' ? event.data?.output : undefined
								});
							}
						} catch {
							// Skip malformed lines
						}
					}
				}
				
			} else {
				// Handle regular .json files
				const sessionContent = JSON.parse(fileContent);
				let sessionMode: 'ask' | 'edit' | 'agent' = 'ask';
				
				// Detect session-level mode
				if (sessionContent.mode?.id) {
					const modeId = sessionContent.mode.id.toLowerCase();
					if (modeId.includes('agent')) {
						sessionMode = 'agent';
					} else if (modeId.includes('edit')) {
						sessionMode = 'edit';
					}
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
						this.analyzeContextReferences(userMessage, contextRefs);
						if (request.variableData) {
							const varDataStr = JSON.stringify(request.variableData).toLowerCase();
							if (varDataStr.includes('workspace')) { contextRefs.workspace++; }
							if (varDataStr.includes('terminal')) { contextRefs.terminal++; }
							if (varDataStr.includes('vscode')) { contextRefs.vscode++; }
						}
						
						// Extract model
						const model = this.getModelFromRequest(request);
						
						// Extract response
						let assistantResponse = '';
						const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
						const mcpTools: { server: string; tool: string }[] = [];
						
						if (request.response && Array.isArray(request.response)) {
							const { responseText, toolCalls: tc, mcpTools: mcp } = this.extractResponseData(request.response);
							assistantResponse = responseText;
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
							outputTokensEstimate: this.estimateTokensFromText(assistantResponse, model)
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
			usageAnalysis
		};
	}

	/**
	 * Create empty context references object.
	 */
	private createEmptyContextRefs(): ContextReferenceUsage {
		return {
			file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
			workspace: 0, terminal: 0, vscode: 0,
			byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
		};
	}

	/**
	 * Extract response data from a response array.
	 */
	private extractResponseData(response: any[]): {
		responseText: string;
		toolCalls: { toolName: string; arguments?: string; result?: string }[];
		mcpTools: { server: string; tool: string }[];
	} {
		let responseText = '';
		const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
		const mcpTools: { server: string; tool: string }[] = [];
		
		for (const item of response) {
			// Extract text content
			if (item.value && typeof item.value === 'string') {
				responseText += item.value;
			} else if (item.kind === 'markdownContent' && item.content?.value) {
				responseText += item.content.value;
			}
			
			// Extract tool invocations
			if (item.kind === 'toolInvocationSerialized' || item.kind === 'prepareToolInvocation') {
				const toolName = item.toolId || item.toolName || item.invocationMessage?.toolName || item.toolSpecificData?.kind || 'unknown';
				toolCalls.push({
					toolName,
					arguments: item.input ? JSON.stringify(item.input) : undefined,
					result: item.result ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result)) : undefined
				});
			}
			
			// Extract MCP tools
			if (item.kind === 'mcpServersStarting' && item.didStartServerIds) {
				for (const serverId of item.didStartServerIds) {
					mcpTools.push({ server: serverId, tool: 'start' });
				}
			}
		}
		
		return { responseText, toolCalls, mcpTools };
	}

	/**
	 * Calculate estimated cost in USD based on model usage
	 * Assumes 50/50 split between input and output tokens for estimation
	 * @param modelUsage Object with model names as keys and token counts as values
	 * @returns Estimated cost in USD
	 */
	private calculateEstimatedCost(modelUsage: ModelUsage): number {
		let totalCost = 0;

		for (const [model, usage] of Object.entries(modelUsage)) {
			const pricing = this.modelPricing[model];
			
			if (pricing) {
				// Use actual input and output token counts
				const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion;
				const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion;
				
				totalCost += inputCost + outputCost;
			} else {
				// Fallback for models without pricing data - use GPT-4o-mini as default
				const fallbackPricing = this.modelPricing['gpt-4o-mini'];
				
				const inputCost = (usage.inputTokens / 1_000_000) * fallbackPricing.inputCostPerMillion;
				const outputCost = (usage.outputTokens / 1_000_000) * fallbackPricing.outputCostPerMillion;
				
				totalCost += inputCost + outputCost;
				
				this.log(`No pricing data for model '${model}', using fallback pricing (gpt-4o-mini)`);
			}
		}

		return totalCost;
	}

	private checkCopilotExtension(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		if (!copilotExtension && !copilotChatExtension) {
			this.log('⚠️ GitHub Copilot extensions not found');
		} else {
			const copilotStatus = copilotExtension ? (copilotExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			const chatStatus = copilotChatExtension ? (copilotChatExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			this.log(`GitHub Copilot: ${copilotStatus}, Chat: ${chatStatus}`);
		}

		// Check if we're in GitHub Codespaces
		const isCodespaces = process.env.CODESPACES === 'true';
		if (isCodespaces && (!copilotExtension?.isActive || !copilotChatExtension?.isActive)) {
			this.warn('⚠️ Running in Codespaces with inactive Copilot extensions');
		}
	}

	/**
	 * Get all possible VS Code user data paths for all VS Code variants
	 * Supports: Code (stable), Code - Insiders, VSCodium, remote servers, etc.
	 * 
	 * NOTE: The canonical JavaScript implementation is in:
	 * .github/skills/copilot-log-analysis/session-file-discovery.js
	 * This TypeScript implementation should mirror that logic.
	 */
	private getVSCodeUserPaths(): string[] {
		const platform = os.platform();
		const homedir = os.homedir();
		const paths: string[] = [];

		// VS Code variants to check
		const vscodeVariants = [
			'Code',               // Stable
			'Code - Insiders',    // Insiders
			'Code - Exploration', // Exploration builds
			'VSCodium',           // VSCodium
			'Cursor'              // Cursor editor
		];

		if (platform === 'win32') {
			const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
			for (const variant of vscodeVariants) {
				paths.push(path.join(appDataPath, variant, 'User'));
			}
		} else if (platform === 'darwin') {
			for (const variant of vscodeVariants) {
				paths.push(path.join(homedir, 'Library', 'Application Support', variant, 'User'));
			}
		} else {
			// Linux and other Unix-like systems
			const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
			for (const variant of vscodeVariants) {
				paths.push(path.join(xdgConfigHome, variant, 'User'));
			}
		}

		// Remote/Server paths (used in Codespaces, WSL, SSH remotes)
		const remotePaths = [
			path.join(homedir, '.vscode-server', 'data', 'User'),
			path.join(homedir, '.vscode-server-insiders', 'data', 'User'),
			path.join(homedir, '.vscode-remote', 'data', 'User'),
			path.join('/tmp', '.vscode-server', 'data', 'User'),
			path.join('/workspace', '.vscode-server', 'data', 'User')
		];

		paths.push(...remotePaths);

		return paths;
	}

	/**
	 * NOTE: The canonical JavaScript implementation is in:
	 * .github/skills/copilot-log-analysis/session-file-discovery.js
	 * This TypeScript implementation should mirror that logic.
	 */
	private async getCopilotSessionFiles(): Promise<string[]> {
		// Check short-term cache to avoid expensive filesystem scans during rapid successive calls
		const now = Date.now();
		if (this._sessionFilesCache && (now - this._sessionFilesCacheTime) < CopilotTokenTracker.SESSION_FILES_CACHE_TTL) {
			this.log(`💨 Using cached session files list (${this._sessionFilesCache.length} files, cached ${Math.round((now - this._sessionFilesCacheTime) / 1000)}s ago)`);
			return this._sessionFilesCache;
		}
		
		const sessionFiles: string[] = [];

		const platform = os.platform();
		const homedir = os.homedir();

		this.log(`🔍 Searching for Copilot session files on ${platform}`);

		// Get all possible VS Code user paths (stable, insiders, remote, etc.)
		const allVSCodePaths = this.getVSCodeUserPaths();
		this.log(`📂 Reading local folders [0/${allVSCodePaths.length}]`);

		// Track which paths we actually found
		const foundPaths: string[] = [];
		for (let i = 0; i < allVSCodePaths.length; i++) {
			const codeUserPath = allVSCodePaths[i];
			try {
				if (fs.existsSync(codeUserPath)) {
					foundPaths.push(codeUserPath);
				}
			} catch (checkError) {
				this.warn(`Could not check path ${codeUserPath}: ${checkError}`);
			}
			// Update progress
			if ((i + 1) % 5 === 0 || i === allVSCodePaths.length - 1) {
				this.log(`📂 Reading local folders [${i + 1}/${allVSCodePaths.length}]`);
			}
		}

		this.log(`✅ Found ${foundPaths.length} VS Code installation(s)`);

		try {
			// Scan all found VS Code paths for session files
			for (let i = 0; i < foundPaths.length; i++) {
				const codeUserPath = foundPaths[i];
				const pathName = path.basename(path.dirname(codeUserPath));

				// Workspace storage sessions
				const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
				try {
					if (fs.existsSync(workspaceStoragePath)) {
						try {
							const workspaceDirs = fs.readdirSync(workspaceStoragePath);

							for (const workspaceDir of workspaceDirs) {
								const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
								try {
									if (fs.existsSync(chatSessionsPath)) {
										try {
											const sessionFiles2 = fs.readdirSync(chatSessionsPath)
												.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
												.map(file => path.join(chatSessionsPath, file));
											if (sessionFiles2.length > 0) {
												this.log(`📄 Found ${sessionFiles2.length} session files in ${pathName}/workspaceStorage/${workspaceDir}`);
												sessionFiles.push(...sessionFiles2);
											}
										} catch (readError) {
											this.warn(`Could not read chat sessions in ${chatSessionsPath}: ${readError}`);
										}
									}
								} catch (checkError) {
									this.warn(`Could not check chat sessions path ${chatSessionsPath}: ${checkError}`);
								}
							}
						} catch (readError) {
							this.warn(`Could not read workspace storage in ${workspaceStoragePath}: ${readError}`);
						}
					}
				} catch (checkError) {
					this.warn(`Could not check workspace storage path ${workspaceStoragePath}: ${checkError}`);
				}

				// Global storage sessions (legacy emptyWindowChatSessions)
				const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
				try {
					if (fs.existsSync(globalStoragePath)) {
						try {
							const globalSessionFiles = fs.readdirSync(globalStoragePath)
								.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
								.map(file => path.join(globalStoragePath, file));
							if (globalSessionFiles.length > 0) {
								this.log(`📄 Found ${globalSessionFiles.length} session files in ${pathName}/globalStorage/emptyWindowChatSessions`);
								sessionFiles.push(...globalSessionFiles);
							}
						} catch (readError) {
							this.warn(`Could not read global storage in ${globalStoragePath}: ${readError}`);
						}
					}
				} catch (checkError) {
					this.warn(`Could not check global storage path ${globalStoragePath}: ${checkError}`);
				}

				// GitHub Copilot Chat extension global storage
				const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', 'github.copilot-chat');
				try {
					if (fs.existsSync(copilotChatGlobalPath)) {
						this.log(`📄 Scanning ${pathName}/globalStorage/github.copilot-chat`);
						this.scanDirectoryForSessionFiles(copilotChatGlobalPath, sessionFiles);
					}
				} catch (checkError) {
					this.warn(`Could not check Copilot Chat global storage path ${copilotChatGlobalPath}: ${checkError}`);
				}
			}

			// Check for Copilot CLI session-state directory (new location for agent mode sessions)
			const copilotCliSessionPath = path.join(os.homedir(), '.copilot', 'session-state');
			try {
				if (fs.existsSync(copilotCliSessionPath)) {
					try {
						const cliSessionFiles = fs.readdirSync(copilotCliSessionPath)
							.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
							.map(file => path.join(copilotCliSessionPath, file));
						if (cliSessionFiles.length > 0) {
							this.log(`📄 Found ${cliSessionFiles.length} session files in Copilot CLI directory`);
							sessionFiles.push(...cliSessionFiles);
						}
					} catch (readError) {
						this.warn(`Could not read Copilot CLI session path in ${copilotCliSessionPath}: ${readError}`);
					}
				}
			} catch (checkError) {
				this.warn(`Could not check Copilot CLI session path ${copilotCliSessionPath}: ${checkError}`);
			}

			// Log summary
			this.log(`✨ Total: ${sessionFiles.length} session file(s) discovered`);
			if (sessionFiles.length === 0) {
				this.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}
			
			// Update short-term cache
			this._sessionFilesCache = sessionFiles;
			this._sessionFilesCacheTime = Date.now();
		} catch (error) {
			this.error('Error getting session files:', error);
		}

		return sessionFiles;
	}

	/**
	 * Recursively scan a directory for session files (.json and .jsonl)
	 * 
	 * NOTE: Mirrors logic in .github/skills/copilot-log-analysis/session-file-discovery.js
	 */
	private scanDirectoryForSessionFiles(dir: string, sessionFiles: string[]): void {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					this.scanDirectoryForSessionFiles(fullPath, sessionFiles);
				} else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
					// Skip known non-session files (embeddings, indexes, etc.)
					if (this.isNonSessionFile(entry.name)) {
						continue;
					}
					// Only add files that look like session files (have reasonable content)
					try {
						const stats = fs.statSync(fullPath);
						if (stats.size > 0) {
							sessionFiles.push(fullPath);
						}
					} catch (e) {
						// Ignore file access errors
					}
				}
			}
		} catch (error) {
			this.warn(`Could not scan directory ${dir}: ${error}`);
		}
	}

	/**
	 * Check if a filename is a known non-session file that should be excluded
	 */
	private isNonSessionFile(filename: string): boolean {
		const nonSessionFilePatterns = [
			'embeddings', // commandEmbeddings.json, settingEmbeddings.json
			'index',      // index files
			'cache',      // cache files
			'preferences',
			'settings',
			'config'
		];
		const lowerFilename = filename.toLowerCase();
		return nonSessionFilePatterns.some(pattern => lowerFilename.includes(pattern));
	}

	private async estimateTokensFromSession(sessionFilePath: string): Promise<number> {
		try {
			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
			
			// Handle .jsonl files OR .json files with JSONL content (each line is a separate JSON object)
			const isJsonlContent = sessionFilePath.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				return this.estimateTokensFromJsonlSession(fileContent);
			}
			
			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);
			let totalInputTokens = 0;
			let totalOutputTokens = 0;

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
							if (responseItem.value) {
								totalOutputTokens += this.estimateTokensFromText(responseItem.value, this.getModelFromRequest(request));
							}
						}
					}
				}
			}

			return totalInputTokens + totalOutputTokens;
		} catch (error) {
			this.warn(`Error parsing session file ${sessionFilePath}: ${error}`);
			return 0;
		}
	}

	/**
	 * Estimate tokens from a JSONL session file (used by Copilot CLI/Agent mode and VS Code incremental format)
	 * Each line is a separate JSON object representing an event in the session
	 */
	private estimateTokensFromJsonlSession(fileContent: string): number {
		let totalTokens = 0;
		const lines = fileContent.trim().split('\n');
		
		for (const line of lines) {
			if (!line.trim()) { continue; }
			
			try {
				const event = JSON.parse(line);
				
				// Handle Copilot CLI event types
				if (event.type === 'user.message' && event.data?.content) {
					totalTokens += this.estimateTokensFromText(event.data.content);
				} else if (event.type === 'assistant.message' && event.data?.content) {
					totalTokens += this.estimateTokensFromText(event.data.content);
				} else if (event.type === 'tool.result' && event.data?.output) {
					totalTokens += this.estimateTokensFromText(event.data.output);
				} else if (event.content) {
					// Fallback for other formats that might have content
					totalTokens += this.estimateTokensFromText(event.content);
				}
				
				// Handle VS Code incremental format (kind: 2 with requests or response)
				if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
					for (const request of event.v) {
						if (request.message?.text) {
							totalTokens += this.estimateTokensFromText(request.message.text);
						}
					}
				}
				
				if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
					for (const responseItem of event.v) {
						if (responseItem.value) {
							totalTokens += this.estimateTokensFromText(responseItem.value);
						} else if (responseItem.kind === 'markdownContent' && responseItem.content?.value) {
							totalTokens += this.estimateTokensFromText(responseItem.content.value);
						}
					}
				}
			} catch (e) {
				// Skip malformed lines
			}
		}
		
		return totalTokens;
	}

	private getModelFromRequest(request: any): string {
		// Try to determine model from request metadata (most reliable source)
		// First check the top-level modelId field (VS Code format)
		if (request.modelId) {
			// Remove "copilot/" prefix if present
			return request.modelId.replace(/^copilot\//, '');
		}
		
		if (request.result && request.result.metadata && request.result.metadata.modelId) {
			return request.result.metadata.modelId.replace(/^copilot\//, '');
		}
		
		// Build a lookup map from display names to model IDs from modelPricing.json
		if (request.result && request.result.details) {
			// Create reverse lookup: displayName -> modelId
			const displayNameToModelId: { [displayName: string]: string } = {};
			for (const [modelId, pricing] of Object.entries(this.modelPricing)) {
				if (pricing.displayNames) {
					for (const displayName of pricing.displayNames) {
						displayNameToModelId[displayName] = modelId;
					}
				}
			}
			
			// Check which display name appears in the details
			// Sort by length descending to match longer names first (e.g., "Gemini 3 Pro (Preview)" before "Gemini 3 Pro")
			const sortedDisplayNames = Object.keys(displayNameToModelId).sort((a, b) => b.length - a.length);
			for (const displayName of sortedDisplayNames) {
				if (request.result.details.includes(displayName)) {
					return displayNameToModelId[displayName];
				}
			}
		}
		
		return 'gpt-4'; // default
	}

	/**
	 * Detect if file content is JSONL format (multiple JSON objects, one per line)
	 * This handles cases where .json files actually contain JSONL content
	 */
	private isJsonlContent(content: string): boolean {
		const trimmed = content.trim();
		// JSONL typically has multiple lines, each starting with { and ending with }
		if (!trimmed.includes('\n')) {
			return false; // Single line - not JSONL
		}
		const lines = trimmed.split('\n').filter(l => l.trim());
		if (lines.length < 2) {
			return false; // Need multiple lines for JSONL
		}
		// Check if first two non-empty lines look like separate JSON objects
		const firstLine = lines[0].trim();
		const secondLine = lines[1].trim();
		return firstLine.startsWith('{') && firstLine.endsWith('}') &&
		       secondLine.startsWith('{') && secondLine.endsWith('}');
	}

	/**
	 * Apply a delta to reconstruct session state from delta-based JSONL format.
	 * VS Code Insiders uses this format where:
	 * - kind: 0 = initial state (full replacement)
	 * - kind: 1 = update value at key path
	 * - kind: 2 = append to array at key path
	 * - k = key path (array of strings)
	 * - v = value
	 */
	private applyDelta(state: any, delta: any): any {
		if (typeof delta !== 'object' || delta === null) {
			return state;
		}

		const { kind, k, v } = delta;

		if (kind === 0) {
			// Initial state - full replacement
			return v;
		}

		if (!Array.isArray(k) || k.length === 0) {
			return state;
		}

		const pathArr = k.map(String);
		let root = typeof state === 'object' && state !== null ? state : {};
		let current: any = root;

		// Traverse to the parent of the target location
		for (let i = 0; i < pathArr.length - 1; i++) {
			const seg = pathArr[i];
			const nextSeg = pathArr[i + 1];
			const wantsArray = /^\d+$/.test(nextSeg);

			if (Array.isArray(current)) {
				const idx = Number(seg);
				if (!current[idx] || typeof current[idx] !== 'object') {
					current[idx] = wantsArray ? [] : {};
				}
				current = current[idx];
			} else {
				if (!current[seg] || typeof current[seg] !== 'object') {
					current[seg] = wantsArray ? [] : {};
				}
				current = current[seg];
			}
		}

		const lastSeg = pathArr[pathArr.length - 1];

		if (kind === 1) {
			// Set value at key path
			if (Array.isArray(current)) {
				current[Number(lastSeg)] = v;
			} else {
				current[lastSeg] = v;
			}
			return root;
		}

		if (kind === 2) {
			// Append value(s) to array at key path
			let target: any[];
			if (Array.isArray(current)) {
				const idx = Number(lastSeg);
				if (!Array.isArray(current[idx])) {
					current[idx] = [];
				}
				target = current[idx];
			} else {
				if (!Array.isArray(current[lastSeg])) {
					current[lastSeg] = [];
				}
				target = current[lastSeg];
			}

			if (Array.isArray(v)) {
				target.push(...v);
			} else {
				target.push(v);
			}
			return root;
		}

		return root;
	}

	private getModelTier(modelId: string): 'standard' | 'premium' | 'unknown' {
		// Determine tier based on multiplier: 0 = standard, >0 = premium
		// Look up from modelPricing.json
		const pricingInfo = this.modelPricing[modelId];
		if (pricingInfo && typeof pricingInfo.multiplier === 'number') {
			return pricingInfo.multiplier === 0 ? 'standard' : 'premium';
		}
		
		// Fallback: try to match partial model names
		for (const [key, value] of Object.entries(this.modelPricing)) {
			if (modelId.includes(key) || key.includes(modelId)) {
				if (typeof value.multiplier === 'number') {
					return value.multiplier === 0 ? 'standard' : 'premium';
				}
			}
		}
		
		return 'unknown';
	}

	private estimateTokensFromText(text: string, model: string = 'gpt-4'): number {
		// Token estimation based on character count and model
		let tokensPerChar = 0.25; // default

		// Find matching model
		for (const [modelKey, ratio] of Object.entries(this.tokenEstimators)) {
			if (model.includes(modelKey) || model.includes(modelKey.replace('-', ''))) {
				tokensPerChar = ratio;
				break;
			}
		}

		return Math.ceil(text.length * tokensPerChar);
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
			'GitHub Copilot Token Usage',
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

		// Set the HTML content
		this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);

		// Handle messages from the webview
		this.detailsPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshDetailsPanel();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
			}
		});

		// Handle panel disposal
		this.detailsPanel.onDidDispose(() => {
			this.log('📊 Details panel closed');
			this.detailsPanel = undefined;
		});
	}

	public async showChart(): Promise<void> {
		this.log('📈 Opening Chart view');
		
		// If panel already exists, just reveal it
		if (this.chartPanel) {
			this.chartPanel.reveal();
			this.log('📈 Chart view revealed (already exists)');
			return;
		}

		// Get daily stats
		const dailyStats = await this.calculateDailyStats();

		// Create webview panel
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

		// Set the HTML content
		this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, dailyStats);

		// Handle messages from the webview
		this.chartPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshChartPanel();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
			}
		});

		// Handle panel disposal
		this.chartPanel.onDidDispose(() => {
			this.log('📈 Chart view closed');
			this.chartPanel = undefined;
		});
	}

	public async showUsageAnalysis(): Promise<void> {
		this.log('📊 Opening Usage Analysis dashboard');
		
		// If panel already exists, dispose it and recreate with fresh data
		if (this.analysisPanel) {
			this.log('📊 Closing existing panel to refresh data...');
			this.analysisPanel.dispose();
			this.analysisPanel = undefined;
		}

		// Get usage analysis stats
		const analysisStats = await this.calculateUsageAnalysisStats();

		// Create webview panel
		this.analysisPanel = vscode.window.createWebviewPanel(
			'copilotUsageAnalysis',
			'Copilot Usage Analysis',
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

		this.log('✅ Usage Analysis dashboard created successfully');

		// Set the HTML content
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);

		// Handle messages from the webview
		this.analysisPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshAnalysisPanel();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
			}
		});

		// Handle panel disposal
		this.analysisPanel.onDidDispose(() => {
			this.log('📊 Usage Analysis dashboard closed');
			this.analysisPanel = undefined;
		});
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
			switch (message.command) {
				case 'openRawFile':
					try {
						await vscode.window.showTextDocument(vscode.Uri.file(sessionFilePath));
					} catch (err) {
						vscode.window.showErrorMessage('Could not open raw file: ' + sessionFilePath);
					}
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
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
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

		const initialData = JSON.stringify(logData).replace(/</g, '\\u003c');

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
		// Refresh all stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Chart view refreshed');
	}

	private async refreshAnalysisPanel(): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		this.log('🔄 Refreshing Usage Analysis dashboard');
		// Refresh all stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Usage Analysis dashboard refreshed');
	}

	private getNonce(): string {
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let text = '';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	private getDetailsHtml(webview: vscode.Webview, stats: DetailedStats): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'details.js')
		);

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify(stats).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Copilot Token Usage</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DETAILS__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}


	public async generateDiagnosticReport(): Promise<string> {
		this.log('Generating diagnostic report...');
		
		const report: string[] = [];
		
		// Header
		report.push('='.repeat(70));
		report.push('GitHub Copilot Token Tracker - Diagnostic Report');
		report.push('='.repeat(70));
		report.push('');
		
		// Extension Information
		report.push('## Extension Information');
		report.push(`Extension Version: ${vscode.extensions.getExtension('RobBos.copilot-token-tracker')?.packageJSON.version || 'Unknown'}`);
		report.push(`VS Code Version: ${vscode.version}`);
		report.push('');
		
		// System Information
		report.push('## System Information');
		report.push(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);
		report.push(`Node Version: ${process.version}`);
		report.push(`Home Directory: ${os.homedir()}`);
		report.push(`Environment: ${process.env.CODESPACES === 'true' ? 'GitHub Codespaces' : (vscode.env.remoteName || 'Local')}`);
		report.push(`VS Code Machine ID: ${vscode.env.machineId}`);
		report.push(`VS Code Session ID: ${vscode.env.sessionId}`);
		report.push(`VS Code UI Kind: ${vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web'}`);
		report.push(`Remote Name: ${vscode.env.remoteName || 'N/A'}`);
		report.push('');
		
		// GitHub Copilot Extension Status
		report.push('## GitHub Copilot Extension Status');
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');
		
		if (copilotExtension) {
			report.push(`GitHub Copilot Extension:`);
			report.push(`  - Installed: Yes`);
			report.push(`  - Version: ${copilotExtension.packageJSON.version}`);
			report.push(`  - Active: ${copilotExtension.isActive ? 'Yes' : 'No'}`);
			
			// Try to get Copilot tier information if available
			try {
				const copilotApi = copilotExtension.exports;
				if (copilotApi && copilotApi.status) {
					const status = copilotApi.status;
					// Display key status fields in a readable format
					if (typeof status === 'object') {
						Object.keys(status).forEach(key => {
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
			report.push(`  - Active: ${copilotChatExtension.isActive ? 'Yes' : 'No'}`);
		} else {
			report.push(`GitHub Copilot Chat Extension: Not Installed`);
		}
		report.push('');
		
		// Session Files Discovery
		report.push('## Session Files Discovery');
		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			report.push(`Total Session Files Found: ${sessionFiles.length}`);
			report.push('');
			
			if (sessionFiles.length > 0) {
				report.push('Session File Locations (first 20):');
				
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
					})
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
				report.push('No session files found. Possible reasons:');
				report.push('  - Copilot extensions are not active');
				report.push('  - No Copilot Chat conversations have been initiated');
				report.push('  - Sessions stored in unsupported location');
				report.push('  - Authentication required with GitHub Copilot');
			}
			report.push('');
		} catch (error) {
			report.push(`Error discovering session files: ${error}`);
			report.push('');
		}
		
		// Cache Statistics
		report.push('## Cache Statistics');
		report.push(`Cached Session Files: ${this.sessionFileCache.size}`);
		report.push(`Cache Storage: Extension Global State`);
		report.push('');
		report.push('Cache provides faster loading by storing parsed session data with file modification timestamps.');
		report.push('Files are only re-parsed when their modification time changes.');
		report.push('');
		
		// Token Statistics
		report.push('## Token Usage Statistics');
		try {
			// Ensure detailed stats calculation runs; currently used for side effects/logging
			await this.calculateDetailedStats();
			
			try {
				const sessionFiles = await this.getCopilotSessionFiles();
				report.push(`Total Session Files Found: ${sessionFiles.length}`);
				report.push("");

				// Group session files by their parent directory
				const dirCounts = new Map<string, number>();
				for (const file of sessionFiles) {
					const parent = require('path').dirname(file);
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
					report.push('Session File Locations (first 20):');
					const filesToShow = sessionFiles.slice(0, 20);
					const fileStats = await Promise.all(
						filesToShow.map(async (file) => {
							try {
								const stat = await fs.promises.stat(file);
								return { file, stat, error: null };
							} catch (error) {
								return { file, stat: null, error };
							}
						})
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
					report.push('No session files found. Possible reasons:');
					report.push('  - Copilot extensions are not active');
					report.push('  - No Copilot Chat conversations have been initiated');
					report.push('  - Sessions stored in unsupported location');
					report.push('  - Authentication required with GitHub Copilot');
				}
				report.push('');
			} catch (error) {
				report.push(`Error discovering session files: ${error}`);
				report.push('');
			}
		} catch (error) {
			report.push(`Error calculating token usage statistics: ${error}`);
			report.push('');
		}
		
		// Footer
		report.push('='.repeat(70));
		report.push(`Report Generated: ${new Date().toISOString()}`);
		report.push('='.repeat(70));
		report.push('');
		report.push('This report can be shared with the extension maintainers to help');
		report.push('troubleshoot issues. No sensitive data from your code is included.');
		report.push('');
		report.push('Submit issues at:');
		report.push(`${this.getRepositoryUrl()}/issues`);
		
		const fullReport = report.join('\n');
		this.log('Diagnostic report generated successfully');
		return fullReport;
	}

	public async showDiagnosticReport(): Promise<void> {
		this.log('🔍 Opening Diagnostic Report');

		// If panel already exists, just reveal it and trigger a refresh in the background
		if (this.diagnosticsPanel) {
			this.diagnosticsPanel.reveal();
			this.log('🔍 Diagnostic Report revealed (already exists)');
			// Load data in background and update the webview
			this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
			return;
		}

		// Create the panel immediately with loading state
		this.diagnosticsPanel = vscode.window.createWebviewPanel(
			'copilotTokenDiagnostics',
			'Diagnostic Report',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: false
			},
			{
				enableScripts: true,
				retainContextWhenHidden: true, // Keep webview context to avoid reloading session files
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.log('✅ Diagnostic Report panel created');

		// Set the HTML content immediately with loading state
		// Note: "Loading..." is the agreed contract between backend and frontend
		// The webview checks for this value to show a loading indicator
		this.diagnosticsPanel.webview.html = this.getDiagnosticReportHtml(
			this.diagnosticsPanel.webview,
			'Loading...', // Placeholder report
			[], // Empty session files
			[], // Empty detailed session files
			[], // Empty session folders
			null // No backend info yet
		);

		// Handle messages from the webview
		this.diagnosticsPanel.webview.onDidReceiveMessage(async (message) => {
			this.log(`DEBUG Diagnostics webview message: ${JSON.stringify(message)}`);
			switch (message.command) {
				case 'copyReport':
					await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
					vscode.window.showInformationMessage('Diagnostic report copied to clipboard');
					break;
				case 'openIssue':
					await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
					vscode.window.showInformationMessage('Diagnostic report copied to clipboard. Please paste it into the GitHub issue.');
					const shortBody = encodeURIComponent('The diagnostic report has been copied to the clipboard. Please paste it below.');
					const issueUrl = `${this.getRepositoryUrl()}/issues/new?body=${shortBody}`;
					await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
					break;
				case 'openSessionFile':
					if (message.file) {
						try {
							// Open the session file in the log viewer
							await this.showLogViewer(message.file);
						} catch (err) {
							vscode.window.showErrorMessage('Could not open log viewer: ' + message.file);
						}
					}
					break;

				case 'openFormattedJsonlFile':
					if (message.file) {
						try {
							await this.showFormattedJsonlFile(message.file);
						} catch (err) {
							const errorMsg = err instanceof Error ? err.message : String(err);
							vscode.window.showErrorMessage('Could not open formatted file: ' + message.file + ' (' + errorMsg + ')');
						}
					}
					break;

				case 'revealPath':
					if (message.path) {
						try {
							const fs = require('fs');
							const pathModule = require('path');
							const normalized = pathModule.normalize(message.path);

							// If the path exists and is a directory, open it directly in the OS file manager.
							// Using `vscode.env.openExternal` with a file URI reliably opens the folder itself.
							try {
								const stat = await fs.promises.stat(normalized);
								if (stat.isDirectory()) {
									await vscode.env.openExternal(vscode.Uri.file(normalized));
								} else {
									// For files, reveal the file in OS (select it)
									await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(normalized));
								}
							} catch (err) {
								// If the stat fails, fallback to revealFileInOS which may still work
								await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(normalized));
							}
						} catch (err) {
							vscode.window.showErrorMessage('Could not reveal: ' + message.path);
						}
					}
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'clearCache':
					this.log('DEBUG clearCache message received from diagnostics webview');
					await this.clearCache();
					// After clearing cache, refresh the diagnostic report if it's open
					if (this.diagnosticsPanel) {
						// Send completion message to webview before refreshing
						this.diagnosticsPanel.webview.postMessage({ command: 'cacheCleared' });
						// Wait a moment for the message to be processed
						await new Promise(resolve => setTimeout(resolve, 500));
						// Simply refresh the diagnostic report by revealing it again
						// This will trigger a rebuild with fresh data
						await this.showDiagnosticReport();
					}
					break;
				case 'configureBackend':
					// Execute the configureBackend command if it exists
					try {
						await vscode.commands.executeCommand('copilot-token-tracker.configureBackend');
					} catch (err) {
						// If command is not registered, show settings
						vscode.window.showInformationMessage(
							'Backend configuration is available in settings. Search for "Copilot Token Tracker: Backend" in settings.',
							'Open Settings'
						).then(choice => {
							if (choice === 'Open Settings') {
								vscode.commands.executeCommand('workbench.action.openSettings', 'copilotTokenTracker.backend');
							}
						});
					}
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('workbench.action.openSettings', 'copilotTokenTracker.backend');
					break;
			}
		});

		// Handle panel disposal
		this.diagnosticsPanel.onDidDispose(() => {
			this.log('🔍 Diagnostic Report closed');
			this.diagnosticsPanel = undefined;
		});

		// Load data in background and update the webview when ready
		this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
	}

	/**
	 * Load all diagnostic data in the background and update the webview progressively.
	 */
	private async loadDiagnosticDataInBackground(panel: vscode.WebviewPanel): Promise<void> {
		try {
			this.log('🔄 Loading diagnostic data in background...');

			// CRITICAL: Ensure stats have been calculated at least once to populate cache
			// If this is the first diagnostic panel open and no stats exist yet,
			// force an update now so the cache is populated before we load session files.
			// This dramatically improves performance on first load (near 100% cache hit rate).
			if (!this.lastDetailedStats) {
				this.log('⚡ No cached stats found - forcing initial stats calculation to populate cache...');
				await this.updateTokenStats(true);
				this.log('✅ Cache populated, proceeding with diagnostics load');
			}

			// Load the diagnostic report
			const report = await this.generateDiagnosticReport();
			this.lastDiagnosticReport = report;

			// Get session files
			const sessionFiles = await this.getCopilotSessionFiles();

			// Get first 20 session files with stats (quick preview)
			const sessionFileData: { file: string; size: number; modified: string }[] = [];
			for (const file of sessionFiles.slice(0, 20)) {
				try {
					const stat = await fs.promises.stat(file);
					sessionFileData.push({
						file,
						size: stat.size,
						modified: stat.mtime.toISOString()
					});
				} catch {
					// Skip inaccessible files
				}
			}

			// Build folder counts grouped by top-level VS Code user folder (editor roots)
			const dirCounts = new Map<string, number>();
			const pathModule = require('path');
			for (const file of sessionFiles) {
				const parts = file.split(/[\\\/]/);
				const userIdx = parts.findIndex((p: string) => p.toLowerCase() === 'user');
				let editorRoot = '';
				if (userIdx > 0) {
					const rootParts = parts.slice(0, Math.min(parts.length, userIdx + 2));
					editorRoot = pathModule.join(...rootParts);
				} else {
					editorRoot = pathModule.dirname(file);
				}
				dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
			}
			const sessionFolders = Array.from(dirCounts.entries()).map(([dir, count]) => ({ 
				dir, 
				count, 
				editorName: this.getEditorNameFromRoot(dir) 
			}));

			// Get backend storage info
			const backendStorageInfo = await this.getBackendStorageInfo();

			// Check if panel is still open before updating
			if (!this.isPanelOpen(panel)) {
				this.log('Diagnostic panel closed during data load, aborting update');
				return;
			}

			// Send the loaded data to the webview
			panel.webview.postMessage({
				command: 'diagnosticDataLoaded',
				report,
				sessionFiles: sessionFileData,
				sessionFolders,
				backendStorageInfo
			});

			this.log('✅ Diagnostic data loaded and sent to webview');

			// Now load detailed session files in the background
			this.loadSessionFilesInBackground(panel, sessionFiles);
		} catch (error) {
			this.error(`Failed to load diagnostic data: ${error}`);
			// Send error to webview if panel is still open
			if (this.isPanelOpen(panel)) {
				panel.webview.postMessage({
					command: 'diagnosticDataError',
					error: String(error)
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
		sessionFiles: string[]
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
					const stat = await fs.promises.stat(file);
					return { file, mtime: stat.mtime.getTime() };
				} catch {
					return { file, mtime: 0 };
				}
			})
		);

		const sortedFiles = fileStats
			.sort((a, b) => b.mtime - a.mtime)
			.map(item => item.file);
		
		// Process up to 500 most recent session files
		for (const file of sortedFiles.slice(0, 500)) {
			// Check if panel was disposed
			if (!this.isPanelOpen(panel)) {
				this.log('Diagnostic panel closed, stopping background load');
				return;
			}
			
			try {
				const details = await this.getSessionFileDetails(file);
				// Only include sessions with activity (lastInteraction or file modified time) within the last 14 days
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
			await panel.webview.postMessage({
				command: 'sessionFilesLoaded',
				detailedSessionFiles
			});
			
			// Calculate and log cache performance for this operation
			const cacheHits = this._cacheHits - initialCacheHits;
			const cacheMisses = this._cacheMisses - initialCacheMisses;
			const totalAccesses = cacheHits + cacheMisses;
			const hitRate = totalAccesses > 0 ? ((cacheHits / totalAccesses) * 100).toFixed(1) : '0.0';
			
			this.log(`Loaded ${detailedSessionFiles.length} session files in background (Cache: ${cacheHits} hits, ${cacheMisses} misses, ${hitRate}% hit rate)`);
			
			// Mark diagnostics as loaded so we don't reload unnecessarily
			if (panel === this.diagnosticsPanel) {
				this.diagnosticsHasLoadedFiles = true;
			}
		} catch (err) {
			// Panel may have been disposed
			this.log('Could not send session files to panel (may be closed)');
		}
	}

	/**
	 * Get backend storage information for diagnostics
	 */
	private async getBackendStorageInfo(): Promise<any> {
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const enabled = config.get<boolean>('backend.enabled', false);
		const storageAccount = config.get<string>('backend.storageAccount', '');
		const subscriptionId = config.get<string>('backend.subscriptionId', '');
		const resourceGroup = config.get<string>('backend.resourceGroup', '');
		const aggTable = config.get<string>('backend.aggTable', 'usageAggDaily');
		const eventsTable = config.get<string>('backend.eventsTable', 'usageEvents');
		const authMode = config.get<string>('backend.authMode', 'entraId');
		const sharingProfile = config.get<string>('backend.sharingProfile', 'off');
		
		// Get last sync time from global state
		const lastSyncAt = this.context.globalState.get<number>('backend.lastSyncAt');
		const lastSyncTime = lastSyncAt ? new Date(lastSyncAt).toISOString() : null;
		
		// Check if backend is configured (has required settings)
		const isConfigured = enabled && storageAccount && subscriptionId && resourceGroup;
		
		// Get unique device count from session files (estimate based on unique workspace roots)
		const sessionFiles = await this.getCopilotSessionFiles();
		const workspaceIds = new Set<string>();
		const pathModule = require('path');
		
		for (const file of sessionFiles) {
			const parts = file.split(/[\\\/]/);
			const workspaceStorageIdx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
			if (workspaceStorageIdx >= 0 && workspaceStorageIdx < parts.length - 1) {
				const workspaceId = parts[workspaceStorageIdx + 1];
				if (workspaceId && workspaceId.length > 10) {
					workspaceIds.add(workspaceId);
				}
			}
		}
		
		return {
			enabled,
			isConfigured,
			storageAccount,
			subscriptionId: subscriptionId ? subscriptionId.substring(0, 8) + '...' : '',
			resourceGroup,
			aggTable,
			eventsTable,
			authMode,
			sharingProfile,
			lastSyncTime,
			deviceCount: workspaceIds.size,
			sessionCount: sessionFiles.length,
			recordCount: null // Will be populated from Azure if configured
		};
	}

	private getDiagnosticReportHtml(
		webview: vscode.Webview, 
		report: string, 
		sessionFiles: { file: string; size: number; modified: string }[],
		detailedSessionFiles: SessionFileDetails[],
		sessionFolders: { dir: string; count: number }[] = [],
		backendStorageInfo: any = null
	): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'diagnostics.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		// Get cache information
		let cacheSizeInMB = 0;
		try {
			// Estimate cache size by serializing to JSON
			const cacheData = Object.fromEntries(this.sessionFileCache);
			const jsonString = JSON.stringify(cacheData);
			cacheSizeInMB = (jsonString.length * 2) / (1024 * 1024); // UTF-16 encoding (2 bytes per char)
		} catch {
			cacheSizeInMB = 0;
		}
		
		// Try to read the persisted cache from VS Code global state to show its actual storage status
		let persistedCacheSummary = 'Not found in VS Code Global State';
		try {
			const persisted = this.context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache');
			if (persisted && typeof persisted === 'object') {
				const count = Object.keys(persisted).length;
				persistedCacheSummary = `VS Code Global State - sessionFileCache (${count} entr${count === 1 ? 'y' : 'ies'})`;
			}
		} catch (e) {
			persistedCacheSummary = 'Error reading VS Code Global State';
		}

		// Try to locate the actual storage file (state DB) for the extension global state
		let storageFilePath: string | null = null;
		try {
			const extensionId = 'RobBos.copilot-token-tracker';
			const userPaths = this.getVSCodeUserPaths();
			for (const userPath of userPaths) {
				try {
					const candidate = path.join(userPath, 'globalStorage', extensionId);
					if (fs.existsSync(candidate)) {
						const files = fs.readdirSync(candidate);
						// Look for likely state files
						const match = files.find(f => f.includes('state') || f.endsWith('.vscdb') || f.endsWith('.json'));
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
			size: this.sessionFileCache.size,
			sizeInMB: cacheSizeInMB,
			lastUpdated: this.sessionFileCache.size > 0 ? new Date().toISOString() : null,
			location: persistedCacheSummary,
			storagePath: storageFilePath
		};

		const initialData = JSON.stringify({ report, sessionFiles, detailedSessionFiles, sessionFolders, cacheInfo, backendStorageInfo }).replace(/</g, '\\u003c');

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
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getChartHtml(webview: vscode.Webview, dailyStats: DailyTokenStats[]): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'chart.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		// Transform dailyStats into the structure expected by the webview
		const labels = dailyStats.map(d => d.date);
		const tokensData = dailyStats.map(d => d.tokens);
		const sessionsData = dailyStats.map(d => d.sessions);

		// Aggregate model usage across all days
		const allModels = new Set<string>();
		dailyStats.forEach(d => Object.keys(d.modelUsage).forEach(m => allModels.add(m)));

		const modelColors = [
			{ bg: 'rgba(54, 162, 235, 0.6)', border: 'rgba(54, 162, 235, 1)' },
			{ bg: 'rgba(255, 99, 132, 0.6)', border: 'rgba(255, 99, 132, 1)' },
			{ bg: 'rgba(75, 192, 192, 0.6)', border: 'rgba(75, 192, 192, 1)' },
			{ bg: 'rgba(153, 102, 255, 0.6)', border: 'rgba(153, 102, 255, 1)' },
			{ bg: 'rgba(255, 159, 64, 0.6)', border: 'rgba(255, 159, 64, 1)' },
			{ bg: 'rgba(255, 205, 86, 0.6)', border: 'rgba(255, 205, 86, 1)' },
			{ bg: 'rgba(201, 203, 207, 0.6)', border: 'rgba(201, 203, 207, 1)' },
			{ bg: 'rgba(100, 181, 246, 0.6)', border: 'rgba(100, 181, 246, 1)' }
		];

		const modelDatasets = Array.from(allModels).map((model, idx) => {
			const color = modelColors[idx % modelColors.length];
			return {
				label: getModelDisplayName(model),
				data: dailyStats.map(d => {
					const usage = d.modelUsage[model];
					return usage ? usage.inputTokens + usage.outputTokens : 0;
				}),
				backgroundColor: color.bg,
				borderColor: color.border,
				borderWidth: 1
			};
		});

		// Aggregate editor usage across all days
		const allEditors = new Set<string>();
		dailyStats.forEach(d => Object.keys(d.editorUsage).forEach(e => allEditors.add(e)));

		const editorDatasets = Array.from(allEditors).map((editor, idx) => {
			const color = modelColors[idx % modelColors.length];
			return {
				label: editor,
				data: dailyStats.map(d => d.editorUsage[editor]?.tokens || 0),
				backgroundColor: color.bg,
				borderColor: color.border,
				borderWidth: 1
			};
		});

		// Calculate editor totals for summary cards
		const editorTotalsMap: Record<string, number> = {};
		dailyStats.forEach(d => {
			Object.entries(d.editorUsage).forEach(([editor, usage]) => {
				editorTotalsMap[editor] = (editorTotalsMap[editor] || 0) + usage.tokens;
			});
		});

		const totalTokens = tokensData.reduce((a, b) => a + b, 0);
		const totalSessions = sessionsData.reduce((a, b) => a + b, 0);

		const chartData = {
			labels,
			tokensData,
			sessionsData,
			modelDatasets,
			editorDatasets,
			editorTotalsMap,
			dailyCount: dailyStats.length,
			totalTokens,
			avgTokensPerDay: dailyStats.length > 0 ? Math.round(totalTokens / dailyStats.length) : 0,
			totalSessions,
			lastUpdated: new Date().toISOString()
		};

		const initialData = JSON.stringify(chartData).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Copilot Token Usage Chart</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_CHART__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getUsageAnalysisHtml(webview: vscode.Webview, stats: UsageAnalysisStats): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'usage.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify({
			today: stats.today,
			last30Days: stats.last30Days,
			month: stats.month,
			lastUpdated: stats.lastUpdated.toISOString()
		}).replace(/</g, '\\u003c');

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
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	public dispose(): void {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
		}
		if (this.initialDelayTimeout) {
			clearTimeout(this.initialDelayTimeout);
			this.log('Cleared initial delay timeout during disposal');
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
		// Save cache to storage before disposing (fire-and-forget async operation)
		// Note: Cache loss during abnormal shutdown is acceptable as it will rebuild on next startup
		// We can't await here since dispose() is synchronous
		this.saveCacheToStorage().catch(err => {
			// Output channel will be disposed, so log to console as fallback
			console.error('Error saving cache during disposal:', err);
		});
		if (this.logViewerPanel) {
			this.logViewerPanel.dispose();
		}
		if (this.diagnosticsPanel) {
			this.diagnosticsPanel.dispose();
		}
		this.statusBarItem.dispose();
		this.outputChannel.dispose();
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Create the token tracker
	const tokenTracker = new CopilotTokenTracker(context.extensionUri, context);

	// Wire up backend facade and commands so the diagnostics webview can launch the
	// configuration wizard. Uses tokenTracker logging and helpers via casting to any.
	try {
		const backendFacade = new BackendFacade({
			context,
			log: (m: string) => (tokenTracker as any).log(m),
			warn: (m: string) => (tokenTracker as any).warn(m),
			updateTokenStats: () => (tokenTracker as any).updateTokenStats(),
			calculateEstimatedCost: (modelUsage: any) => {
				let total = 0;
				const pricing = (modelPricingData as any).pricing || {};
				for (const [model, usage] of Object.entries(modelUsage || {})) {
					const p = pricing[model] || pricing['gpt-4o-mini'];
					if (!p) { continue; }
					const usageData = usage as { inputTokens?: number; outputTokens?: number };
					total += ((usageData.inputTokens || 0) / 1_000_000) * p.inputCostPerMillion;
					total += ((usageData.outputTokens || 0) / 1_000_000) * p.outputCostPerMillion;
				}
				return total;
			},
			co2Per1kTokens: 0.2,
			waterUsagePer1kTokens: 0.3,
			co2AbsorptionPerTreePerYear: 21000,
			getCopilotSessionFiles: () => (tokenTracker as any).getCopilotSessionFiles(),
			estimateTokensFromText: (text: string, model?: string) => (tokenTracker as any).estimateTokensFromText(text, model),
			getModelFromRequest: (req: any) => (tokenTracker as any).getModelFromRequest(req),
			getSessionFileDataCached: (p: string, m: number, s: number) => (tokenTracker as any).getSessionFileDataCached(p, m, s)
		});

		const backendHandler = new BackendCommandHandler({
			facade: backendFacade as any,
			integration: undefined,
			calculateEstimatedCost: (mu: any) => 0,
			warn: (m: string) => (tokenTracker as any).warn(m),
			log: (m: string) => (tokenTracker as any).log(m)
		});

		const configureBackendCommand = vscode.commands.registerCommand('copilot-token-tracker.configureBackend', async () => {
			await backendHandler.handleConfigureBackend();
		});

		context.subscriptions.push(configureBackendCommand);
	} catch (err) {
		// If backend wiring fails for any reason, don't block activation - fall back to settings behavior.
		(tokenTracker as any).warn('Failed to wire backend commands: ' + String(err));
	}

	// Register the refresh command
	const refreshCommand = vscode.commands.registerCommand('copilot-token-tracker.refresh', async () => {
		tokenTracker.log('Refresh command called');
		await tokenTracker.updateTokenStats();
		vscode.window.showInformationMessage('Copilot token usage refreshed');
	});

	// Register the show details command
	const showDetailsCommand = vscode.commands.registerCommand('copilot-token-tracker.showDetails', async () => {
		tokenTracker.log('Show details command called');
		await tokenTracker.showDetails();
	});

	// Register the show chart command
	const showChartCommand = vscode.commands.registerCommand('copilot-token-tracker.showChart', async () => {
		tokenTracker.log('Show chart command called');
		await tokenTracker.showChart();
	});

	// Register the show usage analysis command
	const showUsageAnalysisCommand = vscode.commands.registerCommand('copilot-token-tracker.showUsageAnalysis', async () => {
		tokenTracker.log('Show usage analysis command called');
		await tokenTracker.showUsageAnalysis();
	});

	// Register the generate diagnostic report command
	const generateDiagnosticReportCommand = vscode.commands.registerCommand('copilot-token-tracker.generateDiagnosticReport', async () => {
		tokenTracker.log('Generate diagnostic report command called');
		await tokenTracker.showDiagnosticReport();
	});

	// Register the clear cache command
	const clearCacheCommand = vscode.commands.registerCommand('copilot-token-tracker.clearCache', async () => {
		tokenTracker.log('Clear cache command called');
		await tokenTracker.clearCache();
	});

	// Add to subscriptions for proper cleanup
	context.subscriptions.push(refreshCommand, showDetailsCommand, showChartCommand, showUsageAnalysisCommand, generateDiagnosticReportCommand, clearCacheCommand, tokenTracker);

	tokenTracker.log('Extension activation complete');
}

export function deactivate() {
	// Extension cleanup is handled in the CopilotTokenTracker class
}
