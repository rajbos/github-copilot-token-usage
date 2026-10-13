#!/usr/bin/env node

/**
 * Webview Message Contract Validation
 *
 * Every webview panel talks to the extension host over `postMessage`, and that
 * wiring is invisible to the type checker: a button can post
 * `{ command: 'copyFailed' }` forever while the host has no branch for it, and
 * nothing fails to compile, no test goes red, and the UI just quietly does
 * nothing. `handleAnalysisMessage` in extension.ts already logs that case at
 * runtime ("no handler for webview command") — but only if a human happens to
 * be reading the output channel at the moment they click the button.
 *
 * This script turns that runtime log into a build-time failure. It checks both
 * directions of the contract:
 *
 *   A. webview -> extension  — every `command` a bundle under src/webview/**
 *      can post is matched by a branch on the extension side.
 *   B. extension -> webview  — every `command`/`type` the extension posts into
 *      a panel is matched by a branch on the webview side.
 *
 * Commands are collected with the TypeScript AST (so a `switch (msg.command)`,
 * an `=== 'literal'` comparison and a `Record<string, Handler>` dispatch map
 * all count). The *handled* side is additionally widened by a plain-text scan,
 * which also picks up handlers living inside inline `<script>` template
 * literals (src/loadingHtml.ts, vscode-extension/src/backend/configPanel.ts). Widening the handled set
 * can only ever hide a finding, never invent one — that asymmetry is
 * deliberate, because a checker that cries wolf gets switched off.
 *
 * Usage:
 *   node scripts/validate-webview-contract.js [--json] [--direction a|b|both]
 *
 * Exits 1 when a command has no counterpart.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(REPO_ROOT, 'vscode-extension');
const WEBVIEW_DIR = path.join(EXT_DIR, 'src', 'webview');

/**
 * Commands that intentionally have no counterpart, each with the reason.
 * Keep this list short and justified — it is the escape hatch, not the norm.
 */
const ALLOWED_UNHANDLED = {
  webviewToExtension: {
    // e.g. 'someCommand': 'why it is fine that nothing handles this',
  },
  extensionToWebview: {
    // e.g. 'someCommand': 'why it is fine that nothing handles this',
  },
};

function loadTypeScript() {
  for (const base of [process.cwd(), EXT_DIR, REPO_ROOT]) {
    try {
      return require(path.join(base, 'node_modules', 'typescript'));
    } catch {
      /* try the next location */
    }
  }
  try {
    return require('typescript');
  } catch {
    console.error('❌ Could not resolve the "typescript" package.');
    console.error('   Run `npm ci` in vscode-extension/ first.');
    process.exit(2);
  }
}

const ts = loadTypeScript();

/** Recursively collects .ts files under `dir`, skipping build output and tests. */
function collectTsFiles(dir, results = []) {
  const skipDirs = new Set(['node_modules', 'out', 'dist', 'test', '.vscode-test']);
  if (!fs.existsSync(dir)) {
    return results;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        collectTsFiles(full, results);
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function parseFile(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Strips parentheses, `as` / `<T>` casts, `!` and `satisfies`, which do not change the value posted. */
function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Collects every message name posted from `files`, i.e. the `command` (or
 * `type`) property of an object literal handed to a `postMessage(...)` call.
 *
 * @returns {Map<string, {file: string, line: number}[]>} name -> where it is posted
 */
function collectPostedCommands(files) {
  const posted = new Map();

  for (const file of files) {
    const sourceFile = parseFile(file);

    const visit = (node) => {
      if (ts.isCallExpression(node) && /(^|\.)postMessage$/.test(node.expression.getText(sourceFile))) {
        for (const rawArg of node.arguments) {
          // `({ … })`, `{ … } as Msg` and `{ … } satisfies Msg` post the same message.
          const arg = unwrapExpression(rawArg);
          if (!ts.isObjectLiteralExpression(arg)) {
            continue;
          }
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop)) {
              continue;
            }
            const key = prop.name.getText(sourceFile).replace(/['"]/g, '');
            const value = unwrapExpression(prop.initializer);
            if ((key === 'command' || key === 'type') && ts.isStringLiteralLike(value)) {
              const name = value.text;
              if (!posted.has(name)) {
                posted.set(name, []);
              }
              posted.get(name).push({
                file: path.relative(REPO_ROOT, file),
                line: lineOf(sourceFile, prop),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return posted;
}

/**
 * Collects every message name `files` can handle, from the three dispatch
 * shapes this codebase uses: a `switch (msg.command)`, an `=== 'literal'`
 * comparison, and the keys of a `Record<string, Handler>` dispatch map (either
 * a typed variable or a method that returns one).
 */
function collectHandledCommandsFromAst(files) {
  const handled = new Set();

  for (const file of files) {
    const sourceFile = parseFile(file);

    const collectKeys = (objectLiteral) => {
      for (const prop of objectLiteral.properties) {
        if (!prop.name) {
          continue;
        }
        handled.add(
          ts.isStringLiteralLike(prop.name) ? prop.name.text : prop.name.getText(sourceFile).replace(/['"]/g, '')
        );
      }
    };

    const isFunctionLike = (node) =>
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node);

    /** Collects object literals a `Record<string, ...>`-returning function returns. */
    const collectReturnedMaps = (fn) => {
      const findReturns = (node) => {
        if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
          collectKeys(node.expression);
        }
        // A nested function's returns belong to that function, not to this map.
        if (node !== fn && isFunctionLike(node)) {
          return;
        }
        ts.forEachChild(node, findReturns);
      };
      ts.forEachChild(fn, findReturns);

      // Concise arrow body: `(): Record<string, H> => ({ ... })`
      const body = fn.body;
      if (body && ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
        collectKeys(body.expression);
      } else if (body && ts.isObjectLiteralExpression(body)) {
        collectKeys(body);
      }
    };

    const visit = (node) => {
      // switch (message.command) { case 'x': ... }
      if (ts.isSwitchStatement(node) && /\.(command|type)$/.test(node.expression.getText(sourceFile))) {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
            handled.add(clause.expression.text);
          }
        }
      }

      // message.command === 'x'
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
      ) {
        if (/\.(command|type)$/.test(node.left.getText(sourceFile)) && ts.isStringLiteralLike(node.right)) {
          handled.add(node.right.text);
        }
      }

      // const handlers: Record<string, Handler> = { x: () => ... }
      if (
        ts.isVariableDeclaration(node) &&
        node.type &&
        /Record<\s*string/.test(node.type.getText(sourceFile)) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        collectKeys(node.initializer);
      }

      // private _getHandlers(): Record<string, Handler> { return { x: ... }; }
      if (isFunctionLike(node) && node.type && /Record<\s*string/.test(node.type.getText(sourceFile))) {
        collectReturnedMaps(node);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return handled;
}

/**
 * Widens the handled set with a plain-text scan.
 *
 * Some handlers live inside inline `<script>` template literals (the loading
 * screen, the backend config panels), which the AST sees as one opaque string.
 * This scan reaches them. It over-matches by design: every name it adds can
 * only suppress a finding, so a false positive here costs a missed bug, while
 * a false positive in the *findings* would cost the check its credibility.
 */
function widenHandledFromText(files, handled) {
  const patterns = [
    /\b(?:command|type)\s*===?\s*['"`]([A-Za-z0-9_.]+)['"`]/g,
    /\bcase\s+['"`]([A-Za-z0-9_.]+)['"`]\s*:/g,
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        handled.add(match[1]);
      }
    }
  }
  return handled;
}

/** Emits a GitHub Actions annotation so findings show up inline on the PR. */
function annotate(finding) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }
  const { file, line } = finding.locations[0];
  const message = `${finding.command}: ${finding.detail}`;
  console.log(`::error file=${file},line=${line}::${message.replace(/\n/g, '%0A')}`);
}

function findUnmatched(posted, handled, allowList, detailFor) {
  const findings = [];
  for (const [command, locations] of posted) {
    if (handled.has(command) || Object.prototype.hasOwnProperty.call(allowList, command)) {
      continue;
    }
    findings.push({ command, locations, detail: detailFor(command) });
  }
  return findings.sort((a, b) => a.command.localeCompare(b.command));
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const directionArg = (args[args.indexOf('--direction') + 1] || 'both').toLowerCase();
  const direction = args.includes('--direction') ? directionArg : 'both';

  const webviewFiles = collectTsFiles(WEBVIEW_DIR);
  // src/loadingHtml.ts lives in the shared repo-root src/ (also used by the desktop app) but is
  // still extension-side code that ships inline <script> handlers, so it is scanned too.
  const extensionFiles = collectTsFiles(path.join(EXT_DIR, 'src')).filter(
    (file) => !file.startsWith(WEBVIEW_DIR + path.sep)
  ).concat(path.join(REPO_ROOT, 'src', 'loadingHtml.ts'));

  if (webviewFiles.length === 0 || extensionFiles.length === 0) {
    console.error('❌ Found no sources to check — is this running from the repo root?');
    process.exit(2);
  }

  const findings = { webviewToExtension: [], extensionToWebview: [] };

  if (direction === 'both' || direction === 'a') {
    const posted = collectPostedCommands(webviewFiles);
    const handled = widenHandledFromText(extensionFiles, collectHandledCommandsFromAst(extensionFiles));
    findings.webviewToExtension = findUnmatched(
      posted,
      handled,
      ALLOWED_UNHANDLED.webviewToExtension,
      () => 'posted by a webview, but no branch on the extension side handles it — the click does nothing'
    );
  }

  if (direction === 'both' || direction === 'b') {
    const posted = collectPostedCommands(extensionFiles);
    // Webview-side handlers can also sit in inline scripts on the extension side,
    // so both trees widen the handled set for this direction.
    const handled = widenHandledFromText(
      [...webviewFiles, ...extensionFiles],
      collectHandledCommandsFromAst(webviewFiles)
    );
    findings.extensionToWebview = findUnmatched(
      posted,
      handled,
      ALLOWED_UNHANDLED.extensionToWebview,
      () => 'posted to a webview, but no webview branch handles it — the UI never updates'
    );
  }

  const total = findings.webviewToExtension.length + findings.extensionToWebview.length;

  if (asJson) {
    console.log(JSON.stringify({ ok: total === 0, findings }, null, 2));
    process.exit(total === 0 ? 0 : 1);
  }

  console.log('🔌 Webview message contract\n');

  const sections = [
    ['webview → extension', findings.webviewToExtension],
    ['extension → webview', findings.extensionToWebview],
  ];

  for (const [label, list] of sections) {
    if (list.length === 0) {
      continue;
    }
    console.error(`❌ ${label}: ${list.length} unhandled message(s)`);
    for (const finding of list) {
      console.error(`   - '${finding.command}' — ${finding.detail}`);
      for (const location of finding.locations) {
        console.error(`     posted at ${location.file}:${location.line}`);
      }
      annotate(finding);
    }
    console.error('');
  }

  if (total > 0) {
    console.error('❌ Webview message contract validation failed!\n');
    process.exit(1);
  }

  console.log('✅ Every webview message has a handler on the other side.\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  collectPostedCommands,
  collectHandledCommandsFromAst,
  widenHandledFromText,
  collectTsFiles,
  unwrapExpression,
  ts,
};
