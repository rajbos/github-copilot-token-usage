/**
 * Treemap layout for the Repository Heatmap: folders nest, files are leaves, and a
 * rectangle's area is proportional to how often the file (or everything under the folder)
 * was touched. Pure geometry — no DOM — so every host renders from the same numbers.
 *
 * The packing is the squarified algorithm (Bruls, Huizing, van Wijk): rows are laid along
 * the shorter side and grown while they keep the worst aspect ratio improving.
 */
import type { RepoHeatmapCell, RepoHeatmapSummary } from './repoHeatmapViewBuilder';

export interface TreeNode {
	/** Display name: the file name, or the (possibly collapsed `a/b`) folder name. */
	name: string;
	/** Repository-relative path; '' for the root. */
	path: string;
	/** Touches of the selected kinds under this node. */
	value: number;
	/** Present on file leaves. */
	cell?: RepoHeatmapCell;
	children: TreeNode[];
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface PlacedNode {
	node: TreeNode;
	rect: Rect;
	/** 0 for the root's direct children. */
	depth: number;
	isFolder: boolean;
	/** Folders tall and wide enough for a label reserve a header strip at the top of their rect. */
	hasHeader: boolean;
}

export interface TreemapOptions {
	/** Height of a folder's label strip. */
	headerHeight?: number;
	/** Gap between a folder's border and its children. */
	padding?: number;
	/** Rects smaller than this on either side are dropped (they would render as specks). */
	minSize?: number;
}

const DEFAULTS: Required<TreemapOptions> = { headerHeight: 18, padding: 2, minSize: 3 };

// ── Tree building ────────────────────────────────────────────────────────────

function emptyDir(name: string, path: string): TreeNode { return { name, path, value: 0, children: [] }; }

function childDir(parent: TreeNode, name: string): TreeNode {
	const path = parent.path ? `${parent.path}/${name}` : name;
	let dir = parent.children.find(c => !c.cell && c.name === name);
	if (!dir) { dir = emptyDir(name, path); parent.children.push(dir); }
	return dir;
}

function sumValues(node: TreeNode): number {
	if (!node.cell) { node.value = node.children.reduce((s, c) => s + sumValues(c), 0); }
	return node.value;
}

/** Merges chains of folders with a single folder child (`src` → `webview` becomes `src/webview`). */
function collapseChains(node: TreeNode, isRoot: boolean): void {
	for (const child of node.children) { if (!child.cell) { collapseChains(child, false); } }
	if (isRoot || node.cell) { return; }
	while (node.children.length === 1 && !node.children[0].cell) {
		const only = node.children[0];
		node.name = `${node.name}/${only.name}`;
		node.path = only.path;
		node.children = only.children;
	}
}

/** Builds the folder tree of one summary: every file is a leaf valued by its selected-kind total. */
export function buildFolderTree(summary: RepoHeatmapSummary): TreeNode {
	const root = emptyDir('', '');
	for (const folder of summary.folders) {
		let dir = root;
		if (folder.folder !== '.') { for (const segment of folder.folder.split('/')) { dir = childDir(dir, segment); } }
		for (const cell of folder.files) {
			dir.children.push({ name: cell.name, path: cell.path, value: cell.total, cell, children: [] });
		}
	}
	sumValues(root);
	collapseChains(root, true);
	return root;
}

/**
 * The node at `path`; a path inside a collapsed chain (`src` when the tree holds `src/webview`)
 * resolves to the collapsed node, so a breadcrumb for an intermediate segment still zooms somewhere.
 */
export function findNode(root: TreeNode, path: string): TreeNode | undefined {
	if (!path) { return root; }
	let found: TreeNode | undefined;
	const visit = (node: TreeNode): void => {
		if (found || node.cell) { return; }
		if (node.path === path) { found = node; return; }
		if (node.path && node.path.startsWith(`${path}/`) && !found) { found = node; return; }
		for (const child of node.children) { visit(child); }
	};
	visit(root);
	return found;
}

// ── Squarified packing ───────────────────────────────────────────────────────

function worstRatio(row: number[], side: number): number {
	const sum = row.reduce((s, v) => s + v, 0);
	if (sum <= 0 || side <= 0) { return Infinity; }
	const max = Math.max(...row), min = Math.min(...row);
	return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/**
 * Splits `rect` into one rectangle per value, areas proportional to the values. `values` must be
 * positive and sorted descending; the result is in the same order.
 */
export function squarify(values: number[], rect: Rect): Rect[] {
	const total = values.reduce((s, v) => s + v, 0);
	const out: Rect[] = [];
	if (values.length === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) { return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 })); }
	const scale = (rect.w * rect.h) / total;
	const areas = values.map(v => v * scale);
	let free = { ...rect };
	let i = 0;
	while (i < areas.length) {
		const side = Math.min(free.w, free.h);
		let end = i + 1;
		while (end < areas.length && worstRatio(areas.slice(i, end + 1), side) <= worstRatio(areas.slice(i, end), side)) { end++; }
		free = layRow(areas.slice(i, end), free, out);
		i = end;
	}
	return out;
}

/** Lays one row along the shorter side of `free`, appends its rects to `out`, returns the remaining space. */
function layRow(row: number[], free: Rect, out: Rect[]): Rect {
	const sum = row.reduce((s, v) => s + v, 0);
	if (free.w >= free.h) {
		// Tall free space: the row is a column on the left.
		const colW = sum / free.h;
		let y = free.y;
		for (const a of row) { const h = a / colW; out.push({ x: free.x, y, w: colW, h }); y += h; }
		return { x: free.x + colW, y: free.y, w: free.w - colW, h: free.h };
	}
	const rowH = sum / free.w;
	let x = free.x;
	for (const a of row) { const w = a / rowH; out.push({ x, y: free.y, w, h: rowH }); x += w; }
	return { x: free.x, y: free.y + rowH, w: free.w, h: free.h - rowH };
}

// ── Nested layout ────────────────────────────────────────────────────────────

/**
 * Places every descendant of `root` (not `root` itself) inside `rect`, parents before children.
 * Folders reserve a header strip for their label when there is room, and a small padding so
 * nesting stays visible; zero-value and sub-pixel nodes are dropped.
 */
export function layoutTreemap(root: TreeNode, rect: Rect, options: TreemapOptions = {}): PlacedNode[] {
	const opts = { ...DEFAULTS, ...options };
	const placed: PlacedNode[] = [];
	placeChildren(root, rect, 0, opts, placed);
	return placed;
}

function placeChildren(parent: TreeNode, rect: Rect, depth: number, opts: Required<TreemapOptions>, out: PlacedNode[]): void {
	const kids = parent.children.filter(c => c.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
	const rects = squarify(kids.map(k => k.value), rect);
	kids.forEach((node, i) => {
		const r = rects[i];
		if (r.w < opts.minSize || r.h < opts.minSize) { return; }
		const isFolder = !node.cell;
		const hasHeader = isFolder && r.h >= opts.headerHeight * 2 && r.w >= 60;
		out.push({ node, rect: r, depth, isFolder, hasHeader });
		if (!isFolder) { return; }
		const top = hasHeader ? opts.headerHeight : 0;
		const inner: Rect = { x: r.x + opts.padding, y: r.y + top + (hasHeader ? 0 : opts.padding), w: r.w - 2 * opts.padding, h: r.h - top - (hasHeader ? opts.padding : 2 * opts.padding) };
		placeChildren(node, inner, depth + 1, opts, out);
	});
}
