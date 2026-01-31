import * as fs from 'fs';
import * as vscode from 'vscode';

export interface SessionFileCache {
	tokens: number;
	interactions: number;
	modelUsage: any;
	mtime: number;
	usageAnalysis?: any;
}

/**
 * SessionCacheManager handles caching of parsed session file data
 * to improve performance by avoiding re-parsing unchanged files
 */
export class SessionCacheManager {
	private sessionFileCache: Map<string, SessionFileCache> = new Map();

	constructor(
		private context: vscode.ExtensionContext,
		private log: (message: string) => void,
		private error: (message: string, error?: any) => void
	) {}

	/**
	 * Check if cached data for a file is still valid
	 */
	public isCacheValid(filePath: string, currentMtime: number): boolean {
		const cached = this.sessionFileCache.get(filePath);
		return cached !== undefined && cached.mtime === currentMtime;
	}

	/**
	 * Get cached session data for a file
	 */
	public getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.sessionFileCache.get(filePath);
	}

	/**
	 * Store session data in cache
	 */
	public setCachedSessionData(filePath: string, data: SessionFileCache): void {
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
			this.log(`Cache size limit reached, removed ${keysToDelete.length} oldest entries. Current size: ${this.sessionFileCache.size}`);
		}
	}

	/**
	 * Remove cache entries for files that no longer exist
	 */
	public clearExpiredCache(): void {
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
	 * Load cache from VS Code global state storage
	 */
	public loadCacheFromStorage(): void {
		try {
			const cacheData = this.context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache');
			if (cacheData) {
				this.sessionFileCache = new Map(Object.entries(cacheData));
				this.log(`Loaded ${this.sessionFileCache.size} cached session files from storage`);
			} else {
				this.log('No cached session files found in storage');
			}
		} catch (error) {
			this.error('Error loading cache from storage:', error);
			// Start with empty cache on error
			this.sessionFileCache = new Map();
		}
	}

	/**
	 * Save cache to VS Code global state storage
	 */
	public async saveCacheToStorage(): Promise<void> {
		try {
			// Convert Map to plain object for storage
			const cacheData = Object.fromEntries(this.sessionFileCache);
			await this.context.globalState.update('sessionFileCache', cacheData);
		} catch (error) {
			this.error('Error saving cache to storage:', error);
		}
	}

	/**
	 * Clear all cached data
	 */
	public async clearCache(): Promise<void> {
		this.sessionFileCache.clear();
		await this.context.globalState.update('sessionFileCache', undefined);
		this.log('Cache cleared');
	}

	/**
	 * Get the current cache size
	 */
	public getCacheSize(): number {
		return this.sessionFileCache.size;
	}

	/**
	 * Get all cache keys
	 */
	public getCacheKeys(): string[] {
		return Array.from(this.sessionFileCache.keys());
	}
}
