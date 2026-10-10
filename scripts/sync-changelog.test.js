#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the merge in scripts/sync-changelog.js: backfilling from
 * GitHub releases must add missing versions and never rewrite a curated one.
 *
 * Run with:  node --test scripts/sync-changelog.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeReleases, versionFromTag, compareVersions } = require('./sync-changelog');

const CHANGELOG = [
  '# Change Log',
  '',
  'All notable changes.',
  '',
  '## [Unreleased]',
  '',
  '- Pending thing',
  '',
  '## [0.18.2] - 2026-09-28',
  '',
  '### Features',
  '- Curated feature (#2200)',
  '',
  '## [0.18.0] - 2026-09-18',
  '',
  '### Bug Fixes',
  '- Curated fix',
  '',
].join('\n');

const release = (tagName, body, isPrerelease = false) => ({ tagName, body, isPrerelease });

test('an existing version section is kept byte-for-byte, even when the release body differs', () => {
  const { text, added } = mergeReleases(CHANGELOG, [
    release('vscode/v0.18.2', 'Something completely different'),
    release('vscode/v0.18.0', ''),
  ]);
  assert.deepEqual(added, []);
  assert.equal(text, CHANGELOG);
});

test('a missing version is inserted in version order without touching its neighbours', () => {
  const { text, added } = mergeReleases(CHANGELOG, [
    release('vscode/v0.18.1', '## What changed\r\nFixed a thing\r\n\r\n**Full Changelog**: https://example.test/compare'),
  ]);
  assert.deepEqual(added, ['0.18.1']);
  assert.equal(text, [
    '# Change Log',
    '',
    'All notable changes.',
    '',
    '## [Unreleased]',
    '',
    '- Pending thing',
    '',
    '## [0.18.2] - 2026-09-28',
    '',
    '### Features',
    '- Curated feature (#2200)',
    '',
    '## [0.18.1]',
    '',
    '## What changed',
    '- Fixed a thing',
    '',
    '## [0.18.0] - 2026-09-18',
    '',
    '### Bug Fixes',
    '- Curated fix',
    '',
  ].join('\n'));
});

test('a CRLF changelog keeps its existing sections byte-for-byte and gets the new one in CRLF', () => {
  const crlf = CHANGELOG.replace(/\n/g, '\r\n');
  const releases = [release('vscode/v0.18.1', 'Fixed a thing')];
  const { text, added } = mergeReleases(crlf, releases);
  assert.deepEqual(added, ['0.18.1']);
  assert.ok(!/[^\r]\n/.test(text), 'every line ending is CRLF');
  assert.equal(text, mergeReleases(CHANGELOG, releases).text.replace(/\n/g, '\r\n'));
  // Everything before the inserted section, and everything after it, is the original bytes.
  const insertAt = crlf.indexOf('## [0.18.0]');
  assert.ok(text.startsWith(crlf.slice(0, insertAt)));
  assert.ok(text.endsWith(crlf.slice(insertAt)));
});

test('a CRLF changelog with nothing to add comes back unchanged', () => {
  const crlf = CHANGELOG.replace(/\n/g, '\r\n');
  const { text, added } = mergeReleases(crlf, [release('vscode/v0.18.2', 'Different body')]);
  assert.deepEqual(added, []);
  assert.equal(text, crlf);
});

test('a mixed CRLF/LF changelog keeps every existing line byte-for-byte', () => {
  // CRLF preamble and first sections, LF last section: CRLF is the majority.
  const split = CHANGELOG.indexOf('## [0.18.0]');
  const mixed = CHANGELOG.slice(0, split).replace(/\n/g, '\r\n') + CHANGELOG.slice(split);
  const { text, added } = mergeReleases(mixed, [release('vscode/v0.18.1', 'Fixed a thing'), release('v0.0.1', '')]);
  assert.deepEqual(added, ['0.18.1', '0.0.1']);
  assert.ok(text.startsWith(mixed.slice(0, split)), 'CRLF part unchanged');
  assert.ok(text.includes(CHANGELOG.slice(split)), 'LF part unchanged');
  // New lines use the majority ending.
  assert.ok(text.includes('## [0.18.1]\r\n\r\n- Fixed a thing\r\n\r\n## [0.18.0]'));
  assert.ok(text.endsWith('- Curated fix\n\r\n## [0.0.1]\r\n\r\n- Release 0.0.1\r\n'));
});

test('appending to a changelog whose last line is unterminated terminates it first', () => {
  const { text } = mergeReleases('# Log\n\n## [Unreleased]\n\n## [1.0.0]\n\n- Only', [release('v0.9.0', '- Older')]);
  assert.equal(text, '# Log\n\n## [Unreleased]\n\n## [1.0.0]\n\n- Only\n\n## [0.9.0]\n\n- Older\n');
});

test('a version older than every section is appended at the end, pre-release marked', () => {
  const { text, added } = mergeReleases(CHANGELOG, [release('v0.0.1', '', true)]);
  assert.deepEqual(added, ['0.0.1']);
  assert.ok(text.startsWith(CHANGELOG));
  assert.ok(text.endsWith('\n## [0.0.1] - Pre-release\n\n- Release 0.0.1\n'));
});

test('a version newer than every section goes after [Unreleased], never above it', () => {
  const { text } = mergeReleases(CHANGELOG, [release('vscode/v0.19.0', '- New')]);
  assert.ok(text.indexOf('## [Unreleased]') < text.indexOf('## [0.19.0]'));
  assert.ok(text.indexOf('## [0.19.0]') < text.indexOf('## [0.18.2]'));
});

test('a new file gets the default header, [Unreleased] and the release', () => {
  const { text, added } = mergeReleases('', [release('cli/v0.1.0', '- First')]);
  assert.deepEqual(added, ['0.1.0']);
  assert.ok(text.startsWith('# Change Log\n'));
  assert.ok(text.indexOf('## [Unreleased]') < text.indexOf('## [0.1.0]'));
  assert.ok(text.endsWith('## [0.1.0]\n\n- First\n'));
});

test('versionFromTag strips every supported tag prefix', () => {
  assert.equal(versionFromTag('vscode/v0.18.2'), '0.18.2');
  assert.equal(versionFromTag('cli/v0.6.1'), '0.6.1');
  assert.equal(versionFromTag('vs/v1.4.1'), '1.4.1');
  assert.equal(versionFromTag('v0.0.2'), '0.0.2');
});

test('compareVersions compares numerically and ignores non-versions', () => {
  assert.ok(compareVersions('0.18.10', '0.18.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('Unreleased', '1.0.0'), null);
});
