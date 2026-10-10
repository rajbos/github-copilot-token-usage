/**
 * Where every scene and every narration clip sits on the final timeline.
 *
 * Both the subtitle generator and the FFmpeg assembly graph need the same
 * answer to "when does scene 4 start?", and they must agree exactly or the
 * captions drift out of sync with the voice. So the arithmetic lives here,
 * once, and both stages read it.
 *
 * ## The crossfade overlap
 *
 * `xfade` does not append clips, it *overlaps* them: a 0.6 s fade between two
 * 8 s scenes produces 15.4 s, not 16. Each transition therefore pulls every
 * later scene earlier by its own duration, which is the single easiest thing
 * to get wrong when hand-writing a filter graph and the reason a naive
 * pipeline's subtitles slide further behind with every scene.
 *
 * ## Where the voice sits inside a scene
 *
 * Narration starts a beat *after* the scene does, so the viewer sees the new
 * screen and the title band land before anyone starts talking. The remaining
 * padding falls at the end of the scene, which also means the last word is
 * never clipped by the following transition.
 */

import type { Config } from './config';
import type { Manifest, Scene } from './manifest';

export interface TimelineEntry {
	readonly scene: Scene;
	readonly index: number;
	/** Seconds from the start of the video to the first frame of this scene. */
	readonly start: number;
	/** Full length of the scene's own clip, before any overlap is applied. */
	readonly duration: number;
	/** Seconds from the start of the video to the first sample of this scene's narration. */
	readonly audioStart: number;
	readonly audioDuration: number;
	/** Crossfade into the *next* scene, in seconds. Zero on the last scene. */
	readonly transitionOut: number;
	readonly transitionName: string;
}

export interface Timeline {
	readonly entries: readonly TimelineEntry[];
	/** Length of the assembled video, accounting for every crossfade overlap. */
	readonly totalSeconds: number;
}

/** How much of a scene's padding is spent before the voice starts. */
const LEAD_IN_SHARE = 0.55;

/** Silence kept between the last word and the start of the crossfade. */
const TAIL_SECONDS = 0.15;

/**
 * A scene's length before any transition-driven extension.
 *
 * Every scene has one of these whether or not the manifest states it, which is
 * what lets a scene be clamped against its *neighbour's* real length rather
 * than against a stand-in.
 */
function baseDuration(scene: Manifest['scenes'][number], config: Config): number {
	return scene.durationSeconds
		?? Math.max(config.motion.minSceneSeconds, (scene.audioSeconds ?? 0) + config.motion.paddingSeconds);
}

export function buildTimeline(manifest: Manifest, config: Config): Timeline {
	const entries: TimelineEntry[] = [];
	let cursor = 0;

	// Computed for every scene up front, because clamping scene N's transition
	// needs scene N+1's length. Falling back to the *current* scene's duration
	// when the next one omitted `durationSeconds` — as this used to — meant a
	// long scene followed by a short, audio-less one could keep a transition
	// longer than half the next clip, which is exactly the case the clamp is
	// there to prevent. Extending a scene later only ever makes it longer, so
	// clamping against these pre-extension lengths stays conservative.
	const baseDurations = manifest.scenes.map((scene) => baseDuration(scene, config));

	manifest.scenes.forEach((scene, index) => {
		const audioDuration = scene.audioSeconds ?? 0;
		let duration = baseDurations[index] ?? baseDuration(scene, config);

		const isLast = index === manifest.scenes.length - 1;
		// A transition can never eat more than the shorter neighbouring scene,
		// or xfade's offset would go negative and FFmpeg would fail late, deep
		// in the graph, with a message that does not name the scene.
		const requested = isLast || scene.transition === 'none' ? 0 : scene.transitionSeconds;
		const nextDuration = baseDurations[index + 1] ?? duration;
		let transitionOut = Math.max(0, Math.min(requested, duration / 2, nextDuration / 2));

		const padding = Math.max(0, duration - audioDuration);
		const leadIn = Math.min(padding * LEAD_IN_SHARE, 1.2);

		// The scene has to be long enough to hold everything it is asked to
		// hold: the lead-in before the voice, the voice itself, a breath, and
		// the crossfade out. Configured padding alone does not guarantee this —
		// a 0.7s pad against a 0.6s transition leaves the last 0.28s of every
		// line playing underneath the next screen. Rather than make that the
		// operator's problem to notice, the scene is extended to fit.
		duration = Math.max(duration, leadIn + audioDuration + TAIL_SECONDS + transitionOut);
		transitionOut = Math.max(0, Math.min(transitionOut, duration / 2, nextDuration / 2));

		entries.push({
			scene,
			index,
			start: Number(cursor.toFixed(3)),
			duration: Number(duration.toFixed(3)),
			audioStart: Number((cursor + leadIn).toFixed(3)),
			audioDuration: Number(audioDuration.toFixed(3)),
			transitionOut: Number(transitionOut.toFixed(3)),
			transitionName: scene.transition === 'dissolve' ? 'fade' : scene.transition,
		});

		cursor += duration - transitionOut;
	});

	const last = entries[entries.length - 1];
	const totalSeconds = last ? Number((last.start + last.duration).toFixed(3)) : 0;
	return { entries, totalSeconds };
}
