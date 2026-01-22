import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';
import * as packageJson from '../package.json';
import { parseSessionFileContent as parseSessionFileContentShared } from './sessionParser';

// Design doc: docs/specs/backend/design/backend-sync-qa-design.md

import {
	safeStringifyError,
	isAzurePolicyDisallowedError,
	isStorageLocalAuthDisallowedByPolicyError
} from './utils/errors';

import { writeClipboardText } from './utils/clipboard';
import { escapeHtml, escapeAttr, safeJsonForInlineScript } from './utils/html';

import type { BackendAuthMode, BackendType, BackendSettings, BackendQueryFilters } from './backend/settings';
import { shouldPromptToSetSharedKey } from './backend/settings';
import type { BackendAggDailyEntityLike, TableClientLike } from './backend/storageTables';
import {
	buildAggPartitionKey,
	buildOdataEqFilter,
	listAggDailyEntitiesFromTableClient,
	stableDailyRollupRowKey
} from './backend/storageTables';
import type { DailyRollupKey, DailyRollupMapEntryLike, DailyRollupValueLike } from './backend/rollups';
import { dailyRollupMapKey, isoWeekKeyFromUtcDayKey, upsertDailyRollup } from './backend/rollups';
import type { BackendCopyConfigValues, BackendCopyPayloadV1 } from './backend/copyConfig';

import { BackendFacade } from './backend/facade';
import { BackendCommandHandler } from './backend/commands';
import { BackendIntegration } from './backend/integration';
import { computeBackendSharingPolicy } from './backend/sharingProfile';
import type { ModelUsage } from './backend/types';

// Re-export for backward compatibility with tests
export { shouldPromptToSetSharedKey } from './backend/settings';

interface DailyRollupValue {
	inputTokens: number;
	outputTokens: number;
	interactions: number;
}

interface TokenUsageStats {
	todayTokens: number;
	monthTokens: number;
	lastUpdated: Date;
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

interface BackendQueryResult {
	stats: DetailedStats;
	availableModels: string[];
	availableWorkspaces: string[];
	availableMachines: string[];
	availableUsers: string[];
	workspaceTokenTotals: Array<{ workspaceId: string; tokens: number }>;
	machineTokenTotals: Array<{ machineId: string; tokens: number }>;
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
}

class CopilotTokenTracker implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private context: vscode.ExtensionContext | undefined;
	private readonly extensionUri: vscode.Uri;

	// Helper method to get total tokens from ModelUsage
	private getTotalTokensFromModelUsage(modelUsage: ModelUsage): number {
		return Object.values(modelUsage).reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0);
	}

	private getNonce(): string {
		return crypto.randomBytes(16).toString('base64');
	}

	private getCsp(webview: vscode.Webview, nonce: string, extraScriptSrc: string[] = []): string {
		const scriptSrc = [`'nonce-${nonce}'`, webview.cspSource, ...extraScriptSrc].join(' ');
		return [
			"default-src 'none'",
			`img-src ${webview.cspSource} https: data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${scriptSrc}`,
			`connect-src ${webview.cspSource} https:`
		].join('; ');
	}
	private updateInterval: NodeJS.Timeout | undefined;
	private initialDelayTimeout: NodeJS.Timeout | undefined;
	private backend: BackendFacade;
	private backendIntegration: BackendIntegration;
	private backendCommands: BackendCommandHandler;

	public get commands(): BackendCommandHandler {
		return this.backendCommands;
	}

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
			this.outputChannel.appendLine(`[${timestamp}] ${safeStringifyError(error)}`);
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

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.extensionUri = context.extensionUri;
		// Create output channel for extension logs
		this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot Token Tracker');
		this.log('Constructor called');

		this.backend = new BackendFacade({
			context: this.context,
			log: (m) => this.log(m),
			warn: (m) => this.warn(m),
			updateTokenStats: async () => {
				await this.updateTokenStats();
			},
			calculateEstimatedCost: (mu) => this.calculateEstimatedCost(mu),
			co2Per1kTokens: this.co2Per1kTokens,
			waterUsagePer1kTokens: this.waterUsagePer1kTokens,
			co2AbsorptionPerTreePerYear: this.co2AbsorptionPerTreePerYear,
			getCopilotSessionFiles: async () => await this.getCopilotSessionFiles(),
			estimateTokensFromText: (text, model) => this.estimateTokensFromText(text, model),
			getModelFromRequest: (request) => this.getModelFromRequest(request)
		});

		this.backendIntegration = new BackendIntegration({
			facade: this.backend,
			context: this.context,
			warn: (m) => this.warn(m),
			error: (m, e) => this.error(m, e),
			updateTokenStats: async () => await this.updateTokenStats(),
			toUtcDayKey: (date) => this.toUtcDayKey(date)
		});

		this.backendCommands = new BackendCommandHandler({
			facade: this.backend,
			integration: this.backendIntegration,
			calculateEstimatedCost: (mu: unknown) => this.calculateEstimatedCost(mu as ModelUsage),
			warn: (m) => this.warn(m),
			log: (m) => this.log(m)
		});

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

		// Backend sync runs independently and should never block local mode.
		this.backend.startTimerIfEnabled();
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

	private getBackendSettings(): BackendSettings {
		return this.backendIntegration.getSettings();
	}

	private isBackendConfigured(settings: BackendSettings): boolean {
		return this.backendIntegration.isConfigured(settings);
	}

	private async tryGetBackendDetailedStatsForStatusBar(settings: BackendSettings): Promise<DetailedStats | undefined> {
		return (await this.backend.tryGetBackendDetailedStatsForStatusBar(settings)) as DetailedStats | undefined;
	}

	private async syncToBackendStore(force: boolean): Promise<void> {
		await this.backendIntegration.syncToBackendStore(force);
	}

	public async updateTokenStats(): Promise<DetailedStats | undefined> {
		try {
			this.log('Updating token stats...');

			const backendSettings = this.backend.getSettings();
			let detailedStats: DetailedStats | undefined;
			if (backendSettings.enabled && this.backend.isConfigured(backendSettings)) {
				detailedStats = await this.tryGetBackendDetailedStatsForStatusBar(backendSettings);
				if (!detailedStats) {
					this.warn('Backend sync enabled but backend query failed; falling back to local stats');
				}

				// Kick off sync in the background. It should not block UI.
				this.syncToBackendStore(false).catch((e: any) => {
					this.warn(`Backend sync failed: ${e?.message ?? e}`);
				});
			}

			if (!detailedStats) {
				let computedStats: DetailedStats | undefined;
				let lastProgress = 0;
				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Window,
					title: 'Copilot Tokens'
				}, async (progress) => {
					progress.report({ increment: 0, message: 'Analyzing logs…' });
					computedStats = await this.calculateDetailedStats((completed, total) => {
						const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
						const increment = Math.max(percentage - lastProgress, 0);
						lastProgress = percentage;
						progress.report({ increment, message: `Analyzing ${completed}/${total}` });
						this.statusBarItem.text = `$(loading~spin) Analyzing Logs: ${percentage}%`;
					});
					if (lastProgress < 100) {
						progress.report({ increment: 100 - lastProgress, message: 'Finalizing…' });
					}
				});

				detailedStats = computedStats ?? await this.calculateDetailedStats();
			}

			this.statusBarItem.text = `$(symbol-numeric) ${detailedStats.today.tokens.toLocaleString()} | ${detailedStats.month.tokens.toLocaleString()}`;

			// Create detailed tooltip with markdown support
			const tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown('## 🤖 GitHub Copilot Token Usage\n\n');
			tooltip.appendMarkdown('### 📅 Today\n');
			tooltip.appendMarkdown(`**Tokens:** ${detailedStats.today.tokens.toLocaleString()}\n\n`);
			tooltip.appendMarkdown(`**Est. Cost:** $${detailedStats.today.estimatedCost.toFixed(2)}\n\n`);
			tooltip.appendMarkdown(`**CO₂ Est.:** ${detailedStats.today.co2.toFixed(2)}g\n\n`);
			tooltip.appendMarkdown(`**Water Est.:** ${detailedStats.today.waterUsage.toFixed(3)}L\n\n`);
			tooltip.appendMarkdown(`**Sessions:** ${detailedStats.today.sessions}\n\n`);
			tooltip.appendMarkdown(`**Avg Interactions/Session:** ${detailedStats.today.avgInteractionsPerSession}\n\n`);
			tooltip.appendMarkdown(`**Avg Tokens/Session:** ${detailedStats.today.avgTokensPerSession.toLocaleString()}\n\n`);
			tooltip.appendMarkdown('### 📊 This Month\n');
			tooltip.appendMarkdown(`**Tokens:** ${detailedStats.month.tokens.toLocaleString()}\n\n`);
			tooltip.appendMarkdown(`**Est. Cost:** $${detailedStats.month.estimatedCost.toFixed(2)}\n\n`);
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

			this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Month: ${detailedStats.month.tokens}`);
			return detailedStats;
		} catch (error) {
			this.error('Error updating token stats:', error);
			this.statusBarItem.text = '$(error) Token Error';
			this.statusBarItem.tooltip = 'Error calculating token usage';
			return undefined;
		}
	}

	private async getStatsForDetailsPanel(): Promise<DetailedStats | undefined> {
		return await this.backendIntegration.getStatsForDetailsPanel() as DetailedStats | undefined;
	}

	private setBackendFiltersFromWebview(filters: Partial<BackendQueryFilters>): void {
		this.backendIntegration.setFilters(filters);
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
						const sessionData = await this.getSessionFileDataCached(sessionFile, fileStats.mtime.getTime());
						monthTokens += sessionData.tokens;

						// If modified today, add to today's count
						if (fileStats.mtime >= todayStart) {
							todayTokens += sessionData.tokens;
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
						
						const sessionData = await this.getSessionFileDataCached(sessionFile, fileStats.mtime.getTime());
						const tokens = sessionData.tokens;
						const interactions = sessionData.interactions;
						const modelUsage = sessionData.modelUsage;
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
						const sessionData = await this.getSessionFileDataCached(sessionFile, fileStats.mtime.getTime());
						const tokens = sessionData.tokens;
						const interactions = sessionData.interactions;
						const modelUsage = sessionData.modelUsage;
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

	private toUtcDayKey(date: Date): string {
		return date.toISOString().slice(0, 10);
	}

	private addDaysUtc(dayKey: string, daysToAdd: number): string {
		const date = new Date(`${dayKey}T00:00:00.000Z`);
		date.setUTCDate(date.getUTCDate() + daysToAdd);
		return this.toUtcDayKey(date);
	}

	private getDayKeysInclusive(startDayKey: string, endDayKey: string): string[] {
		const result: string[] = [];
		let current = startDayKey;
		while (current <= endDayKey) {
			result.push(current);
			if (current === endDayKey) {
				break;
			}
			current = this.addDaysUtc(current, 1);
		}
		return result;
	}

	public async exportCurrentViewJson(): Promise<void> {
		await this.backendCommands.exportCurrentView();
	}

	private parseSessionFileContent(sessionFilePath: string, fileContent: string): Omit<SessionFileCache, 'mtime'> {
		return parseSessionFileContentShared(
			sessionFilePath,
			fileContent,
			(text, model) => this.estimateTokensFromText(text, model),
			(req) => this.getModelFromRequest(req)
		);
	}

	// Cached version of session file parsing
	private async getSessionFileDataCached(sessionFilePath: string, mtime: number): Promise<SessionFileCache> {
		// Check if we have valid cached data
		const cached = this.getCachedSessionData(sessionFilePath);
		if (cached && cached.mtime === mtime) {
			return cached;
		}

		let fileContent: string;
		try {
			fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
		} catch (error) {
			this.warn(`Error reading session file ${sessionFilePath}: ${error}`);
			const sessionData: SessionFileCache = { tokens: 0, interactions: 0, modelUsage: {}, mtime };
			this.setCachedSessionData(sessionFilePath, sessionData);
			return sessionData;
		}

		const parsed = this.parseSessionFileContent(sessionFilePath, fileContent);
		
		const sessionData: SessionFileCache = {
			tokens: parsed.tokens,
			interactions: parsed.interactions,
			modelUsage: parsed.modelUsage,
			mtime
		};

		this.setCachedSessionData(sessionFilePath, sessionData);
		return sessionData;
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

	private async getCopilotSessionFiles(): Promise<string[]> {
		const sessionFiles: string[] = [];

		const platform = os.platform();

		// Debug environment information without emitting PII
		this.log('Scanning for Copilot session files');
		this.log(`Platform: ${platform}`);

		// Get all possible VS Code user paths (stable, insiders, remote, etc.)
		const allVSCodePaths = this.getVSCodeUserPaths();
		this.log(`Checking ${allVSCodePaths.length} VS Code path variants`);

		// Track which paths we actually found
		const foundPaths: string[] = [];
		for (const codeUserPath of allVSCodePaths) {
			if (fs.existsSync(codeUserPath)) {
				foundPaths.push(codeUserPath);
			}
		}
		this.log(`Found ${foundPaths.length} VS Code user paths to scan for session files.`);

		try {
			// Scan all found VS Code paths for session files
			for (const codeUserPath of foundPaths) {

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
								// Do NOT log full workspace directory path (contains machine-specific hash)
								this.log(`Found ${sessionFiles2.length} session files in workspace storage`);
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
					// Do NOT log full path (contains homedir)
					this.log(`Found github.copilot-chat global storage`);
					this.scanDirectoryForSessionFiles(copilotChatGlobalPath, sessionFiles);
				}
			}

			// Check for Copilot CLI session-state directory (new location for agent mode sessions)
			// Do NOT construct or log this path with os.homedir() at info level
			// Only check if it exists without revealing the full path
			const copilotCliSessionPath = path.join(os.homedir(), '.copilot', 'session-state');
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

			// Log summary without revealing absolute paths
			this.log(`Total session files found: ${sessionFiles.length}`);
			if (sessionFiles.length === 0) {
				this.warn('No GitHub Copilot session files found. This could be because:');
				this.log('  1. Copilot extensions are not active');
				this.log('  2. No Copilot Chat conversations have been initiated yet');
				this.log('  3. Sessions are stored in a different location not yet supported');
				this.log('  4. User needs to authenticate with GitHub Copilot first');
				this.log('  Run: node scripts/diagnose-session-files.js for detailed diagnostics');
			}
		} catch (error) {
			this.error('Error getting session files:', error);
		}

		return sessionFiles;
	}

	/**
	 * Recursively scan a directory for session files (.json and .jsonl)
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

	private getModelFromRequest(request: any): string {
		const direct = request?.model;
		if (typeof direct === 'string' && direct) {
			return direct;
		}

		const resultModel = request?.result?.model;
		if (typeof resultModel === 'string' && resultModel) {
			return resultModel;
		}

		const modelId = request?.result?.modelId;
		if (typeof modelId === 'string' && modelId) {
			return modelId;
		}

		const details = request?.result?.details;
		if (typeof details === 'string' && details) {
			if (details.includes('Claude Sonnet 3.5')) { return 'claude-sonnet-3.5'; }
			if (details.includes('Claude Sonnet 3.7')) { return 'claude-sonnet-3.7'; }
			if (details.includes('Claude Sonnet 4')) { return 'claude-sonnet-4'; }
			if (details.includes('Gemini 2.5 Pro')) { return 'gemini-2.5-pro'; }
			if (details.includes('Gemini 3 Pro (Preview)')) { return 'gemini-3-pro-preview'; }
			if (details.includes('Gemini 3 Pro')) { return 'gemini-3-pro'; }
			if (details.includes('GPT-4.1')) { return 'gpt-4.1'; }
			if (details.includes('GPT-4o-mini')) { return 'gpt-4o-mini'; }
			if (details.includes('GPT-4o')) { return 'gpt-4o'; }
			if (details.includes('GPT-4')) { return 'gpt-4'; }
			if (details.includes('GPT-5')) { return 'gpt-5'; }
			if (details.includes('GPT-3.5-Turbo')) { return 'gpt-3.5-turbo'; }
			if (details.includes('o3-mini')) { return 'o3-mini'; }
			if (details.includes('o4-mini')) { return 'o4-mini'; }
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

		// Show progress indicator for immediate feedback
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Loading Copilot Token Usage Details",
			cancellable: false
		}, async (progress) => {
			progress.report({ increment: 0, message: "Retrieving statistics..." });

			// Get detailed stats (backend-aware)
			const stats = await this.getStatsForDetailsPanel();
			if (!stats) {
				vscode.window.showErrorMessage('Failed to load token usage details. Check the output channel for more information.');
				return;
			}

			progress.report({ increment: 50, message: "Preparing view..." });

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

			progress.report({ increment: 30, message: "Rendering..." });

			// Set the HTML content
			this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);

			progress.report({ increment: 20, message: "Complete!" });

			// Handle messages from the webview
			this.detailsPanel.webview.onDidReceiveMessage(async (message) => {
				switch (message.command) {
					case 'refresh':
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Refreshing Token Usage",
							cancellable: false
						}, async (progress) => {
							progress.report({ increment: 0, message: "Retrieving statistics..." });
							await this.refreshDetailsPanel();
							progress.report({ increment: 100, message: "Complete!" });
						});
						break;
					case 'setBackendFilters':
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Applying filters",
							cancellable: false
						}, async (progress) => {
							progress.report({ increment: 0, message: "Updating filters..." });
							this.setBackendFiltersFromWebview(message.filters || {});
							progress.report({ increment: 50, message: "Refreshing view..." });
							await this.refreshDetailsPanel();
							progress.report({ increment: 50, message: "Complete!" });
						});
						break;
					case 'exportJson':
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Exporting Data",
							cancellable: false
						}, async (progress) => {
							progress.report({ increment: 0, message: "Preparing export..." });
							await this.exportCurrentViewJson();
							progress.report({ increment: 100, message: "Complete!" });
						});
						break;
					case 'configureBackend':
						await this.backend.configureBackendWizard();
						break;
					case 'showChart':
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Loading Chart",
							cancellable: false
						}, async (progress) => {
							progress.report({ increment: 0, message: "Calculating daily statistics..." });
							await this.showChart();
							progress.report({ increment: 100, message: "Complete!" });
						});
						break;
					case 'showDiagnostics':
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Running Diagnostics",
							cancellable: false
						}, async (progress) => {
							progress.report({ increment: 0, message: "Gathering diagnostic information..." });
							await this.showDiagnosticReport();
							progress.report({ increment: 100, message: "Complete!" });
						});
						break;
				}
			});

			// Handle panel disposal
			this.detailsPanel.onDidDispose(() => {
				this.detailsPanel = undefined;
			});
		});
	}

	public async showChart(): Promise<void> {
		// If panel already exists, just reveal it
		if (this.chartPanel) {
			this.chartPanel.reveal();
			return;
		}

		// Show progress indicator for immediate feedback
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Loading Token Usage Chart",
			cancellable: false
		}, async (progress) => {
			progress.report({ increment: 0, message: "Calculating daily statistics..." });

			// Get daily stats
			const dailyStats = await this.calculateDailyStats();

			progress.report({ increment: 50, message: "Rendering chart..." });

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
			this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, dailyStats);

			progress.report({ increment: 50, message: "Complete!" });

			// Handle messages from the webview
			this.chartPanel.webview.onDidReceiveMessage(async (message) => {
				switch (message.command) {
					case 'refresh':
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Refreshing Chart",
							cancellable: false
						}, async (progress) => {
							progress.report({ increment: 0, message: "Recalculating statistics..." });
							await this.refreshChartPanel();
							progress.report({ increment: 100, message: "Complete!" });
						});
						break;
					case 'setBackendFilters':
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Applying filters",
							cancellable: false
						}, async (progress) => {
							progress.report({ increment: 0, message: "Updating filters..." });
							this.setBackendFiltersFromWebview(message.filters || {});
							progress.report({ increment: 50, message: "Refreshing chart..." });
							await this.refreshChartPanel();
							progress.report({ increment: 50, message: "Complete!" });
						});
						break;
					case 'configureBackend':
						await this.backend.configureBackendWizard();
						break;
				}
			});

			// Handle panel disposal
			this.chartPanel.onDidDispose(() => {
				this.chartPanel = undefined;
			});
		});
	}

	private async refreshDetailsPanel(): Promise<void> {
		if (!this.detailsPanel) {
			return;
		}

		// Update token stats (backend-aware) and refresh the webview content
		const stats = await this.getStatsForDetailsPanel();
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

	private getBackendFilterPanelHtml(includeExportButton: boolean = true): string {
		const backendSettings = this.getBackendSettings();
		const backendEnabled = backendSettings.enabled && this.isBackendConfigured(backendSettings);
		const backendFilters = this.backend.getFilters();
		const backendResult = backendEnabled ? this.backend.getLastQueryResult() : undefined;

		const modelOptions = [''].concat(backendResult?.availableModels ?? []).map((m) => {
			const label = m ? this.getModelDisplayName(m) : 'All models';
			const selected = (backendFilters.model || '') === m ? 'selected' : '';
			return `<option value="${escapeAttr(m)}" ${selected}>${escapeHtml(label)}</option>`;
		}).join('');
		const workspaceOptions = [''].concat(backendResult?.availableWorkspaces ?? []).map((w) => {
			const mapped = w ? (backendResult?.workspaceNamesById?.[w] ?? '') : '';
			const label = w ? (mapped ? `${mapped} — ${w}` : w) : 'All workspaces';
			const selected = (backendFilters.workspaceId || '') === w ? 'selected' : '';
			return `<option value="${escapeAttr(w)}" ${selected}>${escapeHtml(label)}</option>`;
		}).join('');
		const machineOptions = [''].concat(backendResult?.availableMachines ?? []).map((m) => {
			const mapped = m ? (backendResult?.machineNamesById?.[m] ?? '') : '';
			const label = m ? (mapped ? `${mapped} — ${m}` : m) : 'All machines';
			const selected = (backendFilters.machineId || '') === m ? 'selected' : '';
			return `<option value="${escapeAttr(m)}" ${selected}>${escapeHtml(label)}</option>`;
		}).join('');
		const userOptions = [''].concat(backendResult?.availableUsers ?? []).map((u) => {
			const label = u ? u : 'All users';
			const selected = (backendFilters.userId || '') === u ? 'selected' : '';
			return `<option value="${escapeAttr(u)}" ${selected}>${escapeHtml(label)}</option>`;
		}).join('');

		const exportButtonHtml = includeExportButton ? `
			<div>
				<button class="refresh-button" data-action="exportJson" style="margin-top:0; background:#5a5a5a;">Export JSON</button>
			</div>
		` : '';

		return backendEnabled ? `
			<div style="margin-bottom: 16px; padding: 12px; border: 1px solid #5a5a5a; border-radius: 8px; background: #353535;">
				<div style="display:flex; justify-content: space-between; align-items: center; gap: 8px;">
					<div>
						<div style="color:#ffffff; font-weight: 600;">Backend Sync: Enabled</div>
						<div style="font-size: 12px; color: #b3b3b3;">Account: ${escapeHtml(backendSettings.storageAccount)} · Table: ${escapeHtml(backendSettings.aggTable)} · Dataset: ${escapeHtml(backendSettings.datasetId)}</div>
					</div>
					${exportButtonHtml}
				</div>
				<div style="display:flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: end;">
					<div>
						<div style="font-size: 11px; color:#b3b3b3; margin-bottom: 2px;">Time range (days)</div>
						<input id="lookbackDays" type="number" min="1" max="365" value="${backendFilters.lookbackDays}" style="width: 110px; padding: 6px; background:#2d2d2d; color:#ffffff; border:1px solid #5a5a5a; border-radius:4px;" />
					</div>
					<div>
						<div style="font-size: 11px; color:#b3b3b3; margin-bottom: 2px;">Model</div>
						<select id="model" style="min-width: 180px; padding: 6px; background:#2d2d2d; color:#ffffff; border:1px solid #5a5a5a; border-radius:4px;">${modelOptions}</select>
					</div>
					<div>
						<div style="font-size: 11px; color:#b3b3b3; margin-bottom: 2px;">Workspace</div>
						<select id="workspaceId" style="min-width: 200px; padding: 6px; background:#2d2d2d; color:#ffffff; border:1px solid #5a5a5a; border-radius:4px;">${workspaceOptions}</select>
					</div>
					<div>
						<div style="font-size: 11px; color:#b3b3b3; margin-bottom: 2px;">User</div>
						<select id="userId" style="min-width: 160px; padding: 6px; background:#2d2d2d; color:#ffffff; border:1px solid #5a5a5a; border-radius:4px;">${userOptions}</select>
					</div>
					<div>
						<div style="font-size: 11px; color:#b3b3b3; margin-bottom: 2px;">Machine</div>
						<select id="machineId" style="min-width: 240px; padding: 6px; background:#2d2d2d; color:#ffffff; border:1px solid #5a5a5a; border-radius:4px;">${machineOptions}</select>
					</div>
					<div>
						<button class="refresh-button" data-action="applyBackendFilters" style="margin-top:0;">Apply Filters</button>
					</div>
					<div>
						<button class="refresh-button" data-action="configureBackend" style="margin-top:0; background:#0e639c;">Reconfigure…</button>
					</div>
				</div>
			</div>
		` : `
			<div style="margin-bottom: 16px; padding: 12px; border: 1px solid #5a5a5a; border-radius: 8px; background: #353535;">
				<div style="display:flex; justify-content: space-between; align-items: center; gap: 8px;">
					<div>
						<div style="color:#ffffff; font-weight: 600;">Backend Sync: Disabled</div>
						<div style="font-size: 12px; color: #b3b3b3;">Enable cross-device aggregation by syncing rollups to your own Azure Storage account.</div>
					</div>
					<div>
						<button class="refresh-button" data-action="configureBackend" style="margin-top:0;">Configure…</button>
					</div>
				</div>
			</div>
		`;
	}

	private getDetailsHtml(webview: vscode.Webview, stats: DetailedStats): string {
		const nonce = this.getNonce();
		const csp = this.getCsp(webview, nonce);
		const usedModels = new Set([
			...Object.keys(stats.today.modelUsage),
			...Object.keys(stats.month.modelUsage)
		]);

		const backendSettings = this.getBackendSettings();
		const backendEnabled = backendSettings.enabled && this.isBackendConfigured(backendSettings);
		const backendFilters = this.backend.getFilters();
		const rangeLabel = backendEnabled ? `Last ${backendFilters.lookbackDays} days` : 'Today';
		const monthLabel = backendEnabled ? 'Month-to-date' : 'This Month';
		const backendResult = backendEnabled ? this.backend.getLastQueryResult() : undefined;

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

		const backendPanelHtml = this.getBackendFilterPanelHtml(true);

		const workspaceTableHtml = backendEnabled && backendResult?.workspaceTokenTotals?.length ? `
			<div style="margin-top: 16px;">
				<h3 style="color: #ffffff; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
					<span>🗂️</span>
					<span>Top Workspaces (Tokens)</span>
				</h3>
				<table class="stats-table">
					<colgroup>
						<col class="metric-col">
						<col class="value-col">
					</colgroup>
					<thead>
						<tr>
							<th>Workspace</th>
							<th>Tokens</th>
						</tr>
					</thead>
					<tbody>
						${backendResult.workspaceTokenTotals.map(w => {
							const name = backendResult.workspaceNamesById?.[w.workspaceId];
							const label = name ? `${name} — ${w.workspaceId}` : w.workspaceId;
							return `
							<tr>
								<td class="metric-label" title="${escapeAttr(w.workspaceId)}">${escapeHtml(label)}</td>
								<td class="month-value">${w.tokens.toLocaleString()}</td>
							</tr>
							`;
						}).join('')}
					</tbody>
				</table>
			</div>
		` : '';

		const machineTableHtml = backendEnabled && backendResult?.machineTokenTotals?.length ? `
			<div style="margin-top: 16px;">
				<h3 style="color: #ffffff; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
					<span>🖥️</span>
					<span>Top Machines (Tokens)</span>
				</h3>
				<table class="stats-table">
					<colgroup>
						<col class="metric-col">
						<col class="value-col">
					</colgroup>
					<thead>
						<tr>
							<th>Machine</th>
							<th>Tokens</th>
						</tr>
					</thead>
					<tbody>
						${backendResult.machineTokenTotals.map(m => {
							const name = backendResult.machineNamesById?.[m.machineId];
							const label = name ? `${name} — ${m.machineId}` : m.machineId;
							return `
							<tr>
								<td class="metric-label" title="${escapeAttr(m.machineId)}">${escapeHtml(label)}</td>
								<td class="month-value">${m.tokens.toLocaleString()}</td>
							</tr>
							`;
						}).join('')}
					</tbody>
				</table>
			</div>
		` : '';

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="${csp}">
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

				${backendPanelHtml}
				
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
									<span>${escapeHtml(rangeLabel)}</span>
								</div>
							</th>
							<th>
								<div class="period-header">
									<span>📊</span>
									<span>${escapeHtml(monthLabel)}</span>
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
							<td class="today-value">$${stats.today.estimatedCost.toFixed(2)}</td>
							<td class="month-value">$${stats.month.estimatedCost.toFixed(2)}</td>
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

				${this.getEditorUsageHtml(stats)}

				${this.getModelUsageHtml(stats)}

				${workspaceTableHtml}
				${machineTableHtml}

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
					<button class="refresh-button" data-action="refresh">
						<span>🔄</span>
						<span>Refresh Now</span>
					</button>
					<button class="refresh-button" data-action="showChart" style="margin-left: 8px; background: #0e639c;">
						<span>📈</span>
						<span>Show Chart</span>
					</button>
					<button class="refresh-button" data-action="showDiagnostics" style="margin-left: 8px; background: #5a5a5a;">
						<span>🔍</span>
						<span>Diagnostics</span>
					</button>
					<button class="refresh-button" data-action="exportJson" style="margin-left: 8px; background: #5a5a5a;">
						<span>⬇️</span>
						<span>Export JSON</span>
					</button>
				</div>
			</div>
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();

				const handlers = {
					refresh: () => vscode.postMessage({ command: 'refresh' }),
					showChart: () => vscode.postMessage({ command: 'showChart' }),
					showDiagnostics: () => vscode.postMessage({ command: 'showDiagnostics' }),
					exportJson: () => vscode.postMessage({ command: 'exportJson' }),
					configureBackend: () => vscode.postMessage({ command: 'configureBackend' }),
					applyBackendFilters: () => {
						const lookbackDays = Number(document.getElementById('lookbackDays')?.value || 30);
						const model = document.getElementById('model')?.value || '';
						const workspaceId = document.getElementById('workspaceId')?.value || '';
						const userId = document.getElementById('userId')?.value || '';
						const machineId = document.getElementById('machineId')?.value || '';
						vscode.postMessage({
							command: 'setBackendFilters',
							filters: { lookbackDays, model, workspaceId, userId, machineId }
						});
					}
				};

				function wireActions() {
					document.querySelectorAll('[data-action]').forEach((el) => {
						const action = el.getAttribute('data-action');
						const handler = action ? handlers[action] : undefined;
						if (handler) {
							el.addEventListener('click', (event) => {
								event.preventDefault();
								handler();
							});
						}
					});
				}

				document.addEventListener('DOMContentLoaded', wireActions);
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
					${escapeHtml(this.getModelDisplayName(model))}
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
					${this.getEditorIcon(editor)} ${escapeHtml(editor)}
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

	public async generateDiagnosticReport(includeSensitive: boolean = false): Promise<string> {
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
		report.push(`Home Directory: ${includeSensitive ? os.homedir() : '<redacted>'}`);
		report.push(`Environment: ${process.env.CODESPACES === 'true' ? 'GitHub Codespaces' : (vscode.env.remoteName || 'Local')}`);
		report.push(`VS Code Machine ID: ${includeSensitive ? vscode.env.machineId : '<redacted>'}`);
		report.push(`VS Code Session ID: ${includeSensitive ? vscode.env.sessionId : '<redacted>'}`);
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

			if (sessionFiles.length > 0 && includeSensitive) {
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
			} else if (sessionFiles.length > 0 && !includeSensitive) {
				report.push('Session File Locations: <redacted>');
				report.push('To include file paths, re-run Diagnostics and select "Include sensitive diagnostics".');
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

				if (includeSensitive) {
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
				}

				if (sessionFiles.length > 0 && includeSensitive) {
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
				} else if (sessionFiles.length > 0 && !includeSensitive) {
					report.push('Session File Locations: <redacted>');
					report.push('To include file paths, re-run Diagnostics and select "Include sensitive diagnostics".');
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

		const settings = this.getBackendSettings();
		const policy = settings
			? computeBackendSharingPolicy({
				enabled: settings.enabled,
				profile: settings.sharingProfile,
				shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
			})
			: undefined;
		const allowSensitiveDiagnostics = !!policy && (policy.includeNames || policy.workspaceIdStrategy === 'raw' || policy.machineIdStrategy === 'raw');

		let includeSensitive = false;
		if (allowSensitiveDiagnostics) {
			const privacyPick = await vscode.window.showQuickPick(
				[
					{
						label: 'Redacted (recommended)',
						description: 'No home directory, no machine/session IDs, no session file paths.',
						includeSensitive: false
					},
					{
						label: 'Include sensitive diagnostics',
						description: 'Includes machine/session IDs and session file paths (share with care).',
						includeSensitive: true
					}
				],
				{ title: 'Diagnostic report privacy', ignoreFocusOut: true }
			);
			if (!privacyPick) {
				return;
			}
			includeSensitive = !!privacyPick.includeSensitive;
		} else if (policy) {
			this.log('Diagnostic report forced to redacted mode based on Sharing Profile.');
			includeSensitive = false;
		}

		const report = await this.generateDiagnosticReport(includeSensitive);
		
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
		panel.webview.html = this.getDiagnosticReportHtml(panel.webview, report);
		
		// Handle messages from the webview
		panel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'copyReport':
					await writeClipboardText(report);
					vscode.window.showInformationMessage('Diagnostic report copied to clipboard');
					break;
				case 'openIssue':
					await writeClipboardText(report);
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

	private getDiagnosticReportHtml(webview: vscode.Webview, report: string): string {
		const nonce = this.getNonce();
		const csp = this.getCsp(webview, nonce);
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
					const encoded = encodeURIComponent(file);
					sessionFilesHtml += `<li><a href="#" class="session-file-link" data-file="${escapeAttr(encoded)}">${escapeHtml(idx)}. ${escapeHtml(file)}</a><br><span style="color:#aaa;">${escapeHtml(sizeLine)}<br>${escapeHtml(modLine)}</span></li>`;
				} else {
					sessionFilesHtml += `<li>${escapeHtml(fileLine)}</li>`;
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
			<meta http-equiv="Content-Security-Policy" content="${csp}">
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
					<button class="button" data-action="copyReport">
						<span>📋</span>
						<span>Copy to Clipboard</span>
					</button>
					<button class="button secondary" data-action="openIssue">
						<span>🐛</span>
						<span>Open GitHub Issue</span>
					</button>
				</div>
			</div>

			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();

				const diagHandlers = {
					copyReport: () => vscode.postMessage({ command: 'copyReport' }),
					openIssue: () => vscode.postMessage({ command: 'openIssue' })
				};

				function wireDiagActions() {
					document.querySelectorAll('[data-action]').forEach((el) => {
						const action = el.getAttribute('data-action');
						const handler = action ? diagHandlers[action] : undefined;
						if (handler) {
							el.addEventListener('click', (event) => {
								event.preventDefault();
								handler();
							});
						}
					});
				}

				// Make session file links clickable
				document.addEventListener('DOMContentLoaded', () => {
					wireDiagActions();
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
		const csp = this.getCsp(webview, nonce, ['https://cdn.jsdelivr.net']);
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
		
		// Prepare editor-specific data for stacked bars
		const allEditors = new Set<string>();
		dailyStats.forEach(stat => {
			Object.keys(stat.editorUsage).forEach(editor => allEditors.add(editor));
		});
		const editorList = Array.from(allEditors).sort();
		
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
		
		// Editor-specific colors
		const editorColors: { [key: string]: string } = {
			'VS Code': 'rgba(0, 122, 204, 0.8)',           // Blue
			'VS Code Insiders': 'rgba(38, 168, 67, 0.8)',  // Green
			'VS Code Exploration': 'rgba(156, 39, 176, 0.8)', // Purple
			'VS Code Server': 'rgba(0, 188, 212, 0.8)',    // Cyan
			'VS Code Server (Insiders)': 'rgba(0, 150, 136, 0.8)', // Teal
			'VSCodium': 'rgba(33, 150, 243, 0.8)',         // Light Blue
			'Cursor': 'rgba(255, 193, 7, 0.8)',            // Yellow
			'Copilot CLI': 'rgba(233, 30, 99, 0.8)',       // Pink
			'Unknown': 'rgba(158, 158, 158, 0.8)'          // Grey
		};
		
		// Compute total tokens per model so we can prefer non-grey colors for the largest models
		const modelTotals: { [key: string]: number } = {};
		for (const m of modelList) {
			modelTotals[m] = 0;
		}
		dailyStats.forEach(stat => {
			for (const m of modelList) {
				const usage = stat.modelUsage[m];
				if (usage) {
					modelTotals[m] += usage.inputTokens + usage.outputTokens;
				}
			}
		});
		// Sort models by total desc for color assignment
		const modelsBySize = modelList.slice().sort((a, b) => (modelTotals[b] || 0) - (modelTotals[a] || 0));
		
		// Avoid using grey/black/white for the top N largest models
		const forbiddenColorKeywords = ['199, 199, 199', '158, 158, 158', '0, 0, 0', '255, 255, 255'];
		const topN = Math.min(3, modelsBySize.length);
		const reservedColors: { [model: string]: string } = {};
		let colorIndex = 0;
		for (let i = 0; i < topN; i++) {
			const m = modelsBySize[i];
			// find next modelColors[colorIndex] that is not forbidden
			while (colorIndex < modelColors.length) {
				const candidate = modelColors[colorIndex];
				const rgbPart = candidate.match(/rgba\(([^,]+),\s*([^,]+),\s*([^,]+),/);
				if (rgbPart) {
					const rgbKey = `${rgbPart[1].trim()}, ${rgbPart[2].trim()}, ${rgbPart[3].trim()}`;
					if (!forbiddenColorKeywords.includes(rgbKey)) {
						reservedColors[m] = candidate;
						colorIndex++;
						break;
					}
				}
				colorIndex++;
			}
		}

		const modelDatasets = modelList.map((model, index) => {
			const data = dailyStats.map(stat => {
				const usage = stat.modelUsage[model];
				return usage ? usage.inputTokens + usage.outputTokens : 0;
			});
			const assignedColor = reservedColors[model] || modelColors[index % modelColors.length];
			return {
				label: this.getModelDisplayName(model),
				data: data,
				backgroundColor: assignedColor,
				borderColor: assignedColor.replace('0.8', '1'),
				borderWidth: 1
			};
		});

		const editorDatasets = editorList.map((editor, index) => {
			const data = dailyStats.map(stat => {
				const usage = stat.editorUsage[editor];
				return usage ? usage.tokens : 0;
			});
			
			const color = editorColors[editor] || modelColors[index % modelColors.length];
			
			return {
				label: editor,
				data: data,
				backgroundColor: color,
				borderColor: color.replace('0.8', '1'),
				borderWidth: 1
			};
		});

		// Calculate total tokens per editor (for summary panels)
		const editorTotalsMap: { [key: string]: number } = {};
		for (const ed of editorList) {
			editorTotalsMap[ed] = 0;
		}
			dailyStats.forEach(stat => {
				for (const ed of editorList) {
					const usage = stat.editorUsage[ed];
					if (usage) {
						editorTotalsMap[ed] += usage.tokens;
					}
				}
			});

		const editorPanelsHtml = editorList.map(ed => {
			const tokens = editorTotalsMap[ed] || 0;
			return `<div class="stat-card"><div class="stat-label">${this.getEditorIcon(ed)} ${escapeHtml(ed)}</div><div class="stat-value">${tokens.toLocaleString()}</div></div>`;
		}).join('');

		let editorSummaryHtml = '';
		if (editorList.length > 1) {
			// Debug: log editor summary data to output for troubleshooting
			this.log(`Editor list for chart: ${JSON.stringify(editorList)}`);
			this.log(`Editor totals: ${JSON.stringify(editorTotalsMap)}`);
			editorSummaryHtml = `<div class="stats-summary" style="margin-top:12px;">${editorPanelsHtml}</div>`;
		}

		// Pre-calculate summary statistics
		const totalTokens = dailyStats.reduce((sum, stat) => sum + stat.tokens, 0);
		const totalSessions = dailyStats.reduce((sum, stat) => sum + stat.sessions, 0);
		const avgTokensPerDay = dailyStats.length > 0 ? Math.round(totalTokens / dailyStats.length) : 0;

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="${csp}">
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

				${this.getBackendFilterPanelHtml(false)}

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

				${editorSummaryHtml}

				<div class="chart-controls">
					<button class="toggle-button active" id="totalViewBtn" data-action="switch-total">Total Tokens</button>
					<button class="toggle-button" id="modelViewBtn" data-action="switch-model">By Model</button>
					<button class="toggle-button" id="editorViewBtn" data-action="switch-editor">By Editor</button>
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
					<button class="refresh-button" data-action="refresh-chart">
						<span>🔄</span>
						<span>Refresh Chart</span>
					</button>
				</div>
			</div>

			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();

				function refreshChart() {
					vscode.postMessage({ command: 'refresh' });
				}

				function applyBackendFilters() {
					const lookbackDays = Number(document.getElementById('lookbackDays')?.value || 30);
					const model = document.getElementById('model')?.value || '';
					const workspaceId = document.getElementById('workspaceId')?.value || '';
					const userId = document.getElementById('userId')?.value || '';
					const machineId = document.getElementById('machineId')?.value || '';
					vscode.postMessage({
						command: 'setBackendFilters',
						filters: { lookbackDays, model, workspaceId, userId, machineId }
					});
				}

				function configureBackend() {
					vscode.postMessage({ command: 'configureBackend' });
				}

				// Data for different views
				const labels = ${safeJsonForInlineScript(labels)};
				const tokensData = ${safeJsonForInlineScript(tokensData)};
				const sessionsData = ${safeJsonForInlineScript(sessionsData)};
				const modelDatasets = ${safeJsonForInlineScript(modelDatasets)};
				const editorDatasets = ${safeJsonForInlineScript(editorDatasets)};

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

				function createEditorView() {
					return {
						type: 'bar',
						data: {
							labels: labels,
							datasets: editorDatasets
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
										text: 'Tokens by Editor',
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
					document.getElementById('editorViewBtn').classList.toggle('active', viewType === 'editor');
					
					// Destroy existing chart
					if (chart) {
						chart.destroy();
					}
					
					// Create new chart based on view type
					let config;
					if (viewType === 'total') {
						config = createTotalView();
					} else if (viewType === 'model') {
						config = createModelView();
					} else {
						config = createEditorView();
					}
					chart = new Chart(ctx, config);
				}

				document.addEventListener('DOMContentLoaded', () => {
					const actionMap = {
						'switch-total': () => switchView('total'),
						'switch-model': () => switchView('model'),
						'switch-editor': () => switchView('editor'),
						'refresh-chart': () => refreshChart(),
						'applyBackendFilters': () => applyBackendFilters(),
						'configureBackend': () => configureBackend()
					};

					document.querySelectorAll('[data-action]').forEach((el) => {
						const action = el.getAttribute('data-action');
						const handler = action ? actionMap[action] : undefined;
						if (handler) {
							el.addEventListener('click', (event) => {
								event.preventDefault();
								handler();
							});
						}
					});

					chart = new Chart(ctx, createTotalView());
				});
			</script>
		</body>
		</html>`;
	}

	public dispose(): void {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
		}
		this.backend.dispose();
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
	const tokenTracker = new CopilotTokenTracker(context);

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

	const configureBackendCommand = vscode.commands.registerCommand('copilot-token-tracker.configureBackend', async () => {
		tokenTracker.log('Configure backend sync command called');
		await tokenTracker.commands.configureBackend();
	});

	const copyBackendConfigCommand = vscode.commands.registerCommand('copilot-token-tracker.copyBackendConfig', async () => {
		tokenTracker.log('Copy backend sync config command called');
		await tokenTracker.commands.copyBackendConfig();
	});

	const exportCurrentViewCommand = vscode.commands.registerCommand('copilot-token-tracker.exportCurrentView', async () => {
		tokenTracker.log('Export current view command called');
		await tokenTracker.commands.exportCurrentView();
	});

	const setBackendSharedKeyCommand = vscode.commands.registerCommand('copilot-token-tracker.setBackendSharedKey', async () => {
		tokenTracker.log('Set backend sync shared key command called');
		await tokenTracker.commands.setBackendSharedKey();
	});

	const rotateBackendSharedKeyCommand = vscode.commands.registerCommand('copilot-token-tracker.rotateBackendSharedKey', async () => {
		tokenTracker.log('Rotate backend sync shared key command called');
		await tokenTracker.commands.rotateBackendSharedKey();
	});

	const clearBackendSharedKeyCommand = vscode.commands.registerCommand('copilot-token-tracker.clearBackendSharedKey', async () => {
		tokenTracker.log('Clear backend sync shared key command called');
		await tokenTracker.commands.clearBackendSharedKey();
	});

	const enableTeamSharingCommand = vscode.commands.registerCommand('copilot-token-tracker.enableTeamSharing', async () => {
		tokenTracker.log('Enable team sharing command called');
		await tokenTracker.commands.enableTeamSharing();
	});

	const disableTeamSharingCommand = vscode.commands.registerCommand('copilot-token-tracker.disableTeamSharing', async () => {
		tokenTracker.log('Disable team sharing command called');
		await tokenTracker.commands.disableTeamSharing();
	});

	const toggleBackendWorkspaceMachineNameSyncCommand = vscode.commands.registerCommand('copilot-token-tracker.toggleBackendWorkspaceMachineNameSync', async () => {
		tokenTracker.log('Toggle backend workspace/machine name sync command called');
		await tokenTracker.commands.toggleBackendWorkspaceMachineNameSync();
	});

	const setSharingProfileCommand = vscode.commands.registerCommand('copilot-token-tracker.setSharingProfile', async () => {
		tokenTracker.log('Set sharing profile command called');
		await tokenTracker.commands.setSharingProfile();
	});

	// Add to subscriptions for proper cleanup
	context.subscriptions.push(
		refreshCommand,
		showDetailsCommand,
		showChartCommand,
		generateDiagnosticReportCommand,
		configureBackendCommand,
		copyBackendConfigCommand,
		exportCurrentViewCommand,
		setBackendSharedKeyCommand,
		rotateBackendSharedKeyCommand,
		clearBackendSharedKeyCommand,
		enableTeamSharingCommand,
		disableTeamSharingCommand,
		toggleBackendWorkspaceMachineNameSyncCommand,
		setSharingProfileCommand,
		tokenTracker
	);

	tokenTracker.log('Extension activation complete');
}

export function deactivate() {
	// Extension cleanup is handled in the CopilotTokenTracker class
}

