import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';
import * as packageJson from '../package.json';
import {getModelDisplayName} from './webview/shared/modelUtils';
import { DetailsView } from './views/detailsView';
import { ChartView } from './views/chartView';
import { UsageAnalysisView } from './views/usageAnalysisView';
import { LogViewerView } from './views/logViewerView';
import { DiagnosticsView } from './views/diagnosticsView';
import { SessionFileDiscovery } from './utils/sessionFileDiscovery';
import { TokenEstimator } from './utils/tokenEstimator';
import { SessionCacheManager } from './utils/sessionCacheManager';
import { Logger } from './utils/logger';
import { EditorTypeDetector } from './utils/editorTypeDetector';

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
	displayNames?: string[];
}

interface EditorUsage {
	[editorType: string]: {
		tokens: number;
		sessions: number;
	};
}

interface DetailedStats {
	today: {
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
	};
	month: {
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
	};
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
	usageAnalysis?: SessionUsageAnalysis; // New analysis data
}

// New interfaces for usage analysis
interface SessionUsageAnalysis {
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
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
	file: number;        // #file references
	selection: number;   // #selection references
	symbol: number;      // #symbol references
	codebase: number;    // #codebase references
	workspace: number;   // @workspace references
	terminal: number;    // @terminal references
	vscode: number;      // @vscode references
}

interface McpToolUsage {
	total: number;
	byServer: { [serverName: string]: number };
	byTool: { [toolName: string]: number };
}

interface UsageAnalysisStats {
	today: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	lastUpdated: Date;
}

interface UsageAnalysisPeriod {
	sessions: number;
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
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
	private diagnosticsPanel?: vscode.WebviewPanel;
	// Tracks whether the diagnostics panel has already received its session files
	private diagnosticsHasLoadedFiles: boolean = false;
	// Cache of the last loaded detailed session files for diagnostics view
	private diagnosticsCachedFiles: SessionFileDetails[] = [];
	private logViewerPanel?: vscode.WebviewPanel;
	private statusBarItem: vscode.StatusBarItem;
	private readonly extensionUri: vscode.Uri;
	private readonly context: vscode.ExtensionContext;

	// View handlers
	private detailsView: DetailsView;
	private chartView: ChartView;
	private usageAnalysisView: UsageAnalysisView;
	private logViewerView: LogViewerView;
	private diagnosticsView: DiagnosticsView;

	// Utility classes
	private logger: Logger;
	private sessionFileDiscovery: SessionFileDiscovery;
	private tokenEstimator: TokenEstimator;
	private cacheManager: SessionCacheManager;

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
	private lastDetailedStats: DetailedStats | undefined;
	private tokenEstimators: { [key: string]: number } = tokenEstimatorsData.estimators;
	private co2Per1kTokens = 0.2; // gCO2e per 1000 tokens, a rough estimate
	private co2AbsorptionPerTreePerYear = 21000; // grams of CO2 per tree per year
	private waterUsagePer1kTokens = 0.3; // liters of water per 1000 tokens, based on data center usage estimates

	// Model pricing data - loaded from modelPricing.json
	// Reference: OpenAI API Pricing (https://openai.com/api/pricing/) - Retrieved December 2025
	// Reference: Anthropic Claude Pricing (https://www.anthropic.com/pricing) - Standard rates
	// Note: GitHub Copilot uses these models but pricing may differ from direct API usage
	// These are reference prices for cost estimation purposes only
	private modelPricing: { [key: string]: ModelPricing } = modelPricingData.pricing;

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
		return EditorTypeDetector.getEditorTypeFromPath(filePath);
	}

	/**
	 * Determine a friendly editor name from an editor root path (folder name)
	 * e.g. 'C:\...\AppData\Roaming\Code' -> 'VS Code'
	 */
	private getEditorNameFromRoot(rootPath: string): string {
		return EditorTypeDetector.getEditorNameFromRoot(rootPath);
	}

	// Logging methods
	public log(message: string): void {
		this.logger.log(message);
	}

	private warn(message: string): void {
		this.logger.warn(message);
	}

	private error(message: string, error?: any): void {
		this.logger.error(message, error);
	}

	// Cache management methods - delegate to cache manager
	private isCacheValid(filePath: string, currentMtime: number): boolean {
		return this.cacheManager.isCacheValid(filePath, currentMtime);
	}

	private getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.cacheManager.getCachedSessionData(filePath);
	}

	private setCachedSessionData(filePath: string, data: SessionFileCache): void {
		this.cacheManager.setCachedSessionData(filePath, data);
	}

	private clearExpiredCache(): void {
		this.cacheManager.clearExpiredCache();
	}

	// Persistent cache storage methods - delegate to cache manager
	private loadCacheFromStorage(): void {
		this.cacheManager.loadCacheFromStorage();
	}

	private async saveCacheToStorage(): Promise<void> {
		await this.cacheManager.saveCacheToStorage();
	}

	public async clearCache(): Promise<void> {
		   try {
			   // Show the output channel so users can see what's happening
			   this.outputChannel.show(true);
			   this.log('[DEBUG] clearCache() called');
			   this.log('Clearing session file cache...');
			   
			   const cacheSize = this.cacheManager.getCacheSize();
			   await this.cacheManager.clearCache();
			   // Reset diagnostics loaded flag so the diagnostics view will reload files
			this.diagnosticsHasLoadedFiles = false;
			this.diagnosticsCachedFiles = [];
               
			   this.log(`Cache cleared successfully. Removed ${cacheSize} entries.`);
			   vscode.window.showInformationMessage('Cache cleared successfully. Reloading statistics...');
			   
			   // Trigger a refresh after clearing the cache
			   this.log('Reloading token statistics...');
			   await this.updateTokenStats();
			   this.log('Token statistics reloaded successfully.');
		   } catch (error) {
			   this.outputChannel.show(true);
			   this.error('Error clearing cache:', error);
			   vscode.window.showErrorMessage('Failed to clear cache: ' + error);
		   }
	}

	constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.extensionUri = extensionUri;
		this.context = context;
		
		// Create output channel for extension logs (needed by utility classes)
		this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot Token Tracker');
		
		// Initialize utility classes
		this.logger = new Logger(this.outputChannel);
		this.cacheManager = new SessionCacheManager(context, this.log.bind(this), this.error.bind(this));
		this.sessionFileDiscovery = new SessionFileDiscovery(this.log.bind(this), this.warn.bind(this));
		this.tokenEstimator = new TokenEstimator(tokenEstimatorsData.estimators, modelPricingData.pricing, this.warn.bind(this));
		
		// Initialize view handlers
		this.detailsView = new DetailsView(extensionUri);
		this.chartView = new ChartView(extensionUri);
		this.usageAnalysisView = new UsageAnalysisView(extensionUri);
		this.logViewerView = new LogViewerView(extensionUri);
		this.diagnosticsView = new DiagnosticsView(extensionUri);
		
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

		// Update every 5 minutes and save cache
		this.updateInterval = setInterval(() => {
			this.updateTokenStats(true); // Silent update from timer
			this.saveCacheToStorage();
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
				this.detailsPanel.webview.html = this.detailsView.getDetailsHtml(this.detailsPanel.webview, detailedStats);
			}

			// If the chart panel is open, update its content
			if (this.chartPanel) {
				const dailyStats = await this.calculateDailyStats();
				this.chartPanel.webview.html = this.chartView.getChartHtml(this.chartPanel.webview, dailyStats);
			}

			// If the analysis panel is open, update its content
			if (this.analysisPanel) {
				const analysisStats = await this.calculateUsageAnalysisStats();
				this.analysisPanel.webview.html = this.usageAnalysisView.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);
			}

			this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Month: ${detailedStats.month.tokens}`);
			// Store the stats for reuse without recalculation
			this.lastDetailedStats = detailedStats;
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
						const tokens = await this.estimateTokensFromSessionCached(sessionFile, fileStats.mtime.getTime());

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

		const todayStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		const monthStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };

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
					
					// Skip files modified before the current month (quick filter)
					// This is the main performance optimization - filters out old sessions without reading file content
					if (fileStats.mtime < monthStart) {
						skippedFiles++;
						continue;
					}
					
					// For files within current month, check if data is cached to avoid redundant reads
					const mtime = fileStats.mtime.getTime();
					const wasCached = this.isCacheValid(sessionFile, mtime);
					
					// Get interactions count (uses cache if available)
					const interactions = await this.countInteractionsInSessionCached(sessionFile, mtime);
					
					// Skip empty sessions (no interactions = just opened chat panel, no messages sent)
					if (interactions === 0) {
						skippedFiles++;
						continue;
					}
					
					// Get remaining data (all use cache if available)
					const tokens = await this.estimateTokensFromSessionCached(sessionFile, mtime);
					const modelUsage = await this.getModelUsageFromSessionCached(sessionFile, mtime);
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
					else {
						// Session is too old (no activity in current month), skip it
						skippedFiles++;
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile}: ${fileError}`);
				}
			}

			this.log(`✅ Analysis complete: Today ${todayStats.sessions} sessions, Month ${monthStats.sessions} sessions`);
			if (skippedFiles > 0) {
				this.log(`⏭️ Skipped ${skippedFiles} session file(s) (empty or no activity in current month)`);
			}
			const totalCacheAccesses = cacheHits + cacheMisses;
			this.log(`💾 Cache performance: ${cacheHits} hits, ${cacheMisses} misses (${totalCacheAccesses > 0 ? ((cacheHits / totalCacheAccesses) * 100).toFixed(1) : 0}% hit rate)`);
		} catch (error) {
			this.error('Error calculating detailed stats:', error);
		}

		const todayCo2 = (todayStats.tokens / 1000) * this.co2Per1kTokens;
		const monthCo2 = (monthStats.tokens / 1000) * this.co2Per1kTokens;
		
		const todayWater = (todayStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const monthWater = (monthStats.tokens / 1000) * this.waterUsagePer1kTokens;

		const todayCost = this.calculateEstimatedCost(todayStats.modelUsage);
		const monthCost = this.calculateEstimatedCost(monthStats.modelUsage);

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
			lastUpdated: now
		};

		return result;
	}

	private formatDateKey(date: Date): string {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
	}

	private async calculateDailyStats(): Promise<DailyTokenStats[]> {
		const now = new Date();
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
		
		// Map to store daily stats by date string (YYYY-MM-DD)
		const dailyStatsMap = new Map<string, DailyTokenStats>();
		
		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`📈 Preparing chart data from ${sessionFiles.length} session file(s)...`);
			
			for (const sessionFile of sessionFiles) {
				try {
					const fileStats = fs.statSync(sessionFile);
					
					// Only process files modified in the current month
					if (fileStats.mtime >= monthStart) {
						const tokens = await this.estimateTokensFromSessionCached(sessionFile, fileStats.mtime.getTime());
						const interactions = await this.countInteractionsInSessionCached(sessionFile, fileStats.mtime.getTime());
						const modelUsage = await this.getModelUsageFromSessionCached(sessionFile, fileStats.mtime.getTime());
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
		
		// Fill in missing dates between the first date and today
		if (dailyStatsArray.length > 0) {
			const firstDate = new Date(dailyStatsArray[0].date);
			const today = new Date();
			
			// Create a set of existing dates for quick lookup
			const existingDates = new Set(dailyStatsArray.map(s => s.date));
			
			// Generate all dates from first date to today
			const allDates: string[] = [];
			const currentDate = new Date(firstDate);
			
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
		}
		
		return dailyStatsArray;
	}

	/**
	 * Calculate usage analysis statistics for today and this month
	 */
	private async calculateUsageAnalysisStats(): Promise<UsageAnalysisStats> {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		const emptyPeriod = (): UsageAnalysisPeriod => ({
			sessions: 0,
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} }
		});

		const todayStats = emptyPeriod();
		const monthStats = emptyPeriod();

		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`Processing ${sessionFiles.length} session files for usage analysis`);

			for (const sessionFile of sessionFiles) {
				try {
					const fileStats = fs.statSync(sessionFile);

					if (fileStats.mtime >= monthStart) {
						const analysis = await this.getUsageAnalysisFromSessionCached(sessionFile, fileStats.mtime.getTime());
						
						// Add to month stats
						monthStats.sessions++;
						this.mergeUsageAnalysis(monthStats, analysis);

						// Add to today stats if modified today
						if (fileStats.mtime >= todayStart) {
							todayStats.sessions++;
							this.mergeUsageAnalysis(todayStats, analysis);
						}
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile} for usage analysis: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating usage analysis stats:', error);
		}

		return {
			today: todayStats,
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
		period.contextReferences.symbol += analysis.contextReferences.symbol;
		period.contextReferences.codebase += analysis.contextReferences.codebase;
		period.contextReferences.workspace += analysis.contextReferences.workspace;
		period.contextReferences.terminal += analysis.contextReferences.terminal;
		period.contextReferences.vscode += analysis.contextReferences.vscode;

		// Merge MCP tools
		period.mcpTools.total += analysis.mcpTools.total;
		for (const [server, count] of Object.entries(analysis.mcpTools.byServer)) {
			period.mcpTools.byServer[server] = (period.mcpTools.byServer[server] || 0) + count;
		}
		for (const [tool, count] of Object.entries(analysis.mcpTools.byTool)) {
			period.mcpTools.byTool[tool] = (period.mcpTools.byTool[tool] || 0) + count;
		}
	}

	private async countInteractionsInSession(sessionFile: string): Promise<number> {
		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Handle .jsonl files (Copilot CLI format and VS Code incremental format)
			if (sessionFile.endsWith('.jsonl')) {
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

		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Handle .jsonl files (Copilot CLI format and VS Code incremental format)
			if (sessionFile.endsWith('.jsonl')) {
				const lines = fileContent.trim().split('\n');
				// Default model for CLI sessions - they may not specify the model per event
				let defaultModel = 'gpt-4o';
				
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						
						// Handle VS Code incremental format - extract model from session header
						if (event.kind === 0 && event.v?.inputState?.selectedModel?.metadata?.id) {
							defaultModel = event.v.inputState.selectedModel.metadata.id;
						}
						
						// Handle model changes (kind: 1 with selectedModel update)
						if (event.kind === 1 && event.k?.includes('selectedModel') && event.v?.metadata?.id) {
							defaultModel = event.v.metadata.id;
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
								if (request.message?.text) {
									modelUsage[model].inputTokens += this.estimateTokensFromText(request.message.text, model);
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
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} }
		};

		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Handle .jsonl files (Copilot CLI format and VS Code incremental format)
			if (sessionFile.endsWith('.jsonl')) {
				const lines = fileContent.trim().split('\n');
				let sessionMode = 'ask'; // Default mode
				
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						
						// Handle VS Code incremental format - detect mode from session header
						if (event.kind === 0 && event.v?.inputState?.mode?.kind) {
							sessionMode = event.v.inputState.mode.kind;
						}
						
						// Handle mode changes (kind: 1 with mode update)
						if (event.kind === 1 && event.k?.includes('mode') && event.v?.kind) {
							sessionMode = event.v.kind;
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
							}
						}
						
						// Handle VS Code incremental format - tool invocations in responses
						if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
							for (const responseItem of event.v) {
								if (responseItem.kind === 'toolInvocationSerialized') {
									analysis.toolCalls.total++;
									const toolName = responseItem.toolSpecificData?.kind || 'unknown';
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
					
					// Analyze response for tool calls and MCP tools
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							// Detect tool invocations
							if (responseItem.kind === 'toolInvocationSerialized' || 
							    responseItem.kind === 'prepareToolInvocation') {
								analysis.toolCalls.total++;
								const toolName = responseItem.toolName || 
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
						}
					}
					
					// Check metadata for tool calls
					if (request.result?.metadata) {
						const metadataStr = JSON.stringify(request.result.metadata).toLowerCase();
						// Look for tool-related metadata
						if (metadataStr.includes('tool') || metadataStr.includes('function')) {
							// This is a heuristic - actual structure may vary
							try {
								const metadata = request.result.metadata;
								if (metadata.toolCalls || metadata.tools || metadata.functionCalls) {
									const toolData = metadata.toolCalls || metadata.tools || metadata.functionCalls;
									if (Array.isArray(toolData)) {
										for (const toolItem of toolData) {
											analysis.toolCalls.total++;
											// Try to extract tool name from various possible fields
											const toolName = toolItem.name || toolItem.function?.name || toolItem.toolName || 'metadata-tool';
											analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
										}
									}
								}
							} catch (e) {
								// Ignore parsing errors
							}
						}
					}
				}
			}
		} catch (error) {
			this.warn(`Error analyzing session usage from ${sessionFile}: ${error}`);
		}

		return analysis;
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

	// Cached versions of session file reading methods
	private async getSessionFileDataCached(sessionFilePath: string, mtime: number): Promise<SessionFileCache> {
		// Check if we have valid cached data
		const cached = this.getCachedSessionData(sessionFilePath);
		if (cached && cached.mtime === mtime) {
			return cached;
		}

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

		this.setCachedSessionData(sessionFilePath, sessionData);
		return sessionData;
	}

	private async estimateTokensFromSessionCached(sessionFilePath: string, mtime: number): Promise<number> {
		const sessionData = await this.getSessionFileDataCached(sessionFilePath, mtime);
		return sessionData.tokens;
	}

	private async countInteractionsInSessionCached(sessionFile: string, mtime: number): Promise<number> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime);
		return sessionData.interactions;
	}

	private async getModelUsageFromSessionCached(sessionFile: string, mtime: number): Promise<ModelUsage> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime);
		return sessionData.modelUsage;
	}

	private async getUsageAnalysisFromSessionCached(sessionFile: string, mtime: number): Promise<SessionUsageAnalysis> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime);
		return sessionData.usageAnalysis || {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} }
		};
	}

	/**
	 * Get detailed session file information for diagnostics view.
	 * Analyzes session files to extract interactions, context references, and timestamps.
	 */
	private async getSessionFileDetails(sessionFile: string): Promise<SessionFileDetails> {
		const stat = await fs.promises.stat(sessionFile);
		const details: SessionFileDetails = {
			file: sessionFile,
			size: stat.size,
			modified: stat.mtime.toISOString(),
			interactions: 0,
			contextReferences: {
				file: 0, selection: 0, symbol: 0, codebase: 0,
				workspace: 0, terminal: 0, vscode: 0
			},
			firstInteraction: null,
			lastInteraction: null,
			editorSource: this.detectEditorSource(sessionFile)
		};

		// Determine top-level editor root path for this session file (up to the folder before 'User')
		try {
			const parts = sessionFile.split(/[/\\\\]/);
			const userIdx = parts.findIndex(p => p.toLowerCase() === 'user');
			if (userIdx > 0) {
				details.editorRoot = parts.slice(0, userIdx).join(require('path').sep);
			} else {
				details.editorRoot = require('path').dirname(sessionFile);
			}
			// Also populate a friendly editor name for this file
			details['editorName'] = this.getEditorNameFromRoot(details.editorRoot || '');
		} catch (e) {
			details.editorRoot = require('path').dirname(sessionFile);
			details['editorName'] = this.getEditorNameFromRoot(details.editorRoot || '');
		}

		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Handle .jsonl files (Copilot CLI format and VS Code incremental format)
			if (sessionFile.endsWith('.jsonl')) {
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
			
			if (sessionFile.endsWith('.jsonl')) {
				// Handle JSONL formats (CLI and VS Code incremental)
				const lines = fileContent.trim().split('\n');
				let turnNumber = 0;
				let sessionMode: 'ask' | 'edit' | 'agent' = 'ask';
				let currentModel: string | null = null;
				
				// For VS Code incremental format, we need to accumulate requests
				const pendingRequests: Map<string, ChatTurn> = new Map();
				
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						
						// Handle VS Code incremental format - detect mode from session header
						if (event.kind === 0 && event.v?.inputState?.mode?.kind) {
							sessionMode = event.v.inputState.mode.kind as 'ask' | 'edit' | 'agent';
							if (event.v.inputState.selectedModel?.metadata?.id) {
								currentModel = event.v.inputState.selectedModel.metadata.id;
							}
						}
						
						// Handle mode changes
						if (event.kind === 1 && event.k?.includes('mode') && event.v?.kind) {
							sessionMode = event.v.kind as 'ask' | 'edit' | 'agent';
						}
						
						// Handle model changes
						if (event.kind === 1 && event.k?.includes('selectedModel') && event.v?.metadata?.id) {
							currentModel = event.v.metadata.id;
						}
						
						// Handle VS Code incremental format - new requests
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								if (request.requestId) {
									turnNumber++;
									const contextRefs = this.createEmptyContextRefs();
									const userMessage = request.message?.text || '';
									this.analyzeContextReferences(userMessage, contextRefs);
									
									const turn: ChatTurn = {
										turnNumber,
										timestamp: request.timestamp ? new Date(request.timestamp).toISOString() : null,
										mode: sessionMode,
										userMessage,
										assistantResponse: '',
										model: currentModel,
										toolCalls: [],
										contextReferences: contextRefs,
										mcpTools: [],
										inputTokensEstimate: this.estimateTokensFromText(userMessage, currentModel || 'gpt-4'),
										outputTokensEstimate: 0
									};
									
									// Process response if present
									if (request.response && Array.isArray(request.response)) {
										const { responseText, toolCalls, mcpTools } = this.extractResponseData(request.response);
										turn.assistantResponse = responseText;
										turn.toolCalls = toolCalls;
										turn.mcpTools = mcpTools;
										turn.outputTokensEstimate = this.estimateTokensFromText(responseText, currentModel || 'gpt-4');
									}
									
									pendingRequests.set(request.requestId, turn);
								}
							}
						}
						
						// Handle VS Code incremental format - response updates
						if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
							// Find the request this response belongs to
							const requestIdPath = event.k?.find((k: string) => k.match(/^\d+$/));
							if (requestIdPath !== undefined) {
								// This is updating an existing request's response
								for (const turn of pendingRequests.values()) {
									const { responseText, toolCalls, mcpTools } = this.extractResponseData(event.v);
									if (responseText) {
										turn.assistantResponse += responseText;
										turn.outputTokensEstimate = this.estimateTokensFromText(turn.assistantResponse, turn.model || 'gpt-4');
									}
									turn.toolCalls.push(...toolCalls);
									turn.mcpTools.push(...mcpTools);
									break;
								}
							}
						}
						
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
					} catch (e) {
						// Skip malformed lines
					}
				}
				
				// Add pending requests to turns
				turns.push(...pendingRequests.values());
				turns.sort((a, b) => a.turnNumber - b.turnNumber);
				
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
			usageAnalysis = await this.getUsageAnalysisFromSessionCached(sessionFile, mtimeMs);
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
			file: 0, selection: 0, symbol: 0, codebase: 0,
			workspace: 0, terminal: 0, vscode: 0
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
				const toolName = item.toolName || item.invocationMessage?.toolName || item.toolSpecificData?.kind || 'unknown';
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
		return this.sessionFileDiscovery.getVSCodeUserPaths();
	}

	/**
	 * NOTE: The canonical JavaScript implementation is in:
	 * .github/skills/copilot-log-analysis/session-file-discovery.js
	 * This TypeScript implementation should mirror that logic.
	 */
	private async getCopilotSessionFiles(): Promise<string[]> {
		return await this.sessionFileDiscovery.getCopilotSessionFiles();
	}

	private async estimateTokensFromSession(sessionFilePath: string): Promise<number> {
		return await this.tokenEstimator.estimateTokensFromSession(sessionFilePath);
	}

	private getModelFromRequest(request: any): string {
		return this.tokenEstimator.getModelFromRequest(request);
	}

	private estimateTokensFromText(text: string, model: string = 'gpt-4'): number {
		return this.tokenEstimator.estimateTokensFromText(text, model);
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
		this.detailsPanel.webview.html = this.detailsView.getDetailsHtml(this.detailsPanel.webview, stats);

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
		this.chartPanel.webview.html = this.chartView.getChartHtml(this.chartPanel.webview, dailyStats);

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
		
		// If panel already exists, just reveal it
		if (this.analysisPanel) {
			this.analysisPanel.reveal();
			this.log('📊 Usage Analysis dashboard revealed (already exists)');
			return;
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
		this.analysisPanel.webview.html = this.usageAnalysisView.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);

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
		this.logViewerPanel.webview.html = this.logViewerView.getLogViewerHtml(this.logViewerPanel.webview, logData);

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

	private getLogViewerHtml(webview: vscode.Webview, logData: SessionLogData): string {
		return this.logViewerView.getLogViewerHtml(webview, logData);
	}

	private async refreshDetailsPanel(): Promise<void> {
		if (!this.detailsPanel) {
			return;
		}

		this.log('🔄 Refreshing Details panel');
		// Update token stats and refresh the webview content
		const stats = await this.updateTokenStats();
		if (stats) {
			this.detailsPanel.webview.html = this.detailsView.getDetailsHtml(this.detailsPanel.webview, stats);
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


	private getDetailsHtml(webview: vscode.Webview, stats: DetailedStats): string {
		return this.detailsView.getDetailsHtml(webview, stats);
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
		report.push(`Cached Session Files: ${this.cacheManager.getCacheSize()}`);
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

		// If panel already exists, just reveal it and update content
		if (this.diagnosticsPanel) {
			this.diagnosticsPanel.reveal();
			this.log('🔍 Diagnostic Report revealed (already exists)');
			// Optionally, refresh content if needed
			const report = await this.generateDiagnosticReport();
			const sessionFiles = await this.getCopilotSessionFiles();
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
				// Walk up the path to find the 'User' directory which is the canonical editor folder root
				const parts = file.split(/[\\\/]/);
				// Find index of 'User' folder in path parts (case-insensitive)
				const userIdx = parts.findIndex(p => p.toLowerCase() === 'user');
				let editorRoot = '';
				if (userIdx > 0) {
					// Reconstruct path including 'User' and the next folder (e.g., .../Roaming/Code/User/workspaceStorage)
					// Include two extra levels after the 'User' segment so we can distinguish
					// between 'User\\workspaceStorage' and 'User\\globalStorage'.
					const rootParts = parts.slice(0, Math.min(parts.length, userIdx + 2));
					editorRoot = pathModule.join(...rootParts);
				} else {
					// Fallback: use parent dir of the file
					editorRoot = pathModule.dirname(file);
				}

				dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
			}
			const sessionFolders = Array.from(dirCounts.entries()).map(([dir, count]) => ({ dir, count, editorName: this.getEditorTypeFromPath(dir) }));
			// Update the existing diagnostics webview without replacing its HTML
			try {
				await this.diagnosticsPanel.webview.postMessage({
					command: 'updateDiagnosticsReport',
					report,
					sessionFileData,
					sessionFolders
				});
				this.log('Diagnostics webview updated via postMessage');
			} catch (err) {
				this.log('Could not post update to diagnostics webview, falling back to reset');
				this.log(err instanceof Error ? err.message : String(err));
				this.diagnosticsPanel.webview.html = this.getDiagnosticReportHtml(this.diagnosticsPanel.webview, report, sessionFileData, [], sessionFolders);
			}
				// If we have previously loaded session files, re-send them to the webview
				if (this.diagnosticsHasLoadedFiles && this.diagnosticsCachedFiles.length > 0) {
					try {
						await this.diagnosticsPanel.webview.postMessage({
							command: 'sessionFilesLoaded',
							detailedSessionFiles: this.diagnosticsCachedFiles
						});
						this.log('Re-sent cached diagnostics session files to webview');
					} catch (err) {
						this.log('Could not re-send cached session files to diagnostics webview');
						this.log(err instanceof Error ? err.message : String(err));
					}
				} else {
					// Only reload session files in background if we haven't already loaded them
					if (!this.diagnosticsHasLoadedFiles) {
						this.loadSessionFilesInBackground(this.diagnosticsPanel, sessionFiles);
					}
				}
			return;
		}

		const report = await this.generateDiagnosticReport();
		const sessionFiles = await this.getCopilotSessionFiles();
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
			const userIdx = parts.findIndex(p => p.toLowerCase() === 'user');
			let editorRoot = '';
			if (userIdx > 0) {
				// Include 'User' plus one following folder (e.g., 'User\\workspaceStorage' or 'User\\globalStorage')
				const rootParts = parts.slice(0, Math.min(parts.length, userIdx + 2));
				editorRoot = pathModule.join(...rootParts);
			} else {
				editorRoot = pathModule.dirname(file);
			}
			dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
		}
		const sessionFolders = Array.from(dirCounts.entries()).map(([dir, count]) => ({ dir, count, editorName: this.getEditorNameFromRoot(dir) }));

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

		this.log('✅ Diagnostic Report created successfully');

		// Set the HTML content immediately with empty session files (shows loading state)
		this.diagnosticsPanel.webview.html = this.getDiagnosticReportHtml(this.diagnosticsPanel.webview, report, sessionFileData, [], sessionFolders);

		// Handle messages from the webview
		this.diagnosticsPanel.webview.onDidReceiveMessage(async (message) => {
			this.log(`[DEBUG] Diagnostics webview message: ${JSON.stringify(message)}`);
			switch (message.command) {
				case 'copyReport':
					await vscode.env.clipboard.writeText(report);
					vscode.window.showInformationMessage('Diagnostic report copied to clipboard');
					break;
				case 'openIssue':
					await vscode.env.clipboard.writeText(report);
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
					this.log('[DEBUG] clearCache message received from diagnostics webview');
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
			}
		});

		// Handle panel disposal
		this.diagnosticsPanel.onDidDispose(() => {
			this.log('🔍 Diagnostic Report closed');
			this.diagnosticsPanel = undefined;
		});

		// Load detailed session files in the background and send to webview when ready
		this.loadSessionFilesInBackground(this.diagnosticsPanel, sessionFiles);
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
			if (!panel.visible && panel.viewColumn === undefined) {
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
			this.log(`Loaded ${detailedSessionFiles.length} session files in background`);
			// Mark diagnostics as loaded so we don't reload unnecessarily
			if (panel === this.diagnosticsPanel) {
				this.diagnosticsHasLoadedFiles = true;
			}
		} catch (err) {
			// Panel may have been disposed
			this.log('Could not send session files to panel (may be closed)');
		}
	}

	private getCacheInfo() {
		// Get cache information
		let cacheSizeInMB = 0;
		const cacheSize = this.cacheManager.getCacheSize();
		try {
			// Estimate cache size - rough approximation based on cache size
			// Each cache entry is roughly 1KB (this is a simplification)
			cacheSizeInMB = (cacheSize * 1024) / (1024 * 1024);
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

		return {
			size: cacheSize,
			sizeInMB: cacheSizeInMB,
			lastUpdated: cacheSize > 0 ? new Date().toISOString() : null,
			location: persistedCacheSummary,
			storagePath: storageFilePath
		};
	}

	private getDiagnosticReportHtml(
		webview: vscode.Webview, 
		report: string, 
		sessionFiles: { file: string; size: number; modified: string }[],
		detailedSessionFiles: SessionFileDetails[],
		sessionFolders: { dir: string; count: number; editorName: string }[] = []
	): string {
		const cacheInfo = this.getCacheInfo();
		return this.diagnosticsView.getDiagnosticReportHtml(webview, report, sessionFiles, detailedSessionFiles, sessionFolders, cacheInfo);
	}

	private getChartHtml(webview: vscode.Webview, dailyStats: DailyTokenStats[]): string {
		return this.chartView.getChartHtml(webview, dailyStats);
	}

	private getUsageAnalysisHtml(webview: vscode.Webview, stats: UsageAnalysisStats): string {
		return this.usageAnalysisView.getUsageAnalysisHtml(webview, stats);
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
