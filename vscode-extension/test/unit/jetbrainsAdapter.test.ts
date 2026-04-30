/**
 * Unit tests for JetBrainsAdapter — discovery of JetBrains IDE Copilot Chat
 * session files under ~/.copilot/jb/.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
	JetBrainsAdapter,
	isJetBrainsSessionPath,
	getJetBrainsSessionDir,
} from '../../src/adapters/jetbrainsAdapter';
import { isDiscoverable } from '../../src/ecosystemAdapter';

const adapter = new JetBrainsAdapter();

// ---------------------------------------------------------------------------
// Identity & interface conformance
// ---------------------------------------------------------------------------

test('JetBrainsAdapter: id and displayName are stable', () => {
	assert.equal(adapter.id, 'jetbrains');
	assert.equal(adapter.displayName, 'JetBrains IDE');
});

test('JetBrainsAdapter: implements IDiscoverableEcosystem', () => {
	assert.ok(isDiscoverable(adapter));
});

// ---------------------------------------------------------------------------
// handles() — currently a no-op match (parser delegation pending)
// ---------------------------------------------------------------------------

test('JetBrainsAdapter.handles: returns false while parser delegation is pending', () => {
	const p = path.join(os.homedir(), '.copilot', 'jb', 'abc-uuid', 'partition-1.jsonl');
	assert.equal(adapter.handles(p), false);
});

// ---------------------------------------------------------------------------
// Path predicate
// ---------------------------------------------------------------------------

test('isJetBrainsSessionPath: matches partition files under ~/.copilot/jb/', () => {
	assert.ok(isJetBrainsSessionPath('/home/me/.copilot/jb/3678192b-9e4e-41fa-adfc-0865b3f42b87/partition-1.jsonl'));
	assert.ok(isJetBrainsSessionPath('/home/me/.copilot/jb/some-uuid/partition-2.jsonl'));
	assert.ok(isJetBrainsSessionPath('C:\\Users\\me\\.copilot\\jb\\abc\\partition-1.jsonl'));
	assert.ok(isJetBrainsSessionPath('/home/me/.copilot/jb/uuid/partition-10.jsonl'));
});

test('isJetBrainsSessionPath: rejects non-partition files under ~/.copilot/jb/', () => {
	assert.equal(isJetBrainsSessionPath('/home/me/.copilot/jb/uuid/events.jsonl'), false);
	assert.equal(isJetBrainsSessionPath('/home/me/.copilot/jb/uuid/something.json'), false);
	assert.equal(isJetBrainsSessionPath('/home/me/.copilot/jb/uuid/partition-abc.jsonl'), false);
});

test('isJetBrainsSessionPath: rejects unrelated paths', () => {
	assert.equal(isJetBrainsSessionPath('/home/me/.copilot/session-state/abc.jsonl'), false);
	assert.equal(isJetBrainsSessionPath('/home/me/.continue/sessions/abc.json'), false);
	assert.equal(isJetBrainsSessionPath('/home/me/Code/User/workspaceStorage/abc/chatSessions/s1.json'), false);
});

// ---------------------------------------------------------------------------
// getEditorRoot / getCandidatePaths
// ---------------------------------------------------------------------------

test('JetBrainsAdapter.getEditorRoot: returns ~/.copilot/jb', () => {
	assert.equal(adapter.getEditorRoot('/anything'), getJetBrainsSessionDir());
});

test('JetBrainsAdapter.getCandidatePaths: returns single JetBrains entry', () => {
	const paths = adapter.getCandidatePaths();
	assert.equal(paths.length, 1);
	assert.equal(paths[0].source, 'JetBrains IDE');
	assert.ok(paths[0].path.replace(/\\/g, '/').endsWith('/.copilot/jb'));
});

// ---------------------------------------------------------------------------
// Safe-default contract methods
// ---------------------------------------------------------------------------

test('JetBrainsAdapter: safe-default methods return zero values for unreadable files', async () => {
	const f = '/some/file.jsonl';
	assert.deepEqual(await adapter.getTokens(f), { tokens: 0, thinkingTokens: 0, actualTokens: 0 });
	assert.equal(await adapter.countInteractions(f), 0);
	assert.deepEqual(await adapter.getModelUsage(f), {});
	const meta = await adapter.getMeta(f);
	assert.equal(meta.title, undefined);
	assert.equal(meta.firstInteraction, null);
	assert.equal(meta.lastInteraction, null);
});

test('JetBrainsAdapter: parses a real partition file and returns common output', async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jb-parse-'));
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });
	const file = path.join(tmpDir, 'partition-1.jsonl');
	const events = [
		{ type: 'partition.created', data: { conversationId: 'conv-1', partitionId: 1, source: 'panel', createdAt: 1777552130660 }, timestamp: '2026-04-30T12:28:50.660Z' },
		{ type: 'user.message', data: { content: 'hello world', turnId: 't1' }, timestamp: '2026-04-30T12:28:50.713Z' },
		{ type: 'user.message_rendered', data: { turnId: 't1', renderedMessage: '<userRequest>hello world</userRequest>' }, timestamp: '2026-04-30T12:28:51.826Z' },
		{ type: 'assistant.turn_start', data: { turnId: 't1' }, timestamp: '2026-04-30T12:28:51.900Z' },
		{ type: 'tool.execution_start', data: { toolCallId: 'toolu_bdrk_xyz', toolName: 'read_file', arguments: { filePath: '/tmp/x' } }, timestamp: '2026-04-30T12:28:55.802Z' },
		{ type: 'tool.execution_complete', data: { toolCallId: 'toolu_bdrk_xyz', success: true, result: { result: [{ type: 'text', value: 'file contents go here' }] } }, timestamp: '2026-04-30T12:28:56.000Z' },
		{ type: 'assistant.message', data: { text: 'here is your answer', thinking: { id: 'th0', text: 'thinking about it' }, iterationNumber: 1, messageId: 't1' }, timestamp: '2026-04-30T12:29:07.000Z' },
		{ type: 'assistant.turn_end', data: { turnId: 't1', status: 'success' }, timestamp: '2026-04-30T12:29:07.522Z' },
	];
	await fs.promises.writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');

	const tokens = await adapter.getTokens(file);
	assert.ok(tokens.tokens > 0, `expected positive tokens, got ${tokens.tokens}`);
	assert.ok(tokens.thinkingTokens > 0, 'thinking tokens expected from assistant.message.data.thinking.text');
	assert.equal(tokens.actualTokens, 0, 'JetBrains files have no actual API token counts');

	assert.equal(await adapter.countInteractions(file), 1);

	const modelUsage = await adapter.getModelUsage(file);
	// Tool call id starts with `toolu_` → claude family hint
	assert.ok(modelUsage['claude'], 'expected claude model attribution from toolCallId prefix');

	const meta = await adapter.getMeta(file);
	assert.equal(meta.firstInteraction, '2026-04-30T12:28:50.713Z');
	assert.equal(meta.lastInteraction, '2026-04-30T12:29:07.522Z');
});

// ---------------------------------------------------------------------------
// discover() against a synthetic ~/.copilot/jb/ layout
// ---------------------------------------------------------------------------

test('JetBrainsAdapter.discover: finds non-empty partition-{n}.jsonl files in conversation subdirs', async (t) => {
	const tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jb-home-'));
	const jbDir = path.join(tmpHome, '.copilot', 'jb');

	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome;

	t.after(async () => {
		if (originalHome === undefined) { delete process.env.HOME; } else { process.env.HOME = originalHome; }
		if (originalUserProfile === undefined) { delete process.env.USERPROFILE; } else { process.env.USERPROFILE = originalUserProfile; }
		await fs.promises.rm(tmpHome, { recursive: true, force: true });
	});

	if (os.homedir() !== tmpHome) {
		t.skip(`os.homedir() doesn't honour env override on this platform (got ${os.homedir()})`);
		return;
	}

	// Conversation 1: two non-empty partitions
	const conv1 = path.join(jbDir, '3678192b-9e4e-41fa-adfc-0865b3f42b87');
	await fs.promises.mkdir(conv1, { recursive: true });
	await fs.promises.writeFile(path.join(conv1, 'partition-1.jsonl'), '{"type":"partition.created"}\n');
	await fs.promises.writeFile(path.join(conv1, 'partition-2.jsonl'), '{"type":"user.message"}\n');

	// Conversation 2: one non-empty + one empty partition
	const conv2 = path.join(jbDir, 'a1b2c3d4-e5f6-7890-abcd-ef0123456789');
	await fs.promises.mkdir(conv2, { recursive: true });
	await fs.promises.writeFile(path.join(conv2, 'partition-1.jsonl'), '{"type":"partition.created"}\n');
	await fs.promises.writeFile(path.join(conv2, 'partition-2.jsonl'), '');  // empty — should be excluded

	// Conversation 3: non-partition file (should be ignored)
	const conv3 = path.join(jbDir, 'b2c3d4e5-f6a7-8901-bcde-f01234567890');
	await fs.promises.mkdir(conv3, { recursive: true });
	await fs.promises.writeFile(path.join(conv3, 'events.jsonl'), '{"type":"session.start"}\n');  // CLI format, not JetBrains

	const fresh = new JetBrainsAdapter();
	const result = await fresh.discover(() => { /* noop */ });

	// Expect: conv1 (2) + conv2 (1 non-empty) = 3 files; conv3 events.jsonl excluded
	assert.equal(result.sessionFiles.length, 3, `got: ${JSON.stringify(result.sessionFiles)}`);
	assert.ok(result.sessionFiles.some(f => f.replace(/\\/g, '/').endsWith('3678192b-9e4e-41fa-adfc-0865b3f42b87/partition-1.jsonl')));
	assert.ok(result.sessionFiles.some(f => f.replace(/\\/g, '/').endsWith('3678192b-9e4e-41fa-adfc-0865b3f42b87/partition-2.jsonl')));
	assert.ok(result.sessionFiles.some(f => f.replace(/\\/g, '/').endsWith('a1b2c3d4-e5f6-7890-abcd-ef0123456789/partition-1.jsonl')));
	// Empty partition-2 must be excluded
	assert.equal(result.sessionFiles.filter(f => f.includes('a1b2c3d4') && f.includes('partition-2')).length, 0);
	// events.jsonl must be excluded
	assert.equal(result.sessionFiles.filter(f => f.includes('events.jsonl')).length, 0);
});

test('JetBrainsAdapter.discover: returns empty result when jb dir does not exist', async () => {
	const result = await adapter.discover(() => { /* noop */ });
	assert.ok(Array.isArray(result.sessionFiles));
	assert.ok(Array.isArray(result.candidatePaths));
});
