import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface TokenUsageStats {
	todayTokens: number;
	monthTokens: number;
	lastUpdated: Date;
}

interface ModelUsage {
	[modelName: string]: number;
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
	};
	month: {
		tokens: number;
		sessions: number;
		avgInteractionsPerSession: number;
		avgTokensPerSession: number;
		modelUsage: ModelUsage;
		co2: number;
		treesEquivalent: number;
	};
	lastUpdated: Date;
}

class CopilotTokenTracker implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private updateInterval: NodeJS.Timeout | undefined;
	private initialDelayTimeout: NodeJS.Timeout | undefined;
	private detailsPanel: vscode.WebviewPanel | undefined;
	private outputChannel: vscode.OutputChannel;
	private tokenEstimators: { [key: string]: number } = {
		'gpt-4': 0.25,
		'gpt-4.1': 0.25,
		'gpt-4o': 0.25,
		'gpt-4o-mini': 0.25,
		'gpt-3.5-turbo': 0.25,
		'gpt-5': 0.25,
		'claude-sonnet-3.5': 0.24,
		'claude-sonnet-3.7': 0.24,
		'claude-sonnet-4': 0.24,
		'claude-haiku': 0.24,
		'gemini-2.5-pro': 0.25,
		'o3-mini': 0.25,
		'o4-mini': 0.25
	};
	private co2Per1kTokens = 0.2; // gCO2e per 1000 tokens, a rough estimate
	private co2AbsorptionPerTreePerYear = 21000; // grams of CO2 per tree per year

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
			const delaySeconds = process.env.CODESPACES === 'true' ? 10 : 60;
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
			this.updateTokenStats();
		} else {
			this.log('Copilot extensions are active - starting immediate update');
			this.updateTokenStats();
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

	public async updateTokenStats(): Promise<void> {
		try {
			this.log('Updating token stats...');
			const detailedStats = await this.calculateDetailedStats();

			this.statusBarItem.text = `$(symbol-numeric) ${detailedStats.today.tokens.toLocaleString()} | ${detailedStats.month.tokens.toLocaleString()}`;

			// Create detailed tooltip with markdown support
			const tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown('## 🤖 GitHub Copilot Token Usage\n\n');
			tooltip.appendMarkdown('### 📅 Today\n');
			tooltip.appendMarkdown(`**Tokens:** ${detailedStats.today.tokens.toLocaleString()}\n\n`);
			tooltip.appendMarkdown(`**CO₂ Est.:** ${detailedStats.today.co2.toFixed(2)}g\n\n`);
			tooltip.appendMarkdown(`**Sessions:** ${detailedStats.today.sessions}\n\n`);
			tooltip.appendMarkdown(`**Avg Interactions/Session:** ${detailedStats.today.avgInteractionsPerSession}\n\n`);
			tooltip.appendMarkdown(`**Avg Tokens/Session:** ${detailedStats.today.avgTokensPerSession.toLocaleString()}\n\n`);
			tooltip.appendMarkdown('### 📊 This Month\n');
			tooltip.appendMarkdown(`**Tokens:** ${detailedStats.month.tokens.toLocaleString()}\n\n`);
			tooltip.appendMarkdown(`**CO₂ Est.:** ${detailedStats.month.co2.toFixed(2)}g\n\n`);
			tooltip.appendMarkdown(`**Sessions:** ${detailedStats.month.sessions}\n\n`);
			tooltip.appendMarkdown(`**Avg Interactions/Session:** ${detailedStats.month.avgInteractionsPerSession}\n\n`);
			tooltip.appendMarkdown(`**Avg Tokens/Session:** ${detailedStats.month.avgTokensPerSession.toLocaleString()}\n\n`);
			tooltip.appendMarkdown('---\n\n');
			tooltip.appendMarkdown('*Updates automatically every 5 minutes*');

			this.statusBarItem.tooltip = tooltip;

			// If the details panel is open, update its content
			if (this.detailsPanel) {
				this.detailsPanel.webview.html = this.getDetailsHtml(detailedStats);
			}

			this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Month: ${detailedStats.month.tokens}`);
		} catch (error) {
			this.error('Error updating token stats:', error);
			this.statusBarItem.text = '$(error) Token Error';
			this.statusBarItem.tooltip = 'Error calculating token usage';
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
						const tokens = await this.estimateTokensFromSession(sessionFile);

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

	private async calculateDetailedStats(): Promise<DetailedStats> {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		const todayStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage };
		const monthStats = { tokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage };

		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`Processing ${sessionFiles.length} session files for detailed stats`);

			if (sessionFiles.length === 0) {
				this.warn('No session files found - this might indicate an issue in GitHub Codespaces or different VS Code configuration');
			}

			for (const sessionFile of sessionFiles) {
				try {
					const fileStats = fs.statSync(sessionFile);

					if (fileStats.mtime >= monthStart) {
						const tokens = await this.estimateTokensFromSession(sessionFile);
						const interactions = await this.countInteractionsInSession(sessionFile);
						const modelUsage = await this.getModelUsageFromSession(sessionFile);

						this.log(`Session ${path.basename(sessionFile)}: ${tokens} tokens, ${interactions} interactions`);

						monthStats.tokens += tokens;
						monthStats.sessions += 1;
						monthStats.interactions += interactions;

						// Add model usage to month stats
						for (const [model, modelTokens] of Object.entries(modelUsage)) {
							monthStats.modelUsage[model] = (monthStats.modelUsage[model] || 0) + (modelTokens as number);
						}

						if (fileStats.mtime >= todayStart) {
							todayStats.tokens += tokens;
							todayStats.sessions += 1;
							todayStats.interactions += interactions;

							// Add model usage to today stats
							for (const [model, modelTokens] of Object.entries(modelUsage)) {
								todayStats.modelUsage[model] = (todayStats.modelUsage[model] || 0) + (modelTokens as number);
							}
						}
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile}: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating detailed stats:', error);
		}

		const todayCo2 = (todayStats.tokens / 1000) * this.co2Per1kTokens;
		const monthCo2 = (monthStats.tokens / 1000) * this.co2Per1kTokens;

		const result: DetailedStats = {
			today: {
				tokens: todayStats.tokens,
				sessions: todayStats.sessions,
				avgInteractionsPerSession: todayStats.sessions > 0 ? Math.round(todayStats.interactions / todayStats.sessions) : 0,
				avgTokensPerSession: todayStats.sessions > 0 ? Math.round(todayStats.tokens / todayStats.sessions) : 0,
				modelUsage: todayStats.modelUsage,
				co2: todayCo2,
				treesEquivalent: todayCo2 / this.co2AbsorptionPerTreePerYear
			},
			month: {
				tokens: monthStats.tokens,
				sessions: monthStats.sessions,
				avgInteractionsPerSession: monthStats.sessions > 0 ? Math.round(monthStats.interactions / monthStats.sessions) : 0,
				avgTokensPerSession: monthStats.sessions > 0 ? Math.round(monthStats.tokens / monthStats.sessions) : 0,
				modelUsage: monthStats.modelUsage,
				co2: monthCo2,
				treesEquivalent: monthCo2 / this.co2AbsorptionPerTreePerYear
			},
			lastUpdated: now
		};

		this.log(`Today: ${todayStats.interactions} total interactions / ${todayStats.sessions} sessions = ${result.today.avgInteractionsPerSession} avg`);
		this.log(`Month: ${monthStats.interactions} total interactions / ${monthStats.sessions} sessions = ${result.month.avgInteractionsPerSession} avg`);

		return result;
	}

	private async countInteractionsInSession(sessionFile: string): Promise<number> {
		try {
			const sessionContent = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

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
			const sessionContent = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Get model for this request
					const model = this.getModelFromRequest(request);

					// Estimate tokens from user message
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								const tokens = this.estimateTokensFromText(part.text, model);
								modelUsage[model] = (modelUsage[model] || 0) + tokens;
							}
						}
					}

					// Estimate tokens from assistant response
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							if (responseItem.value) {
								const tokens = this.estimateTokensFromText(responseItem.value, model);
								modelUsage[model] = (modelUsage[model] || 0) + tokens;
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
			const sessionContent = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
			let totalTokens = 0;

			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Estimate tokens from user message
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								totalTokens += this.estimateTokensFromText(part.text);
							}
						}
					}

					// Estimate tokens from assistant response
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							if (responseItem.value) {
								totalTokens += this.estimateTokensFromText(responseItem.value, this.getModelFromRequest(request));
							}
						}
					}
				}
			}

			return totalTokens;
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

		// Get detailed stats
		const stats = await this.calculateDetailedStats();

		// Create a small webview panel
		this.detailsPanel = vscode.window.createWebviewPanel(
			'copilotTokenDetails',
			'GitHub Copilot Token Usage',
			{
				viewColumn: vscode.ViewColumn.Beside,
				preserveFocus: true
			},
			{
				enableScripts: false,
				retainContextWhenHidden: false
			}
		);

		// Set the HTML content
		this.detailsPanel.webview.html = this.getDetailsHtml(stats);

		// Handle panel disposal
		this.detailsPanel.onDidDispose(() => {
			this.detailsPanel = undefined;
		});
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
						Token counts are estimated based on character count. CO₂ and tree equivalents are derived from these token estimates.
					</p>
					<ul style="font-size: 12px; color: #b3b3b3; padding-left: 20px; list-style-position: inside; margin-top: 8px;">
						<li><b>CO₂ Estimate:</b> Based on ~${this.co2Per1kTokens}g of CO₂e per 1,000 tokens.</li>
						<li><b>Tree Equivalent:</b> Represents the fraction of a single mature tree's annual CO₂ absorption (~${(this.co2AbsorptionPerTreePerYear / 1000).toFixed(1)} kg/year).</li>
					</ul>
				</div>

				<div class="footer">
					Last updated: ${stats.lastUpdated.toLocaleString()}<br>
					Updates automatically every 5 minutes
				</div>
			</div>
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
			const monthlyTokens = stats.month.modelUsage[model] || 0;
			const projectedTokens = calculateProjection(monthlyTokens);

			return `
			<tr>
				<td class="metric-label">
					${this.getModelDisplayName(model)}
					<span style="font-size: 11px; color: #a0a0a0; font-weight: normal;">(~${charsPerToken} chars/tk)</span>
				</td>
				<td class="today-value">${(stats.today.modelUsage[model] || 0).toLocaleString()}</td>
				<td class="month-value">${monthlyTokens.toLocaleString()}</td>
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
			'claude-sonnet-3.5': 'Claude Sonnet 3.5',
			'claude-sonnet-3.7': 'Claude Sonnet 3.7',
			'claude-sonnet-4': 'Claude Sonnet 4',
			'claude-haiku': 'Claude Haiku',
			'gemini-2.5-pro': 'Gemini 2.5 Pro',
			'o3-mini': 'o3-mini',
			'o4-mini': 'o4-mini (Preview)'
		};
		return modelNames[model] || model;
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
		this.statusBarItem.dispose();
		this.outputChannel.dispose();
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

	// Add to subscriptions for proper cleanup
	context.subscriptions.push(refreshCommand, showDetailsCommand, tokenTracker);

	tokenTracker.log('Extension activation complete');
}

export function deactivate() {
	// Extension cleanup is handled in the CopilotTokenTracker class
}
