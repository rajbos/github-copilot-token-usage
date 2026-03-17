---
applyTo: ".github/workflows/**"
---

# Workflow Security: Validating Untrusted User Input

## Overview

Workflows in this repository that are triggered by untrusted user input (issue
bodies, PR descriptions, comments, branch names, etc.) **must** validate that
input for hidden characters and potential prompt injection before processing it.

This is especially important for workflows that pass user content to AI/LLM
systems (e.g. GitHub Copilot agents), but also applies to any automated
processing where a malicious actor could influence the workflow's behavior.

## The Central Validation Script

**`.github/workflows/validate-input.sh`** is the single, authoritative script
for this check. It detects:

| Threat | Description |
|--------|-------------|
| Bidirectional Unicode control characters | Trojan Source attack (CVE-2021-42574) — makes text look different to humans vs. AI |
| Zero-width / invisible characters | Hidden text injected between visible characters, invisible to human reviewers |
| Unicode tag characters (U+E0000–E007F) | Completely invisible; can encode arbitrary ASCII instructions |
| Unicode variation selectors | Can steganographically encode hidden data |
| HTML comment blocks (`<!-- ... -->`) | Stripped by GitHub's renderer but fully visible to LLMs processing raw Markdown |
| Non-printable control characters | Unexpected control bytes that may confuse parsers |

If any of the above are found, the script:
1. **Posts a warning comment** to the issue or PR, listing every finding and
   linking back to the workflow run that caught it.
2. **Exits with a non-zero code**, failing the workflow job immediately so that
   no further processing occurs on the untrusted content.

## How to Use the Script in a Workflow

Add a validation step **before** any step that reads or processes the untrusted
input. The step must run after the repository is checked out (so the script file
is available), and it needs a `GH_TOKEN` with write access to post comments.

```yaml
- name: Validate <input source> for hidden content
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    INPUT_TEXT: ${{ github.event.issue.body }}   # ← the untrusted text
    ITEM_NUMBER: ${{ github.event.issue.number }} # ← issue or PR number
    REPO: ${{ github.repository }}
    RUN_ID: ${{ github.run_id }}
    SERVER_URL: ${{ github.server_url }}
    CONTEXT_TYPE: issue          # "issue" or "pr"
    FINDINGS_FILE: /tmp/validation-findings.txt
  run: bash .github/workflows/validate-input.sh
```

For a pull request body, swap the event expressions and set `CONTEXT_TYPE: pr`:

```yaml
- name: Validate PR body for hidden content
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    INPUT_TEXT: ${{ github.event.pull_request.body }}
    ITEM_NUMBER: ${{ github.event.pull_request.number }}
    REPO: ${{ github.repository }}
    RUN_ID: ${{ github.run_id }}
    SERVER_URL: ${{ github.server_url }}
    CONTEXT_TYPE: pr
    FINDINGS_FILE: /tmp/validation-findings.txt
  run: bash .github/workflows/validate-input.sh
```

## Deciding Whether a Workflow Needs Validation

Apply the validation step when **all** of the following are true:

1. The workflow is triggered by a user-controllable event:
   `issues`, `issue_comment`, `pull_request`, `pull_request_review`,
   `pull_request_review_comment`, `discussion`, `discussion_comment`, etc.
2. The workflow reads a **text field** from the event payload that a user wrote:
   `.body`, `.title`, `.comment.body`, `.review.body`, branch names, etc.
3. That text is subsequently processed by an automated system (especially an AI).

You do **not** need the script for:
- Purely numeric fields like `issue.number` or `pull_request.number`.
- Internal, trusted triggers (`workflow_dispatch` with controlled inputs,
  `push` to protected branches, `schedule`, etc.).
- Metadata-only fields like `pull_request.draft` or `label.name`.

## Permissions

The validation step requires the `issues: write` (or `pull-requests: write`)
permission on the job so the `gh` CLI can post the warning comment:

```yaml
jobs:
  my-job:
    permissions:
      issues: write      # needed to post the warning comment
      contents: read
```

## Keeping the Script Up to Date

If you discover a new class of hidden-character or injection attack not already
covered, add a new detection block to `.github/workflows/validate-input.sh`
under its clearly-labelled sections. Keep detection logic inside the Python
heredoc so Unicode handling is reliable across all runners.

Document any new threat type with:
- A short comment explaining the attack and why it is dangerous.
- An example of the Unicode code points or patterns being detected.
- A human-readable finding message added to the `findings` list.
