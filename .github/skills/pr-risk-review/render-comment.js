#!/usr/bin/env node
/**
 * Validate a risk verdict and render the pull-request comment for it.
 *
 * The verdict JSON is written by whichever agent ran the `pr-risk-review`
 * skill, so it is model output over an untrusted diff and is treated as such:
 * the schema is enforced here, every string is sanitised, and anything the
 * model did not supply is dropped rather than passed through. The rendered
 * comment is therefore the same shape whether Claude Code, the Copilot CLI, or
 * the heuristic fallback produced it.
 *
 * Usage:
 *   node .github/skills/pr-risk-review/render-comment.js [options]
 *
 * Options:
 *   --changeset <file>  changeset.json from collect-changeset.js.
 *                       Default: pr-risk/changeset.json
 *   --verdict <file>    verdict.json written by the reviewing agent.
 *                       Default: pr-risk/verdict.json
 *   --out <file>        Where to write the comment. Default: pr-risk/comment.md
 *   --fallback          If the verdict is missing or invalid, fall back to the
 *                       heuristic baseline instead of failing. The comment says
 *                       so explicitly.
 *   --run-url <url>     Workflow run URL to link from the comment footer.
 *   --marker <string>   HTML marker that makes the comment stickily updatable.
 *                       Default: pr-risk-review
 *
 * Exit codes: 0 when a comment was rendered, 1 when the verdict was unusable
 * and --fallback was not given, 2 on a usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = ['low', 'medium', 'high'];
const LEVEL_EMOJI = { low: '🟢', medium: '🟡', high: '🔴' };
const MAX_SUMMARY_CHARS = 2400;
const MAX_FIELD_CHARS = 400;
const MAX_FACTORS = 8;
const MAX_RECOMMENDATIONS = 8;

// Invisible characters that make text read differently to a human reviewer than
// to a model — the same classes `.github/workflows/validate-input.sh` rejects on
// the way in, stripped here on the way out. Soft hyphen, combining grapheme
// joiner, the Arabic letter mark, the Mongolian vowel separator, word joiners,
// invisible operators and the deprecated format controls are included too:
// each renders as nothing, so each can hide a character between two others.
const BIDI_AND_INVISIBLE = new RegExp(
  '[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFE00-\uFE0F]',
  'g'
);
const UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/gu;
const VARIATION_SELECTORS_SUPPLEMENT = /[\u{E0100}-\u{E01EF}]/gu;
// Every line ending Markdown or a browser may honour is folded to `\n` before
// anything else, because sanitizeLine() and cell() only collapse `\n`: a bare
// `\r` (which CommonMark treats as a line ending) would otherwise survive both
// and let a factor or recommendation break out of its table row or list item.
// U+2028/U+2029 are folded too; U+0085 (NEL) goes with the C1 controls below.
const LINE_ENDINGS = /\r\n?|[\u2028\u2029]/g;
// C0 and C1 controls other than tab and newline (carriage returns are already
// folded into newlines by LINE_ENDINGS).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

/**
 * Strip everything that could turn model output over an untrusted diff into
 * markup, hidden instructions, or notification spam once posted to a PR:
 * HTML comments (which would also let the model forge our sticky marker),
 * raw HTML tags, Markdown links and images, invisible/bidi control characters,
 * and @mentions.
 *
 * Order matters. Invisible and control characters go FIRST: every later step
 * matches on adjacent characters, so removing a zero-width space after them
 * would splice `<` + U+200B + `!-- marker -->` back into a live
 * `<!-- marker -->` (and `<` + U+200B + `img>` into a real tag) after the HTML
 * steps had already passed it as harmless text.
 */
function sanitize(value, maxChars) {
  if (typeof value !== 'string') return '';
  let text = value
    .replace(LINE_ENDINGS, '\n')
    .replace(BIDI_AND_INVISIBLE, '')
    .replace(UNICODE_TAGS, '')
    .replace(VARIATION_SELECTORS_SUPPLEMENT, '')
    .replace(CONTROL_CHARS, '')
    // A space, not nothing, so removing a comment can never join the
    // characters either side of it into new markup.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Any `<` that could open a tag, comment, declaration or processing
    // instruction, or an autolink such as `<https://...>`, is escaped.
    .replace(/<(?=[!?/a-zA-Z])/g, '&lt;')
    // Neutralise mentions and issue cross-references so a review never pings a
    // person or back-links into an unrelated issue.
    .replace(/(^|[^\w`])@([A-Za-z0-9][-A-Za-z0-9]*)/g, '$1`@$2`')
    .replace(/(^|[^\w`])#(\d+)/g, '$1`#$2`')
    // `[` opens every link, image (`![`), reference definition and footnote,
    // so encoding it as an entity disables all of them while it still renders
    // as `[`. An entity rather than `\[`, because cell() doubles backslashes
    // and would turn `\[` back into a live bracket inside a table. It runs
    // after the `#123` step, which would otherwise wrap the entity's `#91`.
    .replace(/\[/g, '&#91;')
    .trim();
  if (text.length > maxChars) text = `${truncateOutsideEscapes(text, maxChars - 1).trimEnd()}…`;
  return text;
}

// The escapes sanitize() itself writes: a wrapped `@mention` or `#123`, and an
// HTML entity such as `&lt;` or `&#91;`.
const SANITIZER_ESCAPES = /`[@#][^`\s]*`|&#?[A-Za-z0-9]+;/g;

/**
 * Cut `text` to at most `limit` characters without splitting one of
 * sanitize()'s own escapes. Cutting `` `@bob` `` after its opening backtick
 * would leave an unmatched backtick, which is not a code span, so the mention
 * would be live again; when the limit falls inside an escape, the cut moves
 * back to where that escape starts.
 */
function truncateOutsideEscapes(text, limit) {
  let cut = limit;
  for (const match of text.matchAll(SANITIZER_ESCAPES)) {
    const start = match.index;
    if (start >= cut) break;
    if (start + match[0].length > cut) {
      cut = start;
      break;
    }
  }
  return text.slice(0, cut);
}

function sanitizeLine(value, maxChars) {
  return sanitize(value, maxChars).replace(/\s*\n+\s*/g, ' ');
}

/**
 * Cell text for a markdown table: pipes and newlines would break the row.
 * Backslashes are escaped first, or a value ending in one would consume the
 * escape we add to the pipe after it (`a\|b` → `a\\|b`) and split the row
 * anyway — the exact case CodeQL flags as incomplete string escaping.
 */
function cell(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n+\s*/g, ' ');
}

function normalizeLevel(value) {
  const level = String(value || '')
    .trim()
    .toLowerCase();
  return LEVELS.includes(level) ? level : null;
}

function parseArgs(argv) {
  const opts = {
    changeset: path.join('pr-risk', 'changeset.json'),
    verdict: path.join('pr-risk', 'verdict.json'),
    out: path.join('pr-risk', 'comment.md'),
    fallback: false,
    runUrl: '',
    marker: 'pr-risk-review',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--changeset') opts.changeset = next();
    else if (arg === '--verdict') opts.verdict = next();
    else if (arg === '--out') opts.out = next();
    else if (arg === '--fallback') opts.fallback = true;
    else if (arg === '--run-url') opts.runUrl = next();
    else if (arg === '--marker') opts.marker = next();
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  return opts;
}

/**
 * Read the verdict and coerce it into the shape the renderer expects.
 * Returns `{ verdict }` or `{ problem }` — never a partially-trusted object.
 */
function loadVerdict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { problem: `no verdict file at ${file}` };
  }

  // Agents sometimes wrap JSON in a ```json fence despite being told not to.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { problem: `verdict is not valid JSON (${err.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { problem: 'verdict is not a JSON object' };
  }

  const level = normalizeLevel(parsed.risk);
  if (!level) {
    return { problem: `verdict.risk must be one of ${LEVELS.join(', ')}` };
  }
  const summary = sanitize(parsed.summary, MAX_SUMMARY_CHARS);
  if (!summary) return { problem: 'verdict.summary is empty' };

  const factors = (Array.isArray(parsed.factors) ? parsed.factors : [])
    .slice(0, MAX_FACTORS)
    .map((factor) => ({
      level: normalizeLevel(factor && factor.level) || level,
      title: sanitizeLine((factor && factor.title) || '', 120),
      detail: sanitizeLine((factor && factor.detail) || '', MAX_FIELD_CHARS),
    }))
    .filter((factor) => factor.title || factor.detail);

  const recommendations = (
    Array.isArray(parsed.recommendations) ? parsed.recommendations : []
  )
    .slice(0, MAX_RECOMMENDATIONS)
    .map((item) => sanitizeLine(String(item), MAX_FIELD_CHARS))
    .filter(Boolean);

  return {
    verdict: {
      risk: level,
      summary,
      factors,
      recommendations,
      confidence: normalizeLevel(parsed.confidence),
      source: 'agent',
    },
  };
}

/** Build a verdict from the mechanical baseline when the agent produced none. */
function fallbackVerdict(changeset, problem) {
  const { baseline, stats, signals } = changeset;
  const summary =
    `The AI review did not produce a usable verdict (${problem}), so this level ` +
    `comes from the repository's mechanical risk signals alone: ` +
    `${stats.files} file(s) changed, +${stats.insertions}/-${stats.deletions} lines. ` +
    `Treat it as a floor, not a review — a human still needs to read the diff.`;
  return {
    risk: baseline.level,
    // Same caps and sanitising as the agent path: this content comes from
    // risk-signals.json rather than a model, but a comment that silently grows
    // past the documented limits on the failure path is its own bug.
    summary: sanitize(summary, MAX_SUMMARY_CHARS),
    factors: signals.slice(0, MAX_FACTORS).map((signal) => ({
      level: signal.level,
      title: sanitizeLine(signal.label, 120),
      detail: sanitizeLine(
        `${signal.files.length} file(s) matched. ${signal.why}`,
        MAX_FIELD_CHARS
      ),
    })),
    recommendations: [
      'Review the changeset manually — no AI reasoning backs this label.',
      'Re-run the PR Risk Review workflow once the underlying failure is fixed.',
    ].slice(0, MAX_RECOMMENDATIONS),
    confidence: 'low',
    source: 'heuristic',
  };
}

function render(verdict, changeset, opts) {
  const { stats, baseline, signals } = changeset;
  const lines = [];

  lines.push(`<!-- ${opts.marker} -->`);
  lines.push(
    `## ${LEVEL_EMOJI[verdict.risk]} PR risk review — **${verdict.risk.toUpperCase()}**`
  );
  lines.push('');
  lines.push(verdict.summary);
  lines.push('');

  if (verdict.factors.length > 0) {
    lines.push('### What drives the level');
    lines.push('');
    lines.push('| Level | Factor | Detail |');
    lines.push('| --- | --- | --- |');
    for (const factor of verdict.factors) {
      lines.push(
        `| ${LEVEL_EMOJI[factor.level]} ${factor.level} | ${cell(factor.title) || '—'} | ${cell(factor.detail) || '—'} |`
      );
    }
    lines.push('');
  }

  if (verdict.recommendations.length > 0) {
    lines.push('### Suggested checks before merge');
    lines.push('');
    for (const item of verdict.recommendations) lines.push(`- [ ] ${item}`);
    lines.push('');
  }

  lines.push('<details><summary>Changeset facts</summary>');
  lines.push('');
  lines.push(
    `- **${stats.files}** file(s) changed · **+${stats.insertions} / -${stats.deletions}** lines ` +
      `(${stats.generatedFiles} generated, ${stats.binaryFiles} binary)`
  );
  lines.push(
    `- Mechanical baseline: **${baseline.level}**${
      baseline.cappedBy ? ` (capped: ${baseline.cappedBy})` : ''
    }`
  );
  if (signals.length > 0) {
    lines.push('- Sensitive areas touched:');
    for (const signal of signals) {
      lines.push(
        `  - ${LEVEL_EMOJI[signal.level]} ${signal.label} — ${signal.files.length} file(s)`
      );
    }
  } else {
    lines.push('- Sensitive areas touched: none');
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');

  const footer = [
    verdict.source === 'agent'
      ? 'Generated by the `pr-risk-review` skill'
      : '⚠️ Heuristic fallback — the AI review did not complete',
  ];
  if (verdict.confidence) footer.push(`model confidence: ${verdict.confidence}`);
  if (baseline.level !== verdict.risk) {
    footer.push(`mechanical baseline said \`${baseline.level}\``);
  }
  if (opts.runUrl) footer.push(`[workflow run](${opts.runUrl})`);
  lines.push(
    `<sub>${footer.join(' · ')}. This check is advisory and never blocks a merge.</sub>`
  );

  return `${lines.join('\n')}\n`;
}

function writeGithubOutput(entries) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const payload = Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.appendFileSync(file, `${payload}\n`, 'utf8');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let changeset;
  try {
    changeset = JSON.parse(fs.readFileSync(opts.changeset, 'utf8'));
  } catch (err) {
    fail(`could not read changeset ${opts.changeset}: ${err.message}`);
  }

  const { verdict, problem } = loadVerdict(opts.verdict);
  let finalVerdict = verdict;
  if (!finalVerdict) {
    if (!opts.fallback) {
      console.error(`error: ${problem}`);
      return 1;
    }
    console.error(`warning: ${problem} — falling back to the mechanical baseline`);
    finalVerdict = fallbackVerdict(changeset, problem);
  }

  const comment = render(finalVerdict, changeset, opts);
  fs.mkdirSync(path.dirname(opts.out) || '.', { recursive: true });
  fs.writeFileSync(opts.out, comment, 'utf8');

  writeGithubOutput({
    risk: finalVerdict.risk,
    source: finalVerdict.source,
    baseline: changeset.baseline.level,
    comment_file: opts.out,
  });

  console.log(
    `risk=${finalVerdict.risk} source=${finalVerdict.source} baseline=${changeset.baseline.level} → ${opts.out}`
  );
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { sanitize, sanitizeLine, cell, normalizeLevel, loadVerdict, render };
