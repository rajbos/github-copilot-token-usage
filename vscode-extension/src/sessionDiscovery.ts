/**
 * Session file discovery - finds and scans for Copilot/OpenCode/Continue session files.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { OpenCodeDataAccess } from './opencode';
import type { CrushDataAccess } from './crush';
import type { ContinueDataAccess } from './continue';
import type { VisualStudioDataAccess } from "./visualstudio";

export interface SessionDiscoveryDeps {
	log: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string, error?: any) => void;
	openCode: OpenCodeDataAccess;
	crush: CrushDataAccess;
	continue_: ContinueDataAccess;
	visualStudio: VisualStudioDataAccess;
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

		// Copilot CLI
		const copilotCliPath = path.join(os.homedir(), '.copilot', 'session-state');
		let copilotCliExists = false;
		try { copilotCliExists = fs.existsSync(copilotCliPath); } catch { /* ignore */ }
		candidates.push({ path: copilotCliPath, exists: copilotCliExists, source: 'Copilot CLI' });

		// OpenCode JSON storage
		const openCodeDataDir = this.deps.openCode.getOpenCodeDataDir();
		const openCodeSessionDir = path.join(openCodeDataDir, 'storage', 'session');
		let openCodeJsonExists = false;
		try { openCodeJsonExists = fs.existsSync(openCodeSessionDir); } catch { /* ignore */ }
		candidates.push({ path: openCodeSessionDir, exists: openCodeJsonExists, source: 'OpenCode (JSON)' });

		// OpenCode SQLite DB
		const openCodeDbPath = path.join(openCodeDataDir, 'opencode.db');
		let openCodeDbExists = false;
		try { openCodeDbExists = fs.existsSync(openCodeDbPath); } catch { /* ignore */ }
		candidates.push({ path: openCodeDbPath, exists: openCodeDbExists, source: 'OpenCode (DB)' });

		// Crush projects
		const crushConfigDir = this.deps.crush.getCrushConfigDir();
		const crushProjectsPath = path.join(crushConfigDir, 'projects.json');
		let crushConfigExists = false;
		try { crushConfigExists = fs.existsSync(crushProjectsPath); } catch { /* ignore */ }
		candidates.push({ path: crushProjectsPath, exists: crushConfigExists, source: 'Crush (projects.json)' });
		// Add each known Crush project data dir
		const crushProjects = this.deps.crush.readCrushProjects();
		for (const project of crushProjects) {
			const dbPath = path.join(project.data_dir, 'crush.db');
			let dbExists = false;
			try { dbExists = fs.existsSync(dbPath); } catch { /* ignore */ }
			candidates.push({ path: dbPath, exists: dbExists, source: `Crush (${path.basename(project.path)})` });
		}

		// Add VS Copilot log directory as candidate
		const vsLogDir = this.deps.visualStudio.getLogDir();
		let vsLogDirExists = false;
		try { vsLogDirExists = fs.existsSync(vsLogDir); } catch {}
		candidates.push({ path: vsLogDir, exists: vsLogDirExists, source: "Visual Studio (log dir)" });

		// Continue sessions directory
		const continueSessionsDir = this.deps.continue_.getContinueSessionsDir();
		let continueExists = false;
		try { continueExists = fs.existsSync(continueSessionsDir); } catch { /* ignore */ }
		candidates.push({ path: continueSessionsDir, exists: continueExists, source: 'Continue' });

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

		// Screenshot/demo mode: env var takes priority, then VS Code setting
		const envSampleDir = process.env.COPILOT_TEST_DATA_PATH;
		if (envSampleDir && envSampleDir.trim().length > 0) {
			const resolvedEnvDir = envSampleDir.trim();
			try {
				if (fs.existsSync(resolvedEnvDir)) {
					const sampleFiles = fs.readdirSync(resolvedEnvDir)
						.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
						.map(f => path.join(resolvedEnvDir, f));
					this.deps.log(`📸 Sample data mode (COPILOT_TEST_DATA_PATH): using ${sampleFiles.length} file(s) from ${resolvedEnvDir}`);
					this._sessionFilesCache = sampleFiles;
					this._sessionFilesCacheTime = now;
					return sampleFiles;
				} else {
					this.deps.warn(`COPILOT_TEST_DATA_PATH directory not found: ${resolvedEnvDir}`);
				}
			} catch (err) {
				this.deps.warn(`Error reading COPILOT_TEST_DATA_PATH directory: ${err}`);
			}
		}

		// Screenshot/demo mode: if a sample data directory is configured via VS Code setting, use it exclusively
		const sampleDir = vscode.workspace.getConfiguration('copilot-token-tracker').get<string>('sampleDataDirectory');
		if (sampleDir && sampleDir.trim().length > 0) {
			const resolvedSampleDir = sampleDir.trim();
			try {
				if (fs.existsSync(resolvedSampleDir)) {
					const sampleFiles = fs.readdirSync(resolvedSampleDir)
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
		this.deps.log(`📂 Considering ${allVSCodePaths.length} candidate VS Code paths:`);
		for (const candidatePath of allVSCodePaths) {
			this.deps.log(`   📁 ${candidatePath}`);
		}

		// Track which paths we actually found
		const foundPaths: string[] = [];
		for (let i = 0; i < allVSCodePaths.length; i++) {
			const codeUserPath = allVSCodePaths[i];
			try {
				if (fs.existsSync(codeUserPath)) {
					foundPaths.push(codeUserPath);
				}
			} catch (checkError) {
				this.deps.warn(`Could not check path ${codeUserPath}: ${checkError}`);
			}
			// Update progress
			if ((i + 1) % 5 === 0 || i === allVSCodePaths.length - 1) {
				this.deps.log(`📂 Reading local folders [${i + 1}/${allVSCodePaths.length}]`);
			}
		}

		this.deps.log(`✅ Found ${foundPaths.length} of ${allVSCodePaths.length} VS Code paths exist on disk:`);
		for (const fp of foundPaths) {
			this.deps.log(`   ✅ ${fp}`);
		}

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
												this.deps.log(`📄 Found ${sessionFiles2.length} session files in ${pathName}/workspaceStorage/${workspaceDir}`);
												sessionFiles.push(...sessionFiles2);
											}
										} catch (readError) {
											this.deps.warn(`Could not read chat sessions in ${chatSessionsPath}: ${readError}`);
										}
									}
								} catch (checkError) {
									this.deps.warn(`Could not check chat sessions path ${chatSessionsPath}: ${checkError}`);
								}
							}
						} catch (readError) {
							this.deps.warn(`Could not read workspace storage in ${workspaceStoragePath}: ${readError}`);
						}
					}
				} catch (checkError) {
					this.deps.warn(`Could not check workspace storage path ${workspaceStoragePath}: ${checkError}`);
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
								this.deps.log(`📄 Found ${globalSessionFiles.length} session files in ${pathName}/globalStorage/emptyWindowChatSessions`);
								sessionFiles.push(...globalSessionFiles);
							}
						} catch (readError) {
							this.deps.warn(`Could not read global storage in ${globalStoragePath}: ${readError}`);
						}
					}
				} catch (checkError) {
					this.deps.warn(`Could not check global storage path ${globalStoragePath}: ${checkError}`);
				}

				// GitHub Copilot Chat extension global storage
				const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', 'github.copilot-chat');
				try {
					if (fs.existsSync(copilotChatGlobalPath)) {
						this.deps.log(`📄 Scanning ${pathName}/globalStorage/github.copilot-chat`);
						this.scanDirectoryForSessionFiles(copilotChatGlobalPath, sessionFiles);
					}
				} catch (checkError) {
					this.deps.warn(`Could not check Copilot Chat global storage path ${copilotChatGlobalPath}: ${checkError}`);
				}
			}

			// Check for Copilot CLI session-state directory (new location for agent mode sessions)
			const copilotCliSessionPath = path.join(os.homedir(), '.copilot', 'session-state');
			this.deps.log(`📁 Checking Copilot CLI path: ${copilotCliSessionPath} (exists: ${fs.existsSync(copilotCliSessionPath)})`);
			try {
				if (fs.existsSync(copilotCliSessionPath)) {
					try {
						const entries = fs.readdirSync(copilotCliSessionPath, { withFileTypes: true });

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
						let subDirSessionCount = 0;
						for (const subDir of subDirs) {
							const eventsFile = path.join(copilotCliSessionPath, subDir.name, 'events.jsonl');
							try {
								if (fs.existsSync(eventsFile)) {
									const stats = fs.statSync(eventsFile);
									if (stats.size > 0) {
										sessionFiles.push(eventsFile);
										subDirSessionCount++;
									}
								}
							} catch {
								// Ignore individual file access errors
							}
						}
						if (subDirSessionCount > 0) {
							this.deps.log(`📄 Found ${subDirSessionCount} session files in Copilot CLI subdirectories`);
						}
					} catch (readError) {
						this.deps.warn(`Could not read Copilot CLI session path in ${copilotCliSessionPath}: ${readError}`);
					}
				}
			} catch (checkError) {
				this.deps.warn(`Could not check Copilot CLI session path ${copilotCliSessionPath}: ${checkError}`);
			}

			// Check for OpenCode session files
			// OpenCode stores session data in ~/.local/share/opencode/storage/session/
			const openCodeDataDir = this.deps.openCode.getOpenCodeDataDir();
			const openCodeSessionDir = path.join(openCodeDataDir, 'storage', 'session');
			const openCodeDbPath = path.join(openCodeDataDir, 'opencode.db');
			this.deps.log(`📁 Checking OpenCode JSON path: ${openCodeSessionDir} (exists: ${fs.existsSync(openCodeSessionDir)})`);
			this.deps.log(`📁 Checking OpenCode DB path: ${openCodeDbPath} (exists: ${fs.existsSync(openCodeDbPath)})`);
			try {
				if (fs.existsSync(openCodeSessionDir)) {
					const scanOpenCodeDir = (dir: string) => {
						try {
							const entries = fs.readdirSync(dir, { withFileTypes: true });
							for (const entry of entries) {
								if (entry.isDirectory()) {
									scanOpenCodeDir(path.join(dir, entry.name));
								} else if (entry.name.startsWith('ses_') && entry.name.endsWith('.json')) {
									const fullPath = path.join(dir, entry.name);
									try {
										const stats = fs.statSync(fullPath);
										if (stats.size > 0) {
											sessionFiles.push(fullPath);
										}
									} catch {
										// Ignore file access errors
									}
								}
							}
						} catch {
							// Ignore directory access errors
						}
					};
					scanOpenCodeDir(openCodeSessionDir);
					const openCodeCount = sessionFiles.length - (sessionFiles.filter(f => !this.deps.openCode.isOpenCodeSessionFile(f))).length;
					if (openCodeCount > 0) {
						this.deps.log(`📄 Found ${openCodeCount} session files in OpenCode storage`);
					}
				}
			} catch (checkError) {
				this.deps.warn(`Could not check OpenCode session path: ${checkError}`);
			}

			// Check for OpenCode sessions in SQLite database (opencode.db)
			// Newer OpenCode versions store sessions in SQLite instead of JSON files
			try {
				if (fs.existsSync(openCodeDbPath)) {
					const existingSessionIds = new Set(
						sessionFiles
							.filter(f => this.deps.openCode.isOpenCodeSessionFile(f))
							.map(f => this.deps.openCode.getOpenCodeSessionId(f))
							.filter(Boolean)
					);
					const dbSessionIds = await this.deps.openCode.discoverOpenCodeDbSessions();
					let dbNewCount = 0;
					for (const sessionId of dbSessionIds) {
						if (!existingSessionIds.has(sessionId)) {
							// Create virtual path for DB session
							sessionFiles.push(path.join(openCodeDataDir, `opencode.db#${sessionId}`));
							dbNewCount++;
						}
					}
					if (dbNewCount > 0) {
						this.deps.log(`📄 Found ${dbNewCount} additional session(s) in OpenCode database`);
					}
				}
			} catch (dbError) {
				this.deps.warn(`Could not read OpenCode database: ${dbError}`);
			}

			// Check for Crush sessions (per-project ~/.crush/crush.db)
			// Crush records all known projects in %LOCALAPPDATA%/crush/projects.json (Windows)
			try {
				const crushProjects = this.deps.crush.readCrushProjects();
				this.deps.log(`📁 Crush: found ${crushProjects.length} project(s) in projects.json`);
				let crushTotal = 0;
				for (const project of crushProjects) {
					const dbPath = path.join(project.data_dir, 'crush.db');
					this.deps.log(`📁 Checking Crush DB path: ${dbPath} (exists: ${fs.existsSync(dbPath)})`);
					try {
						if (fs.existsSync(dbPath)) {
							const sessionIds = await this.deps.crush.discoverSessionsInDb(dbPath);
							for (const sessionId of sessionIds) {
								// Virtual path: <data_dir>/crush.db#<uuid>
								sessionFiles.push(path.join(project.data_dir, `crush.db#${sessionId}`));
								crushTotal++;
							}
						}
					} catch (projectError) {
						this.deps.warn(`Could not read Crush database for ${project.path}: ${projectError}`);
					}
				}
				if (crushTotal > 0) {
					this.deps.log(`📄 Found ${crushTotal} session(s) in Crush database(s)`);
				}
			} catch (crushError) {
				this.deps.warn(`Could not read Crush projects: ${crushError}`);
			}
			// Check for Continue extension session files (~/.continue/sessions/*.json)
			try {
				const continueFiles = this.deps.continue_.getContinueSessionFiles();
				if (continueFiles.length > 0) {
					this.deps.log(`📄 Found ${continueFiles.length} session file(s) in Continue (~/.continue/sessions)`);
					sessionFiles.push(...continueFiles);
				}
			} catch (continueError) {
				this.deps.warn(`Could not read Continue session files: ${continueError}`);
			}

			// Check for Visual Studio Copilot session files
			try {
				const vsSessions = this.deps.visualStudio.discoverSessions();
				if (vsSessions.length > 0) {
					this.deps.log(`📄 Found ${vsSessions.length} session file(s) in Visual Studio Copilot`);
					sessionFiles.push(...vsSessions);
				}
			} catch (vsError) {
				this.deps.warn(`Could not read Visual Studio session files: ${vsError}`);
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
	scanDirectoryForSessionFiles(dir: string, sessionFiles: string[]): void {
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

