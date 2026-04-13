---
description: "Download the latest mutation testing artifact, analyze surviving mutants against the codebase, and add targeted tests to kill mutants where it genuinely improves test quality."
name: "Improve Mutation Score"
tools: ["execute/runInTerminal", "execute/getTerminalOutput", "read/terminalLastCommand", "search/codebase", "read/problems", "execute/testFailure"]
---

# Improve Mutation Score Agent

Analyzes the latest Stryker mutation report and adds targeted tests to kill surviving mutants — but **only where the test adds real value**, not to chase a score.

---

## Step 1 — Download the latest mutation report artifact

Use the GitHub CLI to find and download the most recent `mutation-report` artifact from CI:

```bash
# List recent runs that produced a mutation-report artifact
gh run list --workflow=ci.yml --limit=10 --json databaseId,displayTitle,conclusion,createdAt

# Download the artifact from the most recent successful run
gh run download <run-id> --name mutation-report --dir /tmp/mutation-report
```

The artifact contains:
- `mutation.json` — full machine-readable report (this is what we analyze)
- `report.html` — human-readable HTML report

If the CI artifact is unavailable, run Stryker locally instead:
```bash
cd vscode-extension
npm run compile-tests
npx stryker run
# Report is written to: vscode-extension/reports/mutation/mutation.json
```

---

## Step 2 — Parse the mutation report

Read `/tmp/mutation-report/mutation.json` (or `vscode-extension/reports/mutation/mutation.json`).

The structure is:
```json
{
  "mutationScore": null,   // may be null — compute from counts instead
  "files": {
    "out/src/tokenEstimation.js": {
      "mutants": [
        {
          "id": "1",
          "mutatorName": "StringLiteral",
          "replacement": "\"\"",
          "location": { "start": { "line": 12, "column": 4 }, "end": { "line": 12, "column": 20 } },
          "status": "Survived",   // Survived | Killed | Timeout | NoCoverage
          "description": "Replaced \"some string\" with \"\""
        }
      ]
    }
  }
}
```

Extract all mutants with `"status": "Survived"`, grouped by source file. Compute the score as:
`killed / (killed + survived + timedOut) * 100`

---

## Step 3 — Map surviving mutants back to TypeScript source

The report references compiled JS files (e.g. `out/src/tokenEstimation.js`). Map these to their TypeScript equivalents:

| Compiled path | TypeScript source |
|---|---|
| `out/src/tokenEstimation.js` | `vscode-extension/src/tokenEstimation.ts` |
| `out/src/sessionParser.js` | `vscode-extension/src/sessionParser.ts` |
| `out/src/workspaceHelpers.js` | `vscode-extension/src/workspaceHelpers.ts` |
| `out/src/claudecode.js` | `vscode-extension/src/claudecode.ts` |
| `out/src/utils/dayKeys.js` | `vscode-extension/src/utils/dayKeys.ts` |
| `out/src/utils/errors.js` | `vscode-extension/src/utils/errors.ts` |
| `out/src/utils/html.js` | `vscode-extension/src/utils/html.ts` |

Read the TypeScript source at the reported line numbers to understand what was mutated.

---

## Step 4 — Triage surviving mutants

For each surviving mutant, classify it as one of:

### ✅ Worth killing — add a test
The mutant reveals a real gap: a code path that is exercised but whose output is never verified.

Examples:
- A boundary condition (off-by-one in a date key, threshold check) that has no assertion
- A string template or formatting function where the exact output is never compared
- An early-return guard that is never triggered in tests
- A boolean condition that could be flipped without any test noticing

### ⚠️ Marginal — use judgment
- Defensive null checks on already-validated data (killing requires ugly test setup)
- Private implementation details with no observable effect from the public API

### 🚫 Not worth killing — skip
- **Equivalent mutants**: the mutation produces identical behavior (e.g. `>=` → `>` when the boundary value is never reachable)
- **Trivial string mutations** in logging/error messages where exact wording isn't tested
- **Timeout/infrastructure mutants**: the code is correct but the test environment is too slow
- Mutations in code paths that are intentionally untestable (VS Code API calls, file system I/O in extension.ts)

Document skipped mutants with a brief reason.

---

## Step 5 — Write targeted tests

For each mutant classified as worth killing:

1. Find the corresponding test file (see mapping below)
2. Add a focused test case that **directly exercises the mutated line** with an assertion that fails when the mutant is applied
3. Keep tests small and focused — one mutant per test case where possible

### Test file mapping

| Source file | Test file |
|---|---|
| `src/tokenEstimation.ts` | `test/unit/tokenEstimation.test.ts` |
| `src/sessionParser.ts` | `test/unit/sessionParser.test.ts` |
| `src/workspaceHelpers.ts` | `test/unit/workspaceHelpers.test.ts` |
| `src/claudecode.ts` | `test/unit/claudecode.test.ts` |
| `src/utils/dayKeys.ts` | `test/unit/utils-dayKeys.test.ts` |
| `src/utils/errors.ts` | `test/unit/utils-errors.test.ts` |
| `src/utils/html.ts` | `test/unit/utils-html.test.ts` |

### Writing effective mutation-killing tests

A good mutation-killing test:
- Calls the function with inputs that **hit the exact mutated branch**
- Has an **explicit assertion** on the return value or side effect
- Does NOT just add `assert.ok(true)` — that kills nothing

Bad example (won't kill `>` → `>=` mutant):
```ts
it('returns something for day keys', () => {
  const result = getDayKey(new Date());
  assert.ok(result); // too vague
});
```

Good example (kills the boundary mutant):
```ts
it('getDayKey returns YYYY-MM-DD format', () => {
  const result = getDayKey(new Date('2024-03-07T00:00:00Z'));
  assert.strictEqual(result, '2024-03-07');
});
```

---

## Step 6 — Validate

After adding tests:

```bash
cd vscode-extension
npm run test:node
```

All tests must pass. Then optionally re-run Stryker on the affected files to confirm the new tests actually kill the targeted mutants:

```bash
npx stryker run
```

Compare the new score to the baseline.

---

## Step 7 — Commit

Stage only the test files (do not modify source files unless a real bug was found):

```bash
git add vscode-extension/test/unit/
git commit -m "test: add targeted tests to kill surviving mutants

Surviving mutants addressed:
- <file>: <mutator> at line <N> — <brief description>
- ...

Mutation score before: X%
Mutation score after:  Y% (estimated)"
```

---

## Guardrails

- **Do not add tests that mock the entire function under test** — they kill mutants trivially but provide no real coverage
- **Do not modify source files** to make mutants easier to kill (e.g. extracting magic strings into constants just to test them). Only fix the source if a genuine bug is revealed.
- **Do not add tests for equivalent mutants** — they will never be killed and are a waste of test suite time
- **Keep the test suite fast** — each test added here will run for every future mutant. Avoid heavy setup, filesystem I/O, or async chains unless the code under test requires it.
- **Prefer `assert.strictEqual` over `assert.ok`** — strict equality assertions kill far more mutants than truthy checks
