/**
 * The narration prompt is sent to `llm.endpoint`, which comes from
 * `config.json`. Loopback is the documented setup; anything else needs an
 * explicit `llm.allowRemote`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertLocalNarrationDestination } from '../llm';

test('loopback endpoints are allowed without opting in', () => {
	for (const url of ['http://127.0.0.1:11434', 'http://localhost:1234', 'http://[::1]:8080']) {
		assert.doesNotThrow(() => assertLocalNarrationDestination(url, false), url);
	}
});

test('a remote endpoint is refused by default', () => {
	assert.throws(() => assertLocalNarrationDestination('https://api.example.com', false), /allowRemote/);
});

test('a lookalike host is not treated as loopback', () => {
	assert.throws(() => assertLocalNarrationDestination('http://localhost.evil.example', false), /allowRemote/);
});

test('a remote endpoint is accepted when allowRemote is set', () => {
	assert.doesNotThrow(() => assertLocalNarrationDestination('https://api.example.com', true));
});

test('a malformed endpoint is reported', () => {
	assert.throws(() => assertLocalNarrationDestination('not a url', false), /not a valid URL/);
});
