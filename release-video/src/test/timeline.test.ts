/**
 * The timeline is the one piece of arithmetic in this pipeline that two
 * independent consumers depend on agreeing — the subtitle cues and the
 * `xfade` offsets. If it is wrong, captions drift further behind with every
 * scene, and the failure is gradual enough to be missed in a short test video
 * and obvious in a long real one. Hence these.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Config } from '../config';
import type { Manifest, Scene } from '../manifest';
import { buildTimeline } from '../timeline';

const config = {
	motion: { minSceneSeconds: 3, paddingSeconds: 0.7, transitionSeconds: 0.6 },
} as unknown as Config;

function scene(id: string, overrides: Partial<Scene> = {}): Scene {
	return {
		id,
		image: `assets/screenshots/${id}.png`,
		title: id,
		narration: 'Something happened.',
		motion: { type: 'zoom-in', from: 1, to: 1.07, focusX: 0.5, focusY: 0.5 },
		transition: 'fade',
		transitionSeconds: 0.6,
		// Short enough that the "extend to fit the speech" rule does not fire,
		// so tests about overlap arithmetic measure only overlap arithmetic.
		audioSeconds: 4,
		durationSeconds: 6,
		...overrides,
	} as Scene;
}

function manifestOf(scenes: Scene[]): Manifest {
	return { project: { title: 't', version: '1.0.0', width: 1920, height: 1080, fps: 30 }, scenes };
}

test('crossfades overlap, so the total is shorter than the sum of the scenes', () => {
	const { entries, totalSeconds } = buildTimeline(manifestOf([scene('a'), scene('b'), scene('c')]), config);

	// 3 x 6s with 2 x 0.6s of overlap.
	assert.equal(totalSeconds, 16.8);
	assert.deepEqual(entries.map((entry) => entry.start), [0, 5.4, 10.8]);
});

test('the last scene never fades out', () => {
	const { entries } = buildTimeline(manifestOf([scene('a'), scene('b')]), config);
	assert.equal(entries[1]?.transitionOut, 0);
});

test('a "none" transition is a hard cut with no overlap', () => {
	const { entries, totalSeconds } = buildTimeline(
		manifestOf([scene('a', { transition: 'none' }), scene('b')]),
		config,
	);
	assert.equal(entries[0]?.transitionOut, 0);
	assert.equal(entries[1]?.start, 6);
	assert.equal(totalSeconds, 12);
});

test('a transition can never exceed half of either neighbouring scene', () => {
	// A 4s transition between two 2s scenes would make xfade's offset negative
	// and fail deep inside the assembly graph.
	const { entries } = buildTimeline(
		manifestOf([
			scene('a', { durationSeconds: 2, audioSeconds: 0.5, transitionSeconds: 4 }),
			scene('b', { durationSeconds: 2, audioSeconds: 0.5 }),
		]),
		config,
	);
	assert.equal(entries[0]?.transitionOut, 1);
	assert.ok((entries[1]?.start ?? -1) >= 0);
});

test('narration starts after the scene does, and never before it', () => {
	const { entries } = buildTimeline(manifestOf([scene('a'), scene('b')]), config);
	for (const entry of entries) {
		assert.ok(entry.audioStart >= entry.start, `${entry.scene.id} speaks before it appears`);
		assert.ok(entry.audioStart < entry.start + entry.duration);
	}
});

test('scene starts are exactly the xfade offsets the renderer uses', () => {
	// The renderer reads `entry.start` as each xfade's offset. Re-derive it the
	// long way here: the chain's length after i fades must equal start[i+1].
	const scenes = [scene('a'), scene('b', { durationSeconds: 9 }), scene('c', { durationSeconds: 4 })];
	const { entries } = buildTimeline(manifestOf(scenes), config);

	let chainEnd = entries[0]?.duration ?? 0;
	for (let i = 1; i < entries.length; i++) {
		const transition = entries[i - 1]?.transitionOut ?? 0;
		const offset = chainEnd - transition;
		assert.equal(Number(offset.toFixed(3)), entries[i]?.start, `offset mismatch at scene ${i}`);
		chainEnd = offset + (entries[i]?.duration ?? 0);
	}
});

test('narration always finishes before the crossfade into the next scene', () => {
	// The QA stage checks exactly this on the rendered file. It should never be
	// able to fail: a scene too short to hold its own lead-in, speech and
	// transition is extended here, not reported later.
	const { entries } = buildTimeline(
		manifestOf([scene('a'), scene('b'), scene('c', { audioSeconds: 5.9, durationSeconds: 6 })]),
		config,
	);
	for (const entry of entries) {
		const speechEnd = entry.audioStart + entry.audioDuration;
		const fadeStart = entry.start + entry.duration - entry.transitionOut;
		assert.ok(speechEnd <= fadeStart + 1e-6, `${entry.scene.id} is still talking when the next scene arrives`);
	}
});

test('a transition is clamped against the next scene even when it omits durationSeconds', () => {
	// The regression: the clamp used to fall back to the *current* scene's
	// duration when the next one had none, so a long scene followed by a short
	// audio-less one kept a transition longer than half the next clip — and
	// xfade then gets an offset it cannot honour.
	const { entries } = buildTimeline(
		manifestOf([
			scene('a', { durationSeconds: 20, audioSeconds: 4, transitionSeconds: 4 }),
			// No durationSeconds: its real length is the 3s minimum.
			scene('b', { durationSeconds: undefined, audioSeconds: 0 }),
		]),
		config,
	);

	const next = entries[1];
	assert.ok(next, 'expected a second scene');
	assert.ok(
		(entries[0]?.transitionOut ?? 0) <= next.duration / 2 + 1e-9,
		`transition ${entries[0]?.transitionOut}s exceeds half of the ${next.duration}s scene it fades into`,
	);
});

test('no scene ever fades for longer than half of either neighbour', () => {
	const { entries } = buildTimeline(
		manifestOf([
			scene('a', { durationSeconds: 18, transitionSeconds: 5 }),
			scene('b', { durationSeconds: undefined, audioSeconds: 0.2 }),
			scene('c', { durationSeconds: 30, audioSeconds: 25 }),
			scene('d', { durationSeconds: undefined, audioSeconds: 0 }),
		]),
		config,
	);

	for (let i = 0; i < entries.length - 1; i++) {
		const here = entries[i];
		const next = entries[i + 1];
		if (!here || !next) { continue; }
		assert.ok(here.transitionOut <= here.duration / 2 + 1e-9, `${here.scene.id} over-fades itself`);
		assert.ok(here.transitionOut <= next.duration / 2 + 1e-9, `${here.scene.id} over-fades into ${next.scene.id}`);
		assert.ok(next.start >= here.start, 'scenes must not run backwards');
	}
});

test('a scene with no measured audio still gets a minimum length', () => {
	const { entries } = buildTimeline(
		manifestOf([scene('a', { audioSeconds: 0, durationSeconds: undefined })]),
		config,
	);
	assert.equal(entries[0]?.duration, 3);
});
