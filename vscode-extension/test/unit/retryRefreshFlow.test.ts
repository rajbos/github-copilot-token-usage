/**
 * Regression guard for the loading-failure/retry flow added in response to PR #2097's Copilot
 * review: a refresh that genuinely fails (updateTokenStats() resolves to undefined and the run
 * was not superseded by a newer one) must replace a loading panel with a real failure/retry page
 * instead of leaving it frozen forever, and clicking that page's retry button must re-enter the
 * loading screen (with real progress) rather than sit on the stale error page with no feedback
 * until the retry finishes.
 *
 * This isn't a runtime test (instantiating `CopilotTokenTracker` requires a full VS Code host —
 * see instantCacheBoot.test.ts for the same constraint), so instead it asserts structural
 * invariants directly on the source, the same way instantCacheBoot.test.ts does for the boot path.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractBracesBlock } from './sourceStructureTestHelpers';

const EXTENSION_SRC_PATH = path.join(__dirname, '../../../../src/extension.ts');
const EXTENSION_SRC = fs.readFileSync(EXTENSION_SRC_PATH, 'utf8');

/**
 * Index of the "stay on the loading screen, a superseded run isn't a genuine failure" guard,
 * tolerant of whitespace/formatting differences (unlike a plain `indexOf` on an exact source
 * string) since this exact statement shape is checked in more than one place below.
 */
function indexOfSupersededGuard(body: string): number {
	const match = body.match(/if\s*\(\s*!stats\s*&&\s*this\.isRefreshSuperseded\(startedAtGeneration\)\s*\)\s*\{\s*return;\s*\}/);
	return match?.index ?? -1;
}

test('getRefreshFailedHtml() wires its retry button to post retryRefresh', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private getRefreshFailedHtml(webview: vscode.Webview): string {');
	assert.ok(body.includes("command: 'retryRefresh'"),
		"the retry button must postMessage({ command: 'retryRefresh' }) — posting 'refresh' instead would skip the loading screen loadDetailsIntoPanel()/loadEnvironmentalIntoPanel() show while retrying");
});

test('loadDetailsIntoPanel() shows the loading screen before awaiting, and the failure page only on a genuine (non-superseded) failure', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private async loadDetailsIntoPanel(panel: vscode.WebviewPanel): Promise<void> {');

	const loadingHtmlIndex = body.indexOf('panel.webview.html = this.getLoadingHtml(');
	const awaitIndex = body.indexOf('await this.updateTokenStats()');
	assert.ok(loadingHtmlIndex !== -1 && awaitIndex !== -1 && loadingHtmlIndex < awaitIndex,
		'must paint the loading screen before awaiting updateTokenStats(), or a retry gives no visible feedback until it resolves');

	// A superseded run (a newer refresh already bumped the generation) must return without
	// touching the panel — the replacement run owns resolving it, not this stale one.
	const supersededGuardIndex = indexOfSupersededGuard(body);
	assert.ok(supersededGuardIndex !== -1 && awaitIndex < supersededGuardIndex,
		'must check isRefreshSuperseded() after awaiting updateTokenStats(), before ever treating a missing result as a genuine failure');

	const failureHtmlIndex = body.indexOf('panel.webview.html = this.getRefreshFailedHtml(panel.webview);');
	assert.ok(failureHtmlIndex !== -1 && supersededGuardIndex < failureHtmlIndex,
		'must render getRefreshFailedHtml() only after the superseded check has already let a stale failure through');

	// The loading-registry bookkeeping must be cleared once resolved one way or the other,
	// otherwise a panel that failed (or succeeded) stays registered for resolveStuckLoadingPanelsAsFailed()
	// to hit again on a later, unrelated failure. Searched from supersededGuardIndex: an earlier
	// occurrence also runs defensively in the `this.detailsPanel !== panel` branch above (a stale,
	// already-replaced panel), which is a separate code path this assertion isn't about.
	const registryClearIndex = body.indexOf('this._refreshLoadingPanels.delete(panel);', supersededGuardIndex);
	assert.ok(registryClearIndex !== -1 && supersededGuardIndex < registryClearIndex && registryClearIndex < failureHtmlIndex,
		'must remove the panel from _refreshLoadingPanels before rendering the failure page, once the run is confirmed to actually belong to this call');

	// Once past the superseded check, a successful (or genuinely failed) result can still have
	// already been handled elsewhere: publishRefreshResult()'s own non-silent render already
	// deletes this same panel from the registry as part of the very updateTokenStats() call this
	// method itself awaited, and a genuine failure is instead resolved by
	// resolveStuckLoadingPanelsAsFailed(). Re-rendering here regardless would overwrite already-
	// current content (including any UI state the user changed while evaluateAndSurfaceInsights()
	// awaited an interactive insight toast) for no benefit.
	const alreadyHandledGuardIndex = body.indexOf('if (!this._refreshLoadingPanels.has(panel)) {');
	assert.ok(alreadyHandledGuardIndex !== -1 && supersededGuardIndex < alreadyHandledGuardIndex && alreadyHandledGuardIndex < registryClearIndex,
		'must skip taking ownership of the render when the panel was already removed from _refreshLoadingPanels by someone else, checked after the superseded guard and before claiming the panel for this call\'s own render');
});

test('loadEnvironmentalIntoPanel() mirrors loadDetailsIntoPanel()\'s loading/failure sequencing', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private async loadEnvironmentalIntoPanel(panel: vscode.WebviewPanel): Promise<void> {');

	const loadingHtmlIndex = body.indexOf('panel.webview.html = this.getLoadingHtml(');
	const awaitIndex = body.indexOf('await this.updateTokenStats()');
	const supersededGuardIndex = indexOfSupersededGuard(body);
	const failureHtmlIndex = body.indexOf('panel.webview.html = this.getRefreshFailedHtml(panel.webview);');

	assert.ok(loadingHtmlIndex !== -1 && awaitIndex !== -1 && supersededGuardIndex !== -1 && failureHtmlIndex !== -1,
		'loadEnvironmentalIntoPanel() must show the loading screen, await a refresh, guard against a superseded run, and fall back to the failure page — same as loadDetailsIntoPanel()');
	assert.ok(loadingHtmlIndex < awaitIndex && awaitIndex < supersededGuardIndex && supersededGuardIndex < failureHtmlIndex,
		'loadEnvironmentalIntoPanel() must keep the same ordering as loadDetailsIntoPanel(): paint loading, await, check superseded, then (only then) render the failure page');

	// Same already-handled guard as loadDetailsIntoPanel() — see that test's own rationale.
	const registryClearIndex = body.indexOf('this._refreshLoadingPanels.delete(panel);', supersededGuardIndex);
	const alreadyHandledGuardIndex = body.indexOf('if (!this._refreshLoadingPanels.has(panel)) {');
	assert.ok(alreadyHandledGuardIndex !== -1 && registryClearIndex !== -1 &&
		supersededGuardIndex < alreadyHandledGuardIndex && alreadyHandledGuardIndex < registryClearIndex,
		'must skip taking ownership of the render when the panel was already removed from _refreshLoadingPanels by someone else');
});

test('the Details panel message handler routes retryRefresh to loadDetailsIntoPanel(panel), not plain refreshDetailsPanel()', () => {
	const body = extractBracesBlock(EXTENSION_SRC, "this.detailsPanel.webview.onDidReceiveMessage(async (message) => {");
	const retryCaseIndex = body.indexOf("case 'retryRefresh':");
	assert.notEqual(retryCaseIndex, -1, "Details panel message handler must have a 'retryRefresh' case");
	const nextBreakIndex = body.indexOf('break;', retryCaseIndex);
	const retryCaseBody = body.slice(retryCaseIndex, nextBreakIndex);
	assert.ok(retryCaseBody.includes('this.loadDetailsIntoPanel(panel)'),
		"'retryRefresh' must call loadDetailsIntoPanel(panel) so retrying re-enters the loading screen — routing it to refreshDetailsPanel() instead would leave the failure page up with no feedback until the retry finishes");
});

test('the Environmental panel message handler routes retryRefresh to loadEnvironmentalIntoPanel(panel)', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'this.environmentalPanel.webview.onDidReceiveMessage(async (message) => {');
	const retryBranchIndex = body.indexOf("message.command === 'retryRefresh'");
	assert.notEqual(retryBranchIndex, -1, "Environmental panel message handler must handle 'retryRefresh'");
	const branchBody = body.slice(retryBranchIndex);
	assert.ok(branchBody.includes('this.loadEnvironmentalIntoPanel(panel)'),
		"'retryRefresh' must call loadEnvironmentalIntoPanel(panel) so retrying re-enters the loading screen");
});

test('resolveStuckLoadingPanelsAsFailed() installs the failure page on every registered panel and clears the registry', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private resolveStuckLoadingPanelsAsFailed(): void {');
	assert.ok(body.includes('for (const panel of this._refreshLoadingPanels)'),
		'must iterate every panel still registered as waiting on the failed refresh, not just one');
	assert.ok(body.includes('panel.webview.html = this.getRefreshFailedHtml(panel.webview);'),
		'must install the failure/retry page on each stuck panel — otherwise a genuinely failed refresh leaves them frozen on the loading screen forever');
	const failureAssignIndex = body.indexOf('panel.webview.html = this.getRefreshFailedHtml(panel.webview);');
	const clearIndex = body.indexOf('this._refreshLoadingPanels.clear();');
	assert.ok(clearIndex !== -1 && failureAssignIndex < clearIndex,
		'must clear _refreshLoadingPanels only after every panel in it has been resolved with the failure page');
});

test('updateDetailsPanelIfOpen() falls back to the failure page if rendering real content throws', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private updateDetailsPanelIfOpen(detailedStats: DetailedStats, silent: boolean): void {');

	// The panel is removed from _refreshLoadingPanels (and _detailsPanelIsLoading cleared) before
	// the render is attempted, so resolveStuckLoadingPanelsAsFailed() can no longer find it if that
	// render throws — this method must handle its own failure instead of relying on that fallback.
	const registryClearIndex = body.indexOf('this._refreshLoadingPanels.delete(this.detailsPanel);');
	const tryIndex = body.indexOf('try {');
	const renderIndex = body.indexOf('this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, detailedStats);');
	const catchFailureHtmlIndex = body.indexOf('this.detailsPanel.webview.html = this.getRefreshFailedHtml(this.detailsPanel.webview);');
	assert.ok(registryClearIndex !== -1 && tryIndex !== -1 && renderIndex !== -1 && catchFailureHtmlIndex !== -1,
		'must remove the panel from the loading registry, then attempt the real render inside a try, with a getRefreshFailedHtml() fallback in the catch');
	assert.ok(registryClearIndex < tryIndex && tryIndex < renderIndex && renderIndex < catchFailureHtmlIndex,
		'the failure fallback must run after a real render throws, not before or in place of attempting it');
});

test('updateEnvironmentalPanelIfOpen() falls back to the failure page if rendering real content throws', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private updateEnvironmentalPanelIfOpen(detailedStats: DetailedStats, silent: boolean): void {');

	const registryClearIndex = body.indexOf('this._refreshLoadingPanels.delete(this.environmentalPanel);');
	const tryIndex = body.indexOf('try {');
	const renderIndex = body.indexOf('this.environmentalPanel.webview.html = this.getEnvironmentalHtml(this.environmentalPanel.webview, detailedStats);');
	const catchFailureHtmlIndex = body.indexOf('this.environmentalPanel.webview.html = this.getRefreshFailedHtml(this.environmentalPanel.webview);');
	assert.ok(registryClearIndex !== -1 && tryIndex !== -1 && renderIndex !== -1 && catchFailureHtmlIndex !== -1,
		'must remove the panel from the loading registry, then attempt the real render inside a try, with a getRefreshFailedHtml() fallback in the catch');
	assert.ok(registryClearIndex < tryIndex && tryIndex < renderIndex && renderIndex < catchFailureHtmlIndex,
		'the failure fallback must run after a real render throws, not before or in place of attempting it');
});
