/**
 * Unit tests for PiAdapter.buildTurns() token counting.
 *
 * Key regression: agentic / subagent pi sessions produce many assistant messages
 * per user turn (one API call per tool-use cycle).  The per-turn token estimate
 * must sum ALL assistant-message usage fields, not just the last message's usage.
 * Using only the last message gives a wildly low estimate (e.g. 86 K instead of
 * 5.4 M for a 101-message session).
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { PiAdapter } from '../../../src/adapters/piAdapter';
import { PiDataAccess } from '../../../src/pi';
import { makeTmpFixtureDir } from './tmpFixtureDirs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSessionLine(id: string, cwd = '/home/user/project'): string {
    return JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd });
}

function makeUserMessage(id: string, text: string, parentId: string): string {
    return JSON.stringify({
        type: 'message', id, parentId,
        timestamp: '2026-01-01T00:01:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1000 },
    });
}

function makeAssistantMessage(
    id: string, parentId: string, model: string,
    input: number, output: number, text = 'ok',
): string {
    return JSON.stringify({
        type: 'message', id, parentId,
        timestamp: '2026-01-01T00:02:00.000Z',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
            model,
            usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
            timestamp: 2000,
        },
    });
}

function makeToolCallMessage(id: string, parentId: string, model: string, input: number, toolName: string): string {
    return JSON.stringify({
        type: 'message', id, parentId,
        timestamp: '2026-01-01T00:02:30.000Z',
        message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tc1', name: toolName, arguments: {} }],
            model,
            usage: { input, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: input + 30 },
            timestamp: 2500,
        },
    });
}

function makeToolResultMessage(id: string, parentId: string): string {
    return JSON.stringify({
        type: 'message', id, parentId,
        timestamp: '2026-01-01T00:02:45.000Z',
        message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 2700 },
    });
}

async function writeTempSession(lines: string[]): Promise<string> {
    const dir = makeTmpFixtureDir('pi-test-');
    const file = path.join(dir, '2026-01-01T00-00-00-000Z_test.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
}

function makeAdapter(): PiAdapter {
    return new PiAdapter(new PiDataAccess());
}

// ---------------------------------------------------------------------------
// single-turn, single assistant message (baseline)
// ---------------------------------------------------------------------------

test('PiAdapter.buildTurns: single assistant message — token estimate equals its usage', async () => {
    const file = await writeTempSession([
        makeSessionLine('s1'),
        makeUserMessage('u1', 'hello', 's1'),
        makeAssistantMessage('a1', 'u1', 'mistral-medium-3.5', 1000, 50),
    ]);

    const adapter = makeAdapter();
    const { turns, actualTokens } = await adapter.buildTurns(file);

    assert.equal(turns.length, 1);
    assert.equal(turns[0].inputTokensEstimate, 1000);
    assert.equal(turns[0].outputTokensEstimate, 50);
    assert.equal(actualTokens, 1050);
});

// ---------------------------------------------------------------------------
// subagent / agentic session: 1 user turn → many assistant messages
// ---------------------------------------------------------------------------

test('PiAdapter.buildTurns: agentic session sums all assistant-message tokens (regression)', async () => {
    // Simulate a subagent session: 1 user prompt, 5 assistant messages with growing context
    const assistantInputs = [10_000, 20_000, 30_000, 40_000, 50_000];
    const assistantOutputs = [100, 100, 100, 100, 200];

    const lines: string[] = [makeSessionLine('s1'), makeUserMessage('u1', 'spin up subagents', 's1')];
    assistantInputs.forEach((inp, i) => {
        const output = assistantOutputs[i];
        lines.push(makeAssistantMessage(`a${i}`, i === 0 ? 'u1' : `a${i - 1}`, 'mistral-medium-3.5', inp, output));
    });

    const file = await writeTempSession(lines);
    const adapter = makeAdapter();
    const { turns, actualTokens } = await adapter.buildTurns(file);

    const expectedInput = assistantInputs.reduce((s, v) => s + v, 0);   // 150 000
    const expectedOutput = assistantOutputs.reduce((s, v) => s + v, 0); //    600

    assert.equal(turns.length, 1, 'should have exactly 1 turn');
    assert.equal(turns[0].inputTokensEstimate, expectedInput,
        `expected input estimate ${expectedInput} but got ${turns[0].inputTokensEstimate}`);
    assert.equal(turns[0].outputTokensEstimate, expectedOutput,
        `expected output estimate ${expectedOutput} but got ${turns[0].outputTokensEstimate}`);
    assert.equal(actualTokens, expectedInput + expectedOutput);
});

// ---------------------------------------------------------------------------
// agentic session with tool calls interspersed
// ---------------------------------------------------------------------------

test('PiAdapter.buildTurns: agentic session with tool-use cycles sums all assistant tokens', async () => {
    const lines: string[] = [
        makeSessionLine('s1'),
        makeUserMessage('u1', 'fix tests', 's1'),
        // cycle 1: tool call
        makeToolCallMessage('a1', 'u1', 'mistral-medium-3.5', 5_000, 'read'),
        makeToolResultMessage('tr1', 'a1'),
        // cycle 2: tool call
        makeToolCallMessage('a2', 'tr1', 'mistral-medium-3.5', 6_000, 'edit'),
        makeToolResultMessage('tr2', 'a2'),
        // final response
        makeAssistantMessage('a3', 'tr2', 'mistral-medium-3.5', 7_000, 200, 'done'),
    ];

    const file = await writeTempSession(lines);
    const adapter = makeAdapter();
    const { turns } = await adapter.buildTurns(file);

    // usage.input and usage.output are separate fields; output for tool-call messages = 30
    const expectedInput = 5_000 + 6_000 + 7_000;
    const expectedOutput = 30 + 30 + 200;

    assert.equal(turns.length, 1);
    assert.equal(turns[0].inputTokensEstimate, expectedInput);
    assert.equal(turns[0].outputTokensEstimate, expectedOutput);
});

// ---------------------------------------------------------------------------
// multi-turn session (two user messages)
// ---------------------------------------------------------------------------

test('PiAdapter.buildTurns: multi-turn session — each turn gets its own token sum', async () => {
    const lines: string[] = [
        makeSessionLine('s1'),
        // turn 1
        makeUserMessage('u1', 'task one', 's1'),
        makeAssistantMessage('a1', 'u1', 'mistral-medium-3.5', 1_000, 50),
        makeAssistantMessage('a2', 'a1', 'mistral-medium-3.5', 2_000, 80),
        // turn 2
        makeUserMessage('u2', 'task two', 'a2'),
        makeAssistantMessage('a3', 'u2', 'mistral-medium-3.5', 500, 20),
    ];

    const file = await writeTempSession(lines);
    const adapter = makeAdapter();
    const { turns } = await adapter.buildTurns(file);

    assert.equal(turns.length, 2);
    // turn 1: a1 + a2
    assert.equal(turns[0].inputTokensEstimate, 3_000);
    assert.equal(turns[0].outputTokensEstimate, 130);
    // turn 2: a3 only
    assert.equal(turns[1].inputTokensEstimate, 500);
    assert.equal(turns[1].outputTokensEstimate, 20);
});

// ---------------------------------------------------------------------------
// fallback to perTurnDefault when no usage data present
// ---------------------------------------------------------------------------

test('PiAdapter.buildTurns: falls back to per-turn default when assistant usage is absent', async () => {
    const lines: string[] = [
        makeSessionLine('s1'),
        makeUserMessage('u1', 'go', 's1'),
        // assistant message with no usage field
        JSON.stringify({
            type: 'message', id: 'a1', parentId: 'u1',
            timestamp: '2026-01-01T00:02:00.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'mistral-medium-3.5' },
        }),
    ];

    const file = await writeTempSession(lines);
    const adapter = makeAdapter();
    const { turns } = await adapter.buildTurns(file);

    assert.equal(turns.length, 1);
    // With no usage on any assistant event, both estimates should be 0 (perTurnDefault = 0/1 = 0)
    assert.equal(turns[0].inputTokensEstimate, 0);
    assert.equal(turns[0].outputTokensEstimate, 0);
});

// ---------------------------------------------------------------------------
// PiDataAccess.getParentSessionPath
// ---------------------------------------------------------------------------

test('PiDataAccess.getParentSessionPath: returns null for root session (no parentSession field)', async () => {
    const file = await writeTempSession([makeSessionLine('s1')]);
    const pi = new PiDataAccess();
    const result = await pi.getParentSessionPath(file);
    assert.equal(result, null);
});

test('PiDataAccess.getParentSessionPath: returns path when parentSession is set in header', async () => {
    const parentPath = '/home/user/.pi/agent/sessions/2026-01-01T00-00-00-000Z_parent.jsonl';
    const sessionLine = JSON.stringify({
        type: 'session', version: 3, id: 'child-id',
        timestamp: '2026-01-01T01:00:00.000Z', cwd: '/home/user/project',
        parentSession: parentPath,
    });
    const file = await writeTempSession([sessionLine]);
    const pi = new PiDataAccess();
    const result = await pi.getParentSessionPath(file);
    assert.equal(result, parentPath);
});

// ---------------------------------------------------------------------------
// PiDataAccess.getParentSessionPathFromFilePath (path-based detection)
// ---------------------------------------------------------------------------

test('PiDataAccess.getParentSessionPathFromFilePath: returns null for top-level timestamp-named session', () => {
    const pi = new PiDataAccess();
    // Top-level sessions have timestamp names, not 'session.jsonl'
    const topLevel = path.join(os.homedir(), '.pi', 'agent', 'sessions', '--cwd--', '2026-01-01T00-00-00-000Z_abc.jsonl');
    assert.equal(pi.getParentSessionPathFromFilePath(topLevel), null);
});

test('PiDataAccess.getParentSessionPathFromFilePath: derives parent path for nested session.jsonl', () => {
    const pi = new PiDataAccess();
    const base = path.join(os.homedir(), '.pi', 'agent', 'sessions', '--cwd--');
    const parentFile = path.join(base, '2026-01-01T00-00-00-000Z_abc.jsonl');
    const childFile  = path.join(base, '2026-01-01T00-00-00-000Z_abc', 'deadbeef', 'run-0', 'session.jsonl');
    assert.equal(pi.getParentSessionPathFromFilePath(childFile), parentFile);
});

// ---------------------------------------------------------------------------
// PiDataAccess.discoverSessions — recursive discovery
// ---------------------------------------------------------------------------

test('PiDataAccess.discoverSessions: discovers nested child session.jsonl files', async () => {
    // Build a fake sessions dir that mirrors the real pi layout:
    //   sessions/{cwdDir}/2026-01-01T_abc.jsonl           ← top-level
    //   sessions/{cwdDir}/2026-01-01T_abc/deadbeef/run-0/session.jsonl  ← child
    const tmpRoot = makeTmpFixtureDir('pi-discover-');
    const cwdDir = path.join(tmpRoot, '--cwd--');
    const parentFile = path.join(cwdDir, '2026-01-01T00-00-00-000Z_abc.jsonl');
    const childDir   = path.join(cwdDir, '2026-01-01T00-00-00-000Z_abc', 'deadbeef', 'run-0');
    const childFile  = path.join(childDir, 'session.jsonl');

    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(parentFile, makeSessionLine('parent') + '\n');
    fs.writeFileSync(childFile, makeSessionLine('child') + '\n');

    // Override the config dir so PiDataAccess scans our temp directory
    const pi = new PiDataAccess();
    // @ts-ignore — override private getConfigDir for test
    pi.getConfigDir = () => tmpRoot;

    const files = await pi.discoverSessions();
    assert.ok(files.includes(parentFile), 'top-level session should be discovered');
    assert.ok(files.includes(childFile),  'nested child session should be discovered');
});
