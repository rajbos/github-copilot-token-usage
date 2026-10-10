/**
 * The path allowlist, tested against links rather than just against strings.
 *
 * `path.relative` is lexical: it compares names, not what those names reach.
 * Two holes came out of review —
 *
 *   1. a symlink inside the project pointing out of it, and
 *   2. a *dangling* symlink, which `existsSync` reports as "does not exist",
 *      so a walk up to the nearest existing ancestor skipped straight past it
 *      and accepted the in-root parent.
 *
 * Symlink creation needs elevation or Developer Mode on Windows, so these
 * skip rather than fail when the filesystem will not make one — a skipped
 * test is honest, a test that silently cannot exercise its subject is not.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { PROJECT_ROOT, resolveInProject } from '../util';

/** Makes a symlink, or returns false when the platform will not allow it. */
function trySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, 'junction');
		return true;
	} catch {
		try {
			fs.symlinkSync(target, linkPath);
			return true;
		} catch {
			return false;
		}
	}
}

const scratch = path.join(PROJECT_ROOT, 'cache', 'test-containment');

function withLink(name: string, target: string, body: (relative: string) => void): boolean {
	fs.mkdirSync(scratch, { recursive: true });
	const linkPath = path.join(scratch, name);
	fs.rmSync(linkPath, { force: true, recursive: true });
	if (!trySymlink(target, linkPath)) { return false; }
	try {
		body(path.relative(PROJECT_ROOT, linkPath).split(path.sep).join('/'));
	} finally {
		fs.rmSync(linkPath, { force: true, recursive: true });
	}
	return true;
}

test('a plain in-project path is accepted', () => {
	assert.doesNotThrow(() => resolveInProject('assets/screenshots/usage.png', 'image'));
});

test('a symlink pointing outside the project is refused', (t) => {
	const ran = withLink('escape', os.tmpdir(), (relative) => {
		assert.throws(
			() => resolveInProject(`${relative}/x.png`, 'image'),
			/only lexically|cannot be resolved/,
		);
	});
	if (!ran) { t.skip('this filesystem will not create symlinks'); }
});

test('a dangling symlink is refused rather than skipped over', (t) => {
	// The subtle one: existsSync follows the link, sees nothing, and reports
	// false — so the old walk-up accepted the parent directory instead.
	const ran = withLink('dangling', path.join(os.tmpdir(), 'definitely-not-here-12345'), (relative) => {
		assert.throws(() => resolveInProject(relative, 'image'), /cannot be resolved/);
	});
	if (!ran) { t.skip('this filesystem will not create symlinks'); }
});

test('an output path that does not exist yet is still allowed', () => {
	// Containment must not require the file to exist: almost everything this
	// pipeline writes is created after the check.
	assert.doesNotThrow(() => resolveInProject('output/not-created-yet.mp4', 'output'));
	assert.doesNotThrow(() => resolveInProject('cache/nested/deeper/new.wav', 'narration'));
});
