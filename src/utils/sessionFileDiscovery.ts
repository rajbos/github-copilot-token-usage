import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * SessionFileDiscovery handles finding GitHub Copilot session files
 * across different VS Code installations and editor variants.
 * 
 * NOTE: The canonical JavaScript implementation is in:
 * .github/skills/copilot-log-analysis/session-file-discovery.js
 * This TypeScript implementation should mirror that logic.
 */
export class SessionFileDiscovery {
	constructor(
		private log: (message: string) => void,
		private warn: (message: string) => void
	) {}

	/**
	 * Get all possible VS Code user paths for different editor variants
	 * across different platforms (Windows, macOS, Linux)
	 */
	public getVSCodeUserPaths(): string[] {
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
	 * Find all GitHub Copilot session files across all VS Code installations
	 */
	public async getCopilotSessionFiles(): Promise<string[]> {
		const sessionFiles: string[] = [];

		const platform = os.platform();
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
		} catch (error) {
			this.warn(`Error getting session files: ${error}`);
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
}
