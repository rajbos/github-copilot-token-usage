/**
 * File-based session cache for the CLI.
 * Stores parsed SessionData on disk so subsequent runs skip unchanged files.
 *
 * Cache file: ~/.copilot-token-tracker/cli-cache.json
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionData } from './helpers';

/** Bump this when the SessionData shape changes to force a full re-parse. */
const CACHE_VERSION = 1;

/** Maximum number of entries to keep in the cache file. */
const MAX_CACHE_ENTRIES = 2000;

interface CacheEntry {
	/** File modification time (ms since epoch) */
	mtime: number;
	/** File size in bytes */
	size: number;
	/** Parsed session data (lastModified stored as ISO string) */
	data: Omit<SessionData, 'lastModified'> & { lastModified: string };
}

interface CacheFile {
	version: number;
	entries: Record<string, CacheEntry>;
}

const CACHE_DIR = path.join(os.homedir(), '.copilot-token-tracker');
const CACHE_PATH = path.join(CACHE_DIR, 'cli-cache.json');

let cache: Map<string, CacheEntry> = new Map();
let cacheEnabled = true;
let dirty = false;

/** Disable caching (e.g. when --no-cache is passed). */
export function disableCache(): void {
	cacheEnabled = false;
	cache.clear();
}

/** Load cache from disk. Safe to call multiple times — only loads once. */
export function loadCache(): void {
	if (!cacheEnabled) { return; }
	try {
		if (!fs.existsSync(CACHE_PATH)) { return; }
		const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
		const parsed: CacheFile = JSON.parse(raw);
		if (parsed.version !== CACHE_VERSION) {
			// Version mismatch — discard stale cache
			cache.clear();
			return;
		}
		cache = new Map(Object.entries(parsed.entries));
	} catch {
		// Corrupt / unreadable — start fresh
		cache.clear();
	}
}

/** Save cache to disk (only if entries were added/updated). */
export function saveCache(): void {
	if (!cacheEnabled || !dirty) { return; }
	try {
		// Prune to MAX_CACHE_ENTRIES, keeping the most recently modified files
		if (cache.size > MAX_CACHE_ENTRIES) {
			const sorted = [...cache.entries()].sort((a, b) => b[1].mtime - a[1].mtime);
			cache = new Map(sorted.slice(0, MAX_CACHE_ENTRIES));
		}

		fs.mkdirSync(CACHE_DIR, { recursive: true });
		const payload: CacheFile = {
			version: CACHE_VERSION,
			entries: Object.fromEntries(cache),
		};
		fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), 'utf-8');
	} catch {
		// Best-effort — don't crash the CLI if cache write fails
	}
}

/**
 * Look up a cached result for a session file.
 * Returns the SessionData if the cache entry matches the file's current mtime and size,
 * or null if the file needs to be re-parsed.
 */
export function getCached(filePath: string, mtime: number, size: number): SessionData | null {
	if (!cacheEnabled) { return null; }
	const entry = cache.get(filePath);
	if (!entry) { return null; }
	if (entry.mtime !== mtime || entry.size !== size) { return null; }
	// Rehydrate the Date
	return {
		...entry.data,
		lastModified: new Date(entry.data.lastModified),
	};
}

/** Store a parsed result in the cache. */
export function setCached(filePath: string, mtime: number, size: number, data: SessionData): void {
	if (!cacheEnabled) { return; }
	dirty = true;
	cache.set(filePath, {
		mtime,
		size,
		data: {
			...data,
			lastModified: data.lastModified.toISOString(),
		},
	});
}

/** Return cache hit/miss stats for display. */
export function getCacheStats(): { entries: number; enabled: boolean } {
	return { entries: cache.size, enabled: cacheEnabled };
}
