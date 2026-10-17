import test from 'node:test';
import * as assert from 'node:assert/strict';
import type * as http from 'node:http';
import { EventEmitter } from 'node:events';
import {
	agentTaskCacheKey,
	collectAgentSessions,
	detectSessionSource,
	fetchAgentSessionsForRepo,
	readSessionUsage,
	repositoryIdFromTask,
	requestGitHubJson,
	requestGitHubJsonTransport,
	resolveTaskRepo,
	toTaskDetailResult,
	toTaskPageResult,
	type AgentRepoSummary,
	type AgentTaskRecord,
	type FetchAccountTaskPageFn,
	type FetchRepositoryByIdFn,
	type FetchTaskPageFn,
	type FetchTaskDetailFn,
} from '../../src/agentSessionsService';

/**
 * Minimal stand-in for `http.ClientRequest`, exercising exactly the surface
 * `attachRequestFailureHandling` (see `src/githubApiConfig.ts`) touches. Lets a test drive the
 * real request-creation code path in `agentSessionsService.ts` end-to-end without a live network
 * call. `requestGitHubJsonTransport` accepts an injectable `requestFn` (defaulting to the real
 * `https.request`) for exactly this purpose — Node's built-in module exports are non-configurable
 * in current versions, so monkey-patching `https.request` directly is not viable here.
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
// detectSessionSource — pure function, no I/O
// ---------------------------------------------------------------------------

test('detectSessionSource: cloud-agent when model is non-empty', () => {
	assert.equal(detectSessionSource({ model: 'sweagent-capi:claude-sonnet-4' }), 'cloud-agent');
	assert.equal(detectSessionSource({ model: 'gpt-4o' }), 'cloud-agent');
});

test('detectSessionSource: cloud-agent when usage field is present (even with empty model)', () => {
	assert.equal(detectSessionSource({ model: '', usage: { credits: 10, type: 'ai-credits' } }), 'cloud-agent');
	assert.equal(detectSessionSource({ usage: { credits: 5 } }), 'cloud-agent');
});

test('detectSessionSource: cli-remote when model field is present but empty, no usage', () => {
	assert.equal(detectSessionSource({ model: '' }), 'cli-remote');
});

test('detectSessionSource: unknown when model field is entirely absent', () => {
	assert.equal(detectSessionSource({}), 'unknown');
	assert.equal(detectSessionSource({ usage: null }), 'unknown');
});

// ---------------------------------------------------------------------------
// fetchAgentSessionsForRepo — pagination, source filtering, credit aggregation
// ---------------------------------------------------------------------------

function makeTask(id: string): any {
	return { id, name: `Task ${id}`, state: 'completed', created_at: new Date().toISOString() };
}

/** GitHub's agents API reports usage.credits in nano-credits (1 credit = 1_000_000_000 nano-credits). */
const NANO_CREDITS_PER_CREDIT = 1_000_000_000;

function makeSession(model: string, credits?: number): any {
	const s: any = { id: `s-${Math.random()}`, state: 'completed', model, created_at: new Date().toISOString() };
	if (credits !== undefined) { s.usage = { credits: credits * NANO_CREDITS_PER_CREDIT, type: 'ai_credits' }; }
	return s;
}

const SINCE = new Date('2024-01-01T00:00:00Z');

test('requestGitHubJson: stops waiting when the transport never settles', async () => {
	const hangingTransport = async (): Promise<never> => new Promise(() => {});
	const result = await requestGitHubJson('/agents/tasks', 'token', hangingTransport, 5);
	assert.match(result.error ?? '', /GitHub API request \/agents\/tasks timed out/);
});

// ---------------------------------------------------------------------------
// requestGitHubJson (default transport) — end-to-end through the real
// `https.request` wiring, verifying it reports a genuine transport failure
// distinctly from a socket-inactivity timeout (PR #1919 follow-up item 1: the
// mislabelled GitHub request timeout).
// ---------------------------------------------------------------------------

test('requestGitHubJsonTransport: a genuine connection error is reported with its real code, not as a timeout', async () => {
	const req = new FakeClientRequest();
	const fakeRequestFn = (() => req) as unknown as typeof http.request;
	const promise = requestGitHubJsonTransport('/agents/tasks', 'token', fakeRequestFn);
	req.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
	const result = await promise;
	assert.match(result.error ?? '', /^Connection failed after \d+(\.\d+)?s \(ECONNRESET\): read ECONNRESET$/);
	assert.doesNotMatch(result.error ?? '', /timed out|inactivity/i);
});

test('requestGitHubJsonTransport: a socket-inactivity timeout is reported with the real elapsed time, not the configured limit', async () => {
	const req = new FakeClientRequest();
	const fakeRequestFn = (() => req) as unknown as typeof http.request;
	const promise = requestGitHubJsonTransport('/agents/tasks', 'token', fakeRequestFn);
	await new Promise((resolve) => setTimeout(resolve, 5));
	req.fireTimeout();
	const result = await promise;
	assert.match(result.error ?? '', /^No response for \d+(\.\d+)?s \(socket inactivity limit 15s\)$/);
});

test('fetchAgentSessionsForRepo: returns empty result when task list is empty', async () => {
	const fetchPage: FetchTaskPageFn = async () => ({ tasks: [] });
	const fetchDetail: FetchTaskDetailFn = async () => ({ sessions: [] });
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 0);
	assert.equal(result.totalSessions, 0);
	assert.equal(result.totalCredits, 0);
	assert.equal(result.tasksTotal, 0);
	assert.equal(result.partial, false);
	assert.equal(result.error, undefined);
});

test('fetchAgentSessionsForRepo: counts only cloud-agent sessions', async () => {
	const tasks = [makeTask('t1')];
	const fetchPage: FetchTaskPageFn = async ({ page }) =>
		page === 1 ? { tasks } : { tasks: [] };
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [
			makeSession('sweagent-capi:claude', 5),  // cloud-agent
			makeSession('', undefined),               // cli-remote (excluded)
			makeSession('gpt-4o', 3),                 // cloud-agent
		],
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 1);
	assert.equal(result.totalSessions, 2);   // only cloud-agent sessions
	assert.equal(result.totalCredits, 8);    // 5 + 3
	assert.equal(result.error, undefined);
});

test('fetchAgentSessionsForRepo: task with no cloud-agent sessions does not count toward totalTasks', async () => {
	const tasks = [makeTask('t1')];
	const fetchPage: FetchTaskPageFn = async ({ page }) =>
		page === 1 ? { tasks } : { tasks: [] };
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [makeSession('', undefined)],  // cli-remote only
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 0);
	assert.equal(result.totalSessions, 0);
});

test('fetchAgentSessionsForRepo: converts real-world nano-credit values to whole AI credits (issue #1554)', async () => {
	const tasks = [makeTask('t1')];
	const fetchPage: FetchTaskPageFn = async ({ page }) =>
		page === 1 ? { tasks } : { tasks: [] };
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [
			// Raw value as observed from the live GitHub agents API (nano-credits).
			{ id: 's1', state: 'completed', model: 'sweagent-capi:gpt-5.4', created_at: new Date().toISOString(), usage: { credits: 43380350000, type: 'ai_credits' } },
		],
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalSessions, 1);
	assert.ok(Math.abs(result.totalCredits - 43.38035) < 1e-9, `expected ~43.38 credits, got ${result.totalCredits}`);
});

test('fetchAgentSessionsForRepo: handles missing usage.credits gracefully', async () => {
	const tasks = [makeTask('t1')];
	const fetchPage: FetchTaskPageFn = async ({ page }) =>
		page === 1 ? { tasks } : { tasks: [] };
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [makeSession('cloud-model')],  // no usage field
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 1);
	assert.equal(result.totalSessions, 1);
	assert.equal(result.totalCredits, 0);
});

test('fetchAgentSessionsForRepo: returns error result when API returns 404', async () => {
	const fetchPage: FetchTaskPageFn = async () => ({ tasks: [], statusCode: 404, error: 'HTTP 404' });
	const fetchDetail: FetchTaskDetailFn = async () => ({ sessions: [] });
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 0);
	assert.ok(result.error?.includes('not enabled') || result.error?.includes('not accessible'));
});

test('fetchAgentSessionsForRepo: returns error result when API returns 403', async () => {
	const fetchPage: FetchTaskPageFn = async () => ({ tasks: [], statusCode: 403, error: 'HTTP 403' });
	const fetchDetail: FetchTaskDetailFn = async () => ({ sessions: [] });
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 0);
	assert.ok(result.error?.includes('Access denied') || result.error?.includes('token'));
});

test('fetchAgentSessionsForRepo: deduplicates tasks that appear in both active and archived lists', async () => {
	const task = makeTask('shared-id');
	let activePageCalled = false;
	const fetchPage: FetchTaskPageFn = async ({ page, archived }) => {
		if (!archived && page === 1) { activePageCalled = true; return { tasks: [task] }; }
		if (archived && page === 1) { return { tasks: [task] }; } // same task in archived
		return { tasks: [] };
	};
	let detailCallCount = 0;
	const fetchDetail: FetchTaskDetailFn = async () => {
		detailCallCount++;
		return { sessions: [makeSession('cloud-model', 2)] };
	};
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.ok(activePageCalled);
	assert.equal(detailCallCount, 1, 'duplicate task id should be fetched only once');
	assert.equal(result.totalTasks, 1);
	assert.equal(result.totalSessions, 1);
	assert.equal(result.totalCredits, 2);
});

test('fetchAgentSessionsForRepo: marks partial=true when tasksTotal > cap', async () => {
	// Create 51 tasks (one over the MAX_TASKS_DETAIL_PER_REPO cap of 50)
	const tasks = Array.from({ length: 51 }, (_, i) => makeTask(`t${i}`));
	const fetchPage: FetchTaskPageFn = async ({ page }) =>
		page === 1 ? { tasks } : { tasks: [] };
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [makeSession('cloud-model', 1)],
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.partial, true);
	assert.equal(result.tasksTotal, 51);
	assert.equal(result.tasksScanned, 50);
	assert.equal(result.totalSessions, 50); // only 50 task details fetched
});

test('fetchAgentSessionsForRepo: partial=false when tasksTotal <= cap', async () => {
	const tasks = [makeTask('t1'), makeTask('t2')];
	const fetchPage: FetchTaskPageFn = async ({ page }) =>
		page === 1 ? { tasks } : { tasks: [] };
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [makeSession('cloud-model', 1)],
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.partial, false);
	assert.equal(result.tasksScanned, 2);
});

test('fetchAgentSessionsForRepo: handles detail fetch failure gracefully (skips task)', async () => {
	const tasks = [makeTask('t1'), makeTask('t2')];
	const fetchPage: FetchTaskPageFn = async ({ page }) =>
		page === 1 ? { tasks } : { tasks: [] };
	let callNum = 0;
	const fetchDetail: FetchTaskDetailFn = async () => {
		callNum++;
		if (callNum === 1) { return { error: 'network error' }; }
		return { sessions: [makeSession('cloud-model', 3)] };
	};
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 1);   // only t2 succeeded
	assert.equal(result.totalSessions, 1);
	assert.equal(result.totalCredits, 3);
	assert.equal(result.error, undefined);
});

// ---------------------------------------------------------------------------
// readSessionUsage — both API spellings of the billing units
// ---------------------------------------------------------------------------

test('readSessionUsage: reads the documented usage.amount in nano-credits', () => {
	assert.deepEqual(
		readSessionUsage({ usage: { type: 'ai_credits', amount: 43380350000 } }),
		{ credits: 43.38035, premiumRequests: 0 },
	);
});

test('readSessionUsage: reads the usage.credits spelling the live API has returned', () => {
	assert.deepEqual(
		readSessionUsage({ usage: { type: 'ai_credits', credits: 2_000_000_000 } }),
		{ credits: 2, premiumRequests: 0 },
	);
});

test('readSessionUsage: premium requests are counted as-is, never scaled like nano-credits', () => {
	assert.deepEqual(
		readSessionUsage({ usage: { type: 'premium_requests', amount: 1.5 } }),
		{ credits: 0, premiumRequests: 1.5 },
	);
});

test('readSessionUsage: missing, empty or non-numeric usage yields zero', () => {
	assert.deepEqual(readSessionUsage({}), { credits: 0, premiumRequests: 0 });
	assert.deepEqual(readSessionUsage({ usage: null }), { credits: 0, premiumRequests: 0 });
	assert.deepEqual(readSessionUsage({ usage: { type: 'ai_credits' } }), { credits: 0, premiumRequests: 0 });
	assert.deepEqual(readSessionUsage({ usage: { amount: 'lots' } }), { credits: 0, premiumRequests: 0 });
});

test('fetchAgentSessionsForRepo: keeps premium-request sessions out of the credit total', async () => {
	const fetchPage: FetchTaskPageFn = async ({ page }) => (page === 1 ? { tasks: [makeTask('t1')] } : { tasks: [] });
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [{ id: 's1', model: 'sweagent-capi:gpt-5.4', usage: { type: 'premium_requests', amount: 1.5 } }],
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalCredits, 0);
	assert.equal(result.totalPremiumRequests, 1.5);
});

// ---------------------------------------------------------------------------
// resolveTaskRepo — the repository a task is attributed to
// ---------------------------------------------------------------------------

test('resolveTaskRepo: reads full_name, nwo, owner+name, and repository html_url', () => {
	assert.deepEqual(resolveTaskRepo({ repository: { full_name: 'octo/demo' } }), { owner: 'octo', repo: 'demo' });
	assert.deepEqual(resolveTaskRepo({ repository: { nwo: 'octo/demo' } }), { owner: 'octo', repo: 'demo' });
	assert.deepEqual(
		resolveTaskRepo({ repository: { name: 'demo', owner: { login: 'octo' } } }),
		{ owner: 'octo', repo: 'demo' },
	);
	assert.deepEqual(
		resolveTaskRepo({ repository: { id: 1, html_url: 'https://github.com/octo/demo' } }),
		{ owner: 'octo', repo: 'demo' },
	);
});

test('resolveTaskRepo: falls back to the task html_url, and ignores agents-page URLs', () => {
	assert.deepEqual(
		resolveTaskRepo({ html_url: 'https://github.com/octo/demo/pull/7' }),
		{ owner: 'octo', repo: 'demo' },
	);
	assert.equal(resolveTaskRepo({ html_url: 'https://github.com/copilot/agents/abc123' }), undefined);
});

test('resolveTaskRepo: returns undefined for a task with no resolvable repository', () => {
	assert.equal(resolveTaskRepo({ id: 't1' }), undefined);
	assert.equal(resolveTaskRepo({ repository: { id: 42 } }), undefined);
	assert.equal(resolveTaskRepo(undefined), undefined);
});

// ---------------------------------------------------------------------------
// repositoryIdFromTask — the bare numeric ID the account-wide listing guarantees
// ---------------------------------------------------------------------------

test('repositoryIdFromTask: reads a numeric repository.id', () => {
	assert.equal(repositoryIdFromTask({ repository: { id: 42 } }), 42);
});

test('repositoryIdFromTask: returns undefined when there is no usable ID', () => {
	assert.equal(repositoryIdFromTask({ repository: { full_name: 'octo/demo' } }), undefined);
	assert.equal(repositoryIdFromTask({ repository: { id: 'not-a-number' } }), undefined);
	assert.equal(repositoryIdFromTask({}), undefined);
	assert.equal(repositoryIdFromTask(undefined), undefined);
});

// ---------------------------------------------------------------------------
// collectAgentSessions — workspace repos merged with the account-wide task list
// ---------------------------------------------------------------------------

/** Task as returned by the account-wide listing, carrying its repository. */
function makeAccountTask(id: string, fullName?: string, updatedAt = '2026-08-01T00:00:00Z'): any {
	return {
		id,
		name: `Task ${id}`,
		state: 'completed',
		updated_at: updatedAt,
		created_at: updatedAt,
		...(fullName ? { repository: { full_name: fullName } } : {}),
	};
}

const NO_TASKS: FetchTaskPageFn = async () => ({ tasks: [] });
const NO_ACCOUNT_TASKS: FetchAccountTaskPageFn = async () => ({ tasks: [] });

function firstPageOnly(tasks: any[]): (page: number) => { tasks: any[] } {
	return (page: number) => (page === 1 ? { tasks } : { tasks: [] });
}

test('collectAgentSessions: finds account tasks in repos that are not open in the workspace', async () => {
	const accountPage = firstPageOnly([makeAccountTask('a1', 'octo/remote-repo')]);
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (archived ? { tasks: [] } : accountPage(page)),
		fetchTaskDetail: async () => ({ sessions: [makeSession('cloud-model', 4)] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});

	assert.equal(result.accountTasksAvailable, true);
	assert.equal(result.repos.length, 1);
	assert.equal(result.repos[0].owner, 'octo');
	assert.equal(result.repos[0].repo, 'remote-repo');
	assert.equal(result.repos[0].discovery, 'account');
	assert.equal(result.totalCredits, 4);
});

/** Task as the account-wide listing typically returns it: only a bare `repository.id`. */
function makeAccountTaskWithRepoId(id: string, repoId: number, updatedAt = '2026-08-01T00:00:00Z'): any {
	return {
		id, name: `Task ${id}`, state: 'completed', updated_at: updatedAt, created_at: updatedAt,
		repository: { id: repoId },
	};
}

test('collectAgentSessions: resolves a bare repository.id via GET /repositories/{id}', async () => {
	const accountPage = firstPageOnly([makeAccountTaskWithRepoId('a1', 555)]);
	const lookedUp: number[] = [];
	const fetchRepositoryById: FetchRepositoryByIdFn = async (id) => {
		lookedUp.push(id);
		return id === 555 ? { owner: 'octo', repo: 'byid' } : undefined;
	};
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (archived ? { tasks: [] } : accountPage(page)),
		fetchTaskDetail: async () => ({ sessions: [makeSession('cloud-model', 3)] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
		fetchRepositoryById,
	});

	assert.deepEqual(lookedUp, [555]);
	assert.equal(result.repos.length, 1);
	assert.equal(result.repos[0].owner, 'octo');
	assert.equal(result.repos[0].repo, 'byid');
	assert.ok(!result.repos[0].unassigned);
	assert.equal(result.repos[0].discovery, 'account');
	assert.equal(result.totalCredits, 3);
});

test('collectAgentSessions: dedups repository-ID lookups across tasks sharing the same repo', async () => {
	const accountPage = firstPageOnly([
		makeAccountTaskWithRepoId('a1', 777, '2026-08-01T00:00:00Z'),
		makeAccountTaskWithRepoId('a2', 777, '2026-08-02T00:00:00Z'),
	]);
	let lookups = 0;
	const fetchRepositoryById: FetchRepositoryByIdFn = async () => { lookups++; return { owner: 'octo', repo: 'shared-by-id' }; };
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (archived ? { tasks: [] } : accountPage(page)),
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
		fetchRepositoryById,
	});

	assert.equal(lookups, 1, 'one lookup per distinct repository ID, not per task');
	assert.equal(result.repos.length, 1);
	assert.equal(result.repos[0].tasksTotal, 2);
});

test('collectAgentSessions: a task whose repository-ID lookup fails still lands in the "no repository" bucket', async () => {
	const accountPage = firstPageOnly([makeAccountTaskWithRepoId('a1', 999)]);
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (archived ? { tasks: [] } : accountPage(page)),
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
		fetchRepositoryById: async () => undefined,
	});

	assert.equal(result.repos.length, 1);
	assert.equal(result.repos[0].unassigned, true);
});

test('collectAgentSessions: repository-ID lookups are capped, leaving the rest in the "no repository" bucket', async () => {
	const tasks = [
		makeAccountTaskWithRepoId('a1', 1),
		makeAccountTaskWithRepoId('a2', 2),
		makeAccountTaskWithRepoId('a3', 3),
	];
	const accountPage = firstPageOnly(tasks);
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		maxRepoIdLookups: 2,
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (archived ? { tasks: [] } : accountPage(page)),
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
		fetchRepositoryById: async (id) => ({ owner: 'octo', repo: `repo-${id}` }),
	});

	const resolvedRepos = result.repos.filter(r => !r.unassigned);
	assert.equal(resolvedRepos.length, 2, 'only the first two distinct IDs are looked up');
	assert.ok(result.repos.some(r => r.unassigned), 'the ID left over falls back to the unassigned bucket');
});

test('collectAgentSessions: a task in both listings is detailed once and marked as seen from both', async () => {
	const shared = makeAccountTask('shared', 'octo/demo');
	let detailCalls = 0;
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'demo' }],
		fetchTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [shared] } : { tasks: [] }),
		fetchAccountTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [shared] } : { tasks: [] }),
		fetchTaskDetail: async () => { detailCalls++; return { sessions: [makeSession('cloud-model', 7)] }; },
		fetchAccountTaskDetail: async () => { detailCalls++; return { sessions: [] }; },
	});

	assert.equal(detailCalls, 1, 'the same task must not be detailed twice');
	assert.equal(result.repos.length, 1);
	assert.equal(result.repos[0].discovery, 'both');
	assert.equal(result.repos[0].tasksTotal, 1);
	assert.equal(result.totalCredits, 7);
	assert.equal(result.totalTasks, 1);
});

test('collectAgentSessions: a shared task whose account-listing repo-ID lookup fails does not spawn a spurious "no repository" row', async () => {
	// Same task ID appears in both listings: the workspace listing resolves it via `owner`/`repo`
	// filters, but the account-wide object only carries a bare repository ID whose lookup fails.
	const workspaceTask = makeAccountTask('shared', undefined, '2026-08-01T00:00:00Z');
	const accountTask = makeAccountTaskWithRepoId('shared', 4242, '2026-08-01T00:00:00Z');
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'demo' }],
		fetchTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [workspaceTask] } : { tasks: [] }),
		fetchAccountTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [accountTask] } : { tasks: [] }),
		fetchTaskDetail: async () => ({ sessions: [makeSession('cloud-model', 6)] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
		fetchRepositoryById: async () => undefined,
	});

	assert.equal(result.repos.length, 1, 'the failed account-side lookup must not create a second, unassigned row');
	assert.equal(result.repos[0].owner, 'octo');
	assert.equal(result.repos[0].repo, 'demo');
	assert.equal(result.repos[0].discovery, 'both');
	assert.equal(result.repos[0].tasksTotal, 1);
});

test('collectAgentSessions: tasks with no repository land in their own bucket, detailed by ID', async () => {
	let byIdCalls = 0;
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) =>
			(!archived && page === 1 ? { tasks: [makeAccountTask('chat-1')] } : { tasks: [] }),
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => { byIdCalls++; return { sessions: [makeSession('cloud-model', 1.5)] }; },
	});

	assert.equal(byIdCalls, 1, 'a task with no repo must be fetched through the account-wide detail endpoint');
	assert.equal(result.repos.length, 1);
	assert.equal(result.repos[0].unassigned, true);
	assert.equal(result.repos[0].owner, '');
	assert.equal(result.totalCredits, 1.5);
});

test('collectAgentSessions: workspace repos are listed even when they have no tasks', async () => {
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'quiet' }],
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: NO_ACCOUNT_TASKS,
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});

	assert.equal(result.repos.length, 1);
	assert.equal(result.repos[0].discovery, 'workspace');
	assert.equal(result.repos[0].tasksTotal, 0);
	assert.equal(result.repos[0].partial, false);
	assert.equal(result.partial, false);
});

test('collectAgentSessions: a failing account listing degrades to the workspace repos', async () => {
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'demo' }],
		fetchTaskPage: async ({ page, archived }) =>
			(!archived && page === 1 ? { tasks: [makeTask('t1')] } : { tasks: [] }),
		fetchAccountTaskPage: async () => ({ tasks: [], statusCode: 403, error: 'HTTP 403' }),
		fetchTaskDetail: async () => ({ sessions: [makeSession('cloud-model', 2)] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});

	assert.equal(result.accountTasksAvailable, false);
	assert.ok(result.accountTasksError?.includes('Access denied'));
	assert.equal(result.repos.length, 1);
	assert.equal(result.totalCredits, 2);
});

test('collectAgentSessions: a failing repo listing shows an error row without failing the pass', async () => {
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'denied' }],
		fetchTaskPage: async () => ({ tasks: [], statusCode: 404, error: 'HTTP 404' }),
		fetchAccountTaskPage: async ({ page, archived }) =>
			(!archived && page === 1 ? { tasks: [makeAccountTask('a1', 'octo/other')] } : { tasks: [] }),
		fetchTaskDetail: async () => ({ sessions: [makeSession('cloud-model', 1)] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});

	const denied = result.repos.find(r => r.repo === 'denied');
	assert.ok(denied?.error?.includes('not enabled') || denied?.error?.includes('not accessible'));
	assert.ok(result.repos.some(r => r.repo === 'other'));
});

test('collectAgentSessions: the detail budget covers the newest tasks and flags the rest as partial', async () => {
	const tasks = [
		makeAccountTask('old', 'octo/demo', '2026-08-01T00:00:00Z'),
		makeAccountTask('new', 'octo/demo', '2026-08-20T00:00:00Z'),
	];
	const detailed: string[] = [];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		maxTaskDetails: 1,
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks } : { tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => {
			detailed.push(taskId);
			return { sessions: [makeSession('cloud-model', 1)] };
		},
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});

	assert.deepEqual(detailed, ['new'], 'the most recently updated task is detailed first');
	assert.equal(result.partial, true);
	assert.equal(result.repos[0].partial, true);
	assert.equal(result.repos[0].tasksTotal, 2);
	assert.equal(result.repos[0].tasksScanned, 1);
});

test('collectAgentSessions: reports progress that never exceeds its own total', async () => {
	const progress: { done: number; total: number }[] = [];
	await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'demo' }],
		fetchTaskPage: async ({ page, archived }) =>
			(!archived && page === 1 ? { tasks: [makeTask('t1')] } : { tasks: [] }),
		fetchAccountTaskPage: NO_ACCOUNT_TASKS,
		fetchTaskDetail: async () => ({ sessions: [makeSession('cloud-model', 1)] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
		onProgress: (done, total) => progress.push({ done, total }),
	});

	assert.ok(progress.length >= 3, 'one unit per repo listing, the account listing, and each detail call');
	assert.ok(progress.every(p => p.done <= p.total), 'progress must never report more done than total');
	const last = progress[progress.length - 1];
	assert.equal(last.done, last.total);
});

// ---------------------------------------------------------------------------
// collectAgentSessions — per-task cache reuse (issue #1968)
// ---------------------------------------------------------------------------

/** The cache record a previous pass would have written for `makeAccountTask(id, fullName, at)`. */
function cachedRecordFor(
	id: string, repoKey: string, updatedAt: string, overrides: Partial<AgentTaskRecord> = {},
): AgentTaskRecord {
	const [owner, repo] = repoKey ? repoKey.split('/') : [undefined, undefined];
	return {
		key: agentTaskCacheKey(repoKey, id),
		id,
		repoKey,
		owner,
		repo,
		discovery: 'account',
		updatedAt: new Date(Date.parse(updatedAt)).toISOString(),
		aggregate: { tasks: 1, sessions: 1, credits: 7, premiumRequests: 0 },
		detailOk: true,
		detailAttempts: 0,
		lastSeenAt: '2026-08-29T12:00:00.000Z',
		...overrides,
	};
}

/** Run one account-only collection over `tasks`, recording which tasks cost a detail call. */
async function collectWithCache(
	tasks: any[],
	cachedTasks: AgentTaskRecord[],
	options: { sessions?: any[]; detailFails?: boolean; maxTaskDetails?: number } = {},
): Promise<{ result: Awaited<ReturnType<typeof collectAgentSessions>>; detailed: string[] }> {
	const detailed: string[] = [];
	const accountPage = firstPageOnly(tasks);
	const detail = async (...args: any[]): Promise<any> => {
		detailed.push(String(args[args.length - 2]));
		if (options.detailFails) { return { error: 'HTTP 500', statusCode: 500 }; }
		return { sessions: options.sessions ?? [makeSession('cloud-model', 4)] };
	};
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		cachedTasks,
		maxTaskDetails: options.maxTaskDetails,
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (archived ? { tasks: [] } : accountPage(page)),
		fetchTaskDetail: async (owner, repo, taskId) => detail(owner, repo, taskId, 'token'),
		fetchAccountTaskDetail: async (taskId) => detail(taskId, 'token'),
	});
	return { result, detailed };
}

test('collectAgentSessions: an unchanged task is served from the cache with no detail call', async () => {
	const task = makeAccountTask('a1', 'octo/remote-repo', '2026-08-01T00:00:00Z');
	const cached = [cachedRecordFor('a1', 'octo/remote-repo', '2026-08-01T00:00:00Z')];
	const { result, detailed } = await collectWithCache([task], cached);

	assert.deepEqual(detailed, [], 'an unchanged task must cost no API call');
	assert.equal(result.totalCredits, 7, 'the cached aggregate is what gets folded in');
	assert.equal(result.repos[0].tasksScanned, 1, 'a cache hit still counts as scanned');
	assert.equal(result.repos[0].partial, false);
	assert.equal(result.taskRecords.length, 1);
	assert.equal(result.taskRecords[0].detailOk, true);
});

test('collectAgentSessions: a task whose updated_at moved is refetched', async () => {
	const task = makeAccountTask('a1', 'octo/remote-repo', '2026-08-02T00:00:00Z');
	const cached = [cachedRecordFor('a1', 'octo/remote-repo', '2026-08-01T00:00:00Z')];
	const { result, detailed } = await collectWithCache([task], cached);

	assert.deepEqual(detailed, ['a1'], 'a changed task must be refetched');
	assert.equal(result.totalCredits, 4, 'the fresh detail wins, not the stale aggregate');
	assert.equal(result.taskRecords[0].updatedAt, '2026-08-02T00:00:00.000Z');
});

test('collectAgentSessions: a cached record never satisfies a task in another repository', async () => {
	const task = makeAccountTask('a1', 'octo/moved-repo', '2026-08-01T00:00:00Z');
	const cached = [cachedRecordFor('a1', 'octo/remote-repo', '2026-08-01T00:00:00Z')];
	const { result, detailed } = await collectWithCache([task], cached);

	assert.deepEqual(detailed, ['a1'], 'a moved task must not reuse its old repo-scoped aggregate');
	assert.equal(result.repos[0].repo, 'moved-repo');
	assert.equal(result.totalCredits, 4);
});

test('collectAgentSessions: a task with no usable updated_at is never cached and always refetched', async () => {
	const task = { id: 'a1', name: 'Task a1', state: 'completed', repository: { full_name: 'octo/remote-repo' } };
	const first = await collectWithCache([task], []);
	assert.deepEqual(first.detailed, ['a1']);
	assert.deepEqual(first.result.taskRecords, [], 'an unstamped task is uncacheable');

	const second = await collectWithCache([task], first.result.taskRecords);
	assert.deepEqual(second.detailed, ['a1'], 'and so it is refetched on every pass');
});

test('collectAgentSessions: a previously failed detail is retried and its attempt count grows', async () => {
	const task = makeAccountTask('a1', 'octo/remote-repo', '2026-08-01T00:00:00Z');
	const failed = await collectWithCache([task], [], { detailFails: true });
	assert.deepEqual(failed.detailed, ['a1']);
	assert.equal(failed.result.taskRecords[0].detailOk, false);
	assert.equal(failed.result.taskRecords[0].aggregate, undefined, 'a failure must not be remembered as zero usage');
	assert.equal(failed.result.taskRecords[0].detailAttempts, 1);
	assert.equal(failed.result.totalCredits, 0);

	const retried = await collectWithCache([task], failed.result.taskRecords, { detailFails: true });
	assert.deepEqual(retried.detailed, ['a1'], 'a task still owing its detail must be retried');
	assert.equal(retried.result.taskRecords[0].detailAttempts, 2);

	const recovered = await collectWithCache([task], retried.result.taskRecords);
	assert.equal(recovered.result.taskRecords[0].detailOk, true);
	assert.equal(recovered.result.taskRecords[0].detailAttempts, 0);
	assert.equal(recovered.result.totalCredits, 4);
});

test('collectAgentSessions: the detail budget is spent on invalidated tasks, newest first', async () => {
	const tasks = [
		makeAccountTask('old', 'octo/remote-repo', '2026-08-01T00:00:00Z'),
		makeAccountTask('new', 'octo/remote-repo', '2026-08-05T00:00:00Z'),
		makeAccountTask('cached', 'octo/remote-repo', '2026-08-03T00:00:00Z'),
	];
	const cached = [cachedRecordFor('cached', 'octo/remote-repo', '2026-08-03T00:00:00Z')];
	const { result, detailed } = await collectWithCache(tasks, cached, { maxTaskDetails: 1 });

	assert.deepEqual(detailed, ['new'], 'the budget goes to the most recent task that actually changed');
	assert.equal(result.partial, true, 'one task was left undetailed, so totals are a lower bound');
	assert.equal(result.repos[0].tasksTotal, 3);
	assert.equal(result.repos[0].tasksScanned, 2, 'the cache hit plus the one fresh detail');
	assert.equal(result.totalCredits, 11, 'cached 7 + fresh 4');
});

test('collectAgentSessions: a complete account listing is reported as such', async () => {
	const { result } = await collectWithCache([makeAccountTask('a1', 'octo/remote-repo')], []);
	assert.equal(result.listingComplete, true);
	assert.equal(result.partial, false);
});

test('collectAgentSessions: a failed account listing is incomplete and marked partial', async () => {
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async () => ({ tasks: [], statusCode: 500, error: 'boom' }),
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});
	assert.equal(result.accountTasksAvailable, false);
	assert.equal(result.listingComplete, false);
	assert.equal(result.partial, true, 'an incomplete listing must show as a lower bound');
});

test('collectAgentSessions: a capped task listing is reported as incomplete', async () => {
	// Five full pages of 100 tasks each means the page cap was hit — absence proves nothing.
	const fullPage = (page: number) => ({
		tasks: Array.from({ length: 100 }, (_, i) => makeAccountTask(`p${page}-${i}`, 'octo/remote-repo')),
	});
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [],
		maxTaskDetails: 0,
		fetchTaskPage: NO_TASKS,
		fetchAccountTaskPage: async ({ page, archived }) => (archived ? { tasks: [] } : fullPage(page)),
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});
	assert.equal(result.listingComplete, false);
	assert.equal(result.partial, true);
});

test('collectAgentSessions: a failed workspace listing makes the pass incomplete', async () => {
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'local-repo' }],
		fetchTaskPage: async () => ({ tasks: [], statusCode: 403, error: 'denied' }),
		fetchAccountTaskPage: NO_ACCOUNT_TASKS,
		fetchTaskDetail: async () => ({ sessions: [] }),
		fetchAccountTaskDetail: async () => ({ sessions: [] }),
	});
	assert.equal(result.listingComplete, false);
	assert.equal(result.partial, true);
	assert.ok(result.repos[0].error);
});

test('collectAgentSessions: task records never carry prompts, titles or transcripts', async () => {
	const task = {
		...makeAccountTask('a1', 'octo/remote-repo'),
		name: 'Fix the secret login bug',
		problem_statement: 'the prompt text that must not be cached',
	};
	const { result } = await collectWithCache([task], []);
	const serialized = JSON.stringify(result.taskRecords);
	assert.ok(!serialized.includes('prompt text'), serialized);
	assert.ok(!serialized.includes('Fix the secret login bug'), serialized);
});

test('collectAgentSessions: a task the budget never reached keeps its retry history', async () => {
	const task = makeAccountTask('a1', 'octo/remote-repo', '2026-08-01T00:00:00Z');
	const failed = await collectWithCache([task], [], { detailFails: true });
	assert.equal(failed.result.taskRecords[0].detailAttempts, 1);

	// Budget of zero: the task is listed but never attempted this pass. Its previous failure must
	// still be on the record, or a permanently broken task would look brand new forever.
	const capped = await collectWithCache([task], failed.result.taskRecords, { maxTaskDetails: 0 });
	assert.deepEqual(capped.detailed, []);
	assert.equal(capped.result.taskRecords[0].detailAttempts, 1);
	assert.equal(capped.result.taskRecords[0].detailOk, false);
	assert.equal(capped.result.partial, true);
});

// --- Review follow-ups (PR #2073) -------------------------------------------

test('collectAgentSessions: a failed detail marks its row and the result partial', () => {
	// Otherwise the only outstanding task failing would still report `partial: false`, presenting an
	// under-counted total as complete.
	return collectWithCache([makeAccountTask('a1', 'octo/remote-repo')], [], { detailFails: true })
		.then(({ result }) => {
			assert.equal(result.partial, true, 'a failed detail leaves the totals short');
			assert.equal(result.repos[0].partial, true, 'and the row says so too');
			assert.equal(result.totalCredits, 0);
		});
});

test('collectAgentSessions: a fully successful pass is not marked partial', () => {
	return collectWithCache([makeAccountTask('a1', 'octo/remote-repo')], [])
		.then(({ result }) => {
			assert.equal(result.partial, false);
			assert.equal(result.repos[0].partial, false);
		});
});

test('collectAgentSessions: an unparseable updated_at falls back to created_at for priority', async () => {
	// A task with a broken timestamp is uncacheable, so it always needs a detail call — losing its
	// newest-first priority and being dropped by the budget is the worst outcome for it.
	const broken = { id: 'broken', name: 'Task broken', state: 'completed', updated_at: 'not-a-date', created_at: '2026-08-20T00:00:00Z', repository: { full_name: 'octo/remote-repo' } };
	const older = makeAccountTask('older', 'octo/remote-repo', '2026-08-01T00:00:00Z');
	const { detailed } = await collectWithCache([older, broken], [], { maxTaskDetails: 1 });
	assert.deepEqual(detailed, ['broken'], 'the recently created task wins the budget');
});

test('toTaskPageResult: a body with no tasks array is an error, not an empty page', () => {
	// A 200 whose body carries no task array must not look like "this repo has no tasks". The
	// short-page check would call the listing complete and reconciliation — which may delete only
	// after a full enumeration — would drop every cached task and publish a confident zero.
	for (const body of [{ unexpected: true }, {}, null, 'nonsense', 42]) {
		const page = toTaskPageResult({ body, statusCode: 200 });
		assert.equal(page.error, 'Unexpected response format', `${JSON.stringify(body)} must be an error`);
		assert.deepEqual(page.tasks, []);
	}
});

test('toTaskPageResult: an explicitly empty listing is still authoritative', () => {
	// The guard above has to distinguish "no tasks" from "no task array" — `{ tasks: [] }` and a
	// bare `[]` are real answers, and erroring on them would stop reconciliation ever converging.
	for (const body of [{ tasks: [] }, []]) {
		const page = toTaskPageResult({ body, statusCode: 200 });
		assert.equal(page.error, undefined, `${JSON.stringify(body)} is a valid empty listing`);
		assert.deepEqual(page.tasks, []);
	}
	assert.deepEqual(toTaskPageResult({ body: { tasks: [{ id: 't1' }] }, statusCode: 200 }).tasks, [{ id: 't1' }]);
});

test('toTaskDetailResult: a body with no sessions array is an error, never zero usage', () => {
	// The caller caches a successful detail as this task's aggregate, so a malformed response read
	// as zero sessions would remember a failure as zero usage — and reuse it for as long as the
	// task's updated_at holds still.
	for (const body of [{ unexpected: true }, {}, null]) {
		const detail = toTaskDetailResult({ body, statusCode: 200 });
		assert.equal(detail.error, 'Unexpected response format', `${JSON.stringify(body)} must be an error`);
		assert.equal(detail.sessions, undefined);
	}
	// A task genuinely without cloud sessions says so, and that *is* a real zero.
	const empty = toTaskDetailResult({ body: { sessions: [] }, statusCode: 200 });
	assert.equal(empty.error, undefined);
	assert.deepEqual(empty.sessions, []);
});

test('collectAgentSessions: a task timestamped differently in the active and archived slices is uncacheable', async () => {
	// A task archived between the two requests comes back from both listings with different
	// timestamps. Keeping the first object is right — it must not be counted twice — but reusing an
	// aggregate matching that value would ignore the other listing having reported it changed.
	const task = (updatedAt: string) => ({
		id: 't1', name: 'Task t1', state: 'completed',
		updated_at: updatedAt, created_at: '2026-08-01T00:00:00Z',
		repository: { full_name: 'octo/local-repo' },
	});
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/local-repo', '2026-08-01T00:00:00Z')];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'local-repo' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ page, archived }) => (
			page === 1 ? { tasks: [task(archived ? '2026-08-02T00:00:00Z' : '2026-08-01T00:00:00Z')] } : { tasks: [] }
		),
		fetchAccountTaskPage: async () => ({ tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, ['t1'], 'the conflicting timestamp forces a fresh detail fetch');
	assert.equal(result.totalTasks, 1, 'and the task is still counted exactly once');
	assert.equal(result.totalCredits, 4);
});

test('collectAgentSessions: the same task in both slices with one timestamp still hits the cache', async () => {
	// An unchanged task legitimately appears in both slices. Treating that as a conflict would cost
	// a detail call for every task that happens to be listed twice.
	const task = () => ({
		id: 't1', name: 'Task t1', state: 'completed',
		updated_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z',
		repository: { full_name: 'octo/local-repo' },
	});
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/local-repo', '2026-08-01T00:00:00Z')];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'local-repo' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ page }) => (page === 1 ? { tasks: [task()] } : { tasks: [] }),
		fetchAccountTaskPage: async () => ({ tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, []);
	assert.equal(result.totalCredits, 7);
});

test('collectAgentSessions: an account slice conflict invalidates a task the workspace already claimed', async () => {
	// The conflicting set was only consulted when *creating* a candidate. A task the workspace
	// listing already claimed reached contestCandidate with no repo disagreement, and when the
	// account timestamp it happened to compare against matched, the conflict was lost — so the
	// cached aggregate was reused even though the other account slice reported a change.
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/local-repo', '2026-08-01T00:00:00Z')];
	const base = { id: 't1', name: 'Task t1', state: 'completed', created_at: '2026-08-01T00:00:00Z', repository: { full_name: 'octo/local-repo' } };
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'local-repo' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [{ ...base, updated_at: '2026-08-01T00:00:00Z' }] } : { tasks: [] }),
		// The account listing agrees on the active slice but its archived slice does not: the task
		// was archived between the two requests.
		fetchAccountTaskPage: async ({ page, archived }) => (
			page === 1 ? { tasks: [{ ...base, updated_at: archived ? '2026-08-02T00:00:00Z' : '2026-08-01T00:00:00Z' }] } : { tasks: [] }
		),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, ['t1'], 'the conflict must reach the existing candidate, not only a new one');
	assert.equal(result.totalCredits, 4, 'the fresh detail is what counts, not the stale 7 credits');
});

test('collectAgentSessions: two workspace repos listing the same task make it uncacheable', async () => {
	// Deduplicating by task ID is what stops one task being counted twice, but it silently threw
	// away the second repo's attribution and timestamp. Whichever of the two is stale, its cached
	// aggregate must not be folded in without a fresh detail call — the same rule already applied
	// to a workspace-vs-account disagreement.
	const task = (repoFullName: string) => ({
		id: 't1', name: 'Task t1', state: 'completed',
		updated_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z',
		repository: { full_name: repoFullName },
	});
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/repo-a', '2026-08-01T00:00:00Z')];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'repo-a' }, { owner: 'octo', repo: 'repo-b' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ repo, page, archived }) => (
			!archived && page === 1 ? { tasks: [task(`octo/${repo}`)] } : { tasks: [] }
		),
		fetchAccountTaskPage: async () => ({ tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, ['t1'], 'the contested task must be refetched, not served from cache');
	assert.equal(result.totalCredits, 4, 'the fresh detail is what counts, not the stale 7 credits');
});

test('collectAgentSessions: one repo listing a task twice is not a disagreement', async () => {
	// The same repo returning a task on two pages (or in both the active and archived slices) must
	// not trip the guard above, or a perfectly ordinary duplicate would cost a detail call.
	const task = () => ({
		id: 't1', name: 'Task t1', state: 'completed',
		updated_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z',
		repository: { full_name: 'octo/repo-a' },
	});
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/repo-a', '2026-08-01T00:00:00Z')];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'repo-a' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ page }) => (page === 1 ? { tasks: [task()] } : { tasks: [] }),
		fetchAccountTaskPage: async () => ({ tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, [], 'the cached aggregate is still valid');
	assert.equal(result.totalCredits, 7);
});

test('collectAgentSessions: a task the two listings timestamp differently is refetched, not reused', async () => {
	// The two listings are fetched moments apart, so a task updated in between reports two
	// different `updated_at` values. The repo-scoped one keeps the row, but reusing its cached
	// aggregate would break the contract this cache rests on — the account listing has already
	// said the task changed, so the cached state is superseded.
	const task = (updatedAt: string) => ({
		id: 't1', name: 'Task t1', state: 'completed',
		updated_at: updatedAt, created_at: '2026-08-01T00:00:00Z',
		repository: { full_name: 'octo/local-repo' },
	});
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/local-repo', '2026-08-01T00:00:00Z')];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'local-repo' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [task('2026-08-01T00:00:00Z')] } : { tasks: [] }),
		fetchAccountTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [task('2026-08-02T00:00:00Z')] } : { tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, ['t1'], 'a contested timestamp must force a fresh detail fetch');
	assert.equal(result.totalCredits, 4, 'the fresh detail is what counts, not the stale 7 credits');
});

test('collectAgentSessions: a task both listings agree on completely is still served from cache', async () => {
	// The guard above must not fire on agreement, or every task seen by both listings would be
	// refetched and the cache would save nothing on exactly the tasks it sees twice.
	const task = () => ({
		id: 't1', name: 'Task t1', state: 'completed',
		updated_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z',
		repository: { full_name: 'octo/local-repo' },
	});
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/local-repo', '2026-08-01T00:00:00Z')];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'local-repo' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [task()] } : { tasks: [] }),
		fetchAccountTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [task()] } : { tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, [], 'no detail call — the cached aggregate is still valid');
	assert.equal(result.totalCredits, 7, 'the cached 7 credits are reused');
});

test('collectAgentSessions: a task both listings disagree about is refetched, not reused', async () => {
	// The repo-scoped listing puts the task in `local-repo`; the account listing resolves it to
	// `moved-repo`. The cached aggregate under the contested key can no longer be trusted to
	// describe current usage, so it must not be folded into either row.
	const task = (repoFullName: string) => ({
		id: 't1', name: 'Task t1', state: 'completed',
		updated_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z',
		repository: { full_name: repoFullName },
	});
	const detailed: string[] = [];
	const cached = [cachedRecordFor('t1', 'octo/local-repo', '2026-08-01T00:00:00Z')];
	const result = await collectAgentSessions({
		token: 'token',
		since: SINCE,
		workspaceRepos: [{ owner: 'octo', repo: 'local-repo' }],
		cachedTasks: cached,
		fetchTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [task('octo/local-repo')] } : { tasks: [] }),
		fetchAccountTaskPage: async ({ page, archived }) => (!archived && page === 1 ? { tasks: [task('octo/moved-repo')] } : { tasks: [] }),
		fetchTaskDetail: async (_owner, _repo, taskId) => { detailed.push(taskId); return { sessions: [makeSession('cloud-model', 4)] }; },
		fetchAccountTaskDetail: async (taskId) => { detailed.push(taskId); return { sessions: [] }; },
	});
	assert.deepEqual(detailed, ['t1'], 'the contested task must be refetched, not served from cache');
	assert.equal(result.totalCredits, 4, 'the fresh detail is what counts, not the stale 7 credits');
	// An uncacheable candidate is never persisted, so the contested aggregate cannot be reused later.
	assert.deepEqual(result.taskRecords, []);
});
