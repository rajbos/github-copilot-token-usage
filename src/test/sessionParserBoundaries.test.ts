/**
 * Boundary / guard tests for src/sessionParser.ts, written to kill surviving Stryker
 * mutants (issue #2341): delta-path traversal (array index vs object key, last segment),
 * kind 1/2 application, response text/thinking extraction, request model resolution,
 * actual-token extraction and the file-format fallbacks.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { parseSessionFileContent, TokenAccumulator } from '../sessionParser';

const len = (text: string): number => text.length;

function jsonl(...events: unknown[]): string {
	return events.map(e => JSON.stringify(e)).join('\n');
}

function parseDelta(...events: unknown[]) {
	return parseSessionFileContent('s.jsonl', jsonl(...events), len);
}

function parseJson(session: unknown, getModel?: (r: any) => string) {
	return parseSessionFileContent('s.json', JSON.stringify(session), len, getModel);
}

// ----- TokenAccumulator -----

test('TokenAccumulator: falls back to default model for empty/non-string and counts exactly', () => {
	const acc = new TokenAccumulator('def', len);
	assert.equal(acc.ensureModel(''), 'def');
	assert.equal(acc.ensureModel(undefined), 'def');
	assert.equal(acc.ensureModel(5 as any), 'def');
	assert.equal(acc.ensureModel('m'), 'm');
	acc.addInput('', 'abc');
	acc.addOutput('m', 'de');
	acc.addInput('m', 'f');
	assert.deepEqual(acc.modelUsage, {
		def: { inputTokens: 3, outputTokens: 0, sessions: 0 },
		m: { inputTokens: 1, outputTokens: 2, sessions: 0 },
	});
	assert.equal(acc.totalInputTokens, 4);
	assert.equal(acc.totalOutputTokens, 2);
});

test('TokenAccumulator: unsafe model keys are ignored entirely', () => {
	const acc = new TokenAccumulator('def', len);
	acc.addInput('__proto__', 'abc');
	acc.addOutput('constructor', 'abc');
	assert.deepEqual(Object.keys(acc.modelUsage), []);
	assert.equal(acc.totalInputTokens, 0);
	assert.equal(acc.totalOutputTokens, 0);
});

// ----- delta path traversal (kind 1) -----

test('delta kind 1: array index in the middle of the path updates the existing element', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'aaaa' } }, { message: { text: 'bb' } }] } },
		{ kind: 1, k: ['requests', '1', 'message', 'text'], v: 'cccccc' },
	);
	assert.equal(r.interactions, 2);
	assert.equal(r.tokens, 4 + 6);
	assert.equal(r.modelUsage['unknown'].inputTokens, 10);
});

test('delta kind 1: numeric (non-string) path segments are stringified', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'aa' } }] } },
		{ kind: 1, k: ['requests', 0, 'message', 'text'], v: 'zzzzz' },
	);
	assert.equal(r.tokens, 5);
});

test('delta kind 1: last segment as array index replaces / appends the element', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'aa' } }] } },
		{ kind: 1, k: ['requests', '0'], v: { message: { text: 'bbb' } } },
		{ kind: 1, k: ['requests', '1'], v: { message: { text: 'cccc' } } },
	);
	assert.equal(r.interactions, 2);
	assert.equal(r.tokens, 3 + 4);
});

test('delta kind 1: missing intermediate containers are created (array for index, object for key)', () => {
	const r = parseDelta(
		{ kind: 0, v: {} },
		{ kind: 1, k: ['requests', '0', 'message', 'parts', '0', 'text'], v: 'hello' },
	);
	assert.equal(r.interactions, 0, 'no message.text, so not a user interaction');
	assert.equal(r.tokens, 5, 'parts[0].text was created as array-of-object and counted as input');
	assert.equal(r.modelUsage['unknown'].inputTokens, 5);
});

test('delta kind 1: non-object intermediate nodes are replaced with a fresh container', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [5] } },
		{ kind: 1, k: ['requests', '0', 'message', 'text'], v: 'abc' },
	);
	assert.equal(r.interactions, 1);
	assert.equal(r.tokens, 3);

	const r2 = parseDelta(
		{ kind: 0, v: { requests: 'oops' } },
		{ kind: 1, k: ['requests', '0', 'message', 'text'], v: 'abcd' },
	);
	assert.equal(r2.interactions, 1);
	assert.equal(r2.tokens, 4);
});

test('delta kind 1: object keys that look numeric on an object parent do not become array slots', () => {
	// requests is an object here (not an array), so reconstruction yields no requests.
	const r = parseDelta(
		{ kind: 0, v: { requests: {} } },
		{ kind: 1, k: ['requests', '0'], v: { message: { text: 'abc' } } },
	);
	assert.equal(r.interactions, 0);
	assert.equal(r.tokens, 0);
});

test('delta kind 1: non-numeric last segment on an array parent does not write an element', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'aa' } }] } },
		{ kind: 1, k: ['requests', 'x1'], v: { message: { text: 'bbbb' } } },
	);
	assert.equal(r.interactions, 1);
	assert.equal(r.tokens, 2);
});

test('delta kind 1: path whose parent chain is a primitive returns the state unchanged', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'aa' } }], title: 'str' } },
		{ kind: 1, k: ['title', 'a', 'b'], v: 'x' },
	);
	assert.equal(r.interactions, 1);
	assert.equal(r.tokens, 2);
});

// ----- delta kind 2 -----

test('delta kind 2: array value is spread, non-array value is pushed as one element', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [] } },
		{ kind: 2, k: ['requests'], v: [{ message: { text: 'a' } }, { message: { text: 'bb' } }] },
		{ kind: 2, k: ['requests'], v: { message: { text: 'ccc' } } },
	);
	assert.equal(r.interactions, 3);
	assert.equal(r.tokens, 1 + 2 + 3);
});

test('delta kind 2: creates the target array when missing', () => {
	const r = parseDelta(
		{ kind: 0, v: {} },
		{ kind: 2, k: ['requests'], v: [{ message: { text: 'ab' } }] },
	);
	assert.equal(r.interactions, 1);
	assert.equal(r.tokens, 2);
});

test('delta kind 2: replaces a non-array value at the key with a new array', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: 'nope' } },
		{ kind: 2, k: ['requests'], v: { message: { text: 'abc' } } },
	);
	assert.equal(r.interactions, 1);
	assert.equal(r.tokens, 3);
});

test('delta kind 2: appends to a nested array reached through an array index', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'a' }, response: [] }] } },
		{ kind: 2, k: ['requests', '0', 'response'], v: [{ value: 'xx' }, { value: 'yyy' }] },
	);
	assert.equal(r.tokens, 1 + 5);
	assert.equal(r.modelUsage['unknown'].outputTokens, 5);
});

test('delta kind 2: array index as last segment creates a nested array in an array parent', () => {
	// state.requests[0].response is [[...]]-style access: last segment "0" on an array parent
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'a' }, response: [] }] } },
		{ kind: 2, k: ['requests', '0', 'response', '0'], v: [1, 2] },
	);
	// response[0] becomes an array (not a response item) and must not crash or add output
	assert.equal(r.tokens, 1);
	assert.equal(r.interactions, 1);
});

test('delta: unknown kind, empty key path and non-array key path leave state untouched', () => {
	const base = { kind: 0, v: { requests: [{ message: { text: 'aa' } }] } };
	for (const bad of [
		{ kind: 3, k: ['requests', '0', 'message', 'text'], v: 'zzzz' },
		{ kind: 1, k: [], v: 'zzzz' },
		{ kind: 1, k: 'requests', v: 'zzzz' },
		{ kind: 1, v: 'zzzz' },
		'not-an-object',
		null,
	]) {
		const r = parseDelta(base, bad);
		assert.equal(r.tokens, 2, JSON.stringify(bad));
		assert.equal(r.interactions, 1);
	}
});

test('delta: any unsafe path segment rejects the whole delta', () => {
	for (const k of [
		['requests', '0', '__proto__', 'x'],
		['requests', '0', 'constructor'],
		['requests', '0', 'prototype'],
		['requests', '0', 'hasOwnProperty'],
		['requests', '__custom'],
	]) {
		const r = parseDelta(
			{ kind: 0, v: { requests: [{ message: { text: 'aa' } }] } },
			{ kind: 1, k, v: { message: { text: 'zzzzzzzz' } } },
		);
		assert.equal(r.tokens, 2, JSON.stringify(k));
	}
	assert.equal(({} as any).x, undefined);
});

test('delta: kind 0 replaces whole state; first line without numeric kind is not delta format', () => {
	const r = parseDelta(
		{ kind: 0, v: { requests: [{ message: { text: 'a' } }] } },
		{ kind: 0, v: { requests: [{ message: { text: 'bb' } }, { message: { text: 'c' } }] } },
	);
	assert.equal(r.interactions, 2);
	assert.equal(r.tokens, 3);

	// First line parses but has no numeric kind -> falls through to whole-file JSON parse
	const whole = parseSessionFileContent('s.jsonl', JSON.stringify({ requests: [{ message: { text: 'abc' } }] }), len);
	assert.equal(whole.interactions, 1);
	assert.equal(whole.tokens, 3);
	assert.equal(whole.actualTokens, 0);
});

test('delta: state that is not an object yields no requests; blank lines and CRLF are tolerated', () => {
	const r = parseSessionFileContent('s.jsonl', '{"kind":0,"v":5}\r\n\r\n   \r\n', len);
	assert.deepEqual(r, { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 });

	const r2 = parseSessionFileContent(
		's.jsonl',
		'{"kind":0,"v":{"requests":[{"message":{"text":"ab"}}]}}\r\n\r\n{"kind":2,"k":["requests"],"v":[{"message":{"text":"c"}}]}\r\n',
		len,
	);
	assert.equal(r2.interactions, 2);
	assert.equal(r2.tokens, 3);
});

test('delta: interactions only count requests with non-blank string message.text; actualTokens stay 0', () => {
	const r = parseDelta({
		kind: 0,
		v: {
			requests: [
				{ message: { text: 'a' }, result: { promptTokens: 10, outputTokens: 5 } },
				{ message: { text: '   ' } },
				{ message: { text: 5 } },
				{ message: 'x' },
				{ message: null },
				'str',
				null,
				{},
			],
		},
	});
	assert.equal(r.interactions, 1);
	assert.equal(r.actualTokens, 0);
});

// ----- response text / thinking -----

test('thinking item with string value counts as thinking tokens, not output', () => {
	const r = parseJson({ requests: [{ response: [{ kind: 'thinking', value: 'abcde' }] }] });
	assert.equal(r.thinkingTokens, 5);
	assert.equal(r.tokens, 5);
	assert.deepEqual(r.modelUsage, {});
});

test('thinking item with non-string value counts nothing and is not treated as plain text', () => {
	for (const value of [123, { a: 1 }, ['abc'], null, undefined, true]) {
		const r = parseJson({ requests: [{ response: [{ kind: 'thinking', value, content: { value: 'zz' }, message: { parts: [{ text: 'yyyy' }] } }] }] });
		assert.equal(r.thinkingTokens, 0, JSON.stringify(value));
		assert.equal(r.tokens, 0, JSON.stringify(value));
		assert.deepEqual(r.modelUsage, {});
	}
});

test('response text: content.value preferred over value; plain value counted as output', () => {
	const r = parseJson({ requests: [{ response: [
		{ value: 'ignored', content: { value: 'abc' } },
		{ value: 'de' },
		{ kind: 'markdownContent', value: 'f' },
	] }] });
	assert.equal(r.modelUsage['unknown'].outputTokens, 3 + 2 + 1);
	assert.equal(r.thinkingTokens, 0);
});

test('response text and thinking text are summed per request and estimated once for thinking', () => {
	const calls: string[] = [];
	const est = (t: string) => { calls.push(t); return t.length; };
	const r = parseSessionFileContent('s.json', JSON.stringify({ requests: [{ response: [
		{ kind: 'thinking', value: 'ab' }, { value: 'cde' }, { kind: 'thinking', value: 'f' }, { value: 'gh' },
	] }] }), est);
	assert.equal(r.thinkingTokens, 3);
	assert.equal(r.modelUsage['unknown'].outputTokens, 5);
	assert.equal(r.tokens, 8);
	assert.ok(calls.includes('abf'));
	assert.ok(calls.includes('cdegh'));
});

test('response non-array or empty text yields nothing', () => {
	assert.equal(parseJson({ requests: [{ response: 'abc' }] }).tokens, 0);
	assert.equal(parseJson({ requests: [{ response: [{ value: '' }, { content: { value: '' } }, null, 5] }] }).tokens, 0);
});

// ----- processResponseItem -----

test('message.parts of items without a string value are counted as output', () => {
	const r = parseJson({ requests: [{ response: [
		{ message: { parts: [{ text: 'abc' }, { text: '' }, { text: 5 }, null, { text: 'de' }] } },
	] }] });
	assert.equal(r.modelUsage['unknown'].outputTokens, 5);
});

test('message.parts of items with a string value or thinking kind are not double-counted', () => {
	const r = parseJson({ requests: [{ response: [
		{ value: 'ab', message: { parts: [{ text: 'zzzz' }] } },
		{ kind: 'thinking', value: 'c', message: { parts: [{ text: 'zzzz' }] } },
		{ kind: 'thinking', message: { parts: [{ text: 'zzzz' }] } },
	] }] });
	assert.equal(r.modelUsage['unknown'].outputTokens, 2);
	assert.equal(r.thinkingTokens, 1);
});

test('items with a non-string value still contribute message.parts', () => {
	const r = parseJson({ requests: [{ response: [{ value: 5, message: { parts: [{ text: 'abc' }] } }] }] });
	assert.equal(r.modelUsage['unknown'].outputTokens, 3);
});

test('sub-agent items add prompt as input and result as output on the sub-agent model, then stop', () => {
	const r = parseJson({ requests: [{ modelId: 'main-model', response: [
		{
			kind: 'toolInvocationSerialized',
			message: { parts: [{ text: 'ignored' }] },
			toolSpecificData: { kind: 'subagent', prompt: 'pppp', result: 'rr', modelName: 'sub-model' },
		},
		{
			kind: 'toolInvocationSerialized',
			toolSpecificData: { kind: 'subagent', prompt: 'ppp', result: '' },
		},
		{
			kind: 'toolInvocationSerialized',
			toolSpecificData: { kind: 'subagent', prompt: '', result: 'rrr' },
		},
	] }] });
	assert.equal(r.modelUsage['sub-model'].inputTokens, 4);
	assert.equal(r.modelUsage['sub-model'].outputTokens, 2);
	assert.equal(r.modelUsage['main-model'].inputTokens, 3);
	assert.equal(r.modelUsage['main-model'].outputTokens, 3);
});

test('request.responses is used when response is absent; response wins when both present', () => {
	const r = parseJson({ requests: [{ responses: [{ message: { parts: [{ text: 'abc' }] } }] }] });
	assert.equal(r.modelUsage['unknown'].outputTokens, 3);

	const both = parseJson({ requests: [{
		response: [{ message: { parts: [{ text: 'a' }] } }],
		responses: [{ message: { parts: [{ text: 'bbbbbb' }] } }],
	}] });
	assert.equal(both.modelUsage['unknown'].outputTokens, 1);

	const neither = parseJson({ requests: [{ response: 'x', responses: 'y' }] });
	assert.equal(neither.tokens, 0);
});

// ----- request input -----

test('request input: message.parts texts win over message.text; empty/non-string parts are skipped', () => {
	const r = parseJson({ requests: [{ message: { text: 'zzzzzz', parts: [{ text: 'ab' }, { text: '' }, { text: 7 }, null, { text: 'c' }] } }] });
	assert.equal(r.modelUsage['unknown'].inputTokens, 3);
});

test('request input: message.text used when no parts; empty string text adds nothing', () => {
	assert.equal(parseJson({ requests: [{ message: { text: 'abcd' } }] }).modelUsage['unknown'].inputTokens, 4);
	assert.equal(parseJson({ requests: [{ message: { text: '' } }] }).tokens, 0);
	assert.deepEqual(parseJson({ requests: [{ message: { text: 5 } }] }).modelUsage, {});
});

test('non-object requests are skipped but still counted as interactions for JSON sessions', () => {
	const r = parseJson({ requests: [null, 'str', 5, { message: { text: 'ab' } }] });
	assert.equal(r.interactions, 4);
	assert.equal(r.tokens, 2);
});

// ----- model resolution -----

test('model resolution order: modelId, selectedModel.identifier, model; copilot/ prefix stripped; blank ignored', () => {
	const mk = (req: any) => Object.keys(parseJson({ requests: [{ message: { text: 'a' }, ...req }] }).modelUsage);
	assert.deepEqual(mk({ modelId: 'copilot/gpt-x', model: 'other' }), ['gpt-x']);
	assert.deepEqual(mk({ selectedModel: { identifier: ' sel ' }, model: 'other' }), ['sel']);
	assert.deepEqual(mk({ model: 'plain' }), ['plain']);
	assert.deepEqual(mk({}), ['unknown']);
	assert.deepEqual(mk({ modelId: '   ' }), ['unknown']);
});

test('model resolution: callback is used only when no usable model on the request', () => {
	let calls = 0;
	const cb = () => { calls++; return 'copilot/from-cb'; };
	const withModel = parseJson({ requests: [{ message: { text: 'a' }, modelId: 'own' }] }, cb);
	assert.deepEqual(Object.keys(withModel.modelUsage), ['own']);
	assert.equal(calls, 0);

	const without = parseJson({ requests: [{ message: { text: 'a' } }] }, cb);
	assert.deepEqual(Object.keys(without.modelUsage), ['from-cb']);
	assert.equal(calls, 1);

	const blankCb = parseJson({ requests: [{ message: { text: 'a' } }] }, () => '  ');
	assert.deepEqual(Object.keys(blankCb.modelUsage), ['unknown']);
});

// ----- actual token extraction -----

test('actual tokens: usage block (with partial/invalid fields) takes precedence', () => {
	const act = (result: any) => parseJson({ requests: [{ result }] }).actualTokens;
	assert.equal(act({ usage: { promptTokens: 10, completionTokens: 5 }, promptTokens: 100, outputTokens: 100 }), 15);
	assert.equal(act({ usage: { promptTokens: 10 } }), 10);
	assert.equal(act({ usage: { completionTokens: 5 } }), 5);
	assert.equal(act({ usage: { promptTokens: '10', completionTokens: null } , promptTokens: 7, outputTokens: 7 }), 0);
	assert.equal(act({ usage: {} }), 0);
});

test('actual tokens: top-level and metadata fallbacks require both fields to be numbers', () => {
	const act = (result: any) => parseJson({ requests: [{ result }] }).actualTokens;
	assert.equal(act({ promptTokens: 3, outputTokens: 4 }), 7);
	assert.equal(act({ promptTokens: 3 }), 0);
	assert.equal(act({ outputTokens: 4 }), 0);
	assert.equal(act({ promptTokens: '3', outputTokens: 4 }), 0);
	assert.equal(act({ promptTokens: 3, outputTokens: 4, metadata: { promptTokens: 100, outputTokens: 100 } }), 7);
	assert.equal(act({ metadata: { promptTokens: 3, outputTokens: 4 } }), 7);
	assert.equal(act({ metadata: { promptTokens: 3 } }), 0);
	assert.equal(act({ metadata: { outputTokens: 4 } }), 0);
	assert.equal(act({ metadata: { promptTokens: '3', outputTokens: 4 } }), 0);
	assert.equal(act({ metadata: { promptTokens: 3, outputTokens: '4' } }), 0);
	assert.equal(act({ promptTokens: 0, outputTokens: 0, metadata: { promptTokens: 3, outputTokens: 4 } }), 0);
	assert.equal(act(undefined), 0);
});

test('actual tokens are summed across requests', () => {
	const r = parseJson({ requests: [
		{ result: { promptTokens: 1, outputTokens: 2 } },
		{ result: { usage: { promptTokens: 4, completionTokens: 8 } } },
	] });
	assert.equal(r.actualTokens, 15);
});

// ----- file-format fallbacks -----

test('JSON sessions: requests preferred over history; neither -> no interactions', () => {
	const both = parseJson({ requests: [{ message: { text: 'a' } }], history: [{ message: { text: 'b' } }, { message: { text: 'c' } }] });
	assert.equal(both.interactions, 1);
	const hist = parseJson({ history: [{ message: { text: 'b' } }, { message: { text: 'c' } }] });
	assert.equal(hist.interactions, 2);
	assert.equal(hist.tokens, 2);
	const none = parseJson({ requests: 'x', history: 'y' });
	assert.deepEqual(none, { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 });
});

test('invalid or non-object content returns the empty result shape', () => {
	const empty = { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 };
	assert.deepEqual(parseSessionFileContent('s.json', 'not json', len), empty);
	assert.deepEqual(parseSessionFileContent('s.json', 'null', len), empty);
	assert.deepEqual(parseSessionFileContent('s.json', '"str"', len), empty);
	assert.deepEqual(parseSessionFileContent('s.json', '5', len), empty);
	assert.deepEqual(parseSessionFileContent('s.json', '[]', len), empty);
	assert.deepEqual(parseSessionFileContent('s.json', '[{"requests":[{"message":{"text":"a"}}]}]', len), empty);
	assert.deepEqual(parseSessionFileContent('s.jsonl', 'not json at all', len), empty);
	assert.deepEqual(parseSessionFileContent('s.jsonl', '', len), empty);
});

test('.jsonl whole-file JSON with surrounding whitespace is parsed via the trimmed fallback', () => {
	const r = parseSessionFileContent('s.jsonl', '\n  {"history":[{"message":{"text":"abc"}}]}  \n', len);
	assert.equal(r.interactions, 1);
	assert.equal(r.tokens, 3);
});

test('tokens total = input + output + thinking and JSON sessions report actualTokens', () => {
	const r = parseJson({ requests: [{
		message: { text: 'ab' },
		response: [{ value: 'cde' }, { kind: 'thinking', value: 'f' }],
		result: { promptTokens: 20, outputTokens: 30 },
	}] });
	assert.equal(r.tokens, 2 + 3 + 1);
	assert.equal(r.thinkingTokens, 1);
	assert.equal(r.actualTokens, 50);
	assert.equal(r.interactions, 1);
});
