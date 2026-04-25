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

/** POST /auth/pat — Sign in with a GitHub Personal Access Token. */
dashboard.post('/auth/pat', async (c) => {
	const body = await c.req.parseBody();
	const token = (body['pat'] as string ?? '').trim();

	if (!token) {
		return c.html(errorPage('No token provided.'), 400);
	}

	// Fetch the authenticated user
	let userData: { id: number; login: string; name: string | null; avatar_url: string };
	try {
		const userRes = await fetch('https://api.github.com/user', {
			headers: {
				Authorization: `Bearer ${token}`,
				'User-Agent': 'copilot-sharing-server/1.0',
				Accept: 'application/vnd.github+json',
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!userRes.ok) {
			return c.html(errorPage('Invalid token or unable to verify GitHub identity.'), 401);
		}
		userData = await userRes.json() as typeof userData;
	} catch (err) {
		return c.html(errorPage(`Failed to reach GitHub: ${String(err)}`), 502);
	}

	// Optional org membership check
	const allowedOrg = process.env.ALLOWED_GITHUB_ORG;
	if (allowedOrg) {
		try {
			const memberRes = await fetch(`https://api.github.com/user/memberships/orgs/${allowedOrg}`, {
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': 'copilot-sharing-server/1.0',
					Accept: 'application/vnd.github+json',
				},
				signal: AbortSignal.timeout(10_000),
			});
			if (memberRes.status === 403) {
				return c.html(errorPage(
					`Access denied: your token is not authorized for the "${allowedOrg}" organization. ` +
					`If this org uses SAML SSO, go to github.com → Settings → Personal access tokens, ` +
					`click your token, and grant SSO access to the "${allowedOrg}" org.`
				), 403);
			}
			if (memberRes.status !== 200) {
				return c.html(errorPage(`Access denied: you are not a member of the "${allowedOrg}" organization.`), 403);
			}
			const membership = await memberRes.json() as { state: string };
			if (membership.state !== 'active') {
				return c.html(errorPage(`Access denied: your membership in the "${allowedOrg}" organization is not active.`), 403);
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

// ── Fluency Scoring ───────────────────────────────────────────────────────────

/** Tools operated automatically by Copilot (excluded from user-driven tool scoring). */
const AUTOMATIC_TOOLS = new Set([
	'get_errors', 'read_file', 'list_dir', 'list_files', 'grep_search',
	'file_search', 'codebase_search', 'semantic_search', 'find_references',
	'codesearch', 'run_tests', 'check_errors', 'view_line_range', 'get_file_contents',
	'read_resource', 'list_resources', 'list_tools', 'list_servers', 'get_resource',
]);

interface AggregatedFluency {
	askModeCount: number;
	editModeCount: number;
	agentModeCount: number;
	cliModeCount: number;
	toolCallsByTool: Record<string, number>;
	toolCallsTotal: number;
	ctxFile: number; ctxSelection: number; ctxSymbol: number;
	ctxCodebase: number; ctxWorkspace: number; ctxTerminal: number;
	ctxVscode: number; ctxClipboard: number; ctxChanges: number;
	ctxProblemsPanel: number; ctxOutputPanel: number;
	ctxTerminalLastCommand: number; ctxTerminalSelection: number;
	ctxByKind: Record<string, number>;
	mcpTotal: number;
	mcpByServer: Record<string, number>;
	mixedTierSessions: number;
	switchingFreqSum: number; switchingFreqCount: number;
	standardModels: Set<string>; premiumModels: Set<string>;
	multiFileEdits: number;
	filesPerEditSum: number; filesPerEditCount: number;
	editsAgentCount: number; workspaceAgentCount: number;
	repositories: Set<string>; repositoriesWithCustomization: Set<string>;
	applyRateSum: number; applyRateCount: number;
	multiTurnSessions: number;
	turnsPerSessionSum: number; turnsPerSessionCount: number;
	sessionCount: number;
	hasData: boolean;
}

function aggregateFluencyMetrics(uploads: UploadRow[]): AggregatedFluency {
	const agg: AggregatedFluency = {
		askModeCount: 0, editModeCount: 0, agentModeCount: 0, cliModeCount: 0,
		toolCallsByTool: {}, toolCallsTotal: 0,
		ctxFile: 0, ctxSelection: 0, ctxSymbol: 0, ctxCodebase: 0, ctxWorkspace: 0,
		ctxTerminal: 0, ctxVscode: 0, ctxClipboard: 0, ctxChanges: 0,
		ctxProblemsPanel: 0, ctxOutputPanel: 0, ctxTerminalLastCommand: 0, ctxTerminalSelection: 0,
		ctxByKind: {},
		mcpTotal: 0, mcpByServer: {},
		mixedTierSessions: 0, switchingFreqSum: 0, switchingFreqCount: 0,
		standardModels: new Set(), premiumModels: new Set(),
		multiFileEdits: 0, filesPerEditSum: 0, filesPerEditCount: 0,
		editsAgentCount: 0, workspaceAgentCount: 0,
		repositories: new Set(), repositoriesWithCustomization: new Set(),
		applyRateSum: 0, applyRateCount: 0,
		multiTurnSessions: 0, turnsPerSessionSum: 0, turnsPerSessionCount: 0,
		sessionCount: 0, hasData: false,
	};

	for (const upload of uploads) {
		if (!upload.fluency_json) continue;
		try {
			const fm = JSON.parse(upload.fluency_json) as Record<string, unknown>;
			agg.hasData = true;

			agg.askModeCount += (fm.askModeCount as number) || 0;
			agg.editModeCount += (fm.editModeCount as number) || 0;
			agg.agentModeCount += (fm.agentModeCount as number) || 0;
			agg.cliModeCount += (fm.cliModeCount as number) || 0;
			agg.multiFileEdits += (fm.multiFileEdits as number) || 0;
			agg.multiTurnSessions += (fm.multiTurnSessions as number) || 0;
			agg.sessionCount += (fm.sessionCount as number) || 1;

			if (fm.avgTurnsPerSession !== undefined) {
				agg.turnsPerSessionSum += (fm.avgTurnsPerSession as number) || 0;
				agg.turnsPerSessionCount++;
			}

			if (fm.toolCallsJson) {
				try {
					const tc = JSON.parse(fm.toolCallsJson as string) as Record<string, unknown>;
					agg.toolCallsTotal += (tc.total as number) || 0;
					for (const [k, v] of Object.entries((tc.byTool as Record<string, number>) || {})) {
						agg.toolCallsByTool[k] = (agg.toolCallsByTool[k] || 0) + (v || 0);
					}
				} catch { /* skip */ }
			}

			if (fm.contextRefsJson) {
				try {
					const cr = JSON.parse(fm.contextRefsJson as string) as Record<string, unknown>;
					agg.ctxFile += (cr.file as number) || 0;
					agg.ctxSelection += (cr.selection as number) || 0;
					agg.ctxSymbol += (cr.symbol as number) || 0;
					agg.ctxCodebase += (cr.codebase as number) || 0;
					agg.ctxWorkspace += (cr.workspace as number) || 0;
					agg.ctxTerminal += (cr.terminal as number) || 0;
					agg.ctxVscode += (cr.vscode as number) || 0;
					agg.ctxClipboard += (cr.clipboard as number) || 0;
					agg.ctxChanges += (cr.changes as number) || 0;
					agg.ctxProblemsPanel += (cr.problemsPanel as number) || 0;
					agg.ctxOutputPanel += (cr.outputPanel as number) || 0;
					agg.ctxTerminalLastCommand += (cr.terminalLastCommand as number) || 0;
					agg.ctxTerminalSelection += (cr.terminalSelection as number) || 0;
					for (const [k, v] of Object.entries((cr.byKind as Record<string, number>) || {})) {
						agg.ctxByKind[k] = (agg.ctxByKind[k] || 0) + (v || 0);
					}
				} catch { /* skip */ }
			}

			if (fm.mcpToolsJson) {
				try {
					const mcp = JSON.parse(fm.mcpToolsJson as string) as Record<string, unknown>;
					agg.mcpTotal += (mcp.total as number) || 0;
					for (const [k, v] of Object.entries((mcp.byServer as Record<string, number>) || {})) {
						agg.mcpByServer[k] = (agg.mcpByServer[k] || 0) + (v || 0);
					}
				} catch { /* skip */ }
			}

			if (fm.modelSwitchingJson) {
				try {
					const ms = JSON.parse(fm.modelSwitchingJson as string) as Record<string, unknown>;
					agg.mixedTierSessions += (ms.mixedTierSessions as number) || 0;
					if (ms.switchingFrequency !== undefined) {
						agg.switchingFreqSum += (ms.switchingFrequency as number) || 0;
						agg.switchingFreqCount++;
					}
					for (const m of (ms.standardModels as string[]) || []) { agg.standardModels.add(m); }
					for (const m of (ms.premiumModels as string[]) || []) { agg.premiumModels.add(m); }
				} catch { /* skip */ }
			}

			if (fm.editScopeJson) {
				try {
					const es = JSON.parse(fm.editScopeJson as string) as Record<string, unknown>;
					const editSessions = ((es.singleFileEdits as number) || 0) + ((es.multiFileEdits as number) || 0);
					if (editSessions > 0) {
						agg.filesPerEditSum += (es.totalEditedFiles as number) || 0;
						agg.filesPerEditCount += editSessions;
					}
				} catch { /* skip */ }
			}

			if (fm.agentTypesJson) {
				try {
					const at = JSON.parse(fm.agentTypesJson as string) as Record<string, number>;
					agg.editsAgentCount += at.editsAgent || 0;
					agg.workspaceAgentCount += at.workspaceAgent || 0;
				} catch { /* skip */ }
			}

			if (fm.repositoriesJson) {
				try {
					const rj = JSON.parse(fm.repositoriesJson as string) as { repositories?: string[]; repositoriesWithCustomization?: string[] };
					for (const r of rj.repositories || []) { agg.repositories.add(r); }
					for (const r of rj.repositoriesWithCustomization || []) { agg.repositoriesWithCustomization.add(r); }
				} catch { /* skip */ }
			}

			if (fm.applyUsageJson) {
				try {
					const au = JSON.parse(fm.applyUsageJson as string) as Record<string, number>;
					if (au.applyRate !== undefined) {
						agg.applyRateSum += au.applyRate || 0;
						agg.applyRateCount++;
					}
				} catch { /* skip */ }
			}
		} catch { /* skip malformed rows */ }
	}

	return agg;
}

interface CategoryScore { category: string; icon: string; stage: number; tips: string[] }
interface FluencyScore {
	overallStage: number;
	overallLabel: string;
	categories: CategoryScore[];
}

function computeFluencyScore(fd: AggregatedFluency, dashboardSessions: number): FluencyScore {
	const stageLabels: Record<number, string> = {
		1: 'Stage 1: AI Skeptic',
		2: 'Stage 2: AI Explorer',
		3: 'Stage 3: AI Collaborator',
		4: 'Stage 4: AI Strategist',
	};

	const totalInteractions = fd.askModeCount + fd.editModeCount + fd.agentModeCount + fd.cliModeCount;
	const avgTurnsPerSession = fd.turnsPerSessionCount > 0 ? fd.turnsPerSessionSum / fd.turnsPerSessionCount : 0;
	const switchingFrequency = fd.switchingFreqCount > 0 ? fd.switchingFreqSum / fd.switchingFreqCount : 0;
	const hasModelSwitching = fd.mixedTierSessions > 0 || switchingFrequency > 0;
	const hasAgentMode = (fd.agentModeCount + fd.cliModeCount) > 0;
	const nonAutoToolCount = Object.keys(fd.toolCallsByTool).filter(t => !AUTOMATIC_TOOLS.has(t.toLowerCase())).length;
	const avgFilesPerSession = fd.filesPerEditCount > 0 ? fd.filesPerEditSum / fd.filesPerEditCount : 0;
	const avgApplyRate = fd.applyRateCount > 0 ? fd.applyRateSum / fd.applyRateCount : 0;
	const totalContextRefs = fd.ctxFile + fd.ctxSelection + fd.ctxSymbol + fd.ctxCodebase + fd.ctxWorkspace;

	// 1. Prompt Engineering
	let peStage = 1;
	const slashCmds = ['explain', 'fix', 'tests', 'doc', 'generate', 'optimize', 'new', 'search', 'fixTestFailure', 'setupTests'];
	const usedSlashCommands = slashCmds.filter(cmd => (fd.toolCallsByTool[cmd] ?? 0) > 0);
	if (avgTurnsPerSession >= 3 || totalInteractions >= 5) peStage = Math.max(peStage, 2);
	if (avgTurnsPerSession >= 5) peStage = Math.max(peStage, 3);
	if (totalInteractions >= 30 && (usedSlashCommands.length >= 2 || hasAgentMode)) peStage = Math.max(peStage, 3);
	if (totalInteractions >= 100 && hasAgentMode && (hasModelSwitching || usedSlashCommands.length >= 3)) peStage = 4;
	if (hasModelSwitching && fd.mixedTierSessions > 0) peStage = Math.max(peStage, 3);
	const peTips: string[] = [];
	if (peStage < 2) peTips.push('Try asking Copilot a question using the Chat panel');
	if (peStage < 3) {
		if (!hasAgentMode) peTips.push('Try agent mode for multi-file changes');
		if (usedSlashCommands.length < 2) peTips.push('Use slash commands like /explain, /fix, or /tests for structured prompts');
	}
	if (peStage < 4) {
		if (!hasAgentMode) peTips.push('Try agent mode for autonomous, multi-step coding tasks');
		if (!hasModelSwitching) peTips.push('Experiment with different models — fast ones for simple queries, reasoning models for complex problems');
	}

	// 2. Context Engineering
	const usedRefTypeCount = [
		fd.ctxFile, fd.ctxSelection, fd.ctxSymbol, fd.ctxCodebase, fd.ctxWorkspace,
		fd.ctxTerminal, fd.ctxVscode, fd.ctxClipboard, fd.ctxChanges,
		fd.ctxProblemsPanel, fd.ctxOutputPanel, fd.ctxTerminalLastCommand, fd.ctxTerminalSelection,
	].filter(v => v > 0).length;
	let ceStage = 1;
	if (totalContextRefs >= 1) ceStage = 2;
	if (usedRefTypeCount >= 3 && totalContextRefs >= 10) ceStage = 3;
	if (usedRefTypeCount >= 5 && totalContextRefs >= 30) ceStage = 4;
	if ((fd.ctxByKind['copilot.image'] ?? 0) > 0) ceStage = Math.max(ceStage, 3);
	const ceTips: string[] = [];
	if (ceStage < 2) ceTips.push('Add #file or #selection references to give Copilot more context');
	if (ceStage < 3) ceTips.push('Explore @workspace, #codebase, and @terminal for broader context');
	if (ceStage < 4) ceTips.push('Try #changes, #problemsPanel, #outputPanel, and image attachments for advanced context');

	// 3. Agentic
	let agStage = 1;
	if (hasAgentMode || fd.multiFileEdits > 0 || fd.editsAgentCount > 0) agStage = 2;
	if (avgFilesPerSession >= 3) agStage = Math.max(agStage, 3);
	if (fd.agentModeCount >= 10 && nonAutoToolCount >= 3) agStage = Math.max(agStage, 3);
	if (fd.agentModeCount >= 50 && nonAutoToolCount >= 5) agStage = 4;
	if (fd.multiFileEdits >= 20 && avgFilesPerSession >= 3) agStage = Math.max(agStage, 4);
	const agTips: string[] = [];
	if (agStage < 2) agTips.push('Try agent mode — it can run terminal commands, edit files, and explore your codebase');
	if (agStage < 3) agTips.push('Use agent mode for multi-step tasks; let it chain tools like file search, terminal, and code edits');
	if (agStage < 4) agTips.push('Tackle complex refactoring or debugging tasks in agent mode for deeper autonomous workflows');

	// 4. Tool Usage
	let tuStage = 1;
	if (nonAutoToolCount > 0) tuStage = 2;
	if (fd.workspaceAgentCount > 0) tuStage = Math.max(tuStage, 3);
	const advancedTools = ['github_pull_request', 'github_repo', 'run_in_terminal', 'editFiles', 'listFiles'];
	if (advancedTools.filter(t => (fd.toolCallsByTool[t] ?? 0) > 0).length >= 2) tuStage = Math.max(tuStage, 3);
	if (fd.mcpTotal > 0) tuStage = Math.max(tuStage, 3);
	if (Object.keys(fd.mcpByServer).length >= 2) tuStage = 4;
	const tuTips: string[] = [];
	if (tuStage < 2) tuTips.push('Try agent mode to let Copilot use built-in tools for file operations and terminal commands');
	if (tuStage < 3) {
		if (fd.mcpTotal === 0) tuTips.push('Set up MCP servers to connect Copilot to external tools (databases, APIs, cloud services)');
		else tuTips.push('Explore GitHub integrations and advanced tools like editFiles and run_in_terminal');
	}
	if (tuStage < 4) {
		if (Object.keys(fd.mcpByServer).length === 1) tuTips.push('Add more MCP servers to expand Copilot\'s capabilities');
		else if (fd.mcpTotal === 0) tuTips.push('Explore MCP servers for tools that integrate with your workflow');
	}

	// 5. Customization
	const totalRepos = fd.repositories.size;
	const reposWithCustomization = fd.repositoriesWithCustomization.size;
	const customizationRate = totalRepos > 0 ? reposWithCustomization / totalRepos : 0;
	let cuStage = 1;
	if (reposWithCustomization > 0) cuStage = 2;
	if (customizationRate >= 0.3 && reposWithCustomization >= 2) cuStage = 3;
	if (customizationRate >= 0.7 && reposWithCustomization >= 3) cuStage = 4;
	const uniqueModels = new Set([...fd.standardModels, ...fd.premiumModels]);
	if (uniqueModels.size >= 3) cuStage = Math.max(cuStage, 3);
	if (uniqueModels.size >= 5 && reposWithCustomization >= 3) cuStage = 4;
	const cuTips: string[] = [];
	if (cuStage < 2) cuTips.push('Create a .github/copilot-instructions.md file with project-specific guidelines');
	if (cuStage < 3) cuTips.push('Add custom instructions to more repositories to standardize your Copilot experience');
	if (cuStage < 4) {
		const uncustomized = totalRepos - reposWithCustomization;
		if (uncustomized > 0) cuTips.push(`${reposWithCustomization} of ${totalRepos} repos customized — add instructions to the remaining ${uncustomized}`);
		else cuTips.push('Aim for consistent customization across all projects');
	}

	// 6. Workflow Integration
	const effectiveSessions = Math.max(dashboardSessions, fd.sessionCount);
	const modesUsed = [fd.askModeCount > 0, fd.agentModeCount > 0].filter(Boolean).length;
	let wiStage = 1;
	if (effectiveSessions >= 3 || avgApplyRate >= 50) wiStage = 2;
	if (modesUsed >= 2 || totalContextRefs >= 20) wiStage = Math.max(wiStage, 3);
	if (effectiveSessions >= 15 && modesUsed >= 2 && totalContextRefs >= 20) wiStage = 4;
	const wiTips: string[] = [];
	if (wiStage < 2) wiTips.push('Use Copilot more regularly — even for quick questions');
	if (wiStage < 3) {
		if (modesUsed < 2) wiTips.push('Combine ask mode with agent mode in your daily workflow');
		if (totalContextRefs < 10) wiTips.push('Use explicit context references like #file, @workspace, and #selection');
	}
	if (wiStage < 4) wiTips.push('Make Copilot part of every coding task: planning, coding, testing, and reviewing');

	// Overall: median of 6 category stages
	const scores = [peStage, ceStage, agStage, tuStage, cuStage, wiStage].sort((a, b) => a - b);
	const mid = Math.floor(scores.length / 2);
	const overallStage = scores.length % 2 === 0
		? Math.round((scores[mid - 1] + scores[mid]) / 2)
		: scores[mid];

	return {
		overallStage,
		overallLabel: stageLabels[overallStage] ?? 'Stage 1: AI Skeptic',
		categories: [
			{ category: 'Prompt Engineering', icon: '💬', stage: peStage, tips: peTips },
			{ category: 'Context Engineering', icon: '📎', stage: ceStage, tips: ceTips },
			{ category: 'Agentic', icon: '🤖', stage: agStage, tips: agTips },
			{ category: 'Tool Usage', icon: '🔧', stage: tuStage, tips: tuTips },
			{ category: 'Customization', icon: '⚙️', stage: cuStage, tips: cuTips },
			{ category: 'Workflow Integration', icon: '🔄', stage: wiStage, tips: wiTips },
		],
	};
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
    padding: 14px 16px; }
  .fluency-cat-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .fluency-cat-icon { font-size: 1.1rem; }
  .fluency-cat-name { font-size: 0.85rem; font-weight: 600; color: #c9d1d9; }
  .fluency-stage-pill { display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.72rem; font-weight: 600; margin-left: auto; white-space: nowrap; }
  .stage-1 { background: #6e768166; color: #8b949e; }
  .stage-2 { background: #1f6feb33; color: #58a6ff; }
  .stage-3 { background: #238636aa; color: #3fb950; }
  .stage-4 { background: #b08800aa; color: #e3b341; }
  .fluency-tips { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .fluency-tips li { font-size: 0.8rem; color: #8b949e; padding-left: 14px; position: relative; }
  .fluency-tips li::before { content: "→"; position: absolute; left: 0; color: #58a6ff66; }
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
</style>
</head>
<body>
${body}
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
  </p>
  <div style="color:#8b949e; margin: 24px 0; font-size:0.9rem">— or —</div>` : '';

	return layout('Sign In', `
<div class="header"><h1>🤖 Copilot Token Tracker Sharing</h1></div>
<div class="content" style="text-align:center; margin-top: 80px; align-items:center">
  <h2 style="color:#e6edf3">Sign in to view your usage dashboard</h2>
  <p style="color:#8b949e">Your data is linked to your GitHub account. No account creation needed.</p>
  ${oauthSection}
  <form method="POST" action="/auth/pat" style="max-width:420px; margin:0 auto; text-align:left">
    <label style="color:#8b949e; font-size:0.9rem; display:block; margin-bottom:6px">
      Sign in with a GitHub Personal Access Token (PAT)
    </label>
    <input
      type="password"
      name="pat"
      placeholder="ghp_..."
      required
      autocomplete="off"
      style="width:100%; padding:10px 12px; border-radius:6px; border:1px solid #30363d;
             background:#161b22; color:#e6edf3; font-size:0.95rem; box-sizing:border-box"
    />
    <p style="color:#8b949e; font-size:0.8rem; margin:6px 0 12px">
      Needs <code>read:user</code> scope (and <code>read:org</code> + SSO authorization if your org enforces SAML SSO).
    </p>
    <button type="submit" class="btn btn-primary" style="width:100%; font-size:1rem; padding:10px">
      Sign in with PAT
    </button>
  </form>
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

	// ── Fluency score ─────────────────────────────────────────────────────────
	const fluencyAgg = aggregateFluencyMetrics(uploads);
	const dashSessions = new Set(uploads.map(r => r.day)).size; // use active days as proxy
	const fluencyScore = fluencyAgg.hasData ? computeFluencyScore(fluencyAgg, dashSessions) : null;

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
      location.hash = target;
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
	const stageColors: Record<number, string> = { 1: '#6e7681', 2: '#58a6ff', 3: '#3fb950', 4: '#e3b341' };
	const stageColor = fluencyScore ? (stageColors[fluencyScore.overallStage] ?? '#8b949e') : '#8b949e';

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
		? `<ul class="fluency-tips">${cat.tips.map(t => `<li>${h(t)}</li>`).join('')}</ul>`
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
    var stageColors = { 1: '#6e768166', 2: '#1f6feb88', 3: '#23863688', 4: '#b0880088' };
    var borderColors = { 1: '#6e7681', 2: '#58a6ff', 3: '#3fb950', 4: '#e3b341' };
    var overallStage = ${fluencyScore.overallStage};
    var fillColor   = stageColors[overallStage] || '#58a6ff44';
    var borderColor = borderColors[overallStage] || '#58a6ff';

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
  ${avatarUrl ? `<img src="${avatarUrl}" class="avatar-sm" alt="${login}" style="margin-left:8px">` : ''}
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
<script>${fluencyJs}</script>`);
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
