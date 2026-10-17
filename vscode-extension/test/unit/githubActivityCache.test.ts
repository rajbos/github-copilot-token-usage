import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	GITHUB_ACTIVITY_MANUAL_REFRESH_COOLDOWN_MS,
	applyRecordBudget,
	approximateRecordBytes,
	buildGitHubActivityScope,
	deleteGitHubActivityCacheFiles,
	entityTimestampsMatch,
	evictInactiveGitHubActivityScopes,
	hashAccountIdentity,
	isManualRefreshAllowed,
	listGitHubActivityCacheFiles,
	normalizeGitHubHost,
	parseEntityTimestamp,
} from '../../src/githubActivityCache';

// ---------------------------------------------------------------------------
// Scoping: one identity's cached GitHub data must never serve another's
// ---------------------------------------------------------------------------

test('normalizeGitHubHost folds the github.com spellings together', () => {
	assert.equal(normalizeGitHubHost('github.com'), 'github-com');
	assert.equal(normalizeGitHubHost('api.github.com'), 'github-com');
	assert.equal(normalizeGitHubHost('WWW.GitHub.com'), 'github-com');
	assert.equal(normalizeGitHubHost(undefined), 'github-com');
	assert.equal(normalizeGitHubHost(''), 'github-com');
});

test('normalizeGitHubHost keeps enterprise hosts distinct from github.com', () => {
	assert.match(normalizeGitHubHost('api.octocat.ghe.com'), /^octocat-ghe-com-[0-9a-f]{8}$/);
	assert.equal(normalizeGitHubHost('api.octocat.ghe.com'), normalizeGitHubHost('octocat.ghe.com'));
	assert.notEqual(normalizeGitHubHost('octocat.ghe.com'), normalizeGitHubHost('github.com'));
});

test('normalizeGitHubHost does not collapse two different enterprise hosts into one scope', () => {
	// `ghe.internal.example` and `ghe-internal.example` slug identically; without the hash suffix
	// they would share a cache scope and one host's private snapshots could serve the other.
	const dotted = normalizeGitHubHost('ghe.internal.example');
	const hyphenated = normalizeGitHubHost('ghe-internal.example');
	assert.notEqual(dotted, hyphenated, `${dotted} vs ${hyphenated}`);
	assert.match(dotted, /^ghe-internal-example-[0-9a-f]{8}$/);
});

test('normalizeGitHubHost stays filename-safe for a host with no usable characters', () => {
	assert.match(normalizeGitHubHost('...'), /^host-[0-9a-f]{8}$/);
});

test('hashAccountIdentity is stable, case-insensitive and never reveals the login', () => {
	const hash = hashAccountIdentity('Octocat');
	assert.equal(hash, hashAccountIdentity('octocat'));
	assert.equal(hash.length, 16);
	assert.match(hash, /^[0-9a-f]{16}$/);
	assert.ok(!hash.includes('octocat'));
	assert.notEqual(hash, hashAccountIdentity('hubot'));
});

test('hashAccountIdentity maps an unknown account to a distinct anonymous handle', () => {
	assert.equal(hashAccountIdentity(undefined), 'anon');
	assert.equal(hashAccountIdentity('   '), 'anon');
	assert.notEqual(hashAccountIdentity('octocat'), 'anon');
});

test('buildGitHubActivityScope separates mode, host and account', () => {
	const octocat = buildGitHubActivityScope({ cacheIdentifier: 'prod', hostname: 'api.github.com', accountIdentity: 'octocat' });
	assert.match(octocat, /^prod\.github-com\.[0-9a-f]{16}$/);

	// A different account, host or VS Code mode must all land on a different file.
	assert.notEqual(octocat, buildGitHubActivityScope({ cacheIdentifier: 'prod', hostname: 'api.github.com', accountIdentity: 'hubot' }));
	assert.notEqual(octocat, buildGitHubActivityScope({ cacheIdentifier: 'prod', hostname: 'api.octocat.ghe.com', accountIdentity: 'octocat' }));
	assert.notEqual(octocat, buildGitHubActivityScope({ cacheIdentifier: 'dev', hostname: 'api.github.com', accountIdentity: 'octocat' }));
	assert.notEqual(octocat, buildGitHubActivityScope({ cacheIdentifier: 'prod', hostname: 'api.github.com', accountIdentity: undefined }));
});

test('a dev-mode scope cannot match the legacy dev-<hash> cleanup pattern', () => {
	// cacheManager.cleanupStaleDevCacheFiles() deletes `agenttasks_dev-<hex>.snapshot.json`.
	// A scoped filename must never look like that, or live snapshots would be swept away.
	const scope = buildGitHubActivityScope({ cacheIdentifier: 'dev', hostname: 'github.com', accountIdentity: 'octocat' });
	const filename = `agenttasks_${scope}.snapshot.json`;
	assert.ok(!/^(cache|refresh|agenttasks|repoprs)_dev-[0-9a-f]+\.(snapshot\.json|lock)$/.test(filename), filename);
});

// ---------------------------------------------------------------------------
// Entity timestamps: the correctness contract for reusing a cached projection
// ---------------------------------------------------------------------------

test('parseEntityTimestamp canonicalizes equivalent spellings of the same instant', () => {
	assert.equal(parseEntityTimestamp('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
	assert.equal(parseEntityTimestamp('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z');
	assert.equal(parseEntityTimestamp('2026-01-02T04:04:05+01:00'), '2026-01-02T03:04:05.000Z');
});

test('parseEntityTimestamp treats missing and malformed timestamps as uncacheable', () => {
	for (const value of [undefined, null, '', '   ', 'not-a-date', 42, {}, []]) {
		assert.equal(parseEntityTimestamp(value), undefined, `expected ${JSON.stringify(value)} to be uncacheable`);
	}
});

test('entityTimestampsMatch requires both sides to be present and equal', () => {
	assert.equal(entityTimestampsMatch('2026-01-02T03:04:05Z', '2026-01-02T03:04:05.000Z'), true);
	assert.equal(entityTimestampsMatch('2026-01-02T03:04:05Z', '2026-01-02T03:04:06Z'), false);
	assert.equal(entityTimestampsMatch(undefined, '2026-01-02T03:04:05Z'), false);
	assert.equal(entityTimestampsMatch('2026-01-02T03:04:05Z', 'nonsense'), false);
	assert.equal(entityTimestampsMatch(undefined, undefined), false);
});

// ---------------------------------------------------------------------------
// Manual refresh cooldown
// ---------------------------------------------------------------------------

test('isManualRefreshAllowed permits the first refresh and then enforces the cooldown', () => {
	const now = Date.parse('2026-08-29T12:00:00Z');
	assert.equal(isManualRefreshAllowed(undefined, now), true);
	assert.equal(isManualRefreshAllowed(now - 1_000, now), false);
	assert.equal(isManualRefreshAllowed(now - GITHUB_ACTIVITY_MANUAL_REFRESH_COOLDOWN_MS, now), true);
});

test('isManualRefreshAllowed is not pinned shut by a clock jump backwards', () => {
	const now = Date.parse('2026-08-29T12:00:00Z');
	assert.equal(isManualRefreshAllowed(now + 10 * 60_000, now), true);
	assert.equal(isManualRefreshAllowed(Number.NaN, now), true);
});

// ---------------------------------------------------------------------------
// Storage budget
// ---------------------------------------------------------------------------

test('normalizeGitHubHost does not merge an Enterprise host with its api. prefix', () => {
	// `api.` and `www.` front the same service only for github.com and the documented
	// api.<tenant>.ghe.com form. Nothing says a self-hosted `api.acme.example` is the same machine
	// as `acme.example`, and merging them would serve one host's private snapshots on the other.
	assert.notEqual(normalizeGitHubHost('api.acme.example'), normalizeGitHubHost('acme.example'));
	assert.notEqual(normalizeGitHubHost('www.acme.example'), normalizeGitHubHost('acme.example'));

	// The deliberate aliases still hold.
	assert.equal(normalizeGitHubHost('api.github.com'), 'github-com');
	assert.equal(normalizeGitHubHost('www.github.com'), 'github-com');
	assert.equal(normalizeGitHubHost('github.com'), 'github-com');
	assert.equal(normalizeGitHubHost('api.acme.ghe.com'), normalizeGitHubHost('acme.ghe.com'));

	// ...and an Enterprise host that merely *contains* ghe.com is not the tenant form.
	assert.notEqual(normalizeGitHubHost('api.acme.ghe.com.evil.example'), normalizeGitHubHost('acme.ghe.com.evil.example'));
});

test('applyRecordBudget keeps the most recently updated records within the record cap', () => {
	const records = [
		{ id: 'old', at: 1 },
		{ id: 'newest', at: 3 },
		{ id: 'middle', at: 2 },
	];
	const { kept, evicted } = applyRecordBudget(records, { maxRecords: 2, maxBytes: 1_000_000 }, (r) => r.at);
	assert.deepEqual(kept.map((r) => r.id), ['newest', 'middle']);
	assert.equal(evicted, 1);
});

test('applyRecordBudget stops at the byte budget but always keeps at least one record', () => {
	const records = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, at: i, padding: 'x'.repeat(100) }));
	const { kept, evicted } = applyRecordBudget(records, { maxRecords: 100, maxBytes: 250 }, (r) => r.at);
	assert.ok(kept.length >= 1 && kept.length < records.length, `kept ${kept.length}`);
	assert.equal(kept[0].id, 'r9');
	assert.equal(evicted, records.length - kept.length);

	// Even an impossibly small budget keeps the newest record rather than storing nothing.
	const tiny = applyRecordBudget(records, { maxRecords: 100, maxBytes: 1 }, (r) => r.at);
	assert.deepEqual(tiny.kept.map((r) => r.id), ['r9']);
});

test('applyRecordBudget charges the byte budget to what sizeOf names, not the wrapper', () => {
	// A caller that flattens records into a wrapper (to carry a grouping key) must be able to say
	// what actually gets persisted, or every entry pays for bookkeeping that never reaches the file.
	const wrapped = Array.from({ length: 4 }, (_, i) => ({
		key: 'k'.repeat(500),
		record: { id: `r${i}`, at: i },
	}));
	const payloadBytes = wrapped.reduce((sum, w) => sum + Buffer.byteLength(JSON.stringify(w.record), 'utf8'), 0);

	const measured = applyRecordBudget(wrapped, { maxRecords: 100, maxBytes: payloadBytes }, (w) => w.record.at, (w) => approximateRecordBytes(w.record));
	assert.deepEqual(measured.kept.map((w) => w.record.id), ['r3', 'r2', 'r1', 'r0']);
	assert.equal(measured.evicted, 0);

	// Without the hook the huge key is charged to every entry and the same set is evicted away.
	const unmeasured = applyRecordBudget(wrapped, { maxRecords: 100, maxBytes: payloadBytes }, (w) => w.record.at);
	assert.equal(unmeasured.kept.length, 1);
});

test('applyRecordBudget handles an empty set and a zero record cap', () => {
	assert.deepEqual(applyRecordBudget([], { maxRecords: 10, maxBytes: 10 }, () => 0), { kept: [], evicted: 0 });
	assert.deepEqual(applyRecordBudget([{ at: 1 }], { maxRecords: 0, maxBytes: 10 }, (r) => r.at), { kept: [], evicted: 1 });
});

// ---------------------------------------------------------------------------
// File helpers (isolated temp directories, cleaned up)
// ---------------------------------------------------------------------------

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gh-activity-cache-'));
	try {
		await run(dir);
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}

const SCOPE_A = 'prod.github-com.aaaaaaaaaaaaaaaa';
const SCOPE_B = 'prod.github-com.bbbbbbbbbbbbbbbb';

async function seedCacheFiles(dir: string): Promise<void> {
	await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_A}.snapshot.json`), '{}', 'utf8');
	await fs.promises.writeFile(path.join(dir, `agenttasks_${SCOPE_A}.snapshot.json`), '{}', 'utf8');
	await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_B}.snapshot.json`), '{}', 'utf8');
	// Unrelated files that must survive: the session cache and the lock files.
	await fs.promises.writeFile(path.join(dir, 'cache_prod.snapshot.json'), '{}', 'utf8');
	await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_A}.lock`), '{}', 'utf8');
}

test('listGitHubActivityCacheFiles finds only the two GitHub-activity snapshots', async () => {
	await withTempDir(async (dir) => {
		await seedCacheFiles(dir);
		const files = await listGitHubActivityCacheFiles(dir);
		assert.equal(files.length, 3);
		assert.deepEqual([...new Set(files.map((f) => f.scope))].sort(), [SCOPE_A, SCOPE_B]);
	});
});

test('listGitHubActivityCacheFiles returns nothing for a missing directory', async () => {
	assert.deepEqual(await listGitHubActivityCacheFiles(path.join(os.tmpdir(), 'no-such-dir-for-cache-test')), []);
});

test('deleteGitHubActivityCacheFiles with a scope removes only that identity (sign-out)', async () => {
	await withTempDir(async (dir) => {
		await seedCacheFiles(dir);
		const removed = await deleteGitHubActivityCacheFiles(dir, SCOPE_A);
		assert.equal(removed, 2);
		const remaining = (await fs.promises.readdir(dir)).sort();
		assert.deepEqual(remaining, ['cache_prod.snapshot.json', `repoprs_${SCOPE_A}.lock`, `repoprs_${SCOPE_B}.snapshot.json`].sort());
	});
});

test('deleteGitHubActivityCacheFiles without a scope removes every identity (Clear Cache)', async () => {
	await withTempDir(async (dir) => {
		await seedCacheFiles(dir);
		const removed = await deleteGitHubActivityCacheFiles(dir);
		assert.equal(removed, 3);
		// Clear Cache must not delete the session snapshot here (its own path handles that) and
		// must never touch the lock files that coordinate other windows.
		const remaining = (await fs.promises.readdir(dir)).sort();
		assert.deepEqual(remaining, ['cache_prod.snapshot.json', `repoprs_${SCOPE_A}.lock`].sort());
	});
});

test('evictInactiveGitHubActivityScopes keeps the active scope and the newest inactive ones', async () => {
	await withTempDir(async (dir) => {
		const scopes = ['prod.github-com.1111111111111111', 'prod.github-com.2222222222222222', 'prod.github-com.3333333333333333'];
		for (const [index, scope] of scopes.entries()) {
			const file = path.join(dir, `repoprs_${scope}.snapshot.json`);
			await fs.promises.writeFile(file, '{}', 'utf8');
			const stamp = new Date(Date.parse('2026-08-29T12:00:00Z') + index * 60_000);
			await fs.promises.utimes(file, stamp, stamp);
		}
		await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_A}.snapshot.json`), '{}', 'utf8');

		const removed = await evictInactiveGitHubActivityScopes(dir, SCOPE_A, 1);
		assert.equal(removed, 2);
		const remaining = (await fs.promises.readdir(dir)).sort();
		// The active scope survives, plus the single most recently written inactive one.
		assert.deepEqual(remaining, [`repoprs_${SCOPE_A}.snapshot.json`, `repoprs_${scopes[2]}.snapshot.json`].sort());
	});
});

test('evictInactiveGitHubActivityScopes never evicts the active scope', async () => {
	await withTempDir(async (dir) => {
		await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_A}.snapshot.json`), '{}', 'utf8');
		await fs.promises.writeFile(path.join(dir, `agenttasks_${SCOPE_A}.snapshot.json`), '{}', 'utf8');
		assert.equal(await evictInactiveGitHubActivityScopes(dir, SCOPE_A, 0), 0);
		assert.equal((await fs.promises.readdir(dir)).length, 2);
	});
});

// --- Review follow-up (PR #2073): abandoned atomic-write temp files ----------

test('cleanup also reclaims the temp files an interrupted atomic write leaves behind', async () => {
	// Both caches write `<name>.snapshot.json.<pid>.tmp` and rename it into place. A host that dies
	// between the two leaves a complete private envelope on disk; Clear Cache and sign-out must not
	// report success while that copy survives.
	await withTempDir(async (dir) => {
		await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_A}.snapshot.json`), '{}', 'utf8');
		await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_A}.snapshot.json.4242.tmp`), '{}', 'utf8');
		await fs.promises.writeFile(path.join(dir, `agenttasks_${SCOPE_B}.snapshot.json.99.tmp`), '{}', 'utf8');

		const listed = await listGitHubActivityCacheFiles(dir);
		assert.equal(listed.length, 3);
		assert.deepEqual([...new Set(listed.map((f) => f.scope))].sort(), [SCOPE_A, SCOPE_B]);

		// A scoped (sign-out) clear takes that identity's temp file with it.
		assert.equal(await deleteGitHubActivityCacheFiles(dir, SCOPE_A), 2);
		assert.deepEqual(await fs.promises.readdir(dir), [`agenttasks_${SCOPE_B}.snapshot.json.99.tmp`]);

		// And a full (Clear Cache) clear leaves nothing behind at all.
		assert.equal(await deleteGitHubActivityCacheFiles(dir), 1);
		assert.deepEqual(await fs.promises.readdir(dir), []);
	});
});

test('a temp file is attributed to its own scope, not to a scope named after the pid', async () => {
	await withTempDir(async (dir) => {
		await fs.promises.writeFile(path.join(dir, `repoprs_${SCOPE_A}.snapshot.json.7.tmp`), '{}', 'utf8');
		const [file] = await listGitHubActivityCacheFiles(dir);
		assert.equal(file.scope, SCOPE_A);
	});
});

test('applyRecordBudget stays deterministic when rank() returns a non-finite value', () => {
	// The helper is generic; a caller returning NaN would otherwise make the comparator
	// non-transitive and the eviction order non-deterministic.
	const records = [{ id: 'nan' }, { id: 'two' }, { id: 'one' }];
	const ranks: Record<string, number> = { nan: Number.NaN, two: 2, one: 1 };
	const { kept, evicted } = applyRecordBudget(records, { maxRecords: 2, maxBytes: 1_000_000 }, (r) => ranks[r.id]);
	assert.equal(kept.length, 2);
	assert.equal(evicted, 1);
	// NaN normalizes to 0, so it ranks below both real values and is the one evicted.
	assert.deepEqual(kept.map((r) => r.id), ['two', 'one']);
});
