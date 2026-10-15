import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

import {
	fileUriToPath,
	getRepoNameFromWorkspacePath,
	hasWindowsDriveSegment,
	normalizePath,
	normalizePathForDedup,
	normalizeToRepoRoot,
	splitNormalizedPath,
	stripWindowsDriveUriPrefix,
	toPlatformPath
} from '../utils/pathUtils';

// normalizePath tests
test('normalizePath: converts backslashes to forward slashes', () => {
	assert.equal(normalizePath('C:/Users/name/repo/file.ts'), 'C:/Users/name/repo/file.ts');
});

test('normalizePath: preserves existing forward slashes', () => {
	assert.equal(normalizePath('/home/user/repo/file.ts'), '/home/user/repo/file.ts');
});

test('normalizePath: handles empty string', () => {
	assert.equal(normalizePath(''), '');
});

// toPlatformPath tests
test('toPlatformPath: converts normalized paths', () => {
	const result = toPlatformPath('C:/Users/name/repo/file.ts');
	assert.ok(result.includes('Users'));
});

// splitNormalizedPath tests
test('splitNormalizedPath: returns segments', () => {
	assert.deepEqual(splitNormalizedPath('C:/Users/name/repo/file.ts'), ['C:', 'Users', 'name', 'repo', 'file.ts']);
	assert.deepEqual(splitNormalizedPath('/home/user/repo/file.ts'), ['home', 'user', 'repo', 'file.ts']);
});

// fileUriToPath tests - Branch coverage
test('fileUriToPath: keeps localhost URIs transparent', () => {
	assert.equal(fileUriToPath('file://localhost/home/user/file.txt'), '/home/user/file.txt');
});

test('fileUriToPath: handles standard file URI', () => {
	assert.equal(fileUriToPath('file:///home/user/file.txt'), '/home/user/file.txt');
});

test('fileUriToPath: returns non-file strings unchanged', () => {
	assert.equal(fileUriToPath('not-a-file-uri'), 'not-a-file-uri');
});

test('fileUriToPath: returns empty string unchanged', () => {
	assert.equal(fileUriToPath(''), '');
});

test('fileUriToPath: handles http URI unchanged', () => {
	assert.equal(fileUriToPath('http://example.com/file.txt'), 'http://example.com/file.txt');
});

// normalizePathForDedup - Branch coverage
test('normalizePathForDedup: on linux preserves case', () => {
	assert.equal(normalizePathForDedup('C:/Users/Foo', 'linux'), 'C:/Users/Foo');
});

test('normalizePathForDedup: on win32 lower-cases', () => {
	assert.equal(normalizePathForDedup('C:/Users/Foo', 'win32'), 'c:/users/foo');
});

test('normalizePathForDedup: on darwin lower-cases', () => {
	assert.equal(normalizePathForDedup('/Users/Foo/Bar', 'darwin'), '/users/foo/bar');
});

test('normalizePathForDedup: on freebsd lower-cases', () => {
	assert.equal(normalizePathForDedup('/Users/Foo', 'freebsd'), '/users/foo');
});

// stripWindowsDriveUriPrefix - Branch coverage
test('stripWindowsDriveUriPrefix: on win32 strips leading slash from drive URI', () => {
	assert.equal(stripWindowsDriveUriPrefix('/C:/repo/file.ts', 'win32'), 'C:/repo/file.ts');
});

test('stripWindowsDriveUriPrefix: on win32 strips leading slash from lowercase drive URI', () => {
	assert.equal(stripWindowsDriveUriPrefix('/c:/repo/file.ts', 'win32'), 'c:/repo/file.ts');
});

test('stripWindowsDriveUriPrefix: on linux returns path unchanged', () => {
	assert.equal(stripWindowsDriveUriPrefix('/C:/repo/file.ts', 'linux'), '/C:/repo/file.ts');
});

test('stripWindowsDriveUriPrefix: on win32 returns non-drive path unchanged', () => {
	assert.equal(stripWindowsDriveUriPrefix('/home/user/file.ts', 'win32'), '/home/user/file.ts');
});

test('stripWindowsDriveUriPrefix: on win32 returns path without leading slash unchanged', () => {
	assert.equal(stripWindowsDriveUriPrefix('C:/repo/file.ts', 'win32'), 'C:/repo/file.ts');
});

// hasWindowsDriveSegment - Branch coverage
test('hasWindowsDriveSegment: on win32 returns true for drive letter segment', () => {
	assert.equal(hasWindowsDriveSegment('C:', 'win32'), true);
});

test('hasWindowsDriveSegment: on win32 returns true for lowercase drive letter', () => {
	assert.equal(hasWindowsDriveSegment('c:', 'win32'), true);
});

test('hasWindowsDriveSegment: on linux returns false for drive letter segment', () => {
	assert.equal(hasWindowsDriveSegment('C:', 'linux'), false);
});

test('hasWindowsDriveSegment: on win32 returns false for non-drive segment', () => {
	assert.equal(hasWindowsDriveSegment('Users', 'win32'), false);
});

test('hasWindowsDriveSegment: on win32 returns false for undefined segment', () => {
	assert.equal(hasWindowsDriveSegment(undefined, 'win32'), false);
});

// normalizeToRepoRoot - strips agent-worktree segments up to the repo root
test('normalizeToRepoRoot: strips Windows .claude/worktrees segment', () => {
	assert.equal(
		normalizeToRepoRoot('C:\\Users\\me\\repos\\proj\\.claude\\worktrees\\feature-x'),
		'C:\\Users\\me\\repos\\proj'
	);
});

test('normalizeToRepoRoot: strips POSIX .claude/worktrees segment', () => {
	assert.equal(
		normalizeToRepoRoot('/home/me/repos/proj/.claude/worktrees/feature-x'),
		'/home/me/repos/proj'
	);
});

test('normalizeToRepoRoot: strips copilot-worktrees segment', () => {
	assert.equal(
		normalizeToRepoRoot('C:\\Users\\me\\repos\\proj\\copilot-worktrees\\session-123'),
		'C:\\Users\\me\\repos\\proj'
	);
});

test('normalizeToRepoRoot: strips trailing sub-path below the worktree name', () => {
	assert.equal(
		normalizeToRepoRoot('/home/me/repos/proj/.claude/worktrees/feature-x/src/app'),
		'/home/me/repos/proj'
	);
});

test('normalizeToRepoRoot: is case-insensitive for the marker segments', () => {
	assert.equal(
		normalizeToRepoRoot('/home/me/repos/proj/Copilot-Worktrees/session-123'),
		'/home/me/repos/proj'
	);
});

test('normalizeToRepoRoot: returns a plain repo path unchanged', () => {
	assert.equal(
		normalizeToRepoRoot('C:\\Users\\me\\repos\\proj'),
		'C:\\Users\\me\\repos\\proj'
	);
});

test('normalizeToRepoRoot: does not strip when the marker has no leading repo prefix', () => {
	assert.equal(normalizeToRepoRoot('copilot-worktrees/session-123'), 'copilot-worktrees/session-123');
});

test('normalizeToRepoRoot: ignores an unrelated "worktrees" folder without the .claude parent', () => {
	assert.equal(
		normalizeToRepoRoot('/home/me/repos/proj/worktrees/foo'),
		'/home/me/repos/proj/worktrees/foo'
	);
});

test('normalizeToRepoRoot: home-level ~/.claude/worktrees/<repo>/<name> keeps the repo folder', () => {
	assert.equal(
		normalizeToRepoRoot('C:\\Users\\me\\.claude\\worktrees\\my-repo\\friendly-ritchie-c20e1c'),
		'C:\\Users\\me\\.claude\\worktrees\\my-repo'
	);
	assert.equal(
		normalizeToRepoRoot('/home/me/.copilot/worktrees/my-repo/local-supreme-enigma/src'),
		'/home/me/.copilot/worktrees/my-repo'
	);
});

test('getRepoNameFromWorkspacePath: home-level agent worktrees resolve to the repo, not the worktree name', () => {
	assert.equal(getRepoNameFromWorkspacePath('C:\\Users\\me\\.claude\\worktrees\\my-repo\\friendly-ritchie-c20e1c'), 'my-repo');
	assert.equal(getRepoNameFromWorkspacePath('/home/me/.copilot/worktrees/my-repo/desktop-app-release-33c7b8'), 'my-repo');
});

test('normalizeToRepoRoot: strips Copilot App "<repo>.worktrees" sibling folder (Windows)', () => {
	assert.equal(
		normalizeToRepoRoot('C:\\Users\\me\\repos\\rajbos\\proj.worktrees\\copilot-worktree-2026-02-07T20-38-48'),
		'C:\\Users\\me\\repos\\rajbos\\proj'
	);
});

test('normalizeToRepoRoot: strips Copilot App "<repo>.worktrees" sibling folder (POSIX)', () => {
	assert.equal(
		normalizeToRepoRoot('/home/me/repos/rajbos/proj.worktrees/copilot-worktree-2026-02-07T20-38-48'),
		'/home/me/repos/rajbos/proj'
	);
});

test('normalizeToRepoRoot: strips trailing sub-path below a "<repo>.worktrees" worktree name', () => {
	assert.equal(
		normalizeToRepoRoot('/home/me/repos/rajbos/proj.worktrees/copilot-worktree-abc/src/app'),
		'/home/me/repos/rajbos/proj'
	);
});

test('normalizeToRepoRoot: strips Copilot App ".copilot/copilot-worktrees" repo root', () => {
	assert.equal(
		normalizeToRepoRoot('C:\\Users\\me\\.copilot\\copilot-worktrees\\ai-engineering-fluency\\rajbos-supreme-carnival'),
		'C:\\Users\\me\\.copilot\\copilot-worktrees\\ai-engineering-fluency'
	);
});

// getRepoNameFromWorkspacePath tests
test('getRepoNameFromWorkspacePath: app-store worktree resolves to the repo folder, not the worktree name', () => {
	assert.equal(
		getRepoNameFromWorkspacePath('C:\\Users\\me\\.copilot\\copilot-worktrees\\ai-engineering-fluency\\rajbos-supreme-carnival'),
		'ai-engineering-fluency'
	);
});

test('getRepoNameFromWorkspacePath: app-store worktree with an owner sub-segment', () => {
	assert.equal(
		getRepoNameFromWorkspacePath('C:\\Users\\me\\.copilot\\copilot-worktrees\\authority-contribution-scraper\\rajbos\\huskiest-oleta'),
		'authority-contribution-scraper'
	);
});

test('getRepoNameFromWorkspacePath: app-store worktree with a posix path', () => {
	assert.equal(
		getRepoNameFromWorkspacePath('/home/me/.copilot/copilot-worktrees/github-copilot-token-usage/rajbos-covetable-youlanda'),
		'github-copilot-token-usage'
	);
});

test('getRepoNameFromWorkspacePath: user-repo copilot-worktrees layout resolves to the repo before the marker', () => {
	assert.equal(
		getRepoNameFromWorkspacePath('C:\\Users\\me\\repos\\proj\\copilot-worktrees\\session-123'),
		'proj'
	);
});

test('getRepoNameFromWorkspacePath: claude worktree layout resolves to the repo before the marker', () => {
	assert.equal(
		getRepoNameFromWorkspacePath('/home/me/repos/proj/.claude/worktrees/feature-x'),
		'proj'
	);
});

test('getRepoNameFromWorkspacePath: plain repo path returns its basename', () => {
	assert.equal(
		getRepoNameFromWorkspacePath('C:\\Users\\me\\repos\\my-repo'),
		'my-repo'
	);
});

test('getRepoNameFromWorkspacePath: Copilot App "<repo>.worktrees" layout resolves to the repo, not the worktree name', () => {
	assert.equal(
		getRepoNameFromWorkspacePath('C:\\Users\\me\\repos\\rajbos\\proj.worktrees\\copilot-worktree-2026-02-07T20-38-48'),
		'proj'
	);
});
