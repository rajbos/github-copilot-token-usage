import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
	REPO_PRS_CACHE_SCHEMA_VERSION,
	REPO_PRS_REFRESH_INTERVAL_MS,
	canServeRepoPrSnapshot,
	getRepoPrCachePath,
	isRealRepoPrSnapshot,
	isRepoPrEnvelopeUsable,
	isRepoPrSnapshotFresh,
	nextRepoPrRefreshAt,
	pruneRepoPrRecords,
	readRepoPrRecords,
	readRepoPrSnapshot,
	shouldPreserveRepoPrSnapshotForEmptyDiscovery,
	shouldPublishRepoPrStats,
	writeRepoPrSnapshot,
	type RepoPrCacheEnvelope,
} from '../../src/repoPrCache';
import type { RepoPrRecord, RepoPrStatsResult } from '../../src/githubPrService';

const NOW = Date.parse('2026-08-29T12:00:00Z');
const SINCE = new Date('2026-07-30T12:00:00Z');

function makeResult(overrides: Partial<RepoPrStatsResult> = {}): RepoPrStatsResult {
	return {
		repos: [],
		authenticated: true,
		since: SINCE.toISOString(),
		fetchedAt: new Date(NOW).toISOString(),
		...overrides,
	};
}

function makeEnvelope(overrides: Partial<RepoPrCacheEnvelope> = {}): RepoPrCacheEnvelope {
	return {
		schemaVersion: REPO_PRS_CACHE_SCHEMA_VERSION,
		fetchedAt: new Date(NOW).toISOString(),
		since: SINCE.toISOString(),
		data: makeResult(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('isRepoPrSnapshotFresh: a snapshot younger than the interval is fresh', () => {
	const fetchedAt = new Date(NOW - 59 * 60 * 1000).toISOString();
	assert.equal(isRepoPrSnapshotFresh(fetchedAt, NOW), true);
});

test('isRepoPrSnapshotFresh: a snapshot at or past the interval is stale', () => {
	const exactly = new Date(NOW - REPO_PRS_REFRESH_INTERVAL_MS).toISOString();
	const older = new Date(NOW - 3 * REPO_PRS_REFRESH_INTERVAL_MS).toISOString();
	assert.equal(isRepoPrSnapshotFresh(exactly, NOW), false);
	assert.equal(isRepoPrSnapshotFresh(older, NOW), false);
});

test('isRepoPrSnapshotFresh: missing or unparseable timestamps are stale', () => {
	assert.equal(isRepoPrSnapshotFresh(undefined, NOW), false);
	assert.equal(isRepoPrSnapshotFresh('', NOW), false);
	assert.equal(isRepoPrSnapshotFresh('not-a-date', NOW), false);
});

test('isRepoPrSnapshotFresh: a far-future timestamp (clock change) is stale, not pinned fresh', () => {
	const future = new Date(NOW + 5 * REPO_PRS_REFRESH_INTERVAL_MS).toISOString();
	assert.equal(isRepoPrSnapshotFresh(future, NOW), false);
});

test('nextRepoPrRefreshAt: one interval after the fetch, undefined without one', () => {
	const fetchedAt = new Date(NOW).toISOString();
	assert.equal(nextRepoPrRefreshAt(fetchedAt), new Date(NOW + REPO_PRS_REFRESH_INTERVAL_MS).toISOString());
	assert.equal(nextRepoPrRefreshAt(undefined), undefined);
	assert.equal(nextRepoPrRefreshAt('nonsense'), undefined);
});

// ---------------------------------------------------------------------------
// Envelope usability
// ---------------------------------------------------------------------------

test('isRepoPrEnvelopeUsable: accepts a current-schema envelope covering the window', () => {
	assert.equal(isRepoPrEnvelopeUsable(makeEnvelope(), SINCE), true);
});

test('isRepoPrEnvelopeUsable: rejects a snapshot written by another schema version', () => {
	assert.equal(isRepoPrEnvelopeUsable(makeEnvelope({ schemaVersion: 0 }), SINCE), false);
});

test('isRepoPrEnvelopeUsable: rejects a snapshot covering a shorter window than asked for', () => {
	const shorter = makeEnvelope({ since: new Date(SINCE.getTime() + 24 * 60 * 60 * 1000).toISOString() });
	assert.equal(isRepoPrEnvelopeUsable(shorter, SINCE), false);
});

test('isRepoPrEnvelopeUsable: accepts a slightly older window (since is recomputed per call)', () => {
	const drifted = makeEnvelope({ since: new Date(SINCE.getTime() - 30 * 1000).toISOString() });
	assert.equal(isRepoPrEnvelopeUsable(drifted, SINCE), true);
});

test('isRepoPrEnvelopeUsable: rejects missing, malformed, and repo-less payloads', () => {
	assert.equal(isRepoPrEnvelopeUsable(undefined, SINCE), false);
	assert.equal(isRepoPrEnvelopeUsable(makeEnvelope({ since: 'garbage' }), SINCE), false);
	assert.equal(isRepoPrEnvelopeUsable({ ...makeEnvelope(), data: undefined as any }, SINCE), false);
});

test('canServeRepoPrSnapshot: a usable but stale snapshot is not served without a refresh', () => {
	const stale = makeEnvelope({ fetchedAt: new Date(NOW - 2 * REPO_PRS_REFRESH_INTERVAL_MS).toISOString() });
	assert.equal(isRepoPrEnvelopeUsable(stale, SINCE), true);
	assert.equal(canServeRepoPrSnapshot(stale, SINCE, NOW), false);
	assert.equal(canServeRepoPrSnapshot(makeEnvelope(), SINCE, NOW), true);
});

test('shouldPreserveRepoPrSnapshotForEmptyDiscovery: retains a populated usable snapshot when a window finds no repos', () => {
	const populated = makeEnvelope({
		data: makeResult({
			repos: [{ owner: 'a', repo: 'b', repoUrl: 'https://github.com/a/b', totalPrs: 3, aiAuthoredPrs: 1, aiReviewRequestedPrs: 0, aiDetails: [] }],
		}),
	});
	assert.equal(shouldPreserveRepoPrSnapshotForEmptyDiscovery(populated, SINCE, 0), true);
	assert.equal(shouldPreserveRepoPrSnapshotForEmptyDiscovery(populated, SINCE, 1), false);
	assert.equal(shouldPreserveRepoPrSnapshotForEmptyDiscovery(makeEnvelope(), SINCE, 0), false);
	assert.equal(shouldPreserveRepoPrSnapshotForEmptyDiscovery(makeEnvelope({ schemaVersion: 0 }), SINCE, 0), false);
});

// ---------------------------------------------------------------------------
// Disk round-trip
// ---------------------------------------------------------------------------

test('getRepoPrCachePath: keeps dev and prod snapshots apart', () => {
	assert.equal(getRepoPrCachePath('/store', 'prod'), path.join('/store', 'repoprs_prod.snapshot.json'));
	assert.notEqual(getRepoPrCachePath('/store', 'dev-abc'), getRepoPrCachePath('/store', 'prod'));
});

test('writeRepoPrSnapshot/readRepoPrSnapshot: round-trips the snapshot', async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), 'repoprs-'));
	const filePath = getRepoPrCachePath(path.join(dir, 'nested'), 'prod');
	const envelope = makeEnvelope({ data: makeResult({ repos: [{ owner: 'a', repo: 'b', repoUrl: 'https://github.com/a/b', totalPrs: 3, aiAuthoredPrs: 1, aiReviewRequestedPrs: 0, aiDetails: [] }] }) });

	await writeRepoPrSnapshot(filePath, envelope);
	const readBack = await readRepoPrSnapshot(filePath);

	assert.deepEqual(readBack, envelope);
	assert.deepEqual(await fs.promises.readdir(path.dirname(filePath)), [path.basename(filePath)]);
	await fs.promises.rm(dir, { recursive: true, force: true });
});

test('readRepoPrSnapshot: missing or corrupt files read as undefined, never throw', async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), 'repoprs-'));
	const missing = path.join(dir, 'nope.json');
	const corrupt = path.join(dir, 'corrupt.json');
	await fs.promises.writeFile(corrupt, '{ this is not json', 'utf8');

	assert.equal(await readRepoPrSnapshot(missing), undefined);
	assert.equal(await readRepoPrSnapshot(corrupt), undefined);
	await fs.promises.rm(dir, { recursive: true, force: true });
});

// ── isRealRepoPrSnapshot ─────────────────────────────────────────────────────
// The Efficiency view's Value tab derives PR metrics from this snapshot, so it has to tell the
// instant cold-open placeholder ("no PR data yet" — render the hint) from a snapshot that really
// was fetched and happens to contain zeroes.

test('isRealRepoPrSnapshot: the never-fetched placeholder is not real data', () => {
	assert.equal(isRealRepoPrSnapshot(undefined), false);
	assert.equal(isRealRepoPrSnapshot({ repos: [], fetchedAt: '' }), false);
	assert.equal(isRealRepoPrSnapshot({ repos: [], fetchedAt: undefined }), false);
});

test('isRealRepoPrSnapshot: a fetched snapshot is real even with zero repos', () => {
	assert.equal(isRealRepoPrSnapshot(makeResult({ repos: [] })), true);
});

test('isRealRepoPrSnapshot: a populated repo list counts without a fetch timestamp', () => {
	// `fetchedAt` is optional on `RepoPrStatsResult` and the cache-read path does not require it,
	// so repos alone must be enough — otherwise such a snapshot would leave the Value tab on its
	// "never loaded" hint.
	const repo = { owner: 'a', repo: 'b', repoUrl: 'https://github.com/a/b', totalPrs: 3, aiAuthoredPrs: 1, aiReviewRequestedPrs: 0, aiDetails: [] };
	assert.equal(isRealRepoPrSnapshot({ repos: [repo], fetchedAt: undefined }), true);
});

// ── shouldPublishRepoPrStats ─────────────────────────────────────────────────
// The other half of "which snapshots may reach the Value cards": a refresh that was already in
// flight when the user signed out finishes with an authenticated result the signed-out check at
// the *start* of a refresh cannot see.

test('shouldPublishRepoPrStats: an authenticated result is dropped once the user signed out', () => {
	assert.equal(shouldPublishRepoPrStats(makeResult({ authenticated: true }), true), false);
});

test('shouldPublishRepoPrStats: the sign-out\'s own unauthenticated result still publishes', () => {
	// Sign-out sets the flag *before* publishing its empty snapshot, so dropping on the flag alone
	// would leave the cards showing pre-sign-out numbers — the opposite of the intent.
	assert.equal(shouldPublishRepoPrStats(makeResult({ authenticated: false }), true), true);
});

test('shouldPublishRepoPrStats: nothing is dropped while signed in', () => {
	assert.equal(shouldPublishRepoPrStats(makeResult({ authenticated: true }), false), true);
	assert.equal(shouldPublishRepoPrStats(makeResult({ authenticated: false }), false), true);
});

// ---------------------------------------------------------------------------
// Per-PR cache records (issue #1968)
// ---------------------------------------------------------------------------

function makePrRecord(overrides: Partial<RepoPrRecord> = {}): RepoPrRecord {
	return {
		number: 1,
		title: 'Add a thing',
		url: 'https://github.com/rajbos/repo/pull/1',
		createdAt: '2026-08-01T10:00:00.000Z',
		updatedAt: '2026-08-02T10:00:00.000Z',
		state: 'open',
		merged: false,
		authorAiType: null,
		authorLogin: 'octocat',
		reviewerAiTypes: [],
		...overrides,
	};
}

test('readRepoPrRecords returns the records of the requested repo only', () => {
	const envelope = makeEnvelope({
		prs: {
			'rajbos/repo': [makePrRecord({ number: 1 })],
			'rajbos/other': [makePrRecord({ number: 2 })],
		},
	});
	assert.deepEqual(readRepoPrRecords(envelope, 'rajbos/repo').map((r) => r.number), [1]);
	assert.deepEqual(readRepoPrRecords(envelope, 'rajbos/other').map((r) => r.number), [2]);
	assert.deepEqual(readRepoPrRecords(envelope, 'rajbos/unknown'), []);
});

test('readRepoPrRecords drops records that could never be matched again', () => {
	const envelope = makeEnvelope({
		prs: {
			'rajbos/repo': [
				makePrRecord({ number: 1 }),
				makePrRecord({ number: 2, updatedAt: '' }),
				makePrRecord({ number: 3, updatedAt: 'not-a-date' }),
				makePrRecord({ number: -1 }),
			],
		},
	});
	assert.deepEqual(readRepoPrRecords(envelope, 'rajbos/repo').map((r) => r.number), [1]);
});

test('readRepoPrRecords drops a record whose projection is malformed, not just mis-keyed', () => {
	// summarizeRepoPrRecords() iterates reviewerAiTypes and reads the string fields directly, so a
	// record that reached disk malformed would be reused on a matching timestamp and throw —
	// turning a cache read into a failure where recomputing the PR costs one projection.
	const envelope = makeEnvelope({
		prs: {
			'rajbos/repo': [
				makePrRecord({ number: 1 }),
				makePrRecord({ number: 2, reviewerAiTypes: null as any }),
				makePrRecord({ number: 3, reviewerAiTypes: 'copilot' as any }),
				makePrRecord({ number: 4, authorLogin: undefined as any }),
				makePrRecord({ number: 5, title: 42 as any }),
			],
		},
	});
	assert.deepEqual(readRepoPrRecords(envelope, 'rajbos/repo').map((r) => r.number), [1]);
});

test('readRepoPrRecords drops a record whose counted fields have the wrong type', () => {
	// merged and the AI attribution are *counted*, not just displayed: `merged: "false"` is truthy
	// and inflates the merged count, and any truthy AI value increments the AI metrics whether or
	// not it names a system this code knows how to attribute.
	const envelope = makeEnvelope({
		prs: {
			'rajbos/repo': [
				makePrRecord({ number: 1 }),
				makePrRecord({ number: 2, merged: 'false' as any }),
				makePrRecord({ number: 3, authorAiType: 'gemini' as any }),
				makePrRecord({ number: 4, reviewerAiTypes: ['copilot', 'nonsense'] as any }),
			],
		},
	});
	assert.deepEqual(readRepoPrRecords(envelope, 'rajbos/repo').map((r) => r.number), [1]);

	// The real shapes still load: a human author is `null`, and the four known AI types are valid.
	const valid = makeEnvelope({
		prs: {
			'rajbos/repo': [
				makePrRecord({ number: 5, authorAiType: null, merged: true }),
				makePrRecord({ number: 6, authorAiType: 'copilot', reviewerAiTypes: ['claude', 'openai', 'other-ai'] }),
			],
		},
	});
	assert.deepEqual(readRepoPrRecords(valid, 'rajbos/repo').map((r) => r.number), [5, 6]);
});

test('readRepoPrRecords drops a fractional PR number', () => {
	// GitHub's PR numbers are whole and 1-based. A fractional one could never be matched by a
	// listing, and would surface in the AI-detail rows as a `#1.5` link that goes nowhere.
	const envelope = makeEnvelope({
		prs: { 'rajbos/repo': [makePrRecord({ number: 1 }), makePrRecord({ number: 1.5 })] },
	});
	assert.deepEqual(readRepoPrRecords(envelope, 'rajbos/repo').map((r) => r.number), [1]);
});

test('readRepoPrRecords canonicalizes timestamps so an alternate ISO spelling still hits', () => {
	// Reuse is exact string equality against a canonical listing timestamp. A record written with a
	// valid-but-different spelling (no millis, or an offset instead of Z) would pass validation and
	// then silently never match again — a permanent cache miss with nothing to see in the UI.
	const envelope = makeEnvelope({
		prs: {
			'rajbos/repo': [makePrRecord({
				number: 1,
				createdAt: '2026-08-01T00:00:00Z',
				updatedAt: '2026-08-02T03:04:05+00:00',
			})],
		},
	});
	const [record] = readRepoPrRecords(envelope, 'rajbos/repo');
	assert.equal(record.createdAt, '2026-08-01T00:00:00.000Z');
	assert.equal(record.updatedAt, '2026-08-02T03:04:05.000Z');
});

test('pruneRepoPrRecords budgets the record, not the repo key it is grouped under', () => {
	// The flattened `{ repoKey, record }` wrapper is bookkeeping — the repo key is stored once per
	// repo as an object key, never once per PR. Charging it to every record would make the byte
	// budget bite well before the size it advertises, and the longer the repo name the worse.
	// Two records, so the "always keep at least one" floor cannot mask the difference.
	const records = [makePrRecord({ number: 1 }), makePrRecord({ number: 2 })];
	const recordBytes = records.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r), 'utf8'), 0);
	const longKey = `rajbos/${'a'.repeat(200)}`;
	const pruned = pruneRepoPrRecords({ [longKey]: records }, { maxRecords: 100, maxBytes: recordBytes });
	assert.equal(pruned.evicted, 0);
	assert.deepEqual(pruned.prs[longKey].map((r) => r.number), [1, 2]);
});

test('readRepoPrRecords tolerates a snapshot written before per-PR records existed', () => {
	assert.deepEqual(readRepoPrRecords(makeEnvelope(), 'rajbos/repo'), []);
	assert.deepEqual(readRepoPrRecords(undefined, 'rajbos/repo'), []);
	assert.deepEqual(readRepoPrRecords(makeEnvelope({ prs: { 'rajbos/repo': 'nope' as any } }), 'rajbos/repo'), []);
});

test('pruneRepoPrRecords keeps the most recently updated PRs across every repo', () => {
	const prs = {
		'rajbos/a': [makePrRecord({ number: 1, updatedAt: '2026-08-01T00:00:00.000Z' })],
		'rajbos/b': [
			makePrRecord({ number: 2, updatedAt: '2026-08-03T00:00:00.000Z' }),
			makePrRecord({ number: 3, updatedAt: '2026-08-02T00:00:00.000Z' }),
		],
	};
	const pruned = pruneRepoPrRecords(prs, { maxRecords: 2, maxBytes: 1_000_000 });
	assert.equal(pruned.evicted, 1);
	assert.deepEqual(Object.keys(pruned.prs), ['rajbos/b']);
	assert.deepEqual(pruned.prs['rajbos/b'].map((r) => r.number), [2, 3]);
});

test('pruneRepoPrRecords leaves an in-budget record set untouched', () => {
	const prs = { 'rajbos/a': [makePrRecord({ number: 1 })] };
	const pruned = pruneRepoPrRecords(prs, { maxRecords: 100, maxBytes: 1_000_000 });
	assert.equal(pruned.evicted, 0);
	assert.deepEqual(pruned.prs['rajbos/a'].map((r) => r.number), [1]);
});

test('a snapshot round-trips its per-PR records through disk', async () => {
	const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'repopr-records-'));
	try {
		const filePath = getRepoPrCachePath(dir, 'prod.github-com.aaaaaaaaaaaaaaaa');
		const envelope = makeEnvelope({ prs: { 'rajbos/repo': [makePrRecord()] } });
		await writeRepoPrSnapshot(filePath, envelope);
		const read = await readRepoPrSnapshot(filePath);
		assert.deepEqual(readRepoPrRecords(read, 'rajbos/repo'), [makePrRecord()]);
		// The scope is part of the filename, so another identity's read finds nothing.
		assert.equal(await readRepoPrSnapshot(getRepoPrCachePath(dir, 'prod.github-com.bbbbbbbbbbbbbbbb')), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
