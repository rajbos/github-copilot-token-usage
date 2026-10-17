# GitHub activity cache

The Usage Analysis view has two tabs whose data comes from the GitHub API rather than from local
session logs: **Repository PRs** and **Cloud Agent**. Both are served from a cache in the
extension's global storage so opening a tab is instant and costs no API calls. This document is the
reference for how that cache behaves — what it keeps, who can read it, when it refreshes, and what
it does when it cannot get a complete answer.

Source: `vscode-extension/src/githubActivityCache.ts` (shared policy),
`vscode-extension/src/repoPrCache.ts` (Repository PRs),
`vscode-extension/src/agentTasksCache.ts` (Cloud Agent).

## What is cached, per entity

Before, each cache held only the aggregate snapshot the panel renders, so every refresh after the
TTL expired paid for everything again — including relisting and re-detailing up to 200 cloud-agent
tasks that had not changed. Both caches now also keep a **per-entity record**:

| Cache | Keyed by | Record holds |
|---|---|---|
| Repository PRs | normalized `owner/repo` + PR number | title, URL, `created_at`, exact `updated_at`, open/closed state, merged flag, author login, author and requested-reviewer AI attribution |
| Cloud Agent | `owner/repo` + task ID (`agentTaskCacheKey`) | exact `updated_at`, repository attribution, which listing surfaced it, the pre-aggregated cloud-session totals, and the detail-fetch success/retry state |

Titles are kept for Repository PRs only because the existing AI-detail list displays them.
Deliberately **not** stored anywhere: access tokens, PR bodies or diffs, task prompts, task
titles/descriptions, and session transcripts.

### `updated_at` is the correctness contract

A cached record is reused **only** when the entity's `updated_at`, parsed and canonicalized, matches
the authoritative listing exactly. A record loaded from disk must also *describe itself*: a
cloud-agent record whose key is not `agentTaskCacheKey(repoKey, id)` is discarded rather than
allowed to answer for the task whose key it happens to occupy, and totals that would be added to a
row (session counts, credits) must be non-negative numbers of the expected type — malformed local
data causes a refetch, never a wrong number on screen. Anything that changes a PR or a task moves that timestamp, so a
reused record cannot be showing a superseded state. An entity whose `updated_at` is missing or
unparseable is treated as **uncacheable**: it is counted in the current pass but never enters the
cache, so it is recomputed every time rather than reused on a timestamp that cannot be verified.

The cloud-agent task key includes the repository, so a task that moves repositories (or that only
gets attributed once a bare `repository.id` resolves) lands on a different key — its old aggregate
can never be folded into the wrong repository's row.

If billable cloud-agent session data could ever change *without* moving `updated_at`, exact cache
freshness would be impossible. The unit tests in `test/unit/agentSessionsService.test.ts` pin this
contract; treat a failure there as a signal that the assumption no longer holds, not as a flaky test.

## Scope: one identity's data never serves another's

Cache filenames carry a scope segment built from three things
(`buildGitHubActivityScope`):

1. the VS Code mode (`dev` / `prod`, from the cache manager);
2. the normalized GitHub host — `github.com` and a configured `github-enterprise.uri` host are
   different scopes;
3. a **non-reversible SHA-256 hash** of the authenticated account label, truncated to 16 hex
   characters. The login itself is never written to disk or into a filename.

An Enterprise host slug carries a short hash of the exact host alongside the readable part, because
slugging alone is lossy: `ghe.internal.example` and `ghe-internal.example` would otherwise share a
scope, and one host's private snapshots could be served for the other.

The `api.` and `www.` prefixes are treated as aliases **only** for `github.com` and for a GitHub
Enterprise Cloud tenant's documented `api.<tenant>.ghe.com` API host. A self-hosted Enterprise
Server keeps its hostname exactly as configured — nothing says `api.acme.example` and `acme.example`
are the same machine, and folding them together would be the same leak the hash prevents.

So `repoprs_prod.github-com.1a2b3c4d5e6f7a8b.snapshot.json`. Signing out, switching accounts or
repointing the Enterprise host lands on a different file rather than re-serving the previous
identity's private data. Access tokens are never part of the scope and are never stored.

## Retention, bounds and eviction

The caches are local-only conveniences that are always allowed to lose data — an evicted record is
simply refetched. They are bounded three ways:

- **Window pruning.** Only entities in the current 30-day window's listing are kept, after a
  successful reconciliation (see below).
- **Record and byte budgets.** `REPO_PR_RECORD_BUDGET` and `AGENT_TASK_RECORD_BUDGET` cap how many
  records and roughly how many bytes each cache stores. The least recently updated (PRs) or least
  recently seen (tasks) records go first.
- **Inactive-scope-first eviction.** On activation, cache files belonging to accounts/hosts this
  install is not currently signed in as are dropped before anything in the active scope is.

Eviction only ever causes a safe refetch. It can never make an incomplete result look complete,
because the totals on screen are built from the current listing, not from whatever survived
eviction.

## Refresh: hourly TTL, one window, plus a manual refresh

A served snapshot describes the 30-day window as it stood when the snapshot was taken, so at the
window's trailing edge it can still count an entity that has since aged out — by at most the age of
the snapshot, which the banner states. Invalidating on window drift instead is not an option: the
window start moves forward continuously, so any tolerance shorter than the TTL would throw the cache
away on almost every read.

- Each cache is revalidated **at most once an hour**
  (`REPO_PRS_REFRESH_INTERVAL_MS` / `AGENT_TASKS_REFRESH_INTERVAL_MS`), by whichever VS Code window
  wins that cache's file lock. Other windows read the snapshot that window wrote. A heartbeat keeps
  the lock alive so a slow API pass is never mistaken for a stale lock. The freshness check runs
  again **after** the lock is acquired: the window that waited may have been waiting on exactly the
  refresh it was about to duplicate. That re-check requires the snapshot to be *usable*, not just
  recent — a v2 cloud-agent envelope has a perfectly fresh `fetchedAt` and no task records, and
  standing down on it would make **Refresh now** refuse the very v3 rebuild the migration needs.
  A window that stands down this way **publishes the leader's snapshot** before returning: it is
  already holding the fresh data, so staying on its own older copy until the tab is loaded again
  would be a self-inflicted staleness.
- Opening a tab serves the cached snapshot immediately (stale-while-revalidate) and then asks for a
  refresh, which only happens if the snapshot is actually due.
- The freshness banner on both tabs offers **Refresh now** — including on the error state, which is
  exactly when a retry is wanted. It bypasses the hourly TTL but still respects the cross-window
  lock and a short cooldown (`GITHUB_ACTIVITY_MANUAL_REFRESH_COOLDOWN_MS`), so repeated clicking
  cannot spend the rate limit. The cooldown is enforced twice: per window in memory, and — once the
  lock is held — against the snapshot's own `fetchedAt`, which is what makes it reach across
  windows that cannot see each other's clicks.

A refresh is incremental: the authoritative listing still runs (it is the only way to discover new,
changed, removed, archived and moved entities), but per-entity work is only redone for entities that
are new, changed, uncacheable, or whose previous detail fetch failed. For the Cloud Agent tab that
is the expensive half — the detail budget is now spent on recently invalidated work instead of on
everything.

## Partial results are never silently presented as totals

Reconciliation may delete a cached record **only after a listing that is known to have enumerated
fully**. A page cap, a timeout or an error is not authoritative: the record is retained, and the
result is marked partial.

| Situation | Effect |
|---|---|
| Listing completed | Records not in the listing are removed; totals are complete |
| Listing hit its page cap (5 pages) | Records retained for the cache; repo/tab marked partial (lower bound) |
| Listing errored or timed out | Pages collected before the failure are still counted; records retained; per-repo error shown; tab marked partial |
| Cloud-agent detail budget exhausted | Undetailed tasks stay "owed"; tab marked partial |
| Cloud-agent detail call failed | No aggregate stored for that task — a failure is never remembered as zero usage; the task's row and the tab are marked partial; retried next pass, with its consecutive-failure count |
| A listing or detail response arrived without its array | Treated as an error, not as an empty result. A 200 carrying no `tasks` array would otherwise read as an authoritative empty page — enough for reconciliation to delete every cached task and publish a confident zero — and one carrying no `sessions` array would be cached as a successful zero-usage aggregate. An empty answer says so explicitly, as `{ tasks: [] }` or `{ sessions: [] }` |
| The same task appears in both the active and archived listings with different `updated_at` values | Counted once (the first sighting keeps the row), but treated as uncacheable — one of the two listings has already reported it changed |
| Two workspace repositories both list the same task | The first repository keeps the row (deduplicating by task ID is what stops one task being counted twice), but the disagreement makes the task uncacheable for that pass, exactly as a workspace-vs-account disagreement does |
| Both listings disagree about a task's repository or its `updated_at` | The repo-scoped listing wins the row attribution, but the task is treated as uncacheable for that pass. A repository disagreement would let a stale aggregate land on the wrong row; a timestamp disagreement means the other listing has already seen the task change, so reusing the cached state would break the `updated_at` contract |
| A repo's listing errored after collecting some pages | The counts it did collect are shown, with the error noted beside them. A row is blanked to an error-only line only when the listing produced nothing — the banner already calls the figures a lower bound, so hiding them would contradict it |

**Retained records are cached, not counted.** A record kept only because the listing was incomplete
stays in the cache so the next pass can reuse it, but it is deliberately left out of the numbers on
screen: it might name a PR that has since been deleted, and counting it would turn the advertised
lower bound into a possible overcount. A retained record whose PR has aged out of the 30-day window
is dropped outright rather than carried forward.

The banner states which of these applies: *not fetched yet*, *updated N ago / next refresh at …*,
*revalidating* (TTL passed, showing the cached snapshot), and an explicit **partial data — the
figures below are a lower bound** line with the reason.

## Clearing and sign-out

- **Clear Cache** (`aiEngineeringFluency.clearCache`) removes every scope's Repository PRs and Cloud
  Agent cache files, the in-memory snapshots and the freshness state. It never signs the user out.
- **Sign out from GitHub** additionally purges the signing-out identity's scope specifically, so
  nothing can serve that account's data afterwards. A session revoked *outside* the extension goes
  through the same purge — it is the same event from the user's side, and clearing only memory
  would leave that account's files to be served again the moment anyone signs back into it.

Both also drop this window's in-memory snapshots *and* the retained webview-replay messages, so
recreating the Usage Analysis panel cannot repopulate it from data that was just discarded. The
cleanup covers the `*.snapshot.json.<pid>.tmp` files an interrupted atomic write can leave behind,
which hold a complete envelope.

An open panel is cleared too, not just the host's copies. The Usage Analysis view is created with
`retainContextWhenHidden`, so it keeps its own rendered rows across a discard — dropping only the
host state would leave the previous identity's repository names and counts on screen, which is the
leak the scoping exists to prevent, one layer up. Every discard therefore pushes an empty,
never-fetched snapshot to the panel; because it carries no `fetchedAt`, the panel also re-arms its
lazy loader so the tab asks for the new identity's data instead of considering itself loaded.

Neither touches the session-parsing caches' lock files or another window's coordination state.

Both invalidate **before** deleting. A refresh already past its pre-write guard could otherwise
rename its snapshot back into place between the unlink and the generation bump — and then pass its
post-write guard too — so a clear that reported success would leave the file on disk.

One known limit, and it is a real one: **invalidation is window-local.** The generation counter that
makes a discard stick lives in the window that ran it. Another window that already holds an
in-memory snapshot keeps showing it until its next revalidation; and a window that is
*mid-collection* when the discard happens still considers its own scope and generation valid, so
its atomic write can recreate a file that Clear Cache or a sign-out just removed. Closing that properly needs a shared on-disk tombstone (or equivalent cross-window
coordination) that a writer checks immediately before its rename — a design addition with its own
races, deliberately left out of the change that introduced per-entity caching. Until then, a second
Clear Cache removes anything a racing window resurrected.

Within a single window, a refresh that is *mid-write* when a discard lands is caught on the other
side too: the scope and generation are re-checked **after** the awaited write, and the file the
atomic rename just recreated is removed rather than published. Checking only before the write would let the rename put
back a file that Clear Cache had already deleted.

### Identity changes mid-flight

The in-memory snapshots are tagged with the scope they were collected under. Switching account or
Enterprise host discards them rather than publishing the previous identity's repository names and
counts to the new session. Repointing `github-enterprise.uri` discards them too: it changes which
identity's data the caches describe exactly as an account switch does, but it arrives as a setting
change rather than an auth event, so the configuration listener has to catch it. Identity
transitions are queued, because VS Code fires each session-change handler independently — without a
queue, a purge resuming after a later sign-in would clear the *new* account's state.

The snapshot *read* on each serve path is scoped from the session that
call just resolved, never from the extension's `githubSession` field — that field lags an account
switch until the auth listener catches up, and reading through it would serve the previous
identity's file. The guard that decides whether a pass is still current compares against the
recorded in-flight scope for the same reason: recomputing it from the lagging field would discard
the *new* account's own valid work and strand it on the empty state. A collection pass that spans a sign-out, a switch or a Clear Cache has
its result discarded instead of written — otherwise it would recreate a deliberately deleted file
under an identity that is no longer signed in.

## A shared snapshot, per workspace

The snapshot is scoped by mode, host and account — deliberately not by workspace — so every window
signed in as the same account shares one file. Its *contents*, though, come from the repositories
the writing window discovered. A window with a different workspace therefore replaces the rows the
previous writer collected, and each window's repos reappear only when that window next refreshes.

This predates per-entity caching (the snapshot has always been one shared file) and is left as is:
making the cache workspace-aware means either a file per workspace set, which multiplies the API
cost the cache exists to avoid, or merging foreign rows into a snapshot whose completeness this
window cannot vouch for. Neither belongs in the change that adds per-entity records.

## Migration

The Cloud Agent cache schema went from **v2 to v3** when per-task records were added. A v2 snapshot
held aggregate totals only, and per-task records cannot be recovered from an aggregate — attributing
it back to individual tasks would be invention, not migration. A v2 file is therefore ignored and
rebuilt by the next background refresh, exactly as a first-ever run does: one full (already
budgeted) pass, then incremental passes afterwards.

The Repository PRs cache did **not** need a version bump: its rendered payload is unchanged and the
per-PR records are purely additive, so a snapshot *at the new path* keeps rendering while it has no
records and simply gains them on the next revalidation.

Both caches do, however, get a **one-time invalidation from the scoping change itself**. Snapshots
written before this change live at the unscoped `repoprs_prod.snapshot.json` /
`agenttasks_prod.snapshot.json`; the new path carries the account and host, so the legacy file is
never read. That is deliberate — an unscoped file cannot be shown to belong to the account now
signed in, and serving it would be exactly the cross-identity leak the scoping exists to prevent.
The cost is one refetch per install; the legacy files are then reclaimed by inactive-scope eviction.

Note that the two GitHub-activity **locks** are scoped the same way as the snapshots they protect.
A mode-only lock would let a window signed in as one account block a window signed in as another
from refreshing its own, independent snapshot.

## Related

- [CLOUD-AGENT-COST.md](CLOUD-AGENT-COST.md) — what the Cloud Agent tab measures and where the
  numbers come from.
- [../VALIDATION.md](../VALIDATION.md) — the checks to run after touching this code.
