/**
 * Cross-window cache for the Repository PRs snapshot.
 *
 * Collecting AI PR activity costs a PR-list call (plus a commit-messages call per PR to detect
 * co-authored-by AI) for every discovered repo, so it is deliberately expensive to refresh: the
 * snapshot is written to a JSON file in the extension's global storage (shared by every VS Code
 * window of this edition) and refreshed at most once an hour, by whichever window currently holds
 * the repo-PRs lock. Every other window — and every panel open in between — reads this file
 * instead of calling GitHub.
 *
 * The file I/O lives here; the freshness decisions are pure functions so they can be unit tested
 * without touching disk. This mirrors the split used by `agentTasksCache.ts` for the Cloud Agent tab.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RepoPrRecord, RepoPrStatsResult } from './githubPrService';
import { isCacheableRepoPrRecord } from './githubPrService';
import { applyRecordBudget, approximateRecordBytes, parseEntityTimestamp, type RecordBudget } from './githubActivityCache';

/** How often the repository-PRs snapshot may be refreshed from the GitHub API: once an hour. */
export const REPO_PRS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Bumped whenever the shape of `RepoPrStatsResult` changes in a way that would make an older
 * snapshot render incorrectly. Snapshots from a different version are ignored (and refetched).
 *
 * Adding `prs` did **not** need a bump, unlike the cloud-agent cache's v2 → v3: the rendered part
 * of the envelope is unchanged, and the new per-PR records are purely additive. An existing
 * snapshot therefore keeps rendering exactly as before while it has no records — the next
 * revalidation simply recomputes every PR (which is what it did anyway) and writes records for the
 * pass after that. No user loses their snapshot to this change.
 */
export const REPO_PRS_CACHE_SCHEMA_VERSION = 1;

/**
 * Bounds on the locally stored PR records. Five pages of listing is 500 PRs per repo, so this fits
 * roughly twenty busy repositories' 30-day windows before the least recently updated PRs start
 * being evicted — and an evicted PR is simply recomputed from the next listing.
 */
export const REPO_PR_RECORD_BUDGET: RecordBudget = { maxRecords: 10_000, maxBytes: 4_000_000 };

/** On-disk envelope: the snapshot plus what it takes to decide whether it is still usable. */
export interface RepoPrCacheEnvelope {
	schemaVersion: number;
	/** When the snapshot was fetched from GitHub (ISO 8601). */
	fetchedAt: string;
	/** Start of the window the snapshot covers (ISO 8601), so a widened window invalidates it. */
	since: string;
	data: RepoPrStatsResult;
	/**
	 * Per-PR records behind the counts in `data`, keyed by normalized `owner/repo`. Local-only:
	 * this is the half of the envelope that never reaches a webview. Absent on snapshots written
	 * before this cache kept per-PR state.
	 */
	prs?: Record<string, RepoPrRecord[]>;
}

/**
 * The cached records for one repository, filtered to the ones that are actually reusable — the same
 * predicate the writer uses, so a record can never be stored under a rule the reader disagrees with.
 * Anything that fails it is treated as absent and recomputed.
 *
 * Timestamps are **canonicalized here**, at the one boundary where a record can arrive in a form
 * this code did not write. Reuse is decided by exact string equality against a listing timestamp
 * that is always canonical, so a valid-but-differently-spelled `2026-01-02T03:04:05Z` on disk would
 * otherwise pass the filter and then never match — a permanent, invisible cache miss. Normalizing
 * on read keeps that spelling out of the comparison *and* out of what the next pass persists.
 */
export function readRepoPrRecords(envelope: RepoPrCacheEnvelope | undefined, repoKey: string): RepoPrRecord[] {
	const records = envelope?.prs?.[repoKey];
	if (!Array.isArray(records)) { return []; }
	// The filter has already proved both timestamps parse, so the `!` below cannot be hit.
	return records.filter(isCacheableRepoPrRecord).map((record) => ({
		...record,
		createdAt: parseEntityTimestamp(record.createdAt)!,
		updatedAt: parseEntityTimestamp(record.updatedAt)!,
	}));
}

/**
 * Apply the storage budget across every repository's records at once, keeping the most recently
 * updated PRs. Eviction is always safe here: an evicted PR still appears in the next listing and is
 * simply recomputed — it never turns into a missing row or a shortened count, because the counts
 * are built from the listing, not from what survived eviction.
 */
export function pruneRepoPrRecords(
	prs: Record<string, RepoPrRecord[]>,
	budget: RecordBudget = REPO_PR_RECORD_BUDGET,
): { prs: Record<string, RepoPrRecord[]>; evicted: number } {
	const flattened: { repoKey: string; record: RepoPrRecord }[] = [];
	for (const [repoKey, records] of Object.entries(prs)) {
		for (const record of records) { flattened.push({ repoKey, record }); }
	}
	const { kept, evicted } = applyRecordBudget(
		flattened,
		budget,
		(entry) => Date.parse(entry.record.updatedAt) || 0,
		// Measure the record, not the `{ repoKey, record }` wrapper this function flattens into.
		// The repo key is stored once per repo as an object key, not once per PR, so charging it to
		// every record would make the budget bite well before the bytes it names.
		(entry) => approximateRecordBytes(entry.record),
	);
	const pruned: Record<string, RepoPrRecord[]> = {};
	for (const { repoKey, record } of kept) {
		(pruned[repoKey] ??= []).push(record);
	}
	return { prs: pruned, evicted };
}

/** Path of the shared snapshot file for this cache identifier (dev and prod are kept separate). */
export function getRepoPrCachePath(globalStoragePath: string, cacheIdentifier: string): string {
	return path.join(globalStoragePath, `repoprs_${cacheIdentifier}.snapshot.json`);
}

/**
 * Whether a snapshot is still fresh enough to serve without calling GitHub. A missing or
 * unparseable timestamp counts as stale, and so does one in the future by more than the interval
 * (a clock change) so a bad timestamp can never pin the cache open forever.
 */
export function isRepoPrSnapshotFresh(
	fetchedAt: string | undefined,
	now: number,
	intervalMs: number = REPO_PRS_REFRESH_INTERVAL_MS,
): boolean {
	if (!fetchedAt) { return false; }
	const fetchedMs = Date.parse(fetchedAt);
	if (!Number.isFinite(fetchedMs)) { return false; }
	const age = now - fetchedMs;
	if (age < -intervalMs) { return false; }
	return age < intervalMs;
}

/** Whether this envelope can be served as-is: right schema, same window, still fresh. */
export function canServeRepoPrSnapshot(
	envelope: RepoPrCacheEnvelope | undefined,
	since: Date,
	now: number,
	intervalMs: number = REPO_PRS_REFRESH_INTERVAL_MS,
): boolean {
	if (!isRepoPrEnvelopeUsable(envelope, since)) { return false; }
	return isRepoPrSnapshotFresh(envelope?.fetchedAt, now, intervalMs);
}

/**
 * Whether an envelope may be shown at all (even when stale): a stale snapshot is still the best
 * thing to render while the next hourly refresh is pending, but one from another schema version or
 * covering a shorter window than asked for is not.
 */
export function isRepoPrEnvelopeUsable(
	envelope: RepoPrCacheEnvelope | undefined,
	since: Date,
): boolean {
	if (!envelope || envelope.schemaVersion !== REPO_PRS_CACHE_SCHEMA_VERSION) { return false; }
	if (!envelope.data || !Array.isArray(envelope.data.repos)) { return false; }
	const snapshotSince = Date.parse(envelope.since);
	if (!Number.isFinite(snapshotSince)) { return false; }
	// Tolerate a minute of drift: `since` is recomputed as "30 days ago" on every call.
	return snapshotSince <= since.getTime() + 60_000;
}

/**
 * A global snapshot may be refreshed by a VS Code window that has no repository folders open.
 * Do not let that window replace an existing, usable repository list with an empty result.
 */
export function shouldPreserveRepoPrSnapshotForEmptyDiscovery(
	envelope: RepoPrCacheEnvelope | undefined,
	since: Date,
	discoveredRepoCount: number,
): boolean {
	return discoveredRepoCount === 0
		&& isRepoPrEnvelopeUsable(envelope, since)
		&& (envelope?.data.repos.length ?? 0) > 0;
}

/**
 * True when a snapshot carries real PR data rather than the "never fetched" placeholder.
 *
 * `buildEmptyRepoPrStatsResult()` serves an instant placeholder on cold open — `repos: []` with
 * `fetchedAt: ''` — so consumers that derive metrics from the snapshot (the Efficiency view's Value
 * tab) can tell "no PR data yet" from "fetched, and the answer is zero". `fetchedAt` is optional in
 * `RepoPrStatsResult`, and nothing on the cache-read path requires it, so a populated repo list
 * counts as real on its own.
 *
 * A snapshot with neither a timestamp nor repos is deliberately "no data" rather than "fetched,
 * and the answer is zero": every producer stamps `fetchedAt` (the placeholder with `''`, the
 * refresh path with a real ISO time, and the cache write carries that same result), so nothing
 * legitimate lands here — and a zero-PR claim derived from a snapshot that cannot show it ever
 * fetched would be a worse guess than the actionable hint.
 */
export function isRealRepoPrSnapshot(
	result: Pick<RepoPrStatsResult, 'repos' | 'fetchedAt'> | undefined,
): boolean {
	if (!result) { return false; }
	return Boolean(result.fetchedAt) || (Array.isArray(result.repos) && result.repos.length > 0);
}

/**
 * Whether a freshly collected Repository PR result may still be published.
 *
 * Sits beside {@link isRealRepoPrSnapshot} on purpose: between them they decide which snapshots
 * are allowed to reach the Repository PRs tab and the Efficiency view's Value cards.
 *
 * A refresh already in flight when the user signs out finishes with an authenticated result — the
 * signed-out check that gates *starting* a refresh cannot see it — and publishing that result
 * would repopulate the very cards the sign-out just cleared. The unauthenticated result the
 * sign-out itself publishes is unaffected: only authenticated ones are dropped.
 */
export function shouldPublishRepoPrStats(
	result: Pick<RepoPrStatsResult, 'authenticated'>,
	signedOutByUser: boolean,
): boolean {
	return !(result.authenticated && signedOutByUser);
}

/** When the next refresh becomes due, as an ISO timestamp (undefined when it is due now). */
export function nextRepoPrRefreshAt(
	fetchedAt: string | undefined,
	intervalMs: number = REPO_PRS_REFRESH_INTERVAL_MS,
): string | undefined {
	if (!fetchedAt) { return undefined; }
	const fetchedMs = Date.parse(fetchedAt);
	if (!Number.isFinite(fetchedMs)) { return undefined; }
	return new Date(fetchedMs + intervalMs).toISOString();
}

/** Read the shared snapshot, returning undefined when it is missing or unreadable. */
export async function readRepoPrSnapshot(filePath: string): Promise<RepoPrCacheEnvelope | undefined> {
	try {
		const raw = await fs.promises.readFile(filePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') { return undefined; }
		return parsed as RepoPrCacheEnvelope;
	} catch {
		return undefined;
	}
}

/**
 * Write the shared snapshot. Writes to a temporary file first and renames it into place so a
 * window reading concurrently never sees a half-written file.
 */
export async function writeRepoPrSnapshot(filePath: string, envelope: RepoPrCacheEnvelope): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.tmp`;
	await fs.promises.writeFile(tempPath, JSON.stringify(envelope), 'utf8');
	try {
		await fs.promises.rename(tempPath, filePath);
	} catch (err) {
		await fs.promises.rm(tempPath, { force: true });
		throw err;
	}
}
