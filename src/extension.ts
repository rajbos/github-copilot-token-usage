import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';
import * as packageJson from '../package.json';

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

class CopilotTokenTracker implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private readonly extensionUri: vscode.Uri;

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
	private isCacheValid(filePath: string, currentMtime: number): boolean {
		const cached = this.sessionFileCache.get(filePath);
		return cached !== undefined && cached.mtime === currentMtime;
	}

	private getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.sessionFileCache.get(filePath);
	}

	private setCachedSessionData(filePath: string, data: SessionFileCache): void {
		this.sessionFileCache.set(filePath, data);
		
		// Limit cache size to prevent memory issues (keep last 1000 files)
		if (this.sessionFileCache.size > 1000) {
			const entries = Array.from(this.sessionFileCache.entries());
			// Remove oldest entries (simple FIFO approach)
			const toRemove = entries.slice(0, this.sessionFileCache.size - 1000);
			for (const [key] of toRemove) {
				this.sessionFileCache.delete(key);
			}
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



	constructor(extensionUri: vscode.Uri) {
		this.extensionUri = extensionUri;
		// Create output channel for extension logs
		this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot Token Tracker');
		this.log('Constructor called');

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

		// Update every 5 minutes
		this.updateInterval = setInterval(() => {
			this.updateTokenStats();
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
			this.log(`Copilot extensions found but not active yet - delaying initial update by ${delaySeconds} seconds to allow extensions to load`);
			this.log(`Setting timeout for ${new Date(Date.now() + (delaySeconds * 1000)).toLocaleTimeString()}`);

			this.initialDelayTimeout = setTimeout(() => {
				try {
					this.log('🚀 Delayed initial update starting now...');
					this.recheckCopilotExtensionsAfterDelay();
					this.updateTokenStats();
				} catch (error) {
					this.error('Error in delayed initial update:', error);
				}
			}, delaySeconds * 1000);

			this.log(`Timeout ID: ${this.initialDelayTimeout} set successfully`);

			// Add a heartbeat to prove the timeout mechanism is working
			setTimeout(() => {
				this.log('💓 Heartbeat: 2 seconds elapsed, timeout still pending...');
			}, 2 * 1000);
		} else if (!copilotExtension && !copilotChatExtension) {
			this.log('No Copilot extensions found - starting immediate update');
			setTimeout(() => this.updateTokenStats(), 100);
		} else {
			this.log('Copilot extensions are active - starting immediate update');
			setTimeout(() => this.updateTokenStats(), 100);
		}
	}

	private recheckCopilotExtensionsAfterDelay(): void {
		this.log('Re-checking Copilot extensions after delay...');

		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		if (copilotExtension) {
			this.log(`GitHub Copilot extension: ${copilotExtension.isActive ? 'NOW ACTIVE' : 'STILL INACTIVE'}`);
		}

		if (copilotChatExtension) {
			this.log(`GitHub Copilot Chat extension: ${copilotChatExtension.isActive ? 'NOW ACTIVE' : 'STILL INACTIVE'}`);
		}

		// If still not active, provide guidance
		if ((copilotExtension && !copilotExtension.isActive) || (copilotChatExtension && !copilotChatExtension.isActive)) {
			this.warn('Some Copilot extensions are still not active after 60-second delay');
			this.log('This may be normal in Codespaces - extensions might need manual activation or authentication');
		}
	}

	public async updateTokenStats(): Promise<DetailedStats | undefined> {
		try {
			this.log('Updating token stats...');
			const detailedStats = await this.calculateDetailedStats((completed, total) => {
				const percentage = Math.round((completed / total) * 100);
				this.statusBarItem.text = `$(loading~spin) Analyzing Logs: ${percentage}%`;
			});

			this.statusBarItem.text = `$(symbol-numeric) ${detailedStats.today.tokens.toLocaleString()} | ${detailedStats.month.tokens.toLocaleString()}`;

			// Create detailed tooltip with markdown support
			const tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown('## 🤖 GitHub Copilot Token Usage\n\n');
			tooltip.appendMarkdown('### 📅 Today\n');
			tooltip.appendMarkdown(`**Tokens:** ${detailedStats.today.tokens.toLocaleString()}\n\n`);
			tooltip.appendMarkdown(`**Est. Cost:** $${detailedStats.today.estimatedCost.toFixed(4)}\n\n`);
			tooltip.appendMarkdown(`**CO₂ Est.:** ${detailedStats.today.co2.toFixed(2)}g\n\n`);
			tooltip.appendMarkdown(`**Water Est.:** ${detailedStats.today.waterUsage.toFixed(3)}L\n\n`);
			tooltip.appendMarkdown(`**Sessions:** ${detailedStats.today.sessions}\n\n`);
			tooltip.appendMarkdown(`**Avg Interactions/Session:** ${detailedStats.today.avgInteractionsPerSession}\n\n`);
			tooltip.appendMarkdown(`**Avg Tokens/Session:** ${detailedStats.today.avgTokensPerSession.toLocaleString()}\n\n`);
			tooltip.appendMarkdown('### 📊 This Month\n');
			tooltip.appendMarkdown(`**Tokens:** ${detailedStats.month.tokens.toLocaleString()}\n\n`);
			tooltip.appendMarkdown(`**Est. Cost:** $${detailedStats.month.estimatedCost.toFixed(4)}\n\n`);
			tooltip.appendMarkdown(`**CO₂ Est.:** ${detailedStats.month.co2.toFixed(2)}g\n\n`);
			tooltip.appendMarkdown(`**Water Est.:** ${detailedStats.month.waterUsage.toFixed(3)}L\n\n`);
			tooltip.appendMarkdown(`**Sessions:** ${detailedStats.month.sessions}\n\n`);
			tooltip.appendMarkdown(`**Avg Interactions/Session:** ${detailedStats.month.avgInteractionsPerSession}\n\n`);
			tooltip.appendMarkdown(`**Avg Tokens/Session:** ${detailedStats.month.avgTokensPerSession.toLocaleString()}\n\n`);
			tooltip.appendMarkdown('---\n\n');
			tooltip.appendMarkdown('*Cost estimates based on actual input/output token ratios*\n\n');
			tooltip.appendMarkdown('*Updates automatically every 5 minutes*');

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
				this.analysisPanel.webview.html = this.getUsageAnalysisHtml(analysisStats);
			}

			this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Month: ${detailedStats.month.tokens}`);
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
			this.log(`Processing ${sessionFiles.length} session files for detailed stats`);

			if (sessionFiles.length === 0) {
				this.warn('No session files found - this might indicate an issue in GitHub Codespaces or different VS Code configuration');
			}

			let cacheHits = 0;
			let cacheMisses = 0;

			for (let i = 0; i < sessionFiles.length; i++) {
				const sessionFile = sessionFiles[i];
				
				if (progressCallback) {
					progressCallback(i + 1, sessionFiles.length);
				}

				try {
					const fileStats = fs.statSync(sessionFile);

					if (fileStats.mtime >= monthStart) {
						// Check if data is cached before making calls
						const wasCached = this.isCacheValid(sessionFile, fileStats.mtime.getTime());
						
						const tokens = await this.estimateTokensFromSessionCached(sessionFile, fileStats.mtime.getTime());
						const interactions = await this.countInteractionsInSessionCached(sessionFile, fileStats.mtime.getTime());
						const modelUsage = await this.getModelUsageFromSessionCached(sessionFile, fileStats.mtime.getTime());
						const editorType = this.getEditorTypeFromPath(sessionFile);

						// Update cache statistics
						if (wasCached) {
							cacheHits++;
						} else {
							cacheMisses++;
						}

						this.log(`Session ${path.basename(sessionFile)}: ${tokens} tokens, ${interactions} interactions, editor: ${editorType}`);

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

						if (fileStats.mtime >= todayStart) {
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
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile}: ${fileError}`);
				}
			}

			this.log(`Cache performance - Hits: ${cacheHits}, Misses: ${cacheMisses}, Hit Rate: ${sessionFiles.length > 0 ? ((cacheHits / sessionFiles.length) * 100).toFixed(1) : 0}%`);
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

		this.log(`Today: ${todayStats.interactions} total interactions / ${todayStats.sessions} sessions = ${result.today.avgInteractionsPerSession} avg`);
		this.log(`Month: ${monthStats.interactions} total interactions / ${monthStats.sessions} sessions = ${result.month.avgInteractionsPerSession} avg`);

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
			this.log(`Processing ${sessionFiles.length} session files for daily chart stats`);
			
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
		const dailyStatsArray = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
		
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
			
			// Handle .jsonl files (Copilot CLI format)
			if (sessionFile.endsWith('.jsonl')) {
				const lines = fileContent.trim().split('\n');
				let interactions = 0;
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						if (event.type === 'user.message') {
							interactions++;
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
			
			// Handle .jsonl files (Copilot CLI format)
			if (sessionFile.endsWith('.jsonl')) {
				const lines = fileContent.trim().split('\n');
				// Default model for CLI sessions - they may not specify the model per event
				const defaultModel = 'gpt-4o';
				
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						const model = event.model || defaultModel;
						
						if (!modelUsage[model]) {
							modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
						}
						
						if (event.type === 'user.message' && event.data?.content) {
							modelUsage[model].inputTokens += this.estimateTokensFromText(event.data.content, model);
						} else if (event.type === 'assistant.message' && event.data?.content) {
							modelUsage[model].outputTokens += this.estimateTokensFromText(event.data.content, model);
						} else if (event.type === 'tool.result' && event.data?.output) {
							// Tool outputs are typically input context
							modelUsage[model].inputTokens += this.estimateTokensFromText(event.data.output, model);
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
			
			// Handle .jsonl files (Copilot CLI format)
			if (sessionFile.endsWith('.jsonl')) {
				const lines = fileContent.trim().split('\n');
				
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						
						// Detect mode from event type - CLI can be chat or agent mode
						// We check for indicators of autonomous agent behavior
						if (event.type === 'user.message') {
							// Check if this appears to be an agent mode interaction
							// Agent mode typically has tool calls, file operations, etc.
							// For now, default to chat (ask) for CLI unless we see agent indicators
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
						
						// Detect tool calls
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
		this.log('Checking GitHub Copilot extension status');

		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		this.log(`GitHub Copilot extension: ${copilotExtension ? 'FOUND' : 'NOT FOUND'}`);
		if (copilotExtension) {
			this.log(`  - Active: ${copilotExtension.isActive}`);
			this.log(`  - Version: ${copilotExtension.packageJSON.version}`);
			if (!copilotExtension.isActive) {
				this.log(`  - Status: Extension found but not yet activated (likely still loading)`);
			}
		}

		this.log(`GitHub Copilot Chat extension: ${copilotChatExtension ? 'FOUND' : 'NOT FOUND'}`);
		if (copilotChatExtension) {
			this.log(`  - Active: ${copilotChatExtension.isActive}`);
			this.log(`  - Version: ${copilotChatExtension.packageJSON.version}`);
			if (!copilotChatExtension.isActive) {
				this.log(`  - Status: Extension found but not yet activated (likely still loading)`);
			}
		}

		// Check if we're in GitHub Codespaces
		const isCodespaces = process.env.CODESPACES === 'true';
		const isVSCodeServer = process.env.VSCODE_IPC_HOOK_CLI || process.env.VSCODE_SERVER;

		this.log(`Environment detection:`);
		this.log(`  - GitHub Codespaces: ${isCodespaces}`);
		this.log(`  - VS Code Server: ${!!isVSCodeServer}`);
		this.log(`  - Remote Name: ${vscode.env.remoteName || 'local'}`);
		this.log(`  - VS Code Machine ID: ${vscode.env.machineId}`);
		this.log(`  - VS Code Session ID: ${vscode.env.sessionId}`);

		// Enhanced analysis for Codespaces
		if (isCodespaces) {
			if (!copilotExtension || !copilotChatExtension) {
				this.warn('Running in GitHub Codespaces but Copilot extension(s) not found - this may explain why no session files are located');
			} else if (!copilotExtension.isActive || !copilotChatExtension.isActive) {
				this.warn('Copilot extensions found but NOT ACTIVE in Codespaces - this is likely why no chat sessions exist');
				this.log('Possible reasons:');
				this.log('  1. Extensions may not be pre-activated in Codespaces');
				this.log('  2. User may need to manually activate Copilot');
				this.log('  3. Copilot may not be configured for this workspace');
				this.log('  4. Authentication issues with GitHub Copilot in Codespaces');
			} else {
				this.log('Copilot extensions are active in Codespaces - investigating session storage...');
			}
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
		const sessionFiles: string[] = [];

		const platform = os.platform();
		const homedir = os.homedir();

		// Debug environment information
		this.log('Debugging getCopilotSessionFiles');
		this.log(`Platform: ${platform}`);
		this.log(`Home directory: ${homedir}`);
		this.log(`Environment variables:`);
		this.log(`  APPDATA: ${process.env.APPDATA}`);
		this.log(`  HOME: ${process.env.HOME}`);
		this.log(`  XDG_CONFIG_HOME: ${process.env.XDG_CONFIG_HOME}`);
		this.log(`  VSCODE_PORTABLE: ${process.env.VSCODE_PORTABLE}`);
		this.log(`  CODESPACES: ${process.env.CODESPACES}`);
		this.log(`  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: ${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`);

		// Get all possible VS Code user paths (stable, insiders, remote, etc.)
		const allVSCodePaths = this.getVSCodeUserPaths();
		this.log(`Checking ${allVSCodePaths.length} VS Code path variants`);

		// Track which paths we actually found
		const foundPaths: string[] = [];
		for (const codeUserPath of allVSCodePaths) {
			if (fs.existsSync(codeUserPath)) {
				foundPaths.push(codeUserPath);
				this.log(`Found VS Code path: ${codeUserPath}`);
			}
		}

		try {
			// Scan all found VS Code paths for session files
			for (const codeUserPath of foundPaths) {
				this.log(`Scanning VS Code path: ${codeUserPath}`);

				// Workspace storage sessions
				const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
				if (fs.existsSync(workspaceStoragePath)) {
					const workspaceDirs = fs.readdirSync(workspaceStoragePath);
					this.log(`Found ${workspaceDirs.length} workspace directories in ${path.basename(path.dirname(codeUserPath))}`);

					for (const workspaceDir of workspaceDirs) {
						const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
						if (fs.existsSync(chatSessionsPath)) {
							const sessionFiles2 = fs.readdirSync(chatSessionsPath)
								.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
								.map(file => path.join(chatSessionsPath, file));
							if (sessionFiles2.length > 0) {
								this.log(`Found ${sessionFiles2.length} session files in ${workspaceDir}`);
								sessionFiles.push(...sessionFiles2);
							}
						}
					}
				}

				// Global storage sessions (legacy emptyWindowChatSessions)
				const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
				if (fs.existsSync(globalStoragePath)) {
					const globalSessionFiles = fs.readdirSync(globalStoragePath)
						.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
						.map(file => path.join(globalStoragePath, file));
					if (globalSessionFiles.length > 0) {
						this.log(`Found ${globalSessionFiles.length} global session files`);
						sessionFiles.push(...globalSessionFiles);
					}
				}

				// GitHub Copilot Chat extension global storage
				const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', 'github.copilot-chat');
				if (fs.existsSync(copilotChatGlobalPath)) {
					this.log(`Found github.copilot-chat global storage: ${copilotChatGlobalPath}`);
					this.scanDirectoryForSessionFiles(copilotChatGlobalPath, sessionFiles);
				}
			}

			// Check for Copilot CLI session-state directory (new location for agent mode sessions)
			const copilotCliSessionPath = path.join(os.homedir(), '.copilot', 'session-state');
			this.log(`Checking Copilot CLI session-state path: ${copilotCliSessionPath}`);
			if (fs.existsSync(copilotCliSessionPath)) {
				this.log(`Found Copilot CLI session-state directory`);
				const cliSessionFiles = fs.readdirSync(copilotCliSessionPath)
					.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
					.map(file => path.join(copilotCliSessionPath, file));
				if (cliSessionFiles.length > 0) {
					this.log(`Found ${cliSessionFiles.length} Copilot CLI session files`);
					sessionFiles.push(...cliSessionFiles);
				}
			}

			// Log summary
			this.log(`Total session files found: ${sessionFiles.length}`);
			if (sessionFiles.length > 0) {
				this.log('Session file paths:');
				sessionFiles.slice(0, 20).forEach((file, index) => {
					this.log(`  ${index + 1}: ${file}`);
				});
				if (sessionFiles.length > 20) {
					this.log(`  ... and ${sessionFiles.length - 20} more files`);
				}
			} else {
				this.warn('No GitHub Copilot session files found. This could be because:');
				this.log('  1. Copilot extensions are not active');
				this.log('  2. No Copilot Chat conversations have been initiated yet');
				this.log('  3. Sessions are stored in a different location not yet supported');
				this.log('  4. User needs to authenticate with GitHub Copilot first');
				this.log('  Run: node .github/skills/copilot-log-analysis/diagnose-session-files.js for detailed diagnostics');
			}
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

	private async estimateTokensFromSession(sessionFilePath: string): Promise<number> {
		try {
			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
			
			// Handle .jsonl files (each line is a separate JSON object)
			if (sessionFilePath.endsWith('.jsonl')) {
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
	 * Estimate tokens from a JSONL session file (used by Copilot CLI/Agent mode)
	 * Each line is a separate JSON object representing an event in the session
	 */
	private estimateTokensFromJsonlSession(fileContent: string): number {
		let totalTokens = 0;
		const lines = fileContent.trim().split('\n');
		
		for (const line of lines) {
			if (!line.trim()) { continue; }
			
			try {
				const event = JSON.parse(line);
				
				// Handle different event types from the Copilot CLI session format
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
			} catch (e) {
				// Skip malformed lines
			}
		}
		
		return totalTokens;
	}

	private getModelFromRequest(request: any): string {
		// Try to determine model from request metadata
		if (request.result && request.result.metadata && request.result.metadata.modelId) {
			return request.result.metadata.modelId;
		}
		if (request.result && request.result.details) {
			if (request.result.details.includes('Claude Sonnet 3.5')) { return 'claude-sonnet-3.5'; }
			if (request.result.details.includes('Claude Sonnet 3.7')) { return 'claude-sonnet-3.7'; }
			if (request.result.details.includes('Claude Sonnet 4')) { return 'claude-sonnet-4'; }
			if (request.result.details.includes('Gemini 2.5 Pro')) { return 'gemini-2.5-pro'; }
			if (request.result.details.includes('Gemini 3 Pro (Preview)')) { return 'gemini-3-pro-preview'; }
			if (request.result.details.includes('Gemini 3 Pro')) { return 'gemini-3-pro'; }
			if (request.result.details.includes('GPT-4.1')) { return 'gpt-4.1'; }
			if (request.result.details.includes('GPT-4o-mini')) { return 'gpt-4o-mini'; }
			if (request.result.details.includes('GPT-4o')) { return 'gpt-4o'; }
			if (request.result.details.includes('GPT-4')) { return 'gpt-4'; }
			if (request.result.details.includes('GPT-5')) { return 'gpt-5'; }
			if (request.result.details.includes('GPT-3.5-Turbo')) { return 'gpt-3.5-turbo'; }
			if (request.result.details.includes('o3-mini')) { return 'o3-mini'; }
			if (request.result.details.includes('o4-mini')) { return 'o4-mini'; }
		}
		return 'gpt-4'; // default
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
		// If panel already exists, just reveal it
		if (this.detailsPanel) {
			this.detailsPanel.reveal();
			return;
		}

		// Get detailed stats (with progress in status bar)
		const stats = await this.updateTokenStats();
		if (!stats) {
			return;
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
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

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
			this.detailsPanel = undefined;
		});
	}

	public async showChart(): Promise<void> {
		// If panel already exists, just reveal it
		if (this.chartPanel) {
			this.chartPanel.reveal();
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

		// Set the HTML content
		this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, dailyStats);

		// Handle messages from the webview
		this.chartPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshChartPanel();
					break;
			}
		});

		// Handle panel disposal
		this.chartPanel.onDidDispose(() => {
			this.chartPanel = undefined;
		});
	}

	public async showUsageAnalysis(): Promise<void> {
		// If panel already exists, just reveal it
		if (this.analysisPanel) {
			this.analysisPanel.reveal();
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
				retainContextWhenHidden: false
			}
		);

		// Set the HTML content
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(analysisStats);

		// Handle messages from the webview
		this.analysisPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshAnalysisPanel();
					break;
			}
		});

		// Handle panel disposal
		this.analysisPanel.onDidDispose(() => {
			this.analysisPanel = undefined;
		});
	}

	private async refreshDetailsPanel(): Promise<void> {
		if (!this.detailsPanel) {
			return;
		}

		// Update token stats and refresh the webview content
		const stats = await this.updateTokenStats();
		if (stats) {
			this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);
		}
	}

	private async refreshChartPanel(): Promise<void> {
		if (!this.chartPanel) {
			return;
		}

		// Refresh the chart webview content
		const dailyStats = await this.calculateDailyStats();
		this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, dailyStats);
	}

	private async refreshAnalysisPanel(): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		// Refresh the analysis webview content
		const analysisStats = await this.calculateUsageAnalysisStats();
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(analysisStats);
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
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'details.js'));

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

	private getModelUsageHtml(stats: DetailedStats): string {
		// Get all unique models from both periods
		const allModels = new Set([
			...Object.keys(stats.today.modelUsage),
			...Object.keys(stats.month.modelUsage)
		]);

		if (allModels.size === 0) {
			return '';
		}

		const now = new Date();
		const currentDayOfMonth = now.getDate();
		const daysInYear = (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) || now.getFullYear() % 400 === 0 ? 366 : 365;

		const calculateProjection = (monthlyValue: number) => {
			if (currentDayOfMonth === 0) {
				return 0;
			}
			const dailyAverage = monthlyValue / currentDayOfMonth;
			return dailyAverage * daysInYear;
		};

		const modelRows = Array.from(allModels).map(model => {
			const ratio = this.tokenEstimators[model] || 0.25;
			const charsPerToken = (1 / ratio).toFixed(1);
			
			const todayUsage = stats.today.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
			const monthUsage = stats.month.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
			
			const todayTotal = todayUsage.inputTokens + todayUsage.outputTokens;
			const monthTotal = monthUsage.inputTokens + monthUsage.outputTokens;
			const projectedTokens = calculateProjection(monthTotal);
			
			const todayInputPercent = todayTotal > 0 ? ((todayUsage.inputTokens / todayTotal) * 100).toFixed(0) : 0;
			const todayOutputPercent = todayTotal > 0 ? ((todayUsage.outputTokens / todayTotal) * 100).toFixed(0) : 0;
			const monthInputPercent = monthTotal > 0 ? ((monthUsage.inputTokens / monthTotal) * 100).toFixed(0) : 0;
			const monthOutputPercent = monthTotal > 0 ? ((monthUsage.outputTokens / monthTotal) * 100).toFixed(0) : 0;

			return `
			<tr>
				<td class="metric-label">
					${this.getModelDisplayName(model)}
					<span style="font-size: 11px; color: #a0a0a0; font-weight: normal;">(~${charsPerToken} chars/tk)</span>
				</td>
				<td class="today-value">
					${todayTotal.toLocaleString()}
					<div style="font-size: 10px; color: #999; font-weight: normal; margin-top: 2px;">↑${todayInputPercent}% ↓${todayOutputPercent}%</div>
				</td>
				<td class="month-value">
					${monthTotal.toLocaleString()}
					<div style="font-size: 10px; color: #999; font-weight: normal; margin-top: 2px;">↑${monthInputPercent}% ↓${monthOutputPercent}%</div>
				</td>
				<td class="month-value">${Math.round(projectedTokens).toLocaleString()}</td>
			</tr>
		`;
		}).join('');

		return `
			<div style="margin-top: 16px;">
				<h3 style="color: #ffffff; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
					<span>🎯</span>
					<span>Model Usage (Tokens)</span>
				</h3>
				<table class="stats-table">
					<colgroup>
						<col class="metric-col">
						<col class="value-col">
						<col class="value-col">
						<col class="value-col">
					</colgroup>
					<thead>
						<tr>
							<th>Model</th>
							<th>
								<div class="period-header">
									<span>📅</span>
									<span>Today</span>
								</div>
							</th>
							<th>
								<div class="period-header">
									<span>📊</span>
									<span>This Month</span>
								</div>
							</th>
							<th>
								<div class="period-header">
									<span>🌍</span>
									<span>Projected Year</span>
								</div>
							</th>
						</tr>
					</thead>
					<tbody>
						${modelRows}
					</tbody>
				</table>
			</div>
		`;
	}

	private getEditorUsageHtml(stats: DetailedStats): string {
		// Get all unique editors from both periods
		const allEditors = new Set([
			...Object.keys(stats.today.editorUsage),
			...Object.keys(stats.month.editorUsage)
		]);

		if (allEditors.size === 0) {
			return '';
		}

		// Calculate totals for percentages
		const todayTotal = Object.values(stats.today.editorUsage).reduce((sum, e) => sum + e.tokens, 0);
		const monthTotal = Object.values(stats.month.editorUsage).reduce((sum, e) => sum + e.tokens, 0);

		const editorRows = Array.from(allEditors).sort().map(editor => {
			const todayUsage = stats.today.editorUsage[editor] || { tokens: 0, sessions: 0 };
			const monthUsage = stats.month.editorUsage[editor] || { tokens: 0, sessions: 0 };
			
			const todayPercent = todayTotal > 0 ? ((todayUsage.tokens / todayTotal) * 100).toFixed(1) : '0.0';
			const monthPercent = monthTotal > 0 ? ((monthUsage.tokens / monthTotal) * 100).toFixed(1) : '0.0';

			return `
			<tr>
				<td class="metric-label">
					${this.getEditorIcon(editor)} ${editor}
				</td>
				<td class="today-value">
					${todayUsage.tokens.toLocaleString()}
					<div style="font-size: 10px; color: #999; font-weight: normal; margin-top: 2px;">${todayPercent}% · ${todayUsage.sessions} sessions</div>
				</td>
				<td class="month-value">
					${monthUsage.tokens.toLocaleString()}
					<div style="font-size: 10px; color: #999; font-weight: normal; margin-top: 2px;">${monthPercent}% · ${monthUsage.sessions} sessions</div>
				</td>
			</tr>
		`;
		}).join('');

		return `
			<div style="margin-top: 16px;">
				<h3 style="color: #ffffff; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
					<span>💻</span>
					<span>Usage by Editor</span>
				</h3>
				<table class="stats-table">
					<colgroup>
						<col class="metric-col">
						<col class="value-col">
						<col class="value-col">
					</colgroup>
					<thead>
						<tr>
							<th>Editor</th>
							<th>
								<div class="period-header">
									<span>📅</span>
									<span>Today</span>
								</div>
							</th>
							<th>
								<div class="period-header">
									<span>📊</span>
									<span>This Month</span>
								</div>
							</th>
						</tr>
					</thead>
					<tbody>
						${editorRows}
					</tbody>
				</table>
			</div>
		`;
	}

	private getEditorIcon(editor: string): string {
		const icons: { [key: string]: string } = {
			'VS Code': '💙',
			'VS Code Insiders': '💚',
			'VS Code Exploration': '🧪',
			'VS Code Server': '☁️',
			'VS Code Server (Insiders)': '☁️',
			'VSCodium': '🔷',
			'Cursor': '⚡',
			'Copilot CLI': '🤖',
			'Unknown': '❓'
		};
		return icons[editor] || '📝';
	}

	private getModelDisplayName(model: string): string {
		const modelNames: { [key: string]: string } = {
			'gpt-4': 'GPT-4',
			'gpt-4.1': 'GPT-4.1',
			'gpt-4o': 'GPT-4o',
			'gpt-4o-mini': 'GPT-4o Mini',
			'gpt-3.5-turbo': 'GPT-3.5 Turbo',
			'gpt-5': 'GPT-5',
			'gpt-5-codex': 'GPT-5 Codex (Preview)',
			'gpt-5-mini': 'GPT-5 Mini',
			'gpt-5.1': 'GPT-5.1',
			'gpt-5.1-codex': 'GPT-5.1 Codex',
			'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
			'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini (Preview)',
			'gpt-5.2': 'GPT-5.2',
			'claude-sonnet-3.5': 'Claude Sonnet 3.5',
			'claude-sonnet-3.7': 'Claude Sonnet 3.7',
			'claude-sonnet-4': 'Claude Sonnet 4',
			'claude-sonnet-4.5': 'Claude Sonnet 4.5',
			'claude-haiku': 'Claude Haiku',
			'claude-haiku-4.5': 'Claude Haiku 4.5',
			'claude-opus-4.1': 'Claude Opus 4.1',
			'claude-opus-4.5': 'Claude Opus 4.5',
			'gemini-2.5-pro': 'Gemini 2.5 Pro',
			'gemini-3-flash': 'Gemini 3 Flash',
			'gemini-3-pro': 'Gemini 3 Pro',
			'gemini-3-pro-preview': 'Gemini 3 Pro (Preview)',
			'grok-code-fast-1': 'Grok Code Fast 1',
			'raptor-mini': 'Raptor Mini',
			'o3-mini': 'o3-mini',
			'o4-mini': 'o4-mini (Preview)'
		};
		return modelNames[model] || model;
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
		this.log('Showing diagnostic report...');
		
		const report = await this.generateDiagnosticReport();
		
		// Create a webview panel to display the report
		const panel = vscode.window.createWebviewPanel(
			'copilotTokenDiagnostics',
			'Diagnostic Report',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: false
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false
			}
		);
		
		// Set the HTML content
		panel.webview.html = this.getDiagnosticReportHtml(report);
		
		// Handle messages from the webview
		panel.webview.onDidReceiveMessage(async (message) => {
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
							await vscode.window.showTextDocument(vscode.Uri.file(message.file));
						} catch (err) {
							vscode.window.showErrorMessage('Could not open file: ' + message.file);
						}
					}
					break;
			}
		});
	}

	private getDiagnosticReportHtml(report: string): string {
		// Split the report into sections
		const sessionFilesSectionMatch = report.match(/Session File Locations \(first 20\):([\s\S]*?)(?=\n\s*\n|$)/);
		let sessionFilesHtml = '';
		if (sessionFilesSectionMatch) {
			const lines = sessionFilesSectionMatch[1].split('\n').filter(l => l.trim());
			sessionFilesHtml = '<div class="session-files-list"><h4>Session File Locations (first 20):</h4><ul style="padding-left:20px;">';
			for (let i = 0; i < lines.length; i += 3) {
				const fileLine = lines[i];
				const sizeLine = lines[i+1] || '';
				const modLine = lines[i+2] || '';
				const fileMatch = fileLine.match(/(\d+)\. (.+)/);
				if (fileMatch) {
					const idx = fileMatch[1];
					const file = fileMatch[2];
					sessionFilesHtml += `<li><a href="#" class="session-file-link" data-file="${encodeURIComponent(file)}">${idx}. ${file}</a><br><span style="color:#aaa;">${sizeLine}<br>${modLine}</span></li>`;
				} else {
					sessionFilesHtml += `<li>${fileLine}</li>`;
				}
			}
			sessionFilesHtml += '</ul></div>';
		}

		// Escape HTML for the rest of the report
		let escapedReport = report.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
		// Remove the session files section from the escaped report
		if (sessionFilesSectionMatch) {
			escapedReport = escapedReport.replace(sessionFilesSectionMatch[0], '');
		}

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Diagnostic Report</title>
			<style>
				* {
					margin: 0;
					padding: 0;
					box-sizing: border-box;
				}
				body {
					font-family: 'Consolas', 'Courier New', monospace;
					background: #2d2d2d;
					color: #cccccc;
					padding: 16px;
					line-height: 1.6;
				}
				.container {
					background: #3c3c3c;
					border: 1px solid #5a5a5a;
					border-radius: 8px;
					padding: 16px;
					box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
					max-width: 1200px;
					margin: 0 auto;
				}
				.header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 8px;
					margin-bottom: 16px;
					padding-bottom: 12px;
					border-bottom: 1px solid #5a5a5a;
				}
				.header-left {
					display: flex;
					align-items: center;
					gap: 8px;
				}
				.header-icon {
					font-size: 20px;
				}
				.header-title {
					font-size: 16px;
					font-weight: 600;
					color: #ffffff;
				}
				.report-content {
					background: #2a2a2a;
					border: 1px solid #5a5a5a;
					border-radius: 4px;
					padding: 16px;
					white-space: pre-wrap;
					font-size: 13px;
					overflow-x: auto;
					max-height: 70vh;
					overflow-y: auto;
				}
				.session-files-list ul {
					list-style: none;
				}
				.session-file-link {
					color: #4FC3F7;
					text-decoration: underline;
					cursor: pointer;
				}
				.session-file-link:hover {
					color: #81D4FA;
				}
				.button-group {
					display: flex;
					gap: 12px;
					margin-top: 16px;
					flex-wrap: wrap;
				}
				.button {
					background: #0e639c;
					border: 1px solid #1177bb;
					color: #ffffff;
					padding: 10px 20px;
					border-radius: 4px;
					cursor: pointer;
					font-size: 13px;
					font-weight: 500;
					transition: background-color 0.2s;
					display: inline-flex;
					align-items: center;
					gap: 8px;
				}
				.button:hover {
					background: #1177bb;
				}
				.button:active {
					background: #0a5a8a;
				}
				.button.secondary {
					background: #3c3c3c;
					border-color: #5a5a5a;
				}
				.button.secondary:hover {
					background: #4a4a4a;
				}
				.info-box {
					background: #3a4a5a;
					border: 1px solid #4a5a6a;
					border-radius: 4px;
					padding: 12px;
					margin-bottom: 16px;
					font-size: 13px;
				}
				.info-box-title {
					font-weight: 600;
					color: #ffffff;
					margin-bottom: 6px;
				}
			</style>
		</head>
		<body>
			<div class="container">
				<div class="header">
					<div class="header-left">
						<span class="header-icon">🔍</span>
						<span class="header-title">Diagnostic Report</span>
					</div>
				</div>
                
				<div class="info-box">
					<div class="info-box-title">📋 About This Report</div>
					<div>
						This diagnostic report contains information about your GitHub Copilot Token Tracker
						extension setup and usage statistics. It does <strong>not</strong> include any of your
						code or conversation content. You can safely share this report when reporting issues.
					</div>
				</div>
                
				<div class="report-content">${escapedReport}</div>
				${sessionFilesHtml}
				<div class="button-group">
					<button class="button" onclick="copyReport()">
						<span>📋</span>
						<span>Copy to Clipboard</span>
					</button>
					<button class="button secondary" onclick="openIssue()">
						<span>🐛</span>
						<span>Open GitHub Issue</span>
					</button>
				</div>
			</div>

			<script>
				const vscode = acquireVsCodeApi();

				function copyReport() {
					vscode.postMessage({ command: 'copyReport' });
				}

				function openIssue() {
					vscode.postMessage({ command: 'openIssue' });
				}

				// Make session file links clickable
				document.addEventListener('DOMContentLoaded', () => {
					document.querySelectorAll('.session-file-link').forEach(link => {
						link.addEventListener('click', (e) => {
							e.preventDefault();
							const file = decodeURIComponent(link.getAttribute('data-file'));
							vscode.postMessage({ command: 'openSessionFile', file });
						});
					});
				});
			</script>
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
				label: this.getModelDisplayName(model),
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

	private getUsageAnalysisHtml(stats: UsageAnalysisStats): string {
		// Helper to escape HTML to prevent XSS
		const escapeHtml = (text: string): string => {
			return text
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		};

		// Helper to get the total of context references
		const getTotalContextRefs = (refs: ContextReferenceUsage): number => {
			return refs.file + refs.selection + refs.symbol + refs.codebase + 
			       refs.workspace + refs.terminal + refs.vscode;
		};

		const todayTotalRefs = getTotalContextRefs(stats.today.contextReferences);
		const monthTotalRefs = getTotalContextRefs(stats.month.contextReferences);
		const todayTotalModes = stats.today.modeUsage.ask + stats.today.modeUsage.edit + stats.today.modeUsage.agent;
		const monthTotalModes = stats.month.modeUsage.ask + stats.month.modeUsage.edit + stats.month.modeUsage.agent;

		// Generate top tools lists
		const generateTopToolsList = (byTool: { [key: string]: number }, limit: number = 5): string => {
			const sortedTools = Object.entries(byTool)
				.sort(([, a], [, b]) => b - a)
				.slice(0, limit);
			
			if (sortedTools.length === 0) {
				return '<li style="color: #999;">No tools used yet</li>';
			}
			
			return sortedTools.map(([tool, count]) => 
				`<li><strong>${escapeHtml(tool)}</strong>: ${count} ${count === 1 ? 'call' : 'calls'}</li>`
			).join('');
		};

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Usage Analysis</title>
			<style>
				* {
					margin: 0;
					padding: 0;
					box-sizing: border-box;
				}
				body {
					font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
					background: #2d2d2d;
					color: #cccccc;
					padding: 16px;
					line-height: 1.5;
					min-width: 320px;
				}
				.container {
					background: #3c3c3c;
					border: 1px solid #5a5a5a;
					border-radius: 8px;
					padding: 16px;
					box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
					max-width: 1200px;
					margin: 0 auto;
				}
				.header {
					display: flex;
					align-items: center;
					gap: 8px;
					margin-bottom: 16px;
					padding-bottom: 12px;
					border-bottom: 1px solid #5a5a5a;
				}
				.header-icon {
					font-size: 20px;
				}
				.header-title {
					font-size: 16px;
					font-weight: 600;
					color: #ffffff;
				}
				.section {
					margin-bottom: 24px;
				}
				.section-title {
					font-size: 15px;
					font-weight: 600;
					color: #ffffff;
					margin-bottom: 12px;
					display: flex;
					align-items: center;
					gap: 8px;
				}
				.section-subtitle {
					font-size: 13px;
					color: #999;
					margin-bottom: 12px;
				}
				.stats-grid {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
					gap: 12px;
					margin-bottom: 16px;
				}
				.stat-card {
					background: #353535;
					border: 1px solid #5a5a5a;
					border-radius: 4px;
					padding: 12px;
				}
				.stat-label {
					font-size: 11px;
					color: #b3b3b3;
					margin-bottom: 4px;
				}
				.stat-value {
					font-size: 20px;
					font-weight: 600;
					color: #ffffff;
				}
				.bar-chart {
					background: #353535;
					border: 1px solid #5a5a5a;
					border-radius: 4px;
					padding: 12px;
					margin-bottom: 12px;
				}
				.bar-item {
					margin-bottom: 8px;
				}
				.bar-label {
					display: flex;
					justify-content: space-between;
					font-size: 12px;
					margin-bottom: 4px;
				}
				.bar-track {
					background: #2a2a2a;
					height: 8px;
					border-radius: 4px;
					overflow: hidden;
				}
				.bar-fill {
					background: linear-gradient(90deg, #7c3aed, #a855f7);
					height: 100%;
					border-radius: 4px;
					transition: width 0.3s ease;
				}
				.list {
					background: #353535;
					border: 1px solid #5a5a5a;
					border-radius: 4px;
					padding: 12px 16px;
				}
				.list ul {
					list-style: none;
					padding: 0;
				}
				.list li {
					padding: 4px 0;
					font-size: 13px;
				}
				.two-column {
					display: grid;
					grid-template-columns: 1fr 1fr;
					gap: 16px;
				}
				.info-box {
					background: #3a4a5a;
					border: 1px solid #4a5a6a;
					border-radius: 4px;
					padding: 12px;
					margin-bottom: 16px;
					font-size: 13px;
				}
				.info-box-title {
					font-weight: 600;
					color: #ffffff;
					margin-bottom: 6px;
				}
				.footer {
					margin-top: 16px;
					padding-top: 12px;
					border-top: 1px solid #5a5a5a;
					text-align: center;
					font-size: 11px;
					color: #999999;
					font-style: italic;
				}
				.refresh-button {
					background: #0e639c;
					border: 1px solid #1177bb;
					color: #ffffff;
					padding: 8px 16px;
					border-radius: 4px;
					cursor: pointer;
					font-size: 12px;
					font-weight: 500;
					margin-top: 8px;
					transition: background-color 0.2s;
					display: inline-flex;
					align-items: center;
					gap: 6px;
				}
				.refresh-button:hover {
					background: #1177bb;
				}
				.refresh-button:active {
					background: #0a5a8a;
				}
				@media (max-width: 768px) {
					.two-column {
						grid-template-columns: 1fr;
					}
				}
			</style>
		</head>
		<body>
			<div class="container">
				<div class="header">
					<span class="header-icon">📊</span>
					<span class="header-title">Copilot Usage Analysis Dashboard</span>
				</div>

				<div class="info-box">
					<div class="info-box-title">📋 About This Dashboard</div>
					<div>
						This dashboard analyzes your GitHub Copilot usage patterns by examining session log files.
						It tracks modes (ask/edit/agent), tool usage, context references (#file, @workspace, etc.),
						and MCP (Model Context Protocol) tools to help you understand how you interact with Copilot.
					</div>
				</div>

				<!-- Mode Usage Section -->
				<div class="section">
					<div class="section-title">
						<span>🎯</span>
						<span>Interaction Modes</span>
					</div>
					<div class="section-subtitle">
						How you're using Copilot: Ask (chat), Edit (code edits), or Agent (autonomous tasks)
					</div>
					
					<div class="two-column">
						<div>
							<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
							<div class="bar-chart">
								<div class="bar-item">
									<div class="bar-label">
										<span>💬 Ask Mode</span>
										<span><strong>${stats.today.modeUsage.ask}</strong> (${todayTotalModes > 0 ? ((stats.today.modeUsage.ask / todayTotalModes) * 100).toFixed(0) : 0}%)</span>
									</div>
									<div class="bar-track">
										<div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.ask / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #3b82f6, #60a5fa);"></div>
									</div>
								</div>
								<div class="bar-item">
									<div class="bar-label">
										<span>✏️ Edit Mode</span>
										<span><strong>${stats.today.modeUsage.edit}</strong> (${todayTotalModes > 0 ? ((stats.today.modeUsage.edit / todayTotalModes) * 100).toFixed(0) : 0}%)</span>
									</div>
									<div class="bar-track">
										<div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.edit / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #10b981, #34d399);"></div>
									</div>
								</div>
								<div class="bar-item">
									<div class="bar-label">
										<span>🤖 Agent Mode</span>
										<span><strong>${stats.today.modeUsage.agent}</strong> (${todayTotalModes > 0 ? ((stats.today.modeUsage.agent / todayTotalModes) * 100).toFixed(0) : 0}%)</span>
									</div>
									<div class="bar-track">
										<div class="bar-fill" style="width: ${todayTotalModes > 0 ? ((stats.today.modeUsage.agent / todayTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7c3aed, #a855f7);"></div>
									</div>
								</div>
							</div>
						</div>
						<div>
							<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
							<div class="bar-chart">
								<div class="bar-item">
									<div class="bar-label">
										<span>💬 Ask Mode</span>
										<span><strong>${stats.month.modeUsage.ask}</strong> (${monthTotalModes > 0 ? ((stats.month.modeUsage.ask / monthTotalModes) * 100).toFixed(0) : 0}%)</span>
									</div>
									<div class="bar-track">
										<div class="bar-fill" style="width: ${monthTotalModes > 0 ? ((stats.month.modeUsage.ask / monthTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #3b82f6, #60a5fa);"></div>
									</div>
								</div>
								<div class="bar-item">
									<div class="bar-label">
										<span>✏️ Edit Mode</span>
										<span><strong>${stats.month.modeUsage.edit}</strong> (${monthTotalModes > 0 ? ((stats.month.modeUsage.edit / monthTotalModes) * 100).toFixed(0) : 0}%)</span>
									</div>
									<div class="bar-track">
										<div class="bar-fill" style="width: ${monthTotalModes > 0 ? ((stats.month.modeUsage.edit / monthTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #10b981, #34d399);"></div>
									</div>
								</div>
								<div class="bar-item">
									<div class="bar-label">
										<span>🤖 Agent Mode</span>
										<span><strong>${stats.month.modeUsage.agent}</strong> (${monthTotalModes > 0 ? ((stats.month.modeUsage.agent / monthTotalModes) * 100).toFixed(0) : 0}%)</span>
									</div>
									<div class="bar-track">
										<div class="bar-fill" style="width: ${monthTotalModes > 0 ? ((stats.month.modeUsage.agent / monthTotalModes) * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7c3aed, #a855f7);"></div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Context References Section -->
				<div class="section">
					<div class="section-title">
						<span>🔗</span>
						<span>Context References</span>
					</div>
					<div class="section-subtitle">
						How often you reference files, selections, symbols, and workspace context
					</div>
					
					<div class="stats-grid">
						<div class="stat-card">
							<div class="stat-label">📄 #file</div>
							<div class="stat-value">${stats.month.contextReferences.file}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.file}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">✂️ #selection</div>
							<div class="stat-value">${stats.month.contextReferences.selection}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.selection}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">🔤 #symbol</div>
							<div class="stat-value">${stats.month.contextReferences.symbol}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.symbol}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">🗂️ #codebase</div>
							<div class="stat-value">${stats.month.contextReferences.codebase}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.codebase}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">📁 @workspace</div>
							<div class="stat-value">${stats.month.contextReferences.workspace}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.workspace}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">💻 @terminal</div>
							<div class="stat-value">${stats.month.contextReferences.terminal}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.terminal}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">🔧 @vscode</div>
							<div class="stat-value">${stats.month.contextReferences.vscode}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${stats.today.contextReferences.vscode}</div>
						</div>
						<div class="stat-card" style="background: #4a3a5a;">
							<div class="stat-label">📊 Total References</div>
							<div class="stat-value">${monthTotalRefs}</div>
							<div style="font-size: 10px; color: #999; margin-top: 4px;">Today: ${todayTotalRefs}</div>
						</div>
					</div>
				</div>

				<!-- Tool Calls Section -->
				<div class="section">
					<div class="section-title">
						<span>🔧</span>
						<span>Tool Usage</span>
					</div>
					<div class="section-subtitle">
						Functions and tools invoked by Copilot during interactions
					</div>
					
					<div class="two-column">
						<div>
							<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
							<div class="list">
								<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">
									Total Tool Calls: ${stats.today.toolCalls.total}
								</div>
								<ul>
									${generateTopToolsList(stats.today.toolCalls.byTool)}
								</ul>
							</div>
						</div>
						<div>
							<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
							<div class="list">
								<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">
									Total Tool Calls: ${stats.month.toolCalls.total}
								</div>
								<ul>
									${generateTopToolsList(stats.month.toolCalls.byTool)}
								</ul>
							</div>
						</div>
					</div>
				</div>

				<!-- MCP Tools Section -->
				<div class="section">
					<div class="section-title">
						<span>🔌</span>
						<span>MCP Tools</span>
					</div>
					<div class="section-subtitle">
						Model Context Protocol (MCP) server and tool usage
					</div>
					
					<div class="two-column">
						<div>
							<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
							<div class="list">
								<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">
									Total MCP Calls: ${stats.today.mcpTools.total}
								</div>
								${stats.today.mcpTools.total > 0 ? `
									<div style="margin-top: 12px;">
										<strong>By Server:</strong>
										<ul style="margin-top: 4px;">
											${generateTopToolsList(stats.today.mcpTools.byServer)}
										</ul>
									</div>
									<div style="margin-top: 12px;">
										<strong>By Tool:</strong>
										<ul style="margin-top: 4px;">
											${generateTopToolsList(stats.today.mcpTools.byTool)}
										</ul>
									</div>
								` : '<div style="color: #999; margin-top: 8px;">No MCP tools used yet</div>'}
							</div>
						</div>
						<div>
							<h4 style="color: #fff; font-size: 13px; margin-bottom: 8px;">📊 This Month</h4>
							<div class="list">
								<div style="font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 8px;">
									Total MCP Calls: ${stats.month.mcpTools.total}
								</div>
								${stats.month.mcpTools.total > 0 ? `
									<div style="margin-top: 12px;">
										<strong>By Server:</strong>
										<ul style="margin-top: 4px;">
											${generateTopToolsList(stats.month.mcpTools.byServer)}
										</ul>
									</div>
									<div style="margin-top: 12px;">
										<strong>By Tool:</strong>
										<ul style="margin-top: 4px;">
											${generateTopToolsList(stats.month.mcpTools.byTool)}
										</ul>
									</div>
								` : '<div style="color: #999; margin-top: 8px;">No MCP tools used yet</div>'}
							</div>
						</div>
					</div>
				</div>

				<!-- Summary Section -->
				<div class="section">
					<div class="section-title">
						<span>📈</span>
						<span>Sessions Summary</span>
					</div>
					<div class="stats-grid">
						<div class="stat-card">
							<div class="stat-label">📅 Today Sessions</div>
							<div class="stat-value">${stats.today.sessions}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">📊 Month Sessions</div>
							<div class="stat-value">${stats.month.sessions}</div>
						</div>
					</div>
				</div>

				<div class="footer">
					Last updated: ${stats.lastUpdated.toLocaleString()}<br>
					Updates automatically every 5 minutes
					<br>
					<button class="refresh-button" onclick="refreshAnalysis()">
						<span>🔄</span>
						<span>Refresh Analysis</span>
					</button>
				</div>
			</div>

			<script>
				const vscode = acquireVsCodeApi();

				function refreshAnalysis() {
					vscode.postMessage({ command: 'refresh' });
				}
			</script>
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
		this.statusBarItem.dispose();
		this.outputChannel.dispose();
		// Clear cache on disposal
		this.sessionFileCache.clear();
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Create the token tracker
	const tokenTracker = new CopilotTokenTracker(context.extensionUri);

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

	// Add to subscriptions for proper cleanup
	context.subscriptions.push(refreshCommand, showDetailsCommand, showChartCommand, showUsageAnalysisCommand, generateDiagnosticReportCommand, tokenTracker);

	tokenTracker.log('Extension activation complete');
}

export function deactivate() {
	// Extension cleanup is handled in the CopilotTokenTracker class
}
