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
// ── Mutation-killing tests ──────────────────────────────────────────────

import {
        extractWorkspaceIdFromSessionPath,
        globToRegExp,
        getEditorTypeFromPath,
        detectEditorSource
} from '../../src/workspaceHelpers';

// ── extractWorkspaceIdFromSessionPath ───────────────────────────────────

test('extractWorkspaceIdFromSessionPath: extracts ID after workspaceStorage', () => {
        const path = '/home/user/.config/Code/User/workspaceStorage/abc123def/chatSessions/session.json';
        assert.equal(extractWorkspaceIdFromSessionPath(path), 'abc123def');
});

test('extractWorkspaceIdFromSessionPath: handles Windows paths', () => {
        const path = 'C:\\Users\\user\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc123def\\chatSessions\\session.json';
        assert.equal(extractWorkspaceIdFromSessionPath(path), 'abc123def');
});

test('extractWorkspaceIdFromSessionPath: returns undefined for non-workspace path', () => {
        assert.equal(extractWorkspaceIdFromSessionPath('/home/user/.claude/projects/hash/session.jsonl'), undefined);
});

test('extractWorkspaceIdFromSessionPath: returns undefined for empty string', () => {
        assert.equal(extractWorkspaceIdFromSessionPath(''), undefined);
});

// ── globToRegExp ────────────────────────────────────────────────────────

test('globToRegExp: matches simple wildcard', () => {
        const re = globToRegExp('*.ts');
        assert.ok(re.test('file.ts'));
        assert.ok(!re.test('file.js'));
        assert.ok(!re.test('dir/file.ts')); // * should not match /
});

test('globToRegExp: matches globstar **', () => {
        const re = globToRegExp('**/*.ts');
        assert.ok(re.test('src/file.ts'));
        assert.ok(re.test('src/deep/nested/file.ts'));
        assert.ok(!re.test('file.js'));
});

test('globToRegExp: escapes special regex characters', () => {
        const re = globToRegExp('file.test.ts');
        assert.ok(re.test('file.test.ts'));
        assert.ok(!re.test('fileXtestXts'));
});

test('globToRegExp: supports case insensitive mode', () => {
        const re = globToRegExp('*.TS', true);
        assert.ok(re.test('file.ts'));
        assert.ok(re.test('file.TS'));
});

test('globToRegExp: matches question mark as single char', () => {
        const re = globToRegExp('file?.ts');
        assert.ok(re.test('file1.ts'));
        assert.ok(re.test('fileX.ts'));
        assert.ok(!re.test('file12.ts'));
});

// ── getEditorTypeFromPath ───────────────────────────────────────────────

test('getEditorTypeFromPath: detects Copilot CLI', () => {
        assert.equal(getEditorTypeFromPath('/home/user/.copilot/session-state/abc/session.json'), 'Copilot CLI');
});

test('getEditorTypeFromPath: detects Continue', () => {
        assert.equal(getEditorTypeFromPath('/home/user/.continue/sessions/session.json'), 'Continue');
});

test('getEditorTypeFromPath: detects Claude Code', () => {
        assert.equal(getEditorTypeFromPath('/home/user/.claude/projects/hash/session.jsonl'), 'Claude Code');
});

test('getEditorTypeFromPath: detects Cursor', () => {
        assert.equal(getEditorTypeFromPath('/home/user/Cursor/User/workspaceStorage/abc/chatSessions/session.json'), 'Cursor');
});

test('getEditorTypeFromPath: detects VS Code Insiders', () => {
        assert.equal(getEditorTypeFromPath('/home/user/Code - Insiders/User/workspaceStorage/abc/session.json'), 'VS Code Insiders');
});

test('getEditorTypeFromPath: detects OpenCode via callback', () => {
        const isOpenCode = (p: string) => p.includes('/opencode/');
        assert.equal(getEditorTypeFromPath('/home/user/.local/share/opencode/session.db#ses_1', isOpenCode), 'OpenCode');
});

test('getEditorTypeFromPath: returns Unknown for unrecognized paths', () => {
        assert.equal(getEditorTypeFromPath('/tmp/random/file.json'), 'Unknown');
});

// ── detectEditorSource ──────────────────────────────────────────────────

test('detectEditorSource: detects Claude Code from path', () => {
        assert.equal(detectEditorSource('/home/user/.claude/projects/hash/session.jsonl'), 'Claude Code');
});

test('detectEditorSource: detects VS Code from Code path', () => {
        assert.equal(detectEditorSource('/home/user/.config/Code/User/workspaceStorage/abc/session.json'), 'VS Code');
});

test('detectEditorSource: detects Windsurf', () => {
        assert.equal(detectEditorSource('/home/user/.config/Windsurf/User/workspaceStorage/abc/session.json'), 'Windsurf');
});

test('detectEditorSource: detects VSCodium', () => {
        assert.equal(detectEditorSource('/home/user/.config/VSCodium/User/workspaceStorage/abc/session.json'), 'VSCodium');
});

test('detectEditorSource: detects Visual Studio', () => {
        assert.equal(detectEditorSource('/project/.vs/solution.sln/copilot-chat/hash/sessions/uuid'), 'Visual Studio');
});

test('detectEditorSource: detects Claude Desktop Cowork', () => {
        assert.equal(detectEditorSource('/home/user/.config/local-agent-mode-sessions/session.json'), 'Claude Desktop Cowork');
});

test('detectEditorSource: detects Crush', () => {
        assert.equal(detectEditorSource('/home/user/.crush/crush.db#session'), 'Crush');
});

test('detectEditorSource: returns Unknown for unrecognized paths', () => {
        assert.equal(detectEditorSource('/tmp/random/file.json'), 'Unknown');
});