import test from 'node:test';
import * as assert from 'node:assert/strict';

import type { FileTouch } from '../fileActivity';
import {
	agentWorktreeInfo,
	buildRepoHeatmapViewData,
	summarizeRepoHeatmap,
	toRepoRelativePath,
	type RepoHeatmapSessionInput,
} from '../repoHeatmapViewBuilder';

const NOW = new Date(2026, 9, 22, 12, 0, 0); // 2026-10-22 local
const at = (day: string) => new Date(`${day}T12:00:00`).getTime();
const touch = (path: string, kind: FileTouch['kind'], day?: string): FileTouch => ({ path, kind, ...(day ? { ts: at(day) } : {}) });

const session = (overrides: Partial<RepoHeatmapSessionInput> & { touches: FileTouch[] }): RepoHeatmapSessionInput => ({
	repository: 'https://github.com/o/r.git',
	workspaceFolderPath: 'C:\\code\\r',
	fallbackDayKey: '2026-10-22',
	...overrides,
});

test('toRepoRelativePath: anchors under the workspace, case-insensitively, and rejects outside paths', () => {
	assert.equal(toRepoRelativePath('c:/CODE/r/src/a.ts', 'C:\\code\\r'), 'src/a.ts');
	assert.equal(toRepoRelativePath('./docs/x.md', 'C:\\code\\r'), 'docs/x.md');
	assert.equal(toRepoRelativePath('C:/Users/me/.claude/notes.md', 'C:\\code\\r'), undefined);
	assert.equal(toRepoRelativePath('C:/code/r2/a.ts', 'C:\\code\\r'), undefined, 'a sibling folder sharing a prefix is not inside');
	assert.equal(toRepoRelativePath('/abs/a.ts', undefined), undefined);
});

test('buildRepoHeatmapViewData: merges sessions of one repository across worktrees', () => {
	const data = buildRepoHeatmapViewData([
		session({ touches: [touch('C:/code/r/src/a.ts', 'read', '2026-10-22'), touch('C:/code/r/src/a.ts', 'edited', '2026-10-22')] }),
		session({ workspaceFolderPath: 'C:\\wt\\r-feature', touches: [touch('C:/wt/r-feature/src/a.ts', 'read', '2026-10-21')] }),
	], NOW);
	assert.equal(data.repos.length, 1);
	assert.equal(data.repos[0].label, 'o/r');
	assert.deepEqual(data.repos[0].files.map(f => f.path), ['src/a.ts']);
	assert.deepEqual(data.repos[0].files[0].days, { '2026-10-22': [1, 1, 0, 0], '2026-10-21': [1, 0, 0, 0] });
});

test('buildRepoHeatmapViewData: touches outside the workspace are counted, not shown; touches without ts use the session day', () => {
	const data = buildRepoHeatmapViewData([
		session({ fallbackDayKey: '2026-10-20', touches: [touch('C:/elsewhere/x.ts', 'read'), touch('C:/code/r/b.ts', 'created')] }),
	], NOW);
	assert.equal(data.outsideRepoTouches, 1);
	assert.deepEqual(data.repos[0].files[0].days, { '2026-10-20': [0, 0, 1, 0] });
});

test('buildRepoHeatmapViewData: no sessions means no data; local repos fall back to the folder name; busiest repo first', () => {
	assert.equal(buildRepoHeatmapViewData([], NOW).hasData, false);
	const data = buildRepoHeatmapViewData([
		session({ repository: undefined, workspaceFolderPath: 'C:\\code\\local-only', touches: [touch('C:/code/local-only/a.ts', 'read', '2026-10-22')] }),
		session({ touches: [touch('C:/code/r/a.ts', 'read', '2026-10-22'), touch('C:/code/r/b.ts', 'read', '2026-10-22')] }),
	], NOW);
	assert.deepEqual(data.repos.map(r => r.label), ['o/r', 'local-only']);
});

test('buildRepoHeatmapViewData: shell deletes keep the inferred flag only when every delete was inferred', () => {
	const data = buildRepoHeatmapViewData([
		session({ touches: [{ path: 'old.txt', kind: 'deleted', inferred: true, ts: at('2026-10-22') }, { path: 'C:/code/r/kept.txt', kind: 'deleted', ts: at('2026-10-22') }] }),
	], NOW);
	const byPath = Object.fromEntries(data.repos[0].files.map(f => [f.path, f]));
	assert.equal(byPath['old.txt'].inferredDeletes, true);
	assert.equal(byPath['kept.txt'].inferredDeletes, undefined);
});

test('summarizeRepoHeatmap: groups files by folder and filters on the standard periods', () => {
	const data = buildRepoHeatmapViewData([
		session({ touches: [
			touch('C:/code/r/src/a.ts', 'edited', '2026-10-22'),
			touch('C:/code/r/src/a.ts', 'read', '2026-10-22'),
			touch('C:/code/r/src/b.ts', 'read', '2026-10-10'),
			touch('C:/code/r/docs/c.md', 'read', '2026-08-01'),
			touch('C:/code/r/README.md', 'created', '2026-10-22'),
		] }),
	], NOW);
	const repo = data.repos[0];

	const today = summarizeRepoHeatmap(repo, 'today', NOW);
	assert.deepEqual(today.folders.map(f => [f.folder, f.files.map(x => x.name)]), [['src', ['a.ts']], ['.', ['README.md']]]);
	assert.deepEqual(today.counts, [1, 1, 1, 0]);

	const last30 = summarizeRepoHeatmap(repo, 'last30', NOW);
	assert.deepEqual(last30.folders.map(f => f.folder), ['src', '.']);
	assert.equal(last30.fileCount, 3);
	assert.deepEqual(last30.folders[0].files.map(f => f.name), ['a.ts', 'b.ts']);

	const month = summarizeRepoHeatmap(repo, 'currentMonth', NOW);
	assert.equal(month.fileCount, 3);

	const all = summarizeRepoHeatmap(repo, 'allTime', NOW);
	assert.equal(all.fileCount, 4);
	assert.equal(all.maxCellTotal, 2);
});

test('summarizeRepoHeatmap: the kind filter hides files with no selected activity', () => {
	const data = buildRepoHeatmapViewData([
		session({ touches: [touch('C:/code/r/a.ts', 'read', '2026-10-22'), touch('C:/code/r/b.ts', 'edited', '2026-10-22'), touch('C:/code/r/c.ts', 'deleted', '2026-10-22')] }),
	], NOW);
	const edits = summarizeRepoHeatmap(data.repos[0], 'allTime', NOW, new Set(['edited']));
	assert.deepEqual(edits.folders[0].files.map(f => f.name), ['b.ts']);
	const deletes = summarizeRepoHeatmap(data.repos[0], 'allTime', NOW, new Set(['deleted', 'created']));
	assert.deepEqual(deletes.folders[0].files.map(f => f.name), ['c.ts']);
});

test('summarizeRepoHeatmap: future-dated activity is excluded', () => {
	const data = buildRepoHeatmapViewData([session({ touches: [touch('C:/code/r/a.ts', 'read', '2026-11-30')] })], NOW);
	assert.equal(summarizeRepoHeatmap(data.repos[0], 'allTime', NOW).fileCount, 0);
});

test('agentWorktreeInfo: recognises the agent worktree layouts and ignores ordinary folders', () => {
	assert.deepEqual(agentWorktreeInfo(String.raw`C:\Users\me\.claude\worktrees\repo\feat-1\src\a.ts`), { root: 'C:/Users/me/.claude/worktrees/repo/feat-1', repoName: 'repo' });
	assert.deepEqual(agentWorktreeInfo('C:/Users/me/.copilot/copilot-worktrees/repo/local-x'), { root: 'C:/Users/me/.copilot/copilot-worktrees/repo/local-x', repoName: 'repo' });
	assert.deepEqual(agentWorktreeInfo('/code/repo.worktrees/topic/src/a.ts'), { root: '/code/repo.worktrees/topic', repoName: 'repo' });
	assert.equal(agentWorktreeInfo('C:/code/repo/src/a.ts'), undefined);
});

test('buildRepoHeatmapViewData: worktrees without a remote group by repository name and join the matching remote', () => {
	const wt = (name: string, file: string, repository?: string): RepoHeatmapSessionInput => session({
		repository,
		workspaceFolderPath: `C:/Users/me/.claude/worktrees/r/${name}`,
		touches: [touch(`C:/Users/me/.claude/worktrees/r/${name}/${file}`, 'edited', '2026-10-22')],
	});
	const data = buildRepoHeatmapViewData([
		wt('one', 'src/a.ts'),
		wt('two', 'src/a.ts'),
		wt('three', 'src/b.ts', 'https://github.com/o/r.git'),
	], NOW);
	assert.equal(data.repos.length, 1, 'the name-keyed worktrees merge into o/r');
	assert.equal(data.repos[0].label, 'o/r');
	const byPath = Object.fromEntries(data.repos[0].files.map(f => [f.path, f.days['2026-10-22']]));
	assert.deepEqual(byPath, { 'src/a.ts': [0, 2, 0, 0], 'src/b.ts': [0, 1, 0, 0] });

	const lone = buildRepoHeatmapViewData([wt('one', 'x.ts')], NOW);
	assert.equal(lone.repos[0].label, 'r', 'no matching remote: the worktree repository name');
});

test('buildRepoHeatmapViewData: a touch inside another worktree than the session folder belongs to that worktree repository', () => {
	const data = buildRepoHeatmapViewData([
		session({
			repository: undefined,
			workspaceFolderPath: 'C:/Users/me/group',
			touches: [touch('C:/Users/me/.claude/worktrees/other/wt-1/src/a.ts', 'read', '2026-10-22'), touch('C:/Users/me/group/notes.md', 'read', '2026-10-22')],
		}),
	], NOW);
	assert.deepEqual(data.repos.map(r => [r.label, r.files.map(f => f.path)]).sort(), [['group', ['notes.md']], ['other', ['src/a.ts']]]);
});

test('buildRepoHeatmapViewData: two remotes ending in the same name stay separate rather than guess', () => {
	const remote = (url: string): RepoHeatmapSessionInput => session({ repository: url, workspaceFolderPath: 'C:/code/x', touches: [touch('C:/code/x/a.ts', 'read', '2026-10-22')] });
	const data = buildRepoHeatmapViewData([
		remote('https://github.com/a/r.git'),
		remote('https://github.com/b/r.git'),
		session({ repository: undefined, workspaceFolderPath: 'C:/Users/me/.claude/worktrees/r/w', touches: [touch('C:/Users/me/.claude/worktrees/r/w/z.ts', 'read', '2026-10-22')] }),
	], NOW);
	assert.equal(data.repos.length, 3);
});
