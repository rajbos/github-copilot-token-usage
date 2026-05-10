import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
	detectSessionSource,
	fetchAgentSessionsForRepo,
	type AgentRepoSummary,
	type FetchTaskPageFn,
	type FetchTaskDetailFn,
} from '../../src/agentSessionsService';

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

function makeSession(model: string, credits?: number): any {
	const s: any = { id: `s-${Math.random()}`, state: 'completed', model, created_at: new Date().toISOString() };
	if (credits !== undefined) { s.usage = { credits, type: 'ai-credits' }; }
	return s;
}

const SINCE = new Date('2024-01-01T00:00:00Z');

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
	const fetchPage: FetchTaskPageFn = async (_o, _r, _t, page) =>
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
	const fetchPage: FetchTaskPageFn = async (_o, _r, _t, page) =>
		page === 1 ? { tasks } : { tasks: [] };
	const fetchDetail: FetchTaskDetailFn = async () => ({
		sessions: [makeSession('', undefined)],  // cli-remote only
	});
	const result = await fetchAgentSessionsForRepo('owner', 'repo', 'token', SINCE, fetchPage, fetchDetail);
	assert.equal(result.totalTasks, 0);
	assert.equal(result.totalSessions, 0);
});

test('fetchAgentSessionsForRepo: handles missing usage.credits gracefully', async () => {
	const tasks = [makeTask('t1')];
	const fetchPage: FetchTaskPageFn = async (_o, _r, _t, page) =>
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
	const fetchPage: FetchTaskPageFn = async (_o, _r, _t, page, archived) => {
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
	const fetchPage: FetchTaskPageFn = async (_o, _r, _t, page) =>
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
	const fetchPage: FetchTaskPageFn = async (_o, _r, _t, page) =>
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
	const fetchPage: FetchTaskPageFn = async (_o, _r, _t, page) =>
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
