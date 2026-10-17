/**
 * How scenes are joined.
 *
 * The hard-cut case had a bug that no amount of reading would have caught:
 * `xfade=duration=0` is accepted by FFmpeg, exits zero, and *discards the
 * second input*. Two three-second clips joined that way produce 3.03 seconds
 * rather than 6. Because it never errors, the only symptom is a scene quietly
 * missing from the finished video.
 *
 * Measured directly:
 *
 *   xfade=transition=fade:duration=0:offset=3   -> 3.03s   (second clip lost)
 *   xfade=transition=fade:duration=0.5:offset=2.5 -> 5.50s (correct)
 *   concat=n=2:v=1:a=0                          -> 6.00s   (correct)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Config } from '../config';
import type { Manifest, Scene } from '../manifest';
import { assemblyFilterGraph } from '../render';
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
		motion: { type: 'zoom-in', from: 1, to: 1.12, focusX: 0.5, focusY: 0.5 },
		transition: 'fade',
		transitionSeconds: 0.6,
		audioSeconds: 4,
		durationSeconds: 6,
		...overrides,
	} as Scene;
}

function graphFor(scenes: Scene[]): string {
	const manifest: Manifest = {
		project: { title: 't', version: '1.0.0', width: 1920, height: 1080, fps: 30 },
		scenes,
	};
	return assemblyFilterGraph(buildTimeline(manifest, config), scenes.length, 0, null, config);
}

test('a "none" transition becomes a concat, never a zero-length xfade', () => {
	const graph = graphFor([scene('a', { transition: 'none' }), scene('b')]);
	assert.match(graph, /concat=n=2:v=1:a=0/);
	assert.doesNotMatch(graph, /duration=0[^.]/, 'a zero-duration xfade silently drops a clip');
});

test('a normal transition still uses xfade, with a positive duration', () => {
	const graph = graphFor([scene('a'), scene('b')]);
	const xfade = graph.match(/xfade=transition=\w+:duration=([\d.]+)/);
	assert.ok(xfade, 'expected an xfade');
	assert.ok(Number(xfade[1]) > 0, `duration ${xfade?.[1]} must be positive`);
	assert.doesNotMatch(graph, /concat=/);
});

test('a mixed run joins each pair by its own transition', () => {
	// cut, then fade — both branches in one chain.
	const graph = graphFor([scene('a', { transition: 'none' }), scene('b'), scene('c')]);
	assert.equal((graph.match(/concat=/g) ?? []).length, 1);
	assert.equal((graph.match(/xfade=/g) ?? []).length, 1);
});

test('every clip reaches the chain', () => {
	// The dropped-clip bug showed up as an input label that nothing consumed.
	const scenes = [scene('a', { transition: 'none' }), scene('b'), scene('c')];
	const graph = graphFor(scenes);
	for (let i = 1; i < scenes.length; i++) {
		assert.match(graph, new RegExp(`\\[${i}:v\\]`), `clip ${i} is not referenced`);
	}
});
