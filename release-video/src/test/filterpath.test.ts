/**
 * `escapeFilterPath` puts a filename inside an FFmpeg filter argument, where
 * the graph is parsed twice — once to split filters, once to split each
 * filter's options. Getting it wrong either breaks the render or, worse,
 * quietly points the `subtitles` filter at a different file.
 *
 * CodeQL flagged the original as incomplete escaping, and it was right: it
 * escaped `:` and `'` in separate passes without ever escaping the backslash,
 * and relied on an earlier pass having removed backslashes — which only held
 * on Windows.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { escapeFilterPath } from '../render';

test('a drive-letter colon is escaped', () => {
	// Unescaped, FFmpeg reads "C" as an option name.
	const escaped = escapeFilterPath('C:/cache/subtitles/0.18.0.ass');
	assert.equal(escaped, 'C\\:/cache/subtitles/0.18.0.ass');
});

test('a quote is escaped', () => {
	assert.equal(escapeFilterPath("/tmp/rob's/x.ass"), "/tmp/rob\\'s/x.ass");
});

test('a backslash is treated by the rules of the platform it is on', () => {
	// This is the case the old code got wrong, and what "right" means depends
	// on the platform, so the test says which:
	//
	//   Windows — a backslash IS a separator, so normalising it to "/" is
	//             correct and nothing is left to escape.
	//   POSIX   — a backslash is a legal character in a filename, so it must
	//             survive and be escaped. The old code rewrote it to "/" and
	//             silently addressed a different file.
	const escaped = escapeFilterPath('/tmp/od\\d/x.ass');

	if (path.sep === '\\') {
		assert.equal(escaped, '/tmp/od/d/x.ass');
	} else {
		assert.equal(escaped, '/tmp/od\\\\d/x.ass');
	}
});

test('every escape is itself a single backslash followed by the character', () => {
	// A character escaped twice (or an escape left unescaped) shows up here as
	// an odd number of backslashes before the payload.
	const escaped = escapeFilterPath("C:/a'b/c.ass");
	for (const match of escaped.matchAll(/(\\*)([':\\])/g)) {
		assert.equal(match[1]?.length, 1, `"${match[2]}" in ${escaped} is not escaped exactly once`);
	}
});

test('platform separators become forward slashes', () => {
	const joined = ['cache', 'subtitles', 'x.ass'].join(path.sep);
	assert.equal(escapeFilterPath(joined), 'cache/subtitles/x.ass');
});

test('a plain POSIX path is unchanged', () => {
	assert.equal(escapeFilterPath('/home/rob/cache/x.ass'), '/home/rob/cache/x.ass');
});
