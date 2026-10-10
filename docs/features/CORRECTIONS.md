# Corrections — detection of correction moments in sessions

The **Corrections** tab in the Usage Analysis view surfaces moments where a conversation had to be
corrected: either the **agent corrected itself after an error**, or the **user had to correct the
agent**. It is the first step towards correction-driven insights about where agents go wrong.

## What is detected

| Type | Source | Definition |
|---|---|---|
| `user-correction` | User message text | Heuristic patterns: "no, ...", "that's wrong", "not what I asked", "undo/revert", "why did you", "that didn't work", ... |
| `edit-retry` | Tool-call sequence | Repeat edit to a file whose immediately preceding tool call was an edit to the same file (same definition as model efficiency "retry") |
| `edit-self-correction` | Tool-call sequence | Repeat edit to a file already edited in the same turn, with other tool calls in between (same definition as model efficiency "self-correction") |
| `tool-error` | Tool result | A failed tool call (`success: false`); marked **retried** when the same tool is called again later in the session |
| `agent-self-correction` | Assistant response text | Heuristic patterns: "my mistake", "let me fix", "you're right", "that failed", apologies, ... — **only counted when corroborated** by a `tool-error`, `edit-retry`/`edit-self-correction` in the same turn, or a `user-correction` in this turn or the one before it (see `corroboratedBy`) |

The pattern-based detectors are **heuristics** — they produce candidates, not verdicts. The edit-based
detectors intentionally share their definitions with `src/modelEfficiency.ts` so counts stay comparable
with the model-efficiency counters.

`agent-self-correction` phrasing ("let me fix", "you're right", ...) is extremely common narration even
when nothing went wrong, so the bare phrase alone is not enough — it must be corroborated by an
independent failure signal nearby (see the table above). This cut a large share of false positives found
when the detector was run against real local sessions (see the "Precision notes" section below).

`user-correction` matching skips auto-injected editor/tool notifications (e.g. VS Code's
background-terminal "done" ping, which lands in the same `userMessage` field as a typed message but
isn't authored by the human) — see `isHumanAuthored` in `src/correctionDetection.ts`.

### Sentiment proxies

No supported editor's session logs carry an actual sentiment/feedback score (there is no "the user
rated this response" field anywhere), so two cheap proxies are layered on top of `user-correction`
instead:

- **`intensity: 'strong'`** — the message itself carries shouting (an ALL-CAPS word), repeated `!`/`?`,
  or an intensifier ("again", "seriously", "for the last time").
- **`escalated: true`** — this correction lands within `ESCALATION_WINDOW_TURNS` (4) turns of an earlier
  one in the same session, i.e. corrections are clustering rather than one-off. `CorrectionCounts.
  escalatedUserCorrections` and `CorrectionPeriodCounts.sessionsWithEscalations` aggregate this.

Both are heuristics, not a verdict on how the user feels — they exist because no real signal is
available, not as a replacement for one.

## Data flow

1. `src/correctionDetection.ts` (`detectCorrectionMoments`) — pure module, scans a session's turns
   (`CorrectionTurn[]`, satisfied by both `ChatTurn` and the extended `EfficiencyTurn`) and returns
   capped (`MAX_MOMENTS_PER_SESSION = 50`), snippet-truncated `CorrectionMoment[]`.
2. Detection rides the **existing per-session analysis passes** in `src/usageAnalysis.ts` — no extra
   parsing:
   - ecosystem adapters: moments are computed from the same `buildTurns()` output used for
     `modelEfficiency`;
   - Copilot Chat JSON / delta JSONL: `_applyJsonRequestsEfficiency` now carries user/assistant text
     into the efficiency turns;
   - Copilot CLI JSONL: `user.message` / `assistant.message` text is accumulated onto the efficiency
     turns, and `tool.execution_complete` with `success: false` marks the turn's tool call as failed.
3. Moments are cached per session in `SessionUsageAnalysis.correctionMoments` (inside the normal
   `SessionFileCache`; `CACHE_VERSION` 71). `mergeUsageAnalysis` folds per-session moments into
   period-level `UsageAnalysisPeriod.corrections` counters.
4. `CopilotTokenTracker.buildCorrectionReport()` regroups the already-parsed sessions **per
   repository** (`SessionFileCache.repository`), keeping each repo's **25 most recent sessions** with
   moments, and attaches the report to `UsageAnalysisStats.correctionReport`.
5. The Usage Analysis webview renders the report in the Corrections tab (moments show a 📈 badge when
   `escalated` and a 🔥 badge when `intensity: 'strong'`); the insights engine reads
   `last30Days.corrections` for three insights:
   - `corrections-user-pushback` (≥ 3 user corrections in 30 days) — suggests capturing conventions in
     `copilot-instructions.md` / `AGENTS.md`;
   - `corrections-tool-errors` (≥ 5 tool errors or ≥ 10 edit retries/self-corrections in 30 days) —
     points at recurring self-correction loops;
   - `corrections-user-escalation` (≥ 2 escalated corrections in 30 days) — corrections clustering
     within a session, the closest local proxy to "this conversation is going badly".

## Coverage and limitations

- `tool-error` moments require a format that records tool success/failure — currently the Copilot CLI
  JSONL path. Ecosystem adapters contribute the other four types.
- Sessions without per-turn detail (e.g. binary formats without a turn builder) produce no moments.
- Pattern-based matches can be false positives (e.g. "actually," starting a new request). Patterns
  live in `USER_CORRECTION_PATTERNS` / `AGENT_SELF_CORRECTION_PATTERNS` in `src/correctionDetection.ts` and
  are expected to be tuned as real reports are triaged.
- English-only: phrasing patterns and intensity intensifiers ("again", "seriously", ...) don't match
  corrections written in another language.

### Precision notes (from running detection against real local sessions)

Running the detector against real local VS Code Copilot Chat history surfaced two concrete false-positive
sources, both addressed above:

- `agent-self-correction` fired on completely routine task narration ("Let me fix this", "You're right")
  far more often than on an actual recovered mistake — this is why it now requires corroboration.
- Auto-injected editor notifications (e.g. a background-terminal "command finished" ping) landed in the
  same field as a typed user message and matched boilerplate phrasing (e.g. "...or kill_terminal to
  **stop** it.") as a `user-correction` — this is why those are now excluded before matching.

## Turning corrections into action: "Ask Copilot to fix this"

The Corrections tab and the `corrections-user-pushback` insight both let you go from "here's what
went wrong" to "here's a prompt that asks Copilot how to prevent it":

- Each repository section in the Corrections tab has a **🤖 Ask Copilot to fix this** button (plus a
  **📋 Copy prompt** fallback for pasting into a different workspace's chat than the one currently
  open). It builds a prompt naming the repository and listing up to `MAX_PROMPT_EXAMPLES` (5) of that
  repo's actual correction moments, then opens GitHub Copilot Chat with it via VS Code's
  `workbench.action.chat.open` command (same mechanism as the Repo Hygiene tab's "Ask Copilot to
  Improve").
- The `corrections-user-pushback` insight (Insights tab) has a matching secondary action, **🤖 Ask
  Copilot to Fix This**, which targets whichever repository currently has the most correction
  moments — the insight itself is aggregated across all repos, so it has no single repo to target on
  its own.
- Example selection (`selectCorrectionPromptExamples` in `src/correctionDetection.ts`) ranks
  escalated user-corrections highest, then "strong"-intensity ones, then any other user-correction,
  then everything else — the clearest first-hand signal of real friction, not just the most recent
  moments — with ties broken by recency (a repo's sessions are already ordered most-recent-first).
- The prompt (`buildCorrectionImprovementPrompt`) asks the assistant to propose changes grounded in
  the repository's actual instructions files (e.g. `.github/copilot-instructions.md`, `AGENTS.md`),
  custom instructions, and prompt/chat-mode files, rather than generic advice.
- This targets GitHub Copilot Chat in VS Code first; the generated prompt is plain text, so the
  "Copy prompt" fallback works with any assistant you paste it into.

## Privacy

Snippets are short excerpts (≤ ~240 chars) from the user's own local session logs, displayed only
locally in the webview and stored only in the local extension cache. Nothing is sent anywhere unless
you click "Ask Copilot to fix this" / "Ask Copilot to Fix This", which opens Copilot Chat with the
generated prompt — at that point the same session-log excerpts already shown in the tab are sent to
whichever model Copilot Chat is configured to use, the same as pasting them in yourself.

## Tests

- `src/test/correctionDetection.test.ts` — detection rules, counts, caps, and the
  improvement-prompt builder (example ranking, caps, prompt content).
- `vscode-extension/test/unit/insightsEngine.test.ts` — the three correction insights (thresholds)
  and the `corrections-user-pushback` secondary action command.
- `npm run check:contract` / `npm run check:interaction` — the "Ask Copilot to fix this" / "Copy
  prompt" buttons are plain webview controls, covered by the same message-contract and click-crawl
  checks as the rest of the Corrections tab (see [docs/VALIDATION.md](../VALIDATION.md)).
