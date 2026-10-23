import test from 'node:test';
import * as assert from 'node:assert/strict';

import { extractDeletedPathsFromCommand, extractFileActivity } from '../fileActivity';

const jsonl = (...events: unknown[]): string => events.map(e => JSON.stringify(e)).join('\n');

const claudeUse = (id: string, name: string, input: Record<string, unknown>, timestamp = '2026-10-20T10:00:00.000Z') =>
	({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const claudeResult = (id: string, content: unknown, isError = false) =>
	({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

test('Claude Code: Read, Edit and Write map to read, edited and created', () => {
	const touches = extractFileActivity(jsonl(
		claudeUse('t1', 'Read', { file_path: 'C:\\repo\\src\\a.ts' }),
		claudeResult('t1', 'ok'),
		claudeUse('t2', 'Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' }),
		claudeResult('t2', 'ok'),
		claudeUse('t3', 'Write', { file_path: '/repo/src/new.ts', content: '' }),
		claudeResult('t3', 'File created successfully at: /repo/src/new.ts'),
	));
	assert.deepEqual(touches.map(t => [t.path, t.kind]), [
		['C:/repo/src/a.ts', 'read'],
		['/repo/src/a.ts', 'edited'],
		['/repo/src/new.ts', 'created'],
	]);
	assert.equal(touches[0].ts, Date.parse('2026-10-20T10:00:00.000Z'));
});

test('Claude Code: Write over an existing file is an edit, a failed call is dropped', () => {
	const touches = extractFileActivity(jsonl(
		claudeUse('w1', 'Write', { file_path: '/repo/a.ts' }),
		claudeResult('w1', 'The file /repo/a.ts has been updated.'),
		claudeUse('e1', 'Edit', { file_path: '/repo/b.ts' }),
		claudeResult('e1', 'String to replace not found', true),
	));
	assert.deepEqual(touches.map(t => [t.path, t.kind]), [['/repo/a.ts', 'edited']]);
});

test('Claude Code: a re-logged streaming fragment of one tool_use counts once', () => {
	const use = claudeUse('dup', 'Read', { file_path: '/repo/a.ts' });
	assert.equal(extractFileActivity(jsonl(use, use)).length, 1);
});

test('Claude Code: Glob and Grep are not file touches', () => {
	assert.deepEqual(extractFileActivity(jsonl(claudeUse('g', 'Grep', { pattern: 'x', path: '/repo' }))), []);
});

test('Claude Code: shell deletes are inferred and flagged', () => {
	const touches = extractFileActivity(jsonl(claudeUse('b', 'Bash', { command: 'rm -f old.txt && git rm "docs/a b.md"; rm -rf build/*' })));
	assert.deepEqual(touches.map(t => [t.path, t.kind, t.inferred]), [
		['old.txt', 'deleted', true],
		['docs/a b.md', 'deleted', true],
	]);
});

test('Copilot CLI: view, edit and create; failed calls are dropped', () => {
	const start = (id: string, toolName: string, args: Record<string, unknown>) =>
		({ type: 'tool.execution_start', timestamp: '2026-10-21T08:00:00.000Z', data: { toolCallId: id, toolName, arguments: args } });
	const touches = extractFileActivity(jsonl(
		start('1', 'view', { path: 'C:\\r\\a.ts', view_range: [1, 5] }),
		start('2', 'edit', { path: 'C:\\r\\a.ts', old_str: 'a', new_str: 'b' }),
		{ type: 'tool.execution_complete', data: { toolCallId: '2', success: true } },
		start('3', 'create', { path: 'C:\\r\\b.ts', file_text: 'x' }),
		start('4', 'edit', { path: 'C:\\r\\c.ts' }),
		{ type: 'tool.execution_complete', data: { toolCallId: '4', success: false } },
		start('5', 'powershell', { command: 'Remove-Item -Path .\\tmp.log -Force' }),
	));
	assert.deepEqual(touches.map(t => [t.path, t.kind]), [
		['C:/r/a.ts', 'read'], ['C:/r/a.ts', 'edited'], ['C:/r/b.ts', 'created'], ['./tmp.log', 'deleted'],
	]);
});

test('VS Code Copilot Chat: toolInvocationSerialized in delta JSONL, latest snapshot wins', () => {
	const uri = (p: string) => ({ uris: { [`file:///${p}`]: { $mid: 1, path: `/${p}`, scheme: 'file' } } });
	const touches = extractFileActivity(jsonl(
		{ kind: 0, v: { requests: [] } },
		{ kind: 2, k: ['requests', 0, 'response'], v: [
			{ kind: 'toolInvocationSerialized', toolCallId: 'a', toolId: 'copilot_readFile', invocationMessage: { value: 'Reading', ...uri('c:/r/src/a.ts') } },
			{ kind: 'toolInvocationSerialized', toolCallId: 'a', toolId: 'copilot_readFile', invocationMessage: { value: 'Reading', ...uri('c:/r/src/a.ts') }, pastTenseMessage: { value: 'Read', ...uri('c:/r/src/a.ts') } },
			{ kind: 'toolInvocationSerialized', toolCallId: 'b', toolId: 'copilot_replaceString', invocationMessage: { value: 'Replacing', ...uri('c:/r/src/b.ts') } },
			{ kind: 'toolInvocationSerialized', toolCallId: 'c', toolId: 'copilot_createFile', invocationMessage: { value: 'Creating', ...uri('c:/r/src/c.ts') } },
			{ kind: 'toolInvocationSerialized', toolCallId: 'd', toolId: 'copilot_findFiles', invocationMessage: 'Searching' },
		] },
	));
	assert.deepEqual(touches.map(t => [t.path, t.kind]), [
		['c:/r/src/a.ts', 'read'], ['c:/r/src/b.ts', 'edited'], ['c:/r/src/c.ts', 'created'],
	]);
});

test('VS Code Copilot Chat: legacy single-document JSON is read too', () => {
	const doc = { requests: [{ requestId: 'r1', timestamp: 1_760_000_000_000, response: [
		{ kind: 'toolInvocationSerialized', toolCallId: 'a', toolId: 'copilot_readFile', pastTenseMessage: { value: 'Read', uris: { 'file:///c%3A/r/x.ts': { path: '/c:/r/x.ts' } } } },
	] }] };
	const touches = extractFileActivity(JSON.stringify(doc, null, 2));
	assert.deepEqual(touches, [{ path: 'c:/r/x.ts', kind: 'read', ts: 1_760_000_000_000 }]);
});

test('logs without file-touching tools and malformed lines yield nothing', () => {
	assert.deepEqual(extractFileActivity(''), []);
	assert.deepEqual(extractFileActivity('not json\n{"type":"tool_use"'), []);
});

test('extractDeletedPathsFromCommand: rm variants, quotes, globs and variables', () => {
	assert.deepEqual(extractDeletedPathsFromCommand('rm a.txt b.txt'), ['a.txt', 'b.txt']);
	assert.deepEqual(extractDeletedPathsFromCommand('del /q "C:\\x\\y.log"'), ['C:/x/y.log']);
	assert.deepEqual(extractDeletedPathsFromCommand('rm -rf dist/* $TMP/x.txt out/'), []);
	assert.deepEqual(extractDeletedPathsFromCommand('ls -la; echo rm'), []);
	assert.deepEqual(extractDeletedPathsFromCommand('rm -rf out cli/out'), [], 'recursive deletes remove directories');
	assert.deepEqual(extractDeletedPathsFromCommand('Remove-Item -Recurse -Force build'), []);
	assert.deepEqual(extractDeletedPathsFromCommand('Remove-Item a.log, b.log -Force -ErrorAction SilentlyContinue'), ['a.log', 'b.log']);
	assert.deepEqual(extractDeletedPathsFromCommand('Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue'), []);
	assert.deepEqual(extractDeletedPathsFromCommand(undefined), []);
});
