import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import type * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { detectAiType, detectCoAuthorAiType, normalizeRepoKey, reconcileRepoPrRecords, summarizeRepoPrRecords, toCacheableRepoPrRecords, toRepoPrRecord, fetchPrCommitMessages, fetchRepoPrs, fetchRepoPrsPage, fetchCopilotPlanInfo, fetchCopilotTokenEndpointInfo, fetchUserEnterprises, fetchEnterprisePremiumBudgets, discoverGitHubRepos, fetchPrCopilotReviews, fetchPrCopilotReviewRequests, fetchPrCopilotReviewActivity, isCompletedCopilotReview, isAttributableCopilotReviewRequest, type CopilotPlanInfo, type CopilotTokenEndpointInfo, type EnterpriseInfo, type EnterpriseBudgetEntry } from '../../src/githubPrService';

/**
 * Minimal stand-in for `http.ClientRequest`, exercising exactly the surface
 * `attachRequestFailureHandling` (see `src/githubApiConfig.ts`) touches. Lets a test drive the
 * real request-creation code path in `githubPrService.ts` end-to-end without a live network call.
 * `fetchRepoPrsPage` accepts an injectable `requestFn` (defaulting to the real `https.request`) for
 * exactly this purpose — Node's built-in module exports are non-configurable in current versions,
 * so monkey-patching `https.request` directly is not viable here.
 */
class FakeClientRequest extends EventEmitter {
	private timeoutCallback?: () => void;
	setTimeout(_ms: number, cb: () => void): this {
		this.timeoutCallback = cb;
		return this;
	}
	destroy(err?: Error): this {
		if (err) { this.emit('error', err); }
		return this;
	}
	end(): this { return this; }
	fireTimeout(): void { this.timeoutCallback?.(); }
}

// ---------------------------------------------------------------------------
// detectAiType — pure function, no I/O
// ---------------------------------------------------------------------------

test('detectAiType: returns copilot for a Bot-typed login containing "copilot"', () => {
	assert.equal(detectAiType({ login: 'copilot-swe-agent', type: 'Bot' }), 'copilot');
	assert.equal(detectAiType({ login: 'github-copilot-bot', type: 'Bot' }), 'copilot');
	assert.equal(detectAiType({ login: 'COPILOT-agent', type: 'Bot' }), 'copilot');
});

test('detectAiType: returns claude for a Bot-typed login containing "claude" or "anthropic"', () => {
	assert.equal(detectAiType({ login: 'claude-code-action', type: 'Bot' }), 'claude');
	assert.equal(detectAiType({ login: 'anthropic-bot', type: 'Bot' }), 'claude');
	assert.equal(detectAiType({ login: 'Claude-Agent', type: 'Bot' }), 'claude');
});

test('detectAiType: returns openai for a Bot-typed login containing "openai" or "codex"', () => {
	assert.equal(detectAiType({ login: 'openai-code-agent', type: 'Bot' }), 'openai');
	assert.equal(detectAiType({ login: 'codex-bot', type: 'Bot' }), 'openai');
	assert.equal(detectAiType({ login: 'OPENAI-agent', type: 'Bot' }), 'openai');
});

test('detectAiType: returns null for a regular human login', () => {
	assert.equal(detectAiType({ login: 'octocat', type: 'User' }), null);
	assert.equal(detectAiType({ login: 'jane-doe', type: 'User' }), null);
	assert.equal(detectAiType({ login: '', type: 'User' }), null);
	assert.equal(detectAiType(undefined), null);
	assert.equal(detectAiType(null), null);
});

test('detectAiType: copilot match takes priority over other patterns', () => {
	// A login that technically contains both; copilot check comes first
	assert.equal(detectAiType({ login: 'copilot-openai-test', type: 'Bot' }), 'copilot');
});

test('detectAiType: gates on user.type === "Bot" rather than the login string alone', () => {
	// Same logins as the recognized-pattern tests above, but type: 'User' — must not classify as AI.
	assert.equal(detectAiType({ login: 'copilot-swe-agent', type: 'User' }), null);
	assert.equal(detectAiType({ login: 'claude-code-action', type: 'User' }), null);
	assert.equal(detectAiType({ login: 'openai-code-agent', type: 'User' }), null);
});

test('detectAiType: recognizes the "[bot]" login suffix as a secondary bot signal when type is absent', () => {
	assert.equal(detectAiType({ login: 'copilot-swe-agent[bot]' }), 'copilot');
	assert.equal(detectAiType({ login: 'dependabot[bot]' }), 'other-ai');
});

test('detectAiType: false positives — a human login containing an AI substring is not classified as AI', () => {
	assert.equal(detectAiType({ login: 'copilotpilot', type: 'User' }), null);
	assert.equal(detectAiType({ login: 'claudia-dev', type: 'User' }), null);
	assert.equal(detectAiType({ login: 'openai-research-partner', type: 'User' }), null);
	assert.equal(detectAiType({ login: 'codexterous', type: 'User' }), null);
});

test('detectAiType: an unrecognized Bot-typed account (e.g. a custom enterprise GitHub App) is classified as other-ai, not human', () => {
	assert.equal(detectAiType({ login: 'acme-devbot[bot]', type: 'Bot' }), 'other-ai');
	assert.equal(detectAiType({ login: 'internal-release-bot', type: 'Bot' }), 'other-ai');
});

// ---------------------------------------------------------------------------
// detectCoAuthorAiType — pure function, no I/O
// ---------------------------------------------------------------------------

test('detectCoAuthorAiType: detects Claude Code from its noreply@anthropic.com trailer', () => {
	const messages = ['Fix bug\n\nCo-Authored-By: Claude <noreply@anthropic.com>'];
	assert.equal(detectCoAuthorAiType(messages), 'claude');
});

test('detectCoAuthorAiType: detects Copilot coding agent from its bot trailer', () => {
	const messages = ['Add feature\n\nCo-authored-by: copilot-swe-agent[bot] <123+copilot-swe-agent[bot]@users.noreply.github.com>'];
	assert.equal(detectCoAuthorAiType(messages), 'copilot');
});

test('detectCoAuthorAiType: returns null when no commit has a recognized AI trailer', () => {
	const messages = ['Fix bug\n\nCo-authored-by: Jane Doe <jane@example.com>', 'Unrelated commit'];
	assert.equal(detectCoAuthorAiType(messages), null);
});

test('detectCoAuthorAiType: returns null for an empty message list', () => {
	assert.equal(detectCoAuthorAiType([]), null);
});

// ---------------------------------------------------------------------------
// fetchPrCommitMessages — uses injectable fetcher
// ---------------------------------------------------------------------------

test('fetchPrCommitMessages: returns commit messages on success', async () => {
	const mockFetcher = async () => ({ messages: ['first commit', 'second commit'], statusCode: 200 });
	const { messages, error } = await fetchPrCommitMessages('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(messages, ['first commit', 'second commit']);
	assert.equal(error, undefined);
});

test('fetchPrCommitMessages: propagates error from fetcher', async () => {
	const mockFetcher = async () => ({ messages: [], statusCode: 404, error: 'Not Found' });
	const { messages, error } = await fetchPrCommitMessages('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(messages, []);
	assert.equal(error, 'Not Found');
});

// ---------------------------------------------------------------------------
// isCompletedCopilotReview — pure function, no I/O
// ---------------------------------------------------------------------------

test('isCompletedCopilotReview: true for a submitted Copilot review', () => {
	assert.equal(isCompletedCopilotReview({ user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'COMMENTED' }), true);
	assert.equal(isCompletedCopilotReview({ user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'APPROVED' }), true);
});

test('isCompletedCopilotReview: false for a PENDING (drafted, not yet submitted) Copilot review', () => {
	assert.equal(isCompletedCopilotReview({ user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'PENDING' }), false);
});

test('isCompletedCopilotReview: false for a submitted review from someone other than Copilot', () => {
	assert.equal(isCompletedCopilotReview({ user: { login: 'octocat' }, state: 'COMMENTED' }), false);
});

test('isCompletedCopilotReview: false for a Copilot review with a missing/undefined state', () => {
	// A partial or unexpected-shape API response must not be treated as completed just because
	// `undefined !== 'PENDING'` — state has to be a real, non-PENDING string.
	assert.equal(isCompletedCopilotReview({ user: { login: 'copilot-pull-request-reviewer[bot]' } }), false);
	assert.equal(isCompletedCopilotReview({ user: { login: 'copilot-pull-request-reviewer[bot]' }, state: undefined }), false);
});

test('isCompletedCopilotReview: false for missing user/state', () => {
	assert.equal(isCompletedCopilotReview({}), false);
	assert.equal(isCompletedCopilotReview(null), false);
	assert.equal(isCompletedCopilotReview(undefined), false);
});

// ---------------------------------------------------------------------------
// isAttributableCopilotReviewRequest — pure function, no I/O
// ---------------------------------------------------------------------------

test('isAttributableCopilotReviewRequest: true for a review_requested event naming Copilot with a real actor login', () => {
	assert.equal(
		isAttributableCopilotReviewRequest({ event: 'review_requested', requested_reviewer: { login: 'Copilot' }, actor: { login: 'rajbos' } }),
		true,
	);
});

test('isAttributableCopilotReviewRequest: false when the actor login is missing (e.g. a deleted account) — not synthesized into "unknown"', () => {
	assert.equal(
		isAttributableCopilotReviewRequest({ event: 'review_requested', requested_reviewer: { login: 'Copilot' }, actor: {} }),
		false,
	);
	assert.equal(
		isAttributableCopilotReviewRequest({ event: 'review_requested', requested_reviewer: { login: 'Copilot' } }),
		false,
	);
	assert.equal(
		isAttributableCopilotReviewRequest({ event: 'review_requested', requested_reviewer: { login: 'Copilot' }, actor: { login: '' } }),
		false,
	);
});

test('isAttributableCopilotReviewRequest: false for a review_requested event naming a different reviewer', () => {
	assert.equal(
		isAttributableCopilotReviewRequest({ event: 'review_requested', requested_reviewer: { login: 'octocat' }, actor: { login: 'rajbos' } }),
		false,
	);
});

test('isAttributableCopilotReviewRequest: false for a non-review_requested timeline event', () => {
	assert.equal(
		isAttributableCopilotReviewRequest({ event: 'commented', requested_reviewer: { login: 'Copilot' }, actor: { login: 'rajbos' } }),
		false,
	);
});

test('isAttributableCopilotReviewRequest: false for missing/null/undefined input', () => {
	assert.equal(isAttributableCopilotReviewRequest({}), false);
	assert.equal(isAttributableCopilotReviewRequest(null), false);
	assert.equal(isAttributableCopilotReviewRequest(undefined), false);
});

// ---------------------------------------------------------------------------
// fetchPrCopilotReviews / fetchPrCopilotReviewRequests / fetchPrCopilotReviewActivity
// ---------------------------------------------------------------------------

test('fetchPrCopilotReviews: returns reviews on success', async () => {
	const reviews = [{ submittedAt: '2026-09-19T14:18:55Z', state: 'COMMENTED' }];
	const mockFetcher = async () => ({ reviews, statusCode: 200 });
	const result = await fetchPrCopilotReviews('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(result.reviews, reviews);
	assert.equal(result.error, undefined);
});

test('fetchPrCopilotReviews: propagates error from fetcher', async () => {
	const mockFetcher = async () => ({ reviews: [], statusCode: 404, error: 'Not Found' });
	const result = await fetchPrCopilotReviews('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(result.reviews, []);
	assert.equal(result.error, 'Not Found');
});

test('fetchPrCopilotReviews: pages through a full first page to collect reviews from a second page', async () => {
	// A full page of 100 raw reviews with only one of them Copilot's must not be mistaken for
	// "no more pages" just because the filtered `reviews.length` (1) is well under 100.
	const pages = [
		{ reviews: [{ submittedAt: '2026-09-19T10:00:00Z', state: 'COMMENTED' }], pageSize: 100, statusCode: 200 },
		{ reviews: [{ submittedAt: '2026-09-19T11:00:00Z', state: 'APPROVED' }], pageSize: 3, statusCode: 200 },
	];
	const calledPages: number[] = [];
	const mockFetcher = async (_o: string, _r: string, _n: number, _t: string, page: number) => {
		calledPages.push(page);
		return pages[page - 1];
	};
	const result = await fetchPrCopilotReviews('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(calledPages, [1, 2]);
	assert.deepEqual(result.reviews, [...pages[0].reviews, ...pages[1].reviews]);
	assert.equal(result.error, undefined);
});

test('fetchPrCopilotReviews: stops at the page cap rather than paginating forever', async () => {
	let calls = 0;
	const countingFetcher = async () => { calls++; return { reviews: [], pageSize: 100, statusCode: 200 }; };
	await fetchPrCopilotReviews('owner', 'repo', 42, 'token', countingFetcher);
	assert.equal(calls, 5);
});

test('fetchPrCopilotReviewRequests: returns requests on success', async () => {
	const requests = [{ requestedBy: 'rajbos', requestedAt: '2026-09-19T14:12:18Z' }];
	const mockFetcher = async () => ({ requests, statusCode: 200 });
	const result = await fetchPrCopilotReviewRequests('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(result.requests, requests);
	assert.equal(result.error, undefined);
});

test('fetchPrCopilotReviewRequests: pages through a full first page to collect requests from a second page', async () => {
	// A full page of 100 raw timeline events with only one review request must not be mistaken
	// for "no more pages" just because the filtered `requests.length` (1) is well under 100.
	const pages = [
		{ requests: [{ requestedBy: 'rajbos', requestedAt: '2026-09-19T10:00:00Z' }], pageSize: 100, statusCode: 200 },
		{ requests: [{ requestedBy: 'octocat', requestedAt: '2026-09-19T11:00:00Z' }], pageSize: 3, statusCode: 200 },
	];
	const calledPages: number[] = [];
	const mockFetcher = async (_o: string, _r: string, _n: number, _t: string, page: number) => {
		calledPages.push(page);
		return pages[page - 1];
	};
	const result = await fetchPrCopilotReviewRequests('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(calledPages, [1, 2]);
	assert.deepEqual(result.requests, [...pages[0].requests, ...pages[1].requests]);
	assert.equal(result.error, undefined);
});

test('fetchPrCopilotReviewRequests: stops at the page cap rather than paginating forever', async () => {
	let calls = 0;
	const countingFetcher = async () => { calls++; return { requests: [], pageSize: 100, statusCode: 200 }; };
	await fetchPrCopilotReviewRequests('owner', 'repo', 42, 'token', countingFetcher);
	assert.equal(calls, 5);
});

test('fetchPrCopilotReviewRequests: propagates error from fetcher', async () => {
	const mockFetcher = async () => ({ requests: [], statusCode: 403, error: 'Forbidden' });
	const result = await fetchPrCopilotReviewRequests('owner', 'repo', 42, 'token', mockFetcher);
	assert.deepEqual(result.requests, []);
	assert.equal(result.error, 'Forbidden');
});

test('fetchPrCopilotReviewActivity: combines reviews and requests from both fetchers', async () => {
	const reviews = [
		{ submittedAt: '2026-09-19T10:25:49Z', state: 'COMMENTED' },
		{ submittedAt: '2026-09-19T14:19:01Z', state: 'COMMENTED' },
	];
	const requests = [
		{ requestedBy: 'rajbos', requestedAt: '2026-09-19T10:20:02Z' },
		{ requestedBy: 'rajbos', requestedAt: '2026-09-19T14:12:18Z' },
	];
	const mockFetchReviews = async () => ({ reviews, statusCode: 200 });
	const mockFetchRequests = async () => ({ requests, statusCode: 200 });
	const result = await fetchPrCopilotReviewActivity('owner', 'repo', 42, 'token', mockFetchReviews, mockFetchRequests);
	assert.deepEqual(result.reviews, reviews);
	assert.deepEqual(result.requests, requests);
	assert.equal(result.error, undefined);
});

test('fetchPrCopilotReviewActivity: surfaces an error from either fetcher', async () => {
	const mockFetchReviews = async () => ({ reviews: [], statusCode: 500, error: 'Server error' });
	const mockFetchRequests = async () => ({ requests: [], statusCode: 200 });
	const result = await fetchPrCopilotReviewActivity('owner', 'repo', 42, 'token', mockFetchReviews, mockFetchRequests);
	assert.equal(result.error, 'Server error');
});

// ---------------------------------------------------------------------------
// fetchRepoPrs — pagination logic with mock fetchPage
// ---------------------------------------------------------------------------

function makePr(createdAt: string, number = 1) {
	return {
		number,
		title: 'test PR',
		html_url: `https://github.com/owner/repo/pull/${number}`,
		user: { login: 'octocat' },
		requested_reviewers: [],
		created_at: createdAt,
	};
}

test('fetchRepoPrs: returns empty array when first page is empty', async () => {
	const mockFetchPage = async () => ({ prs: [] });
	const since = new Date('2024-01-01T00:00:00Z');
	const { prs, error } = await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(prs.length, 0);
	assert.equal(error, undefined);
});

test('fetchRepoPrs: returns prs created after since date', async () => {
	const since = new Date('2024-01-15T00:00:00Z');
	const recentPr = makePr('2024-01-20T00:00:00Z');
	const oldPr = makePr('2024-01-10T00:00:00Z');

	const mockFetchPage = async () => ({ prs: [recentPr, oldPr] });
	const { prs, error } = await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(prs.length, 1);
	assert.equal(prs[0].created_at, '2024-01-20T00:00:00Z');
	assert.equal(error, undefined);
});

test('fetchRepoPrs: stops paginating when oldest PR on page is before since', async () => {
	const since = new Date('2024-01-15T00:00:00Z');
	let callCount = 0;

	// Page 1: 100 PRs, but the oldest is before since
	const page1 = Array.from({ length: 100 }, (_, i) =>
		makePr(i < 50 ? '2024-01-20T00:00:00Z' : '2024-01-10T00:00:00Z', i + 1)
	);

	const mockFetchPage = async (_owner: string, _repo: string, _token: string, _page: number) => {
		callCount++;
		return { prs: page1 };
	};

	const { prs } = await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(callCount, 1); // Should not request page 2
	assert.equal(prs.length, 50); // Only the 50 PRs after since
});

test('fetchRepoPrs: paginates when page is full and oldest is after since', async () => {
	const since = new Date('2024-01-01T00:00:00Z');
	let callCount = 0;

	const mockFetchPage = async (_owner: string, _repo: string, _token: string, page: number) => {
		callCount++;
		if (page === 1) {
			// Full page, all PRs after since
			return { prs: Array.from({ length: 100 }, (_, i) => makePr('2024-01-20T00:00:00Z', i + 1)) };
		}
		// Second page is empty — stop
		return { prs: [] };
	};

	const { prs } = await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(callCount, 2);
	assert.equal(prs.length, 100);
});

test('fetchRepoPrs: caps at 5 pages maximum', async () => {
	const since = new Date('2024-01-01T00:00:00Z');
	let callCount = 0;

	// Every page returns 100 PRs all after since — would be infinite without the cap
	const mockFetchPage = async (_owner: string, _repo: string, _token: string, page: number) => {
		callCount++;
		return { prs: Array.from({ length: 100 }, (_, i) => makePr('2024-01-20T00:00:00Z', (page - 1) * 100 + i + 1)) };
	};

	await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(callCount, 5);
});

test('fetchRepoPrs: propagates error from fetchPage with 404 status', async () => {
	const mockFetchPage = async () => ({ prs: [], statusCode: 404, error: 'Not Found' });
	const since = new Date('2024-01-01T00:00:00Z');
	const { prs, error } = await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(prs.length, 0);
	assert.equal(error, 'Repo not found or not accessible with current token');
});

test('fetchRepoPrs: propagates error from fetchPage with 403 status', async () => {
	const mockFetchPage = async () => ({ prs: [], statusCode: 403, error: 'Forbidden' });
	const since = new Date('2024-01-01T00:00:00Z');
	const { prs, error } = await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(prs.length, 0);
	assert.equal(error, 'Forbidden');
});

test('fetchRepoPrs: propagates generic error from fetchPage', async () => {
	const mockFetchPage = async () => ({ prs: [], error: 'Network error' });
	const since = new Date('2024-01-01T00:00:00Z');
	const { prs, error } = await fetchRepoPrs('owner', 'repo', 'token', since, mockFetchPage);
	assert.equal(prs.length, 0);
	assert.equal(error, 'Network error');
});

test('fetchRepoPrs: stops waiting when a page fetch never settles', async () => {
	const hangingFetchPage = async (): Promise<{ prs: any[] }> => new Promise(() => {});
	const since = new Date('2024-01-01T00:00:00Z');
	const { prs, error } = await fetchRepoPrs('owner', 'repo', 'token', since, hangingFetchPage, 5);
	assert.deepEqual(prs, []);
	assert.match(error ?? '', /Fetching PRs for owner\/repo page 1 timed out/);
});

// ---------------------------------------------------------------------------
// fetchRepoPrsPage — end-to-end through the real `https.request` wiring,
// verifying it reports a genuine transport failure distinctly from a
// socket-inactivity timeout (PR #1919 follow-up item 1: the mislabelled
// GitHub request timeout).
// ---------------------------------------------------------------------------

test('fetchRepoPrsPage: a genuine connection error is reported with its real code, not as a timeout', async () => {
	const req = new FakeClientRequest();
	const fakeRequestFn = (() => req) as unknown as typeof http.request;
	const promise = fetchRepoPrsPage('owner', 'repo', 'token', 1, fakeRequestFn);
	req.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
	const { prs, error } = await promise;
	assert.deepEqual(prs, []);
	assert.match(error ?? '', /^Connection failed after \d+(\.\d+)?s \(ECONNRESET\): read ECONNRESET$/);
	assert.doesNotMatch(error ?? '', /timed out|inactivity/i);
});

test('fetchRepoPrsPage: a socket-inactivity timeout is reported with the real elapsed time, not the configured limit', async () => {
	const req = new FakeClientRequest();
	const fakeRequestFn = (() => req) as unknown as typeof http.request;
	const promise = fetchRepoPrsPage('owner', 'repo', 'token', 1, fakeRequestFn);
	await new Promise((resolve) => setTimeout(resolve, 5));
	req.fireTimeout();
	const { prs, error } = await promise;
	assert.deepEqual(prs, []);
	assert.match(error ?? '', /^No response for \d+(\.\d+)?s \(socket inactivity limit 15s\)$/);
});

// ---------------------------------------------------------------------------
// fetchCopilotPlanInfo — uses injectable fetcher
// ---------------------------------------------------------------------------

test('fetchCopilotPlanInfo: returns plan info on success', async () => {
	const planData: CopilotPlanInfo = {
		copilot_plan: 'copilot_individual',
		ide_chat: 'enabled',
		copilot_ide_agent: 'enabled',
		public_code_suggestions: 'block',
		unlimited_pr_summaries: true,
	};
	const mockFetcher = async () => ({ planInfo: planData, statusCode: 200 });
	const { planInfo, statusCode, error } = await fetchCopilotPlanInfo('token', mockFetcher);
	assert.equal(error, undefined);
	assert.equal(statusCode, 200);
	assert.deepEqual(planInfo, planData);
});

test('fetchCopilotPlanInfo: returns error on non-2xx response', async () => {
	const mockFetcher = async () => ({ statusCode: 401, error: 'HTTP 401' });
	const { planInfo, statusCode, error } = await fetchCopilotPlanInfo('token', mockFetcher);
	assert.equal(planInfo, undefined);
	assert.equal(statusCode, 401);
	assert.equal(error, 'HTTP 401');
});

test('fetchCopilotPlanInfo: returns error on 403 response', async () => {
	const mockFetcher = async () => ({ statusCode: 403, error: 'HTTP 403' });
	const { planInfo, statusCode, error } = await fetchCopilotPlanInfo('token', mockFetcher);
	assert.equal(planInfo, undefined);
	assert.equal(statusCode, 403);
});

test('fetchCopilotPlanInfo: returns error on network failure', async () => {
	const mockFetcher = async () => ({ error: 'socket hang up' });
	const { planInfo, error } = await fetchCopilotPlanInfo('token', mockFetcher);
	assert.equal(planInfo, undefined);
	assert.equal(error, 'socket hang up');
});

test('fetchCopilotPlanInfo: returns error on unexpected response format', async () => {
	const mockFetcher = async () => ({ statusCode: 200, error: 'Unexpected response format' });
	const { planInfo, error } = await fetchCopilotPlanInfo('token', mockFetcher);
	assert.equal(planInfo, undefined);
	assert.ok(error?.includes('Unexpected response format'));
});

test('fetchCopilotPlanInfo: handles partial plan data gracefully', async () => {
	// Not all fields may be present — only copilot_plan returned
	const mockFetcher = async () => ({ planInfo: { copilot_plan: 'copilot_free' } as CopilotPlanInfo, statusCode: 200 });
	const { planInfo, error } = await fetchCopilotPlanInfo('token', mockFetcher);
	assert.equal(error, undefined);
	assert.equal(planInfo?.copilot_plan, 'copilot_free');
	assert.equal(planInfo?.ide_chat, undefined);
});

// ---------------------------------------------------------------------------
// fetchCopilotTokenEndpointInfo — uses injectable fetcher
// ---------------------------------------------------------------------------

test('fetchCopilotTokenEndpointInfo: returns endpoint info on success', async () => {
	const endpointData: CopilotTokenEndpointInfo = {
		endpoints: { api: 'https://api.individual.githubcopilot.com' },
		expires_at: 1730000000,
		refresh_in: 1500,
		sku: 'copilot_individual',
	};
	const mockFetcher = async () => ({ info: endpointData, statusCode: 200 });
	const { info, statusCode, error } = await fetchCopilotTokenEndpointInfo('token', mockFetcher);
	assert.equal(error, undefined);
	assert.equal(statusCode, 200);
	assert.deepEqual(info, endpointData);
});

test('fetchCopilotTokenEndpointInfo: returns error on non-2xx response', async () => {
	const mockFetcher = async () => ({ statusCode: 401, error: 'HTTP 401' });
	const { info, statusCode, error } = await fetchCopilotTokenEndpointInfo('token', mockFetcher);
	assert.equal(info, undefined);
	assert.equal(statusCode, 401);
	assert.equal(error, 'HTTP 401');
});

test('fetchCopilotTokenEndpointInfo: returns error on network failure', async () => {
	const mockFetcher = async () => ({ error: 'socket hang up' });
	const { info, error } = await fetchCopilotTokenEndpointInfo('token', mockFetcher);
	assert.equal(info, undefined);
	assert.equal(error, 'socket hang up');
});

test('fetchCopilotTokenEndpointInfo: handles partial response gracefully', async () => {
	// Only endpoints returned, no expiry info
	const mockFetcher = async () => ({ info: { endpoints: { api: 'https://api.business.githubcopilot.com' } } as CopilotTokenEndpointInfo, statusCode: 200 });
	const { info, error } = await fetchCopilotTokenEndpointInfo('token', mockFetcher);
	assert.equal(error, undefined);
	assert.equal(info?.endpoints?.api, 'https://api.business.githubcopilot.com');
	assert.equal(info?.expires_at, undefined);
});

test('fetchCopilotTokenEndpointInfo: handles empty info object gracefully', async () => {
	const mockFetcher = async () => ({ info: {} as CopilotTokenEndpointInfo, statusCode: 200 });
	const { info, error } = await fetchCopilotTokenEndpointInfo('token', mockFetcher);
	assert.equal(error, undefined);
	assert.deepEqual(info, {});
});

// ---------------------------------------------------------------------------
// fetchUserEnterprises — uses injectable fetcher
// ---------------------------------------------------------------------------

test('fetchUserEnterprises: returns enterprises on success', async () => {
	const enterprises: EnterpriseInfo[] = [
		{ slug: 'acme-corp', name: 'Acme Corporation' },
		{ slug: 'widgets-inc', name: 'Widgets Inc' },
	];
	const mockFetcher = async () => ({ enterprises });
	const { enterprises: result, error } = await fetchUserEnterprises('token', mockFetcher);
	assert.equal(error, undefined);
	assert.deepEqual(result, enterprises);
});

test('fetchUserEnterprises: returns empty array when user has no enterprises', async () => {
	const mockFetcher = async () => ({ enterprises: [] });
	const { enterprises, error } = await fetchUserEnterprises('token', mockFetcher);
	assert.equal(error, undefined);
	assert.deepEqual(enterprises, []);
});

test('fetchUserEnterprises: returns error on network failure', async () => {
	const mockFetcher = async () => ({ error: 'socket hang up' });
	const { enterprises, error } = await fetchUserEnterprises('token', mockFetcher);
	assert.equal(enterprises, undefined);
	assert.equal(error, 'socket hang up');
});

test('fetchUserEnterprises: returns error on GraphQL error', async () => {
	const mockFetcher = async () => ({ error: 'Must be logged in.' });
	const { enterprises, error } = await fetchUserEnterprises('token', mockFetcher);
	assert.equal(enterprises, undefined);
	assert.ok(error?.includes('Must be logged in'));
});

// ---------------------------------------------------------------------------
// fetchEnterprisePremiumBudgets — uses injectable fetcher
// ---------------------------------------------------------------------------

test('fetchEnterprisePremiumBudgets: returns budgets on success', async () => {
	const budgets: EnterpriseBudgetEntry[] = [
		{ id: 'budget-1', budget_amount: 500, prevent_further_usage: true, budget_scope: 'enterprise', budget_product_skus: ['copilot_premium_requests'] },
	];
	const mockFetcher = async () => ({ budgets, statusCode: 200 });
	const { budgets: result, error } = await fetchEnterprisePremiumBudgets('acme-corp', 'rajbos', 'token', mockFetcher);
	assert.equal(error, undefined);
	assert.deepEqual(result, budgets);
});

test('fetchEnterprisePremiumBudgets: returns error on 403 (not an admin)', async () => {
	const mockFetcher = async () => ({ statusCode: 403, error: 'HTTP 403' });
	const { budgets, statusCode, error } = await fetchEnterprisePremiumBudgets('acme-corp', 'rajbos', 'token', mockFetcher);
	assert.equal(budgets, undefined);
	assert.equal(statusCode, 403);
	assert.equal(error, 'HTTP 403');
});

test('fetchEnterprisePremiumBudgets: returns error on network failure', async () => {
	const mockFetcher = async () => ({ error: 'ECONNREFUSED' });
	const { budgets, error } = await fetchEnterprisePremiumBudgets('acme-corp', 'rajbos', 'token', mockFetcher);
	assert.equal(budgets, undefined);
	assert.equal(error, 'ECONNREFUSED');
});

test('fetchEnterprisePremiumBudgets: returns empty array when no budgets configured', async () => {
	const mockFetcher = async () => ({ budgets: [], statusCode: 200 });
	const { budgets, error } = await fetchEnterprisePremiumBudgets('acme-corp', 'rajbos', 'token', mockFetcher);
	assert.equal(error, undefined);
	assert.deepEqual(budgets, []);
});

// ---------------------------------------------------------------------------
// discoverGitHubRepos — reads real git remotes from temp repos
// ---------------------------------------------------------------------------

/** Create a temp dir with a git repo whose `origin` remote is `remoteUrl`. */
function makeGitRepoWithRemote(remoteUrl: string): string {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'discover-gh-repos-'));
	childProcess.execSync('git init -q', { cwd: dir });
	childProcess.execSync(`git remote add origin ${remoteUrl}`, { cwd: dir });
	return dir;
}

test('discoverGitHubRepos: matches a github.com remote', async () => {
	const dir = makeGitRepoWithRemote('https://github.com/rajbos/ai-engineering-fluency.git');
	try {
		const repos = await discoverGitHubRepos([dir]);
		assert.deepEqual(repos, [{ owner: 'rajbos', repo: 'ai-engineering-fluency' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: ignores a non-github.com remote when no enterprise URI is configured', async () => {
	const dir = makeGitRepoWithRemote('https://customer.ghe.com/rajbos/private-repo.git');
	try {
		const repos = await discoverGitHubRepos([dir]);
		assert.deepEqual(repos, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: matches a GHE.com remote when the enterprise URI is configured', async () => {
	const dir = makeGitRepoWithRemote('https://customer.ghe.com/rajbos/private-repo.git');
	try {
		const repos = await discoverGitHubRepos([dir], 'https://customer.ghe.com');
		assert.deepEqual(repos, [{ owner: 'rajbos', repo: 'private-repo' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: still matches github.com remotes when an enterprise URI is also configured', async () => {
	const dir = makeGitRepoWithRemote('https://github.com/rajbos/ai-engineering-fluency.git');
	try {
		const repos = await discoverGitHubRepos([dir], 'https://customer.ghe.com');
		assert.deepEqual(repos, [{ owner: 'rajbos', repo: 'ai-engineering-fluency' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: matches an on-prem GitHub Enterprise Server remote via SSH form', async () => {
	const dir = makeGitRepoWithRemote('git@github.acme-corp.com:rajbos/internal-tool.git');
	try {
		const repos = await discoverGitHubRepos([dir], 'https://github.acme-corp.com');
		assert.deepEqual(repos, [{ owner: 'rajbos', repo: 'internal-tool' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: skips non-git and missing paths without throwing', async () => {
	const dir = makeGitRepoWithRemote('https://github.com/rajbos/ai-engineering-fluency.git');
	const notARepo = fs.mkdtempSync(path.join(process.cwd(), 'discover-gh-notrepo-'));
	try {
		const repos = await discoverGitHubRepos([notARepo, path.join(process.cwd(), 'does-not-exist-xyz'), dir]);
		assert.deepEqual(repos, [{ owner: 'rajbos', repo: 'ai-engineering-fluency' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(notARepo, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: deduplicates repos reachable from multiple workspace paths', async () => {
	const dir = makeGitRepoWithRemote('https://github.com/rajbos/ai-engineering-fluency.git');
	try {
		const repos = await discoverGitHubRepos([dir, dir]);
		assert.deepEqual(repos, [{ owner: 'rajbos', repo: 'ai-engineering-fluency' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: does not match a github.com mention inside another host\'s URL', async () => {
	const dir = makeGitRepoWithRemote('https://evil.example.com/github.com/rajbos/not-a-match.git');
	try {
		const repos = await discoverGitHubRepos([dir]);
		assert.deepEqual(repos, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('discoverGitHubRepos: matches an ssh://git@ remote', async () => {
	const dir = makeGitRepoWithRemote('ssh://git@github.com/rajbos/ai-engineering-fluency.git');
	try {
		const repos = await discoverGitHubRepos([dir]);
		assert.deepEqual(repos, [{ owner: 'rajbos', repo: 'ai-engineering-fluency' }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Per-PR cache projection and reconciliation (issue #1968)
// ---------------------------------------------------------------------------

/** One raw PR as the `state=all` listing returns it, with only what the projection reads. */
function rawPr(overrides: Record<string, any> = {}): any {
	return {
		number: 1,
		title: 'Add a thing',
		html_url: 'https://github.com/rajbos/repo/pull/1',
		created_at: '2026-08-01T10:00:00Z',
		updated_at: '2026-08-02T10:00:00Z',
		state: 'open',
		merged_at: null,
		user: { login: 'octocat', type: 'User' },
		requested_reviewers: [],
		...overrides,
	};
}

test('normalizeRepoKey is case-insensitive, so a repo cannot be cached under two keys', () => {
	assert.equal(normalizeRepoKey('Rajbos', 'AI-Engineering-Fluency'), 'rajbos/ai-engineering-fluency');
	assert.equal(normalizeRepoKey('rajbos', 'ai-engineering-fluency'), normalizeRepoKey('RAJBOS', 'AI-ENGINEERING-FLUENCY'));
});

test('toRepoPrRecord keeps only the projection the panel renders, with a canonical timestamp', () => {
	const record = toRepoPrRecord(rawPr({
		merged_at: '2026-08-03T10:00:00Z',
		state: 'closed',
		user: { login: 'Copilot', type: 'Bot' },
		requested_reviewers: [{ login: 'claude[bot]', type: 'Bot' }, { login: 'a-human', type: 'User' }],
		body: 'secret body',
	}));
	assert.deepEqual(record, {
		number: 1,
		title: 'Add a thing',
		url: 'https://github.com/rajbos/repo/pull/1',
		createdAt: '2026-08-01T10:00:00.000Z',
		updatedAt: '2026-08-02T10:00:00.000Z',
		state: 'closed',
		merged: true,
		authorAiType: 'copilot',
		authorLogin: 'copilot',
		reviewerAiTypes: ['claude'],
	});
	// The PR body (and anything else not in the projection) is never persisted.
	assert.ok(!JSON.stringify(record).includes('secret body'));
});

test('toRepoPrRecord refuses to cache a PR with a missing or unparseable updated_at', () => {
	assert.equal(toRepoPrRecord(rawPr({ updated_at: undefined })), undefined);
	assert.equal(toRepoPrRecord(rawPr({ updated_at: 'yesterday' })), undefined);
	assert.equal(toRepoPrRecord(rawPr({ number: undefined })), undefined);
});

test('summarizeRepoPrRecords counts AI authorship, AI review requests and the user\'s own PRs', () => {
	const records = [
		toRepoPrRecord(rawPr({ number: 1, user: { login: 'Copilot', type: 'Bot' } }))!,
		toRepoPrRecord(rawPr({ number: 2, requested_reviewers: [{ login: 'copilot[bot]', type: 'Bot' }] }))!,
		toRepoPrRecord(rawPr({ number: 3, merged_at: '2026-08-03T10:00:00Z', state: 'closed' }))!,
	];
	const summary = summarizeRepoPrRecords(records, 'OctoCat');
	assert.equal(summary.totalPrs, 3);
	assert.equal(summary.aiAuthoredPrs, 1);
	assert.equal(summary.aiReviewRequestedPrs, 1);
	assert.equal(summary.userAuthoredPrs, 2);   // #2 and #3, authored by octocat
	assert.equal(summary.userMergedPrs, 1);     // only #3 merged
	assert.deepEqual(summary.aiDetails.map((d) => [d.number, d.role]), [[1, 'author'], [2, 'reviewer-requested']]);
});

test('summarizeRepoPrRecords omits the user columns entirely when the login is unknown', () => {
	const summary = summarizeRepoPrRecords([toRepoPrRecord(rawPr())!]);
	assert.equal(summary.userAuthoredPrs, undefined);
	assert.equal(summary.userMergedPrs, undefined);
	assert.equal(summary.totalPrs, 1);
});

test('reconcileRepoPrRecords reuses a cached PR whose updated_at still matches exactly', () => {
	const cached = toRepoPrRecord(rawPr({ title: 'Cached title' }))!;
	const result = reconcileRepoPrRecords([cached], [rawPr({ title: 'Cached title' })], { listingComplete: true });
	assert.equal(result.reused, 1);
	assert.equal(result.recomputed, 0);
	assert.equal(result.records[0], cached, 'the cached object itself should be reused');
});

test('reconcileRepoPrRecords recomputes a PR whose updated_at moved', () => {
	const cached = toRepoPrRecord(rawPr({ title: 'Old title' }))!;
	const result = reconcileRepoPrRecords(
		[cached],
		[rawPr({ title: 'New title', updated_at: '2026-08-04T10:00:00Z' })],
		{ listingComplete: true },
	);
	assert.equal(result.reused, 0);
	assert.equal(result.recomputed, 1);
	assert.equal(result.records[0].title, 'New title');
	assert.equal(result.records[0].updatedAt, '2026-08-04T10:00:00.000Z');
});

test('reconcileRepoPrRecords never serves a cached PR for a different PR number', () => {
	const cached = toRepoPrRecord(rawPr({ number: 7, title: 'PR seven' }))!;
	const result = reconcileRepoPrRecords([cached], [rawPr({ number: 8, title: 'PR eight' })], { listingComplete: true });
	assert.equal(result.reused, 0);
	assert.deepEqual(result.records.map((r) => [r.number, r.title]), [[8, 'PR eight']]);
});

test('reconcileRepoPrRecords keeps closed and merged PRs represented', () => {
	const listed = [
		rawPr({ number: 1, state: 'closed', merged_at: '2026-08-03T10:00:00Z' }),
		rawPr({ number: 2, state: 'closed', merged_at: null }),
	];
	const result = reconcileRepoPrRecords([], listed, { listingComplete: true });
	assert.deepEqual(result.records.map((r) => [r.number, r.state, r.merged]), [[1, 'closed', true], [2, 'closed', false]]);
});

test('reconcileRepoPrRecords drops an unseen PR only after a complete listing', () => {
	const cached = [toRepoPrRecord(rawPr({ number: 1 }))!, toRepoPrRecord(rawPr({ number: 2 }))!];
	const complete = reconcileRepoPrRecords(cached, [rawPr({ number: 1 })], { listingComplete: true });
	assert.equal(complete.removed, 1);
	assert.equal(complete.retainedUnverified, 0);
	assert.deepEqual(complete.records.map((r) => r.number), [1]);
});

test('reconcileRepoPrRecords retains unseen PRs when the listing was incomplete', () => {
	const cached = [toRepoPrRecord(rawPr({ number: 1 }))!, toRepoPrRecord(rawPr({ number: 2 }))!];
	const partial = reconcileRepoPrRecords(cached, [rawPr({ number: 1 })], { listingComplete: false });
	assert.equal(partial.removed, 0);
	assert.equal(partial.retainedUnverified, 1);
	assert.deepEqual(partial.records.map((r) => r.number).sort(), [1, 2]);
});

test('reconcileRepoPrRecords counts an uncacheable PR this pass but never caches it', () => {
	const result = reconcileRepoPrRecords([], [rawPr({ number: 5, updated_at: 'nope' })], { listingComplete: true });
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0].updatedAt, '');
	assert.deepEqual(toCacheableRepoPrRecords(result.records), []);

	// And a record with an empty timestamp can never be matched on a later pass.
	const next = reconcileRepoPrRecords(result.records, [rawPr({ number: 5, updated_at: 'nope' })], { listingComplete: true });
	assert.equal(next.reused, 0);
});

test('reconcileRepoPrRecords ignores malformed cached entries', () => {
	const cached = [
		{ number: 1, updatedAt: 'garbage' } as any,
		{ number: undefined, updatedAt: '2026-08-02T10:00:00Z' } as any,
	];
	const result = reconcileRepoPrRecords(cached, [rawPr({ number: 1 })], { listingComplete: true });
	assert.equal(result.reused, 0);
	assert.equal(result.recomputed, 1);
	assert.equal(result.removed, 0);
});

test('fetchRepoPrs reports a complete listing when pagination runs out naturally', async () => {
	const since = new Date('2026-08-01T00:00:00Z');
	const page = async () => ({ prs: [rawPr({ created_at: '2026-08-10T00:00:00Z' })] });
	const result = await fetchRepoPrs('rajbos', 'repo', 'token', since, page);
	assert.equal(result.complete, true);
	assert.equal(result.prs.length, 1);
});

test('fetchRepoPrs reports an incomplete listing when the five-page cap is hit', async () => {
	const since = new Date('2026-01-01T00:00:00Z');
	let pages = 0;
	const page = async () => {
		pages++;
		return { prs: Array.from({ length: 100 }, (_, i) => rawPr({ number: pages * 100 + i, created_at: '2026-08-10T00:00:00Z' })) };
	};
	const result = await fetchRepoPrs('rajbos', 'repo', 'token', since, page);
	assert.equal(pages, 5, 'the page cap should still be five');
	assert.equal(result.complete, false, 'a capped listing is not authoritative about removals');
	assert.equal(result.prs.length, 500);
});

test('fetchRepoPrs reports an incomplete listing on an error', async () => {
	const since = new Date('2026-08-01T00:00:00Z');
	const result = await fetchRepoPrs('rajbos', 'repo', 'token', since, async () => ({ prs: [], statusCode: 403, error: 'nope' }));
	assert.equal(result.complete, false);
	assert.ok(result.error);
});

// --- Review follow-ups (PR #2073) -------------------------------------------

test('reconcileRepoPrRecords keeps retained records out of the counted set', () => {
	// An incomplete listing retains a cached PR so the next pass can still reuse it, but that PR
	// might have been deleted — counting it would turn the advertised lower bound into an overcount.
	const cached = [toRepoPrRecord(rawPr({ number: 1 }))!, toRepoPrRecord(rawPr({ number: 2 }))!];
	const result = reconcileRepoPrRecords(cached, [rawPr({ number: 1 })], { listingComplete: false });
	assert.deepEqual(result.listed.map((r) => r.number), [1], 'only the listing is counted');
	assert.deepEqual(result.records.map((r) => r.number).sort(), [1, 2], 'both are still cached');
	assert.equal(summarizeRepoPrRecords(result.listed).totalPrs, 1);
});

test('reconcileRepoPrRecords does not count an uncacheable PR twice', () => {
	// The listing reports PR #1 with a broken timestamp, so it cannot be cached — but it has been
	// spoken for, and an incomplete listing must not also retain the older cached record for it.
	const cached = [toRepoPrRecord(rawPr({ number: 1, title: 'Cached' }))!];
	const result = reconcileRepoPrRecords(cached, [rawPr({ number: 1, updated_at: 'nope' })], { listingComplete: false });
	assert.equal(result.listed.length, 1);
	assert.equal(result.records.length, 1);
	assert.equal(result.retainedUnverified, 0);
});

test('reconcileRepoPrRecords reuses a cached record stored with an alternate ISO spelling', () => {
	// Reuse goes through entityTimestampsMatch(), which compares canonicalized timestamps. A record
	// that reached the cache spelled `...:00+00:00` still names the same instant as the listing's
	// `...:00.000Z`, and re-fetching it would be work done for a difference that does not exist.
	const cached = [{ ...toRepoPrRecord(rawPr({ number: 1, title: 'Cached' }))!, updatedAt: '2026-08-20T10:00:00+00:00' }];
	const result = reconcileRepoPrRecords(cached, [rawPr({ number: 1, title: 'Fresh', updated_at: '2026-08-20T10:00:00.000Z' })], { listingComplete: true });
	assert.equal(result.reused, 1);
	assert.equal(result.recomputed, 0);
	assert.equal(result.listed[0].title, 'Cached');
});

test('reconcileRepoPrRecords drops a retained record that has aged out of the window', () => {
	const since = new Date('2026-08-01T00:00:00Z');
	const inWindow = toRepoPrRecord(rawPr({ number: 1, created_at: '2026-08-10T00:00:00Z' }))!;
	const expired = toRepoPrRecord(rawPr({ number: 2, created_at: '2026-06-01T00:00:00Z' }))!;
	const result = reconcileRepoPrRecords([inWindow, expired], [], { listingComplete: false, since });
	assert.deepEqual(result.records.map((r) => r.number), [1], 'the expired PR is not carried forward');
	assert.equal(result.removed, 1);
	assert.equal(result.retainedUnverified, 1);
});

test('reconcileRepoPrRecords still retains an in-window record with no since given', () => {
	const cached = [toRepoPrRecord(rawPr({ number: 1, created_at: '2020-01-01T00:00:00Z' }))!];
	const result = reconcileRepoPrRecords(cached, [], { listingComplete: false });
	assert.equal(result.retainedUnverified, 1);
});

test('fetchRepoPrs returns the pages it collected before an error, not nothing', () => {
	// Those PRs are real; discarding them would understate the repo for no gain.
	const since = new Date('2026-01-01T00:00:00Z');
	let page = 0;
	return fetchRepoPrs('rajbos', 'repo', 'token', since, async () => {
		page++;
		return page === 1
			? { prs: Array.from({ length: 100 }, (_, i) => rawPr({ number: i, created_at: '2026-08-10T00:00:00Z' })) }
			: { prs: [], statusCode: 500, error: 'boom' };
	}).then((result) => {
		assert.equal(result.prs.length, 100);
		assert.equal(result.complete, false);
		assert.ok(result.error);
	});
});

test('toRepoPrRecord refuses a PR with a malformed created_at', () => {
	// `createdAt` is what decides whether a retained record has aged out. Caching a record without
	// one would let a single bad timestamp pin it in the cache forever.
	assert.equal(toRepoPrRecord(rawPr({ created_at: undefined })), undefined);
	assert.equal(toRepoPrRecord(rawPr({ created_at: 'yesterday' })), undefined);
});

test('toRepoPrRecord refuses PR numbers GitHub cannot produce', () => {
	// GitHub's PR numbers are 1-based; 0, negatives and non-finite values are malformed.
	for (const number of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(toRepoPrRecord(rawPr({ number })), undefined, `expected ${number} to be uncacheable`);
	}
	assert.ok(toRepoPrRecord(rawPr({ number: 1 })));
});

test('reconcileRepoPrRecords never emits an AI detail row for a numberless PR', () => {
	// The uncacheable branch used to push a `number: -1` sentinel straight into aiDetails.
	const listed = [rawPr({ number: undefined, updated_at: 'nope', user: { login: 'Copilot', type: 'Bot' } })];
	const result = reconcileRepoPrRecords([], listed, { listingComplete: true });
	assert.deepEqual(result.listed, []);
	assert.deepEqual(summarizeRepoPrRecords(result.listed).aiDetails, []);
});

test('reconcileRepoPrRecords still counts a real PR whose timestamp is malformed', () => {
	const result = reconcileRepoPrRecords([], [rawPr({ number: 7, updated_at: 'nope' })], { listingComplete: true });
	assert.deepEqual(result.listed.map((r) => r.number), [7]);
	assert.deepEqual(toCacheableRepoPrRecords(result.records), []);
});

test('indexCachedPrRecords ignores malformed cached numbers', () => {
	const malformed = [
		{ ...toRepoPrRecord(rawPr({ number: 1 }))!, number: Number.NaN },
		{ ...toRepoPrRecord(rawPr({ number: 1 }))!, number: 0 },
	];
	// None of these can be matched by a listing, so none may be retained on an incomplete pass.
	const result = reconcileRepoPrRecords(malformed, [], { listingComplete: false });
	assert.deepEqual(result.records, []);
	assert.equal(result.retainedUnverified, 0);
});
