import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmpFixtureDir } from './tmpFixtureDirs';

// The desktop app reuses this extension's webview bundles. These checks live in
// repo-root scripts/ (plain CommonJS, loaded by path) and run here too, so a new
// webview button or theme token fails the extension's own suite until the
// desktop app decides what to do with it — not just the desktop's CI job.
const requireFromHere = createRequire(__filename);

function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, 'scripts', 'validate-desktop-contract.js'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the repo root from ${__dirname}`);
}

const REPO_ROOT = findRepoRoot();

type Finding = { kind: string; command: string; detail: string };
const desktopContract = requireFromHere(path.join(REPO_ROOT, 'scripts', 'validate-desktop-contract.js')) as {
	readDesktopViews: () => string[];
	collectViewFiles: (entry: string) => string[];
	collectIpcHandledCommands: (file: string) => Set<string>;
	collectComputedPostedCommands: (files: string[]) => { posted: Map<string, unknown[]>; unresolved: { key: string }[] };
	parseViewFiles: (files: string[]) => unknown[];
	indexFunctions: (parsed: unknown[]) => unknown;
	collectPostSites: (parsed: unknown[], index: unknown) => { node: unknown; pf: { sf: unknown }; names: Set<string> }[];
	controlsForSite: (node: unknown, sf: unknown, parsed: unknown[]) => Set<string> | undefined;
	selectorOverreach: (token: string, postedBy: Set<string>, viewOwnTexts: Map<string, string>) => string[];
	analyse: () => { views: string[]; findings: Finding[] };
};
const webviewShell = requireFromHere(path.join(REPO_ROOT, 'scripts', 'validate-webview-shell.js')) as {
	analyse: () => { referenced: number; findings: string[] };
};

test('desktop contract: every message a desktop view posts is handled or listed as unsupported', () => {
	const { findings } = desktopContract.analyse();
	assert.deepEqual(
		findings.map(f => `${f.command}: ${f.detail}`),
		[],
		'run `pnpm run check:contract` in desktop/ for details',
	);
});

test('desktop contract: reads the bundled views from desktop/esbuild.js', () => {
	const views = desktopContract.readDesktopViews();
	assert.ok(views.includes('details'), `expected 'details' among ${views.join(', ')}`);
	for (const view of views) {
		assert.ok(
			fs.existsSync(path.join(REPO_ROOT, 'vscode-extension', 'src', 'webview', view, 'main.ts')),
			`desktop bundles ${view}.js but its webview entry point does not exist`,
		);
	}
});

test('desktop contract: a view only owns the files it imports', () => {
	const dir = makeTmpFixtureDir('desktop-contract-');
	fs.mkdirSync(path.join(dir, 'view'));
	fs.mkdirSync(path.join(dir, 'shared'));
	fs.writeFileSync(path.join(dir, 'view', 'main.ts'), `import { a } from '../shared/used';\nimport 'external-pkg';\n`);
	fs.writeFileSync(path.join(dir, 'shared', 'used.ts'), `export { b as a } from './nested';\n`);
	fs.writeFileSync(path.join(dir, 'shared', 'nested.ts'), `export const b = 1;\n`);
	fs.writeFileSync(path.join(dir, 'shared', 'unused.ts'), `export const c = 2;\n`);

	const files = desktopContract.collectViewFiles(path.join(dir, 'view', 'main.ts'))
		.map(f => path.relative(dir, f).split(path.sep).join('/'))
		.sort();
	assert.deepEqual(files, ['shared/nested.ts', 'shared/used.ts', 'view/main.ts']);
});

test('desktop contract: only registerIpcHandlers counts as handling a command', () => {
	// Keys of an unrelated Record<string, …> map or a comparison elsewhere in
	// main.ts must not pass for an IPC handler.
	const dir = makeTmpFixtureDir('desktop-ipc-');
	const file = path.join(dir, 'main.ts');
	fs.writeFileSync(file, `
		declare const ipcMain: any; declare const other: { command: string };
		const STATIC_MIME_TYPES: Record<string, string> = { refreshAll: 'text/javascript' };
		if (other.command === 'elsewhere') { /* not the IPC dispatch */ }
		function registerIpcHandlers(): void {
			ipcMain.on('webview-message', (_e: unknown, message: { command: string }) => {
				switch (message.command) {
					case 'refresh': run(); break;
					// Fall-through shares the next clause's body.
					case 'showMaturity':
					case 'showDashboard':
						run();
						break;
					// Looks like a handler, drops the message: not handled.
					case 'saveSortSettings':
						// stored in memory for now
						break;
					case 'emptyFallThrough':
					default:
						break;
				}
				if (message.command === 'copyText') { run(); }
				if (message.command === 'emptyIf') { /* nothing */ }
			});
		}
		function run(): void { /* stub */ }
	`);
	assert.deepEqual(
		[...desktopContract.collectIpcHandledCommands(file)].sort(),
		['copyText', 'refresh', 'showDashboard', 'showMaturity'],
	);
});

test('desktop contract: a hidden selector must not reach views that do not post its command', () => {
	// Desktop CSS applies to every panel. `.share-btn` sat on both the Diagnostics
	// and the Fluency Score share buttons, so hiding it for Diagnostics' command
	// silently hid Fluency Score's controls too.
	const viewOwnTexts = new Map([
		['diagnostics', '<button id="btn-share-card-linkedin" class="share-btn">'],
		['maturity', '<button id="btn-share-linkedin" class="share-btn">'],
	]);
	const postedBy = new Set(['diagnostics']);
	assert.deepEqual(desktopContract.selectorOverreach('share-btn', postedBy, viewOwnTexts), ['maturity']);
	assert.deepEqual(desktopContract.selectorOverreach('btn-share-card-linkedin', postedBy, viewOwnTexts), []);
	// Whole-word match: an id that merely starts with the token is a different control.
	assert.deepEqual(desktopContract.selectorOverreach('btn-share', postedBy, viewOwnTexts), []);
});

test('desktop contract: resolves commands whose name is computed at runtime', () => {
	// The Fluency Score hook buttons post `{ command: action }` with `action` read
	// from the clicked button's data-action: the literal scan sees no name at all.
	const dir = makeTmpFixtureDir('desktop-computed-');
	const file = path.join(dir, 'main.ts');
	fs.writeFileSync(file, `
		declare const vscode: { postMessage(m: unknown): void }; declare const items: { command: string }[];
		const markup = \`
			<button class="hook-reminder-btn active" data-action="uninstallHook">x</button>
			<button class="hook-reminder-btn" data-action="installHook">y</button>
			<button class="mcp-discover-btn" data-action="searchMcp">z</button>\`;
		function wireHooks(): void {
			document.querySelectorAll('.hook-reminder-btn').forEach(btn => {
				btn.addEventListener('click', (e) => {
					const action = (e.currentTarget as HTMLElement).getAttribute('data-action');
					if (action) { vscode.postMessage({ command: action }); }
				});
			});
		}
		function exportAs(command: 'exportPdf' | 'exportPptx'): void { vscode.postMessage({ command, data: [] }); }
		function runFromData(): void { for (const item of items) { vscode.postMessage({ command: item.command }); } }
		vscode.postMessage({ command: 'literalIsNotOurs' });
	`);
	const { posted, unresolved } = desktopContract.collectComputedPostedCommands([file]);
	// searchMcp is on another class, which the .hook-reminder-btn handler never sees.
	assert.deepEqual([...posted.keys()].sort(), ['exportPdf', 'exportPptx', 'installHook', 'uninstallHook']);
	assert.deepEqual(unresolved.map(u => u.key.replace(/^.*#/, '')), ['runFromData:item.command']);
});

test('desktop contract: follows message objects built by a helper and forwarded', () => {
	// serverMemories.ts shape: a helper returns the message, its caller forwards it
	// through a `postMessage` parameter, and the view passes a relay lambda in.
	const dir = makeTmpFixtureDir('desktop-forwarded-');
	const helper = path.join(dir, 'helper.ts');
	const main = path.join(dir, 'main.ts');
	fs.writeFileSync(helper, `
		export function messageForClick(ok: boolean) {
			return ok ? { command: 'draftPromotion', subject: 's' } : { command: 'openCitation', path: 'p' };
		}
		export function wireButtons(postMessage: (m: unknown) => void): void {
			document.addEventListener('click', () => {
				const message = messageForClick(true);
				if (message) { postMessage(message); }
			});
		}
		export function wireOther(send: (m: unknown) => void): void { send({ command: 'neverSeen' }); }
	`);
	fs.writeFileSync(main, `
		import { wireButtons, wireOther } from './helper';
		declare const vscode: { postMessage(m: unknown): void };
		wireButtons(message => vscode.postMessage(message));
		wireOther(message => vscode.postMessage(message));
	`);
	const { posted, unresolved } = desktopContract.collectComputedPostedCommands([helper, main]);
	assert.deepEqual([...posted.keys()].sort(), ['draftPromotion', 'openCitation']);
	// The second relay hands messages to a parameter called `send`, whose calls the
	// scan does not visit, so it must stay unresolved instead of passing silently.
	assert.deepEqual(unresolved.map(u => u.key.replace(/^.*#/, '')), ['<module>>wireOther:message']);
});

test('desktop contract: finds the control behind each post of a hidden command', () => {
	const dir = makeTmpFixtureDir('desktop-controls-');
	const file = path.join(dir, 'main.ts');
	fs.writeFileSync(file, `
		declare const vscode: { postMessage(m: unknown): void };
		const LINKS = '.open-link, .report-link';
		function wire(): void {
			const efficiency = document.getElementById('btn-efficiency');
			efficiency?.addEventListener('click', () => vscode.postMessage({ command: 'showEfficiency' }));
			// A second button posting the same, already-hidden command.
			document.getElementById('btn-efficiency-2')?.addEventListener('click', () => vscode.postMessage({ command: 'showEfficiency' }));
			document.querySelectorAll('.hook-btn').forEach(btn => btn.addEventListener('click', () => vscode.postMessage({ command: 'installHook' })));
			for (const { id } of [{ id: 'btn-share-a' }, { id: 'btn-share-b' }]) {
				document.getElementById(id)?.addEventListener('click', () => vscode.postMessage({ command: 'share' }));
			}
			document.addEventListener('click', (e) => {
				const link = (e.target as Element).closest(LINKS);
				if (!link) { return; }
				if (link.classList.contains('open-link')) {
					vscode.postMessage({ command: 'open' });
				} else {
					vscode.postMessage({ command: 'report' });
				}
				const target = e.target as HTMLElement;
				if (target.id === 'btn-clear' || target.id === 'btn-clear-tab') { clearCache(); }
			});
		}
		function clearCache(): void { vscode.postMessage({ command: 'clearCache' }); }
		function nobodyCallsThis(): void { vscode.postMessage({ command: 'orphan' }); }
	`);
	const parsed = desktopContract.parseViewFiles([file]);
	const controls = new Map<string, string[]>();
	for (const site of desktopContract.collectPostSites(parsed, desktopContract.indexFunctions(parsed))) {
		const found = desktopContract.controlsForSite(site.node, site.pf.sf, parsed);
		for (const name of site.names) {
			controls.set(name, [...(controls.get(name) ?? []), ...(found ? [...found] : ['?'])]);
		}
	}
	assert.deepEqual(controls.get('showEfficiency'), ['#btn-efficiency', '#btn-efficiency-2']);
	assert.deepEqual(controls.get('installHook'), ['.hook-btn']);
	assert.deepEqual(controls.get('share'), ['#btn-share-a', '#btn-share-b']);
	assert.deepEqual(controls.get('open'), ['.open-link']);
	assert.deepEqual(controls.get('report'), ['.report-link']);
	assert.deepEqual(controls.get('clearCache'), ['#btn-clear', '#btn-clear-tab']);
	assert.deepEqual(controls.get('orphan'), ['?']);
});

test('desktop-build.yml: push paths match the PR desktop-relevant filter', () => {
	// A path only in the job filter is checked on PRs but never on pushes to main:
	// the push trigger's own `paths:` decides whether the workflow starts at all.
	const yml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'desktop-build.yml'), 'utf8').replace(/\r\n/g, '\n');
	const quotedPaths = (block: string) => [...block.matchAll(/^\s*- '([^']+)'/gm)].map(m => m[1]).sort();
	const pushBlock = yml.slice(yml.indexOf('  push:'), yml.indexOf('  pull_request:'));
	const filterStart = yml.indexOf('desktop-relevant:\n');
	assert.ok(filterStart > 0, 'desktop-relevant filter not found in desktop-build.yml');
	const filterBlock = yml.slice(filterStart, yml.indexOf('\n\n', filterStart));
	assert.ok(quotedPaths(pushBlock).length > 0, 'no push paths found in desktop-build.yml');
	assert.deepEqual(quotedPaths(pushBlock), quotedPaths(filterBlock));
});

test('webview shell: every --vscode-* token the webviews use is defined for the desktop app and harness', () => {
	const { referenced, findings } = webviewShell.analyse();
	assert.ok(referenced > 0, 'found no --vscode-* references; has the webview source moved?');
	assert.deepEqual(findings, [], 'run `pnpm run check:shell` in desktop/ for details');
});
