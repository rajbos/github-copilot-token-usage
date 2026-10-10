import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	groupWorkspaces,
	detectArtefactWorkspaceNames,
	classifyArtefactName,
	matchWorktreeConvention,
	repositoryIdentity,
	workspaceBasename,
	mergeGroupCustomizationFiles,
	workspaceProbePaths,
	workspaceEntriesWithRemotes,
	groupFolders,
	type WorkspaceUsageEntry,
	type WorkspaceGroupingProbes,
	type WorkspaceGitInfo,
	type WorkspaceGroup,
} from '../../../src/workspaceGrouping';
import { readWorkspaceGitInfo, prefetchWorkspaceGroupingProbes } from '../../../src/workspaceGroupingProbes';

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(p: string, sessionCount = 1, interactionCount = 1, repository?: string): WorkspaceUsageEntry {
	return { path: p, sessionCount, interactionCount, ...(repository ? { repository } : {}) };
}

/** Offline probes: `existing` paths exist; `git` maps a folder to its git facts. */
function probes(platform: string, existing: string[] = [], git: Record<string, WorkspaceGitInfo> = {}): WorkspaceGroupingProbes {
	const exists = new Set(existing);
	return {
		platform,
		pathExists: p => exists.has(p),
		readGitInfo: p => git[p],
	};
}

/** A compact, order-independent view of the groups for deepEqual. */
function summarize(groups: WorkspaceGroup[]): Array<{ name: string; canonical: string; members: string[]; sessions: number; interactions: number }> {
	return groups
		.map(g => ({ name: g.displayName, canonical: g.canonicalPath, members: g.memberPaths, sessions: g.sessionCount, interactions: g.interactionCount }))
		.sort((a, b) => a.canonical.localeCompare(b.canonical));
}

// ── Corpus: one row per known naming pattern ─────────────────────────────────
//
// To teach the grouping a new pattern: add a row here with anonymised paths, watch it fail
// (usually the hygiene invariant below names the leftover), then fix src/workspaceGrouping.ts.

interface CorpusRow {
	name: string;
	platform: string;
	entries: WorkspaceUsageEntry[];
	existing?: string[];
	git?: Record<string, WorkspaceGitInfo>;
	/** Expected groups: display name → canonical path and member paths. */
	expected: Array<{ name: string; canonical: string; members: string[] }>;
}

const CORPUS: CorpusRow[] = [
	{
		name: 'Claude desktop worktrees (~/.claude/worktrees/<repo>/<name>) fold into the main checkout',
		platform: 'win32',
		entries: [
			entry('C:\\Users\\dev\\code\\acme-app', 3, 30),
			entry('C:\\Users\\dev\\.claude\\worktrees\\acme-app\\goofy-wozniak-42f712', 2, 20),
			entry('C:\\Users\\dev\\.claude\\worktrees\\acme-app\\friendly-ritchie-c20e1c', 1, 10),
		],
		expected: [{
			name: 'acme-app', canonical: 'C:\\Users\\dev\\code\\acme-app', members: [
				'C:\\Users\\dev\\.claude\\worktrees\\acme-app\\friendly-ritchie-c20e1c',
				'C:\\Users\\dev\\.claude\\worktrees\\acme-app\\goofy-wozniak-42f712',
				'C:\\Users\\dev\\code\\acme-app',
			],
		}],
	},
	{
		name: 'Claude desktop worktrees without the main checkout still group under the repo name',
		platform: 'win32',
		entries: [
			entry('C:\\Users\\dev\\.claude\\worktrees\\acme-app\\goofy-wozniak-42f712', 1, 5),
			entry('C:\\Users\\dev\\.claude\\worktrees\\acme-app\\brave-curie-0a1b2c', 1, 9),
		],
		expected: [{
			name: 'acme-app', canonical: 'C:\\Users\\dev\\.claude\\worktrees\\acme-app\\brave-curie-0a1b2c', members: [
				'C:\\Users\\dev\\.claude\\worktrees\\acme-app\\brave-curie-0a1b2c',
				'C:\\Users\\dev\\.claude\\worktrees\\acme-app\\goofy-wozniak-42f712',
			],
		}],
	},
	{
		name: 'Claude Code CLI worktree inside the repo (<repo>/.claude/worktrees/<name>)',
		platform: 'linux',
		entries: [
			entry('/home/dev/src/widget', 2, 4),
			entry('/home/dev/src/widget/.claude/worktrees/agent-a1b2c3', 1, 3),
		],
		expected: [{ name: 'widget', canonical: '/home/dev/src/widget', members: ['/home/dev/src/widget', '/home/dev/src/widget/.claude/worktrees/agent-a1b2c3'] }],
	},
	{
		name: 'Copilot app worktrees (copilot-worktrees/<repo>/<name>) fold into ~/.copilot/repos/<repo>',
		platform: 'win32',
		entries: [entry('C:\\Users\\dev\\.copilot\\copilot-worktrees\\acme-api\\copilot-fix-123', 2, 8)],
		existing: ['C:\\Users\\dev\\.copilot\\repos\\acme-api'],
		expected: [{ name: 'acme-api', canonical: 'C:\\Users\\dev\\.copilot\\repos\\acme-api', members: ['C:\\Users\\dev\\.copilot\\copilot-worktrees\\acme-api\\copilot-fix-123'] }],
	},
	{
		name: 'Copilot app worktree whose repos checkout is gone stays named after the repo',
		platform: 'darwin',
		entries: [entry('/Users/dev/.copilot/copilot-worktrees/acme-api/copilot-fix-123', 2, 8)],
		expected: [{ name: 'acme-api', canonical: '/Users/dev/.copilot/copilot-worktrees/acme-api/copilot-fix-123', members: ['/Users/dev/.copilot/copilot-worktrees/acme-api/copilot-fix-123'] }],
	},
	{
		name: 'sibling worktree folder <repo>-refactor-wt',
		platform: 'win32',
		entries: [entry('C:\\code\\acme-app', 5, 50), entry('C:\\code\\acme-app-refactor-wt', 1, 2)],
		expected: [{ name: 'acme-app', canonical: 'C:\\code\\acme-app', members: ['C:\\code\\acme-app', 'C:\\code\\acme-app-refactor-wt'] }],
	},
	{
		name: 'sibling worktree folder <repo>-wt',
		platform: 'linux',
		entries: [entry('/srv/acme-app-wt', 4, 40), entry('/srv/acme-app', 1, 1)],
		expected: [{ name: 'acme-app', canonical: '/srv/acme-app', members: ['/srv/acme-app', '/srv/acme-app-wt'] }],
	},
	{
		name: 'scratch clone with a hash suffix (<repo>-85ed99)',
		platform: 'win32',
		entries: [entry('C:\\code\\acme-app', 2, 2), entry('C:\\tmp\\acme-app-85ed99', 9, 90)],
		expected: [{ name: 'acme-app', canonical: 'C:\\code\\acme-app', members: ['C:\\code\\acme-app', 'C:\\tmp\\acme-app-85ed99'] }],
	},
	{
		name: 'same repository cloned twice',
		platform: 'win32',
		entries: [entry('C:\\code\\acme-app', 1, 1), entry('D:\\work\\acme-app', 2, 7)],
		expected: [{ name: 'acme-app', canonical: 'D:\\work\\acme-app', members: ['C:\\code\\acme-app', 'D:\\work\\acme-app'] }],
	},
	{
		name: 'case-only difference on Windows',
		platform: 'win32',
		entries: [entry('C:\\Code\\Acme-App', 1, 1), entry('c:\\code\\acme-app', 3, 3)],
		expected: [{ name: 'acme-app', canonical: 'c:\\code\\acme-app', members: ['C:\\Code\\Acme-App', 'c:\\code\\acme-app'] }],
	},
	{
		name: 'WSL / remote path with the same folder name as a local checkout',
		platform: 'win32',
		entries: [entry('/home/dev/acme-app', 10, 100), entry('C:\\code\\acme-app', 1, 1)],
		expected: [{ name: 'acme-app', canonical: 'C:\\code\\acme-app', members: ['/home/dev/acme-app', 'C:\\code\\acme-app'] }],
	},
	{
		name: 'WSL path inside a Claude desktop worktree layout joins the local checkout',
		platform: 'win32',
		entries: [
			entry('C:\\code\\acme-app', 2, 2),
			entry('/home/dev/.claude/worktrees/acme-app/goofy-wozniak-42f712', 3, 3),
		],
		expected: [{ name: 'acme-app', canonical: 'C:\\code\\acme-app', members: ['/home/dev/.claude/worktrees/acme-app/goofy-wozniak-42f712', 'C:\\code\\acme-app'] }],
	},
	{
		name: 'branch-named worktree joined by its session git remote (Copilot Chat / CLI repository field)',
		platform: 'win32',
		entries: [
			entry('C:\\code\\checkout-a', 1, 1, 'https://github.com/acme/widget.git'),
			entry('C:\\scratch\\groups-dashboard-layout-85ed99', 2, 2, 'git@github.com:acme/widget.git'),
		],
		expected: [{ name: 'widget', canonical: 'C:\\code\\checkout-a', members: ['C:\\code\\checkout-a', 'C:\\scratch\\groups-dashboard-layout-85ed99'] }],
	},
	{
		name: 'existing worktree resolved through its .git pointer to a main checkout not in the list',
		platform: 'win32',
		entries: [entry('C:\\wt\\copilot-server-memories-027fbb', 2, 6)],
		existing: ['C:\\wt\\copilot-server-memories-027fbb', 'C:\\code\\gadget'],
		git: { 'C:\\wt\\copilot-server-memories-027fbb': { mainWorktreePath: 'C:\\code\\gadget' } },
		expected: [{ name: 'gadget', canonical: 'C:\\code\\gadget', members: ['C:\\wt\\copilot-server-memories-027fbb'] }],
	},
	{
		name: 'JetBrains / Copilot CLI cwd under a worktree sub-folder still groups by the Claude layout',
		platform: 'linux',
		entries: [
			entry('/home/dev/acme-app', 1, 1),
			entry('/home/dev/.claude/worktrees/acme-app/eager-hopper-9f8e7d/server', 1, 1),
		],
		expected: [{ name: 'acme-app', canonical: '/home/dev/acme-app', members: ['/home/dev/.claude/worktrees/acme-app/eager-hopper-9f8e7d/server', '/home/dev/acme-app'] }],
	},
];

for (const row of CORPUS) {
	test(`corpus: ${row.name}`, () => {
		const groups = groupWorkspaces(row.entries, probes(row.platform, row.existing, row.git));
		assert.deepEqual(
			groups.map(g => ({ name: g.displayName, canonical: g.canonicalPath, members: g.memberPaths })).sort((a, b) => a.canonical.localeCompare(b.canonical)),
			[...row.expected].sort((a, b) => a.canonical.localeCompare(b.canonical)),
		);
		const totalSessions = row.entries.reduce((s, e) => s + e.sessionCount, 0);
		const totalInteractions = row.entries.reduce((s, e) => s + e.interactionCount, 0);
		assert.equal(groups.reduce((s, g) => s + g.sessionCount, 0), totalSessions, 'sessions are conserved');
		assert.equal(groups.reduce((s, g) => s + g.interactionCount, 0), totalInteractions, 'interactions are conserved');
	});
}

test('corpus invariant: after grouping no display name looks like a worktree or clone artefact', () => {
	for (const row of CORPUS) {
		const groups = groupWorkspaces(row.entries, probes(row.platform, row.existing, row.git));
		assert.deepEqual(detectArtefactWorkspaceNames(groups), [], row.name);
	}
});

/** Rows are permuted exhaustively, which is factorial: keep each row small (6 entries = 720 orders). */
const MAX_PERMUTED_ENTRIES = 6;

test('corpus invariant: every row gives the same groups in every input order', () => {
	for (const row of CORPUS) {
		assert.ok(row.entries.length <= MAX_PERMUTED_ENTRIES, `${row.name}: split rows above ${MAX_PERMUTED_ENTRIES} entries, every order is checked`);
		const p = probes(row.platform, row.existing, row.git);
		const expected = summarize(groupWorkspaces(row.entries, p));
		for (const order of permutations(row.entries)) {
			assert.deepEqual(summarize(groupWorkspaces(order, p)), expected, row.name);
		}
	}
});

// ── Precedence: remotes veto weaker signals ──────────────────────────────────

test('same basename but different remotes stays two groups', () => {
	const groups = groupWorkspaces([
		entry('C:\\a\\app', 1, 1, 'https://github.com/acme/app'),
		entry('C:\\b\\app', 1, 1, 'https://github.com/other/app'),
	], probes('win32'));
	assert.equal(groups.length, 2);
	assert.deepEqual(groups.map(g => g.repositoryId).sort(), ['github.com/acme/app', 'github.com/other/app']);
});

test('a -wt / hash name pattern never merges across different remotes', () => {
	const groups = groupWorkspaces([
		entry('C:\\code\\acme-app', 1, 1, 'https://github.com/acme/acme-app'),
		entry('C:\\code\\acme-app-wt', 1, 1, 'https://github.com/fork/something-else'),
		entry('C:\\code\\acme-app-85ed99', 1, 1, 'https://github.com/fork/third'),
	], probes('win32'));
	assert.equal(groups.length, 3);
});

/** Every ordering of `items`. */
function permutations<T>(items: T[]): T[][] {
	if (items.length <= 1) { return [items]; }
	return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
}

test('remote identity beats basename: a remote-less folder between two repositories of the same name stays apart, in every order', () => {
	const entries = [
		entry('C:\\one\\tools', 1, 1, 'https://github.com/acme/tools'),
		entry('C:\\two\\tools', 1, 1),
		entry('C:\\three\\tools', 1, 1, 'https://github.com/other/tools'),
	];
	for (const order of permutations(entries)) {
		const groups = groupWorkspaces(order, probes('win32'));
		assert.deepEqual(groups.map(g => g.memberPaths).sort(), [['C:\\one\\tools'], ['C:\\three\\tools'], ['C:\\two\\tools']]);
	}
});

test('ambiguous name: several remote-less same-named folders still fold together, apart from both repositories', () => {
	const entries = [
		entry('C:\\one\\tools', 1, 1, 'https://github.com/acme/tools'),
		entry('C:\\two\\tools', 1, 1),
		entry('D:\\two\\tools', 1, 1),
		entry('C:\\three\\tools', 1, 1, 'https://github.com/other/tools'),
	];
	for (const order of permutations(entries)) {
		const groups = groupWorkspaces(order, probes('win32'));
		assert.deepEqual(groups.map(g => g.memberPaths).sort(), [['C:\\one\\tools'], ['C:\\three\\tools'], ['C:\\two\\tools', 'D:\\two\\tools']]);
	}
});

test('ambiguous stem: a scratch clone with two same-named repositories to choose from joins neither, in every order', () => {
	const entries = [
		entry('C:\\a\\tools', 1, 1, 'https://github.com/acme/tools'),
		entry('C:\\b\\tools', 1, 1, 'https://github.com/other/tools'),
		entry('C:\\tmp\\tools-85ed99', 1, 1),
	];
	for (const order of permutations(entries)) {
		assert.equal(groupWorkspaces(order, probes('win32')).length, 3);
	}
});

test('a -wt folder only joins a sibling checkout; a hash-suffixed clone may sit anywhere', () => {
	// Different parent folders: not a sibling worktree, so no merge on the name alone.
	assert.equal(groupWorkspaces([entry('/projects/acme'), entry('/unrelated/acme-feature-wt')], probes('linux')).length, 2);
	assert.equal(groupWorkspaces([entry('C:\\projects\\acme'), entry('D:\\other\\acme-wt')], probes('win32')).length, 2);
	// Same parent: a sibling worktree.
	assert.equal(groupWorkspaces([entry('/projects/acme'), entry('/projects/acme-feature-wt')], probes('linux')).length, 1);
	assert.equal(groupWorkspaces([entry('C:\\Projects\\acme'), entry('c:\\projects\\acme-wt\\')], probes('win32')).length, 1, 'case and a trailing separator do not matter on Windows');
	// A scratch clone matches across folders.
	assert.equal(groupWorkspaces([entry('/projects/acme'), entry('/tmp/acme-85ed99')], probes('linux')).length, 1);
	// … and the -wt folder in another folder is flagged as an artefact instead of merged.
	const leftovers = detectArtefactWorkspaceNames(groupWorkspaces([entry('/projects/acme'), entry('/unrelated/acme-feature-wt')], probes('linux')));
	assert.deepEqual(leftovers.map(l => [l.displayName, l.reason]), [['acme-feature-wt', 'worktree-suffix']]);
});

test('ambiguous remote path: a WSL folder named like two different local repositories joins neither, in every order', () => {
	const entries = [
		entry('C:\\a\\tools', 1, 1, 'https://github.com/acme/tools'),
		entry('C:\\b\\tools', 1, 1, 'https://github.com/other/tools'),
		entry('/home/dev/tools', 1, 1),
	];
	for (const order of permutations(entries)) {
		const groups = groupWorkspaces(order, probes('win32'));
		assert.ok(groups.some(g => g.memberPaths.length === 1 && g.memberPaths[0] === '/home/dev/tools'));
		assert.equal(groups.length, 3);
	}
});

test('ambiguous component: a remote-less local folder between two remote paths of different repositories joins neither, in every order', () => {
	const entries = [
		entry('C:\\work\\tools', 1, 1),
		entry('/home/a/tools', 1, 1, 'https://github.com/acme/tools'),
		entry('/home/b/tools', 1, 1, 'https://github.com/other/tools'),
	];
	for (const order of permutations(entries)) {
		const groups = groupWorkspaces(order, probes('win32'));
		assert.deepEqual(groups.map(g => g.memberPaths).sort(), [['/home/a/tools'], ['/home/b/tools'], ['C:\\work\\tools']]);
	}
});

test('a path seen with two different remotes has no identity, so neither remote claims it', () => {
	const entries = [
		entry('C:\\reused\\tools', 1, 1, 'https://github.com/acme/tools'),
		entry('C:\\reused\\tools', 1, 1, 'https://github.com/other/tools'),
		entry('D:\\acme\\checkout', 1, 1, 'https://github.com/acme/tools'),
		entry('D:\\other\\checkout', 1, 1, 'https://github.com/other/tools'),
	];
	for (const order of permutations(entries)) {
		const groups = groupWorkspaces(order, probes('win32'));
		const reused = groups.find(g => g.memberPaths.includes('C:\\reused\\tools'))!;
		assert.deepEqual(reused.memberPaths, ['C:\\reused\\tools']);
		assert.equal(reused.repositoryId, undefined);
		assert.equal(reused.sessionCount, 2);
	}
	// The same remote twice is not a conflict.
	const [same] = groupWorkspaces([entry('C:\\r', 1, 1, 'acme/r'), entry('C:\\r', 1, 1, 'https://github.com/acme/r.git')], probes('win32'));
	assert.equal(same.repositoryId, 'github.com/acme/r');
});

test('a conflicted path is not merged by name even when only one same-named repository is a candidate', () => {
	const cases: Array<[string, WorkspaceUsageEntry[]]> = [
		['basename', [
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/acme/tools'),
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/other/tools'),
			entry('D:\\acme\\tools', 1, 1, 'https://github.com/acme/tools'),
		]],
		['stem', [
			entry('C:\\reused\\tools-wt', 1, 1, 'https://github.com/acme/tools'),
			entry('C:\\reused\\tools-wt', 1, 1, 'https://github.com/other/tools'),
			entry('D:\\acme\\tools', 1, 1, 'https://github.com/acme/tools'),
		]],
		['stem target', [
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/acme/tools'),
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/other/tools'),
			entry('D:\\code\\tools-wt', 1, 1),
		]],
		['remote path', [
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/acme/tools'),
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/other/tools'),
			entry('/home/dev/tools', 1, 1),
		]],
		['remote-less same name', [
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/acme/tools'),
			entry('C:\\reused\\tools', 1, 1, 'https://github.com/other/tools'),
			entry('D:\\plain\\tools', 1, 1),
		]],
	];
	for (const [name, entries] of cases) {
		for (const order of permutations(entries)) {
			const groups = groupWorkspaces(order, probes('win32'));
			const reused = groups.find(g => g.memberPaths.some(m => m.startsWith('C:\\reused')))!;
			assert.equal(reused.memberPaths.length, 1, name);
			assert.equal(reused.sessionCount, 2, name);
		}
	}
});

test('a session remote that disagrees with the folder\'s current .git remote makes the folder conflicting', () => {
	const reused = 'C:\\reused\\tools';
	const p = probes('win32', [reused], { [reused]: { remote: 'https://github.com/other/two' } });
	const acme = entry('D:\\acme\\tools', 1, 1, 'https://github.com/acme/one');
	for (const order of permutations([entry(reused, 2, 2, 'https://github.com/acme/one'), acme])) {
		const groups = groupWorkspaces(order, p);
		const group = groups.find(g => g.canonicalPath === reused)!;
		assert.deepEqual(group.memberPaths, [reused], 'not merged with acme/one by name');
		assert.equal(group.repositoryId, undefined);
	}
	// The flag survives folding duplicate paths, whichever observation comes first.
	for (const order of permutations([entry(reused, 1, 1, 'https://github.com/acme/one'), entry(reused, 1, 1), acme])) {
		const group = groupWorkspaces(order, p).find(g => g.canonicalPath === reused)!;
		assert.deepEqual(group.memberPaths, [reused]);
		assert.equal(group.sessionCount, 2);
	}
	// Agreeing observations are one identity, not a conflict.
	const agree = probes('win32', [reused], { [reused]: { remote: 'git@github.com:acme/one.git' } });
	const [joined] = groupWorkspaces([entry(reused, 1, 1, 'acme/one'), acme], agree);
	assert.equal(joined.memberPaths.length, 2);
});

test('a conflicting folder is kept out of the worktree-pointer and case-folding merges too', () => {
	const main = 'C:\\code\\gadget';
	const wt = 'C:\\wt\\feature';
	const p = probes('win32', [main, wt], { [wt]: { mainWorktreePath: main } });
	// A worktree path seen under two repositories does not join the main checkout of one of them.
	const pointerEntries = [
		entry(main, 1, 1, 'https://github.com/acme/gadget'),
		entry(wt, 1, 1, 'https://github.com/acme/gadget'),
		entry(wt, 1, 1, 'https://github.com/other/thing'),
	];
	for (const order of permutations(pointerEntries)) {
		const groups = groupWorkspaces(order, p);
		assert.deepEqual(groups.map(g => g.memberPaths).sort(), [[main], [wt]]);
	}
	// A conflicting main checkout is not joined by its worktree either.
	const conflictingMain = [
		entry(main, 1, 1, 'https://github.com/acme/gadget'),
		entry(main, 1, 1, 'https://github.com/other/thing'),
		entry(wt, 1, 1, 'https://github.com/acme/gadget'),
	];
	for (const order of permutations(conflictingMain)) {
		assert.deepEqual(groupWorkspaces(order, p).map(g => g.memberPaths).sort(), [[main], [wt]]);
	}
	// A case-only spelling of a conflicting folder is not folded into it.
	const caseEntries = [
		entry('C:\\Reused\\Tools', 1, 1, 'https://github.com/acme/tools'),
		entry('C:\\Reused\\Tools', 1, 1, 'https://github.com/other/tools'),
		entry('c:\\reused\\tools', 1, 1, 'https://github.com/acme/tools'),
	];
	for (const order of permutations(caseEntries)) {
		const groups = groupWorkspaces(order, probes('win32'));
		const conflicted = groups.find(g => g.memberPaths.includes('C:\\Reused\\Tools'))!;
		assert.deepEqual(conflicted.memberPaths, ['C:\\Reused\\Tools']);
		assert.equal(conflicted.sessionCount, 2);
	}
});

test('a worktree whose remote differs from its existing main checkout is not merged into it', () => {
	const main = 'C:\\code\\gadget';
	const wt = 'C:\\wt\\feature';
	const p = probes('win32', [main, wt], { [wt]: { mainWorktreePath: main } });
	for (const order of permutations([entry(main, 1, 1, 'https://github.com/acme/gadget'), entry(wt, 1, 1, 'https://github.com/fork/other')])) {
		const groups = groupWorkspaces(order, p);
		assert.deepEqual(groups.map(g => g.memberPaths).sort(), [[main], [wt]]);
		assert.deepEqual(groups.map(g => g.repositoryId).sort(), ['github.com/acme/gadget', 'github.com/fork/other']);
	}
	// Same remote (or none on the main checkout): the pointer still merges them.
	assert.equal(groupWorkspaces([entry(main, 1, 1, 'acme/gadget'), entry(wt, 1, 1, 'https://github.com/acme/gadget')], p).length, 1);
	assert.equal(groupWorkspaces([entry(main, 1, 1), entry(wt, 1, 1, 'https://github.com/acme/gadget')], p).length, 1);
});

test('two worktrees with different remotes pointing at one synthetic anchor do not merge with each other', () => {
	const anchor = 'C:\\code\\gadget';
	const a = 'C:\\wt\\a';
	const b = 'C:\\wt\\b';
	const p = probes('win32', [anchor, a, b], { [a]: { mainWorktreePath: anchor }, [b]: { mainWorktreePath: anchor } });
	for (const order of permutations([entry(a, 1, 1, 'acme/one'), entry(b, 1, 1, 'acme/two')])) {
		assert.equal(groupWorkspaces(order, p).length, 2);
	}
});

test('workspaceEntriesWithRemotes keeps every remote of a folder so a reused folder reaches the grouping as conflicting', () => {
	assert.deepEqual(workspaceEntriesWithRemotes('C:\\r', 3, 9), [{ path: 'C:\\r', sessionCount: 3, interactionCount: 9 }]);
	assert.deepEqual(workspaceEntriesWithRemotes('C:\\r', 3, 9, new Set(['a/x', 'b/y', 'a/x'])), [
		{ path: 'C:\\r', sessionCount: 3, interactionCount: 9, repository: 'a/x' },
		{ path: 'C:\\r', sessionCount: 0, interactionCount: 0, repository: 'b/y' },
	]);
	const entries = [
		...workspaceEntriesWithRemotes('C:\\reused\\tools', 2, 5, ['https://github.com/acme/tools', 'https://github.com/other/tools']),
		...workspaceEntriesWithRemotes('D:\\acme\\tools', 1, 1, ['https://github.com/acme/tools']),
	];
	const groups = groupWorkspaces(entries, probes('win32'));
	assert.equal(groups.length, 2);
	const reused = groups.find(g => g.canonicalPath === 'C:\\reused\\tools')!;
	assert.equal(reused.sessionCount, 2);
	assert.equal(reused.interactionCount, 5);
	assert.equal(reused.repositoryId, undefined);
});

test('a remote path joins the single local repository it names even when that repository has a remote', () => {
	const groups = groupWorkspaces([entry('C:\\a\\tools', 1, 1, 'https://github.com/acme/tools'), entry('/home/dev/tools')], probes('win32'));
	assert.equal(groups.length, 1);
	assert.equal(groups[0].displayName, 'tools');
});

test('WSL paths in a Claude worktree layout still group by the layout (no disk access needed)', () => {
	let probed = 0;
	const p: WorkspaceGroupingProbes = { platform: 'win32', pathExists: () => { probed++; return false; } };
	const groups = groupWorkspaces([
		entry('/home/dev/.claude/worktrees/acme-app/goofy-wozniak-42f712', 1, 2),
		entry('/home/dev/.claude/worktrees/acme-app/brave-curie-0a1b2c', 1, 3),
	], p);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].displayName, 'acme-app');
	assert.deepEqual(detectArtefactWorkspaceNames(groups), []);
	// Only local paths are probed (the anchor here is remote too).
	assert.equal(probed, 0);
});

test('remote identity merges folders whose names share nothing', () => {
	const groups = groupWorkspaces([
		entry('/x/alpha', 1, 1, 'https://github.com/Acme/Widget'),
		entry('/y/beta', 1, 1, 'ssh://git@github.com/acme/widget.git'),
	], probes('linux'));
	assert.equal(groups.length, 1);
	assert.equal(groups[0].displayName, 'widget');
});

test('remote read through the probes counts as identity for existing folders', () => {
	const groups = groupWorkspaces([entry('/x/alpha'), entry('/y/beta')], probes('linux', ['/x/alpha', '/y/beta'], {
		'/x/alpha': { remote: 'https://github.com/acme/widget.git' },
		'/y/beta': { remote: 'git@github.com:acme/widget.git' },
	}));
	assert.equal(groups.length, 1);
});

test('probes are not consulted for folders that no longer exist', () => {
	let asked = 0;
	groupWorkspaces([entry('/gone/repo')], { platform: 'linux', pathExists: () => false, readGitInfo: () => { asked++; return undefined; } });
	assert.equal(asked, 0);
});

test('an artefact name with nothing to merge into is left alone, and flagged', () => {
	const groups = groupWorkspaces([entry('C:\\code\\acme-app'), entry('C:\\tmp\\groups-dashboard-layout-85ed99')], probes('win32'));
	assert.equal(groups.length, 2);
	assert.deepEqual(detectArtefactWorkspaceNames(groups).map(a => [a.displayName, a.reason]), [['groups-dashboard-layout-85ed99', 'hash-suffix']]);
});

// ── Platform rules ───────────────────────────────────────────────────────────

test('case-only differences are separate folders on Linux (but basenames still match)', () => {
	const groups = groupWorkspaces([entry('/a/Repo', 1, 1, 'https://github.com/a/one'), entry('/a/repo', 1, 1, 'https://github.com/a/two')], probes('linux'));
	assert.equal(groups.length, 2);
});

test('POSIX paths are not treated as remote on non-Windows hosts', () => {
	const groups = groupWorkspaces([entry('/home/dev/acme-app', 5, 5), entry('/srv/acme-app', 1, 1)], probes('linux'));
	assert.equal(groups.length, 1);
	assert.equal(groups[0].canonicalPath, '/home/dev/acme-app');
});

test('a remote path is never chosen as canonical over a local one', () => {
	const [g] = groupWorkspaces([entry('/home/dev/x', 100, 100), entry('C:\\x', 1, 1)], probes('win32'));
	assert.equal(g.canonicalPath, 'C:\\x');
});

test('two remote paths with the same name do not merge by basename alone', () => {
	const groups = groupWorkspaces([entry('/home/a/x'), entry('/home/b/x')], probes('win32'));
	assert.equal(groups.length, 2);
});

// ── Counts, ties, passthrough ────────────────────────────────────────────────

test('counts are summed and duplicate input paths are merged', () => {
	const groups = groupWorkspaces([entry('C:\\code\\r', 1, 2), entry('C:\\code\\r', 3, 4), entry('D:\\r', 5, 6)], probes('win32'));
	assert.equal(groups.length, 1);
	assert.equal(groups[0].sessionCount, 9);
	assert.equal(groups[0].interactionCount, 12);
	assert.deepEqual(groups[0].memberPaths, ['C:\\code\\r', 'D:\\r']);
});

test('canonical choice is deterministic on ties: interactions, then sessions, then smallest path', () => {
	const a = entry('C:\\b\\repo', 1, 1);
	const b = entry('C:\\a\\repo', 1, 1);
	assert.equal(groupWorkspaces([a, b], probes('win32'))[0].canonicalPath, 'C:\\a\\repo');
	assert.equal(groupWorkspaces([b, a], probes('win32'))[0].canonicalPath, 'C:\\a\\repo');
	assert.equal(groupWorkspaces([entry('C:\\b\\repo', 2, 1), b], probes('win32'))[0].canonicalPath, 'C:\\b\\repo');
	assert.equal(groupWorkspaces([entry('C:\\b\\repo', 1, 2), entry('C:\\a\\repo', 9, 1)], probes('win32'))[0].canonicalPath, 'C:\\b\\repo');
});

test('a clean folder name is preferred as canonical over a busier artefact folder', () => {
	const [g] = groupWorkspaces([entry('C:\\code\\repo', 1, 1), entry('C:\\code\\repo-wt', 50, 500)], probes('win32'));
	assert.equal(g.canonicalPath, 'C:\\code\\repo');
});

test('<unresolved:…> entries pass through untouched', () => {
	const groups = groupWorkspaces([entry('<unresolved:abc123>', 0, 7), entry('<unresolved:abc123-85ed99>', 0, 1), entry('C:\\x\\abc123')], probes('win32'));
	assert.equal(groups.length, 3);
	const u = groups.find(g => g.canonicalPath === '<unresolved:abc123>')!;
	assert.deepEqual(u.memberPaths, ['<unresolved:abc123>']);
	assert.equal(u.interactionCount, 7);
	assert.deepEqual(detectArtefactWorkspaceNames(groups), []);
});

test('output is sorted by interactions, then sessions', () => {
	const groups = groupWorkspaces([entry('/a/one', 9, 1), entry('/a/two', 1, 5), entry('/a/three', 2, 1)], probes('linux'));
	assert.deepEqual(groups.map(g => g.displayName), ['two', 'one', 'three']);
});

test('empty input gives no groups', () => {
	assert.deepEqual(groupWorkspaces([], probes('linux')), []);
});

test('missing probes default to "nothing exists"', () => {
	const groups = groupWorkspaces([entry('C:\\Users\\dev\\.copilot\\copilot-worktrees\\r\\w')], { platform: 'win32' });
	assert.equal(groups[0].canonicalPath, 'C:\\Users\\dev\\.copilot\\copilot-worktrees\\r\\w');
	assert.equal(groups[0].displayName, 'r');
});

test('an existing main checkout found through a worktree pointer becomes canonical even when a clean member exists', () => {
	const [g] = groupWorkspaces(
		[entry('C:\\elsewhere\\gadget', 9, 9), entry('C:\\wt\\feature', 1, 1)],
		probes('win32', ['C:\\wt\\feature', 'C:\\code\\gadget'], { 'C:\\wt\\feature': { mainWorktreePath: 'C:\\code\\gadget' } }),
	);
	assert.equal(g.canonicalPath, 'C:\\code\\gadget');
	assert.deepEqual(g.memberPaths, ['C:\\elsewhere\\gadget', 'C:\\wt\\feature']);
});

// ── Building blocks ──────────────────────────────────────────────────────────

test('repositoryIdentity normalises remote URL forms', () => {
	const widget = 'github.com/acme/widget';
	assert.equal(repositoryIdentity('https://github.com/Acme/Widget.git'), widget);
	assert.equal(repositoryIdentity('git@github.com:acme/widget.git'), widget);
	assert.equal(repositoryIdentity('ssh://git@github.com:22/acme/widget'), widget);
	assert.equal(repositoryIdentity('https://github.com/acme/widget/'), widget);
	assert.equal(repositoryIdentity('acme/widget'), widget, 'a bare owner/name is a GitHub repository');
	assert.equal(repositoryIdentity(''), undefined);
	assert.equal(repositoryIdentity(undefined), undefined);
	assert.equal(repositoryIdentity('C:/repos/widget.git'), undefined, 'a local path is not an scp-style remote');
	for (const local of ['/srv/repo.git', '../repo.git', './repo', '~/repos/repo.git', 'C:\\repos\\repo.git', 'file:///srv/repo.git', 'repos\\repo', 'C:repos/repo.git', 'd:repo']) {
		assert.equal(repositoryIdentity(local), undefined, `local remote ${local} names no hosted repository`);
	}
	assert.equal(repositoryIdentity('(unknown)'), undefined);
});

test('repositoryIdentity keeps hosts and namespaces apart', () => {
	assert.notEqual(repositoryIdentity('https://github.com/acme/widget'), repositoryIdentity('https://gitlab.com/acme/widget'));
	assert.equal(repositoryIdentity('https://gitlab.com/group/sub/widget.git'), 'gitlab.com/group/sub/widget');
	assert.equal(repositoryIdentity('git@gitlab.com:group/sub/widget.git'), 'gitlab.com/group/sub/widget');
	assert.equal(repositoryIdentity('https://ghe.example.com/acme/widget'), 'ghe.example.com/acme/widget');
	assert.notEqual(repositoryIdentity('https://ghe.example.com/acme/widget'), repositoryIdentity('acme/widget'));
	// Azure DevOps: https, ssh and legacy visualstudio.com all name the same repository …
	const ado = 'dev.azure.com/org/project/repo';
	assert.equal(repositoryIdentity('https://user@dev.azure.com/org/Project/_git/Repo'), ado);
	assert.equal(repositoryIdentity('git@ssh.dev.azure.com:v3/org/Project/Repo'), ado);
	assert.equal(repositoryIdentity('https://org.visualstudio.com/Project/_git/Repo'), ado);
	assert.equal(repositoryIdentity('org@vs-ssh.visualstudio.com:v3/org/Project/Repo'), ado);
	// … while the same project/repo in another organisation is a different one.
	assert.notEqual(repositoryIdentity('https://dev.azure.com/other-org/Project/_git/Repo'), ado);
});

test('repositoryIdentity reads scp-style SSH-config aliases without a user or dotted host', () => {
	assert.equal(repositoryIdentity('work:acme/widget.git'), 'work/acme/widget');
	assert.equal(repositoryIdentity('git@work:acme/widget.git'), 'work/acme/widget');
	assert.notEqual(repositoryIdentity('work:acme/widget.git'), repositoryIdentity('https://github.com/work:acme/widget'));
	// Drive letters are still local, never an alias host.
	assert.equal(repositoryIdentity('C:repos/widget.git'), undefined);
});

test('repositoryIdentity strips _git only for Azure DevOps', () => {
	assert.equal(repositoryIdentity('https://gitlab.com/group/_git/widget'), 'gitlab.com/group/_git/widget');
	assert.notEqual(repositoryIdentity('https://gitlab.com/group/_git/widget'), repositoryIdentity('https://gitlab.com/group/widget'));
	assert.equal(repositoryIdentity('https://dev.azure.com/org/Project/_git/Repo'), 'dev.azure.com/org/project/repo');
	assert.equal(repositoryIdentity('https://org.visualstudio.com/Project/_git/Repo'), 'dev.azure.com/org/project/repo');
});

test('an existing checkout anchor with its own remote vetoes a worktree of another repository', () => {
	const repos = 'C:\\u\\.copilot\\repos\\api';
	const wt = 'C:\\u\\.copilot\\copilot-worktrees\\api\\fix-1'; // deleted, session recorded B
	const p = probes('win32', [repos], { [repos]: { remote: 'https://github.com/acme/api' } });
	const groups = groupWorkspaces([entry(wt, 2, 2, 'https://github.com/other/api')], p);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].canonicalPath, wt, 'not merged into, nor represented by, repository A\'s checkout');
	assert.equal(groups[0].repositoryId, 'github.com/other/api');
	// Same remote (or none recorded): the worktree still folds into the checkout.
	assert.equal(groupWorkspaces([entry(wt, 2, 2, 'acme/api')], p)[0].canonicalPath, repos);
	assert.equal(groupWorkspaces([entry(wt, 2, 2)], p)[0].canonicalPath, repos);
});

test('same owner/name on two hosts stays two groups', () => {
	const groups = groupWorkspaces([
		entry('C:\\a\\widget', 1, 1, 'https://github.com/acme/widget'),
		entry('C:\\b\\widget', 1, 1, 'https://gitlab.com/acme/widget'),
	], probes('win32'));
	assert.equal(groups.length, 2);
});

test('UNC network shares are local paths, WSL / remote paths are not', () => {
	const unc = '\\\\server\\share\\acme-app';
	const p = probes('win32', [unc], { [unc]: { remote: 'https://github.com/acme/acme-app' } });
	const cases: Array<[string, boolean]> = [
		[unc, false],
		['//server/share/acme-app', false],
		['/home/dev/acme-app', true],
		['\\home\\dev\\acme-app', true], // what path.normalize() makes of a WSL path on Windows
	];
	for (const [folder, remote] of cases) {
		const groups = groupWorkspaces([entry('C:\\code\\acme-app', 1, 1), entry(folder, 5, 5)], p);
		assert.equal(groups.length, 1, folder);
		// A remote spelling never becomes canonical; a UNC share with more activity does.
		assert.equal(groups[0].canonicalPath === folder, !remote, folder);
	}
	// The UNC share is probed like any local folder, so its git remote counts.
	assert.equal(groupWorkspaces([entry(unc)], p)[0].repositoryId, 'github.com/acme/acme-app');
	assert.ok(workspaceProbePaths([entry(unc)], 'win32').includes(unc));
});

test('classifyArtefactName recognises the known shapes and avoids hex-looking words', () => {
	assert.equal(classifyArtefactName('goofy-wozniak-42f712'), 'generated-name');
	assert.equal(classifyArtefactName('groups-dashboard-layout-85ed99'), 'hash-suffix');
	assert.equal(classifyArtefactName('copilot-server-memories-027fbb'), 'hash-suffix');
	assert.equal(classifyArtefactName('ai-engineering-fluency-refactor-wt'), 'worktree-suffix');
	assert.equal(classifyArtefactName('wt'), 'worktree-suffix');
	assert.equal(classifyArtefactName('ai-engineering-fluency'), undefined);
	assert.equal(classifyArtefactName('my-facade'), undefined, 'all-letter hex words are not hashes');
	assert.equal(classifyArtefactName('decade-cafe'), undefined);
	assert.equal(classifyArtefactName('release-2024'), undefined, 'short numbers are not hashes');
	assert.equal(classifyArtefactName('newt'), undefined);
});

test('detectArtefactWorkspaceNames flags a group still named after a worktree folder', () => {
	const flagged = detectArtefactWorkspaceNames([
		{ canonicalPath: '/x/worktrees/feature', displayName: 'feature', memberPaths: ['/x/worktrees/feature'], sessionCount: 1, interactionCount: 1 },
		{ canonicalPath: '/x/worktrees/feature', displayName: 'repo', memberPaths: ['/x/worktrees/feature'], sessionCount: 1, interactionCount: 1 },
		{ canonicalPath: 'C:\\x\\copilot-worktrees\\fix', displayName: 'fix', memberPaths: [], sessionCount: 1, interactionCount: 1 },
		{ canonicalPath: '/code/repo-wt', displayName: 'repo-wt', memberPaths: [], sessionCount: 1, interactionCount: 1 },
	]);
	assert.deepEqual(flagged.map(f => [f.displayName, f.reason]), [['feature', 'worktree-folder'], ['fix', 'worktree-folder'], ['repo-wt', 'worktree-suffix']]);
});

test('detectArtefactWorkspaceNames flags an unknown layout with worktrees anywhere above the folder', () => {
	const groups = groupWorkspaces([entry('/tmp/worktrees/repo/feature')], probes('linux'));
	assert.deepEqual(detectArtefactWorkspaceNames(groups).map(f => [f.displayName, f.reason]), [['feature', 'worktree-folder']]);
	// …but not a folder that was renamed to its repository, nor the worktrees folder itself.
	assert.deepEqual(detectArtefactWorkspaceNames([
		{ canonicalPath: '/tmp/worktrees/repo/feature', displayName: 'repo', memberPaths: [], sessionCount: 1, interactionCount: 1 },
		{ canonicalPath: '/tmp/worktrees', displayName: 'worktrees', memberPaths: [], sessionCount: 1, interactionCount: 1 },
	]), []);
});

test('workspaceProbePaths lists every path the grouping can ask about, and nothing remote', () => {
	const paths = workspaceProbePaths([
		entry('C:\\u\\.copilot\\copilot-worktrees\\api\\fix'),
		entry('/src/widget/.claude/worktrees/agent/server'),
		entry('/home/dev/wsl-only'),
		entry('<unresolved:abc>'),
	], 'win32');
	assert.deepEqual(paths.sort(), [
		'C:\\u\\.copilot\\copilot-worktrees\\api',
		'C:\\u\\.copilot\\copilot-worktrees\\api\\fix',
		'C:\\u\\.copilot\\repos\\api',
	]);
	const linux = workspaceProbePaths([entry('/src/widget/.claude/worktrees/agent/server')], 'linux');
	assert.deepEqual(linux.sort(), ['/src/widget', '/src/widget/.claude/worktrees/agent/server', '/src/widget/.git']);
});

test('grouping with prefetched probes asks nothing outside the prefetched set', () => {
	const entries = [entry('/src/widget/.claude/worktrees/agent/server'), entry('/home/u/.copilot/copilot-worktrees/api/fix'), entry('/code/repo-wt')];
	const known = new Set(workspaceProbePaths(entries, 'linux'));
	const asked: string[] = [];
	groupWorkspaces(entries, { platform: 'linux', pathExists: p => { asked.push(p); return false; } });
	assert.deepEqual(asked.filter(p => !known.has(p)), []);
});

test('matchWorktreeConvention reads the three layouts', () => {
	assert.deepEqual(matchWorktreeConvention('/home/u/.claude/worktrees/repo/name'), { repoName: 'repo', anchorPath: '/home/u/.claude/worktrees/repo', anchorIsCheckout: false });
	assert.deepEqual(matchWorktreeConvention('/src/repo/.claude/worktrees/name'), { repoName: 'repo', anchorPath: '/src/repo', anchorIsCheckout: true });
	assert.deepEqual(
		matchWorktreeConvention('/src/repo/.claude/worktrees/name/sub', { pathExists: p => p === '/src/repo/.git' }),
		{ repoName: 'repo', anchorPath: '/src/repo', anchorIsCheckout: true },
		'an existing .git next to .claude means the in-repo layout, even with a sub-folder',
	);
	assert.deepEqual(matchWorktreeConvention('C:\\u\\.copilot\\copilot-worktrees\\repo\\w'), { repoName: 'repo', anchorPath: 'C:\\u\\.copilot\\copilot-worktrees\\repo', anchorIsCheckout: false });
	assert.equal(matchWorktreeConvention('/home/u/.claude/worktrees'), undefined);
	assert.equal(matchWorktreeConvention('/home/u/code/repo'), undefined);
});

test('matchWorktreeConvention: an in-repo worktree sub-folder is read without disk access', () => {
	const inRepo = { repoName: 'widget', anchorPath: '/src/widget', anchorIsCheckout: true };
	// No probes at all (deleted checkout, WSL path): the folder above .claude is not a home directory.
	assert.deepEqual(matchWorktreeConvention('/src/widget/.claude/worktrees/agent/server'), inRepo);
	assert.deepEqual(matchWorktreeConvention('/src/widget/.claude/worktrees/agent/server', { pathExists: () => false }), inRepo, 'deleted checkout');
	assert.deepEqual(matchWorktreeConvention('/home/dev/widget/.claude/worktrees/agent/a/b'), { ...inRepo, anchorPath: '/home/dev/widget' });
	assert.deepEqual(
		matchWorktreeConvention('C:\\code\\widget\\.claude\\worktrees\\agent\\server'),
		{ repoName: 'widget', anchorPath: 'C:\\code\\widget', anchorIsCheckout: true },
	);
});

test('matchWorktreeConvention: the desktop layout is recognised by its home-directory parent', () => {
	for (const home of ['/home/dev', '/Users/dev', '/root', 'C:\\Users\\dev', '/mnt/c/Users/dev', 'C:\\Documents and Settings\\dev']) {
		const sep = home.includes('\\') ? '\\' : '/';
		const wt = [home, '.claude', 'worktrees', 'acme', 'goofy-wozniak-42f712', 'server'].join(sep);
		assert.equal(matchWorktreeConvention(wt)?.repoName, 'acme', home);
		assert.equal(matchWorktreeConvention(wt)?.anchorIsCheckout, false, home);
	}
});

test('matchWorktreeConvention: a home directory that is itself a known workspace or checkout is the repository', () => {
	const wt = '/home/dev/.claude/worktrees/agent/server';
	const expected = { repoName: 'dev', anchorPath: '/home/dev', anchorIsCheckout: true };
	assert.deepEqual(matchWorktreeConvention(wt, { isWorkspace: p => p === '/home/dev' }), expected);
	assert.deepEqual(matchWorktreeConvention(wt, { pathExists: p => p === '/home/dev/.git' }), expected);
});

test('in-repo worktree sub-folders group with their repository when the checkout is gone or the path is WSL', () => {
	for (const [platform, repo, wt] of [
		['linux', '/src/widget', '/src/widget/.claude/worktrees/agent-a1b2c3/server'],
		['win32', '/home/dev/src/widget', '/home/dev/src/widget/.claude/worktrees/agent-a1b2c3/server'],
		['win32', 'C:\\code\\widget', 'C:\\code\\widget\\.claude\\worktrees\\agent-a1b2c3\\server'],
	]) {
		for (const p of [probes(platform), { platform }]) {
			const groups = groupWorkspaces([entry(repo, 2, 2), entry(wt, 1, 1)], p);
			assert.equal(groups.length, 1, `${platform} ${wt}`);
			assert.equal(groups[0].canonicalPath, repo);
			assert.equal(groups[0].displayName, 'widget');
		}
		// Only the worktree is in the list: it is still named after the repository, not `agent-…`.
		const [alone] = groupWorkspaces([entry(wt, 1, 1)], probes(platform));
		assert.equal(alone.displayName, 'widget');
		assert.deepEqual(detectArtefactWorkspaceNames([alone]), []);
	}
});

test('matchWorktreeConvention: a redirected home directory from the probes is the desktop layout', () => {
	const home = 'D:\\Profiles\\dev';
	const wt = 'D:\\Profiles\\dev\\.claude\\worktrees\\repo-a\\goofy-wozniak-42f712';
	assert.equal(matchWorktreeConvention(wt)?.repoName, 'dev', 'without the real home it reads as in-repo');
	assert.deepEqual(matchWorktreeConvention(wt, { homeDirectory: home }), {
		repoName: 'repo-a', anchorPath: 'D:\\Profiles\\dev\\.claude\\worktrees\\repo-a', anchorIsCheckout: false,
	});
	assert.equal(matchWorktreeConvention(wt, { homeDirectory: 'd:/profiles/dev/' })?.repoName, 'repo-a', 'separators, case and trailing slash do not matter');
	// Unrelated worktrees under that home stay apart, each named after its repository.
	const groups = groupWorkspaces([
		entry(wt, 1, 1),
		entry('D:\\Profiles\\dev\\.claude\\worktrees\\repo-b\\brave-curie-0a1b2c', 1, 1),
	], { platform: 'win32', homeDirectory: home });
	assert.deepEqual(groups.map(g => g.displayName).sort(), ['repo-a', 'repo-b']);
	assert.ok(workspaceProbePaths([entry(wt)], 'win32', home).includes('D:\\Profiles\\dev\\.claude\\worktrees\\repo-a'));
});

test('UNC roots survive path splitting: worktree anchors and a UNC home directory', () => {
	const home = '\\\\fileserver\\profiles\\dev';
	const wt = '\\\\fileserver\\profiles\\dev\\.claude\\worktrees\\repo-a\\goofy-wozniak-42f712';
	assert.deepEqual(matchWorktreeConvention(wt, { homeDirectory: home }), {
		repoName: 'repo-a', anchorPath: '\\\\fileserver\\profiles\\dev\\.claude\\worktrees\\repo-a', anchorIsCheckout: false,
	});
	// In-repo layout on a share: the repository root keeps its UNC prefix.
	assert.deepEqual(matchWorktreeConvention('\\\\nas\\code\\widget\\.claude\\worktrees\\agent\\server'), {
		repoName: 'widget', anchorPath: '\\\\nas\\code\\widget', anchorIsCheckout: true,
	});
	assert.deepEqual(matchWorktreeConvention('//nas/code/widget/.claude/worktrees/agent'), {
		repoName: 'widget', anchorPath: '//nas/code/widget', anchorIsCheckout: true,
	});
	// Copilot app layout: the repos/<repo> checkout probed is a valid UNC path.
	assert.ok(workspaceProbePaths([entry('\\\\nas\\u\\.copilot\\copilot-worktrees\\api\\fix')], 'win32').includes('\\\\nas\\u\\.copilot\\repos\\api'));
	assert.equal(workspaceBasename('\\\\nas\\code\\widget'), 'widget');
});

test('case-only differences of WSL / remote paths are not folded on Windows', () => {
	const groups = groupWorkspaces([entry('/home/dev/Repo', 1, 1), entry('/home/dev/repo', 1, 1)], probes('win32'));
	assert.equal(groups.length, 2);
	// Local Windows spellings still fold.
	assert.equal(groupWorkspaces([entry('C:\\Code\\Repo', 1, 1), entry('c:\\code\\repo', 1, 1)], probes('win32')).length, 1);
});

test('a dotfiles home repository in the list claims its own .claude/worktrees sub-folders', () => {
	const groups = groupWorkspaces([entry('/home/dev', 1, 1), entry('/home/dev/.claude/worktrees/agent/server', 1, 1)], probes('linux'));
	assert.equal(groups.length, 1);
	assert.equal(groups[0].canonicalPath, '/home/dev');
});

test('matchWorktreeConvention: unrelated paths do not match', () => {
	assert.equal(matchWorktreeConvention('/home/u/.copilot/copilot-worktrees/repo'), undefined);
	assert.equal(matchWorktreeConvention('/home/u/code/repo'), undefined);
});

test('workspaceBasename ignores trailing separators and handles both separator styles', () => {
	assert.equal(workspaceBasename('C:\\code\\repo\\'), 'repo');
	assert.equal(workspaceBasename('/home/dev/repo/'), 'repo');
	assert.equal(workspaceBasename('repo'), 'repo');
});

// ── Customization files of a group ───────────────────────────────────────────

function file(type: string, relativePath: string, lastModified: string | null, isStale = false) {
	return { type, relativePath, lastModified, isStale, path: `/x/${relativePath}` };
}

test('mergeGroupCustomizationFiles keeps every type found in any member folder', () => {
	const main = [file('instructions', '.github/copilot-instructions.md', '2026-10-01T00:00:00Z')];
	const worktree = [file('skill', '.github/skills/a/SKILL.md', '2026-10-02T00:00:00Z'), file('agent', '.github/agents/x.agent.md', '2026-10-03T00:00:00Z')];
	const merged = mergeGroupCustomizationFiles([main, undefined, worktree]);
	assert.deepEqual(merged.map(f => f.type).sort(), ['agent', 'instructions', 'skill']);
});

test('mergeGroupCustomizationFiles keeps one copy of the same file: fresh over stale, then newest', () => {
	const stale = file('instructions', '.github\\copilot-instructions.md', '2026-10-09T00:00:00Z', true);
	const older = file('instructions', '.github/copilot-instructions.md', '2026-09-01T00:00:00Z');
	const newer = file('instructions', '.GITHUB/copilot-instructions.md', '2026-10-01T00:00:00Z');
	assert.deepEqual(mergeGroupCustomizationFiles([[stale], [older], [newer]]), [newer]);
	assert.deepEqual(mergeGroupCustomizationFiles([[newer], [stale], [older]]), [newer]);
	assert.deepEqual(mergeGroupCustomizationFiles([[stale]]), [stale], 'a stale copy is kept when it is the only one');
});

test('mergeGroupCustomizationFiles: same path under two types is two entries; nothing in, nothing out', () => {
	assert.equal(mergeGroupCustomizationFiles([[file('a', 'f.md', null)], [file('b', 'f.md', null)]]).length, 2);
	assert.deepEqual(mergeGroupCustomizationFiles([undefined, []]), []);
});

// ── Node probes (real temp folders, never user data) ──────────────────────────

test('readWorkspaceGitInfo reads a checkout remote and a worktree pointer', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-grouping-'));
	try {
		const main = path.join(root, 'main-repo');
		fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
		fs.writeFileSync(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
		const wt = path.join(root, 'main-repo-85ed99');
		fs.mkdirSync(wt);
		fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);
		const plain = path.join(root, 'plain');
		fs.mkdirSync(plain);

		assert.deepEqual(await readWorkspaceGitInfo(main), { remote: 'https://github.com/acme/widget.git' });
		assert.deepEqual(await readWorkspaceGitInfo(wt), { remote: 'https://github.com/acme/widget.git', mainWorktreePath: main });
		assert.equal(await readWorkspaceGitInfo(plain), undefined);
		assert.equal(await readWorkspaceGitInfo(path.join(root, 'missing')), undefined);

		const entries = [entry(wt, 2, 2), entry(plain)];
		const groups = groupWorkspaces(entries, await prefetchWorkspaceGroupingProbes(entries));
		const widget = groups.find(g => g.displayName === 'widget')!;
		assert.equal(widget.canonicalPath, main);
		assert.deepEqual(widget.memberPaths, [wt]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('prefetchWorkspaceGroupingProbes answers from async checks, including a main checkout found through a pointer', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-grouping-'));
	try {
		const main = path.join(root, 'gadget');
		fs.mkdirSync(path.join(main, '.git', 'worktrees', 'x'), { recursive: true });
		fs.writeFileSync(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/gadget.git\n');
		const wt = path.join(root, 'feature-x');
		fs.mkdirSync(wt);
		fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'x')}\n`);
		const gone = path.join(root, 'deleted');

		const entries = [entry(wt), entry(gone)];
		const p = await prefetchWorkspaceGroupingProbes(entries);
		assert.equal(p.pathExists!(wt), true);
		assert.equal(p.pathExists!(main), true, 'the main checkout behind the pointer is prefetched');
		assert.equal(p.pathExists!(gone), false);
		assert.equal(p.pathExists!(path.join(root, 'never-asked')), false, 'unknown paths read as missing');
		assert.deepEqual(p.readGitInfo!(wt), { remote: 'git@github.com:acme/gadget.git', mainWorktreePath: main });
		assert.equal(p.readGitInfo!(gone), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('prefetchWorkspaceGroupingProbes also reads the git remote of an existing checkout anchor', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-grouping-'));
	try {
		const repos = path.join(root, '.copilot', 'repos', 'api');
		fs.mkdirSync(path.join(repos, '.git'), { recursive: true });
		fs.writeFileSync(path.join(repos, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/api.git\n');
		const wt = path.join(root, '.copilot', 'copilot-worktrees', 'api', 'fix-1'); // deleted worktree
		const entries = [entry(wt, 1, 1, 'https://github.com/other/api')];
		const p = await prefetchWorkspaceGroupingProbes(entries);
		assert.deepEqual(p.readGitInfo!(repos), { remote: 'https://github.com/acme/api.git' });
		const groups = groupWorkspaces(entries, p);
		assert.equal(groups[0].canonicalPath, wt, 'the other repository\'s checkout does not absorb it');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('readWorkspaceGitInfo ignores a .git file that does not point into a worktrees folder', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-grouping-'));
	try {
		fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../somewhere/modules/sub\n');
		assert.equal(await readWorkspaceGitInfo(root), undefined);
		fs.writeFileSync(path.join(root, '.git'), 'not a pointer');
		assert.equal(await readWorkspaceGitInfo(root), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('groupFolders: canonical first, including a checkout that had no sessions of its own', () => {
	assert.deepEqual(groupFolders({ canonicalPath: 'C:\\code\\gadget', memberPaths: ['C:\\wt\\feature'] }), ['C:\\code\\gadget', 'C:\\wt\\feature']);
	assert.deepEqual(groupFolders({ canonicalPath: '/b', memberPaths: ['/a', '/b', '/c'] }), ['/b', '/a', '/c']);
	assert.deepEqual(groupFolders({ canonicalPath: '/only', memberPaths: ['/only'] }), ['/only']);
	// The real case: a deleted worktree resolved through its pointer to an existing checkout.
	const [g] = groupWorkspaces([entry('C:\\wt\\feature')], probes('win32', ['C:\\wt\\feature', 'C:\\code\\gadget'], { 'C:\\wt\\feature': { mainWorktreePath: 'C:\\code\\gadget' } }));
	assert.deepEqual(groupFolders(g), ['C:\\code\\gadget', 'C:\\wt\\feature']);
});
