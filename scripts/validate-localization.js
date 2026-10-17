#!/usr/bin/env node

/**
 * Localization Validation Script
 *
 * Ensures that whenever the VS Code extension's localization keys change, all
 * locale files (package.nls.<locale>.json) stay in sync with the base
 * package.nls.json, and that every key referenced from source/package.json
 * actually exists in the base file. Run as part of CI to catch missing
 * translations before merge.
 *
 * When running inside GitHub Actions (GITHUB_ACTIONS=true), findings are also
 * emitted as workflow error/warning annotations pinned to the offending file
 * and line, so they show up inline on the "Files changed" tab of the PR.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const vscodeExtDir = path.join(repoRoot, 'vscode-extension');
const srcDir = path.join(vscodeExtDir, 'src');
const basePackageJsonPath = path.join(vscodeExtDir, 'package.json');
const baseNlsPath = path.join(vscodeExtDir, 'package.nls.json');

// Resolve node_modules from the CWD (where npm runs this script from)
const cwdNodeModules = path.join(process.cwd(), 'node_modules');

let parseJsonc;
try {
  const jsoncParser = require(path.join(cwdNodeModules, 'jsonc-parser'));
  parseJsonc = (content) => {
    const errors = [];
    const result = jsoncParser.parse(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const error = errors[0];
      throw new Error(`${jsoncParser.printParseErrorCode(error.error)} at position ${error.offset}`);
    }
    return result;
  };
} catch (e) {
  const stripJsonComments = require(path.join(cwdNodeModules, 'strip-json-comments'));
  parseJsonc = (content) => JSON.parse(stripJsonComments(content));
}

/** Recursively collect files under `dir` matching `extensions`, skipping test/output folders. */
function collectFiles(dir, extensions) {
  const results = [];
  const skipDirs = new Set(['node_modules', 'out', 'dist', '.vscode-test', 'test']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) { continue; }
      results.push(...collectFiles(path.join(dir, entry.name), extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

/** 1-based line number of `index` within `content`. */
function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

/** 1-based line number of the first `"key":` occurrence in `content`, or undefined if not found. */
function lineOfKey(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}"\\s*:`).exec(content);
  return match ? lineAt(content, match.index) : undefined;
}

/**
 * Every localization key referenced from source, across every root that uses one.
 *
 * Recognizes four call shapes, because the repo has four of them (see
 * docs/adr/LOCALIZATION-ARCHITECTURE.md):
 *   - `l10n.t('key')` / `vscode.l10n.t('key')` — the extension host
 *   - `translate('key')` / `ctx.translate('key')` — pure modules handed a
 *     `Translate`, e.g. insightsEngine.ts. Matching only `l10n.t(` left this
 *     scanner blind to all 179 keys the insights catalog added.
 *   - `localize('key')` / `localizeFormat('key')` — webview bundles
 *
 * Keys built by concatenation (`plural()` appending `.one`/`.other`, or a
 * template literal with a computed suffix) are out of reach by construction —
 * the same boundary the hardcoded-string ratchet has. Those are covered by the
 * table-driven tests in vscode-extension/test/unit/l10n.test.ts instead.
 */
function findUsedKeysInSource() {
  const found = []; // { key, file, line }
  // Each alternative ends at `(` so a bare identifier like `translated` cannot match.
  const pattern = /(?:\bl10n\.t|(?:^|[^.\w])translate|\.translate|\blocalizeFormat|\blocalize)\(\s*['"]([^'"]+)['"]/g;
  for (const root of sourceRoots()) {
    for (const file of collectFiles(root, ['.ts'])) {
      if (file.endsWith('.test.ts') || file.includes(`${path.sep}node_modules${path.sep}`)) { continue; }
      const content = fs.readFileSync(file, 'utf8');
      let match;
      while ((match = pattern.exec(content)) !== null) {
        found.push({ key: match[1], file, line: lineAt(content, match.index) });
      }
    }
  }
  return found;
}

/**
 * The source trees that may reference a localization key.
 *
 * Was `vscode-extension/src` alone, which meant a key used only from the
 * shared `src/` folder read as unreferenced and a missing one went undetected.
 * Roots that do not exist are skipped so this keeps working in partial
 * checkouts.
 */
function sourceRoots() {
  return [
    srcDir,
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'desktop', 'src'),
  ].filter((dir) => fs.existsSync(dir));
}

/** Extract %key% placeholders referenced from package.json (contribution point strings). */
function findUsedKeysInPackageJson() {
  const found = []; // { key, file, line }
  const content = fs.readFileSync(basePackageJsonPath, 'utf8');
  const pattern = /%([a-zA-Z0-9_.]+)%/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    found.push({ key: match[1], file: basePackageJsonPath, line: lineAt(content, match.index) });
  }
  return found;
}

/** True if a string looks like it contains translatable prose (not just symbols/numbers). */
function looksTranslatable(value) {
  return typeof value === 'string' && /[A-Za-z]{2,}/.test(value);
}

/** Escape a value for use as GitHub Actions workflow command data. */
function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a value for use as a GitHub Actions workflow command property. */
function escapeProperty(value) {
  return escapeData(value).replace(/,/g, '%2C').replace(/:/g, '%3A');
}

const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';

/** Emit a GitHub Actions error/warning annotation pinned to `file`/`line` (no-op outside CI). */
function annotate(level, { file, line, message }) {
  if (!inGitHubActions) { return; }
  const props = [`file=${escapeProperty(path.relative(repoRoot, file).replace(/\\/g, '/'))}`];
  if (line) { props.push(`line=${line}`); }
  console.log(`::${level} ${props.join(',')}::${escapeData(message)}`);
}

function main() {
  console.log('🔍 Validating VS Code extension localization files...\n');

  const errors = []; // { message, file, line }
  const warnings = []; // { message, file, line }

  const baseContent = fs.readFileSync(baseNlsPath, 'utf8');
  const baseNls = parseJsonc(baseContent);
  const baseKeys = new Set(Object.keys(baseNls));

  // 1. Every key referenced from source/package.json must exist in the base file.
  const usedKeys = [...findUsedKeysInSource(), ...findUsedKeysInPackageJson()];
  for (const { key, file, line } of usedKeys) {
    if (!baseKeys.has(key)) {
      errors.push({ file, line, message: `Key "${key}" is referenced but missing from package.nls.json` });
    }
  }

  // 2. Every locale file must define a translation for every base key.
  const localeFiles = fs.readdirSync(vscodeExtDir)
    .filter((f) => /^package\.nls\.[a-z0-9-]+\.json$/i.test(f))
    .sort();

  if (localeFiles.length === 0) {
    warnings.push({ file: baseNlsPath, message: 'No package.nls.<locale>.json files found — nothing to compare against the base file.' });
  }

  for (const localeFile of localeFiles) {
    const locale = localeFile.replace(/^package\.nls\.|\.json$/g, '');
    const localePath = path.join(vscodeExtDir, localeFile);
    const localeContent = fs.readFileSync(localePath, 'utf8');
    const localeData = parseJsonc(localeContent);
    const localeKeys = new Set(Object.keys(localeData));

    const missing = [...baseKeys].filter((k) => !localeKeys.has(k));
    for (const key of missing) {
      // Annotate the base file at the key's definition, since that's the line that changed.
      errors.push({
        file: baseNlsPath,
        line: lineOfKey(baseContent, key),
        message: `Missing "${key}" translation in ${localeFile}`
      });
    }

    const extra = [...localeKeys].filter((k) => !baseKeys.has(k));
    for (const key of extra) {
      warnings.push({
        file: localePath,
        line: lineOfKey(localeContent, key),
        message: `Stale key "${key}" is not present in package.nls.json`
      });
    }

    for (const key of localeKeys) {
      if (!baseKeys.has(key)) { continue; }
      const localeValue = localeData[key];
      const baseValue = baseNls[key];
      const line = lineOfKey(localeContent, key);
      if (looksTranslatable(baseValue) && localeValue === baseValue) {
        warnings.push({ file: localePath, line, message: `Key "${key}" looks untranslated (identical to English)` });
      }
      if (typeof localeValue === 'string' && localeValue.trim().length === 0) {
        errors.push({ file: localePath, line, message: `Key "${key}" has an empty translation` });
      }
    }
  }

  // Print + annotate results
  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s):`);
    for (const w of warnings) {
      console.log(`   - [${path.relative(repoRoot, w.file)}${w.line ? `:${w.line}` : ''}] ${w.message}`);
      annotate('warning', w);
    }
    console.log('');
  }

  if (errors.length > 0) {
    console.error(`❌ ${errors.length} error(s):`);
    for (const e of errors) {
      console.error(`   - [${path.relative(repoRoot, e.file)}${e.line ? `:${e.line}` : ''}] ${e.message}`);
      annotate('error', e);
    }
    console.error('\n❌ Localization validation failed!\n');
    process.exit(1);
  }

  console.log('✅ All localization keys are in sync!\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { findUsedKeysInSource, findUsedKeysInPackageJson, lineOfKey };
