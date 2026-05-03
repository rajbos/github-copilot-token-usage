import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GeminiCliDataAccess, normalizeGeminiModelId } from '../../src/geminicli';

const geminiCli = new GeminiCliDataAccess();

function createTempGeminiSession(records: unknown[], projectBucket = 'demo-project'): string {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-test-'));
	const chatsDir = path.join(tmpRoot, '.gemini', 'tmp', projectBucket, 'chats');
	fs.mkdirSync(chatsDir, { recursive: true });
	const sessionFile = path.join(chatsDir, 'session-2026-05-03T15-01-ee37b453.jsonl');
	fs.writeFileSync(sessionFile, records.map(record => JSON.stringify(record)).join('\n'), 'utf8');
	return sessionFile;
}

function cleanupSessionFile(sessionFile: string): void {
	try {
		const tmpRoot = sessionFile.split(`${path.sep}.gemini`)[0];
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// Ignore cleanup failures in tests.
	}
}

function createSampleRecords(): unknown[] {
	return [
		{
			sessionId: 'ee37b453-387e-441c-8558-8ec2da287ed4',
			projectHash: 'demo-project',
			startTime: '2026-05-03T15:01:21.339Z',
			lastUpdated: '2026-05-03T15:01:21.339Z',
			kind: 'main',
		},
		{
			id: 'user-1',
			timestamp: '2026-05-03T15:01:31.511Z',
			type: 'user',
			content: [{ text: 'Summarize the repo' }],
		},
		{
			id: 'assistant-1',
			timestamp: '2026-05-03T15:01:34.141Z',
			type: 'gemini',
			content: '',
			thoughts: [],
			tokens: {
				input: 100,
				output: 10,
				cached: 40,
				thoughts: 5,
				tool: 0,
				total: 115,
			},
			model: 'gemini-3-flash-preview',
		},
		{
			id: 'assistant-1',
			timestamp: '2026-05-03T15:01:36.000Z',
			type: 'gemini',
			content: 'Repo summary',
			thoughts: [{ subject: 'plan', description: 'thinking', timestamp: '2026-05-03T15:01:35.000Z' }],
			tokens: {
				input: 120,
				output: 20,
				cached: 50,
				thoughts: 6,
				tool: 4,
				total: 150,
			},
			model: 'gemini-3-flash-preview',
			toolCalls: [
				{
					id: 'tool-1',
					name: 'read_file',
					displayName: 'ReadFile',
					args: { path: 'README.md' },
					resultDisplay: 'ok',
				},
				{
					id: 'tool-blank',
					name: '',
					displayName: '',
				},
			],
		},
		{
			$set: {
				lastUpdated: '2026-05-03T15:01:36.000Z',
			},
		},
		{
			id: 'user-2',
			timestamp: '2026-05-04T10:00:00.000Z',
			type: 'user',
			content: [{ text: 'Open the tests' }],
		},
		{
			id: 'assistant-2',
			timestamp: '2026-05-04T10:00:05.000Z',
			type: 'gemini',
			content: 'Test summary',
			thoughts: [],
			tokens: {
				input: 60,
				output: 8,
				cached: 10,
				thoughts: 2,
				tool: 0,
				total: 70,
			},
			model: 'gemini-3-flash',
		},
	];
}

test('normalizeGeminiModelId: maps observed preview IDs to priced model IDs', () => {
	assert.equal(normalizeGeminiModelId('gemini-3-flash-preview'), 'gemini-3-flash');
	assert.equal(normalizeGeminiModelId('gemini-3-flash'), 'gemini-3-flash');
});

test('isGeminiCliSessionFile: recognises ~/.gemini session paths', () => {
	const sessionPath = path.join(os.homedir(), '.gemini', 'tmp', 'demo-project', 'chats', 'session-abc.jsonl');
	assert.ok(geminiCli.isGeminiCliSessionFile(sessionPath));
});

test('isGeminiCliSessionFile: recognises Windows-style ~/.gemini session paths', () => {
	const sessionPath = `${os.homedir()}\\.gemini\\tmp\\demo-project\\chats\\session-abc.jsonl`;
	assert.ok(geminiCli.isGeminiCliSessionFile(sessionPath));
});

test('isGeminiCliSessionFile: rejects unrelated files', () => {
	assert.ok(!geminiCli.isGeminiCliSessionFile('/tmp/random/session.jsonl'));
	assert.ok(!geminiCli.isGeminiCliSessionFile(path.join(os.homedir(), '.gemini', 'logs.json')));
});

test('readGeminiCliSession: dedupes assistant updates by id', () => {
	const sessionFile = createTempGeminiSession(createSampleRecords());
	try {
		const session = geminiCli.readGeminiCliSession(sessionFile);
		assert.equal(session.userRecords.length, 2);
		assert.equal(session.assistantRecords.length, 2);
		assert.equal(session.projectBucket, 'demo-project');
	} finally {
		cleanupSessionFile(sessionFile);
	}
});

test('getTokensFromGeminiCliSession: uses actual token totals from latest assistant updates', () => {
	const sessionFile = createTempGeminiSession(createSampleRecords());
	try {
		const result = geminiCli.getTokensFromGeminiCliSession(sessionFile);
		assert.equal(result.tokens, 220);
		assert.equal(result.thinkingTokens, 8);
	} finally {
		cleanupSessionFile(sessionFile);
	}
});

test('countGeminiCliInteractions: counts user turns', () => {
	const sessionFile = createTempGeminiSession(createSampleRecords());
	try {
		assert.equal(geminiCli.countGeminiCliInteractions(sessionFile), 2);
	} finally {
		cleanupSessionFile(sessionFile);
	}
});

test('getGeminiCliModelUsage: aggregates normalized models and cached reads', () => {
	const sessionFile = createTempGeminiSession(createSampleRecords());
	try {
		const modelUsage = geminiCli.getGeminiCliModelUsage(sessionFile);
		assert.deepEqual(modelUsage['gemini-3-flash'], {
			inputTokens: 180,
			outputTokens: 40,
			cachedReadTokens: 60,
		});
	} finally {
		cleanupSessionFile(sessionFile);
	}
});

test('getGeminiCliSessionMeta: derives title, timestamps, and workspace fallback', () => {
	const sessionFile = createTempGeminiSession(createSampleRecords());
	try {
		const meta = geminiCli.getGeminiCliSessionMeta(sessionFile);
		assert.equal(meta.title, 'Summarize the repo');
		assert.equal(meta.firstInteraction, '2026-05-03T15:01:21.339Z');
		assert.equal(meta.lastInteraction, '2026-05-04T10:00:05.000Z');
		assert.equal(meta.workspacePath, 'demo-project');
	} finally {
		cleanupSessionFile(sessionFile);
	}
});

test('buildGeminiCliTurns: groups assistant updates by user turn and filters blank tool names', () => {
	const sessionFile = createTempGeminiSession(createSampleRecords());
	try {
		const result = geminiCli.buildGeminiCliTurns(sessionFile);
		assert.equal(result.actualTokens, 220);
		assert.equal(result.turns.length, 2);

		assert.equal(result.turns[0].userMessage, 'Summarize the repo');
		assert.equal(result.turns[0].assistantResponse, 'Repo summary');
		assert.equal(result.turns[0].model, 'gemini-3-flash');
		assert.equal(result.turns[0].toolCalls.length, 1);
		assert.equal(result.turns[0].toolCalls[0].toolName, 'ReadFile');
		assert.equal(result.turns[0].inputTokensEstimate, 120);
		assert.equal(result.turns[0].outputTokensEstimate, 24);
		assert.equal(result.turns[0].thinkingTokensEstimate, 6);
		assert.equal(result.turns[0].actualUsage?.promptTokens, 120);
		assert.equal(result.turns[0].actualUsage?.completionTokens, 30);

		assert.equal(result.turns[1].userMessage, 'Open the tests');
		assert.equal(result.turns[1].assistantResponse, 'Test summary');
		assert.equal(result.turns[1].inputTokensEstimate, 60);
		assert.equal(result.turns[1].outputTokensEstimate, 8);
		assert.equal(result.turns[1].thinkingTokensEstimate, 2);
	} finally {
		cleanupSessionFile(sessionFile);
	}
});

test('getGeminiCliDailyFractions: splits usage by user-turn day', () => {
	const sessionFile = createTempGeminiSession(createSampleRecords());
	try {
		const dailyFractions = geminiCli.getGeminiCliDailyFractions(sessionFile);
		assert.equal(dailyFractions['2026-05-03'], 0.5);
		assert.equal(dailyFractions['2026-05-04'], 0.5);
	} finally {
		cleanupSessionFile(sessionFile);
	}
});
