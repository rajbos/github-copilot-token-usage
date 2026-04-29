import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { api } from './routes/api.js';
import { dashboard } from './routes/dashboard.js';
import { getDb, closeDb, restoreFromBackup, backupToAzureFiles, syncAdminLogins } from './db.js';

const app = new Hono();

// Health check — no auth required
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// API routes (Bearer GitHub token auth)
app.route('/api', api);

// Dashboard + auth routes (session cookie)
app.route('/', dashboard);

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Log unhandled errors so they appear in container logs (ACA / Docker)
app.onError((err, c) => {
	console.error(`[${new Date().toISOString()}] Unhandled error on ${c.req.method} ${c.req.path}:`, err);
	return c.text('Internal Server Error', 500);
});

// Backup DB to Azure Files then close cleanly on shutdown.
// Azure Files is the persistence layer; SQLite runs on local container disk.
function shutdown(signal: string): void {
	console.log(`Received ${signal}, backing up database and exiting...`);
	backupToAzureFiles();
	closeDb();
	process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

async function initDbWithRetry(maxAttempts = 20): Promise<void> {
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

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main(): Promise<void> {
	// Restore database from Azure Files backup before opening SQLite.
	// SQLite runs on local container disk (/tmp/db) to avoid Azure Files SMB
	// locking issues. Azure Files is used only as a backup/restore store.
	restoreFromBackup();
	await initDbWithRetry();
	syncAdminLogins();
	// Periodic backup every 5 minutes in case of unexpected SIGKILL.
	setInterval(() => backupToAzureFiles(), 5 * 60 * 1000).unref();

	const org = process.env.ALLOWED_GITHUB_ORG;
	const adminLogins = process.env.ADMIN_GITHUB_LOGINS;
	serve({ fetch: app.fetch, port: PORT }, (info) => {
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

main().catch(err => {
	console.error('Fatal startup error:', err);
	process.exit(1);
});
