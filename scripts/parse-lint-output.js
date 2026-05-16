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

let md = '## 📊 Complexity Analysis\n\n';

// Summary row
md += `| ESLint Errors | ESLint Warnings | Complexity Violations |\n`;
md += `|:-------------:|:---------------:|:---------------------:|\n`;
md += `| ${totalErrors} | ${totalWarnings} | ${violations.length} |\n\n`;

if (violations.length === 0) {
  md += '✅ No complexity violations found.\n';
} else {
  // Sort by rule type, then file, then line number
  violations.sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line
  );

  md += '| Type | File | Line | Details |\n';
  md += '|------|------|:----:|---------|\n';

  for (const v of violations) {
    const label = RULE_LABELS[v.rule] ?? v.rule;
    const icon  = v.severity === 2 ? '❌' : '⚠️';
    md += `| ${icon} ${label} | \`${v.file}\` | ${v.line} | ${v.message} |\n`;
  }

  md += '\n';
}

process.stdout.write(md);
