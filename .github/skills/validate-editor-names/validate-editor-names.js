#!/usr/bin/env node
/**
 * validate-editor-names.js
 *
 * Verifies that:
 *  1. Every editor name returned by cli/src/analysis.ts::getEditorSourceFromPath
 *     has an entry in the EDITOR_ICON_MAP in formatUtils.ts.
 *  2. Every editor name returned by src/workspaceHelpers.ts::
 *     getEditorTypeFromPath has an entry in the EDITOR_ICON_MAP.
 *  3. For a canonical set of test paths the CLI and VS Code detectors return
 *     identical friendly names.
 *  4. No broad path pattern shadows a more specific one in the CLI function
 *     (e.g. /.copilot/ before /.copilot/jb/).
 *
 * Exit codes:  0 = all checks pass
 *              1 = one or more checks failed
 *              2 = configuration / environment error (source files not found)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json')  { opts.json  = true; continue; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    process.stderr.write(`Unknown flag: ${a}\n`);
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT              = path.resolve(__dirname, '..', '..', '..');
const CLI_ANALYSIS      = path.join(ROOT, 'cli', 'src', 'analysis.ts');
const WS_HELPERS        = path.join(ROOT, 'src', 'workspaceHelpers.ts');
// The authoritative icon map lives in editorIcons.ts; formatUtils.ts only
// re-exports it for the webview bundles.
const FORMAT_UTILS      = path.join(ROOT, 'vscode-extension', 'src', 'editorIcons.ts');

// ---------------------------------------------------------------------------
// Source file reading
// ---------------------------------------------------------------------------

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`ERROR: File not found: ${filePath}\n`);
    process.exit(2);
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ---------------------------------------------------------------------------
// Extract function body
// ---------------------------------------------------------------------------

/**
 * Extracts the body of a named function from TypeScript source (first match).
 * Works for both `export function foo(` and `function foo(` declarations.
 */
function extractFunctionBody(source, functionName) {
  const startRe = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const startIdx = source.search(startRe);
  if (startIdx === -1) return null;

  // Walk forward to find the opening brace
  let braceIdx = source.indexOf('{', startIdx);
  if (braceIdx === -1) return null;

  let depth = 0;
  let i = braceIdx;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(braceIdx, i + 1);
}

// ---------------------------------------------------------------------------
// Extract return-value names from a function body
// ---------------------------------------------------------------------------

/**
 * Scans all `return 'SomeName'` and `return "SomeName"` statements and
 * collects the unique string values, excluding obvious non-name returns
 * (numbers, undefined, null, booleans, 0, 1).
 */
function extractReturnedNames(body) {
  const names = new Set();
  const re = /\breturn\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const v = m[1];
    // Skip numeric strings or control values
    if (/^\d+$/.test(v)) continue;
    names.add(v);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Extract EDITOR_ICON_MAP keys from formatUtils.ts
// ---------------------------------------------------------------------------

/**
 * Reads formatUtils.ts and extracts the string keys of EDITOR_ICON_MAP.
 */
function extractIconMapKeys(source) {
  const mapMatch = source.match(/EDITOR_ICON_MAP[^=]*=\s*\{([^}]+)\}/s);
  if (!mapMatch) return new Set();
  const body = mapMatch[1];
  const keys = new Set();
  const re = /['"]([^'"]+)['"]\s*:/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Extract ordered includes-patterns → returned name from a function body
// ---------------------------------------------------------------------------

/**
 * For a function body like `if (x.includes('/.copilot/jb/')) { return 'JetBrains'; }`
 * extracts an ordered list of { patterns, name } objects so we can:
 *   a) simulate path detection
 *   b) check ordering invariants
 *
 * Uses balanced-paren extraction so multi-condition (&&) if statements are
 * handled correctly (e.g. the Gemini CLI check uses three sub-conditions).
 */
function extractIncludesRules(body) {
  const rules = [];
  // Find every `return 'Name';` statement, then look backward for its `if (`.
  // `return detectClaudeCodeEditorVariant(...)` is treated as 'Claude Code'
  // (that helper's default) so the /.claude/projects/ rule is still simulated.
  const returnRe = /\breturn\s+(?:'([^']+)'|detectClaudeCodeEditorVariant\([^)]*\))\s*;/g;
  let m;
  while ((m = returnRe.exec(body)) !== null) {
    const name = m[1] ?? 'Claude Code';
    if (/^\d+$/.test(name)) continue; // skip numeric strings

    // Walk outward through the enclosing if-chain: for each `if (` found
    // before the return, extract its condition and block; when the return
    // sits inside that block, the condition guards it too, so accumulate its
    // patterns and keep walking. This makes nested guards like
    // `if (A) { if (B) { return 'X'; } }` simulate correctly.
    const patterns = [];
    let searchFrom = m.index;
    while (true) {
      const before = body.slice(0, searchFrom);
      const ifIdx = Math.max(before.lastIndexOf('if ('), before.lastIndexOf('if('));
      if (ifIdx === -1) break;

      // Use balanced-paren walk to extract the full if condition
      let depth = 0;
      let condStart = -1;
      let condEnd   = -1;
      for (let i = ifIdx + 2; i < body.length; i++) {
        const ch = body[i];
        if (ch === '(') {
          if (depth === 0) condStart = i + 1;
          depth++;
        } else if (ch === ')') {
          depth--;
          if (depth === 0) { condEnd = i; break; }
        }
      }
      if (condStart === -1 || condEnd === -1) break;

      // The if's block must contain the return for its condition to guard it;
      // otherwise this `if (` belongs to a sibling statement.
      const blockStart = body.indexOf('{', condEnd);
      let braceDepth = 0;
      let blockEnd = -1;
      for (let i = blockStart; i < body.length; i++) {
        if (body[i] === '{') braceDepth++;
        else if (body[i] === '}') {
          braceDepth--;
          if (braceDepth === 0) { blockEnd = i; break; }
        }
      }
      if (blockStart === -1 || blockEnd < m.index) break;

      const condition = body.slice(condStart, condEnd);

      // Condition normal form: AND of ORs. Split on '&&' for the required
      // parts, then on '||' inside each part for alternatives. Patterns within
      // one part become a single OR group (match if ANY is present); parts are
      // ANDed (ALL groups must match). '||'-joined alternatives that each
      // contain several '&&'-joined includes are not supported — none exist,
      // and the ordering check would rather under-report than guess.
      const conditionGroups = condition
        .split('&&')
        .map(part => {
          const group = [];
          const incRe = /\.includes\(['"]([^'"]+)['"]\)/g;
          let inc;
          while ((inc = incRe.exec(part)) !== null) {
            group.push(inc[1]);
          }
          return group;
        })
        .filter(group => group.length > 0);
      patterns.push(...conditionGroups);
      searchFrom = ifIdx;
    }
    if (patterns.length > 0) {
      rules.push({ patterns, name });
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Simulate path detection (mirrors includes-based logic)
// ---------------------------------------------------------------------------

/**
 * Given ordered rules, returns the first matching name for a given path.
 * A rule's patterns are AND-of-OR groups: every group must have at least one
 * pattern present in the normalized path (OR within a group, AND across).
 */
function detectEditor(rules, filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  for (const rule of rules) {
    if (rule.patterns.every(group => group.some(p => normalized.includes(p)))) {
      return rule.name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canonical test cases
// ---------------------------------------------------------------------------

const TEST_CASES = [
  // JetBrains — must not be misclassified as Copilot CLI
  {
    path: '/home/user/.copilot/jb/uuid-abc/partition-0.jsonl',
    expected: 'JetBrains',
    label: 'JetBrains partition file'
  },
  // Copilot CLI session-state
  {
    path: '/home/user/.copilot/session-state/uuid-abc/session.jsonl',
    expected: 'Copilot CLI',
    label: 'Copilot CLI session-state'
  },
  // Copilot CLI session-store
  {
    path: '/home/user/.copilot/session-store.db#uuid',
    expected: 'Copilot CLI',
    label: 'Copilot CLI session-store DB'
  },
  // Claude Code
  {
    path: '/home/user/.claude/projects/abc123/session.jsonl',
    expected: 'Claude Code',
    label: 'Claude Code session'
  },
  // VS Code (generic)
  {
    path: '/home/user/.config/Code/User/workspaceStorage/abc/chatSessions/session.json',
    expected: 'VS Code',
    label: 'VS Code chat session'
  },
  // VS Code Insiders
  {
    path: '/home/user/.config/Code - Insiders/User/workspaceStorage/abc/chatSessions/session.json',
    expected: 'VS Code Insiders',
    label: 'VS Code Insiders chat session'
  },
  // VS Code Exploration
  {
    path: '/home/user/.config/Code - Exploration/User/workspaceStorage/abc/chatSessions/session.json',
    expected: 'VS Code Exploration',
    label: 'VS Code Exploration chat session'
  },
  // VSCodium
  {
    path: '/home/user/.config/VSCodium/User/workspaceStorage/abc/chatSessions/session.json',
    expected: 'VSCodium',
    label: 'VSCodium chat session'
  },
  // Cursor
  {
    path: '/home/user/.config/Cursor/User/workspaceStorage/abc/chatSessions/session.json',
    expected: 'Cursor',
    label: 'Cursor chat session'
  },
  // Gemini CLI — must not be misclassified as Antigravity
  {
    path: '/home/user/.gemini/tmp/session-xyz/chats/session-001.jsonl',
    expected: 'Gemini CLI',
    label: 'Gemini CLI session'
  },
  // Antigravity — must not be misclassified as Gemini CLI
  {
    path: '/home/user/.gemini/antigravity/brain/project/.system_generated/logs/transcript.jsonl',
    expected: 'Antigravity',
    label: 'Antigravity session'
  },
  // Continue
  {
    path: '/home/user/.continue/sessions/abc.jsonl',
    expected: 'Continue',
    label: 'Continue session'
  },
  // Crush
  {
    path: '/home/user/.crush/crush.db#rowid',
    expected: 'Crush',
    label: 'Crush DB session'
  },
  // Cline — must not be misclassified as VS Code (path contains /Code/User/)
  {
    path: '/home/user/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/1782681302220/ui_messages.json',
    expected: 'Cline',
    label: 'Cline task session'
  },
  // Mistral Vibe
  {
    path: '/home/user/.vibe/logs/session/session-abc.jsonl',
    expected: 'Mistral Vibe',
    label: 'Mistral Vibe session'
  },
  // Claude Desktop Cowork
  {
    path: '/home/user/Library/Application Support/Claude/local-agent-mode-sessions/abc.jsonl',
    expected: 'Claude Desktop Cowork',
    label: 'Claude Desktop Cowork session'
  },
  // Visual Studio (solution chats live under <solution>/.vs/project/copilot-chat/<hash>/sessions/)
  {
    path: 'C:/Users/user/AppData/Local/Microsoft/VisualStudio/17/.vs/project/copilot-chat/abc/sessions/def.json',
    expected: 'Visual Studio',
    label: 'Visual Studio chat session'
  },
  // Visual Studio solution-less chats (VS AppData VSGitHubCopilot folder) — must
  // not be misclassified as SSMS or fall through to VS Code.
  {
    path: 'C:/Users/user/AppData/Local/Microsoft/VisualStudio/17/vsgithubcopilot/copilot-chat/abc/sessions/def.json',
    expected: 'Visual Studio',
    label: 'Visual Studio solution-less chat session'
  },
  // SSMS Copilot Chat — must keep its own label, not Visual Studio.
  {
    path: 'C:/Users/user/AppData/Local/Microsoft/SQL Server Management Studio/19/ssmsgithubcopilot/copilot-chat/abc/sessions/def.json',
    expected: 'SSMS',
    label: 'SSMS chat session'
  },
  // VS Code Server
  {
    path: '/home/user/.vscode-server/data/User/workspaceStorage/abc/chatSessions/session.json',
    expected: 'VS Code Server',
    label: 'VS Code Server session'
  },
  // VS Code Server (Insiders)
  {
    path: '/home/user/.vscode-server-insiders/data/User/workspaceStorage/abc/chatSessions/session.json',
    expected: 'VS Code Server (Insiders)',
    label: 'VS Code Server (Insiders) session'
  },
  // Eclipse — must not fall through to the CLI's 'VS Code' default
  {
    path: '/home/user/eclipse-workspace/.metadata/.plugins/com.microsoft.copilot.eclipse/conversations/abc.json',
    expected: 'Eclipse',
    label: 'Eclipse Copilot conversation'
  },
  // Pi — the encoded cwd folder can contain 'code'
  {
    path: '/home/user/.pi/agent/sessions/--home-user-code-repo--/2026-09-01T10-00-00_abc.jsonl',
    expected: 'Pi',
    label: 'Pi session'
  },
  // Devin CLI virtual DB path
  {
    path: 'C:/Users/user/AppData/Roaming/devin/cli/sessions.db#sess-123',
    expected: 'Devin CLI',
    label: 'Devin CLI sessions.db'
  },
  // Hermes virtual DB path
  {
    path: 'C:/Users/user/AppData/Local/hermes/state.db#20260726_204744_427b88',
    expected: 'Hermes',
    label: 'Hermes state.db'
  },
  // Codex CLI — 'codex' contains 'code'
  {
    path: '/home/user/.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl',
    expected: 'Codex CLI',
    label: 'Codex CLI rollout'
  },
];

// ---------------------------------------------------------------------------
// Ordering invariant check
// ---------------------------------------------------------------------------

/**
 * Detects pairs of rules where a broad pattern (broadPat) would match any path
 * that also matches a more specific pattern (specificPat), and the broad rule
 * appears first. This causes the specific rule to be unreachable.
 *
 * Checks: if every path that includes specificPat also includes broadPat, and
 * the broad rule comes first, that's a shadow.
 */
function checkOrderingInvariants(rules) {
  const issues = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const broad    = rules[i];
      const specific = rules[j];
      // A broad rule shadows a specific rule when:
      //   - broad has exactly 1 pattern (single group, single alternative)
      //   - specific.patterns includes that broad pattern as a substring prefix
      //   - the two return different names
      if (broad.patterns.length !== 1 || broad.patterns[0].length !== 1) continue;
      const broadPat = broad.patterns[0][0];
      const specificPatterns = specific.patterns.flat();
      const isShadowing = specificPatterns.some(p => p.startsWith(broadPat) && p !== broadPat);
      if (isShadowing && broad.name !== specific.name) {
        issues.push({
          broadPattern:    broadPat,
          broadName:       broad.name,
          specificPattern: specific.patterns.map(g => g.join(' | ')).join(' && '),
          specificName:    specific.name,
          broadIndex:      i,
          specificIndex:   j,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    console.log([
      'Usage: node validate-editor-names.js [--json] [--help]',
      '',
      'Validates that the CLI and VS Code extension return matching friendly',
      'editor names for the same path patterns, and that every name has an',
      'icon in the EDITOR_ICON_MAP.',
      '',
      'Options:',
      '  --json   Emit JSON only (no ANSI colour)',
      '  --help   Show this message',
      '',
      'Exit codes:  0 = all checks pass',
      '             1 = one or more checks failed',
      '             2 = configuration / environment error',
    ].join('\n'));
    process.exit(0);
  }

  // -- Read source files -----------------------------------------------------

  const cliSource        = readFile(CLI_ANALYSIS);
  const wsHelpersSource  = readFile(WS_HELPERS);
  const formatSource     = readFile(FORMAT_UTILS);

  // -- Extract function bodies -----------------------------------------------

  const cliFnBody = extractFunctionBody(cliSource, 'getEditorSourceFromPath');
  if (!cliFnBody) {
    process.stderr.write('ERROR: Could not find getEditorSourceFromPath in analysis.ts\n');
    process.exit(2);
  }

  const detectToolFnBody = extractFunctionBody(wsHelpersSource, 'detectToolEditorFromPath');
  const detectVSFnBody   = extractFunctionBody(wsHelpersSource, 'detectVSCodeVariantFromPath');
  if (!detectToolFnBody || !detectVSFnBody) {
    process.stderr.write('ERROR: Could not find detectToolEditorFromPath or detectVSCodeVariantFromPath in workspaceHelpers.ts\n');
    process.exit(2);
  }
  // getEditorTypeFromPath's own pre-checks (Eclipse) run first; then the helpers
  // detectToolEditorFromPath delegates to — detectCopilotFamilyFromPath (JetBrains,
  // Copilot CLI), detectCliAgentStoreFromPath (Crush, Kilo Code, Hermes, Devin CLI,
  // Codex CLI) and detectGlobalStorageEditorFromPath (Kiro, Kiro CLI, Cline) — ahead
  // of the VS Code variant checks, so the simulation matches the real evaluation order.
  const helperBody = name => extractFunctionBody(wsHelpersSource, name) ?? '';
  const wsComboBody = [
    helperBody('getEditorTypeFromPath'),
    helperBody('detectCopilotFamilyFromPath'),
    helperBody('detectCliAgentStoreFromPath'),
    helperBody('detectGlobalStorageEditorFromPath'),
    detectToolFnBody,
    detectVSFnBody,
  ].join('\n');

  // -- Extract rules ---------------------------------------------------------

  const cliRules = extractIncludesRules(cliFnBody);
  const wsRules  = extractIncludesRules(wsComboBody);

  // -- Extract returned names ------------------------------------------------

  const cliNames = extractReturnedNames(cliFnBody);
  const wsNames  = extractReturnedNames(wsComboBody);

  // -- Extract icon map keys -------------------------------------------------

  const iconMapKeys = extractIconMapKeys(formatSource);

  // -- CHECKS ----------------------------------------------------------------

  const failures = [];
  const warnings = [];

  // 1. CLI names in EDITOR_ICON_MAP
  const cliMissingIcons = [...cliNames].filter(n => !iconMapKeys.has(n));

  // 2. VS Code names in EDITOR_ICON_MAP
  const wsMissingIcons = [...wsNames].filter(n => !iconMapKeys.has(n));

  // 3. Cross-function consistency for test cases
  const testResults = TEST_CASES.map(tc => {
    const cliDetected = detectEditor(cliRules, tc.path) ?? 'VS Code';
    const wsDetected  = detectEditor(wsRules, tc.path)  ?? null;
    // wsDetected === null means VS Code uses helper functions not visible to
    // static includes-extraction (e.g. isCodeInsidersPath, isVisualStudioPath).
    // Those paths are marked as "not cross-checkable" and never count as failures.
    const cliMatch   = cliDetected === tc.expected;
    const wsMatch    = wsDetected === null || wsDetected === tc.expected;
    // A real cross-mismatch requires both sides to return a concrete different name.
    const crossMatch = wsDetected === null || cliDetected === wsDetected;
    return { ...tc, cliDetected, wsDetected: wsDetected ?? '(uses helpers)', cliMatch, wsMatch, crossMatch };
  });
  const testFailures = testResults.filter(r => !r.cliMatch || !r.crossMatch);

  // 4. Ordering invariants in CLI function
  const orderingIssues = checkOrderingInvariants(cliRules);

  // -- Accumulate failures ---------------------------------------------------

  if (cliMissingIcons.length > 0) {
    failures.push({
      check: 'cli-icon-coverage',
      description: 'CLI returns names with no EDITOR_ICON_MAP entry',
      items: cliMissingIcons,
    });
  }
  if (wsMissingIcons.length > 0) {
    failures.push({
      check: 'vscode-icon-coverage',
      description: 'VS Code extension returns names with no EDITOR_ICON_MAP entry',
      items: wsMissingIcons,
    });
  }
  if (testFailures.length > 0) {
    failures.push({
      check: 'cross-function-consistency',
      description: 'CLI and VS Code return different names for the same path',
      items: testFailures.map(r => ({
        label:       r.label,
        path:        r.path,
        expected:    r.expected,
        cli:         r.cliDetected,
        vscode:      r.wsDetected,
        cliOk:       r.cliMatch,
        vscodeOk:    r.wsMatch,
        crossMatch:  r.crossMatch,
      })),
    });
  }
  if (orderingIssues.length > 0) {
    // Ordering issues are warnings, not hard failures — they may be intentional
    warnings.push({
      check: 'ordering-invariants',
      description: 'Broad pattern appears before specific pattern (possible shadowing)',
      items: orderingIssues,
    });
  }

  // -- Output ----------------------------------------------------------------

  const result = {
    passed:   failures.length === 0,
    summary: {
      cliReturnedNames:   [...cliNames].sort(),
      vsCodeReturnedNames: [...wsNames].sort(),
      iconMapKeys:        [...iconMapKeys].sort(),
      testCasesRun:       TEST_CASES.length,
      testCasesFailed:    testFailures.length,
    },
    failures,
    warnings,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result);
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

function printHumanReport(result) {
  const isTTY = process.stdout.isTTY;
  const c = (code, text) => isTTY ? `${code}${text}${C.reset}` : text;

  console.log();
  console.log(c(C.bold, '=== validate-editor-names ==='));
  console.log();

  const { summary } = result;
  console.log(`CLI returned names      : ${c(C.cyan, summary.cliReturnedNames.join(', '))}`);
  console.log(`VS Code returned names  : ${c(C.cyan, summary.vsCodeReturnedNames.join(', '))}`);
  console.log(`Icon map keys           : ${c(C.cyan, summary.iconMapKeys.join(', '))}`);
  console.log(`Test cases run          : ${summary.testCasesRun}`);
  console.log(`Test cases failed       : ${summary.testCasesFailed > 0 ? c(C.red, String(summary.testCasesFailed)) : c(C.green, '0')}`);
  console.log();

  if (result.failures.length === 0 && result.warnings.length === 0) {
    console.log(c(C.green, '✔ All checks passed'));
    console.log();
    return;
  }

  for (const failure of result.failures) {
    console.log(c(C.red, `✖ FAIL: ${failure.check}`));
    console.log(`  ${failure.description}`);
    for (const item of failure.items) {
      if (typeof item === 'string') {
        console.log(`  - ${c(C.red, item)}`);
      } else if (item.label) {
        // Test case failure
        const cliStatus   = item.cliOk   ? c(C.green, '✔') : c(C.red, '✖');
        const vsStatus    = item.vscodeOk ? c(C.green, '✔') : c(C.red, '✖');
        const crossStatus = item.crossMatch ? c(C.green, 'match') : c(C.red, 'MISMATCH');
        console.log(`  - ${c(C.bold, item.label)}`);
        console.log(`    Path     : ${c(C.gray, item.path)}`);
        console.log(`    Expected : ${c(C.cyan, item.expected)}`);
        console.log(`    CLI      : ${cliStatus} ${item.cli}`);
        console.log(`    VS Code  : ${vsStatus} ${item.vscode}`);
        console.log(`    Cross    : ${crossStatus}`);
      } else {
        // Ordering issue
        console.log(`  - Broad '${c(C.yellow, item.broadPattern)}' (→ '${item.broadName}') at rule #${item.broadIndex} shadows`);
        console.log(`    specific '${c(C.yellow, item.specificPattern)}' (→ '${item.specificName}') at rule #${item.specificIndex}`);
      }
    }
    console.log();
  }

  for (const warning of result.warnings) {
    console.log(c(C.yellow, `⚠ WARN: ${warning.check}`));
    console.log(`  ${warning.description}`);
    for (const item of warning.items) {
      if (item.broadPattern) {
        console.log(`  - '${c(C.yellow, item.broadPattern)}' (→ '${item.broadName}') at rule #${item.broadIndex} may shadow`);
        console.log(`    '${c(C.yellow, item.specificPattern)}' (→ '${item.specificName}') at rule #${item.specificIndex}`);
      } else {
        console.log(`  - ${JSON.stringify(item)}`);
      }
    }
    console.log();
  }

  if (result.failures.length > 0) {
    console.log(c(C.red, `✖ ${result.failures.length} check(s) failed`));
  }
  console.log();
}

main();
