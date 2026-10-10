/**
 * Copilot Memory Files discovery & analysis.
 *
 * GitHub Copilot's agent writes its own Markdown "memory" notes to disk, in three scopes
 * (see docs/features/COPILOT-MEMORY-FILES-INSIGHT.md for the full writeup):
 *
 *   - User (global):  <User>/globalStorage/{GitHub,github}.copilot-chat/memory-tool/memories/*.md
 *   - Repo (per-workspace):    <User>/workspaceStorage/<hash>/{GitHub,github}.copilot-chat/memory-tool/memories/repo/*.md
 *   - Session (per-workspace): .../memory-tool/memories/<base64(sessionId)>/*.md
 *                              .../memory-tool/memories/session/*.md  (literal folder, older/alt layout)
 *
 * Session-scope folders come in two layouts: most commonly the folder name is the
 * base64-encoded chat-session UUID and must be decoded explicitly (see
 * `decodeSessionFolderName`), but some memory-tool versions use a literal "session" folder
 * instead (no session UUID to decode). Both are recognized and folded into session scope;
 * anything else under memories/ is an unrecognized layout and is skipped.
 *
 * This module discovers those files and produces a metadata-only hygiene analysis (counts,
 * staleness, size). It never reads a memory file's *content* beyond deriving a display title
 * from its filename. Pure Node (fs/path), no VS Code API, so the extension and the CLI share it.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { MemoryFileEntry, MemoryFilesAnalysis, MemoryFilesAnalysisView, MemoryFilesWorkspaceSummary } from './types';
import { parseWorkspaceStorageJsonFile } from './workspacePathResolver';
import { getVSCodeUserPaths, getWSLWindowsPathsSync, isWSL } from './adapters/copilotChatAdapter';

/** Extension-folder spellings Copilot Chat's memory-tool directory has shipped under. */
const COPILOT_EXTENSION_FOLDERS = ['GitHub.copilot-chat', 'github.copilot-chat', 'GitHub.copilot', 'github.copilot'];

/** Path segments from the extension folder down to the memory files themselves. */
const MEMORY_TOOL_SEGMENTS = ['memory-tool', 'memories'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Standard base64 alphabet (RFC 4648 §4), with optional `=`/`==` padding. `Buffer.from(...,
 * 'base64')` silently ignores characters outside this set instead of throwing, so a folder name
 * with stray characters (e.g. a valid encoded UUID plus a trailing `!`) would otherwise decode to
 * the same UUID and be misclassified as session scope. Reject anything that isn't valid base64
 * before decoding.
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Default look-back threshold (days) beyond which a memory file is flagged as stale. */
export const DEFAULT_STALE_DAYS = 90;
/** Default size threshold (bytes) beyond which a memory file is flagged as unusually large. */
export const DEFAULT_LARGE_FILE_BYTES = 10 * 1024;

/**
 * Attempt to decode a base64-encoded session-scope folder name back to the chat session UUID
 * it was derived from. This is the more common session-scope layout; some memory-tool versions
 * instead use a literal "session" folder with no UUID to decode (see `discoverWorkspaceHashMemoryFiles`,
 * which recognizes that layout separately). Returns undefined for anything that doesn't decode to
 * a UUID (e.g. the literal "repo"/"session" folders, or an unrecognized layout).
 */
export function decodeSessionFolderName(folderName: string): string | undefined {
	if (!folderName || folderName === 'repo' || !BASE64_RE.test(folderName)) { return undefined; }
	try {
		const decoded = Buffer.from(folderName, 'base64').toString('utf8');
		return UUID_RE.test(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function listMdFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter(d => d.isFile() && d.name.toLowerCase().endsWith('.md'))
			.map(d => path.join(dir, d.name));
	} catch {
		return [];
	}
}

function listSubDirNames(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter(d => d.isDirectory())
			.map(d => d.name);
	} catch {
		return [];
	}
}

function toEntry(filePath: string, scope: MemoryFileEntry['scope'], extra: Partial<MemoryFileEntry> = {}): MemoryFileEntry | undefined {
	try {
		const stat = fs.statSync(filePath);
		return {
			path: filePath,
			scope,
			sizeBytes: stat.size,
			mtimeMs: stat.mtimeMs,
			title: path.basename(filePath, path.extname(filePath)),
			...extra,
		};
	} catch {
		return undefined;
	}
}

/**
 * Filter `COPILOT_EXTENSION_FOLDERS` down to the spellings that actually exist as directory
 * entries directly under `parentDir`, matched with exact case via a single `readdirSync`. Using
 * `fs.existsSync(candidate)` per spelling would false-positive on case-insensitive filesystems
 * (Windows, default macOS) — e.g. `github.copilot-chat` would appear to "exist" merely because
 * `GitHub.copilot-chat` does, causing every file under it to be discovered and counted twice.
 * Reading the real directory entries once and matching by exact name (as
 * `adapters/copilotChatAdapter.ts`'s session-file discovery does) avoids that duplication while
 * still finding every spelling that is genuinely present (e.g. on a case-sensitive filesystem
 * after an extension id migration).
 */
function matchedExtensionFolders(parentDir: string): string[] {
	const entrySet = new Set(listSubDirNames(parentDir));
	return COPILOT_EXTENSION_FOLDERS.filter(f => entrySet.has(f));
}

/**
 * Find every existing `memory-tool/memories` directory under a "User" root's `globalStorage`,
 * across all known extension-folder spellings. Multiple spellings can coexist on the same
 * machine (e.g. after an extension id migration, or on case-sensitive filesystems), so all
 * matches are returned rather than stopping at the first hit — otherwise files under the
 * later folder(s) would be silently dropped. Mirrors the multi-folder scan pattern in
 * `adapters/copilotChatAdapter.ts`'s session-file discovery.
 */
function findGlobalMemoriesDirs(userPath: string): string[] {
	const globalStorageDir = path.join(userPath, 'globalStorage');
	return matchedExtensionFolders(globalStorageDir)
		.map(extFolder => path.join(globalStorageDir, extFolder, ...MEMORY_TOOL_SEGMENTS))
		.filter(candidate => fs.existsSync(candidate));
}

/**
 * Find every existing `memory-tool/memories` directory under a specific
 * `workspaceStorage/<hash>`, across all known extension-folder spellings. See
 * {@link findGlobalMemoriesDirs} for why matching is done against real directory entries
 * instead of per-spelling `existsSync` calls.
 */
function findWorkspaceMemoriesDirs(userPath: string, hash: string): string[] {
	const hashDir = path.join(userPath, 'workspaceStorage', hash);
	return matchedExtensionFolders(hashDir)
		.map(extFolder => path.join(hashDir, extFolder, ...MEMORY_TOOL_SEGMENTS))
		.filter(candidate => fs.existsSync(candidate));
}

/**
 * Resolve a `workspaceStorage/<hash>` folder back to its real workspace folder path, by reading
 * `workspace.json` / `meta.json` — reuses the same JSON parsing helper the session-attribution
 * code uses, so this stays in sync with that logic instead of re-implementing it.
 */
function resolveWorkspaceName(userPath: string, hash: string): string | undefined {
	const hashDir = path.join(userPath, 'workspaceStorage', hash);
	const workspaceJsonPath = path.join(hashDir, 'workspace.json');
	const metaJsonPath = path.join(hashDir, 'meta.json');
	if (fs.existsSync(workspaceJsonPath)) {
		const resolved = parseWorkspaceStorageJsonFile(workspaceJsonPath, ['folder', 'workspace', 'configuration', 'uri', 'path']);
		if (resolved) { return resolved; }
	}
	if (fs.existsSync(metaJsonPath)) {
		return parseWorkspaceStorageJsonFile(metaJsonPath, ['folder', 'uri', 'workspace', 'path']);
	}
	return undefined;
}

/** Discover memory files for one `workspaceStorage/<hash>` folder (repo + session scope subdirs). */
function discoverWorkspaceHashMemoryFiles(userPath: string, hash: string): MemoryFileEntry[] {
	const memoriesDirs = findWorkspaceMemoriesDirs(userPath, hash);
	if (memoriesDirs.length === 0) { return []; }
	const workspaceName = resolveWorkspaceName(userPath, hash);

	const entries: MemoryFileEntry[] = [];
	for (const memoriesDir of memoriesDirs) {
		for (const subDir of listSubDirNames(memoriesDir)) {
			const isRepoScope = subDir === 'repo';
			// Some memory-tool layouts (per current VS Code agent-memory docs) use a literal
			// "session" folder rather than encoding the session UUID into the folder name.
			const isLiteralSessionScope = subDir === 'session';
			const sessionId = (isRepoScope || isLiteralSessionScope) ? undefined : decodeSessionFolderName(subDir);
			// Anything under memories/ that isn't "repo"/"session" and doesn't decode to a session
			// UUID is an unrecognized layout (future memory-tool version?) — skip it rather than
			// misclassify it.
			if (!isRepoScope && !isLiteralSessionScope && !sessionId) { continue; }
			const scope: MemoryFileEntry['scope'] = isRepoScope ? 'repo' : 'session';

			for (const file of listMdFiles(path.join(memoriesDir, subDir))) {
				const entry = toEntry(file, scope, { workspaceHash: hash, workspaceName, sessionId });
				if (entry) { entries.push(entry); }
			}
		}
	}
	return entries;
}

/**
 * Discover all Copilot memory files (user, repo and session scope) under a single VS Code
 * "User" root directory (e.g. one editor variant's `%APPDATA%/Code/User`).
 */
export function discoverMemoryFilesInUserPath(userPath: string): MemoryFileEntry[] {
	const entries: MemoryFileEntry[] = [];

	for (const globalDir of findGlobalMemoriesDirs(userPath)) {
		for (const file of listMdFiles(globalDir)) {
			const entry = toEntry(file, 'user');
			if (entry) { entries.push(entry); }
		}
	}

	const workspaceStorageRoot = path.join(userPath, 'workspaceStorage');
	for (const hash of listSubDirNames(workspaceStorageRoot)) {
		entries.push(...discoverWorkspaceHashMemoryFiles(userPath, hash));
	}

	return entries;
}

/**
 * Default set of "User" root paths to scan: every known VS Code variant, plus — when running
 * inside WSL — the Windows-side roots (`/mnt/c/Users/<name>/AppData/Roaming/...`) so memory
 * files written by a native Windows VS Code window are also discovered. Mirrors
 * `resolveAllVSCodePaths()` / `getCandidatePaths()` in `adapters/copilotChatAdapter.ts`, using
 * the synchronous WSL-path variant since this module's discovery API is synchronous.
 */
function getDefaultUserPaths(): string[] {
	const paths = getVSCodeUserPaths();
	if (isWSL()) {
		paths.push(...getWSLWindowsPathsSync());
	}
	// getVSCodeUserPaths() can yield duplicates (e.g. when os.homedir() is already /tmp or
	// /workspace, which are also appended explicitly for remote hosts). Dedupe before walking
	// so a single memory file isn't counted/scanned twice, inflating totals/stale/large counts.
	return Array.from(new Set(paths));
}

/**
 * Discover Copilot memory files across every known VS Code "User" root on this machine
 * (Code, Code - Insiders, Code - Exploration, VSCodium, Cursor), including WSL Windows-side
 * roots when applicable. Pass `userPaths` to restrict the scan, e.g. in tests, or to a single
 * workspace's own storage.
 */
export function discoverAllMemoryFiles(userPaths: string[] = getDefaultUserPaths()): MemoryFileEntry[] {
	return userPaths.flatMap(discoverMemoryFilesInUserPath);
}

/** Look up (creating if needed) the per-workspace summary bucket a file belongs to. */
function getOrCreateWorkspaceSummary(
	byWorkspaceKey: Map<string, MemoryFilesWorkspaceSummary>,
	file: MemoryFileEntry,
): MemoryFilesWorkspaceSummary {
	const key = file.scope === 'user' ? '__user__' : (file.workspaceHash ?? '__unknown__');
	let summary = byWorkspaceKey.get(key);
	if (!summary) {
		summary = {
			workspaceHash: file.scope === 'user' ? undefined : file.workspaceHash,
			workspaceName: file.scope === 'user' ? 'User (global)' : file.workspaceName,
			repoCount: 0,
			sessionCount: 0,
			userCount: 0,
			totalBytes: 0,
			newestMtimeMs: null,
			oldestMtimeMs: null,
			staleFiles: [],
		};
		byWorkspaceKey.set(key, summary);
	}
	return summary;
}

/** Fold one file's metadata into its workspace summary (counts, sizes, min/max mtime, staleness). */
function foldFileIntoSummary(summary: MemoryFilesWorkspaceSummary, file: MemoryFileEntry, staleThresholdMs: number): void {
	if (file.scope === 'repo') { summary.repoCount++; }
	else if (file.scope === 'session') { summary.sessionCount++; }
	else if (file.scope === 'user') { summary.userCount++; }
	summary.totalBytes += file.sizeBytes;
	summary.newestMtimeMs = summary.newestMtimeMs === null ? file.mtimeMs : Math.max(summary.newestMtimeMs, file.mtimeMs);
	summary.oldestMtimeMs = summary.oldestMtimeMs === null ? file.mtimeMs : Math.min(summary.oldestMtimeMs, file.mtimeMs);
	if (!summary.largestFile || file.sizeBytes > summary.largestFile.sizeBytes) { summary.largestFile = file; }
	if (file.mtimeMs < staleThresholdMs) { summary.staleFiles.push(file); }
}

/**
 * Analyze discovered memory files into a metadata-only hygiene summary: per-workspace counts,
 * staleness (files older than `staleDays`), and unusually large files (over `largeFileBytes`).
 */
export function analyzeMemoryFiles(
	files: MemoryFileEntry[],
	options: { staleDays?: number; largeFileBytes?: number } = {},
): MemoryFilesAnalysis {
	const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
	const largeFileBytes = options.largeFileBytes ?? DEFAULT_LARGE_FILE_BYTES;
	const staleThresholdMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;

	const byWorkspaceKey = new Map<string, MemoryFilesWorkspaceSummary>();
	for (const file of files) {
		const summary = getOrCreateWorkspaceSummary(byWorkspaceKey, file);
		foldFileIntoSummary(summary, file, staleThresholdMs);
	}

	return {
		staleDays,
		largeFileBytes,
		files,
		byWorkspace: Array.from(byWorkspaceKey.values()),
		totalFiles: files.length,
		totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
		staleFileCount: files.filter(f => f.mtimeMs < staleThresholdMs).length,
		largeFileCount: files.filter(f => f.sizeBytes > largeFileBytes).length,
	};
}

/**
 * Reduce a workspace folder path to its final path segment (basename), tolerating both POSIX
 * and Windows separators regardless of the host OS `path` module in use (a WSL-discovered
 * Windows path may use `\` while running on a POSIX `path` implementation, and vice versa).
 * Used to keep only a non-identifying project-folder name in {@link MemoryFilesAnalysisView} —
 * never the full absolute path.
 */
function basenameOfWorkspacePath(workspacePath: string): string {
	const normalized = workspacePath.replace(/[/\\]+$/, '');
	const segments = normalized.split(/[/\\]/);
	// A root path (e.g. "/" or "C:\") has its trailing separator trimmed away entirely,
	// leaving `normalized` (and therefore the last segment) empty. Fall back to the original,
	// untrimmed path so a root workspace still renders a label instead of an empty string.
	return segments[segments.length - 1] || normalized || workspacePath;
}

/**
 * Project a full {@link MemoryFilesAnalysis} down to the compact {@link MemoryFilesAnalysisView}
 * the Usage Analysis webview actually renders: counts and rollup scalars, without the full
 * `files` list or each workspace's `staleFiles`/`largestFile`/`oldestMtimeMs` (absolute paths,
 * session IDs, per-file objects). `workspaceName` is reduced to its basename — the raw analysis
 * carries the full workspace folder path (needed by the extension host's insights engine and the
 * CLI report), but the webview's privacy/compact contract must not ship absolute paths for
 * projects that may not even be open.
 */
export function toMemoryFilesAnalysisView(analysis: MemoryFilesAnalysis | null): MemoryFilesAnalysisView | null {
	if (!analysis) { return null; }
	return {
		staleDays: analysis.staleDays,
		largeFileBytes: analysis.largeFileBytes,
		byWorkspace: analysis.byWorkspace.map(ws => ({
			workspaceHash: ws.workspaceHash,
			workspaceName: ws.workspaceName ? basenameOfWorkspacePath(ws.workspaceName) : ws.workspaceName,
			repoCount: ws.repoCount,
			sessionCount: ws.sessionCount,
			userCount: ws.userCount,
			totalBytes: ws.totalBytes,
			newestMtimeMs: ws.newestMtimeMs,
			staleFileCount: ws.staleFiles.length,
		})),
		totalFiles: analysis.totalFiles,
		totalBytes: analysis.totalBytes,
		staleFileCount: analysis.staleFileCount,
		largeFileCount: analysis.largeFileCount,
	};
}
