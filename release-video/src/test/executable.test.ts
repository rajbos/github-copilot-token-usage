/**
 * Resolving the executable named by an argv template.
 *
 * A command containing a path separator is a file in this project and must be
 * made absolute, because Windows resolves a relative executable against the
 * *parent* process's working directory rather than the child's `cwd`.
 *
 * This file exists because the first version of that check used the character
 * class `[\/]` — only a forward slash, the backslash having been lost to an
 * escaping layer. `.venv-tts\Scripts\python.exe` was therefore treated as a
 * bare PATH command and left relative: the exact case the function is for.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { PROJECT_ROOT, resolveExecutable } from '../util';

test('a forward-slash path is made absolute', () => {
	const resolved = resolveExecutable('.venv-tts/Scripts/python.exe', 'argv[0]');
	assert.ok(path.isAbsolute(resolved), `${resolved} is not absolute`);
	assert.ok(resolved.startsWith(PROJECT_ROOT));
});

test('a backslash path is made absolute too', () => {
	const command = String.raw`.venv-tts\Scripts\python.exe`;
	const resolved = resolveExecutable(command, 'argv[0]');
	assert.notEqual(resolved, command, 'left relative — spawn would resolve it against the wrong directory');
	assert.ok(path.isAbsolute(resolved), `${resolved} is not absolute`);
});

test('a mixed-separator path is made absolute', () => {
	const command = String.raw`.venv-tts/Scripts\python.exe`;
	assert.ok(path.isAbsolute(resolveExecutable(command, 'argv[0]')));
});

test('a bare command is left for PATH lookup', () => {
	assert.equal(resolveExecutable('ffmpeg', 'argv[0]'), 'ffmpeg');
	assert.equal(resolveExecutable('python', 'argv[0]'), 'python');
});

test('a path escaping the project is still refused', () => {
	assert.throws(() => resolveExecutable('../../evil.exe', 'argv[0]'), /outside the project root/);
});
