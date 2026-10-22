/**
 * Node-side gathering for the Repository Heatmap: turns one session file into a
 * {@link RepoHeatmapSessionInput}. Shared by the CLI (and through it the desktop app) and the
 * VS Code extension, so the file-activity extraction, repository resolution and workspace-root
 * anchoring are the same in every host. The pure folding lives in `repoHeatmapViewBuilder.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IEcosystemAdapter } from './ecosystemAdapter';
import { extractFileActivity, extractSessionCwd } from './fileActivity';
import { agentWorktreeInfo, type RepoHeatmapSessionInput } from './repoHeatmapViewBuilder';
import { resolveSessionAttributes, type SessionAttributesCache } from './sessionRepository';
import { resolveWorkspaceFolderWithFallback } from './workspaceHelpers';
import { toLocalDayKey } from './utils/dayKeys';

/** Nearest ancestor of `dir` holding a `.git` entry (file or directory), or undefined. */
function findGitRoot(dir: string): string | undefined {
	let current = path.resolve(dir);
	for (;;) {
		if (fs.existsSync(path.join(current, '.git'))) { return current; }
		const parent = path.dirname(current);
		if (parent === current) { return undefined; }
		current = parent;
	}
}

/**
 * The folder a session's file paths are made relative to. A path-shape rule comes first so an
 * agent worktree resolves even after it was deleted; then the git root on disk; else `cwd`.
 */
export function resolveWorkspaceRoot(cwd: string): string {
	return agentWorktreeInfo(cwd)?.root ?? findGitRoot(cwd) ?? cwd;
}

export interface RepoHeatmapCollectDeps {
	ecosystems: IEcosystemAdapter[];
	attributesCache?: SessionAttributesCache;
}

/**
 * One session file as a heatmap input, or undefined when it touched no files (or is a
 * database-backed session whose log carries no tool-call paths).
 */
export async function collectRepoHeatmapSession(
	deps: RepoHeatmapCollectDeps,
	sessionFile: string,
	activityMs: number,
): Promise<RepoHeatmapSessionInput | undefined> {
	if (deps.ecosystems.some(e => e.handles(sessionFile))) { return undefined; }
	const content = await fs.promises.readFile(sessionFile, 'utf8');
	const touches = extractFileActivity(content);
	if (touches.length === 0) { return undefined; }
	const cwd = extractSessionCwd(content);
	const workspace = cwd
		? resolveWorkspaceRoot(cwd)
		: resolveWorkspaceFolderWithFallback(sessionFile, deps.attributesCache?.workspaceFolders ?? new Map());
	const attributes = await resolveSessionAttributes(deps.ecosystems, sessionFile, content, deps.attributesCache);
	return {
		repository: attributes?.repository || undefined,
		workspaceFolderPath: workspace,
		fallbackDayKey: toLocalDayKey(new Date(activityMs)),
		touches,
	};
}

// ── Whole-history scan with a persistent cache ───────────────────────────────

/** Bump when the extraction or anchoring rules change so cached results are rebuilt. */
export const REPO_HEATMAP_CACHE_VERSION = 1;

export interface RepoHeatmapCacheEntry {
	mtimeMs: number;
	size: number;
	/** null: the session was read and touched no files (cached so it is not re-read). */
	input: RepoHeatmapSessionInput | null;
}

/** Per-session results keyed by session file path; unchanged files (mtime and size) are not re-read. */
export type RepoHeatmapScanCache = Map<string, RepoHeatmapCacheEntry>;

export interface RepoHeatmapScanOptions {
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
	/** Reports a file that could not be read; the scan continues. */
	onError?: (file: string, error: unknown) => void;
}

async function scanOne(deps: RepoHeatmapCollectDeps, file: string, cache: RepoHeatmapScanCache, onError: RepoHeatmapScanOptions['onError']): Promise<RepoHeatmapSessionInput | null> {
	try {
		const stat = await fs.promises.stat(file);
		const hit = cache.get(file);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) { return hit.input; }
		const input = (await collectRepoHeatmapSession(deps, file, stat.mtimeMs)) ?? null;
		cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, input });
		return input;
	} catch (error) {
		onError?.(file, error);
		return null;
	}
}

/**
 * Collects the heatmap inputs of many session files. Entries for files that no longer exist
 * are dropped from `cache`, so it tracks the session set rather than growing forever.
 */
export async function scanRepoHeatmapSessions(
	deps: RepoHeatmapCollectDeps,
	files: string[],
	cache: RepoHeatmapScanCache,
	options: RepoHeatmapScanOptions = {},
): Promise<RepoHeatmapSessionInput[]> {
	const live = new Set(files);
	for (const key of [...cache.keys()]) { if (!live.has(key)) { cache.delete(key); } }
	const results: (RepoHeatmapSessionInput | null)[] = new Array(files.length).fill(null);
	let next = 0, done = 0;
	const worker = async (): Promise<void> => {
		while (next < files.length) {
			const i = next++;
			results[i] = await scanOne(deps, files[i], cache, options.onError);
			options.onProgress?.(++done, files.length);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 6, files.length)) }, worker));
	return results.filter((r): r is RepoHeatmapSessionInput => r !== null);
}

/** JSON form of the cache for hosts that persist it between runs. */
export function serializeRepoHeatmapCache(cache: RepoHeatmapScanCache): string {
	return JSON.stringify({ version: REPO_HEATMAP_CACHE_VERSION, entries: [...cache.entries()] });
}

/** Restores a cache written by {@link serializeRepoHeatmapCache}; any mismatch or corruption yields an empty cache. */
export function deserializeRepoHeatmapCache(json: string | undefined): RepoHeatmapScanCache {
	if (!json) { return new Map(); }
	try {
		const parsed = JSON.parse(json) as { version?: number; entries?: [string, RepoHeatmapCacheEntry][] };
		if (parsed.version !== REPO_HEATMAP_CACHE_VERSION || !Array.isArray(parsed.entries)) { return new Map(); }
		return new Map(parsed.entries.filter(([k, v]) => typeof k === 'string' && v && typeof v.mtimeMs === 'number' && typeof v.size === 'number'));
	} catch {
		return new Map();
	}
}
