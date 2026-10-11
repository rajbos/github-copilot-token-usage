/**
 * Node filesystem implementation of the probes `groupWorkspaces()` takes.
 * Kept apart from `workspaceGrouping.ts` so the grouping rules stay pure and testable offline.
 *
 * All disk access is asynchronous and happens up front (prefetchWorkspaceGroupingProbes): the
 * grouping then reads the answers synchronously, so the extension host's event loop is never
 * blocked by `existsSync` / `readFileSync` on slow or network-mounted workspaces
 * (docs/adr/ANALYSIS-WORKER.md).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseGitRemoteUrl } from './workspaceHelpers';
import {
	workspaceProbePaths,
	type WorkspaceGitInfo,
	type WorkspaceGroupingProbes,
	type WorkspaceUsageEntry,
} from './workspaceGrouping';

/** How many filesystem checks run at once. */
const PROBE_CONCURRENCY = 16;

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
	try { return await fs.promises.readFile(filePath, 'utf8'); } catch { return undefined; }
}

async function pathExistsAsync(filePath: string): Promise<boolean> {
	try { await fs.promises.access(filePath); return true; } catch { return false; }
}

async function forEachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	for (let i = 0; i < items.length; i += PROBE_CONCURRENCY) {
		await Promise.all(items.slice(i, i + PROBE_CONCURRENCY).map(fn));
	}
}

/**
 * Read a folder's git setup without spawning git:
 *  - `<folder>/.git` directory → remote from `.git/config`;
 *  - `<folder>/.git` file (`gitdir: <main>/.git/worktrees/<name>`) → the main checkout's folder
 *    and the remote from `<main>/.git/config`.
 * Only the folder itself is inspected (no walking up), so a sub-folder of a repo reports nothing.
 */
export async function readWorkspaceGitInfo(folderPath: string): Promise<WorkspaceGitInfo | undefined> {
	const dotGit = path.join(folderPath, '.git');
	let stat: fs.Stats;
	try { stat = await fs.promises.stat(dotGit); } catch { return undefined; }
	if (stat.isDirectory()) {
		const config = await readFileOrUndefined(path.join(dotGit, 'config'));
		return config ? { remote: parseGitRemoteUrl(config) } : undefined;
	}
	const pointer = (await readFileOrUndefined(dotGit))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
	if (!pointer) { return undefined; }
	const gitdir = path.resolve(folderPath, pointer);
	const worktreesDir = path.dirname(gitdir);
	if (path.basename(worktreesDir).toLowerCase() !== 'worktrees') { return undefined; }
	const mainGitDir = path.dirname(worktreesDir);
	const config = await readFileOrUndefined(path.join(mainGitDir, 'config'));
	return {
		remote: config ? parseGitRemoteUrl(config) : undefined,
		// `<main>/.git` → `<main>`; a bare repo's git dir has no checkout to point at.
		mainWorktreePath: path.basename(mainGitDir).toLowerCase() === '.git' ? path.dirname(mainGitDir) : undefined,
	};
}

/**
 * Check, asynchronously, everything `groupWorkspaces()` can ask about these entries, and
 * return probes that answer from those results. A path that was not prefetched reads as
 * "does not exist", which the grouping already treats as the safe default.
 */
export async function prefetchWorkspaceGroupingProbes(
	entries: WorkspaceUsageEntry[],
	platform: string = process.platform,
	homeDirectory: string = os.homedir(),
): Promise<WorkspaceGroupingProbes> {
	const exists = new Map<string, boolean>();
	const gitInfo = new Map<string, WorkspaceGitInfo>();
	const check = async (p: string): Promise<void> => {
		if (!exists.has(p)) { exists.set(p, await pathExistsAsync(p)); }
	};
	const paths = workspaceProbePaths(entries, platform, homeDirectory);
	await forEachLimited(paths, check);
	// Git facts for every existing folder the grouping may consult: the inputs and the checkout
	// anchors their worktree layouts point at (an anchor's own remote feeds the veto). The
	// `<repo>/.git` paths are only existence checks.
	const folders = paths.filter(p => exists.get(p) && path.basename(p).toLowerCase() !== '.git');
	await forEachLimited(folders, async p => {
		const info = await readWorkspaceGitInfo(p);
		if (!info) { return; }
		gitInfo.set(p, info);
		if (info.mainWorktreePath) { await check(info.mainWorktreePath); }
	});
	return {
		platform,
		homeDirectory,
		pathExists: p => exists.get(p) ?? false,
		readGitInfo: p => gitInfo.get(p),
	};
}
