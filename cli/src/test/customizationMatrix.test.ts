/**
 * buildCustomizationMatrix counts workspaces that have no agent instructions file.
 * Each accepted spelling must satisfy the check on its own, matching the shared
 * scanner (src/customizationPatterns.json), which is case-insensitive.
 */

import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildCustomizationMatrix } from '../helpers';

/**
 * Where fixture folders are created (each test removes its own). Not os.tmpdir(): the shared safe
 * file reader refuses to read session files from the OS temp directory (src/utils/safeFileRead.ts).
 * Not under this checkout either: a checkout can itself sit in a Claude worktree layout
 * (`~/.claude/worktrees/<repo>/<name>`), which the grouping rightly recognises and which would
 * then decide these tests' group names. A folder directly under the home directory is neither.
 */
const FIXTURE_PREFIX = path.join(os.homedir(), '.aef-cli-custmatrix-');

/**
 * A VS Code chat session with one request: the matrix only counts sessions with interactions
 * in the last 30 days, like the extension, so an empty `{}` file would be skipped.
 */
const ONE_REQUEST_SESSION = sessionWithRequestAt(new Date());

/** A one-request VS Code chat session whose request happened at `when`. */
function sessionWithRequestAt(when: Date): string {
	return JSON.stringify({
		version: 3,
		requests: [{ requestId: 'r1', timestamp: when.getTime(), message: { text: 'hello' }, response: [{ value: 'hi' }] }],
	});
}

/** Write an old session: both its request and its file date are `when`. */
function backdate(sessionFile: string, when: Date): void {
	fs.writeFileSync(sessionFile, sessionWithRequestAt(when));
	fs.utimesSync(sessionFile, when, when);
}

/** Build a VS Code-style session file whose workspace.json points at a temp workspace. */
function makeWorkspace(files: string[]): { root: string; sessionFile: string } {
	const root = fs.mkdtempSync(FIXTURE_PREFIX);
	const workspace = path.join(root, 'ws');
	fs.mkdirSync(workspace);
	for (const rel of files) {
		const abs = path.join(workspace, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, '# instructions');
	}
	const hashDir = path.join(root, 'workspaceStorage', 'abc123');
	const chatDir = path.join(hashDir, 'chatSessions');
	fs.mkdirSync(chatDir, { recursive: true });
	fs.writeFileSync(
		path.join(hashDir, 'workspace.json'),
		JSON.stringify({ folder: 'file:///' + workspace.replace(/\\/g, '/') })
	);
	const sessionFile = path.join(chatDir, 's1.json');
	fs.writeFileSync(sessionFile, ONE_REQUEST_SESSION);
	return { root, sessionFile };
}

async function issuesFor(files: string[]): Promise<number | undefined> {
	const { root, sessionFile } = makeWorkspace(files);
	try {
		return (await buildCustomizationMatrix([sessionFile]))?.workspacesWithIssues;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('buildCustomizationMatrix: workspace without any instructions file has an issue', async () => {
	assert.equal(await issuesFor([]), 1);
});

for (const file of [
	'AGENTS.md',
	'agents.md',
	'CLAUDE.md',
	'claude.md',
	'.claude/CLAUDE.md',
	'.claude/claude.md',
	'.CLAUDE/claude.md',
	'.github/copilot-instructions.md',
]) {
	test(`buildCustomizationMatrix: ${file} alone satisfies the instructions check`, async () => {
		assert.equal(await issuesFor([file]), 0);
	});
}

// ── Workspace grouping (shared src/workspaceGrouping.ts) ─────────────────────

import { groupWorkspaces } from '../../../src/workspaceGrouping';
import { prefetchWorkspaceGroupingProbes } from '../../../src/workspaceGroupingProbes';

/** One VS Code-style session file per folder, so each folder counts one session. */
function makeSessions(root: string, folders: string[]): string[] {
	return folders.map((folder, i) => {
		const hashDir = path.join(root, 'workspaceStorage', `hash${i}`);
		const chatDir = path.join(hashDir, 'chatSessions');
		fs.mkdirSync(chatDir, { recursive: true });
		fs.writeFileSync(path.join(hashDir, 'workspace.json'), JSON.stringify({ folder: 'file:///' + folder.replace(/\\/g, '/') }));
		const sessionFile = path.join(chatDir, 's.json');
		fs.writeFileSync(sessionFile, ONE_REQUEST_SESSION);
		return sessionFile;
	});
}

test('buildCustomizationMatrix: worktrees and clones of one repository count as one grouped workspace', async () => {
	const root = fs.mkdtempSync(FIXTURE_PREFIX);
	try {
		const main = path.join(root, 'code', 'acme-app');
		const sibling = path.join(root, 'code', 'acme-app-refactor-wt');
		const clone = path.join(root, 'tmp', 'acme-app-85ed99');
		const other = path.join(root, 'code', 'other-repo');
		for (const dir of [main, sibling, clone, other]) { fs.mkdirSync(dir, { recursive: true }); }
		// Only the sibling worktree has an instructions file; the group as a whole is covered.
		fs.writeFileSync(path.join(sibling, 'AGENTS.md'), '# instructions');

		const matrix = await buildCustomizationMatrix(makeSessions(root, [main, sibling, clone, other]));
		assert.ok(matrix);
		assert.equal(matrix.totalWorkspaces, 2);
		assert.equal(matrix.workspacesWithIssues, 1, 'only other-repo lacks instructions');
		const acme = matrix.workspaces.find(w => w.workspaceName === 'acme-app');
		assert.ok(acme);
		assert.equal(acme.workspacePath, main);
		assert.equal(acme.sessionCount, 3);
		assert.deepEqual(acme.memberPaths, [main, sibling, clone].sort());
		const otherRow = matrix.workspaces.find(w => w.workspaceName === 'other-repo');
		assert.equal(otherRow?.memberPaths, undefined, 'single-folder rows carry no member list');
		assert.equal(matrix.ungroupedWorkspaceNames, undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('buildCustomizationMatrix: grouped totals match the shared grouping the extension uses (parity)', async () => {
	const root = fs.mkdtempSync(FIXTURE_PREFIX);
	try {
		const folders = [
			path.join(root, 'code', 'widget'),
			path.join(root, 'clones', 'widget'),
			path.join(root, '.copilot', 'copilot-worktrees', 'widget', 'goofy-wozniak-42f712'),
			path.join(root, 'scratch', 'groups-dashboard-layout-85ed99'),
		];
		for (const dir of folders) { fs.mkdirSync(dir, { recursive: true }); }
		const matrix = await buildCustomizationMatrix(makeSessions(root, folders));
		// The extension feeds the same folder → count list through the same function.
		const entries = folders.map(p => ({ path: p, sessionCount: 1, interactionCount: 0 }));
		const expected = groupWorkspaces(entries, await prefetchWorkspaceGroupingProbes(entries));
		assert.ok(matrix);
		assert.equal(matrix.totalWorkspaces, expected.length);
		assert.deepEqual(
			matrix.workspaces.map(w => [w.workspaceName, w.sessionCount]),
			expected.map(g => [g.displayName, g.sessionCount]),
		);
		assert.equal(matrix.totalWorkspaces, 2);
		// The branch-named scratch clone has nothing to join, so the detector reports it.
		assert.deepEqual(matrix.ungroupedWorkspaceNames, ['groups-dashboard-layout-85ed99']);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('buildCustomizationMatrix: only sessions with interactions in the last 30 days count, like the extension', async () => {
	const root = fs.mkdtempSync(FIXTURE_PREFIX);
	try {
		const active = path.join(root, 'code', 'active-repo');
		const old = path.join(root, 'code', 'old-repo');
		const empty = path.join(root, 'code', 'empty-repo');
		for (const dir of [active, old, empty]) { fs.mkdirSync(dir, { recursive: true }); }
		const [activeSession, oldSession, emptySession] = makeSessions(root, [active, old, empty]);
		const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
		backdate(oldSession, sixtyDaysAgo);
		fs.writeFileSync(emptySession, '{}');
		assert.ok(activeSession);

		const matrix = await buildCustomizationMatrix([activeSession, oldSession, emptySession]);
		assert.ok(matrix);
		assert.deepEqual(matrix.workspaces.map(w => w.workspaceName), ['active-repo']);
		assert.equal(matrix.workspaces[0].sessionCount, 1);
		assert.ok(matrix.workspaces[0].interactionCount > 0, 'interactions are counted, not left at 0');
		assert.equal(await buildCustomizationMatrix([oldSession, emptySession]), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('sessionActiveSince: a DB-backed session is placed by its own activity, never by the shared database mtime', async () => {
	const { sessionActiveSince } = await import('../helpers');
	const cutoff = new Date('2026-09-10T00:00:00Z');
	const recent = new Date('2026-10-01T00:00:00Z');
	const old = new Date('2026-06-01T00:00:00Z');
	// Regular file (no per-session activity): the file mtime decides.
	assert.equal(sessionActiveSince(recent, null, cutoff), true);
	assert.equal(sessionActiveSince(old, null, cutoff), false);
	// DB-backed: an old session in a recently-touched database does not count …
	assert.equal(sessionActiveSince(recent, old, cutoff), false);
	// … and a recent one counts even if the database file looks older.
	assert.equal(sessionActiveSince(old, recent, cutoff), true);
	// A virtual session with no activity of its own never borrows the database mtime …
	assert.equal(sessionActiveSince(recent, null, cutoff, true), false);
	// … while its own activity still decides when known.
	assert.equal(sessionActiveSince(recent, recent, cutoff, true), true);
	assert.equal(sessionActiveSince(recent, old, cutoff, true), false);
});

test('buildCustomizationMatrix: the 30-day window is the extension\'s (30 calendar dates including today)', async () => {
	const root = fs.mkdtempSync(FIXTURE_PREFIX);
	try {
		const now = new Date();
		const first = path.join(root, 'code', 'first-day');
		const before = path.join(root, 'code', 'day-before');
		for (const dir of [first, before]) { fs.mkdirSync(dir, { recursive: true }); }
		const [firstSession, beforeSession] = makeSessions(root, [first, before]);
		const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 12);
		const dayBefore = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 12);
		backdate(firstSession, firstDay);
		backdate(beforeSession, dayBefore);
		const matrix = await buildCustomizationMatrix([firstSession, beforeSession], undefined, now);
		assert.deepEqual(matrix?.workspaces.map(w => w.workspaceName), ['first-day']);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('buildCustomizationMatrix: VS Code sessions are grouped by the remote of the files they referenced (parity)', async () => {
	// Long-form path: the workspace folder resolved from workspace.json goes through realpath,
	// and a Windows runner's temp dir can be an 8.3 short path (RUNNER~1), so build fixtures on the real path.
	const root = fs.realpathSync.native(fs.mkdtempSync(FIXTURE_PREFIX));
	try {
		// Two workspace folders inside one repository (a monorepo opened per package): neither
		// folder has its own .git, so only the files the sessions referenced lead to the remote.
		const repo = path.join(root, 'repos', 'widget-main');
		fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
		fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
		const folders = [path.join(repo, 'packages', 'checkout-a'), path.join(repo, 'packages', 'groups-dashboard-layout-85ed99')];
		const sessions = makeSessions(root, folders);
		folders.forEach((folder, i) => {
			fs.mkdirSync(folder, { recursive: true });
			const touched = path.join(folder, 'index.ts');
			fs.writeFileSync(touched, '');
			fs.writeFileSync(sessions[i], sessionReferencing(touched));
		});

		const matrix = await buildCustomizationMatrix(sessions);
		assert.ok(matrix);
		assert.equal(matrix.totalWorkspaces, 1, 'both folders share the referenced remote');
		assert.equal(matrix.workspaces[0].workspaceName, 'widget');
		assert.deepEqual(matrix.workspaces[0].memberPaths, folders.map(f => path.normalize(f)).sort());
		assert.equal(matrix.ungroupedWorkspaceNames, undefined, 'the branch-named folder is no longer a leftover');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('buildCustomizationMatrix: a recently copied log of old requests does not count (last activity day, not file mtime)', async () => {
	const root = fs.mkdtempSync(FIXTURE_PREFIX);
	try {
		const copied = path.join(root, 'code', 'copied-repo');
		fs.mkdirSync(copied, { recursive: true });
		const [session] = makeSessions(root, [copied]);
		// Requests from 60 days ago, but the file was just written (copied / touched).
		fs.writeFileSync(session, sessionWithRequestAt(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)));
		assert.equal(await buildCustomizationMatrix([session]), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('sessionLastActivityDay: the last daily-fraction day, else the fallback date\'s day', async () => {
	const { sessionLastActivityDay } = await import('../helpers');
	assert.equal(sessionLastActivityDay({ '2026-08-01': 0.5, '2026-09-03': 0.5, '2026-08-20': 0 }, new Date()), '2026-09-03');
	assert.equal(sessionLastActivityDay({}, new Date(2026, 9, 1, 12)), '2026-10-01');
	assert.equal(sessionLastActivityDay(undefined, new Date(2026, 9, 1, 12)), '2026-10-01');
});

test('sessionLastActivityDay: a valid adapter lastInteraction wins over synthesised daily fractions', async () => {
	const { sessionLastActivityDay } = await import('../helpers');
	// A copied old Pi session: the daily split was synthesised from today's mtime …
	const synthesised = { '2026-10-10': 1 };
	// … but the adapter recorded its real last interaction.
	assert.equal(sessionLastActivityDay(synthesised, new Date(2026, 9, 10, 12), new Date(2026, 6, 1, 12).toISOString()), '2026-07-01');
	// Missing or invalid metadata falls back to the daily fractions.
	assert.equal(sessionLastActivityDay(synthesised, new Date(), null), '2026-10-10');
	assert.equal(sessionLastActivityDay(synthesised, new Date(), 'not a date'), '2026-10-10');
});

/** A one-request VS Code chat session that referenced `file`. */
function sessionReferencing(file: string): string {
	return JSON.stringify({
		version: 3,
		requests: [{
			requestId: 'r1', timestamp: Date.now(), message: { text: 'look at this' }, response: [{ value: 'ok' }],
			contentReferences: [{ kind: 'reference', reference: { fsPath: file } }],
		}],
	});
}

test('buildCustomizationMatrix: a file referenced from another repository is not the workspace\'s remote', async () => {
	// Long-form path: the workspace folder resolved from workspace.json goes through realpath,
	// and a Windows runner's temp dir can be an 8.3 short path (RUNNER~1), so build fixtures on the real path.
	const root = fs.realpathSync.native(fs.mkdtempSync(FIXTURE_PREFIX));
	try {
		const other = path.join(root, 'repos', 'other-lib');
		fs.mkdirSync(path.join(other, '.git'), { recursive: true });
		fs.writeFileSync(path.join(other, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/other-lib.git\n');
		const otherFile = path.join(other, 'lib.ts');
		fs.writeFileSync(otherFile, '');
		// Two unrelated workspaces that both happened to look at other-lib.
		const folders = [path.join(root, 'code', 'app-one'), path.join(root, 'code', 'app-two')];
		for (const f of folders) { fs.mkdirSync(f, { recursive: true }); }
		const sessions = makeSessions(root, folders);
		for (const s of sessions) { fs.writeFileSync(s, sessionReferencing(otherFile)); }

		const matrix = await buildCustomizationMatrix(sessions);
		assert.ok(matrix);
		assert.deepEqual(matrix.workspaces.map(w => w.workspaceName).sort(), ['app-one', 'app-two'], 'not merged under other-lib');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('buildCustomizationMatrix: rows carry the instructions status the issue count is based on', async () => {
	const root = fs.mkdtempSync(FIXTURE_PREFIX);
	try {
		const customized = path.join(root, 'code', 'customized');
		const missing = path.join(root, 'code', 'missing');
		for (const dir of [customized, missing]) { fs.mkdirSync(dir, { recursive: true }); }
		fs.writeFileSync(path.join(customized, 'AGENTS.md'), '# instructions');
		const matrix = await buildCustomizationMatrix(makeSessions(root, [customized, missing]));
		assert.ok(matrix);
		assert.deepEqual(matrix.customizationTypes.map(t => t.id), ['instructions']);
		const status = (name: string) => matrix.workspaces.find(w => w.workspaceName === name)?.typeStatuses;
		assert.deepEqual(status('customized'), { instructions: '✅' });
		assert.deepEqual(status('missing'), { instructions: '❌' });
		assert.equal(matrix.workspacesWithIssues, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
