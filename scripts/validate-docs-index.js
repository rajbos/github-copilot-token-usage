#!/usr/bin/env node
'use strict';

/**
 * Validates docs/README.md as the index of the docs/ folder.
 *
 * Fails (exit 1) when:
 *   - a docs/**\/*.md file is not linked from docs/README.md, or
 *   - a relative link in docs/README.md points at a file or folder that does not exist.
 *
 * A link to a folder (e.g. `cli/`) indexes that folder's README.md. Links inside fenced code
 * blocks are ignored. Dependency-free; run with:  node scripts/validate-docs-index.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const INDEX_FILE = path.join(DOCS_DIR, 'README.md');

/** Recursively list files under `dir` whose name ends in `.md`, as absolute paths. */
function listMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') { continue; }
      out.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** Extract `[text](target)` link targets from markdown, skipping fenced code blocks. */
function extractLinks(markdown) {
  const links = [];
  let fence = null; // { ch, len } of the currently open fenced block
  for (const line of markdown.split(/\r?\n/)) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // Only a fence of the same character, at least as long, with no info string, closes the block.
      if (open && open[1][0] === fence.ch && open[1].length >= fence.len && open[2].trim() === '') { fence = null; }
      continue;
    }
    if (open) { fence = { ch: open[1][0], len: open[1].length }; continue; }
    const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line)) !== null) { links.push(m[1]); }
  }
  return links;
}

/** Turn a link target into a path relative-resolved against `baseDir`, or null if not a local file link. */
function resolveLocalTarget(target, baseDir) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) { return null; }
  const clean = target.split('#')[0].split('?')[0];
  if (!clean) { return null; }
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* keep raw */ }
  return path.resolve(baseDir, decoded);
}

/**
 * @param {string} indexMarkdown contents of the index file
 * @param {string[]} docFiles absolute paths of every markdown file that must be indexed
 * @param {string} indexDir directory containing the index file
 * @param {(p: string) => boolean} [exists] injectable existence check (defaults to fs.existsSync)
 * @returns {{ unlinked: string[], broken: string[] }} paths relative to `indexDir`, forward-slashed
 */
function checkIndex(indexMarkdown, docFiles, indexDir, exists = fs.existsSync) {
  const rel = (p) => path.relative(indexDir, p).split(path.sep).join('/');
  const linked = new Set();
  const broken = [];
  for (const target of extractLinks(indexMarkdown)) {
    const resolved = resolveLocalTarget(target, indexDir);
    if (!resolved) { continue; }
    if (!exists(resolved)) { broken.push(target); continue; }
    linked.add(resolved);
    // A folder link indexes the README.md inside it.
    linked.add(path.join(resolved, 'README.md'));
  }
  const indexPath = path.join(indexDir, 'README.md');
  const unlinked = docFiles
    .filter((f) => path.resolve(f) !== path.resolve(indexPath))
    .filter((f) => !linked.has(path.resolve(f)))
    .map(rel)
    .sort();
  return { unlinked, broken: [...new Set(broken)].sort() };
}

function main() {
  const { unlinked, broken } = checkIndex(
    fs.readFileSync(INDEX_FILE, 'utf8'),
    listMarkdownFiles(DOCS_DIR),
    DOCS_DIR,
  );
  for (const f of unlinked) { console.error(`docs/README.md does not link docs/${f}`); }
  for (const l of broken) { console.error(`docs/README.md links to a missing path: ${l}`); }
  if (unlinked.length || broken.length) {
    console.error(`\nDocs index check failed: ${unlinked.length} unlinked, ${broken.length} broken.`);
    process.exit(1);
  }
  console.log('Docs index OK: every docs/**/*.md is linked from docs/README.md and no link is broken.');
}

if (require.main === module) { main(); }

module.exports = { listMarkdownFiles, extractLinks, resolveLocalTarget, checkIndex };
