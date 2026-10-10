#!/usr/bin/env node
/**
 * Render the pull-request comment for a visual view diff.
 *
 * The `visual-view-diff` skill deliberately stops at `report.json` and the
 * PNGs: deciding what changed visually and telling somebody about it are
 * separate concerns. This is the telling half. It turns the report into a
 * comment body and the list of screenshots to attach to it with
 * `gh pr comment --attach` (GitHub CLI 2.99+), which uploads each file and
 * rewrites the body's `![alt](path)` references to the uploaded asset.
 *
 * Usage:
 *   node .github/workflows/scripts/visual-diff-comment.js [options]
 *
 * Options:
 *   --report <file>       report.json from diff-screenshots.js.
 *                         Default: visual-output/diff/report.json
 *   --screenshots <dir>   Root holding baseline/, current/ and diff/. The
 *                         attachment paths are written relative to the current
 *                         directory, so the caller runs `gh` from that same
 *                         directory. Default: visual-output
 *   --out-dir <dir>       Where to write the outputs. Default: visual-comment
 *   --marker <string>     HTML marker that makes the comment findable for
 *                         replacement. Default: visual-view-diff
 *   --run-url <url>       Workflow run URL to link from the footer.
 *   --artifact <name>     Name of the uploaded screenshots artifact, for the
 *                         footer and the no-images fallback.
 *   --base <sha>          Baseline commit, shown in the header.
 *   --max-attachments <n> Attachment budget. gh allows 50 per command; the
 *                         default leaves a little headroom. Default: 48
 *
 * Outputs (in --out-dir):
 *   comment.md        body with inline image references, for `gh pr comment
 *                     --attach`
 *   comment-plain.md  the same body without images, for a token that cannot
 *                     upload (the Actions installation token cannot)
 *   attachments.txt   one `<path>#<alt text>` per line, in the order they are
 *                     referenced, ready to be passed as `--attach` values
 *
 * When GITHUB_OUTPUT is set, `has_report`, `has_changes` and `attachments` are
 * appended to it so the workflow can decide whether to post at all.
 *
 * Exit codes: 0 always on a rendered or deliberately empty result, 2 on a
 * usage error. A missing report is not an error — the diff step may have
 * failed, and that is already visible on the job.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATUS_LABEL = {
  changed: '🎨 changed',
  unchanged: '⚪ unchanged',
  added: '🆕 added',
  removed: '🗑️ removed',
};

function parseArgs(argv) {
  const opts = {
    report: path.join('visual-output', 'diff', 'report.json'),
    screenshots: 'visual-output',
    outDir: 'visual-comment',
    marker: 'visual-view-diff',
    runUrl: '',
    artifact: 'webview-screenshots',
    base: '',
    maxAttachments: 48,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`${arg} needs a value`);
        process.exit(2);
      }
      return value;
    };
    if (arg === '--report') opts.report = next();
    else if (arg === '--screenshots') opts.screenshots = next();
    else if (arg === '--out-dir') opts.outDir = next();
    else if (arg === '--marker') opts.marker = next();
    else if (arg === '--run-url') opts.runUrl = next();
    else if (arg === '--artifact') opts.artifact = next();
    else if (arg === '--base') opts.base = next().replace(/[^0-9a-f]/gi, '');
    else if (arg === '--max-attachments') opts.maxAttachments = Number(next());
    else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }
  opts.marker = safeId(opts.marker);
  opts.artifact = safeId(opts.artifact);
  if (opts.runUrl && !/^https:\/\/[A-Za-z0-9./_-]+$/.test(opts.runUrl)) {
    console.error('--run-url must be a plain https URL');
    process.exit(2);
  }
  if (!Number.isInteger(opts.maxAttachments) || opts.maxAttachments < 0 || opts.maxAttachments > 50) {
    console.error('--max-attachments must be a whole number between 0 and 50 (gh attaches at most 50 files)');
    process.exit(2);
  }
  return opts;
}

/** Human titles for view and state ids, from the same registry the render uses. */
function loadTitles() {
  const configPath = path.join(__dirname, '..', '..', 'skills', 'visual-view-diff', 'views.config.json');
  const titles = new Map();
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const view of config.views || []) {
      titles.set(safeId(view.id), safeText(view.title || view.id));
      for (const state of view.states || []) {
        titles.set(`${safeId(view.id)}--${safeId(state.id)}`, safeText(state.title || state.id));
      }
    }
  } catch {
    // The registry is a nicety here; ids are readable enough on their own.
  }
  return titles;
}

/**
 * Alt text travels on the `--attach` value after a `#`, so it must not contain
 * one, and gh refuses alt text that would not render safely inside an image.
 * Letters, digits, spaces and a few separators are all a label needs.
 */
function safeAlt(text) {
  return String(text).replace(/[^A-Za-z0-9 ,.:_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Everything rendered into the comment comes from files the PR controls —
 * views.config.json, report.json — and the comment is posted by a privileged
 * identity. So nothing from those files may carry markup, a table pipe, a
 * mention, a link or our own sticky marker into the body. Ids get a strict
 * allowlist; titles keep readable punctuation and lose anything that means
 * something to Markdown or HTML.
 */
function safeId(text) {
  return String(text).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
}

function safeText(text) {
  return String(text)
    .replace(/[<>|`\\[\]()@#*_~\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function formatPercent(value) {
  // normalizeComparison always yields a number; this keeps a caller that
  // skips it from failing the whole comment on a missing value.
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0%';
  if (value < 0.01) return '<0.01%';
  return `${value.toFixed(2)}%`;
}

function formatChange(c) {
  return `${formatPercent(c.changedPercent)} (${Number(c.changedPixels).toLocaleString('en-US')} px)`;
}

/** `usage` or `usage--tools`, the screenshot's identity across the report. */
function key(c) {
  return c.state ? `${c.view}--${c.state}` : c.view;
}

/**
 * One comparison from report.json with every field this script renders
 * reduced to something safe to put in a comment. Numbers are coerced, strings
 * are allowlisted, and anything else is dropped.
 */
function normalizeComparison(raw) {
  const theme = raw.theme === 'light' ? 'light' : 'dark';
  const status = ['changed', 'unchanged', 'added', 'removed'].includes(raw.status) ? raw.status : 'unchanged';
  const size = (v) => (typeof v === 'string' && /^\d+×\d+$/.test(v) ? v : '');
  const file = (v) => (typeof v === 'string' ? path.posix.basename(v) : '');
  return {
    view: safeId(raw.view || ''),
    state: raw.state ? safeId(raw.state) : null,
    theme,
    status,
    changedPixels: Number.isFinite(raw.changedPixels) ? Math.max(0, Math.floor(raw.changedPixels)) : 0,
    changedPercent: Number.isFinite(raw.changedPercent) ? Math.max(0, raw.changedPercent) : 0,
    resized: raw.resized === true,
    baselineSize: size(raw.baselineSize),
    currentSize: size(raw.currentSize),
    baseline: file(raw.baseline),
    current: file(raw.current),
    diff: file(raw.diff),
  };
}

/**
 * Resolves a screenshot for attaching. The path is rebuilt from the report's
 * *basename* only, then resolved on disk and required to be a regular file
 * inside the screenshots root — never a symlink, never `../`, never an
 * absolute path smuggled through report.json. A file that fails any of that
 * is simply not attached; the report still lists the view.
 */
function resolveAttachment(rootDir, subDir, fileName) {
  if (!fileName || !/^[A-Za-z0-9_.-]+\.png$/.test(fileName) || fileName.includes('..')) {
    return null;
  }
  const relative = path.posix.join(rootDir, subDir, fileName);
  let real;
  try {
    if (fs.lstatSync(relative).isSymbolicLink()) { return null; }
    real = fs.realpathSync(relative);
    if (!fs.statSync(real).isFile()) { return null; }
  } catch {
    return null;
  }
  const rootReal = (() => { try { return fs.realpathSync(rootDir); } catch { return null; } })();
  if (!rootReal || !real.startsWith(rootReal + path.sep)) {
    return null;
  }
  return relative;
}

function describe(c, titles) {
  const viewTitle = titles.get(c.view) || c.view;
  const stateTitle = c.state ? titles.get(key(c)) || c.state : null;
  return stateTitle ? `${viewTitle} › ${stateTitle}` : viewTitle;
}

/**
 * Decides which screenshots ride along inline. Views are prioritized by their
 * largest change, with light before dark within each view, and a changed view
 * takes its before, after and diff together or not at all — two of the three
 * tell a reviewer less than none. Whatever does not fit is still in the table
 * and the artifact.
 */
function planAttachments(comparisons, roots, budget, titles) {
  const interesting = comparisons.filter((c) => c.status !== 'unchanged');
  const themeOrder = { light: 0, dark: 1 };
  const groups = new Map();
  for (const c of interesting) {
    const groupKey = key(c);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(c);
  }
  const ordered = [...groups.values()]
    .sort((a, b) =>
      Math.max(...b.map((c) => c.changedPixels || 0)) -
      Math.max(...a.map((c) => c.changedPixels || 0)) ||
      key(a[0]).localeCompare(key(b[0])))
    .flatMap((group) => group.sort((a, b) =>
      (themeOrder[a.theme] ?? 2) - (themeOrder[b.theme] ?? 2) ||
      (b.changedPixels || 0) - (a.changedPixels || 0)));

  const attachments = [];
  const inline = new Map();
  for (const c of ordered) {
    const label = `${describe(c, titles)} ${c.theme}`;
    const files = [];
    if (c.status === 'changed') {
      // A changed row always has a diff image; one without is malformed and
      // is not attached at all rather than as a before/after pair.
      files.push({ kind: 'Before', file: resolveAttachment(roots.root, 'baseline', c.baseline), alt: `Before: ${label}` });
      files.push({ kind: 'After', file: resolveAttachment(roots.root, 'current', c.current), alt: `After: ${label}` });
      files.push({ kind: 'Diff', file: c.diff ? resolveAttachment(roots.root, 'diff', c.diff) : null, alt: `Diff: ${label}` });
    } else if (c.status === 'added') {
      files.push({ kind: 'After', file: resolveAttachment(roots.root, 'current', c.current), alt: `New view: ${label}` });
    } else if (c.status === 'removed') {
      files.push({ kind: 'Before', file: resolveAttachment(roots.root, 'baseline', c.baseline), alt: `Removed view: ${label}` });
    }
    // A changed view takes before, after and diff together or not at all;
    // one that fails validation drops the whole row from the inline set.
    const present = files.filter((f) => f.file);
    if (present.length !== files.length || present.length === 0) {
      continue;
    }
    if (attachments.length + present.length > budget) {
      continue;
    }
    for (const f of present) attachments.push(f);
    inline.set(`${key(c)}.${c.theme}`, present);
  }
  return { attachments, inline };
}

const image = (f) => `![${f.alt}](${f.file})`;

/**
 * Show the before, after and diff together for each changed view. Sorting by
 * view first keeps light and dark rows together, with light mode first.
 */
function renderImages(lines, shown, plan, titles) {
  const files = (c) => plan.inline.get(`${key(c)}.${c.theme}`);
  if (shown.length === 0) return;
  const themeOrder = { light: 0, dark: 1 };
  const ordered = [...shown].sort((a, b) =>
    key(a).localeCompare(key(b)) ||
    themeOrder[a.theme] - themeOrder[b.theme]);
  const screenshot = (c, kind) => files(c).find((f) => f.kind === kind);
  const cell = (c, kind) => {
    const file = screenshot(c, kind);
    return file ? image(file) : '';
  };

  lines.push('| Name | Before | After | Diff |', '| --- | --- | --- | --- |');
  for (const c of ordered) {
    const name = `**${describe(c, titles)}** (${c.theme} mode)`;
    lines.push(`| ${name} | ${cell(c, 'Before')} | ${cell(c, 'After')} | ${cell(c, 'Diff')} |`);
  }
  const hasDiff = ordered.some((c) => screenshot(c, 'Diff'));
  const legend = hasDiff ? 'Magenta marks changed pixels in the diff. ' : '';
  lines.push('', `<sub>${legend}Click an image for full size.</sub>`, '');
}

function renderBody(report, opts, titles, plan, { withImages }) {
  const { summary, comparisons } = report;
  const lines = [`<!-- ${opts.marker} -->`, '## 📸 Webview screenshots', ''];

  const total = comparisons.length;
  const noChanges = summary.changed === 0 && summary.added === 0 && summary.removed === 0;
  const baseNote = opts.base ? ` against the merge base \`${opts.base.slice(0, 12)}\`` : '';

  if (noChanges) {
    lines.push(`No visual changes: all ${total} view screenshots are pixel-identical${baseNote}.`, '');
  } else {
    const parts = [];
    if (summary.changed) parts.push(`**${summary.changed} changed**`);
    if (summary.added) parts.push(`${summary.added} added`);
    if (summary.removed) parts.push(`${summary.removed} removed`);
    if (summary.unchanged) parts.push(`${summary.unchanged} unchanged`);
    lines.push(`${parts.join(' · ')} of ${total} view screenshots${baseNote}.`, '');

    lines.push('| View | State | Theme | Status | Pixels changed | Size |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of comparisons.filter((x) => x.status !== 'unchanged')) {
      const pixels = c.status === 'changed' ? formatChange(c) : '—';
      const size = c.resized ? `${c.baselineSize} → ${c.currentSize}` : (c.currentSize || c.baselineSize || '—');
      lines.push(`| \`${c.view}\` | ${c.state || 'initial'} | ${c.theme} | ${STATUS_LABEL[c.status] || c.status} | ${pixels} | ${size} |`);
    }
    lines.push('');

    if (withImages && plan.inline.size > 0) {
      renderImages(lines, comparisons.filter((x) => plan.inline.has(`${key(x)}.${x.theme}`)), plan, titles);
      const shown = plan.inline.size;
      const wanted = comparisons.filter((x) => x.status !== 'unchanged').length;
      if (shown < wanted) {
        lines.push(`<sub>${wanted - shown} more changed screenshot(s) did not fit the ${opts.maxAttachments}-image comment budget; they are in the artifact below.</sub>`, '');
      }
    } else if (!withImages) {
      lines.push(`<sub>Before/after/diff images are in the \`${opts.artifact}\` artifact on the workflow run below.</sub>`, '');
    }
  }

  const footer = [];
  footer.push('Rendered headlessly from committed fixtures — the real webview bundles, not a mock-up.');
  if (!noChanges) {
    footer.push('A changed view is not automatically a problem: read the diff and decide whether it is the intended restyle.');
  }
  if (opts.runUrl) {
    footer.push(`Full-size images: the \`${opts.artifact}\` artifact on the [workflow run](${opts.runUrl}).`);
  }
  footer.push('Generated by the `visual-view-diff` harness in CI.');
  lines.push(`<sub>${footer.join(' ')}</sub>`, '');
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });

  const outputs = [];
  const emit = (name, value) => outputs.push(`${name}=${value}`);

  if (!fs.existsSync(opts.report)) {
    console.log(`No report at ${opts.report}; nothing to post.`);
    emit('has_report', 'false');
    emit('has_changes', 'false');
    emit('attachments', '0');
    return finish(outputs);
  }

  const report = JSON.parse(fs.readFileSync(opts.report, 'utf8'));
  const comparisons = (Array.isArray(report.comparisons) ? report.comparisons : [])
    .filter((c) => c && typeof c === 'object')
    .map(normalizeComparison)
    .filter((c) => c.view);
  // Summary counts are recomputed from the rows rather than trusted from the file.
  const summary = {
    changed: comparisons.filter((c) => c.status === 'changed').length,
    unchanged: comparisons.filter((c) => c.status === 'unchanged').length,
    added: comparisons.filter((c) => c.status === 'added').length,
    removed: comparisons.filter((c) => c.status === 'removed').length,
  };
  const titles = loadTitles();
  const roots = { root: opts.screenshots };

  const plan = planAttachments(comparisons, roots, opts.maxAttachments, titles);
  const hasChanges = summary.changed + summary.added + summary.removed > 0;

  fs.writeFileSync(path.join(opts.outDir, 'comment.md'), renderBody({ summary, comparisons }, opts, titles, plan, { withImages: true }));
  fs.writeFileSync(path.join(opts.outDir, 'comment-plain.md'), renderBody({ summary, comparisons }, opts, titles, plan, { withImages: false }));
  fs.writeFileSync(path.join(opts.outDir, 'attachments.txt'),
    plan.attachments.map((f) => `${f.file}#${safeAlt(f.alt)}`).join('\n') + (plan.attachments.length ? '\n' : ''));

  console.log(`${hasChanges ? 'Visual changes found' : 'No visual changes'}: ${summary.changed} changed, ${summary.added} added, ${summary.removed} removed, ${summary.unchanged} unchanged.`);
  console.log(`${plan.attachments.length} screenshot(s) to attach; comment written to ${opts.outDir}/comment.md`);
  emit('has_report', 'true');
  emit('has_changes', String(hasChanges));
  emit('attachments', String(plan.attachments.length));
  return finish(outputs);
}

function finish(outputs) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, outputs.join('\n') + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { planAttachments, renderBody, resolveAttachment, normalizeComparison, safeAlt, safeId, safeText };
