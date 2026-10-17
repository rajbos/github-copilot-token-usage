---
name: ai-fluency
description: Show the user's AI Engineering Fluency stats (token usage, cost, sessions, charts, fluency score) in the AI Engineering Fluency canvas. Use when the user asks about their AI or Copilot token usage, spend, recent sessions, or fluency score.
---

# AI Engineering Fluency canvas

The `ai-fluency-canvas` plugin provides a canvas with `canvasId` `ai-fluency`.

- To show the stats, open it: `open_canvas({ canvasId: "ai-fluency", instanceId: "ai-fluency" })`.
- To answer questions in chat, open the canvas as above, then call
  `invoke_canvas_action({ instanceId: "ai-fluency", actionName: "get_summary" })`.
  It returns the cached snapshot's aggregate numbers and never runs the CLI.
- Only pass `{ "topSessions": 1-25 }` when the user asks about specific sessions: it adds session titles (often the
  user's first prompt) and project names to the result.
- To update the numbers, call the `refresh` action. It returns once the refresh has begun (`started: false` means
  another Copilot session is already refreshing and its result is used) and fails at once if it can't start. A run
  takes several minutes; pass `{ "wait": true }` only when the user wants to wait for fresh numbers.
- If `get_summary` returns `available: false`, no snapshot exists yet: tell the user the first run
  parses all local session logs and takes a few minutes, then start a `refresh`.

The canvas reads local session logs and uploads nothing itself, but whatever `get_summary` returns becomes part of
this conversation and is sent to the model.
