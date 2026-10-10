import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import {
	encodeSession, decodeSession, makeClaims,
	COOKIE_NAME, OAUTH_STATE_COOKIE, SESSION_MAX_AGE,
} from '../session.js';
import {
	getUserById, getUserByGithubId, getUploadsForUser, upsertUser,
	getAdminUserSummaries, getAdminDailyTotals, isConfiguredAdminLogin,
	type UploadRow, type UserRow, type UserUsageSummary, type AdminDailyRow,
} from '../db.js';
import { OAUTH_STATE_MAX_AGE_SECONDS } from '../config.js';
import { getTeamInsights, parseTeamDays } from '../teamInsights.js';
import { renderTeamInsights, teamInsightsCsv } from './teamPage.js';
import { renderNavExtra } from '../nav.js';
export const dashboard = new Hono();

dashboard.use('*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store');
	await next();
});

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const DEPLOY_SHA    = process.env.DEPLOY_SHA    ?? 'unknown';
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH ?? 'unknown';
const DEPLOY_DATE   = process.env.DEPLOY_DATE   ?? 'unknown';
const { version: packageVersion } = require('../../package.json') as { version: string };

// Load Chart.js UMD bundle once at startup.
// Bundled build: esbuild.js copies it next to dist/server.js.
// Library build: locate chart.js through Node's own resolution, since a downstream
// server consuming this package has its own dist/ layout and may run from any cwd.

/**
 * Resolve chart.js's UMD bundle via Node module resolution.
 *
 * chart.js ships an `exports` map that refuses both `chart.js/dist/*` and
 * `chart.js/package.json`, so neither can be resolved directly. The package root
 * *is* resolvable though, so we resolve that and walk to its sibling UMD file.
 * Resolution starts from this module's location, which means it finds chart.js
 * whether it is a direct dependency or hoisted into a parent node_modules — and,
 * unlike a cwd-based guess, it does not depend on where the process was started.
 */
function resolveChartJsUmd(): string | undefined {
	try {
		const require_ = createRequire(__filename);
		// e.g. <root>/node_modules/chart.js/dist/chart.cjs → <root>/node_modules/chart.js/dist
		return join(dirname(require_.resolve('chart.js')), 'chart.umd.min.js');
	} catch {
		return undefined;
	}
}

const _chartJsCode: string = (() => {
	const candidates = [
		process.env.CHART_JS_PATH,
		join(__dirname, 'chart.min.js'),
		join(__dirname, '..', 'chart.min.js'),
		resolveChartJsUmd(),
	].filter((p): p is string => Boolean(p));

	for (const candidate of candidates) {
		try {
			return readFileSync(candidate, 'utf-8');
		} catch { /* try next candidate */ }
	}
	console.warn(
		'[dashboard] Chart.js not found — charts will not render. ' +
		'Run `npm run build` in sharing-server/, or if you are consuming this package as a ' +
		'library, install the optional peer dependency (`npm install chart.js`) or point ' +
		'CHART_JS_PATH at a chart.umd.min.js file.',
	);
	return '/* chart.js not found — see the server log for how to provide it */';
})();

// ── Auth ─────────────────────────────────────────────────────────────────────

/** GET /auth/github — Start GitHub OAuth for the web dashboard. */
dashboard.get('/auth/github', (c) => {
	if (!GITHUB_CLIENT_ID) {
		return c.html(errorPage('GitHub OAuth is not configured on this server.'), 503);
	}
	const state = randomState();
	const params = new URLSearchParams({
		client_id: GITHUB_CLIENT_ID,
		redirect_uri: `${BASE_URL}/auth/github/callback`,
		scope: 'read:user',
		state,
	});
	// Bind state to a short-lived cookie for CSRF validation
	setCookie(c, OAUTH_STATE_COOKIE, state, {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'Lax',
		maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
		path: '/',
	});
	return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

/** GET /auth/github/callback — GitHub OAuth callback. */
dashboard.get('/auth/github/callback', async (c) => {
	const code = c.req.query('code');
	const state = c.req.query('state');
	const storedState = getCookie(c, OAUTH_STATE_COOKIE);

	// Validate CSRF state
	deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
	if (!code || !state || !storedState || state !== storedState) {
		return c.html(errorPage('Invalid or expired authentication state. Please try again.'), 400);
	}

	// Exchange code for access token
	let accessToken: string;
	try {
		const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({
				client_id: GITHUB_CLIENT_ID,
				client_secret: GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: `${BASE_URL}/auth/github/callback`,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
		if (!tokenData.access_token) {
			return c.html(errorPage(`GitHub OAuth error: ${tokenData.error ?? 'no token returned'}`), 400);
		}
		accessToken = tokenData.access_token;
	} catch (err) {
		return c.html(errorPage(`Failed to reach GitHub: ${String(err)}`), 502);
	}

	// Fetch user profile
	let userData: { id: number; login: string; name: string | null; avatar_url: string };
	try {
		const userRes = await fetch('https://api.github.com/user', {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'User-Agent': 'copilot-sharing-server/1.0',
				Accept: 'application/vnd.github+json',
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!userRes.ok) {
			return c.html(errorPage('Failed to retrieve GitHub profile.'), 502);
		}
		userData = await userRes.json() as typeof userData;
	} catch (err) {
		return c.html(errorPage(`Failed to reach GitHub: ${String(err)}`), 502);
	}

	// Optional org membership check
	const allowedOrg = process.env.ALLOWED_GITHUB_ORG;
	if (allowedOrg) {
		// Prefer a server-side PAT (already SSO-authorized) so the user's OAuth token
		// doesn't need read:org or SAML SSO authorization.
		const usingServerToken = Boolean(process.env.GITHUB_ORG_CHECK_TOKEN);
		const checkToken = process.env.GITHUB_ORG_CHECK_TOKEN || accessToken;
		try {
			const memberRes = await fetch(`https://api.github.com/orgs/${allowedOrg}/members/${userData.login}`, {
				headers: {
					Authorization: `Bearer ${checkToken}`,
					'User-Agent': 'copilot-sharing-server/1.0',
					Accept: 'application/vnd.github+json',
				},
				signal: AbortSignal.timeout(10_000),
			});
			if (memberRes.status !== 204) {
				// Distinguish "genuinely not a member" (404) from "the check itself is
				// broken" (401/403 — typically an expired/invalid GITHUB_ORG_CHECK_TOKEN,
				// or a user token lacking read:org/SSO authorization when no server PAT
				// is configured). Both cases otherwise look identical to the end user.
				const brokenCheck = memberRes.status === 401 || memberRes.status === 403;
				console.error(
					`[auth/callback] Org membership check for '${userData.login}' in '${allowedOrg}' returned ` +
					`${memberRes.status} (using ${usingServerToken ? 'GITHUB_ORG_CHECK_TOKEN' : "the user's own token"}).` +
					(brokenCheck ? ` Likely cause: ${usingServerToken ? 'GITHUB_ORG_CHECK_TOKEN is invalid/expired — rotate it' : "the user's token lacks read:org scope or SSO authorization"}.` : ''),
				);
				let adminDetail = '';
				if (isConfiguredAdminLogin(userData.login)) {
					adminDetail = brokenCheck
						? ` (Admin diagnostic: the membership check itself failed with HTTP ${memberRes.status} — ` +
						  `${usingServerToken ? 'GITHUB_ORG_CHECK_TOKEN is likely invalid or expired. Rotate it.' : "your token likely lacks read:org scope or SSO authorization for this org."})`
						: ` (Admin diagnostic: the membership check returned HTTP ${memberRes.status} — not a member, per GitHub.)`;
				}
				return c.html(errorPage(`Access denied: you are not a member of the "${allowedOrg}" organization.${adminDetail}`), 403);
			}
		} catch (err) {
			console.error(`[auth/callback] Org membership check for '${userData.login}' in '${allowedOrg}' failed with a network/timeout error:`, err);
			return c.html(errorPage('Unable to verify organization membership. Please try again.'), 502);
		}
	}

	let user;
	try {
		user = upsertUser(userData.id, userData.login, userData.name, userData.avatar_url);
	} catch (err) {
		console.error('[auth/callback] upsertUser failed:', err);
		return c.html(errorPage(`Database error during sign-in: ${String(err)}`), 500);
	}
	const claims = makeClaims(user.id);
	const sessionValue = encodeSession(claims);

	setCookie(c, COOKIE_NAME, sessionValue, {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'Lax',
		maxAge: SESSION_MAX_AGE,
		path: '/',
	});

	return c.redirect('/dashboard');
});

/** GET /auth/logout — Clear session cookie and redirect to dashboard. */
dashboard.get('/auth/logout', (c) => {
	deleteCookie(c, COOKIE_NAME, { path: '/' });
	return c.redirect('/dashboard');
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

/** Redirect root to dashboard. */
dashboard.get('/', (c) => c.redirect('/dashboard'));

/** GET /dashboard — Main web dashboard. */
dashboard.get('/dashboard', (c) => {
	const cookieValue = getCookie(c, COOKIE_NAME);
	const claims = cookieValue ? decodeSession(cookieValue) : null;

	if (!claims) {
		return c.html(loginPage());
	}

	// Re-read user from DB on every request (so is_admin/name changes take effect)
	const user = getUserById(claims.sub);
	if (!user) {
		deleteCookie(c, COOKIE_NAME, { path: '/' });
		return c.html(loginPage());
	}

	const uploads = getUploadsForUser(user.id, 30);
	const isAdmin = user.is_admin === 1;

	return c.html(dashboardPage(c, user, uploads, isAdmin));
});

/** GET /admin — Admin-only dashboard showing all-user token usage and trends. */
dashboard.get('/admin', (c) => {
	const cookieValue = getCookie(c, COOKIE_NAME);
	const claims = cookieValue ? decodeSession(cookieValue) : null;
	if (!claims) return c.redirect('/dashboard');

	const user = getUserById(claims.sub);
	if (!user || user.is_admin !== 1) return c.redirect('/dashboard');

	const userSummaries = getAdminUserSummaries(30);
	const dailyTotals = getAdminDailyTotals(90);

	return c.html(adminDashboardPage(c, user, userSummaries, dailyTotals));
});

function getSessionUser(c: Context): UserRow | undefined {
	const cookie = getCookie(c, COOKIE_NAME);
	const claims = cookie ? decodeSession(cookie) : null;
	return claims ? getUserById(claims.sub) : undefined;
}

dashboard.get('/team', (c) => {
	const user = getSessionUser(c);
	if (!user) return c.redirect('/dashboard');

	const data = getTeamInsights(user.id, parseTeamDays(c.req.query('days')));
	return c.html(layout('Team Insights', `
<div class="header">
  <h1><img src="/icon.png" class="header-icon" alt="AI Engineering Fluency"></h1>
  <span class="spacer"></span>
  <nav class="header-nav" aria-label="Pages">
    ${user.is_admin === 1 ? '<a href="/admin" class="nav-admin">Admin Dashboard</a>' : ''}
    <a href="/dashboard">My Dashboard</a>
    <strong aria-current="page">Team Insights</strong>
    ${renderNavExtra(c, '/team')}
  </nav>
  <div class="header-user">
    ${user.avatar_url ? `<img src="${h(user.avatar_url)}" class="avatar-sm" alt="">` : ''}
    <span class="user-name">${h(user.github_name ?? user.github_login)}</span>
    <a href="/auth/logout">Sign out</a>
  </div>
</div>
<script>${_chartJsCode}</script>
${renderTeamInsights(data)}`));
});

dashboard.get('/team/export', (c) => {
	const user = getSessionUser(c);
	if (!user) return c.redirect('/dashboard');
	const format = c.req.query('format') ?? 'csv';
	if (format !== 'csv' && format !== 'json') {
		return c.json({ error: 'Supported export formats: csv, json.' }, 400);
	}
	const data = getTeamInsights(user.id, parseTeamDays(c.req.query('days')));
	c.header('Content-Disposition', `attachment; filename="team-insights-${data.days}days.${format}"`);
	if (format === 'json') return c.json(data);
	return c.body(teamInsightsCsv(data), 200, { 'Content-Type': 'text/csv; charset=utf-8' });
});

// ── HTML Rendering ────────────────────────────────────────────────────────────

function h(text: unknown): string {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Render a tip string: converts [text](url) markdown links to <a> tags, escapes everything else. */
function renderTip(tip: string): string {
	const mdLink = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	const parts: string[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = mdLink.exec(tip)) !== null) {
		parts.push(h(tip.slice(last, m.index)));
		parts.push(`<a href="${h(m[2])}" target="_blank" rel="noopener noreferrer">${h(m[1])}</a>`);
		last = m.index + m[0].length;
	}
	parts.push(h(tip.slice(last)));
	return parts.join('');
}

/** Normalize raw vscode.env.appName values to the friendly names used by the extension. */
function normalizeEditorName(raw: string | null | undefined): string {
	const name = (raw ?? '').trim();
	if (!name || name === 'VS Code') { return 'VS Code'; }
	if (name === 'Visual Studio Code') { return 'VS Code'; }
	if (name === 'Visual Studio Code - Insiders') { return 'VS Code Insiders'; }
	if (name === 'Visual Studio Code - Exploration') { return 'VS Code Exploration'; }
	return name;
}

/** Safely embed arbitrary data as a JS literal inside a <script> block. */
function safeJson(data: unknown): string {
	return JSON.stringify(data)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026');
}

function fmt(n: number): string {
	if (n >= 999_950_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

const chartFormatterJs = `
  function formatChartTokens(n) {
    n = Math.round(n);
    if (n >= 999950000) return (n / 1000000000).toFixed(1) + 'B';
    if (n >= 999950) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
`;

// ── Fluency Score types (score is computed by the extension and uploaded directly) ──────────

interface CategoryScore { category: string; icon: string; stage: number; tips: string[] }
interface FluencyScore {
	overallStage: number;
	overallLabel: string;
	categories: CategoryScore[];
}

function layout(title: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#161b22">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/icon.png">
<link rel="apple-touch-icon" href="/icon.png">
<title>${h(title)} — AI Engineering Fluency</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; background: #0d1117; color: #e6edf3; min-height: 100vh; }

  /* ── Header ── */
  /* Wraps instead of overflowing: a header wider than the screen widens the whole page. */
  .header { background: #161b22; border-bottom: 1px solid #30363d;
    padding: 12px max(24px, env(safe-area-inset-right)) 12px max(24px, env(safe-area-inset-left));
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
  .header h1 { margin: 0; font-size: 1.1rem; color: #58a6ff; display: flex; align-items: center; gap: 8px; }
  .header-icon { height: 32px; width: auto; display: block; }
  .header .spacer { flex: 1; }
  .header a { color: #8b949e; text-decoration: none; font-size: 0.875rem; }
  .header a:hover { color: #e6edf3; }
  .avatar-sm { width: 28px; height: 28px; border-radius: 50%; vertical-align: middle; flex-shrink: 0; }
  .header-nav { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .header-nav a, .header-nav [aria-current="page"] { padding: 6px 10px; border-radius: 6px;
    font-size: 0.875rem; white-space: nowrap; }
  .header-nav [aria-current="page"] { color: #e6edf3; font-weight: 600; background: #21262d; }
  .header-nav a.nav-admin { color: #e3b341; }
  .header-user { display: flex; align-items: center; gap: 10px; min-width: 0; margin-left: 8px; }
  .header-user .user-name { color: #c9d1d9; font-size: 0.875rem; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header-user a { white-space: nowrap; }

  /* ── Layout ── */
  .content { max-width: 1100px; margin: 28px auto; display: flex; flex-direction: column; gap: 16px;
    padding: 0 max(20px, env(safe-area-inset-right)) 0 max(20px, env(safe-area-inset-left)); }
  .content > * { min-width: 0; }

  /* ── Cards ── */
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; }
  .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
  .card-header h3 { margin: 0; color: #c9d1d9; font-size: 0.95rem; font-weight: 600; }

  /* ── Tabs ── */
  .tabs { display: flex; gap: 3px; background: #0d1117; border: 1px solid #30363d; border-radius: 7px; padding: 3px; }
  .tab { padding: 5px 14px; border-radius: 5px; border: none; cursor: pointer;
    background: transparent; color: #8b949e; font-size: 0.8rem; font-weight: 500; transition: all 0.15s; }
  .tab.active { background: #30363d; color: #e6edf3; }
  .tab:hover:not(.active) { color: #c9d1d9; }

  /* ── Profile ── */
  .profile-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px 24px;
    display: flex; align-items: center; gap: 20px; }
  .profile-avatar { width: 72px; height: 72px; border-radius: 50%; border: 2px solid #30363d; flex-shrink: 0; }
  .profile-avatar-placeholder { width: 72px; height: 72px; border-radius: 50%; background: #21262d;
    display: flex; align-items: center; justify-content: center; font-size: 2rem; flex-shrink: 0; }
  .profile-name { font-size: 1.3rem; font-weight: 700; color: #e6edf3; margin-bottom: 2px; overflow-wrap: anywhere; }
  .profile-login a { color: #58a6ff; text-decoration: none; font-size: 0.9rem; }
  .profile-login a:hover { text-decoration: underline; }
  .profile-meta { color: #8b949e; font-size: 0.8rem; margin-top: 4px; }
  .admin-badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 0.7rem;
    background: #b08800; color: #fff; margin-left: 8px; vertical-align: middle; }

  /* ── Stat grid ── */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .stat-card { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 14px 16px; }
  .stat-card .label { color: #8b949e; font-size: 0.8rem; }
  .stat-card .value { font-size: 1.6rem; font-weight: 700; color: #58a6ff; margin-top: 2px; line-height: 1; }
  .stats-panel.hidden, .admin-stats-panel.hidden { display: none; }

  /* ── Editor bars ── */
  .editor-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .editor-label { width: 160px; flex-shrink: 0; text-align: right; font-size: 0.85rem; color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .editor-track { flex: 1; background: #21262d; border-radius: 4px; height: 8px; overflow: hidden; }
  .editor-fill { height: 100%; border-radius: 4px; }
  .editor-pct { min-width: 44px; text-align: right; font-size: 0.78rem; color: #8b949e; }

  /* ── Chart ── */
  .chart-wrap { position: relative; height: 290px; margin-top: 4px; }
  .chart-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

  /* ── Table ── */
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; margin-top: 12px; min-width: 700px; }
  th { background: #0d1117; color: #8b949e; padding: 8px 10px; text-align: left; border-bottom: 1px solid #30363d; white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid #161b22; white-space: nowrap; }
  td.truncate { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  /* Keeps the row label in view while a wide table scrolls sideways on a narrow screen. */
  .sticky-first th:first-child, .sticky-first td:first-child { position: sticky; left: 0; z-index: 1; }
  .sticky-first td:first-child { background: #161b22; }
  tr:hover td { background: #21262d33; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.78rem; background: #1f6feb33; color: #58a6ff; white-space: nowrap; }

  /* ── Alerts ── */
  .alert { padding: 12px 16px; border-radius: 6px; margin: 4px 0; }
  .alert-warn { background: #3d2b0030; border: 1px solid #bb8009; color: #e3b341; }

  /* ── Fluency Score Badge ── */
  .fluency-badge { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    background: #1c2433; border: 1px solid #30363d; border-radius: 8px;
    cursor: pointer; transition: all 0.15s; text-decoration: none; user-select: none; }
  .fluency-badge:hover { background: #21262d; border-color: #58a6ff44; }
  .fluency-badge .fb-label { font-size: 0.75rem; color: #8b949e; }
  .fluency-badge .fb-stage { font-size: 0.9rem; font-weight: 700; color: #e6edf3; }
  .fluency-badge .fb-stars { font-size: 0.8rem; letter-spacing: 1px; }
  .fluency-badge .fb-icon { font-size: 1.1rem; }

  /* ── Fluency Modal Overlay ── */
  .fluency-modal-overlay { display: none; position: fixed; inset: 0; background: #0d111799;
    z-index: 1000; align-items: center; justify-content: center; padding: 20px; }
  .fluency-modal-overlay.open { display: flex; }
  .fluency-modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    width: 100%; max-width: 860px; max-height: 90vh; overflow-y: auto;
    display: flex; flex-direction: column; }
  .fluency-modal-header { padding: 20px 24px 0; display: flex; align-items: flex-start;
    justify-content: space-between; gap: 16px; }
  .fluency-modal-title { font-size: 1.2rem; font-weight: 700; color: #e6edf3; margin: 0; }
  .fluency-modal-subtitle { color: #8b949e; font-size: 0.85rem; margin-top: 4px; }
  .fluency-modal-close { background: none; border: none; color: #8b949e; font-size: 1.4rem;
    cursor: pointer; padding: 0 4px; line-height: 1; flex-shrink: 0; }
  .fluency-modal-close:hover { color: #e6edf3; }
  .fluency-modal-body { padding: 20px 24px 24px; display: flex; flex-direction: column; gap: 20px; }

  /* ── Radar Chart ── */
  .fluency-chart-wrap { position: relative; height: 320px; display: flex; align-items: center; justify-content: center; }

  /* ── Category Cards ── */
  .fluency-categories { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .fluency-cat-card { background: #0d1117; border: 1px solid #21262d; border-radius: 8px;
    padding: 14px 16px; overflow: hidden; }
  .fluency-cat-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .fluency-cat-icon { font-size: 1.1rem; flex-shrink: 0; }
  .fluency-cat-name { font-size: 0.85rem; font-weight: 600; color: #c9d1d9; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .fluency-stage-pill { display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.72rem; font-weight: 600; margin-left: auto; white-space: nowrap; flex-shrink: 0; }
  .stage-1 { background: rgba(147,197,253,0.15); color: #93c5fd; border: 1px solid rgba(147,197,253,0.4); }
  .stage-2 { background: rgba(167,139,250,0.15); color: #a78bfa; border: 1px solid rgba(167,139,250,0.4); }
  .stage-3 { background: rgba(59,130,246,0.15);  color: #3b82f6; border: 1px solid rgba(59,130,246,0.4); }
  .stage-4 { background: rgba(34,211,238,0.15);  color: #22d3ee; border: 1px solid rgba(34,211,238,0.4); }
  .fluency-tips { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .fluency-tips li { font-size: 0.8rem; color: #8b949e; padding-left: 14px; position: relative;
    overflow-wrap: break-word; word-break: break-word; }
  .fluency-tips li::before { content: "→"; position: absolute; left: 0; color: #58a6ff66; }
  .fluency-tips a { color: #58a6ff; text-decoration: none; }
  .fluency-tips a:hover { text-decoration: underline; }
  .fluency-no-data { color: #8b949e; font-size: 0.85rem; font-style: italic; }

  /* ── Collapsible ── */
  details.card > summary { cursor: pointer; color: #8b949e; font-size: 0.9rem; padding: 0;
    user-select: none; list-style: none; display: flex; align-items: center; gap: 6px; }
  details.card > summary::before { content: "▶"; font-size: 0.7rem; transition: transform 0.15s; }
  details.card[open] > summary::before { transform: rotate(90deg); }
  details.card > summary:hover { color: #e6edf3; }

  /* ── Misc ── */
  .btn { display: inline-block; padding: 8px 18px; border-radius: 6px; text-decoration: none;
    font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; }
  .btn-primary { background: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-secondary { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
  .btn-secondary:hover { background: #30363d; }
  code { background: #21262d; border-radius: 4px; padding: 1px 5px; font-size: 0.875em; }

  /* ── Footer ── */
  .deploy-footer { text-align: center; padding: 20px; margin-top: 8px;
    color: #484f58; font-size: 0.75rem; border-top: 1px solid #21262d; }
  .deploy-footer code { background: transparent; color: #484f58; padding: 0; font-size: 0.75em; }

  /* ── Phones and narrow windows ── */
  @media (max-width: 720px) {
    .header { padding-top: 8px; padding-bottom: 0; gap: 6px 10px;
      padding-left: max(12px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); }
    .header-icon { height: 28px; }
    .header .spacer { order: 1; }
    .fluency-badge { order: 2; min-height: 40px; padding: 6px 10px; }
    .fluency-badge .fb-text { display: none; }
    .header-user { order: 3; margin-left: 0; }
    .header-user .user-name { max-width: 30vw; }
    .header-user a { display: inline-flex; align-items: center; min-height: 40px; }
    /* Page links get their own row that scrolls sideways, so any number of them fits. */
    .header-nav { order: 4; flex: 1 0 100%; overflow-x: auto; scrollbar-width: none;
      -webkit-overflow-scrolling: touch; margin: 0 -12px; padding: 0 12px 6px; }
    .header-nav::-webkit-scrollbar { display: none; }
    .header-nav a, .header-nav [aria-current="page"] { display: inline-flex; align-items: center;
      min-height: 40px; padding: 0 12px; flex-shrink: 0; }
    .header:not(:has(.header-nav)) { padding-bottom: 8px; }

    .content { margin: 12px auto; gap: 12px;
      padding-left: max(12px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); }
    .card { padding: 14px; }
    .card-header { flex-direction: column; align-items: stretch; margin-bottom: 12px; }
    .profile-card { padding: 14px; gap: 14px; }
    .profile-avatar, .profile-avatar-placeholder { width: 52px; height: 52px; }
    .profile-avatar-placeholder { font-size: 1.5rem; }
    .profile-name { font-size: 1.1rem; }
    .profile-meta { line-height: 1.5; }

    .tabs { display: flex; }
    .tab { flex: 1 1 auto; min-height: 40px; padding: 6px 8px; font-size: 0.85rem;
      display: inline-flex; align-items: center; justify-content: center; text-align: center; }
    .chart-controls { display: grid; grid-template-columns: 1fr 1fr; }
    .chart-controls > .tabs { grid-column: 1 / -1; }
    .chart-controls > #group-tabs, .chart-controls > #scale-tabs { grid-column: auto; }
    .chart-controls > #view-tabs { order: 1; }

    .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .stat-card { padding: 10px 12px; }
    .stat-card .value { font-size: 1.35rem; margin-top: 4px; }

    .editor-row { flex-wrap: wrap; gap: 4px 10px; margin-bottom: 12px; }
    .editor-label { width: auto; flex: 1 1 0; min-width: 0; text-align: left; }
    .editor-track { order: 1; flex: 1 0 100%; }

    .chart-wrap { height: 300px; }
    table { font-size: 0.8rem; }
    th, td { padding: 9px 10px; }
    td.truncate { max-width: 140px; }

    /* Own uploads: each row becomes a small card so the token counts need no sideways scroll.
       The column headings stay available to assistive technology; each value carries its label. */
    .breakdown-table { min-width: 0; }
    .breakdown-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .breakdown-table tr { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px 10px;
      padding: 12px 0; border-bottom: 1px solid #30363d; }
    .breakdown-table tr:hover td { background: transparent; }
    .breakdown-table td { padding: 0; border: none; white-space: normal; min-width: 0; overflow-wrap: anywhere; }
    .breakdown-table td.truncate { max-width: none; overflow: visible; }
    .breakdown-table .bd-day { font-weight: 600; align-self: center; }
    .breakdown-table .bd-model { grid-column: 2 / -1; justify-self: end; }
    .breakdown-table .bd-model .pill { white-space: normal; }
    .breakdown-table .bd-num { order: 1; font-variant-numeric: tabular-nums; }
    .breakdown-table .bd-num::before { content: attr(data-label); display: block; color: #8b949e; font-size: 0.72rem; }
    .breakdown-table .bd-meta { order: 2; grid-column: 1 / -1; color: #8b949e; }
    .breakdown-table .bd-meta::before { content: attr(data-label) ": "; }
    details.card > summary, details > summary { min-height: 40px; align-items: center; }
    .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; text-align: center; }
    .alert { overflow-wrap: anywhere; }
    .alert ul { padding-left: 20px; }

    /* The score details become a full-screen sheet rather than a floating dialog. */
    .fluency-modal-overlay { padding: 0; align-items: stretch; }
    .fluency-modal { max-width: none; max-height: none; height: 100%; border: none; border-radius: 0;
      padding-bottom: env(safe-area-inset-bottom); }
    .fluency-modal-header { position: sticky; top: 0; z-index: 1; background: #161b22;
      padding: max(12px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) 10px max(14px, env(safe-area-inset-left));
      border-bottom: 1px solid #30363d; }
    .fluency-modal-close { min-width: 44px; min-height: 44px; margin: -6px -8px 0 0; }
    .fluency-modal-body { gap: 14px;
      padding: 14px max(14px, env(safe-area-inset-right)) 14px max(14px, env(safe-area-inset-left)); }
    .fluency-chart-wrap { height: 280px; }
    .fluency-categories { grid-template-columns: 1fr; }

    .deploy-footer { padding: 16px 12px max(16px, env(safe-area-inset-bottom)); overflow-wrap: anywhere; }
  }
  @media (max-width: 720px) and (orientation: landscape) {
    .chart-wrap { height: 240px; }
  }
  /* Touch screens of any width, e.g. a phone held sideways: keep controls easy to hit. */
  @media (pointer: coarse) {
    .tab { min-height: 40px; }
    .header-nav a, .header-nav [aria-current="page"] { padding-top: 10px; padding-bottom: 10px; }
    .header-user a { padding: 10px 0; }
  }
  @media (max-width: 350px) {
    .stat-card .value { font-size: 1.2rem; }
    .header-user .user-name { display: none; }
  }
</style>
</head>
<body>
${body}
<footer class="deploy-footer">
  sharing-server <code>v${h(packageVersion)}</code> &middot; deployed from <code>${h(DEPLOY_BRANCH)}</code> &middot; <code>${h(DEPLOY_SHA)}</code> &middot; ${h(DEPLOY_DATE)}
</footer>
</body>
</html>`;
}

function loginPage(): string {
	const oauthAvailable = !!process.env.GITHUB_CLIENT_ID;
	const oauthSection = oauthAvailable ? `
  <a href="/auth/github" class="btn btn-primary" style="font-size:1rem; padding:12px 28px">
    Sign in with GitHub (OAuth)
  </a>
  <p style="color:#8b949e; margin-top:8px; font-size:0.85rem">
    Note: requires org admin approval for SSO organizations.
  </p>` : '';

	return layout('Sign In', `
<div class="header"><h1><img src="/icon.png" class="header-icon" alt="AI Engineering Fluency"> Sharing</h1></div>
<div class="content" style="text-align:center; margin-top: 80px; align-items:center">
  <h2 style="color:#e6edf3">Sign in to view your usage dashboard</h2>
  <p style="color:#8b949e">Your data is linked to your GitHub account. No account creation needed.</p>
  ${oauthSection}
  <p style="color:#8b949e; margin-top:32px; font-size:0.85rem">
    The VS Code extension uploads data automatically using your existing GitHub session —
    no separate sign-in required.
  </p>
</div>`);
}

function dashboardPage(c: Context, user: UserRow, uploads: UploadRow[], isAdmin: boolean): string {
	// ── Per-period stats ───────────────────────────────────────────────────────
	const today = new Date().toISOString().slice(0, 10);
	const sevenDaysAgo = (() => {
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 6);
		return d.toISOString().slice(0, 10);
	})();

	const uploads1d = uploads.filter(r => r.day === today);
	const uploads7d = uploads.filter(r => r.day >= sevenDaysAgo);

	type PeriodStats = { inputTokens: number; outputTokens: number; interactions: number; daysActive: number };
	const computeStats = (rows: UploadRow[]): PeriodStats => ({
		inputTokens: rows.reduce((s, r) => s + r.input_tokens, 0),
		outputTokens: rows.reduce((s, r) => s + r.output_tokens, 0),
		interactions: rows.reduce((s, r) => s + r.interactions, 0),
		daysActive: new Set(rows.map(r => r.day)).size,
	});
	const periodStats = {
		today: computeStats(uploads1d),
		week: computeStats(uploads7d),
		month: computeStats(uploads),
	};

	// ── Fluency score ─────────────────────────────────────────────────────────
	// Use the score uploaded directly by the extension (exact same computation as local UI).
	let fluencyScore: FluencyScore | null = null;
	if (user.fluency_score_json) {
		try {
			fluencyScore = JSON.parse(user.fluency_score_json) as FluencyScore;
		} catch { /* ignore malformed stored score */ }
	}

	// ── Editor breakdown (last 30 days) ───────────────────────────────────────
	const editorTotals = new Map<string, number>();
	for (const r of uploads) {
		const editor = normalizeEditorName(r.editor);
		editorTotals.set(editor, (editorTotals.get(editor) ?? 0) + r.input_tokens + r.output_tokens);
	}
	const grandTotal = [...editorTotals.values()].reduce((s, v) => s + v, 0);
	const editorList = [...editorTotals.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([editor, tokens]) => ({
			editor,
			tokens,
			pct: grandTotal > 0 ? (tokens / grandTotal) * 100 : 0,
		}));

	// ── Chart data ────────────────────────────────────────────────────────────
	const chartData = uploads.map(r => ({
		day: r.day,
		model: r.model,
		editor: normalizeEditorName(r.editor),
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		interactions: r.interactions,
	}));

	// ── Helpers ───────────────────────────────────────────────────────────────
	const EDITOR_COLORS = ['#58a6ff', '#3fb950', '#bc8cff', '#f0883e', '#e3b341', '#f778ba'];

	function statCards(stats: PeriodStats, panelId: string, hidden: boolean): string {
		return `<div id="${panelId}" class="stats-panel${hidden ? ' hidden' : ''}">
  <div class="stat-grid">
    <div class="stat-card"><div class="label">Input Tokens</div><div class="value">${fmt(stats.inputTokens)}</div></div>
    <div class="stat-card"><div class="label">Output Tokens</div><div class="value">${fmt(stats.outputTokens)}</div></div>
    <div class="stat-card"><div class="label">Interactions</div><div class="value">${fmt(stats.interactions)}</div></div>
    <div class="stat-card"><div class="label">Days Active</div><div class="value">${stats.daysActive}</div></div>
  </div>
</div>`;
	}

	const avatarUrl = user.avatar_url ? h(user.avatar_url) : '';
	const displayName = h(user.github_name ?? user.github_login);
	const login = h(user.github_login);

	// ── Build HTML blocks ─────────────────────────────────────────────────────

	const profileHtml = `
<div class="profile-card">
  ${avatarUrl
		? `<img src="${avatarUrl}" class="profile-avatar" alt="${login}">`
		: `<div class="profile-avatar-placeholder">👤</div>`}
  <div>
    <div class="profile-name">${displayName}${isAdmin ? '<span class="admin-badge">admin</span>' : ''}</div>
    <div class="profile-login"><a href="https://github.com/${login}" target="_blank" rel="noopener">@${login}</a></div>
    <div class="profile-meta">
      Member since ${h(user.created_at.slice(0, 10))}${user.last_seen_at ? ` &nbsp;·&nbsp; Last active ${h(user.last_seen_at.slice(0, 10))}` : ''}
    </div>
  </div>
</div>`;

	const summaryHtml = `
<div class="card">
  <div class="card-header">
    <h3>Usage Summary</h3>
    <div class="tabs" id="period-tabs">
      <button class="tab active" data-period="stats-today">Today</button>
      <button class="tab" data-period="stats-week">Last 7 Days</button>
      <button class="tab" data-period="stats-month">Last 30 Days</button>
    </div>
  </div>
  ${statCards(periodStats.today, 'stats-today', false)}
  ${statCards(periodStats.week, 'stats-week', true)}
  ${statCards(periodStats.month, 'stats-month', true)}
</div>`;

	const editorsHtml = editorList.length > 0 ? `
<div class="card">
  <div class="card-header"><h3>Editors Used (last 30 days)</h3></div>
  ${editorList.map((e, i) => `
  <div class="editor-row">
    <span class="editor-label" title="${h(e.editor)}">${h(e.editor)}</span>
    <div class="editor-track">
      <div class="editor-fill" style="width:${e.pct.toFixed(1)}%;background:${EDITOR_COLORS[i % EDITOR_COLORS.length]}"></div>
    </div>
    <span class="editor-pct">${e.pct.toFixed(1)}%</span>
  </div>`).join('')}
</div>` : '';

	const chartHtml = uploads.length > 0 ? `
<div class="card">
  <div class="card-header">
    <h3>Token Usage Trend</h3>
    <div class="chart-controls">
      <div class="tabs" id="chart-period-tabs">
        <button class="tab" data-chart-period="7">Last 7 days</button>
        <button class="tab active" data-chart-period="30">Last 30 days</button>
        <button class="tab" data-chart-period="0">All</button>
      </div>
      <div class="tabs" id="group-tabs">
        <button class="tab active" data-group="model">By Model</button>
        <button class="tab" data-group="editor">By Editor</button>
      </div>
      <div class="tabs" id="view-tabs">
        <button class="tab active" data-view="day">Day</button>
        <button class="tab" data-view="week">Week</button>
        <button class="tab" data-view="month">Month</button>
      </div>
      <div class="tabs" id="scale-tabs">
        <button class="tab active" data-scale="linear">Linear</button>
        <button class="tab" data-scale="log">Log</button>
      </div>
    </div>
  </div>
  <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
</div>` : `
<div class="alert alert-warn">
  No data yet. The VS Code extension uploads to this server when <em>all</em> of these settings are in place:
  <ul>
    <li><code>aiEngineeringFluency.backend.sharingServer.enabled</code> — must be <code>true</code></li>
    <li><code>aiEngineeringFluency.backend.sharingServer.endpointUrl</code> — this server's URL</li>
    <li><code>aiEngineeringFluency.backend.sharingProfile</code> — any value other than <code>off</code></li>
  </ul>
  Running <strong>AI Engineering Fluency: Configure Team Server Backend</strong> sets all three; pick a
  sharing profile other than <em>Off</em> there. The Azure Storage toggle is not needed for this server.
  You also need to be signed in to GitHub in VS Code, since uploads are authenticated with that account.
  Saving the settings triggers an upload straight away; check the extension's output channel for
  <code>Sharing server upload:</code> if nothing arrives.
</div>`;

	const tableHtml = uploads.length > 0 ? `
<details class="card">
  <summary>Detailed Breakdown (${uploads.length} rows, last 30 days)</summary>
  <div class="table-scroll">
  <table class="breakdown-table">
    <thead>
      <tr>
        <th>Day</th><th>Model</th><th>Editor</th><th>Workspace</th><th>Machine</th>
        <th>Input Tokens</th><th>Output Tokens</th><th>Interactions</th>
      </tr>
    </thead>
    <tbody>
      ${uploads.map(r => `
      <tr>
        <td class="bd-day">${h(r.day)}</td>
        <td class="bd-model"><span class="pill">${h(r.model)}</span></td>
        <td class="bd-meta" data-label="Editor">${h(normalizeEditorName(r.editor))}</td>
        <td class="bd-meta truncate" data-label="Workspace" title="${h(r.workspace_name ?? r.workspace_id)}">${h(r.workspace_name ?? r.workspace_id)}</td>
        <td class="bd-meta truncate" data-label="Machine" title="${h(r.machine_name ?? r.machine_id)}">${h(r.machine_name ?? r.machine_id)}</td>
        <td class="bd-num" data-label="Input">${r.input_tokens.toLocaleString()}</td>
        <td class="bd-num" data-label="Output">${r.output_tokens.toLocaleString()}</td>
        <td class="bd-num" data-label="Interactions">${r.interactions.toLocaleString()}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
</details>` : '';

	// ── Interactive JS ────────────────────────────────────────────────────────
	const interactiveJs = `
(function () {
  ${chartFormatterJs}
  // ── Period tabs ─────────────────────────────────────────────────────────
  function activatePeriod(period) {
    document.querySelectorAll('#period-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
    var btn = document.querySelector('#period-tabs .tab[data-period="' + period + '"]');
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.stats-panel').forEach(function(el) {
      el.classList.toggle('hidden', el.id !== period);
    });
  }

  document.querySelectorAll('#period-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = btn.getAttribute('data-period');
      history.replaceState(null, '', '#' + target);
      activatePeriod(target);
    });
  });

  // Restore period from URL hash on load (e.g. after refresh)
  var hash = location.hash.replace('#', '');
  var validPeriods = ['stats-today', 'stats-week', 'stats-month'];
  if (validPeriods.indexOf(hash) !== -1) {
    activatePeriod(hash);
  }

  // ── Chart ────────────────────────────────────────────────────────────────
  var canvas = document.getElementById('trend-chart');
  if (!canvas || !CHART_DATA.length) return;
  // Fewer axis labels on a phone: sixteen rotated dates leave no room for the bars.
  // Re-evaluated when the width crosses the breakpoint, e.g. on rotating the phone.
  var narrowQuery = window.matchMedia('(max-width: 720px)');
  var narrow = narrowQuery.matches;

  var MODEL_PALETTE  = ['#58a6ff','#3fb950','#bc8cff','#f0883e','#e3b341','#f778ba','#79c0ff','#56d364','#d2a8ff','#ffa657'];
  var CLAUDE_COLORS  = ['#bc8cff','#a371f7','#d2a8ff','#6e40c9','#8250df'];
  var GPT_COLORS     = ['#58a6ff','#388bfd','#1f6feb','#79c0ff'];
  var GEMINI_COLORS  = ['#3fb950','#2ea043','#56d364'];
  var EDITOR_COLORS  = ['#58a6ff','#3fb950','#bc8cff','#f0883e','#e3b341','#f778ba'];
  var colorIdx = { claude: 0, gpt: 0, gemini: 0, other: 0, editor: 0 };
  var modelColorMap = {}, editorColorMap = {};

  function getModelColor(m) {
    if (!modelColorMap[m]) {
      if (m.includes('claude'))         modelColorMap[m] = CLAUDE_COLORS[colorIdx.claude++  % CLAUDE_COLORS.length];
      else if (m.match(/\\bgpt|o[134]\\b/)) modelColorMap[m] = GPT_COLORS[colorIdx.gpt++     % GPT_COLORS.length];
      else if (m.includes('gemini'))    modelColorMap[m] = GEMINI_COLORS[colorIdx.gemini++ % GEMINI_COLORS.length];
      else                               modelColorMap[m] = MODEL_PALETTE[colorIdx.other++  % MODEL_PALETTE.length];
    }
    return modelColorMap[m];
  }
  function getEditorColor(e) {
    if (!editorColorMap[e]) editorColorMap[e] = EDITOR_COLORS[colorIdx.editor++ % EDITOR_COLORS.length];
    return editorColorMap[e];
  }

  var allModels  = [...new Set(CHART_DATA.map(function(r) { return r.model; }))].sort();
  var allEditors = [...new Set(CHART_DATA.map(function(r) { return r.editor; }))].sort();
  allModels.forEach(getModelColor);
  allEditors.forEach(getEditorColor);

  function toWeekStart(day) {
    var d = new Date(day + 'T00:00:00Z');
    var dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  function toMonth(day) { return day.slice(0, 7); }

  function aggregate(keyFn, groupBy) {
    var map = {};
    CHART_DATA.forEach(function(r) {
      var label = keyFn(r.day);
      var dim   = groupBy === 'editor' ? r.editor : r.model;
      if (!map[label]) map[label] = {};
      map[label][dim] = (map[label][dim] || 0) + r.inputTokens + r.outputTokens;
    });
    return map;
  }

  function buildDatasets(grouped, labels, dims, colorFn) {
    return dims
      .map(function(dim) {
        return {
          label: dim,
          data: labels.map(function(l) { return grouped[l] && grouped[l][dim] || 0; }),
          backgroundColor: colorFn(dim) + 'bb',
          borderColor: colorFn(dim),
          borderWidth: 1,
          borderRadius: 2,
        };
      })
      .filter(function(ds) { return ds.data.some(function(v) { return v > 0; }); });
  }

  var currentGroup = 'model', currentView = 'day', currentChartDays = 30, currentScale = 'linear';

  function getChartData() {
    if (currentChartDays === 0) { return CHART_DATA; }
    var cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - (currentChartDays - 1));
    var cutoffStr = cutoff.toISOString().slice(0, 10);
    return CHART_DATA.filter(function(r) { return r.day >= cutoffStr; });
  }

  function makeYAxisConfig() {
    var isLog = currentScale === 'log';
    return {
      stacked: !isLog,
      type: isLog ? 'logarithmic' : 'linear',
      grid: { color: '#21262d' },
      ticks: {
        color: '#8b949e', font: { size: 11 },
        callback: function(v) {
          // Show only "round" log-scale ticks
          if (isLog) {
            var log = Math.log10(v);
            if (Math.abs(log - Math.round(log)) > 0.01) { return null; }
          }
          return formatChartTokens(v);
        },
      },
      title: { display: !narrow, text: 'Tokens', color: '#8b949e', font: { size: 11 } },
    };
  }

  var grouped = aggregate(function(d) { return d; }, currentGroup);
  var labels  = [...new Set(CHART_DATA.map(function(r) { return r.day; }))].sort();

  var chart = new Chart(canvas, {
    type: 'bar',
    data: { labels: labels, datasets: buildDatasets(grouped, labels, allModels, getModelColor) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: narrow ? 6 : 16, font: { size: 11 } } },
        y: makeYAxisConfig(),
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#c9d1d9', boxWidth: 11, padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
          callbacks: {
            label: function(ctx) {
              var v = ctx.parsed.y;
              return '  ' + ctx.dataset.label + ': ' + formatChartTokens(v) + ' tokens';
            },
            footer: function(items) {
              var total = items.reduce(function(s,i) { return s + i.parsed.y; }, 0);
              return 'Total: ' + formatChartTokens(total) + ' tokens';
            },
          },
        },
      },
    },
  });

  function rebuildChart() {
    var filteredData = getChartData();
    var keyFn = currentView === 'week' ? toWeekStart : currentView === 'month' ? toMonth : function(d) { return d; };
    // Re-aggregate using filtered data
    var filteredMap = {};
    filteredData.forEach(function(r) {
      var label = keyFn(r.day);
      var dim   = currentGroup === 'editor' ? r.editor : r.model;
      if (!filteredMap[label]) filteredMap[label] = {};
      filteredMap[label][dim] = (filteredMap[label][dim] || 0) + r.inputTokens + r.outputTokens;
    });
    grouped = filteredMap;
    labels  = [...new Set(filteredData.map(function(r) { return keyFn(r.day); }))].sort();
    var dims     = currentGroup === 'editor' ? allEditors : allModels;
    var colorFn  = currentGroup === 'editor' ? getEditorColor : getModelColor;
    chart.data.labels   = labels;
    chart.data.datasets = buildDatasets(grouped, labels, dims, colorFn);
    chart.options.scales.x.stacked = currentScale !== 'log';
    chart.options.scales.y = makeYAxisConfig();
    chart.update();
  }

  narrowQuery.addEventListener('change', function(e) {
    narrow = e.matches;
    chart.options.scales.x.ticks.maxTicksLimit = narrow ? 6 : 16;
    rebuildChart();
  });

  document.querySelectorAll('#chart-period-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#chart-period-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentChartDays = parseInt(btn.getAttribute('data-chart-period'), 10);
      rebuildChart();
    });
  });

  document.querySelectorAll('#scale-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#scale-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentScale = btn.getAttribute('data-scale');
      rebuildChart();
    });
  });

  document.querySelectorAll('#group-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#group-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentGroup = btn.getAttribute('data-group');
      rebuildChart();
    });
  });

  document.querySelectorAll('#view-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#view-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentView = btn.getAttribute('data-view');
      rebuildChart();
    });
  });
})();`;

	// ── Fluency badge (header) ────────────────────────────────────────────────
	const stageStars = fluencyScore
		? ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐'][fluencyScore.overallStage] ?? ''
		: '';
	const stageColorMap: Record<number, string> = { 1: '#93c5fd', 2: '#a78bfa', 3: '#3b82f6', 4: '#22d3ee' };
	const stageColor = fluencyScore ? (stageColorMap[fluencyScore.overallStage] ?? '#93c5fd') : '#93c5fd';

	const fluencyBadgeHtml = fluencyScore ? `
<button class="fluency-badge" id="fluency-badge-btn" title="View your AI Fluency Score details" aria-label="AI Fluency: ${h(fluencyScore.overallLabel)}. View details">
  <span class="fb-icon">🎯</span>
  <div class="fb-text">
    <div class="fb-label">AI Fluency</div>
    <div class="fb-stage" style="color:${stageColor}">${h(fluencyScore.overallLabel)}</div>
  </div>
  <span class="fb-stars">${stageStars}</span>
</button>` : '';

	// ── Fluency modal ─────────────────────────────────────────────────────────
	const fluencyModalHtml = fluencyScore ? (() => {
		const cats = fluencyScore.categories;
		const catCards = cats.map(cat => `
  <div class="fluency-cat-card">
    <div class="fluency-cat-header">
      <span class="fluency-cat-icon">${cat.icon}</span>
      <span class="fluency-cat-name">${h(cat.category)}</span>
      <span class="fluency-stage-pill stage-${cat.stage}">Stage ${cat.stage}</span>
    </div>
    ${cat.tips.length > 0
		? `<ul class="fluency-tips">${cat.tips.map(t => `<li>${renderTip(t)}</li>`).join('')}</ul>`
		: `<p class="fluency-no-data">🏆 You're at the highest level!</p>`}
  </div>`).join('');

		return `
<div class="fluency-modal-overlay" id="fluency-modal-overlay">
  <div class="fluency-modal">
    <div class="fluency-modal-header">
      <div>
        <p class="fluency-modal-title">🎯 AI Fluency Score</p>
        <p class="fluency-modal-subtitle">
          Overall: <strong style="color:${stageColor}">${h(fluencyScore.overallLabel)}</strong>
          &nbsp;${stageStars}&nbsp;·&nbsp;Based on your last 30 days of activity
        </p>
      </div>
      <button class="fluency-modal-close" id="fluency-modal-close" aria-label="Close">✕</button>
    </div>
    <div class="fluency-modal-body">
      <div class="fluency-chart-wrap">
        <canvas id="fluency-radar-chart" style="max-height:300px"></canvas>
      </div>
      <div class="fluency-categories">${catCards}</div>
    </div>
  </div>
</div>`;
	})() : '';

	// ── Fluency JS ────────────────────────────────────────────────────────────
	const fluencyJs = fluencyScore ? `
(function() {
  var overlay = document.getElementById('fluency-modal-overlay');
  var badge   = document.getElementById('fluency-badge-btn');
  var closeBtn = document.getElementById('fluency-modal-close');
  var radarCanvas = document.getElementById('fluency-radar-chart');
  var radarChart = null;

  function openModal() {
    overlay.classList.add('open');
    if (!radarChart && radarCanvas) { buildRadar(); }
  }
  function closeModal() { overlay.classList.remove('open'); }

  if (badge)    badge.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (overlay)  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) { closeModal(); }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeModal(); }
  });

  function buildRadar() {
    var FLUENCY_DATA = ${safeJson(fluencyScore.categories.map(c => ({ category: c.category, icon: c.icon, stage: c.stage })))};
    // On a phone the chart is too narrow for one-line labels: one word per line, no icon.
    var narrowQuery = window.matchMedia('(max-width: 720px)');
    var narrow   = narrowQuery.matches;
    function radarLabels() {
      return FLUENCY_DATA.map(function(c) { return narrow ? c.category.split(' ') : c.icon + ' ' + c.category; });
    }
    var labels   = radarLabels();
    narrowQuery.addEventListener('change', function(e) {
      narrow = e.matches;
      radarChart.data.labels = radarLabels();
      radarChart.options.scales.r.ticks.display = !narrow;
      radarChart.update();
    });
    var values   = FLUENCY_DATA.map(function(c) { return c.stage; });
    var overallStage = ${fluencyScore.overallStage};
    var fillColor   = 'rgba(88,166,255,0.25)';
    var borderColor = '#58a6ff';

    radarChart = new Chart(radarCanvas, {
      type: 'radar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Your Score',
          data: values,
          backgroundColor: fillColor,
          borderColor: borderColor,
          borderWidth: 2,
          pointBackgroundColor: borderColor,
          pointRadius: 5,
          pointHoverRadius: 7,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        scales: {
          r: {
            min: 0, max: 4,
            ticks: {
              display: !narrow, stepSize: 1, color: '#8b949e', backdropColor: 'transparent', font: { size: 10 },
              callback: function(v) {
                return v === 0 ? '' : ['','AI Skeptic','Explorer','Collaborator','Strategist'][v] || v;
              },
            },
            grid: { color: '#30363d' },
            pointLabels: { color: '#c9d1d9', font: { size: 11 } },
            angleLines: { color: '#30363d' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
            callbacks: {
              label: function(ctx) {
                var s = ctx.parsed.r;
                var labels = ['','AI Skeptic','AI Explorer','AI Collaborator','AI Strategist'];
                return ' Stage ' + s + ': ' + (labels[s] || '');
              },
            },
          },
        },
      },
    });
  }
})();` : '';

	return layout(`${user.github_login}'s Dashboard`, `
<div class="header">
  <h1><img src="/icon.png" class="header-icon" alt="AI Engineering Fluency"></h1>
  <span class="spacer"></span>
  ${fluencyBadgeHtml}
  <nav class="header-nav" aria-label="Pages">
    ${isAdmin ? '<a href="/admin" class="nav-admin">Admin Dashboard</a>' : ''}
    <strong aria-current="page">My Dashboard</strong>
    <a href="/team">Team Insights</a>
    ${renderNavExtra(c, '/dashboard')}
  </nav>
  <div class="header-user">
    ${avatarUrl ? `<img src="${avatarUrl}" class="avatar-sm" alt="${login}">` : ''}
    <span class="user-name">${displayName}</span>
    <a href="/auth/logout">Sign out</a>
  </div>
</div>
<div class="content">
  ${profileHtml}
  ${summaryHtml}
  ${editorsHtml}
  ${chartHtml}
  ${tableHtml}
</div>
${fluencyModalHtml}

<script>
var CHART_DATA = ${safeJson(chartData)};
</script>
<script>${_chartJsCode}</script>
<script>${interactiveJs}</script>
<script>
// Re-compute "Today" stats using browser's local timezone (server pre-renders in UTC)
(function() {
  function fmtLocal(n) {
    if (n >= 999950000) return (n / 1000000000).toFixed(1) + 'B';
    if (n >= 999950) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  var todayLocal = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local timezone
  var todayData = CHART_DATA.filter(function(r) { return r.day === todayLocal; });
  var inputTokens = todayData.reduce(function(s, r) { return s + r.inputTokens; }, 0);
  var outputTokens = todayData.reduce(function(s, r) { return s + r.outputTokens; }, 0);
  var interactions = todayData.reduce(function(s, r) { return s + r.interactions; }, 0);
  var daysActive = todayData.length > 0 ? 1 : 0;
  var panel = document.getElementById('stats-today');
  if (panel) {
    var values = panel.querySelectorAll('.stat-card .value');
    if (values[0]) values[0].textContent = fmtLocal(inputTokens);
    if (values[1]) values[1].textContent = fmtLocal(outputTokens);
    if (values[2]) values[2].textContent = fmtLocal(interactions);
    if (values[3]) values[3].textContent = String(daysActive);
  }
})();
</script>
<script>${fluencyJs}</script>`);
}

// ── Admin Dashboard ──────────────────────────────────────────────────────────

interface AdminPeriodStats {
	totalInput: number;
	totalOutput: number;
	totalInteractions: number;
	activeUsers: number;
}

function computeAdminPeriodStats(rows: AdminDailyRow[], days: number): AdminPeriodStats {
	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - days);
	const cutoffStr = cutoff.toISOString().slice(0, 10);
	const filtered = rows.filter(r => r.day >= cutoffStr);
	const totalInput = filtered.reduce((s, r) => s + r.input_tokens, 0);
	const totalOutput = filtered.reduce((s, r) => s + r.output_tokens, 0);
	const totalInteractions = filtered.reduce((s, r) => s + r.interactions, 0);
	const activeUsers = new Set(
		filtered
			.filter(r => r.input_tokens + r.output_tokens + r.interactions > 0)
			.map(r => r.github_login)
	).size;
	return { totalInput, totalOutput, totalInteractions, activeUsers };
}

function adminStatPanel(stats: AdminPeriodStats, totalUsers: number, panelId: string, hidden: boolean): string {
	const avgPerActiveUser = stats.activeUsers > 0
		? Math.round((stats.totalInput + stats.totalOutput) / stats.activeUsers)
		: 0;
	return `<div id="${panelId}" class="stats-panel${hidden ? ' hidden' : ''}">
  <div class="stat-grid">
    <div class="stat-card"><div class="label">Total Users</div><div class="value">${totalUsers}</div></div>
    <div class="stat-card"><div class="label">Active Users</div><div class="value">${stats.activeUsers}</div></div>
    <div class="stat-card"><div class="label">Total Tokens</div><div class="value">${fmt(stats.totalInput + stats.totalOutput)}</div></div>
    <div class="stat-card"><div class="label">Avg Tokens / User</div><div class="value">${fmt(avgPerActiveUser)}</div></div>
    <div class="stat-card"><div class="label">Interactions</div><div class="value">${fmt(stats.totalInteractions)}</div></div>
  </div>
</div>`;
}

function adminDashboardPage(
	c: Context,
	adminUser: UserRow,
	userSummaries: UserUsageSummary[],
	dailyTotals: AdminDailyRow[],
): string {
	const totalUsers = userSummaries.length;

	const stats7  = computeAdminPeriodStats(dailyTotals, 7);
	const stats30 = computeAdminPeriodStats(dailyTotals, 30);
	const stats90 = computeAdminPeriodStats(dailyTotals, 90);

	const adminLogin = h(adminUser.github_login);
	const adminAvatar = adminUser.avatar_url ? h(adminUser.avatar_url) : '';
	const adminName = h(adminUser.github_name ?? adminUser.github_login);

	const chartData = dailyTotals.map(r => ({
		day: r.day,
		login: r.github_login,
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		interactions: r.interactions,
	}));

	const overviewHtml = `
<div class="card">
  <div class="card-header">
    <h3>Overview</h3>
    <div class="tabs" id="admin-period-tabs">
      <button class="tab" data-admin-period="7">Last 7 days</button>
      <button class="tab active" data-admin-period="30">Last 30 days</button>
      <button class="tab" data-admin-period="90">Last 90 days</button>
    </div>
  </div>
  ${adminStatPanel(stats7,  totalUsers, 'admin-stats-7',  true)}
  ${adminStatPanel(stats30, totalUsers, 'admin-stats-30', false)}
  ${adminStatPanel(stats90, totalUsers, 'admin-stats-90', true)}
</div>`;

	const chartHtml = chartData.length > 0 ? `
<div class="card">
  <div class="card-header">
    <h3>Usage Trend</h3>
    <div class="chart-controls">
      <div class="tabs" id="admin-mode-tabs">
        <button class="tab active" data-admin-mode="total">Total</button>
        <button class="tab" data-admin-mode="average">Per-User Average</button>
      </div>
    </div>
  </div>
  <div class="chart-wrap"><canvas id="admin-trend-chart"></canvas></div>
</div>` : `
<div class="alert alert-warn">No usage data uploaded yet.</div>`;

	const tableHtml = `
<div class="card">
  <div class="card-header"><h3>Users — last 30 days</h3></div>
  <div class="table-scroll">
  <table>
    <thead>
      <tr>
        <th></th><th>Login</th><th>Name</th>
        <th>Input Tokens</th><th>Output Tokens</th><th>Interactions</th>
        <th>Days Active</th><th>Last Upload</th><th>Admin</th>
      </tr>
    </thead>
    <tbody>
      ${userSummaries.map(u => `
      <tr>
        <td>${u.avatar_url ? `<img src="${h(u.avatar_url)}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle">` : ''}</td>
        <td><a href="https://github.com/${h(u.github_login)}" target="_blank" rel="noopener" style="color:#58a6ff">${h(u.github_login)}</a></td>
        <td>${h(u.github_name ?? '—')}</td>
        <td>${u.total_input > 0 ? fmt(u.total_input) : '—'}</td>
        <td>${u.total_output > 0 ? fmt(u.total_output) : '—'}</td>
        <td>${u.total_interactions > 0 ? u.total_interactions.toLocaleString() : '—'}</td>
        <td>${u.days_active > 0 ? String(u.days_active) : '—'}</td>
        <td>${h(u.last_upload_day ?? '—')}</td>
        <td>${u.is_admin ? '✅' : ''}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
</div>`;

	const adminInteractiveJs = `
(function () {
  ${chartFormatterJs}
  // ── Period tabs (stat cards only — chart uses its own period state) ─────────
  var currentPeriod = 30;
  var currentMode = 'total';

  function activatePeriod(period) {
    document.querySelectorAll('#admin-period-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
    var btn = document.querySelector('#admin-period-tabs .tab[data-admin-period="' + period + '"]');
    if (btn) btn.classList.add('active');
    ['admin-stats-7','admin-stats-30','admin-stats-90'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', id !== 'admin-stats-' + period);
    });
    currentPeriod = period;
    rebuildChart();
  }

  document.querySelectorAll('#admin-period-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      activatePeriod(parseInt(btn.getAttribute('data-admin-period'), 10));
    });
  });

  document.querySelectorAll('#admin-mode-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#admin-mode-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentMode = btn.getAttribute('data-admin-mode');
      rebuildChart();
    });
  });

  // ── Chart ────────────────────────────────────────────────────────────────
  var canvas = document.getElementById('admin-trend-chart');
  if (!canvas || !ADMIN_CHART_DATA.length) return;
  var narrowQuery = window.matchMedia('(max-width: 720px)');
  var narrow = narrowQuery.matches;

  var TOP_N = 10;
  var USER_COLORS = ['#58a6ff','#3fb950','#bc8cff','#f0883e','#e3b341','#f778ba','#79c0ff','#56d364','#d2a8ff','#ffa657'];
  var OTHERS_COLOR = '#8b949e';

  function makeDayRange(days) {
    var dates = [];
    var now = new Date();
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  function filterData(days) {
    var labels = makeDayRange(days);
    var cutoff = labels[0];
    return ADMIN_CHART_DATA.filter(function(r) { return r.day >= cutoff; });
  }

  function topUsersByTokens(data) {
    var totals = {};
    data.forEach(function(r) {
      totals[r.login] = (totals[r.login] || 0) + r.inputTokens + r.outputTokens;
    });
    return Object.keys(totals)
      .sort(function(a, b) { return totals[b] - totals[a]; })
      .slice(0, TOP_N);
  }

  function buildTotalDatasets(data, labels, topLogins) {
    var topSet = {};
    topLogins.forEach(function(l) { topSet[l] = true; });
    var hasOthers = data.some(function(r) { return !topSet[r.login]; });

    var datasets = topLogins.map(function(login, i) {
      var color = USER_COLORS[i % USER_COLORS.length];
      return {
        label: login,
        data: labels.map(function(day) {
          var total = 0;
          data.forEach(function(r) { if (r.day === day && r.login === login) total += r.inputTokens + r.outputTokens; });
          return total;
        }),
        backgroundColor: color + 'bb',
        borderColor: color,
        borderWidth: 1, borderRadius: 2,
      };
    });

    if (hasOthers) {
      datasets.push({
        label: 'Others',
        data: labels.map(function(day) {
          var total = 0;
          data.forEach(function(r) { if (r.day === day && !topSet[r.login]) total += r.inputTokens + r.outputTokens; });
          return total;
        }),
        backgroundColor: OTHERS_COLOR + 'bb',
        borderColor: OTHERS_COLOR,
        borderWidth: 1, borderRadius: 2,
      });
    }

    return datasets.filter(function(ds) { return ds.data.some(function(v) { return v > 0; }); });
  }

  function buildAverageDatasets(data, labels) {
    var dayMap = {};
    data.forEach(function(r) {
      if (!dayMap[r.day]) dayMap[r.day] = {};
      dayMap[r.day][r.login] = (dayMap[r.day][r.login] || 0) + r.inputTokens + r.outputTokens;
    });
    return [{
      label: 'Avg tokens per active user',
      data: labels.map(function(day) {
        if (!dayMap[day]) return 0;
        var logins = Object.keys(dayMap[day]).filter(function(l) { return dayMap[day][l] > 0; });
        if (!logins.length) return 0;
        var total = logins.reduce(function(s, l) { return s + dayMap[day][l]; }, 0);
        return total / logins.length;
      }),
      backgroundColor: '#58a6ffbb',
      borderColor: '#58a6ff',
      borderWidth: 1, borderRadius: 2,
    }];
  }

  function makeYConfig(stacked) {
    return {
      stacked: stacked,
      grid: { color: '#21262d' },
      ticks: {
        color: '#8b949e', font: { size: 11 },
        callback: function(v) { return formatChartTokens(v); },
      },
      title: { display: !narrow, text: 'Tokens', color: '#8b949e', font: { size: 11 } },
    };
  }

  var initLabels = makeDayRange(currentPeriod);
  var initData   = filterData(currentPeriod);
  var initTop    = topUsersByTokens(initData);
  var initDs     = buildTotalDatasets(initData, initLabels, initTop);

  var chart = new Chart(canvas, {
    type: 'bar',
    data: { labels: initLabels, datasets: initDs },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: narrow ? 6 : 20, font: { size: 11 } } },
        y: makeYConfig(true),
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#c9d1d9', boxWidth: 11, padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
          callbacks: {
            label: function(ctx) {
              var v = ctx.parsed.y;
              return '  ' + ctx.dataset.label + ': ' + formatChartTokens(v) + ' tokens';
            },
            footer: function(items) {
              var total = items.reduce(function(s, i) { return s + i.parsed.y; }, 0);
              return 'Total: ' + formatChartTokens(total) + ' tokens';
            },
          },
        },
      },
    },
  });

  function rebuildChart() {
    var labels  = makeDayRange(currentPeriod);
    var data    = filterData(currentPeriod);
    var stacked = currentMode === 'total';
    var datasets;
    if (currentMode === 'total') {
      var top = topUsersByTokens(data);
      datasets = buildTotalDatasets(data, labels, top);
    } else {
      datasets = buildAverageDatasets(data, labels);
    }
    chart.data.labels   = labels;
    chart.data.datasets = datasets;
    chart.options.scales.x.stacked = stacked;
    chart.options.scales.y = makeYConfig(stacked);
    chart.options.scales.y.title.text = currentMode === 'total' ? 'Tokens' : 'Avg Tokens/User';
    chart.update();
  }

  narrowQuery.addEventListener('change', function(e) {
    narrow = e.matches;
    chart.options.scales.x.ticks.maxTicksLimit = narrow ? 6 : 20;
    rebuildChart();
  });
})();`;

	return layout('Admin Dashboard', `
<div class="header">
  <h1><img src="/icon.png" class="header-icon" alt="AI Engineering Fluency"></h1>
  <span class="spacer"></span>
  <nav class="header-nav" aria-label="Pages">
    <strong aria-current="page">Admin Dashboard</strong>
    <a href="/dashboard">My Dashboard</a>
    <a href="/team">Team Insights</a>
    ${renderNavExtra(c, '/admin')}
  </nav>
  <div class="header-user">
    ${adminAvatar ? `<img src="${adminAvatar}" class="avatar-sm" alt="${adminLogin}">` : ''}
    <span class="user-name">${adminName}</span>
    <a href="/auth/logout">Sign out</a>
  </div>
</div>
<div class="content">
  ${overviewHtml}
  ${chartHtml}
  ${tableHtml}
</div>

<script>
var ADMIN_CHART_DATA = ${safeJson(chartData)};
</script>
<script>${_chartJsCode}</script>
<script>${adminInteractiveJs}</script>`);
}

function errorPage(message: string): string {
	return layout('Error', `
<div class="header"><h1><img src="/icon.png" class="header-icon" alt="AI Engineering Fluency"> Sharing</h1></div>
<div class="content" style="text-align:center; margin-top:80px; align-items:center">
  <h2 style="color:#e6edf3">Something went wrong</h2>
  <p style="color:#8b949e">${h(message)}</p>
  <a href="/dashboard" class="btn btn-secondary">Back to Dashboard</a>
</div>`);
}

function randomState(): string {
	return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
