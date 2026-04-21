import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
	encodeSession, decodeSession, makeClaims,
	COOKIE_NAME, OAUTH_STATE_COOKIE, SESSION_MAX_AGE,
} from '../session.js';
import { getUserById, getUserByGithubId, getUploadsForUser, getAllUsers, upsertUser, type UploadRow, type UserRow } from '../db.js';

export const dashboard = new Hono();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

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
		try {
			const memberRes = await fetch(`https://api.github.com/orgs/${allowedOrg}/members/${userData.login}`, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'User-Agent': 'copilot-sharing-server/1.0',
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

	const user = upsertUser(userData.id, userData.login, userData.name, userData.avatar_url);
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

	return c.html(dashboardPage(user, uploads, isAdmin, allUsers));
});

// ── HTML Rendering ────────────────────────────────────────────────────────────

function h(text: unknown): string {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function layout(title: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} — Copilot Token Tracker Sharing</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; background: #0d1117; color: #e6edf3; min-height: 100vh; }
  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 24px;
    display: flex; align-items: center; gap: 16px; }
  .header h1 { margin: 0; font-size: 1.1rem; color: #58a6ff; }
  .header .spacer { flex: 1; }
  .header a { color: #8b949e; text-decoration: none; font-size: 0.9rem; }
  .header a:hover { color: #e6edf3; }
  .content { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
  h2 { color: #e6edf3; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  h3 { color: #8b949e; font-size: 0.95rem; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { background: #21262d; color: #8b949e; padding: 8px 12px; text-align: left;
    border-bottom: 1px solid #30363d; }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #161b22; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 12px;
    font-size: 0.8rem; background: #1f6feb33; color: #58a6ff; }
  .btn { display: inline-block; padding: 8px 16px; border-radius: 6px; text-decoration: none;
    font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; }
  .btn-primary { background: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-secondary { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
  .btn-secondary:hover { background: #30363d; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 16px 0; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .stat-card .label { color: #8b949e; font-size: 0.85rem; }
  .stat-card .value { font-size: 1.5rem; font-weight: 700; color: #58a6ff; margin-top: 4px; }
  .alert { padding: 12px 16px; border-radius: 6px; margin: 16px 0; }
  .alert-warn { background: #3d2b0030; border: 1px solid #bb8009; color: #e3b341; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; vertical-align: middle; margin-right: 8px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function loginPage(): string {
	return layout('Sign In', `
<div class="header"><h1>🤖 Copilot Token Tracker Sharing</h1></div>
<div class="content" style="text-align:center; margin-top: 80px">
  <h2>Sign in to view your usage dashboard</h2>
  <p style="color:#8b949e">Your data is linked to your GitHub account. No account creation needed.</p>
  <a href="/auth/github" class="btn btn-primary" style="font-size:1rem; padding:12px 24px">
    Sign in with GitHub
  </a>
  <p style="color:#8b949e; margin-top:32px; font-size:0.85rem">
    The VS Code extension uploads data automatically using your existing GitHub session — no separate sign-in needed there.
  </p>
</div>`);
}

function dashboardPage(user: UserRow, uploads: UploadRow[], isAdmin: boolean, allUsers?: UserRow[]): string {
	const totalInput = uploads.reduce((s, r) => s + r.input_tokens, 0);
	const totalOutput = uploads.reduce((s, r) => s + r.output_tokens, 0);
	const totalInteractions = uploads.reduce((s, r) => s + r.interactions, 0);
	const uniqueDays = new Set(uploads.map(r => r.day)).size;

	const rows = uploads.map(r => `
<tr>
  <td>${h(r.day)}</td>
  <td><span class="pill">${h(r.model)}</span></td>
  <td>${h(r.workspace_name ?? r.workspace_id)}</td>
  <td>${h(r.machine_name ?? r.machine_id)}</td>
  <td>${r.input_tokens.toLocaleString()}</td>
  <td>${r.output_tokens.toLocaleString()}</td>
  <td>${r.interactions.toLocaleString()}</td>
</tr>`).join('');

	const adminSection = isAdmin && allUsers ? `
<h2>Admin: All Users</h2>
<table>
  <thead><tr><th>GitHub Login</th><th>Name</th><th>Joined</th><th>Last Seen</th><th>Admin</th></tr></thead>
  <tbody>
    ${allUsers.map(u => `<tr>
      <td><a href="https://github.com/${h(u.github_login)}" target="_blank">${h(u.github_login)}</a></td>
      <td>${h(u.github_name ?? '—')}</td>
      <td>${h(u.created_at.slice(0, 10))}</td>
      <td>${h(u.last_seen_at?.slice(0, 10) ?? '—')}</td>
      <td>${u.is_admin ? '✅' : ''}</td>
    </tr>`).join('')}
  </tbody>
</table>` : '';

	const avatarHtml = user.avatar_url
		? `<img src="${h(user.avatar_url)}" class="avatar" alt="${h(user.github_login)}">`
		: '';

	return layout(`${user.github_login}'s Dashboard`, `
<div class="header">
  <h1>🤖 Copilot Token Tracker</h1>
  <span class="spacer"></span>
  ${avatarHtml}<span>${h(user.github_name ?? user.github_login)}</span>
  <a href="/auth/logout" style="margin-left:16px">Sign out</a>
</div>
<div class="content">
  <h2>Your Usage (last 30 days)</h2>
  <div class="stat-grid">
    <div class="stat-card"><div class="label">Input Tokens</div><div class="value">${fmt(totalInput)}</div></div>
    <div class="stat-card"><div class="label">Output Tokens</div><div class="value">${fmt(totalOutput)}</div></div>
    <div class="stat-card"><div class="label">Interactions</div><div class="value">${fmt(totalInteractions)}</div></div>
    <div class="stat-card"><div class="label">Days with Data</div><div class="value">${uniqueDays}</div></div>
  </div>

  ${uploads.length === 0 ? `
  <div class="alert alert-warn">
    No data yet. Make sure the VS Code extension is configured with this server's endpoint URL
    (<code>copilotTokenTracker.sharingServer.endpointUrl</code>).
  </div>` : `
  <h3>Detailed Breakdown</h3>
  <table>
    <thead><tr><th>Day</th><th>Model</th><th>Workspace</th><th>Machine</th>
      <th>Input Tokens</th><th>Output Tokens</th><th>Interactions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}

  ${adminSection}
</div>`);
}

function errorPage(message: string): string {
	return layout('Error', `
<div class="header"><h1>🤖 Copilot Token Tracker Sharing</h1></div>
<div class="content" style="text-align:center; margin-top:80px">
  <h2>Something went wrong</h2>
  <p style="color:#8b949e">${h(message)}</p>
  <a href="/dashboard" class="btn btn-secondary">Back to Dashboard</a>
</div>`);
}

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function randomState(): string {
	return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
