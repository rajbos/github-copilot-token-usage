#!/usr/bin/env node
'use strict';

/**
 * End-to-end visual comparison: builds the webviews at a baseline commit and at
 * the working tree, renders both, and reports which views changed.
 *
 * Usage:
 *   node visual-diff.js [--base <ref>] [--out <dir>] [--theme dark|light|both] [--view <id>]
 *                       [--concurrency <n>]
 *
 * Both sides are built first, then rendered at the same time, each with
 * `--concurrency` pages open at once (default 4, so twice that in total).
 * Rendering is almost all settle waits, which is why overlapping it is where
 * the time goes; the builds take about a second each. How long every phase
 * took is printed at the end and written to `<out>/timings.md`.
 *
 * The baseline is built in a detached `git worktree`, so the working tree is
 * never touched — no stashing, no checking out another branch under the user's
 * feet. `node_modules` is symlinked into that worktree rather than installed
 * again, which turns a multi-minute npm install into a few seconds.
 *
 * This produces images and a Markdown report. It does not post them anywhere;
 * see SKILL.md for why that boundary exists.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { REPO_ROOT } = require('./lib/harness');
const { parseArgs, readConfig, baselineRegistry } = require('./lib/config');
const { parseConcurrency } = require('./lib/pool');

const SKILL_DIR = __dirname;

function git(args, options = {}) {
	return execFileSync('git', args, {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		...options,
	}).trim();
}

function run(command, args, cwd) {
	execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * Picks the commit to compare against.
 *
 * A branch's merge base — not the tip of main — is the right baseline: it is
 * the state the branch actually started from, so unrelated changes that landed
 * on main since then do not show up as "visual changes in this PR".
 */
function resolveBaseRef(requested) {
	const candidates = requested ? [requested] : ['origin/main', 'main'];
	for (const candidate of candidates) {
		try {
			git(['rev-parse', '--verify', `${candidate}^{commit}`]);
		} catch {
			continue;
		}
		try {
			return { ref: candidate, sha: git(['merge-base', 'HEAD', candidate]) };
		} catch {
			return { ref: candidate, sha: git(['rev-parse', `${candidate}^{commit}`]) };
		}
	}
	throw new Error(
		`Could not resolve a baseline commit from ${candidates.join(', ')}. Pass one explicitly with --base <ref>.`,
	);
}

/**
 * Warns when the baseline is probably not what the caller thinks it is.
 *
 * On a shallow clone `origin/main` can be dozens of commits behind, and the
 * merge base then lands on a much older tree — so half the views come back
 * "changed" for reasons that have nothing to do with the change under review.
 * The run is still useful, but only if you know that is what you are looking
 * at, so say so rather than printing a wall of confident-looking diffs.
 */
function warnIfBaselineLooksStale(base) {
	let shallow = false;
	try {
		shallow = git(['rev-parse', '--is-shallow-repository']) === 'true';
	} catch {
		return;
	}
	if (!shallow) {
		return;
	}
	let behind = '';
	try {
		behind = ` (${git(['rev-list', '--count', `${base.sha}..HEAD`])} commit(s) from HEAD)`;
	} catch {
		/* best effort */
	}
	console.warn(
		`\n⚠️  This is a shallow clone, so ${base.ref} may be far behind its real tip${behind}.` +
		`\n   Views can show as changed because the baseline is old, not because your change touched them.` +
		`\n   Run \`git fetch --unshallow\` for a trustworthy comparison, or pass --base <ref> explicitly.\n`,
	);
}

function buildWebviews(checkoutRoot, label) {
	const extensionDir = path.join(checkoutRoot, 'vscode-extension');
	const nodeModules = path.join(extensionDir, 'node_modules');

	if (!fs.existsSync(nodeModules)) {
		// Reuse the working tree's install: esbuild is the only thing the bundle
		// build needs, and dependencies rarely differ across a single PR.
		const source = path.join(REPO_ROOT, 'vscode-extension', 'node_modules');
		if (!fs.existsSync(source)) {
			throw new Error(`vscode-extension/node_modules is missing — run \`npm install\` in vscode-extension/ first.`);
		}
		fs.symlinkSync(source, nodeModules, 'dir');
	}

	console.log(`\n▶ Building webview bundles (${label})…`);
	// Invoke esbuild directly because baseline revisions may still define
	// `npm run compile` as a combined type-check, lint, and bundle command.
	run(process.execPath, ['esbuild.js'], extensionDir);
}

/**
 * Runs a Node script without blocking, prefixing every output line with
 * `label` so two renders running side by side stay readable in one log.
 * Resolves on exit code 0 and rejects otherwise.
 */
function runPrefixed(args, cwd, label) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		const relay = (stream, sink) => {
			let pending = '';
			stream.setEncoding('utf8');
			stream.on('data', (chunk) => {
				pending += chunk;
				const lines = pending.split('\n');
				pending = lines.pop();
				for (const line of lines) { sink.write(`[${label}] ${line}\n`); }
			});
			stream.on('end', () => { if (pending) { sink.write(`[${label}] ${pending}\n`); } });
		};
		relay(child.stdout, process.stdout);
		relay(child.stderr, process.stderr);
		child.on('error', reject);
		child.on('close', (code, signal) => {
			if (code === 0) { resolve(); return; }
			reject(new Error(`Rendering the ${label} views failed (${signal ? `signal ${signal}` : `exit code ${code}`}).`));
		});
	});
}

function renderInto(outDir, { label, distDir, repoRoot, theme, view, allowMissing, configPath, concurrency }) {
	const args = [path.join(SKILL_DIR, 'render-views.js'), '--out', outDir, '--dist', distDir, '--repo-root', repoRoot];
	args.push('--concurrency', String(concurrency));
	if (theme) { args.push('--theme', theme); }
	if (view) { args.push('--view', view); }
	// The baseline is rendered from the base commit's registry plus the
	// current-only targets (see writeBaselineRegistry). A view or state this
	// branch introduced has nothing to render at the base commit — an "added"
	// screenshot, not a failed run — and one the branch removed still renders
	// there, so the comparison can call it "removed".
	if (allowMissing) { args.push('--allow-missing'); }
	if (configPath) { args.push('--config', configPath); }
	return runPrefixed(args, REPO_ROOT, label);
}

/**
 * Records how long each phase took, so a slow CI job says where its time went
 * instead of leaving that to be reconstructed from step timestamps.
 */
function createTimer() {
	const phases = [];
	return {
		phases,
		async time(name, fn) {
			const startedAt = Date.now();
			try {
				return await fn();
			} finally {
				phases.push({ name, seconds: (Date.now() - startedAt) / 1000 });
			}
		},
	};
}

function writeTimings(outRoot, phases, totalSeconds, concurrency) {
	const markdown = [
		'### Visual diff timings',
		'',
		`${concurrency} page(s) at a time per side. Baseline and current render concurrently, so their rows overlap inside "Render (both sides)".`,
		'',
		'| Phase | Duration |',
		'| --- | ---: |',
		...phases.map((p) => `| ${p.name} | ${p.seconds.toFixed(1)} s |`),
		`| **Total** | **${totalSeconds.toFixed(1)} s** |`,
		'',
	].join('\n');
	fs.writeFileSync(path.join(outRoot, 'timings.md'), markdown);
	console.log('\nTimings:');
	for (const p of phases) { console.log(`  ${p.name.padEnd(22)} ${p.seconds.toFixed(1).padStart(7)} s`); }
	console.log(`  ${'Total'.padEnd(22)} ${totalSeconds.toFixed(1).padStart(7)} s`);
}

/**
 * Writes the registry the baseline renders from: the base commit's own
 * registry (its definitions, fixtures and bundles) plus every view and state
 * only the current registry declares, flagged so `--allow-missing` skips
 * exactly those when the old bundle cannot produce them. See
 * `baselineRegistry` in lib/config.js.
 */
function writeBaselineRegistry(worktreeDir, outRoot) {
	const baseSkillDir = path.join(worktreeDir, '.github', 'skills', 'visual-view-diff');
	// Only a base commit that predates the registry takes the no-base path.
	// A registry that exists but cannot be read or validated must fail the
	// run: treating it as absent would flag every target current-only and
	// let the diff finish with an all-"added" report that hides removals and
	// every real before/after comparison.
	let base = null;
	if (fs.existsSync(path.join(baseSkillDir, 'views.config.json'))) {
		base = readConfig(baseSkillDir);
	}
	const merged = baselineRegistry(readConfig(SKILL_DIR), base, {
		baseFixtureDir: path.join(baseSkillDir, 'fixtures'),
		currentFixtureDir: path.join(SKILL_DIR, 'fixtures'),
	});
	const label = (v, s) => (s ? `${v.id}--${s.id}` : v.id);
	const currentOnly = merged.views.flatMap((v) => v.currentOnly
		? [label(v)]
		: (v.states || []).filter((s) => s.currentOnly).map((s) => label(v, s)));
	const currentIds = new Set(readConfig(SKILL_DIR).views.map((v) => v.id));
	const baseOnly = merged.views.flatMap((v) => !currentIds.has(v.id)
		? [label(v)]
		: []);
	if (!base) {
		console.log('The base commit has no views.config.json; every view and state counts as new there.');
	}
	if (currentOnly.length > 0 && base) {
		console.log(`Only this branch declares ${currentOnly.length} view/state(s): ${currentOnly.join(', ')} — rendered on the baseline where the old bundle allows, skipped otherwise.`);
	}
	if (baseOnly.length > 0) {
		console.log(`Only the base commit declares ${baseOnly.length} view(s): ${baseOnly.join(', ')} — rendered on the baseline side so the diff can report them as removed.`);
	}
	const file = path.join(outRoot, '.baseline-registry.json');
	fs.writeFileSync(file, JSON.stringify(merged, null, 2));
	return file;
}

async function main() {
	const startedAt = Date.now();
	const args = parseArgs(process.argv.slice(2));
	const outRoot = path.resolve(args.out || path.join(REPO_ROOT, 'visual-output'));
	const theme = args.theme || 'dark';
	const view = typeof args.view === 'string' ? args.view : undefined;
	const concurrency = parseConcurrency(args.concurrency);
	const timer = createTimer();

	const base = resolveBaseRef(typeof args.base === 'string' ? args.base : undefined);
	console.log(`Baseline: ${base.sha.slice(0, 12)} (merge base with ${base.ref})`);
	warnIfBaselineLooksStale(base);

	const baselineDir = path.join(outRoot, 'baseline');
	const currentDir = path.join(outRoot, 'current');
	const diffDir = path.join(outRoot, 'diff');
	for (const dir of [baselineDir, currentDir, diffDir]) {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.rmSync(path.join(outRoot, 'timings.md'), { force: true });

	const worktreeDir = path.join(outRoot, '.baseline-worktree');
	fs.rmSync(worktreeDir, { recursive: true, force: true });

	try {
		await timer.time('Check out baseline', () => {
			console.log(`\n▶ Checking out the baseline into a temporary worktree…`);
			git(['worktree', 'add', '--detach', worktreeDir, base.sha]);
		});

		// Both builds finish before either render starts. They write to separate
		// dist directories, so the renders can then run side by side.
		await timer.time('Build baseline', () => buildWebviews(worktreeDir, 'baseline'));
		await timer.time('Build current', () => buildWebviews(REPO_ROOT, 'working tree'));
		const baselineConfig = writeBaselineRegistry(worktreeDir, outRoot);

		console.log(`\n▶ Rendering baseline and current views…`);
		// allSettled, not all: when one side fails, the other must finish before
		// the finally block below removes the worktree it may be reading from.
		const renders = await timer.time('Render (both sides)', () => Promise.allSettled([
			timer.time('Render baseline', () => renderInto(baselineDir, {
				label: 'baseline',
				distDir: path.join(worktreeDir, 'vscode-extension', 'dist', 'webview'),
				repoRoot: worktreeDir,
				theme,
				view,
				allowMissing: true,
				configPath: baselineConfig,
				concurrency,
			})),
			timer.time('Render current', () => renderInto(currentDir, {
				label: 'current',
				distDir: path.join(REPO_ROOT, 'vscode-extension', 'dist', 'webview'),
				repoRoot: REPO_ROOT,
				theme,
				view,
				concurrency,
			})),
		]));
		const failedRender = renders.find((r) => r.status === 'rejected');
		if (failedRender) { throw failedRender.reason; }

		await timer.time('Compare', () => {
			console.log(`\n▶ Comparing…`);
			run(process.execPath, [
				path.join(SKILL_DIR, 'diff-screenshots.js'),
				'--baseline', baselineDir,
				'--current', currentDir,
				'--out', diffDir,
			], REPO_ROOT);
		});
	} finally {
		fs.rmSync(path.join(outRoot, '.baseline-registry.json'), { force: true });
		// Always remove the worktree, or the next run trips over a stale one.
		try {
			git(['worktree', 'remove', '--force', worktreeDir]);
		} catch {
			fs.rmSync(worktreeDir, { recursive: true, force: true });
			try { git(['worktree', 'prune']); } catch { /* best effort */ }
		}
		// Written on failure too: a slow run that then failed is exactly the
		// one whose timings someone will want.
		writeTimings(outRoot, timer.phases, (Date.now() - startedAt) / 1000, concurrency);
	}

	console.log(`\nScreenshots and report are under ${path.relative(process.cwd(), outRoot) || outRoot}/`);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`\n${error && error.message || error}`);
		process.exit(1);
	});
}
