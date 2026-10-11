'use strict';

/**
 * Resolves Playwright's `chromium` without adding it to any package.json.
 *
 * The extension does not depend on Playwright, and it should not have to: this
 * harness is developer/CI tooling, not shipped code. So we look for an existing
 * install rather than pulling one into the extension's dependency tree —
 * agent environments and CI images generally already provide one.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Global npm root without spawning the `npm` shim: Node refuses to spawn .cmd
 * shims without a shell on Windows (CVE-2024-27980), and we deliberately keep
 * `shell` disabled, so run npm's CLI entrypoint with the current Node binary.
 * Falls back to npm's default Windows prefix when the CLI can't be located.
 */
function globalNpmRoot() {
	const nodeDir = path.dirname(process.execPath);
	const cliCandidates = [
		path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
		path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX layout
	];
	const cli = cliCandidates.find(p => fs.existsSync(p));
	if (cli) {
		try {
			return execFileSync(process.execPath, [cli, 'root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		} catch {
			// Fall through to the platform default below.
		}
	}
	if (process.platform === 'win32' && process.env.APPDATA) {
		return path.join(process.env.APPDATA, 'npm', 'node_modules');
	}
	return null;
}

const INSTALL_HINT = [
	'Playwright is required to render the webviews but was not found.',
	'',
	'Install it globally (it is intentionally not a dependency of the extension):',
	'  npm install -g playwright && npx playwright install chromium',
	'',
	'If a browser is already present elsewhere, point PLAYWRIGHT_BROWSERS_PATH at it.',
].join('\n');

/**
 * CI installs a pinned Playwright into its own package tree (see
 * .github/workflows/dependencies/playwright) rather than globally, so a plain
 * `require('playwright')` from this file never finds it via Node's normal
 * upward node_modules search. Resolve that location explicitly.
 */
function pinnedWorkflowInstallRoot() {
	return path.join(__dirname, '..', '..', '..', 'workflows', 'dependencies', 'playwright', 'node_modules');
}

/** Candidate module paths, cheapest first. */
function candidatePaths() {
	const paths = ['playwright', '@playwright/test', 'playwright-core'];
	const pinnedRoot = pinnedWorkflowInstallRoot();
	paths.push(`${pinnedRoot}/playwright`, `${pinnedRoot}/@playwright/test`, `${pinnedRoot}/playwright-core`);
	// Global installs are not on a local script's resolution path, so ask npm
	// where its global root is and look there too.
	const globalRoot = globalNpmRoot();
	if (globalRoot) {
		paths.push(`${globalRoot}/playwright`, `${globalRoot}/@playwright/test`, `${globalRoot}/playwright-core`);
	}
	return paths;
}

function loadChromium() {
	for (const candidate of candidatePaths()) {
		try {
			const mod = require(candidate);
			if (mod && mod.chromium) {
				return mod.chromium;
			}
		} catch {
			// Try the next candidate.
		}
	}
	throw new Error(INSTALL_HINT);
}

/**
 * Keeps the page off the network. The bundle under review runs in this page,
 * and nothing it renders needs more than the local `file://` page, its bundle
 * and codicons, so every http(s) request and WebSocket is refused. Routing on
 * the context also covers popups the page opens. A blocked request surfaces as
 * a console error, which marks the render `warn` instead of passing silently.
 */
async function blockNetwork(page) {
	await page.context().route('**/*', (route) => (
		/^(file|data|blob):/i.test(route.request().url()) ? route.continue() : route.abort('blockedbyclient')
	));
	// Fail closed: an older Playwright without WebSocket routing would leave
	// that channel open while the run reports the page as isolated.
	if (typeof page.context().routeWebSocket !== 'function') {
		throw new Error('This Playwright cannot block WebSockets (routeWebSocket needs Playwright 1.48+); upgrade it to render webviews.');
	}
	await page.context().routeWebSocket(/.*/, (ws) => ws.close());
}

module.exports = { blockNetwork, loadChromium, INSTALL_HINT };
