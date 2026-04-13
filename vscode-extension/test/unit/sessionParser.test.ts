import test from 'node:test';
import * as assert from 'node:assert/strict';

import { parseSessionFileContent } from '../../src/sessionParser';

function estimateTokensByLength(text: string): number {
	return text.length;
}

test('delta-based JSONL: does not allow prototype pollution via delta path keys', () => {
	// Ensure clean baseline
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: extracts per-request modelId and does not let callback override to default', () => {
	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2,
			k: ['requests'],
			v: [
				{
					modelId: 'copilot/claude-sonnet-4.5',
					message: { text: 'hi' },
					response: [{ kind: 'markdownContent', content: { value: 'hello' } }]
				}
			]
		})
	].join('\n');

	const result = parseSessionFileContent(
		filePath,
		content,
		estimateTokensByLength,
		// Simulate an unhelpful callback returning a default model
		() => 'gpt-4o'
	);

	assert.equal(result.interactions, 1);
	assert.ok(result.modelUsage['claude-sonnet-4.5']);
	assert.equal(result.modelUsage['claude-sonnet-4.5'].inputTokens, 2);
	assert.equal(result.modelUsage['claude-sonnet-4.5'].outputTokens, 5);
});

test('delta-based JSONL: response text prefers content.value over value to avoid double counting', () => {
	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2,
			k: ['requests'],
			v: [
				{
					modelId: 'copilot/gpt-5-mini',
					message: { text: 'x' },
					response: [{ kind: 'markdownContent', value: 'AAAA', content: { value: 'BB' } }]
				}
			]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.ok(result.modelUsage['gpt-5-mini']);
	assert.equal(result.modelUsage['gpt-5-mini'].inputTokens, 1);
	// Should count only "BB" (2), not "AAAA" + "BB"
	assert.equal(result.modelUsage['gpt-5-mini'].outputTokens, 2);
});

test('non-delta .jsonl: parses JSON object content when file extension is .jsonl', () => {
	const filePath = 'C:/tmp/session.jsonl';
	const content = JSON.stringify({
		requests: [
			{ model: 'gpt-5-mini', message: { text: 'x' }, response: [{ value: 'y' }] }
		]
	});

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.interactions, 1);
	assert.ok(result.modelUsage['gpt-5-mini']);
	assert.equal(result.modelUsage['gpt-5-mini'].inputTokens, 1);
	assert.equal(result.modelUsage['gpt-5-mini'].outputTokens, 1);
});

// CR-002: Additional prototype pollution attack vector tests
test('delta-based JSONL: blocks prototype pollution via constructor path', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['constructor', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: blocks prototype pollution via hasOwnProperty path', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['hasOwnProperty', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: blocks prototype pollution via __-prefixed keys', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['__secret__', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
});

test('delta-based JSONL: blocks nested prototype pollution attempts', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['requests', '__proto__', 'polluted'], v: 'yes' })
	].join('\n');

	const _ = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: blocks prototype pollution in array append operations', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 2, k: ['__proto__'], v: [{ polluted: 'yes' }] })
	].join('\n');

	const _ = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

// ── Thinking token tests ────────────────────────────────────────────────

test('JSON session: thinking response items are tracked separately and included in total', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'claude-sonnet-4.5',
				message: { text: 'think hard' },
				response: [
					{ kind: 'thinking', value: 'Let me reason about this...' },
					{ value: 'Here is the answer.' }
				]
			}
		]
	});
	const result = parseSessionFileContent('session.json', content, estimateTokensByLength);
	assert.equal(result.interactions, 1);
	assert.ok(result.thinkingTokens > 0, 'thinkingTokens should be > 0');
	// tokens = input + output + thinking (thinking is included, not subtracted)
	const inputLen = 'think hard'.length;
	const outputLen = 'Here is the answer.'.length;
	const thinkingLen = 'Let me reason about this...'.length;
	assert.equal(result.thinkingTokens, thinkingLen);
	assert.equal(result.tokens, inputLen + outputLen + thinkingLen);
});

test('delta-based JSONL: thinking response items are tracked separately and included in total', () => {
	const filePath = 'session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2,
			k: ['requests'],
			v: [
				{
					modelId: 'copilot/claude-sonnet-4.5',
					message: { text: 'think' },
					response: [
						{ kind: 'thinking', value: 'reasoning...' },
						{ kind: 'markdownContent', content: { value: 'answer' } }
					]
				}
			]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.thinkingTokens, 'reasoning...'.length);
	assert.equal(result.tokens, 'think'.length + 'answer'.length + 'reasoning...'.length);
});

test('JSON session: no thinking items means thinkingTokens is 0', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'gpt-4o',
				message: { text: 'hello' },
				response: [{ value: 'world' }]
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.thinkingTokens, 0);
	assert.equal(result.tokens, 'hello'.length + 'world'.length);
});

// ── Multi-model session tests ───────────────────────────────────────────

test('JSON session: multiple models produce separate modelUsage entries', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'gpt-4o',
				message: { text: 'aaa' },
				response: [{ value: 'bbb' }]
			},
			{
				model: 'claude-sonnet-4.5',
				message: { text: 'ccc' },
				response: [{ value: 'ddd' }]
			},
			{
				model: 'gpt-4o',
				message: { text: 'eee' },
				response: [{ value: 'fff' }]
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.interactions, 3);
	assert.ok(result.modelUsage['gpt-4o'], 'gpt-4o should be present');
	assert.ok(result.modelUsage['claude-sonnet-4.5'], 'claude-sonnet-4.5 should be present');
	// gpt-4o: input aaa(3)+eee(3)=6, output bbb(3)+fff(3)=6
	assert.equal(result.modelUsage['gpt-4o'].inputTokens, 6);
	assert.equal(result.modelUsage['gpt-4o'].outputTokens, 6);
	// claude: input ccc(3), output ddd(3)
	assert.equal(result.modelUsage['claude-sonnet-4.5'].inputTokens, 3);
	assert.equal(result.modelUsage['claude-sonnet-4.5'].outputTokens, 3);
});

test('delta-based JSONL: multiple requests with different models', () => {
	const filePath = 'session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2, k: ['requests'],
			v: [
				{ modelId: 'copilot/gpt-4o', message: { text: 'aa' }, response: [{ kind: 'markdownContent', content: { value: 'bb' } }] },
				{ modelId: 'copilot/o3-mini', message: { text: 'cc' }, response: [{ kind: 'markdownContent', content: { value: 'dd' } }] }
			]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.interactions, 2);
	assert.ok(result.modelUsage['gpt-4o']);
	assert.ok(result.modelUsage['o3-mini']);
});

// ── Edge cases ──────────────────────────────────────────────────────────

test('JSON session: empty requests array returns zeros', () => {
	const content = JSON.stringify({ requests: [] });
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(result.interactions, 0);
	assert.equal(result.thinkingTokens, 0);
	assert.deepEqual(result.modelUsage, {});
});

test('invalid JSON returns zeros', () => {
	const result = parseSessionFileContent('s.json', 'not json at all {{{', estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(result.interactions, 0);
});

test('JSON session: missing model defaults to gpt-4o', () => {
	const content = JSON.stringify({
		requests: [
			{ message: { text: 'hi' }, response: [{ value: 'yo' }] }
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.ok(result.modelUsage['gpt-4o'], 'should default to gpt-4o');
});

test('JSON session: uses message.parts when message.text is absent', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'gpt-4o',
				message: { parts: [{ text: 'part1' }, { text: 'part2' }] },
				response: [{ value: 'reply' }]
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.modelUsage['gpt-4o'].inputTokens, 'part1'.length + 'part2'.length);
});

test('JSON session: falls back to history array when requests is absent', () => {
	const content = JSON.stringify({
		history: [
			{ model: 'gpt-4o', message: { text: 'q' }, response: [{ value: 'a' }] }
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.interactions, 1);
	assert.equal(result.tokens, 'q'.length + 'a'.length);
});

test('JSON session: copilot/ prefix is stripped from model ID', () => {
	const content = JSON.stringify({
		requests: [
			{ model: 'copilot/claude-sonnet-4.5', message: { text: 'x' }, response: [{ value: 'y' }] }
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.ok(result.modelUsage['claude-sonnet-4.5'], 'copilot/ prefix should be stripped');
	assert.ok(!result.modelUsage['copilot/claude-sonnet-4.5'], 'full prefixed name should not be a key');
});

test('delta-based JSONL: request with empty message text is not counted as interaction', () => {
	const filePath = 'session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2, k: ['requests'],
			v: [
				{ modelId: 'copilot/gpt-4o', message: { text: '' }, response: [{ kind: 'markdownContent', content: { value: 'auto' } }] },
				{ modelId: 'copilot/gpt-4o', message: { text: 'real question' }, response: [{ kind: 'markdownContent', content: { value: 'answer' } }] }
			]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.interactions, 1, 'empty message text should not count as interaction');
});

test('delta-based JSONL: invalid JSON lines are silently skipped', () => {
	const filePath = 'session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		'this is { not valid json',
		JSON.stringify({
			kind: 2, k: ['requests'],
			v: [{ modelId: 'copilot/gpt-4o', message: { text: 'hi' }, response: [{ kind: 'markdownContent', content: { value: 'yo' } }] }]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.interactions, 1);
	assert.equal(result.tokens, 'hi'.length + 'yo'.length);
});

// ── actualTokens extraction tests ──────────────────────────────────────────

test('JSON session: extracts actualTokens from old result.usage format', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'gpt-4o',
				message: { text: 'hello' },
				response: [{ value: 'world' }],
				result: { usage: { promptTokens: 100, completionTokens: 50 } }
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.actualTokens, 150);
});

test('JSON session: extracts actualTokens from new result.promptTokens/outputTokens format', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'gpt-4o',
				message: { text: 'hello' },
				response: [{ value: 'world' }],
				result: { promptTokens: 200, outputTokens: 80 }
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.actualTokens, 280);
});

test('JSON session: extracts actualTokens from insiders result.metadata format', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'gpt-4o',
				message: { text: 'hello' },
				response: [{ value: 'world' }],
				result: { metadata: { promptTokens: 300, outputTokens: 120 } }
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.actualTokens, 420);
});

test('JSON session: accumulates actualTokens across multiple requests', () => {
	const content = JSON.stringify({
		requests: [
			{
				model: 'gpt-4o',
				message: { text: 'a' },
				response: [{ value: 'b' }],
				result: { usage: { promptTokens: 100, completionTokens: 50 } }
			},
			{
				model: 'gpt-4o',
				message: { text: 'c' },
				response: [{ value: 'd' }],
				result: { promptTokens: 200, outputTokens: 80 }
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.actualTokens, 430);
});

test('JSON session: actualTokens is 0 when no result usage fields present', () => {
	const content = JSON.stringify({
		requests: [
			{ model: 'gpt-4o', message: { text: 'hello' }, response: [{ value: 'world' }] }
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.equal(result.actualTokens, 0);
});

// Sub-agent token tracking tests

test('JSON session: sub-agent with plain string result is counted under sub-agent model', () => {
	const subAgentItem = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'find files',        // 10 chars
			result: 'here are files',    // 14 chars
		}
	};
	const content = JSON.stringify({
		requests: [
			{
				model: 'claude-opus-4',
				message: { text: 'go' },            // 2 input chars under opus
				response: [
					{ value: 'ok' },                  // 2 output chars under opus
					subAgentItem,
				]
			}
		]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	// Sub-agent model name normalized: "claude-haiku-4.5"
	assert.ok(result.modelUsage['claude-haiku-4.5'], 'sub-agent model should have usage');
	assert.equal(result.modelUsage['claude-haiku-4.5'].inputTokens, 10, 'sub-agent prompt chars');
	assert.equal(result.modelUsage['claude-haiku-4.5'].outputTokens, 14, 'sub-agent result chars');
	// Parent model still has its own tokens
	assert.equal(result.modelUsage['claude-opus-4'].outputTokens, 2);
});

test('JSON session: sub-agent with streaming char object result is counted correctly', () => {
	// Build streaming char result: "Hi" => {"0":"H","1":"i"}
	const streamingResult: Record<string, string> = {};
	Array.from('Hi').forEach((c, i) => { streamingResult[String(i)] = c; });
	const subAgentItem = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'ping',
			result: streamingResult,
		}
	};
	const content = JSON.stringify({
		requests: [{ model: 'gpt-4o', message: { text: 'x' }, response: [subAgentItem] }]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.ok(result.modelUsage['claude-haiku-4.5']);
	assert.equal(result.modelUsage['claude-haiku-4.5'].inputTokens, 4, 'prompt: "ping"');
	assert.equal(result.modelUsage['claude-haiku-4.5'].outputTokens, 2, 'result: "Hi"');
});

test('JSON session: sub-agent with missing modelName falls back to parent model', () => {
	const subAgentItem = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			// no modelName
			prompt: 'search',
			result: 'found it',
		}
	};
	const content = JSON.stringify({
		requests: [{ model: 'gpt-4o', message: { text: 'do' }, response: [subAgentItem] }]
	});
	const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
	assert.ok(result.modelUsage['gpt-4o']);
	// Falls back to parent model
	assert.equal(result.modelUsage['gpt-4o'].inputTokens, 2 + 6, 'parent input + sub-agent prompt');
	assert.equal(result.modelUsage['gpt-4o'].outputTokens, 8, 'sub-agent result under parent');
});

test('delta-based JSONL: sub-agent tokens are counted from reconstructed state', () => {
	const subAgentItem = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'list',       // 4 chars
			result: 'file.ts',   // 7 chars
		}
	};
	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2,
			k: ['requests'],
			v: [{
				requestId: 'r1',
				modelId: 'copilot/claude-opus-4.6',
				message: { text: 'go' },
				response: [subAgentItem],
			}]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.ok(result.modelUsage['claude-haiku-4.5'], 'sub-agent model should appear in delta path');
	assert.equal(result.modelUsage['claude-haiku-4.5'].inputTokens, 4);
	assert.equal(result.modelUsage['claude-haiku-4.5'].outputTokens, 7);
});

test('delta-based JSONL: sub-agent items do not contribute to parent model output', () => {
	const subAgentItem = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'search query',
			result: 'search results here',
		}
	};
	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2,
			k: ['requests'],
			v: [{
				requestId: 'r1',
				modelId: 'copilot/claude-opus-4.6',
				message: { text: 'help' },
				response: [
					{ kind: 'markdownContent', content: { value: 'sure' } },
					subAgentItem,
				],
			}]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	// Parent model only has "sure" (4 chars) as output, not the sub-agent text
	assert.equal(result.modelUsage['claude-opus-4.6'].outputTokens, 4, 'parent output should not include sub-agent result');
	// Sub-agent is tracked separately
	assert.ok(result.modelUsage['claude-haiku-4.5']);
});

// ── Mutation-killing tests ──────────────────────────────────────────────

test('delta-based JSONL: kind 1 (update) sets value at key path', () => {
        const filePath = 'C:/tmp/session.jsonl';
        const content = [
                JSON.stringify({ kind: 0, v: { requests: [{ model: 'gpt-4o', message: { text: 'aaa' }, response: [] }] } }),
                JSON.stringify({ kind: 1, k: ['requests', '0', 'response'], v: [{ value: 'bbb' }] })
        ].join('\n');

        const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
        assert.equal(result.interactions, 1);
        assert.ok(result.modelUsage['gpt-4o']);
        assert.equal(result.modelUsage['gpt-4o'].outputTokens, 3);
});

test('delta-based JSONL: multiple kind 2 appends accumulate requests', () => {
        const filePath = 'C:/tmp/session.jsonl';
        const content = [
                JSON.stringify({ kind: 0, v: { requests: [] } }),
                JSON.stringify({
                        kind: 2,
                        k: ['requests'],
                        v: [{ modelId: 'copilot/gpt-4o', message: { text: 'q1' }, response: [{ kind: 'markdownContent', content: { value: 'a1' } }] }]
                }),
                JSON.stringify({
                        kind: 2,
                        k: ['requests'],
                        v: [{ modelId: 'copilot/gpt-4o', message: { text: 'q2' }, response: [{ kind: 'markdownContent', content: { value: 'a2' } }] }]
                })
        ].join('\n');

        const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
        assert.equal(result.interactions, 2);
        assert.equal(result.modelUsage['gpt-4o'].inputTokens, 4); // q1(2) + q2(2)
        assert.equal(result.modelUsage['gpt-4o'].outputTokens, 4); // a1(2) + a2(2)
});

test('JSON session: normalizes copilot/ prefix in model field', () => {
        const content = JSON.stringify({
                requests: [
                        { model: 'copilot/claude-sonnet-4.5', message: { text: 'hi' }, response: [{ value: 'hello' }] }
                ]
        });
        const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
        assert.ok(result.modelUsage['claude-sonnet-4.5']);
        assert.ok(!result.modelUsage['copilot/claude-sonnet-4.5']);
});

test('JSON session: uses default model when model field is empty string', () => {
        const content = JSON.stringify({
                requests: [
                        { model: '', message: { text: 'hi' }, response: [{ value: 'world' }] }
                ]
        });
        const result = parseSessionFileContent('s.json', content, estimateTokensByLength, () => 'fallback-model');
        assert.ok(result.modelUsage['fallback-model']);
});

test('JSON session: uses default model when model field is whitespace', () => {
        const content = JSON.stringify({
                requests: [
                        { model: '   ', message: { text: 'hi' }, response: [{ value: 'world' }] }
                ]
        });
        const result = parseSessionFileContent('s.json', content, estimateTokensByLength, () => 'fallback-model');
        assert.ok(result.modelUsage['fallback-model']);
});

test('JSON session: uses default model when model field is not a string', () => {
        const content = JSON.stringify({
                requests: [
                        { model: 42, message: { text: 'hi' }, response: [{ value: 'world' }] }
                ]
        });
        const result = parseSessionFileContent('s.json', content, estimateTokensByLength, () => 'fallback-model');
        assert.ok(result.modelUsage['fallback-model']);
});

test('JSON session: empty requests array returns zero stats', () => {
        const content = JSON.stringify({ requests: [] });
        const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
        assert.equal(result.tokens, 0);
        assert.equal(result.interactions, 0);
        assert.equal(result.thinkingTokens, 0);
        assert.deepEqual(result.modelUsage, {});
});

test('JSON session: request with empty message text and response', () => {
        const content = JSON.stringify({
                requests: [
                        { model: 'gpt-4o', message: { text: '' }, response: [] }
                ]
        });
        const result = parseSessionFileContent('s.json', content, estimateTokensByLength);
        assert.equal(result.interactions, 1);
        assert.equal(result.tokens, 0);
});

test('delta-based JSONL: kind 0 replaces entire state', () => {
        const filePath = 'C:/tmp/session.jsonl';
        const content = [
                JSON.stringify({ kind: 0, v: { requests: [{ modelId: 'copilot/gpt-4o', message: { text: 'old' }, response: [{ kind: 'markdownContent', content: { value: 'old-resp' } }] }] } }),
                JSON.stringify({ kind: 0, v: { requests: [{ modelId: 'copilot/claude-sonnet-4.5', message: { text: 'new' }, response: [{ kind: 'markdownContent', content: { value: 'new-resp' } }] }] } })
        ].join('\n');

        const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
        // Second kind:0 replaces state, so only claude-sonnet-4.5 should be present
        assert.equal(result.interactions, 1);
        assert.ok(result.modelUsage['claude-sonnet-4.5']);
        assert.ok(!result.modelUsage['gpt-4o']);
});

test('delta-based JSONL: ignores deltas with non-object value', () => {
        const filePath = 'C:/tmp/session.jsonl';
        const content = [
                JSON.stringify({ kind: 0, v: { requests: [] } }),
                'not valid json at all',
                JSON.stringify({
                        kind: 2,
                        k: ['requests'],
                        v: [{ modelId: 'copilot/gpt-4o', message: { text: 'q' }, response: [{ kind: 'markdownContent', content: { value: 'a' } }] }]
                })
        ].join('\n');

        const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
        assert.equal(result.interactions, 1);
});

test('delta-based JSONL: handles response with both value and content.value', () => {
        const filePath = 'C:/tmp/session.jsonl';
        const content = [
                JSON.stringify({ kind: 0, v: { requests: [] } }),
                JSON.stringify({
                        kind: 2,
                        k: ['requests'],
                        v: [{
                                modelId: 'copilot/gpt-4o',
                                message: { text: 'question' },
                                response: [
                                        { kind: 'markdownContent', value: 'should-be-ignored', content: { value: 'preferred' } },
                                        { kind: 'markdownContent', content: { value: ' answer' } }
                                ]
                        }]
                })
        ].join('\n');

        const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
        // Should use content.value (preferred + answer = 16), not value
        assert.equal(result.modelUsage['gpt-4o'].outputTokens, 'preferred answer'.length);
});