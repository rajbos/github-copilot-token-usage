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

test('getEditorNameFromRoot: .copilot/jb path returns JetBrains', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\.copilot\\jb'), 'JetBrains');
});

test('getEditorNameFromRoot: .copilot/jb forward-slash path returns JetBrains', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.copilot/jb'), 'JetBrains');
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

test('getEditorNameFromRoot: .gemini path returns Gemini CLI', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.gemini'), 'Gemini CLI');
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

test('getEditorTypeFromPath: detects Mistral Vibe', () => {
        assert.equal(getEditorTypeFromPath('/home/user/.vibe/logs/session/session_20250101_120000_abc12345/meta.json'), 'Mistral Vibe');
});

test('getEditorTypeFromPath: detects Gemini CLI', () => {
        assert.equal(getEditorTypeFromPath('/home/user/.gemini/tmp/demo-project/chats/session-abc.jsonl'), 'Gemini CLI');
});

test('getEditorTypeFromPath: detects Claude Desktop Cowork', () => {
        assert.equal(getEditorTypeFromPath('/home/user/AppData/Local/Packages/Claude_pzs/LocalCache/Roaming/claude/local-agent-mode-sessions/session.jsonl'), 'Claude Desktop Cowork');
});

test('getEditorTypeFromPath: returns Unknown for unrecognized paths', () => {
        assert.equal(getEditorTypeFromPath('/tmp/random/file.json'), 'Unknown');
});

test('getEditorTypeFromPath: detects JetBrains from .copilot/jb path', () => {
        assert.equal(getEditorTypeFromPath('/home/user/.copilot/jb/uuid-1234/partition-0.jsonl'), 'JetBrains');
});

test('getEditorTypeFromPath: detects JetBrains from Windows-style .copilot\\jb path', () => {
        assert.equal(getEditorTypeFromPath('C:\\Users\\user\\.copilot\\jb\\uuid-1234\\partition-0.jsonl'), 'JetBrains');
});

test('getEditorTypeFromPath: JetBrains takes priority over Copilot CLI fallback', () => {
        // .copilot/jb/ path must NOT be mis-attributed to Copilot CLI
        assert.notEqual(getEditorTypeFromPath('/home/user/.copilot/jb/uuid-1234/partition-0.jsonl'), 'Copilot CLI');
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

test('detectEditorSource: detects Gemini CLI from path', () => {
        assert.equal(detectEditorSource('/home/user/.gemini/tmp/demo-project/chats/session-abc.jsonl'), 'Gemini CLI');
});

test('detectEditorSource: returns Unknown for unrecognized paths', () => {
        assert.equal(detectEditorSource('/tmp/random/file.json'), 'Unknown');
});
// ── Round 2: extractWorkspaceIdFromSessionPath boundary conditions ────────

test('extractWorkspaceIdFromSessionPath: workspaceStorage as last segment returns undefined', () => {
        // idx+1 >= parts.length case
        const path = '/home/user/.config/Code/User/workspaceStorage';
        assert.equal(extractWorkspaceIdFromSessionPath(path), undefined);
});

test('extractWorkspaceIdFromSessionPath: returns part immediately after workspaceStorage', () => {
        const path = '/Code/User/workspaceStorage/abc123def/chatSessions/x.json';
        assert.equal(extractWorkspaceIdFromSessionPath(path), 'abc123def');
});

test('extractWorkspaceIdFromSessionPath: case-insensitive workspaceStorage match', () => {
        const path = '/Code/User/WorkspaceStorage/abc123/session.json';
        assert.equal(extractWorkspaceIdFromSessionPath(path), 'abc123');
});

// ── Round 2: globToRegExp regex mutation coverage ────────────────────────

test('globToRegExp: /**/ in middle of pattern matches multiple segments', () => {
        const re = globToRegExp('src/**/test/*.ts');
        assert.ok(re.test('src/test/foo.ts'));
        assert.ok(re.test('src/a/b/test/foo.ts'));
        assert.ok(!re.test('src/test/sub/foo.ts')); // last * shouldn't match /
});

test('globToRegExp: trailing ** matches any depth', () => {
        const re = globToRegExp('src/**');
        assert.ok(re.test('src/file.ts'));
        assert.ok(re.test('src/a/b/c/file.ts'));
});

test('globToRegExp: escapes dot in filename', () => {
        const re = globToRegExp('package.json');
        assert.ok(re.test('package.json'));
        assert.ok(!re.test('packageXjson'));  // dot should NOT match any char
});

test('globToRegExp: case sensitive by default', () => {
        const re = globToRegExp('*.TS');
        assert.ok(re.test('file.TS'));
        assert.ok(!re.test('file.ts'));
});

test('globToRegExp: non-case-insensitive flag is false by default', () => {
        const reDefault = globToRegExp('*.ts');
        const reExplicit = globToRegExp('*.ts', false);
        assert.equal(reDefault.flags, reExplicit.flags);
});

// ── Round 2: detectEditorSource ordering and exact string matching ────────

test('detectEditorSource: Cursor is detected before VS Code fallback', () => {
        // Path contains both "cursor" and "code" — cursor should win
        const path = '/home/user/.config/Cursor/User/workspaceStorage/abc/session.json';
        assert.equal(detectEditorSource(path), 'Cursor');
});

test('detectEditorSource: code-insiders hyphenated variant detected', () => {
        assert.equal(detectEditorSource('/home/user/.config/Code-Insiders/User/session.json'), 'VS Code Insiders');
});

test('detectEditorSource: Copilot CLI takes priority over code path', () => {
        // .copilot/session-state path should return Copilot CLI, not VS Code
        assert.equal(detectEditorSource('/home/user/.copilot/session-state/session123.json'), 'Copilot CLI');
});

test('detectEditorSource: JetBrains detected from .copilot/jb path', () => {
        assert.equal(detectEditorSource('/home/user/.copilot/jb/uuid-1234/partition-0.jsonl'), 'JetBrains');
});

test('detectEditorSource: JetBrains takes priority over Copilot CLI fallback', () => {
        // .copilot/jb/ path should return JetBrains, not Copilot CLI
        assert.notEqual(detectEditorSource('/home/user/.copilot/jb/uuid-1234/partition-0.jsonl'), 'Copilot CLI');
});

test('detectEditorSource: Claude Code takes priority over code path', () => {
        assert.equal(detectEditorSource('/home/user/.claude/projects/abc/session.jsonl'), 'Claude Code');
});

// ── Round 2: extractCustomAgentName edge cases ────────────────────────────

test('extractCustomAgentName: returns null for non-.agent.md path', () => {
        const result = extractCustomAgentName('file:///home/user/code/not-an-agent.ts');
        assert.equal(result, null);
});

test('extractCustomAgentName: handles path without file:// prefix', () => {
        const result = extractCustomAgentName('/home/user/.github/agents/my-agent.agent.md');
        assert.ok(result !== null);
        assert.equal(result, 'my-agent');
});

test('extractCustomAgentName: file:/// URI with agent.md returns just the agent name', () => {
        const result = extractCustomAgentName('file:///home/user/.github/agents/code-review.agent.md');
        assert.equal(result, 'code-review');
});

// ── Round 2: getRepoDisplayName edge cases ────────────────────────────────

test('getRepoDisplayName: handles .git suffix in HTTPS URL', () => {
        const result = getRepoDisplayName('https://github.com/owner/my-repo.git');
        assert.equal(result, 'owner/my-repo');
});

test('getRepoDisplayName: handles URL without trailing .git', () => {
        const result = getRepoDisplayName('https://github.com/owner/repo');
        assert.equal(result, 'owner/repo');
});

test('getRepoDisplayName: handles SSH URL with .git', () => {
        const result = getRepoDisplayName('git@github.com:owner/repo.git');
        assert.equal(result, 'owner/repo');
});

// ── Claude Code MCP double-underscore format ──────────────────────────────

test('isMcpTool: mcp__ double-underscore prefix (Claude Code format) returns true', () => {
        assert.equal(isMcpTool('mcp__github__create_issue'), true);
        assert.equal(isMcpTool('mcp__filesystem__read_file'), true);
});

test('isMcpTool: regular tool without mcp__ prefix returns false', () => {
        assert.equal(isMcpTool('github__create_issue'), false);
        assert.equal(isMcpTool('__slash__review'), false);
});

test('extractMcpServerName: mcp__server__tool format extracts server name', () => {
        assert.equal(extractMcpServerName('mcp__github__create_issue'), 'github');
        assert.equal(extractMcpServerName('mcp__filesystem__read_file'), 'filesystem');
});

test('extractMcpServerName: mcp__server__multi__part__tool extracts only first server segment', () => {
        assert.equal(extractMcpServerName('mcp__my_server__tool__with__parts'), 'my_server');
});
// ── scanWorkspaceCustomizationFiles — category detection ─────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { scanWorkspaceCustomizationFiles } from '../../src/workspaceHelpers';

test('scanWorkspaceCustomizationFiles: returns empty array for non-existent dir', () => {
const result = scanWorkspaceCustomizationFiles('/does/not/exist/xyz123');
assert.deepEqual(result, []);
});

test('scanWorkspaceCustomizationFiles: detects copilot-instructions.md as copilot category', () => {
const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wh-test-'));
try {
const githubDir = nodePath.join(tmpDir, '.github');
fs.mkdirSync(githubDir);
fs.writeFileSync(nodePath.join(githubDir, 'copilot-instructions.md'), '# Instructions');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const copilotFile = result.find(f => f.type !== 'unknown' && f.path.includes('copilot-instructions.md'));
assert.ok(copilotFile, 'should find copilot-instructions.md');
assert.equal(copilotFile?.category, 'copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('scanWorkspaceCustomizationFiles: detects .cursorrules as non-copilot category', () => {
const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wh-test-'));
try {
fs.writeFileSync(nodePath.join(tmpDir, '.cursorrules'), '# Cursor rules');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const cursorFile = result.find(f => f.path.includes('.cursorrules'));
assert.ok(cursorFile, 'should find .cursorrules');
assert.equal(cursorFile?.category, 'non-copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('scanWorkspaceCustomizationFiles: detects .claude/settings.json as non-copilot (not CLAUDE.md)', () => {
const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wh-test-'));
try {
// CLAUDE.md should NOT appear as non-copilot (it is Copilot-compatible)
fs.writeFileSync(nodePath.join(tmpDir, 'CLAUDE.md'), '# Claude instructions');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const claudeMd = result.find(f => f.path.includes('CLAUDE.md') && f.category === 'non-copilot');
assert.equal(claudeMd, undefined, 'CLAUDE.md should not be flagged as non-copilot');

// .claude/settings.json SHOULD appear as non-copilot
const claudeDir = nodePath.join(tmpDir, '.claude');
fs.mkdirSync(claudeDir);
fs.writeFileSync(nodePath.join(claudeDir, 'settings.json'), '{}');
const result2 = scanWorkspaceCustomizationFiles(tmpDir);
const claudeSettings = result2.find(f => f.path.includes('settings.json') && f.category === 'non-copilot');
assert.ok(claudeSettings, 'should find .claude/settings.json as non-copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('scanWorkspaceCustomizationFiles: detects opencode.json as non-copilot', () => {
const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wh-test-'));
try {
fs.writeFileSync(nodePath.join(tmpDir, 'opencode.json'), '{}');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const opencodeFile = result.find(f => f.path.includes('opencode.json'));
assert.ok(opencodeFile, 'should find opencode.json');
assert.equal(opencodeFile?.category, 'non-copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});
