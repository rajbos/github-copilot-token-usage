---
description: 'Pick one large function flagged by ESLint max-lines-per-function and refactor it into smaller, focused helpers without breaking tests.'
tools: ['read_file', 'write_file', 'search_files', 'run_in_terminal']
---

# Refactor Large Function

An ESLint complexity or `max-lines-per-function` rule is producing warnings for functions that are too long. Pick **one** of those functions (not from `extension.ts`, which is intentionally monolithic) and refactor it into smaller, focused private helpers.

## Step 1 - Identify the target

Run ESLint with the complexity rules to get the current list of violations:

```bash
cd vscode-extension && node_modules/.bin/eslint src --rule '{"max-lines-per-function": ["warn", 80]}' --format stylish 2>&1 | grep "Lines/Fn\|max-lines-per-function" | head -20
```

Or, if the project already has the rule configured, just run:

```bash
cd vscode-extension && node_modules/.bin/eslint src 2>&1 | grep "max-lines-per-function\|Lines/Fn" | head -20
```

Choose **one** function to refactor, following these priorities:

1. Skip `src/extension.ts` - it is intentionally large and hard to test in isolation.
2. Prefer files that already have unit tests (check `test/unit/` for a matching test file).
3. Among the remaining candidates, pick the one with the clearest logical sections (wizard steps, processing phases, format branches, etc.) - those decompose most cleanly.

## Step 2 - Read the instructions file

Before touching any code, read the relevant sub-project instructions file. For `vscode-extension/` work, read `.github/instructions/vscode-extension.instructions.md`.

## Step 3 - Understand the function

Read the full function body and identify natural decomposition boundaries:

- **Wizard / multi-step UI flows**: each step becomes a private method returning `null` on cancellation.
- **Format dispatch** (e.g. JSONL vs JSON vs delta): each format branch becomes its own function.
- **Multi-phase processing**: setup / main loop / finalization each become their own function.
- **Complex sub-operations** inside a branch that push complexity above the threshold: extract them too.

Introduce small result interfaces or types at the top of the file (not exported) to carry data between steps cleanly, rather than long parameter lists.

## Step 4 - Run the baseline tests

Before changing anything, compile and run the existing unit tests to establish a green baseline:

```bash
cd vscode-extension
node_modules/.bin/tsc.cmd --noEmit          # type-check
pnpm run test:node                            # unit tests
```

Record which tests cover the target file so you know what to watch.

## Step 5 - Refactor

Apply the extraction. Rules:

- The public/exported API must not change - only internal structure changes.
- Each extracted helper should have a single clear responsibility, stated in its name.
- Private methods use a leading `_` prefix to signal they are internal helpers.
- Return `null` (not `undefined`) from a helper to signal user cancellation or an unrecoverable error; the caller does an early `if (!result) { return; }` guard.
- Do not add new comments unless the code is genuinely non-obvious after extraction.
- Keep new helpers in the same file unless they are independently reusable - do not create new files just to reduce line counts.

## Step 6 - Lint the changed file

```bash
cd vscode-extension && node_modules/.bin/eslint src/path/to/changed-file.ts
```

All **new** warnings introduced by your changes must be resolved before proceeding. Pre-existing warnings on other functions in the same file are acceptable - do not fix unrelated code.

## Step 7 - Run the full test suite and build

```bash
cd vscode-extension
node_modules/.bin/tsc.cmd --noEmit          # type-check
pnpm run test:node                            # unit tests
node esbuild.js --production                # production bundle
```

All tests must pass and the build must succeed. If a test fails, fix the refactoring - do not modify the tests unless the test itself was wrong before your change.

## Step 8 - Commit

Write a commit in this format:

```
refactor: extract <FunctionName> into focused private methods

<One or two sentences describing which logical sections were extracted
and why the split makes sense.>

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Step 9 - Open a PR

Open a pull request to `main`. The PR description should:

- Lead with the motivation (ESLint rule violation, cognitive overhead).
- List the extracted helpers in a small table (method name | responsibility).
- Confirm that all unit tests pass and the production build succeeds.
- Note any pre-existing warnings that were not introduced by this change.

## Constraints

- Only modify the one source file being refactored (plus its test file if a test needs updating to import a newly-exported helper, which should be rare).
- Do not fix pre-existing ESLint warnings on other functions in the same file.
- Do not change any exported function signatures or public class method signatures.
- Do not add new test files - rely on the existing test suite to verify correctness.
- If `tsc` or unit tests fail after your change, revert and choose a different decomposition strategy rather than patching around the failure.
