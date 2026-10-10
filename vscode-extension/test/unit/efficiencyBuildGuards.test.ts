import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	chainBuild,
	isComputedStatsCurrent,
	isMemoryFilesScanFresh,
	makeLivePanelSink,
	mergeDailyStatsIntoFullYear,
	planEfficiencyRebuild,
	webviewDocumentLanguage,
	type PostablePanel,
} from '../../src/extension';

// ---------------------------------------------------------------------------
// isComputedStatsCurrent — the guard that keeps a pre-clear build's result from
// being read back as current after clearCache() has bumped the generation.
// ---------------------------------------------------------------------------

test('isComputedStatsCurrent: an unstamped cache is never current', () => {
	assert.equal(isComputedStatsCurrent(undefined, 0), false);
	assert.equal(isComputedStatsCurrent(undefined, 7), false);
});

test('isComputedStatsCurrent: a cache stamped at the live generation is current', () => {
	assert.equal(isComputedStatsCurrent(0, 0), true);
	assert.equal(isComputedStatsCurrent(7, 7), true);
});

test('isComputedStatsCurrent: any generation move invalidates the stamp', () => {
	assert.equal(isComputedStatsCurrent(0, 1), false, 'a clear after the stamp');
	// Defensive: the caches are stamped, not compared by ordering, so a stamp that somehow
	// runs ahead of the live generation is rejected too rather than treated as "new enough".
	assert.equal(isComputedStatsCurrent(2, 1), false);
});

test('isComputedStatsCurrent: the in-flight-build race is rejected end to end', () => {
	// The sequence the guard exists for, played out in the order the real code runs it.
	let cacheGeneration = 0;

	// 1. A build starts and captures the generation before its first await.
	const startedAtGeneration = cacheGeneration;

	// 2. clearCache() runs while that build is awaiting: caches emptied, generation bumped.
	cacheGeneration++;
	let fullDaily: string | undefined = undefined;
	let fullDailyStamp: number | undefined = undefined;

	// 3. The in-flight build finishes *after* the clear and assigns its result, which was
	//    derived from the pre-clear session cache. The value is present again...
	fullDaily = 'pre-clear data';
	fullDailyStamp = startedAtGeneration;
	assert.ok(fullDaily, 'the cache is non-empty, so presence alone cannot be the test');

	// 4. ...but the next non-forced read must still recompute rather than reuse it.
	assert.equal(
		isComputedStatsCurrent(fullDailyStamp, cacheGeneration),
		false,
		'a result computed before the clear must not be readable as current after it',
	);

	// 5. A build that starts after the clear stamps the live generation and is reusable.
	const rebuildStamp = cacheGeneration;
	assert.equal(isComputedStatsCurrent(rebuildStamp, cacheGeneration), true);
});

// ---------------------------------------------------------------------------
// isMemoryFilesScanFresh — throttles the synchronous readdirSync/statSync walk that
// discovers Copilot memory files, so it does not repeat on every uncached recompute
// (e.g. a periodic Usage Analysis refresh while the panel is open).
// ---------------------------------------------------------------------------

test('isMemoryFilesScanFresh: a scan that has never run is never fresh', () => {
	assert.equal(isMemoryFilesScanFresh(undefined, Date.now(), 5 * 60 * 1000), false);
});

test('isMemoryFilesScanFresh: a scan within the TTL window is reused', () => {
	const now = 1_000_000;
	assert.equal(isMemoryFilesScanFresh(now - 1000, now, 5 * 60 * 1000), true, 'well within TTL');
	assert.equal(isMemoryFilesScanFresh(now - (5 * 60 * 1000 - 1), now, 5 * 60 * 1000), true, 'just under the TTL boundary');
});

test('isMemoryFilesScanFresh: a scan at or past the TTL is stale and must rescan', () => {
	const now = 1_000_000;
	assert.equal(isMemoryFilesScanFresh(now - 5 * 60 * 1000, now, 5 * 60 * 1000), false, 'exactly at the TTL boundary');
	assert.equal(isMemoryFilesScanFresh(now - 6 * 60 * 1000, now, 5 * 60 * 1000), false, 'past the TTL');
});

// ---------------------------------------------------------------------------
// makeLivePanelSink — Efficiency builds are serialized, so the single build in
// flight is always what the live panel is waiting on. Its progress follows that
// panel across a close/reopen instead of dying with the panel that started it.
// ---------------------------------------------------------------------------

function fakePanel(name: string): PostablePanel & { posted: object[]; name: string } {
	const posted: object[] = [];
	return { name, posted, webview: { postMessage: (msg: object) => { posted.push(msg); return true; } } };
}

test('makeLivePanelSink: delivers to the live panel', () => {
	const panel = fakePanel('a');
	const sink = makeLivePanelSink(() => panel);

	sink({ command: 'loadingProgress', completed: 3 });
	sink({ command: 'loadingStep', step: 'computing' });

	assert.deepEqual(panel.posted, [
		{ command: 'loadingProgress', completed: 3 },
		{ command: 'loadingStep', step: 'computing' },
	]);
});

test('makeLivePanelSink: a build outliving its panel keeps the replacement informed', () => {
	// The regression this rule exists for: close the view mid-walk and reopen it, and the new
	// panel's own build is queued behind the one still running. If progress died with the closed
	// panel, the replacement would sit on a frozen loading screen for the rest of that walk.
	const closed = fakePanel('closed');
	const reopened = fakePanel('reopened');
	let live: PostablePanel | undefined = closed;

	const sink = makeLivePanelSink(() => live);
	sink({ tick: 1 });

	live = reopened;
	sink({ tick: 2 });

	assert.deepEqual(closed.posted, [{ tick: 1 }], 'the closed panel stops receiving');
	assert.deepEqual(reopened.posted, [{ tick: 2 }], 'and the replacement picks the walk up mid-flight');
});

test('makeLivePanelSink: drops messages when no panel is live at all', () => {
	let live: PostablePanel | undefined = fakePanel('a');
	const sink = makeLivePanelSink(() => live);

	live = undefined;
	assert.doesNotThrow(() => sink({ tick: 1 }), 'a closed view with no replacement is not an error');
});

test('makeLivePanelSink: the live panel is read per message, not captured', () => {
	// Captured once, this sink would keep posting to a panel the user has closed.
	const first = fakePanel('a');
	const second = fakePanel('b');
	let live: PostablePanel | undefined = first;
	const sink = makeLivePanelSink(() => live);

	sink({ tick: 1 });
	live = second;
	sink({ tick: 2 });
	live = first;
	sink({ tick: 3 });

	assert.deepEqual(first.posted, [{ tick: 1 }, { tick: 3 }]);
	assert.deepEqual(second.posted, [{ tick: 2 }]);
});

// ---------------------------------------------------------------------------
// chainBuild — Efficiency builds are serialized so an older build finishing
// second cannot leave stale data in the shared stat caches.
// ---------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

test('chainBuild: a queued build does not start until the one ahead of it finishes', async () => {
	const events: string[] = [];
	const first = deferred<string>();

	let chain: Promise<unknown> = Promise.resolve();

	const a = chainBuild(chain, () => { events.push('a:start'); return first.promise; });
	chain = a.chain;
	const b = chainBuild(chain, async () => { events.push('b:start'); return 'b'; });
	chain = b.chain;

	// Let every already-resolvable microtask run. `b` must still be waiting on `a`.
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(events, ['a:start'], 'the second build must not start alongside the first');

	first.resolve('a');
	assert.equal(await a.result, 'a');
	assert.equal(await b.result, 'b');
	assert.deepEqual(events, ['a:start', 'b:start']);
});

test('chainBuild: results come back to their own callers, in queue order', async () => {
	let chain: Promise<unknown> = Promise.resolve();
	const results: string[] = [];

	const queued = ['one', 'two', 'three'].map(label => {
		const { result, chain: next } = chainBuild(chain, async () => { results.push(label); return label; });
		chain = next;
		return result;
	});

	assert.deepEqual(await Promise.all(queued), ['one', 'two', 'three']);
	assert.deepEqual(results, ['one', 'two', 'three'], 'builds ran in the order they were queued');
});

test('chainBuild: the caller sees its own build reject', async () => {
	const boom = new Error('build failed');
	const { result } = chainBuild(Promise.resolve(), async () => { throw boom; });

	await assert.rejects(() => result, (e: unknown) => e === boom);
});

test('chainBuild: a failed build does not wedge the builds queued behind it', async () => {
	// The chain and the caller's result differ in failure handling on purpose: without that,
	// one failed Efficiency build would leave the view unable to ever rebuild.
	let chain: Promise<unknown> = Promise.resolve();

	const failing = chainBuild(chain, async () => { throw new Error('build failed'); });
	chain = failing.chain;
	const after = chainBuild(chain, async () => 'recovered');
	chain = after.chain;

	await assert.rejects(() => failing.result);
	assert.equal(await after.result, 'recovered', 'the next build still runs');

	// And the chain itself stays usable for everything queued later.
	const later = chainBuild(chain, async () => 'later');
	assert.equal(await later.result, 'later');
});

test('chainBuild: a rejected predecessor chain still runs the next build', async () => {
	// chainBuild passes `build` as both handlers, so it runs whether the chain it was queued
	// behind settled or failed. A chain that somehow arrives rejected must not skip the build.
	const rejected = Promise.reject(new Error('previous'));
	rejected.catch(() => { /* keep node from flagging an unhandled rejection */ });

	const { result } = chainBuild(rejected, async () => 'ran anyway');
	assert.equal(await result, 'ran anyway');
});

// ---------------------------------------------------------------------------
// Wiring. The pure guards above prove the rules; these prove the rules are
// actually applied at every site that reads or writes a computed-stat cache.
// CopilotTokenTracker cannot be instantiated outside a VS Code host, so this
// follows the structural-assertion pattern instantCacheBoot.test.ts uses.
// ---------------------------------------------------------------------------

// Compiled test output lives under out/vscode-extension/test/unit (tsconfig.tests.json's
// rootDir is the repo root), so walk back up to the package root, then down into src/.
const EXTENSION_SRC = fs.readFileSync(path.join(__dirname, '../../../../src/extension.ts'), 'utf8');

/**
 * The full brace-balanced body of one method, or a loud failure.
 *
 * These tests used to bound a method by naming the method that follows it. That is silently
 * wrong the moment either one moves: `evaluateAndSurfaceInsights`'s end marker named
 * `refreshInsightBadgeFromState`, which sits ~1500 lines *earlier* in the file, so `indexOf`
 * returned -1, `slice(0, -1)` swallowed the rest of the file, and the guard-count assertion was
 * measuring the whole remainder. It passed for the wrong reason until an unrelated guard was
 * added elsewhere. Brace-balancing cannot drift that way, and a missing marker asserts.
 */
function methodBody(marker: string): string {
	const markerIndex = EXTENSION_SRC.indexOf(marker);
	assert.notEqual(markerIndex, -1, `marker not found in extension.ts: ${marker}`);
	const braceStart = EXTENSION_SRC.indexOf('{', markerIndex);
	let depth = 0;
	for (let i = braceStart; i < EXTENSION_SRC.length; i++) {
		if (EXTENSION_SRC[i] === '{') { depth++; }
		else if (EXTENSION_SRC[i] === '}') {
			depth--;
			if (depth === 0) { return EXTENSION_SRC.slice(markerIndex, i + 1); }
		}
	}
	throw new Error(`unbalanced braces while scanning for marker: ${marker}`);
}

/** A span between two markers, asserting the end really follows the start. */
function sliceBetween(startMarker: string, endMarker: string): string {
	const startIndex = EXTENSION_SRC.indexOf(startMarker);
	assert.notEqual(startIndex, -1, `start marker not found in extension.ts: ${startMarker}`);
	const endIndex = EXTENSION_SRC.indexOf(endMarker, startIndex + startMarker.length);
	assert.notEqual(endIndex, -1, `end marker does not follow the start marker: ${endMarker}`);
	return EXTENSION_SRC.slice(startIndex, endIndex);
}

test('wiring: every computed-stat cache is stamped with the generation its build started at', () => {
	// Captured before the first await, never re-read at the write — re-reading would stamp a
	// pre-clear result with the *post*-clear generation and make it look current.
	for (const marker of [
		'this._statsGeneration.detailed = originGeneration;',
		'this._statsGeneration.daily = startedAtGeneration;',
		'this._statsGeneration.fullDaily = startedAtGeneration;',
		'this._statsGeneration.usage = startedAtGeneration;',
		'this._statsGeneration.sessionInputs = startedAtGeneration;',
	]) {
		assert.ok(EXTENSION_SRC.includes(marker), `missing generation stamp: ${marker}`);
	}
	// Nine captures: the six producers of a stamped cache, loadAnalysisStatsInBackground() (which
	// stamps nothing but posts its walk's result straight to the panel and so needs the same
	// capture to gate on), and showDetails()/showEnvironmental() (which gate whether a failed
	// updateTokenStats() means a genuine error or a discarded, superseded run — see
	// isRefreshSuperseded()). The count is the tripwire — a new one added by re-reading the live
	// generation at write time is the bug this whole scheme exists for.
	assert.equal(
		EXTENSION_SRC.split('const startedAtGeneration = ').length - 1,
		9,
		'every producer of a stamped cache or a gated publication must capture before its first await',
	);
	// A refresh's results belong to the generation its *inputs* were gathered in, not the one in
	// effect when a particular calculation happens to start. calculateUsageAnalysisStats() can be
	// handed preloaded entries that predate a clear, so it prefers the caller's origin generation.
	assert.ok(
		EXTENSION_SRC.includes('const startedAtGeneration = originGeneration ?? this._cacheGeneration;'),
		'calculateUsageAnalysisStats() must stamp with the caller-supplied origin generation when it has one',
	);
	assert.ok(
		EXTENSION_SRC.includes('await this.updateAnalysisPanelIfOpen(silent, preloaded, startedAtGeneration);')
		&& EXTENSION_SRC.includes('await this.computeAndUploadFluencyScore(silent, preloaded, startedAtGeneration);'),
		'_runRefreshCore() must pass its pre-preload generation down both paths that consume preloaded',
	);
	// A *producer* must never stamp its result with the generation read at write time — that is
	// the bug this whole scheme exists for. refreshAnalysisPanel() is the one legitimate use of
	// that shape and is excluded: it is not recording a computed result, it is carrying an
	// already-current stamp across its own deliberate bump (see the scoped-invalidation test).
	const refreshAt = EXTENSION_SRC.indexOf('private async refreshAnalysisPanel()');
	const withoutScopedBump = EXTENSION_SRC.slice(0, refreshAt)
		+ EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('\n\tprivate ', refreshAt + 1));
	assert.ok(
		!/_statsGeneration\.\w+ = this\._cacheGeneration/.test(withoutScopedBump),
		'a cache must never be stamped with the generation read at write time — that is the bug',
	);
});

test('wiring: the full-year merge is handed its input\'s origin generation, not the live one', () => {
	// The guard is only a guard if the caller passes the generation its *rows* came from. Passing
	// this._cacheGeneration would make the check trivially true at every call and restore exactly
	// the bug: a pre-clear refresh splicing its rows into a post-clear, current-stamped year.
	assert.ok(
		EXTENSION_SRC.includes('private mergeIntoFullDailyStats(dailyStats: DailyTokenStats[], originGeneration: number): void {'),
		'mergeIntoFullDailyStats() must take the incoming rows\' origin generation',
	);
	assert.equal(
		EXTENSION_SRC.split('this.mergeIntoFullDailyStats(dailyStats, startedAtGeneration);').length - 1,
		2,
		'both callers (the instant paint and the refresh) must pass their own pre-await capture',
	);
	assert.equal(
		EXTENSION_SRC.split('this.mergeIntoFullDailyStats(').length - 1,
		2,
		'no third caller may merge without an origin generation',
	);
	assert.ok(
		!/mergeIntoFullDailyStats\([^)]*this\._cacheGeneration/.test(EXTENSION_SRC),
		'a caller must never re-read the live generation as its input\'s origin — that is the bug',
	);
});

test('wiring: every computed-stat cache is reachable only through a generation-guarded accessor', () => {
	for (const [accessor, key, field] of [
		['currentDetailedStats', 'detailed', 'lastDetailedStats'],
		['currentDailyStats', 'daily', 'lastDailyStats'],
		['currentFullDailyStats', 'fullDaily', 'lastFullDailyStats'],
		['currentUsageAnalysisStats', 'usage', 'lastUsageAnalysisStats'],
		['currentEfficiencySessionInputs', 'sessionInputs', 'lastEfficiencySessionInputs'],
	]) {
		assert.ok(
			EXTENSION_SRC.includes(`private get ${accessor}()`),
			`missing generation-aware accessor: ${accessor}`,
		);
		assert.ok(
			EXTENSION_SRC.includes(
				`return isComputedStatsCurrent(this._statsGeneration.${key}, this._cacheGeneration) ? this.${field} : undefined;`,
			),
			`${accessor} must return undefined once its stamp is no longer current`,
		);
	}
});

test('wiring: the Efficiency sink and build queue use the tested helpers', () => {
	assert.ok(
		EXTENSION_SRC.includes('return makeLivePanelSink(() => this.efficiencyPanel);'),
		'efficiencyLoadingSink() must delegate to the tested live-panel helper',
	);
	// The sink following the live panel is only sound because renders do *not*: a build that
	// outlived its panel must still be barred from drawing its result over the replacement.
	assert.equal(
		EXTENSION_SRC.split('this.efficiencyPanel !== panel').length - 1,
		5,
		'each Efficiency render path must keep its own panel-identity check',
	);
	// The build is wrapped rather than passed straight through, so the queue can tell a build that
	// has not started yet (and will therefore read the live generation) from one already running —
	// and so the running one's own capture is recorded for as long as it runs.
	assert.ok(
		/const \{ result, chain \} = chainBuild\(this\._efficiencyBuildChain, async \(\) => \{\s*this\._efficiencyBuildsQueued--;\s*const generation = this\._cacheGeneration;\s*this\._efficiencyBuildRunningFor = generation;\s*try \{ return await build\(generation\); \}/
			.test(EXTENSION_SRC),
		'runEfficiencyBuild() must delegate to the tested serialization helper',
	);
	// The decrement has to be the last thing before build() runs: every caller captures
	// _cacheGeneration as its callback's first statement, and an await in between would let a
	// clear land after the count said a build would still see it.
	assert.ok(
		EXTENSION_SRC.includes('this._efficiencyBuildsQueued++;'),
		'runEfficiencyBuild() must count the build from the moment it is queued',
	);
	// The caller's promise and the queue's chain must not be the same object: the chain has to
	// absorb failures so one failed build cannot wedge every build queued after it.
	assert.ok(
		EXTENSION_SRC.includes('this._efficiencyBuildChain = chain;\n\t\treturn result;'),
		'the queue must advance on the failure-absorbing chain, not on the caller-facing result',
	);
});

test('wiring: the raw computed-stat fields are never read outside their accessors', () => {
	// The accessors are only a guarantee if nothing bypasses them. Every surviving mention of a
	// raw field must be an assignment to it or the single read inside its own accessor — anything
	// else is a consumer silently opted out of the generation check, which is how this guard was
	// half-applied the first time.
	for (const field of [
		'lastDetailedStats', 'lastDailyStats', 'lastFullDailyStats',
		'lastUsageAnalysisStats', 'lastEfficiencySessionInputs',
	]) {
		const offenders = EXTENSION_SRC.split('\n')
			.map((line, i) => ({ line: line.trim(), no: i + 1 }))
			.filter(({ line }) => line.includes(`this.${field}`))
			.filter(({ line }) => !new RegExp(`this\\.${field}\\s*=`).test(line))
			.filter(({ line }) => !line.startsWith('*') && !line.startsWith('//'))
			.filter(({ line }) => !line.includes('isComputedStatsCurrent('));
		assert.deepEqual(
			offenders, [],
			`${field} is read directly instead of through its generation-aware accessor`,
		);
	}
});

test('wiring: the Efficiency cold path announces the daily phase after its walk, never before', () => {
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('private async collectEfficiencyInputs('));
	const inputs = body.slice(0, body.indexOf('\n\tprivate async buildEfficiencyViewData('));

	const walkAt = inputs.indexOf('dailyStats = await this.trackFullYearBackfill(this.calculateDailyStats(365,');
	assert.ok(walkAt !== -1, 'the cold path must still perform the full-year walk');

	const dailySteps = [...inputs.matchAll(/postEfficiencyStep\(send, stepPct\.daily/g)].map(m => m.index!);
	assert.equal(dailySteps.length, 2, 'both the cached path and the cold path must announce the daily phase');

	// Posting it before the walk pins the bar above parsing's band and freezes it for the whole
	// parse — the failure this view had at 96%, and the reason the cold path posts it afterwards.
	const coldStep = dailySteps.find(i => i > walkAt);
	assert.ok(coldStep !== undefined, 'the cold path must announce the daily phase after its walk completes');

	const usageAt = inputs.indexOf('postEfficiencyStep(send, stepPct.usage');
	assert.ok(coldStep! < usageAt, 'and before the usage step, so the bar steps 85 -> 88 -> 92');
});

test('wiring: clearing the cache rebuilds an open Efficiency panel', () => {
	// _runRefreshCore() publishes to the details/chart/analysis/environmental panels but not this
	// one, and showEfficiency() returns early for an already-open panel — so without this the view
	// keeps showing pre-clear numbers until the user clicks Refresh.
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('public async clearCache()'));
	const clear = body.slice(0, body.indexOf('\n\tpublic async resetInsightsState('));
	assert.ok(
		/if \(this\.efficiencyPanel\) \{[\s\S]*?this\.requestEfficiencyRebuild\(\);/.test(clear),
		'clearCache() must rebuild an open Efficiency panel',
	);
	assert.ok(
		clear.indexOf('this.requestEfficiencyRebuild()') > clear.indexOf('await this.updateTokenStats()'),
		'the rebuild must come after the clear has completed and the token stats refreshed',
	);
});

test('wiring: a cache invalidation queues at most one automatic Efficiency rebuild', () => {
	// clearCache() and the build-side payload retry both notice an invalidation and both want the
	// panel rebuilt. Neither can be dropped — clearCache() is not the only writer that bumps the
	// generation — so they are collapsed by generation instead, or one clear costs two full walks.
	assert.ok(
		EXTENSION_SRC.includes('private requestEfficiencyRebuild(): void {'),
		'the automatic rebuild must go through a single coalescing entry point',
	);
	assert.ok(
		EXTENSION_SRC.includes('const plan = planEfficiencyRebuild(')
		&& EXTENSION_SRC.includes("if (plan === 'already-requested') { return; }")
		&& EXTENSION_SRC.includes('this._efficiencyRebuildRequestedFor = this._cacheGeneration;'),
		'it must record the generation it requested for, so a second caller at the same generation no-ops',
	);
	// The queued-build arm must mark the invalidation answered too, or the *next* caller at this
	// same generation walks straight past 'already-requested' and queues the second walk anyway.
	assert.ok(
		EXTENSION_SRC.indexOf('this._efficiencyRebuildRequestedFor = this._cacheGeneration;')
		< EXTENSION_SRC.indexOf("if (plan === 'coalesce-onto-queued') {"),
		'the requested-for stamp must be recorded before the coalescing arm returns',
	);
	assert.ok(
		EXTENSION_SRC.includes('this._efficiencyBuildsQueued++;')
		&& EXTENSION_SRC.includes('this._efficiencyBuildsQueued--;'),
		'runEfficiencyBuild() must track builds that are queued but have not started yet',
	);
	// And the generation of the build that is *running*, which the queued count stops describing
	// the moment it starts. Handed to the build rather than re-read by each caller: two captures of
	// the same number can drift, one cannot.
	assert.ok(
		EXTENSION_SRC.includes('private runEfficiencyBuild<T>(build: (generation: number) => Promise<T>): Promise<T> {'),
		'runEfficiencyBuild() must hand the build its captured generation instead of each caller re-reading it',
	);
	assert.ok(
		EXTENSION_SRC.includes('this._efficiencyBuildRunningFor = generation;')
		&& EXTENSION_SRC.includes('this._efficiencyBuildRunningFor,'),
		'the running build\'s generation must be recorded and given to the planner',
	);
	// Cleared identity-checked, like clearInFlightRefresh() and releaseEfficiencyRebuildRequest():
	// a build settling after its successor started must not erase the successor's registration.
	assert.ok(
		EXTENSION_SRC.includes('if (this._efficiencyBuildRunningFor === generation) { this._efficiencyBuildRunningFor = undefined; }'),
		'a settling build must only clear the running registration it owns',
	);
	// No caller may re-read the live generation inside its build callback — that is the drift the
	// handed capture exists to remove.
	for (const callback of ['this.runEfficiencyBuild(startedAt =>', 'this.runEfficiencyBuild(async startedAt =>']) {
		assert.ok(EXTENSION_SRC.includes(callback), `build callers must take the handed generation: ${callback}`);
	}
	assert.equal(
		EXTENSION_SRC.split('generation = startedAt;').length - 1, 2,
		'both build callers must use the handed capture, not one of their own',
	);
	// Exactly one caller may start a rebuild directly: refreshEfficiencyPanel() is also the panel's
	// own Refresh button, which must never be coalesced away.
	assert.equal(
		EXTENSION_SRC.split('void this.refreshEfficiencyPanel()').length - 1,
		1,
		'both automatic triggers must route through requestEfficiencyRebuild(), not call the refresh directly',
	);
});

test('wiring: a Usage Analysis refresh does not invalidate the daily or full-year caches', () => {
	// The generation counter is global but refreshAnalysisPanel()'s invalidation is not: it
	// discards usage-analysis state only. A bare bump silently truncated an open Chart —
	// _runRefreshCore()'s backfill skips whenever a chart panel is open, so nothing rebuilt the
	// full year, and the chart re-rendered from the 30-day fallback after nothing more than a
	// Usage Analysis refresh.
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('private async refreshAnalysisPanel()'));
	const refresh = body.slice(0, body.indexOf('\n\tprivate ', 1));

	assert.ok(refresh.includes('this._cacheGeneration++;'), 'the bump itself must stay — recordEfficiencyPayload() keys on it');

	for (const key of ['detailed', 'daily', 'fullDaily']) {
		assert.ok(
			refresh.includes(`isComputedStatsCurrent(this._statsGeneration.${key}, this._cacheGeneration)`),
			`refreshAnalysisPanel() must record whether ${key} was current before the bump`,
		);
		assert.ok(
			refresh.includes(`this._statsGeneration.${key} = this._cacheGeneration;`),
			`refreshAnalysisPanel() must carry a current ${key} stamp across the bump`,
		);
	}

	// Order matters: both reads must precede the bump, or they compare against the new value
	// and every cache looks stale regardless.
	const bumpAt = refresh.indexOf('this._cacheGeneration++;');
	const lastRead = Math.max(
		refresh.indexOf('const detailedWasCurrent'),
		refresh.indexOf('const dailyWasCurrent'),
		refresh.indexOf('const fullDailyWasCurrent'),
	);
	assert.ok(lastRead !== -1 && lastRead < bumpAt, 'the was-current reads must be taken before the bump');
});

test('wiring: an explicit refresh always re-scans memory files, even within the TTL', () => {
	// computeMemoryFilesAnalysis() throttles its filesystem walk to once per
	// MEMORY_FILES_SCAN_TTL_MS and reuses the cached result in between — but a user who presses
	// Refresh (or clears the cache) is explicitly asking for current data, so both paths must
	// reset the scan timestamp rather than silently serving a within-TTL result that ignores
	// files added or deleted since the last scan.
	for (const [fnSignature, label] of [
		['private async refreshAnalysisPanel()', 'refreshAnalysisPanel()'],
		['public async clearCache()', 'clearCache()'],
	] as const) {
		const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf(fnSignature));
		const nextPrivate = body.indexOf('\n\tprivate ', 1);
		const nextPublic = body.indexOf('\n\tpublic ', 1);
		const candidates = [nextPrivate, nextPublic].filter(i => i !== -1);
		const end = candidates.length > 0 ? Math.min(...candidates) : body.length;
		const fn = body.slice(0, end);
		assert.ok(
			fn.includes('this._memoryFilesAnalysisScannedAt = undefined;'),
			`${label} must reset _memoryFilesAnalysisScannedAt so the next recompute forces a fresh memory-files scan`,
		);
	}
});

// ---------------------------------------------------------------------------
// mergeDailyStatsIntoFullYear — the destination's stamp is not enough. The rows
// being merged in carry a generation of their own, and merging stale rows into a
// current-stamped array is worse than no guard: it certifies the mixture.
// ---------------------------------------------------------------------------

const day = (date: string, tokens: number) => ({ date, tokens }) as never;

test('mergeDailyStatsIntoFullYear: merges current rows by date and keeps the result sorted', () => {
	const merged = mergeDailyStatsIntoFullYear(
		[day('2026-01-01', 1), day('2026-01-03', 3)],
		[day('2026-01-03', 30), day('2026-01-02', 20)],
		4, 4,
	);
	assert.deepEqual(
		merged?.map((d: { date: string; tokens: number }) => [d.date, d.tokens]),
		[['2026-01-01', 1], ['2026-01-02', 20], ['2026-01-03', 30]],
		'incoming rows overwrite the same date and the array stays date-ordered',
	);
});

test('mergeDailyStatsIntoFullYear: nothing to merge into is not a merge', () => {
	assert.equal(mergeDailyStatsIntoFullYear(undefined, [day('2026-01-01', 1)], 4, 4), undefined);
});

test('mergeDailyStatsIntoFullYear: rows older than the live generation are refused', () => {
	// The exact sequence the guard exists for. A refresh starts at generation 4; clearCache()
	// bumps to 5 and a post-clear build repopulates the full year at 5, so the *destination* is
	// legitimately current. The pre-clear refresh then arrives with its own 30-day rows.
	const postClearYear = [day('2026-01-01', 100), day('2026-01-02', 200)];
	const preClearRows = [day('2026-01-02', 2), day('2026-01-09', 9)];

	assert.equal(
		mergeDailyStatsIntoFullYear(postClearYear, preClearRows, 4, 5),
		undefined,
		'a merge whose input predates the destination must be refused, not spliced in',
	);
	// Same inputs, same generation: this is the ordinary case and must still merge, or the guard
	// would have broken the merge instead of the corruption.
	assert.ok(mergeDailyStatsIntoFullYear(postClearYear, preClearRows, 5, 5));
});

// ---------------------------------------------------------------------------
// planEfficiencyRebuild — `requestedFor` alone cannot see the build queue, so a
// clear landing while a build is queued-but-not-started costs a second full walk.
// ---------------------------------------------------------------------------

test('planEfficiencyRebuild: a fresh invalidation with an idle queue starts a rebuild', () => {
	assert.equal(planEfficiencyRebuild(undefined, 0, 0), 'start');
	assert.equal(planEfficiencyRebuild(3, 4, 0), 'start');
});

test('planEfficiencyRebuild: a second request at the same generation no-ops', () => {
	assert.equal(planEfficiencyRebuild(4, 4, 0), 'already-requested');
	// Even with a build queued: the first request already decided what to do about this clear.
	assert.equal(planEfficiencyRebuild(4, 4, 1), 'already-requested');
});

test('planEfficiencyRebuild: a queued build satisfies the invalidation instead of a second walk', () => {
	// Close/reopen queues an initial build; clearCache() then bumps the generation and asks for a
	// rebuild. The queued build captures the live generation when it starts, so it already
	// produces post-clear data — queuing a rebuild behind it walks the full year twice for one clear.
	assert.equal(planEfficiencyRebuild(undefined, 5, 1), 'coalesce-onto-queued');
	assert.equal(planEfficiencyRebuild(4, 5, 2), 'coalesce-onto-queued');
});

test('planEfficiencyRebuild: a build that already completed at this generation satisfies it', () => {
	// clearCache() requests its rebuild only after awaiting updateTokenStats() — long enough for a
	// queued build to start (dropping the queued count to zero), capture the bumped generation and
	// finish. Counting queued builds alone would then start a second full-year walk over data that
	// is already current.
	assert.equal(planEfficiencyRebuild(undefined, 5, 0, 5), 'already-built');
	assert.equal(planEfficiencyRebuild(4, 5, 0, 5), 'already-built');
	// A build that completed at an *older* generation settles nothing.
	assert.equal(planEfficiencyRebuild(undefined, 5, 0, 4), 'start');
	assert.equal(planEfficiencyRebuild(undefined, 5, 1, 4), 'coalesce-onto-queued');
});

test('planEfficiencyRebuild: a running build satisfies it only if it captured this generation', () => {
	// This test previously asserted that a running build *never* satisfies the invalidation, on the
	// stated grounds that it must have captured an older generation. That is false, and the case it
	// misses is the ordinary one: clearCache() bumps the generation and only *then* awaits
	// updateTokenStats(). A build starting inside that await captures the bumped generation, takes
	// the queued count back to zero on its way in, and is still running when the rebuild is finally
	// requested — so counting queued builds alone starts a second full-year walk behind a build
	// that was already going to produce exactly that payload.
	assert.equal(planEfficiencyRebuild(undefined, 5, 0, undefined, 5), 'coalesce-onto-running');
	assert.equal(planEfficiencyRebuild(4, 5, 0, undefined, 5), 'coalesce-onto-running');

	// A build running at an *older* generation still does not count: its payload will be discarded
	// by recordEfficiencyPayload(), so something must rebuild.
	assert.equal(planEfficiencyRebuild(undefined, 5, 0, undefined, 4), 'start');
	// Nor does no running build at all.
	assert.equal(planEfficiencyRebuild(undefined, 5, 0), 'start');
	assert.equal(planEfficiencyRebuild(undefined, 5, 0, undefined, undefined), 'start');

	// Precedence: a queued build is reported as such even when one is also running, and an
	// already-recorded payload still wins over both — the cheaper answer is the truer one.
	assert.equal(planEfficiencyRebuild(undefined, 5, 1, undefined, 5), 'coalesce-onto-queued');
	assert.equal(planEfficiencyRebuild(undefined, 5, 0, 5, 5), 'already-built');
	assert.equal(planEfficiencyRebuild(5, 5, 0, undefined, 5), 'already-requested');
});

// ---------------------------------------------------------------------------
// webviewDocumentLanguage — every view in extension.ts renders localized text, so
// a hardcoded lang="en" has assistive technology announce it as English.
// ---------------------------------------------------------------------------

test('webviewDocumentLanguage: declares a locale the extension actually has a bundle for', () => {
	assert.equal(webviewDocumentLanguage('en'), 'en');
	assert.equal(webviewDocumentLanguage('zh-cn'), 'zh-cn');
	// A bare tag resolves to the bundle that serves it, so the declaration names the language the
	// text is really in — Simplified Chinese, not an unqualified 'zh'.
	assert.equal(webviewDocumentLanguage('zh'), 'zh-cn');
});

test('webviewDocumentLanguage: a language with no bundle is declared en, because the text is en', () => {
	// The point of declaring the language is to stop assistive technology reading localized text
	// with the wrong pronunciation rules. l10n.t() falls back to the English bundle for every
	// language without a package.nls.<locale>.json, so on these installs the rendered strings ARE
	// English — declaring 'fr' would be the same mismatch pointing the other way.
	assert.equal(webviewDocumentLanguage('fr'), 'en');
	assert.equal(webviewDocumentLanguage('pt-BR'), 'en');
	assert.equal(webviewDocumentLanguage('zh-tw'), 'en', 'Traditional Chinese must not claim the Simplified bundle');
});

test('webviewDocumentLanguage: falls back to en for a missing or empty locale', () => {
	assert.equal(webviewDocumentLanguage(undefined), 'en');
	assert.equal(webviewDocumentLanguage(''), 'en');
	assert.equal(webviewDocumentLanguage('   '), 'en');
});

test('webviewDocumentLanguage: anything that is not a known locale cannot reach the attribute', () => {
	// The value is interpolated into a double-quoted HTML attribute. Resolving against the bundle
	// list makes the output a closed set of compile-time ids, so this holds by construction.
	assert.equal(webviewDocumentLanguage('en" onload="alert(1)'), 'en');
	assert.equal(webviewDocumentLanguage('en><script>'), 'en');
	assert.equal(webviewDocumentLanguage('zh-cn" onload="alert(1)'), 'en');
});

test('webviewDocumentLanguage: a prototype key is not a shipped locale', () => {
	// LOCALE_BUNDLES is a plain object, so a *lowercase* prototype key reads back truthy from a
	// bare lookup and would be reported as a locale — emitting lang="constructor". The lookup is
	// own-property checked, which is also what makes the "closed set of bundle ids" claim true.
	assert.equal(webviewDocumentLanguage('constructor'), 'en');
	assert.equal(webviewDocumentLanguage('__proto__'), 'en');
	assert.equal(webviewDocumentLanguage('CONSTRUCTOR'), 'en', 'the lookup lowercases, so casing cannot smuggle it past');
});

test('webviewDocumentLanguage: tracks the bundles that actually ship', () => {
	// If a package.nls.<locale>.json is added, this must start returning it — otherwise the new
	// translation ships while every view still declares English.
	const bundles = fs.readdirSync(path.join(__dirname, '../../../..'))
		.filter(f => /^package\.nls\..+\.json$/.test(f))
		.map(f => f.replace(/^package\.nls\.|\.json$/g, '').toLowerCase());
	assert.deepEqual(bundles.sort(), ['zh-cn'], 'a new bundle needs a case in the tests above');
	for (const locale of bundles) {
		assert.equal(webviewDocumentLanguage(locale), locale, `${locale} ships a bundle and must be declared`);
	}
});

// ---------------------------------------------------------------------------
// Wiring for the publication gate. The stamps make a later *read* of a
// superseded result recompute; they do nothing about the run that produced it
// publishing straight to the panels.
// ---------------------------------------------------------------------------

test('wiring: a refresh superseded by a clear publishes nothing at all', () => {
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('private async publishRefreshResult('));
	const core = body.slice(0, body.indexOf('\n\t/** Core discover → parse → compute → render → persist pass'));

	const gateAt = core.indexOf('if (this.isRefreshSuperseded(startedAtGeneration)) { return false; }');
	assert.ok(gateAt !== -1, 'publishRefreshResult() must gate on the generation its inputs were gathered in');

	// Everything that leaves this function — the status bar, the four panel publications, the
	// persisted snapshot — must sit behind the gate, not merely the cache stamps.
	for (const published of [
		'this._hasCompletedRealRefresh = true;',
		'this.updateStatusBarAndTooltip(detailedStats);',
		'this.updateDetailsPanelIfOpen(detailedStats, silent);',
		'await this.updateAnalysisPanelIfOpen(silent, preloaded, startedAtGeneration);',
		'this.updateEnvironmentalPanelIfOpen(detailedStats, silent);',
		'this.recordDetailedStats(detailedStats, startedAtGeneration);',
		'this.persistRefreshResult(isLeader);',
	]) {
		const at = core.indexOf(published);
		assert.ok(at !== -1, `publishRefreshResult() no longer contains: ${published}`);
		assert.ok(at > gateAt, `${published} must come after the superseded-run gate`);
	}
	// One check on entry is not enough: this awaits calculateUsageAnalysisStats(),
	// calculateMaturityScores() and the insight pass, and a clearCache() landing in any of them
	// would otherwise let the Environmental panel and the persisted snapshot carry pre-clear data.
	assert.equal(
		core.split('if (this.isRefreshSuperseded(startedAtGeneration)) { return false; }').length - 1,
		4,
		'the generation must be re-checked after every await, not only on entry',
	);
	for (const [awaited, next] of [
		['await this.updateAnalysisPanelIfOpen(', 'await this.computeAndUploadFluencyScore('],
		['await this.computeAndUploadFluencyScore(', 'this.updateEnvironmentalPanelIfOpen('],
		['await this.evaluateAndSurfaceInsights(startedAtGeneration);', 'this.persistRefreshResult(isLeader);'],
	]) {
		// indexOf(-1) silently restarts from 0, which would match the entry gate and pass
		// vacuously — this assertion caught exactly that after the insight call gained a parameter.
		const awaitedAt = core.indexOf(awaited);
		assert.ok(awaitedAt !== -1, `publishRefreshResult() no longer contains: ${awaited}`);
		const recheck = core.indexOf('if (this.isRefreshSuperseded(startedAtGeneration)) { return false; }', awaitedAt);
		assert.ok(
			recheck !== -1 && recheck < core.indexOf(next),
			`a superseded run must not reach ${next} after awaiting ${awaited}`,
		);
	}
	// The detailed stats must be recorded before the analysis payload is built: it reads
	// monthBillingGroupCosts through currentDetailedStats, which is empty until the stamp lands.
	assert.ok(
		core.indexOf('this.recordDetailedStats(detailedStats, startedAtGeneration);')
		< core.indexOf('await this.updateAnalysisPanelIfOpen('),
		'recordDetailedStats() must run before the panels that read currentDetailedStats',
	);
	// _hasCompletedRealRefresh in particular: it tells renderInstantStatsFromCache() that verified
	// data has already been published, so a discarded run must never set it.
	assert.ok(
		core.indexOf('this._hasCompletedRealRefresh = true;') > gateAt,
		'a discarded run must not claim a real refresh completed',
	);
	// And _runRefreshCore() must route its result through this method rather than publishing inline.
	const runBody = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('private async _runRefreshCore('));
	const run = runBody.slice(0, runBody.indexOf('\n\t/**\n\t * Persist results after a refresh.'));
	assert.ok(
		run.includes('const published = await this.publishRefreshResult(') && run.includes('if (!published) { return undefined; }'),
		'_runRefreshCore() must publish through publishRefreshResult() and abandon the run when it declines',
	);
});

test('wiring: a helper that publishes after its own await checks the generation itself', () => {
	// The gates in publishRefreshResult() run *between* helpers, which is too late for one that
	// awaits and then publishes on the way back: the pre-clear data is already on screen by the
	// time the caller re-checks. Each such helper asks mayPublishAt() immediately before publishing.
	assert.ok(
		EXTENSION_SRC.includes('private mayPublishAt(originGeneration: number | undefined): boolean {')
		&& EXTENSION_SRC.includes('return originGeneration === undefined || isComputedStatsCurrent(originGeneration, this._cacheGeneration);'),
		'the inner guard must defer to the tested generation predicate, and stay inert for callers outside a refresh',
	);
	for (const [entry, awaited, publication] of [
		[
			'private async updateAnalysisPanelIfOpen(',
			'await this.calculateUsageAnalysisStats(false, preloaded, originGeneration);', 'if (silent) {',
		],
		[
			'private async computeAndUploadFluencyScore(',
			'await this.calculateMaturityScores(false, preloaded, originGeneration)', 'this.maturityPanel.webview.html =',
		],
		[
			'private async evaluateAndSurfaceInsights(',
			"await this.context.globalState.update('insights.state', this._insightStateBag);", 'command: \'updateInsights\'',
		],
	]) {
		const fn = methodBody(entry);
		const guardAt = fn.indexOf('if (!this.mayPublishAt(originGeneration)) { return; }');
		assert.ok(guardAt !== -1, `${entry} must check the generation before publishing`);
		assert.ok(fn.indexOf(awaited) < guardAt, `${entry}'s guard must come after its own await, not before it`);
		assert.ok(guardAt < fn.indexOf(publication), `${entry}'s guard must come before it publishes`);
	}
	// The insight pass publishes twice — the panel post, then the toast after a second state
	// write — so one guard is not enough for it.
	const insights = methodBody('private async evaluateAndSurfaceInsights(');
	assert.equal(
		insights.split('if (!this.mayPublishAt(originGeneration)) { return; }').length - 1,
		2,
		'every publication in the insight pass must be guarded, not only the first',
	);
	assert.ok(
		insights.indexOf("await this.context.globalState.update('insights.lastNudgeAt', now);")
		< insights.lastIndexOf('if (!this.mayPublishAt(originGeneration)) { return; }')
		&& insights.lastIndexOf('if (!this.mayPublishAt(originGeneration)) { return; }') < insights.indexOf('showInformationMessage('),
		'the toast must be guarded after its own state write, not before it',
	);
	// The insight pass only gets a generation because the refresh hands it one.
	assert.ok(
		EXTENSION_SRC.includes('await this.evaluateAndSurfaceInsights(startedAtGeneration);'),
		'publishRefreshResult() must thread its generation into the insight pass',
	);
});

test('wiring: a superseded walk stops narrating its progress too', () => {
	// Gating only the terminal ready/error messages left the curation stages ungated: they come
	// from computeCurationAnalysis(), called *inside* calculateUsageAnalysisStats(), so a walk a
	// clear had superseded could still post curation:* stages and counts to the live panel and
	// regress the replacement refresh's loading UI back to its own stale progress.
	assert.ok(
		EXTENSION_SRC.includes('private postUsageLoadingProgress(stage: string, details?: Record<string, unknown>, originGeneration?: number): void {'),
		'the progress poster must be able to take the generation its walk belongs to',
	);
	const poster = methodBody('private postUsageLoadingProgress(');
	assert.ok(
		poster.includes('if (!this.mayPublishAt(originGeneration)) { return; }'),
		'and must gate on it, through the same predicate every other publication uses',
	);
	assert.ok(
		poster.indexOf('if (!this.analysisPanel) { return; }') < poster.indexOf('mayPublishAt'),
		'the panel check stays first — a closed panel is cheaper to rule out than a generation',
	);

	// Every curation stage must carry it, not just the ones that report counts.
	const curationAt = EXTENSION_SRC.indexOf('private computeCurationAnalysis(');
	assert.ok(
		EXTENSION_SRC.slice(curationAt).startsWith('private computeCurationAnalysis(last30Days: UsageAnalysisPeriod, originGeneration?: number)'),
		'computeCurationAnalysis() must take the generation to pass on',
	);
	const curation = methodBody('private computeCurationAnalysis(');
	const stages = curation.split("this.postUsageLoadingProgress('curation:").length - 1;
	assert.ok(stages >= 10, `expected the curation stages to still be there, found ${stages}`);
	assert.equal(
		curation.split(', originGeneration);').length - 1, stages,
		'every curation progress post must carry its walk\'s generation, not just some of them',
	);
	// And the walk must hand it the generation it stamps its own result with.
	assert.ok(
		EXTENSION_SRC.includes('curationAnalysis: this.computeCurationAnalysis(last30DaysStats, startedAtGeneration),'),
		'calculateUsageAnalysisStats() must pass the generation it stamps with, not re-read the live one',
	);
});

test('wiring: the background Usage Analysis load gates its own post', () => {
	// loadAnalysisStatsInBackground() is the fourth helper of the same shape: it awaits the
	// usage-analysis walk and then posts updateStats straight to the panel. The stamp on
	// lastUsageAnalysisStats makes currentUsageAnalysisStats reject the cached result but does
	// nothing to stop *this* result reaching the view, so a clear landing during the walk could
	// land this post after the clear's replacement refresh and overwrite it.
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('private async loadAnalysisStatsInBackground('));
	const fn = body.slice(0, body.indexOf('\n\tprivate postUsageLoadingProgress('));
	assert.ok(fn.length > 0, 'loadAnalysisStatsInBackground() must be findable for this assertion');

	const captureAt = fn.indexOf('const startedAtGeneration = this._cacheGeneration;');
	assert.ok(captureAt !== -1, 'it must capture the generation its inputs belong to');
	const awaitAt = fn.indexOf('await this.calculateUsageAnalysisStats(true, undefined, startedAtGeneration);');
	assert.ok(
		awaitAt !== -1,
		'the walk must be handed that capture, so the stamp and the gate are the same number by construction',
	);
	const guardAt = fn.indexOf('if (!this.mayPublishAt(startedAtGeneration)) { return; }');
	assert.ok(guardAt !== -1, 'it must check the generation before publishing');
	assert.ok(captureAt < awaitAt && awaitAt < guardAt, 'the guard must come after its own await, not before it');
	// The failure path publishes too, and is gated on the same capture. An error from a superseded
	// walk replacing the replacement refresh's loading state — or the valid content it already
	// rendered — is the same defect wearing a different message. The log stays unconditional.
	const logAt = fn.indexOf('this.error(`Failed to load usage analysis stats:');
	assert.ok(logAt !== -1, 'the failure must still be logged');
	const catchGuardAt = fn.indexOf('if (!this.mayPublishAt(startedAtGeneration)) { return; }', guardAt + 1);
	assert.ok(catchGuardAt !== -1, 'the catch block must gate its panel-facing messages too');
	assert.ok(logAt < catchGuardAt, 'the log must not be gated — only the two panel messages are');
	for (const publication of ["this.postUsageLoadingProgress('error'", "command: 'updateStatsError'"]) {
		const at = fn.indexOf(publication);
		assert.ok(at !== -1, `missing failure publication: ${publication}`);
		assert.ok(catchGuardAt < at, `${publication} must sit behind the catch guard`);
	}
	// And the panel-identity check is retained alongside it, not replaced by it.
	assert.ok(
		fn.includes('if (this.analysisPanel && this.analysisPanel === panel) {'),
		'the generation gate must not displace the panel-identity check',
	);
	// Both publications are behind it: the progress card's tool counts come from the same walk.
	for (const publication of ["this.postUsageLoadingProgress('ready'", "command: 'updateStats'"]) {
		const at = fn.indexOf(publication);
		assert.ok(at !== -1, `missing publication: ${publication}`);
		assert.ok(guardAt < at, `${publication} must sit behind the guard`);
	}
});

test('wiring: a caller does not re-refresh when the run it waited for already covered it', () => {
	// The awaited run was registered before this caller's generation, but beginRefreshGeneration()
	// re-captures once it is past its cache-load/snapshot/lock preamble — so a clear landing inside
	// that preamble leaves it publishing valid post-clear data, and a second full refresh here
	// would be pure duplicate work for one clear.
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('public async updateTokenStats('));
	const fn = body.slice(0, body.indexOf('\n\t/**\n\t * Seeds a preload queue'));
	assert.ok(
		fn.includes('if (settled !== undefined && this._lastPublishedRefreshGeneration === this._cacheGeneration) {')
		&& fn.includes('return settled;'),
		'a waiter must reuse the completed run\'s result when that run ended up covering its generation',
	);
	assert.ok(
		fn.indexOf('const settled = await inFlight.catch(() => undefined);') < fn.indexOf('return settled;'),
		'the reuse check must read the state left behind after the await',
	);
	// And only a run that actually published may set that marker.
	const publish = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('private async publishRefreshResult('));
	const pub = publish.slice(0, publish.indexOf('\n\t/** Core discover → parse → compute → render → persist pass'));
	assert.ok(
		pub.indexOf('this._lastPublishedRefreshGeneration = startedAtGeneration;') > pub.indexOf('this.persistRefreshResult(isLeader);'),
		'the published-generation marker must be set only on the success path, after persistence',
	);
});

test('wiring: the superseded-run gate reuses the tested generation predicate', () => {
	assert.ok(
		EXTENSION_SRC.includes('private isRefreshSuperseded(startedAtGeneration: number): boolean {')
		&& EXTENSION_SRC.includes('if (isComputedStatsCurrent(startedAtGeneration, this._cacheGeneration)) { return false; }'),
		'isRefreshSuperseded() must decide with isComputedStatsCurrent(), not an ad-hoc comparison',
	);
});

test('wiring: the instant paint checks the live generation before publishing', () => {
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('private async renderInstantStatsFromCache('));
	const render = body.slice(0, body.indexOf('\n\tprivate async queueMissingOpenCodeDbSessionsFromCache('));

	const gateAt = render.indexOf('if (!this.canPublishInstantPaint(startedAtGeneration)) { return; }');
	assert.ok(gateAt !== -1, 'the provisional paint must be gated on the generation it started in');
	for (const published of [
		'this.recordDetailedStats(stats, startedAtGeneration);',
		'this.updateStatusBarAndTooltip(stats);',
		'this.updateDetailsPanelIfOpen(stats, true);',
		'this.updateChartPanelIfOpen(true);',
	]) {
		assert.ok(render.indexOf(published) > gateAt, `${published} must come after the generation gate`);
	}
	// _hasCompletedRealRefresh is a different question from "were the caches cleared": the clear's
	// own refresh may not have published yet, so that flag can still be false here.
	assert.ok(
		EXTENSION_SRC.includes('private canPublishInstantPaint(startedAtGeneration: number): boolean {')
		&& /canPublishInstantPaint[\s\S]{0,400}?isComputedStatsCurrent\(startedAtGeneration, this\._cacheGeneration\)/.test(EXTENSION_SRC),
		'canPublishInstantPaint() must test the generation, not only _hasCompletedRealRefresh',
	);
});

test('wiring: a caller past a cache clear does not coalesce onto a run that will discard', () => {
	const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf('public async updateTokenStats('));
	const fn = body.slice(0, body.indexOf('\n\t/**\n\t * Seeds a preload queue'));

	assert.ok(
		fn.includes('if (this._updateTokenStatsInFlightGeneration === this._cacheGeneration) {'),
		'coalescing must be conditional on the in-flight run belonging to the caller\'s generation',
	);
	assert.ok(
		fn.includes('await inFlight.catch(() => undefined);'),
		'a superseded run must be waited out, not raced — see the refresh-leader lock',
	);
	// Overlapping two runs in one window would have the second lose acquireRefreshLock() to the
	// first and parse as a follower, on a miss budget, over the cache the clear just emptied.
	assert.ok(
		fn.indexOf('await inFlight.catch(() => undefined);') < fn.indexOf('const run = this._runUpdateTokenStats(silent);'),
		'the fresh run must start only after the superseded one has settled',
	);
	// Registration is identity-checked on both sides, so a superseded run settling late cannot
	// deregister the fresh run that replaced it.
	assert.ok(
		EXTENSION_SRC.includes('if (this._updateTokenStatsInFlight !== run) { return; }'),
		'clearInFlightRefresh() must only clear the registration it owns',
	);
	assert.equal(
		fn.split('this.clearInFlightRefresh(').length - 1, 2,
		'both the wait loop and the run\'s own finally must deregister through the identity check',
	);
});

test('wiring: the in-flight generation tracks the capture that governs the discard', () => {
	// updateTokenStats() registers its own capture before the cache load, snapshot warm and leader
	// election. _runRefreshCore() captures again afterwards, and *that* is the number it discards
	// on — so it republishes it, or a caller declines to coalesce onto a run that is in fact going
	// to publish current data and pays for a second full parse.
	assert.ok(
		EXTENSION_SRC.includes('const startedAtGeneration = this.beginRefreshGeneration();'),
		'_runRefreshCore() must capture through beginRefreshGeneration()',
	);
	assert.ok(
		/private beginRefreshGeneration\(\): number \{\s*this\._updateTokenStatsInFlightGeneration = this\._cacheGeneration;\s*return this\._cacheGeneration;/
			.test(EXTENSION_SRC),
		'beginRefreshGeneration() must publish its capture as the in-flight run\'s generation',
	);
});

test('wiring: the Efficiency build threads its origin generation into both later walks', () => {
	// The full-year walk repopulates the raw session cache. A clear landing during it leaves
	// pre-clear entries there, and these two then read them as cache hits while starting *after*
	// the bump — stamping pre-clear data with the new generation.
	assert.ok(
		EXTENSION_SRC.includes('const usage = await this.calculateUsageAnalysisStats(!forceRecalc, undefined, originGeneration);'),
		'the Efficiency usage walk must stamp with the build\'s origin generation',
	);
	assert.ok(
		EXTENSION_SRC.includes('const sessionInputs = await this.collectEfficiencySessionInputs(EFFICIENCY_BEHAVIOR_WEEKS, !forceRecalc, originGeneration);'),
		'the Efficiency session-input walk must stamp with the build\'s origin generation',
	);
	assert.equal(
		EXTENSION_SRC.split('const startedAtGeneration = originGeneration ?? this._cacheGeneration;').length - 1,
		2,
		'both walks must prefer a caller-supplied origin generation over their own start',
	);
	// And the generation actually reaching them is the one each build captured for its payload
	// check, not a second, later read.
	for (const call of [
		'return this.buildEfficiencyViewData(false, this.efficiencyLoadingSink(), generation);',
		'return this.buildEfficiencyViewData(true, this.efficiencyLoadingSink(), generation);',
	]) {
		assert.ok(EXTENSION_SRC.includes(call), `build must pass its captured generation: ${call}`);
	}
});

test('wiring: a failed Efficiency build does not leave its generation marked satisfied', () => {
	// requestEfficiencyRebuild() marks a generation satisfied when it defers to a queued build.
	// That assumes the build publishes; if it throws, the panel sits on its error/fallback state
	// and the stamp would coalesce away every later request for the same generation.
	assert.ok(
		EXTENSION_SRC.includes('private releaseEfficiencyRebuildRequest(failedAtGeneration: number): void {')
		&& EXTENSION_SRC.includes('this._efficiencyRebuildRequestedFor = undefined;'),
		'a failed build must be able to release the rebuild stamp',
	);
	// And release only the stamp it owns, exactly as clearInFlightRefresh() deregisters only its
	// own run. An unconditional clear lets a stale build's failure erase a stamp a newer
	// invalidation already set, and the next request for that newer generation queues a duplicate
	// full-year walk once the replacement build has started and the queued count is back to zero.
	assert.ok(
		EXTENSION_SRC.includes('if (this._efficiencyRebuildRequestedFor !== failedAtGeneration) { return; }'),
		'releaseEfficiencyRebuildRequest() must only release the stamp its own generation set',
	);
	assert.equal(
		EXTENSION_SRC.split('this.releaseEfficiencyRebuildRequest(generation);').length - 1,
		2,
		'both Efficiency build paths must release the stamp, for the generation their build ran at',
	);
	for (const [errorLog, until] of [
		["this.error('Error building Efficiency view:', error);", '\n\tprivate async refreshEfficiencyPanel('],
		["this.error('Error refreshing Efficiency view:', error);", '\n\t/** Maps one cached session'],
	]) {
		const at = EXTENSION_SRC.indexOf(errorLog);
		assert.ok(at !== -1, `missing catch block: ${errorLog}`);
		const rest = EXTENSION_SRC.slice(at, EXTENSION_SRC.indexOf(until, at));
		assert.ok(
			rest.includes('this.releaseEfficiencyRebuildRequest(generation);'),
			`${errorLog} must release the stamp for its own build's generation`,
		);
	}
	// And only a payload that was actually recorded may mark its generation built.
	assert.ok(
		/this\._lastEfficiencyViewData = data;\s*this\._efficiencyBuildCompletedFor = builtAtGeneration;/.test(EXTENSION_SRC),
		'the completed-build marker must be set where the payload is recorded, not where the build starts',
	);
	assert.ok(
		EXTENSION_SRC.includes('this._efficiencyBuildCompletedFor,'),
		'requestEfficiencyRebuild() must consult the completed-build generation',
	);
});

test('wiring: every rejected Efficiency payload queues the rebuild that replaces it', () => {
	// Both rejection paths must queue one. showEfficiency()'s always did; refreshEfficiencyPanel()'s
	// did not, on the stated grounds that re-entering the refresh "would loop". It cannot:
	// requestEfficiencyRebuild() records the generation it requested for, so a second request at
	// the same generation no-ops and a loop would need a fresh bump every round. clearCache() hid
	// the gap by requesting the rebuild itself; refreshAnalysisPanel() bumps and does not, leaving
	// an Efficiency refresh that spanned it showing a fallback with nothing queued to correct it.
	for (const [entry, until] of [
		['public async showEfficiency()', '\n\tprivate async refreshEfficiencyPanel()'],
		['private async refreshEfficiencyPanel()', '\n\t/** Maps one cached session'],
	]) {
		const body = EXTENSION_SRC.slice(EXTENSION_SRC.indexOf(entry));
		const fn = body.slice(0, body.indexOf(until));
		const rejectedAt = fn.indexOf('if (!this.recordEfficiencyPayload(data, generation)) {');
		assert.ok(rejectedAt !== -1, `${entry} must check recordEfficiencyPayload()`);
		const requestAt = fn.indexOf('requestEfficiencyRebuild()', rejectedAt);
		assert.ok(
			requestAt !== -1,
			`${entry} must queue a rebuild when its payload is rejected — nothing else will redraw the panel`,
		);
	}
	// And it must go through the coalescing entry point, which is what bounds the re-entry.
	assert.equal(
		EXTENSION_SRC.split('void this.refreshEfficiencyPanel()').length - 1,
		1,
		'the rebuild must be requested, not by calling the refresh directly — that is what could loop',
	);
});

test('wiring: every webview document that renders localized text declares the viewer\'s language', () => {
	// Those views render localized text — a localized <title>, localized headings, or a
	// `localization` payload their bundle renders from — so lang="en" has assistive technology
	// announce localized content with English pronunciation rules.
	const declared = EXTENSION_SRC.split('<html lang="${webviewDocumentLanguage(vscode.env.language)}">').length - 1;
	assert.equal(declared, 12, 'every localized webview document must declare the viewer\'s language');

	// Two documents are the exception, and both render English regardless of the viewer's
	// language. `lang` names a document's predominant language, so deriving the viewer's locale
	// on these would mislabel the whole page:
	//
	//   getLoadingHtml    — body is loadingHtml.getLoadingHtmlBody(), hardcoded English throughout.
	//   getDashboardHtml  — its `localization` payload sits behind `data ?` and the only call site
	//                       passes undefined, so the bundle never initializes localization and
	//                       renders raw English literals.
	//
	// Pinned by count *and* by location, so a third cannot quietly join them and neither can
	// silently become the wrong one.
	const hardcoded = EXTENSION_SRC.split('<html lang="en">').length - 1;
	assert.equal(hardcoded, 2, 'only the loading screen and the Dashboard may hardcode lang="en"');
	for (const marker of ['private getLoadingHtml(webview: vscode.Webview', 'private getDashboardHtml(']) {
		assert.ok(
			methodBody(marker).includes('<html lang="en">'),
			`a hardcoded lang="en" must belong to ${marker}, not some other document`,
		);
	}

	assert.equal(
		EXTENSION_SRC.split('<html lang=').length - 1, declared + hardcoded,
		'and no other spelling of the lang attribute may survive',
	);
});
