import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	AGENT_TASKS_CACHE_SCHEMA_VERSION,
	AGENT_TASKS_REFRESH_INTERVAL_MS,
	canServeAgentTasksSnapshot,
	getAgentTasksCachePath,
	isAgentTasksEnvelopeUsable,
	isAgentTasksSnapshotFresh,
	nextAgentTasksRefreshAt,
	readAgentTaskRecords,
	readAgentTasksSnapshot,
	reconcileAgentTaskRecords,
	writeAgentTasksSnapshot,
	type AgentTasksCacheEnvelope,
} from '../../src/agentTasksCache';
import { agentTaskCacheKey, type AgentTaskRecord } from '../../src/agentSessionsService';
import type { AgentSessionsResult } from '../../../src/types';

const NOW = Date.parse('2026-08-29T12:00:00Z');
const SINCE = new Date('2026-07-30T12:00:00Z');

function makeResult(overrides: Partial<AgentSessionsResult> = {}): AgentSessionsResult {
	return {
		repos: [],
		totalTasks: 0,
		totalSessions: 0,
		totalCredits: 0,
		totalPremiumRequests: 0,
		authenticated: true,
		since: SINCE.toISOString(),
		fetchedAt: new Date(NOW).toISOString(),
		accountTasksAvailable: true,
		partial: false,
		...overrides,
	};
}

function makeEnvelope(overrides: Partial<AgentTasksCacheEnvelope> = {}): AgentTasksCacheEnvelope {
	return {
		schemaVersion: AGENT_TASKS_CACHE_SCHEMA_VERSION,
		fetchedAt: new Date(NOW).toISOString(),
		since: SINCE.toISOString(),
		data: makeResult(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('isAgentTasksSnapshotFresh: a snapshot younger than the interval is fresh', () => {
	const fetchedAt = new Date(NOW - 59 * 60 * 1000).toISOString();
	assert.equal(isAgentTasksSnapshotFresh(fetchedAt, NOW), true);
});

test('isAgentTasksSnapshotFresh: a snapshot at or past the interval is stale', () => {
	const exactly = new Date(NOW - AGENT_TASKS_REFRESH_INTERVAL_MS).toISOString();
	const older = new Date(NOW - 3 * AGENT_TASKS_REFRESH_INTERVAL_MS).toISOString();
	assert.equal(isAgentTasksSnapshotFresh(exactly, NOW), false);
	assert.equal(isAgentTasksSnapshotFresh(older, NOW), false);
});

test('isAgentTasksSnapshotFresh: missing or unparseable timestamps are stale', () => {
	assert.equal(isAgentTasksSnapshotFresh(undefined, NOW), false);
	assert.equal(isAgentTasksSnapshotFresh('', NOW), false);
	assert.equal(isAgentTasksSnapshotFresh('not-a-date', NOW), false);
});

test('isAgentTasksSnapshotFresh: a far-future timestamp (clock change) is stale, not pinned fresh', () => {
	const future = new Date(NOW + 5 * AGENT_TASKS_REFRESH_INTERVAL_MS).toISOString();
	assert.equal(isAgentTasksSnapshotFresh(future, NOW), false);
});

test('nextAgentTasksRefreshAt: one interval after the fetch, undefined without one', () => {
	const fetchedAt = new Date(NOW).toISOString();
	assert.equal(nextAgentTasksRefreshAt(fetchedAt), new Date(NOW + AGENT_TASKS_REFRESH_INTERVAL_MS).toISOString());
	assert.equal(nextAgentTasksRefreshAt(undefined), undefined);
	assert.equal(nextAgentTasksRefreshAt('nonsense'), undefined);
});

// ---------------------------------------------------------------------------
// Envelope usability
// ---------------------------------------------------------------------------

test('isAgentTasksEnvelopeUsable: accepts a current-schema envelope covering the window', () => {
	assert.equal(isAgentTasksEnvelopeUsable(makeEnvelope(), SINCE), true);
});

test('isAgentTasksEnvelopeUsable: rejects a snapshot written by another schema version', () => {
	assert.equal(isAgentTasksEnvelopeUsable(makeEnvelope({ schemaVersion: 0 }), SINCE), false);
});

test('isAgentTasksEnvelopeUsable: rejects a snapshot covering a shorter window than asked for', () => {
	const shorter = makeEnvelope({ since: new Date(SINCE.getTime() + 24 * 60 * 60 * 1000).toISOString() });
	assert.equal(isAgentTasksEnvelopeUsable(shorter, SINCE), false);
});

test('isAgentTasksEnvelopeUsable: accepts a slightly older window (since is recomputed per call)', () => {
	const drifted = makeEnvelope({ since: new Date(SINCE.getTime() - 30 * 1000).toISOString() });
	assert.equal(isAgentTasksEnvelopeUsable(drifted, SINCE), true);
});

test('isAgentTasksEnvelopeUsable: rejects missing, malformed, and repo-less payloads', () => {
	assert.equal(isAgentTasksEnvelopeUsable(undefined, SINCE), false);
	assert.equal(isAgentTasksEnvelopeUsable(makeEnvelope({ since: 'garbage' }), SINCE), false);
	assert.equal(isAgentTasksEnvelopeUsable({ ...makeEnvelope(), data: undefined as any }, SINCE), false);
});

test('canServeAgentTasksSnapshot: a usable but stale snapshot is not served without a refresh', () => {
	const stale = makeEnvelope({ fetchedAt: new Date(NOW - 2 * AGENT_TASKS_REFRESH_INTERVAL_MS).toISOString() });
	assert.equal(isAgentTasksEnvelopeUsable(stale, SINCE), true);
	assert.equal(canServeAgentTasksSnapshot(stale, SINCE, NOW), false);
	assert.equal(canServeAgentTasksSnapshot(makeEnvelope(), SINCE, NOW), true);
});

// ---------------------------------------------------------------------------
// Disk round-trip
// ---------------------------------------------------------------------------

test('getAgentTasksCachePath: keeps dev and prod snapshots apart', () => {
	assert.equal(getAgentTasksCachePath('/store', 'prod'), path.join('/store', 'agenttasks_prod.snapshot.json'));
	assert.notEqual(getAgentTasksCachePath('/store', 'dev-abc'), getAgentTasksCachePath('/store', 'prod'));
});

test('writeAgentTasksSnapshot/readAgentTasksSnapshot: round-trips the snapshot', async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), 'agenttasks-'));
	const filePath = getAgentTasksCachePath(path.join(dir, 'nested'), 'prod');
	const envelope = makeEnvelope({ data: makeResult({ totalCredits: 43.4, totalTasks: 2 }) });

	await writeAgentTasksSnapshot(filePath, envelope);
	const readBack = await readAgentTasksSnapshot(filePath);

	assert.deepEqual(readBack, envelope);
	assert.deepEqual(await fs.promises.readdir(path.dirname(filePath)), [path.basename(filePath)]);
	await fs.promises.rm(dir, { recursive: true, force: true });
});

test('readAgentTasksSnapshot: missing or corrupt files read as undefined, never throw', async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), 'agenttasks-'));
	const missing = path.join(dir, 'nope.json');
	const corrupt = path.join(dir, 'corrupt.json');
	await fs.promises.writeFile(corrupt, '{ this is not json', 'utf8');

	assert.equal(await readAgentTasksSnapshot(missing), undefined);
	assert.equal(await readAgentTasksSnapshot(corrupt), undefined);
	await fs.promises.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Per-task cache records (issue #1968)
// ---------------------------------------------------------------------------

/**
 * A well-formed task record. The key is **derived** from the record's own repo and id unless a test
 * overrides it explicitly — `readAgentTaskRecords()` now rejects a record whose key does not
 * describe it, so a helper that left a fixed key behind would make every other test here pass for
 * the wrong reason: they would be asserting the key check, not the field they mean to isolate.
 */
function makeTaskRecord(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
	const merged: AgentTaskRecord = {
		key: '',
		id: 'task-1',
		repoKey: 'rajbos/repo',
		owner: 'rajbos',
		repo: 'repo',
		discovery: 'workspace',
		updatedAt: '2026-08-28T12:00:00.000Z',
		aggregate: { tasks: 1, sessions: 2, credits: 3, premiumRequests: 0 },
		detailOk: true,
		detailAttempts: 0,
		lastSeenAt: '2026-08-29T12:00:00.000Z',
		...overrides,
	};
	return 'key' in overrides ? merged : { ...merged, key: agentTaskCacheKey(merged.repoKey, merged.id) };
}

test('the cloud-agent cache schema is v3 — a v2 aggregate-only snapshot is not migrated', () => {
	assert.equal(AGENT_TASKS_CACHE_SCHEMA_VERSION, 3);
	const v2 = makeEnvelope({ schemaVersion: 2 });
	// Per-task records cannot be invented from a v2 aggregate, so the whole snapshot is ignored
	// and rebuilt in the background rather than half-migrated.
	assert.equal(isAgentTasksEnvelopeUsable(v2, SINCE), false);
	assert.deepEqual(readAgentTaskRecords(v2), []);
});

test('readAgentTaskRecords drops records that could never be matched again', () => {
	const envelope = makeEnvelope({
		tasks: [
			makeTaskRecord(),
			makeTaskRecord({ key: '', id: 'no-key' }),
			makeTaskRecord({ id: 'bad-stamp', updatedAt: 'not-a-date' }),
			makeTaskRecord({ key: 'k3', id: 'missing-stamp', updatedAt: undefined as any }),
		],
	});
	assert.deepEqual(readAgentTaskRecords(envelope).map((r) => r.id), ['task-1']);
});

test('readAgentTaskRecords drops a record whose aggregate is not all numbers', () => {
	// A present aggregate is summed straight into the tab's credits and session counts, so one
	// string or undefined in there turns a repo's totals into NaN. Refetching the detail is the
	// cheap outcome; a NaN on screen is not.
	const envelope = makeEnvelope({
		tasks: [
			makeTaskRecord(),
			makeTaskRecord({ id: 'string-credits', aggregate: { tasks: 1, sessions: 1, credits: '3' as any, premiumRequests: 0 } }),
			makeTaskRecord({ id: 'missing-field', aggregate: { tasks: 1, sessions: 1, credits: 3 } as any }),
			makeTaskRecord({ id: 'nan-credits', aggregate: { tasks: 1, sessions: 1, credits: NaN, premiumRequests: 0 } }),
			makeTaskRecord({ id: 'not-an-object', aggregate: 'nope' as any }),
		],
	});
	assert.deepEqual(readAgentTaskRecords(envelope).map((r) => r.id), ['task-1']);
});

test('readAgentTaskRecords drops a record whose detailOk is not a boolean', () => {
	// `detailOk` gates the cache hit and a string reaches that check truthy, so `"false"` would
	// suppress the very detail fetch it is asking for and serve stale usage as current.
	const envelope = makeEnvelope({
		tasks: [
			makeTaskRecord(),
			makeTaskRecord({ id: 'string-flag', detailOk: 'false' as any }),
			makeTaskRecord({ id: 'missing-flag', detailOk: undefined as any }),
		],
	});
	assert.deepEqual(readAgentTaskRecords(envelope).map((r) => r.id), ['task-1']);
});

test('reconcileAgentTaskRecords drops a seen-but-unverifiable task instead of retaining it', () => {
	// A task the listing surfaced with an uncacheable timestamp is absent from `current`, because
	// buildTaskRecords() refuses to store it. Retaining it would read "seen but unverifiable" as
	// "not seen", and a later pass whose timestamp happened to match the stale one would reuse the
	// old aggregate with no detail call.
	const seen = makeTaskRecord({ key: 'seen-uncacheable', id: 'u1' });
	const absent = makeTaskRecord({ key: 'never-listed', id: 'n1' });
	const result = reconcileAgentTaskRecords([seen, absent], [], {
		listingComplete: false,
		seenKeys: new Set(['seen-uncacheable']),
	});
	assert.deepEqual(result.records.map((r) => r.key), ['never-listed'], 'only the unseen record is retained');
	assert.equal(result.removed, 1);
	assert.equal(result.retainedUnverified, 1);
});

test('readAgentTaskRecords drops an aggregate with a negative field', () => {
	// foldAggregateIntoRow() *adds* these into the displayed totals, so a negative subtracts usage
	// a repo really had. None of these quantities can be negative in the API.
	const envelope = makeEnvelope({
		tasks: [
			makeTaskRecord(),
			makeTaskRecord({ id: 'neg-credits', aggregate: { tasks: 1, sessions: 1, credits: -5, premiumRequests: 0 } }),
			makeTaskRecord({ id: 'neg-sessions', aggregate: { tasks: 1, sessions: -1, credits: 0, premiumRequests: 0 } }),
		],
	});
	assert.deepEqual(readAgentTaskRecords(envelope).map((r) => r.id), ['task-1']);
	// Zero stays legitimate — a task can genuinely have run no billable sessions.
	const zeroed = makeTaskRecord({ id: 'zeroed', aggregate: { tasks: 0, sessions: 0, credits: 0, premiumRequests: 0 } });
	assert.equal(readAgentTaskRecords(makeEnvelope({ tasks: [zeroed] })).length, 1);
});

test('readAgentTaskRecords drops a record whose key does not describe it', () => {
	// The key is what a candidate is looked up by. A record sitting under a key that names another
	// task would hand its aggregate to that task — the cross-entity reuse this cache rules out.
	const impostor = {
		...makeTaskRecord({ id: 'task-1', repoKey: 'octo/repo' }),
		key: agentTaskCacheKey('octo/repo', 'a-different-task'),
	};
	assert.deepEqual(readAgentTaskRecords(makeEnvelope({ tasks: [impostor] })), []);

	const mismatchedRepo = { ...makeTaskRecord({ id: 'task-1', repoKey: 'octo/repo' }), key: agentTaskCacheKey('octo/other', 'task-1') };
	assert.deepEqual(readAgentTaskRecords(makeEnvelope({ tasks: [mismatchedRepo] })), []);

	// The honestly-keyed record still loads, including the "no repository" bucket's empty repoKey.
	assert.equal(readAgentTaskRecords(makeEnvelope({ tasks: [makeTaskRecord()] })).length, 1);
	const noRepo = { ...makeTaskRecord({ id: 'orphan', repoKey: '' }), key: agentTaskCacheKey('', 'orphan') };
	assert.equal(readAgentTaskRecords(makeEnvelope({ tasks: [noRepo] })).length, 1);
});

test('readAgentTaskRecords keeps a record that is still owed its detail', () => {
	// An absent aggregate means "must be fetched", never "zero" — such a record is kept so its
	// retry history survives, and partitionByCacheHit() refuses to treat it as a hit.
	const owed = makeTaskRecord({ id: 'owed', aggregate: undefined, detailOk: false, detailAttempts: 2 });
	const [record] = readAgentTaskRecords(makeEnvelope({ tasks: [owed] }));
	assert.equal(record.id, 'owed');
	assert.equal(record.detailAttempts, 2);
});

test('readAgentTaskRecords canonicalizes updatedAt so an alternate ISO spelling still hits', () => {
	// Task reuse is exact string equality against a canonical listing timestamp, so a record stored
	// with a valid-but-different spelling would validate and then be re-detailed on every pass —
	// paying the full detail cost forever with nothing in the UI to explain it.
	const envelope = makeEnvelope({ tasks: [makeTaskRecord({ updatedAt: '2026-08-28T12:00:00+00:00' })] });
	assert.equal(readAgentTaskRecords(envelope)[0].updatedAt, '2026-08-28T12:00:00.000Z');
});

test('readAgentTaskRecords tolerates an envelope written before task records existed', () => {
	assert.deepEqual(readAgentTaskRecords(makeEnvelope()), []);
	assert.deepEqual(readAgentTaskRecords(undefined), []);
	assert.deepEqual(readAgentTaskRecords(makeEnvelope({ tasks: 'nonsense' as any })), []);
});

test('agentTaskCacheKey scopes a task to its repository', () => {
	// A task that moved repositories lands on a new key, so its old aggregate can never be folded
	// into the wrong repository's row.
	assert.notEqual(agentTaskCacheKey('rajbos/repo', 't1'), agentTaskCacheKey('rajbos/other', 't1'));
	assert.notEqual(agentTaskCacheKey('', 't1'), agentTaskCacheKey('rajbos/repo', 't1'));
});

test('reconcileAgentTaskRecords drops tasks missing from a complete listing', () => {
	const cached = [makeTaskRecord(), makeTaskRecord({ key: 'k2', id: 'task-2' })];
	const current = [makeTaskRecord()];
	const result = reconcileAgentTaskRecords(cached, current, { listingComplete: true });
	assert.equal(result.removed, 1);
	assert.equal(result.retainedUnverified, 0);
	assert.deepEqual(result.records.map((r) => r.id), ['task-1']);
});

test('reconcileAgentTaskRecords retains tasks missing from an incomplete listing', () => {
	const cached = [makeTaskRecord(), makeTaskRecord({ key: 'k2', id: 'task-2' })];
	const result = reconcileAgentTaskRecords(cached, [makeTaskRecord()], { listingComplete: false });
	assert.equal(result.removed, 0);
	assert.equal(result.retainedUnverified, 1);
	assert.deepEqual(result.records.map((r) => r.id).sort(), ['task-1', 'task-2']);
});

test('reconcileAgentTaskRecords prefers the current pass over the cached copy of the same task', () => {
	const cached = makeTaskRecord({ aggregate: { tasks: 1, sessions: 1, credits: 1, premiumRequests: 0 } });
	const current = makeTaskRecord({ updatedAt: '2026-08-29T09:00:00.000Z', aggregate: { tasks: 1, sessions: 9, credits: 9, premiumRequests: 0 } });
	const result = reconcileAgentTaskRecords([cached], [current], { listingComplete: true });
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0].aggregate?.sessions, 9);
});

test('reconcileAgentTaskRecords evicts the least recently seen records past the budget', () => {
	const cached = Array.from({ length: 5 }, (_, i) => makeTaskRecord({
		key: `k${i}`, id: `task-${i}`,
		lastSeenAt: new Date(Date.parse('2026-08-29T12:00:00Z') + i * 60_000).toISOString(),
	}));
	const result = reconcileAgentTaskRecords(cached, [], { listingComplete: false }, { maxRecords: 2, maxBytes: 1_000_000 });
	assert.equal(result.evicted, 3);
	assert.deepEqual(result.records.map((r) => r.id), ['task-4', 'task-3']);
});
