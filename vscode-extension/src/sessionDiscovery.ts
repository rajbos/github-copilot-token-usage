/**
 * Session file discovery - finds and scans for Copilot/OpenCode/Continue session files.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { IEcosystemAdapter } from './ecosystemAdapter';
import { isDiscoverable } from './ecosystemAdapter';

export interface SessionDiscoveryDeps {
	log: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string, error?: any) => void;
	ecosystems: IEcosystemAdapter[];
	sampleDataDirectoryOverride?: () => string | undefined;
}

export class SessionDiscovery {
	private deps: SessionDiscoveryDeps;
	private _sessionFilesCache: string[] | null = null;
	private _sessionFilesCacheTime: number = 0;
	private static readonly SESSION_FILES_CACHE_TTL = 60000;

	constructor(deps: SessionDiscoveryDeps) {
		this.deps = deps;
	}

	clearCache(): void {
		this._sessionFilesCache = null;
		this._sessionFilesCacheTime = 0;
	}

	/** Async replacement for fs.existsSync — does not block the event loop. */
	private async pathExists(p: string): Promise<boolean> {
		try {
			await fs.promises.access(p);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Run async tasks with bounded concurrency to avoid saturating the extension host.
	 */
	private async runWithConcurrency<T>(
		items: T[],
		fn: (item: T, index: number) => Promise<void>,
		limit = 8
	): Promise<void> {
		if (items.length === 0) { return; }
		let index = 0;
		const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (index < items.length) {
				const i = index++;
				try {
					await fn(items[i], i);
				} catch (error) {
					this.deps.warn(`Failed to process session discovery item at index ${i}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		});
		await Promise.all(workers);
	}

	/**
	 * Get all possible VS Code user data paths for all VS Code variants
	 * Supports: Code (stable), Code - Insiders, VSCodium, remote servers, etc.
	 * 
	 * NOTE: The canonical JavaScript implementation is in:
	 * .github/skills/copilot-log-analysis/session-file-discovery.js
	 * This TypeScript implementation should mirror that logic.
	 */
	getVSCodeUserPaths(): string[] {
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

	/** Returns true when the extension host is running inside WSL. */
	isWSL(): boolean {
		return os.platform() === 'linux' && (
			typeof process.env.WSL_DISTRO_NAME === 'string' ||
			typeof process.env.WSL_INTEROP === 'string'
		);
	}

	/**
	 * When running inside WSL, probes the Windows-side VS Code user paths
	 * (mounted at /mnt/c/...) so sessions created in a native Windows VS Code
	 * window are also discovered.
	 *
	 * This is intentionally async and non-blocking: all path existence checks
	 * use async fs.promises.access; errors at any level are silently ignored so
	 * a missing or inaccessible /mnt/c mount never throws.
	 */
	async getWSLWindowsPaths(): Promise<string[]> {
		if (!this.isWSL()) {
			return [];
		}

		const wslPaths: string[] = [];

		const vscodeVariants = [
			'Code',
			'Code - Insiders',
			'Code - Exploration',
			'VSCodium',
			'Cursor'
		];

		// Derive candidate Windows usernames (safe, multiple fallbacks).
		const windowsUsernames: string[] = [];

		// USERPROFILE in WSL is sometimes set to the Windows path e.g. /mnt/c/Users/alice
		const userprofile = process.env.USERPROFILE;
		if (userprofile) {
			const match = userprofile.match(/^\/mnt\/[a-z]\/Users\/([^/]+)/);
			if (match) {
				windowsUsernames.push(match[1]);
			}
		}

		// Enumerate /mnt/c/Users/ if accessible — gives us every Windows profile
		// without guessing. We read only the top-level directory names.
		const windowsUsersDir = '/mnt/c/Users';
		try {
			const entries = await fs.promises.readdir(windowsUsersDir, { withFileTypes: true });
			for (const entry of entries) {
				// Skip system pseudo-folders
				if (!entry.isDirectory()) { continue; }
				const name = entry.name;
				if (name === 'Public' || name === 'Default' || name === 'Default User' ||
					name === 'All Users' || name.startsWith('.')) {
					continue;
				}
				if (!windowsUsernames.includes(name)) {
					windowsUsernames.push(name);
				}
			}
		} catch {
			// /mnt/c/Users is not accessible — WSL drive not mounted or no Windows partition
			return [];
		}

		for (const winUser of windowsUsernames) {
			const appData = path.join(windowsUsersDir, winUser, 'AppData', 'Roaming');
			for (const variant of vscodeVariants) {
				wslPaths.push(path.join(appData, variant, 'User'));
			}
		}

		return wslPaths;
	}

	/**
	 * Returns all candidate paths the extension considers when scanning for session files,
	 * along with whether each path exists on disk. Used for diagnostics display.
	 */
	getDiagnosticCandidatePaths(): { path: string; exists: boolean; source: string }[] {
		const candidates: { path: string; exists: boolean; source: string }[] = [];

		// VS Code user paths
		const allVSCodePaths = this.getVSCodeUserPaths();
		for (const p of allVSCodePaths) {
			let exists = false;
			try { exists = fs.existsSync(p); } catch { /* ignore */ }
			candidates.push({ path: p, exists, source: 'VS Code' });
		}

		// When in WSL, synchronously check the top-level Windows users dir and add
		// candidate paths so they appear in the diagnostics panel.
		if (this.isWSL()) {
			const vscodeVariants = ['Code', 'Code - Insiders', 'Code - Exploration', 'VSCodium', 'Cursor'];
			const windowsUsersDir = '/mnt/c/Users';
			try {
				const entries = fs.readdirSync(windowsUsersDir, { withFileTypes: true });
				const systemNames = new Set(['Public', 'Default', 'Default User', 'All Users']);
				for (const entry of entries) {
					if (!entry.isDirectory() || entry.name.startsWith('.') || systemNames.has(entry.name)) { continue; }
					for (const variant of vscodeVariants) {
						const p = path.join(windowsUsersDir, entry.name, 'AppData', 'Roaming', variant, 'User');
						let exists = false;
						try { exists = fs.existsSync(p); } catch { /* ignore */ }
						candidates.push({ path: p, exists, source: 'VS Code (Windows via WSL)' });
					}
				}
			} catch { /* /mnt/c not accessible — skip */ }
		}

		// Copilot CLI
		const copilotCliPath = path.join(os.homedir(), '.copilot', 'session-state');
		let copilotCliExists = false;
		try { copilotCliExists = fs.existsSync(copilotCliPath); } catch { /* ignore */ }
		candidates.push({ path: copilotCliPath, exists: copilotCliExists, source: 'Copilot CLI' });

		// Ecosystem adapter candidate paths (centralized existence check)
		for (const eco of this.deps.ecosystems) {
			if (isDiscoverable(eco)) {
				try {
					const ecoPaths = eco.getCandidatePaths();
					for (const cp of ecoPaths) {
						let exists = false;
						try { exists = fs.existsSync(cp.path); } catch { /* ignore */ }
						candidates.push({ path: cp.path, exists, source: cp.source });
					}
				} catch { /* ignore */ }
			}
		}

		return candidates;
	}

	checkCopilotExtension(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		if (!copilotExtension && !copilotChatExtension) {
			this.deps.log('⚠️ GitHub Copilot extensions not found');
		} else {
			const copilotStatus = copilotExtension ? (copilotExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			const chatStatus = copilotChatExtension ? (copilotChatExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			this.deps.log(`GitHub Copilot: ${copilotStatus}, Chat: ${chatStatus}`);
		}

		// Check if we're in GitHub Codespaces
		const isCodespaces = process.env.CODESPACES === 'true';
		if (isCodespaces && (!copilotExtension?.isActive || !copilotChatExtension?.isActive)) {
			this.deps.warn('⚠️ Running in Codespaces with inactive Copilot extensions');
		}
	}

	/**
	 * NOTE: The canonical JavaScript implementation is in:
	 * .github/skills/copilot-log-analysis/session-file-discovery.js
	 * This TypeScript implementation should mirror that logic.
	 */
	async getCopilotSessionFiles(): Promise<string[]> {
		// Check short-term cache to avoid expensive filesystem scans during rapid successive calls
		const now = Date.now();
		if (this._sessionFilesCache && (now - this._sessionFilesCacheTime) < SessionDiscovery.SESSION_FILES_CACHE_TTL) {
			this.deps.log(`💨 Using cached session files list (${this._sessionFilesCache.length} files, cached ${Math.round((now - this._sessionFilesCacheTime) / 1000)}s ago)`);
			return this._sessionFilesCache;
		}

		// Screenshot/demo mode: if a sample data directory is configured, use it exclusively
		const sampleDir = this.deps.sampleDataDirectoryOverride?.()
			?? vscode.workspace.getConfiguration('aiEngineeringFluency').get<string>('sampleDataDirectory');
		if (sampleDir && sampleDir.trim().length > 0) {
			const resolvedSampleDir = sampleDir.trim();
			try {
				if (await this.pathExists(resolvedSampleDir)) {
					const sampleFiles = (await fs.promises.readdir(resolvedSampleDir))
						.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
						.map(f => path.join(resolvedSampleDir, f));
					this.deps.log(`📸 Sample data mode: using ${sampleFiles.length} file(s) from ${resolvedSampleDir}`);
					this._sessionFilesCache = sampleFiles;
					this._sessionFilesCacheTime = now;
					return sampleFiles;
				} else {
					this.deps.warn(`Sample data directory not found: ${resolvedSampleDir}`);
				}
			} catch (err) {
				this.deps.warn(`Error reading sample data directory: ${err}`);
			}
		}

		const sessionFiles: string[] = [];

		const platform = os.platform();
		const homedir = os.homedir();

		this.deps.log(`🔍 Searching for Copilot session files on ${platform}`);

		// Get all possible VS Code user paths (stable, insiders, remote, etc.)
		const allVSCodePaths = this.getVSCodeUserPaths();

		// When running inside WSL also probe the Windows-side paths so sessions
		// created in a native Windows VS Code window are not missed.
		if (this.isWSL()) {
			this.deps.log(`🪟 WSL environment detected — probing Windows-side VS Code paths`);
			const wslWinPaths = await this.getWSLWindowsPaths();
			if (wslWinPaths.length > 0) {
				this.deps.log(`🪟 Adding ${wslWinPaths.length} Windows-side candidate paths from WSL`);
				allVSCodePaths.push(...wslWinPaths);
			} else {
				this.deps.log(`🪟 No Windows-side paths found (Windows drive may not be mounted)`);
			}
		}

		this.deps.log(`📂 Considering ${allVSCodePaths.length} candidate VS Code paths:`);
		for (const candidatePath of allVSCodePaths) {
			this.deps.log(`   📁 ${candidatePath}`);
		}

		// Check all VS Code paths in parallel — typically 10 paths, one syscall each
		const existenceResults = await Promise.all(
			allVSCodePaths.map(p => this.pathExists(p).catch(() => false))
		);
		const foundPaths = allVSCodePaths.filter((_, i) => existenceResults[i]);

		this.deps.log(`✅ Found ${foundPaths.length} of ${allVSCodePaths.length} VS Code paths exist on disk:`);
		for (const fp of foundPaths) {
			this.deps.log(`   ✅ ${fp}`);
		}

		try {
			// Scan all found VS Code paths for session files with bounded concurrency.
			await this.runWithConcurrency(foundPaths, async (codeUserPath) => {
				const pathName = path.basename(path.dirname(codeUserPath));

				// Workspace storage sessions — also bounded to avoid spawning hundreds of FS ops at once.
				const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
				try {
					if (await this.pathExists(workspaceStoragePath)) {
						const workspaceDirs = await fs.promises.readdir(workspaceStoragePath);
						await this.runWithConcurrency(workspaceDirs, async (workspaceDir) => {
							const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
							try {
								if (await this.pathExists(chatSessionsPath)) {
									const sessionFiles2 = (await fs.promises.readdir(chatSessionsPath))
										.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
										.map(file => path.join(chatSessionsPath, file));
									if (sessionFiles2.length > 0) {
										this.deps.log(`📄 Found ${sessionFiles2.length} session files in ${pathName}/workspaceStorage/${workspaceDir}`);
										sessionFiles.push(...sessionFiles2);
									}
								}
							} catch {
								// Ignore individual workspace dir errors
							}
						}, 6);
					}
				} catch (checkError) {
					this.deps.warn(`Could not check workspace storage path ${workspaceStoragePath}: ${checkError}`);
				}

				// Global storage sessions (legacy emptyWindowChatSessions)
				const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
				try {
					if (await this.pathExists(globalStoragePath)) {
						const globalSessionFiles = (await fs.promises.readdir(globalStoragePath))
							.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
							.map(file => path.join(globalStoragePath, file));
						if (globalSessionFiles.length > 0) {
							this.deps.log(`📄 Found ${globalSessionFiles.length} session files in ${pathName}/globalStorage/emptyWindowChatSessions`);
							sessionFiles.push(...globalSessionFiles);
						}
					}
				} catch (checkError) {
					this.deps.warn(`Could not check global storage path ${globalStoragePath}: ${checkError}`);
				}

				// GitHub Copilot Chat extension global storage
				const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', 'github.copilot-chat');
				try {
					if (await this.pathExists(copilotChatGlobalPath)) {
						this.deps.log(`📄 Scanning ${pathName}/globalStorage/github.copilot-chat`);
						await this.scanDirectoryForSessionFiles(copilotChatGlobalPath, sessionFiles);
					}
				} catch (checkError) {
					this.deps.warn(`Could not check Copilot Chat global storage path ${copilotChatGlobalPath}: ${checkError}`);
				}
			}, 4);

			// Check for Copilot CLI session-state directory (new location for agent mode sessions)
			const copilotCliSessionPath = path.join(os.homedir(), '.copilot', 'session-state');
			this.deps.log(`📁 Checking Copilot CLI path: ${copilotCliSessionPath}`);
			try {
				if (await this.pathExists(copilotCliSessionPath)) {
					try {
						const entries = await fs.promises.readdir(copilotCliSessionPath, { withFileTypes: true });

						// Collect flat .json/.jsonl files at the top level
						const cliSessionFiles = entries
							.filter(e => !e.isDirectory() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl')))
							.map(e => path.join(copilotCliSessionPath, e.name));
						if (cliSessionFiles.length > 0) {
							this.deps.log(`📄 Found ${cliSessionFiles.length} session files in Copilot CLI directory`);
							sessionFiles.push(...cliSessionFiles);
						}

						// Scan UUID subdirectories for events.jsonl (newer Copilot CLI format)
						const subDirs = entries.filter(e => e.isDirectory());
						const subDirFiles = (await Promise.all(
							subDirs.map(async (subDir) => {
								const eventsFile = path.join(copilotCliSessionPath, subDir.name, 'events.jsonl');
								try {
									const stats = await fs.promises.stat(eventsFile);
									return stats.size > 0 ? eventsFile : null;
								} catch {
									return null;
								}
							})
						)).filter((f): f is string => f !== null);
						if (subDirFiles.length > 0) {
							this.deps.log(`📄 Found ${subDirFiles.length} session files in Copilot CLI subdirectories`);
							sessionFiles.push(...subDirFiles);
						}
					} catch (readError) {
						this.deps.warn(`Could not read Copilot CLI session path in ${copilotCliSessionPath}: ${readError}`);
					}
				}
			} catch (checkError) {
				this.deps.warn(`Could not check Copilot CLI session path ${copilotCliSessionPath}: ${checkError}`);
			}

			// Discover sessions from all ecosystem adapters
			for (const eco of this.deps.ecosystems) {
				if (isDiscoverable(eco)) {
					try {
						const result = await eco.discover(this.deps.log);
						sessionFiles.push(...result.sessionFiles);
					} catch (ecoError) {
						this.deps.warn(`Could not discover ${eco.displayName} sessions: ${ecoError}`);
					}
				}
			}

			// Log summary
			this.deps.log(`✨ Total: ${sessionFiles.length} session file(s) discovered`);
			if (sessionFiles.length === 0) {
				this.deps.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}

			// Update short-term cache
			this._sessionFilesCache = sessionFiles;
			this._sessionFilesCacheTime = Date.now();
		} catch (error) {
			this.deps.error('Error getting session files:', error);
		}

		return sessionFiles;
	}

	/**
	 * Recursively scan a directory for session files (.json and .jsonl)
	 * 
	 * NOTE: Mirrors logic in .github/skills/copilot-log-analysis/session-file-discovery.js
	 */
	async scanDirectoryForSessionFiles(dir: string, sessionFiles: string[]): Promise<void> {
		try {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await this.scanDirectoryForSessionFiles(fullPath, sessionFiles);
				} else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
					// Skip known non-session files (embeddings, indexes, etc.)
					if (this.isNonSessionFile(entry.name)) {
						continue;
					}
					// Only add files that look like session files (have reasonable content)
					try {
						const stats = await fs.promises.stat(fullPath);
						if (stats.size > 0) {
							sessionFiles.push(fullPath);
						}
					} catch (e) {
						// Ignore file access errors
					}
				}
			}
		} catch (error) {
			this.deps.warn(`Could not scan directory ${dir}: ${error}`);
		}
	}

	/**
	 * Check if a filename is a known non-session file that should be excluded
	 */
	isNonSessionFile(filename: string): boolean {
		const nonSessionFilePatterns = [
			'embeddings',       // commandEmbeddings.json, settingEmbeddings.json
			'index',            // index files
			'cache',            // cache files
			'preferences',
			'settings',
			'config',
			'workspacesessions', // copilot.cli.workspaceSessions.*.json (index files with session ID lists)
			'globalsessions',    // copilot.cli.oldGlobalSessions.json (index files)
			'api.json'           // api.json (API configuration)
		];
		const lowerFilename = filename.toLowerCase();
		return nonSessionFilePatterns.some(pattern => lowerFilename.includes(pattern));
	}
}
