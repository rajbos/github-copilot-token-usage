import * as https from 'https';
import { getGitHubApiEndpoints, buildGitHubApiHeaders, attachRequestFailureHandling } from './githubApiConfig';
import { withTimeout } from './utils/promises';
import { entityTimestampsMatch, parseEntityTimestamp } from './githubActivityCache';
import type {
	AgentRepoDiscovery,
	AgentRepoSummary,
	AgentSessionSource,
	AgentSessionsResult,
} from '../../src/types';

/**
 * The shape of these results is shared with the webviews via `src/types.ts`; they are re-exported
 * here so callers of this service keep importing them from one place.
 */
export type { AgentSessionSource, AgentRepoDiscovery, AgentRepoSummary, AgentSessionsResult };

/** Maximum number of task detail fetches per repo to avoid API rate-limit spikes. */
const MAX_TASKS_DETAIL_PER_REPO = 50;

/**
 * Maximum number of task-detail calls for one account-wide collection pass. Each task costs one
 * request, so this caps a refresh at a few hundred calls even for very active accounts. Because
 * the snapshot is only refreshed hourly by a single window, this stays far below GitHub's
 * 5,000 req/hour primary rate limit.
 */
export const MAX_TASK_DETAILS_PER_REFRESH = 200;

/**
 * Maximum number of `GET /repositories/{id}` lookups per refresh, used to resolve the bare
 * `repository.id` the account-wide listing returns into an `owner/repo` pair. Each distinct
 * repository ID costs one call regardless of how many tasks reference it, so this is a much
 * smaller cap than the task-detail one — a very active account still touches only a handful of
 * distinct repos per pass. IDs left over after the cap fall back into the "no repository" bucket
 * for this pass and are retried on the next hourly refresh.
 */
export const MAX_REPO_ID_LOOKUPS_PER_REFRESH = 50;

/**
 * Detect whether an agent session came from the GitHub Copilot cloud agent or a CLI/remote session.
 *
 * Heuristic from the agents API:
 *   cloud-agent: model field is non-empty (e.g. "sweagent-capi:claude-sonnet-4") OR usage field present
 *   cli-remote:  model field present but empty string
 *   unknown:     model field absent entirely
 */
export function detectSessionSource(session: { model?: string; usage?: unknown }): AgentSessionSource {
	if (session.model !== undefined && session.model !== '') { return 'cloud-agent'; }
	if (Object.prototype.hasOwnProperty.call(session, 'usage') && session.usage !== null && session.usage !== undefined) { return 'cloud-agent'; }
	if (session.model !== undefined) { return 'cli-remote'; }
	return 'unknown';
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers (injectable for testing)
// ---------------------------------------------------------------------------

export interface TaskPageResult {
	tasks: any[];
	statusCode?: number;
	error?: string;
}

export interface TaskDetailResult {
	sessions?: any[];
	statusCode?: number;
	error?: string;
}

export interface FetchTaskPageOptions {
	owner: string;
	repo: string;
	token: string;
	page: number;
	archived: boolean;
	since?: string;
}

export interface FetchAccountTaskPageOptions {
	token: string;
	page: number;
	archived: boolean;
	since?: string;
}

export type FetchTaskPageFn = (options: FetchTaskPageOptions) => Promise<TaskPageResult>;

export type FetchAccountTaskPageFn = (options: FetchAccountTaskPageOptions) => Promise<TaskPageResult>;

export type FetchTaskDetailFn = (
	owner: string, repo: string, taskId: string, token: string,
) => Promise<TaskDetailResult>;

export type FetchAccountTaskDetailFn = (taskId: string, token: string) => Promise<TaskDetailResult>;

export type FetchRepositoryByIdFn = (id: number, token: string) => Promise<{ owner: string; repo: string } | undefined>;

export type GitHubJsonResult = { body?: any; statusCode?: number; error?: string };
type GitHubJsonTransport = (path: string, token: string) => Promise<GitHubJsonResult>;

/**
 * GET a GitHub REST path and parse the JSON body, mapping transport/HTTP errors into the result.
 * Exported (rather than kept private like the rest of this module's low-level fetchers) so tests
 * can inject a fake `requestFn` and drive the real request-creation code path end-to-end without
 * a live network call, matching the pattern in `githubPrService.ts`'s `fetchRepoPrsPage`.
 * @param requestFn Injectable request factory for testing; defaults to the real HTTPS implementation.
 */
export function requestGitHubJsonTransport(
	path: string,
	token: string,
	requestFn: typeof https.request = https.request,
): Promise<GitHubJsonResult> {
	return new Promise((resolve) => {
		const { hostname, restPathPrefix } = getGitHubApiEndpoints();
		const req = requestFn(
			{ hostname, path: `${restPathPrefix}${path}`, headers: buildGitHubApiHeaders(token) },
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
						resolve({ body: JSON.parse(data), statusCode });
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

export async function requestGitHubJson(
	path: string,
	token: string,
	transport: GitHubJsonTransport = requestGitHubJsonTransport,
	timeoutMs = 20_000,
): Promise<GitHubJsonResult> {
	try {
		return await withTimeout(
			transport(path, token),
			timeoutMs,
			`GitHub API request ${path}`,
		);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Build the shared query string for both the repo-scoped and account-wide task listings. */
function buildTaskListQuery(page: number, archived: boolean, since?: string): string {
	let query = `per_page=100&page=${page}`;
	if (archived) { query += '&is_archived=true'; }
	if (since) { query += `&since=${encodeURIComponent(since)}`; }
	return query;
}

/**
 * Pull the `tasks` array out of a task-listing response, tolerating a bare array body.
 *
 * A body that carries no task array at all is an **error**, not an empty page. Returning `tasks: []`
 * for it would make a truncated or unexpected 200 indistinguishable from "this repo has no tasks":
 * the short-page check would call the listing complete, and reconciliation — which is allowed to
 * delete only after a listing known to have enumerated fully — would drop every cached task and
 * publish a confident zero. An empty listing says so explicitly, as `{ tasks: [] }` or `[]`.
 *
 * Exported (like `requestGitHubJsonTransport`) so that distinction can be asserted directly: the
 * injectable fetchers tests use return a `TaskPageResult` already, so they bypass this normalizer.
 */
export function toTaskPageResult(result: GitHubJsonResult): TaskPageResult {
	if (result.error) { return { tasks: [], statusCode: result.statusCode, error: result.error }; }
	const parsed = result.body;
	const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : (Array.isArray(parsed) ? parsed : undefined);
	if (!tasks) { return { tasks: [], statusCode: result.statusCode, error: 'Unexpected response format' }; }
	return { tasks, statusCode: result.statusCode };
}

/**
 * Pull the `sessions` array out of a task-detail response.
 *
 * As with the listing, a body with no `sessions` array is an error rather than an empty result. The
 * caller caches a successful detail as this task's aggregate, so treating a malformed response as
 * zero sessions would remember a failure as zero usage — and then reuse it, without another detail
 * call, for as long as the task's `updated_at` holds still. A task genuinely without cloud sessions
 * comes back as `{ sessions: [] }`.
 */
export function toTaskDetailResult(result: GitHubJsonResult): TaskDetailResult {
	if (result.error) { return { statusCode: result.statusCode, error: result.error }; }
	if (!Array.isArray(result.body?.sessions)) { return { statusCode: result.statusCode, error: 'Unexpected response format' }; }
	return { sessions: result.body.sessions, statusCode: result.statusCode };
}

/** Fetch one page of agent tasks for a single repository. */
export async function fetchAgentTasksPage(
	{ owner, repo, token, page, archived, since }: FetchTaskPageOptions,
): Promise<TaskPageResult> {
	const query = buildTaskListQuery(page, archived, since);
	return toTaskPageResult(await requestGitHubJson(`/agents/repos/${owner}/${repo}/tasks?${query}`, token));
}

/**
 * Fetch one page of agent tasks for the authenticated user across **all** repositories.
 *
 * This is the account-wide `/agents/tasks` endpoint: it surfaces tasks started from github.com
 * (the agents page and cloud chat) in repos that are not checked out locally, which the
 * repo-scoped listing can never see. Needs "Agent tasks" (read) on the token.
 */
export async function fetchAccountAgentTasksPage(
	{ token, page, archived, since }: FetchAccountTaskPageOptions,
): Promise<TaskPageResult> {
	const query = buildTaskListQuery(page, archived, since);
	return toTaskPageResult(await requestGitHubJson(`/agents/tasks?${query}`, token));
}

/** Fetch session details for a single agent task, scoped to its repository. */
export async function fetchAgentTaskDetail(
	owner: string,
	repo: string,
	taskId: string,
	token: string,
): Promise<TaskDetailResult> {
	const path = `/agents/repos/${owner}/${repo}/tasks/${encodeURIComponent(taskId)}`;
	return toTaskDetailResult(await requestGitHubJson(path, token));
}

/** Fetch session details for a task by ID alone — used for tasks with no resolvable repository. */
export async function fetchAccountAgentTaskDetail(taskId: string, token: string): Promise<TaskDetailResult> {
	return toTaskDetailResult(await requestGitHubJson(`/agents/tasks/${encodeURIComponent(taskId)}`, token));
}

/**
 * Resolve a bare repository ID (as returned by the account-wide `/agents/tasks` listing, which only
 * guarantees `repository.id`) to an `owner/repo` pair via `GET /repositories/{id}`. Any signed-in
 * user can call this endpoint for a public or accessible repo; it returns undefined on any failure
 * (private repo the token can't see, deleted repo, transport error) so the caller can fall back to
 * the "no repository" bucket instead of failing the whole pass.
 */
export async function fetchRepositoryById(id: number, token: string): Promise<{ owner: string; repo: string } | undefined> {
	const { body, error } = await requestGitHubJson(`/repositories/${id}`, token);
	if (error || !body || typeof body !== 'object') { return undefined; }
	return splitFullName(body.full_name)
		?? (typeof body.owner?.login === 'string' && body.owner.login && typeof body.name === 'string' && body.name
			? { owner: body.owner.login, repo: body.name }
			: undefined);
}

// ---------------------------------------------------------------------------
// Session usage parsing
// ---------------------------------------------------------------------------

/**
 * The agents API reports AI credits in nano-credits (1 credit = 1_000_000_000 nano-credits),
 * e.g. a session costing 43.38 AI credits is reported as `43380350000`. Divide by this factor to
 * get the whole-credit value shown in the UI (where 1 credit = $0.01).
 */
const NANO_CREDITS_PER_CREDIT = 1_000_000_000;

/** Billing units consumed by a single agent session. */
export interface SessionUsage {
	/** Whole AI credits (nano-credits from the API, divided down). */
	credits: number;
	/** Premium requests, for sessions that ran before the June 2026 switch to AI credits. */
	premiumRequests: number;
}

/**
 * Read the billing units of one session.
 *
 * The documented shape is `usage: { type: 'ai_credits' | 'premium_requests', amount: number }`;
 * the live API has also been observed reporting the amount as `usage.credits`, so both spellings
 * are accepted. Premium-request amounts are whole/fractional requests — not nano units — so they
 * are kept in their own bucket rather than being scaled down as if they were credits.
 */
export function readSessionUsage(session: any): SessionUsage {
	const usage = session?.usage;
	if (!usage || typeof usage !== 'object') { return { credits: 0, premiumRequests: 0 }; }
	const raw = typeof usage.amount === 'number' ? usage.amount
		: typeof usage.credits === 'number' ? usage.credits
		: 0;
	if (!Number.isFinite(raw) || raw <= 0) { return { credits: 0, premiumRequests: 0 }; }
	if (usage.type === 'premium_requests') { return { credits: 0, premiumRequests: raw }; }
	return { credits: raw / NANO_CREDITS_PER_CREDIT, premiumRequests: 0 };
}

// ---------------------------------------------------------------------------
// Task → repository resolution
// ---------------------------------------------------------------------------

/** Extract `owner/repo` from a github.com-style URL, if it looks like a repository URL. */
function repoFromUrl(url: unknown): { owner: string; repo: string } | undefined {
	if (typeof url !== 'string') { return undefined; }
	const match = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s?#]+)/.exec(url);
	if (!match) { return undefined; }
	const [, owner, repo] = match;
	// Task URLs on the agents page (github.com/copilot/agents/...) are not repository URLs.
	if (owner === 'copilot') { return undefined; }
	return { owner, repo: repo.replace(/\.git$/, '') };
}

/** Split an `owner/repo` full name, ignoring anything that is not exactly two non-empty parts. */
function splitFullName(fullName: unknown): { owner: string; repo: string } | undefined {
	if (typeof fullName !== 'string') { return undefined; }
	const [owner, repo, ...rest] = fullName.split('/');
	return owner && repo && rest.length === 0 ? { owner, repo } : undefined;
}

/** Pick the repo out of the repository object itself, across the spellings the API has used. */
function repoFromRepositoryObject(repository: any, task: any): { owner: string; repo: string } | undefined {
	const fromFullName = splitFullName(repository.full_name) ?? splitFullName(repository.nwo);
	if (fromFullName) { return fromFullName; }

	const ownerLogin = repository.owner?.login ?? task?.owner?.login;
	if (typeof ownerLogin === 'string' && ownerLogin && typeof repository.name === 'string' && repository.name) {
		return { owner: ownerLogin, repo: repository.name };
	}
	return repoFromUrl(repository.html_url);
}

/**
 * Resolve the repository a task belongs to from the fields already on the task object.
 *
 * The live API returns richer repo objects on the repo-scoped listing, so every known spelling is
 * tried before falling back to parsing the task's URLs. Returns undefined when none of those are
 * present — most notably, the account-wide `/agents/tasks` listing only guarantees
 * `repository.id` (a bare numeric ID, no owner/name/URL at all), which this function cannot turn
 * into an `owner/repo` pair by itself. Callers that need to resolve that case should read
 * `repositoryIdFromTask()` and look the ID up with `fetchRepositoryById()`. Also returns undefined
 * for tasks with no repository at all — e.g. ad-hoc sessions started from cloud chat before a repo
 * is picked — which are grouped into their own bucket.
 */
export function resolveTaskRepo(task: any): { owner: string; repo: string } | undefined {
	const repository = task?.repository;
	if (repository && typeof repository === 'object') {
		const resolved = repoFromRepositoryObject(repository, task);
		if (resolved) { return resolved; }
	}
	return repoFromUrl(task?.html_url);
}

/** Read the bare numeric repository ID off a task, if present — see `resolveTaskRepo()`. */
export function repositoryIdFromTask(task: any): number | undefined {
	const id = task?.repository?.id;
	return typeof id === 'number' && Number.isFinite(id) ? id : undefined;
}

/** Stable map key for a repository summary; account tasks with no repo share the empty key. */
export function repoKey(owner: string, repo: string): string {
	return owner && repo ? `${owner.toLowerCase()}/${repo.toLowerCase()}` : '';
}

// ---------------------------------------------------------------------------
// High-level aggregation
// ---------------------------------------------------------------------------

/**
 * Fetch and aggregate cloud-agent session stats for a single GitHub repository.
 *
 * Only cloud-agent sessions (model != '' or usage present) are counted.
 * CLI-remote sessions that appear in the same tasks are excluded so they are
 * not double-counted with the chat-session data already tracked by this extension.
 *
 * Fetches are capped at MAX_TASKS_DETAIL_PER_REPO task-detail calls to limit
 * API usage. When the cap is hit, `partial` is set to true and totals are
 * conservative lower bounds.
 */
export async function fetchAgentSessionsForRepo(
	owner: string,
	repo: string,
	token: string,
	since: Date,
	fetchTaskPage: FetchTaskPageFn = fetchAgentTasksPage,
	fetchTaskDetail: FetchTaskDetailFn = fetchAgentTaskDetail,
): Promise<AgentRepoSummary> {
	const sinceStr = since.toISOString();
	const { allTasks, error } = await fetchAllTasksForRepo(owner, repo, token, sinceStr, fetchTaskPage);
	if (error) { return error; }

	const tasksTotal = allTasks.length;
	const tasksToDetail = allTasks.slice(0, MAX_TASKS_DETAIL_PER_REPO);
	const partial = tasksTotal > MAX_TASKS_DETAIL_PER_REPO;
	const totals = await aggregateTaskDetails(tasksToDetail, owner, repo, token, fetchTaskDetail);

	return {
		owner, repo,
		totalTasks: totals.totalTasks,
		totalSessions: totals.totalSessions,
		totalCredits: totals.totalCredits,
		totalPremiumRequests: totals.totalPremiumRequests,
		tasksScanned: tasksToDetail.length,
		tasksTotal,
		partial,
		discovery: 'workspace',
	};
}

/** An empty summary row for a repository, before any task totals are folded in. */
export function emptyRepoSummary(owner: string, repo: string, discovery: AgentRepoDiscovery): AgentRepoSummary {
	return {
		owner, repo,
		totalTasks: 0, totalSessions: 0, totalCredits: 0, totalPremiumRequests: 0,
		tasksScanned: 0, tasksTotal: 0, partial: false,
		discovery,
	};
}

function buildTaskFetchError(owner: string, repo: string, statusCode: number | undefined): AgentRepoSummary {
	return { ...emptyRepoSummary(owner, repo, 'workspace'), error: describeTaskFetchError(statusCode) };
}

/** Human-readable reason for a failed task listing, based on the HTTP status. */
export function describeTaskFetchError(statusCode: number | undefined): string {
	if (statusCode === 404) { return 'Copilot cloud agent not enabled or not accessible for this repo'; }
	if (statusCode === 403) { return 'Access denied — check that your GitHub token has repo scope'; }
	if (statusCode === 401) { return 'GitHub sign-in expired — sign in again to refresh agent data'; }
	return `API error (HTTP ${statusCode ?? 'unknown'})`;
}

async function fetchTasksForArchivedBatch(
	owner: string, repo: string, token: string, sinceStr: string, archived: boolean,
	fetchTaskPage: FetchTaskPageFn, seen: Set<string>, allTasks: any[],
): Promise<AgentRepoSummary | undefined> {
	for (let page = 1; page <= 5; page++) {
		const { tasks, statusCode, error } = await fetchTaskPage({ owner, repo, token, page, archived, since: sinceStr });
		if (error && page === 1 && !archived) { return buildTaskFetchError(owner, repo, statusCode); }
		if (tasks.length === 0 || error) { break; }
		for (const t of tasks) { if (!seen.has(t.id)) { seen.add(t.id); allTasks.push(t); } }
		if (tasks.length < 100) { break; }
	}
	return undefined;
}

async function fetchAllTasksForRepo(
	owner: string,
	repo: string,
	token: string,
	sinceStr: string,
	fetchTaskPage: FetchTaskPageFn,
): Promise<{ allTasks: any[]; error?: AgentRepoSummary }> {
	const allTasks: any[] = [];
	const seen = new Set<string>();
	for (const archived of [false, true]) {
		const err = await fetchTasksForArchivedBatch(owner, repo, token, sinceStr, archived, fetchTaskPage, seen, allTasks);
		if (err) { return { allTasks: [], error: err }; }
	}
	return { allTasks };
}

/** Totals for the cloud-agent sessions of a single task. */
function sumCloudSessionUsage(sessions: any[]): { tasks: number; sessions: number; credits: number; premiumRequests: number } {
	const cloudSessions = sessions.filter(s => detectSessionSource(s) === 'cloud-agent');
	if (cloudSessions.length === 0) { return { tasks: 0, sessions: 0, credits: 0, premiumRequests: 0 }; }
	let credits = 0;
	let premiumRequests = 0;
	for (const session of cloudSessions) {
		const usage = readSessionUsage(session);
		credits += usage.credits;
		premiumRequests += usage.premiumRequests;
	}
	return { tasks: 1, sessions: cloudSessions.length, credits, premiumRequests };
}

async function aggregateTaskDetails(
	tasksToDetail: any[],
	owner: string,
	repo: string,
	token: string,
	fetchTaskDetail: FetchTaskDetailFn,
): Promise<{ totalTasks: number; totalSessions: number; totalCredits: number; totalPremiumRequests: number }> {
	let totalTasks = 0;
	let totalSessions = 0;
	let totalCredits = 0;
	let totalPremiumRequests = 0;
	const CONCURRENCY = 5;
	for (let i = 0; i < tasksToDetail.length; i += CONCURRENCY) {
		const batch = tasksToDetail.slice(i, i + CONCURRENCY);
		const results = await Promise.all(batch.map(task => fetchTaskDetail(owner, repo, task.id, token)));
		for (const { sessions } of results) {
			if (!sessions || sessions.length === 0) { continue; }
			const totals = sumCloudSessionUsage(sessions);
			totalTasks += totals.tasks;
			totalSessions += totals.sessions;
			totalCredits += totals.credits;
			totalPremiumRequests += totals.premiumRequests;
		}
	}
	return { totalTasks, totalSessions, totalCredits, totalPremiumRequests };
}

// ---------------------------------------------------------------------------
// Account-wide collection (workspace repos + /agents/tasks)
// ---------------------------------------------------------------------------

/** One task considered for a detail fetch, with the repository it was attributed to. */
interface AgentTaskCandidate {
	id: string;
	key: string;
	owner?: string;
	repo?: string;
	/** Sort key (most recent first) so the detail budget is spent on the newest tasks. */
	sortAt: number;
	/** Canonical `updated_at`, or '' when the API did not report a usable one (uncacheable). */
	updatedAt: string;
	/** Cache key scoping this task to the repo row it belongs to — see `agentTaskCacheKey`. */
	cacheKey: string;
	/** Which listing surfaced this task; widened to `both` when both listings did. */
	discovery: AgentRepoDiscovery;
}

// ---------------------------------------------------------------------------
// Per-task cache records
// ---------------------------------------------------------------------------

/** The pre-aggregated cloud-session totals of one task — all the detail call is kept for. */
export interface AgentTaskAggregate {
	/** 1 when the task had at least one cloud-agent session, else 0 (matches `totalTasks`). */
	tasks: number;
	sessions: number;
	credits: number;
	premiumRequests: number;
}

/**
 * What is remembered about one cloud-agent task between refreshes, so a task that has not changed
 * costs no detail call at all.
 *
 * Deliberately **not** stored: the prompt, the task title or description, the transcript, session
 * bodies, or anything from the token — only the repository attribution, the timestamp that decides
 * reuse, and the four numbers the Cloud Agent table adds up.
 */
export interface AgentTaskRecord {
	/** `${repoKey}#${taskId}` — scoping the ID to its repo row, see `agentTaskCacheKey`. */
	key: string;
	/** The task's own ID, as the listing reports it. */
	id: string;
	/** Normalized `owner/repo` the task was attributed to; '' for the "no repository" bucket. */
	repoKey: string;
	owner?: string;
	repo?: string;
	/** Which listing surfaced the task, so the row's discovery badge survives a cache hit. */
	discovery: AgentRepoDiscovery;
	/** Canonical `updated_at`; a record is only reused when this matches the listing exactly. */
	updatedAt: string;
	/** The task's session totals — present only once a detail fetch has succeeded for this exact
	 * `updatedAt`. Absent means "must be fetched", never "zero". */
	aggregate?: AgentTaskAggregate;
	/** False while the detail fetch is still owed (never tried, budget-capped, or failed). */
	detailOk: boolean;
	/** Consecutive failed detail attempts, so a permanently broken task cannot starve the budget. */
	detailAttempts: number;
	/** When the task was last seen in a listing (ISO), used for cache eviction ordering. */
	lastSeenAt: string;
}

/**
 * Cache key for one task. The repo key is part of it on purpose: if a task moves repositories (or
 * is re-attributed once a bare `repository.id` finally resolves), it lands on a different key and
 * its old aggregate cannot be folded into the wrong repository's row. Combined with the exact
 * `updated_at` match, a cache entry can never satisfy a request for a different entity or for a
 * newer version of the same one.
 */
export function agentTaskCacheKey(repoKey: string, taskId: string): string {
	return `${repoKey}#${taskId}`;
}

export interface CollectAgentSessionsOptions {
	token: string;
	since: Date;
	/** Repos discovered from workspace git remotes. Listed even when they report no tasks. */
	workspaceRepos: { owner: string; repo: string }[];
	fetchTaskPage?: FetchTaskPageFn;
	fetchAccountTaskPage?: FetchAccountTaskPageFn;
	fetchTaskDetail?: FetchTaskDetailFn;
	fetchAccountTaskDetail?: FetchAccountTaskDetailFn;
	fetchRepositoryById?: FetchRepositoryByIdFn;
	/** Cap on task-detail calls for this pass (default MAX_TASK_DETAILS_PER_REFRESH). */
	maxTaskDetails?: number;
	/** Cap on repository-ID lookups for this pass (default MAX_REPO_ID_LOOKUPS_PER_REFRESH). */
	maxRepoIdLookups?: number;
	/**
	 * Task records kept from the previous refresh. A record whose `updated_at` still matches the
	 * listing exactly is reused instead of costing a detail call — which is the entire point of the
	 * cache. Omit it (or pass an empty list) for a full, uncached collection.
	 */
	cachedTasks?: readonly AgentTaskRecord[];
	/** Reports coarse progress (list calls + detail calls) so the panel can show a bar. */
	onProgress?: (done: number, total: number) => void;
}

/**
 * What one collection pass produced: the snapshot the webview renders, plus the local-only cache
 * material. The two are kept apart deliberately — `taskRecords` carries repository attribution and
 * per-task totals that belong in global storage, never in a webview payload.
 */
export interface AgentSessionsCollection extends AgentSessionsResult {
	/** Per-task records for every task in this pass's listing membership. */
	taskRecords: AgentTaskRecord[];
	/**
	 * Cache keys of every task this pass's listings actually surfaced — a superset of
	 * `taskRecords`, because a task whose `updated_at` was uncacheable is seen but not stored.
	 * Reconciliation needs the difference: "seen but unverifiable" must drop the old record rather
	 * than retain it as reusable, which is what "not seen at all" does on an incomplete listing.
	 */
	seenTaskKeys: Set<string>;
	/** True when every listing (each workspace repo and the account-wide endpoint) enumerated fully. */
	listingComplete: boolean;
}

/** The fields of a listed task this module reads for ordering and cache validation. */
interface RawAgentTask {
	id?: string;
	created_at?: unknown;
	updated_at?: unknown;
}

/** Timestamp used to spend the detail budget on the most recently active tasks first. */
function taskSortAt(task: RawAgentTask | null | undefined): number {
	// Fall back to `created_at` whenever `updated_at` is missing *or* unparseable — a task with a
	// malformed timestamp is uncacheable and so always needs a detail call, which makes losing its
	// newest-first priority (and being dropped by the budget) the worst possible outcome for it.
	const updated = Date.parse(typeof task?.updated_at === 'string' ? task.updated_at : '');
	if (Number.isFinite(updated)) { return updated; }
	const created = Date.parse(typeof task?.created_at === 'string' ? task.created_at : '');
	return Number.isFinite(created) ? created : 0;
}

/**
 * The task's `updated_at` in canonical form, or '' when it is missing or unparseable. A task with
 * no usable timestamp is **uncacheable**: its detail is fetched every pass rather than reused on a
 * timestamp we cannot verify.
 */
function taskUpdatedAt(task: RawAgentTask | null | undefined): string {
	return parseEntityTimestamp(task?.updated_at) ?? '';
}

/** Maximum listing pages fetched per task slice — caps one slice at 500 tasks. */
const MAX_TASK_LIST_PAGES = 5;

/**
 * Collect one archived/active slice of a task listing into `tasks`, deduplicating by task ID.
 *
 * `complete` says whether the slice enumerated fully: false on any error and when the page cap cut
 * it short. Only a complete enumeration proves a cached task is really gone, so this flag is what
 * stops the cache from reconciling away tasks it simply never got to (see `reconcileAgentTaskRecords`).
 */
/**
 * Record one listed task, keeping the first object seen for any id.
 *
 * The same task legitimately appears in both the active and archived slices (and can repeat across
 * pages). Keeping the first is what stops it being counted twice — but if the two sightings carry
 * *different* timestamps, one of the listings has already reported the task as changed, so reusing
 * a cached aggregate matching the other would break the exact-timestamp reuse contract. That id is
 * recorded as conflicting and its candidate is made uncacheable.
 */
function absorbListedTask(task: RawAgentTask, tasks: any[], seen: Map<string, string>, conflicting: Set<string>): void {
	if (!task?.id) { return; }
	const previous = seen.get(task.id);
	if (previous === undefined) {
		seen.set(task.id, taskUpdatedAt(task));
		tasks.push(task);
		return;
	}
	if (previous !== taskUpdatedAt(task)) { conflicting.add(task.id); }
}

async function listTaskSlice(
	fetchPage: (page: number, archived: boolean) => Promise<TaskPageResult>,
	archived: boolean,
	tasks: any[],
	seen: Map<string, string>,
	conflicting: Set<string>,
): Promise<{ statusCode?: number; error?: string; complete: boolean }> {
	for (let page = 1; page <= MAX_TASK_LIST_PAGES; page++) {
		const result = await fetchPage(page, archived);
		if (result.error) { return { statusCode: result.statusCode, error: result.error, complete: false }; }
		for (const task of result.tasks) { absorbListedTask(task, tasks, seen, conflicting); }
		if (result.tasks.length < 100) { return { complete: true }; }
	}
	return { complete: false };
}

/**
 * Page through a task listing, active tasks first and then archived ones. Only a failure on the
 * very first call is reported: once some tasks are in hand, a later page or the archived pass
 * failing just means the snapshot is slightly short, which the per-repo `partial` flag covers.
 */
async function listAllTasks(
	fetchPage: (page: number, archived: boolean) => Promise<TaskPageResult>,
): Promise<{ tasks: any[]; conflicting: Set<string>; statusCode?: number; error?: string; complete: boolean }> {
	const tasks: any[] = [];
	const seen = new Map<string, string>();
	const conflicting = new Set<string>();
	const active = await listTaskSlice(fetchPage, false, tasks, seen, conflicting);
	if (active.error && tasks.length === 0) { return { tasks: [], conflicting, ...active }; }
	const archived = await listTaskSlice(fetchPage, true, tasks, seen, conflicting);
	// Report the first error from either slice even when some pages did come back. Dropping it
	// would hide a failed archived pass, or a failure partway through the active one, behind a
	// result that looks whole — the caller still gets the tasks it did collect, plus the reason
	// the pass is short and `complete: false` to stop anything reconciling on it.
	const failure = active.error ? active : (archived.error ? archived : undefined);
	return { tasks, conflicting, statusCode: failure?.statusCode, error: failure?.error, complete: active.complete && archived.complete };
}

/**
 * Mark a candidate uncacheable when a second sighting disagrees with the first.
 *
 * The repo-scoped listing keeps the row — it is the more specific source — but whichever sighting
 * is stale, its cached aggregate must not be folded in without a fresh detail call. A disagreement
 * is the repository (a move, or a late `repository.id` resolution), the `updated_at` — the listings
 * are fetched moments apart, so a task changed in between reports two values and the other listing
 * has already said the cached state is superseded — or a conflict this listing's own slices already
 * reported, which `contested` carries in. That last one matters because the timestamp *this* call
 * sees may be the one that happens to match: only the caller knows the other slice disagreed.
 *
 * The sort key takes the newer sighting's value too. An uncacheable task always needs a detail
 * call, so leaving it on the older listing's position would make it lose the newest-first budget
 * to work that is genuinely older.
 */
function contestCandidate(candidate: AgentTaskCandidate, task: RawAgentTask, contested: boolean): void {
	if (!contested && taskUpdatedAt(task) === candidate.updatedAt) { return; }
	candidate.updatedAt = '';
	candidate.sortAt = Math.max(candidate.sortAt, taskSortAt(task));
}

/** Ensure a row exists for this repo key, widening its discovery when seen from both sources. */
function upsertRow(
	rows: Map<string, AgentRepoSummary>, key: string, owner: string, repo: string, discovery: AgentRepoDiscovery,
): AgentRepoSummary {
	const existing = rows.get(key);
	if (existing) {
		if (existing.discovery !== discovery) { existing.discovery = 'both'; }
		return existing;
	}
	const row: AgentRepoSummary = { ...emptyRepoSummary(owner, repo, discovery) };
	if (!key) { row.unassigned = true; }
	rows.set(key, row);
	return row;
}

/** List tasks for every workspace repo, recording per-repo errors on their rows. */
async function collectWorkspaceTasks(
	options: CollectAgentSessionsOptions,
	rows: Map<string, AgentRepoSummary>,
	candidates: Map<string, AgentTaskCandidate>,
	reportProgress: () => void,
): Promise<boolean> {
	const fetchTaskPage = options.fetchTaskPage ?? fetchAgentTasksPage;
	const sinceStr = options.since.toISOString();
	let allComplete = true;
	for (const { owner, repo } of options.workspaceRepos) {
		const key = repoKey(owner, repo);
		const row = upsertRow(rows, key, owner, repo, 'workspace');
		const { tasks, conflicting, statusCode, error, complete } = await listAllTasks(
			(page, archived) => fetchTaskPage({ owner, repo, token: options.token, page, archived, since: sinceStr }),
		);
		if (error) { row.error = describeTaskFetchError(statusCode); }
		if (!complete) { allComplete = false; }
		for (const task of tasks) {
			const existing = candidates.get(task.id);
			if (existing) {
				// Two workspace repositories both listed this task — a move, or an inconsistent
				// listing. The first repo keeps the row (deduplicating by task ID is what stops one
				// task being counted twice), but a disagreement about the repo or the timestamp
				// makes the candidate uncacheable, exactly as a workspace-vs-account one does.
				contestCandidate(existing, task, existing.key !== key || conflicting.has(task.id));
				continue;
			}
			candidates.set(task.id, {
				id: task.id, key, owner, repo,
				sortAt: taskSortAt(task),
				// A task the two listing slices timestamped differently is uncacheable for the same
				// reason: one of them has already reported it changed.
				updatedAt: conflicting.has(task.id) ? '' : taskUpdatedAt(task),
				cacheKey: agentTaskCacheKey(key, task.id), discovery: 'workspace',
			});
		}
		reportProgress();
	}
	return allComplete;
}

/**
 * Resolve the tasks whose repository could not be read from the task object directly (the
 * account-wide listing typically only returns a bare `repository.id`) by looking that ID up
 * through `GET /repositories/{id}`. Distinct IDs are looked up once and cached for the whole pass,
 * since many tasks in the same repo share one ID, and the lookup count is capped to bound API
 * usage — IDs left over stay unresolved for this pass and land in the "no repository" bucket.
 */
async function resolveRepositoryIds(
	tasks: any[],
	options: CollectAgentSessionsOptions,
): Promise<Map<number, { owner: string; repo: string } | undefined>> {
	const fetchRepoById = options.fetchRepositoryById ?? fetchRepositoryById;
	const maxLookups = options.maxRepoIdLookups ?? MAX_REPO_ID_LOOKUPS_PER_REFRESH;

	const unresolvedIds = new Set<number>();
	for (const task of tasks) {
		if (resolveTaskRepo(task)) { continue; }
		const id = repositoryIdFromTask(task);
		if (id !== undefined) { unresolvedIds.add(id); }
	}

	const idsToFetch = [...unresolvedIds].slice(0, maxLookups);
	const idCache = new Map<number, { owner: string; repo: string } | undefined>();
	const CONCURRENCY = 5;
	for (let i = 0; i < idsToFetch.length; i += CONCURRENCY) {
		const batch = idsToFetch.slice(i, i + CONCURRENCY);
		const results = await Promise.all(batch.map(id => fetchRepoById(id, options.token)));
		batch.forEach((id, index) => idCache.set(id, results[index]));
	}
	return idCache;
}

/** Resolve one account-listing task's repo: its own fields first, then the ID-lookup cache. */
function resolveAccountTaskRepo(
	task: any,
	idCache: Map<number, { owner: string; repo: string } | undefined>,
): { owner: string; repo: string } | undefined {
	const resolved = resolveTaskRepo(task);
	if (resolved) { return resolved; }
	const id = repositoryIdFromTask(task);
	return id !== undefined ? idCache.get(id) : undefined;
}

/**
 * Key an account-listing task should be filed under. Falls back to an already-known candidate's
 * key when the account object itself can't be resolved (bare-ID lookup failed or was capped), so a
 * task already attributed to a repo via the workspace listing doesn't spawn a spurious empty
 * "no repository" row.
 */
function accountTaskKey(
	resolved: { owner: string; repo: string } | undefined,
	existingCandidate: AgentTaskCandidate | undefined,
): string {
	return repoKey(resolved?.owner ?? '', resolved?.repo ?? '') || existingCandidate?.key || '';
}

/** List the authenticated user's tasks across all repositories, adding any repos not seen yet. */
async function collectAccountTasks(
	options: CollectAgentSessionsOptions,
	rows: Map<string, AgentRepoSummary>,
	candidates: Map<string, AgentTaskCandidate>,
): Promise<{ available: boolean; error?: string; complete: boolean }> {
	const fetchAccountPage = options.fetchAccountTaskPage ?? fetchAccountAgentTasksPage;
	const sinceStr = options.since.toISOString();
	const { tasks, conflicting, statusCode, error, complete } = await listAllTasks(
		(page, archived) => fetchAccountPage({ token: options.token, page, archived, since: sinceStr }),
	);
	// Only a listing that produced nothing is "unavailable". One that failed partway still has real
	// tasks in hand, and throwing them away would understate the account for no gain — they are
	// folded in, with the error surfaced and `complete: false` marking the pass as short.
	if (error && tasks.length === 0) { return { available: false, error: describeTaskFetchError(statusCode), complete: false }; }
	const listingError = error ? describeTaskFetchError(statusCode) : undefined;

	const idCache = await resolveRepositoryIds(tasks, options);

	for (const task of tasks) {
		absorbAccountTask(task, rows, candidates, idCache, conflicting);
	}
	return { available: true, error: listingError, complete: complete && !error };
}

/** Fold one account-wide task into the rows and candidates, contesting an existing candidate. */
function absorbAccountTask(
	task: any,
	rows: Map<string, AgentRepoSummary>,
	candidates: Map<string, AgentTaskCandidate>,
	idCache: Map<number, { owner: string; repo: string } | undefined>,
	conflicting: ReadonlySet<string>,
): void {
	const existingCandidate = candidates.get(task.id);
	const resolved = resolveAccountTaskRepo(task, idCache);
	const key = accountTaskKey(resolved, existingCandidate);
	upsertRow(rows, key, resolved?.owner ?? '', resolved?.repo ?? '', 'account');
	if (existingCandidate) {
		if (existingCandidate.discovery !== 'account') { existingCandidate.discovery = 'both'; }
		// Any disagreement between the two listings makes the repo-scoped candidate uncacheable.
		// The repo-scoped listing is the more specific source, so it keeps the row attribution,
		// but a cached aggregate under a contested key can no longer be trusted to describe
		// current usage — marking the candidate uncacheable forces a fresh detail fetch.
		//
		// - **Repository**: the task moved, or was re-attributed once its bare repository ID
		//   resolved, so a stale aggregate could be folded into the wrong repository's row.
		// - **Timestamp**: the two listings were fetched moments apart, so a task updated in
		//   between reports two different `updated_at` values. Reusing the older one would
		//   break the contract this cache rests on — that a reused record cannot be showing a
		//   superseded state — because the newer listing has already said it changed. An
		//   account timestamp that is itself uncacheable ('' here) counts as a disagreement
		//   too: it cannot confirm the repo-scoped one.
		const contestedRepo = Boolean(resolved) && repoKey(resolved!.owner, resolved!.repo) !== existingCandidate.key;
		contestCandidate(existingCandidate, task, contestedRepo || conflicting.has(task.id));
		return;
	}
	candidates.set(task.id, {
		id: task.id, key, owner: resolved?.owner, repo: resolved?.repo,
		sortAt: taskSortAt(task),
		updatedAt: conflicting.has(task.id) ? '' : taskUpdatedAt(task),
		cacheKey: agentTaskCacheKey(key, task.id), discovery: 'account',
	});
}

/** Add one task's cloud-session totals to its repository row. */
function foldAggregateIntoRow(row: AgentRepoSummary | undefined, aggregate: AgentTaskAggregate): void {
	if (!row) { return; }
	row.totalTasks += aggregate.tasks;
	row.totalSessions += aggregate.sessions;
	row.totalCredits += aggregate.credits;
	row.totalPremiumRequests += aggregate.premiumRequests;
}

/**
 * Fetch details for the selected tasks, fold their session totals into the repo rows, and record
 * per-task whether the fetch succeeded so the cache can tell "already known" from "still owed".
 */
async function foldTaskDetails(
	selected: AgentTaskCandidate[],
	options: CollectAgentSessionsOptions,
	rows: Map<string, AgentRepoSummary>,
	reportProgress: () => void,
): Promise<Map<string, AgentTaskAggregate | undefined>> {
	const fetchTaskDetail = options.fetchTaskDetail ?? fetchAgentTaskDetail;
	const fetchAccountTaskDetail = options.fetchAccountTaskDetail ?? fetchAccountAgentTaskDetail;
	const outcomes = new Map<string, AgentTaskAggregate | undefined>();
	const CONCURRENCY = 5;
	for (let i = 0; i < selected.length; i += CONCURRENCY) {
		const batch = selected.slice(i, i + CONCURRENCY);
		const details = await Promise.all(batch.map(candidate => (
			candidate.owner && candidate.repo
				? fetchTaskDetail(candidate.owner, candidate.repo, candidate.id, options.token)
				: fetchAccountTaskDetail(candidate.id, options.token)
		)));
		batch.forEach((candidate, index) => {
			reportProgress();
			const detail = details[index];
			// A failed detail call leaves no aggregate: the task stays "owed" in the cache and is
			// retried next pass, rather than being remembered as having contributed nothing.
			if (!detail || detail.error || !detail.sessions) { outcomes.set(candidate.cacheKey, undefined); return; }
			const totals = sumCloudSessionUsage(detail.sessions);
			outcomes.set(candidate.cacheKey, totals);
			foldAggregateIntoRow(rows.get(candidate.key), totals);
		});
	}
	return outcomes;
}

/** Order rows by cost, then activity, then name — with the "no repository" bucket last. */
function sortRepoRows(rows: AgentRepoSummary[]): AgentRepoSummary[] {
	return rows.sort((a, b) => {
		if (Boolean(a.unassigned) !== Boolean(b.unassigned)) { return a.unassigned ? 1 : -1; }
		if (b.totalCredits !== a.totalCredits) { return b.totalCredits - a.totalCredits; }
		if (b.tasksTotal !== a.tasksTotal) { return b.tasksTotal - a.tasksTotal; }
		return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
	});
}

/**
 * Collect cloud-agent session stats for the authenticated user across both sources:
 * the workspace's git remotes (which also surface tasks other people started in those repos) and
 * the account-wide `/agents/tasks` listing (which surfaces tasks started from github.com in repos
 * that aren't checked out locally, plus ad-hoc cloud chat tasks with no repository at all).
 *
 * The account-wide listing only guarantees a bare `repository.id` on each task, so those are
 * resolved to `owner/repo` via `GET /repositories/{id}` (capped, cached per distinct ID for the
 * pass) before rows are built — otherwise every account-only task would wrongly land in the "no
 * repository" bucket even though it belongs to a real repo.
 *
 * Tasks are deduplicated by ID across both listings, so a task visible in both is counted once.
 * The number of task-detail calls is capped: the newest tasks are detailed first and any repo with
 * tasks left over is flagged `partial`, making its totals a lower bound.
 */
export async function collectAgentSessions(options: CollectAgentSessionsOptions): Promise<AgentSessionsCollection> {
	const rows = new Map<string, AgentRepoSummary>();
	const candidates = new Map<string, AgentTaskCandidate>();
	const maxDetails = options.maxTaskDetails ?? MAX_TASK_DETAILS_PER_REFRESH;
	const cachedByKey = indexCachedTasks(options.cachedTasks);

	// Progress is reported over: one unit per workspace repo listing, one for the account listing,
	// and one per task-detail call. The detail count is only known after listing, so the total is
	// re-estimated as it grows rather than pretending to be exact up front.
	let done = 0;
	let total = options.workspaceRepos.length + 1;
	const reportProgress = () => { done++; options.onProgress?.(done, Math.max(total, done)); };

	const workspaceComplete = await collectWorkspaceTasks(options, rows, candidates, reportProgress);
	const account = await collectAccountTasks(options, rows, candidates);
	reportProgress();

	for (const candidate of candidates.values()) {
		const row = rows.get(candidate.key);
		if (row) { row.tasksTotal++; }
	}

	// Split the listing into what the cache already answers and what still owes a detail call. Only
	// the latter spends the budget, so a mostly-unchanged account now costs a handful of calls
	// instead of the full 200 — and the newest invalidated work is detailed first.
	const { reusable, needsDetail } = partitionByCacheHit(candidates, cachedByKey);
	const selected = needsDetail.sort((a, b) => b.sortAt - a.sortAt).slice(0, maxDetails);
	total += selected.length;
	for (const candidate of [...reusable, ...selected]) {
		const row = rows.get(candidate.key);
		if (row) { row.tasksScanned++; }
	}
	for (const row of rows.values()) { row.partial = row.tasksTotal > row.tasksScanned; }

	for (const candidate of reusable) {
		foldAggregateIntoRow(rows.get(candidate.key), cachedByKey.get(candidate.cacheKey)!.aggregate!);
	}
	const outcomes = await foldTaskDetails(selected, options, rows, reportProgress);

	// A selected task whose detail call failed contributed nothing, so its row's totals are short
	// even though it was counted as scanned. Mark those rows (and the whole result) partial now
	// that the outcomes are known — before this, a repo could show an under-count as complete.
	const failed = selected.filter((candidate) => outcomes.get(candidate.cacheKey) === undefined);
	for (const candidate of failed) {
		const row = rows.get(candidate.key);
		if (row) { row.partial = true; }
	}

	const listingComplete = workspaceComplete && account.available && account.complete;
	const repos = sortRepoRows(Array.from(rows.values()));
	return {
		repos,
		totalTasks: repos.reduce((sum, r) => sum + r.totalTasks, 0),
		totalSessions: repos.reduce((sum, r) => sum + r.totalSessions, 0),
		totalCredits: repos.reduce((sum, r) => sum + r.totalCredits, 0),
		totalPremiumRequests: repos.reduce((sum, r) => sum + r.totalPremiumRequests, 0),
		authenticated: true,
		since: options.since.toISOString(),
		fetchedAt: new Date().toISOString(),
		accountTasksAvailable: account.available,
		accountTasksError: account.error,
		// Lower bound whenever the detail budget was short, a detail call failed, or a listing did
		// not enumerate fully.
		partial: needsDetail.length > selected.length || failed.length > 0 || !listingComplete,
		taskRecords: buildTaskRecords(candidates, cachedByKey, new Set(selected.map(c => c.cacheKey)), outcomes),
		seenTaskKeys: new Set([...candidates.values()].map((c) => c.cacheKey)),
		listingComplete,
	};
}

/** Index the previous pass's records by cache key, ignoring anything malformed. */
function indexCachedTasks(cachedTasks: readonly AgentTaskRecord[] | undefined): Map<string, AgentTaskRecord> {
	const byKey = new Map<string, AgentTaskRecord>();
	for (const record of cachedTasks ?? []) {
		if (record && typeof record.key === 'string' && record.key) { byKey.set(record.key, record); }
	}
	return byKey;
}

/**
 * Decide, per task, whether the cache already answers it. A hit needs all four of: a record under
 * the same scoped key, a successful previous detail fetch, a stored aggregate, and a listing
 * `updated_at` that matches the record's exactly. A task with no usable timestamp never hits.
 */
function partitionByCacheHit(
	candidates: Map<string, AgentTaskCandidate>,
	cachedByKey: Map<string, AgentTaskRecord>,
): { reusable: AgentTaskCandidate[]; needsDetail: AgentTaskCandidate[] } {
	const reusable: AgentTaskCandidate[] = [];
	const needsDetail: AgentTaskCandidate[] = [];
	for (const candidate of candidates.values()) {
		const cached = cachedByKey.get(candidate.cacheKey);
		const hit = Boolean(
			cached && cached.detailOk && cached.aggregate
			&& entityTimestampsMatch(cached.updatedAt, candidate.updatedAt),
		);
		(hit ? reusable : needsDetail).push(candidate);
	}
	return { reusable, needsDetail };
}

/**
 * Build the records to cache for this pass, from current listing membership only.
 *
 * A task whose detail was reused or freshly fetched carries its aggregate; one whose fetch failed
 * or never ran (budget) is recorded as still owed, with its consecutive failure count so a
 * permanently broken task is visible rather than silently retried forever. Tasks with no usable
 * `updated_at` are left out entirely — they are uncacheable by construction.
 */
function buildTaskRecords(
	candidates: Map<string, AgentTaskCandidate>,
	cachedByKey: Map<string, AgentTaskRecord>,
	attempted: Set<string>,
	outcomes: Map<string, AgentTaskAggregate | undefined>,
): AgentTaskRecord[] {
	const now = new Date().toISOString();
	const records: AgentTaskRecord[] = [];
	for (const candidate of candidates.values()) {
		if (candidate.updatedAt === '') { continue; }
		records.push(buildTaskRecord(candidate, cachedByKey.get(candidate.cacheKey), attempted, outcomes, now));
	}
	return records;
}

/** The record for one task: what is known about its detail now, and what was known before. */
function buildTaskRecord(
	candidate: AgentTaskCandidate,
	cached: AgentTaskRecord | undefined,
	attempted: Set<string>,
	outcomes: Map<string, AgentTaskAggregate | undefined>,
	now: string,
): AgentTaskRecord {
	const stillValid = cached?.updatedAt === candidate.updatedAt;
	const previousAttempts = stillValid ? (cached?.detailAttempts ?? 0) : 0;
	const wasAttempted = attempted.has(candidate.cacheKey);
	const fresh = wasAttempted ? outcomes.get(candidate.cacheKey) : undefined;
	const aggregate = fresh ?? (stillValid && cached?.detailOk ? cached.aggregate : undefined);
	const failedNow = wasAttempted && fresh === undefined;
	return {
		key: candidate.cacheKey,
		id: candidate.id,
		repoKey: candidate.key,
		owner: candidate.owner,
		repo: candidate.repo,
		discovery: candidate.discovery,
		updatedAt: candidate.updatedAt,
		aggregate,
		detailOk: aggregate !== undefined,
		// A fresh success resets the count; a failure increments it; a task the budget never
		// reached keeps the count it already had, so its retry history is not silently lost.
		detailAttempts: aggregate !== undefined ? 0 : previousAttempts + (failedNow ? 1 : 0),
		lastSeenAt: now,
	};
}
