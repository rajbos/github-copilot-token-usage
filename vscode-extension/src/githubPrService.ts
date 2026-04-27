import * as https from 'https';
import * as childProcess from 'child_process';

export type RepoPrDetail = {
	number: number;
	title: string;
	url: string;
	aiType: 'copilot' | 'claude' | 'openai' | 'other-ai';
	role: 'author' | 'reviewer-requested';
};

export type RepoPrInfo = {
	owner: string;
	repo: string;
	repoUrl: string;
	totalPrs: number;
	aiAuthoredPrs: number;
	aiReviewRequestedPrs: number;
	aiDetails: RepoPrDetail[];
	error?: string;
};

export type RepoPrStatsResult = {
	repos: RepoPrInfo[];
	authenticated: boolean;
	since: string; // ISO date string
};

// ---------------------------------------------------------------------------
// Copilot plan info
// ---------------------------------------------------------------------------

export type CopilotPlanInfo = {
	copilot_plan?: string;             // e.g. "copilot_individual" | "copilot_business" | "copilot_enterprise" | "copilot_free"
	public_code_suggestions?: string;  // "block" | "allow"
	ide_chat?: string;                 // "enabled" | "disabled"
	copilot_ide_agent?: string;        // "enabled" | "disabled"
	unlimited_pr_summaries?: boolean;
	assignee?: { login?: string; id?: number };
	[key: string]: unknown;
};

export type CopilotPlanResult = { planInfo?: CopilotPlanInfo; statusCode?: number; error?: string };

/** Internal low-level fetcher for the copilot_internal/user endpoint. */
function fetchCopilotPlanInfoPage(token: string): Promise<CopilotPlanResult> {
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname: 'api.github.com',
				path: '/copilot_internal/user',
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': 'copilot-token-tracker',
					Accept: 'application/json',
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					const statusCode = res.statusCode ?? 0;
					if (statusCode < 200 || statusCode >= 300) {
						resolve({ statusCode, error: `HTTP ${statusCode}` });
						return;
					}
					try {
						const parsed = JSON.parse(data);
						if (typeof parsed !== 'object' || parsed === null) {
							resolve({ statusCode, error: 'Unexpected response format' });
							return;
						}
						resolve({ planInfo: parsed as CopilotPlanInfo, statusCode });
					} catch (e) {
						resolve({ statusCode, error: String(e) });
					}
				});
			},
		);
		req.on('error', (e) => resolve({ error: e.message }));
		req.setTimeout(15000, () => {
			req.destroy(new Error('Request timed out after 15 s'));
		});
		req.end();
	});
}

/**
 * Fetch GitHub Copilot plan information for the authenticated user.
 * Uses the VS Code-only internal endpoint `https://api.github.com/copilot_internal/user`.
 * Treat as best-effort — this endpoint may not be available for all accounts.
 * @param fetcher Injectable fetcher for testing; defaults to the real HTTPS implementation.
 */
export function fetchCopilotPlanInfo(
	token: string,
	fetcher: (token: string) => Promise<CopilotPlanResult> = fetchCopilotPlanInfoPage,
): Promise<CopilotPlanResult> {
	return fetcher(token);
}

/** Detect which AI system a GitHub login belongs to, or null if not an AI bot. */
export function detectAiType(login: string): RepoPrDetail['aiType'] | null {
	const l = login.toLowerCase();
	if (l.includes('copilot')) { return 'copilot'; }
	if (l.includes('claude') || l.includes('anthropic')) { return 'claude'; }
	if (l.includes('openai') || l.includes('codex')) { return 'openai'; }
	return null;
}

/** Fetch a single page of PRs from GitHub REST API. */
export function fetchRepoPrsPage(
	owner: string,
	repo: string,
	token: string,
	page: number,
): Promise<{ prs: any[]; statusCode?: number; error?: string }> {
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname: 'api.github.com',
				path: `/repos/${owner}/${repo}/pulls?state=all&per_page=100&sort=created&direction=desc&page=${page}`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': 'copilot-token-tracker',
					Accept: 'application/vnd.github.v3+json',
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					try {
						const parsed = JSON.parse(data);
						if (!Array.isArray(parsed)) {
							resolve({ prs: [], statusCode: res.statusCode, error: parsed.message ?? 'Unexpected API response' });
						} else {
							resolve({ prs: parsed, statusCode: res.statusCode });
						}
					} catch (e) {
						resolve({ prs: [], statusCode: res.statusCode, error: String(e) });
					}
				});
			},
		);
		req.on('error', (e) => resolve({ prs: [], error: e.message }));
		req.setTimeout(15000, () => {
			req.destroy(new Error('Request timed out after 15 s'));
		});
		req.end();
	});
}

/** Fetch all PRs from the last 30 days for a repo, paginating as needed. */
export async function fetchRepoPrs(
	owner: string,
	repo: string,
	token: string,
	since: Date,
	fetchPage: (owner: string, repo: string, token: string, page: number) => Promise<{ prs: any[]; statusCode?: number; error?: string }> = fetchRepoPrsPage,
): Promise<{ prs: any[]; error?: string }> {
	const allPrs: any[] = [];
	const MAX_PAGES = 5; // Cap at 500 PRs per repo
	for (let page = 1; page <= MAX_PAGES; page++) {
		const { prs, statusCode, error } = await fetchPage(owner, repo, token, page);
		if (error) {
			const msg = statusCode === 404
				? 'Repo not found or not accessible with current token'
				: statusCode === 403
				? (error || 'Access denied (private repo requires additional permissions)')
				: error;
			return { prs: allPrs, error: msg };
		}
		if (prs.length === 0) { break; }
		for (const pr of prs) {
			if (new Date(pr.created_at) >= since) {
				allPrs.push(pr);
			}
		}
		// Stop paginating when the oldest PR on this page is before our window
		const oldest = prs[prs.length - 1];
		if (new Date(oldest.created_at) < since || prs.length < 100) {
			break;
		}
	}
	return { prs: allPrs };
}

/**
 * Discover GitHub repos from workspace paths using git remote.
 * Deduplicates by owner/repo so each GitHub repo is only fetched once.
 */
export function discoverGitHubRepos(workspacePaths: string[]): { owner: string; repo: string }[] {
	const seen = new Set<string>();
	const repos: { owner: string; repo: string }[] = [];
	for (const workspacePath of workspacePaths) {
		try {
			const remote = childProcess.execSync('git remote get-url origin', {
				cwd: workspacePath,
				encoding: 'utf8',
				timeout: 3000,
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
			// Only process github.com remotes
			const match = remote.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
			if (!match) { continue; }
			const key = `${match[1]}/${match[2]}`.toLowerCase();
			if (seen.has(key)) { continue; }
			seen.add(key);
			repos.push({ owner: match[1], repo: match[2] });
		} catch {
			// Not a git repo or no remote — skip
		}
	}
	return repos;
}
