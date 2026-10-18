/**
 * Boundary / exact-value tests for src/tokenEstimation.ts, written to kill
 * surviving Stryker mutants (refs #2341): number-coercion guards, sums, index-scan
 * boundaries and threshold comparisons. Every assertion pins an exact value.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	NANO_AIU_TO_DOLLARS,
	applyDelta,
	buildReasoningEffortTimeline,
	createEmptyContextRefs,
	estimateTokensFromJsonlSession,
	estimateTokensFromText,
	extractAllTokensFromDebugLog,
	extractCachedTokensFromDebugLog,
	extractPerRequestUsageFromRawLines,
	extractResponseItemText,
	extractSubAgentData,
	extractTtftSamplesFromDebugLog,
	getLongContextInfo,
	getModelCostBucket,
	getModelFromRequest,
	getModelTier,
	getRequestResult,
	getResponseArray,
	getTotalTokensFromModelUsage,
	isCopilotAutoRequest,
	isJsonlContent,
	isUuidPointerFile,
	normalizeDisplayModelName,
	parseContextThreshold,
	reconstructJsonlStateAsync,
	selectTokenEstimationStrategy,
	DeltaTokenStrategy,
	EventJsonlTokenStrategy,
} from '../tokenEstimation';

const jl = (...events: unknown[]): string => events.map(e => JSON.stringify(e)).join('\n');
const delta = (requests: unknown[]): string => jl({ kind: 0, v: { requests } });
const chars = (n: number): string => 'x'.repeat(n);

// --- estimateTokensFromText ---

test('estimateTokensFromText: default ratio is 0.25 tokens/char and rounds up', () => {
	assert.equal(estimateTokensFromText(''), 0);
	assert.equal(estimateTokensFromText('abcd'), 1);
	assert.equal(estimateTokensFromText('abcde'), 2);
	assert.equal(estimateTokensFromText(chars(100)), 25);
});

test('estimateTokensFromText: model estimator matches by key or dash-stripped key, first match wins', () => {
	const est = { 'gpt-4o': 0.5, 'gpt': 2 };
	assert.equal(estimateTokensFromText(chars(10), 'gpt-4o', est), 5);
	assert.equal(estimateTokensFromText(chars(10), 'gpt4o-mini', est), 5); // normalized key 'gpt4o'
	assert.equal(estimateTokensFromText(chars(10), 'gpt-3', est), 20); // falls to the second estimator
	assert.equal(estimateTokensFromText(chars(10), 'claude', est), 3); // default 0.25 -> ceil(2.5)
});

test('normalizeDisplayModelName trims, lower-cases and dashes whitespace runs', () => {
	assert.equal(normalizeDisplayModelName('  Claude  Haiku 4.5 '), 'claude-haiku-4.5');
});

// --- accessors ---

test('getRequestResult / getResponseArray only accept objects with the right member shape', () => {
	assert.equal(getRequestResult(null), undefined);
	assert.equal(getRequestResult('x'), undefined);
	assert.equal(getRequestResult({ result: null }), undefined);
	assert.equal(getRequestResult({ result: 'x' }), undefined);
	assert.equal(getRequestResult({}), undefined);
	const r = { promptTokens: 1 };
	assert.equal(getRequestResult({ result: r }), r);
	assert.equal(getResponseArray(null), undefined);
	assert.equal(getResponseArray(5), undefined);
	assert.equal(getResponseArray({ response: {} }), undefined);
	assert.equal(getResponseArray({}), undefined);
	const arr = [1];
	assert.equal(getResponseArray({ response: arr }), arr);
});

// --- extractSubAgentData ---

test('extractSubAgentData: guards, streaming-char results and model-name normalization', () => {
	const mk = (tsd: unknown) => ({ kind: 'toolInvocationSerialized', toolSpecificData: tsd });
	assert.equal(extractSubAgentData(null), null);
	assert.equal(extractSubAgentData('x'), null);
	assert.equal(extractSubAgentData({ kind: 'other' }), null);
	assert.equal(extractSubAgentData(mk(null)), null);
	assert.equal(extractSubAgentData(mk('subagent')), null);
	assert.equal(extractSubAgentData(mk({ kind: 'other', prompt: 'p' })), null);
	assert.equal(extractSubAgentData(mk({ kind: 'subagent' })), null);
	assert.equal(extractSubAgentData(mk({ kind: 'subagent', prompt: 5, result: null })), null);
	assert.deepEqual(extractSubAgentData(mk({ kind: 'subagent', prompt: 'P', result: 'R', modelName: 'Claude Haiku 4.5' })),
		{ prompt: 'P', result: 'R', modelName: 'claude-haiku-4.5' });
	assert.deepEqual(extractSubAgentData(mk({ kind: 'subagent', result: 'R', modelName: 7 })),
		{ prompt: '', result: 'R', modelName: '' });
	// numeric (not lexicographic) key order; non-string values contribute ''
	const streaming: Record<string, unknown> = { '10': 'c', '2': 'b', '1': 'a', '3': 9 };
	assert.deepEqual(extractSubAgentData(mk({ kind: 'subagent', result: streaming })),
		{ prompt: '', result: 'abc', modelName: '' });
	assert.deepEqual(extractSubAgentData(mk({ kind: 'subagent', prompt: 'P' })),
		{ prompt: 'P', result: '', modelName: '' });
});

// --- extractResponseItemText ---

test('extractResponseItemText: thinking needs string value; content.value wins over value', () => {
	assert.deepEqual(extractResponseItemText(null), { text: '', isThinking: false });
	assert.deepEqual(extractResponseItemText('str'), { text: '', isThinking: false });
	assert.deepEqual(extractResponseItemText({ kind: 'thinking', value: 'deep' }), { text: 'deep', isThinking: true });
	assert.deepEqual(extractResponseItemText({ kind: 'thinking', value: 42 }), { text: '', isThinking: true });
	assert.deepEqual(extractResponseItemText({ kind: 'thinking', content: { value: 'c' } }), { text: '', isThinking: true });
	assert.deepEqual(extractResponseItemText({ value: 'v', content: { value: 'c' } }), { text: 'c', isThinking: false });
	assert.deepEqual(extractResponseItemText({ value: 'v', content: { value: '' } }), { text: 'v', isThinking: false });
	assert.deepEqual(extractResponseItemText({ value: 'v', content: { value: 3 } }), { text: 'v', isThinking: false });
	assert.deepEqual(extractResponseItemText({ value: 'v', content: null }), { text: 'v', isThinking: false });
	assert.deepEqual(extractResponseItemText({ value: '' }), { text: '', isThinking: false });
	assert.deepEqual(extractResponseItemText({ value: 5 }), { text: '', isThinking: false });
	assert.deepEqual(extractResponseItemText({}), { text: '', isThinking: false });
});

test('NANO_AIU_TO_DOLLARS is exactly 1e-11', () => {
	assert.equal(NANO_AIU_TO_DOLLARS, 1e-11);
	assert.equal(5e11 * NANO_AIU_TO_DOLLARS, 5);
});

// --- DeltaTokenStrategy: actual-token extraction ---

function actual(requests: unknown[]) {
	return estimateTokensFromJsonlSession(delta(requests));
}

test('delta actual tokens: top-level promptTokens + outputTokens are summed exactly', () => {
	const r = actual([{ result: { promptTokens: 100, outputTokens: 50 } }]);
	assert.equal(r.actualTokens, 150);
	assert.equal(r.maxRequestInputTokens, 100);
});

test('delta actual tokens: both top-level fields must be numbers', () => {
	for (const result of [
		{ promptTokens: '100', outputTokens: 50 },
		{ promptTokens: 100, outputTokens: '50' },
		{ promptTokens: null, outputTokens: 50 },
		{ promptTokens: 100 },
		{ outputTokens: 50 },
	]) {
		const r = actual([{ result }]);
		assert.equal(r.actualTokens, 0, JSON.stringify(result));
		assert.equal('maxRequestInputTokens' in r, false, JSON.stringify(result));
	}
});

test('delta actual tokens: metadata format requires both numeric fields', () => {
	const ok = actual([{ result: { metadata: { promptTokens: 20, outputTokens: 5 } } }]);
	assert.equal(ok.actualTokens, 25);
	assert.equal(ok.maxRequestInputTokens, 20);
	for (const metadata of [
		{ promptTokens: '20', outputTokens: 5 },
		{ promptTokens: 20, outputTokens: '5' },
		{ promptTokens: 20 },
		{ outputTokens: 5 },
		null,
	]) {
		assert.equal(actual([{ result: { metadata } }]).actualTokens, 0, JSON.stringify(metadata));
	}
	// metadata incomplete -> falls through to usage
	const viaUsage = actual([{ result: { metadata: { promptTokens: 20 }, usage: { promptTokens: 7, completionTokens: 3 } } }]);
	assert.equal(viaUsage.actualTokens, 10);
	assert.equal(viaUsage.maxRequestInputTokens, 20); // metadata.promptTokens is numeric, so it wins the prompt-size lookup
});

test('delta actual tokens: top-level wins over metadata, metadata wins over usage', () => {
	const r = actual([{ result: {
		promptTokens: 1, outputTokens: 2,
		metadata: { promptTokens: 10, outputTokens: 20 },
		usage: { promptTokens: 100, completionTokens: 200 },
	} }]);
	assert.equal(r.actualTokens, 3);
	const m = actual([{ result: {
		metadata: { promptTokens: 10, outputTokens: 20 },
		usage: { promptTokens: 100, completionTokens: 200 },
	} }]);
	assert.equal(m.actualTokens, 30);
	assert.equal(m.maxRequestInputTokens, 10);
});

test('delta actual tokens: usage format counts each numeric field independently', () => {
	assert.equal(actual([{ result: { usage: { promptTokens: 7, completionTokens: 3 } } }]).actualTokens, 10);
	assert.equal(actual([{ result: { usage: { promptTokens: 7 } } }]).actualTokens, 7);
	assert.equal(actual([{ result: { usage: { completionTokens: 3 } } }]).actualTokens, 3);
	assert.equal(actual([{ result: { usage: { promptTokens: '7', completionTokens: 3 } } }]).actualTokens, 3);
	assert.equal(actual([{ result: { usage: { promptTokens: 7, completionTokens: '3' } } }]).actualTokens, 7);
	assert.equal(actual([{ result: { usage: {} } }]).actualTokens, 0);
	// usage with only completionTokens has no prompt -> no maxRequestInputTokens
	assert.equal('maxRequestInputTokens' in actual([{ result: { usage: { completionTokens: 3 } } }]), false);
});

test('delta maxRequestInputTokens: prompt size comes from the first matching source and max wins across requests', () => {
	// output missing at top level, so tokens come from usage, but the prompt max prefers the top-level promptTokens
	const r = actual([{ result: { promptTokens: 100, usage: { promptTokens: 7, completionTokens: 3 } } }]);
	assert.equal(r.actualTokens, 10);
	assert.equal(r.maxRequestInputTokens, 100);
	const viaMeta = actual([{ result: { metadata: { promptTokens: 40 }, usage: { promptTokens: 7, completionTokens: 3 } } }]);
	assert.equal(viaMeta.maxRequestInputTokens, 40);
	const bigFirst = actual([
		{ result: { promptTokens: 300, outputTokens: 1 } },
		{ result: { promptTokens: 20, outputTokens: 1 } },
	]);
	assert.equal(bigFirst.actualTokens, 322);
	assert.equal(bigFirst.maxRequestInputTokens, 300);
	const bigLast = actual([
		{ result: { promptTokens: 20, outputTokens: 1 } },
		{ result: { promptTokens: 300, outputTokens: 1 } },
	]);
	assert.equal(bigLast.maxRequestInputTokens, 300);
});

test('delta actual tokens: zero-valued results contribute nothing and are not "actual"', () => {
	const r = actual([{ result: { promptTokens: 0, outputTokens: 0 } }, { result: { promptTokens: 4, outputTokens: 1 } }]);
	assert.equal(r.actualTokens, 5);
	assert.equal(r.maxRequestInputTokens, 4);
	assert.equal(actual([{ result: { promptTokens: 0, outputTokens: 0 } }]).actualTokens, 0);
	assert.equal(actual([{}, null, 'x', { result: 'x' }]).actualTokens, 0);
});

// --- DeltaTokenStrategy: regex fallback and index scan boundaries ---

const BAD_ESCAPE_RESULT = (i: number, p: number, o: number) =>
	`{"kind":1,"k":["requests",${i},"result"],"v":{"promptTokens":${p},"outputTokens":${o},"x":"\\q"}}`;

test('delta fallback: a result line that fails JSON.parse is recovered by regex for index within requests', () => {
	const content = [delta([{}, {}]), BAD_ESCAPE_RESULT(1, 10, 5)].join('\n');
	const r = estimateTokensFromJsonlSession(content);
	assert.equal(r.actualTokens, 15);
	assert.equal(r.maxRequestInputTokens, 10);
});

test('delta fallback: index equal to requests.length (one past the end) is still scanned', () => {
	// requests.length === 1, fallback index 1 -> maxIndex must grow to 2 and the loop must include i === 1
	const content = [delta([{}]), BAD_ESCAPE_RESULT(1, 10, 5)].join('\n');
	assert.equal(estimateTokensFromJsonlSession(content).actualTokens, 15);
	// empty requests, fallback index 0
	const empty = [delta([]), BAD_ESCAPE_RESULT(0, 8, 2)].join('\n');
	assert.equal(estimateTokensFromJsonlSession(empty).actualTokens, 10);
	// far beyond the request list
	const far = [delta([{}]), BAD_ESCAPE_RESULT(4, 6, 1)].join('\n');
	assert.equal(estimateTokensFromJsonlSession(far).actualTokens, 7);
});

test('delta fallback: several fallback entries are all counted and the highest index extends the scan', () => {
	const content = [delta([]), BAD_ESCAPE_RESULT(0, 1, 1), BAD_ESCAPE_RESULT(2, 20, 10), BAD_ESCAPE_RESULT(1, 3, 3)].join('\n');
	const r = estimateTokensFromJsonlSession(content);
	assert.equal(r.actualTokens, 2 + 30 + 6);
	assert.equal(r.maxRequestInputTokens, 20);
});

test('delta fallback: a real result in state takes precedence over the regex-recovered one', () => {
	const content = [delta([{ result: { promptTokens: 100, outputTokens: 50 } }]), BAD_ESCAPE_RESULT(0, 1, 1)].join('\n');
	const r = estimateTokensFromJsonlSession(content);
	assert.equal(r.actualTokens, 150);
	assert.equal(r.maxRequestInputTokens, 100);
});

test('delta fallback: not consulted when every line parses', () => {
	// A line that mentions "result" and would match the regex, but is valid JSON about another path.
	const content = jl({ kind: 0, v: { requests: [] } }, { kind: 1, k: ['requests', 0, 'result'], v: { promptTokens: 10, outputTokens: 5 } });
	// applyDelta reconstructs requests[0].result, so this is counted from state, once.
	assert.equal(estimateTokensFromJsonlSession(content).actualTokens, 15);
});

test('extractPerRequestUsageFromRawLines: formats, precedence and rejection of partial data', () => {
	const m = extractPerRequestUsageFromRawLines([
		'{"k": ["requests", 3, "result"], "v": {"promptTokens":10,"outputTokens":4}}',
		'{"k":["requests",12,"result"],"v":{"promptTokens":7,"completionTokens":2}}',
		'{"k":["requests",5,"result"],"v":{"promptTokens":1,"outputTokens":0,"completionTokens":9}}',
		'{"k":["requests",6,"result"],"v":{"promptTokens":11}}',
		'{"k":["requests",7,"result"],"v":{"outputTokens":11}}',
		'{"k":["requests",8,"other"],"v":{"promptTokens":1,"outputTokens":1}}',
		'{"k":["requests",9,"x"],"v":{"note":"result","promptTokens":1,"outputTokens":1}}',
		'no match at all',
	]);
	assert.deepEqual([...m.entries()].sort((a, b) => a[0] - b[0]), [
		[3, { promptTokens: 10, outputTokens: 4 }],
		[5, { promptTokens: 1, outputTokens: 0 }],
		[12, { promptTokens: 7, outputTokens: 2 }],
	]);
});

// --- DeltaTokenStrategy: estimated tokens ---

test('delta estimation: kind:2 request message text, response items and thinking are estimated separately', () => {
	const content = jl(
		{ kind: 0, v: { requests: [] } },
		{ kind: 2, k: ['requests'], v: [{ message: { text: chars(8) } }, { message: {} }, { message: { text: chars(4) } }] },
		{ kind: 2, k: ['requests', 0, 'response'], v: [{ value: chars(16) }, { kind: 'thinking', value: chars(40) }, { value: '' }] },
	);
	const r = estimateTokensFromJsonlSession(content);
	assert.equal(r.thinkingTokens, 10);
	assert.equal(r.tokens, 2 + 1 + 4 + 10);
	assert.equal(r.actualTokens, 0);
});

test('delta estimation: non-matching kind:2 events and non-array values add nothing', () => {
	const content = jl(
		{ kind: 0, v: { requests: [] } },
		{ kind: 1, k: ['requests'], v: [{ message: { text: chars(40) } }] },
		{ kind: 2, k: ['other'], v: [{ message: { text: chars(40) } }] },
		{ kind: 2, k: ['requests'], v: { message: { text: chars(40) } } },
		{ kind: 2, k: ['requests', 0, 'other'], v: [{ value: chars(40) }] },
		{ kind: 2, k: ['requests', 0, 'response'], v: 'str' },
	);
	assert.equal(estimateTokensFromJsonlSession(content).tokens, 0);
});

test('delta estimation: sub-agent prompt/result are counted once from the final state, not per delta', () => {
	const sub = { kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'subagent', prompt: chars(4), result: chars(8) } };
	const onlyPrompt = { kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'subagent', prompt: chars(20) } };
	const content = jl(
		{ kind: 0, v: { requests: [{ response: [sub, onlyPrompt, { value: chars(12) }] }, { response: 'nope' }, 5] } },
		{ kind: 2, k: ['requests', 0, 'response'], v: [sub] },
	);
	const r = estimateTokensFromJsonlSession(content);
	// incremental: the appended sub-agent item is skipped; final state has 2 sub-agent items ... plus the appended one
	assert.equal(r.tokens, (1 + 2) + 5 + (1 + 2));
});

test('delta strategy ignores blank lines and counts unparsable lines only to enable the fallback', () => {
	const r = new DeltaTokenStrategy().estimate(['', '   ', JSON.stringify({ kind: 0, v: { requests: [] } }), 'not json']);
	assert.deepEqual(r, {
		tokens: 0, thinkingTokens: 0, actualTokens: 0, cacheReadTokens: 0, modelUsage: {},
		dailyActualTokens: {}, copilotNanoAiu: 0,
	});
});

// --- strategy selection ---

test('selectTokenEstimationStrategy: kind must be numeric and within the first 10 non-empty lines', () => {
	const ev = JSON.stringify({ type: 'user.message', data: { content: 'x' } });
	const kind = JSON.stringify({ kind: 0, v: {} });
	assert.ok(selectTokenEstimationStrategy([kind]) instanceof DeltaTokenStrategy);
	assert.ok(selectTokenEstimationStrategy(['', '  ', kind]) instanceof DeltaTokenStrategy);
	assert.ok(selectTokenEstimationStrategy([JSON.stringify({ kind: '0' })]) instanceof EventJsonlTokenStrategy);
	assert.ok(selectTokenEstimationStrategy(['bad json', kind]) instanceof DeltaTokenStrategy);
	// the 10th non-empty line is still inspected, the 11th is not
	assert.ok(selectTokenEstimationStrategy([...Array(9).fill(ev), kind]) instanceof DeltaTokenStrategy);
	assert.ok(selectTokenEstimationStrategy([...Array(10).fill(ev), kind]) instanceof EventJsonlTokenStrategy);
	// blank lines do not consume the budget
	assert.ok(selectTokenEstimationStrategy([...Array(9).fill(ev), ...Array(5).fill(''), kind]) instanceof DeltaTokenStrategy);
	assert.ok(selectTokenEstimationStrategy([]) instanceof EventJsonlTokenStrategy);
});

// --- EventJsonlTokenStrategy ---

const toolStarts = (n: number) => Array.from({ length: n }, () => ({ type: 'tool.execution_start' }));
const asst = (out: number, model?: string) => ({ type: 'assistant.message', data: { outputTokens: out, ...(model ? { model } : {}) } });

test('event ratio estimate: tool-call thresholds are exclusive (5 -> low, 6 -> medium, 20 -> medium, 21 -> high)', () => {
	const run = (tools: number) => estimateTokensFromJsonlSession(jl(...toolStarts(tools), asst(10)));
	for (const [tools, ratio] of [[0, 10], [5, 10], [6, 50], [20, 50], [21, 130]] as const) {
		const r = run(tools);
		assert.equal(r.actualTokens, 10 * ratio + 10, `tools=${tools}`);
		assert.equal(r.cacheReadTokens, 10 * ratio, `tools=${tools}`);
	}
});

test('event ratio estimate: per-model outputs are accumulated and ratio applied to each', () => {
	const r = estimateTokensFromJsonlSession(jl(asst(3, 'a'), asst(4, 'a'), asst(5), asst(2, 'b')));
	// a: 7 -> 70 + 7; unknown: 5 -> 50 + 5; b: 2 -> 20 + 2
	assert.equal(r.actualTokens, 77 + 55 + 22);
	assert.equal(r.cacheReadTokens, 70 + 50 + 20);
});

test('event ratio estimate: rounds the estimated input per model', () => {
	// ratio 10 is integral, so use the medium ratio with an odd output; 50 * 3 = 150
	const r = estimateTokensFromJsonlSession(jl(...toolStarts(6), asst(3, 'm')));
	assert.equal(r.actualTokens, 153);
	assert.equal(r.cacheReadTokens, 150);
});

test('event assistant.message: outputTokens must be a positive number, otherwise content is estimated', () => {
	for (const out of [0, -3, '9', null]) {
		const r = estimateTokensFromJsonlSession(jl({ type: 'assistant.message', data: { outputTokens: out, content: chars(8) } }));
		assert.equal(r.tokens, 2, String(out));
		assert.equal(r.actualTokens, 0, String(out));
	}
	// real output tokens: content is not double counted
	const real = estimateTokensFromJsonlSession(jl({ type: 'assistant.message', data: { outputTokens: 4, content: chars(80) } }));
	assert.equal(real.tokens, 0);
	assert.equal(real.actualTokens, 44);
});

test('event thinking: reasoningText and thinking.text are both counted as thinking tokens', () => {
	const r = estimateTokensFromJsonlSession(jl({
		type: 'assistant.message',
		data: { content: chars(4), reasoningText: chars(8), thinking: { text: chars(12) } },
	}));
	assert.equal(r.thinkingTokens, 2 + 3);
	assert.equal(r.tokens, 1 + 5);
	const none = estimateTokensFromJsonlSession(jl({
		type: 'assistant.message', data: { reasoningText: '', thinking: { text: 5 } },
	}));
	assert.equal(none.thinkingTokens, 0);
	const numeric = estimateTokensFromJsonlSession(jl({ type: 'assistant.message', data: { reasoningText: 99 } }));
	assert.equal(numeric.thinkingTokens, 0);
});

test('event text sources: user messages, rendered messages, tool results and generic content', () => {
	const r = estimateTokensFromJsonlSession(jl(
		{ type: 'user.message', data: { content: chars(8) } },
		{ type: 'user.message_rendered', data: { renderedMessage: chars(16) } },
		{ type: 'tool.execution_complete', data: { result: { detailedContent: chars(12), content: chars(400) } } },
		{ type: 'tool.execution_complete', data: { result: { content: chars(20) } } },
		{ type: 'tool.execution_complete', data: { result: { content: 5 } } },
		{ type: 'tool.execution_complete', data: {} },
		{ type: 'something.else', content: chars(4) },
		{ type: 'user.message', data: {} },
		{ type: 'user.message_rendered', data: {} },
	));
	assert.equal(r.tokens, 2 + 4 + 3 + 5 + 1);
});

test('event shutdown: exact per-model totals, cache and day attribution', () => {
	const r = estimateTokensFromJsonlSession(jl(
		asst(1000, 'm'),
		{ type: 'session.shutdown', timestamp: '2026-03-04T12:00:00Z', data: {
			modelMetrics: { m: { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 25 } } },
		} },
	));
	assert.equal(r.actualTokens, 140); // shutdown wins over the ratio estimate
	assert.equal(r.cacheReadTokens, 25);
	assert.equal(r.modelUsage.m.inputTokens, 100);
	const days = Object.entries(r.dailyActualTokens);
	assert.equal(days.length, 1);
	assert.equal(days[0][1], 140);
	assert.match(days[0][0], /^2026-03-0[345]$/);
});

test('event shutdown: no daily attribution without a timestamp', () => {
	const mk = (timestamp?: string) => estimateTokensFromJsonlSession(jl({
		type: 'session.shutdown', ...(timestamp ? { timestamp } : {}),
		data: { modelMetrics: { m: { usage: { inputTokens: 10, outputTokens: 5 } } } },
	}));
	assert.deepEqual(mk().dailyActualTokens, {});
	assert.equal(mk().actualTokens, 15);
	const noMetrics = estimateTokensFromJsonlSession(jl({ type: 'session.shutdown', timestamp: '2026-03-04T12:00:00Z', data: {} }));
	assert.equal(noMetrics.actualTokens, 0);
	assert.deepEqual(noMetrics.modelUsage, {});
});

test('event nano-AIU: latest positive checkpoint/shutdown value replaces earlier ones; zero/non-number ignored', () => {
	const r = estimateTokensFromJsonlSession(jl(
		{ type: 'session.usage_checkpoint', data: { totalNanoAiu: 100 } },
		{ type: 'session.usage_checkpoint', data: { totalNanoAiu: 250 } },
		{ type: 'session.usage_checkpoint', data: { totalNanoAiu: 0 } },
		{ type: 'session.usage_checkpoint', data: { totalNanoAiu: '999' } },
		{ type: 'session.usage_checkpoint', data: { totalNanoAiu: -5 } },
		{ type: 'session.usage_checkpoint' },
	));
	assert.equal(r.copilotNanoAiu, 250);
	const sd = estimateTokensFromJsonlSession(jl(
		{ type: 'session.usage_checkpoint', data: { totalNanoAiu: 100 } },
		{ type: 'session.shutdown', data: { totalNanoAiu: 400 } },
	));
	assert.equal(sd.copilotNanoAiu, 400);
});

test('event truncation: only events that removed messages are counted', () => {
	const r = estimateTokensFromJsonlSession(jl(
		{ type: 'session.truncation', data: { messagesRemovedDuringTruncation: 3 } },
		{ type: 'session.truncation', data: { messagesRemovedDuringTruncation: 0 } },
		{ type: 'session.truncation', data: { messagesRemovedDuringTruncation: -2 } },
		{ type: 'session.truncation', data: { messagesRemovedDuringTruncation: '4' } },
		{ type: 'session.truncation', data: { messagesRemovedDuringTruncation: 2 } },
		{ type: 'session.truncation' },
	));
	assert.equal(r.truncationCount, 2);
	assert.equal(r.messagesRemovedByTruncation, 5);
	const none = estimateTokensFromJsonlSession(jl({ type: 'session.truncation', data: { messagesRemovedDuringTruncation: 0 } }));
	assert.equal('truncationCount' in none, false);
	assert.equal('messagesRemovedByTruncation' in none, false);
});

test('event context tier: last non-empty string wins from start/resume/model_change only', () => {
	assert.equal(estimateTokensFromJsonlSession(jl(
		{ type: 'session.start', data: { contextTier: 'default' } },
		{ type: 'session.resume', data: { contextTier: '' } },
		{ type: 'session.model_change', data: { contextTier: 5 } },
		{ type: 'session.truncation', data: { contextTier: 'ignored' } },
	)).contextTier, 'default');
	assert.equal(estimateTokensFromJsonlSession(jl(
		{ type: 'session.start', data: { contextTier: 'default' } },
		{ type: 'session.model_change', data: { contextTier: 'large' } },
	)).contextTier, 'large');
	assert.equal(estimateTokensFromJsonlSession(jl({ type: 'session.resume', data: { contextTier: 'r' } })).contextTier, 'r');
	assert.equal('contextTier' in estimateTokensFromJsonlSession(jl({ type: 'session.start', data: {} })), false);
	assert.equal('contextTier' in estimateTokensFromJsonlSession(jl({ type: 'session.other', data: { contextTier: 'x' } })), false);
});

test('estimateTokensFromJsonlSession: exactUsage overrides actuals, nanoAiu falls back when 0', () => {
	const content = jl({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 77 } }, asst(10));
	const withZero = estimateTokensFromJsonlSession(content, { actualTokens: 5, cacheReadTokens: 2, nanoAiu: 0 } as never);
	assert.equal(withZero.actualTokens, 5);
	assert.equal(withZero.cacheReadTokens, 2);
	assert.equal(withZero.copilotNanoAiu, 77);
	const withValue = estimateTokensFromJsonlSession(content, { actualTokens: 5, cacheReadTokens: 2, nanoAiu: 9 } as never);
	assert.equal(withValue.copilotNanoAiu, 9);
	assert.equal(estimateTokensFromJsonlSession(content, null).actualTokens, 110);
});

test('EventJsonlTokenStrategy skips blank and invalid lines', () => {
	const r = new EventJsonlTokenStrategy().estimate(['', '  ', 'oops', JSON.stringify({ type: 'user.message', data: { content: chars(4) } })]);
	assert.equal(r.tokens, 1);
});

// --- reconstructJsonlStateAsync / applyDelta ---

test('reconstructJsonlStateAsync: delta detection, invalid-line skipping and non-delta files', async () => {
	const lines = [JSON.stringify({ kind: 0, v: { a: 1 } }), 'bad', '', JSON.stringify({ kind: 1, k: ['a'], v: 2 })];
	const r = await reconstructJsonlStateAsync(lines, 2);
	assert.equal(r.isDeltaBased, true);
	assert.deepEqual(r.sessionState, { a: 2 });
	const non = await reconstructJsonlStateAsync([JSON.stringify({ type: 'x' })]);
	assert.equal(non.isDeltaBased, false);
	assert.deepEqual(non.sessionState, {});
});

test('applyDelta: kind 0 replaces, kind 1 sets, kind 2 appends, with array/object path creation', () => {
	assert.deepEqual(applyDelta({ old: 1 }, { kind: 0, v: { n: 1 } }), { n: 1 });
	assert.equal(applyDelta('keep', null), 'keep');
	assert.equal(applyDelta('keep', 5), 'keep');
	assert.deepEqual(applyDelta({ a: 1 }, { kind: 1, k: [], v: 2 }), { a: 1 });
	assert.deepEqual(applyDelta({ a: 1 }, { kind: 1, k: 'a', v: 2 }), { a: 1 });
	assert.deepEqual(applyDelta({ a: 1 }, { kind: 1, k: ['a'], v: 2 }), { a: 2 });
	assert.deepEqual(applyDelta(undefined, { kind: 1, k: ['a', 'b'], v: 2 }), { a: { b: 2 } });
	assert.deepEqual(applyDelta(null, { kind: 1, k: ['list', 0, 'x'], v: 1 }), { list: [{ x: 1 }] });
	const sparse = (applyDelta({ list: [] }, { kind: 1, k: ['list', 2], v: 'z' }) as { list: unknown[] }).list;
	assert.equal(sparse.length, 3);
	assert.equal(sparse[2], 'z');
	assert.deepEqual(applyDelta({ list: [{ a: 1 }] }, { kind: 1, k: ['list', 0, 'a'], v: 9 }), { list: [{ a: 9 }] });
	// replaces a primitive on the path
	assert.deepEqual(applyDelta({ a: 5 }, { kind: 1, k: ['a', 'b'], v: 1 }), { a: { b: 1 } });
	assert.deepEqual(applyDelta({ a: null }, { kind: 1, k: ['a', '0'], v: 1 }), { a: [1] });
	// kind 2
	assert.deepEqual(applyDelta({}, { kind: 2, k: ['r'], v: [1, 2] }), { r: [1, 2] });
	assert.deepEqual(applyDelta({ r: [0] }, { kind: 2, k: ['r'], v: 1 }), { r: [0, 1] });
	assert.deepEqual(applyDelta({ r: 'notarray' }, { kind: 2, k: ['r'], v: [1] }), { r: [1] });
	assert.deepEqual(applyDelta({ r: [[1]] }, { kind: 2, k: ['r', 0], v: [2] }), { r: [[1, 2]] });
	const grown = (applyDelta({ r: [] }, { kind: 2, k: ['r', 1], v: [2] }) as { r: unknown[] }).r;
	assert.equal(grown.length, 2);
	assert.deepEqual(grown[1], [2]);
	// unknown kind leaves state intact
	assert.deepEqual(applyDelta({ a: 1 }, { kind: 9, k: ['a'], v: 2 }), { a: 1 });
});

// --- debug-log extraction ---

const llm = (attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'llm_request', attrs, ...extra });

test('extractAllTokensFromDebugLog: sums, per-model breakdown, max input and null when empty', () => {
	const content = [
		llm({ inputTokens: 100, outputTokens: 10, cachedTokens: 40, model: 'm1', copilotUsageNanoAiu: 5 }),
		'',
		'garbage',
		JSON.stringify({ type: 'other', attrs: { inputTokens: 999 } }),
		llm({ inputTokens: 300, outputTokens: 20, cachedTokens: 0, model: 'm1', copilotUsageNanoAiu: 7 }),
		llm({ inputTokens: '5', outputTokens: 1, cachedTokens: 2 }),
		llm({ inputTokens: 50, outputTokens: 2, cachedTokens: 3, model: 'm2', copilotUsageNanoAiu: '9' }),
		llm({ model: '' }),
	].join('\n');
	assert.deepEqual(extractAllTokensFromDebugLog(content), {
		inputTokens: 450, outputTokens: 33, cachedTokens: 45, modelTurns: 5,
		modelBreakdown: {
			m1: { inputTokens: 400, outputTokens: 30, cachedTokens: 40 },
			m2: { inputTokens: 50, outputTokens: 2, cachedTokens: 3 },
		},
		copilotNanoAiu: 12, maxRequestInputTokens: 300,
	});
	assert.equal(extractAllTokensFromDebugLog(''), null);
	assert.equal(extractAllTokensFromDebugLog(JSON.stringify({ type: 'x' })), null);
	assert.equal(extractCachedTokensFromDebugLog(content), 45);
	assert.equal(extractCachedTokensFromDebugLog(''), 0);
	assert.equal(extractAllTokensFromDebugLog('{"type":"llm_request"}')?.modelTurns, 1);
});

test('extractTtftSamplesFromDebugLog: unit normalisation and required fields', () => {
	const content = [
		llm({ ttft: 1.5, model: 'm' }, { ts: 1_700_000_000 }),            // seconds ts, seconds ttft
		llm({ ttft: 2500, model: 'm' }, { ts: 1_700_000_000_000 }),       // ms ts, ms ttft
		llm({ ttft: 99.9, model: 'm' }, { ts: 999_999_999_999 }),         // just under both thresholds
		llm({ ttft: 100, model: 'm' }, { ts: 1_000_000_000_000 }),        // exactly at both thresholds
		llm({ ttft: 1, model: 'm' }),                                      // no ts
		llm({ ttft: 1, model: '' }, { ts: 5 }),                            // empty model
		llm({ ttft: '1', model: 'm' }, { ts: 5 }),                         // non-numeric ttft
		llm({ ttft: 1, model: 'm' }, { ts: '5' }),                         // non-numeric ts
		llm({ model: 'm' }, { ts: 5 }),                                    // no ttft
		JSON.stringify({ type: 'other', attrs: { ttft: 1, model: 'm' }, ts: 5 }),
		'null',
		'',
		'garbage',
	].join('\n');
	assert.deepEqual(extractTtftSamplesFromDebugLog(content), [
		{ tsMs: 1_700_000_000_000, model: 'm', ttftSeconds: 1.5 },
		{ tsMs: 1_700_000_000_000, model: 'm', ttftSeconds: 2.5 },
		{ tsMs: 999_999_999_999_000, model: 'm', ttftSeconds: 99.9 },
		{ tsMs: 1_000_000_000_000, model: 'm', ttftSeconds: 0.1 },
	]);
});

// --- reasoning effort timeline ---

const effortModel = (effort: unknown) => ({ metadata: { configurationSchema: { properties: { reasoningEffort: { default: effort } } } } });

test('buildReasoningEffortTimeline: tracks effort per request and counts switches', () => {
	const r = buildReasoningEffortTimeline([
		'',
		'bad',
		JSON.stringify({ kind: 0, v: { inputState: { selectedModel: effortModel('low') } } }),
		JSON.stringify({ kind: 2, k: ['requests', 0], v: { requestId: 'r1' } }),
		JSON.stringify({ kind: 1, k: ['inputState', 'selectedModel'], v: effortModel('low') }), // same: no switch
		JSON.stringify({ kind: 1, k: ['inputState', 'selectedModel'], v: effortModel('high') }),
		JSON.stringify({ kind: 1, k: ['inputState', 'selectedModel'], v: effortModel(5) }),       // invalid: ignored
		JSON.stringify({ kind: 1, k: ['inputState', 'other'], v: effortModel('x') }),             // other path: ignored
		JSON.stringify({ kind: 1, k: ['other', 'selectedModel'], v: effortModel('x') }),
		JSON.stringify({ kind: 2, k: ['requests', 1], v: { requestId: 'r2' } }),
		JSON.stringify({ kind: 2, k: ['requests', 2], v: { requestId: 7 } }),                     // non-string id
		JSON.stringify({ kind: 2, k: ['requests', 3], v: null }),
		JSON.stringify({ kind: 2, k: ['requests', 'x'], v: { requestId: 'r4' } }),                // non-numeric index
		JSON.stringify({ kind: 2, k: ['other', 4], v: { requestId: 'r5' } }),
		JSON.stringify({ kind: 2, k: ['requests', 5], v: { requestId: '' } }),
		JSON.stringify({ kind: 'x' }),
	]);
	assert.deepEqual([...r.effortByRequestId.entries()], [['r1', 'low'], ['r2', 'high']]);
	assert.equal(r.defaultEffort, 'low');
	assert.equal(r.switchCount, 1);
});

test('buildReasoningEffortTimeline: first kind:1 effort without a default is not a switch; broken model shapes yield null', () => {
	const r = buildReasoningEffortTimeline([
		JSON.stringify({ kind: 2, k: ['requests', 0], v: { requestId: 'before' } }), // no effort yet: not recorded
		JSON.stringify({ kind: 1, k: ['inputState', 'selectedModel'], v: effortModel('med') }),
		JSON.stringify({ kind: 2, k: ['requests', 1], v: { requestId: 'after' } }),
	]);
	assert.deepEqual([...r.effortByRequestId.entries()], [['after', 'med']]);
	assert.equal(r.defaultEffort, null);
	assert.equal(r.switchCount, 0);
	for (const model of [null, 'x', {}, { metadata: null }, { metadata: {} }, { metadata: { configurationSchema: null } },
		{ metadata: { configurationSchema: {} } }, { metadata: { configurationSchema: { properties: null } } },
		{ metadata: { configurationSchema: { properties: {} } } },
		{ metadata: { configurationSchema: { properties: { reasoningEffort: null } } } },
		{ metadata: { configurationSchema: { properties: { reasoningEffort: {} } } } }]) {
		const t = buildReasoningEffortTimeline([JSON.stringify({ kind: 0, v: { inputState: { selectedModel: model } } })]);
		assert.equal(t.defaultEffort, null, JSON.stringify(model));
	}
});

// --- model resolution ---

test('getModelFromRequest: precedence of explicit id, auto resolution, metadata, display name, auto, fallback', () => {
	const pricing = {
		'gpt-4o': { displayNames: ['GPT-4o'] },
		'gpt-4o-mini': { displayNames: ['GPT-4o mini'] },
		'nodisplay': {},
	} as never;
	assert.equal(getModelFromRequest({ modelId: 'copilot/claude-x' }), 'claude-x');
	assert.equal(getModelFromRequest({ modelId: 'plain' }), 'plain');
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [{ kind: 'autoModeResolution', resolved: { id: 'copilot/gpt-5' } }] }), 'gpt-5');
	// resolution itself 'auto' is skipped
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [{ kind: 'autoModeResolution', resolved: { id: 'auto' } }] }), 'auto');
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [{ kind: 'autoModeResolution', resolved: { id: '' } }] }), 'auto');
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [{ kind: 'autoModeResolution', resolved: 'x' }] }), 'auto');
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [{ kind: 'autoModeResolution' }] }), 'auto');
	assert.equal(getModelFromRequest({ modelId: 'auto', response: [{ kind: 'other', resolved: { id: 'z' } }, null, 'x'] }), 'auto');
	assert.equal(getModelFromRequest({ modelId: 'auto', response: 'x' as never }), 'auto');
	assert.equal(getModelFromRequest({ modelId: 'copilot/auto', result: { metadata: { modelId: 'copilot/m1' } } }), 'm1');
	assert.equal(getModelFromRequest({ result: { metadata: { modelId: 'copilot/auto' }, details: 'GPT-4o mini x' } }, pricing), 'gpt-4o-mini');
	assert.equal(getModelFromRequest({ result: { details: 'Running GPT-4o' } }, pricing), 'gpt-4o');
	assert.equal(getModelFromRequest({ result: { details: 'unknown thing' } }, pricing), 'gpt-4');
	assert.equal(getModelFromRequest({ result: { details: 'unknown thing' } }, pricing, 'fb'), 'fb');
	assert.equal(getModelFromRequest({ result: { metadata: { modelId: 'copilot/auto' }, details: 'nothing' } }, pricing), 'auto');
	assert.equal(getModelFromRequest({}), 'gpt-4');
});

test('isCopilotAutoRequest: only explicit request-level evidence counts', () => {
	assert.equal(isCopilotAutoRequest({ modelId: 'auto' }), true);
	assert.equal(isCopilotAutoRequest({ modelId: 'copilot/auto' }), true);
	assert.equal(isCopilotAutoRequest({ result: { metadata: { modelId: 'auto' } } }), true);
	assert.equal(isCopilotAutoRequest({ response: [{ kind: 'autoModeResolution' }] }), true);
	assert.equal(isCopilotAutoRequest({ response: [null, 'x', { kind: 'other' }] }), false);
	assert.equal(isCopilotAutoRequest({ modelId: 'gpt-4o' }), false);
	assert.equal(isCopilotAutoRequest({}), false);
});

// --- content sniffing ---

test('isJsonlContent: needs two non-empty lines that each look like an object', () => {
	assert.equal(isJsonlContent('{"a":1}'), false);
	assert.equal(isJsonlContent('{"a":1}\n'), false);
	assert.equal(isJsonlContent('{"a":1}\n{"b":2}'), true);
	assert.equal(isJsonlContent('  {"a":1}  \n\n  {"b":2}  \n'), true);
	assert.equal(isJsonlContent('{"a":1}\n\n\n'), false);
	assert.equal(isJsonlContent('[1]\n{"b":2}'), false);
	assert.equal(isJsonlContent('{"a":1\n{"b":2}'), false);
	assert.equal(isJsonlContent('{"a":1}\n"b"}'), false);
	assert.equal(isJsonlContent('{"a":1}\n{"b":2'), false);
});

test('isUuidPointerFile: whole-content, case-insensitive UUID only', () => {
	assert.equal(isUuidPointerFile('123e4567-e89b-12d3-a456-426614174000'), true);
	assert.equal(isUuidPointerFile('  123E4567-E89B-12D3-A456-426614174000\n'), true);
	assert.equal(isUuidPointerFile('x123e4567-e89b-12d3-a456-426614174000'), false);
	assert.equal(isUuidPointerFile('123e4567-e89b-12d3-a456-426614174000x'), false);
	assert.equal(isUuidPointerFile('123e4567-e89b-12d3-a456-42661417400'), false);
	assert.equal(isUuidPointerFile('123e4567-e89b-12d3-a456-4266141740000'), false);
	assert.equal(isUuidPointerFile('g23e4567-e89b-12d3-a456-426614174000'), false);
	assert.equal(isUuidPointerFile('123e456-e89b-12d3-a456-4266141740000'), false);
});

// --- pricing lookups ---

test('parseContextThreshold: K/M units, plain numbers and rejection of non-positive values', () => {
	assert.equal(parseContextThreshold('> 200K'), 200_000);
	assert.equal(parseContextThreshold('≤ 272k'), 272_000);
	assert.equal(parseContextThreshold('1M'), 1_000_000);
	assert.equal(parseContextThreshold('1.5m'), 1_500_000);
	assert.equal(parseContextThreshold('128000'), 128_000);
	assert.equal(parseContextThreshold('0'), null);
	assert.equal(parseContextThreshold('0K'), null);
	assert.equal(parseContextThreshold('abc'), null);
	assert.equal(parseContextThreshold(''), null);
	assert.equal(parseContextThreshold(null), null);
	assert.equal(parseContextThreshold(undefined), null);
	assert.equal(parseContextThreshold('.'), null);
});

const pricing = {
	'claude-a': { inputCostPerMillion: 1, outputCostPerMillion: 2, tier: 'premium', copilotPricing: { inputCostPerMillion: 4, outputCostPerMillion: 8, longContext: { threshold: '> 200K', inputCostPerMillion: 9 } } },
	'gpt-low': { inputCostPerMillion: 1.99, outputCostPerMillion: 2, tier: 'standard' },
	'gpt-mid': { inputCostPerMillion: 2, outputCostPerMillion: 2 },
	'gpt-mid2': { inputCostPerMillion: 4.99, outputCostPerMillion: 2 },
	'gpt-high': { inputCostPerMillion: 5, outputCostPerMillion: 2 },
	'cp-low': { inputCostPerMillion: 50, outputCostPerMillion: 2, copilotPricing: { inputCostPerMillion: 1, outputCostPerMillion: 1 } },
	'broken': { outputCostPerMillion: 1 },
} as never;

test('getModelTier / getModelCostBucket: exact then partial matches with explicit boundaries', () => {
	assert.equal(getModelTier('claude-a', pricing), 'premium');
	assert.equal(getModelTier('gpt-low', pricing), 'standard');
	assert.equal(getModelTier('gpt-mid', pricing), 'unknown');
	assert.equal(getModelTier('claude-a-extended', pricing), 'premium');   // key contained in id
	assert.equal(getModelTier('claude', pricing), 'premium');              // id contained in key
	assert.equal(getModelTier('zzz', pricing), 'unknown');
	assert.equal(getModelTier('zzz'), 'unknown');
	assert.equal(getModelCostBucket('gpt-low', pricing), 'low');
	assert.equal(getModelCostBucket('gpt-mid', pricing), 'medium');
	assert.equal(getModelCostBucket('gpt-mid2', pricing), 'medium');
	assert.equal(getModelCostBucket('gpt-high', pricing), 'high');
	assert.equal(getModelCostBucket('cp-low', pricing), 'low');
	assert.equal(getModelCostBucket('claude-a', pricing), 'medium');       // copilot 4
	assert.equal(getModelCostBucket('gpt-high-preview', pricing), 'high'); // partial
	assert.equal(getModelCostBucket('broken', pricing), 'unknown');
	assert.equal(getModelCostBucket('zzz', pricing), 'unknown');
	assert.equal(getModelCostBucket('zzz'), 'unknown');
});

test('getLongContextInfo: resolves exact and partial matches, rejects missing or unparsable thresholds', () => {
	const expected = { thresholdTokens: 200_000, defaultInputCostPerMillion: 4, longContextInputCostPerMillion: 9 };
	assert.deepEqual(getLongContextInfo('claude-a', pricing), expected);
	assert.deepEqual(getLongContextInfo('CLAUDE-A-preview', pricing), expected);
	assert.deepEqual(getLongContextInfo('claude', pricing), expected);
	assert.equal(getLongContextInfo('gpt-low', pricing), null);
	assert.equal(getLongContextInfo('zzz', pricing), null);
	assert.equal(getLongContextInfo('zzz'), null);
	const bad = { m: { inputCostPerMillion: 1, outputCostPerMillion: 1, copilotPricing: { inputCostPerMillion: 1, outputCostPerMillion: 1, longContext: { threshold: 'n/a', inputCostPerMillion: 2 } } } } as never;
	assert.equal(getLongContextInfo('m', bad), null);
});

// --- misc helpers ---

test('createEmptyContextRefs / getTotalTokensFromModelUsage', () => {
	const refs = createEmptyContextRefs();
	for (const [k, v] of Object.entries(refs)) {
		if (k === 'byKind' || k === 'byPath') { assert.deepEqual(v, {}, k); } else { assert.equal(v, 0, k); }
	}
	assert.equal(Object.keys(refs).length, 20);
	assert.equal(getTotalTokensFromModelUsage({}), 0);
	assert.equal(getTotalTokensFromModelUsage({
		a: { inputTokens: 10, outputTokens: 5, sessions: 1 },
		b: { inputTokens: 100, outputTokens: 20, sessions: 1 },
	}), 135);
});
