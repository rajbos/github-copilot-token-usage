/// <reference path="../../src/types/jsdom.d.ts" />
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

/**
 * Regression test: the Chart view's Summary → "By Editor" section remembers whether the user
 * collapsed it. The flag lives in `vscode.getState()/setState()`, so a panel that is hidden and
 * re-shown (or VS Code restarting) must come back in the same state instead of always opening.
 *
 * The *real* `src/webview/chart/main.ts` is bundled and executed in jsdom; a fake
 * `acquireVsCodeApi` keeps state across "reloads" the way VS Code does.
 */

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY = path.join(EXT_ROOT, 'src', 'webview', 'chart', 'main.ts');
const FIXTURE = path.join(EXT_ROOT, '..', '.github', 'skills', 'visual-view-diff', 'fixtures', 'chart.json');

let bundlePromise: Promise<string> | undefined;

/** Chart.js is stubbed: jsdom has no canvas and the chart itself is not under test. */
const stubChartPlugin: esbuild.Plugin = {
	name: 'stub-chartjs',
	setup(build) {
		build.onResolve({ filter: /^chart\.js\/auto$/ }, () => ({ path: 'chartjs-stub', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: 'export default class Chart { destroy() {} update() {} }',
			loader: 'js',
		}));
	},
};

function bundleChartWebview(): Promise<string> {
	bundlePromise ??= esbuild.build({
		entryPoints: [ENTRY],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		nodePaths: [path.join(EXT_ROOT, 'node_modules')],
		loader: { '.css': 'text', '.svg': 'dataurl', '.png': 'dataurl' },
		plugins: [stubChartPlugin],
		logLevel: 'silent',
	}).then((result) => result.outputFiles[0].text);
	return bundlePromise;
}

/** Boots the chart webview; `state` is what `getState()` returns, like a restored VS Code panel. */
async function bootChart(
	state: { current: unknown },
	editorTotalsMap?: Record<string, number>,
	host?: { initial?: boolean; posted?: any[] },
): Promise<any> {
	const bundle = await bundleChartWebview();
	const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://example.org/',
	});
	const window = dom.window as any;
	window.acquireVsCodeApi = () => ({
		postMessage: (message: unknown) => { host?.posted?.push(message); },
		getState: () => state.current,
		setState: (next: unknown) => { state.current = next; },
	});
	window.HTMLElement.prototype.attachInternals = () => ({
		setFormValue() { /* no-op */ }, setValidity() { /* no-op */ }, form: null, states: new Set(), role: null,
	});
	if (editorTotalsMap) { data.editorTotalsMap = editorTotalsMap; }
	if (host?.initial !== undefined) { data.initialEditorListCollapsed = host.initial; }
	window.__INITIAL_CHART__ = data;
	window.eval(bundle);
	for (let i = 0; i < 20; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	return window;
}

const isCollapsed = (window: any): boolean =>
	window.document.getElementById('editor-cards').classList.contains('hidden');

test('By Editor section starts expanded when nothing was saved', async () => {
	const window = await bootChart({ current: undefined });
	assert.equal(isCollapsed(window), false);
	assert.equal(window.document.getElementById('editor-list-toggle').getAttribute('aria-expanded'), 'true');
});

test('collapsing By Editor persists and is restored when the panel is re-opened', async () => {
	const state: { current: any } = { current: undefined };
	const first = await bootChart(state);
	first.document.getElementById('editor-list-toggle').dispatchEvent(new first.MouseEvent('click', { bubbles: true }));
	assert.equal(isCollapsed(first), true, 'clicking collapses the cards');
	assert.equal(state.current?.editorListCollapsed, true, 'the collapsed flag was written to webview state');

	// Same persisted state, brand-new JS context — what happens when the tab is hidden/re-shown.
	const second = await bootChart(state);
	assert.equal(isCollapsed(second), true, 'cards stay collapsed after reopening');
	const toggle = second.document.getElementById('editor-list-toggle');
	assert.equal(toggle.getAttribute('aria-expanded'), 'false');
	assert.match(toggle.textContent, /▸/);
});

test('collapsed state survives changing other chart toggles', async () => {
	const state: { current: any } = { current: undefined };
	const first = await bootChart(state);
	first.document.getElementById('editor-list-toggle').dispatchEvent(new first.MouseEvent('click', { bubbles: true }));
	first.document.getElementById('metric-cost').dispatchEvent(new first.MouseEvent('click', { bubbles: true }));
	for (let i = 0; i < 20; i++) { await new Promise((resolve) => setImmediate(resolve)); }
	assert.equal(state.current?.editorListCollapsed, true, 'a full-state save keeps the flag');

	const second = await bootChart(state);
	assert.equal(isCollapsed(second), true);
});

test('expanding again is persisted too', async () => {
	const state: { current: any } = { current: { editorListCollapsed: true } };
	const first = await bootChart(state);
	assert.equal(isCollapsed(first), true, 'restored collapsed');
	first.document.getElementById('editor-list-toggle').dispatchEvent(new first.MouseEvent('click', { bubbles: true }));
	assert.equal(state.current?.editorListCollapsed, false);
	const second = await bootChart(state);
	assert.equal(isCollapsed(second), false);
});

test('toggling By Editor tells the extension host so it outlives the panel', async () => {
	const posted: any[] = [];
	const w = await bootChart({ current: undefined }, undefined, { posted });
	w.document.getElementById('editor-list-toggle').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	assert.ok(posted.some((m) => m.command === 'setEditorListCollapsed' && m.collapsed === true));
});

test('host-persisted collapsed flag seeds a brand-new panel that has no webview state', async () => {
	const collapsed = await bootChart({ current: undefined }, undefined, { initial: true });
	assert.equal(isCollapsed(collapsed), true);
	const hidden = await bootChart({ current: { editorListCollapsed: true } }, undefined, { initial: false });
	assert.equal(isCollapsed(hidden), true, 'newer webview state wins over the stale host snapshot on hide/show');
	const reexpanded = await bootChart({ current: { editorListCollapsed: false } }, undefined, { initial: true });
	assert.equal(isCollapsed(reexpanded), false, 'an explicit expanded flag is respected');
});

test('editor cards show the official logo, with the emoji as fallback for tools without one', async () => {
	const window = await bootChart({ current: undefined }, { 'VS Code': 5, 'Copilot CLI': 4, 'Unknown': 3 });
	const vscodeCard = window.document.getElementById('editor-VS Code');
	assert.ok(vscodeCard, 'fixture has a VS Code card');
	assert.match(vscodeCard.querySelector('img.editor-logo')?.getAttribute('src') ?? '', /^data:image\/svg\+xml/);
	const copilot = window.document.getElementById('editor-Copilot CLI');
	assert.equal(copilot.querySelectorAll('img.editor-logo').length, 2, 'light + dark variant');
	const unknown = window.document.getElementById('editor-Unknown');
	assert.equal(unknown.querySelector('img'), null);
	assert.equal(unknown.querySelector('.editor-logo-emoji')?.textContent, '❓');
});

test('every tool with an official logo renders an <img>, including dark variants', async () => {
	const withLogo = ['Claude Code', 'Claude Desktop', 'Cline', 'Continue', 'Copilot CLI', 'Crush', 'Cursor', 'Devin', 'Eclipse',
		'Gemini CLI', 'JetBrains', 'Kiro', 'Mistral Vibe', 'OpenCode', 'Pi', 'Visual Studio', 'VS Code', 'VSCodium', 'Windsurf',
		'Antigravity', 'Codex CLI', 'Hermes', 'Kilo Code', 'SSMS', 'MS Scout (Copilot CLI)'];
	const window = await bootChart({ current: undefined }, Object.fromEntries(withLogo.map((n) => [n, 1])));
	for (const name of withLogo) {
		const imgs = window.document.getElementById(`editor-${name}`).querySelectorAll('img.editor-logo');
		assert.ok(imgs.length >= 1, `${name} has a logo`);
	}
	for (const name of ['Cline', 'Devin', 'Eclipse', 'JetBrains', 'OpenCode', 'Pi', 'Windsurf', 'Codex CLI', 'Hermes', 'Kilo Code']) {
		assert.equal(window.document.getElementById(`editor-${name}`).querySelectorAll('img.editor-logo').length, 2, `${name} has a dark variant`);
	}
});

test('logo theme: declared kind wins, otherwise page background, otherwise dark', async () => {
	const w = await bootChart({ current: undefined });
	const body = w.document.body;
	assert.equal(body.getAttribute('data-logo-theme'), 'dark', 'no theme info → dark (VS/JetBrains default)');
	body.setAttribute('data-vscode-theme-kind', 'vscode-light');
	await new Promise((r) => setImmediate(r));
	assert.equal(body.getAttribute('data-logo-theme'), 'light', 'desktop/VS Code light');
	body.setAttribute('data-vscode-theme-kind', 'vscode-high-contrast-light');
	await new Promise((r) => setImmediate(r));
	assert.equal(body.getAttribute('data-logo-theme'), 'light');
	body.setAttribute('data-vscode-theme-kind', 'vscode-high-contrast');
	await new Promise((r) => setImmediate(r));
	assert.equal(body.getAttribute('data-logo-theme'), 'dark');
});
