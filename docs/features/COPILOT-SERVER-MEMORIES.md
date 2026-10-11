# Copilot Server-Side Repository Memories

Status: **Implemented** — shared fetch/analysis module, CLI `memory-files --server`
/ `--promote`, and a Tools-tab UI section are live.

Companion to [COPILOT-MEMORY-FILES-INSIGHT.md](COPILOT-MEMORY-FILES-INSIGHT.md),
which covers the *local* half of Copilot's memory. This document covers the other
half: the per-repository store GitHub keeps server-side for the Copilot coding
agent.

## The two kinds of Copilot memory

|  | Local memory files | Server repository memories |
|---|---|---|
| Where | `workspaceStorage/<hash>/…/memory-tool/memories/*.md` on this machine | GitHub, per repository |
| Who sees them | Only this machine | Everyone working on the repository |
| Written by | Copilot Chat's memory-tool | The coding agent's `store_memory` tool (on this repository, every memory observed so far came from `copilot-code-review`) |
| UI | None built in | Repository **Settings → Copilot → Memory** (preview) |
| What we report | Metadata only — file content is deliberately never read | The content: fact text, citations, and what to do about them |

The metadata-only rule from the local feature does **not** carry over. A server
memory *is* content — the API returns the fact, its citations and the agent's
reasoning, and there is nothing else to report. Nothing is uploaded anywhere; the
store is read for the signed-in user and analyzed in process.

## API contract

There is no public documentation for these routes. The contract below was taken
from the shipped Copilot CLI bundle (`~/.copilot/pkg/universal/<version>/index.js`),
which is their authoritative consumer, and verified against live repositories.

```
GET {base}/agents/swe/internal/memory/v0/{owner}/{repo}/enabled
    -> 200 { "enabled": boolean }
GET {base}/agents/swe/internal/memory/v0/{owner}/{repo}/recent?limit=N
    -> 200 ServerMemory[], or 204 No Content when the repository has none
PUT {base}/agents/swe/internal/memory/v0/{owner}/{repo}
    -> stores one memory
```

`{base}` is always `https://api.githubcopilot.com` in what ships here. The Copilot CLI
additionally derives it from a configured agent endpoint with a trailing `/agent`
stripped; this feature deliberately does not, and is public-GitHub only at both ends —
the remote parser accepts only github.com repositories and the token lookup is pinned to
that host. `fetchRepoMemories()` takes an `apiBase` override, but it exists for tests and
has no user-facing setting or CLI option behind it.

**The PUT is deliberately not implemented.** This repository only ever *reports* on
a memory store, so no code path of ours can write to one.

### Two requirements that fail silently

Both of these make a healthy store look empty, which is why they are asserted in
`copilotServerMemories.test.ts` rather than left as comments:

- **The scheme must be `Bearer`.** A plain GitHub OAuth token works, but the
  `token` scheme that `gh api` sends is rejected with 401 — as is `gh api`'s
  automatic `X-GitHub-Api-Version` header, which these routes answer with
  `400 invalid apiVersion`.
- **`Copilot-Integration-Id` must name a recognized integration.** An unrecognized
  id returns `403 memory is disabled for this client`, which reads like a
  repository setting but is not. `vscode-chat` is rejected; `copilot-developer-cli`
  (the Copilot CLI's own id, and the one we send), `copilot-cli`,
  `copilot-coding-agent` and `vscode` all work.

### Response shape

```json
{
  "id": "392bef7b-466b-432f-ad8c-a418ab11831b",
  "subject": "What's New catalog",
  "fact": "Version bumps must prepend a current-version entry in WHATS_NEW_RELEASES…",
  "citations": ["vscode-extension/src/whatsNew/catalog.ts:16-35", "…"],
  "reason": "This convention governs release-prep changes and prevents…",
  "scope": "repository",
  "source": {
    "interactionId": "call_bZ99zY3hMAoXXj3lFMwlHiTl",
    "agent": "copilot-code-review",
    "baseModel": "gpt-5.6-luna"
  },
  "billingOrganizationId": 217613454,
  "billingEnterpriseId": 3518
}
```

Two things follow from this shape:

- **There are no timestamps.** The server returns "recent" in its own usefulness
  ranking (the web UI calls it "Ranked by usefulness"), so memories cannot be aged
  locally the way local memory files can. Only their *citations* can be checked
  for staleness — which is what we do.
- **`source` has no `integrationId`**, even though the CLI's write payload sends
  one. The API is in preview and has already drifted from its own client, so the
  type requires only `id`/`subject`/`fact`/`citations`, unknown fields ride along,
  and malformed records are dropped rather than failing the read.

The CLI asks for `limit=20` because that is all it wants to paste into a prompt.
We ask for 500; the server caps the response itself (this repository returned 340
for both `limit=500` and `limit=1000`) and there is no pagination cursor.

The API also returns more than the settings page shows — a repository whose UI
read "32 memories" returned 35 — consistent with the UI's note that memories
Copilot has learned not to use are hidden from the list.

## Why we analyze rather than just list

Reading the whole store is what the GitHub settings page is for. What this feature
adds is the part that page cannot show.

A live store is not a tidy set of facts. On this repository it held **340 memories
across 191 subjects**, in which:

- the same graphify-setup fact appeared **14 times** in slightly different wordings;
- **99** memories cited `AGENTS.md` or another instruction file — the agent paying,
  repeatedly, to re-learn something it had already been told;
- **11** cited files that no longer exist, 4 of them with no surviving source at all.

That repetition is the signal. **A fact the agent keeps rediscovering from code is
a fact that belongs in a checked-in customization file** (`AGENTS.md`,
`.github/copilot-instructions.md`, `.github/instructions/*`), where every agent
reads it for free on every run.

So `analyzeServerMemories()` groups memories by normalized subject, keeps only
groups where *no* member cites an instruction file, and ranks them by how many
times the same thing has been re-learned. Repeat count is also the only ranking
available, given the API returns no timestamps.

`renderPromotionMarkdown()` turns the top groups into a Markdown block. It is
produced as text for a human to edit and commit, never written into an instruction
file directly by this tool: these facts are an agent's unverified observations —
some of this repository's cited files are already gone — and an instruction file is
the one place where a wrong statement is read by every agent on every run.

The VS Code section's **Ask Copilot** button is the softer version of the same
thing. It *drafts* a Copilot Chat prompt (agent mode, not submitted) built by the
shared `buildPromotionPrompt()`: it quotes the fact as an unverified claim, lists
the citations and the target file, and asks Copilot to verify the fact against the
cited files **before** adding a concise entry, and not to commit. The person reads
the prompt before sending it and reviews the resulting diff, so nothing reaches an
instruction file without a human in the loop. Every server-supplied field is
flattened to one line, so memory text cannot add steps of its own to the prompt.
Citations are listed live-first (`orderCitationsLiveFirst()`): the existing regular
files that made the group promotable come before `User input:` or deleted ones, so
the five-citation cap can never hide the only verifiable source.

The button sends the group's subject key and a fingerprint of the row it was
rendered from (subject, fact, citations — `promotionGroupFingerprint()`) as
`draftServerMemoryPromotion`; never prompt text. Renders do no filesystem checks:
they show the cached analysis, which a throttled background re-check refreshes at
most once a minute (see below). The click handler is therefore the authorization
step: it rebuilds the prompt from the cached analysis and synchronously re-checks
the target file and the group's live sources at that moment
(`buildPromotionPromptForSubject()`). It drafts nothing, and says why, when there
is no safe target any more, the group's last source is gone, or the current
group's fingerprint no longer matches the clicked row (it then re-renders), so a
background refresh cannot swap what gets drafted. It likewise refuses when the workspace now resolves to a
different repository or checkout than the analysis was read for, and when the
group's last live source was deleted since the analysis (a targeted re-check of
just that group's cited files).

Only the network read is cached for the TTL. The extension re-derives everything
that depends on the checkout — eligibility, live citations, missing documentation
— from that raw read with `analyzeServerMemoriesForCheckoutAsync()`: the cited
paths are probed with asynchronous, yielding I/O (`probeCheckoutPathsAsync()`), so
a store of hundreds of memories never blocks the extension host
(`docs/adr/ANALYSIS-WORKER.md`, rule 1). That re-check runs in the background at
most once a minute and re-renders the section only when the result changed. The
CLI, which has no shared event loop, uses the synchronous
`analyzeServerMemoriesForCheckout()`; both produce the same analysis (tested).
Liveness is tracked per memory record rather than per id, since the store can
repeat an id.

The target file is chosen deterministically by `selectPromotionTarget()`: an
existing root `AGENTS.md`, else an existing `.github/copilot-instructions.md`, else
a new root `AGENTS.md`. Scoped `.github/instructions/*.instructions.md` files are
not matched yet — that needs `applyTo` glob parsing. Each candidate is checked by
its own probe, `createPromotionTargetProbe()`, not by the citation-staleness
callback: it reports `exists` (a regular file whose real path stays inside the
checkout), `absent` (nothing there, not even a dangling link) or `unsafe` (an
escaping or dangling symlink, a directory, or any inspection error other than
"not found"). When the file the rule would pick is `unsafe`, no target is offered,
the rows get no button, and the reports say `none — <path> is not a regular file
inside this checkout` instead of naming it (`promotionTargetBlockedPath`). When the
analyzed repository is not checked out here (CLI `--repo` elsewhere), the target is
reported as not checked.

A subject is a promotion group only if no member is documented and at least one
member cites a **regular file** that still exists inside the checkout
(`createRepoRegularFileCheck()`). So `User input:`-only memories, fully stale ones
(no cited file survives) and ones citing only directories never qualify, in the
extension or in `--promote`. When that leaves nothing, both surfaces print the same
explanation (`describeNoPromotionCandidates()`) with the documented / unverifiable /
fully stale breakdown, rather than claiming every memory is already documented.

## The Tools-tab section

- **Scope.** The section names the repository (`owner/name`) and the local checkout
  it was resolved from. The store is per GitHub repository, shared by everyone
  working on it, not per VS Code workspace — unlike the local Copilot Memory Files
  section. In a multi-root workspace only the first folder with a github.com
  `origin` is used, and the section says so.
- **Worth adding to AGENTS.md.** The top 10 promotion groups, each with an **Ask
  Copilot** button (see above).
- **Already documented.** The first 10 memories that cite an instruction or
  documentation file, with the file(s) they cite and an **Open file** button for
  files that resolve inside the checkout ("showing 10 of N" when there are more).
  A cited file that no longer exists (or is a directory) is marked **missing**: such a
  memory is not actually written down any more, so the hint says to keep it, and to check
  the cited file before deleting any memory.
  "Documented" follows `INSTRUCTION_PATH_PATTERN`, which also matches `docs/` and
  `.github/skills|agents/`. The stored copy is redundant only once you have confirmed
  that at least one cited file still exists and still states the fact; when every cited
  file is missing, or none says it any more, the memory may be the only remaining copy
  and should be kept. Deletion happens on GitHub (Settings → Copilot → Memory), since this
  repository deliberately implements no write route.

## Usage

```bash
# Local memory files plus this repository's server store
ai-engineering-fluency memory-files --server

# A Markdown block ready to paste into AGENTS.md
ai-engineering-fluency memory-files --promote

# Another repository, and machine-readable output
ai-engineering-fluency memory-files --server --repo owner/name --json
```

`--promote` and `--repo` both imply `--server`. Citation staleness is only checked
when the analyzed repository is the one checked out here — with `--repo` pointing
elsewhere the local tree says nothing about that repository's files, so every
citation would look missing.

There is also a standalone discovery probe,
`scripts/fetch-copilot-memories.js`, which prints the raw payload including any
fields the typed shape does not know about. Use it when the API changes.

## What's implemented

| Piece | Location |
|---|---|
| Fetch + analysis (shared) | `src/copilotServerMemories.ts` — `fetchRepoMemories()`, `analyzeServerMemories()`, `toServerMemoriesAnalysisView()`, `renderPromotionMarkdown()`, `selectPromotionTarget()`, `createPromotionTargetProbe()`, `createRepoRegularFileCheck()`, `describePromotionTarget()`, `describeNoPromotionCandidates()`, `buildPromotionPrompt()`, `parseRepoFromRemoteUrl()`, `isValidRepoSlug()`, `isSafeRepoRelativePath()` |
| Types | `src/types.ts` — `ServerMemory`, `ServerMemoryPromotionGroup`, `ServerMemoryStaleCitation`, `ServerMemoryDocumentedEntry`, `ServerMemoryPromotionTarget`, `ServerMemoriesAnalysis`, `ServerMemoriesAnalysisView` |
| Unit tests | `vscode-extension/test/unit/copilotServerMemories.test.ts` (offline — `fetch` and `fileExists` are both injected), `vscode-extension/test/unit/webview-serverMemoriesSection.test.ts` (section HTML and click mapping) |
| CLI | `cli/src/commands/memory-files.ts` — `--server`, `--repo`, `--limit`, `--promote` |
| Runtime wiring | `vscode-extension/src/extension.ts` — `scheduleServerMemoriesRefresh()`, `decideServerMemoriesRefresh()` (pure, exported), `buildServerMemoriesView()`, `resolveWorkspaceRepoSlug()`, `invalidateServerMemoriesCache()`, TTL `SERVER_MEMORIES_FETCH_TTL_MS` |
| Tools-tab UI | `vscode-extension/src/webview/usage/serverMemories.ts` — `buildServerMemoriesSectionHtml()`, `sanitizeServerMemoriesAnalysis()`, `wireServerMemoriesButtons()`, `#section-server-memories`. The buttons post `draftServerMemoryPromotion` (subject key and row fingerprint; the host rebuilds and drafts) and `openServerMemoryCitation` (a repo-relative path; the host opens it only if the current analysis cites it and it is a regular file inside the current checkout, `isOpenableCitedDocument()`). The webview never receives absolute paths. Both tables use the shared data-table component. Split out of `main.ts`, which would otherwise have crossed the 6000-line `max-lines` ceiling; `main.ts` imports both and holds the cross-refresh cache. |
| Raw probe | `scripts/fetch-copilot-memories.js` |
| Setting | `aiEngineeringFluency.serverMemories.enabled` (default `true`) |

### Host-side behaviour worth knowing

The fetch is **out of band**. The stats build is synchronous and must not wait on
a network call, so it renders whatever the last read produced and kicks off a
background refresh for the *next* render. A slow or unreachable GitHub therefore
cannot delay any other number on the view. The TTL is one hour — far longer than
the local scan's five minutes, because this costs a network round trip and a
memory store only changes when a coding-agent run stores something.

The feature is gated on **workspace trust**, matching
`ensureWorkspaceTrustedForGitAccess()`. Everything downstream is driven by a file
the checkout controls: `.git/config` names the repository, which decides what we
ask the Copilot API for with the user's token, and the citations that come back
decide which local paths get probed. Opening a hostile repository must not be
enough to start that, so an untrusted or virtual (non-`file`) workspace resolves
to no repository and the section simply does not appear. Unlike the hygiene
analysis this returns rather than throwing — that one is an explicit user action
deserving an explanation, while this runs on a background refresh.

Authentication is **silent-only**: `getSession(..., { silent: true })`. A user with
no existing GitHub session gets an empty section rather than a sign-in prompt for a
secondary insight. This is also the only part of the Usage Analysis view that
contacts the network, which is why it has its own opt-out setting.

The repository slug comes from `readGitOriginUrl()` in `src/darkFactorySignals.ts`
— a git-config file read rather than spawning `git remote get-url`, reusing the
helper that already exists for exactly this.
