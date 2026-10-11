#!/usr/bin/env node
/**
 * Collect the changeset context the `pr-risk-review` skill reasons over.
 *
 * Dependency-free. Runs the same way for every agent that uses the skill —
 * Claude Code on a local branch, the Copilot CLI inside the PR Risk Review
 * workflow, or a human debugging the heuristics — so the mechanical half of a
 * risk review (what changed, how big, which sensitive areas it touches) is
 * identical no matter who runs it. Only the judgement half is left to the model.
 *
 * Usage:
 *   node .github/skills/pr-risk-review/collect-changeset.js [options]
 *
 * Options:
 *   --base <ref>        Base commit/ref. Default: merge-base with the default
 *                       branch, falling back to HEAD^.
 *   --head <ref>        Head commit/ref. Default: HEAD.
 *   --out-dir <dir>     Where to write the outputs. Default: pr-risk
 *   --max-diff-bytes N  Truncate changeset.diff at N bytes. Default: 200000
 *   --json              Also print changeset.json to stdout.
 *
 * Writes into <out-dir>:
 *   changeset.json  Structured facts: files, stats, matched signals, baseline.
 *   changeset.md    The same facts as markdown, for pasting into a prompt.
 *   changeset.diff  The unified diff (truncated at --max-diff-bytes).
 *
 * Exit codes: 0 on success (an empty changeset is a success), 2 on a usage or
 * git error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LEVELS = ['low', 'medium', 'high'];
const CONFIG_PATH = path.join(__dirname, 'risk-signals.json');

// ── helpers ────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFailure) return null;
    fail(`git ${args.join(' ')} failed: ${err.message}`);
  }
  return null;
}

function levelFromWeight(weight) {
  return LEVELS[Math.min(Math.max(weight, 1), LEVELS.length) - 1];
}

function maxLevel(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

/**
 * Translate a glob into a regex anchored at both ends.
 * `**\/` matches zero or more leading segments, `**` crosses segments,
 * `*` stays inside one segment, `?` is a single non-separator character.
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const rest = glob.slice(i);
    if (rest.startsWith('**/')) {
      out += '(?:[^/]+/)*';
      i += 2;
    } else if (rest.startsWith('**')) {
      out += '.*';
      i += 1;
    } else {
      const ch = glob[i];
      if (ch === '*') out += '[^/]*';
      else if (ch === '?') out += '[^/]';
      else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function compilePatterns(patterns) {
  return patterns.map((p) => globToRegExp(p));
}

function matchesAny(compiled, filePath) {
  return compiled.some((re) => re.test(filePath));
}

// ── argument parsing ───────────────────────────────────────────────────────

/**
 * `--base`/`--head` reach `git rev-parse` as positional arguments, where a
 * value starting with `-` would be read as an option instead of a revision.
 */
function refArg(flag, value) {
  if (value.startsWith('-')) fail(`${flag} must be a commit or ref, not an option: ${value}`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    base: null,
    head: 'HEAD',
    outDir: 'pr-risk',
    maxDiffBytes: 200000,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--base') opts.base = refArg(arg, next());
    else if (arg === '--head') opts.head = refArg(arg, next());
    else if (arg === '--out-dir') opts.outDir = next();
    else if (arg === '--max-diff-bytes') opts.maxDiffBytes = Number(next());
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  if (!Number.isFinite(opts.maxDiffBytes) || opts.maxDiffBytes <= 0) {
    fail('--max-diff-bytes must be a positive number');
  }
  return opts;
}

/** Resolve the base commit when the caller did not pass one. */
function resolveBase(head) {
  for (const candidate of ['origin/main', 'main', 'origin/HEAD']) {
    const mergeBase = git(['merge-base', candidate, head], { allowFailure: true });
    if (mergeBase && mergeBase.trim()) return mergeBase.trim();
  }
  const parent = git(['rev-parse', `${head}^`], { allowFailure: true });
  return parent && parent.trim() ? parent.trim() : null;
}

// ── changeset collection ───────────────────────────────────────────────────

/**
 * Parse `git diff --name-status -z` output: `CODE\0path\0` per entry, or
 * `R100\0old\0new\0` for renames and copies. Returns a map keyed on the new path.
 */
function parseNameStatusZ(output) {
  const tokens = output.split('\0');
  const byPath = new Map();
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) {
      i += 1;
      continue;
    }
    const twoPaths = code[0] === 'R' || code[0] === 'C';
    const oldPath = twoPaths ? tokens[i + 1] : null;
    const filePath = twoPaths ? tokens[i + 2] : tokens[i + 1];
    i += twoPaths ? 3 : 2;
    if (filePath === undefined) break;
    byPath.set(filePath, { status: code[0], oldPath });
  }
  return byPath;
}

/**
 * Parse `git diff --numstat -z` output. A normal entry is `ins\tdel\tpath\0`;
 * a rename or copy is `ins\tdel\t\0old\0new\0` — the empty path field says two
 * NUL-terminated paths follow. Without `-z`, git prints renames as
 * `{a => .github/workflows}/f.txt` and C-quotes unusual names, and neither of
 * those strings would match a sensitive-path glob.
 */
function parseNumstatZ(output) {
  const tokens = output.split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i += 1;
      continue;
    }
    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      i += 1;
      continue;
    }
    const rawIns = token.slice(0, firstTab);
    const rawDel = token.slice(firstTab + 1, secondTab);
    const inlinePath = token.slice(secondTab + 1);
    let filePath;
    let oldPath = null;
    if (inlinePath) {
      filePath = inlinePath;
      i += 1;
    } else {
      oldPath = tokens[i + 1];
      filePath = tokens[i + 2];
      i += 3;
      if (filePath === undefined) break;
    }
    entries.push({ rawIns, rawDel, filePath, oldPath });
  }
  return entries;
}

function collectFiles(base, head) {
  const range = base ? [`${base}...${head}`] : [head];
  const numstat = git(['diff', '--numstat', '-z', '-M', ...range]) || '';
  const nameStatus = git(['diff', '--name-status', '-z', '-M', ...range]) || '';

  const statusByPath = parseNameStatusZ(nameStatus);

  const files = [];
  for (const { rawIns, rawDel, filePath, oldPath } of parseNumstatZ(numstat)) {
    const known = statusByPath.get(filePath);
    // `-` in the numstat columns means a binary file.
    const binary = rawIns === '-' || rawDel === '-';
    files.push({
      path: filePath,
      // Where a rename or copy came from. Classified too: moving a workflow
      // out of `.github/workflows/` deletes it from there.
      oldPath: oldPath || (known && known.oldPath) || null,
      status: (known && known.status) || (oldPath ? 'R' : 'M'),
      insertions: binary ? 0 : Number(rawIns) || 0,
      deletions: binary ? 0 : Number(rawDel) || 0,
      binary,
      categories: [],
      generated: false,
    });
  }
  return { files, range };
}

/**
 * Tag every file with the categories it matches and settle on one effective
 * weight per file. Matching a low-risk category (tests, docs) wins outright: a
 * file under `vscode-extension/src/test/` is a test first and a host
 * integration second, and scoring it as a host integration would make every
 * test-only PR look medium.
 */
function classify(files, config) {
  const lowRiskIds = new Set(config.lowRiskCategories.ids);
  const categories = config.categories.map((category) => ({
    ...category,
    compiled: compilePatterns(category.paths),
    matched: [],
  }));
  const generated = compilePatterns(config.generatedPaths.paths);

  for (const file of files) {
    // A rename or copy is judged at both ends, each end on its own, and the
    // worse end wins: moving `.github/workflows/x.yml` to `docs/x.yml` removes
    // a workflow, and the low-risk `docs` match on the new path must not hide it.
    // The same goes for the generated flag, which drops a file's churn from the
    // size assessment: renaming hand-written code into `dist/` must not.
    const endPaths = file.oldPath ? [file.path, file.oldPath] : [file.path];
    file.generated = endPaths.every((p) => matchesAny(generated, p));
    const ends = endPaths.map((p) => {
      const matched = categories.filter((category) => matchesAny(category.compiled, p));
      // Kept as its own flag rather than inferred from weight === 1: build
      // tooling and uncategorised files are also weight 1, and they are
      // ordinary reviewable code that must still count towards the size
      // thresholds. Only tests and docs drop out.
      const lowRisk = matched.some((category) => lowRiskIds.has(category.id));
      const weight = lowRisk
        ? 1
        : matched.reduce((highest, category) => Math.max(highest, category.weight), 1);
      return { matched, lowRisk, weight };
    });
    for (const category of categories) {
      if (ends.some((end) => end.matched.includes(category))) {
        file.categories.push(category.id);
        category.matched.push(file.path);
      }
    }
    file.lowRisk = ends.every((end) => end.lowRisk);
    file.effectiveWeight = Math.max(...ends.map((end) => end.weight));
    file.effectiveLevel = levelFromWeight(file.effectiveWeight);
  }

  const byPath = new Map(files.map((file) => [file.path, file]));

  return categories
    .filter((category) => category.matched.length > 0)
    .map((category) => ({
      id: category.id,
      label: category.label,
      weight: category.weight,
      level: levelFromWeight(category.weight),
      why: category.why,
      files: category.matched,
      // Files where this category is what actually sets the level — a category
      // whose every match was downgraded to low is reported but never cited as
      // a reason for the baseline.
      drivingFiles: category.matched.filter(
        (filePath) => (byPath.get(filePath) || {}).effectiveWeight === category.weight
      ),
    }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/**
 * Size only counts lines a reviewer actually has to reason about: generated
 * files, binaries, and anything the low-risk categories claimed (tests, docs)
 * are excluded, so a 2,000-line markdown diff never reads as a 2,000-line
 * review.
 */
function sizeAssessment(files, thresholds) {
  const handWritten = files.filter(
    (file) => !file.generated && !file.binary && !file.lowRisk
  );
  const changedLines = handWritten.reduce(
    (total, file) => total + file.insertions + file.deletions,
    0
  );
  const reasons = [];
  let level = 'low';

  if (changedLines >= thresholds.highLines) {
    level = 'high';
    reasons.push(
      `${changedLines} reviewable lines changed (>= ${thresholds.highLines})`
    );
  } else if (changedLines >= thresholds.mediumLines) {
    level = 'medium';
    reasons.push(
      `${changedLines} reviewable lines changed (>= ${thresholds.mediumLines})`
    );
  }

  if (handWritten.length >= thresholds.highFiles) {
    level = maxLevel(level, 'high');
    reasons.push(
      `${handWritten.length} reviewable files touched (>= ${thresholds.highFiles})`
    );
  } else if (handWritten.length >= thresholds.mediumFiles) {
    level = maxLevel(level, 'medium');
    reasons.push(
      `${handWritten.length} reviewable files touched (>= ${thresholds.mediumFiles})`
    );
  }

  return { level, changedLines, reviewableFiles: handWritten.length, reasons };
}

/**
 * The mechanical floor: the worst of the size assessment and the per-file
 * levels. Only categories that actually drive a file's level are cited, so a
 * signal whose every match was downgraded to low (say, a README inside `cli/`)
 * shows up in the report without inflating the baseline.
 */
function computeBaseline(signals, size, files) {
  const reasons = [...size.reasons];
  let level = size.level;

  for (const file of files) {
    level = maxLevel(level, file.effectiveLevel);
  }

  for (const signal of signals) {
    if (signal.level !== 'low' && signal.drivingFiles.length > 0) {
      reasons.push(`${signal.label} touched (${signal.drivingFiles.length} file(s))`);
    }
  }

  if (reasons.length === 0) {
    reasons.push(
      files.length === 0
        ? 'empty changeset'
        : 'small changeset in low-risk areas'
    );
  }

  return { level, reasons };
}

// ── rendering ──────────────────────────────────────────────────────────────

// Characters a file name can carry that would render as nothing, reorder the
// text around them, or break the line: shown as visible `\u{…}` escapes so the
// reviewer, the step summary and the model all see the same name. `|` and `\`
// are written the same way: a pipe splits a table row even inside a code span,
// and the usual `\|` escape can be cancelled by a backslash in the name itself
// (`a\|b` -> `a\\|b`). A visible escape has neither problem, and escaping both
// in one pass means no step ever adds a backslash that a later step re-reads.
const ESCAPE_IN_NAMES =
  /[\\|\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFE00-\uFE0F]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * Render an author-controlled file name as an inline code span that is safe
 * inside a Markdown table row. The PR author picks every byte of a file name,
 * so it may contain backticks (closing our span early and letting the rest
 * render as Markdown), pipes (splitting the row), backslashes, newlines, or
 * invisible and bidirectional characters.
 */
function codeSpan(value) {
  const text = String(value).replace(
    ESCAPE_IN_NAMES,
    (ch) => `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`
  );
  // A code span is closed by a backtick run of the same length as its opener,
  // so open with one longer than any run inside.
  const longestRun = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  // CommonMark strips one space from each end of a code span whose content
  // starts AND ends with a space (` foo ` renders as `foo`), and a backtick at
  // either end would merge with the fence. Padding with one more space on each
  // side survives that stripping, so the name renders exactly. A name made
  // only of spaces is left alone: CommonMark does not strip those.
  const edgeSpace = /^ | $/.test(text) && /[^ ]/.test(text);
  const pad = text.startsWith('`') || text.endsWith('`') || edgeSpace ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function renderMarkdown(changeset) {
  const { stats, signals, size, baseline, files, diff } = changeset;
  const lines = [];

  lines.push('# Changeset facts');
  lines.push('');
  lines.push(`- Range: \`${changeset.range}\``);
  lines.push(
    `- Files changed: **${stats.files}** (${stats.reviewableFiles} reviewable, ` +
      `${stats.generatedFiles} generated, ${stats.binaryFiles} binary)`
  );
  lines.push(`- Lines: **+${stats.insertions} / -${stats.deletions}**`);
  lines.push(
    `- Reviewable lines changed: **${size.changedLines}** → size level \`${size.level}\`` +
      ' (tests, docs, generated files and binaries excluded)'
  );
  lines.push(`- Heuristic baseline: **${baseline.level.toUpperCase()}**`);
  for (const reason of baseline.reasons) lines.push(`  - ${reason}`);
  lines.push('');

  lines.push('## Sensitive areas touched');
  lines.push('');
  if (signals.length === 0) {
    lines.push('_None matched._');
  } else {
    lines.push('| Level | Area | Files | Why it matters |');
    lines.push('| --- | --- | --- | --- |');
    for (const signal of signals) {
      const sample = signal.files.slice(0, 4).map(codeSpan).join(', ');
      const more =
        signal.files.length > 4 ? `, +${signal.files.length - 4} more` : '';
      lines.push(
        `| ${signal.level} | ${signal.label} | ${sample}${more} | ${signal.why} |`
      );
    }
  }
  lines.push('');

  lines.push('## Files');
  lines.push('');
  lines.push('| Status | File | +/- | Level | Areas |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const file of files) {
    const tags = file.categories.length ? file.categories.join(', ') : '—';
    const churn = file.binary ? 'binary' : `+${file.insertions}/-${file.deletions}`;
    const name = file.oldPath
      ? `${codeSpan(file.path)} (from ${codeSpan(file.oldPath)})`
      : codeSpan(file.path);
    lines.push(
      `| ${file.status} | ${name} | ${churn} | ${file.effectiveLevel} | ${tags} |`
    );
  }
  lines.push('');

  if (diff.truncated) {
    lines.push(
      `> Note: \`changeset.diff\` was truncated at ${diff.bytesWritten} of ` +
        `${diff.bytesTotal} bytes. Read the files directly for anything the diff cut off.`
    );
    lines.push('');
  }

  return lines.join('\n');
}

// ── main ───────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  const head = git(['rev-parse', '--verify', `${opts.head}^{commit}`]).trim();
  const base = opts.base
    ? git(['rev-parse', '--verify', `${opts.base}^{commit}`]).trim()
    : resolveBase(head);

  const { files, range } = collectFiles(base, head);
  const signals = classify(files, config);
  const size = sizeAssessment(files, config.sizeThresholds);
  const baseline = computeBaseline(signals, size, files);

  const stats = {
    files: files.length,
    reviewableFiles: size.reviewableFiles,
    generatedFiles: files.filter((f) => f.generated).length,
    binaryFiles: files.filter((f) => f.binary).length,
    insertions: files.reduce((total, f) => total + f.insertions, 0),
    deletions: files.reduce((total, f) => total + f.deletions, 0),
  };

  fs.mkdirSync(opts.outDir, { recursive: true });

  const rawDiff = base
    ? git(['diff', '-M', `${base}...${head}`]) || ''
    : git(['show', '--format=', head]) || '';
  const diffBuffer = Buffer.from(rawDiff, 'utf8');
  const truncated = diffBuffer.length > opts.maxDiffBytes;
  const diffOut = truncated
    ? `${diffBuffer.subarray(0, opts.maxDiffBytes).toString('utf8')}\n\n... diff truncated at ${opts.maxDiffBytes} bytes ...\n`
    : rawDiff;
  fs.writeFileSync(path.join(opts.outDir, 'changeset.diff'), diffOut, 'utf8');

  const changeset = {
    generatedBy: 'pr-risk-review/collect-changeset.js',
    configVersion: config.version,
    base,
    head,
    range: base ? `${base}...${head}` : head,
    stats,
    size,
    signals,
    baseline,
    files,
    diff: {
      path: path.join(opts.outDir, 'changeset.diff'),
      truncated,
      bytesTotal: diffBuffer.length,
      bytesWritten: Buffer.byteLength(diffOut, 'utf8'),
    },
  };

  fs.writeFileSync(
    path.join(opts.outDir, 'changeset.json'),
    `${JSON.stringify(changeset, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(opts.outDir, 'changeset.md'),
    `${renderMarkdown(changeset)}\n`,
    'utf8'
  );

  if (opts.json) {
    console.log(JSON.stringify(changeset, null, 2));
  } else {
    console.log(
      `Changeset: ${stats.files} file(s), +${stats.insertions}/-${stats.deletions}, ` +
        `baseline ${baseline.level.toUpperCase()} → ${opts.outDir}/`
    );
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  globToRegExp,
  levelFromWeight,
  maxLevel,
  parseNumstatZ,
  parseNameStatusZ,
  classify,
  codeSpan,
  refArg,
};
