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