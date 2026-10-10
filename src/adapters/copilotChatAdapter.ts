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
 *   - workspaceStorage/<hash>/GitHub.copilot/chatSessions/             (unified extension, VS Code 1.117+)
 *   - workspaceStorage/<hash>/github.copilot/chatSessions/             (Linux case-sensitive variant)
 *   - workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/          (debug logs, e.g. devcontainer layout)
 *   - workspaceStorage/<hash>/github.copilot-chat/debug-logs/          (Linux case-sensitive variant)
 *   - workspaceStorage/<hash>/GitHub.copilot/debug-logs/               (unified extension debug logs)
 *   - workspaceStorage/<hash>/github.copilot/debug-logs/               (Linux case-sensitive variant)
 *   - workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/         (Copilot Chat ≥ v0.51.0 — new typed-event JSONL)
 *   - workspaceStorage/<hash>/github.copilot-chat/transcripts/         (Linux case-sensitive variant)
 *   - workspaceStorage/<hash>/GitHub.copilot/transcripts/              (unified extension, ≥ v0.51.0)
 *   - workspaceStorage/<hash>/github.copilot/transcripts/              (Linux case-sensitive variant)
 *   - globalStorage/emptyWindowChatSessions/                           (legacy)
 *   - globalStorage/{GitHub,github}.copilot-chat/**                    (both casings, recursive)
 *   - globalStorage/{GitHub,github}.copilot/**                         (unified extension, both casings)
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
import { isCopilotChatNonSessionFile } from './adapterPredicates';
import { normalizePath } from '../utils/pathUtils';
import { pathExists } from '../utils/fsAsync';
import { readTextFileWithSizeGuard } from '../utils/safeFileRead';

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

/** A discovered WSL Windows user root: which `/mnt/<drive>/Users` directory a username lives under. */
interface WslUserRoot {
	username: string;
	usersDir: string;
}

/**
 * Adds a candidate WSL user root, skipping it if an entry for the same directory already
 * exists with a username differing only in case. Windows usernames are case-insensitive, so
 * without this a `USERPROFILE`-derived "Alice" and an enumerated "alice" in the same
 * `/mnt/<drive>/Users` directory would otherwise be treated as two different users and the
 * same physical memory-file roots would be scanned (and counted) twice.
 */
function addWslUserRoot(roots: WslUserRoot[], candidate: WslUserRoot): void {
	const exists = roots.some(
		r => r.usersDir === candidate.usersDir && r.username.toLowerCase() === candidate.username.toLowerCase(),
	);
	if (!exists) { roots.push(candidate); }
}

/**
 * Extracts a `{ username, usersDir }` root from a WSL-style `USERPROFILE` value such as
 * `/mnt/c/Users/alice` or `/mnt/d/Users/alice`. The drive letter is preserved in `usersDir`
 * rather than being discarded in favour of a hard-coded `/mnt/c/Users`, so a profile that
 * lives on a non-C drive still resolves to its own real root instead of silently probing
 * the (wrong) C: drive path.
 */
function wslUserRootFromUserProfile(userprofile: string | undefined): WslUserRoot | undefined {
	if (!userprofile) { return undefined; }
	const match = userprofile.match(/^\/mnt\/([a-z])\/Users\/([^/]+)/);
	if (!match) { return undefined; }
	return { username: match[2], usersDir: `/mnt/${match[1]}/Users` };
}

const WINDOWS_USERS_C_DRIVE = '/mnt/c/Users';

/**
 * When running inside WSL, probes the Windows-side VS Code user paths
 * (mounted at /mnt/c/Users/<name>/AppData/Roaming/...) so sessions created
 * in a native Windows VS Code window are also discovered. Always returns []
 * outside of WSL or when /mnt/c is not mounted (and USERPROFILE doesn't point
 * at a usable drive either).
 */
export async function getWSLWindowsPaths(): Promise<string[]> {
	if (!isWSL()) { return []; }

	const wslPaths: string[] = [];
	const userRoots: WslUserRoot[] = [];

	const profileRoot = wslUserRootFromUserProfile(process.env.USERPROFILE);
	if (profileRoot) { addWslUserRoot(userRoots, profileRoot); }

	try {
		const entries = await fs.promises.readdir(WINDOWS_USERS_C_DRIVE, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			const name = entry.name;
			if (SYSTEM_USER_FOLDERS.has(name) || name.startsWith('.')) { continue; }
			addWslUserRoot(userRoots, { username: name, usersDir: WINDOWS_USERS_C_DRIVE });
		}
	} catch {
		// C: drive's /mnt/c/Users not accessible — WSL drive not mounted or no Windows
		// partition. A profile-derived root on another drive (if any) is still usable.
		if (userRoots.length === 0) { return []; }
	}

	for (const { username, usersDir } of userRoots) {
		const appData = path.join(usersDir, username, 'AppData', 'Roaming');
		for (const variant of VSCODE_VARIANTS) {
			wslPaths.push(path.join(appData, variant, 'User'));
		}
	}

	return wslPaths;
}

/**
 * Synchronous flavour originally added for the diagnostics panel so it can render
 * Windows-side WSL candidates without an await; `src/copilotMemoryFiles.ts` also calls
 * it (from `getDefaultUserPaths()`) to discover Windows-side memory files under WSL, since
 * memory-file discovery is itself synchronous end to end. Mirrors getWSLWindowsPaths: when
 * `/mnt/c/Users` can't be enumerated it falls back to a `USERPROFILE`-derived root (which may
 * live on a different drive), and only returns an empty list when neither source yields one.
 */
export function getWSLWindowsPathsSync(): string[] {
	if (!isWSL()) { return []; }
	const userRoots: WslUserRoot[] = [];

	// USERPROFILE in WSL is sometimes set to a /mnt/<drive>/Users/<name> path. Collect it
	// before (and independently of) directory enumeration so a profile-derived root is still
	// found when /mnt/c/Users itself can't be listed (see getWSLWindowsPaths above).
	const profileRoot = wslUserRootFromUserProfile(process.env.USERPROFILE);
	if (profileRoot) { addWslUserRoot(userRoots, profileRoot); }

	try {
		const entries = fs.readdirSync(WINDOWS_USERS_C_DRIVE, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || SYSTEM_USER_FOLDERS.has(entry.name)) {
				continue;
			}
			addWslUserRoot(userRoots, { username: entry.name, usersDir: WINDOWS_USERS_C_DRIVE });
		}
	} catch {
		/* /mnt/c not accessible — fall through with whatever USERPROFILE gave us */
	}

	const out: string[] = [];
	for (const { username, usersDir } of userRoots) {
		const appData = path.join(usersDir, username, 'AppData', 'Roaming');
		for (const variant of VSCODE_VARIANTS) {
			out.push(path.join(appData, variant, 'User'));
		}
	}
	return out;
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
		if (isCopilotChatNonSessionFile(entry.name)) { continue; }
		try {
			const stats = await fs.promises.stat(full);
			if (stats.size > 0) { out.push(full); }
		} catch { /* ignore */ }
	}
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
			const content = await readTextFileWithSizeGuard(sessionFile, 'copilotChatAdapter');
			if (content === undefined) {
				return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
			}
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
		const norm = normalizePath(sessionFile);
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

		const allVSCodePaths = await this.resolveAllVSCodePaths(log);
		log(`📂 Considering ${allVSCodePaths.length} candidate VS Code paths`);

		const existence = await Promise.all(allVSCodePaths.map(p => pathExists(p).catch(() => false)));
		const foundPaths = allVSCodePaths.filter((_, i) => existence[i]);
		log(`✅ Found ${foundPaths.length} of ${allVSCodePaths.length} VS Code paths exist on disk`);

		await runWithConcurrency(foundPaths, async (codeUserPath) => {
			const pathName = path.basename(path.dirname(codeUserPath));
			await this.scanWorkspaceStorage(codeUserPath, pathName, sessionFiles, log);
			await this.scanGlobalStorage(codeUserPath, pathName, sessionFiles, log);
		}, 4, (item, _i, err) => {
			log(`Failed to scan VS Code user path ${item}: ${err instanceof Error ? err.message : String(err)}`);
		});

		return { sessionFiles, candidatePaths };
	}

	private async resolveAllVSCodePaths(log: (msg: string) => void): Promise<string[]> {
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
		return allVSCodePaths;
	}

	private async scanWorkspaceStorage(codeUserPath: string, pathName: string, sessionFiles: string[], log: (msg: string) => void): Promise<void> {
		const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
		let workspaceDirs: string[];
		try {
			workspaceDirs = await fs.promises.readdir(workspaceStoragePath);
		} catch {
			return; // workspaceStorage doesn't exist for this VS Code variant — silent skip
		}

		const EXT_FOLDERS = ['GitHub.copilot-chat', 'github.copilot-chat', 'GitHub.copilot', 'github.copilot'];
		const SESSION_SUBDIRS = ['chatSessions', 'debug-logs', 'transcripts'];

		// Scan a single leaf directory, collecting .json/.jsonl files into sessionFiles.
		const scanLeafDir = async (dirPath: string) => {
			try {
				const files = (await fs.promises.readdir(dirPath))
					.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
					.map(f => path.join(dirPath, f));
				if (files.length > 0) { sessionFiles.push(...files); }
			} catch { /* directory doesn't exist or isn't readable */ }
		};

		let dirsWithSessions = 0;
		await runWithConcurrency(workspaceDirs, async (workspaceDir) => {
			const wdPath = path.join(workspaceStoragePath, workspaceDir);
			// One readdir per workspace dir replaces 9 sequential pathExists probes.
			let entries: string[];
			try {
				entries = await fs.promises.readdir(wdPath);
			} catch { return; }
			const entrySet = new Set(entries);

			const before = sessionFiles.length;

			// Legacy flat chatSessions (pre-extension-namespacing)
			if (entrySet.has('chatSessions')) {
				await scanLeafDir(path.join(wdPath, 'chatSessions'));
			}

			// Extension-namespaced subdirs — only descend into folders that exist
			for (const extFolder of EXT_FOLDERS) {
				if (!entrySet.has(extFolder)) { continue; }
				for (const subDir of SESSION_SUBDIRS) {
					await scanLeafDir(path.join(wdPath, extFolder, subDir));
				}
			}

			if (sessionFiles.length > before) { dirsWithSessions++; }
		}, 8);

		if (dirsWithSessions > 0) {
			log(`📂 ${pathName}: found sessions in ${dirsWithSessions}/${workspaceDirs.length} workspace dir(s)`);
		}
	}

	private async scanGlobalStorage(codeUserPath: string, pathName: string, sessionFiles: string[], log: (msg: string) => void): Promise<void> {
		// globalStorage/emptyWindowChatSessions/ — try readdir directly, skip on error
		try {
			const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
			const files = (await fs.promises.readdir(globalStoragePath))
				.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
				.map(f => path.join(globalStoragePath, f));
			if (files.length > 0) { sessionFiles.push(...files); }
		} catch { /* path doesn't exist */ }

		// globalStorage/{GitHub,github}.copilot-chat/** and {GitHub,github}.copilot/** (recursive)
		for (const extFolderName of ['GitHub.copilot-chat', 'github.copilot-chat', 'GitHub.copilot', 'github.copilot']) {
			const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', extFolderName);
			try {
				await fs.promises.access(copilotChatGlobalPath);
				await scanGlobalStorageRecursively(copilotChatGlobalPath, sessionFiles, log);
			} catch { /* path doesn't exist */ }
		}
	}
}
