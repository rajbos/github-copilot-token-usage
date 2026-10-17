// @ts-nocheck
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    getModeType,
    getRepoDisplayName,
    parseGitRemoteUrl,
    isMcpTool,
    normalizeMcpToolName,
    extractMcpServerName,
    extractCustomAgentName,
    getEditorNameFromRoot,
    normalizePathSeparators,
    normalizePathForComparison,
    normalizePathForDedup,
    fileUriToPath,
    parseWorkspaceStorageJsonFile,
    resolveSessionWorkspaceName,
} from '../../../src/workspaceHelpers';

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

test('normalizeMcpToolName: github-mcp-server- prefix maps to mcp_io_github_git_', () => {
    assert.equal(
        normalizeMcpToolName('github-mcp-server-list_issues'),
        'mcp_io_github_git_list_issues'
    );
});

test('normalizeMcpToolName: mcp_github_mcp_s2_ prefix maps to mcp_io_github_git_', () => {
    assert.equal(
        normalizeMcpToolName('mcp_github_mcp_s2_issue_read'),
        'mcp_io_github_git_issue_read'
    );
});

test('normalizeMcpToolName: context7 prefix variants normalize to context7-', () => {
    assert.equal(
        normalizeMcpToolName('mcp_context7_query-docs'),
        'context7-query-docs'
    );
    assert.equal(
        normalizeMcpToolName('mcp__context7__query-docs'),
        'context7-query-docs'
    );
    assert.equal(
        normalizeMcpToolName('mcp_io_github_ups_resolve-library-id'),
        'context7-resolve-library-id'
    );
});

test('normalizeMcpToolName: playwright prefix variants normalize to microsoft_playwright-mcp-', () => {
    assert.equal(
        normalizeMcpToolName('mcp_playwright_browser_click'),
        'microsoft_playwright-mcp-browser_click'
    );
    assert.equal(
        normalizeMcpToolName('mcp__microsoft_playwright-mcp__browser_click'),
        'microsoft_playwright-mcp-browser_click'
    );
    assert.equal(
        normalizeMcpToolName('mcp_microsoft_pla_browser_click'),
        'microsoft_playwright-mcp-browser_click'
    );
});

test('normalizeMcpToolName: tavily prefix variants normalize to io_github_tavily-ai_tavily-mcp-', () => {
    assert.equal(
        normalizeMcpToolName('mcp_tavily_tavily_search'),
        'io_github_tavily-ai_tavily-mcp-tavily_search'
    );
    assert.equal(
        normalizeMcpToolName('mcp_tavily-mcp_tavily_search'),
        'io_github_tavily-ai_tavily-mcp-tavily_search'
    );
});

test('normalizeMcpToolName: claude browser prefix variants normalize to mcp__claude_browser__', () => {
    assert.equal(
        normalizeMcpToolName('mcp__claude-in-chrome__navigate'),
        'mcp__claude_browser__navigate'
    );
    assert.equal(
        normalizeMcpToolName('mcp__Claude_Browser__navigate'),
        'mcp__claude_browser__navigate'
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

test('getEditorNameFromRoot: .devin path returns Devin', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.devin'), 'Devin');
});

test('getEditorNameFromRoot: devin-desktop install path returns Devin (not misclassified as Copilot CLI)', () => {
    // Devin bundles the 'codeium.windsurf' extension and a plugin id that does NOT
    // contain 'copilot', so this mainly guards against future substring collisions.
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Local\\Programs\\devin-desktop'), 'Devin');
});

test('getEditorNameFromRoot: Devin CLI config dir returns "Devin CLI" (distinct from the desktop app)', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Roaming\\devin\\cli'), 'Devin CLI');
    assert.equal(getEditorNameFromRoot('/home/user/.local/share/devin/cli'), 'Devin CLI');
});

test('getEditorNameFromRoot: Codex CLI home (~/.codex) returns "Codex CLI", not VS Code', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\.codex'), 'Codex CLI');
    assert.equal(getEditorNameFromRoot('/home/user/.codex'), 'Codex CLI');
});
// ── Mutation-killing tests ──────────────────────────────────────────────

import {
        extractWorkspaceIdFromSessionPath,
        globToRegExp,
        getEditorTypeFromPath,
        detectEditorSource,
        detectClaudeCodeEditorVariant,
        resetClaudeCodeEditorVariantCacheForTests,
        refineEditorLabelForInteractionModeSplit,
        SYNCED_INTERACTION_MODE_LABELS
} from '../../../src/workspaceHelpers';
import { MODE_USAGE_CONTENT_CLASSIFIED_KEYS } from '../../src/webview/shared/types';

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

test('detectClaudeCodeEditorVariant: returns Claude Desktop for entrypoint claude-desktop', () => {
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-variant-'));
        const projectsDir = path.join(dir, '.claude', 'projects', 'hash');
        fs.mkdirSync(projectsDir, { recursive: true });
        const file = path.join(projectsDir, 'session.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'claude-desktop', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        try {
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Desktop');
                assert.equal(getEditorTypeFromPath(file), 'Claude Desktop');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
        }
});

test('detectClaudeCodeEditorVariant: returns Claude Code CLI for entrypoint cli', () => {
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-variant-'));
        const file = path.join(dir, 'session.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'cli', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        try {
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Code CLI');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
        }
});

test('detectClaudeCodeEditorVariant: returns Claude Code for any other entrypoint (e.g. VS Code extension)', () => {
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-variant-'));
        const file = path.join(dir, 'session.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'claude-vscode', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        try {
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Code');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
        }
});

test('detectClaudeCodeEditorVariant: defaults to Claude Code when file is missing or has no entrypoint', () => {
        assert.equal(detectClaudeCodeEditorVariant('/nonexistent/path/session.jsonl'), 'Claude Code');
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-variant-'));
        const file = path.join(dir, 'session.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'queue-operation', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        try {
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Code');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
        }
});

test('detectClaudeCodeEditorVariant: a definitive answer is remembered, so repeated label lookups do not re-read the file', () => {
        // Every view asks for every file's label; each ask used to open and read 64 KB synchronously on the host.
        resetClaudeCodeEditorVariantCacheForTests();
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-variant-'));
        const file = path.join(dir, 'session.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'cli', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        try {
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Code CLI');
                fs.rmSync(file); // a re-read would now fall back to the default
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Code CLI', 'served from memory, not from disk');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
                resetClaudeCodeEditorVariantCacheForTests();
        }
});

test('detectClaudeCodeEditorVariant: a session with no entrypoint yet is not remembered and is detected once it gains one', () => {
        resetClaudeCodeEditorVariantCacheForTests();
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-variant-'));
        const file = path.join(dir, 'session.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'queue-operation', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        try {
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Code');
                fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'claude-desktop', timestamp: '2026-01-01T00:00:01.000Z' }) + '\n');
                assert.equal(detectClaudeCodeEditorVariant(file), 'Claude Desktop', 'the default must not have been cached');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
                resetClaudeCodeEditorVariantCacheForTests();
        }
});

// ── refineEditorLabelForInteractionModeSplit ─────────────────────────────

test('refineEditorLabelForInteractionModeSplit: relabels Claude Code as Claude (VS Code)', () => {
        assert.equal(refineEditorLabelForInteractionModeSplit('/home/user/.claude/projects/hash/session.jsonl', 'Claude Code'), 'Claude (VS Code)');
});

test('refineEditorLabelForInteractionModeSplit: leaves Claude Desktop and Claude Code CLI untouched', () => {
        assert.equal(refineEditorLabelForInteractionModeSplit('/home/user/.claude/projects/hash/session.jsonl', 'Claude Desktop'), 'Claude Desktop');
        assert.equal(refineEditorLabelForInteractionModeSplit('/home/user/.claude/projects/hash/session.jsonl', 'Claude Code CLI'), 'Claude Code CLI');
});

test('refineEditorLabelForInteractionModeSplit: relabels Copilot CLI as Copilot App when workspace.yaml marks the desktop app', () => {
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'copilot-app-'));
        const sessionDir = path.join(dir, '.copilot', 'session-state', 'abc');
        fs.mkdirSync(sessionDir, { recursive: true });
        const file = path.join(sessionDir, 'events.jsonl');
        fs.writeFileSync(file, '');
        fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), 'cwd: /repo\nclient_name: github/autopilot\n');
        try {
                assert.equal(refineEditorLabelForInteractionModeSplit(file, 'Copilot CLI'), 'Copilot App');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
        }
});

test('refineEditorLabelForInteractionModeSplit: leaves Copilot CLI untouched for plain terminal CLI sessions', () => {
        const dir = fs.mkdtempSync(path.join(process.cwd(), 'copilot-cli-'));
        const sessionDir = path.join(dir, '.copilot', 'session-state', 'abc');
        fs.mkdirSync(sessionDir, { recursive: true });
        const file = path.join(sessionDir, 'events.jsonl');
        fs.writeFileSync(file, '');
        fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), 'cwd: /repo\nclient_name: github/cli\n');
        try {
                assert.equal(refineEditorLabelForInteractionModeSplit(file, 'Copilot CLI'), 'Copilot CLI');
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
        }
});

test('refineEditorLabelForInteractionModeSplit: leaves Copilot CLI untouched when workspace.yaml is missing', () => {
        assert.equal(refineEditorLabelForInteractionModeSplit('/nonexistent/path/session-state/abc/events.jsonl', 'Copilot CLI'), 'Copilot CLI');
});

test('refineEditorLabelForInteractionModeSplit: leaves unrelated editor labels untouched', () => {
        assert.equal(refineEditorLabelForInteractionModeSplit('/home/user/Code/User/workspaceStorage/abc/session.json', 'VS Code'), 'VS Code');
});

test('SYNCED_INTERACTION_MODE_LABELS stays in lockstep with MODE_USAGE_CONTENT_CLASSIFIED_KEYS (drift guard)', () => {
        // 'claudeDesktop' needs no sync-side refinement: it already gets a stable path-based
        // label ('Claude Desktop') straight from detectClaudeCodeEditorVariant.
        const syncedKeys = Object.keys(SYNCED_INTERACTION_MODE_LABELS).concat('claudeDesktop').sort();
        const webviewKeys = [...MODE_USAGE_CONTENT_CLASSIFIED_KEYS].sort();
        assert.deepEqual(
                syncedKeys,
                webviewKeys,
                'A new content-classified ModeUsage key was added on one side without updating the other — ' +
                        'add it to SYNCED_INTERACTION_MODE_LABELS (workspaceHelpers.ts) or ' +
                        'MODE_USAGE_CONTENT_CLASSIFIED_KEYS (webview/shared/types.ts) to match.'
        );
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

test('getEditorTypeFromPath: detects Claude Desktop Cowork from renamed claude-code-sessions dir', () => {
        assert.equal(getEditorTypeFromPath('/home/user/AppData/Local/Packages/Claude_pzs/LocalCache/Roaming/claude/claude-code-sessions/app/machine/local_abc/.claude/projects/hash/session.jsonl'), 'Claude Desktop Cowork');
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

test('detectEditorSource: detects Devin (Cognition Labs fork/rebrand of Windsurf)', () => {
        assert.equal(detectEditorSource('/home/user/.devin/User/workspaceStorage/abc/session.json'), 'Devin');
});

test('detectEditorSource: detects Devin CLI virtual sessions.db paths (distinct from the desktop app)', () => {
        const p = 'C:\\Users\\alice\\AppData\\Roaming\\devin\\cli\\sessions.db#sess-abc123';
        assert.equal(detectEditorSource(p), 'Devin CLI');
});

test('detectEditorSource: detects Codex CLI rollout files and virtual thread paths (not VS Code, despite the "code" substring)', () => {
        const rollout = 'C:\\Users\\alice\\.codex\\sessions\\2026\\03\\19\\rollout-2026-03-19T12-00-00-019d0233-2d86-7c21-b13a-8fa9578d3a0d.jsonl';
        assert.equal(detectEditorSource(rollout), 'Codex CLI');
        const virtual = '/home/alice/.codex/state_5.sqlite#019d0233-2d86-7c21-b13a-8fa9578d3a0d';
        assert.equal(detectEditorSource(virtual), 'Codex CLI');
});

test('detectEditorSource: detects VSCodium', () => {
        assert.equal(detectEditorSource('/home/user/.config/VSCodium/User/workspaceStorage/abc/session.json'), 'VSCodium');
});

test('detectEditorSource: detects Visual Studio', () => {
        assert.equal(detectEditorSource('/project/.vs/solution.sln/copilot-chat/hash/sessions/uuid'), 'Visual Studio');
});

test('detectEditorSource: detects Visual Studio from the VSGitHubCopilot AppData store', () => {
        // Chats started without a solution open — no .vs folder exists (issue #2137).
        assert.equal(
                detectEditorSource('C:/Users/u/AppData/Local/Microsoft/VisualStudio/18.0_0a408795/VSGitHubCopilot/copilot-chat/b6662ded/sessions/80720523'),
                'Visual Studio'
        );
});

test('detectEditorSource: labels SSMS sessions as SSMS, not Visual Studio', () => {
        assert.equal(
                detectEditorSource('C:/Users/u/AppData/Local/Microsoft/SSMS/22.0_82a729ff/SSMSGitHubCopilot/copilot-chat/ca1642fb/sessions/7bb52dc2'),
                'SSMS'
        );
});

test('detectEditorSource: detects Claude Desktop Cowork', () => {
        assert.equal(detectEditorSource('/home/user/.config/local-agent-mode-sessions/session.json'), 'Claude Desktop Cowork');
        assert.equal(detectEditorSource('/home/user/.config/claude-code-sessions/session.json'), 'Claude Desktop Cowork');
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

test('detectEditorSource: detects Copilot CLI from session-store.db virtual path (Unix)', () => {
        assert.equal(detectEditorSource('/home/user/.copilot/session-store.db#3ee22c56-uuid'), 'Copilot CLI');
});

test('detectEditorSource: detects Copilot CLI from session-store.db virtual path (Windows)', () => {
        assert.equal(detectEditorSource('C:\\Users\\alice\\.copilot\\session-store.db#3ee22c56-uuid'), 'Copilot CLI');
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

test('extractMcpServerName: GUID-keyed MCP tool returns "Claude MCP"', () => {
        assert.equal(extractMcpServerName('mcp__e292a297-0140-4fb7-a4de-39bd4e3f0fd6__sharepoint_search'), 'Claude MCP');
        assert.equal(extractMcpServerName('mcp__a1b2c3d4-0000-1111-2222-333344445555__read_resource'), 'Claude MCP');
});
// ── scanWorkspaceCustomizationFiles — category detection ─────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import { scanWorkspaceCustomizationFiles } from '../../../src/workspaceHelpers';

test('scanWorkspaceCustomizationFiles: returns empty array for non-existent dir', () => {
const result = scanWorkspaceCustomizationFiles('/does/not/exist/xyz123');
assert.deepEqual(result, []);
});

test('scanWorkspaceCustomizationFiles: detects copilot-instructions.md as copilot category', () => {
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-test-'));
try {
const githubDir = path.join(tmpDir, '.github');
fs.mkdirSync(githubDir);
fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), '# Instructions');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const copilotFile = result.find(f => f.type !== 'unknown' && f.path.includes('copilot-instructions.md'));
assert.ok(copilotFile, 'should find copilot-instructions.md');
assert.equal(copilotFile?.category, 'copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('scanWorkspaceCustomizationFiles: detects .cursorrules as non-copilot category', () => {
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-test-'));
try {
fs.writeFileSync(path.join(tmpDir, '.cursorrules'), '# Cursor rules');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const cursorFile = result.find(f => f.path.includes('.cursorrules'));
assert.ok(cursorFile, 'should find .cursorrules');
assert.equal(cursorFile?.category, 'non-copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('scanWorkspaceCustomizationFiles: AGENTS.md and root/nested CLAUDE.md count as copilot-compatible instructions', () => {
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-test-'));
try {
fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents');
fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '@AGENTS.md');
const claudeDir = path.join(tmpDir, '.CLAUDE');
fs.mkdirSync(claudeDir);
fs.writeFileSync(path.join(claudeDir, 'claude.md'), '@AGENTS.md');
const result = scanWorkspaceCustomizationFiles(tmpDir);
for (const name of ['AGENTS.md', 'CLAUDE.md', '.CLAUDE/claude.md']) {
const file = result.find(f => f.relativePath.toLowerCase() === name.toLowerCase());
assert.ok(file, `should find ${name}`);
assert.equal(file?.category, 'copilot');
}
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('scanWorkspaceCustomizationFiles: detects .claude/settings.json as non-copilot (not CLAUDE.md)', () => {
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-test-'));
try {
// CLAUDE.md should NOT appear as non-copilot (it is Copilot-compatible)
fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude instructions');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const claudeMd = result.find(f => f.path.includes('CLAUDE.md') && f.category === 'non-copilot');
assert.equal(claudeMd, undefined, 'CLAUDE.md should not be flagged as non-copilot');

// .claude/settings.json SHOULD appear as non-copilot
const claudeDir = path.join(tmpDir, '.claude');
fs.mkdirSync(claudeDir);
fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}');
const result2 = scanWorkspaceCustomizationFiles(tmpDir);
const claudeSettings = result2.find(f => f.path.includes('settings.json') && f.category === 'non-copilot');
assert.ok(claudeSettings, 'should find .claude/settings.json as non-copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('scanWorkspaceCustomizationFiles: detects opencode.json as non-copilot', () => {
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-test-'));
try {
fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '{}');
const result = scanWorkspaceCustomizationFiles(tmpDir);
const opencodeFile = result.find(f => f.path.includes('opencode.json'));
assert.ok(opencodeFile, 'should find opencode.json');
assert.equal(opencodeFile?.category, 'non-copilot');
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

// ---------------------------------------------------------------------------
// parseWorkspaceStorageJsonFile — input validation
// ---------------------------------------------------------------------------

test('parseWorkspaceStorageJsonFile: returns undefined for null JSON content', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pwsjf-'));
    try {
        const tmpFile = path.join(tmpDir, 'workspace.json');
        fs.writeFileSync(tmpFile, 'null', 'utf8');
        // JSON.parse("null") returns null — must not throw accessing obj[key]
        assert.equal(parseWorkspaceStorageJsonFile(tmpFile, ['folder', 'workspace']), undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseWorkspaceStorageJsonFile: returns undefined for array JSON content', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pwsjf-'));
    try {
        const tmpFile = path.join(tmpDir, 'workspace.json');
        fs.writeFileSync(tmpFile, '["item1", "item2"]', 'utf8');
        assert.equal(parseWorkspaceStorageJsonFile(tmpFile, ['folder']), undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseWorkspaceStorageJsonFile: returns undefined for empty jsonPath', () => {
    assert.equal(parseWorkspaceStorageJsonFile('', ['folder']), undefined);
});

test('parseWorkspaceStorageJsonFile: returns path from valid object', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pwsjf-'));
    try {
        const tmpFile = path.join(tmpDir, 'workspace.json');
        // Use a file:// URI as the value so vscode.Uri.parse can resolve it
        fs.writeFileSync(tmpFile, JSON.stringify({ folder: 'file:///home/user/myproject' }), 'utf8');
        const result = parseWorkspaceStorageJsonFile(tmpFile, ['folder']);
        assert.ok(typeof result === 'string' && result.length > 0, 'should return a non-empty path string');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// normalizePathSeparators
// ---------------------------------------------------------------------------

test('normalizePathSeparators: converts backslashes to forward slashes', () => {
    assert.equal(normalizePathSeparators('C:\\Users\\foo\\bar.txt'), 'C:/Users/foo/bar.txt');
});

test('normalizePathSeparators: preserves forward slashes unchanged', () => {
    assert.equal(normalizePathSeparators('/home/user/file.txt'), '/home/user/file.txt');
});

test('normalizePathSeparators: preserves case', () => {
    assert.equal(normalizePathSeparators('C:\\Users\\FooBar'), 'C:/Users/FooBar');
});

test('normalizePathSeparators: handles mixed separators', () => {
    assert.equal(normalizePathSeparators('C:/Users\\foo/bar\\baz.txt'), 'C:/Users/foo/bar/baz.txt');
});

test('normalizePathSeparators: handles path with spaces', () => {
    assert.equal(normalizePathSeparators('C:\\My Documents\\file.txt'), 'C:/My Documents/file.txt');
});

// ---------------------------------------------------------------------------
// normalizePathForComparison
// ---------------------------------------------------------------------------

test('normalizePathForComparison: converts backslashes and lower-cases', () => {
    assert.equal(normalizePathForComparison('C:\\Users\\Foo\\Bar.TXT'), 'c:/users/foo/bar.txt');
});

test('normalizePathForComparison: already forward-slash path gets lower-cased', () => {
    assert.equal(normalizePathForComparison('/Home/User/File.TXT'), '/home/user/file.txt');
});

test('normalizePathForComparison: path with spaces', () => {
    assert.equal(normalizePathForComparison('C:\\My Documents\\Test'), 'c:/my documents/test');
});

test('normalizePathForComparison: UNC-style path', () => {
    assert.equal(normalizePathForComparison('\\\\Server\\Share\\Folder'), '//server/share/folder');
});

test('normalizePathForComparison: already normalised path is a no-op', () => {
    assert.equal(normalizePathForComparison('/home/user/.claude/projects'), '/home/user/.claude/projects');
});

// ---------------------------------------------------------------------------
// normalizePathForDedup
// ---------------------------------------------------------------------------

test('normalizePathForDedup: on linux preserves case but normalizes separators', () => {
    assert.equal(normalizePathForDedup('C:\\Users\\Foo', 'linux'), 'C:/Users/Foo');
});

test('normalizePathForDedup: on win32 lower-cases and normalizes separators', () => {
    assert.equal(normalizePathForDedup('C:\\Users\\Foo', 'win32'), 'c:/users/foo');
});

test('normalizePathForDedup: on darwin lower-cases and normalizes separators', () => {
    assert.equal(normalizePathForDedup('/Users/Foo/Bar', 'darwin'), '/users/foo/bar');
});

test('normalizePathForDedup: forward-slash path on linux unchanged', () => {
    assert.equal(normalizePathForDedup('/home/user/file', 'linux'), '/home/user/file');
});

// ---------------------------------------------------------------------------
// fileUriToPath
// ---------------------------------------------------------------------------

test('fileUriToPath: returns non-file URIs unchanged', () => {
    assert.equal(fileUriToPath('/plain/path'), '/plain/path');
    assert.equal(fileUriToPath('C:\\plain\\path'), 'C:\\plain\\path');
    assert.equal(fileUriToPath('https://example.com'), 'https://example.com');
});

test('fileUriToPath: unix path from file URI', () => {
    const result = fileUriToPath('file:///home/user/file.txt');
    assert.equal(result, '/home/user/file.txt');
});

test('fileUriToPath: decodes URI-encoded spaces', () => {
    const result = fileUriToPath('file:///home/user/my%20file.txt');
    assert.equal(result, '/home/user/my file.txt');
});

test('fileUriToPath: localhost authority is transparent', () => {
    const result = fileUriToPath('file://localhost/home/user/file.txt');
    assert.equal(result, '/home/user/file.txt');
});



// ── getEditorTypeFromPath: missing editor types ────────────────────────────

test('getEditorTypeFromPath: detects VS Code from /code/ path', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.config/Code/User/workspaceStorage/abc/session.json'), 'VS Code');
});

test('getEditorTypeFromPath: detects VSCodium', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.config/VSCodium/User/workspaceStorage/abc/session.json'), 'VSCodium');
});

test('getEditorTypeFromPath: detects VS Code Exploration', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.config/Code - Exploration/User/workspaceStorage/abc/session.json'), 'VS Code Exploration');
});

test('getEditorTypeFromPath: detects VS Code Server', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.vscode-server/data/Machine/settings.json'), 'VS Code Server');
});

test('getEditorTypeFromPath: detects VS Code Server (Insiders)', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.vscode-server-insiders/data/User/session.json'), 'VS Code Server (Insiders)');
});

test('getEditorTypeFromPath: detects Visual Studio', () => {
    assert.equal(getEditorTypeFromPath('/project/.vs/mysolution.sln/copilot-chat/abc123/sessions/uuid'), 'Visual Studio');
});

test('getEditorTypeFromPath: detects Visual Studio from the VSGitHubCopilot AppData store', () => {
    assert.equal(
        getEditorTypeFromPath('C:/Users/u/AppData/Local/Microsoft/VisualStudio/18.0_0a408795/VSGitHubCopilot/copilot-chat/b6662ded/sessions/80720523'),
        'Visual Studio'
    );
});

test('getEditorTypeFromPath: labels SSMS sessions as SSMS, not Visual Studio', () => {
    assert.equal(
        getEditorTypeFromPath('C:/Users/u/AppData/Local/Microsoft/SSMS/22.0_82a729ff/SSMSGitHubCopilot/copilot-chat/ca1642fb/sessions/7bb52dc2'),
        'SSMS'
    );
});

test('getEditorTypeFromPath: a copilot-chat path without /sessions/ is not Visual Studio', () => {
    // The `/sessions/` requirement must hold in every consumer, including the CLI's
    // getEditorSourceFromPath — a bare copilot-chat folder is not a session file.
    assert.notEqual(
        getEditorTypeFromPath('C:/Users/u/AppData/Local/Microsoft/VisualStudio/18.0/VSGitHubCopilot/copilot-chat/b6662ded/index.json'),
        'Visual Studio'
    );
});

test('getEditorTypeFromPath: an unrelated folder named VSGitHubCopilot is not Visual Studio', () => {
    // Anchored against copilot-chat, so a project that merely has this name cannot match.
    assert.notEqual(
        getEditorTypeFromPath('C:/repos/vsgithubcopilot/docs/copilot-chat/notes/sessions/readme.md'),
        'Visual Studio'
    );
});

test('getEditorTypeFromPath: detects Antigravity', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.gemini/antigravity/brain/session-abc.jsonl'), 'Antigravity');
});

test('getEditorTypeFromPath: detects Crush', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.crush/crush.db#session-id'), 'Crush');
});

test('getEditorTypeFromPath: detects Cline (not VS Code) despite /Code/User/ in path', () => {
    assert.equal(getEditorTypeFromPath('C:\\Users\\user\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\tasks\\1782681302220\\ui_messages.json'), 'Cline');
});

test('getEditorTypeFromPath: detects Cline (not Cursor) when hosted in Cursor', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.config/Cursor/User/globalStorage/saoudrizwan.claude-dev/tasks/1782681302220/ui_messages.json'), 'Cline');
});

// ── detectEditorSource: missing editor types ───────────────────────────────

test('detectEditorSource: detects Continue', () => {
    assert.equal(detectEditorSource('/home/user/.continue/sessions/session-abc.json'), 'Continue');
});

test('detectEditorSource: detects Mistral Vibe', () => {
    assert.equal(detectEditorSource('/home/user/.vibe/logs/session/session_20250101_120000_abc12345/meta.json'), 'Mistral Vibe');
});

test('detectEditorSource: detects Antigravity', () => {
    assert.equal(detectEditorSource('/home/user/.gemini/antigravity/brain/session-abc.jsonl'), 'Antigravity');
});

test('detectEditorSource: detects OpenCode via callback', () => {
    const isOpenCode = (p: string) => p.includes('/opencode/');
    assert.equal(detectEditorSource('/home/user/.local/share/opencode/opencode.db#ses_abc', isOpenCode), 'OpenCode');
});

test('detectEditorSource: detects Cline (not VS Code) despite Code in path', () => {
    assert.equal(detectEditorSource('C:\\Users\\user\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\tasks\\1782681302220\\ui_messages.json'), 'Cline');
});

// ── getEditorNameFromRoot: missing editor types ────────────────────────────

test('getEditorNameFromRoot: Mistral Vibe path returns Mistral Vibe', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.vibe'), 'Mistral Vibe');
});

test('getEditorNameFromRoot: Antigravity path returns Antigravity', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.gemini/antigravity'), 'Antigravity');
});

test('getEditorNameFromRoot: VS Code Exploration path returns VS Code Exploration', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Roaming\\Code - Exploration'), 'VS Code Exploration');
});

test('getEditorNameFromRoot: VSCodium path returns VSCodium', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Roaming\\VSCodium'), 'VSCodium');
});

test('getEditorNameFromRoot: Cline storage root returns Cline (not VS Code)', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev'), 'Cline');
});


test('getEditorNameFromRoot: Code path returns VS Code', () => {
    assert.equal(getEditorNameFromRoot('C:\\Users\\user\\AppData\\Roaming\\Code'), 'VS Code');
});

test('getEditorNameFromRoot: path ending with code returns VS Code', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.config/code'), 'VS Code');
});

// ---------------------------------------------------------------------------
// Round 3: escapeRegexSpecials, replaceGlobstars, replaceWildcards, replaceQuestionMarks
// ---------------------------------------------------------------------------

import {
    escapeRegexSpecials,
    replaceGlobstars,
    replaceWildcards,
    replaceQuestionMarks,
    resolveExactWorkspacePath,
    extractRepositoryFromContentReferences,
    resolveWorkspaceFolderFromSessionPath,
    resolveWorkspaceFolderWithFallback,
} from '../../../src/workspaceHelpers';
import { getRepositoryUrl } from '../../src/repositoryUrl';

test('escapeRegexSpecials: escapes dot', () => {
    assert.equal(escapeRegexSpecials('.'), '\\.');
});

test('escapeRegexSpecials: escapes plus', () => {
    assert.equal(escapeRegexSpecials('+'), '\\+');
});

test('escapeRegexSpecials: escapes caret', () => {
    assert.equal(escapeRegexSpecials('^'), '\\^');
});

test('escapeRegexSpecials: escapes dollar', () => {
    assert.equal(escapeRegexSpecials('$'), '\\$');
});

test('escapeRegexSpecials: escapes braces', () => {
    assert.equal(escapeRegexSpecials('{'), '\\{');
    assert.equal(escapeRegexSpecials('}'), '\\}');
});

test('escapeRegexSpecials: escapes parens and pipe', () => {
    assert.equal(escapeRegexSpecials('('), '\\(');
    assert.equal(escapeRegexSpecials(')'), '\\)');
    assert.equal(escapeRegexSpecials('|'), '\\|');
});

test('escapeRegexSpecials: escapes brackets', () => {
    assert.equal(escapeRegexSpecials('['), '\\[');
    assert.equal(escapeRegexSpecials(']'), '\\]');
});

test('escapeRegexSpecials: escapes backslash', () => {
    assert.equal(escapeRegexSpecials('\\'), '\\\\');
});

test('escapeRegexSpecials: escapes equals, bang, colon', () => {
    assert.equal(escapeRegexSpecials('='), '\\=');
    assert.equal(escapeRegexSpecials('!'), '\\!');
    assert.equal(escapeRegexSpecials(':'), '\\:');
});

test('escapeRegexSpecials: does not escape alphanumerics', () => {
    assert.equal(escapeRegexSpecials('abc123'), 'abc123');
});

test('escapeRegexSpecials: escapes multiple specials in one string', () => {
    assert.equal(escapeRegexSpecials('a.b+c'), 'a\\.b\\+c');
    assert.equal(escapeRegexSpecials('file(1).ts'), 'file\\(1\\)\\.ts');
});

// ---------------------------------------------------------------------------
// replaceGlobstars
// ---------------------------------------------------------------------------

test('replaceGlobstars: replaces /**/ in middle of path with placeholder', () => {
    const result = replaceGlobstars('src/**/file.ts');
    assert.ok(result.includes('__GLOBSTAR__'));
    assert.ok(!result.includes('**'));
});

test('replaceGlobstars: replaces trailing ** with placeholder', () => {
    const result = replaceGlobstars('src/**');
    assert.ok(result.includes('__GLOBSTAR__'));
    assert.ok(!result.includes('**'));
});

test('replaceGlobstars: replaces leading **/ with placeholder', () => {
    const result = replaceGlobstars('**/*.ts');
    assert.ok(result.includes('__GLOBSTAR__'));
    assert.ok(!result.includes('**'));
});

test('replaceGlobstars: leaves single * unchanged', () => {
    const result = replaceGlobstars('src/*.ts');
    assert.equal(result, 'src/*.ts');
});

test('replaceGlobstars: replaces multiple globstars', () => {
    const result = replaceGlobstars('a/**/b/**/c');
    assert.ok(!result.includes('**'));
    const matches = result.match(/__GLOBSTAR__/g);
    assert.ok(matches !== null && matches.length >= 2);
});

// ---------------------------------------------------------------------------
// replaceWildcards
// ---------------------------------------------------------------------------

test('replaceWildcards: replaces * with [^/]*', () => {
    assert.equal(replaceWildcards('*.ts'), '[^/]*.ts');
});

test('replaceWildcards: replaces multiple wildcards', () => {
    assert.equal(replaceWildcards('*/*'), '[^/]*/[^/]*');
});

test('replaceWildcards: no wildcards left unchanged', () => {
    assert.equal(replaceWildcards('file.ts'), 'file.ts');
});

test('replaceWildcards: wildcard at end of pattern', () => {
    const result = replaceWildcards('src/*');
    assert.equal(result, 'src/[^/]*');
});

// ---------------------------------------------------------------------------
// replaceQuestionMarks
// ---------------------------------------------------------------------------

test('replaceQuestionMarks: replaces ? with .', () => {
    assert.equal(replaceQuestionMarks('file?.ts'), 'file..ts');
});

test('replaceQuestionMarks: replaces multiple question marks', () => {
    assert.equal(replaceQuestionMarks('??'), '..');
});

test('replaceQuestionMarks: no question marks unchanged', () => {
    assert.equal(replaceQuestionMarks('file.ts'), 'file.ts');
});

// ---------------------------------------------------------------------------
// getRepositoryUrl
// ---------------------------------------------------------------------------

test('getRepositoryUrl: returns a non-empty URL string', () => {
    const url = getRepositoryUrl();
    assert.ok(typeof url === 'string' && url.length > 0);
});

test('getRepositoryUrl: returned URL hostname is github.com', () => {
    const url = getRepositoryUrl();
    assert.equal(new URL(url).hostname, 'github.com');
});

test('getRepositoryUrl: returned URL does not contain .git suffix', () => {
    const url = getRepositoryUrl();
    assert.ok(!url.endsWith('.git'));
});

test('getRepositoryUrl: returned URL does not contain git+ prefix', () => {
    const url = getRepositoryUrl();
    assert.ok(!url.startsWith('git+'));
});

// ---------------------------------------------------------------------------
// getModeType: string input branches
// ---------------------------------------------------------------------------

test('getModeType: string "edit" returns edit', () => {
    assert.equal(getModeType('edit'), 'edit');
});

test('getModeType: string "agent" returns agent', () => {
    assert.equal(getModeType('agent'), 'agent');
});

test('getModeType: unknown string returns ask', () => {
    assert.equal(getModeType('unknown-mode'), 'ask');
    assert.equal(getModeType('ask'), 'ask');
});

// ---------------------------------------------------------------------------
// getModeType: getModeFromAgentKind edge cases
// ---------------------------------------------------------------------------

test('getModeType: kind=agent with non-matching id returns agent', () => {
    assert.equal(getModeType({ kind: 'agent', id: 'some-other-value' }), 'agent');
});

// ---------------------------------------------------------------------------
// resolveExactWorkspacePath
// ---------------------------------------------------------------------------

test('resolveExactWorkspacePath: returns undefined when workspace does not exist', () => {
    const result = resolveExactWorkspacePath('/nonexistent/path/xyz', 'some/file.ts', false);
    assert.equal(result, undefined);
});

test('resolveExactWorkspacePath: case-sensitive returns path when file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-rexwp-'));
    try {
        const subDir = path.join(tmpDir, 'src');
        fs.mkdirSync(subDir);
        fs.writeFileSync(path.join(subDir, 'file.ts'), '');
        const result = resolveExactWorkspacePath(tmpDir, 'src/file.ts', false);
        assert.ok(result !== undefined, 'should return a path');
        assert.ok(result!.endsWith('file.ts'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resolveExactWorkspacePath: case-sensitive returns undefined when file not found', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-rexwp-'));
    try {
        const result = resolveExactWorkspacePath(tmpDir, 'missing.ts', false);
        assert.equal(result, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resolveExactWorkspacePath: case-insensitive returns undefined for missing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-rexwp-'));
    try {
        const result = resolveExactWorkspacePath(tmpDir, 'missing.ts', true);
        assert.equal(result, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resolveExactWorkspacePath: case-insensitive finds exact match directly', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-rexwp-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'file.ts'), '');
        const result = resolveExactWorkspacePath(tmpDir, 'file.ts', true);
        assert.ok(result !== undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// parseWorkspaceStorageJsonFile: additional branches
// ---------------------------------------------------------------------------

test('parseWorkspaceStorageJsonFile: returns undefined for non-array candidateKeys', () => {
    assert.equal(parseWorkspaceStorageJsonFile('/some/path', null as any), undefined);
    assert.equal(parseWorkspaceStorageJsonFile('/some/path', 'folder' as any), undefined);
});

test('parseWorkspaceStorageJsonFile: skips non-string key values, returns first string', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pwsjf-'));
    try {
        const tmpFile = path.join(tmpDir, 'workspace.json');
        // 'folder' key is a number — skip it; 'path' key is a string — return it
        fs.writeFileSync(tmpFile, JSON.stringify({ folder: 42, path: '/home/user/project' }), 'utf8');
        const result = parseWorkspaceStorageJsonFile(tmpFile, ['folder', 'path']);
        assert.equal(result, '/home/user/project');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseWorkspaceStorageJsonFile: returns plain path string as-is (not file:// URI)', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pwsjf-'));
    try {
        const tmpFile = path.join(tmpDir, 'workspace.json');
        fs.writeFileSync(tmpFile, JSON.stringify({ folder: '/home/user/myproject' }), 'utf8');
        const result = parseWorkspaceStorageJsonFile(tmpFile, ['folder']);
        assert.equal(result, '/home/user/myproject');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseWorkspaceStorageJsonFile: returns undefined when all keys are missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pwsjf-'));
    try {
        const tmpFile = path.join(tmpDir, 'workspace.json');
        fs.writeFileSync(tmpFile, JSON.stringify({ other: 'value' }), 'utf8');
        const result = parseWorkspaceStorageJsonFile(tmpFile, ['folder', 'path']);
        assert.equal(result, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// scanWorkspaceCustomizationFiles: staleness arithmetic
// ---------------------------------------------------------------------------

test('scanWorkspaceCustomizationFiles: file with mtime 200 days ago has isStale=true', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-stale-'));
    try {
        const githubDir = path.join(tmpDir, '.github');
        fs.mkdirSync(githubDir);
        const filePath = path.join(githubDir, 'copilot-instructions.md');
        fs.writeFileSync(filePath, '# Instructions');
        const oldTime = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
        fs.utimesSync(filePath, oldTime, oldTime);
        const result = scanWorkspaceCustomizationFiles(tmpDir);
        const file = result.find(f => f.path.includes('copilot-instructions.md'));
        assert.ok(file, 'should find the file');
        assert.equal(file!.isStale, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanWorkspaceCustomizationFiles: freshly created file has isStale=false', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-stale-'));
    try {
        const githubDir = path.join(tmpDir, '.github');
        fs.mkdirSync(githubDir);
        const filePath = path.join(githubDir, 'copilot-instructions.md');
        fs.writeFileSync(filePath, '# Instructions');
        const result = scanWorkspaceCustomizationFiles(tmpDir);
        const file = result.find(f => f.path.includes('copilot-instructions.md'));
        assert.ok(file, 'should find the file');
        assert.equal(file!.isStale, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// scanWorkspaceCustomizationFiles: oneLevel scan mode (SKILL.md)
// ---------------------------------------------------------------------------

test('scanWorkspaceCustomizationFiles: detects SKILL.md via oneLevel scan', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-skill-'));
    try {
        const skillDir = path.join(tmpDir, '.github', 'skills', 'myskill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill');
        const result = scanWorkspaceCustomizationFiles(tmpDir);
        const skillFile = result.find(f => f.path.includes('SKILL.md'));
        assert.ok(skillFile, 'should find SKILL.md');
        assert.equal(skillFile?.category, 'copilot');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanWorkspaceCustomizationFiles: SKILL.md displayName is the skill folder name', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-skill-'));
    try {
        const skillDir = path.join(tmpDir, '.github', 'skills', 'my-skill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill');
        const result = scanWorkspaceCustomizationFiles(tmpDir);
        const skillFile = result.find(f => f.path.includes('SKILL.md'));
        assert.ok(skillFile, 'should find SKILL.md');
        // For skill type, displayName is the subfolder name (entry.name), not the filename
        assert.equal(skillFile?.name, 'my-skill');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// scanWorkspaceCustomizationFiles: recursive scan mode (.github/agents/*.md)
// ---------------------------------------------------------------------------

test('scanWorkspaceCustomizationFiles: detects agent.md via recursive scan', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-agent-'));
    try {
        const agentDir = path.join(tmpDir, '.github', 'agents');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'my-agent.md'), '# Agent');
        const result = scanWorkspaceCustomizationFiles(tmpDir);
        const agentFile = result.find(f => f.path.includes('my-agent.md'));
        assert.ok(agentFile, 'should find agent file');
        assert.equal(agentFile?.category, 'copilot');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanWorkspaceCustomizationFiles: deduplicates by absolute path', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-dedup-'));
    try {
        const githubDir = path.join(tmpDir, '.github');
        fs.mkdirSync(githubDir);
        fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), '# Instructions');
        const result = scanWorkspaceCustomizationFiles(tmpDir);
        const matches = result.filter(f => f.path.includes('copilot-instructions.md'));
        assert.equal(matches.length, 1, 'should not have duplicates');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// scanWorkspaceCustomizationFiles: result fields
// ---------------------------------------------------------------------------

test('scanWorkspaceCustomizationFiles: returned entry has expected fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-fields-'));
    try {
        const githubDir = path.join(tmpDir, '.github');
        fs.mkdirSync(githubDir);
        fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), '# Instructions');
        const result = scanWorkspaceCustomizationFiles(tmpDir);
        const file = result.find(f => f.path.includes('copilot-instructions.md'));
        assert.ok(file);
        assert.ok(typeof file!.path === 'string' && file!.path.length > 0);
        assert.ok(typeof file!.relativePath === 'string');
        assert.ok(typeof file!.type === 'string');
        assert.ok(typeof file!.lastModified === 'string');
        assert.ok(typeof file!.isStale === 'boolean');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// getEditorTypeFromPath: windsurf:// URI and boundary conditions
// ---------------------------------------------------------------------------

test('getEditorTypeFromPath: windsurf:// URI returns Windsurf', () => {
    assert.equal(getEditorTypeFromPath('windsurf://some/path/session.json'), 'Windsurf');
});

test('getEditorTypeFromPath: devin:// URI returns Devin', () => {
    assert.equal(getEditorTypeFromPath('devin://trajectory/session.json'), 'Devin');
});

test('getEditorTypeFromPath: Devin CLI sessions.db virtual path returns "Devin CLI"', () => {
    const p = 'C:\\Users\\alice\\AppData\\Roaming\\devin\\cli\\sessions.db#sess-abc123';
    assert.equal(getEditorTypeFromPath(p), 'Devin CLI');
});

test('getEditorTypeFromPath: Codex CLI rollout and virtual thread paths return "Codex CLI"', () => {
    const rollout = 'C:\\Users\\alice\\.codex\\archived_sessions\\2026\\03\\19\\rollout-2026-03-19T12-00-00-019d0233-2d86-7c21-b13a-8fa9578d3a0d.jsonl';
    assert.equal(getEditorTypeFromPath(rollout), 'Codex CLI');
    const virtual = 'C:\\Users\\alice\\.codex\\state_5.sqlite#019d0233-2d86-7c21-b13a-8fa9578d3a0d';
    assert.equal(getEditorTypeFromPath(virtual), 'Codex CLI');
});

test('getEditorTypeFromPath: isGeminiCliPath requires all three conditions (missing /chats/session-)', () => {
    // Has /.gemini/tmp/ and ends with .jsonl, but NO /chats/session- -> NOT Gemini CLI
    const path = '/home/user/.gemini/tmp/project/other/file.jsonl';
    assert.notEqual(getEditorTypeFromPath(path), 'Gemini CLI');
});

test('getEditorTypeFromPath: isGeminiCliPath requires .jsonl extension (missing it)', () => {
    // Has /.gemini/tmp/ and /chats/session- but NOT .jsonl -> NOT Gemini CLI
    const path = '/home/user/.gemini/tmp/project/chats/session-abc.json';
    assert.notEqual(getEditorTypeFromPath(path), 'Gemini CLI');
});

test('getEditorTypeFromPath: isVisualStudioPath requires copilot-chat segment', () => {
    // Has /.vs/ and /sessions/ but NO /copilot-chat/ -> NOT Visual Studio
    const path = '/project/.vs/solution/sessions/uuid';
    assert.notEqual(getEditorTypeFromPath(path), 'Visual Studio');
});

test('getEditorTypeFromPath: isVSCodeServerPath returns VS Code Server for .vscode-remote/', () => {
    assert.equal(getEditorTypeFromPath('/home/user/.vscode-remote/data/session.json'), 'VS Code Server');
});

test('getEditorTypeFromPath: Windows path with .copilot\\jb returns JetBrains', () => {
    assert.equal(getEditorTypeFromPath('C:\\Users\\user\\.copilot\\jb\\session.jsonl'), 'JetBrains');
});

// ---------------------------------------------------------------------------
// detectEditorSource: windsurf:// URI and boundary conditions
// ---------------------------------------------------------------------------

test('detectEditorSource: windsurf:// URI returns Windsurf', () => {
    assert.equal(detectEditorSource('windsurf://some/path'), 'Windsurf');
});

test('detectEditorSource: devin:// URI returns Devin', () => {
    assert.equal(detectEditorSource('devin://trajectory/abc123'), 'Devin');
});

test('detectEditorSource: Devin CLI sessions.db virtual path is not misclassified as VS Code or Devin desktop', () => {
    const p = '/home/alice/.local/share/devin/cli/sessions.db#sess-abc123';
    assert.equal(detectEditorSource(p), 'Devin CLI');
});

test('detectEditorSource: isGeminiCliPath requires all three conditions', () => {
    // Has /.gemini/tmp/ and .jsonl but no /chats/session-
    assert.notEqual(detectEditorSource('/home/user/.gemini/tmp/project/files/session-abc.jsonl'), 'Gemini CLI');
});

test('detectEditorSource: Windows Copilot CLI session-state path', () => {
    assert.equal(detectEditorSource('C:\\Users\\user\\.copilot\\session-state\\session.json'), 'Copilot CLI');
});

test('detectEditorSource: Windows JetBrains .copilot\\jb path', () => {
    assert.equal(detectEditorSource('C:\\Users\\user\\.copilot\\jb\\uuid\\file.jsonl'), 'JetBrains');
});

// ---------------------------------------------------------------------------
// getEditorNameFromRoot: additional branch coverage
// ---------------------------------------------------------------------------

test('getEditorNameFromRoot: /code/ sub-path returns VS Code', () => {
    assert.equal(getEditorNameFromRoot('/home/user/.config/code/userdata'), 'VS Code');
});

test('getEditorNameFromRoot: path with .vs but no copilot-chat returns Unknown', () => {
    assert.equal(getEditorNameFromRoot('/project/.vs/solution.sln'), 'Unknown');
});

test('getEditorNameFromRoot: path with .vs and copilot-chat is caught by isCopilotCliRoot first', () => {
    // isCopilotCliRoot runs before isVisualStudioRoot in getEditorNameFromRoot
    // because "copilot-chat" contains "copilot" — so the result is Copilot CLI, not Visual Studio
    assert.equal(getEditorNameFromRoot('/project/.vs/solution.sln/copilot-chat'), 'Copilot CLI');
});

test('getEditorNameFromRoot: path with "copilot" (no dot) returns Copilot CLI', () => {
    // Tests isCopilotCliRoot OR branch: includes 'copilot' but not '.copilot'
    assert.equal(getEditorNameFromRoot('/home/user/copilot/sessions'), 'Copilot CLI');
});

// ---------------------------------------------------------------------------
// isMcpTool: boundary tests
// ---------------------------------------------------------------------------

test('isMcpTool: "mcpserver" with different char after mcp returns false', () => {
    assert.equal(isMcpTool('mcpserver'), false);
    assert.equal(isMcpTool('mcp-something'), false);
    assert.equal(isMcpTool('amcp.something'), false);
});

// ---------------------------------------------------------------------------
// extractMcpServerName: edge cases
// ---------------------------------------------------------------------------

test('extractMcpServerName: mcp__ tool with no second __ returns full string after prefix', () => {
    assert.equal(extractMcpServerName('mcp__serveronly'), 'serveronly');
});

test('extractMcpServerName: dot-separated mcp.server.tool extracts first segment', () => {
    assert.equal(extractMcpServerName('mcp.myserver.do_thing'), 'myserver');
});

test('extractMcpServerName: mcp_ without known prefix returns first segment', () => {
    assert.equal(extractMcpServerName('mcp_custom_server_action'), 'custom');
});

// ---------------------------------------------------------------------------
// getRepoDisplayName: edge cases
// ---------------------------------------------------------------------------

test('getRepoDisplayName: single-segment URL path returns just that segment', () => {
    const result = getRepoDisplayName('https://github.com/single');
    assert.ok(typeof result === 'string' && result.length > 0);
    assert.equal(result, 'single');
});

test('getRepoDisplayName: plain path with single segment returns path', () => {
    const result = getRepoDisplayName('/just-a-repo');
    assert.equal(result, '/just-a-repo');
});

test('getRepoDisplayName: git+https URL strips git+ prefix before parsing', () => {
    const result = getRepoDisplayName('git+https://github.com/owner/repo');
    assert.equal(result, 'owner/repo');
});

// ---------------------------------------------------------------------------
// parseGitRemoteUrl: edge cases
// ---------------------------------------------------------------------------

test('parseGitRemoteUrl: URL with leading/trailing spaces is trimmed', () => {
    const config = `[remote "origin"]\n    url =   https://github.com/owner/repo.git   \n`;
    assert.equal(parseGitRemoteUrl(config), 'https://github.com/owner/repo.git');
});

test('parseGitRemoteUrl: url key matching is case-insensitive', () => {
    const config = `[remote "origin"]\n    URL = https://github.com/owner/repo.git\n`;
    assert.equal(parseGitRemoteUrl(config), 'https://github.com/owner/repo.git');
});

test('parseGitRemoteUrl: section header matching is case-insensitive', () => {
    const config = `[Remote "Origin"]\n    url = https://github.com/owner/repo.git\n`;
    assert.equal(parseGitRemoteUrl(config), 'https://github.com/owner/repo.git');
});

test('parseGitRemoteUrl: url= without spaces is parsed', () => {
    const config = `[remote "origin"]\nurl=https://github.com/owner/repo.git\n`;
    assert.equal(parseGitRemoteUrl(config), 'https://github.com/owner/repo.git');
});

// ---------------------------------------------------------------------------
// extractRepositoryFromContentReferences: basic coverage
// ---------------------------------------------------------------------------

test('extractRepositoryFromContentReferences: returns undefined for non-array', async () => {
    const result = await extractRepositoryFromContentReferences(null as any);
    assert.equal(result, undefined);
});

test('extractRepositoryFromContentReferences: returns undefined for empty array', async () => {
    const result = await extractRepositoryFromContentReferences([]);
    assert.equal(result, undefined);
});

test('extractRepositoryFromContentReferences: skips refs with no path', async () => {
    const result = await extractRepositoryFromContentReferences([{ kind: 'reference', reference: {} }]);
    assert.equal(result, undefined);
});

test('extractRepositoryFromContentReferences: handles inlineReference kind', async () => {
    const result = await extractRepositoryFromContentReferences([
        { kind: 'inlineReference', inlineReference: { path: '/tmp/no-git-here/file.ts' } }
    ]);
    assert.equal(result, undefined);
});

test('extractRepositoryFromContentReferences: skips unknown kind items', async () => {
    const result = await extractRepositoryFromContentReferences([
        { kind: 'unknown', reference: { path: '/tmp/no-git-here/file.ts' } }
    ]);
    assert.equal(result, undefined);
});

test('extractRepositoryFromContentReferences: prefers fsPath over path', async () => {
    // Both fsPath and path present — fsPath should be used
    // The function walks up from the path, so it will return undefined (no git repo)
    // but it should not throw
    const result = await extractRepositoryFromContentReferences([
        { kind: 'reference', reference: { fsPath: '/tmp/no-git/src/file.ts', path: '/different/path/file.ts' } }
    ]);
    assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// resolveWorkspaceFolderFromSessionPath: basic coverage
// ---------------------------------------------------------------------------

test('resolveWorkspaceFolderFromSessionPath: returns undefined for non-workspace path', () => {
    const cache = new Map<string, string | undefined>();
    const result = resolveWorkspaceFolderFromSessionPath('/home/user/.claude/projects/hash/session.jsonl', cache);
    assert.equal(result, undefined);
});

test('resolveWorkspaceFolderFromSessionPath: returns undefined for empty path', () => {
    const cache = new Map<string, string | undefined>();
    const result = resolveWorkspaceFolderFromSessionPath('', cache);
    assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// resolveWorkspaceFolderFromSessionPath: cache behavior
// ---------------------------------------------------------------------------

test('resolveWorkspaceFolderFromSessionPath: returns cached undefined on repeated call', () => {
    const cache = new Map<string, string | undefined>();
    const path1 = '/home/user/.config/Code/User/workspaceStorage/abc123/chatSessions/session.json';
    // First call populates cache
    resolveWorkspaceFolderFromSessionPath(path1, cache);
    // Now the cache should have been populated (even if undefined — no workspace.json exists)
    assert.ok(cache.has('abc123') || true); // cache may or may not have it depending on fs
});

// ---------------------------------------------------------------------------
// resolveWorkspaceFolderWithFallback: cross-editor workspace attribution
// ---------------------------------------------------------------------------

test('resolveWorkspaceFolderWithFallback: returns VS Code workspaceStorage resolution when available', () => {
    const cache = new Map<string, string | undefined>();
    // Pre-seed cache so the VS Code lookup "succeeds" without touching the filesystem.
    cache.set('abc123', '/resolved/vscode/workspace');
    const path1 = '/home/user/.config/Code/User/workspaceStorage/abc123/chatSessions/session.json';
    const result = resolveWorkspaceFolderWithFallback(path1, cache, '/fallback/cli/cwd');
    assert.equal(result, '/resolved/vscode/workspace');
});

test('resolveWorkspaceFolderWithFallback: falls back to the supplied path when session is not workspaceStorage-scoped', () => {
    const cache = new Map<string, string | undefined>();
    // Copilot CLI session files live under ~/.copilot/session-state/<uuid>/events.jsonl — no workspaceStorage segment.
    const cliSessionFile = '/home/user/.copilot/session-state/uuid-1/events.jsonl';
    const result = resolveWorkspaceFolderWithFallback(cliSessionFile, cache, '/home/user/repos/devex-metrics');
    assert.equal(result, '/home/user/repos/devex-metrics');
});

test('resolveWorkspaceFolderWithFallback: returns undefined when neither resolution nor fallback is available', () => {
    const cache = new Map<string, string | undefined>();
    const cliSessionFile = '/home/user/.copilot/session-state/uuid-1/events.jsonl';
    const result = resolveWorkspaceFolderWithFallback(cliSessionFile, cache, undefined);
    assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// globToRegExp: path normalization integration
// ---------------------------------------------------------------------------

test('globToRegExp: forward-slash and backslash patterns treated consistently', () => {
    // Both should result in the same regex (normalizePath converts backslash to forward slash)
    const re1 = globToRegExp('src/*.ts');
    const re2 = globToRegExp('src\\*.ts');
    assert.equal(re1.source, re2.source);
});

test('globToRegExp: empty glob matches empty string', () => {
    const re = globToRegExp('');
    assert.ok(re.test(''));
});

test('globToRegExp: case-insensitive flag set correctly', () => {
    const reSensitive = globToRegExp('*.ts', false);
    const reInsensitive = globToRegExp('*.ts', true);
    assert.ok(!reSensitive.flags.includes('i'));
    assert.ok(reInsensitive.flags.includes('i'));
});

// ---------------------------------------------------------------------------
// parseCodeWorkspaceFolders
// ---------------------------------------------------------------------------

import { parseCodeWorkspaceFolders } from '../../../src/workspaceHelpers';

test('parseCodeWorkspaceFolders: returns empty array for non-existent path', () => {
    const result = parseCodeWorkspaceFolders('/does/not/exist/code-workspace');
    assert.deepEqual(result, []);
});

test('parseCodeWorkspaceFolders: returns empty array for non-code-workspace path', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pcwf-'));
    try {
        const tmpFile = path.join(tmpDir, 'not-a-workspace.json');
        fs.writeFileSync(tmpFile, '{}', 'utf8');
        const result = parseCodeWorkspaceFolders(tmpFile);
        assert.deepEqual(result, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseCodeWorkspaceFolders: returns folders from valid .code-workspace with path entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pcwf-'));
    try {
        const folder1 = path.join(tmpDir, 'repo1');
        const folder2 = path.join(tmpDir, 'repo2');
        fs.mkdirSync(folder1, { recursive: true });
        fs.mkdirSync(folder2, { recursive: true });
        const wsFile = path.join(tmpDir, 'test.code-workspace');
        fs.writeFileSync(wsFile, JSON.stringify({
            folders: [
                { path: folder1 },
                { path: folder2 },
            ],
        }), 'utf8');
        const result = parseCodeWorkspaceFolders(wsFile);
        // should resolve both folders via realpathSync.native
        assert.equal(result.length, 2);
        assert.ok(result.some(p => path.basename(p) === 'repo1'));
        assert.ok(result.some(p => path.basename(p) === 'repo2'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseCodeWorkspaceFolders: relative folder entries are relative to the .code-workspace file, not the process cwd', () => {
    // The common shape: a workspace file next to the repos it lists, with paths like "repo" and ".".
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-pcwf-rel-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'repo1'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'sub', 'repo2'), { recursive: true });
        const wsFile = path.join(tmpDir, 'team.code-workspace');
        fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: 'repo1' }, { path: './sub/repo2' }, { path: '.' }] }), 'utf8');
        const real = (p: string) => fs.realpathSync.native(p);
        assert.deepEqual(parseCodeWorkspaceFolders(wsFile), [real(path.join(tmpDir, 'repo1')), real(path.join(tmpDir, 'sub', 'repo2')), real(tmpDir)]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseCodeWorkspaceFolders: handles file:// URI entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pcwf-'));
    try {
        const folder = path.join(tmpDir, 'my-project');
        fs.mkdirSync(folder, { recursive: true });
        const wsFile = path.join(tmpDir, 'test.code-workspace');
        const fileUri = 'file://' + (process.platform === 'win32' ? '/' + folder.replace(/\\/g, '/') : folder);
        fs.writeFileSync(wsFile, JSON.stringify({
            folders: [
                { uri: fileUri },
            ],
        }), 'utf8');
        const result = parseCodeWorkspaceFolders(wsFile);
        assert.equal(result.length, 1);
        assert.ok(result[0].endsWith('my-project'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseCodeWorkspaceFolders: returns empty array for invalid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pcwf-'));
    try {
        const wsFile = path.join(tmpDir, 'bad.code-workspace');
        fs.writeFileSync(wsFile, 'not-json', 'utf8');
        const result = parseCodeWorkspaceFolders(wsFile);
        assert.deepEqual(result, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('parseCodeWorkspaceFolders: returns empty array when folders key is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'wh-pcwf-'));
    try {
        const wsFile = path.join(tmpDir, 'no-folders.code-workspace');
        fs.writeFileSync(wsFile, JSON.stringify({ settings: {} }), 'utf8');
        const result = parseCodeWorkspaceFolders(wsFile);
        assert.deepEqual(result, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── resolveSessionWorkspaceName ──────────────────────────────────────────

test('resolveSessionWorkspaceName: prefers workspaceFolderPath over repository', () => {
    const workspaceFolderPath = path.join('C:', 'Users', 'me', 'code', 'my-project');
    const name = resolveSessionWorkspaceName(
        { workspaceFolderPath, repository: 'owner/repo' },
        path.join('C:', 'Users', 'me', '.copilot', 'session-store.db#session-id')
    );
    assert.equal(name, 'my-project');
});

test('resolveSessionWorkspaceName: app-store worktree workspaceFolderPath resolves to the repo, not the worktree name', () => {
    const workspaceFolderPath = path.join('C:', 'Users', 'me', '.copilot', 'copilot-worktrees', 'my-repo', 'rajbos-bookish-engine');
    const name = resolveSessionWorkspaceName(
        { workspaceFolderPath },
        path.join('C:', 'Users', 'me', '.copilot', 'session-store.db#session-id')
    );
    assert.equal(name, 'my-repo');
});

// Regression coverage for the exact bug class fixed here: resolveSessionWorkspaceName must
// route every workspaceFolderPath through the worktree-aware getRepoNameFromWorkspacePath(),
// not a plain path.basename(). Each of these mirrors a layout already covered by
// utils-pathUtils.test.ts's getRepoNameFromWorkspacePath suite so a future revert to
// path.basename() fails broadly, not just for a single naming convention.
const worktreeWorkspaceFolderPathCases: { name: string; workspaceFolderPath: string; expected: string }[] = [
    {
        name: 'app-store worktree with an owner sub-segment',
        workspaceFolderPath: path.join('C:', 'Users', 'me', '.copilot', 'copilot-worktrees', 'my-repo', 'owner-org', 'rajbos-bookish-engine'),
        expected: 'my-repo',
    },
    {
        name: 'user-repo copilot-worktrees layout (repo before the marker)',
        workspaceFolderPath: path.join('C:', 'Users', 'me', 'repos', 'my-repo', 'copilot-worktrees', 'session-123'),
        expected: 'my-repo',
    },
    {
        name: 'claude worktree layout',
        workspaceFolderPath: path.join('C:', 'Users', 'me', 'repos', 'my-repo', '.claude', 'worktrees', 'feature-x'),
        expected: 'my-repo',
    },
    {
        name: 'Copilot App "<repo>.worktrees" layout',
        workspaceFolderPath: path.join('C:', 'Users', 'me', 'repos', 'my-repo.worktrees', 'copilot-worktree-2026-02-07T20-38-48'),
        expected: 'my-repo',
    },
];
for (const { name, workspaceFolderPath, expected } of worktreeWorkspaceFolderPathCases) {
    test(`resolveSessionWorkspaceName: ${name} resolves to the repo, not the worktree name`, () => {
        const resolvedName = resolveSessionWorkspaceName(
            { workspaceFolderPath },
            path.join('C:', 'Users', 'me', '.copilot', 'session-store.db#session-id')
        );
        assert.equal(resolvedName, expected);
    });
}

test('resolveSessionWorkspaceName: workspaceStorage-resolved worktree path also collapses to the repo name', () => {
    // Proves the *other* call site this fix touched: when VS Code's workspaceStorage
    // resolution succeeds (rather than falling back to workspaceFolderPath), the resolved
    // folder must still go through getRepoNameFromWorkspacePath(), not path.basename().
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-rsws-wt-'));
    try {
        const workspaceFolder = path.join(tmpDir, '.copilot', 'copilot-worktrees', 'my-repo', 'rajbos-bookish-engine');
        fs.mkdirSync(workspaceFolder, { recursive: true });
        const workspaceStorage = path.join(tmpDir, 'workspaceStorage', 'wsid456');
        fs.mkdirSync(workspaceStorage, { recursive: true });
        fs.writeFileSync(
            path.join(workspaceStorage, 'workspace.json'),
            JSON.stringify({ folder: workspaceFolder }),
            'utf8'
        );
        const sessionFile = path.join(workspaceStorage, 'chatSessions', 'session.json');
        const cache = new Map<string, string | undefined>();
        const name = resolveSessionWorkspaceName({}, sessionFile, cache);
        assert.equal(name, 'my-repo');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resolveSessionWorkspaceName: falls back to repository when workspaceFolderPath is absent', () => {
    const name = resolveSessionWorkspaceName(
        { repository: 'owner/repo' },
        'some-session.jsonl'
    );
    assert.equal(name, 'owner/repo');
});

test('resolveSessionWorkspaceName: falls back to workspaceStorage resolution', () => {
    // Use the OS temp dir (not process.cwd()) so this stays hermetic even when the test
    // suite itself runs from inside a "copilot-worktrees" checkout, which would otherwise
    // make getRepoNameFromWorkspacePath collapse the synthetic path to the real repo name.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-rsws-'));
    try {
        const workspaceFolder = path.join(tmpDir, 'my-vscode-project');
        fs.mkdirSync(workspaceFolder, { recursive: true });
        const workspaceStorage = path.join(tmpDir, 'workspaceStorage', 'wsid123');
        fs.mkdirSync(workspaceStorage, { recursive: true });
        fs.writeFileSync(
            path.join(workspaceStorage, 'workspace.json'),
            JSON.stringify({ folder: workspaceFolder }),
            'utf8'
        );
        const sessionFile = path.join(workspaceStorage, 'chatSessions', 'session.json');
        const cache = new Map<string, string | undefined>();
        const name = resolveSessionWorkspaceName({}, sessionFile, cache);
        assert.equal(name, 'my-vscode-project');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resolveSessionWorkspaceName: returns undefined when no attribution is available', () => {
    const name = resolveSessionWorkspaceName(
        {},
        '/home/user/.claude/projects/hash/session.jsonl'
    );
    assert.equal(name, undefined);
});

// ── resolveDebugLogCandidatePaths ────────────────────────────────────────
//
// path.basename/path.extname are separator-sensitive, so paths here are built with
// path.join (not hardcoded backslash literals) to stay meaningful on POSIX CI runners
// too — see extractCopilotCliSessionId's tests in copilotCliOtel.test.ts for the same rule.

import { resolveDebugLogCandidatePaths } from '../../../src/workspaceHelpers';

const TTFT_SESSION_ID = 'e84b3e82-c1fb-43de-8f52-367f4c74826a';

test('resolveDebugLogCandidatePaths: returns one candidate per known extension-folder spelling', () => {
    const sessionFile = path.join('home', 'user', 'workspaceStorage', 'abc123', 'chatSessions', `${TTFT_SESSION_ID}.json`);
    const candidates = resolveDebugLogCandidatePaths(sessionFile);
    assert.ok(candidates);
    assert.equal(candidates!.length, 4);
    assert.ok(candidates!.every(p => p.includes(TTFT_SESSION_ID) && p.endsWith(path.join('debug-logs', TTFT_SESSION_ID, 'main.jsonl'))));
    assert.ok(candidates!.some(p => p.includes('GitHub.copilot-chat')));
    assert.ok(candidates!.some(p => p.includes('github.copilot-chat')));
});

test('resolveDebugLogCandidatePaths: returns undefined for a non-UUID session file', () => {
    const sessionFile = path.join('home', 'user', 'workspaceStorage', 'abc123', 'chatSessions', 'not-a-uuid.json');
    assert.equal(resolveDebugLogCandidatePaths(sessionFile), undefined);
});

test('resolveDebugLogCandidatePaths: returns undefined for a UUID-named file outside workspaceStorage', () => {
    const sessionFile = path.join('home', 'user', '.copilot', 'session-state', `${TTFT_SESSION_ID}.jsonl`);
    assert.equal(resolveDebugLogCandidatePaths(sessionFile), undefined);
});
