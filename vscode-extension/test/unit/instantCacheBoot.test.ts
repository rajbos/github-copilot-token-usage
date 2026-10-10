/**
 * Regression guard for the boot-time changes made for issue #2018 fix #2
 * (persist the discovery list, render from it immediately):
 *
 *   1. `renderInstantStatsFromCache()` paints the status bar from the on-disk
 *      cache alone (no discovery, no fs.stat, no parsing) the moment
 *      `scheduleInitialUpdate()` runs, so a cold boot shows real numbers
 *      before the full discover→parse pass even starts.
 *   2. `seedPreloadQueueFromCache()` seeds the preload worker queue with the
 *      cache's known file paths before adapter discovery starts, so the
 *      worker pool begins stat+cache-validating files from tick zero instead
 *      of waiting on the slowest adapter's directory walk.
 *
 * Also covers the fixes made in response to PR #2080's Copilot review:
 *   3. The instant paint must not block on the OpenCode DB probe chained onto
 *      the cache-file load (queueMissingOpenCodeDbSessionsFromCache() does its
 *      own SQLite I/O), and must not run at all in sample-data mode (it would
 *      otherwise mix real user sessions into a screenshot/regression fixture).
 *   4. Cache-to-discovery deduplication must use the same path normalization
 *      SessionDiscovery uses across adapters, or a differently-cased/separated
 *      cached key can coexist with a freshly discovered one and double-count
 *      the same file.
 *   5. `_preloadSessionFiles()` must not discard already-seeded `preloaded`
 *      results just because this run's adapter discovery came back empty.
 *   6. The cache snapshot itself (not just cache-vs-discovery) can contain
 *      multiple raw-path spellings of the same physical file, which both the
 *      instant paint and the cache-seeded queue must deduplicate against.
 *   7. `_runRefreshCore()`'s one-time full-year chart backfill must not run
 *      against an empty `sessionFiles` when real cache-seeded `preloaded`
 *      data exists — calculateDailyStats(365, []) sets `lastFullDailyStats`
 *      to `[]`, and since an empty array is truthy, showChart() would treat
 *      that as complete data and get stuck showing an empty chart.
 *
 * This isn't a runtime test (instantiating `CopilotTokenTracker` requires a
 * full VS Code host and file-system session discovery — see
 * analysisUpdateStatsPayload.test.ts for the same constraint), so instead it
 * asserts structural invariants directly on the source.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePathForDedup, dedupeByNormalizedKeyKeepGreatest } from '../../../src/utils/pathUtils';
import { extractBracesBlock } from './sourceStructureTestHelpers';

// Compiled test output lives under out/vscode-extension/test/unit (tsconfig.tests.json's
// rootDir is the repo root), so __dirname does not sit next to the real source tree —
// walk back up to the vscode-extension package root, then down into src/.
const EXTENSION_SRC_PATH = path.join(__dirname, '../../../../src/extension.ts');
const EXTENSION_SRC = fs.readFileSync(EXTENSION_SRC_PATH, 'utf8');

/** Slice the source between two unique markers (inclusive of both), for spans that aren't a single balanced-brace block (e.g. a few statements inside a larger function). */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
	const startIndex = source.indexOf(startMarker);
	assert.notEqual(startIndex, -1, `start marker not found in extension.ts: ${startMarker}`);
	const endMarkerIndex = source.indexOf(endMarker, startIndex);
	assert.notEqual(endMarkerIndex, -1, `end marker not found after start marker in extension.ts: ${endMarker}`);
	return source.slice(startIndex, endMarkerIndex + endMarker.length);
}

test('scheduleInitialUpdate() kicks off renderInstantStatsFromCache() before the real refresh', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private scheduleInitialUpdate(): void {');
	assert.ok(
		body.includes('this.renderInstantStatsFromCache()'),
		'scheduleInitialUpdate() no longer calls renderInstantStatsFromCache() — cold boot will go back to showing nothing until the full scan finishes'
	);
	// It must run before the real pass (inside the 3s setTimeout), not after,
	// otherwise there is nothing "instant" about it.
	const instantCallIndex = body.indexOf('this.renderInstantStatsFromCache()');
	const realRefreshIndex = body.indexOf('await this.updateTokenStats()');
	assert.ok(instantCallIndex !== -1 && realRefreshIndex !== -1 && instantCallIndex < realRefreshIndex,
		'renderInstantStatsFromCache() must be kicked off before the real updateTokenStats() pass');
});

test('renderInstantStatsFromCache() renders from the cache alone, with no discovery/fs I/O, and skips sample-data mode', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private async renderInstantStatsFromCache(): Promise<void> {');

	// Skips entirely in sample-data mode (screenshot/regression fixtures), and does so before
	// touching the cache, or a warm real-user cache would still contaminate a fixture run.
	const sampleGuardIndex = body.indexOf('if (this.isSampleDataModeActive()) { return; }');
	assert.ok(sampleGuardIndex !== -1, 'must skip entirely in sample-data mode — otherwise a warm real cache paints real user data over a screenshot/regression fixture run');

	// Waits for the raw cache-FILE load only — not the OpenCode DB probe chained onto
	// _cacheLoadPromise, which does its own SQLite I/O and would defeat the "no filesystem/DB
	// I/O" guarantee of an instant first paint.
	assert.ok(body.includes('this._cacheFileLoadPromise'), 'must await _cacheFileLoadPromise (the raw cache-file load), not _cacheLoadPromise (which also chains the OpenCode DB probe)');
	assert.ok(!/this\._cacheLoadPromise\b/.test(body), 'must not await _cacheLoadPromise — that also waits on queueMissingOpenCodeDbSessionsFromCache()\'s SQLite I/O, defeating the instant paint');
	const cacheFileWaitIndex = body.indexOf('this._cacheFileLoadPromise');
	assert.ok(sampleGuardIndex < cacheFileWaitIndex, 'the sample-data guard must run before waiting on/reading the cache');

	// After the await, both sample mode (re-checked — the first check only reflects the state at
	// the very start of this call, and runLocalViewRegression() could switch it on while this was
	// suspended) and disposal (dispose() can also run during that same await, e.g. the window
	// closing during startup) are checked via one extracted helper — moving both branches out of
	// this function keeps its own cyclomatic complexity under the lint ceiling.
	const cacheSizeCheckIndex = body.indexOf('if (this.cacheManager.cache.size === 0) { return; }');
	const combinedGuardIndex = body.indexOf('if (this.shouldAbandonInstantPaintAfterCacheLoad()) { return; }');
	assert.ok(combinedGuardIndex !== -1 && cacheFileWaitIndex < combinedGuardIndex && combinedGuardIndex < cacheSizeCheckIndex,
		'must call shouldAbandonInstantPaintAfterCacheLoad() after awaiting _cacheFileLoadPromise, before reading the cache — a single check at the top of the function can go stale across that await');

	assert.ok(!body.includes('getCopilotSessionFilesStreaming') && !body.includes('getCopilotSessionFiles('),
		'renderInstantStatsFromCache() must not run adapter discovery — that defeats the point of an instant render');
	assert.ok(!body.includes('statSessionFile('), 'renderInstantStatsFromCache() must not fs.stat — it should only read the already-loaded in-memory cache');

	// Bails out cleanly when there is nothing cached yet (first-ever run).
	assert.ok(cacheSizeCheckIndex !== -1,
		'must return early when the cache is empty instead of rendering an empty/misleading first paint');

	// Iterates the deduplicated view of the cache, not the raw Map directly — the snapshot is
	// keyed by whatever raw path string was recorded at write time, so two separator/case
	// variants of the same physical file (e.g. on Windows) can coexist as separate entries and
	// would otherwise get summed as if they were two different sessions.
	assert.ok(body.includes('this.getDeduplicatedCacheEntries()'),
		'must iterate getDeduplicatedCacheEntries(), not this.cacheManager.cache directly — a raw iteration can double-count a file that has two path-spelling variants in the cache');
	assert.ok(!/for \(const \[sessionFile, sessionData\] of this\.cacheManager\.cache\)/.test(body),
		'must not iterate this.cacheManager.cache directly — see getDeduplicatedCacheEntries()');

	// Builds preload entries straight from cache and renders the same way a real refresh does.
	assert.ok(body.includes('this.buildMinimalPreloadDetails('), 'must reuse buildMinimalPreloadDetails() to build SessionFileDetails without a fresh parse');
	assert.ok(body.includes('this.calculateDetailedStats(undefined, preloaded)'), 'must aggregate stats via calculateDetailedStats() like the real refresh does');
	for (const renderCall of ['this.updateStatusBarAndTooltip(stats)', 'this.updateDetailsPanelIfOpen(stats, true)', 'this.updateChartPanelIfOpen(true)']) {
		assert.ok(body.includes(renderCall), `renderInstantStatsFromCache() must call ${renderCall} so an already-open panel also gets the instant first paint`);
	}

	// Must compute the same cutoff the real refresh bounds `preloaded` to (Math.min of last30Days/
	// lastMonth start), and filter every cache entry through isUsableForInstantPaint() with it —
	// otherwise this provisional paint could include entries the real refresh's own preloaded
	// excludes, showing a higher number that then visibly drops once the verified refresh lands.
	assert.ok(body.includes('computeUtcDateRanges(new Date())'),
		'must compute the same UTC date ranges the real refresh uses to derive fileLoadCutoffMs');
	assert.ok(/this\.isUsableForInstantPaint\(sessionData, instantPaintCutoffMs\)/.test(body),
		'must filter each cache entry through isUsableForInstantPaint() with the computed cutoff before including it');
});

test('isUsableForInstantPaint() requires a finite positive interaction count, a finite mtime, and falling within the cutoff window', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private isUsableForInstantPaint(sessionData: SessionFileCache | undefined, cutoffMs: number): sessionData is SessionFileCache {');
	assert.ok(body.includes('Number.isFinite(sessionData.interactions) && sessionData.interactions > 0'),
		'must require a finite, positive interactions count — a bare `!== 0` check wrongly accepts NaN or a negative value from a malformed persisted record, since neither strictly equals 0');
	assert.ok(body.includes('Number.isFinite(sessionData.mtime) && sessionData.mtime >= cutoffMs'),
		'must reject a missing entry, a non-finite mtime (a malformed persisted record — new Date(...).toISOString() would throw on it deeper in the caller), and an entry older than cutoffMs');
});

test('isUsableForInstantPaint() rejects details-only placeholder entries', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private isUsableForInstantPaint(sessionData: SessionFileCache | undefined, cutoffMs: number): sessionData is SessionFileCache {');
	assert.ok(body.includes('!sessionData.detailsOnly'),
		'must exclude detailsOnly placeholders (tokens 0 / default usage analysis) from the cache-only startup paint');
});

test('shouldAbandonInstantPaintAfterCacheLoad() checks both sample mode and disposal', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private shouldAbandonInstantPaintAfterCacheLoad(): boolean {');
	assert.ok(body.includes('return this.isSampleDataModeActive() || this._disposed;'),
		'must return true if either sample mode turned on or the window was disposed while the cache-file-load await was suspended — either one means the caller must not proceed to aggregate/publish');
});

test('isSampleDataModeActive() picks the override only when it was actually set (not merely falsy), and gates on being a real directory', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private isSampleDataModeActive(): boolean {');
	assert.ok(body.includes('this.localRegressionSampleDataDir'),
		'must check localRegressionSampleDataDir — set by runLocalViewRegression()/the visual-view-diff harness');
	assert.ok(body.includes("getConfiguration('aiEngineeringFluency').get<string>('sampleDataDirectory')"),
		'must check the aiEngineeringFluency.sampleDataDirectory setting — this must mirror SessionDiscovery.tryGetSampleDataFiles()\'s own check exactly, or the two can disagree about whether sample mode is active');

	// SessionDiscovery's real precedence is `sampleDataDirectoryOverride?.() ?? configured` — the
	// override function is always defined once constructed, so `??` only falls through to config
	// when the override's *return value* is nullish. runLocalViewRegression() sets
	// localRegressionSampleDataDir to '' (not undefined) while deliberately trying real discovery
	// first; a plain truthy check treats '' the same as "no override" and wrongly falls back to
	// config, disagreeing with SessionDiscovery whenever a sampleDataDirectory setting also
	// happens to be configured.
	assert.ok(/overrideValue !== undefined \? overrideValue :/.test(body),
		'must select the override with an explicit !== undefined check, not a truthy check — otherwise runLocalViewRegression()\'s deliberate \'\' override is wrongly treated as absent');

	// tryGetSampleDataFiles() returns undefined (falls back to real discovery) for a
	// configured-but-missing directory, or one whose readdir() fails (e.g. it names a file, not a
	// directory) — a configured stale/deleted/non-directory sampleDataDirectory must not silently
	// disable the cache-only paint on a normal warm boot.
	assert.ok(/fs\.statSync\(sampleDir\.trim\(\)\)\.isDirectory\(\)/.test(body),
		'must gate on the path actually being a directory (fs.statSync(...).isDirectory()), not merely existing — existsSync alone would also true for a misconfigured path pointing at a file');
});

test('_preloadSessionFiles() seeds the queue from the cache before discovery starts, dedupes with path normalization, and never discards seeded results on empty discovery', () => {
	// _preloadSessionFiles()'s own return type is an inline object literal
	// (`Promise<{ sessionFiles: ...; preloaded: ... }>`), so a marker at the
	// start of the signature would make extractBracesBlock's brace-balancing
	// latch onto that type's braces instead of the function body. Anchor the
	// marker on the tail of the signature instead, right before the real `{`.
	const preloadBody = extractBracesBlock(EXTENSION_SRC, 'preloaded: SessionFilePreload[] }> {');
	assert.ok(preloadBody.includes('this.seedPreloadQueueFromCache(queue, seen, cutoffMs, editorSet)'),
		'_preloadSessionFiles() must seed the queue from the cache before kicking off adapter discovery, passing through its own cutoffMs so the seed is bounded the same way the rest of this pass is');

	const seedIndex = preloadBody.indexOf('this.seedPreloadQueueFromCache(');
	const discoveryIndex = preloadBody.indexOf('getCopilotSessionFilesStreaming');
	assert.ok(seedIndex !== -1 && discoveryIndex !== -1 && seedIndex < discoveryIndex,
		'the cache seed must happen before discovery starts, otherwise workers gain nothing from it');

	// Discovery must dedupe against the cache-seeded `seen` set using the same path
	// normalization SessionDiscovery.addDedupedBatch() uses across adapters — a raw-string
	// comparison lets a differently-cased/separated cached key coexist with a freshly
	// discovered one for the same physical file, double-queuing (and double-counting) it.
	assert.ok(/seen\.has\(_normalizePathForDedup\(f\)\)/.test(preloadBody),
		'discovery batches must be filtered using _normalizePathForDedup(), not a raw-string seen.has() check');
	assert.ok(/seen\.add\(_normalizePathForDedup\(f\)\)/.test(preloadBody),
		'newly discovered files must be added to `seen` via _normalizePathForDedup() too, matching how they were checked');

	// A run whose fresh adapter discovery comes back empty (sessionFiles.length === 0) must not
	// clobber already-seeded, already-processed `preloaded` results with a hardcoded [] — that
	// would regress the instant cache-only paint straight back to zero stats whenever adapters
	// transiently return nothing.
	assert.ok(/if \(sessionFiles\.length === 0\) \{[\s\S]*?return \{ sessionFiles, preloaded \};[\s\S]*?\}/.test(preloadBody),
		'the empty-discovery early return must return the real `preloaded` array, not a hardcoded empty one');
	assert.ok(!/return \{ sessionFiles, preloaded: \[\] \};/.test(preloadBody),
		'must not hardcode preloaded: [] on empty discovery — that discards cache-seeded results');

	// A cache-seeded file that still exists but a clean discovery pass no longer recognizes must
	// be reconciled out of `preloaded` (see reconcilePreloadedAgainstDiscovery()) — otherwise it
	// keeps contributing stale stats to every refresh forever, since clearExpiredCache() only
	// detects outright-deleted files, not "un-discovered while still readable" ones.
	const reconcileIndex = preloadBody.indexOf('this.reconcilePreloadedAgainstDiscovery(preloaded, sessionFiles)');
	assert.ok(reconcileIndex !== -1,
		'_preloadSessionFiles() must reconcile `preloaded` against this run\'s discovery result via reconcilePreloadedAgainstDiscovery() after the Promise.all resolves');
	const promiseAllIndex = preloadBody.indexOf('await Promise.all([');
	assert.ok(promiseAllIndex !== -1 && promiseAllIndex < reconcileIndex,
		'reconciliation must happen after discovery+workers finish (sessionFiles must be the real, final discovery result)');
});

test('reconcilePreloadedAgainstDiscovery() only trusts a clean, non-empty, non-sample-mode discovery result, and compares with path normalization', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private reconcilePreloadedAgainstDiscovery(preloaded: SessionFilePreload[], sessionFiles: string[]): SessionFilePreload[] {');

	// Must bail out (keep every cached entry, no pruning) on a flaky/partial scan, OR while sample-data
	// mode is active — gated on isSampleDataModeActive() as well as lastDiscoveryHadError and an empty
	// sessionFiles list. Sample mode matters here specifically: SessionDiscovery returns only the
	// fixture directory's files as `sessionFiles` in that mode, so without this guard every real
	// cached session (none of which are in that fixture-only confirmed set) would be swept and
	// tombstoned by a regression/screenshot run — not just fixture-related entries.
	assert.ok(/if \(this\.isSampleDataModeActive\(\) \|\| this\.sessionDiscovery\.lastDiscoveryHadError \|\| sessionFiles\.length === 0\) \{ ?return preloaded; ?\}/.test(body),
		'must return `preloaded` unfiltered whenever sample-data mode is active, or this run\'s discovery errored or found nothing — pruning must only ever run on a run we can actually trust with real session data');

	assert.ok(/_normalizePathForDedup\(f\)/.test(body) && /confirmedKeys\.has\(_normalizePathForDedup\(p\.sessionFile\)\)/.test(body),
		'the confirmed-by-discovery comparison must use _normalizePathForDedup() on both sides, matching the dedup key used everywhere else in this method');
});

test('seedPreloadQueueFromCache() skips sample-data mode, seeds from the deduplicated + cutoff-filtered cache view, normalizes seen keys, and populates editorSet', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private seedPreloadQueueFromCache(queue: string[], seen: Set<string>, cutoffMs: number, editorSet?: Set<string>): number {');
	const sampleGuardIndex = body.indexOf('if (this.isSampleDataModeActive()) { return 0; }');
	assert.ok(sampleGuardIndex !== -1, 'must skip seeding entirely in sample-data mode — otherwise real cached sessions get mixed into a screenshot/regression fixture run');

	// Must source cachedPaths from the deduplicated view, not the raw cache Map — otherwise two
	// path-spelling variants of the same file in the cache both get queued and double-counted.
	assert.ok(body.includes('this.getDeduplicatedCacheEntries()'),
		'cachedPaths must come from getDeduplicatedCacheEntries(), not Array.from(this.cacheManager.cache.keys()) — the raw keys can contain multiple spellings of the same physical file');

	// Must filter by cutoffMs, not seed the entire (up to 20,000-entry) cache unbounded — the
	// worker pool's concurrency is finite and this queue is a plain FIFO, so an unfiltered seed
	// would let a large cache's old-but-still-valid backlog occupy every worker ahead of the files
	// that actually matter for this refresh, delaying relevant results instead of speeding them up.
	assert.ok(/\.filter\(\(\[, data\]\) => data\.mtime >= cutoffMs\)/.test(body),
		'must filter cache entries to cutoffMs before seeding — an excluded older entry still exists on disk and arrives via normal streaming discovery instead, just not front-loaded ahead of relevant files');

	assert.ok(/seen\.add\(_normalizePathForDedup\(p\)\)/.test(body),
		'must normalize cached paths with _normalizePathForDedup() before adding to `seen`, matching the discovery-side check');

	assert.ok(body.includes('this.detectEditorSource(file)'),
		'must call detectEditorSource() for cache-seeded paths, or the loading UI editor pills will silently miss editors only known from the cache');
	assert.ok(body.includes('queue.push(...cachedPaths)'), 'must push the cached (un-normalized) paths onto the shared queue — downstream stat/parse code needs the real path, not the dedup key');
	assert.ok(body.includes('return cachedPaths.length'), 'must return the seeded count so the caller can fold it into totalDiscovered');
});

// A structural "does the source call getDeduplicatedCacheEntries()" assertion (see the tests
// above) can't tell you the dedup itself is correct — only that something with that name got
// called, and a prior version of this test reimplemented the algorithm locally instead of
// exercising the real one, so a regression in production (e.g. keeping the older entry, or
// dropping normalization) would still have passed. getDeduplicatedCacheEntries() is a private
// method on CopilotTokenTracker, which can't be instantiated outside a full VS Code host (see the
// file header), but the dedup algorithm itself now lives in the shared, side-effect-free
// dedupeByNormalizedKeyKeepGreatest() (src/utils/pathUtils.ts) that getDeduplicatedCacheEntries()
// delegates to — so this calls that exact production function directly.
test('dedupeByNormalizedKeyKeepGreatest() — the production algorithm getDeduplicatedCacheEntries() delegates to — keeps exactly one winner per physical file', () => {
	type MinimalCacheEntry = { mtime: number };
	const cache = new Map<string, MinimalCacheEntry>([
		['C:\\Users\\dev\\.copilot\\session.json', { mtime: 1000 }],
		['c:/Users/dev/.copilot/session.json', { mtime: 2000 }],
		['C:\\Users\\dev\\.claude\\other.json', { mtime: 500 }],
	]);

	const deduped = dedupeByNormalizedKeyKeepGreatest(cache, data => data.mtime, 'win32');
	assert.equal(deduped.length, 2, 'two spelling variants of the same physical file must collapse to one entry');
	const sessionEntry = deduped.find(([, data]) => data.mtime === 2000 || data.mtime === 1000);
	assert.ok(sessionEntry, 'the session.json entry must survive under one of its two spellings');
	assert.equal(sessionEntry![1].mtime, 2000, 'must keep the newer-mtime variant, not an arbitrary/first one');
});

// A persisted snapshot is just parsed JSON — a single malformed/null record must not crash this
// whole pass (which getDeduplicatedCacheEntries() feeds into both the cache-only instant paint and
// the cache-seeded preload queue) the way a bare `data.mtime` dereference on a null entry would.
test('dedupeByNormalizedKeyKeepGreatest() skips a null/undefined entry instead of throwing on getValue()', () => {
	type MinimalCacheEntry = { mtime: number };
	const cache = new Map<string, MinimalCacheEntry | null>([
		['/a.json', null],
		['/b.json', { mtime: 2000 }],
	]);

	const deduped = dedupeByNormalizedKeyKeepGreatest(cache as unknown as Map<string, MinimalCacheEntry>, data => data.mtime, 'linux');
	assert.equal(deduped.length, 1, 'the null entry must be skipped, not thrown on');
	assert.equal(deduped[0][0], '/b.json');
});

// A non-null record with a missing/non-numeric mtime passes the null/undefined guard above, but
// `undefined > validMtime` and `NaN > validMtime` are both false — so if such a record is seen
// first under a normalized key, `!existing` lets it win, and no later, genuinely valid duplicate
// under that same key can ever out-score it. The malformed entry would then be the one instant
// paint and the preload seed both read.
test('dedupeByNormalizedKeyKeepGreatest() does not let a malformed (non-finite) score permanently win its key over a later valid duplicate', () => {
	type MinimalCacheEntry = { mtime: unknown };
	const cache = new Map<string, MinimalCacheEntry>([
		['C:\\Users\\dev\\.copilot\\session.json', { mtime: undefined }],
		['c:/Users/dev/.copilot/session.json', { mtime: 2000 }],
	]);

	const deduped = dedupeByNormalizedKeyKeepGreatest(cache, data => data.mtime as number, 'win32');
	assert.equal(deduped.length, 1, 'the two spellings must still collapse to one entry');
	assert.equal(deduped[0][1].mtime, 2000, 'the malformed entry must not shadow the valid duplicate, regardless of iteration order');
});

test('dedupeByNormalizedKeyKeepGreatest() skips an entry whose score is malformed and every duplicate under its key is also malformed', () => {
	type MinimalCacheEntry = { mtime: unknown };
	const cache = new Map<string, MinimalCacheEntry>([
		['/a.json', { mtime: NaN }],
		['/b.json', { mtime: 2000 }],
	]);

	const deduped = dedupeByNormalizedKeyKeepGreatest(cache, data => data.mtime as number, 'linux');
	assert.equal(deduped.length, 1, 'the malformed-only entry must be dropped rather than surfaced with an unusable score');
	assert.equal(deduped[0][0], '/b.json');
});

test('getDeduplicatedCacheEntries() delegates to the shared dedupeByNormalizedKeyKeepGreatest() helper', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private getDeduplicatedCacheEntries(): [string, SessionFileCache][] {');
	assert.ok(body.includes('_dedupeByNormalizedKeyKeepGreatest(this.cacheManager.cache, data => data.mtime)'),
		'must delegate to the shared, independently-tested dedupeByNormalizedKeyKeepGreatest() helper rather than reimplementing the dedup loop inline');
});

// A structural "does the source call _normalizePathForDedup()" assertion (see the tests above)
// can't tell you the function actually collapses equivalent paths to the same key — only that
// something with that name got called. This proves the actual invariant the dedup fix depends
// on: on a non-Linux platform, a cache-recorded key and a freshly discovered key for the same
// physical file that differ only in drive-letter case or separator style normalize identically,
// so they can never coexist in the `seen` set as two "different" files. normalizePathForDedup()
// itself already has full behavioral coverage in utils-pathUtils.test.ts; this test exists to
// make the tie to *this* PR's dedup contract explicit rather than assumed.
test('normalizePathForDedup() collapses the exact kind of equivalent-path pair the cache/discovery dedup relies on', () => {
	const cacheRecordedKey = normalizePathForDedup('C:\\Users\\dev\\.copilot\\session.json', 'win32');
	const freshlyDiscoveredKey = normalizePathForDedup('c:/Users/dev/.copilot/session.json', 'win32');
	assert.equal(cacheRecordedKey, freshlyDiscoveredKey,
		'a cached path and a freshly discovered path for the same file that differ only in drive-letter case/separator must normalize to the same seen-set key, or the file gets queued and counted twice');
});

test('the constructor chains the OpenCode DB probe onto _cacheLoadPromise only, never onto _cacheFileLoadPromise', () => {
	// _cacheFileLoadPromise must resolve as soon as the on-disk snapshot itself is read, with
	// nothing else chained onto it — renderInstantStatsFromCache() awaits exactly this promise,
	// so if the OpenCode probe (or any other filesystem/DB I/O) were ever chained onto it too,
	// the "instant, no I/O" guarantee of the cache-only first paint would silently regress.
	const fileLoadBlock = sliceBetween(
		EXTENSION_SRC,
		'this._cacheFileLoadPromise = cacheFileLoad.finally(() => {',
		'this._cacheFileLoadPromise = undefined;\n\t\t});'
	);
	assert.ok(!fileLoadBlock.includes('queueMissingOpenCodeDbSessionsFromCache'),
		'_cacheFileLoadPromise must not chain queueMissingOpenCodeDbSessionsFromCache() (or any other I/O) — renderInstantStatsFromCache() depends on this promise resolving with no filesystem/DB work beyond the raw snapshot read');

	// _cacheLoadPromise keeps its original, fuller meaning (used by the real refresh path, which
	// legitimately needs the OpenCode reconciliation done before it starts discovery/preload).
	const fullLoadBlock = sliceBetween(
		EXTENSION_SRC,
		'this._cacheLoadPromise = cacheFileLoad.then(async () => {',
		'this._cacheLoadPromise = undefined;\n\t\t});'
	);
	assert.ok(fullLoadBlock.includes('queueMissingOpenCodeDbSessionsFromCache'),
		'_cacheLoadPromise must still chain queueMissingOpenCodeDbSessionsFromCache() — the real refresh path (which awaits _cacheLoadPromise) needs the OpenCode DB reconciled before discovery/preload starts');
});

test('isDiscoveryUntrustworthyForBackfill() detects the empty-discovery-but-cached-data case (via preloaded OR the raw cache), and lastDiscoveryHadError', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private isDiscoveryUntrustworthyForBackfill(sessionFiles: string[], preloaded: SessionFilePreload[]): boolean {');
	assert.ok(/return this\.sessionDiscovery\.lastDiscoveryHadError\s*\|\|\s*\(sessionFiles\.length === 0 && \(preloaded\.length > 0 \|\| this\.cacheManager\.cache\.size > 0\)\);/.test(body),
		'must detect BOTH the "sessionFiles empty but preloaded non-empty" case AND lastDiscoveryHadError — calculateDailyStats(365, sessionFiles) would otherwise store a truncated/incomplete (but truthy) lastFullDailyStats when only one adapter out of several failed');

	// preloaded alone is not enough: it only holds entries within fileLoadCutoffMs (~30 days), far
	// narrower than this 365-day backfill. A dormant user with real cached data older than that
	// window would have an empty `preloaded` too on a transient empty-discovery run, and this guard
	// must still catch it via the raw cache instead of letting the original bug through.
	assert.ok(/this\.cacheManager\.cache\.size > 0/.test(body),
		'must also treat a non-empty cache as "we have real data" even when none of it made it into the narrower preloaded array');
});

test('_runRefreshCore() skips the one-time full-year chart backfill when discovery is untrustworthy, or this window is a follower', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private async _runRefreshCore(silent: boolean, isLeader: boolean): Promise<DetailedStats | undefined> {');

	const backfillCallIndex = body.indexOf('this.trackFullYearBackfill(this.calculateDailyStats(365, sessionFiles));');
	assert.ok(backfillCallIndex !== -1, '_runRefreshCore() must still perform the one-time full-year backfill call');

	// Tracked (not just detached with a bare `void`) so clearCache() can wait it out — see
	// _pendingFullYearBackfills' own doc comment: this backfill reparses files and calls
	// setCachedSessionData() well after _runRefreshCore()'s own promise has already resolved, so a
	// clear landing during it could otherwise be silently repopulated. Routed through
	// trackFullYearBackfill() (a shared Set, not a single overwritable slot) so a second overlapping
	// backfill from a later leader refresh can't drop this one's tracking.
	assert.ok(backfillCallIndex !== -1,
		'the backfill promise must be tracked via trackFullYearBackfill(), not just fired with a bare `void`, or clearCache() cannot wait for it');

	// calculateDailyStats(365, sessionFiles) reparses every discovered file with no missBudget/
	// follower awareness at all, unlike the regular per-refresh preload just above it (which passes
	// FOLLOWER_MISS_BUDGET for non-leaders). Without the isLeader guard, every follower window's
	// first refresh would launch a full, unbounded reparse of the entire session history in
	// parallel with the leader's own preload — defeating the follower miss-budget stampede
	// protection and the cold-boot cost this PR exists to cut.
	// `currentFullDailyStats` rather than the raw `lastFullDailyStats`: the field is now read through
	// a generation-aware accessor, so a set left behind by a build that was already running when the
	// caches were cleared reads as absent and the backfill runs. The isLeader requirement this test
	// exists for is unchanged.
	assert.ok(/if \(isLeader && !this\.currentFullDailyStats && !this\.chartPanel && !this\.isDiscoveryUntrustworthyForBackfill\(sessionFiles, preloaded\)\) \{/.test(body),
		'the backfill call must also require isLeader — calculateDailyStats(365, ...) has no follower miss-budget of its own, so running it on a follower would reparse the entire session history unbounded, defeating the FOLLOWER_MISS_BUDGET stampede protection used just above it');
});

test('renderInstantStatsFromCache() never overwrites a real refresh that already completed while it was still computing', () => {
	const instantBody = extractBracesBlock(EXTENSION_SRC, 'private async renderInstantStatsFromCache(): Promise<void> {');
	const calcIndex = instantBody.indexOf('await this.calculateDetailedStats(undefined, preloaded)');
	const guardIndex = instantBody.indexOf('if (!this.canPublishInstantPaint(startedAtGeneration)) { return; }');
	const commitIndex = instantBody.indexOf('this.recordDetailedStats(stats, startedAtGeneration);');
	assert.ok(calcIndex !== -1 && guardIndex !== -1 && commitIndex !== -1 && calcIndex < guardIndex && guardIndex < commitIndex,
		'renderInstantStatsFromCache() must re-check whether it may still publish after awaiting calculateDetailedStats and before committing its own results — otherwise a real refresh that finishes first, a window that closed mid-await, or a regression run that started mid-await can be silently overwritten by/resumed into/contaminated by this slower, stale cache-only computation');

	// The checks themselves live in canPublishInstantPaint() (extracted so the added generation
	// check did not push this method over the complexity ceiling), so assert them there.
	const publishGuard = extractBracesBlock(EXTENSION_SRC, 'private canPublishInstantPaint(startedAtGeneration: number): boolean {');
	assert.ok(publishGuard.includes('if (this._hasCompletedRealRefresh || this._disposed || this.isSampleDataModeActive()) { return false; }'),
		'canPublishInstantPaint() must check _hasCompletedRealRefresh, _disposed (dispose() can run during that same await), AND isSampleDataModeActive() (a regression run could start during that same, potentially slow await)');
	assert.ok(publishGuard.includes('isComputedStatsCurrent(startedAtGeneration, this._cacheGeneration)'),
		'canPublishInstantPaint() must also reject a paint the caches were cleared under — _hasCompletedRealRefresh is still false while the clear\'s own refresh is running');

	// The flag must be set as soon as _runRefreshCore()'s own verified result exists — right after
	// its own calculateDetailedStats() resolves — and specifically BEFORE updateStatusBarAndTooltip()
	// publishes it to the UI. Setting it any later (e.g. after the slower, some-awaited/some-network
	// steps like computeAndUploadFluencyScore that follow) would leave a wide window where the real
	// refresh has already redrawn the status bar, but renderInstantStatsFromCache() still sees the
	// flag as false and can overwrite that already-correct UI with its own, older cache-only result.
	// The publication sequence lives in publishRefreshResult() (extracted so the generation can be
	// re-checked at every async boundary); _runRefreshCore() hands its result straight to it, so
	// "immediately after calculateDetailedStats()" spans the two.
	const refreshBody = extractBracesBlock(EXTENSION_SRC, 'private async _runRefreshCore(silent: boolean, isLeader: boolean): Promise<DetailedStats | undefined> {');
	const refreshCalcIndex = refreshBody.indexOf('await this.calculateDetailedStats(undefined, preloaded)');
	const publishIndex = refreshBody.indexOf('await this.publishRefreshResult(');
	assert.ok(refreshCalcIndex !== -1 && publishIndex !== -1 && refreshCalcIndex < publishIndex,
		'_runRefreshCore() must publish its verified result through publishRefreshResult() as soon as calculateDetailedStats() resolves');

	const publishBody = extractBracesBlock(EXTENSION_SRC, 'private async publishRefreshResult(');
	const flagSetIndex = publishBody.indexOf('this._hasCompletedRealRefresh = true;');
	const statusBarIndex = publishBody.indexOf('this.updateStatusBarAndTooltip(detailedStats);');
	assert.ok(flagSetIndex !== -1 && statusBarIndex !== -1 && flagSetIndex < statusBarIndex,
		'publishRefreshResult() must set _hasCompletedRealRefresh before updateStatusBarAndTooltip() (and every slower step after it) — not after the UI is already published');
});

test('reconcilePreloadedAgainstDiscovery() evicts every raw cache key for an unconfirmed path, via the tombstone-aware deleteCachedSessionData()', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private reconcilePreloadedAgainstDiscovery(preloaded: SessionFilePreload[], sessionFiles: string[]): SessionFilePreload[] {');
	assert.ok(body.includes('this.cacheManager.deleteCachedSessionData(rawPath)'),
		'must evict via cacheManager.deleteCachedSessionData() (which tombstones the path), not a plain cache.delete() — a plain delete is silently resurrected by the very next trySaveCacheToStorage(), whose merge starts from whatever is already on disk (see cacheManager-snapshot.test.ts)');
	assert.ok(!/this\.cacheManager\.cache\.delete\(/.test(body),
		'must not touch cacheManager.cache directly — deletions here must always go through the tombstone-aware deleteCachedSessionData()');

	// Must sweep every raw key in the cache that normalizes to an unconfirmed path, compared
	// directly against confirmedKeys — not derived from `preloaded` — so a cache-seeded entry that
	// was too old for the refresh cutoff, or whose stat/parse failed this run (and therefore never
	// reached `preloaded` at all), is confirmed/evicted exactly like a dedup-winner spelling variant
	// would be.
	assert.ok(/for \(const rawPath of Array\.from\(this\.cacheManager\.cache\.keys\(\)\)\)/.test(body),
		'must scan all raw cache keys (not just entries derived from `preloaded`) when evicting unconfirmed entries');
	assert.ok(/if \(!confirmedKeys\.has\(_normalizePathForDedup\(rawPath\)\)\) \{/.test(body),
		'must match raw cache keys directly against confirmedKeys via _normalizePathForDedup(), so an entry that never reached `preloaded` (cutoff-filtered or failed) is evicted too, not only unconfirmed dedup winners');
});

test('_preloadSessionFiles() always schedules clearExpiredCache(), even when this run\'s discovery came back empty', () => {
	const preloadBody = extractBracesBlock(EXTENSION_SRC, 'preloaded: SessionFilePreload[] }> {');
	const cleanupIndex = preloadBody.indexOf('this.cacheManager.clearExpiredCache()');
	const emptyBranchIndex = preloadBody.indexOf('if (sessionFiles.length === 0) {');
	assert.ok(cleanupIndex !== -1 && emptyBranchIndex !== -1 && cleanupIndex < emptyBranchIndex,
		'clearExpiredCache() must be scheduled before the empty-sessionFiles early return, not only on the non-empty path — otherwise a cached entry for a genuinely deleted file never gets pruned on a run where every adapter returned nothing, and can keep being resurrected by a future cache-only instant paint');
});

test('sample-data mode never writes to the shared on-disk cache snapshot: neither the end-of-refresh save nor mid-parse checkpointing', () => {
	const persistBody = extractBracesBlock(EXTENSION_SRC, 'private persistRefreshResult(isLeader: boolean): void {');
	const sampleGuardIndex = persistBody.indexOf('if (this.isSampleDataModeActive()) { return; }');
	const saveIndex = persistBody.indexOf('await this.cacheManager.saveAndAccountForRefresh()');
	assert.ok(sampleGuardIndex !== -1 && saveIndex !== -1 && sampleGuardIndex < saveIndex,
		'persistRefreshResult() must skip its cache save in sample-data mode, before attempting it — a regression/screenshot fixture refresh must never let its fixture data survive on disk past the run, where a later normal boot\'s cache-only instant paint would show it as real stats');

	const preloadBody = extractBracesBlock(EXTENSION_SRC, 'preloaded: SessionFilePreload[] }> {');
	assert.ok(/processed % 25 === 0 && isLeader && !this\.isSampleDataModeActive\(\)/.test(preloadBody),
		'the mid-parse checkpoint (maybeCheckpointCache(), which also writes the shared snapshot directly) must skip sample-data mode too, or it can persist fixture data even when persistRefreshResult() itself is correctly guarded');

	// dispose()'s own shutdown save is a third, independent write path to the shared snapshot,
	// bypassing persistRefreshResult() entirely — it needs the exact same guard. Without it, closing
	// the Extension Development Host while runLocalViewRegression() is still mid-flight (fixture
	// entries already in cacheManager.cache, its own finally block not yet run) would persist
	// fixture data into the developer's real, shared production snapshot.
	const disposeBody = extractBracesBlock(EXTENSION_SRC, 'public dispose(): void {');
	const disposeSampleGuardIndex = disposeBody.indexOf('if (!this.isSampleDataModeActive()) {');
	const disposeSaveIndex = disposeBody.indexOf('await this.trySaveCacheToStorage()');
	assert.ok(disposeSampleGuardIndex !== -1 && disposeSaveIndex !== -1 && disposeSampleGuardIndex < disposeSaveIndex,
		'dispose() must also skip its shutdown trySaveCacheToStorage() call in sample-data mode, same as persistRefreshResult()');
});

test('persistRefreshResult() tracks its detached end-of-refresh save so _runUpdateTokenStats() can await it before releasing the refresh-leader lock', () => {
	const persistBody = extractBracesBlock(EXTENSION_SRC, 'private persistRefreshResult(isLeader: boolean): void {');
	assert.ok(persistBody.includes('this._pendingLeaderSnapshotSave = (async () => {'),
		'must assign the detached save to _pendingLeaderSnapshotSave instead of a bare `void (async () => {...})()` — otherwise nothing can observe when it settles');

	// A second window winning the refresh-leader lock while this window's own end-of-refresh save
	// is still mid-flight can publish its own snapshot first; this window's stale save landing
	// afterward would then merge pre-existing (same-mtime) data back on top of it. Awaiting the
	// tracked save before releasing the lock closes that window.
	const updateBody = extractBracesBlock(EXTENSION_SRC, 'private async _runUpdateTokenStats(silent: boolean): Promise<DetailedStats | undefined> {');
	const finallyIndex = updateBody.indexOf('} finally {');
	const awaitSaveIndex = updateBody.indexOf('await this._pendingLeaderSnapshotSave;');
	const releaseLockIndex = updateBody.indexOf('await this.cacheManager.releaseRefreshLock();');
	assert.ok(finallyIndex !== -1 && awaitSaveIndex !== -1 && releaseLockIndex !== -1,
		'_runUpdateTokenStats() must await _pendingLeaderSnapshotSave before releasing the refresh lock in its finally block');
	assert.ok(finallyIndex < awaitSaveIndex && awaitSaveIndex < releaseLockIndex,
		'must await the pending snapshot save (inside the finally block) before releasing the refresh-leader lock, not after — releasing first would let a second window become leader and publish while this window\'s save is still in flight');
});

test('_runUpdateTokenStats() keeps the refresh-lock heartbeat alive through the end-of-refresh save/checkpoint waits, stopping it only right before release', () => {
	// startRefreshHeartbeat() renews the refresh lock's timestamp every 30s so
	// handleExistingLock()'s 5-minute staleness check doesn't break a lock still legitimately held.
	// Stopping the heartbeat before the awaits above (as an earlier version of this finally block
	// did) freezes that timestamp for their entire duration — a slow enough snapshot write could
	// then let another window break the lock and start its own leader cycle while this window is
	// still mid-save, exactly the stale-snapshot race those awaits exist to prevent.
	const updateBody = extractBracesBlock(EXTENSION_SRC, 'private async _runUpdateTokenStats(silent: boolean): Promise<DetailedStats | undefined> {');
	const finallyIndex = updateBody.indexOf('} finally {');
	const awaitSaveIndex = updateBody.indexOf('await this._pendingLeaderSnapshotSave;');
	const awaitCheckpointIndex = updateBody.indexOf('await this.cacheManager.awaitInFlightCheckpoint();');
	const stopHeartbeatIndices = [...updateBody.matchAll(/this\.stopRefreshHeartbeat\(\);/g)].map(m => m.index!);
	const releaseLockIndex = updateBody.indexOf('await this.cacheManager.releaseRefreshLock();');

	assert.ok(finallyIndex !== -1 && awaitSaveIndex !== -1 && awaitCheckpointIndex !== -1 && releaseLockIndex !== -1,
		'the finally block must still await the pending snapshot save and the in-flight checkpoint before releasing the lock');

	// The leader path's stopRefreshHeartbeat() call must sit strictly after both awaits and
	// strictly before releaseRefreshLock() — not at the very top of the finally block, where it
	// would stop renewing the lock before either wait even starts.
	const leaderStopIndex = stopHeartbeatIndices.find(i => i > awaitCheckpointIndex && i < releaseLockIndex);
	assert.ok(leaderStopIndex !== undefined,
		'stopRefreshHeartbeat() on the leader path must run after awaiting the snapshot save/checkpoint and before releaseRefreshLock() — stopping it any earlier lets the lock go stale while this window is still writing');
	assert.ok(!stopHeartbeatIndices.some(i => i > finallyIndex && i < awaitSaveIndex),
		'stopRefreshHeartbeat() must not run before the end-of-refresh save/checkpoint waits on the leader path');

	// A follower never starts the heartbeat in the first place (startRefreshHeartbeat() no-ops for
	// non-leaders), but the finally block must still stop it unconditionally on that path too, in
	// case this run only became a follower after already having heartbeat state from an earlier
	// leader cycle in the same window.
	assert.ok(stopHeartbeatIndices.some(i => i > releaseLockIndex),
		'the non-leader (else) branch must still call stopRefreshHeartbeat()');
});

test('runLocalViewRegression() evicts its own session files from the cache when it finishes, only when bundled fixtures were used', () => {
	// Skipping the on-disk save (see the sample-data-mode test above) does not stop a regression
	// pass from writing fixture entries into the IN-MEMORY cache — computeRegressionStats() runs
	// the normal preload pipeline, whose getSessionFileDataCached() unconditionally calls
	// setCachedSessionData() regardless of sample mode. Without eviction here, the very next
	// normal refresh in this same session (no restart needed) would seed/paint from those fixture
	// entries via getDeduplicatedCacheEntries(), which reads the cache directly.
	const body = extractBracesBlock(EXTENSION_SRC, 'public async runLocalViewRegression(): Promise<void> {');

	assert.ok(body.includes('regressionSessionFiles = setup.sessionFiles;'),
		'must capture the exact session files (real or bundled-fixture) the regression pass used');
	assert.ok(body.includes('usedBundledFixtures = setup.usedBundledFixtures;'),
		'must capture whether this run actually used bundled fixtures (vs. real discovered sessions)');

	const finallyIndex = body.indexOf('} finally {');
	const fixtureGuardIndex = body.indexOf('if (usedBundledFixtures) {');
	const evictCallIndex = body.indexOf('await this.evictRegressionSessionFilesFromCache(regressionSessionFiles);');
	assert.ok(finallyIndex !== -1 && fixtureGuardIndex !== -1 && evictCallIndex !== -1
		&& fixtureGuardIndex > finallyIndex && evictCallIndex > fixtureGuardIndex,
		'must evict the regression run\'s own session files from the cache in the finally block, so it always runs — even if the regression pass itself throws');

	// The whole sweep must be gated on usedBundledFixtures — when a developer runs this locally
	// on a machine WITH real session data, regressionSessionFiles is that real, entire discovered
	// set. Evicting it unconditionally isn't just "one avoidable reparse": deleteCachedSessionData()
	// tombstones the path, and buildMergedSnapshotEntries() excludes every tombstoned path from
	// every subsequent save — so a normal refresh's checkpoint/publish landing before the next full
	// re-parse completes would wipe those real sessions from the shared on-disk snapshot too.
	assert.ok(body.includes('if (usedBundledFixtures) {\n\t\t\t\tawait this.evictRegressionSessionFilesFromCache(regressionSessionFiles);\n\t\t\t}'),
		'the eviction call must only run when usedBundledFixtures is true — evicting real discovered sessions risks permanently losing them from the shared snapshot, not just a harmless in-memory reparse');
});

// deleteCachedSessionData() only tombstones in memory. A stale on-disk snapshot entry from a run
// predating the sample-mode save guards (or a mid-parse checkpoint that raced this eviction) would
// otherwise sit untouched on disk until some unrelated later save happens to occur — and if the
// Extension Development Host is closed before that, the next boot's instant paint loads and shows
// the fixture data as real usage.
test('evictRegressionSessionFilesFromCache() sweeps by normalized key and persists the tombstones to the shared snapshot', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private async evictRegressionSessionFilesFromCache(regressionSessionFiles: string[]): Promise<void> {');

	// Must sweep by normalized key, not the exact raw strings setupRegressionSessionFiles()
	// returned — otherwise a same-file spelling variant already sitting in the cache under a
	// different raw key (case/separator) survives this eviction and is still readable by the very
	// next getDeduplicatedCacheEntries() call.
	assert.ok(/for \(const rawPath of Array\.from\(this\.cacheManager\.cache\.keys\(\)\)\)/.test(body),
		'must scan all raw cache keys, not just the exact regressionSessionFiles strings, when evicting');
	assert.ok(/regressionKeys\.has\(_normalizePathForDedup\(rawPath\)\)/.test(body),
		'must match raw cache keys against regressionKeys via _normalizePathForDedup(), so a differently-cased/separated duplicate of a regression file is evicted too');

	const evictionIndex = body.indexOf('this.cacheManager.deleteCachedSessionData(rawPath);');
	const evictedAnyIndex = body.indexOf('evictedAny = true;');
	const saveIndex = body.indexOf('await this.trySaveCacheToStorage();');
	assert.ok(evictionIndex !== -1 && evictedAnyIndex !== -1 && saveIndex !== -1
		&& evictedAnyIndex > evictionIndex && saveIndex > evictedAnyIndex,
		'must persist the tombstones (via trySaveCacheToStorage()) after evicting fixture entries, so a stale on-disk copy from before this eviction existed does not linger until some other save happens to occur');

	const guardIndex = body.indexOf('if (evictedAny && !this.isSampleDataModeActive()) {');
	assert.ok(guardIndex !== -1 && guardIndex > evictedAnyIndex && guardIndex < saveIndex,
		'the persist call must be gated on both having actually evicted something and sample mode being confirmed off again, not run unconditionally');
});

test('setupRegressionSessionFiles() reports whether it fell back to bundled fixtures vs. using real discovered sessions', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'usedBundledFixtures: boolean }> {');
	assert.ok(body.includes('return { sessionFiles, dataSourceLabel: defaultLabel, usedBundledFixtures: false };'),
		'must report usedBundledFixtures: false on the real-session-data path (sessionFiles.length > 0)');
	assert.ok(body.includes("return { sessionFiles, dataSourceLabel: `bundled sample data (${sampleDir})`, usedBundledFixtures: true };"),
		'must report usedBundledFixtures: true only on the bundled-fixture fallback path');
});

test('clearCache() waits for in-flight deferred parses before clearing, so a straggler cannot repopulate the cache it just emptied', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'public async clearCache(): Promise<void> {');

	const awaitDeferredIndex = body.indexOf('await this.awaitAllDeferredParses();');
	const clearIndex = body.indexOf('this.cacheManager.clearAllCachedData();');
	assert.ok(awaitDeferredIndex !== -1 && clearIndex !== -1 && awaitDeferredIndex < clearIndex,
		'must await every deferred (backgrounded) parse still running from an earlier refresh before clearing — otherwise one finishing after the clear could call setCachedSessionData() and silently repopulate the cache this command just emptied');

	// A pre-existing refresh that hasn't deferred anything yet — its workers are still on their
	// ordinary (non-timed-out) pass over files — is invisible to awaitAllDeferredParses(), since
	// that only tracks parses already registered as deferred. Awaiting the whole in-flight run
	// first closes that gap: only after it settles (or defers work of its own, which the
	// subsequent awaitAllDeferredParses() then covers) is it safe to read _deferredSessionPreloadPromises.
	const preClearRefreshIndex = body.indexOf('const preClearRefresh = this._updateTokenStatsInFlight;');
	assert.ok(preClearRefreshIndex !== -1 && preClearRefreshIndex < awaitDeferredIndex,
		'must wait out any pre-existing in-flight updateTokenStats() run before awaiting deferred parses — otherwise a foreground worker still on its ordinary (non-deferred) pass over a file could call setCachedSessionData() after the clear');

	// awaitAllDeferredParses() can await real, I/O-bound parses, which yields to the event loop for
	// real time — long enough for an unrelated timer-triggered refresh to start and populate
	// _updateTokenStatsInFlight with a run a single, non-looped pass would never have captured. Both
	// waits must therefore sit inside a loop that only exits once one full pass finds nothing left
	// outstanding, not run once each.
	const loopMatch = body.match(/while\s*\(\s*this\._updateTokenStatsInFlight\s*\|\|\s*this\._deferredSessionPreloadPromises\.size > 0/);
	const loopIndex = loopMatch?.index ?? -1;
	assert.ok(loopIndex !== -1 && loopIndex < preClearRefreshIndex && preClearRefreshIndex < awaitDeferredIndex,
		'must loop the in-flight-refresh wait and awaitAllDeferredParses() together until a full pass finds nothing left to wait for — a single pass of each can miss a refresh that starts while the other is still awaiting real I/O');

	// Every full-year chart backfill (see _pendingFullYearBackfills' own doc comment) is a third
	// source invisible to both the in-flight-refresh wait and awaitAllDeferredParses(): one call
	// site is dispatched fire-and-forget only after the refresh that started it has already
	// returned, the other runs on a separate foreground call chain. The loop condition and the loop
	// body must both account for every such backfill (a Set, not a single overwritable slot), or a
	// backfill still running at the moment of a clear could keep writing pre-clear entries into the
	// cache this clears.
	assert.ok(/while\s*\([^)]*this\._pendingFullYearBackfills\.size > 0/.test(body),
		'the loop condition must also check _pendingFullYearBackfills.size > 0, or the loop could exit while a backfill is still running');
	const pendingBackfillWaitIndex = body.indexOf('const pendingBackfills = [...this._pendingFullYearBackfills];');
	assert.ok(pendingBackfillWaitIndex !== -1 && preClearRefreshIndex < pendingBackfillWaitIndex && pendingBackfillWaitIndex < awaitDeferredIndex,
		'must await every pending full-year backfill inside the loop, between the in-flight-refresh wait and awaitAllDeferredParses()');
	assert.ok(body.indexOf('await Promise.all(pendingBackfills.map(backfill => backfill.catch(() => undefined)));', pendingBackfillWaitIndex) !== -1,
		'must await all snapshotted backfills together, not just the first one');
});

test('every call site of calculateDailyStats() is routed through trackFullYearBackfill(), not called bare', () => {
	// Regression guard for a review finding on this exact tracking mechanism: the Chart view's
	// showChart()/refreshChartPanel() (each defaulting daysBack to 365 via a bare, argument-less
	// call) and computeRegressionStats() all called calculateDailyStats() directly, invisible to
	// _pendingFullYearBackfills and therefore to clearCache()'s wait loop — the same class of gap
	// the leader-refresh and Efficiency-view call sites were already fixed for. Every call site,
	// present and future, must go through the shared tracking helper instead of being fixed up
	// one at a time as each new gap is found.
	const lines = EXTENSION_SRC.split('\n');
	const offenders: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('*')) { continue; }
		if (!trimmed.includes('this.calculateDailyStats(')) { continue; }
		if (!trimmed.includes('this.trackFullYearBackfill(this.calculateDailyStats(')) {
			offenders.push(trimmed);
		}
	}
	assert.deepEqual(offenders, [],
		'every this.calculateDailyStats(...) call site must be wrapped as this.trackFullYearBackfill(this.calculateDailyStats(...)), or clearCache() cannot wait it out');
});

test('deferSessionPreloadRefresh() tracks each deferred parse\'s settle promise for awaitAllDeferredParses() to await, and untracks it once settled', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private deferSessionPreloadRefresh(sessionFile: string, processing: Promise<void>, release: () => void): void {');

	assert.ok(body.includes('this._deferredSessionPreloadPromises.set(sessionFile, settled);'),
		'must register this parse\'s settle promise for awaitAllDeferredParses() to observe');
	assert.ok(body.includes('this._deferredSessionPreloadPromises.delete(sessionFile);'),
		'must untrack the promise once it settles (inside the .finally()), or the map would grow unboundedly across a long session');
});
