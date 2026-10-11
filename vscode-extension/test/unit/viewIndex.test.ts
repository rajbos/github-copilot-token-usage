import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VIEW_INDEX, findViewIndexEntry, flattenViewIndex, type ViewIndexView } from '../../src/whatsNew/viewIndex';
import { highlightRanges, scoreWord, searchViewIndex } from '../../src/webview/whatsnew/viewIndexSearch';

/** The extension folder holding the TypeScript sources, found by walking up from the compiled test. */
function findExtensionRoot(): string {
	for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const candidate = path.join(dir, 'vscode-extension');
		if (fs.existsSync(path.join(candidate, 'src', 'webview', 'whatsnew', 'main.ts'))) { return candidate; }
		if (fs.existsSync(path.join(dir, 'src', 'webview', 'whatsnew', 'main.ts'))) { return dir; }
	}
	throw new Error('vscode-extension sources not found');
}

/** Every webview source a view's bundle is built from, concatenated: its own folder plus the shared code. */
function viewSources(view: string): string {
	const webviewDir = path.join(findExtensionRoot(), 'src', 'webview');
	const read = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true })
		.map((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { return read(full); }
			return entry.name.endsWith('.ts') ? fs.readFileSync(full, 'utf8') : '';
		})
		.join('\n');
	return read(path.join(webviewDir, view)) + read(path.join(webviewDir, 'shared'));
}

const ENTRIES = flattenViewIndex();

test('view index: every id is unique and every line has a title and a short description', () => {
	const ids = ENTRIES.map((entry) => entry.id);
	assert.equal(new Set(ids).size, ids.length, 'duplicate view index ids');
	for (const entry of ENTRIES) {
		assert.ok(entry.node.title.trim(), `${entry.id} has no title`);
		assert.ok(entry.node.description.trim(), `${entry.id} has no description`);
		// The tree clamps descriptions to two lines; a paragraph would be cut mid-sentence.
		assert.ok(entry.node.description.length <= 200, `${entry.id} description is too long to fit two lines`);
	}
});

test('view index: lists the log viewer only where it is opened from, since it needs a session file', () => {
	assert.ok(!VIEW_INDEX.some((view) => view.view === 'logviewer'));
	assert.ok(searchViewIndex(ENTRIES, 'session log viewer').matchedIds.includes('usage.sessions'));
});

test('view index: navigation is inherited from the tab and reset by a new tab', () => {
	assert.deepEqual(findViewIndexEntry('usage.tools.latency')?.nav, { tab: 'tools', anchor: 'section-tool-latency' });
	assert.deepEqual(findViewIndexEntry('usage.group.github')?.nav, { tab: 'repos' });
	assert.deepEqual(findViewIndexEntry('usage.agent')?.nav, { tab: 'agent' });
	assert.deepEqual(findViewIndexEntry('diagnostics.backend.team-server')?.nav, { tab: 'backend', subtab: 'backend-teamserver' });
	assert.deepEqual(findViewIndexEntry('maturity.radar')?.nav, { selector: '.radar-wrapper' });
	assert.deepEqual(findViewIndexEntry('details')?.nav, {});
	assert.deepEqual(findViewIndexEntry('dashboard.azure')?.nav, { anchor: 'section-personal-summary' });
	assert.deepEqual(findViewIndexEntry('dashboard.team')?.nav, { anchor: 'section-team-comparison' });
	assert.deepEqual(findViewIndexEntry('usage.tools.latency')?.path, ['AI Usage Analysis', 'Workspace', 'Tools & Integrations', 'Tool latency profile']);
	assert.equal(findViewIndexEntry('no-such-entry'), null);
});

test('view index: flattenViewIndex does not leak a section anchor into its siblings', () => {
	const views: ViewIndexView[] = [{
		id: 'v', view: 'usage', title: 'V', description: 'd',
		children: [{
			id: 't', title: 'T', description: 'd', nav: { tab: 'tools' },
			children: [
				{ id: 'a', title: 'A', description: 'd', nav: { anchor: 'x' } },
				{ id: 'b', title: 'B', description: 'd' },
			],
		}],
	}];
	const byId = new Map(flattenViewIndex(views).map((entry) => [entry.id, entry.nav]));
	assert.deepEqual(byId.get('a'), { tab: 'tools', anchor: 'x' });
	assert.deepEqual(byId.get('b'), { tab: 'tools' });
});

test('view index: usage entries use element ids only, since the usage panel scrolls by id', () => {
	for (const entry of ENTRIES.filter((e) => e.view === 'usage')) {
		assert.equal(entry.nav.selector, undefined, `${entry.id} uses a selector`);
	}
});

test('view index: every tab, sub-tab and anchor still exists in that view\'s webview sources', () => {
	const sourcesByView = new Map<string, string>();
	const sourcesOf = (view: string): string => {
		if (!sourcesByView.has(view)) { sourcesByView.set(view, viewSources(view)); }
		return sourcesByView.get(view) as string;
	};
	const quoted = (value: string): RegExp => new RegExp(`["'\`]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`);
	for (const entry of ENTRIES) {
		const sources = sourcesOf(entry.view);
		const { tab, subtab, anchor, selector } = entry.nav;
		if (tab) {
			// Tab ids appear as `data-tab="x"`, `dataset.tab = "x"` or in a tab table as `'x'`.
			assert.ok(quoted(tab).test(sources) || sources.includes(`data-tab="${tab}"`), `${entry.id}: tab "${tab}" not found in ${entry.view}`);
		}
		if (subtab) {
			assert.ok(sources.includes(subtab), `${entry.id}: sub-tab "${subtab}" not found in ${entry.view}`);
		}
		if (anchor) {
			assert.ok(
				sources.includes(`id="${anchor}"`) || quoted(anchor).test(sources),
				`${entry.id}: anchor "${anchor}" not found in ${entry.view}`,
			);
		}
		if (selector) {
			const className = /^\.([\w-]+)$/.exec(selector)?.[1];
			assert.ok(className, `${entry.id}: selector "${selector}" should be a single class`);
			assert.ok(sources.includes(className), `${entry.id}: class "${className}" not found in ${entry.view}`);
		}
	}
});

test('view index search: an empty query matches nothing and does not throw', () => {
	assert.deepEqual(searchViewIndex(ENTRIES, '   ').matchedIds, []);
});

test('view index search: finds by title, keyword, description and parent', () => {
	assert.equal(searchViewIndex(ENTRIES, 'latency profile').matchedIds[0], 'usage.tools.latency');
	// "slow" is only a keyword of the latency section.
	assert.ok(searchViewIndex(ENTRIES, 'slow').matchedIds.includes('usage.tools.latency'));
	// "p95" only appears in the description.
	assert.ok(searchViewIndex(ENTRIES, 'p95').matchedIds.includes('usage.tools.latency'));
	// Every word must match somewhere, and "diagnostics" comes from the parent path.
	const scoped = searchViewIndex(ENTRIES, 'diagnostics cache').matchedIds;
	assert.ok(scoped.includes('diagnostics.cache'));
	assert.ok(!scoped.includes('efficiency.cache'));
});

test('view index search: tolerates a missing letter and squashed words', () => {
	assert.ok(searchViewIndex(ENTRIES, 'latncy').matchedIds.includes('usage.tools.latency'));
	assert.ok(searchViewIndex(ENTRIES, 'mcphealth').matchedIds.includes('usage.tools.mcp-health'));
});

test('view index search: is case- and accent-insensitive', () => {
	assert.ok(searchViewIndex(ENTRIES, 'CO₂').matchedIds.length > 0);
	assert.ok(searchViewIndex(ENTRIES, 'WORKTREES').matchedIds.includes('usage.worktrees'));
	assert.ok(scoreWord('cafe', 'Café') > 0);
});

test('view index search: a scattered short word is not a match', () => {
	assert.equal(scoreWord('ai', 'a big list of items'), 0);
	assert.equal(scoreWord('xyz', 'x and y and then much later z'), 0);
	assert.ok(scoreWord('tool', 'Tool Usage') > scoreWord('tool', 'Multitool'));
});

test('view index search: highlights merged substring ranges only', () => {
	assert.deepEqual(highlightRanges('Tool latency profile', 'lat tool'), [[0, 4], [5, 8]]);
	assert.deepEqual(highlightRanges('Tool latency', 'latncy'), []);
	assert.deepEqual(highlightRanges('aaa', 'aa a'), [[0, 3]]);
});
