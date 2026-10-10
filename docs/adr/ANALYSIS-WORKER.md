# Session analysis runs on worker threads, not the extension host

**Status:** implemented (VS Code extension). **Applies to:** `vscode-extension/src/analysis/`, `vscode-extension/src/utils/eventLoopMonitor.ts`.

## The problem

A click in a webview panel (navigating to another tab, opening a view) is a `postMessage` that
the extension host can only deliver **between event-loop ticks**. The host has exactly one thread,
and everything that refreshes data used to run on it. Any long synchronous stretch therefore showed
up as "navigation is blocked for tens of seconds".

Yielding with `setImmediate` between files (the earlier fixes, e.g. #2176) only helps when the
stretches are short. It cannot help when a single step is long, and it cannot be enforced: the next
synchronous `readdirSync` added anywhere reintroduces the freeze.

Measured on a real machine (6,876 session files, 687 in the last 30 days, a 9.8 GB Copilot CLI OTel
export), a cold full refresh blocked the host for:

| Cause | Longest single stall |
|---|---|
| Parsing large session files (`JSON.parse`, token estimation, usage analysis) on the host | 6–8 s per burst, tens of seconds in total |
| Recursive **synchronous** `readdir` over every workspace to find customization files | **~90 s** in one stretch (69 s of pure `readdir` self-time) |

After this change the same refresh blocks the host for **< 1 s** at worst, finishes faster, and the
host thread is idle ~90% of the time while it runs.

## The design

```
 extension host (one thread)            analysis worker threads (1–2)
 ───────────────────────────            ─────────────────────────────
 owns: VS Code API, webviews,     ──►   owns: reading files, JSON.parse,
 the cache (CacheManager), state        token estimation, usage analysis,
                                        daily rollups, directory walks
 sends: path + mtime/size               returns: a SessionFileCache entry,
        (+ a small skeleton)                    a details result, or a file list
```

* **`analysis/sessionFileAnalyzer.ts`, `sessionDetailsAnalyzer.ts`, `workspaceCustomizationScan.ts`** — the
  CPU-heavy work as plain, `vscode`-free functions over an explicit `SessionAnalyzerDeps`. The exact same code
  runs on a worker (normal) or in-process (fallback). They never touch the cache; they receive the previous
  entry as data and return the new one.
* **`analysis/analysisWorker.ts`** — the worker entry point, bundled to `dist/analysisWorker.js` by
  `esbuild.js`. It builds its own adapter registry. `vscode` is aliased to a stub that throws, so an accidental
  import of the VS Code API fails loudly instead of at load time.
* **`analysis/analysisWorkerPool.ts`** — the host-side client. Lazily spawns up to
  `max(1, min(2, cores − 1))` workers (so a single-core machine still gets one), keeps a pool-side queue, hands each worker at most two requests at a time, and
  treats workers as disposable.
* **`CopilotTokenTracker`** (`extension.ts`) calls the pool from `getSessionFileDataCached`,
  `getSessionFileDetails` and the customization-file resolver, and only does the cache write itself.

### Failure model

`AnalysisWorkerError.kind` decides what the caller may do:

| kind | meaning | host behaviour |
|---|---|---|
| `unavailable` | the worker could not be used (failed before `ready`, pool-wide restart budget spent, pool disposed) | fall back to the in-process analyzer (not once the extension is disposed) |
| `timeout` | the file hung a worker for 3 minutes (worker is killed and respawned) | reject — running it in-process would move the hang onto the host |
| `failed` | the analysis itself threw, or the request killed two workers | reject, **keeping `error.code`** (e.g. `ENOENT`) so existing handling still works |

A worker death re-sends its in-flight requests once on a fresh worker; a request that kills two workers is
rejected as `failed` (it is the likely cause — an out-of-memory kill or native crash — and must not be retried on the
host). When a request times out, its neighbours on that worker are re-sent without spending their own retry.

A request that timed out a worker, or killed two, is **quarantined** (keyed by file path, modified time and size) for the rest
of the session: later requests for that version of the file are rejected as `failed` — including once the restart budget is
spent and every other request falls back to the host. Without that, repeated deaths from a few dangerous files would disable
the pool and the next refresh would parse those same files on the host. A file that changes gets another chance. (If a hang
is blamed on the wrong request, see below, that request is skipped for the session too.)

Workers run their requests **concurrently** (they are mostly waiting on disk or on the host). A strictly in-order
worker was tried and reverted: one slow host lookup then froze every request queued behind it. The accepted cost is
that if a request genuinely hangs the thread while another is in flight, the older one can be the one blamed; the
other is re-sent and, if it is the culprit, times out on its own next.

The hang watchdog is paused while a worker is waiting on a **host lookup** (see below) and restarted with a full window
when the last one returns: waiting on the host is not a hung worker. Lookups are themselves bounded (20 seconds). More than five deaths in a minute
disables the pool for the session (with a warning) and everything runs in-process, as it did before this change.

### Why a queue and a small in-flight window

A worker can only parse serially. If twenty requests were posted to it and the per-request timeout started
at posting, a perfectly healthy but busy worker would be killed for "hanging" because its twentieth request
waited behind nineteen others. Requests wait in the pool instead, and the timeout starts when a request is
handed to a worker, where it only waits behind one neighbour.

### Concurrent views share one discovery pass

Finding the session files runs every adapter (25–95 s on a large history on a busy machine) and its result was
only cached when a pass *finished*. Every view opened meanwhile started its own full pass, all competing for the
same thread, so opening several views made each of them (and the refresh) slower. `SessionDiscovery` now lets
concurrent callers join the pass already running — replaying the batches it has produced so far, then streaming the
rest — and `clearCache()` detaches a running pass so an explicit refresh starts a fresh one.

### Serialized usage-analysis runs

`calculateUsageAnalysisStats` resets per-run caches (`_customizationFilesCache`, `_workspaceIdToFolderCache`) at its
start. Scans are now asynchronous, so there are awaits between filling and reading those caches; an overlapping run's
reset in that gap would leave the first run reading an empty cache (every workspace shown as having no customization
files). Runs are therefore serialized through a promise chain.

### Adapter caches inside workers

Each worker builds its own adapter registry, so adapter-internal caches (for example the in-memory SQLite copies)
exist once per worker and are not reachable from the host's `clearCache()`. They are keyed on file stat like their
host counterparts, so a changed file is re-read; a worker restart also drops them.

### Worker `execArgv`

Both `Worker` constructors pass `execArgv: []`. A worker otherwise inherits the host's node flags
(`--inspect`, `--require` hooks, ...), which are meant for that process; in testing, an inherited
`--require` hook with a 30 s self-exit silently killed every worker.

## Keeping it fixed

* **`startEventLoopMonitor`** (`utils/eventLoopMonitor.ts`) samples event-loop delay with Node's built-in
  histogram and logs `Extension host event loop stalled: worst tick N ms ...` to the *AI Engineering Fluency*
  output channel whenever a 2 s window contains a tick over 250 ms. If users report a freeze, this line says
  how long, and when.
* **`test/unit/analysisWorkerEquivalence.test.ts`** builds the real worker bundle and checks that
  (1) its output is identical to the in-process analyzer on the session fixtures, for the analyze, details and
  customization-scan operations, and (2) the host event loop stays free while the worker parses a 15 MB+
  session that takes the host over half a second in-process. Moving parsing back onto the host thread
  fails (2).
* **`test/unit/analysisWorkerPool.test.ts`** covers the pool's crash/timeout/queue/dispose behaviour
  deterministically with a fake worker.

### Rules for new code

1. **Do not add synchronous filesystem walks (`readdirSync`, `statSync` in loops, `execSync`) or large
   `JSON.parse` calls to code that runs during a refresh on the host.** Put the work in `src/analysis/` behind a
   new pool operation, or make it asynchronous *and* yielding.
2. Code in `src/analysis/` must stay free of `vscode`. It may import the shared modules in `src/`; check that a
   module you add does not use the VS Code API on the code path the worker runs.
3. A new pool operation needs: a request/response type in `analysisProtocol.ts`, a branch in
   `analysisWorker.ts`, a method on the pool, and an equivalence test against the in-process function.

## Switching it off

Set `AI_FLUENCY_DISABLE_ANALYSIS_WORKER=1` in the environment of the extension host to run everything
in-process (the previous behaviour). The extension also does this automatically if `dist/analysisWorker.js` is
missing.

## Not changed (and why)

* **Cache snapshot (`CacheManager`) read/merge/write.** It serializes the whole cache on the host. On the
  measured machine (23 MB, 6.7k entries) that is ~0.1 s to parse and ~0.2 s to stringify per checkpoint — not a
  user-visible stall — and moving it would mean reworking its clear-epoch race fences. Revisit if the cache
  grows by an order of magnitude; the lag monitor will show it.
* **The OTel index is built once, saved to disk, and announced.** `copilotCliOtel.ts` saves the consolidated index
  and each file's consumed offset (plus a hash of the file's first 4 KB, to notice a replaced file) to
  `globalStorage/copilot-cli-otel-index.json`; the next start restores it and reads only the appended tail instead of
  re-parsing the whole export. Consumers do not read or wait on it one by one: `onCopilotCliOtelIndexReady` /
  `whenCopilotCliOtelIndexReady` announce when it is built. A worker question (`otelIndexLookup.ts`) waits briefly for
  that, otherwise fails at once and remembers it; when the index is ready the host refreshes those sessions once.
* **The Copilot CLI OTel index is the host's; the session-store lookup is the worker's.** For a Copilot CLI
  session, exact usage comes from the `session-store.db` billing table first and from the OTel file export only
  when the table has no rows. The export is append-only and was 9.8 GB on the measured machine, and its index
  lives in module state, so each worker would build its own. Workers therefore install
  `setCopilotCliOtelUsageResolver` and ask the host for *that fallback only* (`otelUsage` / `otelUsageReply`);
  the database lookup — frequent, and the database is reloaded whenever the CLI writes to it — stays in the
  worker, so the host thread never parses that 85 MB database. The hook is unset everywhere else (CLI, tests, the
  host itself).

  Waiting on the host has its own rules, learned from a real run that sat at 9% for ten minutes:
  * A request parked on a host lookup **does not count against the worker's running window** (each holds its
    file in memory, so parked requests are bounded at 32 per worker). Otherwise a few sessions waiting for the
    index take every slot and freeze all the files that never needed it.
  * Its hang clock is paused for the wait, and restarts with a full window afterwards.
  * The wait is bounded (20 seconds, and the cooldown after a timeout ends as soon as the late lookup answers; replies that arrive together resume only as the worker has running capacity). Past it the request **fails** — the analysis code tolerates many errors
    and would otherwise cache a half-answered result as complete — and is retried on the next refresh. After a
    timeout further lookups fail at once for a minute, instead of each waiting out its own limit.
  * The pool logs `OTel usage lookup for … took Ns` for slow lookups, and `Analysis pool: no request has
    completed for Ns — …` (queued, running, parked on the host, longest-running request) when nothing finishes
    for 30 s. If a refresh looks stuck, that line says why.
* **Remaining per-worker memory.** Adapters that read other SQLite stores (for example Copilot's `data.db`, 127 MB
  on the measured machine) still hold one in-memory copy per worker, which is why the pool is capped at two
  workers rather than scaled to the core count.
* **Windsurf sessions** stay in-process: they come from a gRPC client that needs the VS Code API.
* **Small remaining host work** (path/editor-label classification per file, a few hundred ms of WAL merge for the
  Copilot CLI database) is each well under a second.
