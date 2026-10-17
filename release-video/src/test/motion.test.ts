/**
 * Smooth motion has one hard requirement, and it is easy to violate by
 * accident: `zoompan` crops in whole source pixels, so if the crop rectangle
 * moves less than a pixel between two output frames, those frames are
 * identical and the move judders.
 *
 * The first cut of this pipeline failed exactly this way — a frame-difference
 * trace showed every other frame was a byte-for-byte duplicate — so the
 * requirement is asserted here rather than left to be noticed by eye.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Scene } from '../manifest';
import { supersampleFor } from '../render';

const WIDTH = 1920;
const FPS = 30;

function motion(from: number, to: number): Scene['motion'] {
	return { type: 'zoom-in', from, to, focusX: 0.5, focusY: 0.5 };
}

/** Source pixels the crop edge travels per output frame at a given supersample. */
function pixelsPerFrame(m: Scene['motion'], frames: number, supersample: number): number {
	return (WIDTH * supersample * Math.abs(1 / m.from - 1 / m.to)) / frames;
}

test('the crop moves at least a pixel per frame for a typical scene', () => {
	const frames = 20 * FPS;
	const m = motion(1.0, 1.12);
	const supersample = supersampleFor(m, frames, WIDTH);
	assert.ok(
		pixelsPerFrame(m, frames, supersample) >= 1,
		`${pixelsPerFrame(m, frames, supersample).toFixed(2)} px/frame at ${supersample}x — frames would duplicate`,
	);
});

test('the same holds for a long scene with a shallow zoom', () => {
	// The worst case: little zoom spread over a lot of frames. This is the
	// combination that produced the original judder (1.0 -> 1.07 over 20s).
	const frames = 25 * FPS;
	const m = motion(1.0, 1.07);
	const supersample = supersampleFor(m, frames, WIDTH);
	assert.ok(pixelsPerFrame(m, frames, supersample) >= 1);
});

test('a zoom out is measured the same as a zoom in', () => {
	const frames = 17 * FPS;
	const outward = supersampleFor(motion(1.06, 1.0), frames, WIDTH);
	const inward = supersampleFor(motion(1.0, 1.06), frames, WIDTH);
	assert.equal(outward, inward);
	assert.ok(pixelsPerFrame(motion(1.06, 1.0), frames, outward) >= 1);
});

test('a short punchy zoom does not waste memory on supersampling', () => {
	// 3s of 1.0 -> 1.2 already moves plenty; upscaling 6x would cost a lot of
	// RAM for nothing.
	assert.equal(supersampleFor(motion(1.0, 1.2), 3 * FPS, WIDTH), 2);
});

test('supersampling is capped so a frame stays in memory', () => {
	// An extreme ask — a 60s scene with a 1% zoom — cannot be made smooth by
	// upscaling alone. It must clamp rather than try to allocate a 20x frame.
	const supersample = supersampleFor(motion(1.0, 1.01), 60 * FPS, WIDTH);
	assert.ok(supersample <= 6, `${supersample}x would be 11520px wide or more`);
});

test('a still scene asks for no supersampling budget', () => {
	assert.equal(supersampleFor(motion(1.0, 1.0), 10 * FPS, WIDTH), 2);
});
