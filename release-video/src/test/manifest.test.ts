/**
 * The manifest validator is the boundary between "text a model wrote" and
 * "arguments FFmpeg is given". These tests are about what it must refuse.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateManifest } from '../manifest';

const project = { title: 'Demo', version: '0.18.0', width: 1920, height: 1080, fps: 30 };

function sceneWith(overrides: Record<string, unknown> = {}) {
	return {
		id: 'intro',
		image: 'assets/screenshots/whatsnew.png',
		title: 'Intro',
		narration: 'Hello.',
		motion: { type: 'zoom-in', from: 1, to: 1.07, focusX: 0.5, focusY: 0.5 },
		transition: 'fade',
		transitionSeconds: 0.6,
		...overrides,
	};
}

test('a valid manifest round-trips', () => {
	const manifest = validateManifest({ project, scenes: [sceneWith()] });
	assert.equal(manifest.scenes.length, 1);
	assert.equal(manifest.scenes[0]?.motion.type, 'zoom-in');
});

test('an image outside the project root is refused', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ image: '../../../../Windows/System32/x.png' })] }),
		/resolves outside the project root/,
	);
});

test('an absolute image path is refused', () => {
	// Two different guards catch this depending on the host: on Windows the
	// containment check, on POSIX the foreign-absolute check (where "C:/..."
	// is not absolute at all). Both refuse it, which is the point.
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ image: 'C:/Windows/System32/x.png' })] }),
		/outside the project root|absolute path from another platform/,
	);
});

test('an unknown motion type is refused rather than passed to the filter graph', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ motion: { type: 'explode' } })] }),
		/motion.type must be one of/,
	);
});

test('an unknown transition is refused', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ transition: 'starwipe' })] }),
		/transition must be one of/,
	);
});

test('a scene id that is not a slug is refused — it becomes a file name', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ id: '../escape' })] }),
		/must be a lowercase slug/,
	);
});

test('duplicate scene ids are refused — they would share a cache entry', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith(), sceneWith()] }),
		/duplicate scene id/,
	);
});

test('out-of-range numbers are refused, not clamped', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ motion: { type: 'zoom-in', from: 1, to: 99 } })] }),
		/motion.to must be between/,
	);
});

test('a non-finite duration is refused', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ durationSeconds: 'soon' })] }),
		/must be a finite number/,
	);
});

test('an empty scene list is refused', () => {
	assert.throws(() => validateManifest({ project, scenes: [] }), /non-empty array/);
});

test('missing motion fields fall back to sane defaults', () => {
	const manifest = validateManifest({ project, scenes: [sceneWith({ motion: {} })] });
	assert.deepEqual(manifest.scenes[0]?.motion, { type: 'zoom-in', from: 1, to: 1.07, focusX: 0.5, focusY: 0.5 });
});

/* --------------------------------------------- provenance becomes a filename */

test('a traversal segment in source.view is refused', () => {
	// source.view is joined into the screenshot's file name, so this used to be
	// a way out of assets/screenshots entirely.
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ source: { view: '../outside' } })] }),
		/must be a plain identifier/,
	);
});

test('a traversal segment in source.tab is refused', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ source: { view: 'usage', tab: '../../etc' } })] }),
		/must be a plain identifier/,
	);
});

test('a separator in source.anchor is refused', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ source: { view: 'usage', anchor: 'a/b' } })] }),
		/must be a plain identifier/,
	);
});

test('real catalog provenance still validates', () => {
	// The dotted feature id and the dashed view/tab/anchor the catalog actually
	// produces must all survive.
	const manifest = validateManifest({
		project,
		scenes: [sceneWith({
			source: {
				featureId: 'usage.memory-files-hygiene',
				view: 'usage',
				tab: 'tools',
				anchor: 'section-memory-files',
			},
		})],
	});
	assert.equal(manifest.scenes[0]?.source?.view, 'usage');
	assert.equal(manifest.scenes[0]?.source?.anchor, 'section-memory-files');
});

test('unknown keys in source are dropped rather than carried through', () => {
	const manifest = validateManifest({
		project,
		scenes: [sceneWith({ source: { view: 'usage', somethingElse: '../evil' } })],
	});
	assert.deepEqual(Object.keys(manifest.scenes[0]?.source ?? {}), ['view']);
});

test('requireAssets turns a missing screenshot into an error, not a black frame', () => {
	assert.throws(
		() => validateManifest({ project, scenes: [sceneWith({ image: 'assets/screenshots/nope.png' })] }, { requireAssets: true }),
		/run the `shots` stage first/,
	);
});
