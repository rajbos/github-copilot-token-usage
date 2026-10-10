#!/usr/bin/env python3
"""Unit tests for sync_toolnames.py.

Run directly with: python3 .github/scripts/test_sync_toolnames.py -v
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from toolnames_utils import find_new_duplicate_groups
from sync_toolnames import compute_missing, extract_tool_ids, friendly_name, inject

UPSTREAM = """
export enum ToolName {
	// ignore me: Ignored = 'comment_tool',
	ReadFile = 'read_file',
	RunInTerminal = "run_in_terminal",
	Evil = 'x"; rm -rf /',
}
export enum ContributedToolName {
	GitHubThing = 'copilot_githubThing',
}
export enum Other { Nope = 'not_a_tool' }
"""


class SyncToolNamesTests(unittest.TestCase):
    def test_extracts_only_tool_enums_and_ignores_comments(self):
        self.assertEqual(
            extract_tool_ids(UPSTREAM),
            ["read_file", "run_in_terminal", "copilot_githubThing"],
        )

    def test_missing_enum_fails_loudly(self):
        only_tool_name = "export enum ToolName {\n\tA = 'a_tool',\n}\n"
        only_contributed = "export enum ContributedToolName {\n\tB = 'b_tool',\n}\n"
        with self.assertRaisesRegex(ValueError, "ContributedToolName"):
            extract_tool_ids(only_tool_name)
        with self.assertRaisesRegex(ValueError, r"enum ToolName not found"):
            extract_tool_ids(only_contributed)

    def test_duplicate_gate_ignores_historical_but_catches_new(self):
        base = {"copilot_findFiles": "Find Files", "opilot_findFiles": "Find Files"}
        self.assertEqual(find_new_duplicate_groups(base, base), ({}, {}))
        head = {**base, "new_tool": "New Tool", "new-tool": "New Tool"}
        strict, _ = find_new_duplicate_groups(head, base)
        self.assertEqual(len(strict), 1)

    def test_friendly_names(self):
        self.assertEqual(friendly_name("copilot_readFile"), "Copilot Read File")
        self.assertEqual(friendly_name("mcp.io.github.git"), "MCP IO GitHub Git")
        self.assertEqual(friendly_name("vscode_command"), "VSCode Command")

    def test_missing_skips_known_canonical_and_unsafe_ids(self):
        existing = {"read_file": "Read File", "mcp_io_github_git_get_tag": "GitHub MCP: Get Tag"}
        upstream = ["read_file", "ReAd_File", "github-mcp-server-get_tag", 'x"; rm', "new_tool", "new_tool"]
        self.assertEqual(compute_missing(upstream, existing), [("new_tool", "New Tool")])

    def test_inject_groups_by_prefix_and_keeps_style_and_crlf(self):
        text = '{\r\n  "unknown": "Unknown"\r\n  ,"copilot_a": "A"\r\n  ,"other": "Other"\r\n}\r\n'
        out = inject(text, [("copilot_b", "B"), ("zzz", "Z")])
        self.assertIn('  ,"copilot_a": "A"\r\n  ,"copilot_b": "B"\r\n  ,"other"', out)
        self.assertTrue(out.endswith('  ,"zzz": "Z"\r\n}\r\n'))
        self.assertEqual(json.loads(out)["zzz"], "Z")


if __name__ == "__main__":
    unittest.main()
