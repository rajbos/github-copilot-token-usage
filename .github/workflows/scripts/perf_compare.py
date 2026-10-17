#!/usr/bin/env python3
"""Compare base vs PR benchmark results and write a performance findings report.

Reads the two JSON files produced by `scripts/benchmark/perf-bench.cjs` (one for
the base branch, one for the PR), computes the per-benchmark percentage change in
median time, and flags any benchmark that is more than the configured threshold
slower. The flag is deterministic — we do not ask a model to interpret timings.

The output follows the same findings contract as the review agents under
`.github/agents/`, so the performance-expert agent can report it as-is.

Environment variables:
  PERF_BASE_FILE             Base-branch results JSON (default: perf-base.json).
  PERF_HEAD_FILE             PR results JSON (default: perf-head.json).
  OUTPUT_FILE                Findings markdown to write (default: findings/performance.md).
  PERF_REGRESSION_THRESHOLD  Percent-slower that counts as a regression (default: 20).
  PERF_MIN_ABS_MS            Ignore benchmarks whose base median is below this many
                             ms, where timing noise dominates (default: 1.0).
"""

import json
import os
import sys

# Map each benchmark to the source file most likely responsible, so a flagged
# regression points the reader at where to look.
SOURCE_OF = {
    "estimateTokensFromJsonlSession": "src/tokenEstimation.ts",
    "estimateTokensFromText": "src/tokenEstimation.ts",
}

HIGH = "\U0001f534"
MEDIUM = "\U0001f7e1"
GREEN = "\U0001f7e2"


def load(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"::warning::Could not read {path}: {exc}", file=sys.stderr)
        return {}


def fmt(ms) -> str:
    return f"{ms:.3f}" if isinstance(ms, (int, float)) else "—"


def main() -> int:
    base_file = os.environ.get("PERF_BASE_FILE", "perf-base.json")
    head_file = os.environ.get("PERF_HEAD_FILE", "perf-head.json")
    output_file = os.environ.get("OUTPUT_FILE", "findings/performance.md")
    threshold = float(os.environ.get("PERF_REGRESSION_THRESHOLD", "20") or "20")
    floor = float(os.environ.get("PERF_MIN_ABS_MS", "1.0") or "1.0")

    base = load(base_file).get("benchmarks", {})
    head = load(head_file).get("benchmarks", {})

    os.makedirs(os.path.dirname(output_file) or ".", exist_ok=True)

    lines = ["# Performance Review", ""]

    common = [k for k in head if k in base]
    if not common:
        lines += [
            "**Verdict:** PASS",
            "",
            "Performance could not be measured for this changeset — no comparable "
            "benchmark results on both sides (a base or PR build/benchmark may have "
            "failed, or the benchmarked functions were absent). No regression flagged; "
            "review manually if this change touches a hot path.",
            "",
            "## Findings",
            "",
            "_No performance findings in this changeset._",
        ]
        with open(output_file, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines).rstrip() + "\n")
        print("No common benchmarks; wrote PASS.", file=sys.stderr)
        return 0

    rows = []
    high, medium, improved = [], [], []
    for name in sorted(common):
        b = base[name].get("medianMs")
        h = head[name].get("medianMs")
        if not isinstance(b, (int, float)) or not isinstance(h, (int, float)) or b <= 0:
            rows.append((name, b, h, None, "n/a"))
            continue
        pct = (h - b) / b * 100.0
        src = SOURCE_OF.get(name, "")
        below_floor = b < floor
        if pct > threshold and not below_floor:
            sev = HIGH if pct > 2 * threshold else MEDIUM
            target = high if sev == HIGH else medium
            target.append(
                f"- **`{name}`** — {pct:.1f}% slower (base {fmt(b)}ms → PR {fmt(h)}ms), "
                f"over the {threshold:.0f}% threshold."
                + (f" Investigate changes to `{src}`." if src else "")
            )
            status = f"{HIGH if sev == HIGH else MEDIUM} +{pct:.1f}%"
        elif pct < -threshold and not below_floor:
            improved.append(f"- **`{name}`** — {abs(pct):.1f}% faster (base {fmt(b)}ms → PR {fmt(h)}ms). Nice.")
            status = f"{GREEN} {pct:.1f}%"
        else:
            note = " (below noise floor)" if below_floor and abs(pct) > threshold else ""
            status = f"{pct:+.1f}%{note}"
        rows.append((name, b, h, pct, status))

    actionable = bool(high or medium)
    verdict = "CHANGES_SUGGESTED" if actionable else "PASS"

    lines.append(f"**Verdict:** {verdict}")
    lines.append("")
    if actionable:
        lines.append(
            f"One or more hot-path benchmarks regressed by more than the "
            f"{threshold:.0f}% threshold. See the findings below."
        )
    else:
        lines.append(
            f"No hot-path benchmark regressed by more than the {threshold:.0f}% "
            f"threshold (median of {head[common[0]].get('iterations', '?')} runs)."
        )
    lines.append("")

    lines.append("## Results")
    lines.append("")
    lines.append("| Benchmark | Base median (ms) | PR median (ms) | Status |")
    lines.append("| --- | --- | --- | --- |")
    for name, b, h, _pct, status in rows:
        lines.append(f"| `{name}` | {fmt(b)} | {fmt(h)} | {status} |")
    lines.append("")

    lines.append("## Findings")
    lines.append("")
    if high:
        lines.append(f"### {HIGH} High")
        lines += high
        lines.append("")
    if medium:
        lines.append(f"### {MEDIUM} Medium")
        lines += medium
        lines.append("")
    if improved:
        lines.append(f"### {GREEN} Improvements")
        lines += improved
        lines.append("")
    if not actionable and not improved:
        lines.append("_No performance regressions above the threshold in this changeset._")

    with open(output_file, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines).rstrip() + "\n")

    print(
        f"Compared {len(common)} benchmark(s): {len(high)} high, {len(medium)} medium, "
        f"{len(improved)} improved. Verdict={verdict}.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
