/**
 * Every case here is a real entry from this repository's What's New catalog,
 * and every expectation is about the difference between text written to be
 * *read beside the thing it describes* and text written to be *listened to*.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ResolvedFeature } from '../catalog';
import { describeBehaviour, featureNarration } from '../narration';

function feature(overrides: Partial<ResolvedFeature> = {}): ResolvedFeature {
	return {
		id: 'usage.corrections-tab',
		titleKey: 'k',
		descriptionKey: 'k',
		title: 'Corrections tab',
		description: 'Shows the moments where things went sideways.',
		kind: 'tab',
		surface: { view: 'usage', tab: 'corrections' },
		...overrides,
	} as ResolvedFeature;
}

test('the narration says where you are, in the words on screen', () => {
	const text = featureNarration(feature(), { index: 1, previousView: 'diagnostics' });
	assert.match(text, /the Usage Analysis view/);
	// Never the raw id a listener has never seen.
	assert.doesNotMatch(text, /\busage\b/);
});

test('a title that already ends in "tab" does not get a second one', () => {
	const text = featureNarration(feature(), { index: 0 });
	assert.match(text, /a new tab called Corrections\./);
	assert.doesNotMatch(text, /Corrections tab/);
});

test('a nested tab is named the way people say it, not the way the UI draws it', () => {
	// The catalog title is "Research → TTFT"; spoken verbatim the arrow becomes
	// "Research then TTFT", which is nobody's name for that tab.
	const text = featureNarration(
		feature({
			title: 'Research → TTFT',
			kind: 'tab',
			surface: { view: 'diagnostics', tab: 'ttft' },
		}),
		{ index: 2 },
	);
	assert.match(text, /a new tab called TTFT, under Research\./);
	assert.doesNotMatch(text, /then/);
});

test('a section is addressed by its tab as well as its view', () => {
	const text = featureNarration(
		feature({
			title: 'Copilot Memory Files',
			kind: 'section',
			description: 'A new section on the Tools tab showing how much memory has accumulated.',
			surface: { view: 'usage', tab: 'tools', anchor: 'section-memory-files' },
		}),
		{ index: 0 },
	);
	assert.match(text, /on the Tools and Integrations tab/);
	assert.match(text, /a new section called Copilot Memory Files/);
});

test('staying on a view is not announced as a move', () => {
	const stayed = featureNarration(feature(), { index: 3, previousView: 'usage' });
	assert.match(stayed, /^(Staying|Still|Also) in the Usage Analysis view/);

	const moved = featureNarration(feature(), { index: 3, previousView: 'logviewer' });
	assert.match(moved, /^(Over in|Next, in|Moving to) the Usage Analysis view/);
});

test('narration is deterministic, so the same release always reads the same', () => {
	const context = { index: 2, previousView: 'diagnostics' };
	assert.equal(featureNarration(feature(), context), featureNarration(feature(), context));
});

/* ----------------------------------------------- restoring the subject */

test('a headless verb gets its subject back', () => {
	assert.equal(
		describeBehaviour('Shows the moments where things went sideways.'),
		'It shows the moments where things went sideways.',
	);
});

test('a self-describing opener is not repeated after the location sentence', () => {
	// The location sentence has just said "on the Tools tab, a new section", so
	// repeating it would be the third time the listener hears it.
	assert.equal(
		describeBehaviour('A new section on the Tools tab showing how much memory has accumulated on disk.'),
		'It shows how much memory has accumulated on disk.',
	);
});

test('a noun phrase answering a question becomes a statement', () => {
	assert.equal(
		describeBehaviour('How long each model takes to start answering you.'),
		'It shows how long each model takes to start answering you.',
	);
});

test('a sentence that already has a subject is left alone', () => {
	const original = 'When a Copilot CLI session runs on HydraFusion, several models draft one answer.';
	assert.equal(describeBehaviour(original), original);
});

test('a leading product name keeps its capital', () => {
	assert.equal(
		describeBehaviour('Lists Copilot conversations from your account.'),
		'It lists Copilot conversations from your account.',
	);
});
