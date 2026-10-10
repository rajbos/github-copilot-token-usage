---
name: whats-new-catalog
description: Keep the What's New release catalog (vscode-extension/src/whatsNew/catalog.ts) in step with what the extension actually ships. Detects a released version with no catalog entry, an entry left marked "Unreleased" after it shipped, a feature pointing at a view or tab that no longer exists (a "Take me there" button that goes nowhere), and a catalogued tab on a view that never reports being opened — which silently breaks the "don't announce what they already found" rule. Also prints the surface inventory and the CHANGELOG's Unreleased bullets side by side, the two things you read when writing a new entry. Use when bumping the extension version or cutting a release, after adding a new view/tab/section, or when the What's New view looks stale or wrong.
---

# What's New Catalog Skill

`vscode-extension/src/whatsNew/catalog.ts` is hand-written prose that drives two
user-facing things:

- the **What's New view** (the last 5 releases, in plain English), and
- the **one-a-day new-feature notifications** — which surface gets pointed out,
  and where its "Take me there" button goes.

Because it is prose, nothing about it compiles-or-breaks. A release can ship with
no entry, an entry can point at a tab that was renamed, and everything still
builds and every test still passes. The view just quietly starts lying.

This skill covers the mechanical half. The editorial half — *what to say* — is
yours, and the guidance for it is below.

> Full feature documentation: [docs/features/WHATS-NEW.md](../../../docs/features/WHATS-NEW.md)

## The detector

```bash
node .github/skills/whats-new-catalog/whats-new-catalog.js          # human-readable
node .github/skills/whats-new-catalog/whats-new-catalog.js --json   # machine-readable
```

Dependency-free apart from the repo's own TypeScript — it transpiles and
evaluates `catalog.ts` rather than pattern-matching its prose, so multi-line
descriptions containing braces and quotes can never confuse it. Run `pnpm install` in
`vscode-extension/` first if it complains.

### What it checks

| Check | Why it matters |
|---|---|
| **Version coverage** — `package.json`'s version has a catalog entry | Without one, everything in that release is invisible in the view and can never be announced |
| **Date hygiene** — only the newest entry may be `date: null` | An older undated entry makes the view say "Unreleased" about something users have run for months |
| **Orphan surfaces** — every `surface` resolves to a real view, and a real tab on it | An orphan is a "Take me there" button that silently does nothing |
| **Tab-tracking gaps** — a catalogued `tab` on a view that never posts `viewTabOpened` | The announcer can never tell the user opened it, so it keeps offering something they already found. Invisible in review; the main reason this script exists |

Ordering, id uniqueness and prose length are covered by
`vscode-extension/test/unit/whatsNewCatalog.test.ts` and are deliberately not
duplicated here.

### What it prints for you to judge

- **The current entry**, with each feature marked if it falls **beyond the
  per-release announcement cap** — those are listed in the view but never
  announced, so if an important one is sitting below the line, reorder.
- **The surface inventory** — every view and tab the extension ships, ticked
  where some catalog entry names it. A blank is *not* a problem; most tabs
  predate the catalog. It is the reference table for writing a surface.
- **The CHANGELOG's `Unreleased` → `Features` bullets** — the raw material.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Catalog is consistent with the code |
| `1` | Mechanical drift you can fix directly (orphan surface, stale null date, untracked tab) |
| `2` | Configuration error (a source file moved, or TypeScript is not installed) |
| `3` | **No entry for the current version** — needs written prose. Takes precedence over `1` |

## Workflow for the agent

1. **Run the detector.**
2. **Exit 1 → fix it in `catalog.ts` directly.** These are unambiguous:
   - orphan surface → repoint it at the tab's current name, or drop the `tab`
     and leave it at view level;
   - undated older entry → add the release date from `vscode-extension/CHANGELOG.md`;
   - untracked tab → either drop the `tab` from the surface, or wire that view's
     webview to post `{ command: 'viewTabOpened', view, tab }` on tab change
     (see `src/webview/usage/main.ts` → `reportTabOpened`). Wiring it up is the
     better fix when the view genuinely has tabs users navigate between.
3. **Exit 3 → write the entry** (see the next section), then re-run.
4. **Read the "beyond the cap" markers.** If something important is below the
   line, reorder the `features` array. Catalog order *is* the decision about
   what mattered most in the release.
5. **Re-run until clean**, then run the unit tests:
   `cd vscode-extension && npm run test:node`.

## Writing a release entry

Prepend to `WHATS_NEW_RELEASES` (newest first):

```ts
{
  version: '0.18.0',
  date: null,          // a date once it ships; see "At release time" below
  headline: 'One sentence for someone who skipped the details.',
  features: [ /* most important first — the cap truncates */ ],
},
```

**Write for a user, not a reviewer.** The CHANGELOG says what changed in the
diff; this says what someone can now *do*, and why they would look. Compare:

> ❌ *"Add corrections detection with per-repo grouping over the 25 most recent sessions"*
>
> ✅ *"Shows the moments where things went sideways — a tool call that failed, an
> edit the agent immediately redid, a 'sorry, let me try that again' — grouped per
> repository. A good place to look when a session felt like hard work but you
> cannot say why."*

Rules that are easy to get wrong:

- **Only list things a person can point at**: a new view, tab, or section. Bug
  fixes, refactors and performance work belong in the CHANGELOG. A release with
  nothing pointable gets `features: []` and a headline saying so — the view
  renders that honestly, and a gap in the version list would read as a bug.
- **Order by importance.** Only the first `WHATS_NEW_MAX_ANNOUNCEMENTS_PER_RELEASE`
  are ever announced; the rest are view-only.
- **Never reuse or renumber an `id`.** They are persisted in `globalState` to
  remember what each user has been told, so a recycled id silently suppresses the
  announcement for everyone who saw the feature it used to name.
- **`kind`** is only used for the notification's wording ("New tab: …"), so pick
  the one that matches what the user will see appear.
- **`surface`** must be precise enough both to open the thing and to tell whether
  the user has been there. Use `anchor` for a section within a tab; anchors are
  not part of the "have they seen it" key, so a section counts as found once its
  tab has been visited.

## At release time

When the version bump lands and the release ships:

1. Set the entry's `date` to the release date (matching `CHANGELOG.md`).
2. Add the new in-development version's entry with `date: null`.
3. Re-run the detector — it should be clean at exit 0.

The oldest entries can stay in the array; the view slices to
`WHATS_NEW_MAX_RELEASES`. Keeping a little more history than that is harmless and
means the trim point is a display decision rather than a data-loss one.

## Related files

- `vscode-extension/src/whatsNew/catalog.ts` — the catalog itself
- `vscode-extension/src/whatsNew/announcer.ts` — the pacing rules (caps, daily gate, staleness)
- `vscode-extension/src/whatsNew/visits.ts` — the per-view/per-tab last-opened stamps
- `vscode-extension/src/webview/whatsnew/main.ts` — the view
- `vscode-extension/test/unit/whatsNewCatalog.test.ts` — ordering, unique ids, prose length
- `docs/features/WHATS-NEW.md` — how the whole feature works
- `.github/skills/sync-host-views/` — the sibling skill for a *new view* that the
  Visual Studio and JetBrains hosts do not yet ship
