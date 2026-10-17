import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	DARK_FACTORY_CACHE_TTL_MS,
	MAX_SCANNED_REPOS,
	isReportStale,
	parseCacheEntry,
	readinessScopeKey,
	parseCachedReport,
	indexPrStats,
	scanDarkFactoryReadiness,
	selectRepoRoots,
} from '../../src/darkFactoryService';
import type { RepoPrInfo, RepoPrStatsResult } from '../../src/githubPrService';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TEMP_ROOTS: string[] = [];

/** Create a throwaway repository whose `origin` remote is `remoteUrl` (when given). */
function makeRepo(files: Record<string, string>, remoteUrl?: string): string {
	const root = fs.mkdtempSync(path.join(process.cwd(), 'df-service-'));
	TEMP_ROOTS.push(root);
	const all: Record<string, string> = {
		'.git/config': remoteUrl ? `[remote "origin"]\n\turl = ${remoteUrl}\n` : '[core]\n',
		...files,
	};
	for (const [relative, content] of Object.entries(all)) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, 'utf8');
	}
	return root;
}

/** A plain directory that is not a git repository. */
function makePlainDir(): string {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'df-plain-'));
	TEMP_ROOTS.push(dir);
	return dir;
}

test.after(() => {
	for (const root of TEMP_ROOTS) { fs.rmSync(root, { recursive: true, force: true }); }
});

function prStats(repos: Partial<RepoPrInfo>[], authenticated = true): RepoPrStatsResult {
	return {
		authenticated,
		since: '2026-08-01T00:00:00.000Z',
		repos: repos.map(repo => ({
			owner: 'rajbos', repo: 'demo', repoUrl: '', totalPrs: 0, aiAuthoredPrs: 0,
			aiReviewRequestedPrs: 0, aiDetails: [], ...repo,
		})),
	};
}

const FIXED_NOW = () => new Date('2026-09-01T12:00:00.000Z');

// ---------------------------------------------------------------------------
// selectRepoRoots
// ---------------------------------------------------------------------------

test('selectRepoRoots: keeps git repositories and drops everything else', () => {
	const repo = makeRepo({});
	const plain = makePlainDir();
	const { roots, skipped } = selectRepoRoots([plain, repo, path.join(process.cwd(), 'df-missing-xyz')]);
	assert.deepEqual(roots, [repo]);
	assert.equal(skipped, 0);
});

test('selectRepoRoots: deduplicates the same repository reached by different path spellings', () => {
	const repo = makeRepo({});
	const { roots } = selectRepoRoots([repo, path.join(repo, '.'), repo]);
	assert.deepEqual(roots, [repo]);
});

test('selectRepoRoots: ignores the unresolved workspace placeholders the matrix can contain', () => {
	const repo = makeRepo({});
	const { roots } = selectRepoRoots(['<unresolved:abc123>', '', repo]);
	assert.deepEqual(roots, [repo]);
});

test('selectRepoRoots: preserves caller ordering so the most relevant paths survive the cap', () => {
	const first = makeRepo({});
	const second = makeRepo({});
	assert.deepEqual(selectRepoRoots([second, first]).roots, [second, first]);
});

/** Create a linked worktree of `mainRoot`, laid out the way `git worktree add` does. */
function makeWorktree(mainRoot: string, name: string): string {
	const wt = fs.mkdtempSync(path.join(process.cwd(), 'df-wt-'));
	TEMP_ROOTS.push(wt);
	const gitDir = path.join(mainRoot, '.git', 'worktrees', name);
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, 'commondir'), '../..', 'utf8');
	fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
	return wt;
}

test('selectRepoRoots: groups linked worktrees under their main checkout', () => {
	const main = makeRepo({});
	const wtA = makeWorktree(main, 'a');
	const wtB = makeWorktree(main, 'b');
	const { roots, skipped } = selectRepoRoots([wtA, wtB, main]);
	assert.deepEqual(roots, [main]);
	assert.equal(skipped, 0);
});

test('selectRepoRoots: a lone worktree is scanned as itself, never swapped for a checkout the user did not open', () => {
	const main = makeRepo({});
	const wt = makeWorktree(main, 'a');
	assert.deepEqual(selectRepoRoots([wt]).roots, [wt]);
});

test('selectRepoRoots: falls back to the first worktree when the main checkout is gone', () => {
	const main = makeRepo({});
	const wtA = makeWorktree(main, 'a');
	const wtB = makeWorktree(main, 'b');
	fs.rmSync(path.join(main, '.git', 'config'));
	fs.renameSync(path.join(main, '.git'), path.join(main, '.git-moved'));
	fs.mkdirSync(path.join(main, '.git-moved', 'x'), { recursive: true });
	// Re-point the worktrees at a common dir that no longer sits at `<root>/.git`.
	const common = path.join(main, '.git-moved');
	for (const [wt, name] of [[wtA, 'a'], [wtB, 'b']]) {
		fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(common, 'worktrees', name)}\n`, 'utf8');
	}
	assert.deepEqual(selectRepoRoots([wtA, wtB]).roots, [wtA]);
});

test('selectRepoRoots: a bare repository named .git is not mistaken for a main checkout', () => {
	const container = makeRepo({});
	fs.writeFileSync(path.join(container, '.git', 'config'), '[core]\n\tbare = true\n', 'utf8');
	const wt = makeWorktree(container, 'a');
	assert.deepEqual(selectRepoRoots([wt]).roots, [wt]);
});

test('selectRepoRoots: a main checkout with a separate git dir is still preferred over its worktree', () => {
	const sep = fs.mkdtempSync(path.join(process.cwd(), 'df-sepgit-'));
	TEMP_ROOTS.push(sep);
	fs.writeFileSync(path.join(sep, 'config'), '[core]\n', 'utf8');
	const main = fs.mkdtempSync(path.join(process.cwd(), 'df-sepmain-'));
	TEMP_ROOTS.push(main);
	fs.writeFileSync(path.join(main, '.git'), `gitdir: ${sep}\n`, 'utf8');
	const wtGitDir = path.join(sep, 'worktrees', 'a');
	fs.mkdirSync(wtGitDir, { recursive: true });
	fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..', 'utf8');
	const wt = fs.mkdtempSync(path.join(process.cwd(), 'df-sepwt-'));
	TEMP_ROOTS.push(wt);
	fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8');
	assert.deepEqual(selectRepoRoots([wt, main]).roots, [main]);
});

test('readinessScopeKey: crossing the scan cap changes the key even though the selected roots do not', () => {
	const repos = Array.from({ length: MAX_SCANNED_REPOS }, () => makeRepo({}));
	const before = readinessScopeKey(repos);
	const after = readinessScopeKey([...repos, makeRepo({})]);
	assert.notEqual(before, after);
});

test('parseCacheEntry: a report with GitHub evidence is withheld while signed out, a filesystem-only one is kept', () => {
	const a = makeRepo({});
	const key = readinessScopeKey([a]);
	const withApi = { ...(reportAt('2026-09-01T12:00:00.000Z') as object), apiSignalsIncluded: true } as never;
	const fsOnly = { ...(reportAt('2026-09-01T12:00:00.000Z') as object), apiSignalsIncluded: false } as never;
	assert.equal(parseCacheEntry({ scopeKey: key, report: withApi }, key, true), withApi);
	assert.equal(parseCacheEntry({ scopeKey: key, report: withApi }, key, false), undefined);
	assert.equal(parseCacheEntry({ scopeKey: key, report: fsOnly }, key, false), fsOnly);
});

test('selectRepoRoots: a symlinked main checkout and its worktree are one repository', (t) => {
	const main = makeRepo({});
	const wt = makeWorktree(main, 'a');
	const alias = path.join(os.tmpdir(), `df-alias-${process.pid}-${Date.now()}`);
	try {
		fs.symlinkSync(main, alias, 'junction');
	} catch {
		t.skip('cannot create symlinks here');
		return;
	}
	TEMP_ROOTS.push(alias);
	const { roots, skipped } = selectRepoRoots([alias, wt]);
	assert.equal(roots.length, 1);
	assert.equal(skipped, 0);
});

test('selectRepoRoots: caps the scan and reports how many repositories it skipped', () => {
	const repos = Array.from({ length: MAX_SCANNED_REPOS + 3 }, () => makeRepo({}));
	const { roots, skipped } = selectRepoRoots(repos);
	assert.equal(roots.length, MAX_SCANNED_REPOS);
	assert.equal(skipped, 3);
});

// ---------------------------------------------------------------------------
// readiness report cache
// ---------------------------------------------------------------------------

const reportAt = (scannedAt: string) => ({ scannedAt, repos: [] }) as never;

test('parseCachedReport: accepts a report-shaped value and rejects anything else', () => {
	const ok = reportAt('2026-09-01T12:00:00.000Z');
	assert.equal(parseCachedReport(ok), ok);
	assert.equal(parseCachedReport(Object.assign(Object.create({ inherited: true }), ok)), undefined);
	for (const bad of [undefined, null, 'x', {}, { repos: [] }, { repos: {}, scannedAt: '2026-09-01T12:00:00.000Z' }, { repos: [], scannedAt: 'nope' }]) {
		assert.equal(parseCachedReport(bad), undefined);
	}
});

test('cache entries only replay for the workspace scope they were scanned for', () => {
	const a = makeRepo({});
	const b = makeRepo({});
	const report = reportAt('2026-09-01T12:00:00.000Z');
	const keyA = readinessScopeKey([a]);
	const entry = { scopeKey: keyA, report };
	assert.equal(parseCacheEntry(entry, keyA), report);
	// Switching workspace, or gaining a repository, is a cache miss.
	assert.equal(parseCacheEntry(entry, readinessScopeKey([b])), undefined);
	assert.equal(parseCacheEntry(entry, readinessScopeKey([a, b])), undefined);
	assert.equal(parseCacheEntry(report, keyA), undefined);
	assert.equal(parseCacheEntry(undefined, keyA), undefined);
});

test('isReportStale: fresh within a day, stale beyond it, and a future timestamp is distrusted', () => {
	const now = new Date('2026-09-02T12:00:00.000Z');
	assert.equal(isReportStale(reportAt('2026-09-02T11:00:00.000Z'), now), false);
	assert.equal(isReportStale(reportAt(new Date(now.getTime() - DARK_FACTORY_CACHE_TTL_MS).toISOString()), now), false);
	assert.equal(isReportStale(reportAt(new Date(now.getTime() - DARK_FACTORY_CACHE_TTL_MS - 1).toISOString()), now), true);
	assert.equal(isReportStale(reportAt('2026-09-03T12:00:00.000Z'), now), true);
});

// ---------------------------------------------------------------------------
// indexPrStats
// ---------------------------------------------------------------------------

test('indexPrStats: an unauthenticated result contributes nothing', () => {
	assert.equal(indexPrStats(prStats([{ owner: 'rajbos', repo: 'demo' }], false)).size, 0);
	assert.equal(indexPrStats(undefined).size, 0);
});

test('indexPrStats: keys are lower-cased and carry the per-repo error through', () => {
	const index = indexPrStats(prStats([{ owner: 'RajBos', repo: 'Demo', totalPrs: 4, aiAuthoredPrs: 1, error: 'denied' }]));
	assert.deepEqual(index.get('rajbos/demo'), { totalPrs: 4, aiAuthoredPrs: 1, error: 'denied' });
});

// ---------------------------------------------------------------------------
// scanDarkFactoryReadiness
// ---------------------------------------------------------------------------

test('scan: an empty workspace produces an empty, honest report', () => {
	const report = scanDarkFactoryReadiness({ workspacePaths: [], now: FIXED_NOW });
	assert.deepEqual(report.repos, []);
	assert.equal(report.apiSignalsIncluded, false);
	assert.equal(report.scannedAt, '2026-09-01T12:00:00.000Z');
	assert.equal(report.maxAssessableStage, 4);
});

test('scan: resolves owner/repo from the git config without spawning git', () => {
	const repo = makeRepo({}, 'https://github.com/rajbos/ai-engineering-fluency.git');
	const report = scanDarkFactoryReadiness({ workspacePaths: [repo], now: FIXED_NOW });
	assert.equal(report.repos[0].nameWithOwner, 'rajbos/ai-engineering-fluency');
});

test('scan: leaves nameWithOwner unset for a repository with no GitHub remote', () => {
	const repo = makeRepo({}, 'https://gitlab.com/rajbos/elsewhere.git');
	const report = scanDarkFactoryReadiness({ workspacePaths: [repo], now: FIXED_NOW });
	assert.equal(report.repos[0].nameWithOwner, undefined);
});

test('scan: resolves an enterprise remote when the enterprise URI is configured', () => {
	const repo = makeRepo({}, 'https://customer.ghe.com/rajbos/private-repo.git');
	const report = scanDarkFactoryReadiness({ workspacePaths: [repo], now: FIXED_NOW, enterpriseUri: 'https://customer.ghe.com' });
	assert.equal(report.repos[0].nameWithOwner, 'rajbos/private-repo');
});

test('scan: without pull-request data the agent-PR control is unknown, not absent', () => {
	const repo = makeRepo({}, 'https://github.com/rajbos/demo.git');
	const report = scanDarkFactoryReadiness({ workspacePaths: [repo], now: FIXED_NOW });
	const control = report.repos[0].controls.find(c => c.id === 'agent-authored-pull-requests');
	assert.equal(control?.state, 'unknown');
	assert.equal(report.apiSignalsIncluded, false);
});

test('scan: joins already-fetched pull-request statistics by owner/repo', () => {
	const repo = makeRepo({}, 'https://github.com/rajbos/demo.git');
	const report = scanDarkFactoryReadiness({
		workspacePaths: [repo],
		prStats: prStats([{ owner: 'rajbos', repo: 'demo', totalPrs: 20, aiAuthoredPrs: 5 }]),
		now: FIXED_NOW,
	});
	const control = report.repos[0].controls.find(c => c.id === 'agent-authored-pull-requests');
	assert.equal(control?.state, 'present');
	assert.equal(report.apiSignalsIncluded, true);
});

test('scan: pull-request statistics for a different repository are not borrowed', () => {
	const repo = makeRepo({}, 'https://github.com/rajbos/demo.git');
	const report = scanDarkFactoryReadiness({
		workspacePaths: [repo],
		prStats: prStats([{ owner: 'someone', repo: 'else', totalPrs: 20, aiAuthoredPrs: 5 }]),
		now: FIXED_NOW,
	});
	assert.equal(report.repos[0].controls.find(c => c.id === 'agent-authored-pull-requests')?.state, 'unknown');
});

test('scan: a repository with AI customization but no CI raises the agents-before-delivery finding', () => {
	const repo = makeRepo({ '.github/copilot-instructions.md': '# rules' });
	const report = scanDarkFactoryReadiness({ workspacePaths: [repo], now: FIXED_NOW });
	const finding = report.repos[0].findings.find(f => f.id === 'agents-before-delivery');
	assert.equal(finding?.severity, 'high');
});

test('scan: names the repository by its folder and records the scanned path', () => {
	const repo = makeRepo({});
	const report = scanDarkFactoryReadiness({ workspacePaths: [repo], now: FIXED_NOW });
	assert.equal(report.repos[0].name, path.basename(repo));
	assert.equal(report.repos[0].repoRoot, path.resolve(repo));
});
