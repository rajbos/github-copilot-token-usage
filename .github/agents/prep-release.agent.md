---
description: "Prep version bumps for a new release: detect which components changed since their last release tag, bump versions, create a release-prep branch, commit, push, and open a PR. Outputs which GitHub Actions workflows to run after merging."
name: "Prep Release"
tools: ["execute/runInTerminal", "execute/getTerminalOutput", "read/terminalLastCommand", "search/codebase"]
---

# Prep Release Agent

Automates the version-bump PR needed before publishing a new release.
Detects which of the three releasable components have changed, bumps their version numbers, opens a release-prep branch and PR, and tells the user exactly which GitHub Actions workflows to trigger after merging.

## Releasable Components

| Component | Version file | Last release tag prefix | Workflow to run after merge |
|-----------|-------------|------------------------|----------------------------|
| **VS Code extension** | `vscode-extension/package.json` → `version` | `vscode/v` | `release.yml` (Actions → _Extensions - Release_ → Run workflow) |
| **CLI** | `cli/package.json` → `version` | `cli/v` | `cli-publish.yml` (Actions → _CLI - Publish to npm and GitHub_ → Run workflow) |
| **Visual Studio extension** | `visualstudio-extension/src/CopilotTokenTracker/source.extension.vsixmanifest` → `Identity.Version` | `vs/v` | `visualstudio-build.yml` (Actions → _Visual Studio Extension - Build & Package_ → Run workflow, set `publish_marketplace: true`) |

---

## Step-by-Step Instructions

### Step 1 — Determine the default bump type

If the user didn't specify a bump type, ask:
> "What kind of version bump should I apply? (patch / minor / major) — or specify per-component."

Default to **patch** if the user doesn't specify.

Individual overrides per component are also valid (e.g. "minor for vscode, patch for cli, skip vs").

### Step 2 — Find last release tags for each component

Run these three commands to find the most recent release tag for each component:

```bash
git tag --sort=-version:refname | grep '^vscode/v' | head -1
git tag --sort=-version:refname | grep '^cli/v' | head -1
git tag --sort=-version:refname | grep '^vs/v' | head -1
```

Record the result for each. If no tag exists for a component, treat it as "never released" and compare against `origin/main`.

### Step 3 — Detect which components have changed

For each component, diff from the last tag (or `origin/main` if no tag) to `HEAD`:

```bash
# VS Code extension
git diff --name-only <last-vscode-tag>...HEAD -- vscode-extension/

# CLI
git diff --name-only <last-cli-tag>...HEAD -- cli/

# Visual Studio extension
git diff --name-only <last-vs-tag>...HEAD -- visualstudio-extension/
```

If **no tag** exists, use:
```bash
git merge-base origin/main HEAD   # get the merge base
git diff --name-only <merge-base> -- <path>/
```

A component **has changes** if the diff output is non-empty.

Also note: changes to shared `vscode-extension/src/` files (e.g. `tokenEstimators.json`, `modelPricing.json`, `toolNames.json`) are relevant to the VS Code extension. The VS extension build also depends on changes to `cli/` and shared `vscode-extension/src/*.ts` files — if those changed since the last VS tag, include the VS extension in the bump.

### Step 4 — Read current versions

```bash
node -p "require('./vscode-extension/package.json').version"
node -p "require('./cli/package.json').version"
```

For the VS extension, read the `Version` attribute from the `<Identity>` element in `visualstudio-extension/src/CopilotTokenTracker/source.extension.vsixmanifest`.

### Step 5 — Confirm the plan with the user

Before making any changes, summarize the plan:

```
## Release Prep Plan

| Component | Last tag | Current version | New version | Change? |
|-----------|----------|-----------------|-------------|---------|
| VS Code extension | vscode/v0.0.27 | 0.0.27 | 0.0.28 (patch) | ✅ yes |
| CLI | cli/v0.0.7 | 0.0.7 | 0.0.8 (patch) | ✅ yes |
| Visual Studio extension | vs/v1.0.4 | 1.0.4 | — | ❌ no changes |

Branch: release/prep-2026-04-09
```

Ask the user to confirm before proceeding.

### Step 6 — Bump version numbers

For VS Code extension (if changed):
```bash
cd vscode-extension
npm version <bump-type> --no-git-tag-version
cd ..
```

For CLI (if changed):
```bash
cd cli
npm version <bump-type> --no-git-tag-version
cd ..
```

For Visual Studio extension (if changed), update the `Version` attribute in the `<Identity>` element of `visualstudio-extension/src/CopilotTokenTracker/source.extension.vsixmanifest`. Use the `edit` tool to make a targeted string replacement. The current value will be something like `Version="1.0.4"` — replace only the version number, not the whole line.

### Step 7 — Create a release-prep branch

```bash
git checkout -b release/prep-YYYY-MM-DD
```

Use today's date. If the branch already exists, append a short suffix (e.g. `-2`).

### Step 8 — Commit the version bump files

Stage only the version files:
```bash
git add vscode-extension/package.json vscode-extension/package-lock.json   # if VS Code changed
git add cli/package.json cli/package-lock.json                              # if CLI changed
git add visualstudio-extension/src/CopilotTokenTracker/source.extension.vsixmanifest  # if VS changed
```

Commit with a descriptive message:
```bash
git commit -m "chore: bump versions for release (<list bumped components>)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Step 9 — Push and create a PR

```bash
git push origin release/prep-YYYY-MM-DD
```

Create the PR:
```bash
gh pr create \
  --title "chore: bump versions for release (<list components>)" \
  --body "$(cat <<'EOF'
## Release prep — version bumps

This PR bumps version numbers for components that have changed since their last release tags.

| Component | Old version | New version |
|-----------|-------------|-------------|
| VS Code extension | v0.0.27 | v0.0.28 |
...

### After merging, run these workflows:

- **Extensions - Release** (`release.yml`) — publishes VS Code extension v0.0.28
...
EOF
)" \
  --base main \
  --head release/prep-YYYY-MM-DD
```

### Step 10 — Output the next steps

After the PR is created, output a clear summary:

```markdown
## ✅ Release prep PR created

**PR:** <url>

---

### After the PR is merged, run these workflows:

#### 1. VS Code Extension (if bumped)
- Go to **Actions → Extensions - Release → Run workflow** (on `main`)
- This publishes VS Code extension **vX.X.X** to the VS Code Marketplace
- Optionally set `publish_marketplace: true` (default: true for workflow_dispatch)

#### 2. CLI (if bumped)
- Go to **Actions → CLI - Publish to npm and GitHub → Run workflow** (on `main`)
- This publishes **@rajbos/ai-engineering-fluency@X.X.X** to npm

#### 3. Visual Studio Extension (if bumped)
- Go to **Actions → Visual Studio Extension - Build & Package → Run workflow** (on `main`)
- Set `publish_marketplace: true` to publish to the Visual Studio Marketplace
```

---

## Important Rules

- **Never bump a component that has no changes** since its last release tag (unless the user explicitly asks).
- **Always confirm the plan with the user** before creating files/branches/PRs (Step 5).
- **Dry-run mode**: If the user says "preview", "dry run", or "check only", stop after Step 5 without making any changes.
- **Only stage version files** in the commit — do not stage other changes.
- **Use `--no-git-tag-version`** with `npm version` to prevent npm from creating a git tag automatically.
- The VS extension's `<Identity Version="...">` is on a different line than `<PackageManifest Version="2.0.0">` — make sure to update only the `<Identity>` element.
- After `npm version`, also stage the `package-lock.json` — npm updates both files.

## Error Handling

- If `git push` fails (e.g. branch exists on remote), try `git push origin release/prep-YYYY-MM-DD-2`.
- If `gh pr create` fails, output the full `git push` URL instead and tell the user to create the PR manually.
- If any command fails unexpectedly, explain the error and ask the user how to proceed.
