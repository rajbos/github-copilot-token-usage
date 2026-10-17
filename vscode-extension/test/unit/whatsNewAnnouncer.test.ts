import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	EMPTY_WHATS_NEW_STATE,
	compareVersions,
	localDateKey,
	planAnnouncement,
	reconcileVersion,
	sanitizeState,
	type WhatsNewState,
} from '../../src/whatsNew/announcer';
import type { WhatsNewRelease } from '../../src/whatsNew/catalog';

const NOW = new Date('2026-09-07T12:00:00.000Z');

/** A four-feature release so the per-release cap of 3 is actually exercised. */
const RELEASES: WhatsNewRelease[] = [
	{
		version: '2.0.0',
		date: '2026-09-01',
		headlineKey: 'Two.',
		features: [
			{ id: 'f-a', titleKey: 'A', descriptionKey: 'a', kind: 'tab', surface: { view: 'usage', tab: 'alpha' } },
			{ id: 'f-b', titleKey: 'B', descriptionKey: 'b', kind: 'tab', surface: { view: 'usage', tab: 'beta' } },
			{ id: 'f-c', titleKey: 'C', descriptionKey: 'c', kind: 'view', surface: { view: 'efficiency' } },
			{ id: 'f-d', titleKey: 'D', descriptionKey: 'd', kind: 'section', surface: { view: 'chart' } },
		],
	},
	{
		version: '1.5.0',
		date: '2026-08-20',
		headlineKey: 'One and a half.',
		features: [
			{ id: 'f-e', titleKey: 'E', descriptionKey: 'e', kind: 'view', surface: { view: 'environmental' } },
		],
	},
	{
		version: '1.0.0',
		date: '2024-01-01',
		headlineKey: 'Ancient history.',
		features: [
			{ id: 'f-old', titleKey: 'Old', descriptionKey: 'old', kind: 'view', surface: { view: 'maturity' } },
		],
	},
];

const state = (overrides: Partial<WhatsNewState> = {}): WhatsNewState => ({ ...EMPTY_WHATS_NEW_STATE, ...overrides });

test('compareVersions', async (t) => {
	await t.test('orders numerically, not lexically', () => {
		assert.ok(compareVersions('0.17.10', '0.17.9') > 0);
		assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
		assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
	});

	await t.test('ignores a prerelease suffix', () => {
		assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), 0);
	});

	await t.test('treats missing and non-numeric segments as zero rather than throwing', () => {
		assert.equal(compareVersions('1.2', '1.2.0'), 0);
		assert.equal(compareVersions('', '0.0.0'), 0);
		assert.ok(compareVersions('1.x.3', '1.0.3') === 0);
	});
});

test('reconcileVersion', async (t) => {
	await t.test('a fresh install adopts the version and queues nothing', () => {
		// New users get the onboarding flow; a backlog of "new in 2.0.0" on day
		// one is meaningless to someone who has never seen 1.x.
		const next = reconcileVersion({ releases: RELEASES, state: state(), currentVersion: '2.0.0', now: NOW });
		assert.deepEqual(next.pending, []);
		assert.equal(next.lastKnownVersion, '2.0.0');
		assert.equal(next.versionSeenAt, NOW.toISOString());
	});

	await t.test('an existing user meeting the mechanism for the first time gets the current release only', () => {
		// No stored version means there is no way to know which releases they
		// crossed, so anything older than the running build is left to the
		// What's New view rather than guessed at.
		const next = reconcileVersion({ releases: RELEASES, state: state(), currentVersion: '2.0.0', now: NOW, isFreshInstall: false });
		assert.deepEqual(next.pending, ['f-a', 'f-b', 'f-c']);
		assert.equal(next.lastKnownVersion, '2.0.0');
	});

	await t.test('an existing user on a version the catalog does not list gets nothing', () => {
		const next = reconcileVersion({ releases: RELEASES, state: state(), currentVersion: '2.0.1', now: NOW, isFreshInstall: false });
		assert.deepEqual(next.pending, []);
		assert.equal(next.lastKnownVersion, '2.0.1');
	});

	await t.test('an existing user on a stale release still gets nothing', () => {
		const next = reconcileVersion({ releases: RELEASES, state: state(), currentVersion: '1.0.0', now: NOW, isFreshInstall: false });
		assert.deepEqual(next.pending, []);
	});

	await t.test('an unchanged version is a no-op, returning the same object', () => {
		const before = state({ lastKnownVersion: '2.0.0', versionSeenAt: '2026-09-02T00:00:00.000Z', pending: ['f-a'] });
		assert.equal(reconcileVersion({ releases: RELEASES, state: before, currentVersion: '2.0.0', now: NOW }), before);
	});

	await t.test('an upgrade queues at most three features per release, in catalog order', () => {
		const next = reconcileVersion({
			releases: RELEASES,
			state: state({ lastKnownVersion: '1.5.0', versionSeenAt: '2026-08-21T00:00:00.000Z' }),
			currentVersion: '2.0.0',
			now: NOW,
		});
		// 'f-d' is the fourth feature of 2.0.0 and is deliberately dropped.
		assert.deepEqual(next.pending, ['f-a', 'f-b', 'f-c']);
	});

	await t.test('crossing several releases queues each one separately', () => {
		const next = reconcileVersion({
			releases: RELEASES,
			state: state({ lastKnownVersion: '1.0.0', versionSeenAt: '2024-01-02T00:00:00.000Z' }),
			currentVersion: '2.0.0',
			now: NOW,
		});
		assert.deepEqual(next.pending, ['f-a', 'f-b', 'f-c', 'f-e']);
	});

	await t.test('releases the user was already on are not re-queued', () => {
		const next = reconcileVersion({
			releases: RELEASES,
			state: state({ lastKnownVersion: '2.0.0', versionSeenAt: '2026-09-02T00:00:00.000Z' }),
			currentVersion: '2.0.1',
			now: NOW,
		});
		assert.deepEqual(next.pending, []);
	});

	await t.test('features already announced spend the release\'s budget rather than making room for more', () => {
		const next = reconcileVersion({
			releases: RELEASES,
			state: state({ lastKnownVersion: '1.5.0', versionSeenAt: '2026-08-21T00:00:00.000Z', announced: ['f-a', 'f-b'] }),
			currentVersion: '2.0.0',
			now: NOW,
		});
		assert.deepEqual(next.pending, ['f-c']);
	});

	await t.test('a stale release is skipped, so a long-dormant install is not spammed', () => {
		const next = reconcileVersion({
			releases: RELEASES,
			state: state({ lastKnownVersion: '0.9.0', versionSeenAt: '2023-01-01T00:00:00.000Z' }),
			currentVersion: '1.0.0',
			now: NOW,
		});
		assert.deepEqual(next.pending, []);
	});

	await t.test('a downgrade adopts the version and clears the queue', () => {
		const next = reconcileVersion({
			releases: RELEASES,
			state: state({ lastKnownVersion: '2.0.0', versionSeenAt: '2026-09-02T00:00:00.000Z', pending: ['f-a'] }),
			currentVersion: '1.5.0',
			now: NOW,
		});
		assert.equal(next.lastKnownVersion, '1.5.0');
		assert.deepEqual(next.pending, []);
	});
});

test('planAnnouncement', async (t) => {
	const upgraded = state({
		lastKnownVersion: '2.0.0',
		versionSeenAt: '2026-09-06T00:00:00.000Z',
		pending: ['f-a', 'f-b', 'f-c'],
	});

	await t.test('announces one feature and moves it to announced', () => {
		const plan = planAnnouncement({ releases: RELEASES, state: upgraded, visits: {}, now: NOW });
		assert.equal(plan.announcement?.feature.id, 'f-a');
		assert.equal(plan.announcement?.release.version, '2.0.0');
		assert.deepEqual(plan.state.pending, ['f-b', 'f-c']);
		assert.deepEqual(plan.state.announced, ['f-a']);
		assert.equal(plan.state.lastAnnouncedDate, localDateKey(NOW));
	});

	await t.test('stays quiet for the rest of the day after announcing', () => {
		const first = planAnnouncement({ releases: RELEASES, state: upgraded, visits: {}, now: NOW });
		const second = planAnnouncement({ releases: RELEASES, state: first.state, visits: {}, now: NOW });
		assert.equal(second.announcement, null);
		// Nothing was consumed: tomorrow's announcement is still 'f-b'.
		assert.deepEqual(second.state.pending, ['f-b', 'f-c']);
	});

	await t.test('announces again the next day', () => {
		const first = planAnnouncement({ releases: RELEASES, state: upgraded, visits: {}, now: NOW });
		const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
		const second = planAnnouncement({ releases: RELEASES, state: first.state, visits: {}, now: tomorrow });
		assert.equal(second.announcement?.feature.id, 'f-b');
	});

	await t.test('drops a feature the user already opened themselves', () => {
		// Found the Alpha tab on their own after upgrading — telling them about
		// it now is the noise this whole mechanism exists to avoid.
		const visits = { 'usage#alpha': '2026-09-06T09:00:00.000Z' };
		const plan = planAnnouncement({ releases: RELEASES, state: upgraded, visits, now: NOW });
		assert.equal(plan.announcement?.feature.id, 'f-b');
		assert.ok(!plan.state.pending.includes('f-a'));
		// It was never announced, so it is not recorded as announced either.
		assert.deepEqual(plan.state.announced, ['f-b']);
	});

	await t.test('a visit from before the upgrade does not count as having seen it', () => {
		const visits = { 'usage#alpha': '2026-09-01T09:00:00.000Z' };
		const plan = planAnnouncement({ releases: RELEASES, state: upgraded, visits, now: NOW });
		assert.equal(plan.announcement?.feature.id, 'f-a');
	});

	await t.test('prunes self-discovered features even on a day it stays quiet', () => {
		const quiet = { ...upgraded, lastAnnouncedDate: localDateKey(NOW) };
		const visits = { 'usage#alpha': '2026-09-06T09:00:00.000Z' };
		const plan = planAnnouncement({ releases: RELEASES, state: quiet, visits, now: NOW });
		assert.equal(plan.announcement, null);
		assert.deepEqual(plan.state.pending, ['f-b', 'f-c']);
	});

	await t.test('drops a queued id that is no longer in the catalog', () => {
		const stale = state({ lastKnownVersion: '2.0.0', versionSeenAt: '2026-09-06T00:00:00.000Z', pending: ['f-removed', 'f-a'] });
		const plan = planAnnouncement({ releases: RELEASES, state: stale, visits: {}, now: NOW });
		assert.equal(plan.announcement?.feature.id, 'f-a');
		assert.deepEqual(plan.state.pending, []);
	});

	await t.test('drops a feature whose release has gone stale before announcing it', () => {
		const stale = state({ lastKnownVersion: '2.0.0', versionSeenAt: '2026-09-06T00:00:00.000Z', pending: ['f-old'] });
		const plan = planAnnouncement({ releases: RELEASES, state: stale, visits: {}, now: NOW });
		assert.equal(plan.announcement, null);
		assert.deepEqual(plan.state.pending, []);
	});

	await t.test('an empty queue returns the same state object untouched', () => {
		const empty = state({ lastKnownVersion: '2.0.0' });
		const plan = planAnnouncement({ releases: RELEASES, state: empty, visits: {}, now: NOW });
		assert.equal(plan.announcement, null);
		assert.equal(plan.state, empty);
	});
});

test('sanitizeState', async (t) => {
	await t.test('recovers a usable state from junk', () => {
		assert.deepEqual(sanitizeState(undefined), EMPTY_WHATS_NEW_STATE);
		assert.deepEqual(sanitizeState('nope'), EMPTY_WHATS_NEW_STATE);
		assert.deepEqual(sanitizeState({ pending: ['f-a', 7, ''], announced: 'nope', lastKnownVersion: 12 }), {
			lastKnownVersion: null,
			versionSeenAt: null,
			pending: ['f-a'],
			announced: [],
			lastAnnouncedDate: null,
		});
	});
});

test('localDateKey uses the local calendar day, so "one a day" means the user\'s day', () => {
	const localMidnight = new Date(2026, 8, 7, 0, 30);
	assert.equal(localDateKey(localMidnight), '2026-09-07');
});
