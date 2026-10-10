#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/validate-docs-index.js.
 *
 * Run with:  node --test scripts/validate-docs-index.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractLinks, resolveLocalTarget, checkIndex, listMarkdownFiles } = require('./validate-docs-index.js');

const DIR = path.resolve('/virtual/docs');
const f = (rel) => path.join(DIR, rel);

test('extractLinks skips fenced code blocks and keeps titles out of the target', () => {
  const md = ['[a](a.md)', '```', '[x](ignored.md)', '```', '[b](sub/b.md "Title")'].join('\n');
  assert.deepEqual(extractLinks(md), ['a.md', 'sub/b.md']);
});

test('resolveLocalTarget ignores URLs and bare anchors, strips fragments', () => {
  assert.equal(resolveLocalTarget('https://example.com/x', DIR), null);
  assert.equal(resolveLocalTarget('mailto:a@b.c', DIR), null);
  assert.equal(resolveLocalTarget('#section', DIR), null);
  assert.equal(resolveLocalTarget('a.md#top', DIR), f('a.md'));
});

test('checkIndex reports unlinked docs and broken links', () => {
  const md = '[a](a.md) [gone](gone.md)';
  const existing = new Set([f('a.md'), f('b.md')]);
  const res = checkIndex(md, [f('README.md'), f('a.md'), f('b.md')], DIR, (p) => existing.has(p));
  assert.deepEqual(res.unlinked, ['b.md']);
  assert.deepEqual(res.broken, ['gone.md']);
});

test('a folder link indexes that folder\'s README.md', () => {
  const existing = new Set([f('cli'), f('cli/README.md')]);
  const res = checkIndex('[cli](cli/)', [f('README.md'), f('cli/README.md')], DIR, (p) => existing.has(p));
  assert.deepEqual(res, { unlinked: [], broken: [] });
});

test('the index file itself never needs to be linked', () => {
  const res = checkIndex('', [f('README.md')], DIR, () => true);
  assert.deepEqual(res, { unlinked: [], broken: [] });
});

test('listMarkdownFiles finds nested markdown only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-'));
  try {
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'a.md'), '');
    fs.writeFileSync(path.join(tmp, 'sub', 'b.MD'), '');
    fs.writeFileSync(path.join(tmp, 'sub', 'c.json'), '');
    const names = listMarkdownFiles(tmp).map((p) => path.relative(tmp, p).split(path.sep).join('/')).sort();
    assert.deepEqual(names, ['a.md', 'sub/b.MD']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
