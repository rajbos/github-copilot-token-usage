'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, 'visual-diff-comment.js');

test('renders before, after and diff in light-then-dark rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-diff-comment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const screenshots = path.join(root, 'screenshots');
  for (const directory of ['baseline', 'current', 'diff']) {
    fs.mkdirSync(path.join(screenshots, directory), { recursive: true });
  }

  const comparisons = ['dark', 'light'].map((theme) => {
    const name = `sample.${theme}.png`;
    for (const directory of ['baseline', 'current']) {
      fs.writeFileSync(path.join(screenshots, directory, name), 'png');
    }
    const diff = `sample.${theme}.diff.png`;
    fs.writeFileSync(path.join(screenshots, 'diff', diff), 'png');
    return {
      view: 'sample',
      theme,
      status: 'changed',
      baseline: name,
      current: name,
      diff,
      changedPixels: 10,
      changedPercent: 1,
    };
  });
  const report = path.join(root, 'report.json');
  fs.writeFileSync(report, JSON.stringify({ comparisons }));

  execFileSync(process.execPath, [
    script,
    '--report', 'report.json',
    '--screenshots', 'screenshots',
    '--out-dir', 'output',
  ], { cwd: root });

  const comment = fs.readFileSync(path.join(root, 'output', 'comment.md'), 'utf8');
  const rows = comment.split('\n').filter((line) => line.startsWith('| **sample**'));
  assert.match(comment, /\| Name \| Before \| After \| Diff \|/);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('(light mode)'));
  assert.ok(rows[0].includes('![Before: sample light](screenshots/baseline/sample.light.png)'));
  assert.ok(rows[0].includes('![After: sample light](screenshots/current/sample.light.png)'));
  assert.ok(rows[0].includes('![Diff: sample light](screenshots/diff/sample.light.diff.png)'));
  assert.ok(rows[1].includes('(dark mode)'));
  assert.ok(rows[1].includes('![Before: sample dark](screenshots/baseline/sample.dark.png)'));
  assert.ok(rows[1].includes('![After: sample dark](screenshots/current/sample.dark.png)'));
  assert.ok(rows[1].includes('![Diff: sample dark](screenshots/diff/sample.dark.diff.png)'));
  assert.doesNotMatch(comment, /<details>/);
});
