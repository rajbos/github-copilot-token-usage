import * as path from 'path';

import { resolveFileUri } from '../workspacePathResolver';

/**
 * Normalize a filesystem path to forward slashes.
 * Use this before doing platform-agnostic path comparisons or splitting.
 */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Backward-compatible alias for callers that only need separator normalization.
 */
export const normalizePathSeparators = normalizePath;

/**
 * Convert a normalized path back to the current platform's native separators.
 */
export function toPlatformPath(p: string): string {
	return path.sep === '/'
		? normalizePath(p)
		: normalizePath(p).replace(/\//g, path.sep);
}

/**
 * Split a path into non-empty segments after normalizing separators.
 */
export function splitNormalizedPath(p: string): string[] {
	return normalizePath(p).split('/').filter(segment => segment.length > 0);
}

/**
 * Normalize a filesystem path for case-insensitive substring/prefix matching.
 */
export function normalizePathForComparison(p: string): string {
	return normalizePath(p).toLowerCase();
}

/**
 * The lower-cased, forward-slash prefix that `path.join(dir, child)` puts in front of
 * `child`, for matching paths an adapter built by joining onto `dir`. Unlike
 * `normalizePathForComparison(dir) + '/'` this agrees with `path.join` on the edge
 * cases: `'.'` gives `''` (join drops the `./`) and `'/'` gives `'/'` (not `'//'`).
 */
export function joinedChildPrefixForComparison(dir: string): string {
	return normalizePathForComparison(path.join(dir, 'x')).slice(0, -1);
}

/**
 * Normalize a filesystem path for deduplication across adapters.
 */
export function normalizePathForDedup(
	p: string,
	platform: NodeJS.Platform = process.platform as NodeJS.Platform
): string {
	const normalized = normalizePath(p);
	return platform === 'linux' ? normalized : normalized.toLowerCase();
}

/**
 * Collapses `entries` to at most one per normalizePathForDedup() key, keeping whichever value
 * has the greater `getValue()` (typically an mtime) for a given key. A single logical resource
 * (a session file, a cache entry) can be recorded more than once under raw-string keys that
 * differ only in separator/case — e.g. two Windows spellings of the same path — and any caller
 * that reads such a keyed collection directly, rather than through a path-identity-aware lookup,
 * must dedupe through this first or it will double-count that resource.
 */
export function dedupeByNormalizedKeyKeepGreatest<T>(
	entries: Iterable<[string, T]>,
	getValue: (value: T) => number,
	platform: NodeJS.Platform = process.platform as NodeJS.Platform
): [string, T][] {
	const winners = new Map<string, [string, T]>();
	for (const [key, value] of entries) {
		// A persisted snapshot is just parsed JSON — a corrupt/malformed record (e.g. a null
		// entry, or one with a missing/non-numeric score field) must not crash this whole pass,
		// nor silently win its normalized key over a usable duplicate: `undefined > 123` and
		// `NaN > 123` are both false, so an invalid first-seen record would otherwise block every
		// later, valid record under the same key from ever replacing it. Skip it instead, the same
		// way callers already skip an unusable entry when iterating the cache directly.
		if (value === null || value === undefined) { continue; }
		const score = getValue(value);
		if (!Number.isFinite(score)) { continue; }
		const normalizedKey = normalizePathForDedup(key, platform);
		const existing = winners.get(normalizedKey);
		if (!existing || score > getValue(existing[1])) {
			winners.set(normalizedKey, [key, value]);
		}
	}
	return Array.from(winners.values());
}

/**
 * Normalize a session workspace path up to its parent repository root by stripping a trailing
 * agent-worktree segment created by Copilot CLI, Claude Code, or the Copilot App:
 *   "<home>/.copilot/copilot-worktrees/<repo>[/...]" -> "<home>/.copilot/copilot-worktrees/<repo>"
 *   "<repo>/copilot-worktrees/<name>[/...]"      -> "<repo>"
 *   "<repo>/.claude/worktrees/<name>[/...]"       -> "<repo>"
 *   "<parent>/<repo>.worktrees/<name>[/...]"      -> "<parent>/<repo>"
 * The last form is the Copilot App's own default (and a common convention used by its
 * customizable "Worktree location" setting, added in v1.1.4 - see
 * https://github.com/github/app/releases/tag/v1.1.4); since that setting is a free-form path
 * template, this only recognizes the "<repo>.worktrees" naming rather than every possible value.
 * This lets the worktree scanner cover the whole repo (finding sibling worktrees) instead of a
 * single worktree subfolder. The original path is returned unchanged when no pattern matches,
 * and the input's separator style is preserved.
 */
export function normalizeToRepoRoot(p: string): string {
	const appStore = p.match(/^(.+?[\\/]\.copilot[\\/]copilot-worktrees[\\/][^\\/]+)(?:[\\/].*)?$/i);
	if (appStore) { return appStore[1]; }
	const copilot = p.match(/^(.+?)[\\/]copilot-worktrees[\\/][^\\/]+(?:[\\/].*)?$/i);
	if (copilot) { return copilot[1]; }
	const claude = p.match(/^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/i);
	if (claude) { return claude[1]; }
	const dotWorktrees = p.match(/^(.+?)([\\/])([^\\/]+?)\.worktrees\2[^\\/]+(?:\2.*)?$/i);
	if (dotWorktrees) { return `${dotWorktrees[1]}${dotWorktrees[2]}${dotWorktrees[3]}`; }
	return p;
}

/**
 * Derive a repository display name from a session's workspace/cwd path.
 *
 * Multiple agent-worktree layouts exist and place the repo folder on opposite sides of
 * the "copilot-worktrees" marker, or fold it into the marker segment itself:
 *   - Copilot CLI app store:  "<home>/.copilot/copilot-worktrees/<repo>/<worktree>[/...]" -> "<repo>"
 *     (the repo folder comes *after* the marker)
 *   - User-repo / Claude:     "<repo>/copilot-worktrees/<name>[/...]"                     -> "<repo>"
 *     "<repo>/.claude/worktrees/<name>[/...]"                                             -> "<repo>"
 *     (the repo folder comes *before* the marker; handled by normalizeToRepoRoot)
 *   - Copilot App:            "<parent>/<repo>.worktrees/<name>[/...]"                    -> "<repo>"
 *     (the repo folder name has the marker as a suffix; handled by normalizeToRepoRoot)
 *
 * Using a plain path.basename() on an app-store worktree path yields the worktree
 * name (e.g. "rajbos-supreme-carnival") instead of the repository — this helper
 * returns the repository folder name instead. Falls back to the last path segment.
 */
export function getRepoNameFromWorkspacePath(p: string): string {
	const segments = splitNormalizedPath(p);
	const lower = segments.map(s => s.toLowerCase());
	const wtIdx = lower.lastIndexOf('copilot-worktrees');
	// App-store layout: repo folder is the segment right after the marker, which is
	// itself nested directly under the ".copilot" store directory.
	if (wtIdx > 0 && lower[wtIdx - 1] === '.copilot' && wtIdx + 1 < segments.length) {
		return segments[wtIdx + 1];
	}
	const rootSegments = splitNormalizedPath(normalizeToRepoRoot(p));
	return rootSegments.length > 0 ? rootSegments[rootSegments.length - 1] : path.basename(p);
}

/**
 * Strip the synthetic leading slash from Windows drive-letter URI paths.
 * Example: "/C:/repo/file.ts" -> "C:/repo/file.ts".
 */
export function stripWindowsDriveUriPrefix(
	rawPath: string,
	platform: NodeJS.Platform = process.platform as NodeJS.Platform
): string {
	return platform === 'win32' && /^\/[a-zA-Z]:/.test(rawPath)
		? rawPath.substring(1)
		: rawPath;
}

/**
 * Returns true when the path segment looks like a Windows drive root ("C:").
 */
export function hasWindowsDriveSegment(
	segment: string | undefined,
	platform: NodeJS.Platform = process.platform as NodeJS.Platform
): boolean {
	return platform === 'win32' && /^[a-zA-Z]:$/.test(segment ?? '');
}

/**
 * Convert a file:// URI to a plain filesystem path.
 *
 * Non-file strings are returned unchanged.
 */
export function fileUriToPath(uri: string): string {
	if (!uri.startsWith('file://')) { return uri; }
	const normalized = uri.replace(/^file:\/\/localhost(\/|$)/, 'file:///');
	return resolveFileUri(normalized) ?? uri;
}
