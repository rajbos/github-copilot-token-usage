/**
 * These cover the transforms between written UI copy and spoken narration.
 * Every case here is one that actually appeared in this repository's own
 * release catalog.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPronunciation, capWords, splitSentences, toSpokenText } from '../speech';

test('a version number is not three sentences', () => {
	// The bug this exists for: "version 0.18.0." split into "version 0.",
	// "18.", "0." — which read aloud as nonsense and, because each fragment
	// ate part of the word budget, silently dropped the sentence after it.
	assert.deepEqual(
		splitSentences('Here is what changed in version 0.18.0. This release is about patterns.'),
		['Here is what changed in version 0.18.0.', 'This release is about patterns.'],
	);
});

test('capWords keeps the headline that follows a version number', () => {
	const text = 'Here is what changed in version 0.18.0. This release is about noticing patterns.';
	assert.equal(capWords(text, 55), text);
});

test('capWords drops whole sentences rather than cutting one', () => {
	const capped = capWords('One two three four. Five six seven eight nine ten.', 5);
	assert.equal(capped, 'One two three four.');
});

test('capWords keeps the first sentence even when it alone exceeds the budget', () => {
	// Truncating it would be worse: a line cut at word three sounds like the
	// audio failed rather than like an edit.
	const capped = capWords('One two three four five six. Seven.', 2);
	assert.equal(capped, 'One two three four five six.');
});

test('markdown links become their label', () => {
	assert.equal(
		toSpokenText('See [the docs](https://example.com/a/b.md) for more'),
		'See the docs for more.',
	);
});

test('setting ids lose their backticks and gain spoken dots', () => {
	assert.equal(
		toSpokenText('Turn it off with `aiEngineeringFluency.whatsNew.enabled`'),
		'Turn it off with aiEngineeringFluency dot whatsNew dot enabled.',
	);
});

test('navigation arrows become a spoken word', () => {
	assert.equal(toSpokenText('Research → TTFT'), 'Research then TTFT.');
});

test('a parenthetical does not leave stray punctuation', () => {
	// "(Beta)" used to produce "Mistral Cloud, Beta,: a new tab".
	assert.equal(
		toSpokenText('Mistral Cloud (Beta): a new tab'),
		'Mistral Cloud, Beta: a new tab.',
	);
});

test('em dashes become pauses, not silence', () => {
	assert.equal(toSpokenText('It shows counts — per workspace'), 'It shows counts, per workspace.');
});

test('symbols that read badly are spelled out', () => {
	assert.equal(toSpokenText('at least 80% across 3+ sessions'), 'at least 80 percent across 3 or more sessions.');
});

test('pronunciation applies to whole words only', () => {
	const map = { replacements: { CLI: 'C L I' } };
	assert.equal(applyPronunciation('the CLI and the CLIENT', map), 'the C L I and the CLIENT');
});

test('pronunciation prefers the longest matching key', () => {
	const map = { replacements: { Copilot: 'Co pilot', 'Copilot CLI': 'Co pilot C L I' } };
	assert.equal(applyPronunciation('Copilot CLI', map), 'Co pilot C L I');
});

test('pronunciation is case-insensitive but the replacement is literal', () => {
	assert.equal(applyPronunciation('the ttft tab', { replacements: { TTFT: 'T T F T' } }), 'the T T F T tab');
});
