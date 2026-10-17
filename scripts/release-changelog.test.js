#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/release-changelog.js.
 *
 * Run with:  node --test scripts/release-changelog.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSection, promoteUnreleased } = require('./release-changelog');

const CHANGELOG = [
  '# Change Log',
  '',
  'All notable changes.',
  '',
  '## [Unreleased]',
  '',
  '### Features',
  '- New thing',
  '',
  '## [0.18.1] - 2026-09-21',
  '',
  '### Bug Fixes',
  '- Fixed thing',
  '',
  '## [0.18.0]',
  '',
  '- Older thing',
  '',
].join('\n');

test('promote moves Unreleased entries into a dated version section', () => {
  const result = promoteUnreleased(CHANGELOG, '0.18.2', '2026-09-28');
  assert.equal(result, [
    '# Change Log',
    '',
    'All notable changes.',
    '',
    '## [Unreleased]',
    '',
    '## [0.18.2] - 2026-09-28',
    '',
    '### Features',
    '- New thing',
    '',
    '## [0.18.1] - 2026-09-21',
    '',
    '### Bug Fixes',
    '- Fixed thing',
    '',
    '## [0.18.0]',
    '',
    '- Older thing',
    '',
  ].join('\n'));
});

test('promote refuses an empty Unreleased section', () => {
  const promoted = promoteUnreleased(CHANGELOG, '0.18.2', '2026-09-28');
  assert.throws(() => promoteUnreleased(promoted, '0.18.3', '2026-09-29'), /Unreleased.*empty/);
});

test('promote refuses a version that already has a section', () => {
  assert.throws(() => promoteUnreleased(CHANGELOG, '0.18.1', '2026-09-28'), /already exists/);
});

test('promote refuses a changelog without an Unreleased section', () => {
  assert.throws(() => promoteUnreleased('# Log\n\n## [1.0.0]\n\n- x\n', '1.0.1', '2026-09-28'), /No "## \[Unreleased\]"/);
});

test('promote keeps a CRLF changelog in CRLF', () => {
  const crlf = CHANGELOG.replace(/\n/g, '\r\n');
  const result = promoteUnreleased(crlf, '0.18.2', '2026-09-28');
  assert.ok(!/[^\r]\n/.test(result), 'every line ending is CRLF');
  assert.equal(result, promoteUnreleased(CHANGELOG, '0.18.2', '2026-09-28').replace(/\n/g, '\r\n'));
  assert.ok(result.includes('## [0.18.2] - 2026-09-28\r\n\r\n### Features\r\n- New thing\r\n'));
});

test('promote leaves the sections it does not change byte-for-byte', () => {
  const result = promoteUnreleased(CHANGELOG, '0.18.2', '2026-09-28');
  const untouched = CHANGELOG.slice(CHANGELOG.indexOf('## [0.18.1]'));
  assert.ok(result.endsWith(untouched));
});

test('promote on a mixed CRLF/LF changelog keeps every untouched line byte-for-byte', () => {
  // CRLF preamble and [Unreleased] (9 lines), LF released sections (8 lines).
  const split = CHANGELOG.indexOf('## [0.18.1]');
  const mixed = CHANGELOG.slice(0, split).replace(/\n/g, '\r\n') + CHANGELOG.slice(split);
  const result = promoteUnreleased(mixed, '0.18.2', '2026-09-28');
  assert.equal(result,
    '# Change Log\r\n\r\nAll notable changes.\r\n\r\n## [Unreleased]\r\n\r\n' +
    '## [0.18.2] - 2026-09-28\r\n\r\n### Features\r\n- New thing\r\n\r\n' +
    CHANGELOG.slice(split)); // LF sections unchanged, not converted to the CRLF majority

  // Flip it: an LF-majority file keeps its CRLF lines too, and new lines are LF.
  const lfMajority = CHANGELOG.slice(0, split) + CHANGELOG.slice(split).replace(/\n/g, '\r\n').replace('- Older thing\r\n', '- Older thing\n');
  const flipped = promoteUnreleased(lfMajority.replace('# Change Log\n', '# Change Log\r\n'), '0.18.2', '2026-09-28');
  assert.ok(flipped.startsWith('# Change Log\r\n\nAll notable changes.\n\n## [Unreleased]\n\n## [0.18.2] - 2026-09-28\n'));
  assert.ok(flipped.endsWith(lfMajority.slice(split)));
});

test('promote handles an [Unreleased] section on an unterminated last line', () => {
  const result = promoteUnreleased('# Log\n\n## [Unreleased]\n\n- Last thing', '1.0.0', '2026-09-28');
  assert.equal(result, '# Log\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-28\n\n- Last thing\n');
});

test('extract returns LF text from a CRLF changelog', () => {
  assert.equal(extractSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.18.1'), '### Bug Fixes\n- Fixed thing');
});

test('extract returns a dated section body without surrounding blank lines', () => {
  assert.equal(extractSection(CHANGELOG, '0.18.1'), '### Bug Fixes\n- Fixed thing');
});

test('extract handles an undated heading and the last section', () => {
  assert.equal(extractSection(CHANGELOG, '0.18.0'), '- Older thing');
});

test('extract does not match a version that is only a prefix of another', () => {
  assert.throws(() => extractSection(CHANGELOG, '0.18'), /No "## \[0.18\]" section/);
});

test('extract fails for a missing version', () => {
  assert.throws(() => extractSection(CHANGELOG, '0.19.0'), /No "## \[0.19.0\]" section/);
});

test('extract fails for an empty section', () => {
  assert.throws(() => extractSection('## [Unreleased]\n\n## [1.0.0]\n\n', '1.0.0'), /is empty/);
});

test('extract works on the promoted output', () => {
  const promoted = promoteUnreleased(CHANGELOG, '0.18.2', '2026-09-28');
  assert.equal(extractSection(promoted, '0.18.2'), '### Features\n- New thing');
});
