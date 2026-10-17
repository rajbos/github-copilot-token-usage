import test from 'node:test';
import * as assert from 'node:assert/strict';
import { SWITCHABLE_TABS, isSwitchableTab } from '../../src/webview/usage/switchableTabs';

// handleSwitchTab persists the requested tab in module state (not just the DOM) so a switchTab
// message arriving while the webview is still in its loading state — e.g. the worktree
// notification's "Show Me" action — survives until the eventual renderLayout. Unknown tabs are
// rejected up front so a bogus name can neither blank the dashboard nor be interpolated into
// a CSS selector.

test('isSwitchableTab: accepts every tab rendered in the tab bar', () => {
	for (const tab of ['activity', 'sessions', 'tools', 'health', 'repos', 'readiness', 'agent', 'worktrees', 'insights', 'corrections']) {
		assert.ok(SWITCHABLE_TABS.has(tab), `missing ${tab}`);
		assert.ok(isSwitchableTab(tab));
	}
});

test('isSwitchableTab: rejects unknown tab names', () => {
	assert.equal(isSwitchableTab('nonsense'), false);
	assert.equal(isSwitchableTab('worktrees")], [*'), false);
});

test('isSwitchableTab: coerces non-string input before guarding', () => {
	assert.equal(isSwitchableTab(undefined), false);
	assert.equal(isSwitchableTab(null), false);
	assert.equal(isSwitchableTab(42), false);
});
