/**
 * Second batch of boundary / exact-value tests for src/tokenEstimation.ts, written to kill
 * the Stryker survivors that remained after tokenEstimationBoundaries.test.ts (refs #2341).
 *
 * Clusters: the yield cadence of reconstructJsonlStateAsync, null-tolerant reasoning-effort
 * parsing, applyDelta path creation, event-JSONL optional-chaining fallbacks, the
 * delta-strategy parse-failure fallback, auto-model resolution, pricing lookup precedence
 * and turn/sub-agent cost attachment. Every assertion pins an exact value.
 */
import test, { mock } from 'node:test';
import * as assert from 'node:assert/strict';

import {
	applyDelta,
	attachEstimatedTurnCosts,
	buildReasoningEffortTimeline,
	createEmptyContextRefs,
	estimateTokensFromJsonlSession,
	estimateTokensFromText,
	extractAllTokensFromDebugLog,
	extractResponseItemText,
	extractSubAgentData,
	extractTtftSamplesFromDebugLog,
	getLongContextInfo,
	getModelCostBucket,
	getModelFromRequest,
	getModelTier,
	isJsonlContent,
	reconstructJsonlStateAsync,
	selectTokenEstimationStrategy,
	DeltaTokenStrategy,
} from '../tokenEstimation';
import type { ChatTurn, ModelPricing } from '../types';

const jl = (...events: unknown[]): string => events.map(e => JSON.stringify(e)).join('\n');
const delta = (requests: unknown[]): string => jl({ kind: 0, v: { requests } });

// --- reconstructJsonlStateAsync: yield cadence ---

/** Count the zero-delay timers reconstructJsonlStateAsync schedules for a given input. */
async function countYields(lines: string[], interval: number): Promise<number> {
	const original = globalThis.setTimeout;
	let yields = 0;
	const spy = mock.method(globalThis, 'setTimeout', ((fn: () => void, ms?: number) => {
		if (ms === 0) { yields++; }
		return original(fn, ms);
	}) as typeof setTimeout);
	try {
		await reconstructJsonlStateAsync(lines, interval);
	} finally {
		spy.mock.restore();
	}
	return yields;
}

test('reconstructJsonlStateAsync: yields only at i>0 multiples of the interval for delta files', async () => {
	const lines = [1, 2, 3, 4, 5].map(i => JSON.stringify({ kind: 1, k: ['a'], v: i }));
	// interval 2 -> yields at i=2 and i=4 (never at i=0)
	assert.equal(await countYields(lines, 2), 2);
	// interval 1 -> yields at i=1..4 (i=0 excluded)
	assert.equal(await countYields(lines, 1), 4);
});

test('reconstructJsonlStateAsync: never yields for non-delta content', async () => {
	const lines = [1, 2, 3, 4, 5].map(i => JSON.stringify({ type: 'x', i }));
	assert.equal(await countYields(lines, 2), 0);
	assert.equal(await countYields(lines, 1), 0);
});

test('reconstructJsonlStateAsync: blank lines are skipped before the yield check', async () => {
	// index 2 is blank and sits on the interval; skipping it means it must not yield
	const lines = [JSON.stringify({ kind: 1, k: ['a'], v: 1 }), JSON.stringify({ kind: 1, k: ['a'], v: 2 }), '   ', JSON.stringify({ kind: 1, k: ['a'], v: 3 })];
	assert.equal(await countYields(lines, 2), 0);
	const withEmpty = [lines[0], lines[1], '', lines[3]];
	assert.equal(await countYields(withEmpty, 2), 0);
});

// --- extractAllTokensFromDebugLog ---

test('extractAllTokensFromDebugLog: a non-string model is not used as a breakdown key', () => {
	const out = extractAllTokensFromDebugLog(jl({ type: 'llm_request', attrs: { inputTokens: 5, outputTokens: 2, model: 123 } }));
	assert.deepEqual(out?.modelBreakdown, {});
	assert.equal(out?.inputTokens, 5);
	assert.equal(out?.modelTurns, 1);
});

// --- extractTtftSamplesFromDebugLog ---

test('extractTtftSamplesFromDebugLog: empty and non-string models are skipped', () => {
	const mk = (model: unknown) => ({ type: 'llm_request', ts: 1700000000, attrs: { ttft: 0.5, model } });
	assert.deepEqual(extractTtftSamplesFromDebugLog(jl(mk(''), mk(5))), []);
	assert.deepEqual(extractTtftSamplesFromDebugLog(jl(mk('gpt-5'))), [{ tsMs: 1700000000000, model: 'gpt-5', ttftSeconds: 0.5 }]);
});

// --- extractSubAgentData / estimateTokensFromText ---

test('extractSubAgentData: only toolInvocationSerialized items qualify', () => {
	const tsd = { kind: 'subagent', prompt: 'p', result: 'r' };
	assert.equal(extractSubAgentData({ kind: 'other', toolSpecificData: tsd }), null);
	assert.deepEqual(extractSubAgentData({ kind: 'toolInvocationSerialized', toolSpecificData: tsd }), { prompt: 'p', result: 'r', modelName: '' });
});

test('extractSubAgentData: streaming-char results are ordered numerically, negatives first', () => {
	const item = { kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'subagent', prompt: '', result: { 0: 'b', '-1': 'a', 1: 'c', '-2': 'z' } } };
	// Object.entries yields 0,1 (integer keys) then -1,-2 (insertion order); numeric sort gives -2,-1,0,1
	assert.equal(extractSubAgentData(item)?.result, 'zabc');
});

test('estimateTokensFromText: default model is gpt-4', () => {
	assert.equal(estimateTokensFromText('abcd', undefined, { 'gpt-4': 0.5 }), 2);
	assert.equal(estimateTokensFromText('abcd', 'claude', { 'gpt-4': 0.5 }), 1);
});

// --- isJsonlContent ---

test('isJsonlContent: whitespace-only lines are ignored and both lines must be {...}', () => {
	assert.equal(isJsonlContent('{"a":1}\n   \n{"b":2}'), true);
	assert.equal(isJsonlContent('{"a":1}\n{"b":2}'), true);
	assert.equal(isJsonlContent('[1]\n{"b":2}'), false);       // first must start with {
	assert.equal(isJsonlContent('{"a":1\n{"b":2}'), false);    // first must end with }
	assert.equal(isJsonlContent('{"a":1}\n"b"}'), false);      // second must start with {
	assert.equal(isJsonlContent('{"a":1}\n{"b":2'), false);    // second must end with }
});

// --- selectTokenEstimationStrategy ---

test('selectTokenEstimationStrategy: whitespace-only lines do not use up the detection budget', () => {
	const lines = [...Array(12).fill('   '), JSON.stringify({ kind: 0, v: {} })];
	assert.ok(selectTokenEstimationStrategy(lines) instanceof DeltaTokenStrategy);
});

// --- buildReasoningEffortTimeline ---

const effortModel = (effort: string) => ({ metadata: { configurationSchema: { properties: { reasoningEffort: { default: effort } } } } });

test('buildReasoningEffortTimeline: null at any level of the model path yields no effort', () => {
	const nulls = [
		null,
		{ metadata: null },
		{ metadata: { configurationSchema: null } },
		{ metadata: { configurationSchema: { properties: null } } },
		{ metadata: { configurationSchema: { properties: { reasoningEffort: null } } } },
	];
	for (const selectedModel of nulls) {
		const out = buildReasoningEffortTimeline([jl({ kind: 0, v: { inputState: { selectedModel } } })]);
		assert.equal(out.defaultEffort, null);
		assert.equal(out.switchCount, 0);
	}
});

test('buildReasoningEffortTimeline: kind:0 without a payload, or without a model, keeps the previous effort', () => {
	const out = buildReasoningEffortTimeline([
		jl({ kind: 0, v: { inputState: { selectedModel: effortModel('high') } } }),
		jl({ kind: 0 }),
		jl({ kind: 0, v: { inputState: { selectedModel: {} } } }),
		jl({ kind: 2, k: ['requests', 0], v: { requestId: 'r1' } }),
	]);
	assert.equal(out.defaultEffort, 'high');
	assert.deepEqual([...out.effortByRequestId], [['r1', 'high']]);
});

test('buildReasoningEffortTimeline: null or primitive request payloads are ignored', () => {
	const out = buildReasoningEffortTimeline([
		jl({ kind: 0, v: { inputState: { selectedModel: effortModel('low') } } }),
		jl({ kind: 2, k: ['requests', 0], v: null }),
		jl({ kind: 2, k: ['requests', 1], v: 'text' }),
	]);
	assert.equal(out.effortByRequestId.size, 0);
});

test('buildReasoningEffortTimeline: only kind 2 deltas record request efforts', () => {
	const out = buildReasoningEffortTimeline([
		jl({ kind: 0, v: { inputState: { selectedModel: effortModel('low') } } }),
		jl({ kind: 3, k: ['requests', 0], v: { requestId: 'r1' } }),
	]);
	assert.equal(out.effortByRequestId.size, 0);
});

// --- applyDelta ---

test('applyDelta: null and primitive deltas leave the state untouched', () => {
	const state = { a: 1 };
	assert.equal(applyDelta(state, null), state);
	assert.equal(applyDelta(state, 'x'), state);
	assert.equal(applyDelta(state, 5), state);
});

test('applyDelta: intermediate nodes are created as arrays only for pure-digit next segments', () => {
	assert.deepEqual(applyDelta({}, { kind: 1, k: ['a', '1x', 'y'], v: 1 }), { a: { '1x': { y: 1 } } });
	assert.deepEqual(applyDelta({}, { kind: 1, k: ['a', 'x1', 'y'], v: 1 }), { a: { x1: { y: 1 } } });
	const multi = applyDelta({}, { kind: 1, k: ['a', '12', 'y'], v: 1 }) as { a: unknown };
	assert.ok(Array.isArray(multi.a));
});

test('applyDelta: created arrays are empty (no phantom elements)', () => {
	const viaObject = applyDelta({}, { kind: 1, k: ['m', 1, 'x'], v: 9 }) as { m: unknown[] };
	assert.equal(viaObject.m[0], undefined);
	assert.equal(0 in viaObject.m, false);
	assert.deepEqual(viaObject.m[1], { x: 9 });

	const viaArray = applyDelta({}, { kind: 1, k: ['m', 0, 1, 'x'], v: 9 }) as { m: unknown[][] };
	assert.equal(0 in viaArray.m[0], false);
	assert.deepEqual(viaArray.m[0][1], { x: 9 });
});

test('applyDelta: non-object intermediates are replaced, including null and truthy primitives', () => {
	for (const bad of [null, 'str', 0, 7]) {
		const inObject = applyDelta({ a: bad }, { kind: 1, k: ['a', 'b'], v: 1 });
		assert.deepEqual(inObject, { a: { b: 1 } });
		const inArray = applyDelta({ list: [bad] }, { kind: 1, k: ['list', 0, 'b'], v: 1 });
		assert.deepEqual(inArray, { list: [{ b: 1 }] });
	}
});

// --- delta strategy: JSON.parse-failure fallback ---

/** A request result in a shape the structured readers skip but the raw-line regex still finds. */
const rawOnlyResultLine = jl({ kind: 1, k: ['requests', 0, 'result'], v: { odd: { promptTokens: 10, completionTokens: 5 } } });

test('DeltaTokenStrategy: raw-line fallback runs only when some line failed to parse', () => {
	const base = [delta([{}]), rawOnlyResultLine];
	assert.equal(new DeltaTokenStrategy().estimate(base).actualTokens, 0);
	assert.equal(new DeltaTokenStrategy().estimate([...base, '{broken']).actualTokens, 15);
});

test('DeltaTokenStrategy: blank lines are skipped and do not count as parse failures', () => {
	const base = [delta([{}]), rawOnlyResultLine];
	assert.equal(new DeltaTokenStrategy().estimate([...base, '']).actualTokens, 0);
	assert.equal(new DeltaTokenStrategy().estimate([...base, '   ']).actualTokens, 0);
});

test('DeltaTokenStrategy: kind:2 events without a path are ignored, not treated as parse failures', () => {
	const noPath = jl({ kind: 2, v: [{ message: { text: 'abcdefgh' }, value: 'abcdefgh' }] });
	const out = new DeltaTokenStrategy().estimate([delta([{}]), noPath, rawOnlyResultLine]);
	assert.equal(out.actualTokens, 0);
	assert.equal(out.tokens, 0);
});

test('DeltaTokenStrategy: kind:2 appends outside "response" paths add no response tokens', () => {
	const append = jl({ kind: 2, k: ['requests'], v: [{ value: 'abcdefgh' }] });
	assert.equal(new DeltaTokenStrategy().estimate([delta([]), append]).tokens, 0);
});

test('DeltaTokenStrategy: sub-agent items appended to a response are counted once, from final state', () => {
	const item = { kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'subagent', prompt: 'p', result: 'r' }, value: 'abcdefgh' };
	const append = jl({ kind: 2, k: ['requests', 0, 'response'], v: [item] });
	// prompt 'p' = 1 token, result 'r' = 1 token; the wrapper `value` (2 tokens) must not be added
	assert.equal(new DeltaTokenStrategy().estimate([delta([{}]), append]).tokens, 2);
});

test('DeltaTokenStrategy: maxRequestInputTokens skips usage blocks without promptTokens', () => {
	const out = new DeltaTokenStrategy().estimate([delta([
		{ result: { usage: { completionTokens: 3 } } },
		{ result: { usage: { promptTokens: 7, completionTokens: 2 } } },
	])]);
	assert.equal(out.actualTokens, 12);
	assert.equal(out.maxRequestInputTokens, 7);
});

// --- event JSONL strategy: data-less events keep their later fallbacks ---

const estimateEvents = (...events: unknown[]) => estimateTokensFromJsonlSession(jl(...events));

test('EventJsonlTokenStrategy: usage_checkpoint / shutdown / context / truncation events without data still fall through to content', () => {
	// 'abcdefgh' = 2 tokens through the generic `event.content` branch
	for (const type of ['session.usage_checkpoint', 'session.shutdown', 'session.start', 'session.truncation']) {
		assert.equal(estimateEvents({ type, content: 'abcdefgh' }).tokens, 2, type);
	}
	// shutdown with data but no modelMetrics must not create an accumulator or abort the event
	const out = estimateEvents({ type: 'session.shutdown', data: {}, content: 'abcdefgh' });
	assert.equal(out.tokens, 2);
	assert.equal(out.actualTokens, 0);
	assert.deepEqual(out.modelUsage, {});
});

test('EventJsonlTokenStrategy: user messages without data fall back to event.content', () => {
	assert.equal(estimateEvents({ type: 'user.message', content: 'abcdefgh' }).tokens, 2);
	assert.equal(estimateEvents({ type: 'user.message_rendered', content: 'abcdefgh' }).tokens, 2);
});

test('EventJsonlTokenStrategy: user.message_rendered with no renderedMessage adds nothing', () => {
	assert.equal(estimateEvents({ type: 'user.message_rendered', data: {} }).tokens, 0);
	assert.equal(estimateEvents({ type: 'user.message_rendered', data: { renderedMessage: 'abcd' } }).tokens, 1);
});

test('EventJsonlTokenStrategy: assistant.message with zero real output and no content adds nothing', () => {
	assert.equal(estimateEvents({ type: 'assistant.message', data: { outputTokens: 0 } }).tokens, 0);
	assert.equal(estimateEvents({ type: 'assistant.message', data: { outputTokens: 0, content: 'abcd' } }).tokens, 1);
});

// --- extractResponseItemText ---

test('extractResponseItemText: non-object items yield empty non-thinking text', () => {
	assert.deepEqual(extractResponseItemText(null), { text: '', isThinking: false });
	assert.deepEqual(extractResponseItemText('abc'), { text: '', isThinking: false });
});

// --- getModelFromRequest / auto resolution ---

const autoItem = (resolved: unknown) => ({ kind: 'autoModeResolution', resolved });

test('getModelFromRequest: auto resolution skips unusable items and returns the first valid id', () => {
	const bad = [autoItem({ id: 5 }), autoItem({ id: '' }), autoItem({ id: 'auto' }), autoItem({ id: 'copilot/auto' }), autoItem({}), autoItem(null)];
	const good = autoItem({ id: 'copilot/gpt-5' });
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [...bad, good] } as never), 'gpt-5');
});

test('getModelFromRequest: only a leading "copilot/" prefix is stripped', () => {
	assert.equal(getModelFromRequest({ modelId: 'a/copilot/b' } as never), 'a/copilot/b');
	assert.equal(getModelFromRequest({ modelId: 'copilot/b' } as never), 'b');
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [autoItem({ id: 'x/copilot/y' })] } as never), 'x/copilot/y');
	assert.equal(getModelFromRequest({ modelId: 'auto', result: { metadata: { modelId: 'x/copilot/y' } } } as never), 'x/copilot/y');
	assert.equal(getModelFromRequest({ modelId: 'auto', result: { metadata: { modelId: 'copilot/y' } } } as never), 'y');
});

// --- pricing lookups: exact match wins over partial ---

const price = (extra: Partial<ModelPricing> = {}): ModelPricing => ({ inputCostPerMillion: 1, outputCostPerMillion: 2, ...extra });

test('getModelTier: an exact pricing entry wins over an earlier partial match', () => {
	const pricing = { 'gpt': price({ tier: 'standard' }), 'gpt-5': price({ tier: 'premium' }) };
	assert.equal(getModelTier('gpt-5', pricing), 'premium');
});

test('getModelCostBucket: an exact pricing entry wins over an earlier partial match', () => {
	const pricing = { 'gpt': price({ inputCostPerMillion: 0.5 }), 'gpt-5': price({ inputCostPerMillion: 10 }) };
	assert.equal(getModelCostBucket('gpt-5', pricing), 'high');
});

test('getLongContextInfo: an exact pricing entry wins over an earlier partial match', () => {
	const longContext = { threshold: '> 200K', inputCostPerMillion: 7, outputCostPerMillion: 9 };
	const pricing = {
		'gpt-5-mini': price(),
		'gpt-5': price({ copilotPricing: { inputCostPerMillion: 3, outputCostPerMillion: 4, longContext } as never }),
	};
	assert.deepEqual(getLongContextInfo('gpt-5', pricing), {
		thresholdTokens: 200000,
		defaultInputCostPerMillion: 3,
		longContextInputCostPerMillion: 7,
	});
});

// --- attachEstimatedTurnCosts ---

const turnPricing = { 'gpt-x': price({ inputCostPerMillion: 1_000_000, outputCostPerMillion: 2_000_000 }) };

function makeTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
	return {
		turnNumber: 1, timestamp: null, mode: 'agent', userMessage: '', assistantResponse: '', model: 'gpt-x',
		toolCalls: [], contextReferences: createEmptyContextRefs(), mcpTools: [],
		inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokensEstimate: 0,
		...overrides,
	};
}

test('attachEstimatedTurnCosts: cost is set when either input or output is positive, and a model is present', () => {
	const inputOnly = makeTurn({ inputTokensEstimate: 1 });
	const outputOnly = makeTurn({ outputTokensEstimate: 1 });
	const neither = makeTurn();
	const noModel = makeTurn({ model: null, inputTokensEstimate: 1, outputTokensEstimate: 1 });
	attachEstimatedTurnCosts([inputOnly, outputOnly, neither, noModel], turnPricing, 'provider');
	assert.equal(inputOnly.estimatedCost, 1);
	assert.equal(outputOnly.estimatedCost, 2);
	assert.equal('estimatedCost' in neither, false);
	assert.equal('estimatedCost' in noModel, false);
});

test('attachEstimatedTurnCosts: actual usage overrides the estimates, including a zero actual', () => {
	const t = makeTurn({ inputTokensEstimate: 5, outputTokensEstimate: 5, actualUsage: { promptTokens: 1, completionTokens: 0 } as never });
	attachEstimatedTurnCosts([t], turnPricing, 'provider');
	assert.equal(t.estimatedCost, 1);
});

test('attachEstimatedTurnCosts: a model without pricing gets no estimatedCost', () => {
	const t = makeTurn({ model: 'unpriced', inputTokensEstimate: 10 });
	attachEstimatedTurnCosts([t], turnPricing, 'provider');
	assert.equal('estimatedCost' in t, false);
});

test('attachEstimatedTurnCosts: sub-agent cost needs a sub-agent flag, a model and tokens', () => {
	const tokens = { input: 1, output: 1 };
	const t = makeTurn({
		toolCalls: [
			{ toolName: 'a', isSubAgent: true, subAgentModel: 'gpt-x', subAgentTokens: tokens },
			{ toolName: 'b', isSubAgent: false, subAgentModel: 'gpt-x', subAgentTokens: tokens },
			{ toolName: 'c', isSubAgent: true, subAgentTokens: tokens },
			{ toolName: 'd', isSubAgent: true, subAgentModel: 'gpt-x' },
			{ toolName: 'e', isSubAgent: true, subAgentModel: 'unpriced', subAgentTokens: tokens },
			{ toolName: 'f', isSubAgent: true, subAgentModel: 'gpt-x', subAgentTokens: { input: 0, output: 0 } },
		],
	});
	attachEstimatedTurnCosts([t], turnPricing, 'provider');
	assert.equal(t.toolCalls[0].subAgentCost, 3);
	for (const tc of t.toolCalls.slice(1)) {
		assert.equal('subAgentCost' in tc, false, tc.toolName);
	}
});

test('DeltaTokenStrategy: a stray empty metadata block does not hide usage-format prompt tokens', () => {
	const out = new DeltaTokenStrategy().estimate([delta([
		{ result: { metadata: {}, usage: { promptTokens: 7, completionTokens: 2 } } },
	])]);
	assert.equal(out.actualTokens, 9);
	assert.equal(out.maxRequestInputTokens, 7);
});

test('DeltaTokenStrategy: only kind:2 appends contribute response tokens', () => {
	const set = jl({ kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'abcdefgh' }] });
	assert.equal(new DeltaTokenStrategy().estimate([delta([{}]), set]).tokens, 0);
	const append = jl({ kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'abcdefgh' }] });
	assert.equal(new DeltaTokenStrategy().estimate([delta([{}]), append]).tokens, 2);
});
