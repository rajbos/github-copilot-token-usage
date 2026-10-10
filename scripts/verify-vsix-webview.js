#!/usr/bin/env node
/*
 * verify-vsix-webview.js
 * ------------------------------------------------------------------------
 * Open a built Visual Studio extension (.vsix, a zip) and assert that every
 * webview file the host is expected to ship is present and non-empty.
 *
 * Why: the webview bundles are no longer committed; they are copied from the
 * VS Code extension's build output by the csproj (see
 * docs/adr/VS-WEBVIEW-BUNDLE-SOURCING.md). A green MSBuild can still produce a
 * VSIX with an empty webview\ folder, and nothing else inspects the package.
 *
 * The expected list is derived, not hardcoded:
 *   - the csproj `_WebviewBundle` items (what CopyWebviewBundles copies),
 *   - cross-checked against the csproj `VSIXSourceItem ...\webview\<file>` items
 *     (what AddWebviewBundlesToVsix packs) - the two lists must be identical,
 *   - and every `.js` bundle must be an entry point in vscode-extension/esbuild.js
 *     (the source of truth the sync-host-views skill also uses).
 * A drift between any of these fails the check before the VSIX is even opened.
 *
 * Dependency-free (Node built-ins only). Node >= 16.
 *
 * Usage:
 *   node scripts/verify-vsix-webview.js <path/to/file.vsix> [--json]
 *
 * Exit codes: 0 ok · 1 VSIX missing/empty/invalid webview content ·
 *             2 usage or configuration error (unreadable csproj/esbuild.js/zip)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CSPROJ = path.join(
  REPO_ROOT, 'visualstudio-extension', 'src', 'AIEngineeringFluency', 'AIEngineeringFluency.csproj',
);
const DEFAULT_ESBUILD = path.join(REPO_ROOT, 'vscode-extension', 'esbuild.js');
const VSIX_WEBVIEW_DIR = 'webview/';

class ConfigError extends Error {}

// ── Expected-list derivation ─────────────────────────────────────────────────

/** File names copied by CopyWebviewBundles (`_WebviewBundle Include="...<file>"`). */
function parseCsprojBundles(csprojText) {
  const names = new Set();
  const re = /<_WebviewBundle\s+Include="([^"]+)"/g;
  let m;
  while ((m = re.exec(csprojText)) !== null) {
    names.add(m[1].split(/[\\/]/).pop());
  }
  return names;
}

/** File names packed by AddWebviewBundlesToVsix (`VSIXSourceItem Include="...\webview\<file>"`). */
function parseCsprojVsixItems(csprojText) {
  const names = new Set();
  const re = /<VSIXSourceItem\s+Include="[^"]*[\\/]webview[\\/]([^"\\/]+)"/g;
  let m;
  while ((m = re.exec(csprojText)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/** Bundle names (keys) of the webview entryPoints block in esbuild.js. */
function parseEsbuildViews(esbuildText) {
  const re = /(['"]?)([\w-]+)\1\s*:\s*['"]src\/webview\/[^'"]+['"]/g;
  const views = new Set();
  let m;
  while ((m = re.exec(esbuildText)) !== null) {
    views.add(m[2]);
  }
  return views;
}

/**
 * Build the expected file list and any internal-consistency problems.
 * @returns {{expected: string[], problems: string[]}}
 */
function deriveExpected(csprojText, esbuildText) {
  const bundles = parseCsprojBundles(csprojText);
  const vsixItems = parseCsprojVsixItems(csprojText);
  const views = parseEsbuildViews(esbuildText);
  const problems = [];

  if (bundles.size === 0) {
    throw new ConfigError('No _WebviewBundle items found in the csproj - has CopyWebviewBundles moved?');
  }
  if (views.size === 0) {
    throw new ConfigError('No webview entryPoints found in esbuild.js - has the entryPoints block moved?');
  }

  for (const f of bundles) {
    if (!vsixItems.has(f)) {
      problems.push(`${f} is copied by CopyWebviewBundles but not packed by AddWebviewBundlesToVsix`);
    }
    if (f.endsWith('.js') && !views.has(f.slice(0, -3))) {
      problems.push(`${f} is not an esbuild entry point in vscode-extension/esbuild.js`);
    }
  }
  for (const f of vsixItems) {
    if (!bundles.has(f)) {
      problems.push(`${f} is packed by AddWebviewBundlesToVsix but not copied by CopyWebviewBundles`);
    }
  }
  return { expected: [...bundles].sort(), problems };
}

// ── Minimal zip reader (central directory + inflate) ─────────────────────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * Parse the central directory of a zip buffer.
 * @returns {Map<string, {method:number, compSize:number, size:number, localOffset:number}>}
 */
function readZipEntries(buf) {
  // EOCD is at least 22 bytes and sits within the last 22 + 65535 bytes.
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new ConfigError('Not a zip file: end-of-central-directory record not found');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) {
    throw new ConfigError('Zip64 archives are not supported by this checker');
  }

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) {
      throw new ConfigError('Corrupt zip: bad central directory entry');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    let name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // OPC packages percent-encode part names.
    try { name = decodeURIComponent(name); } catch { /* keep raw name */ }
    entries.set(name.replace(/\\/g, '/'), { method, compSize, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf, entry) {
  const o = entry.localOffset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOC_SIG) {
    throw new Error('corrupt local header');
  }
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method}`);
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * @returns {{ok: boolean, expected: string[], failures: string[], entries: string[]}}
 */
function verifyVsix(vsixBuf, expected) {
  const entries = readZipEntries(vsixBuf);
  const failures = [];
  for (const file of expected) {
    const entry = entries.get(VSIX_WEBVIEW_DIR + file);
    if (!entry) {
      failures.push(`${VSIX_WEBVIEW_DIR}${file}: MISSING from the VSIX`);
      continue;
    }
    let data;
    try {
      data = readEntryData(vsixBuf, entry);
    } catch (e) {
      failures.push(`${VSIX_WEBVIEW_DIR}${file}: unreadable (${e.message})`);
      continue;
    }
    if (data.length === 0) {
      failures.push(`${VSIX_WEBVIEW_DIR}${file}: present but EMPTY`);
    } else if (file.endsWith('.json')) {
      try { JSON.parse(data.toString('utf8').replace(/^﻿/, '')); }
      catch { failures.push(`${VSIX_WEBVIEW_DIR}${file}: not valid JSON`); }
    }
  }
  return { ok: failures.length === 0, expected, failures, entries: [...entries.keys()].sort() };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function readFileOrConfigError(file) {
  try { return fs.readFileSync(file); }
  catch (e) { throw new ConfigError(`Cannot read ${file}: ${e.message}`); }
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const vsixPath = args.find((a) => !a.startsWith('--'));
  if (args.includes('--help') || !vsixPath) {
    console.log('Usage: node scripts/verify-vsix-webview.js <file.vsix> [--json]');
    return vsixPath ? 0 : 2;
  }

  let result;
  try {
    const { expected, problems } = deriveExpected(
      readFileOrConfigError(DEFAULT_CSPROJ).toString('utf8'),
      readFileOrConfigError(DEFAULT_ESBUILD).toString('utf8'),
    );
    const verified = verifyVsix(readFileOrConfigError(vsixPath), expected);
    verified.failures.unshift(...problems.map((p) => `source lists disagree: ${p}`));
    verified.ok = verified.failures.length === 0;
    result = verified;
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`config error: ${e.message}`);
      return 2;
    }
    throw e;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`OK: all ${result.expected.length} webview files are present and non-empty in ${path.basename(vsixPath)}:`);
    for (const f of result.expected) console.log(`  ${VSIX_WEBVIEW_DIR}${f}`);
  } else {
    console.error(`FAIL: ${path.basename(vsixPath)} does not contain the expected webview content:`);
    for (const f of result.failures) console.error(`  - ${f}`);
    // Evidence for diagnosing wrong-path vs genuinely-missing: what the package does contain.
    console.error(`VSIX contains ${result.entries.length} entries; non-binary-looking ones:`);
    for (const e of result.entries) if (!/\.(dll|exe|wasm|pdb)$/i.test(e)) console.error(`    ${e}`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  parseCsprojBundles,
  parseCsprojVsixItems,
  parseEsbuildViews,
  deriveExpected,
  readZipEntries,
  verifyVsix,
  main,
};
