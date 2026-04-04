#!/usr/bin/env bash
# validate-input.sh
#
# Central script for validating untrusted user input in GitHub Actions workflows.
# Detects hidden Unicode characters, invisible text, and HTML comment injection
# that could be used for prompt injection attacks against AI/LLM systems.
#
# Usage: source this script or call it directly after setting the required
# environment variables listed below.
#
# Required environment variables:
#   INPUT_TEXT   - The untrusted text to validate (e.g. issue body, PR body)
#   ITEM_NUMBER  - Issue or PR number used to post a warning comment
#   REPO         - Repository in "owner/repo" format
#   GH_TOKEN     - GitHub token with permission to write comments
#
# Optional environment variables:
#   CONTEXT_TYPE - "issue" or "pr" (default: "issue")
#   RUN_ID       - Workflow run ID for linking back to this run
#   SERVER_URL   - GitHub server URL (default: https://github.com)

set -euo pipefail

INPUT_TEXT="${INPUT_TEXT:-}"
ITEM_NUMBER="${ITEM_NUMBER:-}"
REPO="${REPO:-}"
CONTEXT_TYPE="${CONTEXT_TYPE:-issue}"
RUN_ID="${RUN_ID:-}"
SERVER_URL="${SERVER_URL:-https://github.com}"

FINDINGS_FILE="/tmp/validation-findings.txt"
rm -f "$FINDINGS_FILE"

echo "=== Validating untrusted user input for security threats ==="

# Run the full Unicode and injection analysis in Python, which handles
# Unicode categories reliably across all platforms.
python3 - << 'PYEOF'
import os
import re
import sys
import unicodedata

input_text = os.environ.get("INPUT_TEXT", "")
findings = []

MAX_INPUT_CHARS = 200_000  # guard against extremely large payloads (~200 KB of ASCII)
if len(input_text) > MAX_INPUT_CHARS:
    input_text = input_text[:MAX_INPUT_CHARS]
    print("Warning: input was truncated to 200,000 characters for validation", file=sys.stderr)

# ── 1. Bidirectional text control characters ─────────────────────────────────
# These are used in the "Trojan Source" class of attacks (CVE-2021-42574).
# They make rendered text appear different from the actual bytes, hiding
# malicious instructions from human reviewers while LLMs still process them.
BIDI_CHARS = {
    0x200E: "LEFT-TO-RIGHT MARK",
    0x200F: "RIGHT-TO-LEFT MARK",
    0x202A: "LEFT-TO-RIGHT EMBEDDING",
    0x202B: "RIGHT-TO-LEFT EMBEDDING",
    0x202C: "POP DIRECTIONAL FORMATTING",
    0x202D: "LEFT-TO-RIGHT OVERRIDE",
    0x202E: "RIGHT-TO-LEFT OVERRIDE",
    0x2066: "LEFT-TO-RIGHT ISOLATE",
    0x2067: "RIGHT-TO-LEFT ISOLATE",
    0x2068: "FIRST STRONG ISOLATE",
    0x2069: "POP DIRECTIONAL ISOLATE",
}
found_bidi = [name for cp, name in BIDI_CHARS.items() if chr(cp) in input_text]
if found_bidi:
    findings.append(
        "Bidirectional Unicode control characters detected "
        f"({', '.join(found_bidi[:3])}{'...' if len(found_bidi) > 3 else ''}) — "
        "these can make content appear different to humans than to AI systems "
        "(Trojan Source / CVE-2021-42574)"
    )

# ── 2. Zero-width and invisible characters ────────────────────────────────────
# Invisible to human readers but processed by AI models — ideal for hiding
# secret instructions inside otherwise normal-looking text.
INVISIBLE_CHARS = {
    0x00AD: "SOFT HYPHEN",
    0x200B: "ZERO WIDTH SPACE",
    0x200C: "ZERO WIDTH NON-JOINER",
    0x200D: "ZERO WIDTH JOINER",
    0x2060: "WORD JOINER",
    0xFEFF: "ZERO WIDTH NO-BREAK SPACE (BOM)",
}
found_invisible = [name for cp, name in INVISIBLE_CHARS.items() if chr(cp) in input_text]
if found_invisible:
    findings.append(
        "Invisible/zero-width Unicode characters detected "
        f"({', '.join(found_invisible[:3])}{'...' if len(found_invisible) > 3 else ''}) — "
        "these are not visible to human reviewers but are processed by AI systems"
    )

# ── 3. Unicode tag characters (U+E0000–U+E007F) ───────────────────────────────
# A block of characters originally reserved for language tags. Completely
# invisible in most renderers but can encode arbitrary ASCII text.
tag_chars = [c for c in input_text if 0xE0000 <= ord(c) <= 0xE007F]
if tag_chars:
    findings.append(
        f"Unicode tag characters detected ({len(tag_chars)} character(s) in U+E0000–E007F range) — "
        "these are fully invisible and can encode hidden ASCII messages"
    )

# ── 4. Variation selectors ────────────────────────────────────────────────────
# Variation selectors modify the appearance of the preceding character but can
# also be abused to encode hidden information steganographically.
variation_selectors = [
    c for c in input_text
    if (0xFE00 <= ord(c) <= 0xFE0F) or (0xE0100 <= ord(c) <= 0xE01EF)
]
if variation_selectors:
    findings.append(
        f"Unicode variation selectors detected ({len(variation_selectors)} character(s)) — "
        "these can be used to steganographically encode hidden data"
    )

# ── 5. HTML comments ──────────────────────────────────────────────────────────
# HTML comments are stripped by GitHub's Markdown renderer, making them
# invisible to human readers, but an LLM processing the raw source will see
# and potentially act on any instructions hidden inside them.
if re.search(r"<!--.*?-->", input_text, re.DOTALL):
    findings.append(
        "HTML comment block(s) detected (<!-- ... -->) — "
        "these are hidden from the rendered view but visible to AI systems "
        "processing the raw source, making them a common prompt injection vector"
    )

# ── 6. Non-printable control characters ──────────────────────────────────────
# Excludes ordinary whitespace (tab, LF, CR) which are expected in text.
ALLOWED_CONTROL = {0x09, 0x0A, 0x0D}  # HT, LF, CR
control_chars = [
    c for c in input_text
    if unicodedata.category(c) == "Cc" and ord(c) not in ALLOWED_CONTROL
]
if control_chars:
    findings.append(
        f"Non-printable control characters detected ({len(control_chars)} character(s)) — "
        "unexpected control characters may indicate an attempt to confuse parsers or renderers"
    )

# Write findings to a temp file so the calling shell script can build the comment
findings_file = os.environ.get("FINDINGS_FILE", "/tmp/validation-findings.txt")
with open(findings_file, "w") as fh:
    for f in findings:
        fh.write(f + "\n")

if findings:
    print(f"⚠️  Found {len(findings)} security concern(s) in input", file=sys.stderr)
    sys.exit(1)
else:
    print("✅ No suspicious content detected", file=sys.stderr)
    sys.exit(0)
PYEOF
VALIDATION_EXIT=$?

if [ "$VALIDATION_EXIT" -ne 0 ]; then
    WORKFLOW_URL="${SERVER_URL}/${REPO}/actions/runs/${RUN_ID}"

    # Build the warning comment
    {
        echo "## ⚠️ Security Warning: Suspicious Input Detected"
        echo ""
        echo "This ${CONTEXT_TYPE} contains content that may be used for **prompt injection** — an attack that hides instructions inside text to manipulate AI/LLM systems processing it."
        echo ""
        echo "### Findings"
        echo ""
        while IFS= read -r line; do
            echo "- ${line}"
        done < "$FINDINGS_FILE"
        echo ""
        echo "### What this means"
        echo ""
        echo "Hidden Unicode characters or HTML comments can be invisible to human reviewers while still being read and acted upon by AI models. This is a known technique for injecting malicious instructions into AI-assisted workflows."
        echo ""
        echo "**Action required:** Please review and edit the ${CONTEXT_TYPE} to remove any hidden characters before this workflow can proceed. If you believe this is a false positive, please contact a repository maintainer."
        echo ""
        if [ -n "${RUN_ID}" ]; then
            echo "_Detected by [workflow run #${RUN_ID}](${WORKFLOW_URL})_"
        else
            echo "_Detected by an automated security validation step._"
        fi
    } > /tmp/security-comment.md

    echo "=== Posting security warning comment to ${CONTEXT_TYPE} #${ITEM_NUMBER} ==="
    if [ "${CONTEXT_TYPE}" = "pr" ]; then
        gh pr comment "${ITEM_NUMBER}" --repo "${REPO}" --body-file /tmp/security-comment.md
    else
        gh issue comment "${ITEM_NUMBER}" --repo "${REPO}" --body-file /tmp/security-comment.md
    fi

    echo "::error::Input validation failed: suspicious content detected. See comment on ${CONTEXT_TYPE} #${ITEM_NUMBER} for details."
    exit 1
fi

echo "✅ Input validation passed — no suspicious content detected"
