#!/usr/bin/env node

/**
 * Webview Page Shell Validation
 *
 * The shared webview bundles assume a page shell that VS Code provides for
 * free: every `--vscode-*` colour token defined, and the codicon icon font
 * loaded. Hosts that render the bundles outside VS Code have to supply both
 * themselves, and when they miss one nothing fails — a colour silently resolves
 * to nothing, or a nav button renders as an empty square.
 *
 * The desktop app and the headless visual-view-diff harness share one list of
 * theme tokens (.github/skills/visual-view-diff/lib/theme-{dark,light}.css).
 * This script checks that:
 *
 *   1. every `--vscode-*` token referenced under vscode-extension/src/webview/
 *      or src/webview/ is defined in both theme files, and every referenced
 *      colour token also in the harness's high-contrast overlays
 *      (theme-hc.css, theme-hc-light.css). The desktop app does not load the
 *      overlays, but the visual diff renders the views with them: a colour
 *      missing there silently falls back to the Modern value in high contrast;
 *   2. the two theme files define the same set of tokens;
 *   3. desktop/src/main.ts takes its tokens from those files rather than
 *      defining its own copy, which is how the desktop app drifted before;
 *   4. the desktop app ships the codicon stylesheet and font, and links the
 *      stylesheet from its panel pages, when the views use codicons.
 *
 * Usage:
 *   node scripts/validate-webview-shell.js [--json]
 *
 * Exits 1 on any finding.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const THEME_DIR = path.join(REPO_ROOT, '.github', 'skills', 'visual-view-diff', 'lib');
const THEME_FILES = ['theme-dark.css', 'theme-light.css'];
/** Layered after the base themes by the harness; they list colours only, so fonts are inherited on purpose. */
const HC_OVERLAY_FILES = ['theme-hc.css', 'theme-hc-light.css'];
const NOT_COLOURS = new Set(['--vscode-font-family', '--vscode-font-size', '--vscode-font-weight', '--vscode-editor-font-family']);
const WEBVIEW_SOURCE_DIRS = [
  path.join(REPO_ROOT, 'vscode-extension', 'src', 'webview'),
  path.join(REPO_ROOT, 'src', 'webview'),
];
const DESKTOP_MAIN = path.join(REPO_ROOT, 'desktop', 'src', 'main.ts');
const DESKTOP_ESBUILD = path.join(REPO_ROOT, 'desktop', 'esbuild.js');

const TOKEN = /--vscode-[A-Za-z0-9-]+/g;
const TOKEN_DEFINITION = /(--vscode-[A-Za-z0-9-]+)\s*:/g;

function collectSourceFiles(dir, results = []) {
  if (!fs.existsSync(dir)) {
    return results;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        collectSourceFiles(full, results);
      }
    } else if (/\.(ts|css)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

/** token -> first `file:line` that references it */
function collectReferencedTokens() {
  const referenced = new Map();
  for (const dir of WEBVIEW_SOURCE_DIRS) {
    for (const file of collectSourceFiles(dir)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const match of line.matchAll(TOKEN)) {
          if (!referenced.has(match[0])) {
            referenced.set(match[0], `${path.relative(REPO_ROOT, file)}:${i + 1}`);
          }
        }
      });
    }
  }
  return referenced;
}

function definedTokens(cssText) {
  return new Set([...cssText.matchAll(TOKEN_DEFINITION)].map((m) => m[1]));
}

function analyse({ themeDir = THEME_DIR } = {}) {
  const findings = [];
  const referenced = collectReferencedTokens();
  const themes = THEME_FILES.map((name) => ({
    name,
    tokens: definedTokens(fs.readFileSync(path.join(themeDir, name), 'utf8')),
  }));
  const overlays = HC_OVERLAY_FILES.map((name) => ({
    name,
    tokens: definedTokens(fs.readFileSync(path.join(themeDir, name), 'utf8')),
  }));

  // 1. Every referenced token is defined in every theme.
  for (const [token, where] of [...referenced].sort(([a], [b]) => a.localeCompare(b))) {
    for (const theme of themes) {
      if (!theme.tokens.has(token)) {
        findings.push(`${token} (used at ${where}) is not defined in ${theme.name} — the desktop app and the visual-diff harness render it as unset`);
      }
    }
    for (const overlay of overlays) {
      if (!NOT_COLOURS.has(token) && !overlay.tokens.has(token)) {
        findings.push(`${token} (used at ${where}) is not defined in ${overlay.name} — high-contrast screenshots fall back to the Modern-theme value`);
      }
    }
  }

  // 2. Both themes define the same tokens.
  const [dark, light] = themes;
  for (const [a, b] of [[dark, light], [light, dark]]) {
    for (const token of a.tokens) {
      if (!b.tokens.has(token)) {
        findings.push(`${token} is defined in ${a.name} but not in ${b.name}`);
      }
    }
  }

  // 3. The desktop takes its tokens from the shared theme files.
  const main = fs.readFileSync(DESKTOP_MAIN, 'utf8');
  for (const name of THEME_FILES) {
    if (!main.includes(`visual-view-diff/lib/${name}`)) {
      findings.push(`desktop/src/main.ts does not import ${name}; its panels would miss theme tokens the views use`);
    }
  }
  const ownDefinitions = definedTokens(main);
  if (ownDefinitions.size > 0) {
    findings.push(
      `desktop/src/main.ts defines its own --vscode-* tokens (${[...ownDefinitions].slice(0, 3).join(', ')}…); ` +
        'add them to the shared theme files instead so the lists cannot drift',
    );
  }

  // 4. Codicons: shipped and linked when the views use them.
  const usesCodicons = WEBVIEW_SOURCE_DIRS.some((dir) =>
    collectSourceFiles(dir).some((file) => /\bcodicon-[a-z]/.test(fs.readFileSync(file, 'utf8'))),
  );
  if (usesCodicons) {
    const esbuild = fs.readFileSync(DESKTOP_ESBUILD, 'utf8');
    for (const asset of ['codicon.css', 'codicon.ttf']) {
      if (!esbuild.includes(`'${asset}'`)) {
        findings.push(`desktop/esbuild.js does not copy ${asset}; the views use codicon glyphs`);
      }
    }
    if (!/<link[^>]+href="[^"]*codicons\/codicon\.css"/.test(main)) {
      findings.push('desktop/src/main.ts does not link codicons/codicon.css from its panel pages; the views use codicon glyphs');
    }
  }

  return { referenced: referenced.size, findings };
}

function main() {
  const result = analyse();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: result.findings.length === 0, ...result }, null, 2));
    process.exit(result.findings.length === 0 ? 0 : 1);
  }

  console.log('🎨 Webview page shell (theme tokens, codicons)\n');
  console.log(`   --vscode-* tokens referenced by the webviews: ${result.referenced}\n`);

  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      console.error(`❌ ${finding}`);
      if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::error::${finding}`);
      }
    }
    console.error('\n❌ Webview page shell validation failed!\n');
    process.exit(1);
  }

  console.log('✅ Every theme token the webviews use is defined, and the desktop app loads the shared shell.\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { analyse };
