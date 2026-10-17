/**
 * Cross-window cache for the Copilot cloud-agent task snapshot.
 *
 * Collecting agent sessions costs a task-list call per repo plus one detail call per task, so it
 * is deliberately expensive to refresh: the snapshot is written to a JSON file in the extension's
 * global storage (shared by every VS Code window of this edition) and refreshed at most once an
 * hour, by whichever window currently holds the agent-tasks lock. Every other window — and every
 * panel open in between — reads this file instead of calling GitHub.
 *
 * The file I/O lives here; the freshness decisions are pure functions so they can be unit tested
 * without touching disk, following the same split as `worktreeBackgroundScan.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSessionsResult, AgentTaskRecord } from './agentSessionsService';
import { agentTaskCacheKey } from './agentSessionsService';
import { applyRecordBudget, parseEntityTimestamp, type RecordBudget } from './githubActivityCache';

/** How often the agent-task snapshot may be refreshed from the GitHub API: once an hour. */
export const AGENT_TASKS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Bumped whenever the shape of `AgentSessionsResult` changes in a way that would make an older
 * snapshot render incorrectly. Snapshots from a different version are ignored (and refetched).
 *
 * **v3** added `tasks`: the per-task records that let an unchanged task skip its detail call. A v2
 * snapshot only ever held the aggregate totals, from which per-task records cannot be recovered —
 * attributing an aggregate back to individual tasks would be invention, not migration. So there is
 * no v2 → v3 migration: a v2 file is ignored and the first refresh after upgrading rebuilds the
 * records in the background, exactly as a first-ever run does. That costs one full (already
 * budgeted) pass once; every pass after it is incremental.
 */
export const AGENT_TASKS_CACHE_SCHEMA_VERSION = 3;

/**
 * Bounds on the locally stored task records. A record is a few hundred bytes, so 4,000 of them is
 * well under a megabyte — far below the size at which a JSON file in global storage is a problem,
 * and far above what a normal account accumulates in a 30-day window.
 */
export const AGENT_TASK_RECORD_BUDGET: RecordBudget = { maxRecords: 4000, maxBytes: 2_000_000 };

/** On-disk envelope: the snapshot plus what it takes to decide whether it is still usable. */
export interface AgentTasksCacheEnvelope {
	schemaVersion: number;
	/** When the snapshot was fetched from GitHub (ISO 8601). */
	fetchedAt: string;
	/** Start of the window the snapshot covers (ISO 8601), so a widened window invalidates it. */
	since: string;
	data: AgentSessionsResult;
	/**
	 * Per-task records behind the totals in `data`. Local-only: this is the half of the envelope
	 * that never reaches a webview. Absent on a snapshot written before a listing completed.
	 */
	tasks?: AgentTaskRecord[];
}

/**
 * The cached task records of an envelope, filtered to the ones that are actually reusable.
 *
 * `updatedAt` is canonicalized here, at the one boundary where a record can arrive in a form this
 * code did not write: reuse is exact string equality against a listing timestamp that is always
 * canonical, so a valid-but-differently-spelled timestamp on disk would pass the filter and then
 * never match — a task re-detailed on every pass, at full cost, for no visible reason.
 */
export function readAgentTaskRecords(envelope: AgentTasksCacheEnvelope | undefined): AgentTaskRecord[] {
	if (!envelope || !Array.isArray(envelope.tasks)) { return []; }
	return envelope.tasks.filter((record): record is AgentTaskRecord => (
		Boolean(record)
		&& typeof record.key === 'string' && record.key !== ''
		&& typeof record.id === 'string'
		// The key must be derived from this record's *own* repo and task, not merely non-empty.
		// It is what a candidate is looked up by, so a record sitting under a key that does not
		// describe it would hand its aggregate to a different task — precisely the cross-entity
		// reuse this cache promises cannot happen.
		&& typeof record.repoKey === 'string'
		&& record.key === agentTaskCacheKey(record.repoKey, record.id)
		&& parseEntityTimestamp(record.updatedAt) !== undefined
		// `detailOk` gates the cache hit, and a string reaches that check truthy — a record stored
		// as `detailOk: "false"` would suppress the detail fetch it is asking for and show stale
		// usage. Nothing about the field's *name* forces it to be a boolean on disk, so check.
		&& typeof record.detailOk === 'boolean'
		&& isUsableTaskAggregate(record.aggregate)
	// The filter has already proved the timestamp parses, so the `!` below cannot be hit.
	)).map((record) => ({ ...record, updatedAt: parseEntityTimestamp(record.updatedAt)! }));
}

/**
 * Whether a record's aggregate can be added to a row's totals.
 *
 * Absent is legitimate — it means "the detail fetch is still owed", never "zero". But a *present*
 * aggregate is summed straight into the tab's credits and session counts, so every field has to be
 * a real number. A record that reached disk with a string or an undefined in there (a hand-edited
 * file, a truncated write, an older shape) would otherwise satisfy the cache-hit check and quietly
 * turn a repo's totals into `NaN` — which is far worse than refetching the task's detail.
 */
function isUsableTaskAggregate(aggregate: AgentTaskRecord['aggregate']): boolean {
	if (aggregate === undefined || aggregate === null) { return true; }
	if (typeof aggregate !== 'object') { return false; }
	// Non-negative, not merely finite: `foldAggregateIntoRow()` *adds* these straight into the
	// displayed totals, so a negative would subtract credits or sessions a repo really used. None
	// of these quantities can be negative in the API, so one on disk means the record is corrupt.
	return (['tasks', 'sessions', 'credits', 'premiumRequests'] as const)
		.every((field) => Number.isFinite(aggregate[field]) && aggregate[field] >= 0);
}

/**
 * Decide which task records to persist after a refresh.
 *
 * `current` is this pass's listing membership. When the listing enumerated fully, that membership
 * is authoritative and anything missing from it really is gone (closed, archived away, moved to a
 * repo the token can no longer see) — so the leftovers are dropped. When it did not, absence
 * proves nothing: the leftovers are retained so the next pass can still reuse them instead of
 * paying for every detail call again. Either way, the retained records only ever save API calls —
 * the totals shown come from current membership alone, so a stale leftover can never inflate them.
 */
export function reconcileAgentTaskRecords(
	cached: readonly AgentTaskRecord[],
	current: readonly AgentTaskRecord[],
	options: { listingComplete: boolean; seenKeys?: ReadonlySet<string> },
	budget: RecordBudget = AGENT_TASK_RECORD_BUDGET,
): { records: AgentTaskRecord[]; removed: number; retainedUnverified: number; evicted: number } {
	const byKey = new Map<string, AgentTaskRecord>();
	for (const record of current) { byKey.set(record.key, record); }

	let removed = 0;
	let retainedUnverified = 0;
	for (const record of cached) {
		if (byKey.has(record.key)) { continue; }
		// A task the listing *did* surface but whose timestamp was uncacheable is absent from
		// `current` — `buildTaskRecords()` refuses to store it. Retaining its old record here would
		// treat "seen, but cannot be verified" as "not seen", and a later pass whose timestamp
		// happened to match the stale one would reuse the old aggregate without a detail call. The
		// record is dropped instead: it was observed, and observation without verification is
		// exactly the case the cache must not paper over.
		if (options.seenKeys?.has(record.key)) { removed++; continue; }
		if (options.listingComplete) { removed++; continue; }
		byKey.set(record.key, record);
		retainedUnverified++;
	}

	const { kept, evicted } = applyRecordBudget(
		[...byKey.values()],
		budget,
		(record) => Date.parse(record.lastSeenAt) || Date.parse(record.updatedAt) || 0,
	);
	return { records: kept, removed, retainedUnverified, evicted };
}

/** Path of the shared snapshot file for this cache identifier (dev and prod are kept separate). */
export function getAgentTasksCachePath(globalStoragePath: string, cacheIdentifier: string): string {
	return path.join(globalStoragePath, `agenttasks_${cacheIdentifier}.snapshot.json`);
}

/**
 * Whether a snapshot is still fresh enough to serve without calling GitHub. A missing or
 * unparseable timestamp counts as stale, and so does one in the future by more than the interval
 * (a clock change) so a bad timestamp can never pin the cache open forever.
 */
export function isAgentTasksSnapshotFresh(
	fetchedAt: string | undefined,
	now: number,
	intervalMs: number = AGENT_TASKS_REFRESH_INTERVAL_MS,
): boolean {
	if (!fetchedAt) { return false; }
	const fetchedMs = Date.parse(fetchedAt);
	if (!Number.isFinite(fetchedMs)) { return false; }
	const age = now - fetchedMs;
	if (age < -intervalMs) { return false; }
	return age < intervalMs;
}

/** Whether this envelope can be served as-is: right schema, same window, still fresh. */
export function canServeAgentTasksSnapshot(
	envelope: AgentTasksCacheEnvelope | undefined,
	since: Date,
	now: number,
	intervalMs: number = AGENT_TASKS_REFRESH_INTERVAL_MS,
): boolean {
	if (!isAgentTasksEnvelopeUsable(envelope, since)) { return false; }
	return isAgentTasksSnapshotFresh(envelope?.fetchedAt, now, intervalMs);
}

/**
 * Whether an envelope may be shown at all (even when stale): a stale snapshot is still the best
 * thing to render while the next hourly refresh is pending, but one from another schema version or
 * covering a shorter window than asked for is not.
 */
export function isAgentTasksEnvelopeUsable(
	envelope: AgentTasksCacheEnvelope | undefined,
	since: Date,
): boolean {
	if (!envelope || envelope.schemaVersion !== AGENT_TASKS_CACHE_SCHEMA_VERSION) { return false; }
	if (!envelope.data || !Array.isArray(envelope.data.repos)) { return false; }
	const snapshotSince = Date.parse(envelope.since);
	if (!Number.isFinite(snapshotSince)) { return false; }
	// Tolerate a minute of drift: `since` is recomputed as "30 days ago" on every call.
	return snapshotSince <= since.getTime() + 60_000;
}

/** When the next refresh becomes due, as an ISO timestamp (undefined when it is due now). */
export function nextAgentTasksRefreshAt(
	fetchedAt: string | undefined,
	intervalMs: number = AGENT_TASKS_REFRESH_INTERVAL_MS,
): string | undefined {
	if (!fetchedAt) { return undefined; }
	const fetchedMs = Date.parse(fetchedAt);
	if (!Number.isFinite(fetchedMs)) { return undefined; }
	return new Date(fetchedMs + intervalMs).toISOString();
}

/** Read the shared snapshot, returning undefined when it is missing or unreadable. */
export async function readAgentTasksSnapshot(filePath: string): Promise<AgentTasksCacheEnvelope | undefined> {
	try {
		const raw = await fs.promises.readFile(filePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') { return undefined; }
		return parsed as AgentTasksCacheEnvelope;
	} catch {
		return undefined;
	}
}

/**
 * Write the shared snapshot. Writes to a temporary file first and renames it into place so a
 * window reading concurrently never sees a half-written file.
 */
export async function writeAgentTasksSnapshot(filePath: string, envelope: AgentTasksCacheEnvelope): Promise<void> {
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
