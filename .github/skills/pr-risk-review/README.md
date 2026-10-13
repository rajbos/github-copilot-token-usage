# PR Risk Review Skill

Classifies a changeset as **low**, **medium**, or **high** risk with a written
rationale, so a reviewer knows how much care a pull request needs before they
open the diff.

See [SKILL.md](SKILL.md) for the full instructions and the risk rubric.

## Quick start

```bash
# 1. Collect the facts (scripted — identical for every agent)
node .github/skills/pr-risk-review/collect-changeset.js --out-dir pr-risk

# 2. Read pr-risk/changeset.md + pr-risk/changeset.diff, write pr-risk/verdict.json
#    (this is the agent's judgement — see SKILL.md for the contract)

# 3. Validate the verdict and render the PR comment
node .github/skills/pr-risk-review/render-comment.js --out pr-risk/comment.md
```

## Who runs it

| Runner | How it picks the skill up |
|---|---|
| GitHub Copilot (VS Code, coding agent) | Auto-discovered from `.github/skills/` |
| GitHub Copilot CLI | Auto-discovered from `.github/skills/`, `.agents/skills/`, or `.claude/skills/` |
| Claude Code | Reads the mirrored copy at `.claude/skills/pr-risk-review/SKILL.md` |
| CI | `.github/workflows/pr-risk-review.yml` drives the Copilot CLI through the same steps |

The `SKILL.md` is mirrored byte-for-byte into `.claude/skills/pr-risk-review/`
per the rule in [`AGENTS.md`](../../../AGENTS.md).
The scripts and this README live only here — the Claude-side copy points at
these same paths, so there is one source of truth for the code.

## Tuning the heuristics

`risk-signals.json` maps path globs to a weight (`3` = high, `2` = medium,
`1` = low) plus a sentence explaining why that area matters. It also holds the
size thresholds and `lowRiskCategories` — the categories (tests, docs, assets)
that pin a matching file to low no matter where it lives, and whose lines are
excluded from the size thresholds. Keep those globs narrow: anything they match
stops counting. Change the heuristics there and both editors — and CI — pick
the change up at once.

## Files

- **SKILL.md** — the skill instructions and risk rubric (mirrored to `.claude/skills/`)
- **risk-signals.json** — declarative path globs → risk weights and thresholds
- **collect-changeset.js** — writes `changeset.json`, `changeset.md`, `changeset.diff`, and the mechanical baseline
- **render-comment.js** — validates + sanitises the verdict and renders the PR comment
