/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
	markUsageLoadingInactive,
	renderUsageLoadingState,
	resetUsageLoadingSteps,
	updateUsageLoadingProgress,
} from '../../src/webview/usage/usageLoadingCard';

function mount(withRoot = true): Document {
	const dom = new JSDOM(`<!DOCTYPE html><html><body>${withRoot ? '<div id="root"></div>' : ''}</body></html>`);
	(globalThis as { document?: Document }).document = dom.window.document as unknown as Document;
	resetUsageLoadingSteps();
	return dom.window.document as unknown as Document;
}

test('renderUsageLoadingState draws the card with the initial message', () => {
	const doc = mount();
	renderUsageLoadingState('Warming up');

	assert.ok(doc.getElementById('usage-loading-card'), 'the loading card renders into #root');
	assert.ok(doc.getElementById('root')!.textContent!.includes('Warming up'));
});

test('renderUsageLoadingState is a no-op without a #root element', () => {
	const doc = mount(false);
	assert.doesNotThrow(() => renderUsageLoadingState());
	assert.equal(doc.getElementById('usage-loading-card'), null);
});

test('a known progress stage advances the bar, percentage and subtitle', () => {
	const doc = mount();
	renderUsageLoadingState();
	updateUsageLoadingProgress({ stage: 'curation:mcpJson' });

	assert.equal(doc.getElementById('ul-pct')!.textContent, '44%');
	assert.equal(doc.getElementById('ul-fill')!.style.width, '44%');
	assert.equal(doc.getElementById('ul-subtitle')!.textContent, 'Scanning MCP config files…');
});

test('unknown or malformed progress messages leave the card untouched', () => {
	const doc = mount();
	renderUsageLoadingState();
	const before = doc.getElementById('ul-pct')!.textContent;

	updateUsageLoadingProgress({ stage: 'nope' });
	updateUsageLoadingProgress(null);
	updateUsageLoadingProgress({ stage: 42 });

	assert.equal(doc.getElementById('ul-pct')!.textContent, before);
});

test('progress after the card was removed recreates it only while loading is active', () => {
	const doc = mount();
	renderUsageLoadingState();
	doc.getElementById('root')!.replaceChildren();

	let recreated = 0;
	updateUsageLoadingProgress({ stage: 'start' }, () => { recreated++; });
	assert.ok(doc.getElementById('usage-loading-card'), 'an active loading run rebuilds the card');
	assert.equal(recreated, 1, 'and tells the caller so it can re-arm lazy tab loads');

	doc.getElementById('root')!.replaceChildren();
	markUsageLoadingInactive();
	updateUsageLoadingProgress({ stage: 'start' }, () => { recreated++; });
	assert.equal(doc.getElementById('usage-loading-card'), null, 'an inactive run must not resurrect the card');
	assert.equal(recreated, 1);
});
