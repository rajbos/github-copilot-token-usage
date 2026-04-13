import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ClaudeCodeDataAccess, normalizeClaudeModelId } from '../../src/claudecode';

const claudeCode = new ClaudeCodeDataAccess();

// ----- normalizeClaudeModelId -----

test('normalizeClaudeModelId: converts hyphen version to dot notation', () => {
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-6'), 'claude-sonnet-4.6');
	assert.equal(normalizeClaudeModelId('claude-haiku-4-5'), 'claude-haiku-4.5');
	assert.equal(normalizeClaudeModelId('claude-opus-4-6'), 'claude-opus-4.6');
});

test('normalizeClaudeModelId: strips date suffix and normalises version', () => {
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4.5');
	assert.equal(normalizeClaudeModelId('claude-haiku-4-5-20250929'), 'claude-haiku-4.5');
});

test('normalizeClaudeModelId: is idempotent for already-dotted IDs', () => {
	assert.equal(normalizeClaudeModelId('claude-sonnet-4.6'), 'claude-sonnet-4.6');
	assert.equal(normalizeClaudeModelId('claude-haiku-4.5'), 'claude-haiku-4.5');
});

test('normalizeClaudeModelId: does not transform legacy IDs like claude-3-5-sonnet-20241022', () => {
	// Legacy IDs have a different structure — do not alter them
	const legacy = 'claude-3-5-sonnet-20241022';
	assert.equal(normalizeClaudeModelId(legacy), legacy);
});

test('normalizeClaudeModelId: passes through non-Claude model IDs unchanged', () => {
	assert.equal(normalizeClaudeModelId('gpt-4o'), 'gpt-4o');
	assert.equal(normalizeClaudeModelId('unknown'), 'unknown');
	assert.equal(normalizeClaudeModelId(''), '');
});

// ----- isClaudeCodeSessionFile -----

test('isClaudeCodeSessionFile: recognises ~/.claude/projects paths', () => {
	const sessionPath = path.join(os.homedir(), '.claude', 'projects', 'home-user-code', 'abc123.jsonl');
	assert.ok(claudeCode.isClaudeCodeSessionFile(sessionPath));
});

test('isClaudeCodeSessionFile: recognises Windows paths', () => {
	// Test backslash normalisation using the current home directory so the test passes on any OS
	const sessionPath = `${os.homedir()}\\.claude\\projects\\c--Users-user-code\\abc123.jsonl`;
	assert.ok(claudeCode.isClaudeCodeSessionFile(sessionPath));
});

test('isClaudeCodeSessionFile: rejects non-matching paths', () => {
	assert.ok(!claudeCode.isClaudeCodeSessionFile('/home/user/.continue/sessions/abc.json'));
	assert.ok(!claudeCode.isClaudeCodeSessionFile('/home/user/.claude/stats-cache.json'));
	assert.ok(!claudeCode.isClaudeCodeSessionFile('/home/user/.claude/projects/hash/session.json'));
});

// ----- getClaudeCodeSessionId -----

test('getClaudeCodeSessionId: extracts UUID from filename', () => {
	const id = claudeCode.getClaudeCodeSessionId('/home/user/.claude/projects/hash/4817b4d3-a794-4be1-ac45-ea05f7dc9f00.jsonl');
	assert.equal(id, '4817b4d3-a794-4be1-ac45-ea05f7dc9f00');
});

// ----- getProjectPathFromHash -----

test('getProjectPathFromHash: Windows path reversal', () => {
	const original = os.platform();
	// Test the logic directly (the method checks os.platform())
	const result = claudeCode.getProjectPathFromHash('c--Users-RobBos-code-repos-myproject');
	if (os.platform() === 'win32') {
		assert.equal(result, 'C:\\Users\\RobBos\\code\\repos\\myproject');
	}
	// On non-Windows, just check it returns something reasonable
	assert.ok(result.length > 0);
});

// ----- Token counting with synthetic data -----

function createTempSession(events: any[]): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
	const projectDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
	fs.mkdirSync(projectDir, { recursive: true });
	const filePath = path.join(projectDir, 'test-session.jsonl');
	const content = events.map(e => JSON.stringify(e)).join('\n');
	fs.writeFileSync(filePath, content, 'utf8');
	return filePath;
}

function cleanup(filePath: string) {
	try {
		// Walk up to the temp dir root and remove
		const tmpRoot = filePath.split('.claude')[0];
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch { /* ignore */ }
}

test('getTokensFromClaudeCodeSession: counts actual API tokens', () => {
	const events = [
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
			timestamp: '2026-03-27T22:47:31.013Z',
			sessionId: 'test-session'
		},
		{
			type: 'assistant',
			requestId: 'req_001',
			message: {
				model: 'claude-sonnet-4-6',
				role: 'assistant',
				content: [{ type: 'text', text: 'hi there' }],
				stop_reason: 'end_turn',
				usage: {
					input_tokens: 10,
					output_tokens: 50,
					cache_creation_input_tokens: 100,
					cache_read_input_tokens: 200
				}
			},
			timestamp: '2026-03-27T22:47:35.000Z',
			sessionId: 'test-session'
		}
	];

	const filePath = createTempSession(events);
	try {
		const result = claudeCode.getTokensFromClaudeCodeSession(filePath);
		// input: 10 + 100 + 200 = 310, output: 50, total: 360
		assert.equal(result.tokens, 360);
		assert.equal(result.thinkingTokens, 0);
	} finally {
		cleanup(filePath);
	}
});

test('getTokensFromClaudeCodeSession: de-duplicates by requestId', () => {
	const events = [
		{
			type: 'assistant',
			requestId: 'req_001',
			message: {
				model: 'claude-sonnet-4-6',
				content: [{ type: 'text', text: 'streaming...' }],
				stop_reason: null,
				usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
			},
			timestamp: '2026-03-27T22:47:33.000Z'
		},
		{
			type: 'assistant',
			requestId: 'req_001',
			message: {
				model: 'claude-sonnet-4-6',
				content: [{ type: 'text', text: 'complete response' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 20, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
			},
			timestamp: '2026-03-27T22:47:35.000Z'
		}
	];

	const filePath = createTempSession(events);
	try {
		const result = claudeCode.getTokensFromClaudeCodeSession(filePath);
		// Only the final event (stop_reason: 'end_turn') should be counted: 20 + 100 = 120
		assert.equal(result.tokens, 120);
	} finally {
		cleanup(filePath);
	}
});

test('countClaudeCodeInteractions: counts non-sidechain user text messages', () => {
	const events = [
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: [{ type: 'text', text: 'first question' }] }
		},
		{
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
		},
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result' }] }] }
		},
		{
			type: 'user',
			isSidechain: true,
			message: { role: 'user', content: [{ type: 'text', text: 'subagent message' }] }
		},
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: [{ type: 'text', text: 'second question' }] }
		}
	];

	const filePath = createTempSession(events);
	try {
		const count = claudeCode.countClaudeCodeInteractions(filePath);
		// Should count 2: first and second question (not tool_result, not sidechain)
		assert.equal(count, 2);
	} finally {
		cleanup(filePath);
	}
});

test('getClaudeCodeModelUsage: aggregates per-model token usage', () => {
	const events = [
		{
			type: 'assistant',
			requestId: 'req_001',
			message: {
				model: 'claude-sonnet-4-6',
				stop_reason: 'end_turn',
				usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
			}
		},
		{
			type: 'assistant',
			requestId: 'req_002',
			message: {
				model: 'claude-opus-4-6',
				stop_reason: 'tool_use',
				usage: { input_tokens: 5, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 }
			}
		},
		{
			type: 'assistant',
			requestId: 'req_003',
			message: {
				model: 'claude-sonnet-4-6',
				stop_reason: 'end_turn',
				usage: { input_tokens: 20, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
			}
		}
	];

	const filePath = createTempSession(events);
	try {
		const modelUsage = claudeCode.getClaudeCodeModelUsage(filePath);
		// Model IDs are normalised: hyphens in version → dots (claude-sonnet-4-6 → claude-sonnet-4.6)
		assert.ok(modelUsage['claude-sonnet-4.6']);
		assert.ok(modelUsage['claude-opus-4.6']);
		// sonnet: input = (10+0+100) + (20+0+0) = 130, output = 50+30 = 80
		assert.equal(modelUsage['claude-sonnet-4.6'].inputTokens, 130);
		assert.equal(modelUsage['claude-sonnet-4.6'].outputTokens, 80);
		// opus: input = 5+50+0 = 55, output = 200
		assert.equal(modelUsage['claude-opus-4.6'].inputTokens, 55);
		assert.equal(modelUsage['claude-opus-4.6'].outputTokens, 200);
	} finally {
		cleanup(filePath);
	}
});

test('getClaudeCodeSessionMeta: extracts title and timestamps', () => {
	const events = [
		{
			type: 'user',
			timestamp: '2026-03-27T22:47:31.000Z',
			entrypoint: 'claude-vscode',
			cwd: 'C:\\Users\\RobBos\\code\\repos\\myproject'
		},
		{
			type: 'assistant',
			timestamp: '2026-03-27T22:48:00.000Z'
		},
		{
			type: 'ai-title',
			sessionId: 'test',
			aiTitle: 'Analyze repo extensions'
		},
		{
			type: 'user',
			timestamp: '2026-03-27T22:50:00.000Z'
		}
	];

	const filePath = createTempSession(events);
	try {
		const meta = claudeCode.getClaudeCodeSessionMeta(filePath);
		assert.ok(meta);
		assert.equal(meta!.title, 'Analyze repo extensions');
		assert.equal(meta!.entrypoint, 'claude-vscode');
		assert.equal(meta!.cwd, 'C:\\Users\\RobBos\\code\\repos\\myproject');
		assert.equal(meta!.firstInteraction, '2026-03-27T22:47:31.000Z');
		assert.equal(meta!.lastInteraction, '2026-03-27T22:50:00.000Z');
	} finally {
		cleanup(filePath);
	}
});

test('getTokensFromClaudeCodeSession: returns zero for empty file', () => {
	const filePath = createTempSession([]);
	try {
		const result = claudeCode.getTokensFromClaudeCodeSession(filePath);
		assert.equal(result.tokens, 0);
		assert.equal(result.thinkingTokens, 0);
	} finally {
		cleanup(filePath);
	}
});

test('getTokensFromClaudeCodeSession: skips non-assistant events', () => {
	const events = [
		{ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-03-27T22:47:30.985Z' },
		{ type: 'file-history-snapshot', messageId: 'abc', snapshot: {} },
		{ type: 'ai-title', sessionId: 'test', aiTitle: 'Test title' },
		{
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'test' }] }
		}
	];

	const filePath = createTempSession(events);
	try {
		const result = claudeCode.getTokensFromClaudeCodeSession(filePath);
		assert.equal(result.tokens, 0);
	} finally {
		cleanup(filePath);
	}
});

// ── Mutation-killing tests ──────────────────────────────────────────────

test('getTokensFromClaudeCodeSession: handles non-numeric usage fields gracefully', () => {
        const events = [
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn',
                                usage: {
                                        input_tokens: 'not a number',
                                        output_tokens: null,
                                        cache_creation_input_tokens: undefined,
                                        cache_read_input_tokens: 10
                                }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const result = claudeCode.getTokensFromClaudeCodeSession(filePath);
                // Only cache_read_input_tokens (10) is numeric, rest default to 0
                assert.equal(result.tokens, 10);
                assert.equal(result.thinkingTokens, 0);
        } finally {
                cleanup(filePath);
        }
});

test('getTokensFromClaudeCodeSession: handles missing usage object', () => {
        const events = [
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn'
                                // no usage
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const result = claudeCode.getTokensFromClaudeCodeSession(filePath);
                assert.equal(result.tokens, 0);
        } finally {
                cleanup(filePath);
        }
});

test('getTokensFromClaudeCodeSession: skips streaming fragments without stop_reason', () => {
        const events = [
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                model: 'claude-sonnet-4-6',
                                stop_reason: null,
                                usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                },
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                model: 'claude-sonnet-4-6',
                                stop_reason: undefined,
                                usage: { input_tokens: 8, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                },
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn',
                                usage: { input_tokens: 20, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const result = claudeCode.getTokensFromClaudeCodeSession(filePath);
                // Only the final event with stop_reason='end_turn' should count
                assert.equal(result.tokens, 120);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: counts string content messages', () => {
        const events = [
                {
                        type: 'user',
                        isSidechain: false,
                        message: { role: 'user', content: 'plain text message' }
                },
                {
                        type: 'user',
                        isSidechain: false,
                        message: { role: 'user', content: 'another message' }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const count = claudeCode.countClaudeCodeInteractions(filePath);
                assert.equal(count, 2);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: does not count tool_result-only messages', () => {
        const events = [
                {
                        type: 'user',
                        isSidechain: false,
                        message: {
                                role: 'user',
                                content: [
                                        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result' }] }
                                ]
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const count = claudeCode.countClaudeCodeInteractions(filePath);
                assert.equal(count, 0);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: does not count messages with text AND tool_result', () => {
        const events = [
                {
                        type: 'user',
                        isSidechain: false,
                        message: {
                                role: 'user',
                                content: [
                                        { type: 'text', text: 'check this' },
                                        { type: 'tool_result', tool_use_id: 'toolu_1', content: [] }
                                ]
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const count = claudeCode.countClaudeCodeInteractions(filePath);
                // Has text but also has tool_result → not a user interaction
                assert.equal(count, 0);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: returns 0 for empty file', () => {
        const filePath = createTempSession([]);
        try {
                const count = claudeCode.countClaudeCodeInteractions(filePath);
                assert.equal(count, 0);
        } finally {
                cleanup(filePath);
        }
});

test('getClaudeCodeModelUsage: handles events without requestId', () => {
        const events = [
                {
                        type: 'assistant',
                        message: {
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn',
                                usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const modelUsage = claudeCode.getClaudeCodeModelUsage(filePath);
                assert.ok(modelUsage['claude-sonnet-4.6']);
                assert.equal(modelUsage['claude-sonnet-4.6'].inputTokens, 10);
                assert.equal(modelUsage['claude-sonnet-4.6'].outputTokens, 20);
        } finally {
                cleanup(filePath);
        }
});

test('getClaudeCodeModelUsage: handles non-numeric usage fields', () => {
        const events = [
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                model: 'claude-haiku-4-5',
                                stop_reason: 'end_turn',
                                usage: {
                                        input_tokens: 'invalid',
                                        output_tokens: 30,
                                        cache_creation_input_tokens: null,
                                        cache_read_input_tokens: 5
                                }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const modelUsage = claudeCode.getClaudeCodeModelUsage(filePath);
                assert.ok(modelUsage['claude-haiku-4.5']);
                // input_tokens defaults to 0 (non-numeric), cache_creation defaults to 0, cache_read = 5
                assert.equal(modelUsage['claude-haiku-4.5'].inputTokens, 5);
                assert.equal(modelUsage['claude-haiku-4.5'].outputTokens, 30);
        } finally {
                cleanup(filePath);
        }
});

test('getProjectPathFromHash: returns Unix-style path on non-Windows', () => {
        // The method uses os.platform() internally — test the output format
        const result = claudeCode.getProjectPathFromHash('home-user-repos-myproject');
        if (os.platform() !== 'win32') {
                assert.equal(result, '/home/user/repos/myproject');
        } else {
                // On Windows, non-drive-letter hash falls through to Unix path
                // but since we're on Windows with drive letter pattern expected, just check it returns something
                assert.ok(result.length > 0);
        }
});

test('getProjectPathFromHash: handles simple single-segment hash', () => {
        const result = claudeCode.getProjectPathFromHash('myproject');
        if (os.platform() !== 'win32') {
                assert.equal(result, '/myproject');
        } else {
                assert.ok(result.length > 0);
        }
});

test('getClaudeCodeSessionMeta: returns null for empty file', () => {
        const filePath = createTempSession([]);
        try {
                const meta = claudeCode.getClaudeCodeSessionMeta(filePath);
                assert.equal(meta, null);
        } finally {
                cleanup(filePath);
        }
});

test('getClaudeCodeSessionMeta: extracts timestamps without ai-title', () => {
        const events = [
                {
                        type: 'user',
                        timestamp: '2026-03-27T22:47:31.000Z',
                        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
                },
                {
                        type: 'assistant',
                        timestamp: '2026-03-27T22:48:00.000Z',
                        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const meta = claudeCode.getClaudeCodeSessionMeta(filePath);
                assert.ok(meta);
                assert.equal(meta!.title, undefined);
                assert.equal(meta!.firstInteraction, '2026-03-27T22:47:31.000Z');
                assert.equal(meta!.lastInteraction, '2026-03-27T22:48:00.000Z');
        } finally {
                cleanup(filePath);
        }
});