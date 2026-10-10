/**
 * Which group tab each of the Usage Analysis leaf tabs lives under.
 *
 * The view reached ten tabs in one strip, which wrapped onto a second row at ordinary panel
 * widths and offered no way to tell at a glance that "Repository PRs" and "Cloud Agent" are the
 * same kind of thing. This mirrors the two-level strip the Diagnostics view already uses.
 *
 * The count is ten because AI Readiness joined the view in #2194; the test against SWITCHABLE_TABS
 * is what actually keeps this list honest, so trust it over any number written in prose.
 *
 * **Leaf tab ids are unchanged and must stay that way.** They are the `viewTabOpened` telemetry
 * key the host records against, the `switchTab` message payload, and the target of the What's New
 * view's "Take me there" deep links — all of which name a tab from outside this module. (The
 * in-memory `activeTab` uses them too; it is not persisted — `UsageWebviewState` stores only
 * `aboutCollapsed`.) Grouping them is chrome; renaming them would break those three callers.
 */

/** A group tab: the id used in `data-group`, its label, and the leaf tabs it owns, in order. */
export interface UsageTabGroup {
	id: string;
	/**
	 * Webview localization key for the label, not the label itself — resolved and escaped at
	 * render time so the strip translates with the rest of the view.
	 */
	labelKey: string;
	/** Codicon name without the `codicon-` prefix. */
	icon: string;
	tabs: string[];
}

export const USAGE_TAB_GROUPS: readonly UsageTabGroup[] = [
	{ id: 'usage', labelKey: 'usage.group.usage', icon: 'graph', tabs: ['activity', 'sessions'] },
	{ id: 'workspace', labelKey: 'usage.group.workspace', icon: 'folder-opened', tabs: ['tools', 'health', 'readiness', 'worktrees'] },
	{ id: 'github', labelKey: 'usage.group.github', icon: 'github', tabs: ['repos', 'agent'] },
	{ id: 'coaching', labelKey: 'usage.group.coaching', icon: 'mortar-board', tabs: ['insights', 'corrections'] },
];

/** The group that owns `tabId`, falling back to the first group for an unknown tab. */
export function groupOfUsageTab(tabId: string): string {
	for (const group of USAGE_TAB_GROUPS) {
		if (group.tabs.includes(tabId)) { return group.id; }
	}
	return USAGE_TAB_GROUPS[0].id;
}

/** Every leaf tab id, in strip order. */
export function allUsageTabs(): string[] {
	return USAGE_TAB_GROUPS.flatMap(group => group.tabs);
}
