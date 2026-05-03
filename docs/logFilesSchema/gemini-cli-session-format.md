---
title: Gemini CLI Session Format
created: 2026-05-03
updated: 2026-05-03
status: research
type: format-analysis
tags: [gemini-cli, jsonl, session-logs, schema]
---

# Gemini CLI Session Format (Observed on Windows)

## TL;DR

The observed Gemini CLI session format is rich enough for the tracker to support:

- session discovery and session list views
- chat turn reconstruction
- actual token totals per assistant turn
- model usage and cache-read breakdown
- tool call timelines

The logs contain **real token counts**, not estimates. No explicit cost field was observed, so cost would need to be derived from model pricing.

## Why this document exists

TokTrack's current Gemini parser expects a single JSON document at:

```text
~/.gemini/tmp/*/chats/session-*.json
```

On this Windows machine, Gemini CLI wrote:

```text
%USERPROFILE%\.gemini\tmp\<project>\chats\session-*.jsonl
```

That difference matters. A parser that only looks for `session-*.json` will miss the real sessions that were observed here.

## Observed files

| File | Purpose | Notes |
|------|---------|-------|
| `%USERPROFILE%\.gemini\tmp\<project>\chats\session-*.jsonl` | Full session event stream | Primary source of truth |
| `%USERPROFILE%\.gemini\logs.json` | Lightweight message index | Useful for quick session/message discovery |
| `%USERPROFILE%\.gemini\projects.json` | Workspace to project-bucket mapping | Helps map session folders back to repo paths |
| `%USERPROFILE%\.gemini\state.json` | UI state | Not useful for token tracking |

Observed session path:

```text
C:\Users\RobBos\.gemini\tmp\actions-marketplace-checks\chats\session-2026-05-03T15-01-ee37b453.jsonl
```

## High-level structure

The session file is newline-delimited JSON. Different lines represent different record shapes.

### 1. Session header

```json
{
  "sessionId": "ee37b453-387e-441c-8558-8ec2da287ed4",
  "projectHash": "<hash>",
  "startTime": "2026-05-03T15:01:21.339Z",
  "lastUpdated": "2026-05-03T15:01:21.339Z",
  "kind": "main"
}
```

### 2. User turn

```json
{
  "id": "<message-id>",
  "timestamp": "2026-05-03T15:01:31.511Z",
  "type": "user",
  "content": [
    { "text": "<user prompt>" }
  ]
}
```

### 3. Session update marker

```json
{
  "$set": {
    "lastUpdated": "2026-05-03T15:01:31.512Z"
  }
}
```

### 4. Gemini assistant turn

```json
{
  "id": "<message-id>",
  "timestamp": "2026-05-03T15:01:34.141Z",
  "type": "gemini",
  "content": "",
  "thoughts": [],
  "tokens": {
    "input": 11410,
    "output": 105,
    "cached": 0,
    "thoughts": 65,
    "tool": 0,
    "total": 11580
  },
  "model": "gemini-3-flash-preview"
}
```

### 5. Gemini assistant turn with tool calls

Later lines may repeat the same assistant `id` and add tool call details:

```json
{
  "id": "<same-message-id>",
  "timestamp": "2026-05-03T15:01:34.141Z",
  "type": "gemini",
  "content": "",
  "thoughts": [],
  "tokens": { "...": "..." },
  "model": "gemini-3-flash-preview",
  "toolCalls": [
    {
      "id": "<tool-call-id>",
      "name": "read_file",
      "args": { "...": "..." },
      "result": [ { "functionResponse": { "...": "..." } } ],
      "status": "success",
      "timestamp": "2026-05-03T15:01:44.057Z",
      "resultDisplay": "...",
      "description": "...",
      "displayName": "ReadFile",
      "renderOutputAsMarkdown": true
    }
  ]
}
```

## Field inventory

### Session metadata

The header gives enough data to build a session list:

- `sessionId`
- `projectHash`
- `startTime`
- `lastUpdated`
- `kind`

### User turns

User records contain:

- `id`
- `timestamp`
- `type: "user"`
- `content[]`
- `content[].text`

This is enough to render the user side of the conversation.

### Assistant turns

Gemini assistant records contain:

- `id`
- `timestamp`
- `type: "gemini"`
- `content`
- `thoughts[]`
- `tokens`
- `model`
- `toolCalls[]` on later updates

### Thoughts

Observed `thoughts[]` items contain:

- `subject`
- `description`
- `timestamp`

This gives us a separate "thinking" timeline if we want to show it.

### Token object

Observed `tokens` fields:

- `input`
- `output`
- `cached`
- `thoughts`
- `tool`
- `total`

These are **actual token counts from Gemini CLI**, not character-based estimates.

### Tool calls

Observed `toolCalls[]` fields:

- `id`
- `name`
- `args`
- `result`
- `status`
- `timestamp`
- `resultDisplay`
- `description`
- `displayName`
- `renderOutputAsMarkdown`

This is enough to reconstruct a tool timeline similar to the existing log viewers for other ecosystems.

## Observed session summary

The following numbers were extracted from the real session JSONL and compared with the Gemini CLI exit summary shown in the terminal UI.

| Metric | Observed value |
|--------|----------------|
| Session ID | `ee37b453-387e-441c-8558-8ec2da287ed4` |
| Project bucket | `actions-marketplace-checks` |
| Model | `gemini-3-flash-preview` |
| Session line count | `54` |
| Unique user messages | `2` |
| Unique Gemini message IDs | `17` |
| Duplicate Gemini updates | `15` |
| `$set` update records | `19` |
| First timestamp | `2026-05-03T15:01:21Z` |
| Last timestamp | `2026-05-03T15:05:22Z` |
| Input tokens | `430,224` |
| Cache reads | `305,900` |
| Output tokens | `2,452` |
| Thought tokens | `3,438` |
| Tool tokens | `0` |
| Total tokens | `436,114` |

### Session UI summary from Gemini CLI itself

The Gemini CLI exit screen for the same session reported:

- `Tool Calls: 22`
- `Success Rate: 100.0%`
- `Reqs: 28`
- `Input Tokens: 430,224`
- `Cache Reads: 305,900`
- `Output Tokens: 2,452`

The token totals matched the JSONL exactly.

## Token semantics

The observed token math suggests:

```text
total = input + output + thoughts + tool
```

In the observed session:

```text
430,224 input
+  2,452 output
+  3,438 thoughts
+      0 tool
= 436,114 total
```

`cached` is **not additive** on top of `input`. It appears to be a breakdown of cached prompt reuse within the input side, which matches the Gemini CLI terminal summary showing "Input Tokens" and "Cache Reads" as separate columns.

## Can we show sessions and chat turns?

Yes.

### Session list

We have enough for a session list from:

- the file path
- the header record (`sessionId`, `startTime`, `lastUpdated`, `kind`)
- `projects.json` for mapping normalized repo paths to project buckets
- `logs.json` as a lightweight secondary index

### Turn reconstruction

We can reconstruct turns by:

1. reading the JSONL line-by-line
2. treating `type: "user"` records as user turns
3. treating `type: "gemini"` records as assistant turns
4. **deduping assistant turns by `id` and keeping the latest record**
5. sorting the surviving turns by `timestamp`

That dedupe step is required because Gemini rewrites assistant turns. In the observed session there were `17` unique assistant IDs but `32` raw `type: "gemini"` lines.

### Content coverage

The logs contain enough information to render:

- user message text
- assistant message text when `content` is non-empty
- thoughts as a separate expandable section
- tool calls and tool results
- per-turn token counts

Important nuance: many intermediate assistant records had `content: ""` but still carried useful `thoughts`, `toolCalls`, and `tokens`. A Gemini log viewer should therefore not treat empty `content` as an empty turn.

### Lightweight index file

`logs.json` observed on disk:

```json
[
  {
    "sessionId": "ee37b453-387e-441c-8558-8ec2da287ed4",
    "messageId": 0,
    "type": "user",
    "message": "<user prompt>",
    "timestamp": "2026-05-03T15:01:31.496Z"
  }
]
```

This file is useful for quick discovery, but the JSONL session file should remain the source of truth for turn rendering and token accounting.

## Tool call observations

Observed named tool calls included:

- `read_file`
- `list_directory`
- `glob`
- `grep_search`
- `run_shell_command`
- `update_topic`

Two observed tool call entries had an empty `name`. Because of that, a naive sum of `toolCalls[]` entries from the deduped JSONL exceeded the Gemini CLI exit summary (`24` vs `22`). A production parser should therefore:

1. inspect unnamed tool call entries before counting them
2. consider filtering blank-name placeholders
3. prefer explicit tool status fields over raw array length when the UI summary disagrees

## Parsing guidance for the tracker

If we add Gemini CLI support, the parser should:

1. Discover session files at `~/.gemini/tmp/*/chats/session-*.jsonl`
2. Parse them as JSONL, not as a single JSON document
3. Use the first header line for session metadata
4. Count `type: "user"` entries for interaction/session-turn metrics
5. Upsert `type: "gemini"` records by `id`, keeping the latest line
6. Use `tokens.*` as actual token counts
7. Treat `tokens.cached` as an input breakdown, not a separate additive total
8. Derive cost from pricing data, because no cost field was observed
9. Use `logs.json` only as an optional discovery/index helper
10. Preserve `thoughts[]` and `toolCalls[]` for detailed session viewers

## Implications for this repo

This observed format is already good enough to support:

- token tracking without estimation
- per-model rollups
- session lists
- turn-by-turn chat views
- tool call breakdowns

The main implementation risk is not missing data. The main risk is **correct upsert/dedupe behavior** for assistant turns that are rewritten across multiple lines.

## Current conclusion

**Yes, the Gemini CLI session logs on this machine contain token data and enough structure to show chat sessions and turns.**

The tracker should target the observed JSONL format, not TokTrack's current `session-*.json` assumption.
