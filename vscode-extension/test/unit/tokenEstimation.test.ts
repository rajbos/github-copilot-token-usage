import test from 'node:test';
import * as assert from 'node:assert/strict';

import { extractSubAgentData, normalizeDisplayModelName, extractResponseItemText } from '../../../src/tokenEstimation';
import { isCopilotAutoRequest, attachEstimatedTurnCosts } from '../../../src/tokenEstimation';
import type { ChatTurn, ModelUsage } from '../../../src/types';
import { getPricingSourceForEditor } from '../../../src/chartDataBuilder';

const autoPricing = { 'gpt-4o': {
	inputCostPerMillion: 20, outputCostPerMillion: 40, cachedInputCostPerMillion: 1,
	copilotPricing: { inputCostPerMillion: 2, outputCostPerMillion: 4 },
} };

test('Auto discount: only the eligible Copilot token subset gets 10% off', () => {
	const manual = { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 1 };
	const auto = { ...manual, autoRouting: { inputTokens: 1_000_000, outputTokens: 1_000_000 } };
	assert.equal(calculateEstimatedCost({ 'gpt-4o': auto }, autoPricing, 'copilot'), 5.4);
	assert.equal(calculateEstimatedCost({ 'gpt-4o': manual }, autoPricing, 'copilot'), 6);
	assert.equal(calculateEstimatedCost({ 'gpt-4o': auto }, autoPricing, 'provider'), 60);
	const mixed = { ...auto, inputTokens: 2_000_000, outputTokens: 3_000_000 };
	assert.equal(calculateEstimatedCost({ 'gpt-4o': mixed }, autoPricing, 'copilot'), 15.4);
	assert.equal(calculateEstimatedCost({ 'gpt-4o': mixed }, autoPricing), 160);
	assert.equal(calculateEstimatedCost({ 'gpt-4o': auto }, { 'gpt-4o': { inputCostPerMillion: 20, outputCostPerMillion: 40 } }, 'copilot'), 60);
});

test('Auto discount: cache subset uses only Copilot rates and their fallbacks', () => {
	const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 500_000 };
	const usage = { 'gpt-4o': { ...tokens, autoRouting: tokens, sessions: 1 } };
	// Copilot has no cache rate: use its $2 input rate, not the provider's $1 cache rate.
	assert.equal(calculateEstimatedCost(usage, autoPricing, 'copilot'), 5.4);
	const pricing = { 'gpt-4o': { ...autoPricing['gpt-4o'], copilotPricing: {
		inputCostPerMillion: 2, outputCostPerMillion: 4, cachedInputCostPerMillion: 0.2,
		cacheCreationCostPerMillion: 3, cacheCreation1hCostPerMillion: 5,
	} } };
	const cached = { ...tokens, cacheCreationTokens: 200_000, cacheCreation1hTokens: 100_000 };
	const autoUsage: ModelUsage = { 'gpt-4o': { ...cached, autoRouting: cached, sessions: 1 } };
	assert.ok(Math.abs(calculateEstimatedCost(autoUsage, pricing, 'copilot') - 5.5 * 0.9) < 1e-12);
});

test('Auto detection and resolution use request evidence, not unrelated auto strings', () => {
	for (const modelId of ['auto', 'copilot/auto']) {
		const request = { modelId, result: { metadata: { modelId: 'gpt-4o' } } };
		assert.equal(isCopilotAutoRequest(request), true);
		assert.equal(getModelFromRequest(request), 'gpt-4o');
	}
	const response = [{ kind: 'autoModeResolution', resolved: { id: 'copilot/gpt-4o', name: 'GPT-4o' } }];
	assert.equal(isCopilotAutoRequest({ response }), true);
	assert.equal(getModelFromRequest({ response }), 'gpt-4o');
	assert.equal(getModelFromRequest({ modelId: 'auto' }), 'auto');
	assert.equal(isCopilotAutoRequest({ modelId: 'customendpoint/kiro/auto' }), false);
	assert.equal(isCopilotAutoRequest({ modelId: 'gpt-4o' }), false);
	assert.equal(isCopilotAutoRequest({ response: [null, {}, { kind: 'markdownContent', value: 'auto' }] }), false);
	assert.equal(getModelFromRequest({ response: [{ kind: 'autoModeResolution', resolved: null }] }), 'auto');
});

test('Steps Overview costs: Auto actual usage discounted, manual/provider and child calls unchanged', () => {
	const makeTurn = (autoRouted: boolean): ChatTurn => ({
		turnNumber: 1, timestamp: null, mode: 'agent', userMessage: '', assistantResponse: '',
		model: 'gpt-4o', autoRouted, contextReferences: createEmptyContextRefs(), mcpTools: [],
		inputTokensEstimate: 1, outputTokensEstimate: 1, thinkingTokensEstimate: 0,
		actualUsage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
		toolCalls: [{ toolName: 'runSubagent', isSubAgent: true, subAgentModel: 'gpt-4o', subAgentTokens: { input: 1_000_000, output: 1_000_000 } }],
	});
	const turns = [makeTurn(true), makeTurn(false)];
	attachEstimatedTurnCosts(turns, autoPricing, getPricingSourceForEditor('VS Code'));
	assert.equal(turns[0].estimatedCost, 5.4);
	assert.equal(turns[1].estimatedCost, 6);
	assert.equal(turns[0].toolCalls[0].subAgentCost, 6);
	const provider = makeTurn(true);
	attachEstimatedTurnCosts([provider], autoPricing, getPricingSourceForEditor('Claude Code'));
	assert.equal(provider.estimatedCost, 60);
	const estimated = makeTurn(true);
	delete estimated.actualUsage;
	estimated.inputTokensEstimate = 1_000_000;
	estimated.outputTokensEstimate = 1_000_000;
	attachEstimatedTurnCosts([estimated], autoPricing, 'copilot');
	assert.equal(estimated.estimatedCost, 5.4);
	const unknown = { ...makeTurn(true), model: 'auto' };
	attachEstimatedTurnCosts([unknown], autoPricing, 'copilot');
	assert.equal(unknown.estimatedCost, undefined);
});

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

// ── extractResponseItemText ──────────────────────────────────────────────

test('extractResponseItemText: null returns empty non-thinking', () => {
	const result = extractResponseItemText(null);
	assert.equal(result.text, '');
	assert.equal(result.isThinking, false);
});

test('extractResponseItemText: non-object returns empty non-thinking', () => {
	assert.deepEqual(extractResponseItemText('string'), { text: '', isThinking: false });
	assert.deepEqual(extractResponseItemText(42), { text: '', isThinking: false });
	assert.deepEqual(extractResponseItemText(undefined), { text: '', isThinking: false });
});

test('extractResponseItemText: thinking item returns isThinking=true with text', () => {
	const result = extractResponseItemText({ kind: 'thinking', value: 'extended reasoning here' });
	assert.equal(result.text, 'extended reasoning here');
	assert.equal(result.isThinking, true);
});

test('extractResponseItemText: thinking item with empty value returns empty string', () => {
	const result = extractResponseItemText({ kind: 'thinking', value: '' });
	assert.equal(result.text, '');
	assert.equal(result.isThinking, true);
});

test('extractResponseItemText: prefers content.value over value to avoid double-counting', () => {
	const result = extractResponseItemText({ kind: 'markdownContent', value: 'WRAPPER', content: { value: 'ACTUAL' } });
	assert.equal(result.text, 'ACTUAL');
	assert.equal(result.isThinking, false);
});

test('extractResponseItemText: falls back to value when content.value is empty', () => {
	const result = extractResponseItemText({ kind: 'markdownContent', value: 'fallback', content: { value: '' } });
	assert.equal(result.text, 'fallback');
	assert.equal(result.isThinking, false);
});

test('extractResponseItemText: uses value when no content property', () => {
	const result = extractResponseItemText({ kind: 'markdownContent', value: 'response text' });
	assert.equal(result.text, 'response text');
	assert.equal(result.isThinking, false);
});

test('extractResponseItemText: content.value works for any kind, not just markdownContent', () => {
	const result = extractResponseItemText({ kind: 'otherKind', value: 'WRAPPER', content: { value: 'INNER' } });
	assert.equal(result.text, 'INNER');
	assert.equal(result.isThinking, false);
});

test('extractResponseItemText: returns empty for item with no text fields', () => {
	const result = extractResponseItemText({ kind: 'toolInvocationSerialized', toolId: 'someTool' });
	assert.equal(result.text, '');
	assert.equal(result.isThinking, false);
});



import {
        estimateTokensFromText,
        isJsonlContent,
        isUuidPointerFile,
        getModelTier,
        calculateEstimatedCost,
        getTotalTokensFromModelUsage,
        getModelFromRequest,
        createEmptyContextRefs
} from '../../../src/tokenEstimation';

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

test('getModelTier: returns standard for tier "standard"', () => {
        const pricing = { 'gpt-4o-mini': { inputCostPerMillion: 0.15, outputCostPerMillion: 0.6, tier: 'standard' as const } };
        assert.equal(getModelTier('gpt-4o-mini', pricing), 'standard');
});

test('getModelTier: returns premium for tier "premium"', () => {
        const pricing = { 'claude-sonnet-4.5': { inputCostPerMillion: 3, outputCostPerMillion: 15, tier: 'premium' as const } };
        assert.equal(getModelTier('claude-sonnet-4.5', pricing), 'premium');
});

test('getModelTier: returns unknown for model not in pricing', () => {
        assert.equal(getModelTier('unknown-model', {}), 'unknown');
});

test('getModelTier: falls back to partial match', () => {
        const pricing = { 'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10, tier: 'premium' as const } };
        assert.equal(getModelTier('gpt-4o-2024-08-06', pricing), 'premium');
});

// ── calculateEstimatedCost ──────────────────────────────────────────────

test('calculateEstimatedCost: calculates correct cost for known model', () => {
        const modelUsage = { 'gpt-4o': { inputTokens: 1000, outputTokens: 500, sessions: 0} };
        const pricing = { 'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // input: 1000/1M * 2.5 = 0.0025, output: 500/1M * 10 = 0.005
        assert.ok(Math.abs(cost - 0.0075) < 0.0001);
});

test('calculateEstimatedCost: returns 0 for empty usage', () => {
        assert.equal(calculateEstimatedCost({}, {}), 0);
});

test('calculateEstimatedCost: unknown models contribute $0 (no gpt-4o-mini fallback)', () => {
        const modelUsage = { 'unknown-model': { inputTokens: 1000, outputTokens: 1000, sessions: 0} };
        const pricing = { 'gpt-4o-mini': { inputCostPerMillion: 0.15, outputCostPerMillion: 0.6 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // No pricing entry for 'unknown-model' → $0, not gpt-4o-mini rates
        assert.equal(cost, 0);
});

test('calculateEstimatedCost: prices a custom-endpoint model from its model-ID part', () => {
        const modelUsage = { 'customendpoint/Mistral/mistral-medium-latest': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 0} };
        const pricing = { 'mistral-medium-latest': { inputCostPerMillion: 0.4, outputCostPerMillion: 2.0 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        assert.ok(Math.abs(cost - 2.4) < 1e-9);
});

test('calculateEstimatedCost: custom-endpoint model with an unpriced model part stays $0', () => {
        const modelUsage = { 'customendpoint/Mistral/some-private-model': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 0} };
        const pricing = { 'mistral-medium-latest': { inputCostPerMillion: 0.4, outputCostPerMillion: 2.0 } };
        assert.equal(calculateEstimatedCost(modelUsage, pricing), 0);
});

test('calculateEstimatedCost: prices an org-UUID-prefixed catalog model from its model-ID part', () => {
        const modelUsage = { '83a386ed-9f05-4fd9-83d4-f453d20c994c/mistral-medium-latest': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 0} };
        const pricing = { 'mistral-medium-latest': { inputCostPerMillion: 0.4, outputCostPerMillion: 2.0 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        assert.ok(Math.abs(cost - 2.4) < 1e-9);
});

test('calculateEstimatedCost: prices a dash-separated version id from its dotted pricing key', () => {
        const modelUsage = { 'claude-opus-4-8': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 0} };
        const pricing = { 'claude-opus-4.8': { inputCostPerMillion: 5.0, outputCostPerMillion: 25.0 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        assert.ok(Math.abs(cost - 30.0) < 1e-9);
});

test('calculateEstimatedCost: UUID-prefixed model with an unpriced model part stays $0', () => {
        const modelUsage = { '83a386ed-9f05-4fd9-83d4-f453d20c994c/some-private-model': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 0} };
        const pricing = { 'mistral-medium-latest': { inputCostPerMillion: 0.4, outputCostPerMillion: 2.0 } };
        assert.equal(calculateEstimatedCost(modelUsage, pricing), 0);
});

test('calculateEstimatedCost: copilot source uses copilotPricing block when present', () => {
        const modelUsage = { 'gpt-x': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 0} };
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
        const modelUsage = { 'gpt-y': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 0} };
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
                        cacheCreationTokens: 100_000, sessions: 0}
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
                'gpt-4o': { inputTokens: 100, outputTokens: 200, sessions: 0},
                'claude-sonnet': { inputTokens: 50, outputTokens: 150, sessions: 0}
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

import { estimateTokensFromJsonlSession } from '../../../src/tokenEstimation';

test('estimateTokensFromJsonlSession: counts user.message tokens', () => {
        const content = JSON.stringify({ type: 'user.message', data: { content: 'hello there' } });
        const result = estimateTokensFromJsonlSession(content);
        assert.ok(result.tokens > 0);
});

test('estimateTokensFromJsonlSession: counts user.message_rendered tokens (JetBrains format)', () => {
        const renderedMessage = '<context>\nFile content here with lots of code...\n</context>\n\nwhats in this repo?';
        const events = [
                JSON.stringify({ type: 'user.message', data: { content: 'whats in this repo?', turnId: 'turn-1' } }),
                JSON.stringify({ type: 'user.message_rendered', data: { renderedMessage, turnId: 'turn-1' } }),
        ].join('\n');
        const result = estimateTokensFromJsonlSession(events);
        // Should count both user.message and user.message_rendered (rendered is the richer/longer form)
        const renderedResult = estimateTokensFromJsonlSession(
                JSON.stringify({ type: 'user.message_rendered', data: { renderedMessage } })
        );
        assert.ok(renderedResult.tokens > 0, 'user.message_rendered should contribute tokens');
        assert.ok(result.tokens >= renderedResult.tokens, 'Combined result should include rendered tokens');
});


test('estimateTokensFromJsonlSession: counts assistant.message tokens', () => {
        const content = JSON.stringify({ type: 'assistant.message', data: { content: 'the answer is yes' } });
        const result = estimateTokensFromJsonlSession(content);
        assert.ok(result.tokens > 0);
});

test('estimateTokensFromJsonlSession: does not count legacy tool.result tokens', () => {
        // tool.result is the old dead event type — it should no longer count
        const content = JSON.stringify({ type: 'tool.result', data: { output: 'tool output data' } });
        const result = estimateTokensFromJsonlSession(content);
        assert.equal(result.tokens, 0);
});

test('estimateTokensFromJsonlSession: counts tool.execution_complete content tokens', () => {
        const content = JSON.stringify({
                type: 'tool.execution_complete',
                data: { result: { content: 'file contents here' } }
        });
        const result = estimateTokensFromJsonlSession(content);
        assert.ok(result.tokens > 0);
});

test('estimateTokensFromJsonlSession: prefers detailedContent over content in tool.execution_complete', () => {
        const shortContent = 'short';
        const longDetailedContent = 'a'.repeat(400); // much longer — should give more tokens
        const eventWithBoth = JSON.stringify({
                type: 'tool.execution_complete',
                data: { result: { content: shortContent, detailedContent: longDetailedContent } }
        });
        const eventWithShort = JSON.stringify({
                type: 'tool.execution_complete',
                data: { result: { content: shortContent } }
        });
        const resultBoth = estimateTokensFromJsonlSession(eventWithBoth);
        const resultShort = estimateTokensFromJsonlSession(eventWithShort);
        assert.ok(resultBoth.tokens > resultShort.tokens, 'detailedContent should be used when present');
});

test('estimateTokensFromJsonlSession: skips tool.execution_complete when result is missing', () => {
        const content = JSON.stringify({ type: 'tool.execution_complete', data: {} });
        const result = estimateTokensFromJsonlSession(content);
        assert.equal(result.tokens, 0);
});

test('estimateTokensFromJsonlSession: uses session.shutdown actual tokens', () => {
        const events = [
                JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
                JSON.stringify({
                        type: 'session.shutdown',
                        data: {
                                modelMetrics: {
                                        'gpt-4o': { usage: { inputTokens: 100, outputTokens: 200, sessions: 0} }
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
                                        'gpt-4o': { usage: { inputTokens: 'bad', outputTokens: 50, sessions: 0} }
                                }
                        }
                })
        ].join('\n');
        const result = estimateTokensFromJsonlSession(events);
        // inputTokens is non-numeric → defaults to 0; outputTokens = 50
        assert.equal(result.actualTokens, 50);
});

test('estimateTokensFromJsonlSession: session.shutdown propagates cacheReadTokens/cacheWriteTokens to per-model usage', () => {
        // Real CLI sessions report inputTokens as the TOTAL (uncached + reads + writes).
        // The cache breakdown must propagate so calculateEstimatedCost can apply discount rates;
        // otherwise every token is charged at full input rate, vastly overstating Claude costs.
        const events = JSON.stringify({
                type: 'session.shutdown',
                data: {
                        modelMetrics: {
                                'claude-sonnet-4.6': {
                                        usage: {
                                                inputTokens: 1_000_000,
                                                outputTokens: 5_000,
                                                cacheReadTokens: 900_000,
                                                cacheWriteTokens: 50_000,
                                        },
                                },
                        },
                },
        });
        const result = estimateTokensFromJsonlSession(events);
        const usage = result.modelUsage['claude-sonnet-4.6'];
        assert.ok(usage, 'claude-sonnet-4.6 modelUsage entry should exist');
        assert.equal(usage.inputTokens, 1_000_000);
        assert.equal(usage.outputTokens, 5_000);
        assert.equal(usage.cachedReadTokens, 900_000);
        assert.equal(usage.cacheCreationTokens, 50_000);
});

test('estimateTokensFromJsonlSession: session.shutdown without cache fields leaves cache breakdown undefined', () => {
        const events = JSON.stringify({
                type: 'session.shutdown',
                data: {
                        modelMetrics: {
                                'gpt-5.4': { usage: { inputTokens: 100, outputTokens: 50, sessions: 0} },
                        },
                },
        });
        const result = estimateTokensFromJsonlSession(events);
        const usage = result.modelUsage['gpt-5.4'];
        assert.ok(usage);
        assert.equal(usage.cachedReadTokens, undefined);
        assert.equal(usage.cacheCreationTokens, undefined);
});

// ── extractCachedTokensFromDebugLog ──────────────────────────────────────

import { extractCachedTokensFromDebugLog } from '../../../src/tokenEstimation';

test('extractCachedTokensFromDebugLog: sums cachedTokens from llm_request events', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 5000 } }),
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 3000 } }),
        ].join('\n');
        assert.equal(extractCachedTokensFromDebugLog(lines), 8000);
});

test('extractCachedTokensFromDebugLog: returns 0 for empty content', () => {
        assert.equal(extractCachedTokensFromDebugLog(''), 0);
});

test('extractCachedTokensFromDebugLog: ignores non-llm_request events', () => {
        const lines = [
                JSON.stringify({ type: 'request_start', attrs: { cachedTokens: 9999 } }),
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 100 } }),
                JSON.stringify({ type: 'request_end', attrs: {} }),
        ].join('\n');
        assert.equal(extractCachedTokensFromDebugLog(lines), 100);
});

test('extractCachedTokensFromDebugLog: ignores llm_request events without cachedTokens', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 1000, outputTokens: 200, sessions: 0} }),
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 50 } }),
        ].join('\n');
        assert.equal(extractCachedTokensFromDebugLog(lines), 50);
});

test('extractCachedTokensFromDebugLog: skips invalid JSON lines without crashing', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 200 } }),
                'not valid json {{{',
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 300 } }),
        ].join('\n');
        assert.equal(extractCachedTokensFromDebugLog(lines), 500);
});

test('extractCachedTokensFromDebugLog: handles CRLF line endings', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 1000 } }),
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 2000 } }),
        ].join('\r\n');
        assert.equal(extractCachedTokensFromDebugLog(lines), 3000);
});

test('extractCachedTokensFromDebugLog: ignores non-numeric cachedTokens values', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 'lots' } }),
                JSON.stringify({ type: 'llm_request', attrs: { cachedTokens: 100 } }),
        ].join('\n');
        assert.equal(extractCachedTokensFromDebugLog(lines), 100);
});

// ── extractAllTokensFromDebugLog ──────────────────────────────────────────

import { extractAllTokensFromDebugLog } from '../../../src/tokenEstimation';

test('extractAllTokensFromDebugLog: sums all token fields across llm_request events', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 21224, outputTokens: 636, cachedTokens: 5000 } }),
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 22327, outputTokens: 101, cachedTokens: 3000 } }),
        ].join('\n');
        const result = extractAllTokensFromDebugLog(lines);
        assert.ok(result);
        assert.equal(result.inputTokens, 43551);
        assert.equal(result.outputTokens, 737);
        assert.equal(result.cachedTokens, 8000);
        assert.equal(result.modelTurns, 2);
});

test('extractAllTokensFromDebugLog: returns null for empty content', () => {
        assert.equal(extractAllTokensFromDebugLog(''), null);
});

test('extractAllTokensFromDebugLog: returns null when no llm_request events exist', () => {
        const lines = [
                JSON.stringify({ type: 'request_start', attrs: { inputTokens: 100 } }),
                JSON.stringify({ type: 'request_end', attrs: {} }),
        ].join('\n');
        assert.equal(extractAllTokensFromDebugLog(lines), null);
});

test('extractAllTokensFromDebugLog: handles missing optional fields gracefully', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 1000 } }),
                JSON.stringify({ type: 'llm_request', attrs: { outputTokens: 200 } }),
        ].join('\n');
        const result = extractAllTokensFromDebugLog(lines);
        assert.ok(result);
        assert.equal(result.inputTokens, 1000);
        assert.equal(result.outputTokens, 200);
        assert.equal(result.cachedTokens, 0);
        assert.equal(result.modelTurns, 2);
});

test('extractAllTokensFromDebugLog: ignores non-llm_request events', () => {
        const lines = [
                JSON.stringify({ type: 'request_start', attrs: { inputTokens: 9999 } }),
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 500, outputTokens: 100, sessions: 0} }),
                JSON.stringify({ type: 'request_end', attrs: {} }),
        ].join('\n');
        const result = extractAllTokensFromDebugLog(lines);
        assert.ok(result);
        assert.equal(result.inputTokens, 500);
        assert.equal(result.outputTokens, 100);
        assert.equal(result.modelTurns, 1);
});

test('extractAllTokensFromDebugLog: skips invalid JSON lines without crashing', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 300, outputTokens: 50, sessions: 0} }),
                'not valid json {{{',
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 200, outputTokens: 30, sessions: 0} }),
        ].join('\n');
        const result = extractAllTokensFromDebugLog(lines);
        assert.ok(result);
        assert.equal(result.inputTokens, 500);
        assert.equal(result.outputTokens, 80);
        assert.equal(result.modelTurns, 2);
});

test('extractAllTokensFromDebugLog: extractCachedTokensFromDebugLog still works via delegation', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 1000, outputTokens: 200, cachedTokens: 5000 } }),
                JSON.stringify({ type: 'llm_request', attrs: { inputTokens: 2000, outputTokens: 100, cachedTokens: 3000 } }),
        ].join('\n');
        assert.equal(extractCachedTokensFromDebugLog(lines), 8000);
});

// ── Strategy pattern: selectTokenEstimationStrategy ────────────────────────

import { DeltaTokenStrategy, EventJsonlTokenStrategy, selectTokenEstimationStrategy } from '../../../src/tokenEstimation';

test('selectTokenEstimationStrategy: returns DeltaTokenStrategy for delta-based JSONL', () => {
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [] } }),
                JSON.stringify({ kind: 2, k: ['requests', 0], v: { message: { text: 'hello' } } }),
        ];
        const strategy = selectTokenEstimationStrategy(lines);
        assert.ok(strategy instanceof DeltaTokenStrategy);
});

test('selectTokenEstimationStrategy: returns EventJsonlTokenStrategy for CLI JSONL', () => {
        const lines = [
                JSON.stringify({ type: 'session.start', data: {} }),
                JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
        ];
        const strategy = selectTokenEstimationStrategy(lines);
        assert.ok(strategy instanceof EventJsonlTokenStrategy);
});

test('selectTokenEstimationStrategy: returns EventJsonlTokenStrategy for empty input', () => {
        const strategy = selectTokenEstimationStrategy([]);
        assert.ok(strategy instanceof EventJsonlTokenStrategy);
});

test('selectTokenEstimationStrategy: skips blank lines when detecting format', () => {
        const lines = ['', '   ', JSON.stringify({ kind: 0, v: {} })];
        const strategy = selectTokenEstimationStrategy(lines);
        assert.ok(strategy instanceof DeltaTokenStrategy);
});

// ── DeltaTokenStrategy: independently testable ─────────────────────────────

test('DeltaTokenStrategy: estimates tokens from kind:2 request message text', () => {
        // Real VS Code format: k=['requests'] with array v
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [] } }),
                JSON.stringify({ kind: 2, k: ['requests'], v: [{ message: { text: 'hello world from delta' } }] }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0);
});

test('DeltaTokenStrategy: extracts actual tokens from reconstructed state (promptTokens/outputTokens)', () => {
        // Put the result in kind:0 initial state so it's properly reconstructed
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [{ message: { text: 'q' }, result: { promptTokens: 100, outputTokens: 50 } }] } }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 150);
});

test('DeltaTokenStrategy: extracts actual tokens from result.metadata (Insiders format)', () => {
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [{ message: { text: 'q' }, result: { metadata: { promptTokens: 200, outputTokens: 80 } } }] } }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 280);
});

test('DeltaTokenStrategy: extracts actual tokens from result.usage (completionTokens)', () => {
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [{ message: { text: 'q' }, result: { usage: { promptTokens: 50, completionTokens: 30 } } }] } }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 80);
});

test('DeltaTokenStrategy: separates thinking tokens from kind:2 response', () => {
        // Use k=['requests', 0, 'response'] so k.includes('response') is true
        const lines = [
                JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'thinking', value: 'thinking text' }] }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.ok(result.thinkingTokens > 0);
        assert.equal(result.tokens, result.thinkingTokens, 'total tokens equals thinking-only tokens when there is no other content');
});

test('DeltaTokenStrategy: returns zero cacheReadTokens and empty modelUsage', () => {
        const lines = [JSON.stringify({ kind: 0, v: {} })];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.equal(result.cacheReadTokens, 0);
        assert.deepEqual(result.modelUsage, {});
        assert.deepEqual(result.dailyActualTokens, {});
});

test('DeltaTokenStrategy: handles empty lines gracefully', () => {
        const result = new DeltaTokenStrategy().estimate([]);
        assert.equal(result.tokens, 0);
        assert.equal(result.actualTokens, 0);
});

// ── EventJsonlTokenStrategy: independently testable ────────────────────────

test('EventJsonlTokenStrategy: counts user.message tokens', () => {
        const lines = [JSON.stringify({ type: 'user.message', data: { content: 'hello from cli' } })];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0);
});

test('EventJsonlTokenStrategy: counts user.message_rendered tokens (JetBrains)', () => {
        const lines = [JSON.stringify({ type: 'user.message_rendered', data: { renderedMessage: 'rendered with context' } })];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0);
});

test('EventJsonlTokenStrategy: counts assistant.message content tokens', () => {
        const lines = [JSON.stringify({ type: 'assistant.message', data: { content: 'the answer' } })];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0);
});

test('EventJsonlTokenStrategy: uses session.shutdown for actual tokens and model usage', () => {
        const lines = [
                JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
                JSON.stringify({
                        type: 'session.shutdown',
                        data: { modelMetrics: { 'gpt-4o': { usage: { inputTokens: 100, outputTokens: 200, sessions: 0} } } }
                }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 300);
        assert.ok(result.modelUsage['gpt-4o']);
        assert.equal(result.modelUsage['gpt-4o'].inputTokens, 100);
        assert.equal(result.modelUsage['gpt-4o'].outputTokens, 200);
});

test('EventJsonlTokenStrategy: copilotNanoAiu is the latest usage_checkpoint while the session runs', () => {
        const lines = [
                JSON.stringify({ type: 'session.start', data: {} }),
                JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 1_000_000_000 } }),
                JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 4_500_000_000 } }),
        ];
        assert.equal(new EventJsonlTokenStrategy().estimate(lines).copilotNanoAiu, 4_500_000_000);
});

test('EventJsonlTokenStrategy: copilotNanoAiu is a running total, not summed across resume/shutdown', () => {
        // totalNanoAiu is cumulative for the whole session and repeats in every checkpoint and
        // shutdown, including after session.resume, so adding events would double count.
        const shutdown = (nano: number) => JSON.stringify({
                type: 'session.shutdown',
                data: { totalNanoAiu: nano, modelMetrics: { 'gpt-4o': { usage: { inputTokens: 1, outputTokens: 1 } } } },
        });
        const lines = [
                JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 2_000_000_000 } }),
                shutdown(2_000_000_000),
                JSON.stringify({ type: 'session.resume', data: {} }),
                JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 3_000_000_000 } }),
                shutdown(3_000_000_000),
        ];
        assert.equal(new EventJsonlTokenStrategy().estimate(lines).copilotNanoAiu, 3_000_000_000);
});

test('EventJsonlTokenStrategy: extracts thinking tokens from assistant.message.reasoningText', () => {
        const lines = [JSON.stringify({ type: 'assistant.message', data: { reasoningText: 'thinking hard' } })];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.ok(result.thinkingTokens > 0);
});

test('EventJsonlTokenStrategy: extracts JetBrains thinking tokens from data.thinking.text', () => {
        const lines = [JSON.stringify({ type: 'assistant.message', data: { thinking: { text: 'deep thought' } } })];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.ok(result.thinkingTokens > 0);
});

test('EventJsonlTokenStrategy: counts tool.execution_complete content tokens', () => {
        const lines = [JSON.stringify({ type: 'tool.execution_complete', data: { result: { content: 'file contents here' } } })];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0);
});

test('EventJsonlTokenStrategy: attributes shutdown tokens to UTC day', () => {
        const ts = '2025-03-15T10:00:00.000Z';
        const lines = [
                JSON.stringify({
                        type: 'session.shutdown',
                        timestamp: ts,
                        data: { modelMetrics: { 'gpt-4o': { usage: { inputTokens: 50, outputTokens: 50, sessions: 0} } } }
                }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.dailyActualTokens['2025-03-15'], 100);
});

test('EventJsonlTokenStrategy: returns empty result for empty input', () => {
        const result = new EventJsonlTokenStrategy().estimate([]);
        assert.equal(result.tokens, 0);
        assert.equal(result.actualTokens, 0);
        assert.deepEqual(result.modelUsage, {});
});

// ── getRequestResult ────────────────────────────────────────────────────────

import { getRequestResult, getResponseArray } from '../../../src/tokenEstimation';

test('getRequestResult: returns undefined for null', () => {
        assert.equal(getRequestResult(null), undefined);
});

test('getRequestResult: returns undefined for non-object primitives', () => {
        assert.equal(getRequestResult(42), undefined);
        assert.equal(getRequestResult('string'), undefined);
        assert.equal(getRequestResult(undefined), undefined);
});

test('getRequestResult: returns undefined when result is missing', () => {
        assert.equal(getRequestResult({}), undefined);
        assert.equal(getRequestResult({ message: { text: 'hi' } }), undefined);
});

test('getRequestResult: returns undefined when result is not an object', () => {
        assert.equal(getRequestResult({ result: 'string' }), undefined);
        assert.equal(getRequestResult({ result: 42 }), undefined);
        assert.equal(getRequestResult({ result: null }), undefined);
});

test('getRequestResult: returns typed result for valid promptTokens/outputTokens shape', () => {
        const req = { result: { promptTokens: 100, outputTokens: 50 } };
        const result = getRequestResult(req);
        assert.ok(result !== undefined);
        assert.equal(result!.promptTokens, 100);
        assert.equal(result!.outputTokens, 50);
});

test('getRequestResult: returns typed result for Insiders metadata shape', () => {
        const req = { result: { metadata: { promptTokens: 200, outputTokens: 80 } } };
        const result = getRequestResult(req);
        assert.ok(result !== undefined);
        assert.ok(result!.metadata !== undefined);
        assert.equal(result!.metadata!.promptTokens, 200);
        assert.equal(result!.metadata!.outputTokens, 80);
});

test('getRequestResult: returns typed result for usage shape', () => {
        const req = { result: { usage: { promptTokens: 50, completionTokens: 30 } } };
        const result = getRequestResult(req);
        assert.ok(result !== undefined);
        assert.ok(result!.usage !== undefined);
        assert.equal(result!.usage!.promptTokens, 50);
        assert.equal(result!.usage!.completionTokens, 30);
});

// ── getResponseArray ────────────────────────────────────────────────────────

test('getResponseArray: returns undefined for null', () => {
        assert.equal(getResponseArray(null), undefined);
});

test('getResponseArray: returns undefined for non-object primitives', () => {
        assert.equal(getResponseArray(42), undefined);
        assert.equal(getResponseArray('string'), undefined);
        assert.equal(getResponseArray(undefined), undefined);
});

test('getResponseArray: returns undefined when response is missing', () => {
        assert.equal(getResponseArray({}), undefined);
        assert.equal(getResponseArray({ result: {} }), undefined);
});

test('getResponseArray: returns undefined when response is not an array', () => {
        assert.equal(getResponseArray({ response: 'not-array' }), undefined);
        assert.equal(getResponseArray({ response: 42 }), undefined);
        assert.equal(getResponseArray({ response: null }), undefined);
        assert.equal(getResponseArray({ response: {} }), undefined);
});

test('getResponseArray: returns the array when response is a valid array', () => {
        const items = [{ kind: 'markdownContent', value: 'hello' }, { kind: 'thinking', value: 'think' }];
        const result = getResponseArray({ response: items });
        assert.ok(Array.isArray(result));
        assert.equal(result!.length, 2);
        assert.deepEqual(result, items);
});

test('getResponseArray: returns empty array when response is []', () => {
        const result = getResponseArray({ response: [] });
        assert.ok(Array.isArray(result));
        assert.equal(result!.length, 0);
});

// ── applyDelta ──────────────────────────────────────────────────────────────

import { applyDelta } from '../../../src/tokenEstimation';

test('applyDelta: kind:0 replaces the entire state with v', () => {
        const initial = { requests: [{ id: 1 }] };
        const result = applyDelta(initial, { kind: 0, v: { requests: [] } });
        assert.deepEqual(result, { requests: [] });
});

test('applyDelta: kind:0 with null v replaces state with null', () => {
        const result = applyDelta({ a: 1 }, { kind: 0, v: null });
        assert.equal(result, null);
});

test('applyDelta: kind:1 sets a top-level field', () => {
        const state = { name: 'old' };
        const result = applyDelta(state, { kind: 1, k: ['name'], v: 'new' }) as Record<string, unknown>;
        assert.equal(result.name, 'new');
});

test('applyDelta: kind:1 sets nested field via multi-segment path', () => {
        const state = { a: { b: { c: 'original' } } };
        const result = applyDelta(state, { kind: 1, k: ['a', 'b', 'c'], v: 'updated' }) as Record<string, unknown>;
        const nested = (result.a as Record<string, unknown>).b as Record<string, unknown>;
        assert.equal(nested.c, 'updated');
});

test('applyDelta: kind:1 creates intermediate objects when missing', () => {
        const state = {};
        const result = applyDelta(state, { kind: 1, k: ['x', 'y'], v: 42 }) as Record<string, unknown>;
        assert.equal((result.x as Record<string, unknown>).y, 42);
});

test('applyDelta: kind:1 sets value on array container at numeric index', () => {
        const state = { items: ['a', 'b', 'c'] };
        const result = applyDelta(state, { kind: 1, k: ['items', '1'], v: 'B' }) as Record<string, unknown>;
        assert.deepEqual(result.items, ['a', 'B', 'c']);
});

test('applyDelta: kind:2 appends a single value to an array', () => {
        const state = { requests: [] };
        const result = applyDelta(state, { kind: 2, k: ['requests'], v: { id: 1 } }) as Record<string, unknown>;
        assert.deepEqual(result.requests, [{ id: 1 }]);
});

test('applyDelta: kind:2 spreads an array value into the target', () => {
        const state = { items: [1] };
        const result = applyDelta(state, { kind: 2, k: ['items'], v: [2, 3] }) as Record<string, unknown>;
        assert.deepEqual(result.items, [1, 2, 3]);
});

test('applyDelta: kind:2 creates array when target does not exist', () => {
        const state = {};
        const result = applyDelta(state, { kind: 2, k: ['response'], v: { kind: 'text', value: 'hi' } }) as Record<string, unknown>;
        assert.ok(Array.isArray(result.response));
        assert.equal((result.response as unknown[]).length, 1);
});

test('applyDelta: kind:2 appends to nested path in existing array', () => {
        const state = { requests: [{ response: [] }] };
        const result = applyDelta(state, { kind: 2, k: ['requests', '0', 'response'], v: { kind: 'text' } }) as Record<string, unknown>;
        const req = (result.requests as unknown[])[0] as Record<string, unknown>;
        assert.equal((req.response as unknown[]).length, 1);
});

test('applyDelta: non-object delta returns state unchanged', () => {
        const state = { a: 1 };
        assert.deepEqual(applyDelta(state, 'not an object'), state);
        assert.deepEqual(applyDelta(state, null), state);
        assert.deepEqual(applyDelta(state, 42), state);
});

test('applyDelta: empty k array returns state unchanged', () => {
        const state = { a: 1 };
        const result = applyDelta(state, { kind: 1, k: [], v: 'x' });
        assert.deepEqual(result, state);
});

test('applyDelta: non-array k returns state unchanged', () => {
        const state = { a: 1 };
        const result = applyDelta(state, { kind: 1, k: 'not-array', v: 'x' });
        assert.deepEqual(result, state);
});

test('applyDelta: kind:2 on array container at numeric index', () => {
        const state = { requests: [[]] };
        const result = applyDelta(state, { kind: 2, k: ['requests', '0'], v: 'item' }) as Record<string, unknown>;
        assert.deepEqual(result.requests, [['item']]);
});

test('applyDelta: kind:2 with numeric last segment creates new array when slot is undefined', () => {
        // Lines 953-955: current is an array but current[idx] is not yet an array → create new []
        const state = { requests: [] }; // requests[0] is undefined, not an array
        const result = applyDelta(state, { kind: 2, k: ['requests', '0'], v: 'first' }) as Record<string, unknown>;
        // A fresh [] was created at requests[0], then 'first' was appended
        assert.ok(Array.isArray((result.requests as unknown[])[0]));
        assert.deepEqual((result.requests as unknown[])[0], ['first']);
});

test('applyDelta: kind:1 with null state creates new object', () => {
        const result = applyDelta(null, { kind: 1, k: ['field'], v: 'value' }) as Record<string, unknown>;
        assert.equal(result.field, 'value');
});

test('applyDelta: unknown kind returns root after traversal (no assignment)', () => {
        const state = { a: 'original' };
        const result = applyDelta(state, { kind: 99, k: ['a'], v: 'changed' }) as Record<string, unknown>;
        // kind 99 is not handled — root is returned but nothing assigned
        assert.ok(result !== null);
});

test('applyDelta: kind:2 reuses existing array at target slot', () => {
        const state = { items: [1, 2] };
        const result = applyDelta(state, { kind: 2, k: ['items'], v: 3 }) as Record<string, unknown>;
        assert.deepEqual(result.items, [1, 2, 3]);
});

// ── buildReasoningEffortTimeline ────────────────────────────────────────────

import { buildReasoningEffortTimeline } from '../../../src/tokenEstimation';

function makeModelWithEffort(effort: string): unknown {
        return {
                metadata: {
                        configurationSchema: {
                                properties: {
                                        reasoningEffort: { default: effort }
                                }
                        }
                }
        };
}

test('buildReasoningEffortTimeline: empty lines returns empty state', () => {
        const result = buildReasoningEffortTimeline([]);
        assert.equal(result.defaultEffort, null);
        assert.equal(result.switchCount, 0);
        assert.equal(result.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: kind:0 with selectedModel sets defaultEffort and currentEffort', () => {
        const delta = {
                kind: 0,
                v: { inputState: { selectedModel: makeModelWithEffort('medium') } }
        };
        const result = buildReasoningEffortTimeline([JSON.stringify(delta)]);
        assert.equal(result.defaultEffort, 'medium');
        assert.equal(result.switchCount, 0);
});

test('buildReasoningEffortTimeline: kind:0 without selectedModel leaves defaultEffort null', () => {
        const delta = { kind: 0, v: { inputState: {} } };
        const result = buildReasoningEffortTimeline([JSON.stringify(delta)]);
        assert.equal(result.defaultEffort, null);
});

test('buildReasoningEffortTimeline: kind:1 switching effort increments switchCount', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind1 = { kind: 1, k: ['inputState', 'selectedModel'], v: makeModelWithEffort('high') };
        const result = buildReasoningEffortTimeline([kind0, kind1].map(d => JSON.stringify(d)));
        assert.equal(result.defaultEffort, 'medium');
        assert.equal(result.switchCount, 1);
});

test('buildReasoningEffortTimeline: kind:1 with same effort does not increment switchCount', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind1 = { kind: 1, k: ['inputState', 'selectedModel'], v: makeModelWithEffort('medium') };
        const result = buildReasoningEffortTimeline([kind0, kind1].map(d => JSON.stringify(d)));
        assert.equal(result.switchCount, 0);
});

test('buildReasoningEffortTimeline: kind:1 before any kind:0 does not increment switchCount', () => {
        // currentEffort starts null; setting it to 'high' is not a switch
        const kind1 = { kind: 1, k: ['inputState', 'selectedModel'], v: makeModelWithEffort('high') };
        const result = buildReasoningEffortTimeline([JSON.stringify(kind1)]);
        assert.equal(result.switchCount, 0);
});

test('buildReasoningEffortTimeline: kind:1 with wrong path is ignored', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind1bad = { kind: 1, k: ['someOther', 'field'], v: makeModelWithEffort('high') };
        const result = buildReasoningEffortTimeline([kind0, kind1bad].map(d => JSON.stringify(d)));
        assert.equal(result.switchCount, 0);
});

test('buildReasoningEffortTimeline: kind:2 maps requestId to current effort', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('low') } } };
        const kind2 = { kind: 2, k: ['requests', 0], v: { requestId: 'req-abc', message: { text: 'hi' } } };
        const result = buildReasoningEffortTimeline([kind0, kind2].map(d => JSON.stringify(d)));
        assert.equal(result.effortByRequestId.get('req-abc'), 'low');
});

test('buildReasoningEffortTimeline: kind:2 without currentEffort does not add to map', () => {
        // No kind:0, so currentEffort is null
        const kind2 = { kind: 2, k: ['requests', 0], v: { requestId: 'req-xyz' } };
        const result = buildReasoningEffortTimeline([JSON.stringify(kind2)]);
        assert.equal(result.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: kind:2 without requestId is skipped', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind2 = { kind: 2, k: ['requests', 0], v: { message: { text: 'no requestId here' } } };
        const result = buildReasoningEffortTimeline([kind0, kind2].map(d => JSON.stringify(d)));
        assert.equal(result.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: kind:2 with non-string requestId is skipped', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind2 = { kind: 2, k: ['requests', 0], v: { requestId: 42 } };
        const result = buildReasoningEffortTimeline([kind0, kind2].map(d => JSON.stringify(d)));
        assert.equal(result.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: kind:2 with non-requests k[0] is skipped', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind2 = { kind: 2, k: ['response', 0], v: { requestId: 'req-1' } };
        const result = buildReasoningEffortTimeline([kind0, kind2].map(d => JSON.stringify(d)));
        assert.equal(result.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: kind:2 with non-numeric k[1] is skipped', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind2 = { kind: 2, k: ['requests', 'bad'], v: { requestId: 'req-1' } };
        const result = buildReasoningEffortTimeline([kind0, kind2].map(d => JSON.stringify(d)));
        assert.equal(result.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: blank lines and invalid JSON are skipped', () => {
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const lines = ['', '   ', 'not valid json {{{', JSON.stringify(kind0)];
        const result = buildReasoningEffortTimeline(lines);
        assert.equal(result.defaultEffort, 'medium');
});

test('buildReasoningEffortTimeline: multiple effort switches tracked correctly', () => {
        const lines = [
                { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('low') } } },
                { kind: 1, k: ['inputState', 'selectedModel'], v: makeModelWithEffort('medium') },
                { kind: 1, k: ['inputState', 'selectedModel'], v: makeModelWithEffort('high') },
        ].map(d => JSON.stringify(d));
        const result = buildReasoningEffortTimeline(lines);
        assert.equal(result.switchCount, 2);
        assert.equal(result.defaultEffort, 'low');
});

// ── extractPerRequestUsageFromRawLines ──────────────────────────────────────

import { extractPerRequestUsageFromRawLines } from '../../../src/tokenEstimation';

test('extractPerRequestUsageFromRawLines: returns empty map for empty input', () => {
        const result = extractPerRequestUsageFromRawLines([]);
        assert.equal(result.size, 0);
});

test('extractPerRequestUsageFromRawLines: returns empty map when no result lines', () => {
        const lines = [
                JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
                JSON.stringify({ kind: 0, v: {} }),
        ];
        const result = extractPerRequestUsageFromRawLines(lines);
        assert.equal(result.size, 0);
});

test('extractPerRequestUsageFromRawLines: extracts promptTokens + outputTokens from matching line', () => {
        // Construct a raw line that contains the k pattern and token counts
        // (This simulates a delta line that would fail JSON.parse but has regex-extractable data)
        const line = '{"kind":1,"k":["requests",0,"result"],"v":{"promptTokens":150,"outputTokens":75}}';
        const result = extractPerRequestUsageFromRawLines([line]);
        assert.ok(result.has(0));
        assert.equal(result.get(0)!.promptTokens, 150);
        assert.equal(result.get(0)!.outputTokens, 75);
});

test('extractPerRequestUsageFromRawLines: extracts completionTokens fallback', () => {
        const line = '{"kind":1,"k":["requests",2,"result"],"v":{"promptTokens":200,"completionTokens":100}}';
        const result = extractPerRequestUsageFromRawLines([line]);
        assert.ok(result.has(2));
        assert.equal(result.get(2)!.promptTokens, 200);
        assert.equal(result.get(2)!.outputTokens, 100);
});

test('extractPerRequestUsageFromRawLines: skips lines without "result" substring', () => {
        const line = '{"kind":1,"k":["requests",0,"message"],"v":{"promptTokens":100,"outputTokens":50}}';
        const result = extractPerRequestUsageFromRawLines([line]);
        assert.equal(result.size, 0);
});

test('extractPerRequestUsageFromRawLines: skips lines with result but non-matching k pattern', () => {
        const line = '{"kind":1,"k":["other",0,"result"],"v":{"promptTokens":100,"outputTokens":50}}';
        const result = extractPerRequestUsageFromRawLines([line]);
        assert.equal(result.size, 0);
});

test('extractPerRequestUsageFromRawLines: skips lines with result k pattern but no token counts', () => {
        const line = '{"kind":1,"k":["requests",0,"result"],"v":{"someOtherField":42}}';
        const result = extractPerRequestUsageFromRawLines([line]);
        assert.equal(result.size, 0);
});

test('extractPerRequestUsageFromRawLines: extracts from multiple indices', () => {
        const lines = [
                '{"kind":1,"k":["requests",0,"result"],"v":{"promptTokens":100,"outputTokens":50}}',
                '{"kind":1,"k":["requests",1,"result"],"v":{"promptTokens":200,"outputTokens":80}}',
                '{"kind":1,"k":["requests",3,"result"],"v":{"promptTokens":300,"outputTokens":90}}',
        ];
        const result = extractPerRequestUsageFromRawLines(lines);
        assert.equal(result.size, 3);
        assert.equal(result.get(0)!.outputTokens, 50);
        assert.equal(result.get(1)!.outputTokens, 80);
        assert.equal(result.get(3)!.outputTokens, 90);
});

// ── EventJsonlTokenStrategy: ratio-based estimation ─────────────────────────

test('EventJsonlTokenStrategy: uses high ratio (130x) when tool calls > 20', () => {
        // 21 tool.execution_start + one assistant.message with real outputTokens, no session.shutdown
        const lines = [
                ...Array(21).fill(null).map(() => JSON.stringify({ type: 'tool.execution_start', data: {} })),
                JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', outputTokens: 1000 } }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        // estimatedInput = Math.round(1000 * 130) = 130000; actualTokens = 131000
        assert.equal(result.actualTokens, 131000);
        assert.equal(result.cacheReadTokens, 130000);
});

test('EventJsonlTokenStrategy: uses medium ratio (50x) when tool calls > 5 and <= 20', () => {
        const lines = [
                ...Array(10).fill(null).map(() => JSON.stringify({ type: 'tool.execution_start', data: {} })),
                JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', outputTokens: 1000 } }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        // estimatedInput = Math.round(1000 * 50) = 50000; actualTokens = 51000
        assert.equal(result.actualTokens, 51000);
        assert.equal(result.cacheReadTokens, 50000);
});

test('EventJsonlTokenStrategy: uses low ratio (10x) when tool calls <= 5', () => {
        const lines = [
                ...Array(3).fill(null).map(() => JSON.stringify({ type: 'tool.execution_start', data: {} })),
                JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', outputTokens: 1000 } }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        // estimatedInput = Math.round(1000 * 10) = 10000; actualTokens = 11000
        assert.equal(result.actualTokens, 11000);
        assert.equal(result.cacheReadTokens, 10000);
});

test('EventJsonlTokenStrategy: exactly at MED threshold (5 tool calls) uses low ratio', () => {
        // TOOL_CALLS_MED_THRESHOLD = 5; condition is > 5, so exactly 5 → low
        const lines = [
                ...Array(5).fill(null).map(() => JSON.stringify({ type: 'tool.execution_start', data: {} })),
                JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', outputTokens: 1000 } }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 11000); // 10x ratio
});

test('EventJsonlTokenStrategy: exactly at HIGH threshold (20 tool calls) uses medium ratio', () => {
        // TOOL_CALLS_HIGH_THRESHOLD = 20; condition is > 20, so exactly 20 → medium
        const lines = [
                ...Array(20).fill(null).map(() => JSON.stringify({ type: 'tool.execution_start', data: {} })),
                JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', outputTokens: 1000 } }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 51000); // 50x ratio
});

test('EventJsonlTokenStrategy: ratio estimation skipped when session.shutdown provides actual tokens', () => {
        const lines = [
                ...Array(25).fill(null).map(() => JSON.stringify({ type: 'tool.execution_start', data: {} })),
                JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', outputTokens: 1000 } }),
                JSON.stringify({ type: 'session.shutdown', data: { modelMetrics: { 'gpt-4o': { usage: { inputTokens: 5000, outputTokens: 1000, sessions: 0} } } } }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        // session.shutdown overrides ratio estimation
        assert.equal(result.actualTokens, 6000);
});

test('EventJsonlTokenStrategy: fallback event.content contributes to tokens', () => {
        // An event with no known type but with a top-level content field
        const lines = [
                JSON.stringify({ content: 'fallback text content here' }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0);
});

test('EventJsonlTokenStrategy: ratio estimation with zero real output skips estimation', () => {
        // assistant.message with content (not outputTokens) → no cliRealOutputByModel → no ratio estimation
        const lines = [
                ...Array(25).fill(null).map(() => JSON.stringify({ type: 'tool.execution_start', data: {} })),
                JSON.stringify({ type: 'assistant.message', data: { content: 'hello' } }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 0);
});

// ── DeltaTokenStrategy: regex fallback for parse-failed lines ────────────────

test('DeltaTokenStrategy: uses regex fallback for lines that fail JSON.parse', () => {
        // A line with the right k pattern and token counts but invalid JSON
        const invalidLine = '{"kind":1,"k":["requests",0,"result"],"v":{"promptTokens":500,"outputTokens":250,INVALID}';
        const result = new DeltaTokenStrategy().estimate([invalidLine]);
        // The line fails JSON.parse, so parseFailedLines++ triggers regex fallback
        assert.equal(result.actualTokens, 750);
});

test('DeltaTokenStrategy: regex fallback extracts completionTokens when outputTokens absent', () => {
        const invalidLine = '{"kind":1,"k":["requests",0,"result"],"v":{"promptTokens":100,"completionTokens":40,INVALID}';
        const result = new DeltaTokenStrategy().estimate([invalidLine]);
        assert.equal(result.actualTokens, 140);
});

// ── getModelFromRequest: default fallback and details matching ─────────────

test('getModelFromRequest: returns gpt-4 default when no model info', () => {
        assert.equal(getModelFromRequest({}), 'gpt-4');
        assert.equal(getModelFromRequest({ result: {} }), 'gpt-4');
});

test('getModelFromRequest: matches model from result.details via displayNames', () => {
        const pricing = {
                'gpt-4o': {
                        inputCostPerMillion: 2.5,
                        outputCostPerMillion: 10,
                        displayNames: ['GPT-4o']
                }
        };
        const req = { result: { details: 'Model: GPT-4o was used for this request' } };
        assert.equal(getModelFromRequest(req, pricing), 'gpt-4o');
});

test('getModelFromRequest: longer displayName matched before shorter (no prefix collision)', () => {
        const pricing = {
                'gemini-3-pro': { inputCostPerMillion: 1, outputCostPerMillion: 2, displayNames: ['Gemini 3 Pro'] },
                'gemini-3-pro-preview': { inputCostPerMillion: 1, outputCostPerMillion: 2, displayNames: ['Gemini 3 Pro (Preview)'] },
        };
        const req = { result: { details: 'Gemini 3 Pro (Preview) was used' } };
        assert.equal(getModelFromRequest(req, pricing), 'gemini-3-pro-preview');
});

test('getModelFromRequest: result.details with no matching displayName falls back to gpt-4', () => {
        const pricing = { 'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10, displayNames: ['GPT-4o'] } };
        const req = { result: { details: 'Unknown model was used' } };
        assert.equal(getModelFromRequest(req, pricing), 'gpt-4');
});

test('getModelFromRequest: strips copilot/ prefix from result.metadata.modelId', () => {
        const req = { result: { metadata: { modelId: 'copilot/claude-sonnet-4.5' } } };
        assert.equal(getModelFromRequest(req), 'claude-sonnet-4.5');
});

// ── getModelFromRequest: Auto-mode resolution ───────────────────────────────
// Copilot's "Auto" routing only records "auto"/"copilot/auto" as modelId; the
// model actually picked for that turn is reported later as an
// `autoModeResolution` item in the response stream. Without resolving this,
// "auto" is treated as an unpriced model, silently dropping the turn's cost.

test('getModelFromRequest: resolves the real model from an autoModeResolution response item', () => {
        const req = {
                modelId: 'copilot/auto',
                response: [
                        { kind: 'autoModeResolution', resolved: { id: 'mai-code-1.1-flash', name: 'MAI-Code-1.1-Flash' } },
                ],
        };
        assert.equal(getModelFromRequest(req), 'mai-code-1.1-flash');
});

test('getModelFromRequest: falls back to "auto" when no autoModeResolution item is present', () => {
        assert.equal(getModelFromRequest({ modelId: 'auto' }), 'auto');
        assert.equal(getModelFromRequest({ modelId: 'copilot/auto', response: [] }), 'auto');
});

test('getModelFromRequest: non-auto modelId is unaffected by a response array', () => {
        const req = {
                modelId: 'copilot/gpt-4o',
                response: [{ kind: 'autoModeResolution', resolved: { id: 'claude-sonnet-4.5' } }],
        };
        assert.equal(getModelFromRequest(req), 'gpt-4o');
});

test('getModelFromRequest: resolves auto from result.metadata.modelId (metadata-only shape) too', () => {
        const req = {
                result: { metadata: { modelId: 'copilot/auto' } },
                response: [{ kind: 'autoModeResolution', resolved: { id: 'gpt-5.4' } }],
        };
        assert.equal(getModelFromRequest(req), 'gpt-5.4');
});

// ── selectTokenEstimationStrategy: format detection limit ──────────────────

test('selectTokenEstimationStrategy: format detection stops after FORMAT_DETECTION_LINE_LIMIT non-empty lines', () => {
        // 10 non-kind event lines (limit) + kind:0 line after → should use EventJsonlTokenStrategy
        // because the kind:0 line is past the 10-line detection window
        const lines = [
                ...Array(10).fill(null).map(() => JSON.stringify({ type: 'user.message', data: { content: 'x' } })),
                JSON.stringify({ kind: 0, v: {} }),
        ];
        const strategy = selectTokenEstimationStrategy(lines);
        assert.ok(strategy instanceof EventJsonlTokenStrategy, 'should be event strategy when kind:0 is past limit');
});

test('selectTokenEstimationStrategy: detects delta format within first 10 non-empty lines', () => {
        const lines = [
                ...Array(5).fill(null).map(() => JSON.stringify({ type: 'user.message', data: { content: 'x' } })),
                JSON.stringify({ kind: 0, v: {} }),
        ];
        const strategy = selectTokenEstimationStrategy(lines);
        assert.ok(strategy instanceof DeltaTokenStrategy);
});

// ── isJsonlContent: additional edge cases ──────────────────────────────────

test('isJsonlContent: returns false when both lines present but first does not end with }', () => {
        const content = '{"a":1,\n"b":2}';
        assert.equal(isJsonlContent(content), false);
});

test('isJsonlContent: returns false when second line does not start with {', () => {
        const content = '{"a":1}\nnot-json';
        assert.equal(isJsonlContent(content), false);
});

test('isJsonlContent: exactly 2 valid JSON object lines returns true', () => {
        const content = '{"a":1}\n{"b":2}';
        assert.equal(isJsonlContent(content), true);
});

// ── isUuidPointerFile: additional edge cases ────────────────────────────────

test('isUuidPointerFile: returns false for UUID with extra text', () => {
        assert.equal(isUuidPointerFile('550e8400-e29b-41d4-a716-446655440000 extra'), false);
});

test('isUuidPointerFile: returns false for short UUID (too few chars)', () => {
        assert.equal(isUuidPointerFile('550e8400-e29b-41d4-a716'), false);
});

// ── calculateEstimatedCost: additional edge cases ───────────────────────────

test('calculateEstimatedCost: clamps uncachedInput to 0 when cachedRead exceeds inputTokens', () => {
        // Math.max(0, inputTokens - cachedRead) should not go negative
        const modelUsage = { 'claude-x': { inputTokens: 100, outputTokens: 50, cachedReadTokens: 200, sessions: 0} };
        const pricing = { 'claude-x': { inputCostPerMillion: 10, outputCostPerMillion: 20 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // uncachedInput = max(0, 100 - 200 - 0) = 0
        // cachedRead = 200 → 200/1M * 10 = 0.002 (uses inputCostPerMillion as fallback)
        // output = 50/1M * 20 = 0.001
        assert.ok(cost >= 0, 'cost should not be negative');
});

test('calculateEstimatedCost: skips model with no pricing entry and no fallback', () => {
        // If neither exact model nor gpt-4o-mini fallback exists, model is skipped
        const modelUsage = { 'exotic-model': { inputTokens: 1000000, outputTokens: 1000000, sessions: 0} };
        const pricing = { 'some-other-model': { inputCostPerMillion: 1, outputCostPerMillion: 2 } };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        assert.equal(cost, 0);
});

test('calculateEstimatedCost: uses cachedInputCostPerMillion when present', () => {
        const modelUsage = {
                'model-a': { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 500_000, sessions: 0}
        };
        const pricing = {
                'model-a': { inputCostPerMillion: 10, outputCostPerMillion: 20, cachedInputCostPerMillion: 2 }
        };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // uncached = 500_000 → 0.5 * 10 = 5.0
        // cached read = 500_000 → 0.5 * 2 = 1.0
        // output = 0
        assert.ok(Math.abs(cost - 6.0) < 1e-9);
});

// ── calculateEstimatedCost: 1-hour cache-creation TTL pricing ───────────────
// Anthropic bills prompt-cache writes at different rates depending on TTL:
// the default 5-minute TTL (cacheCreationCostPerMillion) vs. the 1-hour TTL
// (cacheCreation1hCostPerMillion) that Claude Code uses by default, which is
// billed at a higher rate. See issue #1589.

test('calculateEstimatedCost: splits cacheCreationTokens into 1h and 5m portions', () => {
        const modelUsage = {
                'claude-sonnet-4-6': {
                        inputTokens: 1_000_000,
                        outputTokens: 0,
                        cacheCreationTokens: 1_000_000,
                        cacheCreation1hTokens: 400_000, // 400k of the 1M cache-write was 1h TTL, 600k was 5m TTL
                        sessions: 0}
        };
        const pricing = {
                'claude-sonnet-4-6': {
                        inputCostPerMillion: 3,
                        outputCostPerMillion: 15,
                        cacheCreationCostPerMillion: 3.75,
                        cacheCreation1hCostPerMillion: 6
                }
        };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // uncachedInput = max(0, 1_000_000 - 0 - 1_000_000) = 0
        // 5m portion = 600_000 → 0.6 * 3.75 = 2.25
        // 1h portion = 400_000 → 0.4 * 6 = 2.4
        const expected = 2.25 + 2.4;
        assert.ok(Math.abs(cost - expected) < 1e-9, `expected ${expected}, got ${cost}`);
});

test('calculateEstimatedCost: falls back to cacheCreationCostPerMillion when cacheCreation1hCostPerMillion is missing', () => {
        const modelUsage = {
                'model-x': {
                        inputTokens: 100_000,
                        outputTokens: 0,
                        cacheCreationTokens: 100_000,
                        cacheCreation1hTokens: 100_000,
                        sessions: 0}
        };
        const pricing = {
                'model-x': { inputCostPerMillion: 3, outputCostPerMillion: 15, cacheCreationCostPerMillion: 3.75 }
        };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // No cacheCreation1hCostPerMillion → all 100_000 tokens fall back to the 5-min rate
        assert.ok(Math.abs(cost - 0.375) < 1e-9);
});

test('calculateEstimatedCost: cacheCreation1hTokens is clamped to cacheCreationTokens (never exceeds total)', () => {
        const modelUsage = {
                'claude-sonnet-4-6': {
                        inputTokens: 100_000,
                        outputTokens: 0,
                        cacheCreationTokens: 50_000,
                        cacheCreation1hTokens: 999_999, // malformed/overcounted input should not blow up the total
                        sessions: 0}
        };
        const pricing = {
                'claude-sonnet-4-6': {
                        inputCostPerMillion: 3,
                        outputCostPerMillion: 15,
                        cacheCreationCostPerMillion: 3.75,
                        cacheCreation1hCostPerMillion: 6
                }
        };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // cacheCreation1h clamped to 50_000 → 0.05 * 6 = 0.3, 5m portion = 0
        // uncachedInput = max(0, 100_000 - 0 - 50_000) = 50_000 → 0.05 * 3 = 0.15
        assert.ok(Math.abs(cost - 0.45) < 1e-9, `expected 0.45, got ${cost}`);
});

test('calculateEstimatedCost: no cacheCreation1hTokens behaves exactly as before (backward compatible)', () => {
        const modelUsage = {
                'claude-sonnet-4-6': { inputTokens: 100_000, outputTokens: 0, cacheCreationTokens: 100_000, sessions: 0}
        };
        const pricing = {
                'claude-sonnet-4-6': {
                        inputCostPerMillion: 3,
                        outputCostPerMillion: 15,
                        cacheCreationCostPerMillion: 3.75,
                        cacheCreation1hCostPerMillion: 6
                }
        };
        const cost = calculateEstimatedCost(modelUsage, pricing);
        // All 100_000 tokens priced at the 5m rate since cacheCreation1hTokens is absent
        assert.ok(Math.abs(cost - 0.375) < 1e-9);
});

// ── getModelTier: additional edge cases ─────────────────────────────────────

test('getModelTier: partial match where modelId includes key', () => {
        const pricing = { 'claude': { inputCostPerMillion: 3, outputCostPerMillion: 15, tier: 'premium' as const } };
        assert.equal(getModelTier('claude-sonnet-4.5', pricing), 'premium');
});

test('getModelTier: partial match where key includes modelId', () => {
        const pricing = { 'claude-sonnet': { inputCostPerMillion: 3, outputCostPerMillion: 15, tier: 'standard' as const } };
        assert.equal(getModelTier('claude', pricing), 'standard');
});

test('getModelTier: tier "standard" returns standard (exact match)', () => {
        const pricing = { 'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10, tier: 'standard' as const } };
        assert.equal(getModelTier('gpt-4o', pricing), 'standard');
});

// ── EventJsonlTokenStrategy: session.shutdown without timestamp ─────────────

test('EventJsonlTokenStrategy: session.shutdown without timestamp still accumulates actualTokens', () => {
        const lines = [
                JSON.stringify({
                        type: 'session.shutdown',
                        data: { modelMetrics: { 'gpt-4o': { usage: { inputTokens: 100, outputTokens: 200, sessions: 0} } } }
                        // no timestamp field
                }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 300);
        assert.deepEqual(result.dailyActualTokens, {});
});

test('EventJsonlTokenStrategy: session.shutdown with zero total tokens does not add dailyActualTokens', () => {
        // shutdownTotal > 0 guard: when both inputTokens and outputTokens are 0, no daily entry is added
        const lines = [
                JSON.stringify({
                        type: 'session.shutdown',
                        timestamp: '2025-03-15T10:00:00.000Z',
                        data: { modelMetrics: { 'gpt-4o': { usage: { inputTokens: 0, outputTokens: 0, sessions: 0} } } }
                }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 0);
        assert.deepEqual(result.dailyActualTokens, {});
});

// ── getTotalTokensFromModelUsage: additional cases ──────────────────────────

test('getTotalTokensFromModelUsage: single model returns correct sum', () => {
        assert.equal(getTotalTokensFromModelUsage({ 'gpt-4o': { inputTokens: 1000, outputTokens: 500, sessions: 0} }), 1500);
});

test('getTotalTokensFromModelUsage: model with zero tokens contributes zero', () => {
        assert.equal(getTotalTokensFromModelUsage({ 'empty': { inputTokens: 0, outputTokens: 0, sessions: 0} }), 0);
});

// ── extractAllTokensFromDebugLog: model breakdown ──────────────────────────

test('extractAllTokensFromDebugLog: builds per-model breakdown correctly', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { model: 'gpt-4o', inputTokens: 1000, outputTokens: 200, cachedTokens: 100 } }),
                JSON.stringify({ type: 'llm_request', attrs: { model: 'claude', inputTokens: 500, outputTokens: 100, cachedTokens: 50 } }),
                JSON.stringify({ type: 'llm_request', attrs: { model: 'gpt-4o', inputTokens: 800, outputTokens: 150 } }),
        ].join('\n');
        const result = extractAllTokensFromDebugLog(lines);
        assert.ok(result);
        assert.equal(result.modelTurns, 3);
        assert.ok(result.modelBreakdown['gpt-4o']);
        assert.equal(result.modelBreakdown['gpt-4o'].inputTokens, 1800);
        assert.equal(result.modelBreakdown['gpt-4o'].outputTokens, 350);
        assert.equal(result.modelBreakdown['gpt-4o'].cachedTokens, 100);
        assert.ok(result.modelBreakdown['claude']);
        assert.equal(result.modelBreakdown['claude'].inputTokens, 500);
});

test('extractAllTokensFromDebugLog: llm_request with empty model string is not added to breakdown', () => {
        const lines = [
                JSON.stringify({ type: 'llm_request', attrs: { model: '', inputTokens: 100 } }),
        ].join('\n');
        const result = extractAllTokensFromDebugLog(lines);
        assert.ok(result);
        assert.deepEqual(result.modelBreakdown, {});
});

// ── DeltaTokenStrategy: sub-agent token counting ────────────────────────────

test('DeltaTokenStrategy: counts sub-agent tokens from reconstructed state', () => {
        const subAgentItem = {
                kind: 'toolInvocationSerialized',
                toolSpecificData: {
                        kind: 'subagent',
                        modelName: 'claude-haiku',
                        prompt: 'list all files in the repo',
                        result: 'Found 42 files',
                }
        };
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [{ response: [subAgentItem] }] } }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0, 'sub-agent prompt+result should contribute tokens');
});

test('DeltaTokenStrategy: sub-agent items in kind:2 are counted from final reconstructed state', () => {
        // Sub-agent items in kind:2 delta are skipped during accumulation but ARE
        // counted via _dtsExtractSubAgentTokens from the fully reconstructed state.
        const subAgentItem = {
                kind: 'toolInvocationSerialized',
                toolSpecificData: { kind: 'subagent', prompt: 'a', result: 'b' }
        };
        const lines = [
                JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [subAgentItem] }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        // prompt='a' (1 token) + result='b' (1 token) = 2 tokens from final state
        assert.equal(result.tokens, 2);
});

// ── reconstructJsonlStateAsync ──────────────────────────────────────────────

import { reconstructJsonlStateAsync } from '../../../src/tokenEstimation';

test('reconstructJsonlStateAsync: delta-based input sets isDeltaBased=true', async () => {
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [] } }),
                JSON.stringify({ kind: 1, k: ['requests'], v: [] }),
        ];
        const { isDeltaBased } = await reconstructJsonlStateAsync(lines);
        assert.equal(isDeltaBased, true);
});

test('reconstructJsonlStateAsync: non-delta input sets isDeltaBased=false', async () => {
        const lines = [
                JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
        ];
        const { isDeltaBased } = await reconstructJsonlStateAsync(lines);
        assert.equal(isDeltaBased, false);
});

test('reconstructJsonlStateAsync: empty lines returns empty state', async () => {
        const { sessionState, isDeltaBased } = await reconstructJsonlStateAsync([]);
        assert.deepEqual(sessionState, {});
        assert.equal(isDeltaBased, false);
});

test('reconstructJsonlStateAsync: reconstructs state from kind:0 and kind:1 deltas', async () => {
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [], title: 'session1' } }),
                JSON.stringify({ kind: 1, k: ['title'], v: 'updated-title' }),
        ];
        const { sessionState } = await reconstructJsonlStateAsync(lines);
        const state = sessionState as Record<string, unknown>;
        assert.equal(state.title, 'updated-title');
});

test('reconstructJsonlStateAsync: skips invalid JSON lines without throwing', async () => {
        const lines = [
                JSON.stringify({ kind: 0, v: { x: 1 } }),
                'not valid json',
                JSON.stringify({ kind: 1, k: ['x'], v: 2 }),
        ];
        const { sessionState } = await reconstructJsonlStateAsync(lines);
        const state = sessionState as Record<string, unknown>;
        assert.equal(state.x, 2);
});

// ── EventJsonlTokenStrategy: session.truncation event parsing ─────────────

test('estimateTokensFromJsonlSession: session.truncation with removed messages increments truncationCount', () => {
	const events = [
		JSON.stringify({ type: 'user.message', data: { content: 'hello' } }),
		JSON.stringify({
			type: 'session.truncation',
			data: {
				tokenLimit: 128000,
				preTruncationTokensInMessages: 13863,
				preTruncationMessagesLength: 9,
				postTruncationTokensInMessages: 8000,
				postTruncationMessagesLength: 5,
				tokensRemovedDuringTruncation: 5863,
				messagesRemovedDuringTruncation: 4,
				performedBy: 'BasicTruncator',
			},
		}),
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.truncationCount, 1, 'should count one truncation event');
	assert.equal(result.messagesRemovedByTruncation, 4, 'should track messages removed');
});

test('estimateTokensFromJsonlSession: session.truncation with zero removed messages does not increment truncationCount', () => {
	const events = [
		JSON.stringify({
			type: 'session.truncation',
			data: {
				tokenLimit: 128000,
				preTruncationTokensInMessages: 13863,
				preTruncationMessagesLength: 9,
				postTruncationTokensInMessages: 13863,
				postTruncationMessagesLength: 9,
				tokensRemovedDuringTruncation: 0,
				messagesRemovedDuringTruncation: 0,
				performedBy: 'BasicTruncator',
			},
		}),
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.truncationCount, undefined, 'should not count truncation when no messages removed');
	assert.equal(result.messagesRemovedByTruncation, undefined, 'should not track messages when none removed');
});

test('estimateTokensFromJsonlSession: multiple session.truncation events accumulate correctly', () => {
	const makeTruncation = (removed: number) => JSON.stringify({
		type: 'session.truncation',
		data: { messagesRemovedDuringTruncation: removed, tokensRemovedDuringTruncation: removed * 100 },
	});
	const events = [
		makeTruncation(3),  // should count
		makeTruncation(0),  // should not count (no messages removed)
		makeTruncation(2),  // should count
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.truncationCount, 2, 'should count only events where messages were removed');
	assert.equal(result.messagesRemovedByTruncation, 5, 'should sum all removed messages');
});

test('estimateTokensFromJsonlSession: session.truncation missing data does not count', () => {
	const events = [
		JSON.stringify({ type: 'session.truncation' }),
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.truncationCount, undefined, 'missing data should not count as truncation');
});

test('estimateTokensFromJsonlSession: session.truncation with non-numeric messagesRemoved does not count', () => {
	const events = [
		JSON.stringify({
			type: 'session.truncation',
			data: { messagesRemovedDuringTruncation: 'lots' },
		}),
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.truncationCount, undefined, 'non-numeric messagesRemoved should not count');
});

test('estimateTokensFromJsonlSession: truncation events do not affect token counts', () => {
	const userOnly = JSON.stringify({ type: 'user.message', data: { content: 'hello world' } });
	const withTruncation = [
		JSON.stringify({ type: 'user.message', data: { content: 'hello world' } }),
		JSON.stringify({
			type: 'session.truncation',
			data: { messagesRemovedDuringTruncation: 5 },
		}),
	].join('\n');
	const resultA = estimateTokensFromJsonlSession(userOnly);
	const resultB = estimateTokensFromJsonlSession(withTruncation);
	assert.equal(resultA.tokens, resultB.tokens, 'truncation events should not affect estimated token counts');
});

test('reconstructJsonlStateAsync: blank lines are silently skipped', async () => {
        // Lines 597-599: if (!line.trim()) { continue; }
        const lines = [
                '',
                '   ',
                JSON.stringify({ kind: 0, v: { requests: [], title: 'blank-skip-test' } }),
        ];
        const { sessionState, isDeltaBased } = await reconstructJsonlStateAsync(lines);
        assert.equal((sessionState as Record<string, unknown>).title, 'blank-skip-test');
        assert.equal(isDeltaBased, true);
});

// ── DeltaTokenStrategy: incremental response item edge cases ────────────────

test('DeltaTokenStrategy: blank lines in estimate input are silently skipped', () => {
        // Lines 342-344: if (!line.trim()) { continue; }
        const validLine = JSON.stringify({ kind: 0, v: { requests: [] } });
        const result = new DeltaTokenStrategy().estimate(['', '   ', validLine]);
        assert.equal(result.tokens, 0);
        assert.equal(result.actualTokens, 0);
});

test('DeltaTokenStrategy: kind:2 response item with no extractable text is skipped', () => {
        // _dtsAddResponseItemTokens: if (!text) { return; }  (lines 308-310)
        // toolInvocationSerialized with no text fields — extractResponseItemText returns ''
        const noTextItem = { kind: 'toolInvocationSerialized', toolId: 'read' };
        const lines = [
                JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [noTextItem] }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.equal(result.tokens, 0);
});

test('DeltaTokenStrategy: kind:2 response item with non-thinking text adds to totalTokens', () => {
        // _dtsAddResponseItemTokens: else branch (isThinking=false, text non-empty) (lines 314-316)
        const textItem = { kind: 'markdownContent', value: 'non-thinking response content' };
        const lines = [
                JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [textItem] }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.ok(result.tokens > 0, 'non-thinking text should contribute to tokens');
        assert.equal(result.thinkingTokens, 0, 'thinkingTokens should be zero for non-thinking response');
});

// ── EventJsonlTokenStrategy: session.shutdown edge cases ────────────────────

test('EventJsonlTokenStrategy: session.shutdown without modelMetrics is silently ignored', () => {
        // _ejtsHandleShutdown: if (!data?.modelMetrics) { return; }  (lines 406-408)
        const lines = [
                JSON.stringify({ type: 'session.shutdown', data: {} }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 0);
});

test('EventJsonlTokenStrategy: session.shutdown model entry without usage field contributes zero actual tokens', () => {
        // _ejtsAccumulateModelMetrics: if (!usage) { return 0; }  (lines 381-383)
        const lines = [
                JSON.stringify({
                        type: 'session.shutdown',
                        data: { modelMetrics: { 'gpt-4o': {} } }, // model entry with no usage
                }),
        ];
        const result = new EventJsonlTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 0);
});

// ── buildReasoningEffortTimeline: _bretExtractEffortFromModel guard clauses ─

test('buildReasoningEffortTimeline: kind:0 selectedModel without metadata leaves defaultEffort null', () => {
        // _bretExtractEffortFromModel: !metadata → return null  (lines 697-700)
        const delta = { kind: 0, v: { inputState: { selectedModel: {} } } };
        const result = buildReasoningEffortTimeline([JSON.stringify(delta)]);
        assert.equal(result.defaultEffort, null);
});

test('buildReasoningEffortTimeline: kind:0 selectedModel without configurationSchema leaves defaultEffort null', () => {
        // _bretExtractEffortFromModel: !schema → return null  (lines 701-704)
        const delta = { kind: 0, v: { inputState: { selectedModel: { metadata: {} } } } };
        const result = buildReasoningEffortTimeline([JSON.stringify(delta)]);
        assert.equal(result.defaultEffort, null);
});

test('buildReasoningEffortTimeline: kind:0 selectedModel without properties leaves defaultEffort null', () => {
        // _bretExtractEffortFromModel: !props → return null  (lines 705-710)
        const delta = { kind: 0, v: { inputState: { selectedModel: { metadata: { configurationSchema: {} } } } } };
        const result = buildReasoningEffortTimeline([JSON.stringify(delta)]);
        assert.equal(result.defaultEffort, null);
});

test('buildReasoningEffortTimeline: kind:0 selectedModel without reasoningEffort property leaves defaultEffort null', () => {
        // _bretExtractEffortFromModel: !re → return null  (lines 711-715)
        const delta = { kind: 0, v: { inputState: { selectedModel: { metadata: { configurationSchema: { properties: {} } } } } } };
        const result = buildReasoningEffortTimeline([JSON.stringify(delta)]);
        assert.equal(result.defaultEffort, null);
});

test('buildReasoningEffortTimeline: kind:2 with null v is skipped', () => {
        // _bretHandleKind2: !req || typeof req !== 'object' → return  (lines 750-752)
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const kind2 = { kind: 2, k: ['requests', 0], v: null };
        const result = buildReasoningEffortTimeline([kind0, kind2].map(d => JSON.stringify(d)));
        assert.equal(result.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: event with non-numeric kind string is skipped', () => {
        // Lines 772-774: typeof delta.kind !== 'number' → continue
        const kind0 = { kind: 0, v: { inputState: { selectedModel: makeModelWithEffort('medium') } } };
        const stringKindEvent = { kind: 'user.message', data: { content: 'hello' } };
        const result = buildReasoningEffortTimeline([kind0, stringKindEvent].map(d => JSON.stringify(d)));
        assert.equal(result.defaultEffort, 'medium');
        // defaultEffort was set from kind:0 — the string-kind event was silently ignored
});

// ── DeltaTokenStrategy: _dtsExtractFromResult fallback zero return ───────────

test('DeltaTokenStrategy: request result with no recognized token fields contributes zero actual tokens', () => {
        // _dtsExtractFromResult: return 0 fallback (line 225)
        // result object exists but has none of promptTokens/outputTokens/metadata/usage
        const lines = [
                JSON.stringify({ kind: 0, v: { requests: [{ result: { unexpectedField: 'no tokens here' } }] } }),
        ];
        const result = new DeltaTokenStrategy().estimate(lines);
        assert.equal(result.actualTokens, 0);
});

// ── reconstructJsonlStateAsync: event-loop yield ─────────────────────────────

test('reconstructJsonlStateAsync: yields to event loop every yieldInterval delta lines', async () => {
        // Lines 611-612: await new Promise(resolve => setTimeout(resolve, 0))
        // yieldInterval=1 forces yield at every delta line after index 0
        const lines = [
                JSON.stringify({ kind: 0, v: { title: 'session' } }),
                JSON.stringify({ kind: 1, k: ['title'], v: 'updated' }),
        ];
        const { sessionState } = await reconstructJsonlStateAsync(lines, 1);
        assert.equal((sessionState as Record<string, unknown>).title, 'updated');
});
// ── Long-context tier discovery ──────────────────────────────────────────────

import { parseContextThreshold, getLongContextInfo } from '../../../src/tokenEstimation';

test('estimateTokensFromJsonlSession: captures contextTier from session.start', () => {
	const events = [
		JSON.stringify({ type: 'session.start', data: { sessionId: 'x', contextTier: 'default' } }),
		JSON.stringify({ type: 'user.message', data: { content: 'hello' } }),
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.contextTier, 'default');
});

test('estimateTokensFromJsonlSession: last non-empty contextTier wins (session.model_change)', () => {
	const events = [
		JSON.stringify({ type: 'session.start', data: { contextTier: 'default' } }),
		JSON.stringify({ type: 'session.model_change', data: { model: 'gpt-5.6-luna', contextTier: 'long-context' } }),
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.contextTier, 'long-context');
});

test('estimateTokensFromJsonlSession: null/missing contextTier leaves field absent', () => {
	const events = [
		JSON.stringify({ type: 'session.start', data: { contextTier: null } }),
		JSON.stringify({ type: 'session.resume', data: {} }),
	].join('\n');
	const result = estimateTokensFromJsonlSession(events);
	assert.equal(result.contextTier, undefined);
});

test('DeltaTokenStrategy: tracks max per-request prompt tokens (usage format)', () => {
	const lines = [
		JSON.stringify({ kind: 0, v: { requests: [
			{ result: { usage: { promptTokens: 50_000, completionTokens: 100 } } },
			{ result: { usage: { promptTokens: 120_000, completionTokens: 200 } } },
			{ result: { usage: { promptTokens: 80_000, completionTokens: 300 } } },
		] } }),
	];
	const result = new DeltaTokenStrategy().estimate(lines);
	assert.equal(result.maxRequestInputTokens, 120_000);
});

test('DeltaTokenStrategy: maxRequestInputTokens absent when no request has usage data', () => {
	const lines = [
		JSON.stringify({ kind: 0, v: { requests: [{ result: { unexpectedField: true } }] } }),
	];
	const result = new DeltaTokenStrategy().estimate(lines);
	assert.equal(result.maxRequestInputTokens, undefined);
});

test('extractAllTokensFromDebugLog: tracks max per-llm_request inputTokens', () => {
	const content = [
		JSON.stringify({ type: 'llm_request', attrs: { model: 'gpt-5.6-luna', inputTokens: 30_000, outputTokens: 100, cachedTokens: 25_000 } }),
		JSON.stringify({ type: 'llm_request', attrs: { model: 'gpt-5.6-luna', inputTokens: 132_780, outputTokens: 250, cachedTokens: 90_000 } }),
		JSON.stringify({ type: 'other_event', attrs: { inputTokens: 999_999 } }),
	].join('\n');
	const result = extractAllTokensFromDebugLog(content);
	assert.ok(result);
	assert.equal(result!.maxRequestInputTokens, 132_780);
	assert.equal(result!.inputTokens, 162_780);
});

test('parseContextThreshold: parses docs-table formats', () => {
	assert.equal(parseContextThreshold('> 200K'), 200_000);
	assert.equal(parseContextThreshold('≤ 272K'), 272_000);
	assert.equal(parseContextThreshold('200K'), 200_000);
	assert.equal(parseContextThreshold('1M'), 1_000_000);
	assert.equal(parseContextThreshold('128000'), 128_000);
	assert.equal(parseContextThreshold(''), null);
	assert.equal(parseContextThreshold(undefined), null);
	assert.equal(parseContextThreshold('no numbers'), null);
});

test('getLongContextInfo: resolves tiered model with exact key match', () => {
	const pricing = {
		'gpt-5.6-luna': {
			inputCostPerMillion: 1.0, outputCostPerMillion: 6.0,
			copilotPricing: {
				inputCostPerMillion: 1.0, outputCostPerMillion: 6.0,
				longContext: { inputCostPerMillion: 2.0, outputCostPerMillion: 9.0, threshold: '> 200K' },
			},
		},
	};
	const info = getLongContextInfo('gpt-5.6-luna', pricing);
	assert.ok(info);
	assert.equal(info!.thresholdTokens, 200_000);
	assert.equal(info!.defaultInputCostPerMillion, 1.0);
	assert.equal(info!.longContextInputCostPerMillion, 2.0);
});

test('getLongContextInfo: partial key match (prefixed model id)', () => {
	const pricing = {
		'gpt-5.6-sol': {
			inputCostPerMillion: 5.0, outputCostPerMillion: 30.0,
			copilotPricing: {
				inputCostPerMillion: 5.0, outputCostPerMillion: 30.0,
				longContext: { inputCostPerMillion: 10.0, outputCostPerMillion: 45.0, threshold: '> 272K' },
			},
		},
	};
	const info = getLongContextInfo('copilot/GPT-5.6-Sol', pricing);
	assert.ok(info, 'case-insensitive partial match should resolve');
	assert.equal(info!.thresholdTokens, 272_000);
});

test('getLongContextInfo: returns null for models without a longContext block', () => {
	const pricing = {
		'claude-sonnet-4.5': {
			inputCostPerMillion: 3.0, outputCostPerMillion: 15.0,
			copilotPricing: { inputCostPerMillion: 3.3, outputCostPerMillion: 16.5 },
		},
	};
	assert.equal(getLongContextInfo('claude-sonnet-4.5', pricing), null);
	assert.equal(getLongContextInfo('unknown-model', pricing), null);
	assert.equal(getLongContextInfo('anything', {}), null);
});

// ── extractTtftSamplesFromDebugLog ──────────────────────────────────────

import { extractTtftSamplesFromDebugLog } from '../../../src/tokenEstimation';

test('extractTtftSamplesFromDebugLog: extracts one sample per llm_request event with ttft, model, and ts', () => {
	const lines = [
		JSON.stringify({ type: 'llm_request', ts: 1_780_000_000_000, attrs: { model: 'claude-sonnet-5', ttft: 0.45 } }),
		JSON.stringify({ type: 'llm_request', ts: 1_780_000_005_000, attrs: { model: 'gpt-5', ttft: 1.2 } }),
	].join('\n');
	const samples = extractTtftSamplesFromDebugLog(lines);
	assert.equal(samples.length, 2);
	assert.equal(samples[0].model, 'claude-sonnet-5');
	assert.equal(samples[0].ttftSeconds, 0.45);
	assert.equal(samples[0].tsMs, 1_780_000_000_000);
	assert.equal(samples[1].model, 'gpt-5');
});

test('extractTtftSamplesFromDebugLog: ignores non-llm_request events and events missing ttft/model/ts', () => {
	const lines = [
		JSON.stringify({ type: 'turn_start', ts: 1_780_000_000_000, attrs: { turnId: 'a' } }),
		JSON.stringify({ type: 'llm_request', ts: 1_780_000_000_000, attrs: { model: 'claude-sonnet-5' } }), // no ttft
		JSON.stringify({ type: 'llm_request', ts: 1_780_000_000_000, attrs: { ttft: 0.3 } }), // no model
		JSON.stringify({ type: 'llm_request', attrs: { model: 'claude-sonnet-5', ttft: 0.3 } }), // no ts
		JSON.stringify({ type: 'llm_request', ts: 1_780_000_000_000, attrs: { model: 'claude-sonnet-5', ttft: 0.3 } }), // valid
	].join('\n');
	const samples = extractTtftSamplesFromDebugLog(lines);
	assert.equal(samples.length, 1);
	assert.equal(samples[0].ttftSeconds, 0.3);
});

test('extractTtftSamplesFromDebugLog: skips invalid JSON lines and blank lines without crashing', () => {
	const lines = [
		JSON.stringify({ type: 'llm_request', ts: 1_780_000_000_000, attrs: { model: 'gpt-5', ttft: 0.5 } }),
		'',
		'not valid json {{{',
		JSON.stringify({ type: 'llm_request', ts: 1_780_000_001_000, attrs: { model: 'gpt-5', ttft: 0.6 } }),
	].join('\n');
	const samples = extractTtftSamplesFromDebugLog(lines);
	assert.equal(samples.length, 2);
});

test('extractTtftSamplesFromDebugLog: normalizes a seconds-magnitude ts (unix seconds) up to milliseconds', () => {
	// 1780000000 (10 digits, ~year 2026 in seconds) vs. the ms equivalent 1780000000000.
	const lines = JSON.stringify({ type: 'llm_request', ts: 1_780_000_000, attrs: { model: 'gpt-5', ttft: 0.5 } });
	const samples = extractTtftSamplesFromDebugLog(lines);
	assert.equal(samples[0].tsMs, 1_780_000_000_000);
});

test('extractTtftSamplesFromDebugLog: normalizes a milliseconds-magnitude ttft down to seconds', () => {
	// 450 only makes sense as milliseconds (450 seconds would be a 7.5-minute TTFT).
	const lines = JSON.stringify({ type: 'llm_request', ts: 1_780_000_000_000, attrs: { model: 'gpt-5', ttft: 450 } });
	const samples = extractTtftSamplesFromDebugLog(lines);
	assert.equal(samples[0].ttftSeconds, 0.45);
});

test('extractTtftSamplesFromDebugLog: returns an empty array for content with no llm_request events', () => {
	assert.deepEqual(extractTtftSamplesFromDebugLog(''), []);
	assert.deepEqual(extractTtftSamplesFromDebugLog(JSON.stringify({ type: 'session_start', attrs: {} })), []);
});
