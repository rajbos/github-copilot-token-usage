import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	collectSessionContentReferences,
	extractRepositoryFromSessionContent,
	extractWorkspaceRepository,
	requestContentReferences,
	toolArgumentPathReferences,
} from '../../../src/sessionRepository';

const ref = (fsPath: string) => ({ kind: 'reference', reference: { fsPath } });

test('requestContentReferences: a request\'s own references, or nothing', () => {
	assert.deepEqual(requestContentReferences({ contentReferences: [ref('/a/b.ts')] }), [ref('/a/b.ts')]);
	assert.deepEqual(requestContentReferences({ contentReferences: 'nope' }), []);
	assert.deepEqual(requestContentReferences(null), []);
	assert.deepEqual(requestContentReferences(undefined), []);
});

test('toolArgumentPathReferences: path-like string arguments only', () => {
	assert.deepEqual(toolArgumentPathReferences({ path: '/repo/src/a.ts', file: 'C:\\repo\\b.ts', n: 3, short: 'a/b', text: 'hello' }), [
		ref('/repo/src/a.ts'),
		ref('C:\\repo\\b.ts'),
	]);
	assert.deepEqual(toolArgumentPathReferences(undefined), []);
	assert.deepEqual(toolArgumentPathReferences('not-an-object'), []);
});

test('collectSessionContentReferences reads VS Code JSON, VS Code delta JSONL and Copilot CLI JSONL', async () => {
	const json = JSON.stringify({ requests: [{ contentReferences: [ref('/r/a.ts')] }, { contentReferences: [ref('/r/b.ts')] }] });
	assert.deepEqual(await collectSessionContentReferences(json), [ref('/r/a.ts'), ref('/r/b.ts')]);

	const delta = [
		JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }),
		JSON.stringify({ kind: 2, k: ['requests'], v: { requestId: 'r1', message: { text: 'x' }, contentReferences: [ref('/r/c.ts')] } }),
	].join('\n');
	assert.deepEqual(await collectSessionContentReferences(delta), [ref('/r/c.ts')]);

	const cli = [
		JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
		JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'view', arguments: { path: '/r/d.ts' } } }),
		'not json',
	].join('\n');
	assert.deepEqual(await collectSessionContentReferences(cli), [ref('/r/d.ts')]);

	assert.deepEqual(await collectSessionContentReferences('{ broken'), []);
	assert.deepEqual(await collectSessionContentReferences(JSON.stringify({ requests: 'nope' })), []);
});

test('extractRepositoryFromSessionContent finds the remote of the referenced files\' repository', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-'));
	try {
		const repo = path.join(root, 'widget');
		fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
		fs.mkdirSync(path.join(repo, 'src'));
		fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
		const file = path.join(repo, 'src', 'index.ts');
		fs.writeFileSync(file, '');

		const content = JSON.stringify({ requests: [{ contentReferences: [ref(file)] }] });
		assert.equal(await extractRepositoryFromSessionContent(content), 'https://github.com/acme/widget.git');
		assert.equal(await extractRepositoryFromSessionContent(JSON.stringify({ requests: [] })), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** A repository folder with an origin remote and one file, under `root`. */
function makeRepo(root: string, relative: string, name: string): { repo: string; file: string } {
	const repo = path.join(root, relative);
	fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
	fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/acme/${name}.git\n`);
	const file = path.join(repo, 'index.ts');
	fs.writeFileSync(file, '');
	return { repo, file };
}

test('extractWorkspaceRepository: a known workspace answers with its own repository, not with referenced files', async () => {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-')));
	try {
		const app = makeRepo(root, 'app', 'app');
		const lib = makeRepo(root, 'lib', 'lib');
		// A session in repo "app" that looked at repo "lib" first, or only at "lib".
		assert.equal(await extractWorkspaceRepository([ref(lib.file), ref(app.file)], app.repo), 'https://github.com/acme/app.git');
		assert.equal(await extractWorkspaceRepository([ref(lib.file)], app.repo), 'https://github.com/acme/app.git');
		assert.equal(await extractWorkspaceRepository([], app.repo), 'https://github.com/acme/app.git', 'no references needed');
		// Without a known workspace, the referenced files decide.
		assert.equal(await extractWorkspaceRepository([ref(lib.file)]), 'https://github.com/acme/lib.git');
		assert.equal(await extractWorkspaceRepository([]), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('extractWorkspaceRepository: a nested clone inside the workspace does not replace the workspace\'s own remote', async () => {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-')));
	try {
		const outer = makeRepo(root, 'repo', 'outer');
		const nested = makeRepo(root, path.join('repo', 'vendor', 'nested'), 'nested');
		assert.equal(await extractWorkspaceRepository([ref(nested.file)], outer.repo), 'https://github.com/acme/outer.git');
		// The nested clone opened as its own workspace is, of course, the nested repository.
		assert.equal(await extractWorkspaceRepository([], nested.repo), 'https://github.com/acme/nested.git');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('extractWorkspaceRepository: a sub-folder workspace (or deleted in-repo worktree) resolves to the enclosing repository', async () => {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-')));
	try {
		const widget = makeRepo(root, 'widget', 'widget');
		const subfolder = path.join(widget.repo, 'packages', 'api');
		fs.mkdirSync(subfolder, { recursive: true });
		assert.equal(await extractWorkspaceRepository(toolArgumentPathReferences({ path: 'src/a.ts' }), subfolder), 'https://github.com/acme/widget.git');
		const deletedWorktree = path.join(widget.repo, '.claude', 'worktrees', 'agent-a1b2c3');
		assert.equal(await extractWorkspaceRepository([], deletedWorktree), 'https://github.com/acme/widget.git');
		// A folder in no repository at all has no remote.
		const loose = path.join(root, 'loose');
		fs.mkdirSync(loose);
		assert.equal(await extractWorkspaceRepository([], loose), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('extractWorkspaceRepository: a linked worktree workspace resolves through its .git pointer', async () => {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-')));
	try {
		const main = makeRepo(root, 'main', 'gadget');
		fs.mkdirSync(path.join(main.repo, '.git', 'worktrees', 'feature'), { recursive: true });
		const wt = path.join(root, 'feature-wt');
		fs.mkdirSync(wt);
		fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main.repo, '.git', 'worktrees', 'feature')}\n`);
		assert.equal(await extractWorkspaceRepository([], wt), 'https://github.com/acme/gadget.git');
		assert.equal(await extractRepositoryFromSessionContent(JSON.stringify({ requests: [] }), undefined, wt), 'https://github.com/acme/gadget.git');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
