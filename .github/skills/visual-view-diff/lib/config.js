'use strict';

const fs = require('fs');
const path = require('path');

/** Parses `--key value` and `--flag` arguments into a plain object. */
function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) { continue; }
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			args[key] = true;
		} else {
			args[key] = next;
			i++;
		}
	}
	return args;
}

/**
 * Reads the view registry. `configPath` overrides the skill's own
 * `views.config.json`, which is how the visual diff renders a baseline from a
 * registry built from the base commit's (see `baselineRegistry`).
 */
function readConfig(skillDir, configPath) {
	const config = JSON.parse(fs.readFileSync(configPath || path.join(skillDir, 'views.config.json'), 'utf8'));
	return validateRegistry({ defaults: config.defaults, views: config.views });
}

/**
 * A view or state id becomes part of a file name (`<view>--<state>.<theme>.png`)
 * and of a temp path, so it is held to a strict allowlist: no separators, no
 * dots, no `--` (the view/state delimiter), and unique within its scope. A
 * registry that breaks this is refused up front rather than letting one entry
 * write over another's screenshot or outside the output directory.
 */
const ID_PATTERN = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/;

function validateRegistry(config) {
	const seenViews = new Set();
	for (const view of config.views || []) {
		if (typeof view.id !== 'string' || !ID_PATTERN.test(view.id)) {
			throw new Error(`views.config.json: view id ${JSON.stringify(view.id)} must match ${ID_PATTERN} (letters, digits, _ and single dashes)`);
		}
		if (seenViews.has(view.id)) {
			throw new Error(`views.config.json: duplicate view id "${view.id}"`);
		}
		seenViews.add(view.id);
		const seenStates = new Set();
		for (const state of view.states || []) {
			if (typeof state.id !== 'string' || !ID_PATTERN.test(state.id)) {
				throw new Error(`views.config.json: state id ${JSON.stringify(state.id)} on view "${view.id}" must match ${ID_PATTERN}`);
			}
			if (seenStates.has(state.id)) {
				throw new Error(`views.config.json: duplicate state id "${state.id}" on view "${view.id}"`);
			}
			seenStates.add(state.id);
			// Without `expect`, a state whose steps silently fail to switch tabs
			// would screenshot the initial tab and pass as "unchanged" forever —
			// the exact blind spot states exist to remove.
			if (typeof state.expect !== 'string' || state.expect.trim() === '') {
				throw new Error(`views.config.json: state "${state.id}" on view "${view.id}" must declare a non-empty "expect" selector`);
			}
		}
	}
	return config;
}

/**
 * The registry to render a *baseline* from.
 *
 * The baseline is the base commit's own registry — its view definitions,
 * state steps, fixtures and bundles — so that an old bundle is always driven
 * the way the old registry drove it. Rendering the baseline from the current
 * registry would replay the branch's edited selectors, fixtures and expects
 * against the old code and misreport a changed tab as skipped or added.
 *
 * On top of that, every view and state only the *current* registry declares is
 * added and flagged `currentOnly`, so the branch's additions are attempted on
 * the old bundle and, when they cannot render there, skipped by
 * `--allow-missing` — which skips those targets and nothing else. A target
 * both registries declare that fails on the base bundle stays an error, so a
 * broken baseline is never quietly reported as "added".
 *
 * Views and states only the base declares stay in, with the base commit's
 * fixture directory, so a view or tab the branch removed still renders on the
 * baseline side and the comparison reports it as **removed**.
 *
 * Without a base registry (a base commit that predates it) every current
 * target is flagged `currentOnly`.
 */
function baselineRegistry(current, base, { baseFixtureDir, currentFixtureDir }) {
	const clone = (v) => ({ ...v, states: (v.states || []).map((s) => ({ ...s })) });
	if (!base) {
		return validateRegistry({
			defaults: current.defaults,
			views: current.views.map((v) => ({ ...clone(v), currentOnly: true, fixtureDir: currentFixtureDir })),
		});
	}
	const views = (base.views || [])
		.filter((v) => ID_PATTERN.test(String(v.id)))
		.map((v) => ({
			...clone(v),
			states: (v.states || []).filter((s) => ID_PATTERN.test(String(s.id))).map((s) => ({ ...s })),
			fixtureDir: baseFixtureDir,
		}));
	const byId = new Map(views.map((v) => [v.id, v]));
	for (const currentView of current.views) {
		const baseView = byId.get(currentView.id);
		if (!baseView) {
			views.push({ ...clone(currentView), currentOnly: true, fixtureDir: currentFixtureDir });
			continue;
		}
		// A newly enabled view had no meaningful baseline fixture. Render both
		// bundles with the same new fixture instead of comparing data to a loader.
		if (baseView.enabled === false && currentView.enabled !== false) {
			baseView.fixture = currentView.fixture;
			baseView.fixtureDir = currentFixtureDir;
			baseView.globals = currentView.globals;
			baseView.enabled = true;
		}
		const baseStates = new Set(baseView.states.map((s) => s.id));
		for (const state of currentView.states || []) {
			if (!baseStates.has(state.id)) {
				baseView.states.push({ ...state, currentOnly: true });
			}
		}
	}
	return validateRegistry({ defaults: base.defaults || current.defaults, views });
}

/**
 * Picks the views to render.
 *
 * `filter` may be a single id or a comma-separated list. Views marked
 * `enabled: false` are skipped unless named explicitly, so `--view dashboard`
 * still works for someone debugging it.
 */
function selectViews(config, filter) {
	if (typeof filter === 'string' && filter.length > 0) {
		const wanted = new Set(filter.split(',').map((s) => s.trim()).filter(Boolean));
		return config.views.filter((v) => wanted.has(v.id));
	}
	return config.views.filter((v) => v.enabled !== false);
}

module.exports = { parseArgs, readConfig, selectViews, validateRegistry, baselineRegistry, ID_PATTERN };
