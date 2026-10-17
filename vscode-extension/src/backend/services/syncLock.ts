/**
 * Cross-instance file lock management for backend sync.
 * Prevents concurrent syncs across multiple VS Code windows.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BACKEND_SYNC_MIN_INTERVAL_MS } from '../constants';

/**
 * Manages an exclusive file-based lock so only one VS Code window
 * can run a backend sync at a time.
 */
export class SyncLock {
	/** Stale threshold for the sync lock file (matches the sync timer interval). */
	static readonly STALE_MS = BACKEND_SYNC_MIN_INTERVAL_MS;

	constructor(
		private readonly context: vscode.ExtensionContext | undefined,
		private readonly log: (msg: string) => void,
		private readonly warn: (msg: string) => void,
	) {}

	/**
	 * Try to acquire an exclusive file lock so only one VS Code window
	 * can run a backend sync at a time.
	 *
	 * `lockName` selects the lock file (see {@link SyncLock.lockPath}); callers pass one name per
	 * sync target endpoint, so independent targets never share a file. If the existing lock was written by
	 * an instance configured against a *different* server URL, the lock does not apply — both
	 * instances are syncing to independent endpoints and should not block each other.
	 */
	async acquire(lockName?: string, serverUrl?: string): Promise<boolean> {
		const ctx = this.context;
		if (!ctx) { return true; } // No context → allow (tests)
		const lockPath = SyncLock.lockPath(ctx, lockName);
		const lockContent = JSON.stringify({
			sessionId: vscode.env.sessionId,
			timestamp: Date.now(),
			serverUrl,
		});
		try {
			await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
			await fs.promises.writeFile(lockPath, lockContent, { flag: 'wx' });
			return true;
		} catch (err: any) {
			if (err.code !== 'EEXIST') {
				this.warn(`Sync lock: unexpected error acquiring lock: ${err.message}`);
				return false;
			}
			// Lock file exists — check if it belongs to a different server or is stale
			try {
				const content = await fs.promises.readFile(lockPath, 'utf-8');
				const lock = this.parseLockContent(content);
				if (!lock) {
					// Corrupt/empty lock (owner killed between atomic create and
					// write): the staleness check can never run on unparseable
					// content, so it would block every sync attempt forever.
					this.log('Sync lock: breaking corrupt lock (unparseable content)');
					return this.breakAndRewrite(lockPath, lockContent);
				}
				// Different server URL → the lock does not apply to this instance.
				if (serverUrl && lock.serverUrl && lock.serverUrl !== serverUrl) {
					this.log(`Sync lock: lock is held for a different server (${lock.serverUrl}), proceeding for ${serverUrl}`);
					return true;
				}
				if (Date.now() - lock.timestamp > SyncLock.STALE_MS) {
					this.log('Sync lock: breaking stale lock from another window');
					return this.breakAndRewrite(lockPath, lockContent);
				}
			} catch {
				// Lock file may have been deleted by its owner
			}
			return false;
		}
	}

	/**
	 * Lock file for a lock name: `backend_sync.lock` by default, else `backend_sync_<name>.lock`.
	 * Keyed by the target being written to — never by the legacy `backend.backend` selector,
	 * which says nothing about which targets a window syncs.
	 */
	private static lockPath(ctx: vscode.ExtensionContext, lockName?: string): string {
		const safeName = (lockName ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '');
		const suffix = safeName ? `_${safeName}` : '';
		return path.join(ctx.globalStorageUri.fsPath, `backend_sync${suffix}.lock`);
	}

	private parseLockContent(content: string): { sessionId?: unknown; timestamp: number; serverUrl?: string } | undefined {
		try {
			const lock = JSON.parse(content);
			if (!lock || typeof lock !== 'object' || typeof lock.timestamp !== 'number') { return undefined; }
			return lock;
		} catch {
			return undefined;
		}
	}

	private async breakAndRewrite(lockPath: string, lockContent: string): Promise<boolean> {
		try {
			await fs.promises.unlink(lockPath);
			await fs.promises.writeFile(lockPath, lockContent, { flag: 'wx' });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Whether a live (non-stale, parseable) lock at `lockName` is held by *another* window and
	 * `covers` its recorded server URL. Read-only: never creates, breaks or rewrites the file.
	 */
	async isHeldByAnotherWindow(lockName: string | undefined, covers: (lockServerUrl: string | undefined) => boolean): Promise<boolean> {
		const ctx = this.context;
		if (!ctx) { return false; }
		try {
			const lock = this.parseLockContent(await fs.promises.readFile(SyncLock.lockPath(ctx, lockName), 'utf-8'));
			if (!lock || lock.sessionId === vscode.env.sessionId) { return false; }
			if (Date.now() - lock.timestamp > SyncLock.STALE_MS) { return false; }
			return covers(lock.serverUrl);
		} catch {
			return false; // No lock file
		}
	}

	/**
	 * Release the sync lock, but only if we own it.
	 */
	async release(lockName?: string): Promise<void> {
		const ctx = this.context;
		if (!ctx) { return; }
		const lockPath = SyncLock.lockPath(ctx, lockName);
		try {
			const content = await fs.promises.readFile(lockPath, 'utf-8');
			const lock = JSON.parse(content);
			if (lock.sessionId === vscode.env.sessionId) {
				await fs.promises.unlink(lockPath);
			}
		} catch {
			// Lock file already gone or unreadable
		}
	}
}
