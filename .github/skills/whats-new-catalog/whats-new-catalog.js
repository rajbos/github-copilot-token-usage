#!/usr/bin/env node
/*
 * whats-new-catalog.js
 * ------------------------------------------------------------------------
 * Keep `vscode-extension/src/whatsNew/catalog.ts` — the hand-written release
 * catalog behind the What's New view and the one-a-day new-feature
 * notifications — honest about what the extension actually ships.
 *
 * The catalog is prose, so most of it is a human judgment call. This script
 * does only the parts that are mechanically decidable, and prints the raw
 * material for the parts that are not:
 *
 *   1. VERSION COVERAGE — the version in package.json has a catalog entry.
 *      Without one, everything that shipped in it is invisible: no view
 *      section, and nothing to announce.
 *   2. DATE HYGIENE — at most one entry may be undated (`date: null`), and it
 *      must be the version currently in development. An *older* undated entry
 *      is a release that shipped and never got its date, which makes the view
 *      say "Unreleased" about something users have been running for months.
 *   3. ORPHAN SURFACES — every `surface` in the catalog resolves to a view the
 *      extension builds and, where given, a tab that view renders. An orphan is
 *      a "Take me there" button that silently does nothing.
 *   4. TAB-TRACKING GAPS — a catalog entry that names a `tab` on a view which
 *      never posts `viewTabOpened` can never be suppressed by the user opening
 *      it, so the announcer would keep offering something they already found.
 *      This one is invisible in review and is the reason this script exists.
 *
 * Then, informationally: the full inventory of views and tabs with a mark for
 * the ones the catalog mentions, and the CHANGELOG's Unreleased feature
 * bullets — the two things you read side by side when writing a new entry.
 *
 * Ordering, id uniqueness and prose length are covered by
 * `vscode-extension/test/unit/whatsNewCatalog.test.ts`, not duplicated here.
 *
 * Usage:
 *   node .github/skills/whats-new-catalog/whats-new-catalog.js [--json]
 *
 * Dependency-free apart from the repo's own TypeScript (used to evaluate the
 * catalog exactly rather than regex-parsing prose). Node >= 16.
 *
 * Exit codes:
 *   0  catalog is consistent with the code
 *   1  mechanical drift the agent can fix (orphan surface, stale null date,
 *      untracked tab)
 *   2  environment / configuration error (a source file moved, deps missing)
 *   3  no catalog entry for the current version — needs written prose, so a
 *      human or the agent must author it. Takes precedence over 1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// This file lives at <repo>/.github/skills/whats-new-catalog/whats-new-catalog.js
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXT = path.join(REPO_ROOT, 'vscode-extension');

const PATHS = {
  catalog: path.join(EXT, 'src', 'whatsNew', 'catalog.ts'),
  packageJson: path.join(EXT, 'package.json'),
  changelog: path.join(EXT, 'CHANGELOG.md'),
  esbuild: path.join(EXT, 'esbuild.js'),
  usageTabs: path.join(EXT, 'src', 'webview', 'usage', 'switchableTabs.ts'),
  diagnosticsMain: path.join(EXT, 'src', 'webview', 'diagnostics', 'main.ts'),
  efficiencyMain: path.join(EXT, 'src', 'webview', 'efficiency', 'main.ts'),
  webviewDir: path.join(EXT, 'src', 'webview'),
  // The catalog holds nls keys, not prose, since it was localized —
  // resolve them for display so this report stays readable.
  englishBundle: path.join(EXT, 'package.nls.json'),
};

/**
 * English text for an nls key.
 *
 * The catalog stores `titleKey`/`descriptionKey`/`headlineKey` rather than
 * prose — it is a pure module and cannot resolve strings itself, so
 * `extension.ts` does it at the render boundary. This report reads the English
 * bundle directly for the same reason, and degrades to showing the key rather
 * than failing if the bundle cannot be read.
 */
let _englishBundle;
function englishText(key) {
  if (!key) { return '(no key)'; }
  if (_englishBundle === undefined) {
    try { _englishBundle = JSON.parse(fs.readFileSync(PATHS.englishBundle, 'utf8')); }
    catch { _englishBundle = null; }
  }
  return (_englishBundle && _englishBundle[key]) || key;
}

// ── Tiny ANSI helpers ────────────────────────────────────────────────────────
const asJson = process.argv.includes('--json');
const useColour = process.stdout.isTTY && !asJson;
const c = (code, s) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

class ConfigError extends Error {}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read ${path.relative(REPO_ROOT, file)}: ${e.message}`);
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/**
 * Evaluates catalog.ts for real rather than regex-scraping it: the file is a
 * self-contained module of literals with only type imports, so transpiling it
 * and running it in a sandbox gives the exact data the extension sees. A regex
 * would have to cope with multi-line prose that reasonably contains braces,
 * quotes and colons.
 */
function loadCatalog() {
  let ts;
  for (const base of [EXT, REPO_ROOT, process.cwd()]) {
    try {
      ts = require(path.join(base, 'node_modules', 'typescript'));
      break;
    } catch { /* keep looking */ }
  }
  if (!ts) {
    throw new ConfigError(
      'TypeScript not found. Run `pnpm install` in vscode-extension/ first — this script ' +
      'evaluates catalog.ts rather than pattern-matching its prose.',
    );
  }
  const source = read(PATHS.catalog);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const sandbox = { exports: {}, module: { exports: {} }, require: () => ({}) };
  sandbox.module.exports = sandbox.exports;
  try {
    vm.runInNewContext(js, sandbox, { filename: 'catalog.ts', timeout: 5000 });
  } catch (e) {
    throw new ConfigError(`catalog.ts did not evaluate: ${e.message}`);
  }
  const releases = sandbox.exports.WHATS_NEW_RELEASES;
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new ConfigError('catalog.ts exported no WHATS_NEW_RELEASES — has the export moved?');
  }
  return {
    releases,
    maxPerRelease: sandbox.exports.WHATS_NEW_MAX_ANNOUNCEMENTS_PER_RELEASE ?? 3,
    maxReleases: sandbox.exports.WHATS_NEW_MAX_RELEASES ?? 5,
  };
}

function currentVersion() {
  try {
    return JSON.parse(read(PATHS.packageJson)).version;
  } catch (e) {
    throw new ConfigError(`Cannot read the version from package.json: ${e.message}`);
  }
}

// ── Surface inventory (what the extension actually ships) ────────────────────

/** Every webview bundle esbuild builds — the canonical set of view ids. */
function parseViews() {
  const src = read(PATHS.esbuild);
  const re = /(['"]?)([\w-]+)\1\s*:\s*['"]src\/webview\/[^'"]+['"]/g;
  const views = new Set();
  let m;
  while ((m = re.exec(src)) !== null) { views.add(m[2]); }
  if (views.size === 0) {
    throw new ConfigError('No webview entryPoints found in esbuild.js — has the block moved?');
  }
  return views;
}

/** Usage Analysis tabs, from the allowlist the host switches through. */
function parseUsageTabs() {
  const src = read(PATHS.usageTabs);
  const block = /SWITCHABLE_TABS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!block) {
    throw new ConfigError('SWITCHABLE_TABS not found in switchableTabs.ts — has it moved?');
  }
  return new Set([...block[1].matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]));
}

/** Diagnostics tabs, from the `data-tab="…"` buttons its shell renders. */
function parseDiagnosticsTabs() {
  const src = read(PATHS.diagnosticsMain);
  const tabs = new Set([...src.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]));
  // The selector-building call sites use a template literal, not a literal name.
  tabs.delete('${tabId}');
  return tabs;
}

/** Efficiency tabs, from its TABS array. */
function parseEfficiencyTabs() {
  const src = read(PATHS.efficiencyMain);
  const block = /const TABS[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
  if (!block) { return new Set(); }
  return new Set([...block[1].matchAll(/id:\s*['"]([\w-]+)['"]/g)].map((m) => m[1]));
}

/**
 * Views whose webview posts `viewTabOpened`. A catalog entry naming a tab on a
 * view outside this set can never be suppressed by the user opening it.
 */
function parseTabReportingViews() {
  const views = new Set();
  let dirs;
  try {
    dirs = fs.readdirSync(PATHS.webviewDir, { withFileTypes: true });
  } catch (e) {
    throw new ConfigError(`Cannot list src/webview: ${e.message}`);
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) { continue; }
    const main = path.join(PATHS.webviewDir, entry.name, 'main.ts');
    if (!fs.existsSync(main)) { continue; }
    const src = fs.readFileSync(main, 'utf8');
    const m = /viewTabOpened["'],?\s*view:\s*["']([\w-]+)["']/.exec(src)
      || (/viewTabOpened/.test(src) ? [null, entry.name] : null);
    if (m) { views.add(m[1]); }
  }
  return views;
}

/** view id -> Set of tab ids that view renders. Views absent here have no tabs. */
function buildTabIndex() {
  return new Map([
    ['usage', parseUsageTabs()],
    ['diagnostics', parseDiagnosticsTabs()],
    ['efficiency', parseEfficiencyTabs()],
  ]);
}

// ── CHANGELOG ────────────────────────────────────────────────────────────────

/** The bullets under `## [Unreleased]` → `### Features`, as raw one-liners. */
function parseUnreleasedFeatures() {
  const src = read(PATHS.changelog);
  const unreleased = /^##\s*\[Unreleased\][^\n]*\n([\s\S]*?)(?=^##\s*\[)/m.exec(src);
  if (!unreleased) { return []; }
  const features = /^###\s*Features\s*\n([\s\S]*?)(?=^###\s|\Z)/m.exec(unreleased[1]);
  if (!features) { return []; }
  return features[1]
    .split(/\n(?=- )/)
    .map((line) => line.replace(/^-\s*/, '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

// ── Checks ───────────────────────────────────────────────────────────────────

function analyse() {
  const { releases, maxPerRelease, maxReleases } = loadCatalog();
  const version = currentVersion();
  const views = parseViews();
  const tabIndex = buildTabIndex();
  const tabReporting = parseTabReportingViews();

  const problems = [];   // mechanical drift → exit 1
  const blocking = [];   // needs written prose → exit 3

  // 1. Version coverage.
  const entry = releases.find((r) => r.version === version);
  if (!entry) {
    blocking.push(
      `No catalog entry for the current version ${version}. Everything that shipped in ` +
      'it is invisible in the What\'s New view and can never be announced.',
    );
  }

  // 2. Date hygiene: only the newest entry may be undated.
  releases.forEach((release, i) => {
    if (release.date !== null) { return; }
    if (i !== 0) {
      problems.push(
        `${release.version} is undated but is not the newest entry — the view shows ` +
        '"Unreleased" for a version that has already shipped.',
      );
    } else if (release.version !== version) {
      problems.push(
        `${release.version} is undated but package.json is on ${version} — either it ` +
        'shipped and needs its release date, or the version bump was missed.',
      );
    }
  });

  // 3 + 4. Surfaces resolve, and tabbed surfaces are actually tracked.
  const mentioned = new Set();
  for (const release of releases) {
    for (const feature of release.features) {
      const { view, tab } = feature.surface;
      mentioned.add(tab ? `${view}#${tab}` : view);
      if (!views.has(view)) {
        problems.push(
          `${feature.id} points at view "${view}", which esbuild does not build — ` +
          'its "Take me there" button goes nowhere.',
        );
        continue;
      }
      if (!tab) { continue; }
      const tabs = tabIndex.get(view);
      if (tabs && !tabs.has(tab)) {
        problems.push(
          `${feature.id} points at tab "${view}#${tab}", which that view does not render — ` +
          'its "Take me there" button goes nowhere.',
        );
      }
      if (!tabReporting.has(view)) {
        problems.push(
          `${feature.id} names a tab on "${view}", but that view never posts ` +
          '`viewTabOpened`, so opening it can never suppress the announcement. ' +
          'Either wire the view up or drop the tab from the surface.',
        );
      }
    }
  }

  return {
    version, entry, releases, problems, blocking,
    maxPerRelease, maxReleases,
    views, tabIndex, tabReporting, mentioned,
    unreleasedFeatures: parseUnreleasedFeatures(),
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function report(r) {
  console.log(bold("\n📣 What's New catalog\n"));
  console.log(`   package.json version : ${bold(r.version)}`);
  console.log(`   catalog entries      : ${r.releases.length} (view shows the newest ${r.maxReleases})`);
  console.log(`   announcement cap     : ${r.maxPerRelease} per release\n`);

  if (r.entry) {
    const dated = r.entry.date ? r.entry.date : dim('unreleased');
    console.log(`   ${green('✓')} ${r.version} — ${dated}, ${r.entry.features.length} feature(s)`);
    r.entry.features.forEach((f, i) => {
      const capped = i >= r.maxPerRelease ? dim('  (beyond the cap — listed in the view, never announced)') : '';
      console.log(`       ${dim(`${f.kind}`.padEnd(8))} ${englishText(f.titleKey)}${capped}`);
    });
    console.log('');
  }

  for (const msg of r.blocking) { console.log(`   ${red('✗')} ${msg}`); }
  for (const msg of r.problems) { console.log(`   ${yellow('!')} ${msg}`); }
  if (r.blocking.length || r.problems.length) { console.log(''); }

  // Inventory: what exists, and whether the catalog has ever mentioned it.
  console.log(bold('   Surfaces the extension ships'));
  console.log(dim('   (✓ = named by some catalog entry; a blank is not a problem, just uncatalogued)\n'));
  for (const view of [...r.views].sort()) {
    const tabs = r.tabIndex.get(view);
    const mark = r.mentioned.has(view) ? green('✓') : ' ';
    const tracked = tabs && tabs.size > 0 && !r.tabReporting.has(view)
      ? dim('  (tabs not tracked)') : '';
    console.log(`   ${mark} ${view}${tracked}`);
    for (const tab of tabs ? [...tabs].sort() : []) {
      const tabMark = r.mentioned.has(`${view}#${tab}`) ? green('✓') : ' ';
      console.log(`     ${tabMark}   ${dim(tab)}`);
    }
  }

  if (r.unreleasedFeatures.length) {
    console.log(bold('\n   CHANGELOG → Unreleased → Features'));
    console.log(dim('   (raw material for the entry; only user-pointable things belong in the catalog)\n'));
    for (const line of r.unreleasedFeatures) {
      console.log(`   • ${line.length > 150 ? `${line.slice(0, 150)}…` : line}`);
    }
  }

  console.log('');
  if (r.blocking.length) {
    console.log(red(`✗ ${r.version} has no catalog entry — write one (see SKILL.md).\n`));
  } else if (r.problems.length) {
    console.log(yellow(`! ${r.problems.length} issue(s) to fix in catalog.ts.\n`));
  } else {
    console.log(green('✓ Catalog is consistent with the code.\n'));
  }
}

function main() {
  let r;
  try {
    r = analyse();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(asJson ? JSON.stringify({ error: e.message }) : red(`✗ ${e.message}`));
      process.exit(2);
    }
    throw e;
  }

  if (asJson) {
    console.log(JSON.stringify({
      version: r.version,
      hasEntryForVersion: !!r.entry,
      blocking: r.blocking,
      problems: r.problems,
      releases: r.releases.map((x) => ({
        version: x.version, date: x.date, featureCount: x.features.length,
      })),
      surfaces: [...r.views].sort().map((view) => ({
        view,
        catalogued: r.mentioned.has(view),
        tabsTracked: r.tabReporting.has(view),
        tabs: [...(r.tabIndex.get(view) ?? [])].sort().map((tab) => ({
          tab, catalogued: r.mentioned.has(`${view}#${tab}`),
        })),
      })),
      unreleasedFeatures: r.unreleasedFeatures,
    }, null, 2));
  } else {
    report(r);
  }

  if (r.blocking.length) { process.exit(3); }
  if (r.problems.length) { process.exit(1); }
  process.exit(0);
}

main();
