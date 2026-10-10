import * as https from 'https';
import * as childProcess from 'child_process';
import { getGitHubApiEndpoints, GITHUB_API_USER_AGENT, GITHUB_API_ACCEPT_V3, GITHUB_API_VERSION, attachRequestFailureHandling } from './githubApiConfig';
import { withTimeout } from './utils/promises';

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
	/**
	 * PRs in the window authored by the signed-in user. Distinct from
	 * `aiAuthoredPrs`, which only counts PRs opened by AI bot accounts
	 * (cloud agents) — work driven by a local AI assistant is authored by
	 * the human and lands here instead. Absent when the user login is unknown.
	 */
	userAuthoredPrs?: number;
	/** Subset of `userAuthoredPrs` that has been merged. */
	userMergedPrs?: number;
	error?: string;
};

export type RepoPrStatsResult = {
	repos: RepoPrInfo[];
	authenticated: boolean;
	since: string; // ISO date string
	/** Set when the collection itself failed (not a per-repo error) — the panel shows this instead of hanging on "Loading…". */
	error?: string;
	/** When the snapshot was fetched from GitHub; empty string when it has never been fetched. */
	fetchedAt?: string;
	/** How often the snapshot is refreshed, so the UI can say when the next refresh is due. */
	refreshIntervalMs?: number;
};

// ---------------------------------------------------------------------------
// Copilot plan info
// ---------------------------------------------------------------------------

export type QuotaSnapshot = {
	quota_id?: string;
	timestamp_utc?: string;
	entitlement?: string;
	quota_remaining?: number;
	remaining?: number;
	percent_remaining?: number;
	unlimited?: boolean;
	overage_permitted?: boolean;
	overage_count?: number;
	has_quota?: boolean;
	quota_reset_at?: string;
	token_based_billing?: boolean;
};

export type CopilotPlanInfo = {
	login?: string;
	copilot_plan?: string;             // e.g. "copilot_individual" | "copilot_business" | "copilot_enterprise" | "copilot_free"
	chat_enabled?: boolean;
	cli_enabled?: boolean;
	is_mcp_enabled?: boolean;
	editor_preview_features_enabled?: boolean;
	copilotignore_enabled?: boolean;
	restricted_telemetry?: boolean;
	access_type_sku?: string;
	assigned_date?: string;
	organization_list?: string[];
	quota_snapshots?: Record<string, QuotaSnapshot>;
	quota_reset_date_utc?: string;
	quota_reset_date?: string;
	token_based_billing?: boolean;
	analytics_tracking_id?: string;
	// Legacy fields (may still be present)
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
	const { hostname, restPathPrefix } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname,
				path: `${restPathPrefix}/copilot_internal/user`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
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
		attachRequestFailureHandling(req, 15000, (message) => resolve({ error: message }));
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

// ---------------------------------------------------------------------------
// Copilot v2 token endpoint info
// ---------------------------------------------------------------------------

/** Endpoint URLs returned by the copilot_internal/v2/token endpoint. */
export type CopilotTokenEndpoints = {
	api?: string;
	'origin-tracker'?: string;
	telemetry?: string;
	proxy?: string;
	[key: string]: string | undefined;
};

/** Non-sensitive metadata from the copilot_internal/v2/token response (token string excluded). */
export type CopilotTokenEndpointInfo = {
	endpoints?: CopilotTokenEndpoints;
	/** Unix timestamp (seconds) when the token expires. */
	expires_at?: number;
	/** How many seconds until the token should be refreshed. */
	refresh_in?: number;
	/** Subscription SKU embedded in the token header (e.g. "copilot_individual"). */
	sku?: string;
	[key: string]: unknown;
};

export type CopilotTokenEndpointResult = { info?: CopilotTokenEndpointInfo; statusCode?: number; error?: string };

/** Internal low-level fetcher for the copilot_internal/v2/token endpoint. */
function fetchCopilotTokenEndpointInfoPage(token: string): Promise<CopilotTokenEndpointResult> {
	const { hostname, restPathPrefix } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname,
				path: `${restPathPrefix}/copilot_internal/v2/token`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
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
						// Exclude the short-lived token string — we only care about the metadata.
						const { token: _token, ...rest } = parsed as { token?: string } & CopilotTokenEndpointInfo;
						resolve({ info: rest as CopilotTokenEndpointInfo, statusCode });
					} catch (e) {
						resolve({ statusCode, error: String(e) });
					}
				});
			},
		);
		attachRequestFailureHandling(req, 15000, (message) => resolve({ error: message }));
		req.end();
	});
}

/**
 * Fetch Copilot token endpoint metadata for the authenticated user.
 * Uses the VS Code-only internal endpoint `https://api.github.com/copilot_internal/v2/token`.
 * Returns metadata (endpoints, expiry) but never the token string itself.
 * Treat as best-effort — this endpoint may not be available for all accounts.
 * @param fetcher Injectable fetcher for testing; defaults to the real HTTPS implementation.
 */
export function fetchCopilotTokenEndpointInfo(
	token: string,
	fetcher: (token: string) => Promise<CopilotTokenEndpointResult> = fetchCopilotTokenEndpointInfoPage,
): Promise<CopilotTokenEndpointResult> {
	return fetcher(token);
}

// ---------------------------------------------------------------------------
// Enterprise membership discovery (GraphQL)
// ---------------------------------------------------------------------------

export type EnterpriseInfo = { slug: string; name: string };
export type UserEnterprisesResult = { enterprises?: EnterpriseInfo[]; error?: string };

/** Discover enterprises the authenticated user belongs to via the GitHub GraphQL API. */
export function fetchUserEnterprises(
	token: string,
	fetcher: (token: string) => Promise<UserEnterprisesResult> = fetchUserEnterprisesPage,
): Promise<UserEnterprisesResult> {
	return fetcher(token);
}

function fetchUserEnterprisesPage(token: string): Promise<UserEnterprisesResult> {
	const query = JSON.stringify({
		query: '{ viewer { enterprises(first: 10, membershipType: ALL) { nodes { slug name } } } }',
	});
	const { hostname, graphQlPath } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname,
				path: graphQlPath,
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(query),
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					const statusCode = res.statusCode ?? 0;
					if (statusCode < 200 || statusCode >= 300) {
						resolve({ error: `HTTP ${statusCode}` });
						return;
					}
					try {
						const parsed = JSON.parse(data);
						const nodes = parsed?.data?.viewer?.enterprises?.nodes;
						if (!Array.isArray(nodes)) {
							const gqlError = parsed?.errors?.[0]?.message;
							resolve({ error: gqlError ?? 'Unexpected response format' });
							return;
						}
						resolve({ enterprises: nodes as EnterpriseInfo[] });
					} catch (e) {
						resolve({ error: String(e) });
					}
				});
			},
		);
		attachRequestFailureHandling(req, 15000, (message) => resolve({ error: message }));
		req.write(query);
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Enterprise premium request budget
// ---------------------------------------------------------------------------

export type EnterpriseBudgetEntry = {
	id?: string;
	budget_amount?: number;
	prevent_further_usage?: boolean;
	budget_scope?: string;
	budget_product_skus?: string[];
	[key: string]: unknown;
};
export type EnterpriseBudgetResult = { budgets?: EnterpriseBudgetEntry[]; statusCode?: number; error?: string };

/**
 * Fetch enterprise billing budgets filtered for premium requests for a specific user.
 * Requires the authenticated user to be an enterprise admin or billing manager.
 * Best-effort — returns an error on 403/404 for non-admin users.
 */
export function fetchEnterprisePremiumBudgets(
	enterpriseSlug: string,
	username: string,
	token: string,
	fetcher: (slug: string, username: string, token: string) => Promise<EnterpriseBudgetResult> = fetchEnterprisePremiumBudgetsPage,
): Promise<EnterpriseBudgetResult> {
	return fetcher(enterpriseSlug, username, token);
}

function fetchEnterprisePremiumBudgetsPage(enterpriseSlug: string, username: string, token: string): Promise<EnterpriseBudgetResult> {
	const params = new URLSearchParams({ user: username, budgetTarget: 'premium_req' });
	const { hostname, restPathPrefix } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname,
				path: `${restPathPrefix}/enterprises/${encodeURIComponent(enterpriseSlug)}/settings/billing/budgets?${params}`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
					Accept: GITHUB_API_ACCEPT_V3,
					'X-GitHub-Api-Version': GITHUB_API_VERSION,
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
						const budgets = parsed?.budgets ?? (Array.isArray(parsed) ? parsed : undefined);
						if (budgets === undefined) {
							resolve({ statusCode, error: 'Unexpected response format' });
							return;
						}
						resolve({ budgets, statusCode });
					} catch (e) {
						resolve({ statusCode, error: String(e) });
					}
				});
			},
		);
		attachRequestFailureHandling(req, 15000, (message) => resolve({ error: message }));
		req.end();
	});
}

/**
 * Recognized AI bot/App login substrings, mapped to the `aiType` the dashboard reports.
 * Extend this list as new AI coding agents or custom GitHub Apps are identified — each
 * entry is matched as a case-insensitive substring against the bot's login. Order matters:
 * the first match wins, so put more specific patterns first if a login could plausibly
 * match more than one entry.
 */
const KNOWN_BOT_LOGIN_PATTERNS: ReadonlyArray<{ pattern: string; aiType: NonNullable<RepoPrDetail['aiType']> }> = [
	{ pattern: 'copilot', aiType: 'copilot' },
	{ pattern: 'claude', aiType: 'claude' },
	{ pattern: 'anthropic', aiType: 'claude' },
	{ pattern: 'openai', aiType: 'openai' },
	{ pattern: 'codex', aiType: 'openai' },
];

/**
 * Detect which AI system authored or was requested to review a PR, from the GitHub user
 * object on the REST payload (`pr.user`, or one entry of `pr.requested_reviewers`).
 *
 * **What this can see**: any account GitHub itself marks as automated — `type: 'Bot'` on the
 * REST payload, or (as a secondary signal, since some App-driven accounts have historically
 * omitted `type`) a login ending in the `[bot]` suffix GitHub Apps conventionally use. A bot
 * whose login matches a known pattern (Copilot, Claude/Anthropic, OpenAI/Codex) is attributed
 * to that specific `aiType`. A bot that doesn't match any known pattern — e.g. an enterprise's
 * own custom GitHub App fronting an internal agent — is still counted as AI via `'other-ai'`
 * rather than silently falling through to "human". Gating on `type === 'Bot'` (instead of the
 * old login-substring-only check) also removes the false-positive side: a human account whose
 * login happens to contain "copilot", "claude" or "openai" (e.g. `copilotpilot`, `claudia-dev`,
 * an org named `openai-research-partners`) has `type: 'User'` and is correctly left unclassified.
 *
 * **What this cannot see**: AI coding work driven locally (Claude Code, Copilot agent mode in
 * the IDE, etc.) and pushed under the human's own GitHub account. That PR is authored by a real
 * `User`, not a `Bot`, and is indistinguishable from manual work by this function alone — see
 * `RepoPrInfo.userAuthoredPrs` and `detectCoAuthorAiType` below for the `Co-authored-by:`
 * trailer signal that can recover it (as a separate, opt-in enrichment, not part of this check).
 */
export function detectAiType(user: { login?: string; type?: string } | null | undefined): RepoPrDetail['aiType'] | null {
	const login = (user?.login ?? '').toLowerCase();
	const isBot = user?.type === 'Bot' || login.endsWith('[bot]');
	if (!isBot) { return null; }
	for (const { pattern, aiType } of KNOWN_BOT_LOGIN_PATTERNS) {
		if (login.includes(pattern)) { return aiType; }
	}
	return 'other-ai';
}

// ---------------------------------------------------------------------------
// Co-authored-by trailer detection (locally-driven agent work)
// ---------------------------------------------------------------------------

/** Matches one `Co-authored-by: Name <email>` git trailer line (case-insensitive), capturing the email. */
const CO_AUTHOR_TRAILER_PATTERN = /^co-authored-by:.*<([^>]+)>/gim;

/**
 * Known co-author email patterns that identify AI-authored commits, mapped to the existing
 * `aiType` union. Extend alongside `KNOWN_BOT_LOGIN_PATTERNS` as new tools are identified.
 * Claude Code stamps `Co-Authored-By: Claude <noreply@anthropic.com>`; GitHub's coding agent
 * and Copilot agent mode stamp the bot's own `users.noreply.github.com` address.
 */
const KNOWN_CO_AUTHOR_EMAIL_PATTERNS: ReadonlyArray<{ pattern: string; aiType: NonNullable<RepoPrDetail['aiType']> }> = [
	{ pattern: '@anthropic.com', aiType: 'claude' },
	{ pattern: 'copilot-swe-agent', aiType: 'copilot' },
	{ pattern: 'copilot@users.noreply.github.com', aiType: 'copilot' },
	{ pattern: '@openai.com', aiType: 'openai' },
];

/**
 * Detect an AI co-author from a PR's commit messages, via `Co-authored-by:` trailers. This is
 * the signal that can attribute locally-driven agent work (Claude Code, Copilot agent mode) —
 * work `detectAiType` cannot see because it lands under the human's own GitHub account.
 *
 * Deliberately **not** wired into `fetchRepoPrs` / any bulk aggregation path: getting commit
 * messages requires a `GET .../pulls/{number}/commits` request per PR (there is no bulk
 * endpoint), and `fetchRepoPrs` already caps at up to 500 PRs/repo per refresh — calling this
 * for every PR would multiply that into up to 500 extra requests per repo per refresh. Callers
 * that want this signal must fetch commit messages (e.g. via `fetchPrCommitMessages` below) for
 * a deliberately bounded set of PRs (e.g. only the signed-in user's own PRs in the current
 * window) rather than from the bulk path.
 */
export function detectCoAuthorAiType(commitMessages: string[]): RepoPrDetail['aiType'] | null {
	for (const message of commitMessages) {
		for (const match of message.matchAll(CO_AUTHOR_TRAILER_PATTERN)) {
			const email = match[1].toLowerCase();
			for (const { pattern, aiType } of KNOWN_CO_AUTHOR_EMAIL_PATTERNS) {
				if (email.includes(pattern)) { return aiType; }
			}
		}
	}
	return null;
}

/**
 * Fetch the commit messages for a single PR (`GET /pulls/{number}/commits`), for use with
 * `detectCoAuthorAiType`. One HTTP request per call — see that function's doc comment for why
 * this is not called from the bulk `fetchRepoPrs` path.
 */
export function fetchPrCommitMessages(
	owner: string,
	repo: string,
	prNumber: number,
	token: string,
	fetcher: (owner: string, repo: string, prNumber: number, token: string) => Promise<{ messages: string[]; statusCode?: number; error?: string }> = fetchPrCommitMessagesPage,
): Promise<{ messages: string[]; statusCode?: number; error?: string }> {
	return fetcher(owner, repo, prNumber, token);
}

function fetchPrCommitMessagesPage(owner: string, repo: string, prNumber: number, token: string): Promise<{ messages: string[]; statusCode?: number; error?: string }> {
	const { hostname, restPathPrefix } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname,
				path: `${restPathPrefix}/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
					Accept: GITHUB_API_ACCEPT_V3,
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					try {
						const parsed = JSON.parse(data);
						if (!Array.isArray(parsed)) {
							resolve({ messages: [], statusCode: res.statusCode, error: parsed.message ?? 'Unexpected API response' });
						} else {
							resolve({ messages: parsed.map((c: any) => c?.commit?.message ?? '').filter(Boolean), statusCode: res.statusCode });
						}
					} catch (e) {
						resolve({ messages: [], statusCode: res.statusCode, error: String(e) });
					}
				});
			},
		);
		attachRequestFailureHandling(req, 15000, (message) => resolve({ messages: [], error: message }));
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Copilot Code Review (CCR) activity — reviews + who requested them
// ---------------------------------------------------------------------------

/** Login GitHub's code review bot posts completed reviews as. */
const COPILOT_REVIEWER_BOT_LOGIN = 'copilot-pull-request-reviewer[bot]';
/** Name GitHub uses for Copilot on `review_requested` timeline events — distinct from the bot login above. */
const COPILOT_REVIEWER_REQUEST_NAME = 'Copilot';

export type CcrReview = {
	/** ISO timestamp the review was submitted. */
	submittedAt: string;
	/** GitHub review state, e.g. "COMMENTED", "APPROVED", "CHANGES_REQUESTED". */
	state: string;
};

export type CcrReviewRequest = {
	/** Login of the actor (human or bot) who requested Copilot as a reviewer. */
	requestedBy: string;
	/** ISO timestamp the request was made. */
	requestedAt: string;
};

export type PrCopilotReviewActivity = {
	/** Completed Copilot code reviews on the PR — each one is a billable CCR event. */
	reviews: CcrReview[];
	/**
	 * `review_requested` events that named Copilot — the best non-admin-reachable signal for who
	 * is likely billed for each review. GitHub bills either the requester (manual per-review
	 * request) or the PR author (repo-wide auto-review setting); this API cannot distinguish the
	 * two modes, so `requestedBy` is a proxy, not a confirmed billing attribution.
	 */
	requests: CcrReviewRequest[];
	error?: string;
};

/**
 * True when a review row from `GET /pulls/{number}/reviews` is both Copilot's and actually
 * submitted. GitHub's reviews endpoint can include a `PENDING` review — one drafted but not yet
 * submitted, with no real `submitted_at` — which is not a billable CCR event yet and must not be
 * counted as completed activity.
 */
export function isCompletedCopilotReview(review: { user?: { login?: string }; state?: string } | null | undefined): boolean {
	return review?.user?.login === COPILOT_REVIEWER_BOT_LOGIN && typeof review?.state === 'string' && review.state !== 'PENDING';
}

/**
 * Fetch one page of completed Copilot code reviews for one PR via `GET /pulls/{number}/reviews`.
 * `pageSize` is the raw item count for this page (before filtering to completed Copilot reviews) —
 * callers must page on that, not on `reviews.length`, since most reviews on a PR are not Copilot's.
 */
function fetchPrCopilotReviewsPage(owner: string, repo: string, prNumber: number, token: string, page: number): Promise<{ reviews: CcrReview[]; pageSize?: number; statusCode?: number; error?: string }> {
	const { hostname, restPathPrefix } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname,
				path: `${restPathPrefix}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
					Accept: GITHUB_API_ACCEPT_V3,
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					try {
						const parsed = JSON.parse(data);
						if (!Array.isArray(parsed)) {
							resolve({ reviews: [], statusCode: res.statusCode, error: parsed.message ?? 'Unexpected API response' });
							return;
						}
						const reviews: CcrReview[] = parsed
							.filter(isCompletedCopilotReview)
							.map((r: any) => ({ submittedAt: r.submitted_at, state: r.state }));
						resolve({ reviews, pageSize: parsed.length, statusCode: res.statusCode });
					} catch (e) {
						resolve({ reviews: [], statusCode: res.statusCode, error: String(e) });
					}
				});
			},
		);
		attachRequestFailureHandling(req, 15000, (message) => resolve({ reviews: [], error: message }));
		req.end();
	});
}

/**
 * True when a timeline event is a `review_requested` naming Copilot AND has a real actor login to
 * attribute it to. An event with no real actor login (e.g. a deleted account) is not attributable —
 * it is dropped rather than synthesized into a fake "unknown" requester, which would have no real
 * meaning to a viewer and would leak into the UI as if it were data.
 */
export function isAttributableCopilotReviewRequest(
	event: { event?: string; requested_reviewer?: { login?: string }; actor?: { login?: string } } | null | undefined,
): boolean {
	return event?.event === 'review_requested'
		&& event?.requested_reviewer?.login === COPILOT_REVIEWER_REQUEST_NAME
		&& typeof event?.actor?.login === 'string' && event.actor.login.length > 0;
}

/**
 * Fetch one page of `review_requested` timeline events naming Copilot for one PR via
 * `GET /issues/{number}/timeline`. `pageSize` is the raw event count for this page (before
 * filtering to Copilot review requests) — callers must page on that, not on `requests.length`,
 * since most timeline events on a PR are not review requests at all.
 */
function fetchPrCopilotReviewRequestsPage(owner: string, repo: string, prNumber: number, token: string, page: number): Promise<{ requests: CcrReviewRequest[]; pageSize?: number; statusCode?: number; error?: string }> {
	const { hostname, restPathPrefix } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname,
				path: `${restPathPrefix}/repos/${owner}/${repo}/issues/${prNumber}/timeline?per_page=100&page=${page}`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
					// The Timeline API is long-GA on github.com, but some older GitHub Enterprise Server
					// versions still gate it behind the "mockingbird" preview media type and 415 without
					// it. Listing both keeps this working on github.com (which ignores the unused
					// preview type) and on those older GHES instances alike.
					Accept: `application/vnd.github.mockingbird-preview+json,${GITHUB_API_ACCEPT_V3}`,
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					try {
						const parsed = JSON.parse(data);
						if (!Array.isArray(parsed)) {
							resolve({ requests: [], statusCode: res.statusCode, error: parsed.message ?? 'Unexpected API response' });
							return;
						}
						const requests: CcrReviewRequest[] = parsed
							.filter(isAttributableCopilotReviewRequest)
							.map((e: any) => ({ requestedBy: e.actor.login, requestedAt: e.created_at }));
						resolve({ requests, pageSize: parsed.length, statusCode: res.statusCode });
					} catch (e) {
						resolve({ requests: [], statusCode: res.statusCode, error: String(e) });
					}
				});
			},
		);
		attachRequestFailureHandling(req, 15000, (message) => resolve({ requests: [], error: message }));
		req.end();
	});
}

/** Cap on pages fetched per PR for reviews/timeline events — 500 of each, same bound as {@link fetchRepoPrs}. */
const MAX_CCR_PAGES = 5;

/**
 * Fetch completed Copilot code reviews for one PR, paginating as needed.
 * @param fetcher Injectable low-level single-page fetcher for testing; defaults to the real HTTPS implementation.
 */
export async function fetchPrCopilotReviews(
	owner: string,
	repo: string,
	prNumber: number,
	token: string,
	fetcher: (owner: string, repo: string, prNumber: number, token: string, page: number) => Promise<{ reviews: CcrReview[]; pageSize?: number; statusCode?: number; error?: string }> = fetchPrCopilotReviewsPage,
): Promise<{ reviews: CcrReview[]; statusCode?: number; error?: string }> {
	const reviews: CcrReview[] = [];
	for (let page = 1; page <= MAX_CCR_PAGES; page++) {
		const result = await fetcher(owner, repo, prNumber, token, page);
		if (result.error) { return { reviews, statusCode: result.statusCode, error: result.error }; }
		reviews.push(...result.reviews);
		// Page on the raw item count, not the filtered `reviews.length` — most reviews on a PR
		// are not Copilot's, so a full page can still filter down to zero matches.
		if ((result.pageSize ?? result.reviews.length) < 100) { break; }
	}
	return { reviews };
}

/**
 * Fetch `review_requested` timeline events naming Copilot for one PR, paginating as needed.
 * @param fetcher Injectable low-level single-page fetcher for testing; defaults to the real HTTPS implementation.
 */
export async function fetchPrCopilotReviewRequests(
	owner: string,
	repo: string,
	prNumber: number,
	token: string,
	fetcher: (owner: string, repo: string, prNumber: number, token: string, page: number) => Promise<{ requests: CcrReviewRequest[]; pageSize?: number; statusCode?: number; error?: string }> = fetchPrCopilotReviewRequestsPage,
): Promise<{ requests: CcrReviewRequest[]; statusCode?: number; error?: string }> {
	const requests: CcrReviewRequest[] = [];
	for (let page = 1; page <= MAX_CCR_PAGES; page++) {
		const result = await fetcher(owner, repo, prNumber, token, page);
		if (result.error) { return { requests, statusCode: result.statusCode, error: result.error }; }
		requests.push(...result.requests);
		// Page on the raw item count, not the filtered `requests.length` — most timeline events
		// on a PR are not review requests at all, so a full page can still filter to zero matches.
		if ((result.pageSize ?? result.requests.length) < 100) { break; }
	}
	return { requests };
}

/**
 * Fetch a PR's full Copilot Code Review activity (reviews + who requested them), one call each,
 * run concurrently. Deliberately **not** wired into `fetchRepoPrs` / any bulk aggregation path —
 * same reasoning as `fetchPrCommitMessages` above: this is two extra requests per PR, so callers
 * must fetch it for a deliberately bounded set of PRs (e.g. the signed-in user's own PRs in the
 * current window), not from the bulk path.
 */
export async function fetchPrCopilotReviewActivity(
	owner: string,
	repo: string,
	prNumber: number,
	token: string,
	fetchReviews: typeof fetchPrCopilotReviews = fetchPrCopilotReviews,
	fetchRequests: typeof fetchPrCopilotReviewRequests = fetchPrCopilotReviewRequests,
): Promise<PrCopilotReviewActivity> {
	const [reviewsResult, requestsResult] = await Promise.all([
		fetchReviews(owner, repo, prNumber, token),
		fetchRequests(owner, repo, prNumber, token),
	]);
	const error = reviewsResult.error ?? requestsResult.error;
	return {
		reviews: reviewsResult.reviews,
		requests: requestsResult.requests,
		...(error ? { error } : {}),
	};
}

/**
 * Fetch a single page of PRs from GitHub REST API.
 * @param requestFn Injectable request factory for testing; defaults to the real HTTPS implementation.
 */
export function fetchRepoPrsPage(
	owner: string,
	repo: string,
	token: string,
	page: number,
	requestFn: typeof https.request = https.request,
): Promise<{ prs: any[]; statusCode?: number; error?: string }> {
	const { hostname, restPathPrefix } = getGitHubApiEndpoints();
	return new Promise((resolve) => {
		const req = requestFn(
			{
				hostname,
				path: `${restPathPrefix}/repos/${owner}/${repo}/pulls?state=all&per_page=100&sort=created&direction=desc&page=${page}`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': GITHUB_API_USER_AGENT,
					Accept: GITHUB_API_ACCEPT_V3,
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
		attachRequestFailureHandling(req, 15000, (message) => resolve({ prs: [], error: message }));
		req.end();
	});
}

function buildFetchRepoPrsError(statusCode: number | undefined, error: string | undefined): string {
	if (statusCode === 404) { return 'Repo not found or not accessible with current token'; }
	if (statusCode === 403) { return error || 'Access denied (private repo requires additional permissions)'; }
	return error ?? 'Unknown error';
}

type RepoPrPageResult = { prs: any[]; statusCode?: number; error?: string };

async function fetchRepoPrsPageWithinTimeout(
	fetchPage: (owner: string, repo: string, token: string, page: number) => Promise<RepoPrPageResult>,
	owner: string,
	repo: string,
	token: string,
	page: number,
	pageTimeoutMs: number,
): Promise<RepoPrPageResult> {
	try {
		return await withTimeout(
			fetchPage(owner, repo, token, page),
			pageTimeoutMs,
			`Fetching PRs for ${owner}/${repo} page ${page}`,
		);
	} catch (error) {
		return { prs: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Fetch all PRs from the last 30 days for a repo, paginating as needed. */
export async function fetchRepoPrs(
	owner: string,
	repo: string,
	token: string,
	since: Date,
	fetchPage: (owner: string, repo: string, token: string, page: number) => Promise<RepoPrPageResult> = fetchRepoPrsPage,
	pageTimeoutMs = 20_000,
): Promise<{ prs: any[]; error?: string }> {
	const allPrs: any[] = [];
	const MAX_PAGES = 5; // Cap at 500 PRs per repo
	for (let page = 1; page <= MAX_PAGES; page++) {
		const { prs, statusCode, error } = await fetchRepoPrsPageWithinTimeout(
			fetchPage, owner, repo, token, page, pageTimeoutMs,
		);
		if (error) { return { prs: allPrs, error: buildFetchRepoPrsError(statusCode, error) }; }
		if (prs.length === 0) { break; }
		for (const pr of prs) {
			if (new Date(pr.created_at) >= since) { allPrs.push(pr); }
		}
		const oldest = prs[prs.length - 1];
		if (new Date(oldest.created_at) < since || prs.length < 100) { break; }
	}
	return { prs: allPrs };
}

/** Maximum number of concurrent `git remote` probes during repo discovery. */
const DISCOVERY_CONCURRENCY = 8;

/** Anchored matcher for the scp-like remote form `git@host:owner/repo(.git)` (a `/` separator after the host is also accepted). */
const SCP_LIKE_REMOTE_PATTERN = /^git@([^:/]+)[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i;

/** Collect the accepted GitHub hosts: github.com plus an optional enterprise host. */
export function buildGitHubHosts(enterpriseUri?: string): Set<string> {
	const hosts = new Set<string>(['github.com']);
	if (enterpriseUri) {
		try {
			const enterpriseHost = new URL(enterpriseUri).host.toLowerCase();
			if (enterpriseHost) { hosts.add(enterpriseHost); }
		} catch { /* ignore invalid URI — fall back to github.com only */ }
	}
	return hosts;
}

/** Strip a trailing `.git` suffix from a repo name, matching git's own remote handling. */
function stripGitSuffix(repo: string): string {
	return repo.toLowerCase().endsWith('.git') ? repo.slice(0, -'.git'.length) : repo;
}

/**
 * Extract owner/repo from a git remote URL when its host is one of `hosts`.
 * Accepts the remote forms git actually produces for GitHub hosts:
 * https://host/o/r(.git), ssh://git@host/o/r and the scp-like git@host:o/r.
 * Parsed with `new URL()` where possible (no unanchored host regex) with an
 * anchored fallback for the scp-like form, which is not a valid URL.
 */
export function parseGitHubRemote(remote: string, hosts: Set<string>): { owner: string; repo: string } | undefined {
	try {
		const url = new URL(remote);
		if ((url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'ssh:') && hosts.has(url.host.toLowerCase())) {
			const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
			if (segments.length === 2) {
				return { owner: segments[0], repo: stripGitSuffix(segments[1]) };
			}
		}
		return undefined;
	} catch {
		// Not a URL — fall through to the scp-like form below.
	}
	const match = SCP_LIKE_REMOTE_PATTERN.exec(remote);
	if (match && hosts.has(match[1].toLowerCase())) {
		return { owner: match[2], repo: match[3] };
	}
	return undefined;
}

/**
 * Read the `origin` remote of one path, resolving to undefined on any failure. Async with a
 * hard timeout — unlike execSync this never blocks the extension host, which matters when the
 * customization matrix contributes hundreds of workspace paths (a sync probe per path would
 * freeze the host for minutes and leave every webview stuck on "Loading…").
 */
function getGitRemoteOrigin(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		childProcess.execFile(
			'git', ['remote', 'get-url', 'origin'],
			{ cwd, encoding: 'utf8', timeout: 3000, windowsHide: true },
			(error, stdout) => resolve(error ? undefined : String(stdout ?? '').trim()),
		);
	});
}

/**
 * Discover GitHub repos from workspace paths using git remote.
 * Deduplicates by owner/repo so each GitHub repo is only fetched once.
 *
 * Always matches github.com remotes; when `enterpriseUri` is configured (the
 * `github-enterprise.uri` setting), remotes on that host (e.g. a `tenant.ghe.com`
 * or on-prem GitHub Enterprise Server) are recognized too.
 *
 * Probes run with bounded concurrency so a large workspace-path list costs the
 * slowest handful of `git` calls rather than the sum of all of them.
 */
export async function discoverGitHubRepos(workspacePaths: string[], enterpriseUri?: string): Promise<{ owner: string; repo: string }[]> {
	const gitHubHosts = buildGitHubHosts(enterpriseUri);
	const uniquePaths = [...new Set(workspacePaths)];
	const remotes = new Array<string | undefined>(uniquePaths.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < uniquePaths.length) {
			const i = nextIndex++;
			try {
				remotes[i] = await getGitRemoteOrigin(uniquePaths[i]);
			} catch {
				remotes[i] = undefined; // Not a git repo or no remote — skip
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, uniquePaths.length) }, worker));

	const seen = new Set<string>();
	const repos: { owner: string; repo: string }[] = [];
	for (const remote of remotes) {
		if (!remote) { continue; }
		const parsed = parseGitHubRemote(remote, gitHubHosts);
		if (!parsed) { continue; }
		const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
		if (seen.has(key)) { continue; }
		seen.add(key);
		repos.push(parsed);
	}
	return repos;
}
