/**
 * Stage 1 — turn a release into a scene manifest.
 *
 * The plan is fully deterministic without any model: every scene's image, its
 * title and a first draft of its narration come from the catalog entry, whose
 * `surface` already names the exact view and tab the feature lives on. A local
 * LLM, when enabled, only rewrites the *prose* of the narration; it never
 * chooses a screenshot, a duration or a transition.
 *
 * The result is written to `content/manifest.json`, which is meant to be
 * edited by hand. Re-running `plan` overwrites it, so `--keep-narration`
 * preserves narration you have already tuned.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { selectRelease, type ResolvedFeature } from './catalog';
import { paths, type Config } from './config';
import { cardRelativePath } from './cards';
import { applyCachedFocus, screenshotRelativePath, type ShotTarget } from './shots';
import { polishNarration } from './llm';
import { validateManifest, type Manifest, type Scene } from './manifest';
import { coldOpenNarration, featureNarration, introNarration, outroNarration } from './narration';
import { capWords } from './speech';
import { log, slug, writeJson } from './util';

export interface PlanOptions {
	readonly version?: string;
	readonly maxFeatures?: number;
	readonly keepNarration?: boolean;
	readonly useLlm?: boolean;
}

/** The view used for the opening and closing cards. */
const BOOKEND_VIEW = 'whatsnew';

/**
 * Where the feature's screenshot lives, and what to focus the zoom on.
 *
 * A feature with a DOM `anchor` names a specific element; the capture stage
 * measures that element and writes its centre into the shot index, so the Ken
 * Burns move ends on the new thing rather than on the middle of the page.
 */
function shotTargetFor(feature: ResolvedFeature): ShotTarget {
	return {
		view: feature.surface.view,
		...(feature.surface.tab !== undefined ? { state: feature.surface.tab } : {}),
		...(feature.surface.anchor !== undefined ? { anchor: feature.surface.anchor } : {}),
	};
}

/**
 * The provenance block a scene carries.
 *
 * This is not only documentation: the capture stage reads `view` and `tab` to
 * decide which panel and which tab to screenshot. A scene that omits it leaves
 * the capture stage inferring from the filename, which cannot recover a tab.
 */
function sourceOf(feature: ResolvedFeature): NonNullable<Scene['source']> {
	return {
		featureId: feature.id,
		view: feature.surface.view,
		...(feature.surface.tab !== undefined ? { tab: feature.surface.tab } : {}),
		...(feature.surface.anchor !== undefined ? { anchor: feature.surface.anchor } : {}),
	};
}

/** Alternates the Ken Burns direction so consecutive scenes do not feel identical. */
function motionFor(index: number, config: Config): Scene['motion'] {
	const directions = ['zoom-in', 'pan-right', 'zoom-in', 'pan-left'] as const;
	return {
		type: directions[index % directions.length] ?? 'zoom-in',
		from: config.motion.zoomFrom,
		to: config.motion.zoomTo,
		focusX: 0.5,
		focusY: 0.5,
	};
}

export async function plan(config: Config, options: PlanOptions = {}): Promise<Manifest> {
	const release = selectRelease(options.version);
	log.group(`Planning ${config.project.productName} ${release.version}`);
	log.info(`${release.features.length} catalogued feature(s)${release.date ? `, released ${release.date}` : ', unreleased'}`);

	const features = options.maxFeatures !== undefined
		? release.features.slice(0, options.maxFeatures)
		: [...release.features];

	// The bookend view gets its own scenes, so a feature that *is* that view
	// would otherwise be shown three times. Drop it from the body.
	const body = features.filter((feature) => feature.surface.view !== BOOKEND_VIEW);
	if (body.length !== features.length) {
		log.info(`Skipping the ${BOOKEND_VIEW} feature in the body — it is already the opening and closing card`);
	}

	const previous = options.keepNarration ? readPreviousNarration() : new Map<string, string>();

	const scenes: Scene[] = [];

	// Cold open: a real screen from this release, held for one line before the
	// logo lands. Opening on the product rather than on a logo gives a viewer
	// something to look at while the first sentence tells them what this is.
	const heroFeature = body[0];
	const heroImage = heroFeature
		? screenshotRelativePath(shotTargetFor(heroFeature))
		: screenshotRelativePath({ view: BOOKEND_VIEW });

	scenes.push({
		id: 'cold-open',
		image: heroImage,
		title: '',
		narration: previous.get('cold-open') ?? coldOpenNarration(release, config.project.productName),
		// A firmer push than the body scenes: this one has to feel like a start.
		motion: { type: 'zoom-in', from: 1.0, to: 1.16, focusX: 0.5, focusY: 0.42 },
		transition: 'fade',
		transitionSeconds: 0.5,
		// The hero's surface travels with the scene. Without it the capture
		// stage has only the filename to go on, and `usage--tools.png` infers
		// back to the bare view `usage` — so it captured an extra screenshot
		// that nothing referenced, and would have captured the *wrong* one had
		// no other scene needed that tab.
		...(heroFeature ? { source: sourceOf(heroFeature) } : {}),
	});

	// The logo sting. A hard cut into it, so it lands rather than dissolves.
	scenes.push({
		id: 'title-card',
		image: cardRelativePath('title'),
		title: '',
		narration: previous.get('title-card') ?? introNarration(release, config.project.productName),
		motion: { type: 'zoom-in', from: 1.0, to: 1.04, focusX: 0.5, focusY: 0.5 },
		transition: config.motion.transition as Scene['transition'],
		transitionSeconds: config.motion.transitionSeconds,
	});

	body.forEach((feature, index) => {
		const id = slug(feature.id);
		const target = shotTargetFor(feature);
		const previousView = index > 0 ? body[index - 1]?.surface.view : undefined;
		scenes.push({
			id,
			image: screenshotRelativePath(target),
			title: feature.title,
			narration: previous.get(id) ?? featureNarration(feature, {
				index,
				...(previousView !== undefined ? { previousView } : {}),
			}),
			motion: motionFor(index, config),
			transition: config.motion.transition as Scene['transition'],
			transitionSeconds: config.motion.transitionSeconds,
			source: sourceOf(feature),
		});
	});

	// The download card. Still, because a URL that drifts is a URL you cannot
	// read or type in from a paused frame.
	scenes.push({
		id: 'download-card',
		image: cardRelativePath('download'),
		title: '',
		narration: previous.get('download-card') ?? outroNarration(body.length, config.project.productName),
		motion: { type: 'still', from: 1.0, to: 1.0, focusX: 0.5, focusY: 0.5 },
		transition: 'none',
		transitionSeconds: 0,
	});

	let manifest = validateManifest({
		project: {
			title: `${config.project.productName} ${release.version}`,
			version: release.version,
			width: config.project.width,
			height: config.project.height,
			fps: config.project.fps,
		},
		scenes,
	});

	// Anchor focus points were measured against screenshots that a re-plan does
	// not invalidate, so carry them over rather than resetting every anchored
	// zoom to the middle of the page.
	manifest = applyCachedFocus(manifest);

	const wantsLlm = options.useLlm ?? config.llm.enabled;
	if (wantsLlm) {
		manifest = await polishNarration(manifest, config, release);
	} else {
		// Even without a model, hold narration to the same budget so a verbose
		// catalog entry cannot silently produce a 40-second scene.
		manifest = validateManifest({
			...manifest,
			scenes: manifest.scenes.map((scene) => ({
				...scene,
				narration: capWords(scene.narration, config.llm.maxWordsPerScene),
			})),
		});
	}

	writeJson(paths.manifest, manifest);
	log.info(`Wrote ${path.relative(process.cwd(), paths.manifest)} — ${manifest.scenes.length} scenes`);
	log.groupEnd();
	return manifest;
}

/**
 * Narration from a previous plan, keyed by scene id.
 *
 * Hand-tuned wording is the most expensive thing in the manifest and the
 * easiest to lose; `--keep-narration` exists so re-planning after a catalog
 * edit does not throw it away.
 */
function readPreviousNarration(): Map<string, string> {
	const map = new Map<string, string>();
	if (!fs.existsSync(paths.manifest)) { return map; }
	try {
		const previous = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as Manifest;
		for (const scene of previous.scenes ?? []) {
			if (scene.id && typeof scene.narration === 'string') {
				map.set(scene.id, scene.narration);
			}
		}
		log.info(`Keeping narration from ${map.size} existing scene(s)`);
	} catch (error) {
		log.warn(`Could not read existing manifest, planning fresh: ${(error as Error).message}`);
	}
	return map;
}
