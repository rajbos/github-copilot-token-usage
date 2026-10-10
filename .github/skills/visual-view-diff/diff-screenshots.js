#!/usr/bin/env node
'use strict';

/**
 * Compares two directories of view screenshots and reports what changed
 * visually.
 *
 * Usage:
 *   node diff-screenshots.js --baseline <dir> --current <dir> --out <dir>
 *
 * The pixel comparison runs inside Chromium rather than in Node: the browser
 * already decodes and re-encodes PNGs, so the whole thing needs no image
 * library and therefore adds no dependency to the extension.
 *
 * Output is a set of diff images plus `report.json` / `report.md`. Posting that
 * report anywhere (a PR comment, a CI artifact) is deliberately somebody else's
 * job — this skill only decides *what changed visually*.
 */

const fs = require('fs');
const path = require('path');

const { loadChromium } = require('./lib/browser');
const { parseArgs, readConfig } = require('./lib/config');
const { diffImagesInPage } = require('./lib/imageDiff');
const { renderMarkdownReport } = require('./lib/report');

/**
 * Screenshot filenames are `<view>.<theme>.png`, or `<view>--<state>.<theme>.png`
 * for a view rendered in one of its declared states (see `renderTargets` in
 * render-views.js). The view id is recovered separately because the noise floor
 * is declared per view and applies to every state of it.
 */
function parseShotName(fileName) {
	const match = /^(.+?)(?:--(.+))?\.(dark|light)\.png$/.exec(fileName);
	return match ? { view: match[1], state: match[2] || null, theme: match[3] } : null;
}

function listShots(dir) {
	if (!fs.existsSync(dir)) { return new Map(); }
	const shots = new Map();
	for (const fileName of fs.readdirSync(dir)) {
		const parsed = parseShotName(fileName);
		if (parsed) { shots.set(fileName, { ...parsed, fileName, filePath: path.join(dir, fileName) }); }
	}
	return shots;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.baseline || !args.current) {
		console.error('Usage: node diff-screenshots.js --baseline <dir> --current <dir> [--out <dir>] [--threshold <0-1>] [--noise-floor <pixels>]');
		process.exit(1);
	}

	const baselineDir = path.resolve(args.baseline);
	const currentDir = path.resolve(args.current);
	const outDir = path.resolve(args.out || path.join(path.dirname(currentDir), 'diff'));
	// Per-channel tolerance, 0–1. Anti-aliasing and sub-pixel text rendering move
	// a channel by a hair between otherwise identical runs; 0.02 (~5/255)
	// absorbs that without hiding a real colour or layout change.
	const threshold = Number(args.threshold ?? 0.02);
	// Views that draw to a <canvas> (the chart's Chart.js surface, the fluency
	// radar) can differ by a handful of anti-aliased pixels between otherwise
	// identical runs. That tolerance is set per view in views.config.json rather
	// than globally, because a blanket floor would also hide small real changes
	// in the text-and-DOM views — a badge's corner radius moves only ~180px.
	// Everything without an explicit floor is compared exactly.
	const noiseFloors = new Map();
	for (const v of readConfig(__dirname).views) {
		noiseFloors.set(v.id, v.noiseFloorPixels || 0);
		// A state may override its view's floor: the Models tab draws to a canvas
		// even though the efficiency view's initial render is compared exactly.
		for (const state of v.states || []) {
			noiseFloors.set(`${v.id}--${state.id}`, state.noiseFloorPixels ?? v.noiseFloorPixels ?? 0);
		}
	}
	const overrideFloor = args['noise-floor'] === undefined ? undefined : Number(args['noise-floor']);

	fs.mkdirSync(outDir, { recursive: true });

	const baseline = listShots(baselineDir);
	const current = listShots(currentDir);
	const allNames = [...new Set([...baseline.keys(), ...current.keys()])].sort();

	if (allNames.length === 0) {
		console.error(`No screenshots found in ${baselineDir} or ${currentDir}.`);
		process.exit(1);
	}

	const chromium = loadChromium();
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const comparisons = [];

	try {
		for (const name of allNames) {
			const before = baseline.get(name);
			const after = current.get(name);
			const meta = before || after;

			if (!before) {
				comparisons.push({ ...pick(meta), status: 'added', current: name });
				console.log(`🆕 ${label(meta)} (${meta.theme}) — new view screenshot`);
				continue;
			}
			if (!after) {
				comparisons.push({ ...pick(meta), status: 'removed', baseline: name });
				console.log(`🗑️  ${label(meta)} (${meta.theme}) — no longer rendered`);
				continue;
			}

			const diffPath = path.join(outDir, `${label(meta)}.${meta.theme}.diff.png`);
			const result = await diffImagesInPage(page, before.filePath, after.filePath, diffPath, threshold);

			const noiseFloor = overrideFloor ?? noiseFloors.get(label(meta)) ?? noiseFloors.get(meta.view) ?? 0;
			const status = result.changedPixels > noiseFloor ? 'changed' : 'unchanged';
			comparisons.push({
				...pick(meta),
				status,
				baseline: name,
				current: name,
				...result,
				noiseFloor,
				diff: status === 'changed' ? path.basename(diffPath) : undefined,
			});

			if (status === 'unchanged') {
				fs.rmSync(diffPath, { force: true });
				const noise = result.changedPixels > 0 ? ` (${result.changedPixels}px within the ${noiseFloor}px canvas tolerance)` : '';
				console.log(`⚪ ${label(meta)} (${meta.theme}) — identical${noise}`);
			} else {
				const sizeNote = result.resized ? `, size ${result.baselineSize} → ${result.currentSize}` : '';
				console.log(`🎨 ${label(meta)} (${meta.theme}) — ${result.changedPercent.toFixed(2)}% of pixels differ${sizeNote}`);
			}
		}
	} finally {
		await browser.close();
	}

	const report = {
		generatedAt: new Date().toISOString(),
		baselineDir,
		currentDir,
		threshold,
		summary: {
			changed: comparisons.filter((c) => c.status === 'changed').length,
			unchanged: comparisons.filter((c) => c.status === 'unchanged').length,
			added: comparisons.filter((c) => c.status === 'added').length,
			removed: comparisons.filter((c) => c.status === 'removed').length,
		},
		comparisons,
	};

	fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
	fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdownReport(report));

	const { changed, added, removed } = report.summary;
	console.log(`\n${changed} changed, ${added} added, ${removed} removed, ${report.summary.unchanged} unchanged`);
	console.log(`Report → ${path.join(outDir, 'report.md')}`);
}

/** `usage` for the initial render, `usage--tools` for a state. */
function label({ view, state }) {
	return state ? `${view}--${state}` : view;
}

function pick({ view, state, theme }) {
	return { view, state, theme };
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
