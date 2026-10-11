'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, 'visual-diff-comment.js');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')]);

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
      fs.writeFileSync(path.join(screenshots, directory, name), PNG);
    }
    const diff = `sample.${theme}.diff.png`;
    fs.writeFileSync(path.join(screenshots, 'diff', diff), PNG);
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

test('artifact contents are untrusted: non-PNG, oversized and unusable inputs are not attached', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-diff-comment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const screenshots = path.join(root, 'screenshots');
  for (const directory of ['baseline', 'current', 'diff']) {
    fs.mkdirSync(path.join(screenshots, directory), { recursive: true });
  }
  // "fake" carries a .png name but not PNG bytes; "good" is a real PNG.
  for (const [name, bytes] of [['fake.png', Buffer.from('<script>')], ['good.png', PNG]]) {
    for (const directory of ['baseline', 'current', 'diff']) {
      fs.writeFileSync(path.join(screenshots, directory, name), bytes);
    }
  }
  // A real PNG header followed by padding past the size bound.
  for (const directory of ['baseline', 'current', 'diff']) {
    fs.writeFileSync(path.join(screenshots, directory, 'big.png'), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
  }
  const row = (view, file) => ({
    view, theme: 'light', status: 'changed', baseline: file, current: file, diff: file,
    changedPixels: 1, changedPercent: 1,
  });
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ comparisons: [row('fake', 'fake.png'), row('big', 'big.png'), row('good', 'good.png')] }));
  const run = (report) => execFileSync(process.execPath, [
    script, '--report', report, '--screenshots', 'screenshots', '--out-dir', 'output',
  ], { cwd: root, encoding: 'utf8' });

  run('report.json');
  const attachments = fs.readFileSync(path.join(root, 'output', 'attachments.txt'), 'utf8');
  assert.ok(attachments.includes('good.png'));
  assert.ok(!attachments.includes('fake.png'));
  assert.ok(!attachments.includes('big.png'), 'a PNG over the size bound must be omitted');

  // An oversized report is treated like a missing one, not parsed.
  fs.writeFileSync(path.join(root, 'huge.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  assert.match(run('huge.json'), /unusable/);
  // So is one that is not JSON.
  fs.writeFileSync(path.join(root, 'bad.json'), 'not json');
  assert.match(run('bad.json'), /unusable/);
});

test('--notice writes a marker-first replacement for a stale comment', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-diff-comment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const kind of ['skipped', 'no-report']) {
    execFileSync(process.execPath, [
      script, '--notice', kind, '--out-dir', 'output', '--run-url', 'https://github.com/o/r/actions/runs/1',
    ], { cwd: root });
    const body = fs.readFileSync(path.join(root, 'output', 'comment-plain.md'), 'utf8');
    assert.ok(body.startsWith('<!-- visual-view-diff -->\n'), 'marker must stay the first line');
    assert.match(body, /no longer apply/);
    assert.match(body, /\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/);
  }
  assert.throws(() => execFileSync(process.execPath, [script, '--notice', 'bogus'], { cwd: root, stdio: 'pipe' }));
});
