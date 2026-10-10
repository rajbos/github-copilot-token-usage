/**
 * Stage 2 — capture the screenshots the scenes point at.
 *
 * This reuses the repository's existing headless webview harness
 * (`.github/skills/visual-view-diff/lib/**`) rather than reimplementing it:
 * the same fixtures, the same bundles, the same VS Code theme shim and the
 * same `steps` vocabulary that drives a view to a particular tab. What this
 * adds on top is video-specific and does not belong in that skill:
 *
 *   - A 16:9 viewport at the project's aspect ratio, captured at a device
 *     scale factor so 1280 CSS pixels of UI become a crisp 1920x1080 frame.
 *     (The visual diff captures full-page, which for video would mean a very
 *     tall image pillarboxed into a letterbox.)
 *   - **Anchor measurement.** A catalogued feature names the DOM id of the
 *     section it added. That element is scrolled into view and its bounding
 *     box measured, and the centre becomes the scene's Ken Burns focus point —
 *     so the zoom lands on the new section instead of on the middle of the
 *     page. This is the part that makes the motion mean something.
 *
 * Because the catalog already names `view` and `tab`, no vision model is
 * involved in deciding what to show. The mapping is a lookup, not a guess.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { renderCards } from './cards';
import { paths, type Config } from './config';
import { validateManifest, type Manifest } from './manifest';
import { digest, ensureDir, fingerprintFile, log, REPO_ROOT, resolveInProject, writeJson } from './util';

const SKILL_DIR = path.join(REPO_ROOT, '.github', 'skills', 'visual-view-diff');

/** Matches the harness registry's own default; a view may override it. */
const DEFAULT_SETTLE_MS = 1200;

export interface ShotTarget {
	readonly view: string;
	/** A `state` id from views.config.json — which is also the `data-tab` value. */
	readonly state?: string;
	/** DOM id to focus on, from the catalog feature's `surface.anchor`. */
	readonly anchor?: string;
}

/**
 * The state definition a tab gets when the registry does not declare one.
 *
 * Every registered tab state in `views.config.json` follows the same shape —
 * click `.tab-button[data-tab="x"]`, expect `#tab-panel-x` — so a tab that is
 * simply not listed (a panel's initial tab, typically) can be driven by that
 * same convention rather than being refused.
 */
function implicitState(stateId: string): { id: string; steps: unknown[]; expect: string; settleMs?: number } {
	return {
		id: stateId,
		steps: [{ click: `.tab-button[data-tab="${stateId}"]` }],
		expect: `#tab-panel-${stateId}`,
	};
}

/** Stable key for a screenshot. Anchors share a screenshot; only the focus differs. */
export function shotKey(target: ShotTarget): string {
	return target.state ? `${target.view}--${target.state}` : target.view;
}

/** Project-relative path of a target's PNG, as it appears in the manifest. */
export function screenshotRelativePath(target: ShotTarget): string {
	return `assets/screenshots/${shotKey(target)}.png`;
}

interface ViewRegistryEntry {
	id: string;
	bundle: string;
	global: string;
	fixture: string;
	settleMs?: number;
	states?: { id: string; steps?: unknown[]; expect?: string; settleMs?: number }[];
}

interface HarnessLib {
	REPO_ROOT: string;
	WEBVIEW_DIST: string;
	pathToFileUrl(file: string): string;
	buildPageHtml(args: { globalName: string; fixture: unknown; theme: string; bundlePath: string; repoRoot: string }): string;
	loadFixture(fixturePath: string, repoRoot: string): unknown;
}

function requireSkill<T>(relative: string): T {
	const file = path.join(SKILL_DIR, relative);
	if (!fs.existsSync(file)) {
		throw new Error(
			`the visual-view-diff harness is missing at ${file}. ` +
			'The screenshot stage reuses it rather than duplicating it.',
		);
	}
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require(file) as T;
}

export interface ShotsOptions {
	/** CSS pixels are multiplied by this to reach the project resolution. */
	readonly scale?: number;
	/** Re-capture even when the PNG already exists. */
	readonly force?: boolean;
}

/**
 * Captures every screenshot the manifest references and writes the measured
 * anchor focus points back into it.
 *
 * Returns the updated manifest; the caller persists it.
 */
export async function captureShots(manifest: Manifest, config: Config, options: ShotsOptions = {}): Promise<Manifest> {
	const scale = options.scale ?? 1.5;
	const cssWidth = Math.round(manifest.project.width / scale);
	const cssHeight = Math.round(manifest.project.height / scale);

	const harness = requireSkill<HarnessLib>('lib/harness.js');
	const { pathToFileUrl } = harness;
	const { loadChromium } = requireSkill<{ loadChromium(): any }>('lib/browser.js');
	const { readConfig } = requireSkill<{ readConfig(dir: string): { views: ViewRegistryEntry[] } }>('lib/config.js');
	const { applySteps, isShowing } = requireSkill<{
		applySteps(page: unknown, steps: unknown[], opts?: unknown): Promise<{ ok: boolean; step?: string; reason?: string }>;
		isShowing(page: unknown, selector: string): Promise<boolean>;
	}>('lib/steps.js');

	if (!fs.existsSync(harness.WEBVIEW_DIST)) {
		throw new Error(
			`no webview bundles at ${harness.WEBVIEW_DIST}.\n` +
			'Build them first:  cd vscode-extension && npm run compile',
		);
	}

	const registry = readConfig(SKILL_DIR);
	const byId = new Map(registry.views.map((view) => [view.id, view]));

	// One capture per distinct view+tab; several scenes may share one.
	//
	// Only scenes backed by a real panel screenshot are captured. Title and
	// download cards live under assets/cards and are drawn by `renderCards`,
	// so feeding them through the view registry would fail on a view id that
	// was never meant to exist.
	const targets = new Map<string, ShotTarget>();
	for (const scene of manifest.scenes) {
		if (!scene.image.startsWith('assets/screenshots/')) { continue; }
		const source = scene.source;
		const target: ShotTarget = {
			view: source?.view ?? inferViewFromImage(scene.image),
			...(source?.tab !== undefined ? { state: source.tab } : {}),
		};
		targets.set(shotKey(target), target);
	}

	ensureDir(paths.screenshots);
	ensureDir(paths.cache);
	const pageDir = ensureDir(path.join(paths.cache, 'pages'));

	// Fingerprints of the inputs each screenshot was last captured from.
	const inputIndexFile = path.join(paths.cache, 'shot-inputs.json');
	const previousInputs: Record<string, string> = fs.existsSync(inputIndexFile)
		? JSON.parse(fs.readFileSync(inputIndexFile, 'utf8')) as Record<string, string>
		: {};
	const currentInputs: Record<string, string> = {};

	// The harness's own rendering inputs, shared by every shot in this run.
	const harnessFingerprint = digest(
		fingerprintFile(path.join(SKILL_DIR, 'lib', 'harness.js')) ?? 'no-harness',
		fingerprintFile(path.join(SKILL_DIR, 'lib', `theme-${config.project.theme}.css`)) ?? 'no-theme',
	);

	const chromium = loadChromium();
	const browser = await chromium.launch();
	/** shotKey -> anchor id -> focus point, measured in this run. */
	const focusIndex: Record<string, Record<string, { focusX: number; focusY: number }>> = {};

	try {
		log.group(`Capturing ${targets.size} screenshot(s) at ${cssWidth}x${cssHeight} CSS ×${scale}`);

		for (const target of targets.values()) {
			const key = shotKey(target);
			// Through the allowlist, not just path.join: the key is built from
			// the manifest's source.view/source.tab, and path.join happily
			// resolves a traversal segment. The manifest validates those fields
			// too — this is the second lock on the same door.
			const outFile = resolveInProject(screenshotRelativePath(target), `screenshot for ${key}`);
			const view = byId.get(target.view);
			if (!view) {
				throw new Error(
					`view "${target.view}" is not in views.config.json. ` +
					'Every panel must be registered there — see AGENTS.md, "Webview changes must be validated by clicking".',
				);
			}

			const bundlePath = path.join(harness.WEBVIEW_DIST, `${view.bundle}.js`);
			const fixturePath = path.join(SKILL_DIR, 'fixtures', view.fixture);
			const stateDefinition = target.state
				? (view.states ?? []).find((candidate) => candidate.id === target.state) ?? implicitState(target.state)
				: null;

			// The cache key is the *inputs*, not merely whether a PNG is there.
			//
			// Keyed on existence alone, a normal `build` after rebuilding the
			// webview bundles reused the old screenshot and the video shipped
			// the previous UI — silently, because the stale PNG then looks
			// unchanged to the scene renderer too. Everything that can alter
			// the pixels goes in here.
			const inputFingerprint = digest(
				fingerprintFile(bundlePath) ?? 'no-bundle',
				fingerprintFile(fixturePath) ?? 'no-fixture',
				// The harness draws the page, so its shell and the theme it
				// injects are inputs too: change the VS Code theme stand-in and
				// every screenshot changes without any bundle moving.
				harnessFingerprint,
				JSON.stringify({
					global: view.global,
					settleMs: view.settleMs ?? null,
					state: stateDefinition,
				}),
				`${cssWidth}x${cssHeight}@${scale}`,
				config.project.theme,
			);
			currentInputs[key] = inputFingerprint;

			const stale = previousInputs[key] !== inputFingerprint;
			const anchors = anchorsFor(manifest, key);
			const needsCapture = options.force || !fs.existsSync(outFile) || stale;
			if (!needsCapture && anchors.length === 0) {
				log.info(`${key} — cached`);
				continue;
			}
			if (stale && fs.existsSync(outFile) && !options.force) {
				log.info(`${key} — inputs changed, re-capturing`);
			}

			const context = await browser.newContext({
				viewport: { width: cssWidth, height: cssHeight },
				deviceScaleFactor: scale,
				// Pinned for the same reason the visual diff pins them: a date or
				// number a view formats itself must not change between runs.
				locale: 'en-US',
				timezoneId: 'UTC',
				colorScheme: config.project.theme,
				reducedMotion: 'reduce',
			});
			const page = await context.newPage();
			const consoleErrors: string[] = [];
			page.on('console', (message: { type(): string; text(): string }) => {
				if (message.type() === 'error') { consoleErrors.push(message.text()); }
			});
			page.on('pageerror', (error: Error) => { consoleErrors.push(String(error.stack ?? error)); });

			try {
				const fixture = harness.loadFixture(fixturePath, harness.REPO_ROOT);
				const html = harness.buildPageHtml({
					globalName: view.global,
					fixture,
					theme: config.project.theme,
					bundlePath,
					repoRoot: harness.REPO_ROOT,
				});
				// The page must be loaded from a real file, not via setContent: the
				// bundle is referenced with a file:// URL, and a document whose
				// own origin is about:blank cannot fetch one — the view would
				// come out blank, and a blank screenshot is not an error anyone
				// notices until they watch the video.
				const pageFile = path.join(pageDir, `${key}.html`);
				fs.writeFileSync(pageFile, html, 'utf8');
				await page.goto(pathToFileUrl(pageFile), { waitUntil: 'networkidle', timeout: 30000 });
				await page.waitForTimeout(view.settleMs ?? DEFAULT_SETTLE_MS);

				if (target.state) {
					// An unregistered tab is not necessarily a mistake. A panel's
					// *initial* tab is deliberately absent from `states`, because
					// the harness already captures the initial render — `usage`
					// has no `activity` state for exactly that reason, and the
					// 0.17.0 and 0.13.0 catalog entries both point at it. Failing
					// here would make those releases unbuildable.
					//
					// So an unregistered tab falls back to the convention every
					// registered state already follows: click the tab button,
					// expect the matching panel. It is still a hard failure if
					// that tab does not exist — which is the guarantee that
					// mattered — it just no longer requires a registry entry.
					const state = (view.states ?? []).find((candidate) => candidate.id === target.state)
						?? implicitState(target.state);
					const applied = await applySteps(page, (state.steps ?? []) as unknown[]);
					if (!applied.ok) {
						throw new Error(`could not open ${key}: ${applied.reason} (${applied.step})`);
					}
					if (state.expect && !(await isShowing(page, state.expect))) {
						throw new Error(`opened ${key} but "${state.expect}" is not showing`);
					}
					await page.waitForTimeout(state.settleMs ?? view.settleMs ?? DEFAULT_SETTLE_MS);
				}

				if (consoleErrors.length > 0) {
					const first = consoleErrors[0]?.split(/\r?\n/)[0] ?? '';
					log.warn(`${key}: the view logged ${consoleErrors.length} console error(s), e.g. ${first}`);
				}

				for (const anchor of anchors) {
					const focus = await measureAnchor(page, anchor, cssWidth, cssHeight);
					if (focus) {
						(focusIndex[key] ??= {})[anchor] = focus;
					} else {
						log.warn(`${key}: anchor "#${anchor}" not found — the zoom will centre on the page instead`);
					}
				}

				await page.screenshot({ path: outFile, fullPage: false });
				log.info(`${key} → ${path.relative(process.cwd(), outFile)}${anchors.length ? ` (${anchors.length} anchor(s) measured)` : ''}`);
			} finally {
				await context.close();
			}
		}
		await renderCards(browser, config, manifest.project.version, {
			width: manifest.project.width,
			height: manifest.project.height,
		});
	} finally {
		await browser.close();
		log.groupEnd();
	}

	// Merged, so a key this run did not touch keeps its recorded fingerprint.
	writeJson(inputIndexFile, { ...previousInputs, ...currentInputs });
	writeJson(focusIndexPath(), focusIndex);
	return applyFocus(manifest, focusIndex);
}

/** Anchors any scene using this screenshot asked to be focused on. */
function anchorsFor(manifest: Manifest, key: string): string[] {
	const anchors = new Set<string>();
	for (const scene of manifest.scenes) {
		const source = scene.source;
		if (!source?.anchor) { continue; }
		const sceneKey = shotKey({ view: source.view ?? '', ...(source.tab !== undefined ? { state: source.tab } : {}) });
		if (sceneKey === key) { anchors.add(source.anchor); }
	}
	return [...anchors];
}

/**
 * Scrolls an element into view and returns its centre in 0..1 viewport
 * coordinates, or `null` when there is no such element.
 *
 * Scrolling happens before the screenshot on purpose: the shot is what the
 * viewer sees, so the anchored section has to actually be in it.
 */
async function measureAnchor(
	page: any,
	anchorId: string,
	cssWidth: number,
	cssHeight: number,
): Promise<{ focusX: number; focusY: number } | null> {
	const box = (await page.evaluate((id: string) => {
		const element = document.getElementById(id);
		if (!element) { return null; }
		element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
		const rect = element.getBoundingClientRect();
		return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
	}, anchorId)) as { x: number; y: number; width: number; height: number } | null;

	if (!box) { return null; }
	await page.waitForTimeout(250);

	const clamp = (value: number) => Math.min(1, Math.max(0, value));
	return {
		focusX: Number(clamp((box.x + box.width / 2) / cssWidth).toFixed(4)),
		focusY: Number(clamp((box.y + box.height / 2) / cssHeight).toFixed(4)),
	};
}

/** Where the last capture run recorded each anchor's measured focus point. */
function focusIndexPath(): string {
	return path.join(paths.cache, 'shot-focus.json');
}

/**
 * Re-applies focus points measured by a previous capture run.
 *
 * `plan` calls this because re-planning rebuilds every scene from the catalog,
 * which would otherwise reset each anchored scene's focus back to the centre of
 * the page — silently undoing the measurement and leaving the zoom pointing at
 * nothing in particular. The screenshots and their measurements outlive a
 * re-plan, so the focus should too.
 */
export function applyCachedFocus(manifest: Manifest): Manifest {
	const file = focusIndexPath();
	if (!fs.existsSync(file)) { return manifest; }
	try {
		const index = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, { focusX: number; focusY: number }>>;
		return applyFocus(manifest, index);
	} catch (error) {
		log.warn(`Ignoring cached anchor focus: ${(error as Error).message}`);
		return manifest;
	}
}

/** Writes measured focus points into the scenes that asked for them. */
function applyFocus(
	manifest: Manifest,
	focusIndex: Record<string, Record<string, { focusX: number; focusY: number }>>,
): Manifest {
	return validateManifest({
		...manifest,
		scenes: manifest.scenes.map((scene) => {
			const source = scene.source;
			if (!source?.anchor || !source.view) { return scene; }
			const key = shotKey({ view: source.view, ...(source.tab !== undefined ? { state: source.tab } : {}) });
			const focus = focusIndex[key]?.[source.anchor];
			if (!focus) { return scene; }
			return { ...scene, motion: { ...scene.motion, focusX: focus.focusX, focusY: focus.focusY } };
		}),
	});
}

/** Recovers the view id from a manifest image path, for hand-written scenes. */
function inferViewFromImage(image: string): string {
	const base = path.basename(image, '.png');
	const [view] = base.split('--');
	return view ?? base;
}
