#!/usr/bin/env python3
"""Mechanically sync src/toolNames.json with microsoft/vscode-copilot-chat.

Replaces the former Copilot-CLI agent step. The upstream checkout is untrusted
third-party content, so it is only ever *parsed* here (regex over two enums);
nothing in it is executed, interpreted as instructions, or given network/token
access. The script performs no network calls and reads no credentials.

Reads the string values of `ToolName` and `ContributedToolName` in the
upstream `src/extension/tools/common/toolNames.ts`, drops the IDs already
represented in toolNames.json (exact, case-variant, canonical-equivalent, or
same friendly name), and injects the rest in the file's leading-comma style.
Only the toolNames.json file passed via --tool-names is modified.
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from toolnames_utils import canonicalize_tool_id, find_matches_for_new_tool, load_tool_names  # noqa: E402

ENUM_NAMES = ("ToolName", "ContributedToolName")
# Upstream values become JSON keys; refuse anything outside this charset.
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$")
# A compromised upstream must not be able to flood the mapping unnoticed.
MAX_NEW_ENTRIES = 40

SPECIAL_WORDS = {"github": "GitHub", "vscode": "VSCode"}
ACRONYMS = {"mcp", "api", "url", "json", "http", "https", "cli", "ui", "io", "id"}


def strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    return re.sub(r"(?m)//.*$", "", source)


def extract_tool_ids(source: str) -> list[str]:
    """Return the string values of the ToolName / ContributedToolName enums.

    Raises ValueError unless BOTH enums are present, so a partial upstream
    refactor cannot silently omit one enum's tools.
    """
    source = strip_comments(source)
    ids: list[str] = []
    for enum_name in ENUM_NAMES:
        match = re.search(
            rf"export\s+(?:const\s+)?enum\s+{enum_name}\s*\{{(.*?)\n\}}", source, flags=re.DOTALL
        )
        if not match:
            raise ValueError(f"enum {enum_name} not found upstream; layout changed? Refusing a partial sync.")
        ids += [m.group(2) for m in re.finditer(r"=\s*(['\"])([^'\"]+)\1", match.group(1))]
    return ids


def friendly_name(tool_id: str) -> str:
    spaced = re.sub(r"[_\-.]+", " ", tool_id)
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", spaced)
    spaced = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", spaced)
    words = []
    for word in spaced.split():
        lower = word.lower()
        if lower in SPECIAL_WORDS:
            words.append(SPECIAL_WORDS[lower])
        elif lower in ACRONYMS:
            words.append(lower.upper())
        else:
            words.append(word[:1].upper() + word[1:])
    return " ".join(words)


def compute_missing(upstream_ids: list[str], existing: dict[str, str]) -> list[tuple[str, str]]:
    known_friendly = {v.strip().lower() for v in existing.values()}
    known_canonical = {canonicalize_tool_id(k) for k in existing}
    missing: dict[str, str] = {}
    for tool_id in sorted(set(upstream_ids)):
        if not SAFE_ID_RE.match(tool_id):
            print(f"Skipping unsafe upstream tool id: {tool_id!r}", file=sys.stderr)
            continue
        matches = find_matches_for_new_tool(tool_id, existing)
        if matches["exact"] or matches["case_variant"] or matches["canonical_equivalent"]:
            continue
        canonical = canonicalize_tool_id(tool_id)
        friendly = friendly_name(tool_id)
        if canonical in known_canonical or friendly.lower() in known_friendly:
            continue
        known_canonical.add(canonical)
        known_friendly.add(friendly.lower())
        missing[tool_id] = friendly
    return sorted(missing.items())


def entry_line(tool_id: str, friendly: str) -> str:
    return f"  ,{json.dumps(tool_id)}: {json.dumps(friendly)}"


def prefix_of(tool_id: str) -> str:
    return re.split(r"[_.\-]", tool_id, maxsplit=1)[0].lower()


def inject(text: str, entries: list[tuple[str, str]]) -> str:
    """Insert entries after the last existing line sharing their prefix, else at the end."""
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.rstrip("\r\n").split(newline)
    for tool_id, friendly in entries:
        prefix = prefix_of(tool_id)
        insert_at = None
        # Index 0 is "{" and the last line is "}"; only touch entry lines.
        for i in range(1, len(lines) - 1):
            key = re.match(r'\s*,?\s*"((?:[^"\\]|\\.)*)"\s*:', lines[i])
            if key and prefix_of(json.loads(f'"{key.group(1)}"')) == prefix and len(prefix) > 2:
                insert_at = i + 1
        if insert_at is None:
            insert_at = len(lines) - 1
        lines.insert(insert_at, entry_line(tool_id, friendly))
    return newline.join(lines) + newline


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-file", required=True, type=Path, help="upstream toolNames.ts")
    parser.add_argument("--tool-names", required=True, type=Path, help="src/toolNames.json to update")
    args = parser.parse_args()

    try:
        upstream_ids = extract_tool_ids(args.upstream_file.read_text(encoding="utf-8"))
    except ValueError as err:
        print(f"::error::{err}")
        return 1
    if not upstream_ids:
        print(f"::error::No tool ids found in {args.upstream_file}; upstream layout changed?")
        return 1
    print(f"Upstream tool ids found: {len(upstream_ids)}")

    existing = load_tool_names(args.tool_names)
    missing = compute_missing(upstream_ids, existing)
    if not missing:
        print("NO_DELTA")
        return 0
    if len(missing) > MAX_NEW_ENTRIES:
        print(f"::error::{len(missing)} new tool ids exceeds the safety cap of {MAX_NEW_ENTRIES}; review manually.")
        return 1

    with open(args.tool_names, encoding="utf-8", newline="") as f:
        original = f.read()
    updated = inject(original, missing)
    json.loads(updated)  # must still be valid JSON
    with open(args.tool_names, "w", encoding="utf-8", newline="") as f:
        f.write(updated)
    for tool_id, friendly in missing:
        print(f"+ {tool_id} -> {friendly}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
