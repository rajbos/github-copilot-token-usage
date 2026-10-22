import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { extractSessionCwd } from '../fileActivity';
import {
	deserializeRepoHeatmapCache,
	REPO_HEATMAP_CACHE_VERSION,
	resolveWorkspaceRoot,
	scanRepoHeatmapSessions,
	serializeRepoHeatmapCache,
} from '../repoHeatmapCollector';
import { buildRepoHeatmapViewData } from '../repoHeatmapViewBuilder';

function makeTempDir(t: { after: (fn: () => void) => void }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-heatmap-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const claudeLog = (cwd: string, filePath: string): string => [
	JSON.stringify({ type: 'user', cwd, timestamp: '2026-10-20T09:00:00.000Z', message: { role: 'user', content: 'hi' } }),
	JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-10-20T09:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: filePath } }] } }),
	JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-10-20T09:00:09.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: filePath } }] } }),
].join('\n');

test('resolveWorkspaceRoot: agent worktree layouts resolve to the worktree root, even when it is gone', () => {
	assert.equal(resolveWorkspaceRoot('C:\\Users\\me\\.claude\\worktrees\\repo\\feature-1\\vscode-extension'), 'C:/Users/me/.claude/worktrees/repo/feature-1');
	assert.equal(resolveWorkspaceRoot('C:\\Users\\me\\.copilot\\copilot-worktrees\\repo\\local-sturdy'), 'C:/Users/me/.copilot/copilot-worktrees/repo/local-sturdy');
	assert.equal(resolveWorkspaceRoot('/home/me/code/repo.worktrees/topic/src'), '/home/me/code/repo.worktrees/topic');
});

test('resolveWorkspaceRoot: a plain folder resolves to its git root, else to itself', (t) => {
	const dir = makeTempDir(t);
	const nested = path.join(dir, 'a', 'b');
	fs.mkdirSync(nested, { recursive: true });
	assert.equal(resolveWorkspaceRoot(nested), nested, 'no .git anywhere above: the cwd');
	fs.mkdirSync(path.join(dir, 'a', '.git'));
	assert.equal(resolveWorkspaceRoot(nested), path.join(dir, 'a'));
});

test('extractSessionCwd: Claude events and Copilot CLI session.start both carry one', () => {
	assert.equal(extractSessionCwd(claudeLog('/work/r', '/work/r/a.ts')), '/work/r');
	assert.equal(extractSessionCwd(JSON.stringify({ type: 'session.start', data: { context: { cwd: 'C:\\w\\r' } } })), 'C:\\w\\r');
	assert.equal(extractSessionCwd('{"type":"user"}'), undefined);
});

test('scanRepoHeatmapSessions: reads sessions, caches by mtime and size, drops vanished files', async (t) => {
	const dir = makeTempDir(t);
	const repoDir = path.join(dir, 'repo');
	fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
	const sessionFile = path.join(dir, 'session.jsonl');
	const emptyFile = path.join(dir, 'empty.jsonl');
	fs.writeFileSync(sessionFile, claudeLog(repoDir, path.join(repoDir, 'src', 'a.ts')));
	fs.writeFileSync(emptyFile, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));

	const cache = new Map();
	const deps = { ecosystems: [] };
	const sessions = await scanRepoHeatmapSessions(deps, [sessionFile, emptyFile], cache, { concurrency: 2 });
	assert.equal(sessions.length, 1, 'a session with no file activity yields no input');
	assert.equal(cache.size, 2, 'both files are cached, the empty one as null');

	const data = buildRepoHeatmapViewData(sessions, new Date(2026, 9, 22));
	assert.deepEqual(data.repos[0].files.map(f => f.path), ['src/a.ts']);
	assert.deepEqual(data.repos[0].files[0].days['2026-10-20'], [1, 1, 0, 0]);

	// An unchanged file is served from the cache: corrupting the cached input proves it was not re-read.
	cache.get(sessionFile).input = null;
	assert.equal((await scanRepoHeatmapSessions(deps, [sessionFile, emptyFile], cache)).length, 0);

	// Files that disappeared are dropped from the cache.
	await scanRepoHeatmapSessions(deps, [emptyFile], cache);
	assert.deepEqual([...cache.keys()], [emptyFile]);
});

test('scanRepoHeatmapSessions: an unreadable file is reported and skipped, progress reaches the total', async (t) => {
	const dir = makeTempDir(t);
	const missing = path.join(dir, 'gone.jsonl');
	const errors: string[] = [];
	const progress: [number, number][] = [];
	const sessions = await scanRepoHeatmapSessions({ ecosystems: [] }, [missing], new Map(), {
		onError: file => errors.push(file),
		onProgress: (done, total) => progress.push([done, total]),
	});
	assert.deepEqual(sessions, []);
	assert.deepEqual(errors, [missing]);
	assert.deepEqual(progress, [[1, 1]]);
});

test('heatmap cache serialization round-trips and rejects other versions and corruption', () => {
	const cache = new Map([['/s/a.jsonl', { mtimeMs: 5, size: 9, input: null }]]);
	assert.deepEqual([...deserializeRepoHeatmapCache(serializeRepoHeatmapCache(cache))], [...cache]);
	assert.equal(deserializeRepoHeatmapCache(JSON.stringify({ version: REPO_HEATMAP_CACHE_VERSION + 1, entries: [] })).size, 0);
	assert.equal(deserializeRepoHeatmapCache('{not json').size, 0);
	assert.equal(deserializeRepoHeatmapCache(undefined).size, 0);
});
