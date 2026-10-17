/**
 * Shared policy for the two GitHub-activity caches — Repository PRs (`repoPrCache.ts`) and Copilot
 * cloud-agent tasks (`agentTasksCache.ts`).
 *
 * Both caches hold data that GitHub only shows to one authenticated account on one host, so both
 * need the same three things, which live here so the two cannot drift apart:
 *
 * - **Scoping.** A cache file is only ever read back by the same VS Code mode (dev/prod), the same
 *   normalized GitHub host, and the same account. The account contributes a non-reversible hash,
 *   never its login: the file *name* ends up in `globalStorage` next to everything else, and a
 *   readable login there would leak who is signed in. Signing out, switching accounts or pointing
 *   `github-enterprise.uri` at another host therefore lands on a different file rather than
 *   re-serving the previous identity's private data. Access tokens are never part of the scope and
 *   are never written to disk.
 * - **Entity timestamps.** Reuse of a cached projection is gated on the entity's `updated_at`
 *   matching the authoritative listing *exactly*. A missing, non-string or unparseable timestamp is
 *   uncacheable — it can never be matched, so those entities are always recomputed.
 * - **Bounds.** These caches are local-only conveniences, so they are allowed to lose data: record
 *   and byte budgets evict the least recently updated entries, and whole inactive scopes are
 *   dropped before the active one. Eviction must only ever cause a refetch — never a silently
 *   incomplete total — which is why every caller pairs it with the "did the listing complete?"
 *   flags in the two cache modules.
 *
 * Everything here is a pure function except the file helpers at the bottom, so the policy can be
 * unit tested without touching disk (the same split `agentTasksCache.ts` already uses).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A user-triggered "Refresh GitHub activity" bypasses the hourly TTL, but not more often than
 * this — otherwise a click-happy user could spend the whole GitHub rate limit from one window.
 */
export const GITHUB_ACTIVITY_MANUAL_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Filenames written by the GitHub-activity caches, for bulk clearing and scope eviction.
 *
 * The optional `.<pid>.tmp` tail matters: both caches write atomically by creating
 * `<name>.snapshot.json.<pid>.tmp` and renaming it into place. If the extension host dies between
 * the two, that temp file is left behind holding a **complete** private envelope. Matching only the
 * final name would let Clear Cache and sign-out report success while that copy survived on disk,
 * outside the advertised cleanup and outside the storage budget.
 */
const GITHUB_ACTIVITY_CACHE_FILE_PATTERN = /^(repoprs|agenttasks)_(.+?)\.snapshot\.json(?:\.\d+\.tmp)?$/;

/**
 * Normalize a GitHub host into a stable, filename-safe slug. `api.github.com`, `github.com` and
 * `www.github.com` are the same host as far as the cache is concerned; a GitHub Enterprise host
 * keeps its own identity so its data never satisfies a github.com request (and vice versa).
 *
 * Enterprise hosts carry a short hash of the exact canonical host alongside the readable slug.
 * Collapsing separators alone is lossy — `ghe.internal.example` and `ghe-internal.example` both
 * slug to `ghe-internal-example` — and two hosts sharing a scope would let one host's private
 * snapshots be served for the other. github.com keeps its bare, readable slug: its aliases are
 * deliberate, and it is the one host that cannot collide with an Enterprise host by construction
 * (an Enterprise scope always carries a hash suffix).
 *
 * The `api.`/`www.` aliases are recognized only for github.com and for a GitHub Enterprise Cloud
 * tenant's documented `api.<tenant>.ghe.com` API host. A self-hosted Enterprise Server keeps its
 * hostname exactly as configured — nothing says `api.acme.example` and `acme.example` are the same
 * machine, and treating them as one scope would be the same leak the hash exists to prevent.
 */
export function normalizeGitHubHost(hostname: string | undefined): string {
	const host = (hostname ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
	if (!host) { return 'github-com'; }
	// Alias stripping is deliberately *not* general. `api.` and `www.` are known to front the same
	// service only for github.com and for a GitHub Enterprise Cloud tenant's documented
	// `api.<tenant>.ghe.com` API host. Stripping them from every host would merge two genuinely
	// different self-hosted Enterprise servers — `api.acme.example` and `acme.example` are not
	// required to be the same machine — and one host's private snapshots would serve the other.
	if (host === 'github.com' || host === 'api.github.com' || host === 'www.github.com') { return 'github-com'; }
	const canonical = /^api\.[a-z0-9][a-z0-9-]*\.ghe\.com$/.test(host) ? host.slice('api.'.length) : host;
	const slug = canonical.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
	return slug ? `${slug}-${digest}` : `host-${digest}`;
}

/**
 * A non-reversible, stable handle for the authenticated account. Truncated to 16 hex characters:
 * long enough that two accounts do not collide in practice, short enough to keep filenames sane.
 * An unknown account (not signed in yet) hashes to a fixed `anon` handle so a pre-auth read can
 * never pick up a signed-in account's file.
 */
export function hashAccountIdentity(accountIdentity: string | undefined): string {
	const identity = (accountIdentity ?? '').trim().toLowerCase();
	if (!identity) { return 'anon'; }
	return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/** The inputs that decide which cache file a request may read or write. */
export interface GitHubActivityScopeInput {
	/** `dev` or `prod`, from the cache manager — debug data never mixes with a real install's. */
	cacheIdentifier: string;
	/** REST hostname currently configured (github.com, GHE.com or GitHub Enterprise Server). */
	hostname: string | undefined;
	/** The authenticated account's label. Hashed, never stored or logged in the clear. */
	accountIdentity: string | undefined;
}

/**
 * Build the scope segment used in a cache filename, e.g. `prod.github-com.1a2b3c4d5e6f7a8b`.
 *
 * The dot separators keep this from ever matching the legacy `dev-<hash>` cleanup pattern in
 * `cacheManager.cleanupStaleDevCacheFiles()`, which would otherwise delete live snapshots.
 */
export function buildGitHubActivityScope({ cacheIdentifier, hostname, accountIdentity }: GitHubActivityScopeInput): string {
	const mode = (cacheIdentifier || 'prod').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
	return `${mode}.${normalizeGitHubHost(hostname)}.${hashAccountIdentity(accountIdentity)}`;
}

/**
 * Canonicalize an entity's `updated_at` for cache-freshness comparison, returning undefined when
 * it is missing, not a string, or not a real timestamp. Callers treat undefined as **uncacheable**:
 * such an entity is recomputed on every pass rather than being reused on a guess.
 *
 * Canonicalizing (rather than keeping the raw string) means two spellings of the same instant —
 * `2026-01-02T03:04:05Z` and `2026-01-02T03:04:05.000Z` — compare equal, while any real change to
 * the entity moves the instant and therefore invalidates the cached projection.
 */
export function parseEntityTimestamp(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.trim() === '') { return undefined; }
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) { return undefined; }
	return new Date(parsed).toISOString();
}

/**
 * Whether a cached entity's timestamp matches the one the authoritative listing just reported.
 * Both sides must be present and valid — an unparseable timestamp on either side never matches,
 * so the entity is recomputed.
 */
export function entityTimestampsMatch(cached: unknown, listed: unknown): boolean {
	const a = parseEntityTimestamp(cached);
	const b = parseEntityTimestamp(listed);
	return a !== undefined && a === b;
}

/** Whether a manual refresh may start now, given when the last one started. */
export function isManualRefreshAllowed(
	lastManualRefreshAt: number | undefined,
	now: number,
	cooldownMs: number = GITHUB_ACTIVITY_MANUAL_REFRESH_COOLDOWN_MS,
): boolean {
	if (lastManualRefreshAt === undefined || !Number.isFinite(lastManualRefreshAt)) { return true; }
	const elapsed = now - lastManualRefreshAt;
	// A clock jump backwards must not pin the cooldown open forever.
	return elapsed < 0 || elapsed >= cooldownMs;
}

/** Budget for one cache's record set. Both limits are upper bounds; whichever bites first wins. */
export interface RecordBudget {
	/** Maximum number of records kept. */
	maxRecords: number;
	/** Approximate maximum serialized size of the kept records, in bytes. */
	maxBytes: number;
}

/**
 * Apply a record budget, keeping the most recently updated records and dropping the rest.
 *
 * Dropping a record is always safe *as long as the caller still lists the entity*: the next pass
 * finds it missing from the cache and refetches it. It is never used to make a total look complete
 * — an incomplete listing keeps its records instead (see the two cache modules' reconcilers).
 *
 * Guarantees: at most `maxRecords` are kept (so `maxRecords: 0` keeps none). When `maxRecords > 0`
 * and there is at least one input record, the single most recent record is kept even if it alone
 * exceeds `maxBytes` — the byte budget only trims *after* the first record — so one oversized
 * record cannot empty the cache.
 *
 * @param rank Sort key for a record; higher is kept first (callers pass the parsed `updated_at`).
 * @param sizeOf What to measure against the byte budget. Defaults to the record itself, which is
 *   right when the caller budgets exactly what it persists. A caller that budgets a *wrapper* (to
 *   carry a grouping key alongside the record) must pass the payload instead, or every entry is
 *   charged for bookkeeping that never reaches the file and eviction bites earlier than the
 *   budget advertises.
 */
export function applyRecordBudget<T>(
	records: readonly T[],
	budget: RecordBudget,
	rank: (record: T) => number,
	sizeOf: (record: T) => number = approximateRecordBytes,
): { kept: T[]; evicted: number } {
	// Normalize the rank: this helper is generic, and a caller whose `rank()` returns NaN would
	// otherwise make the comparator non-transitive and eviction order non-deterministic.
	const rankOf = (record: T): number => {
		const value = rank(record);
		return Number.isFinite(value) ? value : 0;
	};
	const ordered = [...records].sort((a, b) => rankOf(b) - rankOf(a));
	const withinCount = ordered.slice(0, Math.max(0, budget.maxRecords));
	const kept: T[] = [];
	let bytes = 0;
	for (const record of withinCount) {
		const size = sizeOf(record);
		if (kept.length > 0 && bytes + size > budget.maxBytes) { break; }
		kept.push(record);
		bytes += size;
	}
	return { kept, evicted: records.length - kept.length };
}

/** Serialized size of one record, used by the byte budget. Unserializable records count as 0. */
export function approximateRecordBytes(record: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8');
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// File helpers (the only impure part of this module)
// ---------------------------------------------------------------------------

/** Every GitHub-activity snapshot file in `dir`, with the scope segment each belongs to. */
export async function listGitHubActivityCacheFiles(dir: string): Promise<{ name: string; scope: string }[]> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return []; // globalStorage missing or unreadable — nothing cached yet.
	}
	const files: { name: string; scope: string }[] = [];
	for (const name of entries) {
		const match = GITHUB_ACTIVITY_CACHE_FILE_PATTERN.exec(name);
		if (match) { files.push({ name, scope: match[2] }); }
	}
	return files;
}

/**
 * Delete GitHub-activity snapshot files. With `scope` set only that identity's files go (explicit
 * sign-out); without it every scope's do (Clear Cache). Neither signs the user out — the files are
 * pure caches, so the next refresh simply refetches. Best-effort: a file another window is holding
 * is skipped rather than failing the whole clear.
 *
 * @returns how many files were actually removed.
 */
export async function deleteGitHubActivityCacheFiles(dir: string, scope?: string): Promise<number> {
	const files = await listGitHubActivityCacheFiles(dir);
	let removed = 0;
	for (const file of files) {
		if (scope !== undefined && file.scope !== scope) { continue; }
		try {
			await fs.promises.unlink(path.join(dir, file.name));
			removed++;
		} catch { /* already gone or locked by another window — skip */ }
	}
	return removed;
}

/**
 * Drop whole cache scopes that are not the active one, keeping the `keepScopes` most recently
 * written of them. Inactive scopes are evicted before anything inside the active scope is, so a
 * long-lived install that has seen several accounts or hosts does not grow without bound while the
 * account actually in use keeps its data.
 *
 * @returns how many files were removed.
 */
export async function evictInactiveGitHubActivityScopes(
	dir: string,
	activeScope: string,
	keepScopes = 2,
): Promise<number> {
	const files = await listGitHubActivityCacheFiles(dir);
	const newestByScope = new Map<string, number>();
	for (const file of files) {
		if (file.scope === activeScope) { continue; }
		let mtime = 0;
		try { mtime = (await fs.promises.stat(path.join(dir, file.name))).mtimeMs; }
		catch { continue; }
		newestByScope.set(file.scope, Math.max(newestByScope.get(file.scope) ?? 0, mtime));
	}
	const doomed = new Set(
		[...newestByScope.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(Math.max(0, keepScopes))
			.map(([scope]) => scope),
	);
	let removed = 0;
	for (const file of files) {
		if (!doomed.has(file.scope)) { continue; }
		try {
			await fs.promises.unlink(path.join(dir, file.name));
			removed++;
		} catch { /* already gone or locked by another window — skip */ }
	}
	return removed;
}
