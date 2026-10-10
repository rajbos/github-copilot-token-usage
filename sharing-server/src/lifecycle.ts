import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { getDb, closeDb, restoreFromBackup, backupToAzureFiles, syncAdminLogins } from './db.js';
import { BACKUP_INTERVAL_MS } from './config.js';
import { assertSessionSecretConfigured } from './session.js';

export interface StartServerOptions {
	/** Port to listen on. Defaults to `PORT` env var, then 3000. */
	port?: number;
	/** Interval between Azure Files backups in ms. Defaults to `BACKUP_INTERVAL_MS`. Set to 0 to disable. */
	backupIntervalMs?: number;
	/** Extra work to run after the database is initialised but before listening. */
	onReady?: () => void | Promise<void>;
}

/** Open the database, retrying with backoff — Azure Files restore can lag behind container start. */
export async function initDbWithRetry(maxAttempts = 20): Promise<void> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			getDb();
			console.log(`[db] Initialised successfully (attempt ${attempt})`);
			return;
		} catch (err) {
			if (attempt < maxAttempts) {
				const delay = Math.min(attempt * 5_000, 30_000);
				console.warn(`[db] Init attempt ${attempt}/${maxAttempts} failed: ${err}. Retrying in ${delay}ms…`);
				await new Promise(r => setTimeout(r, delay));
			} else {
				console.error('[db] All init attempts exhausted:', err);
				throw err;
			}
		}
	}
}

/**
 * Back up the DB to Azure Files then close cleanly on SIGTERM/SIGINT.
 *
 * Idempotent: as a library this may be called both by a downstream app and by
 * `startServer`, and registering twice would double-run the backup on shutdown and
 * leak listeners (`MaxListenersExceededWarning`) across multiple servers in a test run.
 */
let shutdownHandlersRegistered = false;

export function registerShutdownHandlers(): void {
	if (shutdownHandlersRegistered) {
		return;
	}
	shutdownHandlersRegistered = true;

	function shutdown(signal: string): void {
		console.log(`Received ${signal}, backing up database and exiting...`);
		backupToAzureFiles();
		closeDb();
		process.exit(0);
	}
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT',  () => shutdown('SIGINT'));
}

/**
 * Boot the full server lifecycle: restore backup, open the database, register shutdown
 * handlers and start listening. Downstream servers call this with their own composed app.
 */
export async function startServer(app: Hono, options: StartServerOptions = {}): Promise<void> {
	// Fail fast, before touching the database or listening, on an unusable production secret.
	assertSessionSecretConfigured();

	const port = options.port ?? parseInt(process.env.PORT ?? '3000', 10);

	registerShutdownHandlers();

	// Restore database from Azure Files backup before opening SQLite.
	// SQLite runs on local container disk (/tmp/db) to avoid Azure Files SMB
	// locking issues. Azure Files is used only as a backup/restore store.
	restoreFromBackup();
	await initDbWithRetry();
	syncAdminLogins();

	const backupIntervalMs = options.backupIntervalMs ?? BACKUP_INTERVAL_MS;
	if (backupIntervalMs > 0) {
		// Periodic backup in case of unexpected SIGKILL.
		setInterval(() => backupToAzureFiles(), backupIntervalMs).unref();
	}

	await options.onReady?.();

	const org = process.env.ALLOWED_GITHUB_ORG;
	const adminLogins = process.env.ADMIN_GITHUB_LOGINS;
	serve({ fetch: app.fetch, port }, (info) => {
		console.log(`Token Tracker sharing server listening on port ${info.port}`);
		if (org) {
			console.log(`  Access restricted to members of GitHub org: ${org}`);
		} else {
			console.log('  Access: open to any GitHub user (set ALLOWED_GITHUB_ORG to restrict)');
		}
		if (adminLogins) {
			console.log(`  Admin logins (ADMIN_GITHUB_LOGINS): ${adminLogins}`);
		}
	});
}
