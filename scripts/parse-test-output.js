#!/usr/bin/env node
'use strict';

/**
 * Parses Node.js built-in test runner output (TAP format + text coverage table)
 * and writes a GitHub Actions step summary in Markdown.
 *
 * Usage:  node scripts/parse-test-output.js <output-file>
 * Output: Markdown written to stdout (redirect/append to $GITHUB_STEP_SUMMARY)
 */

const fs = require('fs');

const inputFile = process.argv[2];
let content = '';

if (inputFile && fs.existsSync(inputFile)) {
  try {
    content = fs.readFileSync(inputFile, 'utf8');
  } catch {
    // fall through to empty-content handling below
  }
}

if (!content.trim()) {
  process.stdout.write('## ⚠️ Test Results\n\nNo test output was captured.\n');
  process.exit(0);
}

// ── TAP summary ───────────────────────────────────────────────────────────────
// Node.js test runner emits summary lines like "# tests 284" at the end of TAP output.
function tapNum(pattern) {
  const m = content.match(pattern);
  return m ? parseInt(m[1], 10) : 0;
}

const total      = tapNum(/^# tests (\d+)/m);
const passed     = tapNum(/^# pass (\d+)/m);
const failed     = tapNum(/^# fail (\d+)/m);
const skipped    = tapNum(/^# skipped (\d+)/m);
const durationMs = tapNum(/^# duration_ms (\d+)/m);

// ── Coverage table ────────────────────────────────────────────────────────────
// The Node.js text coverage reporter appends a table after the TAP output:
//
//   File        | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
//   All files   |   78.48 |    64.58 |   81.08 |   78.48 |
//    backend/   |   76.00 |    58.00 |   72.00 |   76.00 |
//     foo.js    |   80.00 |    60.00 |   75.00 |   80.00 | 15-20
//
// Strategy: scan every line for "name | num | num | num | num |".
// This regex is specific enough not to match TAP test-result lines.
const ROW_RE = /^(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/;

const entries = [];

for (const raw of content.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line.includes('|')) continue;

  const m = ROW_RE.exec(line);
  if (!m) continue;

  const name = m[1].trim();
  // Skip the column header row
  if (name.toLowerCase() === 'file') continue;

  entries.push({
    name,
    stmts:    parseFloat(m[2]),
    branches: parseFloat(m[3]),
    funcs:    parseFloat(m[4]),
    lines:    parseFloat(m[5]),
  });
}

// "All files" row = overall totals
const allFiles = entries.find(e => e.name.toLowerCase() === 'all files');

// Directory rows are entries whose name ends with '/'
const dirs = entries.filter(e => e !== allFiles && e.name.endsWith('/'));

// Keep only "leaf" directories — those not a parent of any other listed directory.
// e.g. if "out/src/" and "out/src/backend/" are both present, keep only "out/src/backend/"
const leafDirs = dirs.filter(d => {
  const n = d.name.toLowerCase();
  return !dirs.some(other => {
    const o = other.name.toLowerCase();
    return o !== n && o.startsWith(n);
  });
});

function displayLabel(dirPath) {
  const segs = dirPath.replace(/\/+$/, '').split('/').filter(Boolean);
  const last  = segs.at(-1) ?? dirPath;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function pct(n) {
  return `${n.toFixed(1)}%`;
}

// ── Markdown ──────────────────────────────────────────────────────────────────
const emoji  = failed > 0 ? '❌' : '✅';
const durSec = (durationMs / 1000).toFixed(2);

let md = '';

md += `## ${emoji} Unit Test Results\n\n`;
md += '| Tests | Passed | Failed | Skipped | Duration |\n';
md += '|:-----:|:------:|:------:|:-------:|:--------:|\n';
md += `| ${total} | ${passed} | ${failed} | ${skipped} | ${durSec}s |\n\n`;

if (allFiles || leafDirs.length > 0) {
  md += '### 📊 Coverage Summary\n\n';
  md += '| Module | Statements | Branches | Functions | Lines |\n';
  md += '|--------|:----------:|:--------:|:---------:|:-----:|\n';

  for (const d of [...leafDirs].sort((a, b) => a.name.localeCompare(b.name))) {
    md += `| ${displayLabel(d.name)} | ${pct(d.stmts)} | ${pct(d.branches)} | ${pct(d.funcs)} | ${pct(d.lines)} |\n`;
  }

  if (allFiles) {
    md += `| **All files** | **${pct(allFiles.stmts)}** | **${pct(allFiles.branches)}** | **${pct(allFiles.funcs)}** | **${pct(allFiles.lines)}** |\n`;
  }

  md += '\n';
}

process.stdout.write(md);
