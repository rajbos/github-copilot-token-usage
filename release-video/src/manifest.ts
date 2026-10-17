/**
 * The scene manifest: the single artifact that stands between "what the
 * release was about" and "what FFmpeg renders".
 *
 * Everything downstream — screenshots, narration, timing, subtitles, the
 * filter graph — is derived from this file, so it is also the natural place
 * for a human to intervene. Edit `content/manifest.json` by hand and re-run
 * `render`: the pipeline will honour it and regenerate only what changed.
 *
 * ## Why validation lives here
 *
 * A local model may *propose* narration and title text. It must never decide a
 * file path, a duration, a frame offset or an enum value, because those become
 * FFmpeg arguments. {@link validateManifest} is the choke point: it rejects
 * unknown enum members, coerces numbers into sane ranges, and runs every path
 * through the project-root allowlist. A manifest that survives it cannot, by
 * construction, point FFmpeg at something outside the project.
 */

import * as fs from 'node:fs';

import { resolveInProject } from './util';

export const MOTION_TYPES = ['zoom-in', 'zoom-out', 'pan-right', 'pan-left', 'still'] as const;
export type MotionType = (typeof MOTION_TYPES)[number];

export const TRANSITIONS = ['fade', 'wipeleft', 'wiperight', 'slideup', 'slidedown', 'dissolve', 'none'] as const;
export type Transition = (typeof TRANSITIONS)[number];

export interface SceneMotion {
	readonly type: MotionType;
	readonly from: number;
	readonly to: number;
	/** Focus point in 0..1 image coordinates. Measured from the feature's DOM anchor when there is one. */
	readonly focusX: number;
	readonly focusY: number;
}

export interface Scene {
	/** Stable id. Becomes a cache key and a file name, so it is a slug. */
	readonly id: string;
	/** Project-relative path to the screenshot this scene shows. */
	readonly image: string;
	/** On-screen title band. Keep it short — it is rendered at 1080p. */
	readonly title: string;
	/** What the voice says. The timing authority is the rendered WAV, not this text. */
	readonly narration: string;
	readonly motion: SceneMotion;
	readonly transition: Transition;
	readonly transitionSeconds: number;
	/**
	 * Filled in by the `voice` stage from the real WAV. Absent until then —
	 * nothing may guess it. See docs in `timing.ts`.
	 */
	readonly audio?: string;
	readonly audioSeconds?: number;
	readonly durationSeconds?: number;
	/** Where this scene came from, for traceability back to the release notes. */
	readonly source?: {
		readonly featureId?: string;
		readonly view?: string;
		readonly tab?: string;
		readonly anchor?: string;
	};
}

export interface Manifest {
	readonly project: {
		readonly title: string;
		readonly version: string;
		readonly width: number;
		readonly height: number;
		readonly fps: number;
	};
	readonly scenes: readonly Scene[];
}

function fail(message: string): never {
	throw new Error(`manifest: ${message}`);
}

function asString(value: unknown, label: string, { max = 2000 } = {}): string {
	if (typeof value !== 'string' || value.trim() === '') {
		fail(`${label} must be a non-empty string`);
	}
	const text = value.trim();
	if (text.length > max) {
		fail(`${label} is ${text.length} characters, over the ${max} limit`);
	}
	return text;
}

function asNumber(value: unknown, label: string, min: number, max: number, fallback?: number): number {
	if (value === undefined || value === null) {
		if (fallback !== undefined) { return fallback; }
		fail(`${label} is required`);
	}
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num)) {
		fail(`${label} must be a finite number, got ${JSON.stringify(value)}`);
	}
	if (num < min || num > max) {
		fail(`${label} must be between ${min} and ${max}, got ${num}`);
	}
	return num;
}

function asEnum<T extends string>(value: unknown, label: string, allowed: readonly T[], fallback?: T): T {
	if (value === undefined && fallback !== undefined) { return fallback; }
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		fail(`${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
	}
	return value as T;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A release identifier that is safe to interpolate into a filename.
 *
 * `project.version` names the subtitle file, so validating it only as a
 * non-empty string was not enough: a hand-edited or model-produced manifest
 * with `"../../outside"` would have written the `.ass` outside the project and
 * quietly broken the containment contract this module exists to hold.
 *
 * Deliberately narrow — digits, letters, dot, dash, underscore — because the
 * only thing that ever legitimately appears here is a version number.
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A view or tab id, matching the pattern the harness registry enforces on its
 * own ids. No dots, no separators — these become part of a screenshot's file
 * name.
 */
const SURFACE_ID_PATTERN = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/;

/** A DOM id. Slightly looser than a surface id, still filename-safe. */
const ANCHOR_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A catalog feature id, which is dotted (`usage.corrections-tab`). */
const FEATURE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validates a scene's provenance block.
 *
 * `source.view` and `source.tab` are not just documentation: the capture stage
 * joins them into the screenshot's file name, so a manifest with
 * `view: "../outside"` would write outside `assets/screenshots` and defeat the
 * containment the rest of the pipeline relies on. This block used to be cast
 * straight through without a single check.
 */
function asSource(raw: unknown, label: string): Scene['source'] {
	if (!raw || typeof raw !== 'object') {
		fail(`${label}.source must be an object`);
	}
	const source = raw as Record<string, unknown>;

	const identifier = (key: string, pattern: RegExp): string | undefined => {
		if (source[key] === undefined) { return undefined; }
		const value = asString(source[key], `${label}.source.${key}`, { max: 120 });
		if (!pattern.test(value) || value.includes('..')) {
			fail(
				`${label}.source.${key} "${value}" must be a plain identifier — ` +
				'it becomes part of a generated file name',
			);
		}
		return value;
	};

	const featureId = identifier('featureId', FEATURE_ID_PATTERN);
	const view = identifier('view', SURFACE_ID_PATTERN);
	const tab = identifier('tab', SURFACE_ID_PATTERN);
	const anchor = identifier('anchor', ANCHOR_PATTERN);

	return {
		...(featureId !== undefined ? { featureId } : {}),
		...(view !== undefined ? { view } : {}),
		...(tab !== undefined ? { tab } : {}),
		...(anchor !== undefined ? { anchor } : {}),
	};
}

function asVersion(value: unknown): string {
	const version = asString(value, 'project.version', { max: 40 });
	if (!VERSION_PATTERN.test(version) || version.includes('..')) {
		fail(
			`project.version "${version}" is not a filename-safe release identifier ` +
			'(letters, digits, dot, dash and underscore only) — it is used to name generated files',
		);
	}
	return version;
}

/**
 * Validates and normalizes a parsed manifest.
 *
 * `requireAssets` is off while planning (screenshots have not been captured
 * yet) and on before rendering, where a missing PNG must be a hard error
 * rather than a black frame.
 */
export function validateManifest(raw: unknown, { requireAssets = false } = {}): Manifest {
	if (!raw || typeof raw !== 'object') { fail('must be a JSON object'); }
	const input = raw as Record<string, unknown>;
	const project = (input.project ?? {}) as Record<string, unknown>;

	const normalizedProject = {
		title: asString(project.title, 'project.title', { max: 200 }),
		version: asVersion(project.version),
		width: asNumber(project.width, 'project.width', 320, 7680, 1920),
		height: asNumber(project.height, 'project.height', 240, 4320, 1080),
		fps: asNumber(project.fps, 'project.fps', 10, 120, 30),
	};

	if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
		fail('scenes must be a non-empty array');
	}

	const seen = new Set<string>();
	const scenes = input.scenes.map((entry, index) => {
		const scene = (entry ?? {}) as Record<string, unknown>;
		const label = `scenes[${index}]`;

		const id = asString(scene.id, `${label}.id`, { max: 80 });
		if (!SLUG_PATTERN.test(id)) {
			fail(`${label}.id "${id}" must be a lowercase slug (a-z, 0-9, single dashes) — it becomes a file name`);
		}
		if (seen.has(id)) { fail(`duplicate scene id "${id}"`); }
		seen.add(id);

		const image = asString(scene.image, `${label}.image`, { max: 400 });
		const imageAbs = resolveInProject(image, `${label}.image`);
		if (requireAssets && !fs.existsSync(imageAbs)) {
			fail(`${label}.image "${image}" does not exist — run the \`shots\` stage first`);
		}

		const motionRaw = (scene.motion ?? {}) as Record<string, unknown>;
		const motion: SceneMotion = {
			type: asEnum(motionRaw.type, `${label}.motion.type`, MOTION_TYPES, 'zoom-in'),
			from: asNumber(motionRaw.from, `${label}.motion.from`, 1.0, 3.0, 1.0),
			to: asNumber(motionRaw.to, `${label}.motion.to`, 1.0, 3.0, 1.07),
			focusX: asNumber(motionRaw.focusX, `${label}.motion.focusX`, 0, 1, 0.5),
			focusY: asNumber(motionRaw.focusY, `${label}.motion.focusY`, 0, 1, 0.5),
		};

		const audio = scene.audio === undefined ? undefined : asString(scene.audio, `${label}.audio`, { max: 400 });
		if (audio !== undefined) {
			const audioAbs = resolveInProject(audio, `${label}.audio`);
			if (requireAssets && !fs.existsSync(audioAbs)) {
				fail(`${label}.audio "${audio}" does not exist — run the \`voice\` stage first`);
			}
		}

		const normalized: Scene = {
			id,
			image,
			// An empty title is meaningful: the cold open and the cards carry no
			// title band, because the card art already says what they are.
			title: scene.title === '' ? '' : asString(scene.title, `${label}.title`, { max: 120 }),
			narration: asString(scene.narration, `${label}.narration`, { max: 1200 }),
			motion,
			transition: asEnum(scene.transition, `${label}.transition`, TRANSITIONS, 'fade'),
			transitionSeconds: asNumber(scene.transitionSeconds, `${label}.transitionSeconds`, 0, 3, 0.6),
			...(audio !== undefined ? { audio } : {}),
			...(scene.audioSeconds !== undefined
				? { audioSeconds: asNumber(scene.audioSeconds, `${label}.audioSeconds`, 0, 600) }
				: {}),
			...(scene.durationSeconds !== undefined
				? { durationSeconds: asNumber(scene.durationSeconds, `${label}.durationSeconds`, 0.5, 600) }
				: {}),
			...(scene.source !== undefined ? { source: asSource(scene.source, label) } : {}),
		};
		return normalized;
	});

	return { project: normalizedProject, scenes };
}

export function loadManifest(file: string, options?: { requireAssets?: boolean }): Manifest {
	const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
	return validateManifest(raw, options);
}
