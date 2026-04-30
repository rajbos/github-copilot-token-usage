import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
	encodeSession, decodeSession, makeClaims,
	COOKIE_NAME, OAUTH_STATE_COOKIE, SESSION_MAX_AGE,
} from '../session.js';
import {
	getUserById, getUserByGithubId, getUploadsForUser, getAllUsers, getAllUploads, upsertUser,
	getAdminUserSummaries, getAdminDailyTotals,
	type UploadRow, type UserRow, type AdminUploadRow, type UserUsageSummary, type AdminDailyRow,
} from '../db.js';
export const dashboard = new Hono();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const DEPLOY_SHA    = process.env.DEPLOY_SHA    ?? 'unknown';
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH ?? 'unknown';
const DEPLOY_DATE   = process.env.DEPLOY_DATE   ?? 'unknown';

// Load Chart.js UMD bundle once at startup — copied to dist/ by esbuild.js
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _chartJsCode: string = (() => {
	try {
		return readFileSync(join(__dirname, 'chart.min.js'), 'utf-8');
	} catch {
		return '/* chart.js not bundled — run npm run build in sharing-server/ */';
	}
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
		maxAge: 300, // 5 minutes
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
				return c.html(errorPage(`Access denied: you are not a member of the "${allowedOrg}" organization.`), 403);
			}
		} catch {
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
	const allUsers = isAdmin ? getAllUsers() : undefined;
	const allUploads = isAdmin ? getAllUploads(30) : undefined;

	return c.html(dashboardPage(user, uploads, isAdmin, allUsers, allUploads));
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

	return c.html(adminDashboardPage(user, userSummaries, dailyTotals));
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
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} — Copilot Token Tracker</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; background: #0d1117; color: #e6edf3; min-height: 100vh; }

  /* ── Header ── */
  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 24px;
    display: flex; align-items: center; gap: 12px; }
  .header h1 { margin: 0; font-size: 1.1rem; color: #58a6ff; }
  .header .spacer { flex: 1; }
  .header a { color: #8b949e; text-decoration: none; font-size: 0.875rem; }
  .header a:hover { color: #e6edf3; }
  .avatar-sm { width: 28px; height: 28px; border-radius: 50%; vertical-align: middle; }

  /* ── Layout ── */
  .content { max-width: 1100px; margin: 28px auto; padding: 0 20px; display: flex; flex-direction: column; gap: 16px; }

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
  .profile-name { font-size: 1.3rem; font-weight: 700; color: #e6edf3; margin-bottom: 2px; }
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

  /* ── Table ── */
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; margin-top: 12px; min-width: 700px; }
  th { background: #0d1117; color: #8b949e; padding: 8px 10px; text-align: left; border-bottom: 1px solid #30363d; white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid #161b22; white-space: nowrap; }
  td.truncate { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
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
  .stage-2 { background: rgba(110,231,183,0.15); color: #6ee7b7; border: 1px solid rgba(110,231,183,0.4); }
  .stage-3 { background: rgba(59,130,246,0.15);  color: #3b82f6; border: 1px solid rgba(59,130,246,0.4); }
  .stage-4 { background: rgba(16,185,129,0.15);  color: #10b981; border: 1px solid rgba(16,185,129,0.4); }
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
</style>
</head>
<body>
${body}
<footer class="deploy-footer">
  deployed from <code>${h(DEPLOY_BRANCH)}</code> &middot; <code>${h(DEPLOY_SHA)}</code> &middot; ${h(DEPLOY_DATE)}
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
<div class="header"><h1>🤖 Copilot Token Tracker Sharing</h1></div>
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

function dashboardPage(user: UserRow, uploads: UploadRow[], isAdmin: boolean, allUsers?: UserRow[], allUploads?: AdminUploadRow[]): string {
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
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
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
  No data yet. Configure the VS Code extension with this server's endpoint URL
  (<code>aiEngineeringFluency.backend.sharingServer.endpointUrl</code>) and wait for the
  next sync (or trigger one from the status bar).
</div>`;

	const tableHtml = uploads.length > 0 ? `
<details class="card">
  <summary>Detailed Breakdown (${uploads.length} rows, last 30 days)</summary>
  <div class="table-scroll">
  <table>
    <thead>
      <tr>
        <th>Day</th><th>Model</th><th>Editor</th><th>Workspace</th><th>Machine</th>
        <th>Input Tokens</th><th>Output Tokens</th><th>Interactions</th>
      </tr>
    </thead>
    <tbody>
      ${uploads.map(r => `
      <tr>
        <td>${h(r.day)}</td>
        <td><span class="pill">${h(r.model)}</span></td>
        <td>${h(normalizeEditorName(r.editor))}</td>
        <td class="truncate" title="${h(r.workspace_name ?? r.workspace_id)}">${h(r.workspace_name ?? r.workspace_id)}</td>
        <td class="truncate" title="${h(r.machine_name ?? r.machine_id)}">${h(r.machine_name ?? r.machine_id)}</td>
        <td>${r.input_tokens.toLocaleString()}</td>
        <td>${r.output_tokens.toLocaleString()}</td>
        <td>${r.interactions.toLocaleString()}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
</details>` : '';

	// ── Admin section ─────────────────────────────────────────────────────────
	// Renamed user-list collapsible (keeps existing behavior)
	const adminUsersHtml = isAdmin && allUsers ? `
<details class="card">
  <summary>👑 Admin: All Users (${allUsers.length})</summary>
  <div class="table-scroll">
  <table>
    <thead><tr><th></th><th>GitHub Login</th><th>Name</th><th>Joined</th><th>Last Seen</th><th>Admin</th></tr></thead>
    <tbody>
      ${allUsers.map(u => `
      <tr>
        <td>${u.avatar_url ? `<img src="${h(u.avatar_url)}" style="width:22px;height:22px;border-radius:50%;vertical-align:middle">` : ''}</td>
        <td><a href="https://github.com/${h(u.github_login)}" target="_blank" rel="noopener" style="color:#58a6ff">${h(u.github_login)}</a></td>
        <td>${h(u.github_name ?? '—')}</td>
        <td>${h(u.created_at.slice(0, 10))}</td>
        <td>${h(u.last_seen_at?.slice(0, 10) ?? '—')}</td>
        <td>${u.is_admin ? '✅' : ''}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
</details>` : '';

	// Admin overview: aggregate stats + trend chart + top users (shown only to admins)
	let adminChartData: { day: string; model: string; editor: string; user: string; inputTokens: number; outputTokens: number; interactions: number }[] = [];
	let adminSectionHtml = '';
	let adminInteractiveJs = '';

	if (isAdmin && allUploads !== undefined) {
		// Build per-user totals for top-users table and chart user cap
		const userAvatarMap = new Map(allUsers?.map(u => [u.github_login, u.avatar_url]) ?? []);
		type AdminUserStats = { login: string; avatarUrl: string | null; input: number; output: number; interactions: number; lastActive: string | null };
		const userTotals = new Map<string, AdminUserStats>();
		for (const r of allUploads) {
			if (!userTotals.has(r.github_login)) {
				userTotals.set(r.github_login, { login: r.github_login, avatarUrl: userAvatarMap.get(r.github_login) ?? null, input: 0, output: 0, interactions: 0, lastActive: null });
			}
			const s = userTotals.get(r.github_login)!;
			s.input += r.input_tokens;
			s.output += r.output_tokens;
			s.interactions += r.interactions;
			if (!s.lastActive || r.day > s.lastActive) s.lastActive = r.day;
		}
		const topUsers = [...userTotals.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));

		// Cap "By User" chart grouping at top 10 — label the rest "Other"
		const topChartLogins = new Set(topUsers.slice(0, 10).map(u => u.login));
		adminChartData = allUploads.map(r => ({
			day: r.day,
			model: r.model,
			editor: normalizeEditorName(r.editor),
			user: topChartLogins.has(r.github_login) ? r.github_login : 'Other',
			inputTokens: r.input_tokens,
			outputTokens: r.output_tokens,
			interactions: r.interactions,
		}));

		// Period stats for admin
		const todayStr = new Date().toISOString().slice(0, 10);
		const sevenDaysAgoStr = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 6); return d.toISOString().slice(0, 10); })();
		type AdminPeriodStats = { inputTokens: number; outputTokens: number; interactions: number; activeUsers: number };
		const computeAdminStats = (rows: AdminUploadRow[]): AdminPeriodStats => ({
			inputTokens: rows.reduce((s, r) => s + r.input_tokens, 0),
			outputTokens: rows.reduce((s, r) => s + r.output_tokens, 0),
			interactions: rows.reduce((s, r) => s + r.interactions, 0),
			activeUsers: new Set(rows.map(r => r.github_login)).size,
		});
		const adminStats = {
			today: computeAdminStats(allUploads.filter(r => r.day === todayStr)),
			week: computeAdminStats(allUploads.filter(r => r.day >= sevenDaysAgoStr)),
			month: computeAdminStats(allUploads),
		};

		function adminStatCards(s: AdminPeriodStats, panelId: string, hidden: boolean): string {
			return `<div id="${panelId}" class="admin-stats-panel${hidden ? ' hidden' : ''}">
  <div class="stat-grid">
    <div class="stat-card"><div class="label">Input Tokens</div><div class="value">${fmt(s.inputTokens)}</div></div>
    <div class="stat-card"><div class="label">Output Tokens</div><div class="value">${fmt(s.outputTokens)}</div></div>
    <div class="stat-card"><div class="label">Interactions</div><div class="value">${fmt(s.interactions)}</div></div>
    <div class="stat-card"><div class="label">Active Users</div><div class="value">${s.activeUsers}</div></div>
  </div>
</div>`;
		}

		const userCount = allUsers?.length ?? topUsers.length;
		adminSectionHtml = `
<div class="card">
  <div class="card-header">
    <h3>👑 Admin Overview</h3>
    <div style="color:#8b949e;font-size:0.8rem">${userCount} user${userCount !== 1 ? 's' : ''}</div>
    <div class="tabs" id="admin-period-tabs">
      <button class="tab active" data-period="admin-stats-today">Today</button>
      <button class="tab" data-period="admin-stats-week">Last 7 Days</button>
      <button class="tab" data-period="admin-stats-month">Last 30 Days</button>
    </div>
  </div>
  ${adminStatCards(adminStats.today, 'admin-stats-today', false)}
  ${adminStatCards(adminStats.week, 'admin-stats-week', true)}
  ${adminStatCards(adminStats.month, 'admin-stats-month', true)}
</div>
${allUploads.length > 0 ? `<div class="card">
  <div class="card-header">
    <h3>Token Usage Trend — All Users</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <div class="tabs" id="admin-chart-period-tabs">
        <button class="tab" data-chart-period="7">Last 7 days</button>
        <button class="tab active" data-chart-period="30">Last 30 days</button>
        <button class="tab" data-chart-period="0">All</button>
      </div>
      <div class="tabs" id="admin-group-tabs">
        <button class="tab active" data-group="model">By Model</button>
        <button class="tab" data-group="editor">By Editor</button>
        <button class="tab" data-group="user">By User</button>
      </div>
      <div class="tabs" id="admin-view-tabs">
        <button class="tab active" data-view="day">Day</button>
        <button class="tab" data-view="week">Week</button>
        <button class="tab" data-view="month">Month</button>
      </div>
      <div class="tabs" id="admin-scale-tabs">
        <button class="tab active" data-scale="linear">Linear</button>
        <button class="tab" data-scale="log">Log</button>
      </div>
    </div>
  </div>
  <div class="chart-wrap"><canvas id="admin-trend-chart"></canvas></div>
</div>` : ''}
${topUsers.length > 0 ? `<details class="card">
  <summary>Top Users by Token Usage (Last 30 Days)</summary>
  <div class="table-scroll">
  <table>
    <thead><tr><th></th><th>User</th><th>Input Tokens</th><th>Output Tokens</th><th>Interactions</th><th>Last Active</th></tr></thead>
    <tbody>
      ${topUsers.map(u => `
      <tr>
        <td>${u.avatarUrl ? `<img src="${h(u.avatarUrl)}" style="width:22px;height:22px;border-radius:50%;vertical-align:middle">` : ''}</td>
        <td><a href="https://github.com/${h(u.login)}" target="_blank" rel="noopener" style="color:#58a6ff">${h(u.login)}</a></td>
        <td style="text-align:right">${u.input.toLocaleString()}</td>
        <td style="text-align:right">${u.output.toLocaleString()}</td>
        <td style="text-align:right">${u.interactions.toLocaleString()}</td>
        <td>${h(u.lastActive ?? '—')}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
</details>` : ''}`;

		adminInteractiveJs = `
(function () {
  // ── Admin period tabs ────────────────────────────────────────────────────
  function activateAdminPeriod(period) {
    document.querySelectorAll('#admin-period-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
    var btn = document.querySelector('#admin-period-tabs .tab[data-period="' + period + '"]');
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.admin-stats-panel').forEach(function(el) {
      el.classList.toggle('hidden', el.id !== period);
    });
  }
  document.querySelectorAll('#admin-period-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      activateAdminPeriod(btn.getAttribute('data-period'));
    });
  });

  // ── Admin chart ──────────────────────────────────────────────────────────
  var canvas = document.getElementById('admin-trend-chart');
  if (!canvas || !ADMIN_CHART_DATA.length) return;

  var MODEL_PALETTE  = ['#58a6ff','#3fb950','#bc8cff','#f0883e','#e3b341','#f778ba','#79c0ff','#56d364','#d2a8ff','#ffa657'];
  var CLAUDE_COLORS  = ['#bc8cff','#a371f7','#d2a8ff','#6e40c9','#8250df'];
  var GPT_COLORS     = ['#58a6ff','#388bfd','#1f6feb','#79c0ff'];
  var GEMINI_COLORS  = ['#3fb950','#2ea043','#56d364'];
  var EDITOR_COLORS  = ['#58a6ff','#3fb950','#bc8cff','#f0883e','#e3b341','#f778ba'];
  var USER_COLORS    = ['#f0883e','#e3b341','#f778ba','#bc8cff','#58a6ff','#3fb950','#79c0ff','#56d364','#d2a8ff','#ffa657'];
  var colorIdx = { claude: 0, gpt: 0, gemini: 0, other: 0, editor: 0, user: 0 };
  var modelColorMap = {}, editorColorMap = {}, userColorMap = {};

  function getModelColor(m) {
    if (!modelColorMap[m]) {
      if (m.includes('claude'))             modelColorMap[m] = CLAUDE_COLORS[colorIdx.claude++  % CLAUDE_COLORS.length];
      else if (m.match(/\\bgpt|o[134]\\b/)) modelColorMap[m] = GPT_COLORS[colorIdx.gpt++     % GPT_COLORS.length];
      else if (m.includes('gemini'))        modelColorMap[m] = GEMINI_COLORS[colorIdx.gemini++ % GEMINI_COLORS.length];
      else                                   modelColorMap[m] = MODEL_PALETTE[colorIdx.other++  % MODEL_PALETTE.length];
    }
    return modelColorMap[m];
  }
  function getEditorColor(e) {
    if (!editorColorMap[e]) editorColorMap[e] = EDITOR_COLORS[colorIdx.editor++ % EDITOR_COLORS.length];
    return editorColorMap[e];
  }
  function getUserColor(u) {
    if (!userColorMap[u]) userColorMap[u] = USER_COLORS[colorIdx.user++ % USER_COLORS.length];
    return userColorMap[u];
  }

  var allModels  = [...new Set(ADMIN_CHART_DATA.map(function(r) { return r.model; }))].sort();
  var allEditors = [...new Set(ADMIN_CHART_DATA.map(function(r) { return r.editor; }))].sort();
  // Sort users by total tokens descending so legend order matches the top-users table
  var userTokenTotals = {};
  ADMIN_CHART_DATA.forEach(function(r) { userTokenTotals[r.user] = (userTokenTotals[r.user] || 0) + r.inputTokens + r.outputTokens; });
  var allUsers = Object.keys(userTokenTotals).sort(function(a, b) { return userTokenTotals[b] - userTokenTotals[a]; });
  allModels.forEach(getModelColor);
  allEditors.forEach(getEditorColor);
  allUsers.forEach(getUserColor);

  function toWeekStart(day) {
    var d = new Date(day + 'T00:00:00Z');
    var dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  function toMonth(day) { return day.slice(0, 7); }

  function buildDatasets(grouped, labels, dims, colorFn) {
    return dims
      .map(function(dim) {
        return {
          label: dim,
          data: labels.map(function(l) { return Math.round((grouped[l] && grouped[l][dim] || 0) / 1000); }),
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
    if (currentChartDays === 0) { return ADMIN_CHART_DATA; }
    var cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - (currentChartDays - 1));
    var cutoffStr = cutoff.toISOString().slice(0, 10);
    return ADMIN_CHART_DATA.filter(function(r) { return r.day >= cutoffStr; });
  }
  function getDims() {
    if (currentGroup === 'editor') return allEditors;
    if (currentGroup === 'user')   return allUsers;
    return allModels;
  }
  function getColorFn() {
    if (currentGroup === 'editor') return getEditorColor;
    if (currentGroup === 'user')   return getUserColor;
    return getModelColor;
  }
  function getDimKey(r) {
    if (currentGroup === 'editor') return r.editor;
    if (currentGroup === 'user')   return r.user || 'Other';
    return r.model;
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
          if (isLog) { var log = Math.log10(v); if (Math.abs(log - Math.round(log)) > 0.01) { return null; } }
          return v >= 1000 ? (v/1000).toFixed(1)+'M' : v+'K';
        },
      },
      title: { display: true, text: 'Tokens (K)', color: '#8b949e', font: { size: 11 } },
    };
  }

  var initGrouped = {};
  ADMIN_CHART_DATA.forEach(function(r) {
    if (!initGrouped[r.day]) initGrouped[r.day] = {};
    initGrouped[r.day][r.model] = (initGrouped[r.day][r.model] || 0) + r.inputTokens + r.outputTokens;
  });
  var initLabels = [...new Set(ADMIN_CHART_DATA.map(function(r) { return r.day; }))].sort();

  var adminChart = new Chart(canvas, {
    type: 'bar',
    data: { labels: initLabels, datasets: buildDatasets(initGrouped, initLabels, allModels, getModelColor) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 16, font: { size: 11 } } },
        y: makeYAxisConfig(),
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#c9d1d9', boxWidth: 11, padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
          callbacks: {
            label: function(ctx) {
              var v = ctx.parsed.y;
              return '  ' + ctx.dataset.label + ': ' + (v >= 1000 ? (v/1000).toFixed(1)+'M' : v+'K') + ' tokens';
            },
            footer: function(items) {
              var total = items.reduce(function(s,i) { return s + i.parsed.y; }, 0);
              return 'Total: ' + (total >= 1000 ? (total/1000).toFixed(1)+'M' : total+'K') + ' tokens';
            },
          },
        },
      },
    },
  });

  function rebuildAdminChart() {
    var filteredData = getChartData();
    var keyFn = currentView === 'week' ? toWeekStart : currentView === 'month' ? toMonth : function(d) { return d; };
    var filteredMap = {};
    filteredData.forEach(function(r) {
      var label = keyFn(r.day);
      var dim = getDimKey(r);
      if (!filteredMap[label]) filteredMap[label] = {};
      filteredMap[label][dim] = (filteredMap[label][dim] || 0) + r.inputTokens + r.outputTokens;
    });
    var labels = [...new Set(filteredData.map(function(r) { return keyFn(r.day); }))].sort();
    adminChart.data.labels   = labels;
    adminChart.data.datasets = buildDatasets(filteredMap, labels, getDims(), getColorFn());
    adminChart.options.scales.x.stacked = currentScale !== 'log';
    adminChart.options.scales.y = makeYAxisConfig();
    adminChart.update();
  }

  document.querySelectorAll('#admin-chart-period-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#admin-chart-period-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentChartDays = parseInt(btn.getAttribute('data-chart-period'), 10);
      rebuildAdminChart();
    });
  });
  document.querySelectorAll('#admin-scale-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#admin-scale-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentScale = btn.getAttribute('data-scale');
      rebuildAdminChart();
    });
  });
  document.querySelectorAll('#admin-group-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#admin-group-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentGroup = btn.getAttribute('data-group');
      rebuildAdminChart();
    });
  });
  document.querySelectorAll('#admin-view-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#admin-view-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentView = btn.getAttribute('data-view');
      rebuildAdminChart();
    });
  });
})();`;
	}

	// ── Interactive JS ────────────────────────────────────────────────────────
	const interactiveJs = `
(function () {
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
          data: labels.map(function(l) { return Math.round((grouped[l] && grouped[l][dim] || 0) / 1000); }),
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
          return v >= 1000 ? (v/1000).toFixed(1)+'M' : v+'K';
        },
      },
      title: { display: true, text: 'Tokens (K)', color: '#8b949e', font: { size: 11 } },
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
        x: { stacked: true, grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 16, font: { size: 11 } } },
        y: makeYAxisConfig(),
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#c9d1d9', boxWidth: 11, padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
          callbacks: {
            label: function(ctx) {
              var v = ctx.parsed.y;
              return '  ' + ctx.dataset.label + ': ' + (v >= 1000 ? (v/1000).toFixed(1)+'M' : v+'K') + ' tokens';
            },
            footer: function(items) {
              var total = items.reduce(function(s,i) { return s + i.parsed.y; }, 0);
              return 'Total: ' + (total >= 1000 ? (total/1000).toFixed(1)+'M' : total+'K') + ' tokens';
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
	const stageColorMap: Record<number, string> = { 1: '#93c5fd', 2: '#6ee7b7', 3: '#3b82f6', 4: '#10b981' };
	const stageColor = fluencyScore ? (stageColorMap[fluencyScore.overallStage] ?? '#93c5fd') : '#93c5fd';

	const fluencyBadgeHtml = fluencyScore ? `
<button class="fluency-badge" id="fluency-badge-btn" title="View your AI Fluency Score details">
  <span class="fb-icon">🎯</span>
  <div>
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
    var labels   = FLUENCY_DATA.map(function(c) { return c.icon + ' ' + c.category; });
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
              stepSize: 1, color: '#8b949e', backdropColor: 'transparent', font: { size: 10 },
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
  <h1>🤖 Copilot Token Tracker</h1>
  <span class="spacer"></span>
  ${fluencyBadgeHtml}
  ${isAdmin ? `<a href="/admin" style="margin-left:8px;color:#e3b341">👑 Admin</a>` : ''}
  ${avatarUrl ? `<img src="${avatarUrl}" class="avatar-sm" alt="${login}" style="margin-left:8px">` : ''}
  <span style="color:#c9d1d9;font-size:0.875rem">${displayName}</span>
  <a href="/auth/logout" style="margin-left:8px">Sign out</a>
</div>
<div class="content">
  ${profileHtml}
  ${adminSectionHtml}
  ${summaryHtml}
  ${editorsHtml}
  ${chartHtml}
  ${tableHtml}
  ${adminUsersHtml}
</div>
${fluencyModalHtml}

<script>
var CHART_DATA = ${safeJson(chartData)};
</script>
${allUploads !== undefined ? `<script>var ADMIN_CHART_DATA = ${safeJson(adminChartData)};</script>` : ''}
<script>${_chartJsCode}</script>
<script>${interactiveJs}</script>
${adminInteractiveJs ? `<script>${adminInteractiveJs}</script>` : ''}
<script>
// Re-compute "Today" stats using browser's local timezone (server pre-renders in UTC)
(function() {
  function fmtLocal(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
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
${allUploads !== undefined ? `<script>
// Re-compute admin "Today" stats using browser's local timezone
(function() {
  function fmtLocal(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  var todayLocal = new Date().toLocaleDateString('sv-SE');
  var todayData = ADMIN_CHART_DATA.filter(function(r) { return r.day === todayLocal; });
  var inputTokens = todayData.reduce(function(s, r) { return s + r.inputTokens; }, 0);
  var outputTokens = todayData.reduce(function(s, r) { return s + r.outputTokens; }, 0);
  var interactions = todayData.reduce(function(s, r) { return s + r.interactions; }, 0);
  var activeUsers = new Set(todayData.map(function(r) { return r.user; })).size;
  var panel = document.getElementById('admin-stats-today');
  if (panel) {
    var values = panel.querySelectorAll('.stat-card .value');
    if (values[0]) values[0].textContent = fmtLocal(inputTokens);
    if (values[1]) values[1].textContent = fmtLocal(outputTokens);
    if (values[2]) values[2].textContent = fmtLocal(interactions);
    if (values[3]) values[3].textContent = String(activeUsers);
  }
})();
</script>` : ''}
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
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
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
          return Math.round(total / 1000);
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
          return Math.round(total / 1000);
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
        return Math.round(total / logins.length / 1000);
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
        callback: function(v) { return v >= 1000 ? (v/1000).toFixed(1)+'M' : v+'K'; },
      },
      title: { display: true, text: 'Tokens (K)', color: '#8b949e', font: { size: 11 } },
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
        x: { stacked: true, grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 20, font: { size: 11 } } },
        y: makeYConfig(true),
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#c9d1d9', boxWidth: 11, padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
          callbacks: {
            label: function(ctx) {
              var v = ctx.parsed.y;
              return '  ' + ctx.dataset.label + ': ' + (v >= 1000 ? (v/1000).toFixed(1)+'M' : v+'K') + ' tokens';
            },
            footer: function(items) {
              var total = items.reduce(function(s, i) { return s + i.parsed.y; }, 0);
              return 'Total: ' + (total >= 1000 ? (total/1000).toFixed(1)+'M' : total+'K') + ' tokens';
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
    chart.options.scales.y.title.text = currentMode === 'total' ? 'Tokens (K)' : 'Avg Tokens/User (K)';
    chart.update();
  }
})();`;

	return layout('Admin Dashboard', `
<div class="header">
  <h1>🤖 Copilot Token Tracker — Admin</h1>
  <span class="spacer"></span>
  ${adminAvatar ? `<img src="${adminAvatar}" class="avatar-sm" alt="${adminLogin}" style="margin-left:8px">` : ''}
  <span style="color:#c9d1d9;font-size:0.875rem">${adminName}</span>
  <a href="/dashboard" style="margin-left:8px">My Dashboard</a>
  <a href="/auth/logout" style="margin-left:8px">Sign out</a>
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
<div class="header"><h1>🤖 Copilot Token Tracker Sharing</h1></div>
<div class="content" style="text-align:center; margin-top:80px; align-items:center">
  <h2 style="color:#e6edf3">Something went wrong</h2>
  <p style="color:#8b949e">${h(message)}</p>
  <a href="/dashboard" class="btn btn-secondary">Back to Dashboard</a>
</div>`);
}

function randomState(): string {
	return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
