// Tabs the extension host may activate via the 'switchTab' message. Guarded so a bogus tab
// name can never blank the dashboard by leaving every panel hidden, and so untrusted input
// is never interpolated into a CSS selector.
export const SWITCHABLE_TABS: ReadonlySet<string> = new Set([
	'activity', 'sessions', 'tools', 'health', 'repos', 'readiness', 'agent', 'worktrees', 'insights', 'corrections'
]);

// True when a switchTab message names a tab the webview actually renders. Non-string input is
// coerced first so it can never throw or slip past the guard.
export function isSwitchableTab(value: unknown): boolean {
	return SWITCHABLE_TABS.has(String(value));
}
