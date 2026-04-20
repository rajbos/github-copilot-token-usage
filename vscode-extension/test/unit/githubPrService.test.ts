import test from 'node:test';
import * as assert from 'node:assert/strict';
import { detectAiType, fetchRepoPrs } from '../../src/githubPrService';

// ---------------------------------------------------------------------------
// detectAiType — pure function, no I/O
// ---------------------------------------------------------------------------

test('detectAiType: returns copilot for login containing "copilot"', () => {
	assert.equal(detectAiType('copilot-swe-agent'), 'copilot');
	assert.equal(detectAiType('github-copilot-bot'), 'copilot');
	assert.equal(detectAiType('COPILOT-agent'), 'copilot');
});

test('detectAiType: returns claude for login containing "claude" or "anthropic"', () => {
	assert.equal(detectAiType('claude-code-action'), 'claude');
	assert.equal(detectAiType('anthropic-bot'), 'claude');
	assert.equal(detectAiType('Claude-Agent'), 'claude');
});

test('detectAiType: returns openai for login containing "openai" or "codex"', () => {
	assert.equal(detectAiType('openai-code-agent'), 'openai');
	assert.equal(detectAiType('codex-bot'), 'openai');
	assert.equal(detectAiType('OPENAI-agent'), 'openai');
});

test('detectAiType: returns null for a regular human login', () => {
	assert.equal(detectAiType('octocat'), null);
	assert.equal(detectAiType('jane-doe'), null);
	assert.equal(detectAiType(''), null);
});

test('detectAiType: copilot match takes priority over other patterns', () => {
	// A login that technically contains both; copilot check comes first
	assert.equal(detectAiType('copilot-openai-test'), 'copilot');
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
