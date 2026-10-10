import type { SessionFileCache } from '../../src/types';

/**
 * True when a cache entry may be served by getSessionFileDataCached(): its mtime and size
 * match the file AND it came from a full analysis. A `detailsOnly` entry (created by the
 * Details/Diagnostics path for a session never fully analyzed) carries tokens 0 and an empty
 * usage analysis, so serving it as a hit would freeze the session at zero until the file changes.
 */
export function isFullCacheHit(cached: SessionFileCache | undefined, mtime: number, size: number): cached is SessionFileCache {
	return !!cached && !cached.detailsOnly && cached.mtime === mtime && cached.size === size;
}

/**
 * Whether a cache entry written by the details-only parse is a placeholder (true) or may be
 * treated as a full entry (false). A token result does not make it full: the details path never
 * runs the full usage analysis, so the entry keeps a default usageAnalysis. It is therefore a
 * placeholder unless it inherits from an existing full entry; only a full analysis result
 * (getSessionFileDataCached()) removes the marker. Real token fields are still preserved.
 */
export function isDetailsOnlyPlaceholder(existing: SessionFileCache | undefined): boolean {
	return !existing || existing.detailsOnly === true;
}

/**
 * Full entry that replaces a same-version placeholder (equal mtime and size): keep the detail
 * metadata the details path discovered (repository attribution, workspace, title) wherever the
 * full analysis did not produce it, instead of dropping it with the placeholder.
 */
export function mergePlaceholderDetails(full: SessionFileCache, placeholder: SessionFileCache): SessionFileCache {
	return {
		...full,
		...(full.repository === undefined && placeholder.repository !== undefined ? { repository: placeholder.repository } : {}),
		...(!full.repositoryResolved && placeholder.repositoryResolved ? { repositoryResolved: true } : {}),
		...(full.workspaceFolderPath === undefined && placeholder.workspaceFolderPath !== undefined ? { workspaceFolderPath: placeholder.workspaceFolderPath } : {}),
		...(full.title === undefined && placeholder.title !== undefined ? { title: placeholder.title } : {}),
	};
}

/**
 * Entry to store when a full analysis finishes. If a concurrent details parse wrote a placeholder
 * for the same file version while the analysis was running, fold its detail metadata in so the
 * full result does not overwrite it with nothing.
 */
export function resolveFullResultAgainstCurrent(full: SessionFileCache, current: SessionFileCache | undefined): SessionFileCache {
	return current?.detailsOnly === true && current.mtime === full.mtime && current.size === full.size
		? mergePlaceholderDetails(full, current)
		: full;
}
