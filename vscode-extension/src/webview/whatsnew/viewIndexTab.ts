// View index tab of the What's New panel: a searchable tree of every view, tab and section.
import { el } from '../shared/domUtils';
import { localize, localizeFormat } from '../shared/localization';
import { VIEW_INDEX, flattenViewIndex, type ViewIndexNode } from '../../whatsNew/viewIndex';
import { highlightRanges, searchViewIndex } from './viewIndexSearch';

type PostMessage = (message: unknown) => void;

/** The View index state worth keeping when the panel is hidden and its webview torn down. */
export type ViewIndexPersistedState = {
	query: string;
	/** Node ids the user expanded or collapsed by hand; absent means the default. */
	toggled: Record<string, boolean>;
};

/**
 * Current state. Seeded from the webview's saved state by {@link buildViewIndexTab}
 * and handed back through its `persist` callback on every change, because the
 * What's New panel does not retain its context while hidden — opening a view
 * from the index hides it.
 */
const state: ViewIndexPersistedState = { query: '', toggled: {} };
let persistState: (state: ViewIndexPersistedState) => void = () => {};

function saveState(): void {
	persistState({ query: state.query, toggled: { ...state.toggled } });
}

const ENTRIES = flattenViewIndex();
const PATH_BY_ID = new Map(ENTRIES.map((entry) => [entry.id, entry.path]));

/**
 * Views and tab groups start open, so the first screen is the map of every
 * subview; the sections inside a tab start folded. A group is a node whose
 * children are tabs of their own.
 */
function isExpandedByDefault(node: ViewIndexNode, depth: number): boolean {
	return depth === 0 || (depth === 1 && !!node.children?.some((child) => child.nav?.tab));
}

function appendHighlighted(target: HTMLElement, text: string, query: string): void {
	let cursor = 0;
	for (const [start, end] of highlightRanges(text, query)) {
		if (start > cursor) { target.append(document.createTextNode(text.slice(cursor, start))); }
		target.append(el('mark', 'index-mark', text.slice(start, end)));
		cursor = end;
	}
	if (cursor < text.length) { target.append(document.createTextNode(text.slice(cursor))); }
}

function buildOpenButton(node: ViewIndexNode, post: PostMessage): HTMLButtonElement {
	const label = localizeFormat('viewIndex.open', PATH_BY_ID.get(node.id)?.join(' › ') ?? node.title);
	const button = el('button', 'index-open');
	button.type = 'button';
	button.id = `index-open-${node.id}`;
	button.title = label;
	button.setAttribute('aria-label', label);
	button.append(el('span', 'codicon codicon-go-to-file'));
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		post({ command: 'openViewIndexEntry', entryId: node.id });
	});
	return button;
}

type RenderContext = {
	post: PostMessage;
	query: string;
	/** Ids to show while searching: the matches and their ancestors. Null when not searching. */
	visible: ReadonlySet<string> | null;
	matched: ReadonlySet<string>;
	rerender: () => void;
};

function buildToggle(node: ViewIndexNode, hasChildren: boolean, expanded: boolean, ctx: RenderContext): HTMLButtonElement {
	const toggle = el('button', 'index-toggle');
	toggle.type = 'button';
	toggle.id = `index-toggle-${node.id}`;
	if (!hasChildren) {
		toggle.classList.add('index-toggle-leaf');
		toggle.disabled = true;
		toggle.setAttribute('aria-hidden', 'true');
		toggle.tabIndex = -1;
		return toggle;
	}
	toggle.append(el('span', `codicon codicon-chevron-${expanded ? 'down' : 'right'}`));
	toggle.setAttribute('aria-label', localizeFormat(expanded ? 'viewIndex.collapse' : 'viewIndex.expand', node.title));
	toggle.setAttribute('aria-expanded', String(expanded));
	toggle.addEventListener('click', () => {
		state.toggled[node.id] = !expanded;
		saveState();
		ctx.rerender();
		// The re-render replaced this button; keep keyboard focus on its successor.
		document.getElementById(toggle.id)?.focus();
	});
	toggle.disabled = !!ctx.visible;
	return toggle;
}

/**
 * A line can match on a keyword that appears nowhere on screen ("slow" →
 * Tool latency profile). Chips for the keywords that hit make the match explain itself.
 */
function buildKeywordChips(node: ViewIndexNode, query: string): HTMLElement[] {
	if (!query) { return []; }
	return (node.keywords ?? [])
		.filter((keyword) => highlightRanges(keyword, query).length > 0)
		.map((keyword) => {
			const chip = el('span', 'index-keyword');
			chip.append(el('span', 'codicon codicon-tag'));
			appendHighlighted(chip, keyword, query);
			return chip;
		});
}

function buildText(node: ViewIndexNode, query: string): HTMLElement {
	const titleLine = el('div', 'index-title-line');
	const title = el('span', 'index-title');
	appendHighlighted(title, node.title, query);
	titleLine.append(title);
	if (node.condition) {
		const condition = el('span', 'index-condition');
		appendHighlighted(condition, node.condition, query);
		titleLine.append(condition);
	}
	titleLine.append(...buildKeywordChips(node, query));
	const description = el('div', 'index-description');
	appendHighlighted(description, node.description, query);
	description.title = node.description;
	const text = el('div', 'index-text');
	text.append(titleLine, description);
	return text;
}

function buildNode(node: ViewIndexNode, depth: number, ctx: RenderContext): HTMLElement | null {
	if (ctx.visible && !ctx.visible.has(node.id)) { return null; }
	const children = (node.children ?? [])
		.map((child) => buildNode(child, depth + 1, ctx))
		.filter((child): child is HTMLElement => child !== null);
	const hasChildren = children.length > 0;
	// While searching everything on the path to a match is open; otherwise honour the user's toggles.
	const expanded = ctx.visible ? true : state.toggled[node.id] ?? isExpandedByDefault(node, depth);

	// Nested lists with disclosure buttons rather than role="tree": a tree promises
	// arrow-key navigation, while plain buttons work with Tab like everything else.
	const item = el('li', `index-item depth-${Math.min(depth, 3)}`);
	item.dataset.entryId = node.id;
	if (ctx.visible && !ctx.matched.has(node.id)) { item.classList.add('index-context'); }

	const toggle = buildToggle(node, hasChildren, expanded, ctx);
	const row = el('div', 'index-row');
	row.append(toggle, buildText(node, ctx.query), buildOpenButton(node, ctx.post));
	item.append(row);

	if (hasChildren && expanded) {
		const list = el('ul', 'index-children');
		list.id = `index-children-${node.id}`;
		toggle.setAttribute('aria-controls', list.id);
		list.append(...children);
		item.append(list);
	}
	return item;
}

/** Ids of every ancestor of each matched entry, plus the matches themselves. */
function visibleForMatches(matchedIds: readonly string[]): Set<string> {
	const visible = new Set<string>();
	const parentOf = new Map<string, string>();
	const walk = (node: ViewIndexNode, parent?: string): void => {
		if (parent) { parentOf.set(node.id, parent); }
		node.children?.forEach((child) => walk(child, node.id));
	};
	VIEW_INDEX.forEach((view) => walk(view));
	for (const id of matchedIds) {
		for (let current: string | undefined = id; current; current = parentOf.get(current)) {
			visible.add(current);
		}
	}
	return visible;
}

function renderTree(container: HTMLElement, status: HTMLElement, post: PostMessage): void {
	const query = state.query.trim();
	const result = query ? searchViewIndex(ENTRIES, query) : null;
	const ctx: RenderContext = {
		post,
		query,
		visible: result ? visibleForMatches(result.matchedIds) : null,
		matched: new Set(result?.matchedIds ?? []),
		rerender: () => renderTree(container, status, post),
	};

	const tree = el('ul', 'index-tree');
	tree.setAttribute('aria-label', localize('viewIndex.treeLabel'));
	VIEW_INDEX.forEach((view) => {
		const node = buildNode(view, 0, ctx);
		if (node) { tree.append(node); }
	});

	if (result && result.matchedIds.length === 0) {
		status.textContent = localizeFormat('viewIndex.noMatchStatus', query);
		container.replaceChildren(el('div', 'index-empty', localize('viewIndex.noMatch')));
		return;
	}
	status.textContent = result
		? (result.matchedIds.length === 1 ? localize('viewIndex.matchOne') : localizeFormat('viewIndex.matchMany', result.matchedIds.length))
		: localizeFormat('viewIndex.summary', ENTRIES.length, VIEW_INDEX.length);
	container.replaceChildren(tree);
}

/** Builds the View index tab's content, restoring `saved` and reporting every change to `persist`. */
export function buildViewIndexTab(
	post: PostMessage,
	saved: ViewIndexPersistedState,
	persist: (state: ViewIndexPersistedState) => void,
): HTMLElement {
	state.query = typeof saved.query === 'string' ? saved.query : '';
	state.toggled = saved.toggled && typeof saved.toggled === 'object' ? { ...saved.toggled } : {};
	persistState = persist;
	const panel = el('div', 'index-panel');

	panel.append(el('div', 'intro', localize('viewIndex.intro')));

	const searchRow = el('div', 'index-search-row');
	const icon = el('span', 'codicon codicon-search index-search-icon');
	icon.setAttribute('aria-hidden', 'true');
	const input = el('input', 'index-search');
	input.id = 'view-index-search';
	input.type = 'search';
	input.placeholder = localize('viewIndex.searchPlaceholder');
	input.setAttribute('aria-label', localize('viewIndex.searchLabel'));
	input.autocomplete = 'off';
	input.spellcheck = false;
	input.value = state.query;
	const status = el('div', 'index-status');
	status.setAttribute('aria-live', 'polite');
	searchRow.append(icon, input);

	const treeContainer = el('div', 'index-tree-container');
	input.addEventListener('input', () => {
		state.query = input.value;
		saveState();
		renderTree(treeContainer, status, post);
	});
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && input.value) {
			event.preventDefault();
			input.value = '';
			state.query = '';
			saveState();
			renderTree(treeContainer, status, post);
		}
	});

	panel.append(searchRow, status, treeContainer);
	renderTree(treeContainer, status, post);
	return panel;
}
