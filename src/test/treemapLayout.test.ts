import test from 'node:test';
import * as assert from 'node:assert/strict';

import type { RepoHeatmapCell, RepoHeatmapSummary } from '../repoHeatmapViewBuilder';
import { buildFolderTree, findNode, layoutTreemap, squarify, type Rect } from '../treemapLayout';

const cell = (path: string, total: number): RepoHeatmapCell => ({ name: path.split('/').pop()!, path, counts: [total, 0, 0, 0], total, inferredDeletes: false });
const summaryOf = (files: [string, number][]): RepoHeatmapSummary => {
	const byFolder = new Map<string, RepoHeatmapCell[]>();
	for (const [p, n] of files) {
		const i = p.lastIndexOf('/');
		const folder = i < 0 ? '.' : p.slice(0, i);
		byFolder.set(folder, [...(byFolder.get(folder) ?? []), cell(p, n)]);
	}
	return {
		folders: [...byFolder.entries()].map(([folder, cells]) => ({ folder, files: cells, counts: [0, 0, 0, 0], total: cells.reduce((s, c) => s + c.total, 0) })),
		counts: [0, 0, 0, 0], fileCount: files.length, maxCellTotal: Math.max(...files.map(f => f[1])),
	};
};
const area = (r: Rect): number => r.w * r.h;

test('squarify: areas are proportional to the values and tile the rectangle', () => {
	const rect = { x: 10, y: 20, w: 600, h: 400 };
	const rects = squarify([6, 6, 4, 3, 2, 2, 1], rect);
	const total = 24;
	rects.forEach((r, i) => assert.ok(Math.abs(area(r) - ([6, 6, 4, 3, 2, 2, 1][i] / total) * area(rect)) < 1e-6));
	assert.ok(Math.abs(rects.reduce((s, r) => s + area(r), 0) - area(rect)) < 1e-6);
	for (const r of rects) {
		assert.ok(r.x >= rect.x - 1e-9 && r.y >= rect.y - 1e-9 && r.x + r.w <= rect.x + rect.w + 1e-9 && r.y + r.h <= rect.y + rect.h + 1e-9, 'inside the rectangle');
	}
});

test('squarify: no two rectangles overlap and the shapes stay reasonably square', () => {
	const rects = squarify([50, 30, 20, 10, 10, 5, 5, 1], { x: 0, y: 0, w: 800, h: 500 });
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const a = rects[i], b = rects[j];
			const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
			const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
			assert.ok(!(overlapW > 1e-6 && overlapH > 1e-6), `${i} overlaps ${j}`);
		}
	}
	for (const r of rects.slice(0, 5)) { assert.ok(Math.max(r.w / r.h, r.h / r.w) < 5); }
});

test('squarify: empty input, zero totals and degenerate rectangles do not throw', () => {
	assert.deepEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
	assert.equal(squarify([1, 1], { x: 0, y: 0, w: 0, h: 10 }).every(r => r.w === 0 && r.h === 0), true);
	assert.equal(squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 }).length, 2);
});

test('buildFolderTree: nests folders, sums values and collapses single-child folder chains', () => {
	const root = buildFolderTree(summaryOf([['src/webview/a.ts', 5], ['src/webview/b.ts', 3], ['src/c.ts', 2], ['README.md', 1], ['deep/er/est/d.ts', 4]]));
	assert.equal(root.value, 15);
	const names = root.children.map(c => c.name).sort();
	assert.deepEqual(names, ['README.md', 'deep/er/est', 'src']);
	const src = root.children.find(c => c.name === 'src')!;
	assert.equal(src.value, 10);
	assert.deepEqual(src.children.map(c => c.name).sort(), ['c.ts', 'webview']);
	const deep = root.children.find(c => c.name === 'deep/er/est')!;
	assert.equal(deep.path, 'deep/er/est');
	assert.equal(deep.children[0].cell?.path, 'deep/er/est/d.ts');
});

test('findNode: exact path, intermediate segment of a collapsed chain, and misses', () => {
	const root = buildFolderTree(summaryOf([['a/b/c/x.ts', 1], ['a/b/c/y.ts', 1], ['z.ts', 1]]));
	assert.equal(findNode(root, '')?.path, '');
	assert.equal(findNode(root, 'a/b/c')?.path, 'a/b/c');
	assert.equal(findNode(root, 'a')?.path, 'a/b/c', 'a path inside the collapsed chain resolves to it');
	assert.equal(findNode(root, 'nope'), undefined);
});

test('layoutTreemap: files are leaves inside their folder, parents come first, area follows value', () => {
	const root = buildFolderTree(summaryOf([['src/a.ts', 60], ['src/b.ts', 20], ['docs/c.md', 20]]));
	const rect = { x: 0, y: 0, w: 1000, h: 600 };
	const placed = layoutTreemap(root, rect);
	const folders = placed.filter(p => p.isFolder);
	assert.deepEqual(folders.map(p => p.node.name).sort(), ['docs', 'src']);
	const src = placed.find(p => p.node.name === 'src')!;
	const a = placed.find(p => p.node.name === 'a.ts')!;
	assert.ok(placed.indexOf(src) < placed.indexOf(a), 'a folder is placed before its children');
	assert.equal(a.depth, 1);
	assert.ok(a.rect.x >= src.rect.x && a.rect.y >= src.rect.y && a.rect.x + a.rect.w <= src.rect.x + src.rect.w && a.rect.y + a.rect.h <= src.rect.y + src.rect.h, 'inside the folder');
	const b = placed.find(p => p.node.name === 'b.ts')!;
	assert.ok(Math.abs(area(a.rect) / area(b.rect) - 3) < 0.4, 'a has three times the touches of b, so about three times the area');
	assert.ok(src.hasHeader, 'a large folder reserves a label strip');
});

test('layoutTreemap: specks are dropped and tiny folders get no header', () => {
	const root = buildFolderTree(summaryOf([['big/a.ts', 100000], ['tiny/b.ts', 1]]));
	const placed = layoutTreemap(root, { x: 0, y: 0, w: 300, h: 200 });
	assert.equal(placed.some(p => p.node.name === 'b.ts'), false);
	assert.equal(placed.find(p => p.node.name === 'big')?.hasHeader, true);
});
