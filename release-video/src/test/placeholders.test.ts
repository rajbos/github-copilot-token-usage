/**
 * Argv placeholder substitution.
 *
 * The naive `.replace('{{text}}', text)` chain this replaced got two things
 * wrong, and both corrupted text on its way to a TTS engine:
 *
 *   - `$&`, `` $` `` and `$'` are substitution patterns in a *string*
 *     replacement. Narration containing `$&` had the literal `{{text}}`
 *     spliced into it and spoken aloud; `$'` duplicated surrounding text.
 *   - A string pattern replaces only the first match, so a template using a
 *     placeholder twice left the second one as literal text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { substitutePlaceholders } from '../voice';

const values = { text: 'hello', out: '/tmp/a.wav', textFile: '/tmp/a.txt', referenceWav: '', referenceText: '' };

test('a placeholder is substituted', () => {
	assert.equal(substitutePlaceholders('{{out}}', values), '/tmp/a.wav');
	assert.equal(substitutePlaceholders('--out={{out}}', values), '--out=/tmp/a.wav');
});

test('every occurrence is substituted, not just the first', () => {
	assert.equal(
		substitutePlaceholders('{{out}} and {{out}}.log', values),
		'/tmp/a.wav and /tmp/a.wav.log',
	);
});

test('a dollar-ampersand in the value stays literal', () => {
	// Previously produced "price {{text}} each" — the placeholder itself, spoken.
	assert.equal(
		substitutePlaceholders('{{text}}', { ...values, text: 'price $& each' }),
		'price $& each',
	);
});

test('a dollar-quote in the value does not splice in surrounding text', () => {
	assert.equal(
		substitutePlaceholders('say {{text}} now', { ...values, text: "a $' b" }),
		"say a $' b now",
	);
});

test('a dollar-backtick in the value stays literal', () => {
	assert.equal(
		substitutePlaceholders('say {{text}}', { ...values, text: 'x $` y' }),
		'say x $` y',
	);
});

test('a plain dollar amount survives unchanged', () => {
	assert.equal(
		substitutePlaceholders('{{text}}', { ...values, text: 'it costs $100' }),
		'it costs $100',
	);
});

test('a token with no placeholder is returned as-is', () => {
	assert.equal(substitutePlaceholders('--length-scale', values), '--length-scale');
});

test('an unknown value resolves to empty rather than the literal placeholder', () => {
	assert.equal(substitutePlaceholders('{{referenceWav}}', values), '');
});
