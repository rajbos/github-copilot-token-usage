import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { USAGE_TAB_GROUPS, groupOfUsageTab, allUsageTabs } from '../../src/webview/usage/tabGroups';
import { SWITCHABLE_TABS } from '../../src/webview/usage/switchableTabs';

// ── Coverage for the Usage Analysis two-level tab strip ──────────────────────
//
// The view's ten tabs sit under four group tabs. The grouping is chrome — the leaf tab ids are
// the viewTabOpened telemetry key, the switchTab payload, and the target of the What's New
// view's "Take me there" deep links. (activeTab uses them too, but only in module memory:
// UsageWebviewState stores just aboutCollapsed, so recreating the panel resets the selected tab.)
//
// The load-bearing test here is the round-trip against SWITCHABLE_TABS: adding a tab to one list
// and not the other leaves a tab the host can switch to but no group can show (or a group
// pointing at a tab that does not exist), and nothing else in the build would catch it.

describe('USAGE_TAB_GROUPS', () => {
	test('covers exactly the switchable tabs, with no extras and none missing', () => {
		assert.deepEqual(allUsageTabs().slice().sort(), [...SWITCHABLE_TABS].sort());
	});

	test('assigns every tab to exactly one group', () => {
		const tabs = allUsageTabs();
		assert.equal(new Set(tabs).size, tabs.length, 'a tab appears in more than one group');
	});

	test('has unique, non-empty group ids', () => {
		const ids = USAGE_TAB_GROUPS.map(g => g.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(ids.every(id => id.length > 0));
	});

	test('every group has a label, an icon, and at least one tab', () => {
		for (const group of USAGE_TAB_GROUPS) {
			assert.ok(group.labelKey.length > 0, `${group.id} has no label key`);
			assert.ok(group.icon.length > 0, `${group.id} has no icon`);
			assert.ok(group.tabs.length > 0, `${group.id} has no tabs`);
		}
	});

	test('opens on the group that owns the default tab', () => {
		// activeTab starts at 'activity'; if it were not in the first group the strip would
		// render with one group marked active and a different group's leaf bar showing.
		assert.equal(groupOfUsageTab('activity'), USAGE_TAB_GROUPS[0].id);
		assert.ok(USAGE_TAB_GROUPS[0].tabs.includes('activity'));
	});
});

describe('groupOfUsageTab', () => {
	test('returns the owning group for each known tab', () => {
		assert.equal(groupOfUsageTab('activity'), 'usage');
		assert.equal(groupOfUsageTab('sessions'), 'usage');
		assert.equal(groupOfUsageTab('tools'), 'workspace');
		assert.equal(groupOfUsageTab('health'), 'workspace');
		assert.equal(groupOfUsageTab('worktrees'), 'workspace');
		assert.equal(groupOfUsageTab('repos'), 'github');
		assert.equal(groupOfUsageTab('agent'), 'github');
		assert.equal(groupOfUsageTab('insights'), 'coaching');
		assert.equal(groupOfUsageTab('corrections'), 'coaching');
	});

	test('falls back to the first group rather than returning nothing for an unknown tab', () => {
		// A tab with no group would leave every leaf bar hidden, which is worse than landing
		// the user on the default group.
		assert.equal(groupOfUsageTab('does-not-exist'), USAGE_TAB_GROUPS[0].id);
		assert.equal(groupOfUsageTab(''), USAGE_TAB_GROUPS[0].id);
	});
});
