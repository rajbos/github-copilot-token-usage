/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { SurfaceRevealQueue } from '../../src/whatsNew/surfaceRevealQueue';
import { cancelReveal, flashSection, installSurfaceNavigation, preferredScrollBehavior, revealSurface } from '../../src/webview/shared/surfaceNavigation';

// ── Host side: the request handshake ─────────────────────────────────────

type Panel = { name: string };
type Nav = { tab?: string; anchor?: string };

function makeQueue(start = 1_000) {
	let now = start;
	const queue = new SurfaceRevealQueue<'usage' | 'chart', Nav, Panel>(60_000, () => now);
	return { queue, advance: (ms: number) => { now += ms; } };
}

test('surface reveal queue: a new panel gets the request on ready, until it acknowledges', () => {
	const { queue } = makeQueue();
	const panel = { name: 'new' };
	queue.request('chart', { anchor: 'a' }, undefined);
	assert.equal(queue.opened('chart', panel), null, 'a new panel waits for its ready handshake');
	assert.deepEqual(queue.ready('chart', panel), { anchor: 'a' });
	// Not yet acknowledged: a reload of the same panel retries.
	assert.deepEqual(queue.ready('chart', panel), { anchor: 'a' });
	queue.handled('chart');
	assert.equal(queue.ready('chart', panel), null);
});

test('surface reveal queue: a ready that beats the opener is delivered to the new panel', () => {
	const { queue } = makeQueue();
	const panel = { name: 'new' };
	queue.request('chart', { anchor: 'a' }, undefined);
	assert.deepEqual(queue.ready('chart', panel), { anchor: 'a' });
	queue.handled('chart');
	assert.equal(queue.opened('chart', panel), null, 'already delivered and handled');
});

test('surface reveal queue: a reused panel is posted to directly and still retried on reload', () => {
	const { queue } = makeQueue();
	const panel = { name: 'existing' };
	queue.request('chart', { tab: 't' }, panel);
	assert.deepEqual(queue.opened('chart', panel), { tab: 't' });
	assert.deepEqual(queue.ready('chart', panel), { tab: 't' }, 'a hidden panel reloading on reveal still gets it');
	queue.handled('chart');
	assert.equal(queue.peek('chart'), undefined);
});

test('surface reveal queue: a ready from the reused panel before the opener returns is held, not dropped', () => {
	const { queue } = makeQueue();
	const panel = { name: 'existing' };
	queue.request('chart', { tab: 't' }, panel);
	assert.equal(queue.ready('chart', panel), null);
	assert.deepEqual(queue.peek('chart'), { tab: 't' });
	assert.deepEqual(queue.opened('chart', panel), { tab: 't' });
});

test('surface reveal queue: a panel the opener replaced cannot claim the request', () => {
	const { queue } = makeQueue();
	const old = { name: 'old' };
	const recreated = { name: 'recreated' };
	queue.request('chart', { anchor: 'a' }, old);
	assert.equal(queue.opened('chart', recreated), null);
	assert.equal(queue.ready('chart', old), null);
	assert.equal(queue.peek('chart'), undefined, 'dropped rather than replayed somewhere unexpected');
});

test('surface reveal queue: a panel the user reopened by hand is never redirected', () => {
	const { queue } = makeQueue();
	const intended = { name: 'intended' };
	const reopened = { name: 'reopened' };
	queue.request('chart', { anchor: 'a' }, undefined);
	queue.opened('chart', intended);
	assert.equal(queue.ready('chart', reopened), null);
	assert.equal(queue.ready('chart', intended), null, 'the request is gone, not just skipped once');
});

test('surface reveal queue: a request expires after the TTL', () => {
	const { queue, advance } = makeQueue();
	const panel = { name: 'new' };
	queue.request('chart', { anchor: 'a' }, undefined);
	queue.opened('chart', panel);
	advance(60_001);
	assert.equal(queue.ready('chart', panel), null);
	assert.equal(queue.peek('chart'), undefined);
});

test('surface reveal queue: a newer request replaces an older one, and a late opener delivers the newer', () => {
	const { queue } = makeQueue();
	const panel = { name: 'existing' };
	queue.request('chart', { anchor: 'old' }, panel);
	queue.request('chart', { anchor: 'new' }, panel);
	assert.deepEqual(queue.opened('chart', panel), { anchor: 'new' });
});

test('surface reveal queue: an opener that left no panel drops the request, and views are independent', () => {
	const { queue } = makeQueue();
	queue.request('chart', { anchor: 'a' }, undefined);
	queue.request('usage', { tab: 'tools' }, undefined);
	assert.equal(queue.opened('chart', undefined), null);
	assert.equal(queue.peek('chart'), undefined);
	assert.deepEqual(queue.peek('usage'), { tab: 'tools' });
	queue.clear('usage');
	assert.equal(queue.peek('usage'), undefined);
});

test('surface reveal queue: a late acknowledgement for a replaced request leaves the newer one held', () => {
	const { queue } = makeQueue();
	const panel = { name: 'existing' };
	const first = queue.request('chart', { anchor: 'old' }, panel);
	const second = queue.request('chart', { anchor: 'new' }, panel);
	assert.notEqual(first, second);
	queue.handled('chart', first);
	assert.deepEqual(queue.peek('chart'), { anchor: 'new' });
	assert.equal(queue.currentId('chart'), second);
	queue.handled('chart', second);
	assert.equal(queue.peek('chart'), undefined);
});

test('surface reveal queue: a panel bound at creation cannot be replaced by one reopened by hand before the opener resolves', () => {
	const { queue } = makeQueue();
	const created = { name: 'created' };
	const reopened = { name: 'reopened' };
	queue.request('chart', { anchor: 'a' }, undefined);
	queue.bind('chart', created);
	// The user closes `created` while its opener still loads data, then reopens the view.
	assert.equal(queue.ready('chart', reopened), null);
	assert.equal(queue.peek('chart'), undefined);
	assert.equal(queue.opened('chart', reopened), null);
});

test('surface reveal queue: an opener that resolves on a different panel than the bound one drops the request', () => {
	const { queue } = makeQueue();
	queue.request('chart', { anchor: 'a' }, undefined);
	queue.bind('chart', { name: 'created' });
	assert.equal(queue.opened('chart', { name: 'other' }), null);
	assert.equal(queue.peek('chart'), undefined);
});

test('surface reveal queue: bind ignores the panel being replaced and an already-bound request', () => {
	const { queue } = makeQueue();
	const existing = { name: 'existing' };
	queue.request('chart', { tab: 't' }, existing);
	queue.bind('chart', existing);
	assert.deepEqual(queue.opened('chart', existing), { tab: 't' }, 'still treated as a reused panel');
});

test('surface reveal queue: an opener that settles after the TTL does not deliver to a reused panel', () => {
	const { queue, advance } = makeQueue();
	const panel = { name: 'existing' };
	queue.request('chart', { tab: 't' }, panel);
	advance(60_001);
	assert.equal(queue.opened('chart', panel), null);
	assert.equal(queue.peek('chart'), undefined);
});

// ── Webview side: carrying out a reveal ──────────────────────────────────

/** Installs a jsdom document as the globals the webview helper reads, and records scrolls. */
function installDom(html: string): { window: JSDOM['window']; scrolled: string[] } {
	const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
	const scrolled: string[] = [];
	dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { scrolled.push(this.id); };
	const globals = globalThis as unknown as Record<string, unknown>;
	globals.document = dom.window.document;
	globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
	globals.window = dom.window;
	return { window: dom.window, scrolled };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('revealSurface: opens the tab\'s group, clicks the tab, then scrolls to the section', async () => {
	const { window, scrolled } = installDom(`
		<button class="group-tab" data-group="workspace">Workspace</button>
		<div class="tab-bar leaf-tabs" data-group="workspace"><button class="tab-button" data-tab="tools">Tools</button></div>
		<div id="section-x">Section</div>`);
	const clicks: string[] = [];
	window.document.querySelector('.group-tab')!.addEventListener('click', () => clicks.push('group'));
	window.document.querySelector('.tab-button')!.addEventListener('click', () => clicks.push('tab'));
	assert.equal(await revealSurface({ command: 'revealSurface', tab: 'tools', anchor: 'section-x' }, 500, 150), true);
	assert.deepEqual(clicks, ['group', 'tab']);
	await sleep(80);
	assert.deepEqual(scrolled, ['section-x']);
});

test('revealSurface: waits for content that renders later', async () => {
	const { window } = installDom('<div id="root"></div>');
	setTimeout(() => {
		const late = window.document.createElement('div');
		late.id = 'late';
		window.document.getElementById('root')!.append(late);
	}, 150);
	assert.equal(await revealSurface({ command: 'revealSurface', anchor: 'late' }, 2_000, 150), true);
});

test('revealSurface: reports failure when the section never appears, so the host keeps the request', async () => {
	installDom('<div id="root"></div>');
	assert.equal(await revealSurface({ command: 'revealSurface', anchor: 'never' }, 250, 150), false);
	assert.equal(await revealSurface({ command: 'revealSurface', tab: 'missing', anchor: 'root' }, 250, 150), false);
});

test('revealSurface: a newer request supersedes one still waiting', async () => {
	const { window } = installDom('<div id="here">Here</div>');
	const first = revealSurface({ command: 'revealSurface', anchor: 'not-yet' }, 2_000, 150);
	const second = revealSurface({ command: 'revealSurface', anchor: 'here' }, 2_000, 150);
	assert.equal(await second, true);
	const late = window.document.createElement('div');
	late.id = 'not-yet';
	window.document.body.append(late);
	assert.equal(await first, false, 'the older reveal must not scroll away from the newer one');
});

test('revealSurface: scrolls to the fresh section when the panel replaces its DOM mid-reveal', async () => {
	const { window, scrolled } = installDom('<div id="root"><div id="section-x" data-gen="cached"></div></div>');
	const reveal = revealSurface({ command: 'revealSurface', anchor: 'section-x' }, 2_000, 150);
	// The dashboard swaps cached data for fresh inside the paint delay.
	const root = window.document.getElementById('root')!;
	const fresh = window.document.createElement('div');
	fresh.id = 'section-x';
	fresh.dataset.gen = 'fresh';
	root.replaceChildren(fresh);
	assert.equal(await reveal, true);
	assert.deepEqual(scrolled, ['section-x']);
	assert.equal(fresh.style.boxShadow !== '', true, 'the live element is the one highlighted');
});

test('revealSurface: switches to the tab that controls a hidden section', async () => {
	const { window } = installDom(`
		<button id="tab-azure" aria-controls="azure-content">Azure</button>
		<div id="azure-content" style="display: none"><div id="section-personal-summary">Summary</div></div>`);
	let clicked = false;
	window.document.getElementById('tab-azure')!.addEventListener('click', () => {
		clicked = true;
		window.document.getElementById('azure-content')!.style.display = '';
	});
	assert.equal(await revealSurface({ command: 'revealSurface', anchor: 'section-personal-summary' }, 500, 150), true);
	assert.equal(clicked, true);
});

test('flashSection: overlapping flashes restore the original inline styles', async (t) => {
	const { window } = installDom('<div id="s" style="box-shadow: 1px 1px red; transition: opacity 1s"></div>');
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const target = window.document.getElementById('s') as HTMLElement;
	flashSection(target);
	t.mock.timers.tick(1_000);
	flashSection(target);
	t.mock.timers.tick(2_000);
	assert.equal(target.style.boxShadow, '1px 1px red');
	assert.equal(target.style.transition, 'opacity 1s');
});

test('installSurfaceNavigation: reports ready, then acknowledges a reveal only once it has landed', async () => {
	const { window } = installDom('<div id="present">Here</div>');
	const posted: unknown[] = [];
	installSurfaceNavigation({ postMessage: (message: unknown) => { posted.push(message); } }, 'chart');
	assert.deepEqual(posted, [{ command: 'surfaceNavReady', view: 'chart' }]);

	// A reveal whose section is not there yet: no acknowledgement, so the host keeps the request.
	window.dispatchEvent(new window.MessageEvent('message', { data: { command: 'revealSurface', anchor: 'later' } }));
	await sleep(250);
	assert.equal(posted.length, 1);

	// A reveal that lands — superseding the one still waiting — is acknowledged once.
	window.dispatchEvent(new window.MessageEvent('message', { data: { command: 'revealSurface', requestId: 7, anchor: 'present' } }));
	await sleep(2_300); // the default settle window must pass before the acknowledgement
	assert.deepEqual(posted.slice(1), [{ command: 'surfaceRevealHandled', view: 'chart', requestId: 7 }]);

	// The superseded reveal never acknowledges, even once its section appears.
	const late = window.document.createElement('div');
	late.id = 'later';
	window.document.body.append(late);
	await sleep(250);
	assert.equal(posted.length, 2);

	// Unrelated messages are ignored.
	window.dispatchEvent(new window.MessageEvent('message', { data: { command: 'updateStats' } }));
	await sleep(50);
	assert.equal(posted.length, 2);
});

test('cancelReveal: a reveal still waiting never scrolls once the user opened the view itself', async () => {
	const { window, scrolled } = installDom('<div id="root"></div>');
	const waiting = revealSurface({ command: 'revealSurface', anchor: 'async-section' }, 2_000, 150);
	cancelReveal();
	const late = window.document.createElement('div');
	late.id = 'async-section';
	window.document.getElementById('root')!.append(late);
	assert.equal(await waiting, false);
	await sleep(80);
	assert.deepEqual(scrolled, []);
});

test('installSurfaceNavigation: a cancelReveal message abandons the waiting reveal without acknowledging it', async () => {
	const { window, scrolled } = installDom('<div id="root"></div>');
	const posted: unknown[] = [];
	installSurfaceNavigation({ postMessage: (message: unknown) => { posted.push(message); } }, 'dashboard');
	window.dispatchEvent(new window.MessageEvent('message', { data: { command: 'revealSurface', anchor: 'slow' } }));
	await sleep(50);
	window.dispatchEvent(new window.MessageEvent('message', { data: { command: 'cancelReveal' } }));
	const late = window.document.createElement('div');
	late.id = 'slow';
	window.document.getElementById('root')!.append(late);
	await sleep(250);
	assert.deepEqual(posted, [{ command: 'surfaceNavReady', view: 'dashboard' }]);
	assert.deepEqual(scrolled, []);
});

test('revealSurface: a cancelled or superseded reveal stops polling at once instead of running out its budget', async () => {
	installDom('<div id="root"></div>');
	const started = Date.now();
	const cancelled = revealSurface({ command: 'revealSurface', anchor: 'never' }, 10_000, 150);
	await sleep(50);
	cancelReveal();
	assert.equal(await cancelled, false);
	const superseded = revealSurface({ command: 'revealSurface', anchor: 'never-either' }, 10_000, 150);
	await sleep(50);
	void revealSurface({ command: 'revealSurface' }, 10_000, 150);
	assert.equal(await superseded, false);
	assert.ok(Date.now() - started < 1_000, 'both waits ended within a poll interval of being abandoned');
});

test('preferredScrollBehavior: instant under prefers-reduced-motion, smooth otherwise', () => {
	const { window } = installDom('');
	const setReduced = (reduce: boolean) => {
		(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia =
			(query: string) => ({ matches: reduce && query.includes('prefers-reduced-motion: reduce') });
	};
	setReduced(true);
	assert.equal(preferredScrollBehavior(), 'auto');
	setReduced(false);
	assert.equal(preferredScrollBehavior(), 'smooth');
});

test('revealSurface: follows a section the panel re-renders after landing, and only then reports success', async () => {
	// The dashboard renders cached data, then replaces its whole root with fresh data.
	const { window, scrolled } = installDom('<div id="root"><div id="section-x" data-gen="cached"></div></div>');
	let settled = false;
	const reveal = revealSurface({ command: 'revealSurface', anchor: 'section-x' }, 5_000, 400).then((landed) => {
		settled = true;
		return landed;
	});
	await sleep(150); // landed on the cached node
	assert.deepEqual(scrolled, ['section-x']);
	const fresh = window.document.createElement('div');
	fresh.id = 'section-x';
	fresh.dataset.gen = 'fresh';
	window.document.getElementById('root')!.replaceChildren(fresh);
	await sleep(150);
	assert.equal(settled, false, 'not acknowledged while the landing is still moving');
	assert.equal(await reveal, true);
	assert.deepEqual(scrolled, ['section-x', 'section-x'], 'landed again on the fresh node');
	assert.notEqual(fresh.style.boxShadow, '', 'the fresh node is the one highlighted');
});
