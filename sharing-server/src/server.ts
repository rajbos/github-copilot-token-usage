import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { api } from './routes/api.js';
import { dashboard } from './routes/dashboard.js';

const app = new Hono();

// Health check — no auth required
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// API routes (Bearer GitHub token auth)
app.route('/api', api);

// Dashboard + auth routes (session cookie)
app.route('/', dashboard);

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404));

const PORT = parseInt(process.env.PORT ?? '3000', 10);

serve({ fetch: app.fetch, port: PORT }, (info) => {
	const org = process.env.ALLOWED_GITHUB_ORG;
	console.log(`Copilot Token Tracker sharing server listening on port ${info.port}`);
	if (org) {
		console.log(`  Access restricted to members of GitHub org: ${org}`);
	} else {
		console.log('  Access: open to any GitHub user (set ALLOWED_GITHUB_ORG to restrict)');
	}
});
