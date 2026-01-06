import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';

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

interface DetailedStats {
	today: {
		tokens: number;
		sessions: number;
		avgInteractionsPerSession: number;
		avgTokensPerSession: number;
		modelUsage: ModelUsage;
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
}

interface SessionFileCache {
	tokens: number;
	interactions: number;
	modelUsage: ModelUsage;
	mtime: number; // file modification time as timestamp
}

class CopilotTokenTracker implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;

	// Helper method to get total tokens from ModelUsage
	private getTotalTokensFromModelUsage(modelUsage: ModelUsage): number {
		return Object.values(modelUsage).reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0);
	}
	private updateInterval: NodeJS.Timeout | undefined;
	private initialDelayTimeout: NodeJS.Timeout | undefined;
	private detailsPanel: vscode.WebviewPanel | undefined;
	private chartPanel: vscode.WebviewPanel | undefined;
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



	constructor() {
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
			const delaySeconds = process.env.CODESPACES === 'true' ? 10 : 15;
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
				this.log('💓 Heartbeat: 5 seconds elapsed, timeout still pending...');
			}, 5 * 1000);
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
				this.detailsPanel.webview.html = this.getDetailsHtml(detailedStats);
			}

			// If the chart panel is open, update its content
			if (this.chartPanel) {
				const dailyStats = await this.calculateDailyStats();
				this.chartPanel.webview.html = this.getChartHtml(dailyStats);
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

		const todayStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage };
		const monthStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage };

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

						// Update cache statistics
						if (wasCached) {
							cacheHits++;
						} else {
							cacheMisses++;
						}

						this.log(`Session ${path.basename(sessionFile)}: ${tokens} tokens, ${interactions} interactions`);

						monthStats.tokens += tokens;
						monthStats.sessions += 1;
						monthStats.interactions += interactions;

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
						
						// Get the date in YYYY-MM-DD format
						const dateKey = this.formatDateKey(new Date(fileStats.mtime));
						
						// Initialize or update the daily stats
						if (!dailyStatsMap.has(dateKey)) {
							dailyStatsMap.set(dateKey, {
								date: dateKey,
								tokens: 0,
								sessions: 0,
								interactions: 0,
								modelUsage: {}
							});
						}
						
						const dailyStats = dailyStatsMap.get(dateKey)!;
						dailyStats.tokens += tokens;
						dailyStats.sessions += 1;
						dailyStats.interactions += interactions;
						
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

	private async countInteractionsInSession(sessionFile: string): Promise<number> {
		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
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
		
		const sessionData: SessionFileCache = {
			tokens,
			interactions,
			modelUsage,
			mtime
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

	private async getCopilotSessionFiles(): Promise<string[]> {
		const sessionFiles: string[] = [];

		// Cross-platform path resolution for VS Code user data
		let codeUserPath: string;
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

		if (platform === 'win32') {
			// Windows: %APPDATA%/Code/User
			const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
			codeUserPath = path.join(appDataPath, 'Code', 'User');
			this.log(`Windows path - APPDATA: ${appDataPath}`);
		} else if (platform === 'darwin') {
			// macOS: ~/Library/Application Support/Code/User
			codeUserPath = path.join(homedir, 'Library', 'Application Support', 'Code', 'User');
			this.log(`macOS path calculated`);
		} else {
			// Linux and other Unix-like systems: ~/.config/Code/User
			// In GitHub Codespaces, also check for alternative VS Code paths
			const xdgConfigHome = process.env.XDG_CONFIG_HOME;
			if (xdgConfigHome) {
				codeUserPath = path.join(xdgConfigHome, 'Code', 'User');
				this.log(`Linux path using XDG_CONFIG_HOME: ${xdgConfigHome}`);
			} else {
				codeUserPath = path.join(homedir, '.config', 'Code', 'User');
				this.log(`Linux path using default .config`);
			}
		}

		this.log(`Calculated VS Code user path: ${codeUserPath}`);
		this.log(`Path exists: ${fs.existsSync(codeUserPath)}`);

		// Check alternative VS Code paths that might be used in Codespaces
		const alternativePaths = [
			path.join(homedir, '.vscode-server', 'data', 'User'),
			path.join(homedir, '.vscode-remote', 'data', 'User'),
			path.join('/tmp', '.vscode-server', 'data', 'User'),
			path.join('/workspace', '.vscode-server', 'data', 'User')
		];

		this.log('Checking alternative VS Code paths:');
		for (const altPath of alternativePaths) {
			const exists = fs.existsSync(altPath);
			this.log(`  ${altPath}: ${exists ? 'EXISTS' : 'not found'}`);
			if (exists && !fs.existsSync(codeUserPath)) {
				this.log(`  Using alternative path: ${altPath}`);
				codeUserPath = altPath;
				break;
			}
		}

		try {
			// Workspace storage sessions
			const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
			this.log(`Checking workspace storage path: ${workspaceStoragePath}`);
			this.log(`Workspace storage exists: ${fs.existsSync(workspaceStoragePath)}`);

			if (fs.existsSync(workspaceStoragePath)) {
				const workspaceDirs = fs.readdirSync(workspaceStoragePath);
				this.log(`Found ${workspaceDirs.length} workspace directories`);

				for (const workspaceDir of workspaceDirs) {
					const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
					this.log(`Checking chat sessions path: ${chatSessionsPath}`);

					if (fs.existsSync(chatSessionsPath)) {
						const sessionFiles2 = fs.readdirSync(chatSessionsPath)
							.filter(file => file.endsWith('.json'))
							.map(file => path.join(chatSessionsPath, file));
						this.log(`Found ${sessionFiles2.length} session files in ${workspaceDir}`);
						sessionFiles.push(...sessionFiles2);
					} else {
						this.log(`Chat sessions path does not exist: ${chatSessionsPath}`);
						// Investigate what's actually in this workspace directory
						try {
							const workspaceDirPath = path.join(workspaceStoragePath, workspaceDir);
							const dirContents = fs.readdirSync(workspaceDirPath);
							this.log(`  Workspace ${workspaceDir} contains: ${dirContents.join(', ')}`);

							// Check for GitHub Copilot specific directories
							const copilotDirs = dirContents.filter(dir =>
								dir.toLowerCase().includes('copilot') ||
								dir.toLowerCase().includes('chat') ||
								dir.toLowerCase().includes('github')
							);
							if (copilotDirs.length > 0) {
								this.log(`  Found potential Copilot-related directories: ${copilotDirs.join(', ')}`);
							}
						} catch (error) {
							this.warn(`  Could not read workspace directory ${workspaceDir}: ${error}`);
						}
					}
				}
			} else {
				this.log(`Workspace storage path does not exist: ${workspaceStoragePath}`);
			}			// Global storage sessions
			const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
			this.log(`Checking global storage path: ${globalStoragePath}`);
			this.log(`Global storage exists: ${fs.existsSync(globalStoragePath)}`);

			if (fs.existsSync(globalStoragePath)) {
				const globalSessionFiles = fs.readdirSync(globalStoragePath)
					.filter(file => file.endsWith('.json'))
					.map(file => path.join(globalStoragePath, file));
				this.log(`Found ${globalSessionFiles.length} global session files`);
				sessionFiles.push(...globalSessionFiles);
			} else {
				this.log(`Global storage path does not exist: ${globalStoragePath}`);
			}

			// If no session files found, check for alternative GitHub Copilot storage locations
			if (sessionFiles.length === 0) {
				this.log('No session files found in standard locations. Checking alternative GitHub Copilot storage...');

				// Check for GitHub Copilot extension specific storage
				const alternativeStorageLocations = [
					path.join(codeUserPath, 'globalStorage', 'github.copilot'),
					path.join(codeUserPath, 'globalStorage', 'github.copilot-chat'),
					path.join(codeUserPath, 'globalStorage', 'github.copilot-labs'),
					path.join(codeUserPath, 'User', 'globalStorage', 'github.copilot-chat'),
					path.join(os.homedir(), '.copilot'),
					path.join(os.homedir(), '.github-copilot')
				];

				for (const altLocation of alternativeStorageLocations) {
					if (fs.existsSync(altLocation)) {
						this.log(`Found alternative Copilot storage: ${altLocation}`);
						try {
							const contents = fs.readdirSync(altLocation);
							this.log(`  Contains: ${contents.join(', ')}`);

							// Look for any JSON files that might be session files
							const jsonFiles = contents.filter(file => file.endsWith('.json'));
							if (jsonFiles.length > 0) {
								this.log(`  Found ${jsonFiles.length} JSON files that might be sessions: ${jsonFiles.join(', ')}`);
							}
						} catch (error) {
							this.warn(`  Could not read alternative storage ${altLocation}: ${error}`);
						}
					}
				}
			}

			this.log(`Total session files found: ${sessionFiles.length}`);
			if (sessionFiles.length > 0) {
				this.log('Session file paths:');
				sessionFiles.forEach((file, index) => {
					this.log(`  ${index + 1}: ${file}`);
				});
			} else {
				this.warn('No GitHub Copilot session files found. This could be because:');
				this.log('  1. Copilot extensions are not active (most likely in Codespaces)');
				this.log('  2. No Copilot Chat conversations have been initiated yet');
				this.log('  3. Sessions are stored in a different location not yet supported');
				this.log('  4. User needs to authenticate with GitHub Copilot first');
			}
		} catch (error) {
			this.error('Error getting session files:', error);
		}

		return sessionFiles;
	}

	private async estimateTokensFromSession(sessionFilePath: string): Promise<number> {
		try {
			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
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
				retainContextWhenHidden: false
			}
		);

		// Set the HTML content
		this.detailsPanel.webview.html = this.getDetailsHtml(stats);

		// Handle messages from the webview
		this.detailsPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshDetailsPanel();
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
				retainContextWhenHidden: false
			}
		);

		// Set the HTML content
		this.chartPanel.webview.html = this.getChartHtml(dailyStats);

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

	private async refreshDetailsPanel(): Promise<void> {
		if (!this.detailsPanel) {
			return;
		}

		// Update token stats and refresh the webview content
		const stats = await this.updateTokenStats();
		if (stats) {
			this.detailsPanel.webview.html = this.getDetailsHtml(stats);
		}
	}

	private async refreshChartPanel(): Promise<void> {
		if (!this.chartPanel) {
			return;
		}

		// Refresh the chart webview content
		const dailyStats = await this.calculateDailyStats();
		this.chartPanel.webview.html = this.getChartHtml(dailyStats);
	}

	private getDetailsHtml(stats: DetailedStats): string {
		const usedModels = new Set([
			...Object.keys(stats.today.modelUsage),
			...Object.keys(stats.month.modelUsage)
		]);

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

		const projectedTokens = calculateProjection(stats.month.tokens);
		const projectedSessions = calculateProjection(stats.month.sessions);
		const projectedCo2 = calculateProjection(stats.month.co2);
		const projectedTrees = calculateProjection(stats.month.treesEquivalent);
		const projectedWater = calculateProjection(stats.month.waterUsage);
		const projectedCost = calculateProjection(stats.month.estimatedCost);

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Copilot Token Usage</title>
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
				.stats-table {
					width: 100%;
					border-collapse: collapse;
					margin-bottom: 16px;
					table-layout: fixed;
				}
				.stats-table col.metric-col {
					width: 180px;
				}
				.stats-table col.value-col {
					width: 110px;
				}
				.stats-table th {
					background: #4a4a4a;
					color: #ffffff;
					font-weight: 600;
					font-size: 13px;
					padding: 10px 8px;
					text-align: left;
					border: 1px solid #5a5a5a;
					white-space: nowrap;
				}
				.stats-table th:first-child {
					border-top-left-radius: 4px;
				}
				.stats-table th:last-child {
					border-top-right-radius: 4px;
				}
				.stats-table td {
					padding: 8px;
					font-size: 12px;
					border: 1px solid #5a5a5a;
					background: #353535;
				}
				.stats-table tr:last-child td:first-child {
					border-bottom-left-radius: 4px;
				}
				.stats-table tr:last-child td:last-child {
					border-bottom-right-radius: 4px;
				}
				.metric-label {
					color: #b3b3b3;
					font-weight: 500;
				}
				.today-value {
					color: #ffffff;
					font-weight: 600;
					text-align: right;
				}
				.month-value {
					color: #ffffff;
					font-weight: 600;
					text-align: right;
				}
				.period-header {
					display: flex;
					align-items: center;
					gap: 4px;
				}
				.footer {
					margin-top: 12px;
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
					margin-top: 12px;
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
			</style>
		</head>
		<body>
			<div class="container">
				<div class="header">
					<span class="header-icon">🤖</span>
					<span class="header-title">Copilot Token Usage</span>
				</div>
				
				<table class="stats-table">
					<colgroup>
						<col class="metric-col">
						<col class="value-col">
						<col class="value-col">
						<col class="value-col">
					</colgroup>
					<thead>
						<tr>
							<th>Metric</th>
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
						<tr>
							<td class="metric-label">Tokens</td>
							<td class="today-value">${stats.today.tokens.toLocaleString()}</td>
							<td class="month-value">${stats.month.tokens.toLocaleString()}</td>
							<td class="month-value">${Math.round(projectedTokens).toLocaleString()}</td>
						</tr>
						<tr>
							<td class="metric-label">💵 Est. Cost (USD)</td>
							<td class="today-value">$${stats.today.estimatedCost.toFixed(4)}</td>
							<td class="month-value">$${stats.month.estimatedCost.toFixed(4)}</td>
							<td class="month-value">$${projectedCost.toFixed(2)}</td>
						</tr>
						<tr>
							<td class="metric-label">Sessions</td>
							<td class="today-value">${stats.today.sessions}</td>
							<td class="month-value">${stats.month.sessions}</td>
							<td class="month-value">${Math.round(projectedSessions)}</td>
						</tr>
						<tr>
							<td class="metric-label">Avg Interactions</td>
							<td class="today-value">${stats.today.avgInteractionsPerSession}</td>
							<td class="month-value">${stats.month.avgInteractionsPerSession}</td>
							<td class="month-value">-</td>
						</tr>
						<tr>
							<td class="metric-label">Avg Tokens</td>
							<td class="today-value">${stats.today.avgTokensPerSession.toLocaleString()}</td>
							<td class="month-value">${stats.month.avgTokensPerSession.toLocaleString()}</td>
							<td class="month-value">-</td>
						</tr>
						<tr>
							<td class="metric-label">Est. CO₂ (${this.co2Per1kTokens}g/1k&nbsp;tk)</td>
							<td class="today-value">${stats.today.co2.toFixed(2)} g</td>
							<td class="month-value">${stats.month.co2.toFixed(2)} g</td>
							<td class="month-value">${projectedCo2.toFixed(2)} g</td>
						</tr>
						<tr>
							<td class="metric-label">💧 Est. Water (${this.waterUsagePer1kTokens}L/1k&nbsp;tk)</td>
							<td class="today-value">${stats.today.waterUsage.toFixed(3)} L</td>
							<td class="month-value">${stats.month.waterUsage.toFixed(3)} L</td>
							<td class="month-value">${projectedWater.toFixed(3)} L</td>
						</tr>
						<tr>
							<td class="metric-label">🌳 Tree Equivalent (yr)</td>
							<td class="today-value">${stats.today.treesEquivalent.toFixed(6)}</td>
							<td class="month-value">${stats.month.treesEquivalent.toFixed(6)}</td>
							<td class="month-value">${projectedTrees.toFixed(4)}</td>
						</tr>
					</tbody>
				</table>

				${this.getModelUsageHtml(stats)}

				<div style="margin-top: 24px;">
					<h3 style="color: #ffffff; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
						<span>💡</span>
						<span>Calculation & Estimates</span>
					</h3>
					<p style="font-size: 12px; color: #b3b3b3; margin-bottom: 8px;">
						Token counts are estimated based on character count. CO₂, tree equivalents, water usage, and costs are derived from these token estimates.
					</p>
					<ul style="font-size: 12px; color: #b3b3b3; padding-left: 20px; list-style-position: inside; margin-top: 8px;">
						<li><b>Cost Estimate:</b> Based on public API pricing (see <a href="https://github.com/rajbos/github-copilot-token-usage/blob/main/src/modelPricing.json" style="color: #3794ff;">modelPricing.json</a> for sources and rates). Uses actual input/output token counts for accurate cost calculation. <b>Note:</b> GitHub Copilot pricing may differ from direct API usage. These are reference estimates only.</li>
						<li><b>CO₂ Estimate:</b> Based on ~${this.co2Per1kTokens}g of CO₂e per 1,000 tokens.</li>
						<li><b>Tree Equivalent:</b> Represents the fraction of a single mature tree's annual CO₂ absorption (~${(this.co2AbsorptionPerTreePerYear / 1000).toFixed(1)} kg/year).</li>
						<li><b>Water Estimate:</b> Based on ~${this.waterUsagePer1kTokens}L of water per 1,000 tokens for data center cooling and operations.</li>
					</ul>
				</div>

				<div class="footer">
					Last updated: ${stats.lastUpdated.toLocaleString()}<br>
					Updates automatically every 5 minutes
					<br>
					<button class="refresh-button" onclick="refreshData()">
						<span>🔄</span>
						<span>Refresh Now</span>
					</button>
					<button class="refresh-button" onclick="showChart()" style="margin-left: 8px; background: #0e639c;">
						<span>📈</span>
						<span>Show Chart</span>
					</button>
					<button class="refresh-button" onclick="showDiagnostics()" style="margin-left: 8px; background: #5a5a5a;">
						<span>🔍</span>
						<span>Diagnostics</span>
					</button>
				</div>
			</div>

			<script>
				const vscode = acquireVsCodeApi();

				function refreshData() {
					// Send message to extension to refresh data
					vscode.postMessage({ command: 'refresh' });
				}

				function showChart() {
					// Send message to extension to show chart
					vscode.postMessage({ command: 'showChart' });
				}

				function showDiagnostics() {
					// Send message to extension to show diagnostic report
					vscode.postMessage({ command: 'showDiagnostics' });
				}
			</script>
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
					report.push(`  - Status: ${JSON.stringify(copilotApi.status)}`);
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
				sessionFiles.slice(0, 20).forEach((file, index) => {
					const stat = fs.statSync(file);
					report.push(`  ${index + 1}. ${file}`);
					report.push(`     - Size: ${stat.size} bytes`);
					report.push(`     - Modified: ${stat.mtime.toISOString()}`);
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
			const stats = await this.calculateDetailedStats();
			
			// Today's stats
			report.push('### Today');
			report.push(`  - Total Tokens: ${stats.today.tokens.toLocaleString()}`);
			report.push(`  - Sessions: ${stats.today.sessions}`);
			report.push(`  - Avg Interactions/Session: ${stats.today.avgInteractionsPerSession}`);
			report.push(`  - Avg Tokens/Session: ${stats.today.avgTokensPerSession.toLocaleString()}`);
			report.push(`  - Estimated Cost: $${stats.today.estimatedCost.toFixed(4)}`);
			
			// Model breakdown for today
			if (Object.keys(stats.today.modelUsage).length > 0) {
				report.push('  - Models Used:');
				for (const [model, usage] of Object.entries(stats.today.modelUsage)) {
					const total = usage.inputTokens + usage.outputTokens;
					report.push(`    * ${model}: ${total.toLocaleString()} tokens (↑${usage.inputTokens.toLocaleString()} ↓${usage.outputTokens.toLocaleString()})`);
				}
			}
			report.push('');
			
			// Month's stats
			report.push('### This Month');
			report.push(`  - Total Tokens: ${stats.month.tokens.toLocaleString()}`);
			report.push(`  - Sessions: ${stats.month.sessions}`);
			report.push(`  - Avg Interactions/Session: ${stats.month.avgInteractionsPerSession}`);
			report.push(`  - Avg Tokens/Session: ${stats.month.avgTokensPerSession.toLocaleString()}`);
			report.push(`  - Estimated Cost: $${stats.month.estimatedCost.toFixed(4)}`);
			
			// Model breakdown for month
			if (Object.keys(stats.month.modelUsage).length > 0) {
				report.push('  - Models Used:');
				for (const [model, usage] of Object.entries(stats.month.modelUsage)) {
					const total = usage.inputTokens + usage.outputTokens;
					report.push(`    * ${model}: ${total.toLocaleString()} tokens (↑${usage.inputTokens.toLocaleString()} ↓${usage.outputTokens.toLocaleString()})`);
				}
			}
			report.push('');
		} catch (error) {
			report.push(`Error calculating statistics: ${error}`);
			report.push('');
		}
		
		// Cache Statistics
		report.push('## Cache Statistics');
		report.push(`  - Cached Session Files: ${this.sessionFileCache.size}`);
		report.push('');
		
		// Footer
		report.push('='.repeat(70));
		report.push(`Report Generated: ${new Date().toISOString()}`);
		report.push('='.repeat(70));
		report.push('');
		report.push('This report can be shared with the extension maintainers to help');
		report.push('troubleshoot issues. No sensitive data from your code is included.');
		report.push('');
		report.push('Submit issues at:');
		report.push('https://github.com/rajbos/github-copilot-token-usage/issues');
		
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
					const issueUrl = 'https://github.com/rajbos/github-copilot-token-usage/issues/new';
					await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
					break;
			}
		});
	}

	private getDiagnosticReportHtml(report: string): string {
		// Escape HTML special characters in the report
		const escapedReport = report
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
		
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
			</script>
		</body>
		</html>`;
	}

	private getChartHtml(dailyStats: DailyTokenStats[]): string {
		// Prepare data for Chart.js
		const labels = dailyStats.map(stat => stat.date);
		const tokensData = dailyStats.map(stat => stat.tokens);
		const sessionsData = dailyStats.map(stat => stat.sessions);

		// Prepare model-specific data for stacked bars
		const allModels = new Set<string>();
		dailyStats.forEach(stat => {
			Object.keys(stat.modelUsage).forEach(model => allModels.add(model));
		});
		const modelList = Array.from(allModels).sort();
		
		// Create model-specific datasets for stacked view
		const modelColors = [
			'rgba(54, 162, 235, 0.8)',
			'rgba(255, 99, 132, 0.8)',
			'rgba(255, 206, 86, 0.8)',
			'rgba(75, 192, 192, 0.8)',
			'rgba(153, 102, 255, 0.8)',
			'rgba(255, 159, 64, 0.8)',
			'rgba(199, 199, 199, 0.8)',
			'rgba(83, 102, 255, 0.8)'
		];
		
		const modelDatasets = modelList.map((model, index) => {
			const data = dailyStats.map(stat => {
				const usage = stat.modelUsage[model];
				return usage ? usage.inputTokens + usage.outputTokens : 0;
			});
			
			return {
				label: this.getModelDisplayName(model),
				data: data,
				backgroundColor: modelColors[index % modelColors.length],
				borderColor: modelColors[index % modelColors.length].replace('0.8', '1'),
				borderWidth: 1
			};
		});

		// Pre-calculate summary statistics
		const totalTokens = dailyStats.reduce((sum, stat) => sum + stat.tokens, 0);
		const totalSessions = dailyStats.reduce((sum, stat) => sum + stat.sessions, 0);
		const avgTokensPerDay = dailyStats.length > 0 ? Math.round(totalTokens / dailyStats.length) : 0;

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Token Usage Over Time</title>
			<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
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
				.chart-container {
					position: relative;
					height: 400px;
					margin-bottom: 16px;
				}
				.footer {
					margin-top: 12px;
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
					margin-top: 12px;
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
				.stats-summary {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
					gap: 12px;
					margin-bottom: 16px;
				}
				.stat-card {
					background: #353535;
					border: 1px solid #5a5a5a;
					border-radius: 4px;
					padding: 12px;
					text-align: center;
				}
				.stat-label {
					font-size: 11px;
					color: #b3b3b3;
					margin-bottom: 4px;
				}
				.stat-value {
					font-size: 18px;
					font-weight: 600;
					color: #ffffff;
				}
				.chart-controls {
					display: flex;
					justify-content: center;
					gap: 8px;
					margin-bottom: 16px;
				}
				.toggle-button {
					background: #353535;
					border: 1px solid #5a5a5a;
					color: #cccccc;
					padding: 6px 12px;
					border-radius: 4px;
					cursor: pointer;
					font-size: 12px;
					transition: all 0.2s;
				}
				.toggle-button.active {
					background: #0e639c;
					border-color: #1177bb;
					color: #ffffff;
				}
				.toggle-button:hover {
					background: #4a4a4a;
				}
				.toggle-button.active:hover {
					background: #1177bb;
				}
			</style>
		</head>
		<body>
			<div class="container">
				<div class="header">
					<span class="header-icon">📈</span>
					<span class="header-title">Token Usage Over Time</span>
				</div>
				
				<div class="stats-summary">
					<div class="stat-card">
						<div class="stat-label">Total Days</div>
						<div class="stat-value">${dailyStats.length}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Total Tokens</div>
						<div class="stat-value">${totalTokens.toLocaleString()}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Avg Tokens/Day</div>
						<div class="stat-value">${avgTokensPerDay.toLocaleString()}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Total Sessions</div>
						<div class="stat-value">${totalSessions}</div>
					</div>
				</div>

				<div class="chart-controls">
					<button class="toggle-button active" id="totalViewBtn" onclick="switchView('total')">Total Tokens</button>
					<button class="toggle-button" id="modelViewBtn" onclick="switchView('model')">By Model</button>
				</div>

				<div class="chart-container">
					<canvas id="tokenChart"></canvas>
				</div>

				<div class="footer">
					Day-by-day token usage for the current month
					<br>
					Last updated: ${new Date().toLocaleString()}
					<br>
					<em>Updates automatically every 5 minutes</em>
					<br>
					<button class="refresh-button" onclick="refreshChart()">
						<span>🔄</span>
						<span>Refresh Chart</span>
					</button>
				</div>
			</div>

			<script>
				const vscode = acquireVsCodeApi();

				function refreshChart() {
					vscode.postMessage({ command: 'refresh' });
				}

				// Data for different views
				const labels = ${JSON.stringify(labels)};
				const tokensData = ${JSON.stringify(tokensData)};
				const sessionsData = ${JSON.stringify(sessionsData)};
				const modelDatasets = ${JSON.stringify(modelDatasets)};

				// Chart instance
				let chart;
				let currentView = 'total';

				// Initialize chart with total view
				const ctx = document.getElementById('tokenChart').getContext('2d');
				
				function createTotalView() {
					return {
						type: 'bar',
						data: {
							labels: labels,
							datasets: [
								{
									label: 'Tokens',
									data: tokensData,
									backgroundColor: 'rgba(54, 162, 235, 0.6)',
									borderColor: 'rgba(54, 162, 235, 1)',
									borderWidth: 1,
									yAxisID: 'y'
								},
								{
									label: 'Sessions',
									data: sessionsData,
									backgroundColor: 'rgba(255, 99, 132, 0.6)',
									borderColor: 'rgba(255, 99, 132, 1)',
									borderWidth: 1,
									type: 'line',
									yAxisID: 'y1'
								}
							]
						},
						options: {
							responsive: true,
							maintainAspectRatio: false,
							interaction: {
								mode: 'index',
								intersect: false,
							},
							scales: {
								x: {
									grid: { color: '#5a5a5a' },
									ticks: { color: '#cccccc', font: { size: 11 } }
								},
								y: {
									type: 'linear',
									display: true,
									position: 'left',
									grid: { color: '#5a5a5a' },
									ticks: { 
										color: '#cccccc', 
										font: { size: 11 },
										callback: function(value) { return value.toLocaleString(); }
									},
									title: {
										display: true,
										text: 'Tokens',
										color: '#cccccc',
										font: { size: 12, weight: 'bold' }
									}
								},
								y1: {
									type: 'linear',
									display: true,
									position: 'right',
									grid: { drawOnChartArea: false },
									ticks: { color: '#cccccc', font: { size: 11 } },
									title: {
										display: true,
										text: 'Sessions',
										color: '#cccccc',
										font: { size: 12, weight: 'bold' }
									}
								}
							},
							plugins: {
								legend: {
									position: 'top',
									labels: { color: '#cccccc', font: { size: 12 } }
								},
								tooltip: {
									backgroundColor: 'rgba(0, 0, 0, 0.8)',
									titleColor: '#ffffff',
									bodyColor: '#cccccc',
									borderColor: '#5a5a5a',
									borderWidth: 1,
									padding: 10,
									displayColors: true
								}
							}
						}
					};
				}

				function createModelView() {
					return {
						type: 'bar',
						data: {
							labels: labels,
							datasets: modelDatasets
						},
						options: {
							responsive: true,
							maintainAspectRatio: false,
							interaction: {
								mode: 'index',
								intersect: false,
							},
							scales: {
								x: {
									stacked: true,
									grid: { color: '#5a5a5a' },
									ticks: { color: '#cccccc', font: { size: 11 } }
								},
								y: {
									stacked: true,
									grid: { color: '#5a5a5a' },
									ticks: { 
										color: '#cccccc', 
										font: { size: 11 },
										callback: function(value) { return value.toLocaleString(); }
									},
									title: {
										display: true,
										text: 'Tokens by Model',
										color: '#cccccc',
										font: { size: 12, weight: 'bold' }
									}
								}
							},
							plugins: {
								legend: {
									position: 'top',
									labels: { color: '#cccccc', font: { size: 12 } }
								},
								tooltip: {
									backgroundColor: 'rgba(0, 0, 0, 0.8)',
									titleColor: '#ffffff',
									bodyColor: '#cccccc',
									borderColor: '#5a5a5a',
									borderWidth: 1,
									padding: 10,
									displayColors: true
								}
							}
						}
					};
				}

				function switchView(viewType) {
					currentView = viewType;
					
					// Update button states
					document.getElementById('totalViewBtn').classList.toggle('active', viewType === 'total');
					document.getElementById('modelViewBtn').classList.toggle('active', viewType === 'model');
					
					// Destroy existing chart
					if (chart) {
						chart.destroy();
					}
					
					// Create new chart based on view type
					const config = viewType === 'total' ? createTotalView() : createModelView();
					chart = new Chart(ctx, config);
				}

				// Initialize with total view
				chart = new Chart(ctx, createTotalView());
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
		this.statusBarItem.dispose();
		this.outputChannel.dispose();
		// Clear cache on disposal
		this.sessionFileCache.clear();
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Create the token tracker
	const tokenTracker = new CopilotTokenTracker();

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

	// Register the generate diagnostic report command
	const generateDiagnosticReportCommand = vscode.commands.registerCommand('copilot-token-tracker.generateDiagnosticReport', async () => {
		tokenTracker.log('Generate diagnostic report command called');
		await tokenTracker.showDiagnosticReport();
	});

	// Add to subscriptions for proper cleanup
	context.subscriptions.push(refreshCommand, showDetailsCommand, showChartCommand, generateDiagnosticReportCommand, tokenTracker);

	tokenTracker.log('Extension activation complete');
}

export function deactivate() {
	// Extension cleanup is handled in the CopilotTokenTracker class
}
