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

// Eagerly initialise the database before accepting requests.
// If Azure Files has a stale SMB oplock from a previous revision, this blocks
// here (up to busy_timeout = 60 s) rather than failing on the first user request.
try {
	getDb();
	console.log('Database initialised');
} catch (err) {
	console.error('Database initialisation failed at startup:', err);
	// Continue — individual requests will retry and surface the error cleanly.
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
	const org = process.env.ALLOWED_GITHUB_ORG;
	console.log(`Token Tracker sharing server listening on port ${info.port}`);
	if (org) {
		console.log(`  Access restricted to members of GitHub org: ${org}`);
	} else {
		console.log('  Access: open to any GitHub user (set ALLOWED_GITHUB_ORG to restrict)');
	}
});
