/**
 * The view parse (processSessionFileForViews) reads a session twice — the base parse, then the
 * usage analysis — and writes the enriched result back to the session cache. It must key that
 * entry by the stat taken before reading, and skip the write when the file changed in between:
 * otherwise an actively-written session stores data parsed from an older version under the
 * newer mtime, and the stale entry is served until the file changes again.
 *
 * Kept in its own file because the other contract tests disable the cache. This file never
 * loads or saves the on-disk cache, so it only touches the in-memory map.
 */
import test, { type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { calculateDailyStats, calculateEfficiencySessionInputs, calculateUsageAnalysisStats, calculateViewStats, processSessionFileForViews, recentAnalysisCutoff, isSessionActiveSince, createSessionActivityLookup, sessionActivityTime, ViewStatsCancelledError, sessionVersion } from '../helpers';
import { getCached } from '../cliCache';
import { buildClassificationInputFromUsageAnalysis, classifySessionTask } from '../../../src/taskClassification';

type MockOptions = { changeDuringAnalysis?: boolean; failAnalysisRead?: boolean; content?: string };

// Captured before any test mocks them; the mocks below delegate to these.
const realOpen = fs.promises.open.bind(fs.promises);
const realReadFile = fs.promises.readFile.bind(fs.promises) as (file: string, options?: unknown) => Promise<string | Buffer>;
const realStat = fs.promises.stat.bind(fs.promises);

/**
 * A real session file (the base parse reads through the size-guarded reader, which opens a file
 * handle), under the git-ignored build output rather than os.tmpdir(), which that reader refuses.
 * Every read of it is counted; its mtime is controlled so a test can "change" the file mid-run.
 */
function mockSession(t: TestContext, id: string, changeDuringAnalysis: boolean | MockOptions): { filePath: string; mtimes: number[]; reads: () => number } {
	const opts: MockOptions = typeof changeDuringAnalysis === 'boolean' ? { changeDuringAnalysis } : changeDuringAnalysis;
	const root = fs.mkdtempSync(path.join(__dirname, 'view-cache-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const filePath = path.join(root, 'workspaceStorage', 'synthetic', 'chatSessions', `${id}.json`);
	const content = opts.content ?? JSON.stringify({ requests: [{
		requestId: 'r1', timestamp: Date.now(), modelId: 'copilot/gpt-4o',
		message: { text: 'Write a test', parts: [{ text: 'Write a test' }] },
		response: [], result: { promptTokens: 100, outputTokens: 20 },
	}] });
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	const first = new Date(); first.setMilliseconds(0);
	let mtime = first.getTime();
	const mtimes = [mtime];
	let sessionReads = 0;
	const onRead = () => {
		// The second read is the view enrichment: simulate the editor appending meanwhile.
		if (++sessionReads === 2 && opts.changeDuringAnalysis) { mtime += 5000; mtimes.push(mtime); }
		if (sessionReads === 2 && opts.failAnalysisRead) { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
	};
	t.mock.method(fs.promises, 'stat', async (file: string) => {
		if (file !== filePath) { return realStat(file); }
		return { ...fs.statSync(filePath), mtime: new Date(mtime), mtimeMs: mtime, size: content.length, isFile: () => true } as unknown as fs.Stats;
	});
	t.mock.method(fs.promises, 'open', async (file: string, ...rest: unknown[]) => {
		if (file === filePath) { onRead(); }
		return (realOpen as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
	});
	t.mock.method(fs.promises, 'readFile', async (file: string, ...rest: unknown[]) => {
		if (file === filePath) { onRead(); }
		return realReadFile(file, ...(rest as [unknown]));
	});
	return { filePath, mtimes, reads: () => sessionReads };
}

test('the enriched view parse is cached under the pre-parse stat when the file is unchanged', async t => {
	const { filePath, mtimes } = mockSession(t, '22222222-2222-4222-8222-222222222222', false);
	const data = await processSessionFileForViews(filePath);
	assert.equal(data?.viewAttributesResolved, true);
	const size = (await fs.promises.stat(filePath)).size;
	assert.equal(getCached(filePath, mtimes[0], size)?.viewAttributesResolved, true);
});

test('the enriched view parse is not cached when the file changed while it was read', async t => {
	const { filePath, mtimes } = mockSession(t, '33333333-3333-4333-8333-333333333333', true);
	const data = await processSessionFileForViews(filePath);
	assert.equal(data?.viewAttributesResolved, true, 'this run still gets the enriched data');
	assert.equal(mtimes.length, 2, 'the fixture must have changed the file during the analysis read');
	const size = (await fs.promises.stat(filePath)).size;
	assert.equal(getCached(filePath, mtimes[1], size), null, 'older data must not be stored under the newer mtime');
	assert.equal(getCached(filePath, mtimes[0], size)?.viewAttributesResolved, undefined, 'only the base parse stays cached for the old version');
});

test('a failed view analysis is neither marked resolved nor cached, so the next run retries', async t => {
	// analyzeSessionUsage() swallows read/parser errors and returns an empty analysis; caching
	// that as resolved would hide the session's task/LOC/efficiency data until the file changes.
	const { filePath, mtimes } = mockSession(t, '44444444-4444-4444-8444-444444444444', { failAnalysisRead: true });
	const data = await processSessionFileForViews(filePath);
	assert.ok(data, 'the base parse still counts the session');
	assert.equal(data.viewAttributesResolved, undefined);
	assert.equal(data.taskCategory, undefined);
	const size = (await fs.promises.stat(filePath)).size;
	assert.equal(getCached(filePath, mtimes[0], size)?.viewAttributesResolved, undefined);
});

test('calculateViewStats walks the files once and matches the single-purpose collectors', async t => {
	const { filePath, reads } = mockSession(t, '55555555-5555-4555-8555-555555555555', false);
	const viewStats = await calculateViewStats([filePath]);
	assert.equal(reads(), 2, 'one base parse and one usage analysis — not a second walk');
	assert.deepEqual(viewStats.dailyStats, await calculateDailyStats([filePath]));
	assert.deepEqual(viewStats.efficiencySessionInputs, await calculateEfficiencySessionInputs([filePath]));
	assert.equal(reads(), 2, 'the collectors reuse the cached enriched parse');
	assert.equal(viewStats.efficiencySessionInputs.length, 1);
});

test('a non-fatal analysis warning does not discard the enriched view parse', async t => {
	// analyzeSessionUsage() also uses deps.warn for notices that leave a valid analysis (here an
	// unexpected session format). Only its dedicated onAnalysisError signal marks a failure.
	const { filePath, mtimes } = mockSession(t, '66666666-6666-4666-8666-666666666666', { content: JSON.stringify({ requests: 'not-an-array' }) });
	const data = await processSessionFileForViews(filePath);
	assert.ok(data);
	assert.equal(data.viewAttributesResolved, true, 'a warning alone must not be treated as a failed analysis');
	const size = (await fs.promises.stat(filePath)).size;
	assert.equal(getCached(filePath, mtimes[0], size)?.viewAttributesResolved, true);
});

test('the view walk and Usage Analysis share one analysis per file version', async t => {
	// `cli all` and the desktop Efficiency build need both; the session cache only keeps the
	// slim enriched data, so without the shared analysis each recent session was analyzed twice.
	const { filePath, reads } = mockSession(t, '88888888-8888-4888-8888-888888888888', false);
	await calculateViewStats([filePath]);
	assert.equal(reads(), 2, 'one base parse and one read shared by analysis and repository');
	const usage = await calculateUsageAnalysisStats([filePath]);
	assert.equal(reads(), 2, 'Usage Analysis must reuse the analysis instead of reading the session again');
	assert.equal(usage.last30Days.sessions, 1);
});

test('the view parse passes the session title to the task fallback, as the extension does', async t => {
	// With no classified turns the shared heuristic reads the title; the extension passes it,
	// so the CLI must too or the two hosts file the same session under different tasks.
	const title = 'Plan the database migration';
	const { filePath } = mockSession(t, '99999999-9999-4999-8999-999999999999', { content: JSON.stringify({ customTitle: title, requests: [] }) });
	const data = await processSessionFileForViews(filePath);
	assert.ok(data?.viewAttributesResolved);
	const expected = classifySessionTask(buildClassificationInputFromUsageAnalysis({ toolCalls: { total: 0, byTool: {} } }, title));
	assert.equal(data.taskCategory, expected);
	assert.notEqual(classifySessionTask(buildClassificationInputFromUsageAnalysis({ toolCalls: { total: 0, byTool: {} } })), expected, 'the fixture title must change the category, or this test proves nothing');
});

test('recentAnalysisCutoff is the earlier of the start of last month and 30 days ago', () => {
	assert.deepEqual(recentAnalysisCutoff(new Date(2026, 2, 31, 12)), new Date(2026, 1, 1), 'last month starts first');
	assert.deepEqual(recentAnalysisCutoff(new Date(2026, 2, 1, 12)), new Date(2026, 0, 30), '30 days ago starts first');
});

test('calculateDailyStats enriches only sessions modified since enrichSince', async t => {
	// `all --json` (awaited by the Visual Studio host under a timeout) bounds the enrichment to
	// the recent window; older sessions keep the lean parse, so nothing analyzes the whole history.
	const lean = mockSession(t, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false);
	const leanDays = await calculateDailyStats([lean.filePath], false, { enrichSince: new Date(Date.now() + 86_400_000) });
	assert.equal(lean.reads(), 1, 'an older session must not get the analysis read');
	assert.equal(leanDays.reduce((sum, d) => sum + d.tokens, 0) > 0, true, 'its tokens still count');
	t.mock.restoreAll();
	const recent = mockSession(t, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false);
	await calculateDailyStats([recent.filePath], false, { enrichSince: new Date(Date.now() - 86_400_000) });
	assert.equal(recent.reads(), 2, 'a recent session is enriched');
});

test('isSessionActiveSince asks the adapter when a DB-backed session\'s file mtime is older than the window', async () => {
	// A virtual session's database mtime can lag its real activity (writes still in the WAL), so
	// the bounded `all`/`chart` enrichment must not treat a recently active session as old.
	const cutoff = new Date(2026, 4, 1);
	const oldMtime = new Date(2026, 3, 1);
	let adapterCalls = 0;
	const sources = (lastActivity: Date | null) => ({
		getBackingPath: () => 'store.db',
		getLastActivity: async () => { adapterCalls++; return lastActivity; },
		getMeta: async () => null,
	});
	assert.equal(await isSessionActiveSince(createSessionActivityLookup('store.db#1', sources(new Date(2026, 4, 5))), oldMtime, cutoff), true);
	assert.equal(await isSessionActiveSince(createSessionActivityLookup('store.db#2', sources(new Date(2026, 3, 5))), oldMtime, cutoff), false);
	// A recent database mtime does not decide on its own: an idle session in an active database
	// is judged by its own (old) activity. With no adapter answer the mtime stands in.
	assert.equal(await isSessionActiveSince(createSessionActivityLookup('store.db#3', sources(new Date(2026, 2, 5))), new Date(2026, 4, 2), cutoff), false);
	assert.equal(await isSessionActiveSince(createSessionActivityLookup('store.db#4', sources(null)), new Date(2026, 4, 2), cutoff), true);
	const before = adapterCalls;
	// A regular file: its own mtime is the answer; the adapter is never asked.
	const regular = { getBackingPath: (f: string) => f, getLastActivity: async () => { adapterCalls++; return new Date(); }, getMeta: async () => null };
	assert.equal(await isSessionActiveSince(createSessionActivityLookup('session.json', regular), oldMtime, cutoff), false);
	assert.equal(adapterCalls, before);
});

test('sessionActivityTime: a DB-backed session is dated by its own adapter activity, never by the shared database mtime', async () => {
	// Usage Analysis buckets periods by this time and the view walk filters by it, so both count
	// the same sessions (the Efficiency view combines them).
	const cutoff = new Date(2026, 4, 1);
	const oldMtime = new Date(2026, 3, 1);
	const recentMtime = new Date(2026, 4, 9);
	const virtual = (lastActivity: Date | null) => ({ isVirtual: true, lastActivity: async () => lastActivity });
	// WAL lag: the database looks old, the session was active recently.
	assert.deepEqual(await sessionActivityTime(virtual(new Date(2026, 4, 8)), oldMtime), new Date(2026, 4, 8));
	// Another session wrote to the database recently; this one has been idle for weeks. It must
	// not borrow the database mtime, or one write would admit every historical session.
	assert.deepEqual(await sessionActivityTime(virtual(new Date(2026, 2, 1)), recentMtime), new Date(2026, 2, 1));
	assert.equal(await isSessionActiveSince(virtual(new Date(2026, 2, 1)), recentMtime, cutoff), false);
	// No adapter answer: the database mtime stands in, as before.
	assert.deepEqual(await sessionActivityTime(virtual(null), oldMtime), oldMtime);
	// A regular file is its own mtime, with no adapter lookup.
	const regular = { isVirtual: false, lastActivity: async () => { throw new Error('must not be asked'); } };
	assert.deepEqual(await sessionActivityTime(regular, recentMtime), recentMtime);
	assert.equal(await isSessionActiveSince(regular, recentMtime, cutoff), true);
	assert.equal(await isSessionActiveSince(regular, oldMtime, cutoff), false);
});

test('calculateViewStats stops and throws instead of returning a partial walk when cancelled', async t => {
	const { filePath, reads } = mockSession(t, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', false);
	await assert.rejects(calculateViewStats([filePath], false, undefined, { isCancelled: () => true }), ViewStatsCancelledError);
	assert.equal(reads(), 0, 'a walk cancelled up front reads nothing');
	// Cancelled after the first file: the rest are skipped and nothing partial is returned.
	let checks = 0;
	const missing = path.join(path.dirname(filePath), 'never-read.json');
	await assert.rejects(calculateViewStats([filePath, missing], false, undefined, { isCancelled: () => ++checks > 2 }), ViewStatsCancelledError);
	assert.equal(reads(), 2, 'only the first file was parsed and enriched');
});

test('sessionVersion adds a DB-backed session\'s own activity time; a file is versioned by its stat alone', async () => {
	// The shared database's mtime moves for other sessions and may not move while this session's
	// writes sit in the WAL, so the view caches must also see the session's own activity time.
	const stats = { mtimeMs: 1_000, size: 10 };
	let asked = 0;
	const at = (ms: number) => async () => { asked++; return new Date(ms); };
	const virtual = path.join(__dirname, 'home', '.crush', 'crush.db#session-1');
	assert.deepEqual(await sessionVersion(virtual, stats, at(5_000)), { mtimeMs: 1_000, size: 10, activityMs: 5_000 });
	assert.notDeepEqual(await sessionVersion(virtual, stats, at(6_000)), await sessionVersion(virtual, stats, at(5_000)), 'a WAL write changes the version even with an unchanged database stat');
	assert.deepEqual(await sessionVersion(virtual, stats, async () => null), stats, 'no adapter answer: the stat alone');
	const before = asked;
	assert.deepEqual(await sessionVersion(path.join(__dirname, 'session.json'), stats, at(9_000)), stats);
	assert.equal(asked, before, 'a regular file never asks the adapter');
});

test('calculateViewStats stays cancelled once cancellation was seen, even if the predicate flips back', async t => {
	// The desktop predicate flips back when the user returns to Chart mid-walk; files skipped while
	// it was true must not come back as a complete (partial) history.
	const { filePath } = mockSession(t, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', false);
	const missing = path.join(path.dirname(filePath), 'never-read.json');
	let checks = 0;
	// Pre-check false, first file sees true (skipped), everything after sees false again.
	await assert.rejects(
		calculateViewStats([filePath, missing], false, undefined, { isCancelled: () => ++checks === 2 }),
		ViewStatsCancelledError,
	);
});
