---
name: deduplicate-code
description: Detect copy-pasted code blocks across the shared source (vscode-extension/src, the repo-root src/, cli/src) with the dependency-free check-code-duplication.js detector, then pick one duplicate group and extract a shared helper to eliminate it, keeping all tests green. Use when a PR review notes duplication, when the CI step summary's "Code Duplication Analysis" grows, or when asked to reduce code duplication / DRY up the codebase.
---
# Deduplicate Code

The CI step summary runs `check-code-duplication.js` and reports copy-pasted
blocks across the three TypeScript source trees every PR. A growing "Code
Duplication Analysis" section (or a review finding of "this is duplicated")
is the signal this skill remediates: it finds the duplicate groups, picks
**one**, extracts a single shared helper in their place, and verifies nothing
broke. Like `refactor-large-function`, it changes **one** group per pass so the
diff stays reviewable and a regression points at a single extraction.

## What the detector does

`scripts/check-code-duplication.js` (run as `npm run check:duplicates` from
`vscode-extension/`) normalizes source lines (whitespace collapsed, comment-only
and blank lines dropped so re-indented or re-commented copies are still caught),
hashes sliding windows of a minimum length, groups identical windows, and
extends each group to its **maximal shared block**. It reports clone groups as
Markdown (for the step summary) or `--json`. It is **report-only by default**;
this skill does the remediation the report asks for.

A "duplicate group" is a normalized sequence of >= `--min-lines` lines that
occurs in two or more places (cross-file, or non-overlapping within one file).

## Step 1 - List the duplicate groups

Get the current clone groups in machine-readable form so you can pick a target:

```bash
node scripts/check-code-duplication.js --json --min-lines 14
```

Or, scoped to one area if the full scan is large:

```bash
node scripts/check-code-duplication.js --json --min-lines 14 --include 'src/**/*.ts'
```

Read the `groups` array: each entry has `lines` (maximal block length),
`occurrences` (`{ file, startLine, endLine }`), and a `preview` (first 3 lines).
Pick the single group to remediate following these priorities:

1. **Skip auto-generated or intentionally-mirrored files.** The shared editor
   adapters under `src/adapters/*.ts` and the per-editor CLI store modules
   (`src/kilo.ts`, `src/opencode.ts`, `src/copilotCliStore.ts`, `src/devinCli.ts`,
   `src/hermes.ts`) deliberately mirror each other's SQLite/stat helpers because
   each editor's session layout differs. A pure structural clone between two of
   these is usually NOT a safe extraction \u2014 only consolidate when the *exact*
   same logic (not just the same shape) is being copied.
2. Prefer groups where every occurrence is genuinely identical *behavior* (same
   inputs, same outputs, same side effects) \u2014 those extract cleanly.
3. Among those, prefer groups with the **most occurrences** (one helper replaces
   many copies) and the **most lines** (biggest payoff), all else equal.
4. Prefer files that already have unit tests (check `vscode-extension/test/unit/`
   for a matching test file) so the extraction is covered.

## Step 2 - Read the instructions file

Before touching code, read the relevant sub-project instructions file for the
area you are changing \u2014 `.github/instructions/vscode-extension.instructions.md`
for `vscode-extension/` work, `.github/instructions/cli.instructions.md` for
`cli/`, and the root `AGENTS.md` for shared `src/` (notably the "CLI Must Reuse
Shared Functions" rule: never reimplement session parsing or cost attribution
in a place the shared module already covers).

## Step 3 - Understand the duplicate

Open every occurrence the detector reported and read the full block plus a few
lines of surrounding context. Confirm it is a true behavioral duplicate and not
two blocks that merely *look* the same but read different inputs or have
different error handling. If the occurrences are only structurally similar
(condemn both, then act), **stop and pick a different group** \u2014 forcing a
shared helper onto divergent logic is the failure mode this skill exists to
avoid.

Decide where the extracted helper lives:

- **Same file, used by two places in that file** \u2192 a private helper (`_`
  prefix) at the top of the file, like `refactor-large-function`.
- **Same package, multiple files** \u2192 a private helper in the most natural
  existing module of that package (do not create a new file just to host the
  helper unless it is independently reusable \u2014 keep new files to a minimum).
- **Cross-package (e.g. shared `src/` and `vscode-extension/src`)** \u2192 the
  helper must live in the shared `src/` module and be *imported* by the consumer,
  never copied. This is the canonical split documented in `AGENTS.md`.

## Step 4 - Run the baseline tests

Establish a green baseline before changing anything:

```bash
cd vscode-extension
npm ci --ignore-scripts
node_modules/.bin/tsc --noEmit        # type-check
npm run test:node                     # unit tests
```

Record which tests cover the target files so you know what to watch.

## Step 5 - Extract the shared helper

Apply the extraction. Rules:

- The public/exported API must not change \u2014 only internal structure changes.
- The helper takes the *differences* between the occurrences as parameters
  (the parts that were not actually identical) and encapsulates the *common*
  logic. If the occurrences have no meaningful differences, the helper has no
  parameters beyond the data it operates on.
- Name the helper for what it does, not where it was copied from.
- Use a leading `_` prefix for private helpers in the same file.
- Return `null` (not `undefined`) from a helper to signal an unrecoverable
  error or "nothing to do"; the caller guards with an early `if (!result)`.
- Do not add comments unless the code is genuinely non-obvious after extraction.
- Replace **every** occurrence the detector reported for the chosen group with
  a call to the helper \u2014 leaving one copy behind defeats the point and the
  detector will still flag the group on the next run.

## Step 6 - Lint the changed files

```bash
cd vscode-extension && node_modules/.bin/eslint src ../src <changed-files>
```

All **new** warnings introduced by your changes must be resolved before
proceeding. Pre-existing warnings on other functions in the same files are
acceptable \u2014 do not fix unrelated code.

## Step 7 - Re-run the detector on the changed files

Confirm the chosen group is gone and you did not introduce a new one:

```bash
node scripts/check-code-duplication.js --json --min-lines 14
```

The group you remediated must no longer appear. If a *new* group appeared
because your helper is itself now duplicated, that means the helper was placed
in the wrong module \u2014 move it to the shared location and import it instead
of copying.

## Step 8 - Run the full test suite and build

```bash
cd vscode-extension
node_modules/.bin/tsc --noEmit        # type-check
npm run test:node                     # unit tests
node esbuild.js --production          # production bundle
```

All tests must pass and the build must succeed. If a test fails, fix the
extraction \u2014 do not modify the tests unless the test itself was wrong
before your change.

## Step 9 - Commit

```
refactor: extract shared helper to eliminate duplicate block in <area>

<Which group was chosen, where the helper lives, and how many copies it
replaced. Note that the duplication detector no longer flags the group.>
```

## Step 10 - Open a PR

Open a pull request to `main`. The PR description should:

- Lead with the motivation (duplication detector flagged the group, or a review
  noted the copy-paste).
- List the occurrences that were consolidated (file:line for each) and the
  single helper that replaced them.
- Confirm `check-code-duplication.js` no longer reports the group, all unit
  tests pass, and the production build succeeds.
- Note any pre-existing warnings that were not introduced by this change.

## Constraints

- Remediate **one** duplicate group per pass \u2014 a second group is a separate
  PR. This keeps the diff reviewable and a regression attributable.
- Do not consolidate editor adapter / per-editor store modules that are
  intentionally mirrored (see Step 1) unless the logic is behaviorally identical.
- Do not change any exported function signatures or public class method
  signatures.
- Do not create a new file solely to host the helper unless it is independently
  reusable across packages.
- Do not fix pre-existing ESLint warnings on unrelated code.
- If `tsc` or unit tests fail after your change, revert and choose a different
  extraction (or a different group) rather than patching around the failure.

## Related files

- `scripts/check-code-duplication.js` \u2014 the detector this skill drives.
- `vscode-extension/package.json` \u2014 `npm run check:duplicates` script.
- `.github/workflows/ci.yml` \u2014 the CI step that publishes the "Code
  Duplication Analysis" report to the step summary.
- `.github/skills/refactor-large-function/SKILL.md` \u2014 the companion skill
  for functions that are too long rather than duplicated.
- `.github/instructions/vscode-extension.instructions.md`,
  `.github/instructions/cli.instructions.md`, `AGENTS.md` \u2014 the area rules
  to read before editing (notably the shared-`src/` reuse contract).
