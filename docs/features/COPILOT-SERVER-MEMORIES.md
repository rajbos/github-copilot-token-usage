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
file directly: these facts are an agent's unverified observations — some of this
repository's cited files are already gone — and an instruction file is the one
place where a wrong statement is read by every agent on every run.

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
| Fetch + analysis (shared) | `src/copilotServerMemories.ts` — `fetchRepoMemories()`, `analyzeServerMemories()`, `toServerMemoriesAnalysisView()`, `renderPromotionMarkdown()`, `parseRepoFromRemoteUrl()`, `isValidRepoSlug()`, `isSafeRepoRelativePath()` |
| Types | `src/types.ts` — `ServerMemory`, `ServerMemoryPromotionGroup`, `ServerMemoryStaleCitation`, `ServerMemoriesAnalysis`, `ServerMemoriesAnalysisView` |
| Unit tests | `vscode-extension/test/unit/copilotServerMemories.test.ts` (offline — `fetch` and `fileExists` are both injected) |
| CLI | `cli/src/commands/memory-files.ts` — `--server`, `--repo`, `--limit`, `--promote` |
| Runtime wiring | `vscode-extension/src/extension.ts` — `scheduleServerMemoriesRefresh()`, `decideServerMemoriesRefresh()` (pure, exported), `buildServerMemoriesView()`, `resolveWorkspaceRepoSlug()`, `invalidateServerMemoriesCache()`, TTL `SERVER_MEMORIES_FETCH_TTL_MS` |
| Tools-tab UI | `vscode-extension/src/webview/usage/serverMemories.ts` — `buildServerMemoriesSectionHtml()`, `sanitizeServerMemoriesAnalysis()`, `#section-server-memories`. Split out of `main.ts`, which would otherwise have crossed the 6000-line `max-lines` ceiling; `main.ts` imports both and holds the cross-refresh cache. |
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
