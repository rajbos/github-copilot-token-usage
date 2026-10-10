import test from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyToolKind, TOOL_KINDS } from '../../../src/toolKind';

test('classifyToolKind: MCP prefixes from every supported editor naming scheme', () => {
    for (const name of [
        'mcp__github__create_issue',           // Claude Code
        'mcp_io_github_git_get_file_contents', // VS Code Copilot Chat (local stdio)
        'mcp.github.github.issue_read',        // dotted variant
        'github-mcp-server-get_file_contents', // Copilot CLI
    ]) {
        assert.equal(classifyToolKind(name), 'mcp', name);
    }
});

test('classifyToolKind: skill wrappers and slash-command markers', () => {
    assert.equal(classifyToolKind('Skill'), 'skill');
    assert.equal(classifyToolKind('skill'), 'skill');
    assert.equal(classifyToolKind('__slash__commit'), 'skill');
});

test('classifyToolKind: delegation / subagent tools', () => {
    for (const name of ['task', 'Agent', 'read_agent', 'spawn_task', 'runSubagent']) {
        assert.equal(classifyToolKind(name), 'subagent', name);
    }
});

test('classifyToolKind: everything else is builtin, and MCP wins over other patterns', () => {
    for (const name of ['powershell', 'view', 'Bash', 'read_file', 'grep_search', 'web_fetch', 'ask_user']) {
        assert.equal(classifyToolKind(name), 'builtin', name);
    }
    assert.equal(classifyToolKind('mcp__agents__task'), 'mcp');
    assert.deepEqual([...TOOL_KINDS], ['builtin', 'mcp', 'subagent', 'skill']);
});
