import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { api } from './routes/api.js';
import { dashboard } from './routes/dashboard.js';
import { navExtraMiddleware, type NavLink } from './nav.js';

export interface CreateAppOptions {
	/**
	 * Called before any built-in route is mounted. Because Hono resolves routes in
	 * registration order, anything registered here takes precedence over every
	 * built-in route (`/health`, `/icon.png`, `/api` and the dashboard) — which is how
	 * a downstream server overrides a page or an endpoint without forking this package.
	 */
	extend?: (app: Hono) => void;
	/** Extra fields merged into the `/health` response, e.g. a downstream version stamp. */
	healthExtra?: () => Record<string, unknown>;
	/**
	 * Extra links appended to the built-in page headers, so a page mounted through
	 * `extend` is reachable from the UI instead of by URL only. Called on each render,
	 * so the list can vary per deployment. Scoped to this app, and only same-origin
	 * paths are accepted.
	 */
	navExtra?: () => NavLink[];
	/** Mount the built-in `/api` routes. Default: true. */
	mountApi?: boolean;
	/** Mount the built-in dashboard and OAuth routes. Default: true. */
	mountDashboard?: boolean;
	/**
	 * Directory holding static assets such as `icon.png`. Defaults to the `images/`
	 * folder next to the bundle. A downstream server that bundles to its own `dist/`
	 * can point this at the OSS package's copy.
	 */
	imagesDir?: string;
}

/**
 * Build the sharing-server Hono application.
 *
 * Exported so downstream servers (e.g. a vendor-specific deployment) can compose extra
 * routes and tables on top of this one instead of maintaining a fork:
 *
 * ```ts
 * const app = createApp({ extend: (a) => a.route('/api/vendor', vendorRoutes) });
 * await startServer(app);
 * ```
 */
export function createApp(options: CreateAppOptions = {}): Hono {
	const app = new Hono();

	// Publishes this app's nav links on every request context, so pages registered
	// through `extend` can render them too. Middleware only decorates the context, so
	// it does not affect the extend-before-builtins precedence below.
	app.use('*', navExtraMiddleware(options.navExtra));

	// Registered first so downstream routes take precedence over every built-in
	// route below — Hono resolves in registration order.
	options.extend?.(app);

	// Serve the product icon used by the dashboard header. The icon is copied into
	// dist/images/ at build time so the bundled server remains self-contained.
	const iconPath = path.join(options.imagesDir ?? path.join(__dirname, 'images'), 'icon.png');
	app.get('/icon.png', (c) => {
		if (!fs.existsSync(iconPath)) {
			return c.body('Icon not found', 404, { 'Content-Type': 'text/plain' });
		}
		const icon = fs.readFileSync(iconPath);
		return c.body(icon, 200, {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=86400',
		});
	});

	// Health check — no auth required
	app.get('/health', (c) => c.json({
		status: 'ok',
		timestamp: new Date().toISOString(),
		version: {
			sha:    process.env.DEPLOY_SHA    ?? 'unknown',
			branch: process.env.DEPLOY_BRANCH ?? 'unknown',
			date:   process.env.DEPLOY_DATE   ?? 'unknown',
		},
		...(options.healthExtra?.() ?? {}),
	}));

	// API routes (bearer token auth)
	if (options.mountApi !== false) {
		app.route('/api', api);
	}

	// Dashboard + auth routes (session cookie)
	if (options.mountDashboard !== false) {
		app.route('/', dashboard);
	}

	// 404 fallback
	app.notFound((c) => c.json({ error: 'Not found' }, 404));

	// Log unhandled errors so they appear in container logs (ACA / Docker)
	app.onError((err, c) => {
		console.error(`[${new Date().toISOString()}] Unhandled error on ${c.req.method} ${c.req.path}:`, err);
		return c.text('Internal Server Error', 500);
	});

	return app;
}
