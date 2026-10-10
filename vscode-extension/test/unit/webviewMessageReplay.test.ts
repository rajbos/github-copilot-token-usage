import test from 'node:test';
import * as assert from 'node:assert/strict';
import { WebviewMessageReplay, type ReplayableWebviewMessage } from '../../src/webviewMessageReplay';

test('posts immediately even when the webview never announced readiness', async () => {
	// Regression: gating delivery on the readiness handshake turned a lost or late
	// `usageWebviewReady` into a permanent "Loading…" panel, because the payload was never
	// posted at all — not even to a webview that already had its listener attached.
	const delivered: ReplayableWebviewMessage[] = [];
	const replay = new WebviewMessageReplay((message) => {
		delivered.push(message);
		return true;
	});

	const result = await replay.publish('repoPrStats', { command: 'repoPrStatsLoaded', data: { repos: [] } });

	assert.equal(result.delivered, true);
	assert.equal(result.wasReady, false);
	assert.deepEqual(delivered, [{ command: 'repoPrStatsLoaded', data: { repos: [] } }]);
});

test('replays only the latest state per feature when the webview announces readiness', async () => {
	const delivered: string[] = [];
	const replay = new WebviewMessageReplay((message) => {
		delivered.push(message.command);
		return true;
	});

	await replay.publish('repoPrStats', { command: 'repoPrStatsProgress', done: 0, total: 2 });
	await replay.publish('repoPrStats', { command: 'repoPrStatsLoaded', data: { repos: [] } });
	delivered.length = 0;

	const replayed = await replay.markReady();

	assert.deepEqual(replayed, ['repoPrStats']);
	assert.deepEqual(delivered, ['repoPrStatsLoaded']);
});

test('replays results published while a replacement webview is loading', async () => {
	const delivered: string[] = [];
	const replay = new WebviewMessageReplay((message) => {
		delivered.push(message.command);
		return true;
	});

	await replay.markReady();
	await replay.publish('repoPrStats', { command: 'repoPrStatsProgress', done: 1, total: 2 });
	replay.markNotReady();
	await replay.publish('repoPrStats', { command: 'repoPrStatsLoaded', data: { repos: [] } });
	delivered.length = 0;

	await replay.markReady();

	assert.deepEqual(delivered, ['repoPrStatsLoaded']);
});

test('a repeated readiness announcement re-posts the latest state', async () => {
	// The webview announces readiness again once the layout — and therefore the target
	// containers — exists, so state posted into a container-less DOM gets re-applied.
	const delivered: string[] = [];
	const replay = new WebviewMessageReplay((message) => {
		delivered.push(message.command);
		return true;
	});

	await replay.markReady();
	await replay.publish('agentSessions', { command: 'agentSessionsLoaded', data: {} });
	delivered.length = 0;

	await replay.markReady();

	assert.deepEqual(delivered, ['agentSessionsLoaded']);
});

test('a hanging webview delivery is bounded and remains replayable', { timeout: 250 }, async () => {
	let shouldHang = true;
	const delivered: string[] = [];
	const errors: unknown[] = [];
	const replay = new WebviewMessageReplay(
		(message) => {
			if (shouldHang) { return new Promise<boolean>(() => { /* never settles */ }); }
			delivered.push(message.command);
			return true;
		},
		5,
		(error) => errors.push(error),
	);

	await replay.markReady();
	const result = await replay.publish('agentSessions', { command: 'agentSessionsLoaded', data: {} });
	assert.equal(result.delivered, false);
	assert.equal(errors.length, 1);

	shouldHang = false;
	await replay.markReady();
	assert.deepEqual(delivered, ['agentSessionsLoaded']);
});

test('reset() forgets buffered state so a later document gets nothing stale', async () => {
	// The Efficiency panel's buffered Value snapshot is derived from the data one document was
	// rendered with; replaying it into a *later* document would push stale numbers over fresher
	// bootstrap data, so that panel resets the buffer whenever it replaces its HTML.
	const delivered: string[] = [];
	const replay = new WebviewMessageReplay((message) => {
		delivered.push(message.command);
		return true;
	});

	await replay.markReady();
	await replay.publish('valueSignals', { command: 'valueSignalsUpdated', value: {} });
	delivered.length = 0;

	replay.reset();
	assert.equal(replay.isReady, false, 'the replacement document has not announced readiness yet');

	const replayed = await replay.markReady();
	assert.deepEqual(replayed, []);
	assert.deepEqual(delivered, []);
});

test('reset() cannot be outrun by a delivery that was already in flight', () => {
	// The delivery `publish()` awaits is the *timeout wrapper*, not the post: `deliver()` calls
	// send() synchronously, so a publish in flight when reset() runs has already posted to the
	// document that was live then. Nothing buffered before the reset may be posted after it.
	const sent: string[] = [];
	let resolveSend: ((delivered: boolean) => void) | undefined;
	const replay = new WebviewMessageReplay((message) => {
		sent.push(message.command);
		return new Promise<boolean>((resolve) => { resolveSend = resolve; });
	});

	const inFlight = replay.publish('valueSignals', { command: 'valueSignalsUpdated', value: {} });
	assert.deepEqual(sent, ['valueSignalsUpdated'], 'the post happens synchronously inside publish()');

	replay.reset();
	resolveSend?.(true);

	return inFlight.then(async () => {
		assert.deepEqual(sent, ['valueSignalsUpdated'], 'the settling delivery posts nothing further');
		assert.deepEqual(await replay.markReady(), [], 'and the replacement document replays nothing');
		assert.deepEqual(sent, ['valueSignalsUpdated']);
	});
});

test('reset() during a replay stops the entries it has not reached yet', async () => {
	// markReady() awaits between entries, so a reset landing mid-replay — the HTML being replaced
	// while the outgoing document announces readiness — must not keep feeding the old buffer out.
	const sent: string[] = [];
	let resetOnNextSend = false;
	const replay: WebviewMessageReplay = new WebviewMessageReplay((message) => {
		sent.push(message.command);
		// Only the replay pass resets, so the two publishes below still fill the buffer.
		if (resetOnNextSend) { replay.reset(); }
		return true;
	});

	await replay.publish('repoPrStats', { command: 'repoPrStatsLoaded', data: {} });
	await replay.publish('agentSessions', { command: 'agentSessionsLoaded', data: {} });
	sent.length = 0;
	resetOnNextSend = true;

	const replayed = await replay.markReady();

	assert.equal(sent.length, 1, 'the reset in the first delivery ends the loop');
	assert.deepEqual(replayed, ['repoPrStats']);
});

test('publishing with no panel attached is a no-op, not a throw', async () => {
	// Sign-out now publishes the unauthenticated repository-PR result unconditionally, so this
	// channel is routinely used with no panel open — `panel?.webview.postMessage(...) ?? false`
	// is what the host passes as `send`. That must report an undelivered message rather than
	// throwing, and must still buffer it for whichever document opens next.
	const delivered: string[] = [];
	let panelOpen = false;
	const replay = new WebviewMessageReplay((message) => {
		if (!panelOpen) { return false; }
		delivered.push(message.command);
		return true;
	});

	const result = await replay.publish('repoPrStats', { command: 'repoPrStatsLoaded', data: { authenticated: false, repos: [] } });

	assert.equal(result.delivered, false, 'nothing was listening');
	assert.equal(result.wasReady, false);
	assert.deepEqual(delivered, []);

	// A panel opening afterwards gets the sign-out result rather than the pre-sign-out state.
	panelOpen = true;
	assert.deepEqual(await replay.markReady(), ['repoPrStats']);
	assert.deepEqual(delivered, ['repoPrStatsLoaded']);
});
