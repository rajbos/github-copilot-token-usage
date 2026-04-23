/**
 * CopilotChatAdapter — discovers GitHub Copilot Chat session files for the
 * VS Code family of editors (Code, Code - Insiders, Code - Exploration,
 * VSCodium, Cursor) and the corresponding remote/server installations
 * (.vscode-server, .vscode-remote, /tmp, /workspace), plus Windows-side
 * paths probed from inside WSL.
 *
 * Discovery scope (was previously hardcoded in sessionDiscovery.ts):
 *   - workspaceStorage/<hash>/chatSessions/                            (legacy layout)
 *   - workspaceStorage/<hash>/GitHub.copilot-chat/chatSessions/        (newer layout)
 *   - workspaceStorage/<hash>/github.copilot-chat/chatSessions/        (Linux case-sensitive variant)
 *   - globalStorage/emptyWindowChatSessions/                           (legacy)
 *   - globalStorage/{GitHub,github}.copilot-chat/**                    (both casings, recursive)
 *
 * NOTE on `handles()`: this adapter currently returns `false` so that the
 * existing fallback parsing code in `extension.ts` continues to own the
 * chat-session parsing semantics unchanged. Discovery is the primary value
 * delivered by this adapter; full delegation of getTokens/getMeta/etc. is a
 * planned follow-up. The other IEcosystemAdapter methods are implemented as
 * safe defaults that delegate to the shared parser helpers, so a future
 * change can flip `handles()` to a real predicate (e.g. `isCopilotChatPath`)
 * without re-plumbing call sites.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage } from '../types';
import type {
	IEcosystemAdapter,
	IDiscoverableEcosystem,
	DiscoveryResult,
	CandidatePath,
} from '../ecosystemAdapter';
import {
	estimateTokensFromJsonlSession,
	isJsonlContent,
	isUuidPointerFile,
} from '../tokenEstimation';

/** VS Code variants probed across all platforms. */
const VSCODE_VARIANTS = [
	'Code',                // Stable
	'Code - Insiders',     // Insiders
	'Code - Exploration',  // Exploration builds
	'VSCodium',            // VSCodium
	'Cursor',              // Cursor editor
] as const;

const SYSTEM_USER_FOLDERS = new Set(['Public', 'Default', 'Default User', 'All Users']);

/**
 * Returns true when the host is running inside a WSL distribution.
 * Mirrors the original implementation in sessionDiscovery.ts.
 */
export function isWSL(): boolean {
	return os.platform() === 'linux' && (
		typeof process.env.WSL_DISTRO_NAME === 'string' ||
		typeof process.env.WSL_INTEROP === 'string'
	);
}

/**
 * Compute every candidate VS Code "User" directory the extension should
 * consider when scanning for Copilot Chat session files.
 *
 * NOTE: The canonical JavaScript implementation is in:
 *   .github/skills/copilot-log-analysis/session-file-discovery.js
 * This TypeScript implementation must mirror that logic.
 */
export function getVSCodeUserPaths(): string[] {
	const platform = os.platform();
	const homedir = os.homedir();
	const paths: string[] = [];

	if (platform === 'win32') {
		const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
		for (const variant of VSCODE_VARIANTS) {
			paths.push(path.join(appDataPath, variant, 'User'));
		}
	} else if (platform === 'darwin') {
		for (const variant of VSCODE_VARIANTS) {
			paths.push(path.join(homedir, 'Library', 'Application Support', variant, 'User'));
		}
	} else {
		const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
		for (const variant of VSCODE_VARIANTS) {
			paths.push(path.join(xdgConfigHome, variant, 'User'));
		}
	}

	// Remote/Server paths (Codespaces, WSL, SSH remotes)
	paths.push(
		path.join(homedir, '.vscode-server', 'data', 'User'),
		path.join(homedir, '.vscode-server-insiders', 'data', 'User'),
		path.join(homedir, '.vscode-remote', 'data', 'User'),
		path.join('/tmp', '.vscode-server', 'data', 'User'),
		path.join('/workspace', '.vscode-server', 'data', 'User'),
	);

	return paths;
}

/**
 * When running inside WSL, probes the Windows-side VS Code user paths
 * (mounted at /mnt/c/Users/<name>/AppData/Roaming/...) so sessions created
 * in a native Windows VS Code window are also discovered. Always returns []
 * outside of WSL or when /mnt/c is not mounted.
 */
export async function getWSLWindowsPaths(): Promise<string[]> {
	if (!isWSL()) { return []; }

	const wslPaths: string[] = [];
	const windowsUsernames: string[] = [];

	// USERPROFILE in WSL is sometimes set to a /mnt/c/Users/<name> path.
	const userprofile = process.env.USERPROFILE;
	if (userprofile) {
		const match = userprofile.match(/^\/mnt\/[a-z]\/Users\/([^/]+)/);
		if (match) { windowsUsernames.push(match[1]); }
	}

	const windowsUsersDir = '/mnt/c/Users';
	try {
		const entries = await fs.promises.readdir(windowsUsersDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			const name = entry.name;
			if (SYSTEM_USER_FOLDERS.has(name) || name.startsWith('.')) { continue; }
			if (!windowsUsernames.includes(name)) { windowsUsernames.push(name); }
		}
	} catch {
		// /mnt/c/Users not accessible — WSL drive not mounted or no Windows partition.
		return [];
	}

	for (const winUser of windowsUsernames) {
		const appData = path.join(windowsUsersDir, winUser, 'AppData', 'Roaming');
		for (const variant of VSCODE_VARIANTS) {
			wslPaths.push(path.join(appData, variant, 'User'));
		}
	}

	return wslPaths;
}

/**
 * Synchronous flavour used only by the diagnostics panel so it can render
 * Windows-side WSL candidates without an await. Mirrors getWSLWindowsPaths
 * but tolerates a missing /mnt/c by returning an empty list.
 */
function getWSLWindowsPathsSync(): string[] {
	if (!isWSL()) { return []; }
	const out: string[] = [];
	const windowsUsersDir = '/mnt/c/Users';
	try {
		const entries = fs.readdirSync(windowsUsersDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || SYSTEM_USER_FOLDERS.has(entry.name)) {
				continue;
			}
			for (const variant of VSCODE_VARIANTS) {
				out.push(path.join(windowsUsersDir, entry.name, 'AppData', 'Roaming', variant, 'User'));
			}
		}
	} catch {
		/* /mnt/c not accessible — skip */
	}
	return out;
}

/** Filenames we explicitly skip when recursively scanning Copilot Chat globalStorage. */
const NON_SESSION_PATTERNS = [
	'embeddings',
	'index',
	'cache',
	'preferences',
	'settings',
	'config',
	'workspacesessions',
	'globalsessions',
	'api.json',
];

function isNonSessionFile(filename: string): boolean {
	const lower = filename.toLowerCase();
	return NON_SESSION_PATTERNS.some(p => lower.includes(p));
}

async function pathExists(p: string): Promise<boolean> {
	try { await fs.promises.access(p); return true; } catch { return false; }
}

async function runWithConcurrency<T>(
	items: T[],
	fn: (item: T, index: number) => Promise<void>,
	limit: number,
	onError?: (item: T, index: number, err: unknown) => void,
): Promise<void> {
	if (items.length === 0) { return; }
	let index = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (index < items.length) {
			const i = index++;
			try { await fn(items[i], i); } catch (e) { onError?.(items[i], i, e); }
		}
	});
	await Promise.all(workers);
}

/**
 * Recursively walks a directory collecting Copilot Chat session files
 * (.json / .jsonl), skipping known non-session filenames and empty files.
 */
async function scanGlobalStorageRecursively(
	dir: string,
	out: string[],
	log: (msg: string) => void,
): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (e) {
		log(`Could not scan directory ${dir}: ${e}`);
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await scanGlobalStorageRecursively(full, out, log);
			continue;
		}
		if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) { continue; }
		if (isNonSessionFile(entry.name)) { continue; }
		try {
			const stats = await fs.promises.stat(full);
			if (stats.size > 0) { out.push(full); }
		} catch { /* ignore */ }
	}
}

/**
 * Path predicate that recognises Copilot Chat session storage shapes. Kept
 * narrow so it never accidentally claims unrelated VS Code files.
 */
export function isCopilotChatSessionPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, '/');
	if (!/\.jsonl?$/.test(norm)) { return false; }

	// workspaceStorage/<hash>/chatSessions/<file>
	if (/\/workspaceStorage\/[^/]+\/(?:GitHub\.copilot-chat|github\.copilot-chat)\/chatSessions\/[^/]+$/.test(norm)) {
		return true;
	}
	if (/\/workspaceStorage\/[^/]+\/chatSessions\/[^/]+$/.test(norm)) {
		return true;
	}
	// globalStorage/emptyWindowChatSessions/<file>
	if (/\/globalStorage\/emptyWindowChatSessions\/[^/]+$/.test(norm)) { return true; }
	// globalStorage/{GitHub,github}.copilot-chat/**
	if (/\/globalStorage\/(?:GitHub|github)\.copilot-chat\/.+$/.test(norm)) {
		return !isNonSessionFile(path.basename(norm));
	}
	return false;
}

export class CopilotChatAdapter implements IEcosystemAdapter, IDiscoverableEcosystem {
	readonly id = 'copilotchat';
	readonly displayName = 'GitHub Copilot Chat';

	/**
	 * Currently a no-op match. The adapter participates in discovery via
	 * IDiscoverableEcosystem but lets the existing fallback parsing code in
	 * extension.ts continue to own per-session parsing for VS Code Copilot
	 * Chat files. A future PR can return `isCopilotChatSessionPath(...)`
	 * here once the parsing helpers are extracted from extension.ts.
	 */
	handles(_sessionFile: string): boolean {
		return false;
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		try {
			const content = await fs.promises.readFile(sessionFile, 'utf8');
			if (isUuidPointerFile(content)) {
				return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
			}
			if (sessionFile.endsWith('.jsonl') || isJsonlContent(content)) {
				return estimateTokensFromJsonlSession(content);
			}
			// JSON path: deliberately not implemented here while handles() returns false.
			// The existing fallback in extension.ts owns this. When handles() flips,
			// this should call the extracted JSON token estimator.
			return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
		} catch {
			return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
		}
	}

	async countInteractions(_sessionFile: string): Promise<number> {
		return 0;
	}

	async getModelUsage(_sessionFile: string): Promise<ModelUsage> {
		return {};
	}

	async getMeta(_sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		return { title: undefined, firstInteraction: null, lastInteraction: null };
	}

	getEditorRoot(sessionFile: string): string {
		// Walk up from the session file to the VS Code "User" directory.
		const norm = sessionFile.replace(/\\/g, '/');
		const userIdx = norm.lastIndexOf('/User/');
		if (userIdx >= 0) {
			return norm.substring(0, userIdx + '/User'.length);
		}
		return path.dirname(sessionFile);
	}

	/**
	 * Build the full list of candidate VS Code user paths for diagnostics.
	 * Includes WSL Windows-side candidates synchronously where possible.
	 */
	getCandidatePaths(): CandidatePath[] {
		const out: CandidatePath[] = [];
		for (const p of getVSCodeUserPaths()) {
			out.push({ path: p, source: 'VS Code' });
		}
		for (const p of getWSLWindowsPathsSync()) {
			out.push({ path: p, source: 'VS Code (Windows via WSL)' });
		}
		return out;
	}

	/**
	 * Discover all Copilot Chat session files across every VS Code user path,
	 * including WSL Windows-side paths when applicable. Mirrors the original
	 * sessionDiscovery.ts logic: parallel existence checks, bounded concurrency
	 * per workspaceStorage scan.
	 */
	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];

		const allVSCodePaths = getVSCodeUserPaths();
		if (isWSL()) {
			log(`🪟 WSL environment detected — probing Windows-side VS Code paths`);
			const wslWinPaths = await getWSLWindowsPaths();
			if (wslWinPaths.length > 0) {
				log(`🪟 Adding ${wslWinPaths.length} Windows-side candidate paths from WSL`);
				allVSCodePaths.push(...wslWinPaths);
			} else {
				log(`🪟 No Windows-side paths found (Windows drive may not be mounted)`);
			}
		}

		log(`📂 Considering ${allVSCodePaths.length} candidate VS Code paths`);

		const existence = await Promise.all(
			allVSCodePaths.map(p => pathExists(p).catch(() => false)),
		);
		const foundPaths = allVSCodePaths.filter((_, i) => existence[i]);
		log(`✅ Found ${foundPaths.length} of ${allVSCodePaths.length} VS Code paths exist on disk`);

		await runWithConcurrency(foundPaths, async (codeUserPath) => {
			const pathName = path.basename(path.dirname(codeUserPath));

			// workspaceStorage/<hash>/{,GitHub.copilot-chat/,github.copilot-chat/}chatSessions/
			const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
			try {
				if (await pathExists(workspaceStoragePath)) {
					const workspaceDirs = await fs.promises.readdir(workspaceStoragePath);
					await runWithConcurrency(workspaceDirs, async (workspaceDir) => {
						const candidates = [
							path.join(workspaceStoragePath, workspaceDir, 'chatSessions'),
							path.join(workspaceStoragePath, workspaceDir, 'GitHub.copilot-chat', 'chatSessions'),
							path.join(workspaceStoragePath, workspaceDir, 'github.copilot-chat', 'chatSessions'),
						];
						for (const chatSessionsPath of candidates) {
							try {
								if (!(await pathExists(chatSessionsPath))) { continue; }
								const files = (await fs.promises.readdir(chatSessionsPath))
									.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
									.map(f => path.join(chatSessionsPath, f));
								if (files.length > 0) {
									log(`📄 Found ${files.length} session files in ${pathName}/workspaceStorage/${workspaceDir}`);
									sessionFiles.push(...files);
								}
							} catch { /* ignore individual workspace dir errors */ }
						}
					}, 6);
				}
			} catch (e) {
				log(`Could not check workspace storage path ${workspaceStoragePath}: ${e}`);
			}

			// globalStorage/emptyWindowChatSessions/
			const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
			try {
				if (await pathExists(globalStoragePath)) {
					const files = (await fs.promises.readdir(globalStoragePath))
						.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
						.map(f => path.join(globalStoragePath, f));
					if (files.length > 0) {
						log(`📄 Found ${files.length} session files in ${pathName}/globalStorage/emptyWindowChatSessions`);
						sessionFiles.push(...files);
					}
				}
			} catch (e) {
				log(`Could not check global storage path ${globalStoragePath}: ${e}`);
			}

			// globalStorage/{GitHub,github}.copilot-chat/** (recursive)
			for (const extFolderName of ['GitHub.copilot-chat', 'github.copilot-chat']) {
				const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', extFolderName);
				try {
					if (await pathExists(copilotChatGlobalPath)) {
						log(`📄 Scanning ${pathName}/globalStorage/${extFolderName}`);
						await scanGlobalStorageRecursively(copilotChatGlobalPath, sessionFiles, log);
					}
				} catch (e) {
					log(`Could not check Copilot Chat global storage path ${copilotChatGlobalPath}: ${e}`);
				}
			}
		}, 4, (item, _i, err) => {
			log(`Failed to scan VS Code user path ${item}: ${err instanceof Error ? err.message : String(err)}`);
		});

		return { sessionFiles, candidatePaths };
	}
}
