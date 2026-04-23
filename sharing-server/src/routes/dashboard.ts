import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
	encodeSession, decodeSession, makeClaims,
	COOKIE_NAME, OAUTH_STATE_COOKIE, SESSION_MAX_AGE,
} from '../session.js';
import { getUserById, getUserByGithubId, getUploadsForUser, getAllUsers, upsertUser, type UploadRow, type UserRow } from '../db.js';

export const dashboard = new Hono();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

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
  .stats-panel.hidden { display: none; }

  /* ── Editor bars ── */
  .editor-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .editor-label { min-width: 110px; text-align: right; font-size: 0.85rem; color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
<div class="content" style="text-align:center; margin-top: 80px; align-items:center">
  <h2 style="color:#e6edf3">Sign in to view your usage dashboard</h2>
  <p style="color:#8b949e">Your data is linked to your GitHub account. No account creation needed.</p>
  <a href="/auth/github" class="btn btn-primary" style="font-size:1rem; padding:12px 28px">
    Sign in with GitHub
  </a>
  <p style="color:#8b949e; margin-top:32px; font-size:0.85rem">
    The VS Code extension uploads data automatically using your existing GitHub session —
    no separate sign-in required.
  </p>
</div>`);
}

function dashboardPage(user: UserRow, uploads: UploadRow[], isAdmin: boolean, allUsers?: UserRow[]): string {
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
      <div class="tabs" id="group-tabs">
        <button class="tab active" data-group="model">By Model</button>
        <button class="tab" data-group="editor">By Editor</button>
      </div>
      <div class="tabs" id="view-tabs">
        <button class="tab active" data-view="day">Day</button>
        <button class="tab" data-view="week">Week</button>
        <button class="tab" data-view="month">Month</button>
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

	const adminHtml = isAdmin && allUsers ? `
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

	// ── Interactive JS ────────────────────────────────────────────────────────
	const interactiveJs = `
(function () {
  // ── Period tabs ─────────────────────────────────────────────────────────
  document.querySelectorAll('#period-tabs .tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#period-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var target = btn.getAttribute('data-period');
      document.querySelectorAll('.stats-panel').forEach(function(el) {
        el.classList.toggle('hidden', el.id !== target);
      });
    });
  });

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

  var currentGroup = 'model', currentView = 'day';
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
        y: { stacked: true, grid: { color: '#21262d' },
          ticks: { color: '#8b949e', font: { size: 11 },
            callback: function(v) { return v >= 1000 ? (v/1000).toFixed(1)+'M' : v+'K'; } },
          title: { display: true, text: 'Tokens (K)', color: '#8b949e', font: { size: 11 } },
        },
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
    var keyFn = currentView === 'week' ? toWeekStart : currentView === 'month' ? toMonth : function(d) { return d; };
    grouped = aggregate(keyFn, currentGroup);
    labels  = [...new Set(CHART_DATA.map(function(r) { return keyFn(r.day); }))].sort();
    var dims     = currentGroup === 'editor' ? allEditors : allModels;
    var colorFn  = currentGroup === 'editor' ? getEditorColor : getModelColor;
    chart.data.labels   = labels;
    chart.data.datasets = buildDatasets(grouped, labels, dims, colorFn);
    chart.update();
  }

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

	return layout(`${user.github_login}'s Dashboard`, `
<div class="header">
  <h1>🤖 Copilot Token Tracker</h1>
  <span class="spacer"></span>
  ${avatarUrl ? `<img src="${avatarUrl}" class="avatar-sm" alt="${login}">` : ''}
  <span style="color:#c9d1d9;font-size:0.875rem">${displayName}</span>
  <a href="/auth/logout" style="margin-left:8px">Sign out</a>
</div>
<div class="content">
  ${profileHtml}
  ${summaryHtml}
  ${editorsHtml}
  ${chartHtml}
  ${tableHtml}
  ${adminHtml}
</div>

<script>
var CHART_DATA = ${safeJson(chartData)};
</script>
<script>${_chartJsCode}</script>
<script>${interactiveJs}</script>`);
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
