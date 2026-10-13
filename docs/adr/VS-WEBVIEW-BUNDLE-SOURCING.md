# Should the Visual Studio Webview Bundles Stay Committed?

**Status:** Implemented in code, **release gate OPEN (unverified)** · **Decided/added:** 2026-09-12 · **Verified against code on:** 2026-10-11 (file/CI/csproj claims only — nothing here has been executed on Windows)

> ## 🚧 RELEASE GATE — OPEN, NEEDS A HUMAN — read before the next Visual Studio release 🚧
>
> **Decision (done):** the Visual Studio webview bundles are no longer committed. The
> `.js`/`.json` files under `visualstudio-extension/src/AIEngineeringFluency/webview/` are
> gitignored build output, produced at build time by `CopyWebviewBundles` /
> `AddWebviewBundlesToVsix` in `AIEngineeringFluency.csproj` from a fresh
> `vscode-extension/dist/webview`.
>
> **Unresolved:** nobody has installed a Visual Studio `.vsix` built this way and seen it work.
> CI now opens the built `.vsix` and asserts every expected webview file is present and non-empty
> (`scripts/verify-vsix-webview.js`, run by `visualstudio-build.yml`, `visualstudio-publish.yml` and
> `release.yml`; the first CI run of it caught the `AddWebviewBundlesToVsix` ordering bug, fixed by
> `DependsOnTargets="CopyWebviewBundles"`). That does not prove the files match `dist/webview` or
> that the VSIX installs and renders. `ci.yml` checks only that `dist/webview` has the expected files, not the VSIX. The
> MSBuild reasoning that makes this safe (see "Exactly how the VS host references the files today"
> below) is inferred from reading the `.csproj`, not executed. Before that check existed, a green build could ship an
> empty `webview/` folder.
>
> ### Acceptance criteria (all must be ticked by a human on Windows + Visual Studio 2022 with the VSSDK workload)
>
> - [ ] **Clean tree:** a fresh checkout has no `webview/*.js` or `webview/*.json` under `visualstudio-extension/src/AIEngineeringFluency/` before building.
> - [ ] **Bundles built:** `cd vscode-extension && npm run package` leaves every file the `.csproj` `_WebviewBundle` list names in `vscode-extension/dist/webview/` (plus `src/fluencyLevelData.json`). The list is the source of truth for the expected set — it had 14 entries on 2026-10-11 (7 `.js` bundles, 4 data `.json`, 2 `localization.*.json`, `fluencyLevelData.json`); do not rely on a count in this document.
> - [ ] **Local build:** `msbuild AIEngineeringFluency.sln /p:Configuration=Release /t:Build /v:minimal` (from `visualstudio-extension/`) succeeds and `CopyWebviewBundles`' missing-source `Error` does not fire.
> - [ ] **Local VSIX contents:** unzip the produced `.vsix`; every file in the `_WebviewBundle` list is present under the `webview` folder, non-empty, and matches the `dist/webview` (or `src/`) source.
> - [ ] **CI VSIX contents:** repeat the previous two checks on the `.vsix` artifact uploaded by an actual `visualstudio-build.yml` run (scratch branch or `workflow_dispatch`), since that is the path that ships.
> - [ ] **Installs and renders:** the VSIX installs in Visual Studio and the webview screens render.
> - [x] **Follow-up automation:** CI unzips the produced `.vsix` and fails when a listed webview file is missing or empty (`scripts/verify-vsix-webview.js`). This covers presence/non-emptiness only; the human boxes above stay open.
>
> Until every box above is ticked, treat any Visual Studio release built from this code as
> **unverified for webview content**.
>
> The implementation narrative, the original step-by-step procedure and the deletion log were moved
> out of this file; see [history/VS-WEBVIEW-BUNDLE-SOURCING-SESSION-LOG.md](history/VS-WEBVIEW-BUNDLE-SOURCING-SESSION-LOG.md).

## Current state (2026-10-11)

- No webview files are committed; `.gitignore` ignores `webview/*.js` and `webview/*.json` at that path.
- `CopyWebviewBundles` fails the build (`Error`) when the `dist/webview` sources are missing.
- `AddWebviewBundlesToVsix` injects the files as `VSIXSourceItem`s before `GetVsixSourceItems`.
- `ci.yml` ("Check webview bundles are generated correctly") asserts that `npm run package` produced the expected non-empty files and that a simulated copy keeps them. It does not inspect any `.vsix`.
- `visualstudio-build.yml`, `visualstudio-publish.yml` and `release.yml` run `scripts/verify-vsix-webview.js` on the built `.vsix` (expected list derived from the `.csproj` and `esbuild.js`). The build workflow also starts MSBuild with an empty `webview/` folder and has a negative-path step for a missing `dist/webview`.
- The Investigation and Recommendation sections below were written **before** the deletion (2026-09-12): numbers such as line counts, the "6 bundles" and the stale `usage.js` finding describe that moment, not today.

## Problem Statement

The Visual Studio host commits esbuild **build output** into source control:

```
visualstudio-extension/src/AIEngineeringFluency/webview/chart.js          18,479 lines
visualstudio-extension/src/AIEngineeringFluency/webview/maturity.js       12,264 lines
visualstudio-extension/src/AIEngineeringFluency/webview/usage.js           9,203 lines
visualstudio-extension/src/AIEngineeringFluency/webview/diagnostics.js     6,810 lines
visualstudio-extension/src/AIEngineeringFluency/webview/details.js         3,621 lines
visualstudio-extension/src/AIEngineeringFluency/webview/environmental.js   2,494 lines
```

~52,900 lines — roughly a quarter of the repo's total line count. Every VS Code
webview change regenerates them, producing large unreviewable diffs and merge
conflicts across parallel branches. Commit `a7dfe7b` already marked these paths
`linguist-generated=true` in `.gitattributes`, which collapses them in GitHub's
diff view. That treats the symptom. This document answers the underlying
question: **must they be in git at all?**

## Investigation

### 1. How the JetBrains host does it (the reference implementation)

`jetbrains-plugin/src/main/resources/webview/` contains only a `.gitkeep` —
nothing is committed. `jetbrains-plugin/build.gradle.kts` copies the real
bundles at Gradle build time:

```kotlin
val prepareBundledAssets by tasks.registering(Copy::class) {
    description = "Copy webview bundles, vscode-shim, and CLI binaries into plugin resources."
    group = "build"

    val repoRoot = rootProject.projectDir.parentFile

    // 1. Webview JS bundles produced by `npm run compile` in vscode-extension/.
    from("$repoRoot/vscode-extension/dist/webview") {
        include("details.js", "chart.js", "usage.js", "diagnostics.js", "environmental.js", "maturity.js")
        into("webview")
    }
    ...
}

tasks {
    processResources {
        dependsOn(prepareBundledAssets)
        ...
    }
}
```

Nothing is ever checked in; `processResources` always depends on a fresh
`Copy` from `vscode-extension/dist/webview`. There is no "stale committed
copy" failure mode for JetBrains — only "did anyone run `npm run compile`
first," which is a build-ordering problem, not a source-control one.

### 2. Exactly how the VS host references the files today

**`visualstudio-extension/src/AIEngineeringFluency/AIEngineeringFluency.csproj`**
already contains an MSBuild target that copies from
`vscode-extension/dist/webview` into the project's `webview\` folder — it is
not purely "committed and consumed as-is":

```xml
<!--
  Copy webview JS bundles from the vscode-extension build output into this project's
  webview\ folder so they can be packaged inside the VSIX.
  Prerequisite: run `npm run compile` in vscode-extension/ first.
-->
<Target Name="CopyWebviewBundles" BeforeTargets="Build">
  <ItemGroup>
    <_WebviewBundle Include="..\..\..\vscode-extension\dist\webview\details.js" />
    <_WebviewBundle Include="..\..\..\vscode-extension\dist\webview\chart.js" />
    <_WebviewBundle Include="..\..\..\vscode-extension\dist\webview\usage.js" />
    <_WebviewBundle Include="..\..\..\vscode-extension\dist\webview\diagnostics.js" />
    <_WebviewBundle Include="..\..\..\vscode-extension\dist\webview\environmental.js" />
    <_WebviewBundle Include="..\..\..\vscode-extension\dist\webview\maturity.js" />
    ... (tokenEstimators.json, modelPricing.json, toolNames.json, automaticTools.json)
  </ItemGroup>
  <!--
    Warn loudly when the freshly-built bundles are absent. Without this, the Copy below
    silently no-ops (ContinueOnError) and the VSIX ships the committed webview\*.js, which
    can be weeks out of date ...
  -->
  <Warning
    Condition="!Exists('..\..\..\vscode-extension\dist\webview\details.js')"
    Text="vscode-extension/dist/webview bundles not found — packaging the committed (possibly STALE) webview\*.js. ..." />
  <MakeDir Directories="$(MSBuildProjectDirectory)\webview" />
  <Copy SourceFiles="@(_WebviewBundle)" DestinationFolder="$(MSBuildProjectDirectory)\webview\" SkipUnchangedFiles="true" ContinueOnError="true" />
</Target>

<!-- Include copied webview JS files inside the VSIX package -->
<ItemGroup>
  <Content Include="webview\*.js" Condition="Exists('$(MSBuildProjectDirectory)\webview')">
    <IncludeInVSIX>true</IncludeInVSIX>
    <VSIXSubPath>webview\</VSIXSubPath>
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
  </Content>
  <Content Include="webview\*.json" Condition="Exists('$(MSBuildProjectDirectory)\webview')">
    <IncludeInVSIX>true</IncludeInVSIX>
    <VSIXSubPath>webview\</VSIXSubPath>
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
  </Content>
</ItemGroup>
```

So the `.csproj` author already built a "generate at build time" path — the
commit of `webview/*.js` exists specifically as a **fallback for when
`dist/webview` hasn't been built**, with a `Warning` (not an `Error`) telling
the developer the packaged output may be stale. It is `ContinueOnError="true"`
by design.

`source.extension.vsixmanifest` does **not** enumerate the webview files
individually — its only `<Asset>` is the VsPackage output group:

```xml
<Assets>
  <Asset Type="Microsoft.VisualStudio.VsPackage"
         d:Source="Project"
         d:ProjectName="%CurrentProject%"
         Path="|%CurrentProject%;PkgdefProjectOutputGroup|" />
</Assets>
```

The webview files reach the VSIX purely through the `.csproj`'s
`IncludeInVSIX`/`VSIXSubPath` metadata on the `Content` items above, collected
by the VSSDK's `GetVsixSourceItems` target — not through the manifest.

**A specific MSBuild subtlety this repo has already run into once**, documented
in its own comment on a neighboring target (`AddCliBundleToVsix`):

> "`CreateVsixContainer` is triggered by `PrepareForRun` (not `Build`). The
> `CopyWebviewBundles` target (`BeforeTargets="Build"`) does NOT run in the
> `PrepareForRun` path, so any Content items added there are invisible to
> `GetVsixSourceItems`."

This is why the CLI `.exe`/`.wasm` files are injected as `VSIXSourceItem`
entries from a target with `BeforeTargets="GetVsixSourceItems"`, executed
imperatively at the right point in the build — rather than as a static,
top-level wildcard `Content Include`. The webview files, by contrast, **are**
declared as a plain top-level wildcard (`Content Include="webview\*.js"
Condition="Exists(...)"`). In classic (non-SDK-style) `.csproj` files —
this one is classic, evidenced by its fully explicit `<Compile Include>`
lists — top-level `<ItemGroup>` wildcards are expanded once, during project
**evaluation**, before any target (including `CopyWebviewBundles`, despite
`BeforeTargets="Build"`) has executed. That means the wildcard only sees
files that are *already on disk before MSBuild starts* — which today is true
only because the committed copies are already there. **This is inferred from
reading the file and from MSBuild's documented evaluation-vs-execution model,
not executed/verified** — this container has no `dotnet`/`msbuild`/Windows to
confirm it empirically (see Verification Limits below). If true, it means a
naive "delete the committed files, keep only the `BeforeTargets="Build"`
copy target" change would silently ship a VSIX with **zero** webview content
on a clean checkout's first build, because at evaluation time `webview\` is
empty. It also affects the `.json` sidecar files (`tokenEstimators.json`,
`modelPricing.json`, `toolNames.json`, `automaticTools.json`), which are
copied by the same target but are not part of the ~52,900-line problem since
they aren't committed under `webview/` today — confirm this before treating
them as already solved.

### 3. What CI does today

Both `.github/workflows/visualstudio-build.yml` and
`.github/workflows/visualstudio-publish.yml` already have a working Node
toolchain (`actions/setup-node` + `.nvmrc`) and, critically, **already rebuild
the bundles from TypeScript and overwrite the committed copies before MSBuild
ever runs**:

```powershell
# ── Build webview bundles (chart.js, usage.js, etc.) ──────────────────
- name: Build VS Code extension webview bundles
  working-directory: vscode-extension
  run: npm run package

- name: Copy webview bundles to VS extension project
  shell: pwsh
  run: |
    $src = "vscode-extension\dist\webview"
    $dst = "visualstudio-extension\src\AIEngineeringFluency\webview"
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $src $dst -Recurse -Force
    Write-Host "✅ Copied webview bundles"

# ── Build Visual Studio extension (MSBuild / VSSDK) ───────────────────
- name: Restore NuGet packages
  ...
- name: Build solution (Release)
  run: msbuild AIEngineeringFluency.sln /p:Configuration=Release /t:Build /v:minimal
```

This wholesale `Remove-Item`/`Copy-Item` happens as a **separate workflow
step before `msbuild` is invoked**, i.e. before MSBuild's project-evaluation
phase begins — which is exactly why it sidesteps the wildcard-timing issue
described above: the files are on disk *before* MSBuild starts evaluating,
not injected mid-build. The `.csproj`'s own `CopyWebviewBundles` target then
runs too, redundantly (`SkipUnchangedFiles="true"` makes it a no-op).

`build.ps1 -Project visualstudio` (the local/agent-facing orchestrator) does
the identical thing for local builds — always runs `npm run compile` and
copies `dist/webview/*.js` over the committed files before invoking MSBuild.

**Conclusion: in both CI paths and the documented local build path, the
committed `webview/*.js` files are never actually consumed as committed —
they are overwritten by a fresh build immediately before every build.** The
only path where the *committed* content is what ships is: a developer (or an
agent, contrary to `AGENTS.md`) opens the `.sln` directly in Visual Studio and
builds/presses F5 without ever running `npm run compile` first — the exact
scenario the `.csproj`'s `Warning` (not `Error`) is guarding against.

`dotnet` is not installed in this container (`command not found`), so no part
of the MSBuild/VSIX pipeline could be executed here to confirm any of the
above at runtime; everything about MSBuild's own behavior above is read from
the `.csproj`/workflow source and documented MSBuild semantics.

### 4. Are the committed copies currently in sync?

Built `vscode-extension/dist/webview/*.js` fresh (`npm run compile`, dependencies
already installed) and compared by SHA-256 against the committed VS bundles:

| Bundle | Result |
|---|---|
| `chart.js` | identical (18,479 lines) |
| `maturity.js` | identical (12,264 lines) |
| `diagnostics.js` | identical (6,810 lines) |
| `details.js` | identical (3,621 lines) |
| `environmental.js` | identical (2,494 lines) |
| `usage.js` | **different** — dist: 9,231 lines vs. committed: 9,203 lines |

`usage.js` is stale. `git diff` between the two shows real, functional
divergence, not whitespace/formatting: the committed VS bundle is missing an
entire feature — a per-repository "Clean up pushed worktrees" button
(`startWorktreeCleanup(repoLabel)`, `buildWorktreeRepoCleanupButtonHtml`,
`getCleanupCandidates(repoLabel)`) that landed in `vscode-extension` via PR
#1954 (merge commit `b002b33`) after the VS bundle was last hand-refreshed at
`35329c5`. Running the repo's own drift detector confirms this independently:

```
$ node .github/skills/sync-host-views/sync-host-views.js
...
Visual Studio committed-bundle health
  stale vs dist: usage
...
exit code: 3   (also flags 4 NEW VS-Code-only views unrelated to this staleness)
```

`git log` on the committed VS `usage.js` also shows a recurring
`chore: refresh Visual Studio usage bundle` commit pattern (e.g. `8797352`) —
i.e. this is not a one-off miss, it is the expected steady-state failure mode
of "regenerate and hand-commit," which has already recurred at least once
before this investigation caught the current instance.

**This is independent, load-bearing evidence for the recommendation below**:
the manual-sync model this repo is trying to keep working (committed bundles
refreshed by a human or agent running `sync-host-views --refresh`) is
demonstrably not staying current in practice, on this very branch's parent
history.

## Recommendation: (a) Generate at build time

The single most decisive fact: **CI already does this.** Both
`visualstudio-build.yml` and `visualstudio-publish.yml` run `npm run package`
and forcibly overwrite the committed `webview/` folder before invoking
MSBuild, on every push, PR, and release. The committed files are not load-bearing
for either CI pipeline today — they are dead weight for the one consumer
(CI) that matters most for what ships. The `.csproj`'s own comments already
frame the committed copies as a "possibly STALE" fallback for a workflow
(building directly from the `.sln` without running the Node build first) that
`AGENTS.md` explicitly tells agents never to exercise (no `devenv`, no `code
.`, no launching a real IDE), and that human contributors are told to avoid
via the `Warning` text pointing at `build.ps1 -Project visualstudio`. The
`usage.js` staleness found above shows the fallback's actual cost: it doesn't
fail safe, it ships silently wrong behavior to anyone who skips the Node
build step, indistinguishable from a correct build.

### What generating at build time requires

1. **Make the VS host's existing `CopyWebviewBundles` target the only source
   of truth**, mirroring `prepareBundledAssets`: replace the six committed
   `webview/*.js` files with a `.gitkeep` (same pattern as
   `jetbrains-plugin/src/main/resources/webview/`).
2. **Fix the MSBuild evaluation-timing risk identified in §2** before removing
   the committed files, not after. Concretely: convert the top-level
   `<ItemGroup><Content Include="webview\*.js" .../></ItemGroup>` into
   dynamically-injected `VSIXSourceItem` entries from a target with
   `BeforeTargets="GetVsixSourceItems"`, the same pattern already used for the
   CLI bundle in `AddCliBundleToVsix`. Enumerate the six known bundle names
   explicitly (as `_WebviewBundle` already does) rather than relying on a
   wildcard evaluated at project-load time. This needs to be validated on an
   actual Windows/MSBuild machine — it cannot be verified from this container.
3. **Turn the existing `Warning` into an `Error`** when `dist/webview` is
   missing, so a build without a prior `npm run compile`/`npm run package`
   fails loudly instead of silently packaging nothing (per point 2) or
   something stale (today's behavior). This is the direct fail-safe
   replacement for "the committed files are always there as a safety net."
4. **CI changes**: none required for `visualstudio-build.yml` /
   `visualstudio-publish.yml` — they already build and copy fresh bundles
   before invoking MSBuild. The `Remove-Item`/`Copy-Item` workflow steps
   become redundant with a corrected in-project target but are harmless to
   leave as an explicit, readable step; removing them is optional cleanup, not
   required for correctness.
5. **`sync-host-views` skill**: its "refresh the committed VS bundles"
   mode (`--refresh`, and the "stale vs dist" check) becomes unnecessary once
   nothing is committed — it should be scoped down to what it already does
   for JetBrains: only tracking NEW/ORPHAN view-list drift between
   `esbuild.js`, the `.csproj` include list, and `build.gradle.kts`. (Propose
   this change; do not implement it here per task scope.)

### Risks

- **Unverifiable from this container.** No `dotnet`, no MSBuild, no Windows,
  no Visual Studio. The MSBuild wildcard-evaluation-timing concern in §2 is
  read from the `.csproj`'s own comments and MSBuild's documented
  evaluate-then-execute model — it is a strong inference, not something this
  investigation executed. It must be validated with a real build (ideally the
  existing `visualstudio-build.yml` CI job on a branch) before deleting the
  committed files, exactly as the task's scope limits require.
- **Contributors without Node.** Anyone who clones the repo and opens the
  `.sln` directly (skipping `build.ps1`) will get a build error instead of a
  stale-but-functional VSIX. This is a behavior change from "silently stale"
  to "loudly blocked," which is the intended fail-safe improvement, but it
  does raise the bar for a from-scratch Windows/VS-only contributor to also
  have Node installed — no different from the requirement JetBrains
  contributors already have today.
- **Offline/air-gapped builds** lose the "last known good" webview content
  that shipping committed files currently provides as an implicit cache.
  Nothing here indicates this is a real constraint for this project (no
  air-gapped build docs found), but it is worth the human decision-maker
  confirming before migrating.
- **VSIX packaging via `GetVsixSourceItems`/`PrepareForRun`** is the one place
  a naive migration could silently regress (§2) — this is the crux of why
  this task does not delete the committed files itself.

## Migration Steps (for a human to execute on Windows/VS)

> The deletion in step 5 has already happened in git, ahead of the verification in steps 1–3. Those verification steps are what the release-gate checklist at the top of this file tracks; they are still open.

1. On a Windows machine with Visual Studio/MSBuild, apply the
   `AddCliBundleToVsix`-style dynamic-`VSIXSourceItem` conversion for the
   webview `Content` items in `AIEngineeringFluency.csproj` (§2 fix), keeping
   the committed files in place for now as a safety net.
2. Delete `visualstudio-extension/src/AIEngineeringFluency/webview/*.js` from
   the working copy (but not from git yet), run `build.ps1 -Project
   visualstudio -Target package` (or `msbuild ... /t:Build` after a fresh
   `npm run compile`), and confirm the resulting `.vsix` actually contains
   `webview\*.js` (unzip and check) with correct, current content.
3. Run the same check via the actual `visualstudio-build.yml` GitHub Actions
   job (push to a scratch branch, or `workflow_dispatch` if enabled) to
   confirm the CI path also produces a correct VSIX with the committed files
   absent.
4. Once both are confirmed: replace the six committed `.js` files with a
   `.gitkeep`, change the `Warning` to an `Error` in `CopyWebviewBundles`,
   remove the now-redundant `linguist-generated=true` line for these paths
   from `.gitattributes` (nothing left to mark), and scope down
   `sync-host-views` to view-list drift only (drop the VS bundle
   refresh/staleness feature, matching how it already treats JetBrains).
5. Delete the ~52,900 lines from git in the same PR that lands step 4, with
   the CI run from step 3 linked as evidence.

If step 2 or 3 reveals that the dynamic-`VSIXSourceItem` conversion does not
fully resolve the packaging risk (e.g. some other MSBuild target also depends
on `webview\*.js` being present at evaluation time), that is grounds to fall
back to recommendation (b) — keep the files committed — with the
`.gitattributes` marker as the only mitigation already in place, plus adding
a CI check (a new, low-cost step in `visualstudio-build.yml`) that fails the
build when the committed bundles drift from a fresh build, using the same
SHA-256 comparison `sync-host-views.js --json` already performs, so staleness
like the current `usage.js` gap cannot recur silently.

## Verification Limits

Verified in this investigation (Linux container, no MSBuild/VS):
- `.csproj`, `.vsixmanifest`, `build.gradle.kts`, both VS GitHub Actions
  workflows, and `sync-host-views.js` were read in full.
- `vscode-extension/dist/webview/*.js` was rebuilt from source
  (`npm run compile`) and byte-compared (SHA-256) against the six committed
  VS bundles.
- `node .github/skills/sync-host-views/sync-host-views.js` was run and its
  independent "stale vs dist: usage" finding corroborates the manual diff.

Not verified (would require Windows + Visual Studio/MSBuild + VSSDK):
- Whether the MSBuild wildcard-evaluation-timing concern in §2 actually
  manifests as described (this is inferred from the `.csproj`'s own comments
  about `GetVsixSourceItems`/`PrepareForRun` plus MSBuild's documented
  evaluate-then-execute model, not from running MSBuild).
- Whether a `.vsix` built with the committed files removed actually installs
  and renders webview content correctly end to end.
- Whether `visualstudio-publish.yml`'s marketplace-publish step or any
  Marketplace-side validation inspects file provenance in a way that cares
  whether `webview/*.js` was committed vs. generated (nothing found in the
  workflow suggests this, but it was not exercised).
