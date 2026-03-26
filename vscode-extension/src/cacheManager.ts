/**
 * Session file cache management.
 * Handles persistent caching of parsed session data to avoid re-reading files.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionFileCache } from './types';

export interface CacheManagerDeps {
	log: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
}

export class CacheManager {
	private sessionFileCache: Map<string, SessionFileCache> = new Map();
	private readonly context: vscode.ExtensionContext;
	private readonly deps: CacheManagerDeps;
	private readonly cacheVersion: number;

	constructor(context: vscode.ExtensionContext, deps: CacheManagerDeps, cacheVersion: number) {
		this.context = context;
		this.deps = deps;
		this.cacheVersion = cacheVersion;
	}

	get cache(): Map<string, SessionFileCache> {
		return this.sessionFileCache;
	}

	// Cache management methods
	/**
	 * Checks if the cache is valid for a file by comparing mtime and size.
	 * If the cache entry is missing size (old format), treat as invalid so it will be upgraded.
	 */
	isCacheValid(filePath: string, currentMtime: number, currentSize: number): boolean {
		const cached = this.sessionFileCache.get(filePath);
		if (!cached) {
			return false;
		}
		// If size is missing (old cache), treat as invalid so it will be upgraded
		if (typeof cached.size !== 'number') {
			return false;
		}
		return cached.mtime === currentMtime && cached.size === currentSize;
	}

	getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.sessionFileCache.get(filePath);
	}

	/**
	 * Sets the cache entry for a session file, including file size.
	 */
	setCachedSessionData(filePath: string, data: SessionFileCache, fileSize?: number): void {
		if (typeof fileSize === 'number') {
			data.size = fileSize;
		}
		this.sessionFileCache.set(filePath, data);

		// Limit cache size to prevent memory issues (keep last 1000 files)
		// Only trigger cleanup when size exceeds limit by 100 to avoid frequent operations
		if (this.sessionFileCache.size > 1100) {
			// Remove 100 oldest entries to bring size back to 1000
			// Maps maintain insertion order, so the first entries are the oldest
			const keysToDelete: string[] = [];
			let count = 0;
			for (const key of this.sessionFileCache.keys()) {
				keysToDelete.push(key);
				count++;
				if (count >= 100) {
					break;
				}
			}
			for (const key of keysToDelete) {
				this.sessionFileCache.delete(key);
			}
			this.deps.log(`Cache size limit reached, removed ${keysToDelete.length} oldest entries. Current size: ${this.sessionFileCache.size}`);
		}
	}

	clearExpiredCache(): void {
		// Remove cache entries for files that no longer exist
		const filesToCheck = Array.from(this.sessionFileCache.keys());
		for (const filePath of filesToCheck) {
			try {
				if (!fs.existsSync(filePath)) {
					this.sessionFileCache.delete(filePath);
				}
			} catch (error) {
				// File access error, remove from cache
				this.sessionFileCache.delete(filePath);
			}
		}
	}

	/**
	 * Generate a cache identifier based on VS Code extension mode.
	 * VS Code editions (stable vs insiders) already have separate globalState storage,
	 * so we only need to distinguish between production and development (debug) mode.
	 * In development mode, each VS Code window gets a unique cache identifier using
	 * the session ID, preventing the Extension Development Host from sharing/fighting
	 * with the main dev window's cache.
	 */
	getCacheIdentifier(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			// Use a short hash of the session ID to keep the key short but unique per window
			const sessionId = vscode.env.sessionId;
			const hash = sessionId.substring(0, 8);
			return `dev-${hash}`;
		}
		return 'prod';
	}

	/**
	 * Get the path for the cache lock file.
	 * Uses globalStorageUri which is already scoped per VS Code edition.
	 */
	getCacheLockPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `cache_${cacheId}.lock`);
	}

	/**
	 * Acquire an exclusive file lock for cache writes.
	 * Uses atomic file creation (O_EXCL / CREATE_NEW) to prevent concurrent writes
	 * across multiple VS Code windows of the same edition.
	 * Returns true if lock acquired, false if another instance holds it.
	 */
	async acquireCacheLock(): Promise<boolean> {
		const lockPath = this.getCacheLockPath();
		try {
			// Ensure the directory exists
			await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

			// Atomic exclusive create — fails if lock file already exists
			const fd = await fs.promises.open(lockPath, 'wx');
			await fd.writeFile(JSON.stringify({
				sessionId: vscode.env.sessionId,
				timestamp: Date.now()
			}));
			await fd.close();
			return true;
		} catch (err: any) {
			if (err.code !== 'EEXIST') {
				// Unexpected error (permissions, disk full, etc.)
				this.deps.warn(`Unexpected error acquiring cache lock: ${err.message}`);
				return false;
			}

			// Lock file exists — check if it's stale (owner crashed)
			try {
				const content = await fs.promises.readFile(lockPath, 'utf-8');
				const lock = JSON.parse(content);
				const staleThreshold = 5 * 60 * 1000; // 5 minutes (matches update interval)

				if (Date.now() - lock.timestamp > staleThreshold) {
					// Stale lock — break it and retry once
					this.deps.log('Breaking stale cache lock');
					await fs.promises.unlink(lockPath);
					try {
						const fd = await fs.promises.open(lockPath, 'wx');
						await fd.writeFile(JSON.stringify({
							sessionId: vscode.env.sessionId,
							timestamp: Date.now()
						}));
						await fd.close();
						return true;
					} catch {
						return false; // Another instance beat us to it
					}
				}
			} catch {
				// Can't read lock file — might have been deleted by the owner already
			}
			return false;
		}
	}

	/**
	 * Release the cache lock file, but only if we own it.
	 */
	async releaseCacheLock(): Promise<void> {
		const lockPath = this.getCacheLockPath();
		try {
			const content = await fs.promises.readFile(lockPath, 'utf-8');
			const lock = JSON.parse(content);
			if (lock.sessionId === vscode.env.sessionId) {
				await fs.promises.unlink(lockPath);
			}
		} catch {
			// Lock file already gone or unreadable — nothing to do
		}
	}

	// Persistent cache storage methods
	loadCacheFromStorage(): void {
		try {
			const cacheId = this.getCacheIdentifier();
			const versionKey = `sessionFileCacheVersion_${cacheId}`;
			const cacheKey = `sessionFileCache_${cacheId}`;
			
			// One-time migration: clean up old per-session cache keys from previous versions
			this.migrateOldCacheKeys(cacheId);
			
			// Check cache version first
			const storedVersion = this.context.globalState.get<number>(versionKey);
			if (storedVersion !== this.cacheVersion) {
				this.deps.log(`Cache version mismatch (stored: ${storedVersion}, current: ${this.cacheVersion}) for ${cacheId}. Clearing cache.`);
				this.sessionFileCache = new Map();
				return;
			}

			const cacheData = this.context.globalState.get<Record<string, SessionFileCache>>(cacheKey);
			if (cacheData) {
				this.sessionFileCache = new Map(Object.entries(cacheData));
				this.deps.log(`Loaded ${this.sessionFileCache.size} cached session files from storage (${cacheId})`);
			} else {
				this.deps.log(`No cached session files found in storage for ${cacheId}`);
			}
		} catch (error) {
			this.deps.error(`Error loading cache from storage: ${error}`);
			// Start with empty cache on error
			this.sessionFileCache = new Map();
		}
	}

	/**
	 * One-time migration: remove old per-session cache keys that were created by
	 * earlier versions of the extension (keys containing sessionId or timestamp).
	 * Also removes the legacy unscoped keys ('sessionFileCache', 'sessionFileCacheVersion').
	 */
	migrateOldCacheKeys(currentCacheId: string): void {
		try {
			const allKeys = this.context.globalState.keys();
			const currentCacheKey = `sessionFileCache_${currentCacheId}`;
			const currentVersionKey = `sessionFileCacheVersion_${currentCacheId}`;
			
			let removedCount = 0;
			for (const key of allKeys) {
				// Remove old timestamp keys (no longer used)
				if (key.startsWith('sessionFileCacheTimestamp_')) {
					this.context.globalState.update(key, undefined);
					removedCount++;
					continue;
				}
				// Remove old per-session cache keys that have session IDs embedded
				// (they contain more than one underscore-separated segment after the prefix)
				if (key.startsWith('sessionFileCache_') && key !== currentCacheKey) {
					const suffix = key.replace('sessionFileCache_', '');
					if (suffix !== 'dev' && suffix !== 'prod') {
						this.context.globalState.update(key, undefined);
						removedCount++;
					}
				}
				if (key.startsWith('sessionFileCacheVersion_') && key !== currentVersionKey) {
					const suffix = key.replace('sessionFileCacheVersion_', '');
					if (suffix !== 'dev' && suffix !== 'prod') {
						this.context.globalState.update(key, undefined);
						removedCount++;
					}
				}
				// Remove legacy unscoped keys from the original code
				if (key === 'sessionFileCache' || key === 'sessionFileCacheVersion') {
					this.context.globalState.update(key, undefined);
					removedCount++;
				}
			}
			
			if (removedCount > 0) {
				this.deps.log(`Migrated: removed ${removedCount} old cache keys from globalState`);
			}
		} catch (error) {
			this.deps.error(`Error migrating old cache keys: ${error}`);
		}
	}

	async saveCacheToStorage(): Promise<void> {
		const acquired = await this.acquireCacheLock();
		if (!acquired) {
			this.deps.log('Cache lock held by another VS Code window, skipping save');
			return;
		}
		try {
			const cacheId = this.getCacheIdentifier();
			const versionKey = `sessionFileCacheVersion_${cacheId}`;
			const cacheKey = `sessionFileCache_${cacheId}`;
			
			// Convert Map to plain object for storage
			const cacheData = Object.fromEntries(this.sessionFileCache);
			await this.context.globalState.update(cacheKey, cacheData);
			await this.context.globalState.update(versionKey, this.cacheVersion);
			this.deps.log(`Saved ${this.sessionFileCache.size} cached session files to storage (version ${this.cacheVersion}, ${cacheId})`);
		} catch (error) {
			this.deps.error(`Error saving cache to storage: ${error}`);
		} finally {
			await this.releaseCacheLock();
		}
	}
}
