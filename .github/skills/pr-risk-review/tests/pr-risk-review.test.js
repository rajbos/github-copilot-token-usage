'use strict';

// Regression tests for the pr-risk-review scripts (issue #2307).
// Run with: node --test .github/skills/pr-risk-review/tests/pr-risk-review.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { sanitize, sanitizeLine, cell, render } = require('../render-comment.js');
const {
  parseNumstatZ,
  parseNameStatusZ,
  classify,
  codeSpan,
} = require('../collect-changeset.js');

const SKILL_DIR = path.resolve(__dirname, '..');
const COLLECT = path.join(SKILL_DIR, 'collect-changeset.js');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'risk-signals.json'), 'utf8'));
const ZWSP = '\u200B';

// ── the skill's own sources ─────────────────────────────────────────────────

// Code points that render as nothing or reorder text. Checked numerically so
// this test cannot itself be defeated by the characters it looks for.
function isHidden(cp) {
  return (
    (cp < 0x20 && cp !== 0x0a && cp !== 0x09) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    [0xad, 0x34f, 0x61c, 0x180e, 0xfeff].includes(cp) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp >= 0xe0000
  );
}

test('sources: no literal invisible, bidi or control characters (use escapes)', () => {
  const files = ['render-comment.js', 'collect-changeset.js', 'SKILL.md', 'SECURITY.md', 'tests/pr-risk-review.test.js'];
  for (const name of files) {
    const text = fs.readFileSync(path.join(SKILL_DIR, name), 'utf8');
    const found = [];
    let line = 1;
    let previous = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      // The one allowed exception: U+FE0F as the emoji presentation of the
      // warning sign U+26A0 (the existing ⚠️ in render-comment.js). Anywhere
      // else a variation selector is still reported.
      const emojiPresentation = cp === 0xfe0f && previous === 0x26a0;
      if (ch === '\n') line += 1;
      else if (isHidden(cp) && !emojiPresentation) found.push(`line ${line}: U+${cp.toString(16)}`);
      previous = cp;
    }
    assert.deepEqual(found, [], `${name} contains literal hidden characters`);
  }
});

// ── render-comment.js sanitize()────────────────────────────────────────────

test('sanitize: zero-width space cannot splice a forged sticky marker back together', () => {
  const out = sanitize(`<${ZWSP}!-- pr-risk-review -->`, 2400);
  assert.ok(!out.includes('<!--'), out);
  assert.ok(!out.includes('<'), out);
  assert.ok(!out.includes(ZWSP), out);
});

test('sanitize: zero-width space cannot splice a raw HTML tag back together', () => {
  const out = sanitize(`<${ZWSP}img src=x>`, 2400);
  assert.ok(!/<img/i.test(out), out);
  assert.ok(!out.includes('<'), out);
});

test('sanitize: other invisible characters are removed before the HTML steps', () => {
  for (const ch of ['\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD', '\u202E', '\u{E0041}', '\u0007']) {
    const out = sanitize(`<${ch}!-- pr-risk-review --> <${ch}script>`, 2400);
    assert.ok(!out.includes('<'), `U+${ch.codePointAt(0).toString(16)}: ${out}`);
  }
});

test('sanitize: a mention hidden behind a zero-width space is still neutralised', () => {
  assert.equal(sanitize(`ping @${ZWSP}octocat`, 2400), 'ping `@octocat`');
});

test('sanitize: a comment removed from between characters cannot form new markup', () => {
  const out = sanitize('<<!-- x -->!-- pr-risk-review --> <<!---->img src=x>', 2400);
  assert.ok(!out.includes('<!--'), out);
  assert.ok(!/<img/i.test(out), out);
});

test('sanitize: closing tags, declarations and autolinks are escaped', () => {
  const out = sanitize('</details> <!DOCTYPE html> <?xml?> <https://example.com>', 2400);
  assert.ok(!out.includes('<'), out);
});

test('sanitize: markdown images and links are neutralised', () => {
  const out = sanitize(
    'See ![x](https://example.com/p.png) and [text](https://example.com) and [r][1]\n[1]: https://example.com',
    2400
  );
  assert.ok(!out.includes('['), out);
  assert.ok(out.startsWith('See !&#91;x](https://example.com/p.png) and &#91;text]'), out);
});

test('sanitize: carriage returns and Unicode line separators are folded to newlines', () => {
  assert.equal(sanitize('a\rb\r\nc\u2028d\u2029e\u0085f', 2400), 'a\nb\nc\nd\nef');
});

test('sanitizeLine and cell: a bare carriage return cannot break a table row or list item', () => {
  for (const input of ['row\r| injected | cell |', 'item\r- [x] injected', 'x\u2028## heading']) {
    const line = sanitizeLine(input, 400);
    assert.ok(!/[\r\n\u2028\u2029]/.test(line), JSON.stringify(line));
    assert.ok(!/[\r\n\u2028\u2029]/.test(cell(line)), JSON.stringify(cell(line)));
  }
});

test('sanitize: the length cap never splits a neutralised mention or reference', () => {
  for (let max = 4; max <= 16; max += 1) {
    for (const input of ['xxx @bob tail', 'xxx #123 tail', 'a <b> [c] @dave #42 end']) {
      const out = sanitize(input, max);
      assert.ok(out.length <= max, `${max}: ${out}`);
      // Every backtick that is written is part of a closed pair.
      assert.equal((out.match(/`/g) || []).length % 2, 0, `${max}: ${out}`);
      // No mention or reference outside a code span (`&#91;` is our entity).
      assert.ok(!/(^|[^`\w&])[@#][A-Za-z0-9]/.test(out.replace(/`[^`]*`/g, '')), `${max}: ${out}`);
      // No entity cut in half.
      assert.ok(!/&#?[A-Za-z0-9]*…$/.test(out), `${max}: ${out}`);
    }
  }
  assert.equal(sanitize('xxx @bob tail', 10), 'xxx…');
});

test('sanitize: plain comparisons and code survive', () => {
  assert.equal(sanitize('a < b and x <= 3', 2400), 'a < b and x <= 3');
});

// ── render-comment.js render() ──────────────────────────────────────────────

function changesetFixture() {
  return {
    stats: { files: 1, insertions: 1, deletions: 0, generatedFiles: 0, binaryFiles: 0 },
    baseline: { level: 'low' },
    signals: [],
  };
}

test('render: only the renderer emits the sticky marker, even for both bypass inputs', () => {
  const verdict = {
    risk: 'low',
    summary: sanitize(`<${ZWSP}!-- pr-risk-review --> <${ZWSP}img src=x>`, 2400),
    factors: [
      {
        level: 'low',
        title: sanitize(`<${ZWSP}!-- pr-risk-review -->`, 120),
        detail: sanitize(`![x](https://example.com/p.png) <${ZWSP}img src=x>`, 400),
      },
    ],
    recommendations: [sanitize('[click](https://example.com)', 400)],
    confidence: 'high',
    source: 'agent',
  };
  const comment = render(verdict, changesetFixture(), { marker: 'pr-risk-review', runUrl: '' });
  assert.equal(comment.split('<!-- pr-risk-review -->').length - 1, 1);
  assert.ok(!/<img/i.test(comment), comment);
  for (const live of ['![', '[x]', '[click]']) assert.ok(!comment.includes(live), comment);
});

// ── collect-changeset.js parsing ────────────────────────────────────────────

test('parseNumstatZ: renames come back as two real paths', () => {
  const output = '3\t1\t\0a/f.txt\0.github/workflows/f.txt\0' + '2\t0\tsrc/x.ts\0' + '-\t-\tlogo.png\0';
  assert.deepEqual(parseNumstatZ(output), [
    { rawIns: '3', rawDel: '1', filePath: '.github/workflows/f.txt', oldPath: 'a/f.txt' },
    { rawIns: '2', rawDel: '0', filePath: 'src/x.ts', oldPath: null },
    { rawIns: '-', rawDel: '-', filePath: 'logo.png', oldPath: null },
  ]);
});

test('parseNameStatusZ: rename status is keyed on the new path', () => {
  const map = parseNameStatusZ('R100\0a/f.txt\0.github/workflows/f.txt\0M\0src/x.ts\0');
  assert.deepEqual(map.get('.github/workflows/f.txt'), { status: 'R', oldPath: 'a/f.txt' });
  assert.deepEqual(map.get('src/x.ts'), { status: 'M', oldPath: null });
});

function fileFixture(filePath, oldPath = null) {
  return {
    path: filePath,
    oldPath,
    status: oldPath ? 'R' : 'M',
    insertions: 1,
    deletions: 0,
    binary: false,
    categories: [],
    generated: false,
  };
}

test('classify: a file moved out of a sensitive directory into docs keeps the higher level', () => {
  const [plain] = [fileFixture('.github/workflows/ci.yml')];
  classify([plain], CONFIG);
  const moved = fileFixture('docs/ci.yml', '.github/workflows/ci.yml');
  classify([moved], CONFIG);
  assert.equal(moved.effectiveLevel, plain.effectiveLevel);
  assert.notEqual(moved.effectiveLevel, 'low');
  assert.equal(moved.lowRisk, false);
});

test('classify: a hand-written file renamed into a generated path still counts as reviewable', () => {
  const moved = fileFixture('vscode-extension/dist/extension.js', 'vscode-extension/src/extension.ts');
  classify([moved], CONFIG);
  assert.equal(moved.generated, false);
  const both = fileFixture('a/dist/x.js', 'b/dist/x.js');
  classify([both], CONFIG);
  assert.equal(both.generated, true);
});

// ── collect-changeset.js end to end against a scratch repository ────────────

function gitIn(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('collect-changeset: a rename into .github/workflows is classified at its real path', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-risk-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  gitIn(repo, ['init', '-q']);
  gitIn(repo, ['config', 'user.email', 'test@example.com']);
  gitIn(repo, ['config', 'user.name', 'test']);
  gitIn(repo, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(repo, 'a'));
  fs.writeFileSync(path.join(repo, 'a', 'f.yml'), 'name: x\non: push\njobs: {}\n'.repeat(5));
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-q', '-m', 'base']);
  const base = gitIn(repo, ['rev-parse', 'HEAD']).trim();
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  gitIn(repo, ['mv', 'a/f.yml', '.github/workflows/f.yml']);
  gitIn(repo, ['commit', '-q', '-m', 'move']);

  const outDir = path.join(repo, 'out');
  const result = spawnSync(process.execPath, [COLLECT, '--base', base, '--head', 'HEAD', '--out-dir', outDir], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const changeset = JSON.parse(fs.readFileSync(path.join(outDir, 'changeset.json'), 'utf8'));
  assert.equal(changeset.files.length, 1);
  const [file] = changeset.files;
  assert.equal(file.path, '.github/workflows/f.yml');
  assert.equal(file.oldPath, 'a/f.yml');
  assert.equal(file.status, 'R');
  assert.equal(file.effectiveLevel, 'high');
});

test('collect-changeset: --base/--head values starting with "-" are rejected', () => {
  for (const flag of ['--base', '--head']) {
    const result = spawnSync(process.execPath, [COLLECT, flag, '--output=/tmp/x'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not an option/);
  }
});

// ── collect-changeset.js codeSpan() ─────────────────────────────────────────

test('codeSpan: backticks, pipes, newlines and bidi in file names cannot break the table', () => {
  const span = codeSpan('a`b|c\nd\u202Ee.txt');
  assert.ok(!span.includes('\n'));
  assert.ok(!span.includes('\u202E'));
  assert.ok(!span.includes('|'), span);
  assert.ok(span.includes('\\u{202E}'));
  assert.ok(span.includes('\\u{7C}'));
  assert.ok(span.startsWith('``') && span.endsWith('``'), span);
});

test('codeSpan: leading and trailing spaces survive CommonMark stripping', () => {
  // CommonMark strips one space from each end when both ends are spaces.
  const stripOnce = (span) => {
    const content = span.replace(/^`+|`+$/g, '');
    return /^ .* $/.test(content) && /[^ ]/.test(content) ? content.slice(1, -1) : content;
  };
  for (const name of [' foo ', ' foo', 'foo ', '  two  ', '`tick', 'tick`']) {
    assert.equal(stripOnce(codeSpan(name)), name, JSON.stringify(name));
  }
  assert.equal(codeSpan('   '), '`   `');
});

test('codeSpan: a backslash before a pipe cannot split the row', () => {
  for (const name of ['a\\|b', 'a\\\\|b', 'trailing\\', '\\|']) {
    const span = codeSpan(name);
    assert.ok(!span.includes('|'), `${JSON.stringify(name)} -> ${span}`);
    // The only backslashes left are the ones opening our own `\u{...}` escapes.
    assert.ok(!/\\(?!u\{)/.test(span), `${JSON.stringify(name)} -> ${span}`);
    assert.ok(span.includes('\\u{5C}'), span);
  }
});
