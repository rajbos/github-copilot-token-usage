import test from 'node:test';
import * as assert from 'node:assert/strict';

import { getLoadingHtmlBody, getLoadingHtmlScript } from '../../src/loadingHtml';

test('loading timer starts from the supplied analysis start time', () => {
	const startedAtMs = 1_725_000_123_456;

	assert.match(getLoadingHtmlScript(startedAtMs), /var t0 = 1725000123456;/);
	assert.match(getLoadingHtmlScript(startedAtMs), /updateElapsed\(\);\s+setInterval\(updateElapsed, 1000\);/);
	assert.match(getLoadingHtmlBody('nonce', undefined, startedAtMs), /var t0 = 1725000123456;/);
});

/**
 * Runs the generated loading script against a stub DOM and returns a handle for
 * posting the messages the extension host sends, plus a reader for what the user
 * would see. The script is plain ES5 against `document`/`window`, so a handful of
 * stubs are enough to exercise the real behaviour rather than its source text.
 */
function runLoadingScript(): {
	post: (msg: Record<string, unknown>) => void;
	pct: () => string;
	barWidth: () => string;
	subtitle: () => string;
	text: (id: string) => string;
} {
	const makeEl = () => ({
		textContent: '',
		innerHTML: '',
		style: {} as Record<string, string>,
		className: '',
		classList: { add() { /* unused */ }, remove() { /* unused */ } },
		querySelector: () => makeEl(),
		appendChild() { /* unused */ },
	});
	const els = new Map<string, ReturnType<typeof makeEl>>();
	const listeners: ((ev: { data: unknown }) => void)[] = [];

	const sandbox = {
		document: {
			getElementById(id: string) {
				if (!els.has(id)) { els.set(id, makeEl()); }
				return els.get(id);
			},
			createElement: () => makeEl(),
		},
		window: { addEventListener: (_: string, fn: (ev: { data: unknown }) => void) => listeners.push(fn) },
		setInterval: () => 0,
		Date,
	};

	// eslint-disable-next-line no-new-func
	new Function(...Object.keys(sandbox), getLoadingHtmlScript())(...Object.values(sandbox));

	const read = (id: string, field: 'textContent') => els.get(id)?.[field] ?? '';
	return {
		post: (msg) => listeners.forEach(fn => fn({ data: msg })),
		pct: () => read('pct', 'textContent'),
		barWidth: () => els.get('prog-fill')?.style.width ?? '',
		subtitle: () => read('subtitle', 'textContent'),
		text: (id) => read(id, 'textContent'),
	};
}

test('computing step parks at 96% when the caller reports no sub-step progress', () => {
	const ui = runLoadingScript();

	ui.post({ command: 'loadingStep', step: 'computing' });

	assert.equal(ui.pct(), '96%');
	assert.equal(ui.barWidth(), '96%');
	assert.equal(ui.subtitle(), 'Computing statistics...');
});

test('computing step follows a caller-driven percentage and label', () => {
	const ui = runLoadingScript();

	ui.post({ command: 'loadingStep', step: 'computing', percentage: 88, label: 'Aggregating daily activity…' });
	assert.equal(ui.pct(), '88%');
	assert.equal(ui.barWidth(), '88%');
	assert.equal(ui.subtitle(), 'Aggregating daily activity…');

	ui.post({ command: 'loadingStep', step: 'computing', percentage: 96, label: 'Reading session signals…' });
	assert.equal(ui.pct(), '96%');
	assert.equal(ui.subtitle(), 'Reading session signals…');
});

test('computing percentage never walks backwards on an out-of-order sub-step', () => {
	const ui = runLoadingScript();

	ui.post({ command: 'loadingStep', step: 'computing', percentage: 96, label: 'Reading session signals…' });
	ui.post({ command: 'loadingStep', step: 'computing', percentage: 88, label: 'Aggregating daily activity…' });

	assert.equal(ui.pct(), '96%', 'bar must not retreat');
	assert.equal(ui.barWidth(), '96%');
});

test('parsing progress drives the bar, scaled into its own lower band', () => {
	const ui = runLoadingScript();

	ui.post({ command: 'loadingProgress', completed: 120, total: 400, percentage: 30 });

	// Parsing owns 0-85% so the compute sub-steps above it always move forward.
	assert.equal(ui.pct(), '26%');
	assert.equal(ui.barWidth(), '26%');
	assert.match(ui.subtitle(), /^Parsing session 120/);
});

test('the first compute sub-step does not drop the bar after parsing finishes', () => {
	const ui = runLoadingScript();

	// The Efficiency prime always ends its file walk on a 100% tick...
	ui.post({ command: 'loadingProgress', completed: 400, total: 400, percentage: 100 });
	assert.equal(ui.pct(), '85%');

	// ...so the first compute sub-step must still be an increase, not a jump backwards.
	ui.post({ command: 'loadingStep', step: 'computing', percentage: 88, label: 'Aggregating daily activity…' });
	assert.equal(ui.pct(), '88%');
	assert.equal(ui.barWidth(), '88%');
});

test('a host that sends no compute sub-steps still moves forward at its fixed 96%', () => {
	const ui = runLoadingScript();

	ui.post({ command: 'loadingProgress', completed: 400, total: 400, percentage: 100 });
	ui.post({ command: 'loadingStep', step: 'computing' });

	assert.equal(ui.pct(), '96%');
});

test('a compute sub-step posted before parsing would freeze the bar for the whole parse', () => {
	const ui = runLoadingScript();

	// Regression guard for the shape of the original bug, at a different number: a host that
	// announces a compute sub-step *before* the file walk pins the monotonic bar above
	// parsing's band, and every subsequent parse tick is then clamped away.
	ui.post({ command: 'loadingStep', step: 'computing', percentage: 88, label: 'Aggregating daily activity…' });
	ui.post({ command: 'loadingProgress', completed: 100, total: 400, percentage: 25 });
	ui.post({ command: 'loadingProgress', completed: 400, total: 400, percentage: 100 });

	assert.equal(ui.pct(), '88%', 'the bar cannot move during the parse once pinned above its band');

	// Which is why collectEfficiencyInputs() posts no compute step until the walk is done:
	// left to itself, parsing climbs through its own band.
	const fresh = runLoadingScript();
	fresh.post({ command: 'loadingProgress', completed: 100, total: 400, percentage: 25 });
	assert.equal(fresh.pct(), '21%');
	fresh.post({ command: 'loadingProgress', completed: 400, total: 400, percentage: 100 });
	assert.equal(fresh.pct(), '85%');
});

test('parsing follows a falling percentage from a growing discovery total', () => {
	const ui = runLoadingScript();

	// _preloadSessionFiles reports against a discovery total that grows as adapter batches
	// arrive, so an early batch legitimately reads 1/1 and a later tick 2/400. Clamping
	// inside the parsing phase would freeze the bar at that high-water mark.
	ui.post({ command: 'loadingProgress', completed: 1, total: 1, percentage: 100 });
	assert.equal(ui.pct(), '85%');

	ui.post({ command: 'loadingProgress', completed: 2, total: 400, percentage: 1 });
	assert.equal(ui.pct(), '1%', 'the bar must follow parsing down rather than stick at 85%');

	ui.post({ command: 'loadingProgress', completed: 200, total: 400, percentage: 50 });
	assert.equal(ui.pct(), '43%');
});

test('a late parsing tick cannot drag the bar back below a compute sub-step', () => {
	const ui = runLoadingScript();

	ui.post({ command: 'loadingStep', step: 'computing', percentage: 92, label: 'Analysing usage patterns…' });
	// A concurrent background refresh shares this channel and restarts its own file walk.
	ui.post({ command: 'loadingProgress', completed: 10, total: 400, percentage: 3 });

	assert.equal(ui.pct(), '92%', 'bar must not follow the unrelated refresh backwards');
	assert.equal(ui.barWidth(), '92%');
});

test('a fresh discovering step resets the bar/checklist state left behind by a superseded run', () => {
	// A panel a superseded run left registered for its replacement (see isRefreshSuperseded()
	// callers in extension.ts) keeps this exact script instance running rather than getting a
	// fresh getLoadingHtml() paint — so the replacement's own 'discovering' message is the only
	// signal this script gets that a new refresh has started, and must reset everything the old
	// run advanced. Without it, the old run's clamped `computing`/`barPct` would hold the bar at a
	// stale high percentage straight through the new run's own early parsing ticks.
	const ui = runLoadingScript();

	// Drive the old run through discovery and parsing first, so both step counters (sc-discover's
	// "(N found)" and sc-parse's "(completed/total)") have real leftover text to reset, not just
	// their initial empty state.
	ui.post({ command: 'loadingStep', step: 'parsing', total: 500, editors: [] });
	assert.equal(ui.text('sc-discover'), '(500 found)');
	ui.post({ command: 'loadingProgress', completed: 250, total: 500, percentage: 50 });
	assert.equal(ui.text('sc-parse'), '(250/500)');
	ui.post({ command: 'loadingStep', step: 'computing', percentage: 92, label: 'Analysing usage patterns…' });
	assert.equal(ui.pct(), '92%');

	ui.post({ command: 'loadingStep', step: 'discovering' });
	assert.equal(ui.pct(), '–', 'must reset to the initial "not started" display, not stay clamped at the old run\'s percentage');
	assert.equal(ui.subtitle(), 'Discovering session files...');
	assert.equal(ui.text('sc-discover'), '', 'the old run\'s "(N found)" count must not linger on the fresh discovering screen');
	assert.equal(ui.text('sc-parse'), '', 'the old run\'s "(completed/total)" count must not linger on the fresh discovering screen');

	// The critical behavioral check: a real, low parsing percentage from the new run must now be
	// able to render as low, instead of being clamped to (or above) the old run's 92%.
	ui.post({ command: 'loadingProgress', completed: 10, total: 400, percentage: 3 });
	assert.equal(ui.pct(), '3%', 'a fresh run\'s own early parsing tick must not be clamped by the superseded run\'s compute percentage');
});
