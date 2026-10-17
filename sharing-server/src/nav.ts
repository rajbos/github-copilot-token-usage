/**
 * Extra navigation links contributed by a downstream server.
 *
 * The built-in page headers only know about the pages this package ships. A downstream
 * server that mounts its own page via `createApp({ extend })` has no way to surface it
 * in the header, which leaves the page reachable by URL only. Registering a nav link
 * closes that gap without forking the dashboard markup.
 *
 * The provider is carried on the Hono context rather than in module state, so two apps
 * composed in one process each render their own links.
 */
import type { Context, Next } from 'hono';

/** A single header link contributed by a downstream server. */
export interface NavLink {
	/** Same-origin path, e.g. `/vendor`. Must start with a single `/`. */
	href: string;
	/** Visible link text. */
	label: string;
	/** Optional `title` attribute for a tooltip. */
	title?: string;
}

/** Context variable holding the per-app nav-link provider. */
export type NavVariables = { navExtra?: () => NavLink[] };

const NAV_EXTRA_VAR = 'navExtra';

/**
 * Middleware that publishes an app's nav-link provider on the request context.
 * `createApp` installs this; a downstream server only needs it directly when building
 * a Hono app by hand instead of through `createApp`.
 */
export function navExtraMiddleware(provider: (() => NavLink[]) | undefined) {
	return async (c: Context, next: Next): Promise<void> => {
		c.set(NAV_EXTRA_VAR, provider);
		await next();
	};
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Characters a browser strips or rewrites before parsing a URL, which is what turns an
 * apparently-rooted path into an off-origin one: a backslash normalises to `/`, and
 * tab/newline/carriage-return are removed outright. Both `/\evil.example/x` and
 * `/<LF>//evil.example` pass a naive `startsWith('/')` test yet navigate away.
 */
const NORMALIZED_AWAY = /[\u0000-\u001F\u007F\\]/;

/** Fixed base used purely to confirm a candidate href cannot escape its origin. */
const SAME_ORIGIN_BASE = 'https://nav.invalid';

/**
 * A downstream link is same-origin only. Rather than pattern-matching the schemes we
 * happen to think of, resolve the href against a fixed base and require the origin to
 * survive: an absolute URL, a protocol-relative `//host`, a `javascript:` scheme and
 * the normalisation tricks above all change the origin and are rejected.
 */
function isSafeHref(href: string): boolean {
	if (!href.startsWith('/') || href.startsWith('//')) return false;
	if (NORMALIZED_AWAY.test(href)) return false;
	try {
		return new URL(href, SAME_ORIGIN_BASE).origin === SAME_ORIGIN_BASE;
	} catch {
		return false;
	}
}

function isRenderableLink(link: NavLink): boolean {
	if (!link || typeof link !== 'object') return false;
	if (typeof link.href !== 'string' || typeof link.label !== 'string') return false;
	// An optional field still has to be a string: anything else reaches escapeHtml()
	// and throws outside the provider's try/catch, taking the page down.
	if (link.title !== undefined && typeof link.title !== 'string') return false;
	if (!isSafeHref(link.href)) {
		console.warn(`[nav] ignoring nav link with unsupported href: ${link.href}`);
		return false;
	}
	return true;
}

/**
 * Render the links registered for this app as header anchors.
 *
 * Returns an empty string when nothing is registered, so the built-in headers can
 * interpolate it unconditionally. A provider that throws is treated as contributing
 * nothing: a broken downstream hook must not take the whole dashboard down.
 *
 * @param c           The current request context.
 * @param currentPath Path of the page being rendered, used to mark the active link.
 */
export function renderNavExtra(c: Context, currentPath?: string): string {
	let links: NavLink[];
	try {
		const provider = c.get(NAV_EXTRA_VAR) as (() => NavLink[]) | undefined;
		links = provider?.() ?? [];
	} catch (err) {
		console.error('[nav] navExtra provider threw, skipping downstream links:', err);
		return '';
	}
	if (!Array.isArray(links)) return '';

	return links
		.filter(isRenderableLink)
		.map((link) => {
			const title = link.title ? ` title="${escapeHtml(link.title)}"` : '';
			const current = link.href === currentPath ? ' aria-current="page"' : '';
			return `<a href="${escapeHtml(link.href)}"${title}${current}>${escapeHtml(link.label)}</a>`;
		})
		.join('');
}
