import test from 'node:test';
import * as assert from 'node:assert/strict';

import { resolveGuidMcpToolName, isGuidMcpTool, resolveMcpFamilyToolName, isMcpFamilyResolvedTool, canonicalizeToolId, lookupKnownToolName, isKnownToolDisplayName } from '../../../src/utils/toolUtils';
import toolNamesData from '../../../src/toolNames.json';

// ── resolveGuidMcpToolName ───────────────────────────────────────────────────

test('resolveGuidMcpToolName: returns friendly name for GUID-keyed MCP tool', () => {
	const result = resolveGuidMcpToolName('mcp__e292a297-0140-4fb7-a4de-39bd4e3f0fd6__sharepoint_search');
	assert.equal(result, 'Claude MCP: M365 Connector - Sharepoint Search');
});

test('resolveGuidMcpToolName: formats multi-word tool name with title case', () => {
	const result = resolveGuidMcpToolName('mcp__e292a297-0140-4fb7-a4de-39bd4e3f0fd6__sharepoint_folder_search');
	assert.equal(result, 'Claude MCP: M365 Connector - Sharepoint Folder Search');
});

test('resolveGuidMcpToolName: handles read_resource tool', () => {
	const result = resolveGuidMcpToolName('mcp__e292a297-0140-4fb7-a4de-39bd4e3f0fd6__read_resource');
	assert.equal(result, 'Claude MCP: M365 Connector - Read Resource');
});

test('resolveGuidMcpToolName: works with any tenant GUID', () => {
	const result = resolveGuidMcpToolName('mcp__a1b2c3d4-0000-1111-2222-333344445555__some_tool');
	assert.equal(result, 'Claude MCP: M365 Connector - Some Tool');
});

test('resolveGuidMcpToolName: returns undefined for non-GUID mcp__ tool', () => {
	assert.equal(resolveGuidMcpToolName('mcp__github__create_issue'), undefined);
});

test('resolveGuidMcpToolName: returns undefined for non-MCP tool', () => {
	assert.equal(resolveGuidMcpToolName('run_in_terminal'), undefined);
});

test('resolveGuidMcpToolName: returns undefined for mcp_ (underscore) format', () => {
	assert.equal(resolveGuidMcpToolName('mcp_io_github_git_list_issues'), undefined);
});

// ── isGuidMcpTool ────────────────────────────────────────────────────────────

test('isGuidMcpTool: returns true for GUID-keyed MCP tool', () => {
	assert.ok(isGuidMcpTool('mcp__e292a297-0140-4fb7-a4de-39bd4e3f0fd6__sharepoint_search'));
});

test('isGuidMcpTool: returns true for any tenant GUID', () => {
	assert.ok(isGuidMcpTool('mcp__a1b2c3d4-0000-1111-2222-333344445555__tool'));
});

test('isGuidMcpTool: returns false for non-GUID mcp__ tool', () => {
	assert.equal(isGuidMcpTool('mcp__github__create_issue'), false);
});

test('isGuidMcpTool: returns false for regular tool', () => {
	assert.equal(isGuidMcpTool('run_in_terminal'), false);
});

test('isGuidMcpTool: returns false for mcp_ (underscore) format', () => {
	assert.equal(isGuidMcpTool('mcp_io_github_git_list_issues'), false);
});

// ── resolveMcpFamilyToolName ─────────────────────────────────────────────────
// Regression coverage for issue #1760: new MCP client/server-registration
// spellings of an already-recognized tool must resolve without a literal
// toolNames.json entry for every possible prefix.

test('resolveMcpFamilyToolName: resolves bare Claude Code GitHub MCP registration', () => {
	assert.equal(resolveMcpFamilyToolName('mcp__github__create_pull_request'), 'GitHub MCP: Create Pull Request');
	assert.equal(resolveMcpFamilyToolName('mcp__github__list_pull_requests'), 'GitHub MCP: List Pull Requests');
	assert.equal(resolveMcpFamilyToolName('mcp__github__pull_request_read'), 'GitHub MCP: Pull Request Read');
	assert.equal(resolveMcpFamilyToolName('mcp__github__update_pull_request'), 'GitHub MCP: Update Pull Request');
});

test('resolveMcpFamilyToolName: resolves VS Code plugin-marketplace Playwright registration', () => {
	assert.equal(
		resolveMcpFamilyToolName('mcp__plugin_playwright_playwright__browser_click'),
		'Playwright MCP: Browser Click'
	);
	assert.equal(
		resolveMcpFamilyToolName('mcp__plugin_playwright_playwright__browser_take_screenshot'),
		'Playwright MCP: Browser Take Screenshot'
	);
});

test('resolveMcpFamilyToolName: resolves other known prefix spellings for the same families', () => {
	assert.equal(resolveMcpFamilyToolName('mcp_github_mcp_se_issue_write'), 'GitHub MCP: Issue Write');
	assert.equal(resolveMcpFamilyToolName('mcp_playwright_browser_navigate'), 'Playwright MCP: Browser Navigate');
	assert.equal(resolveMcpFamilyToolName('mcp_context7_resolve_library_id'), 'Context7 MCP: Resolve Library Id');
	assert.equal(resolveMcpFamilyToolName('mcp_tavily_tavily_search'), 'Tavily MCP: Tavily Search');
	assert.equal(resolveMcpFamilyToolName('mcp__claude-in-chrome__navigate'), 'Claude Browser MCP: Navigate');
});

test('resolveMcpFamilyToolName: does NOT resolve a VS Code 13-char-truncated prefix (needs a literal entry)', () => {
	// "mcp_microsoft_pla_" truncates "microsoft_playwright" to 13 chars — the
	// literal keyword "playwright" never appears, so this intentionally falls
	// through to the literal toolNames.json entry rather than this resolver.
	assert.equal(resolveMcpFamilyToolName('mcp_microsoft_pla_browser_navigate'), undefined);
});

test('resolveMcpFamilyToolName: returns undefined for unrelated tools', () => {
	assert.equal(resolveMcpFamilyToolName('shell_command'), undefined);
	assert.equal(resolveMcpFamilyToolName('Apply Patch'), undefined);
	assert.equal(resolveMcpFamilyToolName('run_in_terminal'), undefined);
});

test('resolveMcpFamilyToolName: does not match a family action without the family keyword present', () => {
	assert.equal(resolveMcpFamilyToolName('mcp__foo__create_pull_request'), undefined);
});

// ── isMcpFamilyResolvedTool ───────────────────────────────────────────────────

test('isMcpFamilyResolvedTool: true for a new-prefix family match', () => {
	assert.ok(isMcpFamilyResolvedTool('mcp__github__create_pull_request'));
	assert.ok(isMcpFamilyResolvedTool('mcp__plugin_playwright_playwright__browser_click'));
});

test('isMcpFamilyResolvedTool: false for tools outside known families', () => {
	assert.equal(isMcpFamilyResolvedTool('shell_command'), false);
});

// Regression coverage for issue #1761: a differently-cased VS Code server alias
// ("Microsoft_Learn") and a not-yet-seen GitHub action ("get_label").

test('resolveMcpFamilyToolName: resolves Microsoft Learn docs tools under a mixed-case VS Code alias', () => {
	assert.equal(
		resolveMcpFamilyToolName('mcp_Microsoft_Learn_microsoft_docs_fetch'),
		'Microsoft Docs MCP: Docs Fetch'
	);
	assert.equal(
		resolveMcpFamilyToolName('mcp_Microsoft_Learn_microsoft_docs_search'),
		'Microsoft Docs MCP: Docs Search'
	);
});

test('resolveMcpFamilyToolName: resolves GitHub get_label under an unseen server alias', () => {
	assert.equal(resolveMcpFamilyToolName('mcp_github_mcp_s13be_get_label'), 'GitHub MCP: Get Label');
	assert.equal(resolveMcpFamilyToolName('mcp_github_mcp_s13be_issue_write'), 'GitHub MCP: Issue Write');
});

// ── canonicalizeToolId ───────────────────────────────────────────────────────
// Regression coverage for issue #1942: "ListAgents" (PascalCase, as reported
// by one host) should canonicalize the same as an existing "list_agents"
// entry, mirroring canonicalize_tool_id() in .github/scripts/toolnames_utils.py.

test('canonicalizeToolId: PascalCase matches snake_case', () => {
	assert.equal(canonicalizeToolId('ListAgents'), canonicalizeToolId('list_agents'));
});

test('canonicalizeToolId: camelCase matches snake_case', () => {
	assert.equal(canonicalizeToolId('readFile'), canonicalizeToolId('read_file'));
});

test('canonicalizeToolId: acronym run splits before the trailing word', () => {
	assert.equal(canonicalizeToolId('HTTPServer'), canonicalizeToolId('http_server'));
});

test('canonicalizeToolId: plain snake_case is unchanged', () => {
	assert.equal(canonicalizeToolId('list_agents'), 'list_agents');
});

// ── lookupKnownToolName ──────────────────────────────────────────────────────

test('lookupKnownToolName: returns exact match', () => {
	assert.equal(lookupKnownToolName('list_agents', { list_agents: 'List Agents' }), 'List Agents');
});

test('lookupKnownToolName: returns case-insensitive match', () => {
	assert.equal(lookupKnownToolName('List_Agents', { list_agents: 'List Agents' }), 'List Agents');
});

test('lookupKnownToolName: returns canonicalized match for a PascalCase id', () => {
	// The exact scenario from issue #1942: a host reports "ListAgents" but
	// toolNames.json only has the snake_case "list_agents" entry.
	assert.equal(lookupKnownToolName('ListAgents', { list_agents: 'List Agents' }), 'List Agents');
});

test('lookupKnownToolName: returns undefined when nothing matches', () => {
	assert.equal(lookupKnownToolName('totally_unknown_tool', { list_agents: 'List Agents' }), undefined);
});

// ── issue #2223: equivalent MCP-prefix entries and server display names ─────
// The "Toolnames Checkup" comment (toolnames_utils.py) reported these as
// equivalent to an existing entry; the extension must agree and resolve them.

test('canonicalizeToolId: Claude_Browser and claude-in-chrome prefixes are equivalent', () => {
	assert.equal(
		canonicalizeToolId('mcp__Claude_Browser__browser_batch'),
		canonicalizeToolId('mcp__claude-in-chrome__browser_batch'),
	);
	assert.equal(canonicalizeToolId('mcp__Claude_Browser__browser_batch'), 'claude_browser_browser_batch');
});

test('canonicalizeToolId: numeric collision suffix on a server prefix is ignored', () => {
	assert.equal(canonicalizeToolId('mcp_context73_query_docs'), canonicalizeToolId('mcp_context7_query_docs'));
});

test('canonicalizeToolId: GitHub local and remote prefixes are equivalent', () => {
	assert.equal(canonicalizeToolId('mcp.io.github.git.issue_read'), canonicalizeToolId('mcp_github_github_issue_read'));
});

test('lookupKnownToolName: resolves an equivalent MCP-prefix entry (issue #2223)', () => {
	const map = { 'mcp__claude-in-chrome__browser_batch': 'MCP: Claude In Chrome - Browser Batch' };
	assert.equal(lookupKnownToolName('mcp__Claude_Browser__browser_batch', map), 'MCP: Claude In Chrome - Browser Batch');
});

test('lookupKnownToolName: every issue #2223 equivalent id resolves against the real toolNames.json', () => {
	assert.ok(lookupKnownToolName('mcp__Claude_Browser__browser_batch', toolNamesData as Record<string, string>));
});

test('isKnownToolDisplayName: matches a server part of a friendly name', () => {
	const map = { 'mcp__ccd_session__mark_chapter': 'CCD Session: Mark Chapter' };
	assert.equal(isKnownToolDisplayName('CCD Session', map), true);
});

test('isKnownToolDisplayName: matches a full friendly name', () => {
	assert.equal(isKnownToolDisplayName('Claude Browser', { Claude_Browser: 'Claude Browser' }), true);
});

test('isKnownToolDisplayName: raw tool ids and unknown names are not display names', () => {
	const map = { 'mcp__ccd_session__mark_chapter': 'CCD Session: Mark Chapter' };
	assert.equal(isKnownToolDisplayName('mcp__ccd_host__sync_with_base_branch', map), false);
	assert.equal(isKnownToolDisplayName('Mark Chapter', map), false);
});

test('isKnownToolDisplayName: issue #2223 server names are recognized in the real toolNames.json', () => {
	for (const name of ['CCD Session', 'Claude Browser', 'GitHub MCP (Local)', 'MCP Claude Browser', 'MCP Scheduled Tasks']) {
		assert.equal(isKnownToolDisplayName(name, toolNamesData as Record<string, string>), true, name);
	}
	for (const id of ['ccd_host', 'mcp__ccd_host__sync_with_base_branch', 'mcp__ccd_pr__bind_pr', 'mcp__ccd_pr__set_monitor']) {
		assert.equal(isKnownToolDisplayName(id, toolNamesData as Record<string, string>), false, id);
	}
});
