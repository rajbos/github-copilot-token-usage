import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    getModeType,
    getRepoDisplayName,
    parseGitRemoteUrl,
    isMcpTool,
    normalizeMcpToolName,
    extractMcpServerName,
    extractCustomAgentName,
    getEditorNameFromRoot,
} from '../../src/workspaceHelpers';

// ---------------------------------------------------------------------------
// getModeType
// ---------------------------------------------------------------------------

test('getModeType: null/undefined mode defaults to ask', () => {
    assert.equal(getModeType(null), 'ask');
    assert.equal(getModeType(undefined), 'ask');
    assert.equal(getModeType({}), 'ask');
});

test('getModeType: kind=ask returns ask', () => {
    assert.equal(getModeType({ kind: 'ask' }), 'ask');
});

test('getModeType: kind=edit returns edit', () => {
    assert.equal(getModeType({ kind: 'edit' }), 'edit');
});

test('getModeType: kind=agent with no id returns agent', () => {
    assert.equal(getModeType({ kind: 'agent' }), 'agent');
    assert.equal(getModeType({ kind: 'agent', id: 'agent' }), 'agent');
});

test('getModeType: kind=agent with plan-agent id returns plan', () => {
    assert.equal(getModeType({ kind: 'agent', id: 'vscode-userdata:/settings/plan-agent/Plan.agent.md' }), 'plan');
});

test('getModeType: kind=agent with custom .agent.md file returns customAgent', () => {
    assert.equal(getModeType({ kind: 'agent', id: 'file:///workspace/.github/agents/my-agent.agent.md' }), 'customAgent');
});

test('getModeType: unknown kind defaults to ask', () => {
    assert.equal(getModeType({ kind: 'something-else' }), 'ask');
});

// ---------------------------------------------------------------------------
// getRepoDisplayName
// ---------------------------------------------------------------------------

test('getRepoDisplayName: empty/unknown returns Unknown', () => {
    assert.equal(getRepoDisplayName(''), 'Unknown');
    assert.equal(getRepoDisplayName('Unknown'), 'Unknown');
});

test('getRepoDisplayName: HTTPS URL returns owner/repo', () => {
    assert.equal(getRepoDisplayName('https://github.com/owner/repo'), 'owner/repo');
    assert.equal(getRepoDisplayName('https://github.com/owner/repo.git'), 'owner/repo');
});

test('getRepoDisplayName: SSH URL returns owner/repo', () => {
    assert.equal(getRepoDisplayName('git@github.com:owner/repo.git'), 'owner/repo');
    assert.equal(getRepoDisplayName('git@github.com:owner/repo'), 'owner/repo');
});

test('getRepoDisplayName: git+https URL strips git+ prefix', () => {
    assert.equal(getRepoDisplayName('git+https://github.com/owner/repo.git'), 'owner/repo');
});

test('getRepoDisplayName: GitHub Enterprise HTTPS URL returns owner/repo', () => {
    assert.equal(getRepoDisplayName('https://myghe.example.com/owner/repo'), 'owner/repo');
});

// ---------------------------------------------------------------------------
// parseGitRemoteUrl
// ---------------------------------------------------------------------------

test('parseGitRemoteUrl: returns undefined for empty string', () => {
    assert.equal(parseGitRemoteUrl(''), undefined);
});

test('parseGitRemoteUrl: extracts HTTPS remote origin URL', () => {
    const config = `
[core]
    repositoryformatversion = 0
[remote "origin"]
    url = https://github.com/owner/repo.git
    fetch = +refs/heads/*:refs/remotes/origin/*
`;
    assert.equal(parseGitRemoteUrl(config), 'https://github.com/owner/repo.git');
});

test('parseGitRemoteUrl: extracts SSH remote origin URL', () => {
    const config = `
[remote "origin"]
    url = git@github.com:owner/repo.git
`;
    assert.equal(parseGitRemoteUrl(config), 'git@github.com:owner/repo.git');
});

test('parseGitRemoteUrl: stops at next section boundary', () => {
    const config = `
[remote "origin"]
    url = https://github.com/owner/repo.git
[remote "upstream"]
    url = https://github.com/upstream/repo.git
`;
    assert.equal(parseGitRemoteUrl(config), 'https://github.com/owner/repo.git');
});

test('parseGitRemoteUrl: returns undefined when no origin section present', () => {
    const config = `
[core]
    repositoryformatversion = 0
[remote "upstream"]
    url = https://github.com/upstream/repo.git
`;
    assert.equal(parseGitRemoteUrl(config), undefined);
});

// ---------------------------------------------------------------------------
// isMcpTool
// ---------------------------------------------------------------------------

test('isMcpTool: mcp. prefix returns true', () => {
    assert.equal(isMcpTool('mcp.io.github.git.list_issues'), true);
});

test('isMcpTool: mcp_ prefix returns true', () => {
    assert.equal(isMcpTool('mcp_github_github_create_issue'), true);
});

test('isMcpTool: regular tool names return false', () => {
    assert.equal(isMcpTool('editFiles'), false);
    assert.equal(isMcpTool('run_in_terminal'), false);
    assert.equal(isMcpTool('github_pull_request'), false);
});

// ---------------------------------------------------------------------------
// normalizeMcpToolName
// ---------------------------------------------------------------------------

test('normalizeMcpToolName: mcp_github_github_ prefix maps to mcp_io_github_git_', () => {
    assert.equal(
        normalizeMcpToolName('mcp_github_github_list_issues'),
        'mcp_io_github_git_list_issues'
    );
});

test('normalizeMcpToolName: mcp.github.github. prefix maps to mcp.io.github.git.', () => {
    assert.equal(
        normalizeMcpToolName('mcp.github.github.list_issues'),
        'mcp.io.github.git.list_issues'
    );
});

test('normalizeMcpToolName: other tool names pass through unchanged', () => {
    assert.equal(normalizeMcpToolName('mcp_io_github_git_list_issues'), 'mcp_io_github_git_list_issues');
    assert.equal(normalizeMcpToolName('editFiles'), 'editFiles');
});

// ---------------------------------------------------------------------------
// extractMcpServerName
// ---------------------------------------------------------------------------

test('extractMcpServerName: uses display name from toolNameMap when available', () => {
    const map = { 'mcp_io_github_git_list_issues': 'GitHub MCP: Issue Read' };
    assert.equal(extractMcpServerName('mcp_io_github_git_list_issues', map), 'GitHub MCP');
});

test('extractMcpServerName: falls back to known prefix for mcp_io_github_git_', () => {
    assert.equal(extractMcpServerName('mcp_io_github_git_unknown_action'), 'GitHub MCP (Local)');
});

test('extractMcpServerName: falls back to known prefix for mcp_github_github_', () => {
    assert.equal(extractMcpServerName('mcp_github_github_unknown_action'), 'GitHub MCP (Remote)');
});

test('extractMcpServerName: generic fallback extracts first segment', () => {
    const result = extractMcpServerName('mcp_myserver_some_tool');
    assert.equal(result, 'myserver');
});

// ---------------------------------------------------------------------------
// extractCustomAgentName
// ---------------------------------------------------------------------------

test('extractCustomAgentName: returns null for non-agent paths', () => {
    assert.equal(extractCustomAgentName(''), null);
    assert.equal(extractCustomAgentName('vscode-userdata:/plan-agent/Plan.md'), null);
});

test('extractCustomAgentName: extracts name from file:/// URI', () => {
    assert.equal(
        extractCustomAgentName('file:///workspace/.github/agents/my-agent.agent.md'),
        'my-agent'
    );
});

test('extractCustomAgentName: extracts name from plain path', () => {
    assert.equal(
        extractCustomAgentName('/home/user/.github/agents/code-reviewer.agent.md'),
        'code-reviewer'
    );
});

// ---------------------------------------------------------------------------
// getEditorNameFromRoot
// ---------------------------------------------------------------------------

test('getEditorNameFromRoot: empty string returns Unknown', () => {
    assert.equal(getEditorNameFromRoot(''), 'Unknown');
});

test('getEditorNameFromRoot: .copilot path returns Copilot CLI', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\.copilot\\worktrees\\session'), 'Copilot CLI');
});

test('getEditorNameFromRoot: Code Insiders path returns VS Code Insiders', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Roaming\\Code - Insiders'), 'VS Code Insiders');
});

test('getEditorNameFromRoot: Cursor path returns Cursor', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Roaming\\Cursor'), 'Cursor');
});

test('getEditorNameFromRoot: .continue path returns Continue', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.continue/sessions'), 'Continue');
});

test('getEditorNameFromRoot: opencode path returns OpenCode', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.local/share/opencode'), 'OpenCode');
});