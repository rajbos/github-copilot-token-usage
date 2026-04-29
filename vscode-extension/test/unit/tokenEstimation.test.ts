import test from 'node:test';
import * as assert from 'node:assert/strict';

import { extractSubAgentData, normalizeDisplayModelName } from '../../src/tokenEstimation';

test('normalizeDisplayModelName: lowercases and replaces spaces with hyphens', () => {
	assert.equal(normalizeDisplayModelName('Claude Haiku 4.5'), 'claude-haiku-4.5');
	assert.equal(normalizeDisplayModelName('GPT 4 Turbo'), 'gpt-4-turbo');
	assert.equal(normalizeDisplayModelName('claude-sonnet-4'), 'claude-sonnet-4');
	assert.equal(normalizeDisplayModelName('  Gemini 2.5 Pro  '), 'gemini-2.5-pro');
});

test('extractSubAgentData: returns null for non-subagent items', () => {
	assert.equal(extractSubAgentData(null), null);
	assert.equal(extractSubAgentData(undefined), null);
	assert.equal(extractSubAgentData({ kind: 'markdownContent', value: 'hello' }), null);
	assert.equal(extractSubAgentData({ kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'other' } }), null);
	assert.equal(extractSubAgentData({ kind: 'toolInvocationSerialized' }), null);
	assert.equal(extractSubAgentData({ kind: 'toolInvocationSerialized', toolSpecificData: {} }), null);
});

test('extractSubAgentData: extracts data from plain string result', () => {
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'search for files',
			result: 'found 3 files',
		}
	};
	const data = extractSubAgentData(item);
	assert.ok(data, 'should return data');
	assert.equal(data.prompt, 'search for files');
	assert.equal(data.result, 'found 3 files');
	assert.equal(data.modelName, 'claude-haiku-4.5');
});

test('extractSubAgentData: decodes streaming char object result in correct order', () => {
	// Numeric keys in non-sequential order to verify sort
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'go',
			result: { '2': 'l', '0': 'h', '1': 'e', '3': 'p' }
		}
	};
	const data = extractSubAgentData(item);
	assert.ok(data);
	assert.equal(data.result, 'help', 'should sort numerically: 0=h,1=e,2=l,3=p');
});

test('extractSubAgentData: returns null when both prompt and result are empty', () => {
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: '',
			result: '',
		}
	};
	assert.equal(extractSubAgentData(item), null);
});

test('extractSubAgentData: handles missing modelName gracefully', () => {
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			prompt: 'list files',
			result: 'file.ts',
		}
	};
	const data = extractSubAgentData(item);
	assert.ok(data);
	assert.equal(data.modelName, '', 'empty string when modelName is absent');
	assert.equal(data.prompt, 'list files');
	assert.equal(data.result, 'file.ts');
});

// ── Mutation-killing tests ──────────────────────────────────────────────

import {
        estimateTokensFromText,
        isJsonlContent,
        isUuidPointerFile,
        getModelTier,
        calculateEstimatedCost,
        getTotalTokensFromModelUsage,
        getModelFromRequest,
        createEmptyContextRefs
} from '../../src/tokenEstimation';

// ── estimateTokensFromText ──────────────────────────────────────────────

test('estimateTokensFromText: returns token count for simple text', () => {
        const result = estimateTokensFromText('hello world', 'gpt-4');
        assert.ok(result > 0);
        assert.equal(typeof result, 'number');
});

test('estimateTokensFromText: empty text returns 0', () => {
        assert.equal(estimateTokensFromText('', 'gpt-4'), 0);
});

test('estimateTokensFromText: uses custom estimator for matching model', () => {
        const estimators = { 'test-model': 0.5 };
        const result = estimateTokensFromText('abcdefgh', 'test-model', estimators);
        // 8 chars * 0.5 = 4 tokens
        assert.equal(result, 4);
});

test('estimateTokensFromText: falls back to default ratio for unknown model', () => {
        const result = estimateTokensFromText('abcd', 'unknown-model', {});
        // 4 chars * 0.25 default = 1 token
        assert.equal(result, 1);
});

// ── isJsonlContent ──────────────────────────────────────────────────────

test('isJsonlContent: returns true for multi-line JSON objects', () => {
        const content = '{"kind":0,"v":{}}\n{"kind":1,"k":["a"],"v":"b"}\n';
        assert.equal(isJsonlContent(content), true);
});

test('isJsonlContent: returns false for single-line JSON', () => {
        assert.equal(isJsonlContent('{"requests":[]}'), false);
});

test('isJsonlContent: returns false for single line with newlines only in content', () => {
        assert.equal(isJsonlContent('single line without newlines'), false);
});

test('isJsonlContent: returns false for non-JSON multi-line content', () => {
        assert.equal(isJsonlContent('line one\nline two'), false);
});

test('isJsonlContent: returns true for JSON objects on each line', () => {
        const content = '{"a":1}\n{"b":2}';
        assert.equal(isJsonlContent(content), true);
});

// ── isUuidPointerFile ───────────────────────────────────────────────────

test('isUuidPointerFile: returns true for valid UUID', () => {
        assert.equal(isUuidPointerFile('550e8400-e29b-41d4-a716-446655440000'), true);
});

test('isUuidPointerFile: returns true for uppercase UUID', () => {
        assert.equal(isUuidPointerFile('550E8400-E29B-41D4-A716-446655440000'), true);
});

test('isUuidPointerFile: returns true for UUID with whitespace', () => {
        assert.equal(isUuidPointerFile('  550e8400-e29b-41d4-a716-446655440000  \n'), true);
});

test('isUuidPointerFile: returns false for non-UUID content', () => {
        assert.equal(isUuidPointerFile('not a uuid'), false);
        assert.equal(isUuidPointerFile('{"requests":[]}'), false);
        assert.equal(isUuidPointerFile(''), false);
});

// ── getModelTier ────────────────────────────────────────────────────────

test('getModelTier: returns standard for multiplier 0', () => {
        const pricing = { 'gpt-4o-mini': { inputCostPerMillion: 0.15, outputCostPerMillion: 0.6, multiplier: 0 } };
        assert.equal(getModelTier('gpt-4o-mini', pricing), 'standard');
});

test('getModelTier: returns premium for multiplier > 0', () => {
        const pricing = { 'claude-sonnet-4.5': { inputCostPerMillion: 3, outputCostPerMillion: 15, multiplier: 1 } };
        assert.equal(getModelTier('claude-sonnet-4.5', pricing), 'premium');
});

test('getModelTier: returns unknown for model not in pricing', () => {
        assert.equal(getModelTier('unknown-model', {}), 'unknown');
});

test('getModelTier: falls back to partial match', () => {
        const pricing = { 'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10, multiplier: 1 } };
        assert.equal(getModelTier('gpt-4o-2024-08-06', pricing), 'premium');
});

// ── calculateEstimatedCost ──────────────────────────────────────────────

test('calculateEstimatedCost: calculates correct cost for known model', () => {
        const modelUsage = { 'gpt-4o': { inputTokens: 1000, outputTokens: 500 } };
        const pricing = { 'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // input: 1000/1M * 2.5 = 0.0025, output: 500/1M * 10 = 0.005
        assert.ok(Math.abs(cost - 0.0075) < 0.0001);
});

test('calculateEstimatedCost: returns 0 for empty usage', () => {
        assert.equal(calculateEstimatedCost({}, {}), 0);
});

test('calculateEstimatedCost: uses fallback pricing for unknown models', () => {
        const modelUsage = { 'unknown-model': { inputTokens: 1000, outputTokens: 1000 } };
        const pricing = { 'gpt-4o-mini': { inputCostPerMillion: 0.15, outputCostPerMillion: 0.6 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // Falls back to gpt-4o-mini pricing: input 1000/1M*0.15 + output 1000/1M*0.6 = 0.00075
        assert.ok(cost > 0);
        assert.ok(Math.abs(cost - 0.00075) < 0.0001);
});

test('calculateEstimatedCost: copilot source uses copilotPricing block when present', () => {
        const modelUsage = { 'gpt-x': { inputTokens: 1_000_000, outputTokens: 1_000_000 } };
        const pricing = {
                'gpt-x': {
                        inputCostPerMillion: 1.0,
                        outputCostPerMillion: 2.0,
                        copilotPricing: { inputCostPerMillion: 5.0, outputCostPerMillion: 10.0 }
                }
        };
        const providerCost = calculateEstimatedCost(modelUsage, pricing);
        const copilotCost = calculateEstimatedCost(modelUsage, pricing, 'copilot');
        assert.ok(Math.abs(providerCost - 3.0) < 1e-9);   // 1 + 2
        assert.ok(Math.abs(copilotCost - 15.0) < 1e-9);   // 5 + 10
});

test('calculateEstimatedCost: copilot source falls back to provider pricing when copilotPricing missing', () => {
        const modelUsage = { 'gpt-y': { inputTokens: 1_000_000, outputTokens: 1_000_000 } };
        const pricing = { 'gpt-y': { inputCostPerMillion: 1.0, outputCostPerMillion: 2.0 } };
        const providerCost = calculateEstimatedCost(modelUsage, pricing);
        const copilotCost = calculateEstimatedCost(modelUsage, pricing, 'copilot');
        assert.equal(providerCost, copilotCost);
});

test('calculateEstimatedCost: copilot source applies cached + cache-creation rates from copilotPricing', () => {
        const modelUsage = {
                'claude-x': {
                        inputTokens: 1_000_000,         // total input
                        outputTokens: 1_000_000,
                        cachedReadTokens: 400_000,
                        cacheCreationTokens: 100_000
                }
        };
        const pricing = {
                'claude-x': {
                        inputCostPerMillion: 3.0,
                        cachedInputCostPerMillion: 0.3,
                        cacheCreationCostPerMillion: 3.75,
                        outputCostPerMillion: 15.0,
                        copilotPricing: {
                                inputCostPerMillion: 6.0,
                                cachedInputCostPerMillion: 0.6,
                                cacheCreationCostPerMillion: 7.5,
                                outputCostPerMillion: 30.0
                        }
                }
        };
        const cost = calculateEstimatedCost(modelUsage, pricing, 'copilot');
        // uncached = 500_000 → 0.5*6 = 3.0
        // cached read = 400_000 → 0.4*0.6 = 0.24
        // cache creation = 100_000 → 0.1*7.5 = 0.75
        // output = 1_000_000 → 1.0*30 = 30.0
        // total = 33.99
        assert.ok(Math.abs(cost - 33.99) < 1e-9);
});

// ── getTotalTokensFromModelUsage ────────────────────────────────────────

test('getTotalTokensFromModelUsage: sums input and output across models', () => {
        const usage = {
                'gpt-4o': { inputTokens: 100, outputTokens: 200 },
                'claude-sonnet': { inputTokens: 50, outputTokens: 150 }
        };
        assert.equal(getTotalTokensFromModelUsage(usage), 500);
});

test('getTotalTokensFromModelUsage: returns 0 for empty usage', () => {
        assert.equal(getTotalTokensFromModelUsage({}), 0);
});

// ── getModelFromRequest ─────────────────────────────────────────────────

test('getModelFromRequest: extracts modelId with copilot/ prefix', () => {
        assert.equal(getModelFromRequest({ modelId: 'copilot/gpt-4o' }), 'gpt-4o');
});

test('getModelFromRequest: extracts modelId without prefix', () => {
        assert.equal(getModelFromRequest({ modelId: 'claude-sonnet-4.5' }), 'claude-sonnet-4.5');
});

test('getModelFromRequest: falls back to result.metadata.modelId', () => {
        const req = { result: { metadata: { modelId: 'copilot/gpt-4o-mini' } } };
        assert.equal(getModelFromRequest(req), 'gpt-4o-mini');
});

// ── createEmptyContextRefs ──────────────────────────────────────────────

test('createEmptyContextRefs: returns object with all zero counts', () => {
        const refs = createEmptyContextRefs();
        assert.equal(refs.file, 0);
        assert.equal(refs.selection, 0);
        assert.equal(refs.codebase, 0);
        assert.equal(refs.terminal, 0);
        assert.equal(refs.clipboard, 0);
        assert.deepEqual(refs.byKind, {});
        assert.deepEqual(refs.byPath, {});
});
// ── Round 2: estimateTokensFromText deeper coverage ─────────────────────

test('estimateTokensFromText: model key match strips hyphen for lookup', () => {
        // e.g. 'gpt4' should match estimator key 'gpt-4' via replace('-','')
        const estimators = { 'gpt-4': 0.5 };
        const result = estimateTokensFromText('abcdefgh', 'gpt4', estimators);
        assert.equal(result, 4); // 8 * 0.5
});

test('estimateTokensFromText: uses first matching estimator key and breaks', () => {
        // Ensure the break fires — only first match used
        const estimators = { 'claude': 0.5, 'claude-sonnet': 0.1 };
        const r1 = estimateTokensFromText('abcdefgh', 'claude-sonnet', estimators);
        const r2 = estimateTokensFromText('abcdefgh', 'other', estimators);
        assert.equal(r1, 4);   // matches 'claude' first (0.5), not 'claude-sonnet' (0.1)
        assert.equal(r2, 2);   // no match → default 0.25 → ceil(8*0.25)=2
});

test('normalizeDisplayModelName: trims whitespace before lowercasing', () => {
        assert.equal(normalizeDisplayModelName('  Claude  '), 'claude');
});

test('normalizeDisplayModelName: collapses multiple spaces to single hyphen', () => {
        // /\s+/g replaces runs of whitespace with a single '-'
        assert.equal(normalizeDisplayModelName('Claude  Sonnet  4.5'), 'claude-sonnet-4.5');
});

// ── Round 2: extractSubAgentData deeper coverage ─────────────────────────

test('extractSubAgentData: returns null for non-subagent toolInvocationSerialized', () => {
        const item = { kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'other' } };
        assert.equal(extractSubAgentData(item), null);
});

test('extractSubAgentData: returns null when toolSpecificData is missing', () => {
        const item = { kind: 'toolInvocationSerialized' };
        assert.equal(extractSubAgentData(item), null);
});

test('extractSubAgentData: returns null when toolSpecificData is not an object', () => {
        const item = { kind: 'toolInvocationSerialized', toolSpecificData: 'string' };
        assert.equal(extractSubAgentData(item), null);
});

test('extractSubAgentData: returns null when both prompt and result are empty', () => {
        const item = {
                kind: 'toolInvocationSerialized',
                toolSpecificData: { kind: 'subagent', prompt: '', result: '' }
        };
        assert.equal(extractSubAgentData(item), null);
});

test('extractSubAgentData: returns result when only result is non-empty', () => {
        const item = {
                kind: 'toolInvocationSerialized',
                toolSpecificData: { kind: 'subagent', prompt: '', result: 'done' }
        };
        const out = extractSubAgentData(item);
        assert.ok(out !== null);
        assert.equal(out!.result, 'done');
        assert.equal(out!.prompt, '');
});

test('extractSubAgentData: prompt defaults to empty string when non-string', () => {
        const item = {
                kind: 'toolInvocationSerialized',
                toolSpecificData: { kind: 'subagent', prompt: 42, result: 'answer' }
        };
        const out = extractSubAgentData(item);
        assert.ok(out !== null);
        assert.equal(out!.prompt, '');
        assert.equal(out!.result, 'answer');
});

test('extractSubAgentData: streaming result object with non-numeric keys filtered', () => {
        const item = {
                kind: 'toolInvocationSerialized',
                toolSpecificData: {
                        kind: 'subagent',
                        prompt: 'q',
                        result: { 0: 'H', 1: 'i', foo: 123 }
                }
        };
        const out = extractSubAgentData(item);
        assert.ok(out !== null);
        assert.equal(out!.result, 'Hi'); // non-string values map to ''
});

test('extractSubAgentData: result object with non-string values becomes empty strings', () => {
        const item = {
                kind: 'toolInvocationSerialized',
                toolSpecificData: {
                        kind: 'subagent',
                        prompt: 'q',
                        result: { 0: 'A', 1: null, 2: 'B' }
                }
        };
        const out = extractSubAgentData(item);
        assert.ok(out !== null);
        assert.equal(out!.result, 'AB'); // null becomes ''
});

// ── Round 2: estimateTokensFromJsonlSession ──────────────────────────────

import { estimateTokensFromJsonlSession } from '../../src/tokenEstimation';

test('estimateTokensFromJsonlSession: counts user.message tokens', () => {
        const content = JSON.stringify({ type: 'user.message', data: { content: 'hello there' } });
        const result = estimateTokensFromJsonlSession(content);
        assert.ok(result.tokens > 0);
});

test('estimateTokensFromJsonlSession: counts assistant.message tokens', () => {
        const content = JSON.stringify({ type: 'assistant.message', data: { content: 'the answer is yes' } });
        const result = estimateTokensFromJsonlSession(content);
        assert.ok(result.tokens > 0);
});

test('estimateTokensFromJsonlSession: counts tool.result tokens', () => {
        const content = JSON.stringify({ type: 'tool.result', data: { output: 'tool output data' } });
        const result = estimateTokensFromJsonlSession(content);
        assert.ok(result.tokens > 0);
});

test('estimateTokensFromJsonlSession: uses session.shutdown actual tokens', () => {
        const events = [
                JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
                JSON.stringify({
                        type: 'session.shutdown',
                        data: {
                                modelMetrics: {
                                        'gpt-4o': { usage: { inputTokens: 100, outputTokens: 200 } }
                                }
                        }
                })
        ].join('\n');
        const result = estimateTokensFromJsonlSession(events);
        // session.shutdown actual tokens should take precedence
        assert.equal(result.actualTokens, 300);
});

test('estimateTokensFromJsonlSession: skips blank lines without crashing', () => {
        const content = '\n\n' + JSON.stringify({ type: 'user.message', data: { content: 'hi' } }) + '\n\n';
        const result = estimateTokensFromJsonlSession(content);
        assert.ok(result.tokens > 0);
});

test('estimateTokensFromJsonlSession: handles empty string', () => {
        const result = estimateTokensFromJsonlSession('');
        assert.equal(result.tokens, 0);
        assert.equal(result.thinkingTokens, 0);
        assert.equal(result.actualTokens, 0);
});

test('estimateTokensFromJsonlSession: session.shutdown handles non-numeric usage fields', () => {
        const events = [
                JSON.stringify({
                        type: 'session.shutdown',
                        data: {
                                modelMetrics: {
                                        'gpt-4o': { usage: { inputTokens: 'bad', outputTokens: 50 } }
                                }
                        }
                })
        ].join('\n');
        const result = estimateTokensFromJsonlSession(events);
        // inputTokens is non-numeric → defaults to 0; outputTokens = 50
        assert.equal(result.actualTokens, 50);
});