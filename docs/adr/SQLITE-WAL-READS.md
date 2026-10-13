# Reading SQLite databases another process may hold open (WAL mode)

> **Status:** Implemented · **Decided/added:** 2026-09-07 · **Verified against code on:** 2026-10-11 (`src/utils/sqliteWal.ts` exists and is used by the readers listed below)

## Context

The extension reads several local SQLite databases it does not own:

- `~/.copilot/data.db` — the Copilot app's own database (session hierarchy,
  context-window state). Read via `CopilotAppDataAccess`
  (`vscode-extension/src/copilotAppData.ts`).
- OpenCode's `opencode.db`. Read via `OpenCodeDataAccess` (`src/opencode.ts`).
- Kilo Code's db. Read via `KiloDataAccess` (`src/kilo.ts`).
- Cursor's global `state.vscdb` — routinely **1-2 GB** on its own. Read via
  `CursorDataAccess` (`src/cursor.ts`).

Most of these were originally read with [`sql.js`](https://github.com/sql-js/sql.js),
a WASM build of SQLite that only understands a single in-memory buffer — it
has no code path for SQLite's write-ahead log. When the owning process (the
Copilot app, the OpenCode CLI, Kilo Code, or Cursor) keeps its database open
in **WAL mode**, its most recent writes are appended to a `<dbfile>-wal`
sidecar file and are only merged back into the main `.db` file when SQLite
performs a **checkpoint** — typically when every connection to the database
closes, or the WAL grows past a size threshold.

If we read just the `.db` file's bytes while a WAL exists, `sql.js` returns a
**silently stale snapshot**: no error, just missing the writer's most recent
rows/columns. This exact gap caused the "Context Window & Long-Context
Pricing" usage section to show "No data" for an actively-running Copilot CLI
session — its `context_current_tokens` update was sitting in `data.db-wal`
and only became visible after the session was restarted (closing the writer's
connection triggered a checkpoint).

You can confirm a database is in this state by checking for a non-empty
`<dbfile>-wal` next to it:

```powershell
Get-ChildItem "$env:USERPROFILE\.copilot\data.db*"
```

The naive fix — copy `<dbfile>` + `<dbfile>-wal` and checkpoint the copy — is
itself what caused #2033: on every read of Cursor's `state.vscdb` (queried on
a multi-second polling loop), the extension copied the *entire* 1-2 GB file
to `%temp%`, repeatedly, filling the user's disk. A read strategy for these
databases has to bound that cost, not just correctness against staleness.

## Decision

Two backends now exist, and which one applies depends on whether the caller
can use `node:sqlite` directly:

### Preferred: copy-free read-only `node:sqlite` (`src/cursor.ts`)

When `node:sqlite` (Node.js 22+) is available, open `dbPath` directly with
`new DatabaseSync(dbPath, { readOnly: true })`. This sees another process's
pending WAL frames live, cross-process, with **zero copies** and no size cap
— it never touches the main db or the WAL file. `CursorDataAccess` opens,
queries and closes this connection per call (never holds it open, since a
long-lived reader can block the writer's own checkpointing) and demotes a db
path to the fallback below only temporarily after a failed open (a cooldown,
not a permanent flag — a transient failure like `SQLITE_BUSY` during the
writer's own checkpoint must not strand a db on the copy-based fallback for
the rest of the process's life).

**This is the backend new callers should prefer** for any db another process
may hold open in WAL mode, especially a database that can be large — it is
the only option that is both cheap and current regardless of size.

### Fallback: copy + checkpoint via `src/utils/sqliteWal.ts`

For callers/environments that can't use `node:sqlite` directly (sql.js-based
readers, or a db path currently demoted after a read-only failure):

- `readDbBufferWithWal(dbPath): Promise<Buffer>` — copies `<dbfile>`,
  `<dbfile>-wal`, and `<dbfile>-shm` (if present) to a temp file under
  `~/.copilot/tmp`, opens the copy with `node:sqlite`, runs
  `PRAGMA wal_checkpoint(TRUNCATE)` to fold the WAL into the temp file, and
  returns that buffer for `sql.js` to load. Falls back to a bare
  `fs.readFileSync(dbPath)` when there is no WAL, the WAL is empty, the
  combined db+WAL size is over the cap below, or `node:sqlite` is
  unavailable.
- `readDbBufferWithWalFingerprint(dbPath): Promise<WalReadResult>` — same
  read, but always returns the db+WAL fingerprint (mtime + size of each) the
  returned bytes actually reflect. **Callers with their own db cache must use
  this, not `readDbBufferWithWal` + a fresh `getWalMtimeMs(dbPath)` call
  afterwards** — see "Caching and the fingerprint contract" below.
- `getWalMtimeMs(dbPath)` — a plain, un-cached "what is the WAL's mtime right
  now" stat, still useful for a caller's own *current-state* checks (e.g.
  "has anything changed since I last looked") that are independent of what a
  particular read returned.

This fallback is hardened against exactly the failure mode #2033 hit:

- **Size cap** (`MAX_WAL_MERGE_DB_SIZE_BYTES`, 256 MB): `tryReadDbWithWal`
  refuses to copy when `<dbfile>` + `<dbfile>-wal` **combined** exceed this
  budget (not the main db alone — the WAL is copied in full too, so a small
  db with a multi-GB WAL would otherwise defeat the cap). Above the cap, the
  fallback returns a **WAL-blind, potentially stale** plain read instead —
  this is the deliberate trade #2033 requires (never copy multi-GB files
  repeatedly), but it means a database routinely over the cap, like Cursor's
  `state.vscdb`, gets stale reads on this path. That is the practical reason
  Cursor uses the read-only `node:sqlite` backend above instead of this
  fallback as its primary path — it has no size cap because it never copies
  anything. The first time a path is skipped for being over the cap, this is
  logged once (`console.debug`, not on every poll) so the staleness is
  discoverable rather than silent; the log fires again if the path later
  becomes eligible and then exceeds the cap again.
- **Per-path throttle**: repeated merge attempts for the same `dbPath` are
  served from an in-memory cache of the last result instead of re-copying,
  for `WAL_MERGE_MIN_INTERVAL_MS` (1 minute) normally, backing off to
  `WAL_MERGE_WRITER_ACTIVE_INTERVAL_MS` (5 minutes) while `isWalWriterActive`
  detects the WAL being touched recently (a running writer touches its WAL
  constantly, and re-merging at the plain rate against that would negate the
  throttle). A throttled buffer is only reused while the **main** `.db`
  file's own mtime/size still match what produced it — a checkpoint or
  wholesale replacement of the main file during the throttle window forces a
  fresh merge rather than silently serving bytes that predate it. The WAL's
  own mtime is deliberately *not* part of that reuse decision (reacting to
  every WAL touch is what the throttle exists to prevent).
- **Failed-attempt throttling**: a merge that fails (`node:sqlite`
  unavailable, or the copy/checkpoint itself errors) is also recorded and
  throttled, not retried on every single call — otherwise the throttle does
  nothing for the expensive, repeatedly-failing case, which is exactly where
  it matters most. A last-good buffer, if one exists, is still preferred over
  returning nothing.
- **Cache eviction**: a path that goes ineligible (WAL gone, emptied, or now
  over the cap) has its retained buffer dropped immediately rather than held
  for the rest of the retention window; every path's cache entry is also
  dropped once nothing can serve it any more (past
  `WAL_MERGE_CACHE_RETENTION_MS`), so merged buffers — up to the cap each —
  aren't retained for the life of the process.
- **Temp-file sweep** (`sweepStaleWalTempFiles`, run once at activation):
  reclaims `cursor-wal-*` / `sqlite-wal-*` (+ `-wal`/`-shm` siblings) left
  behind in `os.tmpdir()` or `~/.copilot/tmp` by earlier extension versions
  or an interrupted merge.

### Caching and the fingerprint contract

A throttled read can return bytes **older than "now"** — that is the whole
point of the throttle. A caller that keys its own db cache on a *fresh* stat
taken after the read (e.g. `getWalMtimeMs(dbPath)` called again once the
buffer comes back) ends up stamping a stale buffer with a fingerprint that
claims to be current. If the writer then goes quiet, nothing ever notices the
mismatch again — the cache reads as valid forever, and the real write is
hidden permanently, not just delayed.

The fix is for the helper to report the state the returned bytes *actually*
correspond to, and for callers to key their cache on that instead of
re-statting: `readDbBufferWithWalFingerprint`'s `WalReadResult` carries the
main db's mtime/size and the `-wal`'s mtime/size **as they were when those
bytes were produced** — the buffer's original fingerprint for a
cache-served/throttled read, or the current stat for a fresh merge or a plain
direct read. `OpenCodeDataAccess` and `KiloDataAccess` store this returned
`walMtimeMs` in their own db cache entries rather than calling
`getWalMtimeMs(dbPath)` again after the fact; `CursorDataAccess`'s composer
cache does the same for its sql.js-fallback reads (its read-only `node:sqlite`
reads are live, so no such fingerprint is needed for those).

`readDbBufferWithWal(dbPath): Promise<Buffer>` keeps its original signature
and behavior for callers that don't need the fingerprint (e.g.
`vscode-extension/src/copilotAppData.ts`) — the fingerprint-returning
function is an addition, not a breaking change.

## Consequences

- Prefer the copy-free read-only `node:sqlite` backend (open `dbPath`
  directly with `{ readOnly: true }`) for any new integration reading a local
  SQLite database another process may still be writing to — it is both
  cheaper and more current than the copy-based fallback, and has no size cap.
- Where that isn't available, read through `readDbBufferWithWal()` /
  `readDbBufferWithWalFingerprint()` rather than `fs.readFileSync()`
  directly.
- A db whose `.db` + `-wal` combined size is routinely over
  `MAX_WAL_MERGE_DB_SIZE_BYTES` will get stale, WAL-blind reads on the
  copy-based fallback — by design, to avoid repeatedly copying huge files.
  Don't rely on that fallback path for a database this large; use the
  read-only backend instead.
- Any caller that keeps its own cache of a WAL-mode db (keyed on file
  identity) must key it on the fingerprint `readDbBufferWithWalFingerprint`
  returns, not on a fresh `getWalMtimeMs(dbPath)` call taken after the read —
  see "Caching and the fingerprint contract" above. Getting this wrong
  doesn't cause a wrong read today; it causes a *permanently* stale cache
  once the writer goes quiet.
- The merge does a real file copy + `node:sqlite` open per attempt, so it is
  not free even with the throttle — callers that poll frequently should keep
  doing so through a stat-based cache rather than calling
  `readDbBufferWithWal`/`readDbBufferWithWalFingerprint` on every call.
- If `node:sqlite` is ever removed/unavailable in the extension's Node
  runtime, both backends degrade: the read-only backend is simply
  unavailable (callers fall back to the copy-based path), and the copy-based
  fallback itself degrades to a direct file read (the original,
  potentially-stale behavior) rather than throwing.
