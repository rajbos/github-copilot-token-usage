#!/usr/bin/env node

/**
 * Desktop app headless render check
 *
 * Builds every desktop panel's page with the app's own panel builder
 * (desktop/src/panelPage.ts, the code Electron's main process calls) over a small
 * set of session files, loads each page in headless Chromium and fails on:
 *
 *   - an uncaught script error, a console error or a failed/4xx request;
 *   - an empty `#root` (the bundle threw while rendering, e.g. on a payload field
 *     the desktop does not provide);
 *   - a codicon font that does not load.
 *
 * The app serves a panel's page from `app://panel` and its scripts from
 * `app://static`, two origins; the codicon font has to come from the panel's own
 * origin or the browser blocks it. This script reproduces that split with two local
 * HTTP servers on different ports (neither sends CORS headers, like the `app`
 * scheme), rewriting the page's `app://` URLs, so a page that loads the font from
 * the wrong origin fails here as it does in the app. Two scenarios are rendered,
 * each in the dark and the light theme: a populated history, and no sessions at all
 * (the empty states).
 *
 * The session files are written under a temporary HOME, never the user's own.
 * No editor or Electron window is opened.
 *
 * Needs the built desktop webviews (`pnpm run build` in desktop/) and Playwright
 * (see .github/skills/visual-view-diff/lib/browser.js for how it is found).
 *
 * Usage:
 *   node scripts/validate-desktop-render.js [--panel <id>] [--keep]
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DESKTOP_DIR = path.join(REPO_ROOT, 'desktop');
const WEBVIEW_DIST = path.join(DESKTOP_DIR, 'dist', 'webview');
const { loadChromium } = require('../.github/skills/visual-view-diff/lib/browser.js');
const { readDesktopViews } = require('./validate-desktop-contract.js');

const SCENARIOS = ['populated', 'empty'];
const THEMES = ['dark', 'light'];
const RENDER_TIMEOUT_MS = 15000;

const CONTENT_TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };

/**
 * Serves `routes` (url path -> { file } to send from disk, or { html } to send as is).
 * No CORS headers: the `app` scheme has CORS disabled too.
 */
function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes.get(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    if (route.html !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(route.html);
      return;
    }
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(route.file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(route.file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Bundles the page-building entry for plain Node. Returns the bundle path. */
function bundleBuilder(tmp) {
  const esbuild = require(path.join(DESKTOP_DIR, 'node_modules', 'esbuild'));
  const outfile = path.join(tmp, 'renderPanels.js');
  esbuild.buildSync({
    entryPoints: [path.join(DESKTOP_DIR, 'src', 'test', 'renderPanels.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    // Same resolution and loaders as desktop/esbuild.js.
    nodePaths: ['desktop', 'cli', 'vscode-extension'].map((d) => path.join(REPO_ROOT, d, 'node_modules')),
    loader: { '.json': 'json', '.css': 'text' },
    banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': '__importMetaUrl' },
    logLevel: 'error',
  });
  // The SQLite reader (sql.js) loads its wasm from next to the bundle, as it does in dist/.
  const wasm = path.join(DESKTOP_DIR, 'dist', 'sql-wasm.wasm');
  if (fs.existsSync(wasm)) { fs.copyFileSync(wasm, path.join(tmp, 'sql-wasm.wasm')); }
  return outfile;
}

/** Writes every scenario's pages under `tmp/<scenario>`; HOME is private to each run. */
function buildPages(tmp, bundle) {
  for (const scenario of SCENARIOS) {
    const home = path.join(tmp, `home-${scenario}`);
    fs.mkdirSync(home, { recursive: true });
    const run = spawnSync(process.execPath, [bundle, path.join(tmp, scenario), scenario], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        HERMES_HOME: path.join(home, '.hermes'),
      },
    });
    if (run.status !== 0) {
      throw new Error(`building the ${scenario} pages failed:\n${run.stderr || run.stdout}`);
    }
  }
}

async function renderOne(browser, name, url) {
  const problems = [];
  const context = await browser.newContext();
  // What desktop/src/preload.ts exposes to the pages (its postMessage goes to the main process).
  await context.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: (s) => s });
  });
  const page = await context.newPage();
  const external = new Set();
  page.on('pageerror', (e) => problems.push(`script error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') { problems.push(`console error: ${m.text()}`); } });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() >= 400) { problems.push(`HTTP ${r.status()}: ${r.url()}`); } });
  // Nothing outside the two local origins may be fetched.
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') { return route.continue(); }
    external.add(u.origin);
    return route.abort('blockedbyclient');
  });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, null, { timeout: RENDER_TIMEOUT_MS })
      .catch(() => problems.push('#root stayed empty: the view did not render'));
    // Let async render work and late errors surface.
    await page.waitForTimeout(500);
    const fontLoaded = await page.evaluate(async () => (await document.fonts.load('16px codicon')).length > 0);
    if (!fontLoaded) { problems.push('the codicon font did not load'); }
  } catch (e) {
    problems.push(`navigation failed: ${e.message}`);
  } finally {
    await context.close();
  }
  for (const origin of external) { problems.push(`requested an external origin: ${origin}`); }
  return { name, problems: [...new Set(problems)] };
}

async function main() {
  const only = process.argv.includes('--panel') ? process.argv[process.argv.indexOf('--panel') + 1] : null;
  const views = readDesktopViews().filter((v) => !only || v === only);
  if (views.length === 0 || !fs.existsSync(path.join(WEBVIEW_DIST, `${views[0]}.js`))) {
    console.error(`❌ ${WEBVIEW_DIST} has no built webviews (or --panel names no desktop view). Run "pnpm run build" in desktop/ first.`);
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-render-'));
  const servers = [];
  try {
    buildPages(tmp, bundleBuilder(tmp));

    const staticRoutes = new Map();
    const panelRoutes = new Map();
    for (const f of fs.readdirSync(WEBVIEW_DIST).filter((n) => n.endsWith('.js'))) {
      staticRoutes.set(`/${f}`, { file: path.join(WEBVIEW_DIST, f) });
    }
    for (const f of ['codicon.css', 'codicon.ttf']) {
      // The app's static origin serves every file of dist/webview too, so a page that links the
      // font from there loads the stylesheet and then has the font blocked cross-origin.
      staticRoutes.set(`/codicons/${f}`, { file: path.join(WEBVIEW_DIST, 'codicons', f) });
      panelRoutes.set(`/assets/codicons/${f}`, { file: path.join(WEBVIEW_DIST, 'codicons', f) });
    }
    const staticServer = await serve(staticRoutes);
    const panelServer = await serve(panelRoutes);
    servers.push(staticServer, panelServer);
    const staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;
    const panelOrigin = `http://127.0.0.1:${panelServer.address().port}`;

    const jobs = [];
    for (const scenario of SCENARIOS) {
      for (const theme of THEMES) {
        for (const view of views) {
          const file = path.join(tmp, scenario, `${view}.${theme}.html`);
          if (!fs.existsSync(file)) { throw new Error(`the page builder did not write ${path.relative(tmp, file)}`); }
          const html = fs.readFileSync(file, 'utf8');
          if (!html.includes('app://static/')) {
            throw new Error(`${view}: the page no longer loads its script from app://static, so this check would not reproduce the app's origins`);
          }
          const route = `/${scenario}/${theme}/${view}`;
          panelRoutes.set(route, { html: html.replaceAll('app://panel', panelOrigin).replaceAll('app://static', staticOrigin) });
          jobs.push({ name: `${view} (${scenario}, ${theme})`, url: panelOrigin + route });
        }
      }
    }

    const browser = await loadChromium().launch();
    const failures = [];
    try {
      console.log('🖥️  Desktop app headless render\n');
      for (const job of jobs) {
        const result = await renderOne(browser, job.name, job.url);
        console.log(`   ${result.problems.length ? '❌' : '✅'} ${result.name}`);
        for (const p of result.problems) { console.log(`        ${p}`); }
        if (result.problems.length) { failures.push(result); }
      }
    } finally {
      await browser.close();
    }
    if (failures.length) {
      console.error(`\n❌ ${failures.length} of ${jobs.length} desktop renders failed.`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ All ${jobs.length} desktop renders have content and no script errors.`);
    }
  } finally {
    servers.forEach((s) => s.close());
    if (process.argv.includes('--keep')) {
      console.log(`kept ${tmp}`);
    } else {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((e) => { console.error(`❌ ${e.stack || e.message}`); process.exit(1); });
