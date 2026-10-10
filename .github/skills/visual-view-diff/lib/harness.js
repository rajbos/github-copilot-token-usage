'use strict';

/**
 * Headless render harness for the extension's webview panels.
 *
 * VS Code builds each panel's HTML in `vscode-extension/src/extension.ts`
 * (`getDetailsHtml`, `getChartHtml`, …). Every one of those shells is the same
 * four ingredients:
 *
 *   1. `<div id="root"></div>`
 *   2. `window.__INITIAL_<VIEW>__ = <the view's data>`
 *   3. the shared JSON config globals (token estimators, pricing, tool names)
 *   4. `<script src="dist/webview/<view>.js">` — the real bundle, which injects
 *      its own CSS and renders into `#root`
 *
 * So the harness can reproduce a panel faithfully without VS Code: rebuild that
 * shell around a committed fixture, add the `--vscode-*` theme tokens VS Code
 * would normally inject, and let the *real* bundle do the rendering. Nothing is
 * re-implemented here, which is what keeps the screenshots honest — if a view's
 * rendering code changes, the screenshot changes with it.
 *
 * This deliberately does NOT launch VS Code or the Extension Development Host:
 * the repo forbids agents from opening a real editor window
 * (see .github/copilot-instructions.md, "Never Launch a Real Editor/IDE Instance").
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'vscode-extension');
const WEBVIEW_DIST = path.join(EXTENSION_DIR, 'dist', 'webview');

/** Shared JSON data files that extension.ts exposes to every webview. */
const JSON_CONFIG_GLOBALS = {
	__TOKEN_ESTIMATORS__: 'tokenEstimators.json',
	__MODEL_PRICING__: 'modelPricing.json',
	__TOOL_NAMES__: 'toolNames.json',
	__AUTOMATIC_TOOLS__: 'automaticTools.json',
};

/**
 * Loads a fixture file, resolving `$fromRepoJson` references.
 *
 * Some views are driven by data files that already live in the repo (e.g. the
 * fluency level definitions in `src/fluencyLevelData.json`). Copying those into
 * a fixture would mean maintaining two copies and would hide real visual
 * changes when the source file is edited, so a fixture can point at the source
 * instead:
 *
 *   { "categories": { "$fromRepoJson": "src/fluencyLevelData.json" } }
 *
 * @param {string} fixturePath absolute path to the fixture JSON
 * @param {string} repoRoot
 */
function loadFixture(fixturePath, repoRoot) {
	const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
	const resolve = (node) => {
		if (Array.isArray(node)) {
			return node.map(resolve);
		}
		if (node && typeof node === 'object') {
			if (typeof node.$fromRepoJson === 'string') {
				return JSON.parse(fs.readFileSync(path.join(repoRoot, node.$fromRepoJson), 'utf8'));
			}
			return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v)]));
		}
		return node;
	};
	return resolve(raw);
}

/** Escapes `<` so an embedded JSON payload can never close the script tag. */
function toScriptJson(value) {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

function readJsonConfigGlobals(repoRoot) {
	const parts = [];
	for (const [globalName, fileName] of Object.entries(JSON_CONFIG_GLOBALS)) {
		const filePath = path.join(repoRoot, 'src', fileName);
		const raw = fs.readFileSync(filePath, 'utf8');
		parts.push(`window.${globalName}=${raw.replace(/</g, '\\u003c')};`);
	}
	return parts.join('');
}

/**
 * Builds the standalone HTML page for one view.
 *
 * @param {object} options
 * @param {string} options.globalName   e.g. `__INITIAL_DETAILS__`
 * @param {unknown} options.fixture     the view's initial data payload
 * @param {'dark'|'light'} options.theme
 * @param {string} options.bundlePath   absolute path to `dist/webview/<view>.js`
 * @param {string} options.repoRoot
 * @param {object} [options.extraGlobals]  additional window globals supplied by the panel shell
 * @returns {string} the full HTML document
 */
function buildPageHtml({ globalName, fixture, theme, bundlePath, repoRoot, extraGlobals = {} }) {
	const themeCss = fs.readFileSync(path.join(__dirname, `theme-${theme}.css`), 'utf8');
	const themeKind = theme === 'light' ? 'vscode-light' : 'vscode-dark';
	const codiconCss = path.join(path.dirname(bundlePath), 'codicons', 'codicon.css');
	const codiconTag = fs.existsSync(codiconCss)
		? `<link rel="stylesheet" href="${pathToFileUrl(codiconCss)}" />`
		: '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${themeCss}</style>
${codiconTag}
<style>
	/* VS Code applies these to every webview body; the bundles' own CSS assumes them. */
	body {
		margin: 0;
		padding: 0 20px;
		background-color: var(--vscode-editor-background);
		color: var(--vscode-editor-foreground);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		font-weight: var(--vscode-font-weight);
	}
	/* Screenshots must be deterministic: a mid-flight transition or a blinking
	   caret would make two identical builds diff against each other. */
	*, *::before, *::after {
		animation-duration: 0s !important;
		animation-delay: 0s !important;
		transition-duration: 0s !important;
		transition-delay: 0s !important;
		caret-color: transparent !important;
	}
</style>
</head>
<body data-vscode-theme-kind="${themeKind}" class="${themeKind}">
<div id="root"></div>
<script>
	// Minimal stand-in for the API VS Code injects into a webview. State is kept
	// in memory and messages are recorded so a view that posts on startup does
	// not throw; nothing is sent anywhere.
	window.__HARNESS_POSTED_MESSAGES__ = [];
	let __harnessState = {};
	window.acquireVsCodeApi = function () {
		return {
			postMessage: (message) => { window.__HARNESS_POSTED_MESSAGES__.push(message); },
			getState: () => __harnessState,
			setState: (next) => { __harnessState = next; return next; },
		};
	};
	// Surface render failures to the harness instead of failing silently with a
	// blank page that still screenshots "successfully".
	window.__HARNESS_ERRORS__ = [];
	window.addEventListener('error', (e) => {
		window.__HARNESS_ERRORS__.push(String((e && e.error && e.error.stack) || (e && e.message) || e));
	});
	window.addEventListener('unhandledrejection', (e) => {
		window.__HARNESS_ERRORS__.push('unhandledrejection: ' + String((e && e.reason) || e));
	});
</script>
<script>window.${globalName} = ${toScriptJson(fixture)};</script>
<script>${Object.entries(extraGlobals).map(([name, value]) => `window[${toScriptJson(name)}] = ${toScriptJson(value)};`).join('')}</script>
<script>${readJsonConfigGlobals(repoRoot)}</script>
<script>window.__EXTENSION_POINT_BUTTONS__ = [];</script>
<script src="${pathToFileUrl(bundlePath)}"></script>
</body>
</html>`;
}

function pathToFileUrl(filePath) {
	return require('url').pathToFileURL(filePath).href;
}

module.exports = {
	REPO_ROOT,
	EXTENSION_DIR,
	WEBVIEW_DIST,
	buildPageHtml,
	loadFixture,
	pathToFileUrl,
	toScriptJson,
};
