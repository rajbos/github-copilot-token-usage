#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/bump-vscode-types.js: the cooldown must hold back
 * recent releases, pre-releases must be skipped, and @types/vscode and
 * engines.vscode must always move together and never downgrade.
 *
 * Run with:  node --test scripts/bump-vscode-types.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickEligibleVersion, applyBump } = require('./bump-vscode-types');

const NOW = Date.parse('2026-10-13T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

test('pickEligibleVersion skips versions inside the cooldown', () => {
  const time = {
    created: daysAgo(900),
    modified: daysAgo(1),
    '1.134.0': daysAgo(60),
    '1.135.0': daysAgo(41),
    '1.136.0': daysAgo(5),
  };
  assert.equal(pickEligibleVersion(time, NOW, 42), '1.134.0');
});

test('pickEligibleVersion includes a version published exactly at the cutoff', () => {
  assert.equal(pickEligibleVersion({ '1.135.0': daysAgo(42) }, NOW, 42), '1.135.0');
});

test('pickEligibleVersion returns the highest eligible version, not the latest published', () => {
  const time = { '1.133.1': daysAgo(100), '1.134.0': daysAgo(50), '1.133.9': daysAgo(45) };
  assert.equal(pickEligibleVersion(time, NOW, 42), '1.134.0');
});

test('pickEligibleVersion ignores pre-releases and returns null when nothing qualifies', () => {
  assert.equal(pickEligibleVersion({ '1.136.0-insiders.1': daysAgo(90) }, NOW, 42), null);
  assert.equal(pickEligibleVersion({ '1.136.0': daysAgo(2) }, NOW, 42), null);
});

const PACKAGE_JSON = `{
  "engines": {
    "vscode": "^1.134.0"
  },
  "devDependencies": {
    "@types/vscode": "1.134.0",
    "typescript": "^5.0.0"
  }
}
`;

test('applyBump updates @types/vscode and engines.vscode together, keeping formatting', () => {
  const out = applyBump(PACKAGE_JSON, '1.136.0');
  assert.equal(out, PACKAGE_JSON.replace('"^1.134.0"', '"^1.136.0"').replace('"1.134.0"', '"1.136.0"'));
  const pkg = JSON.parse(out);
  assert.equal(pkg.devDependencies['@types/vscode'], '1.136.0');
  assert.equal(pkg.engines.vscode, '^1.136.0');
});

test('applyBump returns null for the same or an older version (never downgrades)', () => {
  assert.equal(applyBump(PACKAGE_JSON, '1.134.0'), null);
  assert.equal(applyBump(PACKAGE_JSON, '1.133.0'), null);
});

test('applyBump rejects a range instead of a pinned @types/vscode', () => {
  const ranged = PACKAGE_JSON.replace('"1.134.0",', '"^1.134.0",');
  assert.throws(() => applyBump(ranged, '1.136.0'), /pinned/);
});
