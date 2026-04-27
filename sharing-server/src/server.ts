import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { api } from './routes/api.js';
import { dashboard } from './routes/dashboard.js';
import { getDb, closeDb } from './db.js';

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

// Cleanly close the DB on shutdown so Azure Files SMB oplocks are released
// before the new container revision starts. This minimises lock contention
// during rolling deploys.
function shutdown(signal: string): void {
	console.log(`Received ${signal}, closing database and exiting...`);
	closeDb();
	process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// Attempt database initialisation with exponential backoff.
// Each getDb() call blocks for at most busy_timeout (5 s) so the event loop
// is only briefly blocked per attempt while the server continues serving
// health checks between retries.
async function initDbWithRetry(maxAttempts = 20): Promise<void> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			getDb();
			console.log(`[db] Initialised successfully (attempt ${attempt})`);
			return;
		} catch (err) {
			if (attempt < maxAttempts) {
				// Back off between 5 s and 30 s, giving the previous revision's
				// SMB oplock time to release (ACA rolling deploy window).
				const delay = Math.min(attempt * 5_000, 30_000);
				console.warn(`[db] Init attempt ${attempt}/${maxAttempts} failed: ${err}. Retrying in ${delay}ms…`);
				await new Promise(r => setTimeout(r, delay));
			} else {
				console.error('[db] All init attempts exhausted:', err);
			}
		}
	}
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
	const org = process.env.ALLOWED_GITHUB_ORG;
	console.log(`Token Tracker sharing server listening on port ${info.port}`);
	if (org) {
		console.log(`  Access restricted to members of GitHub org: ${org}`);
	} else {
		console.log('  Access: open to any GitHub user (set ALLOWED_GITHUB_ORG to restrict)');
	}
	// Initialise the database asynchronously so the server starts accepting
	// requests (including health checks) immediately. Individual requests
	// calling getDb() will block briefly per-attempt until the lock clears.
	initDbWithRetry();
});
