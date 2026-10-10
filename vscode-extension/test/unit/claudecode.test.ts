import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeWorkspaceFixtureDir } from './tmpFixtureDirs';

import { ClaudeCodeDataAccess, normalizeClaudeModelId } from '../../../src/claudecode';
import { ClaudeCodeAdapter } from '../../../src/adapters/claudeCodeAdapter';

const claudeCode = new ClaudeCodeDataAccess();
const claudeCodeAdapter = new ClaudeCodeAdapter(claudeCode);

// ----- normalizeClaudeModelId -----

test('normalizeClaudeModelId: converts hyphen version to dot notation', async () => {
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-6'), 'claude-sonnet-4.6');
	assert.equal(normalizeClaudeModelId('claude-haiku-4-5'), 'claude-haiku-4.5');
	assert.equal(normalizeClaudeModelId('claude-opus-4-6'), 'claude-opus-4.6');
});

test('normalizeClaudeModelId: strips date suffix and normalises version', async () => {
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4.5');
	assert.equal(normalizeClaudeModelId('claude-haiku-4-5-20250929'), 'claude-haiku-4.5');
});

test('normalizeClaudeModelId: is idempotent for already-dotted IDs', async () => {
	assert.equal(normalizeClaudeModelId('claude-sonnet-4.6'), 'claude-sonnet-4.6');
	assert.equal(normalizeClaudeModelId('claude-haiku-4.5'), 'claude-haiku-4.5');
});

test('normalizeClaudeModelId: does not transform legacy IDs like claude-3-5-sonnet-20241022', async () => {
	// Legacy IDs have a different structure — do not alter them
	const legacy = 'claude-3-5-sonnet-20241022';
	assert.equal(normalizeClaudeModelId(legacy), legacy);
});

test('normalizeClaudeModelId: passes through non-Claude model IDs unchanged', async () => {
	assert.equal(normalizeClaudeModelId('gpt-4o'), 'gpt-4o');
	assert.equal(normalizeClaudeModelId('unknown'), 'unknown');
	assert.equal(normalizeClaudeModelId(''), '');
});

// ----- isClaudeCodeSessionFile -----

test('isClaudeCodeSessionFile: recognises ~/.claude/projects paths', async () => {
	const sessionPath = path.join(os.homedir(), '.claude', 'projects', 'home-user-code', 'abc123.jsonl');
	assert.ok(claudeCode.isClaudeCodeSessionFile(sessionPath));
});

test('isClaudeCodeSessionFile: recognises Windows paths', async () => {
	// Test backslash normalisation using the current home directory so the test passes on any OS
	const sessionPath = `${os.homedir()}\\.claude\\projects\\c--Users-user-code\\abc123.jsonl`;
	assert.ok(claudeCode.isClaudeCodeSessionFile(sessionPath));
});

test('isClaudeCodeSessionFile: rejects non-matching paths', async () => {
	assert.ok(!claudeCode.isClaudeCodeSessionFile('/home/user/.continue/sessions/abc.json'));
	assert.ok(!claudeCode.isClaudeCodeSessionFile('/home/user/.claude/stats-cache.json'));
	assert.ok(!claudeCode.isClaudeCodeSessionFile('/home/user/.claude/projects/hash/session.json'));
});

// ----- getClaudeCodeSessionId -----

test('getClaudeCodeSessionId: extracts UUID from filename', async () => {
	const id = claudeCode.getClaudeCodeSessionId('/home/user/.claude/projects/hash/4817b4d3-a794-4be1-ac45-ea05f7dc9f00.jsonl');
	assert.equal(id, '4817b4d3-a794-4be1-ac45-ea05f7dc9f00');
});

// ----- getProjectPathFromHash -----

test('getProjectPathFromHash: Windows path reversal', async () => {
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
	// Keep synthetic session files outside the OS temp directory so the secure file-read guard
	// in src/utils/safeFileRead.ts still permits the parser to exercise actual session logic.
	const tmpDir = makeWorkspaceFixtureDir('claude-test-');
	const projectDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
	fs.mkdirSync(projectDir, { recursive: true });
	const filePath = path.join(projectDir, 'test-session.jsonl');
	const content = events.map(e => JSON.stringify(e)).join('\n');
	fs.writeFileSync(filePath, content, 'utf8');
	return filePath;
}

function cleanup(filePath: string): void {
	// Deliberately a no-op on the path: makeWorkspaceFixtureDir registers the
	// directory it created and removes it when the file finishes, so there is
	// nothing to derive here.
	//
	// This used to be `fs.rmSync(filePath.split('.claude')[0], { recursive: true,
	// force: true })`, which guessed the fixture root by splitting on a path
	// segment that also occurs in the fixture's own path. A checkout whose own
	// path contains `.claude` — a git worktree under `~/.claude/worktrees/`, say —
	// made that expression resolve to the user's home directory and try to delete
	// it recursively, with the failure swallowed by the surrounding catch.
	void filePath;
}

test('getTokensFromClaudeCodeSession: counts actual API tokens', async () => {
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
		const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
		// input: 10 + 100 + 200 = 310, output: 50, total: 360
		assert.equal(result.tokens, 360);
		assert.equal(result.thinkingTokens, 0);
	} finally {
		cleanup(filePath);
	}
});

test('getTokensFromClaudeCodeSession: de-duplicates streaming fragments by message.id (last-wins)', async () => {
	const events = [
		{
			type: 'assistant',
			requestId: 'req_001',
			message: {
				id: 'msg_001',
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
				id: 'msg_001',
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
		const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
		// Last-wins on message.id: final event (20+100=120) supersedes streaming fragment
		assert.equal(result.tokens, 120);
	} finally {
		cleanup(filePath);
	}
});

test('countClaudeCodeInteractions: counts non-sidechain user text messages', async () => {
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
		const count = await claudeCode.countClaudeCodeInteractions(filePath);
		// Should count 2: first and second question (not tool_result, not sidechain)
		assert.equal(count, 2);
	} finally {
		cleanup(filePath);
	}
});

test('getClaudeCodeModelUsage: aggregates per-model token usage', async () => {
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
		const modelUsage = await claudeCode.getClaudeCodeModelUsage(filePath);
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

test('getClaudeCodeModelUsage: tracks 1-hour cache TTL tokens separately from 5-minute TTL (issue #1589)', async () => {
	// Claude Code defaults to Anthropic's 1-hour prompt-cache TTL, which is billed at a
	// higher rate than the default 5-minute TTL. The breakdown lives under
	// message.usage.cache_creation.ephemeral_1h_input_tokens / ephemeral_5m_input_tokens.
	const events = [
		{
			type: 'assistant',
			message: {
				id: 'msg_1h',
				model: 'claude-sonnet-4-6',
				stop_reason: 'end_turn',
				usage: {
					input_tokens: 1,
					output_tokens: 100,
					cache_creation_input_tokens: 1000,
					cache_read_input_tokens: 0,
					cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 }
				}
			}
		},
		{
			type: 'assistant',
			message: {
				id: 'msg_5m',
				model: 'claude-sonnet-4-6',
				stop_reason: 'end_turn',
				usage: {
					input_tokens: 1,
					output_tokens: 50,
					cache_creation_input_tokens: 400,
					cache_read_input_tokens: 0,
					cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 400 }
				}
			}
		}
	];

	const filePath = createTempSession(events);
	try {
		const modelUsage = await claudeCode.getClaudeCodeModelUsage(filePath);
		const usage = modelUsage['claude-sonnet-4.6'];
		assert.ok(usage);
		assert.equal(usage.cacheCreationTokens, 1400); // total cache-write tokens (1000 + 400)
		assert.equal(usage.cacheCreation1hTokens, 1000); // only the 1h-TTL portion
	} finally {
		cleanup(filePath);
	}
});

test('getClaudeCodeSessionMeta: extracts title and timestamps', async () => {
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
		const meta = await claudeCode.getClaudeCodeSessionMeta(filePath);
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

test('getTokensFromClaudeCodeSession: returns zero for empty file', async () => {
	const filePath = createTempSession([]);
	try {
		const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
		assert.equal(result.tokens, 0);
		assert.equal(result.thinkingTokens, 0);
	} finally {
		cleanup(filePath);
	}
});

test('getTokensFromClaudeCodeSession: skips non-assistant events', async () => {
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
		const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
		assert.equal(result.tokens, 0);
	} finally {
		cleanup(filePath);
	}
});

// ── Mutation-killing tests ──────────────────────────────────────────────

test('getTokensFromClaudeCodeSession: handles non-numeric usage fields gracefully', async () => {
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
                const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
                // Only cache_read_input_tokens (10) is numeric, rest default to 0
                assert.equal(result.tokens, 10);
                assert.equal(result.thinkingTokens, 0);
        } finally {
                cleanup(filePath);
        }
});

test('getTokensFromClaudeCodeSession: handles missing usage object', async () => {
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
                const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
                assert.equal(result.tokens, 0);
        } finally {
                cleanup(filePath);
        }
});

test('getTokensFromClaudeCodeSession: last-wins on message.id correctly handles streaming fragments', async () => {
        const events = [
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                id: 'msg_001',
                                model: 'claude-sonnet-4-6',
                                stop_reason: null,
                                usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                },
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                id: 'msg_001',
                                model: 'claude-sonnet-4-6',
                                stop_reason: undefined,
                                usage: { input_tokens: 8, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                },
                {
                        type: 'assistant',
                        requestId: 'req_001',
                        message: {
                                id: 'msg_001',
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn',
                                usage: { input_tokens: 20, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
                // Last-wins: final event (stop_reason='end_turn', 20+100=120) supersedes earlier fragments
                assert.equal(result.tokens, 120);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: counts string content messages', async () => {
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
                const count = await claudeCode.countClaudeCodeInteractions(filePath);
                assert.equal(count, 2);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: does not count tool_result-only messages', async () => {
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
                const count = await claudeCode.countClaudeCodeInteractions(filePath);
                assert.equal(count, 0);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: does not count messages with text AND tool_result', async () => {
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
                const count = await claudeCode.countClaudeCodeInteractions(filePath);
                // Has text but also has tool_result → not a user interaction
                assert.equal(count, 0);
        } finally {
                cleanup(filePath);
        }
});

test('countClaudeCodeInteractions: returns 0 for empty file', async () => {
        const filePath = createTempSession([]);
        try {
                const count = await claudeCode.countClaudeCodeInteractions(filePath);
                assert.equal(count, 0);
        } finally {
                cleanup(filePath);
        }
});

test('getClaudeCodeModelUsage: handles events without requestId', async () => {
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
                const modelUsage = await claudeCode.getClaudeCodeModelUsage(filePath);
                assert.ok(modelUsage['claude-sonnet-4.6']);
                assert.equal(modelUsage['claude-sonnet-4.6'].inputTokens, 10);
                assert.equal(modelUsage['claude-sonnet-4.6'].outputTokens, 20);
        } finally {
                cleanup(filePath);
        }
});

test('getClaudeCodeModelUsage: handles non-numeric usage fields', async () => {
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
                const modelUsage = await claudeCode.getClaudeCodeModelUsage(filePath);
                assert.ok(modelUsage['claude-haiku-4.5']);
                // input_tokens defaults to 0 (non-numeric), cache_creation defaults to 0, cache_read = 5
                assert.equal(modelUsage['claude-haiku-4.5'].inputTokens, 5);
                assert.equal(modelUsage['claude-haiku-4.5'].outputTokens, 30);
        } finally {
                cleanup(filePath);
        }
});

test('getProjectPathFromHash: returns Unix-style path on non-Windows', async () => {
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

test('getProjectPathFromHash: handles simple single-segment hash', async () => {
        const result = claudeCode.getProjectPathFromHash('myproject');
        if (os.platform() !== 'win32') {
                assert.equal(result, '/myproject');
        } else {
                assert.ok(result.length > 0);
        }
});

test('getClaudeCodeSessionMeta: returns null for empty file', async () => {
        const filePath = createTempSession([]);
        try {
                const meta = await claudeCode.getClaudeCodeSessionMeta(filePath);
                assert.equal(meta, null);
        } finally {
                cleanup(filePath);
        }
});

test('getClaudeCodeSessionMeta: extracts timestamps without ai-title', async () => {
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
                const meta = await claudeCode.getClaudeCodeSessionMeta(filePath);
                assert.ok(meta);
                assert.equal(meta!.title, undefined);
                assert.equal(meta!.firstInteraction, '2026-03-27T22:47:31.000Z');
                assert.equal(meta!.lastInteraction, '2026-03-27T22:48:00.000Z');
        } finally {
                cleanup(filePath);
        }
});

// ── message.id dedup — crashed sessions and no-requestId duplicates ──────

test('getTokensFromClaudeCodeSession: crashed session uses partial tokens from last known event', async () => {
        // Session crashed before stop_reason was written — only streaming fragments available.
        // last-wins on message.id means we use the last fragment's token counts (partial but better than 0).
        const events = [
                {
                        type: 'assistant',
                        message: {
                                id: 'msg_crash',
                                model: 'claude-sonnet-4-6',
                                stop_reason: null,
                                usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                },
                {
                        type: 'assistant',
                        message: {
                                id: 'msg_crash',
                                model: 'claude-sonnet-4-6',
                                stop_reason: null,
                                usage: { input_tokens: 15, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
                // Last event wins: 15+40=55 (not 5+10+15+40=70)
                assert.equal(result.tokens, 55);
        } finally {
                cleanup(filePath);
        }
});

test('getTokensFromClaudeCodeSession: de-duplicates no-requestId events sharing a message.id', async () => {
        // Events without requestId can still have duplicate message.ids (Claude Code write-on-append).
        // Previously these were double-counted because only requestId-based dedup existed.
        const events = [
                {
                        type: 'assistant',
                        message: {
                                id: 'msg_dup',
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn',
                                usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                },
                {
                        type: 'assistant',
                        message: {
                                id: 'msg_dup',
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn',
                                usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                },
                {
                        type: 'assistant',
                        message: {
                                id: 'msg_unique',
                                model: 'claude-sonnet-4-6',
                                stop_reason: 'end_turn',
                                usage: { input_tokens: 5, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const result = await claudeCode.getTokensFromClaudeCodeSession(filePath);
                // msg_dup deduplicated to 60, msg_unique adds 25 → total 85 (not 60+60+25=145)
                assert.equal(result.tokens, 85);
        } finally {
                cleanup(filePath);
        }
});

test('getClaudeCodeModelUsage: crashed session contributes partial tokens per model', async () => {
        const events = [
                {
                        type: 'assistant',
                        message: {
                                id: 'msg_crash',
                                model: 'claude-sonnet-4-6',
                                stop_reason: null,
                                usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 }
                        }
                },
                {
                        type: 'assistant',
                        message: {
                                id: 'msg_crash',
                                model: 'claude-sonnet-4-6',
                                stop_reason: null,
                                usage: { input_tokens: 15, output_tokens: 30, cache_creation_input_tokens: 5, cache_read_input_tokens: 200 }
                        }
                }
        ];

        const filePath = createTempSession(events);
        try {
                const modelUsage = await claudeCode.getClaudeCodeModelUsage(filePath);
                // Last event wins: input=15+5+200=220, output=30, cacheCreation=5, cachedRead=200
                assert.ok(modelUsage['claude-sonnet-4.6']);
                assert.equal(modelUsage['claude-sonnet-4.6'].inputTokens, 220);
                assert.equal(modelUsage['claude-sonnet-4.6'].outputTokens, 30);
                assert.equal(modelUsage['claude-sonnet-4.6'].cacheCreationTokens, 5);
                assert.equal(modelUsage['claude-sonnet-4.6'].cachedReadTokens, 200);
        } finally {
                cleanup(filePath);
        }
});
// ----- ClaudeCodeAdapter.analyzeUsage: compact_boundary / __auto_compact__ -----

const adapterCtx = { modelPricing: {}, toolNameMap: {} };

test('ClaudeCodeAdapter.analyzeUsage: counts permissionMode per human user prompt as autonomyUsage', async () => {
const user = (mode: string | undefined, id: string) => ({
type: 'user', uuid: id, message: { role: 'user', content: 'hi' }, timestamp: '2026-10-04T09:00:00.000Z',
...(mode ? { permissionMode: mode } : {}),
});
const toolResult = { type: 'user', uuid: 'tr', permissionMode: 'auto', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: '2026-10-04T09:00:00.000Z' };
const synthetic = { type: 'user', uuid: 'sy', permissionMode: 'auto', message: { role: 'user', content: '<system-reminder>generated</system-reminder>' }, timestamp: '2026-10-04T09:00:00.000Z' };
const events = [user('default', 'a'), user('auto', 'b'), toolResult, synthetic, user('auto', 'c'), user('acceptEdits', 'd'), user(undefined, 'e')];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.deepEqual(result.autonomyUsage, { autonomous: 2, supervised: 2, plan: 0, other: 0 });
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: increments __auto_compact__ for trigger=auto', async () => {
const events = [
{
type: 'system',
subtype: 'compact_boundary',
content: 'Conversation compacted',
isMeta: false,
timestamp: '2026-05-06T10:15:34.700Z',
uuid: '1d887419-0000-0000-0000-000000000001',
compactMetadata: { trigger: 'auto', preTokens: 170679, postTokens: 8697, durationMs: 72528 },
entrypoint: 'claude-desktop'
}
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.toolCalls.byTool['__auto_compact__'], 1);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: accumulates multiple auto-compact events', async () => {
const events = [
{
type: 'system',
subtype: 'compact_boundary',
compactMetadata: { trigger: 'auto', preTokens: 170679, postTokens: 8697, durationMs: 72528 },
},
{
type: 'system',
subtype: 'compact_boundary',
compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 9000, durationMs: 60000 },
}
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.toolCalls.byTool['__auto_compact__'], 2);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: does NOT count __auto_compact__ for trigger=manual', async () => {
const events = [
{
type: 'system',
subtype: 'compact_boundary',
compactMetadata: { trigger: 'manual', preTokens: 50000, postTokens: 5000, durationMs: 10000 },
}
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.toolCalls.byTool['__auto_compact__'] ?? 0, 0);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: auto-compact does NOT inflate toolCalls.total', async () => {
const events = [
{
type: 'system',
subtype: 'compact_boundary',
compactMetadata: { trigger: 'auto', preTokens: 170679, postTokens: 8697, durationMs: 72528 },
}
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.toolCalls.total, 0);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: ignores system events with unknown subtype', async () => {
const events = [
{
type: 'system',
subtype: 'something_else',
content: 'unknown system event',
}
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.toolCalls.byTool['__auto_compact__'] ?? 0, 0);
assert.equal(result.toolCalls.total, 0);
} finally {
cleanup(filePath);
}
});

// ----- ClaudeCodeAdapter.analyzeUsage: Skill tool_use -> skillCalls (agnostic skill-usage tracking) -----

test('ClaudeCodeAdapter.analyzeUsage: unwraps Skill tool_use into skillCalls.byName', async () => {
const events = [
{
type: 'assistant',
message: {
id: 'msg_skill_1',
model: 'claude-sonnet-4-6',
role: 'assistant',
stop_reason: 'tool_use',
content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'graphify' } }]
}
}
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.skillCalls?.byName['graphify'], 1);
assert.equal(result.skillCalls?.total, 1);
// Additive (Option C): the raw "Skill" wrapper tool call is still counted as-is, unchanged.
assert.equal(result.toolCalls.byTool['Skill'], 1);
assert.equal(result.toolCalls.total, 1);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: accumulates multiple invocations of the same and different skills', async () => {
const events = [
{ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'tool_use',
content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'graphify' } }] } },
{ type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'tool_use',
content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'graphify' } }] } },
{ type: 'assistant', message: { id: 'm3', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'tool_use',
content: [{ type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'sync-host-views' } }] } },
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.skillCalls?.byName['graphify'], 2);
assert.equal(result.skillCalls?.byName['sync-host-views'], 1);
assert.equal(result.skillCalls?.total, 3);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: does not record skillCalls for non-Skill tool calls', async () => {
const events = [
{ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'tool_use',
content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.skillCalls?.total ?? 0, 0);
assert.equal(result.toolCalls.byTool['Bash'], 1);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: ignores Skill tool_use with missing/malformed input.skill', async () => {
const events = [
{ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'tool_use',
content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: {} }] } },
];
const filePath = createTempSession(events);
try {
const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
assert.equal(result.skillCalls?.total ?? 0, 0);
assert.equal(result.toolCalls.byTool['Skill'], 1);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.analyzeUsage: a user-typed slash invocation (<command-name>) also populates skillCalls', async () => {
	// Regression test for the real /graphify session: when a user directly types a
	// registered skill/command, Claude Code expands it into a plain USER message
	// carrying <command-message>/<command-name> tags - it is never a Skill tool_use
	// block, so this is a completely separate detection path from extractSkillName.
	const events = [
		{
			type: 'user', isSidechain: false,
			message: { role: 'user', content: '<command-message>graphify</command-message>\n<command-name>/graphify</command-name>' },
		},
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		assert.equal(result.skillCalls?.byName['graphify'], 1);
		assert.equal(result.skillCalls?.total, 1);
	} finally {
		cleanup(filePath);
	}
});

// ----- ClaudeCodeAdapter.analyzeUsage: modeUsage bucketing by entrypoint variant -----

test('ClaudeCodeAdapter.analyzeUsage: entrypoint "cli" counts toward modeUsage.cli', async () => {
	const events = [
		{ type: 'user', isSidechain: false, entrypoint: 'cli', message: { role: 'user', content: 'hello' } },
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		assert.equal(result.modeUsage.cli, 1);
		assert.equal(result.modeUsage.claudeDesktop ?? 0, 0);
		assert.equal(result.modeUsage.claudeVsCode ?? 0, 0);
	} finally {
		cleanup(filePath);
	}
});

test('ClaudeCodeAdapter.analyzeUsage: entrypoint "claude-desktop" counts toward modeUsage.claudeDesktop, not cli', async () => {
	const events = [
		{ type: 'user', isSidechain: false, entrypoint: 'claude-desktop', message: { role: 'user', content: 'hello' } },
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		assert.equal(result.modeUsage.claudeDesktop, 1);
		assert.equal(result.modeUsage.cli, 0);
		assert.equal(result.modeUsage.claudeVsCode ?? 0, 0);
	} finally {
		cleanup(filePath);
	}
});

test('ClaudeCodeAdapter.analyzeUsage: entrypoint "claude-vscode" counts toward modeUsage.claudeVsCode, not cli', async () => {
	const events = [
		{ type: 'user', isSidechain: false, entrypoint: 'claude-vscode', message: { role: 'user', content: 'hello' } },
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		assert.equal(result.modeUsage.claudeVsCode, 1);
		assert.equal(result.modeUsage.cli, 0);
		assert.equal(result.modeUsage.claudeDesktop ?? 0, 0);
	} finally {
		cleanup(filePath);
	}
});

test('ClaudeCodeAdapter.analyzeUsage: multiple user turns in a claude-desktop session all count under claudeDesktop', async () => {
	const events = [
		{ type: 'user', isSidechain: false, entrypoint: 'claude-desktop', message: { role: 'user', content: 'first' } },
		{ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
		{ type: 'user', isSidechain: false, message: { role: 'user', content: 'second' } },
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		assert.equal(result.modeUsage.claudeDesktop, 2);
		assert.equal(result.modeUsage.cli, 0);
	} finally {
		cleanup(filePath);
	}
});

// ----- ClaudeCodeAdapter.analyzeUsage: every event in the session is processed -----
//
// analyzeUsage's for-loop must run to completion and return once, after the loop —
// not return from inside it. A regression that closed the loop early would still
// type-check (a `return` inside a `for` is legal JS), so this is asserted directly
// on aggregate counts that only add up correctly if every event was visited.

test('ClaudeCodeAdapter.analyzeUsage: processes every event, not just the first — user turns, tool calls and models all accumulate past event 1', async () => {
	const events = [
		{ type: 'user', isSidechain: false, entrypoint: 'cli', message: { role: 'user', content: 'first' } },
		{
			type: 'assistant',
			message: {
				id: 'm1', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'tool_use',
				content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }],
			},
		},
		{ type: 'user', isSidechain: false, message: { role: 'user', content: 'second' } },
		{
			type: 'assistant',
			message: {
				id: 'm2', model: 'claude-opus-4-6', role: 'assistant', stop_reason: 'tool_use',
				content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/b.ts' } }],
			},
		},
		{ type: 'user', isSidechain: false, message: { role: 'user', content: 'third' } },
		{
			type: 'assistant',
			message: {
				id: 'm3', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn',
				content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/c.ts' } }],
			},
		},
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		// 3 user turns — only reachable if the loop visited events past index 0.
		assert.equal(result.modeUsage.cli, 3);
		// 3 tool calls across 3 separate assistant events.
		assert.equal(result.toolCalls.total, 3);
		assert.deepEqual(result.toolCalls.byTool, { Read: 1, Write: 1, Edit: 1 });
		// Model-switching stats are computed once, after the loop, from all 3 models seen.
		assert.equal(result.modelSwitching.totalRequests, 3);
		assert.equal(result.modelSwitching.modelCount, 2);
		assert.equal(result.modelSwitching.switchCount, 2);
	} finally {
		cleanup(filePath);
	}
});

// ----- ClaudeCodeAdapter.analyzeUsage: cacheBreakage (see src/cacheBreakage.ts) -----

test('ClaudeCodeAdapter.analyzeUsage: populates cacheBreakage from a multi-turn session with a TTL-expiry break', async () => {
	const bigPrefix = 60_000;
	const events = [
		{
			type: 'assistant',
			message: {
				id: 'c1', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn',
				content: [{ type: 'text', text: 'warm the cache' }],
				usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: bigPrefix, cache_read_input_tokens: 0 },
			},
			timestamp: '2026-05-06T10:00:00.000Z',
		},
		{
			// Idle well past the 5-minute default TTL, same model, no compaction —
			// the whole prefix has to be written again.
			type: 'assistant',
			message: {
				id: 'c2', model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn',
				content: [{ type: 'text', text: 're-warm' }],
				usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: bigPrefix, cache_read_input_tokens: 0 },
			},
			timestamp: '2026-05-06T10:30:00.000Z',
		},
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		assert.ok(result.cacheBreakage, 'cacheBreakage should be populated when assistant events carry usage');
		assert.equal(result.cacheBreakage!.breaks.length, 1);
		assert.equal(result.cacheBreakage!.breaks[0].cause, 'ttl-expiry');
		assert.equal(result.cacheBreakage!.tokensWritten, bigPrefix * 2);
	} finally {
		cleanup(filePath);
	}
});

test('ClaudeCodeAdapter.analyzeUsage: leaves cacheBreakage undefined when no assistant event carries usage', async () => {
	const events = [
		{ type: 'user', isSidechain: false, message: { role: 'user', content: 'hi' } },
	];
	const filePath = createTempSession(events);
	try {
		const result = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);
		assert.equal(result.cacheBreakage, undefined);
	} finally {
		cleanup(filePath);
	}
});

// ----- getClaudeCodeDailyFractions (issue #1608, root cause A) -----

test('getClaudeCodeDailyFractions: splits usage by each assistant event day, weighted by tokens', async () => {
const events = [
{
type: 'assistant',
message: {
model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn',
id: 'msg_day1', usage: { input_tokens: 100, output_tokens: 200 }
},
timestamp: '2026-07-11T12:00:00.000Z'
},
{
type: 'assistant',
message: {
model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn',
id: 'msg_day2', usage: { input_tokens: 100, output_tokens: 100 }
},
// 19h later — a different local day in every timezone from UTC-10 to UTC+14
timestamp: '2026-07-12T07:00:00.000Z'
}
];
const filePath = createTempSession(events);
try {
const fractions = await claudeCode.getClaudeCodeDailyFractions(filePath);
const keys = Object.keys(fractions).sort();
assert.equal(keys.length, 2, 'should have exactly 2 local day keys');
// day1: 300 tokens, day2: 200 tokens, total 500
const values = keys.map(k => fractions[k]).sort((a, b) => a - b);
assert.ok(Math.abs(values[0] - 0.4) < 1e-9, `expected 0.4, got ${values[0]}`);
assert.ok(Math.abs(values[1] - 0.6) < 1e-9, `expected 0.6, got ${values[1]}`);
const total = Object.values(fractions).reduce((a, b) => a + b, 0);
assert.ok(Math.abs(total - 1.0) < 1e-9, 'fractions should sum to 1.0');
} finally {
cleanup(filePath);
}
});

test('getClaudeCodeDailyFractions: de-duplicates streaming fragments by message.id before bucketing', async () => {
const events = [
{
type: 'assistant',
message: { model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: null, id: 'msg_1', usage: { input_tokens: 10, output_tokens: 20 } },
timestamp: '2026-07-11T12:00:00.000Z'
},
{
type: 'assistant',
message: { model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn', id: 'msg_1', usage: { input_tokens: 10, output_tokens: 50 } },
timestamp: '2026-07-11T12:00:05.000Z'
}
];
const filePath = createTempSession(events);
try {
const fractions = await claudeCode.getClaudeCodeDailyFractions(filePath);
const keys = Object.keys(fractions);
assert.equal(keys.length, 1);
assert.ok(Math.abs(fractions[keys[0]] - 1.0) < 1e-9);
} finally {
cleanup(filePath);
}
});

test('getClaudeCodeDailyFractions: falls back to firstInteraction day when there is no usage data', async () => {
const events = [
{
type: 'user',
isSidechain: false,
message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
timestamp: '2026-07-11T12:00:00.000Z'
}
];
const filePath = createTempSession(events);
try {
const fractions = await claudeCode.getClaudeCodeDailyFractions(filePath);
const keys = Object.keys(fractions);
assert.equal(keys.length, 1);
assert.equal(fractions[keys[0]], 1.0);
} finally {
cleanup(filePath);
}
});

test('ClaudeCodeAdapter.getDailyFractions: delegates to ClaudeCodeDataAccess', async () => {
const events = [
{
type: 'assistant',
message: { model: 'claude-sonnet-4-6', role: 'assistant', stop_reason: 'end_turn', id: 'msg_1', usage: { input_tokens: 10, output_tokens: 20 } },
timestamp: '2026-07-11T12:00:00.000Z'
}
];
const filePath = createTempSession(events);
try {
const fractions = await claudeCodeAdapter.getDailyFractions(filePath);
const keys = Object.keys(fractions);
assert.equal(keys.length, 1);
assert.equal(fractions[keys[0]], 1.0);
} finally {
cleanup(filePath);
}
});

// ----- getClaudeCodeSessionFiles recursion into subagent transcripts (issue #1608, root cause B) -----

class TestableClaudeCodeDataAccess extends ClaudeCodeDataAccess {
constructor(private readonly testDataDir: string) { super(); }
override getClaudeCodeDataDir(): string { return this.testDataDir; }
}

test('getClaudeCodeSessionFiles: discovers subagent transcripts nested under <sessionId>/subagents/**', async () => {
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'claude-discovery-test-'));
try {
const dataDir = path.join(tmpDir, '.claude');
const projectDir = path.join(dataDir, 'projects', 'test-project');
const topLevelFile = path.join(projectDir, 'session-1.jsonl');
const subagentDir = path.join(projectDir, 'session-1', 'subagents', 'workflows', 'wf-1');
const subagentFile = path.join(subagentDir, 'agent-1.jsonl');

fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(topLevelFile, JSON.stringify({ type: 'user' }), 'utf8');
fs.mkdirSync(subagentDir, { recursive: true });
fs.writeFileSync(subagentFile, JSON.stringify({ type: 'assistant' }), 'utf8');

const cc = new TestableClaudeCodeDataAccess(dataDir);
const files = (await cc.getClaudeCodeSessionFiles()).map(f => path.normalize(f)).sort();
assert.deepEqual(files, [path.normalize(subagentFile), path.normalize(topLevelFile)].sort());
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

test('getClaudeCodeSessionFiles: ignores empty files at any depth', async () => {
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'claude-discovery-test-'));
try {
const dataDir = path.join(tmpDir, '.claude');
const projectDir = path.join(dataDir, 'projects', 'test-project');
const subagentDir = path.join(projectDir, 'session-1', 'subagents');
const emptyTopLevel = path.join(projectDir, 'empty.jsonl');
const emptySubagent = path.join(subagentDir, 'empty-agent.jsonl');

fs.mkdirSync(subagentDir, { recursive: true });
fs.writeFileSync(emptyTopLevel, '', 'utf8');
fs.writeFileSync(emptySubagent, '', 'utf8');

const cc = new TestableClaudeCodeDataAccess(dataDir);
const files = await cc.getClaudeCodeSessionFiles();
assert.deepEqual(files, []);
} finally {
fs.rmSync(tmpDir, { recursive: true, force: true });
}
});

// ----- Cross-file dedup between a top-level session and its subagent transcripts -----
//
// Reproduces the scenario ccusage's dedup guards against ("sidechain logs can replay
// parent messages with new request IDs"): the same message.id appears in both the
// top-level session file and a nested <sessionId>/subagents/*.jsonl file. Since #1627
// made subagent files independently discoverable, and getTokensFromClaudeCodeSession /
// getClaudeCodeModelUsage only dedupe *within* a single file, the shared message's
// tokens get summed once per file instead of once total (issue #1570 investigation).

function createSessionFamily(topLevelEvents: any[], subagentEvents: any[]): { topLevelFile: string; subagentFile: string; tmpDir: string } {
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'claude-family-test-'));
	const projectDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
	const sessionId = 'session-family-1';
	const topLevelFile = path.join(projectDir, `${sessionId}.jsonl`);
	const subagentDir = path.join(projectDir, sessionId, 'subagents');
	const subagentFile = path.join(subagentDir, 'agent-1.jsonl');
	fs.mkdirSync(subagentDir, { recursive: true });
	fs.writeFileSync(topLevelFile, topLevelEvents.map(e => JSON.stringify(e)).join('\n'), 'utf8');
	fs.writeFileSync(subagentFile, subagentEvents.map(e => JSON.stringify(e)).join('\n'), 'utf8');
	return { topLevelFile, subagentFile, tmpDir };
}

const SHARED_MESSAGE_USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }; // 150 tokens
const SUBAGENT_OWN_USAGE = { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }; // 30 tokens

test('getTokensFromClaudeCodeSession: does not double-count a message.id replayed in a sibling subagent file', async () => {
	const topLevelEvents = [
		{ type: 'assistant', isSidechain: false, requestId: 'req_parent', message: { id: 'msg_shared', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: SHARED_MESSAGE_USAGE } }
	];
	const subagentEvents = [
		// The parent message replayed under a new requestId inside the subagent transcript.
		{ type: 'assistant', isSidechain: true, requestId: 'req_sidechain_replay', message: { id: 'msg_shared', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: SHARED_MESSAGE_USAGE } },
		// A genuinely unique message produced by the subagent itself.
		{ type: 'assistant', isSidechain: true, requestId: 'req_subagent_own', message: { id: 'msg_subagent_own', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: SUBAGENT_OWN_USAGE } }
	];
	const { topLevelFile, subagentFile, tmpDir } = createSessionFamily(topLevelEvents, subagentEvents);
	try {
		const parentTokens = await claudeCode.getTokensFromClaudeCodeSession(topLevelFile);
		const subagentTokens = await claudeCode.getTokensFromClaudeCodeSession(subagentFile);
		// True family total: 150 (shared, counted once) + 30 (subagent-only) = 180.
		// The generic per-file pipeline sums each file's independent result, so that sum
		// must equal the true total — the subagent file must NOT re-contribute the shared message.
		assert.equal(parentTokens.tokens, 150, 'parent file should count its own message once');
		assert.equal(subagentTokens.tokens, 30, 'subagent file should exclude the message already counted in the parent');
		assert.equal(parentTokens.tokens + subagentTokens.tokens, 180, 'summed family total must not double-count the shared message');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('getClaudeCodeModelUsage: does not double-count a message.id replayed in a sibling subagent file', async () => {
	const topLevelEvents = [
		{ type: 'assistant', isSidechain: false, requestId: 'req_parent', message: { id: 'msg_shared', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: SHARED_MESSAGE_USAGE } }
	];
	const subagentEvents = [
		{ type: 'assistant', isSidechain: true, requestId: 'req_sidechain_replay', message: { id: 'msg_shared', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: SHARED_MESSAGE_USAGE } },
		{ type: 'assistant', isSidechain: true, requestId: 'req_subagent_own', message: { id: 'msg_subagent_own', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: SUBAGENT_OWN_USAGE } }
	];
	const { topLevelFile, subagentFile, tmpDir } = createSessionFamily(topLevelEvents, subagentEvents);
	try {
		const parentUsage = await claudeCode.getClaudeCodeModelUsage(topLevelFile);
		const subagentUsage = await claudeCode.getClaudeCodeModelUsage(subagentFile);
		const totalInput = (parentUsage['claude-sonnet-4.6']?.inputTokens ?? 0) + (subagentUsage['claude-sonnet-4.6']?.inputTokens ?? 0);
		const totalOutput = (parentUsage['claude-sonnet-4.6']?.outputTokens ?? 0) + (subagentUsage['claude-sonnet-4.6']?.outputTokens ?? 0);
		// Family total: input 100+20=120, output 50+10=60 — the shared message must only appear once.
		assert.equal(totalInput, 120, 'summed input tokens must not double-count the shared message');
		assert.equal(totalOutput, 60, 'summed output tokens must not double-count the shared message');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ── Synthetic (harness-injected) user turns ────────────────────────────────────────────────────
// Claude Desktop-launched sessions interleave machine-generated `user` events with real prompts.
// Counting those as interactions inflated the count, and could make a session's presence in the
// Recent Sessions table depend entirely on synthetic noise (both views drop interactions === 0).

test('countClaudeCodeInteractions: ignores a turn that is only a <system-reminder>', async () => {
	const events = [
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>' }
		}
	];

	const filePath = createTempSession(events);
	try {
		assert.equal(await claudeCode.countClaudeCodeInteractions(filePath), 0);
	} finally {
		cleanup(filePath);
	}
});

test('countClaudeCodeInteractions: ignores a turn that is only a <task-notification>', async () => {
	const events = [
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: '<task-notification>\n<task-id>bhs2oz7e1</task-id>\n</task-notification>' }
		}
	];

	const filePath = createTempSession(events);
	try {
		assert.equal(await claudeCode.countClaudeCodeInteractions(filePath), 0);
	} finally {
		cleanup(filePath);
	}
});

test('countClaudeCodeInteractions: counts a real prompt prefixed by a <system-reminder>', async () => {
	// Claude Desktop prepends a worktree notice to the first prompt of a session. The human text
	// after the wrapper is a genuine turn and must survive stripping.
	const events = [
		{
			type: 'user',
			isSidechain: false,
			message: {
				role: 'user',
				content: '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n\nFix the broken CLI call in pr-risk-review.yml'
			}
		}
	];

	const filePath = createTempSession(events);
	try {
		assert.equal(await claudeCode.countClaudeCodeInteractions(filePath), 1);
	} finally {
		cleanup(filePath);
	}
});

test('countClaudeCodeInteractions: strips wrappers inside text blocks too', async () => {
	const events = [
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }] }
		},
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>\nreal question' }] }
		}
	];

	const filePath = createTempSession(events);
	try {
		assert.equal(await claudeCode.countClaudeCodeInteractions(filePath), 1);
	} finally {
		cleanup(filePath);
	}
});

test('countClaudeCodeInteractions: leaves unmatched angle brackets in prompt text alone', async () => {
	// Only paired, known wrapper elements are stripped — a prompt mentioning a tag must still count.
	const events = [
		{
			type: 'user',
			isSidechain: false,
			message: { role: 'user', content: 'why does <system-reminder> show up in my logs?' }
		}
	];

	const filePath = createTempSession(events);
	try {
		assert.equal(await claudeCode.countClaudeCodeInteractions(filePath), 1);
	} finally {
		cleanup(filePath);
	}
});

// ── Titles ─────────────────────────────────────────────────────────────────────────────────────

test('getClaudeCodeSessionMeta: reads a custom-title when there is no ai-title', async () => {
	// Claude Desktop-started sessions often carry only `custom-title`; reading `ai-title` alone
	// left them untitled in the Recent Sessions table.
	const events = [
		{ type: 'user', timestamp: '2026-09-16T07:49:59.000Z', entrypoint: 'claude-desktop' },
		{ type: 'custom-title', sessionId: 'test', customTitle: "Fix PR risk review's broken Copilot CLI call" }
	];

	const filePath = createTempSession(events);
	try {
		const meta = await claudeCode.getClaudeCodeSessionMeta(filePath);
		assert.equal(meta!.title, "Fix PR risk review's broken Copilot CLI call");
		assert.equal(meta!.entrypoint, 'claude-desktop');
	} finally {
		cleanup(filePath);
	}
});

test('getClaudeCodeSessionMeta: a custom-title outranks an ai-title', async () => {
	const events = [
		{ type: 'user', timestamp: '2026-09-16T07:49:59.000Z' },
		{ type: 'ai-title', sessionId: 'test', aiTitle: 'Model-generated title' },
		{ type: 'custom-title', sessionId: 'test', customTitle: 'Title the user chose' }
	];

	const filePath = createTempSession(events);
	try {
		assert.equal((await claudeCode.getClaudeCodeSessionMeta(filePath))!.title, 'Title the user chose');
	} finally {
		cleanup(filePath);
	}
});
// ----- ClaudeCodeAdapter.analyzeUsage: tool_use/tool_result pairing -> failures, latency, output tokens -----

test('ClaudeCodeAdapter.analyzeUsage: pairs tool_result with tool_use to record failures, observed latency and output tokens', async () => {
	const t = (offsetMs: number) => new Date(Date.UTC(2026, 4, 1, 10, 0, 0, offsetMs)).toISOString();
	const assistant = (ts: string, blocks: any[], extra: Record<string, unknown> = {}) => ({
		type: 'assistant', timestamp: ts, ...extra,
		message: { role: 'assistant', model: 'claude-sonnet-4-6', content: blocks },
	});
	const result = (ts: string, blocks: any[], extra: Record<string, unknown> = {}) => ({
		type: 'user', timestamp: ts, parentUuid: 'x', ...extra,
		message: { role: 'user', content: blocks },
	});
	const events = [
		{ type: 'user', timestamp: t(0), message: { role: 'user', content: 'do things' } },
		// Bash: 3000 ms, is_error
		assistant(t(100), [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'x' } }]),
		result(t(3100), [{ type: 'tool_result', tool_use_id: 'toolu_bash', is_error: true, content: 'boom' }]),
		// Read: 40 ms, success, result text sized into outputTokensByTool
		assistant(t(4000), [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/a' } }]),
		result(t(4040), [{ type: 'tool_result', tool_use_id: 'toolu_read', content: [{ type: 'text', text: 'x'.repeat(400) }] }]),
		// Streaming re-log of the same tool_use id: the earlier timestamp must win.
		assistant(t(4500), [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/a' } }]),
		// MCP: 1500 ms, failure, attributed to the server derived from the name prefix.
		assistant(t(5000), [{ type: 'tool_use', id: 'toolu_mcp', name: 'mcp__github__create_issue', input: {} }]),
		result(t(6500), [{ type: 'tool_result', tool_use_id: 'toolu_mcp', is_error: true, content: 'nope' }]),
		// Sidechain (subagent) pair: matched even though sidechain user events are not real turns.
		assistant(t(7000), [{ type: 'tool_use', id: 'toolu_side', name: 'Grep', input: {} }], { isSidechain: true }),
		result(t(7200), [{ type: 'tool_result', tool_use_id: 'toolu_side', content: 'hit' }], { isSidechain: true }),
		// Result with no timestamp: failure counted, no latency sample.
		assistant(t(8000), [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: {} }]),
		{ type: 'user', parentUuid: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', is_error: true, content: '' }] } },
		// Orphaned tool_use (session aborted): nothing recorded.
		assistant(t(9000), [{ type: 'tool_use', id: 'toolu_orphan', name: 'WebFetch', input: {} }]),
		// Result for an unknown id: ignored.
		result(t(9500), [{ type: 'tool_result', tool_use_id: 'toolu_unknown', content: 'stray' }]),
	];
	const filePath = createTempSession(events);
	try {
		const analysis = await claudeCodeAdapter.analyzeUsage(filePath, adapterCtx);

		assert.deepEqual(analysis.toolCalls.completedByTool, { Bash: 1, Read: 1, Grep: 1, Edit: 1 }, 'one completion per matched result; re-logged and orphaned tool_use blocks do not count');
		assert.deepEqual(analysis.toolCalls.failuresByTool, { Bash: 1, Edit: 1 });
		assert.deepEqual(analysis.mcpTools.completedByServer, { github: 1 });
		assert.deepEqual(analysis.mcpTools.failuresByServer, { github: 1 });

		const lat = analysis.toolCalls.latencyByTool!;
		assert.equal(lat.Bash.count, 1);
		assert.equal(lat.Bash.sumMs, 3000);
		assert.equal(lat.Read.count, 1);
		assert.equal(lat.Read.sumMs, 40);
		assert.equal(lat.Grep.sumMs, 200);
		assert.equal(lat.mcp__github__create_issue, undefined, 'MCP latency lives under mcpTools only');
		assert.equal(lat.Edit, undefined, 'no latency sample without a result timestamp');
		assert.equal(lat.WebFetch, undefined, 'orphaned tool_use must not produce a sample');
		assert.equal(analysis.mcpTools.latencyByServer!.github.sumMs, 1500);

		const out = analysis.toolCalls.outputTokensByTool!;
		assert.ok(out.Read > 0, 'Read result text should be sized');
		assert.ok(out.Bash > 0, 'error text still counts as tool output');
		assert.equal(out.mcp__github__create_issue, undefined, 'MCP results are not sized into outputTokensByTool');
		assert.equal(out.Edit, undefined, 'empty result text adds nothing');

		// Existing counters are unchanged by the pairing (the re-logged tool_use still counts as before).
		assert.equal(analysis.toolCalls.byTool.Read, 2);
		assert.equal(analysis.toolCalls.byTool.Bash, 1);
		assert.equal(analysis.mcpTools.byServer.github, 1);
	} finally {
		cleanup(filePath);
	}
});
