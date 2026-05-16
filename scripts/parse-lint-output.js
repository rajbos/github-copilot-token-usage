#!/usr/bin/env node
'use strict';

/**
 * Parses ESLint JSON output (from `npm run lint:report`) and writes a
 * GitHub Actions step summary in Markdown, focusing on complexity violations.
 *
 * Usage:  node scripts/parse-lint-output.js <lint-output.json>
 * Output: Markdown written to stdout (redirect/append to $GITHUB_STEP_SUMMARY)
 */

const fs = require('fs');

const COMPLEXITY_RULES = new Set([
  'complexity',
  'sonarjs/cognitive-complexity',
  'max-depth',
  'max-lines-per-function',
  'max-params',
]);

const RULE_LABELS = {
  'complexity':                    'Cyclomatic',
  'sonarjs/cognitive-complexity':  'Cognitive',
  'max-depth':                     'Max Depth',
  'max-lines-per-function':        'Lines/Fn',
  'max-params':                    'Max Params',
};

const inputFile = process.argv[2];
let content = '';

if (inputFile && fs.existsSync(inputFile)) {
  try {
    content = fs.readFileSync(inputFile, 'utf8');
  } catch {
    // fall through to empty-content handling below
  }
}

if (!content.trim()) {
  process.stdout.write('## 📊 Complexity Analysis\n\nNo lint output was captured.\n');
  process.exit(0);
}

let results;
try {
  results = JSON.parse(content);
} catch {
  process.stdout.write('## 📊 Complexity Analysis\n\n⚠️ Could not parse lint output as JSON.\n');
  process.exit(0);
}

// Normalise file paths to a short relative form starting at "src/"
function shortenPath(filePath) {
  const match = filePath.replace(/\\/g, '/').match(/src\/.+$/);
  return match ? match[0] : filePath.replace(/\\/g, '/');
}

// Collect all complexity-related warnings
const violations = [];
for (const file of results) {
  const relPath = shortenPath(file.filePath);
  for (const msg of file.messages) {
    if (!COMPLEXITY_RULES.has(msg.ruleId)) { continue; }
    violations.push({
      file: relPath,
      rule: msg.ruleId,
      line: msg.line,
      message: msg.message,
      severity: msg.severity, // 1=warn, 2=error
    });
  }
}

// Count all ESLint errors and warnings across every rule for the totals row
let totalErrors = 0;
let totalWarnings = 0;
for (const file of results) {
  totalErrors   += file.errorCount;
  totalWarnings += file.warningCount;
}

// Extract the complexity number from an ESLint message for ranking
function extractComplexityValue(msg) {
  const m = msg.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

let md = '## 📊 Complexity Analysis\n\n';

// Summary row
md += `| ESLint Errors | ESLint Warnings | Complexity Violations |\n`;
md += `|:-------------:|:---------------:|:---------------------:|\n`;
md += `| ${totalErrors} | ${totalWarnings} | ${violations.length} |\n\n`;

if (violations.length === 0) {
  md += '✅ No complexity violations found.\n';
} else {
  // Top 10 worst violations sorted by complexity value descending
  const top10 = [...violations]
    .sort((a, b) => extractComplexityValue(b.message) - extractComplexityValue(a.message))
    .slice(0, 10);

  md += '### 🔝 Top 10 most complex\n\n';
  md += '| Type | File | Line | Details |\n';
  md += '|------|------|:----:|---------|\n';
  for (const v of top10) {
    const label = RULE_LABELS[v.rule] ?? v.rule;
    const icon  = v.severity === 2 ? '❌' : '⚠️';
    md += `| ${icon} ${label} | \`${v.file}\` | ${v.line} | ${v.message} |\n`;
  }
  md += '\n';

  // Full list in a collapsible block
  const sorted = [...violations].sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line
  );

  md += '<details>\n<summary>All violations</summary>\n\n';
  md += '| Type | File | Line | Details |\n';
  md += '|------|------|:----:|---------|\n';
  for (const v of sorted) {
    const label = RULE_LABELS[v.rule] ?? v.rule;
    const icon  = v.severity === 2 ? '❌' : '⚠️';
    md += `| ${icon} ${label} | \`${v.file}\` | ${v.line} | ${v.message} |\n`;
  }
  md += '\n</details>\n';
}

process.stdout.write(md);
