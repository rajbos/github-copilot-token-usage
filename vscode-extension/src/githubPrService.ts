import * as https from 'https';
import * as childProcess from 'child_process';
import { getGitHubApiEndpoints, GITHUB_API_USER_AGENT, GITHUB_API_ACCEPT_V3, GITHUB_API_VERSION, attachRequestFailureHandling } from './githubApiConfig';
import { withTimeout } from './utils/promises';
import { entityTimestampsMatch, parseEntityTimestamp } from './githubActivityCache';

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
	/**
	 * True when this repo's PR listing did not complete — an error, a timeout, or the five-page
	 * cap. The counts are then a **lower bound**, and the cache must not treat a PR's absence from
	 * this pass as proof it is gone. See `fetchRepoPrs().complete`.
	 */
	partial?: boolean;
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
	/** True when at least one repo's listing was incomplete — the totals shown are lower bounds. */
	partial?: boolean;
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

/** Maximum PR listing pages fetched per repo — caps one repo's refresh at 500 PRs. */
export const MAX_REPO_PR_PAGES = 5;

/**
 * Fetch all PRs from the last 30 days for a repo, paginating as needed.
 *
 * `complete` reports whether the listing actually *enumerated the whole window*: true only when
 * pagination ran out naturally (a short/empty page, or a page whose oldest PR predates the window)
 * with no error along the way. It is false on any error and when the {@link MAX_REPO_PR_PAGES} cap
 * cut the listing short. That distinction is the cache's correctness contract: a PR missing from
 * an incomplete listing has **not** been shown to be gone, so its cached record must be retained
 * rather than reconciled away (see `reconcileRepoPrRecords`).
 */
export async function fetchRepoPrs(
	owner: string,
	repo: string,
	token: string,
	since: Date,
	fetchPage: (owner: string, repo: string, token: string, page: number) => Promise<RepoPrPageResult> = fetchRepoPrsPage,
	pageTimeoutMs = 20_000,
): Promise<{ prs: any[]; error?: string; complete: boolean }> {
	const allPrs: any[] = [];
	let complete = false;
	for (let page = 1; page <= MAX_REPO_PR_PAGES; page++) {
		const { prs, statusCode, error } = await fetchRepoPrsPageWithinTimeout(
			fetchPage, owner, repo, token, page, pageTimeoutMs,
		);
		if (error) { return { prs: allPrs, error: buildFetchRepoPrsError(statusCode, error), complete: false }; }
		if (prs.length === 0) { complete = true; break; }
		for (const pr of prs) {
			if (new Date(pr.created_at) >= since) { allPrs.push(pr); }
		}
		const oldest = prs[prs.length - 1];
		if (new Date(oldest.created_at) < since || prs.length < 100) { complete = true; break; }
	}
	return { prs: allPrs, complete };
}

// ---------------------------------------------------------------------------
// Cached per-PR projection
// ---------------------------------------------------------------------------

/**
 * The minimum a cached PR has to carry for the Repository PRs tab to be rendered from it without
 * calling GitHub again: the classification inputs (author/reviewer AI attribution, whether the
 * signed-in user opened it, whether it merged) plus the two fields the AI-detail list displays
 * (title and URL). Deliberately **not** stored: bodies, diffs, labels, reviewer lists beyond their
 * AI attribution, or anything about a PR the current projection does not render.
 *
 * `updatedAt` is the correctness contract. It is the canonical form of GitHub's `updated_at`, and a
 * record is only ever reused when it matches the listing exactly — any edit, comment, review, push
 * or state change moves `updated_at`, so a reused record cannot be showing a superseded state.
 */
export interface RepoPrRecord {
	/** PR number, unique within its repository — with the repo key, this is the cache key. */
	number: number;
	title: string;
	url: string;
	/** ISO `created_at`, used to keep the 30-day window honest when serving from cache. */
	createdAt: string;
	/** Canonical ISO `updated_at`; the value a revalidating listing must match exactly. */
	updatedAt: string;
	/** `open` or `closed` — closed and merged PRs stay represented, matching `state=all`. */
	state: string;
	/** True when the PR merged (GitHub reports this as a non-null `merged_at`). */
	merged: boolean;
	/** Which AI system authored the PR, or null when a human did. */
	authorAiType: RepoPrDetail['aiType'] | null;
	/** Lower-cased author login, needed to attribute the signed-in user's own PRs. */
	authorLogin: string;
	/** One entry per requested reviewer that is an AI bot — humans are not recorded. */
	reviewerAiTypes: RepoPrDetail['aiType'][];
}

/** Normalized `owner/repo` key. Case-insensitive, matching how GitHub treats repository names. */
export function normalizeRepoKey(owner: string, repo: string): string {
	return `${(owner ?? '').toLowerCase()}/${(repo ?? '').toLowerCase()}`;
}

/**
 * The fields of a raw PR-listing payload this module reads. Every one is `unknown` or optional on
 * purpose: the payload crosses a network boundary, so each read goes through a guard rather than
 * trusting the shape.
 */
export interface RawGitHubPr {
	number?: unknown;
	title?: unknown;
	html_url?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	state?: unknown;
	merged_at?: unknown;
	user?: { login?: string; type?: string } | null;
	requested_reviewers?: unknown;
}

/** Read a string field off a raw PR payload, falling back to '' for anything else. */
function prString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** The AI attribution of every requested reviewer that is an AI bot; humans are not recorded. */
function reviewerAiTypesOf(pr: RawGitHubPr | undefined): RepoPrDetail['aiType'][] {
	const reviewers = Array.isArray(pr?.requested_reviewers) ? pr.requested_reviewers : [];
	const aiTypes: RepoPrDetail['aiType'][] = [];
	for (const reviewer of reviewers) {
		const reviewerAi = detectAiType(reviewer);
		if (reviewerAi) { aiTypes.push(reviewerAi); }
	}
	return aiTypes;
}

/**
 * Project one raw PR from the listing into the record shape.
 *
 * `updatedAt` is '' when the payload's `updated_at` is missing or unparseable, which makes the
 * record **uncacheable**: `reconcileRepoPrRecords` never matches an empty timestamp and
 * `toCacheableRepoPrRecords` filters it out, so such a PR is recomputed from the listing on every
 * pass instead of being reused on a timestamp that cannot be verified. Its `number` is -1 when the
 * payload has none, which is likewise never cacheable.
 */
function projectRepoPr(pr: RawGitHubPr | undefined): RepoPrRecord | undefined {
	if (!pr || typeof pr !== 'object') { return undefined; }
	return {
		number: typeof pr.number === 'number' && Number.isFinite(pr.number) ? pr.number : -1,
		title: prString(pr.title),
		url: prString(pr.html_url),
		createdAt: parseEntityTimestamp(pr.created_at) ?? '',
		updatedAt: parseEntityTimestamp(pr.updated_at) ?? '',
		state: pr.state === 'closed' ? 'closed' : 'open',
		merged: Boolean(pr.merged_at),
		authorAiType: detectAiType(pr.user),
		authorLogin: prString(pr.user?.login).toLowerCase(),
		reviewerAiTypes: reviewerAiTypesOf(pr),
	};
}

/**
 * Whether a record carries everything the cache needs to use it safely later:
 *
 * - a **real PR number** — GitHub's are 1-based, so 0, a negative, `NaN` and `Infinity` are all
 *   malformed. A number no listing can ever produce would never be matched and, on an incomplete
 *   listing, would be retained pass after pass;
 * - a parseable **`updated_at`**, the reuse contract;
 * - a parseable **`created_at`**, because that is what decides whether a retained record has aged
 *   out of the window. Without it `isOutsideWindow()` cannot evict the record by age, so a single
 *   malformed timestamp would pin it in the cache indefinitely.
 */
export function isCacheableRepoPrRecord(record: RepoPrRecord | undefined): record is RepoPrRecord {
	return Boolean(record)
		// Integer, not merely finite: GitHub's PR numbers are whole and 1-based, so `1.5` is
		// malformed — it could never be matched by a listing, and would surface in the AI-detail
		// rows as a `#1.5` link that goes nowhere.
		&& typeof record!.number === 'number' && Number.isInteger(record!.number) && record!.number > 0
		&& parseEntityTimestamp(record!.updatedAt) !== undefined
		&& parseEntityTimestamp(record!.createdAt) !== undefined
		// The projection has to be whole, not just correctly keyed. `summarizeRepoPrRecords()`
		// iterates `reviewerAiTypes` and reads the string fields directly, so a record that
		// reached disk malformed (a hand-edited file, a truncated write, a future shape) would
		// otherwise be reused on a matching timestamp and throw — turning a cache read into a
		// failure where recomputing the PR from the listing would have cost one projection.
		&& typeof record!.authorLogin === 'string'
		&& typeof record!.title === 'string'
		&& typeof record!.url === 'string'
		&& typeof record!.state === 'string'
		// `merged` and the AI attribution are *counted*, not just displayed, so their types have to
		// hold: `merged: "false"` is truthy and would inflate the merged count, and any truthy
		// value in an AI field increments the AI metrics whether or not it names a real system.
		&& typeof record!.merged === 'boolean'
		&& isRepoPrAiType(record!.authorAiType, true)
		&& Array.isArray(record!.reviewerAiTypes)
		&& record!.reviewerAiTypes.every((type) => isRepoPrAiType(type, false));
}

/** The AI attribution values `summarizeRepoPrRecords()` knows how to count. */
const REPO_PR_AI_TYPES: readonly RepoPrDetail['aiType'][] = ['copilot', 'claude', 'openai', 'other-ai'];

function isRepoPrAiType(value: unknown, nullAllowed: boolean): boolean {
	if (value === null) { return nullAllowed; }
	return REPO_PR_AI_TYPES.includes(value as RepoPrDetail['aiType']);
}

/**
 * Project one raw PR into its **cacheable** record, or undefined when it cannot be cached safely —
 * see {@link isCacheableRepoPrRecord}. An uncacheable PR is still counted in the current pass (it
 * is in the listing); it simply never enters the cache.
 */
export function toRepoPrRecord(pr: RawGitHubPr | undefined): RepoPrRecord | undefined {
	const record = projectRepoPr(pr);
	return isCacheableRepoPrRecord(record) ? record : undefined;
}

/** The counters the Repository PRs table renders for one repo, derived purely from its records. */
export type RepoPrSummary = Pick<RepoPrInfo, 'totalPrs' | 'aiAuthoredPrs' | 'aiReviewRequestedPrs' | 'aiDetails' | 'userAuthoredPrs' | 'userMergedPrs'>;

/**
 * Count a repo's cached PR records into the table's projection. Pure, so serving from cache and
 * serving from a fresh listing go through exactly the same arithmetic — a cached row can never
 * disagree with a freshly fetched one about what the same PRs mean.
 *
 * `userAuthoredPrs`/`userMergedPrs` are omitted entirely when the signed-in login is unknown,
 * preserving the existing "absent, not zero" contract for that column.
 */
export function summarizeRepoPrRecords(records: readonly RepoPrRecord[], userLogin?: string): RepoPrSummary {
	const login = userLogin?.toLowerCase();
	const aiDetails: RepoPrDetail[] = [];
	let aiAuthoredPrs = 0;
	let aiReviewRequestedPrs = 0;
	let userAuthoredPrs = 0;
	let userMergedPrs = 0;
	for (const record of records) {
		if (record.authorAiType) {
			aiAuthoredPrs++;
			aiDetails.push({ number: record.number, title: record.title, url: record.url, aiType: record.authorAiType, role: 'author' });
		}
		for (const aiType of record.reviewerAiTypes) {
			aiReviewRequestedPrs++;
			aiDetails.push({ number: record.number, title: record.title, url: record.url, aiType, role: 'reviewer-requested' });
		}
		if (login && record.authorLogin === login) {
			userAuthoredPrs++;
			if (record.merged) { userMergedPrs++; }
		}
	}
	const base = { totalPrs: records.length, aiAuthoredPrs, aiReviewRequestedPrs, aiDetails };
	return login ? { ...base, userAuthoredPrs, userMergedPrs } : base;
}

/** Outcome of revalidating one repo's cached PR records against a fresh listing. */
export interface RepoPrReconciliation {
	/** Every record to write back to the cache: the listed ones plus any retained unverified. */
	records: RepoPrRecord[];
	/**
	 * Only the records the current listing actually enumerated. This is what the panel counts:
	 * including a retained-unverified record would let a PR that has since been deleted inflate
	 * the total, which would make "lower bound" a lie in the one direction that matters.
	 */
	listed: RepoPrRecord[];
	/** How many cached records were reused because their `updated_at` matched exactly. */
	reused: number;
	/** How many records were (re)computed: new, changed, or previously uncacheable PRs. */
	recomputed: number;
	/** How many cached records were dropped because a complete listing no longer contains them. */
	removed: number;
	/** How many cached records were kept only because the listing was incomplete. */
	retainedUnverified: number;
}

/**
 * Revalidate one repo's cached PR records against a fresh `state=all` listing.
 *
 * - A cached record whose `updated_at` matches the listing exactly is **reused** as-is.
 * - A PR that is new, whose timestamp moved, or whose timestamp is missing/invalid on either side
 *   is **recomputed** from the listing payload.
 * - A cached record the listing did not mention is removed **only when `listingComplete`**. On an
 *   error, a timeout or a capped listing, absence proves nothing, so the record is *retained for the
 *   cache* — but it is deliberately left out of `listed`, so it can never inflate the count the
 *   panel shows. A retained record that has aged out of the window is dropped outright: keeping it
 *   would eventually have the cache asserting membership of a window the PR no longer belongs to.
 *
 * @param options.since Start of the window being counted; retained records older than this are
 *   dropped rather than carried forward. Omit only when the caller has no window (tests).
 */
export function reconcileRepoPrRecords(
	cached: readonly RepoPrRecord[] | undefined,
	listedPrs: readonly RawGitHubPr[],
	options: { listingComplete: boolean; since?: Date },
): RepoPrReconciliation {
	const cachedByNumber = indexCachedPrRecords(cached);
	const listed = projectListedPrs(listedPrs, cachedByNumber);
	const records = [...listed.records];

	let removed = 0;
	let retainedUnverified = 0;
	for (const [number, record] of cachedByNumber) {
		if (listed.seen.has(number)) { continue; }
		if (options.listingComplete || isOutsideWindow(record, options.since)) { removed++; continue; }
		records.push(record);
		retainedUnverified++;
	}

	return { records, listed: listed.records, reused: listed.reused, recomputed: listed.recomputed, removed, retainedUnverified };
}

/**
 * Whether a cached record's PR was created before the window currently being counted.
 *
 * An unparseable `createdAt` counts as outside: a record that cannot be dated cannot be shown to
 * still belong to the window, and treating it as inside would let one bad timestamp keep it in the
 * cache forever. `isCacheableRepoPrRecord()` already refuses to store such a record, so this is the
 * second line of defence, for anything that predates that rule on disk.
 */
function isOutsideWindow(record: RepoPrRecord, since: Date | undefined): boolean {
	if (!since) { return false; }
	const created = Date.parse(record.createdAt);
	return !Number.isFinite(created) || created < since.getTime();
}

/** Walk the fresh listing, reusing each cached record whose timestamp still matches exactly. */
function projectListedPrs(
	listedPrs: readonly RawGitHubPr[],
	cachedByNumber: ReadonlyMap<number, RepoPrRecord>,
): { records: RepoPrRecord[]; seen: Set<number>; reused: number; recomputed: number } {
	const records: RepoPrRecord[] = [];
	const seen = new Set<number>();
	let reused = 0;
	let recomputed = 0;
	for (const pr of listedPrs) {
		const fresh = toRepoPrRecord(pr);
		if (!fresh) {
			// Uncacheable (a bad timestamp) but still a real PR: count it this pass without caching
			// it. A payload with no usable number is dropped outright — it cannot be linked, and a
			// sentinel like `#-1` leaking into the AI-detail rows would be worse than omitting it.
			const uncacheable = projectRepoPr(pr);
			if (!uncacheable || uncacheable.number < 1) { continue; }
			// Mark the number seen. The listing has spoken for this PR, so its stale cached record
			// must not *also* be retained — that would count the same PR twice.
			seen.add(uncacheable.number);
			records.push(uncacheable);
			recomputed++;
			continue;
		}
		seen.add(fresh.number);
		const previous = cachedByNumber.get(fresh.number);
		const hit = entityTimestampsMatch(previous?.updatedAt, fresh.updatedAt);
		records.push(hit ? previous! : fresh);
		if (hit) { reused++; } else { recomputed++; }
	}
	return { records, seen, reused, recomputed };
}

/** Index the previous pass's records by PR number, dropping anything that could never match. */
function indexCachedPrRecords(cached: readonly RepoPrRecord[] | undefined): Map<number, RepoPrRecord> {
	const byNumber = new Map<number, RepoPrRecord>();
	for (const record of cached ?? []) {
		if (isCacheableRepoPrRecord(record)) { byNumber.set(record.number, record); }
	}
	return byNumber;
}

/** Records that may be persisted — see {@link isCacheableRepoPrRecord} for what disqualifies one. */
export function toCacheableRepoPrRecords(records: readonly RepoPrRecord[]): RepoPrRecord[] {
	return records.filter(isCacheableRepoPrRecord);
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
