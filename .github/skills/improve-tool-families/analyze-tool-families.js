#!/usr/bin/env node
/**
 * Analyze coverage of src/toolFamilies.ts (DEFAULT_TOOL_FAMILIES)
 * against the canonical tool-name list in src/toolNames.json, and optionally
 * against a live/adhoc list of tool names (e.g. the current agent's own tool list).
 *
 * Tool family matching in the extension is an EXACT string match against raw
 * tool names as recorded per-editor in session logs (see usageAnalysis.ts /
 * the various src/adapters/*.ts). There is no cross-editor normalization
 * before the match, so every editor-specific spelling of "read a file",
 * "search text", "run a shell command", etc. needs to be listed explicitly
 * in the family it belongs to, or it silently falls into the "Other Tools"
 * bucket in the Tool Output Token Analysis tab.
 *
 * This script finds tool names that exist in toolNames.json (or were passed
 * in via --tools) but are not yet listed in any family's builtIn/alternatives
 * arrays, and suggests which family they likely belong to via keyword
 * heuristics. It does NOT modify toolFamilies.ts automatically -- a human (or
 * agent) should review the suggestions and decide built-in vs. alternative
 * placement, since that distinction is a judgment call the script cannot make
 * reliably.
 *
 * Usage:
 *   node .github/skills/improve-tool-families/analyze-tool-families.js
 *   node .github/skills/improve-tool-families/analyze-tool-families.js --json
 *   node .github/skills/improve-tool-families/analyze-tool-families.js --tools read,view,my_custom_tool
 *
 * Exit codes:
 *   0 - ran successfully (uncovered tools may still exist; see report)
 *   2 - configuration / environment error (source files not found)
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOL_NAMES_JSON = path.join(REPO_ROOT, 'src', 'toolNames.json');
const TOOL_FAMILIES_TS = path.join(REPO_ROOT, 'src', 'toolFamilies.ts');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { json: false, tools: [] };
  for (const arg of argv) {
    if (arg === '--json') { args.json = true; }
    else if (arg === '--help' || arg === '-h') { args.help = true; }
    else if (arg.startsWith('--tools=')) { args.tools = arg.slice('--tools='.length).split(',').map(s => s.trim()).filter(Boolean); }
  }
  return args;
}

function loadToolNamesJson() {
  if (!fs.existsSync(TOOL_NAMES_JSON)) { fail(`Not found: ${TOOL_NAMES_JSON}`); }
  const raw = fs.readFileSync(TOOL_NAMES_JSON, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch (e) { fail(`Failed to parse ${TOOL_NAMES_JSON}: ${e.message}`); }
  return Object.keys(data);
}

/** Extract the DEFAULT_TOOL_FAMILIES array literal from the TS source and eval it as plain JS. */
function loadDefaultToolFamilies() {
  if (!fs.existsSync(TOOL_FAMILIES_TS)) { fail(`Not found: ${TOOL_FAMILIES_TS}`); }
  const src = fs.readFileSync(TOOL_FAMILIES_TS, 'utf8');
  const marker = 'export const DEFAULT_TOOL_FAMILIES: ToolFamily[] = ';
  const start = src.indexOf(marker);
  if (start === -1) { fail(`Could not find DEFAULT_TOOL_FAMILIES in ${TOOL_FAMILIES_TS}`); }
  const arrayStart = src.indexOf('[', start + marker.length);
  // Find the matching closing bracket for the array literal.
  let depth = 0, end = -1;
  for (let i = arrayStart; i < src.length; i++) {
    if (src[i] === '[') { depth++; }
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) { fail('Could not locate end of DEFAULT_TOOL_FAMILIES array literal.'); }
  const literal = src.slice(arrayStart, end + 1);
  // eslint-disable-next-line no-eval -- trusted local source file, plain object/array literal only.
  return eval(literal);
}

/** Keyword heuristics used to suggest a family for an uncovered tool name. */
const FAMILY_KEYWORDS = {
  'code-intelligence': ['error', 'hover', 'reference', 'definition', 'lsp', 'diagnostic', 'symbol', 'usage', 'type_check', 'typecheck'],
  'reading': ['read', 'view', 'cat', 'open_file', 'get_file'],
  'writing': ['write', 'create_file', 'edit', 'replace', 'patch', 'insert', 'delete_file', 'notebook'],
  'search': ['search', 'grep', 'glob', 'find', 'list_dir', 'list_directory', ' ls', 'ls_', '_ls', 'lookup'],
  'shell': ['run', 'terminal', 'bash', 'shell', 'execute', 'command', 'exec'],
  'web': ['web', 'fetch', 'http', 'browser', 'url'],
};

function suggestFamily(toolName) {
  const lower = toolName.toLowerCase();
  for (const [familyId, keywords] of Object.entries(FAMILY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) { return familyId; }
  }
  return null;
}

function normalize(name) { return name.toLowerCase(); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8'));
    return;
  }

  const families = loadDefaultToolFamilies();
  const canonicalNames = loadToolNamesJson();
  const liveNames = args.tools;

  const covered = new Set();
  for (const family of families) {
    for (const name of [...(family.builtIn || []), ...(family.alternatives || [])]) {
      covered.add(normalize(name));
    }
  }

  const candidateNames = Array.from(new Set([...canonicalNames, ...liveNames]));
  const uncovered = candidateNames.filter(n => n !== 'unknown' && !covered.has(normalize(n)));

  const suggestions = {};
  const unclassified = [];
  for (const name of uncovered) {
    const familyId = suggestFamily(name);
    if (familyId) {
      (suggestions[familyId] = suggestions[familyId] || []).push(name);
    } else {
      unclassified.push(name);
    }
  }

  const report = {
    familiesDefined: families.map(f => f.id),
    totalCanonicalNames: canonicalNames.length,
    totalCoveredEntries: covered.size,
    totalUncovered: uncovered.length,
    suggestionsByFamily: suggestions,
    unclassified,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('Tool Family Coverage Report');
  console.log('===========================');
  console.log(`Families defined:        ${report.familiesDefined.join(', ')}`);
  console.log(`Canonical tool names:    ${report.totalCanonicalNames} (src/toolNames.json)`);
  console.log(`Names already covered:   ${report.totalCoveredEntries} (builtIn + alternatives, all families)`);
  console.log(`Uncovered candidates:    ${report.totalUncovered}`);
  console.log('');

  if (Object.keys(suggestions).length > 0) {
    console.log('Suggested additions by family (review builtIn vs. alternative placement manually):');
    for (const [familyId, names] of Object.entries(suggestions)) {
      console.log(`  [${familyId}]`);
      for (const name of names.sort()) { console.log(`    - ${name}`); }
    }
    console.log('');
  }

  if (unclassified.length > 0) {
    console.log('Unclassified (no keyword match - decide manually, or ignore if not a comparable tool):');
    for (const name of unclassified.sort()) { console.log(`  - ${name}`); }
    console.log('');
  }

  if (report.totalUncovered === 0) {
    console.log('All canonical tool names are covered by a family. Nothing to do.');
  } else {
    console.log(`Next step: edit ${path.relative(REPO_ROOT, TOOL_FAMILIES_TS)} to add the tools you want tracked,`);
    console.log('deciding for each whether it is a baseline ("builtIn") tool or a more efficient ("alternatives") one.');
  }
}

main();
