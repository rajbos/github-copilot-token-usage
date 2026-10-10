import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// The view registry helpers are plain CommonJS developer tooling under the
// visual-view-diff skill, outside the extension's TypeScript program, so they
// are loaded by path. Ids from this registry become file names and temp paths,
// and the merged registry decides what the baseline side of a diff renders,
// which is why both are pinned down here.
const requireFromHere = createRequire(__filename);

function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, '.github', 'skills', 'visual-view-diff', 'lib', 'config.js'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the repo root from ${__dirname}`);
}

const REPO_ROOT = findRepoRoot();
const SKILL_DIR = path.join(REPO_ROOT, '.github', 'skills', 'visual-view-diff');

type State = { id: string; title?: string; steps?: unknown[]; expect?: string; currentOnly?: boolean };
type View = { id: string; title?: string; bundle?: string; global?: string; fixture?: string; globals?: Record<string, unknown>; enabled?: boolean; states?: State[]; currentOnly?: boolean; fixtureDir?: string };
type Registry = { defaults?: Record<string, unknown>; views: View[] };

type Dirs = { baseFixtureDir: string; currentFixtureDir: string };

const config = requireFromHere(path.join(SKILL_DIR, 'lib', 'config.js')) as {
	readConfig: (skillDir: string, configPath?: string) => Registry;
	validateRegistry: (registry: Registry) => Registry;
	baselineRegistry: (current: Registry, base: Registry | null, dirs: Dirs) => Registry;
	ID_PATTERN: RegExp;
};

const harness = requireFromHere(path.join(SKILL_DIR, 'lib', 'harness.js')) as {
	buildPageHtml: (options: { globalName: string; fixture: unknown; theme: string; bundlePath: string; repoRoot: string; extraGlobals?: Record<string, unknown> }) => string;
};

const DIRS: Dirs = { baseFixtureDir: '/base/fixtures', currentFixtureDir: '/current/fixtures' };

function registry(views: View[]): Registry {
	return { defaults: { viewport: { width: 1280, height: 900 }, fullPage: true, settleMs: 100 }, views };
}

test('the committed registry validates', () => {
	const committed = config.readConfig(SKILL_DIR);
	assert.ok(committed.views.length > 0);
	assert.ok(committed.views.some((v) => (v.states || []).length > 0), 'at least one view declares states');
	const dashboard = committed.views.find((v) => v.id === 'dashboard');
	assert.equal(dashboard?.enabled, undefined, 'the dashboard fixture renders by default');
	assert.equal(dashboard?.states?.length, 5, 'all dashboard modes are covered');
	assert.ok(dashboard?.globals?.__DASHBOARD_CONFIG__, 'the dashboard renders both backend tabs');
	const fixture = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'fixtures', 'dashboard.json'), 'utf8'));
	assert.ok(fixture.personal && fixture.team?.members?.length > 0, 'the dashboard renders real-shaped synthetic data');
});

test('the render harness injects additional panel globals without allowing script markup through', () => {
	const html = harness.buildPageHtml({
		globalName: '__INITIAL_DASHBOARD__',
		fixture: {},
		theme: 'dark',
		bundlePath: path.join(SKILL_DIR, 'dist', 'dashboard.js'),
		repoRoot: REPO_ROOT,
		extraGlobals: { __DASHBOARD_CONFIG__: { teamServerUrl: '</script><script>alert(1)</script>' } },
	});
	assert.match(html, /window\["__DASHBOARD_CONFIG__"\]/);
	assert.match(html, /\\u003c\/script>/);
	assert.doesNotMatch(html, /<\/script><script>alert/);
});

test('validateRegistry refuses ids that could escape or collide as file names', () => {
	for (const bad of ['../etc', 'a/b', 'a.b', 'a--b', '', 'a b', 'a\\b']) {
		assert.throws(() => config.validateRegistry(registry([{ id: bad }])), new RegExp('view id'), `view id ${JSON.stringify(bad)}`);
		assert.throws(() => config.validateRegistry(registry([{ id: 'ok', states: [{ id: bad, expect: '#x' }] }])), new RegExp('state id'), `state id ${JSON.stringify(bad)}`);
	}
	assert.throws(() => config.validateRegistry(registry([{ id: 'dup' }, { id: 'dup' }])), /duplicate view id/);
	assert.throws(() => config.validateRegistry(registry([{ id: 'v', states: [{ id: 's', expect: '#a' }, { id: 's', expect: '#b' }] }])), /duplicate state id/);
	assert.doesNotThrow(() => config.validateRegistry(registry([{ id: 'fluency-level-viewer', states: [{ id: 'path-analyzer', expect: '#p' }, { id: 'tab_2', expect: '#t' }] }])));
});

test('validateRegistry refuses a state that does not say what it expects to see', () => {
	// Without `expect`, steps that fail to switch tabs would screenshot the
	// initial tab and pass as "unchanged" — the blind spot states exist to close.
	for (const missing of [{ id: 's' }, { id: 's', expect: '' }, { id: 's', expect: '   ' }, { id: 's', expect: 42 as unknown as string }]) {
		assert.throws(() => config.validateRegistry(registry([{ id: 'v', states: [missing] }])), /must declare a non-empty "expect"/);
	}
	const committed = config.readConfig(SKILL_DIR);
	for (const view of committed.views) {
		for (const state of view.states || []) {
			assert.ok(state.expect && state.expect.trim(), `${view.id}--${state.id} declares expect`);
		}
	}
});

test('baselineRegistry renders the base commit\'s own definitions, plus current-only targets flagged', () => {
	const current = registry([
		{ id: 'usage', fixture: 'usage.json', bundle: 'usage', states: [
			{ id: 'tools', steps: [{ click: '.new-selector' }], expect: '#new-panel' },
			{ id: 'insights', steps: [{ click: '[data-tab="insights"]' }], expect: '#tab-panel-insights' },
		] },
		{ id: 'details', fixture: 'details-renamed.json', bundle: 'details-v2' },
		{ id: 'brand-new', fixture: 'brand-new.json', bundle: 'brand-new' },
	]);
	const base = registry([
		{ id: 'usage', fixture: 'usage.json', bundle: 'usage', states: [
			{ id: 'tools', steps: [{ click: '.old-selector' }], expect: '#old-panel' },
			{ id: 'legacy-tab', steps: [{ click: '.legacy' }], expect: '#legacy' },
		] },
		{ id: 'details', fixture: 'details.json', bundle: 'details' },
		{ id: 'retired', fixture: 'retired.json', bundle: 'retired' },
	]);
	const merged = config.baselineRegistry(current, base, DIRS);

	assert.deepEqual(merged.views.map((v) => v.id), ['usage', 'details', 'retired', 'brand-new']);

	// A view both sides declare keeps the BASE definition: its bundle, its fixture, its fixture directory.
	const details = merged.views.find((v) => v.id === 'details');
	assert.equal(details?.bundle, 'details');
	assert.equal(details?.fixture, 'details.json');
	assert.equal(details?.fixtureDir, DIRS.baseFixtureDir);
	assert.equal(details?.currentOnly, undefined);

	// A state both sides declare keeps the BASE steps and expect, so the old bundle is driven the old way.
	const usageStates = merged.views.find((v) => v.id === 'usage')?.states || [];
	assert.deepEqual(usageStates.map((s) => s.id), ['tools', 'legacy-tab', 'insights']);
	assert.deepEqual(usageStates[0].steps, [{ click: '.old-selector' }]);
	assert.equal(usageStates[0].expect, '#old-panel');
	assert.equal(usageStates[0].currentOnly, undefined);

	// A base-only state stays, unflagged, so its failure on the base bundle would be a real error.
	assert.equal(usageStates[1].currentOnly, undefined);

	// A current-only state rides along flagged, with the current definition (the only one there is).
	assert.equal(usageStates[2].currentOnly, true);
	assert.equal(usageStates[2].expect, '#tab-panel-insights');

	// A retired view stays with the base fixture directory; a brand-new view is flagged and uses the current one.
	const retired = merged.views.find((v) => v.id === 'retired');
	assert.equal(retired?.fixtureDir, DIRS.baseFixtureDir);
	assert.equal(retired?.currentOnly, undefined);
	const brandNew = merged.views.find((v) => v.id === 'brand-new');
	assert.equal(brandNew?.currentOnly, true);
	assert.equal(brandNew?.fixtureDir, DIRS.currentFixtureDir);

	// Inputs are not mutated.
	assert.equal(base.views[0].states?.length, 2);
	assert.equal(current.views[0].states?.length, 2);
});

test('baselineRegistry flags everything current-only when the base commit has no registry', () => {
	const current = registry([{ id: 'usage', fixture: 'usage.json', states: [{ id: 'tools', expect: '#tab-panel-tools' }] }]);
	const merged = config.baselineRegistry(current, null, DIRS);
	assert.equal(merged.views[0].currentOnly, true);
	assert.equal(merged.views[0].fixtureDir, DIRS.currentFixtureDir);
	assert.equal(merged.views[0].states?.[0].currentOnly, undefined, 'the flag on the view covers its states');
});

test('baselineRegistry uses the new fixture when enabling a previously disabled view', () => {
	const current = registry([{ id: 'dashboard', fixture: 'dashboard.json', globals: { __DASHBOARD_CONFIG__: { azureConfigured: true } }, states: [{ id: 'team-server', expect: '.team-server-card' }] }]);
	const base = registry([{ id: 'dashboard', fixture: 'dashboard.json', enabled: false }]);
	const merged = config.baselineRegistry(current, base, DIRS).views[0];
	assert.equal(merged.fixtureDir, DIRS.currentFixtureDir);
	assert.equal(merged.enabled, true);
	assert.deepEqual(merged.globals, current.views[0].globals);
	assert.equal(merged.states?.[0].currentOnly, true);
	assert.equal(base.views[0].enabled, false, 'the base registry is not mutated');
});

test('baselineRegistry drops base entries with unsafe ids instead of importing them', () => {
	const current = registry([{ id: 'usage', fixture: 'usage.json' }]);
	const base = registry([{ id: '../escape', fixture: 'x.json' }, { id: 'usage', fixture: 'usage.json', states: [{ id: 'a/b' }] }]);
	const merged = config.baselineRegistry(current, base, DIRS);
	assert.deepEqual(merged.views.map((v) => v.id), ['usage']);
	assert.deepEqual(merged.views[0].states || [], []);
});
