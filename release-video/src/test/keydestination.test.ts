/**
 * The endpoint an API key is sent to comes from `config.json`, so a tampered
 * or carelessly edited config could send a bearer token over plain HTTP, or to
 * someone else's host entirely. CodeQL and the PR risk review both flagged the
 * config-to-network flow; this is the part of it that is worth enforcing in
 * code rather than accepting.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSafeKeyDestination } from '../voice';

test('an https endpoint is allowed', () => {
	assert.doesNotThrow(() => assertSafeKeyDestination('https://api.mistral.ai/v1/audio/speech', 'MISTRAL_API_KEY'));
});

test('plain http is refused', () => {
	assert.throws(
		() => assertSafeKeyDestination('http://api.mistral.ai/v1/audio/speech', 'MISTRAL_API_KEY'),
		/may only go to an https endpoint/,
	);
});

test('loopback over http is allowed, for a local proxy', () => {
	for (const host of ['http://localhost:8000/v1/audio/speech', 'http://127.0.0.1:8000/x']) {
		assert.doesNotThrow(() => assertSafeKeyDestination(host, 'MISTRAL_API_KEY'));
	}
});

test('a non-loopback host over http is refused even if it looks local', () => {
	// "localhost.evil.test" is not loopback, and a substring check would have
	// said it was.
	assert.throws(
		() => assertSafeKeyDestination('http://localhost.evil.test/v1/audio/speech', 'MISTRAL_API_KEY'),
		/may only go to an https endpoint/,
	);
});

test('the error names the variable but never its value', () => {
	process.env.RV_TEST_KEY = 'super-secret-value';
	try {
		assertSafeKeyDestination('http://elsewhere.test/x', 'RV_TEST_KEY');
		assert.fail('should have thrown');
	} catch (error) {
		const message = (error as Error).message;
		assert.match(message, /RV_TEST_KEY/);
		assert.doesNotMatch(message, /super-secret-value/);
	} finally {
		delete process.env.RV_TEST_KEY;
	}
});

test('a malformed endpoint is reported rather than silently used', () => {
	assert.throws(() => assertSafeKeyDestination('not a url', 'MISTRAL_API_KEY'), /not a valid URL/);
});

/* ------------------------------------------------ which host, not just https */

const MISTRAL = { expectedHost: 'api.mistral.ai' };

test('the expected host is allowed', () => {
	assert.doesNotThrow(
		() => assertSafeKeyDestination('https://api.mistral.ai/v1/audio/speech', 'MISTRAL_API_KEY', MISTRAL),
	);
});

test('a lookalike host is refused even over https', () => {
	// The case https alone does not cover: this host has a perfectly valid
	// certificate for itself, and any suffix or substring test would pass it.
	assert.throws(
		() => assertSafeKeyDestination('https://api.mistral.ai.evil.test/v1/audio/speech', 'MISTRAL_API_KEY', MISTRAL),
		/this adapter is for api\.mistral\.ai/,
	);
});

test('a prefix lookalike is refused too', () => {
	assert.throws(
		() => assertSafeKeyDestination('https://evil-api.mistral.ai.test/x', 'MISTRAL_API_KEY', MISTRAL),
		/this adapter is for api\.mistral\.ai/,
	);
});

test('another host needs an explicit opt-in', () => {
	const other = 'https://tts.example.test/v1/audio/speech';
	assert.throws(() => assertSafeKeyDestination(other, 'MISTRAL_API_KEY', MISTRAL), /allowOtherHosts/);
	assert.doesNotThrow(
		() => assertSafeKeyDestination(other, 'MISTRAL_API_KEY', { ...MISTRAL, allowOtherHosts: true }),
	);
});

test('loopback stays usable regardless of the expected host', () => {
	assert.doesNotThrow(
		() => assertSafeKeyDestination('http://127.0.0.1:8000/v1/audio/speech', 'MISTRAL_API_KEY', MISTRAL),
	);
});
