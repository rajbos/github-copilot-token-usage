#!/usr/bin/env node
'use strict';

/**
 * Renders every configured webview panel headlessly and writes a PNG per view —
 * one for its initial render and one per declared `state` (a tab, a mode).
 *
 * Usage:
 *   node render-views.js --out <dir> [--view <id>] [--theme dark|light|both]
 *                        [--dist <dir>] [--repo-root <dir>] [--allow-missing]
 *                        [--config <views.config.json>] [--concurrency <n>]
 *
 * `--concurrency` is how many pages render at once (default 4). Each target
 * gets its own page and browser context, so they cannot see each other; the
 * report and the log summary are ordered by view, state and theme regardless
 * of which page finished first.
 *
 * `--config` renders from another registry than the skill's own — the visual
 * diff passes a registry merged with the base commit's, so a view or state the
 * branch removed still renders on the baseline side and shows up as removed.
 *
 * `--allow-missing` is for rendering a *baseline* build from a registry
 * produced by `baselineRegistry()`: a view or state flagged `currentOnly` (one
 * only the current registry declares) that this build cannot produce — a
 * bundle that did not exist yet, a tab whose selector the old code never
 * rendered — is skipped rather than failed, so the comparison can report the
 * current screenshot as "added". Any other failed render stays an error, with
 * a non-zero exit, so a baseline that breaks on a view both sides declare is
 * never quietly reported as an addition.
 *
 * `--dist` and `--repo-root` point the render at a different checkout's build,
 * which is how `visual-diff.js` renders the baseline commit: the fixtures and
 * this harness stay fixed while the webview bundles being rendered change, so
 * a diff isolates the change in rendering code.
 *
 * The screenshots are the deliverable — this script never posts anything
 * anywhere. Comparing two runs is `diff-screenshots.js`; getting the images in
 * front of a human (a PR comment, an artifact upload) is deliberately out of
 * scope for this skill.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
	REPO_ROOT,
	buildPageHtml,
	loadFixture,
} = require('./lib/harness');
const { loadChromium } = require('./lib/browser');
const { parseArgs, readConfig, selectViews } = require('./lib/config');
const { applySteps, isShowing } = require('./lib/steps');
const { parseConcurrency, runPool } = require('./lib/pool');

/** How long a responsive chart gets to redraw after the viewport is grown. */
const RESIZE_SETTLE_MS = 750;

/**
 * The wall-clock time every page sees. Views read `new Date()` — the chart
 * draws a "projected rest of the current period" bar sized by the minute of
 * the day, and several views filter to "last N days" — so an unfrozen clock
 * made identical builds diff against each other depending on when each side
 * rendered. The fixtures all treat 2026-03-14 as "today" (the chart's
 * `lastUpdated`), so the clock is pinned there.
 *
 * This lives in the harness rather than in views.config.json on purpose: the
 * baseline render uses the base commit's registry, which would not carry a
 * newly added setting, and both sides must see the same clock.
 */
const FROZEN_NOW = '2026-03-14T09:30:00.000Z';

/**
 * Screenshot file name for a view, optionally in one of its declared states.
 *
 * `<view>.<theme>.png` for the initial render and `<view>--<state>.<theme>.png`
 * for a state, so `diff-screenshots.js` can pair baseline and current shots by
 * name and still recover the view id (for its per-view noise floor).
 */
function shotFileName(viewId, stateId, theme) {
	return `${viewId}${stateId ? `--${stateId}` : ''}.${theme}.png`;
}

/**
 * The renders a view produces: its initial state, then every declared `state`.
 *
 * A tabbed panel screenshotted only in its initial state hides every change on
 * the other tabs — a whole new section on the Tools tab of the usage view once
 * diffed as "unchanged" for exactly that reason. `states` are the tabs and
 * modes worth a screenshot of their own, each reached by replaying a few
 * click/select steps on a fresh page.
 */
function renderTargets(view) {
	return [null, ...(view.states || [])];
}

async function renderView({ browser, view, state, theme, outDir, tmpDir, defaults, distDir, repoRoot }) {
	const id = state ? `${view.id}--${state.id}` : view.id;
	const bundlePath = path.join(distDir, `${view.bundle}.js`);
	if (!fs.existsSync(bundlePath)) {
		return {
			view: view.id,
			state: state ? state.id : null,
			theme,
			status: 'error',
			missing: true,
			error: `Missing bundle ${bundlePath} — run \`npm run compile\` in vscode-extension/ first.`,
		};
	}

	// A registry from baselineRegistry() pins each view to the fixture directory
	// of the commit that declared it, so a base view renders with the base
	// commit's fixture even when the current tree renamed or deleted it.
	const fixturePath = path.join(view.fixtureDir || path.join(__dirname, 'fixtures'), path.basename(String(view.fixture || '')));
	if (!view.fixture || !fs.existsSync(fixturePath)) {
		return { view: view.id, state: state ? state.id : null, theme, status: 'error', missing: true, error: `Missing fixture ${view.fixture}` };
	}

	// Building the page reads the fixture and the repo JSON it references
	// (`$fromRepoJson`) from `repoRoot`. On the baseline side that root is the
	// base commit, which may not have a file this branch introduced; that is a
	// per-target error (skippable for a current-only target), not a reason to
	// abort the whole render.
	const pageFile = path.join(tmpDir, `${id}-${theme}.html`);
	try {
		const html = buildPageHtml({
			globalName: view.global,
			fixture: loadFixture(fixturePath, repoRoot),
			theme,
			bundlePath,
			repoRoot,
			extraGlobals: view.globals,
		});
		fs.writeFileSync(pageFile, html);
	} catch (error) {
		return { view: view.id, state: state ? state.id : null, theme, status: 'error', missing: true, error: `Could not build the page for ${id}: ${String(error && error.message || error)}` };
	}

	const viewport = view.viewport || defaults.viewport;
	const page = await browser.newPage({
		viewport,
		deviceScaleFactor: 1,
		// Pinned so a date/number rendered by the view is stable between runs.
		locale: 'en-US',
		timezoneId: 'UTC',
		colorScheme: theme,
		reducedMotion: 'reduce',
	});

	const consoleErrors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') { consoleErrors.push(msg.text()); }
	});
	page.on('pageerror', (err) => { consoleErrors.push(String(err && err.stack || err)); });

	try {
		// `setFixedTime` pins Date/Date.now but leaves timers running, so the
		// settle waits and Chart.js's own scheduling behave as before.
		await page.clock.setFixedTime(new Date(FROZEN_NOW));
		await page.goto(`file://${pageFile}`, { waitUntil: 'networkidle', timeout: 30_000 });
		await page.waitForTimeout(view.settleMs ?? defaults.settleMs);

		if (state) {
			// Reach the declared state from the initial render, then let the view
			// re-render before measuring — a tab switch is a full re-render in
			// most of these panels.
			const applied = await applySteps(page, state.steps);
			if (!applied.ok) {
				return {
					view: view.id, state: state.id, theme, status: 'error', missing: true,
					error: `State '${state.id}' could not be reached (${applied.step}: ${applied.reason}).`,
				};
			}
			await page.waitForTimeout(state.settleMs ?? view.settleMs ?? defaults.settleMs);
			// `expect` names what the state must be showing. A tab whose panel
			// never appeared would otherwise screenshot the previous tab and pass
			// as "unchanged" forever.
			if (!(await isShowing(page, state.expect))) {
				return {
					view: view.id, state: state.id, theme, status: 'error', missing: true,
					error: `State '${state.id}' was reached but '${state.expect}' is not showing.`,
				};
			}
		}

		// Web fonts and codicons load asynchronously; screenshotting before they
		// settle produces spurious diffs on every second run.
		await page.evaluate(() => document.fonts && document.fonts.ready);

		// A full-page screenshot temporarily grows the viewport to the page's
		// height, and every responsive <canvas> (Chart.js) redraws on that
		// resize — sometimes finishing before the capture, sometimes not, which
		// made the radar and trend charts diff against themselves. Grow the
		// viewport first and let the redraw finish, so the capture itself
		// triggers no layout change.
		const fullPage = view.fullPage ?? defaults.fullPage;
		if (fullPage) {
			const pageHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
			if (pageHeight > viewport.height) {
				await page.setViewportSize({ width: viewport.width, height: pageHeight });
				await page.waitForTimeout(RESIZE_SETTLE_MS);
			}
		}

		const probe = await page.evaluate(() => {
			const root = document.getElementById('root');
			return {
				rootChildren: root ? root.children.length : 0,
				bodyTextLength: (document.body.innerText || '').length,
				harnessErrors: window.__HARNESS_ERRORS__ || [],
			};
		});

		const file = path.join(outDir, shotFileName(view.id, state && state.id, theme));
		await page.screenshot({ path: file, fullPage });

		// A page that throws during render can still screenshot as a blank panel,
		// which would silently pass as "no visual change". Treat it as a failure.
		const rendered = probe.rootChildren > 0 && probe.bodyTextLength > 0;
		const errors = [...probe.harnessErrors, ...consoleErrors];
		return {
			view: view.id,
			state: state ? state.id : null,
			title: state ? `${view.title} — ${state.title || state.id}` : view.title,
			theme,
			status: rendered && errors.length === 0 ? 'ok' : rendered ? 'warn' : 'error',
			file: path.relative(outDir, file),
			rootChildren: probe.rootChildren,
			bodyTextLength: probe.bodyTextLength,
			errors: errors.slice(0, 5),
			...(rendered ? {} : { error: 'View produced an empty #root — the fixture is probably missing required fields.' }),
		};
	} catch (error) {
		return { view: view.id, state: state ? state.id : null, theme, status: 'error', error: String(error && error.message || error) };
	} finally {
		await page.close();
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const outDir = path.resolve(args.out || path.join(REPO_ROOT, 'visual-output', 'current'));
	const repoRoot = path.resolve(args['repo-root'] || REPO_ROOT);
	const distDir = path.resolve(args.dist || path.join(repoRoot, 'vscode-extension', 'dist', 'webview'));
	const config = readConfig(__dirname, typeof args.config === 'string' ? path.resolve(args.config) : undefined);
	const views = selectViews(config, args.view);
	const themes = args.theme === 'both' ? ['dark', 'light'] : [args.theme || 'dark'];
	const allowMissing = args['allow-missing'] === true;
	const concurrency = parseConcurrency(args.concurrency);

	if (views.length === 0) {
		console.error(`No enabled views matched${args.view ? ` "${args.view}"` : ''}.`);
		process.exit(1);
	}

	fs.mkdirSync(outDir, { recursive: true });
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-view-diff-'));

	const chromium = loadChromium();
	const browser = await chromium.launch();
	const targets = views.flatMap((view) => renderTargets(view)
		.flatMap((state) => themes.map((theme) => ({ view, state, theme }))));
	const startedAt = Date.now();
	let results;
	try {
		results = await runPool(targets, concurrency, async ({ view, state, theme }) => {
			let result = await renderView({ browser, view, state, theme, outDir, tmpDir, defaults: config.defaults, distDir, repoRoot });
			const currentOnly = Boolean(view.currentOnly || (state && state.currentOnly));
			if (allowMissing && result.status === 'error' && currentOnly) {
				// The baseline simply does not have this yet. Leaving no
				// screenshot behind is what lets the diff call the current
				// one "added" instead of the whole run failing. A target both
				// registries declare is never skipped: its failure is real.
				// A render that got as far as the capture and then failed the
				// empty-root check has written its PNG already; drop it, or
				// the diff would compare against a blank baseline.
				const { file, ...rest } = result;
				if (file) { fs.rmSync(path.join(outDir, file), { force: true }); }
				result = { ...rest, status: 'skipped' };
			}
			// Logged as each render finishes, so the order here follows timing;
			// render-report.json keeps the deterministic order.
			const icon = { ok: '✅', warn: '⚠️ ', skipped: '⏭️ ' }[result.status] || '❌';
			const detail = result.status === 'ok'
				? `${result.bodyTextLength} chars of text`
				: (result.error || (result.errors || []).join(' | '));
			console.log(`${icon} ${state ? `${view.id}--${state.id}` : view.id} (${theme}) — ${detail}`);
			return result;
		});
	} finally {
		await browser.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	fs.writeFileSync(
		path.join(outDir, 'render-report.json'),
		JSON.stringify({ generatedAt: new Date().toISOString(), themes, distDir, repoRoot, results }, null, 2) + '\n',
	);

	const failed = results.filter((r) => r.status === 'error');
	const skipped = results.filter((r) => r.status === 'skipped');
	const skippedNote = skipped.length ? ` (${skipped.length} not in this build, skipped)` : '';
	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(`\n${results.length - failed.length - skipped.length}/${results.length} renders succeeded${skippedNote} in ${seconds}s (${concurrency} at a time) → ${path.relative(process.cwd(), outDir) || outDir}`);
	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

module.exports = { renderView, renderTargets, shotFileName };
