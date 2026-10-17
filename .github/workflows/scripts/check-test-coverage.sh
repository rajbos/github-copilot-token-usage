#!/usr/bin/env bash
# Deterministic "test coverage companion" check.
#
# Catches the class of review finding "new source logic added without any test
# changes" without needing an LLM: if a PR touches production source files but
# no test files, the change ships without CI-visible test coverage updates and
# this job fails.
#
# Inputs (env):
#   BASE_SHA  — PR base sha (falls back to HEAD^)
#   HEAD_SHA  — PR head sha (falls back to HEAD)
#   PR_BODY   — PR body text; if it contains the marker [skip-test-check] the
#               check passes with a warning (documented escape hatch for
#               changes that genuinely cannot be unit-tested, e.g. pure
#               HTML/layout tweaks in webview code).
#
# Classification rules:
#   SOURCE: *.ts/*.tsx/*.js/*.cjs/*.mjs under vscode-extension/src/, cli/src/,
#           or the shared src/ folder.
#   TEST:   any path containing /test/, /tests/ or /__tests__/, or a filename
#           containing .test. or .spec. — in any directory of the repo.
#
# Changes that add no new logic need no test companion (the existing suite —
# type-check, lint, tests — still has to pass). Decisions key on added-line
# counts and content, never on a rename alone, so a rename cannot hide an edit:
#   - Deletion-only: a source file with 0 added lines (removed dead code or an
#     unused import, or a file deleted outright).
#   - Pure rename: a rename (git -M, >=50% similar) of a file that was already
#     production source, with 0 added lines (100% similar) or whose added lines
#     are all existing imports re-pointed by the rename (see below). Moving a
#     file in from outside the source trees (examples/, tests) needs a test.
#   - Import-path update: a modified file whose added lines are all imports.
#   An added import line is exempt only if it is the twin of a removed import
#   line once module specifiers are resolved to repo paths (explicit extensions preserved)
#   and a renamed file's new path is mapped back to its old one. A brand-new
#   import, or one re-pointed at a different module, needs a test.
#   Limit: only static single-line import / 'export ... from' / require
#   statements are recognised; a reformatted multi-line import block counts as
#   real logic. Use [skip-test-check] for such cases.
set -euo pipefail

BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"
PR_BODY="${PR_BODY:-}"

if [ -z "$HEAD_SHA" ]; then
  HEAD_SHA="$(git rev-parse HEAD)"
fi

if [ -z "$BASE_SHA" ]; then
  BASE_SHA="$(git rev-parse "${HEAD_SHA}^" 2>/dev/null || true)"
fi

if [ -z "$BASE_SHA" ]; then
  echo "No base commit available; nothing to check. PASS."
  exit 0
fi

if git merge-base "$BASE_SHA" "$HEAD_SHA" >/dev/null 2>&1; then
  RANGE=("${BASE_SHA}...${HEAD_SHA}")
else
  RANGE=("${BASE_SHA}" "${HEAD_SHA}")
fi

# Materialise the numstat in a checked command (NUL bytes cannot live in a
# shell variable, and process substitution would hide git's exit status): an
# unreadable diff must fail closed, not look like an empty passing changeset.
NUMSTAT_FILE="$(mktemp)"
trap 'rm -f "$NUMSTAT_FILE"' EXIT
if ! git diff -M --numstat -z "${RANGE[@]}" > "$NUMSTAT_FILE"; then
  echo "::error::git diff failed for ${RANGE[*]}; cannot determine the changeset, so the coverage check fails closed."
  exit 1
fi

# NUL-delimited numstat with rename detection. Records are
# "<added>\t<deleted>\t<path>\0" or, for renames,
# "<added>\t<deleted>\t\0<old>\0<new>\0".
REC_ADDED=(); REC_OLD=(); REC_PATH=()
while IFS= read -r -d '' rec <&3; do
  IFS=$'\t' read -r added _deleted file <<< "$rec"
  old=""
  if [ -z "$file" ]; then
    IFS= read -r -d '' old <&3
    IFS= read -r -d '' file <&3
  fi
  REC_ADDED+=("$added"); REC_OLD+=("$old"); REC_PATH+=("$file")
done 3< "$NUMSTAT_FILE"

if [ "${#REC_PATH[@]}" -eq 0 ]; then
  echo "Empty changeset; nothing to check. PASS."
  exit 0
fi

is_test_file() {
  case "$1" in
    */test/*|*/tests/*|*/__tests__/*|test/*|tests/*|__tests__/*) return 0 ;;
  esac
  case "$(basename "$1")" in
    *.test.*|*.spec.*) return 0 ;;
  esac
  return 1
}

is_source_file() {
  case "$1" in
    vscode-extension/src/*|cli/src/*|src/*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *.ts|*.tsx|*.js|*.cjs|*.mjs) return 0 ;;
  esac
  return 1
}

# One added diff line that is purely a static single-line import,
# `export ... from` re-export or `const x = require(...)`. A plain
# `export const x = "..."` is deliberately NOT matched: it adds data/logic.
Q="['\"]"
IMPORT_LINE_RE="^\+[[:space:]]*(import[[:space:]]+(type[[:space:]]+)?([^;='\"]+[[:space:]]+from[[:space:]]*)?${Q}[^'\"]+${Q}|export[[:space:]]+(type[[:space:]]+)?(\*([[:space:]]+as[[:space:]]+[A-Za-z_\$][A-Za-z0-9_\$]*)?|\{[^}]*\})[[:space:]]*from[[:space:]]*${Q}[^'\"]+${Q}|\}[[:space:]]*from[[:space:]]*${Q}[^'\"]+${Q}|(const|let|var)[[:space:]]+[A-Za-z_\$][A-Za-z0-9_\$]*[[:space:]]*=[[:space:]]*require\([[:space:]]*${Q}[^'\"]+${Q}[[:space:]]*\))[[:space:]]*;?[[:space:]]*(//.*)?$"

# diff_lines <+|-> <old-or-empty> <path>: added or removed lines of one file's diff.
diff_lines() {
  local sign="$1"
  # Only records inside @@ hunks: a content line that merely starts with "++ "
  # or "-- " (shown as "+++ "/"--- ") must not be mistaken for a file header.
  git diff -M -U0 --no-ext-diff "${RANGE[@]}" -- ${2:+"$2"} "$3" \
    | awk -v s="$sign" '/^@@/ {h=1; next} h && substr($0,1,1)==s {print}'
}

# strip_ext <path>: drop a trailing extension from the last path segment;
# declaration files (.d.ts/.d.mts/.d.cts) lose the compound extension.
strip_ext() {
  case "${1##*/}" in
    *.d.ts|*.d.mts|*.d.cts) printf '%s' "$1" | sed -E 's/\.d\.[mc]?ts$//' ;;
    *.*) printf '%s' "${1%.*}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# collapse_path <path>: resolve "." and ".." segments lexically.
collapse_path() {
  local seg out=() IFS=/
  for seg in $1; do
    case "$seg" in
      ""|.) ;;
      ..) if [ "${#out[@]}" -gt 0 ] && [ "${out[${#out[@]}-1]}" != ".." ]; then
           unset 'out[${#out[@]}-1]'
         else
           out+=("..")   # keep parents above the repo root so they stay distinct
         fi ;;
      *) out+=("$seg") ;;
    esac
  done
  printf '%s' "${out[*]}"
}

# Every "<path-without-extension> <path>" in the base and head trees. An
# extensionless or directory import is only mapped through a rename when no
# other file competes for the same stem (old.ts vs old.js, adapters.ts vs
# adapters/index.ts): module resolution order is then ambiguous, so the
# exemption is declined and a test is required.
if ! BASE_TREE="$(git ls-tree -r --name-only "$BASE_SHA")" || ! HEAD_TREE="$(git ls-tree -r --name-only "$HEAD_SHA")"; then
  echo "::error::git ls-tree failed; cannot inspect the repository trees, so the coverage check fails closed."
  exit 1
fi
STEMS="$(printf '%s\n%s\n' "$BASE_TREE" "$HEAD_TREE" | sort -u \
  | awk '{ s=$0; if (s ~ /\.d\.[mc]?ts$/) sub(/\.d\.[mc]?ts$/, "", s); else if (s ~ /\.[^.\/]*$/) sub(/\.[^.\/]*$/, "", s); printf "%s\t%s\n", s, $0 }')"
# stem_is_unique <stem> <path>: no file other than <path> has this stem.
stem_is_unique() {
  ! printf '%s\n' "$STEMS" | awk -F'\t' -v s="$1" -v x="$2" '$1==s && $2!=x {f=1} END {exit !f}'
}

# "<new path>TAB<old path>" (tab-delimited: paths may contain spaces) for each file renamed in this PR: with the extension
# (explicit imports), without it (extensionless imports) and, for renamed index
# modules, the directory itself (directory imports).
RENAME_MAP=""
for i in "${!REC_PATH[@]}"; do
  if [ -n "${REC_OLD[$i]}" ]; then
    np="${REC_PATH[$i]}"; op="${REC_OLD[$i]}"
    RENAME_MAP="${RENAME_MAP}${np}"$'	'"${op}"$'\n'
    if stem_is_unique "$(strip_ext "$np")" "$np" && stem_is_unique "$(strip_ext "$op")" "$op"; then
      RENAME_MAP="${RENAME_MAP}$(strip_ext "$np")"$'	'"$(strip_ext "$op")"$'\n'
      if [[ "$(strip_ext "$(basename "$np")")" == index && "$(strip_ext "$(basename "$op")")" == index ]] \
         && stem_is_unique "$(dirname "$np")" "" && stem_is_unique "$(dirname "$op")" ""; then
        RENAME_MAP="${RENAME_MAP}$(dirname "$np")"$'	'"$(dirname "$op")"$'\n'
      fi
    fi
  fi
done

# norm_import <line> <dir>: an import line with its module specifier resolved
# to a repo-relative path (explicit extensions kept, so ./mod.js and ./mod.ts
# stay distinct; relative to <dir>, the directory the
# importing file lived in at that side of the diff), mapping a renamed file's
# new path back to its old one. A rename-driven path update therefore
# normalises to the same string as the line it replaced, while two different
# modules that merely share a basename (./first/types vs ./second/types) stay
# distinct. Bare package specifiers are kept as written. Leading +/- dropped.
norm_import() {
  local line="${1:1}" spec resolved old
  spec="$(printf '%s' "$line" | grep -oE "${Q}[^'\"]+${Q}" | tail -1 | tr -d "'\"")"
  resolved="$spec"
  if [[ "$spec" == .* ]]; then
    resolved="$(collapse_path "$2/$spec")"
    old="$(printf '%s' "$RENAME_MAP" | awk -F'	' -v p="$resolved" '$1==p {print $2; exit}')"
    resolved="${old:-$resolved}"
  fi
  # Collapse whitespace around the specifier only; the specifier itself stays
  # verbatim so './foo  bar' and './foo bar' remain distinct modules.
  line="${line/"$spec"/@@SPEC@@}"
  line="$(printf '%s' "$line" | tr -s '[:space:]' ' ')"
  printf '%s' "${line/@@SPEC@@/"$resolved"}"
}

# only_imports <added-lines> <removed-lines> <added-dir> <removed-dir>: every
# added line is an import statement AND is the rename-normalised twin of a
# distinct removed import line, i.e. an existing import re-pointed at a renamed
# file. A brand-new import, or one re-pointed at a different module, has no
# twin and fails.
only_imports() {
  local line removed="" r
  while IFS= read -r r; do
    [ -z "$r" ] && continue
    [[ "+${r:1}" =~ $IMPORT_LINE_RE ]] && removed="${removed}$(norm_import "$r" "$4")"$'\n'
  done <<< "$2"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [[ "$line" =~ $IMPORT_LINE_RE ]] || return 1
    r="$(norm_import "$line" "$3")"
    printf '%s' "$removed" | grep -qxF -- "$r" || return 1
    removed="$(printf '%s' "$removed" | awk -v r="$r" '!d && $0==r {d=1; next} {print}')"$'\n'
  done <<< "$1"
  return 0
}

SOURCE_FILES=""
DELETION_ONLY_FILES=""
RENAME_ONLY_FILES=""
IMPORT_ONLY_FILES=""
TEST_FILES=""
for i in "${!REC_PATH[@]}"; do
  file="${REC_PATH[$i]}"; old="${REC_OLD[$i]}"; added="${REC_ADDED[$i]}"
  if is_test_file "$file"; then
    TEST_FILES="${TEST_FILES}${file}"$'\n'
  elif is_source_file "$file"; then
    if [ "$added" = "0" ] && [ -z "$old" ]; then
      DELETION_ONLY_FILES="${DELETION_ONLY_FILES}${file}"$'\n'
    # A rename only counts as a pure source rename when the old path was
    # already production source; moving a file in from examples/ or a test
    # directory, or promoting a test file (src/test/x.ts -> src/x.ts), introduces
    # new production code.
    elif [ -n "$old" ] && [ "$added" != "-" ] && is_source_file "$old" && ! is_test_file "$old" && { [ "$added" = "0" ] || only_imports "$(diff_lines + "$old" "$file")" "$(diff_lines - "$old" "$file")" "$(dirname "$file")" "$(dirname "$old")"; }; then
      RENAME_ONLY_FILES="${RENAME_ONLY_FILES}${old} -> ${file}"$'\n'
    elif [ -z "$old" ] && [ "$added" != "-" ] && only_imports "$(diff_lines + "" "$file")" "$(diff_lines - "" "$file")" "$(dirname "$file")" "$(dirname "$file")"; then
      IMPORT_ONLY_FILES="${IMPORT_ONLY_FILES}${file}"$'\n'
    else
      SOURCE_FILES="${SOURCE_FILES}${file}"$'\n'
    fi
  fi
done

if [ -z "$SOURCE_FILES" ]; then
  if [ -n "${DELETION_ONLY_FILES}${RENAME_ONLY_FILES}${IMPORT_ONLY_FILES}" ]; then
    echo "Source changes add no new logic (deletions, pure renames, import-path updates); no test companion needed. PASS."
    if [ -n "$DELETION_ONLY_FILES" ]; then
      echo "Deletion-only source files:"; printf '%s' "$DELETION_ONLY_FILES" | sed 's/^/  - /'
    fi
    if [ -n "$RENAME_ONLY_FILES" ]; then
      echo "Pure renames:"; printf '%s' "$RENAME_ONLY_FILES" | sed 's/^/  - /'
    fi
    if [ -n "$IMPORT_ONLY_FILES" ]; then
      echo "Import-path updates for renamed files:"; printf '%s' "$IMPORT_ONLY_FILES" | sed 's/^/  - /'
    fi
  else
    echo "No production source files changed. PASS."
  fi
  exit 0
fi

if [ -n "$TEST_FILES" ]; then
  echo "Source files changed together with test files. PASS."
  echo "Test files touched:"
  printf '%s' "$TEST_FILES" | sed 's/^/  - /'
  exit 0
fi

if [[ "$PR_BODY" == *"[skip-test-check]"* ]]; then
  echo "::warning::Source files changed without test changes, but the PR body contains [skip-test-check]; passing."
  exit 0
fi

cat <<EOF
::error::Source files changed but no test files were added or modified.

Source files without a test-file companion change:
$(printf '%s' "$SOURCE_FILES" | sed 's/^/  - /')

Deletion-only changes, pure renames (import-path edits only) and import-path
updates for files renamed in the same PR are exempt automatically; the files
above add other lines.

Add or update tests covering this change, or — if the change genuinely cannot
be unit-tested — add the marker [skip-test-check] to the PR body explaining why.
EOF
exit 1
